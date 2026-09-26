// WalletConnect v2 (Reown WalletKit), wallet side.
//
// The SDK is loaded on demand — only when the user pairs a site, or on unlock
// when this device already has sessions — so a wallet that never uses
// WalletConnect never opens a connection to the relay. One client per page:
// it outlives lock/unlock (it holds no wallet key; requests that arrive while
// locked wait in the queue and are shown after unlocking).
//
// Its sessions name the connected address, so they follow the vault's
// "remember on this device": a wallet that is not remembered keeps them in
// memory only, and locking (or forgetting) it ends every session and deletes
// whatever WalletConnect had stored in IndexedDB (forgetWalletConnect).

import { useCallback, useEffect, useState } from 'react';
import { WC_PROJECT_ID, WC_TEST_KIT } from '../config.ts';
import { WcController, type KitLike, type WcState } from '../lib/wcController.ts';
import { markWcUsed, wcWasUsed } from './storage.ts';
import { wcMetadataOverrides } from '../platform/index.ts';

/** WalletConnect's own IndexedDB store (@walletconnect/keyvaluestorage). */
const WC_IDB = 'WALLET_CONNECT_V2_INDEXED_DB';
const WC_IDB_STORE = 'keyvaluestorage';
/** Storage prefix of an in-memory client: its own global-core slot, never the stored client's. */
const WC_MEMORY_PREFIX = 'fxw-memory';

export type WcStatus = 'off' | 'starting' | 'ready' | 'error';

export interface WalletConnectApi {
  /** A project id was configured at build time. */
  configured: boolean;
  status: WcStatus;
  error: string | null;
  state: WcState;
  start: () => Promise<WcController | null>;
  controller: WcController | null;
}

const EMPTY: WcState = { sessions: [], proposals: [], requests: [], notice: null };

let controller: WcController | null = null;
let starting: Promise<WcController> | null = null;
let kitRef: KitLike | null = null;
let currentAddress: string | null = null;
/** The vault is stored on this device: WalletConnect may store its sessions too. */
let remembered = false;
const listeners = new Set<(s: WcState) => void>();
let lastState: WcState = EMPTY;

/** A key-value store in this page's memory (the SDK's IKeyValueStorage): gone with the tab. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getKeys: async () => [...m.keys()],
    getEntries: async <T,>() => [...m.entries()].map(([k, v]) => [k, JSON.parse(v)] as [string, T]),
    getItem: async <T,>(key: string) => (m.has(key) ? (JSON.parse(m.get(key)!) as T) : undefined),
    setItem: async <T,>(key: string, value: T) => void m.set(key, JSON.stringify(value)),
    removeItem: async (key: string) => void m.delete(key),
  };
}

async function createKit(projectId: string, persist: boolean): Promise<KitLike> {
  if (WC_TEST_KIT) {
    const make = (window as { __ferminuxWcTestKit?: () => KitLike }).__ferminuxWcTestKit;
    if (make) return make();
  }
  const [{ Core }, { WalletKit }] = await Promise.all([import('@walletconnect/core'), import('@reown/walletkit')]);
  // Telemetry off: the SDK otherwise batches usage events to pulse.walletconnect.org.
  // Not remembered: sessions live in memory only (they name the address).
  const core = new Core({
    projectId,
    telemetryEnabled: false,
    ...(persist ? {} : { storage: memoryStorage() as never, customStoragePrefix: WC_MEMORY_PREFIX }),
  });
  // telemetryEnabled only stops the batched events: WalletKit.init still calls
  // core.eventClient.init(), which POSTs one INIT event (client id + user
  // agent) to pulse.walletconnect.org regardless. The wallet's CSP does not
  // allow that host (infra/compose/nginx/nginx.conf), so the request would
  // only be refused with a console error on every pairing. Skip it here.
  const events = (core as unknown as { eventClient?: { init?: () => Promise<void> } }).eventClient;
  if (events) events.init = async () => undefined;
  const icon = new URL('favicon.svg', window.location.href).toString();
  const kit = await WalletKit.init({
    core,
    metadata: {
      name: 'Ferminux Wallet',
      description: 'Self-custody wallet for Ferminux and seven other networks.',
      url: window.location.origin,
      icons: [icon],
      // The app's page origin (https://localhost) means nothing to a dApp: name the public wallet and its links.
      ...wcMetadataOverrides(),
    },
  });
  return kit as unknown as KitLike;
}

function startController(): Promise<WcController> {
  if (controller) return Promise.resolve(controller);
  if (!starting) {
    starting = createKit(WC_PROJECT_ID, remembered).then(
      (kit) => {
        const c = new WcController(kit, {
          getAddress: () => currentAddress,
          onChange: (s) => {
            lastState = s;
            for (const l of listeners) l(s);
          },
          // "reconnect on the next unlock" only means something for a stored wallet
          onUsed: (used) => markWcUsed(used && remembered),
        });
        kitRef = kit;
        controller = c;
        c.start();
        return c;
      },
      (e: unknown) => {
        starting = null;
        throw e;
      },
    );
  }
  return starting;
}

/**
 * The wallet was locked with "remember" off, or forgotten: end every
 * WalletConnect session (each site is told), close the client, and delete
 * what the SDK stored in IndexedDB — sessions, pairings, keys and the request
 * history, all of which name the address. The next pairing starts a new client.
 */
