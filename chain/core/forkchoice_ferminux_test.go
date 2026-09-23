// Copyright 2026 The Ferminux Network Authors
// Fork-choice tests for the Ferminux authority chain (forkchoice.go).

package core

import (
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/params"
)

// tdReader is a ChainReader serving total difficulties from a map.
type tdReader struct {
	config *params.ChainConfig
	tds    map[common.Hash]*big.Int
}

func (r *tdReader) Config() *params.ChainConfig { return r.config }
func (r *tdReader) GetTd(hash common.Hash, _ uint64) *big.Int {
	return r.tds[hash]
}

// header makes a distinct header at `number` with the given TD registered.
func (r *tdReader) header(number uint64, td int64, tag string) *types.Header {
	h := &types.Header{Number: new(big.Int).SetUint64(number), Extra: []byte(tag)}
	r.tds[h.Hash()] = big.NewInt(td)
	return h
}

// TestFerminuxForkChoicePosaDominatesPoW: an authority head (>= PosaBlock) is
// never abandoned for a proof-of-work head however heavy, a proof-of-work head
// is always abandoned for an authority head however light, and total
// difficulty decides only between heads of the same kind. With PosaBlock unset
// the stock total-difficulty rule is untouched.
func TestFerminuxForkChoicePosaDominatesPoW(t *testing.T) {
	config := *params.TestChainConfig
	config.PosaBlock = big.NewInt(10)
	reader := &tdReader{config: &config, tds: map[common.Hash]*big.Int{}}
	forker := NewForkChoice(reader, nil)

	var (
		powHeavy  = reader.header(9, 1_000_000_000, "pow-heavy")  // dead-end PoW branch, huge TD
		powLight  = reader.header(9, 900_000_000, "pow-light")    // the canonical pre-fork PoW block
		posaHead  = reader.header(12, 900_000_024, "posa-12")     // canonical authority head
		posaNext  = reader.header(13, 900_000_026, "posa-13")     // child of the head
		posaLight = reader.header(12, 900_000_022, "posa-12-alt") // competing, lighter authority block
		posaHeavy = reader.header(12, 900_000_026, "posa-12-hvy") // competing, heavier authority block
		posaFirst = reader.header(10, 900_000_020, "posa-10")     // first authority block
	)
	check := func(name string, current, extern *types.Header, want bool) {
		t.Helper()
		got, err := forker.ReorgNeeded(current, extern)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != want {
			t.Errorf("%s: reorg = %v, want %v", name, got, want)
		}
	}
	check("authority head vs heavier PoW dead end", posaHead, powHeavy, false)
	check("authority head vs lighter PoW block", posaHead, powLight, false)
	check("PoW head vs lighter first authority block", powHeavy, posaFirst, true)
	check("PoW head vs lighter later authority block", powHeavy, posaHead, true)
	check("authority head vs its child", posaHead, posaNext, true)
	check("authority head vs lighter sibling", posaHead, posaLight, false)
	check("authority head vs heavier sibling", posaHead, posaHeavy, true)
	check("PoW head vs heavier PoW", powLight, powHeavy, true)
	check("PoW head vs lighter PoW", powHeavy, powLight, false)

	// PosaBlock unset: pure total difficulty, byte-identical to today.
	stock := *params.TestChainConfig
	stock.PosaBlock = nil
	reader.config = &stock
	check("stock: heavier wins", posaHead, powHeavy, true)
	check("stock: lighter loses", powHeavy, posaHead, false)
	check("stock: heavier sibling wins", posaHead, posaHeavy, true)
}
