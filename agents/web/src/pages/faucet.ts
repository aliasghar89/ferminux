// /faucet/ — gas for a new key. The form POSTs /api/faucet {address[, pow]} (agents/gateway/src/v3/faucet.ts).
// Before it asks, the page checks what the chain can tell it (balance and nonce, from the public RPC), so a key
// the gateway would refuse gets a plain sentence and no request. Every limit on the page is read live from
// GET /api/faucet; the on-chain faucet contract's terms are read from the contract.
import { Contract, formatEther } from "ethers";
import { api, ApiError } from "../api";
import { config, explorerTx } from "../config";
import { checkFaucetAddress, faucetRefusal, solvePow, transfersFor, type FaucetStatus } from "../faucet";
import { esc, int, short } from "../format";
import { $, $$, addrHtml, copyText, initChrome, setBusy } from "../ui";
import { addNetwork, connect, errMessage, onWallet, readProvider } from "../wallet";

initChrome();

const FAUCET_CONTRACT = config.faucet;
const form = $("#fc-form") as HTMLFormElement;
const input = $("#fc-addr") as HTMLInputElement;
const go = $("#fc-go") as HTMLButtonElement;
const useWallet = $("#fc-wallet") as HTMLButtonElement;
const status = $("#fc-status")!;
const result = $("#fc-result")!;
const addrErr = $("#fc-addr-err")!;

let limits: FaucetStatus | null = null;
let busy = false;

/* ---------------- code blocks: copy the whole snippet ---------------- */
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-block]"); if (!b) return;
  const pre = b.closest(".code-block")?.querySelector("pre"); if (pre) copyText(pre.textContent ?? "", b);
});

/* ---------------- live limits ---------------- */
const fmxText = (s: string | undefined) => (s == null ? "—" : Number(s).toLocaleString("en-US", { maximumFractionDigits: 4 }));
const setAll = (key: string, text: string) => $$(`[data-fc="${key}"]`).forEach((el) => { el.textContent = text; });

