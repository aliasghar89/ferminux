import { STREAM_PAY_ABI } from "../abi";
import { api } from "../api";
import { config, streamsDeployed } from "../config";
import { economy } from "../economy";
import { dur, esc, fmxUnit, int, timeHtml, toWei } from "../format";
import { $, authorHtml, initChrome, setBusy, skel, toast, txHtml } from "../ui";
import { agentSelect } from "../commons";
import { connect, contractWrite, errMessage, onWallet, sendCall, walletState, type TxPhase } from "../wallet";
import { mountCredits } from "../credits";
import type { AgentView, PlanView, StreamView, SubView } from "../types";

initChrome();
const view = $("#view")!;
let current: string | null = null;
let tab: "streams" | "subs" | "plans" = "streams";

render();
function render() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Streams &amp; subscriptions</h1><p>Pay per second while an agent works, or subscribe to a recurring plan. The payee claims what has accrued; the rest stays in the deposit and can be cancelled back to you.</p></div></div>
    </section>
    ${!streamsDeployed ? `<div class="alert" style="margin-bottom:20px">StreamPay is not deployed yet. Browsing plans works; opening streams and subscribing will be enabled once its address is published here.</div>` : ""}
    <div class="section-head"><h3>Plans you can subscribe to</h3></div>
    <div class="rows" id="s-allplans" style="margin-bottom:32px"></div>
    <div id="s-notice" role="status" aria-live="polite"></div>
    <div id="s-mine"></div>
    <div id="s-credits" style="margin-top:24px"></div>
    <div style="height:48px"></div>`;
  view.setAttribute("aria-busy", "false");
  loadAllPlans();
  onWallet((s) => { if (s.address !== current) { current = s.address; $("#s-notice")!.innerHTML = ""; if (s.address) { loadMine(s.address); mountCredits($("#s-credits"), "streamPay", s.address); } else { renderMineEmpty(); $("#s-credits")!.innerHTML = ""; } } });
}
/** Persistent notice above the tabs — the tab panel is re-rendered after every write, which used to wipe the confirmation. */
const notice = (html: string, kind: "ok" | "warn" | "info" = "ok") => { const n = $("#s-notice"); if (n) n.innerHTML = html ? `<div class="alert ${kind}" style="margin-bottom:16px">${html}</div>` : ""; };
const phaseTo = (btn: HTMLButtonElement) => (ph: TxPhase) => { if (ph === "pending") setBusy(btn, true, "Waiting for a block…"); else if (ph === "indexing") setBusy(btn, true, "Indexing…"); };

async function loadAllPlans() {
  const box = $("#s-allplans")!;
  box.innerHTML = Array.from({ length: 2 }, () => `<div class="row" aria-hidden="true"><div class="row-main">${skel("50%")}</div></div>`).join("");
  try {
    const { items } = await economy.allPlans();
    box.innerHTML = items.length ? items.map(planRow).join("") : `<div class="empty" style="border:0"><h3>No active plans</h3>Create one below once you're connected.</div>`;
    box.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((b) => b.addEventListener("click", () => doSubscribe(b, Number(b.dataset.sub))));
    fillPlanNames(box, items);
  } catch (e) { box.innerHTML = `<div class="alert warn" style="border:0;border-radius:0">Could not load plans: ${esc(errMessage(e))}</div>`; }
}
/** Plans created on this page keep their name in a gateway payload; show it once it loads. */
function fillPlanNames(root: HTMLElement, items: PlanView[]) {
  for (const p of items) economy.planName(p.metadataURI).then((name) => { const el = root.querySelector<HTMLElement>(`[data-plan-name="${p.id}"]`); if (el && name) el.textContent = name; }).catch(() => {});
}
function planRow(p: PlanView): string {
  return `<div class="row"><div class="row-main">
      <div class="row-title"><span data-plan-name="${p.id}">Plan #${p.id}</span>${p.metadataURI && /^https?:\/\//.test(p.metadataURI) ? ` <a class="small faint" href="${esc(p.metadataURI)}" rel="noopener" style="font-weight:400;text-decoration:underline">details</a>` : ""}</div>
      <div class="row-meta">${authorHtml(p.payee, { link: false })} <span class="sep">·</span> every ${esc(dur(p.period))}${p.activeSubs !== undefined ? ` <span class="sep">·</span> ${int(p.activeSubs)} subscriber${p.activeSubs === 1 ? "" : "s"}` : ""}</div>
    </div>
    <div class="row-side"><span class="big num">${fmxUnit(p.pricePerPeriod, 3)}</span><span class="sub">per period</span>
      <div class="form-row" style="margin-top:6px;grid-template-columns:60px auto"><input type="number" min="1" step="1" value="1" id="periods-${p.id}" class="num" style="height:30px;padding:0 8px" aria-label="Periods"><button class="btn btn-primary btn-sm" type="button" data-sub="${p.id}">Subscribe</button></div>
    </div></div>`;
}
async function doSubscribe(btn: HTMLButtonElement, planId: number) {
  if (!walletState().address) { setBusy(btn, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(btn, false); return; } setBusy(btn, false); }
  const periods = Math.max(1, Number((document.getElementById(`periods-${planId}`) as HTMLInputElement)?.value || 1));
  setBusy(btn, true, "Confirm in wallet…");
  try {
    const { items } = await economy.allPlans(); const p = items.find((x) => x.id === planId);
    if (!p) throw new Error("Plan not found.");
    const value = BigInt(p.pricePerPeriod) * BigInt(periods);
    if (walletState().address && p.payee.address.toLowerCase() === walletState().address!.toLowerCase()) throw new Error("This is your own plan — you cannot subscribe to yourself.");
    let hash: string | null = null;
    if (config.mock) { await economy.mockSubscribe(planId, periods); }
    else { if (!streamsDeployed) throw new Error("StreamPay is not deployed yet."); const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "subscribe", [planId, periods], { value }, phaseTo(btn))).hash; }
    toast("Subscribed"); tab = "subs"; notice(`Subscribed to plan #${planId} for ${periods} period${periods === 1 ? "" : "s"} (${fmxUnit(value, 4)})${hash ? ` — ${txHtml(hash, "transaction")}` : ""}.`);
    if (current) loadMine(current); loadAllPlans();
  } catch (e) { toast(errMessage(e)); notice(esc(errMessage(e)), "warn"); }
  finally { setBusy(btn, false); }
}

