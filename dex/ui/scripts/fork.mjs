// ---------------------------------------------------------------------------
// A local anvil FORK of chain 3961, and the market the tests trade against.
//
// Shared by scripts/e2e-fork.mjs (the data layer) and scripts/ui-check.mjs
// (the built page in a browser). Everything happens on 127.0.0.1: anvil
// copies chain 3961's state on demand and every transaction below is confirmed
// by that local anvil only. Accounts are IMPERSONATED (anvil_impersonateAccount):
// no key is read, loaded or needed, and nothing is ever sent to a public node.
//
// The market it builds, all at the official $0.52 per FMX:
//   1. WFMX/USDF, created by the treasury at 0.52 USDF per FMX (the owner's
//      price) unless the fork already has one, in which case liquidity is
//      added at that pool's own ratio;
//   2. the live WFMX/AZNT pool, moved from ~0.325 to 0.884 AZNT per FMX
//      (= $0.52 at 1.70 AZN per USD) by one AZNT → FMX swap from the AZNT
//      ops wallet, so both FMX pools agree with the official price;
//   3. AZNT/USDF at the peg, 1.70 AZNT per USDF, so FMX → USDF has a second,
//      two-pool route through AZNT that the router must weigh.
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

/** Build the $0.52 market on the fork. Returns what it did, for the tests to check. */
export async function seedMarket(provider, log = () => {}) {
  const addresses = DEX_ADDRESSES;
  const cache = new TokenMetaCache(addresses.wfmx);
  const fmx = nativeToken(addresses.wfmx);
  const usdf = await cache.get(provider, USDF);
  const aznt = await cache.get(provider, AZNT);
  const treasury = await impersonate(provider, TREASURY);
  const ops = await impersonate(provider, AZNT_OPS);
  const usdfT = new Contract(USDF, ERC20, treasury);

  // Gas money and inventory for the AZNT ops wallet, from the treasury.
  await confirmed(treasury.sendTransaction({ to: AZNT_OPS, value: parseEther('200') }));
  await confirmed(usdfT.transfer(AZNT_OPS, parseUnits('120000', 6)));

  // 1. WFMX/USDF at $0.52.
  let usdfPair = await findPair(provider, addresses, addresses.wfmx, USDF);
  let usdfPool = usdfPair ? await loadPair(provider, usdfPair, cache) : null;
  const usdfSeed = parseUnits('26000', 6);
  const fmxSeed = parseEther(String(26000 / FMX_USD)); // 50,000 FMX
  await confirmed(approveToken(treasury, usdf, addresses.router, usdfSeed));
  let createdUsdfPool = false;
  if (!usdfPool || usdfPool.reserve0 === 0n || usdfPool.reserve1 === 0n) {
    const q = quoteAddLiquidity(usdfPool, usdf, fmx, 'A', usdfSeed, 50, fmxSeed);
    await confirmed(addLiquidity(treasury, addresses, q, TREASURY, 20, await chainNow(provider)));
    createdUsdfPool = true;
  } else {
    const q = quoteAddLiquidity(usdfPool, usdf, fmx, 'A', usdfSeed, 50);
    await confirmed(addLiquidity(treasury, addresses, q, TREASURY, 20, await chainNow(provider)));
  }
  usdfPair = await findPair(provider, addresses, addresses.wfmx, USDF);
  log(`${createdUsdfPool ? 'created' : 'topped up'} WFMX/USDF ${usdfPair}`);

  // 2. Move the live WFMX/AZNT pool to 0.884 AZNT per FMX with one AZNT → FMX swap.
  const live = await loadPair(provider, LIVE_AZNT_PAIR, cache);
  const wIs0 = live.token0.address.toLowerCase() === addresses.wfmx.toLowerCase();
  const rW = Number(wIs0 ? live.reserve0 : live.reserve1) / 1e18;
  const rA = Number(wIs0 ? live.reserve1 : live.reserve0) / 1e6;
  const target = FMX_USD * AZN_PER_USD; // AZNT per FMX
  const before = rA / rW;
  let rebalanced = null;
  if (before < target * 0.995) {
    const aIn = (Math.sqrt(rW * rA * target) - rA) / 0.997;
    const amountIn = parseUnits(aIn.toFixed(6), 6);
    await confirmed(approveToken(ops, aznt, addresses.router, amountIn));
    let index = buildPairIndex(await loadAllPairs(provider, addresses, cache));
    const q = await quoteSwap(provider, addresses, index, aznt, fmx, amountIn, { slippageBps: 100, maxHops: 1 });
    await confirmed(executeSwap(ops, addresses, q, AZNT_OPS, 20, await chainNow(provider)));
    rebalanced = { amountIn, fmxOut: q.amountOut };
  }
  const liveAfter = await loadPair(provider, LIVE_AZNT_PAIR, cache);
  const rW2 = Number(wIs0 ? liveAfter.reserve0 : liveAfter.reserve1) / 1e18;
  const rA2 = Number(wIs0 ? liveAfter.reserve1 : liveAfter.reserve0) / 1e6;
  log(`WFMX/AZNT ${before.toFixed(4)} → ${(rA2 / rW2).toFixed(4)} AZNT per FMX`);

  // 3. AZNT/USDF at the peg: 170,000 AZNT + 100,000 USDF.
  let azntUsdfPair = await findPair(provider, addresses, AZNT, USDF);
  const snap = azntUsdfPair ? await loadPair(provider, azntUsdfPair, cache) : null;
  const aSeed = parseUnits('170000', 6);
  const uSeed = parseUnits('100000', 6);
  await confirmed(approveToken(ops, aznt, addresses.router, aSeed));
  await confirmed(approveToken(ops, usdf, addresses.router, uSeed));
  const q3 =
    snap && snap.reserve0 > 0n
      ? quoteAddLiquidity(snap, aznt, usdf, 'B', uSeed, 50)
      : quoteAddLiquidity(snap, aznt, usdf, 'A', aSeed, 50, uSeed);
  await confirmed(addLiquidity(ops, addresses, q3, AZNT_OPS, 20, await chainNow(provider)));
  azntUsdfPair = await findPair(provider, addresses, AZNT, USDF);
  log(`AZNT/USDF ${azntUsdfPair}`);

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
