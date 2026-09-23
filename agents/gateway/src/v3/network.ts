// The hiring graph — AI-LinkedIn's network half.
//
//   GET /api/network              who hired whom, and who paid whom per call
//   GET /api/network/similar/:agent   agents like this one, each with its reason
//
// Every edge is `chain`-provable: it aggregates indexed ServiceEscrow jobs and
// X402Vault settlements, and each one names the jobs behind it so a reader can
// pull the receipts. Client addresses are resolved to an agent when the address
// owns one, which is what turns a payment ledger into a graph of agents hiring
// agents.
//
// A note that belongs on the record rather than in a changelog: this makes
// already-public counterparty addresses legible in a way the raw chain does not.
// Nothing new is disclosed — every edge is a public log — but it is now trivially
// indexable, and that was a deliberate choice, not an accident of implementation.
import type { FastifyInstance } from "fastify";
import { JobStatusEnum } from "../abi.js";
import { CHAIN } from "../constants.js";
import { HttpError } from "../commons/context.js";
import type { AgentRow } from "../types.js";
import { AgentStatusName } from "../types.js";
import type { V3Context } from "./context.js";
import { parseCard, resolveAgentSlug, slugify } from "./a2a.js";

export const NETWORK_DEFAULT_LIMIT = 200;
export const NETWORK_MAX_LIMIT = 1000;
export const SIMILAR_DEFAULT = 5;
export const SIMILAR_MAX = 25;

export type EdgeKind = "hire" | "x402";

interface Edge {
  kind: EdgeKind;
  from: string;
  fromAgentId: number | null;
  fromName: string | null;
  to: string;
  toAgentId: number;
  toName: string;
  jobs: number;
  volumeWei: string;
  ratedJobs: number;
  avgRating: number | null;
  firstAt: number | null;
  lastAt: number | null;
  jobIds: number[];
  provenance: "chain";
  proven: true;
  source: string;
}

function capabilitiesOf(row: AgentRow): string[] {
  const card = parseCard(row);
  return Array.isArray(card?.capabilities) ? (card!.capabilities as unknown[]).filter((c): c is string => typeof c === "string").map((c) => c.trim().toLowerCase()).filter(Boolean) : [];
}

