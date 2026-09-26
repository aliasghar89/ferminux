/* Stats charts (surfaces/explorer.md §4.16; dataviz skill). One hue, the Ferminux green; no second hue,
   no pies, no animation after render (inner pages never move, §7.1).
   - areaChart(): one series, horizontal gridlines only, a crosshair + tooltip that snaps to the nearest
     day, ←/→ Home/End stepping from the keyboard, the peak labelled once. Redraws on width change.
   - lanesHtml(): the signer lanes, 5 rows × the last 64 blocks, a 4 × 12 px tick where that signer
     confirmed the block (filled = in turn, outlined = out of turn), count and in-turn share per row. */
import { html, type Html } from "../../ui/html";
import { seal } from "../../ui/seal";
import { int, pct } from "../../format";
import { signerNo } from "../../signer";
import { lc, onAbort } from "../../util";
import { dayLabel } from "../../ui/kit";

/* ---------------------------------------------------------------- area chart */

export interface Point { date: string; value: number }

function niceStep(max: number, ticks: number): number {
  const raw = Math.max(1, max) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

let chartSeq = 0;
/**
 * Draw `pts` (oldest first) into `host`. `unit` names the value in the tooltip ("transactions").
 * Returns nothing; everything is torn down when `signal` aborts.
 */
export function areaChart(host: HTMLElement, pts: Point[], o: { unit: string; label: string; signal: AbortSignal; height?: number }) {
  const id = `ac${++chartSeq}`;
  const n = pts.length;
  const max = Math.max(0, ...pts.map((p) => p.value));
  const step = niceStep(max, 4);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const peak = pts.reduce((b, p, i) => (p.value > pts[b].value ? i : b), 0);
  const lo = Math.min(...pts.map((p) => p.value));

  host.classList.add("ns-chart");
  host.tabIndex = 0;
  host.setAttribute("role", "group");
  host.setAttribute("aria-roledescription", "chart");
  host.setAttribute("aria-label", `${o.label}: ${int(lo)} to ${int(max)} per day, ${dayLabel(pts[0].date, true)} to ${dayLabel(pts[n - 1].date, true)}. Use the left and right arrow keys to read each day.`);
  let cur = -1;
  let W = 0;
  let fx: ((i: number) => number) | null = null, fy: ((v: number) => number) | null = null;

  const draw = () => {
    W = host.clientWidth - 36; // the host's 18 px side padding
    if (W < 120) return;
    const H = o.height ?? (W < 520 ? 150 : 180);
    const L = 8 + String(int(top)).length * 7, R = 8, T = 14, B = 22;
    const x = (i: number) => L + (n === 1 ? 0 : (i * (W - L - R)) / (n - 1));
    const y = (v: number) => T + (H - T - B) * (1 - v / top);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join("");
    const area = `${line}L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)}L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z`;
    const xl = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
    const px = x(peak), py = y(pts[peak].value);
    host.innerHTML = html`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">
  <defs><linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s0"/><stop offset="1" class="s1"/></linearGradient></defs>
  ${ticks.map((t) => html`<line class="${t === 0 ? "base" : "grid"}" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ax" x="${L - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${int(t)}</text>`)}
  ${xl.map((i, k) => html`<text class="ax" x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="${k === 0 ? "start" : k === xl.length - 1 ? "end" : "middle"}">${dayLabel(pts[i].date)}</text>`)}
  <path d="${area}" fill="url(#${id}-g)"/>
  <path class="ln" d="${line}"/>
  ${max > 0 ? html`<text class="pk" x="${px.toFixed(1)}" y="${(py - 6).toFixed(1)}" text-anchor="${peak === 0 ? "start" : peak === n - 1 ? "end" : "middle"}">${int(pts[peak].value)}</text>` : ""}
  <g data-hover hidden><line class="xh" x1="0" x2="0" y1="${T}" y2="${y(0).toFixed(1)}"/><circle class="dot" r="4" cx="0" cy="0"/></g>
</svg><div class="ns-tip" hidden></div><p class="vh" aria-live="polite"></p>`.s;
    fx = x; fy = y;
    if (cur >= 0) show(cur, false);
  };

  const show = (i: number, speak: boolean) => {
    cur = i;
    if (!fx || !fy) return;
    const g = host.querySelector<SVGGElement>("[data-hover]");
    const tip = host.querySelector<HTMLElement>(".ns-tip");
    if (!g || !tip) return;
    const cx = fx(i), cy = fy(pts[i].value);
    g.removeAttribute("hidden");
    g.querySelector("line")!.setAttribute("x1", cx.toFixed(1));
    g.querySelector("line")!.setAttribute("x2", cx.toFixed(1));
    g.querySelector("circle")!.setAttribute("cx", cx.toFixed(1));
    g.querySelector("circle")!.setAttribute("cy", cy.toFixed(1));
    const text = `${int(pts[i].value)} ${pts[i].value === 1 ? o.unit.replace(/s$/, "") : o.unit}`;
    tip.innerHTML = html`<b>${text}</b>${dayLabel(pts[i].date, true)}`.s;
    tip.hidden = false;
    // beside the crosshair (right, or left near the end), never over the point being read
    const tw = tip.offsetWidth;
    const right = 18 + cx + 12, leftSide = 18 + cx - 12 - tw;
    const left = right + tw <= host.clientWidth ? right : Math.max(0, leftSide);
    tip.style.transform = `translateX(${left.toFixed(0)}px)`;
    if (speak) { const live = host.querySelector(".vh"); if (live) live.textContent = `${dayLabel(pts[i].date, true)}: ${text}`; }
  };
  const hide = () => {
    if (document.activeElement === host) return;
    cur = -1;
    host.querySelector("[data-hover]")?.setAttribute("hidden", "");
    const tip = host.querySelector<HTMLElement>(".ns-tip"); if (tip) tip.hidden = true;
  };
  const nearest = (clientX: number) => {
    const r = host.getBoundingClientRect();
    if (!fx) return 0;
    const px = clientX - r.left - 18;
    let best = 0, d = Infinity;
    for (let i = 0; i < n; i++) { const dd = Math.abs(fx(i) - px); if (dd < d) { d = dd; best = i; } }
    return best;
  };

  host.addEventListener("pointermove", (e) => show(nearest(e.clientX), false));
  host.addEventListener("pointerleave", hide);
  host.addEventListener("focus", () => show(cur >= 0 ? cur : n - 1, true));
  host.addEventListener("blur", () => { cur = -1; hide(); });
  host.addEventListener("keydown", (e) => {
    const k = e.key;
    let i = cur < 0 ? n - 1 : cur;
    if (k === "ArrowLeft") i = Math.max(0, i - 1);
    else if (k === "ArrowRight") i = Math.min(n - 1, i + 1);
    else if (k === "Home") i = 0;
    else if (k === "End") i = n - 1;
    else return;
    e.preventDefault();
    show(i, true);
  });

  draw();
  let raf = 0, lastW = host.clientWidth;
  const ro = new ResizeObserver(() => {
    if (host.clientWidth === lastW) return;
    lastW = host.clientWidth;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  });
  ro.observe(host);
  onAbort(o.signal, () => { ro.disconnect(); cancelAnimationFrame(raf); });
}

/* ---------------------------------------------------------------- signer lanes */

export interface Tick { n: number; signer: string | null | undefined; turn: boolean | null; ts: number }
export interface LaneRow { addr: string; count: number; inTurn: number }

/** Per-signer counts over a window (lower-case addresses), for the lanes, the table and the summary. */
export function laneRows(set: string[], ticks: Tick[]): LaneRow[] {
  const all = new Set(set.map(lc));
  ticks.forEach((t) => { if (t.signer) all.add(lc(t.signer)); });
  return [...all].map((a) => ({
    addr: a,
    count: ticks.filter((t) => lc(t.signer) === a).length,
    inTurn: ticks.filter((t) => lc(t.signer) === a && t.turn === true).length,
  })).sort((x, y) => (signerNo(x.addr) ?? 99) - (signerNo(y.addr) ?? 99) || x.addr.localeCompare(y.addr));
}

const nameOf = (a: string) => { const k = signerNo(a); return k ? `Signer ${k}` : "Unknown signer"; };

/** The lanes markup (aria-hidden) plus a sentence per signer for readers. `ticks` are oldest first. */
export function lanesHtml(rows: LaneRow[], ticks: Tick[], head: number): Html {
  const first = ticks[0]?.n, last = ticks[ticks.length - 1]?.n;
  const lane = (r: LaneRow) => html`<div class="ns-lane">
  <span class="ns-lh">${seal({ height: head, signer: r.addr, name: true })}</span>
  <span class="ns-ticks">${ticks.map((t) => lc(t.signer) === r.addr
    ? html`<span class="${t.turn ? "in" : "out"}" title="Block ${int(t.n)} · ${nameOf(r.addr)} · ${t.turn ? "in turn" : "out of turn"}"><i></i></span>`
    : html`<span></span>`)}</span>
  <span class="ns-lc">${int(r.count)}<span class="faint">· ${r.count ? pct((r.inTurn / r.count) * 100, 0) : "0%"} in turn</span></span>
</div>`;
  const say = (r: LaneRow) => `${nameOf(r.addr)} confirmed ${r.count} of the last ${ticks.length} blocks, ${r.inTurn} in turn.`;
  return html`<div class="ns-lanes" aria-hidden="true">${rows.map(lane)}
  <div class="ns-axis"><span></span><span><span>${first !== undefined ? html`Block ${int(first)}` : ""}</span><span>${last !== undefined ? int(last) : ""}</span></span><span></span></div>
</div><ul class="vh">${rows.map((r) => html`<li>${say(r)}</li>`)}</ul>`;
}
