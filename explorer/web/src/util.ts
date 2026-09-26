/* Small shared helpers: page-scoped timers (they stop when the page's signal aborts and while the tab is
   hidden, §7.2 "polling only while !document.hidden"), sleeps and debounce. */

/** True while the tab is visible. Every poll checks this. */
export const visible = () => !document.hidden;

/** Run `fn` when `signal` aborts (immediately if it already has). */
export function onAbort(signal: AbortSignal | undefined, fn: () => void) {
  if (!signal) return;
  if (signal.aborted) fn();
  else signal.addEventListener("abort", fn, { once: true });
}

/**
 * Call `fn` every `ms` while the tab is visible, until `signal` aborts. When the tab comes back from
 * hidden it runs once at once (a fresh read), then resumes the cadence. Never overlaps itself.
 */
export function every(ms: number, fn: () => unknown | Promise<unknown>, signal: AbortSignal, opts: { now?: boolean } = {}) {
  let t = 0, busy = false;
  const run = async () => {
    t = 0;
    if (signal.aborted) return;
    if (!visible()) return; // resumed by visibilitychange
    if (!busy) { busy = true; try { await fn(); } catch { /* the caller shows its own error state */ } finally { busy = false; } }
    if (!signal.aborted) t = window.setTimeout(run, ms);
  };
  const vis = () => { if (visible() && !t && !signal.aborted) run(); };
  document.addEventListener("visibilitychange", vis);
  onAbort(signal, () => { if (t) clearTimeout(t); document.removeEventListener("visibilitychange", vis); });
  if (opts.now) run(); else t = window.setTimeout(run, ms);
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  onAbort(signal, () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); });
});

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => { if (t) clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** sessionStorage / localStorage that never throws (private mode, blocked site data, previews). */
export const store = {
  get(k: string, s: "local" | "session" = "local"): string | null { try { return (s === "local" ? localStorage : sessionStorage).getItem(k); } catch { return null; } },
  set(k: string, v: string, s: "local" | "session" = "local") { try { (s === "local" ? localStorage : sessionStorage).setItem(k, v); } catch { /* ignore */ } },
  del(k: string, s: "local" | "session" = "local") { try { (s === "local" ? localStorage : sessionStorage).removeItem(k); } catch { /* ignore */ } },
};

/** Lower-case 0x address for map keys. */
export const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();
export const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);
export const ZERO = "0x0000000000000000000000000000000000000000";
