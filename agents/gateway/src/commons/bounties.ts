// Bounties: open work any agent may claim. The reward is a promise settled
// by the poster hiring the awarded agent through ServiceEscrow (requestJob
// with amount = reward and inputURI "fmx://bounty/<id>"); the indexer links
// the job and moves the bounty open → awarded → completed (or back to open
// on refund/cancel).
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { JobStatusEnum, JobStatusName } from "../abi.js";
import { HttpError, MAX_TITLE_CHARS, parseTags, type Author, type CommonsContext } from "./context.js";
import type { ActivityBus } from "./activity.js";

export const BOUNTY_STATUSES = ["open", "awarded", "completed"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];
export const MAX_BRIEF_BYTES = 16 * 1024;
export const MAX_PITCH_BYTES = 4 * 1024;
export const BOUNTY_URI_RE = /^fmx:\/\/bounty\/(\d+)/i;

export interface BountyRow {
  id: number;
  poster: string;
  title: string;
  brief: string;
  rewardWei: string;
  tags: string;
  deadline: number | null;
  status: BountyStatus;
  awardedAgentId: number | null;
  jobId: number | null;
  createdAt: number;
  updatedAt: number;
  awardedAt: number | null;
  completedAt: number | null;
}
export interface ClaimRow {
  id: number;
  bountyId: number;
  agentId: number;
  claimer: string;
  pitch: string;
  createdAt: number;
  updatedAt: number;
}
export interface ClaimView {
  id: number;
  bountyId: number;
  agentId: number;
  agentName: string | null;
  /** {agentId, name} — alias for the web normaliser */
  agent: { agentId: number; name: string | null };
  claimer: Author;
  pitch: string;
  createdAt: number;
  updatedAt: number;
}
export interface BountyView {
  id: number;
  title: string;
  brief: string;
  rewardWei: string;
  tags: string[];
  deadline: number | null;
  status: BountyStatus;
  poster: Author;
  /** same as poster (alias for the web normaliser) */
  author: Author;
  awardedAgentId: number | null;
  awardedAgentName: string | null;
  jobId: number | null;
  jobStatus: string | null;
  claimCount: number;
  createdAt: number;
  updatedAt: number;
  awardedAt: number | null;
  completedAt: number | null;
}

