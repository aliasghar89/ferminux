// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package fmx

import (
	"context"
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/accounts"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/consensus/clique"
	"github.com/aliasghar89/ferminux/chain/consensus/posa"
	"github.com/aliasghar89/ferminux/chain/consensus/powhash"
	"github.com/aliasghar89/ferminux/chain/core"
	"github.com/aliasghar89/ferminux/chain/core/rawdb"
	"github.com/aliasghar89/ferminux/chain/core/vm"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/params"
	"github.com/aliasghar89/ferminux/chain/rpc"
)

// newAuthorityBackend builds an API backend over a chain of n blocks that is
// under authority from block 1 (one signer, so the safe window is one block)
// and enforces a reorg cap of maxReorgDepth.
func newAuthorityBackend(t *testing.T, n, maxReorgDepth int) (*EthAPIBackend, *core.BlockChain) {
	t.Helper()
	key, _ := crypto.GenerateKey()
	signer := crypto.PubkeyToAddress(key.PublicKey)

	config := *params.FerminuxChainConfig
	config.PosaBlock = big.NewInt(1)
	pcfg := &posa.Config{
		Period: 7, Epoch: 30000,
		InitialSigners: []common.Address{signer},
		RewardSink:     common.HexToAddress("0xb2"),
		Treasury:       common.HexToAddress("0xa1"),
	}
	gspec := &core.Genesis{Config: &config, ExtraData: []byte("ferminux test genesis"), GasLimit: 10_000_000, BaseFee: big.NewInt(params.InitialBaseFee)}

	genDB := rawdb.NewMemoryDatabase()
	genesis := gspec.MustCommit(genDB)
	genEngine, err := posa.New(&config, pcfg, powhash.NewFaker(), genDB)
	if err != nil {
		t.Fatal(err)
	}
	genEngine.Authorize(signer, func(_ accounts.Account, _ string, data []byte) ([]byte, error) {
		return crypto.Sign(crypto.Keccak256(data), key)
	})
	blocks, _ := core.GenerateChain(&config, genesis, genEngine, genDB, n, func(i int, gen *core.BlockGen) {
		gen.SetCoinbase(common.Address{})
		gen.SetDifficulty(big.NewInt(2))
		gen.SetExtra(make([]byte, 32+crypto.SignatureLength))
	})
	parent := genesis.Hash()
	for i, b := range blocks {
		h := b.Header()
		h.ParentHash = parent
		sig, err := crypto.Sign(clique.SealHash(h).Bytes(), key)
		if err != nil {
			t.Fatal(err)
		}
		copy(h.Extra[len(h.Extra)-crypto.SignatureLength:], sig)
		blocks[i] = b.WithSeal(h)
		parent = blocks[i].Hash()
	}

	db := rawdb.NewMemoryDatabase()
	gspec.MustCommit(db)
	engine, err := posa.New(&config, pcfg, powhash.NewFaker(), db)
	if err != nil {
		t.Fatal(err)
	}
	chain, err := core.NewBlockChain(db, &core.CacheConfig{
		TrieCleanLimit: 16, TrieDirtyLimit: 16, SnapshotLimit: 0,
		FerminuxMaxReorgDepth: maxReorgDepth,
	}, &config, engine, vm.Config{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := chain.InsertChain(blocks); err != nil {
		t.Fatalf("import: %v", err)
	}
	return &EthAPIBackend{eth: &Ferminux{blockchain: chain, engine: engine}}, chain
}

// TestFerminuxSafeFinalizedTags checks the backend wiring of the authority
// "safe" and "finalized" tags for headers and blocks, and the stock answer
// when the reorg cap is off.
func TestFerminuxSafeFinalizedTags(t *testing.T) {
	ctx := context.Background()
	b, chain := newAuthorityBackend(t, 20, 8)
	defer chain.Stop()

	check := func(tag rpc.BlockNumber, want uint64) {
		t.Helper()
		h, err := b.HeaderByNumber(ctx, tag)
		if err != nil || h == nil || h.Number.Uint64() != want {
			t.Fatalf("HeaderByNumber(%v) = %v, %v; want block %d", tag, h, err, want)
		}
		blk, err := b.BlockByNumber(ctx, tag)
		if err != nil || blk == nil || blk.Hash() != h.Hash() {
			t.Fatalf("BlockByNumber(%v) = %v, %v; want %x", tag, blk, err, h.Hash())
		}
		hh, err := b.HeaderByNumberOrHash(ctx, rpc.BlockNumberOrHashWithNumber(tag))
		if err != nil || hh.Hash() != h.Hash() {
			t.Fatalf("HeaderByNumberOrHash(%v) = %v, %v", tag, hh, err)
		}
	}
	check(rpc.FinalizedBlockNumber, 20-8)
	check(rpc.SafeBlockNumber, 20-1)

	// --ferminux.allowdeepreorg: no cap, no finalized block; safe still holds.
	b2, chain2 := newAuthorityBackend(t, 5, 0)
	defer chain2.Stop()
	if h, err := b2.HeaderByNumber(ctx, rpc.FinalizedBlockNumber); err == nil || h != nil {
		t.Fatalf("finalized with the cap off = %v, %v; want not found", h, err)
	}
	if blk, _ := b2.BlockByNumber(ctx, rpc.FinalizedBlockNumber); blk != nil {
		t.Fatalf("finalized block with the cap off = %d", blk.NumberU64())
	}
	if h, err := b2.HeaderByNumber(ctx, rpc.SafeBlockNumber); err != nil || h.Number.Uint64() != 4 {
		t.Fatalf("safe with the cap off = %v, %v; want block 4", h, err)
	}
}
