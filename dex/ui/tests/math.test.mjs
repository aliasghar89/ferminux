// Unit tests for the AMM math the UI quotes with.
//
// These pin the arithmetic against three independent things:
//   1. the worked example published in dex/contracts/README.md (a 10,000 SEED
//      / 5,000 FMX pool, three trade sizes, with the expected outputs and the
//      expected "total cost vs mid" in basis points);
//   2. hand-computed integer cases small enough to check on paper;
//   3. invariants the pool itself enforces (k never falls, getAmountIn is the
//      exact inverse of getAmountOut, rounding always favours the pool).
//
// The same functions are ALSO checked against the deployed contract's own
// getAmountOut/getAmountIn/quote over 256 randomised inputs in scripts/e2e.mjs
// — that is the authoritative comparison; this file is the fast one.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, formatEther } from 'ethers';

import {
  BPS,
  FEE_BPS,
  PPM,
  deadlineFromNow,
  getAmountIn,
  getAmountOut,
  getAmountsIn,
  getAmountsOut,
  liquidityMinted,
  maximumSold,
  midOutput,
  minimumReceived,
  pooledAmounts,
  priceImpactBps,
  priceImpactPpm,
  quote,
  shareOfPoolPpm,
} from '../src/lib/math.ts';

// The pool from the contracts README: 10,000 SEED and 5,000 FMX.
const SEED_RESERVE = parseEther('10000');
const FMX_RESERVE = parseEther('5000');

test('getAmountOut matches the worked example in dex/contracts/README.md', () => {
  // "Trade size | FMX in | SEED out | Total cost vs mid"
  const rows = [
    { fmxIn: '5', seedOut: '9.9601', bps: 39 },
    { fmxIn: '50', seedOut: '98.7158', bps: 128 },
    { fmxIn: '250', seedOut: '474.8297', bps: 503 },
  ];
  for (const row of rows) {
    const amountIn = parseEther(row.fmxIn);
    const out = getAmountOut(amountIn, FMX_RESERVE, SEED_RESERVE);
    // The README quotes 4 decimal places, rounded.
    assert.equal(
      Number(formatEther(out)).toFixed(4),
      row.seedOut,
      `${row.fmxIn} FMX should buy ${row.seedOut} SEED`,
    );
    const hops = [{ reserveIn: FMX_RESERVE, reserveOut: SEED_RESERVE }];
    assert.equal(priceImpactBps(amountIn, out, hops), row.bps, `${row.fmxIn} FMX should cost ${row.bps} bps vs mid`);
  }
});

test('getAmountOut is the exact Solidity formula on hand-checkable integers', () => {
  // amountInWithFee = 100 * 997 = 99_700
  // numerator       = 99_700 * 1_000 = 99_700_000
  // denominator     = 1_000 * 1_000 + 99_700 = 1_099_700
  // 99_700_000 / 1_099_700 = 90.66… → 90 (floor, in the pool's favour)
  assert.equal(getAmountOut(100n, 1000n, 1000n), 90n);
  // A trade that rounds to nothing yields nothing rather than a fractional wei.
  assert.equal(getAmountOut(1n, parseEther('1000000'), 1n), 0n);
});

test('getAmountIn rounds UP and is the tight inverse of getAmountOut', () => {
  const targets = [1n, 7n, 12345n, parseEther('1'), parseEther('137.5')];
  for (const wanted of targets) {
    const needed = getAmountIn(wanted, FMX_RESERVE, SEED_RESERVE);
    assert.ok(getAmountOut(needed, FMX_RESERVE, SEED_RESERVE) >= wanted, 'the computed input must actually suffice');
    if (needed > 1n) {
      assert.ok(
        getAmountOut(needed - 1n, FMX_RESERVE, SEED_RESERVE) < wanted,
        'one wei less must NOT suffice — otherwise the round-up is too generous',
      );
    }
  }
});

test('every swap leaves k at least where it was', () => {
  let reserveIn = FMX_RESERVE;
  let reserveOut = SEED_RESERVE;
  for (const size of ['0.001', '1', '17.5', '400']) {
    const amountIn = parseEther(size);
    const kBefore = reserveIn * reserveOut;
    const amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
    reserveIn += amountIn;
    reserveOut -= amountOut;
    assert.ok(reserveIn * reserveOut >= kBefore, `k fell on a ${size} trade`);
  }
});

