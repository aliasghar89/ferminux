// Unit tests for route selection — the code that decides which pools a swap
// goes through, and therefore what the user is quoted.
//
// Everything here is pure: a hand-built pair index, no chain. The same route
// choices are then exercised against real pools in scripts/e2e.mjs.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';

import { buildPairIndex, hopReserves, orientedReserves, pairKey, tokensFromPairs } from '../src/lib/pairs.ts';
import { bestRoute, candidatePaths, priceRoute, routeMidOutput, MAX_HOPS } from '../src/lib/route.ts';
import { getAmountOut } from '../src/lib/math.ts';

const A = '0x1111111111111111111111111111111111111111'; // 18 decimals
const B = '0x2222222222222222222222222222222222222222'; // 6 decimals (AZNT-like)
const W = '0x3333333333333333333333333333333333333333'; // WFMX

const token = (address, symbol, decimals) => ({ kind: 'erc20', address, symbol, name: symbol, decimals });

/** Pools are stored token0 < token1 by address, exactly as the factory does. */
function pool(token0, token1, reserve0, reserve1, totalSupply = parseEther('1000')) {
  return {
    pair: `0x${'ab'.repeat(20)}`,
    token0,
    token1,
    reserve0,
    reserve1,
    totalSupply,
    blockTimestampLast: 0,
  };
}

const tokenA = token(A, 'AAA', 18);
const tokenB = token(B, 'BBB', 6);
const tokenW = token(W, 'WFMX', 18);

const deepAW = pool(tokenA, tokenW, parseEther('1000'), parseEther('1000'));
const deepBW = pool(tokenB, tokenW, parseUnits('1000', 6), parseEther('1000'));
const shallowAB = pool(tokenA, tokenB, parseEther('10'), parseUnits('10', 6));

test('pairKey is order-independent and matches the contracts sort', () => {
  assert.equal(pairKey(A, B), pairKey(B, A));
  assert.equal(pairKey(A, B), `${A.toLowerCase()}/${B.toLowerCase()}`);
});

test('hopReserves orients the reserves in the direction of the trade', () => {
  const index = buildPairIndex([pool(tokenA, tokenW, parseEther('7'), parseEther('11'))]);
  assert.deepEqual(hopReserves(index, A, W), { reserveIn: parseEther('7'), reserveOut: parseEther('11') });
  assert.deepEqual(hopReserves(index, W, A), { reserveIn: parseEther('11'), reserveOut: parseEther('7') });
  assert.equal(hopReserves(index, A, B), null, 'a pool that does not exist has no reserves');

  const empty = buildPairIndex([pool(tokenA, tokenW, 0n, 0n)]);
  assert.equal(hopReserves(empty, A, W), null, 'an unseeded pool is not routable');

  assert.deepEqual(orientedReserves(deepBW, W), { own: parseEther('1000'), other: parseUnits('1000', 6) });
});

test('candidatePaths offers the direct pool and one hop through a base', () => {
  const index = buildPairIndex([deepAW, deepBW, shallowAB]);
  const paths = candidatePaths(index, A, B, [W]);
  assert.deepEqual(paths, [
    [A, B],
    [A, W, B],
  ]);
  assert.equal(paths.every((p) => p.length <= MAX_HOPS + 1), true);

  // Same token both sides is not a trade.
  assert.deepEqual(candidatePaths(index, A, A, [W]), []);
  // A base with no pool on one leg is not offered.
  assert.deepEqual(candidatePaths(buildPairIndex([deepAW]), A, B, [W]), []);
});

test('bestRoute takes the two-hop route when the direct pool is too shallow', () => {
  const index = buildPairIndex([deepAW, deepBW, shallowAB]);
  const amountIn = parseEther('5');
  const route = bestRoute(index, A, B, amountIn, [W]);
  assert.ok(route);
  assert.deepEqual(route.path, [A, W, B], 'should hop through WFMX');
  assert.equal(route.hops.length, 2);
  assert.equal(route.amounts.length, 3);
  assert.equal(route.amounts[0], amountIn);
  assert.equal(route.amountOut, route.amounts[2]);

  const direct = priceRoute(index, [A, B], amountIn);
  assert.ok(direct.amountOut < route.amountOut, 'the direct pool must actually be worse here');
});

test('bestRoute takes the direct pool when it is the deeper one', () => {
  const deepAB = pool(tokenA, tokenB, parseEther('100000'), parseUnits('100000', 6));
  const index = buildPairIndex([deepAW, deepBW, deepAB]);
  const route = bestRoute(index, A, B, parseEther('5'), [W]);
  assert.deepEqual(route.path, [A, B]);
  assert.equal(route.hops.length, 1);
});

test('a genuine tie goes to the shorter path', () => {
  // BBB has 6 decimals, so outputs are coarse: at this size the extra 0.30%
  // of the second hop disappears into the same floored unit and both routes
  // quote exactly 100 base units. The rule is then "fewer pools wins".
  const directAB = pool(tokenA, tokenB, parseEther('1000'), parseUnits('1000', 6));
  const index = buildPairIndex([directAB, deepAW, deepBW]);
  const amountIn = 101_200_000_000_000n;

  const direct = priceRoute(index, [A, B], amountIn);
  const viaW = priceRoute(index, [A, W, B], amountIn);
  assert.equal(direct.amountOut, 100n);
  assert.equal(viaW.amountOut, 100n, 'the two routes must really tie for this test to mean anything');

  const route = bestRoute(index, A, B, amountIn, [W]);
  assert.deepEqual(route.path, [A, B]);
});

test('route amounts equal the chained pool math, hop by hop', () => {
  const index = buildPairIndex([deepAW, deepBW]);
  const amountIn = parseEther('12.5');
  const route = priceRoute(index, [A, W, B], amountIn);
  const first = getAmountOut(amountIn, parseEther('1000'), parseEther('1000'));
  const second = getAmountOut(first, parseEther('1000'), parseUnits('1000', 6));
  assert.equal(route.amounts[1], first);
  assert.equal(route.amountOut, second);

  // Mid-price reference ignores the fee, so it is strictly better than the fill.
  assert.ok(routeMidOutput(route, amountIn) > route.amountOut);
  // Two hops of 0.30% put the impact above 60 bps even at this size.
  assert.ok(route.priceImpactPpm > 6_000n, `expected > 6000 ppm, got ${route.priceImpactPpm}`);
});

test('unroutable requests return null rather than a wrong number', () => {
  const index = buildPairIndex([deepAW]);
  assert.equal(bestRoute(index, A, B, parseEther('1'), [W]), null);
  assert.equal(priceRoute(index, [A, B], parseEther('1')), null);
  assert.equal(priceRoute(index, [A], parseEther('1')), null, 'a path needs at least two tokens');
  assert.equal(priceRoute(index, [A, W], 0n), null, 'zero in, nothing out');
  assert.equal(priceRoute(index, [A, W, B, A], parseEther('1')), null, 'longer than MAX_HOPS is refused');
});

test('tokensFromPairs collects every token that has a pool', () => {
  const list = tokensFromPairs([deepAW, deepBW, shallowAB]).map((t) => t.symbol).sort();
  assert.deepEqual(list, ['AAA', 'BBB', 'WFMX']);
});
