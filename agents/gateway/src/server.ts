import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { JsonRpcProvider, Contract } from "ethers";
import { loadConfig, type GatewayConfig } from "./config.js";
import { openDb, getMeta, type Db } from "./db.js";
import { REGISTRY_ABI, ESCROW_ABI, JobStatusName, AgentStatusName } from "./abi.js";
import { startIndexer } from "./indexer.js";
import { startHealthProbe } from "./health.js";
import { storePayload, getPayload, servableContentType, MAX_PAYLOAD_BYTES } from "./payloads.js";
import { agentRowToView, jobRowToView, type AgentRow, type JobRow } from "./types.js";
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
import { slugify } from "./v3/a2a.js";
import { applyV3Event } from "./v3/indexer-v3.js";
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
  /** Addendum v3 overrides for tests: fetch used by webhook delivery + the /a/<slug>/invoke proxy */
  v3?: {
    fetchImpl?: typeof fetch;
    /** pay-in test hooks: a PriceFeed subclass with stubbed pool reads, fake BNB/Base providers for the watcher */
    priceFeed?: PriceFeed;
    payinProviderFor?: PayinWatcherOptions["providerFor"];
  };
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
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: MAX_PAYLOAD_BYTES, trustProxy: true });

  await app.register(cors, { origin: "*" });
  await app.register(rateLimit, { global: false });

  // Catch-all raw-body parser: POST /api/payloads accepts any content-type
  // (JSON, text, or arbitrary bytes) and we hash the exact bytes received.
  // Fastify's built-in 'application/json' and 'text/plain' parsers would
  // otherwise take precedence over a '*' parser and decode the body before
  // we can hash the exact bytes, so replace them too.
  app.removeContentTypeParser(["application/json", "text/plain"]);
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/api/health", async () => {
    const head = await provider.getBlockNumber().catch(() => -1);
    const chainId = await provider
      .getNetwork()
      .then((n) => Number(n.chainId))
      .catch(() => null);
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

  app.post(
    "/api/payloads",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = req.body as Buffer;
      if (!body || body.length === 0) return reply.code(400).send({ error: "empty body" });
      if (body.length > MAX_PAYLOAD_BYTES) {
        return reply.code(413).send({ error: "payload too large (max 256 KiB)" });
      }
      const contentType = (req.headers["content-type"] as string) || "application/octet-stream";
      return storePayload(db, body, contentType);
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
  const priceFeed = opts.v3?.priceFeed ?? new PriceFeed(cfg.bscRpcUrl, { fixedPriceUsd: cfg.payinPriceUsd, minPriceUsd: cfg.payinMinPriceUsd, now });
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
  // Open work (one feed of everything an agent can earn from), status page, changelog
  registerWorkRoutes(app, { db, cfg, commons: commonsCtx, activity }, { heartbeatMs: opts.commons?.sseHeartbeatMs });
  registerStatusRoutes(app, { db, cfg, provider, v3, x402, payin });
  registerChangelogRoutes(app, { cfg, commons: commonsCtx });
  const detachWebhooks = webhooks.attachActivity(activity);
  const detachOracle = workers ? attachValidationOracle(v3, activity) : () => undefined;
  indexerHooks.onV3Event = (ev) => applyV3Event({ db, activity, webhooks }, ev);
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
  const stopHealth = workers ? startHealthProbe(db, cfg.probeMs) : () => undefined;
  const stopToolProbe = workers ? startToolProbe(db, cfg.toolProbeMs) : () => undefined;
  const stopWebhooks = workers ? webhooks.start(cfg.webhookTickMs) : () => undefined;
  const stopX402 = workers ? x402.start(cfg.x402BatchMs) : () => undefined;
  const stopPayin = workers ? payin.start(cfg.payinPollMs) : () => undefined;
  // Growth — referral payouts from GROWTH_KEY (no key → rows stay pending, worker is a no-op)
  const referralPayout = new ReferralPayout({ db, activity, provider, growthKey: cfg.growthKey, rewardFmx: cfg.referralRewardFmx, maxPerReferrerPerDay: cfg.referralMaxPerReferrerPerDay, maxPerDay: cfg.referralMaxPerDay, nowS: commonsCtx.nowS });
  const stopReferrals = workers ? referralPayout.start(cfg.referralTickMs) : () => undefined;

  app.addHook("onClose", async () => {
    stopIndexer();
    stopHealth();
    stopToolProbe();
    stopWebhooks();
    stopX402();
    stopPayin();
    stopReferrals();
    detachWebhooks();
    detachOracle();
    priceFeed.destroy();
    provider.destroy();
    db.close();
  });

  return { app, cfg, activity, indexerHooks, v3, x402, webhooks, payin, referralPayout };
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