test('quote is the fee-free add-liquidity ratio', () => {
  // 1 FMX pairs with 2 SEED in a 5,000 / 10,000 pool — no 0.30% anywhere.
  assert.equal(quote(parseEther('1'), FMX_RESERVE, SEED_RESERVE), parseEther('2'));
  assert.notEqual(quote(parseEther('1'), FMX_RESERVE, SEED_RESERVE), getAmountOut(parseEther('1'), FMX_RESERVE, SEED_RESERVE));
});

test('rejections match the contract require strings', () => {
  assert.throws(() => getAmountOut(0n, 1n, 1n), /insufficient input amount/);
  assert.throws(() => getAmountOut(1n, 0n, 1n), /insufficient liquidity/);
  assert.throws(() => getAmountIn(0n, 1n, 1n), /insufficient output amount/);
  assert.throws(() => getAmountIn(10n, 1n, 10n), /insufficient liquidity/, 'cannot buy the entire reserve');
  assert.throws(() => quote(0n, 1n, 1n), /insufficient amount/);
  assert.throws(() => getAmountsOut(1n, []), /invalid path/);
});

test('multi-hop chains the fee: two hops cost about twice one hop', () => {
  const hops = [
    { reserveIn: FMX_RESERVE, reserveOut: SEED_RESERVE },
    { reserveIn: SEED_RESERVE, reserveOut: FMX_RESERVE },
  ];
  const amountIn = parseEther('1');
  const amounts = getAmountsOut(amountIn, hops);
  assert.equal(amounts.length, 3);
  assert.equal(amounts[0], amountIn);
  assert.equal(amounts[1], getAmountOut(amountIn, FMX_RESERVE, SEED_RESERVE));
  assert.equal(amounts[2], getAmountOut(amounts[1], SEED_RESERVE, FMX_RESERVE));

  // Round trip through two mirrored pools: you get back ~1 − 2×0.30% − impact.
  const bps = priceImpactBps(amountIn, amounts[2], hops);
  assert.ok(bps >= 2 * FEE_BPS, `two hops must cost at least ${2 * FEE_BPS} bps, got ${bps}`);
  assert.ok(bps < 2 * FEE_BPS + 5, `a tiny trade should cost barely more than the fees, got ${bps}`);
});

test('getAmountsIn walks the route backwards and agrees with getAmountsOut', () => {
  const hops = [
    { reserveIn: FMX_RESERVE, reserveOut: SEED_RESERVE },
    { reserveIn: SEED_RESERVE, reserveOut: FMX_RESERVE },
  ];
  const wanted = parseEther('0.5');
  const amounts = getAmountsIn(wanted, hops);
  assert.equal(amounts.length, 3);
  assert.equal(amounts[2], wanted);
  const forward = getAmountsOut(amounts[0], hops);
  assert.ok(forward[2] >= wanted, 'spending the computed input must deliver at least the requested output');
});

test('midOutput is the zero-fee reference and never truncates per hop', () => {
  const hops = [
    { reserveIn: FMX_RESERVE, reserveOut: SEED_RESERVE },
    { reserveIn: SEED_RESERVE, reserveOut: FMX_RESERVE },
  ];
  // 1 FMX → 2 SEED → 1 FMX at the mid price, exactly, with no rounding loss.
  assert.equal(midOutput(parseEther('1'), hops), parseEther('1'));
  assert.equal(midOutput(parseEther('1'), [hops[0]]), parseEther('2'));
});

test('price impact is measured against the mid price and includes the fee', () => {
  const hops = [{ reserveIn: FMX_RESERVE, reserveOut: SEED_RESERVE }];
  const dust = parseEther('0.000001'); // depth is irrelevant at this size
  const out = getAmountOut(dust, FMX_RESERVE, SEED_RESERVE);
  const ppm = priceImpactPpm(dust, out, hops);
  // A trade of nothing still gives up the 0.30% fee: 3,000 ppm = 30 bps.
  assert.ok(ppm >= 2_990n && ppm <= 3_010n, `dust trade impact should be ~3000 ppm, got ${ppm}`);

  // At single-wei sizes the pool's floor division dominates: 1,000 wei in
  // yields 1,993 rather than 1,994, which reads as 500 ppm of extra impact.
  // That is real — it is the pool rounding in its own favour — and the UI must
  // not pretend otherwise.
  assert.equal(getAmountOut(1000n, FMX_RESERVE, SEED_RESERVE), 1993n);
  assert.equal(priceImpactPpm(1000n, 1993n, hops), 3_500n);

  // Impact rises monotonically with size.
  let previous = -1n;
  for (const size of ['1', '10', '100', '1000']) {
    const amountIn = parseEther(size);
    const value = priceImpactPpm(amountIn, getAmountOut(amountIn, FMX_RESERVE, SEED_RESERVE), hops);
    assert.ok(value > previous, `impact must grow with size (${size})`);
    previous = value;
  }
  assert.equal(priceImpactPpm(parseEther('1'), parseEther('99999'), hops), 0n, 'never reports a negative impact');
});

