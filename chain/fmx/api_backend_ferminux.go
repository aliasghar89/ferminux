// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package fmx

import (
	"github.com/aliasghar89/ferminux/chain/consensus/posa"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/rpc"
)

// ferminuxTagHeader resolves the "finalized" and "safe" block tags from the
// authority rules (consensus/posa/tags.go): finalized is the block the reorg
// cap (64) protects below the head, safe is the block len(signers)/2+1 below
// it. The tags are derived from the head on every call and never stored.
//
// It returns nil when the rules do not apply (no authority engine, a head
// below PosaBlock, --ferminux.allowdeepreorg for finalized) and the caller
// falls back to the stock values.
func (b *EthAPIBackend) ferminuxTagHeader(number rpc.BlockNumber) *types.Header {
	p := posa.Unwrap(b.eth.engine)
	if p == nil {
		return nil
	}
	chain := b.eth.blockchain
	head := chain.CurrentBlock().Header()
	var (
		n  uint64
		ok bool
	)
	switch number {
	case rpc.FinalizedBlockNumber:
		n, ok = p.FinalizedNumber(head, chain.FerminuxMaxReorgDepth())
	case rpc.SafeBlockNumber:
		n, ok = p.SafeNumber(chain, head)
	}
	if !ok {
		return nil
	}
	return chain.GetHeaderByNumber(n)
}
