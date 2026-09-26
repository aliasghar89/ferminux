// /validators/ — the validator pilot: invite-only, up to 20 seats of exactly 2,000 FMX on chain 3961, opening to
// everyone after an external audit.
//
// Without a hub address (src/validatorConfig.ts) the page says the pilot opens soon and offers the waitlist.
// With one, it reads the ValidatorHub and its lens straight from the node (never the gateway), and for the
// connected wallet (the site's connector: Ferminux Wallet first, then injected wallets, then WalletConnect):
//   invited (or open to all) → 1 download the validator app (SHA-256 from /downloads/validator-pilot/SHA256SUMS)
//                              2 paste its seat proof (fmx-validator seat-proof --owner <wallet>), checked here
//                              3 review: the exact contract, method and amount; the wallet's chain is read again
//                                and openSeat simulated right before the wallet is asked to sign
//                              4 the seat's live status, read from the lens every 14 s
//   not invited / full / paused → the waitlist
//   on the deny list → that, and nothing to sign
// The waitlist entry is signed by the wallet it lists (GET /api/validators/waitlist/challenge, personal_sign,
// POST /api/validators/waitlist), so the gateway can require signatures.
import { Contract, zeroPadValue, type ContractTransactionResponse, type TransactionReceipt } from "ethers";
import { initChrome, $, $$, connectPrompt, toast } from "../ui";
import { esc, int, short, fmxUnit } from "../format";
import { config, explorerAddr, explorerTx } from "../config";
import { rpc } from "../chainread";
import { onWallet, connect, personalSign, signer, readProvider, getBalance, errMessage, connectedWalletName } from "../wallet";
import { checkForm, checkChallenge, challengeQuery, type WaitlistForm, type WaitlistBody } from "../validatorForm";
import { pilotHub } from "../validatorConfig";
import {
  ACTIVATION_DELAY, CHAIN_ID, DOWNLOAD_BASE, HUB_ABI, JAIL_WINDOW, LENS_ABI, PACKAGES, PILOT_MAX_SEATS, REVERT_TEXT, SEAT_DEPOSIT_WEI,
  checkSeatProof, hubIface, parseSeatProof, parseSha256Sums, revertName, seatPhase, toSeatAccess, toSeatView,
  type CheckedProof, type SeatAccess, type SeatView,
} from "../validatorPilot";

initChrome();

const H = pilotHub;
const hubC = H ? new Contract(H.hub, HUB_ABI, readProvider()) : null;
const lensC = H ? new Contract(H.lens, LENS_ABI, readProvider()) : null;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const pill = (text: string, tone = "") => `<span class="pill ${tone}">${esc(text)}</span>`;
const addrLink = (a: string, n = 4) => `<span class="addr"><a class="mono" href="${explorerAddr(a)}" rel="noopener" title="${esc(a)}">${esc(short(a, n))}</a><button class="copy" type="button" data-copy="${esc(a)}" aria-label="Copy ${esc(a)}">copy</button></span>`;
const code = (cmd: string, label: string) => `<div class="vp-code"><code>${esc(cmd)}</code><button class="copy" type="button" data-copy="${esc(cmd)}" aria-label="Copy the ${esc(label)} command">copy</button></div>`;
const EXPLORER_SEAT = (id: number) => `${config.explorer}/validators/${id}`;

/* ==================================================================== state */

interface HubSummary { allowlistOnly: boolean; maxSeats: number; occupied: number; paused: boolean; rewardPool: bigint; runwayDays: number | null; owner: string; head: number }
type Os = "windows" | "linux";
const st = {
  hub: null as HubSummary | null,
  hubErr: false,
  hubMissing: false,
  addr: null as string | null,
  chainId: null as number | null,
  access: null as SeatAccess | null,
  accessErr: false,
  seats: null as SeatView[] | null,
  loadingWallet: false,
  step: 1 as 1 | 2 | 3 | 4,
  os: (/Windows/i.test(navigator.userAgent) ? "windows" : "linux") as Os,
  proofText: "",
  checked: null as CheckedProof | null,
  checkedFor: null as string | null,
  keyFree: null as boolean | null,
  attesterBal: null as bigint | null,
  opened: null as { id: number; hash: string } | null,
  sums: null as Map<string, string> | null,
  sumsErr: false,
};

/* ==================================================================== reads */

async function readHub(): Promise<HubSummary> {
  const [allowlistOnly, maxSeats, occupied, paused, pool, owner, head] = await Promise.all([
    hubC!.allowlistOnly(), hubC!.maxSeats(), hubC!.occupiedSeats(), hubC!.seatsPaused(), hubC!.rewardPool(), hubC!.owner(), readProvider().getBlockNumber(),
  ]);
  const runway = await lensC!.runwayDays().then((d: bigint) => (d > 100_000n ? null : Number(d))).catch(() => null);
  return { allowlistOnly: Boolean(allowlistOnly), maxSeats: Number(maxSeats), occupied: Number(occupied), paused: Boolean(paused), rewardPool: BigInt(pool), runwayDays: runway, owner: String(owner), head };
}

let deployBlock = H?.deployBlock ?? 0;
/** SeatOpened ids already found for one owner, and the block the scan reached: step 4 polls every 14 s, and
 *  rescanning from the deploy block each time would grow by one log query per 50,000 blocks for ever. */
const seatScan = { owner: "", to: 0, ids: new Set<number>() };
/** The wallet's seats: SeatOpened logs with the owner topic (from the hub's deploy block), then each seat from the lens. */
async function readMySeats(owner: string): Promise<SeatView[]> {
  const p = readProvider();
  if (!deployBlock) deployBlock = Number(await hubC!.deployBlock());
  const head = await p.getBlockNumber();
  const topic = hubIface.getEvent("SeatOpened")!.topicHash;
  if (!same(seatScan.owner, owner)) { seatScan.owner = owner; seatScan.to = 0; seatScan.ids = new Set(); }
  // a few blocks back from where the last scan ended, in case the tip it saw was replaced
  const start = seatScan.to ? Math.max(deployBlock, seatScan.to - 63) : deployBlock;
  const ids = new Set(seatScan.ids);
  for (let from = start; from <= head; from += 50_000) {
    const logs = await p.getLogs({ address: H!.hub, topics: [topic, null, zeroPadValue(owner, 32)], fromBlock: from, toBlock: Math.min(head, from + 49_999) });
    for (const l of logs) ids.add(Number(BigInt(l.topics[1])));
  }
  if (same(seatScan.owner, owner)) { for (const id of ids) seatScan.ids.add(id); seatScan.to = Math.max(seatScan.to, head); }
  // a stale id (a log from a replaced block) reads back with another owner or none, and is dropped here
  const seats = await Promise.all([...ids].sort((a, b) => b - a).map(async (id) => toSeatView(id, await lensC!.seat(id))));
  return seats.filter((s) => same(s.owner, owner));
}

