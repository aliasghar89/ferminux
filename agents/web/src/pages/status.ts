// /status/ — the gateway's own health board (GET /api/status).
//
// The route is young: a gateway that predates it answers 404, so a failed read renders a calm
// "status unavailable" panel instead of throwing, and a failed *refresh* keeps the last good board
// on screen with a stale marker rather than blanking a page someone is watching.
import { api, ApiError } from "../api";
import { config } from "../config";
import { dur, esc, int } from "../format";
import { $, addrHtml, initChrome, skel } from "../ui";
import type { StatusService, StatusView } from "../types";

initChrome();
const view = $("#view")!;
const REFRESH_MS = 15_000;
let last: StatusView | null = null;
let timer = 0;

render();
load();
start();

function render() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Network status</h1><p>Chain head, indexer lag and every gateway service, straight from <span class="mono">GET /api/status</span>. This page re-reads it every ${REFRESH_MS / 1000} seconds.</p></div></div>
    </section>
    <div id="st-banner" style="margin-bottom:20px">${skel("50%")}</div>
    <div id="st-chain" style="margin-bottom:28px"></div>
    <div class="section-head"><h3>Services</h3><span class="small faint" id="st-checked"></span></div>
    <div id="st-services"></div>
    <div style="height:56px"></div>`;
  view.setAttribute("aria-busy", "false");
}

function start() {
  timer = window.setInterval(load, REFRESH_MS);
  // A backgrounded tab should not keep polling; pagehide also covers bfcache on iOS.
  window.addEventListener("pagehide", stop);
}
function stop() { if (timer) { clearInterval(timer); timer = 0; } }

async function load() {
  try {
    const s = await api.status();
    last = s;
    paint(s, null);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    if (last) paint(last, status === 404 ? "This gateway does not serve /api/status." : "The last refresh did not come back.");
    else unavailable(status);
  }
}

function unavailable(status: number) {
  $("#st-banner")!.innerHTML = "";
  $("#st-chain")!.innerHTML = "";
  $("#st-checked")!.textContent = "";
  $("#st-services")!.innerHTML = `<div class="empty"><h3>Status unavailable</h3>
    ${status === 404
      ? `This gateway does not serve <span class="mono">/api/status</span> yet. The network itself is unaffected — the explorer and <span class="mono">${esc(config.gateway)}/health</span> still answer.`
      : `The gateway did not answer <span class="mono">/api/status</span>. It may be restarting; this page keeps trying every ${REFRESH_MS / 1000} seconds.`}
    <br><button class="btn btn-secondary" type="button" id="st-retry">Check again</button></div>`;
  $("#st-retry")?.addEventListener("click", () => load());
}

function paint(s: StatusView, stale: string | null) {
  const services = s.services ?? {};
  const degraded = (s.degraded ?? []).filter((k) => typeof k === "string");
  const bad = degraded.length ? degraded : Object.entries(services).filter(([, v]) => v && v.ok === false).map(([k]) => k);
  const ok = s.ok !== false && bad.length === 0;

  $("#st-banner")!.innerHTML = `<div class="alert ${ok ? "ok" : "warn"}">
      <strong>${ok ? "All services ok" : `${int(bad.length)} service${bad.length === 1 ? "" : "s"} degraded`}</strong>${ok ? "" : ` — ${bad.map((k) => `<span class="mono">${esc(k)}</span>`).join(", ")}`}.
      ${s.version ? ` Gateway ${esc(s.version)}.` : ""}${typeof s.uptimeS === "number" ? ` Up ${esc(dur(s.uptimeS))}.` : ""}
      ${stale ? ` <span class="faint">${esc(stale)} Showing the last good reading.</span>` : ""}
    </div>`;

  $("#st-chain")!.innerHTML = `<div class="statgrid">
      <div><div class="l">Chain head</div><div class="v num">${int(s.head)}</div></div>
      <div><div class="l">Indexed block</div><div class="v num">${int(s.indexedBlock)}</div></div>
      <div><div class="l">Head lag</div><div class="v num">${typeof s.headLag === "number" ? `${int(s.headLag)} block${s.headLag === 1 ? "" : "s"}` : "—"}</div></div>
      <div><div class="l">Indexer lag</div><div class="v num">${typeof s.indexerLagSeconds === "number" ? esc(dur(s.indexerLagSeconds)) : "—"}</div></div>
    </div>
    <p class="small faint" style="margin-top:10px">Chain ${esc(String(s.chainId ?? config.chainId))} · gateway <span class="mono">${esc(config.gateway)}</span> · blocks are produced by the network's signers every 7 seconds, so a lag of a block or two is normal.</p>`;

  $("#st-checked")!.textContent = `checked ${new Date().toLocaleTimeString("en-GB")}`;

  const keys = Object.keys(services);
  $("#st-services")!.innerHTML = keys.length
    ? `<div class="cards cards-3" style="gap:12px">${keys.map((k) => serviceCard(k, services[k]!)).join("")}</div>`
    : `<div class="empty"><h3>No services reported</h3>The gateway answered, but listed no services.</div>`;
}

