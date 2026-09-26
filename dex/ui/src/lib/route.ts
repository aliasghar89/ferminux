// ---------------------------------------------------------------------------
// Route finding: which pools a swap should go through.
//
// Pure functions over a PairIndex (no network, no clock), so the choice a user
// sees can be reproduced exactly in a test.
//
// The search: every seeded pool is an edge between its two tokens. Every
// SIMPLE path (no token visited twice) from the token sold to the token bought,
// up to `maxHops` pools, is priced with the same integer math the router runs
// (lib/math.ts), and the one that pays out the most wins. Ties go to the
// shorter path, then to the lexically smaller path, so the answer is
// deterministic. Nothing is split across routes: one order, one path, which is
// what the router's `swapExact…` entry points execute.
//
// The number of simple paths grows fast on a dense graph, so enumeration stops
// at `maxPaths` candidates (shortest first, because the walk is breadth-first
// by length). On a network of tens of pools that limit is never reached.
// ---------------------------------------------------------------------------

import { MAX_HOPS } from '../config.ts';
import { getAmountsOut, midOutput, priceImpactPpm, type HopReserves } from './math.ts';
import { hopReserves, type PairIndex } from './pairs.ts';

export { MAX_HOPS };

/** Upper bound on candidate paths priced per quote. */
export const MAX_PATHS = 400;

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

export interface RouteOptions {
  /** Longest path considered, in pools (default MAX_HOPS). */
  maxHops?: number;
  /** Stop enumerating after this many candidate paths (default MAX_PATHS). */
  maxPaths?: number;
}

/** Token → every token it shares a SEEDED pool with. Keys and values are lowercase. */
export type TokenGraph = Map<string, Set<string>>;

export function buildGraph(index: PairIndex): TokenGraph {
  const graph: TokenGraph = new Map();
  const link = (a: string, b: string) => {
    let set = graph.get(a);
    if (!set) graph.set(a, (set = new Set()));
    set.add(b);
  };
  for (const p of index.values()) {
    if (p.reserve0 <= 0n || p.reserve1 <= 0n) continue;
    const a = p.token0.address.toLowerCase();
    const b = p.token1.address.toLowerCase();
    if (a === b) continue;
    link(a, b);
    link(b, a);
  }
  return graph;
}

/**
 * Every simple path from `tokenIn` to `tokenOut` over seeded pools, shortest
 * first. Paths are returned in the caller's address spelling for the ends and
 * in the index's checksummed spelling in between.
 */
export function enumeratePaths(
  index: PairIndex,
  tokenIn: string,
  tokenOut: string,
  options: RouteOptions = {},
): string[][] {
  const maxHops = Math.max(1, Math.min(options.maxHops ?? MAX_HOPS, 6));
  const maxPaths = Math.max(1, options.maxPaths ?? MAX_PATHS);
  const from = tokenIn.toLowerCase();
  const to = tokenOut.toLowerCase();
  if (from === to) return [];
  const graph = buildGraph(index);
  if (!graph.has(from) || !graph.has(to)) return [];

  // Checksummed spelling for every token the index knows.
  const spelled = new Map<string, string>();
  for (const p of index.values()) {
    spelled.set(p.token0.address.toLowerCase(), p.token0.address);
    spelled.set(p.token1.address.toLowerCase(), p.token1.address);
  }

  const found: string[][] = [];
  // Breadth-first by path length: every 1-hop path before any 2-hop path, so
  // the cap drops the longest (most expensive) candidates first.
  let frontier: string[][] = [[from]];
  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth++) {
    const next: string[][] = [];
    for (const path of frontier) {
      const last = path[path.length - 1];
      const neighbours = [...(graph.get(last) ?? [])].sort();
      for (const n of neighbours) {
        if (path.includes(n)) continue; // simple paths only: a cycle can only lose fees
        const extended = [...path, n];
        if (n === to) {
          found.push(extended);
          if (found.length >= maxPaths) return found.map((p) => respell(p, tokenIn, tokenOut, spelled));
        } else if (depth < maxHops) {
          next.push(extended);
        }
      }
    }
    frontier = next;
  }
  return found.map((p) => respell(p, tokenIn, tokenOut, spelled));
}

function respell(path: string[], tokenIn: string, tokenOut: string, spelled: Map<string, string>): string[] {
  return path.map((t, i) =>
    i === 0 ? tokenIn : i === path.length - 1 ? tokenOut : (spelled.get(t) ?? t),
  );
}

/** Price one path locally. Returns null when a hop has no liquidity. */
export function priceRoute(index: PairIndex, path: string[], amountIn: bigint): Route | null {
  if (path.length < 2) return null;
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

/** Better route first: more output, then fewer hops, then the lexically smaller path. */
export function compareRoutes(a: Route, b: Route): number {
  if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  const ka = a.path.join(',').toLowerCase();
  const kb = b.path.join(',').toLowerCase();
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Every priceable route for this size, best first. */
export function rankRoutes(
  index: PairIndex,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  options: RouteOptions = {},
): Route[] {
  const routes: Route[] = [];
  for (const path of enumeratePaths(index, tokenIn, tokenOut, options)) {
    const route = priceRoute(index, path, amountIn);
    if (route) routes.push(route);
  }
  return routes.sort(compareRoutes);
}

/**
 * The best route for this size: whichever candidate pays out the most.
 * Ties go to the shorter path (fewer pools to fail, less gas).
 */
export function bestRoute(
  index: PairIndex,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  options: RouteOptions = {},
): Route | null {
  return rankRoutes(index, tokenIn, tokenOut, amountIn, options)[0] ?? null;
}

/** Whether any route exists between two tokens at all (no amount needed). */
export function hasRoute(index: PairIndex, tokenIn: string, tokenOut: string, options: RouteOptions = {}): boolean {
  return enumeratePaths(index, tokenIn, tokenOut, { ...options, maxPaths: 1 }).length > 0;
}

/**
 * The zero-fee, zero-impact reference output for a route: the number the
 * displayed price impact is measured against.
 */
export function routeMidOutput(route: Route, amountIn: bigint): bigint {
  return midOutput(amountIn, route.hops);
}
