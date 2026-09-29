import { formatPpmPercent, formatRelativeFuture, formatTimestamp } from '../lib/amounts.ts';
import type { LockSummary } from '../lib/locker.ts';
import { IconLock, IconUnlock } from './icons.tsx';

/** LOCKED (share of LP, unlock date) or NOT LOCKED: the number a buyer checks first. */
export function LockBadge({ lock, chainTime, full }: { lock: LockSummary | null; chainTime: number | null; full?: boolean }) {
  if (!lock) return <span className="badge">lock unknown</span>;
  if (lock.lockedNow > 0n) {
    return (
      <span className="badge badge-lock" title={lock.earliestUnlock ? `Earliest unlock ${formatTimestamp(lock.earliestUnlock)}` : undefined} data-testid="lock-badge">
        <IconLock />
        Locked {formatPpmPercent(lock.lockedPpm, 1)}
        {full && lock.earliestUnlock !== null && <span className="badge-sub">until {formatTimestamp(lock.earliestUnlock).replace(/, \d\d:\d\d UTC$/, '').replace(/ \d\d:\d\d UTC$/, '')}</span>}
        {!full && lock.earliestUnlock !== null && <span className="badge-sub">{formatRelativeFuture(lock.earliestUnlock, chainTime ?? undefined)}</span>}
      </span>
    );
  }
  return (
    <span className="badge badge-open" data-testid="unlock-badge">
      <IconUnlock />
      Not locked
    </span>
  );
}
