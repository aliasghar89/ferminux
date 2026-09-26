// ---------------------------------------------------------------------------
// USD values: what each token is worth, and therefore what a pool holds.
//
// Three kinds of basis, and every figure on the page says which one it used:
//
//   official  FMX and WFMX at the official FMX price ($0.52, config.ts): the
//             price the pay-in sells FMX at, set by the operator.
//   peg       first-party stable tokens at their peg, exactly as the gateway's
//             market logic values them (agents/gateway/src/constants.ts
//             DEX_QUOTE_TOKENS): 1 USDF = 1 USD; 1 AZNT = 1 AZN, and the
//             Central Bank of Azerbaijan holds 1 USD = 1.70 AZN.
//   derived   any other token, through its deepest pool against a token that
//             already has a basis. Anyone can create a pool, so a derived
//             value is only ever as good as that one pool.
//
// Pure bigint arithmetic, 1e18 fixed-point; no network, no clock.
// ---------------------------------------------------------------------------

import { FMX_USD_E18 } from '../config.ts';
import { bySymbol } from '../../../../shared/tokens.ts';
import type { PairIndex, PairSnapshot } from './pairs.ts';

export const E18 = 10n ** 18n;

export type BasisKind = 'official' | 'peg' | 'derived';

export interface UsdBasis {
  /** USD per whole token, 1e18. */
  usdE18: bigint;
  kind: BasisKind;
  /** One line a person can check: where this number comes from. */
  basis: string;
}

/** Lowercased address → basis. */
export type PriceTable = Map<string, UsdBasis>;

/** The gateway's peg table for the first-party stable tokens (DEX_QUOTE_TOKENS). */
export const PEGS: ReadonlyArray<{ address: string; symbol: string; usdE18: bigint; basis: string }> = [
  { address: bySymbol('USDF')!.address, symbol: 'USDF', usdE18: E18, basis: '1 USDF = 1 USD' },
  { address: bySymbol('AZNT')!.address, symbol: 'AZNT', usdE18: (10n ** 20n) / 170n, basis: '1 AZNT = 1 AZN; 1 USD = 1.70 AZN' },
];

export function officialFmxBasis(fmxUsdE18: bigint = FMX_USD_E18): UsdBasis {
  return {
    usdE18: fmxUsdE18,
    kind: 'official',
    basis: `FMX at the official price, $${formatUsdPlain(fmxUsdE18, 4)}`,
  };
}

/**
 * The bases that do not depend on any pool: FMX/WFMX at the official price and
 * the pegged first-party tokens. `pegs` is overridable so a devnet (whose AZNT
 * lives at another address) can be valued the same way.
 */
export function baseTable(
  wfmx: string,
  options: { fmxUsdE18?: bigint; pegs?: ReadonlyArray<{ address: string; usdE18: bigint; basis: string }> } = {},
): PriceTable {
  const table: PriceTable = new Map();
  table.set(wfmx.toLowerCase(), officialFmxBasis(options.fmxUsdE18));
  for (const p of options.pegs ?? PEGS) {
    table.set(p.address.toLowerCase(), { usdE18: p.usdE18, kind: 'peg', basis: p.basis });
  }
  return table;
}

/** USD value of `amount` base units of a token worth `usdE18` per whole token. */
export function valueUsdE18(amount: bigint, decimals: number, usdE18: bigint): bigint {
  return (amount * usdE18) / 10n ** BigInt(decimals);
}

/**
 * Extend `base` with a derived value for every pool token that has none, taken
 * from its deepest pool (by the USD value of the priced side) against a token
 * that does. Two passes, so a token two pools away from a basis is reached.
 */