function renderMineEmpty() {
  $("#s-mine")!.innerHTML = `<div class="empty"><h3>Connect a wallet</h3>See your open streams, subscriptions, and any plans you sell.<br><button class="btn btn-primary" type="button" id="s-connect">Connect wallet</button></div>`;
  $("#s-connect")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(b, false); } });
}

async function loadMine(addr: string) {
  const box = $("#s-mine")!;
  box.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Your streams">
      <button class="tab" role="tab" id="t-streams" aria-selected="${tab === "streams"}">My streams</button>
      <button class="tab" role="tab" id="t-subs" aria-selected="${tab === "subs"}">My subscriptions</button>
      <button class="tab" role="tab" id="t-plans" aria-selected="${tab === "plans"}">My plans</button>
    </div>
    <div id="s-tabpanel">${skel("60%")}</div>`;
  $("#t-streams")!.addEventListener("click", () => { tab = "streams"; loadMine(addr); });
  $("#t-subs")!.addEventListener("click", () => { tab = "subs"; loadMine(addr); });
  $("#t-plans")!.addEventListener("click", () => { tab = "plans"; loadMine(addr); });
  const panel = $("#s-tabpanel")!;
  try {
    if (tab === "streams") {
      const { items } = await economy.myStreams(addr);
      panel.innerHTML = items.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Id</th><th scope="col">Counterparty</th><th scope="col" class="r">Rate / day</th><th scope="col" class="r">Deposit</th><th scope="col" class="r">Claimable</th><th scope="col">Status</th><th scope="col" class="r">Actions</th></tr></thead><tbody>${items.map((s) => streamRow(s, addr)).join("")}</tbody></table></div>` : `<div class="empty"><h3>No streams yet</h3>Open one below.</div>`;
      panel.insertAdjacentHTML("beforeend", openStreamFormHtml());
      wireOpenStream(addr);
      panel.querySelectorAll<HTMLButtonElement>("[data-claim]").forEach((b) => b.addEventListener("click", () => claimStream(b, Number(b.dataset.claim), addr)));
      panel.querySelectorAll<HTMLButtonElement>("[data-cancel-stream]").forEach((b) => b.addEventListener("click", () => cancelStream(b, Number(b.dataset.cancelStream), addr)));
    } else if (tab === "subs") {
      const { items } = await economy.mySubs(addr);
      panel.innerHTML = items.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Plan</th><th scope="col">Paid through</th><th scope="col">Status</th><th scope="col" class="r">Actions</th></tr></thead><tbody>${items.map(subRow).join("")}</tbody></table></div>` : `<div class="empty"><h3>No subscriptions yet</h3>Pick a plan above.</div>`;
      panel.querySelectorAll<HTMLButtonElement>("[data-cancel-sub]").forEach((b) => b.addEventListener("click", () => cancelSub(b, Number(b.dataset.cancelSub), addr)));
    } else {
      const { items } = await economy.myPlans(addr);
      panel.innerHTML = (items.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Plan</th><th scope="col" class="r">Price / period</th><th scope="col">Period</th><th scope="col">Active</th><th scope="col" class="r">Subscribers</th><th scope="col" class="r">Actions</th></tr></thead><tbody>${items.map((p) => myPlanRow(p, addr)).join("")}</tbody></table></div>` : `<div class="empty"><h3>No plans yet</h3>Create one below to sell a recurring subscription.</div>`) + createPlanFormHtml();
      fillPlanNames(panel, items);
      panel.querySelectorAll<HTMLButtonElement>("[data-plan-active]").forEach((b) => b.addEventListener("click", () => togglePlanActive(b, Number(b.dataset.planActive), b.dataset.to === "1", addr)));
      wireCreatePlan(addr);
    }
  } catch (e) { panel.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
}

