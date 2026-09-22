// ---------------------------------------------------------------------------
// Route finding: which pools a swap should go through.
//
// Pure functions over a PairIndex — no network, no clock — so the choice a
// user sees can be reproduced exactly in a test.
//
// Scope, stated plainly: the router considers the direct pool and every
// two-hop route through a configured base token (WFMX, AZNT, and anything the
// caller adds). It does NOT search three or more hops and it does NOT split an
// order across pools. A three-hop route costs ~0.90% in fees before impact, so
// on a network this size it is nearly always worse than the two-hop it would
// replace; when that stops being true, `MAX_HOPS` is the knob.
// ---------------------------------------------------------------------------

import { getAmountsOut, midOutput, priceImpactPpm, type HopReserves } from './math.ts';
import { hopReserves, type PairIndex } from './pairs.ts';

export const MAX_HOPS = 2;

export interface Route {
  /** Token addresses, `path[0]` sold, `path[path.length - 1]` bought. */
  path: string[];
  /** One entry per hop, oriented in the direction of the trade. */
  hops: HopReserves[];
  /** `amounts[i]` is what leaves hop i-1 and enters hop i. */
  amounts: bigint[];
  /** What the last pool pays out. */
  amountOut: bigint;
  /** Deviation from the current pool ratio, parts per million, fee included. */
  priceImpactPpm: bigint;
}

/**
 * Candidate paths from `tokenIn` to `tokenOut`: the direct pool first, then one
 * hop through each base token. Paths whose pools do not exist (or have never
 * been seeded) are dropped here, so every returned path is priceable.
 */
export function candidatePaths(
  index: PairIndex,
  tokenIn: string,
  tokenOut: string,
  bases: string[],
): string[][] {
  const from = tokenIn.toLowerCase();
  const to = tokenOut.toLowerCase();
  if (from === to) return [];

  const paths: string[][] = [];
  if (hopReserves(index, tokenIn, tokenOut)) paths.push([tokenIn, tokenOut]);

  const seen = new Set<string>();
  for (const base of bases) {
    const mid = base.toLowerCase();
    if (mid === from || mid === to || seen.has(mid)) continue;
    seen.add(mid);
    if (hopReserves(index, tokenIn, base) && hopReserves(index, base, tokenOut)) {
      paths.push([tokenIn, base, tokenOut]);
    }
  }
  return paths;
}

/** Price one path locally. Returns null when a hop has no liquidity. */
export function priceRoute(index: PairIndex, path: string[], amountIn: bigint): Route | null {
  if (path.length < 2 || path.length > MAX_HOPS + 1) return null;
  if (amountIn <= 0n) return null;
  const hops: HopReserves[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const hop = hopReserves(index, path[i], path[i + 1]);
    if (!hop) return null;
    hops.push(hop);
  }
  let amounts: bigint[];
  try {
    amounts = getAmountsOut(amountIn, hops);
  } catch {
    return null; // amountIn too small to move any output at this depth
  }
  const amountOut = amounts[amounts.length - 1];
  if (amountOut <= 0n) return null;
  return {
    path: [...path],
    hops,
    amounts,
    amountOut,
    priceImpactPpm: priceImpactPpm(amountIn, amountOut, hops),
  };
}

/**
 * The best route for this size: whichever candidate pays out the most.
 * Ties go to the shorter path (fewer approvals to grief, fewer pools to fail).
 */
export function bestRoute(
  index: PairIndex,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  bases: string[],
): Route | null {
  let best: Route | null = null;
  for (const path of candidatePaths(index, tokenIn, tokenOut, bases)) {
    const route = priceRoute(index, path, amountIn);
    if (!route) continue;
    if (
      !best ||
      route.amountOut > best.amountOut ||
      (route.amountOut === best.amountOut && route.path.length < best.path.length)
    ) {
      best = route;
    }
  }
  return best;
}

/**
 * The zero-fee, zero-impact reference output for a route — the number the
 * displayed price impact is measured against.
 */
export function routeMidOutput(route: Route, amountIn: bigint): bigint {
  return midOutput(amountIn, route.hops);
}
