/* Address tabs: Transactions (§5.6: the §5.4 table plus IN / OUT / SELF, filter All · Sent · Received as
   ?filter=from|to) and Token transfers (Tx · Token · From → To · Amount / #id · Age). */
import { html, type Html } from "../../ui/html";
import { addrChip } from "../../ui/hash";
import { txCols, hydrateMethods } from "../../ui/txcols";
import { transferCols } from "../../ui/transfers";
import { type Col } from "../../ui/table";
import { api } from "../../api";
import type { AddressParam, Tx, TokenTransfer } from "../../types";
import { dirTag, pagedTable, segButtons, bindSeg, setQuery, same, type Ctx } from "./common";

/** A party chip; this page's own address is plain text (no link to itself). */
export const party = (ctx: Ctx, p: AddressParam | string | null | undefined): Html => {
  const h = typeof p === "string" ? p : p?.hash;
  return same(h, ctx.a) ? addrChip(p, { href: null, copy: false }) : addrChip(p, { copy: false });
};

const TX_COLS = (ctx: Ctx): Col<Tx>[] => txCols({
  dir: (t) => dirTag(ctx.a, t.from?.hash, t.to?.hash ?? t.created_contract?.hash),
  party: (p) => party(ctx, p),
});

export function txsTab(ctx: Ctx, panel: HTMLElement) {
  const f0 = ctx.query.get("filter");
  let filter: "from" | "to" | null = f0 === "from" || f0 === "to" ? f0 : null;
  panel.innerHTML = html`<div class="seg-row">${segButtons("Transaction direction", [{ key: "", label: "All" }, { key: "from", label: "Sent" }, { key: "to", label: "Received" }], filter ?? "")}</div><div data-list></div>`.s;
  const host = panel.querySelector<HTMLElement>("[data-list]")!;
  const load = (first = false) => pagedTable<Tx>(host, {
    ctx, tab: "txs", first, sticky: true,
    caption: filter === "from" ? "Transactions sent by this address" : filter === "to" ? "Transactions received by this address" : "Transactions of this address",
    cols: TX_COLS(ctx),
    fetch: (next, signal) => api.addressTxs(ctx.a, filter, next, { signal }),
    empty: filter === "from" ? "No transactions sent from this address yet." : filter === "to" ? "No transactions received by this address yet." : "No transactions from or to this address yet.",
    after: (h) => void hydrateMethods(h),
  });
  bindSeg(panel, (k) => { filter = k === "from" || k === "to" ? k : null; setQuery("filter", filter); load(true); });
  load();
}

/* ---------------------------------------------------------------- token transfers */

const TT_COLS = (ctx: Ctx): Col<TokenTransfer>[] => transferCols({
  dir: (t) => dirTag(ctx.a, t.from?.hash, t.to?.hash),
  party: (p) => party(ctx, p),
});

export function transfersTab(ctx: Ctx, panel: HTMLElement) {
  pagedTable<TokenTransfer>(panel, {
    ctx, tab: "token_transfers", sticky: true,
    caption: "Token transfers of this address",
    cols: TT_COLS(ctx),
    fetch: (next, signal) => api.addressTokenTransfers(ctx.a, next, { signal }),
    empty: "No token transfers yet.",
  });
}
