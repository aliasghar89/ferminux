import { JsonRpcProvider, formatEther, isAddress } from "ethers";
import { Ferminux } from "@ferminux/agent";
import { extractText, type Handler } from "./util.js";

/**
 * Chain oracle — deterministic, always-on, no model. Answers questions about
 * Ferminux mainnet from the RPC and the gateway.
 * Input: text ("balance 0x…", "block", "gas", "agent 1", "agents", "stats", "supply")
 * or JSON {op, address|id|q}.
 *
 * Addendum v3: `validate` posts an FRC-8004 validationResponse for a job when
 * asked by the gateway (SPEC.md "## C5" — verifiable delivery). The Oracle
 * agent's own key must be the `validator` named in the request. Input:
 * {op:"validate", jobId, requestHash, responseURI?, tag?}. Response is a
 * simple, deterministic heuristic (0 or 100) — Delivered/Completed with an
 * output present scores 100, anything else scores 0 — since this handler has
 * no model to judge quality; a real validator would inspect the output.
 *
 * The record layer adds two ops. `cv` returns an agent's verifiable working
 * record together with the verdict of verifying every claim against the chain.
 * `hire` ranks agents by that PROVEN record rather than by what their cards
 * claim — which is the whole difference between a directory and a reputation.
 */
const OPS = ["balance", "block", "gas", "agent", "agents", "stats", "job", "validate", "cv", "hire", "help"] as const;
type Op = (typeof OPS)[number];

function fmx(): Ferminux {
  return new Ferminux({ rpc: process.env.FERMINUX_RPC, gateway: process.env.FERMINUX_GATEWAY,
    registry: process.env.FERMINUX_REGISTRY, escrow: process.env.FERMINUX_ESCROW,
    privateKey: process.env.FERMINUX_PRIVATE_KEY }); // needed only for `validate` (signs validationResponse)
}

export const chainHandler: Handler = async (input) => {
  let op: Op = "help"; let arg = ""; let obj: Record<string, unknown> | null = null;
  if (typeof input === "string" && /^\s*\{/.test(input)) { try { input = JSON.parse(input); } catch { /* text */ } }
  if (input && typeof input === "object" && !(input instanceof Uint8Array)) {
    const o = input as Record<string, unknown>;
    obj = o;
    if (typeof o.op === "string" && (OPS as readonly string[]).includes(o.op)) op = o.op as Op;
    arg = String(o.address ?? o.id ?? o.q ?? o.text ?? "");
  } else {
    const words = extractText(input).trim().split(/\s+/);
    const w0 = (words[0] || "").toLowerCase();
    if ((OPS as readonly string[]).includes(w0)) { op = w0 as Op; arg = words.slice(1).join(" "); }
    else if (isAddress(words[0] || "")) { op = "balance"; arg = words[0]; }
  }
  const f = fmx();
  const provider = f.provider as JsonRpcProvider;
  switch (op) {
    case "balance": {
      if (!isAddress(arg)) return { ok: false, op, error: "give an 0x address" };
      const [bal, credits] = await Promise.all([provider.getBalance(arg), f.credits(arg).catch(() => 0n)]);
      return { ok: true, op, address: arg, balanceFMX: formatEther(bal), escrowCreditsFMX: formatEther(credits) };
    }
    case "block": {
      const b = await provider.getBlock("latest");
      return { ok: true, op, number: b?.number, timestamp: b?.timestamp, baseFeePerGas: b?.baseFeePerGas?.toString(), txs: b?.transactions.length, gasLimit: b?.gasLimit.toString() };
    }
    case "gas": {
      const fee = await provider.getFeeData(); const b = await provider.getBlock("latest");
      return { ok: true, op, baseFeePerGasWei: b?.baseFeePerGas?.toString(), suggestedPriorityWei: fee.maxPriorityFeePerGas?.toString(), note: "signers require a 1 gwei tip; the SDK floors it for you" };
    }
    case "agent": {
      const id = Number(arg); if (!Number.isInteger(id) || id < 1) return { ok: false, op, error: "give an agent id" };
      return { ok: true, op, agent: await f.agents.get(id) };
    }
    case "agents": { const r = await f.agents.list({ q: arg || undefined, status: "active" }); return { ok: true, op, agents: r.items ?? r, note: "these are the agents' own cards — what they SAY about themselves. Use op:\"hire\" to rank them by what the chain says instead." }; }
    case "job": { const id = Number(arg); if (!Number.isInteger(id) || id < 1) return { ok: false, op, error: "give a job id" }; return { ok: true, op, job: await f.jobs.get(id) }; }
    case "stats": return { ok: true, op, stats: await f.gatewayGet("/stats"), health: await f.gatewayGet("/health") };
    case "cv": {
      const id = Number(arg);
      if (!Number.isInteger(id) || id < 1) return { ok: false, op, error: "give an agent id" };
      const doc = await f.cv.get(id);
      const verification = await f.cv.verify(doc);
      return {
        ok: true,
        op,
        agentId: id,
        verified: verification.ok,
        signed: verification.signed,
        anchor: verification.anchor,
        claimsProvedOnChain: verification.verified,
        claimsRejected: verification.rejected,
        summary: doc.credentialSubject.summary,
        warnings: verification.warnings,
        note: "every claim under `claimsProvedOnChain` was checked against the transaction it cites, using an RPC and nothing else",
      };
    }
    case "hire": {
      const { pickAgent } = await import("../hire.js");
      const { best, ranked, considered } = await pickAgent(f, {
        capability: arg || undefined,
        maxPriceWei: obj?.maxPriceWei !== undefined ? BigInt(String(obj.maxPriceWei)) : undefined,
        candidates: obj?.candidates !== undefined ? Number(obj.candidates) : undefined,
        exclude: Array.isArray(obj?.exclude) ? (obj.exclude as unknown[]).map(Number) : undefined,
      });
      return {
        ok: true,
        op,
        considered,
        best,
        ranked: ranked.map((r) => ({ agentId: r.agentId, name: r.name, score: r.score, reason: r.reason, pricePerJobWei: r.pricePerJobWei })),
        note: "ranked by the record the chain proves, not by the capability list each agent wrote about itself. A new agent ranks low and says why; it is never excluded.",
      };
    }
    case "validate": {
      const jobId = Number(obj?.jobId);
      const requestHash = String(obj?.requestHash ?? "");
      if (!Number.isInteger(jobId) || jobId < 1 || !requestHash) {
        return { ok: false, op, error: "give JSON {op:\"validate\", jobId, requestHash}" };
      }
      const job = await f.jobs.get(jobId).catch(() => null);
      if (!job) return { ok: false, op, error: `job ${jobId} not found` };
      const delivered = job.status === "Delivered" || job.status === "Completed";
      const hasOutput = Boolean(job.outputHash || job.outputURI);
      const response = delivered && hasOutput ? 100 : 0;
      const tag = delivered && hasOutput ? "delivered" : "missing-output";
      const responseURI = typeof obj?.responseURI === "string" ? obj.responseURI : `fmx://job/${jobId}`;
      const { tx } = await f.validation.respond({ requestHash, response, responseURI, tag });
      return { ok: true, op, jobId, requestHash, response, tag, tx };
    }
    default: return { ok: true, op: "help", ops: OPS, examples: ["balance 0x…", "block", "gas", "agent 1", "agents translate", "job 1", "stats", "cv 1", "hire hash", '{"op":"validate","jobId":1,"requestHash":"0x…"}'] };
  }
};
