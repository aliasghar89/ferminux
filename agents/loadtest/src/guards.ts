// Safety guards. Checked every GUARD_INTERVAL_S; any failure pauses the runner (no new transaction is
// signed or broadcast) and logs why; it resumes on its own after two healthy checks in a row. A guard
// that cannot be read counts as failed: the load must never be what pushes a small signer set over.
//
//   head      the chain head is older than MAX_HEAD_AGE_S (30 s; blocks are due every 7 s)
//   signers   fewer than MIN_SIGNERS (3) signers confirmed a block in the last 64
//             (clique_status on the RPC; the gateway's /api/status when the RPC lacks the namespace)
//   txpool    more than MAX_TXPOOL_PENDING (2000) transactions pending in the node's pool
//   explorer  the explorer's index is more than MAX_EXPLORER_LAG_BLOCKS (100) behind the head
//   float     the float cannot fund anything and nothing is out to come back (it needs a top-up)
import type { Config } from "./config.js";
import { hexToBig, hexToNum, RpcError, type RpcLike } from "./rpc.js";
import { fmx } from "./amounts.js";

export interface GuardReport {
  ok: boolean;
  /** one short reason per failed guard, e.g. "head is 41 s old" */
  reasons: string[];
  head: number | null;
  headAgeS: number | null;
  baseFee: bigint | null;
  gasUsed: bigint | null;
  gasLimit: bigint | null;
  signers: { active: number; total: number; source: "rpc" | "gateway" } | null;
  txpoolPending: number | null;
  explorerHead: number | null;
  explorerLag: number | null;
  at: number;
}

export interface GuardDeps {
  rpc: RpcLike;
  fetchImpl?: typeof fetch;
  nowS: () => number;
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs = 8000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Signers that confirmed at least one block in clique_status's window. */
export function activeFromCliqueStatus(cs: unknown): { active: number; total: number } | null {
  const act = (cs as { sealerActivity?: Record<string, number | string> } | null)?.sealerActivity;
  if (!act || typeof act !== "object") return null;
  const vals = Object.values(act);
  return { active: vals.filter((n) => Number(n) > 0).length, total: vals.length };
}

/** The gateway's /api/status → services.chain.signers {active,total}. */
export function activeFromGatewayStatus(st: unknown): { active: number; total: number } | null {
  const s = (st as { services?: { chain?: { signers?: { active?: number; total?: number } | null } } } | null)?.services?.chain?.signers;
  if (!s || typeof s.active !== "number" || typeof s.total !== "number") return null;
  return { active: s.active, total: s.total };
}

export async function checkChain(cfg: Config, d: GuardDeps): Promise<GuardReport> {
  const fetchImpl = d.fetchImpl ?? fetch;
  const r: GuardReport = { ok: true, reasons: [], head: null, headAgeS: null, baseFee: null, gasUsed: null, gasLimit: null, signers: null, txpoolPending: null, explorerHead: null, explorerLag: null, at: d.nowS() };
  const fail = (why: string) => { r.ok = false; r.reasons.push(why); };

  // one batch: head, clique_status, txpool_status
  let head: unknown, cs: unknown, pool: unknown;
  try {
    [head, cs, pool] = await d.rpc.batch([
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "clique_status", params: [] },
      { method: "txpool_status", params: [] },
    ]);
  } catch (e) {
    fail(`RPC unreachable: ${(e as Error).message}`);
    return r;
  }

  // head age
  if (head instanceof RpcError || !head || typeof head !== "object") fail("chain head unreadable");
  else {
    const h = head as { number: string; timestamp: string; baseFeePerGas?: string; gasUsed: string; gasLimit: string };
    r.head = hexToNum(h.number);
    r.headAgeS = Math.max(0, d.nowS() - hexToNum(h.timestamp));
    r.baseFee = h.baseFeePerGas ? hexToBig(h.baseFeePerGas) : null;
    r.gasUsed = hexToBig(h.gasUsed);
    r.gasLimit = hexToBig(h.gasLimit);
    if (r.headAgeS > cfg.maxHeadAgeS) fail(`chain head is ${r.headAgeS} s old (limit ${cfg.maxHeadAgeS} s)`);
    if (r.baseFee === null) fail("head block has no base fee");
  }

