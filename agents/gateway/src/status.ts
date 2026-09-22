// GET /api/status — one machine-readable health page for the whole gateway,
// so an agent (or a monitor) can decide whether to retry before it hires
// anyone. /api/health answers "is the process up"; this answers "is every
// moving part keeping up and funded": RPC head vs indexed block, the v3
// indexer, the x402 facilitator's gas, the relayer that sponsors the faucet
// and AgentAccount calls, the faucet's daily budget, the pay-in watcher, the
// webhook queue and the database.
//
// Every service reports {ok, enabled?, detail?} plus its own numbers, and the
// top level lists the ones that are not ok in `degraded`. Nothing here needs a
// key: it is the status page a stranger reads before trusting the network.
import type { FastifyInstance } from "fastify";
import type { JsonRpcProvider } from "ethers";
import { formatEther } from "ethers";
import type { Db } from "./db.js";
import { getMeta } from "./db.js";
import type { GatewayConfig } from "./config.js";
import { CHAIN } from "./constants.js";
import { GATEWAY_VERSION } from "./openapi.js";
import { FAUCET_DRIP_WEI, FAUCET_GLOBAL_PER_DAY } from "./v3/faucet.js";
import { dayStart, type V3Context } from "./v3/context.js";
import type { X402Facilitator } from "./v3/x402.js";
import type { PayinWatcher } from "./v3/payin.js";

/** head − indexedBlock above this is reported as a degraded indexer */
export const STATUS_MAX_BLOCK_LAG = 30;
/** relayer/facilitator balance below this is reported as low funds */
export const STATUS_MIN_GAS_WEI = 10n ** 17n; // 0.1 FMX
/** cached RPC reads: the status page is public and cheap to hammer */
export const STATUS_CACHE_MS = 5_000;

export interface ServiceStatus {
  ok: boolean;
  enabled?: boolean;
  detail?: string;
  [k: string]: unknown;
}

export interface StatusReport {
  ok: boolean;
  version: string;
  now: number;
  uptimeS: number;
  chainId: number | null;
  head: number | null;
  indexedBlock: number | null;
  headLag: number | null;
  indexerLagSeconds: number | null;
  degraded: string[];
  services: Record<string, ServiceStatus>;
  links: Record<string, string>;
}

export interface StatusOptions {
  db: Db;
  cfg: GatewayConfig;
  provider: JsonRpcProvider;
  v3: V3Context;
  x402: X402Facilitator;
  payin: PayinWatcher;
  /** process start (unix ms); default: now at registration */
  startedAt?: number;
  /** response cache window (ms); tests pass 0 */
  cacheMs?: number;
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  try {
    return (db.prepare(sql).get(...params) as { c: number }).c;
  } catch {
    return 0;
  }
}

function fmx(wei: bigint | null): string | null {
  return wei === null ? null : formatEther(wei);
}

