// Swapping on the Ferminux DEX from the wallet: the AMM math against the
// Solidity formulas, route finding (direct, two and three pools, only trusted
// tokens in between, best output wins), price impact, the minimum received,
// the calls that get signed (method, value, path, recipient, spender, chain),
// the one-batch pre-check against a fake chain that answers like the factory,
// the pairs, the tokens and the router, and the decision it feeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, MaxUint256, getAddress, parseEther } from 'ethers';
import {
  DEX,
  METHOD_SIGNATURE,
  SWAP_CHAIN_ID,
  allowanceShortfall,
  bestRoute,
  buildApproveCall,
  buildSwapCall,
  buildWrapCall,
  candidatePaths,
  deadlineFrom,
  decodeSwapCall,
  formatImpactPpm,
  formatPercentBps,
  formatRate,
  getAmountIn,
  getAmountOut,
  getAmountsOut,
  hopOf,
  impactLevel,
  indexPools,
  midOutput,
  minimumReceived,
  offeredTokens,
  pairKey,
  parseDeadlineMinutes,
  parseSlippagePercent,
  parseSwapSettings,
  poolAddress,
  pooledTokens,
  priceImpactPpm,
  priceRoute,
  readPools,
  readSwapPreflight,
  receivedFromLogs,
  routeBases,
  serializeSwapSettings,
  slippageNote,
  spotOutput,
  swapKind,
  swapMethodFor,
  swapProblem,
  tokenKey,
} from '../src/lib/swap.ts';
import { TOKENS } from '../../shared/tokens.ts';

const WFMX = getAddress(DEX.wfmx);
const USDF = getAddress('0xCd032A609e34121D1881E8DE7355b2c2c7092363');
const AZNT = getAddress('0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178');
const XTOK = getAddress('0x1111111111111111111111111111111111111111');
const YTOK = getAddress('0x2222222222222222222222222222222222222222');
const ZTOK = getAddress('0x3333333333333333333333333333333333333333');
const ME = getAddress('0xc0A5Eb613f859f072554F29f1Ab7400265af15aB');

const FMX_T = { address: null, symbol: 'FMX', name: 'Ferminux', decimals: 18 };
const WFMX_T = { address: WFMX, symbol: 'WFMX', name: 'Wrapped FMX', decimals: 18 };
const USDF_T = { address: USDF, symbol: 'USDF', name: 'Ferminux Dollar', decimals: 6 };
const AZNT_T = { address: AZNT, symbol: 'AZNT', name: 'Ferminux Manat', decimals: 6 };

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
let pairSeq = 0xa0;
const pairAddr = () => getAddress('0x' + (pairSeq++).toString(16).padStart(2, '0').repeat(20));

/** A pool as the pair stores it: tokens sorted by address. */
function pool(a, b, ra, rb) {
  const [token0, token1, reserve0, reserve1] = a.toLowerCase() < b.toLowerCase() ? [a, b, ra, rb] : [b, a, rb, ra];
  return { pair: pairAddr(), token0, token1, reserve0, reserve1 };
}

/* ------------------------------------------------------------------ */
/* Deployment facts                                                    */
/* ------------------------------------------------------------------ */

test('the router, factory and WFMX are the deployed ones (DeployDex broadcast) and WFMX is the registry’s', () => {
  const run = JSON.parse(readFileSync(new URL('../../dex/contracts/broadcast/DeployDex.s.sol/3961/run-latest.json', import.meta.url), 'utf8'));
  const deployed = Object.fromEntries(run.transactions.filter((t) => t.contractName).map((t) => [t.contractName, t.contractAddress.toLowerCase()]));
  assert.equal(DEX.router.toLowerCase(), deployed.FerminuxRouter);
  assert.equal(DEX.factory.toLowerCase(), deployed.FerminuxFactory);
  assert.equal(DEX.wfmx.toLowerCase(), deployed.WFMX);
  assert.equal(TOKENS.find((t) => t.symbol === 'WFMX').address, WFMX);
  assert.equal(getAddress(DEX.router), DEX.router, 'checksummed');
  assert.equal(SWAP_CHAIN_ID, 3961);
});

test('route bases are WFMX and the first-party tokens only', () => {
  const bases = routeBases().map((a) => a.toLowerCase());
  assert.equal(bases[0], WFMX.toLowerCase());
  assert.deepEqual(new Set(bases), new Set(TOKENS.filter((t) => t.firstParty).map((t) => t.address.toLowerCase())));
});

