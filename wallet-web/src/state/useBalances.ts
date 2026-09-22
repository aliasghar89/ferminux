// One batched balance read for every account in the session.
//
// The whole set is refreshed together in a single JSON-RPC batch, so the total
// is a sum of readings taken at the same moment rather than N readings drifting
// across N round trips.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import {
  fetchBalances,
  httpBatchTransport,
  normalizeAddresses,
  type BalanceSnapshot,
} from '../lib/balances.ts';
import { REFRESH_MS } from '../config.ts';

export interface BalancesApi {
  snapshot: BalanceSnapshot | null;
  /** The last refresh failed; the values shown are the previous reading. */
  stale: boolean;
  refresh: () => void;
}

export function useBalances(
  rpcUrl: string | null,
  provider: JsonRpcProvider | null,
  addresses: string[],
): BalancesApi {
  const key = useMemo(() => normalizeAddresses(addresses).join(','), [addresses]);
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const providerRef = useRef(provider);
  providerRef.current = provider;

  useEffect(() => {
    const list = key === '' ? [] : key.split(',');
    if (list.length === 0) {
      setSnapshot({ balances: new Map(), failed: [], blockTag: 'latest' });
      return;
    }
    if (!rpcUrl && !provider) return;
    let alive = true;

    const read = async (): Promise<BalanceSnapshot> => {
      if (rpcUrl) {
        try {
          return await fetchBalances(httpBatchTransport(rpcUrl), list);
        } catch {
          // fall through to the provider path below
        }
      }
      const p = providerRef.current;
      if (!p) throw new Error('no transport');
      // ethers coalesces concurrent sends into one batched request too; this is
      // the fallback for a proxy that rejects array bodies.
      const results = await Promise.all(
        list.map(async (address) => {
          try {
            return [address, await p.getBalance(address)] as const;
          } catch {
            return [address, null] as const;
          }
        }),
      );
      const balances = new Map<string, bigint>();
      const failed: string[] = [];
      for (const [address, value] of results) {
        if (value === null) failed.push(address);
        else balances.set(address, value);
      }
      if (balances.size === 0) throw new Error('all balance reads failed');
      return { balances, failed, blockTag: 'latest' };
    };

    const run = async () => {
      try {
        const next = await read();
        if (!alive) return;
        setSnapshot(next);
        setStale(next.failed.length > 0);
      } catch {
        if (alive) setStale(true);
      }
    };

    void run();
    const id = setInterval(() => void run(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key, rpcUrl, provider, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { snapshot, stale, refresh };
}
