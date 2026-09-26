/* NFT instance `/token/:addr/instance/:id` (§5.11). ferminux.net /nfts/ links here, so it must be faithful.
   BS /tokens/:a/instances/:id (+ /transfers, /transfers-count, the collection's /instances for "More from");
   RPC tokenURI(id) and the cap (MAX_ID) for "of 41", ownerOf(id) when the index has no owner, and on a 404
   minted(id)/ownerOf(id) to say WHY (not minted yet, or minted but not indexed yet). A collection the index hasn't
   catalogued yet (nothing minted, so no Transfer) is read from the chain (chainToken) and gets the same answers.
   Layout: the image 5/12 (1:1 on #000, sticky on desktop) · the details 7/12 (h1, collection line, kv with
   Owner · Token ID · Minted · Transfers · Description · Attributes · Links); tabs Transfers · Metadata
   (Table · JSON). Phone: the image first, full width, then the details. */
import { html, mount, dash, type Html } from "../ui/html";
import { addrChip, txChip, blockLink } from "../ui/hash";
import { prov, ago } from "../ui/marks";
import { table, tableSkeleton } from "../ui/table";
import { tabsHtml, bindTabs } from "../ui/tabs";
import { pagerHtml, bindPager, pageOf } from "../ui/pager";
import { kv, type Group, type Row } from "../ui/kv";
import { sk, kvSkeleton } from "../ui/skeleton";
import { empty, showError } from "../ui/state";
import { copyBtn } from "../ui/copy";
import { api, cachedTokens, ApiError } from "../api";
import { knownContract } from "../known";
import { RPC_DOWN } from "../rpc";
import { int, short, safeHref, pretty } from "../format";
import { isAddr, lc } from "../util";
import { crumbs, pageHead, slot } from "./_shell";
import { notFound } from "./notFound";
import { navigate, resolveTab, setMeta, type Params } from "../router";
import type { PageParams, TokenInfo, TokenInstance, TokenTransfer } from "../types";
import {
  isNft, tokenName, tokenDisc, stdTag, transfersTable, nftTile, tileGrid, bindMedia, media, attrOf, isLegendary, instName,
  imageOf, capOf, chainRead, withUint, decString, decAddr, decBool, SEL, pillFor, tierOf, tierPill, chainToken,
} from "./tokens/common";

type Meta = NonNullable<TokenInstance["metadata"]>;
const txSk = () => tableSkeleton({ caption: "Loading", captionHidden: true, cols: [
  { label: "Tx", cell: () => "" }, { label: "Kind", cell: () => "" }, { label: "From → To", cell: () => "", line: 2 },
  { label: "Block", cell: () => "", align: "r", line: 3 }, { label: "Age", cell: () => "", align: "r", end: true },
] }, 3);

