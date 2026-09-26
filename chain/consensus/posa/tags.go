// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.

package posa

import (
	"github.com/aliasghar89/ferminux/chain/consensus"
	"github.com/aliasghar89/ferminux/chain/core/types"
)

// The "safe" and "finalized" block tags of the JSON-RPC API have no source on
// an authority chain in go-ethereum 1.10.26: they are set by a beacon client,
// which Ferminux does not have, so both tags answered "not found". These two
// helpers give them a meaning from the authority rules. Neither is used by
// consensus, fork choice or sync; they only name blocks for the RPC layer.

// FinalizedNumber returns the block that the "finalized" tag names when the
// head is `head` and the node enforces a reorg-depth cap of maxReorgDepth
// (core.CacheConfig.FerminuxMaxReorgDepth): head - maxReorgDepth. While the
// head is an authority block the node refuses any reorg that drops more than
// maxReorgDepth blocks, so that block cannot leave the canonical chain unless
// an operator restarts the node with --ferminux.allowdeepreorg.
//
// ok is false when the rule does not apply: a pass-through engine, a head
// below PosaBlock (the cap is inert there), or no cap.
func (p *Posa) FinalizedNumber(head *types.Header, maxReorgDepth int) (number uint64, ok bool) {
	if p.poa == nil || head == nil || !p.IsPosa(head.Number) || maxReorgDepth <= 0 {
		return 0, false
	}
	return below(head.Number.Uint64(), uint64(maxReorgDepth)), true
}

// SafeNumber returns the block that the "safe" tag names when the head is
// `head`: head - (len(signers)/2 + 1), where signers is the authority set in
// the snapshot at the head. That is the recently-signed window of Clique: no
// signer may seal twice inside it, so the blocks built on a safe block come
// from a majority of distinct signers.
//
// ok is false for a pass-through engine, a head below PosaBlock, or a head
// whose snapshot cannot be built.
func (p *Posa) SafeNumber(chain consensus.ChainHeaderReader, head *types.Header) (number uint64, ok bool) {
	if p.poa == nil || head == nil || !p.IsPosa(head.Number) {
		return 0, false
	}
	signers, err := p.poa.SignersAt(chain, head)
	if err != nil || len(signers) == 0 {
		return 0, false
	}
	return below(head.Number.Uint64(), uint64(len(signers)/2+1)), true
}

// below returns n - depth, floored at the genesis.
func below(n, depth uint64) uint64 {
	if n < depth {
		return 0
	}
	return n - depth
}
