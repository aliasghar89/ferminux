// Copyright 2026 The Ferminux Network Authors
// Unit tests for the Ferminux Clique additions (ferminux.go).

package clique

import (
	"bytes"
	"crypto/ecdsa"
	"math/big"
	"sort"
	"testing"

	"github.com/aliasghar89/ferminux/chain/accounts"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/rawdb"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/params"
)

func testKeys(n int) ([]*ecdsa.PrivateKey, []common.Address) {
	keys := make([]*ecdsa.PrivateKey, n)
	addrs := make([]common.Address, n)
	for i := range keys {
		keys[i], _ = crypto.GenerateKey()
		addrs[i] = crypto.PubkeyToAddress(keys[i].PublicKey)
	}
	return keys, addrs
}

func sortedAddrs(addrs []common.Address) []common.Address {
	out := append([]common.Address{}, addrs...)
	sort.Sort(signersAscending(out))
	return out
}

func signOverride(chainID *big.Int, number uint64, parent common.Hash, list []common.Address, keys ...*ecdsa.PrivateKey) [][]byte {
	digest := breakGlassDigest(chainID, number, parent, list)
	sigs := make([][]byte, len(keys))
	for i, k := range keys {
		sigs[i], _ = crypto.Sign(digest, k)
	}
	return sigs
}

func TestBreakGlassPayloadCodec(t *testing.T) {
	_, addrs := testKeys(3)
	list := sortedAddrs(addrs)
	sigs := [][]byte{bytes.Repeat([]byte{1}, 65), bytes.Repeat([]byte{2}, 65)}

	extra := BreakGlassExtra([]byte("ferminux"), list, sigs)
	if len(extra) != extraVanity+3*common.AddressLength+2*extraSeal+breakGlassTrailerLen+extraSeal {
		t.Fatalf("unexpected extra length %d", len(extra))
	}
	if !isBreakGlassExtra(extra) {
		t.Fatalf("isBreakGlassExtra(break-glass) = false")
	}
	gotSigners, gotSigs, isBG, err := parseCheckpointExtra(extra)
	if err != nil || !isBG {
		t.Fatalf("parse: err=%v isBreakGlass=%v", err, isBG)
	}
	if len(gotSigners) != 3 || len(gotSigs) != 2 {
		t.Fatalf("parsed %d signers / %d sigs", len(gotSigners), len(gotSigs))
	}
	for i := range list {
		if gotSigners[i] != list[i] {
			t.Errorf("signer %d = %s, want %s", i, gotSigners[i].Hex(), list[i].Hex())
		}
	}
	for i := range sigs {
		if !bytes.Equal(gotSigs[i], sigs[i]) {
			t.Errorf("sig %d mismatch", i)
		}
	}
	// Plain checkpoint.
	plain := make([]byte, extraVanity)
	for _, a := range list {
		plain = append(plain, a[:]...)
	}
	plain = append(plain, make([]byte, extraSeal)...)
	if isBreakGlassExtra(plain) {
		t.Errorf("isBreakGlassExtra(plain checkpoint) = true")
	}
	gotSigners, gotSigs, isBG, err = parseCheckpointExtra(plain)
	if err != nil || isBG || gotSigs != nil || len(gotSigners) != 3 {
		t.Fatalf("plain parse: err=%v isBG=%v sigs=%v signers=%d", err, isBG, gotSigs, len(gotSigners))
	}
	// A plain non-checkpoint header and a too-short one are not break-glass.
	if isBreakGlassExtra(make([]byte, extraVanity+extraSeal)) || isBreakGlassExtra([]byte("Made with love by Wizrd - FMX")) {
		t.Errorf("isBreakGlassExtra true for a payload-less or short extra")
	}
	// Length not a multiple of 20 and no magic: stock error, not break-glass.
	bad := append(make([]byte, extraVanity+21), make([]byte, extraSeal)...)
	if isBreakGlassExtra(bad) {
		t.Errorf("isBreakGlassExtra(garbage) = true")
	}
	if _, _, _, err := parseCheckpointExtra(bad); err != errInvalidCheckpointSigners {
		t.Errorf("garbage payload: err = %v, want %v", err, errInvalidCheckpointSigners)
	}
	// Magic present but zero signatures.
	zeroCount := BreakGlassExtra(nil, list, nil)
	if _, _, _, err := parseCheckpointExtra(zeroCount); err != errBreakGlassMalformed {
		t.Errorf("zero-count payload: err = %v, want %v", err, errBreakGlassMalformed)
	}
	// Magic present but the count claims more signature bytes than exist.
	overclaim := append([]byte{}, extra...)
	overclaim[len(overclaim)-extraSeal-breakGlassTrailerLen] = 200
	if _, _, _, err := parseCheckpointExtra(overclaim); err != errBreakGlassMalformed {
		t.Errorf("over-claimed count: err = %v, want %v", err, errBreakGlassMalformed)
	}
	// Too short to hold vanity + seal: an error, never a panic.
	if _, _, _, err := parseCheckpointExtra([]byte("Made with love by Wizrd - FMX")); err != errMissingSignature {
		t.Errorf("29-byte extra: err = %v, want %v", err, errMissingSignature)
	}
	// Length-class proof: no break-glass payload is ever a multiple of 20.
	for k := 1; k <= 7; k++ {
		for m := 1; m <= 5; m++ {
			if (k*common.AddressLength+m*extraSeal+breakGlassTrailerLen)%common.AddressLength == 0 {
				t.Errorf("ambiguous layout for %d signers / %d sigs", k, m)
			}
		}
	}
}

