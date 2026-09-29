// ---------------------------------------------------------------------------
// A local anvil FORK of chain 3961, and the market the tests trade against.
//
// Shared by scripts/e2e-fork.mjs (the data layer) and scripts/ui-check.mjs
// (the built page in a browser). Everything happens on 127.0.0.1: anvil
// copies chain 3961's state on demand and every transaction below is confirmed
// by that local anvil only. Accounts are IMPERSONATED (anvil_impersonateAccount):
// no key is read, loaded or needed, and nothing is ever sent to a public node.
//
// The market is chain 3961's own, as the fork copies it (checked 2026-09-27):
//   1. WFMX/USDF 0x04B2…86f9: 480,769 WFMX + 250,000 USDF, 0.52 USDF per FMX,
//      seeded by the treasury, its LP locked in LiquidityLocker until
//      2027-09-26 (lock #1, all of it but the 1,000-wei minimum);
//   2. WFMX/AZNT 0xbab1…6845 at 0.884 AZNT per FMX (= $0.52 at 1.70 AZN per
//      USD), lock #0 until 2027-08-20.
// Both are used as they are: adding liquidity to either would dilute the lock
// the checks read. The one thing done to them is a guard: if WFMX/AZNT has
// drifted below $0.52, one AZNT → FMX swap from the AZNT ops wallet moves it
// back. A chain without a WFMX/USDF pool (a devnet fork) gets one at $0.52.
//
// `routePool` adds what chain 3961 does not have: a THIN AZNT/USDF pool at
// the peg, so AZNT → USDF has a direct pool and a route through FMX for the
// router to weigh (scripts/e2e-fork.mjs). scripts/ui-check.mjs runs on the
// live market alone and reads every figure it expects from the fork.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { Contract, parseEther, parseUnits } from 'ethers';

import { CHAIN_ID, DEX_ADDRESSES } from '../src/config.ts';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';
import { addLiquidity, quoteAddLiquidity } from '../src/lib/liquidity.ts';
import { TokenMetaCache, buildPairIndex, findPair, loadAllPairs, loadPair } from '../src/lib/pairs.ts';
import { executeSwap, quoteSwap } from '../src/lib/swap.ts';
import { approveToken, nativeToken } from '../src/lib/tokens.ts';

export const FORK_URL = process.env.FERMINUX_FORK_URL || 'https://rpc.ferminux.net';
export const TREASURY = '0xc0A5Eb613f859f072554F29f1Ab7400265af15aB';
export const AZNT_OPS = '0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE';
export const USDF = '0xCd032A609e34121D1881E8DE7355b2c2c7092363';
export const AZNT = '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178';
export const LIVE_AZNT_PAIR = '0xbab12e7B817F0686e11949eC06697235DC146845';
export const LIVE_USDF_PAIR = '0x04B2D76a04ED9b53a0d8fF9ee375eafeF04886f9';
/** LiquidityLocker lock ids holding the two live pools' LP. */
export const LIVE_LOCKS = { [LIVE_AZNT_PAIR.toLowerCase()]: 0n, [LIVE_USDF_PAIR.toLowerCase()]: 1n };

/** $0.52 per FMX, and 1.70 AZN per USD: the bases the whole market is built at. */
export const FMX_USD = 0.52;
export const AZN_PER_USD = 1.7;

export const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
];

