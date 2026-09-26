// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package rlpx

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/crypto/ecies"
)

// shortAuthPacket returns a size-prefixed EIP-8 handshake packet whose ECIES
// body is only bodyLen bytes, with a MAC that verifies against the recipient
// key. Only the recipient's public key is needed to build it, which is all an
// unauthenticated attacker has.
func shortAuthPacket(t *testing.T, remote *ecdsa.PublicKey, bodyLen int) []byte {
	t.Helper()
	eph, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	const keyLen = 16 // AES-128-CTR + HMAC-SHA256, the secp256k1 ECIES suite
	z, err := ecies.ImportECDSA(eph).GenerateShared(ecies.ImportECDSAPublic(remote), keyLen, keyLen)
	if err != nil {
		t.Fatal(err)
	}
	// concatKDF(sha256, z, nil, 32) is one block: sha256(00000001 || z).
	kdf := sha256.New()
	kdf.Write([]byte{0, 0, 0, 1})
	kdf.Write(z)
	k := kdf.Sum(nil)
	km := sha256.Sum256(k[keyLen:])

	rb := elliptic.Marshal(crypto.S256(), eph.PublicKey.X, eph.PublicKey.Y)
	body := bytes.Repeat([]byte{0xaa}, bodyLen)
	size := len(rb) + bodyLen + sha256.Size
	prefix := make([]byte, 2)
	binary.BigEndian.PutUint16(prefix, uint16(size))

	mac := hmac.New(sha256.New, km[:])
	mac.Write(body)
	mac.Write(prefix) // EIP-8 authenticates the size prefix as s2
	packet := append(append(append(prefix, rb...), body...), mac.Sum(nil)...)
	if len(packet) != 2+size {
		t.Fatalf("packet is %d bytes, want %d", len(packet), 2+size)
	}
	return packet
}

// TestHandshakeShortCiphertext is the CVE-2026-22862 regression at the RLPx
// layer: a 98-byte auth packet (65-byte key, 1-byte body, valid MAC) used to
// panic the recipient before the peer was authenticated. It must now be an
// ordinary handshake error, both from readMsg and from a full Conn.Handshake.
func TestHandshakeShortCiphertext(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	for n := 1; n < 16; n++ {
		packet := shortAuthPacket(t, &key.PublicKey, n)
		if n == 1 && len(packet)-2 != 98 {
			t.Fatalf("one-byte body gives a %d-byte ciphertext, want 98", len(packet)-2)
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("body %d: readMsg panicked: %v", n, r)
				}
			}()
			var h handshakeState
			if _, err := h.readMsg(new(authMsgV4), key, bytes.NewReader(packet)); !errors.Is(err, ecies.ErrInvalidMessage) {
				t.Fatalf("body %d: err = %v, want %v", n, err, ecies.ErrInvalidMessage)
			}
		}()
	}

	// End to end over a socket, as the listener's SetupConn goroutine runs it.
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()
	errc := make(chan error, 1)
	go func() {
		_, err := NewConn(c1, nil).Handshake(key)
		errc <- err
	}()
	go c2.Write(shortAuthPacket(t, &key.PublicKey, 1))
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("handshake with a 98-byte auth succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handshake did not return")
	}
}

// TestHandshakeECIESInvalidCurve is upstream's #33669 check: an auth whose
// ephemeral key is not on the curve fails with ErrInvalidPublicKey before any
// ECDH, rather than as a MAC mismatch.
func TestHandshakeECIESInvalidCurve(t *testing.T) {
	initKey, _ := crypto.GenerateKey()
	respKey, _ := crypto.GenerateKey()
	init := handshakeState{initiator: true, remote: ecies.ImportECDSAPublic(&respKey.PublicKey)}
	authMsg, err := init.makeAuthMsg(initKey)
	if err != nil {
		t.Fatal(err)
	}
	packet, err := init.sealEIP8(authMsg)
	if err != nil {
		t.Fatal(err)
	}
	var recv handshakeState
	if _, err := recv.readMsg(new(authMsgV4), respKey, bytes.NewReader(packet)); err != nil {
		t.Fatalf("valid packet: %v", err)
	}
	tampered := append([]byte(nil), packet...)
	tampered[2] = 0x04
	for i := 1; i < 65; i++ {
		tampered[2+i] = 0x00
	}
	var recv2 handshakeState
	if _, err := recv2.readMsg(new(authMsgV4), respKey, bytes.NewReader(tampered)); !errors.Is(err, ecies.ErrInvalidPublicKey) {
		t.Fatalf("err = %v, want %v", err, ecies.ErrInvalidPublicKey)
	}
}
