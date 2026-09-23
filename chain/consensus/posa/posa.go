// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.
//
// Package posa implements the Ferminux proof-of-authority transition engine.
//
// It is a wrapper in the shape of consensus/beacon: every consensus.Engine
// method is dispatched by block number to one of two inner engines,
//
//	header.Number <  ChainConfig.PosaBlock : Ethash proof-of-work (unchanged)
//	header.Number >= ChainConfig.PosaBlock : Clique proof-of-authority
//
// The Clique engine is bootstrapped at PosaBlock-1 from
// params.FerminuxInitialSigners (the Ferminux genesis extraData carries no
// signer list, so stock Clique cannot be used as-is), pays a block reward from
// Finalize to the ecrecovered signer / reward sink / treasury, enforces the
// hardcoded PosaBlock-1 checkpoint hash, and accepts the multisig-owner
// break-glass signer-set override on any authority block
// (consensus/clique/ferminux.go).
//
// Fork choice and reorg policy for the authority chain live in
// core/forkchoice.go (an authority head is never abandoned for a proof-of-work
// head) and core/blockchain.go (reorg-depth cap while the head is an authority
// block).
//
// This is proof-of-authority. Staking is not part of consensus.
//
// Licensed under the GNU Lesser General Public License v3, like upstream.
package posa

import (
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/consensus"
	"github.com/aliasghar89/ferminux/chain/consensus/clique"
	"github.com/aliasghar89/ferminux/chain/consensus/powhash"
	"github.com/aliasghar89/ferminux/chain/core/state"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/fmxdb"
	"github.com/aliasghar89/ferminux/chain/log"
	"github.com/aliasghar89/ferminux/chain/params"
	"github.com/aliasghar89/ferminux/chain/rpc"
	"github.com/aliasghar89/ferminux/chain/trie"
)

var (
	// errCheckpointMismatch is returned for a PosaBlock-1 header whose hash is
	// not the pinned checkpoint, or a PosaBlock header not built on it.
	errCheckpointMismatch = errors.New("header does not match the hardcoded Ferminux authority checkpoint")

	// errNotAuthorized is returned when an authority block is assembled for sealing
	// on a node that has no authorized signer.
	errNotAuthorized = errors.New("authority block assembly requires an authorized signer (Authorize not called)")

	big1 = big.NewInt(1)
)

// notAuthorizedLogInterval bounds how often FinalizeAndAssemble repeats its
// "mining but not a signer" diagnostic. The worker retries assembly on every
// recommit (~3s), and a message that fires 20 times a minute is one the
// operator learns to ignore; once a minute is still impossible to miss.
const notAuthorizedLogInterval = time.Minute

var (

	// Reward split of the authority block reward, in percent. The remainder of the
	// integer division goes to the signer.
	//
	// CONSENSUS CONSTANTS: the split, the divisor below and the sink/treasury
	// addresses in Config are part of the state transition of every authority
	// block and are not covered by the fork ID. Changing any of them after
	// PosaBlock is a hard fork that needs its own *Block field in ChainConfig
	// (so forkid picks it up) and an activation check here.
	sinkPercent     = big.NewInt(50)
	treasuryPercent = big.NewInt(10)
	hundred         = big.NewInt(100)

	// rewardDivisor is the approved emission cut: the authority reward is the
	// pre-authority Powhash
	// schedule's reward divided by four.
	rewardDivisor = big.NewInt(4)
)

// Config carries the proof-of-authority parameters that deliberately live
// outside ChainConfig: genesis.go rejects ChainConfig.Clique on a chain whose
// genesis extraData holds no signer list, and the addresses below are
// Ferminux-specific.
type Config struct {
	Period uint64 // Minimum seconds between authority blocks
	Epoch  uint64 // Checkpoint interval in blocks

	InitialSigners []common.Address // Authority set seeded at PosaBlock
	CheckpointHash common.Hash      // Required hash of block PosaBlock-1; zero disables the check

	RewardSink common.Address // Receives 50% of the block reward; required (consensus constant, see New)
	Treasury   common.Address // Receives 10% of the block reward

	BreakGlassOwners    []common.Address // Multisig owners allowed to sign a signer-set override
	BreakGlassThreshold int              // Distinct owner signatures required
}

