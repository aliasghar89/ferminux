import type { Contract } from "ethers";
import { citizensDeployed, config, explorerAddr, explorerTx, nftDeployed } from "../config";
import { esc, fmx, fmxUnit, int, safeHref } from "../format";
import { $, $$, addrHtml, initChrome, setBusy, skel, toast, txHtml } from "../ui";
import { connect, errMessage, getBalance, hasInjected, nftRead, nftWrite, onWallet, sendCall, walletState } from "../wallet";
import { allIds, artHasLabel, artHtml, bindArt, category, collectionState, imageUrl, isLegendary, loadCollection, metaUrl, mockMarkMinted, ownerBook, status as readStatus, statuses, type NftMeta, type NftStatus } from "../nft";
import { citizensQuery, inCitizensFilter, inFilter, ownerLabel, parseCitizensFilter, tierName, TIERS, type CitizensFilter, type NftFilter, type OwnerBook, type OwnerLabel, type TierName } from "../nftView";
import { citizenStatus, citizensImageUrl, citizensMetaUrl, citizensRead, citizensState, citizensStatuses, citizensWrite, liveTier, loadCitizens, loadExtraMetas, metaSeries, mockCitizenMinted } from "../citizens";
import { citizensMeta } from "../deployments.generated";

initChrome();
const view = $("#view")!;
const MOCK = import.meta.env.VITE_MOCK === "1"; // literal (not config.mock) so the mock branches are dropped from production

// Two collections on one page: Ferminux Agents at /nfts/ and Ferminux Citizens at /nfts/citizens/ (its own HTML
// entry, so a shared link carries its own title and share image). Switching is a pushState; each collection keeps
// its data, so going back and forth never reloads artwork or re-reads the chain.
type Key = "agents" | "citizens";
interface Coll {
  key: Key; path: string; name: string; symbol: string; address: string; live: boolean;
  base: string; ext: "png" | "jpg";
  metas: NftMeta[]; status: Map<number, NftStatus>; loadErr: string; statusErr: string; started: boolean;
  paused: boolean; totalSupply: number | null; totalIds: number | null;
  /** Agents: the one mint price. */ price: bigint | null;
  /** Citizens: price per tier index, read live. */ prices: bigint[] | null;
  filter: CitizensFilter;
  /** ids with a mint in flight: nothing repaints their panel, and a second click does nothing */
  minting: Set<number>;
}
const blank = { metas: [], status: new Map(), loadErr: "", statusErr: "", started: false, paused: false, totalSupply: null, totalIds: null, price: null, prices: null, minting: new Set<number>() };
const colls: Record<Key, Coll> = {
  agents: { key: "agents", path: "/nfts/", name: "Ferminux Agents", symbol: "FMXA", address: config.nft, live: nftDeployed || MOCK, base: config.nftBase, ext: "png", ...blank, status: new Map(), minting: new Set(), filter: { avail: "all", tier: "all", series: "all" } },
  citizens: { key: "citizens", path: "/nfts/citizens/", name: config.citizensName, symbol: config.citizensSymbol, address: config.citizens, live: citizensDeployed, base: config.citizensBase, ext: "jpg", ...blank, status: new Map(), minting: new Set(), filter: { avail: "all", tier: "all", series: "all" } },
};
const SERIES: readonly string[] = citizensMeta.series;
const keyOf = (p = location.pathname): Key => (/^\/nfts\/citizens(\/|$)/.test(p) ? "citizens" : "agents");
let c: Coll = colls[keyOf()];
let book: OwnerBook | null = null;

