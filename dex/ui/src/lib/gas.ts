// ---------------------------------------------------------------------------
// Fee headroom for "Max".
//
// Spending the entire FMX balance leaves nothing to pay for the very
// transaction that spends it, so "Max" on a native-FMX input reserves a
// generous gas budget first. Reserving too much is a rounding error; reserving
// too little means a rejected transaction, so the reserve is deliberately
// pessimistic.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

/** Head-room gas units: a two-hop swap through the router, with slack. */
export const SWAP_GAS_HEADROOM = 400_000n;

/** Fallback fee cap when the node will not give one (5 gwei). */
export const FALLBACK_MAX_FEE_WEI = 5_000_000_000n;

/**
 * The most native FMX that can be spent while still affording the fee.
 * Returns 0 when the balance cannot even cover the reserve.
 */
export function maxNativeSpendable(
  balance: bigint,
  maxFeePerGas: bigint | null | undefined,
  gasLimit: bigint = SWAP_GAS_HEADROOM,
): bigint {
  const feeCap = maxFeePerGas && maxFeePerGas > 0n ? maxFeePerGas : FALLBACK_MAX_FEE_WEI;
  const reserve = feeCap * gasLimit;
  return balance > reserve ? balance - reserve : 0n;
}
