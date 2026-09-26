// One connection manager for every Ferminux dApp's "Connect wallet" button.
//
// The choice, in this order:
//   1. Ferminux Wallet — the web wallet in a popup; always available, no extension.
//   2. Every injected wallet the page can find (EIP-6963, then window.ethereum).
//   3. WalletConnect — only when the dApp was built with a project id; the
//      dApp owns that dependency and hands over a loader, so a build without
//      it never bundles (or contacts) the WalletConnect relay.
//
// The chosen wallet is remembered, and restore() reconnects to it on the next
// visit without a prompt (eth_accounts only). Rendering the choice is left to
// each dApp so it matches that surface's design system.

import { FERMINUX_CHAIN_ID, KNOWN_CHAIN_IDS, parseChainId } from './chains.ts';
import { FERMINUX_RPC_URL, sessionHasChain } from './network.ts';
import { ERR, ProviderRpcError } from './errors.ts';
import { FERMINUX_WALLET_ICON } from './icon.ts';
import {
  FERMINUX_WALLET_NAME,
  FERMINUX_WALLET_RDNS,
  announceFerminuxWallet,
  createFerminuxWalletProvider,
  type FerminuxWalletProvider,
} from './provider.ts';
import { LEGACY_RDNS, watchInjectedWallets, type Eip1193Provider, type InjectedWallet } from './discovery.ts';

export type { Eip1193Provider } from './discovery.ts';

export type WalletKind = 'ferminux' | 'injected' | 'walletconnect';

export interface WalletChoice {
  /** 'ferminux' | 'eip6963:<rdns>' | 'walletconnect' */
  id: string;
  kind: WalletKind;
  name: string;
  /** A data: URI, or '' when the wallet gave none (never a remote URL). */
  icon: string;
  /** One line for the picker. */
  detail: string;
  /** The wallet this network recommends: pickers show it first and marked. */
  featured?: boolean;
}

interface WalletConnectProvider extends Eip1193Provider {
  connect?(opts?: unknown): Promise<unknown>;
  enable?(): Promise<unknown>;
  disconnect?(): Promise<void>;
  session?: unknown;
  accounts?: string[];
}

/** The part of @walletconnect/ethereum-provider this file uses. */
export interface WalletConnectModule {
  EthereumProvider: { init(opts: Record<string, unknown>): Promise<WalletConnectProvider> };
}

export interface WalletConnectOptions {
  /** A Reown (cloud.reown.com) project id. */
  projectId: string;
  /**
   * () => import('@walletconnect/ethereum-provider'). Typed loosely so this
   * shared file does not depend on the package's types; the shape is checked
   * when it loads.
   */
  load: () => Promise<unknown>;
  metadata?: { name: string; description: string; url: string; icons: string[] };
  /** Read endpoint per chain for the WalletConnect provider (defaults to the first of `rpcUrls`). */
  rpcMap?: Record<number, string>;
}

/**
 * Wallets shown first in the WalletConnect modal, by their WalletConnect
 * Explorer id (checked against explorer-api.walletconnect.com on 2026-09-26):
 * the ones people most often hold on a phone. Every other wallet in the
 * Explorer is one search away under "All wallets".
 */
export const FEATURED_WALLETCONNECT_WALLETS: readonly string[] = [
  'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask
  '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0', // Trust Wallet
  '971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709', // OKX Wallet
  '8a0ee50d1f22f6651afcae7eb4253e52a3310b90af5daef78a8c4929a9bb99d4', // Binance Wallet
  '38f5d18bd8522c244bdd70cb4a68e0e718865155811c043f052fb9f1c51de662', // Bitget Wallet
  '0b415a746fb9ee99cce155c2ceca0c6f6061b1dbca2d722b3ba16381d0562150', // SafePal
  'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Coinbase Wallet (Base app)
  '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // Rainbow
  'ecc4036f814562b41a5268adc86270fba1365471402006302e70169465b7ac18', // Zerion
];

/** The mark every Ferminux dApp shows a wallet as its own icon (WalletConnect metadata). */
export const FERMINUX_APP_ICON_URL = 'https://ferminux.net/assets/brand/icon-512.png';

/** The WalletConnect glyph for the picker row, inline so it costs no request. */
const WALLETCONNECT_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 89 89"><rect width="89" height="89" rx="20" fill="#3396FF"/>' +
      '<path fill="#fff" d="M60.05 39.25l5.86-5.86c-13.26-13.26-29.73-13.26-42.98 0l5.86 5.86c10.08-10.08 21.18-10.08 31.26 0zM58.09 52.91L44.42 39.24 30.74 52.91 17.06 39.24l-5.86 5.86 19.54 19.54 13.68-13.68 13.68 13.68 19.54-19.54-5.86-5.86z"/></svg>',
  );

