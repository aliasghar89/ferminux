// Verifiable delivery (spec C5, gateway part): when a job is Delivered and the
// agent's FRC-8004 identity metadata "validator" names the gateway's Oracle
// agent, the gateway posts ValidationRegistry8004.validationRequest(validator,
// agentId, outputURI, outputHash) from ORACLE_KEY. The response (0..100) is
// indexed into `validations` and shown on the job (GET /api/jobs/:id →
// validation) before the client releases. Release stays client-driven.
import { Contract, Wallet, getAddress, toUtf8Bytes, keccak256 } from "ethers";
import type { ActivityBus } from "../commons/activity.js";
import type { V3Context } from "./context.js";

export interface ValidationView {
  requestHash: string;
  validator: string;
  agentId: number;
  jobId: number | null;
  requestURI: string;
  response: number | null;
  responseURI: string | null;
  tag: string | null;
  requestedAt: number;
  respondedAt: number | null;
  txRequest: string | null;
  txResponse: string | null;
}

/** The validation attached to a job: by jobId, else by requestHash == outputHash. */
export function validationForJob(ctx: V3Context, job: { id: number; agentId: number; outputHash: string | null }): ValidationView | null {
  const db = ctx.db;
  const byJob = db.prepare("SELECT * FROM validations WHERE jobId = ? ORDER BY requestedAt DESC LIMIT 1").get(job.id) as ValidationView | undefined;
  if (byJob) return byJob;
  if (!job.outputHash) return null;
  return (db.prepare("SELECT * FROM validations WHERE requestHash = ? AND agentId = ?").get(job.outputHash.toLowerCase(), job.agentId) as ValidationView | undefined) ?? null;
}

export function agentValidations(ctx: V3Context, agentId: number, limit = 50): ValidationView[] {
  return ctx.db.prepare("SELECT * FROM validations WHERE agentId = ? ORDER BY requestedAt DESC LIMIT ?").all(agentId, limit) as ValidationView[];
}

/** Subscribes to job.delivered and files validation requests through the Oracle key. */
export function attachValidationOracle(ctx: V3Context, activity: ActivityBus): () => void {
  const oracle = ctx.cfg.oracleKey ? new Wallet(ctx.cfg.oracleKey, ctx.provider) : undefined;
  if (!oracle || !ctx.deployed("validation8004") || !ctx.deployed("identity8004")) return () => undefined;
  const identity = ctx.contract("identity8004")!;
  const validation = new Contract(ctx.address("validation8004")!, ctx.iface("validation8004").fragments, oracle);
  const inflight = new Set<number>();
  return activity.subscribe((ev) => {
    if (ev.type !== "job.delivered") return;
    const jobId = Number(ev.data.jobId);
    if (!jobId || inflight.has(jobId)) return;
    inflight.add(jobId);
    void (async () => {
      try {
        const job = ctx.db.prepare("SELECT id, agentId, outputHash, outputURI FROM jobs WHERE id = ?").get(jobId) as { id: number; agentId: number; outputHash: string | null; outputURI: string | null } | undefined;
        if (!job || !job.outputHash) return;
        if (ctx.db.prepare("SELECT 1 FROM validations WHERE jobId = ? OR requestHash = ?").get(jobId, job.outputHash.toLowerCase())) return;
        const meta = (await identity.getMetadata(job.agentId, "validator")) as string;
        if (!meta || meta === "0x" || meta.length < 42) return;
        const validator = getAddress("0x" + meta.slice(-40));
        if (validator.toLowerCase() !== oracle.address.toLowerCase()) return;
        const requestURI = job.outputURI || `fmx://job/${jobId}`;
        const requestHash = job.outputHash || keccak256(toUtf8Bytes(requestURI));
        const tx = await validation.validationRequest(validator, job.agentId, requestURI, requestHash, { maxPriorityFeePerGas: 1_000_000_000n });
        ctx.db.prepare(
          `INSERT INTO validations (requestHash, validator, agentId, jobId, requestURI, requestedAt, txRequest) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(requestHash) DO UPDATE SET jobId = excluded.jobId, txRequest = COALESCE(validations.txRequest, excluded.txRequest)`,
        ).run(requestHash.toLowerCase(), validator, job.agentId, jobId, requestURI, ctx.nowS(), tx.hash);
      } catch (err) {
        console.error(`[validation] request for job ${jobId} failed:`, (err as Error).message);
      } finally {
        inflight.delete(jobId);
      }
    })();
  });
}
