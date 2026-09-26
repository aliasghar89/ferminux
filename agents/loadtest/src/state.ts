// Persisted state (DATA_DIR/state.json), written atomically (temp file, fsync, rename) BEFORE every
// broadcast, so a restart at any moment resumes exactly: the next index, every wave's plan and progress,
// every signed transaction that may be in flight (the write-ahead log, with the raw signed bytes so it can
// be rebroadcast as-is), the nonces, and the counters.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { freshOrganic, type OrganicState } from "./organic.js";

export type Kind = "fund" | "transfer" | "sweep" | "final" | "sink";
export const KINDS: Kind[] = ["fund", "transfer", "sweep", "final", "sink"];

export interface Variant {
  hash: string;
  raw: string;
  maxFee: string;
  tip: string;
  value: string;
  at: number;
}

/** A signed transaction that has not been seen in a block yet. */
export interface PendingTx {
  id: string;
  kind: Kind;
  /** wallet index of the sender (0 = the float) */
  from: number;
  to: string;
  nonce: number;
  /** wave id and item position, when the tx belongs to a wave */
  wave: number | null;
  item: number | null;
  /** every variant signed for this nonce (a fee bump adds one); whichever lands is the one counted */
  variants: Variant[];
  /** the node accepted at least one broadcast */
  accepted: boolean;
  firstAt: number;
  lastBroadcastAt: number;
  /** sweeps: the balance the value was computed from (a fee bump recomputes the value from it) */
  balance?: string;
}

export type ItemStatus = "planned" | "sent" | "done" | "failed";
export interface Item {
  kind: "fund" | "transfer" | "sweep";
  from: number;
  /** recipient wallet index (0 = the float) */
  to: number;
  value: string;
  status: ItemStatus;
  hash?: string;
  /** sweeps: the balance the value is computed from (the value is recomputed with the fees at signing) */
  balance?: string;
}

export type Phase = "fund" | "transfer" | "sweep" | "verify" | "done";
export interface Wave {
  id: number;
  pass: number;
  indices: number[];
  phase: Phase;
  items: Item[];
  /** next nonce per wallet index (wallet senders only; the float's nonce is global) */
  nonces: Record<string, number>;
  fundedWei: string;
  createdAt: number;
  sweepRounds: number;
}

export interface Counters {
  /** every load-test transaction seen in a block (all kinds, success or not) */
  transactions: number;
  byKind: Record<Kind, number>;
  failed: number;
  volumeWei: string;
  gasWei: string;
}

export interface FinalSweep {
  reason: "pass" | "drain";
  pass: number;
  cursor: number;
  upTo: number;
  /** wallets of the current batch still to sweep: their nonce and the balance the value is computed from */
  queue: { i: number; nonce: number; balance: string }[];
  /** wallets whose sweep is in flight in this batch */
  inflight: number[];
  /** the float's closing transfer to the sink has been sent */
  closing: boolean;
}

/**
 * The explorer index's own network total as last read, with the load-test count at the moment the index
 * recounted it (see Runner.readIndex). The index caches its totals (every 5 min on explorer.ferminux.net,
 * explorer/envs/backend.env), so the explorer subtracts the count that belongs to the figure it shows, not
 * the live counter.
 */
export interface IndexSnap {
  /** the index's figure (total transactions, total addresses, or transactions in the last 24 h) */
  index: number;
  /** the matching load-test count: the middle of [lo, hi], or hi when lo is unknown */
  lt: number;
  /** when the runner saw the index change to this figure (unix s) */
  at: number;
  /** our count at the previous read, when the index still showed its previous figure (null: unknown, e.g. the
   *  first read ever); the recount happened between the two reads, so the figure holds lo … hi of ours */
  lo?: number | null;
  /** our count at the read that saw the new figure */
  hi?: number;
}
export type SnapKey = "transactions" | "addresses" | "last24h";
export const SNAP_KEYS: SnapKey[] = ["transactions", "addresses", "last24h"];
export const MAX_SNAPS = 24;

