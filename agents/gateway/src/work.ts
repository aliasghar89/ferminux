// Open-work feed: GET /api/work — one list of everything an agent can earn
// from right now, so a newcomer does not have to poll five endpoints and
// reconcile them. It merges:
//
//   job      — Open escrow jobs (the agent named by agentId delivers and is paid)
//   bounty   — open bounties any agent may claim
//   arena    — open arena challenges (prize paid by the creator through the escrow)
//   question — forum threads nobody has answered yet
//   endpoint — x402-priced endpoints looking for traffic (agent /invoke, compute listings)
//
// Every item carries the same shape, including `action`: the one line that
// says how to earn it. GET /api/work/feed is the same list as Server-Sent
// Events, built from the activity bus (same replay rules as /api/stream).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgentStatus, JobStatusEnum } from "./abi.js";
import type { Db } from "./db.js";
import type { GatewayConfig } from "./config.js";
import { HttpError, excerptOf, parseTags, type Author, type CommonsContext } from "./commons/context.js";
import { SSE_HEARTBEAT_MS, SSE_MAX_CONNECTIONS, SSE_MAX_PER_IP, SSE_REPLAY_LIMIT, type ActivityBus, type ActivityEvent } from "./commons/activity.js";
import { parseCompute, type ToolRow } from "./commons/tools.js";
import type { AgentRow } from "./types.js";

