// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package fmxclient

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/rpc"
)

// TestBlockReceipts covers eth_getBlockReceipts: by number, hash and tag it
// returns one receipt per transaction in block order, each identical to
// eth_getTransactionReceipt; an empty block gives an empty list and a missing
// block gives null (NotFound).
func TestBlockReceipts(t *testing.T) {
	backend, chain := newTestBackend(t)
	client, _ := backend.Attach()
	defer backend.Close()
	defer client.Close()
	ec := NewClient(client)
	ctx := context.Background()

	block := chain[2] // carries testTx1 and testTx2
	refs := map[string]rpc.BlockNumberOrHash{
		"number": rpc.BlockNumberOrHashWithNumber(2),
		"hash":   rpc.BlockNumberOrHashWithHash(block.Hash(), false),
		"latest": rpc.BlockNumberOrHashWithNumber(rpc.LatestBlockNumber),
	}
	for name, ref := range refs {
		rs, err := ec.BlockReceipts(ctx, ref)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(rs) != len(block.Transactions()) {
			t.Fatalf("%s: %d receipts, want %d", name, len(rs), len(block.Transactions()))
		}
		for i, tx := range block.Transactions() {
			r := rs[i]
			if r.TxHash != tx.Hash() || r.BlockHash != block.Hash() || r.BlockNumber.Uint64() != 2 || r.TransactionIndex != uint(i) {
				t.Errorf("%s: receipt %d = {tx %x block %x #%v idx %d}", name, i, r.TxHash, r.BlockHash, r.BlockNumber, r.TransactionIndex)
			}
			if r.Status != types.ReceiptStatusSuccessful {
				t.Errorf("%s: receipt %d status %d", name, i, r.Status)
			}
		}
	}

	var batch []map[string]interface{}
	if err := client.CallContext(ctx, &batch, "eth_getBlockReceipts", "0x2"); err != nil {
		t.Fatal(err)
	}
	for i, tx := range block.Transactions() {
		var one map[string]interface{}
		if err := client.CallContext(ctx, &one, "eth_getTransactionReceipt", tx.Hash()); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(batch[i], one) {
			t.Errorf("receipt %d differs from eth_getTransactionReceipt:\n  block: %v\n  tx:    %v", i, batch[i], one)
		}
	}

	var empty []map[string]interface{}
	if err := client.CallContext(ctx, &empty, "eth_getBlockReceipts", "0x1"); err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Errorf("block without transactions: %v, want []", empty)
	}
	if _, err := ec.BlockReceipts(ctx, rpc.BlockNumberOrHashWithNumber(99)); !errors.Is(err, ferminux.NotFound) {
		t.Errorf("missing block: err = %v, want NotFound", err)
	}
}
