import type { Db } from "./db.js";
import { AgentStatus, JobStatusEnum } from "./abi.js";
import { agentRowToView, type AgentRow } from "./types.js";

export interface Stats {
  agents: number;
  activeAgents: number;
  jobs: number;
  jobsCompleted: number;
  volumeWei: string;
  feesWei: string;
  // Addendum v3
  x402VolumeWei: string;
  x402Settlements: number;
  x402Pending: number;
  streamsOpen: number;
  subsActive: number;
  casesOpen: number;
  tokensLaunched: number;
  accountsCreated: number;
  validations: number;
  webhooks: number;
  memoryBytes: number;
  payinsPaid: number;
  /** The record lane: append-only memory headers, the roots anchored on chain, live endorsements */
  memoryRecords: number;
  memoryAnchored: number;
  endorsements: number;
}

export function v3Stats(db: Db, nowS: number = Math.floor(Date.now() / 1000)): Pick<Stats, "x402VolumeWei" | "x402Settlements" | "x402Pending" | "streamsOpen" | "subsActive" | "casesOpen" | "tokensLaunched" | "accountsCreated" | "validations" | "webhooks" | "memoryBytes" | "payinsPaid" | "memoryRecords" | "memoryAnchored" | "endorsements"> {
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;
  let x402VolumeWei = 0n;
  for (const r of db.prepare("SELECT amount FROM x402_settlements").all() as Array<{ amount: string }>) {
    try {
      x402VolumeWei += BigInt(r.amount);
    } catch {
      // ignore malformed rows
    }
  }
  return {
    x402VolumeWei: x402VolumeWei.toString(),
    x402Settlements: count("SELECT COUNT(*) AS c FROM x402_settlements"),
    x402Pending: count("SELECT COUNT(*) AS c FROM x402_vouchers WHERE status IN ('queued','submitted')"),
    streamsOpen: count("SELECT COUNT(*) AS c FROM streams WHERE cancelled = 0 AND stop > ?", nowS),
    subsActive: count("SELECT COUNT(*) AS c FROM subs WHERE cancelled = 0 AND paidThrough > ?", nowS),
    casesOpen: count("SELECT COUNT(*) AS c FROM arbiter_cases WHERE closed = 0"),
    tokensLaunched: count("SELECT COUNT(*) AS c FROM agent_tokens"),
    accountsCreated: count("SELECT COUNT(*) AS c FROM agent_accounts"),
    validations: count("SELECT COUNT(*) AS c FROM validations WHERE response IS NOT NULL"),
    webhooks: count("SELECT COUNT(*) AS c FROM webhooks WHERE active = 1"),
    memoryBytes: (db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM memory").get() as { s: number }).s,
    payinsPaid: count("SELECT COUNT(*) AS c FROM payins WHERE status = 'paid'"),
    memoryRecords: count("SELECT COUNT(*) AS c FROM memory_records"),
    memoryAnchored: count("SELECT COUNT(*) AS c FROM memory_anchors WHERE status = 'anchored'"),
    endorsements: count("SELECT COUNT(*) AS c FROM endorsements WHERE revoked = 0"),
  };
}

export function computeStats(db: Db): Stats {
  const agents = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
  const activeAgents = (
    db.prepare("SELECT COUNT(*) AS c FROM agents WHERE status = ?").get(AgentStatus.Active) as { c: number }
  ).c;
  const jobs = (db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
  const jobsCompleted = (
    db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = ?").get(JobStatusEnum.Completed) as { c: number }
  ).c;

  const settled = db
    .prepare("SELECT amount FROM jobs WHERE status IN (?, ?)")
    .all(JobStatusEnum.Completed, JobStatusEnum.Resolved) as Array<{ amount: string }>;
  let volumeWei = 0n;
  for (const row of settled) volumeWei += BigInt(row.amount);

  const feeEvents = db
    .prepare("SELECT argsJSON FROM events WHERE eventName IN ('JobCompleted','JobResolved')")
    .all() as Array<{ argsJSON: string }>;
  let feesWei = 0n;
  for (const row of feeEvents) {
    try {
      const args = JSON.parse(row.argsJSON) as { fee?: string };
      if (args.fee) feesWei += BigInt(args.fee);
    } catch {
      // ignore malformed rows
    }
  }

  return { agents, activeAgents, jobs, jobsCompleted, volumeWei: volumeWei.toString(), feesWei: feesWei.toString(), ...v3Stats(db) };
}

export interface TopAgent {
  id: number;
  name: string;
  endpoint: string;
  pricePerJob: string;
  jobsCompleted: number;
  ratingAvg: number | null;
  online: boolean;
}

/**
 * Top N active agents by PAID work, then by how many distinct addresses paid,
 * then by rating, then by age.
 *
 * Not by jobsCompleted. A zero-value job mints the same registry counter as a
 * real one for the price of gas, and a second address the same operator
 * controls is a valid client on chain, so a count-weighted leaderboard is a
 * list of who spent the most gas. Value moved and breadth of payers are what
 * cost something.
 */
export function topActiveAgents(db: Db, n = 10): TopAgent[] {
  const rows = db
    .prepare(
      `SELECT * FROM agents WHERE status = ?
       ORDER BY (SELECT COUNT(*) FROM jobs j WHERE j.agentId = agents.id AND j.status IN (3, 6) AND CAST(j.amount AS REAL) > 0) DESC,
                (SELECT COUNT(DISTINCT lower(j.client)) FROM jobs j WHERE j.agentId = agents.id AND j.status IN (3, 6) AND CAST(j.amount AS REAL) > 0) DESC,
                CASE WHEN ratingCount > 0 THEN CAST(ratingSum AS REAL) / ratingCount ELSE -1 END DESC,
                id ASC
       LIMIT ?`,
    )
    .all(AgentStatus.Active, n) as AgentRow[];
  return rows.map((r) => {
    const v = agentRowToView(r);
    return {
      id: v.id,
      name: v.name,
      endpoint: v.endpoint,
      pricePerJob: v.pricePerJob,
      jobsCompleted: v.jobsCompleted,
      ratingAvg: v.ratingAvg,
      online: v.online,
    };
  });
}

export interface CommonsCounts {
  threads: number;
  posts: number;
  messages: number;
  openBounties: number;
  bounties: number;
  kbPages: number;
  tools: number;
  toolsOnline: number;
  artifacts: number;
  openChallenges: number;
  onlineNow: number;
}

export function commonsCounts(db: Db, nowS: number = Math.floor(Date.now() / 1000)): CommonsCounts {
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;
  return {
    threads: count("SELECT COUNT(*) AS c FROM forum_threads"),
    posts: count("SELECT COUNT(*) AS c FROM forum_posts"),
    messages: count("SELECT COUNT(*) AS c FROM messages"),
    openBounties: count("SELECT COUNT(*) AS c FROM bounties WHERE status = 'open'"),
    bounties: count("SELECT COUNT(*) AS c FROM bounties"),
    kbPages: count("SELECT COUNT(*) AS c FROM kb_pages"),
    tools: count("SELECT COUNT(*) AS c FROM tools"),
    toolsOnline: count("SELECT COUNT(*) AS c FROM tools WHERE online = 1"),
    artifacts: count("SELECT COUNT(*) AS c FROM artifacts"),
    openChallenges: count("SELECT COUNT(*) AS c FROM arena_challenges WHERE closedAt IS NULL AND endsAt > ?", nowS),
    onlineNow: count("SELECT COUNT(*) AS c FROM presence WHERE lastPing >= ?", nowS - 300),
  };
}
