// Transaction history via the Blockscout v2 REST API.
// Strictly optional: when the explorer is unreachable the wallet keeps
// working RPC-only and the UI shows a graceful "history unavailable" state.

export interface ActivityItem {
  hash: string;
  from: string;
  to: string | null;
  valueWei: bigint;
  /** ISO timestamp from the explorer, if provided. */
  timestamp: string | null;
  /** Block the transaction landed in; null while pending. */
  blockNumber: number | null;
  /** true = success, false = reverted, null = unknown/pending. */
  success: boolean | null;
  direction: 'in' | 'out' | 'self';
  isContractCall: boolean;
}

interface BlockscoutAddress {
  hash?: string;
}

interface BlockscoutTx {
  hash?: string;
  from?: BlockscoutAddress;
  to?: BlockscoutAddress | null;
  value?: string;
  timestamp?: string | null;
  block_number?: number | string | null;
  status?: string | null; // "ok" | "error" | null
  raw_input?: string;
  method?: string | null;
}

/** Blockscout returns block numbers as numbers, occasionally as strings. */
export function toBlockNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Pure parser — unit-testable without any network. */
export function parseActivity(payload: unknown, selfAddress: string): ActivityItem[] {
  const self = selfAddress.toLowerCase();
  const items = (payload as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: ActivityItem[] = [];
  for (const raw of items) {
    const tx = raw as BlockscoutTx;
    if (typeof tx.hash !== 'string' || typeof tx.from?.hash !== 'string') continue;
    const from = tx.from.hash;
    const to = typeof tx.to?.hash === 'string' ? tx.to.hash : null;
    let valueWei = 0n;
    try {
      valueWei = BigInt(tx.value ?? '0');
    } catch {
      valueWei = 0n;
    }
    const fromSelf = from.toLowerCase() === self;
    const toSelf = to !== null && to.toLowerCase() === self;
    out.push({
      hash: tx.hash,
      from,
      to,
      valueWei,
      timestamp: typeof tx.timestamp === 'string' ? tx.timestamp : null,
      blockNumber: toBlockNumber(tx.block_number),
      success: tx.status === 'ok' ? true : tx.status === 'error' ? false : null,
      direction: fromSelf && toSelf ? 'self' : fromSelf ? 'out' : 'in',
      isContractCall: typeof tx.raw_input === 'string' && tx.raw_input !== '0x' && tx.raw_input !== '',
    });
  }
  return out;
}

/**
 * GET {explorer}/api/v2/addresses/{addr}/transactions.
 * Throws on any failure — the caller renders the fallback state.
 */
export async function fetchActivity(
  explorerUrl: string,
  address: string,
  opts?: { timeoutMs?: number },
): Promise<ActivityItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${explorerUrl}/api/v2/addresses/${address}/transactions`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Explorer API responded ${res.status}`);
    return parseActivity(await res.json(), address);
  } finally {
    clearTimeout(timer);
  }
}
