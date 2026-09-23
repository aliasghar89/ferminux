// Copyright 2026 The Ferminux Network Authors
// Tests for the Ferminux Network consensus rules (ferminux.go).

package powhash

import (
	"math/big"
	"math/rand"
	"testing"

	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/params"
)

func fmxWei(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), big.NewInt(params.Ether))
}

func TestFerminuxBlockReward(t *testing.T) {
	halfFMX := new(big.Int).Div(fmxWei(1), big.NewInt(2))   // 0.5 FMX
	quarterFMX := new(big.Int).Div(fmxWei(1), big.NewInt(4)) // 0.25 FMX
	cases := []struct {
		block  int64
		reward *big.Int
	}{
		// Launch schedule, before the Emission fork.
		{1, fmxWei(6)},
		{FerminuxEmissionForkBlock - 1, fmxWei(6)},
		// Emission fork: base reward drops to 1 FMX at exactly this block.
		{FerminuxEmissionForkBlock, fmxWei(1)},
		{FerminuxEmissionForkBlock + 1, fmxWei(1)},
		{4_499_999, fmxWei(1)},
		// Halvings continue on the original absolute-height boundaries.
		{4_500_000, halfFMX},    // first halving (and PoS transition target)
		{8_999_999, halfFMX},
		{9_000_000, quarterFMX},
	}
	for _, c := range cases {
		got := FerminuxBlockReward(big.NewInt(c.block))
		if got.Cmp(c.reward) != 0 {
			t.Errorf("block %d: reward = %s, want %s", c.block, got, c.reward)
		}
	}
	// Deep eras pay nothing.
	huge := new(big.Int).Mul(big.NewInt(FerminuxHalvingInterval), big.NewInt(64))
	if got := FerminuxBlockReward(huge); got.Sign() != 0 {
		t.Errorf("block %s: reward = %s, want 0", huge, got)
	}
}

// TestFerminuxEmissionCap proves total base PoW emission stays inside the 70M
// non-premine share of the 100M FMX hard cap, even if PoW ran forever.
func TestFerminuxEmissionCap(t *testing.T) {
	// Pre-fork stretch pays the launch reward.
	total := new(big.Int).Mul(fmxWei(6), big.NewInt(FerminuxEmissionForkBlock))

	// Remainder of era 0 pays the reduced base reward.
	total.Add(total, new(big.Int).Mul(fmxWei(1),
		big.NewInt(FerminuxHalvingInterval-FerminuxEmissionForkBlock)))

	// Later eras halve from the reduced base.
	perEra := big.NewInt(FerminuxHalvingInterval)
	for era := int64(1); era <= 63; era++ {
		blockNum := new(big.Int).Mul(big.NewInt(era), perEra)
		blockNum.Add(blockNum, big.NewInt(1)) // first block of the era
		reward := FerminuxBlockReward(blockNum)
		total.Add(total, new(big.Int).Mul(reward, perEra))
	}
	// Geometric series after the fork: ~4.5M + 2.25M + ... -> ~9.1M FMX.
	if total.Cmp(fmxWei(10_000_000)) > 0 {
		t.Fatalf("base emission %s exceeds 10M FMX — reward schedule wrong", total)
	}
	if total.Cmp(fmxWei(9_000_000)) < 0 {
		t.Fatalf("base emission %s unexpectedly low — halving math broken", total)
	}
	// Premine (30M) + base emission must stay far inside the 100M hard cap,
	// leaving ample headroom for Powhash uncle rewards and PoS-era issuance.
	supply := new(big.Int).Add(total, fmxWei(30_000_000))
	if supply.Cmp(fmxWei(41_000_000)) > 0 {
		t.Fatalf("premine + base emission %s exceeds expected ~40M FMX", supply)
	}
}