async function loadHub() {
  if (!H) return;
  const had = !!st.hub;
  try { st.hub = await readHub(); st.hubErr = false; st.hubMissing = false; } catch {
    st.hubErr = true;
    // no code at the address (a wrong build setting, or a record from somewhere else): say so, not "RPC down"
    st.hubMissing = !st.hub && (await readProvider().getCode(H.hub).then((c) => c === "0x").catch(() => false));
  }
  paintChrome();
  // the 30 s refresh can recover from a failed first read: bring the join panel along with the banner
  if (!had && st.hub) { render(); if (st.addr && !st.access && !st.loadingWallet) loadWallet(); }
}

async function loadWallet() {
  const addr = st.addr;
  if (!H || !addr) { render(); return; }
  st.loadingWallet = true; render();
  const [acc, seats] = await Promise.allSettled([lensC!.seatAccess(addr), readMySeats(addr)]);
  if (addr !== st.addr) return; // the wallet changed while we read
  st.loadingWallet = false;
  st.access = acc.status === "fulfilled" ? toSeatAccess(acc.value) : null;
  st.accessErr = acc.status === "rejected";
  st.seats = seats.status === "fulfilled" ? seats.value : null;
  if (st.seats?.length && st.step === 1 && !st.checked) st.step = 4;
  render();
}

/* ==================================================================== the page's fixed parts */

function paintChrome() {
  const h = st.hub;
  const pillEl = $("#status-pill")!, strong = $("#status-strong")!, line = $("#status-line")!;
  const joinPill = $("#join-pill")!, seatsV = $("#v-seats")!, note = $("#terms-note")!, tl = $("#tl-pilot-pill")!;
  if (!H) { renderContract(); return; }
  if (!h) {
    pillEl.textContent = st.hubMissing ? "Opens soon" : "Pilot"; joinPill.textContent = st.hubMissing ? "Not open" : st.hubErr ? "Contract not reachable" : "Reading…";
    line.innerHTML = st.hubMissing
      ? `There is no ValidatorHub contract at the address this page was built with, so no FMX can be deposited for a seat here. Anyone who asks you to send FMX for a validator seat is not us.`
      : `Deposits go only to the ValidatorHub at <span class="mono">${esc(H.hub)}</span>, from this page. Anyone who asks you to send FMX anywhere else for a seat is not us.`;
    renderContract(); return;
  }
  const full = h.occupied >= h.maxSeats;
  pillEl.textContent = h.allowlistOnly ? "Pilot open" : "Open to all";
  if (!h.allowlistOnly) strong.textContent = "Seats are open to every wallet: the invite-only pilot has ended.";
  line.innerHTML = `Deposits go only to the ValidatorHub at <a class="link-inline mono" href="${explorerAddr(H.hub)}" rel="noopener">${esc(short(H.hub, 6))}</a>, from this page or with the validator app's own output. Anyone who asks you to send FMX anywhere else for a seat is not us.`;
  joinPill.className = `pill ${h.paused || full ? "warn" : "ok"}`;
  joinPill.textContent = h.paused ? "New seats paused" : full ? `All ${h.maxSeats} seats taken` : `${h.allowlistOnly ? "Invite-only · " : ""}${h.occupied} of ${h.maxSeats} taken`;
  seatsV.textContent = `${int(h.occupied)} of ${int(h.maxSeats)} taken`;
  note.textContent = "The seat count and the waitlist figure are live.";
  tl.className = "pill ok"; tl.textContent = h.allowlistOnly ? "Open to invited wallets" : "Ended";
  $("#f-seats")!.textContent = `${h.occupied} of ${h.maxSeats} taken`;
  if (!h.allowlistOnly) { $("#f-who")!.textContent = "Any wallet"; $("#f-next")!.textContent = "Step 2, announced separately"; }
  renderContract();
}

function renderContract() {
  const body = $("#c-body")!, cp = $("#c-pill")!;
  if (!H) return; // the static text stands
  const h = st.hub;
  cp.className = `pill ${h ? "ok" : st.hubMissing ? "warn" : ""}`; cp.textContent = h ? "On chain" : st.hubMissing ? "Not on chain" : st.hubErr ? "Not reachable" : "Reading…";
  if (!h && st.hubMissing) {
    body.innerHTML = `<p class="small muted">No contract is deployed at the address this page was built with, so it offers no deposit. The pilot's ValidatorHub address is published here and on the explorer, and only there.</p>`;
    return;
  }
  // only the foundation multisig is described as such; any other owner is shown as it is
  const ownerNote = h && same(h.owner, config.governance) ? `<span class="small faint"> foundation multisig, 2 of 3</span>` : `<span class="small vp-warn"> not the foundation multisig</span>`;
  const rows: [string, string][] = [
    ["ValidatorHub", addrLink(H.hub, 6)],
    ["Owner", h ? `${addrLink(h.owner)}${ownerNote}` : "—"],
    ["Seats", h ? `${int(h.occupied)} of ${int(h.maxSeats)} taken${h.allowlistOnly ? ", invite-only" : ""}` : "—"],
    ["New seats", h ? (h.paused ? "Paused" : "Open") : "—"],
    ["Reward pool", h ? `${esc(fmxUnit(h.rewardPool, 2))}${h.runwayDays !== null ? `<span class="small faint"> about ${int(h.runwayDays)} days at ${h.maxSeats} full seats</span>` : ""}` : "—"],
  ];
  body.innerHTML = `
    <dl class="vp-kv">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
    <p class="small muted">Not upgradeable. The owner cannot move or freeze a deposit. Reads come straight from the chain${h ? `, block ${int(h.head)}` : ""}.</p>
    ${st.hubErr && !h ? `<button type="button" class="btn btn-secondary btn-sm" data-act="retry-hub">Try again</button>` : ""}
    <a class="link-inline small" href="${explorerAddr(H.hub)}" rel="noopener">The contract on the explorer</a>`;
}

/* ==================================================================== the join panel */

type ViewKey = "soon" | "hub-error" | "connect" | "loading" | "denied" | "not-invited" | "full" | "paused" | "steps" | "access-error";

function viewKey(): ViewKey {
  if (!H) return "soon";
  if (!st.hub) return st.hubErr ? "hub-error" : "loading";
  if (!st.addr) return "connect";
  if (st.loadingWallet || (!st.access && !st.accessErr)) return "loading";
  if (!st.access) return "access-error";
  if (st.access.reason === "denied") return "denied";
  if (st.seats?.length || st.access.reason === "open") return "steps";
  return st.access.reason; // not-invited, full, paused
}

/** Can this wallet open a (further) seat right now? */
const canOpen = () => st.access?.reason === "open";

function render() {
  const k = viewKey();
  renderWallet();
  renderSteps(k);
  const view = $("#vp-view")!, wl = $("#wl-box")!;
  const showWl = k === "soon" || k === "connect" || k === "not-invited" || k === "full" || k === "paused" || k === "hub-error";
  wl.hidden = !showWl;
  if (showWl) paintWaitlistLead(k);
  view.innerHTML = viewHtml(k);
  wireView(k);
}

