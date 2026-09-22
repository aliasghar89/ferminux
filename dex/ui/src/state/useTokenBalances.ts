import { useCallback, useEffect, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { REFRESH_MS } from '../config.ts';
import { fetchBalance, tokenKey, type TokenInfo } from '../lib/tokens.ts';

/**
 * Balances for a token list, keyed by `tokenKey`. Missing entries mean "not
 * loaded yet" — never "zero", so a slow RPC cannot make a funded wallet look
 * empty.
 */
export function useTokenBalances(
  provider: JsonRpcProvider | null,
  owner: string | null,
  tokens: TokenInfo[],
): { balances: Map<string, bigint>; refresh: () => void } {
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((a) => a + 1), []);

  // Only the identity of the tokens matters, not the array instance.
  const key = tokens.map(tokenKey).join(',');

  useEffect(() => {
    if (!provider || !owner) {
      setBalances(new Map());
      return;
    }
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        tokens.map(async (token) => {
          try {
            return [tokenKey(token), await fetchBalance(provider, token, owner)] as const;
          } catch {
            return null; // an unreadable token must not blank the others
          }
        }),
      );
      if (!alive) return;
      const next = new Map<string, bigint>();
      for (const entry of entries) if (entry) next.set(entry[0], entry[1]);
      setBalances(next);
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, owner, key, attempt]);

  return { balances, refresh };
}
