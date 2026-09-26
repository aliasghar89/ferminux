// /buy-fmx/ — web3 pay-in: connect a wallet, pick one of 7 chains (Ethereum, BNB Chain, Base, Arbitrum One,
// Polygon, Optimism, Avalanche C-Chain) + asset (USDC / USDT / native), get a quote, pay from the wallet in
// ONE click (ERC-20 transfer or native value transfer to the deposit address, exact amount from the quote —
// the amount never exceeds what was typed: dust is subtracted, never added), then watch seen → confirmed →
// paid with explorer links. A balance preflight before the wallet is asked to sign catches an insufficient
// balance with a clear message instead of letting the wallet fail. Manual-send fallback for wallets we cannot
// drive; after success, add chain 3961 + FMX balance readout.
import { Interface } from "ethers";
import { ApiError, economy } from "../economy";
import { esc, fmx, short, toSec } from "../format";
import { $, initChrome, setBusy, toast } from "../ui";
import { PAYIN_CHAIN_PARAMS, config, explorerTx } from "../config";
import { addNetwork, connectAnyChain, errMessage, ethCall, getBalance, hasInjected, nativeBalanceOf, onWallet, sendRawTransaction, switchToChain, walletState } from "../wallet";
import type { PayinAsset, PayinAssets, PayinChain, PayinChainInfo, PayinMarket, PayinQuote, PayinStatus, PayinStatusName } from "../types";

initChrome();
const view = $("#view")!;
const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const CHAIN_LABEL: Record<PayinChain, string> = { eth: "Ethereum", bsc: "BNB Chain", base: "Base", arbitrum: "Arbitrum One", polygon: "Polygon", optimism: "Optimism", avalanche: "Avalanche C-Chain" };
const CHAINS: PayinChain[] = ["bsc", "base", "arbitrum", "polygon", "optimism", "avalanche", "eth"];
const CHAIN_ASSETS: Record<PayinChain, PayinAsset[]> = { eth: ["USDC", "USDT", "ETH"], bsc: ["USDC", "USDT", "BNB"], base: ["USDC", "USDT", "ETH"], arbitrum: ["USDC", "USDT", "ETH"], polygon: ["USDC", "USDT", "POL"], optimism: ["USDC", "USDT", "ETH"], avalanche: ["USDC", "USDT", "AVAX"] };
const NATIVE_PLACEHOLDER: Partial<Record<PayinAsset, string>> = { ETH: "0.01", BNB: "0.05", POL: "20", AVAX: "0.5" };
const STATUS_LABEL: Record<PayinStatusName, string> = { quoted: "Waiting for your payment", seen: "Payment seen, confirming", confirmed: "Confirmed, sending FMX", paid: "FMX delivered", expired: "Quote expired", failed: "Failed", superseded: "Replaced by a newer quote" };
/** units → decimal string, for balance-preflight messages (matches the gateway's own formatting). */
const fmtUnits = (u: bigint, decimals: number): string => { const d = 10n ** BigInt(decimals); const frac = (u % d).toString().padStart(decimals, "0").replace(/0+$/, ""); return `${u / d}${frac ? "." + frac : ".0"}`; };

let assets: PayinAssets | null = null;
let assetsFailed = false;
let market: PayinMarket | null = null;
let sel: { chain: PayinChain; asset: PayinAsset } = { chain: "bsc", asset: "USDC" };
let pollT = 0, tickT = 0;

/** The chains this page offers: only those whose deposit scanner has completed a recent scan (the gateway's
 *  `available`). Nothing is offered until the list loads; if it cannot load at all every chain is listed and
 *  the quote route, which applies the same rule, has the last word. */
function offered(): PayinChain[] {
  if (!assets) return assetsFailed ? CHAINS : [];
  if (!assets.enabled) return [];
  return CHAINS.filter((c) => chainInfo(c)?.available !== false);
}
const listNames = (cs: PayinChain[]) => { const n = cs.map((c) => CHAIN_LABEL[c]); return n.length > 1 ? `${n.slice(0, -1).join(", ")} or ${n[n.length - 1]}` : n[0] ?? ""; };
const utcTime = (unixS: number) => new Date(unixS * 1000).toISOString().slice(11, 16) + " UTC";
const usd0 = (text: string) => "$" + Number(text).toLocaleString("en-US", { maximumFractionDigits: 0 });
/** A per-FMX price: four decimals below a dollar, where two would hide most of the number. */
const usdPrice = (text: string) => "$" + Number(text).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Number(text) < 1 ? 4 : 2 });
const amount0 = (text: string) => Number(text).toLocaleString("en-US", { maximumFractionDigits: 0 });
const day = (unixS: number) => { const d = new Date(unixS * 1000); return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10); };
/** FMX's own market: the Ferminux DEX. Links from the API are used only when they point where they should. */
const DEX_SWAP_DEFAULT = "https://dex.ferminux.net/?inputCurrency=0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178&outputCurrency=FMX";
const dexSwapHref = (u?: string) => (u && /^https:\/\/dex\.ferminux\.net\/(\?[\w=&.-]*)?$/.test(u) ? u : DEX_SWAP_DEFAULT);
const poolHref = (m: PayinMarket) => (m.poolUrl && /^https:\/\/explorer\.ferminux\.net\/address\/0x[0-9a-fA-F]{40}$/.test(m.poolUrl) ? m.poolUrl : `https://explorer.ferminux.net/address/${esc(m.pair)}`);
const isDex = (m: PayinMarket) => m.venue === "ferminux-dex" && !!m.quoteSymbol && Number(m.priceInQuote) > 0;
const gapText = (m: PayinMarket) => { const gap = m.quoteVsMarketPct; return gap != null && Math.abs(gap) >= 1 ? ` · the pay-in price is ${Math.round(Math.abs(gap))}% ${gap > 0 ? "above" : "below"} it` : ""; };
/** wFMX is native FMX only through the bridge; say so whenever the validators' report does not show it moving. */
const bridgeText = (paused: boolean | undefined) => paused === false
  ? `wFMX can be bridged to native FMX (<a href="/security.html#status" style="text-decoration:underline">bridge status</a>).`
  : `The bridge is paused, so wFMX cannot be turned into native FMX today (<a href="/security.html#status" style="text-decoration:underline">bridge status</a>).`;