  // signers
  if (cfg.signerSource !== "off") {
    let sig: { active: number; total: number } | null = null;
    let source: "rpc" | "gateway" = "rpc";
    if (cfg.signerSource !== "gateway" && !(cs instanceof RpcError)) sig = activeFromCliqueStatus(cs);
    if (!sig && cfg.signerSource !== "rpc" && cfg.statusUrl) {
      try {
        sig = activeFromGatewayStatus(await getJson(fetchImpl, cfg.statusUrl));
        source = "gateway";
      } catch { sig = null; }
    }
    if (!sig) fail("signer activity unreadable (clique_status and the gateway status both failed)");
    else {
      r.signers = { ...sig, source };
      if (sig.active < cfg.minSigners) fail(`${sig.active} of ${sig.total} signers confirming (need ${cfg.minSigners})`);
    }
  }

  // txpool
  // a malformed answer (no hex `pending`) fails too: it must not read as an empty pool
  if (pool instanceof RpcError || !pool || typeof pool !== "object" || !/^0x[0-9a-f]+$/i.test(String((pool as { pending?: unknown }).pending))) fail("txpool_status unreadable");
  else {
    r.txpoolPending = hexToNum((pool as { pending?: string }).pending);
    if (r.txpoolPending > cfg.maxTxpoolPending) fail(`${r.txpoolPending} transactions pending in the pool (limit ${cfg.maxTxpoolPending})`);
  }

  // explorer index lag
  if (cfg.explorerApi) {
    try {
      const blocks = (await getJson(fetchImpl, `${cfg.explorerApi}/main-page/blocks`)) as { height?: number }[];
      const top = Array.isArray(blocks) ? Math.max(...blocks.map((b) => Number(b.height)).filter(Number.isFinite)) : NaN;
      if (!Number.isFinite(top)) fail("explorer index answered without blocks");
      else {
        r.explorerHead = top;
        if (r.head !== null) {
          r.explorerLag = Math.max(0, r.head - top);
          if (r.explorerLag > cfg.maxExplorerLag) fail(`explorer index is ${r.explorerLag} blocks behind (limit ${cfg.maxExplorerLag})`);
        }
      }
    } catch (e) {
      fail(`explorer index unreachable: ${(e as Error).message}`);
    }
  }
  return r;
}

export interface IndexCounters { transactions: number | null; addresses: number | null; last24h: number | null }

/**
 * The explorer index's own network figures: total transactions and addresses (EXPLORER_API/stats) and the
 * transactions of the last 24 h (EXPLORER_API/transactions/stats). The index caches these and recounts them
 * now and then (Blockscout: the total every 2 h by default), which is why the runner records its own count
 * each time one of them changes (Runner.readIndex). A figure that can't be read is null. Never throws.
 */
export async function readIndexCounters(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<IndexCounters> {
  const out: IndexCounters = { transactions: null, addresses: null, last24h: null };
  if (!cfg.explorerApi) return out;
  const n = (v: unknown): number | null => {
    if (typeof v !== "string" && typeof v !== "number") return null;
    const x = Number(v);
    return Number.isSafeInteger(x) && x >= 0 ? x : null;
  };
  const [st, ts] = await Promise.allSettled([getJson(fetchImpl, `${cfg.explorerApi}/stats`), getJson(fetchImpl, `${cfg.explorerApi}/transactions/stats`)]);
  if (st.status === "fulfilled" && st.value && typeof st.value === "object") {
    const s = st.value as { total_transactions?: unknown; total_addresses?: unknown };
    out.transactions = n(s.total_transactions);
    out.addresses = n(s.total_addresses);
  }
  if (ts.status === "fulfilled" && ts.value && typeof ts.value === "object") out.last24h = n((ts.value as { transactions_count_24h?: unknown }).transactions_count_24h);
  return out;
}

/** The float guard: pause only when the float cannot fund anything AND nothing is out to come back. */
export function floatReason(cfg: Config, floatBalance: bigint | null, inFlight: bigint): string | null {
  if (floatBalance === null) return "float balance unreadable";
  if (floatBalance < cfg.floatMinWei && inFlight === 0n) return `float holds ${fmx(floatBalance)} FMX, below its ${fmx(cfg.floatMinWei)} FMX minimum: fund the float`;
  return null;
}
