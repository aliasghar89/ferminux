// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

//go:build !gofuzz && cgo
// +build !gofuzz,cgo

package secp256k1

import (
	"math/big"
	"testing"
)

// pointXOnePlusP returns (1, y) on secp256k1 and its alias (1+P, y): y² = 1+7
// has a root because 8 is a quadratic residue mod P, and P ≡ 3 (mod 4).
func pointXOnePlusP(t *testing.T) (x, xAlias, y *big.Int) {
	t.Helper()
	c := S256()
	e := new(big.Int).Add(c.P, big.NewInt(1))
	e.Rsh(e, 2)
	y = new(big.Int).Exp(big.NewInt(8), e, c.P)
	if new(big.Int).Exp(y, big.NewInt(2), c.P).Cmp(big.NewInt(8)) != 0 {
		t.Fatal("8 is not a square mod P")
	}
	return big.NewInt(1), new(big.Int).Add(c.P, big.NewInt(1)), y
}

// TestIsOnCurveRange is the CVE-2026-26314 regression: a coordinate >= P is not
// a field element and the point must be refused, even though it reduces to a
// point on the curve.
func TestIsOnCurveRange(t *testing.T) {
	c := S256()
	x, xAlias, y := pointXOnePlusP(t)
	if !c.IsOnCurve(x, y) {
		t.Fatal("(1, y) should be on the curve")
	}
	if c.IsOnCurve(xAlias, y) {
		t.Error("(1+P, y) accepted")
	}
	if c.IsOnCurve(x, new(big.Int).Add(y, c.P)) {
		t.Error("(1, y+P) accepted")
	}
	if c.IsOnCurve(new(big.Int).Neg(c.Gx), c.Gy) {
		t.Error("negative x accepted")
	}
	if !c.IsOnCurve(c.Gx, c.Gy) {
		t.Error("generator refused")
	}
}

// TestScalarMultRejectsOverflow checks the C side: secp256k1_ext_scalar_mul
// now refuses a point whose encoded coordinate is >= P instead of silently
// reducing it.
func TestScalarMultRejectsOverflow(t *testing.T) {
	c := S256()
	x, xAlias, y := pointXOnePlusP(t)
	k := []byte{7}
	if rx, _ := c.ScalarMult(x, y, k); rx == nil {
		t.Fatal("ScalarMult of a valid point failed")
	}
	if rx, ry := c.ScalarMult(xAlias, y, k); rx != nil || ry != nil {
		t.Errorf("ScalarMult of (1+P, y) = (%x, %x), want nil", rx, ry)
	}
}
