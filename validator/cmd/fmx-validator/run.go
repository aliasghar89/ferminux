package main

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/aliasghar89/ferminux/validator/internal/attest"
	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/dashboard"
	"github.com/aliasghar89/ferminux/validator/internal/flock"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/logx"
	"github.com/aliasghar89/ferminux/validator/internal/node"
	"github.com/aliasghar89/ferminux/validator/internal/protect"
	"github.com/aliasghar89/ferminux/validator/internal/scheduler"
	"github.com/aliasghar89/ferminux/validator/internal/service"
	"github.com/aliasghar89/ferminux/validator/internal/status"
	"github.com/aliasghar89/ferminux/validator/internal/supervisor"
	"golang.org/x/term"
)

// HaltedFile, in the network directory, keeps a safety stop in force across
// restarts until `fmx-validator resume` removes it.
const HaltedFile = "HALTED"

// LastErrorFile, in the network directory, holds why the last run failed
// (what `status` shows when the sidecar is not running). A run that gets as
// far as serving its dashboard removes it.
const LastErrorFile = "last-error.txt"

// retryEvery is how often the sidecar re-checks what is missing before it can sign.
var retryEvery = 15 * time.Second

type runOptions struct {
	base    baseFlags
	node    nodeFlags
	verbose bool
	service bool
	out     io.Writer
	errOut  io.Writer
	// ready, when set, is called once the sidecar is up (lock held, settings
	// read, dashboard listening); the Windows service reports RUNNING then.
	ready func()
}

func parseRun(args []string, out, errOut io.Writer) (runOptions, error) {
	o := runOptions{out: out, errOut: errOut}
	fs := newFlags("run", errOut)
	o.base.register(fs)
	o.node.register(fs)
	fs.BoolVar(&o.verbose, "verbose", false, "log debug detail")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	return o, o.base.resolve()
}

func cmdRun(args []string, out, errOut io.Writer) error {
	o, err := parseRun(args, out, errOut)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runValidator(ctx, o)
}

// serviceMain is the Windows service entry point (the service's arguments are
// "run --data-dir … --network …"). It hands over to the service manager
// before anything else, so even a bad command line is reported as a failed
// start with its reason in the event log, never as a 1053 timeout.
func serviceMain(args []string) int {
	if len(args) > 0 && args[0] == "run" {
		args = args[1:]
	}
	supervisor.PrepareService()
	err := service.RunService(func(ctx context.Context, ready func()) error {
		o, err := parseRun(args, io.Discard, io.Discard)
		if err != nil {
			return fmt.Errorf("the service's command line %q is not valid (%v); register it again with `fmx-validator install` from an administrator prompt", strings.Join(args, " "), err)
		}
		o.service, o.ready = true, ready
		return runValidator(ctx, o)
	})
	if err != nil {
		return 1
	}
	return 0
}

// runValidator runs until ctx ends. It never exits just because something is
// missing (no hub address yet, no key, node still syncing): it keeps the node
// and the dashboard up and says what is missing, so a service does not flap.
func runValidator(ctx context.Context, o runOptions) (err error) {
	dir := o.base.dir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	logFile, err := logx.OpenRotating(filepath.Join(dir, "logs", "fmx-validator.log"), 20<<20, 5)
	if err != nil {
		return err
	}
	defer logFile.Close()
	var logOut io.Writer = logFile
	if !o.service {
		logOut = io.MultiWriter(o.errOut, logFile)
	}
	level := logx.Info
	if o.verbose {
		level = logx.Debug
	}
	log := logx.New(logOut, level)

	lock, err := flock.Acquire(filepath.Join(dir, "validator.lock"))
	if err != nil {
		return fmt.Errorf("another fmx-validator is already running for %s: %w", o.base.network, err)
	}
	defer lock.Release()
	defer func() {
		if err != nil {
			log.Error("fmx-validator stopped", "err", err)
			recordFailure(dir, err)
		}
	}()

	cfg, _, err := loadOrCreate(o.base, &o.node, false)
	if err != nil {
		return err
	}
	r, err := config.Resolve(cfg, dir)
	if err != nil {
		return err
	}

	tracker := status.NewTracker(status.Snapshot{Version: version, Network: r.Network, ChainID: r.ChainID, Hub: r.HubAddr, Started: time.Now().UTC()})
	dash, err := dashboard.Listen(r.Dashboard, tracker)
	if err != nil {
		return fmt.Errorf("dashboard: %w", err)
	}
	go dash.Serve()
	defer func() {
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		dash.Shutdown(sctx)
		cancel()
		os.Remove(r.DashboardAddrPath())
	}()
	if err := dash.WriteAddrFile(r.DashboardAddrPath()); err != nil {
		log.Warn("could not record the dashboard address", "err", err)
	}
	os.Remove(filepath.Join(dir, LastErrorFile))
	if o.ready != nil {
		o.ready()
	}
	log.Info("fmx-validator started", "version", version, "network", r.Network, "chain", r.ChainID, "dashboard", dash.URL())
	if !o.service {
		fmt.Fprintf(o.out, "Dashboard: %s\n", dash.URL())
	}

	var wg sync.WaitGroup
	defer wg.Wait()
	var sup *supervisor.Supervisor
	if r.Node.Supervise {
		nodeLog, err := logx.OpenRotating(filepath.Join(dir, "logs", "node.log"), 50<<20, 5)
		if err != nil {
			return err
		}
		defer nodeLog.Close()
		if err := os.MkdirAll(r.NodeDataDir(), 0o700); err != nil {
			return err
		}
		if n, err := supervisor.WriteStaticPeers(r.NodeDataDir(), r.StaticPeers()); err != nil {
			log.Warn("could not update the node's static peers", "err", err)
		} else if n > 0 {
			log.Info("static peers added for the node", "added", n, "file", supervisor.StaticNodesPath(r.NodeDataDir()))
		}
		sup = &supervisor.Supervisor{Binary: r.Node.Binary, Args: supervisor.NodeArgs(r), Output: nodeLog, Log: log, Status: tracker}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := sup.Run(ctx); err != nil {
				log.Error("node supervisor stopped", "err", err)
				tracker.Update(func(s *status.Snapshot) { s.Setup = append(s.Setup, "node: "+err.Error()) })
			}
		}()
	}

	a := &attesterRun{o: o, r: r, log: log, tracker: tracker, sup: sup}
	defer a.close()
	a.loop(ctx)
	log.Info("fmx-validator stopping")
	return nil
}

