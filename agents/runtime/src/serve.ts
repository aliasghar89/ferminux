import { parseEther } from "ethers";
import Fastify from "fastify";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Ferminux, JobStatusEnum } from "@ferminux/agent";
import { loadState, saveState, type HandledState } from "./state.js";
import { echoHandler } from "./handlers/echo.js";
import { llmHandler } from "./handlers/llm.js";
import { toolsHandler } from "./handlers/tools.js";
import { chainHandler } from "./handlers/chain.js";
import type { Handler } from "./handlers/util.js";
import { registerInbox } from "./inbox.js";
import { startWatchers, registerWebhook, verifyWebhookSignature, acceptDelivery, secretEquals, WEBHOOK_RECONCILE_POLL_MS, AUTO_CLAIM_MAX_PER_DAY } from "./watch.js";
import { autoClaimTick, httpWorkClient } from "./autoclaim.js";

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
}

/** A built-in handler name, or a path to a module exporting one (`./handler.js`). */
export type HandlerName = "llm" | "echo" | "tools" | "chain" | (string & {});

const POLL_MS = 5000;

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

  // Addendum v3 — A2A Agent Card (SPEC.md "## G.", "## S."). Mirrors the gateway's
  // per-agent proxy card at /a/<slug>/.well-known/agent.json, served directly here too.
  const publicUrl = (process.env.AGENT_PUBLIC_URL || `http://localhost:${opts.port}`).replace(/\/+$/, "");
  app.get("/.well-known/agent.json", async () => {
    const info = cardAgent ?? (await refreshAgent());
    return {
      name: info.name,
      description: process.env.AGENT_DESCRIPTION || "",
      url: publicUrl,
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      skills: capabilities.map((c) => ({ id: c, name: c })),
      authentication: { schemes: ["x402-ferminux"] },
    };
  });

  // Addendum v3 — A2A JSON-RPC: POST /a2a {jsonrpc:"2.0", method:"tasks/send", params, id} -> handler.
  app.post("/a2a", async (request, reply) => {
    const body = (request.body ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    if (body.jsonrpc !== "2.0" || body.method !== "tasks/send") {
      reply.code(400);
      return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "expected JSON-RPC 2.0 method \"tasks/send\"" } };
    }
    try {
      const input = extractA2AInput(body.params);
      const result = await handler(input);
      const outputText = typeof result.output === "string" ? result.output : JSON.stringify(result);
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          id: (body.params as { id?: string } | undefined)?.id ?? randomUUID(),
          status: { state: "completed" },
          artifacts: [{ parts: [{ type: "text", text: outputText }] }],
        },
      };
    } catch (err) {
      return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: (err as Error).message } };
    }
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
  });
  if (autoreply && opts.handlerName !== "llm") {
    app.log.warn("AGENT_AUTOREPLY=1 ignored: auto-reply only works with --handler llm");
  }

  // Addendum v3 — PRICE_PER_CALL puts POST /invoke behind x402 (direct pay-per-call,
  // no escrow job): fmx.x402.requirePayment() checks the gateway facilitator
  // (/api/x402/verify + /api/x402/settle) before the handler ever runs.
  const pricePerCall = process.env.PRICE_PER_CALL;
  if (pricePerCall) {
    const requirePayment = fmx.x402.requirePayment(Number(pricePerCall), {
      resource: "/invoke",
      description: `${agentName()} — pay-per-call`,
    });
    // When the gateway fronts us (nginx routes /a/<slug>/invoke to it) it charges the caller itself and forwards
    // with a shared secret — don't charge twice. Without GATEWAY_INVOKE_SECRET every call must carry its own voucher.
    const gwSecret = process.env.GATEWAY_INVOKE_SECRET;
    const gate: typeof requirePayment.fastify = async (request, reply) => {
      if (gwSecret && secretEquals(request.headers?.["x-ferminux-gateway-secret"], gwSecret)) return;
      return requirePayment.fastify(request, reply);
    };
    app.post("/invoke", { preHandler: gate }, async (request) => {
      return handler(request.body);
    });
    app.log.info(`PRICE_PER_CALL=${pricePerCall} — POST /invoke is x402-priced`);
  } else {
    // The route always exists (a deployed agent endpoint is expected to answer
    // POST /invoke), but an agent that has not priced direct calls sells only
    // through the escrow — say so instead of running the handler for free.
    // Deliberately NOT 402: a 402 without a PAYMENT-REQUIRED challenge sends
    // every x402 client (fmx.fetch included) down the voucher path for a price
    // that does not exist. 404 is what an unpriced agent answered before this
    // route existed, so nothing that already calls us changes behaviour.
    app.post("/invoke", async (request, reply) => {
      const info = cardAgent ?? (await refreshAgent());
      reply.code(404);
      return {
        ok: false,
        error: "this agent does not sell direct calls — set PRICE_PER_CALL to price POST /invoke",
        agentId: info.agentId,
        pricePerJob: info.pricePerJob,
        hire: "POST /api/jobs {agentId, input} on the gateway, or fmx.hire({agentId, input}) in the SDK",
      };
    });
  }

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

  let stopped = false;
  process.on("SIGINT", () => (stopped = true));
  process.on("SIGTERM", () => (stopped = true));

  // Webhooks are the primary delivery path once registered; polling continues as
  // a slow reconciliation safety net for deliveries that were missed or failed.
  const pollMs = usingWebhooks ? WEBHOOK_RECONCILE_POLL_MS : POLL_MS;

  while (!stopped) {
    try {
      await refreshAgent();
      await pollOnce(fmx, opts.id, statePath, handler, app.log);
    } catch (err) {
      app.log.error({ err }, "poll tick failed");
    }
    await sleep(pollMs);
  }

  stopWatchers();
  await app.close();
}

