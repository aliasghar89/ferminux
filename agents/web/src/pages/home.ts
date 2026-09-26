import { api, agentStatusName, jobStatusName } from "../api";
import { economy } from "../economy";
import { bareTitle, dur, fmx, int, esc, relTime, short, starsHtml, fmxUnit, timeHtml, toSec } from "../format";
import { $, authorHtml, initChrome, onlineDot, onlineSr, pillFor, skel } from "../ui";
import type { ActivityEvent, AgentView, JobView, PayinAssets } from "../types";
import { describe, icon } from "../commons";
import { allIds, artHtml, bindArt, category, collectionState, loadCollection, statuses, type NftMeta, type NftStatus } from "../nft";
import { citizensState, citizensStatuses, liveTier, loadCitizens, type CitizensState } from "../citizens";
import { pickShowcase, tierName } from "../nftView";
import { citizensMeta } from "../deployments.generated";
import { config, explorerAddr, explorerTx, nftDeployed } from "../config";
import { getMinBond, onWallet } from "../wallet";
import { calm, fadeRows, initMotion, initSnap, liveText, onPlay, onReveal, playing, resetText } from "../motion";

initChrome();
initMotion(); // initChrome already started it; kept explicit because this page owns the choreography

const set = (id: string, v: string) => { const el = $(`#${id}`); if (el) el.textContent = v; };
/** A live figure: lands once when its section arrives, then rolls only the digits that change. */
const num = (id: string, v: string) => liveText($(`#${id}`), v);
const EASE_OUT = "cubic-bezier(.16,1,.3,1)", EASE_STD = "cubic-bezier(.4,0,.2,1)";
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const extLink = (href: string, text: string) => `<a class="link-inline" href="${href}" rel="noopener">${text}<svg class="ext" width="12" height="12" aria-hidden="true"><use href="#i-ext"/></svg></a>`;

/** Run `fn` every `ms` while the tab is visible, and once more as soon as it becomes visible again. */
function every(ms: number, fn: () => void) {
  window.setInterval(() => { if (!document.hidden) fn(); }, ms);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) fn(); });
}

/** Plain JSON-RPC against the public node. The chip and the signer panel read the chain itself, not the indexer. */
let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(config.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result as T;
}

/** Active agents, fetched once: the hero badges, featured list and "agents online" count all read it. */
const activeAgents = api.agents({ sort: "rating", limit: 50, status: "active" });

/* ---- live network state (the ring card) ---- */
async function loadStats() {
  const [stats, health] = await Promise.allSettled([api.stats(), api.health()]);
  const dot = $("#gw-dot")!, st = $("#gw-status")!;
  if (stats.status === "fulfilled") {
    const s = stats.value;
    num("st-agents", int(s.agents)); num("st-active", int(s.activeAgents)); num("st-jobs", int(s.jobs)); num("st-completed", int(s.jobsCompleted));
    num("st-volume", fmx(s.volumeWei, 2));
    num("rt-agents", `${int(s.activeAgents)} active of ${int(s.agents)}`);
  } else {
    for (const id of ["st-agents", "st-active", "st-jobs", "st-completed", "st-volume"]) num(id, "—");
  }
  // The status line is a live region, so it carries only the state and speaks only when that changes
  // (never the head number, which the chip already shows and which changes every block).
  const line = health.status === "fulfilled"
    ? (health.value.ok ? `live · chain ${health.value.chainId}` : "gateway reports a problem")
    : stats.status === "fulfilled" ? "gateway health check failed" : "gateway unreachable, stats unavailable";
  dot.className = `status-dot ${health.status === "fulfilled" && health.value.ok ? "ok" : "bad"}`;
  if (st.dataset.s !== line) { st.textContent = line; st.dataset.s = line; }
}

/* ---- hero chip: the live head. Reads land just after the next block is due (head + 7.2 s), so the
   confirmation wave fires on the block itself, not on a fixed 7 s timer that drifts against it. ---- */
const head = { n: -1, ts: 0 };
function renderAge() {
  const el = $("#chip-age"); if (!el) return;
  if (!head.ts) { el.textContent = ""; return; }
  const ago = Math.max(0, Math.round(Date.now() / 1000 - head.ts));
  // The caption under the stage says "confirmed by"; the chip keeps only the age, short enough for a 112 px face.
  el.textContent = ago < 2 ? "just now" : ago < 90 ? `${ago} s ago` : relTime(head.ts);
}
/** The announcement line under the stage: the live head, the signer that confirmed it, and the link to check it. */
function renderCaption(n: number, signer: string | null) {
  const a = $<HTMLAnchorElement>("#chip-cap"), t = $("#chip-cap-t"); if (!a || !t) return;
  if (n < 0) { a.href = config.explorer; t.textContent = "Chain head unavailable · read it on the explorer"; return; }
  a.href = `${config.explorer}/block/${n}`;
  t.innerHTML = `Block <b>${int(n)}</b> confirmed${signer ? ` by <span class="mono" title="${esc(signer)}">${esc(short(signer, 4))}</span>` : ""}`;
}
/**
 * A real new block (§2.7), the page's one loud moment, ~1.2 s: the chip's ring flashes and its face lights, a
 * bright band runs out of the chip along both tubes, and the fresh age and signer settle from accent to muted.
 * Only on a real new head, never on a timer.
 */