// recordFailure keeps why a run failed for `fmx-validator status`.
func recordFailure(dir string, err error) {
	line := time.Now().UTC().Format(time.RFC3339) + " " + err.Error() + "\n"
	os.WriteFile(filepath.Join(dir, LastErrorFile), []byte(line), 0o644)
}

// attesterRun gathers what the engine needs, retrying until it has it.
type attesterRun struct {
	o       runOptions
	r       *config.Resolved
	log     *logx.Logger
	tracker *status.Tracker
	sup     *supervisor.Supervisor

	key      *ecdsa.PrivateKey
	marker   keys.Marker
	db       *protect.DB
	client   *node.Client
	prompted bool
}

func (a *attesterRun) setup(reasons ...string) {
	a.tracker.Update(func(s *status.Snapshot) { s.Setup = reasons })
}

func (a *attesterRun) close() {
	if a.db != nil {
		a.db.Close()
	}
	if a.client != nil {
		a.client.Close()
	}
	if a.key != nil {
		b := a.key.D.Bits()
		for i := range b {
			b[i] = 0
		}
	}
}

func (a *attesterRun) loop(ctx context.Context) {
	// until the engine runs, a lighter loop keeps the node's sync state on the
	// dashboard, so a machine waiting for its hub address or key still shows
	// the node catching up
	mctx, stopMonitor := context.WithCancel(ctx)
	var mwg sync.WaitGroup
	mwg.Add(1)
	go func() { defer mwg.Done(); a.monitor(mctx) }()
	stop := func() { stopMonitor(); mwg.Wait() }
	defer stop()
	logged := ""
	for {
		eng, err := a.prepare(ctx)
		if err == nil {
			stop()
			a.setup()
			a.log.Info("attesting", "attester", eng.Addr, "hub", eng.Domain.Hub)
			eng.Run(ctx)
			return
		}
		if msg := err.Error(); msg != logged {
			a.log.Warn("not attesting yet", "reason", msg)
			logged = msg
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryEvery):
		}
	}
}

// monitor reports the node's readiness every retryEvery until ctx ends.
func (a *attesterRun) monitor(ctx context.Context) {
	var c *node.Client
	defer func() {
		if c != nil {
			c.Close()
		}
	}()
	for {
		if c == nil {
			c, _ = node.Dial(ctx, a.r.RPCEndpoint())
		}
		if c != nil {
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			r := node.Check(cctx, c, a.policy(), time.Now())
			cancel()
			if ctx.Err() != nil {
				return
			}
			a.tracker.Update(func(s *status.Snapshot) { s.Sync = r })
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryEvery):
		}
	}
}

// policy is what "ready to sign" means for this node.
func (a *attesterRun) policy() node.Policy {
	var probe func() []string
	if a.sup != nil {
		probe = a.sup.CurrentArgs
	}
	return node.Policy{ChainID: a.r.ChainID, MinPeers: a.r.MinPeers, MaxHeadAge: a.r.MaxHeadAge,
		DeepReorg: node.ReorgCapProbe(probe, a.r.ExternalNodeFlagsChecked)}
}

