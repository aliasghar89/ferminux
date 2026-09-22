// Arena: challenges, submissions and peer voting. Votes are 1..10, one per
// address per submission (a second vote updates the score); addresses that
// own an Active agent weigh 2×; the submitter cannot vote on its own entry.
// The winner is frozen lazily on the first read after endsAt.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { JobStatusName } from "../abi.js";
import { HttpError, MAX_TITLE_CHARS, parseTags, type Author, type CommonsContext } from "./context.js";
import type { ActivityBus } from "./activity.js";

export const ARENA_BRIEF_MAX_BYTES = 16 * 1024;
export const ARENA_RULES_MAX_BYTES = 8 * 1024;
export const ARENA_NOTE_MAX_BYTES = 4 * 1024;
export const ARENA_MIN_DURATION_S = 600;
export const ARENA_MAX_DURATION_S = 90 * 86_400;
export const VOTE_WEIGHT_AGENT = 2;
export const VOTE_WEIGHT_PLAIN = 1;

export interface ChallengeRow {
  id: number;
  creator: string;
  title: string;
  brief: string;
  rules: string;
  prizeWei: string;
  tags: string;
  endsAt: number;
  winnerSubmissionId: number | null;
  closedAt: number | null;
  awardedAgentId: number | null;
  jobId: number | null;
  awardedAt: number | null;
  createdAt: number;
}
export interface SubmissionRow {
  id: number;
  challengeId: number;
  submitter: string;
  agentId: number | null;
  payloadHash: string | null;
  url: string | null;
  note: string;
  createdAt: number;
}
export interface VoteRow {
  submissionId: number;
  voter: string;
  score: number;
  weight: number;
  createdAt: number;
  updatedAt: number;
}
export interface SubmissionView {
  id: number;
  challengeId: number;
  submitter: Author;
  /** same as submitter (alias for the web normaliser) */
  author: Author;
  agentId: number | null;
  agentName: string | null;
  /** {agentId, name} — alias for the web normaliser (null when submitted without an agent) */
  agent: { agentId: number; name: string | null } | null;
  payloadHash: string | null;
  payloadURI: string | null;
  url: string | null;
  note: string;
  createdAt: number;
  /** the viewer's own score on this submission (only with ?viewer=) */
  myVote?: number | null;
  votes: number;
  weightSum: number;
  /** weighted mean score 1..10 (null without votes) */
  score: number | null;
  /** weighted score sum — the ranking key */
  points: number;
  rank: number;
}
export interface ChallengeView {
  id: number;
  title: string;
  brief: string;
  rules: string;
  prizeWei: string;
  tags: string[];
  endsAt: number;
  /** open → closed (endsAt passed, winner frozen) → awarded (creator linked the escrow job) */
  status: "open" | "closed" | "awarded";
  creator: Author;
  /** same as creator (alias for the web normaliser) */
  author: Author;
  submissionCount: number;
  voteCount: number;
  winnerSubmissionId: number | null;
  winner: SubmissionView | null;
  closedAt: number | null;
  awardedAgentId: number | null;
  awardedAgentName: string | null;
  jobId: number | null;
  jobStatus: string | null;
  awardedAt: number | null;
  createdAt: number;
}

/** Weighted ranking: by points (Σ score·weight) desc, then mean score, then vote count, then earliest submission. */
export function rankSubmissions(rows: Array<{ id: number; createdAt: number; votes: number; weightSum: number; points: number }>): number[] {
  return [...rows]
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const ma = a.weightSum ? a.points / a.weightSum : 0;
      const mb = b.weightSum ? b.points / b.weightSum : 0;
      if (mb !== ma) return mb - ma;
      if (b.votes !== a.votes) return b.votes - a.votes;
      return a.createdAt - b.createdAt || a.id - b.id;
    })
    .map((r) => r.id);
}

