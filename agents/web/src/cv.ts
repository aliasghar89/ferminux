// The record — data layer for /cv/ and /network/.
//
// Prefers the gateway's own routes (GET /api/cv/:agent, /api/cv/:agent/credential.json,
// /api/cv/:agent/badge.svg, GET /api/network). Every one of them is optional: when a route
// answers 404 this module assembles the same document out of the routes that have always been
// there — GET /api/agents/:id, /api/agents/:id/jobs and the signed /api/agents/:id/audit.jsonl —
// plus direct contract reads. Whatever it could not read is pushed onto `notes` and rendered on
// the page, never swallowed.
//
// The rule both pages enforce: every figure carries the source it came from (see `Provenance` in
// types.ts). A number the page cannot attribute does not render.
import { api, agentStatusName, jobStatusName } from "./api";
import { economy, slugify } from "./economy";
import { config, identity8004Deployed, reputation8004Deployed } from "./config";
import { toSec } from "./format";
import { IDENTITY_8004_ABI, REPUTATION_8004_ABI } from "./abi";
import { contractRead } from "./wallet";
import type {
  AgentView, CvAnchor, CvClientRow, CvContribution, CvDoc, CvEndorsement, CvEvidence, CvSkill, CvValidation, CvWorkRow, CvX402,
  Env, JobView, NetEdge, NetKind, NetNode, NetView, Provenance,
} from "./types";

const MOCK = import.meta.env.VITE_MOCK === "1";
type MockCv = typeof import("./mockCv");
let mockMod: Promise<MockCv> | null = null;
const mock = () => (mockMod ||= import("./mockCv"));

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (s: string | null | undefined) => (s || "").toLowerCase();

/* ------------------------------------------------------------------ envelopes */

export const env = <T>(value: T, provenance: Provenance, source: string, proof?: Env<T>["proof"]): Env<T> =>
  ({ value, provenance, source, proof: proof ?? null });

export const PROVENANCE_TEXT: Record<Provenance, string> = {
  chain: "Indexed from an event on chain 3961. Re-derivable from any RPC without this gateway.",
  signed: "Off chain, but carries a signature — the audit merkle root, a Commons write or an x402 voucher.",
  observed: "Only this gateway saw it. A stranger cannot re-derive this one.",
  declared: "The agent asserts it in its own card. Nobody checks it.",
};

/* ------------------------------------------------------------------ audit.jsonl */

export interface AuditLine { seq?: number; kind?: string; ts?: number | null; block?: number; contract?: string; event?: string; type?: string; tx?: string; logIndex?: number; args?: Record<string, string | boolean>; actor?: string; ref?: { kind: string; id: string | number }; data?: Record<string, unknown>; [k: string]: unknown }
export interface AuditFooter { merkleRoot?: string; leaves?: number; signer?: string; signerEphemeral?: boolean; generatedAt?: number; owner?: string; agentId?: number }

/** One request returns the agent's whole record: chain events, Commons writes, x402 settlements, and a signed merkle root. */
export async function fetchAudit(agentId: number, limit = 1000): Promise<{ lines: AuditLine[]; footer: AuditFooter | null }> {
  if (MOCK) return (await mock()).audit(agentId);
  const r = await fetch(`${config.gateway}/agents/${agentId}/audit.jsonl?limit=${limit}`, { headers: { accept: "application/x-ndjson" } });
  if (!r.ok) throw Object.assign(new Error(`audit.jsonl ${r.status}`), { status: r.status });
  const text = await r.text();
  const lines: AuditLine[] = []; let footer: AuditFooter | null = null;
  for (const raw of text.split("\n")) {
    const s = raw.trim(); if (!s) continue;
    let o: AuditLine; try { o = JSON.parse(s) as AuditLine; } catch { continue; }
    if (o.merkleRoot !== undefined) footer = o as AuditFooter; else lines.push(o);
  }
  return { lines, footer };
}

/* ------------------------------------------------------------------ resolve ?agent= */

/** `?agent=` accepts an id or a name/slug. Names are not unique on chain: prefer active, then the lowest id. */
export async function resolveAgent(param: string): Promise<AgentView> {
  const s = param.trim();
  if (/^\d+$/.test(s)) return api.agent(Number(s));
  const { items } = await api.agents({ q: s, limit: 50 });
  const want = slugify(s);
  const matches = items.filter((a) => slugify(a.name) === want);
  const pool = matches.length ? matches : items;
  if (!pool.length) throw Object.assign(new Error("Not found."), { status: 404 });
  pool.sort((a, b) => Number(agentStatusName(b.status) === "Active") - Number(agentStatusName(a.status) === "Active") || a.id - b.id);
  return api.agent(pool[0].id);
}

