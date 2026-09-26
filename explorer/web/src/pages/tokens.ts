/* Tokens `/tokens` (§5.9). BS /tokens (one page holds the whole list today: 6 tokens) + /tokens/:a/counters in
   one parallel burst while the list is ≤ 20 (else the Transfers column hides). All · FRC-20 · FRC-721 (?type=,
   old ERC- values accepted) and a name filter (?q=, replaceState): client-side while the list fits one page,
   the index's ?q= / ?type= beyond that. No price, market-cap or volume columns.
   Under the list, while it fits one page: the contract book's tokens that the index hasn't catalogued yet (an
   FRC-721 appears there after its first Transfer), read from the chain and labelled as such. */
import { html, mount, dash, type Html } from "../ui/html";
import { icon } from "../ui/icons";
import { table, tableSkeleton, type Col } from "../ui/table";
import { sk } from "../ui/skeleton";
import { empty, showError } from "../ui/state";
import { pagerHtml, bindPager, pageOf } from "../ui/pager";
import { api } from "../api";
import { CONTRACTS } from "../known";
import { prov } from "../ui/marks";
import { int, short } from "../format";
import { lc } from "../util";
import { shell, seg, slot } from "./_shell";
import { resolveTab, setMeta, type Params } from "../router";
import type { PageParams, TokenCounters, TokenInfo } from "../types";
import { tokenDisc, stdTag, supplyHtml, stdParam, tokenName, chainToken, type ChainToken } from "./tokens/common";

const BURST = 20;
/** A cell whose value a counter fills in later (`data-h` holders, `data-t` transfers). */
const live = (a: string, k: "h" | "t", v: Html | string) => k === "h" ? html`<span data-h="${lc(a)}">${v}</span>` : html`<span data-t="${lc(a)}">${v}</span>`;