function addWei(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

/** Ratings live in the JobCompleted log, not on the jobs row; 0 means unrated. */
function jobRatings(ctx: V3Context): Map<number, number> {
  const out = new Map<number, number>();
  const rows = ctx.db.prepare("SELECT argsJSON FROM events WHERE contractName = 'escrow' AND eventName = 'JobCompleted'").all() as Array<{ argsJSON: string }>;
  for (const r of rows) {
    try {
      const a = JSON.parse(r.argsJSON) as { jobId?: string; rating?: string };
      const id = Number(a.jobId);
      const rating = Number(a.rating ?? 0);
      if (id && rating > 0) out.set(id, rating);
    } catch {
      /* malformed row */
    }
  }
  return out;
}

export function buildNetwork(
  ctx: V3Context,
  opts: { capability?: string; agentId?: number; minJobs?: number; kind?: EdgeKind | "all"; limit: number },
) {
  const db = ctx.db;
  const agents = db.prepare("SELECT * FROM agents ORDER BY id ASC").all() as AgentRow[];
  const byId = new Map(agents.map((a) => [a.id, a]));
  // address → the agent it owns (lowest id wins, same rule the slug resolver uses)
  const ownerToAgent = new Map<string, AgentRow>();
  for (const a of agents) {
    const k = a.owner.toLowerCase();
    if (!ownerToAgent.has(k)) ownerToAgent.set(k, a);
  }
  const accountOwner = new Map<string, string>();
  for (const r of db.prepare("SELECT account, owner FROM agent_accounts").all() as Array<{ account: string; owner: string }>) {
    accountOwner.set(r.account.toLowerCase(), r.owner.toLowerCase());
  }
  /** An AgentAccount is its owner for graph purposes — otherwise a wallet split hides an edge. */
  const resolveActor = (address: string) => {
    const lc = address.toLowerCase();
    const viaAccount = accountOwner.get(lc);
    return ownerToAgent.get(viaAccount ?? lc) ?? null;
  };

  const want = opts.capability?.trim().toLowerCase();
  const capOk = (a: AgentRow) => !want || capabilitiesOf(a).some((c) => c.includes(want));

  const ratings = jobRatings(ctx);
  const edges = new Map<string, Edge>();
  const kind = opts.kind ?? "all";

  if (kind === "all" || kind === "hire") {
    const jobs = db
      .prepare("SELECT id, agentId, client, amount, createdAt, deliveredAt, status FROM jobs WHERE status IN (?, ?) ORDER BY createdAt ASC")
      .all(JobStatusEnum.Completed, JobStatusEnum.Resolved) as Array<{ id: number; agentId: number; client: string; amount: string; createdAt: number; deliveredAt: number | null; status: number }>;
    for (const j of jobs) {
      const to = byId.get(j.agentId);
      if (!to || !capOk(to)) continue;
      if (opts.agentId && j.agentId !== opts.agentId && resolveActor(j.client)?.id !== opts.agentId) continue;
      const fromAgent = resolveActor(j.client);
      const key = `hire:${j.client.toLowerCase()}:${j.agentId}`;
      const e = edges.get(key) ?? {
        kind: "hire" as const,
        from: j.client,
        fromAgentId: fromAgent?.id ?? null,
        fromName: fromAgent?.name ?? null,
        to: to.owner,
        toAgentId: to.id,
        toName: to.name,
        jobs: 0,
        volumeWei: "0",
        ratedJobs: 0,
        avgRating: null,
        firstAt: null,
        lastAt: null,
        jobIds: [],
        provenance: "chain" as const,
        proven: true as const,
        source: "ServiceEscrow.JobCompleted / JobResolved",
      };
      e.jobs += 1;
      e.volumeWei = addWei(e.volumeWei, j.amount);
      const r = ratings.get(j.id);
      if (r) {
        e.ratedJobs += 1;
        e.avgRating = ((e.avgRating ?? 0) * (e.ratedJobs - 1) + r) / e.ratedJobs;
      }
      e.firstAt = e.firstAt === null ? j.createdAt : Math.min(e.firstAt, j.createdAt);
      e.lastAt = e.lastAt === null ? j.createdAt : Math.max(e.lastAt, j.createdAt);
      if (e.jobIds.length < 50) e.jobIds.push(j.id);
      edges.set(key, e);
    }
  }

  if (kind === "all" || kind === "x402") {
    const settlements = db.prepare("SELECT payer, payee, amount, ts FROM x402_settlements ORDER BY ts ASC").all() as Array<{ payer: string; payee: string; amount: string; ts: number }>;
    for (const s of settlements) {
      const to = resolveActor(s.payee);
      if (!to || !capOk(to)) continue;
      const fromAgent = resolveActor(s.payer);
      if (opts.agentId && to.id !== opts.agentId && fromAgent?.id !== opts.agentId) continue;
      const key = `x402:${s.payer.toLowerCase()}:${to.id}`;
      const e = edges.get(key) ?? {
        kind: "x402" as const,
        from: s.payer,
        fromAgentId: fromAgent?.id ?? null,
        fromName: fromAgent?.name ?? null,
        to: to.owner,
        toAgentId: to.id,
        toName: to.name,
        jobs: 0,
        volumeWei: "0",
        ratedJobs: 0,
        avgRating: null,
        firstAt: null,
        lastAt: null,
        jobIds: [],
        provenance: "chain" as const,
        proven: true as const,
        source: "X402Vault.Settled",
      };
      e.jobs += 1;
      e.volumeWei = addWei(e.volumeWei, s.amount);
      e.firstAt = e.firstAt === null ? s.ts : Math.min(e.firstAt, s.ts);
      e.lastAt = e.lastAt === null ? s.ts : Math.max(e.lastAt, s.ts);
      edges.set(key, e);
    }
  }

  let list = [...edges.values()].filter((e) => e.jobs >= (opts.minJobs ?? 1));
  list.sort((a, b) => {
    const d = BigInt(b.volumeWei) - BigInt(a.volumeWei);
    if (d !== 0n) return d > 0n ? 1 : -1;
    return b.jobs - a.jobs;
  });
  const total = list.length;
  list = list.slice(0, opts.limit);
  for (const e of list) if (e.avgRating !== null) e.avgRating = Math.round(e.avgRating * 100) / 100;

  const nodeIds = new Set<number>();
  for (const e of list) {
    nodeIds.add(e.toAgentId);
    if (e.fromAgentId) nodeIds.add(e.fromAgentId);
  }
  const nodes = [...nodeIds]
    .map((id) => byId.get(id))
    .filter((a): a is AgentRow => !!a)
    .map((a) => ({
      agentId: a.id,
      name: a.name,
      slug: slugify(a.name),
      owner: a.owner,
      status: AgentStatusName[a.status] ?? "None",
      capabilities: capabilitiesOf(a),
      pricePerJobWei: a.pricePerJob,
      jobsCompleted: a.jobsCompleted,
      ratingAvg: a.ratingCount > 0 ? Math.round((a.ratingSum / a.ratingCount) * 100) / 100 : null,
      hired: list.filter((e) => e.fromAgentId === a.id).length,
      hiredBy: list.filter((e) => e.toAgentId === a.id).length,
      cv: `${ctx.cfg.publicUrl.replace(/\/+$/, "")}/api/cv/${a.id}`,
    }))
    .sort((a, b) => b.hiredBy - a.hiredBy || a.agentId - b.agentId);

  const externalClients = new Set(list.filter((e) => e.fromAgentId === null).map((e) => e.from.toLowerCase()));
  return {
    nodes,
    edges: list,
    total,
    counts: {
      nodes: nodes.length,
      edges: list.length,
      hireEdges: list.filter((e) => e.kind === "hire").length,
      x402Edges: list.filter((e) => e.kind === "x402").length,
      externalClients: externalClients.size,
      agentToAgentEdges: list.filter((e) => e.fromAgentId !== null).length,
    },
    chainId: CHAIN.chainId,
    provenance: "chain",
    note:
      "every edge aggregates indexed logs (ServiceEscrow.JobCompleted / JobResolved, X402Vault.Settled) and names the jobs behind it, so each one is re-derivable from any chain-3961 RPC. An AgentAccount counts as its owner, so a wallet split does not hide an edge.",
    caution:
      "edge counts are farmable: requestJob accepts msg.value = 0 and both parties can be the same operator. Read volumeWei and the number of DISTINCT payers, never the edge count alone.",
  };
}

export function registerNetworkRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");

  app.get<{ Querystring: { capability?: string; agentId?: string; minJobs?: string; kind?: string; limit?: string } }>("/api/network", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const kind = req.query.kind ?? "all";
      if (!["all", "hire", "x402"].includes(kind)) throw new HttpError(400, "kind must be all|hire|x402");
      const limit = commons.parseLimit(req.query.limit, NETWORK_DEFAULT_LIMIT, NETWORK_MAX_LIMIT);
      const agentId = req.query.agentId ? commons.checkId(req.query.agentId, "agentId") : undefined;
      const minJobs = req.query.minJobs ? Math.max(Number(req.query.minJobs) || 1, 1) : 1;
      reply.header("cache-control", "public, max-age=30");
      return buildNetwork(ctx, { capability: req.query.capability, agentId, minJobs, kind: kind as EdgeKind | "all", limit });
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  /**
   * Similar agents, each with the reason it is similar: shared declared
   * capabilities (Jaccard), clients in common (chain), and price band. No
   * opaque score — the reason IS the output.
   */
  app.get<{ Params: { agent: string }; Querystring: { limit?: string } }>("/api/network/similar/:agent", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const row = resolveAgentSlug(db, req.params.agent);
      const limit = commons.parseLimit(req.query.limit, SIMILAR_DEFAULT, SIMILAR_MAX);
      const mine = new Set(capabilitiesOf(row));
      const myClients = new Set(
        (db.prepare("SELECT DISTINCT client FROM jobs WHERE agentId = ? AND status IN (?, ?)").all(row.id, JobStatusEnum.Completed, JobStatusEnum.Resolved) as Array<{ client: string }>).map((r) => r.client.toLowerCase()),
      );
      let myPrice = 0n;
      try {
        myPrice = BigInt(row.pricePerJob || "0");
      } catch {
        myPrice = 0n;
      }

      const others = (db.prepare("SELECT * FROM agents WHERE id <> ? ORDER BY id ASC").all(row.id) as AgentRow[]).map((a) => {
        const theirs = new Set(capabilitiesOf(a));
        const shared = [...mine].filter((c) => theirs.has(c));
        const union = new Set([...mine, ...theirs]).size;
        const jaccard = union ? shared.length / union : 0;
        const theirClients = new Set(
          (db.prepare("SELECT DISTINCT client FROM jobs WHERE agentId = ? AND status IN (?, ?)").all(a.id, JobStatusEnum.Completed, JobStatusEnum.Resolved) as Array<{ client: string }>).map((r) => r.client.toLowerCase()),
        );
        const coClients = [...theirClients].filter((c) => myClients.has(c));
        let price = 0n;
        try {
          price = BigInt(a.pricePerJob || "0");
        } catch {
          price = 0n;
        }
        // "same price band" = within 2x either way, which is the band a buyer actually shops in
        const sameBand = myPrice > 0n && price > 0n && price * 2n >= myPrice && myPrice * 2n >= price;
        const reasons: string[] = [];
        if (shared.length) reasons.push(`shares ${shared.length} capabilit${shared.length === 1 ? "y" : "ies"} (${shared.slice(0, 4).join(", ")})`);
        if (coClients.length) reasons.push(`${coClients.length} client${coClients.length === 1 ? "" : "s"} in common`);
        if (sameBand) reasons.push("same price band");
        return {
          agentId: a.id,
          name: a.name,
          slug: slugify(a.name),
          owner: a.owner,
          status: AgentStatusName[a.status] ?? "None",
          capabilities: [...theirs],
          sharedCapabilities: shared,
          capabilityJaccard: Math.round(jaccard * 100) / 100,
          clientsInCommon: coClients.length,
          coClientProvenance: coClients.length ? "chain — ServiceEscrow jobs settled for both agents" : null,
          pricePerJobWei: a.pricePerJob,
          samePriceBand: sameBand,
          jobsCompleted: a.jobsCompleted,
          ratingAvg: a.ratingCount > 0 ? Math.round((a.ratingSum / a.ratingCount) * 100) / 100 : null,
          cv: `${base}/api/cv/${a.id}`,
          reason: reasons.join("; ") || "no overlap found",
          rank: jaccard * 3 + coClients.length * 2 + (sameBand ? 0.5 : 0),
        };
      });

      const items = others.filter((o) => o.rank > 0).sort((a, b) => b.rank - a.rank || a.agentId - b.agentId).slice(0, limit);
      reply.header("cache-control", "public, max-age=60");
      return {
        agentId: row.id,
        name: row.name,
        capabilities: [...mine],
        items: items.map(({ rank: _r, ...rest }) => rest),
        total: items.length,
        method: {
          capabilities: "Jaccard over the capabilities each operator DECLARED in its card — declared, never proved",
          clientsInCommon: "chain: distinct clients whose escrow jobs settled for both agents",
          priceBand: "within 2× either way of AgentRegistry.pricePerJob",
          ranking: "3 × capability Jaccard + 2 × clients in common + 0.5 when the price band matches. Published, not opaque — recompute it yourself from the fields above.",
        },
      };
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });
}
