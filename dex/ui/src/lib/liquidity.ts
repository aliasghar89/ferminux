// ---------------------------------------------------------------------------
// Adding and removing liquidity, and the arithmetic behind both.
//
// The pool ratio IS the price. Everything here follows from that:
//   - into an existing pool you may only deposit at the current ratio, so the
//     second amount is computed, never typed;
//   - into an empty pool anything goes, and whatever you choose becomes the
//     opening price — which is why `quoteAddLiquidity` flags `isFirstDeposit`
//     loudly for the UI to explain;
//   - what you get back on exit is your share of the reserves at that moment,
//     not what you put in.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

import { type ContractRunner, type ContractTransactionResponse } from 'ethers';
import { toChecksum } from './amounts.ts';
import {
  deadlineFromNow,
  liquidityMinted,
  minimumDeposited,
  pooledAmounts,
  quote as quoteRatio,
  shareOfPoolPpm,
} from './math.ts';
import { factoryContract, fetchLpBalance, orientedReserves, type PairSnapshot } from './pairs.ts';
import { routerContract } from './swap.ts';
import type { TokenInfo } from './tokens.ts';
import type { DexAddresses } from '../config.ts';

export interface AddLiquidityQuote {
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  /** What will actually be deposited. */
  amountA: bigint;
  amountB: bigint;
  /** Slippage floors handed to the router. */
  amountAMin: bigint;
  amountBMin: bigint;
  /** True when this deposit sets the opening price. */
  isFirstDeposit: boolean;
  /** LP tokens this deposit should mint (exact for an existing pool). */
  lpMinted: bigint | null;
  /**
   * The fewest LP tokens the router is allowed to deliver, handed to it as
   * `minLiquidity`. It is `lpMinted` less the slippage tolerance for a deposit
   * into a live pool, and 0 for the first deposit (an empty pool has no ratio to
   * be short of, and the depositor holds ~100% of the LP so there is nothing to
   * skim). This is what stops a hostile token from taking the paired asset and
   * returning dust LP.
   */
  minLiquidity: bigint;
  /** Depositor's resulting share of the pool, parts per million. */
  shareOfPoolPpm: bigint;
}

/**
 * Work out the counterpart amount for a deposit.
 *
 * `side` says which box the user typed in; the other is derived from the pool
 * ratio with the same `quote()` the router uses, so what is shown is what will
 * be pulled from the wallet.
 */
export function quoteAddLiquidity(
  snapshot: PairSnapshot | null,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
  side: 'A' | 'B',
  amount: bigint,
  slippageBps: number,
  otherAmountForFirstDeposit?: bigint,
): AddLiquidityQuote {
  if (amount <= 0n) throw new Error('Enter an amount to deposit.');

  const empty = !snapshot || snapshot.reserve0 <= 0n || snapshot.reserve1 <= 0n || snapshot.totalSupply <= 0n;
  if (empty) {
    const other = otherAmountForFirstDeposit ?? 0n;
    if (other <= 0n) throw new Error('This pool is empty — enter BOTH amounts to set the opening price.');
    const amountA = side === 'A' ? amount : other;
    const amountB = side === 'A' ? other : amount;
    return {
      tokenA,
      tokenB,
      amountA,
      amountB,
      // Nothing can move an empty pool's ratio, but a pool seeded by someone
      // else between signing and mining CAN. Pinning the mins to the desired
      // amounts makes the router revert in that case instead of quietly
      // depositing at a stranger's price.
      amountAMin: amountA,
      amountBMin: amountB,
      isFirstDeposit: true,
      lpMinted: null,
      // First deposit: no ratio to fall short of and the depositor owns the
      // whole pool, so there is nothing for a hostile token to skim. The amount
      // floors above already pin the opening price.
      minLiquidity: 0n,
      shareOfPoolPpm: 1_000_000n,
    };
  }

  const a = orientedReserves(snapshot, tokenA.address);
  const reserveA = a.own;
  const reserveB = a.other;

  const amountA = side === 'A' ? amount : quoteRatio(amount, reserveB, reserveA);
  const amountB = side === 'A' ? quoteRatio(amount, reserveA, reserveB) : amount;

  const lpMinted = liquidityMinted(amountA, amountB, reserveA, reserveB, snapshot.totalSupply);
  return {
    tokenA,
    tokenB,
    amountA,
    amountB,
    amountAMin: minimumDeposited(amountA, slippageBps),
    amountBMin: minimumDeposited(amountB, slippageBps),
    isFirstDeposit: false,
    lpMinted,
    // The LP floor: expected LP less the same slippage tolerance. The router
    // reverts unless it delivers at least this many LP tokens to the depositor.
    minLiquidity: minimumDeposited(lpMinted, slippageBps),
    shareOfPoolPpm: shareOfPoolPpm(lpMinted, snapshot.totalSupply + lpMinted),
  };
}

