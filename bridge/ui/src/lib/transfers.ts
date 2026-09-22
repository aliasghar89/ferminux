// Persistence for in-flight and historical transfers.
//
// A bridge transfer outlives the page: the source transaction confirms in
// seconds, the destination execution lands minutes later. Losing the transferId
// on a refresh would leave a user with no way to follow their own money, so
// every transfer is written to storage the moment it has a transaction hash.
//
// The storage backend is INJECTED (any {getItem,setItem}) so this module has no
// browser globals and is driven directly by tests/transfers.test.mjs.

import { STORAGE_KEY } from '../config.ts';

export type TransferPhase =
  | 'submitted' // broadcast, not yet mined on the source chain
  | 'confirming' // mined, accumulating source confirmations
  | 'executing' // enough confirmations; validators attest, a relayer submits
  | 'complete' // the destination bridge marked the transferId processed
  | 'reverted' // the source transaction failed — nothing left the wallet
  | 'unverifiable'; // no destination bridge configured, cannot confirm arrival

export interface TransferRecord {
  /** keccak of the transfer struct — globally unique. '' until Sent is parsed. */
  transferId: string;
  srcChainKey: string;
  dstChainKey: string;
  srcChainId: number;
  dstChainId: number;
  srcBridge: string;
  dstBridge: string;
  srcToken: string;
  dstToken: string;
  symbol: string;
  dstSymbol: string;
  decimals: number;
  sender: string;
  recipient: string;
  /** Gross amount left the wallet (decimal string of base units). */
  sentWei: string;
  /** Net amount that arrives on the destination (gross - fee). */
  amountWei: string;
  feeWei: string;
  nonce: number;
  txHash: string;
  txBlockNumber: number | null;
  createdAt: number;
  updatedAt: number;
  phase: TransferPhase;
  /** Last error surfaced for this transfer, if any. */
  error?: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Newest first, capped — a history panel is not an archive. */
export const MAX_RECORDS = 60;

const PHASES: readonly TransferPhase[] = [
  'submitted',
  'confirming',
  'executing',
  'complete',
  'reverted',
  'unverifiable',
];

function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^\d+$/.test(v);
}

/** Accept only records this app wrote and can still render. */
export function isTransferRecord(v: unknown): v is TransferRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(r.txHash) &&
    typeof r.srcChainKey === 'string' &&
    typeof r.dstChainKey === 'string' &&
    typeof r.symbol === 'string' &&
    typeof r.decimals === 'number' &&
    isDecimalString(r.amountWei) &&
    isDecimalString(r.sentWei) &&
    isDecimalString(r.feeWei) &&
    typeof r.createdAt === 'number' &&
    typeof r.phase === 'string' &&
    PHASES.includes(r.phase as TransferPhase)
  );
}

/**
 * Read the stored transfers. Anything unparseable or malformed is discarded
 * silently — a corrupt history must never stop the app from loading.
 */
export function loadTransfers(store: KeyValueStore, key: string = STORAGE_KEY): TransferRecord[] {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTransferRecord).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function saveTransfers(
  store: KeyValueStore,
  records: TransferRecord[],
  key: string = STORAGE_KEY,
): TransferRecord[] {
  const capped = records.slice(0, MAX_RECORDS);
  try {
    store.setItem(key, JSON.stringify(capped));
  } catch {
    // Quota exceeded / storage disabled: the in-memory list still works for
    // this session. Failing to persist is not a reason to lose the transfer.
  }
  return capped;
}

/** Insert or replace by txHash, newest first. */
export function upsertTransfer(
  records: TransferRecord[],
  record: TransferRecord,
): TransferRecord[] {
  const hash = record.txHash.toLowerCase();
  const rest = records.filter((r) => r.txHash.toLowerCase() !== hash);
  return [record, ...rest].slice(0, MAX_RECORDS);
}

/** Merge a patch into one record, stamping updatedAt. No-op if not found. */
export function patchTransfer(
  records: TransferRecord[],
  txHash: string,
  patch: Partial<TransferRecord>,
  nowMs: number = Date.now(),
): TransferRecord[] {
  const hash = txHash.toLowerCase();
  let changed = false;
  const next = records.map((r) => {
    if (r.txHash.toLowerCase() !== hash) return r;
    const merged = { ...r, ...patch, updatedAt: nowMs };
    // Avoid pointless re-renders when nothing actually moved.
    if (JSON.stringify({ ...r, updatedAt: 0 }) === JSON.stringify({ ...merged, updatedAt: 0 })) return r;
    changed = true;
    return merged;
  });
  return changed ? next : records;
}

export function findTransfer(records: TransferRecord[], txHash: string): TransferRecord | undefined {
  const hash = txHash.toLowerCase();
  return records.find((r) => r.txHash.toLowerCase() === hash);
}

/** A transfer still worth polling: not terminal. */
export function isInFlight(r: TransferRecord): boolean {
  return r.phase === 'submitted' || r.phase === 'confirming' || r.phase === 'executing';
}

export function inFlight(records: TransferRecord[]): TransferRecord[] {
  return records.filter(isInFlight);
}

export function settled(records: TransferRecord[]): TransferRecord[] {
  return records.filter((r) => !isInFlight(r));
}

/** A localStorage-backed store, or null where storage is unavailable. */
export function browserStore(): KeyValueStore | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Safari private mode throws on setItem, not on access — probe once.
    const probe = '__ferminux_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
