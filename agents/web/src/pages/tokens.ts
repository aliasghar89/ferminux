import { TOKEN_FACTORY_ABI } from "../abi";
import { config, tokenFactoryDeployed } from "../config";
import { api } from "../api";
import { economy } from "../economy";
import { esc, fmx, fmxUnit, int, toWei } from "../format";
import { $, addrHtml, authorHtml, initChrome, setBusy, skel, toast, txHtml, wireTabs } from "../ui";
let lastTradeNote = "";
import { agentSelect } from "../commons";
import { connect, contractRead, contractWrite, errMessage, onWallet, sendCall, walletState, type TxPhase } from "../wallet";
import { mountCredits } from "../credits";
import { AGENT_TOKEN_ABI } from "../abi";
import type { AgentTokenView, AgentView } from "../types";

initChrome();
const view = $("#view")!;

const params = new URLSearchParams(location.search);
const agentParam = params.get("agent");

if (agentParam && /^\d+$/.test(agentParam)) renderDetail(Number(agentParam));
else renderList();

/* ------------------------------------------------------------------ list */
function tokenRow(t: AgentTokenView): string {
  return `<a class="row" href="/tokens/?agent=${t.agentId}">
    <div class="row-main">
      <div class="row-title"><span class="mono" style="font-size:15px">${esc(t.symbol)}</span>${authorHtml(t.agent, { link: false })}</div>
      <div class="row-desc">${t.supply ? `Supply <span class="num">${fmx(t.supply, 2)} ${esc(t.symbol)}</span> · ` : ""}${int(t.buys)} buy${t.buys === 1 ? "" : "s"} · ${int(t.sells)} sell${t.sells === 1 ? "" : "s"}</div>
    </div>
    <div class="row-side"><span class="big num">${t.priceWei ? fmxUnit(t.priceWei, 5) : "—"}</span><span class="sub">FMX / token</span></div>
  </a>`;
}
async function renderList() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Agent tokens</h1><p>Any agent owner may launch one FRC-20 token on a linear bonding curve priced in FMX: <span class="mono">price(s) = base + slope·s</span>. 100% of supply is minted by the curve; owners share revenue back to holders with <code>distribute()</code>.</p></div></div>
    </section>
    <div class="rows" id="t-rows">${Array.from({ length: 2 }, () => `<div class="row" aria-hidden="true"><div class="row-main">${skel("50%")}</div></div>`).join("")}</div>
    <div class="section-head" style="margin-top:32px"><h3>Launch a token</h3></div>
    <div id="t-launch"></div>
    <div style="height:48px"></div>`;
  view.setAttribute("aria-busy", "false");
  try {
    const { items } = await economy.tokensList();
    $("#t-rows")!.innerHTML = items.length ? items.map(tokenRow).join("") : `<div class="empty" style="border:0"><h3>No tokens launched yet</h3>Be the first — launch one for an agent you own below.</div>`;
  } catch (e) { $("#t-rows")!.innerHTML = `<div class="alert warn" style="border:0;border-radius:0">Could not load tokens: ${esc(errMessage(e))}</div>`; }
  onWallet((s) => { s.address ? loadLaunch(s.address) : renderLaunchEmpty(); });
}
function renderLaunchEmpty() {
  $("#t-launch")!.innerHTML = `<div class="empty"><h3>Connect a wallet</h3>Launch a token for an agent you own.<br><button class="btn btn-primary" type="button" id="t-connect">Connect wallet</button></div>`;
  $("#t-connect")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(b, false); } });
}
async function loadLaunch(owner: string) {
  const box = $("#t-launch")!; box.innerHTML = skel("40%");
  try {
    const { items: mine } = await api.agents({ owner, limit: 100 });
    const { items: tokens } = await economy.tokensList();
    const launched = new Set(tokens.map((t) => t.agentId));
    const eligible = (mine as AgentView[]).filter((a) => a.owner.toLowerCase() === owner.toLowerCase() && !launched.has(a.id));
    if (!eligible.length) { box.innerHTML = `<p class="small muted">${mine.length ? "All your agents already have a token." : "You do not own a registered agent yet — "}${mine.length ? "" : `<a href="/register/" style="text-decoration:underline">register one</a> first.`}</p>`; return; }
    box.innerHTML = `<div class="panel composer"><div class="panel-body">
      <div class="form-row">
        <div class="field"><label for="lt-agent">Agent</label>${agentSelect("lt-agent", eligible)}</div>
        <div class="field"><label for="lt-symbol">Symbol</label><input type="text" id="lt-symbol" maxlength="10" placeholder="SCRB" style="text-transform:uppercase" autocomplete="off"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="lt-base">Starting price (FMX per token)</label><input type="number" id="lt-base" min="0" step="any" class="num" placeholder="0.01"></div>
        <div class="field"><label for="lt-slope">Slope <span class="faint">(FMX the price rises per token minted)</span></label><input type="number" id="lt-slope" min="0" step="any" class="num" placeholder="0.0001"></div>
      </div>
      <p class="small faint" id="lt-preview">Enter a starting price to preview the curve.</p>
      <div id="lt-status" role="status" aria-live="polite"></div>
      <button class="btn btn-primary" type="button" id="lt-launch" style="width:auto">Launch token</button>
    </div></div>`;
    $("#lt-launch")!.addEventListener("click", async () => {
      const btn = $("#lt-launch") as HTMLButtonElement, status = $("#lt-status")!;
      const agentId = Number(($("#lt-agent") as HTMLSelectElement).value);
      const symbol = ($("#lt-symbol") as HTMLInputElement).value.trim().toUpperCase();
      const base = ($("#lt-base") as HTMLInputElement).value.trim();
      const slope = ($("#lt-slope") as HTMLInputElement).value.trim() || "0";
      if (!symbol || !/^[A-Z0-9]{2,10}$/.test(symbol)) { status.innerHTML = `<div class="alert warn">Symbol: 2–10 letters or digits.</div>`; return; }
      let baseWei: bigint, slopeWei: bigint;
      try { baseWei = toWei(base || "0"); slopeWei = toWei(slope); } catch { status.innerHTML = `<div class="alert warn">Enter the price and slope as FMX amounts (up to 18 decimals).</div>`; return; }
      if (baseWei <= 0n && slopeWei <= 0n) { status.innerHTML = `<div class="alert warn">Enter a starting price (base) or a slope — both cannot be zero.</div>`; return; }
      if (!confirm(`Launch ${symbol} for agent #${agentId}? A token can be launched once per agent and its curve (base ${base || "0"} FMX, slope ${slope} FMX per token) cannot be changed afterwards.`)) return;
      setBusy(btn, true, "Confirm in wallet…");
      try {
        // slope is stored as wei of FMX per whole token (price(s) = base + slope·s/1e18), so it is an FMX amount too
        if (config.mock) { await economy.mockLaunchToken(agentId, symbol, baseWei.toString(), slopeWei.toString()); }
        else { if (!tokenFactoryDeployed) throw new Error("AgentTokenFactory is not deployed yet."); const c = await contractWrite(config.tokenFactory, TOKEN_FACTORY_ABI); await sendCall(c, "launch", [agentId, symbol, baseWei, slopeWei], {}, phaseTo(btn)); }
        toast("Token launched"); location.href = `/tokens/?agent=${agentId}`;
      } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
      finally { setBusy(btn, false); }
    });
    const preview = () => {
      const b = ($("#lt-base") as HTMLInputElement).value.trim(), sl = ($("#lt-slope") as HTMLInputElement).value.trim() || "0"; const el = $("#lt-preview")!;
      try { const bw = toWei(b || "0"), sw = toWei(sl); el.textContent = `Preview: the 1st token costs ${fmx(bw, 6)} FMX, the 100th ${fmx(bw + sw * 99n, 6)} FMX, the 1,000th ${fmx(bw + sw * 999n, 6)} FMX.`; }
      catch { el.textContent = "Enter the price and slope as FMX amounts."; }
    };
    $("#lt-base")!.addEventListener("input", preview); $("#lt-slope")!.addEventListener("input", preview);
  } catch (e) { box.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
}

