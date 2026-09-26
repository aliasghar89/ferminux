/* Agent data from the Ferminux gateway (surfaces/explorer.md §4.14, §6.3, §6.5).
   CORS checked 2026-09-24: every route answers `access-control-allow-origin: *` (preflight 204), so the
   browser calls https://ferminux.net/api directly; no proxy. CSP connect-src already lists ferminux.net.
   A gateway failure never breaks a page: agent cards and job rails hide and one line says
   "Agent details unavailable from ferminux.net right now." (§8.3). */
import { getJson } from "./api";
import { swr, TTL, peek } from "./cache";
import { lc } from "./util";

export const GW_BASE = (import.meta.env.VITE_GATEWAY ?? "https://ferminux.net/api").replace(/\/$/, "");
export const GW_DOWN = "Agent details unavailable from ferminux.net right now.";

export interface Agent {
  id: number; owner: string; name: string; endpoint: string; metadataURI: string;
  pricePerJob: string; bond: string; status: "Active" | "Paused" | "Retired" | string;
  registeredAt: number; jobsCompleted: number; jobsFailed: number; ratingCount: number; ratingAvg: number | null;
  card: unknown | null; online: boolean; lastSeen: number | null;
}
export interface AgentDetail extends Agent {
  validation?: { count: number; avgResponse: number | null; latest: unknown | null };
  cv?: Record<string, string>;
  links?: Record<string, string>;
}
export interface AgentWallet { account: string; owner: string; createdAt: number; txHash: string }
export interface AgentToken { token: string; agentId: number; symbol: string; launchedAt: number; buys: number; sells: number; fmxIn: string; fmxOut: string; txLaunched: string; agentName: string; owner: string }
export type JobStatus = "Requested" | "Delivered" | "Completed" | "Released" | "Claimed" | "Refunded" | "Disputed" | "Resolved" | string;
export interface Job {
  id: number; agentId: number; agentName: string; client: string; amount: string;
  inputHash: string; inputURI: string; outputHash: string | null; outputURI: string | null;
  createdAt: number; deliveredAt: number | null; status: JobStatus;
  tx: { requested: string | null; delivered: string | null; closed: string | null };
  validation?: unknown | null;
}
export interface GwStats {
  agents: number; activeAgents: number; jobs: number; jobsCompleted: number; volumeWei: string; feesWei: string;
  x402VolumeWei: string; x402Settlements: number; streamsOpen: number; tokensLaunched: number; accountsCreated: number; [k: string]: unknown;
}
type Items<T> = { items: T[]; total?: number };

const u = (path: string) => `${GW_BASE}${path}`;
const get = <T>(path: string, ttl: number, signal?: AbortSignal) => swr<T>(u(path), ttl, (s) => getJson<T>(u(path), s, { retries: 1 }), { signal });

export const gw = {
  agents: (s?: AbortSignal) => get<Items<Agent>>("/agents?limit=50", TTL.gw, s).then((r) => r.items),
  agent: (id: number, s?: AbortSignal) => get<AgentDetail>(`/agents/${id}`, TTL.gw, s),
  /** Agent wallets (AgentAccount). `owner=` does filter here (unlike /agents). */
  accounts: (s?: AbortSignal) => get<Items<AgentWallet>>("/accounts?limit=100", TTL.gw, s).then((r) => r.items),
  tokens: (s?: AbortSignal) => get<Items<AgentToken>>("/tokens", TTL.gw, s).then((r) => r.items),
  jobs: (q: { limit?: number; agentOwner?: string; client?: string } = {}, s?: AbortSignal) => {
    const p = new URLSearchParams();
    if (q.limit) p.set("limit", String(q.limit));
    if (q.agentOwner) p.set("agentOwner", q.agentOwner);
    if (q.client) p.set("client", q.client);
    return get<Items<Job>>(`/jobs?${p}`, TTL.gw, s).then((r) => r.items);
  },
  job: (id: number, s?: AbortSignal) => get<Job>(`/jobs/${id}`, 30_000, s),
  stats: (s?: AbortSignal) => get<GwStats>("/stats", TTL.gw, s),
  network: (agentId?: number, s?: AbortSignal) => get<unknown>(agentId ? `/network?agentId=${agentId}` : "/network", TTL.gw, s),
  cv: (id: number, s?: AbortSignal) => get<unknown>(`/cv/${id}`, TTL.gw, s),
};

/* ---- synchronous lookups over whatever lists are cached (the name book warms them) ---- */
const cachedAgents = () => peek<Items<Agent>>(u("/agents?limit=50"))?.items ?? [];
const cachedWallets = () => peek<Items<AgentWallet>>(u("/accounts?limit=100"))?.items ?? [];
/** Agents owned by an address (the gateway ignores `owner=` on /agents, so match here; 13 agents). */
export const agentsOwnedBy = (addr: string) => cachedAgents().filter((a) => lc(a.owner) === lc(addr));
export const agentById = (id: number) => cachedAgents().find((a) => a.id === id);
export const walletOf = (addr: string) => cachedWallets().find((w) => lc(w.account) === lc(addr));

/** Links out to ferminux.net for an agent. */
export const agentLinks = (id: number) => ({
  record: `https://ferminux.net/cv/?agent=${id}`,
  page: `https://ferminux.net/agents/?id=${id}`,
  job: (jobId: number) => `${GW_BASE}/jobs/${jobId}`,
  payload: (hash: string) => `${GW_BASE}/payloads/${hash}`,
});
