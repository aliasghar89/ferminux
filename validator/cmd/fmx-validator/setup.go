package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/supervisor"
)

// nodeFlags are the settings init, install and run accept for the node.
type nodeFlags struct {
	hub          string
	rpc          string
	nodePath     string
	supervise    bool
	noSupervise  bool
	dashboard    string
	passwordFile string
	inbound      optBool
}

// optBool is a boolean flag that remembers whether it was given, so
// --allow-inbound=false can turn a saved setting off.
type optBool struct{ set, v bool }

func (b *optBool) String() string {
	if b == nil {
		return "false"
	}
	return strconv.FormatBool(b.v)
}

func (b *optBool) Set(s string) error {
	v, err := strconv.ParseBool(s)
	if err != nil {
		return err
	}
	b.set, b.v = true, v
	return nil
}

func (b *optBool) IsBoolFlag() bool { return true }

func (n *nodeFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&n.hub, "hub", "", "ValidatorHub address (mainnet: filled in once published)")
	fs.StringVar(&n.rpc, "node-ipc", "", "attach to a running node at this IPC path (or http://127.0.0.1:port)")
	fs.StringVar(&n.rpc, "rpc", "", "same as --node-ipc")
	fs.StringVar(&n.nodePath, "node-path", "", "start and supervise this node binary")
	fs.BoolVar(&n.supervise, "supervise", false, "start and supervise the node (ferminux next to this program)")
	fs.BoolVar(&n.noSupervise, "no-supervise", false, "attach to a node that is already running")
	fs.StringVar(&n.dashboard, "dashboard", "", "dashboard address, loopback only (default 127.0.0.1 on a random port)")
	fs.StringVar(&n.passwordFile, "password-file", "", "file holding the attester keystore password (mode 0600)")
	fs.Var(&n.inbound, "allow-inbound", "let the supervised node map its P2P port on the router (UPnP/NAT-PMP) for inbound peers; =false returns to outbound-only sentry mode")
}

// apply folds command-line settings into a config.
func (n *nodeFlags) apply(c *config.Config) error {
	if n.hub != "" {
		if !common.IsHexAddress(n.hub) {
			return fmt.Errorf("--hub %q is not an address", n.hub)
		}
		c.Hub = common.HexToAddress(n.hub).Hex()
	}
	if n.rpc != "" {
		c.RPC = n.rpc
		c.Node.Supervise = false
	}
	if n.nodePath != "" {
		abs, err := filepath.Abs(n.nodePath)
		if err != nil {
			return err
		}
		c.Node.Binary, c.Node.Supervise = abs, true
	}
	if n.supervise {
		c.Node.Supervise = true
	}
	if n.noSupervise {
		c.Node.Supervise = false
	}
	if n.inbound.set {
		c.Node.Inbound = n.inbound.v
	}
	if n.dashboard != "" {
		c.Dashboard = n.dashboard
	}
	if n.passwordFile != "" {
		abs, err := filepath.Abs(n.passwordFile)
		if err != nil {
			return err
		}
		c.PasswordFile = abs
	}
	if c.Node.Supervise && c.Node.Binary == "" {
		c.Node.Binary = supervisor.DefaultBinary()
	}
	if !c.Node.Supervise && c.RPC == "" {
		return errors.New("attaching to an external node needs --node-ipc (its IPC path, or http://127.0.0.1:port)")
	}
	return nil
}

// loadOrCreate reads config.json, creating it from defaults (and cm's chain
// id, for devnet) if it is missing. created reports whether it was written.
func loadOrCreate(cm baseFlags, nf *nodeFlags, persistFlags bool) (config.Config, bool, error) {
	path := filepath.Join(cm.dir(), "config.json")
	var c config.Config
	created := false
	if b, err := os.ReadFile(path); err == nil {
		if err := decodeConfig(b, &c); err != nil {
			return c, false, fmt.Errorf("%s: %w", path, err)
		}
		if c.Network != cm.network {
			return c, false, fmt.Errorf("%s says network %q, expected %q", path, c.Network, cm.network)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		c, err = config.Default(cm.network)
		if err != nil {
			return c, false, err
		}
		if cm.network == "devnet" {
			c.ChainID = cm.chainID
		}
		created = true
	} else {
		return c, false, err
	}
	if cm.chainID != 0 && c.ChainID != cm.chainID {
		return c, false, fmt.Errorf("%s is for chain %d, not %d", path, c.ChainID, cm.chainID)
	}
	if nf != nil {
		if err := nf.apply(&c); err != nil {
			return c, false, err
		}
	}
	// never write a config that would not load
	if _, err := config.Resolve(c, cm.dir()); err != nil {
		return c, false, err
	}
	if created || persistFlags {
		if err := config.Save(cm.dir(), c); err != nil {
			return c, false, err
		}
	}
	return c, created, nil
}

func decodeConfig(b []byte, c *config.Config) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	return dec.Decode(c)
}

func cmdInit(args []string, out io.Writer) error {
	fs := newFlags("init", out)
	var cm baseFlags
	var nf nodeFlags
	cm.register(fs)
	nf.register(fs)
	force := fs.Bool("force", false, "replace an existing config.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	path := filepath.Join(cm.dir(), "config.json")
	if _, err := os.Stat(path); err == nil && !*force {
		// update in place with whatever was given
		c, _, err := loadOrCreate(cm, &nf, true)
		if err != nil {
			return err
		}
		if _, err := config.Resolve(c, cm.dir()); err != nil {
			return err
		}
		return describeConfig(out, cm, c, "updated")
	}
	if cm.network == "devnet" && cm.chainID == 0 {
		return errors.New("devnet needs --chain-id")
	}
	os.Remove(path)
	c, _, err := loadOrCreate(cm, &nf, true)
	if err != nil {
		return err
	}
	if _, err := config.Resolve(c, cm.dir()); err != nil {
		return err
	}
	return describeConfig(out, cm, c, "written")
}

func describeConfig(out io.Writer, cm baseFlags, c config.Config, verb string) error {
	fmt.Fprintf(out, "%s %s\n", filepath.Join(cm.dir(), "config.json"), verb)
	fmt.Fprintf(out, "  network   %s (chain %d)\n", c.Network, c.ChainID)
	hub := c.Hub
	if hub == "" {
		hub = "not set yet (the sidecar runs the node and waits)"
	}
	fmt.Fprintf(out, "  hub       %s\n", hub)
	if c.Node.Supervise {
		fmt.Fprintf(out, "  node      supervised: %s\n", c.Node.Binary)
	} else {
		fmt.Fprintf(out, "  node      external, at %s\n", c.RPC)
	}
	return nil
}
