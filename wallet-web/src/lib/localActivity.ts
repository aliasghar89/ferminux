// Sent-transaction log for the chains without a keyless history API.
// Pure: parsing and list edits. Storage lives in state/storage.ts.
//
// Ferminux history comes from its own explorer. The other chains' explorers
// need API keys for history, so this wallet records what IT sent there — hash,
// sender, recipient, asset, amount — and links each row to the chain's
// explorer. Everything recorded is public on-chain data; nothing secret is
// ever written here.

import { chainById } from './chains.ts';

export const LOCAL_ACTIVITY_KEY = 'ferminux.wallet.activity.v1';
/** Per device, newest kept. */
export const LOCAL_ACTIVITY_CAP = 300;

export type LocalTxStatus = 'pending' | 'confirmed' | 'failed';

export interface LocalTx {
  chainId: number;
  hash: string;
  from: string;
  /** Recipient of the value (for a token transfer: the token's recipient, not the contract). */
  to: string;
  /** 'native' | 'token' | 'nft' | 'call' (a dApp's contract call). */
  kind: 'native' | 'token' | 'nft' | 'call';
  symbol: string;
  /** Base units as a decimal string (bigint does not survive JSON). */
  amount: string;
  decimals: number;
  /** Token contract for 'token' / 'nft'; null otherwise. */
  contract: string | null;
  status: LocalTxStatus;
  createdAt: number;
  /** Set when a WalletConnect dApp requested it. */
  via?: string;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function normalize(raw: unknown): LocalTx | null {
  const r = raw as Partial<LocalTx> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.chainId !== 'number' || !chainById(r.chainId)) return null;
  if (typeof r.hash !== 'string' || !HASH_RE.test(r.hash)) return null;
  if (typeof r.from !== 'string' || !ADDR_RE.test(r.from)) return null;
  if (typeof r.to !== 'string' || !ADDR_RE.test(r.to)) return null;
  if (r.kind !== 'native' && r.kind !== 'token' && r.kind !== 'nft' && r.kind !== 'call') return null;
  if (typeof r.amount !== 'string' || !/^\d{1,80}$/.test(r.amount)) return null;
  if (r.status !== 'pending' && r.status !== 'confirmed' && r.status !== 'failed') return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  const decimals = Number(r.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return {
    chainId: r.chainId,
    hash: r.hash.toLowerCase(),
    from: r.from,
    to: r.to,
    kind: r.kind,
    symbol: typeof r.symbol === 'string' ? r.symbol.slice(0, 16) : '',
    amount: r.amount,
    decimals,
    contract: typeof r.contract === 'string' && ADDR_RE.test(r.contract) ? r.contract : null,
    status: r.status,
    createdAt: r.createdAt,
    ...(typeof r.via === 'string' && r.via !== '' ? { via: r.via.slice(0, 80) } : {}),
  };
}

export function parseLocalActivity(raw: string | null): LocalTx[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LocalTx[] = [];
  for (const item of parsed) {
    const t = normalize(item);
    if (t && !out.some((o) => o.chainId === t.chainId && o.hash === t.hash)) out.push(t);
  }
  return sortNewestFirst(out).slice(0, LOCAL_ACTIVITY_CAP);
}

export function serializeLocalActivity(list: LocalTx[]): string {
  return JSON.stringify(list);
}

function sortNewestFirst(list: LocalTx[]): LocalTx[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** Record a transaction (replacing an existing row with the same chain + hash). */
export function withLocalTx(list: LocalTx[], tx: LocalTx): LocalTx[] {
  const t = normalize(tx);
  if (!t) return list;
  const rest = list.filter((o) => !(o.chainId === t.chainId && o.hash === t.hash));
  return sortNewestFirst([t, ...rest]).slice(0, LOCAL_ACTIVITY_CAP);
}

export function withLocalTxStatus(list: LocalTx[], chainId: number, hash: string, status: LocalTxStatus): LocalTx[] {
  const h = hash.toLowerCase();
  return list.map((o) => (o.chainId === chainId && o.hash === h ? { ...o, status } : o));
}

/** Rows sent by `address`, optionally on one chain, newest first. */
export function localTxFor(list: LocalTx[], address: string, chainId?: number): LocalTx[] {
  const a = address.toLowerCase();
  return list.filter((o) => o.from.toLowerCase() === a && (chainId === undefined || o.chainId === chainId));
}