// FerminuxConfig returns the live Ferminux parameters from package params. It
// reads the package variables at call time so the release build that pins the
// sink and checkpoint together with PosaBlock is picked up.
func FerminuxConfig() *Config {
	return &Config{
		Period:              params.FerminuxPosaPeriod,
		Epoch:               params.FerminuxPosaEpoch,
		InitialSigners:      append([]common.Address{}, params.FerminuxInitialSigners...),
		CheckpointHash:      params.FerminuxPosaCheckpointHash,
		RewardSink:          params.FerminuxRewardSink,
		Treasury:            params.FerminuxTreasury,
		BreakGlassOwners:    append([]common.Address{}, params.FerminuxBreakGlassOwners...),
		BreakGlassThreshold: params.FerminuxBreakGlassThreshold,
	}
}

// Posa is the dispatching engine.
type Posa struct {
	forkBlock *big.Int // ChainConfig.PosaBlock (nil = pure Powhash, everything delegates to pow)
	config    *Config

	pow consensus.Engine // Powhash, used below forkBlock
	poa *clique.Clique   // Clique, used at and above forkBlock

	lock   sync.RWMutex
	signer common.Address // Local signer, set by Authorize; receives the reward of blocks we assemble

	lastNotAuthWarn time.Time // Rate-limits the "mining but not a signer" diagnostic; guarded by lock
}

// New creates the dispatching engine around an existing Powhash engine. With
// chainConfig.PosaBlock == nil the engine is a transparent pass-through to
// pow; otherwise config must be complete.
func New(chainConfig *params.ChainConfig, config *Config, pow consensus.Engine, db fmxdb.Database) (*Posa, error) {
	if chainConfig == nil {
		return nil, errors.New("posa: nil chain config")
	}
	if pow == nil {
		return nil, errors.New("posa: nil proof-of-work engine")
	}
	if _, nested := pow.(*Posa); nested {
		return nil, errors.New("posa: nested posa engine")
	}
	// Keep a private copy: the config is read lock-free from verification
	// goroutines and must be immutable for the engine's lifetime.
	if config != nil {
		cpy := *config
		cpy.InitialSigners = append([]common.Address{}, config.InitialSigners...)
		cpy.BreakGlassOwners = append([]common.Address{}, config.BreakGlassOwners...)
		config = &cpy
	}
	p := &Posa{pow: pow, config: config}
	if chainConfig.PosaBlock == nil {
		return p, nil
	}
	if chainConfig.PosaBlock.Sign() <= 0 {
		return nil, errors.New("posa: PosaBlock must be >= 1 (block 0 is the genesis)")
	}
	if config == nil {
		return nil, errors.New("posa: PosaBlock set but no authority config")
	}
	if config.Period == 0 || config.Epoch == 0 {
		return nil, fmt.Errorf("posa: invalid period %d / epoch %d", config.Period, config.Epoch)
	}
	if len(config.InitialSigners) == 0 {
		return nil, errors.New("posa: no initial signers")
	}
	if config.Treasury == (common.Address{}) {
		return nil, errors.New("posa: treasury address unset")
	}
	if config.RewardSink == (common.Address{}) {
		// The sink is the AddBalance target of every authority block and is not
		// covered by the fork ID: a fleet where some nodes have it pinned
		// and some do not computes different state roots for the same block
		// with identical fork IDs, i.e. a silent chain split. It must
		// therefore be deployed (under proof-of-work, any time before the
		// fork) and pinned in the SAME release that sets PosaBlock; a binary
		// with PosaBlock set and no sink refuses to start.
		return nil, errors.New("posa: reward sink unset; deploy FMXRewardSink and pin params.FerminuxRewardSink in the release that sets PosaBlock")
	}
	if len(config.BreakGlassOwners) > 0 && (config.BreakGlassThreshold <= 0 || config.BreakGlassThreshold > len(config.BreakGlassOwners)) {
		return nil, fmt.Errorf("posa: break-glass threshold %d invalid for %d owners", config.BreakGlassThreshold, len(config.BreakGlassOwners))
	}
	p.forkBlock = new(big.Int).Set(chainConfig.PosaBlock)

	p.poa = clique.New(&params.CliqueConfig{Period: config.Period, Epoch: config.Epoch}, db)
	anchor := new(big.Int).Sub(p.forkBlock, big1)
	if !anchor.IsUint64() {
		return nil, errors.New("posa: PosaBlock out of range")
	}
	if err := p.poa.SetBootstrap(anchor.Uint64(), config.InitialSigners); err != nil {
		return nil, err
	}
	if len(config.BreakGlassOwners) > 0 {
		if err := p.poa.SetBreakGlass(&clique.BreakGlassConfig{
			ChainID:   chainConfig.ChainID,
			Owners:    config.BreakGlassOwners,
			Threshold: config.BreakGlassThreshold,
		}); err != nil {
			return nil, err
		}
	}
	log.Info("Ferminux proof-of-authority engine armed", "posaBlock", p.forkBlock, "period", config.Period, "epoch", config.Epoch,
		"signers", len(config.InitialSigners), "treasury", config.Treasury, "sink", config.RewardSink, "checkpoint", config.CheckpointHash)
	if config.CheckpointHash == (common.Hash{}) {
		log.Warn("Ferminux authority checkpoint hash is unset: block PosaBlock-1 is not pinned")
	}
	return p, nil
}