// ---------- shared bits ----------
const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();
const fmxText = (p: bigint | null) => (p === null ? "…" : `${fmx(p, 2)} FMX`);
const noBook: OwnerBook = { treasury: config.treasury, governance: config.governance, agents: [], wallets: [] };
const ownerOfS = (s: NftStatus): OwnerLabel | null => (s.owner ? ownerLabel(s.owner, book ?? noBook, walletState().address) : null);
const ownerTone = (o: OwnerLabel) => (o.kind === "you" ? "ok" : o.kind === "treasury" || o.kind === "governance" ? "accent" : "");
const tokenUrl = (k: Coll, id: number) => `${config.explorer}/token/${k.address}/instance/${id}`;
const isCit = (k: Coll) => k.key === "citizens";
const tierOfM = (k: Coll, m: NftMeta): TierName | null => (isCit(k) ? tierName(liveTier(m, k.status.get(m.id))) : null);
const seriesOf = (m: NftMeta) => metaSeries(m);
const bare = (m: NftMeta) => m.name.replace(/\s*#\d+$/, "");
/** The price this token mints for right now (null until the chain answered). */
function priceOf(k: Coll, m: NftMeta): bigint | null {
  if (!isCit(k)) return k.price;
  const t = liveTier(m, k.status.get(m.id));
  return k.prices && t >= 0 ? k.prices[t] ?? null : null;
}
/** Ids the contract has: all of collection.json until the contract answers, then 1..totalIds. */
const visible = (k: Coll) => (isCit(k) && k.live && k.totalIds !== null ? k.metas.filter((m) => m.id <= k.totalIds!) : k.metas);
const total = (k: Coll) => (isCit(k) ? (k.live && k.totalIds !== null ? k.totalIds : k.metas.length || null) : k.metas.length || config.nftSupply);
const tierBadge = (t: TierName | null, cls = "") => (t ? `<span class="tier t-${t.toLowerCase()}${cls ? ` ${cls}` : ""}">${t}</span>` : "");
const shows = (k: Coll, m: NftMeta) => (isCit(k)
  ? inCitizensFilter(k.filter, { tier: tierOfM(k, m), series: seriesOf(m) }, k.status.get(m.id))
  : inFilter(k.filter.avail, k.status.get(m.id)));
const listQuery = (k: Coll) => (isCit(k) ? citizensQuery(k.filter) : k.filter.avail === "all" ? "" : `?filter=${k.filter.avail}`);

/** An owner in words, linked to their explorer address page. */
function ownerLink(k: Coll, s: NftStatus, cls: string): string {
  const o = ownerOfS(s);
  if (!o || !s.owner) return `<a class="${cls}" href="${tokenUrl(k, s.id)}" rel="noopener">Minted</a>`;
  return `<a class="${cls} ${ownerTone(o)}" href="${explorerAddr(s.owner)}" rel="noopener" title="${esc(s.owner)}" aria-label="Owner: ${esc(o.name)}, ${esc(s.owner)}, on the explorer">${esc(o.name)}</a>`;
}

/** The card's one row under the artwork: Mint (a label; the whole card is the link) or who owns it. */
function cardStatusHtml(k: Coll, m: NftMeta, s: NftStatus | undefined): string {
  if (isCit(k) && !k.live) return `<span class="nft-row"><span class="pill">Opens soon</span></span>`;
  if (!s) return `<span class="nft-row">${skel("72%")}</span>`;
  if (!s.minted) return k.paused ? `<span class="nft-row"><span class="pill">Minting paused</span></span>`
    : `<span class="btn btn-ghost btn-xs" aria-hidden="true">Mint · ${esc(fmxText(priceOf(k, m)))}</span>`;
  return `<span class="nft-row nft-own"><span class="l" aria-hidden="true">Owner</span>${ownerLink(k, s, "v")}</span>`;
}
function cardLabel(k: Coll, m: NftMeta, s: NftStatus | undefined): string {
  const what = isCit(k) ? `${[tierOfM(k, m), seriesOf(m)].filter(Boolean).join(", ")}` : category(m);
  const avail = isCit(k) && !k.live ? ", minting opens soon" : !s ? "" : !s.minted ? (k.paused ? ", minting paused" : `, available to mint for ${fmxText(priceOf(k, m))}`) : `, owned by ${ownerOfS(s)?.name ?? "someone"}`;
  return `${m.name}, ${what}${avail}`;
}
function cardHtml(k: Coll, m: NftMeta, i: number): string {
  const s = k.status.get(m.id);
  const sizes = "(min-width:1000px) 168px, (min-width:760px) 23vw, (min-width:560px) 31vw, 46vw";
  if (isCit(k)) {
    const t = tierOfM(k, m);
    return `<article class="nft-card nft-card-link cit-card${t ? ` t-${t.toLowerCase()}` : ""}${s?.minted ? " is-minted" : ""}" id="nft-${m.id}" data-id="${m.id}"${shows(k, m) ? "" : " hidden"}>
    <span class="nft-img">${artHtml(m, { sizes, eager: i < 6, base: k.base, ext: k.ext })}<span class="tier-on-art" aria-hidden="true">${tierBadge(t)}</span></span>
    <div class="nft-body">
      <a class="nft-name cit-name" href="${k.path}?id=${m.id}" data-detail="${m.id}" aria-label="${esc(cardLabel(k, m, s))}"><span class="t">${esc(bare(m))}</span><span class="n num">#${m.id}</span></a>
      <div class="nft-status">${cardStatusHtml(k, m, s)}</div>
    </div>
  </article>`;
  }
  const leg = isLegendary(m);
  // The archetype art already shows its number, name and category, so the card does not repeat them; the
  // legendary's art is unlabelled, so the card writes its label in the same place (decorative: the link names it).
  const label = artHasLabel(m) ? "" : `<span class="nft-label" aria-hidden="true"><span class="n">${m.id}</span><span class="t">${esc(bare(m))}</span><span class="c">${esc(category(m))}</span></span>`;
  return `<article class="nft-card nft-card-link${leg ? " legendary" : ""}${s?.minted ? " is-minted" : ""}" id="nft-${m.id}" data-id="${m.id}"${shows(k, m) ? "" : " hidden"}>
    <span class="nft-img">${artHtml(m, { sizes, eager: i < 6 })}${label}</span>
    <div class="nft-body">
      <a class="nft-name" href="/nfts/?id=${m.id}" data-detail="${m.id}" aria-label="${esc(cardLabel(k, m, s))}"></a>
      <div class="nft-status">${cardStatusHtml(k, m, s)}</div>
    </div>
  </article>`;
}

// ---------- list view ----------
function tabsHtml(): string {
  return `<nav class="tabs nft-tabs" aria-label="Collections">${(["agents", "citizens"] as Key[]).map((key) => {
    const k = colls[key];
    return `<a class="tab" href="${k.path}" data-coll="${key}"${key === c.key ? ` aria-current="page"` : ""}>${esc(k.name.replace(/^Ferminux\s+/, ""))}</a>`;
  }).join("")}</nav>`;
}
function statusPill(k: Coll): string {
  if (isCit(k) && !k.live) return `<span class="pill">Opens soon</span>`;
  if (k.totalSupply === null && k.price === null && k.prices === null) return skel("50%");
  return k.paused ? `<span class="pill warn">Paused</span>` : `<span class="pill ok">Minting open</span>`;
}
function mintedText(k: Coll): string {
  if (isCit(k)) {
    if (!k.live) return "—";
    return k.totalSupply !== null && k.totalIds !== null ? `${int(k.totalSupply)} / ${int(k.totalIds)}` : skel("50%");
  }
  const minted = [...k.status.values()].filter((s) => s.minted).length;
  return k.status.size ? `${int(minted)} / ${int(total(k))}` : skel("50%");
}
function renderList() {
  const k = c;
  if (isCit(k)) { renderCitizensList(k); return; }
  view.innerHTML = `
    ${tabsHtml()}
    <section class="hero-sm">
      <div class="page-title"><div><p class="kicker" style="margin-bottom:8px">Ferminux Agents · FRC-721 · FMXA</p><h1>Ferminux Agents — 41 one-of-ones</h1><p>Forty agent archetypes and one legendary operator, each a single token on chain 3961. Mint straight from the contract; every id can exist exactly once.</p></div>
      <div class="hero-actions" style="margin-top:0"><a class="btn btn-secondary" href="${explorerAddr(config.nft)}" rel="noopener">Contract on the explorer</a><a class="btn btn-primary" id="nft-pick" href="/nfts/?filter=available">Mint an agent<span class="num" id="nft-pick-price">${k.price === null ? "" : `· ${esc(fmxText(k.price))}`}</span></a></div></div>
    </section>
    <div class="statgrid nft-stats" aria-label="Collection facts">
      <div><span class="l">Mint price</span><span class="v num" id="nft-price">${k.price === null ? skel("60%") : esc(fmxText(k.price))}</span></div>
      <div><span class="l">Minted</span><span class="v num" id="nft-minted">${mintedText(k)}</span></div>
      <div><span class="l">Status</span><span class="v" id="nft-paused">${k.price === null ? skel("50%") : statusPill(k)}</span></div>
      <div><span class="l">Contract</span><span class="v" style="font-size:14px">${addrHtml(config.nft, { n: 6, label: "Collection" })}</span></div>
    </div>
    ${availSegHtml(k)}
    <div id="nft-alert" class="alert warn" style="margin-bottom:14px"></div>
    <div class="nft-grid" id="nft-grid" aria-busy="true"></div>
    <div class="empty" id="nft-empty" hidden><h3>Nothing here</h3><span></span></div>
    <p class="small faint" style="margin:18px 0 56px">Metadata: <a class="mono" href="${config.nftBase}/collection.json" rel="noopener" style="text-decoration:underline">collection.json</a> · per token <span class="mono" style="overflow-wrap:anywhere">${esc(config.nftBase)}/meta/&lt;id&gt;.json</span> · images 512 px PNG. <code>mint(tokenId)</code> must be sent with exactly <code>price()</code> in FMX; #41 was minted to the treasury at deploy.</p>`;
  wireList(k);
}
function availSegHtml(k: Coll): string {
  return `<div class="seg-row" style="margin-top:18px">
      <div class="seg" role="group" aria-label="Availability">
        <button type="button" data-f="all" aria-pressed="${k.filter.avail === "all"}">All</button>
        <button type="button" data-f="available" aria-pressed="${k.filter.avail === "available"}">Available</button>
        <button type="button" data-f="minted" aria-pressed="${k.filter.avail === "minted"}">Minted</button>
      </div>
      <span class="result-count" id="nft-count" style="margin:0" aria-live="polite"></span>
    </div>`;
}
function tierSegLabel(k: Coll, t: TierName, i: number): string {
  const p = k.live && k.prices ? k.prices[i] : null;
  return `<span class="tier-dot t-${t.toLowerCase()}" aria-hidden="true"></span><span>${t}</span>${p !== null ? `<span class="num tier-price">${fmx(p, 2)} FMX</span>` : ""}`;
}
function renderCitizensList(k: Coll) {
  const launch = citizensMeta.tiers.map((t) => `${t.name} ${t.price}`).join(", ").replace(/, ([^,]*)$/, " and $1");
  view.innerHTML = `
    ${tabsHtml()}
    <section class="hero-sm">
      <div class="page-title"><div><p class="kicker" style="margin-bottom:8px">${esc(k.name)} · FRC-721 · ${esc(k.symbol)}</p><h1>${esc(k.name)}</h1><p>One-of-one portraits of the people, androids and creatures of Ferminux, priced by rarity tier: Common, Rare, Epic and Legendary. The collection grows as new artwork arrives; every id can exist exactly once.</p></div>
      <div class="hero-actions" style="margin-top:0">${k.live ? `<a class="btn btn-secondary" href="${explorerAddr(k.address)}" rel="noopener">Contract on the explorer</a>` : ""}<a class="btn btn-primary" id="nft-pick" href="${k.path}?filter=available">${k.live ? "Mint a citizen" : "Browse the citizens"}</a></div></div>
    </section>
    <div class="statgrid nft-stats" aria-label="Collection facts">
      <div><span class="l">Tokens</span><span class="v num" id="nft-total">${total(k) ? int(total(k)) : skel("40%")}</span></div>
      <div><span class="l">Minted</span><span class="v num" id="nft-minted">${mintedText(k)}</span></div>
      <div><span class="l">Status</span><span class="v" id="nft-paused">${statusPill(k)}</span></div>
      <div><span class="l">Contract</span><span class="v" style="font-size:14px">${k.live ? addrHtml(k.address, { n: 6, label: "Collection" }) : `<span class="faint">Not deployed yet</span>`}</span></div>
    </div>
    ${availSegHtml(k)}
    <div class="seg-row nft-facets">
      <div class="seg seg-wrap tier-seg" role="group" aria-label="Tier">
        <button type="button" data-t="all" aria-pressed="${k.filter.tier === "all"}">All tiers</button>
        ${TIERS.map((t, i) => `<button type="button" data-t="${t}" aria-pressed="${k.filter.tier === t}">${tierSegLabel(k, t, i)}</button>`).join("")}
      </div>
      <label class="nft-series"><span class="vh">Series</span><select id="nft-series" aria-label="Series"><option value="all">All series</option>${SERIES.map((s) => `<option value="${esc(s)}"${k.filter.series === s ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
    </div>
    <div id="nft-alert" class="alert ${k.live ? "warn" : "info"}" style="margin-bottom:14px"></div>
    <div class="nft-grid" id="nft-grid" aria-busy="true"></div>
    <div class="empty" id="nft-empty" hidden><h3>Nothing here</h3><span></span></div>
    <p class="small faint" style="margin:18px 0 56px">Metadata: <a class="mono" href="${k.base}/collection.json" rel="noopener" style="text-decoration:underline">collection.json</a> · per token <span class="mono" style="overflow-wrap:anywhere">${esc(k.base)}/meta/&lt;id&gt;.json</span> · full-size JPEG artwork. <code>mint(tokenId)</code> must be sent with exactly <code>price(tokenId)</code>, the price of the token's tier${k.live ? "" : `; launch prices: ${esc(launch)} FMX`}.</p>`;
  wireList(k);
  $("#nft-series", view)?.addEventListener("change", (e) => { k.filter.series = (e.target as HTMLSelectElement).value; syncFilter(k); });
  $$<HTMLButtonElement>(".tier-seg button", view).forEach((b) => b.addEventListener("click", () => { k.filter.tier = b.dataset.t as TierName | "all"; syncFilter(k); }));
}
function wireList(k: Coll) {
  $$<HTMLButtonElement>(".seg button[data-f]", view).forEach((b) => b.addEventListener("click", () => { k.filter.avail = b.dataset.f as NftFilter; syncFilter(k); }));
  $("#nft-pick")?.addEventListener("click", (e) => { e.preventDefault(); k.filter.avail = "available"; syncFilter(k); $("#nft-grid")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); });
  paintAlert();
  paintGrid();
}
/** Pressed states and the URL follow the filter; the cards are shown or hidden in place. */
function syncFilter(k: Coll) {
  $$<HTMLButtonElement>(".seg button[data-f]", view).forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.f === k.filter.avail)));
  $$<HTMLButtonElement>(".tier-seg button", view).forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.t === k.filter.tier)));
  const sel = $("#nft-series", view) as HTMLSelectElement | null; if (sel) sel.value = k.filter.series;
  history.replaceState(null, "", `${k.path}${listQuery(k)}`);
  applyFilter();
}
function paintAlert() {
  const a = $("#nft-alert"); if (!a) return;
  if (isCit(c)) {
    a.textContent = c.loadErr ? `Could not load the collection metadata: ${c.loadErr}` : !c.live ? "Minting opens soon. The contract is not deployed yet: browse the artwork now; every citizen is still unminted." : c.statusErr;
    a.className = `alert ${!c.live && !c.loadErr ? "info" : "warn"}`;
    return;
  }
  a.textContent = c.loadErr ? `Could not load the collection metadata: ${c.loadErr}` : nftDeployed ? c.statusErr : "The Ferminux Agents contract address is not configured on this build; showing metadata only.";
}
/** Builds the cards once. Filters and status changes then touch the existing cards, so an artwork that is
 *  loading (or loaded) is never thrown away and requested again. */