/* ------------------------------------------------------------------ */
/* AMM math                                                            */
/* ------------------------------------------------------------------ */

test('getAmountOut / getAmountIn match the Solidity formulas, rounding in favour of the pool', () => {
  // 1 WFMX into 138,767.184 WFMX / 45,100 AZNT (the live pool shape)
  const rIn = 138767184453857319492643n;
  const rOut = 45100000000n;
  const out = getAmountOut(E18, rIn, rOut);
  assert.equal(out, (E18 * 997n * rOut) / (rIn * 1000n + E18 * 997n));
  assert.equal(out, 324027n); // 0.324027 AZNT: rounded down
  const need = getAmountIn(out, rIn, rOut);
  assert.equal(need, (rIn * out * 1000n) / ((rOut - out) * 997n) + 1n);
  assert.ok(need <= E18 && getAmountOut(need, rIn, rOut) >= out, 'the input for that output never exceeds what produced it');
  // classic vector: 1000/1000 pool, 10 in → 9 out (9.87… rounded down)
  assert.equal(getAmountOut(10n, 1000n, 1000n), 9n);
  assert.equal(getAmountIn(9n, 1000n, 1000n), 10n);
  assert.throws(() => getAmountOut(0n, 1n, 1n), /insufficient input/);
  assert.throws(() => getAmountOut(1n, 0n, 1n), /insufficient liquidity/);
  assert.throws(() => getAmountIn(1000n, 1000n, 1000n), /insufficient liquidity/);
});

test('getAmountsOut chains hops exactly as the library does', () => {
  const hops = [
    { reserveIn: 1_000_000n * E6, reserveOut: 1_923_076n * E18 },
    { reserveIn: 138_767n * E18, reserveOut: 45_100n * E6 },
  ];
  const a = getAmountsOut(100n * E6, hops);
  assert.equal(a.length, 3);
  assert.equal(a[1], getAmountOut(100n * E6, hops[0].reserveIn, hops[0].reserveOut));
  assert.equal(a[2], getAmountOut(a[1], hops[1].reserveIn, hops[1].reserveOut));
  assert.throws(() => getAmountsOut(1n, []), /invalid path/);
});

test('minimumReceived rounds down and refuses a nonsense tolerance', () => {
  assert.equal(minimumReceived(1000n, 50), 995n);
  assert.equal(minimumReceived(999n, 50), 994n); // 994.005 → 994
  assert.equal(minimumReceived(10n ** 30n, 1), (10n ** 30n * 9999n) / 10000n);
  assert.equal(minimumReceived(5n, 0), 5n);
  assert.throws(() => minimumReceived(1n, 10000), /slippage/);
  assert.throws(() => minimumReceived(1n, -1), /slippage/);
  assert.throws(() => minimumReceived(1n, 0.5), /slippage/);
});

test('price impact excludes the pool fee: a tiny trade is ~0, a big one matches the closed form', () => {
  const hop = [{ reserveIn: 1_000_000n * E18, reserveOut: 520_000n * E6 }];
  const tiny = E18;
  const tinyOut = getAmountOut(tiny, hop[0].reserveIn, hop[0].reserveOut);
  assert.ok(priceImpactPpm(tiny, tinyOut, hop) < 10n, 'one FMX in a million-FMX pool moves nothing');
  // single hop: out/spot = R_in·1000 / (R_in·1000 + 997·x) → impact = 997x / (1000R + 997x)
  const x = 100_000n * E18;
  const out = getAmountOut(x, hop[0].reserveIn, hop[0].reserveOut);
  const ppm = priceImpactPpm(x, out, hop);
  const closed = (997n * x * 1_000_000n) / (hop[0].reserveIn * 1000n + 997n * x);
  assert.ok(ppm >= closed - 2n && ppm <= closed + 2n, `${ppm} vs ${closed}`);
  assert.equal(impactLevel(Number(ppm / 100n)), 'warn'); // ~9.07 %
  assert.equal(impactLevel(299), 'ok');
  assert.equal(impactLevel(300), 'warn');
  assert.equal(impactLevel(1000), 'severe');
  // spot includes the fee, mid does not
  assert.equal(spotOutput(E18, hop), (E18 * 520_000n * E6 * 997n) / (1_000_000n * E18 * 1000n));
  assert.equal(midOutput(E18, hop), 520_000n);
  assert.equal(formatImpactPpm(0n), '0%');
  assert.equal(formatImpactPpm(50n), '<0.01%');
  assert.equal(formatImpactPpm(90_700n), '9.07%');
});

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

