import { useCallback, useEffect, useRef, useState } from 'react';
import { PAYIN_API_URL, PAYIN_POLL_MS } from '../config.ts';
import {
  PAY_STORE_KEY,
  PayApiError,
  applyStatus,
  fetchPayAssets,
  fetchPayStatus,
  isFinished,
  parseStore,
  payChain,
  readPayBalances,
  serializeStore,
  shouldPoll,
  upsertTrack,
  type PayAssetsInfo,
  type PayBalances,
  type PayChainKey,
  type PayStore,
  type PayTrack,
} from '../lib/payin.ts';

// ---------------------------------------------------------------------------
// The pay-in's asset list: read when the "Other networks" section or the pay
// card is on screen, shared by both, re-read after a minute.
// ---------------------------------------------------------------------------

const ASSETS_TTL_MS = 60_000;
let assetsCache: { info: PayAssetsInfo; at: number } | null = null;
let assetsInflight: Promise<PayAssetsInfo> | null = null;
const assetsListeners = new Set<(info: PayAssetsInfo) => void>();

function loadAssets(force: boolean): Promise<PayAssetsInfo> {
  if (!force && assetsCache && Date.now() - assetsCache.at < ASSETS_TTL_MS) return Promise.resolve(assetsCache.info);
  if (assetsInflight) return assetsInflight;
  assetsInflight = fetchPayAssets(PAYIN_API_URL)
    .then((info) => {
      assetsCache = { info, at: Date.now() };
      for (const l of [...assetsListeners]) l(info);
      return info;
    })
    .finally(() => {
      assetsInflight = null;
    });
  return assetsInflight;
}

