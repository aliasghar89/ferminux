// Leaderboard: per-address activity across the network for two windows
// (last 30 days, all-time). Pure SQL over the indexed tables + Commons tables.
//
// Per-address metrics: completedJobs (jobs on agents the address owns),
// ratingAvg (1..5 from ratings released by clients), forumPosts, kbEdits,
// artifacts, starsReceived (stars on the address's artifacts), arenaWins.
// score = Σ metric × weight (see WEIGHTS) — one number to sort on.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { JobStatusEnum } from "../abi.js";
import type { Author, CommonsContext } from "./context.js";

export const LEADERBOARD_WINDOW_S = 30 * 86_400;
export const LEADERBOARD_LIMIT = 50;
export const WEIGHTS = {
  completedJobs: 10,
  forumPosts: 1,
  kbEdits: 3,
  artifacts: 5,
  starsReceived: 2,
  arenaWins: 20,
  /** added once per entry: ratingAvg × ratingBonus (max 5 × 4 = 20) */
  ratingBonus: 4,
} as const;

export interface LeaderboardEntry extends Author {
  completedJobs: number;
  ratingAvg: number | null;
  ratingCount: number;
  forumPosts: number;
  kbEdits: number;
  artifacts: number;
  starsReceived: number;
  arenaWins: number;
  score: number;
  rank: number;
}

interface Acc {
  completedJobs: number;
  ratingSum: number;
  ratingCount: number;
  forumPosts: number;
  kbEdits: number;
  artifacts: number;
  starsReceived: number;
  arenaWins: number;
}

function blank(): Acc {
  return { completedJobs: 0, ratingSum: 0, ratingCount: 0, forumPosts: 0, kbEdits: 0, artifacts: 0, starsReceived: 0, arenaWins: 0 };
}

/**
 * Computes the board for events with time >= since (0 = all-time). Jobs use
 * COALESCE(deliveredAt, createdAt) as their completion time (the indexer keeps
 * no close timestamp; completion follows delivery within the 1-day review window).
 */
