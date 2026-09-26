/* The agent card (§4.14, §6.3) on an agent owner's or an agent wallet's address page. All from the gateway's
   cached lists (agents, wallets, agent tokens): no request per card. Several agents per owner stack as compact
   cards with the first expanded. A gateway failure hides the cards and leaves one line (§8.3). */
import { html, type Html } from "../../ui/html";
import { addrChip } from "../../ui/hash";
import { agentStatusPill } from "../../ui/marks";
import { icon } from "../../ui/icons";
import { fmx, int, relTime, utc, safeHref } from "../../format";
import { agentLinks, type Agent, type AgentWallet, type AgentToken } from "../../gateway";
import { lc } from "../../util";

export interface AgentCtx { wallets: AgentWallet[]; tokens: AgentToken[]; /** the page's address: its chip is not a link */ self?: string }

const online = (a: Agent): Html =>
  a.online ? html`<span class="ad-ag-on"><span class="status-dot ok" aria-hidden="true"></span>online</span>`
    : a.lastSeen ? html`<span class="ad-ag-on faint"><span class="status-dot" aria-hidden="true"></span>last seen ${relTime(a.lastSeen)}</span>` : html``;
const rating = (a: Agent): Html =>
  a.ratingCount > 0 && a.ratingAvg !== null ? html`<span aria-hidden="true">★</span> ${a.ratingAvg.toFixed(1)} <span class="faint">(${int(a.ratingCount)})</span>` : html`<span class="ad-none">no ratings yet</span>`;
const bondZero = (a: Agent) => { try { return BigInt(a.bond || "0") === 0n; } catch { return false; } };

function full(a: Agent, x: AgentCtx, jobsTab: boolean): Html {
  const wallets = x.wallets.filter((w) => lc(w.owner) === lc(a.owner));
  const tokens = x.tokens.filter((t) => t.agentId === a.id);
  const links = agentLinks(a.id);
  return html`<section class="panel ad-ag" aria-labelledby="ag-${a.id}">
  <div class="ad-ag-top">${icon("i-bot", "ad-ag-g", 18)}<h2 class="ad-ag-n" id="ag-${a.id}">${a.name}</h2><span class="hc-id">#${a.id}</span>${agentStatusPill(a.status)}${online(a)}</div>
  <div class="statgrid ad-ag-stats">
    <div><span class="l">Jobs completed</span><span class="v">${int(a.jobsCompleted)}</span><span class="s">${int(a.jobsFailed)} failed</span></div>
    <div><span class="l">Rating</span><span class="v">${rating(a)}</span></div>
    <div><span class="l">Price per job</span><span class="v">${fmx(a.pricePerJob, 4)}<span class="unit">FMX</span></span></div>
    <div><span class="l">Bond</span><span class="v">${fmx(a.bond, 4)}<span class="unit">FMX</span></span>${bondZero(a) ? html`<span class="s">no bond required</span>` : ""}</div>
  </div>
  <dl class="ad-ag-meta">
    <div><dt>Registered</dt><dd><time datetime="${new Date(a.registeredAt * 1000).toISOString()}" title="${utc(a.registeredAt)}">${utc(a.registeredAt).slice(0, 10)}</time></dd></div>
    <div><dt>Owner</dt><dd>${addrChip(a.owner, { label: false, href: lc(a.owner) === lc(x.self) ? null : undefined })}</dd></div>
    <div><dt>Agent wallet</dt><dd>${wallets.length ? wallets.map((w) => addrChip(w.account, { label: false, href: lc(w.account) === lc(x.self) ? null : undefined })) : html`<span class="faint">none</span>`}</dd></div>
    <div><dt>Agent token</dt><dd>${tokens.length ? tokens.map((t) => html`<a class="ad-tok" href="/token/${t.token}">${t.symbol}</a>`) : html`<span class="faint">none</span>`}</dd></div>
    ${a.endpoint ? html`<div><dt>Endpoint</dt><dd><a class="mono ad-ag-ep" href="${safeHref(a.endpoint)}" rel="noopener" data-external>${a.endpoint.replace(/^https?:\/\//, "")}</a></dd></div>` : ""}
  </dl>
  <p class="ad-ag-links"><a class="link-arrow" href="${links.record}" rel="noopener" data-external>Agent record ↗</a><a class="link-arrow" href="${links.page}" rel="noopener" data-external>Agent page ↗</a>${jobsTab ? html`<button type="button" class="link-arrow ad-btn-link" data-jobs>Jobs</button>` : ""}</p>
</section>`;
}

const compact = (a: Agent): Html =>
  html`<li class="ad-ag-c"><a href="${agentLinks(a.id).record}" rel="noopener" data-external>${icon("i-bot", "ad-ag-g", 14)}<span class="hc-n">${a.name}</span><span class="hc-id">#${a.id}</span></a><span class="status-dot ${a.status === "Active" ? "ok" : ""}" title="${a.status}"></span><span class="faint">${a.status}</span><span class="faint">· ${int(a.jobsCompleted)} jobs · ${a.ratingCount ? `★ ${a.ratingAvg?.toFixed(1)}` : "no ratings"}</span></li>`;

/** The cards: the first agent expanded, the rest compact. */
export function agentCards(list: Agent[], x: AgentCtx, jobsTab: boolean): Html {
  if (!list.length) return html``;
  const [first, ...rest] = list;
  return html`${full(first, x, jobsTab)}${rest.length ? html`<ul class="ad-ag-more" aria-label="More agents of this owner">${rest.map(compact)}</ul>` : ""}`;
}
