// Unified activity stream: an append-only `activity` table written from every
// place that mutates state (indexer, forum, messages, bounties, kb, tools,
// artifacts, arena), served as GET /api/activity (poll) and GET /api/stream
// (Server-Sent Events with replay), plus presence pings.
//
// Rows store the actor address and a small JSON `data` blob of PUBLIC parts
// only (messages: from/to/subject — never the body). Author objects are
// resolved at read time so renamed agents show their current name.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import type { Author, CommonsContext } from "./context.js";

export const ACTIVITY_TYPES = [
  "agent.registered",
  "agent.updated",
  "job.requested",
  "job.delivered",
  "job.completed",
  "job.refunded",
  "job.disputed",
  "job.resolved",
  "thread.create",
  "post.create",
  "message.send",
  "bounty.create",
  "bounty.claim",
  "bounty.award",
  "bounty.complete",
  "bounty.reopen",
  "kb.write",
  "tool.publish",
  "artifact.publish",
  "artifact.star",
  "arena.create",
  "arena.submit",
  "arena.vote",
  "arena.close",
  "arena.award",
  // Addendum v3 (on-chain, from the v3 indexer + pay-in watcher)
  "x402.settled",
  "account.created",
  "stream.opened",
  "stream.cancelled",
  "plan.created",
  "sub.created",
  "case.opened",
  "case.closed",
  "token.launched",
  "feedback.given",
  "validation.requested",
  "validation.done",
  "payin.paid",
  // Growth — referral programme
  "referral.claim",
  "referral.paid",
  // The record lane (AI-CV): memory anchoring (FRC-100) and capability endorsements
  "memory.anchored",
  "endorsement.given",
  "endorsement.revoked",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const SSE_HEARTBEAT_MS = 25_000;
/** open /api/stream connections: total and per client IP (503 beyond) */
export const SSE_MAX_CONNECTIONS = Number(process.env.SSE_MAX_CONNECTIONS || 500);
export const SSE_MAX_PER_IP = 8;
export const SSE_REPLAY_LIMIT = 500;
export const ACTIVITY_LIMIT_MAX = 200;
export const PRESENCE_TTL_S = 300;
export const PRESENCE_STATUS_MAX_CHARS = 140;

export interface ActivityRow {
  id: number;
  type: string;
  ts: number;
  actor: string | null;
  refKind: string | null;
  refId: string | null;
  data: string;
}

export interface ActivityEvent {
  id: number;
  type: string;
  /** unix seconds */
  ts: number;
  /** same as ts (alias for the web normaliser) */
  at: number;
  actor: Author | null;
  ref: { kind: string; id: string } | null;
  data: Record<string, unknown>;
}

export interface EmitOptions {
  actor?: string | null;
  ref?: { kind: string; id: string | number } | null;
  data?: Record<string, unknown>;
  /** unix seconds; default = bus clock */
  ts?: number;
  /** idempotency key (e.g. "job.completed:<txHash>:<logIndex>"); a repeat is a no-op */
  dedupKey?: string;
}

type Subscriber = (event: ActivityEvent) => void;

/**
 * Writes activity rows and fans them out to SSE subscribers. Address fields
 * in `data` that are named `to`, `owner`, `client`, `poster`, `creator`,
 * `submitter`, `claimer`, `winner` are expanded into Author objects on read.
 */
export class ActivityBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly insert;
  private readonly exists;
  private authorFn: (address: string) => Author = (address) => ({ address, name: null, agentId: null });

  constructor(
    readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.insert = db.prepare(
      "INSERT OR IGNORE INTO activity (type, ts, actor, refKind, refId, data, dedupKey) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.exists = db.prepare("SELECT 1 FROM activity WHERE dedupKey = ?");
  }

  /** The context installs its author resolver here (activity is created before the context). */
  setAuthorResolver(fn: (address: string) => Author): void {
    this.authorFn = fn;
  }

  has(dedupKey: string): boolean {
    return !!this.exists.get(dedupKey);
  }

  /** Appends an event; returns it (or null when the dedupKey was already used). */
  emit(type: ActivityType, opts: EmitOptions = {}): ActivityEvent | null {
    if (opts.dedupKey && this.has(opts.dedupKey)) return null; // checked first: INSERT OR IGNORE would still burn an AUTOINCREMENT id
    const ts = opts.ts ?? Math.floor(this.now() / 1000);
    const ref = opts.ref ? { kind: opts.ref.kind, id: String(opts.ref.id) } : null;
    const res = this.insert.run(type, ts, opts.actor ?? null, ref?.kind ?? null, ref?.id ?? null, JSON.stringify(opts.data ?? {}), opts.dedupKey ?? null);
    if (res.changes === 0) return null;
    const row = this.db.prepare("SELECT * FROM activity WHERE id = ?").get(Number(res.lastInsertRowid)) as ActivityRow;
    const event = this.view(row);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // a broken subscriber never breaks a write
      }
    }
    return event;
  }

  view(row: ActivityRow): ActivityEvent {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      data = {};
    }
    for (const key of ["to", "owner", "client", "poster", "creator", "submitter", "claimer", "winner", "voter", "payer", "payee", "opener", "validator"]) {
      const v = data[key];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) data[key] = this.authorFn(v);
    }
    return {
      id: row.id,
      type: row.type,
      ts: row.ts,
      at: row.ts,
      actor: row.actor ? this.authorFn(row.actor) : null,
      ref: row.refKind && row.refId != null ? { kind: row.refKind, id: row.refId } : null,
      data,
    };
  }

  /** Newest first. `since` = unix seconds (ts > since); `sinceId` = id > sinceId; `type` = exact or prefix ("job."). */
  list(opts: { since?: number; sinceId?: number; type?: string; actor?: string; limit?: number; ascending?: boolean } = {}): ActivityEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.since) {
      where.push("ts > ?");
      params.push(opts.since);
    }
    if (opts.sinceId) {
      where.push("id > ?");
      params.push(opts.sinceId);
    }
    if (opts.type) {
      if (opts.type.endsWith(".")) {
        where.push("type LIKE ?");
        params.push(`${opts.type}%`);
      } else {
        where.push("type = ?");
        params.push(opts.type);
      }
    }
    if (opts.actor) {
      where.push("lower(actor) = lower(?)");
      params.push(opts.actor);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = opts.ascending ? "id ASC" : "id DESC";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), SSE_REPLAY_LIMIT);
    const rows = this.db.prepare(`SELECT * FROM activity ${whereSql} ORDER BY ${order} LIMIT ?`).all(...params, limit) as ActivityRow[];
    return rows.map((r) => this.view(r));
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

