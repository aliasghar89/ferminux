// ---------------------------------------------------------------------------
// The AMM math, in TypeScript, as pure bigint functions.
//
// Every function here is a line-by-line mirror of the Solidity in
// dex/contracts/src/libraries/FerminuxLibrary.sol — SAME operation order, SAME
// rounding direction. That matters: the UI must show the number the pool will
// actually pay, not a floating-point approximation of it. `tests/math.test.mjs`
// pins the published vectors and `scripts/e2e.mjs` re-checks 256 randomised
// cases against the deployed contract's own getAmountOut/getAmountIn/quote.
//
// Nothing in this file touches the network, the DOM, or floating point.
// ---------------------------------------------------------------------------

/** 0.30% swap fee, charged on the input: 997/1000 of it moves the curve. */
export const FEE_NUMERATOR = 997n;
export const FEE_DENOMINATOR = 1000n;
/** The same fee expressed in basis points, for display. */
export const FEE_BPS = 30;

export const BPS = 10_000n;
/** Price impact is carried at parts-per-million so 0.01% is representable. */
export const PPM = 1_000_000n;

/** Reserves of one hop, already oriented: `reserveIn` is the token being sold. */
export interface HopReserves {
  reserveIn: bigint;
  reserveOut: bigint;
}

/**
 * Equivalent amount of B for `amountA` at the current pool ratio.
 * No fee — this is the ADD-LIQUIDITY ratio, not a swap price.
 * Mirrors FerminuxLibrary.quote.
 */
export function quote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n) throw new Error('LIB: insufficient amount');
  if (reserveA <= 0n || reserveB <= 0n) throw new Error('LIB: insufficient liquidity');
  return (amountA * reserveB) / reserveA;
}

/**
 * Output of a swap of `amountIn`, after the 0.30% fee. Rounds DOWN, i.e. in
 * favour of the pool. Mirrors FerminuxLibrary.getAmountOut.
 */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) throw new Error('LIB: insufficient input amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('LIB: insufficient liquidity');
  const amountInWithFee = amountIn * FEE_NUMERATOR;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
  return numerator / denominator;
}

/**
 * Input required to receive exactly `amountOut`, including the fee. Rounds UP
 * (the +1), i.e. in favour of the pool. Mirrors FerminuxLibrary.getAmountIn.
 */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n) throw new Error('LIB: insufficient output amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('LIB: insufficient liquidity');
  if (amountOut >= reserveOut) throw new Error('LIB: insufficient liquidity');
  const numerator = reserveIn * amountOut * FEE_DENOMINATOR;
  const denominator = (reserveOut - amountOut) * FEE_NUMERATOR;
  return numerator / denominator + 1n;
}

/**
 * Chained `getAmountOut` along a route. `amounts[0]` is the input, the last
 * entry is what the last pool pays out. Mirrors FerminuxLibrary.getAmountsOut,
 * except the reserves are passed in rather than read from the chain — the
 * caller has already loaded them, and a pure function is testable.
 */
export function getAmountsOut(amountIn: bigint, hops: HopReserves[]): bigint[] {
  if (hops.length < 1) throw new Error('LIB: invalid path');
  const amounts: bigint[] = [amountIn];
  for (const hop of hops) {
    amounts.push(getAmountOut(amounts[amounts.length - 1], hop.reserveIn, hop.reserveOut));
  }
  return amounts;
}

/** Chained `getAmountIn`, walked backwards. Mirrors FerminuxLibrary.getAmountsIn. */
export function getAmountsIn(amountOut: bigint, hops: HopReserves[]): bigint[] {
  if (hops.length < 1) throw new Error('LIB: invalid path');
  const amounts: bigint[] = new Array(hops.length + 1).fill(0n);
  amounts[amounts.length - 1] = amountOut;
  for (let i = hops.length - 1; i >= 0; i--) {
    amounts[i] = getAmountIn(amounts[i + 1], hops[i].reserveIn, hops[i].reserveOut);
  }
  return amounts;
}

/**
 * What the route would pay at the *current* ratio if the trade were
 * infinitesimally small and free: amountIn × Π(reserveOut / reserveIn).
 *
 * The whole product is accumulated before the single division, so a two-hop
 * reference does not lose a wei to intermediate truncation. This is the
 * yardstick price impact is measured against.
 */