const LABEL: Record<string, string> = {
  head: "Head", indexedBlock: "Indexed block", lagBlocks: "Block lag", lagSeconds: "Time lag", latencyMs: "Latency",
  balanceFmx: "Balance", lowFunds: "Funding", queued: "Queued", dripFmx: "Drip", usedToday: "Used today",
  remainingToday: "Left today", pending: "Pending", failed24h: "Failed (24 h)", sizeBytes: "Size", address: "Address",
};
const ORDER = Object.keys(LABEL);

function serviceCard(name: string, svc: StatusService): string {
  const disabled = svc.enabled === false;
  const state = disabled ? "off" : svc.ok ? "ok" : "degraded";
  const pill = disabled ? `<span class="pill">disabled</span>` : svc.ok ? `<span class="pill ok">ok</span>` : `<span class="pill warn">degraded</span>`;
  const extras = Object.keys(svc)
    .filter((k) => k !== "ok" && k !== "enabled" && k !== "detail" && svc[k] !== null && svc[k] !== undefined && typeof svc[k] !== "object")
    .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return `<div class="panel" data-state="${state}">
    <div class="panel-head"><h3 class="mono" style="font-size:14px">${esc(name)}</h3>${pill}</div>
    <div class="panel-body" style="gap:8px">
      ${extras.length ? `<dl class="kv" style="border:0;background:transparent">${extras.map((k) => extraRow(k, svc[k])).join("")}</dl>` : `<p class="small muted" style="margin:0">${disabled ? "Not enabled on this gateway." : "Responding."}</p>`}
      ${!svc.ok && svc.detail ? `<p class="small" style="margin:0;color:var(--warn)">${esc(svc.detail)}</p>` : ""}
      ${svc.ok && svc.detail ? `<p class="small muted" style="margin:0">${esc(svc.detail)}</p>` : ""}
    </div></div>`;
}

function extraRow(key: string, value: unknown): string {
  return `<div class="kv-row" style="padding:5px 0;border-bottom:0;grid-template-columns:110px 1fr"><dt class="small">${esc(LABEL[key] ?? key)}</dt><dd class="small">${extraValue(key, value)}</dd></div>`;
}

function extraValue(key: string, value: unknown): string {
  if (typeof value === "boolean") {
    if (key === "lowFunds") return value ? `<span class="pill warn">low</span>` : `<span class="pill ok">funded</span>`;
    return value ? `<span class="pill ok">yes</span>` : `<span class="pill">no</span>`;
  }
  if (key === "address" && typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return addrHtml(value);
  if (key === "sizeBytes") return `<span class="num">${esc(bytes(Number(value)))}</span>`;
  if (key === "latencyMs") return `<span class="num">${int(Number(value))} ms</span>`;
  if (key === "lagSeconds") return `<span class="num">${esc(dur(Number(value)))}</span>`;
  if (key === "lagBlocks") return `<span class="num">${int(Number(value))} block${Number(value) === 1 ? "" : "s"}</span>`;
  if (key === "balanceFmx" || key === "dripFmx") return `<span class="num">${esc(String(value))} FMX</span>`;
  if (typeof value === "number") return `<span class="num">${int(value)}</span>`;
  return `<span class="mono" style="font-size:12.5px">${esc(String(value))}</span>`;
}

function bytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
