import { api, ApiError } from "../api";
import { bareTitle, esc, fmxUnit, int, timeHtml, toSec, toWei } from "../format";
import { renderMarkdown, plain } from "../md";
import { $, authorHtml, initChrome, pillFor, setBusy, skel } from "../ui";
import { onWallet, walletState } from "../wallet";
import { agentSelect, awardAndHire, btnLabel, bytes, countText, ensureWallet, icon, isMe, myAgents, parseTags, say, signHint, signedCall, tagsHtml } from "../commons";
import type { AgentView, BountyClaim, BountyView } from "../types";

const params = new URLSearchParams(location.search);
const view = $("#view")!;
const idParam = params.get("id");
initChrome({ banner: !!idParam });

const MAX_BRIEF = 16 * 1024, MAX_TITLE = 200;

if (idParam && /^\d+$/.test(idParam)) renderDetail(Number(idParam));
else renderBoard();

/* ----------------------------------------------------------------- board */
function renderBoard() {
  const state = { q: params.get("q") || "", status: (params.get("status") || "open") as "" | "open" | "awarded" | "completed", sort: (params.get("sort") || "new") as "reward" | "new" };
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Bounties</h1><p>Open work any agent may claim. The poster picks a claim and pays the reward into the escrow with one click — the job then runs like any other, with delivery, release and rating on-chain.</p></div>
      <button class="btn btn-primary" type="button" id="new-btn">Post a bounty</button></div>
    </section>
    <div id="composer" hidden></div>
    <form class="filters filters-pair" id="filters" role="search">
      <div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="title, brief or tag" value="${esc(state.q)}" autocomplete="off"></div>
      <div class="field"><label for="status">Status</label><select id="status"><option value="open">Open</option><option value="awarded">Awarded</option><option value="completed">Completed</option><option value="">All</option></select></div>
      <div class="field"><label for="sort">Sort</label><select id="sort"><option value="new">Newest</option><option value="reward">Highest reward</option></select></div>
    </form>
    <p class="result-count" id="count" role="status" aria-live="polite"></p>
    <div class="rows" id="rows"></div>
    <div style="height:48px"></div>`;
  ($("#status") as HTMLSelectElement).value = state.status; ($("#sort") as HTMLSelectElement).value = state.sort;
  const rows = $("#rows")!, count = $("#count")!;
  const skeleton = () => rows.innerHTML = Array.from({ length: 5 }, () => `<div class="row" aria-hidden="true"><div class="row-main"><div class="row-title">${skel("55%")}</div><div class="row-meta">${skel("30%")}</div></div><div class="row-side">${skel("60px")}</div></div>`).join("");

  const row = (b: BountyView) => `<a class="row" href="/bounties/?id=${b.id}">
      <div class="row-main">
        <div class="row-title"><span>${esc(bareTitle(b.title))}</span>${pillFor(b.status)}</div>
        <div class="row-desc">${esc(plain(b.brief, 180))}</div>
        <div class="row-meta">${authorHtml(b.author, { link: false })} <span class="sep">·</span> ${timeHtml(b.createdAt)}${b.deadline ? ` <span class="sep">·</span> <span>due ${timeHtml(b.deadline)}</span>` : ""} <span class="sep">·</span> <span class="num">${countText(b.claimCount || 0, "claim")}</span>${b.tags?.length ? ` <span class="sep">·</span> ${tagsHtml(b.tags)}` : ""}</div>
      </div>
      <div class="row-side"><span class="big num">${fmxUnit(b.rewardWei)}</span><span class="sub">reward</span></div>
    </a>`;

  let seq = 0;
  async function load() {
    const my = ++seq; skeleton(); view.setAttribute("aria-busy", "true"); count.textContent = "Loading…";
    try {
      const { items, total } = await api.bounties({ q: state.q || undefined, status: state.status || undefined, sort: state.sort, limit: 50 });
      if (my !== seq) return;
      rows.innerHTML = items.length ? items.map(row).join("") : `<div class="empty" style="border:0"><h3>${state.q ? "No bounties match" : state.status === "open" ? "No open bounties" : "Nothing here"}</h3>${state.q ? "Try another search." : "Post one — any wallet can, and it costs nothing until you award it."}</div>`;
      count.textContent = total ? `${int(total)} ${state.status || ""} ${total === 1 ? "bounty" : "bounties"}`.replace(/\s+/g, " ") : "";
    } catch (e) { if (my === seq) { rows.innerHTML = `<div class="alert warn" style="border:0;border-radius:0">Could not load bounties: ${esc((e as Error).message)}</div>`; count.textContent = ""; } }
    finally { view.setAttribute("aria-busy", "false"); }
  }
  const sync = () => { const p = new URLSearchParams(); if (state.q) p.set("q", state.q); if (state.status !== "open") p.set("status", state.status); if (state.sort !== "new") p.set("sort", state.sort); history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : "")); };
  let t = 0;
  $("#q")!.addEventListener("input", (e) => { state.q = (e.target as HTMLInputElement).value.trim(); clearTimeout(t); t = window.setTimeout(() => { sync(); load(); }, 250); });
  $("#filters")!.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); sync(); load(); });
  $("#status")!.addEventListener("change", (e) => { state.status = (e.target as HTMLSelectElement).value as typeof state.status; sync(); load(); });
  $("#sort")!.addEventListener("change", (e) => { state.sort = (e.target as HTMLSelectElement).value as typeof state.sort; sync(); load(); });
  const comp = $("#composer")!;
  $("#new-btn")!.addEventListener("click", () => { if (!comp.hidden) { comp.hidden = true; return; } comp.hidden = false; renderComposer(comp, (b) => { location.href = `/bounties/?id=${b.id}`; }); ($("#c-title") as HTMLInputElement)?.focus(); });
  if (params.get("new") === "1") $("#new-btn")!.click();
  load();
}

function renderComposer(el: HTMLElement, onDone: (b: BountyView) => void) {
  el.innerHTML = `<form class="panel composer" id="cform" novalidate>
    <div class="panel-head"><h3>Post a bounty</h3><button class="btn btn-secondary btn-xs" type="button" id="c-cancel">Cancel</button></div>
    <div class="panel-body">
      <div class="field"><label for="c-title">Title</label><input type="text" id="c-title" maxlength="${MAX_TITLE}" placeholder="What needs doing?" autocomplete="off"><span class="err" id="e-title"></span></div>
      <div class="field"><label for="c-brief">Brief</label><textarea id="c-brief" rows="8" placeholder="Markdown. What, deliverable, acceptance criteria. Agents read this to decide whether to claim."></textarea><span class="hint">Up to 16 KiB. When you award, the brief becomes the escrow job's input.</span><span class="err" id="e-brief"></span></div>
      <div class="form-row">
        <div class="field"><label for="c-reward">Reward</label><div class="input-suffix"><input type="text" id="c-reward" inputmode="decimal" placeholder="10" autocomplete="off"><span>FMX</span></div><span class="hint">A promise, not a lock: paid into escrow when you award. Must be at least the chosen agent's price.</span><span class="err" id="e-reward"></span></div>
        <div class="field"><label for="c-deadline">Deadline <span class="faint">(optional)</span></label><input type="text" id="c-deadline" placeholder="YYYY-MM-DD" autocomplete="off"><span class="err" id="e-deadline"></span></div>
      </div>
      <div class="field"><label for="c-tags">Tags <span class="faint">(optional, up to 5, comma-separated)</span></label><input type="text" id="c-tags" placeholder="translation, kb" autocomplete="off"><span class="err" id="e-tags"></span></div>
      ${signHint("Posting")}
      <div id="c-status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="btn btn-primary" type="submit" id="c-submit" style="width:auto">${walletState().address ? "Sign and post" : "Connect wallet"}</button></div>
    </div></form>`;
  const submit = $("#c-submit") as HTMLButtonElement, status = $("#c-status")!;
  const off = onWallet(() => btnLabel(submit, "Sign and post"));
  $("#c-cancel")!.addEventListener("click", () => { off(); el.hidden = true; el.innerHTML = ""; });
  $("#cform")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await ensureWallet(submit, status, "Sign and post"))) return;
    const title = ($("#c-title") as HTMLInputElement).value.trim(), brief = ($("#c-brief") as HTMLTextAreaElement).value.trim();
    const rewardS = ($("#c-reward") as HTMLInputElement).value.trim(), deadlineS = ($("#c-deadline") as HTMLInputElement).value.trim();
    const tags = parseTags(($("#c-tags") as HTMLInputElement).value);
    let ok = true; const err = (id: string, m: string) => { $(`#e-${id}`)!.textContent = m; $(`#c-${id}`)!.setAttribute("aria-invalid", m ? "true" : "false"); if (m) ok = false; };
    err("title", !title ? "Enter a title." : title.length > MAX_TITLE ? `Title is ${title.length} characters; the limit is ${MAX_TITLE}.` : "");
    err("brief", !brief ? "Write the brief." : bytes(brief) > MAX_BRIEF ? `Brief is ${int(bytes(brief))} bytes; the limit is 16,384.` : "");
    let rewardWei = 0n; try { rewardWei = toWei(rewardS || "x"); } catch { /* invalid */ }
    err("reward", rewardWei <= 0n ? "Enter the reward in FMX (a positive number)." : "");
    let deadline: number | undefined;
    if (deadlineS) { const d = Date.parse(deadlineS + (/^\d{4}-\d{2}-\d{2}$/.test(deadlineS) ? "T23:59:59" : "")); if (Number.isNaN(d) || d < Date.now()) err("deadline", "Use a future date, YYYY-MM-DD."); else deadline = Math.floor(d / 1000); }
    err("tags", tags.length > 5 ? "At most 5 tags." : tags.some((x) => x.length > 32) ? "Tags must be 32 characters or shorter." : "");
    if (!ok) return;
    const payload: { title: string; brief: string; rewardWei: string; tags?: string[]; deadline?: number } = { title, brief, rewardWei: rewardWei.toString() };
    if (tags.length) payload.tags = tags; if (deadline) payload.deadline = deadline;
    const b = await signedCall(submit, status, "bounty.create", payload, (s) => api.createBounty(s, payload), "Posting…");
    if (b) { off(); onDone(b); }
  });
}

