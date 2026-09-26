// Package config holds the sidecar's per-network settings and on-disk layout.
//
// Everything for one network lives under <datadir>/<network>/:
//
//	config.json            settings (this file's Config)
//	keys/attester.json     the attester key, scrypt-encrypted keystore JSON
//	keys/attester.network  which network the key was made for (per-network keys)
//	keys/attester.pass.dpapi  Windows only: the keystore password, DPAPI-protected (machine scope)
//	protection.log         the append-only slashing-protection database
//	validator.lock         held while a sidecar runs for this network
//	dashboard.addr         the dashboard's current 127.0.0.1 address
//	node/                  the node's datadir when the sidecar supervises it
//	logs/                  sidecar and node logs
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/params"
	"github.com/aliasghar89/ferminux/validator/internal/attest"
)

// MainnetChainID is the Ferminux Network.
const MainnetChainID = 3961

// Preset is a built-in network.
type Preset struct {
	Name       string
	ChainID    uint64
	Hub        common.Address // zero until the hub is deployed; then pinned here
	MinPeers   int
	MaxHeadAge time.Duration
	// StaticPeers are public nodes a supervised node keeps a permanent link to
	// (the node's static-nodes.json), on top of what discovery finds.
	StaticPeers []string
}

// Presets are the built-in networks. "devnet" is for a local lab or anvil
// chain: its chain id and hub must be given in config.json.
var Presets = map[string]Preset{
	"mainnet": {Name: "mainnet", ChainID: MainnetChainID, MinPeers: 3, MaxHeadAge: 60 * time.Second, StaticPeers: params.FerminuxBootnodes},
	"devnet":  {Name: "devnet", MinPeers: 0, MaxHeadAge: 60 * time.Second},
}

// DefaultMaxPeers is the supervised node's peer cap: enough for a healthy
// view of the chain, modest enough for a home connection.
const DefaultMaxPeers = 25

// NodeConfig controls the optional supervised node process.
type NodeConfig struct {
	// Supervise: the sidecar starts the node binary itself, restarts it if it
	// exits and stops it on shutdown. Off: it attaches to a node already running.
	Supervise bool `json:"supervise"`
	// Binary is the node executable (default: ferminux[.exe] next to this program).
	Binary string `json:"binary,omitempty"`
	// DataDir is the node's datadir (default: <network dir>/node).
	DataDir string `json:"datadir,omitempty"`
	// Cache is the node's --cache in MB.
	Cache int `json:"cache,omitempty"`
	// MaxPeers is the node's --maxpeers (default DefaultMaxPeers).
	MaxPeers int `json:"maxPeers,omitempty"`
	// Inbound lets the node ask the router to forward its P2P port
	// (--nat any: UPnP or NAT-PMP). Off (the default) is sentry mode: the
	// node runs with --nat none, dials out to the bootnodes and its static
	// peers, and needs no inbound port. Discovery stays on either way.
	Inbound bool `json:"inbound,omitempty"`
	// ExtraArgs are appended to the node's command line. Flags that would
	// unlock accounts, open the node's RPC to the network, turn
	// block production on or lift the reorg cap are refused. A --maxpeers or
	// --nat given here replaces the default above.
	ExtraArgs []string `json:"extraArgs,omitempty"`
}

// GasConfig bounds what the attester key pays per attestation transaction.
type GasConfig struct {
	TipGwei    float64 `json:"tipGwei"`
	MaxFeeGwei float64 `json:"maxFeeGwei"`
}

// Config is config.json.
type Config struct {
	Network string `json:"network"`
	ChainID uint64 `json:"chainId"`
	Hub     string `json:"hub"`
	// RPC is how to reach the node: an IPC path (preferred; a named pipe on
	// Windows) or http://127.0.0.1:port. Empty means the supervised node's IPC.
	RPC               string     `json:"rpc,omitempty"`
	MinPeers          *int       `json:"minPeers,omitempty"`
	MaxHeadAgeSeconds int        `json:"maxHeadAgeSeconds,omitempty"`
	SubmitMargin      uint64     `json:"submitMarginBlocks,omitempty"`
	Dashboard         string     `json:"dashboard,omitempty"`
	PasswordFile      string     `json:"passwordFile,omitempty"`
	Node              NodeConfig `json:"node"`
	Gas               GasConfig  `json:"gas"`
	// ExternalNodeFlagsChecked must be set to true by the operator when the
	// sidecar attaches to a node it cannot inspect (not supervised, and no
	// /proc to read its command line): it confirms that node was NOT started
	// with --ferminux.allowdeepreorg.
	ExternalNodeFlagsChecked bool `json:"externalNodeFlagsChecked,omitempty"`
	// AdoptOnChainHistory lets a key whose earlier attestations were made on
	// another machine start here: those heights are imported from the chain
	// and a watermark is raised to the current head. Leave false unless the
	// other machine is permanently stopped.
	AdoptOnChainHistory bool `json:"adoptOnChainHistory,omitempty"`
}

