// Swapping on the Ferminux DEX from inside the wallet: the pools, the route,
// the quote, the bounds the router enforces, the calls that get signed and the
// checks that run before anything is signed.
// No browser globals — the unit tests and the fork smoke import this file as is.
//
// The DEX (dex/contracts, deployed 2026-08-20 on chain 3961) is a Uniswap-v2
// style AMM: FerminuxFactory registers one pair per token pair, FerminuxRouter
// is what users call, WFMX wraps native FMX for the pools. Every function here
// that prices a trade mirrors dex/contracts/src/libraries/FerminuxLibrary.sol
// line for line — same operation order, same rounding — so the number on the
// screen is the number the pool pays, not a float approximation of it.
//
// What the wallet signs is limited to exactly four shapes, all built here:
//   approve(ROUTER, amount)            on the token being sold (exact by default)
//   swapExact…(…, to = this account)  on the router, chain 3961 only
//   deposit() / withdraw(amount)       on WFMX (FMX ⇄ WFMX is a wrap, not a trade)
// The router and WFMX addresses are constants: no quote, pool or token can
// point a signature anywhere else, and the recipient is always the account
// that signs.

import { Interface, MaxUint256, getAddress } from 'ethers';
import type { BatchTransport, JsonRpcCall, JsonRpcReply } from './balances.ts';
import { FIRST_PARTY_ADDRESSES } from '../../../shared/tokens.ts';
import { formatAmount } from './validate.ts';

/* ------------------------------------------------------------------ */
/* The DEX on chain 3961                                               */
/* ------------------------------------------------------------------ */

/** The only chain the Ferminux DEX exists on. A swap anywhere else is refused, not attempted. */
export const SWAP_CHAIN_ID = 3961;

/** dex/contracts/broadcast/DeployDex.s.sol/3961/run-latest.json (tests/swap.test.mjs reads it). */
export const DEX = {
  factory: '0x2034a8366fCdbfFCf4517D297f702aDDdba37040',
  router: '0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f',
  wfmx: '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae',
} as const;

/** One token on either side of a swap. `address: null` is native FMX. */
export interface SwapToken {
  address: string | null;
  symbol: string;
  name: string;
  decimals: number;
}

const lower = (a: string) => a.toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lower(a) === lower(b);

/** The address a token has inside the pools: native FMX trades as WFMX. */
export function poolAddress(t: SwapToken): string {
  return getAddress(t.address ?? DEX.wfmx);
}

export function isWfmx(address: string | null): boolean {
  return same(address, DEX.wfmx);
}

/** A stable key for a token in the picker and in settings: "native" or the lowercased address. */
export function tokenKey(t: { address: string | null }): string {
  return t.address ? lower(t.address) : 'native';
}

export type SwapKind = 'swap' | 'wrap' | 'unwrap';

/**
 * FMX ⇄ WFMX is the wrapper contract, 1:1, no pool, no fee, no slippage — a
 * wrap, not a trade. Null when both sides are the same token.
 */
export function swapKind(tokenIn: SwapToken, tokenOut: SwapToken): SwapKind | null {
  if (tokenKey(tokenIn) === tokenKey(tokenOut)) return null;
  if (tokenIn.address === null && isWfmx(tokenOut.address)) return 'wrap';
  if (isWfmx(tokenIn.address) && tokenOut.address === null) return 'unwrap';
  return 'swap';
}

/**
 * Tokens a multi-hop route may pass THROUGH: WFMX and the tokens the project
 * deploys and vouches for (shared/tokens.ts, firstParty). An intermediate hop
 * runs that token's transfer code inside the swap, so an arbitrary token never
 * becomes a hop — only a token the user picked as one of the two ends.
 */
export function routeBases(): string[] {
  const out = [getAddress(DEX.wfmx)];
  for (const a of FIRST_PARTY_ADDRESSES) if (!out.some((o) => same(o, a))) out.push(getAddress(a));
  return out;
}

/* ------------------------------------------------------------------ */
/* AMM math — FerminuxLibrary.sol in bigint                            */
/* ------------------------------------------------------------------ */

/** 0.30% per hop, charged on the input: 997/1000 of it moves the curve. */
export const FEE_NUMERATOR = 997n;
export const FEE_DENOMINATOR = 1000n;
export const FEE_BPS = 30;
export const BPS = 10_000n;
export const PPM = 1_000_000n;

/** Reserves of one hop, oriented in the direction of the trade. */
export interface Hop {
  pair: string;
  reserveIn: bigint;
  reserveOut: bigint;
}

