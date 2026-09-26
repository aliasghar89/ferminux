/* The head store (surfaces/explorer.md §7.2; motion.md §2.7). ONE reader for the whole app:
   RPC eth_getBlockByNumber("latest", false), self-scheduling so it lands on the block, not on a timer:
     next = clamp((headTs + 7.2) × 1000 − now, 1500, 7000);
     head didn't move → retry at +1500 ms up to 3 times, then 7000 ms;
     stopped while document.hidden; one immediate read on visibilitychange.
   It emits {n, ts, baseFee, txCount, signer, difficulty} once the signer is known (one short RPC), so
   digits, caption and seal land together. The first read is not a "new block" event (motion.md §2.7). */
import { rpc } from "./rpc";
import { signerAt, noteHead } from "./signer";
import { onAbort } from "./util";

export interface Head { n: number; hash: string; ts: number; baseFee: bigint | null; txCount: number; gasUsed: bigint; gasLimit: bigint; difficulty: number; signer: string | null; extraData: string }
export type HeadState = "init" | "ok" | "stale" | "down";
/** fn(head, prev): prev is null on the first read (never animate a block event for it). */
type Sub = (h: Head, prev: Head | null) => void;

let head: Head | null = null;
let failed = false;
let timer = 0, same = 0, started = false, reading = false;
const subs = new Set<Sub>();
const stateSubs = new Set<(s: HeadState) => void>();

export const currentHead = () => head;
/** ok: head < 21 s old · stale: 21–60 s · down: the RPC failed or > 60 s (§4.17). */
export function headState(): HeadState {
  if (!head) return failed ? "down" : "init";
  if (failed) return "down";
  const age = Date.now() / 1000 - head.ts;
  return age < 21 ? "ok" : age <= 60 ? "stale" : "down";
}
export const headAge = () => (head ? Math.max(0, Date.now() / 1000 - head.ts) : null);

async function read() {
  timer = 0;
  if (document.hidden || reading) return;
  reading = true;
  let next = 7000;
  try {
    const b = await rpc.block("latest");
    if (!b) throw new Error("no head");
    failed = false;
    const n = Number(BigInt(b.number));
    if (!head || n > head.n) {
      noteHead(n);
      const signer = await signerAt(n).catch(() => null);
      const h: Head = {
        n, hash: b.hash, ts: Number(BigInt(b.timestamp)), baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : null,
        txCount: b.transactions.length, gasUsed: BigInt(b.gasUsed), gasLimit: BigInt(b.gasLimit),
        difficulty: Number(BigInt(b.difficulty)), signer: signer ?? null, extraData: b.extraData,
      };
      const prev = head;
      head = h; same = 0;
      subs.forEach((f) => { try { f(h, prev); } catch (e) { console.error(e); } });
      next = Math.min(7000, Math.max(1500, (h.ts + 7.2) * 1000 - Date.now()));
    } else {
      same++;
      next = same <= 3 ? 1500 : 7000;
    }
  } catch {
    failed = true;
    next = 7000; // rpc.ts adds its own ×2 back-off on a 503
  } finally {
    reading = false;
  }
  stateSubs.forEach((f) => f(headState()));
  if (!document.hidden) timer = window.setTimeout(read, next);
}

/** Start the reader once (main.ts). */
export function startHead() {
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (timer) clearTimeout(timer); timer = 0; }
    else if (!timer) read();
  });
  read();
}

/**
 * Subscribe for the life of a page: unsubscribes when `signal` aborts. With `now`, fn runs at once with
 * the current head (prev = null), so a page can paint from it without waiting up to 7 s.
 */
export function onHead(fn: Sub, signal?: AbortSignal, o: { now?: boolean } = {}) {
  subs.add(fn);
  if (o.now && head) fn(head, null);
  onAbort(signal, () => subs.delete(fn));
  return () => subs.delete(fn);
}
export function onHeadState(fn: (s: HeadState) => void, signal?: AbortSignal) {
  stateSubs.add(fn);
  onAbort(signal, () => stateSubs.delete(fn));
}
/** Resolve with the first head (or the current one). */
export function firstHead(signal?: AbortSignal): Promise<Head> {
  if (head) return Promise.resolve(head);
  return new Promise((res, rej) => {
    const off = onHead((h) => { off(); res(h); }, signal);
    onAbort(signal, () => rej(new DOMException("Aborted", "AbortError")));
  });
}