/** The market beside the quote: source, read time and depth always travel with the number. */
function marketText(m: PayinMarket): string {
  if (isDex(m)) {
    const q = esc(m.quoteSymbol!);
    return `FMX <strong class="num">${Number(m.priceInQuote).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${q}</strong> (≈ ${usdPrice(m.usdPerFmx)}) in the <a href="${poolHref(m)}" rel="noopener" target="_blank" style="text-decoration:underline">Ferminux DEX WFMX/${q} pool</a>, read ${utcTime(m.at)} from its reserves · depth ≈ ${usd0(m.liquidityUsd)}, so larger trades move the price${gapText(m)}`;
  }
  return `wFMX <strong class="num">${usd(m.usdPerFmx)}</strong> on <a href="https://bscscan.com/address/${esc(m.pair)}" rel="noopener" target="_blank" style="text-decoration:underline">PancakeSwap, BNB Chain</a>, read ${utcTime(m.at)} from the pool's reserves · pool depth ≈ ${usd0(m.liquidityUsd)}, so its price moves sharply with trade size${gapText(m)}`;
}
const TRADE_LINK = `<p class="small" style="margin:8px 0 0"><a href="/trade/" style="text-decoration:underline">Where FMX trades, and why there are two venues</a></p>`;
/** The side panel: the Ferminux DEX pool first; PancakeSwap only as "also traded on BNB Chain", with the bridge's state. */
function dexPanelHtml(m: PayinMarket | null): string {
  if (!m || !isDex(m)) {
    const pancake = m && !isDex(m) ? `<p class="small faint" style="margin:12px 0 0">Also traded on BNB Chain as wFMX: ${usdPrice(m.usdPerFmx)} on PancakeSwap, ≈ ${usd0(m.liquidityUsd)} deep. ${bridgeText(m.bridgePaused)}</p>` : "";
    return `<p class="small" style="margin:0 0 12px">FMX's market is the Ferminux DEX on chain 3961. Its pool could not be read just now.</p>
      <a class="btn btn-secondary" href="${DEX_SWAP_DEFAULT}" rel="noopener">Swap on Ferminux DEX</a>${pancake}${TRADE_LINK}`;
  }
  const q = esc(m.quoteSymbol!);
  const sec = m.secondary;
  const secondary = sec && Number(sec.usdPerFmx) > 0
    ? `Also traded on BNB Chain as wFMX: ${usdPrice(sec.usdPerFmx)} on PancakeSwap, ≈ ${usd0(sec.liquidityUsd)} deep. ${bridgeText(sec.bridgePaused)}`
    : `wFMX, the bridged coin on BNB Chain, also trades on PancakeSwap. ${bridgeText(undefined)}`;
  return `<p style="margin:0"><strong class="num" style="font-size:1.25em">1 FMX = ${Number(m.priceInQuote).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${q}</strong> <span class="small faint num">≈ ${usdPrice(m.usdPerFmx)}</span></p>
    <p class="small faint num" style="margin:6px 0 12px">WFMX/${q} pool: ${amount0(m.wfmxReserve)} FMX + ${amount0(m.quoteReserve ?? "0")} ${q}, ≈ ${usd0(m.liquidityUsd)} deep · last trade ${day(m.lastTradeAt)} · <a href="${poolHref(m)}" rel="noopener" target="_blank" style="text-decoration:underline">pool</a>. ${m.usdBasis ? `${esc(m.usdBasis)}.` : ""}</p>
    <a class="btn btn-secondary" id="bf-dex-swap" href="${dexSwapHref(m.swapUrl)}" rel="noopener">Swap on Ferminux DEX</a>
    <p class="small faint" style="margin:12px 0 0">A swap there pays in ${q} and settles native FMX to your address in one block. To pay with USDC, USDT or another chain's coin, use the quote on this page.</p>
    <p class="small faint" style="margin:8px 0 0">${secondary}</p>${TRADE_LINK}`;
}

