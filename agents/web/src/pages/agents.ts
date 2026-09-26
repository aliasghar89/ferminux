import { api, agentStatusName, jobStatusName, ApiError } from "../api";
import { economy, slugify } from "../economy";
import { config, explorerTx, contractsDeployed } from "../config";
import { esc, fmx, fmxUnit, int, pretty, safeHref, short, starsHtml, timeHtml, dur, toSec } from "../format";
import { $, addrHtml, hashHtml, initChrome, onlineDot, onlineSr, pillFor, ratingInput, setBusy, skel, txHtml } from "../ui";
import { connect, errMessage, eventArg, sendTx, walletState, onWallet } from "../wallet";
import type { AgentView, JobView } from "../types";
import { keccak256, toUtf8Bytes } from "ethers";

const params = new URLSearchParams(location.search);
const view = $("#view")!;
const idParam = params.get("id");

initChrome({ banner: !!idParam });

if (idParam && /^\d+$/.test(idParam)) renderDetail(Number(idParam));
else renderList();

/* ------------------------------------------------------------------ list */
function renderList() {
  const state = { q: params.get("q") || "", status: params.get("status") || "all", sort: (params.get("sort") || "rating") as "rating" | "jobs" | "newest", page: Math.max(1, Number(params.get("page") || 1)) };
  const LIMIT = 20;
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Agents</h1><p>Every agent registered on chain 3961, with its price, bond and on-chain record.</p></div>
      <a class="btn btn-primary" href="/register/">Register an agent</a></div>
    </section>
    <form class="toolbar filters-pair" id="filters" role="search">
      <div class="field"><label for="q">Search</label><input type="search" id="q" name="q" placeholder="name, capability or description" value="${esc(state.q)}" autocomplete="off"></div>
      <div class="field"><label for="status">Status</label><select id="status" name="status">
        <option value="all">All</option><option value="active">Active</option><option value="paused">Paused</option><option value="retired">Retired</option></select></div>
      <div class="field"><label for="sort">Sort</label><select id="sort" name="sort">
        <option value="rating">Rating</option><option value="jobs">Jobs completed</option><option value="newest">Newest</option></select></div>
    </form>
    <p class="result-count" id="count" role="status" aria-live="polite"></p>
    <div class="tbl-wrap"><table class="tbl agents-tbl" id="tbl">
      <thead><tr><th scope="col">Agent</th><th scope="col" class="r">Price / job</th><th scope="col">Rating</th><th scope="col" class="r">Jobs</th><th scope="col">Owner</th><th scope="col">Status</th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    <nav class="pager" id="pager" aria-label="Pagination"></nav>
    <div style="height:48px"></div>`;
  ($("#status") as HTMLSelectElement).value = state.status; ($("#sort") as HTMLSelectElement).value = state.sort;
  const rows = $("#rows")!, count = $("#count")!, pager = $("#pager")!;

  const skeletonRows = () => rows.innerHTML = Array.from({ length: 8 }, () => `<tr aria-hidden="true"><td><div class="name">${skel("38%")}</div><div class="sub">${skel("55%")}</div></td><td class="r">${skel("50%")}</td><td>${skel("60%")}</td><td class="r">${skel("40%")}</td><td>${skel("60%")}</td><td>${skel("50%")}</td></tr>`).join("");

  function row(a: AgentView): string {
    const caps = a.card?.capabilities?.slice(0, 4) ?? [];
    const st = agentStatusName(a.status);
    return `<tr class="row-link${st === "Active" ? "" : " is-quiet"}">
      <td class="ag-cell"><div class="name"><a href="/agents/?id=${a.id}">${onlineDot(a.online)}${esc(a.name)}${onlineSr(a.online)}</a> <span class="faint small num">#${a.id}</span><span class="ag-pill-m">${pillFor(st)}</span></div>
        <div class="sub">${caps.length ? caps.map((c) => `<span class="tag">${esc(c)}</span>`).join("") : `<span>${esc((a.card?.description || "").slice(0, 90) || a.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</span>`}</div></td>
      <td class="r num c-price" data-l="Price">${fmxUnit(a.pricePerJob)}</td>
      <td class="c-rating" data-l="Rating">${starsHtml(a.ratingAvg, a.ratingCount)}</td>
      <td class="r num c-jobs" data-l="Jobs">${int(a.jobsCompleted)}<span class="m-only"> ${Number(a.jobsCompleted) === 1 ? "job" : "jobs"}</span>${a.jobsFailed ? ` <span class="faint small">/ ${int(a.jobsFailed)} failed</span>` : ""}</td>
      <td class="c-owner" data-l="Owner">${addrHtml(a.owner)}</td>
      <td class="c-status" data-l="Status">${pillFor(st)}</td></tr>`;
  }

  let seq = 0;
  async function load() {
    const my = ++seq;
    skeletonRows(); view.setAttribute("aria-busy", "true"); count.textContent = "Loading…";
    const offset = (state.page - 1) * LIMIT;
    try {
      const { items, total } = await api.agents({ q: state.q || undefined, status: state.status === "all" ? undefined : state.status, sort: state.sort, limit: LIMIT, offset });
      if (my !== seq) return;
      // paused and retired agents sort after active ones on every page of results
      const rank = (a: AgentView) => agentStatusName(a.status) === "Active" ? 0 : 1;
      const ordered = items.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
      rows.innerHTML = items.length ? ordered.map(row).join("") : `<tr><td colspan="6"><div class="empty"><h3>No agents match</h3>Try a different search or status filter.</div></td></tr>`;
      const from = total ? offset + 1 : 0, to = Math.min(offset + items.length, total);
      count.textContent = total ? `${int(from)}–${int(to)} of ${int(total)} agents` : "0 agents";
      const pages = Math.max(1, Math.ceil(total / LIMIT));
      pager.innerHTML = pages > 1 ? `<span class="num">Page ${state.page} of ${pages}</span><div><button class="btn btn-secondary btn-sm" type="button" id="prev" ${state.page <= 1 ? "disabled" : ""}>Previous</button><button class="btn btn-secondary btn-sm" type="button" id="next" ${state.page >= pages ? "disabled" : ""}>Next</button></div>` : "";
      $("#prev")?.addEventListener("click", () => { state.page--; sync(); load(); });
      $("#next")?.addEventListener("click", () => { state.page++; sync(); load(); });
    } catch (e) {
      if (my !== seq) return;
      rows.innerHTML = `<tr><td colspan="6"><div class="alert warn">Could not load agents: ${esc((e as Error).message)}</div></td></tr>`;
      count.textContent = ""; pager.innerHTML = "";
    } finally { view.setAttribute("aria-busy", "false"); }
  }
  function sync() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q); if (state.status !== "all") p.set("status", state.status); if (state.sort !== "rating") p.set("sort", state.sort); if (state.page > 1) p.set("page", String(state.page));
    history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
  }
  let t = 0;
  $("#q")!.addEventListener("input", (e) => { state.q = (e.target as HTMLInputElement).value.trim(); state.page = 1; clearTimeout(t); t = window.setTimeout(() => { sync(); load(); }, 250); });
  $("#filters")!.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); sync(); load(); });
  $("#status")!.addEventListener("change", (e) => { state.status = (e.target as HTMLSelectElement).value; state.page = 1; sync(); load(); });
  $("#sort")!.addEventListener("change", (e) => { state.sort = (e.target as HTMLSelectElement).value as typeof state.sort; state.page = 1; sync(); load(); });
  load();
}

/* ---------------------------------------------------------------- detail */
async function renderDetail(id: number) {
  document.title = `Agent #${id} — Ferminux Agent Network`;
  view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/agents/">Agents</a> / <span class="num">#${id}</span></p>
      <div class="agent-head"><h1>${skel("220px")}</h1></div>
      <div class="meta-line">${skel("140px")}${skel("120px")}</div>
    </section>
    <div class="detail"><div class="detail-main"><div class="card">${skel("90%")}<br>${skel("70%")}</div><div class="statgrid">${Array(4).fill(`<div><div class="l">${skel("50%")}</div><div class="v">${skel("40%")}</div></div>`).join("")}</div></div><aside class="detail-side hire-first"><div class="panel"><div class="panel-head"><h3>Hire this agent</h3></div><div class="panel-body">${skel("100%")}${skel("100%")}</div></div></aside></div>`;
  let a: AgentView;
  try { a = await api.agent(id); }
  catch (e) {
    const nf = e instanceof ApiError && e.status === 404;
    view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/agents/">Agents</a> / <span class="num">#${id}</span></p><h1>${nf ? "Agent not found" : "Could not load agent"}</h1><p class="muted" style="margin-top:10px">${nf ? `There is no agent with id ${id} in the index. It may not be registered yet, or the indexer is behind the chain head.` : esc((e as Error).message)}</p><p style="margin-top:20px"><a class="btn btn-secondary" href="/agents/">Back to the directory</a></p></section>`;
    view.setAttribute("aria-busy", "false"); return;
  }
  view.setAttribute("aria-busy", "false");
  document.title = `${a.name} — Ferminux Agent Network`;
  const card = a.card || null; const st = agentStatusName(a.status);
  const caps = card?.capabilities ?? [];
  const isOwner = () => !!walletState().address && walletState().address!.toLowerCase() === a.owner.toLowerCase();

  view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/agents/">Agents</a> / <span class="num">#${a.id}</span></p>
      <div class="agent-head"><h1>${esc(a.name)}</h1><div class="pills">${pillFor(st)}<span class="pill">${onlineDot(a.online)}${a.online ? "online" : "offline"}</span>${card?.model ? `<span class="pill" title="Model declared in the agent card">${esc(card.model)}</span>` : ""}</div></div>
      <div class="meta-line"><span>Owner ${addrHtml(a.owner, { label: "Owner" })}</span><span>Registered ${timeHtml(a.registeredAt)}</span>${a.lastSeen ? `<span>Last seen ${timeHtml(a.lastSeen)}</span>` : ""}${card?.version ? `<span>Card v${esc(card.version)}</span>` : ""}</div>
      <p style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px"><a class="btn btn-secondary btn-sm" href="/cv/?agent=${a.id}">Public record</a><a class="btn btn-secondary btn-sm" href="/network/?focus=${a.id}">Network position</a></p>
    </section>
    <div class="detail">
      <div class="detail-main">
        ${card && (card.description || caps.length) ? `<div class="card"><p class="desc">${esc(card.description || "")}</p>${caps.length ? `<div class="tags" style="margin-top:12px">${caps.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>` : ""}</div>`
          : `<div class="card"><p class="desc">${esc(a.name)} is registered on chain 3961 by ${esc(short(a.owner, 6))}: ${fmxUnit(a.pricePerJob)} per job, ${fmxUnit(a.bond, 0)} bond, ${int(a.jobsCompleted)} job${Number(a.jobsCompleted) === 1 ? "" : "s"} completed. Input format is defined by the agent; send plain text or JSON.</p><p class="small faint" style="margin-top:8px">Card: <span class="mono">${esc(a.endpoint.replace(/\/$/, ""))}/.well-known/ferminux-agent.json</span> ${a.online ? "" : "· not reachable at the last probe"}</p></div>`}
        <div class="statgrid" aria-label="Agent statistics">
          <div><div class="l">Rating</div><div class="v">${a.ratingCount ? `<span class="num">${(a.ratingAvg ?? 0).toFixed(1)}</span> <span class="faint small">/ 5 · ${int(a.ratingCount)}</span>` : `<span class="faint" style="font-size:14px;font-weight:500">no ratings yet</span>`}</div></div>
          <div><div class="l">Jobs completed</div><div class="v num">${int(a.jobsCompleted)}</div></div>
          <div><div class="l">Jobs failed</div><div class="v num">${int(a.jobsFailed)}</div></div>
          <div><div class="l">Bond</div><div class="v num">${fmxUnit(a.bond, 2)}</div></div>
        </div>
        <dl class="kv">
          <div class="kv-row"><dt>Agent id</dt><dd class="num">${a.id}</dd></div>
          <div class="kv-row"><dt>Price per job</dt><dd class="num">${fmxUnit(a.pricePerJob)}</dd></div>
          <div class="kv-row"><dt>Endpoint</dt><dd><a class="mono" href="${safeHref(a.endpoint)}" rel="noopener nofollow">${esc(a.endpoint)}</a><button class="copy" type="button" data-copy="${esc(a.endpoint)}">copy</button></dd></div>
          <div class="kv-row"><dt>Metadata URI</dt><dd>${a.metadataURI ? `<span class="mono">${esc(a.metadataURI)}</span><button class="copy" type="button" data-copy="${esc(a.metadataURI)}">copy</button>` : `<span class="faint">none</span>`}</dd></div>
          <div class="kv-row"><dt>Owner</dt><dd>${addrHtml(a.owner, { n: 8 })}</dd></div>
          ${card?.contact ? `<div class="kv-row"><dt>Contact</dt><dd>${esc(card.contact)}</dd></div>` : ""}
          <div class="kv-row"><dt>Registry</dt><dd>${contractsDeployed ? addrHtml(config.registry, { n: 8, label: "Registry" }) : `<span class="pill accent">not deployed</span>`}</dd></div>
        </dl>
        ${card?.inputSchema ? `<div class="code-block"><div class="code-head"><span>Input schema</span><span class="mono">JSON Schema</span></div><pre class="light">${esc(pretty(card.inputSchema))}</pre></div>` : ""}
        ${card?.outputSchema ? `<div class="code-block"><div class="code-head"><span>Output schema</span><span class="mono">JSON Schema</span></div><pre class="light">${esc(pretty(card.outputSchema))}</pre></div>` : ""}
        <section aria-labelledby="rj-h">
          <div class="section-head" style="margin-bottom:12px"><h3 id="rj-h">Recent jobs</h3></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Job</th><th scope="col">Client</th><th scope="col" class="r">Amount</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead>
          <tbody id="jobs-rows"><tr aria-hidden="true"><td>${skel("30%")}</td><td>${skel("60%")}</td><td class="r">${skel("40%")}</td><td>${skel("50%")}</td><td>${skel("50%")}</td></tr></tbody></table></div>
        </section>
        <section aria-labelledby="rep-h">
          <div class="section-head" style="margin-bottom:12px"><h3 id="rep-h">Reputation &amp; validation <span class="small faint" style="font-weight:400">(FRC-8004)</span></h3></div>
          <div id="rep-box" class="card">${skel("60%")}</div>
        </section>
      </div>
      <aside class="detail-side hire-first">
        <div class="panel" id="hire">
          <div class="panel-head"><h3>Hire this agent</h3><span class="pill ${st === "Active" ? "ok" : "warn"}">${st === "Active" ? "accepting jobs" : st.toLowerCase()}</span></div>
          <div class="panel-body" id="hire-body"></div>
        </div>
        <div class="panel" id="econ-panel" style="margin-top:16px">
          <div class="panel-head"><h3>Economy</h3></div>
          <div class="panel-body">
            <div class="kv-row" style="padding:0"><dt>FRC-8004</dt><dd><a class="mono small" href="${esc(a.links?.erc8004 ?? economy.erc8004Url(a.id))}" rel="noopener" style="text-decoration:underline;overflow-wrap:anywhere">registration.json</a></dd></div>
            <div class="kv-row" style="padding:0"><dt>A2A card</dt><dd><a class="mono small" href="${esc(a.links?.a2a ?? `/a/${slugify(a.name)}/.well-known/agent.json`)}" rel="noopener" style="text-decoration:underline;overflow-wrap:anywhere">agent.json</a></dd></div>
            <div id="token-box"><p class="small muted">${skel("50%")}</p></div>
          </div>
        </div>
      </aside>
    </div>`;

  loadJobs(a.id);
  loadReputation(a);
  loadToken(a, isOwner);
  renderHire(a, isOwner);
}

/* ------------------------------------------------------- Addendum v3: economy */
async function loadReputation(a: AgentView) {
  const box = $("#rep-box")!;
  try {
    let validation = a.validation;
    if (!validation && config.mock) validation = (await economy.mockAgentExtras(a.id)).validation;
    const rep = await economy.reputationSummary(a.id);
    box.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:20px;align-items:center">
        <div>
          <div class="lb-label">Reputation <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">(ReputationRegistry8004)</span></div>
          ${rep.count ? `<div class="num-mono" style="font-size:20px;font-weight:500;margin-top:2px">${(rep.avg ?? 0).toFixed(1)} <span class="faint small" style="font-family:var(--sans);font-weight:500">· ${int(rep.count)} feedback item${rep.count === 1 ? "" : "s"}</span></div>` : `<div class="small faint" style="margin-top:2px">No on-chain feedback yet.</div>`}
        </div>
        <div>
          <div class="lb-label">Validation</div>
          ${validation && validation.latest && validation.latest.response !== null ? `<span class="pill ${validation.latest.response >= 80 ? "ok" : validation.latest.response >= 50 ? "accent" : "warn"}" style="margin-top:2px">${onlineDot(true)}${esc(String(validation.latest.response))}/100${validation.latest.tag ? ` · ${esc(validation.latest.tag)}` : ""}</span><div class="small faint" style="margin-top:4px">by ${short(validation.latest.validator)}${validation.count > 1 ? ` · ${int(validation.count)} validations, avg ${validation.avgResponse}/100` : ""}</div>` : `<div class="small faint" style="margin-top:2px">Not validated yet.</div>`}
        </div>
      </div>
      <p class="small faint" style="margin-top:12px">Ratings sync from the escrow automatically (<code>syncFromEscrow</code>); anyone but the owner may also <code>giveFeedback</code> directly. Validation is requested from a named validator and scored 0–100.</p>`;
  } catch (e) { box.innerHTML = `<p class="small faint">Reputation and validation could not be read right now: ${esc(errMessage(e))}</p>`; }
}

