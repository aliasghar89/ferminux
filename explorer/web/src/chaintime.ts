/* Block times from the chain (QA data #8). Some index answers carry wrong block timestamps (the balance history
   rows of an address were hours off), so pages that date a block by height read the header instead.
   - blockTimes(heights): header timestamps, one RPC batch for the misses, cached for good (a confirmed
     block's time never changes; the rare near-head reorg keeps its height's time within seconds).
   - lastBlockAt(times): the last block confirmed at or before each moment, found by interpolation on the
     7-second rhythm: a few batched rounds of header reads for all the moments at once. */
import { rpc } from "./rpc";
import { LRU } from "./cache";
import { currentHead, firstHead } from "./head";

const times = new LRU<number, number>(8000);
const abort = () => new DOMException("Aborted", "AbortError");

/** Header timestamps (Unix seconds) by height. A height the RPC couldn't read is absent from the map. */
export async function blockTimes(heights: number[], signal?: AbortSignal): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const miss: number[] = [];
  for (const n of new Set(heights)) {
    if (!Number.isInteger(n) || n < 0) continue;
    const t = times.get(n);
    if (t !== undefined) out.set(n, t); else miss.push(n);
  }
  if (!miss.length) return out;
  const hs = await Promise.all(miss.map((n) => rpc.block(n, signal).catch(() => null)));
  if (signal?.aborted) throw abort();
  hs.forEach((h, i) => {
    if (!h) return;
    const t = Number(BigInt(h.timestamp));
    times.set(miss[i], t);
    out.set(miss[i], t);
  });
  return out;
}

/**
 * For each moment T (Unix seconds), the height of the last block with timestamp ≤ T (or -1 before genesis).
 * Absent when the chain couldn't be read. Converges in 2–4 rounds; gives up after 10.
 */
export async function lastBlockAt(moments: number[], signal?: AbortSignal): Promise<Map<number, number>> {
  const head = currentHead() ?? await firstHead(signal);
  const out = new Map<number, number>();
  type P = { n: number; t: number };
  const st = moments.map((T) => ({ T, lo: null as P | null, hi: null as P | null, g: Math.max(0, Math.min(head.n, head.n - Math.round((head.ts - T) / 7))) }));
  for (const s of st) if (s.T >= head.ts) out.set(s.T, head.n);
  for (let round = 0; round < 10; round++) {
    const open = st.filter((s) => !out.has(s.T));
    if (!open.length) break;
    // read each guess and the block after it: one batch for every open moment
    const need = open.flatMap((s) => [s.g, s.g + 1].filter((n) => n <= head.n));
    const ts = await blockTimes(need, signal);
    let progressed = false;
    for (const s of open) {
      const a = ts.get(s.g), b = s.g + 1 <= head.n ? ts.get(s.g + 1) : Infinity;
      if (a === undefined || b === undefined) continue;
      progressed = true;
      if (a <= s.T && b > s.T) { out.set(s.T, s.g); continue; }
      if (a <= s.T) s.lo = { n: s.g + 1, t: b as number }; else s.hi = { n: s.g, t: a };
      if (a > s.T && s.g === 0) { out.set(s.T, -1); continue; }
      // the next guess: interpolate inside the bracket when we have one, else step on the 7 s rhythm
      const lo = s.lo, hi = s.hi;
      let g: number;
      if (lo && hi) {
        if (hi.n - lo.n <= 1) { out.set(s.T, lo.t <= s.T ? lo.n : lo.n - 1); continue; }
        const per = (hi.t - lo.t) / (hi.n - lo.n) || 7;
        g = lo.n + Math.floor((s.T - lo.t) / per);
        g = Math.min(hi.n - 1, Math.max(lo.n, g));
      } else if (lo) g = lo.n + Math.max(0, Math.floor((s.T - lo.t) / 7));
      else g = hi!.n - Math.max(1, Math.ceil((hi!.t - s.T) / 7));
      s.g = Math.max(0, Math.min(head.n, g));
    }
    if (!progressed) break; // the RPC is down: leave the rest absent
  }
  return out;
}
