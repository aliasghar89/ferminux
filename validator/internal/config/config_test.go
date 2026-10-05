package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func base() Config {
	c, _ := Default("devnet")
	c.ChainID = 31337
	c.Hub = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
	return c
}

func TestResolveDefaults(t *testing.T) {
	r, err := Resolve(base(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if r.Dashboard != "127.0.0.1:0" || r.Schedule.Interval != 200 || r.Gas.TipGwei != 1 {
		t.Fatalf("defaults not applied: %+v", r)
	}
	// signers never include a tip below 1 gwei
	c := base()
	c.Gas.TipGwei = 0.5
	if r, err := Resolve(c, t.TempDir()); err != nil || r.Gas.TipGwei != 1 {
		t.Fatalf("sub-gwei tip kept: %v %v", r.Gas.TipGwei, err)
	}
}

func TestMainnetGuards(t *testing.T) {
	c, _ := Default("mainnet")
	c.Hub = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
	if _, err := Resolve(c, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	bad := c
	bad.ChainID = 31337
	if _, err := Resolve(bad, t.TempDir()); err == nil {
		t.Fatal("mainnet with a foreign chain id accepted")
	}
	zero := 0
	bad = c
	bad.MinPeers = &zero
	if _, err := Resolve(bad, t.TempDir()); err == nil {
		t.Fatal("mainnet with 0 min peers accepted")
	}
	bad = c
	bad.MaxHeadAgeSeconds = 600
	if _, err := Resolve(bad, t.TempDir()); err == nil {
		t.Fatal("mainnet with a 10 minute head age accepted")
	}
}

func TestHubOptionalButValid(t *testing.T) {
	c := base()
	c.Hub = ""
	r, err := Resolve(c, t.TempDir())
	if err != nil || !r.HubMissing() {
		t.Fatalf("empty hub: %v", err)
	}
	c.Hub = "0x1234"
	if _, err := Resolve(c, t.TempDir()); err == nil {
		t.Fatal("malformed hub accepted")
	}
}

func TestDashboardMustBeLoopback(t *testing.T) {
	for _, a := range []string{"0.0.0.0:8570", "192.168.1.5:0", "[::]:0", "localhost:80", "example.com:1"} {
		c := base()
		c.Dashboard = a
		if _, err := Resolve(c, t.TempDir()); err == nil {
			t.Fatalf("dashboard %s accepted", a)
		}
	}
	for _, a := range []string{"127.0.0.1:0", "127.0.0.1:8570", "[::1]:0"} {
		c := base()
		c.Dashboard = a
		if _, err := Resolve(c, t.TempDir()); err != nil {
			t.Fatalf("dashboard %s refused: %v", a, err)
		}
	}
}

func TestRPCMustBeLocal(t *testing.T) {
	c := base()
	c.RPC = "http://rpc.example.com:8545"
	if _, err := Resolve(c, t.TempDir()); err == nil {
		t.Fatal("remote rpc accepted")
	}
	for _, u := range []string{"http://127.0.0.1:8545", "http://localhost:8545/", "/var/lib/node/geth.ipc", `\\.\pipe\geth.ipc`} {
		c.RPC = u
		if _, err := Resolve(c, t.TempDir()); err != nil {
			t.Fatalf("%s refused: %v", u, err)
		}
	}
}

func TestNodeArgs(t *testing.T) {
	for _, a := range []string{"--ferminux.allowdeepreorg", "--unlock=0xabc", "--mine", "--http", "-http", "--http.addr=0.0.0.0", "--miner.etherbase=0x1", "--signer.enabled", "-signer.enabled=true", "--signer.rewardaddress=0x1", "--datadir=/x", "--config", "-config=/etc/node.toml"} {
		if CheckNodeArgs([]string{"--syncmode=full", a}) == nil {
			t.Fatalf("%s accepted", a)
		}
	}
	if err := CheckNodeArgs([]string{"--syncmode", "full", "--maxpeers=25", "--nat=none"}); err != nil {
		t.Fatal(err)
	}
}

func TestPeerSettings(t *testing.T) {
	c, _ := Default("mainnet")
	r, err := Resolve(c, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if r.Node.MaxPeers != DefaultMaxPeers || r.Node.Inbound || len(r.StaticPeers()) == 0 {
		t.Fatalf("mainnet peering defaults: maxPeers %d inbound %v static %v", r.Node.MaxPeers, r.Node.Inbound, r.StaticPeers())
	}
	for _, n := range []int{-1, 2, 201} { // 2 is below the 3 peers mainnet needs before signing
		c.Node.MaxPeers = n
		if _, err := Resolve(c, t.TempDir()); err == nil {
			t.Fatalf("maxPeers %d accepted", n)
		}
	}
	d := base()
	rd, err := Resolve(d, t.TempDir())
	if err != nil || len(rd.StaticPeers()) != 0 {
		t.Fatalf("devnet has static peers: %v %v", rd.StaticPeers(), err)
	}
}

func TestSaveLoad(t *testing.T) {
	dd := t.TempDir()
	c := base()
	if err := Save(NetworkDir(dd, "devnet"), c); err != nil {
		t.Fatal(err)
	}
	r, err := Load(dd, "devnet")
	if err != nil {
		t.Fatal(err)
	}
	if r.ChainID != 31337 || r.Dir != filepath.Join(dd, "devnet") {
		t.Fatalf("%+v", r)
	}
	if _, err := Load(dd, "mainnet"); err == nil {
		t.Fatal("missing config loaded")
	}
}

// install calls Save as root in a directory the service user owns: a link the
// service user planted there must never become a root write somewhere else.
func TestSaveRefusesLinks(t *testing.T) {
	dd := t.TempDir()
	dir := NetworkDir(dd, "devnet")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	const victimText = "a file the service user may not write\n"
	victim := filepath.Join(dd, "victim")
	if err := os.WriteFile(victim, []byte(victimText), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(dir, "config.json")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if err := Save(dir, base()); err == nil {
		t.Fatal("Save wrote config.json through a symlink")
	}
	if b, _ := os.ReadFile(victim); string(b) != victimText {
		t.Fatalf("the link target was overwritten: %q", b)
	}

	// the network directory itself swapped for a link
	elsewhere := t.TempDir()
	linked := filepath.Join(dd, "testnet")
	if err := os.Symlink(elsewhere, linked); err != nil {
		t.Fatal(err)
	}
	if err := Save(linked, base()); err == nil {
		t.Fatal("Save wrote through a linked network directory")
	}
	if _, err := os.Lstat(filepath.Join(elsewhere, "config.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("config.json appeared in the link's target directory: %v", err)
	}
}

// A hard link is a regular file to Lstat, so it is not refused: the new
// config.json replaces the directory entry and the other name keeps its data.
func TestSaveDoesNotWriteThroughAHardLink(t *testing.T) {
	dd := t.TempDir()
	dir := NetworkDir(dd, "devnet")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	const victimText = "a file the service user may not write\n"
	victim := filepath.Join(dd, "victim")
	if err := os.WriteFile(victim, []byte(victimText), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(victim, filepath.Join(dir, "config.json")); err != nil {
		t.Skipf("hard links unavailable here: %v", err)
	}
	if err := Save(dir, base()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(victim); string(b) != victimText {
		t.Fatalf("the other name of the hard link was overwritten: %q", b)
	}
	if _, err := Load(dd, "devnet"); err != nil {
		t.Fatalf("the saved config does not load: %v", err)
	}
}

func TestSaveReplacesAndLeavesNoTempFile(t *testing.T) {
	dd := t.TempDir()
	dir := NetworkDir(dd, "devnet")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Save(dir, base()); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dd, "devnet"); err != nil {
		t.Fatalf("the saved config does not load: %v", err)
	}
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Fatalf("config.json mode %v, want 0600", fi.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "config.json" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("directory holds %v, want only config.json", names)
	}
}
