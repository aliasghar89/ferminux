// Live per-asset state: balance, allowance, cap usage. Polled, and decayed
// locally between polls so the "remaining 24 h capacity" figure the user sees
// tracks the contract's continuously-draining bucket instead of going stale.

import { useCallback, useEffect, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { POLL_MS } from '../config.ts';
import { readRailState, type RegistryEntry, type RailState } from '../lib/bridge.ts';
import { decayedUsage } from '../lib/amounts.ts';
import { shortenError } from '../components/ui.tsx';

export interface RailData {
  state: RailState | null;
  loading: boolean;
  error: string | null;
  /** Usage decayed from the block it was read at to `nowSeconds`. */
  usageNow: (nowSeconds: number) => bigint;
  refresh: () => void;
}

function railKey(bridgeAddress: string | null, entry: RegistryEntry | null, account: string | null): string | null {
  if (!bridgeAddress || !entry) return null;
  return `${bridgeAddress.toLowerCase()}:${entry.localToken.toLowerCase()}:${(account ?? '-').toLowerCase()}`;
}

export function useRail(
  provider: JsonRpcProvider | null,
  bridgeAddress: string | null,
  entry: RegistryEntry | null,
  account: string | null,
): RailData {
  // The reading is stored WITH the asset it belongs to. Switching assets must
  // never show the previous asset's balance under the new asset's decimals, so
  // a reading whose key no longer matches is treated as absent (skeletons)
  // rather than displayed until the next poll lands.
  const [reading, setReading] = useState<{ key: string; value: RailState } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const key = railKey(bridgeAddress, entry, account);

  useEffect(() => {
    if (!provider || !bridgeAddress || !entry || !key) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const next = await readRailState(provider, bridgeAddress, entry, account);
        if (!alive) return;
        setReading({ key, value: next });
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(shortenError(err instanceof Error ? err.message : String(err)));
      } finally {
        if (alive && first) setLoading(false);
      }
      if (alive) timer = setTimeout(() => void tick(false), POLL_MS);
    };

    void tick(true);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [provider, bridgeAddress, entry, account, key, epoch]);

  const state = reading && reading.key === key ? reading.value : null;

  const usageNow = useCallback(
    (nowSeconds: number) => (state ? decayedUsage(state.usage, state.atSeconds, nowSeconds) : 0n),
    [state],
  );

  const refresh = useCallback(() => setEpoch((n) => n + 1), []);
  return { state, loading: loading || (key !== null && state === null && error === null), error, usageNow, refresh };
}
