// Indexer reorg handling against a scripted chain: the window is the chain's 64-block reorg cap, a reorg rolls
// back what was derived from the blocks it replaced (events, state rows, activity, unsent webhooks, bounty
// transitions, arena award links, referral eligibility, v3_counted increments), a tx re-included at another logIndex
// counts once, a quiet tick re-runs no handler, and a state read that failed is made again.
import test from "node:test";
import assert from "node:assert/strict";
import { Interface, ZeroAddress, getAddress } from "ethers";
import { openMemoryDb } from "../dist/db.js";
import { indexOnce, REORG_DEPTH } from "../dist/indexer.js";
import { REGISTRY_ABI, ESCROW_ABI } from "../dist/abi.js";
import { v3Interface } from "../dist/abi-v3.js";
import { ActivityBus } from "../dist/commons/activity.js";
import { makeIndexerHooks } from "../dist/commons/hooks.js";
import { ReferralPayout } from "../dist/commons/referrals.js";
import { WebhookBus } from "../dist/v3/webhooks.js";
import { applyV3Event, revertV3Event } from "../dist/v3/indexer-v3.js";

const REG = "0xa94f27F18267d09349809f3e2AeF8e7767033e8F";
const ESC = "0x99b331495951dB91857902de91EAe9Ff54d8a719";
const STREAM = "0x59404F738A90E5CF725F5837EF40461d1EA2EC35";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";
const regIface = new Interface(REGISTRY_ABI);
const escIface = new Interface(ESCROW_ABI);
const streamIface = v3Interface("streamPay");
const tx = (tag) => "0x" + tag.padStart(64, "0");

/** A chain we script block by block; `reorgFrom(n)` drops block n and everything above, later blocks get new hashes. */
class ScriptedChain {
  constructor() {
    this.blocks = new Map();
    this.head = 0;
    this.branch = 1;
    this.calls = { getLogs: 0, getBlock: 0, getAgent: 0, getJob: 0 };
    this.agents = new Map();
    this.jobs = new Map();
    const self = this;
    this.provider = {
      async getBlockNumber() {
        return self.head;
      },
      async getBlock(n) {
        self.calls.getBlock++;
        return { timestamp: 1_758_000_000 + n * 7 };
      },
      async getLogs({ address, fromBlock, toBlock }) {
        self.calls.getLogs++;
        const want = new Set(address.map((a) => a.toLowerCase()));
        const out = [];
        for (let n = fromBlock; n <= Math.min(toBlock, self.head); n++) {
          const b = self.blocks.get(n);
          if (!b) continue;
          for (const l of b.logs) if (want.has(l.address.toLowerCase())) out.push({ ...l, blockNumber: n, blockHash: b.hash });
        }
        return out;
      },
    };
  }
  /** appends block `n` (and empty blocks up to it) carrying `logs` in order */
  block(n, logs = []) {
    for (let k = this.head + 1; k < n; k++) this.blocks.set(k, { hash: this.hash(k), logs: [] });
    this.blocks.set(n, { hash: this.hash(n), logs: logs.map((l, index) => ({ ...l, index })) });
    this.head = Math.max(this.head, n);
  }
  hash(n) {
    return "0x" + this.branch.toString(16).padStart(8, "0") + n.toString(16).padStart(56, "0");
  }
  reorgFrom(n) {
    for (const k of [...this.blocks.keys()]) if (k >= n) this.blocks.delete(k);
    this.head = n - 1;
    this.branch++;
  }
}

function log(iface, address, name, values, txHash) {
  const { data, topics } = iface.encodeEventLog(name, values);
  return { address, data, topics, transactionHash: txHash };
}

function agentStruct(owner) {
  return { owner, name: "Scribe", endpoint: "https://scribe.example", metadataURI: "", pricePerJob: 0n, bond: 0n, registeredAt: 1n, retiredAt: 0n, status: 1n, jobsCompleted: 0n, jobsFailed: 0n, ratingCount: 0n, ratingSum: 0n };
}
function jobStruct(status, client = BOB) {
  return { agentId: 7n, client, amount: 10n, inputHash: "0x" + "11".repeat(32), outputHash: "0x" + "00".repeat(32), inputURI: "fmx://in", outputURI: "", createdAt: 1n, deliveredAt: 0n, status: BigInt(status) };
}

