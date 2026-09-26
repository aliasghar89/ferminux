// Put a connected wallet on Ferminux (chain 3961), whichever wallet it is.
//
// Most wallets a dApp reaches through WalletConnect (MetaMask Mobile, Trust,
// OKX, Bitget, SafePal, Coinbase Wallet, Rainbow, Zerion, …) do not ship chain
// 3961. The connector proposes 3961 as an OPTIONAL chain, because a wallet
// refuses the whole session when a REQUIRED chain is one it does not know; the
// session therefore usually comes back on the chains the wallet does know.
// ensureFerminuxChain then asks the wallet to switch, adds the network
// (EIP-3085) when the wallet has never seen it, and — for WalletConnect —
// checks that the session now carries 3961: a request on a chain the session
// does not name is refused by the WalletConnect client before it reaches the
// wallet, so "switched" is not enough on its own.
//
// Every way this can end short of success is one ChainSetupError whose message
// a person can act on, with the network details to add by hand where that is
// the way forward.
//
// Pure: no browser globals; the provider is passed in (tests drive it with a
// scripted fake).

import { FERMINUX_CHAIN_ID, parseChainId, toHexChainId } from './chains.ts';

export const FERMINUX_RPC_URL = 'https://rpc.ferminux.net';
export const FERMINUX_EXPLORER_URL = 'https://explorer.ferminux.net';
/** The brand mark as served by ferminux.net (SVG, and a PNG for wallets that cannot draw SVG). */
export const FERMINUX_ICON_URLS: readonly string[] = [
  'https://ferminux.net/assets/brand/favicon.svg',
  'https://ferminux.net/assets/brand/icon-512.png',
];

/** EIP-3085 wallet_addEthereumChain parameters for Ferminux. Always the public endpoints. */
export const FERMINUX_ADD_CHAIN_PARAMS = {
  chainId: toHexChainId(FERMINUX_CHAIN_ID),
  chainName: 'Ferminux',
  nativeCurrency: { name: 'Ferminux', symbol: 'FMX', decimals: 18 },
  rpcUrls: [FERMINUX_RPC_URL],
  blockExplorerUrls: [FERMINUX_EXPLORER_URL],
  iconUrls: [...FERMINUX_ICON_URLS],
} as const;

/** What a person types into a wallet's "Add network" form. */
export const FERMINUX_NETWORK_DETAILS: ReadonlyArray<readonly [label: string, value: string]> = [
  ['Network name', FERMINUX_ADD_CHAIN_PARAMS.chainName],
  ['RPC URL', FERMINUX_RPC_URL],
  ['Chain ID', String(FERMINUX_CHAIN_ID)],
  ['Currency symbol', 'FMX'],
  ['Block explorer', FERMINUX_EXPLORER_URL],
];

/** The network details on one line, for messages. */
export function manualNetworkText(): string {
  return FERMINUX_NETWORK_DETAILS.map(([k, v]) => `${k}: ${v}`).join(' · ');
}

export type ChainSetupReason =
  /** The person said no to the switch or to adding the network. */
  | 'rejected'
  /** The wallet already shows a request; it answers nothing else until that one is settled. */
  | 'pending'
  /** The wallet cannot add networks from a site (or not this one). */
  | 'unsupported'
  /** WalletConnect: the wallet is on 3961 but did not add it to this site's session. */
  | 'session'
  /** The wallet accepted but never reported chain 3961. */
  | 'timeout';

export class ChainSetupError extends Error {
  readonly reason: ChainSetupReason;
  /** The network details are part of the message (the person can add it by hand). */
  readonly manual: boolean;
  constructor(reason: ChainSetupReason, message: string, manual: boolean) {
    super(message);
    this.name = 'ChainSetupError';
    this.reason = reason;
    this.manual = manual;
  }
}

interface RequestProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

/** The part of a WalletConnect provider (@walletconnect/ethereum-provider) this file reads. */
interface WalletConnectLike {
  isWalletConnect?: boolean;
  session?: { namespaces?: Record<string, { accounts?: string[]; chains?: string[] }>; peer?: { metadata?: { name?: string } } };
}

/** The JSON-RPC error code, wherever the wallet or its SDK put it. */
export function errorCode(e: unknown): number | undefined {
  const err = e as { code?: unknown; data?: { originalError?: { code?: unknown } }; error?: { code?: unknown }; cause?: { code?: unknown } } | null;
  for (const c of [err?.code, err?.data?.originalError?.code, err?.error?.code, err?.cause?.code]) {
    if (typeof c === 'number' && Number.isInteger(c)) return c;
  }
  return undefined;
}

function errorText(e: unknown): string {
  const err = e as { message?: unknown; shortMessage?: unknown; error?: { message?: unknown } } | null;
  const parts = [err?.shortMessage, err?.message, err?.error?.message].filter((x): x is string => typeof x === 'string');
  return parts.join(' ') || (typeof e === 'string' ? e : '');
}

/** The person declined: EIP-1193 4001, WalletConnect's 5000, or a wallet that only says so in words. */
export function isUserRejection(e: unknown): boolean {
  const code = errorCode(e);
  if (code === 4001 || code === 5000) return true;
  return /user (rejected|denied|declined|cancell?ed)|rejected by (the )?user|request rejected|declined/i.test(errorText(e));
}

/** A request of this kind is already open in the wallet. */
export function isPendingRequest(e: unknown): boolean {
  return errorCode(e) === -32002 || /already pending|request.*pending/i.test(errorText(e));
}

