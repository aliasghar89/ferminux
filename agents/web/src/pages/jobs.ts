import { api, jobStatusName } from "../api";
import { config, contractsDeployed } from "../config";
import { dur, esc, fmxUnit, int, pretty, short, timeHtml, toSec } from "../format";
import { $, addrHtml, connectPrompt, hashHtml, initChrome, pillFor, ratingInput, setBusy, skel, toast, txHtml, wireTabs } from "../ui";
import { connect, errMessage, getCredits, onWallet, sendTx, walletState } from "../wallet";
import type { JobView } from "../types";

initChrome({ banner: true });

const view = $("#jobs-view")!, creditsBox = $("#credits-box")!;
let mode: "client" | "owner" = (new URLSearchParams(location.search).get("as") === "owner") ? "owner" : "client";
// undefined, not null: the first onWallet call (address null when no wallet) must still render the connect state.
let current: string | null | undefined = undefined;
let refocusTab = false;

onWallet((s) => {
  if (s.address !== current) { current = s.address; s.address ? load(s.address) : renderEmpty(); }
});

function renderEmpty() {
  creditsBox.innerHTML = "";
  view.innerHTML = `<div class="empty"><h3>Connect a wallet to see your jobs</h3><p>Jobs are looked up by address: as a client (jobs you paid for) and as an agent owner (jobs your agents received).</p>${connectPrompt("jobs-connect")}</div>`;
  $("#jobs-connect")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(b, false); } });
}

async function loadCredits(addr: string) {
  creditsBox.innerHTML = `<div class="panel" style="min-width:220px;max-width:360px"><div class="panel-body" style="padding:12px 16px;gap:6px"><span class="lb-label">Withdrawable credits</span><strong class="lb-value" style="font-size:20px">${skel("60%")}</strong></div></div>`;
  try {
    const c = await getCredits(addr);
    creditsBox.innerHTML = `<div class="panel" style="min-width:220px;max-width:360px"><div class="panel-body" style="padding:12px 16px;gap:8px"><span class="lb-label">Withdrawable credits</span><strong class="lb-value" style="font-size:20px">${fmxUnit(c)}</strong><button class="btn btn-secondary btn-sm" type="button" id="withdraw" ${c === 0n ? "disabled" : ""}>Withdraw to wallet</button><span class="small faint">Payouts, refunds and resolutions accrue here (pull payments).</span></div></div>`;
    $("#withdraw")?.addEventListener("click", async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Confirm…");
      try { const r = await sendTx((k) => k.escrow.withdraw()); toast("Withdrawn"); say(`Withdrew ${fmxUnit(c)} — ${txHtml(r.hash, "transaction")}.`, "ok"); loadCredits(addr); }
      catch (e) { say(esc(errMessage(e)), "warn"); setBusy(b, false); }
    });
  } catch (e) {
    creditsBox.innerHTML = `<div class="panel" style="min-width:220px;max-width:360px"><div class="panel-body" style="padding:12px 16px;gap:6px"><span class="lb-label">Withdrawable credits</span><span class="small" style="color:var(--warn)">${esc(contractsDeployed ? errMessage(e) : "Escrow not deployed yet.")}</span></div></div>`;
  }
}

const say = (m: string, k: "" | "warn" | "ok" | "info" = "") => { const s = $("#jobs-status"); if (s) s.innerHTML = m ? `<div class="alert ${k}">${m}</div>` : ""; };

async function load(addr: string) {
  loadCredits(addr);
  view.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Role" id="jobs-tabs">
      <button class="tab" role="tab" id="t-client" aria-selected="${mode === "client"}" aria-controls="tp">As client</button>
      <button class="tab" role="tab" id="t-owner" aria-selected="${mode === "owner"}" aria-controls="tp">As agent owner</button>
    </div>
    <p class="result-count" id="jobs-count" role="status"></p>
    <div id="tp" role="tabpanel" aria-labelledby="${mode === "client" ? "t-client" : "t-owner"}"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Job</th><th scope="col">Agent</th><th scope="col">${mode === "client" ? "Delivered" : "Client"}</th><th scope="col" class="r">Amount</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col" class="r">Actions</th></tr></thead><tbody id="jobs-rows">${Array(4).fill(`<tr aria-hidden="true"><td>${skel("40%")}</td><td>${skel("50%")}</td><td>${skel("60%")}</td><td class="r">${skel("50%")}</td><td>${skel("50%")}</td><td>${skel("50%")}</td><td></td></tr>`).join("")}</tbody></table></div></div>
    <div id="jobs-status" role="status" aria-live="polite" style="margin-top:12px"></div>`;
  $("#t-client")!.addEventListener("click", () => { mode = "client"; history.replaceState(null, "", "?as=client"); load(addr); });
  $("#t-owner")!.addEventListener("click", () => { mode = "owner"; history.replaceState(null, "", "?as=owner"); load(addr); });
  // an arrow key re-renders the list through the click handler, so focus is put back on the new tab
  wireTabs($("#jobs-tabs"), (t) => { refocusTab = true; t.click(); });
  if (refocusTab) { refocusTab = false; $(`#t-${mode}`)?.focus(); }
  const rows = $("#jobs-rows")!, count = $("#jobs-count")!;
  try {
    const { items } = await api.jobs(mode === "client" ? { client: addr } : { agentOwner: addr });
    items.sort((a, b) => (toSec(b.createdAt) ?? 0) - (toSec(a.createdAt) ?? 0));
    count.textContent = `${int(items.length)} job${items.length === 1 ? "" : "s"} ${mode === "client" ? "requested by" : "received by agents of"} ${short(addr)}`;
    rows.innerHTML = items.length ? items.map((j) => row(j, addr)).join("") : `<tr><td colspan="7"><div class="empty"><h3>No jobs ${mode === "client" ? "requested" : "received"} yet</h3>${mode === "client" ? `<a href="/agents/" style="text-decoration:underline">Browse agents</a> to hire one.` : `Jobs for agents owned by this wallet appear here. <a href="/register/" style="text-decoration:underline">Register an agent</a>.`}</div></td></tr>`;
    rows.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => b.addEventListener("click", () => act(b, items, addr)));
    rows.querySelectorAll<HTMLButtonElement>("button[data-toggle]").forEach((b) => b.addEventListener("click", () => toggleDetail(b, items)));
  } catch (e) {
    rows.innerHTML = `<tr><td colspan="7"><div class="alert warn">Could not load jobs: ${esc((e as Error).message)}</div></td></tr>`; count.textContent = "";
  }
}

