/* Page conventions (read before writing a page; surfaces/explorer.md §5 is the field spec per page).

   1. A page is a module in src/pages/ exporting
        export function render(params: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement)
      Register it in router.ts: PAGES (lazy import) + ROUTES (pattern, nav section, placeholder title).
   2. Paint the SHELL synchronously, before any await: `shell(root, { crumbs, h1, ident, body })` with
      skeletons in every data slot (ui/skeleton.ts, tableSkeleton). The h1 is real text at once, so the
      router can focus it and announce the page. Skeletons show only after 200 ms (CSS), so no flash.
   3. Fetch through the clients only: api.* (index), rpc.* / signersFor (chain), gw.* (gateway). Pass
      `{ signal }` to every call. After each await: `if (signal.aborted) return;`. Never call fetch().
      Independent panels load in parallel and fail on their own (`showError(host, e, retry)`), and a
      detail page's 404/422 renders `notFound(root, …)` from ./notFound.
   4. Render with the `html` template (ui/html.ts): every interpolation is escaped. Never build markup by
      string concatenation with data. Use the components: addrChip / txChip / blockLink (hash chips),
      seal (signer), table + rowLink (lists → phone cards), kv (detail lists), tabsHtml + bindTabs,
      pagerHtml + bindPager, amt / amtExact / fee / gas / gasUsed / ago / when (figures), pill / txStatus /
      kindTag / prov (marks), empty / note (states).
   5. Words: signer / confirmed; FRC-20 / FRC-721 (the api already translated the index's values);
      "the explorer's index" for the backend. No price, no USD, no market cap. A value we couldn't read
      renders `dash("why")` ("—" with a title), never 0 and never a guess. Computed values carry prov().
   6. Tabs and paging are URL state: resolveTab(page, query) for ?tab= (aliases + honest-gap notes),
      pageOf(query) for ?page=&next_page_params=. Titles: setMeta({ title, description }) once the
      entity is known; setSection() when the nav section depends on the data (address: contract vs account).
   7. Live data: onHead(fn, signal) for the head (never your own block poll); every(ms, fn, signal) for
      anything else, which pauses while the tab is hidden. Digits that change use liveText(); only the
      home feeds animate rows (feedInsert). Everything stops when `signal` aborts. */
import { html, mount, type Html, type Val } from "../ui/html";

export interface Crumb { href?: string; label: string }
export interface ShellOpts { crumbs?: Crumb[]; h1: Val; ident?: Val; body?: Val; headExtra?: Val }

export const crumbs = (list: Crumb[]) =>
  html`<nav class="crumbs" aria-label="Breadcrumb">${list.map((c, i) => html`${i ? html` <span aria-hidden="true">/</span> ` : ""}${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span aria-current="page">${c.label}</span>`}`)}</nav>`;

export const pageHead = (o: ShellOpts): Html =>
  html`<header class="page-head">${o.crumbs ? crumbs(o.crumbs) : ""}<h1 tabindex="-1">${o.h1}</h1>${o.ident !== undefined ? html`<div class="ident">${o.ident}</div>` : ""}${o.headExtra ?? ""}</header>`;

/** Mount the page frame: container, head, then the body slots. */
export function shell(root: HTMLElement, o: ShellOpts) {
  mount(root, html`<div class="container page">${pageHead(o)}<div class="stack">${o.body ?? ""}</div></div>`);
}

/** A panel with a head (h2 + optional link) and a body slot `data-slot="<id>"`. */
export const panel = (id: string, title: string, body: Val, link?: { href: string; label: string }) =>
  html`<section class="panel" aria-labelledby="${id}-h"><div class="panel-head"><h2 id="${id}-h">${title}</h2>${link ? html`<a href="${link.href}">${link.label}</a>` : ""}</div><div data-slot="${id}">${body}</div></section>`;

export const slot = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-slot="${id}"]`);

/** The .seg filter (All · Forked · Uncles …): links, so the router owns the URL. */
export const seg = (label: string, items: { href: string; label: string; on: boolean }[]) =>
  html`<div class="seg-row"><div class="seg" role="group" aria-label="${label}">${items.map((i) => html`<a class="seg-a" href="${i.href}"${i.on ? html` aria-current="true"` : ""}>${i.label}</a>`)}</div></div>`;
