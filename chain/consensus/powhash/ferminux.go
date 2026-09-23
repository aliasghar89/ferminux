// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).
//
// The Ferminux node client is a dedicated client for the Ferminux Network
// (ChainID 3961). The consensus rules in this file apply UNCONDITIONALLY from
// genesis to every chain this binary runs, which makes it deliberately
// consensus-incompatible with upstream go-ethereum: every Ferminux node must
// run this client, and this client cannot validate any other chain.
//
// NOTE: the Ethash engine here is Ferminux's PRE-AUTHORITY HISTORY, retained so
// nodes can verify blocks below ChainConfig.PosaBlock (160000). It produces no
// blocks today — from that height the authority signer set in consensus/posa
// confirms every block.
//
// Licensed under the GNU Lesser General Public License v3, like upstream.

package powhash

import (
	"errors"
	"math/big"

	"github.com/aliasghar89/ferminux/chain/consensus"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/params"
)

// errPosaBlock is returned when Powhash is asked to prepare or seal a block at
// or after ChainConfig.PosaBlock: from that height blocks are confirmed by the
// Ferminux authority signer set (consensus/posa) and the retired Powhash engine
// must not start.
var errPosaBlock = errors.New("the retired Ethash engine cannot produce blocks at or after the Ferminux authority fork block")

// refusePosa returns errPosaBlock if the chain configuration places `number`
// at or after the proof-of-authority fork. A nil chain (unit tests) or a
// chain without a PosaBlock is always allowed.
func refusePosa(chain consensus.ChainHeaderReader, number *big.Int) error {
	if chain == nil {
		return nil
	}
	if config := chain.Config(); config != nil && config.IsPosa(number) {
		return errPosaBlock
	}
	return nil
}

const (
	// FerminuxHalvingInterval is the block-reward halving period. The first
	// halving lands at block 4,500,000. Consensus is not affected: Ferminux
	// signers are authorised by the on-chain signer set and are never selected
	// by stake.
	FerminuxHalvingInterval = 4_500_000

	// FerminuxEmissionForkBlock activates the reduced base reward (the
	// "Emission" hard fork). Rationale: the launch reward of 6 FMX per ~7s
	// block emits 26.3M FMX/year — 88% annual inflation against the 30M
	// premine, i.e. ~$38k/day of new supply at the launch reference price.
	// No young market absorbs that, and miners must sell to cover power.
	// From this block the base reward is 1 FMX (4.4M FMX/year, ~15%), which
	// still pays miners properly while leaving a market able to breathe.
	//
	// Scheduled ahead of the chain head so every node and miner has time to
	// upgrade. Nodes running an older ferminux-geth will fork off here —
	// upgrading is mandatory.
	FerminuxEmissionForkBlock = 20_000

	// ferminuxDurationLimit retunes the EIP-100 difficulty adjustment from
	// Ferminux's ~13s equilibrium (divisor 9) to ~7s. For exponentially
	// distributed block times with mean T, the +1/0/-1... adjustment
	// balances when e^(-divisor/T) = 1/2, i.e. T = divisor/ln 2, so a
	// divisor of 5 targets T ≈ 7.2 seconds.
	ferminuxDurationLimit = 5
)

var (
	// FerminuxLaunchBlockReward is the reward paid before
	// FerminuxEmissionForkBlock: 6 FMX in wei.
	FerminuxLaunchBlockReward = new(big.Int).Mul(big.NewInt(6), big.NewInt(params.Ether))

	// FerminuxBaseBlockReward is the era-0 reward from the Emission fork
	// onward: 1 FMX in wei. Emission math: ~4.4M FMX in the remainder of
	// era 0, halving every 4,500,000 blocks thereafter, converging to just
	// under 9.2M FMX of total base emission — far inside the 70M non-premine
	// share of the 100M cap, and a far smaller sell-pressure footprint than
	// the launch schedule.
	FerminuxBaseBlockReward = new(big.Int).Mul(big.NewInt(1), big.NewInt(params.Ether))

	ferminuxBigDurationLimit = big.NewInt(ferminuxDurationLimit)
	ferminuxHalvingBig       = big.NewInt(FerminuxHalvingInterval)
	ferminuxForkBig          = big.NewInt(FerminuxEmissionForkBlock)
)

// FerminuxBlockReward returns the mining reward for the block at the given
// height.
//
//	block <  FerminuxEmissionForkBlock : 6 FMX (launch schedule)
//	block >= FerminuxEmissionForkBlock : 1 FMX, halved every
//	                                     FerminuxHalvingInterval blocks
//
// The halving boundaries stay anchored to absolute block height, so the
// first halving still lands at block 4,500,000 and the schedule below it is
// unchanged in shape.
func FerminuxBlockReward(num *big.Int) *big.Int {
	if num.Cmp(ferminuxForkBig) < 0 {
		return new(big.Int).Set(FerminuxLaunchBlockReward)
	}
	era := new(big.Int).Div(num, ferminuxHalvingBig)
	if !era.IsUint64() || era.Uint64() > 60 {
		// Reward has fully decayed below 1 wei.
		return new(big.Int)
	}
	return new(big.Int).Rsh(FerminuxBaseBlockReward, uint(era.Uint64()))
}

// calcDifficultyFerminux is the Ferminux difficulty adjustment algorithm:
// Byzantium (EIP-100) rules retuned for a ~7 second block target, with the
// difficulty bomb removed. This algorithm governs Ferminux's pre-authority
// history only; from block 160000 the authority signer set confirms blocks.
//
//	diff = parent_diff
//	     + parent_diff/2048 * max((2 if parent has uncles else 1) - (time - parent_time)//5, -99)
//
// floored at params.MinimumDifficulty.
func calcDifficultyFerminux(time uint64, parent *types.Header) *big.Int {
	bigTime := new(big.Int).SetUint64(time)
	bigParentTime := new(big.Int).SetUint64(parent.Time)

	// holds intermediate values to make the algo easier to read & audit
	x := new(big.Int)
	y := new(big.Int)

	// (2 if len(parent.uncles) else 1) - (block_timestamp - parent_timestamp) // 5
	x.Sub(bigTime, bigParentTime)
	x.Div(x, ferminuxBigDurationLimit)
	if parent.UncleHash == types.EmptyUncleHash {
		x.Sub(big1, x)
	} else {
		x.Sub(big2, x)
	}
	// max(..., -99)
	if x.Cmp(bigMinus99) < 0 {
		x.Set(bigMinus99)
	}
	// parent_diff + (parent_diff / 2048 * adjustment)
	y.Div(parent.Difficulty, params.DifficultyBoundDivisor)
	x.Mul(y, x)
	x.Add(parent.Difficulty, x)

	// minimum difficulty can ever be (before exponential factor)
	if x.Cmp(params.MinimumDifficulty) < 0 {
		x.Set(params.MinimumDifficulty)
	}
	return x
}