// Resolved is a validated Config with defaults applied.
type Resolved struct {
	Config
	Dir        string // <datadir>/<network>
	HubAddr    common.Address
	MinPeers   int
	MaxHeadAge time.Duration
	Schedule   attest.Schedule
}

// DefaultDataDir is where the sidecar keeps its state when --datadir is not given.
func DefaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, "FerminuxValidator")
		}
		return `C:\ProgramData\FerminuxValidator`
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "FerminuxValidator")
		}
	default:
		if os.Geteuid() == 0 {
			return "/var/lib/fmx-validator"
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".fmx-validator")
		}
	}
	return ".fmx-validator"
}

// StaticPeers are the public nodes a supervised node keeps a permanent link to.
func (r *Resolved) StaticPeers() []string {
	return append([]string(nil), Presets[r.Network].StaticPeers...)
}

// NetworkDir is <datadir>/<network>.
func NetworkDir(datadir, network string) string { return filepath.Join(datadir, network) }

// HubMissing reports that no hub address is configured yet.
func (r *Resolved) HubMissing() bool { return r.HubAddr == (common.Address{}) }

// Path helpers.
func (r *Resolved) KeysDir() string        { return filepath.Join(r.Dir, "keys") }
func (r *Resolved) ProtectionPath() string { return filepath.Join(r.Dir, "protection.log") }
func (r *Resolved) LockPath() string       { return filepath.Join(r.Dir, "validator.lock") }
func (r *Resolved) DashboardAddrPath() string {
	return filepath.Join(r.Dir, "dashboard.addr")
}
func (r *Resolved) LogDir() string { return filepath.Join(r.Dir, "logs") }
func (r *Resolved) NodeDataDir() string {
	if r.Node.DataDir != "" {
		return r.Node.DataDir
	}
	return filepath.Join(r.Dir, "node")
}

// IPCName is the node IPC endpoint name the supervised node is started with.
// On Windows it becomes \\.\pipe\<name>; elsewhere it is a socket file in the
// node datadir. A per-network name keeps two nodes on one PC apart.
func (r *Resolved) IPCName() string { return "fmx-validator-" + r.Network + ".ipc" }