function setup(chunkSize) {
  const db = openMemoryDb();
  const now = () => 1_758_400_000_000;
  const activity = new ActivityBus(db, now);
  const webhooks = new WebhookBus(db, now, async () => new Response("ok"));
  webhooks.attachActivity(activity);
  const chain = new ScriptedChain();
  const deps = { db, activity, webhooks };
  const ctx = {
    provider: chain.provider,
    registry: { interface: regIface, getAgent: async (id) => (chain.calls.getAgent++, chain.agents.get(Number(id)) ?? agentStruct(ZeroAddress)) },
    escrow: { interface: escIface, getJob: async (id) => (chain.calls.getJob++, chain.jobs.get(Number(id)) ?? jobStruct(0, ZeroAddress)) },
    registryAddress: REG,
    escrowAddress: ESC,
    db,
    deployBlock: 100,
    chunkSize,
    hooks: { ...makeIndexerHooks(db, activity, { webhooks }), onV3Event: (ev) => applyV3Event(deps, ev), onV3Rollback: (ev) => revertV3Event(deps, ev) },
    v3: { contracts: [{ key: "streamPay", address: STREAM, iface: streamIface }] },
  };
  return { db, chain, ctx, activity };
}

test("indexer: the re-check window is the chain's 64-block reorg cap", () => {
  assert.equal(REORG_DEPTH, 64);
});

// chunkSize 3: the window no longer fits one getLogs, so the backfill path (window, then new blocks by chunk) runs
for (const chunkSize of [undefined, 3]) test(`indexer: a reorg rolls back what the replaced blocks wrote; a tx re-included at another logIndex counts once (chunk ${chunkSize ?? "default"})`, async () => {
  const { db, chain, ctx } = setup(chunkSize);
  db.prepare("INSERT INTO webhooks (owner, url, secret, events, active, createdAt, updatedAt) VALUES (?, 'https://hook.example/in', 'sixteen-chars-secret', '[\"job.delivered\"]', 1, 1, 1)").run(ALICE);
  chain.agents.set(7, agentStruct(ALICE));
  chain.jobs.set(3, jobStruct(2)); // Delivered
  chain.block(100, [log(regIface, REG, "AgentRegistered", [7, ALICE, "Scribe", "https://scribe.example", "", 0, 0], tx("a1"))]);
  chain.block(101, [
    log(streamIface, STREAM, "StreamOpened", [5, ALICE, BOB, 1, 1000, 1, 1001], tx("a2")),
    log(escIface, ESC, "JobRequested", [3, 7, BOB, 10, "0x" + "11".repeat(32), "fmx://in"], tx("a3")),
  ]);
  chain.block(102, [
    log(streamIface, STREAM, "StreamClaimed", [5, 300, 0], tx("b0")),
    log(escIface, ESC, "JobDelivered", [3, "0x" + "22".repeat(32), "fmx://out"], tx("b1")),
  ]);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT claimed FROM streams WHERE id = 5").get().claimed, "300");
  assert.equal(db.prepare("SELECT txDelivered FROM jobs WHERE id = 3").get().txDelivered, tx("b1"));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'pending'").get().c, 1, "job.delivered queued for the agent owner");

  // a quiet tick (one new empty block) runs no handler: one getLogs, no state read, no block timestamp
  const before = { ...chain.calls };
  chain.block(103);
  await indexOnce(ctx);
  assert.deepEqual(chain.calls, { ...before, getLogs: before.getLogs + (chunkSize ? 2 : 1) }, "the 64-block re-check is one getLogs and nothing else");

  // block 102 is replaced: tx b0 comes back at logIndex 1 behind a new claim, the delivery (b1) does not
  chain.reorgFrom(102);
  chain.jobs.set(3, jobStruct(1)); // Open again
  chain.block(102, [log(streamIface, STREAM, "StreamClaimed", [5, 100, 0], tx("c0")), log(streamIface, STREAM, "StreamClaimed", [5, 300, 0], tx("b0"))]);
  chain.block(104);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT claimed FROM streams WHERE id = 5").get().claimed, "400", "300 (b0, once) + 100 (c0)");
  assert.deepEqual(db.prepare("SELECT txHash, logIndex FROM v3_counted ORDER BY txHash").all().map((r) => `${r.txHash.slice(-2)}@${r.logIndex}`), ["b0@1", "c0@0"]);
  assert.deepEqual(db.prepare("SELECT txHash, logIndex FROM events WHERE blockNumber = 102 ORDER BY logIndex").all().map((r) => `${r.txHash.slice(-2)}@${r.logIndex}`), ["c0@0", "b0@1"]);
  const job = db.prepare("SELECT status, txRequested, txDelivered FROM jobs WHERE id = 3").get();
  assert.deepEqual(job, { status: 1, txRequested: tx("a3"), txDelivered: null }, "re-read from the chain, tx columns re-pointed");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity WHERE type = 'job.delivered'").get().c, 0, "activity for the removed delivery is gone");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'pending'").get().c, 0, "its unsent webhook too");
  assert.equal(db.prepare("SELECT blockHash FROM events WHERE txHash = ?").get(tx("b0")).blockHash, chain.blocks.get(102).hash);
});

