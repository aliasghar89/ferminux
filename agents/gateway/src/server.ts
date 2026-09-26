import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { JsonRpcProvider, Contract } from "ethers";
import { loadConfig, type GatewayConfig } from "./config.js";
import { openDb, getMeta, type Db } from "./db.js";
import { REGISTRY_ABI, ESCROW_ABI, JobStatusName, AgentStatusName } from "./abi.js";
import { startIndexer } from "./indexer.js";
import { startHealthProbe } from "./health.js";
import { hashPayload, storePayloadDetailed, getPayload, servableContentType, MAX_PAYLOAD_BYTES, PayloadQuota, prunePayloads } from "./payloads.js";
import { startDbBackups } from "./backup.js";
import { startAlerts } from "./alerts.js";
import { agentRowToView, jobRowToView, setReviewWindowS, type AgentRow, type JobRow } from "./types.js";
import { computeStats } from "./stats.js";
import { registerCommons, type CommonsOptions } from "./commons/routes.js";
import { ActivityBus } from "./commons/activity.js";
import { makeIndexerHooks } from "./commons/hooks.js";
import { startToolProbe } from "./commons/tools.js";
import { ReferralPayout, referralRules } from "./commons/referrals.js";
import { registerDiscovery } from "./discovery.js";
import { registerWorkRoutes } from "./work.js";
import { registerStatusRoutes } from "./status.js";
import { registerChangelogRoutes } from "./changelog.js";
import { registerValidatorRoutes } from "./validators.js";
import { SupplyService, registerSupplyRoutes } from "./supply.js";
import { FIXED_CONTRACTS } from "./constants.js";
import { V3_CONTRACT_KEYS } from "./config.js";
import { GATEWAY_VERSION } from "./openapi.js";
import { createV3Context } from "./v3/context.js";
import { WebhookBus, registerWebhookRoutes } from "./v3/webhooks.js";
import { X402Facilitator, registerX402Routes } from "./v3/x402.js";
import { registerMemoryRoutes } from "./v3/memory.js";
import { registerMemoryAnchorRoutes } from "./v3/memory-anchor.js";
import { registerComputeRoutes } from "./v3/compute.js";
import { registerA2aRoutes } from "./v3/a2a.js";
import { registerErc8004Routes } from "./v3/erc8004.js";
import { PayinWatcher, PriceFeed, registerPayinRoutes, type PayinWatcherOptions } from "./v3/payin.js";
import { registerRelayRoutes } from "./v3/relay.js";
import { registerAuditRoutes } from "./v3/audit.js";
import { registerFaucetRoutes } from "./v3/faucet.js";
import { registerV3ReadRoutes } from "./v3/reads.js";
import { cvLinks, registerCvRoutes } from "./v3/cv.js";
import { registerNetworkRoutes } from "./v3/network.js";
import { registerCvContextRoutes } from "./v3/cv-context.js";
import { registerLoadtestRoutes } from "./loadtest.js";
import { slugify } from "./v3/a2a.js";
import { applyV3Event, reconcileStreamCancels } from "./v3/indexer-v3.js";
import { attachValidationOracle, validationForJob, agentValidations } from "./v3/validation.js";

export interface BuildOptions {
  /** pre-opened DB (tests use openMemoryDb()); default opens $DATA_DIR/agents.db */
  db?: Db;
  /** config override; default loadConfig() from env */
  cfg?: GatewayConfig;
  /** start the indexer + health probe (default true; tests pass false) */
  workers?: boolean;
  /** commons plugin overrides (clock, forwarder, SSE heartbeat) for tests */
  commons?: Omit<CommonsOptions, "db" | "cfg" | "activity">;
  /** fastify logger (default true) */
  logger?: boolean;
  /** supply service override (tests pass one wired to a fake RPC) */
  supply?: SupplyService;
  /** Addendum v3 overrides for tests: fetch used by webhook delivery + the /a/<slug>/invoke proxy */
  v3?: {
    fetchImpl?: typeof fetch;
    /** pay-in test hooks: a PriceFeed subclass with stubbed pool reads, fake BNB/Base providers for the watcher */
    priceFeed?: PriceFeed;
    payinProviderFor?: PayinWatcherOptions["providerFor"];
  };
}