/* ------------------------------------------------------------------ the document */

export async function loadCv(param: string): Promise<CvDoc> {
  if (!MOCK) {
    // The gateway's own route wins when it is live — one call, one code path, no drift.
    try {
      const r = await fetch(`${config.gateway}/cv/${encodeURIComponent(param)}`, { headers: { accept: "application/json" } });
      if (r.ok) {
        // The gateway lane ships its own /api/cv; only take it when it carries the shape this page
        // renders, so a first cut of that route can never blank the page — it falls through instead.
        const j = (await r.json()) as Partial<CvDoc> & Record<string, unknown>;
        if (j && typeof j.agentId === "number" && j.identity && j.metrics && j.links
            && j.metrics.jobsCompleted && j.metrics.rating && j.metrics.earnedWei && j.metrics.x402) {
          return {
            work: [], clients: [], skills: [], declaredOnly: [], contributions: [], validations: [], endorsements: [],
            endorsersWithoutRecord: 0, notes: [], armsLength: { paidJobs: 0, zeroValueJobs: 0, payers: 0, ratedPaidJobs: 0 },
            ...j, assembledBy: "gateway",
          } as CvDoc;
        }
      }
    } catch { /* fall through to assembling it here */ }
  }
  const agent = MOCK ? await (await mock()).agentFor(param) : await resolveAgent(param);
  return assemble(agent);
}

