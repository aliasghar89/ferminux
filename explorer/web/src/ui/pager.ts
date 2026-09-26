/* Cursor pagination (§4.10, §3.7). The index can't seek: Newer / Older only, with a stack of cursors kept
   in history.state so "Newer" goes back exactly. A deep link has no stack, so Newer becomes "Newest".
     Left:  "Page 2 · 50 per page" (+ " of N" only where the total is exact)
     Right: Newest (from page ≥ 3) · ← Newer · Older →   ("End of list" when there is no next cursor)
   Incoming Blockscout links (?page=N&next_page_params=<JSON>, encoded once or twice) are honoured;
   an unreadable cursor shows page 1 with a quiet note. */
import { html, type Html } from "./html";
import { cursorQuery, readCursor, type Cursor } from "../api";
import type { PageParams } from "../types";
import { int } from "../format";
import { navigate } from "../router";

export const PER_PAGE = 50;
export type { Cursor };
/** Read the page cursor from the URL (use the router's `query`). */
export const pageOf = (query: URLSearchParams): Cursor => readCursor(query);

interface PagerState { stack?: (PageParams | null)[] }

/** Button words. "time" lists run newest first (Newest · Newer · Older); "rank" lists are sorted by a value
 *  (balance, holders, relevance), where newer/older would be wrong (First · Previous · Next). */
const WORDS = {
  time: { first: "Newest", prev: "← Newer", next: "Older →" },
  rank: { first: "First", prev: "← Previous", next: "Next →" },
};

export function pagerHtml(o: { page: number; next: PageParams | null; total?: number | null; perPage?: number; expired?: boolean; order?: "time" | "rank" }): Html {
  const w = WORDS[o.order ?? "time"];
  const per = o.perPage ?? PER_PAGE;
  const pages = o.total ? Math.max(1, Math.ceil(o.total / per)) : null;
  const stack = ((history.state ?? {}) as PagerState).stack ?? [];
  const canBack = o.page > 1 && stack.length >= o.page - 1;
  return html`<nav class="xpager" aria-label="Pages">
  <span>Page ${int(o.page)}${pages ? html` of ${int(pages)}` : ""} · ${per} per page${o.expired ? html` <span class="end">· That page link has expired; showing the ${o.order === "rank" ? "first page" : "newest"}.</span>` : ""}</span>
  <span class="btns">
    ${o.page >= 3 || (o.page > 1 && !canBack) ? html`<button type="button" class="btn btn-secondary btn-sm" data-pg="first">${w.first}</button>` : ""}
    ${o.page > 1 && canBack ? html`<button type="button" class="btn btn-secondary btn-sm" data-pg="prev">${w.prev}</button>` : ""}
    ${o.next ? html`<button type="button" class="btn btn-secondary btn-sm" data-pg="next">${w.next}</button>` : html`<span class="end">End of list</span>`}
  </span>
</nav>`;
}

/**
 * Wire the pager under a table. Navigates with the router (a real history entry per page), keeping the
 * cursor stack in history.state; after paging the new page scrolls to the table and focuses its caption.
 */
export function bindPager(root: ParentNode, o: { page: number; next: PageParams | null; current: PageParams | null }) {
  root.querySelector(".xpager")?.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-pg]");
    if (!b) return;
    const base = new URLSearchParams(location.search);
    const stack = [...(((history.state ?? {}) as PagerState).stack ?? [])];
    if (b.dataset.pg === "next" && o.next) {
      stack[o.page - 1] = o.current;
      navigate(location.pathname + cursorQuery(o.page + 1, o.next, base), { state: { stack }, focus: "caption" });
    } else if (b.dataset.pg === "prev") {
      const prev = stack[o.page - 2] ?? null;
      navigate(location.pathname + cursorQuery(o.page - 1, prev, base), { state: { stack: stack.slice(0, o.page - 2) }, focus: "caption" });
    } else if (b.dataset.pg === "first") {
      navigate(location.pathname + cursorQuery(1, null, base), { state: { stack: [] }, focus: "caption" });
    }
  });
}
