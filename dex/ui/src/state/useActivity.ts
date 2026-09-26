import { useCallback, useEffect, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES, DEX_START_BLOCK } from '../config.ts';
import { rpcLogSource } from '../lib/events.ts';
import { loadAccountActivity, type ActivityItem } from '../lib/history.ts';
import type { TokenInfo } from '../lib/tokens.ts';
import { persistMarket, type MarketData } from './useMarket.ts';
import type { PoolsState } from './usePools.ts';

export interface ActivityState {
  items: ActivityItem[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** The connected account's DEX transactions, re-read when the market record moves. */
export function useActivity(
  provider: JsonRpcProvider | null,
  account: string | null,
  pools: PoolsState,
  tokens: TokenInfo[],
  market: MarketData,
  head: number | null,
  enabled: boolean,
): ActivityState {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  const marketRef = useRef(market);
  marketRef.current = market;
  const lastLogCount = market.record.logs.length;

  useEffect(() => {
    setItems(null);
  }, [account]);

  useEffect(() => {
    if (!enabled || !provider || !account || head === null || pools.pairs.length === 0) return;
    let alive = true;
    setLoading(true);
    const m = marketRef.current;
    loadAccountActivity({
      source: rpcLogSource(provider),
      rpc: provider,
      clock: m.clock,
      account,
      pools: pools.pairs,
      tokens,
      wfmx: DEX_ADDRESSES.wfmx,
      router: DEX_ADDRESSES.router,
      locker: DEX_ADDRESSES.locker,
      market: m.record,
      fromBlock: DEX_START_BLOCK,
      head,
      txCache: m.txCache,
    })
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setError(null);
        persistMarket(marketRef.current);
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
    // Re-read when the account changes, when the market record grows, or on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, provider, account, pools.pairs.length, lastLogCount, attempt, head !== null]);

  return { items, loading, error, reload };
}