test('minimumReceived and maximumSold bound the trade in the right direction', () => {
  const out = parseEther('100');
  assert.equal(minimumReceived(out, 0), out);
  assert.equal(minimumReceived(out, 50), parseEther('99.5')); // 0.5%
  assert.equal(minimumReceived(out, 100), parseEther('99')); // 1.0%
  assert.ok(minimumReceived(out, 10) < out);

  const input = parseEther('100');
  assert.equal(maximumSold(input, 50), parseEther('100.5'));
  assert.ok(maximumSold(input, 10) > input);
  // Rounds UP so the bound is never tighter than the tolerance asked for.
  assert.equal(maximumSold(3n, 1), 4n);
  assert.equal(minimumReceived(3n, 1), 2n);

  assert.throws(() => minimumReceived(out, -1), /basis points/);
  assert.throws(() => minimumReceived(out, 10_000), /basis points/);
  assert.equal(Number(BPS), 10_000);
});

test('slippage bound is exactly what gets sent to the router', () => {
  // A 1.0% tolerance on a 474.8297 SEED quote is 470.0814… SEED, floored.
  const out = getAmountOut(parseEther('250'), FMX_RESERVE, SEED_RESERVE);
  const min = minimumReceived(out, 100);
  assert.equal(min, (out * 9900n) / 10_000n);
  assert.ok(min < out);
  assert.equal(formatEther(min).slice(0, 8), '470.0814');
});

test('deadlineFromNow is unix seconds in the future', () => {
  assert.equal(deadlineFromNow(20, 1_000_000), 1_001_200n);
  assert.equal(deadlineFromNow(0.5, 1_000_000), 1_000_030n);
  assert.throws(() => deadlineFromNow(0, 1_000_000), /positive/);
});

test('LP share, pooled amounts and minting follow FerminuxPair', () => {
  const totalSupply = parseEther('1000');
  assert.equal(shareOfPoolPpm(parseEther('250'), totalSupply), 250_000n); // 25%
  assert.equal(shareOfPoolPpm(0n, 0n), 0n);
  assert.equal(Number(PPM), 1_000_000);

  const [a, b] = pooledAmounts(parseEther('250'), totalSupply, SEED_RESERVE, FMX_RESERVE);
  assert.equal(a, parseEther('2500'));
  assert.equal(b, parseEther('1250'));

  // min(amount0 * supply / reserve0, amount1 * supply / reserve1)
  assert.equal(liquidityMinted(parseEther('1000'), parseEther('500'), SEED_RESERVE, FMX_RESERVE, totalSupply), parseEther('100'));
  // A lopsided deposit mints on the SHORT side — the excess is a donation.
  assert.equal(liquidityMinted(parseEther('1000'), parseEther('5000'), SEED_RESERVE, FMX_RESERVE, totalSupply), parseEther('100'));
  assert.throws(() => liquidityMinted(1n, 1n, 0n, 0n, 0n), /first deposit sets the price/);
});

test('fuzz: 2,000 random trades keep every invariant', () => {
  // Deterministic PRNG so a failure is reproducible.
  let seed = 3961n;
  const rand = (max) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return (seed >> 11n) % max;
  };
  for (let i = 0; i < 2000; i++) {
    const reserveIn = rand(parseEther('1000000')) + parseEther('0.001');
    const reserveOut = rand(parseEther('1000000')) + parseEther('0.001');
    const amountIn = rand(reserveIn) + 1n;
    const amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
    assert.ok(amountOut < reserveOut, 'a swap can never drain the output reserve');
    assert.ok(
      (reserveIn + amountIn) * (reserveOut - amountOut) >= reserveIn * reserveOut,
      'k must not fall',
    );
    if (amountOut > 0n) {
      const needed = getAmountIn(amountOut, reserveIn, reserveOut);
      assert.ok(needed <= amountIn + 1n, 'the inverse must not ask for materially more than was paid');
      const ppm = priceImpactPpm(amountIn, amountOut, [{ reserveIn, reserveOut }]);
      assert.ok(ppm >= 0n && ppm <= PPM, `impact out of range: ${ppm}`);
      assert.ok(minimumReceived(amountOut, 50) <= amountOut);
    }
  }
});
