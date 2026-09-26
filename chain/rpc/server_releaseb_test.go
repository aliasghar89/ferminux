// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestServerBatchResponseSizeLimit is upstream's #26681 test: with a 60-byte
// budget the first two echo results fit and every later call in the batch is
// answered with "response too large" instead of being executed.
func TestServerBatchResponseSizeLimit(t *testing.T) {
	server := newTestServer()
	defer server.Stop()
	server.SetBatchLimits(100, 60)
	var (
		batch  []BatchElem
		client = DialInProc(server)
	)
	defer client.Close()
	for i := 0; i < 5; i++ {
		batch = append(batch, BatchElem{
			Method: "test_echo",
			Args:   []interface{}{"x", 1},
			Result: new(echoResult),
		})
	}
	if err := client.BatchCall(batch); err != nil {
		t.Fatal("error sending batch:", err)
	}
	for i := range batch {
		if i < 2 {
			if batch[i].Error != nil {
				t.Fatalf("batch elem %d has unexpected error: %v", i, batch[i].Error)
			}
			continue
		}
		re, ok := batch[i].Error.(Error)
		if !ok {
			t.Fatalf("batch elem %d has wrong error: %v", i, batch[i].Error)
		}
		if re.ErrorCode() != errcodeResponseTooLarge {
			t.Errorf("batch elem %d wrong error code, have %d want %d", i, re.ErrorCode(), errcodeResponseTooLarge)
		}
	}
}

// TestServerBatchLimitsHTTP drives both limits through the HTTP transport,
// which is what the public RPC serves: a batch over the item limit gets one
// "batch too large" error and runs nothing; a batch at the limit is served.
func TestServerBatchLimitsHTTP(t *testing.T) {
	server := newTestServer()
	defer server.Stop()
	server.SetBatchLimits(3, 0)
	ts := httptest.NewServer(server)
	defer ts.Close()

	post := func(n int) []map[string]interface{} {
		var calls []string
		for i := 0; i < n; i++ {
			calls = append(calls, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"test_echo","params":["x",%d]}`, i+1, i))
		}
		resp, err := http.Post(ts.URL, "application/json", bytes.NewBufferString("["+strings.Join(calls, ",")+"]"))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out []map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if out := post(3); len(out) != 3 || out[0]["error"] != nil {
		t.Fatalf("batch of 3 at a limit of 3: %v", out)
	}
	out := post(4)
	if len(out) != 1 {
		t.Fatalf("batch of 4 at a limit of 3: %d responses, want 1: %v", len(out), out)
	}
	e, _ := out[0]["error"].(map[string]interface{})
	if e == nil || e["message"] != errMsgBatchTooLarge || out[0]["id"] != float64(1) {
		t.Fatalf("batch of 4 at a limit of 3: got %v", out[0])
	}
}
