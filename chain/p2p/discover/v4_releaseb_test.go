// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package discover

import (
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/p2p/discover/v4wire"
	"github.com/aliasghar89/ferminux/chain/p2p/enode"
)

// TestUDPv4_neighborsKeyOutOfField is the CVE-2026-26314 regression at the
// discovery layer. A peer the node sent FINDNODE to answers with a Neighbors
// entry whose X coordinate is 1+P. Release A accepted the key in DecodePubkey
// and panicked in enode.NewV4, inside the UDPv4 loop goroutine, which took
// the process down. The entry must now be dropped and the good entry returned.
func TestUDPv4_neighborsKeyOutOfField(t *testing.T) {
	test := newUDPTest(t)
	defer test.close()

	rid := enode.PubkeyToIDV4(&test.remotekey.PublicKey)
	test.table.db.UpdateLastPingReceived(rid, test.remoteaddr.IP, time.Now())

	resultc, errc := make(chan []*node, 1), make(chan error, 1)
	go func() {
		ns, err := test.udp.findnode(encodePubkey(&test.remotekey.PublicKey).id(), test.remoteaddr, testTarget)
		if err != nil && len(ns) == 0 {
			errc <- err
		} else {
			resultc <- ns
		}
	}()
	test.waitPacketOut(func(p *v4wire.Findnode, to *net.UDPAddr, hash []byte) {})

	P := crypto.S256().Params().P
	e := new(big.Int).Add(P, big.NewInt(1))
	e.Rsh(e, 2)
	y := new(big.Int).Exp(big.NewInt(8), e, P) // (1, y) is on the curve
	var poisoned v4wire.Pubkey
	new(big.Int).Add(P, big.NewInt(1)).FillBytes(poisoned[:32])
	y.FillBytes(poisoned[32:])

	good := wrapNode(enode.MustParse("enode://ba85011c70bcc5c04d8607d3a0ed29aa6179c092cbdda10d5d32684fb33ed01bd94f588ca8f91ac48318087dcb02eaf36773a7a453f0eedd6742af668097b29c@10.0.1.16:30303?discport=30304"))
	nodes := []v4wire.Node{
		{ID: poisoned, IP: net.IP{10, 0, 1, 17}, UDP: 30303, TCP: 30303},
		nodeToRPC(good),
	}
	test.packetIn(nil, &v4wire.Neighbors{Expiration: futureExp, Nodes: nodes})
	// Fill the rest of the bucket-sized reply so findnode returns now.
	for i := 0; i < bucketSize-2; i++ {
		key := newkey()
		n := wrapNode(enode.NewV4(&key.PublicKey, net.IP{10, 0, 2, byte(i + 1)}, 30303, 30303))
		test.packetIn(nil, &v4wire.Neighbors{Expiration: futureExp, Nodes: []v4wire.Node{nodeToRPC(n)}})
	}

	select {
	case result := <-resultc:
		if len(result) == 0 || result[0].ID() != good.ID() {
			t.Fatalf("findnode returned %d nodes, first %v; want the good node first", len(result), result)
		}
		for _, n := range result {
			if n.IP().Equal(net.IP{10, 0, 1, 17}) {
				t.Fatalf("poisoned entry was accepted: %v", n)
			}
		}
	case err := <-errc:
		t.Fatalf("findnode error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("findnode did not return within 5 seconds")
	}
	// The replies after the poisoned entry were matched, so the loop
	// goroutine survived it; check it is still running.
	select {
	case <-test.udp.closeCtx.Done():
		t.Fatal("UDPv4 loop stopped")
	default:
	}
}