function paintLimits() {
  const s = limits;
  const pill = $("#fc-state")!;
  if (!s) {
    pill.className = "pill"; pill.textContent = "unreachable";
    ["drip", "addr", "ip", "used", "pow"].forEach((k) => { $(`#fc-l-${k}`)!.textContent = "—"; });
    return;
  }
  const spent = s.globalPerDay != null && s.usedToday != null && s.usedToday >= s.globalPerDay;
  pill.className = `pill ${!s.enabled ? "warn" : spent ? "warn" : "ok"}`;
  pill.textContent = !s.enabled ? "switched off" : spent ? "today's budget spent" : "open";
  if (s.dripFmx) setAll("drip", fmxText(s.dripFmx));
  if (s.perIp) setAll("perIp", s.perIp);
  if (s.globalPerDay != null) setAll("global", int(s.globalPerDay));
  if (s.relayerReserveFmx) setAll("reserve", fmxText(s.relayerReserveFmx));
  $("#fc-l-drip")!.textContent = s.dripFmx ? `${fmxText(s.dripFmx)} FMX` : "—";
  $("#fc-l-addr")!.textContent = s.perAddress ?? "—";
  $("#fc-l-ip")!.textContent = s.perIp ?? "—";
  const used = $("#fc-l-used")!;
  if (s.usedToday != null && s.globalPerDay != null) {
    used.innerHTML = `<span class="num">${int(s.usedToday)}</span> <span class="faint">of</span> <span class="num">${int(s.globalPerDay)}</span>`;
    const bar = $("#fc-bar")!; bar.hidden = false;
    const pct = Math.min(100, (s.usedToday / Math.max(1, s.globalPerDay)) * 100);
    ($("#fc-bar-fill") as HTMLElement).style.width = `${pct}%`;
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${s.usedToday} of ${s.globalPerDay} drips used today`);
  } else used.textContent = "—";
  $("#fc-l-pow")!.textContent = s.pow && s.pow.bits > 0 ? `${s.pow.bits} bits, solved in this tab` : "off";
  go.disabled = !s.enabled;
}

async function loadLimits() {
  try { limits = await api.faucetStatus(); } catch { limits = null; }
  paintLimits();
}

/** What 0.5 FMX buys at today's base fee plus the 1 gwei tip the signers require. */
async function loadFee() {
  if (config.mock) return;
  try {
    const p = readProvider();
    const [block, tipHex] = await Promise.all([p.getBlock("latest"), p.send("eth_maxPriorityFeePerGas", [])]);
    const fee = (block?.baseFeePerGas ?? 0n) + BigInt(tipHex);
    const drip = BigInt(Math.round(Number(limits?.dripFmx ?? "0.5") * 1e6)) * 10n ** 12n;
    const n = transfersFor(drip, fee);
    if (n > 0) $("#fc-transfers")!.textContent = int(n);
  } catch { /* stays "—" */ }
}

/** The on-chain faucet's own terms, read from the contract. */
async function loadContract() {
  $("#fc-c-addr")!.innerHTML = addrHtml(FAUCET_CONTRACT, { n: 10, label: "Faucet contract" });
  if (config.mock) return;
  try {
    const c = new Contract(FAUCET_CONTRACT, ["function dripAmount() view returns (uint256)", "function cooldown() view returns (uint256)"], readProvider());
    const [drip, cool, bal] = await Promise.all([c.dripAmount() as Promise<bigint>, c.cooldown() as Promise<bigint>, readProvider().getBalance(FAUCET_CONTRACT)]);
    $("#fc-c-drip")!.textContent = Number(formatEther(drip)).toLocaleString("en-US", { maximumFractionDigits: 4 });
    const sec = Number(cool);
    $("#fc-c-cool")!.textContent = sec % 3600 === 0 ? `${sec / 3600} hours` : `${Math.round(sec / 60)} minutes`;
    $("#fc-c-bal")!.textContent = `${Number(formatEther(bal)).toLocaleString("en-US", { maximumFractionDigits: 2 })} FMX`;
  } catch { /* stays "—" */ }
}

/* ---------------- the form ---------------- */
function fieldError(msg: string | null) {
  addrErr.hidden = !msg; addrErr.textContent = msg ?? "";
  if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}
const say = (html: string, kind: "" | "warn" | "ok" | "info" = "info") => { status.innerHTML = html ? `<div class="alert ${kind}">${html}</div>` : ""; };

input.addEventListener("input", () => { if (!addrErr.hidden) fieldError(null); });

useWallet.addEventListener("click", async () => {
  setBusy(useWallet, true, "Connecting…");
  try { const a = await connect(); input.value = a; fieldError(null); input.focus(); }
  catch (e) { say(esc(errMessage(e)), "warn"); }
  finally { setBusy(useWallet, false); }
});
// A wallet this site already knows fills an empty field, never one the person typed into.
onWallet((s) => { if (s.address && !input.value.trim()) input.value = s.address; });

/**
 * What the chain says about the address before the gateway is asked: the gateway refuses a key that holds the
 * drip amount already or has sent a transaction. A failed read returns null and the gateway decides.
 */
async function precheck(address: string): Promise<string | null> {
  if (config.mock) return null;
  const drip = BigInt(Math.round(Number(limits?.dripFmx ?? "0.5") * 1e6)) * 10n ** 12n;
  try {
    const p = readProvider();
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000));
    const [bal, nonce] = await Promise.race([Promise.all([p.getBalance(address), p.getTransactionCount(address)]), timeout]);
    if (bal >= drip) return `This address already holds ${Number(formatEther(bal)).toLocaleString("en-US", { maximumFractionDigits: 4 })} FMX. The faucet only funds empty keys (below ${fmxText(limits?.dripFmx ?? "0.5")} FMX).`;
    if (nonce > 0) return `This address has already sent ${int(nonce)} transaction${nonce === 1 ? "" : "s"}. The faucet only funds keys that have never sent one.`;
  } catch { /* the gateway checks the same */ }
  return null;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  result.innerHTML = "";
  const chk = checkFaucetAddress(input.value);
  if (!chk.ok) { fieldError(chk.error); input.focus(); return; }
  fieldError(null);
  const address = chk.value;
  input.value = address;
  busy = true; setBusy(go, true, "Checking the address…");
  try {
    if (limits && !limits.enabled) { say("The faucet is switched off on this gateway right now.", "warn"); return; }
    const pre = await precheck(address);
    if (pre) { say(esc(pre), "warn"); return; }
    let pow: string | undefined;
    const bits = Number(limits?.pow?.bits ?? 0);
    if (bits > 0) {
      setBusy(go, true, "Solving the puzzle…");
      say(`Solving the anti-abuse puzzle (${int(bits)} bits) in this tab…`, "info");
      pow = await solvePow(address, bits, (tried) => say(`Solving the anti-abuse puzzle (${int(bits)} bits) · ${int(tried)} hashes tried…`, "info"));
    }
    setBusy(go, true, "Sending…");
    say("");
    const r = await api.faucetDrip(address, pow);
    const hash = r.txHash || r.tx || null;
    say("");
    showSent(address, r.amountFmx ?? limits?.dripFmx ?? "0.5", hash);
    loadLimits();
  } catch (err) {
    const msg = err instanceof ApiError ? faucetRefusal({ status: err.status, code: err.code, message: err.message }, limits) : errMessage(err);
    say(esc(msg), "warn");
  } finally {
    busy = false; setBusy(go, false);
    if (limits && !limits.enabled) go.disabled = true;
  }
});

function showSent(address: string, amount: string, hash: string | null) {
  result.innerHTML = `<div class="alert ok fc-done">
      <p><strong>${esc(fmxText(amount))} FMX is on its way to <span class="mono">${esc(short(address, 6))}</span>.</strong></p>
      ${hash ? `<p class="small">Transaction <a class="mono" href="${explorerTx(hash)}" rel="noopener">${esc(short(hash, 8))}</a> · <span id="fc-conf">waiting for a block…</span></p>` : ""}
    </div>
    <div class="fc-after">
      <button class="btn btn-secondary btn-sm" type="button" id="fc-add">Add Ferminux to my wallet</button>
      <a class="btn btn-secondary btn-sm" href="/register/">Register an agent</a>
      <a class="btn btn-secondary btn-sm" href="/developers/">Deploy a contract</a>
    </div>
    <p class="small faint" id="fc-add-status" role="status" aria-live="polite"></p>`;
  result.focus();
  $("#fc-add")?.addEventListener("click", async () => {
    const s = $("#fc-add-status")!;
    try { await addNetwork(); s.textContent = "Ferminux added. Switch to it in your wallet."; }
    catch (e) { s.textContent = errMessage(e, "The wallet did not add the network."); }
  });
  if (hash && !config.mock) watchReceipt(hash, address);
  else if (hash) { const c = $("#fc-conf"); if (c) c.textContent = "confirmed."; }
}

/** Blocks come every 7 s; watch for about a minute, then leave the explorer link to say the rest. */
async function watchReceipt(hash: string, address: string) {
  const out = () => $("#fc-conf");
  const until = Date.now() + 70_000;
  while (Date.now() < until) {
    try {
      const rc = await readProvider().getTransactionReceipt(hash);
      if (rc) {
        const bal = await readProvider().getBalance(address).catch(() => null);
        const el = out(); if (!el) return;
        el.textContent = rc.status === 1
          ? `confirmed in block ${int(rc.blockNumber)}${bal != null ? `; the address now holds ${Number(formatEther(bal)).toLocaleString("en-US", { maximumFractionDigits: 4 })} FMX` : ""}.`
          : `the transaction failed in block ${int(rc.blockNumber)}.`;
        return;
      }
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
  const el = out(); if (el) el.textContent = "not in a block yet. The explorer link shows when it lands.";
}

loadLimits().then(loadFee);
loadContract();
