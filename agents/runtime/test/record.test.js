// The record layer inside the runtime: `--anchor-memory` (FRC-100 anchoring on
// a cadence) and the hiring path that ranks by a PROVEN record rather than by
// what an agent's card claims about itself.
//
// Every Ferminux client here is a stub, so nothing in this file touches a
// network. What is under test is the runtime's judgement, not the chain.
import test from "node:test";
import assert from "node:assert/strict";
import { anchorTick, startMemoryAnchor, ANCHOR_MIN_INTERVAL_MS } from "../dist/anchor.js";
import { scoreCandidate, recordOf, pickAgent } from "../dist/hire.js";

const log = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// --anchor-memory
// ---------------------------------------------------------------------------

function anchorClient(impl) {
  return { memory: { anchor: impl } };
}

test("anchorTick reports the root, count and transaction when a batch lands", async () => {
  const calls = [];
  const fmx = anchorClient(async (args) => {
    calls.push(args);
    return { root: "0x" + "ab".repeat(32), prevRoot: "0x" + "00".repeat(32), count: 7, fromSeq: 12, toSeq: 18, tx: "0x" + "cd".repeat(32), status: "anchored" };
  });
  const res = await anchorTick({ fmx, agentId: 3, log });
  assert.equal(res.status, "anchored");
  assert.equal(res.count, 7);
  assert.equal(res.fromSeq, 12);
  assert.equal(res.toSeq, 18);
  assert.equal(calls[0].agentId, 3);
  assert.equal(calls[0].send, true);
});

test("a quiet hour is not a failure: nothing to anchor spends nothing and says so", async () => {
  const fmx = anchorClient(async () => {
    throw new Error("Ferminux: gateway POST /memory/anchor failed (409): nothing to anchor: every memory record for this address is already in a batch");
  });
  const res = await anchorTick({ fmx, agentId: 3, log });
  assert.equal(res.status, "nothing-to-anchor");
});

test("MemoryAnchor not being deployed degrades to a notice — memory keeps working, unanchored", async () => {
  const fmx = anchorClient(async () => {
    throw new Error("not deployed");
  });
  const res = await anchorTick({ fmx, agentId: 3, log });
  assert.equal(res.status, "not-deployed");
  assert.match(res.reason, /unanchored/);
});

test("--dry-run builds the batch and sends nothing", async () => {
  let sent = null;
  const fmx = anchorClient(async (args) => {
    sent = args.send;
    return { root: "0x" + "ab".repeat(32), count: 2, fromSeq: 1, toSeq: 2, tx: null, status: "built" };
  });
  const res = await anchorTick({ fmx, agentId: 3, log, dryRun: true });
  assert.equal(res.status, "dry-run");
  assert.equal(sent, false, "a dry run must never send a transaction");
});

test("a failed anchor is retried on the next tick rather than crashing the agent", async () => {
  const fmx = anchorClient(async () => {
    throw new Error("insufficient funds for gas");
  });
  const res = await anchorTick({ fmx, agentId: 3, log });
  assert.equal(res.status, "failed");
  assert.match(res.reason, /insufficient funds/);
});

test("startMemoryAnchor anchors once immediately and once more on shutdown", async () => {
  let n = 0;
  const fmx = anchorClient(async () => {
    n++;
    return { root: "0x" + "ab".repeat(32), count: 1, fromSeq: n, toSeq: n, tx: "0x" + "cd".repeat(32), status: "anchored" };
  });
  const stop = startMemoryAnchor({ fmx, agentId: 3, log, intervalMs: ANCHOR_MIN_INTERVAL_MS });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(n, 1, "the first pass runs at once, not an interval later");
  await stop();
  assert.equal(n, 2, "a session's last writes are anchored before exit");
});

// ---------------------------------------------------------------------------
// Hiring: proven over asserted
// ---------------------------------------------------------------------------

const blank = {
  agentId: 1,
  name: "A",
  owner: "0x" + "11".repeat(20),
  pricePerJobWei: "100000000000000000",
  online: true,
  declaredCapabilities: [],
  provenClaims: 0,
  rejectedClaims: 0,
  jobsCompleted: 0,
  jobsFailed: 0,
  ratingCount: 0,
  ratingAvg: null,
  escrowEarnedWei: "0",
  x402EarnedWei: "0",
  payers: 0,
  paidJobs: 0,
  zeroValueJobs: 0,
  issuerRole: "none",
  anchor: "unchecked",
  signed: false,
  verified: false,
  warnings: [],
};

