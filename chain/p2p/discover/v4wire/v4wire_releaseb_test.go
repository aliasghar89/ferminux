// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package v4wire

import (
	"math/big"
	"testing"

	"github.com/aliasghar89/ferminux/chain/crypto"
)

// TestDecodePubkeyOutOfField is the CVE-2026-26314 regression for discovery:
// a Neighbors entry whose X is 1+P (it reduces to the curve point (1, y))
// must be refused here, in both the cgo and the CGO_ENABLED=0 build, because
// enode.NewV4 panics on it later inside the discovery loop.
func TestDecodePubkeyOutOfField(t *testing.T) {
	curve := crypto.S256()
	P := curve.Params().P
	e := new(big.Int).Add(P, big.NewInt(1))
	e.Rsh(e, 2)
	y := new(big.Int).Exp(big.NewInt(8), e, P) // y² = 1³ + 7
	xAlias := new(big.Int).Add(P, big.NewInt(1))

	var good, bad Pubkey
	big.NewInt(1).FillBytes(good[:32])
	y.FillBytes(good[32:])
	xAlias.FillBytes(bad[:32])
	y.FillBytes(bad[32:])

	if _, err := DecodePubkey(curve, good); err != nil {
		t.Fatalf("(1, y): %v", err)
	}
	if _, err := DecodePubkey(curve, bad); err != ErrBadPoint {
		t.Errorf("(1+P, y): err = %v, want %v", err, ErrBadPoint)
	}
}
