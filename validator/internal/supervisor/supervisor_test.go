package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/status"
)

// The test binary doubles as a fake node: FAKE_NODE=exit exits at once,
// FAKE_NODE=run waits for an interrupt and exits cleanly.
func TestMain(m *testing.M) {
	switch os.Getenv("FAKE_NODE") {
	case "exit":
		os.Exit(3)
	case "fatal":
		os.Stderr.WriteString("INFO starting\nFatal: Error starting protocol stack: listen tcp :30303: bind: address already in use\n")
		os.Exit(1)
	case "run":
		fakeNode()
		return
	}
	os.Exit(m.Run())
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func TestRestartsAfterExit(t *testing.T) {
	t.Setenv("FAKE_NODE", "exit")
	tr := status.NewTracker(status.Snapshot{})
	s := &Supervisor{Binary: os.Args[0], Status: tr, MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	s.Run(ctx)
	if n := tr.Snapshot().Node; n.Restarts < 3 || !n.Supervised {
		t.Fatalf("restarts=%d supervised=%v", n.Restarts, n.Supervised)
	}
}

// The node's own "Fatal:" line is what the dashboard shows, not just the exit status.
func TestExitReason(t *testing.T) {
	t.Setenv("FAKE_NODE", "fatal")
	tr := status.NewTracker(status.Snapshot{})
	s := &Supervisor{Binary: os.Args[0], Status: tr, MinBackoff: time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	s.Run(ctx)
	n := tr.Snapshot().Node
	if !strings.Contains(n.LastExit, "address already in use") || !strings.Contains(n.LastExit, "exit status 1") {
		t.Fatalf("last exit %q", n.LastExit)
	}
	if p := tr.Snapshot().Phase; p.State != status.PhaseNodeDown || !strings.Contains(p.Detail, "address already in use") {
		t.Fatalf("phase %+v", p)
	}
}

func TestGracefulStop(t *testing.T) {
	PrepareService() // Windows: CTRL_BREAK needs a console, which a CI runner may not give the test
	t.Setenv("FAKE_NODE", "run")
	out := &syncBuf{}
	tr := status.NewTracker(status.Snapshot{})
	s := &Supervisor{Binary: os.Args[0], Status: tr, Output: out, StopTimeout: 5 * time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), "fake node up") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !tr.Snapshot().Node.Running {
		t.Fatal("not running")
	}
	start := time.Now()
	cancel()
	<-done
	if !strings.Contains(out.String(), "fake node interrupted") {
		t.Fatalf("node was not interrupted cleanly: %q", out.String())
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("stop waited for the kill timeout")
	}
	if tr.Snapshot().Node.Restarts != 0 {
		t.Fatal("a requested stop counted as a crash")
	}
}

func TestMissingBinary(t *testing.T) {
	s := &Supervisor{Binary: "/nonexistent/ferminux"}
	if err := s.Run(context.Background()); err == nil {
		t.Fatal("missing binary accepted")
	}
	_ = exec.ErrNotFound
}

func TestNodeArgs(t *testing.T) {
	c, _ := config.Default("mainnet")
	c.Hub = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
	r, err := config.Resolve(c, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := strings.Join(NodeArgs(r), " ")
	// sentry mode: discovery on (so no --nodiscover), a modest peer cap, no router port mapping
	for _, want := range []string{"--syncmode full", "--cache 128", "--ipcpath", "--maxpeers 25", "--nat none", "--datadir " + r.NodeDataDir()} {
		if !strings.Contains(a, want) {
			t.Fatalf("%q lacks %q", a, want)
		}
	}
	for _, bad := range []string{"--http", "--mine", "--unlock", "allowdeepreorg", "--networkid", "--nodiscover", "--bootnodes"} {
		if strings.Contains(a, bad) {
			t.Fatalf("%q has %q", a, bad)
		}
	}

	// the operator's own --maxpeers / --nat replace the defaults instead of repeating them
	c.Node.ExtraArgs = []string{"--maxpeers=40", "-nat", "extip:203.0.113.9"}
	if r, err = config.Resolve(c, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	a = strings.Join(NodeArgs(r), " ")
	if strings.Contains(a, "--maxpeers 25") || strings.Contains(a, "--nat none") || !strings.HasSuffix(a, "--maxpeers=40 -nat extip:203.0.113.9") {
		t.Fatalf("extra args did not replace the defaults: %q", a)
	}

	// node.inbound: the node may ask the router for a port mapping
	c.Node.ExtraArgs, c.Node.Inbound, c.Node.MaxPeers = nil, true, 50
	if r, err = config.Resolve(c, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	a = strings.Join(NodeArgs(r), " ")
	if strings.Contains(a, "--nat") || !strings.Contains(a, "--maxpeers 50") {
		t.Fatalf("inbound: %q", a)
	}

	// a devnet node joins its own network id
	d, _ := config.Default("devnet")
	d.ChainID = 31337
	rd, err := config.Resolve(d, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if a := strings.Join(NodeArgs(rd), " "); !strings.Contains(a, "--networkid 31337") {
		t.Fatalf("devnet: %q", a)
	}
}

const (
	peerA = "enode://b31c40acfe75bfaa74c9a0306c4bdf940e6a5b1220f9ba9eaafcd94f34b8424613834631cd20606a2cd18f5f26e8b6c761145f62dcbd2bf8556e7bcc894584e0@<node-host>:30303"
	peerB = "enode://a979fb575495b8d6db44f750317d0f4622bf4c2aa3365d6af7c284339968eef29b69ad0dce72a4d8db5ebb4968de0e3bec910127f134779fbcb0cb6d3331163c@203.0.113.7:30303"
)

func TestWriteStaticPeers(t *testing.T) {
	dd := t.TempDir()
	path := StaticNodesPath(dd)
	if !strings.HasSuffix(filepath.ToSlash(path), "/ferminux-geth/static-nodes.json") {
		t.Fatalf("path %s", path)
	}
	if n, err := WriteStaticPeers(dd, []string{peerA}); err != nil || n != 1 {
		t.Fatalf("first write: %d %v", n, err)
	}
	// the operator's own entry is kept, and nothing is duplicated
	os.WriteFile(path, []byte(`["`+peerB+`","`+peerA+`"]`), 0o600)
	if n, err := WriteStaticPeers(dd, []string{peerA}); err != nil || n != 0 {
		t.Fatalf("second write: %d %v", n, err)
	}
	var got []string
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &got); err != nil || len(got) != 2 || got[0] != peerB {
		t.Fatalf("file now %s (%v)", b, err)
	}
	// a file the node would not read either is reported, never overwritten
	os.WriteFile(path, []byte("not json"), 0o600)
	if _, err := WriteStaticPeers(dd, []string{peerA}); err == nil {
		t.Fatal("malformed file overwritten")
	}
	if b, _ := os.ReadFile(path); string(b) != "not json" {
		t.Fatalf("file changed: %s", b)
	}
	if _, err := WriteStaticPeers(t.TempDir(), []string{"enode://nope@1.2.3.4:30303"}); err == nil {
		t.Fatal("malformed enode accepted")
	}
	// every compiled-in mainnet static peer parses
	c, _ := config.Default("mainnet")
	r, _ := config.Resolve(c, t.TempDir())
	if len(r.StaticPeers()) == 0 {
		t.Fatal("mainnet has no static peers")
	}
	if _, err := WriteStaticPeers(t.TempDir(), r.StaticPeers()); err != nil {
		t.Fatal(err)
	}
}

// InstanceDir must be the node's own datadir instance name, or static-nodes.json
// (and seat-proof's nodekey path) would point at a directory the node never reads.
func TestInstanceDirMatchesNode(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "chain", "cmd", "ferminux", "main.go"))
	if err != nil {
		t.Skip("chain source not next to validator/: ", err)
	}
	if !strings.Contains(string(src), `datadirInstanceName = "`+InstanceDir+`"`) {
		t.Fatalf("chain/cmd/ferminux/main.go no longer names its instance directory %q", InstanceDir)
	}
}
