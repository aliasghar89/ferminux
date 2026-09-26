// Time-series charts drawn as inline SVG: no chart library, nothing fetched.
//
// One visual system for every chart in the app: hairline grid, right-hand mono
// value axis, the Ferminux green for the primary series (a faint area under
// it), neutral greys for the rest, a dashed line for a reference level (the
// official FMX price). Pointer and keyboard both move a crosshair; the values
// under it are read out in a live region. Every chart also carries a one-line
// text summary for readers that never see the pixels.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { Point } from '../lib/market.ts';

export interface Series {
  id: string;
  label: string;
  points: Point[];
  tone: 'accent' | 'muted' | 'faint';
  /** Hold each value until the next point (prices), instead of joining points with a slope. */
  step?: boolean;
  area?: boolean;
  dashed?: boolean;
}

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** The value a series shows at time `t`: the last point at or before it (step), or interpolated. */
function valueAt(s: Series, t: number): number | null {
  const pts = s.points;
  if (pts.length === 0 || t < pts[0].t) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const p = pts[lo];
  if (s.step || lo === pts.length - 1) return p.v;
  const n = pts[lo + 1];
  return p.v + ((n.v - p.v) * (t - p.t)) / (n.t - p.t);
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function formatAxisTime(t: number, span: number): string {
  const d = new Date(t * 1000);
  if (span <= 2 * 86_400) return d.toISOString().slice(11, 16);
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${d.getUTCDate()} ${month}`;
}

export function formatTooltipTime(t: number): string {
  const d = new Date(t * 1000);
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)} UTC`;
}

const PAD = { top: 14, right: 60, bottom: 26, left: 4 };

export function LineChart({
  series,
  from,
  to,
  height = 260,
  formatY,
  reference,
  summary,
  emptyText = 'No data in this range yet.',
  testId,
}: {
  series: Series[];
  from: number;
  to: number;
  height?: number;
  formatY: (v: number) => string;
  reference?: { value: number; label: string };
  summary: string;
  emptyText?: string;
  testId?: string;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);
  const gradId = 'g' + useId().replace(/[^a-zA-Z0-9]/g, '');

  // What is on screen: points inside [from, to], plus the last value before
  // `from` for step series, so a price that did not move still draws a line.
  const visible = useMemo(
    () =>
      series.map((s) => {
        const inside = s.points.filter((p) => p.t >= from && p.t <= to);
        const before = [...s.points].reverse().find((p) => p.t < from);
        const pts = before && s.step ? [{ t: from, v: before.v }, ...inside] : inside;
        if (s.step && pts.length > 0 && pts[pts.length - 1].t < to) pts.push({ t: to, v: pts[pts.length - 1].v });
        return { ...s, points: pts };
      }),
    [series, from, to],
  );

  const values = visible.flatMap((s) => s.points.map((p) => p.v));
  if (reference) values.push(reference.value);
  const hasData = visible.some((s) => s.points.length > 0);

  let yMin = values.length ? Math.min(...values) : 0;
  let yMax = values.length ? Math.max(...values) : 1;
  if (yMax - yMin < Math.abs(yMax) * 0.02 || yMax === yMin) {
    const pad = Math.abs(yMax) * 0.1 || 1;
    yMin -= pad;
    yMax += pad;
  } else {
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
  }
  if (yMin < 0 && values.every((v) => v >= 0)) yMin = 0;

  const w = Math.max(width, 120);
  const innerW = w - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - from) / Math.max(1, to - from)) * innerW;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const pathFor = (s: Series) => {
    let d = '';
    s.points.forEach((p, i) => {
      const px = x(p.t).toFixed(1);
      const py = y(p.v).toFixed(1);
      if (i === 0) d += `M${px},${py}`;
      else if (s.step) d += `H${px}V${py}`;
      else d += `L${px},${py}`;
    });
    return d;
  };

  const yTicks = niceTicks(yMin, yMax, 4);
  const xCount = Math.max(2, Math.min(6, Math.floor(innerW / 90)));
  const xTicks = Array.from({ length: xCount }, (_, i) => from + ((to - from) * i) / (xCount - 1));
  const span = to - from;

  // Crosshair stops: every point time on screen.
  const stops = useMemo(
    () => [...new Set(visible.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b),
    [visible],
  );

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = from + ((px - PAD.left) / innerW) * (to - from);
    setCursor(Math.min(to, Math.max(from, t)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (stops.length === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cur = cursor ?? (e.key === 'ArrowLeft' ? to + 1 : from - 1);
      const next =
        e.key === 'ArrowRight' ? (stops.find((s) => s > cur) ?? stops[stops.length - 1]) : ([...stops].reverse().find((s) => s < cur) ?? stops[0]);
      setCursor(next);
    } else if (e.key === 'Escape') {
      setCursor(null);
    }
  };

  const readout =
    cursor !== null
      ? visible
          .map((s) => ({ s, v: valueAt(s, cursor) }))
          .filter((r): r is { s: typeof r.s; v: number } => r.v !== null)
      : [];
  const tipLeft = cursor !== null ? Math.min(Math.max(x(cursor) + 12, 4), w - 190) : 0;

  return (
    <div className="chart" ref={wrapRef} data-testid={testId}>
      <p className="sr-only">{summary}</p>
      {!hasData ? (
        <div className="chart-empty" style={{ height }}>
          {emptyText}
        </div>
      ) : (
        <div
          className="chart-frame"
          tabIndex={0}
          role="group"
          aria-label={`${summary} Use the left and right arrow keys to read values.`}
          onKeyDown={onKey}
          onBlur={() => setCursor(null)}
        >
          <svg
            width={w}
            height={height}
            viewBox={`0 0 ${w} ${height}`}
            onPointerMove={onMove}
            onPointerLeave={() => setCursor(null)}
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {yTicks.map((v) => (
              <g key={v}>
                <line className="chart-grid" x1={PAD.left} x2={w - PAD.right + 6} y1={y(v)} y2={y(v)} />
                <text className="chart-axis" x={w - PAD.right + 10} y={y(v) + 4}>
                  {formatY(v)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text
                key={t}
                className="chart-axis"
                x={x(t)}
                y={height - 8}
                textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
              >
                {formatAxisTime(t, span)}
              </text>
            ))}
            {reference && reference.value >= yMin && reference.value <= yMax && (
              <g>
                <line className="chart-ref" x1={PAD.left} x2={w - PAD.right + 6} y1={y(reference.value)} y2={y(reference.value)} />
                <text className="chart-ref-label" x={PAD.left + 4} y={y(reference.value) - 6}>
                  {reference.label}
                </text>
              </g>
            )}
            {visible.map((s) =>
              s.area && s.points.length > 1 ? (
                <path
                  key={s.id + '-area'}
                  d={`${pathFor(s)}V${(PAD.top + innerH).toFixed(1)}H${x(s.points[0].t).toFixed(1)}Z`}
                  fill={`url(#${gradId})`}
                />
              ) : null,
            )}
            {visible.map((s) => (
              <path key={s.id} className={`chart-line tone-${s.tone}${s.dashed ? ' dashed' : ''}`} d={pathFor(s)} />
            ))}
            {visible.map((s) =>
              s.points.length === 1 ? (
                <circle key={s.id + '-dot'} className={`chart-dot tone-${s.tone}`} cx={x(s.points[0].t)} cy={y(s.points[0].v)} r={3} />
              ) : null,
            )}
            {cursor !== null && (
              <g>
                <line className="chart-cursor" x1={x(cursor)} x2={x(cursor)} y1={PAD.top} y2={PAD.top + innerH} />
                {readout.map(({ s, v }) => (
                  <circle key={s.id} className={`chart-dot tone-${s.tone}`} cx={x(cursor)} cy={y(v)} r={3.5} />
                ))}
              </g>
            )}
          </svg>
          {cursor !== null && readout.length > 0 && (
            <div className="chart-tip" style={{ left: tipLeft }} aria-live="polite">
              <div className="chart-tip-time">{formatTooltipTime(cursor)}</div>
              {readout.map(({ s, v }) => (
                <div key={s.id} className="chart-tip-row">
                  <span className={`legend-swatch tone-${s.tone}${s.dashed ? ' dashed' : ''}`} />
                  <span className="chart-tip-label">{s.label}</span>
                  <span className="chart-tip-value">{formatY(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BarChart({
  bars,
  bucketSec,
  height = 200,
  formatY,
  summary,
  label,
  testId,
}: {
  bars: Array<{ t: number; v: number }>;
  bucketSec: number;
  height?: number;
  formatY: (v: number) => string;
  summary: string;
  label: string;
  testId?: string;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const w = Math.max(width, 120);
  const innerW = w - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = Math.max(...bars.map((b) => b.v), 0);
  const yMax = max > 0 ? max * 1.1 : 1;
  const slot = bars.length > 0 ? innerW / bars.length : innerW;
  const barW = Math.max(2, Math.min(18, slot * 0.62));
  const y = (v: number) => PAD.top + (1 - v / yMax) * innerH;
  const yTicks = niceTicks(0, yMax, 3);
  const from = bars[0]?.t ?? 0;
  const to = (bars[bars.length - 1]?.t ?? 0) + bucketSec;
  const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(innerW / 70))));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (bars.length === 0) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(bars.length - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? bars.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  return (
    <div className="chart" ref={wrapRef} data-testid={testId}>
      <p className="sr-only">{summary}</p>
      <div className="chart-frame" tabIndex={0} role="group" aria-label={`${summary} Use the arrow keys to read each ${label}.`} onKeyDown={onKey} onBlur={() => setActive(null)}>
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} aria-hidden="true" onPointerLeave={() => setActive(null)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={PAD.left} x2={w - PAD.right + 6} y1={y(v)} y2={y(v)} />
              <text className="chart-axis" x={w - PAD.right + 10} y={y(v) + 4}>
                {formatY(v)}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const cx = PAD.left + slot * i + slot / 2;
            const h = Math.max(b.v > 0 ? 2 : 0, PAD.top + innerH - y(b.v));
            return (
              <g key={b.t} onPointerEnter={() => setActive(i)}>
                <rect x={cx - slot / 2} y={PAD.top} width={slot} height={innerH} fill="transparent" />
                <rect
                  className={'chart-bar' + (active === i ? ' is-active' : '')}
                  x={cx - barW / 2}
                  y={PAD.top + innerH - h}
                  width={barW}
                  height={h}
                  rx={2}
                />
                {i % labelEvery === 0 && (
                  <text className="chart-axis" x={cx} y={height - 8} textAnchor="middle">
                    {formatAxisTime(b.t, to - from)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {active !== null && bars[active] && (
          <div
            className="chart-tip"
            style={{ left: Math.min(Math.max(PAD.left + slot * active + slot / 2 + 10, 4), w - 190) }}
            aria-live="polite"
          >
            <div className="chart-tip-time">{formatTooltipTime(bars[active].t)}</div>
            <div className="chart-tip-row">
              <span className="chart-tip-label">{label}</span>
              <span className="chart-tip-value">{formatY(bars[active].v)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Direct labels under a chart: swatch, name, current value. */
export function Legend({ items }: { items: Array<{ id: string; label: string; tone: Series['tone']; dashed?: boolean; value?: string }> }) {
  return (
    <ul className="legend">
      {items.map((it) => (
        <li key={it.id}>
          <span className={`legend-swatch tone-${it.tone}${it.dashed ? ' dashed' : ''}`} aria-hidden="true" />
          <span className="legend-label">{it.label}</span>
          {it.value && <span className="legend-value">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}
