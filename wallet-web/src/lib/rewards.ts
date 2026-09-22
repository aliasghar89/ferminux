// Mining (block-reward) history + the merged Activity feed.
//
// Ferminux is proof-of-work. A block reward is NOT a transaction — the miner's
// balance is credited directly in state — so an actively mining address has an
// empty /transactions list while earning 6 FMX a block. Two Blockscout v2
// endpoints expose those credits:
//
//   /addresses/{a}/coin-balance-history  per-block balance deltas
//   /addresses/{a}/blocks-validated      blocks this address mined (+ exact reward)
//
// Everything here is pure except the two `fetch*` helpers, and both of those
// degrade to "no data" rather than throwing the wallet offline.

import { toBlockNumber, type ActivityItem } from './activity.ts';

/* ------------------------------------------------------------------ *
 * Raw shapes
 * ------------------------------------------------------------------ */

/** One row of /coin-balance-history: the address's balance after `blockNumber`. */
export interface BalanceHistoryEntry {
  blockNumber: number;
  /** Signed change in wei across that block. */
  deltaWei: bigint;
  /** Balance in wei after the block. */
  valueWei: bigint;
  timestamp: string | null;
  /** Set when the explorer could attribute the change to a single transaction. */
  txHash: string | null;
}

/** One row of /blocks-validated: a block this address mined. */
export interface ValidatedBlock {
  height: number;
  hash: string | null;
  timestamp: string | null;
  /** Sum of the block's reward entries, in wei. */
  rewardWei: bigint;
}