/**
 * Deposit. One of the two tokens may be native FMX, in which case the payable
 * `addLiquidityFMX` path is used and any FMX the ratio did not need is
 * refunded by the router in the same transaction.
 *
 * DELIBERATE: this flow only ever calls the PLAIN router paths, which carry
 * both the caller's `minLiquidity` floor and the router's own proportional
 * floor. It never calls a `SupportingFeeOnTransferTokens` variant — those are
 * for tokens that tax their own transfers, and calling one casually (worse,
 * with `minLiquidity` = 0) would trade the strictest protection away for a
 * token property this UI cannot verify. If fee-on-transfer support is ever
 * added, it must be an explicit user choice that supplies an honest
 * `maxFeeBps` (the token's real tax) and a non-zero `minLiquidity`, because
 * the declared fee is the most a hostile token can cost the depositor.
 *
 * And the honest limit of ALL router protections: they police the deposit,
 * not the token. A token you do not trust controls its own side of the pool
 * forever — it can mint, blacklist, tax, or freeze later, long after an
 * honest-looking deposit settled. Do not pair real value against a token you
 * would not hold outright.
 */
export async function addLiquidity(
  signer: ContractRunner,
  addresses: DexAddresses,
  quote: AddLiquidityQuote,
  to: string,
  deadlineMinutes: number,
  nowSec?: number,
): Promise<ContractTransactionResponse> {
  const router = routerContract(addresses, signer);
  const deadline = deadlineFromNow(deadlineMinutes, nowSec);
  const recipient = toChecksum(to);
  const { tokenA, tokenB, amountA, amountB, amountAMin, amountBMin, minLiquidity } = quote;

  if (tokenA.kind === 'native' && tokenB.kind === 'native') {
    throw new Error('Both sides cannot be native FMX.');
  }
  if (tokenA.kind === 'native') {
    return (await router.addLiquidityFMX(
      tokenB.address,
      amountB,
      amountBMin,
      amountAMin,
      minLiquidity,
      recipient,
      deadline,
      { value: amountA },
    )) as ContractTransactionResponse;
  }
  if (tokenB.kind === 'native') {
    return (await router.addLiquidityFMX(
      tokenA.address,
      amountA,
      amountAMin,
      amountBMin,
      minLiquidity,
      recipient,
      deadline,
      { value: amountB },
    )) as ContractTransactionResponse;
  }
  return (await router.addLiquidity(
    tokenA.address,
    tokenB.address,
    amountA,
    amountB,
    amountAMin,
    amountBMin,
    minLiquidity,
    recipient,
    deadline,
  )) as ContractTransactionResponse;
}

export interface RemoveLiquidityQuote {
  /** LP tokens to burn. */
  liquidity: bigint;
  /** What the burn should pay out, in token0/token1 order of the pool. */
  amount0: bigint;
  amount1: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  /** Percentage of the holder's position, 0–100. */
  percent: number;
}

