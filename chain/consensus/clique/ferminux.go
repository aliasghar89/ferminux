// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.
//
// Ferminux additions to stock Clique. Two things live here:
//
//  1. Snapshot bootstrap. Stock Clique walks back to genesis and parses the
//     signer list out of the genesis extraData. The Ferminux genesis extraData
//     is 29 bytes ("Made with love by Wizrd - FMX"), so that parse yields a
//     negative slice length and panics. A bootstrapped engine instead seeds
//     its first snapshot at a fixed anchor block (PosaBlock-1) from a compiled
//     in signer list and refuses to look below it.
//
//  2. Break-glass signer-set override. ANY authority block may carry a
//     replacement signer list in its extraData, provided it is accompanied by
//     EIP-191 signatures over (chainId, number, parentHash, list) from at
//     least BreakGlassConfig.Threshold distinct Ferminux multisig owners. The
//     owner signatures are the authentication of that block:
//
//     - it may be sealed by ANY member of the override list (the post-block
//       authority set), whether or not that address is in the pre-block set;
//     - the recently-signed rule is NOT applied to it (the pre-block set may
//       be wedged with every live signer inside the recency window, or may be
//       hostile);
//     - its in-turn/out-of-turn difficulty is computed against the override
//       list;
//     - it casts no vote (zero coinbase, zero nonce, like a checkpoint);
//     - from that block on the override list is the authority set, the vote
//       tally is reset, and every stock rule applies again unchanged
//       (seal against the snapshot, recency window, errMismatchingCheckpointSigners
//       for plain checkpoints).
//
//     The signed message binds the exact block slot (number AND parent hash):
//     an override can neither be replayed on a sibling fork nor held back and
//     used at another height. Because the override is not tied to epoch
//     boundaries, recovery from a halted chain (for example three of five
//     signers offline, the two survivors both inside the recency window) takes
//     one block, not one epoch: the owners sign for (head+1, head.hash), a
//     survivor arms it with clique_breakGlass and seals it.
//
// Break-glass extraData layout (any block N >= PosaBlock):
//
//	offset            size   field
//	0                 32     vanity (free form, as in stock Clique)
//	32                20*K   override signer list: K >= 1 addresses, strictly
//	                         ascending, no duplicates (the post-block set)
//	32+20K            65*M   M owner signatures, each r||s||v with v in {0,1}
//	                         (v = 27/28 as emitted by personal_sign is also
//	                         accepted), over breakGlassDigest(chainId, N, parentHash, list)
//	32+20K+65M        1      M, uint8, 1 <= M <= len(owners)
//	32+20K+65M+1      8      magic "FMX-BGL2"
//	len-65            65     Clique seal of a member of the override list
//
// Discrimination from a plain checkpoint is by length: a plain checkpoint
// payload (everything between vanity and seal) is 20K bytes; a break-glass
// payload is 20K + 65M + 9 bytes, which is never a multiple of 20
// (65M + 9 == 5M + 9 mod 20 takes only the values 9, 14, 19, 4). The magic
// trailer is a second, explicit check. On a non-checkpoint block any payload
// that is not a break-glass payload remains errExtraSigners.
//
// Signed message (EIP-191 personal_sign, version 0x45):
//
//	msg    = "FERMINUX-BREAK-GLASS-V2" || chainId (uint256 big-endian, 32 bytes)
//	         || N (uint64 big-endian, 8 bytes) || parentHash (32 bytes)
//	         || signer list (20*K bytes)
//	digest = keccak256("\x19Ethereum Signed Message:\n" || len(msg) || msg)
//
// Owners sign `msg` with any personal_sign-capable wallet; clique_breakGlassMessage
// returns the exact bytes. The sealing node arms the override with
// clique_breakGlass(number, parentHash, signers, signatures) and includes it
// in the header it produces for exactly that slot.

package clique

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"sort"

	"github.com/aliasghar89/ferminux/chain/accounts"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/consensus"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/log"
)

