// "Connect with Ferminux Wallet": an EIP-1193 provider for any dApp, backed by
// the Ferminux web wallet (wallet-web/connect.html) in a popup — a new tab on
// phones — instead of a browser extension.
//
//   • Signing, sending, connecting and adding tokens open the wallet window,
//     which shows the requesting origin and asks the user. The key never
//     leaves the wallet's origin; the dApp gets back an address, a signature
//     or a transaction hash.
//   • Reads (eth_call, eth_getBalance, eth_getLogs, …) go straight to the
//     chain's RPC from this page. The popup is never involved.
//   • eth_accounts / eth_chainId / wallet_switchEthereumChain are answered
//     here from the remembered session: the chain travels with every request
//     and the wallet signs for exactly that chain (after checking it is one it
//     knows), so switching needs no window.
//
// The connection is remembered in localStorage. On a later visit the provider
// reconnects silently, and — when the dApp shares the wallet's site, as every
// *.ferminux.net app does — asks an invisible frame of the wallet page whether
// the wallet still approves this origin, so a revoke in the wallet
// disconnects the dApp on its next load (or live, while both are open).
//
// One wallet, two origins: the same wallet build is served at
// https://wallet.ferminux.net and https://ferminux.net/wallet/, and a browser
// keeps a vault at the origin where it was created. The provider accepts the
// wallet window from either (exact origins, and only the window it opened),
// the window can send itself to the other one when it finds no vault there,
// and the origin that connected is remembered and opened first next time.
//
// Framework-free: no dependencies, only DOM APIs (injectable for tests).

import { FERMINUX_CHAIN_ID, isKnownChain, parseChainId, toHexChainId } from './chains.ts';
import { ERR, ProviderRpcError, fromRpcError } from './errors.ts';
import { FERMINUX_WALLET_ICON } from './icon.ts';
import {
  FRAME_HASH,
  PROTOCOL,
  READ_METHODS,
  REVOKE_METHOD,
  describeMethod,
  newRequestId,
  parseWalletMessage,
  type RequestMessage,
  type StatusMessage,
} from './protocol.ts';

export const DEFAULT_WALLET_URL = 'https://wallet.ferminux.net/connect.html';
/** The official wallet at both of its origins (one build): the first opens by default. */
export const OFFICIAL_WALLET_URLS: readonly string[] = [DEFAULT_WALLET_URL, 'https://ferminux.net/wallet/connect.html'];
export const FERMINUX_WALLET_RDNS = 'net.ferminux.wallet';
export const FERMINUX_WALLET_NAME = 'Ferminux Wallet';

/** Ferminux's own endpoints only — a dApp that reads another chain passes its RPC in `rpcUrls`. */
const DEFAULT_RPC_URLS: Record<number, string[]> = {
  [FERMINUX_CHAIN_ID]: ['https://rpc.ferminux.net', 'https://ferminux.net/rpc'],
};

const POPUP_NAME = 'ferminux-wallet';
const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 720;
/** A response posted right before the window closed may still be queued; wait this long before calling it a rejection. */
const CLOSE_GRACE_MS = 700;
const FRAME_TIMEOUT_MS = 8000;
const SESSION_PREFIX = 'ferminux.fxwallet.session.v1|';
/** Which of the wallet's origins this dApp last connected through (its connect URL). */
const WALLET_PICK_PREFIX = 'ferminux.fxwallet.wallet.v1|';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface RequestArguments {
  method: string;
  params?: readonly unknown[] | object;
}

type Listener = (...args: any[]) => void;

export interface FerminuxWalletProviderOptions {
  /**
   * The wallet's connect page, or the same wallet at several origins (an array,
   * or a comma-separated string): the first opens by default, the one that last
   * connected opens first after that. Only these exact origins are listened to.
   * Default: both official origins. One official URL brings the other with it.
   */
  walletUrl?: string | readonly string[];
  /** Read endpoints per chain id. A plain array means chain 3961. Defaults to the Ferminux RPCs. */
  rpcUrls?: Record<number, readonly string[]> | readonly string[];
  /** Shown in the wallet next to (never instead of) the verified origin. */
  appName?: string;
  /** Chain a fresh session starts on (default 3961). */
  chainId?: number;
  /** Ask a hidden frame of the wallet whether this site is still approved (default true). */
  statusFrame?: boolean;
  /** Palette of the "pop-up blocked" prompt, to match the host page. */
  theme?: 'light' | 'dark';
  /** Test seam: replace the browser globals. */
  env?: Partial<ProviderEnv>;
}

