// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package filters

import (
	"context"
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/consensus/powhash"
	"github.com/aliasghar89/ferminux/chain/core"
	"github.com/aliasghar89/ferminux/chain/core/rawdb"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/params"
	"github.com/aliasghar89/ferminux/chain/rpc"
)

// TestFilterTagRanges is the eth_getLogs half of upstream #25922: "safe" and
// "finalized" are resolved to block numbers before the range is walked,
// in either position, and a missing tag is an error rather than a range
// starting at block -3.
func TestFilterTagRanges(t *testing.T) {
	var (
		db      = rawdb.NewMemoryDatabase()
		backend = &testBackend{db: db}
		sys     = NewFilterSystem(backend, Config{})
		key, _  = crypto.HexToECDSA("b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291")
		addr    = crypto.PubkeyToAddress(key.PublicKey)
		topic   = common.BytesToHash([]byte("topic"))
		gspec   = core.Genesis{
			Alloc:   core.GenesisAlloc{addr: {Balance: big.NewInt(1000000)}},
			BaseFee: big.NewInt(params.InitialBaseFee),
		}
		genesis = gspec.ToBlock()
	)
	gspec.MustCommit(db)
	// One log in every block 1..20.
	chain, receipts := core.GenerateChain(params.TestChainConfig, genesis, powhash.NewFaker(), db, 20, func(i int, gen *core.BlockGen) {
		receipt := types.NewReceipt(nil, false, 0)
		receipt.Logs = []*types.Log{{Address: addr, Topics: []common.Hash{topic}}}
		gen.AddUncheckedReceipt(receipt)
		gen.AddUncheckedTx(types.NewTransaction(uint64(i), common.HexToAddress("0x1"), big.NewInt(1), 1, gen.BaseFee(), nil))
	})
	for i, block := range chain {
		rawdb.WriteBlock(db, block)
		rawdb.WriteCanonicalHash(db, block.Hash(), block.NumberU64())
		rawdb.WriteHeadBlockHash(db, block.Hash())
		rawdb.WriteReceipts(db, block.Hash(), block.NumberU64(), receipts[i])
	}
	count := func(begin, end int64) (int, error) {
		logs, err := sys.NewRangeFilter(begin, end, []common.Address{addr}, nil).Logs(context.Background())
		return len(logs), err
	}
	var (
		latest    = rpc.LatestBlockNumber.Int64()
		finalized = rpc.FinalizedBlockNumber.Int64()
		safe      = rpc.SafeBlockNumber.Int64()
	)

	// No finalized or safe block known yet: the tags are errors.
	if _, err := count(finalized, latest); err == nil {
		t.Error("finalized with no finalized block: no error")
	}
	if _, err := count(safe, latest); err == nil {
		t.Error("safe with no safe block: no error")
	}

	rawdb.WriteFinalizedBlockHash(db, chain[9].Hash()) // block 10
	backend.safe = chain[15].Header()                  // block 16

	cases := []struct {
		name       string
		begin, end int64
		want       int
	}{
		{"finalized..latest", finalized, latest, 11},      // 10..20
		{"finalized..finalized", finalized, finalized, 1}, // 10
		{"0..finalized", 0, finalized, 10},                // 1..10
		{"safe..latest", safe, latest, 5},                 // 16..20
		{"finalized..safe", finalized, safe, 7},           // 10..16
		{"latest..finalized", latest, finalized, 0},       // empty range
		{"12..latest", 12, latest, 9},                     // unchanged
	}
	for _, c := range cases {
		n, err := count(c.begin, c.end)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if n != c.want {
			t.Errorf("%s: %d logs, want %d", c.name, n, c.want)
		}
	}
}
