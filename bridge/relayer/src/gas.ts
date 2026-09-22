// EIP-1559 fee planning and retry escalation for the submitter.
//
// Two failure modes this exists to prevent:
//
//   1. a transfer that sits unmined forever because the fee was estimated once,
//      during a quiet minute, and the chain then got busy
//   2. a submitter that empties its gas account chasing a transaction that is
//      never going to land, because nothing capped the escalation
//
// So: every attempt re-reads the base fee, escalates by a fixed percentage over
// the PREVIOUS attempt (nodes reject a replacement that is not meaningfully more
// expensive — 10% is the usual floor, hence escalationPct >= 10), and every
// attempt is clamped by an absolute ceiling from config. When the ceiling is
// reached the submitter stops and alerts instead of burning more gas.

import type { JsonRpcProvider } from 'ethers';
import type { GasConfig } from './config.ts';

const GWEI = 1_000_000_000n;
const ONE_GWEI_FALLBACK = GWEI;

export interface FeePlan {
  type: 0 | 2;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Only for legacy (type 0) chains. */
  gasPrice: bigint;
  baseFee: bigint | null;
  /** True when the ceiling clipped the plan — the caller must not escalate further. */
  atCeiling: boolean;
}

function pct(value: bigint, percent: number): bigint {
  return (value * BigInt(Math.round(percent * 100))) / 10_000n;
}

/**
 * Fee plan for attempt N (0-based). Each attempt is escalationPct higher than
 * the last, compounding, and hard-clamped to gas.maxFeePerGasGwei.
 */
export async function planFees(provider: JsonRpcProvider, gas: GasConfig, attempt: number): Promise<FeePlan> {
  const ceiling = BigInt(gas.maxFeePerGasGwei) * GWEI;
  const block = await provider.getBlock('latest');
  const baseFee = block?.baseFeePerGas ?? null;

  let tip: bigint;
  try {
    tip = BigInt(await provider.send('eth_maxPriorityFeePerGas', []));
  } catch {
    tip = BigInt(gas.priorityFeeGwei) * GWEI;
  }
  const floorTip = BigInt(gas.priorityFeeGwei) * GWEI;
  if (tip < floorTip) tip = floorTip;
  if (tip <= 0n) tip = ONE_GWEI_FALLBACK;

  const base = baseFee ?? ONE_GWEI_FALLBACK;
  const multiplier = 100 + gas.escalationPct;

  // Escalate ONCE, from the un-escalated first-attempt values. Deriving the
  // legacy gasPrice from an already-escalated tip would compound twice and
  // overpay by escalationPct on every retry.
  const escalate = (value: bigint): bigint => {
    let out = value;
    for (let i = 0; i < attempt; i++) out = pct(out, multiplier);
    return out;
  };

  let atCeiling = false;
  const clamp = (value: bigint): bigint => {
    if (value <= ceiling) return value;
    atCeiling = true;
    return ceiling;
  };

  if (gas.txType === 0) {
    const gasPrice = clamp(escalate(base + tip));
    return { type: 0, maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n, gasPrice, baseFee, atCeiling };
  }

  const maxFee = clamp(escalate(base * BigInt(gas.baseFeeMultiplier) + tip));
  let escalatedTip = escalate(tip);
  if (escalatedTip > maxFee) escalatedTip = maxFee;
  return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: escalatedTip, gasPrice: 0n, baseFee, atCeiling };
}

/** Gas limit with head-room, clamped by gas.gasLimitCap. */
export function planGasLimit(estimate: bigint, gas: GasConfig): bigint {
  const withHeadroom = (estimate * BigInt(Math.round(gas.gasLimitMultiplier * 100))) / 100n;
  const cap = BigInt(gas.gasLimitCap);
  return withHeadroom > cap ? cap : withHeadroom;
}

/**
 * A replacement transaction must beat the one it replaces by enough that the
 * mempool accepts it. Returns true when `next` is a valid replacement for `prev`.
 */
export function isValidReplacement(prev: FeePlan, next: FeePlan, minBumpPct = 10): boolean {
  const need = (v: bigint): bigint => pct(v, 100 + minBumpPct);
  if (next.type === 0) return next.gasPrice >= need(prev.gasPrice);
  return next.maxFeePerGas >= need(prev.maxFeePerGas) && next.maxPriorityFeePerGas >= need(prev.maxPriorityFeePerGas);
}

export { GWEI };