// Unwrap returns the Posa engine inside engine, seeing through wrappers that
// expose InnerEngine() (consensus/beacon). nil if there is none.
func Unwrap(engine consensus.Engine) *Posa {
	for engine != nil {
		if p, ok := engine.(*Posa); ok {
			return p
		}
		wrapper, ok := engine.(interface{ InnerEngine() consensus.Engine })
		if !ok {
			return nil
		}
		engine = wrapper.InnerEngine()
	}
	return nil
}

// ForkBlock returns PosaBlock (nil for a pass-through engine).
func (p *Posa) ForkBlock() *big.Int {
	if p.forkBlock == nil {
		return nil
	}
	return new(big.Int).Set(p.forkBlock)
}

// IsPosa reports whether block `num` is sealed by the authority engine.
func (p *Posa) IsPosa(num *big.Int) bool {
	return p.forkBlock != nil && num != nil && p.forkBlock.Cmp(num) <= 0
}

func (p *Posa) isPosaHeader(header *types.Header) bool {
	return p.IsPosa(header.Number)
}

// InnerClique returns the authority engine (nil for a pass-through engine).
func (p *Posa) InnerClique() *clique.Clique {
	return p.poa
}

// InnerPoW returns the wrapped proof-of-work engine.
func (p *Posa) InnerPoW() consensus.Engine {
	return p.pow
}

// Authorize injects the local signing credentials into the authority engine
// and records the signer that receives the reward of blocks assembled here.
func (p *Posa) Authorize(signer common.Address, signFn clique.SignerFn) {
	p.lock.Lock()
	p.signer = signer
	p.lock.Unlock()
	if p.poa != nil {
		p.poa.Authorize(signer, signFn)
	}
}

// Author implements consensus.Engine: the coinbase for PoW headers, the
// ecrecovered signer for authority headers.
func (p *Posa) Author(header *types.Header) (common.Address, error) {
	if p.isPosaHeader(header) {
		return p.poa.Author(header)
	}
	return p.pow.Author(header)
}