function renderWallet() {
  const el = $("#vp-wallet")!;
  if (!st.addr) {
    el.innerHTML = `<p class="vp-label">Your wallet</p><p class="small muted">Not connected.</p>`;
    return;
  }
  const onChain = st.chainId === CHAIN_ID;
  const a = st.access;
  const status = !H || !a ? "" : a.denied ? pill("Cannot hold a seat", "warn")
    : a.allowlistOnly ? (a.allowlisted ? pill("Invited", "ok") : pill("Not invited")) : pill("Seats open to all", "ok");
  const name = connectedWalletName();
  el.innerHTML = `<p class="vp-label">Your wallet${name ? ` · ${esc(name)}` : ""}</p>
    <p class="vp-addr"><span class="status-dot ${onChain ? "ok" : "bad"}" aria-hidden="true"></span>${addrLink(st.addr, 6)}</p>
    <p class="small ${onChain ? "faint" : "vp-warn"}">${onChain ? "On Ferminux, chain 3961" : "Not on Ferminux: the wallet is asked to switch before anything is signed"}</p>
    ${status ? `<p>${status}</p>` : ""}`;
}

const STEP_NAMES = ["Download the app", "Paste its seat proof", "Review and deposit", "Seat status"];
function renderSteps(k: ViewKey) {
  const ol = $("#vp-steps")!;
  if (k !== "steps") { ol.hidden = true; ol.innerHTML = ""; return; }
  ol.hidden = false;
  const reach = (n: number) => n === 1 || (n === 2 && canOpen()) || (n === 3 && !!st.checked && canOpen()) || (n === 4 && !!st.seats?.length);
  ol.innerHTML = STEP_NAMES.map((name, i) => {
    const n = (i + 1) as 1 | 2 | 3 | 4;
    const cur = st.step === n;
    const done = n < st.step || (n === 4 && !!st.seats?.length && !cur);
    const cls = `vp-step${cur ? " is-current" : ""}${done ? " is-done" : ""}`;
    const label = `<span class="vp-step-n" aria-hidden="true">${done && n !== 4 ? "✓" : n}</span><span class="vp-step-t">${esc(name)}</span>`;
    return `<li class="${cls}">${reach(n) && !cur ? `<button type="button" data-step="${n}">${label}</button>` : `<span${cur ? ' aria-current="step"' : ""}>${label}</span>`}</li>`;
  }).join("");
  $$<HTMLButtonElement>("button[data-step]", ol).forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.step) as 1 | 2 | 3 | 4)));
}

function go(step: 1 | 2 | 3 | 4) {
  st.step = step;
  render();
  const main = $("#vp-view");
  // on a phone the step's content is below the step list: bring its heading into view
  const h = main?.querySelector<HTMLElement>("h3");
  if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); h.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
  if (step === 4) { clearTimeout(seatTimer); seatTimer = 0; pollSeats(); }
}

function viewHtml(k: ViewKey): string {
  switch (k) {
    case "soon":
      return `<h3 class="vp-h">The pilot opens soon</h3>
        <p>Its contract, the ValidatorHub, is not on chain yet. When it is, its address is published on this page, and invited wallets open their seat here in four steps: download the validator app, paste what it prints, review the deposit, and watch the seat start.</p>
        <p class="small muted">There is no deposit button until then, and no address to send a deposit to: anyone asking for FMX for a seat before this page names the contract is not us.</p>`;
    case "hub-error":
      if (st.hubMissing) {
        return `<h3 class="vp-h">The pilot is not open on this page</h3>
        <p>There is no ValidatorHub contract at the address this page was built with, so there is nothing to deposit into. Invited wallets open their seat here once the contract is on chain.</p>
        <p class="small muted">Do not send FMX to that address or to anyone who asks for a seat deposit.</p>`;
      }
      return `<h3 class="vp-h">The contract could not be read</h3>
        <div class="alert warn">The Ferminux RPC did not answer for the ValidatorHub just now, so this page cannot tell which wallets are invited. Nothing was sent.</div>
        <p><button type="button" class="btn btn-secondary btn-sm" data-act="retry-hub">Try again</button></p>`;
    case "loading":
      return `<h3 class="vp-h">Reading the contract…</h3><p class="muted"><span class="sk" style="width:60%" aria-hidden="true"></span></p>`;
    case "access-error":
      return `<h3 class="vp-h">Your wallet's invitation could not be read</h3><div class="alert warn">The Ferminux RPC did not answer. Nothing was sent.</div><p><button type="button" class="btn btn-secondary btn-sm" data-act="retry-wallet">Try again</button></p>`;
    case "connect":
      return `<h3 class="vp-h">Invited? Open your seat here</h3>
        <p>Connect the invited wallet. It owns the seat, sends the 2,000 FMX deposit and is the only wallet that can claim rewards, leave and withdraw. Its key never goes on the validator computer.</p>
        <p class="vp-cta">${connectPrompt("vp-connect-main")}</p>
        <p class="small muted">Not invited? Connect any wallet to join the waitlist below: the entry is signed by the wallet it lists.</p>`;
    case "denied":
      return `<h3 class="vp-h">This wallet cannot hold a seat</h3>
        <div class="alert warn">${esc(REVERT_TEXT.Denied)}</div>
        <p class="small muted">Connect another wallet to open a seat or join the waitlist.</p>`;
    case "not-invited":
      return `<h3 class="vp-h">This wallet is not invited to the pilot</h3>
        <p>During the pilot only wallets the foundation multisig has invited can open a seat${st.hub ? `: ${int(st.hub.occupied)} of ${int(st.hub.maxSeats)} are taken` : ""}. Seats open to everyone after an external audit of the contract.</p>`;
    case "full":
      return `<h3 class="vp-h">Every seat is taken</h3>
        <p>All ${int(st.access?.max ?? PILOT_MAX_SEATS)} seats are in use${st.access?.allowlisted ? ", so even an invited wallet has to wait for one to be released" : ""}. A seat is released when its owner leaves.</p>`;
    case "paused":
      return `<h3 class="vp-h">New seats are paused</h3>
        <p>The foundation multisig has paused new seats for now. Seats that are already open keep running, and nobody's deposit is affected.</p>`;
    case "steps":
      return st.step === 1 ? stepDownload() : st.step === 2 ? stepProof() : st.step === 3 ? stepReview() : stepSeats();
  }
}

function paintWaitlistLead(k: ViewKey) {
  const lead = $("#wl-lead")!;
  lead.textContent = k === "not-invited" ? "Join the waitlist to hear when seats open to more wallets. It does not reserve a seat, and there is nothing to pay."
    : k === "full" ? "Join the waitlist to hear when a seat is free or more seats open. It does not reserve a seat, and there is nothing to pay."
      : "Pilot seats are by invitation. Join the waitlist to hear when seats open to more wallets. It does not reserve a seat, and there is nothing to pay.";
  paintWaitlistWallet();
}

/* ---------------------------------------------------------------- step 1: the app */

function osTabs(): string {
  return `<div class="vp-tabs" role="tablist" aria-label="Your validator computer">${(["windows", "linux"] as Os[]).map((o) => `<button type="button" role="tab" data-os="${o}" aria-selected="${st.os === o}">${o === "windows" ? "Windows" : "Linux"}</button>`).join("")}</div>`;
}