export interface FerminuxWalletProvider {
  readonly isFerminuxWallet: true;
  /** Origin of the wallet page this dApp uses now (the one that last connected, else the first). */
  readonly walletOrigin: string;
  /** Every origin the wallet may answer from; messages from any other origin are ignored. */
  readonly walletOrigins: readonly string[];
  request(args: RequestArguments): Promise<unknown>;
  on(event: string, listener: Listener): FerminuxWalletProvider;
  removeListener(event: string, listener: Listener): FerminuxWalletProvider;
  /** True while the dApp holds an approved account. */
  isConnected(): boolean;
  /** Forget this site locally (and in the wallet, when its status frame is reachable). */
  disconnect(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Environment (browser globals, injectable for the Node tests)        */
/* ------------------------------------------------------------------ */

export interface PopupLike {
  closed: boolean;
  postMessage(message: unknown, targetOrigin: string): void;
  focus?(): void;
}

export interface WindowLike {
  location: { origin: string };
  open(url: string, target?: string, features?: string): PopupLike | null;
  addEventListener(type: string, listener: (event: any) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  document?: Document;
  navigator?: { userAgent: string; maxTouchPoints?: number };
  screenX?: number;
  screenY?: number;
  outerWidth?: number;
  outerHeight?: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ProviderEnv {
  window: WindowLike;
  storage: StorageLike | null;
  fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

function defaultEnv(): ProviderEnv {
  const w = globalThis as unknown as WindowLike & { localStorage?: StorageLike; fetch: ProviderEnv['fetch'] };
  let storage: StorageLike | null = null;
  try {
    storage = w.localStorage ?? null;
  } catch {
    storage = null; // blocked storage (sandboxed frame, privacy mode)
  }
  return { window: w, storage, fetch: (input, init) => w.fetch(input, init) };
}

/** Phones get a tab, not a popup window: mobile browsers have no floating windows. */
export function isPhoneLike(nav: { userAgent: string; maxTouchPoints?: number } | undefined): boolean {
  if (!nav) return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return true;
  return /Macintosh/i.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

/* ------------------------------------------------------------------ */
/* Remembered session                                                  */
/* ------------------------------------------------------------------ */

interface Session {
  accounts: string[];
  chainId: number;
}

export function parseSession(raw: string | null, fallbackChain: number): Session | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { accounts?: unknown; chainId?: unknown };
    const accounts = Array.isArray(o.accounts) ? o.accounts.filter((a): a is string => typeof a === 'string' && ADDRESS_RE.test(a)) : [];
    const chainId = typeof o.chainId === 'number' && isKnownChain(o.chainId) ? o.chainId : fallbackChain;
    return accounts.length > 0 ? { accounts, chainId } : null;
  } catch {
    return null;
  }
}

/**
 * The wallet's connect pages, one per origin (a message carries only its
 * origin, so two pages on one origin could not be told apart).
 */
export function resolveWalletUrls(opt: string | readonly string[] | undefined): URL[] {
  const raw = opt === undefined ? OFFICIAL_WALLET_URLS : typeof opt === 'string' ? opt.split(',') : opt;
  let list = raw.map((x) => x.trim()).filter(Boolean);
  if (list.length === 0) list = [...OFFICIAL_WALLET_URLS];
  if (list.length === 1 && OFFICIAL_WALLET_URLS.includes(list[0]!)) list = [list[0]!, ...OFFICIAL_WALLET_URLS.filter((u) => u !== list[0])];
  const out: URL[] = [];
  for (const href of list) {
    const u = new URL(href);
    u.hash = '';
    if (!out.some((x) => x.origin === u.origin)) out.push(u);
  }
  return out;
}

function sameAccounts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i]!.toLowerCase());
}

function asArray(params: unknown): unknown[] {
  if (Array.isArray(params)) return params;
  return params === undefined || params === null ? [] : [params];
}

/** Params must survive postMessage and JSON: a BigInt or a function is a caller bug, not something to half-send. */
function plainParams(params: unknown): unknown {
  try {
    return params === undefined ? [] : JSON.parse(JSON.stringify(params));
  } catch {
    throw new ProviderRpcError(ERR.INVALID_PARAMS, 'Request params must be plain JSON (hex strings, not BigInt).');
  }
}

interface Pending {
  msg: RequestMessage;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  sent: boolean;
  acked: boolean;
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

class FerminuxWalletProviderImpl implements FerminuxWalletProvider {
  readonly isFerminuxWallet = true as const;
  readonly walletOrigins: readonly string[];

  private readonly env: ProviderEnv;
  private readonly wallets: URL[];
  /** The wallet page this dApp uses: the one that last connected, else the first. */
  private walletUrl: URL;
  private readonly pickKey: string;
  private readonly appName: string;
  private readonly defaultChain: number;
  private readonly theme: 'light' | 'dark';
  private readonly useFrame: boolean;
  private readonly sessionKey: string;
  private readonly rpcUrls = new Map<number, string[]>();
  private readonly rpcPick = new Map<number, number>();
  private rpcSeq = 0;