// errHalted: a safety stop is in force; do not retry.
var errHalted = errors.New("signing is stopped")

func (a *attesterRun) prepare(ctx context.Context) (*scheduler.Engine, error) {
	r := a.r
	haltPath := filepath.Join(r.Dir, HaltedFile)
	if b, err := os.ReadFile(haltPath); err == nil {
		reason := strings.TrimSpace(string(b))
		a.tracker.Update(func(s *status.Snapshot) { s.Halted = reason })
		a.setup("signing was stopped for safety: " + reason + ". After dealing with it, run `fmx-validator resume --yes` and restart.")
		return nil, errHalted
	}
	kdir := r.KeysDir()
	if addr, err := keys.Address(kdir); err == nil {
		a.tracker.Update(func(s *status.Snapshot) { s.Attester = addr })
	}
	if r.HubMissing() {
		a.setup("the ValidatorHub address is not configured yet (config.json \"hub\", set once the hub is published); nothing is signed until then")
		return nil, errors.New("no hub address")
	}
	if a.key == nil {
		addr, err := keys.CheckNetwork(a.o.base.dataDir, kdir, r.Network, r.ChainID)
		if errors.Is(err, keys.ErrNoKey) {
			a.setup("no attester key yet: run `fmx-validator keys new`")
			return nil, err
		}
		if err != nil {
			a.setup(err.Error())
			return nil, err
		}
		a.tracker.Update(func(s *status.Snapshot) { s.Attester = addr })
		interactive := !a.o.service && !a.prompted && term.IsTerminal(int(os.Stdin.Fd()))
		pw, src, err := keys.ResolvePassword(keys.PasswordOptions{File: r.PasswordFile, Network: r.Network, KeysDir: kdir, Interactive: interactive, Stderr: a.o.errOut})
		if interactive {
			a.prompted = true
		}
		if err != nil {
			a.setup("the attester key is locked: " + err.Error())
			return nil, err
		}
		key, _, err := keys.Load(kdir, pw)
		keys.Zero(pw)
		if err != nil {
			a.setup(err.Error())
			return nil, err
		}
		a.key = key
		a.marker, _ = keys.ReadMarker(kdir)
		a.log.Info("attester key opened", "address", addr, "password", string(src))
	}
	if a.db == nil {
		db, err := protect.Open(r.ProtectionPath())
		if err != nil {
			a.setup("slashing protection database: " + err.Error())
			return nil, err
		}
		a.db = db
	}
	if a.client == nil {
		c, err := node.Dial(ctx, r.RPCEndpoint())
		if err != nil {
			a.setup("waiting for the node at " + r.RPCEndpoint() + ": " + err.Error())
			return nil, err
		}
		a.client = c
	}
	addr := a.tracker.Snapshot().Attester
	eng := &scheduler.Engine{
		Chain:                   a.client,
		Hub:                     hub.New(r.HubAddr, a.client),
		DB:                      a.db,
		Key:                     a.key,
		Addr:                    addr,
		Domain:                  attest.Domain{ChainID: r.ChainID, Hub: r.HubAddr},
		Sched:                   r.Schedule,
		Policy:                  a.policy(),
		Status:                  a.tracker,
		Log:                     a.log,
		Imported:                a.marker.Imported,
		Adopt:                   r.AdoptOnChainHistory,
		DoppelgangerCheckpoints: 2,
		OnHalt: func(err error) {
			if werr := os.WriteFile(filepath.Join(r.Dir, HaltedFile), []byte(time.Now().UTC().Format(time.RFC3339)+" "+err.Error()+"\n"), 0o600); werr != nil {
				a.log.Error("could not record the safety stop", "err", werr)
			}
		},
	}
	eng.Sub = &scheduler.TxSubmitter{
		Chain: a.client, Key: a.key, From: addr, ChainID: new(big.Int).SetUint64(r.ChainID), Hub: r.HubAddr,
		Tip: scheduler.Gwei(r.Gas.TipGwei), MaxFee: scheduler.Gwei(r.Gas.MaxFeeGwei),
	}
	if err := eng.Preflight(ctx); err != nil {
		if scheduler.IsFatal(err) {
			if errors.Is(err, scheduler.ErrKeyInUse) {
				eng.OnHalt(err)
			}
			a.tracker.Update(func(s *status.Snapshot) { s.Halted = err.Error() })
			a.setup("cannot attest: " + err.Error())
			a.log.Error("refusing to attest", "reason", err)
			// wait for a restart: nothing here will change by itself
			<-ctx.Done()
			return nil, err
		}
		a.setup(err.Error())
		return nil, err
	}
	return eng, nil
}
