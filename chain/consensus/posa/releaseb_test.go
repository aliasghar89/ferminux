// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.

package posa

import (
	"bytes"
	"encoding/json"
	"math/big"
	"os"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/consensus/powhash"
	"github.com/aliasghar89/ferminux/chain/core/rawdb"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/params"
)

// loadMainnetForkHeaders reads mainnet headers 159998, 159999 and 160000 from
// testdata and checks that each recomputes to the hash the node reported.
func loadMainnetForkHeaders(t *testing.T) []*types.Header {
	t.Helper()
	raw, err := os.ReadFile("testdata/mainnet-fork-headers.json")
	if err != nil {
		t.Fatal(err)
	}
	var body [][]byte
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if !bytes.HasPrefix(bytes.TrimSpace(line), []byte("//")) {
			body = append(body, line)
		}
	}
	js := bytes.Join(body, []byte("\n"))
	var (
		headers  []*types.Header
		reported []struct {
			Hash common.Hash `json:"hash"`
		}
	)
	if err := json.Unmarshal(js, &headers); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(js, &reported); err != nil {
		t.Fatal(err)
	}
	for i, h := range headers {
		if h.Hash() != reported[i].Hash {
			t.Fatalf("header %v recomputes to %x, the node reported %x", h.Number, h.Hash(), reported[i].Hash)
		}
	}
	return headers
}

// TestReleaseBPinMatchesMainnet checks the compiled release-B pin against the
// real mainnet headers: block 159999 hashes to it, block 160000 builds on it,
// and the mainnet engine accepts both at the checkpoint and refuses a
// proof-of-work sibling of 159999 and an authority block on another parent.
func TestReleaseBPinMatchesMainnet(t *testing.T) {
	headers := loadMainnetForkHeaders(t)
	prev, fm1, f := headers[0], headers[1], headers[2]
	if fm1.Number.Uint64() != 159999 || f.Number.Uint64() != 160000 {
		t.Fatalf("fixture numbers %v, %v", fm1.Number, f.Number)
	}
	cfg := FerminuxConfig()
	if cfg.CheckpointHash != fm1.Hash() {
		t.Fatalf("compiled pin %x, mainnet block 159999 is %x", cfg.CheckpointHash, fm1.Hash())
	}
	if f.ParentHash != cfg.CheckpointHash {
		t.Fatalf("mainnet block 160000 parent %x, pin %x", f.ParentHash, cfg.CheckpointHash)
	}
	engine, err := New(params.FerminuxChainConfig, cfg, powhash.NewFaker(), rawdb.NewMemoryDatabase())
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	for _, h := range headers {
		if err := engine.verifyCheckpoint(h); err != nil {
			t.Errorf("mainnet header %v: %v", h.Number, err)
		}
	}
	if !engine.needsCheckpointFilter([]*types.Header{prev, fm1, f}) {
		t.Error("a batch spanning 159998..160000 skips the checkpoint filter")
	}

	sibling := types.CopyHeader(fm1)
	sibling.Nonce = types.EncodeNonce(fm1.Nonce.Uint64() + 1) // same parent, other proof of work
	if err := engine.verifyCheckpoint(sibling); err != errCheckpointMismatch {
		t.Errorf("proof-of-work sibling of 159999: %v, want %v", err, errCheckpointMismatch)
	}
	other := types.CopyHeader(f)
	other.ParentHash = sibling.Hash()
	if err := engine.verifyCheckpoint(other); err != errCheckpointMismatch {
		t.Errorf("block 160000 on the sibling: %v, want %v", err, errCheckpointMismatch)
	}
}

// foreignHistory returns chain A and a chain B whose proof-of-work history
// differs from block 1 (other block times), so hash(F-1) differs, with the
// same authority rules after it. The pin is A's hash(F-1).
func foreignHistory(t *testing.T, n int) (env *testEnv, a, b []*types.Block, pinned *Config) {
	t.Helper()
	env = newTestEnv(testPosaBlock)
	plan := func(num uint64) blockPlan { return defaultPlan(num, env.signers) }
	a = env.makeBlocks(t, n, plan)
	envB := *env
	envB.powOffset = 3
	b = envB.makeBlocks(t, n, plan)
	if a[testPosaBlock-2].Hash() == b[testPosaBlock-2].Hash() {
		t.Fatal("chains A and B share hash(F-1)")
	}
	cfg := *env.posaConfig
	cfg.CheckpointHash = a[testPosaBlock-2].Hash()
	return env, a, b, &cfg
}

