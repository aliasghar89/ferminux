// Balances for the active account on every supported chain.
//
// Each chain runs its own refresh loop: Ferminux every REFRESH_MS, the other
// chains every FOREIGN_REFRESH_MS (public endpoints, gentler cadence). A chain
// that times out or errors keeps its last good reading on screen, flagged, and
// never delays the rest.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHAIN_ID, REFRESH_MS } from '../config.ts';
import { CHAINS, FERMINUX_CHAIN, chainById, type ChainDef } from '../lib/chains.ts';
import {
  chainAssets,
  readChainBalances,
  type AssetRef,
  type ChainReading,
  type CustomToken,
} from '../lib/portfolio.ts';
import { legacyAddressesToResolve, normalizeCustomToken, withCustomToken, withoutCustomToken } from '../lib/customTokens.ts';
import { fetchTokenMeta } from '../lib/tokens.ts';
import { checkAddress } from '../lib/validate.ts';
import { providerFor } from '../lib/providers.ts';
import { loadCustomTokens, loadLegacyTokenList, saveCustomTokens } from './storage.ts';

export const FOREIGN_REFRESH_MS = 30_000;
const READ_TIMEOUT_MS = 8_000;

export type OkReading = Extract<ChainReading, { ok: true }>;

export interface PortfolioApi {
  holder: string;
  customTokens: CustomToken[];
  assetsByChain: Map<number, AssetRef[]>;
  latest: Map<number, ChainReading>;
  lastGood: Map<number, OkReading>;
  /** Chains with a read in flight. */
  busy: Set<number>;
  refresh: (chainId?: number) => void;
  /** Returns an error message, or null on success. */
  addToken: (chainId: number, address: string) => Promise<string | null>;
  removeToken: (chainId: number, address: string) => void;
}

function readingsFor<T>(map: Map<number, T>, chainId: number, value: T): Map<number, T> {
  const next = new Map(map);
  next.set(chainId, value);
  return next;
}

export function usePortfolio(holder: string, chains: ChainDef[] = CHAINS): PortfolioApi {
  const [customTokens, setCustomTokens] = useState<CustomToken[]>(() => loadCustomTokens());
  const [latest, setLatest] = useState<Map<number, ChainReading>>(new Map());
  const [lastGood, setLastGood] = useState<Map<number, OkReading>>(new Map());
  const [busy, setBusy] = useState<Set<number>>(new Set());

  const assetsByChain = useMemo(() => {
    const m = new Map<number, AssetRef[]>();
    for (const c of chains) m.set(c.id, chainAssets(c, customTokens));
    return m;
  }, [chains, customTokens]);
  const assetsRef = useRef(assetsByChain);
  assetsRef.current = assetsByChain;

  // A different account's balances must never linger under the new one.
  useEffect(() => {
    setLatest(new Map());
    setLastGood(new Map());
  }, [holder]);

  // One independent loop per chain. `runNow` lets a manual refresh (or a token
  // added on one chain) re-read just that chain without restarting the others.
  const runNowRef = useRef<(chainId: number) => void>(() => undefined);
  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setInterval>[] = [];
    const inFlight = new Set<number>();
    const runs = new Map<number, () => Promise<void>>();
    for (const chain of chains) {
      const run = async () => {
        if (inFlight.has(chain.id)) return; // a slow chain never stacks reads
        inFlight.add(chain.id);
        setBusy((b) => new Set(b).add(chain.id));
        try {
          const assets = assetsRef.current.get(chain.id) ?? [];
          const reading = await readChainBalances(chain, holder, assets, { timeoutMs: READ_TIMEOUT_MS });
          if (!alive) return;
          setLatest((m) => readingsFor(m, chain.id, reading));
          if (reading.ok) setLastGood((m) => readingsFor(m, chain.id, reading));
        } finally {
          inFlight.delete(chain.id);
          if (alive) {
            setBusy((b) => {
              const n = new Set(b);
              n.delete(chain.id);
              return n;
            });
          }
        }
      };
      runs.set(chain.id, run);
      void run();
      timers.push(setInterval(() => void run(), chain.id === CHAIN_ID ? REFRESH_MS : FOREIGN_REFRESH_MS));
    }
    runNowRef.current = (chainId: number) => void runs.get(chainId)?.();
    return () => {
      alive = false;
      for (const t of timers) clearInterval(t);
      runNowRef.current = () => undefined;
    };
  }, [holder, chains]);

  const refresh = useCallback(
    (chainId?: number) => {
      for (const c of chains) if (chainId === undefined || c.id === chainId) runNowRef.current(c.id);
    },
    [chains],
  );

  // A token added or removed on a chain: re-read that chain now.
  const assetCounts = chains.map((c) => (assetsByChain.get(c.id) ?? []).length).join(',');
  const prevCounts = useRef(assetCounts);
  useEffect(() => {
    const before = prevCounts.current.split(',');
    const after = assetCounts.split(',');
    prevCounts.current = assetCounts;
    chains.forEach((c, i) => {
      if (before[i] !== after[i]) runNowRef.current(c.id);
    });
  }, [assetCounts, chains]);

  const customRef = useRef(customTokens);
  customRef.current = customTokens;

  const commit = useCallback((next: CustomToken[]) => {
    customRef.current = next;
    setCustomTokens(next);
    saveCustomTokens(next);
  }, []);

  const addToken = useCallback(
    async (chainId: number, input: string): Promise<string | null> => {
      const chain = chainById(chainId);
      if (!chain) return 'Choose a supported network first.';
      const check = checkAddress(input);
      if (!check.ok) return check.error;
      let meta;
      try {
        const provider = await providerFor(chain);
        meta = await fetchTokenMeta(provider, check.address);
      } catch (e) {
        return e instanceof Error ? e.message : `Could not read the token on ${chain.name}.`;
      }
      const r = withCustomToken(customRef.current, {
        chainId,
        address: meta.address,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
      });
      if (!r.ok) return r.error;
      commit(r.tokens);
      return null;
    },
    [commit],
  );

  const removeToken = useCallback(
    (chainId: number, address: string) => commit(withoutCustomToken(customRef.current, chainId, address)),
    [commit],
  );

  // One-time upgrade of the single-chain token list: resolve the addresses the
  // user had added on Ferminux into full records.
  useEffect(() => {
    const pending = legacyAddressesToResolve(loadLegacyTokenList(), FERMINUX_CHAIN.id, customRef.current);
    if (pending.length === 0) return;
    let alive = true;
    (async () => {
      let provider;
      try {
        provider = await providerFor(FERMINUX_CHAIN);
      } catch {
        return; // offline: try again next load
      }
      for (const address of pending) {
        try {
          const meta = await fetchTokenMeta(provider, address);
          const t = normalizeCustomToken({ chainId: FERMINUX_CHAIN.id, ...meta });
          if (!alive || !t) continue;
          const r = withCustomToken(customRef.current, t);
          if (r.ok) commit(r.tokens);
        } catch {
          /* a dead contract stays unresolved */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [commit]);

  return { holder, customTokens, assetsByChain, latest, lastGood, busy, refresh, addToken, removeToken };
}
