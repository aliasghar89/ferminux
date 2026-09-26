/* Small shared helpers (first used by the stats, contracts and search pages):
   - xpanel(): the .panel frame with a right-hand aside (a provenance tag, a range) instead of a link;
   - put(): write one keyed cell (data-k) without re-rendering its table, so focus is never lost;
   - whenVisible(): run a callback once per element as it nears the viewport (lazy per-row reads);
   - limit(): a concurrency cap, so lazy rows never fire dozens of index requests at once;
   - stat(): a stat cell whose value/sub are filled later by put(). */
import { html, Html, type Val } from "./html";
import { sk } from "./skeleton";
import { onAbort } from "../util";

export const xpanel = (id: string, title: string, body: Val, aside?: Val) =>
  html`<section class="panel xp" id="${id}" aria-labelledby="${id}-h"><div class="panel-head xp-head"><h2 id="${id}-h">${title}</h2>${aside !== undefined ? html`<span class="xp-aside" data-k="${id}-aside">${aside}</span>` : ""}</div><div data-slot="${id}">${body}</div></section>`;

/** Replace the content of the element keyed `data-k="<key>"` inside `root` (no-op when unchanged). */
export function put(root: ParentNode, key: string, h: Html | string) {
  const el = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
  if (!el) return null;
  const s = h instanceof Html ? h.s : String(h).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  if (el.innerHTML !== s) el.innerHTML = s;
  return el;
}
export const keyEl = (root: ParentNode, key: string) => root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);

/** A stat cell: label, a value slot and a sub-line slot (both keyed). The value shows a bar until filled. */
export const stat = (key: string, label: string) =>
  html`<div><span class="l">${label}</span><span class="v" data-k="${key}"><span class="skel">${sk("64px", "20px")}</span></span><span class="s" data-k="${key}-s"></span></div>`;

/** Run `fn(batch)` for elements as they come within 200 px of the viewport, once each. */
export function whenVisible(els: Element[], fn: (batch: Element[]) => void, signal: AbortSignal) {
  if (!("IntersectionObserver" in window)) { fn(els); return; }
  const io = new IntersectionObserver((es) => {
    const batch = es.filter((e) => e.isIntersecting).map((e) => e.target);
    if (!batch.length) return;
    batch.forEach((b) => io.unobserve(b));
    fn(batch);
  }, { rootMargin: "200px 0px" });
  els.forEach((e) => io.observe(e));
  onAbort(signal, () => io.disconnect());
}

/** At most `n` tasks in flight; the rest wait their turn. */
export function limit(n: number) {
  let active = 0;
  const wait: (() => void)[] = [];
  return <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((res, rej) => {
    const run = () => { active++; task().then(res, rej).finally(() => { active--; wait.shift()?.(); }); };
    if (active < n) run(); else wait.push(run);
  });
}

/** "21 Sep" (UTC) from "2026-09-21" or any ISO/seconds value; "21 Sep 2026" with `year`. Fixed month
 *  names: some locales print "Sept". */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(v: string | number, year = false): string {
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
}
