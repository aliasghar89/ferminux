// Direct (non-escrow) calls: POST /invoke and POST /a2a (Google A2A JSON-RPC tasks/send). Both run the handler,
// so both sit behind the SAME gate: the x402 preHandler when PRICE_PER_CALL is set, a 404 "does not sell direct
// calls" when it is not. /a2a used to have no gate at all — anyone calling <endpoint>/a2a on a priced agent got
// its service free, and an escrow-only agent gave work away the same way.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Handler } from "./handlers/util.js";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface DirectCallOptions {
  handler: Handler;
  /** x402 gate factory (resource path → preHandler); null = direct calls are not for sale */
  gate: ((resource: string) => PreHandler) | null;
  /** body of the 404 an unpriced agent answers */
  notForSale: () => Promise<Record<string, unknown>>;
}

/** Best-effort extraction of a Google A2A `message`/`params` shape into the runtime handler's `unknown` input. */
export function extractA2AInput(params: unknown): unknown {
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

export function registerDirectCallRoutes(app: FastifyInstance, opts: DirectCallOptions): void {
  const { handler } = opts;
  const a2a = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    if (body.jsonrpc !== "2.0" || body.method !== "tasks/send") {
      reply.code(400);
      return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "expected JSON-RPC 2.0 method \"tasks/send\"" } };
    }
    try {
      const input = extractA2AInput(body.params);
      const result = await handler(input);
      const outputText = typeof result.output === "string" ? result.output : JSON.stringify(result);
      // A refusal ({ok:false}) is not a sale: answer 422 so the gateway releases the caller's x402 voucher
      // (it voids a queued voucher on any 4xx/5xx from the agent) — the escrow path declines the job the same way.
      const refused = result.ok === false;
      if (refused) reply.code(422);
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          id: (body.params as { id?: string } | undefined)?.id ?? randomUUID(),
          status: { state: refused ? "failed" : "completed" },
          artifacts: [{ parts: [{ type: "text", text: outputText }] }],
        },
      };
    } catch (err) {
      return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: (err as Error).message } };
    }
  };
  if (opts.gate) {
    app.post("/invoke", { preHandler: opts.gate("/invoke") }, async (request, reply) => {
      const result = await handler(request.body);
      if (result.ok === false) reply.code(422); // a refusal is not billed: the gateway releases the voucher on 4xx
      return result;
    });
    app.post("/a2a", { preHandler: opts.gate("/a2a") }, a2a);
  } else {
    // Deliberately NOT 402: a 402 without a PAYMENT-REQUIRED challenge sends every x402 client (fmx.fetch
    // included) down the voucher path for a price that does not exist. 404 is what an unpriced agent answered
    // before these routes existed, so nothing that already calls us changes behaviour.
    const refuse = async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.code(404);
      return opts.notForSale();
    };
    app.post("/invoke", refuse);
    app.post("/a2a", refuse);
  }
}