/** The name the wallet gave the WalletConnect session, or a plain fallback. */
function walletName(provider: unknown): string {
  const name = (provider as WalletConnectLike | null)?.session?.peer?.metadata?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 40) : 'Your wallet';
}

function isWalletConnect(provider: unknown): provider is WalletConnectLike {
  const p = provider as WalletConnectLike | null;
  return !!p && p.isWalletConnect === true && typeof p.session === 'object' && p.session !== null;
}

/**
 * A WalletConnect session names the chain (an account on it, or the chain
 * itself). Anything that is not a WalletConnect provider has no session to
 * check and passes.
 */
export function sessionHasChain(provider: unknown, chainId: number = FERMINUX_CHAIN_ID): boolean {
  if (!isWalletConnect(provider)) return true;
  const ns = provider.session?.namespaces ?? {};
  const caip = `eip155:${chainId}`;
  for (const [key, value] of Object.entries(ns)) {
    if (key === caip) return true;
    if (!key.startsWith('eip155')) continue;
    if ((value?.accounts ?? []).some((a) => typeof a === 'string' && a.startsWith(`${caip}:`))) return true;
    if ((value?.chains ?? []).includes(caip)) return true;
  }
  return false;
}

/** The first chain a WalletConnect session has an account on, or null. */
function firstSessionChain(provider: unknown): number | null {
  if (!isWalletConnect(provider)) return null;
  for (const [key, value] of Object.entries(provider.session?.namespaces ?? {})) {
    if (!key.startsWith('eip155')) continue;
    for (const a of value?.accounts ?? []) {
      const id = parseChainId(String(a).split(':')[1] ?? '');
      if (id !== null) return id;
    }
  }
  return null;
}

async function readChain(provider: RequestProvider): Promise<number | null> {
  try {
    return parseChainId(await provider.request({ method: 'eth_chainId' }));
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean, ms: number, every = 250): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= until) return false;
    await sleep(every);
  }
}

export type ChainSetupStep = 'switch' | 'add';

export interface EnsureChainOptions {
  /** Told before each request the wallet has to show ("switch" or "add"), so the page can say so. */
  onStep?: (step: ChainSetupStep) => void;
  /** How long to wait for the wallet to report 3961 after it accepted (ms). Default 8000. */
  settleMs?: number;
}

function rejected(): ChainSetupError {
  return new ChainSetupError(
    'rejected',
    `The wallet was not switched to Ferminux, so nothing was sent. Approve Ferminux when the wallet asks, or add it by hand — ${manualNetworkText()} — then try again.`,
    true,
  );
}

function pending(): ChainSetupError {
  return new ChainSetupError(
    'pending',
    'The wallet is already showing a request. Open it, approve or dismiss that request, then try again.',
    false,
  );
}

/**
 * Make the connected wallet use chain 3961: switch; when the wallet does not
 * know the chain (or cannot say), add it and switch; then confirm the wallet
 * (and, over WalletConnect, the session) is on it. Resolves when it is;
 * otherwise throws a ChainSetupError.
 */
export async function ensureFerminuxChain(provider: RequestProvider, opts: EnsureChainOptions = {}): Promise<void> {
  const settleMs = opts.settleMs ?? 8000;
  const target = FERMINUX_CHAIN_ID;
  const hex = toHexChainId(target);
  const onChain = async () => (await readChain(provider)) === target;
  const inSession = () => sessionHasChain(provider, target);
  const name = walletName(provider);

  if ((await onChain()) && inSession()) return;

  let switched = false;
  try {
    opts.onStep?.('switch');
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    switched = true;
  } catch (e) {
    if (isUserRejection(e)) throw rejected();
    if (isPendingRequest(e)) throw pending();
    // Anything else — 4902 (unknown chain), -32603 with "Unrecognized chain",
    // WalletConnect's "not approved" or a wallet that does not implement the
    // switch at all — is answered by adding the network.
  }

  if (!switched) {
    try {
      opts.onStep?.('add');
      await provider.request({ method: 'wallet_addEthereumChain', params: [FERMINUX_ADD_CHAIN_PARAMS] });
    } catch (e) {
      if (isUserRejection(e)) throw rejected();
      if (isPendingRequest(e)) throw pending();
      throw new ChainSetupError(
        'unsupported',
        `${name} could not add Ferminux from this site. Add the network in the wallet's settings — ${manualNetworkText()} — then connect again, or connect with Ferminux Wallet, which has it built in.`,
        true,
      );
    }
    // Most wallets switch as part of adding; the rest need to be asked again.
    if (!(await waitFor(onChain, Math.min(2500, settleMs)))) {
      try {
        opts.onStep?.('switch');
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      } catch (e) {
        if (isUserRejection(e)) throw rejected();
        if (isPendingRequest(e)) throw pending();
        /* the wait below decides */
      }
    }
  }

  if (!(await waitFor(onChain, settleMs))) {
    throw new ChainSetupError(
      'timeout',
      `${name} has not switched to Ferminux yet. Switch to it in the wallet (${manualNetworkText()}) and try again.`,
      true,
    );
  }
  // The wallet updates the session a moment after it answers.
  if (!(await waitFor(inSession, settleMs))) {
    // Until then the WalletConnect provider sits on a chain it has no account
    // for (eth_accounts is empty). Put it back on one the session does name —
    // an approved chain is switched locally, without asking the wallet.
    const back = firstSessionChain(provider);
    if (back !== null) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHexChainId(back) }] }).catch(() => undefined);
    }
    throw new ChainSetupError(
      'session',
      `${name} switched to Ferminux but did not share the network with this site. Disconnect, then connect again: the wallet knows Ferminux now and can include it.`,
      false,
    );
  }
}
