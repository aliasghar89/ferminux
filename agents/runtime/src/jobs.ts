// One escrow job, end to end: re-check it is still Open, fetch the input, run the handler, then deliver — or,
// when the agent cannot serve it, decline it on chain.
//
// A handler answering {ok:false} (unparseable input, an unknown op, a model that failed) used to be DELIVERED
// like any result, which released the client's FMX to the agent for an error message: Oracle charged 0.1 FMX
// for a usage menu (audit 2026-09-24). Now the runtime calls ServiceEscrow.cancel(jobId), the escrow's
// existing agent-declines path, which credits the client the full amount at once instead of leaving it locked
// for the 24 h delivery window. The same happens when the input cannot be fetched or the handler throws on
// every attempt. Only a failure to DELIVER a result the handler did produce leaves the job Open ("abandoned"),
// because the work exists and the client can still refund() after the window.
import { JobStatusEnum } from "@ferminux/agent";
import { loadState, saveState, type HandledState, type JobStateEntry } from "./state.js";
import type { Handler } from "./handlers/util.js";

type Log = { info: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void };

/** The escrow calls one job needs — narrow so tests can stub them (serve.ts binds them to the SDK). */
export interface JobClient {
  /** on-chain JobStatus (ServiceEscrow.getJob(jobId).status) */
  status(jobId: number): Promise<number>;
  input(jobId: number): Promise<unknown>;
  deliver(jobId: number, output: Record<string, unknown>): Promise<{ tx: string }>;
  /** ServiceEscrow.cancel: the agent declines an Open job; the client is credited the full amount */
  cancel(jobId: number): Promise<{ tx: string }>;
}

export const JOB_ATTEMPTS = 3;

/** Jobs being handled right now in this process, by state file + job id. The poll loop and the webhook receiver
 * both call handleOneJob, and a job.requested webhook usually lands while the poll is still on the same job:
 * two runs ran the handler twice (a second paid model call) and raced to deliver, and the loser's retries
 * then overwrote the winner's "delivered" entry. */
const inFlight = new Set<string>();

/** True when a handler result says the request was not served (the only shape the built-ins use for that). */
export function isRefusal(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { ok?: unknown }).ok === false;
}

export async function handleOneJob(
  client: JobClient,
  jobId: number,
  statePath: string,
  handler: Handler,
  log: Log,
  opts: { retryDelayMs?: number } = {},
): Promise<JobStateEntry["status"] | "already"> {
  const key = String(jobId);
  if (loadState(statePath)[key]) return "already"; // delivered, declined or permanently abandoned
  const flight = `${statePath}\0${key}`;
  if (inFlight.has(flight)) return "already"; // the other caller is on it right now
  inFlight.add(flight);
  try {
    return await runJob(client, jobId, statePath, handler, log, opts);
  } finally {
    inFlight.delete(flight);
  }
}

async function runJob(
  client: JobClient,
  jobId: number,
  statePath: string,
  handler: Handler,
  log: Log,
  opts: { retryDelayMs?: number },
): Promise<JobStateEntry["status"]> {
  const key = String(jobId);
  let outcome: JobStateEntry["status"] = "abandoned";
  let lastErr: unknown;
  let stage: "status" | "input" | "handler" | "deliver" = "status";
  let refusal: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      stage = "status";
      // Always re-check on-chain status right before doing (more) work or delivering.
      if ((await client.status(jobId)) !== JobStatusEnum.Open) {
        outcome = "skipped"; // no longer open (delivered/refunded/cancelled elsewhere) — stop tracking it
        break;
      }
      stage = "input";
      const input = await client.input(jobId);
      stage = "handler";
      const result = await handler(input);
      if (isRefusal(result)) {
        const r = result as { error?: unknown; op?: unknown };
        refusal = String(r.error ?? "the agent could not serve this request").slice(0, 200);
        break;
      }
      stage = "deliver";
      await client.deliver(jobId, result);
      outcome = "delivered";
      break;
    } catch (err) {
      lastErr = err;
      log.error({ err, jobId, attempt, stage }, "job attempt failed");
      if (attempt < JOB_ATTEMPTS) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));
    }
  }

  let reason: string | undefined;
  let tx: string | undefined;
  const cannotServe = refusal !== null || (outcome === "abandoned" && (stage === "input" || stage === "handler"));
  if (cannotServe) {
    reason = refusal ?? `${stage === "input" ? "input could not be fetched" : "handler failed"}: ${String((lastErr as Error)?.message ?? lastErr).slice(0, 160)}`;
    try {
      ({ tx } = await client.cancel(jobId));
      outcome = "declined";
    } catch (err) {
      outcome = "abandoned";
      log.error({ jobId, err, reason }, "could not decline the job on chain; the client can refund() once the delivery window ends");
    }
  }

  if (outcome === "abandoned" && stage === "status") {
    // the chain could not even be asked whether the job is open: record nothing, so the next poll retries it
    log.error({ jobId, err: lastErr }, "job status unreadable; will retry on the next poll");
    return outcome;
  }
  // Re-read the file right before writing it: a job can take minutes (a model call, retries), and other jobs
  // handled meanwhile (webhooks run in parallel) saved their outcomes. Writing back the copy read at the start
  // erased them, and an erased "abandoned" job was run again on the next poll.
  const state: HandledState = loadState(statePath);
  state[key] = { status: outcome, attempts, updatedAt: Date.now(), ...(reason ? { reason } : {}), ...(tx ? { tx } : {}) };
  saveState(statePath, state);
  if (outcome === "declined") log.warn({ jobId, reason, tx }, "job declined: cancelled on chain, the client is credited in full");
  else if (outcome === "abandoned") log.error({ jobId, err: lastErr, stage }, `job abandoned after ${attempts} attempts`);
  else log.info({ jobId, outcome }, "job handled");
  return outcome;
}
