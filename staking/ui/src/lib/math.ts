// Staking arithmetic — every number the UI shows is computed here, pure and
// unit-tested. No browser globals, no network.
//
// The economics (staking/DESIGN.md §1, §3, §7.2):
//
//   - Rewards are stake-proportional through WEIGHTED UNITS:
//     units(position) = amount × weightBps / 10000.
//   - Each unit accrues at a base 10%/yr, so a tier's APY cap is
//     weight × 10% (flexible 1.0× → 10%, …, validator 3.0× → 30%).
//   - A pool-wide drip cap (1.2M FMX/yr) bounds total outlay:
//     outlay/yr = min(dripPerYear, totalUnits × 10%).
//     When total units exceed dripPerYear / 10% (12M FMX-units), every tier's
//     effective APY scales down pro-rata. Whichever binds, binds.
//   - The pool is FAIL-CLOSED: rewards are paid only from its actual balance.
//     An empty pool means accrual stops — never an IOU. The UI therefore
//     always shows the pool balance and its projected depletion date.
//
// All FMX quantities are bigint wei. Rates are basis points (bps, 10000 = 100%).

export const BPS = 10_000n;
/** Base accrual per weighted unit: 10%/yr (1000 bps) — DESIGN.md §3. */
export const BASE_UNIT_APR_BPS = 1_000n;
export const SECONDS_PER_YEAR = 31_536_000n;

/** Weighted units contributed by a position: amount × weight. */
export function weightedUnits(amountWei: bigint, weightBps: bigint): bigint {
  if (amountWei < 0n) throw new Error('weightedUnits: negative amount');
  return (amountWei * weightBps) / BPS;
}

/**
 * The per-unit APR actually being paid, in bps.
 * min(10%, dripPerYear / totalUnits) — with no stake at all, the cap rate
 * (nothing is diluted yet).
 */
export function perUnitAprBps(totalUnitsWei: bigint, dripPerYearWei: bigint): bigint {
  if (totalUnitsWei <= 0n) return BASE_UNIT_APR_BPS;
  const dripBps = (dripPerYearWei * BPS) / totalUnitsWei;
  return dripBps < BASE_UNIT_APR_BPS ? dripBps : BASE_UNIT_APR_BPS;
}

/**
 * A tier's live effective APR in bps: weight × per-unit rate.
 * Equals the tier cap until the drip cap binds, then scales down pro-rata.
 * DESIGN.md §7.2: at 15M units, flexible 8%, validator 24%.
 */
export function effectiveAprBps(weightBps: bigint, totalUnitsWei: bigint, dripPerYearWei: bigint): bigint {
  return (weightBps * perUnitAprBps(totalUnitsWei, dripPerYearWei)) / BPS;
}

/** Total pool outlay per year in wei: min(drip cap, units × 10%). */
export function annualOutlayWei(totalUnitsWei: bigint, dripPerYearWei: bigint): bigint {
  const demand = (totalUnitsWei * BASE_UNIT_APR_BPS) / BPS;
  return demand < dripPerYearWei ? demand : dripPerYearWei;
}

/**
 * Seconds until the reward pool is empty at the current outlay.
 * null = no outlay (nothing staked): the pool lasts indefinitely.
 */
export function runwaySeconds(poolWei: bigint, totalUnitsWei: bigint, dripPerYearWei: bigint): bigint | null {
  const outlay = annualOutlayWei(totalUnitsWei, dripPerYearWei);
  if (outlay <= 0n) return null;
  return (poolWei * SECONDS_PER_YEAR) / outlay;
}

/** Projected depletion timestamp (ms), from a runway. null passes through. */
export function depletionDateMs(nowMs: number, runway: bigint | null): number | null {
  if (runway === null) return null;
  const capped = runway > 10_000_000_000n ? 10_000_000_000n : runway; // >316 yr → effectively never
  return nowMs + Number(capped) * 1000;
}

/**
 * Rewards a stake earns over `seconds` at a given APR — a PROJECTION at the
 * current rate, not a promise; the UI labels it as such.
 */
export function projectedRewardsWei(amountWei: bigint, aprBps: bigint, seconds: bigint): bigint {
  if (amountWei < 0n || seconds < 0n) throw new Error('projectedRewardsWei: negative input');
  return (amountWei * aprBps * seconds) / (BPS * SECONDS_PER_YEAR);
}

/**
 * Can the pool actually cover a projection? The stake screen refuses to imply
 * a return the contract cannot pay: it checks the projected rewards for the
 * lock period against the pool's remaining runway.
 */
export function poolCoversProjection(
  poolWei: bigint,
  totalUnitsWei: bigint,
  dripPerYearWei: bigint,
  lockSeconds: bigint,
): boolean {
  const runway = runwaySeconds(poolWei, totalUnitsWei, dripPerYearWei);
  if (runway === null) return poolWei > 0n;
  return runway >= lockSeconds;
}

/* ------------------------------------------------------------------ *
 * Countdowns
 * ------------------------------------------------------------------ */

export interface Countdown {
  done: boolean;
  totalSeconds: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Time remaining from `nowSec` until `targetSec` (unix seconds). */
export function countdown(nowSec: number, targetSec: number): Countdown {
  const total = Math.max(0, Math.floor(targetSec - nowSec));
  return {
    done: total === 0,
    totalSeconds: total,
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

/** Estimated seconds until a future block at the target cadence. */
export function secondsUntilBlock(currentBlock: number, targetBlock: number, secondsPerBlock: number): number {
  return Math.max(0, (targetBlock - currentBlock) * secondsPerBlock);
}

/* ------------------------------------------------------------------ *
 * Fee headroom for the MAX button (staking is a native-coin transfer)
 * ------------------------------------------------------------------ */

/**
 * Gas ceiling reserved for one stake() call. Generous on purpose: a fresh
 * position writes ~302k gas of new storage, and the accrual timestamp write
 * makes bare estimates undershoot when the next block's timestamp moves.
 */
export const STAKE_GAS_LIMIT = 400_000n;

/**
 * The most that can be staked from `balanceWei` while reserving fee headroom
 * for the stake transaction itself. 0 when the balance cannot cover fees.
 */
export function maxStakeableWei(balanceWei: bigint, maxFeePerGas: bigint): bigint {
  const headroom = STAKE_GAS_LIMIT * maxFeePerGas;
  return balanceWei > headroom ? balanceWei - headroom : 0n;
}