async function assemble(a: AgentView): Promise<CvDoc> {
  const notes: string[] = [];
  const owner = a.owner;
  const slug = slugify(a.name);

  const [jobsR, auditR, headR, repR, feedbackR, anchorsR, tokenR] = await Promise.allSettled([
    api.agentJobs(a.id),
    fetchAudit(a.id),
    api.health(),
    economy.reputationSummary(a.id),
    readFeedback(a.id),
    readAnchors(a.id),
    economy.tokenOf(a.id).catch(() => null),
  ]);

  const jobs: JobView[] = jobsR.status === "fulfilled" ? jobsR.value.items : [];
  if (jobsR.status === "rejected") notes.push("The escrow job list could not be read from the gateway just now; the job table below is empty for that reason, not because there are no jobs.");
  const lines: AuditLine[] = auditR.status === "fulfilled" ? auditR.value.lines : [];
  const footer = auditR.status === "fulfilled" ? auditR.value.footer : null;
  if (auditR.status === "rejected") notes.push("The signed audit export (/api/agents/" + a.id + "/audit.jsonl) did not answer, so x402 settlements and Commons contributions are not shown.");
  const head = headR.status === "fulfilled" ? headR.value.head : null;

  /* ---- chain lines, bucketed ---- */
  const ev = (contract: string, event: string) => lines.filter((l) => l.kind === "chain" && l.contract === contract && l.event === event);
  const completed = ev("escrow", "JobCompleted");
  const resolved = ev("escrow", "JobResolved");
  const settled = ev("x402Vault", "Settled");
  const plans = ev("streamPay", "PlanCreated").filter((l) => lc(String(l.args?.payee)) === lc(owner));
  const streamsIn = ev("streamPay", "StreamOpened").filter((l) => lc(String(l.args?.payee)) === lc(owner));
  const vouchers = lines.filter((l) => l.kind === "x402" && l.event === "Voucher").length;
  const registration = ev("registry", "AgentRegistered")[0] ?? null;

  let earned = 0n;
  const payoutByJob = new Map<number, { payout: string; fee: string; rating: number | null; tx: string | null; ts: number | null }>();
  for (const l of completed) {
    const jobId = Number(l.args?.jobId ?? 0);
    const payout = BigInt(String(l.args?.agentPayout ?? "0"));
    earned += payout;
    const rating = Number(l.args?.rating ?? 0);
    payoutByJob.set(jobId, { payout: payout.toString(), fee: String(l.args?.fee ?? "0"), rating: rating > 0 ? rating : null, tx: l.tx ?? null, ts: l.ts ?? null });
  }
  for (const l of resolved) {
    const jobId = Number(l.args?.jobId ?? 0);
    const payout = BigInt(String(l.args?.agentAmount ?? l.args?.agentPayout ?? "0"));
    earned += payout;
    payoutByJob.set(jobId, { payout: payout.toString(), fee: String(l.args?.fee ?? "0"), rating: null, tx: l.tx ?? null, ts: l.ts ?? null });
  }

  let x402In = 0n, x402Out = 0n, x402InCount = 0, x402OutCount = 0;
  const x402Payers = new Set<string>();
  for (const l of settled) {
    const amt = BigInt(String(l.args?.amount ?? "0"));
    if (lc(String(l.args?.payee)) === lc(owner)) { x402In += amt; x402InCount++; if (amt > 0n) x402Payers.add(lc(String(l.args?.payer))); }
    else if (lc(String(l.args?.payer)) === lc(owner)) { x402Out += amt; x402OutCount++; }
  }
  const x402: CvX402 = {
    settlements: x402InCount, earnedWei: x402In.toString(), payments: x402OutCount, spentWei: x402Out.toString(), vouchers,
    resource: a.card?.pricePerCall && BigInt(a.card.pricePerCall) > 0n ? `${a.endpoint.replace(/\/$/, "")}/invoke` : null,
  };

  /* ---- work history ---- */
  const agentsByOwner = await ownerIndex(jobs.map((j) => j.client));
  const work: CvWorkRow[] = jobs.map((j): CvWorkRow => {
    const p = payoutByJob.get(Number(j.id));
    const created = toSec(j.createdAt); const delivered = toSec(j.deliveredAt);
    const known = agentsByOwner.get(lc(j.client)) ?? null;
    return {
      jobId: Number(j.id), client: j.client, clientAgentId: known?.id ?? null, clientName: known?.name ?? null,
      amountWei: String(j.amount ?? "0"), payoutWei: p?.payout ?? null, feeWei: p?.fee ?? null,
      rating: p?.rating ?? null, status: jobStatusName(j.status),
      createdAt: created, deliveredAt: delivered, closedAt: p?.ts ?? null,
      tx: { requested: j.tx?.requested ?? null, delivered: j.tx?.delivered ?? null, closed: j.tx?.closed ?? p?.tx ?? null },
      onTime: created !== null && delivered !== null ? delivered - created <= config.deliveryWindowSec : null,
    };
  }).sort((x, y) => y.jobId - x.jobId);

  const clients: CvClientRow[] = [];
  for (const w of work) {
    let row = clients.find((c) => lc(c.address) === lc(w.client));
    if (!row) { row = { address: w.client, agentId: w.clientAgentId, name: w.clientName, jobs: 0, paidWei: "0", ratings: [], firstAt: w.createdAt, lastAt: w.createdAt }; clients.push(row); }
    row.jobs++; row.paidWei = (BigInt(row.paidWei) + BigInt(w.amountWei)).toString();
    if (w.rating) row.ratings.push(w.rating);
    if (w.createdAt !== null) { row.firstAt = row.firstAt === null ? w.createdAt : Math.min(row.firstAt, w.createdAt); row.lastAt = row.lastAt === null ? w.createdAt : Math.max(row.lastAt, w.createdAt); }
  }
  clients.sort((x, y) => (BigInt(y.paidWei) > BigInt(x.paidWei) ? 1 : BigInt(y.paidWei) < BigInt(x.paidWei) ? -1 : 0));

  /* ---- Commons contributions (signed, not chain) ---- */
  const CONTRIB: Record<string, string> = {
    "kb.write": "Knowledge base", "tool.publish": "Tool published", "artifact.publish": "Artifact published",
    "thread.create": "Forum thread", "post.create": "Forum reply", "bounty.create": "Bounty posted",
    "arena.create": "Arena challenge", "arena.submit": "Arena entry", "bounty.claim": "Bounty claim",
  };
  const HREF: Record<string, (id: string) => string> = {
    kb: (id) => `/kb/?slug=${encodeURIComponent(id)}`, tool: (id) => `/tools/?id=${id}`, artifact: (id) => `/artifacts/?id=${id}`,
    thread: (id) => `/forum/?id=${id}`, bounty: (id) => `/bounties/?id=${id}`, challenge: (id) => `/arena/?id=${id}`,
  };
  const contributions: CvContribution[] = lines
    .filter((l) => l.kind === "commons" && typeof l.type === "string" && CONTRIB[l.type])
    .map((l): CvContribution => {
      const d = (l.data || {}) as Record<string, unknown>;
      const title = String(d.title ?? d.name ?? d.slug ?? l.ref?.id ?? "");
      const href = l.ref && HREF[l.ref.kind] ? HREF[l.ref.kind](String(l.ref.id)) : null;
      return { kind: CONTRIB[l.type as string], title, href, at: l.ts ?? null, provenance: "signed" };
    })
    .sort((x, y) => (y.at ?? 0) - (x.at ?? 0));

  /* ---- FRC-8004 validations and endorsements ---- */
  const validations: CvValidation[] = a.validation?.latest
    ? [{
        requestHash: a.validation.latest.requestHash, validator: a.validation.latest.validator, response: a.validation.latest.response,
        tag: a.validation.latest.tag, requestedAt: toSec(a.validation.latest.requestedAt), respondedAt: toSec(a.validation.latest.respondedAt),
        txRequest: a.validation.latest.txRequest, txResponse: a.validation.latest.txResponse,
      }]
    : [];
  const endorsements: CvEndorsement[] = feedbackR.status === "fulfilled" ? feedbackR.value : [];
  if (feedbackR.status === "rejected") notes.push("ReputationRegistry8004 did not answer, so endorsements are not listed.");
  const endorserRecord = await ownerIndex(endorsements.map((e) => e.from));
  for (const e of endorsements) {
    const k = endorserRecord.get(lc(e.from));
    e.fromAgentId = k?.id ?? null; e.fromName = k?.name ?? null;
    e.paymentBacked = clients.some((c) => lc(c.address) === lc(e.from));
  }
  const endorsersWithoutRecord = endorsements.filter((e) => !(endorserRecord.get(lc(e.from))?.jobsCompleted)).length;

  /* ---- skills with evidence ---- */
  const caps = a.card?.capabilities ?? [];
  const skills: CvSkill[] = caps.map((name) => {
    const evidence: CvEvidence[] = [];
    for (const v of validations) if (v.tag && slugify(v.tag) === slugify(name) && v.response !== null) evidence.push({ label: `validation ${v.response}/100`, provenance: "chain", tx: v.txResponse });
    for (const e of endorsements) if (e.capability && slugify(e.capability) === slugify(name)) evidence.push({ label: "endorsement", provenance: "chain", tx: e.tx });
    for (const l of lines) {
      const tags = (l.data as { tags?: string[] } | undefined)?.tags;
      if (l.kind === "commons" && Array.isArray(tags) && tags.some((t) => slugify(t) === slugify(name))) {
        evidence.push({ label: String(l.type).replace(".", " "), provenance: "signed", href: l.ref && HREF[l.ref.kind] ? HREF[l.ref.kind](String(l.ref.id)) : null });
      }
    }
    return { name, evidence: evidence.slice(0, 4) };
  });
  const declaredOnly = skills.filter((s) => !s.evidence.length).map((s) => s.name);

  /* ---- memory anchors ---- */
  const anchors: CvAnchor[] = anchorsR.status === "fulfilled" ? anchorsR.value : [];
  if (anchorsR.status === "rejected" || !identity8004Deployed) notes.push("IdentityRegistry8004 is not readable from here, so anchored memory roots could not be checked.");

  const token = tokenR.status === "fulfilled" && tokenR.value ? { symbol: tokenR.value.symbol, address: tokenR.value.token, priceWei: tokenR.value.priceWei ?? null } : null;

  const onTimeRows = work.filter((w) => w.onTime !== null);
  const rating = repR.status === "fulfilled" ? repR.value : { count: a.ratingCount, avg: a.ratingAvg };

  const disputes = work.filter((w) => w.status === "Disputed" || w.status === "Resolved").length;

  // WHAT COSTS SOMETHING, separated from what does not.
  //
  // ServiceEscrow.requestJob accepts msg.value = 0 and blocks only the agent's own owner from
  // being the client, so a second address the same operator controls can mint a completed job
  // and a five-star rating for the price of gas — roughly 0.00016 FMX, with no FMX moving at
  // all. We cannot change a deployed contract from here, so no count on this page renders
  // without the paid-job count and the payer count beside it.
  const settledWork = work.filter((w) => w.status === "Completed" || w.status === "Resolved");
  const paidWork = settledWork.filter((w) => {
    try { return BigInt(w.amountWei || "0") > 0n; } catch { return false; }
  });
  const armsLength = {
    paidJobs: paidWork.length,
    zeroValueJobs: settledWork.length - paidWork.length,
    payers: new Set([...paidWork.map((w) => lc(w.client)), ...x402Payers]).size,
    ratedPaidJobs: paidWork.filter((w) => !!w.rating).length,
  };

  const doc: CvDoc = {
    agentId: a.id, slug, canonical: `https://ferminux.net/cv/?agent=${a.id}`,
    builtAt: Math.floor(Date.now() / 1000), builtAtBlock: head, assembledBy: "browser",
    identity: {
      name: a.name, owner, endpoint: a.endpoint, metadataURI: a.metadataURI, status: agentStatusName(a.status),
      registeredAt: toSec(a.registeredAt), online: a.online ?? null, lastSeen: toSec(a.lastSeen),
      description: a.card?.description ?? null, model: a.card?.model ?? null, version: a.card?.version ?? null,
      contact: a.card?.contact ?? null, image: a.card?.image ?? null, capabilities: caps,
    },
    metrics: {
      jobsCompleted: env(Number(a.jobsCompleted ?? 0), "chain", "AgentRegistry.OutcomeRecorded — counted by the registry itself", { kind: "call", address: config.registry, call: `getAgent(${a.id}).jobsCompleted` }),
      jobsFailed: env(Number(a.jobsFailed ?? 0), "chain", "AgentRegistry.OutcomeRecorded", { kind: "call", address: config.registry, call: `getAgent(${a.id}).jobsFailed` }),
      earnedWei: env(earned.toString(), "chain", completed.length + resolved.length < Number(a.jobsCompleted ?? 0) ? `sum of ServiceEscrow.JobCompleted.agentPayout over the ${completed.length + resolved.length} settlements in the signed export — a floor, not the total` : "sum of ServiceEscrow.JobCompleted.agentPayout", { kind: "txs", count: completed.length, txs: completed.slice(0, 5).map((l) => l.tx || "").filter(Boolean) }),
      rating: env({ avg: a.ratingAvg, count: Number(a.ratingCount ?? 0) }, "chain", "ServiceEscrow.JobCompleted.rating, summed by AgentRegistry", { kind: "call", address: config.registry, call: `getAgent(${a.id}).ratingSum / ratingCount` }),
      pricePerJobWei: env(String(a.pricePerJob ?? "0"), "chain", "AgentRegistry.getAgent().pricePerJob", { kind: "call", address: config.registry, call: `getAgent(${a.id}).pricePerJob` }),
      pricePerCallWei: env(a.card?.pricePerCall ?? null, "declared", "pricePerCall in the agent's own card"),
      bondWei: env(String(a.bond ?? "0"), "chain", "AgentRegistry.BondChanged", { kind: "call", address: config.registry, call: `getAgent(${a.id}).bond` }),
      validations: env({ count: a.validation?.count ?? 0, avg: a.validation?.avgResponse ?? null }, "chain", "ValidationRegistry8004.ValidationResponse", { kind: "call", address: config.validation8004, call: `getSummary(${a.id}, [], "")` }),
      x402: env(x402, "chain", "X402Vault.Settled (vouchers themselves are signed, not on chain)", { kind: "txs", count: settled.length, txs: settled.slice(0, 5).map((l) => l.tx || "").filter(Boolean) }),
      disputes: env(disputes, "chain", "ServiceEscrow.JobDisputed / JobResolved"),
    },
    skills, declaredOnly, work, clients, contributions, validations, endorsements, endorsersWithoutRecord,
    memory: {
      anchors, anchored: anchors.length > 0,
      note: anchors.length
        ? "Values stay private; only hashes are anchored. Anyone can check a revealed value against the anchored root."
        : "Memory is private per-address key/value storage on the gateway. No root is anchored on chain for this agent, so nothing here is presented as a chain fact.",
    },
    coverage: { jobsSettled: completed.length + resolved.length, jobsCompleted: Number(a.jobsCompleted ?? 0), partial: completed.length + resolved.length < Number(a.jobsCompleted ?? 0) },
    armsLength,
    reliability: { online: a.online ?? null, lastSeen: toSec(a.lastSeen), onTime: onTimeRows.filter((w) => w.onTime).length, onTimeOf: onTimeRows.length, probeHistory: false },
    network: { plans: plans.length, streams: streamsIn.length, token, referrals: null },
    audit: {
      merkleRoot: footer?.merkleRoot ?? null, leaves: footer?.leaves ?? null, signer: footer?.signer ?? null,
      signerEphemeral: !!footer?.signerEphemeral, generatedAt: footer?.generatedAt ?? null,
      url: `${config.gateway}/agents/${a.id}/audit.jsonl`,
    },
    links: {
      a2a: a.links?.a2a ?? `/a/${slug}/.well-known/agent.json`,
      erc8004: a.links?.erc8004 ?? `${config.gateway}/agents/${a.id}/erc8004.json`,
      audit: a.links?.audit ?? `${config.gateway}/agents/${a.id}/audit.jsonl`,
      credential: `${config.gateway}/cv/${a.id}/credential.json`,
      badge: `${config.gateway}/cv/${a.id}/badge.svg`,
      endpoint: a.endpoint,
    },
    notes,
  };
  if (registration) doc.identity.registeredAt = doc.identity.registeredAt ?? (registration.ts ?? null);
  if (rating.count && rating.avg !== null && !a.ratingCount) doc.metrics.rating = env({ avg: rating.avg, count: rating.count }, "chain", "ReputationRegistry8004.getSummary");
  return doc;
}

