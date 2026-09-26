// /security.html — the bridge security record. Three live sources, each read independently so one failure
// never blanks the others:
//   1. the validators' own status report (/bridge/status.json, written by the relayer): are they signing?
//   2. the contracts on both chains: collateral, caps, timelock, quorum, pause switch;
//   3. the foundation lock-up contract.
// Selectors are from `cast sig`, not guessed: a wrong selector does not fail loudly, it returns the wrong
// slot, and this page would show a confident, incorrect number — worse than an em-dash.
import { initChrome, $ } from "../ui";
import { esc, int, relTime } from "../format";
import { config } from "../config";
import { ethCall, pad32, units, words } from "../chainread";

initChrome();

const BSC = ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb"];
const BRIDGE = "0xe162eeDa683f067d4Ebf61060Fa322332a779EF4";
const WFMX = "0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0";
const LOCK = "0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d";
const SEL = {
  lockedBalance: "0x9ae697bf", // lockedBalance(address)
  totalSupply: "0x18160ddd",   // totalSupply()
  tokenConfig: "0xfe136c4e",   // tokenConfig(address) → (kind, paused, remoteChainId, remoteToken, maxPerTransfer, dailyCap)
  timelockDelay: "0xeef09bad", // timelockDelay()
  getValidators: "0xb7ab4db5", // getValidators()
  threshold: "0x42cde4e8",     // threshold()
  paused: "0x5c975abb",        // paused()
  locked: "0xcf309012",        // locked()
  unlockAt: "0xaa5dec6f",      // unlockAt()
};
const NATIVE = pad32("0"); // address(0): the native coin's slot in the bridge's token registry
/** A report older than this is not trusted: the relayer rewrites it continuously while it runs. */
const STATUS_MAX_AGE_MS = 10 * 60_000;

const set = (id: string, v: string) => { const el = $(`#${id}`); if (el) el.textContent = v; };
const opt = <T>(p: Promise<T>) => p.catch(() => null);

/* ---- 1. the validators' own report ---- */
interface RelayerChain { name?: string; chainId?: number; finality?: { signing?: { paused?: boolean; reason?: string | null } | null } | null }
interface RelayerStatus { generatedAt?: number; chains?: RelayerChain[] }
const chainName = (c: RelayerChain) => c.chainId === 3961 ? "Ferminux" : c.chainId === 56 ? "BNB Smart Chain" : esc(c.name || `chain ${c.chainId ?? "?"}`);

async function loadStatus() {
  const verdict = $("#br-verdict"), list = $("#br-chains"), box = $("#br-now");
  if (!verdict || !list || !box) return;
  let s: RelayerStatus;
  try {
    const r = await fetch("/bridge/status.json", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error(`HTTP ${r.status}`);
    s = (await r.json()) as RelayerStatus;
  } catch {
    verdict.innerHTML = `<b>Bridge status unavailable.</b> The validators' report could not be read, so treat the bridge as not signing until it can be.`;
    return;
  }
  const chains = Array.isArray(s.chains) ? s.chains : [];
  const at = Number(s.generatedAt) || 0;
  const stale = !at || Date.now() - at > STATUS_MAX_AGE_MS;
  const paused = chains.filter((c) => c.finality?.signing?.paused);
  const when = at ? ` Report written ${esc(relTime(Math.floor(at / 1000)))}.` : "";
  if (stale) {
    verdict.innerHTML = `<b>Bridge paused: the validators' report is stale.</b> A report that has stopped updating is not trusted, so treat the bridge as not signing.${when}`;
  } else if (paused.length) {
    verdict.innerHTML = `<b>Bridge paused: validators are not signing.</b> No transfer is released or minted until they resume.${when}`;
  } else if (chains.length) {
    box.classList.remove("warn"); box.classList.add("accent");
    verdict.innerHTML = `<b>Validators report signing on ${chains.map(chainName).join(" and ")}.</b> That is their own report; the collateral check below is the one to verify.${when}`;
  } else {
    verdict.innerHTML = `<b>Bridge status unavailable.</b> The report lists no chains, so treat the bridge as not signing.${when}`;
  }
  const rows = chains.map((c) => {
    const sg = c.finality?.signing;
    return `<li><strong>${chainName(c)}:</strong> ${sg?.paused ? `signing paused — ${esc(sg.reason || "no reason given")}` : sg ? "signing" : "no signing state reported"}</li>`;
  });
  list.innerHTML = rows.join("");
  list.hidden = !rows.length;
}

/* ---- 2 + 3. the contracts ---- */
async function loadChain() {
  const [locked, minted, cfg, delay, vals, thr, paused, lk, unlock] = await Promise.all([
    opt(ethCall(config.rpc, BRIDGE, SEL.lockedBalance + NATIVE)),
    opt(ethCall(BSC, WFMX, SEL.totalSupply)),
    opt(ethCall(config.rpc, BRIDGE, SEL.tokenConfig + NATIVE)),
    opt(ethCall(config.rpc, BRIDGE, SEL.timelockDelay)),
    opt(ethCall(config.rpc, BRIDGE, SEL.getValidators)),
    opt(ethCall(config.rpc, BRIDGE, SEL.threshold)),
    opt(ethCall(config.rpc, BRIDGE, SEL.paused)),
    opt(ethCall(config.rpc, LOCK, SEL.locked)),
    opt(ethCall(config.rpc, LOCK, SEL.unlockAt)),
  ]);

  const v = $("#verdict");
  if (locked && minted) {
    set("locked", `${units(locked)} FMX`);
    set("minted", `${units(minted)} wFMX`);
    if (v) v.innerHTML = BigInt(locked) === BigInt(minted)
      ? `<b class="ok">Fully collateralised.</b> Every wrapped token is backed by locked FMX, exactly.`
      : `<b class="bad">Mismatch.</b> These figures should be identical. Do not bridge until this is explained.`;
  } else if (v) v.textContent = "Could not read both chains just now — run the commands below yourself.";

  const w = cfg ? words(cfg) : [];
  if (w.length >= 6) { set("maxper", `${units(`0x${w[4]}`)} FMX`); set("daily", `${units(`0x${w[5]}`)} FMX`); }
  if (delay) { const secs = Number(BigInt(delay)); set("timelock", secs >= 3600 ? `${int(secs / 3600)} hours` : `${int(secs)} s`); }
  // getValidators() returns a dynamic array: [offset][length][addr…]
  const vw = vals ? words(vals) : [];
  if (thr && vw.length >= 2) set("quorum", `${int(Number(BigInt(thr)))} of ${int(Number(BigInt(`0x${vw[1]}`)))}`);
  if (paused) set("pause", BigInt(paused) === 0n ? "not engaged" : "ENGAGED");
  if (lk) set("lk-amt", `${units(lk)} FMX`);
  if (unlock) set("lk-date", new Date(Number(BigInt(unlock)) * 1000).toISOString().slice(0, 10));

  set("asof", `Figures read live from Ferminux, BNB Smart Chain and the validators' report · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
}

void loadStatus();
void loadChain();
