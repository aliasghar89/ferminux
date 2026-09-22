import { useCallback, useEffect, useState } from 'react';
import type { TokenInfo } from '../lib/tokens.ts';

const STORAGE_KEY = 'ferminux-dex.custom-tokens.v1';

/**
 * Tokens the user pasted in by address. Stored in localStorage so a token
 * imported once stays in the selector, and nowhere else — the app has no
 * backend and keeps no list of who traded what.
 *
 * Storage can be unavailable (private mode, blocked third-party storage); that
 * degrades to "imported for this session only" rather than crashing the app.
 */
export function useCustomTokens(): {
  customTokens: TokenInfo[];
  addCustomToken: (token: TokenInfo) => void;
  removeCustomToken: (address: string) => void;
  persisted: boolean;
} {
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>([]);
  const [persisted, setPersisted] = useState(true);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as TokenInfo[];
      if (Array.isArray(parsed)) {
        setCustomTokens(
          parsed.filter(
            (t) =>
              t &&
              typeof t.address === 'string' &&
              typeof t.symbol === 'string' &&
              Number.isInteger(t.decimals),
          ),
        );
      }
    } catch {
      setPersisted(false);
    }
  }, []);

  const save = useCallback((next: TokenInfo[]) => {
    setCustomTokens(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setPersisted(false);
    }
  }, []);

  const addCustomToken = useCallback(
    (token: TokenInfo) => {
      setCustomTokens((current) => {
        const without = current.filter((t) => t.address.toLowerCase() !== token.address.toLowerCase());
        const next = [...without, { ...token, kind: 'erc20' as const }];
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          setPersisted(false);
        }
        return next;
      });
    },
    [],
  );

  const removeCustomToken = useCallback(
    (address: string) => {
      save(customTokens.filter((t) => t.address.toLowerCase() !== address.toLowerCase()));
    },
    [customTokens, save],
  );

  return { customTokens, addCustomToken, removeCustomToken, persisted };
}