export function midOutput(amountIn: bigint, hops: HopReserves[]): bigint {
  if (hops.length < 1) throw new Error('LIB: invalid path');
  let numerator = amountIn;
  let denominator = 1n;
  for (const hop of hops) {
    if (hop.reserveIn <= 0n || hop.reserveOut <= 0n) throw new Error('LIB: insufficient liquidity');
    numerator *= hop.reserveOut;
    denominator *= hop.reserveIn;
  }
  return numerator / denominator;
}

/**
 * How far this trade moves the price away from the pool's current ratio,
 * in parts per million of the mid-price output.
 *
 *     impact = (midOutput - amountOut) / midOutput
 *
 * It INCLUDES the 0.30%-per-hop fee, because that is what the trader actually
 * gives up versus the price on the screen — the same "total cost vs mid"
 * column the contracts README tabulates. A tiny trade through one pool
 * therefore floors at ~30 bps, not at 0.
 */
export function priceImpactPpm(amountIn: bigint, amountOut: bigint, hops: HopReserves[]): bigint {
  const mid = midOutput(amountIn, hops);
  if (mid <= 0n) return 0n;
  const lost = mid - amountOut;
  if (lost <= 0n) return 0n; // rounding can make a dust trade look free
  return (lost * PPM) / mid;
}

/** Price impact in basis points (integer, floored) — for threshold checks. */
export function priceImpactBps(amountIn: bigint, amountOut: bigint, hops: HopReserves[]): number {
  return Number(priceImpactPpm(amountIn, amountOut, hops) / 100n);
}

/**
 * The `amountOutMin` handed to the router: the worst fill the trader accepts.
 * Rounds DOWN — a minimum that rounded up could reject an honest fill.
 */
export function minimumReceived(amountOut: bigint, slippageBps: number): bigint {
  assertSlippage(slippageBps);
  return (amountOut * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * The `amountInMax` / `amountAMin`-style upper bound for exact-output and
 * add-liquidity paths. Rounds UP so the bound is never accidentally tighter
 * than the tolerance the user asked for.
 */
export function maximumSold(amountIn: bigint, slippageBps: number): bigint {
  assertSlippage(slippageBps);
  const numerator = amountIn * (BPS + BigInt(slippageBps));
  return numerator % BPS === 0n ? numerator / BPS : numerator / BPS + 1n;
}

/** The floor under an add-liquidity leg: amount × (1 − slippage), rounded down. */
export function minimumDeposited(amount: bigint, slippageBps: number): bigint {
  return minimumReceived(amount, slippageBps);
}

function assertSlippage(slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= Number(BPS)) {
    throw new Error(`slippage must be an integer in [0, 10000) basis points, got ${slippageBps}`);
  }
}

/** Unix-seconds deadline `minutes` from `nowSec`. */
export function deadlineFromNow(minutes: number, nowSec: number = Math.floor(Date.now() / 1000)): bigint {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('deadline must be a positive number of minutes');
  return BigInt(Math.floor(nowSec) + Math.round(minutes * 60));
}

/** An LP holder's share of a pool, in parts per million. */
export function shareOfPoolPpm(balance: bigint, totalSupply: bigint): bigint {
  if (totalSupply <= 0n) return 0n;
  return (balance * PPM) / totalSupply;
}

/**
 * What `balance` LP tokens are redeemable for right now.
 * Mirrors FerminuxPair.burn: amount = liquidity × reserve / totalSupply.
 */
export function pooledAmounts(
  balance: bigint,
  totalSupply: bigint,
  reserve0: bigint,
  reserve1: bigint,
): [bigint, bigint] {
  if (totalSupply <= 0n) return [0n, 0n];
  return [(balance * reserve0) / totalSupply, (balance * reserve1) / totalSupply];
}

/**
 * LP tokens minted for a deposit into a pool that already has liquidity.
 * Mirrors FerminuxPair.mint's `min(...)` branch.
 */
export function liquidityMinted(
  amount0: bigint,
  amount1: bigint,
  reserve0: bigint,
  reserve1: bigint,
  totalSupply: bigint,
): bigint {
  if (totalSupply <= 0n || reserve0 <= 0n || reserve1 <= 0n) {
    throw new Error('liquidityMinted: pool is empty — the first deposit sets the price');
  }
  const from0 = (amount0 * totalSupply) / reserve0;
  const from1 = (amount1 * totalSupply) / reserve1;
  return from0 < from1 ? from0 : from1;
}
