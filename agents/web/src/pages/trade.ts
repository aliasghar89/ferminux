// /trade/ — where FMX trades. The Ferminux DEX first: its pool's price, depth, last trade, what a buy of a given
// size gets, and how much of its LP supply is locked. PancakeSwap's wFMX pool on BNB Chain second, with the
// bridge's live state. The gateway's GET /api/payin/market carries both; when it cannot be read, the DEX pool is
// read straight from its reserves over the public RPC, and the PancakeSwap figures stay "—".
import { Contract } from "ethers";
import { economy } from "../economy";
import { api } from "../api";
import { DEX, DEX_QUOTES, buyFmx, lockedShare, spotUsdPerFmx, type LockRow } from "../market";
import { $, addrHtml, copyText, initChrome } from "../ui";
import { readProvider } from "../wallet";
import type { DexMarketPool, PancakeMarket, PayinMarket } from "../types";

initChrome();

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-block]"); if (!b) return;
  const pre = b.closest(".code-block")?.querySelector("pre"); if (pre) copyText(pre.textContent ?? "", b);
});
// the contract rows gain explorer links and copy buttons once the script runs; the plain addresses stay for crawlers
document.querySelectorAll<HTMLElement>("#dex [data-addr]").forEach((dd) => { dd.innerHTML = addrHtml(dd.dataset.addr!, { n: 8, label: dd.previousElementSibling?.textContent ?? "Address" }); });

const set = (id: string, text: string) => { const el = $(`#${id}`); if (el) el.textContent = text; };
const usd0 = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
/** A per-FMX price: four decimals below a dollar, where two would hide most of the number. */
const usdPrice = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
const amount0 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const day = (unixS: number | null | undefined) => { if (!unixS) return "—"; const d = new Date(unixS * 1000); return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10); };
const utc = (unixS: number) => new Date(unixS * 1000).toISOString().slice(11, 16) + " UTC";
const SWAP_OK = /^https:\/\/dex\.ferminux\.net\/(\?[\w=&.-]*)?$/;
const POOL_OK = /^https:\/\/explorer\.ferminux\.net\/address\/0x[0-9a-fA-F]{40}$/;

/** One pool, in the units this page draws with. */
interface DexView {
  pair: string; quoteSymbol: string; quoteDecimals: number; usdPerQuote: number; usdBasis: string;
  wfmxReserve: bigint; quoteReserve: bigint; lastTradeAt: number | null; readAt: number; swapUrl: string; poolUrl: string; source: "gateway" | "rpc";
}
const unitsOf = (text: string, decimals: number): bigint => {
  const [w, f = ""] = String(text).split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
};

function fromGateway(m: PayinMarket): DexView | null {
  if (m.venue !== "ferminux-dex" || !m.quoteSymbol || !(Number(m.priceInQuote) > 0)) return null;
  const pool: DexMarketPool | undefined = m.pools?.find((p) => p.pair.toLowerCase() === m.pair.toLowerCase());
  const q = DEX_QUOTES.find((x) => x.symbol === m.quoteSymbol);
  const decimals = q?.decimals ?? 6;
  const quoteReserve = pool?.quoteReserve ?? m.quoteReserve;
  if (quoteReserve == null) return null;
  return {
    pair: m.pair, quoteSymbol: m.quoteSymbol, quoteDecimals: decimals,
    usdPerQuote: Number(m.usdPerQuote ?? q?.usdPerUnit ?? 0), usdBasis: m.usdBasis ?? q?.usdBasis ?? "",
    wfmxReserve: unitsOf(m.wfmxReserve, 18), quoteReserve: unitsOf(quoteReserve, decimals),
    lastTradeAt: m.lastTradeAt || null, readAt: m.at,
    swapUrl: m.swapUrl && SWAP_OK.test(m.swapUrl) ? m.swapUrl : DEX.swapUrl,
    poolUrl: m.poolUrl && POOL_OK.test(m.poolUrl) ? m.poolUrl : `https://explorer.ferminux.net/address/${m.pair}`,
    source: "gateway",
  };
}

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
];
const LOCKER_ABI = ["function locksForToken(address token) view returns (tuple(uint256 id, address token, address owner, uint256 amount, uint64 lockedAt, uint64 unlockAt, bool withdrawn)[] list)"];