// FMX at $0.52 in the USDF pool, the AZNT pool at 0.325 AZNT per FMX (as on chain 3961), a USDF/AZNT pool at the
// gateway's 1.70 AZN per USD, a user token X paired with WFMX, Y paired with AZNT, Z paired with X only.
function market() {
  return [
    pool(WFMX, USDF, 192_307_692n * E18 / 1000n, 100_000n * E6),
    pool(WFMX, AZNT, 138_767n * E18, 45_100n * E6),
    pool(USDF, AZNT, 10_000n * E6, 17_000n * E6),
    pool(WFMX, XTOK, 50_000n * E18, 1_000_000n * E18),
    pool(AZNT, YTOK, 1_000n * E6, 5_000n * E18),
    pool(XTOK, ZTOK, 1_000n * E18, 1_000n * E18),
  ];
}

test('the pool index orients hops and ignores empty pools', () => {
  const idx = indexPools([...market(), pool(USDF, YTOK, 0n, 0n)]);
  const h = hopOf(idx, USDF, WFMX);
  assert.equal(h.reserveIn, 100_000n * E6);
  assert.equal(h.reserveOut, 192_307_692n * E18 / 1000n);
  assert.equal(hopOf(idx, WFMX, USDF).reserveIn, 192_307_692n * E18 / 1000n);
  assert.equal(hopOf(idx, USDF, YTOK), null, 'an empty pool is no route');
  assert.equal(pairKey(USDF, WFMX), pairKey(WFMX, USDF));
  const pooled = pooledTokens(idx);
  assert.ok(pooled.has(XTOK.toLowerCase()) && pooled.has(ZTOK.toLowerCase()));
});

test('the picker offers FMX, WFMX and the listed tokens always, an added token only once it has a pool', () => {
  const assets = [
    { address: null, symbol: 'FMX', source: 'native' },
    { address: WFMX, symbol: 'WFMX', source: 'listed' },
    { address: USDF, symbol: 'USDF', source: 'listed' },
    { address: XTOK, symbol: 'XTK', source: 'custom' },
    { address: getAddress('0x4444444444444444444444444444444444444444'), symbol: 'NOPOOL', source: 'custom' },
  ];
  const pooled = pooledTokens(indexPools(market()));
  assert.deepEqual(offeredTokens(assets, pooled).map((a) => a.symbol), ['FMX', 'WFMX', 'USDF', 'XTK']);
  assert.deepEqual(offeredTokens(assets, null).map((a) => a.symbol), ['FMX', 'WFMX', 'USDF'], 'added tokens wait for the pools');
  assert.deepEqual(offeredTokens(assets, pooledTokens(indexPools([]))).map((a) => a.symbol), ['FMX', 'WFMX', 'USDF'], 'listed tokens stay without a pool');
});

test('candidate paths: direct first, then one or two trusted tokens between, never more than three pools', () => {
  const idx = indexPools(market());
  const paths = candidatePaths(idx, WFMX, USDF).map((p) => p.map((a) => a.toLowerCase()));
  assert.deepEqual(paths[0], [WFMX, USDF].map((a) => a.toLowerCase()), 'the direct pool comes first');
  assert.ok(paths.some((p) => p.join() === [WFMX, AZNT, USDF].join().toLowerCase()));
  assert.ok(paths.every((p) => p.length <= 4));
  // X → Y needs X/WFMX, WFMX/AZNT, AZNT/Y: three pools, both middles first-party
  const xy = candidatePaths(idx, XTOK, YTOK);
  assert.ok(xy.some((p) => p.join() === [XTOK, WFMX, AZNT, YTOK].join()), JSON.stringify(xy));
  assert.ok(xy.every((p) => p.length === 4 || p.length === 3));
  // Z only pairs with X, and X is not a trusted middle: Z has no route to anything but X
  assert.deepEqual(candidatePaths(idx, ZTOK, WFMX), []);
  assert.deepEqual(candidatePaths(idx, ZTOK, XTOK).map((p) => p.length), [2]);
  assert.deepEqual(candidatePaths(idx, USDF, USDF), []);
  // no token twice
  for (const p of candidatePaths(idx, USDF, AZNT)) assert.equal(new Set(p.map((a) => a.toLowerCase())).size, p.length);
});

