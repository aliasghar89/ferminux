import { ARBITER_POOL_ABI } from "../abi";
import { arbiterDeployed, config } from "../config";
import { economy } from "../economy";
import { dur, esc, fmx, fmxUnit, int, relTime, timeHtml, toWei } from "../format";
import { $, addrHtml, authorHtml, initChrome, pillFor, setBusy, skel, toast } from "../ui";
import { connect, contractWrite, errMessage, onWallet, sendCall, walletState, type TxPhase } from "../wallet";
import { mountCredits } from "../credits";
const phaseTo = (btn: HTMLButtonElement) => (ph: TxPhase) => { if (ph === "pending") setBusy(btn, true, "Waiting for a block…"); else if (ph === "indexing") setBusy(btn, true, "Indexing…"); };
import type { ArbiterCase, ArbiterPoolView, CaseVote } from "../types";

initChrome();
const view = $("#view")!;
const params = new URLSearchParams(location.search);
const idParam = params.get("id");
let poolAddr: string | null | undefined = undefined;

if (idParam && /^\d+$/.test(idParam)) renderDetail(Number(idParam));
else renderList();

/* ------------------------------------------------------------------ list */
function caseRow(c: ArbiterCase): string {
  return `<tr class="row-link"><td class="num" data-l="Case">#${c.id}</td><td data-l="Job"><a href="/disputes/?id=${c.id}">job #${c.jobId}</a></td><td data-l="Opener">${authorHtml(c.opener, { link: false })}</td><td data-l="Opened">${timeHtml(c.openedAt)}</td><td class="num" data-l="Votes">${c.votes}</td><td data-l="Status">${c.closed ? pillFor("Resolved") : pillFor("Disputed")}</td></tr>`;
}
async function renderList() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Disputes</h1><p>When a client disputes a delivered job, staked arbiters vote a client/agent split (0–10000 bps). The median wins after the voting window or once quorum+2 vote; voters within 2000 bps of the result split a reward.</p></div></div>
    </section>
    <div id="d-pool"></div>
    <div class="section-head" style="margin-top:28px"><h3>Open cases</h3></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Case</th><th scope="col">Job</th><th scope="col">Opener</th><th scope="col">Opened</th><th scope="col" class="r">Votes</th><th scope="col">Status</th></tr></thead>
    <tbody id="d-rows"><tr aria-hidden="true"><td>${skel("20%")}</td><td>${skel("30%")}</td><td>${skel("40%")}</td><td>${skel("40%")}</td><td class="r">${skel("20%")}</td><td>${skel("30%")}</td></tr></tbody></table></div>
    <div style="height:48px"></div>`;
  view.setAttribute("aria-busy", "false");
  try { const { items } = await economy.casesList(); $("#d-rows")!.innerHTML = items.length ? items.map(caseRow).join("") : `<tr><td colspan="6"><div class="empty"><h3>No disputed jobs right now</h3>A case opens when a client disputes a delivered job from <a href="/jobs/" style="text-decoration:underline">their jobs page</a>.</div></td></tr>`; }
  catch (e) { $("#d-rows")!.innerHTML = `<tr><td colspan="6"><div class="alert warn">Could not load cases: ${esc(errMessage(e))}</div></td></tr>`; }
  document.querySelectorAll<HTMLTableRowElement>("#d-rows tr.row-link").forEach((r) => r.addEventListener("click", () => { const a = r.querySelector("a"); if (a) location.href = a.getAttribute("href")!; }));
  onWallet((s) => { if (s.address !== poolAddr) { poolAddr = s.address; loadPool("d-pool", s.address); } });
}

/** ArbiterPool.close(): with no votes at the end of the window the result is 5000 bps (an even split) and
 *  the case fee goes to the pool owner. Said wherever a dispute can start, while nobody is staked. */
const EMPTY_POOL = (p: ArbiterPoolView) => `<strong>No arbiters are staked.</strong> A case that gets no votes closes at a 50/50 split of the escrow after the ${esc(dur(p.votingWindowSec || 3 * 86400))} voting window, whatever its merits, and the 1 FMX case fee goes to the pool owner.`;

function poolPanel(p: ArbiterPoolView, addr: string | null): string {
  const staked = p.myStakeWei && BigInt(p.myStakeWei) > 0n;
  return `<div class="panel"><div class="panel-head"><h3>Arbiter pool</h3><span class="pill${p.arbiterCount ? "" : " warn"}">${int(p.arbiterCount)} arbiter${p.arbiterCount === 1 ? "" : "s"}</span></div>
    <div class="panel-body">
      ${p.arbiterCount ? "" : `<div class="alert warn" style="margin-bottom:14px">${EMPTY_POOL(p)}</div>`}
      <div class="statgrid" style="margin:0;grid-template-columns:repeat(2,1fr)">
        <div><div class="l">Min stake</div><div class="v num">${fmxUnit(p.minStakeWei, 0)}</div></div>
        <div><div class="l">Quorum</div><div class="v num">${p.quorum}</div></div>
        <div><div class="l">Voting window</div><div class="v">${esc(dur(p.votingWindowSec))}</div></div>
        <div><div class="l">Your stake</div><div class="v num">${p.myStakeWei ? fmxUnit(p.myStakeWei, 0) : addr ? "0" : "—"}</div></div>
      </div>
      ${addr ? `<div class="form-row" style="margin-top:14px">
        <div class="field"><label for="d-stake">Stake (FMX)</label><input type="number" id="d-stake" min="0" step="any" class="num" placeholder="${esc(fmx(p.minStakeWei, 0))}"><span class="hint">${staked ? "Adds to your existing stake." : `At least ${fmxUnit(p.minStakeWei, 0)} to join.`}</span></div>
        <div class="field" style="align-self:end"><button class="btn btn-primary btn-block" type="button" id="d-join">${staked ? "Add stake" : "Join pool"}</button></div>
      </div>
      ${staked ? `<button class="btn btn-secondary" type="button" id="d-leave">Leave pool (7-day cooldown)</button>` : ""}
      <div id="d-pool-status" role="status" aria-live="polite"></div>` : `<p class="small muted" style="margin-top:12px">Connect a wallet to join the pool and vote.</p>`}
    </div></div>`;
}
async function loadPool(boxId: string, addr: string | null) {
  const box = $(`#${boxId}`); if (!box) return;
  box.innerHTML = `<div class="panel"><div class="panel-body">${skel("60%")}</div></div>`;
  try {
    const p = await economy.arbiterPool(addr || undefined);
    box.innerHTML = poolPanel(p, addr) + `<div id="${boxId}-credits" style="margin-top:16px"></div>`;
    if (addr) mountCredits(box.querySelector<HTMLElement>(`#${boxId}-credits`), "arbiterPool", addr);
    const joinBtn = box.querySelector<HTMLButtonElement>("#d-join");
    joinBtn?.addEventListener("click", async () => {
      const btn = joinBtn, status = box.querySelector<HTMLElement>("#d-pool-status")!;
      const amt = box.querySelector<HTMLInputElement>("#d-stake")!.value.trim();
      if (!amt || Number(amt) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
      let wei: bigint; try { wei = toWei(amt); } catch { status.innerHTML = `<div class="alert warn">Enter a number of FMX.</div>`; return; }
      const total = wei + BigInt(p.myStakeWei || "0");
      if (total < BigInt(p.minStakeWei)) { status.innerHTML = `<div class="alert warn">Your stake would be ${fmxUnit(total, 2)}; the pool minimum is ${fmxUnit(p.minStakeWei, 0)}. Nothing was sent.</div>`; return; }
      setBusy(btn, true, "Confirm in wallet…");
      try {
        if (config.mock) { await economy.mockJoinPool(addr!, wei); }
        else { if (!arbiterDeployed) throw new Error("ArbiterPool is not deployed yet."); const c = await contractWrite(config.arbiterPool, ARBITER_POOL_ABI); await sendCall(c, "joinPool", [], { value: wei }, phaseTo(btn)); }
        toast("Staked"); loadPool(boxId, addr);
      } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
      finally { setBusy(btn, false); }
    });
    const leaveBtn = box.querySelector<HTMLButtonElement>("#d-leave");
    leaveBtn?.addEventListener("click", async () => {
      const btn = leaveBtn, status = box.querySelector<HTMLElement>("#d-pool-status")!;
      setBusy(btn, true, "Confirm…");
      try {
        if (config.mock) { await economy.mockLeavePool(addr!); }
        else { if (!arbiterDeployed) throw new Error("ArbiterPool is not deployed yet."); const c = await contractWrite(config.arbiterPool, ARBITER_POOL_ABI); await sendCall(c, "leavePool", [], {}, phaseTo(btn)); }
        toast("Left pool"); loadPool(boxId, addr);
      } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); }
    });
  } catch (e) { box.innerHTML = `<div class="alert warn">Could not load the arbiter pool: ${esc(errMessage(e))}</div>`; }
}

