/* A one-series area chart (surfaces/explorer.md §4.16; dataviz: single series, no legend, 2 px line, 15 % → 0 %
   fill, recessive grid, crosshair + tooltip on hover and on ←/→, a "Show data" table). Pure SVG, sized from
   the container width on each resize. Values are bigint wei; the axis is in FMX. */
import { html, mount } from "../../ui/html";
import { fmx } from "../../format";
import { onAbort } from "../../util";

export interface Pt { t: number; label: string; v: bigint }

const H = 140, PAD = { l: 64, r: 12, t: 12, b: 24 };
const toNum = (v: bigint) => Number(v / 10n ** 12n) / 1e6; // FMX as a float, for geometry only

export function areaChart(host: HTMLElement, pts: Pt[], o: { label: string; signal: AbortSignal }) {
  if (pts.length < 2) return;
  const vals = pts.map((p) => toNum(p.v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi = hi + (hi || 1) * 0.1; lo = Math.max(0, lo - (lo || 1) * 0.1); }
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad); hi = hi + pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let idx = pts.length - 1;

  const draw = () => {
    const W = Math.max(280, host.clientWidth);
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
    // a step line: a balance holds its value until the next change
    let d = `M${x(pts[0].t).toFixed(1)},${y(vals[0]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += `H${x(pts[i].t).toFixed(1)}V${y(vals[i]).toFixed(1)}`;
    const area = `${d}V${H - PAD.b}H${x(t0).toFixed(1)}Z`;
    const ticks = [lo, (lo + hi) / 2, hi];
    const xl = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i);
    const p = pts[idx];
    mount(host, html`<svg class="ad-ac" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label}" tabindex="0">
      <defs><linearGradient id="adx-ac-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".15"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => html`<line class="ad-ac-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ad-ac-ax" x="${PAD.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtAxis(v)}</text>`)}
      ${xl.map((i) => html`<text class="ad-ac-ax" x="${x(pts[i].t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}">${pts[i].label}</text>`)}
      <path class="ad-ac-area" d="${area}" fill="url(#adx-ac-g)"/>
      <path class="ad-ac-line" d="${d}"/>
      <line class="ad-ac-x" x1="${x(p.t).toFixed(1)}" x2="${x(p.t).toFixed(1)}" y1="${PAD.t}" y2="${H - PAD.b}"/>
      <circle class="ad-ac-dot" cx="${x(p.t).toFixed(1)}" cy="${y(vals[idx]).toFixed(1)}" r="4"/>
    </svg><div class="ad-ac-tip" role="status" aria-live="polite"><span class="mono">${p.label}</span> <b class="num-mono">${fmx(p.v, 4)}</b> <span class="faint">FMX</span></div>`);
    const svg = host.querySelector<SVGSVGElement>("svg")!;
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      let best = 0, bd = Infinity;
      pts.forEach((q, i) => { const dd = Math.abs(x(q.t) - px); if (dd < bd) { bd = dd; best = i; } });
      if (best !== idx) { idx = best; draw(); }
    });
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      idx = Math.max(0, Math.min(pts.length - 1, idx + (e.key === "ArrowLeft" ? -1 : 1)));
      draw();
      host.querySelector<SVGSVGElement>("svg")?.focus();
    });
  };
  draw();
  let w = host.clientWidth;
  const ro = new ResizeObserver(() => { if (host.clientWidth !== w) { w = host.clientWidth; draw(); } });
  ro.observe(host);
  onAbort(o.signal, () => ro.disconnect());
}

function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (a >= 1) return v.toFixed(a >= 100 ? 0 : 1);
  return v.toFixed(3);
}
