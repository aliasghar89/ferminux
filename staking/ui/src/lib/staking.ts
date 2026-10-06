// FMXStaking data layer — typed reads and transaction builders for the vault in
// ../../contracts/src/FMXStaking.sol (ABI fragments: ./abi.ts).
// No browser globals: the e2e suite drives these same functions under Node
// against the real contract deployed on a local anvil.

import { Contract, type ContractRunner, type Provider, type Signer, type TransactionResponse } from 'ethers';
import { FMX_STAKING_ABI } from './abi.ts';
import { BASE_UNIT_APR_BPS, BPS } from './math.ts';
import { TIER_SPECS, unitsFromVault, weightBpsFromTenths } from './tiers.ts';

export function vaultContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, FMX_STAKING_ABI as unknown as string[], runner);
}

/* ------------------------------------------------------------------ *
 * Typed shapes
 * ------------------------------------------------------------------ */

export interface Tier {
  id: number;
  name: string;
  /** Base weight in bps (10000 = 1.0×) — tierWeight(tier, false). */
  weightBps: bigint;
  /** Uptime-boosted weight in bps — tierWeight(tier, true) — when it differs from the base; else null. */
  boostedWeightBps: bigint | null;
  /** APY cap at the base weight: weight × 10%/yr. */
  aprCapBps: bigint;
  /** APY cap at the boosted weight; null when the tier has no boost. */
  boostedAprCapBps: bigint | null;
  /** Time lock in seconds from the stake (LOCK_90 / LOCK_180); 0n for no time lock. */
  lockSeconds: bigint;
  /** Block-height lock (VALIDATOR_LOCK_BLOCK) shared by every position in the tier; null for none. */
  lockUntilBlock: number | null;
  /** Minimum stake (MIN_VALIDATOR_STAKE); 0n = any amount above zero. */
  minStakeWei: bigint;
}

export const POSITION_STATE = { active: 0, cooling: 1, withdrawn: 2 } as const;
export type PositionState = 'active' | 'cooling' | 'withdrawn';

export interface Position {
  id: bigint;
  tier: number;
  state: PositionState;
  /** Validator track only: the uptime boost (2.0× → 3.0×) is on. */
  boosted: boolean;
  amountWei: bigint;
  startTime: number;
  /** Time-lock end (unix seconds) for Locked-90/180; 0 = no time lock. */
  unlockTime: number;
  /** Block-height lock for the validator track; 0 = no block lock. */
  unlockBlock: number;
  cooldownEnd: number;
  /** Claimable now (pendingRewards). Banked rewards survive cooldown AND withdrawal. */
  pendingRewardsWei: bigint;
}

/** Contract constants — fixed in the bytecode, so read once per vault. */
export interface VaultConstants {
  /** tierWeight(tier, false), in tenths, indexed by tier id. */
  weightTenths: bigint[];
  /** tierWeight(tier, true), in tenths, indexed by tier id. */
  boostedWeightTenths: bigint[];
  lock90Seconds: bigint;
  lock180Seconds: bigint;
  validatorLockBlock: number;
  minValidatorStakeWei: bigint;
  cooldownSeconds: number;
  earlyExitPenaltyBps: bigint;
}

