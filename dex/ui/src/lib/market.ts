// ---------------------------------------------------------------------------
// The market record: every pool's event history, kept incrementally, and the
// figures derived from it (volume, fees, fee APR, price and TVL series).
//
// `refreshMarket` scans only what is new since the last refresh (per pool, so
// a pool created today is scanned from the beginning while the others are
// scanned from where they stopped). The last few blocks are always re-read, so
// a short reorg cannot leave a phantom trade in the record. The state is plain
// data and serialises to JSON (bigints as strings), which is how the page keeps
// it between visits without asking the node for the whole history again.
//
// USD figures use lib/prices.ts: FMX at the official price, the pegged tokens
// at their pegs. A trade's USD size is read from the side whose basis is most
// direct (a pegged token first, then FMX, then a derived price).
//
// No browser globals.
// ---------------------------------------------------------------------------

import { FEE_BPS } from './math.ts';
import {
  BlockClock,
  TOPICS,
  assemblePoolEvents,
  decodePoolLog,
  scanLogs,
  type LiquidityLog,
  type LogSource,
  type PoolEvent,
  type PoolLog,
  type RpcSender,
  type SwapLog,
  type SyncLog,
} from './events.ts';
import { E18, feeAprPpm, poolValue, valueUsdE18, e18ToNumber, type PriceTable } from './prices.ts';
import type { PairSnapshot } from './pairs.ts';
import type { TokenInfo } from './tokens.ts';

/** Blocks re-read on every refresh, in case the chain reorganised its tip. */
export const REORG_MARGIN = 6;

export interface MarketState {
  version: 1;
  /** Lowercased pair → last block whose logs are final in `logs`. */
  scanned: Record<string, number>;
  /** Swap, Mint, Burn and Sync logs of every pool, sorted by (block, logIndex). */
  logs: PoolLog[];
}

export function emptyMarket(): MarketState {
  return { version: 1, scanned: {}, logs: [] };
}

/**
 * Bring `state` up to `head` for these pools. Returns a NEW state; the input
 * is not mutated. Timestamps for every block holding a trade or a liquidity
 * change are fetched into `clock`.
 */
