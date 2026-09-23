// FRC-8004 registration file for an agent: GET /api/agents/:id/erc8004.json.
// The label is ours (FRC-8004); the route, the `type` URI below and the
// contract names keep the 8004 spelling because external tooling parses them.
// IdentityRegistry8004.agentURI(id) points here unless the owner set its own.
import type { FastifyInstance } from "fastify";
import type { AgentRow } from "../types.js";
import { CHAIN } from "../constants.js";
import { a2aCard, parseCard, slugify } from "./a2a.js";
import type { V3Context } from "./context.js";

export const ERC8004_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export function erc8004Registration(ctx: V3Context, row: AgentRow) {
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");
  const slug = slugify(row.name);
  const card = parseCard(row);
  const identity = ctx.address("identity8004");
  const reputation = ctx.address("reputation8004");
  const validation = ctx.address("validation8004");
  const a2a = a2aCard(ctx, row);
  return {
    type: ERC8004_TYPE,
    name: row.name,
    description: a2a.description,
    image: a2a.iconUrl,
    services: [
      { name: "ferminux", endpoint: row.endpoint, version: "1", card: row.endpoint ? `${row.endpoint.replace(/\/+$/, "")}/.well-known/ferminux-agent.json` : null },
      { name: "a2a", endpoint: `${base}/a/${slug}/.well-known/agent.json`, version: "0.3" },
      { name: "mcp", endpoint: `${base}/.well-known/agent.json`, version: "2025-06-18", command: "npx -y -p https://ferminux.net/downloads/ferminux-sdk.tgz ferminux-mcp", tool: `fmx_hire_agent {agentId: ${row.id}}` },
      { name: "x402", endpoint: `${base}/a/${slug}/invoke`, version: "1", pricePerCall: a2a.ferminux.pricePerCall },
      { name: "gateway", endpoint: `${base}/api/agents/${row.id}` },
    ],
    registrations: identity ? [{ agentId: row.id, agentRegistry: `eip155:${CHAIN.chainId}:${identity}` }] : [],
    supportedTrust: ["reputation", "validation"],
    active: row.status === 1,
    "x-ferminux": {
      agentId: row.id,
      owner: row.owner,
      agentRegistry: ctx.cfg.registry,
      identityRegistry: identity ?? null,
      reputationRegistry: reputation ?? null,
      validationRegistry: validation ?? null,
      chainId: CHAIN.chainId,
      pricePerJob: row.pricePerJob,
      capabilities: Array.isArray(card?.capabilities) ? card!.capabilities : [],
      model: typeof card?.model === "string" ? card.model : null,
      ...(identity ? {} : { registrationsNote: "IdentityRegistry8004 not deployed yet; registrations[] fills in when it is" }),
    },
  };
}

export function registerErc8004Routes(app: FastifyInstance, ctx: V3Context): void {
  app.get<{ Params: { id: string } }>("/api/agents/:id/erc8004.json", async (req, reply) => {
    const row = ctx.db.prepare("SELECT * FROM agents WHERE id = ?").get(Number(req.params.id)) as AgentRow | undefined;
    if (!row) return reply.code(404).send({ error: "agent not found" });
    reply.header("cache-control", "public, max-age=60");
    return erc8004Registration(ctx, row);
  });
}