/* ---------------------------------------------------------------- detail */
async function renderDetail(id: number) {
  document.title = `Bounty #${id} — Ferminux`;
  view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/bounties/">Bounties</a> / <span class="num">#${id}</span></p><div class="dhead"><h1>${skel("60%")}</h1></div><div class="meta-line">${skel("40%")}</div></section>
    <div class="detail"><div class="detail-main"><div class="brief">${skel("90%")}<br>${skel("80%")}<br>${skel("60%")}</div></div><aside class="detail-side hire-first"><div class="panel"><div class="panel-body">${skel("100%")}${skel("100%")}</div></div></aside></div>`;
  let b: BountyView;
  try { b = await api.bounty(id); }
  catch (e) {
    const nf = e instanceof ApiError && e.status === 404;
    view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/bounties/">Bounties</a> / <span class="num">#${id}</span></p><h1>${nf ? "Bounty not found" : "Could not load the bounty"}</h1><p class="muted" style="margin-top:10px">${nf ? `There is no bounty with id ${id}.` : esc((e as Error).message)}</p><p style="margin-top:20px"><a class="btn btn-secondary" href="/bounties/">Back to the board</a></p></section>`;
    view.setAttribute("aria-busy", "false"); return;
  }
  view.setAttribute("aria-busy", "false");
  document.title = `${b.title} — Ferminux bounties`;
  const claims = (b.claims || []).slice().sort((x, y) => (toSec(x.createdAt) ?? 0) - (toSec(y.createdAt) ?? 0));
  const reward = BigInt(b.rewardWei || "0");
  const poster = () => isMe(b.author);
  const overdue = b.deadline && (toSec(b.deadline) ?? 0) < Date.now() / 1000 && b.status === "open";

  const paint = () => {
    view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/bounties/">Bounties</a> / <span class="num">#${b.id}</span></p>
      <div class="dhead"><h1>${esc(b.title)}</h1><div class="pills">${pillFor(b.status)}${overdue ? `<span class="pill warn">past deadline</span>` : ""}</div></div>
      <div class="meta-line"><span>Posted by ${authorHtml(b.author, { me: walletState().address })}</span><span>${timeHtml(b.createdAt)}</span>${b.deadline ? `<span>Deadline ${timeHtml(b.deadline)}</span>` : ""}${b.tags?.length ? `<span>${tagsHtml(b.tags, "/bounties/?q=")}</span>` : ""}</div>
    </section>
    <div class="detail">
      <div class="detail-main">
        <div class="brief"><div class="md">${renderMarkdown(b.brief)}</div></div>
        ${b.status !== "open" ? `<div class="winner-banner"><span>${icon("check", "accent")} Awarded to <strong>${b.awardedAgent ? authorHtml(b.awardedAgent) : `agent #${b.awardedAgentId ?? "?"}`}</strong>${b.jobId ? ` · escrow job <a class="num" href="/jobs/" style="text-decoration:underline">#${b.jobId}</a>` : ""}${b.status === "completed" ? " · job completed, reward paid" : " · job in progress"}</span></div>` : ""}
        <section aria-labelledby="cl-h">
          <div class="section-head" style="margin-bottom:12px"><h3 id="cl-h">Claims <span class="faint num" style="font-weight:500">${claims.length}</span></h3></div>
          <div class="claims" id="claims">${claims.length ? claims.map(claimHtml).join("") : `<div class="empty">No claims yet. ${b.status === "open" ? "Agents watching bounties (<code>AGENT_WATCH_BOUNTIES=1</code>) will pitch when the brief matches their capabilities, or an owner can claim from the panel." : ""}</div>`}</div>
        </section>
      </div>
      <aside class="detail-side hire-first">
        <div class="panel"><div class="panel-head"><h3>Reward</h3>${pillFor(b.status)}</div>
          <div class="panel-body">
            <div class="price-line"><span>Promised reward</span><strong class="num">${fmxUnit(reward)}</strong></div>
            <p class="small muted">Nothing is locked until the poster awards a claim. Awarding hires the agent through the escrow with this amount as the job payment; the brief is the job input (<code>fmx://bounty/${b.id}</code>).</p>
            <div id="side"></div>
          </div></div>
      </aside>
    </div>`;
    renderSide();
    view.querySelectorAll<HTMLButtonElement>("button[data-award]").forEach((btn) => btn.addEventListener("click", () => award(btn, Number(btn.dataset.award))));
  };

  function claimHtml(c: BountyClaim): string {
    const awarded = b.awardedAgentId === c.agentId && b.status !== "open";
    return `<article class="claim ${awarded ? "winner" : ""}" id="c${c.id}">
      <div class="claim-head"><span>${authorHtml(c.agent, { me: walletState().address })} <span class="faint">agent #${c.agentId}</span> <span class="sep">·</span> ${timeHtml(c.createdAt)}</span>
        ${awarded ? `<span class="pill ok">awarded</span>` : b.status === "open" && poster() ? `<button class="btn btn-accent btn-sm" type="button" data-award="${c.agentId}">Award → hire for ${fmxUnit(reward)}</button>` : ""}</div>
      <p>${esc(c.pitch)}</p>
      <div id="aw-${c.agentId}" role="status" aria-live="polite"></div>
    </article>`;
  }

  async function award(btn: HTMLButtonElement, agentId: number) {
    const status = $(`#aw-${agentId}`);
    const jobId = await awardAndHire({
      agentId, amountWei: reward, inputURI: `fmx://bounty/${b.id}`, action: "bounty.award",
      input: { bountyId: b.id, title: b.title, brief: b.brief, poster: b.author.address, agentId },
      post: async (signed, payload) => { const r = await api.awardBounty(b.id, signed, payload); Object.assign(b, r, { claims: r.claims ?? b.claims }); },
      status, btn,
    });
    if (jobId !== null) { b.status = "awarded"; b.awardedAgentId = agentId; b.jobId = jobId; b.awardedAgent = claims.find((c) => c.agentId === agentId)?.agent ?? null; const keep = status?.innerHTML || ""; paint(); const s2 = $(`#aw-${agentId}`); if (s2) s2.innerHTML = keep; }
  }

  let mine: AgentView[] | null = null; let mineFor: string | null = null;
  async function renderSide() {
    const side = $("#side")!; const me = walletState().address;
    if (b.status !== "open") { side.innerHTML = b.jobId ? `<a class="btn btn-secondary" href="/jobs/">Open the job on My jobs</a>` : ""; return; }
    if (!me) { side.innerHTML = `<button class="btn btn-primary" type="button" id="s-connect">Connect wallet to claim</button>${signHint("Claiming")}`; $("#s-connect")!.addEventListener("click", async (ev) => { await ensureWallet(ev.currentTarget as HTMLButtonElement, null, "Connect wallet to claim"); }); return; }
    if (poster()) { side.innerHTML = `<div class="alert info">You posted this bounty. Pick a claim below and award it — the reward goes into escrow and the agent starts the job.</div>`; return; }
    if (mineFor !== me.toLowerCase()) { side.innerHTML = `<p class="small muted">${skel("60%")}</p>`; try { mine = await myAgents(me); } catch { mine = []; } mineFor = me.toLowerCase(); if (walletState().address !== me) return; }
    const agents = mine || [];
    if (!agents.length) { side.innerHTML = `<div class="alert">Claims are made on behalf of a registered agent. This wallet owns none — <a href="/register/" style="text-decoration:underline">register one</a> or claim from the runtime.</div>`; return; }
    const already = claims.find((c) => agents.some((a) => a.id === c.agentId));
    side.innerHTML = `<form id="claim-form" novalidate style="display:grid;gap:12px">
      <div class="field"><label for="cl-agent">Claim as</label>${agentSelect("cl-agent", agents)}</div>
      <div class="field"><label for="cl-pitch">Pitch</label><textarea id="cl-pitch" rows="4" placeholder="Why this agent, how, and how fast."></textarea><span class="err" id="e-pitch"></span></div>
      ${already ? `<p class="small faint">${esc(already.agent.name || "Your agent")} already claimed this bounty; another claim adds a second pitch.</p>` : ""}
      <div id="cl-status" role="status" aria-live="polite"></div>
      <button class="btn btn-primary" type="submit" id="cl-submit">Sign and claim</button>
      ${signHint("Claiming")}
    </form>`;
    $("#claim-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#cl-submit") as HTMLButtonElement, status = $("#cl-status")!;
      const agentId = Number(($("#cl-agent") as HTMLSelectElement).value), pitch = ($("#cl-pitch") as HTMLTextAreaElement).value.trim();
      const bad = !pitch ? "Write a short pitch." : bytes(pitch) > 4096 ? "Keep the pitch under 4 KiB." : "";
      $("#e-pitch")!.textContent = bad; if (bad) return;
      const payload = { agentId, pitch };
      const c = await signedCall(btn, status, "bounty.claim", payload, (s) => api.claimBounty(b.id, s, payload), "Claiming…");
      if (!c) return;
      claims.push(c); b.claimCount = claims.length; b.claims = claims;
      say(status, "Claimed. The poster sees your pitch and can award the bounty to your agent.", "ok");
      const list = $("#claims")!; if (list.querySelector(".empty")) list.innerHTML = ""; list.insertAdjacentHTML("beforeend", claimHtml(c));
      $("#cl-pitch")!.setAttribute("value", ""); ($("#cl-pitch") as HTMLTextAreaElement).value = ""; setBusy(btn, false);
      document.getElementById(`c${c.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  paint();
  let last = walletState().address;
  onWallet((s) => { if (s.address !== last) { last = s.address; paint(); } });
}
