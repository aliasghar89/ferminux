/* Accounts `/accounts` (surfaces/explorer.md §5.8): every address the index has seen, by FMX balance.
   # (page offset + index) · Address (chip with its name + a kind tag) · Balance (FMX) · Txs. 50 per page,
   "Page 1 of N" with N = total_addresses / 50 (BS /stats). No "% of supply": the index reports supply as 0,
   and the explorer shows no number it can't read (§0.2, §15). Chips re-label when the name book refreshes.
   The index orders the page and names the rows; the figures are checked (QA data #9, #12):
   - Balance: read from the chain for the whole page (ONE eth_getBalance batch), so it agrees with the
     address pages. The index's balance only when the chain can't be read, tagged as such.
   - Txs: the index's per-address counter drifts (32 for 30, empty for 1), so each row is counted from the
     index's transaction list (counts.ts: tabs-counters up to 50, paging above), a few rows at a time. */
import "./address/address.css";
import { html, mount, type Html } from "../ui/html";
import { addrChip } from "../ui/hash";
import { amt, kindTag } from "../ui/marks";
import { table, tableSkeleton, type Col } from "../ui/table";
import { pagerHtml, bindPager, pageOf, PER_PAGE } from "../ui/pager";
import { slowWatch, sk } from "../ui/skeleton";
import { empty, showError } from "../ui/state";
import { int } from "../format";
import { api } from "../api";
import { rpc, RPC_DOWN } from "../rpc";
import { txCount, type TxCount } from "../counts";
import { label } from "../book";
import { knownContract } from "../known";
import { onAbort, lc, isAbort } from "../util";
import type { Account, Paged } from "../types";
import { shell, slot } from "./_shell";
import { phu } from "./address/common";
import { setMeta, type Params } from "../router";
import { ltStatsFor, organic, organicTitle, orgText, ltWalletsNote } from "../loadtest";

type Row = Account & { rank: number };

/** Chain balances and exact tx counts for the rows on screen, filled in as they arrive. */
const chainBal = new Map<string, bigint | null>();
const exactTxs = new Map<string, TxCount>();

const KIND: Record<string, string> = { contract: "Contract", token: "Token", signer: "Signer", account: "", "agent-wallet": "Agent wallet", agent: "Agent", index: "" };
function kindOf(r: Account): Html {
  const l = label(r.hash, r.name);
  const k = l ? KIND[l.kind] : "";
  if (k) return kindTag(k);
  if (r.is_contract || knownContract(r.hash)) return kindTag("Contract");
  return html``;
}

const COLS: Col<Row>[] = [
  { label: "#", cell: (r) => html`<span class="num-mono ad-rank"><span class="ad-hash">#</span>${r.rank}</span>`, align: "r", w: "56px" },
  // the chip is the row's link (the whole row is not a link: the chip and copy stay separate targets)
  { label: "Address", cell: (r) => html`<span class="ad-acct">${addrChip({ hash: r.hash, name: r.name, is_contract: r.is_contract, is_verified: null })}${kindOf(r)}</span>` },
  {
    label: "Balance (FMX)", align: "r", line: 3,
    cell: (r) => {
      const b = chainBal.get(lc(r.hash));
      if (b === undefined) return html`<span data-bal="${lc(r.hash)}">${amt(r.coin_balance)}</span>${phu()}`;
      if (b === null) return html`<span class="est" title="${RPC_DOWN}: the explorer's index balance, which can lag the chain">${amt(r.coin_balance)}</span>${phu()}`;
      return html`<span title="Read from the chain just now">${amt(b)}</span>${phu()}`;
    },
  },
  {
    label: "Txs", align: "r", line: 3, end: true, l: "txs",
    cell: (r) => {
      const c = exactTxs.get(lc(r.hash));
      if (!c) return html`<span class="faint" data-txs="${lc(r.hash)}">${sk("24px")}</span>`;
      return c.exact ? int(c.n) : html`<span class="est" title="The index's counter: too many transactions to count here">${int(c.n)}</span>`;
    },
  },
];

