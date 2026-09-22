// Agent front doors on the gateway: `/a/<slug>/…`
//   GET  /a/<slug>/.well-known/agent.json  Google A2A Agent Card generated from our card
//   POST /a/<slug>/invoke                  x402-priced proxy to <endpoint>/invoke (payTo = agent owner)
//   POST /a/<slug>/a2a                     JSON-RPC tasks/send → invoke (paid via x402 or metadata.jobId)
// <slug> = agent id, or the agent name slugified (lowercase, non-alphanumerics → "-").
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../commons/context.js";
import { JobStatusEnum } from "../abi.js";
import { GATEWAY_VERSION } from "../openapi.js";
import { getPayload } from "../payloads.js";
import type { AgentRow, JobRow } from "../types.js";
import { CHAIN } from "../constants.js";
import type { V3Context } from "./context.js";
import type { X402Facilitator } from "./x402.js";
import { readCapped, safeFetch } from "../net.js";

export const INVOKE_TIMEOUT_MS = 60_000;
export const INVOKE_MAX_RESPONSE_BYTES = 1024 * 1024;

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agent";
}

interface AgentCard {
  description?: string;
  capabilities?: unknown;
  pricePerCall?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  version?: unknown;
  model?: unknown;
  image?: unknown;
  contact?: unknown;
}

export function parseCard(row: AgentRow): AgentCard | null {
  if (!row.card) return null;
  try {
    const c = JSON.parse(row.card);
    return c && typeof c === "object" ? (c as AgentCard) : null;
  } catch {
    return null;
  }
}

/** pricePerCall from the agent's card (wei string), null when unset/invalid/zero. */
export function pricePerCall(row: AgentRow): bigint | null {
  const c = parseCard(row);
  const v = c?.pricePerCall;
  try {
    const n = typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : typeof v === "string" && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : 0n;
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function a2aCard(ctx: V3Context, row: AgentRow) {
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");
  const slug = slugify(row.name);
  const card = parseCard(row);
  const caps = Array.isArray(card?.capabilities) ? (card!.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const price = pricePerCall(row);
  const skills = (caps.length ? caps : ["invoke"]).map((c) => ({ id: slugify(c), name: c, description: `${row.name}: ${c}`, tags: ["ferminux", ...(price ? ["x402"] : [])], inputModes: ["text/plain", "application/json"], outputModes: ["application/json"] }));
  return {
    name: row.name,
    description: typeof card?.description === "string" ? card.description : `Ferminux agent #${row.id}`,
    url: `${base}/a/${slug}/a2a`,
    version: typeof card?.version === "string" ? card.version : "1.0.0",
    provider: { organization: row.name, url: `${base}/agents/?id=${row.id}` },
    documentationUrl: `${base}/agents/?id=${row.id}`,
    iconUrl: typeof card?.image === "string" ? card.image : `${base}/assets/brand/fmx-256.png`,
    capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills,
    authentication: { schemes: ["x402-ferminux"], credentials: price ? `PAYMENT header: EIP-712 FerminuxX402 voucher of ${price} wei to ${row.owner} (see ${base}/api/x402/supported)` : "free (no payment required); or a pre-funded ServiceEscrow job id in metadata.jobId" },
    securitySchemes: { "x402-ferminux": { type: "http", scheme: "x402", description: `402 → PAYMENT-REQUIRED (scheme ferminux-voucher, network ferminux:${CHAIN.chainId}, asset FMX)` } },
    security: price ? [{ "x402-ferminux": [] }] : [],
    ferminux: {
      agentId: row.id,
      owner: row.owner,
      endpoint: row.endpoint,
      pricePerJob: row.pricePerJob,
      pricePerCall: price ? price.toString() : null,
      invoke: `${base}/a/${slug}/invoke`,
      erc8004: `${base}/api/agents/${row.id}/erc8004.json`,
      agent: `${base}/api/agents/${row.id}`,
      online: row.online === 1,
      gateway: GATEWAY_VERSION,
    },
  };
}

interface InvokeResult {
  status: number;
  contentType: string;
  body: Buffer;
}

// AGENT_UPSTREAMS="toolbox=http://fmxp-agent-toolbox:8801,oracle=http://fmxp-agent-oracle:8803,…": agents hosted
// behind our own nginx register https://<PUBLIC_URL>/a/<slug>/ as their endpoint; calling that from inside the
// gateway would route straight back to /a/<slug>/invoke (a loop until the rate limit trips), so map to the container.
const UPSTREAMS: Record<string, string> = Object.fromEntries(
  (process.env.AGENT_UPSTREAMS ?? "").split(",").map((kv) => kv.trim()).filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1).replace(/\/+$/, "")]; }),
);
function internalBase(row: AgentRow): string | undefined {
  const m = /^https?:\/\/[^/]+\/a\/([a-z0-9-]+)\/?$/i.exec(row.endpoint);
  return m ? UPSTREAMS[m[1].toLowerCase()] : undefined;
}

