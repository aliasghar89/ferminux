// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.
//
// Release A (v1.1.0-posa) — the binary that carries the authority fork.
// These assertions pin the exact compiled constants of release A so a build
// that drifts from the approved values fails to compile-and-test rather than
// shipping silently. See infra/RELEASE-posa.md.

package params

import (
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
)

// TestReleaseAPosaBlock asserts the fork switch block is exactly F = 160000 and
// that IsPosa flips at that boundary (159999 is still PoW, 160000 is authority).
func TestReleaseAPosaBlock(t *testing.T) {
	const F = 160000

	if FerminuxChainConfig.PosaBlock == nil {
		t.Fatal("release A: FerminuxChainConfig.PosaBlock is nil, want 160000")
	}
	if got := FerminuxChainConfig.PosaBlock.Int64(); got != F {
		t.Fatalf("release A: PosaBlock = %d, want %d", got, F)
	}

	if FerminuxChainConfig.IsPosa(big.NewInt(F - 1)) {
		t.Errorf("IsPosa(%d) = true, want false (last PoW block)", F-1)
	}
	if !FerminuxChainConfig.IsPosa(big.NewInt(F)) {
		t.Errorf("IsPosa(%d) = false, want true (first authority block)", F)
	}
	if FerminuxChainConfig.IsPosa(big.NewInt(0)) {
		t.Error("IsPosa(0) = true, want false")
	}
	if !FerminuxChainConfig.IsPosa(big.NewInt(F + 1)) {
		t.Errorf("IsPosa(%d) = false, want true", F+1)
	}
}

// TestReleaseARewardSink asserts the reward sink is pinned to the deployed
// FMXRewardSink contract (owner = the Ferminux multisig). The posa engine
// refuses to start with a zero sink once PosaBlock is set, so this must be the
// deployed, non-zero address in the same release that sets PosaBlock.
func TestReleaseARewardSink(t *testing.T) {
	want := common.HexToAddress("0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6")
	if FerminuxRewardSink != want {
		t.Fatalf("release A: FerminuxRewardSink = %s, want %s", FerminuxRewardSink.Hex(), want.Hex())
	}
	if FerminuxRewardSink == (common.Address{}) {
		t.Fatal("release A: FerminuxRewardSink is the zero address")
	}
}

// TestReleaseACheckpointUnset asserts the PosaBlock-1 checkpoint hash stays ZERO
// in release A. Release B pins hash(F-1) after the fork; hash(F-1) cannot exist
// at release-A cut time. A binary with a non-zero checkpoint here would be
// release B, not release A.
func TestReleaseACheckpointUnset(t *testing.T) {
	if FerminuxPosaCheckpointHash != (common.Hash{}) {
		t.Fatalf("release A: FerminuxPosaCheckpointHash = %s, want zero (release B pins hash(F-1))", FerminuxPosaCheckpointHash.Hex())
	}
}

// TestReleaseAGenesisUnchanged asserts release A does not touch the genesis:
// the fork is a compiled state-transition change from PosaBlock onward, not a
// genesis change, so the genesis hash must be byte-identical to the launch
// value and the fork ID base (pre-fork) stays the same.
func TestReleaseAGenesisUnchanged(t *testing.T) {
	want := common.HexToHash("0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf")
	if FerminuxGenesisHash != want {
		t.Fatalf("release A: FerminuxGenesisHash = %s, want %s", FerminuxGenesisHash.Hex(), want.Hex())
	}
}

// TestReleaseAUnchangedAuthorityParams asserts every other authority parameter
// is unchanged by release A: the initial signer set, the break-glass owner set
// and threshold, the treasury, the period, the epoch, and the max reorg depth.
// These are consensus constants (or, for the signer/owner sets, seeded state);
// release A changes only PosaBlock and the reward sink.
func TestReleaseAUnchangedAuthorityParams(t *testing.T) {
	if FerminuxPosaPeriod != 7 {
		t.Errorf("FerminuxPosaPeriod = %d, want 7", FerminuxPosaPeriod)
	}
	if FerminuxPosaEpoch != 30000 {
		t.Errorf("FerminuxPosaEpoch = %d, want 30000", FerminuxPosaEpoch)
	}
	if FerminuxMaxReorgDepth != 64 {
		t.Errorf("FerminuxMaxReorgDepth = %d, want 64", FerminuxMaxReorgDepth)
	}
	if FerminuxBreakGlassThreshold != 2 {
		t.Errorf("FerminuxBreakGlassThreshold = %d, want 2", FerminuxBreakGlassThreshold)
	}

	wantTreasury := common.HexToAddress("0xc0A5Eb613f859f072554F29f1Ab7400265af15aB")
	if FerminuxTreasury != wantTreasury {
		t.Errorf("FerminuxTreasury = %s, want %s", FerminuxTreasury.Hex(), wantTreasury.Hex())
	}

	wantSigners := []common.Address{
		common.HexToAddress("0x3322f60aCEA9f88658665E83BeB30a516036187D"),
		common.HexToAddress("0xA46A721F25771BB2Be312a63A5D891539fF1de23"),
		common.HexToAddress("0x1538249E04c767dFfC50845068C19F633341bB0f"),
		common.HexToAddress("0x71377E0F553a5B0CB847443ab6648235977919b0"),
		common.HexToAddress("0x8e97f419F388c20E745dFF826587f359C31EF693"),
	}
	if len(FerminuxInitialSigners) != len(wantSigners) {
		t.Fatalf("FerminuxInitialSigners has %d entries, want %d", len(FerminuxInitialSigners), len(wantSigners))
	}
	for i, a := range wantSigners {
		if FerminuxInitialSigners[i] != a {
			t.Errorf("FerminuxInitialSigners[%d] = %s, want %s", i, FerminuxInitialSigners[i].Hex(), a.Hex())
		}
	}

	wantOwners := []common.Address{
		common.HexToAddress("0x1a143bf911E1E097730f3aA8C809C6B9109019EA"),
		common.HexToAddress("0x0fBBa0CC0e4f748Dc2Af25dDD3992700e7FCce15"),
		common.HexToAddress("0x11B53110eb83c548b392a56410bF5f959E6F41db"),
	}
	if len(FerminuxBreakGlassOwners) != len(wantOwners) {
		t.Fatalf("FerminuxBreakGlassOwners has %d entries, want %d", len(FerminuxBreakGlassOwners), len(wantOwners))
	}
	for i, a := range wantOwners {
		if FerminuxBreakGlassOwners[i] != a {
			t.Errorf("FerminuxBreakGlassOwners[%d] = %s, want %s", i, FerminuxBreakGlassOwners[i].Hex(), a.Hex())
		}
	}
}