test("a proven record beats an identical-looking one with nothing behind it", () => {
  const proven = scoreCandidate({ ...blank, provenClaims: 9, jobsCompleted: 6, ratingCount: 4, ratingAvg: 4.8, escrowEarnedWei: "40000000000000000000", payers: 5 });
  const asserted = scoreCandidate({ ...blank });
  assert.ok(proven.score > asserted.score * 2, `${proven.score} should dominate ${asserted.score}`);
  assert.match(proven.reason, /9 claim\(s\) proved on chain/);
  assert.match(asserted.reason, /no chain-proved record yet/);
  assert.match(asserted.reason, /no paid work yet/);
});

test("volume alone does not buy rank: breadth of payers does", () => {
  // Same FMX, one payer vs eight. A self-dealer can recycle capital through one
  // address all day; it cannot cheaply manufacture eight unrelated ones.
  const narrow = scoreCandidate({ ...blank, provenClaims: 40, jobsCompleted: 40, escrowEarnedWei: "50000000000000000000", payers: 1 });
  const broad = scoreCandidate({ ...blank, provenClaims: 40, jobsCompleted: 40, escrowEarnedWei: "50000000000000000000", payers: 8 });
  assert.ok(broad.score > narrow.score);
});

test("earned value saturates, so the hundredth FMX cannot outrank a good record", () => {
  const big = scoreCandidate({ ...blank, provenClaims: 5, jobsCompleted: 5, escrowEarnedWei: "5000000000000000000000", payers: 2 });
  const huge = scoreCandidate({ ...blank, provenClaims: 5, jobsCompleted: 5, escrowEarnedWei: "50000000000000000000000", payers: 2 });
  assert.ok(huge.score - big.score <= 1, "ten times the money is worth almost nothing more once saturated");
});

test("a claim that does not bind to the transaction it cites is a red flag, not a neutral", () => {
  const clean = scoreCandidate({ ...blank, provenClaims: 8, jobsCompleted: 8, escrowEarnedWei: "20000000000000000000", payers: 4 });
  const dirty = scoreCandidate({ ...blank, provenClaims: 8, rejectedClaims: 1, jobsCompleted: 8, escrowEarnedWei: "20000000000000000000", payers: 4 });
  assert.ok(dirty.score < clean.score / 2);
  assert.match(dirty.reason, /DID NOT bind/);
});

test("an unrated agent sits in the middle, not at the bottom — unrated is not bad", () => {
  const paid = { provenClaims: 3, jobsCompleted: 3, paidJobs: 3, escrowEarnedWei: "10000000000000000000", payers: 3 };
  const unrated = scoreCandidate({ ...blank, ...paid });
  const oneStar = scoreCandidate({ ...blank, ...paid, ratingCount: 3, ratingAvg: 1 });
  const fiveStar = scoreCandidate({ ...blank, ...paid, ratingCount: 3, ratingAvg: 5 });
  assert.ok(oneStar.score < unrated.score && unrated.score < fiveStar.score);
});

test("a perfect rating earned entirely on zero-value jobs counts for nothing", () => {
  // 50 completed jobs at a flawless 5.0 cost 0.0082 FMX of gas and move no
  // money. The rating is real, on chain, and worth exactly what it cost.
  const farmed = scoreCandidate({ ...blank, provenClaims: 50, jobsCompleted: 50, paidJobs: 0, zeroValueJobs: 50, ratingCount: 50, ratingAvg: 5, escrowEarnedWei: "0", payers: 0 });
  const unratedButPaid = scoreCandidate({ ...blank, provenClaims: 3, jobsCompleted: 3, paidJobs: 3, escrowEarnedWei: "10000000000000000000", payers: 3 });
  assert.ok(unratedButPaid.score > farmed.score, `${unratedButPaid.score} should beat ${farmed.score}`);
  assert.match(farmed.reason, /none of them on a job that moved FMX/);
  assert.match(farmed.reason, /50 settled jobs moved 0 FMX/);
});

function stubFmx({ agents, cvs = {}, verifications = {} }) {
  return {
    agents: { list: async () => ({ items: agents, total: agents.length }) },
    cv: {
      get: async (id) => {
        const doc = cvs[id];
        if (!doc) throw new Error(`no CV for ${id}`);
        return doc;
      },
      verify: async (doc) => verifications[doc.credentialSubject.agent.agentId] ?? { ok: true, signed: true, verified: 0, rejected: 0, skipped: 0, anchor: "current", warnings: [], errors: [] },
    },
  };
}

