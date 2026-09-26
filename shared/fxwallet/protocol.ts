// The postMessage protocol between a dApp (shared/fxwallet/provider.ts) and
// the wallet page (wallet-web/connect.html).
//
//   dApp                                     wallet popup (or phone tab)
//   ────                                     ───────────────────────────
//   window.open(connect.html#origin=…)  ──▶  loads, posts READY to the opener
//                                             with targetOrigin = the claimed
//                                             origin (dropped by the browser
//                                             unless the opener really is it)
//   REQUEST {id, method, params}        ──▶  checks event.source === opener
//                                             and event.origin === claimed
//                                       ◀──  ACK {id}
//                                             unlock, show origin, confirm
//                                       ◀──  RESPONSE {id, result | error}
//                                       ◀──  CLOSING (idle, about to close)
//
//   hidden iframe connect.html#frame    ──▶  STATUS {}            (same-site
//                                       ◀──  STATUS {approved…}    dApps only)
//                                       ──▶  FORGET {}
//
//   Disconnect on any other site: REQUEST wallet_revokePermissions through the
//   window; the wallet removes the requesting origin (event.origin, never a
//   parameter) from its connected sites, answers null and closes.
//
//   The wallet is served at two origins (wallet.ferminux.net and
//   ferminux.net/wallet/). A window that finds no vault can send itself to the
//   other one's connect.html with the same #origin=…; it says READY again from
//   there and the dApp re-sends what it had queued, to that origin only.
//
// Both sides post with an explicit targetOrigin and drop every message whose
// origin/source is not the one they expect. Every message carries PROTOCOL so
// unrelated postMessage traffic on the page (analytics, other wallets) is
// ignored without being parsed further.
//
// Pure module: no browser globals, importable from Node tests.

import type { RpcErrorShape } from './errors.ts';

export const PROTOCOL = 'ferminux-wallet/1';

/** Hash marker that puts connect.html into its invisible status-frame mode. */
export const FRAME_HASH = 'fxw-frame';

export interface RequestMessage {
  protocol: typeof PROTOCOL;
  type: 'request';
  id: string;
  method: string;
  params: unknown;
  /** The chain the dApp's provider is on; the wallet signs for exactly this chain. */
  chainId: number;
  /** Display only. The wallet trusts event.origin, never this. */
  appName: string;
}
export interface StatusQueryMessage {
  protocol: typeof PROTOCOL;
  type: 'status';
}
export interface ForgetMessage {
  protocol: typeof PROTOCOL;
  type: 'forget';
}
export type DappMessage = RequestMessage | StatusQueryMessage | ForgetMessage;

export interface ReadyMessage {
  protocol: typeof PROTOCOL;
  type: 'ready';
}
export interface AckMessage {
  protocol: typeof PROTOCOL;
  type: 'ack';
  id: string;
}
export interface ResponseMessage {
  protocol: typeof PROTOCOL;
  type: 'response';
  id: string;
  result?: unknown;
  error?: RpcErrorShape;
}
export interface ClosingMessage {
  protocol: typeof PROTOCOL;
  type: 'closing';
}
export interface StatusMessage {
  protocol: typeof PROTOCOL;
  type: 'status';
  /**
   * True only when the frame reads the wallet's own storage (the dApp is on
   * the wallet's site). A cross-site frame sees partitioned, empty storage and
   * must not be believed when it says "not approved".
   */
  authoritative: boolean;
  approved: boolean;
  accounts: string[];
}
export type WalletMessage = ReadyMessage | AckMessage | ResponseMessage | ClosingMessage | StatusMessage;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function base(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  return o.protocol === PROTOCOL && typeof o.type === 'string' ? o : null;
}

/** Validate a message a dApp sent to the wallet page. Null = ignore it. */
export function parseDappMessage(data: unknown): DappMessage | null {
  const o = base(data);
  if (!o) return null;
  if (o.type === 'status') return { protocol: PROTOCOL, type: 'status' };
  if (o.type === 'forget') return { protocol: PROTOCOL, type: 'forget' };
  if (o.type !== 'request') return null;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (typeof o.method !== 'string' || o.method.length === 0 || o.method.length > 64) return null;
  if (typeof o.chainId !== 'number' || !Number.isSafeInteger(o.chainId) || o.chainId <= 0) return null;
  const appName = typeof o.appName === 'string' ? o.appName.slice(0, 60) : '';
  return { protocol: PROTOCOL, type: 'request', id: o.id, method: o.method, params: o.params, chainId: o.chainId, appName };
}

/** Validate a message the wallet page sent to a dApp. Null = ignore it. */
export function parseWalletMessage(data: unknown): WalletMessage | null {
  const o = base(data);
  if (!o) return null;
  switch (o.type) {
    case 'ready':
      return { protocol: PROTOCOL, type: 'ready' };
    case 'closing':
      return { protocol: PROTOCOL, type: 'closing' };
    case 'ack':
      return typeof o.id === 'string' && ID_RE.test(o.id) ? { protocol: PROTOCOL, type: 'ack', id: o.id } : null;
    case 'response': {
      if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
      const msg: ResponseMessage = { protocol: PROTOCOL, type: 'response', id: o.id };
      if (o.error !== undefined && o.error !== null) {
        const e = o.error as Record<string, unknown>;
        if (typeof e !== 'object' || typeof e.code !== 'number' || typeof e.message !== 'string') return null;
        msg.error = { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
      } else {
        msg.result = o.result;
      }
      return msg;
    }
    case 'status': {
      const accounts = Array.isArray(o.accounts) ? o.accounts.filter((a): a is string => typeof a === 'string' && ADDRESS_RE.test(a)) : [];
      return {
        protocol: PROTOCOL,
        type: 'status',
        authoritative: o.authoritative === true,
        approved: o.approved === true,
        accounts,
      };
    }
    default:
      return null;
  }
}

/** A dApp's disconnect, carried by the window when its status frame cannot reach the wallet's storage. */
export const REVOKE_METHOD = 'wallet_revokePermissions';

/** Methods the popup must show to the user. */
export const POPUP_METHODS: ReadonlySet<string> = new Set([
  'eth_requestAccounts',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_watchAsset',
]);

/**
 * Read-only JSON-RPC methods the provider sends straight to the chain's RPC —
 * never through the popup. Anything not listed here and not wallet-routed is
 * answered with 4200, so a dApp cannot reach a node method by accident.
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_createAccessList',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_newBlockFilter',
  'eth_newFilter',
  'eth_newPendingTransactionFilter',
  'eth_sendRawTransaction',
  'eth_syncing',
  'eth_uninstallFilter',
  'net_listening',
  'web3_clientVersion',
]);

/** Short phrase for "<site> wants you to …", used by the popup-blocked prompt. */
export function describeMethod(method: string): string {
  switch (method) {
    case 'eth_requestAccounts':
      return 'connect your wallet';
    case 'personal_sign':
    case 'eth_signTypedData_v4':
      return 'sign a message';
    case 'eth_sendTransaction':
      return 'confirm a transaction';
    case 'wallet_watchAsset':
      return 'add a token to your wallet';
    case REVOKE_METHOD:
      return 'disconnect it from your wallet';
    default:
      return 'use your wallet';
  }
}

/** Random request id (URL-safe, fits ID_RE). */
export function newRequestId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
