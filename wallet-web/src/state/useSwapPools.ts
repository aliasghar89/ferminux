// The Ferminux DEX pools between the tokens this wallet knows, for the Swap
// screen: read when it opens, every POOL_REFRESH_MS while it stays open, and on
// demand (Review reads them again before it asks the router for a quote).

import { useCallback, useEffect, useRef, useState } from 'react';
import { httpBatchTransport } from '../lib/balances.ts';
import { indexPools, readPools, type Pool, type PoolIndex } from '../lib/swap.ts';
import { withTransport } from './useNfts.ts';

export const POOL_REFRESH_MS = 15_000;

export interface SwapPoolsApi {
  pools: Pool[] | null;
  index: PoolIndex | null;
  /** The last read failed; `pools` then still holds the one before it (flagged stale). */
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  /** Read again now; resolves with the fresh index (null when the read failed). */
  reload: () => Promise<PoolIndex | null>;
}

/** The probed RPC first (the one transactions go through), then the configured fallbacks. */
export async function fetchPools(rpcUrl: string | null, tokens: string[]): Promise<Pool[]> {
  if (rpcUrl) {
    try {
      return await readPools(httpBatchTransport(rpcUrl, 10_000), tokens);
    } catch {
      /* fall back to the list */
    }
  }
  return withTransport((t) => readPools(t, tokens));
}

export function useSwapPools(rpcUrl: string | null, tokens: string[]): SwapPoolsApi {
  const [state, setState] = useState<{ pools: Pool[] | null; index: PoolIndex | null; error: string | null; updatedAt: number | null }>({
    pools: null,
    index: null,
    error: null,
    updatedAt: null,
  });
  const [loading, setLoading] = useState(true);
  const key = tokens.map((t) => t.toLowerCase()).sort().join(',');
  const latest = useRef({ rpcUrl, tokens });
  latest.current = { rpcUrl, tokens };
  const seq = useRef(0);

  const reload = useCallback(async (): Promise<PoolIndex | null> => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const pools = await fetchPools(latest.current.rpcUrl, latest.current.tokens);
      const index = indexPools(pools);
      if (mine === seq.current) setState({ pools, index, error: null, updatedAt: Date.now() });
      return index;
    } catch (e) {
      if (mine === seq.current) {
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'The Ferminux DEX could not be read.' }));
      }
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), POOL_REFRESH_MS);
    return () => {
      clearInterval(id);
      seq.current += 1; // a read still in flight lands nowhere
    };
    // A new token list or endpoint starts a new read.
  }, [key, rpcUrl, reload]);

  return { ...state, loading, reload };
}