function stepDownload(): string {
  const sums = st.sums;
  const pkgs = PACKAGES.filter((p) => p.os === st.os).map((p) => {
    const sha = sums?.get(p.file);
    return `<li class="vp-pkg">
      <div class="vp-pkg-head"><a class="vp-pkg-link" href="${DOWNLOAD_BASE}${p.file}" download>${esc(p.label)}</a><span class="small faint">${esc(p.sub)}</span></div>
      <div class="vp-sha"><span class="vp-sha-l">SHA-256</span>${sha ? `<code class="mono">${esc(sha)}</code><button class="copy" type="button" data-copy="${esc(sha)}" aria-label="Copy the SHA-256 of ${esc(p.file)}">copy</button>` : `<span class="small faint">${st.sumsErr ? "not published" : "reading…"}</span>`}</div>
    </li>`;
  }).join("");
  const check = st.os === "windows"
    ? code(`Get-FileHash -Algorithm SHA256 .\\${PACKAGES[0].file}`, "checksum")
    : code("sha256sum -c SHA256SUMS --ignore-missing", "checksum");
  const install = st.os === "windows"
    ? `<ol class="vp-list">
        <li>Unzip it to its own folder. Open PowerShell as administrator (Start, type PowerShell, right-click, Run as administrator) in that folder and run:${code("powershell -ExecutionPolicy Bypass -File .\\install.ps1", "install")}</li>
        <li>Choose a password for the attester key. The installer starts the validator as a Windows service and prints the attester address.</li>
        <li>Back up <span class="mono">C:\\ProgramData\\FerminuxValidator\\mainnet\\keys\\attester.json</span> and its password somewhere other than this PC, and send about 1 FMX to the attester address for transaction fees.</li>
      </ol>`
    : `<ol class="vp-list">
        <li>Unpack the one for your server's CPU (<span class="mono">uname -m</span> prints x86_64 or aarch64) and install it as root:${code("tar xzf ferminux-validator-linux-amd64.tar.gz && cd ferminux-validator-linux-amd64 && sudo ./install.sh", "install")}</li>
        <li>It creates the attester key, starts the <span class="mono">fmx-validator</span> service and prints the attester address.</li>
        <li>Back up <span class="mono">/var/lib/fmx-validator/mainnet/keys/attester.json</span> and <span class="mono">/etc/fmx-validator/attester-password</span> somewhere other than this server, and send about 1 FMX to the attester address for transaction fees.</li>
      </ol>`;
  return `<h3 class="vp-h">1. Download the validator app</h3>
    <p>Install it on the computer that will run the seat: a PC or server that stays on. It runs a full Ferminux node and signs checkpoints with its own hot key; your wallet's key never goes there.</p>
    ${osTabs()}
    <ul class="vp-pkgs">${pkgs}</ul>
    ${st.sumsErr ? `<div class="alert info">The pilot release is not published at <span class="mono">ferminux.net${DOWNLOAD_BASE}</span> yet. If the foundation sent you the package, check its SHA-256 against the one in the same message.</div>` : ""}
    <p class="small muted">Check the file before you unpack it: the result must equal the SHA-256 above.${st.os === "windows" ? " The programs are not code-signed yet, so Windows may warn about an unknown publisher; the SHA-256 is how you know the file is ours." : ""} <a class="link-inline" href="${DOWNLOAD_BASE}SHA256SUMS">SHA256SUMS</a> · <a class="link-inline" href="${DOWNLOAD_BASE}BUILDINFO.txt">BUILDINFO.txt</a> (the source commit and how each program was built)</p>
    ${check}
    ${install}
    <div class="vp-actions"><button type="button" class="btn btn-primary" data-act="to-2"${canOpen() ? "" : " disabled"}>It is installed: next</button></div>
    ${canOpen() ? "" : `<p class="small muted">${esc(accessSentence())}</p>`}`;
}

