#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Ferminux DEX UI: end-to-end test on an anvil FORK of chain 3961.
//
// The live contracts, the live WFMX/AZNT pool and its live lock, with a USDF
// market built on top at the official $0.52 (scripts/fork.mjs), driven through
// THE APP'S OWN lib modules:
//
//    routing   every path the local search enumerates is priced by the router
//              too, and the quote always takes the router's best;
//              FMX → USDF goes direct when small and through AZNT when large;
//              three-pool routes (AZNT → FMX → USDF → SEED) execute
//    settle    every swap delivers exactly the quoted amount
//    LP        add at the pool ratio (LP minted as quoted), remove 50% with
//              native FMX out, remove the rest
//    locker    the live pool reads LOCKED, ~100% of LP, until 2027-08-20
//    market    Swap/Sync logs scanned from the factory's deploy block: the
//              live trades and ours, volume, fees, APR, TVL at the $0.52 basis
//    history   the trader's swaps, deposits, withdrawals, wraps and approvals
//
//   npm run e2e:fork          (DEX_TEST_PORT moves anvil off 8602)
//
// Needs anvil (foundry) and network access to rpc.ferminux.net for the fork's
// reads. Nothing is broadcast anywhere: anvil confirms every transaction locally,
// and the accounts that move funds are impersonated, never keyed.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Contract, ContractFactory, Wallet, formatEther, formatUnits, parseEther, parseUnits } from 'ethers';

import { DEX_ADDRESSES, DEX_START_BLOCK, FMX_USD_E18 } from '../src/config.ts';
import { formatAmount, formatPpmPercent } from '../src/lib/amounts.ts';
import { BlockClock, rpcLogSource } from '../src/lib/events.ts';
import { loadAccountActivity } from '../src/lib/history.ts';
import { loadPositions, quoteAddLiquidity, quoteRemoveLiquidity, removeLiquidity, addLiquidity } from '../src/lib/liquidity.ts';
import { loadLockSummary } from '../src/lib/locker.ts';
import { emptyMarket, marketOverview, poolPriceSeries, poolStats, refreshMarket, syncLogs, tradesFrom } from '../src/lib/market.ts';
import { TokenMetaCache, approveLp, buildPairIndex, fetchLpAllowance, fetchLpBalance, loadAllPairs, loadPair } from '../src/lib/pairs.ts';
import { E18, baseTable, poolFmxUsdE18, poolValue, priceTable, valueUsdE18 } from '../src/lib/prices.ts';
import { enumeratePaths, priceRoute, rankRoutes } from '../src/lib/route.ts';
import { executeSwap, planSwap, quoteSwap, unwrapFmx, wrapFmx } from '../src/lib/swap.ts';
import { MAX_UINT256, approveToken, fetchAllowance, fetchBalance } from '../src/lib/tokens.ts';
import { AZNT, LIVE_AZNT_PAIR, USDF, chainNow, forkProvider, fundTrader, haveAnvil, confirmed, seedMarket, startFork } from './fork.mjs';

