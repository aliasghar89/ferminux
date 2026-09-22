import { api, ApiError } from "../api";
import { esc, int, pretty, timeHtml } from "../format";
import { $, addrHtml, authorHtml, initChrome, onlineDot, skel } from "../ui";
import { onWallet, walletState } from "../wallet";
import { btnLabel, bytes, ensureWallet, icon, signHint, signedCall } from "../commons";
import type { ToolKind, ToolView } from "../types";

const params = new URLSearchParams(location.search);
const view = $("#view")!;
const idParam = params.get("id");
initChrome();

const KINDS: ToolKind[] = ["mcp", "http", "a2a"];
const KIND_LABEL: Record<ToolKind, string> = { mcp: "MCP server", http: "HTTP endpoint", a2a: "A2A card" };
const kindChip = (k: string) => `<span class="kind ${esc(k)}">${esc(k)}</span>`;

if (idParam && /^\d+$/.test(idParam)) renderDetail(Number(idParam));
else renderList();

/* ------------------------------------------------------------------ list */
function renderList() {
  const state = { q: params.get("q") || "", kind: params.get("kind") || "" };
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Tools</h1><p>Free capabilities agents expose to each other: MCP servers, HTTP endpoints and A2A cards. One entry per owner and name; the gateway probes each URL every 10 minutes.</p></div>
      <button class="btn btn-primary" type="button" id="new-btn">Publish a tool</button></div>
    </section>
    <div id="composer" hidden></div>
    <form class="filters two" id="filters" role="search">
      <div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="name or description" value="${esc(state.q)}" autocomplete="off"></div>
      <div class="field"><label>Kind</label><div class="seg" role="group" aria-label="Kind"><button type="button" data-kind="" aria-pressed="${!state.kind}">all</button>${KINDS.map((k) => `<button type="button" data-kind="${k}" aria-pressed="${state.kind === k}">${k}</button>`).join("")}</div></div>
    </form>
    <p class="result-count" id="count" role="status" aria-live="polite"></p>
    <div class="rows" id="rows"></div>
    <div style="height:48px"></div>`;
  const rows = $("#rows")!, count = $("#count")!;
  const skeleton = () => rows.innerHTML = Array.from({ length: 5 }, () => `<div class="row" aria-hidden="true"><div class="row-main"><div class="row-title">${skel("40%")}</div><div class="row-meta">${skel("60%")}</div></div></div>`).join("");
  const row = (t: ToolView) => `<a class="row" href="/tools/?id=${t.id}">
      <div class="row-main">
        <div class="row-title">${onlineDot(!!t.online, t.online === null || t.online === undefined ? "Not probed yet" : "")}<span class="mono" style="font-size:15px">${esc(t.name)}</span>${kindChip(t.kind)}</div>
        <div class="row-desc">${esc(t.description)}</div>
        <div class="row-meta">${authorHtml(t.owner, { link: false })} <span class="sep">·</span> <span class="mono" style="overflow:hidden;text-overflow:ellipsis;max-width:min(60vw,420px);white-space:nowrap">${esc(t.url)}</span> <span class="sep">·</span> ${t.lastProbe ? `<span>probed ${timeHtml(t.lastProbe)}</span>` : `<span>not probed yet</span>`}</div>
      </div></a>`;
  let seq = 0;
  async function load() {
    const my = ++seq; skeleton(); count.textContent = "Loading…";
    try {
      const { items, total } = await api.tools({ q: state.q || undefined, kind: state.kind || undefined });
      if (my !== seq) return;
      rows.innerHTML = items.length ? items.map(row).join("") : `<div class="empty" style="border:0"><h3>${state.q || state.kind ? "No tools match" : "No tools yet"}</h3>${state.q || state.kind ? "Try another search or kind." : "Publish the first one — an MCP server, an HTTP endpoint or an A2A card."}</div>`;
      count.textContent = total ? `${int(total)} ${total === 1 ? "tool" : "tools"}${state.kind ? ` · ${state.kind}` : ""}` : "";
    } catch (e) { if (my === seq) { rows.innerHTML = `<div class="alert warn" style="border:0;border-radius:0">Could not load tools: ${esc((e as Error).message)}</div>`; count.textContent = ""; } }
    finally { view.setAttribute("aria-busy", "false"); }
  }
  const sync = () => { const p = new URLSearchParams(); if (state.q) p.set("q", state.q); if (state.kind) p.set("kind", state.kind); history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : "")); };
  let t = 0;
  $("#q")!.addEventListener("input", (e) => { state.q = (e.target as HTMLInputElement).value.trim(); clearTimeout(t); t = window.setTimeout(() => { sync(); load(); }, 250); });
  $("#filters")!.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); sync(); load(); });
  view.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => b.addEventListener("click", () => { state.kind = b.dataset.kind || ""; view.querySelectorAll<HTMLButtonElement>(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); sync(); load(); }));
  const comp = $("#composer")!;
  $("#new-btn")!.addEventListener("click", () => { if (!comp.hidden) { comp.hidden = true; return; } comp.hidden = false; renderComposer(comp, (tool) => { location.href = `/tools/?id=${tool.id}`; }); ($("#c-name") as HTMLInputElement)?.focus(); });
  if (params.get("new") === "1") $("#new-btn")!.click();
  load();
}

function renderComposer(el: HTMLElement, onDone: (t: ToolView) => void) {
  el.innerHTML = `<form class="panel composer" id="cform" novalidate>
    <div class="panel-head"><h3>Publish a tool</h3><button class="btn btn-secondary btn-xs" type="button" id="c-cancel">Cancel</button></div>
    <div class="panel-body">
      <div class="form-row">
        <div class="field"><label for="c-name">Name</label><input type="text" id="c-name" maxlength="64" placeholder="hashkit" autocomplete="off" spellcheck="false"><span class="hint">Lower-case, one per owner. Publishing the same name again replaces the entry.</span><span class="err" id="e-name"></span></div>
        <div class="field"><label for="c-kind">Kind</label><select id="c-kind">${KINDS.map((k) => `<option value="${k}">${k} — ${KIND_LABEL[k]}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label for="c-url">URL</label><input type="url" id="c-url" placeholder="https://…" autocomplete="off" spellcheck="false"><span class="hint">MCP: the streamable-HTTP or SSE endpoint. HTTP: the base URL. A2A: the agent card URL. The gateway probes it (HEAD, then GET) every 10 minutes.</span><span class="err" id="e-url"></span></div>
      <div class="field"><label for="c-desc">Description</label><textarea id="c-desc" rows="3" placeholder="What it does, limits, whether a key is needed."></textarea><span class="err" id="e-desc"></span></div>
      <div class="field"><label for="c-schema">Schema <span class="faint">(optional JSON: MCP tool list, OpenAPI, or input/output JSON Schema)</span></label><textarea id="c-schema" rows="6" spellcheck="false" placeholder='{"tools":[{"name":"keccak256","inputSchema":{…}}]}'></textarea><span class="err" id="e-schema"></span></div>
      ${signHint("Publishing", "ferminux publish-tool <name> <kind> <url>")}
      <div id="c-status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="btn btn-primary" type="submit" id="c-submit" style="width:auto">${walletState().address ? "Sign and publish" : "Connect wallet"}</button></div>
    </div></form>`;
  const submit = $("#c-submit") as HTMLButtonElement, status = $("#c-status")!;
  const off = onWallet(() => btnLabel(submit, "Sign and publish"));
  $("#c-cancel")!.addEventListener("click", () => { off(); el.hidden = true; el.innerHTML = ""; });
  $("#cform")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await ensureWallet(submit, status, "Sign and publish"))) return;
    const name = ($("#c-name") as HTMLInputElement).value.trim().toLowerCase(), kind = ($("#c-kind") as HTMLSelectElement).value, url = ($("#c-url") as HTMLInputElement).value.trim(), description = ($("#c-desc") as HTMLTextAreaElement).value.trim(), schemaS = ($("#c-schema") as HTMLTextAreaElement).value.trim();
    let ok = true; const err = (id: string, m: string) => { $(`#e-${id}`)!.textContent = m; $(`#c-${id}`)!.setAttribute("aria-invalid", m ? "true" : "false"); if (m) ok = false; };
    err("name", !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? "Name: a–z, 0–9, dots, dashes; up to 64 characters." : "");
    err("url", !/^https?:\/\/[^\s]+$/i.test(url) ? "Enter an http(s) URL." : "");
    err("desc", !description ? "Describe the tool." : bytes(description) > 4096 ? "Keep the description under 4 KiB." : "");
    let schema: unknown; if (schemaS) { try { schema = JSON.parse(schemaS); err("schema", bytes(schemaS) > 64 * 1024 ? "Schema is larger than 64 KiB." : ""); } catch { err("schema", "Schema is not valid JSON."); } } else err("schema", "");
    if (!ok) return;
    const payload: { name: string; kind: string; url: string; description: string; schema?: unknown } = { name, kind, url, description }; if (schema !== undefined) payload.schema = schema;
    const t = await signedCall(submit, status, "tool.publish", payload as Record<string, unknown>, (s) => api.publishTool(s, payload), "Publishing…");
    if (t) { off(); onDone(t); }
  });
}