async function loadSums() {
  if (st.sums || st.sumsErr) return;
  try {
    const r = await fetch(`${DOWNLOAD_BASE}SHA256SUMS`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const m = r.ok ? parseSha256Sums(await r.text()) : new Map<string, string>();
    if (!PACKAGES.some((p) => m.has(p.file))) throw new Error("no packages");
    st.sums = m;
  } catch { st.sumsErr = true; }
  if (viewKey() === "steps" && st.step === 1) render();
}

/* ---------------------------------------------------------------- step 2: the seat proof */

function stepProof(): string {
  const owner = st.addr!;
  const hubCmd = st.os === "windows"
    ? `& 'C:\\Program Files\\Ferminux\\fmx-validator.exe' init --hub ${H!.hub}; Restart-Service FerminuxValidator`
    : `sudo fmx-validator init --hub ${H!.hub} && sudo systemctl restart fmx-validator`;
  const proofCmd = st.os === "windows"
    ? `& 'C:\\Program Files\\Ferminux\\fmx-validator.exe' seat-proof --owner ${owner}`
    : `sudo fmx-validator seat-proof --password-file /etc/fmx-validator/attester-password --owner ${owner}`;
  return `<h3 class="vp-h">2. Paste the app's seat proof</h3>
    <p>On the validator computer${st.os === "windows" ? ", in PowerShell as administrator" : ""}, tell the app the contract's address (once), then ask it for the seat proof for your wallet:</p>
    ${osTabs()}
    ${code(hubCmd, "contract address")}
    ${code(proofCmd, "seat proof")}
    <p class="small muted">It prints the attester address and two signatures: public values that tie this attester key and this node to your wallet on this contract. They cannot be used for anything else, and nothing secret leaves the computer.</p>
    <div class="field">
      <label for="vp-proof">Everything it printed</label>
      <textarea id="vp-proof" class="vp-proof" rows="7" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Checked on the hub: … attester 0x… attesterSig 0x… enodePubkey 0x… enodeSig 0x…" aria-describedby="vp-proof-out">${esc(st.proofText)}</textarea>
    </div>
    <div id="vp-proof-out" class="vp-proof-out" aria-live="polite">${proofOutHtml()}</div>
    <div class="vp-actions"><button type="button" class="btn btn-secondary" data-act="to-1">Back</button><button type="button" class="btn btn-primary" data-act="to-3"${proofReady() ? "" : " disabled"}>Review the deposit</button></div>`;
}

const proofReady = () => !!st.checked && same(st.checkedFor, st.addr) && st.keyFree === true && canOpen();
let proofError = "";

function proofOutHtml(): string {
  if (!st.proofText.trim()) return "";
  if (proofError) return `<div class="alert warn">${esc(proofError)}</div>`;
  const c = st.checked;
  if (!c) return "";
  const rows = [
    ["ok", `Made for your wallet ${esc(short(st.addr, 4))} and this contract on chain 3961`],
    ["ok", "The attester key and the node key signed it"],
    st.keyFree === null ? ["", "Checking that the attester key is not used by another seat…"]
      : st.keyFree ? ["ok", "The attester key is not used by any seat yet"] : ["bad", REVERT_TEXT.KeyUsed],
  ];
  const lowFees = st.attesterBal !== null && st.attesterBal < 10n ** 17n;
  return `<p class="vp-attester"><span class="vp-label">Attester</span>${addrLink(c.attester, 6)}</p>
    <p class="small muted">Is this the address the app showed? It signs checkpoints for the seat. Node ${esc(short(c.nodeAddress, 4))}.</p>
    <ul class="vp-checks">${rows.map(([t, s]) => `<li class="${t}"><span class="vp-check-i" aria-hidden="true">${t === "ok" ? "✓" : t === "bad" ? "!" : "…"}</span><span>${s}</span></li>`).join("")}</ul>
    ${lowFees ? `<div class="alert info">The attester key holds ${esc(fmxUnit(st.attesterBal, 4))}. It pays a little FMX in fees to submit checkpoints (about 0.004 FMX a day): send it about 1 FMX. This does not block the deposit.</div>` : ""}`;
}

let proofSeq = 0;
async function onProofInput(text: string) {
  st.proofText = text;
  st.checked = null; st.checkedFor = null; st.keyFree = null; st.attesterBal = null; proofError = "";
  const seq = ++proofSeq;
  if (text.trim()) {
    const p = parseSeatProof(text);
    if (!p.ok) proofError = p.error;
    else {
      const c = checkSeatProof(p.proof, { hub: H!.hub, owner: st.addr! });
      if (!c.ok) proofError = c.error;
      else { st.checked = c.checked; st.checkedFor = st.addr; }
    }
  }
  paintProof();
  if (!st.checked) return;
  const att = st.checked.attester;
  const [ki, bal] = await Promise.allSettled([hubC!.keyInfo(att), readProvider().getBalance(att)]);
  if (seq !== proofSeq) return;
  if (ki.status === "fulfilled") st.keyFree = Number(ki.value[0]) === 0;
  else proofError = "The contract could not be read to check the attester key. Try again in a moment.";
  if (bal.status === "fulfilled") st.attesterBal = bal.value;
  paintProof();
}
function paintProof() {
  const out = $("#vp-proof-out"); if (out) out.innerHTML = proofOutHtml();
  const next = $<HTMLButtonElement>('[data-act="to-3"]'); if (next) next.disabled = !proofReady();
}

/* ---------------------------------------------------------------- step 3: review and deposit */

interface Review { balance: bigint | null; gas: bigint | null; fee: bigint | null; head: number; error: string | null }
let review: Review | null = null;

/** openSeat as the wallet would send it, against the latest block: the custom error by name, or null. */
async function simulate(from: string, c: CheckedProof): Promise<{ error: string | null; gas: bigint | null }> {
  const data = hubIface.encodeFunctionData("openSeat", [c.attester, c.attesterSig, c.enodePubkey, c.enodeSig]);
  const p = readProvider();
  try {
    await p.call({ from, to: H!.hub, value: SEAT_DEPOSIT_WEI, data });
  } catch (e) {
    const err = e as { code?: string; data?: string; message?: string; revert?: { name?: string } };
    const name = revertName(err?.data) ?? err?.revert?.name ?? null;
    if (name && REVERT_TEXT[name]) return { error: REVERT_TEXT[name], gas: null };
    if (/insufficient (funds|balance)/i.test(String(err?.message))) return { error: "This wallet does not hold 2,000 FMX plus the network fee.", gas: null };
    if (err?.code === "CALL_EXCEPTION") return { error: `The contract would refuse this deposit${name ? ` (${name})` : ""}.`, gas: null };
    return { error: "The deposit could not be checked with the contract: the Ferminux RPC did not answer. Try again in a moment.", gas: null };
  }
  const gas = await p.estimateGas({ from, to: H!.hub, value: SEAT_DEPOSIT_WEI, data }).catch(() => null);
  return { error: null, gas };
}

async function loadReview() {
  const c = st.checked!, me = st.addr!;
  review = null; paintReview();
  const p = readProvider();
  const [bal, sim, block] = await Promise.all([getBalance(me).catch(() => null), simulate(me, c), p.getBlock("latest").catch(() => null)]);
  if (!same(me, st.addr) || st.step !== 3) return;
  const base = block?.baseFeePerGas ?? 0n;
  const fee = sim.gas !== null ? sim.gas * (base + 1_000_000_000n) : null;
  // too little FMX makes the simulation fail too: say the plain reason
  const poor = bal !== null && bal < SEAT_DEPOSIT_WEI;
  review = { balance: bal, gas: sim.gas, fee, head: block?.number ?? st.hub?.head ?? 0, error: poor ? `This wallet holds ${fmxUnit(bal, 2)}; the seat needs 2,000 FMX plus the network fee.` : sim.error };
  paintReview();
}

function reviewRows(): string {
  const c = st.checked!, r = review;
  const rows: [string, string][] = [
    ["You send", `<strong class="vp-amount">2,000 FMX</strong><span class="small faint mono"> ${SEAT_DEPOSIT_WEI.toString()} wei, exactly</span>`],
    ["To", `<span class="vp-full"><a class="mono" href="${explorerAddr(H!.hub)}" rel="noopener">${esc(H!.hub)}</a></span><span class="small faint"> ValidatorHub</span>`],
    ["Method", `<code class="mono">openSeat(attester, attesterSig, enodePubkey, enodeSig)</code>`],
    ["Attester", `<span class="vp-full mono">${esc(c.attester)}</span>`],
    ["Node", `<span class="mono" title="${esc(c.enodePubkey)}">${esc(short(c.enodePubkey, 8))}</span>`],
    ["From", `${addrLink(st.addr!, 6)}${r?.balance != null ? `<span class="small faint"> holds ${esc(fmxUnit(r.balance, 2))}</span>` : ""}`],
    ["Network", `Ferminux, chain ${CHAIN_ID}<span class="small faint"> checked in your wallet again right before it signs</span>`],
    ["Network fee", r?.fee != null ? `about ${esc(fmxUnit(r.fee, 6))}` : r ? "—" : `<span class="sk" style="width:40%" aria-hidden="true"></span>`],
    ["Starts", r ? `about 24 hours after the deposit (from block ${int(r.head + 1 + ACTIVATION_DELAY)}), later if 10 seats already start that day; counts toward certification 7 days after it starts` : `<span class="sk" style="width:70%" aria-hidden="true"></span>`],
  ];
  return `<dl class="vp-review">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

function stepReview(): string {
  return `<h3 class="vp-h">3. Review and deposit</h3>
    <p>Your wallet will ask you to sign exactly this. Compare the contract address with the one in your wallet before you confirm.</p>
    <div id="vp-review">${reviewRows()}</div>
    <div id="vp-review-alert"></div>
    <ul class="vp-terms small">
      <li>The 2,000 FMX stays in the contract while the seat runs. To leave, the owner wallet asks to exit; the deposit can be withdrawn 14 days later.</li>
      <li>Downtime never costs the deposit. Running the attester key on two machines at once can cost 200 FMX.</li>
    </ul>
    <label class="wl-check vp-ack"><input type="checkbox" id="vp-ack"><span>I understand the deposit stays in the contract until I leave and wait out the 14-day unbonding.</span></label>
    <div class="vp-actions"><button type="button" class="btn btn-secondary" data-act="to-2">Back</button><button type="button" class="btn btn-primary" id="vp-deposit" disabled>Deposit 2,000 FMX and open the seat</button></div>
    <p class="wl-status" id="vp-deposit-status" role="status" aria-live="polite"></p>`;
}

function paintReview() {
  const box = $("#vp-review"); if (box) box.innerHTML = reviewRows();
  const al = $("#vp-review-alert");
  const r = review;
  let msg = "";
  if (r?.error) msg = r.error;
  else if (r?.balance != null && r.balance < SEAT_DEPOSIT_WEI + (r.fee ?? 0n)) msg = `This wallet holds ${fmxUnit(r.balance, 2)}; the seat needs 2,000 FMX plus the network fee.`;
  if (al) al.innerHTML = msg ? `<div class="alert warn">${esc(msg)}</div>` : "";
  syncDepositButton();
}
function syncDepositButton() {
  const b = $<HTMLButtonElement>("#vp-deposit"), ack = $<HTMLInputElement>("#vp-ack");
  if (!b || b.dataset.busy) return;
  const r = review;
  b.disabled = !(ack?.checked && r && !r.error && !(r.balance != null && r.balance < SEAT_DEPOSIT_WEI + (r.fee ?? 0n)));
}

async function deposit() {
  const b = $<HTMLButtonElement>("#vp-deposit")!, out = $("#vp-deposit-status")!;
  const c = st.checked!, me = st.addr!;
  const busy = (t: string) => { b.dataset.busy = "1"; b.disabled = true; b.textContent = t; };
  const idle = () => { delete b.dataset.busy; b.textContent = "Deposit 2,000 FMX and open the seat"; syncDepositButton(); };
  const say = (html: string, tone = "warn") => { out.className = `wl-status vp-say ${tone}`; out.innerHTML = html; };
  let sent: string | null = null;
  say("", "");
  try {
    busy("Checking your wallet's network…");
    const s = await signer(); // connects if needed and asks the wallet to switch to 3961
    // Right before signing: ask the wallet itself which chain it is on, and which account it will sign with.
    const cid = Number(BigInt(String(await s.provider.send("eth_chainId", []))));
    if (cid !== CHAIN_ID) { say(`Your wallet is on chain ${int(cid)}, not Ferminux (chain ${CHAIN_ID}). Switch it to Ferminux and press the button again. Nothing was sent.`); idle(); return; }
    const from = await s.getAddress();
    if (!same(from, me) || !same(from, st.checkedFor)) { say("The wallet's account changed since the proof was checked. Nothing was sent: check the proof again for this wallet."); idle(); return; }
    busy("Checking the contract…");
    const [sim, bal] = await Promise.all([simulate(from, c), getBalance(from)]);
    if (sim.error) { say(`${esc(sim.error)} Nothing was sent.`); idle(); review = review ? { ...review, error: sim.error } : review; paintReview(); return; }
    if (bal < SEAT_DEPOSIT_WEI) { say(`This wallet holds ${esc(fmxUnit(bal, 2))}; the seat needs 2,000 FMX plus the network fee. Nothing was sent.`); idle(); return; }
    // and once more, immediately before the wallet is asked: a wallet can change networks while we checked
    const cid2 = Number(BigInt(String(await s.provider.send("eth_chainId", []))));
    if (cid2 !== CHAIN_ID) { say(`Your wallet moved to chain ${int(cid2)}. Switch it back to Ferminux (chain ${CHAIN_ID}) and press the button again. Nothing was sent.`); idle(); return; }
    busy("Confirm in your wallet…");
    const hubW = new Contract(H!.hub, HUB_ABI, s);
    // chainId goes into eth_sendTransaction itself, so the wallet refuses the request if it is on another chain by
    // the time it builds the transaction (MetaMask and Ferminux Wallet both check it); the reads above cannot
    // close that window on their own.
    const tx = (await hubW.openSeat(c.attester, c.attesterSig, c.enodePubkey, c.enodeSig, { value: SEAT_DEPOSIT_WEI, chainId: CHAIN_ID })) as ContractTransactionResponse;
    sent = tx.hash;
    busy("Opening the seat…");
    say(`Sent. Waiting for a block (about 7 seconds). <a class="link-inline" href="${explorerTx(tx.hash)}" rel="noopener">The transaction</a>`, "info");
    const rc = (await tx.wait(1)) as TransactionReceipt | null;
    if (!rc || rc.status !== 1) throw new Error("reverted");
    let id = 0;
    for (const l of rc.logs) { try { const ev = hubIface.parseLog({ topics: [...l.topics], data: l.data }); if (ev?.name === "SeatOpened") id = Number(ev.args[0]); } catch { /* another contract's log */ } }
    await opened(id, tx.hash);
  } catch (e) {
    // The transaction may have gone through even though waiting for it failed: the key is then bound to a seat.
    if (sent) {
      const ki = await hubC!.keyInfo(c.attester).catch(() => null);
      if (ki && Number(ki[0]) > 0) { await opened(Number(ki[0]), sent); return; }
    }
    const name = (e as { revert?: { name?: string } })?.revert?.name ?? revertName((e as { data?: string })?.data);
    const text = name && REVERT_TEXT[name] ? `The contract refused the deposit: ${REVERT_TEXT[name]}` : errMessage(e, "The deposit did not go through.");
    say(`${esc(text)}${sent ? ` <a class="link-inline" href="${explorerTx(sent)}" rel="noopener">The transaction</a>` : " Nothing was sent."}`);
    idle();
  }
}

async function opened(id: number, hash: string) {
  st.opened = { id, hash };
  st.checked = null; st.checkedFor = null; st.proofText = ""; st.keyFree = null; review = null;
  toast(id ? `Seat #${id} is open` : "The seat is open");
  const addr = st.addr!;
  const [acc, seats] = await Promise.allSettled([lensC!.seatAccess(addr), readMySeats(addr)]);
  if (acc.status === "fulfilled") st.access = toSeatAccess(acc.value);
  if (seats.status === "fulfilled") st.seats = seats.value;
  loadHub();
  go(4);
}

/* ---------------------------------------------------------------- step 4: live seat status */

let seatHead = 0;
const participation = new Map<number, number>();
function stepSeats(): string {
  const seats = st.seats ?? [];
  const o = st.opened;
  const intro = o ? `<div class="alert ok">Seat${o.id ? ` #${int(o.id)}` : ""} is open. The 2,000 FMX deposit is in the ValidatorHub. <a class="link-inline" href="${explorerTx(o.hash)}" rel="noopener">The transaction</a></div>` : "";
  const cards = seats.length ? seats.map((s) => {
    const ph = seatPhase(s, seatHead || st.hub?.head || 0);
    const part = participation.get(s.id);
    const rows: [string, string][] = [
      ["Attester", addrLink(s.attester, 6)],
      ["Deposit", esc(fmxUnit(s.deposit, 2))],
      ["Rewards to claim", esc(fmxUnit(s.claimable, 4))],
      ...(part !== undefined ? [["Signed, last 124", `${int(part)} of ${int(JAIL_WINDOW)} checkpoints`] as [string, string]] : []),
    ];
    return `<article class="vp-seat" aria-labelledby="seat-${s.id}-h">
      <div class="vp-seat-head"><h4 id="seat-${s.id}-h">Seat #${int(s.id)}</h4>${pill(ph.label, ph.tone)}</div>
      <p class="small">${esc(ph.detail)}</p>
      <dl class="vp-kv">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
      <a class="link-inline small" href="${EXPLORER_SEAT(s.id)}" rel="noopener">Seat #${int(s.id)} on the explorer</a>
    </article>`;
  }).join("") : `<p class="muted">No seat for this wallet yet.</p>`;
  return `<h3 class="vp-h">4. Seat status</h3>
    ${intro}
    <div class="vp-seats">${cards}</div>
    <p class="small faint" id="vp-seat-at">${seatHead ? `Read from the chain at block ${int(seatHead)}; refreshes every 14 seconds.` : ""}</p>
    <div class="vp-actions">${canOpen() ? `<button type="button" class="btn btn-secondary" data-act="another">Open another seat</button>` : ""}</div>
    ${canOpen() ? `<p class="small muted">Each seat needs its own validator app installation with its own key.</p>` : st.access && st.access.reason !== "open" ? `<p class="small muted">${esc(accessSentence())}</p>` : ""}`;
}

let seatTimer = 0, seatPolling = false;
/** Keep step 4 live: one read every 14 s while it is on screen (started by go(4), a reload, or a tab coming back). */
function ensureSeatPoll() { if (!seatTimer && !seatPolling) pollSeats(); }
async function pollSeats() {
  if (seatPolling) return;
  clearTimeout(seatTimer); seatTimer = 0;
  if (!H || !st.addr || viewKey() !== "steps" || st.step !== 4) return;
  seatPolling = true;
  if (document.visibilityState === "visible") {
    const addr = st.addr;
    try {
      const [seats, head] = await Promise.all([readMySeats(addr), readProvider().getBlockNumber()]);
      if (addr !== st.addr) { seatPolling = false; return; } // a new wallet: loadWallet starts over
      st.seats = seats; seatHead = head;
      await Promise.all(seats.filter((s) => s.status === 1 && !s.jailed && s.lastAttestedCp > 0).map(async (s) => {
        try { participation.set(s.id, Number(await hubC!.participation(s.id, JAIL_WINDOW))); } catch { participation.delete(s.id); }
      }));
      if (st.step === 4 && viewKey() === "steps") { const v = $("#vp-view")!; const focusIn = v.contains(document.activeElement); if (!focusIn) { v.innerHTML = stepSeats(); wireView("steps"); } }
    } catch { /* keep the last reading */ }
  }
  seatPolling = false;
  seatTimer = window.setTimeout(pollSeats, 14_000);
}

function accessSentence(): string {
  const a = st.access;
  if (!a) return "";
  return a.reason === "not-invited" ? "This wallet is not invited to the pilot, so it cannot open a seat."
    : a.reason === "full" ? "Every seat is taken right now."
      : a.reason === "paused" ? "New seats are paused right now."
        : a.reason === "denied" ? REVERT_TEXT.Denied : "";
}

/* ---------------------------------------------------------------- wiring */

function wireView(k: ViewKey) {
  const v = $("#vp-view")!;
  $("#vp-connect-main", v)?.addEventListener("click", doConnect);
  $$<HTMLElement>("[data-act]", v).forEach((el) => el.addEventListener("click", () => act(el.dataset.act!)));
  $$<HTMLButtonElement>("[data-os]", v).forEach((b) => b.addEventListener("click", () => { st.os = b.dataset.os as Os; render(); $<HTMLButtonElement>(`[data-os="${st.os}"]`)?.focus(); }));
  if (k !== "steps") return;
  if (st.step === 1) loadSums();
  if (st.step === 4) ensureSeatPoll();
  if (st.step === 2) {
    const ta = $<HTMLTextAreaElement>("#vp-proof", v)!;
    let t = 0;
    ta.addEventListener("input", () => { clearTimeout(t); t = window.setTimeout(() => onProofInput(ta.value), 120); });
    if (st.proofText && !st.checked && !proofError) onProofInput(st.proofText);
  }
  if (st.step === 3) {
    $("#vp-ack", v)?.addEventListener("change", syncDepositButton);
    $("#vp-deposit", v)?.addEventListener("click", deposit);
    loadReview();
  }
}

function act(a: string) {
  if (a === "retry-hub") { st.hubErr = false; render(); loadHub().then(() => loadWallet()); return; }
  if (a === "retry-wallet") { st.accessErr = false; loadWallet(); return; }
  if (a === "to-1") return go(1);
  if (a === "to-2") return go(2);
  if (a === "to-3" && proofReady()) return go(3);
  if (a === "another") { st.opened = null; return go(1); }
}
document.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('#c-body [data-act="retry-hub"]'); if (b) act("retry-hub"); });