// verifyCheckpoint enforces the hardcoded PosaBlock-1 hash: the header at
// PosaBlock-1 must hash to it and the header at PosaBlock must build on it.
func (p *Posa) verifyCheckpoint(header *types.Header) error {
	if p.forkBlock == nil || p.config == nil || p.config.CheckpointHash == (common.Hash{}) || header.Number == nil {
		return nil
	}
	next := new(big.Int).Add(header.Number, big1)
	switch {
	case next.Cmp(p.forkBlock) == 0: // PosaBlock-1
		if header.Hash() != p.config.CheckpointHash {
			log.Error("REJECTING header at PosaBlock-1: hash differs from the hardcoded checkpoint", "number", header.Number, "have", header.Hash(), "want", p.config.CheckpointHash)
			return errCheckpointMismatch
		}
	case header.Number.Cmp(p.forkBlock) == 0: // PosaBlock
		if header.ParentHash != p.config.CheckpointHash {
			log.Error("REJECTING header at PosaBlock: parent is not the hardcoded checkpoint", "number", header.Number, "parent", header.ParentHash, "want", p.config.CheckpointHash)
			return errCheckpointMismatch
		}
	}
	return nil
}

// needsCheckpointFilter reports whether an ascending header batch touches
// PosaBlock-1 or PosaBlock while a checkpoint is pinned.
func (p *Posa) needsCheckpointFilter(headers []*types.Header) bool {
	if p.forkBlock == nil || p.config == nil || p.config.CheckpointHash == (common.Hash{}) || len(headers) == 0 {
		return false
	}
	first, last := headers[0].Number, headers[len(headers)-1].Number
	if first == nil || last == nil {
		return false
	}
	anchor := new(big.Int).Sub(p.forkBlock, big1)
	return first.Cmp(p.forkBlock) <= 0 && last.Cmp(anchor) >= 0
}

// VerifyHeader implements consensus.Engine.
func (p *Posa) VerifyHeader(chain consensus.ChainHeaderReader, header *types.Header, seal bool) error {
	if err := p.verifyCheckpoint(header); err != nil {
		return err
	}
	if p.isPosaHeader(header) {
		return p.poa.VerifyHeader(chain, header, seal)
	}
	return p.pow.VerifyHeader(chain, header, seal)
}

// VerifyHeaders implements consensus.Engine for an ascending, contiguous
// batch. A batch straddling PosaBlock is split: the PoW prefix goes to Powhash
// and the authority suffix to Clique with the prefix supplied as ancestors (those
// headers are not in the database yet). Results are delivered in input order.
func (p *Posa) VerifyHeaders(chain consensus.ChainHeaderReader, headers []*types.Header, seals []bool) (chan<- struct{}, <-chan error) {
	if len(headers) == 0 {
		return p.pow.VerifyHeaders(chain, headers, seals)
	}
	// Find the first authority header; everything after it is authority too.
	split := len(headers)
	for i, header := range headers {
		if p.isPosaHeader(header) {
			split = i
			break
		}
	}
	filter := p.needsCheckpointFilter(headers)
	switch {
	case split == len(headers):
		abort, results := p.pow.VerifyHeaders(chain, headers, seals)
		if !filter {
			return abort, results
		}
		return p.relay(headers, abort, results)

	case split == 0:
		abort, results := p.poa.VerifyHeaders(chain, headers, seals)
		if !filter {
			return abort, results
		}
		return p.relay(headers, abort, results)
	}
	// Mixed batch: verify both halves concurrently, emit in order.
	var (
		abort   = make(chan struct{})
		results = make(chan error, len(headers))

		powAbort, powResults = p.pow.VerifyHeaders(chain, headers[:split], seals[:split])
		poaAbort, poaResults = p.poa.VerifyHeadersWithAncestors(chain, headers[split:], headers[:split])
	)
	go func() {
		stop := func() {
			close(powAbort)
			close(poaAbort)
		}
		for i, header := range headers {
			var err error
			if i < split {
				select {
				case err = <-powResults:
				case <-abort:
					stop()
					return
				}
			} else {
				select {
				case err = <-poaResults:
				case <-abort:
					stop()
					return
				}
			}
			if err == nil {
				err = p.verifyCheckpoint(header)
			}
			select {
			case results <- err:
			case <-abort:
				stop()
				return
			}
		}
	}()
	return abort, results
}

