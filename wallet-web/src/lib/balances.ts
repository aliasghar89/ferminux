// Batched native-balance reads.
// No browser globals beyond `fetch` (already used by lib/rpc.ts).
//
// A multi-account wallet refreshes every account every REFRESH_MS. Doing that
// with N sequential round trips is N× the latency and N× the connections, and
// it makes the total balance a sum of readings taken at different block
// heights. Instead every address goes into ONE JSON-RPC batch: a single HTTP
// POST whose body is an array of eth_getBalance calls, all against the same
// block tag, answered in one response.

export interface JsonRpcCall {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

export interface JsonRpcReply {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Sends one batch and resolves the replies. Injectable so tests need no network. */
export type BatchTransport = (calls: JsonRpcCall[]) => Promise<JsonRpcReply[]>;

export interface BalanceSnapshot {
  /** Lower-cased address → balance in wei. Only successful reads appear. */
  balances: Map<string, bigint>;
  /** Lower-cased addresses the node did not answer for. */
  failed: string[];
  /** Block tag the whole batch was read at. */
  blockTag: string;
}

/** Dedupe addresses case-insensitively, preserving first-seen order. */
export function normalizeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    const lower = a.trim().toLowerCase();
    if (lower === '' || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Build the batch. One call per unique address, ids 1..N so a reply can be
 * matched back even if the node answers out of order (permitted by JSON-RPC).
 */
export function buildBalanceBatch(
  addresses: string[],
  blockTag = 'latest',
): { calls: JsonRpcCall[]; order: string[] } {
  const order = normalizeAddresses(addresses);
  const calls: JsonRpcCall[] = order.map((address, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_getBalance',
    params: [address, blockTag],
  }));
  return { calls, order };
}

/** Match replies to addresses by id and decode the hex quantities. */
export function readBalanceBatch(order: string[], replies: JsonRpcReply[], blockTag = 'latest'): BalanceSnapshot {
  const byId = new Map<number, JsonRpcReply>();
  for (const reply of Array.isArray(replies) ? replies : [replies]) {
    if (reply && typeof reply.id === 'number') byId.set(reply.id, reply);
  }
  const balances = new Map<string, bigint>();
  const failed: string[] = [];
  order.forEach((address, i) => {
    const reply = byId.get(i + 1);
    if (!reply || reply.error || typeof reply.result !== 'string') {
      failed.push(address);
      return;
    }
    try {
      balances.set(address, BigInt(reply.result));
    } catch {
      failed.push(address);
    }
  });
  return { balances, failed, blockTag };
}

/** Fetch every balance in a single round trip. */
export async function fetchBalances(
  transport: BatchTransport,
  addresses: string[],
  blockTag = 'latest',
): Promise<BalanceSnapshot> {
  const { calls, order } = buildBalanceBatch(addresses, blockTag);
  if (calls.length === 0) return { balances: new Map(), failed: [], blockTag };
  const replies = await transport(calls);
  return readBalanceBatch(order, replies, blockTag);
}

/** Sum the balances we have. Addresses with no reading contribute nothing. */
export function totalBalance(snapshot: BalanceSnapshot | null, addresses: string[]): bigint {
  if (!snapshot) return 0n;
  let sum = 0n;
  for (const address of normalizeAddresses(addresses)) {
    sum += snapshot.balances.get(address) ?? 0n;
  }
  return sum;
}

/** True when every requested address has a reading — i.e. the total is exact. */
export function isTotalComplete(snapshot: BalanceSnapshot | null, addresses: string[]): boolean {
  if (!snapshot) return false;
  return normalizeAddresses(addresses).every((a) => snapshot.balances.has(a));
}

export function balanceOf(snapshot: BalanceSnapshot | null, address: string): bigint | null {
  if (!snapshot) return null;
  const value = snapshot.balances.get(address.trim().toLowerCase());
  return value === undefined ? null : value;
}

/**
 * HTTP transport: one POST, array body, array response. Mirrors the raw-fetch
 * style of `probeRpc` rather than going through a provider, so the batch is
 * literally one request and not at the mercy of a batching heuristic.
 */
export function httpBatchTransport(url: string, timeoutMs = 8000): BatchTransport {
  return async (calls) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`RPC responded ${res.status}`);
      const body = (await res.json()) as JsonRpcReply[] | JsonRpcReply;
      return Array.isArray(body) ? body : [body];
    } finally {
      clearTimeout(timer);
    }
  };
}