/** The WFMX/AZNT pool read straight from chain 3961, for when the gateway cannot answer. */
async function fromChain(): Promise<DexView | null> {
  const pair = new Contract(DEX.pair, PAIR_ABI, readProvider());
  const [[r0, r1, ts], t0] = await Promise.all([pair.getReserves() as Promise<[bigint, bigint, bigint]>, pair.token0() as Promise<string>]);
  const wfmxIs0 = t0.toLowerCase() === DEX.wfmx.toLowerCase();
  const q = DEX_QUOTES[0]; // AZNT: the pair's other side
  return {
    pair: DEX.pair, quoteSymbol: q.symbol, quoteDecimals: q.decimals, usdPerQuote: q.usdPerUnit, usdBasis: q.usdBasis,
    wfmxReserve: wfmxIs0 ? r0 : r1, quoteReserve: wfmxIs0 ? r1 : r0,
    // blockTimestampLast is the last reserve update: a swap, or a liquidity change
    lastTradeAt: Number(ts) || null, readAt: Math.floor(Date.now() / 1000),
    swapUrl: DEX.swapUrl, poolUrl: `https://explorer.ferminux.net/address/${DEX.pair}`, source: "rpc",
  };
}

function paintDex(v: DexView | null) {
  const pill = $("#tr-dex-pill")!;
  if (!v) {
    pill.className = "pill warn"; pill.textContent = "could not read the pool";
    set("tr-dex-read", "The pool could not be read just now. The swap link still works.");
    return;
  }
  const qd = 10 ** v.quoteDecimals;
  const qAmt = Number(v.quoteReserve) / qd, fAmt = Number(v.wfmxReserve) / 1e18;
  const priceInQuote = fAmt > 0 ? qAmt / fAmt : 0;
  const spot = spotUsdPerFmx({ wfmxReserve: v.wfmxReserve, quoteReserve: v.quoteReserve, quoteDecimals: v.quoteDecimals, usdPerQuote: v.usdPerQuote });
  pill.className = "pill ok"; pill.textContent = "live";
  set("tr-dex-price", `1 FMX = ${priceInQuote.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${v.quoteSymbol}`);
  set("tr-dex-usd", spot > 0 ? `≈ ${usdPrice(spot)}` : "");
  set("tr-dex-pool", `WFMX/${v.quoteSymbol} pool on chain 3961`);
  set("tr-dex-depth", v.usdPerQuote > 0 ? `≈ ${usd0(qAmt * v.usdPerQuote * 2)}` : "—");
  set("tr-dex-fmx", amount0(fAmt));
  set("tr-dex-qlabel", `${v.quoteSymbol} in pool`);
  set("tr-dex-q", amount0(qAmt));
  set("tr-dex-last", day(v.lastTradeAt));
  set("tr-dex-read", `Read ${utc(v.readAt)} from the pool's reserves${v.source === "rpc" ? " over the public RPC" : ""}.`);
  if (v.usdBasis) set("tr-basis", `USD figures convert through ${v.quoteSymbol}: ${v.usdBasis}.`);
  ($("#tr-swap") as HTMLAnchorElement).href = v.swapUrl;
  ($("#tr-swap-top") as HTMLAnchorElement).href = v.swapUrl;
  ($("#tr-pool-link") as HTMLAnchorElement).href = v.poolUrl;

  const rows = [100, 1_000, 10_000].map((usd) => {
    const r = spot > 0 ? buyFmx(usd, { wfmxReserve: v.wfmxReserve, quoteReserve: v.quoteReserve, quoteDecimals: v.quoteDecimals, usdPerQuote: v.usdPerQuote }) : null;
    if (!r) return `<tr><td class="r">${usd0(usd)}</td><td class="r">—</td><td class="r">—</td><td class="r">—</td></tr>`;
    return `<tr><td class="r">${usd0(usd)}</td><td class="r">${amount0(r.fmx)}</td><td class="r">${usdPrice(r.avgUsd)}</td><td class="r">+${r.impactPct.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%</td></tr>`;
  });
  $("#tr-impact")!.innerHTML = rows.join("");
  set("tr-depth-note", `Paid in ${v.quoteSymbol} at the pool's reserves read ${utc(v.readAt)}. A larger buy moves the price further; the swap screen shows the exact amount before you sign.`);
}