/** The last read of the index's figures and our counts at that moment (kept across restarts, so the first
 *  recount after a restart is still bracketed). */
export interface IndexRead {
  at: number;
  fig: Partial<Record<SnapKey, number>>;
  lt: Record<SnapKey, number>;
}

export interface State {
  v: 1;
  createdAt: number;
  firstLiveAt: number | null;
  pass: number;
  nextIndex: number;
  highestActivated: number;
  waveSeq: number;
  waves: Wave[];
  pending: PendingTx[];
  floatNonce: number | null;
  floatUsed: boolean;
  counters: Counters;
  /** UTC day (YYYY-MM-DD, block time) → load-test transactions in blocks of that day */
  daily: Record<string, number>;
  /** 10-minute buckets (unix seconds / 600) → transactions; the last 48 hours only (for the rolling 24 h figure) */
  tenMin: Record<string, number>;
  firstTx: { at: number; block: number } | null;
  lastTx: { at: number; block: number } | null;
  lastSinkSweepAt: number;
  finalSweep: FinalSweep | null;
  drained: boolean;
  lastPause: { reason: string; at: number } | null;
  /** sink transfers made, for the record */
  sinkTransfers: { hash: string; valueWei: string; at: number; block: number }[];
  /** the explorer index's figures, newest last (MAX_SNAPS each), and the last read */
  indexSnap: Record<SnapKey, IndexSnap[]>;
  indexRead: IndexRead | null;
  /** before indexRead: the last figure read per key (read once, to migrate) */
  indexSeen?: Partial<Record<SnapKey, number>>;
  /** the lowest block that can hold a load-test transaction: the head when the runner first went live */
  ltFromBlock: number | null;
  /** the chain walk that counts organic transactions (organic.ts) */
  organic: OrganicState;
}

export function freshState(now: number): State {
  return {
    v: 1, createdAt: now, firstLiveAt: null, pass: 1, nextIndex: 1, highestActivated: 0, waveSeq: 0, waves: [], pending: [],
    floatNonce: null, floatUsed: false,
    counters: { transactions: 0, byKind: { fund: 0, transfer: 0, sweep: 0, final: 0, sink: 0 }, failed: 0, volumeWei: "0", gasWei: "0" },
    daily: {}, tenMin: {}, firstTx: null, lastTx: null, lastSinkSweepAt: now, finalSweep: null, drained: false, lastPause: null, sinkTransfers: [],
    indexSnap: { transactions: [], addresses: [], last24h: [] }, indexRead: null, ltFromBlock: null, organic: freshOrganic(),
  };
}

/** Write a file atomically and durably: temp file in the same directory, fsync, rename. */
export function writeAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export class Store {
  state: State;
  constructor(readonly file: string, now: number) {
    this.state = existsSync(file) ? Store.parse(readFileSync(file, "utf8")) : freshState(now);
  }
  static parse(text: string): State {
    const s = JSON.parse(text) as State;
    if (s.v !== 1) throw new Error(`state.json: unknown version ${String((s as { v?: unknown }).v)}`);
    // fields added later default here
    s.sinkTransfers ??= [];
    s.tenMin ??= {};
    s.indexSnap ??= { transactions: [], addresses: [], last24h: [] };
    s.indexRead ??= null;
    // a run from before ltFromBlock: its first confirmed block (the lowest one any receipt had), with a margin
    // (live but nothing confirmed yet: the runner sets it from the head, Runner.walkOrganic)
    s.ltFromBlock ??= s.firstTx ? Math.max(0, s.firstTx.block - 20) : null;
    s.organic ??= freshOrganic();
    return s;
  }
  save(): void {
    writeAtomic(this.file, JSON.stringify(this.state));
  }
}

export const dayOf = (unixS: number) => new Date(unixS * 1000).toISOString().slice(0, 10);
/** The 10-minute bucket a block time falls in. */
export const tenMinOf = (unixS: number) => String(Math.floor(unixS / 600));