  private accounts: string[] = [];
  private chainId: number;
  private readonly listeners = new Map<string, Set<Listener>>();

  private popup: PopupLike | null = null;
  private popupReady = false;
  /** The origin the popup's current page said `ready` from: it may move to the wallet's other origin. */
  private popupOrigin: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private connecting: Promise<string[]> | null = null;
  private watchId: unknown = null;
  private closedSince = 0;
  private blocked: HTMLElement | null = null;

  private frame: HTMLIFrameElement | null = null;
  private frameOrigin = '';
  private frameTimer: unknown = null;
  private frameAnswered = false;
  /** What the frame said about itself: true = it reads the wallet's own storage; null = no answer yet. */
  private frameAuthoritative: boolean | null = null;
  /** A frame kept alive after disconnect() until it confirms the wallet forgot this site. */
  private forgetting: HTMLIFrameElement | null = null;
  private forgettingOrigin = '';

  constructor(opts: FerminuxWalletProviderOptions) {
    const base = defaultEnv();
    this.env = { ...base, ...opts.env } as ProviderEnv;
    this.wallets = resolveWalletUrls(opts.walletUrl);
    this.walletOrigins = Object.freeze(this.wallets.map((u) => u.origin));
    // Keyed by the first wallet origin, as before there were two: a session remembered then still loads.
    this.sessionKey = SESSION_PREFIX + this.wallets[0]!.origin;
    this.pickKey = WALLET_PICK_PREFIX + this.wallets[0]!.origin;
    let picked: string | null = null;
    try {
      picked = this.env.storage?.getItem(this.pickKey) ?? null;
    } catch {
      picked = null;
    }
    this.walletUrl = this.wallets.find((u) => u.href === picked) ?? this.wallets[0]!;
    this.appName = (opts.appName ?? '').slice(0, 60);
    this.defaultChain = opts.chainId !== undefined && isKnownChain(opts.chainId) ? opts.chainId : FERMINUX_CHAIN_ID;
    this.theme = opts.theme === 'dark' ? 'dark' : 'light';
    this.useFrame = opts.statusFrame !== false;
    this.chainId = this.defaultChain;

    for (const [id, urls] of Object.entries(DEFAULT_RPC_URLS)) this.rpcUrls.set(Number(id), [...urls]);
    if (Array.isArray(opts.rpcUrls)) {
      if (opts.rpcUrls.length > 0) this.rpcUrls.set(FERMINUX_CHAIN_ID, [...opts.rpcUrls]);
    } else if (opts.rpcUrls) {
      for (const [id, urls] of Object.entries(opts.rpcUrls as Record<string, readonly string[]>)) {
        if (Array.isArray(urls) && urls.length > 0) this.rpcUrls.set(Number(id), [...urls]);
      }
    }

    const saved = parseSession(this.readStorage(), this.defaultChain);
    if (saved) {
      this.accounts = saved.accounts;
      this.chainId = saved.chainId;
    }

    this.env.window.addEventListener('message', this.onMessage);
    this.env.window.addEventListener('storage', this.onStorage);
    if (this.accounts.length > 0) this.startFrame();
  }

  get walletOrigin(): string {
    return this.walletUrl.origin;
  }

  /** Use (and remember) the wallet page at `origin`: the one that just connected this site. */
  private pickWallet(origin: string): void {
    const u = this.wallets.find((x) => x.origin === origin);
    if (!u) return;
    try {
      this.env.storage?.setItem(this.pickKey, u.href);
    } catch {
      /* remembering is best-effort */
    }
    if (u.href === this.walletUrl.href) return;
    this.walletUrl = u;
    // The status frame reads one origin's storage: follow the wallet to its new one.
    if (this.frame) {
      this.stopFrame();
      this.startFrame();
    }
  }

  /* ---------------- EIP-1193 surface ---------------- */

  isConnected(): boolean {
    return this.accounts.length > 0;
  }

  on(event: string, listener: Listener): FerminuxWalletProvider {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): FerminuxWalletProvider {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) {
      try {
        l(...args);
      } catch {
        /* a listener's bug must not break the provider */
      }
    }
  }