function row(j: JobView, addr: string): string {
  const s = jobStatusName(j.status); const now = Date.now() / 1000;
  const created = toSec(j.createdAt) ?? now, delivered = toSec(j.deliveredAt);
  const acts: string[] = [];
  const b = (act: string, label: string, cls = "btn-secondary", disabled = false, title = "") => `<button class="btn ${cls} btn-xs" type="button" data-act="${act}" data-id="${j.id}" ${disabled ? "disabled" : ""} ${title ? `title="${esc(title)}"` : ""}>${label}</button>`;
  if (mode === "client" && j.client.toLowerCase() === addr.toLowerCase()) {
    if (s === "Open") { const ready = created + config.deliveryWindowSec; acts.push(b("refund", "Refund", "btn-secondary", now < ready, now < ready ? `Available in ${dur(ready - now)} if not delivered` : "")); }
    if (s === "Delivered") {
      const end = (delivered ?? now) + config.reviewWindowSec; const late = now >= end;
      acts.push(b("release", "Release", "btn-accent"), b("dispute", "Dispute", "btn-danger", late, late ? "Review window has passed" : ""));
    }
  } else if (mode === "owner") {
    if (s === "Open") acts.push(b("cancel", "Cancel", "btn-danger", false, "Decline the job and refund the client"));
    if (s === "Delivered") { const ready = (delivered ?? now) + config.reviewWindowSec; acts.push(b("claim", "Claim", "btn-accent", now < ready, now < ready ? `Claimable in ${dur(ready - now)} unless the client acts` : "")); }
  }
  acts.push(`<button class="btn btn-secondary btn-xs" type="button" data-toggle="${j.id}" aria-expanded="false" aria-controls="jd-${j.id}">Details</button>`);
  return `<tr id="jr-${j.id}"><td class="num" data-l="Job">#${j.id}</td>
    <td data-l="Agent"><a href="/agents/?id=${j.agentId}">${esc(j.agentName || `Agent #${j.agentId}`)}</a> <span class="faint small num">#${j.agentId}</span></td>
    <td data-l="${mode === "client" ? "Delivered" : "Client"}">${mode === "client" ? timeHtml(j.deliveredAt) : addrHtml(j.client)}</td>
    <td class="r num" data-l="Amount">${fmxUnit(j.amount)}</td><td data-l="Status">${pillFor(s)}</td><td data-l="Created">${timeHtml(j.createdAt)}</td>
    <td class="r" data-l="Actions"><div class="actions">${acts.join("")}</div></td></tr>
    <tr id="jd-${j.id}" hidden><td colspan="7" style="background:var(--surface)"><div id="jdb-${j.id}"></div></td></tr>`;
}

async function toggleDetail(b: HTMLButtonElement, items: JobView[]) {
  const id = Number(b.dataset.toggle), j = items.find((x) => x.id === id)!; const tr = $(`#jd-${id}`) as HTMLTableRowElement, body = $(`#jdb-${id}`)!;
  const open = tr.hidden; tr.hidden = !open; b.setAttribute("aria-expanded", String(open)); b.textContent = open ? "Hide" : "Details";
  if (!open || body.innerHTML) return;
  const s = jobStatusName(j.status);
  body.innerHTML = `<dl class="kv" style="font-size:13.5px">
    <div class="kv-row"><dt>Status</dt><dd>${pillFor(s)} ${j.deliveredAt ? `· delivered ${timeHtml(j.deliveredAt)}` : ""}</dd></div>
    <div class="kv-row"><dt>Input</dt><dd>${hashHtml(j.inputHash)} <button class="btn btn-secondary btn-xs" type="button" data-load="in">Show input</button></dd></div>
    <div class="kv-row"><dt>Output</dt><dd>${j.outputHash ? `${hashHtml(j.outputHash)} <button class="btn btn-secondary btn-xs" type="button" data-load="out">Show output</button>` : `<span class="faint">not delivered</span>`}</dd></div>
    <div class="kv-row"><dt>Transactions</dt><dd class="txlog">${j.tx?.requested ? `<div>Request ${txHtml(j.tx.requested, "")}</div>` : ""}${j.tx?.delivered ? `<div>Delivery ${txHtml(j.tx.delivered, "")}</div>` : ""}${j.tx?.closed ? `<div>Closed ${txHtml(j.tx.closed, "")}</div>` : ""}${!j.tx?.requested && !j.tx?.delivered && !j.tx?.closed ? `<span class="faint">—</span>` : ""}</dd></div>
    <div class="kv-row"><dt>Client</dt><dd>${addrHtml(j.client, { n: 8 })}</dd></div>
  </dl><div id="jp-${id}" style="margin-top:10px"></div>`;
  body.querySelectorAll<HTMLButtonElement>("button[data-load]").forEach((lb) => lb.addEventListener("click", async () => {
    const which = lb.dataset.load; const target = $(`#jp-${id}`)!; setBusy(lb, true, "Loading…");
    try { const { text } = await api.payloadText((which === "in" ? j.inputURI || j.inputHash : j.outputURI || j.outputHash) || ""); target.innerHTML = `<div class="code-block"><div class="code-head"><span>${which === "in" ? "Input" : "Output"}</span></div><pre class="light" style="border:0;border-radius:0;max-height:320px">${esc(pretty(text))}</pre></div>`; }
    catch (e) { target.innerHTML = `<div class="alert warn">${esc((e as Error).message)}</div>`; }
    finally { setBusy(lb, false); }
  }));
}