function streamRow(s: StreamView, me: string) {
  const mine = s.payer.address.toLowerCase() === me.toLowerCase();
  const counterparty = mine ? s.payee : s.payer;
  return `<tr>
    <td class="num" data-l="Id">#${s.id}</td>
    <td data-l="Counterparty">${authorHtml(counterparty)} <span class="small faint">(${mine ? "you pay" : "pays you"})</span></td>
    <td class="r num" data-l="Rate / day">${fmxUnit((BigInt(s.ratePerSec) * 86400n).toString(), 3)}</td>
    <td class="r num" data-l="Deposit">${fmxUnit(s.deposit, 3)}${BigInt(s.claimed || "0") > 0n ? `<div class="small faint">${fmxUnit(s.claimed, 4)} claimed</div>` : ""}</td>
    <td class="r num" data-l="Claimable">${fmxUnit(s.claimableWei ?? claimable(s), 4)}</td>
    <td data-l="Status">${s.cancelled ? `<span class="pill warn">cancelled</span>` : Date.now() / 1000 > Number(s.stop) ? `<span class="pill">exhausted</span>` : `<span class="pill ok">active</span>`}</td>
    <td class="r" data-l="Actions"><div class="actions">${!mine && !s.cancelled && BigInt(s.claimableWei ?? claimable(s)) > 0n ? `<button class="btn btn-secondary btn-xs" type="button" data-claim="${s.id}">Claim</button>` : ""}${!s.cancelled && Date.now() / 1000 <= Number(s.stop) ? `<button class="btn btn-danger btn-xs" type="button" data-cancel-stream="${s.id}">Cancel</button>` : ""}</div></td>
  </tr>`;
}
function claimable(s: StreamView): bigint {
  const now = Date.now() / 1000;
  const elapsed = BigInt(Math.max(0, Math.floor(Math.min(now, Number(s.stop))) - Number(s.start)));
  const accrued = elapsed * BigInt(s.ratePerSec);
  const c = accrued - BigInt(s.claimed);
  return c > 0n ? c : 0n;
}
function subRow(s: SubView) {
  const active = !s.cancelled && Number(s.paidThrough) > Date.now() / 1000;
  return `<tr><td data-l="Plan">Plan #${s.planId}${s.payee ? ` · ${authorHtml(s.payee, { link: false })}` : ""}${s.pricePerPeriod ? ` <span class="small faint num">${fmxUnit(s.pricePerPeriod, 3)}${s.period ? ` / ${esc(dur(s.period))}` : ""}</span>` : ""}</td><td data-l="Paid through">${timeHtml(s.paidThrough)}</td><td data-l="Status">${s.cancelled ? `<span class="pill warn">cancelled</span>` : active ? `<span class="pill ok">active</span>` : `<span class="pill">expired</span>`}</td><td class="r" data-l="Actions">${!s.cancelled ? `<button class="btn btn-danger btn-xs" type="button" data-cancel-sub="${s.id}">Cancel</button>` : ""}</td></tr>`;
}
/**
 * Owner-only row. A plan's payee is the only address StreamPay lets call setPlanActive, so the
 * Deactivate / Reactivate control is rendered only when the connected wallet is that payee — every
 * other viewer sees the status pill and nothing to press. Deactivating stops new subscribers;
 * existing subscriptions keep running until they expire or are cancelled.
 */
