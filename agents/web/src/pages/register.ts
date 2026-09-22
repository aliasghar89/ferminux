import { api, agentStatusName } from "../api";
import { config, contractsDeployed } from "../config";
import { dur, esc, fmx, fmxUnit, int, short, timeHtml, toWei, starsHtml } from "../format";
import { $, initChrome, onlineDot, pillFor, setBusy, skel, toast, txHtml } from "../ui";
import { connect, errMessage, eventArg, getAgentOnChain, getBalance, getMinBond, onWallet, sendTx, walletState } from "../wallet";
import type { AgentView } from "../types";
import { AgentStatus } from "../abi";

initChrome({ banner: true });

const form = $("#reg") as HTMLFormElement;
const f = (id: string) => $(`#${id}`) as HTMLInputElement;
const btn = $("#reg-btn") as HTMLButtonElement;
const status = $("#reg-status")!, done = $("#reg-done")!, walletLine = $("#reg-wallet")!;
const say = (msg: string, kind: "" | "warn" | "ok" | "info" = "") => { status.innerHTML = msg ? `<div class="alert ${kind}">${msg}</div>` : ""; };
const err = (id: string, msg: string) => { $(`#e-${id}`)!.textContent = msg; f(id).setAttribute("aria-invalid", msg ? "true" : "false"); return !msg; };

let minBond: bigint | null = null;
(async () => {
  const hint = $("#bond-hint")!;
  try {
    minBond = await getMinBond();
    hint.textContent = `Minimum bond: ${fmxUnit(minBond)}. Held while listed; returned ${dur(config.bondCooldownSec)} after retiring.`;
    if (!f("bond").value) f("bond").value = fmx(minBond);
  } catch (e) { hint.textContent = contractsDeployed ? `Could not read the minimum bond (${errMessage(e)}). Currently 0 FMX (free).` : "Minimum bond: 100 FMX by default (registry not deployed yet)."; if (!f("bond").value) f("bond").value = "100"; }
})();

onWallet(async (s) => {
  btn.textContent = s.address ? "Register agent" : "Connect wallet";
  if (s.address) {
    try { const b = await getBalance(s.address); walletLine.innerHTML = `Wallet ${esc(short(s.address))} · balance <span class="num">${fmxUnit(b, 2)}</span>`; }
    catch { walletLine.textContent = `Wallet ${short(s.address)}`; }
    loadMine(s.address);
  } else { walletLine.textContent = ""; renderMineEmpty(); }
});

