/* Decoded ABI values → markup (event args, contract reads). Addresses become chips, wei-named integers add
   "= X FMX", basis points add a percent, unix times add the UTC date. Every hint is computed from the value
   itself; the raw value stays visible. */
import { html, type Html } from "../../ui/html";
import { addrChip } from "../../ui/hash";
import { units, utc, int } from "../../format";
import type { AbiParam } from "./abi";

const WEI = /(amount|price|bond|fee|value|balance|deposit|payout|wad|paid|cost|stake|reward|minbond|rate|fmx|credit|refund|escrow|budget|cap|supply)/i;
const NOT_WEI = /(bps|count|id$|ids$|index|time|at$|period|nonce|decimals|block|number|num|seconds|duration|window|delay|rating|score|status|version|len|length|max_id|kind|type)/i;
const TIME = /(at$|time|deadline|start|stop|expiry|expires|until|since|timestamp)/i;
/** On a token contract these are in the token's own units, not FMX. */
const TOKEN_UNITS = /^(totalsupply|balanceof|allowance|supply|cap|maxsupply|balance)$/i;
export interface Unit { symbol: string; decimals: number }

const isAddr = (s: unknown) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isArrayType = (t: string) => /\[\d*\]$/.test(t);

/** One decoded value of ABI type `p`. */
export function valueHtml(v: unknown, p: AbiParam | { name?: string; type: string; components?: AbiParam[] }, token?: Unit): Html {
  const t = p.type;
  const name = p.name ?? "";
  if (v === null || v === undefined) return html`<span class="faint">null</span>`;
  if (isArrayType(t)) {
    const inner = { ...p, type: t.replace(/\[\d*\]$/, "") };
    const arr = Array.from(v as ArrayLike<unknown>);
    if (!arr.length) return html`<span class="faint">[] (empty)</span>`;
    return html`<ol class="ad-av">${arr.map((x) => html`<li>${valueHtml(x, inner, token)}</li>`)}</ol>`;
  }
  if (t === "tuple" || t.startsWith("tuple")) {
    const comps = p.components ?? [];
    const arr = v as ArrayLike<unknown>;
    return html`<dl class="ad-tv">${comps.map((c, i) => html`<div><dt>${c.name || `#${i}`}</dt><dd>${valueHtml(arr[i], c)}</dd></div>`)}</dl>`;
  }
  if (t === "address") return isAddr(v) ? addrChip(String(v)) : html`<span class="mono">${String(v)}</span>`;
  if (t === "bool") return html`<span class="mono">${v ? "true" : "false"}</span>`;
  if (t === "string") return String(v) === "" ? html`<span class="faint">"" (empty)</span>` : html`<span class="ad-sv">${String(v)}</span>`;
  if (t.startsWith("bytes")) return html`<span class="mono ad-hexv">${String(v)}</span>`;
  if (/^u?int\d*$/.test(t)) {
    let b: bigint;
    try { b = BigInt(v as bigint | string | number); } catch { return html`<span class="mono">${String(v)}</span>`; }
    const n = html`<span class="num-mono">${int(b)}</span>`;
    if (/bps$/i.test(name) && b <= 10000n) return html`${n} <span class="faint">(${(Number(b) / 100).toString()}%)</span>`;
    if (TIME.test(name) && !/bps|count/i.test(name) && b >= 1_000_000_000n && b < 4_000_000_000n) return html`${n} <span class="faint">(${utc(Number(b))})</span>`;
    if (token && TOKEN_UNITS.test(name)) return b >= 1000n ? html`${n} <span class="faint">= ${units(b, token.decimals, token.decimals)} ${token.symbol}</span>` : n;
    if (WEI.test(name) && !NOT_WEI.test(name) && t === "uint256" && b >= 1000n) return html`${n} <span class="faint">= ${units(b, 18, 18)} FMX</span>`;
    return n;
  }
  return html`<span class="mono">${String(v)}</span>`;
}

/** Plain text of a value (titles, copy). */
export function valueText(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v) || (v && typeof v === "object" && "length" in (v as object))) return JSON.stringify(Array.from(v as ArrayLike<unknown>), (_, x) => (typeof x === "bigint" ? x.toString() : x));
  return String(v);
}