test("indexer: a reorg deeper than 12 blocks (within 64) is caught and its rows go", async () => {
  const { db, chain, ctx } = setup();
  chain.agents.set(7, agentStruct(ALICE));
  chain.block(100, [log(regIface, REG, "AgentRegistered", [7, ALICE, "Scribe", "https://scribe.example", "", 0, 0], tx("a1"))]);
  chain.block(101, [log(streamIface, STREAM, "StreamOpened", [5, ALICE, BOB, 1, 1000, 1, 1001], tx("a2"))]);
  chain.block(102, [log(streamIface, STREAM, "StreamClaimed", [5, 300, 0], tx("a3"))]);
  chain.block(150);
  await indexOnce(ctx);
  assert.ok(db.prepare("SELECT 1 FROM agents WHERE id = 7").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity").get().c, 2);
  // 51 blocks replaced from 100: the registration, the stream and its claim were never on the winning branch
  chain.reorgFrom(100);
  chain.agents.delete(7);
  chain.block(155);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 0);
  assert.equal(db.prepare("SELECT 1 FROM agents WHERE id = 7").get(), undefined, "the registry no longer knows agent 7");
  assert.equal(db.prepare("SELECT 1 FROM streams WHERE id = 5").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM v3_counted").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity").get().c, 0);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'indexedBlock'").get().value, "155");
});

test("revertV3Event: each v3 handler's rows go, set values fall back, counted increments come off once", () => {
  const db = openMemoryDb();
  const now = () => 1_758_400_000_000;
  const deps = { db, activity: new ActivityBus(db, now), webhooks: new WebhookBus(db, now, async () => new Response("ok")) };
  let n = 0;
  // apply a log as the indexer does (events row first), returning what a rollback of it is handed
  const apply = (key, name, args) => {
    const ev = { key, parsed: { name }, args, blockNumber: 200, txHash: tx(`e${++n}`), logIndex: 0, ts: 1_758_400_000 };
    db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, 0, 200, ?, ?, ?, ?)").run(ev.txHash, key, name, JSON.stringify(args), ev.ts);
    applyV3Event(deps, ev);
    return { contractName: key, eventName: name, args, blockNumber: 200, txHash: ev.txHash, logIndex: 0 };
  };
  const revert = (ev) => {
    revertV3Event(deps, ev);
    db.prepare("DELETE FROM events WHERE txHash = ? AND logIndex = ?").run(ev.txHash, ev.logIndex);
  };
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // x402: the settled voucher goes back to `submitted` for the facilitator's receipt check
  db.prepare("INSERT INTO x402_vouchers (payer, nonce, payee, amount, ref, expiry, sig, resource, status, createdAt) VALUES (?, '9', ?, '5', '0x', 1, '0x', '', 'submitted', 1)").run(getAddress(ALICE), getAddress(BOB));
  const settled = apply("x402Vault", "Settled", { payer: ALICE, payee: BOB, amount: "5", fee: "0", nonce: "9", ref: "0x" });
  assert.equal(one("SELECT status FROM x402_vouchers WHERE nonce = '9'").status, "settled");
  revert(settled);
  assert.equal(one("SELECT status FROM x402_vouchers WHERE nonce = '9'").status, "submitted");
  assert.equal(one("SELECT COUNT(*) AS c FROM x402_settlements").c, 0);

  // arbiter: votes are increments, the case row was created by the log
  const opened = apply("arbiterPool", "CaseOpened", { caseId: "3", jobId: "9", opener: ALICE, evidenceURI: "" });
  const v1 = apply("arbiterPool", "Voted", { caseId: "3" });
  const v2 = apply("arbiterPool", "Voted", { caseId: "3" });
  const evid = apply("arbiterPool", "EvidenceSubmitted", { caseId: "3", by: BOB, uri: "ipfs://e" });
  revert(evid);
  revert(v2);
  assert.equal(one("SELECT votes FROM arbiter_cases WHERE id = 3").votes, 1);
  assert.equal(one("SELECT COUNT(*) AS c FROM case_evidence").c, 0);
  revert(v1);
  revert(opened);
  assert.equal(one("SELECT 1 AS x FROM arbiter_cases WHERE id = 3"), undefined);

  // token counters
  const token = getAddress("0x00000000000000000000000000000000000070c0");
  const launched = apply("tokenFactory", "Launched", { token, agentId: "7", symbol: "SCRB" });
  apply("tokenFactory", "Bought", { token, buyer: BOB, fmxIn: "100", fee: "1", amountOut: "5" });
  const bought = apply("tokenFactory", "Bought", { token, buyer: BOB, fmxIn: "40", fee: "1", amountOut: "2" });
  revert(bought);
  assert.deepEqual(one("SELECT buys, fmxIn FROM agent_tokens WHERE token = ?", token), { buys: 1, fmxIn: "100" });
  revert({ ...launched });
  assert.equal(one("SELECT 1 AS x FROM agent_tokens WHERE token = ?", token), undefined);

  // plans + subs: values set by a log fall back to the previous log's
  apply("streamPay", "PlanCreated", { planId: "4", payee: BOB, pricePerPeriod: "10", period: "60", metadataURI: "" });
  const off = apply("streamPay", "PlanActiveSet", { planId: "4", active: "false" });
  assert.equal(one("SELECT active FROM plans WHERE id = 4").active, 0);
  revert(off);
  assert.equal(one("SELECT active FROM plans WHERE id = 4").active, 1);
  apply("streamPay", "Subscribed", { subId: "8", planId: "4", payer: ALICE, periods: "1", paidThrough: "1000" });
  const renewed = apply("streamPay", "SubRenewed", { subId: "8", periods: "1", paidThrough: "2000" });
  revert(renewed);
  assert.equal(one("SELECT paidThrough FROM subs WHERE id = 8").paidThrough, 1000);

  // a stream top-up carrying the new total: deposit and stop fall back to the open's
  apply("streamPay", "StreamOpened", { id: "6", payer: ALICE, payee: BOB, ratePerSec: "1", deposit: "100", start: "1", stop: "101" });
  const topUp = apply("streamPay", "StreamToppedUp", { id: "6", amount: "50", deposit: "150", stop: "151" });
  revert(topUp);
  assert.deepEqual(one("SELECT deposit, stop FROM streams WHERE id = 6"), { deposit: "100", stop: 101 });

  // FRC-8004 feedback / validation, endorsements, accounts, a root only the chain knew
  const fb = apply("reputation8004", "NewFeedback", { agentId: "7", clientAddress: BOB, value: "5", valueDecimals: "0", tag1: "", tag2: "", feedbackURI: "" });
  revert(fb);
  assert.equal(one("SELECT COUNT(*) AS c FROM reputation_feedback").c, 0);
  const reqHash = "0x" + "ab".repeat(32);
  const vreq = apply("validation8004", "ValidationRequest", { validatorAddress: BOB, agentId: "7", requestURI: "u", requestHash: reqHash });
  const vres = apply("validation8004", "ValidationResponse", { validatorAddress: BOB, agentId: "7", requestHash: reqHash, response: "100", responseURI: "r", tag: "t" });
  revert(vres);
  assert.deepEqual(one("SELECT response, txResponse FROM validations WHERE requestHash = ?", reqHash), { response: null, txResponse: null });
  revert(vreq);
  assert.equal(one("SELECT 1 AS x FROM validations WHERE requestHash = ?", reqHash), undefined);
  const endorsed = apply("endorsements", "Endorsed", { id: "2", fromAgentId: "7", toAgentId: "8", capability: "c", capabilityId: "0x01", basis: "1", weight: "1", evidenceJobId: "0", evidenceAmountWei: "0", uri: "" });
  const revoked = apply("endorsements", "EndorsementRevoked", { id: "2", fromAgentId: "7", toAgentId: "8" });
  revert(revoked);
  assert.equal(one("SELECT revoked FROM endorsements WHERE id = 2").revoked, 0);
  revert(endorsed);
  assert.equal(one("SELECT 1 AS x FROM endorsements WHERE id = 2"), undefined);
  const acct = apply("accountFactory", "AccountCreated", { owner: ALICE, account: "0x00000000000000000000000000000000000aCC01" });
  revert(acct);
  assert.equal(one("SELECT COUNT(*) AS c FROM agent_accounts").c, 0);
  const anchored = apply("memoryAnchor", "MemoryAnchored", { agentId: "7", root: "0x" + "cd".repeat(32), prevRoot: "0x" + "00".repeat(32), seq: "1", count: "2", totalRecords: "2", uri: "", anchoredBy: ALICE });
  revert(anchored);
  assert.equal(one("SELECT COUNT(*) AS c FROM memory_anchors").c, 0);

  assert.equal(one("SELECT COUNT(*) AS c FROM v3_counted").c, 1, "only the claim of a log still applied (the first Bought) remains");
});

