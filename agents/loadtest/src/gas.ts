// Exact gas math for marked native transfers.
//
// A native transfer to an account with no code runs no EVM code, so the gas it uses is exactly its
// intrinsic gas:
//   london (what chain 3961 runs today): 21,000 + 4 per zero data byte + 16 per non-zero data byte
//   prague (EIP-7623 calldata floor):    max(that, 21,000 + 10 × (zero + 4 × non-zero))
// The marker is 5 non-zero bytes, so a marked transfer costs 21,080 gas on 3961 (21,200 under the floor).
// Which rule applies is read from the node once at start (eth_estimateGas on a marked transfer) and must
// match one of the two, or the runner refuses to send (see runner.ts).
//
// Fees are EIP-1559: maxPriorityFeePerGas = the tip (1 gwei, the signers' minimum) and
// maxFeePerGas = the next block's base fee + the tip. While the base fee holds, the effective price is
// exactly maxFeePerGas, so a sweep that sends `balance − gas × maxFeePerGas` leaves exactly zero behind.
// If the base fee falls before inclusion the refund leaves gas × (drop) wei, which is always less than one
// transfer's gas.

export type GasRule = "london" | "prague";

export const TX_BASE_GAS = 21_000n;

export function calldataCounts(data: Uint8Array): { zero: number; nonZero: number } {
  let zero = 0;
  for (const b of data) if (b === 0) zero++;
  return { zero, nonZero: data.length - zero };
}

/** Intrinsic gas of a plain (non-creation, no access list) transaction carrying `data`. */
export function intrinsicGas(data: Uint8Array, rule: GasRule = "london"): bigint {
  const { zero, nonZero } = calldataCounts(data);
  const standard = TX_BASE_GAS + 4n * BigInt(zero) + 16n * BigInt(nonZero);
  if (rule === "london") return standard;
  const tokens = BigInt(zero) + 4n * BigInt(nonZero);
  const floor = TX_BASE_GAS + 10n * tokens;
  return standard > floor ? standard : floor;
}

/** Which rule an estimate matches, or null when it matches neither (then nothing is sent). */
export function ruleForEstimate(estimate: bigint, data: Uint8Array): GasRule | null {
  if (estimate === intrinsicGas(data, "london")) return "london";
  if (estimate === intrinsicGas(data, "prague")) return "prague";
  return null;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** EIP-1559 fees for inclusion in the next block: max fee = base fee + tip, so the effective price is exact. */
export function feesFor(baseFee: bigint, tip: bigint): Fees {
  if (baseFee < 0n || tip < 0n) throw new Error("negative fee");
  return { maxFeePerGas: baseFee + tip, maxPriorityFeePerGas: tip };
}

/** The price a transaction pays per gas once included in a block with `baseFee`. */
export function effectiveGasPrice(baseFee: bigint, fees: Fees): bigint {
  const capped = baseFee + fees.maxPriorityFeePerGas;
  return capped < fees.maxFeePerGas ? capped : fees.maxFeePerGas;
}

/** The most a transaction can cost (what the node checks against the balance before accepting it). */
export function maxCost(gas: bigint, fees: Fees): bigint {
  return gas * fees.maxFeePerGas;
}

/**
 * The value that empties an account: balance − gas × maxFeePerGas. Zero when the balance cannot cover the
 * gas (that balance is dust: less than one transfer's gas, and it stays).
 */
export function sweepValue(balance: bigint, gas: bigint, fees: Fees): bigint {
  const v = balance - maxCost(gas, fees);
  return v > 0n ? v : 0n;
}

/** What stays behind after a sweep of `value` with `fees` lands in a block with `baseFee`. */
export function sweepRemainder(balance: bigint, value: bigint, gas: bigint, fees: Fees, baseFee: bigint): bigint {
  return balance - value - gas * effectiveGasPrice(baseFee, fees);
}

/**
 * The next block's base fee from its parent (EIP-1559, elasticity 2, change denominator 8), as the node
 * computes it: an unchanged, rising or falling base fee with integer rounding.
 */
export function nextBaseFee(parent: { baseFee: bigint; gasUsed: bigint; gasLimit: bigint }): bigint {
  const target = parent.gasLimit / 2n;
  if (target === 0n) return parent.baseFee;
  if (parent.gasUsed === target) return parent.baseFee;
  if (parent.gasUsed > target) {
    const delta = (parent.baseFee * (parent.gasUsed - target)) / target / 8n;
    return parent.baseFee + (delta > 1n ? delta : 1n);
  }
  const delta = (parent.baseFee * (target - parent.gasUsed)) / target / 8n;
  const next = parent.baseFee - delta;
  return next > 0n ? next : 0n;
}

/** A fee bump for a replacement (the node wants ≥ 10 % more on both caps): +25 %, rounded up, at least +1 wei. */
export function bumpFees(old: Fees, baseFee: bigint): Fees {
  const up = (x: bigint) => x + (x + 3n) / 4n + 1n;
  const tip = up(old.maxPriorityFeePerGas);
  const fromBase = baseFee + tip;
  const bumped = up(old.maxFeePerGas);
  return { maxPriorityFeePerGas: tip, maxFeePerGas: bumped > fromBase ? bumped : fromBase };
}