export function render(p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const a = p.addr;
  if (!isAddr(a) || !/^\d{1,78}$/.test(p.id)) { notFound(root, { h1: "That isn't a token instance", body: "An instance link is /token/0x…/instance/<number>." }); return; }
  const id = BigInt(p.id).toString(); // "041" → "41"
  if (id !== p.id) history.replaceState(history.state, "", `/token/${a}/instance/${id}${location.search}${location.hash}`);
  const choice = resolveTab("instance", query);
  const cur = pageOf(query);
  const cached = cachedTokens().find((x) => lc(x.address_hash) === lc(a)) ?? null;
  const known = knownContract(a);
  const sym0 = cached?.symbol ?? null;
  setMeta({ title: `${sym0 ?? short(a, 4)} #${id}` });

  mount(root, html`<div class="container page">
    <div class="tk-crumbs">${crumbs([{ href: "/tokens", label: "Tokens" }, { href: `/token/${a}`, label: sym0 ?? known?.short ?? short(a, 4) }, { label: `#${id}` }])}</div>
    <div class="tk-nft">
      <figure class="tk-hero" data-slot="hero"><span class="tk-media"><span class="skel"><span class="sk"></span></span></span><figcaption><span>${sk("120px")}</span></figcaption></figure>
      <div class="tk-nft-main">
        ${pageHead({ h1: html`<span data-slot="h1">${sym0 ? `${sym0} #${id}` : `#${id}`}</span>`, ident: html`<span class="tk-ident" data-slot="ident">${sk("280px")}</span>` })}
        <div data-slot="kv">${kvSkeleton(["Owner", "Token ID", "Minted", "Transfers", "Description", "Attributes", "Collection"])}</div>
      </div>
    </div>
    <section class="tk-sec" aria-label="Transfers and metadata" data-slot="tabs">${txSk()}</section>
    <section class="tk-sec" data-slot="more" hidden></section>
  </div>`);

  const instP = api.tokenInstance(a, id, { signal });
  const countP = api.tokenInstanceTransfersCount(a, id, { signal }).catch((e: unknown) => { if (signal.aborted) throw e; return null; });
  const firstP = api.tokenInstanceTransfers(a, id, null, { signal }).catch((e: unknown) => { if (signal.aborted) throw e; return null; });

  void (async () => {
    let inst: TokenInstance;
    try { inst = await instP; } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.notFound) { await missing(); return; }
      showError(slot(root, "kv"), e, () => navigate(location.pathname + location.search, { replace: true, focus: "none" }));
      return;
    }
    if (signal.aborted) return;
    let t: TokenInfo | null = inst.token ?? cached;
    if (!t) { try { t = await api.token(a, { signal }); } catch { t = null; } }
    if (signal.aborted) return;
    const token: TokenInfo = t ?? { address_hash: a, name: known?.short ?? null, symbol: null, type: "FRC-721", decimals: null, total_supply: null, holders_count: null, icon_url: null };
    paint(inst, token);
  })();

  /* ---------------------------------------------------------------- the entity */

  function paint(inst: TokenInstance, t: TokenInfo) {
    const m = inst.metadata;
    const nm = instName(inst, t.symbol);
    const coll = tokenName(t);
    const tier = tierOf(m);
    const leg = isLegendary(m) || tier?.key === "legendary";
    const img = imageOf(inst);
    const desc = typeof m?.description === "string" ? m.description.trim() : "";
    setMeta({ title: `${nm.full} · ${coll}`, description: desc ? desc.slice(0, 158) + (desc.length > 158 ? "…" : "") : `${nm.full}, token #${id} of ${coll} (${t.type}) on Ferminux Network (chain 3961): owner, attributes and transfers.` });
    const crumb = root.querySelectorAll<HTMLElement>(".crumbs a")[1];
    if (crumb && t.symbol) crumb.textContent = t.symbol;

    // image
    const hero = slot(root, "hero")!;
    hero.classList.toggle("legendary", leg);
    if (tier?.key) hero.classList.add(`t-${tier.key}`);
    const safe = safeHref(img);
    mount(hero, html`${media(img, { alt: nm.full, eager: true, showUrl: true })}<figcaption><span>${t.symbol ?? coll} #${id}${leg ? " · 1/1" : ""}</span>${safe !== "#" ? html`<a href="${img ?? ""}" rel="noopener" data-external>Full-size image ↗</a>` : ""}</figcaption>`);
    bindMedia(hero);

    // head
    mount(slot(root, "h1"), nm.full);
    mount(slot(root, "ident"), html`<a class="tk-coll" href="/token/${t.address_hash}">${tokenDisc(t)}<span>${coll}</span></a>${stdTag(t.type)}${tierPill(m)}${pillFor(attrOf(m, "Category"), leg && !tier)}${tier ? pillFor(attrOf(m, "Series")) : ""}${pillFor(attrOf(m, "Edition"))}`);

    // details
    const attrs = (m?.attributes ?? []).filter((x) => x && x.value !== undefined && x.value !== null);
    const ext = externalLink(inst, id);
    const groups: Group[] = [
      [
        { label: "Owner", value: inst.owner ? addrChip(inst.owner) : html`<span data-slot="owner">${sk("200px")}</span>` },
        { label: "Token ID", value: html`<span class="num-mono">${id}</span><span data-slot="of"></span>` },
        { label: "Minted", value: html`<span data-slot="minted">${sk("260px")}</span>` },
        { label: "Transfers", value: html`<span data-slot="tcount">${sk("32px")}</span>` },
      ],
      [
        ...(desc ? [{ label: "Description", value: html`<div class="tk-dwrap"><p class="tk-desc" id="tk-desc">${desc}</p><button type="button" class="tk-more" data-desc-more aria-controls="tk-desc" aria-expanded="false" hidden>more</button></div>` }] : [{ label: "Description", value: dash("No description in the metadata") }]),
        ...(attrs.length ? [{ label: "Attributes", value: html`<ul class="tk-attrs">${attrs.map((x) => html`<li class="tk-attr"><span class="l">${x.trait_type || "Trait"}</span><span class="v">${typeof x.value === "object" ? JSON.stringify(x.value) : String(x.value)}</span></li>`)}</ul>` }] : []),
      ],
      [
        { label: "Collection", value: html`${addrChip(t.address_hash)}${stdTag(t.type)}` },
        ...(ext ? [{ label: "Links", value: html`<a class="link-arrow" href="${ext}" rel="noopener" data-external>View on ${new URL(ext).hostname} ↗</a>` }] : []),
      ],
    ];
    const more: Row[] = [
      { label: "Token URI", value: html`<span data-slot="uri">${sk("240px")}</span>`, hint: "tokenURI(id), read from the contract just now." },
      { label: "Image", value: img ? (safe !== "#" ? html`<a class="hc-full link-inline" href="${img}" rel="noopener" data-external>${img}</a>` : html`<span class="hc-full">${img}</span>`) : dash("No image in the metadata") },
    ];
    mount(slot(root, "kv"), kv(groups, { page: "instance", rows: more }));
    bindDesc();

    void chainFacts(inst, t);
    void countP.then((c) => { if (!signal.aborted) mount(slot(root, "tcount"), c ? html`<span class="num-mono">${int(c.transfers_count)}</span>` : dash("Transfer count not reported by the index")); }, () => { /* aborted */ });
    void firstP.then((r) => { if (!signal.aborted) mount(slot(root, "minted"), mintedHtml(r)); }, () => { /* aborted */ });

    void countP.then((c) => { if (!signal.aborted) paintTabs(inst, t, c?.transfers_count ?? null); }, () => { /* aborted */ });
    void moreFrom(t);
  }

  /** "4 lines, then more": the button shows only when the text is clamped. */
  function bindDesc() {
    const p = root.querySelector<HTMLElement>("#tk-desc");
    const b = root.querySelector<HTMLButtonElement>("[data-desc-more]");
    if (!p || !b) return;
    requestAnimationFrame(() => { if (p.scrollHeight > p.clientHeight + 2) b.hidden = false; });
    b.addEventListener("click", () => {
      const open = !p.classList.contains("open");
      p.classList.toggle("open", open);
      b.textContent = open ? "less" : "more";
      b.setAttribute("aria-expanded", String(open));
    });
  }

  /** Chain reads, in one batch: the cap ("of 41"), tokenURI(id), and ownerOf(id) when the index had no owner. */
  async function chainFacts(inst: TokenInstance, t: TokenInfo) {
    const [cap, uri, own] = await Promise.all([
      isNft(t) ? capOf(t, signal).catch(() => null) : Promise.resolve(null),
      chainRead(t.address_hash, withUint(SEL.tokenURI, id), signal).then(decString, (e: unknown) => (isAbortErr(e) ? Promise.reject(e) : null)),
      inst.owner ? Promise.resolve(null) : chainRead(t.address_hash, withUint(SEL.ownerOf, id), signal).then(decAddr, (e: unknown) => (isAbortErr(e) ? Promise.reject(e) : null)),
    ]).catch(() => [null, null, null] as const);
    if (signal.aborted) return;
    if (cap?.cap) mount(slot(root, "of"), html` <span class="faint">of <span class="num-mono">${int(cap.cap)}</span></span> ${prov("chain")}`);
    const u = slot(root, "uri");
    if (u) mount(u, uri ? (safeHref(uri) !== "#" ? html`<a class="hc-full link-inline" href="${uri}" rel="noopener" data-external>${uri}</a> ${prov("chain")}` : html`<span class="hc-full">${uri}</span> ${prov("chain")}`) : dash(RPC_DOWN));
    const o = slot(root, "owner");
    if (o) mount(o, own ? html`${addrChip(own)} ${prov("chain")}` : dash("Owner not reported by the index, and the chain read failed"));
  }

  function mintedHtml(r: { items: TokenTransfer[]; next_page_params: PageParams | null } | null): Html {
    if (!r) return dash("Transfers not reported by the index");
    const mints = r.items.filter((x) => x.type === "token_minting");
    const mt = mints[mints.length - 1];
    if (!mt) return dash(r.next_page_params ? "The mint is older than the newest 50 transfers" : "No mint transfer in the index");
    return html`<span class="faint">block</span> ${blockLink(mt.block_number)} <span class="faint">in</span> ${txChip(mt.transaction_hash, { copy: true })} <span class="faint">${ago(mt.timestamp)}</span>`;
  }

  /* ---------------------------------------------------------------- tabs */

  function paintTabs(inst: TokenInstance, t: TokenInfo, count: number | null) {
    const host = slot(root, "tabs")!;
    const def = "token_transfers";
    const active = choice.tab === "metadata" ? "metadata" : def;
    mount(host, tabsHtml("nft-tabs", [
      { key: "token_transfers", label: "Transfers", count, always: true },
      { key: "metadata", label: "Metadata", always: true },
    ], active, "Instance sections"));
    const first = active;
    bindTabs(host, "nft-tabs", def, (key, panel) => {
      if (key === "metadata") metadataPanel(inst.metadata, panel);
      else transfersPanel(t, panel, key === first ? cur : { page: 1, params: null, expired: false });
    }, signal);
  }

  function transfersPanel(t: TokenInfo, panel: HTMLElement, at: { page: number; params: PageParams | null; expired: boolean }) {
    mount(panel, txSk());
    api.tokenInstanceTransfers(a, id, at.params, { signal }).then((r) => {
      if (signal.aborted) return;
      if (!r.items.length && at.page === 1) { mount(panel, empty("No transfers of this token yet.")); return; }
      const pager = at.page > 1 || r.next_page_params;
      mount(panel, html`${transfersTable(r.items, { token: t, caption: `Transfers of #${id}`, instance: true })}${pager ? pagerHtml({ page: at.page, next: r.next_page_params, expired: at.expired }) : ""}`);
      if (pager) bindPager(panel, { page: at.page, next: r.next_page_params, current: at.params });
    }, (e) => { if (!signal.aborted) showError(panel, e, () => transfersPanel(t, panel, at)); });
  }

  function metadataPanel(m: Meta | null, panel: HTMLElement) {
    if (!m || !Object.keys(m).length) { mount(panel, empty("The index holds no metadata for this token.")); return; }
    const json = pretty(m);
    const rows = Object.entries(m);
    const cell = (v: unknown): Html => {
      if (Array.isArray(v)) return html`<span class="faint">${v.length} ${v.length === 1 ? "item" : "items"}</span>`;
      if (v && typeof v === "object") return html`<span class="num-mono">${JSON.stringify(v)}</span>`;
      const s = String(v ?? "");
      return /^https?:\/\//i.test(s) && safeHref(s) !== "#" ? html`<a class="hc-full link-inline" href="${s}" rel="noopener" data-external>${s}</a>` : html`<span class="tk-mv">${s}</span>`;
    };
    mount(panel, html`<div class="tk-meta-bar"><div class="seg" role="group" aria-label="Metadata view"><button type="button" data-mv="table" aria-pressed="true">Table</button><button type="button" data-mv="json" aria-pressed="false">JSON</button></div><span class="faint small">From the explorer's index</span></div>
      <div data-mview="table" class="tk-meta">${table({ caption: "Metadata", captionHidden: true, dense: true, rows, cols: [
        { label: "Key", cell: ([k]) => html`<span class="num-mono muted">${k}</span>`, w: "180px" },
        { label: "Value", cell: ([, v]) => cell(v), line: 2 },
      ] })}</div>
      <div data-mview="json" hidden><div class="tk-code"><div class="code-head"><span class="mono">metadata.json · ${int(new TextEncoder().encode(json).length)} bytes</span>${copyBtn(json, "Copy metadata JSON")}</div><pre><code>${json}</code></pre></div></div>`);
    panel.querySelector(".seg")?.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>("[data-mv]");
      if (!b) return;
      panel.querySelectorAll<HTMLButtonElement>("[data-mv]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      panel.querySelectorAll<HTMLElement>("[data-mview]").forEach((v) => { v.hidden = v.dataset.mview !== b.dataset.mv; });
    });
  }

  /* ---------------------------------------------------------------- more from the collection */

  async function moreFrom(t: TokenInfo) {
    let r: { items: TokenInstance[] } | null = null;
    try { r = await api.tokenInstances(a, null, { signal }); } catch { return; }
    if (signal.aborted || !r) return;
    const others = r.items.filter((x) => x.id !== id).slice(0, 6);
    if (!others.length) return;
    const host = slot(root, "more")!;
    const total = t.total_supply ? Number(t.total_supply) : null;
    mount(host, html`<div class="tk-sec-head"><h2 id="nft-more-h">More from ${tokenName(t)}</h2><a href="/token/${t.address_hash}">${total ? `All ${int(total)} →` : "The collection →"}</a></div>${tileGrid(others.map((x) => nftTile(x, t)), "six")}`);
    host.setAttribute("aria-labelledby", "nft-more-h");
    host.hidden = false;
    bindMedia(host);
  }

  /* ---------------------------------------------------------------- 404: say why */

  async function missing() {
    let t: TokenInfo | null = null;
    let fromChain = false; // the collection itself isn't in the index: it has no Transfer from this contract yet
    try { t = await api.token(a, { signal }); } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.notFound) {
        // a collection the index hasn't met yet (it lists one after the first Transfer): read it from the chain
        const ct = await chainToken(a, signal).catch(() => (signal.aborted ? null : "down" as const));
        if (signal.aborted) return;
        if (ct === "down") {
          notFound(root, { h1: `${known?.short ?? short(a, 4)} #${id} isn't in the explorer's index`, body: html`The chain RPC didn't answer, so the contract couldn't be read to check this id. Try again in a minute. <a class="link-inline" href="/address/${a}">Open it as an address →</a>`, links: false });
          return;
        }
        if (!ct || !isNft(ct.token)) {
          notFound(root, { h1: html`No token at <span class="num-mono">${short(a, 6)}</span>`, body: html`The explorer's index has no FRC-721 collection at this address on chain 3961. <a class="link-inline" href="/address/${a}">Open it as an address →</a>`, query: a });
          return;
        }
        t = ct.token;
        fromChain = true;
      }
    }
    if (signal.aborted) return;
    const coll = t ? tokenName(t) : known?.short ?? short(a, 4);
    // A mint page from the book's optional mintUrl ("…?id={id}"), for collections anyone can mint from.
    const mintAt = known?.mintUrl ? known.mintUrl.replace("{id}", id) : null;
    // One batch: does the id exist on chain (ownerOf answers), minted(id) where the contract has it, and the cap.
    const [own, minted, cap] = await Promise.all([
      chainRead(a, withUint(SEL.ownerOf, id), signal).then(decAddr, (e: unknown) => (isAbortErr(e) ? Promise.reject(e) : null)),
      chainRead(a, withUint(SEL.minted, id), signal).then(decBool, (e: unknown) => (isAbortErr(e) ? Promise.reject(e) : null)),
      t ? capOf(t, signal).then((c) => c.cap, () => null) : Promise.resolve(null),
    ]).catch(() => [null, null, null] as const);
    if (signal.aborted) return;
    const back = html`<a class="link-inline" href="/token/${a}">${coll} →</a>`;
    if (own && minted !== false) {
      notFound(root, { h1: `${coll} #${id} isn't in the explorer's index yet`, body: html`It exists on chain 3961 and is owned by <span class="num-mono">${short(own, 4)}</span> (read from the chain just now), but ${fromChain
        ? "the index has no Transfer from this contract yet, so it can't show it."
        : "the index hasn't read it. Try again in a minute."} ${back}`, links: false });
      return;
    }
    if (minted === false && cap !== null && BigInt(id) >= 1n && BigInt(id) <= cap) {
      const mint = mintAt && safeHref(mintAt) !== "#" ? html`<a class="link-inline" href="${mintAt}" rel="noopener" data-external>Mint it on ${new URL(mintAt).hostname} ↗</a> · ` : "";
      notFound(root, { h1: `${coll} #${id} hasn't been minted yet`, body: html`Every id from 1 to ${int(cap)} can exist exactly once; #${id} is still free (read from the chain just now). ${mint}${back}`, links: false });
      return;
    }
    notFound(root, { h1: `No token #${id} in ${coll}`, body: html`${coll} has no token with this id on chain 3961${cap !== null ? html` (ids run up to ${int(cap)})` : ""}. ${back}` });
  }
}

const isAbortErr = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** The metadata's app link. ferminux.net /nfts/ (and /nfts/<collection>/) answers ?id=N with that token. */
function externalLink(inst: TokenInstance, id: string): string | null {
  const u = inst.external_app_url || (typeof inst.metadata?.external_url === "string" ? inst.metadata.external_url : null);
  if (!u || safeHref(u) === "#") return null;
  try {
    const url = new URL(u);
    if (url.hostname === "ferminux.net" && /^\/nfts(\/[a-z0-9-]+)?\/?$/.test(url.pathname) && !url.searchParams.has("id")) url.searchParams.set("id", id);
    return url.href;
  } catch { return null; }
}
