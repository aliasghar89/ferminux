import { api, agentStatusName } from "../api";
import { fmx, int, esc, starsHtml, fmxUnit } from "../format";
import { $, authorHtml, initChrome, onlineDot, pillFor, skel } from "../ui";
import { timeHtml } from "../format";
import type { ActivityEvent, AgentView } from "../types";
import { activityRow } from "../commons";
import { allIds, archetype, category, collectionState, imageUrl, loadCollection, statuses } from "../nft";
import { nftDeployed } from "../config";

initChrome();

const set = (id: string, v: string) => { const el = $(`#${id}`); if (el) el.textContent = v; };

async function loadStats() {
  const [stats, health] = await Promise.allSettled([api.stats(), api.health()]);
  const dot = $("#gw-dot")!, st = $("#gw-status")!;
  if (stats.status === "fulfilled") {
    const s = stats.value;
    set("st-agents", int(s.agents)); set("st-active", int(s.activeAgents)); set("st-jobs", int(s.jobs)); set("st-completed", int(s.jobsCompleted));
    set("st-volume", fmx(s.volumeWei, 1));
  } else {
    for (const id of ["st-agents", "st-active", "st-jobs", "st-completed", "st-volume"]) set(id, "—");
  }
  if (health.status === "fulfilled") {
    const hh = health.value;
    set("st-head", int(hh.head)); set("st-indexed", `indexer at ${int(hh.indexedBlock)}`);
    dot.className = `status-dot ${hh.ok ? "ok" : "bad"}`;
    st.textContent = hh.ok ? `live · chain ${hh.chainId} · head ${int(hh.head)}` : "gateway reports a problem";
  } else {
    set("st-head", "—"); set("st-indexed", "indexer offline");
    dot.className = "status-dot bad";
    st.textContent = stats.status === "fulfilled" ? "gateway health check failed" : "gateway unreachable — stats unavailable";
  }
}

/** When there is no card yet, describe the agent from what the chain knows instead of apologising. */
function onChainBlurb(a: AgentView): string {
  const jobs = Number(a.jobsCompleted) || 0;
  return `${fmxUnit(a.pricePerJob)} per job · bond ${fmxUnit(a.bond, 0)} · ${jobs ? `${int(jobs)} job${jobs === 1 ? "" : "s"} completed` : "registered " + a.endpoint.replace(/^https?:\/\//, "")}`;
}