/**
 * Request logging. The 12 agent runtimes poll GET /api/agents/N/jobs every 5 s — ~90 % of all log lines — and
 * rotated the 5×20 MB json-file log in under 14 h, so pay-in and x402 disputes lost their evidence within a day.
 * Successful, fast GET/HEAD/OPTIONS requests (and presence pings) are no longer logged; every write, every money
 * route (/api/payin, /api/x402, /api/relay, /api/faucet, /api/accounts, /api/referrals, /a/…), every non-2xx and
 * every slow (> 2 s) request still is, and error logs are never suppressed. LOG_ALL_REQUESTS=1 restores all.
 */
const MONEY_ROUTE = /^\/(api\/(payin|x402|relay|faucet|accounts|referrals)|a\/)/;
function quietRequest(req: { method: string; url: string }): boolean {
  if (process.env.LOG_ALL_REQUESTS === "1") return false;
  if (req.method === "POST" && req.url.startsWith("/api/presence")) return true;
  return (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") && !MONEY_ROUTE.test(req.url);
}
class GatewayLogController extends LogController {
  override incomingRequest(request: FastifyRequest, reply: FastifyReply, metadata?: Record<string, unknown>): void {
    if (quietRequest(request)) return;
    super.incomingRequest(request, reply, metadata);
  }
  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply, metadata?: Record<string, unknown>): void {
    if (!error && quietRequest(request) && reply.statusCode < 400 && reply.elapsedTime < 2000) return;
    super.requestCompleted(error, request, reply, metadata);
  }
}

/** unbounded job listings were a full-table dump; page them (the web UI and SDK read the newest first) */
const JOBS_DEFAULT_LIMIT = 500;
const JOBS_MAX_LIMIT = 2000;

function resolveAgentStatus(input?: string): number | undefined {
  if (!input) return undefined;
  const idx = AgentStatusName.findIndex((n) => n.toLowerCase() === input.toLowerCase());
  return idx >= 0 ? idx : undefined;
}

function resolveJobStatus(input?: string): number | undefined {
  if (!input) return undefined;
  const idx = JobStatusName.findIndex((n) => n.toLowerCase() === input.toLowerCase());
  return idx >= 0 ? idx : undefined;
}

