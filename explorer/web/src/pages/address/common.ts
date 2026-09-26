/* Shared pieces of the address page's tabs: the page context, a paged table loader, a button seg and the
   direction tag. Local to src/pages/address (the shared ui/ has link segs only, which re-render the page). */
import { html, mount, type Html, type Val } from "../../ui/html";
import { table, tableSkeleton, type Col } from "../../ui/table";
import { pagerHtml, bindPager, pageOf } from "../../ui/pager";
import { slowWatch } from "../../ui/skeleton";
import { empty, showError } from "../../ui/state";
import { lc } from "../../util";
import type { Address, PageParams, Paged } from "../../types";
import type { Cursor } from "../../api";

export interface Ctx {
  /** The address as the URL gave it, then as the index checksums it. */
  a: string;
  signal: AbortSignal;
  query: URLSearchParams;
  /** The tab that was active when the page loaded: only it reads the page cursor from the URL. */
  initialTab: string;
  addr: Address | null;
  isContract: boolean;
  /** The balance read from the chain (eth_getBalance), null when the RPC didn't answer. */
  chainBal?: bigint | null;
  /** Select another tab (e.g. the agent card's "Jobs" link). */
  select(tab: string): void;
}

/** The cursor for a tab: the URL's page for the tab the page opened on, page 1 for the others. */
export const cursorFor = (ctx: Ctx, tab: string): Cursor =>
  ctx.initialTab === tab ? pageOf(ctx.query) : { page: 1, params: null, expired: false };

export const same = (x: string | null | undefined, y: string | null | undefined) => !!x && !!y && lc(x) === lc(y);

/** IN / OUT / SELF against this address. */
export function dirTag(a: string, from: string | null | undefined, to: string | null | undefined): Html {
  const f = same(from, a), t = same(to, a);
  if (f && t) return html`<span class="dir" title="From and to this address">SELF</span>`;
  if (t) return html`<span class="dir in" title="Received by this address">IN</span>`;
  if (f) return html`<span class="dir" title="Sent by this address">OUT</span>`;
  return html``;
}

/** A unit shown only on phone cards, where the column header (which carries the unit) is hidden. */
export const phu = (unit = "FMX") => html`<span class="ad-phu">${unit}</span>`;

/** A segmented filter of buttons (aria-pressed); the caller owns the URL. */
export const segButtons = (label: string, items: { key: string; label: string }[], on: string) =>
  html`<div class="seg" role="group" aria-label="${label}">${items.map((i) => html`<button type="button" data-seg="${i.key}" aria-pressed="${String(i.key === on)}">${i.label}</button>`)}</div>`;
export function bindSeg(host: ParentNode, fn: (key: string) => void) {
  const g = host.querySelector<HTMLElement>(".seg[role=group]");
  g?.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-seg]");
    if (!b || b.getAttribute("aria-pressed") === "true") return;
    g.querySelectorAll("[data-seg]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    fn(b.dataset.seg!);
  });
}

export interface PagedOpts<T> {
  ctx: Ctx;
  tab: string;
  caption: string;
  cols: Col<T>[];
  dense?: boolean;
  sticky?: boolean;
  fetch: (next: PageParams | null, signal: AbortSignal) => Promise<Paged<T>>;
  empty: Val;
  /** Optional markup under the table (a provenance line). */
  foot?: (items: T[]) => Val;
  /** Runs after the rows are in the DOM (lazy method names). */
  after?: (host: HTMLElement, items: T[]) => void;
  /** Skip the URL cursor (a filter change resets to page 1). */
  first?: boolean;
}

/** Load a paged list into `host`: skeleton → table + pager, or the empty line, or the error with Retry. */
export function pagedTable<T>(host: HTMLElement, o: PagedOpts<T>) {
  const c = o.first ? { page: 1, params: null, expired: false } : cursorFor(o.ctx, o.tab);
  const signal = o.ctx.signal;
  mount(host, tableSkeleton({ caption: o.caption, captionHidden: true, cols: o.cols, dense: o.dense }, 8));
  const done = slowWatch(host, () => pagedTable(host, o), signal);
  o.fetch(c.params, signal).then((p) => {
    done();
    if (signal.aborted) return;
    if (!p.items.length && c.page === 1) { mount(host, html`${empty(o.empty)}`); return; }
    const pager = c.page > 1 || p.next_page_params || c.expired ? pagerHtml({ page: c.page, next: p.next_page_params, expired: c.expired }) : "";
    // after paging the router focuses the caption, but a skeleton is visibility:hidden for its first 200 ms, so
    // that focus can miss: move it to the real caption (only on a pager navigation, which carries a cursor stack)
    const refocus = host.contains(document.activeElement) || (document.activeElement === document.body && Array.isArray((history.state as { stack?: unknown } | null)?.stack));
    mount(host, html`${table({ caption: o.caption, captionHidden: true, cols: o.cols, rows: p.items, dense: o.dense, sticky: o.sticky && p.items.length > 15 })}${o.foot ? o.foot(p.items) : ""}${pager}`);
    if (pager) bindPager(host, { page: c.page, next: p.next_page_params, current: c.params });
    if (refocus) host.querySelector<HTMLElement>("caption")?.focus({ preventScroll: true });
    o.after?.(host, p.items);
  }, (e) => { done(); showError(host, e, () => pagedTable(host, o)); });
}

/** Rewrite one query key in place (no history entry), dropping the page cursor. */
export function setQuery(k: string, v: string | null) {
  const u = new URL(location.href);
  if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
  u.searchParams.delete("page"); u.searchParams.delete("next_page_params");
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}