export function render(_p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  setMeta({ title: "Accounts", description: "Addresses on Ferminux Network (chain 3961), sorted by FMX balance." });
  chainBal.clear(); exactTxs.clear();
  shell(root, {
    h1: "Accounts",
    ident: html`<span><span data-slot="count">${sk("64px")}</span> addresses seen on chain · sorted by FMX balance</span>`,
    body: html`<p class="lt-line acc-lt" data-slot="lt-note" hidden></p><div data-slot="list">${tableSkeleton({ caption: "Accounts by balance", captionHidden: true, cols: COLS, sticky: true }, 10)}</div>`,
  });
  root.querySelector(".page")?.classList.add("adx");
  const c = pageOf(query);
  const host = slot(root, "list")!;
  const stats = api.stats({ signal }).catch(() => null);
  // the count leaves Wizrd's load-test wallets out (src/loadtest.ts); the pager and the list keep every address
  stats.then(async (s) => {
    const lt = await ltStatsFor(signal, { addresses: s?.total_addresses }).catch(() => null);
    if (signal.aborted) return;
    const o = organic(s?.total_addresses || null, lt, "addresses");
    mount(slot(root, "count"), html`<span class="num-mono" title="${organicTitle(o, "addresses") ?? ""}">${orgText(o)}</span>`);
    const n = slot(root, "lt-note");
    if (n) { const h = ltWalletsNote(lt, o); mount(n, h); n.hidden = !h; }
  });

  let page: Paged<Account> | null = null;
  let total: number | null = null;
  let first = true;
  const paint = () => {
    if (!page || signal.aborted) return;
    const rows: Row[] = page.items.map((a, i) => ({ ...a, rank: (c.page - 1) * PER_PAGE + i + 1 }));
    // after paging the router focuses the caption, but a skeleton is visibility:hidden for its first 200 ms, so
    // that focus can miss: move it to the real caption (only on a pager navigation, which carries a cursor stack)
    const refocus = first && (host.contains(document.activeElement) || (document.activeElement === document.body && Array.isArray((history.state as { stack?: unknown } | null)?.stack)));
    first = false;
    mount(host, html`${table({ caption: "Accounts by balance", captionHidden: true, cols: COLS, rows, sticky: rows.length > 15 })}${pagerHtml({ page: c.page, next: page.next_page_params, total, order: "rank", expired: c.expired })}`);
    bindPager(host, { page: c.page, next: page.next_page_params, current: c.params });
    // the shared pager speaks in time (Newer / Older); this list is by balance
    const words: Record<string, string> = { first: "First page", prev: "← Previous", next: "Next →" };
    host.querySelectorAll<HTMLButtonElement>("[data-pg]").forEach((b) => { b.textContent = words[b.dataset.pg!] ?? b.textContent; });
    if (refocus) host.querySelector<HTMLElement>("caption")?.focus({ preventScroll: true });
  };
  const load = () => {
    const done = slowWatch(host, load, signal);
    Promise.all([api.accounts(c.params, { signal }), stats]).then(([p, s]) => {
      done();
      if (signal.aborted) return;
      if (!p.items.length) { mount(host, empty("No accounts on this page.", { href: "/accounts", label: "First page" })); return; }
      page = p;
      total = s?.total_addresses ? Number(s.total_addresses) : null;
      paint();
      void verify(p.items);
    }, (e) => { done(); showError(host, e, load); });
  };
  /** The chain's balances (one batch) and the exact counts (a few at a time), repainting in place. */
  const verify = async (rows: Account[]) => {
    const bals = await Promise.all(rows.map((r) => rpc.balance(r.hash, signal).then((b) => b, (e) => { if (isAbort(e)) throw e; return null; }))).catch(() => null);
    if (signal.aborted) return;
    if (bals) { rows.forEach((r, i) => chainBal.set(lc(r.hash), bals[i])); paint(); }
    let pending = 0;
    const flush = () => { pending = 0; if (!signal.aborted) paint(); };
    await Promise.all(rows.map((r) => txCount(r.hash, { signal, counter: r.transactions_count }).then((c) => {
      exactTxs.set(lc(r.hash), c);
      if (!pending) pending = window.setTimeout(flush, 250); // batch the repaints
    }, () => { exactTxs.set(lc(r.hash), { n: Number(r.transactions_count) || 0, exact: false }); })));
    if (!signal.aborted) paint();
  };
  load();
  // names arrive with the gateway lists: re-label the chips in place
  const relabel = () => paint();
  document.addEventListener("fx:book", relabel);
  onAbort(signal, () => document.removeEventListener("fx:book", relabel));
}