export function priceTable(index: PairIndex, base: PriceTable): PriceTable {
  const table: PriceTable = new Map(base);
  for (let pass = 0; pass < 2; pass++) {
    const best = new Map<string, { depth: bigint; basis: UsdBasis }>();
    for (const p of index.values()) {
      if (p.reserve0 <= 0n || p.reserve1 <= 0n) continue;
      for (const [known, unknown, rk, ru] of [
        [p.token0, p.token1, p.reserve0, p.reserve1],
        [p.token1, p.token0, p.reserve1, p.reserve0],
      ] as const) {
        const k = table.get(known.address.toLowerCase());
        if (!k || table.has(unknown.address.toLowerCase())) continue;
        const depth = valueUsdE18(rk, known.decimals, k.usdE18);
        // unknown per whole token = (rk / 10^dk) / (ru / 10^du) × usd(known)
        const usdE18 = (rk * 10n ** BigInt(unknown.decimals) * k.usdE18) / (ru * 10n ** BigInt(known.decimals));
        const prev = best.get(unknown.address.toLowerCase());
        if (!prev || depth > prev.depth) {
          best.set(unknown.address.toLowerCase(), {
            depth,
            basis: { usdE18, kind: 'derived', basis: `through the ${p.token0.symbol}/${p.token1.symbol} pool's price` },
          });
        }
      }
    }
    if (best.size === 0) break;
    for (const [addr, { basis }] of best) table.set(addr, basis);
  }
  return table;
}

export interface PoolValue {
  /** Both sides valued, summed; null when neither side has a basis. */
  tvlUsdE18: bigint | null;
  side0UsdE18: bigint | null;
  side1UsdE18: bigint | null;
  /** True when only one side had a basis and the other was taken as equal to it. */
  estimated: boolean;
}

/**
 * What a pool holds in USD. Each side is valued at its own basis and the two
 * are added, so a pool whose own price differs from the official FMX price
 * shows that honestly as a lopsided pair of sides rather than hiding it. When
 * only one side has a basis, the pool is taken to hold equal value on both
 * sides (true of an x·y=k pool at its own price) and the figure is marked.
 */
export function poolValue(p: PairSnapshot, prices: PriceTable): PoolValue {
  const b0 = prices.get(p.token0.address.toLowerCase());
  const b1 = prices.get(p.token1.address.toLowerCase());
  const s0 = b0 ? valueUsdE18(p.reserve0, p.token0.decimals, b0.usdE18) : null;
  const s1 = b1 ? valueUsdE18(p.reserve1, p.token1.decimals, b1.usdE18) : null;
  if (s0 !== null && s1 !== null) return { tvlUsdE18: s0 + s1, side0UsdE18: s0, side1UsdE18: s1, estimated: false };
  if (s0 !== null) return { tvlUsdE18: 2n * s0, side0UsdE18: s0, side1UsdE18: null, estimated: true };
  if (s1 !== null) return { tvlUsdE18: 2n * s1, side0UsdE18: null, side1UsdE18: s1, estimated: true };
  return { tvlUsdE18: null, side0UsdE18: null, side1UsdE18: null, estimated: false };
}

/**
 * The price of `token` implied by ONE pool, in the other token (1e18 per whole
 * token): reserveOther / reserveToken, decimals-adjusted.
 */
export function poolPriceE18(p: PairSnapshot, token: string): bigint | null {
  if (p.reserve0 <= 0n || p.reserve1 <= 0n) return null;
  const is0 = p.token0.address.toLowerCase() === token.toLowerCase();
  const [rt, ro, dt, dO] = is0
    ? [p.reserve0, p.reserve1, p.token0.decimals, p.token1.decimals]
    : [p.reserve1, p.reserve0, p.token1.decimals, p.token0.decimals];
  return (ro * 10n ** BigInt(dt) * E18) / (rt * 10n ** BigInt(dO));
}

/**
 * FMX's USD price as ONE pool sets it: its price in the paired token times
 * that token's peg. Only meaningful for a WFMX pool against a pegged token;
 * returns null otherwise. This is the "pool price" shown beside the official
 * $0.52, never a replacement for it.
 */
