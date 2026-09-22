// Growth — referral programme.
//
// Flow: an agent (or its operator) shares https://ferminux.net/register/?ref=<agentId>.
// After the referred agent registers on-chain, the NEW agent's owner signs
// `referral.claim` {newAgentId, ref} (Commons EIP-191 recipe) and POSTs it here.
// When the referred agent completes its first QUALIFYING escrow job
// (JobCompleted, seen by the indexer), the payout worker pays
// REFERRAL_REWARD_FMX to BOTH owners from GROWTH_KEY. With GROWTH_KEY unset the
// row stays paid=0 and the leaderboard shows it as "pending" — nothing is
// lost, the worker picks it up once funded.
//
// Anti-farming (agents are free to mint: faucet gas, bond 0): a job only
// qualifies when its client is neither owner (nor an AgentAccount of either)
// and it paid at least REFERRAL_MIN_JOB_FMX; payouts are capped per referrer
// owner and network-wide per UTC day (REFERRAL_MAX_PAYOUTS_*), rows beyond
// the cap simply wait for the next day.
import type { FastifyInstance } from "fastify";
import { JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import type { Db } from "../db.js";
import { JobStatusEnum } from "../abi.js";
import { HttpError, type Author, type CommonsContext } from "./context.js";
import type { ActivityBus } from "./activity.js";
import { dayStart } from "../v3/context.js";

export const REFERRAL_REWARD_FMX_DEFAULT = "10";
export const REFERRAL_MIN_JOB_FMX_DEFAULT = "5";
export const REFERRAL_MAX_PER_REFERRER_PER_DAY_DEFAULT = 5;
export const REFERRAL_MAX_PER_DAY_DEFAULT = 50;
/** A referral must be claimed within this many days of the referred agent's registration. */
export const REFERRAL_CLAIM_WINDOW_S = 30 * 86_400;

export interface ReferralRules {
  /** wei the qualifying job must have paid */
  minJobWei: bigint;
}
export function referralRules(minJobFmx?: string): ReferralRules {
  return { minJobWei: parseEther(minJobFmx ?? REFERRAL_MIN_JOB_FMX_DEFAULT) };
}

/**
 * Does this Completed job count as the referred agent's first real job?
 * The client must be an outside party: not the referred owner, not the
 * referrer owner, and not an AgentAccount either of them owns.
 */
export function jobQualifies(db: Db, row: { newOwner: string; refOwner: string }, job: { client: string; amount: string; status: number }, rules: ReferralRules): boolean {
  if (job.status !== JobStatusEnum.Completed) return false;
  let amount: bigint;
  try {
    amount = BigInt(job.amount || "0");
  } catch {
    return false;
  }
  if (amount < rules.minJobWei) return false;
  const client = job.client.toLowerCase();
  const owners = new Set([row.newOwner.toLowerCase(), row.refOwner.toLowerCase()]);
  if (owners.has(client)) return false;
  const acct = db.prepare("SELECT owner FROM agent_accounts WHERE lower(account) = ?").get(client) as { owner: string } | undefined;
  if (acct && owners.has(acct.owner.toLowerCase())) return false;
  return true;
}

export interface ReferralRow {
  newAgentId: number;
  refAgentId: number;
  newOwner: string;
  refOwner: string;
  ts: number;
  paid: number;
  eligibleAt: number | null;
  jobId: number | null;
  paidAt: number | null;
  txNew: string | null;
  txRef: string | null;
  rewardWei: string | null;
  error: string | null;
  /** GROWTH_KEY tx nonces reserved for the two transfers (crash-safe idempotency) */
  nonceNew: number | null;
  nonceRef: number | null;
}

export type ReferralStatus = "registered" | "pending" | "paid";

export interface ReferralView {
  newAgentId: number;
  newAgentName: string | null;
  refAgentId: number;
  refAgentName: string | null;
  newOwner: Author;
  refOwner: Author;
  ts: number;
  /** registered = waiting for the referred agent's first completed job · pending = earned, payout not sent yet (GROWTH_KEY unset or underfunded) · paid */
  status: ReferralStatus;
  eligibleAt: number | null;
  jobId: number | null;
  paidAt: number | null;
  txNew: string | null;
  txRef: string | null;
  rewardWei: string | null;
}

export interface ReferralLeaderboardRow {
  rank: number;
  agentId: number;
  agentName: string | null;
  owner: Author;
  referred: number;
  earned: number;
  paid: number;
  pending: number;
  /** wei paid out to this referrer so far */
  paidWei: string;
}

export interface ReferralsOptions {
  /** FMX paid to EACH owner per completed referral (decimal string) */
  rewardFmx?: string;
  /** true when GROWTH_KEY is configured (leaderboard advertises whether payouts are live) */
  payoutEnabled?: boolean;
  /** the referred agent's qualifying job must have paid at least this (FMX, decimal string) */
  minJobFmx?: string;
}

export function registerReferrals(app: FastifyInstance, ctx: CommonsContext, opts: ReferralsOptions = {}): void {
  const { db, activity, nowS, author } = ctx;
  const rewardFmx = opts.rewardFmx ?? REFERRAL_REWARD_FMX_DEFAULT;
  const rewardWei = parseEther(rewardFmx).toString();
  const minJobFmx = opts.minJobFmx ?? REFERRAL_MIN_JOB_FMX_DEFAULT;
  const rules = referralRules(minJobFmx);

  const agentNameStmt = db.prepare("SELECT name FROM agents WHERE id = ?");
  const getStmt = db.prepare("SELECT * FROM referrals WHERE newAgentId = ?");
  const agentName = (id: number | null) => (id == null ? null : ((agentNameStmt.get(id) as { name: string } | undefined)?.name ?? null));

  function statusOf(row: ReferralRow): ReferralStatus {
    if (row.paid) return "paid";
    return row.eligibleAt != null ? "pending" : "registered";
  }
  function view(row: ReferralRow): ReferralView {
    return {
      newAgentId: row.newAgentId,
      newAgentName: agentName(row.newAgentId),
      refAgentId: row.refAgentId,
      refAgentName: agentName(row.refAgentId),
      newOwner: author(row.newOwner),
      refOwner: author(row.refOwner),
      ts: row.ts,
      status: statusOf(row),
      eligibleAt: row.eligibleAt,
      jobId: row.jobId,
      paidAt: row.paidAt,
      txNew: row.txNew,
      txRef: row.txRef,
      rewardWei: row.rewardWei ?? rewardWei,
    };
  }

  // POST /api/referrals — signed by the NEW agent's owner (action referral.claim)
  app.post("/api/referrals", async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("referral.claim", body);
      const agent = ctx.requireOwnedAgent(address, body.newAgentId, "newAgentId");
      const refId = ctx.checkId(body.ref, "ref");
      if (refId === agent.id) throw new HttpError(400, "an agent cannot refer itself", "self_referral");
      const refAgent = ctx.agentById(refId);
      if (!refAgent) throw new HttpError(404, `referrer agent ${refId} not found`);
      if (refAgent.owner.toLowerCase() === address.toLowerCase()) throw new HttpError(400, "the referrer and the referred agent have the same owner", "same_owner");
      const registeredAt = (db.prepare("SELECT registeredAt FROM agents WHERE id = ?").get(agent.id) as { registeredAt: number }).registeredAt;
      if (registeredAt && nowS() - registeredAt > REFERRAL_CLAIM_WINDOW_S) throw new HttpError(409, "referral must be claimed within 30 days of registration", "too_late");
      const existing = getStmt.get(agent.id) as ReferralRow | undefined;
      if (existing) throw new HttpError(409, `agent ${agent.id} already has a referrer (agent ${existing.refAgentId})`, "already_referred");
      ctx.commitWrite(address, body);
      const t = nowS();
      // A referred agent that already completed a qualifying job before claiming is eligible immediately.
      const done = (db.prepare(`SELECT id, client, amount, status FROM jobs WHERE agentId = ? AND status = ${JobStatusEnum.Completed} ORDER BY id ASC`).all(agent.id) as Array<{ id: number; client: string; amount: string; status: number }>).find((j) =>
        jobQualifies(db, { newOwner: address, refOwner: refAgent.owner }, j, rules),
      );
      db.prepare(
        "INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts, paid, eligibleAt, jobId, rewardWei) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
      ).run(agent.id, refId, address, refAgent.owner, t, done ? t : null, done?.id ?? null, rewardWei);
      const row = getStmt.get(agent.id) as ReferralRow;
      activity.emit("referral.claim", {
        actor: address,
        ref: { kind: "agent", id: agent.id },
        data: { newAgentId: agent.id, newAgentName: agent.name, refAgentId: refId, refAgentName: refAgent.name, rewardWei },
      });
      return reply.code(201).send(view(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  // GET /api/referrals/leaderboard — top referrers (+ programme facts)
  app.get<{ Querystring: { limit?: string } }>("/api/referrals/leaderboard", async (req) => {
    const lim = ctx.parseLimit(req.query.limit, 50, 200);
    const rows = db
      .prepare(
        `SELECT refAgentId AS agentId, refOwner AS owner, COUNT(*) AS referred,
                SUM(CASE WHEN eligibleAt IS NOT NULL THEN 1 ELSE 0 END) AS earned,
                SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN paid = 0 AND eligibleAt IS NOT NULL THEN 1 ELSE 0 END) AS pending
         FROM referrals GROUP BY refAgentId ORDER BY earned DESC, referred DESC, agentId ASC LIMIT ?`,
      )
      .all(lim) as Array<{ agentId: number; owner: string; referred: number; earned: number; paid: number; pending: number }>;
    const items: ReferralLeaderboardRow[] = rows.map((r, i) => ({
      rank: i + 1,
      agentId: r.agentId,
      agentName: agentName(r.agentId),
      owner: author(r.owner),
      referred: r.referred,
      earned: r.earned,
      paid: r.paid,
      pending: r.pending,
      paidWei: (BigInt(rewardWei) * BigInt(r.paid)).toString(),
    }));
    const totals = db.prepare("SELECT COUNT(*) AS referred, SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN paid = 0 AND eligibleAt IS NOT NULL THEN 1 ELSE 0 END) AS pending FROM referrals").get() as {
      referred: number;
      paid: number | null;
      pending: number | null;
    };
    return {
      items,
      rewardWei,
      rewardFmx,
      minJobFmx,
      rules: { minJobFmx, clientMustBeThirdParty: true },
      payoutEnabled: !!opts.payoutEnabled,
      totals: { referred: totals.referred, paid: totals.paid ?? 0, pending: totals.pending ?? 0 },
      recent: (db.prepare("SELECT * FROM referrals ORDER BY ts DESC LIMIT 10").all() as ReferralRow[]).map(view),
    };
  });

  // GET /api/referrals/by/:agentId — every agent this agent referred ("my referrals")
  app.get<{ Params: { agentId: string }; Querystring: { limit?: string; offset?: string } }>("/api/referrals/by/:agentId", async (req, reply) => {
    try {
      const id = ctx.checkId(req.params.agentId, "agentId");
      const lim = ctx.parseLimit(req.query.limit, 50, 200);
      const off = ctx.parseOffset(req.query.offset);
      const total = (db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE refAgentId = ?").get(id) as { c: number }).c;
      const rows = db.prepare("SELECT * FROM referrals WHERE refAgentId = ? ORDER BY ts DESC LIMIT ? OFFSET ?").all(id, lim, off) as ReferralRow[];
      const sums = db.prepare("SELECT SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN paid = 0 AND eligibleAt IS NOT NULL THEN 1 ELSE 0 END) AS pending FROM referrals WHERE refAgentId = ?").get(id) as { paid: number | null; pending: number | null };
      return { agentId: id, agentName: agentName(id), items: rows.map(view), total, paid: sums.paid ?? 0, pending: sums.pending ?? 0, registered: total - (sums.paid ?? 0) - (sums.pending ?? 0), paidWei: (BigInt(rewardWei) * BigInt(sums.paid ?? 0)).toString(), rewardWei, minJobFmx };
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  // GET /api/referrals/:agentId — the referral row for a referred agent
  app.get<{ Params: { agentId: string } }>("/api/referrals/:agentId", async (req, reply) => {
    try {
      const id = ctx.checkId(req.params.agentId, "agentId");
      const row = getStmt.get(id) as ReferralRow | undefined;
      if (!row) throw new HttpError(404, "no referral recorded for this agent");
      return view(row);
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}

// ---------------------------------------------------------------------------
// Indexer hook: the referred agent's first QUALIFYING Completed job (third-party
// client, ≥ REFERRAL_MIN_JOB_FMX) makes the row eligible. Idempotent.
// ---------------------------------------------------------------------------
export function applyJobToReferrals(db: Db, activity: ActivityBus, job: { id: number; agentId: number; status: number; client?: string; amount?: string }, ts: number, rules: ReferralRules = referralRules()): void {
  if (job.status !== JobStatusEnum.Completed) return;
  const row = db.prepare("SELECT * FROM referrals WHERE newAgentId = ? AND eligibleAt IS NULL").get(job.agentId) as ReferralRow | undefined;
  if (!row) return;
  const full = job.client !== undefined && job.amount !== undefined ? (job as { client: string; amount: string; status: number }) : (db.prepare("SELECT client, amount, status FROM jobs WHERE id = ?").get(job.id) as { client: string; amount: string; status: number } | undefined);
  if (!full || !jobQualifies(db, row, full, rules)) return;
  db.prepare("UPDATE referrals SET eligibleAt = ?, jobId = ? WHERE newAgentId = ? AND eligibleAt IS NULL").run(ts, job.id, job.agentId);
  void activity; // payout emits referral.paid; eligibility is visible via the leaderboard "pending" count
}

// ---------------------------------------------------------------------------
// Payout worker: pays both owners from GROWTH_KEY. No key → no-op (rows pend).
// ---------------------------------------------------------------------------
export interface ReferralPayoutOptions {
  db: Db;
  activity: ActivityBus;
  provider: JsonRpcProvider;
  growthKey?: string;
  rewardFmx?: string;
  /** referrals paid per referrer owner per UTC day (default 5) */
  maxPerReferrerPerDay?: number;
  /** referrals paid network-wide per UTC day (default 50) */
  maxPerDay?: number;
  nowS: () => number;
  /** injectable sender for tests: returns a tx hash. `nonce` is the reserved GROWTH_KEY nonce for this transfer. */
  send?: (to: string, valueWei: bigint, nonce: number) => Promise<string>;
  /** injectable nonce source for tests: [pending, latest] transaction counts of the growth wallet */
  txCounts?: () => Promise<[pending: number, latest: number]>;
}

export class ReferralPayout {
  readonly wallet?: Wallet;
  readonly rewardWei: bigint;
  readonly maxPerReferrerPerDay: number;
  readonly maxPerDay: number;
  private readonly send: (to: string, valueWei: bigint, nonce: number) => Promise<string>;
  private readonly txCounts: () => Promise<[number, number]>;

  constructor(private readonly opts: ReferralPayoutOptions) {
    this.rewardWei = parseEther(opts.rewardFmx ?? REFERRAL_REWARD_FMX_DEFAULT);
    this.maxPerReferrerPerDay = opts.maxPerReferrerPerDay ?? REFERRAL_MAX_PER_REFERRER_PER_DAY_DEFAULT;
    this.maxPerDay = opts.maxPerDay ?? REFERRAL_MAX_PER_DAY_DEFAULT;
    if (opts.growthKey) this.wallet = new Wallet(opts.growthKey, opts.provider);
    this.send =
      opts.send ??
      (async (to, value, nonce) => {
        const tx = await this.wallet!.sendTransaction({ to, value, nonce, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n });
        return tx.hash;
      });
    this.txCounts =
      opts.txCounts ??
      (async () => {
        if (!this.wallet) return [0, 0]; // injected sender without a wallet (tests)
        const p = this.opts.provider;
        const a = this.wallet.address;
        return [await p.getTransactionCount(a, "pending"), await p.getTransactionCount(a, "latest")];
      });
  }

  get enabled(): boolean {
    return !!this.wallet || !!this.opts.send;
  }

  /**
   * One transfer, crash-safe: the wallet nonce is reserved in the row BEFORE
   * sending, and sends use that explicit nonce. After a crash between send and
   * record, the next tick sees the reserved nonce: if the chain has already
   * mined it (GROWTH_KEY is used by this worker only, sequentially) the
   * transfer happened and is recorded as recovered; otherwise it is re-sent
   * with the same nonce, which can never double-pay.
   */
  private async transfer(r: ReferralRow, leg: "New" | "Ref", to: string, value: bigint): Promise<string> {
    const { db } = this.opts;
    const txCol = `tx${leg}`;
    const nonceCol = `nonce${leg}`;
    let nonce = leg === "New" ? r.nonceNew : r.nonceRef;
    if (nonce === null || nonce === undefined) {
      const [pending] = await this.txCounts();
      nonce = pending;
      db.prepare(`UPDATE referrals SET ${nonceCol} = ? WHERE newAgentId = ?`).run(nonce, r.newAgentId);
    } else {
      const [, latest] = await this.txCounts();
      if (latest > nonce) {
        const hash = `recovered:nonce:${nonce}`;
        db.prepare(`UPDATE referrals SET ${txCol} = ?, error = NULL WHERE newAgentId = ?`).run(hash, r.newAgentId);
        return hash;
      }
    }
    const hash = await this.send(to, value, nonce);
    db.prepare(`UPDATE referrals SET ${txCol} = ?, error = NULL WHERE newAgentId = ?`).run(hash, r.newAgentId);
    return hash;
  }

  /** One pass over eligible, unpaid rows (oldest first, within the daily caps). Returns the number of rows paid. */
  async tick(): Promise<number> {
    if (!this.enabled) return 0;
    const { db, activity, nowS } = this.opts;
    const rows = db.prepare("SELECT * FROM referrals WHERE paid = 0 AND eligibleAt IS NOT NULL ORDER BY eligibleAt ASC LIMIT 20").all() as ReferralRow[];
    const day = dayStart(nowS());
    const paidTodayAll = db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE paid = 1 AND paidAt >= ?").get(day) as { c: number };
    const paidTodayBy = db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE paid = 1 AND paidAt >= ? AND lower(refOwner) = lower(?)");
    let paidAll = paidTodayAll.c;
    const paidBy = new Map<string, number>();
    let paid = 0;
    for (const r of rows) {
      const reward = r.rewardWei ? BigInt(r.rewardWei) : this.rewardWei;
      // rows already half-sent (a reserved nonce or a recorded first leg) must finish regardless of the caps
      const inFlight = r.txNew !== null || r.nonceNew !== null;
      const owner = r.refOwner.toLowerCase();
      const byOwner = paidBy.get(owner) ?? (paidTodayBy.get(day, owner) as { c: number }).c;
      if (!inFlight && paidAll >= this.maxPerDay) {
        db.prepare("UPDATE referrals SET error = ? WHERE newAgentId = ?").run(`daily payout cap (${this.maxPerDay}) reached — deferred`, r.newAgentId);
        continue;
      }
      if (!inFlight && byOwner >= this.maxPerReferrerPerDay) {
        db.prepare("UPDATE referrals SET error = ? WHERE newAgentId = ?").run(`referrer's daily payout cap (${this.maxPerReferrerPerDay}) reached — deferred`, r.newAgentId);
        continue;
      }
      try {
        if (this.wallet) {
          const bal = await this.opts.provider.getBalance(this.wallet.address);
          if (bal < reward * 2n + parseEther("0.01")) {
            const msg = `GROWTH_KEY ${this.wallet.address} underfunded: ${formatEther(bal)} FMX < ${formatEther(reward * 2n)} FMX`;
            db.prepare("UPDATE referrals SET error = ? WHERE newAgentId = ?").run(msg, r.newAgentId);
            console.error(`[referrals] ${msg}`);
            break;
          }
        }
        // Two transfers; each reserves its nonce and records its hash so a crash anywhere never double-pays.
        const txNew = r.txNew ?? (await this.transfer(r, "New", r.newOwner, reward));
        const txRef = r.txRef ?? (await this.transfer(r, "Ref", r.refOwner, reward));
        const t = nowS();
        db.prepare("UPDATE referrals SET paid = 1, paidAt = ?, rewardWei = ?, error = NULL WHERE newAgentId = ?").run(t, reward.toString(), r.newAgentId);
        paid++;
        paidAll++;
        paidBy.set(owner, byOwner + 1);
        activity.emit("referral.paid", {
          actor: r.refOwner,
          ref: { kind: "agent", id: r.newAgentId },
          data: { newAgentId: r.newAgentId, refAgentId: r.refAgentId, newOwner: r.newOwner, refOwner: r.refOwner, rewardWei: reward.toString(), jobId: r.jobId, txNew, txRef },
        });
      } catch (err) {
        db.prepare("UPDATE referrals SET error = ? WHERE newAgentId = ?").run((err as Error).message.slice(0, 200), r.newAgentId);
      }
    }
    return paid;
  }

  start(intervalMs: number): () => void {
    if (!this.enabled) {
      console.warn("[referrals] GROWTH_KEY unset — referral rewards accrue as pending and are paid once the key is configured and funded");
      return () => undefined;
    }
    let stopped = false;
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await this.tick();
      } catch (err) {
        console.error("[referrals] tick failed", (err as Error).message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    void run();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}