// RPCEndpoint is where the sidecar dials the node.
func (r *Resolved) RPCEndpoint() string {
	if r.RPC != "" {
		return r.RPC
	}
	if runtime.GOOS == "windows" {
		return `\\.\pipe\` + r.IPCName()
	}
	return filepath.Join(r.NodeDataDir(), r.IPCName())
}

// Load reads <datadir>/<network>/config.json and validates it.
func Load(datadir, network string) (*Resolved, error) {
	dir := NetworkDir(datadir, network)
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("no config for network %q in %s: run `fmx-validator init --network %s` first", network, datadir, network)
		}
		return nil, err
	}
	var c Config
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Join(dir, "config.json"), err)
	}
	if c.Network != network {
		return nil, fmt.Errorf("%s says network %q, expected %q", filepath.Join(dir, "config.json"), c.Network, network)
	}
	return Resolve(c, dir)
}

// Default returns a fresh config for a network.
func Default(network string) (Config, error) {
	p, ok := Presets[network]
	if !ok {
		return Config{}, fmt.Errorf("unknown network %q (known: mainnet, devnet)", network)
	}
	c := Config{
		Network:   network,
		ChainID:   p.ChainID,
		Dashboard: "127.0.0.1:0",
		Node:      NodeConfig{Supervise: runtime.GOOS == "windows", Cache: 128},
		Gas:       GasConfig{TipGwei: 1, MaxFeeGwei: 50},
	}
	if p.Hub != (common.Address{}) {
		c.Hub = p.Hub.Hex()
	}
	return c, nil
}

// Resolve validates c and applies defaults.
func Resolve(c Config, dir string) (*Resolved, error) {
	p, ok := Presets[c.Network]
	if !ok {
		return nil, fmt.Errorf("unknown network %q", c.Network)
	}
	r := &Resolved{Config: c, Dir: dir, MinPeers: p.MinPeers, MaxHeadAge: p.MaxHeadAge, Schedule: attest.DefaultSchedule()}
	switch {
	case c.Network == "mainnet" && c.ChainID != MainnetChainID:
		return nil, fmt.Errorf("mainnet config has chainId %d, must be %d", c.ChainID, MainnetChainID)
	case c.ChainID == 0:
		return nil, errors.New("config: chainId is required")
	}
	// The hub may be left empty until its address is published (HubMissing);
	// the sidecar then runs the node and the dashboard but signs nothing.
	if c.Hub != "" {
		if !common.IsHexAddress(c.Hub) {
			return nil, fmt.Errorf("config: hub must be the ValidatorHub address (got %q)", c.Hub)
		}
		r.HubAddr = common.HexToAddress(c.Hub)
	} else if p.Hub != (common.Address{}) {
		r.HubAddr = p.Hub
	}
	if p.Hub != (common.Address{}) && r.HubAddr != p.Hub {
		return nil, fmt.Errorf("config: %s hub is %s, config says %s", c.Network, p.Hub.Hex(), r.HubAddr.Hex())
	}
	if c.MinPeers != nil {
		if c.Network == "mainnet" && *c.MinPeers < p.MinPeers {
			return nil, fmt.Errorf("config: mainnet needs at least %d peers", p.MinPeers)
		}
		r.MinPeers = *c.MinPeers
	}
	if c.MaxHeadAgeSeconds > 0 {
		if c.Network == "mainnet" && time.Duration(c.MaxHeadAgeSeconds)*time.Second > p.MaxHeadAge {
			return nil, fmt.Errorf("config: mainnet head age limit cannot exceed %s", p.MaxHeadAge)
		}
		r.MaxHeadAge = time.Duration(c.MaxHeadAgeSeconds) * time.Second
	}
	if c.SubmitMargin > 0 {
		r.Schedule.SubmitMargin = c.SubmitMargin
	}
	if err := r.Schedule.Validate(); err != nil {
		return nil, err
	}
	if c.Dashboard == "" {
		r.Dashboard = "127.0.0.1:0"
	}
	if err := CheckLoopback(r.Dashboard); err != nil {
		return nil, err
	}
	if c.Gas.TipGwei <= 0 {
		r.Gas.TipGwei = 1
	}
	if c.Gas.MaxFeeGwei <= 0 {
		r.Gas.MaxFeeGwei = 50
	}
	if r.Gas.MaxFeeGwei < r.Gas.TipGwei {
		return nil, errors.New("config: gas.maxFeeGwei is below gas.tipGwei")
	}
	if r.Node.Cache == 0 {
		r.Node.Cache = 128
	}
	switch {
	case r.Node.MaxPeers == 0:
		r.Node.MaxPeers = DefaultMaxPeers
	case r.Node.MaxPeers < 0 || r.Node.MaxPeers > 200:
		return nil, fmt.Errorf("config: node.maxPeers %d is out of range (1 to 200)", r.Node.MaxPeers)
	}
	if r.Node.MaxPeers < r.MinPeers {
		return nil, fmt.Errorf("config: node.maxPeers %d is below the %d peers the sidecar needs before it signs", r.Node.MaxPeers, r.MinPeers)
	}
	if err := CheckNodeArgs(r.Node.ExtraArgs); err != nil {
		return nil, err
	}
	if strings.HasPrefix(strings.ToLower(r.RPC), "http") {
		if err := checkLocalURL(r.RPC); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// Save writes config.json (mode 0600).
func Save(dir string, c Config) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "config.json"), append(b, '\n'), 0o600)
}

// CheckLoopback refuses any dashboard bind address that is not 127.0.0.1/::1.
func CheckLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("dashboard address %q: %w", addr, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("dashboard address %q: must be a loopback IP such as 127.0.0.1", addr)
	}
	return nil
}

func checkLocalURL(u string) error {
	rest := u[strings.Index(u, "://")+3:]
	host := rest
	if i := strings.IndexAny(rest, "/?"); i >= 0 {
		host = rest[:i]
	}
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	if h == "localhost" {
		return nil
	}
	if ip := net.ParseIP(strings.Trim(h, "[]")); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("config: rpc %q is not on this machine; the sidecar only talks to its own node (use IPC or http://127.0.0.1)", u)
}

// forbiddenNodeFlags may never be passed to a supervised node.
var forbiddenNodeFlags = []string{
	"--ferminux.allowdeepreorg",                         // lifts the 64-block reorg cap the attestation depends on
	"--unlock", "--allow-insecure-unlock", "--password", // no accounts are unlocked in the node
	"--mine",                      // Step 1 seats do not produce blocks
	"--http", "--ws", "--graphql", // the node is reached over IPC only
	"--http.addr", "--ws.addr", "--http.corsdomain", "--ws.origins", "--http.vhosts",
	"--datadir", "--ipcpath", "--ipcdisable", // the sidecar owns these
	"--config", // a settings file can do any of the above (FerminuxAllowDeepReorg, HTTPHost …)
}

// CheckNodeArgs refuses extra node flags that would break the sidecar's safety
// assumptions.
func CheckNodeArgs(args []string) error {
	for _, a := range args {
		name := strings.ToLower(a)
		if i := strings.IndexByte(name, '='); i >= 0 {
			name = name[:i]
		}
		if strings.HasPrefix(name, "-") && !strings.HasPrefix(name, "--") {
			name = "-" + name
		}
		for _, f := range forbiddenNodeFlags {
			if name == f {
				return fmt.Errorf("config: node flag %s is not allowed for a validator node", f)
			}
		}
		if strings.HasPrefix(name, "--miner.") {
			return fmt.Errorf("config: node flag %s is not allowed for a validator node", name)
		}
	}
	return nil
}