// relay forwards an inner engine's results, overriding a nil result with the
// checkpoint verdict for the headers it applies to.
func (p *Posa) relay(headers []*types.Header, innerAbort chan<- struct{}, inner <-chan error) (chan<- struct{}, <-chan error) {
	abort := make(chan struct{})
	results := make(chan error, len(headers))
	go func() {
		for _, header := range headers {
			var err error
			select {
			case err = <-inner:
			case <-abort:
				close(innerAbort)
				return
			}
			if err == nil {
				err = p.verifyCheckpoint(header)
			}
			select {
			case results <- err:
			case <-abort:
				close(innerAbort)
				return
			}
		}
	}()
	return abort, results
}

// VerifyUncles implements consensus.Engine.
func (p *Posa) VerifyUncles(chain consensus.ChainReader, block *types.Block) error {
	if p.isPosaHeader(block.Header()) {
		return p.poa.VerifyUncles(chain, block)
	}
	return p.pow.VerifyUncles(chain, block)
}

// Prepare implements consensus.Engine.
func (p *Posa) Prepare(chain consensus.ChainHeaderReader, header *types.Header) error {
	if p.isPosaHeader(header) {
		return p.poa.Prepare(chain, header)
	}
	return p.pow.Prepare(chain, header)
}

// BlockReward is the authority block reward at height num: the pre-authority schedule
// (powhash.FerminuxBlockReward) divided by four, the approved emission cut.
func BlockReward(num *big.Int) *big.Int {
	return new(big.Int).Div(powhash.FerminuxBlockReward(num), rewardDivisor)
}

// SplitReward divides an authority block reward: 50% sink, 10% treasury, the rest
// (40% plus the integer-division remainder) to the signer.
func SplitReward(total *big.Int) (signer, sink, treasury *big.Int) {
	sink = new(big.Int).Div(new(big.Int).Mul(total, sinkPercent), hundred)
	treasury = new(big.Int).Div(new(big.Int).Mul(total, treasuryPercent), hundred)
	signer = new(big.Int).Sub(total, sink)
	signer.Sub(signer, treasury)
	return signer, sink, treasury
}

// finalize pays the authority reward to signer, sink and treasury and seals the
// state root. The sink and treasury addresses are consensus constants
// validated by New; there is deliberately no fallback routing.
func (p *Posa) finalize(chain consensus.ChainHeaderReader, header *types.Header, state *state.StateDB, signer common.Address) {
	signerShare, sinkShare, treasuryShare := SplitReward(BlockReward(header.Number))
	if signerShare.Sign() > 0 {
		state.AddBalance(signer, signerShare)
	}
	if sinkShare.Sign() > 0 {
		state.AddBalance(p.config.RewardSink, sinkShare)
	}
	if treasuryShare.Sign() > 0 {
		state.AddBalance(p.config.Treasury, treasuryShare)
	}
	header.Root = state.IntermediateRoot(chain.Config().IsEIP158(header.Number))
	header.UncleHash = types.CalcUncleHash(nil)
}

// Finalize implements consensus.Engine. On the authority path (block verification)
// the reward goes to the ECRECOVERED signer, never header.Coinbase, which
// Clique repurposes for votes.
func (p *Posa) Finalize(chain consensus.ChainHeaderReader, header *types.Header, state *state.StateDB, txs []*types.Transaction, uncles []*types.Header) {
	if !p.isPosaHeader(header) {
		p.pow.Finalize(chain, header, state, txs, uncles)
		return
	}
	signer, err := p.poa.Author(header)
	if err != nil {
		// Unsealed or malformed: the reward cannot be attributed. The resulting
		// root cannot match a correctly sealed block, so verification fails
		// closed rather than crediting a guessed address.
		log.Error("authority finalize: cannot recover block signer, paying no reward", "number", header.Number, "err", err)
		header.Root = state.IntermediateRoot(chain.Config().IsEIP158(header.Number))
		header.UncleHash = types.CalcUncleHash(nil)
		return
	}
	p.finalize(chain, header, state, signer)
}