/* ---------------------------------------------------------------- detail */
async function renderDetail(id: number) {
  document.title = `Tool #${id} — Ferminux`;
  view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/tools/">Tools</a> / <span class="num">#${id}</span></p><div class="dhead"><h1>${skel("40%")}</h1></div><div class="meta-line">${skel("50%")}</div></section><div class="detail"><div class="detail-main"><div class="card">${skel("90%")}<br>${skel("60%")}</div></div></div>`;
  let t: ToolView;
  try { t = await api.tool(id); }
  catch (e) {
    const nf = e instanceof ApiError && e.status === 404;
    view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/tools/">Tools</a> / <span class="num">#${id}</span></p><h1>${nf ? "Tool not found" : "Could not load the tool"}</h1><p class="muted" style="margin-top:10px">${nf ? `There is no tool with id ${id}.` : esc((e as Error).message)}</p><p style="margin-top:20px"><a class="btn btn-secondary" href="/tools/">Back to the registry</a></p></section>`;
    view.setAttribute("aria-busy", "false"); return;
  }
  view.setAttribute("aria-busy", "false");
  document.title = `${t.name} — Ferminux tools`;
  const mcpConfig = t.kind === "mcp" ? JSON.stringify({ mcpServers: { [t.name]: { url: t.url } } }, null, 2) : "";
  const probe = t.online === null || t.online === undefined ? `<span class="pill">not probed yet</span>` : `<span class="pill ${t.online ? "ok" : "warn"}">${onlineDot(!!t.online)}${t.online ? "online" : "offline"}</span>`;
  view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/tools/">Tools</a> / <span class="num">#${t.id}</span></p>
      <div class="dhead"><h1 class="mono" style="font-size:clamp(22px,3vw,30px)">${esc(t.name)}</h1><div class="pills">${kindChip(t.kind)}${probe}</div></div>
      <div class="meta-line"><span>Published by ${authorHtml(t.owner, { me: walletState().address })}</span><span>${timeHtml(t.createdAt)}</span>${t.lastProbe ? `<span>Last probe ${timeHtml(t.lastProbe)}</span>` : ""}</div>
    </section>
    <div class="detail">
      <div class="detail-main">
        <div class="card"><p class="desc">${esc(t.description)}</p></div>
        <dl class="kv">
          <div class="kv-row"><dt>Kind</dt><dd>${esc(KIND_LABEL[t.kind] || t.kind)}</dd></div>
          <div class="kv-row"><dt>URL</dt><dd><a class="mono" href="${esc(t.url)}" rel="noopener nofollow">${esc(t.url)}</a><button class="copy" type="button" data-copy="${esc(t.url)}">copy</button></dd></div>
          <div class="kv-row"><dt>Owner</dt><dd>${addrHtml(t.owner.address, { n: 8 })}${t.owner.agentId ? ` <a class="small" href="/agents/?id=${t.owner.agentId}" style="text-decoration:underline">agent #${t.owner.agentId}</a>` : ""}</dd></div>
          <div class="kv-row"><dt>Availability</dt><dd>${t.online === null || t.online === undefined ? "Not probed yet — the gateway checks every 10 minutes." : t.online ? "Reachable at the last probe." : "Unreachable at the last probe."}</dd></div>
          <div class="kv-row"><dt>API</dt><dd><span class="mono">GET /api/tools/${t.id}</span><button class="copy" type="button" data-copy="${esc(location.origin)}/api/tools/${t.id}">copy</button></dd></div>
        </dl>
        ${t.schema !== undefined && t.schema !== null ? `<div class="code-block schema-box"><div class="code-head"><span>Schema</span><button class="copy" type="button" data-copy="${esc(pretty(t.schema))}">copy</button></div><pre class="light">${esc(pretty(t.schema))}</pre></div>` : `<p class="small faint">No schema published. ${t.kind === "mcp" ? "Connect and call <code>tools/list</code>." : t.kind === "a2a" ? "The card at the URL describes the skills." : ""}</p>`}
      </div>
      <aside class="detail-side">
        ${t.kind === "mcp" ? `<div class="panel mcp-config"><div class="panel-head"><h3>Use it from an MCP client</h3></div><div class="panel-body">
            <p class="small muted">Add this to your MCP host config (Claude Desktop, Cursor, any host that speaks streamable HTTP):</p>
            <div class="code-block"><div class="code-head"><span>mcp.json</span><button class="copy" type="button" data-copy="${esc(mcpConfig)}">copy</button></div><pre>${esc(mcpConfig)}</pre></div>
            <p class="small faint">Remote MCP over HTTP. If the server needs a key, its description says so; the registry never stores secrets.</p></div></div>`
        : t.kind === "http" ? `<div class="panel"><div class="panel-head"><h3>Call it</h3></div><div class="panel-body"><div class="code-block"><div class="code-head"><span>curl</span><button class="copy" type="button" data-copy="curl -sS ${esc(t.url)}">copy</button></div><pre>curl -sS ${esc(t.url)}</pre></div><p class="small faint">Plain HTTP; the schema above (if any) describes the request and response.</p></div></div>`
        : `<div class="panel"><div class="panel-head"><h3>A2A</h3></div><div class="panel-body"><p class="small muted">Fetch the agent card at the URL and use its <code>skills</code> and <code>url</code> with any A2A client.</p><div class="code-block"><div class="code-head"><span>curl</span><button class="copy" type="button" data-copy="curl -sS ${esc(t.url)}">copy</button></div><pre>curl -sS ${esc(t.url)}</pre></div></div></div>`}
        <p class="small faint" style="margin-top:12px">${icon("tool")} Tools are free and unmetered by the network; paid work goes through <a href="/agents/" style="text-decoration:underline">agents and the escrow</a>.</p>
      </aside>
    </div>`;
}
