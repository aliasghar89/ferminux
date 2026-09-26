/* Token `/token/:addr` (§5.10). BS /tokens/:a + /counters; the stat row (Cap from the contract: MAX_ID() or
   maxSupply() for FRC-721, cap() for FRC-20, tagged FROM THE CHAIN); the agent token card (GW /tokens +
   /agents); tabs Inventory (FRC-721, default) · Transfers · Holders · Contract. The shell paints from the
   cached tokens list when it has this token.
   A 404 from the index is not the end: the index lists an FRC-721 only after its first Transfer. When the contract
   book calls the address a token, or its code answers supportsInterface(0x80ac58cd), the page is drawn from the
   chain (chainToken): name, symbol, totalSupply(), the cap, a note that the index hasn't catalogued it yet and the
   book's mint link; tabs Inventory · Contract. Anything else renders "No token at 0x…" with a link to the address
   page. */
import { html, mount, dash, type Html } from "../ui/html";
import { addrChip } from "../ui/hash";
import { prov } from "../ui/marks";
import { table, tableSkeleton, type Col } from "../ui/table";
import { tabsHtml, bindTabs, type TabDef } from "../ui/tabs";
import { pagerHtml, bindPager, pageOf, PER_PAGE } from "../ui/pager";
import { sk, statSkeleton } from "../ui/skeleton";
import { empty, showError } from "../ui/state";
import { api, cachedTokens, ApiError } from "../api";
import { gw } from "../gateway";
import { knownContract } from "../known";
import { RPC_DOWN } from "../rpc";
import { amountCell, amountExact, int, short, share, big } from "../format";
import { isAddr, lc } from "../util";
import { shell, slot } from "./_shell";
import { notFound } from "./notFound";
import { navigate, resolveTab, setMeta, type Params } from "../router";
import type { PageParams, TokenCounters, TokenHolder, TokenInfo } from "../types";
import {
  isNft, decimalsOf, tokenName, tokenDisc, stdTag, supplyHtml, transfersTable, nftTile, tileGrid, bindMedia,
  capOf, tokenReads, agentTokenCard, stat, progress, identAddr, chainToken, mintListUrl, type ChainToken,
} from "./tokens/common";

const tabSk = () => tableSkeleton({ caption: "Loading", captionHidden: true, cols: [
  { label: "Tx", cell: () => "" }, { label: "Kind", cell: () => "" }, { label: "From → To", cell: () => "", line: 2 },
  { label: "Amount", cell: () => "", align: "r", line: 3, end: true }, { label: "Age", cell: () => "", align: "r", end: true },
] }, 8);

const h1Of = (t: TokenInfo): Html =>
  html`${tokenDisc(t, 28)}<span>${tokenName(t)}</span>${t.symbol && t.symbol !== tokenName(t) ? html` <span class="sym">${t.symbol}</span>` : ""}`;
const identOf = (t: TokenInfo): Html =>
  html`${stdTag(t.type)}${identAddr(t.address_hash)}<a class="link-arrow" href="/address/${t.address_hash}">Contract page →</a>`;

