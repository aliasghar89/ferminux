import { config, explorerAddr, explorerTx, nftDeployed } from "../config";
import { esc, fmx, fmxUnit, int, safeHref, short } from "../format";
import { $, addrHtml, initChrome, setBusy, skel, toast, txHtml } from "../ui";
import { connect, errMessage, onWallet, sendTx, walletState } from "../wallet";
import { allIds, archetype, category, collectionState, imageUrl, isLegendary, isTreasury, loadCollection, metaUrl, mockMarkMinted, status as readStatus, statuses, type NftMeta, type NftStatus } from "../nft";

initChrome();
const view = $("#view")!;
const MOCK = config.mock;
const tokenUrl = (id: number) => `${config.explorer}/token/${config.nft}/instance/${id}`;

type Filter = "all" | "available" | "minted";
const state = { metas: [] as NftMeta[], status: new Map<number, NftStatus>(), price: null as bigint | null, paused: false, totalSupply: null as number | null, filter: "all" as Filter, statusErr: "" };

// ---------- shared bits ----------
const priceText = () => state.price === null ? "…" : `${fmx(state.price, 2)} FMX`;
function statusHtml(s: NftStatus | undefined, m: NftMeta, size: "xs" | "md" = "xs"): string {
  if (!s) return `<span class="pill">${skel("48px")}</span>`;
  if (!s.minted) return state.paused
    ? `<span class="pill">Minting paused</span>`
    : `<a class="btn btn-primary ${size === "xs" ? "btn-xs" : "btn-sm"}" href="/nfts/?id=${m.id}" data-detail="${m.id}">Mint · ${esc(priceText())}</a>`;
  if (isTreasury(s)) return `<span class="pill accent" title="${esc(s.owner || "")}">Treasury</span>`;
  const me = walletState().address; const mine = !!me && !!s.owner && me.toLowerCase() === s.owner.toLowerCase();
  return `<a class="pill ${mine ? "ok" : ""}" href="${s.owner ? explorerAddr(s.owner) : tokenUrl(m.id)}" rel="noopener" title="${esc(s.owner || "")}">${mine ? "Yours" : `Owned by ${esc(short(s.owner, 2))}`}</a>`;
}
function cardHtml(m: NftMeta): string {
  const s = state.status.get(m.id); const leg = isLegendary(m);
  return `<article class="nft-card${leg ? " legendary" : ""}${s?.minted ? " is-minted" : ""}" id="nft-${m.id}" data-id="${m.id}">
    <a class="nft-img" href="/nfts/?id=${m.id}" data-detail="${m.id}" aria-label="${esc(m.name)}"><img src="${esc(m.image || imageUrl(m.id))}" alt="" width="512" height="512" loading="lazy" decoding="async"></a>
    <div class="nft-body">
      <a class="nft-name" href="/nfts/?id=${m.id}" data-detail="${m.id}"><span>${esc(archetype(m))}</span><span class="faint num">#${m.id}</span></a>
      <span class="nft-cat">${esc(category(m))}</span>
      <div class="nft-status">${statusHtml(s, m)}</div>
    </div>
  </article>`;
}