/** How much of the pool's LP supply the LiquidityLocker holds, and until when. */
async function loadLock(pairAddr: string) {
  const el = $("#tr-lock")!;
  try {
    const pair = new Contract(pairAddr, PAIR_ABI, readProvider());
    const locker = new Contract(DEX.locker, LOCKER_ABI, readProvider());
    const [supply, list] = await Promise.all([pair.totalSupply() as Promise<bigint>, locker.locksForToken(pairAddr) as Promise<Array<{ amount: bigint; unlockAt: bigint; withdrawn: boolean }>>]);
    const locks: LockRow[] = list.map((l) => ({ amount: l.amount, unlockAt: l.unlockAt, withdrawn: l.withdrawn }));
    const { pct, lockedUntil } = lockedShare(locks, supply, Math.floor(Date.now() / 1000));
    el.innerHTML = lockedUntil
      ? `LP tokens: <strong class="num">${pct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</strong> locked in the <a class="link-inline" href="https://explorer.ferminux.net/address/${DEX.locker}" rel="noopener">LiquidityLocker</a> until <strong class="num">${day(lockedUntil)}</strong>, so the pool's liquidity cannot be pulled before then.`
      : `LP tokens: none of this pool's LP supply is in a lock that is still in force.`;
  } catch {
    el.innerHTML = `LP tokens: <span class="faint">the LiquidityLocker could not be read just now.</span>`;
  }
}

function paintPancake(p: PancakeMarket | null | undefined) {
  const pill = $("#tr-bridge-pill")!;
  const paused = p ? p.bridgePaused !== false : null;
  pill.className = `pill ${paused === false ? "ok" : "warn"}`;
  pill.textContent = paused === false ? "bridge running" : paused ? "bridge paused" : "bridge: status unknown";
  if (paused === false) {
    $("#tr-bridge")!.className = "callout";
    $("#tr-bridge")!.innerHTML = `<p><strong>The bridge is running.</strong> wFMX can be bridged to native FMX on chain 3961. <a class="link-inline" href="/security.html#status">Live bridge status</a></p>`;
  }
  if (!p || !(Number(p.usdPerFmx) > 0)) { set("tr-pcs-read", "The PancakeSwap pool could not be read just now."); return; }
  set("tr-pcs-price", usdPrice(Number(p.usdPerFmx)));
  set("tr-pcs-depth", `≈ ${usd0(Number(p.liquidityUsd))}`);
  set("tr-pcs-fmx", Number(p.wfmxReserve).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  set("tr-pcs-last", day(p.lastTradeAt));
  set("tr-pcs-read", `Read ${utc(p.at)} from the pool's reserves on BNB Chain.`);
}

async function load(first = false) {
  let market: PayinMarket | null = null;
  try { market = await economy.payinMarket(); } catch { /* fall back to the chain */ }
  let dex = market ? fromGateway(market) : null;
  if (!dex) { try { dex = await fromChain(); } catch { dex = null; } }
  paintDex(dex);
  if (first) loadLock(dex?.pair ?? DEX.pair);
  // Gateways from before 2026-09-26 answer with PancakeSwap at the top level; newer ones put it under `secondary`.
  const pcs: PancakeMarket | null | undefined = !market ? null : market.venue === "ferminux-dex" ? market.secondary
    : { venue: "pancakeswap", source: market.source, chain: market.chain, pair: market.pair, token: market.token, usdPerFmx: market.usdPerFmx, liquidityUsd: market.liquidityUsd, wfmxReserve: market.wfmxReserve, lastTradeAt: market.lastTradeAt, at: market.at, swapUrl: "", bridgePaused: market.bridgePaused ?? true, bridgeReason: market.bridgeReason ?? null, bridgeStatusUrl: "" };
  paintPancake(pcs);
  if (market?.quoteUsdPerFmx && Number(market.quoteUsdPerFmx) > 0) set("tr-payin", `${usdPrice(Number(market.quoteUsdPerFmx))} per FMX`);
}

async function loadFaucet() {
  try {
    const s = await api.faucetStatus();
    if (s.enabled && s.dripFmx) set("tr-faucet", `${Number(s.dripFmx).toLocaleString("en-US", { maximumFractionDigits: 4 })} FMX a day`);
  } catch { /* nothing */ }
}

load(true);
loadFaucet();
// keep the numbers current while the page is open: pools move only on trades, so once a minute is plenty
setInterval(() => { if (!document.hidden) load(); }, 60_000);