export function render(p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const a = p.addr;
  if (!isAddr(a)) { notFound(root, { h1: "That isn't a token address", body: "A token address is 0x followed by 40 hexadecimal characters.", query: a }); return; }
  const choice = resolveTab("token", query);
  const cur = pageOf(query);
  const cached = cachedTokens().find((x) => lc(x.address_hash) === lc(a)) ?? null;
  const known = knownContract(a);
  setMeta({ title: cached ? `${tokenName(cached)}${cached.symbol ? ` (${cached.symbol})` : ""}` : `Token ${short(a, 4)}` });
  shell(root, {
    crumbs: [{ href: "/tokens", label: "Tokens" }, { label: cached?.symbol ?? known?.name ?? short(a, 4) }],
    h1: html`<span class="tk-h1" data-slot="h1">${cached ? h1Of(cached) : html`${sk("220px", "28px")}<span class="vh">Token ${a}</span>`}</span>`,
    ident: html`<span class="tk-ident" data-slot="ident">${cached ? identOf(cached) : sk("320px")}</span>`,
    body: [
      html`<div class="tk-slot" data-slot="note" hidden></div>`,
      html`<div class="tk-slot" data-slot="stats">${statSkeleton(["Total supply", "Holders", "Transfers", cached && isNft(cached) ? "Cap" : "Decimals"])}</div>`,
      html`<div class="tk-slot" data-slot="agent" hidden></div>`,
      html`<div class="tk-slot" data-slot="tabs">${tabSk()}</div>`,
    ],
  });

  const tokP = api.token(a, { signal });
  const cntP = api.tokenCounters(a, { signal }).catch((e: unknown) => { if (signal.aborted) throw e; return null; });

  void (async () => {
    let t: TokenInfo;
    try { t = await tokP; } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.notFound) {
        // not catalogued by the index: a token the index hasn't met yet, or no token at all (ask the chain)
        const ct = await chainToken(a, signal).catch(() => (signal.aborted ? null : "down" as const));
        if (signal.aborted) return;
        if (ct === "down") { chainDown(); return; }
        if (ct) { paintChain(ct); return; }
        notFound(root, {
          h1: html`No token at <span class="num-mono">${short(a, 6)}</span>`,
          body: html`The explorer's index has no FRC-20 or FRC-721 token at this address on chain 3961. <a class="link-inline" href="/address/${a}">Open it as an address →</a>`,
          query: a,
        });
        return;
      }
      showError(slot(root, "stats"), e, () => navigate(location.pathname + location.search, { replace: true, focus: "none" }));
      mount(slot(root, "tabs"), "");
      return;
    }
    if (signal.aborted) return;
    const nft = isNft(t);
    const name = tokenName(t);
    setMeta({
      title: `${name}${t.symbol ? ` (${t.symbol})` : ""} ${t.type} token`,
      description: `${name}${t.symbol ? ` (${t.symbol})` : ""}, an ${t.type} token on Ferminux Network (chain 3961): ${nft ? "minted tokens, owners" : "total supply, holders"} and transfers.`,
    });
    mount(slot(root, "h1"), h1Of(t));
    mount(slot(root, "ident"), identOf(t));
    const crumb = root.querySelector<HTMLElement>(".crumbs [aria-current]");
    if (crumb) crumb.textContent = t.symbol || name;

    // Agent token card (GW). A gateway failure hides it quietly: most tokens are not agent tokens.
    void gw.tokens(signal).then(async (list) => {
      const at = list.find((x) => lc(x.token) === lc(a));
      if (!at || signal.aborted) return;
      const agents = await gw.agents(signal).catch(() => []);
      if (signal.aborted) return;
      const host = slot(root, "agent");
      if (!host) return;
      mount(host, agentTokenCard(at, agents.find((g) => g.id === at.agentId)));
      host.hidden = false;
    }, () => { /* hidden */ });

    const c = await cntP.catch(() => null);
    if (signal.aborted) return;
    const cap = { v: null as bigint | null, down: false, read: false };
    const paintStats = () => mount(slot(root, "stats"), statsHtml(t, c, cap));
    paintStats();
    void capOf(t, signal).then((r) => { cap.v = r.cap; cap.down = r.down; cap.read = true; if (!signal.aborted) paintStats(); }, () => { /* aborted */ });

    paintTabs(t, c, cap);
  })();

  /* ---------------------------------------------------------------- tabs */

  function paintTabs(t: TokenInfo, c: TokenCounters | null, cap: { v: bigint | null }) {
    const nft = isNft(t);
    const def = nft ? "inventory" : "token_transfers";
    const holders = c?.token_holders_count ?? t.holders_count;
    const defs: TabDef[] = [
      ...(nft ? [{ key: "inventory", label: "Inventory", count: t.total_supply === null ? null : Number(t.total_supply) }] : []),
      { key: "token_transfers", label: "Transfers", count: c ? Number(c.transfers_count) : null },
      { key: "holders", label: "Holders", count: holders === null ? null : Number(holders) },
      { key: "contract", label: "Contract", always: true },
    ];
    const active = pickTab(defs, def);
    const first = active;
    const host = slot(root, "tabs")!;
    mount(host, tabsHtml("tk-tabs", defs, active, `${tokenName(t)} sections`));
    bindTabs(host, "tk-tabs", def, (key, panel) => {
      const at = key === first ? cur : { page: 1, params: null as PageParams | null, expired: false };
      if (key === "token_transfers") loadTransfers(t, panel, at);
      else if (key === "holders") loadHolders(t, c, panel, at);
      else if (key === "inventory") loadInventory(t, cap, panel, at);
      else if (key === "contract") loadContract(t, panel);
    }, signal);
  }

  /** The ?tab= choice when this page has that tab, else the default (and the stale ?tab= / paging leave the URL). */
  function pickTab(defs: TabDef[], def: string): string {
    const active = choice.tab ?? def;
    if (defs.some((d) => d.key === active)) return active;
    const u = new URL(location.href); u.searchParams.delete("tab"); u.searchParams.delete("page"); u.searchParams.delete("next_page_params");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    return def;
  }

  type At = { page: number; params: PageParams | null; expired: boolean };
  /** Load one paged list into a panel: skeleton, fetch, render or error with Retry. */
  function paged<T>(panel: HTMLElement, at: At, fetch: () => Promise<{ items: T[]; next_page_params: PageParams | null }>, body: (items: T[]) => Html, none: Html | string, foot?: (items: T[]) => Html | "", order: "time" | "rank" = "time") {
    mount(panel, tabSk());
    fetch().then((r) => {
      if (signal.aborted) return;
      if (!r.items.length && at.page === 1) { mount(panel, empty(none)); return; }
      const pager = at.page > 1 || r.next_page_params;
      mount(panel, html`${body(r.items)}${foot ? foot(r.items) : ""}${pager ? pagerHtml({ page: at.page, next: r.next_page_params, expired: at.expired, order }) : ""}`);
      if (pager) bindPager(panel, { page: at.page, next: r.next_page_params, current: at.params });
      bindMedia(panel);
    }, (e) => { if (!signal.aborted) showError(panel, e, () => paged(panel, at, fetch, body, none, foot, order)); });
  }

  function loadTransfers(t: TokenInfo, panel: HTMLElement, at: At) {
    paged(panel, at, () => api.tokenTransfers(t.address_hash, at.params, { signal }),
      (items) => transfersTable(items, { token: t, caption: `Transfers of ${tokenName(t)}` }),
      "No transfers yet.");
  }

  function loadHolders(t: TokenInfo, c: TokenCounters | null, panel: HTMLElement, at: At) {
    const nft = isNft(t);
    const d = decimalsOf(t);
    const supply = big(t.total_supply);
    const offset = (at.page - 1) * PER_PAGE;
    const cols: Col<TokenHolder>[] = [
      { label: "#", cell: (_h, i) => html`<span class="num-mono faint">${int(offset + i + 1)}</span>`, w: "56px" },
      { label: "Holder", cell: (h) => addrChip(h.address) },
      {
        label: nft ? "Tokens held" : `Balance${t.symbol ? ` (${t.symbol})` : ""}`, align: "r", line: 3, l: nft ? "Held" : "Balance",
        cell: (h) => nft || d === null ? html`<span class="num-mono">${int(h.value)}</span>` : html`<span class="num-mono" title="${amountExact(h.value, d)}">${amountCell(h.value, d)}</span>${t.symbol ? html`<span class="ph-unit">${t.symbol}</span>` : ""}`,
      },
      {
        label: "Share", align: "r", line: 3, end: true, w: "150px",
        cell: (h) => {
          const s = share(h.value, supply);
          const hv = big(h.value);
          const pv = hv !== null && supply && supply > 0n ? Number((hv * 10_000n) / supply) / 10_000 : null;
          return s === "—" ? dash("Total supply not reported by the index") : html`<span class="tk-share"><span class="num-mono">${s}</span><span class="bar" aria-hidden="true"><i style="--p:${Math.min(1, pv ?? 0)}"></i></span></span>`;
        },
      },
    ];
    const totalHolders = c?.token_holders_count ?? t.holders_count;
    paged(panel, at, () => api.tokenHolders(t.address_hash, at.params, { signal }),
      (items) => html`<div class="tk-holders">${table({ caption: `Holders of ${tokenName(t)}`, captionHidden: true, cols, rows: items, dense: true })}</div>`,
      "No holders yet.",
      () => html`<p class="tk-foot">Share is the balance ÷ the total supply (${supplyHtml(t, true)}), both read from the explorer's index${totalHolders ? html` · <span class="num-mono">${int(totalHolders)}</span> ${Number(totalHolders) === 1 ? "holder" : "holders"}` : ""}.</p>`,
      "rank");
  }

  function loadInventory(t: TokenInfo, cap: { v: bigint | null }, panel: HTMLElement, at: At) {
    // the book's optional mintUrl ("…?id={id}") names the collection's mint page; its list view takes ?filter=available
    const mintList = mintListUrl(knownContract(t.address_hash)?.mintUrl);
    paged(panel, at, () => api.tokenInstances(t.address_hash, at.params, { signal }),
      (items) => tileGrid(items.map((i) => nftTile(i, t))),
      "No tokens minted yet.",
      () => {
        const minted = big(t.total_supply);
        if (minted === null) return "";
        const left = cap.v !== null ? cap.v - minted : null;
        return html`<p class="tk-grid-note"><span><span class="num-mono">${int(minted)}</span> minted${cap.v !== null ? html` of <span class="num-mono">${int(cap.v)}</span> ${prov("chain")}` : ""}</span>${mintList && left !== null && left > 0n
          ? html`<a class="link-arrow" href="${mintList}" rel="noopener" data-external>The other ${int(left)} can be minted on ${new URL(mintList).hostname} ↗</a>` : ""}</p>`;
      });
  }

  function loadContract(t: TokenInfo, panel: HTMLElement) {
    mount(panel, html`<div class="tk-status" data-slot="cstatus">${sk("280px")}</div><div data-slot="creads">${tableSkeleton({ caption: "Reads", captionHidden: true, cols: [{ label: "Function", cell: () => "" }, { label: "Value", cell: () => "" }] }, 5)}</div>
      <p class="tk-foot">This explorer is read-only. Source, bytecode and every function are on <a href="/address/${t.address_hash}?tab=contract">the contract's address page</a>.</p>`);
    api.address(t.address_hash, { signal }).then((ad) => {
      if (signal.aborted) return;
      mount(slot(panel, "cstatus"), ad.is_verified
        ? html`${prov("verified")}<span>Source verified on this explorer.</span>`
        : html`${prov("unverified")}<span>Source not verified on this explorer. The values below are read from the chain with the standard ${t.type} functions.</span>`);
    }, () => { if (!signal.aborted) mount(slot(panel, "cstatus"), html`<span>${dash("Verification status not reported by the index")}</span>`); });
    tokenReads(t, signal).then((r) => {
      if (signal.aborted) return;
      const hostR = slot(panel, "creads");
      if (r.down) { mount(hostR, html`<div class="alert warn" role="alert">${RPC_DOWN}: the contract could not be read just now.</div>`); return; }
      mount(hostR, html`<div class="tk-reads">${table({ caption: `Read from ${tokenName(t)}`, captionHidden: true, dense: true, rows: r.rows, cols: [
        { label: "Function", cell: (x) => html`<span title="${x.raw}">${x.fn}</span>` },
        { label: "Value", cell: (x) => x.value, line: 2 },
      ] })}</div><p class="tk-foot">Read with eth_call from rpc.ferminux.net just now ${prov("chain")}</p>`);
    }, () => { /* aborted */ });
  }

  /* ---------------------------------------------------------------- not in the index yet: from the chain */

  function paintChain(ct: ChainToken) {
    const t = ct.token;
    const nft = isNft(t);
    const name = tokenName(t);
    const sym = t.symbol ? ` (${t.symbol})` : "";
    const first = nft ? "mint" : "transfer";
    // Nothing minted: the index lists it after the first mint. Something minted and still not listed: the contract
    // emitted no Transfer the index has read (just minted, or a collection that never emits one), so promise nothing.
    const note = ct.supply === 0n ? `Not in the explorer's index yet: it appears after the first ${first}.`
      : "Not in the explorer's index: the index has no Transfer from this contract yet.";
    setMeta({
      title: `${name}${sym} ${t.type} token`,
      description: `${name}${sym}, an ${t.type} token on Ferminux Network (chain 3961), read from the chain: not in the explorer's index yet.`,
    });
    mount(slot(root, "h1"), h1Of(t));
    mount(slot(root, "ident"), identOf(t));
    const crumb = root.querySelector<HTMLElement>(".crumbs [aria-current]");
    if (crumb) crumb.textContent = t.symbol || name;

    const mintList = nft ? mintListUrl(ct.mintUrl) : null;
    const noteEl = slot(root, "note")!;
    mount(noteEl, html`<p class="note tk-note"><span>${note}</span>${mintList
      ? html`<a class="link-arrow" href="${mintList}" rel="noopener" data-external>Mint on ${new URL(mintList).hostname} ↗</a>` : ""}</p>`);
    noteEl.hidden = false;

    const cap = { v: null as bigint | null, down: false, read: false };
    const paintStats = () => mount(slot(root, "stats"), chainStatsHtml(t, ct.supply, cap));
    paintStats();
    const capP = capOf(t, signal).then((r) => { cap.v = r.cap; cap.down = r.down; cap.read = true; if (!signal.aborted) paintStats(); }, () => { /* aborted */ });

    const def = nft ? "inventory" : "contract";
    const defs: TabDef[] = [
      ...(nft ? [{ key: "inventory", label: "Inventory", count: ct.supply === null ? null : Number(ct.supply) }] : []),
      { key: "contract", label: "Contract", always: true },
    ];
    const host = slot(root, "tabs")!;
    mount(host, tabsHtml("tk-tabs", defs, pickTab(defs, def), `${name} sections`));
    bindTabs(host, "tk-tabs", def, (key, panel) => {
      if (key === "inventory") chainInventory(ct.supply, cap, capP, mintList, panel);
      else loadContract(t, panel);
    }, signal);
  }

  /** The inventory of a collection the index hasn't listed: nothing minted (the usual case), or minted but with no
   *  Transfer the index has read (a moment ago, or a collection that never emits one). */
  function chainInventory(n: bigint | null, cap: { v: bigint | null }, capP: Promise<void>, mintList: string | null, panel: HTMLElement) {
    const mint = mintList ? html` <a class="link-inline" href="${mintList}" rel="noopener" data-external>Mint on ${new URL(mintList).hostname} ↗</a>` : "";
    const paint = () => mount(panel, html`${n === 0n
      ? html`<div class="empty">No tokens minted yet.${mint}</div>`
      : n === null
      ? html`<div class="empty">The explorer's index has no Transfer from this contract yet, so it can't list its tokens.${mint}</div>`
      : html`<div class="empty"><span class="num-mono">${int(n)}</span> minted on chain 3961. The explorer's index has no Transfer from this contract yet, so it can't list them.</div>`}${n !== null && cap.v !== null
      ? html`<p class="tk-grid-note"><span><span class="num-mono">${int(n)}</span> minted of <span class="num-mono">${int(cap.v)}</span> ${prov("chain")}</span></p>` : ""}`);
    paint();
    void capP.then(() => { if (!signal.aborted) paint(); });
  }

  /** The index has no token here and the chain RPC didn't answer: say both, and offer Retry. */
  function chainDown() {
    const known = knownContract(a);
    mount(slot(root, "h1"), known ? known.short ?? known.name : html`Token <span class="num-mono">${short(a, 6)}</span>`);
    mount(slot(root, "ident"), html`${identAddr(a)}<a class="link-arrow" href="/address/${a}">Contract page →</a>`);
    const host = slot(root, "stats")!;
    mount(host, html`<div class="state-box"><div class="alert warn" role="alert">The explorer's index has no token at this address yet, and the chain RPC didn't answer, so the contract couldn't be read to check it.</div><button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></div>`);
    host.querySelector("[data-retry]")?.addEventListener("click", () => navigate(location.pathname + location.search, { replace: true, focus: "none" }), { once: true });
    mount(slot(root, "tabs"), "");
  }
}

