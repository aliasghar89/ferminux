// ---------------------------------------------------------------------------
// Quoting and executing a swap.
//
// Quoting is deliberately done twice:
//   1. locally, from the reserves already loaded, to CHOOSE the route; and
//   2. on chain, through `FerminuxRouter.getAmountsOut(amountIn, path)`, which
//      is the number actually displayed and the number the slippage bound is
//      derived from.
//
// If those two disagree the quote is flagged (`localMatchesChain: false`) —
// it means the reserves moved under us, and the UI says so rather than showing
// a stale price with a confident face.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

import { Contract, type ContractRunner, type ContractTransactionResponse } from 'ethers';
import { ROUTER_ABI, WFMX_ABI } from './abi.ts';
import { toChecksum } from './amounts.ts';
import { FEE_BPS, deadlineFromNow, minimumReceived, priceImpactPpm } from './math.ts';
import type { PairIndex } from './pairs.ts';
import { rankRoutes, type Route } from './route.ts';
import { fetchAllowance, isWrapPair, type TokenInfo } from './tokens.ts';
import { PRICE_IMPACT_CONFIRM_BPS, PRICE_IMPACT_WARN_BPS, type DexAddresses } from '../config.ts';

export function routerContract(addresses: DexAddresses, runner: ContractRunner): Contract {
  return new Contract(toChecksum(addresses.router), ROUTER_ABI as unknown as string[], runner);
}

export function wfmxContract(addresses: DexAddresses, runner: ContractRunner): Contract {
  return new Contract(toChecksum(addresses.wfmx), WFMX_ABI as unknown as string[], runner);
}

export interface SwapQuote {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  /** Authoritative output: straight from the router's own getAmountsOut. */
  amountOut: bigint;
  /** Every intermediate amount the router reported, one per path entry. */
  amounts: bigint[];
  route: Route;
  /**
   * The other routes that were checked against the router, best first, each
   * with the router's own output for this size. Empty for a single-path pair.
   */
  alternatives: Array<{ route: Route; amountOut: bigint }>;
  /** How many candidate paths the local search priced. */
  routesConsidered: number;
  /** False when the on-chain quote differs from the locally priced one. */
  localMatchesChain: boolean;
  priceImpactPpm: bigint;
  priceImpactBps: number;
  /** `amountOutMin` that will be sent to the router. */
  minimumReceived: bigint;
  slippageBps: number;
  /** 30 bps per hop: the pool fee, not a protocol fee. */
  totalFeeBps: number;
}

export type ImpactLevel = 'ok' | 'warn' | 'severe';

/** ok < 3% ≤ warn < 10% ≤ severe (thresholds live in config.ts). */
export function impactLevel(bps: number): ImpactLevel {
  if (bps >= PRICE_IMPACT_CONFIRM_BPS) return 'severe';
  if (bps >= PRICE_IMPACT_WARN_BPS) return 'warn';
  return 'ok';
}

export class NoRouteError extends Error {
  constructor(symbolIn: string, symbolOut: string) {
    super(`No pool route from ${symbolIn} to ${symbolOut}. Someone has to seed a pool that connects them first.`);
    this.name = 'NoRouteError';
  }
}

/** How many of the locally best routes are re-priced by the router per quote. */
export const ROUTER_CHECKED_ROUTES = 3;

/**
 * Price a swap.
 *
 * The local search (lib/route.ts) prices every path over every seeded pool and
 * ranks them. The best few are then priced again by the router itself
 * (`getAmountsOut`, one call each, in parallel) and the route the ROUTER says
 * pays the most is the one displayed and signed for. If reserves moved between
 * the pool read and the quote, the router's numbers win and the quote is
 * flagged so the UI can say so.
 */
