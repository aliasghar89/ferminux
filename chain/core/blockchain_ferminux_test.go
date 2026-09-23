// Copyright 2026 The Ferminux Network Authors
// Tests for the Ferminux reorg-depth cap (blockchain.go reorg).

package core

import (
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/consensus/powhash"
	"github.com/aliasghar89/ferminux/chain/core/rawdb"
	"github.com/aliasghar89/ferminux/chain/core/vm"
	"github.com/aliasghar89/ferminux/chain/params"
)

// testReorgCap builds a 100-block canonical chain and a heavier side chain
// that forks `depth` blocks below the head, then checks whether the node
// follows it. `posaBlock` is the chain's PosaBlock (nil when negative): the
// cap only engages while the head is an authority block by number, so the
// fake-PoW engine is enough to exercise the policy. `allow` mirrors
// --ferminux.allowdeepreorg (cap lifted).
func testReorgCap(t *testing.T, posaBlock int64, depth int, allow bool, wantFollow bool) {
	t.Helper()
	const canonLen = 100
	config := *params.TestChainConfig
	config.PosaBlock = nil
	if posaBlock >= 0 {
		config.PosaBlock = big.NewInt(posaBlock)
	}
	var (
		gendb   = rawdb.NewMemoryDatabase()
		gspec   = &Genesis{Config: &config, BaseFee: big.NewInt(params.InitialBaseFee)}
		genesis = gspec.MustCommit(gendb)
		engine  = powhash.NewFaker()
	)
	canon, _ := GenerateChain(&config, genesis, engine, gendb, canonLen, func(i int, b *BlockGen) {
		b.SetCoinbase(common.Address{1})
	})
	forkAt := canonLen - depth // common ancestor
	side, _ := GenerateChain(&config, canon[forkAt-1], engine, gendb, depth+2, func(i int, b *BlockGen) {
		b.SetCoinbase(common.Address{2})
	})

	db := rawdb.NewMemoryDatabase()
	gspec.MustCommit(db)
	cache := &CacheConfig{
		TrieCleanLimit:        256,
		TrieDirtyLimit:        256,
		TrieTimeLimit:         5 * time.Minute,
		SnapshotLimit:         256,
		SnapshotWait:          true,
		FerminuxMaxReorgDepth: params.FerminuxMaxReorgDepth, // what eth/backend.go configures
	}
	if allow {
		cache.FerminuxMaxReorgDepth = 0
	}
	chain, err := NewBlockChain(db, cache, &config, engine, vm.Config{}, nil, nil)
	if err != nil {
		t.Fatalf("failed to create chain: %v", err)
	}
	defer chain.Stop()

	if _, err := chain.InsertChain(canon); err != nil {
		t.Fatalf("failed to insert canonical chain: %v", err)
	}
	_, err = chain.InsertChain(side)
	head := chain.CurrentBlock()
	if wantFollow {
		if err != nil {
			t.Fatalf("posa=%d depth %d allow=%v: side chain refused: %v", posaBlock, depth, allow, err)
		}
		if want := side[len(side)-1]; head.Hash() != want.Hash() {
			t.Fatalf("posa=%d depth %d allow=%v: head = %d/%s, want side head %d/%s", posaBlock, depth, allow, head.NumberU64(), head.Hash().Hex(), want.NumberU64(), want.Hash().Hex())
		}
		return
	}
	if err == nil || !strings.Contains(err.Error(), "refusing chain reorg") {
		t.Fatalf("posa=%d depth %d: expected the reorg cap to refuse, got err=%v head=%d", posaBlock, depth, err, head.NumberU64())
	}
	if want := canon[len(canon)-1]; head.Hash() != want.Hash() {
		t.Fatalf("depth %d: head = %d/%s after refusal, want canonical %d/%s", depth, head.NumberU64(), head.Hash().Hex(), want.NumberU64(), want.Hash().Hex())
	}
	// Canonical mapping is intact below the fork point as well.
	if got := chain.GetCanonicalHash(uint64(forkAt + 1)); got != canon[forkAt].Hash() {
		t.Fatalf("depth %d: canonical block %d = %s after refusal, want %s", depth, forkAt+1, got.Hex(), canon[forkAt].Hash().Hex())
	}
}

// With the head above PosaBlock the cap is enforced.

func TestFerminuxReorgCapAllowsCapDepth(t *testing.T) {
	testReorgCap(t, 1, params.FerminuxMaxReorgDepth, false, true)
}

func TestFerminuxReorgCapRefusesDeeper(t *testing.T) {
	testReorgCap(t, 1, params.FerminuxMaxReorgDepth+1, false, false)
}

func TestFerminuxReorgCapLiftedByFlag(t *testing.T) {
	testReorgCap(t, 1, params.FerminuxMaxReorgDepth+1, true, true)
}

func TestFerminuxReorgCapShallow(t *testing.T) {
	testReorgCap(t, 1, 3, false, true)
}

// TestFerminuxReorgCapInertWithoutPosaBlock: with PosaBlock unset (today's
// live configuration) the node wiring's cap never engages, so a deep
// heaviest-chain reorg is accepted exactly as before: PoW behaviour stays
// byte-identical and a partition heals instead of splitting for good.
func TestFerminuxReorgCapInertWithoutPosaBlock(t *testing.T) {
	testReorgCap(t, -1, params.FerminuxMaxReorgDepth+1, false, true)
	testReorgCap(t, -1, 90, false, true)
}

// TestFerminuxReorgCapInertUnderPoWHead: with PosaBlock set but the head
// still below it (syncing the pre-fork segment) the cap is inert too.
func TestFerminuxReorgCapInertUnderPoWHead(t *testing.T) {
	testReorgCap(t, 200, params.FerminuxMaxReorgDepth+1, false, true)
}

// TestFerminuxReorgCapIsNodeWiring documents that the cap is a node-level
// policy: a CacheConfig without FerminuxMaxReorgDepth (library users, the
// upstream tests) keeps stock reorg behaviour, and the constant the node
// wiring applies is 64.
func TestFerminuxReorgCapIsNodeWiring(t *testing.T) {
	if params.FerminuxMaxReorgDepth != 64 {
		t.Fatalf("FerminuxMaxReorgDepth = %d, want 64", params.FerminuxMaxReorgDepth)
	}
	if defaultCacheConfig.FerminuxMaxReorgDepth != 0 {
		t.Fatalf("library default cache config must not cap reorgs (got %d)", defaultCacheConfig.FerminuxMaxReorgDepth)
	}
}