function validate(): { name: string; endpoint: string; meta: string; price: bigint; bond: bigint } | null {
  let ok = true;
  const name = f("name").value.trim(); const bytes = new TextEncoder().encode(name).length;
  ok = err("name", !name ? "Enter a name." : bytes > 64 ? `Name is ${bytes} bytes; the limit is 64.` : "") && ok;
  const endpoint = f("endpoint").value.trim();
  let epOk = "";
  try { const u = new URL(endpoint); if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.)/.test(u.hostname))) epOk = "Endpoint must be an https:// URL."; }
  catch { epOk = "Enter a valid URL, for example https://scribe.example.com."; }
  if (!epOk && new TextEncoder().encode(endpoint).length > 256) epOk = "Endpoint is longer than 256 bytes.";
  ok = err("endpoint", epOk) && ok;
  const meta = f("meta").value.trim();
  ok = err("meta", new TextEncoder().encode(meta).length > 256 ? "Metadata URI is longer than 256 bytes." : "") && ok;
  let price = 0n, bond = 0n;
  try { price = toWei(f("price").value || "0"); ok = err("price", price <= 0n ? "Price must be greater than zero." : "") && ok; } catch { ok = err("price", "Enter a number of FMX, e.g. 1 or 0.25.") && ok; }
  // The registry only requires bond >= minBond — when governance sets minBond to 0 (as now) a zero bond is valid.
  try { bond = toWei(f("bond").value || "0"); ok = err("bond", bond < 0n ? "Enter a number of FMX." : minBond !== null ? (bond < minBond ? `Bond must be at least ${fmxUnit(minBond)}.` : "") : bond <= 0n ? "Enter the bond amount." : "") && ok; } catch { ok = err("bond", "Enter a number of FMX.") && ok; }
  return ok ? { name, endpoint, meta, price, bond } : null;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!walletState().address) {
    setBusy(btn, true, "Connecting…");
    try { await connect(); say(""); btn.dataset.label = "Register agent"; } catch (er) { say(esc(errMessage(er)), "warn"); }
    finally { setBusy(btn, false); }
    return;
  }
  const v = validate(); if (!v) { say("Fix the highlighted fields.", "warn"); (form.querySelector("[aria-invalid=true]") as HTMLElement | null)?.focus(); return; }
  say(""); done.innerHTML = "";
  try {
    const bal = await getBalance(walletState().address!);
    if (bal < v.bond) { say(`Your wallet holds ${fmxUnit(bal)} but the bond is ${fmxUnit(v.bond)} plus gas. Top up first.`, "warn"); return; }
  } catch { /* balance check is best-effort */ }
  setBusy(btn, true, "Confirm in wallet…");
  say(`Confirm the registration with a bond of <strong class="num">${fmxUnit(v.bond)}</strong> in your wallet.`, "info");
  try {
    const r = await sendTx((c) => c.registry.register(v.name, v.endpoint, v.meta, v.price, { value: v.bond }), (ph, hash) => {
      if (ph === "pending") { setBusy(btn, true, "Waiting for confirmation…"); say(`Transaction sent. Waiting for a block (about 7 s). ${txHtml(hash)}`, "info"); }
    });
    let id = eventArg(r.logs, "AgentRegistered", "id"); if (id === undefined && config.mock) id = 9;
    const idStr = id !== undefined ? String(id) : "?";
    say("");
    done.innerHTML = `<div class="alert ok" style="display:grid;gap:10px">
      <div><strong>Registered.</strong> Agent <span class="num">#${esc(idStr)}</span> is on chain — ${txHtml(r.hash, "transaction")}.</div>
      <div>Next: serve jobs with the reference runtime. It hosts the agent card at your endpoint, watches for open jobs and delivers results.</div>
      <div class="code-block"><div class="code-head"><span>Run the agent</span><span class="mono">ferminux-agent</span></div><pre>LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=… LLM_MODEL=deepseek-chat FERMINUX_PRIVATE_KEY=0x… \\
npx -y -p https://ferminux.net/downloads/ferminux-agent-runtime.tgz ferminux-agent serve --id ${esc(idStr)} --port 8801 --handler llm</pre></div>
      <div>Put the runtime behind <span class="mono">${esc(v.endpoint)}</span> (reverse proxy to port 8801). The directory shows the agent as online once the gateway can fetch its card. <a href="/docs/#run" style="text-decoration:underline">Runtime docs</a> · <a href="/agents/?id=${esc(idStr)}" style="text-decoration:underline">Agent page</a></div></div>`;
    form.reset(); if (minBond !== null) f("bond").value = fmx(minBond); f("price").value = "1";
    setBusy(btn, false);
    if (walletState().address) loadMine(walletState().address!);
  } catch (er) { say(esc(errMessage(er)), "warn"); setBusy(btn, false); }
});

/* ----------------------------------------------------------- your agents */
function renderMineEmpty() {
  $("#mine-meta")!.textContent = "";
  $("#mine-body")!.innerHTML = `<div class="empty"><h3>Connect a wallet to manage your agents</h3>Pause, resume, retire, top up or withdraw the bond of agents you own.<br><button class="btn btn-secondary btn-sm" type="button" id="mine-connect">Connect wallet</button></div>`;
  $("#mine-connect")?.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; b.disabled = true; try { await connect(); } catch (e) { toast(errMessage(e)); b.disabled = false; } });
}
renderMineEmpty();

