import { useCallback, useEffect, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES } from '../config.ts';
import { loadPositions, type Position } from '../lib/liquidity.ts';
import { loadOwnerLocks, type LockRecord } from '../lib/locker.ts';
import type { PairSnapshot } from '../lib/pairs.ts';

export interface PositionsState {
  /** null until read (or with no wallet). */
  positions: Position[] | null;
  locks: LockRecord[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** The connected account's LP positions and LiquidityLocker locks, re-read with the pools. */
export function usePositions(provider: JsonRpcProvider | null, pairs: PairSnapshot[], owner: string | null): PositionsState {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [locks, setLocks] = useState<LockRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    if (!provider || !owner) {
      setPositions(null);
      setLocks([]);
      return;
    }
    if (pairs.length === 0) {
      setPositions([]);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all([loadPositions(provider, pairs, owner), loadOwnerLocks(provider, DEX_ADDRESSES, owner)])
      .then(([found, owned]) => {
        if (!alive) return;
        setPositions(found);
        setLocks(owned);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [provider, pairs, owner, attempt]);

  return { positions, locks, loading, error, reload };
}
