import { parseEther } from "ethers";
import Fastify from "fastify";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ferminux } from "@ferminux/agent";
import { loadState, type HandledState } from "./state.js";
import { handleOneJob as handleJob, type JobClient } from "./jobs.js";
import { agentSendQueue, sdkSettleClient, startSettleLoop, SETTLE_INTERVAL_MS, SETTLE_MIN_WITHDRAW_WEI, SETTLE_STREAM_MIN_WEI } from "./settle.js";
import { echoHandler } from "./handlers/echo.js";
import { llmHandler } from "./handlers/llm.js";
import { toolsHandler } from "./handlers/tools.js";
import { chainHandler } from "./handlers/chain.js";
import type { Handler } from "./handlers/util.js";
import { registerInbox } from "./inbox.js";
import { registerDirectCallRoutes } from "./direct.js";
import { startWatchers, registerWebhook, verifyWebhookSignature, acceptDelivery, secretEquals, WEBHOOK_RECONCILE_POLL_MS, AUTO_CLAIM_MAX_PER_DAY } from "./watch.js";
import { autoClaimTick, httpWorkClient, parseKinds } from "./autoclaim.js";
import { startMemoryAnchor, ANCHOR_INTERVAL_MS } from "./anchor.js";

export interface ServeOptions {
  id: number;
  port: number;
  handlerName: HandlerName;
  /** --auto-claim / AGENT_AUTO_CLAIM=1 — poll GET /api/work and act on matching items */
  autoClaim?: boolean;
  /** --dry-run / AGENT_AUTO_CLAIM_DRY_RUN=1 — log what --auto-claim would take; write nothing */
  dryRun?: boolean;
  /** AGENT_AUTO_CLAIM_MAX_PER_DAY (default 20) */
  autoClaimMaxPerDay?: number;
  /** --anchor-memory / AGENT_ANCHOR_MEMORY=1 — fold this agent's memory writes into a merkle root and commit it on chain on a cadence */
  anchorMemory?: boolean;
  /** --anchor-every <minutes> / AGENT_ANCHOR_INTERVAL_MIN (default 60) */
  anchorIntervalMs?: number;
  /** AGENT_AUTO_SETTLE (default on; =0 off) — claim escrow jobs past review, streams, subs; withdraw credits */
  autoSettle?: boolean;
  /** AGENT_SETTLE_INTERVAL_MIN (default 15) */
  settleIntervalMs?: number;
}

/** A built-in handler name, or a path to a module exporting one (`./handler.js`). */
export type HandlerName = "llm" | "echo" | "tools" | "chain" | (string & {});

const POLL_MS = 5000;
/** A Paused/Retired agent cannot be hired, so polling its (empty) job list every 5 s only burns gateway log
 * space — nine paused runtimes were ~90 % of the gateway's request log. AGENT_PAUSED_POLL_MS overrides. */
const PAUSED_POLL_MS = Number(process.env.AGENT_PAUSED_POLL_MS) > 0 ? Number(process.env.AGENT_PAUSED_POLL_MS) : 60_000;
const AGENT_ACTIVE = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for anything that is not one of the four built-ins — treated as a module path. */
export function isHandlerPath(name: string): boolean {
  return name !== "llm" && name !== "echo" && name !== "tools" && name !== "chain";
}

/**
 * Resolves `--handler`: one of the four built-ins, or a path to a module whose
 * default (or named `handler`) export is a `Handler` — what `ferminux-agent
 * init` scaffolds as `handler.js`.
 */
export async function selectHandler(name: HandlerName): Promise<Handler> {
  if (!isHandlerPath(name)) {
    return name === "llm" ? llmHandler : name === "tools" ? toolsHandler : name === "chain" ? chainHandler : echoHandler;
  }
  const url = pathToFileURL(isAbsolute(name) ? name : resolve(process.cwd(), name)).href;
  const mod = (await import(url)) as { default?: unknown; handler?: unknown };
  const fn = typeof mod.default === "function" ? mod.default : typeof mod.handler === "function" ? mod.handler : null;
  if (!fn) throw new Error(`handler module ${name} must export a function (default or "handler")`);
  return fn as Handler;
}