async function doConnect(ev: Event) {
  const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
  try { await connect(); } catch (e) { toast(errMessage(e)); } finally { b.disabled = false; }
}

/* ==================================================================== the waitlist (signed) */

const PLATFORM_NAME: Record<string, string> = { windows: "Windows", linux: "Linux", both: "Windows and Linux" };

async function loadCount() {
  const v = $("#v-count"), split = $("#wl-split");
  try {
    const r = await fetch(`${config.gateway}/validators/waitlist/count`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const c = (await r.json()) as { total?: number; seats?: number; byPlatform?: Record<string, number> };
    const total = Number(c.total) || 0, seats = Number(c.seats) || 0, by = c.byPlatform ?? {};
    if (v) v.textContent = plural(total, "sign-up");
    if (split) split.textContent = total
      ? `${plural(total, "address", "addresses")} on the waitlist, ${plural(seats, "seat")} planned · Windows ${int(by.windows ?? 0)} · Linux ${int(by.linux ?? 0)} · both ${int(by.both ?? 0)}`
      : "Nobody has joined yet: be the first.";
  } catch {
    if (v) v.textContent = "—";
    if (split) split.textContent = "";
  }
}

const form = $<HTMLFormElement>("#wl-form")!;
const fields = { seats: $<HTMLSelectElement>("#wl-seats")!, contact: $<HTMLInputElement>("#wl-contact")!, consent: $<HTMLInputElement>("#wl-consent")! };
const wlStatus = $("#wl-status")!;
const wlSubmit = $<HTMLButtonElement>("#wl-submit")!;

function paintWaitlistWallet() {
  const el = $("#wl-wallet")!;
  if (st.addr) el.innerHTML = `<p class="vp-addr"><span class="status-dot ok" aria-hidden="true"></span>${addrLink(st.addr, 6)}</p>`;
  else {
    el.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="wl-connect">Connect a wallet to sign</button>`;
    $("#wl-connect")?.addEventListener("click", doConnect);
  }
}

function values(): WaitlistForm {
  const platform = form.querySelector<HTMLInputElement>('input[name="platform"]:checked')?.value ?? "";
  return { address: st.addr ?? "", platform, seats: fields.seats.value, contact: fields.contact.value, consent: fields.consent.checked };
}
function showErrors(errors: Partial<Record<keyof WaitlistForm, string>>) {
  const map: Record<keyof WaitlistForm, { err: string; input: HTMLElement | null }> = {
    address: { err: "#wl-address-err", input: null },
    platform: { err: "#wl-platform-err", input: null },
    seats: { err: "#wl-seats-err", input: fields.seats },
    contact: { err: "#wl-contact-err", input: fields.contact },
    consent: { err: "#wl-consent-err", input: fields.consent },
  };
  let first: HTMLElement | null = null;
  for (const [k, m] of Object.entries(map) as [keyof WaitlistForm, (typeof map)[keyof WaitlistForm]][]) {
    const e = $(m.err); const msg = errors[k];
    if (e) { e.textContent = msg ?? ""; e.hidden = !msg; }
    if (m.input) { if (msg) m.input.setAttribute("aria-invalid", "true"); else m.input.removeAttribute("aria-invalid"); }
    if (msg && !first) first = m.input ?? (k === "platform" ? form.querySelector<HTMLElement>('input[name="platform"]') : $("#wl-connect") ?? $("#wl-wallet"));
  }
  return first;
}
/** Server errors name a field by code; anything else goes in the status line. */
const FIELD_OF: Record<string, keyof WaitlistForm> = { bad_address: "address", bad_checksum: "address", bad_platform: "platform", bad_seats: "seats", bad_contact: "contact", consent_required: "consent" };
const SIG_TEXT: Record<string, string> = {
  signature_required: "The gateway needs the entry signed by the wallet it lists. Press the button again and approve the signature in your wallet.",
  sig_expired: "The signature expired before it reached the gateway. Press the button again.",
  sig_mismatch: "The signature is not from the wallet shown above. Press the button again and sign with that wallet.",
  bad_sig: "The wallet returned a signature the gateway could not read. Press the button again.",
  bad_nonce: "The signed request was incomplete. Press the button again.",
  bad_expires: "The signed request was incomplete. Press the button again.",
};

function done(state: "added" | "already" | "verified", body: WaitlistBody) {
  form.hidden = true;
  const box = $("#wl-done")!, t = $("#wl-done-t")!, p = $("#wl-done-p")!;
  t.textContent = state === "already" ? "This wallet is already on the waitlist" : "You are on the waitlist";
  const what = `${esc(short(body.address, 4))} · ${plural(body.seats, "seat")} · ${esc(PLATFORM_NAME[body.platform] ?? body.platform)}`;
  p.innerHTML = state === "already"
    ? "The first signed entry for a wallet stands, so nothing was changed. To change it, write to support@ferminux.com from the contact you gave."
    : `<span class="mono">${what}</span> · signed by this wallet<br>${body.contact ? `We will write to ${esc(body.contact)} when seats open to more wallets.` : "You left no contact, so watch this page: new seats and the downloads are announced here."}`;
  box.hidden = false;
  box.focus();
  loadCount();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  wlStatus.textContent = "";
  if (!st.addr) {
    try { await connect(); } catch (err) { showErrors({ address: errMessage(err, "Connect a wallet to sign the entry.") })?.focus(); return; }
  }
  const checked = checkForm(values());
  if (!checked.ok) { showErrors(checked.errors)?.focus(); return; }
  showErrors({});
  const body = checked.body;
  const busy = (t: string) => { wlSubmit.disabled = true; wlSubmit.textContent = t; };
  try {
    busy("Preparing…");
    const cr = await fetch(`${config.gateway}/validators/waitlist/challenge?${challengeQuery(body)}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15000) });
    const cj = (await cr.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!cr.ok) {
      const field = cj.code ? FIELD_OF[cj.code] : undefined;
      if (field) { showErrors({ [field]: cj.error ?? "Check this field." })?.focus(); return; }
      wlStatus.textContent = cr.status === 429 ? "Too many requests from your network. Please try again in a minute." : `Could not start the sign-up (error ${cr.status}). Please try again.`;
      return;
    }
    const ch = checkChallenge(body, cj, Math.floor(Date.now() / 1000));
    if (!ch.ok) { wlStatus.textContent = ch.error; return; }
    busy("Sign in your wallet…");
    const sig = await personalSign(ch.message, body.address);
    busy("Joining…");
    const r = await fetch(`${config.gateway}/validators/waitlist`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ ...body, nonce: ch.nonce, expires: ch.expires, sig }), signal: AbortSignal.timeout(15000) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string; code?: string };
    if (r.ok && j.ok && (j.status === "added" || j.status === "already" || j.status === "verified")) { done(j.status, body); return; }
    const field = j.code ? FIELD_OF[j.code] : undefined;
    if (field) showErrors({ [field]: j.error ?? "Check this field." })?.focus();
    else wlStatus.textContent = j.code && SIG_TEXT[j.code] ? SIG_TEXT[j.code] : r.status === 429 ? "Too many sign-ups from your network in the last hour. Please try again later." : j.error ? `Could not join: ${j.error}` : `Could not join (error ${r.status}). Please try again.`;
  } catch (err) {
    wlStatus.textContent = err instanceof TypeError || (err as Error)?.name === "TimeoutError" ? "The gateway could not be reached. Check your connection and try again." : errMessage(err, "Could not join the waitlist.");
  } finally {
    wlSubmit.disabled = false; wlSubmit.textContent = "Sign and join the waitlist";
  }
});
// clear a field's error as soon as it is edited
for (const el of [fields.seats, fields.contact, fields.consent]) el.addEventListener("input", () => { el.removeAttribute("aria-invalid"); const err = $(`#${el.id}-err`); if (err) err.hidden = true; });
$$<HTMLInputElement>('input[name="platform"]').forEach((r) => r.addEventListener("change", () => { const err = $("#wl-platform-err"); if (err) err.hidden = true; }));
// the entry is signed by the wallet it lists: another wallet means switching accounts in the wallet first
$("#wl-again")?.addEventListener("click", () => {
  form.reset(); form.hidden = false; $("#wl-done")!.hidden = true;
  wlStatus.textContent = "Switch to the other account in your wallet first: each entry is signed by the wallet it lists.";
  fields.seats.focus();
});

