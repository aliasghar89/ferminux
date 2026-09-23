// Choosing whom to hire — the orchestration side of the record.
//
// The rule this module exists to enforce: PREFER A PROVEN RECORD OVER AN
// ASSERTED ONE. An agent's card is a claim about itself. Its capability list,
// its description, its model name — all of it is a string its operator typed,
// and none of it costs anything to write. What costs something is a client
// paying it, a delivery settling through escrow, a rating being left. Those are
// on chain, and `fmx.cv.verify()` checks each one against the transaction that
// proves it.
//
// So: read the card to find CANDIDATES, read the CV to RANK them.
//
// What this deliberately does NOT do is gate anything. A brand-new agent with
// no record is not penalised into invisibility — it ranks below a proven one
// and says why ("no paid work yet"), which is a true statement about the world
// rather than a punishment. Registration on this network is free and humanless
// and nothing here changes that.
import type { Ferminux, AgentView, CvVerifyResult } from "@ferminux/agent";

export interface CandidateRecord {
  agentId: number;
  name: string;
  owner: string;
  pricePerJobWei: string;
  online: boolean;
  /** what the agent SAYS it can do — operator-written, never scored */
  declaredCapabilities: string[];
  /** claims proved against the chain by fmx.cv.verify */
  provenClaims: number;
  /** claims that cited a transaction which did not bind — a rejected claim is worse than none */
  rejectedClaims: number;
  jobsCompleted: number;
  jobsFailed: number;
  ratingCount: number;
  ratingAvg: number | null;
  /** FMX actually settled through escrow, in wei — the number that costs something to fake */
  escrowEarnedWei: string;
  x402EarnedWei: string;
  /** how many distinct addresses have paid this agent. Breadth is what a self-dealer cannot buy cheaply. */
  payers: number;
  /** settled jobs that actually moved FMX. ServiceEscrow mints the same counter for a job worth nothing. */
  paidJobs: number;
  /** settled jobs that moved 0 FMX — a full jobsCompleted and a full 5★ for the price of gas */
  zeroValueJobs: number;
  /** "owner" (self-issued) | "indexer" (a pinned index assembled it) | "none" (unsigned) */
  issuerRole: string;
  /** "current" | "superseded" | "unanchored" | "unchecked" */
  anchor: string;
  /** the CV carried a signature by the agent's owner */
  signed: boolean;
  /** the CV verified end to end */
  verified: boolean;
  score: number;
  /** one line, in words, explaining the rank — never an opaque number on its own */
  reason: string;
  warnings: string[];
}

export interface PickOptions {
  /** rank only agents whose card declares this capability */
  capability?: string;
  /** free-text search handed to the directory */
  q?: string;
  /** never pay more than this per job (wei) */
  maxPriceWei?: bigint;
  /** how many directory entries to look at before ranking (default 12 — each one costs a CV read) */
  candidates?: number;
  /** skip the CV read entirely and rank on the directory's own counters (fast, and much weaker) */
  shallow?: boolean;
  /** require at least this many chain-proved claims; default 0 — a new agent is ranked, not excluded */
  minProven?: number;
  /** exclude these agent ids (e.g. yourself) */
  exclude?: number[];
  log?: { warn: (o: unknown, msg?: string) => void };
}

const ZERO = 0n;

function wei(v: unknown): bigint {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return ZERO;
  }
}

/** FMX as a float, for scoring only — never for money. */
function fmx(v: bigint): number {
  return Number(v) / 1e18;
}

/**
 * Scores a candidate. Value-weighted, never count-weighted: a completed job at
 * 0 FMX mints the same `jobsCompleted` counter as one at 5 FMX and costs
 * essentially nothing to manufacture, so the counters are reported but the
 * score follows the money and the breadth of who paid it.
 */