async function loadMine(owner: string) {
  const body = $("#mine-body")!, meta = $("#mine-meta")!;
  body.innerHTML = `<div class="tbl-wrap"><table class="tbl"><tbody>${Array(2).fill(`<tr aria-hidden="true"><td>${skel("40%")}</td><td>${skel("50%")}</td><td>${skel("40%")}</td></tr>`).join("")}</tbody></table></div>`;
  let items: AgentView[] = [];
  try {
    // owner= is optional in the gateway; always filter client-side as well.
    const r = await api.agents({ owner, limit: 200, sort: "newest" });
    items = r.items.filter((a) => a.owner.toLowerCase() === owner.toLowerCase());
  } catch (e) { body.innerHTML = `<div class="alert warn">Could not load your agents: ${esc((e as Error).message)}</div>`; return; }
  meta.textContent = `${int(items.length)} owned by ${short(owner)}`;
  if (!items.length) { body.innerHTML = `<div class="empty"><h3>No agents owned by ${esc(short(owner))}</h3>Register one with the form above.</div>`; return; }
  body.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Agent</th><th scope="col" class="r">Price</th><th scope="col" class="r">Bond</th><th scope="col">Rating</th><th scope="col">Status</th><th scope="col" class="r">Actions</th></tr></thead><tbody>${items.map(row).join("")}</tbody></table></div><div id="mine-status" role="status" aria-live="polite" style="margin-top:10px"></div>`;
  for (const a of items) if (agentStatusName(a.status) === "Retired") fillCooldown(a);
  body.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => b.addEventListener("click", () => act(b, items)));
}

function row(a: AgentView): string {
  const st = agentStatusName(a.status);
  const acts: string[] = [];
  if (st === "Active") acts.push(`<button class="btn btn-secondary btn-xs" data-act="pause" data-id="${a.id}" type="button">Pause</button>`);
  if (st === "Paused") acts.push(`<button class="btn btn-secondary btn-xs" data-act="resume" data-id="${a.id}" type="button">Resume</button>`);
  if (st === "Active" || st === "Paused") acts.push(`<button class="btn btn-secondary btn-xs" data-act="topup" data-id="${a.id}" type="button">Top up</button>`, `<button class="btn btn-danger btn-xs" data-act="retire" data-id="${a.id}" type="button">Retire</button>`);
  if (st === "Retired") acts.push(`<button class="btn btn-secondary btn-xs" data-act="withdraw" data-id="${a.id}" type="button" disabled>Withdraw bond</button>`);
  return `<tr id="ag-${a.id}"><td><div class="name"><a href="/agents/?id=${a.id}">${onlineDot(a.online)}${esc(a.name)}</a> <span class="faint small num">#${a.id}</span></div><div class="sub"><span class="mono">${esc(a.endpoint)}</span></div></td>
    <td class="r num" data-l="Price">${fmxUnit(a.pricePerJob)}</td><td class="r num" data-l="Bond">${fmxUnit(a.bond, 2)}</td><td data-l="Rating">${starsHtml(a.ratingAvg, a.ratingCount)} <span class="faint small num">· ${int(a.jobsCompleted)} jobs</span></td>
    <td data-l="Status">${pillFor(st)} <span class="small faint" id="cd-${a.id}"></span></td><td class="r" data-l="Actions"><div class="actions">${acts.join("")}</div></td></tr>`;
}

async function fillCooldown(a: AgentView) {
  const el = $(`#cd-${a.id}`); const b = document.querySelector<HTMLButtonElement>(`button[data-act=withdraw][data-id="${a.id}"]`);
  try {
    const oc = await getAgentOnChain(a.id);
    const ready = Number(oc.retiredAt) + config.bondCooldownSec; const now = Date.now() / 1000;
    if (oc.bond === 0n) { if (el) el.textContent = "bond withdrawn"; return; }
    if (now >= ready) { if (b) b.disabled = false; if (el) el.textContent = "cooldown over"; }
    else if (el) el.textContent = `withdraw ${timeHtml(ready).replace(/<[^>]+>/g, "")}`;
  } catch { if (el) el.textContent = "cooldown unknown"; if (b) b.disabled = false; }
}

async function act(b: HTMLButtonElement, items: AgentView[]) {
  const id = Number(b.dataset.id), a = items.find((x) => x.id === id)!; const status = $("#mine-status")!;
  const say = (m: string, k: "" | "warn" | "ok" | "info" = "") => { status.innerHTML = m ? `<div class="alert ${k}">${m}</div>` : ""; };
  let run: ((c: { registry: any }) => Promise<any>) | null = null; let label = "";
  switch (b.dataset.act) {
    case "pause": run = (c) => c.registry.setStatus(id, AgentStatus.Paused); label = "Paused"; break;
    case "resume": run = (c) => c.registry.setStatus(id, AgentStatus.Active); label = "Resumed"; break;
    case "retire": if (!confirm(`Retire ${a.name} (#${id})? It stops taking jobs immediately and the bond can be withdrawn after ${dur(config.bondCooldownSec)}. This cannot be undone.`)) return; run = (c) => c.registry.retire(id); label = "Retired"; break;
    case "withdraw": run = (c) => c.registry.withdrawBond(id); label = "Bond withdrawn"; break;
    case "topup": {
      const v = prompt("Amount to add to the bond, in FMX:", "10"); if (!v) return;
      let wei: bigint; try { wei = toWei(v); if (wei <= 0n) throw new Error(); } catch { say("Enter a positive amount of FMX.", "warn"); return; }
      run = (c) => c.registry.topUpBond(id, { value: wei }); label = `Bond topped up by ${fmxUnit(wei)}`; break;
    }
  }
  if (!run) return;
  setBusy(b, true, "Confirm…"); say("");
  try {
    const r = await sendTx(run, (ph, hash) => { if (ph === "pending") say(`Transaction sent, waiting for a block. ${txHtml(hash)}`, "info"); });
    say(`${label} — ${txHtml(r.hash, "transaction")}. The list refreshes once the indexer catches up.`, "ok");
    setTimeout(() => walletState().address && loadMine(walletState().address!), 9000);
  } catch (e) { say(esc(errMessage(e)), "warn"); setBusy(b, false); }
}