/** What burning `percent`% of an LP balance pays out right now. */
export function quoteRemoveLiquidity(
  snapshot: PairSnapshot,
  lpBalance: bigint,
  percent: number,
  slippageBps: number,
): RemoveLiquidityQuote {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new Error('Choose a percentage between 1 and 100.');
  }
  if (lpBalance <= 0n) throw new Error('No LP tokens in this pool.');
  // Integer-percent maths on bigints; 100% burns the exact balance so no dust
  // is ever left behind by a rounding division.
  const liquidity = percent === 100 ? lpBalance : (lpBalance * BigInt(Math.round(percent))) / 100n;
  if (liquidity <= 0n) throw new Error('That percentage rounds to zero LP tokens.');
  const [amount0, amount1] = pooledAmounts(liquidity, snapshot.totalSupply, snapshot.reserve0, snapshot.reserve1);
  return {
    liquidity,
    amount0,
    amount1,
    amount0Min: minimumDeposited(amount0, slippageBps),
    amount1Min: minimumDeposited(amount1, slippageBps),
    percent,
  };
}

/**
 * Burn LP tokens. `nativeSide` (when set) unwraps that side back to FMX via
 * `removeLiquidityFMX`; the router needs an LP allowance either way.
 */
export async function removeLiquidity(
  signer: ContractRunner,
  addresses: DexAddresses,
  snapshot: PairSnapshot,
  quote: RemoveLiquidityQuote,
  to: string,
  deadlineMinutes: number,
  options: { unwrapNative?: boolean; wfmx?: string; nowSec?: number } = {},
): Promise<ContractTransactionResponse> {
  const router = routerContract(addresses, signer);
  const deadline = deadlineFromNow(deadlineMinutes, options.nowSec);
  const recipient = toChecksum(to);
  const wfmx = (options.wfmx ?? addresses.wfmx).toLowerCase();
  const token0 = snapshot.token0.address;
  const token1 = snapshot.token1.address;

  if (options.unwrapNative && (token0.toLowerCase() === wfmx || token1.toLowerCase() === wfmx)) {
    const wfmxIsToken0 = token0.toLowerCase() === wfmx;
    const token = wfmxIsToken0 ? token1 : token0;
    const amountTokenMin = wfmxIsToken0 ? quote.amount1Min : quote.amount0Min;
    const amountFMXMin = wfmxIsToken0 ? quote.amount0Min : quote.amount1Min;
    return (await router.removeLiquidityFMX(
      token,
      quote.liquidity,
      amountTokenMin,
      amountFMXMin,
      recipient,
      deadline,
    )) as ContractTransactionResponse;
  }

  return (await router.removeLiquidity(
    token0,
    token1,
    quote.liquidity,
    quote.amount0Min,
    quote.amount1Min,
    recipient,
    deadline,
  )) as ContractTransactionResponse;
}

/**
 * Create an empty pool. The pair can also be created implicitly by the first
 * `addLiquidity`, but doing it explicitly lets the UI show the pool address and
 * make the first-depositor warning unmissable before any money moves.
 */
export async function createPair(
  signer: ContractRunner,
  addresses: DexAddresses,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
): Promise<ContractTransactionResponse> {
  if (tokenA.address.toLowerCase() === tokenB.address.toLowerCase()) {
    throw new Error('A pool needs two different tokens.');
  }
  return (await factoryContract(addresses, signer).createPair(
    tokenA.address,
    tokenB.address,
  )) as ContractTransactionResponse;
}

// -------------------------------------------------------------- positions ---

export interface Position {
  snapshot: PairSnapshot;
  lpBalance: bigint;
  shareOfPoolPpm: bigint;
  pooled0: bigint;
  pooled1: bigint;
}

/** Every pool where `owner` holds LP tokens, biggest share first. */
export async function loadPositions(
  runner: ContractRunner,
  pairs: PairSnapshot[],
  owner: string,
): Promise<Position[]> {
  const balances = await Promise.all(pairs.map((p) => fetchLpBalance(runner, p.pair, owner)));
  const positions: Position[] = [];
  pairs.forEach((snapshot, i) => {
    const lpBalance = balances[i];
    if (lpBalance <= 0n) return;
    const [pooled0, pooled1] = pooledAmounts(lpBalance, snapshot.totalSupply, snapshot.reserve0, snapshot.reserve1);
    positions.push({
      snapshot,
      lpBalance,
      shareOfPoolPpm: shareOfPoolPpm(lpBalance, snapshot.totalSupply),
      pooled0,
      pooled1,
    });
  });
  return positions.sort((a, b) => (b.shareOfPoolPpm > a.shareOfPoolPpm ? 1 : -1));
}
