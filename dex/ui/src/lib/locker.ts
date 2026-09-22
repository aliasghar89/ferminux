// ---------------------------------------------------------------------------
// LiquidityLocker reads — the LOCKED badge.
//
// This is the commercially important number on the whole site: a project can
// add liquidity and pull it a minute later, and a locked LP position is the
// only thing that makes that impossible. So the badge is stated precisely:
//
//   locked NOW  = LP the locker holds whose unlock time is still in the future
//                 (LiquidityLocker.totalLockedForTokenAt(pair, now))
//   held        = everything the locker holds, matured locks included
//                 (LiquidityLocker.totalLockedForToken(pair))
//
// A matured lock is not a lock: it can be withdrawn in the next block. The
// badge therefore reports `lockedNow` as a share of LP supply, with the
// earliest unlock date attached, and shows `held` separately when the two
// differ.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

import { Contract, type ContractRunner } from 'ethers';
import { LOCKER_ABI } from './abi.ts';
import { toChecksum } from './amounts.ts';
import { PPM } from './math.ts';
import type { DexAddresses } from '../config.ts';

export function lockerContract(addresses: DexAddresses, runner: ContractRunner): Contract {
  return new Contract(toChecksum(addresses.locker), LOCKER_ABI as unknown as string[], runner);
}

export interface LockRecord {
  id: bigint;
  /** The LP token (a FerminuxPair) this lock holds. */
  token: string;
  owner: string;
  amount: bigint;
  lockedAt: number;
  unlockAt: number;
  withdrawn: boolean;
}

export interface LockSummary {
  pair: string;
  /** Everything the locker still holds for this pool, matured included. */
  held: bigint;
  /** Still time-locked at `asOf` — the honest number. */
  lockedNow: bigint;
  /** `lockedNow` as a share of LP supply, parts per million. */
  lockedPpm: bigint;
  /** When the first tranche becomes withdrawable; null when nothing is locked. */
  earliestUnlock: number | null;
  /** When the last tranche becomes withdrawable. */
  latestUnlock: number | null;
  /** Locks that are neither withdrawn nor matured. */
  active: LockRecord[];
  /** Every lock ever created for this pool, withdrawn ones included. */
  all: LockRecord[];
  asOf: number;
}

type RawLock = {
  id: bigint;
  token: string;
  owner: string;
  amount: bigint;
  lockedAt: bigint;
  unlockAt: bigint;
  withdrawn: boolean;
};

function toRecord(raw: RawLock | unknown[]): LockRecord {
  // ethers returns a Result: indexable AND named. Index access is stable.
  const r = raw as unknown as [bigint, string, string, bigint, bigint, bigint, boolean];
  return {
    id: BigInt(r[0]),
    token: toChecksum(r[1]),
    owner: toChecksum(r[2]),
    amount: BigInt(r[3]),
    lockedAt: Number(r[4]),
    unlockAt: Number(r[5]),
    withdrawn: Boolean(r[6]),
  };
}

/**
 * Read every lock for one pool and reduce it to the badge.
 *
 * `held` and `lockedNow` come from the contract's own accessors rather than
 * from summing the list, so the headline numbers do not depend on this file
 * getting the filter right; the list is then used for the breakdown and the
 * dates.
 */
export async function loadLockSummary(
  runner: ContractRunner,
  addresses: DexAddresses,
  pair: string,
  lpTotalSupply: bigint,
  asOf: number = Math.floor(Date.now() / 1000),
): Promise<LockSummary> {
  const locker = lockerContract(addresses, runner);
  const pairAddress = toChecksum(pair);
  const [held, lockedNow, rawLocks] = await Promise.all([
    locker.totalLockedForToken(pairAddress) as Promise<bigint>,
    locker.totalLockedForTokenAt(pairAddress, BigInt(asOf)) as Promise<bigint>,
    locker.locksForToken(pairAddress) as Promise<unknown[]>,
  ]);

  const all = rawLocks.map((l) => toRecord(l as RawLock));
  const active = all.filter((l) => !l.withdrawn && l.unlockAt > asOf);
  const unlockTimes = active.map((l) => l.unlockAt);

  return {
    pair: pairAddress,
    held: BigInt(held),
    lockedNow: BigInt(lockedNow),
    lockedPpm: lpTotalSupply > 0n ? (BigInt(lockedNow) * PPM) / lpTotalSupply : 0n,
    earliestUnlock: unlockTimes.length > 0 ? Math.min(...unlockTimes) : null,
    latestUnlock: unlockTimes.length > 0 ? Math.max(...unlockTimes) : null,
    active,
    all,
    asOf,
  };
}

/** Badge data for a whole page of pools, in one pass. */
export async function loadLockSummaries(
  runner: ContractRunner,
  addresses: DexAddresses,
  pools: Array<{ pair: string; totalSupply: bigint }>,
  asOf: number = Math.floor(Date.now() / 1000),
): Promise<Map<string, LockSummary>> {
  const summaries = await Promise.all(
    pools.map((p) => loadLockSummary(runner, addresses, p.pair, p.totalSupply, asOf)),
  );
  const byPair = new Map<string, LockSummary>();
  summaries.forEach((s) => byPair.set(s.pair.toLowerCase(), s));
  return byPair;
}

/** Every lock owned by an address (all pools). */
export async function loadOwnerLocks(
  runner: ContractRunner,
  addresses: DexAddresses,
  owner: string,
): Promise<LockRecord[]> {
  const raw = (await lockerContract(addresses, runner).locksForOwner(toChecksum(owner))) as unknown[];
  return raw.map((l) => toRecord(l as RawLock));
}

/** How a lock should read on screen. */
export function lockState(lock: LockRecord, asOf = Math.floor(Date.now() / 1000)): 'locked' | 'matured' | 'withdrawn' {
  if (lock.withdrawn) return 'withdrawn';
  return lock.unlockAt > asOf ? 'locked' : 'matured';
}