// applyJobToBounties never moves a bounty out of 'completed' and only auto-links an unlinked one, so the re-read
// job could not repair a bounty whose transition came from a job event the reorg removed.
test("indexer: a reorg takes back the bounty transitions its removed job events made", async () => {
  const { db, chain, ctx } = setup();
  db.prepare("INSERT INTO bounties (id, poster, title, brief, rewardWei, createdAt, updatedAt) VALUES (1, ?, 'Index the archive', 'brief', '5', 1, 1)").run(BOB);
  const bounty = () => db.prepare("SELECT status, jobId, awardedAgentId, completedAt FROM bounties WHERE id = 1").get();
  const bountyActivity = () => db.prepare("SELECT type FROM activity WHERE type LIKE 'bounty.%' ORDER BY id").all().map((r) => r.type);
  const job = (status) => ({ ...jobStruct(status), inputURI: "fmx://bounty/1" });
  const hire = (id, txTag) => log(escIface, ESC, "JobRequested", [id, 7, BOB, 10, "0x" + "11".repeat(32), "fmx://bounty/1"], tx(txTag));
  chain.agents.set(7, agentStruct(ALICE));
  chain.jobs.set(3, job(1));
  chain.block(101, [hire(3, "a3")]);
  await indexOnce(ctx);
  chain.jobs.set(3, job(3));
  chain.block(102, [log(escIface, ESC, "JobCompleted", [3, 9, 1, 5], tx("b1"))]);
  await indexOnce(ctx);
  assert.equal(bounty().status, "completed");

  // the completion is reorged out and not re-included: the job is open again, so is the award
  chain.reorgFrom(102);
  chain.jobs.set(3, job(1));
  chain.block(103);
  await indexOnce(ctx);
  assert.deepEqual(bounty(), { status: "awarded", jobId: 3, awardedAgentId: 7, completedAt: null });
  assert.deepEqual(bountyActivity(), ["bounty.award"]);

  // a refund reopens the bounty; when the refund is reorged out the link comes back
  chain.jobs.set(3, job(4));
  chain.block(104, [log(escIface, ESC, "JobRefunded", [3, 10, false], tx("c1"))]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(), { status: "open", jobId: null, awardedAgentId: null, completedAt: null });
  chain.reorgFrom(104);
  chain.jobs.set(3, job(1));
  chain.block(105);
  await indexOnce(ctx);
  assert.deepEqual(bounty(), { status: "awarded", jobId: 3, awardedAgentId: 7, completedAt: null });
  assert.deepEqual(bountyActivity(), ["bounty.award"]);

  // the hire itself is reorged out: the job is gone, the link it made too, and the next hire can take the bounty
  chain.reorgFrom(101);
  chain.jobs.delete(3);
  chain.block(106);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT 1 FROM jobs WHERE id = 3").get(), undefined);
  assert.deepEqual(bounty(), { status: "open", jobId: null, awardedAgentId: null, completedAt: null });
  assert.deepEqual(bountyActivity(), []);
  chain.jobs.set(4, job(1));
  chain.block(107, [hire(4, "d1")]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(), { status: "awarded", jobId: 4, awardedAgentId: 7, completedAt: null });
});