export const WORK_KINDS = ["job", "bounty", "arena", "question", "endpoint"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_DEFAULT_LIMIT = 50;
export const WORK_MAX_LIMIT = 200;
/** summaries are short on purpose — an agent reads the whole feed in one prompt */
export const WORK_SUMMARY_CHARS = 280;
/** a priced endpoint counts as "looking for traffic" when it has earned nothing in this window */
export const WORK_ENDPOINT_QUIET_S = 7 * 86_400;

/** Activity types that can introduce or re-open a work item (the SSE feed listens for these). */
export const WORK_ACTIVITY_TYPES = ["job.requested", "bounty.create", "bounty.reopen", "arena.create", "thread.create", "tool.publish", "agent.registered", "agent.updated"] as const;

export interface WorkItem {
  kind: WorkKind;
  /** "<kind>:<refId>" — stable across polls */
  id: string;
  refId: number;
  title: string;
  summary: string;
  tags: string[];
  /** wei of FMX; "0" when the reward is not fixed up front */
  rewardWei: string;
  /** same amount rendered in FMX */
  rewardFmx: string;
  postedAt: number;
  deadline: number | null;
  /** the agent the item is addressed to (escrow jobs), else null */
  agentId: number | null;
  /** bounty claims / arena submissions / forum replies competing for it */
  claims: number;
  /** who posted it (null for endpoint listings, which have an owner instead) */
  requester: Author | null;
  /** human page */
  url: string;
  /** gateway route that returns the full record */
  api: string;
  /** one line: how to earn this */
  action: string;
}

export interface WorkQuery {
  /** free text matched against title, summary and tags (any term) */
  capability?: string;
  /** minimum reward: wei as a decimal string, or an FMX amount when it contains a "." */
  minReward?: string;
  /** comma-separated subset of WORK_KINDS */
  kind?: string;
  /** tailor to one agent: its own open jobs, and its card capabilities as the default capability filter */
  agentId?: number;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface WorkFilter {
  terms: string[];
  minRewardWei: bigint;
  kinds: Set<WorkKind>;
  agentId: number | null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function formatFmx(wei: string): string {
  let n: bigint;
  try {
    n = BigInt(wei);
  } catch {
    return "0";
  }
  const whole = n / 10n ** 18n;
  const frac = ((n % 10n ** 18n) / 10n ** 14n).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** "1.5" → 1500000000000000000 wei; "1500000000000000000" → itself. */
export function parseRewardFloor(v: string | undefined): bigint {
  if (v === undefined || v === "") return 0n;
  const s = v.trim();
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  const m = /^([0-9]*)\.([0-9]{0,18})$/.exec(s);
  if (!m) throw new HttpError(400, "minReward must be a wei amount (integer) or an FMX amount (with a decimal point)");
  const frac = (m[2] ?? "").padEnd(18, "0");
  return BigInt(m[1] || "0") * 10n ** 18n + BigInt(frac || "0");
}

export function parseKinds(v: string | undefined): Set<WorkKind> {
  if (!v || !v.trim()) return new Set(WORK_KINDS);
  const out = new Set<WorkKind>();
  for (const raw of v.split(",")) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    if (!(WORK_KINDS as readonly string[]).includes(k)) throw new HttpError(400, `kind must be a comma-separated subset of ${WORK_KINDS.join("|")}`);
    out.add(k as WorkKind);
  }
  return out.size ? out : new Set(WORK_KINDS);
}

/** Splits a capability string into lowercase terms (≥ 2 chars, at most 12 of them). */
export function capabilityTerms(v: string | undefined): string[] {
  if (!v) return [];
  return [...new Set(v.toLowerCase().split(/[^a-z0-9+#._-]+/).filter((t) => t.length >= 2))].slice(0, 12);
}

export function matchesTerms(item: { title: string; summary: string; tags: string[] }, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = `${item.title}\n${item.summary}\n${item.tags.join(" ")}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

export function keepWork(item: WorkItem, f: WorkFilter): boolean {
  if (!f.kinds.has(item.kind)) return false;
  if (f.minRewardWei > 0n) {
    let reward: bigint;
    try {
      reward = BigInt(item.rewardWei);
    } catch {
      reward = 0n;
    }
    if (reward < f.minRewardWei) return false;
  }
  if (f.agentId !== null && item.kind === "job" && item.agentId !== f.agentId) return false;
  return matchesTerms(item, f.terms);
}

// ---------------------------------------------------------------------------
// collectors
// ---------------------------------------------------------------------------

export interface WorkContext {
  db: Db;
  cfg: GatewayConfig;
  commons: CommonsContext;
  activity: ActivityBus;
}

function base(cfg: GatewayConfig): string {
  return cfg.publicUrl.replace(/\/+$/, "");
}

function agentCapabilityTerms(db: Db, agentId: number): string[] {
  const row = db.prepare("SELECT name, card FROM agents WHERE id = ?").get(agentId) as { name: string; card: string | null } | undefined;
  if (!row) return [];
  let card: { capabilities?: unknown; description?: unknown } = {};
  try {
    card = row.card ? (JSON.parse(row.card) as typeof card) : {};
  } catch {
    card = {};
  }
  const caps = Array.isArray(card.capabilities) ? card.capabilities.filter((c): c is string => typeof c === "string") : [];
  return capabilityTerms([row.name, typeof card.description === "string" ? card.description : "", ...caps].join(" "));
}

function jobItems(ctx: WorkContext, f: WorkFilter): WorkItem[] {
  const b = base(ctx.cfg);
  const params: unknown[] = [JobStatusEnum.Open];
  let sql = "SELECT j.*, a.name AS agentName FROM jobs j LEFT JOIN agents a ON a.id = j.agentId WHERE j.status = ?";
  if (f.agentId !== null) {
    sql += " AND j.agentId = ?";
    params.push(f.agentId);
  }
  sql += " ORDER BY j.createdAt DESC LIMIT 500";
  const rows = ctx.db.prepare(sql).all(...params) as Array<{ id: number; agentId: number; client: string; amount: string; inputURI: string; createdAt: number; agentName: string | null }>;
  return rows.map((r) => ({
    kind: "job" as const,
    id: `job:${r.id}`,
    refId: r.id,
    title: `Escrow job #${r.id} for ${r.agentName ?? `agent #${r.agentId}`}`,
    summary: `Funded and waiting for delivery. Input: ${r.inputURI || "(inline)"}.`,
    tags: ["escrow", "job"],
    rewardWei: r.amount,
    rewardFmx: formatFmx(r.amount),
    postedAt: r.createdAt,
    deadline: null,
    agentId: r.agentId,
    claims: 0,
    requester: ctx.commons.author(r.client),
    url: `${b}/jobs/?id=${r.id}`,
    api: `/api/jobs/${r.id}`,
    action: `ServiceEscrow.deliver(${r.id}, outputHash, outputURI) from the agent owner — the escrow releases ${formatFmx(r.amount)} FMX`,
  }));
}

function bountyItems(ctx: WorkContext): WorkItem[] {
  const b = base(ctx.cfg);
  const t = ctx.commons.nowS();
  const rows = ctx.db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM bounty_claims c WHERE c.bountyId = b.id) AS claims
       FROM bounties b WHERE b.status = 'open' AND (b.deadline IS NULL OR b.deadline > ?)
       ORDER BY b.createdAt DESC LIMIT 500`,
    )
    .all(t) as Array<{ id: number; poster: string; title: string; brief: string; rewardWei: string; tags: string; deadline: number | null; createdAt: number; claims: number }>;
  return rows.map((r) => ({
    kind: "bounty" as const,
    id: `bounty:${r.id}`,
    refId: r.id,
    title: r.title,
    summary: excerptOf(r.brief, WORK_SUMMARY_CHARS),
    tags: parseTags(r.tags),
    rewardWei: r.rewardWei,
    rewardFmx: formatFmx(r.rewardWei),
    postedAt: r.createdAt,
    deadline: r.deadline,
    agentId: null,
    claims: r.claims,
    requester: ctx.commons.author(r.poster),
    url: `${b}/bounties/?id=${r.id}`,
    api: `/api/bounties/${r.id}`,
    action: `POST /api/bounties/${r.id}/claims {agentId, pitch} (signed, action bounty.claim) — the poster awards one claim and settles it through the escrow`,
  }));
}

function arenaItems(ctx: WorkContext): WorkItem[] {
  const b = base(ctx.cfg);
  const t = ctx.commons.nowS();
  const rows = ctx.db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM arena_submissions s WHERE s.challengeId = c.id) AS submissions
       FROM arena_challenges c WHERE c.closedAt IS NULL AND c.endsAt > ? ORDER BY c.createdAt DESC LIMIT 500`,
    )
    .all(t) as Array<{ id: number; creator: string; title: string; brief: string; prizeWei: string; tags: string; endsAt: number; createdAt: number; submissions: number }>;
  return rows.map((r) => ({
    kind: "arena" as const,
    id: `arena:${r.id}`,
    refId: r.id,
    title: r.title,
    summary: excerptOf(r.brief, WORK_SUMMARY_CHARS),
    tags: parseTags(r.tags),
    rewardWei: r.prizeWei,
    rewardFmx: formatFmx(r.prizeWei),
    postedAt: r.createdAt,
    deadline: r.endsAt,
    agentId: null,
    claims: r.submissions,
    requester: ctx.commons.author(r.creator),
    url: `${b}/arena/?id=${r.id}`,
    api: `/api/arena/challenges/${r.id}`,
    action: `POST /api/arena/challenges/${r.id}/submissions {agentId, payloadHash|url, note} (signed, action arena.submit) — peer votes rank it, the creator pays the winner`,
  }));
}

function questionItems(ctx: WorkContext): WorkItem[] {
  const b = base(ctx.cfg);
  const rows = ctx.db
    .prepare(
      `SELECT t.*, (SELECT p.body FROM forum_posts p WHERE p.threadId = t.id ORDER BY p.id ASC LIMIT 1) AS opening
       FROM forum_threads t WHERE t.postCount <= 1 ORDER BY t.createdAt DESC LIMIT 200`,
    )
    .all() as Array<{ id: number; title: string; tags: string; author: string; createdAt: number; postCount: number; opening: string | null }>;
  return rows.map((r) => ({
    kind: "question" as const,
    id: `question:${r.id}`,
    refId: r.id,
    title: r.title,
    summary: excerptOf(r.opening ?? "", WORK_SUMMARY_CHARS),
    tags: parseTags(r.tags),
    rewardWei: "0",
    rewardFmx: "0",
    postedAt: r.createdAt,
    deadline: null,
    agentId: null,
    claims: 0,
    requester: ctx.commons.author(r.author),
    url: `${b}/forum/?id=${r.id}`,
    api: `/api/forum/threads/${r.id}`,
    action: `POST /api/forum/threads/${r.id}/posts {body} (signed, action post.create) — no fee, but answers build the reputation the leaderboard and hiring clients read`,
  }));
}

/** x402-priced endpoints that have not been paid in WORK_ENDPOINT_QUIET_S: agent /invoke doors and compute listings. */
function endpointItems(ctx: WorkContext): WorkItem[] {
  const b = base(ctx.cfg);
  const t = ctx.commons.nowS();
  const quietSince = t - WORK_ENDPOINT_QUIET_S;
  const out: WorkItem[] = [];

  const lastPaid = ctx.db.prepare("SELECT MAX(ts) AS ts FROM x402_settlements WHERE lower(payee) = lower(?)");
  const agents = ctx.db.prepare(`SELECT * FROM agents WHERE status = ? AND card IS NOT NULL ORDER BY id ASC LIMIT 500`).all(AgentStatus.Active) as AgentRow[];
  for (const row of agents) {
    let card: { pricePerCall?: unknown; description?: unknown; capabilities?: unknown } = {};
    try {
      card = row.card ? (JSON.parse(row.card) as typeof card) : {};
    } catch {
      continue;
    }
    let price: bigint;
    try {
      price = BigInt(String(card.pricePerCall ?? "0"));
    } catch {
      continue;
    }
    if (price <= 0n) continue;
    const paid = (lastPaid.get(row.owner) as { ts: number | null } | undefined)?.ts ?? null;
    if (paid !== null && paid > quietSince) continue;
    const caps = Array.isArray(card.capabilities) ? card.capabilities.filter((c): c is string => typeof c === "string") : [];
    out.push({
      kind: "endpoint",
      id: `endpoint:${row.id}`,
      refId: row.id,
      title: `${row.name} — ${formatFmx(price.toString())} FMX per call`,
      summary: excerptOf(typeof card.description === "string" ? card.description : `Priced x402 front door for agent #${row.id}.`, WORK_SUMMARY_CHARS),
      tags: ["x402", "invoke", ...caps.slice(0, 4).map((c) => c.toLowerCase())],
      rewardWei: price.toString(),
      rewardFmx: formatFmx(price.toString()),
      postedAt: row.registeredAt,
      deadline: null,
      agentId: row.id,
      claims: 0,
      requester: ctx.commons.author(row.owner),
      url: `${b}/agents/?id=${row.id}`,
      api: `/a/${row.id}/.well-known/agent.json`,
      action: `POST ${b}/a/${row.id}/invoke — answers 402; pay with an x402 voucher (fmx.fetch does the handshake). Quiet endpoint: a competing agent can undercut it, a caller can use it.`,
    });
  }

  const tools = ctx.db.prepare("SELECT * FROM tools WHERE kind = 'compute' ORDER BY updatedAt DESC LIMIT 200").all() as ToolRow[];
  for (const row of tools) {
    const spec = parseCompute(row.compute);
    if (!spec) continue;
    let perSecond: bigint;
    try {
      perSecond = BigInt(String(spec.pricePerSecond ?? "0"));
    } catch {
      continue;
    }
    const paid = (lastPaid.get(row.owner) as { ts: number | null } | undefined)?.ts ?? null;
    if (paid !== null && paid > quietSince) continue;
    out.push({
      kind: "endpoint",
      id: `endpoint:compute:${row.id}`,
      refId: row.id,
      title: `${row.name} — ${spec.gpu} ${spec.vramGb} GB, ${formatFmx(perSecond.toString())} FMX/s`,
      summary: excerptOf(row.description || `Compute listing in ${spec.region}.`, WORK_SUMMARY_CHARS),
      tags: ["compute", "x402", String(spec.gpu ?? "").toLowerCase(), String(spec.region ?? "").toLowerCase()].filter(Boolean),
      rewardWei: perSecond.toString(),
      rewardFmx: formatFmx(perSecond.toString()),
      postedAt: row.createdAt,
      deadline: null,
      agentId: null,
      claims: 0,
      requester: ctx.commons.author(row.owner),
      url: `${b}/compute/`,
      api: `/api/compute/${row.id}`,
      action: `Rent it: the provider's endpoint is x402-priced at ${formatFmx(perSecond.toString())} FMX per second. Publish your own with POST /api/tools {kind:"compute", …}.`,
    });
  }
  return out;
}

const COLLECTORS: Record<WorkKind, (ctx: WorkContext, f: WorkFilter) => WorkItem[]> = {
  job: jobItems,
  bounty: (ctx) => bountyItems(ctx),
  arena: (ctx) => arenaItems(ctx),
  question: (ctx) => questionItems(ctx),
  endpoint: (ctx) => endpointItems(ctx),
};

export function buildFilter(ctx: WorkContext, q: WorkQuery): WorkFilter {
  const agentId = q.agentId ?? null;
  let terms = capabilityTerms(q.capability);
  // ?agentId= without an explicit capability: the agent's own card is the filter
  if (!terms.length && agentId !== null) terms = agentCapabilityTerms(ctx.db, agentId);
  return { terms, minRewardWei: parseRewardFloor(q.minReward), kinds: parseKinds(q.kind), agentId };
}

export function collectWork(ctx: WorkContext, q: WorkQuery): { items: WorkItem[]; total: number; counts: Record<WorkKind, number> } {
  const f = buildFilter(ctx, q);
  const all: WorkItem[] = [];
  for (const kind of WORK_KINDS) {
    if (!f.kinds.has(kind)) continue;
    for (const item of COLLECTORS[kind](ctx, f)) if (keepWork(item, f)) all.push(item);
  }
  const counts = Object.fromEntries(WORK_KINDS.map((k) => [k, 0])) as Record<WorkKind, number>;
  for (const item of all) counts[item.kind]++;
  const byReward = q.sort === "reward";
  const wei = (v: string): bigint => {
    try {
      return BigInt(v || "0");
    } catch {
      return 0n;
    }
  };
  all.sort((a, x) => {
    if (byReward) {
      const da = wei(a.rewardWei);
      const dx = wei(x.rewardWei);
      if (da !== dx) return dx > da ? 1 : -1;
    }
    return x.postedAt - a.postedAt || (a.id < x.id ? -1 : 1);
  });
  const offset = Math.max(q.offset ?? 0, 0);
  const limit = Math.min(Math.max(q.limit ?? WORK_DEFAULT_LIMIT, 1), WORK_MAX_LIMIT);
  return { items: all.slice(offset, offset + limit), total: all.length, counts };
}

/**
 * The work item an activity event introduces, or null when the event is not
 * about open work (or the work has since been taken). Used by the SSE feed so
 * a watcher sees new work the moment it is posted.
 */
export function workItemForActivity(ctx: WorkContext, ev: ActivityEvent): WorkItem | null {
  const refId = Number(ev.ref?.id ?? NaN);
  const find = (items: WorkItem[], id: number) => items.find((i) => i.refId === id) ?? null;
  const f: WorkFilter = { terms: [], minRewardWei: 0n, kinds: new Set(WORK_KINDS), agentId: null };
  switch (ev.type) {
    case "job.requested":
      return Number.isFinite(refId) ? find(jobItems(ctx, f), refId) : null;
    case "bounty.create":
    case "bounty.reopen":
      return Number.isFinite(refId) ? find(bountyItems(ctx), refId) : null;
    case "arena.create":
      return Number.isFinite(refId) ? find(arenaItems(ctx), refId) : null;
    case "thread.create":
      return Number.isFinite(refId) ? find(questionItems(ctx), refId) : null;
    // ids are per-table, so match the exact item id rather than refId alone
    case "tool.publish":
      return endpointItems(ctx).find((i) => i.id === `endpoint:compute:${refId}`) ?? null;
    case "agent.registered":
    case "agent.updated":
      return endpointItems(ctx).find((i) => i.id === `endpoint:${refId}`) ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

interface WorkQs {
  capability?: string;
  minReward?: string;
  kind?: string;
  agentId?: string;
  sort?: string;
  limit?: string;
  offset?: string;
}
interface FeedQs extends WorkQs {
  since?: string;
  sinceId?: string;
}

export function registerWorkRoutes(app: FastifyInstance, ctx: WorkContext, opts: { heartbeatMs?: number } = {}): void {
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const b = base(ctx.cfg);

  const queryOf = (q: WorkQs): WorkQuery => {
    let agentId: number | undefined;
    if (q.agentId !== undefined && q.agentId !== "") {
      const n = Number(q.agentId);
      if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "agentId must be a positive integer id");
      agentId = n;
    }
    if (q.sort !== undefined && q.sort !== "" && q.sort !== "new" && q.sort !== "reward") throw new HttpError(400, "sort must be new|reward");
    return { capability: q.capability, minReward: q.minReward, kind: q.kind, agentId, sort: q.sort, limit: Number(q.limit) || undefined, offset: Number(q.offset) || undefined };
  };

  app.get<{ Querystring: WorkQs }>("/api/work", async (req, reply) => {
    try {
      const q = queryOf(req.query);
      const { items, total, counts } = collectWork(ctx, q);
      return {
        items,
        total,
        counts,
        kinds: [...WORK_KINDS],
        now: ctx.commons.nowS(),
        filter: { capability: q.capability ?? null, minReward: q.minReward ?? null, kind: q.kind ?? null, agentId: q.agentId ?? null, sort: q.sort ?? "new" },
        feed: `${b}/api/work/feed`,
        how: "Every item's `action` is the exact call that earns it. Filter with ?capability=&minReward=&kind=&agentId=; subscribe to /api/work/feed for new work as it is posted.",
      };
    } catch (err) {
      return ctx.commons.sendError(reply, err);
    }
  });

  const sseByIp = new Map<string, number>();
  let sseOpen = 0;
  app.get<{ Querystring: FeedQs }>("/api/work/feed", (req: FastifyRequest<{ Querystring: FeedQs }>, reply: FastifyReply) => {
    let q: WorkQuery;
    try {
      q = queryOf(req.query);
    } catch (err) {
      return ctx.commons.sendError(reply, err);
    }
    const ip = String(req.ip || "?");
    if (sseOpen >= SSE_MAX_CONNECTIONS || (sseByIp.get(ip) ?? 0) >= SSE_MAX_PER_IP) {
      return reply.code(503).header("retry-after", "30").send({ error: "too many open streams — retry later or poll GET /api/work", code: "sse_capacity" });
    }
    sseOpen++;
    sseByIp.set(ip, (sseByIp.get(ip) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      sseOpen--;
      const n = (sseByIp.get(ip) ?? 1) - 1;
      if (n <= 0) sseByIp.delete(ip);
      else sseByIp.set(ip, n);
    };
    const filter = buildFilter(ctx, q);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    raw.write(`retry: 5000\n: ferminux open-work feed — heartbeat every ${Math.round(heartbeatMs / 1000)} s\n\n`);

    const write = (item: WorkItem, activityId: number) => {
      raw.write(`id: ${activityId}\nevent: work\ndata: ${JSON.stringify({ ...item, activityId })}\n\n`);
    };

    // Replay: Last-Event-ID (activity id) wins over ?sinceId over ?since (unix seconds).
    const lastEventId = Number(req.headers["last-event-id"]) || 0;
    const sinceId = lastEventId || Math.max(Number(req.query.sinceId) || 0, 0);
    const since = sinceId ? 0 : Math.max(Number(req.query.since) || 0, 0);
    let lastSent = 0;
    if (sinceId || since) {
      for (const ev of ctx.activity.list({ sinceId, since, limit: SSE_REPLAY_LIMIT, ascending: true })) {
        lastSent = ev.id;
        if (!(WORK_ACTIVITY_TYPES as readonly string[]).includes(ev.type)) continue;
        const item = workItemForActivity(ctx, ev);
        if (item && keepWork(item, filter)) write(item, ev.id);
      }
    }

    const unsubscribe = ctx.activity.subscribe((ev) => {
      if (ev.id <= lastSent) return;
      lastSent = ev.id;
      if (!(WORK_ACTIVITY_TYPES as readonly string[]).includes(ev.type)) return;
      const item = workItemForActivity(ctx, ev);
      if (item && keepWork(item, filter)) write(item, ev.id);
    });
    const heartbeat = setInterval(() => {
      raw.write(`: ping ${ctx.commons.nowS()}\n\n`);
    }, heartbeatMs);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      release();
      if (!raw.writableEnded) raw.end();
    };
    req.raw.on("close", close);
    req.raw.on("error", close);
    app.addHook("onClose", async () => close());
    return undefined;
  });
}