// ---------- list view ----------
function renderList() {
  const minted = [...state.status.values()].filter((s) => s.minted).length;
  const total = state.metas.length || config.nftSupply;
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><p class="kicker" style="margin-bottom:8px">Ferminux Agents · FRC-721 · FMXA</p><h1>Ferminux Agents — 41 one-of-ones</h1><p>Forty agent archetypes and one legendary operator, each a single token on chain 3961. Mint straight from the contract; every id can exist exactly once.</p></div>
      <div class="hero-actions" style="margin-top:0"><a class="btn btn-secondary" href="${explorerAddr(config.nft)}" rel="noopener">Contract on the explorer</a></div></div>
    </section>
    <div class="statgrid nft-stats" aria-label="Collection facts">
      <div><span class="l">Mint price</span><span class="v num" id="nft-price">${state.price === null ? skel("60%") : esc(priceText())}</span></div>
      <div><span class="l">Minted</span><span class="v num" id="nft-minted">${state.status.size ? `${int(minted)} / ${int(total)}` : skel("50%")}</span></div>
      <div><span class="l">Status</span><span class="v" id="nft-paused">${state.price === null ? skel("50%") : state.paused ? `<span class="pill warn">Paused</span>` : `<span class="pill ok">Minting open</span>`}</span></div>
      <div><span class="l">Contract</span><span class="v" style="font-size:14px">${addrHtml(config.nft, { n: 6, label: "Collection" })}</span></div>
    </div>
    <div class="seg-row" style="margin-top:18px">
      <div class="seg" role="group" aria-label="Filter">
        <button type="button" data-f="all" aria-pressed="${state.filter === "all"}">All</button>
        <button type="button" data-f="available" aria-pressed="${state.filter === "available"}">Available</button>
        <button type="button" data-f="minted" aria-pressed="${state.filter === "minted"}">Minted</button>
      </div>
      <span class="result-count" id="nft-count" style="margin:0"></span>
    </div>
    <div id="nft-alert" class="alert warn" style="margin-bottom:14px"></div>
    <div class="nft-grid" id="nft-grid" aria-busy="true"></div>
    <p class="small faint" style="margin:18px 0 56px">Metadata: <a class="mono" href="${config.nftBase}/collection.json" rel="noopener" style="text-decoration:underline">collection.json</a> · per token <span class="mono">${esc(config.nftBase)}/meta/&lt;id&gt;.json</span> · images 512 px PNG. <code>mint(tokenId)</code> must be sent with exactly <code>price()</code> in FMX; #41 was minted to the treasury at deploy.</p>`;
  view.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => b.addEventListener("click", () => { state.filter = b.dataset.f as Filter; view.querySelectorAll<HTMLButtonElement>(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); paintGrid(); }));
  $("#nft-alert")!.textContent = state.statusErr;
  if (!nftDeployed) $("#nft-alert")!.textContent = "The Ferminux Agents contract address is not configured on this build; showing metadata only.";
  paintGrid();
}
function paintGrid() {
  const grid = $("#nft-grid"); if (!grid) return;
  if (!state.metas.length) { grid.innerHTML = Array.from({ length: 12 }, () => `<div class="nft-card" aria-hidden="true"><div class="nft-img"><span class="sk" style="width:100%;height:100%;border-radius:0"></span></div><div class="nft-body">${skel("60%")}<span class="nft-cat">${skel("80%")}</span></div></div>`).join(""); return; }
  const items = state.metas.filter((m) => { const s = state.status.get(m.id); return state.filter === "all" || (state.filter === "minted" ? !!s?.minted : s ? !s.minted : true); });
  grid.innerHTML = items.length ? items.map(cardHtml).join("") : `<div class="empty" style="grid-column:1/-1"><h3>Nothing here</h3>${state.filter === "available" ? "Every agent has been minted." : "No token has been minted yet."}</div>`;
  grid.setAttribute("aria-busy", "false");
  const c = $("#nft-count"); if (c) c.textContent = state.filter === "all" ? `${int(items.length)} tokens` : `${int(items.length)} ${state.filter}`;
}
function refreshStats() {
  const minted = [...state.status.values()].filter((s) => s.minted).length;
  const el = $("#nft-minted"); if (el) el.textContent = `${int(minted)} / ${int(state.metas.length || config.nftSupply)}`;
  const p = $("#nft-price"); if (p && state.price !== null) p.textContent = priceText();
  const pa = $("#nft-paused"); if (pa && state.price !== null) pa.innerHTML = state.paused ? `<span class="pill warn">Paused</span>` : `<span class="pill ok">Minting open</span>`;
}

