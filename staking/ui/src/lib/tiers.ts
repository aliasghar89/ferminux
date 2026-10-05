// The vault's Tier enum (FMXStaking.sol), in declaration order: the uint8 that
// stake(tier) takes and getPosition().tier returns. An ABI carries no enum
// member names, so this list is the app's one static copy of the tier SHAPE —
// which tier is which, and which contract constant defines its lock and
// minimum. Every NUMBER about a tier (weight, lock length, lock block,
// minimum) is read from the deployed contract by lib/staking.ts fetchTiers.
// tests/tiers.test.mjs asserts this file against the Solidity source and the
// e2e asserts fetchTiers against a deployed vault, so neither can drift.
// No browser globals: imported by the Node test suites.

import { BPS } from './math.ts';

export const TIER_IDS = { Flexible: 0, Locked90: 1, Locked180: 2, Validator: 3 } as const;
export type TierKey = keyof typeof TIER_IDS;

export interface TierSpec {
  id: number;
  /** The Solidity enum member. */
  key: TierKey;
  name: string;
  shortName: string;
  /**
   * The contract constant that defines the lock (FMXStaking._lockExpired and
   * stake()): LOCK_90 / LOCK_180 are seconds from the stake, VALIDATOR_LOCK_BLOCK
   * is a block height shared by every validator-track position.
   */
  lock: 'none' | 'LOCK_90' | 'LOCK_180' | 'VALIDATOR_LOCK_BLOCK';
  /** The contract constant stake() enforces as a minimum, if any. */
  minStake: 'MIN_VALIDATOR_STAKE' | null;
}

export const TIER_SPECS: readonly TierSpec[] = [
  { id: 0, key: 'Flexible', name: 'Flexible', shortName: 'Flexible', lock: 'none', minStake: null },
  { id: 1, key: 'Locked90', name: 'Locked 90 days', shortName: 'Locked 90d', lock: 'LOCK_90', minStake: null },
  { id: 2, key: 'Locked180', name: 'Locked 180 days', shortName: 'Locked 180d', lock: 'LOCK_180', minStake: null },
  {
    id: 3,
    key: 'Validator',
    name: 'Validator track',
    shortName: 'Validator',
    lock: 'VALIDATOR_LOCK_BLOCK',
    minStake: 'MIN_VALIDATOR_STAKE',
  },
];

export function tierSpec(id: number): TierSpec | null {
  return TIER_SPECS[id] ?? null;
}

/**
 * The vault counts weight in TENTHS (W_FLEX = 10 is 1.0×) and accrues 1%/yr per
 * tenth — `(totalUnits * dt) / (100 * YEAR)` in _accrue. lib/math.ts counts
 * weight in bps (10000 = 1.0×) at BASE_UNIT_APR_BPS (10%/yr) per 1.0× unit:
 * the same rate on a different scale. Convert at the contract boundary only.
 */
export const WEIGHT_TENTHS_PER_X = 10n;

/** tierWeight() tenths → math.ts weight bps (15 → 15000 = 1.5×). */
export function weightBpsFromTenths(tenths: bigint): bigint {
  return (tenths * BPS) / WEIGHT_TENTHS_PER_X;
}

/** totalUnits() (amount × tenths) → math.ts units (amount × weight, 1.0× = 1 per wei). */
export function unitsFromVault(vaultUnits: bigint): bigint {
  return vaultUnits / WEIGHT_TENTHS_PER_X;
}
