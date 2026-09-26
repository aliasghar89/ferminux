/* Transactions `/txs` (§5.4). Head + identity line ("10,753 on chain · 2 in the last 24 h"), the 24 h stats
   row (index /transactions/stats), two filters that live in the URL (Confirmed · Pending as ?tab=, and the kind
   as ?type=, the index's own values), the table (index /transactions, 50 per page, cursor pager) and the live
   part: on page 1 the list is re-read every 14 s while the tab is visible and a "N new transactions · Show"
   button appears (rows never move under a reader); the Pending list simply refreshes. Method names are decoded
   after first paint by the lazy decode chunk. */
import { html, mount, type Html } from "../ui/html";
import { table, tableSkeleton } from "../ui/table";
import { statSkeleton } from "../ui/skeleton";
import { pagerHtml, bindPager, pageOf } from "../ui/pager";
import { showError, empty } from "../ui/state";
import { api, bs } from "../api";
import { TTL } from "../cache";
import { int, units, big } from "../format";
import { every, isAbort } from "../util";
import { shell, seg, slot } from "./_shell";
import { resolveTab, setMeta, type Params } from "../router";
import "./tx/tx.css";
import { txCols, txRowAttrs, hydrateMethods } from "../ui/txcols";
import { ltStatsOrNull, ltStatsFor, organic, organicTitle, orgText, ltNote } from "../loadtest";
import type { Paged, PageParams, Tx } from "../types";

const TX_COLS = txCols();

/** The kind filter (?type=): the index's own transaction_types values. */
const KINDS: { v: string; label: string }[] = [
  { v: "", label: "All" },
  { v: "coin_transfer", label: "FMX transfers" },
  { v: "contract_call", label: "Contract calls" },
  { v: "token_transfer", label: "Token transfers" },
  { v: "contract_creation", label: "Contract creations" },
];
const EMPTY: Record<string, string> = {
  pending: "No pending transactions. A signer confirms a block every 7 s, so a transaction rarely waits here.",
  coin_transfer: "No FMX transfers on this page of the index.",
  contract_call: "No contract calls here yet.",
  token_transfer: "No token transfers here yet.",
  contract_creation: "No contracts created here yet.",
  "": "No transactions yet.",
};

function listOf(filter: "validated" | "pending", type: string, next: PageParams | null, o: { signal?: AbortSignal; fresh?: boolean }) {
  return bs<Paged<Tx>>("/transactions", { filter, type: type || undefined, ...(next ?? {}) }, next ? 60_000 : TTL.list1, o);
}
const fmxUnit = (wei: unknown, dp = 6): Html => { const x = big(wei); return x === null ? html`—` : html`${x === 0n ? "0" : units(x, 18, dp)}<span class="unit">FMX</span>`; };