export function registerBounties(app: FastifyInstance, ctx: CommonsContext): void {
  const { db, activity, nowS, author } = ctx;

  const claimCountStmt = db.prepare("SELECT COUNT(*) AS c FROM bounty_claims WHERE bountyId = ?");
  const agentNameStmt = db.prepare("SELECT name FROM agents WHERE id = ?");
  const jobStatusStmt = db.prepare("SELECT status FROM jobs WHERE id = ?");
  const getStmt = db.prepare("SELECT * FROM bounties WHERE id = ?");
  const claimsStmt = db.prepare("SELECT * FROM bounty_claims WHERE bountyId = ? ORDER BY id ASC");

  function agentName(id: number | null): string | null {
    if (id == null) return null;
    return (agentNameStmt.get(id) as { name: string } | undefined)?.name ?? null;
  }
  function view(row: BountyRow): BountyView {
    const js = row.jobId != null ? (jobStatusStmt.get(row.jobId) as { status: number } | undefined) : undefined;
    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      rewardWei: row.rewardWei,
      tags: parseTags(row.tags),
      deadline: row.deadline,
      status: row.status,
      poster: author(row.poster),
      author: author(row.poster),
      awardedAgentId: row.awardedAgentId,
      awardedAgentName: agentName(row.awardedAgentId),
      jobId: row.jobId,
      jobStatus: js ? (JobStatusName[js.status] ?? "None") : null,
      claimCount: (claimCountStmt.get(row.id) as { c: number }).c,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      awardedAt: row.awardedAt,
      completedAt: row.completedAt,
    };
  }
  function claimView(row: ClaimRow): ClaimView {
    return {
      id: row.id,
      bountyId: row.bountyId,
      agentId: row.agentId,
      agentName: agentName(row.agentId),
      agent: { agentId: row.agentId, name: agentName(row.agentId) },
      claimer: author(row.claimer),
      pitch: row.pitch,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  function detail(row: BountyRow) {
    const claims = claimsStmt.all(row.id) as ClaimRow[];
    return { ...view(row), claims: claims.map(claimView) };
  }
  function load(idRaw: string): BountyRow {
    const id = Number(idRaw);
    const row = getStmt.get(id) as BountyRow | undefined;
    if (!row) throw new HttpError(404, "bounty not found");
    return row;
  }

  app.get<{ Querystring: { status?: string; sort?: string; q?: string; tag?: string; poster?: string; limit?: string; offset?: string } }>(
    "/api/bounties",
    async (req) => {
      const { status, sort, q, tag, poster } = req.query;
      const lim = ctx.parseLimit(req.query.limit, 25, 100);
      const off = ctx.parseOffset(req.query.offset);
      const where: string[] = [];
      const params: unknown[] = [];
      if (status) {
        if (!(BOUNTY_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "status must be open|awarded|completed");
        where.push("b.status = ?");
        params.push(status);
      }
      if (q) {
        where.push("(b.title LIKE ? OR b.brief LIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      if (tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(b.tags) WHERE value = ?)");
        params.push(tag.trim().toLowerCase());
      }
      if (poster) {
        where.push("lower(b.poster) = lower(?)");
        params.push(poster);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      // reward: numeric compare on the decimal string (pad to 78 digits so string order == numeric order)
      let orderSql = "b.createdAt DESC, b.id DESC";
      if (sort === "reward") orderSql = "substr('000000000000000000000000000000000000000000000000000000000000000000000000000000' || b.rewardWei, -78) DESC, b.id DESC";
      else if (sort === "deadline") orderSql = "CASE WHEN b.deadline IS NULL THEN 1 ELSE 0 END, b.deadline ASC, b.id DESC";
      else if (sort === "active") orderSql = "b.updatedAt DESC, b.id DESC";
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM bounties b ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(`SELECT b.* FROM bounties b ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, lim, off) as BountyRow[];
      return { items: rows.map(view), total };
    },
  );

  app.get<{ Params: { id: string } }>("/api/bounties/:id", async (req, reply) => {
    try {
      return detail(load(req.params.id));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post("/api/bounties", async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("bounty.create", body);
      const title = ctx.requireString(body.title, "title").trim();
      if (!title) throw new HttpError(400, "title must not be empty");
      if (title.length > MAX_TITLE_CHARS) throw new HttpError(400, `title too long: max ${MAX_TITLE_CHARS} chars`);
      const brief = ctx.checkBody(ctx.requireString(body.brief, "brief"), MAX_BRIEF_BYTES, "brief");
      const rewardWei = ctx.checkWei(body.rewardWei, "rewardWei");
      const tags = ctx.checkTags(body.tags);
      let deadline: number | null = null;
      if (body.deadline !== undefined && body.deadline !== null) {
        const d = Number(body.deadline);
        if (!Number.isInteger(d) || d <= 0) throw new HttpError(400, "deadline must be a unix timestamp (seconds)");
        if (d <= nowS()) throw new HttpError(400, "deadline must be in the future");
        deadline = d;
      }
      ctx.commitWrite(address, body);
      const t = nowS();
      const r = db
        .prepare(
          "INSERT INTO bounties (poster, title, brief, rewardWei, tags, deadline, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        )
        .run(address, title, brief, rewardWei, JSON.stringify(tags), deadline, t, t);
      const row = getStmt.get(Number(r.lastInsertRowid)) as BountyRow;
      activity.emit("bounty.create", { actor: address, ref: { kind: "bounty", id: row.id }, data: { bountyId: row.id, title, rewardWei, tags } });
      return reply.code(201).send(detail(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/bounties/:id/claims", async (req, reply) => {
    try {
      const bounty = load(req.params.id);
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("bounty.claim", body);
      if (bounty.status !== "open") throw new HttpError(409, `bounty is ${bounty.status}; only open bounties accept claims`, "not_open");
      if (bounty.deadline != null && bounty.deadline <= nowS()) throw new HttpError(409, "bounty deadline has passed", "expired");
      const agent = ctx.requireOwnedAgent(address, body.agentId);
      const pitch = ctx.checkBody(ctx.requireString(body.pitch, "pitch"), MAX_PITCH_BYTES, "pitch");
      if (bounty.poster.toLowerCase() === address.toLowerCase()) throw new HttpError(400, "the poster cannot claim their own bounty", "self_claim");
      ctx.commitWrite(address, body);
      const t = nowS();
      const existing = db.prepare("SELECT id FROM bounty_claims WHERE bountyId = ? AND agentId = ?").get(bounty.id, agent.id) as { id: number } | undefined;
      let claimId: number;
      if (existing) {
        db.prepare("UPDATE bounty_claims SET pitch = ?, claimer = ?, updatedAt = ? WHERE id = ?").run(pitch, address, t, existing.id);
        claimId = existing.id;
      } else {
        const r = db
          .prepare("INSERT INTO bounty_claims (bountyId, agentId, claimer, pitch, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(bounty.id, agent.id, address, pitch, t, t);
        claimId = Number(r.lastInsertRowid);
      }
      db.prepare("UPDATE bounties SET updatedAt = ? WHERE id = ?").run(t, bounty.id);
      const row = db.prepare("SELECT * FROM bounty_claims WHERE id = ?").get(claimId) as ClaimRow;
      activity.emit("bounty.claim", {
        actor: address,
        ref: { kind: "bounty", id: bounty.id },
        data: { bountyId: bounty.id, title: bounty.title, claimId, agentId: agent.id, agentName: agent.name, updated: !!existing },
      });
      return reply.code(existing ? 200 : 201).send(claimView(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/bounties/:id/award", async (req, reply) => {
    try {
      const bounty = load(req.params.id);
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("bounty.award", body);
      if (bounty.poster.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, "only the bounty poster may award it", "not_poster");
      if (bounty.status === "completed") throw new HttpError(409, "bounty is already completed", "completed");
      const agentId = ctx.checkId(body.agentId, "agentId");
      const agent = ctx.agentById(agentId);
      if (!agent) throw new HttpError(404, `agent ${agentId} not found`);
      let jobId: number | null = null;
      if (body.jobId !== undefined && body.jobId !== null) {
        jobId = ctx.checkId(body.jobId, "jobId");
        // The job may not be indexed yet (award right after the hire tx) — validate when we can.
        const job = db.prepare("SELECT agentId, client, status FROM jobs WHERE id = ?").get(jobId) as { agentId: number; client: string; status: number } | undefined;
        if (job) {
          if (job.agentId !== agentId) throw new HttpError(400, `job ${jobId} is for agent ${job.agentId}, not ${agentId}`);
          if (job.client.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, `job ${jobId} was not requested by the poster`, "not_client");
        }
      }
      ctx.commitWrite(address, body);
      const t = nowS();
      const completedNow = jobId != null && (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: number } | undefined)?.status === JobStatusEnum.Completed;
      db.prepare(
        "UPDATE bounties SET status = ?, awardedAgentId = ?, jobId = ?, awardedAt = ?, completedAt = ?, updatedAt = ? WHERE id = ?",
      ).run(completedNow ? "completed" : "awarded", agentId, jobId, t, completedNow ? t : null, t, bounty.id);
      const row = getStmt.get(bounty.id) as BountyRow;
      activity.emit("bounty.award", {
        actor: address,
        ref: { kind: "bounty", id: bounty.id },
        data: { bountyId: bounty.id, title: bounty.title, agentId, agentName: agent.name, jobId, rewardWei: bounty.rewardWei },
      });
      if (completedNow) {
        activity.emit("bounty.complete", { actor: address, ref: { kind: "bounty", id: bounty.id }, data: { bountyId: bounty.id, title: bounty.title, agentId, agentName: agent.name, jobId } });
      }
      return reply.code(200).send(detail(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}

// ---------------------------------------------------------------------------
// Indexer hook: called by the indexer for every escrow job event it applies.
// Links jobs to bounties (award payload jobId, or inputURI fmx://bounty/<id>)
// and drives the status machine. Pure DB logic — unit-tested without a chain.
// ---------------------------------------------------------------------------
export interface IndexedJob {
  id: number;
  agentId: number;
  client: string;
  amount: string;
  inputURI: string;
  status: number;
}

export function applyJobToBounties(db: Db, activity: ActivityBus, job: IndexedJob, ts: number): void {
  const t = ts;
  // 1) auto-link: a job whose inputURI cites a bounty by the bounty poster
  const m = BOUNTY_URI_RE.exec(job.inputURI || "");
  if (m) {
    const bounty = db.prepare("SELECT * FROM bounties WHERE id = ?").get(Number(m[1])) as BountyRow | undefined;
    if (
      bounty &&
      bounty.status !== "completed" &&
      bounty.poster.toLowerCase() === job.client.toLowerCase() &&
      (bounty.jobId == null || bounty.jobId === job.id)
    ) {
      if (bounty.jobId !== job.id || bounty.awardedAgentId !== job.agentId || bounty.status !== "awarded") {
        db.prepare("UPDATE bounties SET status = 'awarded', awardedAgentId = ?, jobId = ?, awardedAt = COALESCE(awardedAt, ?), updatedAt = ? WHERE id = ?").run(
          job.agentId,
          job.id,
          t,
          t,
          bounty.id,
        );
        const name = (db.prepare("SELECT name FROM agents WHERE id = ?").get(job.agentId) as { name: string } | undefined)?.name ?? null;
        activity.emit("bounty.award", {
          actor: job.client,
          ref: { kind: "bounty", id: bounty.id },
          data: { bountyId: bounty.id, title: bounty.title, agentId: job.agentId, agentName: name, jobId: job.id, rewardWei: bounty.rewardWei, viaJob: true },
          dedupKey: `bounty.award:${bounty.id}:${job.id}`,
          ts: t,
        });
      }
    }
  }
  // 2) status machine for linked bounties
  const linked = db.prepare("SELECT * FROM bounties WHERE jobId = ? AND status <> 'completed'").all(job.id) as BountyRow[];
  for (const bounty of linked) {
    const name = (db.prepare("SELECT name FROM agents WHERE id = ?").get(bounty.awardedAgentId ?? -1) as { name: string } | undefined)?.name ?? null;
    if (job.status === JobStatusEnum.Completed) {
      db.prepare("UPDATE bounties SET status = 'completed', completedAt = ?, updatedAt = ? WHERE id = ?").run(t, t, bounty.id);
      activity.emit("bounty.complete", {
        actor: bounty.poster,
        ref: { kind: "bounty", id: bounty.id },
        data: { bountyId: bounty.id, title: bounty.title, agentId: bounty.awardedAgentId, agentName: name, jobId: job.id, rewardWei: bounty.rewardWei },
        dedupKey: `bounty.complete:${bounty.id}:${job.id}`,
        ts: t,
      });
    } else if (job.status === JobStatusEnum.Refunded) {
      db.prepare("UPDATE bounties SET status = 'open', awardedAgentId = NULL, jobId = NULL, awardedAt = NULL, updatedAt = ? WHERE id = ?").run(t, bounty.id);
      activity.emit("bounty.reopen", {
        actor: bounty.poster,
        ref: { kind: "bounty", id: bounty.id },
        data: { bountyId: bounty.id, title: bounty.title, agentId: bounty.awardedAgentId, agentName: name, jobId: job.id, reason: "refunded" },
        dedupKey: `bounty.reopen:${bounty.id}:${job.id}`,
        ts: t,
      });
    }
  }
}

export function openBountyCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM bounties WHERE status = 'open'").get() as { c: number }).c;
}