/** Human amount: "10.0" → "10", "10.000001" → "10.000001", "0.0200" → "0.02" (group thousands). */
function human(text: string, maxFrac = 6): string {
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  const [w, f = ""] = text.split(".");
  const frac = f.slice(0, maxFrac).replace(/0+$/, "");
  return Number(w).toLocaleString("en-US") + (frac ? "." + frac : "");
}
const usd = (text: string) => "$" + Number(text).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mmss = (s: number) => `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
const chainInfo = (c: PayinChain): PayinChainInfo | undefined => assets?.chains.find((x) => x.chain === c);
const depositTx = (s: PayinStatus): { hash: string; url: string } | null => s.txHashes?.deposit ?? (s.txHashIn ? { hash: s.txHashIn, url: `${chainInfo(s.chain)?.explorer ?? "https://bscscan.com"}/tx/${s.txHashIn}` } : null);

function render() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Buy FMX</h1><p id="bf-intro">Pay with USDC, USDT or the chain's native coin, straight from your wallet. FMX lands in your chain-3961 address once the payment confirms. No account, no bridge.</p></div></div>
    </section>
    <div class="detail" style="padding-top:8px">
      <div class="detail-main">
        <div class="panel composer" style="margin-top:0"><div class="panel-head"><h3>1. What you pay with</h3><span class="pill" id="bf-price-pill"></span></div>
          <div class="panel-body">
            <div class="seg-row"><label for="bf-chain" class="small muted" style="min-width:52px">Network</label><select id="bf-chain" class="input" style="max-width:220px" aria-describedby="bf-chain-hint"></select></div>
            <p class="small faint" id="bf-chain-hint" hidden style="margin:-4px 0 12px"></p>
            <div class="seg-row"><span class="small muted" style="min-width:52px">Asset</span><div class="seg" role="radiogroup" aria-label="Asset" id="bf-asset"></div></div>
            <div class="form-row">
              <div class="field"><label for="bf-amount">Amount</label><div class="input-suffix"><input type="text" id="bf-amount" inputmode="decimal" placeholder="50" autocomplete="off" class="num" aria-describedby="bf-estimate"><span id="bf-amount-unit">USDC</span></div><span class="hint" id="bf-estimate">Between $1 and $10,000 per quote.</span></div>
              <div class="field"><label for="bf-to">Credit FMX to</label><input type="text" id="bf-to" placeholder="0x… on chain 3961" autocomplete="off" spellcheck="false" aria-describedby="bf-to-hint"><span class="hint" id="bf-to-hint">Your own address on Ferminux Network — usually the same wallet.</span></div>
            </div>
            <div id="bf-status" role="status" aria-live="polite"></div>
            <div class="actions"><button class="btn btn-primary" type="button" id="bf-go" style="width:auto">Get quote</button><span class="small faint">2% spread · quote valid 15 min</span></div>
            <p class="small faint" id="bf-market" hidden style="margin:14px 0 0"></p>
          </div></div>
        <div id="bf-result"></div>
      </div>
      <aside class="detail-side">
        <div class="panel" id="bf-dex-panel" style="margin-bottom:16px"><div class="panel-head"><h3>FMX market: Ferminux DEX</h3></div>
          <div class="panel-body" id="bf-dex" aria-live="polite"><p class="small faint" style="margin:0">Reading the pool on chain 3961…</p></div></div>
        <div class="panel"><div class="panel-head"><h3>Check an existing quote</h3></div>
          <div class="panel-body">
            <div class="field"><label for="bf-qid">Quote id</label><input type="text" id="bf-qid" placeholder="q_…" autocomplete="off" spellcheck="false"></div>
            <button class="btn btn-secondary" type="button" id="bf-check">Check status</button>
            <div id="bf-check-out"></div>
          </div></div>
        <div class="panel" style="margin-top:16px"><div class="panel-head"><h3>How it works</h3></div>
          <div class="panel-body"><ol class="steps" style="margin:0;padding:0">
            <li><span class="step-dot on">1</span><span>Pick network, asset and amount — you get a quote with an exact amount to pay.</span></li>
            <li><span class="step-dot on">2</span><span>Pay from your wallet (we switch it to the right network) or send manually.</span></li>
            <li><span class="step-dot on">3</span><span>Once the chain's required confirmations are seen, FMX is sent to your chain-3961 address automatically.</span></li>
          </ol></div></div>
        <p class="small faint" style="margin-top:12px">The price per FMX on this page is set by the operator; it is not read from a market. FMX's market is the Ferminux DEX on chain 3961: its pool's live price, depth and read time are shown above and under the form, next to the quote, so you can compare the two before you pay.</p>
      </aside>
    </div>
    <div style="height:24px"></div>`;
  view.setAttribute("aria-busy", "false");

  onWallet((s) => { const to = $("#bf-to") as HTMLInputElement | null; if (to && !to.value && s.address) to.value = s.address; });
  paintSelectors(); wireAssetGroup();
  ($("#bf-chain") as HTMLSelectElement).addEventListener("change", () => { sel.chain = ($("#bf-chain") as HTMLSelectElement).value as PayinChain; paintSelectors(); paintEstimate(); });
  $("#bf-amount")!.addEventListener("input", paintEstimate);
  $("#bf-go")!.addEventListener("click", getQuote);
  $("#bf-check")!.addEventListener("click", checkQuote);

  void loadAssets();
  void loadMarket();
}