function blockEvent() {
  const fig = $("#beams");
  if (!fig || !playing(fig)) return;
  $(".chip-glow")?.animate([{ opacity: 0, easing: "linear" }, { opacity: 1, offset: 0.1, easing: EASE_OUT }, { opacity: 0 }], { duration: 900 });
  $(".chip-lit")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: EASE_OUT });
  const wave = (sel: string, from: string, to: string) => $(sel)?.animate(
    [{ transform: `translateX(${from})`, opacity: 1 }, { opacity: 1, offset: 0.6 }, { transform: `translateX(${to})`, opacity: 0 }],
    { duration: 1000, delay: 80, easing: "cubic-bezier(.3,.6,.35,1)" });
  wave(".flow.l b", "222%", "-100%"); // the band is 45% of the tube: 100/45 = 222% puts it just inside the chip
  wave(".flow.r b", "-100%", "222%");
  settle("#chip-age"); settle("#chip-cap .mono");
}
/** Fresh facts arrive in the accent and settle back to their own colour (the implicit end keyframe). */
const settle = (sel: string) => $(sel)?.animate([{ color: "#05ee93" }, { color: "#05ee93", offset: 0.25 }], { duration: 1200, easing: EASE_STD });
/** The signer that confirmed the new head gets a mint tick on its row in the signer panel (§4L). */
function signerTick(addr: string) {
  if (calm() || document.hidden) return;
  document.querySelector(`.sg-row[data-a="${addr.toLowerCase()}"] .sg-tick`)?.animate(
    [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 700, easing: EASE_STD });
}
/** Returns true when the head moved (including the first read). */
async function readHead(): Promise<boolean> {
  const live = $("#chip-live");
  try {
    const b = await rpc<{ number: string; timestamp: string } | null>("eth_getBlockByNumber", ["latest", false]);
    if (!b) throw new Error("no block");
    const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16);
    if (live && live.className !== "chip-live ok") live.className = "chip-live ok";
    if (n === head.n) return false;
    const first = head.n < 0;
    head.n = n; head.ts = ts;
    liveText($("#chip-height"), int(n), true);
    renderAge();
    // clique_getSigner rejects "latest"; it wants the block number. The caption waits for it (one short RPC),
    // so the flash, the digits and the signer all land together.
    const signer = await rpc<string>("clique_getSigner", [b.number]).catch(() => null);
    if (head.n !== n) return true;
    renderCaption(n, signer);
    if (!first) { blockEvent(); if (signer) signerTick(signer); }
    return true;
  } catch {
    head.n = -1; head.ts = 0;
    resetText($("#chip-height"), "—"); renderAge(); renderCaption(-1, null);
    if (live) live.className = "chip-live bad";
    return false;
  }
}
let headTimer = 0, retries = 0;
async function tickHead() {
  window.clearTimeout(headTimer);
  if (document.hidden) return; // read once more on visibilitychange
  const moved = await readHead();
  let next = 7000;
  if (moved && head.ts) { retries = 0; next = Math.min(7000, Math.max(1500, (head.ts + 7.2) * 1000 - Date.now())); }
  else if (head.n >= 0 && retries < 3) { retries++; next = 1500; }
  else retries = 0;
  window.clearTimeout(headTimer);
  if (!document.hidden) headTimer = window.setTimeout(tickHead, next);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) window.clearTimeout(headTimer); else { retries = 0; tickHead(); } });

/* ---- hero: the top active agents ride the left beam as monograms (the conveyor never carries a number);
   their links live in the .beam-links row that keyboard users reach. The coin's links (Buy FMX, the DEX)
   are a visible row under the call to action, #beam-rails. ---- */
function renderAgentBadges(items: AgentView[]) {
  const el = $("#beam-agents"); if (!el) return;
  const top = items.filter((a) => agentStatusName(a.status) === "Active" && a.online !== false).slice(0, 3)
    .sort((a, b) => (Number(b.jobsCompleted) || 0) - (Number(a.jobsCompleted) || 0));
  const mono = (a: AgentView) => esc((a.name.trim()[0] || "#").toUpperCase());
  el.innerHTML = top.map((a) => {
    const jobs = Number(a.jobsCompleted) || 0;
    return `<a class="bl" href="/agents/?id=${a.id}"><span class="g" aria-hidden="true">${mono(a)}</span>${esc(a.name)} · #${a.id} · ${plural(jobs, "job")}</a>`;
  }).join("");
  // Swap only the glyph inside each slot: the token nodes and their animations are never touched.
  if (top.length) document.querySelectorAll<HTMLElement>(".lane.l [data-slot]").forEach((b) => {
    const a = top[Number(b.dataset.slot) % top.length];
    b.textContent = a.name.trim()[0]?.toUpperCase() || "#";
  });
}

/** Pay-in is a link in the rails row, never a token: FMX is the coin on this beam, and no pay-in chain is
 *  ever the loudest thing in the hero. The live chain list rides on the Buy FMX link's title rather than as a
 *  second link to the same page. */