/* ==================================================================== the signer set (read from the node) */

async function loadSigners() {
  const el = $("#v-signers"); if (!el) return;
  try {
    const signers = await rpc<string[]>("clique_getSigners");
    if (!Array.isArray(signers) || !signers.length) throw new Error("empty");
    el.innerHTML = `${int(signers.length)} right now, <a class="link-inline" href="/consensus.html#signers">listed on the consensus page</a>`;
  } catch { /* keep the static pointer to the consensus page */ }
}

/* ==================================================================== start */

onWallet((s) => {
  const changed = !same(s.address, st.addr);
  const chainChanged = s.chainId !== st.chainId;
  st.addr = s.address ?? null; st.chainId = s.chainId ?? null;
  if (changed) {
    st.access = null; st.accessErr = false; st.seats = null; st.opened = null; review = null;
    st.checked = null; st.checkedFor = null; st.keyFree = null; st.proofText = ""; proofError = "";
    st.step = 1; participation.clear();
    // a new wallet is a new sign-up: bring the form back
    if (form.hidden) { form.hidden = false; $("#wl-done")!.hidden = true; }
    loadWallet();
    return;
  }
  if (chainChanged) renderWallet();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollSeats(); });
if (H) { loadHub().then(() => { render(); }); setInterval(() => { if (document.visibilityState === "visible") loadHub(); }, 30_000); }
paintChrome();
render();
loadSigners();
loadCount();