export interface ConnectorOptions {
  appName: string;
  /** The wallet's connect page(s): see FerminuxWalletProviderOptions.walletUrl. Default: both official origins. */
  walletUrl?: string | readonly string[];
  /** Read endpoints per chain for the Ferminux Wallet provider (3961 defaults to the Ferminux RPC). */
  rpcUrls?: Record<number, readonly string[]>;
  /** The dApp's home chain (3961). */
  chainId?: number;
  walletConnect?: WalletConnectOptions | null;
  /** Palette of the Ferminux Wallet "pop-up blocked" prompt. */
  theme?: 'light' | 'dark';
}

export interface Connection {
  choice: WalletChoice;
  provider: Eip1193Provider;
  accounts: string[];
  chainId: number;
}

export interface WalletConnector {
  /** The Ferminux Wallet provider (also announced on the page under EIP-6963). */
  readonly ferminux: FerminuxWalletProvider;
  choices(): WalletChoice[];
  current(): Connection | null;
  /** Called when the choices or the connection change. */
  subscribe(listener: () => void): () => void;
  /**
   * Connect with one choice. Call it straight from the click handler: the
   * Ferminux Wallet window is opened synchronously on the way in, and a
   * browser only allows that inside the click.
   */
  connect(id: string): Promise<Connection>;
  /** Reconnect silently to the remembered wallet; null when there is nothing to restore. */
  restore(): Promise<Connection | null>;
  disconnect(): Promise<void>;
}

const CHOICE_KEY = 'ferminux.wallet-choice.v1';
const RESTORE_WAIT_MS = 1500;

function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* best-effort */
  }
}

/** Only inline images are shown: a remote icon URL would be a request to a stranger's server. */
export function safeIcon(icon: string | undefined): string {
  return typeof icon === 'string' && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(icon) ? icon : '';
}

async function readAccounts(provider: Eip1193Provider, method: 'eth_accounts' | 'eth_requestAccounts'): Promise<string[]> {
  const res = await provider.request({ method });
  return Array.isArray(res) ? res.filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) : [];
}