const PORT = Number(process.env.DEX_TEST_PORT) || 8602;
// anvil's first dev key: public, and on a fork it is just an empty account we fund.
const TRADER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SEED_OUT = fileURLToPath(new URL('../../contracts/out/SeedPool.s.sol/SeedDemoToken.json', import.meta.url));

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}. ${msg}`);

function makeRandom(seedValue) {
  let seed = BigInt(seedValue);
  return (max) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return (seed >> 11n) % max;
  };
}

async function main() {
  if (!haveAnvil()) {
    console.log('e2e-fork SKIPPED: anvil is not on PATH');
    return;
  }
  const fork = await startFork(PORT);
  ok(`anvil forked chain 3961 on 127.0.0.1:${PORT}`);
  let provider;
  try {
    provider = await forkProvider(fork.rpc);
    const A = DEX_ADDRESSES;
    const head0 = await provider.getBlockNumber();

    // ---- the live deployment, as the fork sees it -------------------------------
    const code = await Promise.all([A.factory, A.router, A.wfmx, A.locker, LIVE_AZNT_PAIR].map((a) => provider.getCode(a)));
    assert.ok(code.every((c) => c.length > 2), 'factory, router, WFMX, locker and the live pool all have code on the fork');
    const livePool = await loadPair(provider, LIVE_AZNT_PAIR, new TokenMetaCache(A.wfmx));
    const lock = await loadLockSummary(provider, A, LIVE_AZNT_PAIR, livePool.totalSupply, await chainNow(provider));
    assert.ok(lock.lockedNow > 0n, 'the live WFMX/AZNT pool must read LOCKED');
    assert.ok(lock.lockedPpm >= 999_000n, `≥ 99.9% of its LP must be locked, got ${formatPpmPercent(lock.lockedPpm, 3)}`);
    assert.ok(lock.earliestUnlock >= Date.UTC(2027, 7, 19) / 1000, 'and not before 2027-08-20');
    ok(`live WFMX/AZNT pool: LOCKED ${formatPpmPercent(lock.lockedPpm, 3)} of LP until ${new Date(lock.earliestUnlock * 1000).toISOString().slice(0, 10)} (lock #${lock.active[0].id})`);

    // ---- the $0.52 market ----------------------------------------------------
    const m = await seedMarket(provider);
    const { cache, fmx, usdf, aznt, treasury } = m;
    let pairs = await loadAllPairs(provider, A, cache);
    let index = buildPairIndex(pairs);
    const pegs = baseTable(A.wfmx);
    const usdfPool = pairs.find((p) => p.pair === m.usdfPair);
    const azntPool = pairs.find((p) => p.pair.toLowerCase() === LIVE_AZNT_PAIR.toLowerCase());
    const usdfFmx = poolFmxUsdE18(usdfPool, A.wfmx, pegs);
    const azntFmx = poolFmxUsdE18(azntPool, A.wfmx, pegs);
    const near = (x, y, tolBps) => (x > y ? x - y : y - x) * 10_000n <= y * BigInt(tolBps);
    assert.ok(near(usdfFmx, FMX_USD_E18, m.createdUsdfPool ? 1 : 500), `WFMX/USDF must price FMX at $0.52, got ${formatEther(usdfFmx)}`);
    assert.ok(near(azntFmx, FMX_USD_E18, 50), `WFMX/AZNT must price FMX at $0.52 after the rebalance, got ${formatEther(azntFmx)}`);
    ok(
      `market at $0.52: WFMX/USDF ${m.createdUsdfPool ? 'created' : 'topped up'} at $${Number(formatEther(usdfFmx)).toFixed(4)}; WFMX/AZNT moved ${m.azntPerFmxBefore.toFixed(4)} → ${m.azntPerFmxAfter.toFixed(4)} AZNT/FMX ($${Number(formatEther(azntFmx)).toFixed(4)}); AZNT/USDF at 1.70`,
    );

    // TVL at the stated bases: FMX at the official price, the pegs as the gateway defines them.
    const prices = priceTable(index, pegs);
    const v = poolValue(usdfPool, prices);
    const wIs0 = usdfPool.token0.address.toLowerCase() === A.wfmx.toLowerCase();
    const [rW, rU] = wIs0 ? [usdfPool.reserve0, usdfPool.reserve1] : [usdfPool.reserve1, usdfPool.reserve0];
    assert.equal(v.tvlUsdE18, valueUsdE18(rW, 18, FMX_USD_E18) + valueUsdE18(rU, 6, E18), 'TVL = FMX side at $0.52 + USDF side at $1');
    assert.equal(v.estimated, false);
    ok(`TVL at the $0.52 basis: WFMX/USDF ${formatAmount(v.tvlUsdE18, 18, 2)} USD (both sides valued), WFMX/AZNT ${formatAmount(poolValue(azntPool, prices).tvlUsdE18, 18, 2)} USD`);

    // ---- a trader --------------------------------------------------------------
    const trader = new Wallet(TRADER_KEY, provider);
    await fundTrader(provider, treasury, trader.address, '60000');
    const opts = (extra = {}) => ({ slippageBps: 50, maxHops: 3, ...extra });

    // Every enumerated path, priced locally and by the router: equal to the wei.
    const checkAllPaths = async (tokenIn, tokenOut, amountIn) => {
      const paths = enumeratePaths(index, tokenIn.address, tokenOut.address, { maxHops: 3 });
      const router = new Contract(A.router, ['function getAmountsOut(uint256,address[]) view returns (uint256[])'], provider);
      let best = null;
      for (const path of paths) {
        const local = priceRoute(index, path, amountIn);
        const chain = (await router.getAmountsOut(amountIn, path)).map(BigInt);
        assert.deepEqual(local.amounts, chain, `local math must equal getAmountsOut on ${path.join('→')}`);
        if (!best || chain[chain.length - 1] > best.out) best = { path, out: chain[chain.length - 1] };
      }
      return { paths, best };
    };

    // Small FMX → USDF: the direct pool.
    const small = parseEther('100');
    const s = await checkAllPaths(fmx, usdf, small);
    const q1 = await quoteSwap(provider, A, index, fmx, usdf, small, opts());
    assert.deepEqual(q1.route.path, s.best.path, 'the quote takes the router-best route');
    assert.equal(q1.route.path.length, 2, 'a small FMX → USDF trade goes direct');
    assert.ok(q1.routesConsidered >= 2, 'with the AZNT route also considered');
    const u0 = await fetchBalance(provider, usdf, trader.address);
    await confirmed(executeSwap(trader, A, q1, trader.address, 20, await chainNow(provider)));
    const got1 = (await fetchBalance(provider, usdf, trader.address)) - u0;
    assert.equal(got1, q1.amountOut, 'received exactly the quote');
    assert.ok(Number(formatUnits(got1, 6)) > 100 * 0.52 * 0.99, 'about $0.52 per FMX, less fee and impact');
    ok(`100 FMX → ${formatUnits(got1, 6)} USDF direct (${s.paths.length} paths priced, router-verified), impact ${formatPpmPercent(q1.priceImpactPpm)}`);

    // Large FMX → USDF: find the size where the two-pool route through AZNT pays more, and take it.
    pairs = await loadAllPairs(provider, A, cache);
    index = buildPairIndex(pairs);
    let big = null;
    for (const n of ['2000', '4000', '8000', '12000', '20000']) {
      const amt = parseEther(n);
      const { best } = await checkAllPaths(fmx, usdf, amt);
      if (best.path.length === 3) {
        big = amt;
        break;
      }
    }
    assert.ok(big, 'at some size the route through AZNT must beat the direct pool');
    const q2 = await quoteSwap(provider, A, index, fmx, usdf, big, opts());
    assert.equal(q2.route.path.length, 3);
    assert.equal(q2.route.path[1].toLowerCase(), AZNT.toLowerCase(), 'through AZNT');
    assert.equal(planSwap(q2, 20).method, 'swapExactFMXForTokens');
    assert.ok(q2.alternatives.length >= 1 && q2.alternatives[0].amountOut < q2.amountOut, 'the direct route was re-priced by the router and lost');
    assert.equal(q2.totalFeeBps, 60);
    const u1 = await fetchBalance(provider, usdf, trader.address);
    await confirmed(executeSwap(trader, A, q2, trader.address, 20, await chainNow(provider)));
    const got2 = (await fetchBalance(provider, usdf, trader.address)) - u1;
    assert.equal(got2, q2.amountOut);
    ok(`${formatEther(big)} FMX → ${formatUnits(got2, 6)} USDF multi-hop FMX → AZNT → USDF (beat direct by ${formatUnits(q2.amountOut - q2.alternatives[0].amountOut, 6)} USDF)`);

    // A token only USDF pairs with: three-pool routes.
    const seedArt = JSON.parse(readFileSync(SEED_OUT, 'utf8'));
    const seedC = await new ContractFactory(seedArt.abi, seedArt.bytecode.object, trader).deploy(trader.address, parseEther('1000000'));
    await seedC.waitForDeployment();
    const seed = await cache.get(provider, await seedC.getAddress());
    const seedLiq = parseEther('5000');
    const usdfLiq = parseUnits('500', 6); // 1 SEED = 0.10 USDF
    await confirmed(approveToken(trader, seed, A.router, seedLiq));
    await confirmed(approveToken(trader, usdf, A.router, usdfLiq));
    await confirmed(addLiquidity(trader, A, quoteAddLiquidity(null, seed, usdf, 'A', seedLiq, 50, usdfLiq), trader.address, 20, await chainNow(provider)));
    pairs = await loadAllPairs(provider, A, cache);
    index = buildPairIndex(pairs);
    const fromAznt = await checkAllPaths(aznt, seed, parseUnits('500', 6));
    assert.ok(fromAznt.paths.some((p) => p.length === 4), 'AZNT → SEED has a three-pool candidate (AZNT → FMX → USDF → SEED)');
    const fromFmx = await checkAllPaths(fmx, seed, parseEther('250'));
    const q3 = await quoteSwap(provider, A, index, fmx, seed, parseEther('250'), opts());
    assert.deepEqual(q3.route.path, fromFmx.best.path);
    assert.ok(q3.route.path.length >= 3, 'FMX → SEED needs at least two pools');
    const sd0 = await fetchBalance(provider, seed, trader.address);
    await confirmed(executeSwap(trader, A, q3, trader.address, 20, await chainNow(provider)));
    assert.equal((await fetchBalance(provider, seed, trader.address)) - sd0, q3.amountOut);
    const direct1 = await quoteSwap(provider, A, index, fmx, seed, parseEther('250'), opts({ maxHops: 1 })).catch((e) => e);
    assert.match(String(direct1?.message ?? direct1), /No pool route/, '"direct only" finds no route to SEED');
    ok(`FMX → SEED via ${q3.route.path.length - 1} pools executed as quoted; AZNT → SEED candidates up to 3 pools; "direct only" correctly finds none`);

    // Randomised: local route math vs getAmountsOut over every path, many sizes and pairs.
    pairs = await loadAllPairs(provider, A, cache);
    index = buildPairIndex(pairs);
    const rand = makeRandom(3961);
    const universe = [fmx, usdf, aznt, seed];
    let checkedPaths = 0;
    for (let i = 0; i < 40; i++) {
      const a = universe[Number(rand(4n))];
      let b = universe[Number(rand(4n))];
      if (a.address.toLowerCase() === b.address.toLowerCase()) b = universe[(universe.indexOf(a) + 1) % 4];
      const amt = (rand(1000n) + 1n) * 10n ** BigInt(a.decimals - 1);
      checkedPaths += (await checkAllPaths(a, b, amt)).paths.length;
      const ranked = rankRoutes(index, a.address, b.address, amt, { maxHops: 3 });
      const q = await quoteSwap(provider, A, index, a, b, amt, opts());
      assert.equal(q.amountOut, ranked[0].amountOut, 'nothing moved between reads: the router agrees with the local best');
      assert.equal(q.localMatchesChain, true);
    }
    ok(`40 random trades over FMX/USDF/AZNT/SEED: ${checkedPaths} paths, local amounts equal getAmountsOut to the wei, best route agreed`);

    // Approvals: exact by default; unlimited only when asked.
    const exact = parseUnits('10', 6);
    await confirmed(approveToken(trader, usdf, A.router, exact));
    assert.equal(await fetchAllowance(provider, usdf, trader.address, A.router), exact, 'exact approval = the trade amount');
    await confirmed(approveToken(trader, usdf, A.router, MAX_UINT256));
    assert.equal(await fetchAllowance(provider, usdf, trader.address, A.router), MAX_UINT256, 'unlimited only when chosen');
    await confirmed(approveToken(trader, usdf, A.router, 0n));
    ok('approvals: exact amount, then unlimited, then revoked to 0, each read back');

    // ---- liquidity: add at the ratio, remove 50% to native FMX, remove the rest ---
    pairs = await loadAllPairs(provider, A, cache);
    const pool = pairs.find((p) => p.pair === m.usdfPair);
    const addQ = quoteAddLiquidity(pool, fmx, usdf, 'A', parseEther('1000'), 50);
    assert.equal(addQ.isFirstDeposit, false);
    await confirmed(approveToken(trader, usdf, A.router, addQ.amountB));
    const lp0 = await fetchLpBalance(provider, pool.pair, trader.address);
    await confirmed(addLiquidity(trader, A, addQ, trader.address, 20, await chainNow(provider)));
    const lpGot = (await fetchLpBalance(provider, pool.pair, trader.address)) - lp0;
    assert.equal(lpGot, addQ.lpMinted, 'LP minted exactly as quoted');
    pairs = await loadAllPairs(provider, A, cache);
    const pos = (await loadPositions(provider, pairs, trader.address)).find((p) => p.snapshot.pair === pool.pair);
    assert.ok(pos && pos.lpBalance === lpGot);
    ok(`added 1,000 FMX + ${formatUnits(addQ.amountB, 6)} USDF at the pool ratio: ${formatAmount(lpGot, 18, 6)} LP, ${formatPpmPercent(pos.shareOfPoolPpm, 3)} of the pool`);

    const rq = quoteRemoveLiquidity(pos.snapshot, pos.lpBalance, 50, 50);
    await confirmed(approveLp(trader, pool.pair, A.router, rq.liquidity));
    const fmxB = await provider.getBalance(trader.address);
    const usdB = await fetchBalance(provider, usdf, trader.address);
    const rec = await confirmed(removeLiquidity(trader, A, pos.snapshot, rq, trader.address, 20, { unwrapNative: true, wfmx: A.wfmx, nowSec: await chainNow(provider) }));
    const gas = rec.gasUsed * rec.gasPrice;
    const fmxGot = (await provider.getBalance(trader.address)) - fmxB + gas;
    const usdGot = (await fetchBalance(provider, usdf, trader.address)) - usdB;
    const [e0, e1] = pos.snapshot.token0.address.toLowerCase() === A.wfmx.toLowerCase() ? [rq.amount0, rq.amount1] : [rq.amount1, rq.amount0];
    assert.equal(fmxGot, e0, 'native FMX out, exactly as quoted');
    assert.equal(usdGot, e1, 'USDF out, exactly as quoted');
    pairs = await loadAllPairs(provider, A, cache);
    const pos2 = (await loadPositions(provider, pairs, trader.address)).find((p) => p.snapshot.pair === pool.pair);
    const rq2 = quoteRemoveLiquidity(pos2.snapshot, pos2.lpBalance, 100, 50);
    assert.equal(rq2.liquidity, pos2.lpBalance, '100% burns the exact balance');
    assert.equal(await fetchLpAllowance(provider, pool.pair, trader.address, A.router), 0n, 'the LP approval was used up exactly');
    await confirmed(approveLp(trader, pool.pair, A.router, rq2.liquidity));
    await confirmed(removeLiquidity(trader, A, pos2.snapshot, rq2, trader.address, 20, { unwrapNative: false, wfmx: A.wfmx, nowSec: await chainNow(provider) }));
    assert.equal(await fetchLpBalance(provider, pool.pair, trader.address), 0n);
    ok(`removed 50% (${formatEther(fmxGot)} FMX native + ${formatUnits(usdGot, 6)} USDF, as quoted), then the rest as WFMX + USDF`);

    // Wrap and unwrap, for the history.
    await confirmed(wrapFmx(trader, A, parseEther('2')));
    await confirmed(unwrapFmx(trader, A, parseEther('2')));

    // ---- the market record: logs from the factory's deploy block, live + ours ------
    const head = await provider.getBlockNumber();
    const clock = new BlockClock();
    const source = rpcLogSource(provider);
    const record = await refreshMarket(emptyMarket(), { source, rpc: provider, clock, pairs: pairs.map((p) => p.pair), head, startBlock: DEX_START_BLOCK });
    const byAddr = new Map(pairs.map((p) => [p.pair.toLowerCase(), p]));
    const pricesNow = priceTable(buildPairIndex(pairs), pegs);
    const trades = tradesFrom(record, byAddr, pricesNow, clock);
    const liveTrades = trades.filter((t) => t.pair === LIVE_AZNT_PAIR.toLowerCase() && t.block <= head0);
    assert.ok(liveTrades.length >= 8, `the live pool's history has at least its 8 swaps, read ${liveTrades.length}`);
    assert.ok(liveTrades.every((t) => t.time !== null && t.time > 1_780_000_000), 'with block timestamps');
    const mine = trades.filter((t) => t.block > head0);
    assert.ok(mine.length >= 6, 'and every swap made on the fork');
    const usdfStats = poolStats(byAddr.get(m.usdfPair.toLowerCase()), trades, pricesNow, await chainNow(provider));
    const usdfTrades = trades.filter((t) => t.pair === m.usdfPair.toLowerCase() && t.block > head0);
    const expectVol = usdfTrades.reduce((acc, t) => acc + t.usdE18, 0n);
    assert.equal(usdfStats.volume24hUsdE18, expectVol, '24h volume sums the pool swaps at the USDF side');
    assert.equal(usdfStats.fees24hUsdE18, (expectVol * 30n) / 10_000n, 'fees are 0.30% of volume');
    assert.ok(usdfStats.apr24hPpm > 0n);
    const overview = marketOverview(pairs.map((p) => poolStats(p, trades, pricesNow, 0)), trades);
    assert.ok(overview.tvlUsdE18 > 0n && overview.pricedPools === pairs.length);
    const series = poolPriceSeries(syncLogs(record), byAddr.get(m.usdfPair.toLowerCase()), A.wfmx, clock, E18);
    const lastUsd = series[series.length - 1].v;
    assert.ok(Math.abs(lastUsd - Number(formatEther(poolFmxUsdE18(byAddr.get(m.usdfPair.toLowerCase()), A.wfmx, pegs)))) < 1e-9, 'the chart ends at the pool price');
    ok(`market record: ${record.logs.length} logs, ${liveTrades.length} live + ${mine.length} fork trades; WFMX/USDF 24h volume $${formatAmount(usdfStats.volume24hUsdE18, 18, 2)}, fees $${formatAmount(usdfStats.fees24hUsdE18, 18, 2)}, APR ${(Number(usdfStats.apr24hPpm) / 10_000).toFixed(2)}%; TVL $${formatAmount(overview.tvlUsdE18, 18, 0)}`);

    // Incremental refresh picks up only what is new.
    await confirmed(executeSwap(trader, A, await quoteSwap(provider, A, buildPairIndex(await loadAllPairs(provider, A, cache)), fmx, usdf, parseEther('5'), opts()), trader.address, 20, await chainNow(provider)));
    const head2 = await provider.getBlockNumber();
    const record2 = await refreshMarket(record, { source, rpc: provider, clock, pairs: pairs.map((p) => p.pair), head: head2, startBlock: DEX_START_BLOCK });
    const trades2 = tradesFrom(record2, byAddr, pricesNow, clock);
    assert.equal(trades2.length, trades.length + 1, 'one new swap, no duplicates from the re-read tail');
    ok('incremental refresh added exactly the one new swap');

    // ---- history ----------------------------------------------------------------
    const items = await loadAccountActivity({
      source,
      rpc: provider,
      clock,
      account: trader.address,
      pools: await loadAllPairs(provider, A, cache),
      tokens: [fmx, usdf, aznt, seed],
      wfmx: A.wfmx,
      router: A.router,
      locker: A.locker,
      market: record2,
      fromBlock: DEX_START_BLOCK,
      head: head2,
      txCache: new Map(),
    });
    const kinds = items.reduce((acc, it) => ((acc[it.kind] = (acc[it.kind] ?? 0) + 1), acc), {});
    const swaps = items.filter((i) => i.kind === 'swap');
    assert.ok(swaps.length >= 4, `the trader's swaps: ${swaps.length}`);
    const multi = swaps.find((i) => i.amountIn === q2.amountIn);
    assert.ok(multi, 'the multi-hop swap is in the history');
    assert.equal(multi.tokenIn.symbol, 'FMX', 'native FMX in, recognised from the value sent');
    assert.equal(multi.amountOut, q2.amountOut);
    assert.deepEqual(multi.route, ['FMX', 'AZNT', 'USDF']);
    assert.ok((kinds.add ?? 0) >= 2 && (kinds.remove ?? 0) >= 2, 'deposits and withdrawals');
    const nativeRemove = items.find((i) => i.kind === 'remove' && i.native);
    assert.ok(nativeRemove, 'the removal paid out in native FMX is marked so');
    assert.ok((kinds.wrap ?? 0) === 1 && (kinds.unwrap ?? 0) === 1, 'the wrap and the unwrap');
    assert.ok((kinds.approve ?? 0) >= 4, 'the approvals to the router');
    assert.ok(items.every((i) => i.time !== null), 'every item dated');
    ok(`history: ${items.length} items (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}); the multi-hop swap reads FMX → AZNT → USDF`);
  } finally {
    provider?.destroy();
    await fork.stop();
  }
  ok(`anvil fork stopped; port ${PORT} free again`);
  console.log('\nE2E (fork): all checks passed.');
}

main().catch((err) => {
  console.error('\nE2E (fork) FAILED:', err);
  process.exit(1);
});