// FinalizeAndAssemble implements consensus.Engine. On the authority path (block
// production) the header is not sealed yet, so the reward goes to the local
// signer that will seal it; a header that already carries a valid seal is
// credited to its ecrecovered signer.
func (p *Posa) FinalizeAndAssemble(chain consensus.ChainHeaderReader, header *types.Header, state *state.StateDB, txs []*types.Transaction, uncles []*types.Header, receipts []*types.Receipt) (*types.Block, error) {
	if !p.isPosaHeader(header) {
		return p.pow.FinalizeAndAssemble(chain, header, state, txs, uncles, receipts)
	}
	signer, err := p.poa.Author(header)
	if err != nil {
		p.lock.RLock()
		signer = p.signer
		p.lock.RUnlock()
		if signer == (common.Address{}) {
			// The worker discards this error (commitWork ignores w.commit's
			// return), so without a log here an upgraded node left with --mine
			// and a non-signer etherbase goes silently dead at PosaBlock:
			// eth.mining stays true, no block is ever produced, nothing is
			// written. The lab rehearsal reproduced exactly that. Say so, once a
			// minute rather than once per recommit, and say what to do.
			p.warnNotAuthorized(header.Number.Uint64())
			return nil, errNotAuthorized
		}
	}
	p.finalize(chain, header, state, signer)
	return types.NewBlock(header, txs, nil, receipts, trie.NewStackTrie(nil)), nil
}

// warnNotAuthorized logs the silent-dead-miner condition at most once per
// notAuthorizedLogInterval. It is a diagnostic only; the caller still returns
// errNotAuthorized.
func (p *Posa) warnNotAuthorized(number uint64) {
	p.lock.Lock()
	defer p.lock.Unlock()
	if now := time.Now(); now.Sub(p.lastNotAuthWarn) >= notAuthorizedLogInterval {
		p.lastNotAuthWarn = now
		log.Error("This node has block production enabled but is NOT a Ferminux signer: it will never confirm a block at or after PosaBlock",
			"number", number, "hint", "stop --mine, or set --miner.etherbase to an unlocked signer account")
	}
}

// Seal implements consensus.Engine.
func (p *Posa) Seal(chain consensus.ChainHeaderReader, block *types.Block, results chan<- *types.Block, stop <-chan struct{}) error {
	if p.isPosaHeader(block.Header()) {
		return p.poa.Seal(chain, block, results, stop)
	}
	return p.pow.Seal(chain, block, results, stop)
}

// SealHash implements consensus.Engine.
func (p *Posa) SealHash(header *types.Header) common.Hash {
	if p.isPosaHeader(header) {
		return p.poa.SealHash(header)
	}
	return p.pow.SealHash(header)
}

// CalcDifficulty implements consensus.Engine for the block following parent.
func (p *Posa) CalcDifficulty(chain consensus.ChainHeaderReader, time uint64, parent *types.Header) *big.Int {
	if parent.Number != nil && p.IsPosa(new(big.Int).Add(parent.Number, big1)) {
		return p.poa.CalcDifficulty(chain, time, parent)
	}
	return p.pow.CalcDifficulty(chain, time, parent)
}

// APIs implements consensus.Engine, exposing both engines' namespaces.
func (p *Posa) APIs(chain consensus.ChainHeaderReader) []rpc.API {
	apis := p.pow.APIs(chain)
	if p.poa != nil {
		apis = append(apis, p.poa.APIs(chain)...)
	}
	return apis
}

// Close implements consensus.Engine.
func (p *Posa) Close() error {
	err := p.pow.Close()
	if p.poa != nil {
		if perr := p.poa.Close(); err == nil {
			err = perr
		}
	}
	return err
}

// SetThreads forwards the mining thread count to the proof-of-work engine.
func (p *Posa) SetThreads(threads int) {
	if th, ok := p.pow.(interface{ SetThreads(threads int) }); ok {
		th.SetThreads(threads)
	}
}

// Hashrate implements consensus.PoW by delegation.
func (p *Posa) Hashrate() float64 {
	if pow, ok := p.pow.(consensus.PoW); ok {
		return pow.Hashrate()
	}
	return 0
}