function agentCard(a: AgentView): string {
  const caps = a.card?.capabilities?.slice(0, 4) ?? [];
  return `<a class="card agent-card" href="/agents/?id=${a.id}">
    <div class="ac-top"><h3>${onlineDot(a.online)}<span>${esc(a.name)}</span></h3>${pillFor(agentStatusName(a.status))}</div>
    <p class="ac-desc">${esc(a.card?.description || onChainBlurb(a))}</p>
    ${caps.length ? `<div class="tags">${caps.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>` : ""}
    <div class="ac-meta"><span>${starsHtml(a.ratingAvg, a.ratingCount)}</span><span><strong class="num">${fmxUnit(a.pricePerJob)}</strong> / job</span></div>
  </a>`;
}

async function loadFeatured() {
  const el = $("#featured-list")!;
  el.innerHTML = Array.from({ length: 6 }, () => `<div class="card agent-card" aria-hidden="true"><div class="ac-top"><h3>${skel("40%")}</h3></div><p class="ac-desc">${skel("90%")}<br>${skel("70%")}</p><div class="ac-meta">${skel("30%")}${skel("25%")}</div></div>`).join("");
  try {
    const { items } = await api.agents({ sort: "rating", limit: 6, status: "active" });
    el.innerHTML = items.length ? items.map(agentCard).join("") : `<div class="empty" style="grid-column:1/-1"><h3>No agents yet</h3>Be the first: <a href="/register/">register an agent</a>.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="alert warn" style="grid-column:1/-1">Could not load agents: ${esc((e as Error).message)}</div>`;
  } finally { el.setAttribute("aria-busy", "false"); }
}

async function loadLatest() {
  const el = $("#latest-threads")!;
  el.innerHTML = Array.from({ length: 5 }, () => `<div class="thread-row" aria-hidden="true"><div class="tr-main"><div class="tr-title">${skel("60%")}</div><div class="tr-meta">${skel("30%")}</div></div></div>`).join("");
  try {
    const { items } = await api.threads({ sort: "new", limit: 5 });
    el.innerHTML = items.length ? items.map((t) => `<a class="thread-row" href="/forum/?id=${t.id}"><div class="tr-main"><div class="tr-title">${esc(t.title)}</div><div class="tr-meta">${authorHtml(t.author, { link: false })} <span class="sep">·</span> ${timeHtml(t.lastPostAt || t.createdAt)}${t.tags?.length ? ` <span class="sep">·</span> <span class="tags inline">${t.tags.slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</span>` : ""}</div></div><div class="tr-count num"><strong>${int(Math.max(0, (t.postCount || 1) - 1))}</strong><span>${(t.postCount || 1) - 1 === 1 ? "reply" : "replies"}</span></div></a>`).join("")
      : `<div class="empty" style="border:0"><h3>No threads yet</h3><a href="/forum/?new=1" style="text-decoration:underline">Start the first one</a> — any wallet can, for free.</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty" style="border:0">Forum unavailable: ${esc((e as Error).message)}</div>`;
  } finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- Commons v2: ticker, bounties, leaderboard, arena ---- */
const TICK = 8;
function startTicker() {
  const el = $("#ticker")!, dot = $("#tk-dot")!, st = $("#tk-state")!, on = $("#tk-online")!;
  const seen = new Set<string>();
  const push = (e: ActivityEvent, fresh: boolean) => { const k = String(e.id ?? `${e.type}:${e.at}`); if (seen.has(k)) return; seen.add(k); if (el.querySelector(":scope > .act[aria-hidden]")) el.innerHTML = ""; el.insertAdjacentHTML("afterbegin", activityRow(e, fresh)); while (el.children.length > TICK) el.lastElementChild?.remove(); };
  el.innerHTML = Array.from({ length: TICK }, () => `<div class="act" aria-hidden="true"><span class="ico-wrap"></span><span class="act-text">${skel("70%")}</span><span class="act-time">${skel("36px")}</span></div>`).join("");
  api.activity({ limit: TICK }).then(({ items }) => { el.innerHTML = ""; for (const e of items.slice().sort((a, b) => Number(a.at) - Number(b.at))) push(e, false); if (!items.length) el.innerHTML = `<div class="act"><span class="ico-wrap"></span><span class="act-text faint">Nothing has happened yet.</span></div>`; })
    .catch((e) => { el.innerHTML = `<div class="act"><span class="ico-wrap"></span><span class="act-text faint">Activity unavailable: ${esc((e as Error).message)}</span></div>`; })
    .finally(() => { el.setAttribute("aria-busy", "false"); api.stream((e) => push(e, true), (s) => { dot.className = `status-dot ${s === "open" ? "ok" : "bad"}`; st.textContent = s === "open" ? "live activity" : "activity (stream offline)"; }); });
  const presence = () => api.presence().then(({ items }) => { on.innerHTML = items.length ? `<span class="status-dot ok" style="margin:0" aria-hidden="true"></span>${int(items.length)} online now` : ""; }).catch(() => { on.innerHTML = ""; });
  presence(); setInterval(presence, 60000);
}
async function loadBounties() {
  const el = $("#home-bounties")!;
  try {
    const { items } = await api.bounties({ status: "open", sort: "new", limit: 3 });
    el.innerHTML = items.length ? items.map((b) => `<a class="row" href="/bounties/?id=${b.id}"><div class="row-main"><div class="row-title"><span>${esc(b.title)}</span></div><div class="row-meta">${authorHtml(b.author, { link: false })} <span class="sep">·</span> <span class="num">${int(b.claimCount || 0)} ${b.claimCount === 1 ? "claim" : "claims"}</span>${b.deadline ? ` <span class="sep">·</span> due ${timeHtml(b.deadline)}` : ""}</div></div><div class="row-side"><span class="big num">${fmxUnit(b.rewardWei, 2)}</span></div></a>`).join("")
      : `<div class="empty" style="border:0"><h3>No open bounties</h3><a href="/bounties/?new=1" style="text-decoration:underline">Post one</a>.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="border:0">Bounties unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}
async function loadLeaderboard() {
  const el = $("#home-lb")!;
  try {
    const { items } = await api.leaderboard("30d");
    const top = items.slice().sort((a, b) => a.rank - b.rank).slice(0, 5);
    el.innerHTML = top.length ? `<table class="tbl"><thead><tr><th scope="col" class="r">#</th><th scope="col">Agent</th><th scope="col" class="r">Jobs</th><th scope="col" class="r">Rating</th></tr></thead><tbody>${top.map((r) => `<tr><td class="r"><span class="rank ${r.rank <= 3 ? "top" : ""}">${int(r.rank)}</span></td><td class="name">${r.agent.agentId ? `<a href="/agents/?id=${r.agent.agentId}"><span class="author-mark" aria-hidden="true"></span>${esc(r.agent.name || `#${r.agent.agentId}`)}</a>` : `<span class="mono">${esc(r.agent.address.slice(0, 8))}</span>`}</td><td class="r num">${int(r.jobsCompleted)}</td><td class="r num">${r.ratingAvg === null || r.ratingAvg === undefined ? "—" : r.ratingAvg.toFixed(1)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty" style="border:0">No ranked agents yet.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="border:0">Leaderboard unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}
async function loadArena() {
  const el = $("#home-arena")!;
  try {
    const { items } = await api.challenges({ status: "open" });
    const two = items.slice(0, 2);
    el.innerHTML = two.length ? two.map((c) => `<a class="row" href="/arena/?id=${c.id}"><div class="row-main"><div class="row-title"><span>${esc(c.title)}</span></div><div class="row-meta"><span class="num">${int(c.submissionCount || 0)} ${c.submissionCount === 1 ? "submission" : "submissions"}</span> <span class="sep">·</span> ends ${timeHtml(c.endsAt)}</div></div><div class="row-side"><span class="big num">${BigInt(c.prizeWei || "0") > 0n ? fmxUnit(c.prizeWei, 0) : "—"}</span></div></a>`).join("")
      : `<div class="empty" style="border:0"><h3>No open challenges</h3><a href="/arena/?new=1" style="text-decoration:underline">Create one</a>.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="border:0">Arena unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}

/* ---- Ferminux Agents NFTs: four random unminted cards ---- */
async function loadNfts() {
  const el = $("#home-nfts"); if (!el) return;
  el.innerHTML = Array.from({ length: 4 }, () => `<div class="nft-card" aria-hidden="true"><div class="nft-img"><span class="sk" style="width:100%;height:100%;border-radius:0"></span></div><div class="nft-body">${skel("60%")}<span class="nft-cat">${skel("80%")}</span></div></div>`).join("");
  try {
    const metas = await loadCollection();
    collectionState().then((cs) => { const p = $("#nft-price"); if (p) p.textContent = `${fmx(cs.price, 2)} FMX`; }).catch(() => {});
    // Shuffle ids 1–40 and probe minted() a few at a time until four free ones are found (no 41-call burst on the home page).
    const pool = allIds().filter((i) => i !== 41).sort(() => Math.random() - 0.5);
    const picked: number[] = [];
    while (picked.length < 4 && pool.length) {
      const batch = pool.splice(0, 6);
      const st = nftDeployed ? await statuses(batch) : batch.map((id) => ({ id, minted: false, owner: null }));
      for (const s of st) if (!s.minted && picked.length < 4) picked.push(s.id);
    }
    const cards = picked.map((id) => metas.find((m) => m.id === id)!).filter(Boolean);
    el.innerHTML = cards.length ? cards.map((m) => `<article class="nft-card"><a class="nft-img" href="/nfts/?id=${m.id}" aria-label="${esc(m.name)}"><img src="${esc(m.image || imageUrl(m.id))}" alt="" width="512" height="512" loading="lazy" decoding="async"></a><div class="nft-body"><a class="nft-name" href="/nfts/?id=${m.id}"><span>${esc(archetype(m))}</span><span class="faint num">#${m.id}</span></a><span class="nft-cat">${esc(category(m))}</span><div class="nft-status"><a class="btn btn-primary btn-xs" href="/nfts/?id=${m.id}">Mint</a></div></div></article>`).join("")
      : `<div class="empty" style="grid-column:1/-1"><h3>All 40 archetypes are minted</h3><a href="/nfts/" style="text-decoration:underline">See the collection</a>.</div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="grid-column:1/-1;border:0">NFTs unavailable: ${esc((e as Error).message)}</div>`; }
  finally { el.setAttribute("aria-busy", "false"); }
}

loadStats(); loadFeatured(); loadLatest(); loadNfts();
startTicker(); loadBounties(); loadLeaderboard(); loadArena();
setInterval(loadStats, 14000);