function paintGrid() {
  const grid = $("#nft-grid"); if (!grid) return;
  const list = visible(c);
  if (!list.length) {
    grid.innerHTML = c.loadErr ? "" : Array.from({ length: 12 }, () => `<div class="nft-card" aria-hidden="true"><div class="nft-img"><span class="sk" style="width:100%;height:100%;border-radius:0"></span></div><div class="nft-body"><span class="nft-row">${skel("72%")}</span></div></div>`).join("");
    return;
  }
  grid.innerHTML = list.map((m, i) => cardHtml(c, m, i)).join("");
  grid.dataset.ids = String(list.length);
  grid.setAttribute("aria-busy", "false");
  bindArt(grid);
  applyFilter();
}
function applyFilter() {
  const grid = $("#nft-grid"); if (!grid) return;
  const list = visible(c); if (!list.length) return;
  let n = 0;
  for (const m of list) {
    const card = $(`#nft-${m.id}`, grid); if (!card) continue;
    const on = shows(c, m);
    card.hidden = !on; if (on) n++;
  }
  const empty = $("#nft-empty");
  if (empty) {
    empty.hidden = n > 0;
    const narrowed = isCit(c) && (c.filter.tier !== "all" || c.filter.series !== "all");
    $("span", empty)!.textContent = narrowed ? "No token matches these filters." : c.filter.avail === "available" ? `Every ${isCit(c) ? "citizen" : "agent"} has been minted.` : "No token has been minted yet.";
  }
  const cnt = $("#nft-count"); if (cnt) cnt.textContent = c.filter.avail === "all" && !(isCit(c) && (c.filter.tier !== "all" || c.filter.series !== "all")) ? `${int(n)} tokens` : `${int(n)} shown`;
}
/** Status, owner names and prices changed: rewrite each card's row, tier and label in place. */
function updateCards() {
  const grid = $("#nft-grid"); if (!grid) return;
  const list = visible(c); if (!list.length) return;
  if (grid.dataset.ids !== String(list.length)) { paintGrid(); return; } // the contract has fewer or more ids than the file
  for (const m of list) {
    const card = $(`#nft-${m.id}`, grid); if (!card) continue;
    const s = c.status.get(m.id);
    card.classList.toggle("is-minted", !!s?.minted);
    if (isCit(c)) {
      const t = tierOfM(c, m);
      for (const x of TIERS) card.classList.toggle(`t-${x.toLowerCase()}`, x === t);
      const b = $(".tier-on-art", card); if (b) b.innerHTML = tierBadge(t);
    }
    $(".nft-status", card)!.innerHTML = cardStatusHtml(c, m, s);
    $(".nft-name", card)!.setAttribute("aria-label", cardLabel(c, m, s));
  }
  applyFilter();
}
function refreshStats() {
  const k = c;
  const el = $("#nft-minted"); if (el) el.innerHTML = mintedText(k);
  const pa = $("#nft-paused"); if (pa && (isCit(k) || k.price !== null)) pa.innerHTML = statusPill(k);
  const tt = $("#nft-total"); if (tt && total(k)) tt.textContent = int(total(k)!);
  if (!isCit(k)) {
    const p = $("#nft-price"); if (p && k.price !== null) p.textContent = fmxText(k.price);
    const pp = $("#nft-pick-price"); if (pp && k.price !== null) pp.textContent = `· ${fmxText(k.price)}`;
  } else {
    $$<HTMLButtonElement>(".tier-seg button[data-t]", view).forEach((b) => { const i = TIERS.indexOf(b.dataset.t as TierName); if (i >= 0) b.innerHTML = tierSegLabel(k, TIERS[i], i); });
  }
}