export interface PayAssetsState {
  info: PayAssetsInfo | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * The asset list read now, not from the minute-long cache: whether a network is
 * taking payments is asked again right before the wallet pays on it. Every
 * mounted usePayAssets sees the answer.
 */
export function refreshPayAssets(): Promise<PayAssetsInfo> {
  return loadAssets(true);
}

export function usePayAssets(active: boolean): PayAssetsState {
  const [info, setInfo] = useState<PayAssetsInfo | null>(() => assetsCache?.info ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const forced = useRef(false);

  useEffect(() => {
    const onInfo = (next: PayAssetsInfo) => {
      setInfo(next);
      setError(null);
    };
    assetsListeners.add(onInfo);
    return () => {
      assetsListeners.delete(onInfo);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const run = (force: boolean) => {
      setLoading(true);
      loadAssets(force)
        .then((next) => {
          if (!alive) return;
          setInfo(next);
          setError(null);
        })
        .catch((err) => {
          if (alive) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    run(forced.current);
    forced.current = false;
    const id = setInterval(() => run(false), ASSETS_TTL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, nonce]);

  const reload = useCallback(() => {
    forced.current = true;
    setNonce((n) => n + 1);
  }, []);
  return { info, error, loading, reload };
}

// ---------------------------------------------------------------------------
// Balances on the paying networks, over their public endpoints. Read only
// while something on screen shows them; cached per account and network.
// ---------------------------------------------------------------------------

const BALANCE_TTL_MS = 30_000;
const balanceCache = new Map<string, PayBalances>();

export function usePayBalances(
  owner: string | null,
  chains: readonly PayChainKey[],
  active: boolean,
): { balances: Partial<Record<PayChainKey, PayBalances>>; refresh: () => void } {
  const [balances, setBalances] = useState<Partial<Record<PayChainKey, PayBalances>>>({});
  const [nonce, setNonce] = useState(0);
  const key = chains.join(',');

  useEffect(() => {
    if (!active || !owner) {
      setBalances({});
      return;
    }
    let alive = true;
    const who = owner.toLowerCase();
    const fromCache = () => {
      const out: Partial<Record<PayChainKey, PayBalances>> = {};
      for (const k of chains) {
        const hit = balanceCache.get(`${who}:${k}`);
        if (hit) out[k] = hit;
      }
      return out;
    };
    setBalances(fromCache());
    const load = async (force: boolean) => {
      await Promise.all(
        chains.map(async (k) => {
          const c = payChain(k);
          const hit = balanceCache.get(`${who}:${k}`);
          if (!c || (!force && hit && Date.now() - hit.at < BALANCE_TTL_MS)) return;
          try {
            const b = await readPayBalances(c, owner);
            balanceCache.set(`${who}:${k}`, b);
            if (alive) setBalances((prev) => ({ ...prev, [k]: b }));
          } catch {
            /* unreadable: shown as not read, never as zero */
          }
        }),
      );
    };
    void load(nonce > 0);
    const id = setInterval(() => void load(false), BALANCE_TTL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // chains is keyed by `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, key, active, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { balances, refresh };
}

// ---------------------------------------------------------------------------
// Open quotes, kept in this browser so a reload does not lose a payment in
// flight, and followed at the pay-in until each is finished.
// ---------------------------------------------------------------------------

function readStore(): PayStore {
  try {
    return parseStore(window.localStorage.getItem(PAY_STORE_KEY), Date.now());
  } catch {
    return { active: null, tracks: [] };
  }
}

function writeStore(s: PayStore): void {
  try {
    window.localStorage.setItem(PAY_STORE_KEY, serializeStore(s));
  } catch {
    /* private mode or full storage: the page still works, it just forgets on reload */
  }
}

/** Two copies of one track (this tab and another): keep whichever knows more, and any send either one recorded. */
function mergeTrack(a: PayTrack, b: PayTrack): PayTrack {
  const rank = (t: PayTrack) => ({ quoted: 0, superseded: 0, expired: 0, seen: 1, confirmed: 2, paid: 3, failed: 3 })[t.status];
  const base = rank(b) > rank(a) || (rank(b) === rank(a) && (b.checkedAt ?? 0) > (a.checkedAt ?? 0)) ? b : a;
  return {
    ...base,
    sentTx: a.sentTx ?? b.sentTx,
    sentAt: a.sentAt ?? b.sentAt,
    sendingAt: a.sentTx ?? b.sentTx ? null : (a.sendingAt ?? b.sendingAt),
    confirmations: Math.max(a.confirmations, b.confirmations),
    depositTx: base.depositTx ?? a.depositTx ?? b.depositTx,
    fmxTx: base.fmxTx ?? a.fmxTx ?? b.fmxTx,
  };
}

export interface PayTracksState {
  tracks: PayTrack[];
  active: PayTrack | null;
  setActive: (quoteId: string | null) => void;
  put: (track: PayTrack) => void;
  update: (quoteId: string, fn: (t: PayTrack) => PayTrack) => void;
  remove: (quoteId: string) => void;
  clearFinished: () => void;
  /** Read one quote's status now. */
  pollNow: (quoteId: string) => void;
}

export function usePayTracks(): PayTracksState {
  const [store, setStore] = useState<PayStore>(readStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const commit = useCallback((fn: (s: PayStore) => PayStore) => {
    setStore((prev) => {
      const next = fn(prev);
      if (next !== prev) writeStore(next);
      return next;
    });
  }, []);

  // Another tab paid or advanced a quote: take what it knows.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PAY_STORE_KEY) return;
      const other = parseStore(e.newValue, Date.now());
      setStore((prev) => {
        let tracks = prev.tracks;
        for (const t of other.tracks) {
          const mine = tracks.find((x) => x.quote.quoteId === t.quote.quoteId);
          tracks = mine ? tracks.map((x) => (x === mine ? mergeTrack(mine, t) : x)) : upsertTrack({ active: null, tracks }, t).tracks;
        }
        return { ...prev, tracks };
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setActive = useCallback((quoteId: string | null) => commit((s) => (s.active === quoteId ? s : { ...s, active: quoteId })), [commit]);
  const put = useCallback((t: PayTrack) => commit((s) => upsertTrack(s, t)), [commit]);
  const update = useCallback(
    (quoteId: string, fn: (t: PayTrack) => PayTrack) =>
      commit((s) => {
        const t = s.tracks.find((x) => x.quote.quoteId === quoteId);
        if (!t) return s;
        const next = fn(t);
        return next === t ? s : { ...s, tracks: s.tracks.map((x) => (x === t ? next : x)) };
      }),
    [commit],
  );
  const remove = useCallback(
    (quoteId: string) =>
      commit((s) => ({ active: s.active === quoteId ? null : s.active, tracks: s.tracks.filter((x) => x.quote.quoteId !== quoteId) })),
    [commit],
  );
  const clearFinished = useCallback(() => {
    const now = Date.now();
    commit((s) => {
      const tracks = s.tracks.filter((x) => !isFinished(x, now));
      return { active: tracks.some((x) => x.quote.quoteId === s.active) ? s.active : null, tracks };
    });
  }, [commit]);

  // ---- following each open quote --------------------------------------------
  const inflight = useRef(new Set<string>());
  const poll = useCallback(
    async (quoteId: string) => {
      if (inflight.current.has(quoteId)) return;
      inflight.current.add(quoteId);
      try {
        const raw = await fetchPayStatus(PAYIN_API_URL, quoteId);
        update(quoteId, (t) => {
          try {
            return applyStatus(t, raw, Date.now());
          } catch (err) {
            return { ...t, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() };
          }
        });
      } catch (err) {
        if (err instanceof PayApiError && err.status === 404) {
          update(quoteId, (t) => ({ ...t, error: 'The pay-in has no record of this quote.', checkedAt: Date.now() }));
        }
        /* otherwise: offline for a moment, the next tick tries again */
      } finally {
        inflight.current.delete(quoteId);
      }
    },
    [update],
  );

  const open = store.tracks.filter((t) => shouldPoll(t, Date.now())).map((t) => t.quote.quoteId);
  const openKey = open.join(',');
  useEffect(() => {
    if (!openKey) return;
    const ids = openKey.split(',');
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      for (const id of ids) void poll(id);
    };
    tick();
    const timer = setInterval(tick, PAYIN_POLL_MS);
    return () => clearInterval(timer);
  }, [openKey, poll]);

  const pollNow = useCallback((quoteId: string) => void poll(quoteId), [poll]);
  const active = store.tracks.find((t) => t.quote.quoteId === store.active) ?? null;
  return { tracks: store.tracks, active, setActive, put, update, remove, clearFinished, pollNow };
}