export async function refreshMarket(
  state: MarketState,
  opts: {
    source: LogSource;
    rpc: RpcSender;
    clock: BlockClock;
    pairs: string[];
    head: number;
    startBlock: number;
  },
): Promise<MarketState> {
  const { source, rpc, clock, head, startBlock } = opts;
  const pairs = [...new Set(opts.pairs.map((p) => p.toLowerCase()))];
  const scanned = { ...state.scanned };
  let logs = state.logs;

  // Group pools by where their scan resumes, so pools in step share one call.
  const groups = new Map<number, string[]>();
  for (const p of pairs) {
    const from = Math.max(startBlock, (scanned[p] ?? startBlock - 1) + 1);
    if (from > head) continue;
    const list = groups.get(from) ?? [];
    list.push(p);
    groups.set(from, list);
  }

  const fresh: PoolLog[] = [];
  for (const [from, group] of groups) {
    const inGroup = new Set(group);
    // Anything already recorded for these pools at or after `from` is the
    // unconfirmed tail of the last scan: drop it, it is about to be re-read.
    logs = logs.filter((l) => !(inGroup.has(l.pair) && l.block >= from));
    const raw = await scanLogs(
      source,
      { address: group, topics: [[TOPICS.swap, TOPICS.sync, TOPICS.mint, TOPICS.burn]] },
      from,
      head,
    );
    for (const r of raw) {
      const decoded = decodePoolLog(r);
      if (decoded) fresh.push(decoded);
    }
    const safe = Math.max(from - 1, head - REORG_MARGIN);
    for (const p of group) scanned[p] = safe;
  }

  const merged = new Map<string, PoolLog>();
  for (const l of [...logs, ...fresh]) merged.set(`${l.block}:${l.logIndex}`, l);
  const next = [...merged.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  await clock.ensure(
    rpc,
    fresh.filter((l) => l.kind !== 'sync').map((l) => l.block),
  );
  return { version: 1, scanned, logs: next };
}

// -------------------------------------------------------- serialisation -----

type Json = Record<string, unknown>;

export function serializeMarket(state: MarketState): string {
  return JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

export function deserializeMarket(text: string): MarketState | null {
  try {
    const parsed = JSON.parse(text, (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Json;
    if (parsed?.version !== 1 || typeof parsed.scanned !== 'object' || !Array.isArray(parsed.logs)) return null;
    return parsed as unknown as MarketState;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- trades -----

export interface Trade {
  pair: string;
  block: number;
  logIndex: number;
  txHash: string;
  /** Unix seconds; null only before any block time could be read. */
  time: number | null;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  amountOut: bigint;
  /** USD size of the trade (see `tradeUsdE18`), null when neither side has a basis. */
  usdE18: bigint | null;
  /** Who received the output: a trader, the next pool of a route, or the router. */
  to: string;
  /** Reserves right after the trade. */
  reserve0: bigint | null;
  reserve1: bigint | null;
}

const RANK: Record<string, number> = { peg: 0, official: 1, derived: 2 };

/**
 * The USD size of one pool swap: the flow on the side with the most direct
 * basis (a pegged token, then FMX at the official price, then a derived one).
 */
export function tradeUsdE18(swap: SwapLog, pool: PairSnapshot, prices: PriceTable): bigint | null {
  const b0 = prices.get(pool.token0.address.toLowerCase());
  const b1 = prices.get(pool.token1.address.toLowerCase());
  const use0 = b0 && (!b1 || RANK[b0.kind] <= RANK[b1.kind]);
  if (use0 && b0) return valueUsdE18(swap.amount0In + swap.amount0Out, pool.token0.decimals, b0.usdE18);
  if (b1) return valueUsdE18(swap.amount1In + swap.amount1Out, pool.token1.decimals, b1.usdE18);
  return null;
}

/** Every pool swap in the record, as a trade in the pool's own tokens. Oldest first. */
export function tradesFrom(
  state: MarketState,
  pools: Map<string, PairSnapshot>,
  prices: PriceTable,
  clock: BlockClock,
): Trade[] {
  const { events } = assemblePoolEvents(state.logs);
  const out: Trade[] = [];
  for (const e of events) {
    if (e.kind !== 'swap') continue;
    const pool = pools.get(e.pair);
    if (!pool) continue;
    const zeroForOne = e.amount0In > 0n && e.amount1Out > 0n;
    const tokenIn = zeroForOne ? pool.token0 : pool.token1;
    const tokenOut = zeroForOne ? pool.token1 : pool.token0;
    out.push({
      pair: e.pair,
      block: e.block,
      logIndex: e.logIndex,
      txHash: e.txHash,
      time: clock.at(e.block),
      tokenIn,
      tokenOut,
      amountIn: zeroForOne ? e.amount0In : e.amount1In,
      amountOut: zeroForOne ? e.amount1Out : e.amount0Out,
      usdE18: tradeUsdE18(e, pool, prices),
      to: e.to,
      reserve0: e.reserve0,
      reserve1: e.reserve1,
    });
  }
  return out;
}

/** Mint and Burn events of the record, oldest first. */
export function liquidityEvents(state: MarketState): Array<PoolEvent & LiquidityLog> {
  return assemblePoolEvents(state.logs).events.filter((e): e is PoolEvent & LiquidityLog => e.kind !== 'swap');
}

/** Sync logs (the reserve history), oldest first. */
export function syncLogs(state: MarketState): SyncLog[] {
  return state.logs.filter((l): l is SyncLog => l.kind === 'sync');
}

// ---------------------------------------------------------------- stats -----

export const DAY = 86_400;

export interface PoolStats {
  pair: string;
  tvlUsdE18: bigint | null;
  tvlEstimated: boolean;
  volume24hUsdE18: bigint;
  volume7dUsdE18: bigint;
  fees24hUsdE18: bigint;
  fees7dUsdE18: bigint;
  trades24h: number;
  trades7d: number;
  tradesAll: number;
  /** Fee APR from the last 24 h and from the last 7 days, parts per million. */
  apr24hPpm: bigint | null;
  apr7dPpm: bigint | null;
  lastTradeTime: number | null;
}

/** The LP fee on a trade of this USD size (0.30%, left in the pool for LPs). */
export function feeUsdE18(volumeUsdE18: bigint): bigint {
  return (volumeUsdE18 * BigInt(FEE_BPS)) / 10_000n;
}

export function poolStats(pool: PairSnapshot, trades: Trade[], prices: PriceTable, now: number): PoolStats {
  const pair = pool.pair.toLowerCase();
  const mine = trades.filter((t) => t.pair === pair);
  const since = (sec: number) => mine.filter((t) => t.time !== null && t.time > now - sec);
  const sum = (list: Trade[]) => list.reduce((acc, t) => acc + (t.usdE18 ?? 0n), 0n);
  const d1 = since(DAY);
  const d7 = since(7 * DAY);
  const value = poolValue(pool, prices);
  const vol24 = sum(d1);
  const vol7 = sum(d7);
  const fees24 = feeUsdE18(vol24);
  const fees7 = feeUsdE18(vol7);
  const last = mine.length > 0 ? mine[mine.length - 1].time : null;
  return {
    pair,
    tvlUsdE18: value.tvlUsdE18,
    tvlEstimated: value.estimated,
    volume24hUsdE18: vol24,
    volume7dUsdE18: vol7,
    fees24hUsdE18: fees24,
    fees7dUsdE18: fees7,
    trades24h: d1.length,
    trades7d: d7.length,
    tradesAll: mine.length,
    apr24hPpm: feeAprPpm(fees24, value.tvlUsdE18, 1),
    apr7dPpm: feeAprPpm(fees7, value.tvlUsdE18, 7),
    lastTradeTime: last,
  };
}

export interface MarketOverview {
  tvlUsdE18: bigint;
  volume24hUsdE18: bigint;
  volume7dUsdE18: bigint;
  volumeAllUsdE18: bigint;
  fees24hUsdE18: bigint;
  trades24h: number;
  tradesAll: number;
  pools: number;
  /** Pools whose TVL could be valued at all. */
  pricedPools: number;
}

export function marketOverview(stats: PoolStats[], trades: Trade[]): MarketOverview {
  let tvl = 0n;
  let priced = 0;
  for (const s of stats) {
    if (s.tvlUsdE18 !== null) {
      tvl += s.tvlUsdE18;
      priced += 1;
    }
  }
  const vol24 = stats.reduce((a, s) => a + s.volume24hUsdE18, 0n);
  return {
    tvlUsdE18: tvl,
    volume24hUsdE18: vol24,
    volume7dUsdE18: stats.reduce((a, s) => a + s.volume7dUsdE18, 0n),
    volumeAllUsdE18: trades.reduce((a, t) => a + (t.usdE18 ?? 0n), 0n),
    fees24hUsdE18: feeUsdE18(vol24),
    trades24h: stats.reduce((a, s) => a + s.trades24h, 0),
    tradesAll: trades.length,
    pools: stats.length,
    pricedPools: priced,
  };
}

// --------------------------------------------------------------- series -----

export interface Point {
  /** Unix seconds. */
  t: number;
  /** Chart value (a JS number: geometry only, never displayed unformatted). */
  v: number;
}

/**
 * Price of `base` in the pool's other token, after every reserve change, as a
 * step series. `usdPerQuoteE18` converts it to USD when given.
 */
export function poolPriceSeries(
  syncs: SyncLog[],
  pool: PairSnapshot,
  base: string,
  clock: BlockClock,
  usdPerQuoteE18?: bigint,
): Point[] {
  const pair = pool.pair.toLowerCase();
  const baseIs0 = pool.token0.address.toLowerCase() === base.toLowerCase();
  const [db, dq] = baseIs0 ? [pool.token0.decimals, pool.token1.decimals] : [pool.token1.decimals, pool.token0.decimals];
  const out: Point[] = [];
  for (const s of syncs) {
    if (s.pair !== pair || s.reserve0 <= 0n || s.reserve1 <= 0n) continue;
    const t = clock.at(s.block);
    if (t === null) continue;
    const [rb, rq] = baseIs0 ? [s.reserve0, s.reserve1] : [s.reserve1, s.reserve0];
    let priceE18 = (rq * 10n ** BigInt(db) * E18) / (rb * 10n ** BigInt(dq));
    if (usdPerQuoteE18 !== undefined) priceE18 = (priceE18 * usdPerQuoteE18) / E18;
    const v = e18ToNumber(priceE18);
    const prev = out[out.length - 1];
    if (prev && prev.t === t) prev.v = v; // several changes in one block: keep the last
    else out.push({ t, v });
  }
  return out;
}

/**
 * Sum of `values` per bucket of `bucketSec` seconds from `from` to `to`
 * (inclusive start, exclusive end), every bucket present, empty ones at 0.
 */
export function bucketSums(
  items: Array<{ time: number | null; usdE18: bigint | null }>,
  bucketSec: number,
  from: number,
  to: number,
): Array<{ t: number; usdE18: bigint }> {
  const start = Math.floor(from / bucketSec) * bucketSec;
  const buckets: Array<{ t: number; usdE18: bigint }> = [];
  for (let t = start; t < to; t += bucketSec) buckets.push({ t, usdE18: 0n });
  for (const it of items) {
    if (it.time === null || it.time < start || it.time >= to) continue;
    const i = Math.floor((it.time - start) / bucketSec);
    if (buckets[i]) buckets[i].usdE18 += it.usdE18 ?? 0n;
  }
  return buckets;
}

/**
 * Total value locked at the end of each bucket: every pool's last reserves at
 * or before that moment, valued at today's bases (the official FMX price and
 * the pegs), summed. A pool counts from its first deposit.
 */
export function tvlSeries(
  syncs: SyncLog[],
  pools: Map<string, PairSnapshot>,
  prices: PriceTable,
  clock: BlockClock,
  bucketSec: number,
  from: number,
  to: number,
): Point[] {
  const timed = syncs
    .map((s) => ({ s, t: clock.at(s.block) }))
    .filter((x): x is { s: SyncLog; t: number } => x.t !== null)
    .sort((a, b) => a.t - b.t);
  const current = new Map<string, SyncLog>();
  const out: Point[] = [];
  let i = 0;
  const start = Math.floor(from / bucketSec) * bucketSec;
  for (let t = start; t < to + bucketSec; t += bucketSec) {
    const end = Math.min(t + bucketSec, to);
    while (i < timed.length && timed[i].t <= end) {
      current.set(timed[i].s.pair, timed[i].s);
      i++;
    }
    let total = 0n;
    for (const [pair, s] of current) {
      const pool = pools.get(pair);
      if (!pool) continue;
      const v = poolValue({ ...pool, reserve0: s.reserve0, reserve1: s.reserve1 }, prices).tvlUsdE18;
      if (v !== null) total += v;
    }
    out.push({ t: end, v: e18ToNumber(total) });
    if (end >= to) break;
  }
  return out;
}