/** FerminuxLibrary.getAmountOut: rounds down, in favour of the pool. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) throw new Error('LIB: insufficient input amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('LIB: insufficient liquidity');
  const amountInWithFee = amountIn * FEE_NUMERATOR;
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}

/** FerminuxLibrary.getAmountIn: rounds up (+1), in favour of the pool. */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n) throw new Error('LIB: insufficient output amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('LIB: insufficient liquidity');
  if (amountOut >= reserveOut) throw new Error('LIB: insufficient liquidity');
  return (reserveIn * amountOut * FEE_DENOMINATOR) / ((reserveOut - amountOut) * FEE_NUMERATOR) + 1n;
}

/** FerminuxLibrary.getAmountsOut over reserves already read: amounts[0] is the input. */
export function getAmountsOut(amountIn: bigint, hops: Pick<Hop, 'reserveIn' | 'reserveOut'>[]): bigint[] {
  if (hops.length < 1) throw new Error('LIB: invalid path');
  const amounts = [amountIn];
  for (const h of hops) amounts.push(getAmountOut(amounts[amounts.length - 1]!, h.reserveIn, h.reserveOut));
  return amounts;
}

/**
 * What the route would pay for `amountIn` at today's pool prices WITH the
 * 0.30%-per-hop fee but without moving any price: amountIn × Π(997·rOut / 1000·rIn).
 * The yardstick price impact is measured against, so the impact shown is the
 * cost of the pools' depth alone and the fee is shown on its own line.
 */
export function spotOutput(amountIn: bigint, hops: Pick<Hop, 'reserveIn' | 'reserveOut'>[]): bigint {
  let num = amountIn;
  let den = 1n;
  for (const h of hops) {
    if (h.reserveIn <= 0n || h.reserveOut <= 0n) throw new Error('LIB: insufficient liquidity');
    num *= h.reserveOut * FEE_NUMERATOR;
    den *= h.reserveIn * FEE_DENOMINATOR;
  }
  return num / den;
}

/** The no-fee, no-impact output: the pools' mid price, for the rate line. */
export function midOutput(amountIn: bigint, hops: Pick<Hop, 'reserveIn' | 'reserveOut'>[]): bigint {
  let num = amountIn;
  let den = 1n;
  for (const h of hops) {
    num *= h.reserveOut;
    den *= h.reserveIn;
  }
  return den === 0n ? 0n : num / den;
}

/** Price impact in parts per million: how far this size moves the price past the fee. */
export function priceImpactPpm(amountIn: bigint, amountOut: bigint, hops: Pick<Hop, 'reserveIn' | 'reserveOut'>[]): bigint {
  const spot = spotOutput(amountIn, hops);
  if (spot <= 0n || amountOut >= spot) return 0n;
  return ((spot - amountOut) * PPM) / spot;
}

/** Price-impact thresholds, basis points: warn at 3 %, ask for an explicit acknowledgement at 10 %. */
export const IMPACT_WARN_BPS = 300;
export const IMPACT_SEVERE_BPS = 1000;
export type ImpactLevel = 'ok' | 'warn' | 'severe';

export function impactLevel(bps: number): ImpactLevel {
  if (bps >= IMPACT_SEVERE_BPS) return 'severe';
  if (bps >= IMPACT_WARN_BPS) return 'warn';
  return 'ok';
}

/** amountOutMin: the worst fill the user accepts. Rounds down, so it never rejects an honest fill. */
export function minimumReceived(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= Number(BPS)) {
    throw new Error(`slippage must be an integer in [0, 10000) basis points, got ${slippageBps}`);
  }
  return (amountOut * (BPS - BigInt(slippageBps))) / BPS;
}

/* ------------------------------------------------------------------ */
/* Pools                                                               */
/* ------------------------------------------------------------------ */

export interface Pool {
  pair: string;
  /** Sorted by address, as the pair stores them. */
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
}

export type PoolIndex = Map<string, Pool>;

export function pairKey(a: string, b: string): string {
  const [x, y] = [lower(a), lower(b)].sort();
  return `${x}|${y}`;
}

export function indexPools(pools: Pool[]): PoolIndex {
  const m: PoolIndex = new Map();
  for (const p of pools) m.set(pairKey(p.token0, p.token1), p);
  return m;
}

/** The hop from → to through their pool, oriented; null when there is no pool or it holds nothing. */
export function hopOf(index: PoolIndex, from: string, to: string): Hop | null {
  const p = index.get(pairKey(from, to));
  if (!p || p.reserve0 <= 0n || p.reserve1 <= 0n) return null;
  return same(p.token0, from)
    ? { pair: p.pair, reserveIn: p.reserve0, reserveOut: p.reserve1 }
    : { pair: p.pair, reserveIn: p.reserve1, reserveOut: p.reserve0 };
}

