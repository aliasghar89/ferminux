// Copyright 2026 The Ferminux Network Authors
// Tests for the built-in Ferminux genesis (genesis_ferminux.go).

package core

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/params"
)

// TestDefaultFerminuxGenesisHash proves the baked-in default genesis is
// byte-identical to genesis/genesis.json (same block hash), so `init`-based
// nodes and zero-config nodes join the same chain.
func TestDefaultFerminuxGenesisHash(t *testing.T) {
	g := DefaultFerminuxGenesisBlock()
	block := g.ToBlock()

	if h := block.Hash(); h != params.FerminuxGenesisHash {
		t.Fatalf("genesis hash = %s, want %s", h.Hex(), params.FerminuxGenesisHash.Hex())
	}
	if string(g.ExtraData) != "Made with love by Wizrd - FMX" {
		t.Fatalf("extraData = %q", g.ExtraData)
	}
	if g.Config.ChainID.Cmp(big.NewInt(3961)) != 0 {
		t.Fatalf("chainId = %s, want 3961", g.Config.ChainID)
	}
	if block.GasLimit() != 30_000_000 {
		t.Fatalf("gasLimit = %d, want 30000000", block.GasLimit())
	}
	if block.BaseFee().Cmp(big.NewInt(params.InitialBaseFee)) != 0 {
		t.Fatalf("baseFee = %s, want 1 gwei", block.BaseFee())
	}

	total := new(big.Int)
	for _, acc := range g.Alloc {
		total.Add(total, acc.Balance)
	}
	want := new(big.Int).Mul(big.NewInt(30_000_000), big.NewInt(params.Ether))
	if total.Cmp(want) != 0 {
		t.Fatalf("premine = %s wei, want 30M FMX", total)
	}
}