test('best route pays the most, whichever length it is; a tie goes to the shorter path', () => {
  const idx = indexPools(market());
  // AZNT → USDF: direct pays 1/1.70 USDF per AZNT; via WFMX pays ~1.60 (the AZNT pool prices FMX low)
  const amt = 100n * E6;
  const r = bestRoute(idx, AZNT, USDF, amt);
  assert.deepEqual(r.path, [AZNT, WFMX, USDF]);
  const direct = priceRoute(idx, [AZNT, USDF], amt);
  assert.ok(r.amountOut > direct.amountOut, `${r.amountOut} > ${direct.amountOut}`);
  assert.equal(r.amountOut, getAmountsOut(amt, r.hops)[2]);
  // USDF → AZNT the other way round: the direct pool wins
  assert.deepEqual(bestRoute(idx, USDF, AZNT, amt).path, [USDF, AZNT]);
  // FMX (as WFMX) → USDF at $0.52: 1,000 FMX ≈ 515.8 USDF after the 0.3% fee and ~0.5% impact
  const fmx = bestRoute(idx, poolAddress(FMX_T), USDF, 1000n * E18);
  assert.deepEqual(fmx.path, [WFMX, USDF]);
  assert.ok(fmx.amountOut > 515n * E6 && fmx.amountOut < 517n * E6, String(fmx.amountOut));
  // tie: two identical routes of different length → the shorter one
  const tie = indexPools([pool(XTOK, YTOK, 1000n, 1000n)]);
  assert.deepEqual(bestRoute(tie, XTOK, YTOK, 10n).path, [XTOK, YTOK]);
  // nothing routes → null; dust that pays out zero → null
  assert.equal(bestRoute(idx, ZTOK, USDF, E18), null);
  assert.equal(priceRoute(indexPools([pool(XTOK, YTOK, 10n ** 30n, 1n)]), [XTOK, YTOK], 1n), null);
});

test('a three-pool route is priced hop by hop and its impact compounds', () => {
  const idx = indexPools(market());
  const r = bestRoute(idx, XTOK, YTOK, 1_000n * E18);
  assert.equal(r.path.length, 4);
  assert.equal(r.hops.length, 3);
  assert.deepEqual(r.amounts, getAmountsOut(1_000n * E18, r.hops));
  assert.equal(r.priceImpactPpm, priceImpactPpm(1_000n * E18, r.amountOut, r.hops));
});

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

test('FMX ⇄ WFMX is a wrap, not a swap', () => {
  assert.equal(swapKind(FMX_T, WFMX_T), 'wrap');
  assert.equal(swapKind(WFMX_T, FMX_T), 'unwrap');
  assert.equal(swapKind(FMX_T, USDF_T), 'swap');
  assert.equal(swapKind(WFMX_T, USDF_T), 'swap');
  assert.equal(swapKind(USDF_T, USDF_T), null);
  assert.equal(tokenKey(FMX_T), 'native');
  assert.equal(tokenKey(USDF_T), USDF.toLowerCase());
  assert.equal(poolAddress(FMX_T), WFMX);
});

