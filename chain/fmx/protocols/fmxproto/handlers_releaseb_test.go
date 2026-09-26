// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package fmxproto

import (
	"math"
	"testing"

	"github.com/aliasghar89/ferminux/chain/p2p"
)

// TestGetBlockHeadersBounded is the CVE-2024-32972 regression. On a
// 3000-block chain release A answered a by-hash request with Amount=0 with
// 2501 headers (the count-1 underflow), against a serve cap of 1024. Amount=0
// must now return nothing in every mode, and no query may return more than
// maxHeadersServe headers.
func TestGetBlockHeadersBounded(t *testing.T) {
	backend := newTestBackend(3000)
	defer backend.close()
	chain := backend.chain
	head := chain.CurrentBlock().NumberU64()
	mid := chain.GetBlockByNumber(2500)

	zero := []*GetBlockHeadersPacket{
		{Origin: HashOrNumber{Hash: mid.Hash()}, Amount: 0},
		{Origin: HashOrNumber{Hash: mid.Hash()}, Amount: 0, Reverse: true},
		{Origin: HashOrNumber{Number: 2500}, Amount: 0},
		{Origin: HashOrNumber{Number: 2500}, Amount: 0, Reverse: true},
		{Origin: HashOrNumber{Hash: mid.Hash()}, Amount: 0, Skip: 3},
		{Origin: HashOrNumber{Number: 2500}, Amount: 0, Skip: 3, Reverse: true},
		{Origin: HashOrNumber{Hash: chain.Genesis().Hash()}, Amount: 0},
	}
	for i, q := range zero {
		if got := ServiceGetBlockHeadersQuery(chain, q, nil); len(got) != 0 {
			t.Errorf("Amount=0 query %d (%+v): %d headers, want 0", i, *q, len(got))
		}
	}

	huge := []*GetBlockHeadersPacket{
		{Origin: HashOrNumber{Hash: chain.Genesis().Hash()}, Amount: math.MaxUint64},
		{Origin: HashOrNumber{Hash: chain.CurrentBlock().Hash()}, Amount: math.MaxUint64, Reverse: true},
		{Origin: HashOrNumber{Number: 0}, Amount: math.MaxUint64},
		{Origin: HashOrNumber{Number: head}, Amount: math.MaxUint64, Reverse: true},
		{Origin: HashOrNumber{Number: head}, Amount: 5000, Reverse: true},
		{Origin: HashOrNumber{Hash: chain.Genesis().Hash()}, Amount: 5000, Skip: 1},
		{Origin: HashOrNumber{Number: head}, Amount: 5000, Skip: 1, Reverse: true},
	}
	for i, q := range huge {
		got := ServiceGetBlockHeadersQuery(chain, q, nil)
		if len(got) > maxHeadersServe {
			t.Errorf("query %d (%+v): %d headers, cap is %d", i, *q, len(got), maxHeadersServe)
		}
		if len(got) == 0 {
			t.Errorf("query %d (%+v): no headers", i, *q)
		}
	}

	// Amount=1 still answers with exactly the origin.
	if got := ServiceGetBlockHeadersQuery(chain, &GetBlockHeadersPacket{Origin: HashOrNumber{Hash: mid.Hash()}, Amount: 1}, nil); len(got) != 1 {
		t.Errorf("Amount=1: %d headers, want 1", len(got))
	}
}

// TestGetBlockHeadersAmountZeroWire sends the attack over the wire: an eth/66
// peer asks for Amount=0 by hash and gets an empty BlockHeaders reply.
func TestGetBlockHeadersAmountZeroWire(t *testing.T) {
	backend := newTestBackend(3000)
	defer backend.close()
	peer, _ := newTestPeer("peer", ETH66, backend)
	defer peer.close()

	origin := backend.chain.GetBlockByNumber(2500).Hash()
	p2p.Send(peer.app, GetBlockHeadersMsg, &GetBlockHeadersPacket66{
		RequestId:             7,
		GetBlockHeadersPacket: &GetBlockHeadersPacket{Origin: HashOrNumber{Hash: origin}, Amount: 0},
	})
	if err := p2p.ExpectMsg(peer.app, BlockHeadersMsg, &BlockHeadersPacket66{RequestId: 7, BlockHeadersPacket: nil}); err != nil {
		t.Fatalf("Amount=0 reply: %v", err)
	}
}
