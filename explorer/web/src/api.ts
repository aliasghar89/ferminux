/* The index client: a typed Blockscout REST v2 client (surfaces/explorer.md §1.3, §1.4; API.md).
   - Base: same origin "/api/v2" in production; `npm run dev` proxies it to explorer.ferminux.net.
   - Every call goes through the SWR cache (cache.ts), takes the page's AbortSignal, times out at 10 s and
     retries twice on a network error or a 5xx (never on a 4xx or a timeout).
   - Normalisers run here, so no page ever sees a backend word (§1.4).
   - Never called, on purpose: /transactions/:h/summary (403), /raw-trace (500), any /internal-transactions
     (always empty), /stats-service/* (404), stats.gas_prices (wrong), stats.total_blocks (stale). */
import { swr, TTL, peek, drop } from "./cache";
import { knownContract, POSA_BLOCK } from "./known";
import type {
  Account, Address, AddressCounters, Block, BlockCountdown, CoinBalance, CoinBalanceDay, IndexingStatus, Log, PageParams, Paged,
  Redirect, SearchItem, SmartContract, SmartContractsCounters, StateChange, Stats, TabsCounters, TokenBalance, TokenCounters,
  TokenHolder, TokenInfo, TokenInstance, TokenTransfer, Tx, TxChartPoint, TxStats, VerificationConfig, Capped,
} from "./types";

export const API_BASE = (import.meta.env.VITE_API_BASE ?? "/api/v2").replace(/\/$/, "");
const TIMEOUT = 10_000;

/* ------------------------------------------------------------------ errors */

export type ApiErrorKind = "offline" | "timeout" | "server" | "not_found" | "invalid" | "http";
export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, public status: number, message: string, public detail = "", public url = "") { super(message); this.name = "ApiError"; }
  /** 404 or 422: render the explorer's own not-found state (§5.15). */
  get notFound() { return this.kind === "not_found" || this.kind === "invalid"; }
}

/** The copy for an error, per §8.3 (the status in mono is added by the UI). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.kind === "offline") return "You're offline. The explorer will refresh when you're back.";
    if (e.kind === "timeout") return "The explorer's index didn't answer within 10 seconds.";
    if (e.kind === "server") return `The explorer's index didn't answer (HTTP ${e.status}).`;
    if (e.kind === "not_found") return "Not found on chain 3961.";
    if (e.kind === "invalid") return e.detail || "That isn't a valid value.";
    return `The explorer's index returned HTTP ${e.status}.`;
  }
  return "The request failed.";
}

/* ------------------------------------------------------------------ transport */

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController();
  let out = false;
  const t = setTimeout(() => { out = true; ctl.abort(); }, ms);
  const fwd = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener("abort", fwd, { once: true }); }
  return { signal: ctl.signal, timedOut: () => out, done: () => { clearTimeout(t); signal?.removeEventListener("abort", fwd); } };
}

/** GET JSON with timeout + retries. Exported for the gateway client, which shares the policy. */
export async function getJson<T>(url: string, signal?: AbortSignal, o: { timeout?: number; retries?: number } = {}): Promise<T> {
  const retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const t = withTimeout(signal, o.timeout ?? TIMEOUT);
    let res: Response;
    try {
      res = await fetch(url, { signal: t.signal, headers: { accept: "application/json" } });
    } catch (e) {
      t.done();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (t.timedOut()) throw new ApiError("timeout", 0, "timeout", "", url);
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new ApiError("offline", 0, "offline", "", url);
      if (attempt < retries) { await delay(400 * (attempt + 1)); continue; }
      throw new ApiError("offline", 0, String((e as Error)?.message ?? e), "", url);
    }
    t.done();
    if (res.ok) return (await res.json()) as T;
    const body = await res.json().catch(() => null) as { message?: string; errors?: { detail?: string }[] } | string | null;
    const msg = typeof body === "string" ? body : body?.message ?? body?.errors?.[0]?.detail ?? res.statusText;
    const detail = typeof body === "object" && body ? body.errors?.[0]?.detail ?? "" : "";
    if (res.status >= 500) {
      if (attempt < retries) { await delay(400 * (attempt + 1)); continue; }
      throw new ApiError("server", res.status, msg, detail, url);
    }
    if (res.status === 404) throw new ApiError("not_found", 404, msg, detail, url);
    if (res.status === 422) throw new ApiError("invalid", 422, msg, detail, url);
    throw new ApiError("http", res.status, msg, detail, url);
  }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ normalisers (§1.4) */

