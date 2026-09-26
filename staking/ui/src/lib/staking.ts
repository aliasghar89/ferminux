// StakingVault data layer — typed reads and transaction builders.
// No browser globals: the e2e suite drives these same functions under Node
// against a local anvil.
//
// ABI STATUS: the production contracts in /staking/contracts are being written
// in parallel and had not landed when this module was built. The ABI below is
// coded to staking/DESIGN.md §8 and to the e2e fixture contracts in
// ../../fixtures. When the real StakingVault lands, reconcile this ABI (and
// the fixture) against its source — the e2e will catch any drift.

import { Contract, Interface, type ContractRunner, type Provider, type Signer, type TransactionResponse } from 'ethers';

export const STAKING_VAULT_ABI = [
  // tiers
  'function tierCount() view returns (uint256)',
  'function getTier(uint256 id) view returns (uint256 lockSeconds, uint256 weightBps, uint256 aprCapBps, uint256 minStake, bool requiresNode)',
  // network stats
  'function totalStaked() view returns (uint256)',
  'function totalWeightedUnits() view returns (uint256)',
  'function stakerCount() view returns (uint256)',
  'function rewardPoolBalance() view returns (uint256)',
  'function dripPerYear() view returns (uint256)',
  'function cooldownSeconds() view returns (uint256)',
  'function emergencyPenaltyBps() view returns (uint256)',
  'function denied(address account) view returns (bool)',
  // positions
  'function getPositions(address owner) view returns (tuple(uint256 id, uint256 tier, uint256 amount, uint256 startTime, uint256 unlockTime, uint256 cooldownEnd, uint256 state, uint256 pendingRewards)[])',
  'function positionById(uint256 id) view returns (address owner, uint256 tier, uint256 amount, uint256 state)',
  // actions
  'function stake(uint256 tierId) payable returns (uint256 id)',
  'function claim(uint256 id)',
  'function beginUnstake(uint256 id)',
  'function withdraw(uint256 id)',
  'function emergencyExit(uint256 id)',
  // events
  'event Staked(address indexed owner, uint256 indexed id, uint256 indexed tier, uint256 amount, uint256 unlockTime)',
  'event Claimed(address indexed owner, uint256 indexed id, uint256 amount)',
  'event CooldownStarted(address indexed owner, uint256 indexed id, uint256 cooldownEnd)',
  'event Withdrawn(address indexed owner, uint256 indexed id, uint256 amount)',
  'event EmergencyExited(address indexed owner, uint256 indexed id, uint256 penalty, uint256 forfeitedRewards)',
  'event PoolFunded(address indexed from, uint256 amount)',
] as const;

export const vaultInterface = new Interface(STAKING_VAULT_ABI as unknown as string[]);

export function vaultContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, STAKING_VAULT_ABI as unknown as string[], runner);
}

/* ------------------------------------------------------------------ *
 * Typed shapes
 * ------------------------------------------------------------------ */

export interface Tier {
  id: number;
  lockSeconds: bigint;
  weightBps: bigint;
  aprCapBps: bigint;
  minStakeWei: bigint;
  requiresNode: boolean;
}

export const POSITION_STATE = { active: 0, cooling: 1, withdrawn: 2 } as const;
export type PositionState = 'active' | 'cooling' | 'withdrawn';

export interface Position {
  id: bigint;
  tier: number;
  amountWei: bigint;
  startTime: number;
  unlockTime: number;
  cooldownEnd: number;
  state: PositionState;
  pendingRewardsWei: bigint;
}

export interface VaultOverview {
  totalStakedWei: bigint;
  totalWeightedUnitsWei: bigint;
  stakerCount: number;
  rewardPoolWei: bigint;
  dripPerYearWei: bigint;
  cooldownSeconds: number;
  emergencyPenaltyBps: bigint;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

function toState(raw: bigint): PositionState {
  if (raw === 0n) return 'active';
  if (raw === 1n) return 'cooling';
  return 'withdrawn';
}

/** All network-level numbers in one pass — the stats header refuses estimates. */
export async function fetchVaultOverview(provider: Provider, vaultAddress: string): Promise<VaultOverview> {
  const vault = vaultContract(vaultAddress, provider);
  const [totalStaked, units, stakers, pool, drip, cooldown, penalty] = await Promise.all([
    vault.totalStaked() as Promise<bigint>,
    vault.totalWeightedUnits() as Promise<bigint>,
    vault.stakerCount() as Promise<bigint>,
    vault.rewardPoolBalance() as Promise<bigint>,
    vault.dripPerYear() as Promise<bigint>,
    vault.cooldownSeconds() as Promise<bigint>,
    vault.emergencyPenaltyBps() as Promise<bigint>,
  ]);
  return {
    totalStakedWei: totalStaked,
    totalWeightedUnitsWei: units,
    stakerCount: Number(stakers),
    rewardPoolWei: pool,
    dripPerYearWei: drip,
    cooldownSeconds: Number(cooldown),
    emergencyPenaltyBps: penalty,
  };
}

export async function fetchTiers(provider: Provider, vaultAddress: string): Promise<Tier[]> {
  const vault = vaultContract(vaultAddress, provider);
  const count = Number(await vault.tierCount());
  const tiers: Tier[] = [];
  for (let id = 0; id < count; id++) {
    const t = (await vault.getTier(id)) as [bigint, bigint, bigint, bigint, boolean];
    tiers.push({
      id,
      lockSeconds: t[0],
      weightBps: t[1],
      aprCapBps: t[2],
      minStakeWei: t[3],
      requiresNode: t[4],
    });
  }
  return tiers;
}

export async function fetchPositions(provider: Provider, vaultAddress: string, owner: string): Promise<Position[]> {
  const vault = vaultContract(vaultAddress, provider);
  const raw = (await vault.getPositions(owner)) as Array<
    [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  >;
  return raw.map((p) => ({
    id: p[0],
    tier: Number(p[1]),
    amountWei: p[2],
    startTime: Number(p[3]),
    unlockTime: Number(p[4]),
    cooldownEnd: Number(p[5]),
    state: toState(p[6]),
    pendingRewardsWei: p[7],
  }));
}

/** Is this address on the premine deny list (earns nothing by design)? */
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
  stake: 400_000n, // fresh position: ~302k measured on the fixture
  claim: 200_000n,
  beginUnstake: 200_000n,
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

export async function beginUnstake(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
): Promise<TransactionResponse> {
  const vault = vaultContract(vaultAddress, signer);
  await vault.beginUnstake.staticCall(positionId);
  return (await vault.beginUnstake(positionId, { gasLimit: GAS_LIMITS.beginUnstake })) as TransactionResponse;
}

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
 * ------------------------------------------------------------------ */

const REASON_MAP: Array<[RegExp, string]> = [
  [/below tier minimum/i, 'This tier has a minimum stake — see the tier card.'],
  [/denied/i, 'This address is excluded from staking rewards (premine deny list).'],
  [/still locked/i, 'This position is still locked. Emergency exit is the only early way out — it forfeits rewards plus a principal penalty.'],
  [/cooldown/i, 'The 7-day cooldown has not finished yet.'],
  [/not active/i, 'This position is not active any more.'],
  [/nothing to claim/i, 'No rewards have accrued yet.'],
  [/pool empty/i, 'The reward pool is empty — accrual is stopped (fail-closed). Principal is unaffected.'],
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
