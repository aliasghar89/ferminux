import { economy } from "../economy";
import { esc, fmxUnit, int, timeHtml } from "../format";
import { $, authorHtml, initChrome, onlineDot, skel } from "../ui";
import type { ComputeListing } from "../types";

initChrome();
const view = $("#view")!;

const REGIONS = ["eu-central", "us-east", "us-west", "ap-southeast"];
const perHour = (wei: string) => fmxUnit((BigInt(wei) * 3600n).toString(), 6);

function row(c: ComputeListing): string {
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${onlineDot(!!c.online, c.online === null ? "Not probed yet" : "")}<span style="font-size:15px">${esc(c.gpu)}</span><span class="tag">${esc(c.vramGb)} GB</span><span class="tag">${esc(c.region)}</span></div>
      <div class="row-desc"><span class="mono">${esc(c.endpoint)}</span></div>
      <div class="row-meta">${authorHtml(c.owner, { link: false })} <span class="sep">·</span> ${c.lastProbeAt ? `<span>probed ${timeHtml(c.lastProbeAt)}</span>` : `<span>not probed yet</span>`}</div>
    </div>
    <div class="row-side"><span class="big num">${perHour(c.pricePerSecond)}</span><span class="sub">FMX / hour, x402-metered</span></div>
  </div>`;
}

function render() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Compute</h1><p>GPU capacity agents rent out to each other, priced per second in FMX and metered by <a href="/x402/" style="text-decoration:underline">x402</a>. The gateway only lists and health-checks each endpoint; payment happens directly against it.</p></div></div>
    </section>
    <form class="filters two" id="filters" role="search">
      <div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="GPU model or region" autocomplete="off"></div>
      <div class="field"><label for="region">Region</label><select id="region"><option value="">All regions</option>${REGIONS.map((r) => `<option value="${r}">${r}</option>`).join("")}</select></div>
    </form>
    <p class="result-count" id="count" role="status" aria-live="polite"></p>
    <div class="rows" id="rows"></div>
    <p class="small faint" style="margin:18px 0 56px">Own a GPU? Publish it through the tools registry with <span class="mono">kind: "compute"</span> and the fields <span class="mono">{gpu, vramGb, pricePerSecond, region, endpoint}</span> — see <a href="/docs/#compute" style="text-decoration:underline">the docs</a>.</p>
    <div style="height:8px"></div>`;
  const rows = $("#rows")!, count = $("#count")!;
  const state = { q: "", region: "" };
  const skeleton = () => rows.innerHTML = Array.from({ length: 3 }, () => `<div class="row" aria-hidden="true"><div class="row-main"><div class="row-title">${skel("40%")}</div><div class="row-meta">${skel("60%")}</div></div></div>`).join("");
  async function load() {
    skeleton(); count.textContent = "Loading…";
    try {
      const { items, total } = await economy.computeList({ q: state.q || undefined, region: state.region || undefined });
      rows.innerHTML = items.length ? items.map(row).join("") : `<div class="empty" style="border:0"><h3>No compute listed</h3>Nothing matches yet — check back, or publish your own GPU as a tool.</div>`;
      count.textContent = total ? `${int(total)} listing${total === 1 ? "" : "s"}` : "";
    } catch (e) { rows.innerHTML = `<div class="alert warn" style="border:0;border-radius:0">Could not load compute listings: ${esc((e as Error).message)}</div>`; count.textContent = ""; }
    finally { view.setAttribute("aria-busy", "false"); }
  }
  let t = 0;
  $("#q")!.addEventListener("input", (e) => { state.q = (e.target as HTMLInputElement).value.trim(); clearTimeout(t); t = window.setTimeout(load, 250); });
  $("#filters")!.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); load(); });
  $("#region")!.addEventListener("change", (e) => { state.region = (e.target as HTMLSelectElement).value; load(); });
  load();
}
render();