/** Best-effort extraction of a Google A2A `message`/`params` shape into the runtime handler's `unknown` input. */
function extractA2AInput(params: unknown): unknown {
  if (params == null) return "";
  const p = params as { message?: { parts?: Array<{ type?: string; text?: string; data?: unknown }> }; input?: unknown };
  const message = p.message;
  if (message?.parts?.length) {
    const textParts = message.parts.filter((part) => part.type !== "data" && typeof part.text === "string").map((part) => part.text as string);
    if (textParts.length) return textParts.join("\n");
    const dataPart = message.parts.find((part) => part.type === "data");
    if (dataPart) return dataPart.data;
  }
  if (p.input !== undefined) return p.input;
  return params;
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
 * Handles a single job end to end (re-checks on-chain status, fetches input,
 * runs the handler, delivers, persists outcome). Shared by the poll loop and
 * the webhook receiver (`POST /webhooks/ferminux`, job.requested events).
 */
async function handleOneJob(fmx: Ferminux, jobId: number, statePath: string, handler: Handler, log: Log): Promise<void> {
  const state: HandledState = loadState(statePath);
  const key = String(jobId);
  if (state[key]) return; // already delivered or permanently abandoned (poll + webhook can race harmlessly)

  let outcome: "delivered" | "abandoned" | "skipped" = "abandoned";
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Always re-check on-chain status right before doing (more) work or delivering.
      const onchain = await fmx.escrow.getJob(jobId);
      if (Number(onchain.status) !== JobStatusEnum.Open) {
        outcome = "skipped"; // no longer open (delivered/refunded/cancelled elsewhere) — stop tracking it
        break;
      }
      const input = await fmx.jobs.input(jobId);
      const result = await handler(input);
      await fmx.jobs.deliver({ jobId, output: result });
      outcome = "delivered";
      break;
    } catch (err) {
      lastErr = err;
      log.error({ err, jobId, attempt }, "job attempt failed");
      if (attempt < 3) await sleep(2000);
    }
  }

  state[key] = { status: outcome, attempts: 3, updatedAt: Date.now() };
  saveState(statePath, state);
  if (outcome === "abandoned") {
    log.error({ jobId, err: lastErr }, "job abandoned after 3 attempts");
  } else {
    log.info({ jobId, outcome }, "job handled");
  }
}
