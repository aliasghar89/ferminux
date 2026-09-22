// ---------------------------------------------------------------------------
// Number in, number out: parsing user input into base units and formatting
// base units back into something a human can read.
//
// Rules of the house:
//   - amounts are bigint base units everywhere, never JS numbers;
//   - formatting NEVER rounds a value up (a balance that reads higher than it
//     is has caused more support tickets than any other UI bug);
//   - the full-precision value is always available for the "Max" button and
//     for tooltips.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

import { formatUnits, getAddress, parseUnits } from 'ethers';

export type ParseResult = { ok: true; wei: bigint } | { ok: false; error: string };

/** Parse a decimal string typed by a user into base units. */
export function parseAmount(input: string, decimals: number): ParseResult {
  const raw = input.trim();
  if (raw === '') return { ok: false, error: 'Enter an amount.' };
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { ok: false, error: 'Numbers only (use . for decimals).' };
  const [, fraction = ''] = raw.split('.');
  if (fraction.length > decimals) {
    return { ok: false, error: `This token has ${decimals} decimals — that is more precision than it can hold.` };
  }
  let wei: bigint;
  try {
    wei = parseUnits(raw, decimals);
  } catch {
    return { ok: false, error: 'Not a valid amount.' };
  }
  if (wei <= 0n) return { ok: false, error: 'Amount must be greater than zero.' };
  return { ok: true, wei };
}

/** True when the string is a syntactically valid, checksummable address. */
export function isAddress(value: string): boolean {
  try {
    getAddress(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** Checksummed address, or throws. */
export function toChecksum(value: string): string {
  return getAddress(value.trim());
}

/** 0x1234…cdef */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Base units → display string, truncated (never rounded up) to
 * `maxFractionDigits`, with thousands separators on the integer part.
 * A non-zero value that would truncate to all zeros renders as "<0.0001"
 * rather than "0", so dust is never displayed as nothing.
 */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 6): string {
  if (value === 0n) return '0';
  const negative = value < 0n;
  const text = formatUnits(negative ? -value : value, decimals);
  const [whole, fraction = ''] = text.split('.');
  const kept = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole === '0' && kept === '') {
    const smallest = maxFractionDigits > 0 ? `0.${'0'.repeat(maxFractionDigits - 1)}1` : '1';
    return `${negative ? '-' : ''}<${smallest}`;
  }
  return `${negative ? '-' : ''}${grouped}${kept ? `.${kept}` : ''}`;
}

/** Every digit the token can express — for tooltips and the Max button. */
export function formatFull(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

/**
 * Price of one `in` token expressed in `out` tokens, from the raw reserves.
 * Returns a plain decimal string (no grouping) so it can be pasted into a
 * calculator, or null when the pool is empty.
 */
export function priceFromReserves(
  reserveIn: bigint,
  decimalsIn: number,
  reserveOut: bigint,
  decimalsOut: number,
  significantDigits = 8,
): string | null {
  if (reserveIn <= 0n || reserveOut <= 0n) return null;
  const PRECISION = 18;
  const scaled =
    (reserveOut * 10n ** BigInt(decimalsIn) * 10n ** BigInt(PRECISION)) / (reserveIn * 10n ** BigInt(decimalsOut));
  if (scaled === 0n) return '<0.000000000000000001';
  return trimSignificant(formatUnits(scaled, PRECISION), significantDigits);
}

/**
 * Keep `digits` significant figures of a decimal string, truncating (never
 * rounding up) and dropping trailing zeros. 1234.5678 → 1234.5678 at 8,
 * 0.000123456789 → 0.00012345 at 5.
 */
export function trimSignificant(text: string, digits: number): string {
  const [whole, fraction = ''] = text.split('.');
  if (whole !== '0') {
    const room = Math.max(0, digits - whole.replace('-', '').length);
    const kept = fraction.slice(0, room).replace(/0+$/, '');
    return kept ? `${whole}.${kept}` : whole;
  }
  const leadingZeros = fraction.length - fraction.replace(/^0+/, '').length;
  const kept = fraction.slice(0, leadingZeros + digits).replace(/0+$/, '');
  return kept ? `0.${kept}` : '0';
}

/** Parts-per-million → percentage string, e.g. 1234n → "0.12%". */
export function formatPpmPercent(ppm: bigint, fractionDigits = 2): string {
  const negative = ppm < 0n;
  const abs = negative ? -ppm : ppm;
  const scale = 10n ** BigInt(fractionDigits);
  // ppm / 10_000 = percent; carry `fractionDigits` extra digits before dividing.
  const scaledPercent = (abs * scale) / 10_000n;
  const whole = scaledPercent / scale;
  const frac = (scaledPercent % scale).toString().padStart(fractionDigits, '0');
  const body = fractionDigits > 0 ? `${whole}.${frac}` : `${whole}`;
  return `${negative ? '-' : ''}${body}%`;
}

/** Basis points → percentage string, e.g. 50 → "0.5%". */
export function formatBpsPercent(bps: number): string {
  const text = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${text === '' ? '0' : text}%`;
}

/** Percentage string → basis points, or null when unparseable. */
export function percentToBps(input: string): number | null {
  const raw = input.trim();
  if (raw === '' || !/^\d*\.?\d*$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const bps = Math.round(value * 100);
  return Number.isInteger(bps) ? bps : null;
}

const UTC_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Unix seconds → "12 Mar 2027, 14:05 UTC". */
export function formatTimestamp(unixSeconds: number | bigint): string {
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms)) return '—';
  return `${UTC_FORMAT.format(new Date(ms)).replace(/,/, '')} UTC`;
}

/**
 * Rough distance to a future timestamp, e.g. "in 3 months", "in 12 days",
 * "in 4 hours". Past timestamps come back as "matured".
 */
export function formatRelativeFuture(unixSeconds: number | bigint, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const delta = Number(unixSeconds) - nowSeconds;
  if (!Number.isFinite(delta)) return '—';
  if (delta <= 0) return 'matured';
  const units: Array<[number, string]> = [
    [365 * 24 * 3600, 'year'],
    [30 * 24 * 3600, 'month'],
    [24 * 3600, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [seconds, label] of units) {
    if (delta >= seconds) {
      const n = Math.floor(delta / seconds);
      return `in ${n} ${label}${n === 1 ? '' : 's'}`;
    }
  }
  return 'in under a minute';
}