// ---------- detail view ----------
const attrOf = (m: NftMeta, t: string) => String(m.attributes.find((a) => a.trait_type === t)?.value ?? "—");
/** A long URL wraps after its slashes ("…/meta/ 10.json"), not in the middle of "10.js|on". */
const urlBreaks = (u: string) => esc(u).replace(/\/(?=[^/])/g, "/<wbr>");
const metaUrlOf = (k: Coll, id: number) => (isCit(k) ? citizensMetaUrl(id) : metaUrl(id));
const imageUrlOf = (k: Coll, m: NftMeta) => m.image || (isCit(k) ? citizensImageUrl(m.id) : imageUrl(m.id));
const backLabel = (k: Coll) => (isCit(k) ? "← All citizens" : "← All 41 agents");
function detailHtml(k: Coll, m: NftMeta): string {
  const s = k.status.get(m.id);
  const t = tierOfM(k, m);
  const cls = isCit(k) ? (t ? ` t-${t.toLowerCase()}` : "") : isLegendary(m) ? " legendary" : "";
  const pills = isCit(k)
    ? `${tierBadge(t)}${seriesOf(m) ? `<span class="pill">${esc(seriesOf(m))}</span>` : ""}<span class="pill">1/1</span>`
    : `<span class="pill ${isLegendary(m) ? "accent" : ""}">${esc(category(m))}</span><span class="pill">${esc(attrOf(m, "Edition"))}</span>`;
  const n = total(k);
  return `
    <p class="crumbs" style="margin-top:20px"><a href="${k.path}" data-detail="">${backLabel(k)}</a></p>
    <div class="nft-detail">
      <div class="nft-hero${cls}">${artHtml(m, { sizes: "(min-width:1152px) 512px, (min-width:900px) 44vw, calc(100vw - 32px)", alt: `${m.name} artwork`, eager: true, base: k.base, ext: k.ext })}</div>
      <div class="detail-main">
        <div>
          <div class="dhead"><h1>${esc(m.name)}</h1><div class="pills">${pills}</div></div>
          <p class="muted" style="margin-top:12px;font-size:15.5px">${esc(m.description)}</p>
        </div>
        <div class="panel" id="mint-panel">
          <div class="panel-head"><h3 id="mint-h">${panelTitle(s)}</h3><span id="mint-status-pill">${panelPill(k, s)}</span></div>
          <div class="panel-body" id="mint-body">${mintBodyHtml(k, m)}</div>
        </div>
        <dl class="kv">
          <div class="kv-row"><dt>Token id</dt><dd class="num">${m.id}${n ? ` of ${int(n)}` : ""}</dd></div>
          ${isCit(k) && t ? `<div class="kv-row"><dt>Tier</dt><dd>${esc(t)}</dd></div>` : ""}
          ${m.attributes.filter((a) => !(isCit(k) && a.trait_type === "Tier" && t)).map((a) => `<div class="kv-row"><dt>${esc(a.trait_type)}</dt><dd>${esc(String(a.value))}</dd></div>`).join("")}
          <div class="kv-row"><dt>Contract</dt><dd>${k.live ? `${addrHtml(k.address, { n: 8, label: "Collection" })} <span class="small faint">FRC-721 · ${esc(k.symbol)}</span>` : `<span class="faint">Not deployed yet · FRC-721 · ${esc(k.symbol)}</span>`}</dd></div>
          <div class="kv-row"><dt>${isCit(k) ? "Metadata" : "tokenURI"}</dt><dd><a class="mono" href="${metaUrlOf(k, m.id)}" rel="noopener" style="overflow-wrap:anywhere;text-decoration:underline">${urlBreaks(metaUrlOf(k, m.id))}</a></dd></div>
          <div class="kv-row"><dt>Image</dt><dd><a class="mono" href="${safeHref(imageUrlOf(k, m))}" rel="noopener" style="overflow-wrap:anywhere;text-decoration:underline">${urlBreaks(imageUrlOf(k, m))}</a></dd></div>
          ${k.live ? `<div class="kv-row"><dt>Explorer</dt><dd><a href="${tokenUrl(k, m.id)}" rel="noopener" style="text-decoration:underline">token #${m.id}</a></dd></div>` : ""}
        </dl>
      </div>
    </div>`;
}
const panelTitle = (s: NftStatus | undefined) => (s?.minted ? "Owner" : "Mint this token");
function panelPill(k: Coll, s: NftStatus | undefined): string {
  if (isCit(k) && !k.live) return `<span class="pill">Opens soon</span>`;
  if (!s) return skel("70px");
  if (s.minted) return ownerLink(k, s, "pill");
  return k.paused ? `<span class="pill warn">Minting paused</span>` : `<span class="pill ok">Available</span>`;
}
const mintLabel = (k: Coll, m: NftMeta) => (walletState().address ? `Mint #${m.id} · ${fmxText(priceOf(k, m))}` : "Connect wallet to mint");
function mintBodyHtml(k: Coll, m: NftMeta): string {
  if (isCit(k) && !k.live) {
    const t = tierOfM(k, m); const launch = citizensMeta.tiers.find((x) => x.name === t)?.price;
    return `<p class="small muted">Minting opens soon. The ${esc(k.name)} contract is not deployed yet${t && launch !== undefined ? `; ${esc(t)} tokens launch at ${int(launch)} FMX` : ""}.</p>`;
  }
  const s = k.status.get(m.id);
  if (!s) return `<p class="muted small">Reading the chain…</p>`;
  if (s.minted) {
    const o = ownerOfS(s);
    const note = o?.kind === "treasury" ? "Held by the Ferminux treasury — not for sale through the contract."
      : o?.kind === "you" ? "This token is in your connected wallet."
      : "Already minted. Each id exists exactly once; the contract cannot mint it again.";
    const agent = o?.agentId ? ` <a class="small faint" href="/agents/?id=${o.agentId}" style="text-decoration:underline">agent #${o.agentId}</a>` : "";
    return `<p class="small muted">${note}</p>
      <div class="price-line nft-owner-line"><span>Owner</span><span class="v">${s.owner ? `${ownerLink(k, s, "nft-owner-name")}${agent} ${addrHtml(s.owner, { n: 4, label: "Owner" })}` : "—"}</span></div>`;
  }
  if (!isCit(k) && !nftDeployed) return `<p class="small muted">The collection address is not configured on this build.</p>`;
  if (k.paused) return `<div class="alert warn">Minting is paused by the contract right now. Check back later.</div>`;
  // No extension or wallet app needed: the button opens the connect dialog, which offers Ferminux Wallet first.
  const hint = !walletState().address && !hasInjected() && !MOCK
    ? `<p class="small faint nft-hint">No wallet app needed: Ferminux Wallet opens right in this browser.</p>` : "";
  const t = tierOfM(k, m);
  return `<div class="price-line"><span>Price${t ? ` · ${esc(t)}` : ""}</span><strong class="num">${esc(fmxText(priceOf(k, m)))}</strong></div>
    <p class="small muted">Sent as <code>mint(${m.id})</code> with exactly the price attached, on chain 3961. Gas is a fraction of a cent.</p>
    <button class="btn btn-primary" type="button" id="mint-btn">${esc(mintLabel(k, m))}</button>${hint}
    <div id="mint-alert" class="alert" role="status"></div>`;
}
/** Rewrite the panel from state (not while a mint is in flight: its button and messages belong to that mint). */
function paintPanel(k: Coll, m: NftMeta, keepAlert = false) {
  if (k.minting.has(m.id) || k !== c) return;
  const body = $("#mint-body"), h = $("#mint-h"), pill = $("#mint-status-pill");
  if (!body || !h || !pill) return;
  const s = k.status.get(m.id);
  h.textContent = panelTitle(s); pill.innerHTML = panelPill(k, s);
  const alert = keepAlert ? $("#mint-alert")?.outerHTML ?? "" : "";
  const hadFocus = document.activeElement?.id === "mint-btn"; // connecting repaints the button under the keyboard
  body.innerHTML = mintBodyHtml(k, m);
  if (hadFocus) $("#mint-btn")?.focus();
  // every state keeps a message slot: a mint's result is written after the panel turns into "Owner"
  if (!$("#mint-alert")) body.insertAdjacentHTML("beforeend", `<div id="mint-alert" class="alert" role="status"></div>`);
  if (alert) $("#mint-alert")!.outerHTML = alert;
  wireMint(k, m);
}

/** What mint() checks, read fresh right before the wallet is asked: the id exists and is free, the sale is open,
 *  and the exact price (Citizens: of the token's live tier). */
async function preflight(k: Coll, id: number): Promise<{ fresh: NftStatus; paused: boolean; price: bigint; exists: boolean }> {
  if (isCit(k)) {
    const cs = await citizensState();
    k.paused = cs.paused; k.prices = cs.prices; k.totalIds = cs.totalIds; k.totalSupply = cs.totalSupply;
    if (id > cs.totalIds) return { fresh: { id, minted: false, owner: null }, paused: cs.paused, price: 0n, exists: false };
    const fresh = await citizenStatus(id);
    return { fresh, paused: cs.paused, price: cs.prices[fresh.tier ?? 0], exists: true };
  }
  const [fresh, cs] = await Promise.all([readStatus(id), collectionState()]);
  k.price = cs.price; k.paused = cs.paused;
  return { fresh, paused: cs.paused, price: cs.price, exists: true };
}
function wireMint(k: Coll, m: NftMeta) {
  const btn = $("#mint-btn") as HTMLButtonElement | null; if (!btn) return;
  const say = (html: string, tone: "" | "ok" | "warn" | "info") => { const a = $("#mint-alert"); if (a) { a.className = `alert ${tone}`; a.innerHTML = html; } };
  const relabel = () => { delete btn.dataset.label; btn.disabled = false; btn.textContent = mintLabel(k, m); };
  btn.addEventListener("click", async () => {
    if (k.minting.has(m.id)) return;
    if (!walletState().address) {
      setBusy(btn, true, "Connecting…");
      try { await connect(); } catch (e) { say(esc(errMessage(e)), "warn"); relabel(); return; }
      relabel(); return;
    }
    k.minting.add(m.id);
    setBusy(btn, true, "Checking…"); say("", "");
    let done = false, sent = "";
    const me = walletState().address!;
    const finish = (hash: string, price: bigint) => {
      if (done) return; done = true;
      if (MOCK) { if (isCit(k)) mockCitizenMinted(m.id, me); else mockMarkMinted(m.id, me); }
      k.status.set(m.id, { ...(k.status.get(m.id) ?? { id: m.id }), id: m.id, minted: true, owner: me });
      if (k.totalSupply !== null) k.totalSupply++;
      k.minting.delete(m.id);
      paintPanel(k, m);
      say(`Minted <strong>${esc(m.name)}</strong> to your wallet for ${esc(fmxUnit(price, 2))} — <a href="${explorerTx(hash)}" rel="noopener" style="text-decoration:underline">view the transaction</a>.`, "ok");
      toast(`Minted #${m.id}`);
    };
    let checked: bigint | null = null;
    try {
      // Re-read everything mint() checks right before asking the wallet: the id is free, the sale is open,
      // the value is exactly the price — and that the wallet can pay it, so nobody signs a sure revert.
      const [pf, bal] = await Promise.all([preflight(k, m.id), getBalance(me).catch(() => null)]);
      if (!pf.exists) { k.minting.delete(m.id); relabel(); say(`#${m.id} is not on chain yet. Its batch is being added; try again in a minute.`, "warn"); return; }
      k.status.set(m.id, pf.fresh);
      if (pf.fresh.minted) { k.minting.delete(m.id); paintPanel(k, m); say(lc(pf.fresh.owner) === lc(me) ? `#${m.id} is already in your wallet.` : `#${m.id} was just minted by someone else.`, "warn"); return; }
      if (pf.paused) { k.minting.delete(m.id); paintPanel(k, m); say("Minting is paused by the contract.", "warn"); return; }
      const price = pf.price; checked = price;
      if (price === 0n && isCit(k)) { k.minting.delete(m.id); paintPanel(k, m); say("This tier is not for sale through the contract right now.", "warn"); return; }
      if (bal !== null && bal < price) {
        k.minting.delete(m.id); relabel();
        say(`This wallet holds ${esc(fmxUnit(bal, 2))}; minting needs ${esc(fmxUnit(price, 2))} plus a little gas. <a href="/buy-fmx/" style="text-decoration:underline">Get FMX</a>`, "warn");
        return;
      }
      // Only the collection: sendTx would also build registry and escrow signers (three network checks).
      const nft: Contract = isCit(k) ? (MOCK && !hasInjected() ? citizensRead() : await citizensWrite()) : (MOCK && !hasInjected() ? nftRead() : await nftWrite());
      setBusy(btn, true, "Confirm in your wallet…");
      const r = await sendCall(nft, "mint", [m.id], { value: price }, (ph, hash) => {
        if (ph === "signing") setBusy(btn, true, "Confirm in your wallet…");
        if (ph === "pending") { sent = hash ?? ""; setBusy(btn, true, "Minting…"); say(`Transaction sent, waiting for a block (about 7 s). ${txHtml(hash)}`, "info"); }
        // Show the result on the receipt; sendCall then waits for the gateway indexer, which minting doesn't need.
        if (ph === "confirmed" && hash) finish(hash, price);
      });
      finish(r.hash, price);
    } catch (e) {
      if (done) return;
      const msg = errMessage(e);
      // Another wallet may have taken the id, or the owner changed the price or paused the sale, since we checked.
      const pf = await preflight(k, m.id).catch(() => null);
      k.minting.delete(m.id);
      const fresh = pf?.fresh;
      // The mint went through but waiting for its receipt failed (RPC hiccup): the token is ours, say so.
      if (fresh?.minted && lc(fresh.owner) === lc(me)) { k.status.set(m.id, fresh); paintPanel(k, m); say(`<strong>${esc(m.name)}</strong> is in your wallet. ${sent ? txHtml(sent) : ""}`, "ok"); return; }
      if (fresh?.minted && lc(fresh.owner) !== lc(me)) { k.status.set(m.id, fresh); paintPanel(k, m); say(`#${m.id} was minted by another wallet first. Nothing was charged except any gas already spent.`, "warn"); return; }
      if (pf && fresh) k.status.set(m.id, fresh);
      if (pf && checked !== null && pf.price !== checked) { relabel(); say(`The mint price changed to ${esc(fmxUnit(pf.price, 2))}. Press Mint again to pay the new price.`, "warn"); return; }
      if (pf?.paused) { paintPanel(k, m); say("Minting was paused by the contract.", "warn"); return; }
      relabel(); say(esc(msg), "warn");
    }
  });
}
async function renderDetail(id: number) {
  const k = c;
  const m = k.metas.find((x) => x.id === id && (!isCit(k) || !k.live || k.totalIds === null || x.id <= k.totalIds));
  if (!m) {
    document.title = listTitle(k);
    const range = isCit(k) ? (total(k) ? `ids run 1–${total(k)}` : "") : `ids run 1–${config.nftSupply}`;
    // Citizens: an id past the cached collection.json may belong to a batch appended on chain; wait for totalIds()
    // (and that batch's own meta files) before saying the token does not exist.
    const waiting = isCit(k) && k.live && !k.statusErr && !k.loadErr && id >= 1 && (k.totalIds === null || id <= k.totalIds);
    view.innerHTML = `${tabsHtml()}<p class="crumbs" style="margin-top:20px"><a href="${k.path}" data-detail="">${backLabel(k)}</a></p>${(k.metas.length || k.loadErr) && !waiting ? `<div class="alert warn" style="margin-bottom:56px">There is no token #${int(id)} in this collection${range ? ` (${range})` : ""}.</div>` : `<p class="muted" style="margin-bottom:56px">${skel("40%")}</p>`}`;
    return;
  }
  document.title = `${m.name} — ${k.name} NFTs`;
  view.innerHTML = tabsHtml() + detailHtml(k, m); bindArt(view); wireMint(k, m);
  if (!k.status.has(id) && k.live && !(isCit(k) && k.totalIds === null && !MOCK)) {
    let s: NftStatus;
    try { s = isCit(k) ? await citizenStatus(id) : await readStatus(id); } catch (e) { const b = $("#mint-body"); if (b && currentId() === id && c === k) b.innerHTML = `<div class="alert warn">Could not read the chain: ${esc((e as Error).message)}</div>`; return; }
    if (!k.status.has(id)) k.status.set(id, s);
    if (currentId() === id && c === k) paintPanel(k, m);
  }
}

// ---------- routing ----------
const listTitle = (k: Coll) => (isCit(k) ? `${k.name} — one-of-one NFTs on chain 3961` : "Ferminux Agents NFTs — 41 one-of-ones on chain 3961");
const currentId = () => { const v = new URLSearchParams(location.search).get("id"); return v && /^\d+$/.test(v) ? Number(v) : null; };
function readFilter(k: Coll) {
  if (isCit(k)) k.filter = parseCitizensFilter(location.search, SERIES);
  else { const f = new URLSearchParams(location.search).get("filter"); k.filter = { avail: f === "available" || f === "minted" ? f : "all", tier: "all", series: "all" }; }
}
function route() {
  c = colls[keyOf()];
  view.setAttribute("aria-busy", "true");
  const id = currentId();
  if (id !== null) renderDetail(id); else { readFilter(c); document.title = listTitle(c); renderList(); }
  view.setAttribute("aria-busy", "false");
  load(c);
}
/** New chain facts or owner names: update what is on screen without rebuilding it (the artwork, a focused
 *  control and a mint in flight all survive). */
function refresh(k: Coll) {
  if (k !== c) return;
  const id = currentId();
  if (id === null) { if (!$("#nft-grid .nft-card[data-id]")) { renderList(); return; } refreshStats(); paintAlert(); updateCards(); return; }
  // visible(): a token listed in a newer collection.json but not appended on chain yet has no detail to update
  const m = visible(k).find((x) => x.id === id);
  if (m && $("#mint-panel")) paintPanel(k, m, true);
  else renderDetail(id);
}
document.addEventListener("click", (e) => {
  const me = e as MouseEvent;
  if (me.metaKey || me.ctrlKey || me.shiftKey || me.button !== 0) return;
  const tab = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-coll]");
  if (tab) {
    e.preventDefault();
    const k = colls[tab.dataset.coll as Key];
    if (k === c && currentId() === null) return;
    history.pushState(null, "", `${k.path}${listQuery(k)}`); route(); window.scrollTo({ top: 0 });
    requestAnimationFrame(() => $<HTMLAnchorElement>(`a[data-coll="${k.key}"]`)?.focus({ preventScroll: true }));
    return;
  }
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-detail]"); if (!a) return;
  e.preventDefault();
  const to = a.dataset.detail ? `${c.path}?id=${a.dataset.detail}` : `${c.path}${listQuery(c)}`;
  history.pushState(null, "", to); route(); window.scrollTo({ top: 0 });
  // keyboard users land on the new view's heading, not at the top of the document
  requestAnimationFrame(() => { const h = $("h1", view); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } });
});
window.addEventListener("popstate", route);
onWallet(() => refresh(c));