function myPlanRow(p: PlanView, me: string): string {
  const mine = !!me && p.payee.address.toLowerCase() === me.toLowerCase();
  const action = mine
    ? `<button class="btn ${p.active ? "btn-secondary" : "btn-primary"} btn-xs" type="button" data-plan-active="${p.id}" data-to="${p.active ? "0" : "1"}">${p.active ? "Deactivate" : "Reactivate"}</button>`
    : `<span class="faint small">payee only</span>`;
  return `<tr><td data-l="Plan"><span data-plan-name="${p.id}">Plan #${p.id}</span></td><td class="r num" data-l="Price">${fmxUnit(p.pricePerPeriod, 3)}</td><td data-l="Period">${esc(dur(p.period))}</td><td data-l="Active">${p.active ? `<span class="pill ok">active</span>` : `<span class="pill">paused</span>`}</td><td class="r num" data-l="Subscribers">${int(p.activeSubs ?? 0)}</td><td class="r" data-l="Actions"><div class="actions">${action}</div></td></tr>`;
}
async function togglePlanActive(btn: HTMLButtonElement, planId: number, active: boolean, addr: string) {
  const { items } = await economy.myPlans(addr).catch(() => ({ items: [] as PlanView[] }));
  const plan = items.find((x) => x.id === planId);
  if (!plan || plan.payee.address.toLowerCase() !== addr.toLowerCase()) { toast("Only the plan's payee can change that."); return; }
  if (active === false && !confirm("Deactivate this plan? No new subscribers can join. Subscriptions already running are untouched and keep paying you until they expire.")) return;
  setBusy(btn, true, "Confirm in wallet…");
  try {
    let hash: string | null = null;
    if (config.mock) { await economy.mockSetPlanActive(planId, active); }
    else { if (!streamsDeployed) throw new Error("StreamPay is not deployed yet."); const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "setPlanActive", [planId, active], {}, phaseTo(btn))).hash; }
    toast(active ? "Plan reactivated" : "Plan deactivated");
    notice(`Plan #${planId} is now ${active ? "active and taking new subscribers" : "paused — it no longer takes new subscribers, and the subscriptions already running keep paying you until they expire"}${hash ? ` — ${txHtml(hash, "transaction")}` : ""}.`);
    loadMine(addr); loadAllPlans();
  } catch (e) { toast(errMessage(e)); notice(esc(errMessage(e)), "warn"); setBusy(btn, false); }
}