const (
	breakGlassMagicLen   = 8
	breakGlassCountLen   = 1
	breakGlassTrailerLen = breakGlassCountLen + breakGlassMagicLen // 9 bytes: count || magic

	// breakGlassMinPayload is the shortest payload that can be a break-glass
	// payload: one address plus the trailer (the count is validated later).
	breakGlassMinPayload = common.AddressLength + breakGlassTrailerLen
)

var (
	breakGlassMagic  = []byte("FMX-BGL2")
	breakGlassPrefix = []byte("FERMINUX-BREAK-GLASS-V2")
)

var (
	// errBelowBootstrap is returned when signer state is requested for a block
	// below the bootstrap anchor; a bootstrapped engine never derives signer
	// state from genesis.
	errBelowBootstrap = errors.New("authority snapshot requested below the PoSA bootstrap block")

	// errBreakGlassDisabled is returned if a header carries an override but
	// the engine has no break-glass configuration.
	errBreakGlassDisabled = errors.New("break-glass override on block but break-glass is not configured")

	// errBreakGlassMalformed is returned if the break-glass trailer is present
	// but the payload does not decode to a signer list plus signatures.
	errBreakGlassMalformed = errors.New("malformed break-glass payload")

	// errBreakGlassSignerList is returned if the override list is empty, not
	// strictly ascending, or contains duplicates.
	errBreakGlassSignerList = errors.New("break-glass signer list empty, unsorted or duplicated")

	// errBreakGlassBadSignature is returned if any accompanying signature is
	// invalid, duplicated, not from a multisig owner, or signed for another
	// chain, block number, parent hash or list.
	errBreakGlassBadSignature = errors.New("break-glass signature invalid, duplicated or not from a multisig owner")

	// errBreakGlassThreshold is returned if fewer distinct owners signed the
	// override than the configured threshold.
	errBreakGlassThreshold = errors.New("break-glass override below the owner-signature threshold")

	// errBreakGlassNumber is returned when arming an override for the genesis.
	errBreakGlassNumber = errors.New("break-glass override must target a block above the genesis")

	// errBreakGlassVote is returned if a break-glass block carries a vote: like
	// a checkpoint it must have a zero beneficiary and a zero nonce.
	errBreakGlassVote = errors.New("vote in break-glass block non-zero")

	// errBreakGlassUnauthorizedSealer is returned if a break-glass block is
	// sealed by an address outside its own override list.
	errBreakGlassUnauthorizedSealer = errors.New("break-glass block not sealed by a member of the override list")
)

// Bootstrap seeds the authority snapshot at a fixed block instead of genesis.
type Bootstrap struct {
	Anchor  uint64           // Block whose post-state is the seeded snapshot (PosaBlock-1)
	Signers []common.Address // Authority set in force at Anchor
}

// BreakGlassConfig authorises signer-set overrides.
type BreakGlassConfig struct {
	ChainID   *big.Int         // Chain ID bound into the signed message
	Owners    []common.Address // Multisig owner keys allowed to sign overrides
	Threshold int              // Distinct owner signatures required
}

func (bg *BreakGlassConfig) isOwner(addr common.Address) bool {
	for _, owner := range bg.Owners {
		if owner == addr {
			return true
		}
	}
	return false
}

// BreakGlassOverride is an armed override waiting for its block slot.
type BreakGlassOverride struct {
	Number     uint64           `json:"number"`
	ParentHash common.Hash      `json:"parentHash"`
	Signers    []common.Address `json:"signers"`
	Signatures [][]byte         `json:"signatures"`
}