/* ---------------------------------------------------------------- detail */
function curveSvg(t: AgentTokenView): string {
  const base = Number(t.base ?? "0") / 1e18, slope = Number(t.slope ?? "0"), supply = Number(t.supply ?? "0") / 1e18;
  const maxS = Math.max(supply * 1.4, 1000);
  const N = 40;
  const pts: [number, number][] = [];
  for (let i = 0; i <= N; i++) { const s = (maxS / N) * i; const price = base + (slope * s) / 1e18; pts.push([s, price]); }
  const maxP = Math.max(...pts.map((p) => p[1]), base * 1.1, 1e-9);
  const W = 400, H = 130, PAD = 4;
  const x = (s: number) => PAD + (s / maxS) * (W - 2 * PAD);
  const y = (p: number) => H - PAD - (p / maxP) * (H - 2 * PAD);
  const line = pts.map(([s, p]) => `${x(s).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const curX = x(supply);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bonding curve: price versus supply" style="width:100%;height:130px;display:block">
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="${curX.toFixed(1)}" y1="0" x2="${curX.toFixed(1)}" y2="${H}" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3,3"/>
    <circle cx="${curX.toFixed(1)}" cy="${y(base + (slope * supply) / 1e18).toFixed(1)}" r="3.5" fill="var(--accent)"/>
  </svg>
  <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--faint)"><span>supply 0</span><span>now — ${fmx(t.supply, 2)} ${esc(t.symbol)}</span><span>${int(Math.round(maxS))} ${esc(t.symbol)}</span></div>`;
}

async function renderDetail(agentId: number) {
  view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/tokens/">Agent tokens</a></p><div class="dhead"><h1>${skel("30%")}</h1></div></section>`;
  let t: AgentTokenView | null;
  try { t = await economy.tokenOf(agentId); }
  catch (e) { view.innerHTML += `<div class="alert warn">${esc(errMessage(e))}</div>`; view.setAttribute("aria-busy", "false"); return; }
  if (!t) { view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/tokens/">Agent tokens</a></p><h1>No token yet</h1><p class="muted" style="margin-top:10px">Agent #${agentId} has not launched a token. <a href="/agents/?id=${agentId}" style="text-decoration:underline">View the agent</a>.</p></section>`; view.setAttribute("aria-busy", "false"); return; }
  document.title = `${t.symbol} — Ferminux agent tokens`;
  view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/tokens/">Agent tokens</a> / <span class="num">${esc(t.symbol)}</span></p>
      <div class="dhead"><h1 class="mono">${esc(t.symbol)}</h1><div class="pills">${authorHtml(t.agent)}</div></div>
      <div class="meta-line"><span>Contract ${addrHtml(t.token, { n: 6, label: "Token contract" })}</span>${t.supply ? `<span>Supply <span class="num">${fmx(t.supply, 2)} ${esc(t.symbol)}</span></span>` : ""}${t.reserveWei ? `<span>Reserve <span class="num">${fmxUnit(t.reserveWei, 4)}</span></span>` : ""}</div>
    </section>
    <div class="detail">
      <div class="detail-main">
        <div class="card"><h3 style="margin-bottom:12px">Bonding curve</h3><div id="t-curve">${curveSvg(t)}</div></div>
        <div class="statgrid">
          <div><div class="l">Price now</div><div class="v num">${t.priceWei ? fmxUnit(t.priceWei, 5) : "—"}</div></div>
          <div><div class="l">Base</div><div class="v num">${t.base ? fmxUnit(t.base, 5) : "—"}</div></div>
          <div><div class="l">Slope</div><div class="v num">${t.slope ? `${fmx(t.slope, 6)} <span class="small faint">FMX / token</span>` : "—"}</div></div>
          <div><div class="l">Buys / sells</div><div class="v num">${int(t.buys)} / ${int(t.sells)}</div></div>
        </div>
        <div class="section-head" style="margin-top:24px"><h3>Distributions</h3></div>
        <div id="t-dist" class="rows">${skel("40%")}</div>
      </div>
      <aside class="detail-side">
        <div class="panel"><div class="panel-head"><h3>Trade</h3></div><div class="panel-body">
          <div class="tabs" role="tablist" aria-label="Trade" id="tb-tabs"><button class="tab" role="tab" id="tb-buy" aria-selected="true" aria-controls="t-trade">Buy</button><button class="tab" role="tab" id="tb-sell" aria-selected="false" aria-controls="t-trade">Sell</button></div>
          <div id="t-trade" role="tabpanel" aria-labelledby="tb-buy"></div>
        </div></div>
        <div id="t-credits" style="margin-top:16px"></div>
        <div class="panel" style="margin-top:16px"><div class="panel-head"><h3>Distribute to holders</h3></div><div class="panel-body">
          <p class="small muted">Owners share revenue with holders by sending FMX through <code>distribute()</code>; holders claim pro-rata (pull payment).</p>
          <div class="field"><label for="t-dist-amt">Amount (FMX)</label><input type="number" id="t-dist-amt" min="0" step="0.01" class="num" placeholder="1"></div>
          <div id="t-dist-status" role="status" aria-live="polite"></div>
          <button class="btn btn-secondary" type="button" id="t-dist-btn">Distribute</button>
          <button class="btn btn-secondary" type="button" id="t-claim-btn">Claim my share</button>
        </div></div>
      </aside>
    </div>`;
  view.setAttribute("aria-busy", "false");
  if (lastTradeNote) { view.querySelector(".detail")!.insertAdjacentHTML("beforebegin", `<div class="alert ok" style="margin-top:16px">${lastTradeNote}</div>`); lastTradeNote = ""; }
  loadDistributions(t);
  wireTrade(t);
  let seen: string | null = null;
  onWallet((s) => { if (s.address !== seen) { seen = s.address; paintTrade(t!); if (s.address) mountCredits($("#t-credits"), "tokenFactory", s.address); else { const c = $("#t-credits"); if (c) c.innerHTML = ""; } } });
  $("#t-dist-btn")!.addEventListener("click", () => doDistribute(t!));
  $("#t-claim-btn")!.addEventListener("click", () => doClaim(t!));
}

/** No per-event history route on the gateway (agent_tokens only sums a running total); shown as
 *  totals instead of a list — distributed so far, and (once a wallet is connected) your claimable share. */
async function loadDistributions(t: AgentTokenView) {
  const box = $("#t-dist")!;
  const total = t.totalDistributed ?? t.distributed;
  let claimable = t.claimableWei;
  try {
    if (!config.mock && tokenFactoryDeployed && walletState().address) {
      const c = contractRead(config.tokenFactory, TOKEN_FACTORY_ABI);
      claimable = ((await c.claimable(t.token, walletState().address)) as bigint).toString();
    }
  } catch { /* best effort */ }
  box.innerHTML = `<div class="row"><div class="row-main"><div class="row-title">${fmxUnit(total, 3)} distributed in total</div><div class="row-meta">shared pro-rata to holders via <code>distribute()</code></div></div>${claimable && BigInt(claimable) > 0n ? `<div class="row-side"><span class="big num">${fmxUnit(claimable, 4)}</span><span class="sub">your claim</span></div>` : ""}</div>`;
}

let tradeMode: "buy" | "sell" = "buy";
const phaseTo = (btn: HTMLButtonElement) => (ph: TxPhase) => { if (ph === "pending") setBusy(btn, true, "Waiting for a block…"); else if (ph === "indexing") setBusy(btn, true, "Indexing…"); };
/** Connected wallet's token balance (0n when not connected / not deployed). */
async function myTokenBalance(t: AgentTokenView): Promise<bigint> {
  const addr = walletState().address; if (!addr || config.mock || !tokenFactoryDeployed) return 0n;
  try { return (await contractRead(t.token, AGENT_TOKEN_ABI).balanceOf(addr)) as bigint; } catch { return 0n; }
}
function wireTrade(t: AgentTokenView) {
  const buyTab = $("#tb-buy") as HTMLButtonElement, sellTab = $("#tb-sell") as HTMLButtonElement;
  buyTab.addEventListener("click", () => { tradeMode = "buy"; buyTab.setAttribute("aria-selected", "true"); sellTab.setAttribute("aria-selected", "false"); paintTrade(t); });
  sellTab.addEventListener("click", () => { tradeMode = "sell"; sellTab.setAttribute("aria-selected", "true"); buyTab.setAttribute("aria-selected", "false"); paintTrade(t); });
  const panel = $("#t-trade"); for (const b of [buyTab, sellTab]) b.addEventListener("click", () => panel?.setAttribute("aria-labelledby", b.id));
  wireTabs($("#tb-tabs"));
  paintTrade(t);
}
async function paintTrade(t: AgentTokenView) {
  const box = $("#t-trade")!;
  const bal = await myTokenBalance(t);
  box.innerHTML = `<div class="field"><label for="tr-amt">${tradeMode === "buy" ? "Spend (FMX)" : `Sell (${esc(t.symbol)})`}</label><input type="number" id="tr-amt" min="0" step="any" class="num" placeholder="1">
      ${tradeMode === "sell" ? `<span class="hint">You hold <span class="num">${fmx(bal, 4)} ${esc(t.symbol)}</span>${bal > 0n ? ` · <button class="linkish" type="button" id="tr-half" style="color:var(--accent);font-weight:500">sell half</button> · <button class="linkish" type="button" id="tr-all" style="color:var(--accent);font-weight:500">sell all</button>` : ""}</span>` : walletState().address ? `<span class="hint">You hold <span class="num">${fmx(bal, 4)} ${esc(t.symbol)}</span></span>` : ""}</div>
    <div class="price-line"><span>You get</span><strong class="num" id="tr-out">—</strong></div>
    <p class="small faint">Quoted live from the curve; the order fails instead of filling if the price moves more than 1%. Sell proceeds are credited inside the factory — withdraw them from the credits panel.</p>
    <div id="tr-status" role="status" aria-live="polite"></div>
    <button class="btn btn-primary" type="button" id="tr-go">${tradeMode === "buy" ? "Buy" : "Sell"} ${esc(t.symbol)}</button>`;
  const input = $("#tr-amt") as HTMLInputElement;
  $("#tr-half")?.addEventListener("click", () => { input.value = fmx(bal / 2n, 18).replace(/,/g, ""); input.dispatchEvent(new Event("input")); });
  $("#tr-all")?.addEventListener("click", () => { input.value = fmx(bal, 18).replace(/,/g, ""); input.dispatchEvent(new Event("input")); });
  const quote = async () => {
    const v = input.value.trim(); const out = $("#tr-out")!;
    if (!v || Number(v) <= 0) { out.textContent = "—"; return; }
    try {
      const amt = toWei(v);
      const res = tradeMode === "buy" ? await quoteBuy(t, amt) : await quoteSell(t, amt);
      out.textContent = tradeMode === "buy" ? `≈ ${fmx(res, 4)} ${t.symbol}` : `≈ ${fmx(res, 6)} FMX`;
    } catch (e) { out.textContent = "—"; $("#tr-status")!.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  };
  input.addEventListener("input", quote);
  $("#tr-go")!.addEventListener("click", async () => { await (tradeMode === "buy" ? doBuy(t, input.value.trim()) : doSell(t, input.value.trim())); });
}
async function quoteBuy(t: AgentTokenView, fmxIn: bigint): Promise<bigint> {
  if (config.mock) { return economy.mockQuoteBuy(t.symbol, fmxIn); }
  if (tokenFactoryDeployed) { const c = contractRead(config.tokenFactory, TOKEN_FACTORY_ABI); return BigInt(await c.quoteBuy(t.token, fmxIn)); }
  const price = BigInt(t.priceWei ?? "0"); return price > 0n ? (fmxIn * 10n ** 18n) / price : 0n;
}
async function quoteSell(t: AgentTokenView, amountIn: bigint): Promise<bigint> {
  if (config.mock) { return economy.mockQuoteSell(t.symbol, amountIn); }
  if (tokenFactoryDeployed) { const c = contractRead(config.tokenFactory, TOKEN_FACTORY_ABI); return BigInt(await c.quoteSell(t.token, amountIn)); }
  return (amountIn * BigInt(t.priceWei ?? "0")) / 10n ** 18n;
}
async function doBuy(t: AgentTokenView, amtStr: string) {
  const btn = $("#tr-go") as HTMLButtonElement, status = $("#tr-status")!;
  if (!amtStr || Number(amtStr) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
  if (!walletState().address) { setBusy(btn, true, "Connecting…"); try { await connect(); } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); return; } setBusy(btn, false); }
  setBusy(btn, true, "Confirm in wallet…");
  try {
    const fmxIn = toWei(amtStr);
    if (config.mock) { await economy.mockBuyToken(t.symbol, fmxIn); }
    else {
      if (!tokenFactoryDeployed) throw new Error("AgentTokenFactory is not deployed yet.");
      const quoted = await quoteBuy(t, fmxIn); const minOut = (quoted * 99n) / 100n; // 1% slippage guard instead of minOut = 0
      const c = await contractWrite(config.tokenFactory, TOKEN_FACTORY_ABI); const r = await sendCall(c, "buy", [t.token, minOut], { value: fmxIn }, phaseTo(btn));
      lastTradeNote = `Bought ≈ ${fmx(quoted, 4)} ${esc(t.symbol)} for ${esc(amtStr)} FMX — ${txHtml(r.hash, "transaction")}.`;
    }
    toast("Bought"); renderDetail(t.agentId);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  finally { setBusy(btn, false); }
}
async function doSell(t: AgentTokenView, amtStr: string) {
  const btn = $("#tr-go") as HTMLButtonElement, status = $("#tr-status")!;
  if (!amtStr || Number(amtStr) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
  if (!walletState().address) { setBusy(btn, true, "Connecting…"); try { await connect(); } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); return; } setBusy(btn, false); }
  setBusy(btn, true, "Confirm in wallet…");
  try {
    const amountIn = toWei(amtStr);
    if (config.mock) { await economy.mockSellToken(t.symbol, amountIn); }
    else {
      if (!tokenFactoryDeployed) throw new Error("AgentTokenFactory is not deployed yet.");
      const bal = await myTokenBalance(t); if (amountIn > bal) throw new Error(`You only hold ${fmx(bal, 4)} ${t.symbol}.`);
      const quoted = await quoteSell(t, amountIn); const minFmx = (quoted * 99n) / 100n;
      const c = await contractWrite(config.tokenFactory, TOKEN_FACTORY_ABI); const r = await sendCall(c, "sell", [t.token, amountIn, minFmx], {}, phaseTo(btn));
      lastTradeNote = `Sold ${esc(amtStr)} ${esc(t.symbol)} for ≈ ${fmx(quoted, 6)} FMX (credited in the factory — withdraw below) — ${txHtml(r.hash, "transaction")}.`;
    }
    toast("Sold"); renderDetail(t.agentId);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  finally { setBusy(btn, false); }
}
async function doDistribute(t: AgentTokenView) {
  const btn = $("#t-dist-btn") as HTMLButtonElement, status = $("#t-dist-status")!;
  const amt = ($("#t-dist-amt") as HTMLInputElement).value.trim();
  if (!amt || Number(amt) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
  setBusy(btn, true, "Confirm…");
  try {
    if (!config.mock) { if (!tokenFactoryDeployed) throw new Error("AgentTokenFactory is not deployed yet."); const c = await contractWrite(config.tokenFactory, TOKEN_FACTORY_ABI); await sendCall(c, "distribute", [t.token], { value: toWei(amt) }, phaseTo(btn)); }
    status.innerHTML = `<div class="alert ok">Distributed ${esc(amt)} FMX to holders.</div>`; toast("Distributed"); loadDistributions(t);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  finally { setBusy(btn, false); }
}
async function doClaim(t: AgentTokenView) {
  const btn = $("#t-claim-btn") as HTMLButtonElement, status = $("#t-dist-status")!;
  setBusy(btn, true, "Confirm…");
  try {
    if (!config.mock) { if (!tokenFactoryDeployed) throw new Error("AgentTokenFactory is not deployed yet."); const c = await contractWrite(config.tokenFactory, TOKEN_FACTORY_ABI); await sendCall(c, "claimDistribution", [t.token], {}, phaseTo(btn)); }
    status.innerHTML = `<div class="alert ok">Claimed — it is credited in the factory; withdraw it from the credits panel.</div>`; toast("Claimed"); loadDistributions(t); if (walletState().address) mountCredits($("#t-credits"), "tokenFactory", walletState().address!);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  finally { setBusy(btn, false); }
}
