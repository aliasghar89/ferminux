// Buying FMX through the pay-in: the asset list, the purchases this device
// made, and the status poll that moves them along (quoted → seen → confirmed
// → paid). The purchases live in WalletHome so they outlive the Swap screen;
// the asset list and the poll run while Swap is open.

import { useCallback, useEffect, useRef, useState } from 'react';
import { PAYIN_API_URL } from '../config.ts';
import { chainById } from '../lib/chains.ts';
import { providerFor } from '../lib/providers.ts';
import {
  PAYIN_POLL_MS,
  fetchPayinAssets,
  fetchPayinStatus,
  isOpen,
  recordsFrom,
  withLocalPay,
  withRecord,
  withStatus,
  type PayinAssets,
  type PayinRecord,
} from '../lib/payin.ts';
import { loadPayinRecords, savePayinRecords } from './storage.ts';

/* ---------------- purchases ---------------- */

export interface PayinRecordsApi {
  list: PayinRecord[];
  put: (rec: PayinRecord) => void;
  /** Apply `fn` to one purchase; returns the result (null when unknown). */
  update: (quoteId: string, fn: (r: PayinRecord) => PayinRecord) => PayinRecord | null;
  get: (quoteId: string) => PayinRecord | null;
}

/**
 * Quote ids whose transfer this page is signing or broadcasting right now:
 * the poll leaves their local state alone until the broadcast has answered.
 */
export const payinSending = new Set<string>();

/** `persist` is the vault's "remember on this device" (see storage.ts, category 5). */
export function usePayinRecords(persist: boolean): PayinRecordsApi {
  const [list, setList] = useState<PayinRecord[]>(() => loadPayinRecords());
  const ref = useRef(list);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const commit = useCallback((next: PayinRecord[]) => {
    ref.current = next;
    setList(next);
    savePayinRecords(next, persistRef.current);
  }, []);

  // Remember switched on or off: move what this page holds to the matching store.
  useEffect(() => {
    if (ref.current.length > 0) savePayinRecords(ref.current, persist);
  }, [persist]);

  const put = useCallback((rec: PayinRecord) => commit(withRecord(ref.current, rec)), [commit]);
  const get = useCallback((quoteId: string) => ref.current.find((r) => r.quoteId === quoteId) ?? null, []);
  const update = useCallback(
    (quoteId: string, fn: (r: PayinRecord) => PayinRecord) => {
      const cur = ref.current.find((r) => r.quoteId === quoteId);
      if (!cur) return null;
      const next = fn(cur);
      if (next !== cur) commit(withRecord(ref.current, next));
      return ref.current.find((r) => r.quoteId === quoteId) ?? null;
    },
    [commit],
  );
  return { list, put, update, get };
}

/* ---------------- the asset list ---------------- */

export interface PayinAssetsApi {
  assets: PayinAssets | null;
  state: 'loading' | 'ok' | 'error';
  error: string | null;
  /** Read again now; resolves the fresh list, or null when it could not be read (the last good one stays). */
  reload: () => Promise<PayinAssets | null>;
  /** The list, read again when older than `maxAgeMs`. */
  fresh: (maxAgeMs?: number) => Promise<PayinAssets | null>;
}

export function usePayinAssets(): PayinAssetsApi {
  const [assets, setAssets] = useState<PayinAssets | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const at = useRef<number>(0);
  const cur = useRef<PayinAssets | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const reload = useCallback(async () => {
    try {
      const a = await fetchPayinAssets(PAYIN_API_URL);
      cur.current = a;
      at.current = Date.now();
      if (alive.current) {
        setAssets(a);
        setState('ok');
        setError(null);
      }
      return a;
    } catch (e) {
      if (alive.current) {
        setState(cur.current ? 'ok' : 'error');
        setError(e instanceof Error ? e.message : 'The pay-in could not be read.');
      }
      return null;
    }
  }, []);

  const fresh = useCallback(
    async (maxAgeMs = 60_000) => (cur.current && Date.now() - at.current < maxAgeMs ? cur.current : reload()),
    [reload],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { assets, state, error, reload, fresh };
}

/* ---------------- the poll ---------------- */

/**
 * While mounted, every PAYIN_POLL_MS: each open purchase from `address` asks
 * the pay-in for its status, and a transfer this wallet sent is checked on
 * its own network (included, reverted, or never arrived). `onPaid` runs once per
 * purchase that turns paid, so the FMX balance can be read again.
 */
export function usePayinTracking(records: PayinRecordsApi, address: string, onPaid: (r: PayinRecord) => void): void {
  const recRef = useRef(records);
  recRef.current = records;
  const paidRef = useRef(onPaid);
  paidRef.current = onPaid;

  useEffect(() => {
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const nowS = Math.floor(Date.now() / 1000);
        const open = recordsFrom(recRef.current.list, address).filter((r) => isOpen(r, nowS) && !payinSending.has(r.quoteId));
        await Promise.all(
          open.map(async (r) => {
            await checkLocalTransfer(r, recRef.current);
            try {
              const s = await fetchPayinStatus(PAYIN_API_URL, r);
              if (!alive) return;
              const before = recRef.current.get(r.quoteId);
              const after = recRef.current.update(r.quoteId, (x) => withStatus(x, s));
              if (before && after && before.status !== 'paid' && after.status === 'paid') paidRef.current(after);
            } catch {
              /* next tick */
            }
          }),
        );
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), PAYIN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [address]);
}

/** A transfer this wallet signed: on its network yet, and did it succeed? */
async function checkLocalTransfer(r: PayinRecord, api: PayinRecordsApi): Promise<void> {
  if (!r.localTx || (r.localState !== 'signed' && r.localState !== 'sent')) return;
  const chain = chainById(r.chainId);
  if (!chain) return;
  try {
    const provider = await providerFor(chain);
    const receipt = await provider.getTransactionReceipt(r.localTx);
    if (receipt) {
      api.update(r.quoteId, (x) => withLocalPay(x, r.localTx, receipt.status === 1 ? 'included' : 'reverted', receipt.status === 1 ? null : 'The transfer reverted.'));
      return;
    }
    if (r.localState === 'signed') {
      // Signed on an earlier visit that never learned whether the broadcast went out.
      const tx = await provider.getTransaction(r.localTx);
      api.update(r.quoteId, (x) => withLocalPay(x, r.localTx, tx ? 'sent' : 'dropped', tx ? null : `The transfer never reached ${chain.name}.`));
    }
  } catch {
    /* the network is unreachable: try again next tick */
  }
}
