package node

import (
	"context"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
)

func TestHasDeepReorgFlag(t *testing.T) {
	yes := [][]string{{"--ferminux.allowdeepreorg"}, {"-ferminux.allowdeepreorg"}, {"--syncmode", "full", "--FERMINUX.ALLOWDEEPREORG"}, {"--ferminux.allowdeepreorg=true"}}
	no := [][]string{{}, {"--syncmode", "full"}, {"--ferminux.allowdeepreorg=false"}, {"--datadir", "/x/ferminux.allowdeepreorg"}}
	for _, a := range yes {
		if !HasDeepReorgFlag(a) {
			t.Fatalf("%v not detected", a)
		}
	}
	for _, a := range no {
		if HasDeepReorgFlag(a) {
			t.Fatalf("%v falsely detected", a)
		}
	}
}

func TestProcScan(t *testing.T) {
	root := t.TempDir()
	mk := func(pid string, argv ...string) {
		os.MkdirAll(filepath.Join(root, pid), 0o755)
		os.WriteFile(filepath.Join(root, pid, "cmdline"), []byte(strings.Join(argv, "\x00")+"\x00"), 0o644)
	}
	mk("1", "/sbin/init")
	mk("self") // not a pid
	found, allowed, unknown, err := ProcScan(root)
	if err != nil || found || allowed || unknown {
		t.Fatalf("empty: %v %v %v %v", found, allowed, unknown, err)
	}
	mk("100", "/usr/local/bin/ferminux", "--syncmode", "full")
	found, allowed, unknown, _ = ProcScan(root)
	if !found || allowed || unknown {
		t.Fatal("clean node misread")
	}
	mk("150", "/usr/local/bin/ferminux", "--config=/etc/ferminux.toml")
	found, allowed, unknown, _ = ProcScan(root)
	if !found || allowed || !unknown {
		t.Fatal("a node with a settings file must read as unknown")
	}
	mk("200", "/opt/geth", "--ferminux.allowdeepreorg")
	found, allowed, unknown, _ = ProcScan(root)
	if !found || !allowed || unknown {
		t.Fatal("flagged node missed")
	}
}

func TestReorgCapProbe(t *testing.T) {
	sup := ReorgCapProbe(func() []string { return []string{"--syncmode", "full"} }, false)
	if a, err := sup(); err != nil || a {
		t.Fatal("supervised clean")
	}
	bad := ReorgCapProbe(func() []string { return []string{"--ferminux.allowdeepreorg"} }, true)
	if a, _ := bad(); !a {
		t.Fatal("supervised flagged must be reported even if the operator confirmed")
	}
	if _, err := ReorgCapProbe(nil, true)(); err != nil {
		t.Fatal("operator-confirmed external node")
	}
	// a settings file can set FerminuxAllowDeepReorg = true without the flag
	for _, args := range [][]string{{"--config", "/x.toml"}, {"-config=/x.toml"}} {
		if _, err := ReorgCapProbe(func() []string { return args }, true)(); err == nil {
			t.Fatalf("%v: supervised node with a settings file passed the reorg-cap check", args)
		}
	}
}

type fakeChain struct {
	id       uint64
	head     Header
	syncing  bool
	peers    int
	err      error
	peersErr error
}

func (f *fakeChain) ChainID(context.Context) (uint64, error) { return f.id, f.err }
func (f *fakeChain) Head(context.Context) (Header, error)    { return f.head, nil }
func (f *fakeChain) HeaderAt(context.Context, uint64) (Header, error) {
	return Header{}, errors.New("unused")
}
func (f *fakeChain) Syncing(context.Context) (bool, error)  { return f.syncing, nil }
func (f *fakeChain) PeerCount(context.Context) (int, error) { return f.peers, f.peersErr }
func (f *fakeChain) Balance(context.Context, common.Address) (*big.Int, error) {
	return nil, nil
}
func (f *fakeChain) CodeAt(context.Context, common.Address) ([]byte, error) { return nil, nil }
func (f *fakeChain) CallContract(context.Context, ferminux.CallMsg, *big.Int) ([]byte, error) {
	return nil, nil
}
func (f *fakeChain) NonceAt(context.Context, common.Address) (uint64, error) { return 0, nil }
func (f *fakeChain) EstimateGas(context.Context, ferminux.CallMsg) (uint64, error) {
	return 0, nil
}
func (f *fakeChain) SendTransaction(context.Context, *types.Transaction) error { return nil }
func (f *fakeChain) TransactionReceipt(context.Context, common.Hash) (*types.Receipt, error) {
	return nil, nil
}

func TestCheck(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ok := func() (bool, error) { return false, nil }
	base := fakeChain{id: 3961, head: Header{Number: 410000, Time: uint64(now.Unix() - 5)}, peers: 8}
	p := Policy{ChainID: 3961, MinPeers: 3, MaxHeadAge: time.Minute, DeepReorg: ok}
	if r := Check(context.Background(), &base, p, now); !r.Ready {
		t.Fatalf("healthy node not ready: %v", r.Reasons)
	}
	cases := map[string]func(f *fakeChain, p *Policy){
		"wrong chain": func(f *fakeChain, p *Policy) { f.id = 1 },
		"syncing":     func(f *fakeChain, p *Policy) { f.syncing = true },
		"stale head":  func(f *fakeChain, p *Policy) { f.head.Time = uint64(now.Unix() - 61) },
		"few peers":   func(f *fakeChain, p *Policy) { f.peers = 2 },
		"deep reorg":  func(f *fakeChain, p *Policy) { p.DeepReorg = func() (bool, error) { return true, nil } },
		"unknown cap": func(f *fakeChain, p *Policy) { p.DeepReorg = nil },
		"down":        func(f *fakeChain, p *Policy) { f.err = errors.New("dial") },
	}
	// no peer requirement: a chain without net_peerCount is fine
	noPeers := base
	noPeers.peersErr = errors.New("method not found")
	if r := Check(context.Background(), &noPeers, Policy{ChainID: 3961, MaxHeadAge: time.Minute, DeepReorg: ok}, now); !r.Ready {
		t.Fatalf("lab chain without net_peerCount: %v", r.Reasons)
	}
	if r := Check(context.Background(), &noPeers, p, now); r.Ready {
		t.Fatal("mainnet policy ignored a failing peer count")
	}
	for name, mut := range cases {
		f, pp := base, p
		mut(&f, &pp)
		if r := Check(context.Background(), &f, pp, now); r.Ready || len(r.Reasons) == 0 {
			t.Fatalf("%s: reported ready", name)
		}
	}
}