// TestReleaseBRefusesForeignHistory: a node with the pin refuses a chain whose
// block F-1 is not the pinned one, both on full import (InsertChain) and on
// the header-first path that fast and snap sync use (InsertHeaderChain), and
// never moves past F-2 on it. The pinned chain itself imports.
func TestReleaseBRefusesForeignHistory(t *testing.T) {
	env, a, b, pinned := foreignHistory(t, 14)

	chain, _, _, err := env.importChain(t, a, pinned)
	if err != nil {
		t.Fatalf("pinned chain: %v", err)
	}
	if head := chain.CurrentBlock().NumberU64(); head != 14 {
		t.Fatalf("pinned chain head %d, want 14", head)
	}
	chain.Stop()

	// Full import.
	chain, _, index, err := env.importChain(t, b, pinned)
	assertErrContains(t, err, "checkpoint")
	if index != testPosaBlock-2 {
		t.Errorf("import stopped at index %d, want %d (block F-1)", index, testPosaBlock-2)
	}
	if head := chain.CurrentBlock().NumberU64(); head != testPosaBlock-2 {
		t.Errorf("head %d on the foreign chain, want %d", head, testPosaBlock-2)
	}
	chain.Stop()

	// Header sync.
	chain, _, _ = env.newChain(t, pinned)
	defer chain.Stop()
	headers := make([]*types.Header, len(b))
	for i, blk := range b {
		headers[i] = blk.Header()
	}
	if _, err := chain.InsertHeaderChain(headers, 1); err == nil {
		t.Fatal("header chain with a foreign F-1 was accepted")
	}
	if h := chain.CurrentHeader().Number.Uint64(); h >= testPosaBlock-1 {
		t.Errorf("header head %d on the foreign chain, want below %d", h, testPosaBlock-1)
	}
	if chain.GetHeaderByHash(b[testPosaBlock-2].Hash()) != nil {
		t.Error("the foreign F-1 header was stored")
	}
}

// TestReleaseBRejectsCheckpointSibling is lab item 8c as a unit test: a node
// that is past the fork on the pinned chain is fed a proof-of-work sibling of
// block F-1 (same parent, different block). It must be rejected, and neither
// the head nor the canonical F-1 may move.
func TestReleaseBRejectsCheckpointSibling(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	plan := func(num uint64) blockPlan { return defaultPlan(num, env.signers) }
	a, genDB := env.makeBlocksDB(t, 12, plan)
	pinned := *env.posaConfig
	pinned.CheckpointHash = a[testPosaBlock-2].Hash()

	chain, _, _, err := env.importChain(t, a, &pinned)
	if err != nil {
		t.Fatal(err)
	}
	defer chain.Stop()
	head := chain.CurrentBlock().Hash()

	envB := *env
	envB.powOffset = 5
	sibling := envB.makeChain(t, genDB, a[testPosaBlock-3], 1, plan)[0] // a new block F-1 on F-2
	if sibling.NumberU64() != testPosaBlock-1 || sibling.ParentHash() != a[testPosaBlock-3].Hash() || sibling.Hash() == a[testPosaBlock-2].Hash() {
		t.Fatalf("bad sibling: #%d parent %x hash %x", sibling.NumberU64(), sibling.ParentHash(), sibling.Hash())
	}
	_, err = chain.InsertChain(types.Blocks{sibling})
	assertErrContains(t, err, "checkpoint")
	if chain.CurrentBlock().Hash() != head {
		t.Error("head moved after the sibling was offered")
	}
	if got := chain.GetCanonicalHash(testPosaBlock - 1); got != pinned.CheckpointHash {
		t.Errorf("canonical F-1 = %x, want the pin %x", got, pinned.CheckpointHash)
	}
	if chain.HasBlock(sibling.Hash(), sibling.NumberU64()) {
		t.Error("the sibling was stored")
	}
}

// TestConfigForScopesThePin: the compiled checkpoint applies to the chain it
// was taken from (chain id 3961, PosaBlock 160000) and to no other chain
// config, so a devnet or lab genesis with its own posaBlock is not refused at
// its block F by the mainnet hash.
func TestConfigForScopesThePin(t *testing.T) {
	pin := params.FerminuxPosaCheckpointHash
	if got := ConfigFor(params.FerminuxChainConfig).CheckpointHash; got != pin {
		t.Fatalf("mainnet: checkpoint %x, want the pin %x", got, pin)
	}
	devnet := *params.FerminuxChainConfig
	devnet.ChainID = big.NewInt(39619)
	devnet.PosaBlock = big.NewInt(1)
	lab := *params.FerminuxChainConfig
	lab.PosaBlock = big.NewInt(1)
	otherID := *params.FerminuxChainConfig
	otherID.ChainID = big.NewInt(39610)
	noFork := *params.FerminuxChainConfig
	noFork.PosaBlock = nil
	for name, cc := range map[string]*params.ChainConfig{"devnet": &devnet, "lab F=1": &lab, "other chain id": &otherID, "no PosaBlock": &noFork} {
		if got := ConfigFor(cc).CheckpointHash; got != (common.Hash{}) {
			t.Errorf("%s: checkpoint %x, want unset", name, got)
		}
		if FerminuxConfig().CheckpointHash != pin {
			t.Fatalf("%s: ConfigFor changed the shared params", name)
		}
	}
	// Every other field is FerminuxConfig's.
	a, b := ConfigFor(&devnet), FerminuxConfig()
	if a.RewardSink != b.RewardSink || a.Treasury != b.Treasury || a.Period != b.Period || a.Epoch != b.Epoch || len(a.InitialSigners) != len(b.InitialSigners) {
		t.Error("ConfigFor changed fields other than the checkpoint")
	}
}