async function loadAssets() {
  try {
    const a = await economy.payinAssets();
    assets = a; assetsFailed = false;
    const pill = $("#bf-price-pill")!;
    if (!a.enabled) { pill.textContent = "pay-in offline"; pill.className = "pill warn"; }
    else if (a.priceUsdPerFmx) { pill.textContent = `1 FMX = ${usd(a.priceUsdPerFmx)}`; pill.className = "pill accent"; }
  } catch {
    // the list could not load: offer every chain and let the quote route (same availability rule) decide
    if (!assets) assetsFailed = true;
  }
  paintSelectors(); paintEstimate();
}

async function loadMarket() {
  try { market = await economy.payinMarket(); } catch { market = null; }
  // a malformed answer is dropped, not rendered: marketText() would throw on it inside renderQuote()
  // (a read time outside the Date range, e.g. milliseconds sent as seconds, would make toISOString() throw too)
  if (market && !(Number(market.usdPerFmx) > 0 && Number.isFinite(market.at) && market.at > 0 && !Number.isNaN(new Date(market.at * 1000).getTime()) && Number.isFinite(Number(market.liquidityUsd)))) market = null;
  const el = $("#bf-market");
  if (el) { el.hidden = !market; el.innerHTML = market ? `Market reference: ${marketText(market)}.` : ""; }
  const panel = $("#bf-dex");
  if (panel) panel.innerHTML = dexPanelHtml(market);
  const row = $("#bf-q-market");
  if (row) { row.hidden = !market; const dd = row.querySelector("dd"); if (dd && market) dd.innerHTML = marketText(market); }
}

/** Chain select + asset radiogroup. The radios are rebuilt only when the chain (or the offered list) changes,
 *  so choosing an asset (mouse or arrow keys) keeps focus on the radio: one Tab stop, arrows move and select. */
let paintedKey = "";
function paintSelectors() {
  const list = offered();
  if (list.length && !list.includes(sel.chain)) sel.chain = list[0]!;
  if (!CHAIN_ASSETS[sel.chain].includes(sel.asset)) sel.asset = "USDC";
  const chainSel = $("#bf-chain") as HTMLSelectElement;
  const group = $("#bf-asset")!;
  const key = `${list.join(",")}|${sel.chain}`;
  if (paintedKey !== key || !group.children.length) {
    paintedKey = key;
    chainSel.innerHTML = list.length
      ? list.map((c) => `<option value="${c}"${c === sel.chain ? " selected" : ""}>${CHAIN_LABEL[c]}</option>`).join("")
      : `<option value="">${assets ? "No network available" : "Checking networks…"}</option>`;
    group.innerHTML = CHAIN_ASSETS[sel.chain].map((a) => `<button type="button" role="radio" aria-checked="false" data-asset="${a}">${a}</button>`).join("");
  }
  chainSel.disabled = !list.length;
  ($("#bf-go") as HTMLButtonElement).disabled = !list.length;
  paintAvailability(list);
  if (list.length) chainSel.value = sel.chain;
  group.querySelectorAll<HTMLButtonElement>("[data-asset]").forEach((b) => { const on = b.dataset.asset === sel.asset; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; });
  $("#bf-amount-unit")!.textContent = sel.asset;
  ($("#bf-amount") as HTMLInputElement).placeholder = NATIVE_PLACEHOLDER[sel.asset] ?? "50";
}
/** Says which chains are not offered and why, and keeps the intro's chain list to what is offered right now. */
function paintAvailability(list: PayinChain[]) {
  const hint = $("#bf-chain-hint"), intro = $("#bf-intro"), status = $("#bf-status");
  if (!hint || !intro || !status) return;
  const loaded = !!assets && assets.enabled;
  const off = loaded ? CHAINS.filter((c) => !list.includes(c)) : [];
  hint.textContent = loaded && list.length && off.length
    ? `Not offered right now: ${off.map((c) => CHAIN_LABEL[c]).join(", ")}. ${off.length === 1 ? "Its deposit scanner has" : "Their deposit scanners have"} not completed a recent scan, so a payment there could not be matched.`
    : "";
  hint.hidden = !hint.textContent;
  const none = loaded && !list.length;
  const noneMsg = status.querySelector("[data-none]");
  if (none && !noneMsg) status.innerHTML = `<div class="alert warn" data-none>No network is taking payments right now: no deposit scanner has completed a recent scan, so a payment could not be matched to a quote. Try again in a few minutes.</div>`;
  else if (!none && noneMsg) status.innerHTML = "";
  intro.textContent = `Pay with USDC, USDT or the chain's native coin${list.length && (loaded || assetsFailed) ? ` on ${listNames(list)}` : ""}, straight from your wallet. FMX lands in your chain-3961 address once the payment confirms. No account, no bridge.`;
}

function pickAsset(a: PayinAsset, focus = false) {
  sel.asset = a; paintSelectors(); paintEstimate();
  if (focus) $<HTMLButtonElement>(`#bf-asset [data-asset="${a}"]`)?.focus();
}
function wireAssetGroup() {
  const group = $("#bf-asset")!;
  group.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>("[data-asset]"); if (b) pickAsset(b.dataset.asset as PayinAsset); });
  group.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const list = CHAIN_ASSETS[sel.chain]; const i = list.indexOf(sel.asset);
    pickAsset(list[(i + step + list.length) % list.length], true);
  });
}