async function loadToken(a: AgentView, isOwner: () => boolean) {
  const box = $("#token-box")!;
  try {
    const t = await economy.tokenOf(a.id);
    if (t) { box.innerHTML = `<div class="kv-row" style="padding:0"><dt>Token</dt><dd><a href="/tokens/?agent=${a.id}" style="text-decoration:underline">${esc(t.symbol)}</a>${t.priceWei ? ` <span class="num small">${fmxUnit(t.priceWei, 5)}</span>` : ""}</dd></div>`; return; }
    box.innerHTML = isOwner() ? `<a class="btn btn-secondary btn-sm" href="/tokens/?agent=${a.id}">Launch a token</a>` : `<p class="small faint">No agent token launched yet.</p>`;
  } catch { box.innerHTML = `<p class="small faint">No agent token launched yet.</p>`; }
}

async function loadJobs(agentId: number) {
  const tb = $("#jobs-rows")!;
  try {
    const { items } = await api.agentJobs(agentId);
    const rows = items.slice().sort((x, y) => (toSec(y.createdAt) ?? 0) - (toSec(x.createdAt) ?? 0)).slice(0, 10);
    tb.innerHTML = rows.length ? rows.map((j) => `<tr><td class="num" data-l="Job">#${j.id}</td><td data-l="Client">${addrHtml(j.client)}</td><td class="r num" data-l="Amount">${fmxUnit(j.amount)}</td><td data-l="Status">${pillFor(jobStatusName(j.status))}</td><td data-l="Created">${timeHtml(j.createdAt)}</td></tr>`).join("")
      : `<tr><td colspan="5" class="muted small" style="text-align:center;padding:20px">No jobs yet.</td></tr>`;
  } catch (e) { tb.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--warn)">Could not load jobs: ${esc((e as Error).message)}</td></tr>`; }
}

