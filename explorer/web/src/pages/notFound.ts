/* 404, not found and invalid input (§5.15). Every state sets robots noindex and the title
   "Not found · Ferminux Explorer". No games, no jokes: what happened, and the way on. */
import { html, mount, type Val } from "../ui/html";
import { omniboxHtml, bindOmnibox } from "../ui/omnibox";
import { setMeta, type Params } from "../router";

export interface NotFoundOpts { h1: Val; body?: Val; query?: string; links?: boolean }

/** Paint a not-found / invalid state into `root` (detail pages call this on a 404 or 422). */
export function notFound(root: HTMLElement, o: NotFoundOpts) {
  setMeta({ title: "Not found", noindex: true, canonical: null });
  mount(root, html`<div class="container"><section class="nf">
    <h1 tabindex="-1">${o.h1}</h1>
    ${o.body ? html`<p>${o.body}</p>` : ""}
    ${omniboxHtml({ large: true, value: o.query ?? "" })}
    ${o.links === false ? "" : html`<p class="links"><a class="link-arrow" href="/blocks">Blocks</a><a class="link-arrow" href="/txs">Transactions</a><a class="link-arrow" href="/tokens">Tokens</a><a class="link-arrow" href="/">Home</a></p>`}
  </section></div>`);
  const f = root.querySelector<HTMLFormElement>("[data-omni]");
  if (f) bindOmnibox(f);
}

/** From an unknown path, the part worth searching for: a 0x value or a block number in any segment
 *  ("/addresss/0x3322…" → "0x3322…"), else nothing. */
function searchable(path: string): string {
  let segs: string[];
  try { segs = decodeURIComponent(path).split("/").filter(Boolean); } catch { segs = path.split("/").filter(Boolean); }
  const hit = segs.find((s) => /^0x[0-9a-f]{4,64}$/i.test(s)) ?? segs.find((s) => /^\d{1,9}$/.test(s));
  return hit ?? "";
}

export function render(_p: Params, _q: URLSearchParams, _s: AbortSignal, root: HTMLElement) {
  const path = location.pathname;
  notFound(root, {
    h1: "This page isn't on the explorer",
    body: html`<span class="hc-full">${path.length > 96 ? `${path.slice(0, 96)}…` : path}</span> doesn't match any page here. Search chain 3961 for a block, a transaction, an address, a token or an agent.`,
    query: searchable(path),
  });
}