/** The proxy answers from the gateway's own origin: only inert types pass through, anything active (html, svg, xml, js) is served as bytes. */
export function safeContentType(ct: string | null): string {
  const v = (ct ?? "").trim();
  if (/^application\/json\b/i.test(v) || /^text\/plain\b/i.test(v) || /^application\/x-ndjson\b/i.test(v)) return v;
  return "application/octet-stream";
}

async function forwardInvoke(ctx: V3Context, row: AgentRow, body: Buffer, contentType: string, extraHeaders: Record<string, string>): Promise<InvokeResult> {
  if (!/^https?:\/\//i.test(row.endpoint)) throw new HttpError(502, "agent has no http(s) endpoint");
  const internal = internalBase(row);
  const url = `${internal ?? row.endpoint.replace(/\/+$/, "")}/invoke`;
  // GATEWAY_INVOKE_SECRET ("this call was already charged by the gateway") is only meaningful for our own
  // upstreams — never send it to a third-party endpoint, which any wallet can register on-chain.
  const secret: Record<string, string> = internal && process.env.GATEWAY_INVOKE_SECRET ? { "x-ferminux-gateway-secret": process.env.GATEWAY_INVOKE_SECRET } : {};
  try {
    // third-party endpoints: public hosts only (SSRF guard), body capped while streaming (never buffered past the cap)
    const res = await safeFetch(url, { method: "POST", headers: { "content-type": contentType, "user-agent": "ferminux-gateway/invoke", "x-ferminux-agent-id": String(row.id), ...secret, ...extraHeaders }, body, timeoutMs: INVOKE_TIMEOUT_MS, trusted: !!internal, fetchImpl: ctx.fetchImpl });
    let buf: Buffer;
    try {
      buf = await readCapped(res, INVOKE_MAX_RESPONSE_BYTES);
    } catch {
      throw new HttpError(502, "agent response over 1 MiB");
    }
    return { status: res.status, contentType: safeContentType(res.headers.get("content-type")), body: buf };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(504, `agent endpoint unreachable: ${(err as Error).message.slice(0, 120)}`);
  }
}

export function registerA2aRoutes(app: FastifyInstance, ctx: V3Context, fac: X402Facilitator): void {
  const { db, commons } = ctx;
  const byId = db.prepare("SELECT * FROM agents WHERE id = ?");
  const all = db.prepare("SELECT * FROM agents ORDER BY CASE WHEN status = 1 THEN 0 ELSE 1 END, id ASC");

  function resolve(slug: string): AgentRow {
    let row: AgentRow | undefined;
    if (/^\d+$/.test(slug)) row = byId.get(Number(slug)) as AgentRow | undefined;
    else {
      const want = slug.toLowerCase();
      for (const r of all.all() as AgentRow[]) {
        if (slugify(r.name) === want) {
          row = r;
          break;
        }
      }
    }
    if (!row) throw new HttpError(404, `no agent with slug "${slug}"`);
    return row;
  }

  const bodyOf = (req: FastifyRequest) => (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {})));

  app.get<{ Params: { slug: string } }>("/a/:slug/.well-known/agent.json", async (req, reply) => {
    try {
      reply.header("cache-control", "public, max-age=60");
      return a2aCard(ctx, resolve(req.params.slug));
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  const rl = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  app.post<{ Params: { slug: string } }>("/a/:slug/invoke", rl, async (req, reply) => {
    try {
      const row = resolve(req.params.slug);
      const paid = await fac.charge(req, reply, {
        amount: () => pricePerCall(row),
        payTo: () => row.owner,
        description: () => `Invoke Ferminux agent #${row.id} ${row.name}`,
      });
      if (!paid) return reply;
      const res = await forwardInvoke(ctx, row, bodyOf(req), (req.headers["content-type"] as string) || "application/json", {
        ...(paid.payer ? { "x-ferminux-payer": paid.payer, "x-ferminux-payment-nonce": paid.nonce ?? "" } : {}),
      });
      reply.code(res.status).header("content-type", res.contentType).header("x-content-type-options", "nosniff");
      return reply.send(res.body);
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.post<{ Params: { slug: string } }>("/a/:slug/a2a", rl, async (req, reply) => {
    let rpcId: unknown = null;
    const rpcError = (code: number, message: string, status = 200, data?: unknown) => reply.code(status).send({ jsonrpc: "2.0", id: rpcId, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    try {
      const row = resolve(req.params.slug);
      let rpc: Record<string, unknown>;
      try {
        rpc = commons.parseJson(req);
      } catch {
        return rpcError(-32700, "parse error", 400);
      }
      rpcId = rpc.id ?? null;
      const method = String(rpc.method ?? "");
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      if (method !== "tasks/send" && method !== "message/send") return rpcError(-32601, `method not found: ${method} (supported: tasks/send, message/send)`);
      const message = (params.message ?? {}) as Record<string, unknown>;
      const parts = Array.isArray(message.parts) ? (message.parts as Array<Record<string, unknown>>) : [];
      if (!parts.length) return rpcError(-32602, "params.message.parts is required");
      const texts: string[] = [];
      const data: unknown[] = [];
      for (const p of parts) {
        const kind = String(p.type ?? p.kind ?? "");
        if (kind === "text" && typeof p.text === "string") texts.push(p.text);
        else if (kind === "data" && p.data !== undefined) data.push(p.data);
      }
      const taskId = typeof params.id === "string" ? params.id : typeof params.taskId === "string" ? params.taskId : `task-${Date.now().toString(36)}`;
      const metadata = (params.metadata ?? {}) as Record<string, unknown>;
      const jobIdRaw = metadata.jobId;
      const jobId = typeof jobIdRaw === "number" || (typeof jobIdRaw === "string" && /^\d+$/.test(jobIdRaw)) ? Number(jobIdRaw) : null;

      const invokeInput = { taskId, text: texts.join("\n"), data: data.length === 1 ? data[0] : data.length ? data : undefined, parts, ...(jobId ? { jobId } : {}) };
      const headers: Record<string, string> = {};
      const artifactsFromOutput = (contentType: string, body: Buffer) => {
        const text = body.toString("utf8");
        if (/json/i.test(contentType)) {
          try {
            return [{ name: "output", parts: [{ type: "data", data: JSON.parse(text) }] }];
          } catch {
            // fall through
          }
        }
        return [{ name: "output", parts: [{ type: "text", text }] }];
      };
      const done = (artifacts: unknown[], extra: Record<string, unknown> = {}) =>
        reply.send({ jsonrpc: "2.0", id: rpcId, result: { id: taskId, sessionId: typeof params.sessionId === "string" ? params.sessionId : null, status: { state: "completed", timestamp: new Date(ctx.now()).toISOString() }, artifacts, history: [message], metadata: { agentId: row.id, ...extra } } });

      if (jobId) {
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
        if (!job || job.agentId !== row.id) return rpcError(-32602, `metadata.jobId ${jobId} is not a job on agent #${row.id}`);
        if (job.status === JobStatusEnum.Delivered || job.status === JobStatusEnum.Completed || job.status === JobStatusEnum.Resolved) {
          // already delivered: hand back the output without invoking again
          const m = /^fmx:\/\/payload\/(0x[0-9a-fA-F]{64})/.exec(job.outputURI ?? "");
          const stored = m ? getPayload(db, m[1]!.toLowerCase()) : undefined;
          const artifacts = stored ? artifactsFromOutput(stored.contentType, stored.bytes) : [{ name: "output", parts: [{ type: "data", data: { outputURI: job.outputURI, outputHash: job.outputHash } }] }];
          return done(artifacts, { jobId, jobStatus: job.status, prefunded: true });
        }
        if (job.status !== JobStatusEnum.Open) return rpcError(-32602, `job ${jobId} is not open (status ${job.status})`);
        headers["x-ferminux-job-id"] = String(jobId);
      } else {
        const paid = await fac.charge(req, reply, { amount: () => pricePerCall(row), payTo: () => row.owner, description: () => `A2A tasks/send to Ferminux agent #${row.id} ${row.name}` });
        if (!paid) return reply; // 402 with PAYMENT-REQUIRED
        if (paid.payer) {
          headers["x-ferminux-payer"] = paid.payer;
          headers["x-ferminux-payment-nonce"] = paid.nonce ?? "";
        }
      }
      const res = await forwardInvoke(ctx, row, Buffer.from(JSON.stringify(invokeInput)), "application/json", headers);
      if (res.status >= 400) {
        return reply.send({ jsonrpc: "2.0", id: rpcId, result: { id: taskId, status: { state: "failed", timestamp: new Date(ctx.now()).toISOString(), message: { role: "agent", parts: [{ type: "text", text: res.body.toString("utf8").slice(0, 2000) }] } }, artifacts: [], history: [message], metadata: { agentId: row.id, upstreamStatus: res.status } } });
      }
      return done(artifactsFromOutput(res.contentType, res.body), jobId ? { jobId } : {});
    } catch (err) {
      if (err instanceof HttpError) return rpcError(-32000, err.message, err.status);
      throw err;
    }
  });
}

export type { FastifyReply };