  // NOTE: no `await` may run before callWallet() in the popup paths below.
  // window.open only succeeds inside the click that asked for it, so the
  // window has to be opened synchronously on the way in.
  request(args: RequestArguments): Promise<unknown> {
    try {
      return this.route(args);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private route(args: RequestArguments): Promise<unknown> {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string') {
      throw new ProviderRpcError(ERR.INVALID_PARAMS, 'request() takes { method, params }.');
    }
    const { method } = args;
    const params = args.params;
    switch (method) {
      case 'eth_accounts':
        return Promise.resolve([...this.accounts]);
      case 'eth_chainId':
        return Promise.resolve(toHexChainId(this.chainId));
      case 'net_version':
        return Promise.resolve(String(this.chainId));
      case 'eth_coinbase':
        return Promise.resolve(this.accounts[0] ?? null);
      case 'eth_requestAccounts':
        return this.requestAccounts();
      case 'wallet_requestPermissions':
        return this.requestAccounts().then(() => this.permissions());
      case 'wallet_getPermissions':
        return Promise.resolve(this.permissions());
      case 'wallet_revokePermissions':
        return this.disconnect().then(() => null);
      case 'wallet_switchEthereumChain':
        return Promise.resolve(this.switchChain(params));
      case 'wallet_addEthereumChain':
        return Promise.resolve(this.addChain(params));
      case 'personal_sign': {
        const p = asArray(params);
        // [message, address] (EIP-1474 order); a few old dApps send [address, message]. The address slot
        // is read first: a message that happens to be 20 bytes of hex must not be taken for the account.
        const isAddr = (x: unknown): x is string => typeof x === 'string' && ADDRESS_RE.test(x);
        this.requireAccount(isAddr(p[1]) ? p[1] : isAddr(p[0]) ? p[0] : undefined);
        return this.callWallet(method, p);
      }
      case 'eth_signTypedData_v4': {
        const p = asArray(params);
        this.requireAccount(p[0] as string | undefined);
        return this.callWallet(method, p);
      }
      case 'eth_sendTransaction': {
        const p = asArray(params);
        const tx = { ...((p[0] as Record<string, unknown>) ?? {}) };
        if (tx.from === undefined) tx.from = this.accounts[0];
        this.requireAccount(tx.from as string | undefined);
        if (tx.chainId !== undefined && parseChainId(tx.chainId) !== this.chainId) {
          throw new ProviderRpcError(
            ERR.INVALID_PARAMS,
            `The transaction names chain ${String(tx.chainId)} but the wallet is on ${this.chainId}. Switch chains first.`,
          );
        }
        return this.callWallet(method, [tx]);
      }
      case 'wallet_watchAsset':
        this.requireAccount(this.accounts[0]);
        return this.callWallet(method, params);
      case 'eth_sign':
      case 'eth_signTransaction':
      case 'eth_signTypedData':
      case 'eth_signTypedData_v1':
      case 'eth_signTypedData_v3':
        throw new ProviderRpcError(ERR.UNSUPPORTED_METHOD, `Ferminux Wallet does not support ${method}; use personal_sign or eth_signTypedData_v4.`);
      default:
        if (READ_METHODS.has(method)) return this.rpc(method, params);
        throw new ProviderRpcError(ERR.UNSUPPORTED_METHOD, `Ferminux Wallet does not support ${method}.`);
    }
  }

  private permissions(): unknown[] {
    return this.accounts.length > 0
      ? [{ parentCapability: 'eth_accounts', invoker: this.env.window.location.origin, caveats: [{ type: 'restrictReturnedAccounts', value: [...this.accounts] }] }]
      : [];
  }

  private requireAccount(address: string | undefined): void {
    if (this.accounts.length === 0) {
      throw new ProviderRpcError(ERR.UNAUTHORIZED, 'Connect Ferminux Wallet first (eth_requestAccounts).');
    }
    if (typeof address !== 'string' || !this.accounts.some((a) => a.toLowerCase() === address.toLowerCase())) {
      throw new ProviderRpcError(ERR.UNAUTHORIZED, 'That account is not connected to this site.');
    }
  }

  private requestAccounts(): Promise<string[]> {
    if (this.accounts.length > 0) return Promise.resolve([...this.accounts]);
    if (this.connecting) return this.connecting;
    const run = this.callWallet('eth_requestAccounts', []).then((result) => {
      const accounts = Array.isArray(result) ? result.filter((a): a is string => typeof a === 'string' && ADDRESS_RE.test(a)) : [];
      if (accounts.length === 0) throw new ProviderRpcError(ERR.USER_REJECTED, 'The wallet returned no account.');
      this.setAccounts(accounts);
      return [...accounts];
    });
    this.connecting = run;
    const clear = () => {
      if (this.connecting === run) this.connecting = null;
    };
    run.then(clear, clear);
    return run;
  }

  private switchChain(params: unknown): null {
    const first = asArray(params)[0] as { chainId?: unknown } | undefined;
    const target = parseChainId(first?.chainId);
    if (target === null) throw new ProviderRpcError(ERR.INVALID_PARAMS, 'wallet_switchEthereumChain needs { chainId: "0x…" }.');
    if (!isKnownChain(target)) {
      throw new ProviderRpcError(
        ERR.UNRECOGNIZED_CHAIN,
        `Ferminux Wallet does not support chain ${target}. It signs for Ferminux Network (3961) and the seven pay-in chains.`,
      );
    }
    this.setChain(target);
    return null;
  }

  private addChain(params: unknown): null {
    const first = asArray(params)[0] as { chainId?: unknown } | undefined;
    const target = parseChainId(first?.chainId);
    if (target === null) throw new ProviderRpcError(ERR.INVALID_PARAMS, 'wallet_addEthereumChain needs { chainId: "0x…", … }.');
    // Known chains are built in, with the wallet's own endpoints: the
    // dApp-supplied rpcUrls are ignored on purpose. Anything else is refused.
    if (!isKnownChain(target)) {
      throw new ProviderRpcError(
        ERR.INVALID_PARAMS,
        `Ferminux Wallet cannot add chain ${target}: it signs for Ferminux Network (3961) and the seven pay-in chains only.`,
      );
    }
    return null;
  }

  // NOTE: like request(), nothing may be awaited before the wallet window
  // opens: disconnect() is called from the "Disconnect" click.
  async disconnect(): Promise<void> {
    // The wallet must forget this site too, or the next connect is approved
    // without asking. Two ways to reach its storage:
    //   • the status frame, once it has said it reads the wallet's own
    //     storage (a dApp on the wallet's site). Hand it over before
    //     setAccounts([]) tears it down.
    //   • otherwise the wallet window: a dApp on any other site (its frame
    //     would see partitioned, empty storage, and the wallet's CSP
    //     frame-ancestors refuses it: only ferminux.net and *.ferminux.net
    //     may frame connect.html), or a frame that has not answered yet.
    //     The window removes the site that sent the request (its verified
    //     origin, nothing else) and closes itself.
    const f = this.frame;
    if (f && this.frameAuthoritative === true) {
      this.frame = null;
      if (this.frameTimer !== null) this.env.window.clearTimeout(this.frameTimer);
      this.frameTimer = null;
      this.forgetting?.remove();
      this.forgetting = f;
      this.forgettingOrigin = this.frameOrigin;
      this.sendForget();
      this.env.window.setTimeout(() => {
        if (this.forgetting === f) this.dropForgetting();
      }, FRAME_TIMEOUT_MS);
    } else if (this.accounts.length > 0) {
      this.callWallet(REVOKE_METHOD, [{ eth_accounts: {} }]).catch(() => undefined);
    }
    this.setAccounts([]);
  }

  private sendForget(): void {
    try {
      this.forgetting?.contentWindow?.postMessage({ protocol: PROTOCOL, type: 'forget' }, this.forgettingOrigin);
    } catch {
      /* frame gone */
    }
  }

  private dropForgetting(): void {
    this.forgetting?.remove();
    this.forgetting = null;
  }

  /* ---------------- session state ---------------- */

  private setAccounts(next: string[]): void {
    const before = this.accounts;
    if (sameAccounts(before, next)) return;
    this.accounts = [...next];
    this.persist();
    if (before.length === 0 && next.length > 0) {
      this.emit('connect', { chainId: toHexChainId(this.chainId) });
      this.startFrame();
    }
    this.emit('accountsChanged', [...next]);
    if (next.length === 0) {
      this.chainId = this.defaultChain;
      this.stopFrame();
      this.emit('disconnect', new ProviderRpcError(ERR.DISCONNECTED, 'Ferminux Wallet disconnected from this site.'));
    }
  }

  private setChain(chainId: number): void {
    if (chainId === this.chainId) return;
    this.chainId = chainId;
    this.persist();
    this.emit('chainChanged', toHexChainId(chainId));
  }

  private readStorage(): string | null {
    try {
      return this.env.storage?.getItem(this.sessionKey) ?? null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      if (this.accounts.length === 0) this.env.storage?.removeItem(this.sessionKey);
      else this.env.storage?.setItem(this.sessionKey, JSON.stringify({ accounts: this.accounts, chainId: this.chainId }));
    } catch {
      /* remembering is best-effort */
    }
  }

  /** Another tab of this dApp connected, switched or disconnected: follow it. */
  private onStorage = (event: { key?: string | null; newValue?: string | null }): void => {
    if (event.key !== this.sessionKey) return;
    const saved = parseSession(event.newValue ?? null, this.defaultChain);
    if (!saved) {
      this.setAccounts([]);
      return;
    }
    this.setChain(saved.chainId);
    this.setAccounts(saved.accounts);
  };

  /* ---------------- reads: straight to the RPC ---------------- */

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const chainId = this.chainId;
    const urls = this.rpcUrls.get(chainId) ?? [];
    if (urls.length === 0) {
      throw new ProviderRpcError(ERR.CHAIN_DISCONNECTED, `No RPC endpoint is configured for chain ${chainId} on this site.`);
    }
    // Stay on the endpoint that last answered: filters (eth_newFilter) live
    // on one node, so hopping between endpoints would lose them.
    const start = this.rpcPick.get(chainId) ?? 0;
    let last: unknown = null;
    for (let i = 0; i < urls.length; i += 1) {
      const idx = (start + i) % urls.length;
      let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      try {
        const res = await this.env.fetch(urls[idx]!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: (this.rpcSeq += 1), method, params: params === undefined ? [] : params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = (await res.json()) as typeof body;
      } catch (e) {
        last = e;
        continue;
      }
      this.rpcPick.set(chainId, idx);
      // A JSON-RPC error is the node's real answer (a revert, a bad param):
      // pass it on unchanged — ethers decodes revert data from it.
      if (body.error) throw new ProviderRpcError(typeof body.error.code === 'number' ? body.error.code : ERR.INTERNAL, body.error.message ?? 'RPC error', body.error.data);
      return body.result;
    }
    throw new ProviderRpcError(ERR.CHAIN_DISCONNECTED, `Cannot reach chain ${chainId}: ${(last as Error)?.message ?? 'network error'}.`);
  }

  /* ---------------- the wallet window ---------------- */

  private callWallet(method: string, params: unknown): Promise<unknown> {
    const plain = plainParams(params);
    return new Promise((resolve, reject) => {
      const id = newRequestId();
      const msg: RequestMessage = { protocol: PROTOCOL, type: 'request', id, method, params: plain, chainId: this.chainId, appName: this.appName };
      this.pending.set(id, { msg, resolve, reject, sent: false, acked: false });
      this.openPopup();
      this.flush();
    });
  }

  private popupUrl(): string {
    const u = new URL(this.walletUrl.href);
    const q = new URLSearchParams({ origin: this.env.window.location.origin });
    if (this.appName) q.set('app', this.appName);
    u.hash = q.toString();
    return u.href;
  }

  private popupFeatures(): string | undefined {
    const w = this.env.window;
    if (isPhoneLike(w.navigator)) return undefined; // a normal new tab
    const left = Math.max(0, Math.round((w.screenX ?? 0) + ((w.outerWidth ?? POPUP_WIDTH) - POPUP_WIDTH) / 2));
    const top = Math.max(0, Math.round((w.screenY ?? 0) + ((w.outerHeight ?? POPUP_HEIGHT) - POPUP_HEIGHT) / 2));
    return `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`;
  }

  private openPopup(): void {
    if (this.popup && !this.popup.closed) {
      try {
        this.popup.focus?.();
      } catch {
        /* focus is best-effort */
      }
      return;
    }
    this.popup = null;
    this.popupReady = false;
    this.popupOrigin = null;
    let win: PopupLike | null = null;
    try {
      win = this.env.window.open(this.popupUrl(), POPUP_NAME, this.popupFeatures());
    } catch {
      win = null;
    }
    if (win) this.adopt(win);
    else this.showBlocked();
  }

  private adopt(win: PopupLike): void {
    this.popup = win;
    this.popupReady = false;
    this.popupOrigin = null;
    this.closedSince = 0;
    this.hideBlocked();
    this.startWatch();
  }

  private flush(): void {
    const w = this.popup;
    const to = this.popupOrigin;
    if (!w || w.closed || !this.popupReady || !to) return;
    for (const p of this.pending.values()) {
      if (p.sent) continue;
      try {
        w.postMessage(p.msg, to);
        p.sent = true;
      } catch {
        return;
      }
    }
  }

  private onMessage = (event: MessageEvent): void => {
    // Exact origins only: the wallet's, never a pattern.
    if (!this.walletOrigins.includes(event.origin)) return;
    const msg = parseWalletMessage(event.data);
    if (!msg) return;
    if (this.forgetting && event.source === this.forgetting.contentWindow) {
      if (event.origin !== this.forgettingOrigin) return;
      // Its answer to "forget" is the confirmation; a late "ready" means it had not heard it yet.
      if (msg.type === 'ready') this.sendForget();
      else if (msg.type === 'status') this.dropForgetting();
      return;
    }
    if (this.frame && event.source === this.frame.contentWindow) {
      if (event.origin !== this.frameOrigin) return;
      if (msg.type === 'status') this.onStatus(msg);
      // The frame's listener is loaded after its `load` event can fire; it
      // says when it is listening, and the question is asked again then.
      else if (msg.type === 'ready') this.askFrame();
      return;
    }
    if (!this.popup || event.source !== (this.popup as unknown)) return;
    // The window may move to the wallet's other origin (no vault here, "my
    // wallet is at …"): it says ready from there, and from then on only that
    // origin is heard and addressed.
    if (msg.type !== 'ready' && event.origin !== this.popupOrigin) return;
    switch (msg.type) {
      case 'ready':
        // A (re)loaded wallet page has an empty queue: send everything again.
        this.popupReady = true;
        this.popupOrigin = event.origin;
        for (const p of this.pending.values()) {
          p.sent = false;
          p.acked = false;
        }
        this.flush();
        break;
      case 'ack': {
        const p = this.pending.get(msg.id);
        if (p) p.acked = true;
        break;
      }
      case 'response': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = fromRpcError(msg.error);
          // The wallet no longer approves this site (revoked, or the account
          // was removed): the remembered session is stale.
          if (err.code === ERR.UNAUTHORIZED) this.setAccounts([]);
          p.reject(err);
        } else {
          // Connected through this origin: it is the one to open (and to ask) from now on.
          if (p.msg.method === 'eth_requestAccounts') this.pickWallet(event.origin);
          p.resolve(msg.result);
        }
        break;
      }
      case 'closing': {
        // The wallet closes itself when idle. Anything it had not taken yet
        // goes to a fresh window.
        this.popup = null;
        this.popupReady = false;
        this.popupOrigin = null;
        const waiting = [...this.pending.values()].filter((p) => !p.acked);
        for (const p of waiting) p.sent = false;
        if (waiting.length > 0) this.openPopup();
        break;
      }
      default:
        break;
    }
  };