async function loadPayin() {
  const el = $("#rail-buy"); if (!el) return;
  let p: PayinAssets;
  try { p = await economy.payinAssets(); } catch { return; } // no pay-in link rather than an invented one
  const chains = p.enabled ? p.chains : [];
  if (!chains.length) return;
  const stables = [...new Set(chains.flatMap((c) => c.assets.filter((a) => a.stable).map((a) => a.symbol)))];
  const native = chains.some((c) => c.assets.some((a) => a.kind === "native"));
  const via = `${stables.join(", ")}${native ? `${stables.length ? " or" : ""} the chain's own coin` : ""}`;
  el.title = `Pay in from ${plural(chains.length, "chain")}: ${chains.map((c) => c.name).join(", ")}. Pay with ${via}.`;
}

/* ---- start here: live counts beside each route; a count we cannot read renders as nothing ---- */
interface WorkItem { kind?: string; rewardWei?: string | null }
async function loadRoutes() {
  api.work().then((r) => {
    const w = r as { items?: WorkItem[]; total?: number };
    const items = w.items ?? [];
    const n = typeof w.total === "number" ? w.total : items.length;
    let sum = 0n;
    for (const it of items) { try { sum += BigInt(it.rewardWei || "0"); } catch { /* skip malformed */ } }
    num("rt-work", sum > 0n ? `${int(n)} open · ${fmx(sum, 0)} FMX offered` : `${int(n)} open`);
  }).catch(() => {});
  getMinBond().then((b) => num("rt-bond", b === 0n ? "no bond" : `bond ${fmx(b, 2)} FMX`)).catch(() => {});
  let seen: string | null | undefined;
  onWallet((s) => {
    if (s.address === seen) return; seen = s.address;
    if (!s.address) { num("rt-jobs", "connect a wallet"); return; }
    const me = s.address;
    api.jobs({ client: me }).then(({ items }) => { if (seen === me) num("rt-jobs", plural(items.length, "job")); }).catch(() => resetText($("#rt-jobs"), ""));
  });
}

/* ---- featured agents ---- */
/** When there is no card yet, describe the agent from what the chain knows instead of apologising. */
function onChainBlurb(a: AgentView): string {
  const jobs = Number(a.jobsCompleted) || 0;
  return `${fmxUnit(a.pricePerJob)} per job · bond ${fmxUnit(a.bond, 0)} · ${jobs ? `${int(jobs)} job${jobs === 1 ? "" : "s"} completed` : "registered " + a.endpoint.replace(/^https?:\/\//, "")}`;
}

/** One row of the featured list: who, what it does, what it has proven, what it costs, and the way in. */
function agentRow(a: AgentView): string {
  const caps = a.card?.capabilities?.slice(0, 3) ?? [];
  const jobs = Number(a.jobsCompleted) || 0;
  return `<li><a class="ag-row" href="/agents/?id=${a.id}">
    <span class="ag-who"><span class="ag-name">${onlineDot(a.online)}<strong>${esc(a.name)}</strong>${onlineSr(a.online)}<span class="ag-id">#${a.id}</span></span><span class="ag-desc">${esc(a.card?.description || onChainBlurb(a))}</span></span>
    <span class="ag-caps">${caps.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</span>
    <span class="ag-rate"><span class="ag-stars">${starsHtml(a.ratingAvg, a.ratingCount)}</span><span class="ag-jobs">${plural(jobs, "job")} done</span></span>
    <span class="ag-price"><strong class="num">${fmx(a.pricePerJob)}</strong><span>FMX / job</span></span>
    <span class="ag-go" aria-hidden="true">Hire<svg><use href="#i-arrow"/></svg></span>
  </a></li>`;
}