func TestVerifyBreakGlass(t *testing.T) {
	ownerKeys, ownerAddrs := testKeys(3)
	_, newAddrs := testKeys(2)
	list := sortedAddrs(newAddrs)
	chainID := big.NewInt(3961)
	parent := common.HexToHash("0xfeed")
	const number = 30001 // deliberately not an epoch boundary: any height is valid
	bg := &BreakGlassConfig{ChainID: chainID, Owners: ownerAddrs, Threshold: 2}

	check := func(name string, want error, sigs [][]byte, l []common.Address, cfg *BreakGlassConfig) {
		t.Helper()
		if got := verifyBreakGlass(cfg, number, parent, l, sigs); got != want {
			t.Errorf("%s: err = %v, want %v", name, got, want)
		}
	}
	check("2 of 3", nil, signOverride(chainID, number, parent, list, ownerKeys[0], ownerKeys[1]), list, bg)
	check("3 of 3", nil, signOverride(chainID, number, parent, list, ownerKeys[0], ownerKeys[1], ownerKeys[2]), list, bg)
	check("1 of 3", errBreakGlassThreshold, signOverride(chainID, number, parent, list, ownerKeys[2]), list, bg)
	check("no signatures", errBreakGlassBadSignature, nil, list, bg)

	strangerKey, _ := crypto.GenerateKey()
	check("owner + stranger", errBreakGlassBadSignature, signOverride(chainID, number, parent, list, ownerKeys[0], strangerKey), list, bg)
	check("duplicate owner", errBreakGlassBadSignature, signOverride(chainID, number, parent, list, ownerKeys[0], ownerKeys[0]), list, bg)
	check("wrong block", errBreakGlassBadSignature, signOverride(chainID, number+1, parent, list, ownerKeys[0], ownerKeys[1]), list, bg)
	check("wrong parent", errBreakGlassBadSignature, signOverride(chainID, number, common.HexToHash("0xdead"), list, ownerKeys[0], ownerKeys[1]), list, bg)
	check("wrong chain", errBreakGlassBadSignature, signOverride(big.NewInt(1), number, parent, list, ownerKeys[0], ownerKeys[1]), list, bg)
	check("wrong list", errBreakGlassBadSignature, signOverride(chainID, number, parent, list[:1], ownerKeys[0], ownerKeys[1]), list, bg)
	check("too many sigs", errBreakGlassBadSignature, signOverride(chainID, number, parent, list, ownerKeys[0], ownerKeys[1], ownerKeys[2], ownerKeys[0]), list, bg)

	unsorted := []common.Address{list[1], list[0]}
	check("unsorted list", errBreakGlassSignerList, signOverride(chainID, number, parent, unsorted, ownerKeys[0], ownerKeys[1]), unsorted, bg)
	dup := []common.Address{list[0], list[0]}
	check("duplicate list", errBreakGlassSignerList, signOverride(chainID, number, parent, dup, ownerKeys[0], ownerKeys[1]), dup, bg)
	check("empty list", errBreakGlassSignerList, signOverride(chainID, number, parent, nil, ownerKeys[0], ownerKeys[1]), nil, bg)
	check("unconfigured", errBreakGlassDisabled, signOverride(chainID, number, parent, list, ownerKeys[0], ownerKeys[1]), list, nil)

	// v = 27/28 (personal_sign wallets) is normalised.
	sigs := signOverride(chainID, number, parent, list, ownerKeys[0], ownerKeys[1])
	sigs[0][crypto.RecoveryIDOffset] += 27
	check("v=27", nil, sigs, list, bg)

	// A short signature is rejected, not sliced.
	check("short signature", errBreakGlassBadSignature, [][]byte{sigs[0][:64], sigs[1]}, list, bg)

	// The digest is the EIP-191 personal_sign hash of the documented message,
	// which binds chain id, number AND parent hash.
	msg := EncodeBreakGlassMessage(chainID, number, parent, list)
	if !bytes.HasPrefix(msg, breakGlassPrefix) || len(msg) != len(breakGlassPrefix)+32+8+common.HashLength+2*common.AddressLength {
		t.Errorf("unexpected message layout: %x", msg)
	}
	if !bytes.Contains(msg, parent[:]) {
		t.Errorf("message does not carry the parent hash")
	}
	if !bytes.Equal(accounts.TextHash(msg), breakGlassDigest(chainID, number, parent, list)) {
		t.Errorf("digest is not TextHash(message)")
	}

	// Turn computation in an override list mirrors Snapshot.inturn.
	for n := uint64(0); n < 6; n++ {
		snap := newSnapshot(&params.CliqueConfig{Period: 7, Epoch: 4}, nil, bg, n, common.Hash{}, list)
		for _, s := range list {
			if inturnAmong(list, n, s) != snap.inturn(n, s) {
				t.Errorf("inturnAmong(%d, %s) disagrees with Snapshot.inturn", n, s.Hex())
			}
		}
	}
}

