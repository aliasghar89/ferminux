// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.

package posa

import (
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/params"
)

// TestSafeAndFinalizedNumbers checks the RPC tag rules on an authority chain:
// safe is len(signers)/2+1 below the head and the blocks above it come from
// distinct signers; finalized is the reorg cap below the head; neither
// applies below PosaBlock, and finalized does not apply without a cap.
func TestSafeAndFinalizedNumbers(t *testing.T) {
	for _, nSigners := range []int{5, 4, 3} {
		env := newTestEnv(testPosaBlock)
		env.signers = env.signers[:nSigners]
		env.posaConfig.InitialSigners = addresses(env.signers)
		blocks := env.makeBlocks(t, 30, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
		chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
		if err != nil {
			t.Fatalf("%d signers: import: %v", nSigners, err)
		}
		head := chain.CurrentBlock().Header()
		window := uint64(nSigners/2 + 1)

		safe, ok := engine.SafeNumber(chain, head)
		if !ok || safe != 30-window {
			t.Errorf("%d signers: safe = %d (ok %v), want %d", nSigners, safe, ok, 30-window)
		}
		seen := map[common.Address]bool{}
		for n := safe + 1; n <= 30; n++ {
			a, err := engine.Author(chain.GetHeaderByNumber(n))
			if err != nil {
				t.Fatal(err)
			}
			if seen[a] {
				t.Errorf("%d signers: %s sealed twice above the safe block", nSigners, a.Hex())
			}
			seen[a] = true
		}
		if len(seen)*2 <= nSigners {
			t.Errorf("%d signers: only %d distinct signers above the safe block", nSigners, len(seen))
		}

		if fin, ok := engine.FinalizedNumber(head, 10); !ok || fin != 20 {
			t.Errorf("%d signers: finalized with cap 10 = %d (ok %v), want 20", nSigners, fin, ok)
		}
		if fin, ok := engine.FinalizedNumber(head, params.FerminuxMaxReorgDepth); !ok || fin != 0 {
			t.Errorf("%d signers: finalized with cap 64 at head 30 = %d (ok %v), want 0", nSigners, fin, ok)
		}
		if _, ok := engine.FinalizedNumber(head, 0); ok {
			t.Errorf("%d signers: finalized with the cap off is defined", nSigners)
		}

		// Below PosaBlock neither rule applies.
		pre := chain.GetHeaderByNumber(testPosaBlock - 1)
		if _, ok := engine.SafeNumber(chain, pre); ok {
			t.Errorf("%d signers: safe defined at a proof-of-work head", nSigners)
		}
		if _, ok := engine.FinalizedNumber(pre, 10); ok {
			t.Errorf("%d signers: finalized defined at a proof-of-work head", nSigners)
		}
		chain.Stop()
	}

	// A pass-through engine (PosaBlock unset) defines neither.
	env := newTestEnv(-1)
	blocks := env.makeBlocks(t, 3, nil)
	chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer chain.Stop()
	head := chain.CurrentBlock().Header()
	if _, ok := engine.SafeNumber(chain, head); ok {
		t.Error("safe defined on a pass-through engine")
	}
	if _, ok := engine.FinalizedNumber(head, 10); ok {
		t.Error("finalized defined on a pass-through engine")
	}
}
