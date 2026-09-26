// Display helpers shared by the pages. Pure; no browser globals.

import type { PairSnapshot } from './pairs.ts';
import type { TokenInfo } from './tokens.ts';

/**
 * The symbol a pool is named by. A pool holds WFMX, the FRC-20 wrapper, but
 * everyone trades it as FMX (the router wraps and unwraps in the same
 * transaction), so pool names say FMX. Pool pages state what the contract
 * actually holds.
 */
export function poolSymbol(token: TokenInfo, wfmx: string): string {
  return token.address.toLowerCase() === wfmx.toLowerCase() ? 'FMX' : token.symbol;
}

/** "FMX / AZNT": WFMX first-named as FMX, and FMX always on the left. */
export function poolName(p: PairSnapshot, wfmx: string): string {
  const [a, b] = orderedTokens(p, wfmx);
  return `${poolSymbol(a, wfmx)} / ${poolSymbol(b, wfmx)}`;
}

/** The pool's two tokens with WFMX (if present) first. */
export function orderedTokens(p: PairSnapshot, wfmx: string): [TokenInfo, TokenInfo] {
  return p.token1.address.toLowerCase() === wfmx.toLowerCase() ? [p.token1, p.token0] : [p.token0, p.token1];
}

/** "3 min ago", "5 h ago", "2 d ago"; `now` in unix seconds. */
export function formatAgo(t: number | null, now: number): string {
  if (t === null) return '—';
  const d = Math.max(0, now - t);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86_400 * 60) return `${Math.floor(d / 86_400)} d ago`;
  return `${Math.floor(d / (86_400 * 30))} mo ago`;
}

/** "26 Sep 2026" (UTC). */
export function formatDay(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
}

/** A JS number for a chart axis or tooltip: "$0.5200", "$12.4K". */
export function formatUsdNumber(v: number, compact = false): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (compact && abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (compact && abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (compact && abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1000) return `${sign}$${Math.floor(abs).toLocaleString('en-US')}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `${sign}$${abs.toPrecision(4)}`;
}

/** A plain number for a chart axis: 0.3250, 1,234. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toLocaleString('en-US');
  if (abs >= 1) return v.toFixed(2);
  if (abs === 0) return '0';
  return v.toPrecision(4);
}