async function act(b: HTMLButtonElement, items: JobView[], addr: string) {
  const id = Number(b.dataset.id), j = items.find((x) => x.id === id)!; const a = b.dataset.act;
  let run: ((c: { escrow: any }) => Promise<any>) | null = null; let label = "";
  if (a === "release") {
    // inline rating picker
    const cell = b.parentElement!; if (cell.querySelector(".rating")) return;
    const wrap = document.createElement("div"); wrap.className = "rating-row"; wrap.style.width = "100%"; wrap.innerHTML = `<span>Rate</span><span class="r-in"></span><button class="btn btn-accent btn-xs" type="button">Confirm release</button><button class="btn btn-secondary btn-xs" type="button">Back</button>`;
    cell.appendChild(wrap); b.hidden = true;
    const get = ratingInput(wrap.querySelector(".r-in") as HTMLElement, 5);
    const [ok, back] = Array.from(wrap.querySelectorAll("button")) as HTMLButtonElement[];
    back.addEventListener("click", () => { wrap.remove(); b.hidden = false; });
    ok.addEventListener("click", async () => {
      setBusy(ok, true, "Confirm…"); say("");
      try { const r = await sendTx((c) => c.escrow.release(id, get()), (ph, hash) => { if (ph === "pending") say(`Release sent. ${txHtml(hash)}`, "info"); }); say(`Job #${id} released with rating ${get()} — ${txHtml(r.hash, "transaction")}.`, "ok"); setTimeout(() => load(addr), 9000); wrap.remove(); $(`#jr-${id} td:nth-child(5)`)!.innerHTML = pillFor("Completed"); }
      catch (e) { say(esc(errMessage(e)), "warn"); setBusy(ok, false); }
    });
    return;
  }
  if (a === "dispute") { if (!confirm(`Dispute job #${id}? This freezes the ${fmxUnit(j.amount)} escrow. To have it decided, either party then opens a case in the ArbiterPool (1 FMX fee, via the SDK or MCP; see /disputes/). Staked arbiters vote a split; a case with no votes closes 50/50 after the 3-day window — and while no arbiters are staked, that is the outcome.`)) return; run = (c) => c.escrow.dispute(id); label = "Disputed"; }
  if (a === "refund") { run = (c) => c.escrow.refund(id); label = "Refunded to your credits"; }
  if (a === "cancel") { if (!confirm(`Cancel job #${id}? The client is refunded and this counts as a failed job on the agent's record.`)) return; run = (c) => c.escrow.cancel(id); label = "Cancelled; client refunded"; }
  if (a === "claim") { run = (c) => c.escrow.claim(id); label = "Claimed to your credits"; }
  if (!run) return;
  setBusy(b, true, "Confirm…"); say("");
  try {
    const r = await sendTx(run, (ph, hash) => { if (ph === "pending") say(`Transaction sent, waiting for a block. ${txHtml(hash)}`, "info"); });
    say(`Job #${id}: ${label} — ${txHtml(r.hash, "transaction")}. Credits update after the next block.`, "ok");
    setTimeout(() => load(addr), 9000);
  } catch (e) { say(esc(errMessage(e)), "warn"); setBusy(b, false); }
}
