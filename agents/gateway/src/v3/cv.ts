// The AI-CV: an agent's verifiable working record.
//
//   GET /api/cv/:agent                  the document — every claim with its provenance
//   GET /api/cv/:agent/credential.json  the same document, signed by the gateway key
//   GET /api/cv/:agent/verify           the exact steps a stranger runs without us
//   GET /api/cv/:agent/badge.svg        an embeddable badge
//
// The governing rule: THE SIGNATURE AUTHENTICATES THE AUTHOR, THE CHAIN
// AUTHENTICATES THE CLAIM. The gateway's signature says only "this index
// assembled and published this document at this block". Every economic claim
// carries the transaction that proves it, so a reader fetches the receipt from
// any chain-3961 RPC and checks it without ever calling Ferminux. Removing our
// signature removes a convenience, not a proof.
//
// What the gateway alone asserts is named, never hidden: uptime is observed by
// our probe and nobody else can re-derive it; Commons contributions are rows in
// our SQLite; card capabilities are what the operator typed. Those claims carry
// `proven: false` and a trust tier, and a verifier that drops everything below
// `chain` still has a complete, checkable record.
//
// Completeness is the one property that leans on us. Every claim verifies
// without Ferminux; that nothing was omitted is attested (recordMeta) and can
// always be re-derived by scanning the logs yourself. The document says so in
// those words rather than claiming to be trustless.
import type { FastifyInstance } from "fastify";
import { Interface, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { ESCROW_ABI, JobStatusEnum, REGISTRY_ABI } from "../abi.js";
import { CHAIN, FIXED_CONTRACTS } from "../constants.js";
import { getMeta } from "../db.js";
import { canonicalJson } from "../commons/sign.js";
import { HttpError } from "../commons/context.js";
import { agentUptime, type UptimeView } from "../health.js";
import type { AgentRow, JobRow } from "../types.js";
import { AgentStatusName, JobStatusName } from "../types.js";
import type { V3ContractKey } from "../config.js";
import type { V3Context } from "./context.js";
import { merkleRoot } from "./audit.js";
import { parseCard, resolveAgentSlug, slugCollisions, slugify } from "./a2a.js";
import { memoryAnchorSummary } from "./memory-anchor.js";
import { ZERO_HASH } from "./merkle.js";

export const CV_VERSION = "1";
export const CV_CONTEXT = "https://ferminux.net/api/ns/aicv/v1";
export const CV_SCHEMA = "https://ferminux.net/api/ns/aicv/v1/schema.json";
export const CV_TYPE = "FerminuxAgentCV";
/** EIP-712 domain the credential proof is built in. */
export const CV_DOMAIN_NAME = "Ferminux AI-CV";
export const CV_CRYPTOSUITE = "eip712-jcs-2026";
/** A CV is a point-in-time snapshot; past this it must be rebuilt. */
export const CV_VALIDITY_S = 90 * 86_400;
export const CV_DEFAULT_CLAIMS = 200;
export const CV_MAX_CLAIMS = 1000;
export const CV_CACHE_S = 30;
export const BADGE_CACHE_S = 300;

/** Whether a stranger can re-derive the claim, and from what. */
export type Trust = "chain" | "gateway" | "selfAttested";
export type Provenance = "chain" | "signed" | "observed" | "declared";

export interface Evidence {
  trust: Trust;
  provenance: Provenance;
  /** true only for `chain`: re-derivable from an event on 3961 by anyone with an RPC URL */
  proven: boolean;
  chainId?: number;
  block?: number | null;
  ts?: number | null;
  tx?: string | null;
  /**
   * The BLOCK-scoped index the RPC returns as `logs[].logIndex`. It is named
   * `blockLogIndex` and not `logIndex` on purpose: "logs[logIndex]" reads like
   * an index into the receipt's own array, the two coincide only while a block
   * holds one transaction, and the first block that holds two is the one where
   * a reader guessing between them gets a different answer.
   */
  blockLogIndex?: number | null;
  address?: string | null;
  contract?: string;
  event?: string;
  topic0?: string | null;
  method?: string;
  source?: string;
  bind?: Array<Record<string, unknown>>;
  note?: string;
}

export interface CvClaim {
  id: string;
  type: string;
  statedAt: number | null;
  evidence: Evidence;
  leaf?: string;
  [k: string]: unknown;
}

interface EventRow {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  contractName: string;
  eventName: string;
  argsJSON: string;
  ts: number | null;
}

const ifaceCache = new Map<string, Interface>();
function ifaceFor(ctx: V3Context, contractName: string): Interface | undefined {
  if (contractName === "registry" || contractName === "escrow") {
    let i = ifaceCache.get(contractName);
    if (!i) {
      i = new Interface(contractName === "registry" ? [...REGISTRY_ABI] : [...ESCROW_ABI]);
      ifaceCache.set(contractName, i);
    }
    return i;
  }
  try {
    return ctx.iface(contractName as V3ContractKey);
  } catch {
    return undefined;
  }
}

function contractAddress(ctx: V3Context, contractName: string): string | null {
  if (contractName === "registry") return ctx.cfg.registry;
  if (contractName === "escrow") return ctx.cfg.escrow;
  return ctx.address(contractName as V3ContractKey) ?? null;
}

/** The event's signature and topic0, so a verifier can match logs[i].topics[0] without our ABI. */
function eventMeta(ctx: V3Context, contractName: string, eventName: string): { signature: string | null; topic0: string | null } {
  const iface = ifaceFor(ctx, contractName);
  try {
    const frag = iface?.getEvent(eventName);
    return frag ? { signature: frag.format("sighash"), topic0: frag.topicHash } : { signature: null, topic0: null };
  } catch {
    return { signature: null, topic0: null };
  }
}

/** Evidence for a claim proved by an indexed log. */
function chainEvidence(
  ctx: V3Context,
  contractName: string,
  eventName: string,
  e: { txHash: string | null; logIndex?: number | null; blockNumber?: number | null; ts?: number | null },
  bind?: Array<Record<string, unknown>>,
): Evidence {
  const meta = eventMeta(ctx, contractName, eventName);
  return {
    trust: "chain",
    provenance: "chain",
    proven: true,
    chainId: CHAIN.chainId,
    block: e.blockNumber ?? null,
    ts: e.ts ?? null,
    tx: e.txHash,
    blockLogIndex: e.logIndex ?? null,
    address: contractAddress(ctx, contractName),
    contract: contractName,
    event: meta.signature ?? eventName,
    topic0: meta.topic0,
    method: "eth_getTransactionReceipt",
    ...(bind ? { bind } : {}),
  };
}

function gatewayEvidence(source: string, note: string): Evidence {
  return { trust: "gateway", provenance: "signed", proven: false, method: "GET", source, note };
}
function observedEvidence(source: string, note: string): Evidence {
  return { trust: "gateway", provenance: "observed", proven: false, method: "GET", source, note };
}
function declaredEvidence(source: string, note: string): Evidence {
  return { trust: "selfAttested", provenance: "declared", proven: false, method: "GET", source, note };
}

/**
 * leaf = keccak256(utf8(JCS(claim without `leaf`))). Defined here rather than
 * borrowed from the audit export's leafHash(), which strips `sig` instead — the
 * two agree today only because no claim carries a `sig`, and a published hash
 * rule should not depend on that.
 */
export function claimLeaf(claim: Record<string, unknown>): string {
  const { leaf: _leaf, ...rest } = claim;
  return keccak256(toUtf8Bytes(canonicalJson(rest)));
}

function jsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bigSum(values: Array<string | null | undefined>): bigint {
  let out = 0n;
  for (const v of values) {
    try {
      out += BigInt(v ?? "0");
    } catch {
      /* malformed row */
    }
  }
  return out;
}

export interface CvOptions {
  /** max claims in record[]; the rest are declared in recordMeta.omitted */
  limit?: number;
}

export interface BuiltCv {
  doc: Record<string, unknown>;
  claims: CvClaim[];
  claimsRoot: string;
  documentHash: string;
  agent: AgentRow;
  summary: Record<string, unknown>;
  asOfBlock: number;
}

/**
 * Assembles the document from every live source. Pure over the DB: the same
 * database at the same block produces the same bytes, which is what makes
 * documentHash reproducible.
 */
export function buildCv(ctx: V3Context, row: AgentRow, opts: CvOptions = {}): BuiltCv {
  const db = ctx.db;
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");
  const owner = getAddress(row.owner);
  const ownerLc = owner.toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? CV_DEFAULT_CLAIMS, 1), CV_MAX_CLAIMS);
  const slug = slugify(row.name);
  const card = parseCard(row);
  const now = ctx.nowS();
  const indexed = getMeta(db, "indexedBlock");
  const asOfBlock = indexed !== undefined ? Number(indexed) : 0;

  // Every indexed log touching this agent (by id) or its owner (by address), in chain order.
  const events = db
    .prepare(
      `SELECT * FROM events WHERE
         (contractName = 'registry' AND json_extract(argsJSON, '$.id') = ?)
      OR (contractName = 'escrow' AND json_extract(argsJSON, '$.jobId') IN (SELECT id FROM jobs WHERE agentId = ?))
      OR (contractName NOT IN ('registry','escrow') AND (json_extract(argsJSON, '$.agentId') = ? OR lower(argsJSON) LIKE ?))
       ORDER BY blockNumber ASC, logIndex ASC`,
    )
    .all(String(row.id), row.id, String(row.id), `%${ownerLc}%`) as EventRow[];

  const byName = new Map<string, EventRow[]>();
  for (const e of events) {
    const k = `${e.contractName}:${e.eventName}`;
    const list = byName.get(k);
    if (list) list.push(e);
    else byName.set(k, [e]);
  }
  const pick = (contract: string, event: string, match?: (args: Record<string, unknown>) => boolean): EventRow | undefined => {
    const list = byName.get(`${contract}:${event}`) ?? [];
    return match ? list.find((e) => match(jsonParse(e.argsJSON))) : list[0];
  };

  const claims: CvClaim[] = [];
  const omitted = new Map<string, { count: number; reason: string }>();
  const omit = (type: string, count: number, reason: string) => {
    if (count <= 0) return;
    const prev = omitted.get(type);
    omitted.set(type, { count: (prev?.count ?? 0) + count, reason: prev?.reason ?? reason });
  };

  // ---------------------------------------------------------------- registration
  //
  // THE SPLIT THAT MATTERS. AgentRegistered proves one thing: this id was
  // registered by this owner, with these values, at this block. It does NOT
  // prove what the endpoint, price, bond or status are NOW — the owner rewrites
  // all four whenever it likes, in one transaction, with no history and no
  // event carrying the current value.
  //
  // Those two facts used to live in one claim marked `proven: true`, bound only
  // by {id, owner}. An attacker rewrote the endpoint to its own host, flipped
  // Paused to Active and multiplied the price by ten, and the document passed
  // every published step. So: registration-time values are named
  // `…AtRegistration` and bound to the log; the live values move to their own
  // AgentState claim, which carries no transaction and is re-read from the
  // registry by the verifier every single time.
  const reg = pick("registry", "AgentRegistered");
  const regArgs = reg ? jsonParse(reg.argsJSON) : {};
  claims.push({
    id: `fmx:${row.id}:registration`,
    type: "Registration",
    statedAt: reg?.ts ?? row.registeredAt,
    agentId: row.id,
    owner,
    name: reg ? String(regArgs.name ?? row.name) : row.name,
    endpointAtRegistration: reg ? String(regArgs.endpoint ?? "") : null,
    metadataURIAtRegistration: reg ? String(regArgs.metadataURI ?? "") : null,
    pricePerJobWeiAtRegistration: reg ? String(regArgs.pricePerJob ?? "0") : null,
    bondWeiAtRegistration: reg ? String(regArgs.bond ?? "0") : null,
    mutableNote:
      "what this agent charges, where it answers and whether it is active are NOT proved here — they are mutable registry state with no history. Read the AgentState claim, or call AgentRegistry.getAgent(id) yourself.",
    evidence: reg
      ? chainEvidence(ctx, "registry", "AgentRegistered", reg, [
          { log: "id", equals: "subject.agentId" },
          { log: "owner", equals: "subject.address" },
          { log: "name", equals: "claim.name" },
          { log: "endpoint", equals: "claim.endpointAtRegistration" },
          { log: "pricePerJob", equals: "claim.pricePerJobWeiAtRegistration" },
          { log: "bond", equals: "claim.bondWeiAtRegistration" },
        ])
      : gatewayEvidence(`${base}/api/agents/${row.id}`, "registration is in the index but its AgentRegistered log has not been backfilled yet — read AgentRegistry.getAgent(id) to confirm"),
  });

  // ---------------------------------------------------------------- live state
  claims.push({
    id: `fmx:${row.id}:state`,
    type: "AgentState",
    statedAt: now,
    agentId: row.id,
    owner,
    endpoint: row.endpoint,
    metadataURI: row.metadataURI ?? "",
    pricePerJobWei: row.pricePerJob,
    bondWei: row.bond,
    status: AgentStatusName[row.status] ?? "None",
    note: "the mutable half of an agent, read live from AgentRegistry. A verifier re-reads it and rejects this claim if the answer differs — a stale document and a forged one get the same answer here on purpose, because the endpoint is where you send work and money.",
    evidence: {
      trust: "chain",
      provenance: "chain",
      proven: true,
      chainId: CHAIN.chainId,
      address: ctx.cfg.registry,
      contract: "registry",
      method: "eth_call",
      call: `getAgent(${row.id})`,
      note: "no transaction proves a mutable field's CURRENT value; this is a live read and the verifier repeats it",
    } as Evidence,
  });

  // ---------------------------------------------------------------- escrow jobs
  const jobs = db.prepare("SELECT * FROM jobs WHERE agentId = ? ORDER BY createdAt DESC").all(row.id) as JobRow[];
  const jobEvent = (jobId: number, event: string) => pick("escrow", event, (a) => Number(a.jobId) === jobId);
  let escrowEarned = 0n;
  let escrowFees = 0n;
  let jobsRated = 0;
  let ratingSumFromJobs = 0;
  const settledJobs = jobs.filter((j) => j.status === JobStatusEnum.Completed || j.status === JobStatusEnum.Resolved);
  const jobClaims: CvClaim[] = [];
  for (const job of jobs) {
    const completed = jobEvent(job.id, "JobCompleted");
    const resolved = jobEvent(job.id, "JobResolved");
    const refunded = jobEvent(job.id, "JobRefunded");
    const settle = completed ?? resolved ?? refunded;
    const args = settle ? jsonParse(settle.argsJSON) : {};
    const payout = String(args.agentPayout ?? "0");
    const fee = String(args.fee ?? "0");
    if (completed || resolved) {
      escrowEarned += bigSum([payout]);
      escrowFees += bigSum([fee]);
    }
    // ServiceEscrow.claim() records rating 0 for a job the client never reviewed.
    // 0 is "unrated", not "zero stars" — a consumer MUST NOT coerce null to 0.
    const ratingRaw = completed ? Number(args.rating ?? 0) : null;
    const rating = ratingRaw !== null && ratingRaw > 0 ? ratingRaw : null;
    if (rating !== null) {
      jobsRated += 1;
      ratingSumFromJobs += rating;
    }
    const requested = jobEvent(job.id, "JobRequested");
    jobClaims.push({
      id: `fmx:${row.id}:job:${job.id}`,
      type: "EscrowJob",
      statedAt: settle?.ts ?? job.deliveredAt ?? job.createdAt,
      jobId: job.id,
      client: job.client,
      amountWei: job.amount,
      payoutWei: completed || resolved ? payout : null,
      feeWei: completed || resolved ? fee : null,
      outcome: JobStatusName[job.status] ?? "None",
      rating,
      ratingScale: "1..5",
      ratingNote: rating === null && completed ? "released without a rating (ServiceEscrow records 0 = unrated; null is not zero stars)" : undefined,
      inputHash: job.inputHash || null,
      outputHash: job.outputHash,
      requestedAt: job.createdAt,
      deliveredAt: job.deliveredAt,
      settledAt: settle?.ts ?? null,
      evidence: settle
        ? chainEvidence(ctx, "escrow", settle.eventName, settle, [
            { log: "jobId", equals: "claim.jobId" },
            { call: { address: contractAddress(ctx, "escrow"), fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" },
            { call: { address: contractAddress(ctx, "escrow"), fn: "getJob(uint256)", args: ["claim.jobId"], field: "outputHash" }, equals: "claim.outputHash" },
            // The money and the rating are IN the log this claim cites, and for
            // a while nothing compared them to it. A payout could be multiplied
            // by a hundred and an unrated job turned into five stars without
            // failing a single published step.
            { log: "agentPayout", equals: "claim.payoutWei" },
            { log: "fee", equals: "claim.feeWei" },
            ...(completed ? [{ log: "rating", equals: "claim.rating|0" }] : []),
          ])
        : requested
          ? chainEvidence(ctx, "escrow", "JobRequested", requested, [
              { log: "jobId", equals: "claim.jobId" },
              { log: "agentId", equals: "subject.agentId" },
            ])
          : gatewayEvidence(`${base}/api/jobs/${job.id}`, "indexed job with no settlement log yet (still open or delivered)"),
      alsoEvidence: [requested, jobEvent(job.id, "JobDelivered")]
        .filter((e): e is EventRow => !!e && e !== settle)
        .map((e) => chainEvidence(ctx, "escrow", e.eventName, e)),
    });
  }
  claims.push(...jobClaims);

  // ---------------------------------------------------------------- x402
  const receipts = db.prepare("SELECT * FROM x402_settlements WHERE lower(payee) = ? ORDER BY ts DESC").all(ownerLc) as Array<{
    txHash: string;
    logIndex: number;
    payer: string;
    payee: string;
    amount: string;
    fee: string;
    nonce: string;
    ref: string;
    blockNumber: number;
    ts: number;
  }>;
  const payments = db.prepare("SELECT * FROM x402_settlements WHERE lower(payer) = ? ORDER BY ts DESC").all(ownerLc) as typeof receipts;
  // NET of the vault fee, exactly like escrowEarnedWei (which uses agentPayout).
  // "Earned" has to mean the same thing in both places, or a stranger
  // recomputing it from the chain gets a number that disagrees with the signed
  // one — which looks precisely like tampering.
  const x402Gross = bigSum(receipts.map((r) => r.amount));
  const x402Fees = bigSum(receipts.map((r) => r.fee));
  const x402Earned = x402Gross - x402Fees;
  const x402Spent = bigSum(payments.map((r) => r.amount));
  const X402_CLAIM_CAP = 50;
  for (const r of receipts.slice(0, X402_CLAIM_CAP)) {
    claims.push({
      id: `fmx:${row.id}:x402:in:${r.nonce}`,
      type: "X402Receipt",
      statedAt: r.ts,
      payer: r.payer,
      payee: r.payee,
      amountWei: r.amount,
      feeWei: r.fee,
      nonce: r.nonce,
      evidence: chainEvidence(ctx, "x402Vault", "Settled", r, [
        { log: "payee", equals: "subject.address" },
        { log: "payer", equals: "claim.payer" },
        { log: "nonce", equals: "claim.nonce" },
        { log: "amount", equals: "claim.amountWei" },
        { log: "fee", equals: "claim.feeWei" },
      ]),
    });
  }
  omit("X402Receipt", receipts.length - Math.min(receipts.length, X402_CLAIM_CAP), "identical shape; the aggregate is in summary.x402EarnedWei");
  for (const r of payments.slice(0, X402_CLAIM_CAP)) {
    claims.push({
      id: `fmx:${row.id}:x402:out:${r.nonce}`,
      type: "X402Payment",
      statedAt: r.ts,
      payer: r.payer,
      payee: r.payee,
      amountWei: r.amount,
      feeWei: r.fee,
      nonce: r.nonce,
      note: "this agent hires other agents; its counterparty history is part of the record",
      evidence: chainEvidence(ctx, "x402Vault", "Settled", r, [
        { log: "payer", equals: "subject.address" },
        { log: "payee", equals: "claim.payee" },
        { log: "nonce", equals: "claim.nonce" },
        { log: "amount", equals: "claim.amountWei" },
        { log: "fee", equals: "claim.feeWei" },
      ]),
    });
  }
  omit("X402Payment", payments.length - Math.min(payments.length, X402_CLAIM_CAP), "identical shape; the aggregate is in summary.x402SpentWei");
  const vouchers = db.prepare("SELECT COUNT(*) AS c FROM x402_vouchers WHERE lower(payee) = ? AND status IN ('queued','submitted')").get(ownerLc) as { c: number };

  // ---------------------------------------------------------------- streams and plans
  const streams = db.prepare("SELECT * FROM streams WHERE lower(payee) = ? ORDER BY id DESC").all(ownerLc) as Array<Record<string, unknown> & { id: number; payer: string; ratePerSec: string; deposit: string; claimed: string; start: number; stop: number; cancelled: number; txOpened: string | null }>;
  for (const s of streams) {
    const e = pick("streamPay", "StreamOpened", (a) => Number(a.id ?? a.streamId) === s.id);
    claims.push({
      id: `fmx:${row.id}:stream:${s.id}`,
      type: "Stream",
      statedAt: e?.ts ?? s.start,
      streamId: s.id,
      payer: s.payer,
      ratePerSecWei: s.ratePerSec,
      depositWei: s.deposit,
      claimedWei: s.claimed,
      start: s.start,
      stop: s.stop,
      cancelled: s.cancelled === 1,
      evidence: e
        ? chainEvidence(ctx, "streamPay", "StreamOpened", e, [{ log: "payee", equals: "subject.address" }])
        : gatewayEvidence(`${base}/api/streams?payee=${owner}`, "indexed stream whose opening log is not in the window"),
    });
  }
  // Spend-side streams. Outbound x402 was already in the record with the note
  // "this agent hires other agents; its counterparty history is part of the
  // record" — and outbound STREAMS were silently absent, which made
  // `complete: true` false for any agent that had ever opened one. Either both
  // sides are in the record or the claim of completeness is not true.
  const streamsOut = db.prepare("SELECT * FROM streams WHERE lower(payer) = ? ORDER BY id DESC").all(ownerLc) as typeof streams;
  for (const st of streamsOut) {
    const e = pick("streamPay", "StreamOpened", (a) => Number(a.id ?? a.streamId) === st.id);
    claims.push({
      id: `fmx:${row.id}:stream:out:${st.id}`,
      type: "StreamPayment",
      statedAt: e?.ts ?? st.start,
      streamId: st.id,
      payer: st.payer,
      payee: String((st as unknown as { payee?: string }).payee ?? ""),
      ratePerSecWei: st.ratePerSec,
      depositWei: st.deposit,
      claimedWei: st.claimed,
      start: st.start,
      stop: st.stop,
      cancelled: st.cancelled === 1,
      note: "this agent pays another agent by the second; its counterparty history is part of the record",
      evidence: e
        ? chainEvidence(ctx, "streamPay", "StreamOpened", e, [
            { log: "payer", equals: "subject.address" },
            { log: "id", equals: "claim.streamId" },
          ])
        : gatewayEvidence(`${base}/api/streams?payer=${owner}`, "indexed stream whose opening log is not in the window"),
    });
  }

  const plans = db.prepare("SELECT * FROM plans WHERE lower(payee) = ? ORDER BY id DESC").all(ownerLc) as Array<{ id: number; pricePerPeriod: string; period: number; active: number; metadataURI: string; createdAt: number }>;
  for (const pl of plans) {
    const e = pick("streamPay", "PlanCreated", (a) => Number(a.planId ?? a.id) === pl.id);
    const subs = db.prepare("SELECT COUNT(*) AS c FROM subs WHERE planId = ? AND cancelled = 0 AND paidThrough > ?").get(pl.id, now) as { c: number };
    claims.push({
      id: `fmx:${row.id}:plan:${pl.id}`,
      type: "SubscriptionPlan",
      statedAt: e?.ts ?? pl.createdAt,
      planId: pl.id,
      payee: owner,
      pricePerPeriodWei: pl.pricePerPeriod,
      periodSeconds: pl.period,
      active: pl.active === 1,
      activeSubscribers: subs.c,
      metadataURI: pl.metadataURI,
      evidence: e
        ? chainEvidence(ctx, "streamPay", "PlanCreated", e, [
            { log: "planId", equals: "claim.planId" },
            { log: "payee", equals: "subject.address" },
          ])
        : gatewayEvidence(`${base}/api/streams/plans?payee=${owner}`, "indexed plan whose PlanCreated log is not in the window"),
    });
  }

  // ---------------------------------------------------------------- FRC-8004 reputation
  const feedback = db.prepare("SELECT * FROM reputation_feedback WHERE agentId = ? ORDER BY ts DESC").all(row.id) as Array<{
    txHash: string;
    logIndex: number;
    client: string;
    value: string;
    valueDecimals: number;
    tag1: string;
    tag2: string;
    feedbackURI: string;
    ts: number;
  }>;
  const FEEDBACK_CAP = 50;
  // A feedback entry is payment-backed when its author actually paid this agent —
  // giveFeedback is permissionless, so an unbacked endorsement costs ~0.0001 FMX.
  const paidClients = new Set<string>([
    ...jobs.filter((j) => j.status === JobStatusEnum.Completed || j.status === JobStatusEnum.Resolved).map((j) => j.client.toLowerCase()),
    ...receipts.map((r) => r.payer.toLowerCase()),
  ]);
  let feedbackBacked = 0;
  for (const f of feedback) {
    const backed = paidClients.has(f.client.toLowerCase());
    if (backed) feedbackBacked += 1;
  }
  for (const f of feedback.slice(0, FEEDBACK_CAP)) {
    const backed = paidClients.has(f.client.toLowerCase());
    claims.push({
      id: `fmx:${row.id}:feedback:${f.txHash}:${f.logIndex}`,
      type: "Feedback",
      statedAt: f.ts,
      client: f.client,
      value: f.value,
      valueDecimals: f.valueDecimals,
      tag1: f.tag1,
      tag2: f.tag2,
      feedbackURI: f.feedbackURI,
      paymentBacked: backed,
      paymentBackedNote: backed
        ? "this author paid this agent through escrow or x402, so the entry has value at risk behind it"
        : "this author has no paid record with this agent; the entry is on chain but cost its author almost nothing — do not average it into a score",
      evidence: chainEvidence(ctx, "reputation8004", "NewFeedback", { txHash: f.txHash, logIndex: f.logIndex, blockNumber: null, ts: f.ts }, [
        { log: "agentId", equals: "subject.agentId" },
        { log: "clientAddress", equals: "claim.client" },
      ]),
    });
  }
  omit("Feedback", feedback.length - Math.min(feedback.length, FEEDBACK_CAP), "older entries; the counts are in summary.feedback");

  // ---------------------------------------------------------------- FRC-8004 validation
  const validations = db.prepare("SELECT * FROM validations WHERE agentId = ? ORDER BY requestedAt DESC").all(row.id) as Array<{
    requestHash: string;
    validator: string;
    jobId: number | null;
    requestURI: string;
    response: number | null;
    responseURI: string | null;
    tag: string | null;
    requestedAt: number;
    respondedAt: number | null;
    txRequest: string | null;
    txResponse: string | null;
  }>;
  const scored = validations.filter((v) => v.response !== null);
  for (const v of validations.slice(0, 50)) {
    // The registry lets an agent name any validator, including one it controls,
    // so an unqualified validator's 100/100 is self-attested and is labelled as such.
    const selfNamed = v.validator.toLowerCase() === ownerLc;
    claims.push({
      id: `fmx:${row.id}:validation:${v.requestHash}`,
      type: "Validation",
      statedAt: v.respondedAt ?? v.requestedAt,
      requestHash: v.requestHash,
      validator: v.validator,
      validatorTier: selfNamed ? "self" : "independent",
      jobId: v.jobId,
      response: v.response,
      responseScale: "0..100",
      tag: v.tag,
      requestURI: v.requestURI,
      responseURI: v.responseURI,
      selfAttested: selfNamed,
      validatorNote: selfNamed
        ? "self-attested: the validator address is the agent's own owner. ValidationRegistry8004 lets an owner name any validator, so this score proves a transaction happened, not that an independent party checked the work."
        : "scored by a validator other than this agent's owner; check what that validator has at stake before weighting it",
      evidence: v.txResponse
        ? chainEvidence(ctx, "validation8004", "ValidationResponse", { txHash: v.txResponse, logIndex: null, blockNumber: null, ts: v.respondedAt }, [
            { log: "agentId", equals: "subject.agentId" },
            { log: "requestHash", equals: "claim.requestHash" },
          ])
        : chainEvidence(ctx, "validation8004", "ValidationRequest", { txHash: v.txRequest, logIndex: null, blockNumber: null, ts: v.requestedAt }),
    });
  }

  // ---------------------------------------------------------------- disputes
  const cases = db
    .prepare("SELECT c.* FROM arbiter_cases c JOIN jobs j ON j.id = c.jobId WHERE j.agentId = ? ORDER BY c.id DESC")
    .all(row.id) as Array<{ id: number; jobId: number; opener: string; evidenceURI: string; openedAt: number; closed: number; result: number | null; closedAt: number | null; txOpened: string | null }>;
  for (const c of cases) {
    const closedEv = pick("arbiterPool", "CaseClosed", (a) => Number(a.caseId ?? a.id) === c.id);
    const openedEv = pick("arbiterPool", "CaseOpened", (a) => Number(a.caseId ?? a.id) === c.id);
    claims.push({
      id: `fmx:${row.id}:dispute:${c.id}`,
      type: "Dispute",
      statedAt: c.closedAt ?? c.openedAt,
      caseId: c.id,
      jobId: c.jobId,
      opener: c.opener,
      closed: c.closed === 1,
      clientBps: c.result,
      outcome: c.closed === 1 ? (c.result === null ? "closed" : c.result >= 5000 ? "mostly for the client" : "mostly for the agent") : "open",
      evidenceURI: c.evidenceURI,
      note: "disputes are part of the record and are never withheld from it",
      evidence: closedEv
        ? chainEvidence(ctx, "arbiterPool", "CaseClosed", closedEv, [{ log: "jobId", equals: "claim.jobId" }])
        : openedEv
          ? chainEvidence(ctx, "arbiterPool", "CaseOpened", openedEv, [{ log: "jobId", equals: "claim.jobId" }])
          : gatewayEvidence(`${base}/api/disputes?jobId=${c.jobId}`, "indexed case whose log is not in the window"),
    });
  }

  // ---------------------------------------------------------------- endorsements
  const endorsements = db
    .prepare("SELECT * FROM endorsements WHERE toAgentId = ? ORDER BY ts DESC")
    .all(row.id) as Array<{ id: number; fromAgentId: number; endorser: string; capability: string; basis: number; weight: number; evidenceJobId: number; evidenceAmountWei: string; uri: string; revoked: number; ts: number; txHash: string | null; logIndex: number | null; blockNumber: number | null }>;
  const liveEndorsements = endorsements.filter((e) => e.revoked === 0);
  for (const e of liveEndorsements.slice(0, 50)) {
    claims.push({
      id: `fmx:${row.id}:endorsement:${e.id}`,
      type: "Endorsement",
      statedAt: e.ts,
      endorsementId: e.id,
      fromAgentId: e.fromAgentId,
      endorser: e.endorser || null,
      capability: e.capability,
      weight: e.weight,
      basis: e.basis,
      paymentBacked: e.evidenceJobId > 0,
      evidenceJobId: e.evidenceJobId > 0 ? e.evidenceJobId : null,
      evidenceAmountWei: e.evidenceAmountWei,
      uri: e.uri || null,
      evidence: e.txHash
        ? chainEvidence(ctx, "endorsements", "Endorsed", { txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, ts: e.ts }, [
            { log: "toAgentId", equals: "subject.agentId" },
            { log: "id", equals: "claim.endorsementId" },
          ])
        : gatewayEvidence(`${base}/api/cv/${row.id}`, "indexed endorsement whose log is not in the window"),
    });
  }
  omit("Endorsement", liveEndorsements.length - Math.min(liveEndorsements.length, 50), "the counts are in summary.endorsements");

  // ---------------------------------------------------------------- memory anchors (FRC-100)
  const memory = memoryAnchorSummary(ctx, row.id, owner);
  const anchors = db
    .prepare("SELECT * FROM memory_anchors WHERE agentId = ? AND status = 'anchored' ORDER BY COALESCE(onchainSeq, id) DESC LIMIT 25")
    .all(row.id) as Array<{ id: number; root: string; prevRoot: string; count: number; fromSeq: number; toSeq: number; onchainSeq: number | null; totalRecords: number | null; txHash: string | null; blockNumber: number | null; anchoredAt: number | null; uri: string }>;
  for (const a of anchors) {
    claims.push({
      id: `fmx:${row.id}:memory:${a.onchainSeq ?? a.root}`,
      type: "MemoryAnchor",
      statedAt: a.anchoredAt,
      anchorSeq: a.onchainSeq,
      root: a.root,
      prevRoot: a.prevRoot,
      count: a.count,
      fromSeq: a.fromSeq,
      toSeq: a.toSeq,
      totalRecords: a.totalRecords,
      uri: a.uri || null,
      proofs: `${base}/api/memory/proof/${row.id}/{seq}`,
      note: "the root commits to a batch of memory-record headers. Values stay private; only commitments are anchored. This proves the records existed in this order no later than this block — not that the log is complete.",
      evidence: a.txHash
        ? chainEvidence(ctx, "memoryAnchor", "MemoryAnchored", { txHash: a.txHash, logIndex: null, blockNumber: a.blockNumber, ts: a.anchoredAt }, [
            { log: "agentId", equals: "subject.agentId" },
            { log: "root", equals: "claim.root" },
          ])
        : gatewayEvidence(`${base}/api/memory/anchors?agentId=${row.id}`, "batch built but not yet anchored"),
    });
  }

  // ---------------------------------------------------------------- token
  const tokens = db.prepare("SELECT * FROM agent_tokens WHERE agentId = ?").all(row.id) as Array<{ token: string; symbol: string; launchedAt: number; buys: number; sells: number; fmxIn: string; fmxOut: string; txLaunched: string | null }>;
  for (const t of tokens) {
    const e = pick("tokenFactory", "Launched", (a) => String(a.token).toLowerCase() === t.token.toLowerCase());
    claims.push({
      id: `fmx:${row.id}:token:${t.token}`,
      type: "TokenLaunch",
      statedAt: e?.ts ?? t.launchedAt,
      token: t.token,
      symbol: t.symbol,
      standard: "FRC-20",
      buys: t.buys,
      sells: t.sells,
      fmxInWei: t.fmxIn,
      fmxOutWei: t.fmxOut,
      evidence: e
        ? chainEvidence(ctx, "tokenFactory", "Launched", e, [
            { log: "agentId", equals: "subject.agentId" },
            { log: "token", equals: "claim.token" },
          ])
        : gatewayEvidence(`${base}/api/tokens?agentId=${row.id}`, "indexed token launch whose log is not in the window"),
    });
  }

  // ---------------------------------------------------------------- referrals
  const referred = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(paid), 0) AS paid FROM referrals WHERE refAgentId = ?").get(row.id) as { c: number; paid: number };
  if (referred.c > 0) {
    claims.push({
      id: `fmx:${row.id}:referrals`,
      type: "Referral",
      statedAt: now,
      referred: referred.c,
      paidOut: referred.paid,
      evidence: gatewayEvidence(
        `${base}/api/referrals/by/${row.id}`,
        "referral claims are Commons rows signed by the referred agent's owner; the reward transfers themselves are on chain and linked from that route",
      ),
    });
  }

  // ---------------------------------------------------------------- Commons contributions
  const commonsRows = db
    .prepare("SELECT type, COUNT(*) AS c, MAX(ts) AS last FROM activity WHERE lower(actor) = ? AND type NOT LIKE 'job.%' AND type NOT LIKE 'agent.%' GROUP BY type ORDER BY c DESC")
    .all(ownerLc) as Array<{ type: string; c: number; last: number }>;
  const commonsTotal = commonsRows.reduce((a, r) => a + r.c, 0);
  for (const c of commonsRows) {
    claims.push({
      id: `fmx:${row.id}:commons:${c.type}`,
      type: "Contribution",
      statedAt: c.last,
      kind: c.type,
      count: c.c,
      evidence: gatewayEvidence(
        `${base}/api/agents/${row.id}/audit.jsonl`,
        "off-chain Commons writes. Each was authenticated by an EIP-191 signature from this owner at write time and appears in the gateway's signed audit export; drop this claim if you only trust chain evidence.",
      ),
    });
  }

  // ---------------------------------------------------------------- reliability (observed)
  const uptime: UptimeView = agentUptime(db, row.id, 30, ctx.now());
  const deliveredOnTime = settledJobs.filter((j) => j.deliveredAt !== null).length;
  claims.push({
    id: `fmx:${row.id}:reliability`,
    type: "Reliability",
    statedAt: now,
    uptimePct: uptime.uptimePct,
    probes: uptime.probes,
    probeDays: uptime.days,
    online: row.online === 1,
    lastSeen: row.lastSeen,
    deliveredJobs: deliveredOnTime,
    settledJobs: settledJobs.length,
    evidence: observedEvidence(
      `${base}/api/cv/${row.id}`,
      uptime.note,
    ),
  });

  // ---------------------------------------------------------------- capabilities (declared)
  const capabilities = Array.isArray(card?.capabilities) ? (card!.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : [];
  claims.push({
    id: `fmx:${row.id}:capabilities`,
    type: "Capability",
    statedAt: now,
    capabilities,
    model: typeof card?.model === "string" ? card.model : null,
    version: typeof card?.version === "string" ? card.version : null,
    pricePerCallWei: typeof card?.pricePerCall === "string" || typeof card?.pricePerCall === "number" ? String(card.pricePerCall) : null,
    card: row.endpoint ? `${row.endpoint.replace(/\/+$/, "")}/.well-known/ferminux-agent.json` : null,
    evidence: declaredEvidence(
      `${base}/api/agents/${row.id}`,
      "declared by the agent in its own card and not proved by chain state. A verifier may test it against the live endpoint.",
    ),
  });

  // ---------------------------------------------------------------- order, cap, hash
  claims.sort((a, b) => {
    const ab = a.evidence.block ?? Number.MAX_SAFE_INTEGER;
    const bb = b.evidence.block ?? Number.MAX_SAFE_INTEGER;
    if (ab !== bb) return ab - bb;
    const at = a.statedAt ?? Number.MAX_SAFE_INTEGER;
    const bt = b.statedAt ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (claims.length > limit) {
    for (const c of claims.slice(limit)) omit(c.type, 1, "over the requested claim limit; raise ?limit= or read the full audit export");
    claims.length = limit;
  }
  for (const c of claims) c.leaf = claimLeaf(c as unknown as Record<string, unknown>);
  const claimsRoot = merkleRoot(claims.map((c) => c.leaf!));

  const ratingAvg = row.ratingCount > 0 ? Math.round((row.ratingSum / row.ratingCount) * 100) / 100 : null;

  // WHAT A SELF-DEALER CAN BUY, MEASURED.
  //
  // ServiceEscrow.requestJob accepts msg.value = 0 and blocks only the agent's
  // own owner from being the client, so a second address you control can mint a
  // completed job and a five-star rating for the price of gas — about 0.00016
  // FMX — with no FMX moving at all. The registry's counters are proven on
  // chain and worth almost nothing on their own.
  //
  // We cannot fix that in a deployed contract from here, so the CV refuses to
  // print a counter without the qualifier beside it: how many of those jobs
  // actually moved money, how many distinct addresses paid, and how many
  // ratings sit on a job that was worth something.
  const paidSettled = settledJobs.filter((j) => {
    try {
      return BigInt(j.amount || "0") > 0n;
    } catch {
      return false;
    }
  });
  const paidJobIds = new Set(paidSettled.map((j) => j.id));
  const ratedPaidJobs = jobClaims.filter((c) => c.rating !== null && paidJobIds.has(Number(c.jobId))).length;
  const distinctPayers = new Set<string>([...paidSettled.map((j) => j.client.toLowerCase()), ...receipts.map((r) => r.payer.toLowerCase())]);
  const arms = {
    paidJobsCompleted: paidSettled.length,
    zeroValueJobs: settledJobs.length - paidSettled.length,
    distinctPayers: distinctPayers.size,
    ratedPaidJobs,
    note:
      settledJobs.length - paidSettled.length > 0
        ? `${settledJobs.length - paidSettled.length} of ${settledJobs.length} settled jobs moved 0 FMX. A zero-value job mints the same jobsCompleted and the same rating as a real one and costs only gas — read paidJobsCompleted and distinctPayers, not the raw counters.`
        : "every settled job in this record moved FMX. The registry's counters are still cheap to inflate in general, so distinctPayers is the number that is hard to buy: breadth of payers, not volume.",
    stillBuyable:
      "a second address the same operator controls is a valid client on chain — ServiceEscrow blocks only the agent's own owner, not an arms-length relation. distinctPayers counts addresses, and an operator can afford several. Weight this record by who paid, by how much, and by whether you recognise them.",
  };

  const summary: Record<string, unknown> = {
    asOfBlock,
    jobsCompleted: row.jobsCompleted,
    jobsFailed: row.jobsFailed,
    jobsSettled: settledJobs.length,
    ratingCount: row.ratingCount,
    ratingSum: row.ratingSum,
    ratingAvg,
    armsLength: arms,
    ratedJobsInRecord: jobsRated,
    ratingSumInRecord: ratingSumFromJobs,
    unratedCompletions: Math.max(settledJobs.length - jobsRated, 0),
    unratedNote: "ServiceEscrow.claim() records rating 0 for a completed job the client never reviewed. An unrated completion is an uncontested delivery, not a missing or zero rating.",
    bondWei: row.bond,
    pricePerJobWei: row.pricePerJob,
    escrowEarnedWei: escrowEarned.toString(),
    escrowFeesWei: escrowFees.toString(),
    x402EarnedWei: x402Earned.toString(),
    x402GrossWei: x402Gross.toString(),
    x402FeesWei: x402Fees.toString(),
    earnedNote: "escrowEarnedWei and x402EarnedWei are both NET of the protocol fee — the FMX this agent could withdraw, not the FMX a payer sent. x402GrossWei is the gross figure if you want it.",
    x402ReceiptCount: receipts.length,
    x402SpentWei: x402Spent.toString(),
    x402PaymentCount: payments.length,
    x402VouchersPending: vouchers.c,
    streams: streams.length,
    subscriptionPlans: plans.length,
    feedback: { total: feedback.length, paymentBacked: feedbackBacked, unbacked: feedback.length - feedbackBacked },
    validations: { total: validations.length, scored: scored.length, avgResponse: scored.length ? Math.round(scored.reduce((a, v) => a + (v.response ?? 0), 0) / scored.length) : null, selfAttested: validations.filter((v) => v.validator.toLowerCase() === ownerLc).length },
    endorsements: { total: endorsements.length, live: liveEndorsements.length, revoked: endorsements.length - liveEndorsements.length, paymentBacked: liveEndorsements.filter((e) => e.evidenceJobId > 0).length },
    disputes: { total: cases.length, open: cases.filter((c) => c.closed === 0).length, lostByAgent: cases.filter((c) => c.closed === 1 && (c.result ?? 0) >= 5000).length },
    memory,
    tokensLaunched: tokens.length,
    referralsMade: referred.c,
    commonsContributions: commonsTotal,
    uptime,
    /** the one eth_call that bounds every headline number before a claim is read */
    verify: {
      method: "eth_call",
      address: ctx.cfg.registry,
      call: "getAgent(uint256) → (owner,name,endpoint,metadataURI,pricePerJob,bond,registeredAt,retiredAt,status,jobsCompleted,jobsFailed,ratingCount,ratingSum)",
      args: [row.id],
      note: "jobsCompleted, jobsFailed, ratingCount, ratingSum and bond are counters AgentRegistry keeps itself. No claim in record[] may exceed them, and a record may not state FEWER failures than the registry counts — one call catches inflation in both directions without reading a single claim. The counters are proven and, on their own, cheap to inflate: read summary.armsLength beside them.",
    },
  };

  const issuedAt = now;
  const expiresAt = now + CV_VALIDITY_S;
  const identity = ctx.address("identity8004");
  const cvUri = `${base}/api/cv/${row.id}/credential.json`;

  const doc: Record<string, unknown> = {
    "@context": ["https://www.w3.org/ns/credentials/v2", CV_CONTEXT],
    type: ["VerifiableCredential", CV_TYPE],
    id: cvUri,
    issuer: `did:pkh:eip155:${CHAIN.chainId}:${ctx.signer.address}`,
    validFrom: new Date(issuedAt * 1000).toISOString(),
    validUntil: new Date(expiresAt * 1000).toISOString(),
    name: `${row.name} — Ferminux AI-CV`,
    description: `Verifiable working record of Ferminux agent #${row.id} (${row.name}) on chain ${CHAIN.chainId}. Every claim in credentialSubject.record carries the transaction or the route that produced it; the chain claims verify against any public RPC for ${CHAIN.rpc} without contacting Ferminux.`,
    credentialSubject: {
      id: `did:pkh:eip155:${CHAIN.chainId}:${owner}`,
      type: "AutonomousAgent",
      name: row.name,
      agent: {
        chainId: CHAIN.chainId,
        caip2: `eip155:${CHAIN.chainId}`,
        agentId: row.id,
        agentRegistry: ctx.cfg.registry,
        identityRegistry: identity ?? null,
        caip19: identity ? `eip155:${CHAIN.chainId}/erc721:${identity}/${row.id}` : null,
        controller: `did:pkh:eip155:${CHAIN.chainId}:${owner}`,
        slug,
        registeredAt: row.registeredAt,
        endpoint: row.endpoint,
        status: AgentStatusName[row.status] ?? "None",
        identityKey: "agent.agentId — two agents owned by the same address share credentialSubject.id, so agentId (not the did:pkh) is the unique identity",
        nameCollisions: (() => {
          const all = slugCollisions(db, slug);
          return {
            count: all.length,
            agents: all.map((a) => ({ agentId: a.id, owner: a.owner, status: AgentStatusName[a.status] ?? "None" })),
            note: all.length > 1
              ? `${all.length} registered agents share the name slug "${slug}". AgentRegistry does not make names unique and charges nothing for one, so a name is never identity — read agentId and owner.`
              : "no other registered agent shares this name slug today; names are still not unique on chain, so read agentId and owner",
          };
        })(),
      },
      summary,
      record: claims,
      recordMeta: {
        count: claims.length,
        limit,
        complete: omitted.size === 0,
        omitted: [...omitted.entries()].map(([type, o]) => ({ type, count: o.count, reason: o.reason })),
        omittedNote: "a CV MUST declare what it left out, by type and count, so selective disclosure is visible rather than silent",
        // `complete` is only a meaningful word if it has a scope. A chain scan
        // of the subject's address turns up transactions this record does not
        // cite — it funds its own x402 balance, it withdraws — and calling the
        // record complete while those exist was not true. So the scope is
        // written down, both sides of every counterparty relationship are in it,
        // and what is deliberately outside is named rather than missing.
        scope: {
          covers: [
            "work done and paid for: escrow jobs, x402 receipts, streams and subscription plans, both as payee and as payer",
            "what counterparties said: FRC-8004 feedback and validations, endorsements, disputes",
            "identity and state: registration, live registry state, slashes, token launches, memory anchors",
          ],
          excludes: [
            {
              what: "the subject funding or draining its own accounts (X402Vault deposits and withdrawals, faucet claims, gas)",
              why: "moving your own money between your own accounts is not work and proves nothing about it. Every one of those transactions is public — read the address on the explorer.",
            },
            { what: "transactions by other addresses the same operator may control", why: "nothing on chain links them, and this index does not guess" },
          ],
        },
        completenessNote:
          "every claim above verifies without Ferminux; that nothing was omitted WITHIN THE SCOPE ABOVE is attested by this gateway, and you can always re-scan the chain yourself. This document is not 'fully trustless' and does not claim to be.",
        full: `${base}/api/agents/${row.id}/audit.jsonl`,
      },
      counts: {
        proven: claims.filter((c) => c.evidence.proven).length,
        asserted: claims.filter((c) => !c.evidence.proven).length,
        byTrust: { chain: claims.filter((c) => c.evidence.trust === "chain").length, gateway: claims.filter((c) => c.evidence.trust === "gateway").length, selfAttested: claims.filter((c) => c.evidence.trust === "selfAttested").length },
      },
    },
    evidence: [
      {
        id: `${base}/api/agents/${row.id}/audit.jsonl`,
        type: ["FerminuxChainAnchor"],
        chainId: CHAIN.chainId,
        asOfBlock,
        asOfBlockHash: null,
        asOfBlockHashNote: "this index tracks block numbers, not hashes; read the hash for asOfBlock from any RPC if you want to pin the fork",
        contracts: {
          agentRegistry: ctx.cfg.registry,
          serviceEscrow: ctx.cfg.escrow,
          x402Vault: ctx.address("x402Vault") ?? null,
          streamPay: ctx.address("streamPay") ?? null,
          arbiterPool: ctx.address("arbiterPool") ?? null,
          identityRegistry: identity ?? null,
          reputationRegistry: ctx.address("reputation8004") ?? null,
          validationRegistry: ctx.address("validation8004") ?? null,
          tokenFactory: ctx.address("tokenFactory") ?? null,
          memoryAnchor: ctx.address("memoryAnchor") ?? null,
          endorsements: ctx.address("endorsements") ?? null,
          treasury: FIXED_CONTRACTS.treasury,
        },
        rpc: [CHAIN.rpc],
        explorer: CHAIN.explorer,
        gatewayAttestation: {
          signer: `did:pkh:eip155:${CHAIN.chainId}:${ctx.signer.address}`,
          signerEphemeral: ctx.signerEphemeral,
          claimsRoot,
          claims: claims.length,
          note: "optional. It attests that this index assembled these claims at this block — completeness of the off-chain half only. Every chain-trust claim above verifies without it.",
        },
      },
    ],
    credentialStatus: identity
      ? {
          id: `${cvUri}#status`,
          type: "FerminuxRegistryPointer2026",
          chainId: CHAIN.chainId,
          identityRegistry: identity,
          agentId: row.id,
          metadataKey: "cv",
          statusPurpose: "supersession",
          check: 'eth_call IdentityRegistry8004.getMetadata(agentId, "cv") → abi.decode(bytes32 documentHash, string uri). Current when documentHash equals proof.eip712.message.documentHash; superseded when it differs; unanchored when empty.',
        }
      : null,
    credentialSchema: { id: CV_SCHEMA, type: "JsonSchema" },
    refreshService: { id: `${base}/api/cv/${row.id}`, type: "FerminuxCvRefresh" },
    links: cvLinks(base, row.id, slug),
  };

  // documentHash covers the whole document except `proof` and `documentHash` itself.
  // Nothing else may be added to the response afterwards, or the hash a reader
  // recomputes would not be the hash that was signed — which is why the routes add
  // only `proof` and why every link already lives inside `links`.
  doc.claimsRoot = claimsRoot;
  doc.issuedAt = issuedAt;
  doc.expiresAt = expiresAt;
  doc.asOfBlock = asOfBlock;
  doc.hashing = {
    canonicalization: "RFC 8785 JCS (JSON.stringify of recursively key-sorted objects, no whitespace, arrays in order, undefined dropped)",
    leaf: "keccak256(utf8(JCS(claim without `leaf`)))",
    claimsRoot: "pairwise keccak256(concat(left, right)) bottom-up; an odd node is paired with itself",
    documentHash: "keccak256(utf8(JCS(document without `proof` and without `documentHash`)))",
    note: "this is the audit-export construction (v3/audit.ts), NOT the domain-tagged tree MemoryAnchor uses on chain. Memory proofs at /api/memory/proof/:agentId/:seq use the tagged one; never mix them.",
    limitNote: "?limit= changes which claims are in record[], so it changes claimsRoot and documentHash. Verify the bytes you were given.",
  };
  const documentHash = keccak256(toUtf8Bytes(canonicalJson(doc)));
  doc.documentHash = documentHash;

  return { doc, claims, claimsRoot, documentHash, agent: row, summary, asOfBlock };
}

export function cvLinks(base: string, id: number, slug: string) {
  return {
    document: `${base}/api/cv/${id}`,
    credential: `${base}/api/cv/${id}/credential.json`,
    verify: `${base}/api/cv/${id}/verify`,
    badge: `${base}/api/cv/${id}/badge.svg`,
    bySlug: `${base}/api/cv/${slug}`,
    audit: `${base}/api/agents/${id}/audit.jsonl`,
    memoryAnchors: `${base}/api/memory/anchors?agentId=${id}`,
    network: `${base}/api/network?agentId=${id}`,
    similar: `${base}/api/network/similar/${id}`,
  };
}

/** The 11-field struct the proof signs. Signing a root, not the whole document, is what makes selective disclosure free. */
export function cvTypedData(ctx: V3Context, built: BuiltCv) {
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");
  const doc = built.doc as { issuedAt: number; expiresAt: number };
  const verifyingContract = ctx.address("identity8004") ?? ctx.cfg.registry;
  const domain = { name: CV_DOMAIN_NAME, version: CV_VERSION, chainId: CHAIN.chainId, verifyingContract };
  const types = {
    AgentCV: [
      { name: "chainId", type: "uint256" },
      { name: "registry", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "subject", type: "address" },
      { name: "claimsRoot", type: "bytes32" },
      { name: "documentHash", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "asOfBlock", type: "uint64" },
      { name: "asOfBlockHash", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
  };
  const message = {
    chainId: CHAIN.chainId,
    registry: ctx.cfg.registry,
    agentId: built.agent.id,
    subject: getAddress(built.agent.owner),
    claimsRoot: built.claimsRoot,
    documentHash: built.documentHash,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    asOfBlock: built.asOfBlock,
    asOfBlockHash: ZERO_HASH,
    uri: `${base}/api/cv/${built.agent.id}/credential.json`,
  };
  return { domain, types, primaryType: "AgentCV" as const, message, digest: TypedDataEncoder.hash(domain, types, message) };
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function fmx(wei: string): string {
  let v: bigint;
  try {
    v = BigInt(wei || "0");
  } catch {
    return "0";
  }
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n) / 10n ** 16n; // 2 dp
  if (whole >= 1000n) return `${whole.toString()}`;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0")}`;
}

/**
 * The badge. No JS, no webfont, no external reference — GitHub's camo proxy
 * strips all three — and a short max-age, because a badge showing better
 * numbers than the record is a small lie with a large blast radius.
 */
export function badgeSvg(row: AgentRow, built: BuiltCv, opts: { theme: "light" | "dark"; style: "flat" | "card"; metric: string; base: string; builtAt: number }): string {
  const s = built.summary as Record<string, unknown>;
  const al = (s.armsLength ?? {}) as { paidJobsCompleted?: number; zeroValueJobs?: number; distinctPayers?: number };
  const paidJobs = al.paidJobsCompleted ?? 0;
  const payers = al.distinctPayers ?? 0;
  const ratingCount = Number(s.ratingCount ?? 0);

  // NO NUMBER WITHOUT ITS QUALIFIER. A badge is the one surface that travels
  // without the document, so "5.0★" with a sample size of one, and "earned"
  // meaning whichever half of the income the author felt like, are exactly the
  // small lies with the large blast radius this badge exists to avoid.
  const rating = (s.ratingAvg as number | null) !== null ? `${(s.ratingAvg as number).toFixed(1)}★ (${ratingCount})` : "unrated";
  const jobs = `${paidJobs} paid job${paidJobs === 1 ? "" : "s"}`;
  const earnedWei = (() => {
    try {
      return (BigInt(String(s.escrowEarnedWei ?? "0")) + BigInt(String(s.x402EarnedWei ?? "0"))).toString();
    } catch {
      return "0";
    }
  })();
  const earned = `${fmx(earnedWei)} FMX net`;
  const headline = opts.metric === "earned" ? earned : opts.metric === "rating" ? rating : jobs;
  const status = AgentStatusName[row.status] ?? "None";
  const bg = opts.theme === "dark" ? "#14161a" : "#ffffff";
  const fg = opts.theme === "dark" ? "#e9eaec" : "#14161a";
  const muted = opts.theme === "dark" ? "#9aa0a6" : "#6b7280";
  const line = opts.theme === "dark" ? "#2a2e35" : "#e3e3e0";
  const accent = status === "Active" ? "#0b8f57" : "#6b7280";
  const font = "-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif";
  const title = `Ferminux record: ${row.name} #${row.id} (${status}) — ${paidJobs} paid job(s) from ${payers} payer(s), ${earned}, ${rating}. Built ${new Date(opts.builtAt * 1000).toISOString()} at block ${built.asOfBlock}. Verify: ${opts.base}/api/cv/${row.id}/verify`;
  const name = xmlEscape(row.name.length > 22 ? `${row.name.slice(0, 21)}…` : row.name);

  if (opts.style === "card") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90" viewBox="0 0 320 90" role="img" aria-label="${xmlEscape(title)}">
<title>${xmlEscape(title)}</title>
<rect x="0.5" y="0.5" width="319" height="89" rx="6" fill="${bg}" stroke="${line}"/>
<rect x="0.5" y="0.5" width="3" height="89" rx="1.5" fill="${accent}"/>
<text x="16" y="26" font-family="${font}" font-size="13" font-weight="600" fill="${fg}">${name} <tspan fill="${muted}" font-weight="400">#${row.id}${status === "Active" ? "" : ` · ${xmlEscape(status.toUpperCase())}`}</tspan></text>
<text x="16" y="50" font-family="${font}" font-size="11" fill="${muted}">FERMINUX RECORD · CHAIN ${CHAIN.chainId} · ${payers} PAYER${payers === 1 ? "" : "S"}</text>
<text x="16" y="72" font-family="${font}" font-size="12" fill="${fg}" font-variant-numeric="tabular-nums">${xmlEscape(jobs)} · ${xmlEscape(rating)} · ${xmlEscape(earned)}</text>
</svg>`;
  }

  const label = "Ferminux";
  const value = `${name}${status === "Active" ? "" : ` (${status})`} · ${headline}`;
  const labelW = 8 + label.length * 6.6;
  const valueW = 12 + value.length * 6.4;
  const w = Math.round(labelW + valueW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img" aria-label="${xmlEscape(title)}">
<title>${xmlEscape(title)}</title>
<rect x="0.5" y="0.5" width="${w - 1}" height="19" rx="6" fill="${bg}" stroke="${line}"/>
<path d="M${Math.round(labelW)} 0.5 h${Math.round(valueW) - 7} a6 6 0 0 1 6 6 v7 a6 6 0 0 1 -6 6 h-${Math.round(valueW) - 7} z" fill="${accent}"/>
<text x="${Math.round(labelW / 2)}" y="14" text-anchor="middle" font-family="${font}" font-size="11" fill="${fg}">${label}</text>
<text x="${Math.round(labelW + valueW / 2)}" y="14" text-anchor="middle" font-family="${font}" font-size="11" fill="#ffffff" font-variant-numeric="tabular-nums">${xmlEscape(value)}</text>
</svg>`;
}

/** The recipe a stranger follows. Every step names the call and what must hold. */
export function cvVerifyDoc(ctx: V3Context, built: BuiltCv, typed: ReturnType<typeof cvTypedData>) {
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");
  const row = built.agent;
  const escrow = ctx.cfg.escrow;
  const al = (built.summary.armsLength ?? {}) as { paidJobsCompleted?: number; zeroValueJobs?: number; distinctPayers?: number };
  const arms = {
    paidJobsCompleted: al.paidJobsCompleted ?? 0,
    settled: (al.paidJobsCompleted ?? 0) + (al.zeroValueJobs ?? 0),
    payers: al.distinctPayers ?? 0,
  };
  return {
    v: 1,
    agentId: row.id,
    subject: getAddress(row.owner),
    chainId: CHAIN.chainId,
    rpc: [CHAIN.rpc],
    explorer: CHAIN.explorer,
    credential: `${base}/api/cv/${row.id}/credential.json`,
    claimsRoot: built.claimsRoot,
    documentHash: built.documentHash,
    asOfBlock: built.asOfBlock,
    signer: ctx.signer.address,
    signerEphemeral: ctx.signerEphemeral,
    eip712: { domain: typed.domain, primaryType: typed.primaryType, types: typed.types, message: typed.message, digest: typed.digest },
    hashing: (built.doc as { hashing: unknown }).hashing,
    steps: [
      { n: 1, name: "shape", do: "check @context[0] is the W3C VC 2.0 context, type contains FerminuxAgentCV, and validFrom <= now < validUntil", fails: "an expired document is historically valid and currently stale — rebuild it from refreshService" },
      { n: 2, name: "documentHash", do: "strip `proof` and `documentHash`, JCS-canonicalize the rest, keccak256", must: "equals the document's own `documentHash` and proof.eip712.message.documentHash" },
      { n: 3, name: "claimsRoot", do: "for each claim strip `leaf`, JCS, keccak256 → must equal that claim's stated leaf; fold all leaves pairwise (odd node pairs with itself)", must: "equals proof.eip712.message.claimsRoot" },
      {
        n: 4,
        name: "signature",
        do: "rebuild the EIP-712 digest from proof.eip712.{domain,types,message} and ecrecover proof.proofValue",
        must: `recovers either AgentRegistry.getAgent(${row.id}).owner (self-issued) or an index key you pinned in advance — this gateway signs with ${ctx.signer.address}, and @ferminux/agent ships that address in NETWORKS[${CHAIN.chainId}].cvIssuers`,
        note: `DO NOT learn the issuer key from ${base}: an issuer that hands you its own public key proves nothing, because an impostor would hand you its own too. Pin it, or use ?signer=owner and have the agent sign its own CV. Either way this step proves who assembled the document and nothing about any claim — that is steps 6 and 7.`,
      },
      {
        n: 5,
        name: "aggregate cross-check",
        do: `eth_call AgentRegistry.getAgent(${row.id}) at ${ctx.cfg.registry}`,
        must: "summary.jobsCompleted / ratingCount / ratingSum must not EXCEED the contract's counters; summary.jobsFailed must not be LESS than the contract's (a record may not understate its failures); and the number of claims whose outcome is Completed or Resolved must not exceed jobsCompleted",
        note: "one call catches inflation before a single claim is read. It is checked in both directions: understating bad news is a lie too.",
      },
      {
        n: 6,
        name: "pin the contracts",
        do: "resolve every evidence.address and every bind.call.address against YOUR OWN list of Ferminux contract addresses (below, or NETWORKS[3961] in @ferminux/agent) before checking anything",
        must: "a claim may only cite these addresses; reject any claim naming a contract you do not recognise",
        note: "this is the step whose absence was a total break. A forged CV deployed its own contract, emitted a log carrying the genuine JobCompleted topic0, pointed bind.call.address at it, and every bind resolved — 58,500 FMX of earnings that never existed, verified clean. The attacker may never choose the contract that answers for the claim.",
      },
      {
        n: 7,
        name: "per claim",
        do: "for every claim whose evidence.trust is `chain`: eth_getTransactionReceipt(evidence.tx), check status == 1, find the log by evidence.blockLogIndex (the RPC's block-scoped logs[].logIndex), assert its address == evidence.address and topics[0] == keccak256(evidence.event), decode it with YOUR OWN ABI keyed by topic0, then compare EVERY field the claim states against the field the log carries — payout, fee, rating, amount, nonce, price, bond, not just the identifiers",
        must: "the claim ties to this subject (log agentId/payee/payer, or ServiceEscrow.getJob(jobId).agentId) AND every stated value equals the logged value",
        note: "`proven: true` is a claim-level word covering claim-level fields. A bind set of {jobId, agentId} left agentPayout, fee and rating unchecked inside the very log the claim cited, so a 100x payout and a fabricated five-star rating passed. Compare all of it, or mark the field asserted.",
      },
      {
        n: 8,
        name: "mutable state",
        do: `for the AgentState claim there is no transaction: eth_call AgentRegistry.getAgent(${row.id}) and compare endpoint, status, pricePerJob and bond`,
        must: "equal — a difference means the document is stale or forged, and both answers are 'do not use this endpoint'",
        note: "endpoint, price, bond and status have no event carrying their current value and the owner rewrites them at will, with no history. They are never proved by the registration log.",
      },
      { n: 9, name: "trust floor", do: "drop every claim below your floor: `chain` re-derives from 3961, `gateway` is a row in the Ferminux index, `selfAttested` is what the operator typed", must: "a CV read at the `chain` floor is still a complete economic record" },
      { n: 10, name: "supersession", do: ctx.address("identity8004") ? `eth_call IdentityRegistry8004.getMetadata(${row.id}, "cv") at ${ctx.address("identity8004")} → abi.decode(bytes32 documentHash, string uri)` : "IdentityRegistry8004 is not configured on this gateway; skip", must: "equal to documentHash → current; different → superseded; empty → never anchored (accept the claims, treat summary as self-asserted)", note: `anchor yours with \`ferminux cv-anchor ${row.id}\` — until an agent writes that key, a stale signed CV of its keeps verifying clean forever` },
      { n: 11, name: "completeness", do: "read credentialSubject.recordMeta.omitted and recordMeta.scope", must: "nothing omitted, and the scope is one you accept", note: "a dishonest issuer can lie here. Completeness is attested, not proved — re-scan the logs yourself if it matters" },
    ],
    contracts: {
      note: "PIN THESE. Step 6 resolves every address a claim cites against this list, and a verifier that takes the list from the document it is checking is not verifying anything. @ferminux/agent ships the same addresses in NETWORKS[3961].",
      agentRegistry: ctx.cfg.registry,
      serviceEscrow: escrow,
      x402Vault: ctx.address("x402Vault") ?? null,
      streamPay: ctx.address("streamPay") ?? null,
      arbiterPool: ctx.address("arbiterPool") ?? null,
      identityRegistry: ctx.address("identity8004") ?? null,
      reputationRegistry: ctx.address("reputation8004") ?? null,
      validationRegistry: ctx.address("validation8004") ?? null,
      tokenFactory: ctx.address("tokenFactory") ?? null,
      memoryAnchor: ctx.address("memoryAnchor") ?? null,
      endorsements: ctx.address("endorsements") ?? null,
    },
    trustBoundary: {
      chainProves: [
        "jobs, amounts, fees, payouts and ratings (ServiceEscrow) — every field, compared to the log, not just the job id",
        "registration: the id, the owner and the values AS REGISTERED (AgentRegistry)",
        "the registry's own counters, and the live endpoint / status / price / bond by eth_call at read time (AgentState)",
        "x402 settlements, gross and net (X402Vault)",
        "streams and subscription plans, both as payee and as payer (StreamPay)",
        "FRC-8004 feedback entries and validation responses",
        "disputes and their clientBps outcome (ArbiterPool)",
        "memory anchors (MemoryAnchor)",
        "endorsements (Endorsements)",
        "token launches (AgentTokenFactory, FRC-20)",
      ],
      gatewayAsserts: [
        "uptime and probe latency — observed by this gateway's probe and re-derivable by nobody",
        "Commons contributions — signed rows in this index, covered by the audit export's merkle root",
        "that nothing was omitted from record[] within recordMeta.scope",
      ],
      operatorDeclares: ["name, description, capabilities, model, pricePerCall — strings the operator typed into the agent card, never tested against the live endpoint"],
      neverProved: [
        "that an unrated completion was good work: ServiceEscrow records 0 for a job the client never reviewed, and null is not zero stars",
        `that a registry counter was expensive to earn: requestJob accepts msg.value = 0, so jobsCompleted and ratingSum are cheap to inflate. This record says how many of them moved FMX: summary.armsLength.paidJobsCompleted = ${arms.paidJobsCompleted} of ${arms.settled}, from ${arms.payers} distinct payer(s)`,
        "that a client was at arms length: ServiceEscrow blocks only the agent's own owner from hiring it, so a second address the same operator controls is a valid client. distinctPayers counts addresses, not people",
        "that a validation was independent: ValidationRegistry8004 lets an owner name any validator, so check who the validator is before trusting a score",
        "that an FRC-8004 feedback author ever paid this agent — the CV marks each entry paymentBacked or not",
        "that this agent can do what its card says: capabilities are declared and never tested",
        "that the name is anyone's: AgentRegistry does not make names unique and charges nothing for one — read agentId and owner, never the name",
      ],
    },
    commands: [
      `curl -s ${base}/api/cv/${row.id}/credential.json | jq '.credentialSubject.summary'`,
      `cast call ${ctx.cfg.registry} "getAgent(uint256)" ${row.id} --rpc-url ${CHAIN.rpc}`,
      ...(built.claims.find((c) => c.evidence.trust === "chain" && c.evidence.tx) ? [`cast receipt ${built.claims.find((c) => c.evidence.trust === "chain" && c.evidence.tx)!.evidence.tx} --rpc-url ${CHAIN.rpc}`] : []),
      `cast call ${escrow} "getJob(uint256)" <jobId> --rpc-url ${CHAIN.rpc}`,
    ],
    portability:
      "chainId + the contract addresses above + any RPC for chain 3961 is everything a verifier needs. Serve a copy of this credential from your own host and it verifies on identical terms — Ferminux is an index, not the trust root.",
  };
}

export function registerCvRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  const base = ctx.cfg.publicUrl.replace(/\/+$/, "");

  function resolve(idOrSlug: string): AgentRow {
    return resolveAgentSlug(db, idOrSlug);
  }

  // A CV is assembled per request from a dozen tables; cache it for 30 s and cap
  // the rate so a public, unauthenticated read cannot be turned into a cheap DoS.
  const rl = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const rlBadge = { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } };

  app.get<{ Params: { agent: string }; Querystring: { limit?: string } }>("/api/cv/:agent", rl, async (req, reply) => {
    try {
      const row = resolve(req.params.agent);
      const built = buildCv(ctx, row, { limit: req.query.limit ? commons.parseLimit(req.query.limit, CV_DEFAULT_CLAIMS, CV_MAX_CLAIMS) : undefined });
      reply.header("cache-control", `public, max-age=${CV_CACHE_S}`);
      reply.header("x-ferminux-claims-root", built.claimsRoot);
      reply.header("x-ferminux-document-hash", built.documentHash);
      return built.doc;
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get<{ Params: { agent: string }; Querystring: { limit?: string; signer?: string } }>("/api/cv/:agent/credential.json", rl, async (req, reply) => {
    try {
      const row = resolve(req.params.agent);
      const built = buildCv(ctx, row, { limit: req.query.limit ? commons.parseLimit(req.query.limit, CV_DEFAULT_CLAIMS, CV_MAX_CLAIMS) : undefined });
      const typed = cvTypedData(ctx, built);
      const wantOwner = req.query.signer === "owner";
      if (req.query.signer !== undefined && req.query.signer !== "owner" && req.query.signer !== "gateway") {
        throw new HttpError(400, "signer must be gateway (default) or owner");
      }
      const proof: Record<string, unknown> = {
        type: "DataIntegrityProof",
        cryptosuite: CV_CRYPTOSUITE,
        created: new Date(ctx.nowS() * 1000).toISOString(),
        proofPurpose: "assertionMethod",
        cryptosuiteNote:
          "eip712-jcs-2026 is not a registered Data Integrity cryptosuite and proofValue carries 0x-hex rather than multibase, so a generic VC verifier will refuse this proof. That is the price of the signer being an on-chain identity; the verification algorithm is reproducible from this document alone — see the `verify` link.",
        eip712: { domain: typed.domain, primaryType: typed.primaryType, types: typed.types, message: typed.message },
        digest: typed.digest,
      };
      if (wantOwner) {
        proof.verificationMethod = `did:pkh:eip155:${CHAIN.chainId}:${getAddress(row.owner)}#blockchainAccountId`;
        proof.proofValue = null;
        proof.sign =
          "unsigned: sign `digest` (or signTypedData over eip712.{domain,types,message}) with the key AgentRegistry.getAgent(agentId).owner returns, then publish this document anywhere. A verifier's authority step recovers that key from the registry, so a CV signed by the owner needs no Ferminux endpoint at all.";
      } else {
        proof.verificationMethod = `did:pkh:eip155:${CHAIN.chainId}:${ctx.signer.address}#blockchainAccountId`;
        proof.proofValue = await ctx.signer.signTypedData(typed.domain, typed.types, typed.message);
        proof.attests =
          "that this index assembled these claims for this agent at this block — the completeness of the off-chain half. Every chain-trust claim verifies without this signature.";
        proof.signerEphemeral = ctx.signerEphemeral;
      }
      reply.header("cache-control", `public, max-age=${CV_CACHE_S}`);
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("x-ferminux-signer", ctx.signer.address);
      reply.header("x-ferminux-claims-root", built.claimsRoot);
      reply.header("x-ferminux-document-hash", built.documentHash);
      return { ...built.doc, proof: [proof] };
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get<{ Params: { agent: string } }>("/api/cv/:agent/verify", rl, async (req, reply) => {
    try {
      const row = resolve(req.params.agent);
      const built = buildCv(ctx, row);
      reply.header("cache-control", `public, max-age=${CV_CACHE_S}`);
      return cvVerifyDoc(ctx, built, cvTypedData(ctx, built));
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get<{ Params: { agent: string }; Querystring: { theme?: string; style?: string; metric?: string } }>("/api/cv/:agent/badge.svg", rlBadge, async (req, reply) => {
    try {
      const row = resolve(req.params.agent);
      const built = buildCv(ctx, row, { limit: 1 });
      const theme = req.query.theme === "dark" ? "dark" : "light";
      const style = req.query.style === "card" ? "card" : "flat";
      const metric = req.query.metric ?? "jobs";
      if (!["jobs", "earned", "rating"].includes(metric)) {
        throw new HttpError(400, `metric must be jobs, earned or rating (got "${metric}") — an unrecognised metric is refused rather than silently answered with a different number`);
      }
      const svg = badgeSvg(row, built, { theme, style, metric, base, builtAt: ctx.nowS() });
      reply.header("content-type", "image/svg+xml; charset=utf-8");
      reply.header("cache-control", `public, max-age=${BADGE_CACHE_S}`);
      reply.header("x-content-type-options", "nosniff");
      return reply.send(svg);
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });
}