// strictReader fails the test on any chain access: a bootstrapped engine must
// not walk below its anchor.
type strictReader struct {
	t      *testing.T
	config *params.ChainConfig
}

func (r *strictReader) Config() *params.ChainConfig { return r.config }
func (r *strictReader) CurrentHeader() *types.Header {
	r.t.Errorf("unexpected CurrentHeader lookup")
	return nil
}
func (r *strictReader) GetHeader(common.Hash, uint64) *types.Header {
	r.t.Errorf("unexpected GetHeader lookup")
	return nil
}
func (r *strictReader) GetHeaderByNumber(n uint64) *types.Header {
	r.t.Errorf("unexpected GetHeaderByNumber(%d) lookup", n)
	return nil
}
func (r *strictReader) GetHeaderByHash(common.Hash) *types.Header {
	r.t.Errorf("unexpected GetHeaderByHash lookup")
	return nil
}
func (r *strictReader) GetTd(common.Hash, uint64) *big.Int {
	r.t.Errorf("unexpected GetTd lookup")
	return nil
}

func TestBootstrapSnapshotNeverLooksBelowAnchor(t *testing.T) {
	_, signers := testKeys(5)
	engine := New(&params.CliqueConfig{Period: 7, Epoch: 30000}, rawdb.NewMemoryDatabase())
	const anchor = 19_999
	if err := engine.SetBootstrap(anchor, signers); err != nil {
		t.Fatal(err)
	}
	reader := &strictReader{t: t, config: params.FerminuxChainConfig}
	hashOf := func(n uint64) common.Hash { return common.BigToHash(new(big.Int).SetUint64(n + 0xabc)) }
	hash := hashOf(anchor)

	snap, err := engine.snapshot(reader, anchor, hash, nil)
	if err != nil {
		t.Fatalf("snapshot at anchor: %v", err)
	}
	if snap.Number != anchor || snap.Hash != hash || len(snap.Signers) != 5 || len(snap.Recents) != 0 {
		t.Fatalf("seed snapshot = %+v", snap)
	}
	for _, s := range signers {
		if _, ok := snap.Signers[s]; !ok {
			t.Errorf("seed missing %s", s.Hex())
		}
	}
	for _, below := range []uint64{anchor - 1, 30000 - 1, 1, 0} {
		if below > anchor {
			continue
		}
		if _, err := engine.snapshot(reader, below, hashOf(below), nil); err != errBelowBootstrap {
			t.Errorf("snapshot(%d): err = %v, want %v", below, err, errBelowBootstrap)
		}
	}
	// Misconfiguration is refused.
	if err := engine.SetBootstrap(anchor, nil); err == nil {
		t.Errorf("empty bootstrap accepted")
	}
	if err := engine.SetBootstrap(anchor, []common.Address{{}}); err == nil {
		t.Errorf("zero-address bootstrap accepted")
	}
	if err := engine.SetBreakGlass(&BreakGlassConfig{ChainID: big.NewInt(1), Owners: signers[:3], Threshold: 4}); err == nil {
		t.Errorf("threshold above owner count accepted")
	}
	if err := engine.SetBreakGlass(&BreakGlassConfig{Owners: signers[:3], Threshold: 2}); err == nil {
		t.Errorf("missing chain id accepted")
	}
}

