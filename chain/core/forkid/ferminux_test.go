// Copyright 2026 The Ferminux Network Authors
// Fork-ID tests for the Ferminux PoSA switch block.

package forkid

import (
	"hash/crc32"
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/params"
)

// TestFerminuxPosaForkID checks that PosaBlock participates in the EIP-2124
// fork ID (so un-upgraded peers are refused once the fork passes) and that
// leaving it nil keeps today's ID byte-identical.
func TestFerminuxPosaForkID(t *testing.T) {
	const fork = 25_000
	genesis := params.FerminuxGenesisHash

	base := *params.FerminuxChainConfig
	base.PosaBlock = nil
	posa := *params.FerminuxChainConfig
	posa.PosaBlock = big.NewInt(fork)

	// The live config's ID below the fork: every EIP fork is at genesis, so the
	// checksum is CRC32(genesis) — unchanged from before release A, which is
	// what lets a release-A node peer with an un-upgraded one until F — and the
	// announced next fork is F itself. Until release A this asserted Next == 0
	// as a tripwire against compiling the fork in early; release A is the
	// deliberate trip, so the assertion now pins F instead.
	genesisSum := checksumToBytes(crc32.ChecksumIEEE(genesis[:]))
	if params.FerminuxChainConfig.PosaBlock == nil {
		t.Fatalf("release A must compile PosaBlock into FerminuxChainConfig")
	}
	liveFork := params.FerminuxChainConfig.PosaBlock.Uint64()
	if id := NewID(params.FerminuxChainConfig, genesis, liveFork-1); id.Hash != genesisSum || id.Next != liveFork {
		t.Fatalf("live Ferminux ID below F = %x/%d, want %x/%d (same checksum as an un-upgraded node, announcing F)", id.Hash, id.Next, genesisSum, liveFork)
	}
	idBase := NewID(&base, genesis, fork+5)
	if idBase.Hash != genesisSum || idBase.Next != 0 {
		t.Fatalf("base ID = %x/%d, want %x/0", idBase.Hash, idBase.Next, genesisSum)
	}
	// Upgraded node before the fork: same checksum, announces the fork.
	idBefore := NewID(&posa, genesis, fork-1)
	if idBefore.Hash != genesisSum || idBefore.Next != fork {
		t.Fatalf("upgraded pre-fork ID = %x/%d, want %x/%d", idBefore.Hash, idBefore.Next, genesisSum, fork)
	}
	// Upgraded node at/after the fork: checksum folds PosaBlock in.
	idAfter := NewID(&posa, genesis, fork)
	wantAfter := checksumToBytes(checksumUpdate(crc32.ChecksumIEEE(genesis[:]), fork))
	if idAfter.Hash != wantAfter || idAfter.Next != 0 {
		t.Fatalf("upgraded post-fork ID = %x/%d, want %x/0", idAfter.Hash, idAfter.Next, wantAfter)
	}
	if idAfter.Hash == idBase.Hash {
		t.Fatalf("fork ID did not change at PosaBlock")
	}

	// Handshake filters.
	upgradedAfter := newFilter(&posa, genesis, func() uint64 { return fork })
	if err := upgradedAfter(idBase); err != ErrRemoteStale {
		t.Errorf("upgraded node past the fork vs un-upgraded peer: err = %v, want %v", err, ErrRemoteStale)
	}
	if err := upgradedAfter(idAfter); err != nil {
		t.Errorf("upgraded node past the fork vs upgraded peer: err = %v", err)
	}
	if err := upgradedAfter(idBefore); err != nil {
		t.Errorf("upgraded node past the fork vs upgraded-but-syncing peer: err = %v", err)
	}
	staleAfter := newFilter(&base, genesis, func() uint64 { return fork })
	if err := staleAfter(idAfter); err != ErrLocalIncompatibleOrStale {
		t.Errorf("un-upgraded node past the fork vs upgraded peer: err = %v, want %v", err, ErrLocalIncompatibleOrStale)
	}
	if err := staleAfter(idBefore); err != ErrLocalIncompatibleOrStale {
		t.Errorf("un-upgraded node past the fork vs peer announcing it: err = %v, want %v", err, ErrLocalIncompatibleOrStale)
	}
	// Before the fork everybody still connects.
	upgradedBefore := newFilter(&posa, genesis, func() uint64 { return fork - 1 })
	if err := upgradedBefore(idBase); err != nil {
		t.Errorf("upgraded node before the fork vs un-upgraded peer: err = %v", err)
	}
	staleBefore := newFilter(&base, genesis, func() uint64 { return fork - 1 })
	if err := staleBefore(idBefore); err != nil {
		t.Errorf("un-upgraded node before the fork vs upgraded peer: err = %v", err)
	}
}
