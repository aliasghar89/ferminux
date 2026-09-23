// /network/ — who hired whom, and who endorsed whom.
//
// Every edge is an escrow job or an FRC-8004 feedback entry on chain 3961, so every row links to
// the transactions behind it. The picture is inline SVG built here (no chart library): a bipartite
// layout, payers on the left, agents on the right, which stays readable at 390 px and degrades to
// the table below it — the table is the information, the drawing is the overview.
import { loadNetwork } from "../cv";
import { config, explorerAddr, explorerTx } from "../config";
import { esc, fmx, fmxUnit, int, short, timeHtml } from "../format";
import { $, addrHtml, initChrome, skel, txHtml } from "../ui";
import type { NetEdge, NetKind, NetNode, NetView } from "../types";

const params = new URLSearchParams(location.search);
const view = $("#view")!;
initChrome();

const state = {
  kind: (params.get("kind") === "endorse" ? "endorse" : "hire") as NetKind,
  q: params.get("q") || "",
  capability: params.get("capability") || "",
  focus: params.get("focus") ? Number(params.get("focus")) : null,
};

let data: NetView | null = null;

shell();
load();

function shell() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>The network</h1>
        <p>Who hired whom on chain ${config.chainId}. Every edge is an escrow job with its transactions attached; nothing here is asserted by this site.</p></div>
        <a class="btn btn-secondary" href="/agents/">Agent directory</a></div>
    </section>
    <div class="seg-row" style="margin-top:18px">
      <div class="seg" role="group" aria-label="Edge kind">
        <button type="button" data-kind="hire" aria-pressed="${state.kind === "hire"}">Hires</button>
        <button type="button" data-kind="endorse" aria-pressed="${state.kind === "endorse"}">Endorsements</button>
      </div>
      <span class="src-inline"><span class="prov chain" title="Indexed from an event on chain 3961.">chain</span> ${state.kind === "hire" ? "ServiceEscrow.JobRequested / JobCompleted" : "ReputationRegistry8004.NewFeedback"}</span>
    </div>
    <form class="filters" id="net-filters" role="search">
      <div class="field"><label for="q">Search</label><input type="search" id="q" name="q" placeholder="agent name or address" value="${esc(state.q)}" autocomplete="off"></div>
      <div class="field"><label for="cap">Capability</label><select id="cap" name="cap"><option value="">All capabilities</option></select></div>
      <div class="field"><label for="focus">Focus</label><select id="focus" name="focus"><option value="">Whole network</option></select></div>
    </form>
    <p class="result-count" id="count" role="status" aria-live="polite">Loading…</p>
    <div id="graph" class="net-graph"></div>
    <div id="rows">${skel("60%")}</div>
    <div style="height:48px"></div>`;

  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-kind]"))) {
    b.addEventListener("click", () => {
      if (state.kind === b.dataset.kind) return;
      state.kind = b.dataset.kind as NetKind;
      for (const o of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-kind]"))) o.setAttribute("aria-pressed", String(o.dataset.kind === state.kind));
      data = null; sync(); load();
    });
  }
  let t = 0;
  $("#q")!.addEventListener("input", (e) => { state.q = (e.target as HTMLInputElement).value.trim(); clearTimeout(t); t = window.setTimeout(() => { sync(); paint(); }, 200); });
  $("#net-filters")!.addEventListener("submit", (e) => e.preventDefault());
  $("#cap")!.addEventListener("change", (e) => { state.capability = (e.target as HTMLSelectElement).value; sync(); paint(); });
  $("#focus")!.addEventListener("change", (e) => { const v = (e.target as HTMLSelectElement).value; state.focus = v ? Number(v) : null; sync(); paint(); });
}

function sync() {
  const p = new URLSearchParams();
  if (state.kind !== "hire") p.set("kind", state.kind);
  if (state.q) p.set("q", state.q);
  if (state.capability) p.set("capability", state.capability);
  if (state.focus) p.set("focus", String(state.focus));
  history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
}

async function load() {
  $("#count")!.textContent = "Loading…";
  $("#rows")!.innerHTML = `<div class="rows">${Array.from({ length: 4 }, () => `<div class="row"><div class="row-main">${skel("40%")}<br>${skel("60%")}</div></div>`).join("")}</div>`;
  try {
    data = await loadNetwork(state.kind);
    fillSelects(data);
    paint();
  } catch (e) {
    $("#count")!.textContent = "";
    $("#rows")!.innerHTML = `<div class="alert warn">Could not build the network view: ${esc((e as Error).message)}</div>`;
  }
}

function fillSelects(d: NetView) {
  const caps = new Set<string>();
  for (const n of d.nodes) for (const c of n.capabilities) caps.add(c);
  const cap = $("#cap") as HTMLSelectElement;
  cap.innerHTML = `<option value="">All capabilities</option>` + [...caps].sort().map((c) => `<option value="${esc(c)}"${c === state.capability ? " selected" : ""}>${esc(c)}</option>`).join("");
  const agents = d.nodes.filter((n) => n.isAgent).sort((a, b) => (a.agentId ?? 0) - (b.agentId ?? 0));
  const focus = $("#focus") as HTMLSelectElement;
  focus.innerHTML = `<option value="">Whole network</option>` + agents.map((a) => `<option value="${a.agentId}"${a.agentId === state.focus ? " selected" : ""}>${esc(a.name)} #${a.agentId}</option>`).join("");
}