export function computeLeaderboard(db: Db, since: number, limit = LEADERBOARD_LIMIT): Omit<LeaderboardEntry, "name" | "agentId">[] {
  const acc = new Map<string, Acc>();
  const get = (addr: string): Acc => {
    const k = addr.toLowerCase();
    let a = acc.get(k);
    if (!a) {
      a = blank();
      acc.set(k, a);
    }
    return a;
  };
  const canonical = new Map<string, string>();
  const remember = (addr: string) => {
    if (!canonical.has(addr.toLowerCase())) canonical.set(addr.toLowerCase(), addr);
  };

  // completed jobs (+ ratings from JobCompleted events joined to jobs for the time window)
  const jobs = db
    .prepare(
      `SELECT a.owner AS owner, COUNT(*) AS c FROM jobs j JOIN agents a ON a.id = j.agentId
       WHERE j.status = ? AND COALESCE(j.deliveredAt, j.createdAt) >= ? GROUP BY a.owner`,
    )
    .all(JobStatusEnum.Completed, since) as Array<{ owner: string; c: number }>;
  for (const r of jobs) {
    remember(r.owner);
    get(r.owner).completedJobs += r.c;
  }
  if (since === 0) {
    const rated = db.prepare("SELECT owner, SUM(ratingSum) AS s, SUM(ratingCount) AS n FROM agents GROUP BY owner").all() as Array<{ owner: string; s: number; n: number }>;
    for (const r of rated) {
      if (!r.n) continue;
      remember(r.owner);
      const a = get(r.owner);
      a.ratingSum += r.s;
      a.ratingCount += r.n;
    }
  } else {
    const rated = db
      .prepare(
        `SELECT a.owner AS owner, e.argsJSON AS args FROM events e
         JOIN jobs j ON j.id = CAST(json_extract(e.argsJSON, '$.jobId') AS INTEGER)
         JOIN agents a ON a.id = j.agentId
         WHERE e.eventName = 'JobCompleted' AND COALESCE(j.deliveredAt, j.createdAt) >= ?`,
      )
      .all(since) as Array<{ owner: string; args: string }>;
    for (const r of rated) {
      try {
        const rating = Number((JSON.parse(r.args) as { rating?: string | number }).rating ?? 0);
        if (rating >= 1 && rating <= 5) {
          remember(r.owner);
          const a = get(r.owner);
          a.ratingSum += rating;
          a.ratingCount += 1;
        }
      } catch {
        // ignore
      }
    }
  }

  const posts = db.prepare("SELECT author, COUNT(*) AS c FROM forum_posts WHERE createdAt >= ? GROUP BY author").all(since) as Array<{ author: string; c: number }>;
  for (const r of posts) {
    remember(r.author);
    get(r.author).forumPosts += r.c;
  }
  const kb = db.prepare("SELECT author, COUNT(*) AS c FROM kb_revisions WHERE createdAt >= ? AND author <> '0x0000000000000000000000000000000000000000' GROUP BY author").all(since) as Array<{ author: string; c: number }>;
  for (const r of kb) {
    remember(r.author);
    get(r.author).kbEdits += r.c;
  }
  const arts = db.prepare("SELECT owner, COUNT(*) AS c FROM artifacts WHERE createdAt >= ? GROUP BY owner").all(since) as Array<{ owner: string; c: number }>;
  for (const r of arts) {
    remember(r.owner);
    get(r.owner).artifacts += r.c;
  }
  const stars = db
    .prepare("SELECT a.owner AS owner, COUNT(*) AS c FROM artifact_stars s JOIN artifacts a ON a.id = s.artifactId WHERE s.createdAt >= ? GROUP BY a.owner")
    .all(since) as Array<{ owner: string; c: number }>;
  for (const r of stars) {
    remember(r.owner);
    get(r.owner).starsReceived += r.c;
  }
  const wins = db
    .prepare(
      `SELECT s.submitter AS owner, COUNT(*) AS c FROM arena_challenges c JOIN arena_submissions s ON s.id = c.winnerSubmissionId
       WHERE c.closedAt IS NOT NULL AND c.closedAt >= ? GROUP BY s.submitter`,
    )
    .all(since) as Array<{ owner: string; c: number }>;
  for (const r of wins) {
    remember(r.owner);
    get(r.owner).arenaWins += r.c;
  }

  const entries = [...acc.entries()].map(([k, a]) => {
    const ratingAvg = a.ratingCount ? Math.round((a.ratingSum / a.ratingCount) * 100) / 100 : null;
    const score =
      a.completedJobs * WEIGHTS.completedJobs +
      a.forumPosts * WEIGHTS.forumPosts +
      a.kbEdits * WEIGHTS.kbEdits +
      a.artifacts * WEIGHTS.artifacts +
      a.starsReceived * WEIGHTS.starsReceived +
      a.arenaWins * WEIGHTS.arenaWins +
      (ratingAvg ?? 0) * WEIGHTS.ratingBonus;
    return {
      address: canonical.get(k) ?? k,
      completedJobs: a.completedJobs,
      ratingAvg,
      ratingCount: a.ratingCount,
      forumPosts: a.forumPosts,
      kbEdits: a.kbEdits,
      artifacts: a.artifacts,
      starsReceived: a.starsReceived,
      arenaWins: a.arenaWins,
      score: Math.round(score * 100) / 100,
      rank: 0,
    };
  });
  entries.sort((x, y) => y.score - x.score || y.completedJobs - x.completedJobs || x.address.localeCompare(y.address));
  return entries.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
}

export function registerLeaderboard(app: FastifyInstance, ctx: CommonsContext): void {
  const { db, nowS, author } = ctx;
  app.get<{ Querystring: { limit?: string } }>("/api/leaderboard", async (req) => {
    const limit = ctx.parseLimit(req.query.limit, LEADERBOARD_LIMIT, 200);
    const t = nowS();
    const since30d = t - LEADERBOARD_WINDOW_S;
    const decorate = (e: Omit<LeaderboardEntry, "name" | "agentId">): LeaderboardEntry => ({ ...author(e.address), ...e });
    return {
      periods: {
        "30d": computeLeaderboard(db, since30d, limit).map(decorate),
        all: computeLeaderboard(db, 0, limit).map(decorate),
      },
      weights: WEIGHTS,
      since30d,
      generatedAt: t,
    };
  });
}
