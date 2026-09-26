/* The chain RPC client (surfaces/explorer.md §1.3; API.md §1, §5).
   - Calls made in the same microtask tick go out as ONE JSON-RPC batch (≤ 100 calls). The public RPC allows
     50 req/s per IP and a batch counts as one, so a blocks page asks 50 `clique_getSigner` in one request.
   - 8 s timeout. A 503/429 (rate limit) backs off ×2 up to 30 s for every later call. No blind retries:
     callers render "—" with the title "Chain RPC unavailable" and the head store simply reads again.
   - Each call takes the page's signal; an aborted call is dropped from the batch (or its answer ignored).
   - Not available on this node: debug_*, trace_*, historic state, wss. `clique_getSigner` rejects "latest". */

export const RPC_URL = import.meta.env.VITE_RPC ?? "https://rpc.ferminux.net";
const TIMEOUT = 8_000;
const MAX_BATCH = 100;

export class RpcError extends Error {
  /** `data`: the node's error data (for a revert, the ABI-encoded custom error or Error(string)). */
  constructor(message: string, public kind: "rpc" | "rate" | "timeout" | "offline" | "http", public code?: number, public data?: string) { super(message); this.name = "RpcError"; }
}
/** The title for a field whose chain read failed. */
export const RPC_DOWN = "Chain RPC unavailable";

interface Pending { method: string; params: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void; dead?: boolean }
let queue: Pending[] = [];
let scheduled = false;
let backoffMs = 0, backoffUntil = 0;
const abortErr = () => new DOMException("Aborted", "AbortError");

/** One JSON-RPC call; batched with every other call made in the same tick. */
export function call<T = unknown>(method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(abortErr()); return; }
    const p: Pending = { method, params, resolve: resolve as (v: unknown) => void, reject };
    signal?.addEventListener("abort", () => { p.dead = true; reject(abortErr()); }, { once: true });
    queue.push(p);
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  });
}

function flush() {
  scheduled = false;
  const live = queue.filter((p) => !p.dead);
  queue = [];
  for (let i = 0; i < live.length; i += MAX_BATCH) void send(live.slice(i, i + MAX_BATCH));
}

async function send(batch: Pending[]) {
  const wait = backoffUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const body = batch.map((p, i) => ({ jsonrpc: "2.0", id: i + 1, method: p.method, params: p.params }));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  const fail = (e: RpcError) => batch.forEach((p) => p.reject(e));
  let res: Response;
  try {
    res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.length === 1 ? body[0] : body), signal: ctl.signal });
  } catch {
    clearTimeout(t);
    fail(ctl.signal.aborted ? new RpcError("RPC timeout", "timeout") : new RpcError("RPC unreachable", navigator.onLine === false ? "offline" : "http"));
    return;
  }
  clearTimeout(t);
  if (res.status === 503 || res.status === 429) {
    backoffMs = Math.min(Math.max(backoffMs * 2, 1000), 30_000);
    backoffUntil = Date.now() + backoffMs;
    fail(new RpcError(`RPC rate limited (HTTP ${res.status})`, "rate", res.status));
    return;
  }
  backoffMs = 0;
  if (!res.ok) { fail(new RpcError(`RPC HTTP ${res.status}`, "http", res.status)); return; }
  let json: unknown;
  try { json = await res.json(); } catch { fail(new RpcError("RPC returned invalid JSON", "http")); return; }
  const arr = (Array.isArray(json) ? json : [json]) as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }[];
  const byId = new Map(arr.map((r) => [r.id, r]));
  batch.forEach((p, i) => {
    const r = byId.get(i + 1);
    if (!r) p.reject(new RpcError("RPC dropped the call", "rpc"));
    else if (r.error) p.reject(new RpcError(r.error.message, "rpc", r.error.code, typeof r.error.data === "string" ? r.error.data : undefined));
    else p.resolve(r.result);
  });
}

/* ------------------------------------------------------------------ typed helpers */

export const hex = (n: number | bigint) => "0x" + n.toString(16);
const num = (h: string) => Number(BigInt(h));
/** eth_call data for supportsInterface(0x80ac58cd): an FRC-721 contract answers true. The index lists an FRC-721
 *  only after its first Transfer, so the token pages ask the contract itself (tokens/common.ts chainToken). */
export const FRC721_PROBE = "0x01ffc9a7" + "80ac58cd".padEnd(64, "0");
/** eth_call data for supportsInterface(0xffffffff), which every FRC-165 contract must answer false. Sent in the same
 *  batch as FRC721_PROBE: a contract whose fallback answers any call with a non-zero word is not an FRC-721. */
export const FRC165_INVALID = "0x01ffc9a7" + "ffffffff".padEnd(64, "0");

/** eth_getBlockByNumber(n, false) as returned by the node: every quantity is a 0x hex string. */
export interface RawBlock {
  number: string; hash: string; parentHash: string; timestamp: string; miner: string; difficulty: string;
  extraData: string; gasLimit: string; gasUsed: string; baseFeePerGas?: string; size: string; nonce: string;
  mixHash: string; sha3Uncles: string; stateRoot: string; transactionsRoot: string; receiptsRoot: string; logsBloom: string;
  totalDifficulty?: string; transactions: (string | RawTx)[]; uncles: string[];
}
export interface RawTx { hash: string; from: string; to: string | null; value: string; input: string; nonce: string; blockNumber: string | null; gas: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; type?: string }
export interface CliqueStatus { inturnPercent: number; sealerActivity: Record<string, number>; numBlocks: number }

export const rpc = {
  call,
  blockNumber: async (s?: AbortSignal) => num(await call<string>("eth_blockNumber", [], s)),
  block: (tag: number | "latest", s?: AbortSignal) => call<RawBlock | null>("eth_getBlockByNumber", [tag === "latest" ? tag : hex(tag), false], s),
  blockByHash: (h: string, s?: AbortSignal) => call<RawBlock | null>("eth_getBlockByHash", [h, false], s),
  /** The confirming signer of an authority block (lower-case). Never "latest": the node rejects it. */
  cliqueGetSigner: (n: number, s?: AbortSignal) => call<string>("clique_getSigner", [hex(n)], s).then((a) => a.toLowerCase()),
  cliqueGetSigners: (s?: AbortSignal) => call<string[]>("clique_getSigners", [], s).then((l) => l.map((a) => a.toLowerCase())),
  cliqueStatus: async (s?: AbortSignal): Promise<CliqueStatus> => {
    const r = await call<CliqueStatus>("clique_status", [], s);
    return { ...r, sealerActivity: Object.fromEntries(Object.entries(r.sealerActivity ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  },
  gasPrice: async (s?: AbortSignal) => BigInt(await call<string>("eth_gasPrice", [], s)),
  maxPriorityFee: async (s?: AbortSignal) => BigInt(await call<string>("eth_maxPriorityFeePerGas", [], s)),
  balance: async (a: string, s?: AbortSignal) => BigInt(await call<string>("eth_getBalance", [a, "latest"], s)),
  code: (a: string, s?: AbortSignal) => call<string>("eth_getCode", [a, "latest"], s),
  tx: (h: string, s?: AbortSignal) => call<RawTx | null>("eth_getTransactionByHash", [h], s),
  ethCall: (to: string, data: string, s?: AbortSignal, tag: number | "latest" = "latest") => call<string>("eth_call", [{ to, data }, tag === "latest" ? tag : hex(tag)], s),
};