// ---------- data ----------
/** Loads a collection once: metadata first (the gallery paints), then the chain. */
function load(k: Coll) {
  if (k.started) return;
  k.started = true;
  (isCit(k) ? loadCitizensData(k) : loadAgentsData(k)).catch((e) => { k.loadErr = (e as Error).message; refresh(k); paintAlert(); });
  if (!book) ownerBook().then((b) => { book = b; refresh(c); });
}
async function loadAgentsData(k: Coll) {
  k.metas = await loadCollection();
  refresh(k);
  const [cs, st] = await Promise.allSettled([collectionState(), statuses(allIds())]);
  if (cs.status === "fulfilled") { k.price = cs.value.price; k.paused = cs.value.paused; k.totalSupply = cs.value.totalSupply; }
  else if (nftDeployed) k.statusErr = `Could not read the contract: ${(cs.reason as Error).message}`;
  // a status read while this ran (the detail view, or a mint) is newer than the batch: keep it
  if (st.status === "fulfilled") for (const s of st.value) { if (!k.minting.has(s.id) && !(k.status.get(s.id)?.minted && !s.minted)) k.status.set(s.id, s); }
  else if (nftDeployed) k.statusErr = `Could not read mint statuses: ${(st.reason as Error).message}`;
  refresh(k);
}
async function loadCitizensData(k: Coll) {
  k.metas = await loadCitizens();
  refresh(k);
  if (!k.live) return;
  let cs;
  try { cs = await citizensState(); } catch (e) { k.statusErr = `Could not read the contract: ${(e as Error).message}`; refresh(k); return; }
  k.paused = cs.paused; k.totalSupply = cs.totalSupply; k.totalIds = cs.totalIds; k.prices = cs.prices;
  // a batch appended on chain after this browser cached collection.json: fetch those ids' own metadata files
  const last = k.metas.length ? k.metas[k.metas.length - 1].id : 0;
  if (cs.totalIds > last) {
    const extra = await loadExtraMetas(last + 1, cs.totalIds);
    const have = new Set(extra.map((m) => m.id));
    for (let id = last + 1; id <= cs.totalIds; id++) if (!have.has(id)) extra.push({ id, name: `Citizen #${id}`, description: "Metadata for this token is on its way.", image: citizensImageUrl(id), attributes: [] });
    k.metas = [...k.metas, ...extra.sort((a, b) => a.id - b.id)];
  }
  refresh(k);
  try {
    const st = await citizensStatuses(1, cs.totalIds);
    for (const s of st) { if (!k.minting.has(s.id) && !(k.status.get(s.id)?.minted && !s.minted)) k.status.set(s.id, s); }
  } catch (e) { k.statusErr = `Could not read mint statuses: ${(e as Error).message}`; }
  refresh(k);
}

// ---------- boot ----------
route();