const ZERO_RE = /^0x0{40}$/i;
const frc = (s: string) => s.replace(/^ERC-(\d+)$/, "FRC-$1");
/** Our FRC-* labels back to the index's query values (the wire keeps its own identifiers). */
const erc = (s: string) => s.replace(/^FRC-(\d+)$/, "ERC-$1");

function normBlock(o: Record<string, unknown>) {
  const height = Number(o.height);
  const era = height >= POSA_BLOCK ? "authority" : "pow";
  const m = o.miner as { hash?: string } | null | undefined;
  delete o.miner;
  const zero = !m || !m.hash || ZERO_RE.test(m.hash);
  o.era = era;
  o.signer = era === "authority" && !zero ? m : null;
  o.producer = era === "pow" && !zero ? m : null;
  // The index names the same rewards two ways: the block detail says "Miner Reward" / "Emission Reward", the
  // lists (/blocks, /addresses/:a/blocks-validated) say "validator" / "emission_funds". Both map to our words.
  // A forked or uncle block is not canonical: whatever the index lists for it, it earned nothing.
  const rw = o.type === "reorg" || o.type === "uncle" ? [] : Array.isArray(o.rewards) ? (o.rewards as { type: string; reward: string }[]) : [];
  const isOwn = (t: string) => t === "Miner Reward" || t === "validator";
  const isEm = (t: string) => t === "Emission Reward" || t === "emission_funds";
  const em = rw.filter((r) => isEm(r.type)).sort((a, b) => (BigInt(b.reward) > BigInt(a.reward) ? 1 : -1));
  o.rewards = rw.map((r) => ({
    reward: r.reward,
    type: isOwn(r.type) ? (era === "authority" ? "signer" : "producer")
      : isEm(r.type) ? (r === em[0] ? "sink" : "treasury") // larger = reward sink (50 %), smaller = treasury (10 %)
      : r.type === "Uncle Reward" ? "uncle" : r.type.toLowerCase(),
  }));
}

/** Deep normaliser applied to every index response. */
export function norm<T>(x: unknown): T {
  if (Array.isArray(x)) return x.map((v) => norm(v)) as T;
  if (!x || typeof x !== "object") return x as T;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if ((k === "type" || k === "token_type") && typeof v === "string") o[k] = frc(v);
    else if (k === "is_miner") o.isSigner = v;
    else if (k === "validations_count") o.blocksConfirmed = v;
    else if (k === "blocks_validated") o.blocksConfirmed = v;
    else o[k] = norm(v);
  }
  // is_contract fills lazily in the index (API.md #5): for a book contract, false means "unknown" and the book wins.
  if (typeof o.hash === "string" && o.is_contract === false && knownContract(o.hash)) o.is_contract = true;
  if ("height" in o && "miner" in o) normBlock(o);
  return o as T;
}

const cap = (v: unknown): Capped => { const n = Number(v ?? 0); return n >= 51 ? { n: 50, capped: true } : { n, capped: false }; };

/* ------------------------------------------------------------------ query + cursor helpers */

type Q = Record<string, string | number | boolean | null | undefined>;
export function qs(q: Q | undefined): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
const urlOf = (path: string, q?: Q) => `${API_BASE}${path}${qs(q)}`;