export function poolFmxUsdE18(p: PairSnapshot, wfmx: string, pegs: PriceTable): bigint | null {
  const w = wfmx.toLowerCase();
  const other = p.token0.address.toLowerCase() === w ? p.token1 : p.token1.address.toLowerCase() === w ? p.token0 : null;
  if (!other) return null;
  const peg = pegs.get(other.address.toLowerCase());
  if (!peg || peg.kind !== 'peg') return null;
  const inOther = poolPriceE18(p, w);
  return inOther === null ? null : (inOther * peg.usdE18) / E18;
}

/**
 * Fee APR, parts per million: the fees earned over `days`, annualised, as a
 * share of what the pool holds now. Simple (not compounded) — liquidity
 * providers' fees stay in the pool, they are not reinvested for them.
 */
export function feeAprPpm(feesUsdE18: bigint, tvlUsdE18: bigint | null, days: number): bigint | null {
  if (tvlUsdE18 === null || tvlUsdE18 <= 0n || days <= 0) return null;
  return (feesUsdE18 * 365n * 1_000_000n * 1000n) / (BigInt(Math.round(days * 1000)) * tvlUsdE18);
}

/** 1e18 fixed-point → JS number. For chart geometry only; never for display text. */
export function e18ToNumber(value: bigint): number {
  const whole = value / E18;
  const frac = value % E18;
  return Number(whole) + Number(frac) / 1e18;
}

/** "1234.5678" style, truncated (never rounded up) to `digits` decimals, no grouping. */
export function formatUsdPlain(e18: bigint, digits = 2): string {
  const negative = e18 < 0n;
  const abs = negative ? -e18 : e18;
  const whole = abs / E18;
  const frac = (abs % E18).toString().padStart(18, '0').slice(0, digits);
  const body = digits > 0 ? `${whole}.${frac}` : `${whole}`;
  return (negative ? '-' : '') + body;
}

/**
 * "$98,688.12". Truncated, never rounded up. `compact` gives "$98.7K" /
 * "$1.24M" for tight cells. Anything above zero but under a cent reads "<$0.01".
 */
export function formatUsd(e18: bigint | null | undefined, options: { compact?: boolean; digits?: number } = {}): string {
  if (e18 === null || e18 === undefined) return '—';
  if (e18 === 0n) return '$0';
  const negative = e18 < 0n;
  const abs = negative ? -e18 : e18;
  const sign = negative ? '-' : '';
  const digits = options.digits ?? 2;
  if (abs < 10n ** 16n) return `${sign}<$0.01`;
  if (options.compact && abs >= 1000n * E18) {
    const units: Array<[bigint, string]> = [
      [10n ** 9n * E18, 'B'],
      [10n ** 6n * E18, 'M'],
      [10n ** 3n * E18, 'K'],
    ];
    for (const [size, suffix] of units) {
      if (abs >= size) {
        const scaled = (abs * 100n) / size; // two decimals
        const whole = scaled / 100n;
        const frac = (scaled % 100n).toString().padStart(2, '0');
        const shown = whole >= 100n ? `${whole}` : whole >= 10n ? `${whole}.${frac[0]}` : `${whole}.${frac}`;
        return `${sign}$${shown}${suffix}`;
      }
    }
  }
  const [w, f] = formatUsdPlain(abs, digits).split('.');
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}${f ? `.${f}` : ''}`;
}

/** A unit price with enough significant digits to compare: "$0.5200", "$0.00001234". */
export function formatUsdPrice(e18: bigint | null | undefined): string {
  if (e18 === null || e18 === undefined) return '—';
  if (e18 <= 0n) return '$0';
  if (e18 >= E18) return formatUsd(e18, { digits: 4 });
  const text = formatUsdPlain(e18, 18);
  const [, frac] = text.split('.');
  const lead = frac.length - frac.replace(/^0+/, '').length;
  const keep = Math.max(4, lead + 4);
  return `$0.${frac.slice(0, keep)}`;
}
