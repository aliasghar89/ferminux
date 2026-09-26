/* The shared chrome in index.html (§3.2, §3.3, §4.17, §8.4): header omnibox, menu sheet, phone search
   panel, the head pill, "Add Ferminux to your wallet", and the index-lag banner. Static markup, wired here. */
import { liveText } from "./motion";
import { onHead, onHeadState, headState, currentHead, headAge } from "./head";
import { api } from "./api";
import { int, relTime } from "./format";
import { bindOmnibox, omniboxHtml, initOmniKeys } from "./ui/omnibox";
import { navigate } from "./router";
import { toast } from "./ui/copy";
import { signerName } from "./signer";
import { relabelChips } from "./ui/hash";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

/* ---- the head pill: "● 396,650", digits roll on change; not a live region (it changes every 7 s) ---- */
function initHeadPill() {
  const pill = $<HTMLAnchorElement>("head-pill"), n = $("head-n");
  if (!pill || !n) return;
  const paint = () => {
    const h = currentHead(), s = headState();
    pill.dataset.state = s;
    if (!h) { pill.setAttribute("aria-label", s === "down" ? "Chain head unreadable" : "Latest block: reading the chain"); pill.title = s === "down" ? "Chain head unreadable" : ""; return; }
    const age = headAge() ?? 0;
    pill.title = s === "down" ? "Chain head unreadable" : s === "stale" ? `Last block ${Math.round(age)} s ago` : "";
    pill.setAttribute("aria-label", `Latest block ${int(h.n)}, confirmed ${relTime(h.ts)}${h.signer && signerName(h.signer) ? ` by ${signerName(h.signer)}` : ""}`);
  };
  onHead((h) => { liveText(n, int(h.n)); pill.href = `/block/${h.n}`; paint(); });
  onHeadState(paint);
  window.setInterval(() => { if (!document.hidden) paint(); }, 5000);
}

/* ---- menu sheet (< 1100) ---- */
function initMenu() {
  const btn = $<HTMLButtonElement>("menu-btn"), sheet = $("menu-sheet");
  if (!btn || !sheet) return;
  const behind = () => document.querySelectorAll<HTMLElement>("main, footer, .lag");
  const set = (open: boolean, refocus = false) => {
    sheet.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    behind().forEach((e) => { e.inert = open; });
    if (open) sheet.querySelector<HTMLElement>("a")?.focus();
    else if (refocus) btn.focus();
  };
  btn.addEventListener("click", () => set(sheet.hidden));
  sheet.addEventListener("click", (e) => { if ((e.target as Element).closest("a")) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) set(false, true); });
  matchMedia("(min-width: 1100px)").addEventListener("change", (m) => { if (m.matches) set(false); });
}

/* ---- phone search panel (< 900) ---- */
function initSearchPanel(): () => void {
  const btn = $<HTMLButtonElement>("search-btn"), panel = $("search-panel"), body = $("search-panel-body"), close = $<HTMLButtonElement>("search-close");
  if (!btn || !panel || !body) return () => {};
  body.insertAdjacentHTML("afterbegin", omniboxHtml({ large: false, label: "Search chain 3961" }).s);
  bindOmnibox(body.querySelector<HTMLFormElement>("[data-omni]")!);
  const set = (open: boolean, refocus = false) => {
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) panel.querySelector<HTMLInputElement>("input")?.focus();
    else if (refocus) btn.focus();
  };
  btn.addEventListener("click", () => set(panel.hidden));
  close?.addEventListener("click", () => set(false, true));
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape" && !(e.target as HTMLInputElement).value) set(false, true); });
  addEventListener("popstate", () => set(false));
  document.addEventListener("click", (e) => { if (!panel.hidden && (e.target as Element).closest("#main a, .omni-opt")) set(false); });
  matchMedia("(min-width: 900px)").addEventListener("change", (m) => { if (m.matches) set(false); });
  return () => set(true);
}

/* ---- "Add Ferminux to your wallet" (§5.16) ---- */
// The same entry as the chain registry listing (infra/listings/eip155-3961.json) and every other Ferminux dApp
// (shared/fxwallet/network.ts FERMINUX_ADD_CHAIN_PARAMS): a wallet that checks the name against the registry
// warns when they differ.
export const CHAIN_PARAMS = {
  chainId: "0xf79", chainName: "Ferminux", nativeCurrency: { name: "Ferminux", symbol: "FMX", decimals: 18 },
  rpcUrls: ["https://rpc.ferminux.net"], blockExplorerUrls: ["https://explorer.ferminux.net"],
  iconUrls: ["https://ferminux.net/assets/brand/favicon.svg", "https://ferminux.net/assets/brand/icon-512.png"],
};
function initAddChain() {
  document.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-add-chain]");
    if (!b) return;
    if (!window.ethereum) { navigate("/api-docs#wallet"); return; }
    try { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); toast("Ferminux Network added to your wallet"); }
    catch { toast("The wallet didn't add the network."); }
  });
}

/* ---- index lag (§8.4): compare the chain head with the index's newest block ---- */
export async function checkIndexLag() {
  const box = $("lag"), text = $("lag-text");
  if (!box || !text) return;
  try {
    const [blocks, status] = await Promise.all([api.mainBlocks({ fresh: true }), api.indexingStatus().catch(() => null)]);
    const h = currentHead();
    const lag = h && blocks[0] ? h.n - blocks[0].height : 0;
    if (lag > 30) { text.innerHTML = `The explorer's index is <strong>${int(lag)}</strong> blocks behind the chain. The newest blocks and transactions may be missing below.`; box.hidden = false; }
    else if (status && status.finished_indexing === false) { text.textContent = "The explorer's index is catching up."; box.hidden = false; }
    else box.hidden = true;
  } catch { /* the page shows its own error; the banner is only for a lagging index */ }
}

/* ---- footer groups: open on wide screens (they read as columns), folded on phones (≤ 699, components.css) ---- */
function initFooterFolds() {
  const mq = matchMedia("(min-width: 700px)");
  const sync = () => document.querySelectorAll<HTMLDetailsElement>("details[data-fold]").forEach((d) => { d.open = mq.matches; });
  sync();
  mq.addEventListener("change", sync);
}

/* ---- names that arrive after a page painted (the gateway's agent list lands ~60 ms after the index): re-tag
   the chips in place, on every page, instead of waiting for the page's next refresh ---- */
function initRelabel() {
  document.addEventListener("fx:book", () => { const m = document.getElementById("main"); if (m) relabelChips(m); });
}

export function initChrome() {
  initFooterFolds();
  initRelabel();
  const hs = $("hdr-search");
  if (hs) { hs.innerHTML = omniboxHtml({ label: "Search chain 3961" }).s; bindOmnibox(hs.querySelector<HTMLFormElement>("[data-omni]")!); }
  initHeadPill();
  initMenu();
  const openSearch = initSearchPanel();
  initOmniKeys(openSearch);
  initAddChain();
  // the lag check once the first head is in, then on every page load of the home page (home calls it too)
  const off = onHead(() => { off(); void checkIndexLag(); });
}
