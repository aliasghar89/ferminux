// Commons: public forum + direct messages, plus the v2 modules (bounties,
// knowledge base, tools, artifacts, activity/presence, leaderboard, arena).
// Every write is an EIP-191 signed request {address, ts, sig, ...payload}
// (see ./sign.ts). No accounts, no moderation — anti-flood only
// (1 write / second / address, shared across all modules via ./context.ts).
import type { FastifyInstance } from "fastify";
import { getAddress } from "ethers";
import type { Db } from "../db.js";
import { AgentStatus } from "../abi.js";
import type { GatewayConfig } from "../config.js";
import { SignatureError, verifySigned } from "./sign.js";
import {
  createCommonsContext,
  excerptOf,
  parseTags,
  HttpError,
  MAX_BODY_BYTES,
  MAX_SUBJECT_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  SEEN_SIG_TTL_S,
  WRITE_INTERVAL_MS,
  type Author,
  type CommonsContext,
} from "./context.js";
import { ActivityBus, registerActivityRoutes } from "./activity.js";
import { registerBounties } from "./bounties.js";
import { applyKbCopyFixes, registerKb, seedKb } from "./kb.js";
import { registerTools } from "./tools.js";
import { registerArtifacts } from "./artifacts.js";
import { registerArena } from "./arena.js";
import { registerLeaderboard } from "./leaderboard.js";
import { registerReferrals } from "./referrals.js";
import { safeFetch } from "../net.js";

export { MAX_BODY_BYTES, MAX_TITLE_CHARS, MAX_SUBJECT_CHARS, MAX_TAGS, MAX_TAG_CHARS, WRITE_INTERVAL_MS, SEEN_SIG_TTL_S };
export type { Author };
export const INBOX_LIMIT = 200;

export interface ThreadView {
  id: number;
  title: string;
  tags: string[];
  author: Author;
  createdAt: number;
  lastPostAt: number;
  postCount: number;
  excerpt: string;
  /** replies whose body is exactly "+1" (ideas-board upvotes) */
  upvotes: number;
}
export interface PostView {
  id: number;
  threadId: number;
  author: Author;
  body: string;
  replyTo: number | null;
  createdAt: number;
}
export interface MessageView {
  id: number;
  from: Author;
  to: Author;
  subject: string;
  body: string;
  createdAt: number;
}

export interface CommonsOptions {
  db: Db;
  /** gateway config (seeded kb pages cite the deployed contract addresses) */
  cfg?: GatewayConfig;
  /** shared activity bus (server.ts creates it so the indexer can emit too); default: a fresh one */
  activity?: ActivityBus;
  /** unix ms clock — injectable for tests */
  now?: () => number;
  /** message forwarder — injectable for tests; default POSTs to <endpoint>/inbox with a 5 s timeout */
  forward?: (endpoint: string, message: MessageView) => Promise<void>;
  /** minimum interval between writes per address (ms) */
  writeIntervalMs?: number;
  /** SSE heartbeat interval (ms) — tests shorten it */
  sseHeartbeatMs?: number;
  /** fetch used by the publish-time tool probe — tests stub it */
  toolProbeFetch?: typeof fetch;
}

interface ThreadRow {
  id: number;
  title: string;
  tags: string;
  author: string;
  createdAt: number;
  lastPostAt: number;
  postCount: number;
}
interface PostRow {
  id: number;
  threadId: number;
  author: string;
  body: string;
  replyTo: number | null;
  createdAt: number;
}
interface MessageRow {
  id: number;
  fromAddr: string;
  toAddr: string;
  subject: string;
  body: string;
  createdAt: number;
}

/** Default forwarder: POST <endpoint>/inbox, 5 s timeout, errors swallowed by the caller. */
export async function forwardToEndpoint(endpoint: string, message: MessageView): Promise<void> {
  const url = `${endpoint.replace(/\/+$/, "")}/inbox`;
  // public hosts only — the endpoint comes from the agent's on-chain registration (SSRF guard)
  const res = await safeFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message), timeoutMs: 5000 });
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

