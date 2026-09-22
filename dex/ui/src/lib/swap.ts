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
import { bestRoute, type Route } from './route.ts';
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
  /** Authoritative output — straight from the router's own getAmountsOut. */
  amountOut: bigint;
  /** Every intermediate amount the router reported, one per path entry. */
  amounts: bigint[];
  route: Route;
  /** False when the on-chain quote differs from the locally priced one. */
  localMatchesChain: boolean;
  priceImpactPpm: bigint;
  priceImpactBps: number;
  /** `amountOutMin` that will be sent to the router. */
  minimumReceived: bigint;
  slippageBps: number;
  /** 30 bps per hop — the pool fee, not a protocol fee. */
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
    super(`No pool route from ${symbolIn} to ${symbolOut}. Someone has to seed that pool first.`);
    this.name = 'NoRouteError';
  }
}

/**
 * Price a swap. `index` supplies the reserves for route selection; the router
 * supplies the amounts that get displayed and signed for.
 */
export async function quoteSwap(
  runner: ContractRunner,
  addresses: DexAddresses,
  index: PairIndex,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: bigint,
  options: { slippageBps: number; bases: string[] },
): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error('Enter an amount to swap.');
  const local = bestRoute(index, tokenIn.address, tokenOut.address, amountIn, options.bases);
  if (!local) throw new NoRouteError(tokenIn.symbol, tokenOut.symbol);

  const onChain = (await routerContract(addresses, runner).getAmountsOut(amountIn, local.path)) as bigint[];
  const amounts = onChain.map((a) => BigInt(a));
  const amountOut = amounts[amounts.length - 1];
  if (amountOut <= 0n) throw new Error('This pool is too shallow to fill that trade.');

  const localMatchesChain = amountOut === local.amountOut;
  // Impact is recomputed from the on-chain output so the percentage always
  // describes the number on the screen, not the one we guessed.
  const ppm = priceImpactPpm(amountIn, amountOut, local.hops);

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    amounts,
    route: local,
    localMatchesChain,
    priceImpactPpm: ppm,
    priceImpactBps: Number(ppm / 100n),
    minimumReceived: minimumReceived(amountOut, options.slippageBps),
    slippageBps: options.slippageBps,
    totalFeeBps: FEE_BPS * local.hops.length,
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
