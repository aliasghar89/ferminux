// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package ecies

import (
	"crypto/elliptic"
	"crypto/rand"
	"math/big"
	"testing"
)

// sealShort builds an ECIES ciphertext whose body (IV || ciphertext) is only
// bodyLen bytes long but whose MAC is valid, i.e. exactly what an attacker who
// knows the recipient's public key can send in an RLPx auth message.
func sealShort(t *testing.T, pub *PublicKey, bodyLen int) []byte {
	t.Helper()
	params, err := pubkeyParams(pub)
	if err != nil {
		t.Fatal(err)
	}
	R, err := GenerateKey(rand.Reader, pub.Curve, params)
	if err != nil {
		t.Fatal(err)
	}
	z, err := R.GenerateShared(pub, params.KeyLen, params.KeyLen)
	if err != nil {
		t.Fatal(err)
	}
	_, Km := deriveKeys(params.Hash(), z, nil, params.KeyLen)
	body := make([]byte, bodyLen)
	rand.Read(body)
	tag := messageTag(params.Hash, Km, body, nil)

	Rb := elliptic.Marshal(pub.Curve, R.PublicKey.X, R.PublicKey.Y)
	ct := append(append(append([]byte{}, Rb...), body...), tag...)
	return ct
}

// TestDecryptShortCiphertext is the CVE-2026-22862 regression: a ciphertext of
// rLen+hLen+{1..BlockSize-1} bytes with a valid MAC must be refused with
// ErrInvalidMessage, not panic in symDecrypt. A body of exactly one block (an
// empty plaintext) is still accepted.
func TestDecryptShortCiphertext(t *testing.T) {
	prv, err := GenerateKey(rand.Reader, DefaultCurve, nil)
	if err != nil {
		t.Fatal(err)
	}
	params, _ := pubkeyParams(&prv.PublicKey)
	for n := 1; n < params.BlockSize; n++ {
		ct := sealShort(t, &prv.PublicKey, n)
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("body of %d bytes (ciphertext %d bytes): Decrypt panicked: %v", n, len(ct), r)
				}
			}()
			if _, err := prv.Decrypt(ct, nil, nil); err != ErrInvalidMessage {
				t.Fatalf("body of %d bytes: err = %v, want %v", n, err, ErrInvalidMessage)
			}
		}()
	}
	// 65 + 32 + 1 = 98 bytes: the exact size reproduced against release A.
	if ct := sealShort(t, &prv.PublicKey, 1); len(ct) != 98 {
		t.Fatalf("one-byte body gives %d-byte ciphertext, want 98", len(ct))
	}
	ct := sealShort(t, &prv.PublicKey, params.BlockSize)
	m, err := prv.Decrypt(ct, nil, nil)
	if err != nil {
		t.Fatalf("one-block body: %v", err)
	}
	if len(m) != 0 {
		t.Fatalf("one-block body decrypted to %d bytes, want 0", len(m))
	}
}

// TestGenerateSharedOffCurve checks that ECDH refuses a peer point that is not
// on the curve before any scalar multiplication (upstream #33669).
func TestGenerateSharedOffCurve(t *testing.T) {
	prv, err := GenerateKey(rand.Reader, DefaultCurve, nil)
	if err != nil {
		t.Fatal(err)
	}
	params, _ := pubkeyParams(&prv.PublicKey)
	bad := []*PublicKey{
		{Curve: DefaultCurve, X: big.NewInt(1), Y: big.NewInt(1)},
		{Curve: DefaultCurve, X: nil, Y: big.NewInt(1)},
	}
	for i, pub := range bad {
		if _, err := prv.GenerateShared(pub, params.KeyLen, params.KeyLen); err != ErrInvalidPublicKey {
			t.Errorf("case %d: err = %v, want %v", i, err, ErrInvalidPublicKey)
		}
	}
	if _, err := prv.GenerateShared(&prv.PublicKey, params.KeyLen, params.KeyLen); err != nil {
		t.Errorf("valid key: %v", err)
	}
}