/** Address → the agent it owns, for naming counterparties. One list call, cached per page. */
let ownerCache: Promise<Map<string, AgentView>> | null = null;
async function ownerIndex(addresses: string[]): Promise<Map<string, AgentView>> {
  if (!addresses.length) return new Map();
  ownerCache ||= (async () => {
    const m = new Map<string, AgentView>();
    try {
      const { items } = await api.agents({ limit: 200 });
      // An owner may hold several agents; name a counterparty after the lowest id so the label is stable.
      for (const x of [...items].sort((a, b) => a.id - b.id)) if (!m.has(lc(x.owner))) m.set(lc(x.owner), x);
    } catch { /* names stay as addresses */ }
    return m;
  })();
  return ownerCache;
}

async function readFeedback(agentId: number): Promise<CvEndorsement[]> {
  if (MOCK) return (await mock()).endorsements(agentId);
  if (!reputation8004Deployed) return [];
  const c = contractRead(config.reputation8004, REPUTATION_8004_ABI);
  const clients = (await c.getClients(agentId)) as string[];
  if (!clients.length) return [];
  const [who, , values, decimals, , tag2s, revoked] = (await c.readAllFeedback(agentId, clients, "", "", false)) as [string[], bigint[], bigint[], number[], string[], string[], boolean[]];
  const out: CvEndorsement[] = [];
  for (let i = 0; i < who.length; i++) {
    if (revoked[i]) continue;
    const dec = Number(decimals[i] ?? 0);
    out.push({ from: who[i], fromAgentId: null, fromName: null, capability: tag2s[i] || null, value: Number(values[i]) / 10 ** dec, at: null, tx: null, paymentBacked: false });
  }
  return out;
}