export async function quoteSwap(
  runner: ContractRunner,
  addresses: DexAddresses,
  index: PairIndex,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: bigint,
  options: { slippageBps: number; maxHops?: number },
): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error('Enter an amount to swap.');
  const ranked = rankRoutes(index, tokenIn.address, tokenOut.address, amountIn, { maxHops: options.maxHops });
  if (ranked.length === 0) throw new NoRouteError(tokenIn.symbol, tokenOut.symbol);

  const router = routerContract(addresses, runner);
  const checked = ranked.slice(0, ROUTER_CHECKED_ROUTES);
  const results = await Promise.all(
    checked.map(async (route) => {
      try {
        const onChain = (await router.getAmountsOut(amountIn, route.path)) as bigint[];
        return { route, amounts: onChain.map((a) => BigInt(a)) };
      } catch {
        return null; // a pool drained since the index was read: skip that path
      }
    }),
  );
  const priced = results
    .filter((r): r is { route: Route; amounts: bigint[] } => r !== null)
    .map((r) => ({ ...r, amountOut: r.amounts[r.amounts.length - 1] }))
    .filter((r) => r.amountOut > 0n)
    .sort((a, b) =>
      a.amountOut !== b.amountOut ? (a.amountOut > b.amountOut ? -1 : 1) : a.route.path.length - b.route.path.length,
    );
  if (priced.length === 0) throw new Error('These pools are too shallow to fill that trade.');

  const best = priced[0];
  const localMatchesChain = best.amountOut === best.route.amountOut;
  // Impact is recomputed from the on-chain output so the percentage always
  // describes the number on the screen, not the one we guessed.
  const ppm = priceImpactPpm(amountIn, best.amountOut, best.route.hops);

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: best.amountOut,
    amounts: best.amounts,
    route: best.route,
    alternatives: priced.slice(1).map((p) => ({ route: p.route, amountOut: p.amountOut })),
    routesConsidered: ranked.length,
    localMatchesChain,
    priceImpactPpm: ppm,
    priceImpactBps: Number(ppm / 100n),
    minimumReceived: minimumReceived(best.amountOut, options.slippageBps),
    slippageBps: options.slippageBps,
    totalFeeBps: FEE_BPS * best.route.hops.length,
  };
}

/** Does the trader still need to approve the router for this input token? */
export async function allowanceShortfall(
  runner: ContractRunner,
  addresses: DexAddresses,
  tokenIn: TokenInfo,
  owner: string,
  amountIn: bigint,
): Promise<bigint> {
  const allowance = await fetchAllowance(runner, tokenIn, owner, addresses.router);
  return allowance >= amountIn ? 0n : amountIn - allowance;
}

export interface SwapExecution {
  amountOutMin: bigint;
  deadline: bigint;
  path: string[];
  method: 'swapExactFMXForTokens' | 'swapExactTokensForFMX' | 'swapExactTokensForTokens';
}

/** The exact call that will be signed — surfaced so the UI can show it. */
export function planSwap(quote: SwapQuote, deadlineMinutes: number, nowSec?: number): SwapExecution {
  const deadline = deadlineFromNow(deadlineMinutes, nowSec);
  const method: SwapExecution['method'] =
    quote.tokenIn.kind === 'native'
      ? 'swapExactFMXForTokens'
      : quote.tokenOut.kind === 'native'
        ? 'swapExactTokensForFMX'
        : 'swapExactTokensForTokens';
  return { amountOutMin: quote.minimumReceived, deadline, path: quote.route.path, method };
}

/**
 * Send the swap. `to` receives the output — normally the trader's own address.
 * The router enforces both bounds: it reverts rather than settle below
 * `amountOutMin` or after `deadline`.
 */
export async function executeSwap(
  signer: ContractRunner,
  addresses: DexAddresses,
  quote: SwapQuote,
  to: string,
  deadlineMinutes: number,
  nowSec?: number,
): Promise<ContractTransactionResponse> {
  const plan = planSwap(quote, deadlineMinutes, nowSec);
  const router = routerContract(addresses, signer);
  const recipient = toChecksum(to);

  switch (plan.method) {
    case 'swapExactFMXForTokens':
      return (await router.swapExactFMXForTokens(plan.amountOutMin, plan.path, recipient, plan.deadline, {
        value: quote.amountIn,
      })) as ContractTransactionResponse;
    case 'swapExactTokensForFMX':
      return (await router.swapExactTokensForFMX(
        quote.amountIn,
        plan.amountOutMin,
        plan.path,
        recipient,
        plan.deadline,
      )) as ContractTransactionResponse;
    default:
      return (await router.swapExactTokensForTokens(
        quote.amountIn,
        plan.amountOutMin,
        plan.path,
        recipient,
        plan.deadline,
      )) as ContractTransactionResponse;
  }
}

// ------------------------------------------------------------------ wrap ----

/**
 * FMX ⇄ WFMX is not a trade: it is the wrapper contract, 1:1, no fee, no
 * slippage and no pool involved. Treating it as a swap would send the user
 * looking for a pool that should never exist.
 */
export function wrapDirection(tokenIn: TokenInfo, tokenOut: TokenInfo): 'wrap' | 'unwrap' | null {
  return isWrapPair(tokenIn, tokenOut);
}

export async function wrapFmx(
  signer: ContractRunner,
  addresses: DexAddresses,
  amount: bigint,
): Promise<ContractTransactionResponse> {
  return (await wfmxContract(addresses, signer).deposit({ value: amount })) as ContractTransactionResponse;
}

export async function unwrapFmx(
  signer: ContractRunner,
  addresses: DexAddresses,
  amount: bigint,
): Promise<ContractTransactionResponse> {
  return (await wfmxContract(addresses, signer).withdraw(amount)) as ContractTransactionResponse;
}