export async function buildServer(opts: BuildOptions = {}) {
  const cfg = opts.cfg ?? loadConfig();
  const db = opts.db ?? openDb(cfg.dataDir);
  const workers = opts.workers ?? true;
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const registry = new Contract(cfg.registry, REGISTRY_ABI, provider);
  const escrow = new Contract(cfg.escrow, ESCROW_ABI, provider);

  // trustProxy: nginx fronts us and sets X-Forwarded-For; without it every external client shares one rate-limit bucket (nginx's IP)
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: MAX_PAYLOAD_BYTES, trustProxy: true, logController: new GatewayLogController() });

  await app.register(cors, { origin: "*" });

  // Per-IP limits. Every route gets a default (RATE_LIMIT_MAX per minute, 300) unless it sets its own — before
  // this only a dozen routes had any limit and /api/health cost three RPC calls per unauthenticated request.
  // Commons writes also share ONE per-IP budget across all their routes (COMMONS_IP_WRITES_PER_MIN, 30): the
  // per-address 1 write/s rule alone is free to bypass, since a new key costs nothing.
  const COMMONS_WRITE = /^\/api\/(forum|messages|bounties|kb|tools|artifacts|arena|presence|referrals)(\/|$|\?)/;
  const commonsPerMin = Number(process.env.COMMONS_IP_WRITES_PER_MIN) > 0 ? Number(process.env.COMMONS_IP_WRITES_PER_MIN) : 30;
  const commonsHits = new Map<string, { start: number; n: number }>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE") return;
    if (!COMMONS_WRITE.test(req.url)) return;
    const t = Date.now();
    const key = String(req.ip || "?");
    const e = commonsHits.get(key);
    if (!e || t - e.start >= 60_000) commonsHits.set(key, { start: t, n: 1 });
    else if (++e.n > commonsPerMin) {
      reply.header("retry-after", String(Math.ceil((e.start + 60_000 - t) / 1000)));
      return reply.code(429).send({ error: `too many Commons writes from your address: max ${commonsPerMin} per minute`, code: "ip_rate_limited" });
    }
    if (commonsHits.size > 20_000) for (const [k, v] of commonsHits) if (t - v.start >= 60_000) commonsHits.delete(k);
  });
  const rateAllow = (process.env.RATE_LIMIT_ALLOW ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX) > 0 ? Number(process.env.RATE_LIMIT_MAX) : 300,
    timeWindow: "1 minute",
    ...(rateAllow.length ? { allowList: rateAllow } : {}),
  });

  // Catch-all raw-body parser: POST /api/payloads accepts any content-type
  // (JSON, text, or arbitrary bytes) and we hash the exact bytes received.
  // Fastify's built-in 'application/json' and 'text/plain' parsers would
  // otherwise take precedence over a '*' parser and decode the body before
  // we can hash the exact bytes, so replace them too.
  app.removeContentTypeParser(["application/json", "text/plain"]);
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // /api/health is the liveness probe: the chain id is read once and reused (it cannot change without a new
  // RPC URL, i.e. a restart), and the head is cached for 2 s, so a flood costs the RPC node almost nothing.
  let chainIdCache: number | null = null;
  let headCache: { at: number; head: number } | null = null;
  app.get("/api/health", async () => {
    let head: number;
    if (headCache && Date.now() - headCache.at < 2000) head = headCache.head;
    else {
      head = await provider.getBlockNumber().catch(() => -1);
      headCache = { at: Date.now(), head };
    }
    if (chainIdCache === null) {
      chainIdCache = await provider
        .getNetwork()
        .then((n) => Number(n.chainId))
        .catch(() => null);
    }
    const chainId = chainIdCache;
    const indexedBlockRaw = getMeta(db, "indexedBlock");
    const v3Contracts: Record<string, string | null> = {};
    for (const key of V3_CONTRACT_KEYS) v3Contracts[key] = v3.address(key) ?? null;
    const funding = await x402.facilitatorStatus();
    return {
      ok: true,
      version: GATEWAY_VERSION,
      chainId,
      head,
      indexedBlock: indexedBlockRaw !== undefined ? Number(indexedBlockRaw) : null,
      registry: cfg.registry,
      escrow: cfg.escrow,
      /** audit-export signing address (GATEWAY_SIGNING_KEY; ephemeral when unset) */
      signer: v3.signer.address,
      signerEphemeral: v3.signerEphemeral,
      v3: {
        contracts: v3Contracts,
        deployBlock: cfg.v3DeployBlock ?? null,
        deployed: V3_CONTRACT_KEYS.filter((k) => v3.deployed(k)),
        facilitator: x402.enabled ? v3.facilitator!.address : null,
        facilitatorBalance: funding.balance,
        facilitatorLowFunds: funding.lowFunds,
        relayer: v3.relayer && v3.deployed("accountImpl") ? v3.relayer.address : null,
        payin: payin.enabled,
        x402Queued: x402.queuedCount(),
      },
    };
  });

  app.get("/api/stats", async () => computeStats(db));

  app.get<{ Querystring: { status?: string; q?: string; sort?: string; limit?: string; offset?: string } }>(
    "/api/agents",
    async (req) => {
      const { status, q, sort, limit, offset } = req.query;
      const statusNum = resolveAgentStatus(status);
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const off = Math.max(Number(offset) || 0, 0);

      const where: string[] = [];
      const params: unknown[] = [];
      if (statusNum !== undefined) {
        where.push("status = ?");
        params.push(statusNum);
      }
      if (q) {
        where.push("(name LIKE ? OR endpoint LIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // RANK ON WHAT COSTS SOMETHING.
      //
      // ServiceEscrow.requestJob accepts msg.value = 0 and blocks only the
      // agent's own owner from being the client, so a second address you
      // control can mint a completed job and a five-star rating for the price
      // of gas. Ordering by the registry's raw jobsCompleted / ratingSum put
      // whoever spent the most gas at the top of a directory used to choose
      // whom to pay. These sorts count only jobs that MOVED FMX, and break ties
      // on how many distinct addresses did the paying — breadth is the part a
      // self-dealer cannot buy cheaply.
      const PAID_JOBS = "(SELECT COUNT(*) FROM jobs j WHERE j.agentId = agents.id AND j.status IN (3, 6) AND CAST(j.amount AS REAL) > 0)";
      const PAYERS = "(SELECT COUNT(DISTINCT lower(j.client)) FROM jobs j WHERE j.agentId = agents.id AND j.status IN (3, 6) AND CAST(j.amount AS REAL) > 0)";
      const EARNED = "(SELECT COALESCE(SUM(CAST(j.amount AS REAL)), 0) FROM jobs j WHERE j.agentId = agents.id AND j.status IN (3, 6))";
      let orderSql = "registeredAt DESC";
      if (sort === "rating") {
        // A rating on a job worth nothing is worth nothing. Agents with no paid
        // work rank below every agent that has some, whatever their average.
        orderSql = `CASE WHEN ${PAID_JOBS} > 0 AND ratingCount > 0 THEN CAST(ratingSum AS REAL) / ratingCount ELSE -1 END DESC, ${PAYERS} DESC, ${EARNED} DESC`;
      } else if (sort === "jobs") {
        orderSql = `${PAID_JOBS} DESC, ${PAYERS} DESC, ${EARNED} DESC`;
      } else if (sort === "earned") {
        orderSql = `${EARNED} DESC, ${PAYERS} DESC`;
      }

      const total = (db.prepare(`SELECT COUNT(*) AS c FROM agents ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db
        .prepare(`SELECT * FROM agents ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
        .all(...params, lim, off) as AgentRow[];
      return { items: rows.map(agentRowToView), total };
    },
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    if (!row) return reply.code(404).send({ error: "agent not found" });
    const validations = agentValidations(v3, id, 20);
    const scored = validations.filter((v) => v.response !== null);
    const base = cfg.publicUrl.replace(/\/+$/, "");
    return {
      ...agentRowToView(row),
      validation: { count: scored.length, avgResponse: scored.length ? Math.round(scored.reduce((a, v) => a + (v.response ?? 0), 0) / scored.length) : null, latest: validations[0] ?? null },
      /** The agent's public record: the document, the signed credential, how to check it without us, and the badge. */
      cv: { ...cvLinks(base, id, slugify(row.name)), description: "Every claim in the CV carries the transaction or the route that produced it. The chain claims verify against any RPC for chain 3961 without calling Ferminux." },
      links: { a2a: `${base}/a/${id}/.well-known/agent.json`, erc8004: `${base}/api/agents/${id}/erc8004.json`, audit: `${base}/api/agents/${id}/audit.jsonl`, cv: `${base}/api/cv/${id}`, credential: `${base}/api/cv/${id}/credential.json`, badge: `${base}/api/cv/${id}/badge.svg` },
    };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string; offset?: string } }>(
    "/api/agents/:id/jobs",
    async (req) => {
      const id = Number(req.params.id);
      const statusNum = resolveJobStatus(req.query.status);
      const params: unknown[] = [id];
      let sql = "SELECT * FROM jobs WHERE agentId = ?";
      if (statusNum !== undefined) {
        sql += " AND status = ?";
        params.push(statusNum);
      }
      sql += " ORDER BY createdAt DESC LIMIT ? OFFSET ?";
      params.push(Math.min(Math.max(Number(req.query.limit) || JOBS_DEFAULT_LIMIT, 1), JOBS_MAX_LIMIT), Math.max(Number(req.query.offset) || 0, 0));
      const rows = db.prepare(sql).all(...params) as JobRow[];
      const agent = db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined;
      return { items: rows.map((r) => jobRowToView(r, agent?.name ?? null)) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) return reply.code(404).send({ error: "job not found" });
    const agent = db.prepare("SELECT name FROM agents WHERE id = ?").get(row.agentId) as { name: string } | undefined;
    // verifiable delivery (FRC-8004 validation, if any) shown before the client releases
    return { ...jobRowToView(row, agent?.name ?? null), validation: validationForJob(v3, row) };
  });

  app.get<{ Querystring: { client?: string; agentOwner?: string; limit?: string; offset?: string } }>("/api/jobs", async (req) => {
    const { client, agentOwner } = req.query;
    let sql = "SELECT j.* FROM jobs j";
    const where: string[] = [];
    const params: unknown[] = [];
    if (agentOwner) {
      sql += " JOIN agents a ON a.id = j.agentId";
      where.push("a.owner = ?");
      params.push(agentOwner);
    }
    if (client) {
      where.push("j.client = ?");
      params.push(client);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY j.createdAt DESC LIMIT ? OFFSET ?";
    params.push(Math.min(Math.max(Number(req.query.limit) || JOBS_DEFAULT_LIMIT, 1), JOBS_MAX_LIMIT), Math.max(Number(req.query.offset) || 0, 0));
    const rows = db.prepare(sql).all(...params) as JobRow[];

    const agentIds = [...new Set(rows.map((r) => r.agentId))];
    const names = new Map<number, string>();
    if (agentIds.length) {
      const placeholders = agentIds.map(() => "?").join(",");
      const nrows = db.prepare(`SELECT id, name FROM agents WHERE id IN (${placeholders})`).all(...agentIds) as Array<{
        id: number;
        name: string;
      }>;
      for (const nr of nrows) names.set(nr.id, nr.name);
    }
    return { items: rows.map((r) => jobRowToView(r, names.get(r.agentId) ?? null)) };
  });

  const payloadQuota = new PayloadQuota(db);
  app.post(
    "/api/payloads",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = req.body as Buffer;
      if (!body || body.length === 0) return reply.code(400).send({ error: "empty body" });
      if (body.length > MAX_PAYLOAD_BYTES) {
        return reply.code(413).send({ error: "payload too large (max 256 KiB)" });
      }
      const ip = String(req.ip || "?");
      // bytes already stored cost nothing: answer without touching the quota
      const known = hashPayload(body);
      if (db.prepare("SELECT 1 FROM payloads WHERE hash = ?").get(known)) return { hash: known, uri: `fmx://payload/${known}`, size: body.length };
      const denied = payloadQuota.check(ip, body.length);
      if (denied) return reply.code(denied[0]).send({ error: denied[1] });
      const contentType = (req.headers["content-type"] as string) || "application/octet-stream";
      const { inserted, ...out } = storePayloadDetailed(db, body, contentType);
      payloadQuota.record(ip, body.length, inserted);
      return out;
    },
  );

  app.get<{ Params: { hash: string } }>("/api/payloads/:hash", async (req, reply) => {
    const payload = getPayload(db, req.params.hash);
    if (!payload) return reply.code(404).send({ error: "payload not found" });
    // user bytes on our origin: never let them run as a document (stored XSS via text/html payloads)
    reply.header("content-type", servableContentType(payload.contentType));
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    return reply.send(payload.bytes);
  });

  // Commons (forum, messages, bounties, kb, tools, artifacts, activity, arena) and AI discoverability
  const now = opts.commons?.now ?? (() => Date.now());
  const activity = new ActivityBus(db, now);
  const commonsCtx = registerCommons(app, { db, cfg, activity, ...(opts.commons ?? {}) });
  const indexerHooks = makeIndexerHooks(db, activity, { referralRules: referralRules(cfg.referralMinJobFmx) });

  // Addendum v3 — agent economy (x402, webhooks, memory, compute, A2A, FRC-8004, pay-in, relay, audit)
  const webhooks = new WebhookBus(db, now, opts.v3?.fetchImpl);
  const v3 = createV3Context({ db, cfg, provider, commons: commonsCtx, activity, webhooks, fetchImpl: opts.v3?.fetchImpl, feeRecipient: FIXED_CONTRACTS.treasury });
  const x402 = new X402Facilitator(v3);
  const priceFeed = opts.v3?.priceFeed ?? new PriceFeed(cfg.bscRpcUrl, { fixedPriceUsd: cfg.payinPriceUsd, minPriceUsd: cfg.payinMinPriceUsd, now, ferminuxRpcUrl: cfg.rpcUrl, bridgeStatusUrl: cfg.bridgeStatusUrl });
  const payin = new PayinWatcher(v3, { providerFor: opts.v3?.payinProviderFor });
  registerX402Routes(app, v3, x402);
  registerWebhookRoutes(app, commonsCtx, webhooks);
  registerMemoryRoutes(app, v3, x402);
  registerMemoryAnchorRoutes(app, v3);
  registerComputeRoutes(app, v3);
  registerA2aRoutes(app, v3, x402);
  registerErc8004Routes(app, v3);
  registerPayinRoutes(app, v3, payin, priceFeed);
  registerRelayRoutes(app, v3);
  registerAuditRoutes(app, v3);
  registerFaucetRoutes(app, v3);
  registerV3ReadRoutes(app, v3);
  // The record lane: the AI-CV document, its signed credential, the verification
  // recipe, the badge, and the hiring graph.
  registerCvContextRoutes(app);
  registerCvRoutes(app, v3);
  registerNetworkRoutes(app, v3);
  // Wizrd's labelled load test: counters, wallet membership, manifest (read-only files from agents/loadtest)
  registerLoadtestRoutes(app, { dir: process.env.LOADTEST_DIR ?? "/loadtest", publicUrl: cfg.publicUrl });
  // Open work (one feed of everything an agent can earn from), status page, changelog
  registerWorkRoutes(app, { db, cfg, commons: commonsCtx, activity }, { heartbeatMs: opts.commons?.sseHeartbeatMs });
  registerStatusRoutes(app, { db, cfg, provider, v3, x402, payin });
  registerChangelogRoutes(app, { cfg, commons: commonsCtx });
  // Validator programme waitlist (ferminux.net/validators/): sign-ups, the public count, the operator export
  registerValidatorRoutes(app, { db, commons: commonsCtx });
  // FMX supply from chain 3961 (plain numbers for listing sites + the JSON breakdown) and the CoinGecko-shaped
  // coin record the explorer's market source reads
  const supply = opts.supply ?? new SupplyService({ rpc: provider, db });
  registerSupplyRoutes(app, supply, priceFeed);
  const detachWebhooks = webhooks.attachActivity(activity);
  const detachOracle = workers ? attachValidationOracle(v3, activity) : () => undefined;
  indexerHooks.onV3Event = (ev) => applyV3Event({ db, activity, webhooks }, ev);
  try {
    const n = reconcileStreamCancels(db);
    if (n) app.log.info({ streams: n }, "reconciled claimed totals of cancelled streams");
  } catch (err) {
    app.log.error({ err: (err as Error).message }, "stream cancel reconcile failed");
  }
  const v3Watch = V3_CONTRACT_KEYS.filter((k) => v3.deployed(k) && k !== "accountImpl").map((key) => ({ key, address: v3.address(key)!, iface: v3.iface(key) }));

  registerDiscovery(app, { db, cfg, v3 });

  const stopIndexer = workers
    ? startIndexer(
        {
          provider,
          registry,
          escrow,
          registryAddress: cfg.registry,
          escrowAddress: cfg.escrow,
          db,
          deployBlock: cfg.deployBlock,
          hooks: indexerHooks,
          v3: { contracts: v3Watch, deployBlock: cfg.v3DeployBlock },
        },
        cfg.pollMs,
      )
    : () => undefined;
  if (workers) void (escrow.reviewWindow() as Promise<bigint>).then((v) => setReviewWindowS(Number(v))).catch(() => undefined);
  const stopHealth = workers ? startHealthProbe(db, cfg.probeMs) : () => undefined;
  const stopToolProbe = workers ? startToolProbe(db, cfg.toolProbeMs) : () => undefined;
  const stopWebhooks = workers ? webhooks.start(cfg.webhookTickMs) : () => undefined;
  const stopX402 = workers ? x402.start(cfg.x402BatchMs) : () => undefined;
  const stopPayin = workers ? payin.start(cfg.payinPollMs) : () => undefined;
  // Growth — referral payouts from GROWTH_KEY (no key → rows stay pending, worker is a no-op)
  const referralPayout = new ReferralPayout({ db, activity, provider, growthKey: cfg.growthKey, rewardFmx: cfg.referralRewardFmx, maxPerReferrerPerDay: cfg.referralMaxPerReferrerPerDay, maxPerDay: cfg.referralMaxPerDay, nowS: commonsCtx.nowS });
  const stopReferrals = workers ? referralPayout.start(cfg.referralTickMs) : () => undefined;
  // Daily: prune unreferenced old payloads (see payloads.ts)
  let stopPrune: () => void = () => undefined;
  if (workers) {
    const prune = () => {
      try {
        const r = prunePayloads(db);
        if (r.deleted) {
          payloadQuota.invalidate();
          app.log.info({ deleted: r.deleted, bytes: r.bytes }, "pruned unreferenced payloads");
        }
      } catch (err) {
        app.log.error({ err: (err as Error).message }, "payload prune failed");
      }
    };
    const first = setTimeout(prune, 60_000);
    const every = setInterval(prune, 86_400_000);
    first.unref?.();
    every.unref?.();
    stopPrune = () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }
  // Keep the supply answer (and its burn tracker) warm, so a listing site's poll never waits on a catch-up
  let stopSupply: () => void = () => undefined;
  if (workers) {
    const warm = () => void supply.snapshot().catch((err) => app.log.warn({ err: (err as Error).message }, "supply snapshot failed"));
    const first = setTimeout(warm, 30_000);
    const every = setInterval(warm, 300_000);
    first.unref?.();
    every.unref?.();
    stopSupply = () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }
  // Consistent SQLite snapshots of agents.db (pay-ins, x402 vouchers, referrals, Commons) — see backup.ts
  const stopBackups = workers ? startDbBackups(db, cfg, app.log) : () => undefined;
  // Push alerts (Telegram / webhook) on degraded status and notable Commons events — see alerts.ts
  const stopAlerts = workers ? startAlerts({ db, cfg, provider, v3, x402, payin, activity, log: app.log }) : () => undefined;

  app.addHook("onClose", async () => {
    stopIndexer();
    stopHealth();
    stopToolProbe();
    stopWebhooks();
    stopX402();
    stopPayin();
    stopReferrals();
    stopPrune();
    stopSupply();
    stopBackups();
    stopAlerts();
    detachWebhooks();
    detachOracle();
    priceFeed.destroy();
    provider.destroy();
    db.close();
  });

  return { app, cfg, activity, indexerHooks, v3, x402, webhooks, payin, referralPayout, supply };
}

async function main() {
  const { app, cfg } = await buildServer();
  try {
    await app.listen({ port: cfg.port, host: "0.0.0.0" });
    app.log.info(`ferminux gateway listening on :${cfg.port} (public: ${cfg.publicUrl})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only auto-start when this module is run directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