/** IdentityRegistry8004.getMetadata(agentId, key) — "memoryRoot" and "cvRoot" are free keys (only agentWallet is reserved). */
async function readAnchors(agentId: number): Promise<CvAnchor[]> {
  if (MOCK) return (await mock()).anchors(agentId);
  if (!identity8004Deployed) return [];
  const c = contractRead(config.identity8004, IDENTITY_8004_ABI);
  const out: CvAnchor[] = [];
  for (const key of ["memoryRoot", "cvRoot"]) {
    try {
      const v = (await c.getMetadata(agentId, key)) as string;
      if (v && v !== "0x" && !/^0x0+$/.test(v)) out.push({ key, root: v.length > 66 ? v.slice(0, 66) : v, at: null, tx: null });
    } catch { /* key unset */ }
  }
  return out;
}

/* ------------------------------------------------------------------ credential */

/** Proven metrics only. Declared fields are excluded by construction — that is the point of the artefact. */
export function credentialFrom(doc: CvDoc) {
  const proven = Object.entries(doc.metrics).filter(([, e]) => (e as Env).provenance === "chain");
  return {
    $schema: "https://ferminux.net/schema/cv-1.json",
    type: "FerminuxAgentRecord/1",
    subject: {
      chainId: config.chainId, agentId: doc.agentId, owner: doc.identity.owner,
      registry: config.registry, identityRegistry: config.identity8004,
      caip10: `eip155:${config.chainId}:${doc.identity.owner}`,
    },
    asOf: { block: doc.builtAtBlock, ts: doc.builtAt },
    proven: Object.fromEntries(proven.map(([k, e]) => [k, { value: (e as Env).value, source: (e as Env).source, proof: (e as Env).proof }])),
    work: doc.work.map((w) => ({ jobId: w.jobId, client: w.client, amountWei: w.amountWei, payoutWei: w.payoutWei, rating: w.rating, status: w.status, tx: w.tx })),
    validations: doc.validations,
    audit: doc.audit,
    verification: {
      rpc: config.rpc,
      steps: [
        `Read AgentRegistry.getAgent(${doc.agentId}) at ${config.registry} on chain ${config.chainId} and compare jobsCompleted, jobsFailed, ratingCount, ratingSum and bond.`,
        `Fetch every txHash under proven[].proof and confirm the log it names exists in that transaction's receipt.`,
        `Fetch ${doc.audit.url}, recompute leaf = keccak256(utf8(canonicalJson(line))) for every line and fold pairwise to the merkleRoot in the last line.`,
        `Recover the signer of the last line's sig with EIP-191 and compare it to the gateway key published at ${config.gateway}/health.`,
        `Ignore everything not listed under proven — it is declared by the agent or observed by the gateway and nobody checks it.`,
      ],
      note: "Every value under `proven` is re-derivable from chain 3961 without this gateway. Nothing declared by the agent is included here.",
    },
    signature: doc.assembledBy === "gateway" ? undefined : { note: "Assembled in the browser from the public routes; the gateway did not sign this copy. Every proof above still resolves against a public RPC." },
  };
}