export function portFree(port) {
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

export function haveAnvil() {
  return !spawnSync('anvil', ['--version']).error;
}

/** Start `anvil --fork-url` on 127.0.0.1:`port`. Throws if the port is taken. */
export async function startFork(port) {
  if (!(await portFree(port))) throw new Error(`port ${port} is busy: stop whatever holds it, or set DEX_TEST_PORT`);
  const proc = spawn(
    'anvil',
    ['--fork-url', FORK_URL, '--chain-id', String(CHAIN_ID), '--port', String(port), '--host', '127.0.0.1', '--silent', '--no-rate-limit'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120 && !(await probeRpc(rpc, CHAIN_ID, 1500)); i++) {
    if (proc.exitCode !== null) throw new Error(`anvil exited: ${stderr.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await probeRpc(rpc, CHAIN_ID, 3000))) throw new Error(`anvil fork did not come up on ${rpc}: ${stderr.slice(0, 400)}`);
  const stop = async () => {
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await exited;
  };
  return { rpc, proc, stop, stderr: () => stderr };
}

/** A provider on the fork. Refuses anything that is not a loopback URL. */
export async function forkProvider(rpc) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)) throw new Error(`refusing to run against ${rpc}: the fork must be local`);
  const { provider } = await connectRpc([rpc], CHAIN_ID, 3000);
  provider.pollingInterval = 150;
  // anvil estimates on the latest block's timestamp. A pool already updated in that second skips its
  // price-accumulator writes in the estimate but makes them when the transaction lands a second later,
  // so an exact estimate can run out of gas in the pair ("not enough gas for reentrancy sentry").
  // Every signer here (the impersonated ones and the test wallet) takes its limit from this provider,
  // so the fork's transactions get a quarter more gas than estimated, as a wallet would add.
  const estimate = provider.estimateGas.bind(provider);
  provider.estimateGas = async (tx) => ((await estimate(tx)) * 5n) / 4n;
  return provider;
}

/** A signer for `address` on the fork, by impersonation: no key involved. */
export async function impersonate(provider, address) {
  await provider.send('anvil_impersonateAccount', [address]);
  return provider.getSigner(address);
}

async function confirmed(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} reverted`);
  return receipt;
}

/**
 * The market on the fork: the live pools (see the top of this file), and with
 * `routePool: { aznt, usdf }` (whole tokens) a thin AZNT/USDF pool at the peg.
 * Returns what it found and did, for the checks to read.
 */
export async function seedMarket(provider, { log = () => {}, routePool = null } = {}) {
  const addresses = DEX_ADDRESSES;
  const cache = new TokenMetaCache(addresses.wfmx);
  const fmx = nativeToken(addresses.wfmx);
  const usdf = await cache.get(provider, USDF);
  const aznt = await cache.get(provider, AZNT);
  const treasury = await impersonate(provider, TREASURY);
  const ops = await impersonate(provider, AZNT_OPS);

  // 1. WFMX/USDF: the live pool, untouched; created at $0.52 only on a chain without one.
  let usdfPair = await findPair(provider, addresses, addresses.wfmx, USDF);
  const usdfPool = usdfPair ? await loadPair(provider, usdfPair, cache) : null;
  let createdUsdfPool = false;
  if (!usdfPool || usdfPool.reserve0 === 0n || usdfPool.reserve1 === 0n) {
    const usdfSeed = parseUnits('26000', 6);
    const fmxSeed = parseEther(String(26000 / FMX_USD)); // 50,000 FMX
    await confirmed(approveToken(treasury, usdf, addresses.router, usdfSeed));
    const q = quoteAddLiquidity(usdfPool, usdf, fmx, 'A', usdfSeed, 50, fmxSeed);
    await confirmed(addLiquidity(treasury, addresses, q, TREASURY, 20, await chainNow(provider)));
    usdfPair = await findPair(provider, addresses, addresses.wfmx, USDF);
    createdUsdfPool = true;
  }
  log(`${createdUsdfPool ? 'created' : 'live'} WFMX/USDF ${usdfPair}`);

  // 2. WFMX/AZNT: back to 0.884 AZNT per FMX with one AZNT → FMX swap, only if it has drifted below.
  const live = await loadPair(provider, LIVE_AZNT_PAIR, cache);
  const wIs0 = live.token0.address.toLowerCase() === addresses.wfmx.toLowerCase();
  const rW = Number(wIs0 ? live.reserve0 : live.reserve1) / 1e18;
  const rA = Number(wIs0 ? live.reserve1 : live.reserve0) / 1e6;
  const target = FMX_USD * AZN_PER_USD; // AZNT per FMX
  const before = rA / rW;
  let rebalanced = null;
  if (before < target * 0.995) {
    await confirmed(treasury.sendTransaction({ to: AZNT_OPS, value: parseEther('200') }));
    const aIn = (Math.sqrt(rW * rA * target) - rA) / 0.997;
    const amountIn = parseUnits(aIn.toFixed(6), 6);
    await confirmed(approveToken(ops, aznt, addresses.router, amountIn));
    const index = buildPairIndex(await loadAllPairs(provider, addresses, cache));
    const q = await quoteSwap(provider, addresses, index, aznt, fmx, amountIn, { slippageBps: 100, maxHops: 1 });
    await confirmed(executeSwap(ops, addresses, q, AZNT_OPS, 20, await chainNow(provider)));
    rebalanced = { amountIn, fmxOut: q.amountOut };
  }
  const liveAfter = await loadPair(provider, LIVE_AZNT_PAIR, cache);
  const rW2 = Number(wIs0 ? liveAfter.reserve0 : liveAfter.reserve1) / 1e18;
  const rA2 = Number(wIs0 ? liveAfter.reserve1 : liveAfter.reserve0) / 1e6;
  log(`WFMX/AZNT ${before.toFixed(4)} → ${(rA2 / rW2).toFixed(4)} AZNT per FMX`);

  // 3. Optional: a thin AZNT/USDF pool at the peg (1.70 AZNT per USDF), which chain 3961 does not have.
  let azntUsdfPair = null;
  if (routePool) {
    const aSeed = parseUnits(String(routePool.aznt), 6);
    const uSeed = parseUnits(String(routePool.usdf), 6);
    await confirmed(treasury.sendTransaction({ to: AZNT_OPS, value: parseEther('200') }));
    await confirmed(new Contract(USDF, ERC20, treasury).transfer(AZNT_OPS, uSeed));
    const existing = await findPair(provider, addresses, AZNT, USDF);
    const snap = existing ? await loadPair(provider, existing, cache) : null;
    await confirmed(approveToken(ops, aznt, addresses.router, aSeed));
    await confirmed(approveToken(ops, usdf, addresses.router, uSeed));
    const q3 =
      snap && snap.reserve0 > 0n
        ? quoteAddLiquidity(snap, aznt, usdf, 'B', uSeed, 50)
        : quoteAddLiquidity(snap, aznt, usdf, 'A', aSeed, 50, uSeed);
    await confirmed(addLiquidity(ops, addresses, q3, AZNT_OPS, 20, await chainNow(provider)));
    azntUsdfPair = await findPair(provider, addresses, AZNT, USDF);
    log(`AZNT/USDF ${azntUsdfPair} (fork only)`);
  }

  return { cache, fmx, usdf, aznt, treasury, ops, usdfPair, azntUsdfPair, createdUsdfPool, rebalanced, azntPerFmxBefore: before, azntPerFmxAfter: rA2 / rW2 };
}

export async function chainNow(provider) {
  return (await provider.getBlock('latest')).timestamp;
}

/** Fund a fresh account (anvil dev key #1, public) with FMX from the treasury. */
export async function fundTrader(provider, treasury, address, fmx = '60000') {
  await confirmed(treasury.sendTransaction({ to: address, value: parseEther(fmx) }));
}

export { confirmed };