  /** Watch for the user closing the wallet window: every request still in it is a rejection. */
  private startWatch(): void {
    if (this.watchId !== null) return;
    this.watchId = this.env.window.setInterval(() => {
      if (this.popup && !this.popup.closed) {
        this.closedSince = 0;
        return;
      }
      if (this.pending.size === 0) {
        this.stopWatch();
        return;
      }
      if (this.blocked) return; // waiting on the user to open it again
      const now = Date.now();
      if (this.closedSince === 0) {
        this.closedSince = now;
        return;
      }
      if (now - this.closedSince < CLOSE_GRACE_MS) return;
      this.closedSince = 0;
      this.popup = null;
      this.popupReady = false;
      this.popupOrigin = null;
      this.rejectAll(new ProviderRpcError(ERR.USER_REJECTED, 'You closed Ferminux Wallet before approving. Nothing was signed.'));
      this.stopWatch();
    }, 250);
  }

  private stopWatch(): void {
    if (this.watchId !== null) this.env.window.clearInterval(this.watchId);
    this.watchId = null;
  }

  private rejectAll(err: ProviderRpcError): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  /* ---------------- pop-up blocked: retry from a real click ---------------- */

  private showBlocked(): void {
    const doc = this.env.window.document;
    if (!doc?.body) {
      this.rejectAll(new ProviderRpcError(ERR.RESOURCE_UNAVAILABLE, 'The browser blocked the Ferminux Wallet window.'));
      return;
    }
    if (this.blocked) return;
    const first = [...this.pending.values()][0];
    const action = describeMethod(first?.msg.method ?? '');
    const dark = this.theme === 'dark';
    const c = dark
      ? { scrim: 'rgba(0,0,0,.72)', card: '#0c110f', border: '#232d29', text: '#ecf2ef', muted: '#a4b1ab', btn: '#eef4f1', btnText: '#03140c', ghost: '#5b6862', radius: '14px' }
      : { scrim: 'rgba(22,24,28,.45)', card: '#ffffff', border: '#e3e3e0', text: '#16181c', muted: '#5b6169', btn: '#16181c', btnText: '#ffffff', ghost: '#c9c9c4', radius: '6px' };

    const overlay = doc.createElement('div');
    overlay.setAttribute('data-fxw-blocked', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'fxw-blocked-title');
    overlay.style.cssText = `position:fixed;inset:0;z-index:2147483646;background:${c.scrim};display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif`;

    const card = doc.createElement('div');
    card.style.cssText = `background:${c.card};color:${c.text};border:1px solid ${c.border};border-radius:${c.radius};max-width:400px;width:100%;padding:22px;box-sizing:border-box;display:grid;gap:12px`;

    const head = doc.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px';
    const icon = doc.createElement('img');
    icon.src = FERMINUX_WALLET_ICON;
    icon.alt = '';
    icon.width = 28;
    icon.height = 28;
    icon.style.cssText = 'border-radius:6px;flex:none';
    const title = doc.createElement('h2');
    title.id = 'fxw-blocked-title';
    title.textContent = 'Open Ferminux Wallet';
    title.style.cssText = 'margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em';
    head.append(icon, title);

    const text = doc.createElement('p');
    text.style.cssText = `margin:0;color:${c.muted};font-size:14px`;
    text.textContent = `Your browser blocked the wallet window. This site is asking you to ${action}: open the wallet to review it there.`;

    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px';
    const open = doc.createElement('button');
    open.type = 'button';
    open.textContent = 'Open Ferminux Wallet';
    open.setAttribute('data-fxw-open', '');
    open.style.cssText = `flex:1 1 auto;min-height:44px;padding:0 18px;border:0;border-radius:${dark ? '999px' : '6px'};background:${c.btn};color:${c.btnText};font:inherit;font-weight:600;cursor:pointer`;
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('data-fxw-cancel', '');
    cancel.style.cssText = `min-height:44px;padding:0 18px;border:1px solid ${c.ghost};border-radius:${dark ? '999px' : '6px'};background:transparent;color:${c.text};font:inherit;cursor:pointer`;
    row.append(open, cancel);
    card.append(head, text, row);
    overlay.append(card);

    open.addEventListener('click', () => {
      // A click is a user gesture: the browser lets this one through.
      let win: PopupLike | null = null;
      try {
        win = this.env.window.open(this.popupUrl(), POPUP_NAME, this.popupFeatures());
      } catch {
        win = null;
      }
      if (win) {
        this.adopt(win);
        this.flush();
      } else {
        text.textContent = 'Still blocked. Allow pop-ups for this site (the icon at the end of the address bar), then press Open again.';
      }
    });
    const onCancel = () => {
      this.hideBlocked();
      this.rejectAll(new ProviderRpcError(ERR.USER_REJECTED, 'The wallet window was blocked and the request was cancelled.'));
    };
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    });

    doc.body.appendChild(overlay);
    this.blocked = overlay;
    open.focus();
  }

  private hideBlocked(): void {
    this.blocked?.remove();
    this.blocked = null;
  }

  /* ---------------- status frame (same-site revoke detection) ---------------- */

  private startFrame(): void {
    const doc = this.env.window.document;
    if (!this.useFrame || this.frame || !doc) return;
    const create = () => {
      if (this.frame || this.accounts.length === 0) return;
      const f = doc.createElement('iframe');
      const u = new URL(this.walletUrl.href);
      u.hash = FRAME_HASH;
      f.src = u.href;
      f.title = 'Ferminux Wallet connection status';
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
      f.addEventListener('load', () => this.askFrame());
      this.frameAnswered = false;
      this.frameAuthoritative = null;
      doc.body.appendChild(f);
      this.frame = f;
      this.frameOrigin = this.walletUrl.origin;
      // A wallet that refuses to be framed never answers: drop the frame and
      // keep the remembered session (a later request still reports 4100).
      this.frameTimer = this.env.window.setTimeout(() => {
        if (!this.frameAnswered) this.stopFrame();
      }, FRAME_TIMEOUT_MS);
    };
    if (doc.body) create();
    else doc.addEventListener('DOMContentLoaded', create, { once: true });
  }

  private askFrame(): void {
    try {
      this.frame?.contentWindow?.postMessage({ protocol: PROTOCOL, type: 'status' }, this.frameOrigin);
    } catch {
      /* frame blocked */
    }
  }

  private stopFrame(): void {
    if (this.frameTimer !== null) this.env.window.clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.frame?.remove();
    this.frame = null;
  }

  private onStatus(msg: StatusMessage): void {
    this.frameAnswered = true;
    this.frameAuthoritative = msg.authoritative;
    if (!msg.authoritative) {
      // Cross-site: the frame reads partitioned (empty) storage. Nothing to learn.
      this.stopFrame();
      return;
    }
    if (!msg.approved) {
      this.setAccounts([]);
      return;
    }
    const allowed = new Set(msg.accounts.map((a) => a.toLowerCase()));
    const kept = this.accounts.filter((a) => allowed.has(a.toLowerCase()));
    if (kept.length !== this.accounts.length) this.setAccounts(kept.length > 0 ? kept : msg.accounts);
  }
}