function openStreamFormHtml() {
  return `<div class="panel composer" style="margin-top:20px"><div class="panel-head"><h3>Open a stream</h3></div><div class="panel-body">
    <div class="form-row">
      <div class="field"><label for="os-agent">Pay to (agent)</label><div id="os-agent-wrap"><select id="os-agent"><option>Loading…</option></select></div></div>
      <div class="field"><label for="os-rate">Rate (FMX / day)</label><input type="number" id="os-rate" min="0" step="0.01" class="num" placeholder="0.5"></div>
    </div>
    <div class="field"><label for="os-dep">Deposit (FMX)</label><input type="number" id="os-dep" min="0" step="0.01" class="num" placeholder="5"></div>
    <div id="os-status"></div>
    <button class="btn btn-primary" type="button" id="os-open" style="width:auto">Open stream</button>
  </div></div>`;
}
async function wireOpenStream(addr: string) {
  const sel = $("#os-agent") as HTMLSelectElement | null; if (!sel) return;
  try { const { items } = await api.agents({ status: "active", limit: 100 }); sel.outerHTML = agentSelect("os-agent", items as AgentView[]); }
  catch { /* keep loading state */ }
  $("#os-open")!.addEventListener("click", async () => {
    const btn = $("#os-open") as HTMLButtonElement, status = $("#os-status")!;
    const rate = ($("#os-rate") as HTMLInputElement).value.trim(), dep = ($("#os-dep") as HTMLInputElement).value.trim();
    const agentSel = $("#os-agent") as HTMLSelectElement;
    if (!rate || Number(rate) <= 0 || !dep || Number(dep) <= 0) { status.innerHTML = `<div class="alert warn">Enter a rate and a deposit.</div>`; return; }
    setBusy(btn, true, "Confirm in wallet…");
    try {
      const { items } = await api.agents({ status: "active", limit: 100 });
      const agent = (items as AgentView[]).find((a) => String(a.id) === agentSel.value);
      if (!agent) throw new Error("Pick an agent.");
      const ratePerSec = toWei(rate) / 86400n;
      if (ratePerSec === 0n) throw new Error("The rate is too small — it rounds to zero wei per second.");
      if (toWei(dep) < ratePerSec) throw new Error("The deposit must cover at least one second at that rate.");
      if (agent.owner.toLowerCase() === addr.toLowerCase()) throw new Error("That agent is yours — you cannot stream to your own address.");
      let hash: string | null = null;
      if (config.mock) { await economy.mockOpenStream(agent.owner, ratePerSec.toString(), toWei(dep).toString()); }
      else { if (!streamsDeployed) throw new Error("StreamPay is not deployed yet."); const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "openStream", [agent.owner, ratePerSec], { value: toWei(dep) }, phaseTo(btn))).hash; }
      toast("Stream opened"); notice(`Stream opened to ${esc(agent.name)}: ${esc(rate)} FMX / day, ${esc(dep)} FMX deposited (runs about ${esc(dur(Number(toWei(dep) / ratePerSec)))})${hash ? ` — ${txHtml(hash, "transaction")}` : ""}.`); loadMine(addr);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
}
async function claimStream(btn: HTMLButtonElement, id: number, addr: string) {
  setBusy(btn, true, "Confirm…");
  try {
    let hash: string | null = null;
    if (config.mock) { await economy.mockClaimStream(id); }
    else { if (!streamsDeployed) throw new Error("StreamPay is not deployed yet."); const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "claimStream", [id], {}, phaseTo(btn))).hash; }
    toast("Claimed"); notice(`Claimed stream #${id}${hash ? ` — ${txHtml(hash, "transaction")}` : ""}. The FMX is credited inside StreamPay: withdraw it from the credits panel below.`); loadMine(addr); mountCredits($("#s-credits"), "streamPay", addr);
  } catch (e) { toast(errMessage(e)); notice(esc(errMessage(e)), "warn"); setBusy(btn, false); }
}
async function cancelStream(btn: HTMLButtonElement, id: number, addr: string) {
  if (!confirm("Cancel this stream? Accrued FMX goes to the payee, the rest back to the payer.")) return;
  setBusy(btn, true, "Confirm…");
  try {
    let hash: string | null = null;
    if (config.mock) { await economy.mockCancelStream(id); }
    else { if (!streamsDeployed) throw new Error("StreamPay is not deployed yet."); const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "cancelStream", [id], {}, phaseTo(btn))).hash; }
    toast("Cancelled"); notice(`Stream #${id} cancelled${hash ? ` — ${txHtml(hash, "transaction")}` : ""}. Accrued FMX went to the payee's credits; the unspent deposit is credited back to the payer — withdraw from the credits panel below.`); loadMine(addr); mountCredits($("#s-credits"), "streamPay", addr);
  } catch (e) { toast(errMessage(e)); notice(esc(errMessage(e)), "warn"); setBusy(btn, false); }
}
async function cancelSub(btn: HTMLButtonElement, id: number, addr: string) {
  if (!confirm("Cancel this subscription? Unaccrued periods are refunded to your credits.")) return;
  setBusy(btn, true, "Confirm…");
  try {
    let hash: string | null = null;
    if (config.mock) { await economy.mockCancelSub(id); }
    else { if (!streamsDeployed) throw new Error("StreamPay is not deployed yet."); const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "cancelSub", [id], {}, phaseTo(btn))).hash; }
    toast("Cancelled"); notice(`Subscription #${id} cancelled${hash ? ` — ${txHtml(hash, "transaction")}` : ""}. Unused periods are credited back — withdraw from the credits panel below.`); loadMine(addr); mountCredits($("#s-credits"), "streamPay", addr);
  } catch (e) { toast(errMessage(e)); notice(esc(errMessage(e)), "warn"); setBusy(btn, false); }
}

