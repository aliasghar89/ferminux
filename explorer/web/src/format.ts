/* Formatting (surfaces/explorer.md §4.5, §4.6). Copied from agents/web/src/format.ts on 2026-09-24 and
   extended. One change to the copied part: `toWei` (and its ethers import) is dropped, because ethers must
   never load on the home page (≤ 45 KB gz). Every function returns a plain string; "—" means "not read". */

/**
 * Wei (string|bigint|number) → "1,234.5678" rounded (half-up) to at most `max` decimals, trailing
 * zeros trimmed. Tiny non-zero amounts that would round to 0 show as "<0.0001"-style so a dust
 * balance is never printed as 0.
 */
export function fmx(wei: string | bigint | number | null | undefined, max = 4): string {
  if (wei === null || wei === undefined || wei === "") return "—";
  let v: bigint;
  try { v = BigInt(typeof wei === "number" ? Math.round(wei) : wei); } catch { return "—"; }
  const neg = v < 0n; if (neg) v = -v;
  const unit = 10n ** BigInt(18 - max);
  const r = unit > 1n ? (v + unit / 2n) / unit : v; // rounded, in units of 10^-max FMX
  if (r === 0n && v > 0n) return (neg ? "-" : "") + "<" + (max ? "0." + "0".repeat(max - 1) + "1" : "1");
  const scale = 10n ** BigInt(max);
  const int = (r / scale).toString(); const frac = max ? (r % scale).toString().padStart(max, "0").replace(/0+$/, "") : "";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}
export const fmxUnit = (wei: string | bigint | number | null | undefined, max = 4) => `${fmx(wei, max)} FMX`;

export const short = (addr: string | null | undefined, n = 4) =>
  !addr ? "—" : addr.length > 2 * n + 2 ? `${addr.slice(0, 2 + n)}…${addr.slice(-n)}` : addr;

export const int = (n: number | string | bigint | null | undefined) =>
  n === null || n === undefined || n === "" ? "—" : typeof n === "bigint" ? group(n.toString()) : Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "—";

/** Accepts unix seconds, unix ms, numeric strings or ISO strings. Returns seconds or null. */
export function toSec(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === 0 || v === "0") return null;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return toSec(Number(v));
    if (/^0x[0-9a-f]+$/i.test(v)) return toSec(Number(BigInt(v)));
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
export function pretty(v: unknown): string {
  if (typeof v === "string") { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/* ======================= explorer additions (§4.5, §4.6) ======================= */

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Parse a wei / integer value that may be a decimal string, a 0x quantity, a number or a bigint. */
export function big(v: unknown): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.round(v)) : null;
    const s = String(v).trim();
    if (/^-?\d+$/.test(s) || /^0x[0-9a-f]+$/i.test(s)) return BigInt(s);
    if (/^-?\d+(\.\d+)?e\+?\d+$/i.test(s)) return BigInt(Number(s).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 0 })); // "5.0005e+21" from the gateway
  } catch { /* fall through */ }
  return null;
}

/** Fixed-point `v / 10^decimals` with at most `dp` decimals, half-up, trailing zeros trimmed, grouped. */
export function units(v: unknown, decimals = 18, dp = 18): string {
  let x = big(v); if (x === null) return "—";
  const neg = x < 0n; if (neg) x = -x;
  dp = Math.min(dp, decimals);
  const drop = BigInt(decimals - dp);
  const r = drop > 0n ? (x + 10n ** drop / 2n) / 10n ** drop : x;
  if (r === 0n && x > 0n) return (neg ? "-" : "") + "<" + (dp ? "0." + "0".repeat(dp - 1) + "1" : "1");
  const s = 10n ** BigInt(dp);
  const i = group((r / s).toString());
  const f = dp ? (r % s).toString().padStart(dp, "0").replace(/0+$/, "") : "";
  return (neg ? "-" : "") + i + (f ? "." + f : "");
}