/** Create the Ferminux Wallet EIP-1193 provider for this page. */
export function createFerminuxWalletProvider(opts: FerminuxWalletProviderOptions = {}): FerminuxWalletProvider {
  return new FerminuxWalletProviderImpl(opts);
}

/* ------------------------------------------------------------------ */
/* EIP-6963                                                            */
/* ------------------------------------------------------------------ */

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

function uuidV4(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID(); // secure contexts only
    } catch {
      /* fall through */
    }
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Announce the provider under EIP-6963 so any wallet picker on the page
 * (ours, wagmi, RainbowKit, …) lists "Ferminux Wallet" next to installed
 * extensions. Returns a function that stops answering requestProvider.
 */
export function announceFerminuxWallet(provider: FerminuxWalletProvider): () => void {
  const w = globalThis as unknown as Window;
  if (typeof w.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return () => {};
  const info: Eip6963ProviderInfo = Object.freeze({
    uuid: uuidV4(),
    name: FERMINUX_WALLET_NAME,
    icon: FERMINUX_WALLET_ICON,
    rdns: FERMINUX_WALLET_RDNS,
  });
  const detail = Object.freeze({ info, provider });
  const announce = () => w.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  announce();
  w.addEventListener('eip6963:requestProvider', announce);
  return () => w.removeEventListener('eip6963:requestProvider', announce);
}