/** Client-side estimate for stables (1 USD each) from the published FMX price; native coins are priced at quote time. */
function paintEstimate() {
  const el = $("#bf-estimate")!;
  const v = Number(($("#bf-amount") as HTMLInputElement).value.trim());
  const stable = sel.asset === "USDC" || sel.asset === "USDT";
  if (!(v > 0)) { el.textContent = "Between $1 and $10,000 per quote."; return; }
  if (!stable || !assets?.priceUsdPerFmx) { el.textContent = `${sel.asset} is priced live when you get the quote.`; return; }
  const out = (v * (1 - (assets.spreadBps ?? 200) / 10_000)) / Number(assets.priceUsdPerFmx);
  el.textContent = `≈ ${out.toLocaleString("en-US", { maximumFractionDigits: 2 })} FMX at ${usd(assets.priceUsdPerFmx)} per FMX (after the 2% spread).`;
}

async function getQuote() {
  const btn = $("#bf-go") as HTMLButtonElement, status = $("#bf-status")!;
  const amount = ($("#bf-amount") as HTMLInputElement).value.trim().replace(/,/g, "");
  const to = ($("#bf-to") as HTMLInputElement).value.trim();
  status.innerHTML = "";
  if (!/^\d*\.?\d+$/.test(amount) || Number(amount) <= 0) { status.innerHTML = `<div class="alert warn">Enter a ${sel.asset} amount.</div>`; return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { status.innerHTML = `<div class="alert warn">Enter a valid chain-3961 address to credit.</div>`; return; }
  setBusy(btn, true, "Getting quote…");
  try {
    const q = await economy.payinQuote({ chain: sel.chain, asset: sel.asset, amount: amount.startsWith(".") ? "0" + amount : amount, to, from: walletState().address });
    renderQuote(q);
    $("#bf-result")!.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    const status503 = (e instanceof ApiError ? e.status : (e as { status?: number }).status) === 503;
    // a chain withdrawn since the list loaded answers 503 "temporarily unavailable": say so and re-read the list
    const chainDown = status503 && /temporarily unavailable/.test((e as Error).message);
    const msg = chainDown ? (e as Error).message : status503 ? "Pay-in is not available right now (the gateway's hot wallet or price feed is offline). Try again in a minute, or use the DEX." : (e as Error).message;
    status.innerHTML = `<div class="alert warn">${esc(msg)}</div>`;
    if (chainDown) void loadAssets();
  } finally { setBusy(btn, false); }
}

async function checkQuote() {
  const id = ($("#bf-qid") as HTMLInputElement).value.trim(); const out = $("#bf-check-out")!;
  if (!id) { out.innerHTML = `<div class="alert warn">Enter a quote id.</div>`; return; }
  out.innerHTML = `<p class="small muted">Checking…</p>`;
  try { const s = await economy.payinStatus(id); out.innerHTML = statusAlert(s); }
  catch (e) { out.innerHTML = `<div class="alert warn">${esc((e as Error).message)}</div>`; }
}

function statusAlert(s: PayinStatus): string {
  const tone = s.status === "paid" ? "ok" : s.status === "expired" || s.status === "failed" || s.status === "superseded" ? "warn" : "info";
  const dep = depositTx(s);
  const conf = s.status === "seen" ? ` · ${s.confirmations}/${s.required ?? 12} confirmations` : "";
  return `<div class="alert ${tone}" style="margin-top:10px"><strong>${esc(STATUS_LABEL[s.status] ?? s.status)}</strong>${conf}<br>
    <span class="small">${esc(human(s.amount ?? s.usdc))} ${esc(s.asset ?? "USDC")} on ${CHAIN_LABEL[s.chain] ?? s.chain} → ${fmx(s.fmxOut, 2)} FMX to <span class="mono">${esc(short(s.target, 6))}</span></span>
    ${dep ? `<br><a class="small mono" href="${esc(dep.url)}" rel="noopener" target="_blank">deposit tx ${esc(short(dep.hash, 6))} ↗</a>` : ""}
    ${s.txHashOut ? `<br><a class="small mono" href="${explorerTx(s.txHashOut)}" rel="noopener" target="_blank">FMX tx ${esc(short(s.txHashOut, 6))} ↗</a>` : ""}
    ${s.error ? `<br><span class="small">${esc(s.error)}</span>` : ""}</div>`;
}

/* ------------------------------------------------------------------ quote + pay */

function renderQuote(q: PayinQuote) {
  clearTimeout(pollT); clearInterval(tickT);
  const box = $("#bf-result")!;
  const native = q.assetKind === "native";
  const dust = q.dustUnits && q.dustUnits !== "0";
  const dustNote = q.dustDirection === "up"
    ? "a few units more than you asked for — every smaller unique amount was already taken"
    : "a few units less than you asked for, so your payment never exceeds your balance";
  const chainName = CHAIN_LABEL[q.chain];
  // headline = the amount the user asked for; the exact (never more, usually a hair less) amount is what the wallet sends and is shown next to it
  const headline = human(q.amountRequested ?? q.amount);
  box.innerHTML = `<div class="panel" style="margin-top:20px" id="bf-quote"><div class="panel-head"><h3>2. Your quote</h3><span class="pill accent" id="bf-expiry" role="timer" aria-live="off">15:00</span></div>
    <div class="panel-body">
      <dl class="kv">
        <div class="kv-row"><dt>You pay</dt><dd><strong class="num" id="bf-pay-amount">${esc(headline)} ${esc(q.asset)}</strong> <span class="muted">on ${chainName}</span>${native ? "" : ` <span class="small faint">(${usd(q.usd)})</span>`}${dust ? `<br><span class="small faint">Exactly <span class="mono">${esc(q.sendExactlyFormatted)}</span> — ${dustNote}.</span>` : ""}</dd></div>
        ${native ? `<div class="kv-row"><dt>${esc(q.asset)} price</dt><dd class="num">${usd(q.assetUsd)} per ${esc(q.asset)} <span class="small faint">· ${usd(q.usd)} total</span></dd></div>` : ""}
        <div class="kv-row"><dt>You receive</dt><dd><strong class="num" id="bf-fmx-out">${fmx(q.fmxOut, 2)} FMX</strong> <span class="small faint">at ${usd(q.priceUsdPerFmx)} per FMX, 2% spread included</span></dd></div>
        <div class="kv-row" id="bf-q-market"${market ? "" : " hidden"}><dt>Market reference</dt><dd class="small">${market ? marketText(market) : ""}</dd></div>
        <div class="kv-row"><dt>Credited to</dt><dd><span class="mono">${esc(q.to)}</span> <span class="small faint">on Ferminux Network (3961)</span></dd></div>
        <div class="kv-row"><dt>Quote id</dt><dd><span class="mono">${esc(q.quoteId)}</span><button class="copy" type="button" data-copy="${esc(q.quoteId)}">copy</button></dd></div>
      </dl>
      <div id="bf-pay-status" role="status" aria-live="polite" style="margin-top:14px"></div>
      <div class="actions" style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" type="button" id="bf-pay" style="width:auto">Pay ${esc(headline)} ${esc(q.asset)} from wallet</button>
        <button class="linkish" type="button" id="bf-manual-toggle" aria-expanded="false" aria-controls="bf-manual">Send manually instead</button>
      </div>
      <div id="bf-manual" hidden style="margin-top:14px">
        <dl class="kv">
          <div class="kv-row"><dt>Network</dt><dd>${chainName} <span class="small faint">(chain id ${q.chainId})</span></dd></div>
          <div class="kv-row"><dt>Send exactly</dt><dd><span class="mono num" id="bf-exact">${esc(q.sendExactlyFormatted)}</span> ${esc(q.asset)}<button class="copy" type="button" data-copy="${esc(q.sendExactlyFormatted)}">copy</button>${dust ? `<br><span class="small faint">This amount is ${esc(q.dustUnits)} unit${q.dustUnits === "1" ? "" : "s"} ${q.dustDirection === "up" ? "more" : "less"} than you typed, so it can be told apart from another open quote — send it exactly as shown.</span>` : ""}</dd></div>
          <div class="kv-row"><dt>To</dt><dd><span class="mono">${esc(q.depositAddress)}</span><button class="copy" type="button" data-copy="${esc(q.depositAddress)}">copy</button></dd></div>
          ${q.token ? `<div class="kv-row"><dt>${esc(q.asset)} contract</dt><dd><span class="mono">${esc(q.token)}</span><button class="copy" type="button" data-copy="${esc(q.token)}">copy</button></dd></div>` : `<div class="kv-row"><dt>Note</dt><dd class="small">Send from a normal wallet address — transfers made by a smart-contract wallet are not detected.</dd></div>`}
        </dl>
        <p class="small faint" style="margin:10px 0 0">Any wallet works. The amount must match to the last digit — that is how the payment is matched to this quote${q.from ? ` (your address ${esc(short(q.from))} is also remembered)` : ""}.</p>
      </div>
      <div id="bf-progress" style="margin-top:18px"></div>
      <div class="txlog" id="bf-txs" style="margin-top:10px"></div>
      <div id="bf-after"></div>
    </div></div>`;

  // countdown: expiresAt is unix SECONDS from the gateway
  const expiresAtS = toSec(q.expiresAt) ?? Math.floor(Date.now() / 1000) + q.expires;
  let expired = false;
  const paintExpiry = () => {
    const el = $("#bf-expiry"); if (!el) return;
    const left = expiresAtS - Date.now() / 1000;
    if (left <= 0) {
      el.textContent = "expired"; el.className = "pill warn"; expired = true;
      const pay = $("#bf-pay") as HTMLButtonElement | null;
      if (pay && !pay.dataset.sent) { pay.disabled = true; $("#bf-pay-status")!.innerHTML = `<div class="alert warn">This quote has expired. Get a new quote before paying.</div>`; }
      clearInterval(tickT);
    } else { el.textContent = mmss(left); el.className = left < 120 ? "pill warn" : "pill accent"; }
  };
  paintExpiry(); tickT = window.setInterval(paintExpiry, 1000);

  $("#bf-manual-toggle")!.addEventListener("click", () => {
    const m = $("#bf-manual")!, t = $("#bf-manual-toggle")!;
    m.hidden = !m.hidden; t.setAttribute("aria-expanded", String(!m.hidden)); t.textContent = m.hidden ? "Send manually instead" : "Hide manual instructions";
  });
  $("#bf-pay")!.addEventListener("click", () => { if (!expired) void pay(q); });
  paintProgress(q, "quoted", 0);
  startPolling(q);
  void loadMarket(); // the reference beside a fresh quote is re-read, not the one from page load
}

const STEPS = ["Payment sent", "Seen on chain", "Confirmed", "FMX delivered"];
function paintProgress(q: PayinQuote, status: PayinStatusName | "sending" | "sent", confirmations: number) {
  const el = $("#bf-progress"); if (!el) return;
  const done = status === "paid" ? 4 : status === "confirmed" ? 3 : status === "seen" ? 2 : status === "sent" ? 1 : 0;
  const bad = status === "failed" || status === "expired" || status === "superseded" ? done : -1;
  const label = (i: number) => (i === 2 && status === "seen" ? `Confirming… ${confirmations}/${q.confirmations}` : i === 2 && done >= 3 ? `Confirmed (${q.confirmations}/${q.confirmations})` : STEPS[i]);
  el.innerHTML = `<ol class="steps" aria-label="Payment progress" style="margin:0;padding:0">${STEPS.map((_, i) => `<li><span class="step-dot ${i === bad ? "bad" : i < done ? "done" : i === done ? "on" : ""}">${i < done ? "✓" : i + 1}</span><span${i === done ? "" : ' class="muted"'}>${label(i)}</span></li>`).join("")}</ol>`;
}

function addTx(label: string, hash: string, url: string) {
  const log = $("#bf-txs"); if (!log) return;
  if (log.querySelector(`[data-hash="${hash}"]`)) return;
  log.insertAdjacentHTML("beforeend", `<div data-hash="${esc(hash)}">${esc(label)}: <a href="${esc(url)}" rel="noopener" target="_blank">${esc(short(hash, 8))} ↗</a></div>`);
}

/** ~0.0001 of a native coin — a rough "you probably have something left for gas" floor. Not chain- or
 * gas-price-aware; it only catches the obvious case, the wallet remains the final authority. */
const GAS_FLOOR_WEI = 100_000_000_000_000n;

/** Best-effort balance check before asking the wallet to sign: catches "not enough balance" with a clear
 * message instead of letting the wallet's transfer revert. Returns null when it looks fine, or when the
 * check itself couldn't run (e.g. an RPC hiccup) — in that case the wallet is left to try as before. */
async function checkBalance(q: PayinQuote, from: string): Promise<string | null> {
  try {
    const need = BigInt(q.sendExactly);
    if (q.assetKind === "native") {
      const bal = await nativeBalanceOf(from);
      if (bal < need) return `You have ${fmtUnits(bal, q.decimals)} ${q.asset}, this quote needs ${q.sendExactlyFormatted} ${q.asset}.`;
      if (bal < need + GAS_FLOOR_WEI) return `Your ${q.asset} balance is right at what this quote needs, with little left for gas on ${CHAIN_LABEL[q.chain]}. Get a new quote for a slightly smaller amount, or top up ${q.asset} first.`;
      return null;
    }
    const raw = await ethCall(q.token!, ERC20.encodeFunctionData("balanceOf", [from]));
    const bal = BigInt(raw);
    if (bal < need) return `You have ${fmtUnits(bal, q.decimals)} ${q.asset}, this quote needs ${q.sendExactlyFormatted} ${q.asset}.`;
    const gas = await nativeBalanceOf(from);
    if (gas <= 0n) return `No native coin for gas on ${CHAIN_LABEL[q.chain]} — you need a little of it alongside your ${q.asset}.`;
    return null;
  } catch {
    return null;
  }
}

async function pay(q: PayinQuote) {
  const btn = $("#bf-pay") as HTMLButtonElement, status = $("#bf-pay-status")!;
  status.innerHTML = "";
  const params = PAYIN_CHAIN_PARAMS[q.chainId];
  if (!params) { status.innerHTML = `<div class="alert warn">Unknown chain ${q.chainId}.</div>`; return; }
  try {
    setBusy(btn, true, "Connecting…");
    const from = walletState().address || (await connectAnyChain());
    let hash: string;
    // Demo builds (VITE_MOCK) without any wallet only pretend to pay.
    if (!(config.mock && !hasInjected())) {
      setBusy(btn, true, `Switching to ${CHAIN_LABEL[q.chain]}…`);
      await switchToChain(q.chainId, params);
      setBusy(btn, true, "Checking your balance…");
      const insufficient = await checkBalance(q, from);
      if (insufficient) { status.innerHTML = `<div class="alert warn">${esc(insufficient)}</div>`; setBusy(btn, false); return; }
      setBusy(btn, true, "Confirm in your wallet…");
      const units = BigInt(q.sendExactly);
      hash = q.assetKind === "native"
        ? await sendRawTransaction({ to: q.depositAddress, value: units })
        : await sendRawTransaction({ to: q.token!, data: ERC20.encodeFunctionData("transfer", [q.depositAddress, units]) });
    } else {
      // mock mode without an injected wallet: pretend the wallet signed
      setBusy(btn, true, "Confirm in your wallet…");
      await new Promise((r) => setTimeout(r, 700));
      hash = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    btn.dataset.sent = "1"; btn.disabled = true; btn.innerHTML = "Payment sent";
    addTx(`${q.asset} payment on ${CHAIN_LABEL[q.chain]}`, hash, `${q.explorer}/tx/${hash}`);
    status.innerHTML = `<div class="alert info">Payment sent from <span class="mono">${esc(short(from, 6))}</span>. Waiting for it to be seen on ${CHAIN_LABEL[q.chain]} — this page checks every 10 seconds; FMX follows after ${q.confirmations} confirmations.</div>`;
    paintProgress(q, "sent", 0);
    if (config.mock) void economy.mockPayinSent(q.quoteId, hash);
  } catch (e) {
    setBusy(btn, false);
    status.innerHTML = `<div class="alert warn">${esc(errMessage(e))} <button class="linkish" type="button" id="bf-manual-hint" style="text-decoration:underline">Send manually instead</button></div>`;
    $("#bf-manual-hint")?.addEventListener("click", () => { const m = $("#bf-manual")!; if (m.hidden) ($("#bf-manual-toggle") as HTMLButtonElement).click(); m.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  }
}

function startPolling(q: PayinQuote) {
  let sentLocally = false;
  const poll = async () => {
    try {
      const s = await economy.payinStatus(q.quoteId);
      sentLocally = !!($("#bf-pay") as HTMLButtonElement | null)?.dataset.sent;
      const dep = depositTx(s);
      if (dep) addTx(`${s.asset} payment on ${CHAIN_LABEL[s.chain]}`, dep.hash, dep.url);
      if (s.txHashOut) addTx("FMX on Ferminux Network", s.txHashOut, explorerTx(s.txHashOut));
      if (s.status !== "quoted" || !sentLocally) paintProgress(q, s.status === "quoted" ? "quoted" : s.status, s.confirmations);
      if (s.status === "seen" || s.status === "confirmed") {
        $("#bf-pay-status")!.innerHTML = `<div class="alert info"><strong>${esc(STATUS_LABEL[s.status])}</strong>${s.status === "seen" ? ` · ${s.confirmations}/${s.required ?? 12} confirmations` : ""}${s.error ? `<br><span class="small">${esc(s.error)}</span>` : ""}</div>`;
        const pay = $("#bf-pay") as HTMLButtonElement | null; if (pay) { pay.disabled = true; pay.innerHTML = "Payment received"; }
      }
      if (s.status === "paid") { clearInterval(tickT); const el = $("#bf-expiry"); if (el) { el.textContent = "paid"; el.className = "pill ok"; } await renderPaid(s); return; }
      if (s.status === "failed") { $("#bf-pay-status")!.innerHTML = `<div class="alert warn"><strong>Failed.</strong> ${esc(s.error || "The gateway could not complete this pay-in.")} Quote <span class="mono">${esc(s.quoteId)}</span> — contact support with this id.</div>`; return; }
      if (s.status === "expired") { $("#bf-pay-status")!.innerHTML = `<div class="alert warn">This quote expired before a payment was seen. If you already sent it, keep the quote id <span class="mono">${esc(s.quoteId)}</span> and contact support.</div>`; return; }
      if (s.status === "superseded") { $("#bf-pay-status")!.innerHTML = `<div class="alert warn">This quote was replaced by a newer one you requested for the same address. Don't send to it — use your latest quote instead.</div>`; return; }
    } catch { /* keep trying */ }
    pollT = window.setTimeout(poll, 10_000);
  };
  pollT = window.setTimeout(poll, 10_000);
}

async function renderPaid(s: PayinStatus) {
  $("#bf-pay-status")!.innerHTML = `<div class="alert ok"><strong>Done — ${fmx(s.fmxOut, 2)} FMX sent to <span class="mono">${esc(short(s.target, 6))}</span>.</strong>${s.txHashOut ? ` <a href="${explorerTx(s.txHashOut)}" rel="noopener" target="_blank">View on explorer.ferminux.net ↗</a>` : ""}</div>`;
  const after = $("#bf-after")!;
  after.innerHTML = `<div class="panel" style="margin-top:16px"><div class="panel-head"><h3>3. Use your FMX</h3></div><div class="panel-body">
    <p class="small muted" style="margin:0 0 10px">Ferminux Network is chain <span class="mono">3961</span> · RPC <span class="mono">https://rpc.ferminux.net</span> · explorer <span class="mono">https://explorer.ferminux.net</span>.</p>
    <div class="actions" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-secondary" type="button" id="bf-add-chain" style="width:auto">Add Ferminux Network to wallet</button>
      <span class="small" id="bf-balance">Balance on 3961: <span class="faint">checking…</span></span>
    </div>
    <p class="small faint" style="margin:10px 0 0">Next: <a href="/agents/" style="text-decoration:underline">hire an agent</a>, <a href="/register/" style="text-decoration:underline">register yours</a>, or <a href="/agent-wallets/" style="text-decoration:underline">open a policy wallet</a>.</p>
  </div></div>`;
  $("#bf-add-chain")!.addEventListener("click", async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    setBusy(b, true, "Check your wallet…");
    try { await addNetwork(); toast("Ferminux Network added"); b.innerHTML = "Added to wallet"; }
    catch (e) { toast(errMessage(e)); setBusy(b, false); }
  });
  const paintBalance = async () => {
    try { const bal = await getBalance(s.target); const el = $("#bf-balance"); if (el) el.innerHTML = `Balance on 3961: <strong class="num">${fmx(bal, 4)} FMX</strong> <span class="faint">(${esc(short(s.target))})</span>`; }
    catch { const el = $("#bf-balance"); if (el) el.innerHTML = `Balance on 3961: <span class="faint">unavailable</span>`; }
  };
  await paintBalance();
}

render();
