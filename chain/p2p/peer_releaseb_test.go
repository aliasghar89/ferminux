// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package p2p

import (
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// TestPeerPingFlood is the CVE-2023-40591 regression. The remote sends 50,000
// pings and never reads a pong. Release A started one goroutine per ping,
// each blocked writing its pong, so goroutines (and memory) grew with every
// ping. Now at most one pong is in flight and 16 are queued, after which the
// peer's own readLoop stalls; the goroutine count stays flat and the peer
// still shuts down cleanly.
func TestPeerPingFlood(t *testing.T) {
	closer, rw, _, errc := testPeer(nil)
	// Let the peer's read, ping and run goroutines start.
	time.Sleep(50 * time.Millisecond)
	base := runtime.NumGoroutine()

	const pings = 50000
	var sent int64
	go func() {
		for i := 0; i < pings; i++ {
			if err := SendItems(rw, pingMsg); err != nil {
				return
			}
			atomic.AddInt64(&sent, 1)
		}
	}()
	// Wait until the flood completes or stalls (the fixed peer stops reading).
	last, still := int64(-1), 0
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
		n := atomic.LoadInt64(&sent)
		if n == pings {
			break
		}
		if n == last {
			if still++; still >= 6 {
				break
			}
		} else {
			last, still = n, 0
		}
	}
	grown := runtime.NumGoroutine() - base
	t.Logf("pings accepted: %d of %d, goroutines grew by %d", atomic.LoadInt64(&sent), pings, grown)
	if grown >= 20 {
		t.Fatalf("goroutines grew by %d during a ping flood, want < 20", grown)
	}

	closer()
	select {
	case <-errc:
	case <-time.After(5 * time.Second):
		t.Fatal("peer did not shut down after the flood")
	}
}