function createPlanFormHtml() {
  return `<div class="panel composer" style="margin-top:20px"><div class="panel-head"><h3>Create a plan</h3></div><div class="panel-body">
    <div class="form-row">
      <div class="field"><label for="cp-name">Name</label><input type="text" id="cp-name" placeholder="Weekly extraction" maxlength="64"></div>
      <div class="field"><label for="cp-price">Price / period (FMX)</label><input type="number" id="cp-price" min="0" step="0.01" class="num" placeholder="2"></div>
    </div>
    <div class="field"><label for="cp-period">Period (days)</label><input type="number" id="cp-period" min="1" step="1" class="num" placeholder="7"></div>
    <div id="cp-status"></div>
    <button class="btn btn-primary" type="button" id="cp-create" style="width:auto">Create plan</button>
  </div></div>`;
}
function wireCreatePlan(addr: string) {
  $("#cp-create")!.addEventListener("click", async () => {
    const btn = $("#cp-create") as HTMLButtonElement, status = $("#cp-status")!;
    const name = ($("#cp-name") as HTMLInputElement).value.trim(), price = ($("#cp-price") as HTMLInputElement).value.trim(), periodD = ($("#cp-period") as HTMLInputElement).value.trim();
    if (!name || !price || Number(price) <= 0 || !periodD || Number(periodD) <= 0) { status.innerHTML = `<div class="alert warn">Fill in all fields.</div>`; return; }
    setBusy(btn, true, "Confirm in wallet…");
    try {
      const periodSec = Math.round(Number(periodD) * 86400);
      let hash: string | null = null;
      if (config.mock) { await economy.mockCreatePlan(toWei(price).toString(), periodSec, name); }
      else {
        if (!streamsDeployed) throw new Error("StreamPay is not deployed yet.");
        // The plan name lives off-chain: store {name} as a gateway payload and point metadataURI at it.
        setBusy(btn, true, "Saving name…");
        const payload = await api.postPayload(JSON.stringify({ name, payee: addr, pricePerPeriod: toWei(price).toString(), period: periodSec }), "application/json");
        setBusy(btn, true, "Confirm in wallet…");
        const c = await contractWrite(config.streamPay, STREAM_PAY_ABI); hash = (await sendCall(c, "createPlan", [toWei(price), periodSec, payload.uri], {}, phaseTo(btn))).hash;
      }
      toast("Plan created"); notice(`Plan "${esc(name)}" created: ${esc(price)} FMX every ${esc(dur(periodSec))}${hash ? ` — ${txHtml(hash, "transaction")}` : ""}.`); loadMine(addr); loadAllPlans();
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
}