/** Table rule for FMX and token amounts: ≥ 1,000 → 2 dp · ≥ 1 → 4 dp · < 1 → 6 dp; dust "<0.000001". */
export function amountCell(v: unknown, decimals = 18): string {
  const x = big(v); if (x === null) return "—";
  if (x === 0n) return "0";
  const a = x < 0n ? -x : x;
  const one = 10n ** BigInt(decimals);
  const dp = a >= 1000n * one ? 2 : a >= one ? 4 : 6;
  return units(x, decimals, dp);
}
/** Detail rule: exact, up to the token's decimals, trailing zeros trimmed ("0.000174382001220674"). */
export const amountExact = (v: unknown, decimals = 18) => units(v, decimals, decimals);
export const fmxCell = (wei: unknown) => amountCell(wei, 18);
export const fmxExact = (wei: unknown) => amountExact(wei, 18);
/** Fee column: FMX to 6 dp. */
export const fmxFee = (wei: unknown) => { const x = big(wei); return x === null ? "—" : x === 0n ? "0" : units(x, 18, 6); };

/** Gas price, base fee, tip (tables): < 1,000,000 wei → "7 wei"; otherwise gwei to 2 dp ("1 gwei"). */
export function gasPrice(wei: unknown): string {
  const x = big(wei); if (x === null) return "—";
  if (x < 1_000_000n) return `${group(x.toString())} wei`;
  return `${units(x, 9, 2)} gwei`;
}
/** Gas price, exact (details): "1.000000007 gwei" (or "7 wei" below 1,000,000 wei). */
export function gasPriceExact(wei: unknown): string {
  const x = big(wei); if (x === null) return "—";
  if (x < 1_000_000n) return `${group(x.toString())} wei`;
  return `${units(x, 9, 9)} gwei`;
}
export const weiInt = (wei: unknown) => { const x = big(wei); return x === null ? "—" : `${group(x.toString())} wei`; };

/** Percent: 1 dp in tables, 2 dp for holder shares. */
export function pct(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x.toFixed(dp).replace(/\.0+$/, "")}%`;
}
/** A share of two bigints in percent (holders: balance / supply). */
export function share(part: unknown, whole: unknown, dp = 2): string {
  const a = big(part), b = big(whole);
  if (a === null || b === null || b === 0n) return "—";
  return pct(Number((a * 10n ** 8n) / b) / 1e6, dp);
}
/** A capped index counter (tabs-counters 51 → "50+"). */
export const count = (c: { n: number; capped: boolean } | number | string | null | undefined) =>
  c === null || c === undefined ? "—" : typeof c === "object" ? int(c.n) + (c.capped ? "+" : "") : int(c);

/** Block number in text: "396,650" (URLs never carry commas). */
export const blockNum = (n: number | string | null | undefined) => int(n);

/** "2026-09-24 04:14:38 UTC" */
export function utc(v: unknown): string {
  const s = toSec(v); if (s === null) return "—";
  return new Date(s * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
/** "08:14:38 your time" */
export function localClock(v: unknown): string {
  const s = toSec(v); if (s === null) return "";
  return new Date(s * 1000).toLocaleTimeString("en-GB", { hour12: false }) + " your time";
}
/** The `title` of every <time>: "2026-09-24 04:14:38 UTC · 08:14:38 your time". */
export const timeTitle = (v: unknown) => { const u = utc(v); return u === "—" ? "" : `${u} · ${localClock(v)}`; };
/** Detail rows: "2026-09-24 04:14:38 UTC (12 h ago)". */
export const utcRel = (v: unknown) => { const u = utc(v); return u === "—" ? u : `${u} (${relTime(v)})`; };
/** ISO string for <time datetime>. */
export const iso = (v: unknown) => { const s = toSec(v); return s === null ? "" : new Date(s * 1000).toISOString(); };

/** Hex quantity → number ("0x60dfc" → 396796). */
export const hexNum = (h: string | null | undefined) => (h ? Number(BigInt(h)) : NaN);
export const toHex = (n: number | bigint) => "0x" + n.toString(16);

/** Bytes of a 0x hex string. */
export const byteLen = (hex: string | null | undefined) => (hex && hex.length > 2 ? (hex.length - 2) / 2 : 0);

/** ASCII from hex with NULs trimmed ("fmx-signer5"); null when not printable. */
export function asciiOf(hex: string): string | null {
  const h = hex.replace(/^0x/, "");
  let s = "";
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    if (c === 0) continue;
    if (c < 32 || c > 126) return null;
    s += String.fromCharCode(c);
  }
  return s;
}