export function render(_p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const { tab } = resolveTab("txs", query);
  const pending = tab === "pending";
  const type = KINDS.some((k) => k.v === query.get("type")) ? query.get("type") ?? "" : "";
  const cur = pageOf(query);
  const caption = pending ? "Pending transactions" : type ? `Confirmed transactions: ${KINDS.find((k) => k.v === type)!.label.toLowerCase()}` : "Confirmed transactions";
  setMeta({ title: pending ? "Pending transactions" : "Transactions", description: "Transactions on Ferminux Network (chain 3961): status, parties, value and fee, live." });

  const href = (o: { tab?: string | null; type?: string | null }) => {
    const q = new URLSearchParams();
    const t = o.tab === undefined ? tab : o.tab, k = o.type === undefined ? type : o.type;
    if (t) q.set("tab", t);
    if (k && t !== "pending") q.set("type", k);
    const s = q.toString();
    return `/txs${s ? `?${s}` : ""}`;
  };
  shell(root, {
    h1: "Transactions",
    ident: html`<span data-slot="ident" class="txs-ident"><span class="sk" style="width:220px"></span></span>`,
    body: [
      html`<div data-slot="stats">${statSkeleton(["Last 24 h", "Fees 24 h", "Average fee", "Pending"])}</div>`,
      html`<div class="txs-filters">${seg("Confirmed or pending", [
        { href: href({ tab: null }), label: "Confirmed", on: !pending },
        { href: href({ tab: "pending", type: null }), label: "Pending", on: pending },
      ])}${pending ? "" : seg("Kind of transaction", KINDS.map((k) => ({ href: href({ type: k.v || null }), label: k.label, on: k.v === type })))}</div>`,
      html`<div class="fresh-row" data-slot="fresh" aria-live="polite"></div>`,
      html`<div data-slot="list">${tableSkeleton({ caption, captionHidden: true, cols: TX_COLS, sticky: true }, 10)}</div>`,
    ],
  });

  /* ---- head numbers: identity line + 24 h stats (independent of the list) ---- */
  let total: number | null = null;
  const loadStats = async () => {
    const host = slot(root, "stats");
    try {
      const [ts, st] = await Promise.all([api.txStats({ signal }), api.stats({ signal }).catch(() => null), ltStatsOrNull(signal)]);
      if (signal.aborted) return;
      // the pager counts every row (the list shows load-test transactions, labelled); the figures leave
      // Wizrd's load test out (src/loadtest.ts)
      total = st?.total_transactions ? Number(st.total_transactions) : null;
      const lt = await ltStatsFor(signal, { transactions: total, last24h: ts.transactions_count_24h });
      if (signal.aborted) return;
      const otx = organic(total, lt, "transactions"), o24 = organic(ts.transactions_count_24h, lt, "last24h");
      const t24 = organicTitle(o24, "transactions");
      mount(slot(root, "ident"), html`${otx.n !== null ? html`<span title="${organicTitle(otx, "transactions") ?? ""}"><b class="num-mono">${orgText(otx)}</b> on chain</span><span class="faint">·</span>` : ""}<span title="${t24 ?? ""}"><b class="num-mono">${orgText(o24)}</b> in the last 24 h</span>`);
      const lnote = ltNote(lt, otx, o24);
      mount(host, html`<div class="statgrid txs-stats">
        <div><span class="l">Last 24 h</span><span class="v" title="${t24 ?? ""}">${orgText(o24)}</span></div>
        <div><span class="l">Fees 24 h</span><span class="v">${fmxUnit(ts.transaction_fees_sum_24h)}</span></div>
        <div><span class="l">Average fee</span><span class="v">${fmxUnit(ts.transaction_fees_avg_24h)}</span></div>
        <div><span class="l">Pending</span><span class="v">${int(ts.pending_transactions_count)}</span></div>
      </div>${lnote ? html`<p class="lt-line txs-lt">${lnote}</p>` : ""}`);
      paintPager();
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      mount(slot(root, "ident"), "");
      showError(host, e, () => void loadStats());
    }
  };
  void loadStats();

  /* ---- the list ---- */
  let shown: Paged<Tx> | null = null;
  let latest: Paged<Tx> | null = null;
  const paintPager = () => {
    const host = slot(root, "pager");
    if (!host || !shown) return;
    const t = !pending && !type && total !== null ? total : null;
    mount(host, pagerHtml({ page: cur.page, next: shown.next_page_params, total: t, expired: cur.expired }));
    bindPager(host, { page: cur.page, next: shown.next_page_params, current: cur.params });
  };
  const paintList = (data: Paged<Tx>) => {
    shown = data;
    const host = slot(root, "list");
    if (!data.items.length) {
      mount(host, html`${empty(EMPTY[pending ? "pending" : type] ?? EMPTY[""], pending ? { href: "/txs", label: "Confirmed transactions →" } : type ? { href: "/txs", label: "All transactions →" } : undefined)}${cur.page > 1 ? html`<div data-slot="pager"></div>` : ""}`);
    } else {
      mount(host, html`${table({ caption, captionHidden: true, cols: TX_COLS, rows: data.items, sticky: data.items.length > 15, rowAttrs: txRowAttrs })}<div data-slot="pager"></div>`);
    }
    paintPager();
    if (host) void hydrateMethods(host, signal);
  };
  const loadList = async () => {
    try {
      const data = await listOf(pending ? "pending" : "validated", type, cur.params, { signal });
      if (signal.aborted) return;
      latest = data;
      paintList(data);
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      showError(slot(root, "list"), e, () => void loadList());
    }
  };
  void loadList();

  /* ---- live: page 1 only ---- */
  if (cur.page > 1 || cur.params) return;
  const fresh = slot(root, "fresh");
  const showNew = (n: number) => {
    if (!fresh) return;
    if (n <= 0) { fresh.replaceChildren(); return; }
    mount(fresh, html`<button type="button" class="btn btn-secondary btn-sm fresh-btn" data-show><span class="status-dot ok" aria-hidden="true"></span>${int(n)}${latest?.items.length && n >= latest.items.length ? "+" : ""} new ${n === 1 ? "transaction" : "transactions"} · Show</button>`);
    fresh.querySelector("[data-show]")?.addEventListener("click", () => {
      if (latest) paintList(latest);
      fresh.replaceChildren();
      slot(root, "list")?.querySelector<HTMLElement>("caption")?.focus({ preventScroll: true });
    }, { once: true });
  };
  every(14_000, async () => {
    const data = await listOf(pending ? "pending" : "validated", type, null, { signal, fresh: true });
    if (signal.aborted) return;
    latest = data;
    if (pending) { if (JSON.stringify(data.items.map((t) => t.hash)) !== JSON.stringify(shown?.items.map((t) => t.hash))) paintList(data); return; }
    const top = shown?.items[0]?.hash;
    const idx = top ? data.items.findIndex((t) => t.hash === top) : data.items.length;
    showNew(idx < 0 ? data.items.length : idx);
  }, signal);
}