// bounties.hire() sends /award {agentId, jobId} as soon as its receipt is in, usually before the indexer has seen the
// job: that award, not the job, made the link, so retracting the job's activity row kept it. The id then belonged to
// nothing, or to whoever's job took it on the winning branch, and that job drove the poster's bounty.
test("indexer: a job the poster's /award named goes from the bounty when a reorg drops it or gives its id to another job", async () => {
  const { db, chain, ctx, activity } = setup();
  const CAROL = "0x00000000000000000000000000000000000CA401";
  for (const id of [1, 2]) db.prepare("INSERT INTO bounties (id, poster, title, brief, rewardWei, createdAt, updatedAt) VALUES (?, ?, 'Index the archive', 'brief', '5', 1, 1)").run(id, BOB);
  const bounty = (id) => db.prepare("SELECT status, jobId, awardedAgentId FROM bounties WHERE id = ?").get(id);
  // what POST /api/bounties/:id/award writes for a job it cannot see yet
  const award = (id, agentId, jobId) => {
    db.prepare("UPDATE bounties SET status = 'awarded', awardedAgentId = ?, jobId = ?, awardedAt = 5, completedAt = NULL, updatedAt = 5 WHERE id = ?").run(agentId, jobId, id);
    activity.emit("bounty.award", { actor: BOB, ref: { kind: "bounty", id }, data: { bountyId: id, agentId, jobId } });
  };
  const job = (bountyId, status, client = BOB) => ({ ...jobStruct(status, client), inputURI: `fmx://bounty/${bountyId}` });
  const hire = (id, bountyId, txTag, client = BOB) => log(escIface, ESC, "JobRequested", [id, 7, client, 10, "0x" + "11".repeat(32), `fmx://bounty/${bountyId}`], tx(txTag));
  chain.agents.set(7, agentStruct(ALICE));

  award(1, 7, 3);
  chain.jobs.set(3, job(1, 1));
  chain.block(101, [hire(3, 1, "a3")]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(1), { status: "awarded", jobId: 3, awardedAgentId: 7 });

  // the winning branch gives id 3 to CAROL's unrelated job and BOB's hire comes back as job 4
  chain.reorgFrom(101);
  chain.jobs.set(3, jobStruct(1, CAROL));
  chain.jobs.set(4, job(1, 1));
  chain.block(101, [log(escIface, ESC, "JobRequested", [3, 7, CAROL, 10, "0x" + "11".repeat(32), "fmx://in"], tx("c3")), hire(4, 1, "a3")]);
  chain.block(102);
  await indexOnce(ctx);
  assert.deepEqual(bounty(1), { status: "awarded", jobId: 4, awardedAgentId: 7 }, "BOB's re-included hire is the link, not CAROL's job 3");
  chain.jobs.set(3, jobStruct(3, CAROL));
  chain.block(103, [log(escIface, ESC, "JobCompleted", [3, 9, 1, 5], tx("c4"))]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(1), { status: "awarded", jobId: 4, awardedAgentId: 7 }, "CAROL's completed job does not complete BOB's bounty");

  // a hire the chain drops for good: the poster's award stays, without the job, and the next hire links
  award(2, 7, 5);
  chain.jobs.set(5, job(2, 1));
  chain.block(104, [hire(5, 2, "b5")]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(2), { status: "awarded", jobId: 5, awardedAgentId: 7 });
  chain.reorgFrom(104);
  chain.jobs.delete(5);
  chain.block(105);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT 1 FROM jobs WHERE id = 5").get(), undefined);
  assert.deepEqual(bounty(2), { status: "awarded", jobId: null, awardedAgentId: 7 });
  chain.jobs.set(5, job(2, 1));
  chain.block(106, [hire(5, 2, "b6")]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(2), { status: "awarded", jobId: 5, awardedAgentId: 7 });
});

