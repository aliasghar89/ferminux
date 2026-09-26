/* In-memory caches (surfaces/explorer.md §1.3). Nothing is persisted: live data must not outlive the tab.
   - `swr()`: stale-while-revalidate keyed by URL. A fresh hit returns at once; a stale hit returns at once
     AND revalidates in the background (calling `onUpdate` if the value changed); a miss fetches.
     Concurrent callers share one request, and that request is aborted only when EVERY waiter's signal
     has aborted, so a late response never paints into the wrong page yet a shared fetch is not wasted.
   - `LRU`: bounded map for immutable facts (a confirmed block's signer never changes). */

export const TTL = {
  list1: 5_000,        // page 1 of any list
  tx: 600_000,         // a confirmed tx (confirmations are computed from the head store)
  block: 600_000,      // a block below head − 64
  blockNew: 5_000,     // a block near the head
  address: 15_000,
  token: 60_000,
  gw: 60_000,          // gateway agents / accounts
  signers: 60_000,     // clique_getSigners
  stats: 60_000,
  forever: Infinity,
} as const;

type Entry<T> = { v?: T; at: number; ttl: number; flight?: Flight<T> };
type Flight<T> = { p: Promise<T>; ctl: AbortController; waiters: number };

const mem = new Map<string, Entry<unknown>>();
const MAX = 600;

function touch(key: string, e: Entry<unknown>) {
  mem.delete(key); mem.set(key, e);
  if (mem.size > MAX) { const k = mem.keys().next().value; if (k !== undefined) mem.delete(k); }
}

function start<T>(key: string, e: Entry<T>, load: (s: AbortSignal) => Promise<T>, ttl: number): Flight<T> {
  const ctl = new AbortController();
  const f: Flight<T> = { ctl, waiters: 0, p: undefined as unknown as Promise<T> };
  f.p = load(ctl.signal).then((v) => { e.v = v; e.at = Date.now(); e.ttl = ttl; return v; })
    .finally(() => { if (e.flight === f) e.flight = undefined; });
  e.flight = f;
  touch(key, e as Entry<unknown>);
  return f;
}

/** Wait for a shared flight, leaving it when our own signal aborts. */
function join<T>(f: Flight<T>, signal?: AbortSignal): Promise<T> {
  f.waiters++;
  if (!signal) return f.p;
  if (signal.aborted) { f.waiters--; if (f.waiters <= 0) f.ctl.abort(); return Promise.reject(new DOMException("Aborted", "AbortError")); }
  return new Promise<T>((res, rej) => {
    const off = () => { f.waiters--; if (f.waiters <= 0) f.ctl.abort(); rej(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", off, { once: true });
    f.p.then((v) => { signal.removeEventListener("abort", off); res(v); }, (err) => { signal.removeEventListener("abort", off); rej(err); });
  });
}

export interface SwrOpts<T> {
  signal?: AbortSignal;
  /** Called when a background revalidation returns a value that differs from the one already returned. */
  onUpdate?: (v: T) => void;
  /** Skip the cache for this read (still stores the result). */
  fresh?: boolean;
}

export function swr<T>(key: string, ttl: number, load: (s: AbortSignal) => Promise<T>, o: SwrOpts<T> = {}): Promise<T> {
  let e = mem.get(key) as Entry<T> | undefined;
  const now = Date.now();
  if (e && e.v !== undefined && !o.fresh) {
    touch(key, e as Entry<unknown>);
    if (now - e.at < e.ttl) return Promise.resolve(e.v);
    // stale: answer from cache now, revalidate once in the background
    const old = e.v;
    if (!e.flight) {
      const f = start(key, e, load, ttl);
      f.waiters++; // the background waiter never aborts
      f.p.then((v) => { if (o.onUpdate && JSON.stringify(v) !== JSON.stringify(old)) o.onUpdate(v); }, () => { /* keep the stale value */ });
    }
    return Promise.resolve(old);
  }
  if (!e) { e = { at: 0, ttl }; }
  const f = e.flight ?? start(key, e, load, ttl);
  return join(f, o.signal);
}

/** Read a cached value without fetching (e.g. the tokens list for a symbol match). */
export function peek<T>(key: string): T | undefined {
  return (mem.get(key) as Entry<T> | undefined)?.v;
}
export function drop(prefix: string) {
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
}

/** A small LRU for immutable facts. */
export class LRU<K, V> {
  private m = new Map<K, V>();
  constructor(private max = 5000) {}
  get(k: K): V | undefined {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k) as V;
    this.m.delete(k); this.m.set(k, v);
    return v;
  }
  has(k: K) { return this.m.has(k); }
  set(k: K, v: V) {
    this.m.delete(k); this.m.set(k, v);
    if (this.m.size > this.max) { const first = this.m.keys().next(); if (!first.done) this.m.delete(first.value); }
    return this;
  }
  get size() { return this.m.size; }
}