func ferminuxParent(diff *big.Int, time uint64, uncles bool) *types.Header {
	h := &types.Header{
		Number:     big.NewInt(100),
		Difficulty: new(big.Int).Set(diff),
		Time:       time,
		UncleHash:  types.EmptyUncleHash,
	}
	if uncles {
		h.UncleHash = types.CalcUncleHash([]*types.Header{{Number: big.NewInt(99)}})
	}
	return h
}

func TestFerminuxDifficulty(t *testing.T) {
	d := big.NewInt(0x80000) // 524288, the genesis difficulty
	step := new(big.Int).Div(d, params.DifficultyBoundDivisor) // d/2048 = 256

	cases := []struct {
		desc   string
		dt     uint64
		uncles bool
		want   *big.Int
	}{
		{"fast block (+1)", 1, false, new(big.Int).Add(d, step)},
		{"4s block (+1)", 4, false, new(big.Int).Add(d, step)},
		{"in-band block (0)", 7, false, new(big.Int).Set(d)},
		{"9s block (0)", 9, false, new(big.Int).Set(d)},
		{"slow block (-1)", 10, false, new(big.Int).Sub(d, step)},
		{"very slow block (-4)", 25, false, new(big.Int).Sub(d, new(big.Int).Mul(step, big.NewInt(4)))},
		{"uncle parent 7s (+1)", 7, true, new(big.Int).Add(d, step)},
	}
	for _, c := range cases {
		parent := ferminuxParent(d, 1000, c.uncles)
		got := calcDifficultyFerminux(1000+c.dt, parent)
		if got.Cmp(c.want) != 0 {
			t.Errorf("%s: difficulty = %s, want %s", c.desc, got, c.want)
		}
	}

	// -99 clamp: an absurdly late block must not underflow.
	parent := ferminuxParent(d, 1000, false)
	got := calcDifficultyFerminux(1000+100000, parent)
	want := new(big.Int).Sub(d, new(big.Int).Mul(step, big.NewInt(99)))
	if want.Cmp(params.MinimumDifficulty) < 0 {
		want.Set(params.MinimumDifficulty)
	}
	if got.Cmp(want) != 0 {
		t.Errorf("clamped block: difficulty = %s, want %s", got, want)
	}

	// Minimum difficulty floor.
	parent = ferminuxParent(params.MinimumDifficulty, 1000, false)
	got = calcDifficultyFerminux(1000+60, parent)
	if got.Cmp(params.MinimumDifficulty) != 0 {
		t.Errorf("floor: difficulty = %s, want minimum %s", got, params.MinimumDifficulty)
	}
}

// TestFerminuxDifficultyConvergence simulates a constant-hashrate miner and
// asserts the retuned adjustment settles block times at ~7 seconds.
func TestFerminuxDifficultyConvergence(t *testing.T) {
	rng := rand.New(rand.NewSource(3961))
	const hashrate = 100_000.0 // H/s, arbitrary constant

	diff := new(big.Int).Set(params.MinimumDifficulty)
	var now uint64 = 1_000_000
	var sum float64
	var count int

	const blocks = 60_000
	const warmup = 30_000
	for i := 0; i < blocks; i++ {
		// Exponentially distributed solve time with mean difficulty/hashrate,
		// quantized to whole seconds like real timestamps (minimum 1s).
		mean := float64(diff.Uint64()) / hashrate
		dt := uint64(rng.ExpFloat64()*mean + 0.5)
		if dt < 1 {
			dt = 1
		}
		if i >= warmup {
			sum += float64(dt)
			count++
		}
		parent := ferminuxParent(diff, now, false)
		now += dt
		diff = calcDifficultyFerminux(now, parent)
	}
	avg := sum / float64(count)
	if avg < 6.0 || avg > 8.5 {
		t.Fatalf("average block time %.2fs, want ~7s (6.0–8.5)", avg)
	}
	t.Logf("converged: average block time %.2fs over %d blocks, final difficulty %s (~%.0fx minimum)",
		avg, count, diff, float64(diff.Uint64())/float64(params.MinimumDifficulty.Uint64()))
}