// ---------- detail view ----------
function detailHtml(m: NftMeta): string {
  const s = state.status.get(m.id); const leg = isLegendary(m);
  return `
    <p class="crumbs" style="margin-top:20px"><a href="/nfts/" data-detail="">← All 41 agents</a></p>
    <div class="nft-detail">
      <div class="nft-hero${leg ? " legendary" : ""}"><img src="${esc(m.image || imageUrl(m.id))}" alt="${esc(m.name)}" width="512" height="512" decoding="async"></div>
      <div class="detail-main">
        <div>
          <div class="dhead"><h1>${esc(m.name)}</h1><div class="pills"><span class="pill ${leg ? "accent" : ""}">${esc(category(m))}</span><span class="pill">${esc(attrOf(m, "Edition"))}</span></div></div>
          <p class="muted" style="margin-top:12px;font-size:15.5px">${esc(m.description)}</p>
        </div>
        <div class="panel" id="mint-panel">
          <div class="panel-head"><h3>${s?.minted ? "Owner" : "Mint this token"}</h3><span id="mint-status-pill">${s ? (s.minted ? statusHtml(s, m, "md") : `<span class="pill ok">Available</span>`) : skel("70px")}</span></div>
          <div class="panel-body" id="mint-body">${mintBodyHtml(m)}</div>
        </div>
        <dl class="kv">
          <div class="kv-row"><dt>Token id</dt><dd class="num">${m.id} of ${config.nftSupply}</dd></div>
          ${m.attributes.map((a) => `<div class="kv-row"><dt>${esc(a.trait_type)}</dt><dd>${esc(String(a.value))}</dd></div>`).join("")}
          <div class="kv-row"><dt>Contract</dt><dd>${addrHtml(config.nft, { n: 8, label: "Collection" })} <span class="small faint">FRC-721 · FMXA</span></dd></div>
          <div class="kv-row"><dt>tokenURI</dt><dd><a class="mono" href="${metaUrl(m.id)}" rel="noopener" style="overflow-wrap:anywhere;text-decoration:underline">${esc(metaUrl(m.id))}</a></dd></div>
          <div class="kv-row"><dt>Image</dt><dd><a class="mono" href="${safeHref(m.image || imageUrl(m.id))}" rel="noopener" style="overflow-wrap:anywhere;text-decoration:underline">${esc(m.image || imageUrl(m.id))}</a></dd></div>
          <div class="kv-row"><dt>Explorer</dt><dd><a href="${tokenUrl(m.id)}" rel="noopener" style="text-decoration:underline">token #${m.id}</a></dd></div>
        </dl>
      </div>
    </div>`;
}
const attrOf = (m: NftMeta, t: string) => String(m.attributes.find((a) => a.trait_type === t)?.value ?? "—");
function mintBodyHtml(m: NftMeta): string {
  const s = state.status.get(m.id);
  if (!s) return `<p class="muted small">Reading the chain…</p>`;
  if (s.minted) {
    const me = walletState().address; const mine = !!me && !!s.owner && me.toLowerCase() === s.owner.toLowerCase();
    return `<p class="small muted">${isTreasury(s) ? "Held by the Ferminux treasury — not for sale through the contract." : mine ? "This token is in your connected wallet." : "Already minted. Each id exists exactly once; the contract cannot mint it again."}</p>
      <div class="price-line"><span>Owner</span><strong style="font-size:14px">${s.owner ? addrHtml(s.owner, { n: 6, label: "Owner" }) : "—"}</strong></div>`;
  }
  if (!nftDeployed) return `<p class="small muted">The collection address is not configured on this build.</p>`;
  if (state.paused) return `<div class="alert warn">Minting is paused by the contract right now. Check back later.</div>`;
  const w = walletState();
  return `<div class="price-line"><span>Price</span><strong class="num">${esc(priceText())}</strong></div>
    <p class="small muted">Sent as <code>mint(${m.id})</code> with exactly the price attached, on chain 3961. Gas is a fraction of a cent.</p>
    <button class="btn btn-primary" type="button" id="mint-btn">${w.address ? `Mint #${m.id} · ${esc(priceText())}` : "Connect wallet to mint"}</button>
    <div id="mint-alert" class="alert"></div>
    <div class="txlog" id="mint-log"></div>`;
}
function wireMint(m: NftMeta) {
  const btn = $("#mint-btn") as HTMLButtonElement | null; if (!btn) return;
  const say = (html: string, tone: "" | "ok" | "warn" | "info") => { const a = $("#mint-alert")!; a.className = `alert ${tone}`; a.innerHTML = html; };
  btn.addEventListener("click", async () => {
    if (!walletState().address) {
      setBusy(btn, true, "Connecting…");
      try { await connect(); } catch (e) { say(esc(errMessage(e)), "warn"); setBusy(btn, false); return; }
      setBusy(btn, false); btn.textContent = `Mint #${m.id} · ${priceText()}`; return;
    }
    setBusy(btn, true, "Checking…"); say("", "");
    try {
      // Re-read price and availability right before sending: mint() reverts unless value == price() and the id is free.
      const [fresh, cs] = await Promise.all([readStatus(m.id), collectionState()]);
      state.status.set(m.id, fresh); state.price = cs.price; state.paused = cs.paused;
      if (fresh.minted) { say(`#${m.id} was just minted by someone else.`, "warn"); $("#mint-body")!.innerHTML = mintBodyHtml(m); return; }
      if (cs.paused) { say("Minting is paused by the contract.", "warn"); return; }
      const price = cs.price;
      const r = await sendTx((c) => c.nft.mint(m.id, { value: price }), (ph, hash) => {
        if (ph === "signing") setBusy(btn, true, "Confirm in wallet…");
        if (ph === "pending") { setBusy(btn, true, "Minting…"); say(`Transaction sent, waiting for a block. ${txHtml(hash)}`, "info"); }
      });
      const me = walletState().address!;
      if (MOCK) mockMarkMinted(m.id, me);
      state.status.set(m.id, { id: m.id, minted: true, owner: me });
      say(`Minted <strong>${esc(m.name)}</strong> to ${esc(short(me))} for ${esc(fmxUnit(price, 2))} — <a href="${explorerTx(r.hash)}" rel="noopener" style="text-decoration:underline">view the transaction</a>.`, "ok");
      toast(`Minted #${m.id}`);
      $("#mint-status-pill")!.innerHTML = statusHtml(state.status.get(m.id), m, "md");
      $("#mint-panel .panel-head h3")!.textContent = "Owner";
      const body = $("#mint-body")!; const keep = $("#mint-alert")!.outerHTML;
      body.innerHTML = mintBodyHtml(m) + keep;
    } catch (e) { say(esc(errMessage(e)), "warn"); setBusy(btn, false); }
  });
}
async function renderDetail(id: number) {
  const m = state.metas.find((x) => x.id === id);
  if (!m) { view.innerHTML = `<p class="crumbs" style="margin-top:20px"><a href="/nfts/" data-detail="">← All 41 agents</a></p><div class="alert warn" style="margin-bottom:56px">${state.metas.length ? `There is no token #${int(id)} in this collection (ids run 1–${config.nftSupply}).` : `The collection metadata could not be loaded, so token #${int(id)} cannot be shown right now. Reload to try again.`}</div>`; return; }
  document.title = `${m.name} — Ferminux Agents NFTs`;
  view.innerHTML = detailHtml(m); wireMint(m);
  if (!state.status.has(id) && nftDeployed) {
    try { state.status.set(id, await readStatus(id)); } catch (e) { $("#mint-body")!.innerHTML = `<div class="alert warn">Could not read the chain: ${esc((e as Error).message)}</div>`; return; }
    if (currentId() !== id) return;
    $("#mint-status-pill")!.innerHTML = state.status.get(id)!.minted ? statusHtml(state.status.get(id), m, "md") : `<span class="pill ok">Available</span>`;
    $("#mint-panel .panel-head h3")!.textContent = state.status.get(id)!.minted ? "Owner" : "Mint this token";
    $("#mint-body")!.innerHTML = mintBodyHtml(m); wireMint(m);
  }
}

// ---------- routing ----------
const currentId = () => { const v = new URLSearchParams(location.search).get("id"); return v && /^\d+$/.test(v) ? Number(v) : null; };
function route() {
  view.setAttribute("aria-busy", "true");
  const id = currentId();
  if (id !== null) renderDetail(id); else { document.title = "Ferminux Agents NFTs — 41 one-of-ones on chain 3961"; renderList(); }
  view.setAttribute("aria-busy", "false");
}
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-detail]"); if (!a || e.metaKey || e.ctrlKey || e.button !== 0) return;
  e.preventDefault(); history.pushState(null, "", a.dataset.detail ? `/nfts/?id=${a.dataset.detail}` : "/nfts/"); route(); window.scrollTo({ top: 0 });
});
window.addEventListener("popstate", route);
onWallet(() => { if (state.metas.length) { if (currentId() === null) paintGrid(); else { const m = state.metas.find((x) => x.id === currentId()); if (m && state.status.get(m.id)?.minted) $("#mint-status-pill")!.innerHTML = statusHtml(state.status.get(m.id), m, "md"); else if (m && $("#mint-btn") && walletState().address) $("#mint-btn")!.textContent = `Mint #${m.id} · ${priceText()}`; } } });

// ---------- boot ----------
(async () => {
  route();
  try { state.metas = await loadCollection(); }
  catch (e) { view.insertAdjacentHTML("beforeend", `<div class="alert warn" style="margin-bottom:56px">Could not load the collection metadata: ${esc((e as Error).message)}</div>`); return; }
  route();
  const [cs, st] = await Promise.allSettled([collectionState(), statuses(allIds())]);
  if (cs.status === "fulfilled") { state.price = cs.value.price; state.paused = cs.value.paused; state.totalSupply = cs.value.totalSupply; }
  else if (nftDeployed) state.statusErr = `Could not read the contract: ${(cs.reason as Error).message}`;
  if (st.status === "fulfilled") for (const s of st.value) state.status.set(s.id, s);
  else if (nftDeployed) state.statusErr = `Could not read mint statuses: ${(st.reason as Error).message}`;
  route();
})();