async function readChainId(provider: Eip1193Provider): Promise<number> {
  try {
    return parseChainId(await provider.request({ method: 'eth_chainId' })) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * What EthereumProvider.init receives. Exported for the tests: this is the
 * whole contract with the wallets on the other end.
 *
 * Every chain is OPTIONAL, none required. A wallet refuses the entire session
 * when a required chain is one it does not know (and almost none know 3961
 * yet), but it approves whichever optional chains it has; ensureFerminuxChain
 * (network.ts) then switches to 3961 or adds it. The read endpoint of each
 * chain the dApp configured goes into rpcMap, so reads never depend on a
 * wallet having the chain.
 */
export function walletConnectInitOptions(
  opts: Pick<ConnectorOptions, 'appName' | 'rpcUrls' | 'theme'>,
  wc: WalletConnectOptions,
  homeChain: number = FERMINUX_CHAIN_ID,
): Record<string, unknown> {
  const others = KNOWN_CHAIN_IDS.filter((c) => c !== homeChain);
  const rpcMap: Record<number, string> = { [FERMINUX_CHAIN_ID]: FERMINUX_RPC_URL };
  for (const [id, urls] of Object.entries(opts.rpcUrls ?? {})) {
    const first = urls?.[0];
    if (typeof first === 'string' && /^https?:\/\//.test(first)) rpcMap[Number(id)] = first;
  }
  Object.assign(rpcMap, wc.rpcMap ?? {});
  const origin = globalThis.location?.origin ?? '';
  const metadata = wc.metadata ?? { name: opts.appName, description: opts.appName, url: origin, icons: [] };
  return {
    projectId: wc.projectId,
    optionalChains: [homeChain, ...others],
    rpcMap,
    showQrModal: true,
    qrModalOptions: {
      themeMode: opts.theme === 'light' ? 'light' : 'dark',
      // Popular phone wallets first; the rest are under "All wallets".
      explorerRecommendedWalletIds: [...FEATURED_WALLETCONNECT_WALLETS],
      // Full screen on a phone: the wallet list is the page, each row a deep link.
      enableMobileFullScreen: true,
    },
    metadata: {
      ...metadata,
      // A wallet shows this next to "wants to connect"; an empty list is a blank square.
      icons: metadata.icons.length > 0 ? metadata.icons : [FERMINUX_APP_ICON_URL],
    },
    // The WalletConnect SDK batches usage events to pulse.walletconnect.org otherwise.
    telemetryEnabled: false,
  };
}

export function createWalletConnector(opts: ConnectorOptions): WalletConnector {
  const homeChain = opts.chainId ?? FERMINUX_CHAIN_ID;
  const ferminux = createFerminuxWalletProvider({
    walletUrl: opts.walletUrl,
    rpcUrls: opts.rpcUrls,
    appName: opts.appName,
    chainId: homeChain,
    theme: opts.theme,
  });
  announceFerminuxWallet(ferminux);

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* one subscriber's bug must not stop the others */
      }
    }
  };

  let injected: InjectedWallet[] = [];
  watchInjectedWallets((list) => {
    injected = list;
    notify();
  });

  const wc = opts.walletConnect && opts.walletConnect.projectId ? opts.walletConnect : null;
  let wcProvider: WalletConnectProvider | null = null;

  let conn: Connection | null = null;
  let detach: (() => void) | null = null;

  const FERMINUX_CHOICE: WalletChoice = {
    id: 'ferminux',
    kind: 'ferminux',
    name: FERMINUX_WALLET_NAME,
    icon: FERMINUX_WALLET_ICON,
    detail: 'Ferminux built in — nothing to install',
    featured: true,
  };
  const WC_CHOICE: WalletChoice = {
    id: 'walletconnect',
    kind: 'walletconnect',
    name: 'WalletConnect',
    icon: WALLETCONNECT_ICON,
    detail: 'MetaMask, Trust, OKX, Bitget and 500+ more',
  };

  const injectedChoice = (w: InjectedWallet): WalletChoice => ({
    id: `eip6963:${w.info.rdns}`,
    kind: 'injected',
    name: w.info.name,
    icon: safeIcon(w.info.icon),
    detail: w.info.rdns === LEGACY_RDNS ? 'Installed in this browser' : 'Browser extension',
  });

  const choices = (): WalletChoice[] => [FERMINUX_CHOICE, ...injected.map(injectedChoice), ...(wc ? [WC_CHOICE] : [])];

  function track(next: Connection | null) {
    detach?.();
    detach = null;
    conn = next;
    if (next) {
      safeSet(CHOICE_KEY, JSON.stringify({ id: next.choice.id }));
      const p = next.provider;
      const onAccounts = (accs: unknown) => {
        const list = Array.isArray(accs) ? accs.filter((a): a is string => typeof a === 'string') : [];
        if (!conn || conn.provider !== p) return;
        if (list.length === 0) {
          // WalletConnect announces [] whenever its default chain moves to one
          // the session has no account on yet (mid-switch, before the wallet's
          // session_update). The session is still there; its end arrives as
          // 'disconnect'.
          if (next.choice.kind === 'walletconnect') return;
          safeSet(CHOICE_KEY, null);
          track(null);
        } else {
          conn = { ...conn, accounts: list };
          notify();
        }
      };
      // WalletConnect: a wallet can report a chain before it has added it to
      // the session, or without ever adding it. The WalletConnect client
      // refuses requests on a chain the session does not name, so the dApp
      // keeps the chain it can use until a session_update names the new one.
      let pendingChain: number | null = null;
      const onChain = (hex: unknown) => {
        if (!conn || conn.provider !== p) return;
        const id = parseChainId(hex) ?? conn.chainId;
        if (next.choice.kind === 'walletconnect' && !sessionHasChain(p, id)) {
          pendingChain = id;
          return;
        }
        pendingChain = null;
        conn = { ...conn, chainId: id };
        notify();
      };
      const onSessionUpdate = () => {
        if (!conn || conn.provider !== p || pendingChain === null || !sessionHasChain(p, pendingChain)) return;
        conn = { ...conn, chainId: pendingChain };
        pendingChain = null;
        notify();
      };
      const onDisconnect = () => {
        if (!conn || conn.provider !== p) return;
        // Injected wallets fire 'disconnect' when one chain's RPC drops; they
        // are still connected. Only a real account loss ends the session.
        if (next.choice.kind === 'injected') return;
        safeSet(CHOICE_KEY, null);
        track(null);
      };
      p.on?.('accountsChanged', onAccounts);
      p.on?.('chainChanged', onChain);
      p.on?.('disconnect', onDisconnect);
      p.on?.('session_update', onSessionUpdate);
      detach = () => {
        p.removeListener?.('accountsChanged', onAccounts);
        p.removeListener?.('chainChanged', onChain);
        p.removeListener?.('disconnect', onDisconnect);
        p.removeListener?.('session_update', onSessionUpdate);
      };
    }
    notify();
  }

  async function walletConnectProvider(): Promise<WalletConnectProvider> {
    if (!wc) throw new ProviderRpcError(ERR.UNSUPPORTED_METHOD, 'WalletConnect is not configured on this site.');
    if (wcProvider) return wcProvider;
    const loaded = (await wc.load()) as Partial<WalletConnectModule> & { default?: Partial<WalletConnectModule> };
    const EthereumProvider = loaded.EthereumProvider ?? loaded.default?.EthereumProvider;
    if (typeof EthereumProvider?.init !== 'function') throw new ProviderRpcError(ERR.INTERNAL, 'WalletConnect failed to load.');
    wcProvider = await EthereumProvider.init(walletConnectInitOptions(opts, wc, homeChain));
    return wcProvider;
  }

  function findInjected(id: string): InjectedWallet | undefined {
    return injected.find((w) => `eip6963:${w.info.rdns}` === id);
  }

  async function connect(id: string): Promise<Connection> {
    if (id === 'ferminux') {
      // Synchronous first call: this is what opens the wallet window.
      const pending = ferminux.request({ method: 'eth_requestAccounts' });
      const accounts = (await pending) as string[];
      const next = { choice: FERMINUX_CHOICE, provider: ferminux, accounts, chainId: await readChainId(ferminux) };
      track(next);
      return next;
    }
    if (id === 'walletconnect') {
      const p = await walletConnectProvider();
      try {
        if (typeof p.connect === 'function') await p.connect();
        else await p.enable?.();
      } catch (e) {
        // Closing the QR modal surfaces as "Connection request reset".
        if (/reset|closed|abort/i.test(String((e as { message?: unknown })?.message ?? ''))) {
          throw new ProviderRpcError(ERR.USER_REJECTED, 'The WalletConnect window was closed before a wallet connected.');
        }
        throw e;
      }
      const accounts = await readAccounts(p, 'eth_accounts');
      if (accounts.length === 0) throw new ProviderRpcError(ERR.USER_REJECTED, 'WalletConnect returned no account.');
      const next = { choice: WC_CHOICE, provider: p as Eip1193Provider, accounts, chainId: await readChainId(p) };
      track(next);
      return next;
    }
    const w = findInjected(id);
    if (!w) throw new ProviderRpcError(ERR.DISCONNECTED, 'That wallet is no longer available in this browser.');
    const accounts = await readAccounts(w.provider, 'eth_requestAccounts');
    if (accounts.length === 0) throw new ProviderRpcError(ERR.USER_REJECTED, 'The wallet returned no account.');
    const next = { choice: injectedChoice(w), provider: w.provider, accounts, chainId: await readChainId(w.provider) };
    track(next);
    return next;
  }

  async function waitForInjected(id: string): Promise<InjectedWallet | undefined> {
    const until = Date.now() + RESTORE_WAIT_MS;
    let found = findInjected(id);
    while (!found && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      found = findInjected(id);
    }
    return found;
  }

  async function restore(): Promise<Connection | null> {
    if (conn) return conn;
    let remembered: { id?: unknown } | null = null;
    try {
      remembered = JSON.parse(safeGet(CHOICE_KEY) ?? 'null') as { id?: unknown } | null;
    } catch {
      remembered = null;
    }
    const id = typeof remembered?.id === 'string' ? remembered.id : null;
    if (!id) return null;
    try {
      if (id === 'ferminux') {
        const accounts = await readAccounts(ferminux, 'eth_accounts');
        if (accounts.length === 0) return null;
        const next = { choice: FERMINUX_CHOICE, provider: ferminux as Eip1193Provider, accounts, chainId: await readChainId(ferminux) };
        track(next);
        return next;
      }
      if (id === 'walletconnect') {
        if (!wc) return null;
        const p = await walletConnectProvider();
        if (!p.session) return null;
        const accounts = await readAccounts(p, 'eth_accounts');
        if (accounts.length === 0) return null;
        const next = { choice: WC_CHOICE, provider: p as Eip1193Provider, accounts, chainId: await readChainId(p) };
        track(next);
        return next;
      }
      const w = await waitForInjected(id);
      if (!w) return null;
      const accounts = await readAccounts(w.provider, 'eth_accounts');
      if (accounts.length === 0) return null;
      const next = { choice: injectedChoice(w), provider: w.provider, accounts, chainId: await readChainId(w.provider) };
      track(next);
      return next;
    } catch {
      return null;
    }
  }

  async function disconnect(): Promise<void> {
    const c = conn;
    safeSet(CHOICE_KEY, null);
    track(null);
    if (!c) return;
    try {
      if (c.choice.kind === 'ferminux') await ferminux.disconnect();
      else if (c.choice.kind === 'walletconnect') await (c.provider as WalletConnectProvider).disconnect?.();
      else await c.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    } catch {
      /* wallets without revokePermissions just stay authorised in the wallet */
    }
  }

  return {
    ferminux,
    choices,
    current: () => conn,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect,
    restore,
    disconnect,
  };
}

export { FERMINUX_WALLET_NAME, FERMINUX_WALLET_RDNS, FERMINUX_WALLET_ICON };