export function render(_p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  resolveTab("tokens", query);
  const type = stdParam(query.get("type"));
  let q = (query.get("q") ?? "").trim();
  const cur = pageOf(query);
  setMeta({ title: type ? `${type} tokens` : "Tokens", description: "FRC-20 and FRC-721 tokens on Ferminux Network (chain 3961): total supply, holders and transfers." });

  const segHref = (t: string) => { const u = new URLSearchParams(); if (t) u.set("type", t); if (q) u.set("q", q); const s = u.toString(); return `/tokens${s ? `?${s}` : ""}`; };
  const colsSk: Col<unknown>[] = [
    { label: "Token", cell: () => "" }, { label: "Standard", cell: () => "", end: true },
    { label: "Total supply", cell: () => "", align: "r", line: 2 }, { label: "Holders", cell: () => "", align: "r", line: 3 },
    { label: "Transfers", cell: () => "", align: "r", line: 3, end: true },
  ];
  shell(root, {
    h1: type ? `${type} tokens` : "Tokens",
    ident: html`<span data-slot="ident">${sk("300px")}</span>`,
    body: [
      html`<div class="tk-bar tk-slot">
        ${seg("Token standard", [
          { href: segHref(""), label: "All", on: !type },
          { href: segHref("FRC-20"), label: "FRC-20", on: type === "FRC-20" },
          { href: segHref("FRC-721"), label: "FRC-721", on: type === "FRC-721" },
        ])}
        <label class="tk-filter">${icon("i-search")}<span class="vh">Filter tokens by name or symbol</span><input type="search" data-filter placeholder="Filter by name or symbol" autocomplete="off" spellcheck="false" value="${q}"></label>
        <span class="tk-count" data-slot="count" aria-live="polite"></span>
      </div>`,
      html`<div class="tk-slot" data-slot="list">${tableSkeleton({ caption: "Tokens", captionHidden: true, cols: colsSk }, 6)}</div>`,
      html`<section class="tk-slot tk-sec tk-unidx" data-slot="unindexed" aria-labelledby="tk-unidx-h" hidden></section>`,
    ],
  });
  const host = slot(root, "list")!;
  const input = root.querySelector<HTMLInputElement>("[data-filter]")!;
  const counters = new Map<string, TokenCounters | null>(); // lc address → counters (null = failed)

  let all: TokenInfo[] = [];
  let unindexed: ChainToken[] = []; // book tokens the index lacks, read from the chain
  let next: PageParams | null = null;
  let complete = false; // the whole list is on one page: filter here, not in the index

  const showCounts = () => all.length <= BURST;
  const tokenCell = (t: TokenInfo) => html`<span class="tk-tok">${tokenDisc(t)}<span class="t"><a class="rl" href="/token/${t.address_hash}" aria-label="${tokenName(t)}${t.symbol ? ` (${t.symbol})` : ""}, ${t.type}"><span>${tokenName(t)}</span>${t.symbol && t.symbol !== tokenName(t) ? html` <span class="sym">${t.symbol}</span>` : ""}</a><span class="ad" title="${t.address_hash}">${short(t.address_hash, 4)}</span></span></span>`;
  const cols = (): Col<TokenInfo>[] => [
    { label: "Token", cell: tokenCell },
    { label: "Standard", cell: (t) => stdTag(t.type), end: true, w: "120px" },
    { label: "Total supply", cell: (t) => supplyHtml(t), align: "r", line: 2, l: "Supply" },
    { label: "Holders", cell: (t) => live(t.address_hash, "h", holdersOf(t)), align: "r", line: 3, l: "Holders", w: "120px" },
    ...(showCounts() ? [{ label: "Transfers", cell: (t: TokenInfo) => live(t.address_hash, "t", transfersOf(t)), align: "r" as const, line: 3 as const, end: true, l: "Transfers", w: "120px" }] : []),
  ];
  const holdersOf = (t: TokenInfo): Html | string => {
    const c = counters.get(lc(t.address_hash));
    const v = c?.token_holders_count ?? t.holders_count;
    return v === null || v === undefined ? dash("Holders not reported by the index") : int(v);
  };
  const transfersOf = (t: TokenInfo): Html | string => {
    const k = lc(t.address_hash);
    if (!counters.has(k)) return sk("40px");
    const c = counters.get(k);
    return c ? int(c.transfers_count) : dash("Transfer count not reported by the index");
  };

  const matches = (t: TokenInfo) => {
    if (type && t.type !== type) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return (t.name ?? "").toLowerCase().includes(s) || (t.symbol ?? "").toLowerCase().includes(s) || lc(t.address_hash).startsWith(s);
  };

  function paint() {
    const rows = complete ? all.filter(matches) : all;
    const std = { "FRC-20": all.filter((t) => t.type === "FRC-20").length, "FRC-721": all.filter((t) => t.type === "FRC-721").length };
    const other = all.length - std["FRC-20"] - std["FRC-721"];
    const identEl = slot(root, "ident");
    if (identEl) mount(identEl, complete
      ? html`<span><span class="num-mono">${int(all.length)}</span> ${all.length === 1 ? "token" : "tokens"} on chain 3961 · <span class="num-mono">${int(std["FRC-20"])}</span> FRC-20 · <span class="num-mono">${int(std["FRC-721"])}</span> FRC-721${other ? html` · <span class="num-mono">${int(other)}</span> other` : ""} · sorted by holders</span>`
      : html`<span>Tokens on chain 3961, sorted by holders</span>`);
    const countEl = slot(root, "count");
    if (countEl) countEl.textContent = complete && (q || type) ? `${int(rows.length)} of ${int(all.length)}` : "";
    paintUnindexed();
    if (!rows.length) {
      const what = type ? `${type} tokens` : "tokens";
      mount(host, q
        ? empty(html`No ${what} match “${q}”.`, { href: type ? `/tokens?type=${type}` : "/tokens", label: "Clear the filter" })
        : empty(html`No ${what} on chain 3961 yet.`, type ? { href: "/tokens", label: "All tokens" } : undefined));
      return;
    }
    mount(host, html`${table({ caption: `Tokens on chain 3961${type ? `, ${type}` : ""}`, captionHidden: true, cols: cols(), rows })}
      ${cur.page > 1 || next ? pagerHtml({ page: cur.page, next, expired: cur.expired, order: "rank" }) : ""}`);
    if (cur.page > 1 || next) bindPager(host, { page: cur.page, next, current: cur.params });
  }

  /** The book's tokens the index hasn't catalogued: the same columns, every figure from the chain. Nothing
   *  minted means no holders and no transfers; otherwise those wait for the index. */
  function paintUnindexed() {
    const el = slot(root, "unindexed");
    if (!el) return;
    const rows = unindexed.filter((c) => matches(c.token));
    el.hidden = !rows.length;
    if (!rows.length) { el.replaceChildren(); return; }
    const later = (c: ChainToken): Html => (c.supply === 0n ? html`<span class="num-mono">0</span>` : dash("Not in the explorer's index yet"));
    mount(el, html`<div class="tk-sec-head"><h2 id="tk-unidx-h">Not in the explorer's index yet ${prov("chain")}</h2></div>
      <p class="tk-foot">In the explorer's contract book and read from the chain just now. The index lists a token after its first mint.</p>
      ${table({ caption: "Tokens not in the explorer's index yet", captionHidden: true, rows, cols: [
        { label: "Token", cell: (c) => tokenCell(c.token) },
        { label: "Standard", cell: (c) => stdTag(c.token.type), end: true, w: "120px" },
        { label: "Total supply", cell: (c) => supplyHtml(c.token), align: "r", line: 2, l: "Supply" },
        { label: "Holders", cell: later, align: "r", line: 3, l: "Holders", w: "120px" },
        ...(showCounts() ? [{ label: "Transfers", cell: later, align: "r" as const, line: 3 as const, end: true, l: "Transfers", w: "120px" }] : []),
      ] })}`);
  }

  /** Read the book's tokens that page 1 of the index's list lacks (only while the whole list fits one page). */
  async function loadUnindexed() {
    const have = new Set(all.map((t) => lc(t.address_hash)));
    const missing = CONTRACTS.filter((c) => c.kind === "token" && !have.has(lc(c.address)));
    if (!missing.length) return;
    const got = await Promise.all(missing.map((c) => chainToken(c.address, signal).catch(() => null)));
    if (signal.aborted) return;
    unindexed = got.filter((c): c is ChainToken => !!c && c !== "down");
    if (unindexed.length) paint();
  }

  /** Fill the Holders / Transfers cells as each counter lands (no repaint of the table). */
  function patch(a: string) {
    const t = all.find((x) => lc(x.address_hash) === a);
    if (!t) return;
    const h = host.querySelector<HTMLElement>(`[data-h="${a}"]`);
    const tr = host.querySelector<HTMLElement>(`[data-t="${a}"]`);
    if (h) mount(h, html`${holdersOf(t)}`);
    if (tr) mount(tr, html`${transfersOf(t)}`);
  }

  async function load() {
    try {
      // Page 1 of the unfiltered list is the book's cached list: usually answered from memory.
      let r = await api.tokens(undefined, cur.params, { signal });
      if (signal.aborted) return;
      complete = cur.page === 1 && !r.next_page_params;
      if (!complete && (q || type)) { r = await api.tokens({ q: q || undefined, type: type || undefined }, cur.params, { signal }); if (signal.aborted) return; }
      all = r.items;
      next = r.next_page_params;
    } catch (e) {
      if (!signal.aborted) showError(host, e, () => { mount(host, tableSkeleton({ caption: "Tokens", captionHidden: true, cols: colsSk }, 6)); void load(); });
      return;
    }
    if (cur.page === 1 && !q && !type) setMeta({ title: "Tokens", description: `${all.length} FRC-20 and FRC-721 tokens on Ferminux Network (chain 3961): total supply, holders and transfers.` });
    paint();
    if (complete) void loadUnindexed();
    if (!showCounts()) return;
    // One parallel burst; each row fills in on its own.
    all.forEach((t) => {
      const k = lc(t.address_hash);
      if (counters.has(k)) return;
      api.tokenCounters(t.address_hash, { signal })
        .then((c) => { counters.set(k, c); }, () => { counters.set(k, null); })
        .finally(() => { if (!signal.aborted) patch(k); });
    });
  }

  // The filter: live, client-side, URL-kept (replaceState). Beyond one page the index answers ?q=.
  let t = 0;
  input.addEventListener("input", () => {
    q = input.value.trim();
    const u = new URL(location.href);
    if (q) u.searchParams.set("q", q); else u.searchParams.delete("q");
    u.searchParams.delete("page"); u.searchParams.delete("next_page_params");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    root.querySelectorAll<HTMLAnchorElement>(".seg .seg-a").forEach((a, i) => { a.href = segHref(["", "FRC-20", "FRC-721"][i]); });
    if (complete) { paint(); return; }
    clearTimeout(t);
    t = window.setTimeout(async () => {
      try {
        const r = await api.tokens({ q: q || undefined, type: type || undefined }, null, { signal });
        if (signal.aborted) return;
        all = r.items; next = r.next_page_params; paint();
      } catch (e) { if (!signal.aborted) showError(host, e, () => input.dispatchEvent(new Event("input"))); }
    }, 250);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; input.dispatchEvent(new Event("input")); } });
  signal.addEventListener("abort", () => clearTimeout(t), { once: true });

  void load();
}
