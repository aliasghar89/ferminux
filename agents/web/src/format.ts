import { parseEther } from "ethers";

/**
 * Wei (string|bigint|number) → "1,234.5678" rounded (half-up) to at most `max` decimals, trailing
 * zeros trimmed. Rounds rather than truncates: a 0.5 FMX/day stream is stored as
 * floor(0.5e18/86400) wei/s and used to display as "0.499 FMX". Tiny non-zero amounts that would
 * round to 0 show as "<0.0001"-style so a dust balance is never printed as 0.
 */
export function fmx(wei: string | bigint | number | null | undefined, max = 4): string {
  if (wei === null || wei === undefined || wei === "") return "—";
  let v: bigint;
  try { v = BigInt(typeof wei === "number" ? Math.round(wei) : wei); } catch { return "—"; }
  const neg = v < 0n; if (neg) v = -v;
  const unit = 10n ** BigInt(18 - max);
  let r = unit > 1n ? (v + unit / 2n) / unit : v; // rounded, in units of 10^-max FMX
  if (r === 0n && v > 0n) return (neg ? "-" : "") + "<" + (max ? "0." + "0".repeat(max - 1) + "1" : "1");
  const scale = 10n ** BigInt(max);
  let int = (r / scale).toString(); let frac = max ? (r % scale).toString().padStart(max, "0").replace(/0+$/, "") : "";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}
export const fmxUnit = (wei: string | bigint | number | null | undefined, max = 4) => `${fmx(wei, max)} FMX`;

export function toWei(fmxAmount: string): bigint {
  return parseEther(fmxAmount.trim());
}

export const short = (addr: string | null | undefined, n = 4) =>
  !addr ? "—" : addr.length > 2 * n + 2 ? `${addr.slice(0, 2 + n)}…${addr.slice(-n)}` : addr;

export const int = (n: number | string | null | undefined) =>
  n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("en-US");

/** Accepts unix seconds, unix ms, numeric strings or ISO strings. Returns seconds or null. */
export function toSec(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === 0 || v === "0") return null;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return toSec(Number(v));
    const t = Date.parse(v); return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}
export function relTime(v: unknown, now = Date.now() / 1000): string {
  const s = toSec(v); if (s === null) return "—";
  const diff = now - s; const future = diff < 0; const d = Math.abs(diff);
  let out: string;
  if (d < 60) out = `${Math.floor(d)} s`;
  else if (d < 3600) out = `${Math.floor(d / 60)} min`;
  else if (d < 86400) out = `${Math.floor(d / 3600)} h`;
  else if (d < 7 * 86400) out = `${Math.floor(d / 86400)} d`;
  else if (d < 30 * 86400) out = `${Math.floor(d / (7 * 86400))} wk`;
  else if (d < 365 * 86400) out = `${Math.floor(d / (30 * 86400))} mo`;
  else out = `${Math.floor(d / (365 * 86400))} yr`;
  return future ? `in ${out}` : `${out} ago`;
}
export function absTime(v: unknown): string {
  const s = toSec(v); if (s === null) return "";
  return new Date(s * 1000).toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
export function timeHtml(v: unknown): string {
  const s = toSec(v); if (s === null) return `<span class="faint">—</span>`;
  return `<time datetime="${new Date(s * 1000).toISOString()}" title="${absTime(v)}">${relTime(v)}</time>`;
}
/** Duration in seconds → "23 h 12 min" */
export function dur(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (sec >= 2 * 86400) return h ? `${d} d ${h} h` : `${d} d`;
  if (sec >= 3600) return m && sec < 86400 ? `${Math.floor(sec / 3600)} h ${m} min` : `${Math.floor(sec / 3600)} h`;
  if (m > 0) return `${m} min`;
  return `${sec} s`;
}
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
/** An href for a URL that came from the chain or the gateway (agent endpoints, images): only http(s) or a root-relative path; anything else (javascript:, data:) becomes "#". Already attribute-escaped. */
export function safeHref(u: unknown): string {
  const s = String(u ?? "").trim();
  return /^(https?:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]*)$/i.test(s) ? esc(s) : "#";
}
export function starsHtml(avg: number | null | undefined, count?: number): string {
  if (avg === null || avg === undefined || !count) return `<span class="faint small">no ratings yet</span>`;
  const full = Math.round(avg);
  let s = `<span class="stars" aria-hidden="true">`;
  for (let i = 1; i <= 5; i++) s += `<span${i <= full ? "" : ' class="e"'}>★</span>`;
  s += `</span> <span class="num">${avg.toFixed(1)}</span> <span class="faint small num">(${int(count)})</span>`;
  return `<span class="vh">Rating ${avg.toFixed(1)} of 5 from ${count} ratings</span>` + s;
}
export function pretty(v: unknown): string {
  if (typeof v === "string") { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
