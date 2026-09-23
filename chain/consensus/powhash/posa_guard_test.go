// Copyright 2026 The Ferminux Network Authors
// Ethash must refuse to mine at or after the Ferminux PoSA fork block.

package powhash

import (
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/params"
)

type posaChainReader struct {
	config *params.ChainConfig
}

func (r *posaChainReader) Config() *params.ChainConfig                 { return r.config }
func (r *posaChainReader) CurrentHeader() *types.Header                { return nil }
func (r *posaChainReader) GetHeader(common.Hash, uint64) *types.Header { return nil }
func (r *posaChainReader) GetHeaderByNumber(uint64) *types.Header      { return nil }
func (r *posaChainReader) GetHeaderByHash(common.Hash) *types.Header   { return nil }
func (r *posaChainReader) GetTd(common.Hash, uint64) *big.Int          { return nil }

func TestFerminuxPowhashRefusesPosaBlocks(t *testing.T) {
	config := *params.TestChainConfig
	config.PosaBlock = big.NewInt(10)
	reader := &posaChainReader{config: &config}

	engine := NewFaker()
	defer engine.Close()

	at := &types.Header{Number: big.NewInt(10), Difficulty: big.NewInt(1)}
	above := &types.Header{Number: big.NewInt(11), Difficulty: big.NewInt(1)}
	below := &types.Header{Number: big.NewInt(9), Difficulty: big.NewInt(1)}
	results := make(chan *types.Block, 4)

	for _, h := range []*types.Header{at, above} {
		if err := engine.Seal(reader, types.NewBlockWithHeader(h), results, nil); err != errPosaBlock {
			t.Errorf("Seal(%d): err = %v, want %v", h.Number, err, errPosaBlock)
		}
		if err := engine.Prepare(reader, h); err != errPosaBlock {
			t.Errorf("Prepare(%d): err = %v, want %v", h.Number, err, errPosaBlock)
		}
	}
	select {
	case b := <-results:
		t.Fatalf("a PoSA-height block %d was sealed", b.NumberU64())
	default:
	}
	// Below the fork the (fake) sealer still works.
	if err := engine.Seal(reader, types.NewBlockWithHeader(below), results, nil); err != nil {
		t.Fatalf("Seal(9): %v", err)
	}
	if b := <-results; b.NumberU64() != 9 {
		t.Fatalf("sealed block %d, want 9", b.NumberU64())
	}
	// No chain (unit tests) and no PosaBlock keep today's behaviour.
	if err := engine.Seal(nil, types.NewBlockWithHeader(at), results, nil); err != nil {
		t.Errorf("Seal with nil chain: %v", err)
	}
	<-results
	if err := engine.Seal(&posaChainReader{config: params.TestChainConfig}, types.NewBlockWithHeader(at), results, nil); err != nil {
		t.Errorf("Seal without PosaBlock: %v", err)
	}
	<-results
}
