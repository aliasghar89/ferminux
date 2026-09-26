// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package rawdb

import (
	"math"
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
)

// TestHeaderRangeFreezerCap checks the upstream #29534 sanity limit: however
// large count is, ReadHeaderRange reads at most maxHeaderRangeBytes from the
// freezer. The frozen segment here is 5000 ordinary-sized headers (~2.7 MB):
// release A sized its read as count*700 bytes and returned all of it, which on
// mainnet is ~420k headers (~230 MB) for one request.
func TestHeaderRangeFreezerCap(t *testing.T) {
	db, err := NewDatabaseWithFreezer(NewMemoryDatabase(), t.TempDir(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const frozen, live = 5000, 10
	var (
		blocks []*types.Block
		parent common.Hash
	)
	for i := 0; i < frozen+live; i++ {
		b := types.NewBlockWithHeader(&types.Header{
			Number:      big.NewInt(int64(i)),
			Extra:       make([]byte, 32),
			UncleHash:   types.EmptyUncleHash,
			TxHash:      types.EmptyRootHash,
			ReceiptHash: types.EmptyRootHash,
			ParentHash:  parent,
		})
		blocks = append(blocks, b)
		parent = b.Hash()
	}
	if _, err := WriteAncientBlocks(db, blocks[:frozen], make([]types.Receipts, frozen), big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks[frozen:] {
		WriteCanonicalHash(db, b.Hash(), b.NumberU64())
		WriteBlock(db, b)
	}
	head := uint64(frozen + live - 1)

	size := func(hs [][]byte) (n int) {
		for _, h := range hs {
			n += len(h)
		}
		return n
	}
	for _, count := range []uint64{frozen + live, math.MaxUint64, math.MaxUint64 / 700, 1 << 62} {
		var raw [][]byte
		for _, h := range ReadHeaderRange(db, head, count) {
			raw = append(raw, h)
		}
		// The live part (10 headers) is always served; the frozen part may be
		// refused as incomplete, but never more than the cap is read.
		if n := size(raw); n > live*700+maxHeaderRangeBytes {
			t.Errorf("count %d: read %d bytes, cap is %d", count, n, maxHeaderRangeBytes)
		}
		if len(raw) < live {
			t.Errorf("count %d: %d headers, want at least the %d live ones", count, len(raw), live)
		}
	}
	// A request that fits under the cap is served in full across the boundary.
	if got := ReadHeaderRange(db, head, 1024); len(got) != 1024 {
		t.Fatalf("1024 headers across the freezer boundary: got %d", len(got))
	}
}
