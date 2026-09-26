// Organic transaction counts, straight from the chain: every transaction of every block, minus the load
// test's own. The explorer's index caches its totals and recounts them on a timer, so "index total − our
// count" is only as good as the guess of WHEN the index counted; at 20 tx/s a few seconds of doubt is a
// hundred transactions, more than the network's organic traffic in a day. This walk needs no guess:
//
//   old blocks      (more than RECENT below the target, and below the first block that can hold a load-test
//                   transaction): eth_getBlockTransactionCountByNumber, 500 blocks a step, all organic
//   recent blocks   eth_getBlockByNumber(n, false): the count and the block time (the rolling 24 h)
//   load-test era   eth_getBlockByNumber(n, true), 10 blocks a step: a transaction is the load test's when
//                   its input starts with the FXLT marker AND its sender is a load-test wallet (the same rule
//                   the explorer labels by); everything else is organic
//
// It walks to head − confirmations, one bounded step per call, reads only, and never throws: a failed read
// leaves the state as it was and is retried on the next step. Until it has caught up once (readyAt), the
// totals cover part of the chain and are not published as figures.
import { MARKER_PREFIX } from "./marker.js";
import { RpcError, hexToNum, toHex, type RpcLike } from "./rpc.js";

export interface OrganicState {
  /** the last block counted (−1: none yet) */
  cursor: number;
  /** organic transactions in blocks 0 … cursor */
  total: number;
  /** load-test transactions found in blocks 0 … cursor (a cross-check of the runner's own counter) */
  loadtest: number;
  /** organic transactions per 10-minute bucket of block time (unix s / 600), the last 48 h */
  ten: Record<string, number>;
  /** when the walk first reached its target (unix s); null while it is still catching up */
  readyAt: number | null;
  /** when the walk last counted a block (unix s) */
  at: number;
}

export const freshOrganic = (): OrganicState => ({ cursor: -1, total: 0, loadtest: 0, ten: {}, readyAt: null, at: 0 });

/** Older than this many blocks below the target, a block's time is more than 48 h back (blocks are ≥ 7 s apart). */
export const RECENT = 30_000;
const COUNTS_PER_STEP = 500;
const HEADERS_PER_STEP = 100;
const FULL_PER_STEP = 10;
const KEEP_BUCKETS = 288; // 48 h of 10-minute buckets

export interface WalkDeps {
  rpc: RpcLike;
  /** the lowest block that can hold a load-test transaction (Infinity: nothing sent yet) */
  ltFrom: number;
  /** is this lower-case address a load-test wallet? */
  isLt: (addr: string) => boolean;
  nowS: number;
}

type RawTx = { from?: unknown; input?: unknown };
type RawBlock = { timestamp?: unknown; transactions?: unknown };

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** One bounded step toward `target` (head − confirmations). True when blocks were counted. */
export async function walkStep(st: OrganicState, target: number, d: WalkDeps): Promise<boolean> {
  if (target <= st.cursor) {
    if (st.readyAt === null && st.cursor >= 0) st.readyAt = d.nowS;
    return false;
  }
  const from = st.cursor + 1;
  const recentFrom = Math.max(0, target - RECENT);
  try {
    if (from < recentFrom && from < d.ltFrom) {
      const to = Math.min(from + COUNTS_PER_STEP - 1, recentFrom - 1, d.ltFrom - 1);
      const r = await d.rpc.batch(range(from, to).map((n) => ({ method: "eth_getBlockTransactionCountByNumber", params: [toHex(n)] })));
      let sum = 0;
      for (const x of r) {
        if (x instanceof RpcError || typeof x !== "string") return false;
        sum += hexToNum(x);
      }
      st.total += sum;
      st.cursor = to;
    } else {
      const full = from >= d.ltFrom;
      let to = Math.min(from + (full ? FULL_PER_STEP : HEADERS_PER_STEP) - 1, target);
      if (!full && to >= d.ltFrom) to = d.ltFrom - 1;
      const r = await d.rpc.batch(range(from, to).map((n) => ({ method: "eth_getBlockByNumber", params: [toHex(n), full] })));
      const blocks: { ts: number; txs: unknown[] }[] = [];
      for (const x of r) {
        const b = x as RawBlock | null;
        if (x instanceof RpcError || !b || typeof b !== "object" || typeof b.timestamp !== "string" || !Array.isArray(b.transactions)) return false;
        blocks.push({ ts: hexToNum(b.timestamp), txs: b.transactions });
      }
      const oldest = Math.floor(d.nowS / 600) - KEEP_BUCKETS;
      for (const b of blocks) {
        let lt = 0;
        if (full) for (const t of b.txs) if (isLoadTestTx(t as RawTx, d.isLt)) lt++;
        const org = b.txs.length - lt;
        st.total += org;
        st.loadtest += lt;
        const k = Math.floor(b.ts / 600);
        if (org && k >= oldest) st.ten[String(k)] = (st.ten[String(k)] ?? 0) + org;
      }
      st.cursor = to;
    }
  } catch {
    return false; // the node didn't answer: the same range is read again next step
  }
  st.at = d.nowS;
  const oldest = Math.floor(d.nowS / 600) - KEEP_BUCKETS;
  for (const k of Object.keys(st.ten)) if (Number(k) < oldest) delete st.ten[k];
  if (st.readyAt === null && st.cursor >= target) st.readyAt = d.nowS;
  return true;
}

function isLoadTestTx(t: RawTx, isLt: (a: string) => boolean): boolean {
  if (!t || typeof t !== "object" || typeof t.input !== "string" || typeof t.from !== "string") return false;
  return t.input.slice(0, 10).toLowerCase() === MARKER_PREFIX && isLt(t.from.toLowerCase());
}

/** Organic transactions in the last 24 h of block time (the current 10-minute bucket and the 143 before it). */
export function organicLast24h(st: OrganicState, nowS: number): number {
  const from = Math.floor(nowS / 600) - 143;
  let n = 0;
  for (const [k, v] of Object.entries(st.ten)) if (Number(k) >= from) n += v;
  return n;
}