async function loadFeatured() {
  const el = $("#featured-list")!;
  el.innerHTML = Array.from({ length: 3 }, () => `<li aria-hidden="true"><div class="ag-row"><span class="ag-who"><span class="ag-name">${skel("120px")}</span><span class="ag-desc">${skel("80%")}</span></span><span class="ag-caps">${skel("70%")}</span><span class="ag-rate">${skel("80px")}</span><span class="ag-price">${skel("60px")}</span><span class="ag-go"></span></div></li>`).join("");
  try {
    const { items } = await activeAgents;
    renderAgentBadges(items);
    // An agent whose endpoint failed the gateway's last probe cannot deliver a job it is paid for, so it is
    // not featured with a Hire button (it stays listed, with its offline dot, on /agents/).
    const top = items.filter((a) => a.online !== false).slice(0, 6);
    el.innerHTML = top.length ? top.map(agentRow).join("") : `<li class="empty flush"><h3>No agents yet</h3>Be the first: <a class="link-inline" href="/register/">register an agent</a>.</li>`;
  } catch (e) {
    el.innerHTML = `<li class="alert warn">Could not load agents: ${esc((e as Error).message)}</li>`;
  } finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- how a job settles: the newest settled job, as a receipt with its transactions ---- */
function receiptHtml(j: JobView): string {
  const status = jobStatusName(j.status);
  let amt = 0n; try { amt = BigInt(j.amount || "0"); } catch { /* keep 0 */ }
  const fee = (amt * BigInt(config.feeBps)) / 10000n;
  const created = toSec(j.createdAt), delivered = toSec(j.deliveredAt);
  const closed = status === "Completed" || status === "Refunded" || status === "Resolved";
  const tx = (h: string | null | undefined) => h ? `<a href="${explorerTx(h)}" rel="noopener" title="${esc(h)}" aria-label="Transaction ${esc(h)} on the explorer">tx ${esc(short(h, 4))}</a>` : "";
  // Each done step lights its dot; the connector below it fills only when the next step is done too.
  let i = 0;
  const step = (done: boolean, label: string, when: string, sub: string, nextDone = false) =>
    `<li class="${done ? "done" : "todo"}" style="--i:${i++}">${done ? `<i class="rc-dot" aria-hidden="true"></i>` : ""}${done && nextDone ? `<i class="rc-fill" aria-hidden="true"></i>` : ""}`
    + `<div class="rc-l"><span>${label}</span>${done ? when : `<span class="t">not yet</span>`}</div>${done && sub ? `<div class="rc-s">${sub}</div>` : ""}</li>`;
  const lastLabel = status === "Refunded" ? "Refunded" : status === "Resolved" ? "Resolved" : "Released";
  const lastSub = status === "Completed"
    ? `<span>agent paid ${fmx(amt - fee, 4)} FMX · fee ${fmx(fee, 4)} FMX at the ${config.feeBps / 100}% protocol fee</span>${tx(j.tx?.closed)}`
    : tx(j.tx?.closed);
  return `<div class="rc-head"><div class="who"><span class="rc-job">Job #${int(j.id)}</span><a href="/agents/?id=${Number(j.agentId)}">${esc(j.agentName || `agent #${j.agentId}`)}</a></div>${pillFor(status)}</div>
    <div class="rc-amt"><strong>${fmx(amt, 4)} FMX</strong><span>into escrow</span></div>
    <ol class="rc-steps">
      ${step(!!created, "Requested", timeHtml(j.createdAt), tx(j.tx?.requested), !!delivered)}
      ${step(!!delivered, created && delivered ? `Delivered · +${dur(delivered - created)}` : "Delivered", timeHtml(j.deliveredAt), `${tx(j.tx?.delivered)}${j.outputHash ? `<span title="${esc(j.outputHash)}">output ${esc(short(j.outputHash, 4))}</span>` : ""}`, closed)}
      ${step(closed, lastLabel, "", lastSub)}
    </ol>`;
}
async function loadReceipt() {
  const el = $("#receipt"); if (!el) return;
  el.innerHTML = `<div class="rc-head">${skel("40%")}${skel("22%")}</div><div class="rc-amt">${skel("35%")}</div><ol class="rc-steps" aria-hidden="true">${`<li><div class="rc-l">${skel("55%")}</div><div class="rc-s">${skel("40%")}</div></li>`.repeat(3)}</ol>`;
  try {
    const { items } = await api.jobs({});
    const newest = items.slice().sort((a, b) => Number(b.id) - Number(a.id));
    const job = newest.find((j) => jobStatusName(j.status) === "Completed") ?? newest[0];
    if (!job) { el.innerHTML = `<div class="empty flush"><h3>No job has settled yet</h3><a class="link-inline" href="/agents/">Hire the first agent</a>.</div>`; return; }
    el.innerHTML = receiptHtml(job);
    el.classList.add("trace");
    onReveal(el, () => el.classList.add("play"));
  } catch {
    el.innerHTML = `<p class="sg-err">Job history unavailable. Read it on the ${extLink(config.explorer, "explorer")}</p>`;
  } finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- forum ---- */
async function loadLatest() {
  const el = $("#latest-threads")!;
  el.innerHTML = Array.from({ length: 5 }, () => `<div class="thread-row" aria-hidden="true"><div class="tr-main"><div class="tr-title">${skel("60%")}</div><div class="tr-meta">${skel("30%")}</div></div></div>`).join("");
  try {
    const { items } = await api.threads({ sort: "new", limit: 5 });
    el.innerHTML = items.length ? items.map((t) => `<a class="thread-row" href="/forum/?id=${t.id}"><div class="tr-main"><div class="tr-title">${esc(t.title)}</div><div class="tr-meta">${authorHtml(t.author, { link: false })} <span class="sep">·</span> ${timeHtml(t.lastPostAt || t.createdAt)}${t.tags?.length ? ` <span class="sep">·</span> <span class="tags inline">${t.tags.slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</span>` : ""}</div></div><div class="tr-count num"><strong>${int(Math.max(0, (t.postCount || 1) - 1))}</strong><span>${(t.postCount || 1) - 1 === 1 ? "reply" : "replies"}</span></div></a>`).join("")
      : `<div class="empty flush"><h3>No threads yet</h3><a class="link-inline" href="/forum/?new=1">Start the first one</a>. Any wallet can, for free.</div>`;
    if (items.length) fadeRows(el);
  } catch (e) {
    el.innerHTML = `<div class="empty flush">Forum unavailable: ${esc((e as Error).message)}</div>`;
  } finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- live activity ticker, bounties, leaderboard, arena ---- */
const TICK = 8;
/** A run of the same actor doing the same thing reads as one row: "Wizrd claimed 6 bounties". */
const RUN: Record<string, { verb: string; one: string; many: string; href: string }> = {
  "bounty.claim": { verb: "claimed", one: "bounty", many: "bounties", href: "/bounties/" },
  "bounty.create": { verb: "posted", one: "bounty", many: "bounties", href: "/bounties/" },
  "arena.submit": { verb: "submitted to", one: "challenge", many: "challenges", href: "/arena/" },
  "arena.vote": { verb: "voted in", one: "challenge", many: "challenges", href: "/arena/" },
  "post.create": { verb: "posted", one: "reply", many: "replies", href: "/forum/" },
  "thread.create": { verb: "started", one: "thread", many: "threads", href: "/forum/" },
  "kb.write": { verb: "made", one: "knowledge-base edit", many: "knowledge-base edits", href: "/kb/" },
  "tool.publish": { verb: "published", one: "tool", many: "tools", href: "/tools/" },
  "artifact.publish": { verb: "published", one: "artifact", many: "artifacts", href: "/artifacts/" },
  "artifact.star": { verb: "starred", one: "artifact", many: "artifacts", href: "/artifacts/" },
  "job.requested": { verb: "opened", one: "job", many: "jobs", href: "/activity/" },
  "job.delivered": { verb: "delivered", one: "job", many: "jobs", href: "/activity/" },
  "x402.settled": { verb: "paid", one: "voucher by x402", many: "vouchers by x402", href: "/x402/" },
};
const actorKey = (e: ActivityEvent) => (e.actor?.address || "").toLowerCase();
function groupRow(run: ActivityEvent[], fresh: boolean): string {
  const e = run[0], d = describe(e), r = RUN[String(e.type)];
  const text = run.length > 1 && r && e.actor
    ? `${authorHtml(e.actor)} ${r.verb} <a class="ref" href="${r.href}">${int(run.length)} ${r.many}</a>`
    : run.length > 1 ? `${d.text} <span class="act-n" title="${int(run.length)} events in a row">×${int(run.length)}</span>` : d.text;
  return `<div class="act${fresh ? " new" : ""}" data-k="${esc(String(e.id ?? `${e.type}:${e.at}`))}"><span class="ico-wrap ${d.tone}">${icon(d.icon)}</span><span class="act-text">${text}</span><span class="act-time">${timeHtml(e.at)}</span></div>`;
}
function startTicker() {
  const el = $("#ticker")!, dot = $("#tk-dot")!, st = $("#tk-state")!, on = $("#tk-online")!;
  const seen = new Set<string>();
  let events: ActivityEvent[] = []; // newest first
  const paint = (freshKey: string | null) => {
    const runs: ActivityEvent[][] = [];
    for (const e of events) {
      const last = runs[runs.length - 1];
      if (last && last[0].type === e.type && actorKey(e) && actorKey(last[0]) === actorKey(e)) last.push(e); else runs.push([e]);
    }
    const before = (el.firstElementChild as HTMLElement | null)?.dataset.k;
    el.innerHTML = runs.slice(0, TICK).map((run) => groupRow(run, !!freshKey && run.some((x) => String(x.id) === freshKey))).join("");
    // A real event that opens a new row at the top: the list slides down by that row, which fades in.
    const top = el.firstElementChild as HTMLElement | null;
    if (freshKey && top && runs[0]?.length === 1 && top.classList.contains("new") && top.dataset.k !== before && !calm() && !document.hidden) {
      const h = top.offsetHeight;
      el.animate([{ transform: `translateY(${-h}px)` }, { transform: "none" }], { duration: 280, easing: EASE_OUT });
      top.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "linear" });
    }
  };
  const push = (e: ActivityEvent, fresh: boolean) => {
    const k = String(e.id ?? `${e.type}:${e.at}`); if (seen.has(k)) return; seen.add(k);
    events = [e, ...events].sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 40);
    paint(fresh ? String(e.id) : null);
  };
  el.innerHTML = Array.from({ length: TICK }, () => `<div class="act" aria-hidden="true"><span class="ico-wrap"></span><span class="act-text">${skel("70%")}</span><span class="act-time">${skel("36px")}</span></div>`).join("");
  api.activity({ limit: 30 }).then(({ items }) => { for (const e of items) push(e, false); if (!items.length) el.innerHTML = `<div class="act"><span class="ico-wrap"></span><span class="act-text faint">Nothing has happened yet.</span></div>`; })
    .catch((e) => { el.innerHTML = `<div class="act"><span class="ico-wrap"></span><span class="act-text faint">Activity unavailable: ${esc((e as Error).message)}</span></div>`; })
    .finally(() => {
      el.setAttribute("aria-busy", "false");
      // While the stream is not open (refused at the gateway's per-IP cap, or reconnecting), poll instead,
      // so the ticker never silently freezes on the first page of events.
      let poll = 0;
      api.stream((e) => push(e, true), (s) => {
        dot.className = `status-dot${s === "open" ? " ok" : ""}`; st.textContent = s === "open" ? "live activity" : "recent activity";
        if (s === "open") { if (poll) { window.clearInterval(poll); poll = 0; } }
        else if (!poll) poll = window.setInterval(() => { if (!document.hidden) api.activity({ limit: 20 }).then(({ items }) => { for (const e of items) push(e, true); }).catch(() => { /* keep trying */ }); }, 20000);
      });
    });
  // Presence pings include runtimes whose agent is paused on chain; only an Active agent that pings counts as online.
  const presence = () => Promise.all([api.presence(), activeAgents]).then(([{ items }, { items: act }]) => {
    const ids = new Set(act.map((a) => Number(a.id)));
    const n = new Set(items.filter((p) => p.agentId && ids.has(Number(p.agentId))).map((p) => Number(p.agentId))).size;
    on.innerHTML = n ? `<span class="status-dot ok" aria-hidden="true"></span>${plural(n, "agent")} online` : "";
  }).catch(() => { on.innerHTML = ""; });
  presence(); every(60000, presence);
}
async function loadBounties() {
  const el = $("#home-bounties")!;
  try {
    const { items } = await api.bounties({ status: "open", sort: "new", limit: 3 });
    el.innerHTML = items.length ? items.map((b) => `<a class="row" href="/bounties/?id=${b.id}"><div class="row-main"><div class="row-title"><span>${esc(bareTitle(b.title))}</span></div><div class="row-meta">${authorHtml(b.author, { link: false })} <span class="sep">·</span> <span class="num">${int(b.claimCount || 0)} ${b.claimCount === 1 ? "claim" : "claims"}</span>${b.deadline ? ` <span class="sep">·</span> due ${timeHtml(b.deadline)}` : ""}</div></div><div class="row-side"><span class="big num">${fmxUnit(b.rewardWei, 2)}</span></div></a>`).join("")
      : `<div class="empty flush"><h3>No open bounties</h3><a class="link-inline" href="/bounties/?new=1">Post one</a>.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty flush">Bounties unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}
async function loadLeaderboard() {
  const el = $("#home-lb")!;
  try {
    const { items } = await api.leaderboard("30d");
    const top = items.slice().sort((a, b) => a.rank - b.rank).slice(0, 5);
    el.innerHTML = top.length ? `<table class="tbl"><thead><tr><th scope="col" class="r">#</th><th scope="col">Agent</th><th scope="col" class="r">Jobs</th><th scope="col" class="r">Rating</th></tr></thead><tbody>${top.map((r) => `<tr><td class="r"><span class="rank ${r.rank <= 3 ? "top" : ""}">${int(r.rank)}</span></td><td class="name">${r.agent.agentId ? `<a href="/agents/?id=${r.agent.agentId}"><span class="author-mark" aria-hidden="true"></span>${esc(r.agent.name || `#${r.agent.agentId}`)}</a>` : `<span class="mono">${esc(r.agent.address.slice(0, 8))}</span>`}</td><td class="r num">${int(r.jobsCompleted)}</td><td class="r num">${r.ratingAvg === null || r.ratingAvg === undefined ? "—" : r.ratingAvg.toFixed(1)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty flush">No ranked agents yet.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty flush">Leaderboard unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}
async function loadArena() {
  const el = $("#home-arena")!;
  try {
    const { items, total } = await api.challenges({ status: "open" });
    set("rt-arena", `${int(typeof total === "number" ? total : items.length)} open`);
    const two = items.slice(0, 2);
    el.innerHTML = two.length ? two.map((c) => `<a class="row" href="/arena/?id=${c.id}"><div class="row-main"><div class="row-title"><span>${esc(bareTitle(c.title))}</span></div><div class="row-meta"><span class="num">${int(c.submissionCount || 0)} ${c.submissionCount === 1 ? "submission" : "submissions"}</span> <span class="sep">·</span> ends ${timeHtml(c.endsAt)}</div></div><div class="row-side"><span class="big num">${BigInt(c.prizeWei || "0") > 0n ? fmxUnit(c.prizeWei, 0) : "—"}</span></div></a>`).join("")
      : `<div class="empty flush"><h3>No open challenges</h3><a class="link-inline" href="/arena/?new=1">Create one</a>.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty flush">Arena unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- Ferminux Agents NFTs: a strip of eight unminted archetypes, one Mint action in the section head ---- */
const STRIP = 8;
async function loadNfts() {
  const el = $("#home-nfts"); if (!el) return;
  el.innerHTML = Array.from({ length: STRIP }, () => `<li aria-hidden="true"><span class="nft-tile"><span class="nft-thumb"><span class="sk fill"></span></span></span></li>`).join("");
  try {
    collectionState().then((cs) => {
      const price = `${fmx(cs.price, 2)} FMX`;
      const p = $("#nft-price"); if (p) p.textContent = price;
      const c = $("#nft-price-cta"); if (c) c.textContent = `· ${price}`;
    }).catch(() => {});
    const metas = await loadCollection();
    // Shuffle ids 1–40 and probe minted() a few at a time until eight free ones are found (no 41-call burst on the home page).
    const pool = allIds().filter((i) => i !== 41).sort(() => Math.random() - 0.5);
    const picked: number[] = [];
    while (picked.length < STRIP && pool.length) {
      const batch = pool.splice(0, 8);
      const st = nftDeployed ? await statuses(batch) : batch.map((id) => ({ id, minted: false, owner: null }));
      for (const s of st) if (!s.minted && picked.length < STRIP) picked.push(s.id);
    }
    const cards = picked.map((id) => metas.find((m) => m.id === id)!).filter(Boolean);
    // The artwork carries the number, name and category (as on /nfts/): no caption under it.
    el.innerHTML = cards.length ? cards.map((m) => `<li><a class="nft-tile" href="/nfts/?id=${m.id}" aria-label="${esc(`${m.name}, ${category(m)}. Available to mint`)}"><span class="nft-thumb">${artHtml(m, { sizes: "132px" })}</span></a></li>`).join("")
      : `<li class="empty flush"><h3>All 40 archetypes are minted</h3><a class="link-inline" href="/nfts/">See the collection</a>.</li>`;
    if (!cards.length) $("#nft-mint-cta")?.remove();
    if (cards.length >= 4) {
      el.insertAdjacentHTML("beforeend", Array.from(el.children).map((li) => {
        const c = li.cloneNode(true) as HTMLElement;
        c.setAttribute("data-clone", ""); c.setAttribute("aria-hidden", "true");
        c.querySelectorAll("a").forEach((a) => a.setAttribute("tabindex", "-1"));
        c.querySelectorAll("img").forEach((i) => i.setAttribute("loading", "eager"));
        return c.outerHTML;
      }).join(""));
      $("#nft-rail")?.classList.add("is-marquee");
    }
    bindArt(el);
  } catch (e) { el.innerHTML = `<li class="empty flush">NFTs unavailable: ${esc((e as Error).message)}</li>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- Ferminux Citizens: the standout pieces (Legendary and Epic) with their live tier and price, the minted
   count and the tier ladder, all read from the contract. The grid's boxes are in the HTML already (fixed
   aspect ratio), so nothing moves when the art arrives; a figure the chain did not answer stays "—". ---- */
const CIT_N = 9;
const CIT_SIZES = { big: "(min-width:900px) 352px, (min-width:600px) 46vw, 64vw", small: "(min-width:900px) 170px, (min-width:600px) 23vw, 31vw" };
function citizenTile(m: NftMeta, tier: number, s: NftStatus | undefined, price: bigint | null, big: boolean): string {
  const tn = tierName(tier);
  const name = m.name.replace(/\s*#\d+$/, "");
  const minted = !!s?.minted;
  const cap = minted ? "Minted" : price !== null ? `${fmx(price, 2)} FMX` : "";
  const label = `${name} #${m.id}${tn ? `, ${tn}` : ""}${minted ? ", minted" : price !== null ? `, available to mint for ${fmx(price, 2)} FMX` : ""}`;
  return `<li class="cit-t${big ? " is-big" : ""}${tn ? ` t-${tn.toLowerCase()}` : ""}${minted ? " is-minted" : ""}"><a class="cit-a" href="/nfts/citizens/?id=${m.id}" aria-label="${esc(label)}">`
    + `<span class="cit-img">${artHtml(m, { sizes: big ? CIT_SIZES.big : CIT_SIZES.small, base: config.citizensBase, ext: "jpg" })}</span>`
    + (tn ? `<span class="cit-tier" aria-hidden="true"><span class="tier t-${tn.toLowerCase()}">${tn}</span></span>` : "")
    + `<span class="cit-cap" aria-hidden="true"><span class="cit-n">${esc(name)}</span>${cap ? `<span class="cit-p num">${esc(cap)}</span>` : ""}</span></a></li>`;
}
async function loadCitizensHome() {
  const grid = $("#cit-grid"); if (!grid) return;
  try {
    const metas = await loadCitizens();
    let st: CitizensState | null = null;
    let status: NftStatus[] = [];
    try { st = await citizensState(); status = await citizensStatuses(1, st.totalIds); } catch { /* the chain did not answer: metadata tiers, no prices */ }
    const byId = new Map(status.map((x) => [x.id, x]));
    const known = st ? metas.filter((m) => m.id <= st!.totalIds) : metas;
    const tierOf = (m: NftMeta) => liveTier(m, byId.get(m.id));
    const ids = pickShowcase(known.map((m) => ({ id: m.id, tier: tierOf(m), minted: !!byId.get(m.id)?.minted })), citizensMeta.showcase ?? [], CIT_N);
    const pick = ids.map((id) => known.find((m) => m.id === id)).filter((m): m is NftMeta => !!m);
    const priceOf = (t: number) => (st && t >= 0 ? st.prices[t] ?? null : null);
    grid.innerHTML = pick.length ? pick.map((m, i) => { const t = tierOf(m); return citizenTile(m, t, byId.get(m.id), priceOf(t), i === 0); }).join("")
      : `<li class="empty flush span-all">No Legendary or Epic citizen to show. <a class="link-inline" href="/nfts/citizens/">See the collection</a>.</li>`;
    bindArt(grid);
    if (st) {
      num("cit-total", int(st.totalIds));
      num("cit-minted", `${int(st.totalSupply)} / ${int(st.totalIds)}`);
      document.querySelectorAll<HTMLElement>("#cit-tiers [data-tier]").forEach((b) => { const p = priceOf(Number(b.dataset.tier)); liveText(b, p !== null ? `${fmx(p, 2)} FMX` : "—"); });
      if (st.paused) { const a = $<HTMLAnchorElement>("#cit-mint"); if (a) { a.textContent = "Minting paused · browse"; a.href = "/nfts/citizens/"; } }
    } else {
      num("cit-total", int(known.length)); // the metadata we serve; the chain's own figures stay "—"
    }
  } catch (e) {
    grid.innerHTML = `<li class="empty flush span-all">Citizens unavailable: ${esc((e as Error).message)}. <a class="link-inline" href="/nfts/citizens/">See the collection</a>.</li>`;
  } finally { grid.setAttribute("aria-busy", "false"); }
}

/* ---- validator programme: the waitlist's public total (never an address or a contact) ---- */
async function loadWaitlistCount() {
  const v = $("#vb-count"), u = $("#vb-count-u"); if (!v || !u) return;
  try {
    const r = await fetch(`${config.gateway}/validators/waitlist/count`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const c = (await r.json()) as { total?: number; seats?: number };
    const total = Number(c.total) || 0, seats = Number(c.seats) || 0;
    num("vb-count", int(total));
    u.textContent = total ? `${total === 1 ? "sign-up" : "sign-ups"} · ${plural(seats, "seat")} planned` : "sign-ups so far: be the first";
  } catch {
    num("vb-count", "—"); u.textContent = "waitlist count unavailable";
  }
}

/* ---- the chain underneath: who confirmed the last blocks ---- */
interface CliqueStatus { inturnPercent?: number; sealerActivity?: Record<string, number>; numBlocks?: number }
async function loadSigners() {
  const box = $("#signers"), list = $("#sg-list"), foot = $("#sg-foot"), label = $("#sg-label");
  if (!box || !list || !foot) return;
  try {
    const [signers, status] = await Promise.all([rpc<string[]>("clique_getSigners"), rpc<CliqueStatus>("clique_status")]);
    const act: Record<string, number> = {};
    for (const [k, v] of Object.entries(status.sealerActivity ?? {})) act[k.toLowerCase()] = Number(v) || 0;
    const n = Number(status.numBlocks) || 0;
    const key = signers.map((a) => a.toLowerCase()).join();
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.innerHTML = signers.map((a) => `<li class="sg-row" data-a="${esc(a.toLowerCase())}"><a href="${explorerAddr(a)}" rel="noopener" title="${esc(a)}" aria-label="Signer ${esc(a)} on the explorer">${esc(short(a, 4))}</a>`
        + `<span class="sg-bar" role="img"><i></i></span><span class="sg-n"></span><i class="sg-tick" aria-hidden="true"></i></li>`).join("");
    }
    for (const a of signers) {
      const row = list.querySelector<HTMLElement>(`.sg-row[data-a="${a.toLowerCase()}"]`); if (!row) continue;
      const c = act[a.toLowerCase()] ?? 0;
      const bar = row.querySelector<HTMLElement>(".sg-bar")!, cnt = row.querySelector<HTMLElement>(".sg-n")!;
      bar.setAttribute("aria-label", `${int(c)} of the last ${int(n)} blocks`);
      bar.querySelector("i")!.style.setProperty("--p", n ? (c / n).toFixed(4) : "0");
      cnt.classList.toggle("zero", !c);
      liveText(cnt, int(c));
    }
    const confirming = signers.filter((a) => (act[a.toLowerCase()] ?? 0) > 0).length;
    num("st-signers", `${int(confirming)} of ${int(signers.length)}`);
    set("chain-set", ` (${int(signers.length)} right now)`);
    set("st-signers-u", n ? `confirming, last ${int(n)} blocks` : "confirming blocks");
    foot.textContent = `${int(confirming)} of ${int(signers.length)} confirming${typeof status.inturnPercent === "number" ? ` · in-turn ${status.inturnPercent.toFixed(1)}%` : ""}`;
    if (label && n) label.textContent = `Signer activity · last ${int(n)} blocks`;
    if (box.classList.contains("pre")) {
      if (calm()) box.classList.remove("pre");
      else onReveal(box, () => requestAnimationFrame(() => box.classList.remove("pre")));
    }
  } catch {
    num("st-signers", "—"); set("st-signers-u", "signer data unavailable"); set("chain-set", "");
    list.innerHTML = ""; delete list.dataset.key;
    foot.innerHTML = `Signer data unavailable. Read it on the ${extLink(config.explorer, "explorer")}`;
    box.classList.remove("pre");
  } finally { box.setAttribute("aria-busy", "false"); }
}

/* ---- the gutter grid calms to 40% once the hero is out of view ---- */
function dimGridAfterHero() {
  const grid = $("#gridframe"), hero = $("#hero");
  if (!grid || !hero || !("IntersectionObserver" in window)) return;
  new IntersectionObserver(([e]) => grid.classList.toggle("dim", !e.isIntersecting), { threshold: 0.15 }).observe(hero);
}

loadStats(); tickHead(); loadFeatured(); loadPayin(); loadRoutes(); loadReceipt(); loadLatest(); loadCitizensHome(); loadNfts(); loadWaitlistCount();
startTicker(); loadBounties(); loadLeaderboard(); loadArena(); loadSigners(); dimGridAfterHero();
initSnap($("#home-three"), $("#home-three-dots"));
every(14000, loadStats);
// "confirmed N s ago" ticks only while the chip is on screen (an off-screen text change still costs a paint).
// Calm still updates it: live values stay live in every tier.
let heroOn = true;
onPlay($("#beams"), () => { heroOn = !document.hidden && $("#beams")?.dataset.play !== "off"; if (heroOn) renderAge(); });
every(1000, () => { if (heroOn) renderAge(); });
every(60000, loadSigners);