/* ---------------------------------------------------------------- stat row */

function statsHtml(t: TokenInfo, c: TokenCounters | null, cap: { v: bigint | null; down: boolean; read: boolean }): Html {
  const nft = isNft(t);
  const d = decimalsOf(t);
  const holders = c?.token_holders_count ?? t.holders_count;
  const cells: Html[] = [];
  cells.push(stat("Total supply", supplyHtml(t, true),
    nft ? progress(big(t.total_supply), cap.v) : d !== null && t.total_supply ? html`<span class="num-mono" title="Exact, from the explorer's index">${amountExact(t.total_supply, d)}</span>` : null));
  if (cap.v !== null) cells.push(stat(html`Cap ${prov("chain")}`, html`<span class="num-mono">${nft ? int(cap.v) : d !== null ? amountExact(cap.v, d) : int(cap.v)}</span>${!nft && t.symbol ? html`<span class="unit">${t.symbol}</span>` : ""}`, nft ? "the contract's highest token id" : "the contract's cap()"));
  else if (nft && (!cap.read || cap.down)) cells.push(stat("Cap", cap.read ? dash(RPC_DOWN) : html`<span class="sk sk-stat"></span>`));
  cells.push(stat("Holders", holders === null || holders === undefined ? dash("Holders not reported by the index") : html`<span class="num-mono">${int(holders)}</span>`));
  cells.push(stat("Transfers", c ? html`<span class="num-mono">${int(c.transfers_count)}</span>` : dash("Transfer count not reported by the index")));
  if (!nft) cells.push(stat("Decimals", d === null ? dash("Decimals not reported by the index") : html`<span class="num-mono">${d}</span>`));
  return html`<div class="statgrid tk-stats" style="--n:${cells.length}">${cells}</div>`;
}

