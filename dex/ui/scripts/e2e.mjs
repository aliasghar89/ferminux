#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Ferminux DEX UI — end-to-end data-layer test.
//
// Spawns a throwaway anvil on port 8602 (chain-id 3961), deploys the REAL AMM
// from ../contracts' forge artifacts (WFMX → factory → router → locker), plus
// two real tokens (SEED, 18 decimals, and the live AZNT contract, 6 decimals),
// seeds pools, and then drives THE APP'S OWN lib modules — the same files the
// UI imports in production — through the whole product:
//
//    1. port 8602 free, anvil up, RPC fallback + health probe
//    2. config ships with EMPTY DEX addresses (nothing is guessed)
//    3. deploy the AMM from ../contracts artifacts
//    4. seed two FMX pools through the app's addLiquidity path
//    5. read every pair back through the app's pool loader
//    6. quote a swap: local route vs the router's own getAmountsOut
//    7. 256 randomised inputs: app math vs the contract's getAmountOut /
//       getAmountIn / quote, asserted equal to the wei
//    8. execute a native-FMX swap and verify the received amount
//    9. approve + execute a two-hop token→token swap through WFMX
//   10. execute a token→FMX swap
//   11. slippage bound and deadline are really enforced by the router
//   12. price-impact thresholds (ok / warn / severe)
//   13. add liquidity to a live pool; LP minted matches the quote exactly
//   14. positions: share of pool and pooled amounts
//   15. remove 50% of a position, unwrapping WFMX back to FMX
//   16. LiquidityLocker: lock LP, read the badge, mature it, read it again
//   17. create a brand-new pair and set its opening price (first depositor)
//   18. wrap / unwrap FMX ⇄ WFMX
//   19. anvil down, port free again
//
// Usage: npm run e2e
// Requires: anvil (foundry) on PATH and a `forge build` in ../contracts.
// Never touches a public chain — everything happens on 127.0.0.1:8602.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Contract, ContractFactory, Wallet, formatEther, formatUnits, parseEther, parseUnits } from 'ethers';

// ---- the production data layer under test, imported unchanged --------------
import { CHAIN_ID, missingAddresses } from '../src/config.ts';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';
import { formatAmount, formatPpmPercent, priceFromReserves } from '../src/lib/amounts.ts';
import {
  getAmountIn,
  getAmountOut,
  minimumReceived,
  pooledAmounts,
  priceImpactPpm,
  quote as quoteRatio,
  shareOfPoolPpm,
} from '../src/lib/math.ts';
import {
  TokenMetaCache,
  buildPairIndex,
  fetchLpAllowance,
  fetchLpBalance,
  fetchPairCount,
  findPair,
  hopReserves,
  loadAllPairs,
  loadPair,
  approveLp,
} from '../src/lib/pairs.ts';
import { bestRoute } from '../src/lib/route.ts';
import {
  allowanceShortfall,
  executeSwap,
  impactLevel,
  planSwap,
  quoteSwap,
  unwrapFmx,
  wrapFmx,
} from '../src/lib/swap.ts';
import {
  addLiquidity,
  createPair,
  loadPositions,
  quoteAddLiquidity,
  quoteRemoveLiquidity,
  removeLiquidity,
} from '../src/lib/liquidity.ts';
import { loadLockSummary, loadLockSummaries, loadOwnerLocks, lockState } from '../src/lib/locker.ts';
import { approveToken, fetchBalance, nativeToken, wfmxToken } from '../src/lib/tokens.ts';

const PORT = 8602;
const RPC = `http://127.0.0.1:${PORT}`;
// Well-known anvil dev keys (public test keys).
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const DEX_OUT = (name, contract = name) =>
  fileURLToPath(new URL(`../../contracts/out/${name}.sol/${contract}.json`, import.meta.url));
const CORE_OUT = (name) => fileURLToPath(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url));

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)}. ${msg}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      sock.destroy();
      resolve(free);
    };
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
    setTimeout(() => done(true), 1500);
  });
}