/** Pool-token addresses (lowercased) that sit in at least one pool holding liquidity. */
export function pooledTokens(index: PoolIndex): Set<string> {
  const s = new Set<string>();
  for (const p of index.values()) {
    if (p.reserve0 <= 0n || p.reserve1 <= 0n) continue;
    s.add(lower(p.token0));
    s.add(lower(p.token1));
  }
  return s;
}

/**
 * The tokens the picker offers: FMX, WFMX and the listed tokens always (a
 * missing pool is then said out loud as "no route"), and a token the user
 * added by address only once it sits in a pool that holds liquidity. `pooled`
 * null = the pools have not been read yet: added tokens wait for them.
 */
export function offeredTokens<T extends { address: string | null; source: string }>(assets: T[], pooled: Set<string> | null): T[] {
  return assets.filter((a) => a.source !== 'custom' || (a.address !== null && pooled !== null && pooled.has(lower(a.address))));
}

const factoryIface = new Interface(['function getPair(address tokenA, address tokenB) view returns (address pair)']);
const pairIface = new Interface([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);

const ZERO_ADDRESS = /^0x0{40}$/i;
const BATCH = 100;

function ethCall(id: number, to: string, data: string): JsonRpcCall {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] };
}

function byId(replies: JsonRpcReply[]): Map<number, JsonRpcReply> {
  const m = new Map<number, JsonRpcReply>();
  for (const r of Array.isArray(replies) ? replies : [replies]) if (r && typeof r.id === 'number') m.set(r.id, r);
  return m;
}

function decode<T>(iface: Interface, fn: string, r: JsonRpcReply | undefined, index = 0): T | undefined {
  if (!r || r.error || typeof r.result !== 'string' || r.result === '0x') return undefined;
  try {
    return iface.decodeFunctionResult(fn, r.result)[index] as T;
  } catch {
    return undefined;
  }
}

async function batched(transport: BatchTransport, calls: JsonRpcCall[]): Promise<Map<number, JsonRpcReply>> {
  const out = new Map<number, JsonRpcReply>();
  for (let i = 0; i < calls.length; i += BATCH) {
    for (const [k, v] of byId(await transport(calls.slice(i, i + BATCH)))) out.set(k, v);
  }
  return out;
}

/**
 * The pools between the tokens the wallet knows (`tokens`: pool addresses,
 * WFMX added if missing), in two batches: FerminuxFactory.getPair for every
 * combination that can take part in a route — each token against each route
 * base, and the user's own tokens against each other while there are few of
 * them — then getReserves of every pair that exists. Addresses are the
 * factory registry's, never derived. Throws when the endpoint answers none of
 * the lookups, so an outage is never shown as "no pools".
 */
export async function readPools(transport: BatchTransport, tokens: string[], bases: string[] = routeBases()): Promise<Pool[]> {
  const all: string[] = [];
  for (const t of [DEX.wfmx, ...bases, ...tokens]) {
    const a = getAddress(t);
    if (!all.some((x) => same(x, a))) all.push(a);
  }
  const isBase = (a: string) => bases.some((b) => same(b, a)) || isWfmx(a);
  const others = all.filter((a) => !isBase(a));
  const combos: [string, string][] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      if (isBase(a) || isBase(b) || others.length <= 12) combos.push([a, b]);
    }
  }
  const lookups = await batched(
    transport,
    combos.map(([a, b], i) => ethCall(i + 1, DEX.factory, factoryIface.encodeFunctionData('getPair', [a, b]))),
  );
  const found: { pair: string; token0: string; token1: string }[] = [];
  let answered = 0;
  combos.forEach(([a, b], i) => {
    const pair = decode<string>(factoryIface, 'getPair', lookups.get(i + 1));
    if (pair === undefined) return;
    answered += 1;
    if (ZERO_ADDRESS.test(pair)) return;
    const [token0, token1] = lower(a) < lower(b) ? [a, b] : [b, a];
    found.push({ pair: getAddress(pair), token0, token1 });
  });
  if (combos.length > 0 && answered === 0) throw new Error('The Ferminux DEX did not answer. Try again in a moment.');
  if (found.length === 0) return [];
  const reserves = await batched(
    transport,
    found.map((f, i) => ethCall(i + 1, f.pair, pairIface.encodeFunctionData('getReserves'))),
  );
  const pools: Pool[] = [];
  found.forEach((f, i) => {
    const r = reserves.get(i + 1);
    if (!r || r.error || typeof r.result !== 'string') return;
    try {
      const [r0, r1] = pairIface.decodeFunctionResult('getReserves', r.result) as unknown as [bigint, bigint];
      pools.push({ ...f, reserve0: BigInt(r0), reserve1: BigInt(r1) });
    } catch {
      /* unreadable pool: left out of routing */
    }
  });
  return pools;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/** Up to three pools per swap: direct, one base between, or two bases between. */