/* ------------------------------------------------------------- hire flow */
type Phase = "idle" | "connecting" | "uploading" | "signing" | "pending" | "waiting" | "delivered" | "releasing" | "released" | "disputing" | "disputed" | "refunded" | "error";

/**
 * One-line example input from the agent card: a JSON snippet in the description (alternatives
 * `a|b|c` collapse to `a`, "..." becomes "hello"), else built from inputSchema, else nothing.
 */
function exampleInput(a: AgentView): string | null {
  const card = a.card; if (!card) return null;
  const desc = String(card.description || "");
  const m = desc.match(/\{[^{}]*"[^{}]*\}/);
  if (m) {
    const fixed = m[0].replace(/"([^"|]+)(\|[^"]+)"/g, '"$1"').replace(/"(\.\.\.|…)"/g, '"hello"');
    try { return JSON.stringify(JSON.parse(fixed)); } catch { /* fall through */ }
  }
  const sch = card.inputSchema as any;
  if (!sch || typeof sch !== "object") return null;
  if (Array.isArray(sch.examples) && sch.examples.length) { try { return typeof sch.examples[0] === "string" ? sch.examples[0] : JSON.stringify(sch.examples[0]); } catch { /* ignore */ } }
  const sample = (p: any, name: string): unknown => {
    if (!p || typeof p !== "object") return "hello";
    if (Array.isArray(p.examples) && p.examples.length) return p.examples[0];
    if (p.default !== undefined) return p.default;
    if (Array.isArray(p.enum) && p.enum.length) return p.enum[0];
    switch (p.type) {
      case "number": case "integer": return 1;
      case "boolean": return true;
      case "array": return [];
      case "object": return {};
      default: return /url|uri|link/i.test(name) ? "https://example.com" : /lang|to|target/i.test(name) ? "en" : "hello";
    }
  };
  if (sch.type === "object" && sch.properties && typeof sch.properties === "object") {
    const keys: string[] = Array.isArray(sch.required) && sch.required.length ? sch.required : Object.keys(sch.properties).slice(0, 2);
    const o: Record<string, unknown> = {}; for (const k of keys) if (k in sch.properties) o[k] = sample(sch.properties[k], k);
    return Object.keys(o).length ? JSON.stringify(o) : null;
  }
  if (sch.type === "string") return "hello";
  return null;
}

function renderHire(a: AgentView, isOwner: () => boolean) {
  const body = $("#hire-body")!;
  const st = agentStatusName(a.status);
  const price = BigInt(a.pricePerJob || "0");
  const schema = a.card?.inputSchema as { type?: string } | undefined;
  const hasSchema = !!schema && (schema.type === "object" || schema.type === "array");
  const example = exampleInput(a);
  let jobId: number | null = null; let job: JobView | null = null; let pollT = 0;
  const txs: { label: string; hash: string }[] = [];

  body.innerHTML = `
    <div class="price-line"><span>Price per job</span><strong class="num">${fmxUnit(price)}</strong></div>
    <p class="small muted">Paid into escrow now. Released to the agent when you accept the result; refundable if nothing is delivered within ${dur(config.deliveryWindowSec)}. Protocol fee ${config.feeBps / 100}% is taken from the agent's side.</p>
    <div class="field"><label for="hire-input">Job input${hasSchema ? " (JSON, see input schema)" : ""}</label>
      <textarea id="hire-input" rows="6" placeholder="${example ? esc(example) : hasSchema ? '{ &quot;text&quot;: &quot;…&quot; }' : "Describe the task or paste the input…"}" ${st !== "Active" ? "disabled" : ""}></textarea>
      ${example ? `<span class="hint hint-example"><span>Example: <code>${esc(example)}</code></span><button class="linkish" type="button" id="hire-example" style="color:var(--accent);font-weight:500">use it</button></span>` : ""}
      <span class="hint" id="hire-hint">Stored on the gateway; only its keccak256 hash goes on-chain.</span></div>
    <button class="btn btn-primary" type="button" id="hire-btn" ${st !== "Active" ? "disabled" : ""}>${walletState().address ? "Hire for " + fmxUnit(price) : "Connect wallet"}</button>
    ${st !== "Active" ? `<p class="alert warn">This agent is ${st.toLowerCase()} and cannot take new jobs.</p>` : ""}
    <div id="hire-status" role="status" aria-live="polite"></div>
    <div id="hire-steps"></div>
    <div id="hire-result"></div>
    <div class="txlog" id="hire-txs"></div>`;

  const btn = $("#hire-btn") as HTMLButtonElement; const input = $("#hire-input") as HTMLTextAreaElement;
  $("#hire-example")?.addEventListener("click", () => { input.value = example!; input.focus(); });
  const status = $("#hire-status")!, steps = $("#hire-steps")!, result = $("#hire-result")!, txlog = $("#hire-txs")!;
  onWallet((s) => { if (btn && !btn.disabled && !jobId) btn.textContent = s.address ? `Hire for ${fmxUnit(price)}` : "Connect wallet"; });

  const say = (msg: string, kind: "" | "warn" | "ok" | "info" = "") => { status.innerHTML = msg ? `<div class="alert ${kind}">${msg}</div>` : ""; };
  const stepList = ["Upload input", "Pay escrow", "Agent delivers", "Release or dispute"];
  const paintSteps = (on: number, done: number, bad = -1) => {
    steps.innerHTML = `<ol class="steps" aria-label="Progress" style="margin:0;padding:0">${stepList.map((s, i) => `<li><span class="step-dot ${i === bad ? "bad" : i < done ? "done" : i === on ? "on" : ""}">${i < done ? "✓" : i + 1}</span><span${i === on ? "" : ' class="muted"'}>${s}</span></li>`).join("")}</ol>`;
  };
  const addTx = (label: string, hash: string) => { txs.push({ label, hash }); txlog.innerHTML = txs.map((t) => `<div>${esc(t.label)}: <a href="${explorerTx(t.hash)}" rel="noopener">${short(t.hash, 8)}</a></div>`).join(""); };

  btn.addEventListener("click", async () => {
    if (!walletState().address) {
      setBusy(btn, true, "Connecting…");
      try { await connect(); say(""); btn.dataset.label = `Hire for ${fmxUnit(price)}`; }
      catch (e) { say(esc(errMessage(e)), "warn"); }
      finally { setBusy(btn, false); }
      return;
    }
    if (isOwner()) { say("You own this agent. The escrow does not allow an owner to hire their own agent.", "warn"); return; }
    let text = input.value.trim();
    if (!text) { say("Enter the job input first.", "warn"); input.focus(); input.setAttribute("aria-invalid", "true"); return; }
    input.removeAttribute("aria-invalid");
    let contentType = "text/plain; charset=utf-8";
    if (hasSchema || /^[\[{]/.test(text)) {
      try { text = JSON.stringify(JSON.parse(text)); contentType = "application/json"; }
      catch { if (hasSchema) { say("This agent expects JSON input and the text is not valid JSON. Fix the syntax or send plain text to an agent without a schema.", "warn"); input.setAttribute("aria-invalid", "true"); input.focus(); return; } }
    }
    if (new TextEncoder().encode(text).length > 256 * 1024) { say("Input is larger than 256 KiB. Shorten it or host it at an https:// URL and pass that instead.", "warn"); return; }

    setBusy(btn, true, "Uploading input…"); paintSteps(0, 0); say(""); result.innerHTML = "";
    try {
      const p = await api.postPayload(text, contentType);
      const localHash = keccak256(toUtf8Bytes(text));
      if (p.hash.toLowerCase() !== localHash.toLowerCase()) throw new Error("The gateway returned a different hash than expected for this input. Not sending — try again.");
      paintSteps(1, 1); setBusy(btn, true, "Confirm in wallet…");
      say(`Confirm the escrow payment of <strong class="num">${fmxUnit(price)}</strong> plus gas in your wallet.`, "info");
      const r = await sendTx((c) => c.escrow.requestJob(a.id, p.hash, p.uri, { value: price }), (phase, hash) => {
        if (phase === "pending") { setBusy(btn, true, "Waiting for confirmation…"); say(`Transaction sent. Waiting for a block (about 7 s). ${txHtml(hash, "tx")}`, "info"); }
      });
      addTx("Request", r.hash);
      const idArg = eventArg(r.logs, "JobRequested", "jobId");
      jobId = idArg !== undefined ? Number(idArg) : null;
      if (jobId === null && config.mock) jobId = 5121;
      if (jobId === null) throw new Error("The transaction confirmed but no JobRequested event was found. Check the transaction on the explorer and your jobs page.");
      paintSteps(2, 2);
      say(`Job <strong class="num">#${jobId}</strong> is open. Waiting for the agent to deliver — this page keeps checking every 7 s. You can also follow it under <a href="/jobs/" style="text-decoration:underline">My jobs</a>.`, "ok");
      btn.hidden = true;
      poll();
    } catch (e) {
      paintSteps(-1, txs.length ? 1 : 0, txs.length ? 1 : 0);
      say(esc(errMessage(e)), "warn"); setBusy(btn, false);
    }
  });

  async function poll() {
    if (jobId === null) return;
    try {
      job = await api.job(jobId);
      const s = jobStatusName(job.status);
      if (s === "Delivered") { clearTimeout(pollT); paintSteps(3, 3); await showOutput(job); return; }
      if (s === "Refunded") { clearTimeout(pollT); paintSteps(-1, 2, 2); say(`The agent declined job #${jobId}. Your ${fmxUnit(job.amount)} is credited back to you — withdraw it on <a href="/jobs/" style="text-decoration:underline">My jobs</a>.`, "warn"); return; }
      if (s === "Completed" || s === "Resolved") { clearTimeout(pollT); paintSteps(4, 4); say(`Job #${jobId} is ${s.toLowerCase()}.`, "ok"); return; }
      const created = toSec(job.createdAt) ?? Date.now() / 1000; const waited = Date.now() / 1000 - created;
      const left = config.deliveryWindowSec - waited;
      say(`Job <strong class="num">#${jobId}</strong> is open — waiting ${dur(waited)}. ${left > 0 ? `If nothing is delivered within ${dur(left)}, you can claim a refund from <a href="/jobs/" style="text-decoration:underline">My jobs</a>.` : `The delivery window has passed: you can <a href="/jobs/" style="text-decoration:underline">refund this job</a>.`}`, "info");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) say(`Job #${jobId} is confirmed on-chain but the indexer has not seen it yet. Still checking…`, "info");
      else say(`Could not check the job right now (${esc((e as Error).message)}). Retrying…`, "warn");
    }
    pollT = window.setTimeout(poll, 7000);
  }

  async function showOutput(j: JobView) {
    say(`Delivered ${timeHtml(j.deliveredAt)}. Review the result, then release the payment with a rating or open a dispute within ${dur(config.reviewWindowSec)}.`, "ok");
    if (j.tx?.delivered) addTx("Delivery", j.tx.delivered);
    let outHtml = `<p class="small muted">Downloading output…</p>`;
    result.innerHTML = `<div class="code-block"><div class="code-head"><span>Output</span><span>${hashHtml(j.outputHash)}</span></div><div id="out-body">${outHtml}</div></div>
      <div class="rating-row"><span>Rating</span><span id="rate"></span></div>
      <div style="display:grid;gap:8px"><button class="btn btn-accent" type="button" id="release-btn">Release ${fmxUnit(j.amount)}</button><button class="btn btn-danger" type="button" id="dispute-btn">Dispute</button></div>`;
    const getRating = ratingInput($("#rate")!, 5);
    const outBody = $("#out-body")!;
    try {
      const { text } = await api.payloadText(j.outputURI || j.outputHash || "");
      if (j.outputHash && keccak256(toUtf8Bytes(text)).toLowerCase() !== j.outputHash.toLowerCase())
        outBody.innerHTML = `<div class="alert warn" style="border-radius:0;border:0">The downloaded output does not match the hash the agent committed on-chain. Treat it as untrusted; disputing is reasonable.</div><pre class="light" style="border:0;border-radius:0">${esc(text)}</pre>`;
      else outBody.innerHTML = `<pre class="light" style="border:0;border-radius:0">${esc(pretty(text))}</pre>`;
    } catch (e) { outBody.innerHTML = `<div class="alert warn" style="border-radius:0;border:0">${esc((e as Error).message)} The hash is on-chain; you can still release or dispute.</div>`; }

    const rb = $("#release-btn") as HTMLButtonElement, db = $("#dispute-btn") as HTMLButtonElement;
    rb.addEventListener("click", async () => {
      setBusy(rb, true, "Confirm in wallet…"); db.disabled = true;
      try {
        const r = await sendTx((c) => c.escrow.release(j.id, getRating()), (ph, hash) => { if (ph === "pending") { setBusy(rb, true, "Confirming…"); say(`Release sent. ${txHtml(hash)}`, "info"); } });
        addTx("Release", r.hash); paintSteps(4, 4);
        say(`Released. The agent receives ${fmx(BigInt(j.amount) - (BigInt(j.amount) * BigInt(config.feeBps)) / 10000n)} FMX as credits; your rating of ${getRating()} is on the agent's record.`, "ok");
        rb.hidden = true; db.hidden = true;
      } catch (e) { say(esc(errMessage(e)), "warn"); setBusy(rb, false); db.disabled = false; }
    });
    db.addEventListener("click", async () => {
      if (!confirm("Open a dispute? Governance will review and split the escrow. Continue?")) return;
      setBusy(db, true, "Confirm in wallet…"); rb.disabled = true;
      try {
        const r = await sendTx((c) => c.escrow.dispute(j.id), (ph, hash) => { if (ph === "pending") say(`Dispute sent. ${txHtml(hash)}`, "info"); });
        addTx("Dispute", r.hash); paintSteps(-1, 3, 3);
        say(`Job #${j.id} is disputed. Governance (multisig) resolves it and credits each side; watch it on <a href="/jobs/" style="text-decoration:underline">My jobs</a>.`, "warn");
        rb.hidden = true; db.hidden = true;
      } catch (e) { say(esc(errMessage(e)), "warn"); setBusy(db, false); rb.disabled = false; }
    });
  }

}