function cvDoc(agentId, { record = [], summary = {} } = {}) {
  return { credentialSubject: { agent: { agentId }, summary, record } };
}

test("recordOf folds the CV's verdict into the ranking, and a missing CV ranks low without disappearing", async () => {
  const agents = [
    { id: 1, name: "Proven", owner: "0x" + "11".repeat(20), pricePerJob: "100000000000000000", online: true, jobsCompleted: 4, jobsFailed: 0, ratingCount: 2, ratingAvg: 5, card: { capabilities: ["hash"] } },
    { id: 2, name: "Silent", owner: "0x" + "22".repeat(20), pricePerJob: "100000000000000000", online: true, jobsCompleted: 0, jobsFailed: 0, ratingCount: 0, ratingAvg: null, card: { capabilities: ["hash"] } },
  ];
  const cvs = {
    1: cvDoc(1, {
      summary: { escrowEarnedWei: "30000000000000000000", x402EarnedWei: "0" },
      record: [
        { type: "EscrowJob", client: "0x" + "aa".repeat(20) },
        { type: "EscrowJob", client: "0x" + "bb".repeat(20) },
        { type: "X402Receipt", payer: "0x" + "cc".repeat(20) },
      ],
    }),
  };
  const fmx = stubFmx({
    agents,
    cvs,
    verifications: {
      1: {
        ok: true,
        signed: true,
        issuerRole: "owner",
        verified: 6,
        rejected: 0,
        skipped: 1,
        anchor: "current",
        warnings: [],
        errors: [],
        // THE MONEY COMES FROM THE VERIFIER, not from the document. This is the
        // figure re-derived from the claims that actually bound to transactions.
        verifiedEarned: { escrowEarnedWei: "30000000000000000000", x402EarnedWei: "0", x402SpentWei: "0", payers: 3, paidJobs: 2, zeroValueJobs: 0 },
      },
    },
  });

  const proven = await recordOf(fmx, agents[0]);
  assert.equal(proven.provenClaims, 6);
  assert.equal(proven.payers, 3, "distinct paying counterparties come out of the claims that VERIFIED");
  assert.equal(proven.escrowEarnedWei, "30000000000000000000");
  assert.equal(proven.verified, true);

  const silent = await recordOf(fmx, agents[1], { log });
  assert.equal(silent.provenClaims, 0);
  assert.ok(silent.warnings.some((w) => w.includes("no readable CV")));
  assert.ok(silent.score >= 0, "a new agent is ranked, never excluded");
  assert.ok(proven.score > silent.score);
});

test("pickAgent prefers the proven agent and never picks one whose claims failed to bind", async () => {
  const agents = [
    { id: 1, name: "Proven", owner: "0x" + "11".repeat(20), pricePerJob: "100000000000000000", online: true, jobsCompleted: 4, jobsFailed: 0, ratingCount: 2, ratingAvg: 5, card: { capabilities: ["hash"] } },
    { id: 2, name: "Loud", owner: "0x" + "22".repeat(20), pricePerJob: "10000000000000000", online: true, jobsCompleted: 900, jobsFailed: 0, ratingCount: 900, ratingAvg: 5, card: { capabilities: ["hash", "everything"] } },
  ];
  // #2 has magnificent counters and a CV whose claims do not bind — exactly the
  // shape a zero-value wash farm produces. It must never be `best`.
  const cvs = {
    1: cvDoc(1, { summary: { escrowEarnedWei: "30000000000000000000" }, record: [{ type: "EscrowJob", client: "0x" + "aa".repeat(20) }, { type: "EscrowJob", client: "0x" + "bb".repeat(20) }] }),
    2: cvDoc(2, { summary: { escrowEarnedWei: "0" }, record: [{ type: "EscrowJob", client: "0x" + "22".repeat(20) }] }),
  };
  const fmx = stubFmx({
    agents,
    cvs,
    verifications: {
      1: { ok: true, signed: true, verified: 5, rejected: 0, skipped: 0, anchor: "current", warnings: [], errors: [] },
      2: { ok: false, signed: true, verified: 0, rejected: 3, skipped: 0, anchor: "unanchored", warnings: [], errors: ["3 claim(s) do not bind"] },
    },
  });
  const { best, ranked, considered } = await pickAgent(fmx, { capability: "hash" });
  assert.equal(considered, 2);
  assert.equal(best.agentId, 1);
  assert.equal(ranked.length, 2, "the rejected agent is still shown, with the reason");
  assert.ok(ranked.find((r) => r.agentId === 2).reason.includes("DID NOT bind"));
});

