import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES, PAIRS_PAGE_SIZE, REFRESH_MS, isConfigured } from '../config.ts';
import { TokenMetaCache, buildPairIndex, loadAllPairs, type PairIndex, type PairSnapshot } from '../lib/pairs.ts';
import { loadLockSummaries, type LockSummary } from '../lib/locker.ts';
import { nativeToken, tokenKey, wfmxToken, type TokenInfo } from '../lib/tokens.ts';

export interface PoolsState {
  pairs: PairSnapshot[];
  index: PairIndex;
  /** Every token that appears in a pool, plus WFMX and the preloaded list. */
  tokens: TokenInfo[];
  locks: Map<string, LockSummary>;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  updatedAt: number | null;
  reload: () => void;
}

/**
 * The whole pool registry, refreshed on a timer and on demand.
 *
 * One shared TokenMetaCache lives for the life of the page: pool listings,
 * the swap selector and the positions list all read the same metadata, so a
 * symbol can never differ between two panels.
 */
export function usePools(provider: JsonRpcProvider | null, chainTimestamp: number | null): PoolsState {
  const [pairs, setPairs] = useState<PairSnapshot[]>([]);
  const [locks, setLocks] = useState<Map<string, LockSummary>>(new Map());
  const [status, setStatus] = useState<PoolsState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new TokenMetaCache(isConfigured() ? DEX_ADDRESSES.wfmx : undefined));

  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    if (!provider || !isConfigured()) return;
    let alive = true;

    const load = async () => {
      setStatus((s) => (s === 'ready' ? 'ready' : 'loading'));
      try {
        const snapshots = await loadAllPairs(provider, DEX_ADDRESSES, cache.current, PAIRS_PAGE_SIZE);
        if (!alive) return;
        setPairs(snapshots);
        // Chain time, not browser time: a lock is matured when the CHAIN says so.
        const asOf = chainTimestamp ?? Math.floor(Date.now() / 1000);
        const summaries = await loadLockSummaries(
          provider,
          DEX_ADDRESSES,
          snapshots.map((p) => ({ pair: p.pair, totalSupply: p.totalSupply })),
          asOf,
        );
        if (!alive) return;
        setLocks(summaries);
        setStatus('ready');
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (!alive) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // chainTimestamp deliberately excluded: it ticks every block and would
    // restart the poll loop. The value is read inside `load` when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, attempt]);

  const index = useMemo(() => buildPairIndex(pairs), [pairs]);

  const tokens = useMemo(() => {
    const merged = new Map<string, TokenInfo>();
    if (isConfigured()) {
      const native = nativeToken(DEX_ADDRESSES.wfmx);
      merged.set(tokenKey(native), native);
      const wrapped = wfmxToken(DEX_ADDRESSES.wfmx);
      merged.set(tokenKey(wrapped), wrapped);
    }
    for (const t of cache.current.all()) merged.set(tokenKey(t), t);
    for (const p of pairs) {
      merged.set(tokenKey(p.token0), p.token0);
      merged.set(tokenKey(p.token1), p.token1);
    }
    return [...merged.values()];
  }, [pairs]);

  return { pairs, index, tokens, locks, status, error, updatedAt, reload };
}