function toBigInt(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    try {
      return BigInt(raw.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Pure parser for /api/v2/addresses/{addr}/coin-balance-history. */
export function parseBalanceHistory(payload: unknown): BalanceHistoryEntry[] {
  const items = (payload as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: BalanceHistoryEntry[] = [];
  for (const raw of items) {
    const row = raw as Record<string, unknown>;
    const blockNumber = toBlockNumber(row.block_number);
    if (blockNumber === null) continue;
    const deltaWei = toBigInt(row.delta);
    if (deltaWei === null) continue;
    out.push({
      blockNumber,
      deltaWei,
      valueWei: toBigInt(row.value) ?? 0n,
      timestamp: typeof row.block_timestamp === 'string' ? row.block_timestamp : null,
      txHash: typeof row.transaction_hash === 'string' && row.transaction_hash !== '' ? row.transaction_hash : null,
    });
  }
  return out;
}

/** Pure parser for /api/v2/addresses/{addr}/blocks-validated. */
export function parseValidatedBlocks(payload: unknown): ValidatedBlock[] {
  const items = (payload as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: ValidatedBlock[] = [];
  for (const raw of items) {
    const row = raw as Record<string, unknown>;
    const height = toBlockNumber(row.height);
    if (height === null) continue;
    let rewardWei = 0n;
    if (Array.isArray(row.rewards)) {
      for (const r of row.rewards as Array<Record<string, unknown>>) {
        const v = toBigInt(r?.reward);
        if (v !== null) rewardWei += v;
      }
    }
    out.push({
      height,
      hash: typeof row.hash === 'string' && row.hash !== '' ? row.hash : null,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
      rewardWei,
    });
  }
  return out;
}

/** True when the explorer says there is another page beyond what we fetched. */
export function hasNextPage(payload: unknown): boolean {
  const next = (payload as { next_page_params?: unknown } | null)?.next_page_params;
  return next !== null && next !== undefined && typeof next === 'object';
}

/* ------------------------------------------------------------------ *
 * Merged feed
 * ------------------------------------------------------------------ */

export type FeedRow =
  | { kind: 'tx'; id: string; blockNumber: number | null; timestamp: string | null; tx: ActivityItem }
  | {
      kind: 'mined';
      id: string;
      blockNumber: number;
      timestamp: string | null;
      rewardWei: bigint;
      blockHash: string | null;
      /**
       * 'validated'  — from /blocks-validated: the reward figure is exact.
       * 'balance'    — inferred from an unattributed positive balance delta.
       */
      source: 'validated' | 'balance';
    };

/**
 * Merge transactions, validated blocks and balance deltas into one
 * chronological feed.
 *
 * Attribution rules — deliberately conservative, because showing a phantom
 * "+6 FMX mined" row would be worse than showing nothing:
 *
 *  1. /blocks-validated is authoritative for WHICH blocks were mined, and for
 *     the reward figure when it has one. Blockscout indexes a block before it
 *     computes its reward, so a just-mined block can come back with
 *     `rewards: []`; in that case the block's own unattributed balance credit
 *     is used instead (marked as inferred), and if there is no such credit the
 *     reward is left at 0 = "not known yet" and excluded from totals.
 *  2. A balance-history row is only promoted to a Mined row of its own when
 *     the credit cannot be explained any other way: the delta is positive, the
 *     explorer attributed it to no transaction, the block is not already
 *     covered by rule 1, and no transaction of ours landed in that block. That
 *     last condition is the dedup: when a reward and a transfer share a block,
 *     the single net delta belongs to the transfer row, not to a second Mined
 *     row.
 *  3. Transactions are deduped by hash.
 *
 * Ordering: newest first — block number descending, pending (no block) on top,
 * timestamp as the tiebreaker, and within one block the transaction is listed
 * above the block reward.
 */
export function buildFeed(
  txs: ActivityItem[],
  history: BalanceHistoryEntry[],
  validated: ValidatedBlock[],
): FeedRow[] {
  const rows: FeedRow[] = [];

  const seenTx = new Set<string>();
  const txBlocks = new Set<number>();
  for (const tx of txs) {
    const key = tx.hash.toLowerCase();
    if (seenTx.has(key)) continue;
    seenTx.add(key);
    if (tx.blockNumber !== null) txBlocks.add(tx.blockNumber);
    rows.push({ kind: 'tx', id: `tx:${key}`, blockNumber: tx.blockNumber, timestamp: tx.timestamp, tx });
  }

  // Unattributed credits, indexed by block: the fallback reward figure and the
  // pool that rule 2 draws from.
  const credits = new Map<number, bigint>();
  for (const entry of history) {
    if (entry.deltaWei <= 0n || entry.txHash !== null) continue;
    if (!credits.has(entry.blockNumber)) credits.set(entry.blockNumber, entry.deltaWei);
  }

  const minedBlocks = new Set<number>();
  for (const b of validated) {
    if (minedBlocks.has(b.height)) continue;
    minedBlocks.add(b.height);
    let rewardWei = b.rewardWei;
    let source: 'validated' | 'balance' = 'validated';
    if (rewardWei === 0n && !txBlocks.has(b.height)) {
      const credit = credits.get(b.height);
      if (credit !== undefined && credit > 0n) {
        rewardWei = credit;
        source = 'balance';
      }
    }
    rows.push({
      kind: 'mined',
      id: `mined:${b.height}`,
      blockNumber: b.height,
      timestamp: b.timestamp,
      rewardWei,
      blockHash: b.hash,
      source,
    });
  }

  for (const entry of history) {
    if (entry.deltaWei <= 0n) continue;
    if (entry.txHash !== null) continue;
    if (minedBlocks.has(entry.blockNumber)) continue;
    if (txBlocks.has(entry.blockNumber)) continue;
    minedBlocks.add(entry.blockNumber);
    rows.push({
      kind: 'mined',
      id: `mined:${entry.blockNumber}`,
      blockNumber: entry.blockNumber,
      timestamp: entry.timestamp,
      rewardWei: entry.deltaWei,
      blockHash: null,
      source: 'balance',
    });
  }

  rows.sort(compareRows);
  return rows;
}

function compareRows(a: FeedRow, b: FeedRow): number {
  // Pending (no block yet) always sits on top.
  const ab = a.blockNumber ?? Number.MAX_SAFE_INTEGER;
  const bb = b.blockNumber ?? Number.MAX_SAFE_INTEGER;
  if (ab !== bb) return bb - ab;

  const at = a.timestamp ? Date.parse(a.timestamp) : NaN;
  const bt = b.timestamp ? Date.parse(b.timestamp) : NaN;
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return bt - at;

  // Same block: the transaction first, then the block reward.
  if (a.kind !== b.kind) return a.kind === 'tx' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Mining summary
 * ------------------------------------------------------------------ */

export interface MiningSummary {
  /** Mined blocks present in the fetched window. */
  blocks: number;
  /** Total reward across those blocks, in wei. */
  totalWei: bigint;
  /** ISO timestamp of the most recent reward, when known. */
  latestTimestamp: string | null;
  /** Highest / lowest mined block in the window. */
  highestBlock: number;
  lowestBlock: number;
  /**
   * false when the explorer signalled further pages — the figures then cover
   * only the fetched window and the UI must say so rather than imply all-time.
   */
  complete: boolean;
  /** true when at least one row's reward was inferred from a balance delta. */
  hasInferred: boolean;
  /**
   * Mined blocks the explorer has not yet published a reward figure for. They
   * count towards `blocks` but contribute nothing to `totalWei`, so the UI has
   * to say the total is short by this many blocks.
   */
  unknownRewards: number;
}

/**
 * Summarise the Mined rows of a feed. Returns null when the address has mined
 * nothing in the window — the caller hides the card entirely rather than
 * rendering a row of zeros.
 */
export function summariseMining(rows: FeedRow[], opts?: { complete?: boolean }): MiningSummary | null {
  const mined = rows.filter((r): r is Extract<FeedRow, { kind: 'mined' }> => r.kind === 'mined');
  if (mined.length === 0) return null;

  let totalWei = 0n;
  let latestTimestamp: string | null = null;
  let latestMs = -Infinity;
  let highestBlock = -Infinity;
  let lowestBlock = Infinity;
  let hasInferred = false;
  let unknownRewards = 0;

  for (const row of mined) {
    totalWei += row.rewardWei;
    if (row.rewardWei === 0n) unknownRewards += 1;
    if (row.source === 'balance') hasInferred = true;
    if (row.blockNumber > highestBlock) highestBlock = row.blockNumber;
    if (row.blockNumber < lowestBlock) lowestBlock = row.blockNumber;
    if (row.timestamp) {
      const ms = Date.parse(row.timestamp);
      if (!Number.isNaN(ms) && ms > latestMs) {
        latestMs = ms;
        latestTimestamp = row.timestamp;
      }
    }
  }

  return {
    blocks: mined.length,
    totalWei,
    latestTimestamp,
    highestBlock,
    lowestBlock,
    complete: opts?.complete ?? false,
    hasInferred,
    unknownRewards,
  };
}

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

export interface MiningData {
  history: BalanceHistoryEntry[];
  validated: ValidatedBlock[];
  /** true when either endpoint answered; false = no mining data at all. */
  available: boolean;
  /** true when neither endpoint reported further pages. */
  complete: boolean;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Explorer API responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch both mining endpoints. Never throws: a Blockscout instance on a
 * non-PoW chain 404s /blocks-validated, and the whole explorer is optional —
 * the caller falls back to transactions-only (or to RPC-only) rather than
 * failing.
 */
export async function fetchMiningData(
  explorerUrl: string,
  address: string,
  opts?: { timeoutMs?: number },
): Promise<MiningData> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const base = `${explorerUrl}/api/v2/addresses/${address}`;
  const [historyRes, validatedRes] = await Promise.allSettled([
    getJson(`${base}/coin-balance-history`, timeoutMs),
    getJson(`${base}/blocks-validated`, timeoutMs),
  ]);

  const historyPayload = historyRes.status === 'fulfilled' ? historyRes.value : undefined;
  const validatedPayload = validatedRes.status === 'fulfilled' ? validatedRes.value : undefined;

  return {
    history: historyPayload !== undefined ? parseBalanceHistory(historyPayload) : [],
    validated: validatedPayload !== undefined ? parseValidatedBlocks(validatedPayload) : [],
    available: historyPayload !== undefined || validatedPayload !== undefined,
    complete: !hasNextPage(historyPayload) && !hasNextPage(validatedPayload),
  };
}