export const MAX_HOPS = 3;

export interface Route {
  /** Pool addresses of the tokens, path[0] sold, path[last] bought (native FMX appears as WFMX). */
  path: string[];
  hops: Hop[];
  /** amounts[i] enters hop i; the last entry is what the last pool pays out. */
  amounts: bigint[];
  amountOut: bigint;
  priceImpactPpm: bigint;
}

/**
 * Every path from → to whose pools exist and hold liquidity: the direct pool,
 * then through one base, then through two. Only `bases` are ever in the
 * middle; no token appears twice.
 */
export function candidatePaths(index: PoolIndex, from: string, to: string, bases: string[] = routeBases(), maxHops = MAX_HOPS): string[][] {
  if (same(from, to)) return [];
  const out: string[][] = [];
  const walk = (path: string[]) => {
    const last = path[path.length - 1]!;
    if (hopOf(index, last, to)) out.push([...path, getAddress(to)]);
    if (path.length >= maxHops) return;
    for (const b of bases) {
      if (same(b, to) || path.some((p) => same(p, b))) continue;
      if (hopOf(index, last, b)) walk([...path, getAddress(b)]);
    }
  };
  walk([getAddress(from)]);
  return out.sort((a, b) => a.length - b.length);
}

/** Price one path locally. Null when a hop has no liquidity or the trade is too small to pay out. */
export function priceRoute(index: PoolIndex, path: string[], amountIn: bigint): Route | null {
  if (path.length < 2 || path.length > MAX_HOPS + 1 || amountIn <= 0n) return null;
  const hops: Hop[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const h = hopOf(index, path[i]!, path[i + 1]!);
    if (!h) return null;
    hops.push(h);
  }
  let amounts: bigint[];
  try {
    amounts = getAmountsOut(amountIn, hops);
  } catch {
    return null;
  }
  const amountOut = amounts[amounts.length - 1]!;
  if (amountOut <= 0n) return null;
  return { path: [...path], hops, amounts, amountOut, priceImpactPpm: priceImpactPpm(amountIn, amountOut, hops) };
}

/**
 * The route that pays out the most for this size. A tie goes to the shorter
 * path: fewer pools to fail, fewer tokens' code to run.
 */