export const badgeSvg = (doc: CvDoc): string => {
  const r = doc.metrics.rating.value;
  const jobs = Number(doc.metrics.jobsCompleted.value).toLocaleString("en-US");
  const label = `${doc.identity.name} · ${jobs} job${Number(doc.metrics.jobsCompleted.value) === 1 ? "" : "s"} · ${r.count ? `${(r.avg ?? 0).toFixed(1)}★` : "unrated"}`;
  const w = Math.round(Math.max(214, 88 + label.length * 6.3));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="Ferminux record: ${esc4(label)}">
<title>Ferminux record — built ${new Date(doc.builtAt * 1000).toISOString()}</title>
<rect width="${w}" height="22" rx="4" fill="#fbfbfa" stroke="#e3e3e0"/>
<path d="M4 0h68v22H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z" fill="#0b8f57"/>
<g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="11">
<text x="10" y="15" fill="#ffffff" font-weight="600">Ferminux</text>
<text x="80" y="15" fill="#16181c">${esc4(label)}</text>
</g></svg>`;
};
const esc4 = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/* ------------------------------------------------------------------ the network */

export async function loadNetwork(kind: NetKind): Promise<NetView> {
  // The gateway's /api/network indexes hire and x402 edges; endorsements are not among them, so that
  // tab is always read from ReputationRegistry8004 here.
  if (!MOCK && kind === "hire") {
    try {
      const r = await fetch(`${config.gateway}/network?kind=hire&limit=500`, { headers: { accept: "application/json" } });
      if (r.ok) {
        const j = (await r.json()) as Partial<NetView>;
        if (Array.isArray(j.nodes) && Array.isArray(j.edges)) {
          // Fill anything the route leaves out rather than trusting every field to be there.
          // The gateway names some of these differently (owner/volumeWei/avgRating/jobIds); take
          // either spelling so this page does not break when that route's shape settles.
          type GwNode = Partial<NetNode> & { owner?: string; slug?: string };
          type GwEdge = Partial<NetEdge> & { volumeWei?: string; avgRating?: number | null; jobIds?: number[] };
          const nodes: NetNode[] = (j.nodes as GwNode[]).map((n) => {
            const address = n.address || n.owner || n.key || "";
            return {
              key: lc(n.key || address), address, agentId: n.agentId ?? null, name: n.name || shortAddr(address),
              jobs: Number(n.jobs ?? (n as { jobsCompleted?: number }).jobsCompleted ?? 0), earnedWei: String(n.earnedWei ?? "0"),
              ratingAvg: n.ratingAvg ?? null, ratingCount: Number(n.ratingCount ?? 0),
              capabilities: Array.isArray(n.capabilities) ? n.capabilities : [], status: n.status || "client",
              isAgent: n.isAgent ?? n.agentId != null,
            };
          }).filter((n) => n.key);
          const edges: NetEdge[] = (j.edges as GwEdge[]).map((e) => ({
            from: lc(e.from || ""), to: lc(e.to || ""), fromName: e.fromName || shortAddr(e.from || ""), toName: e.toName || shortAddr(e.to || ""),
            fromAgentId: e.fromAgentId ?? null, toAgentId: e.toAgentId ?? null, jobs: Number(e.jobs ?? 0),
            fmxWei: String(e.fmxWei ?? e.volumeWei ?? "0"), ratingAvg: e.ratingAvg ?? e.avgRating ?? null,
            firstAt: e.firstAt ?? null, lastAt: e.lastAt ?? null, kind, txs: Array.isArray(e.txs) ? e.txs : [],
            jobIds: Array.isArray(e.jobIds) ? e.jobIds.slice(0, 6) : [],
          })).filter((e) => e.from && e.to && e.from !== e.to);
          return { kind, nodes, edges, builtAt: j.builtAt ?? Math.floor(Date.now() / 1000), source: "gateway", notes: j.notes ?? [] };
        }
      }
    } catch { /* assemble it here instead */ }
  }
  if (MOCK) return (await mock()).network(kind);
  return assembleNetwork(kind);
}

const MAX_AGENTS = 60;

async function assembleNetwork(kind: NetKind): Promise<NetView> {
  const notes: string[] = [];
  const { items, total } = await api.agents({ limit: MAX_AGENTS });
  if (total > items.length) notes.push(`Showing the first ${items.length} of ${total} agents.`);
  const byOwner = new Map(items.map((a) => [lc(a.owner), a]));

  const nodes = new Map<string, NetNode>();
  const nodeFor = (address: string, agent?: AgentView | null): NetNode => {
    const key = lc(address);
    let n = nodes.get(key);
    if (!n) {
      const a = agent ?? byOwner.get(key) ?? null;
      n = {
        key, address, agentId: a?.id ?? null, name: a?.name ?? shortAddr(address),
        jobs: a ? Number(a.jobsCompleted ?? 0) : 0, earnedWei: "0", ratingAvg: a?.ratingAvg ?? null, ratingCount: a ? Number(a.ratingCount ?? 0) : 0,
        capabilities: a?.card?.capabilities ?? [], status: a ? agentStatusName(a.status) : "client", isAgent: !!a,
      };
      nodes.set(key, n);
    }
    return n;
  };
  for (const a of items) nodeFor(a.owner, a);

  const edges: NetEdge[] = [];
  if (kind === "hire") {
    const results = await Promise.allSettled(items.map((a) => api.agentJobs(a.id).then((r) => ({ a, jobs: r.items }))));
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { a, jobs } = r.value;
      const to = nodeFor(a.owner, a);
      for (const j of jobs) {
        const from = nodeFor(j.client);
        const st = jobStatusName(j.status);
        if (st === "Open" || st === "None") continue;
        if (from.key === to.key) continue; // the owner's own address is not a counterparty
        let e = edges.find((x) => x.from === from.key && x.to === to.key);
        if (!e) { e = { from: from.key, to: to.key, fromName: from.name, toName: to.name, fromAgentId: from.agentId, toAgentId: to.agentId, jobs: 0, fmxWei: "0", ratingAvg: null, firstAt: null, lastAt: null, kind, txs: [] }; edges.push(e); }
        e.jobs++; e.fmxWei = (BigInt(e.fmxWei) + BigInt(String(j.amount ?? "0"))).toString();
        const t = toSec(j.createdAt);
        if (t !== null) { e.firstAt = e.firstAt === null ? t : Math.min(e.firstAt, t); e.lastAt = e.lastAt === null ? t : Math.max(e.lastAt, t); }
        for (const h of [j.tx?.requested, j.tx?.closed]) if (h && e.txs.length < 6) e.txs.push(h);
        to.earnedWei = (BigInt(to.earnedWei) + BigInt(String(j.amount ?? "0"))).toString();
      }
    }
  } else {
    const results = await Promise.allSettled(items.map((a) => readFeedback(a.id).then((f) => ({ a, f }))));
    let read = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      read++;
      const { a, f } = r.value;
      const to = nodeFor(a.owner, a);
      for (const e0 of f) {
        const from = nodeFor(e0.from);
        let e = edges.find((x) => x.from === from.key && x.to === to.key);
        if (!e) { e = { from: from.key, to: to.key, fromName: from.name, toName: to.name, fromAgentId: from.agentId, toAgentId: to.agentId, jobs: 0, fmxWei: "0", ratingAvg: null, firstAt: null, lastAt: null, kind, txs: [] }; edges.push(e); }
        e.jobs++; e.ratingAvg = e0.value;
      }
    }
    if (!read) notes.push("ReputationRegistry8004 could not be read from this browser, so the endorsement view is empty.");
  }
  edges.sort((a, b) => (BigInt(b.fmxWei) > BigInt(a.fmxWei) ? 1 : BigInt(b.fmxWei) < BigInt(a.fmxWei) ? -1 : b.jobs - a.jobs));
  return { kind, nodes: [...nodes.values()], edges, builtAt: Math.floor(Date.now() / 1000), source: "browser", notes };
}

const shortAddr = (a: string) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");

export { ZERO };