interface AgentCardCache {
  agentId: number;
  name: string;
  owner: string;
  pricePerJob: string;
  /** registry status: 1 = Active, 2 = Paused, 3 = Retired */
  status: number;
}

type Log = { info: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void };

export async function serve(opts: ServeOptions): Promise<void> {
  const fmx = new Ferminux({
    privateKey: process.env.FERMINUX_PRIVATE_KEY,
    rpc: process.env.FERMINUX_RPC,
    gateway: process.env.FERMINUX_GATEWAY,
    registry: process.env.FERMINUX_REGISTRY,
    escrow: process.env.FERMINUX_ESCROW,
  });
  fmx.requireSigner(); // serving requires a signer (delivers jobs on-chain)

  const dataDir = process.env.DATA_DIR || "./data";
  const statePath = join(dataDir, `agent-${opts.id}-jobs.json`);
  const handler = await selectHandler(opts.handlerName);

  let cardAgent: AgentCardCache | null = null;
  const refreshAgent = async (): Promise<AgentCardCache> => {
    const agent = await fmx.registry.getAgent(opts.id);
    cardAgent = {
      agentId: opts.id,
      name: agent.name as string,
      owner: agent.owner as string,
      pricePerJob: (agent.pricePerJob as bigint).toString(),
      status: Number(agent.status ?? AGENT_ACTIVE),
    };
    return cardAgent;
  };
  await refreshAgent();
  // Wrapped in its own closure so TS's control-flow narrowing of `cardAgent`
  // resets per call (reading `cardAgent?.name` directly after the `??
  // refreshAgent()` expressions above otherwise narrows to `never` — a real
  // quirk of this TS version's aliased-condition analysis across the
  // `refreshAgent` closure, not a logic bug).
  const agentName = (): string => cardAgent?.name ?? `agent-${opts.id}`;

  const capabilities = (process.env.AGENT_CAPABILITIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Addendum v3: capture the raw JSON body too (needed to verify the webhook HMAC signature).
  const app = Fastify({ logger: true });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body : String(body);
    (_req as unknown as { rawBody?: string }).rawBody = raw;
    try {
      done(null, raw.length ? JSON.parse(raw) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/.well-known/ferminux-agent.json", async () => {
    const info = cardAgent ?? (await refreshAgent());
    return {
      ferminux: 1,
      agentId: info.agentId,
      name: info.name,
      description: process.env.AGENT_DESCRIPTION || "",
      owner: info.owner,
      capabilities,
      inputSchema: { type: "string", description: "plain text or JSON {text|prompt|messages}" },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" }, output: { type: "string" } } },
      pricePerJob: info.pricePerJob,
      // v3: wei per direct /invoke call (x402); the gateway reads this to price /a/<slug>/invoke on our behalf
      ...(process.env.PRICE_PER_CALL ? { pricePerCall: parseEther(process.env.PRICE_PER_CALL).toString() } : {}),
      model: opts.handlerName === "llm" ? process.env.LLM_MODEL || "" : opts.handlerName,
      contact: process.env.AGENT_CONTACT || "",
      version: "1.0.0",
    };
  });

  // Addendum v3 — PRICE_PER_CALL puts POST /invoke AND POST /a2a behind x402 (direct pay-per-call, no escrow
  // job): fmx.x402.requirePayment() checks the gateway facilitator (/api/x402/verify + /api/x402/settle)
  // before the handler ever runs. /a2a used to run the handler with no check at all, so anyone calling
  // <endpoint>/a2a on a priced agent got its service free.
  const pricePerCall = process.env.PRICE_PER_CALL;
  // When the gateway fronts us (nginx routes /a/<slug>/invoke to it) it charges the caller itself and forwards
  // with a shared secret — don't charge twice. Without GATEWAY_INVOKE_SECRET every call must carry its own voucher.
  const gwSecret = process.env.GATEWAY_INVOKE_SECRET;
  const makeGate = (resource: string) => {
    const requirePayment = fmx.x402.requirePayment(Number(pricePerCall), { resource, description: `${agentName()} — pay-per-call` });
    const gate: typeof requirePayment.fastify = async (request, reply) => {
      if (gwSecret && secretEquals(request.headers?.["x-ferminux-gateway-secret"], gwSecret)) return;
      return requirePayment.fastify(request, reply);
    };
    return gate;
  };
  const notForSale = async () => {
    const info = cardAgent ?? (await refreshAgent());
    return {
      ok: false,
      error: "this agent does not sell direct calls — set PRICE_PER_CALL to price POST /invoke",
      agentId: info.agentId,
      pricePerJob: info.pricePerJob,
      hire: "POST /api/jobs {agentId, input} on the gateway, or fmx.hire({agentId, input}) in the SDK",
    };
  };

  // Addendum v3 — A2A Agent Card (SPEC.md "## G.", "## S."). Mirrors the gateway's
  // per-agent proxy card at /a/<slug>/.well-known/agent.json, served directly here too.
  const publicUrl = (process.env.AGENT_PUBLIC_URL || `http://localhost:${opts.port}`).replace(/\/+$/, "");
  app.get("/.well-known/agent.json", async () => {
    const info = cardAgent ?? (await refreshAgent());
    return {
      name: info.name,
      description: process.env.AGENT_DESCRIPTION || "",
      // the JSON-RPC endpoint itself, not the agent's base URL
      url: `${publicUrl}/a2a`,
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      skills: capabilities.map((c) => ({ id: c, name: c })),
      // advertise x402 only when a call actually costs something; an unpriced agent sells through escrow only
      authentication: { schemes: pricePerCall ? ["x402-ferminux"] : [] },
      ...(info.status !== AGENT_ACTIVE ? { status: "paused" } : {}),
    };
  });

  app.get("/health", async () => ({ ok: true, agentId: opts.id, handler: opts.handlerName }));

  // Direct messages forwarded by the gateway (POST <endpoint>/inbox)
  const autoreply = process.env.AGENT_AUTOREPLY === "1";
  registerInbox(app, {
    fmx,
    inboxPath: join(dataDir, "inbox.jsonl"),
    agentName,
    agentId: opts.id,
    handlerName: opts.handlerName,
    handler,
    autoreply,
    // a Paused agent never auto-replies (otherwise topping up a shared LLM key silently switches it back on)
    isActive: () => (cardAgent?.status ?? AGENT_ACTIVE) === AGENT_ACTIVE,
  });
  if (autoreply && opts.handlerName !== "llm") {
    app.log.warn("AGENT_AUTOREPLY=1 ignored: auto-reply only works with --handler llm");
  }

  // POST /invoke and POST /a2a: both behind the same x402 gate when priced, both 404 when not (direct.ts)
  registerDirectCallRoutes(app, { handler, gate: pricePerCall ? makeGate : null, notForSale });
  if (pricePerCall) app.log.info(`PRICE_PER_CALL=${pricePerCall} — POST /invoke and POST /a2a are x402-priced`);

  // Addendum v3 — webhook receiver (see registerWebhook() below): the gateway
  // POSTs matching events here instead of this agent polling for them.
  app.post("/webhooks/ferminux", async (request, reply) => {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      reply.code(404);
      return { ok: false, error: "webhooks not configured (set WEBHOOK_URL + WEBHOOK_SECRET)" };
    }
    const raw = (request as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    const sigHeader = request.headers["x-ferminux-signature"] as string | undefined;
    if (!verifyWebhookSignature(secret, raw, sigHeader)) {
      reply.code(401);
      return { ok: false, error: "bad X-Ferminux-Signature" };
    }
    // gateway payload: {id, event, ts, webhookId, data} (older builds sent `type`)
    const event = (request.body ?? {}) as { id?: string; event?: string; type?: string; ts?: number; data?: Record<string, unknown> };
    const type = event.event ?? event.type;
    if (!acceptDelivery(event)) {
      reply.code(409);
      return { ok: false, error: "stale or replayed delivery" };
    }
    app.log.info({ type }, "webhook received");
    if (type === "job.requested") {
      const jobId = Number(event.data?.jobId);
      const agentId = Number(event.data?.agentId ?? opts.id);
      if (Number.isInteger(jobId) && agentId === opts.id) {
        void handleOneJob(fmx, jobId, statePath, handler, app.log).catch((err) => app.log.error({ err, jobId }, "webhook-triggered job handling failed"));
      }
    }
    return { ok: true };
  });

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  app.log.info(`ferminux-agent ${opts.id} serving on :${opts.port} (handler=${opts.handlerName})`);

  // Addendum v3 — register the webhook (job.requested + dm.received) once listening,
  // so WEBHOOK_URL can point back at this very server.
  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  let usingWebhooks = false;
  if (webhookUrl && webhookSecret) {
    usingWebhooks = await registerWebhook(fmx, webhookUrl, webhookSecret, app.log);
  } else if (webhookUrl || webhookSecret) {
    app.log.warn("WEBHOOK_URL and WEBHOOK_SECRET must both be set — falling back to polling");
  }

  // Commons: presence every 2 min; bounty / arena watchers (llm handler only)
  const watchBounties = process.env.AGENT_WATCH_BOUNTIES === "1";
  const watchArena = process.env.AGENT_WATCH_ARENA === "1";
  if ((watchBounties || watchArena) && opts.handlerName !== "llm") {
    app.log.warn("AGENT_WATCH_BOUNTIES / AGENT_WATCH_ARENA ignored: watchers only work with --handler llm");
  }
  // --auto-claim: one watcher over GET /api/work (jobs + bounties + arena in one
  // list). Jobs addressed to this agent are left to the poll/webhook path above.
  const autoClaim = opts.autoClaim === true;
  const dryRun = opts.dryRun === true;
  if (autoClaim && isHandlerPath(opts.handlerName)) {
    app.log.info("--auto-claim: your handler writes the claim pitch — return JSON {\"match\":bool,\"pitch\":\"…\"}");
  } else if (autoClaim && opts.handlerName !== "llm") {
    app.log.warn(`--auto-claim with --handler ${opts.handlerName}: the handler writes the pitch, so only the llm handler will match anything`);
  }
  const watchProfile = {
    agentId: opts.id,
    name: agentName,
    description: process.env.AGENT_DESCRIPTION || "",
    capabilities,
    prompt: process.env.AGENT_PROMPT,
  };
  const watchStatePath = join(dataDir, `agent-${opts.id}-watch.json`);
  const autoClaimOpts = {
    fmx,
    work: httpWorkClient(fmx.gatewayUrl),
    handler,
    profile: watchProfile,
    statePath: watchStatePath,
    log: app.log,
    maxPerDay: opts.autoClaimMaxPerDay ?? AUTO_CLAIM_MAX_PER_DAY,
    dryRun,
    kinds: parseKinds(process.env.AGENT_AUTO_CLAIM_KINDS),
    skipPosters: (process.env.AGENT_AUTO_CLAIM_SKIP_POSTERS ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  };
  const stopWatchers = startWatchers({
    fmx,
    handler,
    profile: watchProfile,
    statePath: watchStatePath,
    log: app.log,
    presence: true,
    bounties: watchBounties && opts.handlerName === "llm",
    arena: watchArena && opts.handlerName === "llm",
    autoClaim: autoClaim ? () => autoClaimTick(autoClaimOpts) : undefined,
    status: () =>
      `serving jobs (${opts.handlerName})${watchBounties ? ", watching bounties" : ""}${watchArena ? ", watching arena" : ""}` +
      `${autoClaim ? (dryRun ? ", auto-claim (dry run)" : ", auto-claiming work") : ""}`,
  });
  if (autoClaim) {
    app.log.info({ dryRun, maxPerDay: autoClaimOpts.maxPerDay }, dryRun ? "auto-claim dry run: nothing will be claimed" : "auto-claim enabled");
  }

  // --anchor-memory: one transaction per batch, on a cadence, from this agent's
  // own key. After it lands, nothing this agent wrote can be altered or silently
  // dropped — a gap in the sequence is visible to anyone. It does not prove the
  // log is complete; see anchor.ts.
  const stopAnchor = opts.anchorMemory
    ? startMemoryAnchor({ fmx, agentId: opts.id, log: app.log, intervalMs: opts.anchorIntervalMs ?? ANCHOR_INTERVAL_MS, dryRun, queue: agentSendQueue })
    : null;

  // Collect what the agent earned (settle.ts): escrow claims after the review window, stream and
  // subscription claims, then withdraw the credits — from this same key, on a cadence. On unless
  // AGENT_AUTO_SETTLE=0; --dry-run makes it log instead of send.
  const fmxAmount = (v: string | undefined, def: bigint) => { try { return v ? parseEther(v) : def; } catch { return def; } };
  const stopSettle = opts.autoSettle !== false
    ? startSettleLoop({
        client: sdkSettleClient(fmx, agentSendQueue),
        agentId: opts.id,
        statePath: join(dataDir, `agent-${opts.id}-settle.json`),
        log: app.log,
        dryRun,
        intervalMs: opts.settleIntervalMs ?? SETTLE_INTERVAL_MS,
        minWithdrawWei: fmxAmount(process.env.AGENT_SETTLE_MIN_WITHDRAW_FMX, SETTLE_MIN_WITHDRAW_WEI),
        streamMinWei: fmxAmount(process.env.AGENT_SETTLE_STREAM_MIN_FMX, SETTLE_STREAM_MIN_WEI),
      })
    : null;
  app.log.info({ autoSettle: opts.autoSettle !== false, dryRun }, opts.autoSettle !== false ? "auto-settle on: claims escrow/stream/sub pay and withdraws credits" : "auto-settle off (AGENT_AUTO_SETTLE=0)");

  let stopped = false;
  process.on("SIGINT", () => (stopped = true));
  process.on("SIGTERM", () => (stopped = true));

  // Webhooks are the primary delivery path once registered; polling continues as
  // a slow reconciliation safety net for deliveries that were missed or failed.
  const pollMs = usingWebhooks ? WEBHOOK_RECONCILE_POLL_MS : POLL_MS;

  while (!stopped) {
    let active = true;
    try {
      const info = await refreshAgent();
      active = info.status === AGENT_ACTIVE;
      await pollOnce(fmx, opts.id, statePath, handler, app.log);
    } catch (err) {
      app.log.error({ err }, "poll tick failed");
    }
    await sleep(active ? pollMs : Math.max(pollMs, PAUSED_POLL_MS));
  }

  stopWatchers();
  if (stopSettle) stopSettle();
  if (stopAnchor) await stopAnchor();
  await app.close();
}

/** The escrow calls handleOneJob needs, bound to this agent's SDK client (and so its signer). */
function jobClient(fmx: Ferminux): JobClient {
  return {
    status: async (jobId) => Number((await fmx.escrow.getJob(jobId)).status),
    input: (jobId) => fmx.jobs.input(jobId),
    // one key, one queue (settle.ts agentSendQueue): never in parallel with a settle, anchor or validation send
    deliver: (jobId, output) => agentSendQueue(() => fmx.jobs.deliver({ jobId, output })),
    cancel: (jobId) => agentSendQueue(() => fmx.jobs.cancel(jobId)),
  };
}

async function pollOnce(
  fmx: Ferminux,
  agentId: number,
  statePath: string,
  handler: Handler,
  log: Log,
): Promise<void> {
  const state: HandledState = loadState(statePath);

  const { items } = await fmx.gatewayGet<{ items: Array<{ id: number; amount: string }> }>(
    `/agents/${agentId}/jobs?status=open`,
  );

  for (const job of items) {
    if (state[String(job.id)]) continue; // already delivered or permanently abandoned

    const agent = await fmx.agents.get(agentId).catch(() => null);
    const price = agent ? BigInt(agent.pricePerJob) : 0n;
    if (BigInt(job.amount) < price) {
      // Below the agent's current price — leave it; the client can refund after the delivery window.
      continue;
    }

    await handleOneJob(fmx, job.id, statePath, handler, log);
  }
}

/**
 * Handles a single job end to end (jobs.ts: re-checks on-chain status, fetches input, runs the handler,
 * delivers — or declines on chain when the agent cannot serve it — and persists the outcome). Shared by the
 * poll loop and the webhook receiver (`POST /webhooks/ferminux`, job.requested events).
 */
async function handleOneJob(fmx: Ferminux, jobId: number, statePath: string, handler: Handler, log: Log): Promise<void> {
  await handleJob(jobClient(fmx), jobId, statePath, handler, log);
}