export function scoreCandidate(r: Omit<CandidateRecord, "score" | "reason">): { score: number; reason: string } {
  const earned = fmx(wei(r.escrowEarnedWei)) + fmx(wei(r.x402EarnedWei));
  // Saturating: the first few FMX of real, externally-paid work move the score a
  // long way; the hundredth does not. That is what stops volume alone buying rank.
  const value = 1 - Math.exp(-earned / 25);
  // Breadth: paid by many distinct addresses is much harder to manufacture than
  // paid a lot by one.
  const breadth = 1 - Math.exp(-r.payers / 4);
  // A rating is only worth reading when the job behind it moved money. A
  // 5.0 average over jobs worth 0 FMX costs gas and nothing else, so an agent
  // whose ratings are all zero-value sits where an unrated one sits.
  const ratingsWorthReading = r.paidJobs > 0 && r.ratingCount > 0 && r.ratingAvg !== null;
  const quality = ratingsWorthReading ? (r.ratingAvg! - 1) / 4 : 0.5; // unrated sits at the middle, not at the bottom
  const reliability = r.jobsCompleted + r.jobsFailed > 0 ? r.jobsCompleted / (r.jobsCompleted + r.jobsFailed) : 1;
  const proven = r.provenClaims > 0 ? 1 : 0;

  let score = 100 * (0.35 * value + 0.25 * breadth + 0.2 * quality + 0.2 * reliability) * (0.4 + 0.6 * proven);
  if (r.rejectedClaims > 0) score *= 0.25; // a claim that cites a transaction which does not bind is a red flag, not a neutral
  if (r.anchor === "superseded") score *= 0.9;
  if (!r.online) score *= 0.85;
  score = Math.max(0, Math.round(score));

  const parts: string[] = [];
  if (r.provenClaims > 0) parts.push(`${r.provenClaims} claim(s) proved on chain`);
  else parts.push("no chain-proved record yet");
  if (earned > 0) parts.push(`${earned.toFixed(4)} FMX earned from ${r.payers} payer${r.payers === 1 ? "" : "s"}`);
  else parts.push("no paid work yet");
  if (r.ratingCount > 0 && r.ratingAvg !== null) {
    parts.push(
      ratingsWorthReading
        ? `${r.ratingAvg.toFixed(1)}★ over ${r.ratingCount} rating${r.ratingCount === 1 ? "" : "s"} on ${r.paidJobs} paid job${r.paidJobs === 1 ? "" : "s"}`
        : `${r.ratingAvg.toFixed(1)}★ over ${r.ratingCount} rating${r.ratingCount === 1 ? "" : "s"}, none of them on a job that moved FMX — not counted`,
    );
  } else parts.push("unrated");
  if (r.zeroValueJobs > 0) parts.push(`${r.zeroValueJobs} settled job${r.zeroValueJobs === 1 ? "" : "s"} moved 0 FMX`);
  if (r.issuerRole === "indexer") parts.push("CV published by an index, not signed by the agent");
  if (r.jobsFailed > 0) parts.push(`${r.jobsFailed} failed job${r.jobsFailed === 1 ? "" : "s"}`);
  if (r.rejectedClaims > 0) parts.push(`${r.rejectedClaims} claim(s) DID NOT bind to the transactions they cite`);
  if (!r.signed) parts.push("record assembled from chain logs, unsigned by the agent");
  if (r.anchor === "superseded") parts.push("its anchored CV is a newer version than the one read");

  return { score, reason: parts.join(" · ") };
}

/**
 * Reads an agent's CV, verifies it against the chain, and folds the result into
 * one ranked record. Never throws: an agent whose CV cannot be read still comes
 * back, scored on what the directory knows and labelled as unproven, because a
 * missing CV is a reason to rank low, not a reason to disappear.
 */
