// Package supervisor starts the ferminux node as a child process, restarts it
// when it exits, and stops it gracefully (interrupt, then kill after a
// timeout) when the sidecar shuts down. The node is given IPC only: no HTTP,
// no WebSocket, no unlocked account, no block production.
//
// Peering is sentry mode by default, so a home validator needs no inbound
// port: discovery stays on and seeds from the bootnodes compiled into the
// node, static-nodes.json keeps a permanent link to the known public nodes,
// the peer cap is modest (config.DefaultMaxPeers), and --nat none keeps the
// node from asking the router to open a port unless node.inbound is set.
package supervisor

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aliasghar89/ferminux/chain/crypto"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/logx"
	"github.com/aliasghar89/ferminux/validator/internal/status"
)

// Supervisor runs one node process.
type Supervisor struct {
	Binary      string
	Args        []string
	Output      io.Writer // node stdout and stderr
	Log         *logx.Logger
	Status      *status.Tracker
	StopTimeout time.Duration
	// MinBackoff and MaxBackoff bound the wait before a restart.
	MinBackoff, MaxBackoff time.Duration

	mu       sync.Mutex
	cmd      *exec.Cmd
	restarts int
}

// InstanceDir is the directory inside the node's datadir that holds its
// chain data, nodekey and static-nodes.json. It is chain/cmd/ferminux's
// datadirInstanceName, frozen there independently of the binary's name.
const InstanceDir = "ferminux-geth"

// NodeArgs is the node command line for a validator: full sync, IPC at the
// sidecar's endpoint, the configured cache, the sentry-mode peering defaults,
// plus the operator's extra flags (already screened by config.CheckNodeArgs;
// a --maxpeers or --nat there replaces the default).
func NodeArgs(r *config.Resolved) []string {
	ipc := r.IPCName()
	if runtime.GOOS != "windows" {
		ipc = filepath.Join(r.NodeDataDir(), r.IPCName())
	}
	args := []string{
		"--datadir", r.NodeDataDir(),
		"--syncmode", "full",
		"--cache", fmt.Sprint(r.Node.Cache),
		"--ipcpath", ipc,
	}
	if r.Network != "mainnet" {
		args = append(args, "--networkid", fmt.Sprint(r.ChainID))
	}
	if !hasFlag(r.Node.ExtraArgs, "--maxpeers") {
		args = append(args, "--maxpeers", fmt.Sprint(r.Node.MaxPeers))
	}
	if !r.Node.Inbound && !hasFlag(r.Node.ExtraArgs, "--nat") {
		args = append(args, "--nat", "none")
	}
	return append(args, r.Node.ExtraArgs...)
}

// hasFlag reports whether args set the named flag (--name, -name, --name=v).
func hasFlag(args []string, name string) bool {
	for _, a := range args {
		a = strings.ToLower(a)
		if i := strings.IndexByte(a, '='); i >= 0 {
			a = a[:i]
		}
		if a == name || "-"+a == name {
			return true
		}
	}
	return false
}

// checkEnode accepts enode://<128 hex public key>@<ip>:<port>[?discport=n],
// the form the node reads from static-nodes.json, with a key on the curve.
func checkEnode(u string) error {
	rest := strings.TrimPrefix(u, "enode://")
	at := strings.IndexByte(rest, '@')
	if rest == u || at != 128 {
		return errors.New("not enode://<public key>@<ip>:<port>")
	}
	pub, err := hex.DecodeString(rest[:at])
	if err != nil {
		return errors.New("public key is not hex")
	}
	if _, err := crypto.UnmarshalPubkey(append([]byte{4}, pub...)); err != nil {
		return err
	}
	hostport := rest[at+1:]
	if i := strings.IndexByte(hostport, '?'); i >= 0 {
		if !strings.HasPrefix(hostport[i:], "?discport=") {
			return errors.New("unknown query")
		}
		hostport = hostport[:i]
	}
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return err
	}
	if net.ParseIP(host) == nil {
		return errors.New("host must be an IP address")
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
		return errors.New("bad port")
	}
	return nil
}

// StaticNodesPath is where the node reads its static peers.
func StaticNodesPath(nodeDataDir string) string {
	return filepath.Join(nodeDataDir, InstanceDir, "static-nodes.json")
}

