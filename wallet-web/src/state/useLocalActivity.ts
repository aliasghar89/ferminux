// The device-local log of transactions this wallet sent on chains other than
// Ferminux (whose history comes from its own explorer).

import { useCallback, useEffect, useRef, useState } from 'react';
import { chainById } from '../lib/chains.ts';
import { withLocalTx, withLocalTxStatus, type LocalTx, type LocalTxStatus } from '../lib/localActivity.ts';
import { providerFor } from '../lib/providers.ts';
import { loadLocalActivity, saveLocalActivity } from './storage.ts';

export interface LocalActivityApi {
  list: LocalTx[];
  record: (tx: LocalTx) => void;
  setStatus: (chainId: number, hash: string, status: LocalTxStatus) => void;
}

/**
 * `persist` is the vault's "remember on this device": the log names this
 * wallet's address, and nothing address-shaped is written to the device when
 * remember is off. Unremembered, the log lives for this page only.
 */
export function useLocalActivity(persist: boolean): LocalActivityApi {
  const [list, setList] = useState<LocalTx[]>(() => loadLocalActivity());
  const ref = useRef(list);
  ref.current = list;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const commit = useCallback((next: LocalTx[]) => {
    ref.current = next;
    setList(next);
    if (persistRef.current) saveLocalActivity(next);
  }, []);

  // Turning remember on keeps what this page already sent.
  useEffect(() => {
    if (persist && ref.current.length > 0) saveLocalActivity(ref.current);
  }, [persist]);

  const record = useCallback((tx: LocalTx) => commit(withLocalTx(ref.current, tx)), [commit]);
  const setStatus = useCallback(
    (chainId: number, hash: string, status: LocalTxStatus) => commit(withLocalTxStatus(ref.current, chainId, hash, status)),
    [commit],
  );

  // A row still "pending" from an earlier visit (the tab closed before the
  // receipt came back) is settled from its receipt once per page load.
  useEffect(() => {
    let alive = true;
    const pending = ref.current.filter((t) => t.status === 'pending');
    for (const t of pending) {
      const chain = chainById(t.chainId);
      if (!chain) continue;
      void (async () => {
        try {
          const provider = await providerFor(chain);
          const receipt = await provider.getTransactionReceipt(t.hash);
          if (alive && receipt) setStatus(t.chainId, t.hash, receipt.status === 1 ? 'confirmed' : 'failed');
        } catch {
          /* leave it pending; the explorer link still works */
        }
      })();
    }
    return () => {
      alive = false;
    };
  }, [setStatus]);

  return { list, record, setStatus };
}