// TestApplyBreakGlass exercises Snapshot.apply on break-glass headers: the
// override installs the new set before the seal is checked, the recency rule
// is waived for that one block, the override works at any height, and the
// sealer must belong to the override list.
func TestApplyBreakGlass(t *testing.T) {
	signerKeys, signerAddrs := testKeys(5)
	ownerKeys, ownerAddrs := testKeys(3)
	newKeys, newAddrs := testKeys(1)
	chainID := big.NewInt(3961)
	bg := &BreakGlassConfig{ChainID: chainID, Owners: ownerAddrs, Threshold: 2}
	config := &params.CliqueConfig{Period: 7, Epoch: 4}
	engine := New(config, rawdb.NewMemoryDatabase())

	// Snapshot after block 11 with five signers and a full recents window.
	base := func() *Snapshot {
		snap := newSnapshot(config, engine.signatures, bg, 11, common.HexToHash("0x11"), signerAddrs)
		snap.Recents = map[uint64]common.Address{9: signerAddrs[0], 10: signerAddrs[1], 11: signerAddrs[2]}
		return snap
	}
	// A break-glass header at `number` on `parent` carrying `list`, sealed by `sealer`.
	bgHeader := func(number uint64, parent common.Hash, list []common.Address, sigs [][]byte, sealer *ecdsa.PrivateKey) *types.Header {
		header := &types.Header{
			Number:     new(big.Int).SetUint64(number),
			ParentHash: parent,
			Difficulty: diffInTurn,
			Extra:      BreakGlassExtra(nil, list, sigs),
			Time:       100,
		}
		sig, _ := crypto.Sign(SealHash(header).Bytes(), sealer)
		copy(header.Extra[len(header.Extra)-extraSeal:], sig)
		return header
	}
	parent := common.HexToHash("0x11")

	// Epoch block 12: override to a single brand-new signer, sealed by that
	// new signer (not in the pre-block set at all).
	sigs := signOverride(chainID, 12, parent, newAddrs, ownerKeys[0], ownerKeys[1])
	next, err := base().apply([]*types.Header{bgHeader(12, parent, newAddrs, sigs, newKeys[0])})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(next.Signers) != 1 {
		t.Fatalf("signers after override = %v", next.Signers)
	}
	if _, ok := next.Signers[newAddrs[0]]; !ok {
		t.Errorf("override signer missing")
	}
	// New limit is 1: only the entry for block 12 itself survives, so a
	// single signer is not locked out by the old five-signer window.
	if len(next.Recents) != 1 || next.Recents[12] != newAddrs[0] {
		t.Errorf("recents after override = %v", next.Recents)
	}
	if len(next.Votes) != 0 || len(next.Tally) != 0 {
		t.Errorf("votes/tally not reset")
	}

	// Off-epoch block 13 (parent 0x12): an override to [s0, s1] sealed by s0,
	// who is inside the recency window of the pre-block set; accepted because
	// the recency rule is waived for the break-glass block only.
	parent13 := common.HexToHash("0x12")
	snap12 := base()
	snap12.Number, snap12.Hash = 12, parent13
	snap12.Recents = map[uint64]common.Address{10: signerAddrs[1], 11: signerAddrs[2], 12: signerAddrs[0]}
	list := sortedAddrs(signerAddrs[:2])
	sigs = signOverride(chainID, 13, parent13, list, ownerKeys[1], ownerKeys[2])
	next, err = snap12.apply([]*types.Header{bgHeader(13, parent13, list, sigs, signerKeys[0])})
	if err != nil {
		t.Fatalf("off-epoch override by a recent signer: %v", err)
	}
	if len(next.Signers) != 2 || next.Recents[13] != signerAddrs[0] {
		t.Errorf("after off-epoch override: signers=%v recents=%v", next.Signers, next.Recents)
	}
	// ...and the stock rules are back for the next block: s0 again at 14 is
	// recently signed (limit 2 for two signers: 13 > 14-2).
	plain14 := &types.Header{Number: big.NewInt(14), ParentHash: common.HexToHash("0x13"), Difficulty: diffInTurn, Extra: make([]byte, extraVanity+extraSeal), Time: 200}
	sig, _ := crypto.Sign(SealHash(plain14).Bytes(), signerKeys[0])
	copy(plain14.Extra[len(plain14.Extra)-extraSeal:], sig)
	if _, err := next.apply([]*types.Header{plain14}); err != errRecentlySigned {
		t.Errorf("stock recency rule after override: err = %v, want %v", err, errRecentlySigned)
	}

	// Rejections.
	reject := func(name string, header *types.Header, want error) {
		t.Helper()
		if _, err := base().apply([]*types.Header{header}); err != want {
			t.Errorf("%s: err = %v, want %v", name, err, want)
		}
	}
	sigs = signOverride(chainID, 12, parent, newAddrs, ownerKeys[0], ownerKeys[1])
	reject("sealed by an old signer outside the override list", bgHeader(12, parent, newAddrs, sigs, signerKeys[3]), errUnauthorizedSigner)
	reject("one owner signature", bgHeader(12, parent, newAddrs, sigs[:1], newKeys[0]), errBreakGlassThreshold)
	replay := signOverride(chainID, 12, common.HexToHash("0x11bad"), newAddrs, ownerKeys[0], ownerKeys[1])
	reject("signed for another parent", bgHeader(12, parent, newAddrs, replay, newKeys[0]), errBreakGlassBadSignature)
	unconfigured := base()
	unconfigured.breakGlass = nil
	if _, err := unconfigured.apply([]*types.Header{bgHeader(12, parent, newAddrs, sigs, newKeys[0])}); err != errBreakGlassDisabled {
		t.Errorf("unconfigured engine: err = %v, want %v", err, errBreakGlassDisabled)
	}
}