// fmx_bounty_award with hire=true awards first (no job yet), then hires citing the bounty: the auto-link only filled
// in the job, but its rollback reopened the bounty and erased the poster's award.
test("indexer: a reorg that drops a hire linked to a bounty the poster had already awarded puts that award back", async () => {
  const { db, chain, ctx, activity } = setup();
  db.prepare("INSERT INTO bounties (id, poster, title, brief, rewardWei, createdAt, updatedAt) VALUES (1, ?, 'Index the archive', 'brief', '5', 1, 1)").run(BOB);
  const bounty = () => db.prepare("SELECT status, jobId, awardedAgentId, awardedAt, completedAt FROM bounties WHERE id = 1").get();
  const bountyActivity = () => db.prepare("SELECT type, dedupKey FROM activity WHERE type LIKE 'bounty.%' ORDER BY id").all().map((r) => `${r.type}${r.dedupKey ? " (via job)" : ""}`);
  db.prepare("UPDATE bounties SET status = 'awarded', awardedAgentId = 8, awardedAt = 5, updatedAt = 5 WHERE id = 1").run();
  activity.emit("bounty.award", { actor: BOB, ref: { kind: "bounty", id: 1 }, data: { bountyId: 1, agentId: 8, jobId: null } });
  chain.agents.set(7, agentStruct(ALICE));
  chain.jobs.set(3, { ...jobStruct(1), inputURI: "fmx://bounty/1" });
  chain.block(101, [log(escIface, ESC, "JobRequested", [3, 7, BOB, 10, "0x" + "11".repeat(32), "fmx://bounty/1"], tx("a3"))]);
  await indexOnce(ctx);
  assert.deepEqual(bounty(), { status: "awarded", jobId: 3, awardedAgentId: 7, awardedAt: 5, completedAt: null });
  assert.deepEqual(bountyActivity(), ["bounty.award", "bounty.award (via job)"]);

  chain.reorgFrom(101);
  chain.jobs.delete(3);
  chain.block(102);
  await indexOnce(ctx);
  assert.deepEqual(bounty(), { status: "awarded", jobId: null, awardedAgentId: 8, awardedAt: 5, completedAt: null }, "the poster's award, as it was before the hire");
  assert.deepEqual(bountyActivity(), ["bounty.award"]);
});

