// Unit tests for route selection: the code that decides which pools a swap
// goes through, and therefore what the user is quoted.
//
// Everything here is pure: a hand-built pair index, no chain. The same route
// choices are then exercised against real pools, and every candidate path is
// re-priced by the router's own getAmountsOut, in scripts/e2e.mjs and
// scripts/e2e-fork.mjs.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';

import { buildPairIndex, hopReserves, orientedReserves, pairKey, tokensFromPairs } from '../src/lib/pairs.ts';
import { MAX_HOPS, bestRoute, buildGraph, compareRoutes, enumeratePaths, hasRoute, priceRoute, rankRoutes, routeMidOutput } from '../src/lib/route.ts';
import { getAmountOut } from '../src/lib/math.ts';

const A = '0x1111111111111111111111111111111111111111'; // 18 decimals
const B = '0x2222222222222222222222222222222222222222'; // 6 decimals (AZNT-like)
const W = '0x3333333333333333333333333333333333333333'; // WFMX
const C = '0x4444444444444444444444444444444444444444'; // 6 decimals (USDF-like)
const D = '0x5555555555555555555555555555555555555555'; // 18 decimals

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
const tokenC = token(C, 'CCC', 6);
const tokenD = token(D, 'DDD', 18);

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

test('enumeratePaths walks every pool, not a base list: direct, then two pools, then three', () => {
  const index = buildPairIndex([deepAW, deepBW, shallowAB]);
  const paths = enumeratePaths(index, A, B);
  assert.deepEqual(paths, [
    [A, B],
    [A, W, B],
  ]);
  assert.equal(MAX_HOPS, 3);
  assert.deepEqual(enumeratePaths(index, A, A), [], 'the same token both sides is not a trade');
  assert.deepEqual(enumeratePaths(buildPairIndex([deepAW]), A, B), [], 'no pool reaches B');

  // A→W→C→B needs three pools and no base list knows about C.
  const wc = pool(tokenW, tokenC, parseEther('1000'), parseUnits('1000', 6));
  const bc = pool(tokenB, tokenC, parseUnits('1000', 6), parseUnits('1000', 6));
  const three = buildPairIndex([deepAW, wc, bc]);
  assert.deepEqual(enumeratePaths(three, A, B), [[A, W, C, B]]);
  assert.deepEqual(enumeratePaths(three, A, B, { maxHops: 2 }), [], 'maxHops 2 stops short of it');
  assert.equal(hasRoute(three, A, B), true);
  assert.equal(hasRoute(three, A, B, { maxHops: 1 }), false);
});

test('enumeratePaths never revisits a token, and caps the candidate count shortest first', () => {
  // A fully connected graph of five tokens.
  const toks = [tokenA, tokenB, tokenW, tokenC, tokenD];
  const all = [];
  for (let i = 0; i < toks.length; i++)
    for (let j = i + 1; j < toks.length; j++) all.push(pool(toks[i], toks[j], parseEther('100'), parseEther('100')));
  const index = buildPairIndex(all);
  const paths = enumeratePaths(index, A, B);
  // 1 direct + 3 two-pool + 3·2 three-pool = 10 simple paths up to three pools.
  assert.equal(paths.length, 10);
  for (const p of paths) assert.equal(new Set(p.map((x) => x.toLowerCase())).size, p.length, `no cycle in ${p.join('>')}`);
  for (let i = 1; i < paths.length; i++) assert.ok(paths[i].length >= paths[i - 1].length, 'shortest first');
  const capped = enumeratePaths(index, A, B, { maxPaths: 4 });
  assert.equal(capped.length, 4);
  assert.deepEqual(capped[0], [A, B], 'the cap keeps the direct pool');
});

test('buildGraph ignores pools that were never seeded', () => {
  const graph = buildGraph(buildPairIndex([deepAW, pool(tokenB, tokenW, 0n, 0n)]));
  assert.deepEqual([...(graph.get(W.toLowerCase()) ?? [])], [A.toLowerCase()]);
  assert.equal(graph.has(B.toLowerCase()), false);
});

test('bestRoute takes a three-pool route when it pays more than anything shorter', () => {
  const wc = pool(tokenW, tokenC, parseEther('100000'), parseUnits('100000', 6));
  const bc = pool(tokenB, tokenC, parseUnits('100000', 6), parseUnits('100000', 6));
  const deepAW2 = pool(tokenA, tokenW, parseEther('100000'), parseEther('100000'));
  const index = buildPairIndex([deepAW2, wc, bc, shallowAB]);
  const route = bestRoute(index, A, B, parseEther('5'));
  assert.deepEqual(route.path, [A, W, C, B]);
  assert.equal(route.hops.length, 3);
  const ranked = rankRoutes(index, A, B, parseEther('5'));
  assert.equal(ranked.length, 2);
  assert.ok(ranked[0].amountOut > ranked[1].amountOut, 'ranked best first');
  assert.deepEqual(ranked[1].path, [A, B]);
  // "Direct only" settles for the shallow pool.
  assert.deepEqual(bestRoute(index, A, B, parseEther('5'), { maxHops: 1 }).path, [A, B]);
});

test('compareRoutes: more output, then fewer pools, then the smaller path', () => {
  const r = (path, amountOut) => ({ path, amountOut, hops: [], amounts: [], priceImpactPpm: 0n });
  assert.ok(compareRoutes(r([A, B], 10n), r([A, W, B], 11n)) > 0);
  assert.ok(compareRoutes(r([A, B], 10n), r([A, W, B], 10n)) < 0);
  assert.ok(compareRoutes(r([A, C, B], 10n), r([A, W, B], 10n)) > 0, 'deterministic on a full tie');
});

test('bestRoute takes the two-hop route when the direct pool is too shallow', () => {
  const index = buildPairIndex([deepAW, deepBW, shallowAB]);
  const amountIn = parseEther('5');
  const route = bestRoute(index, A, B, amountIn);
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
  const route = bestRoute(index, A, B, parseEther('5'));
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

  const route = bestRoute(index, A, B, amountIn);
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
  assert.equal(bestRoute(index, A, B, parseEther('1')), null);
  assert.equal(priceRoute(index, [A, B], parseEther('1')), null);
  assert.equal(priceRoute(index, [A], parseEther('1')), null, 'a path needs at least two tokens');
  assert.equal(priceRoute(index, [A, W], 0n), null, 'zero in, nothing out');
  assert.equal(priceRoute(index, [A, W, B, A], parseEther('1')), null, 'a path over a missing pool is refused');
});

test('tokensFromPairs collects every token that has a pool', () => {
  const list = tokensFromPairs([deepAW, deepBW, shallowAB]).map((t) => t.symbol).sort();
  assert.deepEqual(list, ['AAA', 'BBB', 'WFMX']);
});
