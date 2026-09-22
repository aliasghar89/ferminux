import { useCallback, useEffect, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { fetchTokenMeta, fetchTokenBalance, type TokenMeta } from '../lib/tokens.ts';
import { checkAddress } from '../lib/validate.ts';
import { loadTokenAddresses, saveTokenAddresses } from './storage.ts';
import { DEFAULT_TOKENS, REFRESH_MS } from '../config.ts';

export interface TokenRow {
  address: string;
  meta: TokenMeta | null;
  metaFailed: boolean;
  balance: bigint | null;
}

export interface TokensApi {
  tokens: TokenRow[];
  /** Returns an error message, or null on success. */
  addToken: (address: string) => Promise<string | null>;
  removeToken: (address: string) => void;
  refresh: () => void;
}

export function useTokens(provider: JsonRpcProvider | null, holder: string): TokensApi {
  const [rows, setRows] = useState<TokenRow[]>(() => {
    const stored = loadTokenAddresses();
    const defaults = DEFAULT_TOKENS.map((t) => t.address);
    const all = [...new Set([...defaults, ...stored].map((a) => a.toLowerCase()))];
    return all.map((address) => {
      const preset = DEFAULT_TOKENS.find((t) => t.address.toLowerCase() === address);
      return {
        address,
        meta: preset ? { address: preset.address, name: preset.name, symbol: preset.symbol, decimals: preset.decimals } : null,
        metaFailed: false,
        balance: null,
      };
    });
  });
  const [tick, setTick] = useState(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const persist = useCallback((next: TokenRow[]) => {
    saveTokenAddresses(next.map((r) => r.meta?.address ?? r.address));
  }, []);

  // Resolve missing metadata whenever a provider is available.
  useEffect(() => {
    if (!provider) return;
    let alive = true;
    (async () => {
      for (const row of rowsRef.current) {
        if (row.meta) continue;
        try {
          const meta = await fetchTokenMeta(provider, row.address);
          if (!alive) return;
          setRows((rs) => rs.map((r) => (r.address === row.address ? { ...r, meta, metaFailed: false } : r)));
        } catch {
          if (!alive) return;
          setRows((rs) => rs.map((r) => (r.address === row.address ? { ...r, metaFailed: true } : r)));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider, tick]);

  // Poll balances.
  useEffect(() => {
    if (!provider) return;
    let alive = true;
    const poll = async () => {
      for (const row of rowsRef.current) {
        try {
          const balance = await fetchTokenBalance(provider, row.address, holder);
          if (!alive) return;
          setRows((rs) => rs.map((r) => (r.address === row.address ? { ...r, balance } : r)));
        } catch {
          /* keep the previous value; RPC hiccups are transient */
        }
      }
    };
    void poll();
    const id = setInterval(() => void poll(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [provider, holder, tick]);

  const addToken = useCallback(
    async (input: string): Promise<string | null> => {
      const check = checkAddress(input);
      if (!check.ok) return check.error;
      const lower = check.address.toLowerCase();
      if (rowsRef.current.some((r) => r.address === lower)) return 'This token is already in your list.';
      if (!provider) return 'Not connected to the network — try again once connected.';
      let meta: TokenMeta;
      try {
        meta = await fetchTokenMeta(provider, check.address);
      } catch (e) {
        return e instanceof Error ? e.message : 'Could not read token metadata.';
      }
      let balance: bigint | null = null;
      try {
        balance = await fetchTokenBalance(provider, check.address, holder);
      } catch {
        balance = null;
      }
      setRows((rs) => {
        const next = [...rs, { address: lower, meta, metaFailed: false, balance }];
        persist(next);
        return next;
      });
      return null;
    },
    [provider, holder, persist],
  );

  const removeToken = useCallback(
    (address: string) => {
      setRows((rs) => {
        const next = rs.filter((r) => r.address !== address.toLowerCase());
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { tokens: rows, addToken, removeToken, refresh };
}