// onJobEvent also runs applyJobToArena and applyJobToReferrals, and neither the re-read nor a later event undid them:
// a challenge kept the award link of a hire the chain dropped (blocking the re-included hire), and a referral stayed
// eligible for a completion the chain no longer had, which the payout worker pays in FMX.
test("indexer: a reorg takes back the arena award link and the referral eligibility its removed job events made", async () => {
  const { db, chain, ctx, activity } = setup();
  const CAROL = "0x00000000000000000000000000000000000CA401";
  const ts = (n) => 1_758_000_000 + n * 7; // the scripted chain's block timestamps
  chain.agents.set(7, agentStruct(ALICE));

  // arena: BOB's hire citing his closed challenge links as its award, until the reorg drops it
  db.prepare("INSERT INTO arena_challenges (id, creator, title, brief, endsAt, createdAt) VALUES (1, ?, 'Best summary', 'brief', ?, 1)").run(BOB, ts(0));
  db.prepare("INSERT INTO arena_challenges (id, creator, title, brief, endsAt, createdAt, awardedAgentId, jobId, awardedAt, closedAt) VALUES (2, ?, 'Best index', 'brief', ?, 1, 7, 5, 9, ?)").run(BOB, ts(0), ts(0));
  const challenge = (id) => db.prepare("SELECT awardedAgentId, jobId, awardedAt, closedAt FROM arena_challenges WHERE id = ?").get(id);
  const arenaJob = (challengeId) => ({ ...jobStruct(1), inputURI: `fmx://arena/${challengeId}` });
  const arenaHire = (id, challengeId, txTag) => log(escIface, ESC, "JobRequested", [id, 7, BOB, 10, "0x" + "11".repeat(32), `fmx://arena/${challengeId}`], tx(txTag));
  chain.jobs.set(3, arenaJob(1));
  chain.jobs.set(5, arenaJob(2)); // challenge 2: BOB's own award named job 5 before the indexer saw it
  chain.block(101, [arenaHire(3, 1, "a3"), arenaHire(5, 2, "a5")]);
  await indexOnce(ctx);
  assert.deepEqual(challenge(1), { awardedAgentId: 7, jobId: 3, awardedAt: ts(101), closedAt: ts(0) });
  assert.deepEqual(challenge(2), { awardedAgentId: 7, jobId: 5, awardedAt: 9, closedAt: ts(0) });
  chain.reorgFrom(101);
  chain.jobs.delete(3);
  chain.jobs.delete(5);
  chain.block(102);
  await indexOnce(ctx);
  assert.deepEqual(challenge(1), { awardedAgentId: null, jobId: null, awardedAt: null, closedAt: null }, "back to the challenge the hire found");
  assert.deepEqual(challenge(2), { awardedAgentId: 7, jobId: null, awardedAt: 9, closedAt: ts(0) }, "BOB's award stays, without the job the chain dropped");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity WHERE type = 'arena.award'").get().c, 0);
  chain.jobs.set(4, arenaJob(1));
  chain.block(103, [arenaHire(4, 1, "a4")]);
  await indexOnce(ctx);
  assert.deepEqual(challenge(1), { awardedAgentId: 7, jobId: 4, awardedAt: ts(103), closedAt: ts(0) }, "the hire re-included as job 4 links");

  // referrals: agent 7 (ALICE's) was referred by CAROL's agent 8; BOB, a third party, pays it 10 FMX
  db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts) VALUES (7, 8, ?, ?, 1)").run(ALICE, CAROL);
  const referral = () => db.prepare("SELECT eligibleAt, jobId, paid, reorgFlag FROM referrals WHERE newAgentId = 7").get();
  const paidJob = (status) => ({ ...jobStruct(status), amount: 10n ** 19n });
  const completed = (txTag) => log(escIface, ESC, "JobCompleted", [6, 9, 1, 5], tx(txTag));
  const sent = [];
  const payout = new ReferralPayout({ db, activity, provider: null, nowS: () => 1_758_400_000, txCounts: async () => [sent.length, sent.length], send: async (to, _value, nonce) => (sent.push(to), `0xp${nonce}`) });
  chain.jobs.set(6, paidJob(1));
  chain.block(104, [log(escIface, ESC, "JobRequested", [6, 7, BOB, 10n ** 19n, "0x" + "11".repeat(32), "fmx://in"], tx("b6"))]);
  await indexOnce(ctx);
  chain.jobs.set(6, paidJob(3));
  chain.block(105, [completed("c1")]);
  await indexOnce(ctx);
  assert.deepEqual(referral(), { eligibleAt: ts(105), jobId: 6, paid: 0, reorgFlag: null });

  // the completion is reorged out before the worker ran: nothing is earned, nothing is paid
  chain.reorgFrom(105);
  chain.jobs.set(6, paidJob(2));
  chain.block(106);
  await indexOnce(ctx);
  assert.deepEqual(referral(), { eligibleAt: null, jobId: null, paid: 0, reorgFlag: null });
  assert.equal(await payout.tick(), 0);
  assert.deepEqual(sent, []);

  // completed on the winning branch: earned again, and paid
  chain.jobs.set(6, paidJob(3));
  chain.block(107, [completed("c2")]);
  await indexOnce(ctx);
  assert.deepEqual(referral(), { eligibleAt: ts(107), jobId: 6, paid: 0, reorgFlag: null });
  assert.equal(await payout.tick(), 1);
  assert.deepEqual(sent, [ALICE, CAROL]);

  // reorged out after the payout: the FMX is on chain, so the row stays paid and is flagged for review...
  chain.reorgFrom(107);
  chain.jobs.set(6, paidJob(2));
  chain.block(108);
  await indexOnce(ctx);
  assert.equal(referral().paid, 1);
  assert.match(referral().reorgFlag, /completion of job 6 \(block 107\) was reorged out after this payout was sent/);
  // ...until the job completes again
  chain.jobs.set(6, paidJob(3));
  chain.block(109, [completed("c3")]);
  await indexOnce(ctx);
  assert.deepEqual(referral(), { eligibleAt: ts(107), jobId: 6, paid: 1, reorgFlag: null });
  assert.deepEqual(sent, [ALICE, CAROL], "paid once");
});