test("the capability filter reads the card, and maxPrice is respected", async () => {
  const agents = [
    { id: 1, name: "Hasher", owner: "0x" + "11".repeat(20), pricePerJob: "100000000000000000", online: true, card: { capabilities: ["hash"] } },
    { id: 2, name: "Translator", owner: "0x" + "22".repeat(20), pricePerJob: "100000000000000000", online: true, card: { capabilities: ["translate"] } },
    { id: 3, name: "Expensive", owner: "0x" + "33".repeat(20), pricePerJob: "9000000000000000000", online: true, card: { capabilities: ["hash"] } },
  ];
  const fmx = stubFmx({ agents, cvs: {} });
  const res = await pickAgent(fmx, { capability: "hash", maxPriceWei: 1000000000000000000n, shallow: true, log });
  assert.deepEqual(res.ranked.map((r) => r.agentId), [1]);
  const excluded = await pickAgent(fmx, { capability: "hash", shallow: true, exclude: [1], log });
  assert.deepEqual(excluded.ranked.map((r) => r.agentId), [3]);
});

test("shallow mode says out loud that it ranked on inflatable counters", async () => {
  const agents = [{ id: 1, name: "A", owner: "0x" + "11".repeat(20), pricePerJob: "0", online: true, jobsCompleted: 500, card: {} }];
  const { ranked } = await pickAgent(stubFmx({ agents }), { shallow: true, log });
  assert.ok(ranked[0].warnings.some((w) => w.includes("cheap to inflate")));
});

test("a forged summary never reaches the score: the money is taken from the verifier", async () => {
  // The attack that worked: a CV claiming 58,500 FMX across 12 five-star jobs
  // for an agent that earned nothing. The verifier now re-derives the figure
  // from the claims that actually bound, and this is the number that ranks.
  const agents = [{ id: 3, name: "Inflated", owner: "0x" + "33".repeat(20), pricePerJob: "0", online: true, jobsCompleted: 12, jobsFailed: 0, ratingCount: 12, ratingAvg: 5, card: { capabilities: ["hash"] } }];
  const cvs = { 3: cvDoc(3, { summary: { escrowEarnedWei: "58500000000000000000000", x402EarnedWei: "0" }, record: [] }) };
  const fmx = stubFmx({
    agents,
    cvs,
    verifications: {
      3: {
        ok: true,
        signed: true,
        issuerRole: "owner",
        verified: 1,
        rejected: 0,
        skipped: 0,
        anchor: "unanchored",
        warnings: [],
        errors: [],
        verifiedEarned: { escrowEarnedWei: "0", x402EarnedWei: "0", x402SpentWei: "0", payers: 0, paidJobs: 0, zeroValueJobs: 12 },
      },
    },
  });
  const r = await recordOf(fmx, agents[0]);
  assert.equal(r.escrowEarnedWei, "0", "the document's 58,500 FMX is not repeated anywhere");
  assert.match(r.reason, /no paid work yet/);
  assert.ok(r.warnings.some((w) => w.includes("the claims that verified add up to 0")));
});

test("with no chain check, an agent is ranked as unproven rather than on what its CV says", async () => {
  const agents = [{ id: 4, name: "Unchecked", owner: "0x" + "44".repeat(20), pricePerJob: "0", online: true, jobsCompleted: 9, jobsFailed: 0, ratingCount: 9, ratingAvg: 5, card: { capabilities: ["hash"] } }];
  const cvs = { 4: cvDoc(4, { summary: { escrowEarnedWei: "900000000000000000000" }, record: [] }) };
  const fmx = stubFmx({ agents, cvs, verifications: { 4: { ok: false, signed: true, issuerRole: "owner", verified: 0, rejected: 0, skipped: 3, anchor: "unchecked", warnings: [], errors: [], verifiedEarned: null } } });
  const r = await recordOf(fmx, agents[0]);
  assert.equal(r.escrowEarnedWei, "0");
  assert.ok(r.warnings.some((w) => w.includes("ranked as unproven")));
});
