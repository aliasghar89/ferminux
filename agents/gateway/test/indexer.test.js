// Indexer reorg handling against a scripted chain: the window is the chain's 64-block reorg cap, a reorg rolls
// back what was derived from the blocks it replaced (events, state rows, activity, unsent webhooks, v3_counted
// increments), a tx re-included at another logIndex counts once, and a quiet tick re-runs no handler.
import test from "node:test";
import assert from "node:assert/strict";
import { Interface, ZeroAddress, getAddress } from "ethers";
import { openMemoryDb } from "../dist/db.js";
import { indexOnce, REORG_DEPTH } from "../dist/indexer.js";
import { REGISTRY_ABI, ESCROW_ABI } from "../dist/abi.js";
import { v3Interface } from "../dist/abi-v3.js";
import { ActivityBus } from "../dist/commons/activity.js";
import { makeIndexerHooks } from "../dist/commons/hooks.js";
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