/** The stat row of a token read from the chain. Nothing minted means no holders and no transfers; otherwise those
 *  wait for the index. */
function chainStatsHtml(t: TokenInfo, supply: bigint | null, cap: { v: bigint | null; down: boolean; read: boolean }): Html {
  const nft = isNft(t);
  const d = decimalsOf(t);
  const none = supply === 0n;
  const later = dash("Not in the explorer's index yet");
  const cells: Html[] = [];
  cells.push(stat(html`Total supply ${prov("chain")}`, supply === null ? dash("The contract has no totalSupply()") : supplyHtml(t, true),
    nft ? progress(supply, cap.v) : d !== null && supply !== null ? html`<span class="num-mono">${amountExact(supply, d)}</span>` : null));
  if (cap.v !== null) cells.push(stat(html`Cap ${prov("chain")}`, html`<span class="num-mono">${nft ? int(cap.v) : d !== null ? amountExact(cap.v, d) : int(cap.v)}</span>${!nft && t.symbol ? html`<span class="unit">${t.symbol}</span>` : ""}`, nft ? "the contract's highest token id" : "the contract's cap()"));
  else if (nft && (!cap.read || cap.down)) cells.push(stat("Cap", cap.read ? dash(RPC_DOWN) : html`<span class="sk sk-stat"></span>`));
  cells.push(stat("Holders", none ? html`<span class="num-mono">0</span>` : later));
  cells.push(stat("Transfers", none ? html`<span class="num-mono">0</span>` : later));
  if (!nft) cells.push(stat(html`Decimals ${prov("chain")}`, d === null ? dash("The contract has no decimals()") : html`<span class="num-mono">${d}</span>`));
  return html`<div class="statgrid tk-stats" style="--n:${cells.length}">${cells}</div>`;
}