/* ------------------------------------------------------------------ filtering */

function filtered(d: NetView): { edges: NetEdge[]; nodes: Map<string, NetNode> } {
  const byKey = new Map(d.nodes.map((n) => [n.key, n]));
  const q = state.q.toLowerCase();
  const edges = d.edges.filter((e) => {
    if (state.focus && e.toAgentId !== state.focus && e.fromAgentId !== state.focus) return false;
    if (state.capability) {
      const to = byKey.get(e.to);
      if (!to || !to.capabilities.some((c) => c === state.capability)) return false;
    }
    if (q) {
      const hay = `${e.fromName} ${e.toName} ${e.from} ${e.to}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return { edges, nodes: byKey };
}

/* ------------------------------------------------------------------ paint */

function paint() {
  if (!data) return;
  const { edges, nodes } = filtered(data);
  const totalWei = edges.reduce((s, e) => s + BigInt(e.fmxWei), 0n);
  const jobs = edges.reduce((s, e) => s + e.jobs, 0);
  const payers = new Set(edges.map((e) => e.from)).size;
  const paid = new Set(edges.map((e) => e.to)).size;

  $("#count")!.innerHTML = edges.length
    ? state.kind === "hire"
      ? `${int(edges.length)} hiring relationship${edges.length === 1 ? "" : "s"} · ${int(jobs)} job${jobs === 1 ? "" : "s"} · ${esc(fmxUnit(totalWei.toString()))} moved · ${int(payers)} payer${payers === 1 ? "" : "s"} → ${int(paid)} agent${paid === 1 ? "" : "s"}`
      : `${int(edges.length)} endorsement edge${edges.length === 1 ? "" : "s"} · ${int(payers)} endorser${payers === 1 ? "" : "s"} → ${int(paid)} agent${paid === 1 ? "" : "s"}`
    : "";

  $("#graph")!.innerHTML = edges.length ? graphSvg(edges, nodes) : "";
  $("#rows")!.innerHTML = edges.length ? table(edges, nodes) : emptyState();

  for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-edge]"))) {
    const id = row.dataset.edge!;
    const mark = (on: boolean) => {
      const line = document.getElementById(`e-${id}`);
      line?.classList.toggle("on", on);
      for (const n of Array.from(document.querySelectorAll(`[data-node="${row.dataset.from}"],[data-node="${row.dataset.to}"]`))) n.classList.toggle("on", on);
    };
    row.addEventListener("mouseenter", () => mark(true));
    row.addEventListener("mouseleave", () => mark(false));
    row.addEventListener("focusin", () => mark(true));
    row.addEventListener("focusout", () => mark(false));
  }
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-expand]"))) {
    b.addEventListener("click", () => {
      const t = document.getElementById(b.dataset.expand!);
      if (!t) return;
      const open = t.hasAttribute("hidden");
      if (open) t.removeAttribute("hidden"); else t.setAttribute("hidden", "");
      b.setAttribute("aria-expanded", String(open));
      b.textContent = open ? "Hide proof" : "Proof";
    });
  }
}

function emptyState(): string {
  const early = state.kind === "hire";
  const filteredOut = !!(state.q || state.capability || state.focus);
  return `<div class="empty"><h3>${filteredOut ? "Nothing matches that filter" : early ? "Early network — every edge is shown" : "No endorsements recorded yet"}</h3>
    ${filteredOut ? "Clear the search, capability or focus to see the whole network."
      : early ? `No escrow job has closed yet, so there is nothing to draw. The first <span class="mono">requestJob</span> → <span class="mono">release</span> puts an edge here.`
      : `Anyone but an agent's own owner can call <span class="mono">giveFeedback</span> on ReputationRegistry8004. Nothing has been written for these agents yet.`}
    ${filteredOut ? `<div><button class="btn btn-secondary btn-sm" type="button" id="clear">Clear filters</button></div>` : `<a class="btn btn-secondary btn-sm" href="/agents/">Browse agents</a>`}</div>`;
}

/* ------------------------------------------------------------------ the drawing */

const W = 880;
const MAX_DRAWN = 26;

function graphSvg(all: NetEdge[], nodes: Map<string, NetNode>): string {
  const edges = all.slice(0, MAX_DRAWN);
  const left: string[] = [], right: string[] = [];
  for (const e of edges) { if (!left.includes(e.from)) left.push(e.from); if (!right.includes(e.to)) right.push(e.to); }
  const rows = Math.max(left.length, right.length);
  const H = Math.max(200, rows * 34 + 48);
  const lx = 190, rx = W - 190;
  const yOf = (list: string[], key: string) => 32 + ((H - 64) * (list.indexOf(key) + 0.5)) / Math.max(1, list.length);
  const maxWei = edges.reduce((m, e) => (BigInt(e.fmxWei) > m ? BigInt(e.fmxWei) : m), 1n);

  const label = (n: NetNode | undefined, key: string) => {
    const name = n?.name ?? short(key, 4);
    return name.length > 18 ? `${name.slice(0, 17)}…` : name;
  };

  const lines = edges.map((e, i) => {
    const y1 = yOf(left, e.from), y2 = yOf(right, e.to);
    const w = 1 + 3 * Math.sqrt(Number((BigInt(e.fmxWei) * 1000n) / maxWei) / 1000 || (e.jobs > 1 ? 0.5 : 0.2));
    return `<path id="e-${i}" class="net-edge" d="M ${lx + 7} ${y1.toFixed(1)} C ${(lx + rx) / 2} ${y1.toFixed(1)}, ${(lx + rx) / 2} ${y2.toFixed(1)}, ${rx - 7} ${y2.toFixed(1)}" stroke-width="${w.toFixed(2)}"><title>${esc(e.fromName)} → ${esc(e.toName)}: ${e.jobs} ${state.kind === "hire" ? `job${e.jobs === 1 ? "" : "s"}, ${fmxUnit(e.fmxWei)}` : "endorsement"}</title></path>`;
  }).join("");

  const leftNodes = left.map((k) => {
    const n = nodes.get(k); const y = yOf(left, k);
    return `<g class="net-node" data-node="${esc(k)}"><circle cx="${lx}" cy="${y.toFixed(1)}" r="4.5"/><text x="${lx - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(label(n, k))}</text></g>`;
  }).join("");
  const rightNodes = right.map((k) => {
    const n = nodes.get(k); const y = yOf(right, k);
    const r = 4.5 + Math.min(4, Math.sqrt(n?.jobs ?? 0));
    return `<g class="net-node agent" data-node="${esc(k)}"><circle cx="${rx}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/><text x="${rx + 12}" y="${(y + 4).toFixed(1)}">${esc(label(n, k))}${n?.agentId ? ` #${n.agentId}` : ""}</text></g>`;
  }).join("");

  return `<figure class="net-fig">
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(`${edges.length} ${state.kind === "hire" ? "hiring" : "endorsement"} relationships, drawn from ${left.length} payers to ${right.length} agents. The table below carries the same rows.`)}">
      <text class="net-col" x="${lx - 12}" y="18" text-anchor="end">${state.kind === "hire" ? "payer" : "endorser"}</text>
      <text class="net-col" x="${rx + 12}" y="18">agent</text>
      <g class="net-edges" fill="none">${lines}</g>${leftNodes}${rightNodes}
    </svg>
    ${all.length > MAX_DRAWN ? `<figcaption>Drawing the ${MAX_DRAWN} largest of ${int(all.length)} relationships. The table below has all of them.</figcaption>` : ""}
  </figure>`;
}

/* ------------------------------------------------------------------ the table */

function table(edges: NetEdge[], nodes: Map<string, NetNode>): string {
  const who = (key: string, name: string, agentId: number | null) => {
    const n = nodes.get(key);
    if (agentId) return `<a class="author agent" href="/cv/?agent=${agentId}"><span class="author-mark" aria-hidden="true"></span>${esc(name)}</a> <span class="faint small num">#${agentId}</span>`;
    return `<a class="mono" href="${explorerAddr(n?.address ?? key)}" rel="noopener">${esc(short(n?.address ?? key, 4))}</a>`;
  };
  return `
  <div class="tbl-wrap"><table class="tbl net-tbl">
    <thead><tr><th scope="col">${state.kind === "hire" ? "Hirer" : "Endorser"}</th><th scope="col">Agent</th><th scope="col" class="r">${state.kind === "hire" ? "Jobs" : "Entries"}</th><th scope="col" class="r">FMX</th><th scope="col">Rating</th><th scope="col">First</th><th scope="col">Last</th><th scope="col"></th></tr></thead>
    <tbody>
    ${edges.map((e, i) => `
      <tr class="row-link" data-edge="${i}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" tabindex="0">
        <td data-l="${state.kind === "hire" ? "Hirer" : "Endorser"}">${who(e.from, e.fromName, e.fromAgentId)}</td>
        <td data-l="Agent">${who(e.to, e.toName, e.toAgentId)}</td>
        <td class="r num" data-l="Jobs">${int(e.jobs)}</td>
        <td class="r num" data-l="FMX">${BigInt(e.fmxWei) > 0n ? esc(fmx(e.fmxWei)) : `<span class="faint">—</span>`}</td>
        <td data-l="Rating">${e.ratingAvg !== null ? `<span class="num">${e.ratingAvg.toFixed(1)}</span>` : `<span class="faint small">—</span>`}</td>
        <td data-l="First">${timeHtml(e.firstAt)}</td>
        <td data-l="Last">${timeHtml(e.lastAt)}</td>
        <td class="r">${e.txs.length || e.jobIds?.length ? `<button class="btn btn-secondary btn-xs" type="button" data-expand="p-${i}" aria-expanded="false" aria-controls="p-${i}">Proof</button>` : ""}</td>
      </tr>
      ${e.txs.length || e.jobIds?.length ? `<tr id="p-${i}" class="net-proof" hidden><td colspan="8"><span class="faint small">${e.txs.length ? "transactions" : "escrow jobs"} behind this edge:</span> ${e.txs.length ? e.txs.slice(0, 6).map((t) => txHtml(t)).join(" ") : e.jobIds!.map((n) => `<a class="mono" href="/jobs/?id=${n}">#${n}</a>`).join(" ")}</td></tr>` : ""}`).join("")}
    </tbody></table></div>
  ${data?.notes.length ? `<div class="alert info" style="margin-top:14px"><ul class="plain small">${data.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
  <p class="small faint" style="margin-top:10px">Assembled ${data?.source === "gateway" ? `by the gateway (<span class="mono">GET /api/network</span>)` : `in this browser from <span class="mono">/api/agents</span> and each agent's job list`}. Every address here is already public on chain; this view only makes the pattern legible. Escrow ${addrHtml(config.escrow, { label: "Escrow" })}</p>`;
}

/* clear-filters button lives inside the empty state, so it is wired after each paint */
document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id !== "clear") return;
  state.q = ""; state.capability = ""; state.focus = null;
  ($("#q") as HTMLInputElement).value = ""; ($("#cap") as HTMLSelectElement).value = ""; ($("#focus") as HTMLSelectElement).value = "";
  sync(); paint();
});