export async function recordOf(fmx_: Ferminux, agent: AgentView, opts: { shallow?: boolean; log?: PickOptions["log"] } = {}): Promise<CandidateRecord> {
  const card = (agent.card ?? {}) as Record<string, unknown>;
  const base = {
    agentId: agent.id,
    name: agent.name,
    owner: agent.owner,
    pricePerJobWei: String(agent.pricePerJob ?? "0"),
    online: agent.online !== false,
    declaredCapabilities: Array.isArray(card.capabilities) ? (card.capabilities as string[]) : [],
    provenClaims: 0,
    rejectedClaims: 0,
    jobsCompleted: agent.jobsCompleted ?? 0,
    jobsFailed: agent.jobsFailed ?? 0,
    ratingCount: agent.ratingCount ?? 0,
    ratingAvg: agent.ratingAvg ?? null,
    escrowEarnedWei: "0",
    x402EarnedWei: "0",
    payers: 0,
    paidJobs: 0,
    zeroValueJobs: 0,
    issuerRole: "none",
    anchor: "unchecked",
    signed: false,
    verified: false,
    warnings: [] as string[],
  };
  if (opts.shallow) {
    base.warnings.push("shallow: ranked on the directory's own counters, which are proven on chain and cheap to inflate");
    return { ...base, ...scoreCandidate(base) };
  }
  try {
    const doc = await fmx_.cv.get(agent.id);
    let res: CvVerifyResult | null = null;
    try {
      res = await fmx_.cv.verify(doc);
    } catch (err) {
      base.warnings.push(`verification failed to run: ${(err as Error).message}`);
    }
    // THE MONEY FIGURE NEVER COMES FROM THE DOCUMENT.
    //
    // `summary` is the issuer's own arithmetic over its own claims. A forged CV
    // states whatever it likes there, and an earlier version of this file read
    // it verbatim — which carried a fabricated 58,500 FMX straight into an
    // autonomous hiring decision. The verifier re-derives escrow and x402
    // earnings from the claims that actually bound to transactions on chain,
    // and `verifiedEarned` is that number. When it is absent (no RPC, or the
    // verification did not run) this agent is treated as having proved nothing,
    // not as having earned whatever it says.
    const summary = doc.credentialSubject.summary ?? {};
    if (res) {
      base.provenClaims = res.verified;
      base.rejectedClaims = res.rejected;
      base.anchor = res.anchor;
      base.signed = res.signed;
      base.verified = res.ok;
      base.issuerRole = res.issuerRole;
      base.warnings.push(...res.warnings);
      if (res.errors.length) base.warnings.push(...res.errors.map((e) => `verification error: ${e}`));
    }
    if (res?.verifiedEarned) {
      base.escrowEarnedWei = res.verifiedEarned.escrowEarnedWei;
      base.x402EarnedWei = res.verifiedEarned.x402EarnedWei;
      base.payers = res.verifiedEarned.payers;
      base.paidJobs = res.verifiedEarned.paidJobs;
      base.zeroValueJobs = res.verifiedEarned.zeroValueJobs;
      const stated = String(summary.escrowEarnedWei ?? "0");
      if (stated !== base.escrowEarnedWei) {
        base.warnings.push(`the CV states escrowEarnedWei ${stated}; the claims that verified add up to ${base.escrowEarnedWei} — the verified figure is the one used here`);
      }
    } else {
      base.warnings.push("earnings were not re-derived from verified claims (no chain check ran), so this agent is ranked as unproven rather than on what its CV says");
    }
  } catch (err) {
    base.warnings.push(`no readable CV: ${(err as Error).message}`);
    opts.log?.warn({ agentId: agent.id, err: (err as Error).message }, "could not read a CV for this agent — ranking it on the directory alone");
  }
  return { ...base, ...scoreCandidate(base) };
}

/**
 * Finds candidates in the directory and ranks them by their PROVEN record.
 * Returns everything it looked at, best first, each with the reason for its
 * position — so a caller (or a model reading this over MCP) can see what it is
 * choosing between rather than being handed one answer.
 */
export async function pickAgent(fmx_: Ferminux, opts: PickOptions = {}): Promise<{ best: CandidateRecord | null; ranked: CandidateRecord[]; considered: number }> {
  const limit = opts.candidates ?? 12;
  // `q` is the directory's free-text search over name and description; it does
  // NOT index card capabilities, so a capability filter is applied here instead
  // of being pushed into the query. Over-fetch so the local filter has something
  // to work with.
  const listed = await fmx_.agents.list({ q: opts.q || undefined, status: "active", limit: Math.max(limit * 4, 25) });
  const exclude = new Set(opts.exclude ?? []);
  const wanted = opts.capability?.toLowerCase();
  const candidates = (listed.items ?? [])
    .filter((a) => {
      if (exclude.has(a.id)) return false;
      if (opts.maxPriceWei !== undefined && wei(a.pricePerJob) > opts.maxPriceWei) return false;
      if (!wanted) return true;
      const card = (a.card ?? {}) as Record<string, unknown>;
      const caps = Array.isArray(card.capabilities) ? (card.capabilities as string[]) : [];
      const haystack = [...caps, String(card.description ?? ""), a.name].join(" ").toLowerCase();
      return haystack.includes(wanted);
    })
    .slice(0, limit);

  const ranked = await Promise.all(candidates.map((a) => recordOf(fmx_, a, { shallow: opts.shallow, log: opts.log })));
  const eligible = ranked.filter((r) => r.provenClaims >= (opts.minProven ?? 0) && r.rejectedClaims === 0);
  // Score first, then the cheaper agent. An agent with a rejected claim is never
  // "best", however well it scores otherwise — but it still appears in `ranked`,
  // with the reason, so the caller can see what was passed over and why.
  const byScoreThenPrice = (a: CandidateRecord, b: CandidateRecord) => b.score - a.score || Number(wei(a.pricePerJobWei) - wei(b.pricePerJobWei));
  eligible.sort(byScoreThenPrice);
  ranked.sort(byScoreThenPrice);
  return { best: eligible[0] ?? null, ranked, considered: candidates.length };
}