/** Paging state carried in the URL (§3.7): ?page=N&next_page_params=<JSON>, possibly double-encoded. */
export interface Cursor { page: number; params: PageParams | null; expired: boolean }
export function readCursor(query: URLSearchParams): Cursor {
  const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  let raw = query.get("next_page_params");
  if (!raw) return { page: 1, params: null, expired: page > 1 };
  for (let i = 0; i < 3; i++) {
    try { const v = JSON.parse(raw); if (v && typeof v === "object") return { page, params: v as PageParams, expired: false }; } catch { /* decode once more */ }
    try { const d = decodeURIComponent(raw); if (d === raw) break; raw = d; } catch { break; }
  }
  return { page: 1, params: null, expired: true };
}
/** The query string we write for a page (single-encoded, Blockscout-compatible). */
export function cursorQuery(page: number, params: PageParams | null, base?: URLSearchParams): string {
  const q = new URLSearchParams(base);
  q.delete("page"); q.delete("next_page_params");
  if (page > 1 && params) { q.set("page", String(page)); q.set("next_page_params", JSON.stringify(params)); }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/* ------------------------------------------------------------------ the client */

export interface ReadOpts<T = unknown> { signal?: AbortSignal; onUpdate?: (v: T) => void; fresh?: boolean }

/** A cached, normalised GET. Use the typed wrappers below; this is exported for one-off endpoints. */
export function bs<T>(path: string, q: Q | undefined, ttl: number, o: ReadOpts<T> = {}): Promise<T> {
  const url = urlOf(path, q);
  return swr<T>(url, ttl, async (s) => norm<T>(await getJson(url, s)), o);
}
/** A paged list: page 1 is cached 5 s, deeper pages 60 s (they only change when the index backfills). */
function list<T>(path: string, next: PageParams | null | undefined, q: Q = {}, o: ReadOpts<Paged<T>> = {}) {
  return bs<Paged<T>>(path, { ...q, ...(next ?? {}) }, next ? 60_000 : TTL.list1, o);
}
const enc = encodeURIComponent;

export const api = {
  // home + stats
  stats: (o?: ReadOpts<Stats>) => bs<Stats>("/stats", undefined, TTL.stats, o),
  txChart: (o?: ReadOpts<{ chart_data: TxChartPoint[] }>) => bs<{ chart_data: TxChartPoint[] }>("/stats/charts/transactions", undefined, 300_000, o),
  txStats: (o?: ReadOpts<TxStats>) => bs<TxStats>("/transactions/stats", undefined, TTL.stats, o),
  indexingStatus: (o?: ReadOpts<IndexingStatus>) => bs<IndexingStatus>("/main-page/indexing-status", undefined, TTL.stats, o),
  mainBlocks: (o?: ReadOpts<Block[]>) => bs<Block[]>("/main-page/blocks", undefined, TTL.list1, o),
  mainTxs: (o?: ReadOpts<Tx[]>) => bs<Tx[]>("/main-page/transactions", undefined, TTL.list1, o),

  // blocks
  blocks: (type: "block" | "reorg" | "uncle", next?: PageParams | null, o?: ReadOpts<Paged<Block>>) => list<Block>("/blocks", next, { type }, o),
  block: (id: string | number, o?: ReadOpts<Block>) => bs<Block>(`/blocks/${enc(String(id))}`, undefined, TTL.block, o),
  blockTxs: (id: string | number, next?: PageParams | null, o?: ReadOpts<Paged<Tx>>) => list<Tx>(`/blocks/${enc(String(id))}/transactions`, next, {}, o),
  blockCountdown: (n: number, o?: ReadOpts<BlockCountdown>) => bs<BlockCountdown>(`/blocks/${n}/countdown`, undefined, 7_000, o),

  // transactions
  txs: (filter: "validated" | "pending", next?: PageParams | null, o?: ReadOpts<Paged<Tx>>) => list<Tx>("/transactions", next, { filter }, o),
  tx: (h: string, o?: ReadOpts<Tx>) => bs<Tx>(`/transactions/${enc(h)}`, undefined, TTL.tx, o),
  txLogs: (h: string, next?: PageParams | null, o?: ReadOpts<Paged<Log>>) => list<Log>(`/transactions/${enc(h)}/logs`, next, {}, o),
  txTokenTransfers: (h: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenTransfer>>) => list<TokenTransfer>(`/transactions/${enc(h)}/token-transfers`, next, {}, o),
  txStateChanges: (h: string, next?: PageParams | null, o?: ReadOpts<Paged<StateChange>>) => list<StateChange>(`/transactions/${enc(h)}/state-changes`, next, {}, o),

  // addresses
  address: (a: string, o?: ReadOpts<Address>) => bs<Address>(`/addresses/${enc(a)}`, undefined, TTL.address, o),
  /** An all-"0" answer means the index hasn't counted this address yet (it counts on first request, then
   *  answers a few seconds later): never keep that one in the cache, so the next read asks again. */
  addressCounters: async (a: string, o?: ReadOpts<AddressCounters>): Promise<AddressCounters> => {
    const r = await bs<AddressCounters>(`/addresses/${enc(a)}/counters`, undefined, TTL.address, o);
    if (countersPending(r)) drop(urlOf(`/addresses/${enc(a)}/counters`));
    return r;
  },
  addressTabsCounters: async (a: string, o?: ReadOpts<TabsCounters>): Promise<TabsCounters> => {
    const r = await bs<Record<string, unknown>>(`/addresses/${enc(a)}/tabs-counters`, undefined, TTL.address, { signal: o?.signal });
    return {
      transactions_count: cap(r.transactions_count), token_transfers_count: cap(r.token_transfers_count), blocksConfirmed: cap(r.blocksConfirmed),
      logs_count: cap(r.logs_count), token_balances_count: cap(r.token_balances_count), internal_transactions_count: cap(r.internal_transactions_count),
      withdrawals_count: cap(r.withdrawals_count),
    };
  },
  addressTxs: (a: string, filter: "from" | "to" | null, next?: PageParams | null, o?: ReadOpts<Paged<Tx>>) => list<Tx>(`/addresses/${enc(a)}/transactions`, next, { filter }, o),
  addressTokenTransfers: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenTransfer>>) => list<TokenTransfer>(`/addresses/${enc(a)}/token-transfers`, next, {}, o),
  addressTokenBalances: (a: string, o?: ReadOpts<TokenBalance[]>) => bs<TokenBalance[]>(`/addresses/${enc(a)}/token-balances`, undefined, TTL.address, o),
  addressTokens: (a: string, type: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenBalance>>) => list<TokenBalance>(`/addresses/${enc(a)}/tokens`, next, { type: erc(type) }, o),
  addressNft: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenInstance>>) => list<TokenInstance>(`/addresses/${enc(a)}/nft`, next, { type: "ERC-721,ERC-404,ERC-1155" }, o),
  addressCoinHistory: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<CoinBalance>>) => list<CoinBalance>(`/addresses/${enc(a)}/coin-balance-history`, next, {}, o),
  addressCoinHistoryByDay: (a: string, o?: ReadOpts<{ items: CoinBalanceDay[]; days: number }>) => bs<{ items: CoinBalanceDay[]; days: number }>(`/addresses/${enc(a)}/coin-balance-history-by-day`, undefined, TTL.address, o),
  addressBlocksConfirmed: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<Block>>) => list<Block>(`/addresses/${enc(a)}/blocks-validated`, next, {}, o),
  addressLogs: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<Log>>) => list<Log>(`/addresses/${enc(a)}/logs`, next, {}, o),
  accounts: (next?: PageParams | null, o?: ReadOpts<Paged<Account>>) => list<Account>("/addresses", next, {}, o),

  // tokens
  tokens: (q?: { q?: string; type?: string }, next?: PageParams | null, o?: ReadOpts<Paged<TokenInfo>>) =>
    list<TokenInfo>("/tokens", next, { q: q?.q, type: q?.type ? erc(q.type) : undefined }, o),
  token: (a: string, o?: ReadOpts<TokenInfo>) => bs<TokenInfo>(`/tokens/${enc(a)}`, undefined, TTL.token, o),
  tokenCounters: (a: string, o?: ReadOpts<TokenCounters>) => bs<TokenCounters>(`/tokens/${enc(a)}/counters`, undefined, TTL.token, o),
  tokenTransfers: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenTransfer>>) => list<TokenTransfer>(`/tokens/${enc(a)}/transfers`, next, {}, o),
  tokenHolders: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenHolder>>) => list<TokenHolder>(`/tokens/${enc(a)}/holders`, next, {}, o),
  tokenInstances: (a: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenInstance>>) => list<TokenInstance>(`/tokens/${enc(a)}/instances`, next, {}, o),
  tokenInstance: (a: string, id: string, o?: ReadOpts<TokenInstance>) => bs<TokenInstance>(`/tokens/${enc(a)}/instances/${enc(id)}`, undefined, TTL.token, o),
  tokenInstanceTransfers: (a: string, id: string, next?: PageParams | null, o?: ReadOpts<Paged<TokenTransfer>>) => list<TokenTransfer>(`/tokens/${enc(a)}/instances/${enc(id)}/transfers`, next, {}, o),
  tokenInstanceTransfersCount: (a: string, id: string, o?: ReadOpts<{ transfers_count: number }>) => bs<{ transfers_count: number }>(`/tokens/${enc(a)}/instances/${enc(id)}/transfers-count`, undefined, TTL.token, o),
  tokenTransfersAll: (type: string | null, next?: PageParams | null, o?: ReadOpts<Paged<TokenTransfer>>) => list<TokenTransfer>("/token-transfers", next, { type: type ? erc(type) : undefined }, o),

  // contracts
  smartContracts: (next?: PageParams | null, o?: ReadOpts<Paged<unknown>>) => list<unknown>("/smart-contracts", next, {}, o),
  smartContractsCounters: (o?: ReadOpts<SmartContractsCounters>) => bs<SmartContractsCounters>("/smart-contracts/counters", undefined, TTL.stats, o),
  smartContract: (a: string, o?: ReadOpts<SmartContract>) => bs<SmartContract>(`/smart-contracts/${enc(a)}`, undefined, 600_000, o),
  verificationConfig: (o?: ReadOpts<VerificationConfig>) => bs<VerificationConfig>("/smart-contracts/verification/config", undefined, 600_000, o),

  // search
  search: (q: string, next?: PageParams | null, o?: ReadOpts<Paged<SearchItem>>) => list<SearchItem>("/search", next, { q }, o),
  searchQuick: (q: string, o?: ReadOpts<SearchItem[]>) => bs<SearchItem[]>("/search/quick", { q }, 30_000, o),
  checkRedirect: (q: string, o?: ReadOpts<Redirect>) => bs<Redirect>("/search/check-redirect", { q }, 30_000, o),
};

/** The index answered /counters before counting the address: every figure is "0". */
export const countersPending = (c: AddressCounters | null | undefined) =>
  !!c && [c.transactions_count, c.token_transfers_count, c.gas_usage_count, c.blocksConfirmed].every((v) => !Number(v));

/** The cached tokens list, if a page has loaded it (symbol matching in the omnibox, the name book). */
export const cachedTokens = () => peek<Paged<TokenInfo>>(urlOf("/tokens", {}))?.items ?? [];

/** Where an index `url` field or a search item points in this app (the index uses the same URL shapes). */
export function searchHref(it: SearchItem): string {
  if (it.type === "token" && it.address_hash) return `/token/${it.address_hash}`;
  if ((it.type === "address" || it.type === "contract") && it.address_hash) return `/address/${it.address_hash}`;
  if (it.type === "block" && it.block_number !== undefined) return `/block/${it.block_number}`;
  if (it.type === "transaction" && it.transaction_hash) return `/tx/${it.transaction_hash}`;
  return it.url ?? "/";
}