async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    if (await probeRpc(RPC, CHAIN_ID, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil did not become ready on port ${PORT}`);
}

async function deploy(artifactPath, signer, args = []) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return { address: await contract.getAddress(), abi: artifact.abi, contract };
}

/** Deterministic PRNG so a failing fuzz case can be reproduced. */
function makeRandom(seedValue) {
  let seed = BigInt(seedValue);
  return (max) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return (seed >> 11n) % max;
  };
}

async function chainNow(provider) {
  return (await provider.getBlock('latest')).timestamp;
}

async function main() {
  assert.equal(CHAIN_ID, 3961, 'config CHAIN_ID must be 3961');
  assert.equal(await portFree(PORT), true, `port ${PORT} must be free before the test`);
  ok(`port ${PORT} is free`);

  // --balance 100000: the seeded pools hold 15,000 FMX between them, more than
  // anvil's default 10,000 per account.
  const anvil = spawn(
    'anvil',
    ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--balance', '100000', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let anvilErr = '';
  anvil.stderr.on('data', (d) => (anvilErr += d));
  const anvilExit = new Promise((resolve) => anvil.once('exit', resolve));

  try {
    await waitForAnvil();
    ok(`anvil up on :${PORT} (chain-id ${CHAIN_ID})`);

    // --- 1. RPC fallback: the first endpoint is dead ---
    const { provider, url } = await connectRpc(['http://127.0.0.1:9', RPC], CHAIN_ID, 1500);
    assert.equal(url, RPC);
    provider.pollingInterval = 100;
    ok('connectRpc skipped the dead endpoint and health-probed the live one');

    // --- 2. the shipped config is complete ---
    // Since the 2026-08-20 mainnet deployment the defaults carry the four live
    // contract addresses; every one must be a well-formed 0x address (a
    // half-configured ship — some set, some blank — is the state this guards
    // against). Blank overrides still produce the "Not configured" screen,
    // which ui-check exercises with an explicitly blanked build.
    const missing = missingAddresses();
    assert.equal(missing.length, 0, `config must ship fully configured, still missing: ${missing.join(', ')}`);
    ok('src/config.ts ships with factory/router/WFMX/locker all set to well-formed addresses');

    // --- 3. deploy the AMM from ../contracts artifacts ---
    const deployer = new Wallet(KEY0, provider);
    const wfmx = await deploy(DEX_OUT('WFMX'), deployer);
    const factory = await deploy(DEX_OUT('FerminuxFactory'), deployer, [deployer.address]);
    const router = await deploy(DEX_OUT('FerminuxRouter'), deployer, [factory.address, wfmx.address]);
    const locker = await deploy(DEX_OUT('LiquidityLocker'), deployer);
    const addresses = {
      factory: factory.address,
      router: router.address,
      wfmx: wfmx.address,
      locker: locker.address,
    };
    ok(`deployed WFMX ${wfmx.address.slice(0, 10)}… factory ${factory.address.slice(0, 10)}… router ${router.address.slice(0, 10)}… locker ${locker.address.slice(0, 10)}…`);

    // Two real tokens: SEED (18 decimals) and the live AZNT contract (6).
    const seed = await deploy(DEX_OUT('SeedPool.s', 'SeedDemoToken'), deployer, [deployer.address, parseEther('1000000')]);
    const aznt = await deploy(CORE_OUT('AZNT'), deployer, [deployer.address]);
    const azntAdmin = new Contract(aznt.address, aznt.abi, deployer);
    await (await azntAdmin.grantRole(await azntAdmin.MINTER(), deployer.address)).wait();
    await (await azntAdmin.mint(deployer.address, parseUnits('500000', 6))).wait();
    ok('deployed SEED (18 decimals) and AZNT (6 decimals) and minted the deployer a balance');

    const cache = new TokenMetaCache(addresses.wfmx);
    const seedToken = await cache.get(provider, seed.address);
    const azntToken = await cache.get(provider, aznt.address);
    const fmx = nativeToken(addresses.wfmx);
    const wrapped = wfmxToken(addresses.wfmx);
    assert.equal(seedToken.symbol, 'SEED');
    assert.equal(seedToken.decimals, 18);
    assert.equal(azntToken.symbol, 'AZNT');
    assert.equal(azntToken.decimals, 6, 'AZNT must be read as a 6-decimal token');
    ok('token metadata read through the app cache: SEED (18) and AZNT (6)');

    // --- 4. seed two pools through the app's own addLiquidity path ---
    await (await approveToken(deployer, seedToken, addresses.router, parseEther('100000'))).wait();
    await (await approveToken(deployer, azntToken, addresses.router, parseUnits('100000', 6))).wait();

    // SEED/FMX at 0.5 FMX per SEED: 10,000 SEED + 5,000 FMX (the README pool).
    const seedQuote = quoteAddLiquidity(null, seedToken, fmx, 'A', parseEther('10000'), 50, parseEther('5000'));
    assert.equal(seedQuote.isFirstDeposit, true);
    assert.equal(seedQuote.amountAMin, seedQuote.amountA, 'a first deposit pins its mins to the exact amounts');
    await (await addLiquidity(deployer, addresses, seedQuote, deployer.address, 20)).wait();

    // AZNT/FMX at 2 AZNT per FMX: 20,000 AZNT + 10,000 FMX.
    const azntQuote = quoteAddLiquidity(null, azntToken, fmx, 'A', parseUnits('20000', 6), 50, parseEther('10000'));
    await (await addLiquidity(deployer, addresses, azntQuote, deployer.address, 20)).wait();
    ok('seeded SEED/FMX (10,000 SEED + 5,000 FMX) and AZNT/FMX (20,000 AZNT + 10,000 FMX) via lib/liquidity.ts');

    // --- 5. read the registry back ---
    assert.equal(await fetchPairCount(provider, addresses), 2);
    let pairs = await loadAllPairs(provider, addresses, cache);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].pair, await findPair(provider, addresses, azntToken.address, addresses.wfmx), 'newest pair first');
    let index = buildPairIndex(pairs);
    const seedPool = pairs.find((p) => [p.token0.symbol, p.token1.symbol].includes('SEED'));
    const seedHop = hopReserves(index, addresses.wfmx, seedToken.address);
    assert.equal(seedHop.reserveIn, parseEther('5000'));
    assert.equal(seedHop.reserveOut, parseEther('10000'));
    assert.equal(
      priceFromReserves(seedHop.reserveIn, 18, seedHop.reserveOut, 18),
      '2',
      '1 FMX must price at 2 SEED',
    );
    ok(`loadAllPairs read ${pairs.length} pools with reserves, LP supply and both tokens' metadata`);

    // --- 6. quote a swap: local route vs the router's own getAmountsOut ---
    const routerRead = new Contract(addresses.router, router.abi, provider);
    const fiveFmx = parseEther('5');
    const q1 = await quoteSwap(provider, addresses, index, fmx, seedToken, fiveFmx, {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    assert.deepEqual(q1.route.path, [addresses.wfmx, seedToken.address]);
    assert.equal(q1.localMatchesChain, true, 'the locally chosen route must price identically on chain');
    const chainAmounts = await routerRead.getAmountsOut(fiveFmx, q1.route.path);
    assert.equal(q1.amountOut, chainAmounts[1]);
    assert.equal(Number(formatEther(q1.amountOut)).toFixed(4), '9.9601', 'matches the contracts README worked example');
    assert.equal(q1.priceImpactBps, 39, 'and its published 39 bps total cost vs mid');
    assert.equal(q1.minimumReceived, minimumReceived(q1.amountOut, 50));
    assert.equal(q1.totalFeeBps, 30);
    ok(`quoted 5 FMX → ${formatAmount(q1.amountOut, 18, 4)} SEED, impact ${formatPpmPercent(q1.priceImpactPpm)}, min ${formatAmount(q1.minimumReceived, 18, 4)} (router-verified)`);

    // --- 7. 256 randomised inputs: app math vs the contract, to the wei ---
    const rand = makeRandom(3961);
    let checked = 0;
    for (let i = 0; i < 256; i++) {
      const reserveIn = rand(parseEther('1000000')) + parseEther('1');
      const reserveOut = rand(parseEther('1000000')) + parseEther('1');
      const amountIn = rand(reserveIn) + 1n;
      const [onChainOut, onChainQuote] = await Promise.all([
        routerRead.getAmountOut(amountIn, reserveIn, reserveOut),
        routerRead.quote(amountIn, reserveIn, reserveOut),
      ]);
      assert.equal(getAmountOut(amountIn, reserveIn, reserveOut), onChainOut, `getAmountOut mismatch at i=${i}`);
      assert.equal(quoteRatio(amountIn, reserveIn, reserveOut), onChainQuote, `quote mismatch at i=${i}`);
      const wanted = getAmountOut(amountIn, reserveIn, reserveOut);
      if (wanted > 0n && wanted < reserveOut) {
        const onChainIn = await routerRead.getAmountIn(wanted, reserveIn, reserveOut);
        assert.equal(getAmountIn(wanted, reserveIn, reserveOut), onChainIn, `getAmountIn mismatch at i=${i}`);
      }
      checked += 1;
    }
    ok(`${checked} randomised cases: lib/math.ts getAmountOut / getAmountIn / quote equal the contract's, to the wei`);

    // --- 8. execute a native-FMX swap ---
    const trader = new Wallet(Wallet.createRandom().privateKey, provider);
    await (await deployer.sendTransaction({ to: trader.address, value: parseEther('500') })).wait();
    const beforeSeed = await fetchBalance(provider, seedToken, trader.address);
    const swapQuote = await quoteSwap(provider, addresses, index, fmx, seedToken, parseEther('10'), {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    const plan = planSwap(swapQuote, 20);
    assert.equal(plan.method, 'swapExactFMXForTokens');
    const swapTx = await executeSwap(trader, addresses, swapQuote, trader.address, 20);
    const swapReceipt = await swapTx.wait();
    assert.equal(swapReceipt.status, 1);
    const afterSeed = await fetchBalance(provider, seedToken, trader.address);
    assert.equal(afterSeed - beforeSeed, swapQuote.amountOut, 'received exactly the quoted amount');
    assert.ok(afterSeed - beforeSeed >= swapQuote.minimumReceived, 'and at least the minimum');
    ok(`swapped 10 FMX → ${formatAmount(afterSeed - beforeSeed, 18, 6)} SEED (exactly the quote, native path)`);

    // --- 9. approve + two-hop token → token (SEED → WFMX → AZNT) ---
    pairs = await loadAllPairs(provider, addresses, cache);
    index = buildPairIndex(pairs);
    const hopIn = parseEther('10');
    const shortfallBefore = await allowanceShortfall(provider, addresses, seedToken, trader.address, hopIn);
    assert.equal(shortfallBefore, hopIn, 'a fresh trader has no allowance at all');
    await (await approveToken(trader, seedToken, addresses.router, hopIn)).wait();
    assert.equal(await allowanceShortfall(provider, addresses, seedToken, trader.address, hopIn), 0n);

    const hopQuote = await quoteSwap(provider, addresses, index, seedToken, azntToken, hopIn, {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    assert.deepEqual(hopQuote.route.path, [seedToken.address, addresses.wfmx, azntToken.address]);
    assert.equal(hopQuote.totalFeeBps, 60, 'two hops cost 0.60%');
    assert.equal(planSwap(hopQuote, 20).method, 'swapExactTokensForTokens');
    const beforeAznt = await fetchBalance(provider, azntToken, trader.address);
    await (await executeSwap(trader, addresses, hopQuote, trader.address, 20)).wait();
    const gainedAznt = (await fetchBalance(provider, azntToken, trader.address)) - beforeAznt;
    assert.equal(gainedAznt, hopQuote.amountOut);
    ok(`two-hop swap 10 SEED → WFMX → ${formatUnits(gainedAznt, 6)} AZNT after an exact-amount approval`);

    // --- 10. token → native FMX ---
    pairs = await loadAllPairs(provider, addresses, cache);
    index = buildPairIndex(pairs);
    const sellSeed = parseEther('5');
    await (await approveToken(trader, seedToken, addresses.router, sellSeed)).wait();
    const sellQuote = await quoteSwap(provider, addresses, index, seedToken, fmx, sellSeed, {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    assert.equal(planSwap(sellQuote, 20).method, 'swapExactTokensForFMX');
    const fmxBefore = await provider.getBalance(trader.address);
    const sellReceipt = await (await executeSwap(trader, addresses, sellQuote, trader.address, 20)).wait();
    const gasPaid = sellReceipt.gasUsed * sellReceipt.gasPrice;
    const fmxAfter = await provider.getBalance(trader.address);
    assert.equal(fmxAfter - fmxBefore + gasPaid, sellQuote.amountOut, 'native FMX arrived, net of gas');
    ok(`sold 5 SEED for ${formatAmount(sellQuote.amountOut, 18, 6)} native FMX (unwrapped by the router)`);

    // --- 11. the bounds are real: slippage floor and deadline ---
    pairs = await loadAllPairs(provider, addresses, cache);
    index = buildPairIndex(pairs);
    const boundQuote = await quoteSwap(provider, addresses, index, fmx, seedToken, parseEther('1'), {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    const impossible = { ...boundQuote, minimumReceived: boundQuote.amountOut * 2n };
    await assert.rejects(
      executeSwap(trader, addresses, impossible, trader.address, 20),
      /insufficient output amount/i,
      'the router must refuse to settle below amountOutMin',
    );
    const nowSec = await chainNow(provider);
    await assert.rejects(
      executeSwap(trader, addresses, boundQuote, trader.address, 20, nowSec - 3600),
      /expired/i,
      'the router must refuse a stale deadline',
    );
    ok('router enforced amountOutMin and the deadline — both reverted as designed');

    // --- 12. price-impact thresholds ---
    const smallQuote = await quoteSwap(provider, addresses, index, fmx, seedToken, parseEther('1'), {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    const bigQuote = await quoteSwap(provider, addresses, index, fmx, seedToken, parseEther('1200'), {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    assert.equal(impactLevel(smallQuote.priceImpactBps), 'ok');
    assert.equal(impactLevel(bigQuote.priceImpactBps), 'severe');
    assert.ok(bigQuote.priceImpactBps >= 1000, `expected ≥10% impact, got ${bigQuote.priceImpactBps} bps`);
    const warnQuote = await quoteSwap(provider, addresses, index, fmx, seedToken, parseEther('200'), {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    assert.equal(impactLevel(warnQuote.priceImpactBps), 'warn');
    ok(`impact thresholds: 1 FMX = ${formatPpmPercent(smallQuote.priceImpactPpm)} (ok), 200 FMX = ${formatPpmPercent(warnQuote.priceImpactPpm)} (warn), 1200 FMX = ${formatPpmPercent(bigQuote.priceImpactPpm)} (severe)`);

    // --- 13. add liquidity to a LIVE pool: LP minted matches the quote ---
    pairs = await loadAllPairs(provider, addresses, cache);
    index = buildPairIndex(pairs);
    const livePool = pairs.find((p) => p.pair === seedPool.pair);
    const addQuote = quoteAddLiquidity(livePool, seedToken, fmx, 'A', parseEther('100'), 50);
    assert.equal(addQuote.isFirstDeposit, false);
    assert.ok(addQuote.amountB > 0n, 'the FMX side is computed from the pool ratio, not typed');
    assert.equal(
      addQuote.amountB,
      quoteRatio(
        parseEther('100'),
        livePool.token0.symbol === 'SEED' ? livePool.reserve0 : livePool.reserve1,
        livePool.token0.symbol === 'SEED' ? livePool.reserve1 : livePool.reserve0,
      ),
    );
    await (await approveToken(deployer, seedToken, addresses.router, addQuote.amountA)).wait();
    const lpBefore = await fetchLpBalance(provider, livePool.pair, deployer.address);
    await (await addLiquidity(deployer, addresses, addQuote, deployer.address, 20)).wait();
    const lpAfter = await fetchLpBalance(provider, livePool.pair, deployer.address);
    assert.equal(lpAfter - lpBefore, addQuote.lpMinted, 'LP minted must equal the quoted amount exactly');
    ok(`added 100 SEED + ${formatAmount(addQuote.amountB, 18, 6)} FMX at the pool ratio; minted exactly the quoted ${formatAmount(addQuote.lpMinted, 18, 6)} LP`);

    // --- 14. positions ---
    pairs = await loadAllPairs(provider, addresses, cache);
    const positions = await loadPositions(provider, pairs, deployer.address);
    assert.equal(positions.length, 2, 'the deployer is the LP in both pools');
    const seedPosition = positions.find((p) => p.snapshot.pair === livePool.pair);
    const freshSeedPool = pairs.find((p) => p.pair === livePool.pair);
    assert.equal(seedPosition.shareOfPoolPpm, shareOfPoolPpm(seedPosition.lpBalance, freshSeedPool.totalSupply));
    assert.ok(seedPosition.shareOfPoolPpm > 999_000n, 'the only LP holds essentially 100% of the pool');
    const [expected0, expected1] = pooledAmounts(
      seedPosition.lpBalance,
      freshSeedPool.totalSupply,
      freshSeedPool.reserve0,
      freshSeedPool.reserve1,
    );
    assert.equal(seedPosition.pooled0, expected0);
    assert.equal(seedPosition.pooled1, expected1);
    ok(`positions: ${formatPpmPercent(seedPosition.shareOfPoolPpm, 3)} of the SEED/FMX pool = ${formatAmount(seedPosition.pooled0, freshSeedPool.token0.decimals, 4)} ${freshSeedPool.token0.symbol} + ${formatAmount(seedPosition.pooled1, freshSeedPool.token1.decimals, 4)} ${freshSeedPool.token1.symbol}`);

    // --- 15. remove 50%, unwrapping WFMX back to native FMX ---
    const removeQuote = quoteRemoveLiquidity(freshSeedPool, seedPosition.lpBalance, 50, 50);
    assert.equal(removeQuote.liquidity, seedPosition.lpBalance / 2n);
    assert.equal(await fetchLpAllowance(provider, freshSeedPool.pair, deployer.address, addresses.router), 0n);
    await (await approveLp(deployer, freshSeedPool.pair, addresses.router, removeQuote.liquidity)).wait();
    const seedBalBefore = await fetchBalance(provider, seedToken, deployer.address);
    const fmxBalBefore = await provider.getBalance(deployer.address);
    const removeReceipt = await (
      await removeLiquidity(deployer, addresses, freshSeedPool, removeQuote, deployer.address, 20, {
        unwrapNative: true,
        wfmx: addresses.wfmx,
      })
    ).wait();
    const removeGas = removeReceipt.gasUsed * removeReceipt.gasPrice;
    const seedGained = (await fetchBalance(provider, seedToken, deployer.address)) - seedBalBefore;
    const fmxGained = (await provider.getBalance(deployer.address)) - fmxBalBefore + removeGas;
    const wfmxIsToken0 = freshSeedPool.token0.address.toLowerCase() === addresses.wfmx.toLowerCase();
    assert.equal(seedGained, wfmxIsToken0 ? removeQuote.amount1 : removeQuote.amount0);
    assert.equal(fmxGained, wfmxIsToken0 ? removeQuote.amount0 : removeQuote.amount1);
    ok(`removed 50%: received ${formatAmount(seedGained, 18, 6)} SEED + ${formatAmount(fmxGained, 18, 6)} native FMX, both exactly as quoted`);

    // --- 16. the locker: lock, read the badge, mature it, read it again ---
    const remainingLp = await fetchLpBalance(provider, freshSeedPool.pair, deployer.address);
    const lockAmount = (remainingLp * 60n) / 100n;
    await (await approveLp(deployer, freshSeedPool.pair, addresses.locker, lockAmount)).wait();
    const lockerWrite = new Contract(addresses.locker, locker.abi, deployer);
    const lockUntil = (await chainNow(provider)) + 180 * 24 * 3600; // ~6 months
    await (await lockerWrite.lock(freshSeedPool.pair, lockAmount, lockUntil)).wait();

    // A second, deliberately short lock so maturity can be observed.
    const shortAmount = remainingLp / 100n;
    await (await approveLp(deployer, freshSeedPool.pair, addresses.locker, shortAmount)).wait();
    const shortUntil = (await chainNow(provider)) + 3600;
    await (await lockerWrite.lock(freshSeedPool.pair, shortAmount, shortUntil)).wait();

    let poolNow = await loadPair(provider, freshSeedPool.pair, cache);
    let asOf = await chainNow(provider);
    let summary = await loadLockSummary(provider, addresses, poolNow.pair, poolNow.totalSupply, asOf);
    assert.equal(summary.held, lockAmount + shortAmount);
    assert.equal(summary.lockedNow, lockAmount + shortAmount, 'both locks are still in the future');
    assert.equal(summary.all.length, 2);
    assert.equal(summary.active.length, 2);
    assert.equal(summary.earliestUnlock, shortUntil);
    assert.equal(summary.latestUnlock, lockUntil);
    assert.equal(summary.lockedPpm, ((lockAmount + shortAmount) * 1_000_000n) / poolNow.totalSupply);
    assert.equal(lockState(summary.active[0], asOf), 'locked');
    const badgePercent = formatPpmPercent(summary.lockedPpm, 1);
    ok(`locker badge: ${badgePercent} of LP supply locked, earliest unlock in ${Math.round((summary.earliestUnlock - asOf) / 3600)}h, ${summary.all.length} locks listed`);

    // Move the chain past the short lock: a matured lock is NOT a lock.
    await provider.send('evm_increaseTime', [7200]);
    await provider.send('evm_mine', []);
    asOf = await chainNow(provider);
    poolNow = await loadPair(provider, poolNow.pair, cache);
    summary = await loadLockSummary(provider, addresses, poolNow.pair, poolNow.totalSupply, asOf);
    assert.equal(summary.held, lockAmount + shortAmount, 'the locker still HOLDS both');
    assert.equal(summary.lockedNow, lockAmount, 'but only the long one is still time-locked');
    assert.equal(summary.active.length, 1);
    assert.equal(lockState(summary.all.find((l) => l.unlockAt === shortUntil), asOf), 'matured');
    const summaries = await loadLockSummaries(
      provider,
      addresses,
      pairs.map((p) => ({ pair: p.pair, totalSupply: p.totalSupply })),
      asOf,
    );
    assert.equal(summaries.get(poolNow.pair.toLowerCase()).lockedNow, lockAmount);
    const ownerLocks = await loadOwnerLocks(provider, addresses, deployer.address);
    assert.equal(ownerLocks.length, 2);
    assert.equal(ownerLocks[0].owner, deployer.address);
    ok(`after the short lock matured: held ${formatAmount(summary.held, 18, 4)} LP but only ${formatAmount(summary.lockedNow, 18, 4)} still locked — the badge reports the honest number`);

    // --- 17. create a brand-new pair and set its opening price ---
    assert.equal(await findPair(provider, addresses, seedToken.address, azntToken.address), null);
    await (await createPair(deployer, addresses, seedToken, azntToken)).wait();
    const newPair = await findPair(provider, addresses, seedToken.address, azntToken.address);
    assert.ok(newPair, 'the factory registered the new pool');
    const emptySnapshot = await loadPair(provider, newPair, cache);
    assert.equal(emptySnapshot.totalSupply, 0n, 'a new pool has no LP supply and therefore no price');

    const openQuote = quoteAddLiquidity(
      emptySnapshot,
      seedToken,
      azntToken,
      'A',
      parseEther('1000'),
      50,
      parseUnits('4000', 6),
    );
    assert.equal(openQuote.isFirstDeposit, true);
    assert.equal(openQuote.shareOfPoolPpm, 1_000_000n, 'the first depositor owns 100% of the pool');
    await (await approveToken(deployer, seedToken, addresses.router, openQuote.amountA)).wait();
    await (await approveToken(deployer, azntToken, addresses.router, openQuote.amountB)).wait();
    // Chain time is 2h ahead of wall-clock time after the lock-maturity jump
    // above, so the deadline must be built from the CHAIN's clock. (In the
    // browser the two agree; here it is worth being explicit.)
    await (await addLiquidity(deployer, addresses, openQuote, deployer.address, 20, await chainNow(provider))).wait();
    const seededNew = await loadPair(provider, newPair, cache);
    const seedSide = seededNew.token0.symbol === 'SEED' ? seededNew.reserve0 : seededNew.reserve1;
    const azntSide = seededNew.token0.symbol === 'SEED' ? seededNew.reserve1 : seededNew.reserve0;
    assert.equal(seedSide, parseEther('1000'));
    assert.equal(azntSide, parseUnits('4000', 6));
    assert.equal(priceFromReserves(seedSide, 18, azntSide, 6), '4', 'the depositor set 1 SEED = 4 AZNT');
    ok('created a new SEED/AZNT pool as first depositor and set the opening price to 1 SEED = 4 AZNT');

    // The router now prefers the direct pool for a small SEED → AZNT trade.
    pairs = await loadAllPairs(provider, addresses, cache);
    index = buildPairIndex(pairs);
    const directRoute = bestRoute(index, seedToken.address, azntToken.address, parseEther('1'), [addresses.wfmx]);
    assert.deepEqual(directRoute.path, [seedToken.address, azntToken.address]);
    const directQuote = await quoteSwap(provider, addresses, index, seedToken, azntToken, parseEther('1'), {
      slippageBps: 50,
      bases: [addresses.wfmx],
    });
    assert.equal(directQuote.route.path.length, 2);
    assert.equal(directQuote.localMatchesChain, true);
    ok(`route selection switched to the new direct pool: 1 SEED → ${formatUnits(directQuote.amountOut, 6)} AZNT in one hop`);

    // --- 18. wrap / unwrap ---
    const wrapAmount = parseEther('3');
    await (await wrapFmx(trader, addresses, wrapAmount)).wait();
    assert.equal(await fetchBalance(provider, wrapped, trader.address), wrapAmount, 'WFMX is 1:1');
    await (await unwrapFmx(trader, addresses, wrapAmount)).wait();
    assert.equal(await fetchBalance(provider, wrapped, trader.address), 0n);
    ok('wrapped 3 FMX → WFMX and unwrapped it back, 1:1 both ways');

    // --- sanity: the local price impact still agrees with the pool ---
    const finalPool = pairs.find((p) => p.pair === poolNow.pair);
    const finalHop = hopReserves(index, addresses.wfmx, seedToken.address);
    const sampleIn = parseEther('7');
    const sampleOut = await routerRead.getAmountOut(sampleIn, finalHop.reserveIn, finalHop.reserveOut);
    assert.equal(priceImpactPpm(sampleIn, sampleOut, [finalHop]), priceImpactPpm(sampleIn, getAmountOut(sampleIn, finalHop.reserveIn, finalHop.reserveOut), [finalHop]));
    assert.ok(finalPool.totalSupply > 0n);
    ok('price impact recomputed from the router\'s own output matches the local computation');

    provider.destroy();
  } finally {
    anvil.kill('SIGTERM');
    await Promise.race([anvilExit, new Promise((r) => setTimeout(r, 5000))]);
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
    await anvilExit;
  }

  for (let i = 0; i < 20 && !(await portFree(PORT)); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(await portFree(PORT), true, `port ${PORT} must be free after the test`);
  ok(`anvil stopped; port ${PORT} is free again`);

  console.log('\nE2E: all checks passed.');
  if (anvilErr.trim()) console.log(`(anvil stderr: ${anvilErr.trim().slice(0, 200)})`);
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
