// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package node

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestBatchLimitDefaults pins the default server-side batch limits: 1000
// requests and 25 MB of results per batch.
func TestBatchLimitDefaults(t *testing.T) {
	if DefaultConfig.BatchRequestLimit != 1000 {
		t.Errorf("BatchRequestLimit = %d, want 1000", DefaultConfig.BatchRequestLimit)
	}
	if DefaultConfig.BatchResponseMaxSize != 25*1000*1000 {
		t.Errorf("BatchResponseMaxSize = %d, want 25000000", DefaultConfig.BatchResponseMaxSize)
	}
}

// TestHTTPBatchLimit checks that the limit configured on the node reaches the
// HTTP endpoint's rpc.Server.
func TestHTTPBatchLimit(t *testing.T) {
	srv := createAndStartServer(t, &httpConfig{batchItemLimit: 2}, false, nil)
	defer srv.stop()
	url := "http://" + srv.listenAddr()

	post := func(n int) string {
		call := `{"jsonrpc":"2.0","id":1,"method":"rpc_modules","params":[]}`
		body := "[" + strings.TrimSuffix(strings.Repeat(call+",", n), ",") + "]"
		resp, err := http.Post(url, "application/json", bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	if got := post(2); strings.Contains(got, "batch too large") {
		t.Fatalf("batch of 2 at a limit of 2 refused: %s", got)
	}
	if got := post(3); !strings.Contains(got, "batch too large") {
		t.Fatalf("batch of 3 at a limit of 2 served: %s", got)
	}
}