/* ---------------------------------------------------------------- detail */
async function renderDetail(id: number) {
  view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/disputes/">Disputes</a></p><div class="dhead"><h1>${skel("30%")}</h1></div></section>`;
  let c: ArbiterCase; let pool: ArbiterPoolView; let votes: CaseVote[];
  try { [c, pool, votes] = await Promise.all([economy.arbiterCase(id), economy.arbiterPool(), economy.caseVotes(id)]); }
  catch (e) { view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/disputes/">Disputes</a></p><h1>Case not found</h1><p class="muted" style="margin-top:10px">${esc(errMessage(e))}</p></section>`; view.setAttribute("aria-busy", "false"); return; }
  document.title = `Case #${c.id} — Ferminux disputes`;
  const closesAt = Number(c.openedAt) + (pool.votingWindowSec || 3 * 86400);
  const canClose = votes.length >= (pool.quorum || 3) + 2 || Date.now() / 1000 >= closesAt;
  view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/disputes/">Disputes</a> / <span class="num">#${c.id}</span></p>
      <div class="dhead"><h1>Case #${c.id}</h1><div class="pills">${c.closed ? pillFor("Resolved") : pillFor("Disputed")}</div></div>
      <div class="meta-line"><span>Job <a href="/jobs/">#${c.jobId}</a></span><span>Opened by ${authorHtml(c.opener, { link: false })}</span><span>${timeHtml(c.openedAt)}</span></div>
    </section>
    <div class="detail">
      <div class="detail-main">
        ${c.client ? `<div class="card"><dl class="kv" style="border:0"><div class="kv-row"><dt>Client</dt><dd>${addrHtml(c.client)}</dd></div>${c.agentId !== null ? `<div class="kv-row"><dt>Agent</dt><dd><a href="/agents/?id=${c.agentId}">agent #${c.agentId}</a></dd></div>` : ""}</dl></div>` : ""}
        <div class="section-head"><h3>Evidence</h3></div>
        <div class="rows" id="d-evidence">${c.evidence.map((e) => `<div class="row"><div class="row-main"><div class="row-title">${authorHtml({ address: e.by }, { link: false })}</div><div class="row-desc"><a class="mono" href="${esc(e.uri)}" rel="noopener" style="text-decoration:underline">${esc(e.uri)}</a></div><div class="row-meta">${timeHtml(e.ts)}</div></div></div>`).join("") || `<div class="empty" style="border:0"><h3>No evidence submitted yet</h3></div>`}</div>
        <div class="panel composer" style="margin-top:16px"><div class="panel-body">
          <div class="field"><label for="d-ev-uri">Evidence URI</label><input type="text" id="d-ev-uri" placeholder="fmx://payload/0x… or https://…" autocomplete="off" spellcheck="false"></div>
          <div id="d-ev-status" role="status" aria-live="polite"></div>
          <button class="btn btn-secondary" type="button" id="d-ev-submit" style="width:auto">Submit evidence</button>
        </div></div>
        <div class="section-head" style="margin-top:28px"><h3>Votes</h3></div>
        ${!c.closed && !votes.length && !pool.arbiterCount ? `<div class="alert warn" style="margin-bottom:12px">${EMPTY_POOL(pool)}</div>` : ""}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Arbiter</th><th scope="col" class="r">Client share</th></tr></thead><tbody>${votes.map((v) => `<tr><td>${authorHtml({ address: v.arbiter }, { link: false })}</td><td class="r num">${(v.clientBps / 100).toFixed(1)}%</td></tr>`).join("") || `<tr><td colspan="2" class="muted small" style="text-align:center;padding:16px">No votes yet.</td></tr>`}</tbody></table></div>
        ${c.closed && c.result !== null ? `<div class="alert ok" style="margin-top:16px">Resolved: client gets <strong>${(c.result / 100).toFixed(1)}%</strong>, agent the rest minus fee.</div>` : `<p class="small faint" style="margin-top:12px">Closes ${esc(relTime(closesAt))} (or once quorum+2 vote).</p>`}
      </div>
      <aside class="detail-side">
        <div id="d-vote-panel"></div>
        <div id="d-pool-side" style="margin-top:16px"></div>
      </aside>
    </div>`;
  view.setAttribute("aria-busy", "false");
  onWallet((s) => { if (s.address !== poolAddr) { poolAddr = s.address; loadPool("d-pool-side", s.address); } });

  $("#d-ev-submit")!.addEventListener("click", async () => {
    const btn = $("#d-ev-submit") as HTMLButtonElement, status = $("#d-ev-status")!;
    const uri = ($("#d-ev-uri") as HTMLInputElement).value.trim();
    if (!uri) { status.innerHTML = `<div class="alert warn">Enter a URI.</div>`; return; }
    if (!walletState().address) { setBusy(btn, true, "Connecting…"); try { await connect(); } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); return; } setBusy(btn, false); }
    setBusy(btn, true, "Confirm in wallet…");
    try {
      const addr = walletState().address!;
      if (config.mock) { await economy.mockSubmitEvidence(c.id, addr, uri); }
      else { if (!arbiterDeployed) throw new Error("ArbiterPool is not deployed yet."); const contract = await contractWrite(config.arbiterPool, ARBITER_POOL_ABI); await sendCall(contract, "submitEvidence", [c.id, uri], {}, phaseTo(btn)); }
      toast("Evidence submitted"); renderDetail(c.id);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); }
  });

  const votePanel = $("#d-vote-panel")!;
  if (c.closed) votePanel.innerHTML = `<div class="panel"><div class="panel-head"><h3>Case closed</h3></div><div class="panel-body"><p class="small muted">Result: ${((c.result ?? 5000) / 100).toFixed(1)}% to the client.</p></div></div>`;
  else votePanel.innerHTML = `<div class="panel"><div class="panel-head"><h3>Vote</h3></div><div class="panel-body">
      <div class="field"><label for="d-vote-bps">Client share (%)</label><input type="number" id="d-vote-bps" min="0" max="100" step="0.5" value="50" class="num"></div>
      <p class="small faint">Staked arbiters only, one vote each. Ties resolve to the median.</p>
      <div id="d-vote-status" role="status" aria-live="polite"></div>
      <button class="btn btn-primary" type="button" id="d-vote-btn">Cast vote</button>
      ${canClose ? `<button class="btn btn-secondary" type="button" id="d-close-btn" style="margin-top:8px">Close case</button>` : ""}
    </div></div>`;
  $("#d-vote-btn")?.addEventListener("click", async () => {
    const btn = $("#d-vote-btn") as HTMLButtonElement, status = $("#d-vote-status")!;
    const pct = Number(($("#d-vote-bps") as HTMLInputElement).value);
    if (!(pct >= 0 && pct <= 100)) { status.innerHTML = `<div class="alert warn">Enter 0–100.</div>`; return; }
    const bps = Math.round(pct * 100);
    if (!walletState().address) { setBusy(btn, true, "Connecting…"); try { await connect(); } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); return; } setBusy(btn, false); }
    setBusy(btn, true, "Confirm in wallet…");
    try {
      const addr = walletState().address!;
      if (config.mock) { await economy.mockVoteCase(c.id, addr, bps); }
      else { if (!arbiterDeployed) throw new Error("ArbiterPool is not deployed yet."); const contract = await contractWrite(config.arbiterPool, ARBITER_POOL_ABI); await sendCall(contract, "vote", [c.id, bps], {}, phaseTo(btn)); }
      toast("Vote cast"); renderDetail(c.id);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); }
  });
  $("#d-close-btn")?.addEventListener("click", async () => {
    const btn = $("#d-close-btn") as HTMLButtonElement, status = $("#d-vote-status")!;
    setBusy(btn, true, "Confirm…");
    try {
      if (config.mock) { await economy.mockCloseCase(c.id); }
      else { if (!arbiterDeployed) throw new Error("ArbiterPool is not deployed yet."); const contract = await contractWrite(config.arbiterPool, ARBITER_POOL_ABI); await sendCall(contract, "close", [c.id], {}, phaseTo(btn)); }
      toast("Case closed"); renderDetail(c.id);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); }
  });
}