const router = new Interface([
  'function swapExactFMXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForFMX(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);

test('the swap call: the right router method, the FMX attached only when selling FMX, the recipient always the signer', () => {
  const base = { amountIn: 1000n * E18, amountOutMin: 500n * E6, recipient: ME.toLowerCase(), deadline: 1_790_000_000n, chainId: 3961 };
  const a = buildSwapCall({ ...base, tokenIn: FMX_T, tokenOut: USDF_T, path: [WFMX, USDF] });
  assert.equal(a.to, DEX.router);
  assert.equal(a.value, 1000n * E18);
  assert.equal(a.swapMethod, 'swapExactFMXForTokens');
  assert.equal(a.method, METHOD_SIGNATURE.swapExactFMXForTokens);
  const pa = router.parseTransaction({ data: a.data });
  assert.equal(pa.name, 'swapExactFMXForTokens');
  assert.deepEqual([...pa.args[1]], [WFMX, USDF]);
  assert.equal(pa.args[2], ME);
  assert.equal(pa.args[0], 500n * E6);

  const b = buildSwapCall({ ...base, amountIn: 100n * E6, amountOutMin: 150n * E18, tokenIn: USDF_T, tokenOut: FMX_T, path: [USDF, WFMX] });
  assert.equal(b.value, 0n);
  assert.equal(b.swapMethod, 'swapExactTokensForFMX');
  const pb = router.parseTransaction({ data: b.data });
  assert.equal(pb.args[0], 100n * E6);
  assert.deepEqual([...pb.args[2]], [USDF, WFMX]);

  const c = buildSwapCall({ ...base, amountIn: 100n * E6, amountOutMin: 1n, tokenIn: USDF_T, tokenOut: AZNT_T, path: [USDF, WFMX, AZNT] });
  assert.equal(c.swapMethod, 'swapExactTokensForTokens');
  assert.equal(c.value, 0n);
  const dc = decodeSwapCall(c.data);
  assert.deepEqual(dc, { method: 'swapExactTokensForTokens', amountIn: 100n * E6, amountOutMin: 1n, path: [USDF, WFMX, AZNT], to: ME, deadline: 1_790_000_000n });
  assert.equal(decodeSwapCall(a.data).amountIn, null);
  assert.equal(decodeSwapCall('0xdeadbeef'), null);

  assert.equal(swapMethodFor(FMX_T, USDF_T), 'swapExactFMXForTokens');
  assert.equal(swapMethodFor(AZNT_T, FMX_T), 'swapExactTokensForFMX');
  assert.equal(swapMethodFor(WFMX_T, AZNT_T), 'swapExactTokensForTokens', 'WFMX is sold as a token, not as FMX');
});

test('the swap call refuses another chain, a path that does not match the tokens, a zero minimum and a wrap', () => {
  const base = { amountIn: E18, amountOutMin: 1n, recipient: ME, deadline: 1n, tokenIn: FMX_T, tokenOut: USDF_T, path: [WFMX, USDF] };
  assert.throws(() => buildSwapCall({ ...base, chainId: 1 }), /chain 3961/);
  assert.throws(() => buildSwapCall({ ...base, chainId: 3961, path: [AZNT, USDF] }), /start and end/);
  assert.throws(() => buildSwapCall({ ...base, chainId: 3961, path: [WFMX, AZNT] }), /start and end/);
  assert.throws(() => buildSwapCall({ ...base, chainId: 3961, path: [WFMX, XTOK, YTOK, ZTOK, USDF] }), /two to four/);
  assert.throws(() => buildSwapCall({ ...base, chainId: 3961, amountOutMin: 0n }), /above zero/);
  assert.throws(() => buildSwapCall({ ...base, chainId: 3961, tokenOut: WFMX_T, path: [WFMX, WFMX] }), /wrap/);
});

test('the approval: approve(ROUTER, exactly the amount) by default; unlimited only when chosen', () => {
  const erc20 = new Interface(['function approve(address spender, uint256 amount)']);
  const exact = buildApproveCall(USDF_T, 250n * E6, 'exact', 3961);
  assert.equal(exact.to, USDF);
  assert.equal(exact.value, 0n);
  assert.equal(exact.method, 'approve(address,uint256)');
  const pe = erc20.parseTransaction({ data: exact.data });
  assert.equal(pe.args[0], DEX.router);
  assert.equal(pe.args[1], 250n * E6);
  assert.equal(exact.amount, 250n * E6);
  const unl = buildApproveCall(USDF_T, 250n * E6, 'unlimited', 3961);
  assert.equal(erc20.parseTransaction({ data: unl.data }).args[1], MaxUint256);
  assert.throws(() => buildApproveCall(FMX_T, 1n, 'exact', 3961), /no approval/);
  assert.throws(() => buildApproveCall(USDF_T, 1n, 'exact', 56), /chain 3961/);
  assert.throws(() => buildApproveCall(USDF_T, 0n, 'exact', 3961), /Nothing/);
});

test('wrap and unwrap are deposit() and withdraw(amount) on WFMX', () => {
  const w = buildWrapCall('wrap', 5n * E18, 3961);
  assert.equal(w.to, WFMX);
  assert.equal(w.value, 5n * E18);
  assert.equal(w.data, '0xd0e30db0');
  assert.equal(w.method, 'deposit()');
  const u = buildWrapCall('unwrap', 5n * E18, 3961);
  assert.equal(u.value, 0n);
  assert.equal(u.data, new Interface(['function withdraw(uint256)']).encodeFunctionData('withdraw', [5n * E18]));
  assert.throws(() => buildWrapCall('wrap', 1n, 10), /chain 3961/);
});

/* ------------------------------------------------------------------ */
/* A fake chain: factory, pairs, tokens, router                        */
/* ------------------------------------------------------------------ */

const factoryAbi = new Interface(['function getPair(address,address) view returns (address)']);
const pairAbi = new Interface(['function getReserves() view returns (uint112,uint112,uint32)']);
const tokenAbi = new Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const routerAbi = new Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
const revert = (id) => ({ id, error: { code: 3, message: 'execution reverted: LIB: pair does not exist' } });

function fakeChain({ pools = market(), balances = {}, allowances = {}, native = parseEther('100'), blockTime = 1_790_000_000, seen = [], drop = [] } = {}) {
  const byPair = new Map(pools.map((p) => [p.pair.toLowerCase(), p]));
  const idx = indexPools(pools);
  return async (calls) => {
    seen.push(calls);
    const out = [];
    for (const c of calls) {
      if (drop.includes(c.id)) continue;
      if (c.method === 'eth_getBalance') out.push({ id: c.id, result: '0x' + native.toString(16) });
      else if (c.method === 'eth_getBlockByNumber') out.push({ id: c.id, result: { number: '0x65', timestamp: '0x' + blockTime.toString(16) } });
      else if (c.method === 'eth_call') {
        const { to, data } = c.params[0];
        const t = to.toLowerCase();
        if (t === DEX.factory.toLowerCase()) {
          const [a, b] = factoryAbi.decodeFunctionData('getPair', data);
          const p = idx.get(pairKey(a, b));
          out.push({ id: c.id, result: factoryAbi.encodeFunctionResult('getPair', [p ? p.pair : '0x' + '0'.repeat(40)]) });
        } else if (byPair.has(t)) {
          const p = byPair.get(t);
          out.push({ id: c.id, result: pairAbi.encodeFunctionResult('getReserves', [p.reserve0, p.reserve1, 0]) });
        } else if (t === DEX.router.toLowerCase()) {
          const [amt, path] = routerAbi.decodeFunctionData('getAmountsOut', data);
          const r = priceRoute(idx, [...path], BigInt(amt));
          out.push(r ? { id: c.id, result: routerAbi.encodeFunctionResult('getAmountsOut', [r.amounts]) } : revert(c.id));
        } else {
          const sel = data.slice(0, 10);
          if (sel === tokenAbi.getFunction('balanceOf').selector) out.push({ id: c.id, result: tokenAbi.encodeFunctionResult('balanceOf', [balances[t] ?? 0n]) });
          else out.push({ id: c.id, result: tokenAbi.encodeFunctionResult('allowance', [allowances[t] ?? 0n]) });
        }
      }
    }
    return out;
  };
}

test('readPools: getPair for every routable combination, then the reserves, in two batches', async () => {
  const seen = [];
  const pools = await readPools(fakeChain({ seen }), [USDF, AZNT, XTOK, YTOK, ZTOK]);
  assert.equal(seen.length, 2, 'two round trips');
  assert.equal(pools.length, 6);
  const idx = indexPools(pools);
  const wu = idx.get(pairKey(WFMX, USDF));
  assert.equal(wu.token0.toLowerCase() < wu.token1.toLowerCase(), true, 'token0 is the lower address');
  assert.equal(hopOf(idx, WFMX, USDF).reserveOut, 100_000n * E6);
  // nothing exists → one round trip, empty
  const none = [];
  assert.deepEqual(await readPools(fakeChain({ pools: [], seen: none }), [USDF]), []);
  assert.equal(none.length, 1);
  // an endpoint that answers nothing is an error, not "no pools"
  await assert.rejects(readPools(async () => [], [USDF]), /did not answer/);
});

test('readPools batches at most 100 calls per request', async () => {
  const seen = [];
  const many = Array.from({ length: 30 }, (_, i) => getAddress('0x' + (0x40 + i).toString(16).padStart(2, '0').repeat(20)));
  await readPools(fakeChain({ pools: [], seen }), many);
  assert.ok(seen.every((b) => b.length <= 100));
  // with more than 12 user tokens, only pairs against a trusted token are looked up
  const lookups = seen.flat().length;
  assert.equal(lookups, (3 * 30) + 3, `${lookups}`); // 30 tokens × 3 bases + the 3 base pairs
});

test('the pre-check reads block, balances, allowance and the router quote in one batch', async () => {
  const seen = [];
  const chain = fakeChain({ seen, balances: { [USDF.toLowerCase()]: 500n * E6 }, allowances: { [USDF.toLowerCase()]: 100n * E6 } });
  const pf = await readSwapPreflight(chain, { holder: ME, tokenIn: USDF_T, amountIn: 200n * E6, path: [USDF, WFMX, AZNT] });
  assert.equal(seen.length, 1);
  assert.equal(pf.blockTime, 1_790_000_000);
  assert.equal(pf.balanceIn, 500n * E6);
  assert.equal(pf.allowance, 100n * E6);
  assert.equal(pf.nativeBalance, parseEther('100'));
  assert.equal(pf.amounts.length, 3);
  assert.equal(allowanceShortfall(pf, 200n * E6), 100n * E6);
  assert.equal(allowanceShortfall(pf, 50n * E6), 0n);

  // FMX in: no token reads, no allowance
  const fmx = await readSwapPreflight(fakeChain(), { holder: ME, tokenIn: FMX_T, amountIn: E18, path: [WFMX, USDF] });
  assert.equal(fmx.allowance, null);
  assert.equal(fmx.balanceIn, fmx.nativeBalance);
  assert.equal(allowanceShortfall(fmx, E18), 0n);

  // a route the router cannot price → amounts null (a decision, not an error)
  const gone = await readSwapPreflight(fakeChain({ pools: [] }), { holder: ME, tokenIn: FMX_T, amountIn: E18, path: [WFMX, USDF] });
  assert.equal(gone.amounts, null);

  // wrap: balances only
  const wrap = await readSwapPreflight(fakeChain(), { holder: ME, tokenIn: WFMX_T, amountIn: E18, path: null, wrap: true });
  assert.equal(wrap.allowance, null);
  assert.equal(wrap.amounts, null);

  // a missing answer is a failure, never "enough"
  await assert.rejects(readSwapPreflight(fakeChain({ drop: [2] }), { holder: ME, tokenIn: FMX_T, amountIn: E18, path: [WFMX, USDF] }), /did not answer/);
  await assert.rejects(readSwapPreflight(fakeChain({ drop: [4] }), { holder: ME, tokenIn: USDF_T, amountIn: E18, path: [USDF, WFMX] }), /did not answer/);
  await assert.rejects(readSwapPreflight(fakeChain({ drop: [5] }), { holder: ME, tokenIn: USDF_T, amountIn: E18, path: [USDF, WFMX] }), /did not answer/);
});

test('the decision: short balance, no FMX for the fee, a gone route, a price that moved past the minimum, an expired deadline', async () => {
  const pf = (over = {}) => ({ blockNumber: 1, blockTime: 1000, nativeBalance: parseEther('10'), balanceIn: 100n * E6, allowance: 100n * E6, amounts: [100n * E6, 50n * E18], ...over });
  assert.equal(swapProblem(USDF_T, FMX_T, 100n * E6, pf()), null);
  assert.equal(swapProblem(USDF_T, FMX_T, 101n * E6, pf()).code, 'funds');
  assert.match(swapProblem(USDF_T, FMX_T, 101n * E6, pf()).message, /holds 100 USDF, less than the 101 USDF to swap/);
  assert.equal(swapProblem(USDF_T, FMX_T, 1n, pf({ nativeBalance: 0n }), { feeWei: 1n }).code, 'gas');
  // FMX in: amount + fee must fit
  const fmxPf = pf({ balanceIn: parseEther('10'), allowance: null, amounts: [parseEther('10'), 5n * E6] });
  assert.equal(swapProblem(FMX_T, USDF_T, parseEther('10'), fmxPf), null);
  assert.equal(swapProblem(FMX_T, USDF_T, parseEther('10'), fmxPf, { feeWei: 1n }).code, 'gas');
  assert.match(swapProblem(FMX_T, USDF_T, parseEther('10'), fmxPf, { feeWei: 1n }).message, /Use Max/);
  assert.equal(swapProblem(USDF_T, FMX_T, 1n, pf({ amounts: null })).code, 'no-route');
  const moved = swapProblem(USDF_T, FMX_T, 100n * E6, pf(), { amountOutMin: 51n * E18 });
  assert.equal(moved.code, 'moved');
  assert.match(moved.message, /would now pay 50 FMX, below your minimum of 51 FMX\. Nothing was signed/);
  assert.equal(swapProblem(USDF_T, FMX_T, 100n * E6, pf(), { amountOutMin: 50n * E18 }), null);
  assert.equal(swapProblem(USDF_T, FMX_T, 100n * E6, pf(), { deadline: 1029n }).code, 'expired');
  assert.equal(swapProblem(USDF_T, FMX_T, 100n * E6, pf(), { deadline: 1031n }), null);
  // a wrap never asks about routes or deadlines
  assert.equal(swapProblem(FMX_T, WFMX_T, parseEther('1'), fmxPf, { wrap: true, feeWei: 1n }), null);
  assert.equal(deadlineFrom(1000, 20), 2200n);
});

/* ------------------------------------------------------------------ */
/* Settings, receipts, display                                         */
/* ------------------------------------------------------------------ */

test('settings: defaults, per-field validation, round trip', () => {
  assert.deepEqual(parseSwapSettings(null), { slippageBps: 50, deadlineMin: 20, approval: 'exact' });
  assert.deepEqual(parseSwapSettings('not json'), { slippageBps: 50, deadlineMin: 20, approval: 'exact' });
  assert.deepEqual(parseSwapSettings('{"slippageBps":100,"deadlineMin":5,"approval":"unlimited"}'), { slippageBps: 100, deadlineMin: 5, approval: 'unlimited' });
  assert.deepEqual(parseSwapSettings('{"slippageBps":9999,"deadlineMin":0,"approval":"all"}'), { slippageBps: 50, deadlineMin: 20, approval: 'exact' });
  const s = { slippageBps: 25, deadlineMin: 30, approval: 'exact' };
  assert.deepEqual(parseSwapSettings(serializeSwapSettings(s)), s);

  assert.deepEqual(parseSlippagePercent('0.5'), { ok: true, bps: 50 });
  assert.deepEqual(parseSlippagePercent('.5'), { ok: true, bps: 50 });
  assert.deepEqual(parseSlippagePercent('1%'), { ok: true, bps: 100 });
  assert.deepEqual(parseSlippagePercent('0.01'), { ok: true, bps: 1 });
  assert.deepEqual(parseSlippagePercent('50'), { ok: true, bps: 5000 });
  assert.equal(parseSlippagePercent('51').ok, false);
  assert.equal(parseSlippagePercent('0').ok, false);
  assert.equal(parseSlippagePercent('0.001').ok, false);
  assert.equal(parseSlippagePercent('abc').ok, false);
  assert.deepEqual(parseDeadlineMinutes('20'), { ok: true, minutes: 20 });
  assert.equal(parseDeadlineMinutes('0').ok, false);
  assert.equal(parseDeadlineMinutes('181').ok, false);
  assert.equal(parseDeadlineMinutes('2.5').ok, false);
  assert.equal(slippageNote(50), null);
  assert.match(slippageNote(500), /bot/);
  assert.match(slippageNote(1), /reverts/);
  assert.equal(formatPercentBps(50), '0.5%');
  assert.equal(formatPercentBps(100), '1%');
  assert.equal(formatPercentBps(1234), '12.34%');
});

test('what was received is read from the last pool’s Swap event', () => {
  const ev = new Interface(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)']);
  const P1 = getAddress('0x' + 'b1'.repeat(20));
  const P2 = getAddress('0x' + 'b2'.repeat(20));
  const log = (pair, a0o, a1o) => {
    const e = ev.encodeEventLog('Swap', [DEX.router, 1n, 0n, a0o, a1o, ME]);
    return { address: pair, topics: e.topics, data: e.data };
  };
  const transfer = { address: USDF, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], data: AbiCoder.defaultAbiCoder().encode(['uint256'], [7n]) };
  const logs = [transfer, log(P1, 0n, 123n), log(P2, 456n, 0n)];
  assert.equal(receivedFromLogs(logs, P2), 456n);
  assert.equal(receivedFromLogs(logs, P1), 123n);
  assert.equal(receivedFromLogs(logs, getAddress('0x' + 'b3'.repeat(20))), null);
});

test('rates read naturally in both directions and at any size', () => {
  assert.equal(formatRate(E18, 18, 520000n, 6), '0.52');
  assert.equal(formatRate(520000n, 6, E18, 18), '1.923');
  assert.equal(formatRate(1000n * E18, 18, 518_391_234n, 6), '0.518391');
  assert.equal(formatRate(E6, 6, 1_700_000n * E18, 18), '1,700,000');
  assert.equal(formatRate(E18, 18, 3n, 6), '0.000003');
  assert.equal(formatRate(0n, 18, 1n, 6), '—');
});
