// Polled on-chain staking data: vault overview + tiers, the caller's
// positions, and the node roster. Every consumer gets the same three-state
// shape (loading / data / error) so no screen can show an estimated number.

import { useCallback, useEffect, useState } from 'react';
import type { Provider } from 'ethers';
import { REFRESH_MS } from '../config.ts';
import {
  fetchVaultOverview,
  fetchTiers,
  fetchPositions,
  type VaultOverview,
  type Tier,
  type Position,
} from '../lib/staking.ts';
import { fetchRoster, fetchRegistryParams, type NetworkNode } from '../lib/nodes.ts';

export interface Poll<T> {
  data: T | null;
  /** true only before the FIRST answer; refreshes keep stale data visible. */
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function usePoll<T>(provider: Provider | null, enabled: boolean, fetcher: (p: Provider) => Promise<T>): Poll<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!provider || !enabled) return;
    let alive = true;
    const tick = async () => {
      try {
        const data = await fetcher(provider);
        if (alive) setState({ data, loading: false, error: null });
      } catch (e) {
        if (alive) {
          setState((s) => ({
            data: s.data,
            loading: false,
            error: (e as Error)?.message ?? String(e),
          }));
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [provider, enabled, nonce, fetcher]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}

/* ------------------------------------------------------------------ *
 * Vault
 * ------------------------------------------------------------------ */

export interface VaultData {
  overview: VaultOverview;
  tiers: Tier[];
}

export function useVaultData(provider: Provider | null, vaultAddress: string): Poll<VaultData> {
  const fetcher = useCallback(
    async (p: Provider): Promise<VaultData> => {
      const [overview, tiers] = await Promise.all([
        fetchVaultOverview(p, vaultAddress),
        fetchTiers(p, vaultAddress),
      ]);
      return { overview, tiers };
    },
    [vaultAddress],
  );
  return usePoll(provider, vaultAddress !== '', fetcher);
}

export function usePositions(provider: Provider | null, vaultAddress: string, owner: string | null): Poll<Position[]> {
  const fetcher = useCallback(
    (p: Provider) => fetchPositions(p, vaultAddress, owner ?? ''),
    [vaultAddress, owner],
  );
  return usePoll(provider, vaultAddress !== '' && owner !== null, fetcher);
}

/* ------------------------------------------------------------------ *
 * Node registry
 * ------------------------------------------------------------------ */

export interface RosterData {
  nodes: NetworkNode[];
  minBondWei: bigint;
  validatorTier: number;
}

export function useRoster(provider: Provider | null, registryAddress: string): Poll<RosterData> {
  const fetcher = useCallback(
    async (p: Provider): Promise<RosterData> => {
      const [nodes, params] = await Promise.all([
        fetchRoster(p, registryAddress),
        fetchRegistryParams(p, registryAddress),
      ]);
      return { nodes, ...params };
    },
    [registryAddress],
  );
  return usePoll(provider, registryAddress !== '', fetcher);
}

/* ------------------------------------------------------------------ *
 * Wallet balance
 * ------------------------------------------------------------------ */

export function useBalance(provider: Provider | null, address: string | null): Poll<bigint> {
  const fetcher = useCallback((p: Provider) => p.getBalance(address ?? ''), [address]);
  return usePoll(provider, address !== null, fetcher);
}