// SetBootstrap makes the engine seed its first snapshot at anchor from the
// given signers and refuse to look below it. Must be called before use.
func (c *Clique) SetBootstrap(anchor uint64, signers []common.Address) error {
	if len(signers) == 0 {
		return errors.New("clique bootstrap requires at least one signer")
	}
	seen := make(map[common.Address]struct{}, len(signers))
	uniq := make([]common.Address, 0, len(signers))
	for _, s := range signers {
		if s == (common.Address{}) {
			return errors.New("clique bootstrap signer is the zero address")
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		uniq = append(uniq, s)
	}
	sort.Sort(signersAscending(uniq))
	c.lock.Lock()
	defer c.lock.Unlock()
	c.bootstrap = &Bootstrap{Anchor: anchor, Signers: uniq}
	return nil
}

// SetBreakGlass enables signer-set overrides signed by the given owners. Must
// be called before use.
func (c *Clique) SetBreakGlass(bg *BreakGlassConfig) error {
	if bg == nil {
		c.lock.Lock()
		c.breakGlass = nil
		c.lock.Unlock()
		return nil
	}
	if bg.ChainID == nil {
		return errors.New("clique break-glass requires a chain id")
	}
	if bg.Threshold <= 0 || bg.Threshold > len(bg.Owners) {
		return fmt.Errorf("clique break-glass threshold %d invalid for %d owners", bg.Threshold, len(bg.Owners))
	}
	cpy := &BreakGlassConfig{
		ChainID:   new(big.Int).Set(bg.ChainID),
		Owners:    append([]common.Address{}, bg.Owners...),
		Threshold: bg.Threshold,
	}
	c.lock.Lock()
	defer c.lock.Unlock()
	c.breakGlass = cpy
	return nil
}

// ArmBreakGlass validates and stores an override to be embedded in the header
// this node seals at `number` on top of `parentHash`. It replaces any
// previously armed one.
func (c *Clique) ArmBreakGlass(number uint64, parentHash common.Hash, signers []common.Address, signatures [][]byte) error {
	c.lock.RLock()
	bg := c.breakGlass
	c.lock.RUnlock()
	if bg == nil {
		return errBreakGlassDisabled
	}
	if number == 0 {
		return errBreakGlassNumber
	}
	sorted, err := sortedUniqueSigners(signers)
	if err != nil {
		return err
	}
	if err := verifyBreakGlass(bg, number, parentHash, sorted, signatures); err != nil {
		return err
	}
	sigs := make([][]byte, len(signatures))
	for i, sig := range signatures {
		sigs[i] = common.CopyBytes(sig)
	}
	c.lock.Lock()
	c.bgPending = &BreakGlassOverride{Number: number, ParentHash: parentHash, Signers: sorted, Signatures: sigs}
	c.lock.Unlock()
	log.Warn("BREAK-GLASS signer-set override ARMED", "number", number, "parent", parentHash, "signers", sorted, "owner_sigs", len(sigs))
	return nil
}

// DisarmBreakGlass drops any armed override.
func (c *Clique) DisarmBreakGlass() {
	c.lock.Lock()
	c.bgPending = nil
	c.lock.Unlock()
}

// BreakGlassPending returns a copy of the armed override, or nil.
func (c *Clique) BreakGlassPending() *BreakGlassOverride {
	c.lock.RLock()
	defer c.lock.RUnlock()
	if c.bgPending == nil {
		return nil
	}
	cpy := &BreakGlassOverride{
		Number:     c.bgPending.Number,
		ParentHash: c.bgPending.ParentHash,
		Signers:    append([]common.Address{}, c.bgPending.Signers...),
		Signatures: make([][]byte, len(c.bgPending.Signatures)),
	}
	for i, sig := range c.bgPending.Signatures {
		cpy.Signatures[i] = common.CopyBytes(sig)
	}
	return cpy
}

// BreakGlassMessage returns the raw EIP-191 message owners must sign
// (personal_sign) to authorise `signers` at block `number` built on
// `parentHash`. The chain id comes from the engine's break-glass configuration.
func (c *Clique) BreakGlassMessage(number uint64, parentHash common.Hash, signers []common.Address) ([]byte, error) {
	c.lock.RLock()
	bg := c.breakGlass
	c.lock.RUnlock()
	if bg == nil {
		return nil, errBreakGlassDisabled
	}
	sorted, err := sortedUniqueSigners(signers)
	if err != nil {
		return nil, err
	}
	return breakGlassMessage(bg.ChainID, number, parentHash, sorted), nil
}

// VerifyHeadersWithAncestors is VerifyHeaders for a batch whose parent (and
// further ancestors) may not be in the database yet: `ancestors` are the
// already-verified headers immediately preceding headers[0], in ascending
// order. The posa wrapper uses it for batches that straddle the fork block,
// where the last Powhash headers are verified concurrently with the first
// Clique ones.
func (c *Clique) VerifyHeadersWithAncestors(chain consensus.ChainHeaderReader, headers []*types.Header, ancestors []*types.Header) (chan<- struct{}, <-chan error) {
	abort := make(chan struct{})
	results := make(chan error, len(headers))

	all := make([]*types.Header, 0, len(ancestors)+len(headers))
	all = append(all, ancestors...)
	all = append(all, headers...)

	go func() {
		for i, header := range headers {
			err := c.verifyHeader(chain, header, all[:len(ancestors)+i])

			select {
			case <-abort:
				return
			case results <- err:
			}
		}
	}()
	return abort, results
}

// EncodeBreakGlassMessage returns the raw EIP-191 message (before the
// personal_sign prefix) that authorises `signers` at block `number` built on
// `parentHash` on chain `chainID`. Exported for tooling and tests; signers
// must already be in ascending order.
func EncodeBreakGlassMessage(chainID *big.Int, number uint64, parentHash common.Hash, signers []common.Address) []byte {
	return breakGlassMessage(chainID, number, parentHash, signers)
}

// BreakGlassExtra assembles a complete break-glass extraData: the 32-byte
// vanity (padded/truncated), the override payload and a zeroed 65-byte seal
// slot for the sealer to fill. Exported for tooling and tests.
func BreakGlassExtra(vanity []byte, signers []common.Address, signatures [][]byte) []byte {
	extra := make([]byte, extraVanity)
	copy(extra, vanity)
	extra = append(extra, encodeBreakGlassPayload(signers, signatures)...)
	return append(extra, make([]byte, extraSeal)...)
}

// IsBreakGlassHeader reports whether header carries a break-glass payload
// (without verifying it). Exported for tooling and tests.
func IsBreakGlassHeader(header *types.Header) bool {
	return isBreakGlassExtra(header.Extra)
}

// sortedUniqueSigners returns the list in ascending order, rejecting empty
// lists, duplicates and the zero address.
func sortedUniqueSigners(signers []common.Address) ([]common.Address, error) {
	if len(signers) == 0 {
		return nil, errBreakGlassSignerList
	}
	sorted := append([]common.Address{}, signers...)
	sort.Sort(signersAscending(sorted))
	for i := range sorted {
		if sorted[i] == (common.Address{}) {
			return nil, errBreakGlassSignerList
		}
		if i > 0 && sorted[i-1] == sorted[i] {
			return nil, errBreakGlassSignerList
		}
	}
	return sorted, nil
}

// isBreakGlassExtra reports whether the section between vanity and seal is a
// break-glass payload: not a whole number of addresses (so never a plain
// checkpoint list) and terminated by the magic trailer. A payload that passes
// this test is decoded by parseCheckpointExtra on its break-glass path.
func isBreakGlassExtra(extra []byte) bool {
	if len(extra) < extraVanity+extraSeal+breakGlassMinPayload {
		return false
	}
	payload := extra[extraVanity : len(extra)-extraSeal]
	return len(payload)%common.AddressLength != 0 && bytes.HasSuffix(payload, breakGlassMagic)
}

// parseCheckpointExtra decodes the section between vanity and seal of a
// checkpoint or break-glass header. It returns the signer list, the
// break-glass signatures (nil for a plain checkpoint) and whether the override
// trailer was present. The caller guarantees len(extra) >= extraVanity+extraSeal.
func parseCheckpointExtra(extra []byte) ([]common.Address, [][]byte, bool, error) {
	if len(extra) < extraVanity+extraSeal {
		return nil, nil, false, errMissingSignature
	}
	payload := extra[extraVanity : len(extra)-extraSeal]

	// Plain checkpoint: a whole number of addresses.
	if len(payload)%common.AddressLength == 0 {
		signers := make([]common.Address, len(payload)/common.AddressLength)
		for i := range signers {
			copy(signers[i][:], payload[i*common.AddressLength:])
		}
		return signers, nil, false, nil
	}
	// Anything else must be a break-glass payload terminated by the magic.
	if len(payload) < breakGlassTrailerLen || !bytes.Equal(payload[len(payload)-breakGlassMagicLen:], breakGlassMagic) {
		return nil, nil, false, errInvalidCheckpointSigners
	}
	count := int(payload[len(payload)-breakGlassTrailerLen])
	if count == 0 {
		return nil, nil, true, errBreakGlassMalformed
	}
	sigBytes := count * crypto.SignatureLength
	signersBytes := len(payload) - breakGlassTrailerLen - sigBytes
	if signersBytes < common.AddressLength || signersBytes%common.AddressLength != 0 {
		return nil, nil, true, errBreakGlassMalformed
	}
	signers := make([]common.Address, signersBytes/common.AddressLength)
	for i := range signers {
		copy(signers[i][:], payload[i*common.AddressLength:])
	}
	sigs := make([][]byte, count)
	for i := range sigs {
		start := signersBytes + i*crypto.SignatureLength
		sigs[i] = common.CopyBytes(payload[start : start+crypto.SignatureLength])
	}
	return signers, sigs, true, nil
}

// encodeBreakGlassPayload builds the bytes that go between vanity and seal.
func encodeBreakGlassPayload(signers []common.Address, signatures [][]byte) []byte {
	payload := make([]byte, 0, len(signers)*common.AddressLength+len(signatures)*crypto.SignatureLength+breakGlassTrailerLen)
	for _, s := range signers {
		payload = append(payload, s[:]...)
	}
	for _, sig := range signatures {
		payload = append(payload, sig...)
	}
	payload = append(payload, byte(len(signatures)))
	payload = append(payload, breakGlassMagic...)
	return payload
}

// breakGlassMessage is the raw message owners sign (before the EIP-191 prefix).
func breakGlassMessage(chainID *big.Int, number uint64, parentHash common.Hash, signers []common.Address) []byte {
	msg := make([]byte, 0, len(breakGlassPrefix)+32+8+common.HashLength+len(signers)*common.AddressLength)
	msg = append(msg, breakGlassPrefix...)
	msg = append(msg, common.LeftPadBytes(chainID.Bytes(), 32)...)
	var num [8]byte
	binary.BigEndian.PutUint64(num[:], number)
	msg = append(msg, num[:]...)
	msg = append(msg, parentHash[:]...)
	for _, s := range signers {
		msg = append(msg, s[:]...)
	}
	return msg
}

// breakGlassDigest is the EIP-191 (personal_sign) hash of breakGlassMessage.
func breakGlassDigest(chainID *big.Int, number uint64, parentHash common.Hash, signers []common.Address) []byte {
	return accounts.TextHash(breakGlassMessage(chainID, number, parentHash, signers))
}

// verifyBreakGlass checks an override list and its owner signatures for the
// block slot (number, parentHash). Strict: every signature must be valid,
// from a distinct owner, and at least Threshold distinct owners must have
// signed.
func verifyBreakGlass(bg *BreakGlassConfig, number uint64, parentHash common.Hash, signers []common.Address, signatures [][]byte) error {
	if bg == nil || len(bg.Owners) == 0 || bg.Threshold <= 0 {
		return errBreakGlassDisabled
	}
	if len(signers) == 0 {
		return errBreakGlassSignerList
	}
	for i := range signers {
		if signers[i] == (common.Address{}) {
			return errBreakGlassSignerList
		}
		if i > 0 && bytes.Compare(signers[i-1][:], signers[i][:]) >= 0 {
			return errBreakGlassSignerList
		}
	}
	if len(signatures) == 0 || len(signatures) > len(bg.Owners) {
		return errBreakGlassBadSignature
	}
	digest := breakGlassDigest(bg.ChainID, number, parentHash, signers)
	seen := make(map[common.Address]struct{}, len(signatures))
	for _, sig := range signatures {
		if len(sig) != crypto.SignatureLength {
			return errBreakGlassBadSignature
		}
		norm := make([]byte, crypto.SignatureLength)
		copy(norm, sig)
		if norm[crypto.RecoveryIDOffset] >= 27 {
			norm[crypto.RecoveryIDOffset] -= 27
		}
		pub, err := crypto.SigToPub(digest, norm)
		if err != nil {
			return errBreakGlassBadSignature
		}
		owner := crypto.PubkeyToAddress(*pub)
		if !bg.isOwner(owner) {
			return errBreakGlassBadSignature
		}
		if _, dup := seen[owner]; dup {
			return errBreakGlassBadSignature
		}
		seen[owner] = struct{}{}
	}
	if len(seen) < bg.Threshold {
		return errBreakGlassThreshold
	}
	return nil
}

// breakGlassOverrideOf returns the override list carried by header after
// verifying its owner signatures against bg, or (nil, nil) for a header
// without a break-glass payload.
func breakGlassOverrideOf(bg *BreakGlassConfig, header *types.Header) ([]common.Address, error) {
	if !isBreakGlassExtra(header.Extra) {
		return nil, nil
	}
	signers, sigs, _, err := parseCheckpointExtra(header.Extra)
	if err != nil {
		return nil, err
	}
	if err := verifyBreakGlass(bg, header.Number.Uint64(), header.ParentHash, signers, sigs); err != nil {
		return nil, err
	}
	return signers, nil
}

// breakGlassOverride is breakGlassOverrideOf with the engine's configuration.
func (c *Clique) breakGlassOverride(header *types.Header) ([]common.Address, error) {
	return breakGlassOverrideOf(c.breakGlass, header)
}

// containsAddress reports whether addr is in list.
func containsAddress(list []common.Address, addr common.Address) bool {
	for _, a := range list {
		if a == addr {
			return true
		}
	}
	return false
}

// inturnAmong reports whether signer is the in-turn sealer of block `number`
// for the ascending list `signers` (the same rule as Snapshot.inturn).
func inturnAmong(signers []common.Address, number uint64, signer common.Address) bool {
	offset := 0
	for offset < len(signers) && signers[offset] != signer {
		offset++
	}
	return (number % uint64(len(signers))) == uint64(offset)
}

// calcDifficultyAmong is calcDifficulty for a break-glass block: the turn is
// taken in the override list.
func calcDifficultyAmong(signers []common.Address, number uint64, signer common.Address) *big.Int {
	if inturnAmong(signers, number, signer) {
		return new(big.Int).Set(diffInTurn)
	}
	return new(big.Int).Set(diffNoTurn)
}

// verifyBreakGlassSeal checks the seal of a break-glass header whose owner
// signatures have already been verified: the sealer must be a member of the
// override list and the difficulty must match its turn in that list. The
// recently-signed rule is deliberately not applied (see the file comment).
func (c *Clique) verifyBreakGlassSeal(header *types.Header, override []common.Address) error {
	signer, err := ecrecover(header, c.signatures)
	if err != nil {
		return err
	}
	if !containsAddress(override, signer) {
		return errBreakGlassUnauthorizedSealer
	}
	if !c.fakeDiff {
		inturn := inturnAmong(override, header.Number.Uint64(), signer)
		if inturn && header.Difficulty.Cmp(diffInTurn) != 0 {
			return errWrongDifficulty
		}
		if !inturn && header.Difficulty.Cmp(diffNoTurn) != 0 {
			return errWrongDifficulty
		}
	}
	return nil
}
