// Indexer → Commons bridge: turns on-chain registry/escrow events into
// activity rows (deduplicated by tx hash + log index so the indexer's 12-block
// reorg re-scan never double-posts) and drives bounty status transitions.
import type { Db } from "../db.js";
import { AgentStatusName, JobStatusName } from "../abi.js";
import type { IndexerHooks, IndexedAgentEvent, IndexedJobEvent } from "../indexer.js";
import type { ActivityBus, ActivityType } from "./activity.js";
import { applyJobToBounties } from "./bounties.js";
import { applyJobToArena } from "./arena.js";
import { applyJobToReferrals, referralRules, type ReferralRules } from "./referrals.js";

const JOB_EVENT_TYPES: Record<string, ActivityType> = {
  JobRequested: "job.requested",
  JobDelivered: "job.delivered",
  JobCompleted: "job.completed",
  JobRefunded: "job.refunded",
  JobDisputed: "job.disputed",
  JobResolved: "job.resolved",
};

export function makeIndexerHooks(db: Db, activity: ActivityBus, opts: { referralRules?: ReferralRules } = {}): IndexerHooks {
  const rules = opts.referralRules ?? referralRules();
  const agentStmt = db.prepare("SELECT id, owner, name, endpoint, pricePerJob, status FROM agents WHERE id = ?");
  const jobStmt = db.prepare("SELECT id, agentId, client, amount, inputURI, status, deliveredAt FROM jobs WHERE id = ?");

  return {
    onAgentEvent(ev: IndexedAgentEvent) {
      const agent = agentStmt.get(ev.id) as { id: number; owner: string; name: string; endpoint: string; pricePerJob: string; status: number } | undefined;
      if (!agent) return;
      const type: ActivityType = ev.eventName === "AgentRegistered" ? "agent.registered" : "agent.updated";
      activity.emit(type, {
        actor: agent.owner,
        ref: { kind: "agent", id: agent.id },
        ts: ev.ts,
        dedupKey: `${ev.eventName}:${ev.txHash}:${ev.logIndex}`,
        data: {
          agentId: agent.id,
          name: agent.name,
          endpoint: agent.endpoint,
          pricePerJob: agent.pricePerJob,
          status: AgentStatusName[agent.status] ?? "None",
          event: ev.eventName,
          tx: ev.txHash,
          block: ev.blockNumber,
        },
      });
    },
    onJobEvent(ev: IndexedJobEvent) {
      const job = jobStmt.get(ev.jobId) as { id: number; agentId: number; client: string; amount: string; inputURI: string; status: number; deliveredAt: number | null } | undefined;
      if (!job) return;
      const agent = agentStmt.get(job.agentId) as { owner: string; name: string } | undefined;
      const type = JOB_EVENT_TYPES[ev.eventName];
      if (type) {
        const rating = Number(ev.args.rating ?? 0);
        // actor: the party that acted — client requests/completes/refunds/disputes, agent delivers (and cancels)
        const byAgent = ev.eventName === "JobDelivered" || (ev.eventName === "JobRefunded" && String(ev.args.byAgent) === "true");
        activity.emit(type, {
          actor: byAgent ? (agent?.owner ?? null) : ev.eventName === "JobResolved" ? null : job.client,
          ref: { kind: "job", id: job.id },
          ts: ev.ts,
          dedupKey: `${ev.eventName}:${ev.txHash}:${ev.logIndex}`,
          data: {
            jobId: job.id,
            agentId: job.agentId,
            agentName: agent?.name ?? null,
            owner: agent?.owner ?? null,
            client: job.client,
            amount: job.amount,
            status: JobStatusName[job.status] ?? "None",
            ...(rating > 0 ? { rating } : {}),
            ...(ev.eventName === "JobRefunded" ? { byAgent: String(ev.args.byAgent) === "true" } : {}),
            tx: ev.txHash,
            block: ev.blockNumber,
          },
        });
      }
      applyJobToBounties(db, activity, job, ev.ts);
      applyJobToArena(db, activity, job, ev.ts);
      applyJobToReferrals(db, activity, job, ev.ts, rules);
    },
  };
}
