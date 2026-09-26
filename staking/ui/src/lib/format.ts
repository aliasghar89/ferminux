// Display formatting — pure string work, unit-tested, no browser globals.

import { formatEther } from 'ethers';
import type { Countdown } from './math.ts';

/**
 * Format a wei amount as FMX: thousands-grouped integer part, fraction trimmed
 * to `maxFrac` places with trailing zeros dropped. Never rounds UP a reward.
 */
export function formatFMX(wei: bigint, maxFrac = 4): string {
  const raw = formatEther(wei);
  const neg = raw.startsWith('-');
  const [intPartRaw, fracRaw = ''] = (neg ? raw.slice(1) : raw).split('.');
  const intPart = intPartRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = fracRaw.slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + intPart + (frac ? `.${frac}` : '');
}

/** Basis points → "12.5%" (max 2 decimals, trailing zeros dropped). */
export function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const frac = bps % 100n;
  if (frac === 0n) return `${whole}%`;
  const fracStr = frac.toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}%`;
}

/** Weight in bps → "1.5×". */
export function formatWeight(weightBps: bigint): string {
  const whole = weightBps / 10_000n;
  const frac = (weightBps % 10_000n) / 1_000n;
  return frac === 0n ? `${whole}×` : `${whole}.${frac}×`;
}

/**
 * Compact duration: the two most significant units ("88d 4h", "4h 12m",
 * "12m 30s", "0s"). Used for countdowns and runway.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** Countdown → display string; "unlocked" once done. */
export function formatCountdown(c: Countdown): string {
  if (c.done) return 'unlocked';
  return formatDuration(c.totalSeconds);
}

/** Approximate months, one decimal — for pool-runway copy ("~14.8 months"). */
export function formatMonths(seconds: bigint): string {
  const months = Number(seconds) / 2_629_800; // average month
  if (!Number.isFinite(months)) return '—';
  if (months >= 120) return '10+ years';
  return `~${months.toFixed(1)} months`;
}

/** Unix seconds → local date-time, minute precision. */
export function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Unix seconds → local date only. */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "3m ago" style relative age; "never" for 0/absent timestamps. */
export function formatAgo(unixSeconds: number, nowSec: number): string {
  if (unixSeconds <= 0) return 'never';
  const delta = Math.max(0, Math.floor(nowSec - unixSeconds));
  if (delta < 45) return 'just now';
  return `${formatDuration(delta)} ago`;
}

/** 0x1234…abcd address shortening. */
export function shortAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