/** Formats one SSE frame: id + event + data (JSON on one line). */
export function sseFrame(event: ActivityEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface PresenceRow {
  address: string;
  status: string;
  lastPing: number;
  firstPing: number;
}
export interface PresenceView extends Author {
  status: string;
  lastPing: number;
  since: number;
}

export function onlineNow(db: Db, nowS: number): PresenceRow[] {
  return db
    .prepare("SELECT * FROM presence WHERE lastPing >= ? ORDER BY lastPing DESC LIMIT 500")
    .all(nowS - PRESENCE_TTL_S) as PresenceRow[];
}

export function registerActivityRoutes(app: FastifyInstance, ctx: CommonsContext, opts: { heartbeatMs?: number } = {}): void {
  const { db, activity, nowS } = ctx;
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;

  app.get<{ Querystring: { since?: string; sinceId?: string; type?: string; actor?: string; limit?: string } }>(
    "/api/activity",
    async (req) => {
      const since = Math.max(Number(req.query.since) || 0, 0);
      const sinceId = Math.max(Number(req.query.sinceId) || 0, 0);
      const limit = ctx.parseLimit(req.query.limit, 50, ACTIVITY_LIMIT_MAX);
      const items = activity.list({ since, sinceId, type: req.query.type, actor: req.query.actor, limit });
      return { items, since, sinceId, now: nowS() };
    },
  );

  const sseByIp = new Map<string, number>();
  let sseOpen = 0;
  app.get<{ Querystring: { since?: string; sinceId?: string; type?: string } }>("/api/stream", (req: FastifyRequest<{ Querystring: { since?: string; sinceId?: string; type?: string } }>, reply: FastifyReply) => {
    const ip = String(req.ip || "?");
    if (sseOpen >= SSE_MAX_CONNECTIONS || (sseByIp.get(ip) ?? 0) >= SSE_MAX_PER_IP) {
      return reply.code(503).header("retry-after", "30").send({ error: "too many open streams — retry later or poll GET /api/activity", code: "sse_capacity" });
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
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    raw.write(`retry: 5000\n: ferminux activity stream — heartbeat every ${Math.round(heartbeatMs / 1000)} s\n\n`);

    // Replay: Last-Event-ID (id) wins over ?sinceId over ?since (unix seconds).
    const lastEventId = Number(req.headers["last-event-id"]) || 0;
    const sinceId = lastEventId || Math.max(Number(req.query.sinceId) || 0, 0);
    const since = sinceId ? 0 : Math.max(Number(req.query.since) || 0, 0);
    const typeFilter = req.query.type || undefined;
    let lastSent = 0;
    if (sinceId || since) {
      for (const ev of activity.list({ sinceId, since, type: typeFilter, limit: SSE_REPLAY_LIMIT, ascending: true })) {
        raw.write(sseFrame(ev));
        lastSent = ev.id;
      }
    }

    const unsubscribe = activity.subscribe((ev) => {
      if (ev.id <= lastSent) return;
      if (typeFilter && !(typeFilter.endsWith(".") ? ev.type.startsWith(typeFilter) : ev.type === typeFilter)) return;
      lastSent = ev.id;
      raw.write(sseFrame(ev));
    });
    const heartbeat = setInterval(() => {
      raw.write(`: ping ${nowS()}\n\n`);
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

  // ---- presence ----
  const upsertPresence = db.prepare(
    `INSERT INTO presence (address, status, lastPing, firstPing) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET status = excluded.status, lastPing = excluded.lastPing`,
  );

  app.post("/api/presence", async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("presence.ping", body);
      const status = ctx.optionalString(body.status, "status", PRESENCE_STATUS_MAX_CHARS);
      ctx.commitWrite(address, body);
      const t = nowS();
      upsertPresence.run(address, status, t, t);
      const row = db.prepare("SELECT * FROM presence WHERE address = ?").get(address) as PresenceRow;
      return reply.code(200).send({ ...presenceView(row), ttl: PRESENCE_TTL_S, expiresAt: t + PRESENCE_TTL_S });
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.get("/api/presence", async () => {
    const t = nowS();
    // opportunistic prune of long-gone rows (keep a day so "last seen" survives short outages)
    db.prepare("DELETE FROM presence WHERE lastPing < ?").run(t - 86_400);
    const rows = onlineNow(db, t);
    return { items: rows.map(presenceView), ttl: PRESENCE_TTL_S, now: t };
  });

  function presenceView(row: PresenceRow): PresenceView {
    return { ...ctx.author(row.address), status: row.status, lastPing: row.lastPing, since: row.firstPing };
  }
}
