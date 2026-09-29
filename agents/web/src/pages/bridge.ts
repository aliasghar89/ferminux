// /bridge/: the bridge between Ferminux and BNB Smart Chain is paused. The page is static HTML, so crawlers and
// agents read every word without running anything. This script adds the site chrome, the copy buttons and two
// live reads, each independent so one failure never blanks the other:
//   1. GET /api/payin/market: `secondary` carries the gateway's bridge state (bridgePaused, bridgeReason) and the
//      PancakeSwap pool; the top level carries the pay-in quote shown on the Buy FMX route;
//   2. the collateral: FMX locked in the Ferminux bridge against wFMX outstanding on BNB Smart Chain, read from
//      the nodes (the same calls as /security.html).
// A read that fails leaves "—" or says it could not be read; it never shows a reassuring default.
import { economy } from "../economy";
import { config } from "../config";
import { ethCall, pad32, units } from "../chainread";
import { esc } from "../format";
import { $, copyText, initChrome } from "../ui";
import type { PayinMarket } from "../types";

initChrome();

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-block]"); if (!b) return;
  const pre = b.closest(".code-block")?.querySelector("pre"); if (pre) copyText(pre.textContent ?? "", b);
});

const BSC = ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb"];
const BRIDGE = "0xe162eeDa683f067d4Ebf61060Fa322332a779EF4";
const WFMX = "0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0";
const SEL = { lockedBalance: "0x9ae697bf", totalSupply: "0x18160ddd" }; // lockedBalance(address), totalSupply()
const NATIVE = pad32("0"); // address(0): the native coin's slot in the bridge's token registry

const set = (id: string, text: string) => { const el = $(`#${id}`); if (el) el.textContent = text; };
const day = (unixS: number | null | undefined) => { if (!unixS) return null; const d = new Date(unixS * 1000); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const usdPrice = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });

/* ---- 1. the gateway: bridge state, the PancakeSwap pool, the pay-in quote ---- */
async function loadMarket() {
  let m: PayinMarket | null = null;
  try { m = await economy.payinMarket(); } catch { /* stays as the static text says */ }
  const pill = $("#bp-pill"), reason = $("#bp-reason");
  // Gateways from before 2026-09-26 answer with PancakeSwap at the top level; newer ones put it under `secondary`.
  const pcs = !m ? null : m.venue === "ferminux-dex" ? m.secondary ?? null : m;
  const paused = pcs ? pcs.bridgePaused !== false : null;
  const why = pcs?.bridgeReason ?? null;
  if (pill && reason) {
    if (paused === false) {
      pill.className = "pill ok"; pill.textContent = "running";
      reason.innerHTML = `The gateway reports the validators signing again. The bridge app is still offline here; check the <a class="link-inline" href="/security.html#status">security page</a> before sending anything.`;
    } else if (paused) {
      pill.className = "pill warn"; pill.textContent = "paused";
      reason.innerHTML = why ? `The validators' live report: ${esc(why)}.` : "The validators' live report: not signing.";
    } else {
      pill.className = "pill"; pill.textContent = "status unknown";
      reason.textContent = "The live state could not be read just now. Treat the bridge as paused.";
    }
  }
  if (pcs && pcs.wfmxReserve != null && Number.isFinite(Number(pcs.wfmxReserve))) {
    const last = day(pcs.lastTradeAt);
    set("bp-pool", `${Number(pcs.wfmxReserve).toLocaleString("en-US", { maximumFractionDigits: 2 })} wFMX in it${last ? `, last trade ${last}` : ""}`);
  }
  if (m?.quoteUsdPerFmx && Number(m.quoteUsdPerFmx) > 0) set("bp-payin", `${usdPrice(Number(m.quoteUsdPerFmx))} per FMX`);
}

/* ---- 2. the collateral on both chains ---- */
async function loadCollateral() {
  const [locked, minted] = await Promise.all([
    ethCall(config.rpc, BRIDGE, SEL.lockedBalance + NATIVE).catch(() => null),
    ethCall(BSC, WFMX, SEL.totalSupply).catch(() => null),
  ]);
  if (locked) set("bp-locked", `${units(locked)} FMX`);
  if (minted) set("bp-minted", `${units(minted)} wFMX`);
  const v = $("#bp-verdict");
  if (!v) return;
  if (locked && minted) {
    v.innerHTML = BigInt(locked) === BigInt(minted)
      ? `<b class="ok">Matched.</b> Every wFMX is backed by FMX locked on Ferminux, exactly. Read ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`
      : `<b class="bad">Mismatch.</b> These two figures should be identical. The <a class="link-inline" href="/security.html#invariant">security page</a> explains why that matters.`;
  } else {
    v.textContent = "Could not read both chains just now. Run the commands below yourself.";
  }
}

void loadMarket();
void loadCollateral();
