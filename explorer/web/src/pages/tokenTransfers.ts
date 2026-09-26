/* Token transfers `/token-transfers` (§5.16): every token's transfers, newest first, from the index's
   /token-transfers, with All · FRC-20 · FRC-721 (?type=; the index's ERC-* values are accepted too) and the
   cursor pager. */
import { html, mount } from "../ui/html";
import { table, tableSkeleton } from "../ui/table";
import { transferCols } from "../ui/transfers";
import { pagerHtml, bindPager, pageOf } from "../ui/pager";
import { showError, empty } from "../ui/state";
import { api } from "../api";
import { shell, seg, slot } from "./_shell";
import { setMeta, type Params } from "../router";

const COLS = transferCols();

export function render(_p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const t0 = (query.get("type") ?? "").toUpperCase().replace(/^ERC-/, "FRC-");
  const type = t0 === "FRC-20" || t0 === "FRC-721" ? t0 : null;
  const cur = pageOf(query);
  setMeta({ title: type ? `${type} token transfers` : "Token transfers", description: "Token transfers on Ferminux Network (chain 3961): FRC-20 amounts and FRC-721 tokens, newest first." });
  const caption = type ? `${type} token transfers` : "Token transfers";
  shell(root, {
    crumbs: [{ href: "/txs", label: "Transactions" }, { label: "Token transfers" }],
    h1: "Token transfers",
    body: [
      seg("Token standard", [
        { href: "/token-transfers", label: "All", on: !type },
        { href: "/token-transfers?type=FRC-20", label: "FRC-20", on: type === "FRC-20" },
        { href: "/token-transfers?type=FRC-721", label: "FRC-721", on: type === "FRC-721" },
      ]),
      html`<div data-slot="list">${tableSkeleton({ caption, captionHidden: true, cols: COLS }, 10)}</div>`,
    ],
  });
  const load = () => {
    const host = slot(root, "list");
    api.tokenTransfersAll(type, cur.params, { signal }).then((pg) => {
      if (signal.aborted || !host) return;
      if (!pg.items.length && cur.page === 1) { mount(host, empty(type ? `No ${type} transfers yet.` : "No token transfers yet.", { href: "/tokens", label: "Tokens →" })); return; }
      const pager = cur.page > 1 || pg.next_page_params || cur.expired;
      mount(host, html`${table({ caption, captionHidden: true, cols: COLS, rows: pg.items, sticky: pg.items.length > 15 })}${pager ? pagerHtml({ page: cur.page, next: pg.next_page_params, expired: cur.expired }) : ""}`);
      if (pager) bindPager(host, { page: cur.page, next: pg.next_page_params, current: cur.params });
    }, (e) => { if (!signal.aborted) showError(host, e, load); });
  };
  load();
}