// The 12-block re-scan used to retry a failed read as a side effect. Once a tick re-applies only diverging blocks,
// the events row matches the chain and its log never reaches a handler again: the read has to be queued.
test("indexer: an agent / job read that fails on a transient RPC error is made again on a later tick", async () => {
  const { db, chain, ctx } = setup();
  chain.agents.set(7, agentStruct(ALICE));
  chain.jobs.set(3, jobStruct(1));
  const failures = { agent: 2, job: 2 }; // the read at the event and the retry in the same tick both fail
  const getAgent = ctx.registry.getAgent;
  const getJob = ctx.escrow.getJob;
  ctx.registry.getAgent = async (id, o) => {
    if (failures.agent-- > 0) throw new Error("read ECONNRESET");
    return getAgent(id, o);
  };
  ctx.escrow.getJob = async (id, o) => {
    if (failures.job-- > 0) throw new Error("request timeout");
    return getJob(id, o);
  };
  chain.block(100, [log(regIface, REG, "AgentRegistered", [7, ALICE, "Scribe", "https://scribe.example", "", 0, 0], tx("a1"))]);
  chain.block(101, [log(escIface, ESC, "JobRequested", [3, 7, BOB, 10, "0x" + "11".repeat(32), "fmx://in"], tx("a3"))]);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT 1 FROM agents WHERE id = 7").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM jobs WHERE id = 3").get(), undefined);

  chain.block(102);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT name FROM agents WHERE id = 7").get()?.name, "Scribe");
  assert.deepEqual(db.prepare("SELECT status, txRequested FROM jobs WHERE id = 3").get(), { status: 1, txRequested: tx("a3") });
  assert.deepEqual(db.prepare("SELECT type FROM activity ORDER BY id").all().map((r) => r.type), ["agent.registered", "job.requested"], "the hooks ran too");

  const before = { ...chain.calls };
  chain.block(103);
  await indexOnce(ctx);
  assert.deepEqual([chain.calls.getAgent, chain.calls.getJob], [before.getAgent, before.getJob], "nothing left to retry");
});

test("indexer: a re-read after a rollback that fails is made again on a later tick", async () => {
  const { db, chain, ctx } = setup();
  chain.agents.set(7, agentStruct(ALICE));
  chain.block(100, [log(regIface, REG, "AgentRegistered", [7, ALICE, "Scribe", "https://scribe.example", "", 0, 0], tx("a1"))]);
  chain.block(101);
  await indexOnce(ctx);
  assert.ok(db.prepare("SELECT 1 FROM agents WHERE id = 7").get());

  // the registration is reorged out, and the read that should drop the row fails (twice: rederive and its retry)
  chain.reorgFrom(100);
  chain.agents.delete(7);
  chain.block(102);
  let failures = 2;
  const getAgent = ctx.registry.getAgent;
  ctx.registry.getAgent = async (id, o) => {
    if (failures-- > 0) throw new Error("read ECONNRESET");
    return getAgent(id, o);
  };
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 0);
  chain.block(103);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT 1 FROM agents WHERE id = 7").get(), undefined, "the registry no longer knows agent 7");
});

test("indexer: rows indexed before block hashes were recorded are matched, filled in, and not rolled back", async () => {
  const { db, chain, ctx } = setup();
  chain.block(100, [log(streamIface, STREAM, "StreamOpened", [5, ALICE, BOB, 1, 1000, 1, 1001], tx("a2"))]);
  chain.block(101, [log(streamIface, STREAM, "StreamClaimed", [5, 300, 0], tx("a3"))]);
  await indexOnce(ctx);
  db.prepare("UPDATE events SET blockHash = NULL").run();
  const reads = chain.calls.getBlock;
  chain.block(102);
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT claimed FROM streams WHERE id = 5").get().claimed, "300");
  assert.equal(chain.calls.getBlock, reads, "nothing re-applied");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events WHERE blockHash IS NULL").get().c, 0);
});

test("indexer: rows a dead tick wrote past its recorded progress are applied once, not twice or never", async () => {
  const { db, chain, ctx } = setup();
  chain.block(100, [log(streamIface, STREAM, "StreamOpened", [5, ALICE, BOB, 1, 1000, 1, 1001], tx("a2"))]);
  chain.block(101, [log(streamIface, STREAM, "StreamClaimed", [5, 300, 0], tx("a3"))]);
  await indexOnce(ctx);
  db.prepare("UPDATE meta SET value = '100' WHERE key = 'indexedBlock'").run(); // as if it died before recording 101
  await indexOnce(ctx);
  assert.equal(db.prepare("SELECT claimed FROM streams WHERE id = 5").get().claimed, "300");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 2);
});

test("indexer: a head behind the indexed height waits instead of indexing backwards", async () => {
  const { db, chain, ctx } = setup();
  chain.block(100, [log(streamIface, STREAM, "StreamOpened", [5, ALICE, BOB, 1, 1000, 1, 1001], tx("a2"))]);
  chain.block(110);
  await indexOnce(ctx);
  chain.head = 105; // a lagging node
  assert.deepEqual(await indexOnce(ctx), { head: 105, indexedBlock: 110 });
  assert.ok(db.prepare("SELECT 1 FROM streams WHERE id = 5").get());
});
