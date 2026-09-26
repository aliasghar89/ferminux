package attest

import (
	"bytes"
	"encoding/json"
	"flag"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/math"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/signer/core/apitypes"
)

var update = flag.Bool("update", false, "rewrite testdata/attestation_vectors.json")

const vectorPath = "../../testdata/attestation_vectors.json"

// TestVectorFile pins the shared vector file: regenerating it from this code
// must give the committed bytes. If the signing format ever changes, this test
// fails until the file (and therefore the contract tests reading it) changes too.
func TestVectorFile(t *testing.T) {
	got, err := json.MarshalIndent(BuildVectors(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	if *update {
		if err := os.WriteFile(vectorPath, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatalf("read %s: %v (run with -update to create it)", vectorPath, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale; the signing format changed. Re-run with -update and sync the contract tests", filepath.Base(vectorPath))
	}
}

// TestVectorsAgainstTypedDataEncoder recomputes every vector's digest with the
// node's generic typed-data encoder (signer/core/apitypes), which shares no
// code with Domain.Digest.
func TestVectorsAgainstTypedDataEncoder(t *testing.T) {
	vf := BuildVectors()
	for _, v := range vf.Valid {
		td := apitypes.TypedData{
			Types: apitypes.Types{
				"EIP712Domain": {
					{Name: "name", Type: "string"},
					{Name: "version", Type: "string"},
					{Name: "chainId", Type: "uint256"},
					{Name: "verifyingContract", Type: "address"},
				},
				"Attestation": {
					{Name: "height", Type: "uint64"},
					{Name: "blockHash", Type: "bytes32"},
				},
			},
			PrimaryType: "Attestation",
			Domain: apitypes.TypedDataDomain{
				Name:              DomainName,
				Version:           DomainVersion,
				ChainId:           math.NewHexOrDecimal256(int64(v.ChainID)),
				VerifyingContract: v.Hub.Hex(),
			},
			Message: apitypes.TypedDataMessage{
				"height":    new(big.Int).SetUint64(v.Height).String(),
				"blockHash": v.BlockHash.Hex(),
			},
		}
		digest, _, err := apitypes.TypedDataAndHash(td)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if common.BytesToHash(digest) != v.Digest {
			t.Fatalf("%s: digest %x, typed-data encoder %x", v.Name, v.Digest, digest)
		}
		sep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
		if err != nil {
			t.Fatal(err)
		}
		if common.BytesToHash(sep) != v.DomainSeparator {
			t.Fatalf("%s: separator mismatch", v.Name)
		}
	}
}

func TestVectorsRecover(t *testing.T) {
	vf := BuildVectors()
	for _, v := range vf.Valid {
		d := Domain{ChainID: v.ChainID, Hub: v.Hub}
		got, err := d.Recover(v.Height, v.BlockHash, v.Signature)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if got != v.Signer {
			t.Fatalf("%s: recovered %s want %s", v.Name, got.Hex(), v.Signer.Hex())
		}
		if v.V != 27 && v.V != 28 {
			t.Fatalf("%s: v=%d", v.Name, v.V)
		}
		if new(big.Int).SetBytes(v.S.Bytes()).Cmp(secp256k1HalfN) > 0 {
			t.Fatalf("%s: high s", v.Name)
		}
		// plain secp256k1 ecrecover over the digest agrees too
		raw := append([]byte{}, v.Signature...)
		raw[64] -= 27
		pub, err := crypto.SigToPub(v.Digest.Bytes(), raw)
		if err != nil || crypto.PubkeyToAddress(*pub) != v.Signer {
			t.Fatalf("%s: raw ecrecover disagrees", v.Name)
		}
	}
	dp := vf.DoubleAttestation
	d := Domain{ChainID: dp.ChainID, Hub: dp.Hub}
	a, errA := d.Recover(dp.Height, dp.BlockHashA, dp.SignatureA)
	b, errB := d.Recover(dp.Height, dp.BlockHashB, dp.SignatureB)
	if errA != nil || errB != nil || a != dp.Signer || b != dp.Signer || dp.BlockHashA == dp.BlockHashB {
		t.Fatalf("double attestation pair is not valid evidence")
	}
	for _, iv := range vf.Invalid {
		d := Domain{ChainID: iv.ChainID, Hub: iv.Hub}
		got, err := d.Recover(iv.Height, iv.BlockHash, iv.Signature)
		if iv.NotSigner != (common.Address{}) {
			if err == nil && got == iv.NotSigner {
				t.Fatalf("%s: accepted for %s", iv.Name, iv.NotSigner.Hex())
			}
			continue
		}
		if err == nil {
			t.Fatalf("%s: accepted (%s)", iv.Name, iv.Reason)
		}
	}
}

func TestPossessionVectors(t *testing.T) {
	vf := BuildVectors()
	for _, rv := range vf.RawV {
		d := Domain{ChainID: rv.ChainID, Hub: rv.Hub}
		if got, err := d.Recover(rv.Height, rv.BlockHash, rv.Signature); err != nil || got != vf.Valid[0].Signer {
			t.Fatalf("%s: %v", rv.Name, err)
		}
	}
	for _, p := range vf.AttesterKey {
		got, err := RecoverDigest(p.Digest, p.Signature)
		if err != nil || got != p.Attester {
			t.Fatalf("%s: %v", p.Name, err)
		}
	}
	for _, e := range vf.Enode {
		got, err := RecoverDigest(e.Digest, e.Signature)
		if err != nil || got != e.NodeAddress {
			t.Fatalf("%s: %v", e.Name, err)
		}
		// the hub derives the node address as the low 20 bytes of keccak(pubkey)
		if common.BytesToAddress(crypto.Keccak256(e.Pubkey)[12:]) != e.NodeAddress || len(e.Pubkey) != 64 {
			t.Fatalf("%s: pubkey does not match node address", e.Name)
		}
	}
}

func TestSignDeterministicAndDomainBound(t *testing.T) {
	k := vectorKey("determinism")
	d := Domain{ChainID: 3961, Hub: VectorHub}
	h := crypto.Keccak256Hash([]byte("x"))
	s1, _ := d.Sign(k, 1200, h)
	s2, _ := d.Sign(k, 1200, h)
	if !bytes.Equal(s1, s2) {
		t.Fatal("signing is not deterministic")
	}
	other := Domain{ChainID: 3962, Hub: VectorHub}
	if d.Digest(1200, h) == other.Digest(1200, h) {
		t.Fatal("chain id not bound")
	}
	if d.Digest(1200, h) == d.Digest(1400, h) {
		t.Fatal("height not bound")
	}
}

func TestSchedule(t *testing.T) {
	s := DefaultSchedule()
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		head uint64
		h    uint64
		ok   bool
	}{
		{0, 0, false},
		{63, 0, false},
		{200 + 63, 0, false},  // checkpoint 200 only 63 deep
		{200 + 64, 200, true}, // opens
		{200 + 239, 200, true},
		{200 + 240, 0, false}, // head+1+10 > 450: too late to submit
		{400 + 64, 400, true},
		{400000 + 100, 400000, true},
		{400000 + 250, 0, false},
		{400000 + 263, 0, false},
		{400000 + 264, 400200, true},
	}
	for _, c := range cases {
		h, ok := s.Due(c.head)
		if ok != c.ok || h != c.h {
			t.Fatalf("Due(%d) = %d,%v want %d,%v", c.head, h, ok, c.h, c.ok)
		}
		if ok {
			if !s.Includable(h, c.head+1) {
				t.Fatalf("head %d: next block not includable for %d", c.head, h)
			}
			if c.head-h < MinDelay {
				t.Fatalf("head %d: signing %d only %d deep", c.head, h, c.head-h)
			}
		}
	}
	if !s.Closed(200, 450) || s.Closed(200, 449) {
		t.Fatal("Closed boundary wrong")
	}
	cp, opens := s.Next(400000 + 100)
	if cp != 400200 || opens != 400264 {
		t.Fatalf("Next = %d,%d", cp, opens)
	}
	cp, opens = s.Next(0)
	if cp != 200 || opens != 264 {
		t.Fatalf("Next(0) = %d,%d", cp, opens)
	}
	// every head: at most one checkpoint due, and it is always final and includable
	for head := uint64(0); head < 5000; head++ {
		if h, ok := s.Due(head); ok {
			if head < h+MinDelay || head+1 > h+MaxDelay-DefaultSubmitMargin {
				t.Fatalf("head %d h %d outside the safe window", head, h)
			}
		}
	}
	bad := []Schedule{
		{Interval: 200, MinDelay: 10, MaxDelay: 250},
		{Interval: 200, MinDelay: 64, MaxDelay: 300},
		{Interval: 0, MinDelay: 64, MaxDelay: 250},
		{Interval: 200, MinDelay: 64, MaxDelay: 250, SubmitMargin: 200},
	}
	for _, b := range bad {
		if b.Validate() == nil {
			t.Fatalf("schedule %+v accepted", b)
		}
	}
}