// WriteStaticPeers makes sure the node's static-nodes.json lists every peer
// in peers. Entries already in the file (an operator's own) are kept, in
// order. A file that is not a JSON list of strings is left alone and
// reported. It returns how many peers it added.
func WriteStaticPeers(nodeDataDir string, peers []string) (int, error) {
	if len(peers) == 0 {
		return 0, nil
	}
	for _, p := range peers {
		if err := checkEnode(p); err != nil {
			return 0, fmt.Errorf("static peer %q: %w", p, err)
		}
	}
	path := StaticNodesPath(nodeDataDir)
	var list []string
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, &list); err != nil {
			return 0, fmt.Errorf("%s is not a JSON list of enode URLs (left unchanged): %w", path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	have := make(map[string]bool, len(list))
	for _, e := range list {
		have[strings.TrimSpace(e)] = true
	}
	added := 0
	for _, p := range peers {
		if !have[p] {
			list, have[p] = append(list, p), true
			added++
		}
	}
	if added == 0 {
		return 0, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return 0, err
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return 0, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return 0, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return added, nil
}

// DefaultBinary is ferminux[.exe] next to this program.
func DefaultBinary() string {
	name := "ferminux"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return name
}

// CurrentArgs returns the node's command line (for the reorg-cap probe).
func (s *Supervisor) CurrentArgs() []string {
	return append([]string(nil), s.Args...)
}

func (s *Supervisor) defaults() {
	if s.StopTimeout == 0 {
		s.StopTimeout = 90 * time.Second
	}
	if s.MinBackoff == 0 {
		s.MinBackoff = 5 * time.Second
	}
	if s.MaxBackoff == 0 {
		s.MaxBackoff = 2 * time.Minute
	}
	if s.Output == nil {
		s.Output = io.Discard
	}
	if s.Log == nil {
		s.Log = logx.Discard()
	}
}

func (s *Supervisor) update(f func(n *status.NodeProc)) {
	if s.Status != nil {
		s.Status.Update(func(snap *status.Snapshot) { f(&snap.Node) })
	}
}

// Run keeps the node running until ctx is cancelled, then stops it.
func (s *Supervisor) Run(ctx context.Context) error {
	s.defaults()
	if _, err := exec.LookPath(s.Binary); err != nil {
		if _, serr := os.Stat(s.Binary); serr != nil {
			return fmt.Errorf("node binary %q not found: %w", s.Binary, err)
		}
	}
	s.update(func(n *status.NodeProc) { n.Supervised = true })
	backoff := s.MinBackoff
	for {
		started := time.Now()
		err := s.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		s.mu.Lock()
		s.restarts++
		restarts := s.restarts
		s.mu.Unlock()
		msg := "exited"
		if err != nil {
			msg = err.Error()
		}
		s.Log.Warn("node process stopped; restarting", "err", msg, "restarts", restarts, "wait", backoff)
		s.update(func(n *status.NodeProc) { n.Running, n.PID, n.Restarts, n.LastExit = false, 0, restarts, msg })
		if time.Since(started) > 10*time.Minute {
			backoff = s.MinBackoff // it ran fine for a while: start over
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > s.MaxBackoff {
			backoff = s.MaxBackoff
		}
	}
}

func (s *Supervisor) runOnce(ctx context.Context) error {
	cmd := exec.Command(s.Binary, s.Args...)
	tail := &fatalTail{}
	out := io.MultiWriter(s.Output, tail)
	cmd.Stdout, cmd.Stderr = out, out
	prepare(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	s.mu.Lock()
	s.cmd = cmd
	s.mu.Unlock()
	s.Log.Info("node started", "pid", cmd.Process.Pid, "binary", s.Binary)
	s.update(func(n *status.NodeProc) { n.Running, n.PID, n.Since = true, cmd.Process.Pid, time.Now() })
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if f := tail.line(); f != "" {
			if err == nil {
				return errors.New(f)
			}
			return fmt.Errorf("%v: %s", err, f)
		}
		return err
	case <-ctx.Done():
		s.Log.Info("stopping node", "pid", cmd.Process.Pid)
		if err := interrupt(cmd); err != nil {
			s.Log.Warn("could not interrupt the node; killing it", "err", err)
			cmd.Process.Kill()
		}
		select {
		case <-done:
		case <-time.After(s.StopTimeout):
			s.Log.Warn("node did not stop in time; killing it", "timeout", s.StopTimeout)
			cmd.Process.Kill()
			<-done
		}
		s.update(func(n *status.NodeProc) { n.Running, n.PID = false, 0 })
		return errors.New("stopped")
	}
}

// fatalTail keeps the node's last "Fatal: …" line (how the node reports why
// it could not start, such as a port already in use), so the dashboard can
// say why it stopped instead of only "exit status 1".
type fatalTail struct {
	mu    sync.Mutex
	buf   []byte
	fatal string
}

func (t *fatalTail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	for {
		i := bytes.IndexByte(t.buf, '\n')
		if i < 0 {
			break
		}
		if l := strings.TrimSpace(string(t.buf[:i])); strings.HasPrefix(l, "Fatal:") {
			if len(l) > 300 {
				l = l[:300] + "…"
			}
			t.fatal = l
		}
		t.buf = t.buf[i+1:]
	}
	if len(t.buf) > 4096 { // a long line without a newline: keep only its start
		t.buf = t.buf[:0]
	}
	return len(p), nil
}

func (t *fatalTail) line() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if l := strings.TrimSpace(string(t.buf)); strings.HasPrefix(l, "Fatal:") {
		return l
	}
	return t.fatal
}