export async function forgetWalletConnect(): Promise<void> {
  const c = controller ?? (starting ? await starting.catch(() => null) : null);
  const kit = kitRef;
  controller = null;
  starting = null;
  kitRef = null;
  currentAddress = null;
  lastState = EMPTY;
  for (const l of listeners) l(EMPTY);
  markWcUsed(false);
  if (c) await c.disconnectAll().catch(() => undefined);
  const core = (kit as { core?: { heartbeat?: { stop?: () => void }; relayer?: { transportClose?: () => Promise<void> } } } | null)?.core;
  try {
    core?.heartbeat?.stop?.();
    await core?.relayer?.transportClose?.();
  } catch {
    /* already closed */
  }
  // The SDK parks its client on globalThis and hands it back to the next `new Core()`:
  // drop it, so the next client starts from the (now empty) store, not from memory.
  for (const k of Object.keys(globalThis)) if (k.startsWith('_walletConnectCore_')) delete (globalThis as Record<string, unknown>)[k];
  // disconnectAll reported its (empty) state through the old client: settle on EMPTY
  lastState = EMPTY;
  for (const l of listeners) l(EMPTY);
  await clearWcStore();
}

/** Empty WalletConnect's IndexedDB store, then ask for the database to be deleted. */
async function clearWcStore(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null;
    if (dbs && !dbs.some((d) => d.name === WC_IDB)) return;
  } catch {
    /* cannot list: open it and see */
  }
  // Clear first: a client that still holds a connection blocks deleteDatabase
  // until the page unloads, and an open request queued behind that would hang.
  await new Promise<void>((resolve) => {
    const open = indexedDB.open(WC_IDB);
    open.onerror = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(WC_IDB_STORE)) {
        db.close();
        return resolve();
      }
      const tx = db.transaction(WC_IDB_STORE, 'readwrite');
      tx.objectStore(WC_IDB_STORE).clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => {
        db.close();
        resolve();
      };
    };
  });
  try {
    indexedDB.deleteDatabase(WC_IDB); // completes now, or once the old client's connection closes
  } catch {
    /* the store is already empty */
  }
}

export function useWalletConnect(address: string | null, isRemembered = false): WalletConnectApi {
  const configured = WC_PROJECT_ID !== '' || WC_TEST_KIT;
  const [state, setState] = useState<WcState>(lastState);
  const [status, setStatus] = useState<WcStatus>(controller ? 'ready' : 'off');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const start = useCallback(async (): Promise<WcController | null> => {
    if (!configured) return null;
    if (controller) return controller;
    setStatus('starting');
    setError(null);
    try {
      const c = await startController();
      setStatus('ready');
      setState(c.state());
      return c;
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [configured]);

  // read by startController when a client is created (pairing, or unlock with saved sessions)
  remembered = isRemembered;

  // The address the controller answers for follows the active account (null
  // while locked). Sessions are NOT moved to it: each keeps the account it was
  // approved for (WcController.syncAccount).
  useEffect(() => {
    currentAddress = address;
    if (!controller) return;
    if (address) void controller.syncAccount(address);
    else setState(controller.state());
  }, [address]);

  // Reconnect saved sessions after unlock on a device that has used WalletConnect.
  useEffect(() => {
    if (address && configured && !controller && isRemembered && wcWasUsed()) void start();
  }, [address, configured, start, isRemembered]);

  // A forget from outside the hook (forgetWalletConnect) leaves no client to report on.
  useEffect(() => {
    const onEmpty = (s: WcState) => {
      if (s === EMPTY && !controller) setStatus('off');
    };
    listeners.add(onEmpty);
    return () => {
      listeners.delete(onEmpty);
    };
  }, []);

  return { configured, status, error, state, start, controller };
}
