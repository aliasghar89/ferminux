/* The Transactions sparkline in the home vitals (surfaces/explorer.md §4.16): 32 px, one series, a 1.5 px
   --accent line over a 15 % → 0 % area, no axes. Single series: no legend, the cell label names it.
   Hover layer (dataviz): pointer over the line marks the nearest day and the cell's sub-line reads
   "21 Sep · 100 transactions" until the pointer leaves. Values come from the index's daily chart. */
import { html, raw, type Html } from "../../ui/html";
import { int } from "../../format";

export interface Pt { date: string; n: number }
let seq = 0;

/** Days oldest → newest. Empty or single-point data renders nothing (a line needs two points). */
export function sparkHtml(pts: Pt[]): Html {
  if (pts.length < 2) return html``;
  const W = 160, H = 32, pad = 2;
  const max = Math.max(1, ...pts.map((p) => p.n));
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.n).toFixed(1)}`).join("");
  const id = `spk-${++seq}`;
  const lo = Math.min(...pts.map((p) => p.n));
  return html`<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Transactions per day, last ${pts.length} days: ${int(lo)} to ${int(max)}" data-pts="${JSON.stringify(pts.map((p) => [p.date, p.n]))}">
<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05ee93" stop-opacity=".15"/><stop offset="1" stop-color="#05ee93" stop-opacity="0"/></linearGradient></defs>
${raw(`<path d="${line}L${W} ${H}L0 ${H}Z" fill="url(#${id})"/><path d="${line}" fill="none" stroke="#05ee93" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`)}
<line class="spark-x" x1="0" x2="0" y1="0" y2="${H}" vector-effect="non-scaling-stroke" hidden/>
</svg>`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => { const [, m, dd] = d.split("-").map(Number); return `${dd} ${MON[(m || 1) - 1]}`; };

/** Hover: the nearest day's count replaces `sub`'s text; leaving restores it. Pointer only (fine or coarse). */
export function bindSpark(svg: SVGSVGElement | null, sub: HTMLElement | null) {
  if (!svg || !sub) return;
  let pts: [string, number][] = [];
  try { pts = JSON.parse(svg.dataset.pts ?? "[]"); } catch { return; }
  const xl = svg.querySelector<SVGLineElement>(".spark-x");
  const leave = () => { xl?.setAttribute("hidden", ""); if (sub.dataset.base !== undefined) sub.textContent = sub.dataset.base; delete sub.dataset.hover; };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    if (!r.width || pts.length < 2) return;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))));
    const vx = (i / (pts.length - 1)) * 160;
    xl?.setAttribute("x1", String(vx)); xl?.setAttribute("x2", String(vx)); xl?.removeAttribute("hidden");
    if (sub.dataset.hover === undefined) sub.dataset.base = sub.textContent ?? "";
    sub.dataset.hover = "1";
    const [d, n] = pts[i];
    sub.textContent = `${day(d)} · ${int(n)} transaction${n === 1 ? "" : "s"}`;
  });
  svg.addEventListener("pointerleave", leave);
}