export interface VaultOverview {
  /** Principal the vault owes stakers, active and cooling down (totalPrincipal). */
  totalStakedWei: bigint;
  /** Weighted units on the vault's own scale, amount × weight tenths (totalUnits). */
  totalUnits: bigint;
  /** The same weighted stake in lib/math.ts units (1.0× = 1 per wei). */
  totalWeightedUnitsWei: bigint;
  /**
   * Positions ever opened (positionCount), withdrawn ones included. The vault
   * keeps no staker count, and one address can hold many positions — so this
   * is never shown as a number of stakers.
   */
  positionCount: number;
  /** Unallocated reward pool, settled to the latest block (see settledRewardPool). */
  rewardPoolWei: bigint;
  dripPerYearWei: bigint;
  cooldownSeconds: number;
  emergencyPenaltyBps: bigint;
  /** Deposits paused by the owner. Withdrawals, claims and emergency exits never pause. */
  paused: boolean;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------ */

const PRECISION = 10n ** 18n;
const YEAR = 365n * 86_400n;

/**
 * rewardPool() only moves when a transaction runs the vault's _accrue(), so
 * between transactions it overstates what is left by everything accrued since
 * lastAccrual. This is _accrue()'s pool charge, line for line (same floors,
 * same ceiling on the charge), evaluated at `nowSec` — the number the next
 * transaction would leave behind. Pure arithmetic; never below zero.
 */
export function settledRewardPool(
  s: { rewardPool: bigint; totalUnits: bigint; dripPerYear: bigint; lastAccrual: bigint },
  nowSec: bigint,
): bigint {
  if (nowSec <= s.lastAccrual || s.totalUnits === 0n || s.rewardPool === 0n) return s.rewardPool;
  const dt = nowSec - s.lastAccrual;
  const ideal = (s.totalUnits * dt) / (100n * YEAR);
  const budget = (s.dripPerYear * dt) / YEAR;
  let amount = ideal < budget ? ideal : budget;
  if (amount > s.rewardPool) amount = s.rewardPool;
  const inc = (amount * PRECISION) / s.totalUnits;
  const charged = (inc * s.totalUnits + PRECISION - 1n) / PRECISION;
  return s.rewardPool - charged;
}

/**
 * FMXStaking._lockExpired, inverted: a validator-track position is locked while
 * the chain is below its lock block (unknown head → locked); a Locked-90/180
 * position while its lock end is in the future; Flexible never.
 */
export function isLocked(
  p: Pick<Position, 'unlockTime' | 'unlockBlock'>,
  nowSec: number,
  blockNumber: number | null,
): boolean {
  if (p.unlockBlock > 0) return blockNumber === null || blockNumber < p.unlockBlock;
  return p.unlockTime > nowSec;
}

/**
 * A position is worth listing while it holds principal OR unclaimed rewards:
 * withdraw() returns principal only, and rewards banked at the unstake request
 * stay claimable afterwards.
 */
export function isVisiblePosition(p: Pick<Position, 'state' | 'pendingRewardsWei'>): boolean {
  return p.state !== 'withdrawn' || p.pendingRewardsWei > 0n;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

function toState(raw: bigint): PositionState {
  if (raw === 0n) return 'active';
  if (raw === 1n) return 'cooling';
  return 'withdrawn';
}

async function readConstants(provider: Provider, vaultAddress: string): Promise<VaultConstants> {
  const vault = vaultContract(vaultAddress, provider);
  const ids = TIER_SPECS.map((t) => t.id);
  const [base, boosted, lock90, lock180, lockBlock, minVal, cooldown, penalty] = await Promise.all([
    Promise.all(ids.map((id) => vault.tierWeight(id, false) as Promise<bigint>)),
    Promise.all(ids.map((id) => vault.tierWeight(id, true) as Promise<bigint>)),
    vault.LOCK_90() as Promise<bigint>,
    vault.LOCK_180() as Promise<bigint>,
    vault.VALIDATOR_LOCK_BLOCK() as Promise<bigint>,
    vault.MIN_VALIDATOR_STAKE() as Promise<bigint>,
    vault.COOLDOWN() as Promise<bigint>,
    vault.EARLY_EXIT_PENALTY_BPS() as Promise<bigint>,
  ]);
  return {
    weightTenths: base,
    boostedWeightTenths: boosted,
    lock90Seconds: lock90,
    lock180Seconds: lock180,
    validatorLockBlock: Number(lockBlock),
    minValidatorStakeWei: minVal,
    cooldownSeconds: Number(cooldown),
    earlyExitPenaltyBps: penalty,
  };
}

const constantsCache = new Map<string, Promise<VaultConstants>>();

/** Constants are bytecode, not state: one read per vault, retried only after a failure. */
export function fetchVaultConstants(provider: Provider, vaultAddress: string): Promise<VaultConstants> {
  const key = vaultAddress.toLowerCase();
  let pending = constantsCache.get(key);
  if (!pending) {
    pending = readConstants(provider, vaultAddress);
    constantsCache.set(key, pending);
    pending.catch(() => constantsCache.delete(key));
  }
  return pending;
}

/** All network-level numbers in one pass — the stats header refuses estimates. */
export async function fetchVaultOverview(provider: Provider, vaultAddress: string): Promise<VaultOverview> {
  const vault = vaultContract(vaultAddress, provider);
  const [c, principal, units, positions, pool, drip, lastAccrual, paused, head] = await Promise.all([
    fetchVaultConstants(provider, vaultAddress),
    vault.totalPrincipal() as Promise<bigint>,
    vault.totalUnits() as Promise<bigint>,
    vault.positionCount() as Promise<bigint>,
    vault.rewardPool() as Promise<bigint>,
    vault.dripPerYear() as Promise<bigint>,
    vault.lastAccrual() as Promise<bigint>,
    vault.paused() as Promise<boolean>,
    provider.getBlock('latest'),
  ]);
  const settled = head
    ? settledRewardPool({ rewardPool: pool, totalUnits: units, dripPerYear: drip, lastAccrual }, BigInt(head.timestamp))
    : pool;
  return {
    totalStakedWei: principal,
    totalUnits: units,
    totalWeightedUnitsWei: unitsFromVault(units),
    positionCount: Number(positions),
    rewardPoolWei: settled,
    dripPerYearWei: drip,
    cooldownSeconds: c.cooldownSeconds,
    emergencyPenaltyBps: c.earlyExitPenaltyBps,
    paused,
  };
}

/** The four tiers, every number from the contract; names and lock kinds from lib/tiers.ts. */
export async function fetchTiers(provider: Provider, vaultAddress: string): Promise<Tier[]> {
  const c = await fetchVaultConstants(provider, vaultAddress);
  return TIER_SPECS.map((spec) => {
    const base = c.weightTenths[spec.id];
    const boosted = c.boostedWeightTenths[spec.id];
    const weightBps = weightBpsFromTenths(base);
    const boostedWeightBps = boosted !== base ? weightBpsFromTenths(boosted) : null;
    return {
      id: spec.id,
      name: spec.name,
      weightBps,
      boostedWeightBps,
      aprCapBps: (weightBps * BASE_UNIT_APR_BPS) / BPS,
      boostedAprCapBps: boostedWeightBps === null ? null : (boostedWeightBps * BASE_UNIT_APR_BPS) / BPS,
      lockSeconds: spec.lock === 'LOCK_90' ? c.lock90Seconds : spec.lock === 'LOCK_180' ? c.lock180Seconds : 0n,
      lockUntilBlock: spec.lock === 'VALIDATOR_LOCK_BLOCK' ? c.validatorLockBlock : null,
      minStakeWei: spec.minStake === 'MIN_VALIDATOR_STAKE' ? c.minValidatorStakeWei : 0n,
    };
  });
}

interface RawPosition {
  tier: bigint;
  state: bigint;
  boosted: boolean;
  startTime: bigint;
  lockEnd: bigint;
  cooldownEnd: bigint;
  amount: bigint;
}

export async function fetchPositions(provider: Provider, vaultAddress: string, owner: string): Promise<Position[]> {
  const vault = vaultContract(vaultAddress, provider);
  const [ids, c] = await Promise.all([
    vault.positionsOf(owner) as Promise<bigint[]>,
    fetchVaultConstants(provider, vaultAddress),
  ]);
  return Promise.all(
    [...ids].map(async (id) => {
      const [p, pending] = await Promise.all([
        vault.getPosition(id) as Promise<RawPosition>,
        vault.pendingRewards(id) as Promise<bigint>,
      ]);
      const tier = Number(p.tier);
      return {
        id,
        tier,
        state: toState(p.state),
        boosted: p.boosted,
        amountWei: p.amount,
        startTime: Number(p.startTime),
        unlockTime: Number(p.lockEnd),
        unlockBlock: TIER_SPECS[tier]?.lock === 'VALIDATOR_LOCK_BLOCK' ? c.validatorLockBlock : 0,
        cooldownEnd: Number(p.cooldownEnd),
        pendingRewardsWei: pending,
      };
    }),
  );
}

/** Is this address on the premine deny list (cannot stake, by contract)? */
export async function fetchDenied(provider: Provider, vaultAddress: string, account: string): Promise<boolean> {
  const vault = vaultContract(vaultAddress, provider);
  return (await vault.denied(account)) as boolean;
}

/* ------------------------------------------------------------------ *
 * Actions — each returns the TransactionResponse; the caller awaits
 * confirmation and refreshes its reads.
 *
 * Every action (1) preflights with staticCall so a doomed transaction fails
 * HERE with the contract's require string instead of burning gas on chain,
 * then (2) sends with an explicit, generous gasLimit instead of trusting a
 * bare estimate: the vault's accrual updates a timestamp on every call, so an
 * estimate made in one second can undershoot execution in the next by a few
 * thousand gas — enough to turn an exact-limit transaction into an
 * out-of-gas revert. Unused gas is refunded; the ceiling costs nothing.
 * ------------------------------------------------------------------ */

export const GAS_LIMITS = {
  stake: 400_000n, // fresh position: ~220k measured on FMXStaking (e2e)
  claim: 200_000n,
  requestUnstake: 200_000n,
  withdraw: 200_000n,
  emergencyExit: 250_000n,
} as const;

export async function stake(
  signer: Signer,
  vaultAddress: string,
  tierId: number,
  amountWei: bigint,
): Promise<TransactionResponse> {
  const vault = vaultContract(vaultAddress, signer);
  await vault.stake.staticCall(tierId, { value: amountWei });
  return (await vault.stake(tierId, { value: amountWei, gasLimit: GAS_LIMITS.stake })) as TransactionResponse;
}

export async function claim(signer: Signer, vaultAddress: string, positionId: bigint): Promise<TransactionResponse> {
  const vault = vaultContract(vaultAddress, signer);
  await vault.claim.staticCall(positionId);
  return (await vault.claim(positionId, { gasLimit: GAS_LIMITS.claim })) as TransactionResponse;
}

/** Start the 7-day cooldown on an unlocked position; its rewards are banked and stay claimable. */
export async function requestUnstake(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
): Promise<TransactionResponse> {
  const vault = vaultContract(vaultAddress, signer);
  await vault.requestUnstake.staticCall(positionId);
  return (await vault.requestUnstake(positionId, { gasLimit: GAS_LIMITS.requestUnstake })) as TransactionResponse;
}

/** Return principal after the cooldown. Principal only — claim rewards separately. */
export async function withdraw(signer: Signer, vaultAddress: string, positionId: bigint): Promise<TransactionResponse> {
  const vault = vaultContract(vaultAddress, signer);
  await vault.withdraw.staticCall(positionId);
  return (await vault.withdraw(positionId, { gasLimit: GAS_LIMITS.withdraw })) as TransactionResponse;
}

export async function emergencyExit(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
): Promise<TransactionResponse> {
  const vault = vaultContract(vaultAddress, signer);
  await vault.emergencyExit.staticCall(positionId);
  return (await vault.emergencyExit(positionId, { gasLimit: GAS_LIMITS.emergencyExit })) as TransactionResponse;
}

/* ------------------------------------------------------------------ *
 * Human error mapping — contract require strings → plain words.
 * Keyed on the exact "STK: …" / "NR: …" strings in ../../contracts/src.
 * ------------------------------------------------------------------ */

const REASON_MAP: Array<[RegExp, string]> = [
  [/below validator minimum/i, 'This tier has a minimum stake — see the tier card.'],
  [/staker denied/i, 'This address is excluded from staking (premine deny list).'],
  [/deposits paused/i, 'New deposits are paused by the vault owner. Withdrawals, claims and emergency exits still work.'],
  [/lock not expired/i, 'This position is still locked. Emergency exit is the only early way out — it forfeits rewards plus a principal penalty.'],
  [/cooldown not over/i, 'The 7-day cooldown has not finished yet.'],
  [/not in cooldown/i, 'Start the unstake first — principal is withdrawable only after the 7-day cooldown.'],
  [/STK: not active/i, 'This position is not active any more.'],
  [/nothing to claim/i, 'No rewards have accrued yet.'],
  [/not a validator-track position/i, 'Only a validator-track position can bond a node.'],
  [/bond below minimum/i, 'The position is below the minimum node bond.'],
  [/position not active/i, 'The position is not active (it is cooling down or withdrawn).'],
  [/position already bonds a node/i, 'This position already bonds a node. One node per position.'],
  [/node key already registered/i, 'This node key is already registered.'],
  [/consensus addr already registered/i, 'This consensus address is already registered to another node.'],
  [/invalid possession signature/i, 'The signature was not made by this node key over this registration.'],
  [/not position owner|not node operator/i, 'This wallet does not own that position or node.'],
  [/insufficient funds/i, 'Not enough FMX to cover the amount plus gas.'],
  [/user rejected|denied transaction|ACTION_REJECTED/i, 'Transaction rejected in the wallet.'],
];

/** Translate an ethers/contract error into one honest sentence. */
export function humanizeTxError(err: unknown): string {
  const raw =
    (err as { shortMessage?: string })?.shortMessage ??
    (err as { reason?: string })?.reason ??
    (err as Error)?.message ??
    String(err);
  for (const [re, msg] of REASON_MAP) {
    if (re.test(raw)) return msg;
  }
  const trimmed = raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
  return `Transaction failed: ${trimmed}`;
}