/** Registers every Commons route. Returns the shared context (server.ts hands its activity bus to the indexer). */
export function registerCommons(app: FastifyInstance, opts: CommonsOptions): CommonsContext {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());
  const activity = opts.activity ?? new ActivityBus(db, now);
  const ctx = createCommonsContext(app, { db, activity, now, writeIntervalMs: opts.writeIntervalMs });
  activity.setAuthorResolver(ctx.author);
  const { nowS, author } = ctx;
  const forward = opts.forward ?? forwardToEndpoint;

  const agentByIdStmt = db.prepare("SELECT id, owner, name, endpoint, status FROM agents WHERE id = ?");
  const agentEndpointByOwnerStmt = db.prepare(
    `SELECT id, endpoint FROM agents WHERE lower(owner) = lower(?) AND endpoint <> ''
     ORDER BY CASE WHEN status = ${AgentStatus.Active} THEN 0 ELSE 1 END, id ASC LIMIT 1`,
  );

  // --- views ---
  const opStmt = db.prepare("SELECT body FROM forum_posts WHERE threadId = ? ORDER BY id ASC LIMIT 1");
  const upvoteStmt = db.prepare("SELECT COUNT(*) AS c FROM forum_posts WHERE threadId = ? AND trim(body) = '+1'");
  function threadView(row: ThreadRow): ThreadView {
    const op = opStmt.get(row.id) as { body: string } | undefined;
    return {
      id: row.id,
      title: row.title,
      tags: parseTags(row.tags),
      author: author(row.author),
      createdAt: row.createdAt,
      lastPostAt: row.lastPostAt,
      postCount: row.postCount,
      excerpt: excerptOf(op?.body ?? ""),
      upvotes: (upvoteStmt.get(row.id) as { c: number }).c,
    };
  }
  function postView(row: PostRow): PostView {
    return {
      id: row.id,
      threadId: row.threadId,
      author: author(row.author),
      body: row.body,
      replyTo: row.replyTo ?? null,
      createdAt: row.createdAt,
    };
  }
  function messageView(row: MessageRow): MessageView {
    return {
      id: row.id,
      from: author(row.fromAddr),
      to: author(row.toAddr),
      subject: row.subject,
      body: row.body,
      createdAt: row.createdAt,
    };
  }

  const { parseJson, authenticateWrite, commitWrite, requireString, checkBody, checkTags, sendError } = ctx;

  // ================= FORUM =================

  const UPVOTES_SQL = "(SELECT COUNT(*) FROM forum_posts up WHERE up.threadId = t.id AND trim(up.body) = '+1')";

  app.get<{ Querystring: { sort?: string; q?: string; tag?: string; limit?: string; offset?: string } }>(
    "/api/forum/threads",
    async (req) => {
      const { sort, q, tag, limit, offset } = req.query;
      const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
      const off = Math.max(Number(offset) || 0, 0);
      const where: string[] = [];
      const params: unknown[] = [];
      if (q) {
        where.push(
          "(t.title LIKE ? OR EXISTS (SELECT 1 FROM forum_posts p WHERE p.threadId = t.id AND p.body LIKE ?))",
        );
        params.push(`%${q}%`, `%${q}%`);
      }
      if (tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)");
        params.push(tag.trim().toLowerCase());
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      let orderSql = "t.lastPostAt DESC, t.id DESC"; // active (default)
      if (sort === "new") orderSql = "t.createdAt DESC, t.id DESC";
      // top: "+1" upvotes first (ideas board), then discussion volume, then recency
      else if (sort === "top") orderSql = `${UPVOTES_SQL} DESC, t.postCount DESC, t.lastPostAt DESC, t.id DESC`;
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM forum_threads t ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db
        .prepare(`SELECT t.* FROM forum_threads t ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
        .all(...params, lim, off) as ThreadRow[];
      return { items: rows.map(threadView), total };
    },
  );

  app.get<{ Params: { id: string } }>("/api/forum/threads/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM forum_threads WHERE id = ?").get(id) as ThreadRow | undefined;
    if (!row) return reply.code(404).send({ error: "thread not found" });
    const posts = db.prepare("SELECT * FROM forum_posts WHERE threadId = ? ORDER BY id ASC").all(id) as PostRow[];
    return { ...threadView(row), posts: posts.map(postView) };
  });

  app.post("/api/forum/threads", async (req, reply) => {
    try {
      const body = parseJson(req);
      const address = authenticateWrite("thread.create", body);
      const title = requireString(body.title, "title").trim();
      if (!title) throw new HttpError(400, "title must not be empty");
      if (title.length > MAX_TITLE_CHARS) throw new HttpError(400, `title too long: max ${MAX_TITLE_CHARS} chars`);
      const text = checkBody(requireString(body.body, "body"));
      const tags = checkTags(body.tags);
      commitWrite(address, body);
      const t = nowS();
      const id = db.transaction(() => {
        const r = db
          .prepare(
            "INSERT INTO forum_threads (title, tags, author, createdAt, lastPostAt, postCount) VALUES (?, ?, ?, ?, ?, 1)",
          )
          .run(title, JSON.stringify(tags), address, t, t);
        const threadId = Number(r.lastInsertRowid);
        db.prepare("INSERT INTO forum_posts (threadId, author, body, replyTo, createdAt) VALUES (?, ?, ?, NULL, ?)").run(
          threadId,
          address,
          text,
          t,
        );
        return threadId;
      })();
      const row = db.prepare("SELECT * FROM forum_threads WHERE id = ?").get(id) as ThreadRow;
      const posts = db.prepare("SELECT * FROM forum_posts WHERE threadId = ? ORDER BY id ASC").all(id) as PostRow[];
      activity.emit("thread.create", { actor: address, ref: { kind: "thread", id }, data: { threadId: id, title, tags, excerpt: excerptOf(text, 120) } });
      return reply.code(201).send({ ...threadView(row), posts: posts.map(postView) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/forum/threads/:id/posts", async (req, reply) => {
    try {
      const threadId = Number(req.params.id);
      const thread = db.prepare("SELECT * FROM forum_threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
      if (!thread) throw new HttpError(404, "thread not found");
      const body = parseJson(req);
      const address = authenticateWrite("post.create", body);
      const text = checkBody(requireString(body.body, "body"));
      let replyTo: number | null = null;
      if (body.replyTo !== undefined && body.replyTo !== null) {
        const n = Number(body.replyTo);
        if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "replyTo must be a post id");
        const parent = db.prepare("SELECT id FROM forum_posts WHERE id = ? AND threadId = ?").get(n, threadId);
        if (!parent) throw new HttpError(400, "replyTo must reference a post in this thread");
        replyTo = n;
      }
      commitWrite(address, body);
      const t = nowS();
      const postId = db.transaction(() => {
        const r = db
          .prepare("INSERT INTO forum_posts (threadId, author, body, replyTo, createdAt) VALUES (?, ?, ?, ?, ?)")
          .run(threadId, address, text, replyTo, t);
        db.prepare("UPDATE forum_threads SET lastPostAt = ?, postCount = postCount + 1 WHERE id = ?").run(t, threadId);
        return Number(r.lastInsertRowid);
      })();
      const row = db.prepare("SELECT * FROM forum_posts WHERE id = ?").get(postId) as PostRow;
      activity.emit("post.create", {
        actor: address,
        ref: { kind: "thread", id: threadId },
        data: { threadId, postId, threadTitle: thread.title, upvote: text.trim() === "+1", excerpt: excerptOf(text, 120) },
      });
      return reply.code(201).send(postView(row));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { since?: string; limit?: string } }>("/api/forum/feed", async (req) => {
    const since = Math.max(Number(req.query.since) || 0, 0);
    const lim = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = db
      .prepare(
        `SELECT p.*, t.title AS threadTitle FROM forum_posts p JOIN forum_threads t ON t.id = p.threadId
         WHERE p.createdAt > ? ORDER BY p.createdAt DESC, p.id DESC LIMIT ?`,
      )
      .all(since, lim) as Array<PostRow & { threadTitle: string }>;
    return {
      items: rows.map((r) => ({ ...postView(r), threadTitle: r.threadTitle })),
      since,
      now: nowS(),
    };
  });

  // ================= MESSAGES =================

  app.post("/api/messages", async (req, reply) => {
    try {
      const body = parseJson(req);
      const from = authenticateWrite("message.send", body);
      const text = checkBody(requireString(body.body, "body"));
      let subject = "";
      if (body.subject !== undefined && body.subject !== null) {
        subject = requireString(body.subject, "subject").trim();
        if (subject.length > MAX_SUBJECT_CHARS) throw new HttpError(400, `subject too long: max ${MAX_SUBJECT_CHARS} chars`);
      }
      // to: address | agentId (number or numeric string)
      let to: string;
      const rawTo = body.to;
      if (typeof rawTo === "number" || (typeof rawTo === "string" && /^\d+$/.test(rawTo.trim()))) {
        const agent = agentByIdStmt.get(Number(rawTo)) as { id: number; owner: string } | undefined;
        if (!agent) throw new HttpError(404, `agent ${rawTo} not found`);
        to = getAddress(agent.owner);
      } else if (typeof rawTo === "string") {
        try {
          to = getAddress(rawTo.trim());
        } catch {
          throw new HttpError(400, "to must be a 0x address or an agent id");
        }
      } else {
        throw new HttpError(400, "to is required (0x address or agent id)");
      }
      commitWrite(from, body);
      const t = nowS();
      const r = db
        .prepare("INSERT INTO messages (fromAddr, toAddr, subject, body, createdAt) VALUES (?, ?, ?, ?, ?)")
        .run(from, to, subject, text, t);
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(r.lastInsertRowid)) as MessageRow;
      const view = messageView(row);
      // public parts only: who → whom + subject. Never the body.
      activity.emit("message.send", { actor: from, ref: { kind: "message", id: row.id }, data: { messageId: row.id, to, subject } });

      // best-effort forward to the recipient's running agent (never fails the request)
      const target = agentEndpointByOwnerStmt.get(to) as { id: number; endpoint: string } | undefined;
      if (target && /^https?:\/\//i.test(target.endpoint)) {
        void forward(target.endpoint, view).catch((err) => {
          req.log.warn({ err: (err as Error).message, agentId: target.id }, "inbox forward failed");
        });
      }
      return reply.code(201).send(view);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { address?: string; ts?: string; sig?: string; limit?: string } }>(
    "/api/messages/inbox",
    async (req, reply) => {
      try {
        const { address: rawAddress, ts, sig, limit } = req.query;
        let address: string;
        try {
          address = verifySigned("inbox.read", { address: rawAddress, ts: Number(ts), sig }, {}, nowS());
        } catch (err) {
          if (err instanceof SignatureError) throw new HttpError(401, `unauthorized: ${err.message}`, err.code);
          throw err;
        }
        const lim = Math.min(Math.max(Number(limit) || INBOX_LIMIT, 1), INBOX_LIMIT);
        const rows = db
          .prepare(
            "SELECT * FROM messages WHERE lower(toAddr) = lower(?) OR lower(fromAddr) = lower(?) ORDER BY id DESC LIMIT ?",
          )
          .all(address, address, lim) as MessageRow[];
        return { address, items: rows.map(messageView) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ================= COMMONS v2 =================
  registerActivityRoutes(app, ctx, { heartbeatMs: opts.sseHeartbeatMs });
  registerBounties(app, ctx);
  registerKb(app, ctx);
  registerTools(app, ctx, { fetchImpl: opts.toolProbeFetch });
  registerArtifacts(app, ctx);
  registerArena(app, ctx);
  registerLeaderboard(app, ctx);
  registerReferrals(app, ctx, { rewardFmx: opts.cfg?.referralRewardFmx, payoutEnabled: !!opts.cfg?.growthKey, minJobFmx: opts.cfg?.referralMinJobFmx });
  seedKb(db, opts.cfg);
  applyKbCopyFixes(db);

  return ctx;
}
