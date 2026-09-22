// The validator's own volume caps — a second fence, inside the contract's.
//
// FerminuxBridge already enforces maxPerTransfer and a rolling 24h bucket per
// token per direction. This module enforces the SAME maths off-chain, from the
// validator's own config, before it will sign anything. Why duplicate it:
//
//   * the on-chain cap can be raised by the owner multisig (48h timelock). The
//     validator's cap cannot be raised by anyone who has not touched the
//     validator host. Two different keys have to agree to widen the blast radius.
//   * a validator can be configured TIGHTER than the chain during a ramp-up or
//     an incident, without a 48h wait and without touching the contract
//   * refusing to sign is free and instant; unwinding a signed fraudulent
//     transfer is neither
//
// The decay curve is copied from FerminuxBridge._usage() exactly:
//     used_now = used − used × (now − updatedAt) / WINDOW      (0 past WINDOW)
// A linear drain, not a calendar boundary — there is no instant where capacity
// jumps, so there is no instant to sit on and spend the cap twice.

import type { Store } from './db.ts';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CapCheck {
  ok: boolean;
  reason: string | null;
  usedBefore: bigint;
  usedAfter: bigint;
  cap: bigint;
}

/** Key a bucket by chain, token and direction — never share one across routes. */
export function windowKey(chainId: number, token: string, direction: 'out' | 'in'): string {
  return `${chainId}:${token.toLowerCase()}:${direction}`;
}

/** Current usage after linear decay. */
export function decayedUsage(used: bigint, updatedAt: number, now: number): bigint {
  if (used <= 0n) return 0n;
  const elapsed = now - updatedAt;
  if (elapsed <= 0) return used;
  if (elapsed >= WINDOW_MS) return 0n;
  return used - (used * BigInt(elapsed)) / BigInt(WINDOW_MS);
}

export class VolumeLimiter {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Usage right now, without consuming anything. */
  usage(key: string, now = Date.now()): bigint {
    const w = this.store.getWindow(key);
    if (!w) return 0n;
    return decayedUsage(w.used, w.updatedAt, now);
  }

  /**
   * Check `amount` against `cap` and, if it fits, consume it durably.
   * Consumption is persisted before the caller signs, so a crash between the
   * two loses the capacity rather than the safety property.
   */
  tryConsume(key: string, cap: bigint, amount: bigint, now = Date.now()): CapCheck {
    const usedBefore = this.usage(key, now);
    const usedAfter = usedBefore + amount;
    if (cap <= 0n) {
      return { ok: false, reason: 'no cap configured for this token (refusing by default)', usedBefore, usedAfter, cap };
    }
    if (usedAfter > cap) {
      return { ok: false, reason: `24h volume cap exceeded: ${usedAfter} > ${cap}`, usedBefore, usedAfter, cap };
    }
    this.store.putWindow({ key, used: usedAfter, updatedAt: now });
    return { ok: true, reason: null, usedBefore, usedAfter, cap };
  }

  /** Give capacity back — used when a signature is abandoned after consumption. */
  release(key: string, amount: bigint, now = Date.now()): void {
    const current = this.usage(key, now);
    const next = current > amount ? current - amount : 0n;
    this.store.putWindow({ key, used: next, updatedAt: now });
  }
}