export function registerArena(app: FastifyInstance, ctx: CommonsContext): void {
  const { db, activity, nowS, author } = ctx;
  const getStmt = db.prepare("SELECT * FROM arena_challenges WHERE id = ?");
  const subsStmt = db.prepare("SELECT * FROM arena_submissions WHERE challengeId = ? ORDER BY id ASC");
  const subStmt = db.prepare("SELECT * FROM arena_submissions WHERE id = ?");
  const tallyStmt = db.prepare(
    "SELECT COUNT(*) AS votes, COALESCE(SUM(weight), 0) AS weightSum, COALESCE(SUM(score * weight), 0) AS points FROM arena_votes WHERE submissionId = ?",
  );
  const agentNameStmt = db.prepare("SELECT name FROM agents WHERE id = ?");
  const voteCountStmt = db.prepare("SELECT COUNT(*) AS c FROM arena_votes v JOIN arena_submissions s ON s.id = v.submissionId WHERE s.challengeId = ?");

  function tally(id: number) {
    return tallyStmt.get(id) as { votes: number; weightSum: number; points: number };
  }
  const myVoteStmt = db.prepare("SELECT score FROM arena_votes WHERE submissionId = ? AND lower(voter) = lower(?)");
  function submissionViews(challengeId: number, viewer?: string): SubmissionView[] {
    const rows = subsStmt.all(challengeId) as SubmissionRow[];
    const withTally = rows.map((r) => ({ ...r, ...tally(r.id) }));
    const order = rankSubmissions(withTally);
    return withTally
      .map((r) => ({
        id: r.id,
        challengeId: r.challengeId,
        submitter: author(r.submitter),
        author: author(r.submitter),
        agentId: r.agentId,
        agentName: r.agentId != null ? ((agentNameStmt.get(r.agentId) as { name: string } | undefined)?.name ?? null) : null,
        agent: r.agentId != null ? { agentId: r.agentId, name: (agentNameStmt.get(r.agentId) as { name: string } | undefined)?.name ?? null } : null,
        payloadHash: r.payloadHash,
        payloadURI: r.payloadHash ? `fmx://payload/${r.payloadHash}` : null,
        url: r.url,
        note: r.note,
        createdAt: r.createdAt,
        ...(viewer ? { myVote: (myVoteStmt.get(r.id, viewer) as { score: number } | undefined)?.score ?? null } : {}),
        votes: r.votes,
        weightSum: r.weightSum,
        score: r.weightSum ? Math.round((r.points / r.weightSum) * 100) / 100 : null,
        points: r.points,
        rank: order.indexOf(r.id) + 1,
      }))
      .sort((a, b) => a.rank - b.rank);
  }

  /** Freezes the winner once endsAt has passed (idempotent). Returns the fresh row. */
  function settle(row: ChallengeRow): ChallengeRow {
    if (row.closedAt != null || row.endsAt > nowS()) return row;
    return settleChallenge(db, activity, row, nowS());
  }

  function view(rowIn: ChallengeRow, subs?: SubmissionView[]): ChallengeView {
    const row = settle(rowIn);
    const list = subs ?? submissionViews(row.id);
    const winner = row.winnerSubmissionId != null ? (list.find((s) => s.id === row.winnerSubmissionId) ?? null) : null;
    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      rules: row.rules,
      prizeWei: row.prizeWei,
      tags: parseTags(row.tags),
      endsAt: row.endsAt,
      status: row.awardedAt != null ? "awarded" : row.closedAt != null ? "closed" : "open",
      creator: author(row.creator),
      author: author(row.creator),
      submissionCount: list.length,
      voteCount: (voteCountStmt.get(row.id) as { c: number }).c,
      winnerSubmissionId: row.winnerSubmissionId,
      winner,
      closedAt: row.closedAt,
      awardedAgentId: row.awardedAgentId,
      awardedAgentName: row.awardedAgentId != null ? ((agentNameStmt.get(row.awardedAgentId) as { name: string } | undefined)?.name ?? null) : null,
      jobId: row.jobId,
      jobStatus: row.jobId != null ? (JobStatusName[(db.prepare("SELECT status FROM jobs WHERE id = ?").get(row.jobId) as { status: number } | undefined)?.status ?? -1] ?? null) : null,
      awardedAt: row.awardedAt,
      createdAt: row.createdAt,
    };
  }
  function load(idRaw: string): ChallengeRow {
    const row = getStmt.get(Number(idRaw)) as ChallengeRow | undefined;
    if (!row) throw new HttpError(404, "challenge not found");
    return settle(row);
  }

  app.get<{ Querystring: { status?: string; q?: string; tag?: string; limit?: string; offset?: string } }>("/api/arena/challenges", async (req) => {
    const { status, q, tag } = req.query;
    const lim = ctx.parseLimit(req.query.limit, 25, 100);
    const off = ctx.parseOffset(req.query.offset);
    const t = nowS();
    const where: string[] = [];
    const params: unknown[] = [];
    if (status === "open") {
      where.push("closedAt IS NULL AND endsAt > ?");
      params.push(t);
    } else if (status === "closed") {
      where.push("(closedAt IS NOT NULL OR endsAt <= ?)");
      params.push(t);
    } else if (status) throw new HttpError(400, "status must be open|closed");
    if (q) {
      where.push("(title LIKE ? OR brief LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(arena_challenges.tags) WHERE value = ?)");
      params.push(tag.trim().toLowerCase());
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderSql = status === "closed" ? "endsAt DESC, id DESC" : "CASE WHEN closedAt IS NULL AND endsAt > ? THEN 0 ELSE 1 END, endsAt ASC, id DESC";
    const orderParams = status === "closed" ? [] : [t];
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM arena_challenges ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM arena_challenges ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, ...orderParams, lim, off) as ChallengeRow[];
    return { items: rows.map((r) => view(r)), total, now: t };
  });

  app.get<{ Params: { id: string }; Querystring: { viewer?: string } }>("/api/arena/challenges/:id", async (req, reply) => {
    try {
      const row = load(req.params.id);
      const viewer = req.query.viewer && /^0x[0-9a-fA-F]{40}$/.test(req.query.viewer) ? req.query.viewer : undefined;
      const subs = submissionViews(row.id, viewer);
      const myVotes: Record<string, number> = {};
      if (viewer) for (const s of subs) if (s.myVote != null) myVotes[String(s.id)] = s.myVote;
      return { ...view(row, subs), submissions: subs, ...(viewer ? { viewer, myVotes } : {}) };
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/arena/challenges/:id/award", async (req, reply) => {
    try {
      const challenge = load(req.params.id);
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("arena.award", body);
      if (challenge.creator.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, "only the challenge creator may award it", "not_creator");
      if (challenge.closedAt == null || challenge.endsAt > nowS()) throw new HttpError(409, "challenge is still open; award after endsAt", "not_closed");
      const agentId = ctx.checkId(body.agentId, "agentId");
      const agent = ctx.agentById(agentId);
      if (!agent) throw new HttpError(404, `agent ${agentId} not found`);
      let jobId: number | null = null;
      if (body.jobId !== undefined && body.jobId !== null) {
        jobId = ctx.checkId(body.jobId, "jobId");
        const job = db.prepare("SELECT agentId, client FROM jobs WHERE id = ?").get(jobId) as { agentId: number; client: string } | undefined;
        if (job) {
          if (job.agentId !== agentId) throw new HttpError(400, `job ${jobId} is for agent ${job.agentId}, not ${agentId}`);
          if (job.client.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, `job ${jobId} was not requested by the creator`, "not_client");
        }
      }
      ctx.commitWrite(address, body);
      const t = nowS();
      db.prepare("UPDATE arena_challenges SET awardedAgentId = ?, jobId = ?, awardedAt = COALESCE(awardedAt, ?) WHERE id = ?").run(agentId, jobId, t, challenge.id);
      const row = getStmt.get(challenge.id) as ChallengeRow;
      activity.emit("arena.award", {
        actor: address,
        ref: { kind: "challenge", id: challenge.id },
        data: { challengeId: challenge.id, title: challenge.title, agentId, agentName: agent.name, jobId, prizeWei: challenge.prizeWei, winnerSubmissionId: challenge.winnerSubmissionId },
      });
      const subs = submissionViews(row.id);
      return reply.code(200).send({ ...view(row, subs), submissions: subs });
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post("/api/arena/challenges", async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("arena.create", body);
      const title = ctx.requireString(body.title, "title").trim();
      if (!title) throw new HttpError(400, "title must not be empty");
      if (title.length > MAX_TITLE_CHARS) throw new HttpError(400, `title too long: max ${MAX_TITLE_CHARS} chars`);
      const brief = ctx.checkBody(ctx.requireString(body.brief, "brief"), ARENA_BRIEF_MAX_BYTES, "brief");
      const rules = body.rules === undefined || body.rules === null ? "" : ctx.requireString(body.rules, "rules").trim();
      if (Buffer.byteLength(rules, "utf8") > ARENA_RULES_MAX_BYTES) throw new HttpError(413, `rules too large: max ${ARENA_RULES_MAX_BYTES} bytes`);
      const prizeWei = ctx.checkWei(body.prizeWei, "prizeWei", false);
      const tags = ctx.checkTags(body.tags);
      const endsAt = Number(body.endsAt);
      if (!Number.isInteger(endsAt) || endsAt <= 0) throw new HttpError(400, "endsAt must be a unix timestamp (seconds)");
      const t = nowS();
      if (endsAt < t + ARENA_MIN_DURATION_S) throw new HttpError(400, `endsAt must be at least ${ARENA_MIN_DURATION_S} s in the future`);
      if (endsAt > t + ARENA_MAX_DURATION_S) throw new HttpError(400, "endsAt must be within 90 days");
      ctx.commitWrite(address, body);
      const r = db
        .prepare("INSERT INTO arena_challenges (creator, title, brief, rules, prizeWei, tags, endsAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(address, title, brief, rules, prizeWei, JSON.stringify(tags), endsAt, t);
      const row = getStmt.get(Number(r.lastInsertRowid)) as ChallengeRow;
      activity.emit("arena.create", { actor: address, ref: { kind: "challenge", id: row.id }, data: { challengeId: row.id, title, prizeWei, endsAt, tags } });
      return reply.code(201).send({ ...view(row, []), submissions: [] });
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/arena/challenges/:id/submissions", async (req, reply) => {
    try {
      const challenge = load(req.params.id);
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("arena.submit", body);
      if (challenge.closedAt != null || challenge.endsAt <= nowS()) throw new HttpError(409, "challenge is closed", "closed");
      let agentId: number | null = null;
      let agentName: string | null = null;
      if (body.agentId !== undefined && body.agentId !== null) {
        const a = ctx.requireOwnedAgent(address, body.agentId);
        agentId = a.id;
        agentName = a.name;
      }
      let payloadHash: string | null = null;
      if (body.payloadHash !== undefined && body.payloadHash !== null && body.payloadHash !== "") {
        const h = ctx.requireString(body.payloadHash, "payloadHash").trim().toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(h)) throw new HttpError(400, "payloadHash must be a 0x-prefixed keccak256 hex");
        if (!db.prepare("SELECT 1 FROM payloads WHERE hash = ?").get(h)) throw new HttpError(400, `payloadHash ${h} is not in the payload store — POST /api/payloads first`, "unknown_payload");
        payloadHash = h;
      }
      let url: string | null = null;
      if (body.url !== undefined && body.url !== null && body.url !== "") {
        url = ctx.checkHttpsUrl(body.url, "url");
        if (!url.startsWith("https://")) throw new HttpError(400, "url must be https://");
      }
      if (!payloadHash && !url) throw new HttpError(400, "payloadHash (uploaded via /api/payloads) or an https url is required");
      const note = body.note === undefined || body.note === null ? "" : ctx.requireString(body.note, "note").trim();
      if (Buffer.byteLength(note, "utf8") > ARENA_NOTE_MAX_BYTES) throw new HttpError(413, `note too large: max ${ARENA_NOTE_MAX_BYTES} bytes`);
      const dup = db.prepare("SELECT id FROM arena_submissions WHERE challengeId = ? AND lower(submitter) = lower(?)").get(challenge.id, address) as { id: number } | undefined;
      if (dup) throw new HttpError(409, `you already submitted (#${dup.id}) to this challenge`, "already_submitted");
      ctx.commitWrite(address, body);
      const t = nowS();
      const r = db
        .prepare("INSERT INTO arena_submissions (challengeId, submitter, agentId, payloadHash, url, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(challenge.id, address, agentId, payloadHash, url, note, t);
      const id = Number(r.lastInsertRowid);
      activity.emit("arena.submit", {
        actor: address,
        ref: { kind: "challenge", id: challenge.id },
        data: { challengeId: challenge.id, title: challenge.title, submissionId: id, agentId, agentName, note: note.slice(0, 160) },
      });
      const subs = submissionViews(challenge.id);
      return reply.code(201).send(subs.find((s) => s.id === id));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/arena/submissions/:id/vote", async (req, reply) => {
    try {
      const sub = subStmt.get(Number(req.params.id)) as SubmissionRow | undefined;
      if (!sub) throw new HttpError(404, "submission not found");
      const challenge = load(String(sub.challengeId));
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("arena.vote", body);
      if (challenge.closedAt != null || challenge.endsAt <= nowS()) throw new HttpError(409, "challenge is closed; votes are frozen", "closed");
      const score = Number(body.score);
      if (!Number.isInteger(score) || score < 1 || score > 10) throw new HttpError(400, "score must be an integer 1..10");
      if (sub.submitter.toLowerCase() === address.toLowerCase()) throw new HttpError(403, "you cannot vote on your own submission", "self_vote");
      const weight = ctx.ownsActiveAgent(address) ? VOTE_WEIGHT_AGENT : VOTE_WEIGHT_PLAIN;
      ctx.commitWrite(address, body);
      const t = nowS();
      const existing = db.prepare("SELECT * FROM arena_votes WHERE submissionId = ? AND voter = ?").get(sub.id, address) as VoteRow | undefined;
      db.prepare(
        `INSERT INTO arena_votes (submissionId, voter, score, weight, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(submissionId, voter) DO UPDATE SET score = excluded.score, weight = excluded.weight, updatedAt = excluded.updatedAt`,
      ).run(sub.id, address, score, weight, t, t);
      activity.emit("arena.vote", {
        actor: address,
        ref: { kind: "challenge", id: challenge.id },
        data: { challengeId: challenge.id, title: challenge.title, submissionId: sub.id, score, weight, updated: !!existing },
      });
      const subs = submissionViews(challenge.id);
      return reply.code(200).send({ ...subs.find((s) => s.id === sub.id), yourVote: { score, weight, updated: !!existing } });
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}

/** Stores the winner once (idempotent) and emits arena.close. Exported for tests. */
export function settleChallenge(db: Db, activity: ActivityBus, row: ChallengeRow, nowS: number): ChallengeRow {
  if (row.closedAt != null) return row;
  const subs = db.prepare("SELECT * FROM arena_submissions WHERE challengeId = ? ORDER BY id ASC").all(row.id) as SubmissionRow[];
  const tallies = subs.map((s) => ({
    ...s,
    ...(db
      .prepare("SELECT COUNT(*) AS votes, COALESCE(SUM(weight), 0) AS weightSum, COALESCE(SUM(score * weight), 0) AS points FROM arena_votes WHERE submissionId = ?")
      .get(s.id) as { votes: number; weightSum: number; points: number }),
  }));
  const voted = tallies.filter((t) => t.votes > 0);
  const winnerId = voted.length ? rankSubmissions(voted)[0] : null;
  const closedAt = Math.max(row.endsAt, Math.min(nowS, row.endsAt)); // == endsAt: the freeze time is the deadline
  db.prepare("UPDATE arena_challenges SET winnerSubmissionId = ?, closedAt = ? WHERE id = ? AND closedAt IS NULL").run(winnerId, closedAt, row.id);
  const fresh = db.prepare("SELECT * FROM arena_challenges WHERE id = ?").get(row.id) as ChallengeRow;
  const winner = winnerId != null ? tallies.find((t) => t.id === winnerId) : undefined;
  activity.emit("arena.close", {
    actor: row.creator,
    ref: { kind: "challenge", id: row.id },
    data: {
      challengeId: row.id,
      title: row.title,
      prizeWei: row.prizeWei,
      winnerSubmissionId: winnerId,
      winner: winner?.submitter ?? null,
      winnerAgentId: winner?.agentId ?? null,
      submissions: subs.length,
    },
    dedupKey: `arena.close:${row.id}`,
    ts: closedAt,
  });
  return fresh;
}

export function arenaCounts(db: Db, nowS: number): { openChallenges: number; challenges: number } {
  const challenges = (db.prepare("SELECT COUNT(*) AS c FROM arena_challenges").get() as { c: number }).c;
  const openChallenges = (db.prepare("SELECT COUNT(*) AS c FROM arena_challenges WHERE closedAt IS NULL AND endsAt > ?").get(nowS) as { c: number }).c;
  return { openChallenges, challenges };
}

export const ARENA_URI_RE = /^fmx:\/\/arena\/(\d+)/i;

/** Indexer hook: a job whose inputURI cites a closed challenge, requested by its creator, links as the award. */
export function applyJobToArena(db: Db, activity: ActivityBus, job: { id: number; agentId: number; client: string; inputURI: string }, ts: number): void {
  const m = ARENA_URI_RE.exec(job.inputURI || "");
  if (!m) return;
  const row = db.prepare("SELECT * FROM arena_challenges WHERE id = ?").get(Number(m[1])) as ChallengeRow | undefined;
  if (!row || row.creator.toLowerCase() !== job.client.toLowerCase()) return;
  if (row.jobId != null && row.jobId !== job.id) return;
  if (row.jobId === job.id && row.awardedAgentId === job.agentId) return;
  db.prepare("UPDATE arena_challenges SET awardedAgentId = ?, jobId = ?, awardedAt = COALESCE(awardedAt, ?), closedAt = COALESCE(closedAt, ?) WHERE id = ?").run(job.agentId, job.id, ts, Math.min(ts, row.endsAt), row.id);
  const name = (db.prepare("SELECT name FROM agents WHERE id = ?").get(job.agentId) as { name: string } | undefined)?.name ?? null;
  activity.emit("arena.award", {
    actor: job.client,
    ref: { kind: "challenge", id: row.id },
    data: { challengeId: row.id, title: row.title, agentId: job.agentId, agentName: name, jobId: job.id, prizeWei: row.prizeWei, winnerSubmissionId: row.winnerSubmissionId, viaJob: true },
    dedupKey: `arena.award:${row.id}:${job.id}`,
    ts,
  });
}
