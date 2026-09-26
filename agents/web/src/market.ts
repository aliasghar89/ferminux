// FMX's markets as numbers: what a buy of a given size gets from a constant-product pool, and how much of a
// pool's LP supply is locked. Pure functions (bigint in, plain numbers out), so test/market.test.mjs runs them
// under plain Node. /trade/ feeds them the reserves it reads live.

/** The Ferminux DEX on chain 3961 (dex/contracts, deployed 2026-08-20). The same addresses as agents/gateway/src/constants.ts. */
export const DEX = {
  url: "https://dex.ferminux.net",
  factory: "0x2034a8366fCdbfFCf4517D297f702aDDdba37040",
  router: "0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f",
  wfmx: "0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae",
  locker: "0xe588c594388B978E64B69E2Dd91CC7E302763951",
  /** the WFMX/AZNT pair: the pool FMX trades in today */
  pair: "0xbab12e7B817F0686e11949eC06697235DC146845",
  swapUrl: "https://dex.ferminux.net/?inputCurrency=0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178&outputCurrency=FMX",
} as const;

/** The first-party tokens an FMX pool is priced against, with the USD basis the gateway uses. */
export const DEX_QUOTES = [
  { symbol: "AZNT", address: "0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178", decimals: 6, usdPerUnit: 1 / 1.7, usdBasis: "1 AZNT = 1 AZN; 1 USD = 1.70 AZN" },
  { symbol: "USDF", address: "0xCd032A609e34121D1881E8DE7355b2c2c7092363", decimals: 6, usdPerUnit: 1, usdBasis: "1 USDF = 1 USD" },
] as const;

/** wFMX on BNB Chain: the bridge's FMX, traded in one PancakeSwap v2 pool. */
export const BSC_WFMX = {
  token: "0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0",
  pair: "0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0",
  pairUrl: "https://bscscan.com/address/0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0",
  chartUrl: "https://www.geckoterminal.com/bsc/pools/0x2bff929a81a73e9ff9fbe476975a36bff189f5e0",
} as const;

/** The pools charge 0.30% of the input on every swap (FerminuxPair: the k check is balance-adjusted by 3/1000). */
const FEE_NUM = 997n, FEE_DEN = 1000n;

/** Router getAmountOut: `amountIn` of the input reserve's token buys this much of the output token. */
export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * FEE_NUM;
  return (inWithFee * reserveOut) / (reserveIn * FEE_DEN + inWithFee);
}

const toUnits = (x: number, decimals: number): bigint => BigInt(Math.round(x * 10 ** Math.min(decimals, 6))) * 10n ** BigInt(Math.max(0, decimals - 6));
const fromUnits = (u: bigint, decimals: number): number => Number(u) / 10 ** decimals;

export interface BuyRow {
  usd: number;
  /** FMX the swap pays out */
  fmx: number;
  /** USD paid per FMX received, fee included */
  avgUsd: number;
  /** how far the average price sits above the pool's spot price, in percent */
  impactPct: number;
}

/**
 * A buy of `usd` worth of the quote token against a WFMX/quote pool. Reserves are raw token units;
 * `usdPerQuote` converts dollars to the quote token.
 */
export function buyFmx(usd: number, pool: { wfmxReserve: bigint; quoteReserve: bigint; quoteDecimals: number; usdPerQuote: number }): BuyRow | null {
  const { wfmxReserve, quoteReserve, quoteDecimals, usdPerQuote } = pool;
  if (!(usd > 0) || !(usdPerQuote > 0) || wfmxReserve <= 0n || quoteReserve <= 0n) return null;
  const quoteIn = toUnits(usd / usdPerQuote, quoteDecimals);
  const out = amountOut(quoteIn, quoteReserve, wfmxReserve);
  if (out <= 0n) return null;
  const fmx = fromUnits(out, 18);
  const spotUsd = spotUsdPerFmx(pool);
  const avgUsd = usd / fmx;
  return { usd, fmx, avgUsd, impactPct: (avgUsd / spotUsd - 1) * 100 };
}

/** USD per FMX at the pool's current ratio (no trade, no fee). */
export function spotUsdPerFmx(pool: { wfmxReserve: bigint; quoteReserve: bigint; quoteDecimals: number; usdPerQuote: number }): number {
  const q = fromUnits(pool.quoteReserve, pool.quoteDecimals);
  const f = fromUnits(pool.wfmxReserve, 18);
  return f > 0 ? (q / f) * pool.usdPerQuote : 0;
}

/** One LiquidityLocker lock, as `locksForToken` returns it. */
export interface LockRow { amount: bigint; unlockAt: bigint | number; withdrawn: boolean }

/**
 * The share of a pair's LP supply that sits in locks still in force at `nowS`, and the earliest unlock date among
 * them. The 1,000-unit minimum burned at the first mint counts in the supply and is never lockable, so a fully
 * locked pool reads a hair under 100%.
 */
export function lockedShare(locks: LockRow[], lpSupply: bigint, nowS: number): { pct: number; lockedUntil: number | null } {
  if (lpSupply <= 0n) return { pct: 0, lockedUntil: null };
  let locked = 0n; let until: number | null = null;
  for (const l of locks) {
    const at = Number(l.unlockAt);
    if (l.withdrawn || at <= nowS) continue;
    locked += l.amount;
    until = until == null ? at : Math.min(until, at);
  }
  // basis points first, so a share like 99.99999% floors to 99.99 instead of rounding up to a claim of 100
  const bps = Number((locked * 1_000_000n) / lpSupply) / 10_000;
  return { pct: Math.floor(bps * 100) / 100, lockedUntil: until };
}