export async function buildStatus(opts: StatusOptions, startedAt: number): Promise<StatusReport> {
  const { db, cfg, provider, v3, x402, payin } = opts;
  const now = v3.nowS();
  const services: Record<string, ServiceStatus> = {};

  // --- RPC ---
  const t0 = Date.now();
  let head: number | null = null;
  let chainId: number | null = null;
  let rpcError: string | null = null;
  try {
    head = await provider.getBlockNumber();
    chainId = Number((await provider.getNetwork()).chainId);
  } catch (err) {
    rpcError = (err as Error).message;
  }
  services.rpc = {
    ok: head !== null && (chainId === null || chainId === CHAIN.chainId),
    url: cfg.rpcUrl,
    head,
    chainId,
    latencyMs: Date.now() - t0,
    ...(rpcError ? { detail: `RPC unreachable: ${rpcError}` } : {}),
    ...(chainId !== null && chainId !== CHAIN.chainId ? { detail: `RPC reports chain ${chainId}, expected ${CHAIN.chainId}` } : {}),
  };

  // --- indexer ---
  const indexedRaw = getMeta(db, "indexedBlock");
  const indexedBlock = indexedRaw !== undefined ? Number(indexedRaw) : null;
  const headLag = head !== null && indexedBlock !== null ? Math.max(head - indexedBlock, 0) : null;
  const indexerLagSeconds = headLag === null ? null : headLag * CHAIN.blockTimeSeconds;
  services.indexer = {
    ok: indexedBlock !== null && (headLag === null || headLag <= STATUS_MAX_BLOCK_LAG),
    indexedBlock,
    lagBlocks: headLag,
    lagSeconds: indexerLagSeconds,
    deployBlock: cfg.deployBlock,
    pollMs: cfg.pollMs,
    ...(indexedBlock === null ? { detail: "the indexer has not written a checkpoint yet" } : headLag !== null && headLag > STATUS_MAX_BLOCK_LAG ? { detail: `${headLag} blocks behind head (threshold ${STATUS_MAX_BLOCK_LAG})` } : {}),
  };

  // --- v3 indexer (same loop, separate backfill checkpoint) ---
  const watched = Object.entries(v3.contracts).filter(([, a]) => typeof a === "string").map(([k]) => k);
  services.v3indexer = {
    ok: services.indexer.ok,
    enabled: watched.length > 0,
    contracts: watched,
    deployBlock: cfg.v3DeployBlock ?? null,
    backfilled: getMeta(db, "v3Backfilled") !== undefined,
    indexedBlock,
    lagBlocks: headLag,
    ...(watched.length === 0 ? { detail: "no v3 contract addresses configured" } : {}),
  };

  // --- x402 facilitator ---
  const facilitator = await x402.facilitatorStatus();
  let facBal: bigint | null = null;
  try {
    facBal = facilitator.balance === null ? null : BigInt(facilitator.balance);
  } catch {
    facBal = null;
  }
  services.facilitator = {
    ok: !x402.enabled || (facBal !== null && facBal >= STATUS_MIN_GAS_WEI),
    enabled: x402.enabled,
    address: facilitator.address,
    balanceFmx: fmx(facBal),
    lowFunds: facilitator.lowFunds,
    queued: x402.queuedCount(),
    batchMs: cfg.x402BatchMs,
    vault: v3.address("x402Vault") ?? null,
    ...(!x402.enabled ? { detail: v3.address("x402Vault") ? "FACILITATOR_KEY unset — vouchers are verified and queued but never settled" : "X402Vault is not deployed" } : facBal !== null && facBal < STATUS_MIN_GAS_WEI ? { detail: `facilitator ${facilitator.address} is low on gas (${fmx(facBal)} FMX) — settlement batches will stall` } : {}),
  };

  // --- relayer (gas sponsorship + faucet payer) ---
  let relayerBal: bigint | null = null;
  if (v3.relayer) {
    try {
      relayerBal = await provider.getBalance(v3.relayer.address);
    } catch {
      relayerBal = null;
    }
  }
  services.relayer = {
    ok: !v3.relayer || (relayerBal !== null && relayerBal >= STATUS_MIN_GAS_WEI),
    enabled: !!v3.relayer,
    address: v3.relayer?.address ?? null,
    balanceFmx: fmx(relayerBal),
    lowFunds: relayerBal !== null && relayerBal < STATUS_MIN_GAS_WEI,
    relaysToday: count(db, "SELECT COUNT(*) AS c FROM relays WHERE kind = 'relay' AND createdAt >= ?", dayStart(now)),
    accountImpl: v3.address("accountImpl") ?? null,
    ...(!v3.relayer ? { detail: "RELAYER_KEY unset — gasless onboarding and the faucet are off" } : relayerBal !== null && relayerBal < STATUS_MIN_GAS_WEI ? { detail: `relayer ${v3.relayer.address} holds ${fmx(relayerBal)} FMX — top it up or the faucet stops` } : {}),
  };

  // --- faucet (shares the relayer wallet) ---
  const usedToday = count(db, "SELECT COUNT(*) AS c FROM relays WHERE kind = 'faucet' AND createdAt >= ? AND ok = 1", dayStart(now));
  const drips = relayerBal === null ? null : Number(relayerBal / FAUCET_DRIP_WEI);
  services.faucet = {
    ok: !!v3.relayer && usedToday < FAUCET_GLOBAL_PER_DAY && (drips === null || drips > 0),
    enabled: !!v3.relayer,
    dripFmx: formatEther(FAUCET_DRIP_WEI),
    usedToday,
    remainingToday: Math.max(FAUCET_GLOBAL_PER_DAY - usedToday, 0),
    dripsFunded: drips,
    ...(!v3.relayer ? { detail: "RELAYER_KEY unset — POST /api/faucet answers 503" } : usedToday >= FAUCET_GLOBAL_PER_DAY ? { detail: "today's faucet budget is spent; it resets at 00:00 UTC" } : drips === 0 ? { detail: "the relayer cannot fund another drip" } : {}),
  };

  // --- pay-in watcher ---
  services.payin = {
    ok: true,
    enabled: payin.enabled,
    hotWallet: v3.payinHot?.address ?? null,
    pollMs: cfg.payinPollMs,
    openQuotes: count(db, "SELECT COUNT(*) AS c FROM payins WHERE status IN ('quoted','seen')"),
    paid: count(db, "SELECT COUNT(*) AS c FROM payins WHERE status = 'paid'"),
    ...(payin.enabled ? {} : { detail: "PAYIN_HOT_KEY unset — POST /api/payin/quote answers 503" }),
  };

  // --- webhook queue ---
  const pending = count(db, "SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'pending'");
  const failed24h = count(db, "SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'failed' AND createdAt >= ?", now - 86_400);
  services.webhooks = {
    ok: pending < 500,
    active: count(db, "SELECT COUNT(*) AS c FROM webhooks WHERE active = 1"),
    pending,
    failed24h,
    tickMs: cfg.webhookTickMs,
    ...(pending >= 500 ? { detail: `${pending} deliveries queued — endpoints are not answering` } : {}),
  };

  // --- database ---
  let sizeBytes: number | null = null;
  try {
    const pageCount = Number((db.pragma("page_count", { simple: true }) as number) || 0);
    const pageSize = Number((db.pragma("page_size", { simple: true }) as number) || 0);
    sizeBytes = pageCount * pageSize;
  } catch {
    sizeBytes = null;
  }
  services.db = {
    ok: sizeBytes !== null,
    sizeBytes,
    agents: count(db, "SELECT COUNT(*) AS c FROM agents"),
    jobs: count(db, "SELECT COUNT(*) AS c FROM jobs"),
    activity: count(db, "SELECT COUNT(*) AS c FROM activity"),
    ...(sizeBytes === null ? { detail: "could not read the SQLite page count" } : {}),
  };

  const degraded = Object.entries(services).filter(([, s]) => !s.ok).map(([k]) => k);
  const b = cfg.publicUrl.replace(/\/+$/, "");
  return {
    ok: degraded.length === 0,
    version: GATEWAY_VERSION,
    now,
    uptimeS: Math.max(Math.floor((Date.now() - startedAt) / 1000), 0),
    chainId,
    head,
    indexedBlock,
    headLag,
    indexerLagSeconds,
    degraded,
    services,
    links: { page: `${b}/status/`, health: `${b}/api/health`, stats: `${b}/api/stats`, changelog: `${b}/api/changelog`, work: `${b}/api/work` },
  };
}

export function registerStatusRoutes(app: FastifyInstance, opts: StatusOptions): void {
  const startedAt = opts.startedAt ?? Date.now();
  const cacheMs = opts.cacheMs ?? STATUS_CACHE_MS;
  let cached: { at: number; value: StatusReport } | null = null;

  app.get("/api/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (_req, reply) => {
    if (cached && Date.now() - cached.at < cacheMs) {
      reply.header("cache-control", `public, max-age=${Math.ceil(cacheMs / 1000)}`);
      return cached.value;
    }
    const value = await buildStatus(opts, startedAt);
    cached = { at: Date.now(), value };
    reply.header("cache-control", `public, max-age=${Math.ceil(cacheMs / 1000)}`);
    if (!value.ok) reply.header("x-ferminux-degraded", value.degraded.join(","));
    return value;
  });
}