export function bestRoute(index: PoolIndex, from: string, to: string, amountIn: bigint, bases: string[] = routeBases()): Route | null {
  let best: Route | null = null;
  for (const path of candidatePaths(index, from, to, bases)) {
    const r = priceRoute(index, path, amountIn);
    if (!r) continue;
    if (!best || r.amountOut > best.amountOut || (r.amountOut === best.amountOut && r.path.length < best.path.length)) best = r;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type ApprovalMode = 'exact' | 'unlimited';

export interface SwapSettings {
  /** Slippage tolerance in basis points (50 = 0.5 %). */
  slippageBps: number;
  /** Minutes the router accepts the swap for, counted from the chain's latest block. */
  deadlineMin: number;
  /** What the approval step grants the router: exactly this swap's amount (default), or everything. */
  approval: ApprovalMode;
}

export const SWAP_SETTINGS_KEY = 'ferminux.wallet.swap.v1';
export const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const;
export const DEFAULT_SWAP_SETTINGS: SwapSettings = { slippageBps: 50, deadlineMin: 20, approval: 'exact' };
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 5000;
export const SLIPPAGE_HIGH_BPS = 500;
export const SLIPPAGE_LOW_BPS = 5;
export const MIN_DEADLINE_MIN = 1;
export const MAX_DEADLINE_MIN = 180;

/** Stored settings, each field checked on its own; anything unreadable falls back to the default. */
export function parseSwapSettings(raw: string | null): SwapSettings {
  const d = DEFAULT_SWAP_SETTINGS;
  if (!raw) return { ...d };
  let p: Partial<SwapSettings>;
  try {
    p = JSON.parse(raw) as Partial<SwapSettings>;
  } catch {
    return { ...d };
  }
  if (!p || typeof p !== 'object') return { ...d };
  const s = Number(p.slippageBps);
  const m = Number(p.deadlineMin);
  return {
    slippageBps: Number.isInteger(s) && s >= MIN_SLIPPAGE_BPS && s <= MAX_SLIPPAGE_BPS ? s : d.slippageBps,
    deadlineMin: Number.isInteger(m) && m >= MIN_DEADLINE_MIN && m <= MAX_DEADLINE_MIN ? m : d.deadlineMin,
    approval: p.approval === 'unlimited' ? 'unlimited' : 'exact',
  };
}

export function serializeSwapSettings(s: SwapSettings): string {
  return JSON.stringify({ slippageBps: s.slippageBps, deadlineMin: s.deadlineMin, approval: s.approval });
}

/** "0.5" → 50 bps. Percent with up to two decimals, 0.01 – 50. */
export function parseSlippagePercent(text: string): { ok: true; bps: number } | { ok: false; error: string } {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,2}(\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return { ok: false, error: 'Enter a percentage such as 0.5 (up to two decimals).' };
  const [w, f = ''] = (t.startsWith('.') ? `0${t}` : t).split('.');
  const bps = Number(w) * 100 + Number((f + '00').slice(0, 2));
  if (bps < MIN_SLIPPAGE_BPS) return { ok: false, error: 'Slippage must be at least 0.01%.' };
  if (bps > MAX_SLIPPAGE_BPS) return { ok: false, error: 'Slippage above 50% is not accepted.' };
  return { ok: true, bps };
}

export function parseDeadlineMinutes(text: string): { ok: true; minutes: number } | { ok: false; error: string } {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return { ok: false, error: 'Enter whole minutes.' };
  const n = Number(t);
  if (n < MIN_DEADLINE_MIN || n > MAX_DEADLINE_MIN) return { ok: false, error: `Between ${MIN_DEADLINE_MIN} and ${MAX_DEADLINE_MIN} minutes.` };
  return { ok: true, minutes: n };
}

/** A caution for a slippage setting outside the usual band, or null. */
export function slippageNote(bps: number): string | null {
  if (bps >= SLIPPAGE_HIGH_BPS) return `With ${formatPercentBps(bps)} slippage the swap can settle far below the quote, and a bot can take the difference. Use a small tolerance unless a trade keeps failing.`;
  if (bps < SLIPPAGE_LOW_BPS) return `At ${formatPercentBps(bps)} the swap reverts on almost any price move between review and inclusion (only the network fee is spent).`;
  return null;
}

/** 50 → "0.5%", 1234 → "12.34%". */
export function formatPercentBps(bps: number): string {
  const w = Math.floor(bps / 100);
  const f = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return `${w}${f ? `.${f}` : ''}%`;
}

/** Parts per million → "0.02%"; anything above zero but under 0.01% reads "<0.01%". */
export function formatImpactPpm(ppm: bigint): string {
  if (ppm <= 0n) return '0%';
  if (ppm < 100n) return '<0.01%';
  return formatPercentBps(Number(ppm / 100n));
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

const erc20Iface = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const routerIface = new Interface([
  'function swapExactFMXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForFMX(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);
const wfmxIface = new Interface(['function deposit() payable', 'function withdraw(uint256 wad)']);

export type SwapMethod = 'swapExactFMXForTokens' | 'swapExactTokensForFMX' | 'swapExactTokensForTokens';

/** Method signatures as the confirm screen names them. */
export const METHOD_SIGNATURE: Record<SwapMethod | 'approve' | 'deposit' | 'withdraw', string> = {
  swapExactFMXForTokens: 'swapExactFMXForTokens(uint256,address[],address,uint256)',
  swapExactTokensForFMX: 'swapExactTokensForFMX(uint256,uint256,address[],address,uint256)',
  swapExactTokensForTokens: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  approve: 'approve(address,uint256)',
  deposit: 'deposit()',
  withdraw: 'withdraw(uint256)',
};

export function swapMethodFor(tokenIn: SwapToken, tokenOut: SwapToken): SwapMethod {
  if (tokenIn.address === null) return 'swapExactFMXForTokens';
  if (tokenOut.address === null) return 'swapExactTokensForFMX';
  return 'swapExactTokensForTokens';
}

/** A transaction the wallet will prepare, show and sign. */
export interface TxCall {
  chainId: number;
  to: string;
  value: bigint;
  data: string;
  /** The method as the confirm screen shows it. */
  method: string;
}

function onlyFerminux(chainId: number): void {
  // A build pointed at another chain id (VITE_CHAIN_ID) must not sign to these addresses there.
  if (chainId !== SWAP_CHAIN_ID) throw new Error(`The Ferminux DEX runs on the Ferminux Network (chain ${SWAP_CHAIN_ID}) only.`);
}

/** approve(ROUTER, amount) on the token being sold. The spender is never anything but the router. */
export function buildApproveCall(token: SwapToken, amount: bigint, mode: ApprovalMode, chainId: number): TxCall & { amount: bigint } {
  onlyFerminux(chainId);
  if (token.address === null) throw new Error('Native FMX needs no approval.');
  if (amount <= 0n) throw new Error('Nothing to approve.');
  const granted = mode === 'unlimited' ? MaxUint256 : amount;
  return {
    chainId,
    to: getAddress(token.address),
    value: 0n,
    data: erc20Iface.encodeFunctionData('approve', [getAddress(DEX.router), granted]),
    method: METHOD_SIGNATURE.approve,
    amount: granted,
  };
}

export interface SwapCallInput {
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: bigint;
  amountOutMin: bigint;
  path: string[];
  /** The account that signs: the output goes nowhere else. */
  recipient: string;
  /** Unix seconds (from the chain's latest block plus the setting). */
  deadline: bigint;
  chainId: number;
}

/** The router call for an exact-input swap. Every argument is checked against the pair of tokens. */
export function buildSwapCall(p: SwapCallInput): TxCall & { swapMethod: SwapMethod; path: string[] } {
  onlyFerminux(p.chainId);
  if (swapKind(p.tokenIn, p.tokenOut) !== 'swap') throw new Error('FMX ⇄ WFMX is a wrap, not a swap.');
  if (p.amountIn <= 0n) throw new Error('Enter an amount to swap.');
  if (p.amountOutMin <= 0n) throw new Error('The minimum received must be above zero.');
  if (p.path.length < 2 || p.path.length > MAX_HOPS + 1) throw new Error('A route has two to four tokens.');
  const path = p.path.map((a) => getAddress(a));
  if (!same(path[0], poolAddress(p.tokenIn)) || !same(path[path.length - 1], poolAddress(p.tokenOut))) {
    throw new Error('The route does not start and end at the tokens being swapped.');
  }
  const to = getAddress(p.recipient);
  const method = swapMethodFor(p.tokenIn, p.tokenOut);
  const data =
    method === 'swapExactFMXForTokens'
      ? routerIface.encodeFunctionData(method, [p.amountOutMin, path, to, p.deadline])
      : routerIface.encodeFunctionData(method, [p.amountIn, p.amountOutMin, path, to, p.deadline]);
  return {
    chainId: p.chainId,
    to: getAddress(DEX.router),
    value: method === 'swapExactFMXForTokens' ? p.amountIn : 0n,
    data,
    method: METHOD_SIGNATURE[method],
    swapMethod: method,
    path,
  };
}

/** deposit() with the FMX attached (wrap), or withdraw(amount) (unwrap), on WFMX. */
export function buildWrapCall(kind: 'wrap' | 'unwrap', amount: bigint, chainId: number): TxCall {
  onlyFerminux(chainId);
  if (amount <= 0n) throw new Error('Enter an amount.');
  return kind === 'wrap'
    ? { chainId, to: getAddress(DEX.wfmx), value: amount, data: wfmxIface.encodeFunctionData('deposit'), method: METHOD_SIGNATURE.deposit }
    : { chainId, to: getAddress(DEX.wfmx), value: 0n, data: wfmxIface.encodeFunctionData('withdraw', [amount]), method: METHOD_SIGNATURE.withdraw };
}

export interface DecodedSwap {
  method: SwapMethod;
  amountIn: bigint | null;
  amountOutMin: bigint;
  path: string[];
  to: string;
  deadline: bigint;
}

/** Read back a router call built above (the tests and the confirm screen's calldata check). */
export function decodeSwapCall(data: string): DecodedSwap | null {
  try {
    const tx = routerIface.parseTransaction({ data });
    if (!tx || tx.name === 'getAmountsOut') return null;
    const a = tx.args;
    if (tx.name === 'swapExactFMXForTokens') {
      return { method: tx.name, amountIn: null, amountOutMin: BigInt(a[0]), path: [...(a[1] as string[])], to: a[2] as string, deadline: BigInt(a[3]) };
    }
    return { method: tx.name as SwapMethod, amountIn: BigInt(a[0]), amountOutMin: BigInt(a[1]), path: [...(a[2] as string[])], to: a[3] as string, deadline: BigInt(a[4]) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Pre-check: read fresh before the confirm screen and before signing  */
/* ------------------------------------------------------------------ */

export interface SwapPreflight {
  /** The chain's latest block, for the deadline. */
  blockNumber: number;
  blockTime: number;
  /** FMX: pays the fee (and is the input of an FMX swap or a wrap). */
  nativeBalance: bigint;
  /** The input token's balance (equal to nativeBalance for FMX). */
  balanceIn: bigint;
  /** allowance(holder, ROUTER) on the input token; null for FMX and for wrap/unwrap. */
  allowance: bigint | null;
  /** FerminuxRouter.getAmountsOut(amountIn, path): the authoritative quote. Null for wrap/unwrap or when it reverts. */
  amounts: bigint[] | null;
}

/**
 * One batch: the latest block, the FMX balance, the input token's balance and
 * allowance to the router, and the router's own quote for this route. Throws
 * when the endpoint left out an answer the decision needs, so a failed read is
 * never taken for "enough".
 */
export async function readSwapPreflight(
  transport: BatchTransport,
  q: { holder: string; tokenIn: SwapToken; amountIn: bigint; path: string[] | null; wrap?: boolean },
): Promise<SwapPreflight> {
  const holder = getAddress(q.holder);
  const token = q.tokenIn.address ? getAddress(q.tokenIn.address) : null;
  const calls: JsonRpcCall[] = [
    { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [holder, 'latest'] },
  ];
  if (token) {
    calls.push(ethCall(3, token, erc20Iface.encodeFunctionData('balanceOf', [holder])));
    if (!q.wrap) calls.push(ethCall(4, token, erc20Iface.encodeFunctionData('allowance', [holder, getAddress(DEX.router)])));
  }
  if (q.path && !q.wrap) calls.push(ethCall(5, DEX.router, routerIface.encodeFunctionData('getAmountsOut', [q.amountIn, q.path.map((a) => getAddress(a))])));
  const r = byId(await transport(calls));
  const fail = () => new Error('The network did not answer the swap check. Try again in a moment.');

  const block = r.get(1)?.result as { number?: string; timestamp?: string } | undefined;
  const bal = r.get(2)?.result;
  if (!block || typeof block.number !== 'string' || typeof block.timestamp !== 'string' || typeof bal !== 'string') throw fail();
  const nativeBalance = BigInt(bal);
  let balanceIn = nativeBalance;
  let allowance: bigint | null = null;
  if (token) {
    const b = decode<bigint>(erc20Iface, 'balanceOf', r.get(3));
    if (b === undefined) throw fail();
    balanceIn = BigInt(b);
    if (!q.wrap) {
      const a = decode<bigint>(erc20Iface, 'allowance', r.get(4));
      if (a === undefined) throw fail();
      allowance = BigInt(a);
    }
  }
  let amounts: bigint[] | null = null;
  if (q.path && !q.wrap) {
    const reply = r.get(5);
    if (!reply) throw fail();
    if (!reply.error && typeof reply.result === 'string' && reply.result !== '0x') {
      try {
        amounts = (routerIface.decodeFunctionResult('getAmountsOut', reply.result)[0] as bigint[]).map((x) => BigInt(x));
      } catch {
        amounts = null;
      }
    } else if (reply.error && !/revert/i.test(reply.error.message ?? '') && reply.error.code !== 3) {
      throw fail();
    }
  }
  return { blockNumber: Number(BigInt(block.number)), blockTime: Number(BigInt(block.timestamp)), nativeBalance, balanceIn, allowance, amounts };
}

export type SwapProblemCode = 'funds' | 'gas' | 'no-route' | 'moved' | 'expired';

export interface SwapProblem {
  code: SwapProblemCode;
  message: string;
}

const fmt = (wei: bigint, t: { decimals: number; symbol: string }, digits = 6) => `${formatAmount(wei, t.decimals, digits)} ${t.symbol}`;
const FMX = { decimals: 18, symbol: 'FMX' };

/** Seconds before the deadline under which a swap is not signed any more (the next block could land after it). */
export const DEADLINE_MARGIN_S = 30;

/**
 * Whether the swap (or wrap) can go ahead on a fresh pre-check. `feeWei` is
 * the worst-case network fee once prepared; `amountOutMin` and `deadline` are
 * the bounds already on the confirm screen, checked again before signing.
 */
export function swapProblem(
  tokenIn: SwapToken,
  tokenOut: SwapToken,
  amountIn: bigint,
  pf: SwapPreflight,
  opts: { feeWei?: bigint; amountOutMin?: bigint; deadline?: bigint; wrap?: boolean } = {},
): SwapProblem | null {
  const fee = opts.feeWei ?? 0n;
  if (pf.balanceIn < amountIn) {
    return { code: 'funds', message: `This account holds ${fmt(pf.balanceIn, tokenIn)}, less than the ${fmt(amountIn, tokenIn)} to ${opts.wrap ? 'convert' : 'swap'}.` };
  }
  if (tokenIn.address === null) {
    if (amountIn + fee > pf.nativeBalance) {
      return {
        code: 'gas',
        message: `${fmt(amountIn, FMX)} plus up to ${fmt(fee, FMX, 8)} network fee is more than the ${fmt(pf.nativeBalance, FMX)} this account holds. Use Max: it keeps the fee back.`,
      };
    }
  } else if (fee > pf.nativeBalance) {
    return { code: 'gas', message: `The network fee is paid in FMX: this needs up to ${fmt(fee, FMX, 8)} and the account holds ${fmt(pf.nativeBalance, FMX, 8)}.` };
  }
  if (!opts.wrap) {
    if (!pf.amounts || pf.amounts.length < 2 || pf.amounts[pf.amounts.length - 1]! <= 0n) {
      return { code: 'no-route', message: `The router no longer quotes ${tokenIn.symbol} → ${tokenOut.symbol} on this route. Review the swap again.` };
    }
    const out = pf.amounts[pf.amounts.length - 1]!;
    if (opts.amountOutMin !== undefined && out < opts.amountOutMin) {
      return {
        code: 'moved',
        message: `The price moved: this swap would now pay ${fmt(out, tokenOut)}, below your minimum of ${fmt(opts.amountOutMin, tokenOut)}. Nothing was signed.`,
      };
    }
    if (opts.deadline !== undefined && BigInt(pf.blockTime + DEADLINE_MARGIN_S) >= opts.deadline) {
      return { code: 'expired', message: 'The swap’s deadline has passed (or is seconds away), so the router would refuse it. Review it again for a new one.' };
    }
  }
  return null;
}

/** The input still to be approved to the router: 0 when the allowance covers it. */
export function allowanceShortfall(pf: SwapPreflight, amountIn: bigint): bigint {
  if (pf.allowance === null) return 0n;
  return pf.allowance >= amountIn ? 0n : amountIn - pf.allowance;
}

/** deadline = the chain's latest block time + the setting. The phone's clock plays no part. */
export function deadlineFrom(blockTime: number, minutes: number): bigint {
  return BigInt(Math.floor(blockTime) + Math.round(minutes * 60));
}

/* ------------------------------------------------------------------ */
/* After the swap                                                      */
/* ------------------------------------------------------------------ */

const SWAP_TOPIC = pairIface.getEvent('Swap')!.topicHash;

export interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

/**
 * What the last pool of the route paid out, from its Swap event in the
 * receipt: the amount the account received (for FMX, before the router
 * unwrapped it — the same number). Null when that pool logged no swap.
 */
export function receivedFromLogs(logs: readonly LogLike[], lastPair: string): bigint | null {
  let out: bigint | null = null;
  for (const l of logs) {
    if (!same(l.address, lastPair) || l.topics[0]?.toLowerCase() !== SWAP_TOPIC) continue;
    try {
      const ev = pairIface.decodeEventLog('Swap', l.data, l.topics);
      out = BigInt(ev.amount0Out) + BigInt(ev.amount1Out);
    } catch {
      /* not this event's shape */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/**
 * "1 FMX = 0.5186 USDF": `amountOut / amountIn` as a decimal with about six
 * significant digits, in integer arithmetic.
 */
export function formatRate(amountIn: bigint, decIn: number, amountOut: bigint, decOut: number): string {
  if (amountIn <= 0n) return '—';
  // rate scaled by 10^18: amountOut·10^decIn·10^18 / (amountIn·10^decOut)
  const scaled = (amountOut * 10n ** BigInt(decIn) * 10n ** 18n) / (amountIn * 10n ** BigInt(decOut));
  if (scaled === 0n) return '0';
  const whole = scaled / 10n ** 18n;
  if (whole >= 1000n) return formatAmount(scaled, 18, 2);
  if (whole >= 1n) return formatAmount(scaled, 18, 4);
  // below 1: keep six significant digits
  const digits = scaled.toString().length; // < 19
  const leadingZeros = 18 - digits;
  return formatAmount(scaled, 18, Math.min(18, leadingZeros + 6));
}
