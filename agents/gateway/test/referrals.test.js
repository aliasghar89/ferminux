// Growth — referral programme: claim, eligibility on first completed job,
// payout worker (injected sender), leaderboard with pending/paid counts.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, parseEther } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb, getMeta, setMeta } from "../dist/db.js";
import { REORG_DEPTH } from "../dist/indexer.js";
import { canonicalMessage } from "../dist/commons/sign.js";
import { ReferralPayout, applyJobToReferrals, revertJobOnReferrals } from "../dist/commons/referrals.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1",
  registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F",
  escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0,
  dataDir: ":memory:",
  port: 0,
  publicUrl: "https://ferminux.net",
  pollMs: 1e9,
  probeMs: 1e9,
  toolProbeMs: 1e9,
  referralRewardFmx: "10",
  referralTickMs: 1e9,
  referralMinJobFmx: "5",
  referralMaxPerReferrerPerDay: 5,
  referralMaxPerDay: 50,
};

const toolbox = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // owns agent 1 (referrer)
const newbie = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // owns agent 12 (referred)
const client = new Wallet("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

async function setup() {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  const ins = db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(1, toolbox.address, "Toolbox", "https://toolbox.example", 1, 1_758_000_000);
  ins.run(12, newbie.address, "Newbie", "https://newbie.example", 1, 1_758_399_000);
  ins.run(13, toolbox.address, "Toolbox 2", "https://toolbox2.example", 1, 1_758_399_100);
  const { app, activity, indexerHooks } = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {} } });
  await app.ready();
  const clock = { s: () => Math.floor(nowMs / 1000), advance: (ms) => (nowMs += ms) };
  async function signed(wallet, action, payload) {
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  }
  const post = async (wallet, payload) => {
    clock.advance(1100);
    return app.inject({ method: "POST", url: "/api/referrals", headers: { "content-type": "application/json" }, payload: JSON.stringify(await signed(wallet, "referral.claim", payload)) });
  };
  const get = async (url) => (await app.inject({ method: "GET", url })).json();
  // the indexer's head: a completion is paid once the block of its recorded JobCompleted log is REORG_DEPTH blocks
  // under it. The indexer records that log before it runs the hook: `completed` records one (at the head by default).
  setMeta(db, "indexedBlock", "1000");
  const head = () => Number(getMeta(db, "indexedBlock"));
  let logs = 0;
  const indexer = {
    advance: (n) => setMeta(db, "indexedBlock", String(head() + n)),
    completed: (jobId, block = head()) =>
      db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, 0, ?, 'escrow', 'JobCompleted', ?, ?)").run(`0xc${++logs}`, block, JSON.stringify({ jobId: String(jobId) }), clock.s()),
    reorged: (jobId) => db.prepare("DELETE FROM events WHERE eventName = 'JobCompleted' AND json_extract(argsJSON, '$.jobId') = ?").run(String(jobId)),
  };
  return { app, db, activity, indexerHooks, clock, post, get, indexer };
}

test("referrals", async (t) => {
  const { app, db, activity, indexerHooks, clock, post, get, indexer } = await setup();
  t.after(() => app.close());

  await t.test("leaderboard is empty and advertises the reward + payout state", async () => {
    const lb = await get("/api/referrals/leaderboard");
    assert.deepEqual(lb.items, []);
    assert.equal(lb.rewardWei, parseEther("10").toString());
    assert.equal(lb.rewardFmx, "10");
    assert.equal(lb.payoutEnabled, false);
    assert.deepEqual(lb.totals, { referred: 0, paid: 0, pending: 0 });
  });

  await t.test("claim validation", async () => {
    assert.equal((await post(newbie, { newAgentId: 12, ref: 12 })).statusCode, 400); // self
    assert.equal((await post(toolbox, { newAgentId: 13, ref: 1 })).statusCode, 400); // same owner
    assert.equal((await post(toolbox, { newAgentId: 12, ref: 1 })).statusCode, 403); // not the owner of 12
    assert.equal((await post(newbie, { newAgentId: 12, ref: 999 })).statusCode, 404); // unknown referrer
    assert.equal((await post(newbie, { newAgentId: 12 })).statusCode, 400); // missing ref
  });

  await t.test("the new agent's owner claims the referral once", async () => {
    const r = await post(newbie, { newAgentId: 12, ref: 1 });
    assert.equal(r.statusCode, 201, r.body);
    const v = r.json();
    assert.equal(v.status, "registered");
    assert.equal(v.refAgentName, "Toolbox");
    assert.equal(v.newOwner.address, newbie.address);
    assert.equal(v.refOwner.address, toolbox.address);
    assert.equal((await post(newbie, { newAgentId: 12, ref: 1 })).statusCode, 409); // already referred
    assert.equal((await get("/api/referrals/12")).status, "registered");
    assert.ok(activity.list({ type: "referral.claim" }).length === 1);
  });

  await t.test("self-dealing jobs never qualify: paid by an owner, by an owner's AgentAccount, or below the minimum", async () => {
    const ins = db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)");
    ins.run(490, 12, toolbox.address, parseEther("50").toString(), 3, clock.s()); // referrer hires the referred agent
    ins.run(491, 12, newbie.address, parseEther("50").toString(), 3, clock.s()); // referred owner hires itself
    ins.run(492, 12, client.address, parseEther("4.99").toString(), 3, clock.s()); // outside client, but under REFERRAL_MIN_JOB_FMX
    const acct = "0x00000000000000000000000000000000000000AA";
    db.prepare("INSERT INTO agent_accounts (account, owner, createdAt) VALUES (?, ?, ?)").run(acct, toolbox.address, clock.s());
    ins.run(493, 12, acct, parseEther("50").toString(), 3, clock.s()); // referrer's AgentAccount hires the referred agent
    for (const id of [490, 491, 492, 493]) {
      indexer.completed(id, 1);
      indexerHooks.onJobEvent({ jobId: id, eventName: "JobCompleted", args: {}, ts: clock.s(), txHash: `0x0${id}`, logIndex: 0, blockNumber: 1 });
    }
    assert.equal((await get("/api/referrals/12")).status, "registered");
    assert.equal((await get("/api/referrals/leaderboard")).minJobFmx, "5");
  });

  await t.test("first qualifying completed job (third-party client, ≥ 5 FMX) makes the referral pending (earned, unpaid)", async () => {
    db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(501, 12, client.address, parseEther("5").toString(), 1, clock.s());
    indexerHooks.onJobEvent({ jobId: 501, eventName: "JobRequested", args: {}, ts: clock.s(), txHash: "0x01", logIndex: 0, blockNumber: 1 });
    assert.equal((await get("/api/referrals/12")).status, "registered");
    db.prepare("UPDATE jobs SET status = 3 WHERE id = 501").run(); // Completed
    indexer.completed(501, 2);
    indexerHooks.onJobEvent({ jobId: 501, eventName: "JobCompleted", args: { rating: 5 }, ts: clock.s(), txHash: "0x02", logIndex: 0, blockNumber: 2 });
    const v = await get("/api/referrals/12");
    assert.equal(v.status, "pending");
    assert.equal(v.jobId, 501);
    const mine = await get("/api/referrals/by/1");
    assert.equal(mine.total, 1);
    assert.equal(mine.pending, 1);
    assert.equal(mine.items[0].newAgentId, 12);
    const lb = await get("/api/referrals/leaderboard");
    assert.equal(lb.items[0].agentId, 1);
    assert.equal(lb.items[0].earned, 1);
    assert.equal(lb.items[0].pending, 1);
    assert.equal(lb.items[0].paid, 0);
    assert.deepEqual(lb.totals, { referred: 1, paid: 0, pending: 1 });
    // a second completed job changes nothing
    indexer.completed(502);
    applyJobToReferrals(db, activity, { id: 502, agentId: 12, status: 3, client: client.address, amount: parseEther("9").toString() }, clock.s());
    assert.equal((await get("/api/referrals/12")).jobId, 501);
  });

  await t.test("payout worker: no key → no-op; injected sender pays both owners once", async () => {
    const idle = new ReferralPayout({ db, activity, provider: null, nowS: clock.s });
    assert.equal(idle.enabled, false);
    assert.equal(await idle.tick(), 0);
    assert.equal((await get("/api/referrals/12")).status, "pending");

    const sent = [];
    let next = 7; // growth wallet's next nonce
    const payer = new ReferralPayout({ db, activity, provider: null, rewardFmx: "10", nowS: clock.s, txCounts: async () => [next, next], send: async (to, value, nonce) => { sent.push([to, value, nonce]); next++; return `0xtx${sent.length}`; } });
    assert.equal(payer.enabled, true);
    assert.equal(await payer.tick(), 1);
    assert.deepEqual(sent, [[newbie.address, parseEther("10"), 7], [toolbox.address, parseEther("10"), 8]]); // explicit, reserved nonces
    const v = await get("/api/referrals/12");
    assert.equal(v.status, "paid");
    assert.equal(v.txNew, "0xtx1");
    assert.equal(v.txRef, "0xtx2");
    assert.equal((await get("/api/referrals/by/1")).paidWei, parseEther("10").toString());
    assert.equal(await payer.tick(), 0); // idempotent
    assert.equal(sent.length, 2);
    const lb = await get("/api/referrals/leaderboard");
    assert.equal(lb.items[0].paid, 1);
    assert.equal(lb.items[0].paidWei, parseEther("10").toString());
    assert.equal(activity.list({ type: "referral.paid" }).length, 1);
  });

  await t.test("a failed second transfer is retried without re-sending the first", async () => {
    db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(14, client.address, "Third", "https://third.example", 1, clock.s());
    assert.equal((await post(client, { newAgentId: 14, ref: 1 })).statusCode, 201);
    indexer.completed(601);
    applyJobToReferrals(db, activity, { id: 601, agentId: 14, status: 3, client: newbie.address, amount: parseEther("5").toString() }, clock.s());
    indexer.advance(REORG_DEPTH); // the completion is out of a reorg's reach
    let calls = 0;
    const flaky = new ReferralPayout({ db, activity, provider: null, nowS: clock.s, send: async () => { calls++; if (calls === 2) throw new Error("rpc down"); return `0xf${calls}`; } });
    assert.equal(await flaky.tick(), 0);
    let v = await get("/api/referrals/14");
    assert.equal(v.status, "pending");
    assert.equal(v.txNew, "0xf1");
    assert.equal(v.txRef, null);
    assert.equal(await flaky.tick(), 1);
    v = await get("/api/referrals/14");
    assert.equal(v.status, "paid");
    assert.equal(v.txNew, "0xf1");
    assert.equal(v.txRef, "0xf3");
    assert.equal(calls, 3);
  });

  await t.test("crash between send and record: the reserved nonce is checked on-chain, never re-sent once mined", async () => {
    const owner = new Wallet("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
    db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(15, owner.address, "Fourth", "https://fourth.example", 1, clock.s());
    assert.equal((await post(owner, { newAgentId: 15, ref: 1 })).statusCode, 201);
    indexer.completed(701);
    applyJobToReferrals(db, activity, { id: 701, agentId: 15, status: 3, client: client.address, amount: parseEther("5").toString() }, clock.s());
    // simulate: nonce 20 was reserved for the first leg and the tx broadcast, then the process died before txNew was written
    db.prepare("UPDATE referrals SET nonceNew = 20 WHERE newAgentId = 15").run();
    indexer.advance(REORG_DEPTH);
    const sent = [];
    const w = new ReferralPayout({ db, activity, provider: null, nowS: clock.s, txCounts: async () => [21, 21], send: async (to, value, nonce) => { sent.push(nonce); return `0xr${nonce}`; } });
    assert.equal(await w.tick(), 1);
    assert.deepEqual(sent, [21]); // only the second leg went out; the first was recovered from the chain
    const v = await get("/api/referrals/15");
    assert.equal(v.status, "paid");
    assert.equal(v.txNew, "recovered:nonce:20");
    assert.equal(v.txRef, "0xr21");
  });

  await t.test("daily caps: per referrer and network-wide; deferred rows stay pending with a reason", async () => {
    const ins = db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)");
    const wallets = [];
    for (let i = 0; i < 3; i++) {
      const w = Wallet.createRandom();
      wallets.push(w);
      ins.run(20 + i, w.address, `Ref ${i}`, "https://r.example", 1, clock.s());
      assert.equal((await post(w, { newAgentId: 20 + i, ref: 1 })).statusCode, 201);
      indexer.completed(800 + i);
      applyJobToReferrals(db, activity, { id: 800 + i, agentId: 20 + i, status: 3, client: client.address, amount: parseEther("5").toString() }, clock.s());
    }
    indexer.advance(REORG_DEPTH);
    // toolbox (agent 1's owner) already has 3 paid today → cap 4 leaves room for exactly one more
    const sent = [];
    const capped = new ReferralPayout({ db, activity, provider: null, nowS: clock.s, maxPerReferrerPerDay: 4, maxPerDay: 50, txCounts: async () => [0, 0], send: async (to) => { sent.push(to); return `0xc${sent.length}`; } });
    assert.equal(await capped.tick(), 1);
    assert.equal((await get("/api/referrals/20")).status, "paid");
    const deferred = await get("/api/referrals/21");
    assert.equal(deferred.status, "pending");
    assert.match(db.prepare("SELECT error FROM referrals WHERE newAgentId = 21").get().error, /daily payout cap/);
    // next UTC day the per-referrer cap resets; a network-wide cap of 1 admits exactly one more
    clock.advance(86_400_000);
    const global = new ReferralPayout({ db, activity, provider: null, nowS: clock.s, maxPerReferrerPerDay: 5, maxPerDay: 1, txCounts: async () => [0, 0], send: async (to) => { sent.push(to); return `0xg${sent.length}`; } });
    assert.equal(await global.tick(), 1);
    assert.equal((await get("/api/referrals/21")).status, "paid");
    assert.equal((await get("/api/referrals/22")).status, "pending");
  });

  // A reorg can take a row's eligibility back (revertJobOnReferrals) while a tick that already selected it awaits its
  // nonce read: the transfer must not go out for it.
  await t.test("a row whose eligibility a reorg takes back mid-tick is not paid", async () => {
    const owner = Wallet.createRandom();
    db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(30, owner.address, "Fifth", "https://fifth.example", 1, clock.s());
    clock.advance(86_400_000); // a fresh UTC day: the caps leave room
    assert.equal((await post(owner, { newAgentId: 30, ref: 1 })).statusCode, 201);
    indexer.completed(901);
    applyJobToReferrals(db, activity, { id: 901, agentId: 30, status: 3, client: client.address, amount: parseEther("5").toString() }, clock.s());
    indexer.advance(REORG_DEPTH); // deep enough to pay: only the rollback stops it
    const sent = [];
    const racing = new ReferralPayout({
      db,
      activity,
      provider: null,
      nowS: clock.s,
      txCounts: async () => {
        db.prepare("UPDATE referrals SET eligibleAt = NULL, jobId = NULL WHERE newAgentId = 30").run(); // what the rollback writes
        return [40, 40];
      },
      send: async (to, value, nonce) => (sent.push(to), `0xz${sent.length}`),
    });
    await racing.tick(); // rows still pending from the caps test above may be paid; agent 30's must not
    assert.equal(sent.includes(owner.address), false);
    const row = db.prepare("SELECT paid, nonceNew, txNew FROM referrals WHERE newAgentId = 30").get();
    assert.deepEqual({ ...row }, { paid: 0, nonceNew: null, txNew: null });
  });

  // A reorg that removes the completion behind a payout that has started only flags the row (revertJobOnReferrals),
  // and the worker went on to send what it had not sent yet: the second leg, or both legs again on a reserved nonce
  // whose send had failed, all for a job the winning branch does not complete.
  await t.test("a payout a reorg flags is held: no leg it has not sent goes out until the job is completed again", async () => {
    clock.advance(86_400_000); // a fresh UTC day: the caps leave room
    const owners = {};
    for (const id of [31, 32, 33]) {
      owners[id] = Wallet.createRandom();
      db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(id, owners[id].address, `Agent ${id}`, "https://a.example", 1, clock.s());
      assert.equal((await post(owners[id], { newAgentId: id, ref: 1 })).statusCode, 201);
    }
    const complete = (agentId, jobId) => (indexer.completed(jobId), applyJobToReferrals(db, activity, { id: jobId, agentId, status: 3, client: client.address, amount: parseEther("5").toString() }, clock.s()));
    const row = (id) => ({ ...db.prepare("SELECT paid, txNew, txRef, nonceNew, nonceRef, reorgFlag IS NOT NULL AS flagged FROM referrals WHERE newAgentId = ?").get(id) });
    let next = 50; // growth wallet's next nonce: a send that returns is confirmed at once
    const sent = [];
    const payout = (hooks = {}) =>
      new ReferralPayout({
        db,
        activity,
        provider: null,
        nowS: clock.s,
        txCounts: async () => (hooks.txCounts?.(), [next, next]),
        send: async (to, value, nonce) => {
          if (hooks.fails?.(to)) throw new Error("rpc timeout");
          sent.push([to, nonce]);
          next++;
          return `0xh${nonce}`;
        },
      });

    // the reorg lands while the second leg awaits its nonce: the first leg is on chain, the second does not go out
    complete(31, 931);
    indexer.advance(REORG_DEPTH);
    await payout({ txCounts: () => row(31).txNew && !row(31).flagged && revertJobOnReferrals(db, "JobCompleted", 931, 500) }).tick();
    assert.deepEqual(sent, [[owners[31].address, 50]]);
    assert.deepEqual(row(31), { paid: 0, txNew: "0xh50", txRef: null, nonceNew: 50, nonceRef: null, flagged: 1 });

    // the first leg's send failed (nothing on chain) with its nonce reserved, then the reorg: neither leg goes out
    complete(32, 932);
    indexer.advance(REORG_DEPTH);
    await payout({ fails: (to) => to === owners[32].address }).tick();
    assert.deepEqual(row(32), { paid: 0, txNew: null, txRef: null, nonceNew: 51, nonceRef: null, flagged: 0 });
    revertJobOnReferrals(db, "JobCompleted", 932, 501);
    indexer.reorged(932);
    assert.equal(row(32).flagged, 1);
    await payout().tick();
    await payout().tick();
    assert.deepEqual(sent, [[owners[31].address, 50]], "a flagged payout is held for review");

    // another payout takes the nonce the held one never used
    complete(33, 933);
    indexer.advance(REORG_DEPTH);
    assert.equal(await payout().tick(), 1);
    assert.deepEqual(sent.slice(1), [[owners[33].address, 51], [toolbox.address, 52]]);

    // the winning branch completes job 932 again: the held payout resumes on a fresh nonce, not on the one row 33 used
    complete(32, 932);
    assert.equal(row(32).flagged, 0);
    assert.equal(await payout().tick(), 0, "that completion waits for its own depth");
    indexer.advance(REORG_DEPTH);
    assert.equal(await payout().tick(), 1);
    assert.deepEqual(sent.slice(3), [[owners[32].address, 53], [toolbox.address, 54]]);
    assert.deepEqual(row(32), { paid: 1, txNew: "0xh53", txRef: "0xh54", nonceNew: 53, nonceRef: 54, flagged: 0 });
    assert.deepEqual(row(31), { paid: 0, txNew: "0xh50", txRef: null, nonceNew: 50, nonceRef: null, flagged: 1 }, "still held");
  });

  await t.test("openapi documents the referral routes + action", async () => {
    const spec = await get("/api/openapi.json");
    assert.ok(spec.paths["/api/referrals"].post);
    assert.ok(spec.paths["/api/referrals/leaderboard"].get);
    assert.equal(spec["x-ferminux-signing"].actions["POST /api/referrals"].startsWith("referral.claim"), true);
    assert.ok(spec["x-ferminux-signing"].allActions.includes("referral.claim"));
  });
});

// reorgFlag shipped after the referrals table: a database deployed before it gains the column, and migrating twice is a no-op.
test("migrateGrowth adds reorgFlag to a referrals table created before it existed", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrateGrowth } = await import("../dist/commons/schema.js");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE referrals (newAgentId INTEGER PRIMARY KEY, refAgentId INTEGER NOT NULL, newOwner TEXT NOT NULL, refOwner TEXT NOT NULL, ts INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, eligibleAt INTEGER, jobId INTEGER, paidAt INTEGER, txNew TEXT, txRef TEXT, rewardWei TEXT, error TEXT, nonceNew INTEGER, nonceRef INTEGER)");
  db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts, paid) VALUES (7, 8, '0xa', '0xb', 1, 1)").run();
  migrateGrowth(db);
  migrateGrowth(db);
  assert.ok(db.prepare("PRAGMA table_info(referrals)").all().some((c) => c.name === "reorgFlag"));
  assert.deepEqual({ ...db.prepare("SELECT paid, reorgFlag FROM referrals WHERE newAgentId = 7").get() }, { paid: 1, reorgFlag: null });
});

// The worker paid a referral within 30 s of the JobCompleted that made it eligible, while that block was still inside
// the indexer's reorg window: a reorg that then dropped the completion could only flag the FMX already sent.
test("referral payout waits until the completion is REORG_DEPTH blocks under the indexed head", async () => {
  const { ActivityBus } = await import("../dist/commons/activity.js");
  const db = openMemoryDb();
  const activity = new ActivityBus(db, () => 1_758_400_000_000);
  const head = (n) => setMeta(db, "indexedBlock", String(n));
  const job = (id, agentId) => ({ id, agentId, status: 3, client: client.address, amount: parseEther("5").toString() });
  const refer = (agentId, owner) => db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts) VALUES (?, 1, ?, ?, 1)").run(agentId, owner, toolbox.address);
  const row = (agentId) => ({ ...db.prepare("SELECT paid, eligibleAt IS NOT NULL AS eligible, eligibleBlock FROM referrals WHERE newAgentId = ?").get(agentId) });
  // the indexer records a JobCompleted log, then runs the hook; a rollback deletes it
  const logged = (id, block) => db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, 0, ?, 'escrow', 'JobCompleted', ?, 1)").run(`0xc${id}b${block}`, block, JSON.stringify({ jobId: String(id) }));
  const reorged = (id, block) => (revertJobOnReferrals(db, "JobCompleted", id, block), db.prepare("DELETE FROM events WHERE txHash = ?").run(`0xc${id}b${block}`));
  const sent = [];
  const payout = new ReferralPayout({ db, activity, provider: null, nowS: () => 1_758_400_000, txCounts: async () => [sent.length, sent.length], send: async (to) => (sent.push(to), `0xs${sent.length}`) });

  // job 6 completes at the head; a 10-block reorg drops the completion before it is deep: nothing went out for it
  refer(7, newbie.address);
  head(2000);
  logged(6, 2000);
  applyJobToReferrals(db, activity, job(6, 7), 1);
  assert.deepEqual(row(7), { paid: 0, eligible: 1, eligibleBlock: 2000 });
  assert.equal(await payout.tick(), 0);
  head(2010);
  assert.equal(await payout.tick(), 0);
  reorged(6, 2000);
  assert.deepEqual(row(7), { paid: 0, eligible: 0, eligibleBlock: null });
  assert.deepEqual(sent, []);

  // completed on the winning branch at block 2005: not paid 63 blocks under the head, paid 64 under it
  logged(6, 2005);
  applyJobToReferrals(db, activity, job(6, 7), 2);
  head(2005 + REORG_DEPTH - 1);
  assert.equal(await payout.tick(), 0);
  head(2005 + REORG_DEPTH);
  assert.equal(await payout.tick(), 1);
  assert.deepEqual(sent, [newbie.address, toolbox.address]);

  // an earlier event of job 8 reads it Completed (the job read at its latest state): nothing is eligible until its
  // JobCompleted log is applied, and the payout waits on that log's block
  const early = Wallet.createRandom().address;
  refer(8, early);
  applyJobToReferrals(db, activity, job(8, 8), 3);
  assert.deepEqual(row(8), { paid: 0, eligible: 0, eligibleBlock: null });
  logged(8, 2090);
  applyJobToReferrals(db, activity, job(8, 8), 3);
  assert.equal(row(8).eligibleBlock, 2090);
  head(2080 + REORG_DEPTH);
  assert.equal(await payout.tick(), 0);
  head(2090 + REORG_DEPTH);
  assert.equal(await payout.tick(), 1);

  // a row an older gateway made eligible, with no block recorded: the block of its JobCompleted log is looked up
  const legacy = Wallet.createRandom().address;
  refer(9, legacy);
  db.prepare("UPDATE referrals SET eligibleAt = 4, jobId = 9 WHERE newAgentId = 9").run();
  db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES ('0x09', 0, 2150, 'escrow', 'JobCompleted', ?, 4)").run(JSON.stringify({ jobId: "9", agentPayout: "1", fee: "0", rating: "5" }));
  assert.equal(await payout.tick(), 0);
  assert.equal(row(9).eligibleBlock, 2150);
  head(2150 + REORG_DEPTH);
  assert.equal(await payout.tick(), 1);
  assert.deepEqual(sent.slice(-2), [legacy, toolbox.address]);

  // a row a gateway made eligible on a latest-state read, with an earlier event's block and no JobCompleted log
  // recorded: nothing is paid on that block; it waits for the log, then for that log's own depth
  const unlogged = Wallet.createRandom().address;
  refer(10, unlogged);
  db.prepare("UPDATE referrals SET eligibleAt = 5, jobId = 10, eligibleBlock = 2100 WHERE newAgentId = 10").run();
  assert.equal(await payout.tick(), 0);
  assert.deepEqual(row(10), { paid: 0, eligible: 1, eligibleBlock: null });
  logged(10, 2200);
  assert.equal(await payout.tick(), 0);
  assert.equal(row(10).eligibleBlock, 2200);
  head(2200 + REORG_DEPTH);
  assert.equal(await payout.tick(), 1);
  assert.deepEqual(sent.slice(-2), [unlogged, toolbox.address]);
});

// A claim for a job the jobs table already read Completed took the indexed head as its completion's block when no
// JobCompleted log was recorded: mid-backfill (the job read at its latest state) the next chunk moved the head past it,
// and the payout went out for a completion no recorded log backed.
test("a referral claimed for a completed job is eligible only through its recorded JobCompleted log", async (t) => {
  const { app, db, activity, indexerHooks, clock, post, get, indexer } = await setup();
  t.after(() => app.close());
  const sent = [];
  const payout = new ReferralPayout({ db, activity, provider: null, nowS: clock.s, txCounts: async () => [sent.length, sent.length], send: async (to) => (sent.push(to), `0xs${sent.length}`) });
  const ins = db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt) VALUES (?, ?, ?, ?, 3, ?)");

  // job 501 reads Completed, its log is not recorded yet: the claim is registered, and nothing is paid on it
  ins.run(501, 12, client.address, parseEther("5").toString(), clock.s());
  assert.equal((await post(newbie, { newAgentId: 12, ref: 1 })).statusCode, 201);
  assert.equal((await get("/api/referrals/12")).status, "registered");
  indexer.advance(REORG_DEPTH);
  assert.equal(await payout.tick(), 0);
  assert.deepEqual(sent, []);
  // the indexer applies the log: eligible at its block, paid once that block is REORG_DEPTH under the head
  indexer.completed(501);
  indexerHooks.onJobEvent({ jobId: 501, eventName: "JobCompleted", args: {}, ts: clock.s(), txHash: "0x0501", logIndex: 0, blockNumber: 1064 });
  assert.equal((await get("/api/referrals/12")).status, "pending");
  assert.equal(db.prepare("SELECT eligibleBlock FROM referrals WHERE newAgentId = 12").get().eligibleBlock, 1064);
  assert.equal(await payout.tick(), 0);
  indexer.advance(REORG_DEPTH);
  assert.equal(await payout.tick(), 1);
  assert.deepEqual(sent, [newbie.address, toolbox.address]);

  // a job whose log is recorded already makes the claim eligible at once, at that log's block
  const owner = Wallet.createRandom();
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(14, owner.address, "Fourth", "https://fourth.example", 1, clock.s());
  ins.run(502, 14, client.address, parseEther("5").toString(), clock.s());
  indexer.completed(502, 1050);
  assert.equal((await post(owner, { newAgentId: 14, ref: 1 })).statusCode, 201);
  assert.equal((await get("/api/referrals/14")).status, "pending");
  assert.equal(db.prepare("SELECT eligibleBlock FROM referrals WHERE newAgentId = 14").get().eligibleBlock, 1050);
});

// Nonces are per wallet, and a row recorded only the nonce number: after GROWTH_KEY changed, a nonce the new wallet
// reserved matched one the old wallet had paid on, so a transfer broadcast and then lost to a send() timeout (or a crash
// before its hash was written) counted as never sent and went out again on a fresh nonce. A leg in flight when the key
// changed was compared with the new wallet's counts and sent again from it.
test("a GROWTH_KEY change never sends a leg twice: nonces are matched within the wallet that reserved them", async () => {
  const { ActivityBus } = await import("../dist/commons/activity.js");
  const db = openMemoryDb();
  const activity = new ActivityBus(db, () => 1_758_400_000_000);
  setMeta(db, "indexedBlock", String(1000 + REORG_DEPTH));
  const owners = {};
  for (const id of [7, 8, 9]) {
    owners[id] = Wallet.createRandom().address;
    db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts) VALUES (?, 1, ?, ?, 1)").run(id, owners[id], toolbox.address);
    db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, 0, 1000, 'escrow', 'JobCompleted', ?, 1)").run(`0xc${id}`, JSON.stringify({ jobId: String(id) }));
  }
  const earn = (id) => db.prepare("UPDATE referrals SET eligibleAt = ?, jobId = ?, eligibleBlock = 1000 WHERE newAgentId = ?").run(id, id, id);
  const row = (id) => ({ ...db.prepare("SELECT paid, txNew, txRef, nonceNew, nonceRef FROM referrals WHERE newAgentId = ?").get(id) });
  // every wallet's transfers are confirmed at once; `timesOut` makes send() throw after the node accepted the transfer
  const counts = new Map();
  const sent = [];
  const payout = (wallet, timesOut = () => false) =>
    new ReferralPayout({
      db,
      activity,
      provider: { getBalance: async () => parseEther("1000") },
      growthKey: wallet.privateKey,
      nowS: () => 1_758_400_000,
      txCounts: async () => [counts.get(wallet.address) ?? 0, counts.get(wallet.address) ?? 0],
      send: async (to, _value, nonce) => {
        sent.push([wallet.address, to, nonce]);
        counts.set(wallet.address, nonce + 1);
        if (timesOut(to)) throw new Error("request timeout");
        return `0x${wallet.address.slice(2, 8)}${nonce}`;
      },
    });
  const before = Wallet.createRandom();
  const after = Wallet.createRandom();

  // the first key pays agent 7 on its nonces 0 and 1; agent 9's first leg goes out on nonce 2 and its send times out
  earn(7);
  earn(9);
  await payout(before, (to) => to === owners[9]).tick();
  assert.deepEqual(sent, [[before.address, owners[7], 0], [before.address, toolbox.address, 1], [before.address, owners[9], 2]]);
  assert.deepEqual(row(9), { paid: 0, txNew: null, txRef: null, nonceNew: 2, nonceRef: null });

  // GROWTH_KEY changes. Agent 8's first leg goes out on the new wallet's nonce 0 and its send times out too.
  earn(8);
  await payout(after, (to) => to === owners[8]).tick();
  assert.deepEqual(sent.slice(3), [[after.address, owners[8], 0]], "agent 9's leg in flight on the old wallet is not sent again from the new one");
  assert.match(db.prepare("SELECT error FROM referrals WHERE newAgentId = 9").get().error, new RegExp(`reserved on GROWTH_KEY ${before.address}`));

  // agent 7's tx on the old wallet's nonce 0 is not agent 8's: the new wallet's nonce 0 is confirmed, so it is agent 8's
  assert.equal(await payout(after).tick(), 1);
  assert.deepEqual(sent.slice(4), [[after.address, toolbox.address, 1]], "agent 8's first leg is not sent twice");
  assert.deepEqual(row(8), { paid: 1, txNew: "recovered:nonce:0", txRef: `0x${after.address.slice(2, 8)}1`, nonceNew: 0, nonceRef: 1 });
  assert.deepEqual(row(9), { paid: 0, txNew: null, txRef: null, nonceNew: 2, nonceRef: null }, "still held");
});

// A nonce reserved before fromNew / fromRef existed reads null, but it was reserved on the key in use then. Matched only
// with other null rows, it missed the transfers that key recorded on the same nonce after the upgrade (and they missed
// its own re-send), so a leg claimed another row's transfer as `recovered` and its owner was never paid.
test("a nonce reserved before its wallet was recorded is matched with that wallet's later transfers", async () => {
  const { ActivityBus } = await import("../dist/commons/activity.js");
  const growth = Wallet.createRandom(); // the same GROWTH_KEY before and after the upgrade
  const scenario = async (unsentOnce) => {
    const db = openMemoryDb();
    const activity = new ActivityBus(db, () => 1_758_400_000_000);
    setMeta(db, "indexedBlock", String(1000 + REORG_DEPTH));
    const owners = {};
    // agent 8 was earned first (deferred by a daily cap, say), so it is paid first
    for (const [id, at] of [[7, 2], [8, 1]]) {
      owners[id] = Wallet.createRandom().address;
      db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts, eligibleAt, jobId, eligibleBlock) VALUES (?, 1, ?, ?, 1, ?, ?, 1000)").run(id, owners[id], toolbox.address, at, id);
      db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, 0, 1000, 'escrow', 'JobCompleted', ?, 1)").run(`0xc${id}`, JSON.stringify({ jobId: String(id) }));
    }
    // before the upgrade, agent 7's first leg reserved nonce 0 and its send never reached the node
    db.prepare("UPDATE referrals SET nonceNew = 0, fromNew = NULL WHERE newAgentId = 7").run();
    // the node confirms each transfer at once and refuses a nonce it has confirmed; the first send to agent `unsentOnce`'s
    // owner fails before it reaches the node
    let count = 0;
    const sent = [];
    let failed = false;
    const payout = new ReferralPayout({
      db,
      activity,
      provider: { getBalance: async () => parseEther("1000") },
      growthKey: growth.privateKey,
      nowS: () => 1_758_400_000,
      txCounts: async () => [count, count],
      send: async (to, _value, nonce) => {
        if (to === owners[unsentOnce] && !failed) {
          failed = true;
          throw new Error("connection refused");
        }
        if (nonce < count) throw new Error("nonce too low");
        sent.push([to, nonce]);
        count = nonce + 1;
        return `0x${nonce}`;
      },
    });
    const row = (id) => ({ ...db.prepare("SELECT paid, txNew, nonceNew, fromNew FROM referrals WHERE newAgentId = ?").get(id) });
    return { payout, owners, sent, row };
  };

  // agent 8 reserves the wallet's nonce 0 and is paid on it: agent 7's leg reserved there was never sent, and takes a fresh nonce
  {
    const { payout, owners, sent, row } = await scenario(null);
    assert.equal(await payout.tick(), 2);
    assert.deepEqual(sent, [[owners[8], 0], [toolbox.address, 1], [owners[7], 2], [toolbox.address, 3]], "agent 7's owner is paid");
    assert.deepEqual(row(7), { paid: 1, txNew: "0x2", nonceNew: 2, fromNew: growth.address });
  }

  // agent 8 reserves nonce 0 and its send fails; agent 7's leg goes out on nonce 0 from the same wallet, which is
  // recorded with it: agent 8's leg finds that transfer on its nonce and takes a fresh one
  {
    const { payout, owners, sent, row } = await scenario(8);
    assert.equal(await payout.tick(), 1);
    assert.deepEqual(sent, [[owners[7], 0], [toolbox.address, 1]]);
    assert.deepEqual(row(7), { paid: 1, txNew: "0x0", nonceNew: 0, fromNew: growth.address });
    assert.equal(await payout.tick(), 1);
    assert.deepEqual(sent.slice(2), [[owners[8], 2], [toolbox.address, 3]], "agent 8's owner is paid");
    assert.deepEqual(row(8), { paid: 1, txNew: "0x2", nonceNew: 2, fromNew: growth.address });
  }
});

// fromNew / fromRef shipped after the referrals table: a database deployed before them gains the columns, and migrating twice is a no-op.
test("migrateGrowth adds fromNew and fromRef to a referrals table created before they existed", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrateGrowth } = await import("../dist/commons/schema.js");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE referrals (newAgentId INTEGER PRIMARY KEY, refAgentId INTEGER NOT NULL, newOwner TEXT NOT NULL, refOwner TEXT NOT NULL, ts INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, eligibleAt INTEGER, jobId INTEGER, paidAt INTEGER, txNew TEXT, txRef TEXT, rewardWei TEXT, error TEXT, nonceNew INTEGER, nonceRef INTEGER, reorgFlag TEXT, eligibleBlock INTEGER)");
  db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts, nonceNew) VALUES (7, 8, '0xa', '0xb', 1, 3)").run();
  migrateGrowth(db);
  migrateGrowth(db);
  const cols = db.prepare("PRAGMA table_info(referrals)").all().map((c) => c.name);
  assert.ok(cols.includes("fromNew") && cols.includes("fromRef"));
  assert.deepEqual({ ...db.prepare("SELECT nonceNew, fromNew, fromRef FROM referrals WHERE newAgentId = 7").get() }, { nonceNew: 3, fromNew: null, fromRef: null });
});

// eligibleBlock shipped after the referrals table: a database deployed before it gains the column, and migrating twice is a no-op.
test("migrateGrowth adds eligibleBlock to a referrals table created before it existed", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrateGrowth } = await import("../dist/commons/schema.js");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE referrals (newAgentId INTEGER PRIMARY KEY, refAgentId INTEGER NOT NULL, newOwner TEXT NOT NULL, refOwner TEXT NOT NULL, ts INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, eligibleAt INTEGER, jobId INTEGER, paidAt INTEGER, txNew TEXT, txRef TEXT, rewardWei TEXT, error TEXT, nonceNew INTEGER, nonceRef INTEGER, reorgFlag TEXT)");
  db.prepare("INSERT INTO referrals (newAgentId, refAgentId, newOwner, refOwner, ts, eligibleAt, jobId) VALUES (7, 8, '0xa', '0xb', 1, 5, 6)").run();
  migrateGrowth(db);
  migrateGrowth(db);
  assert.ok(db.prepare("PRAGMA table_info(referrals)").all().some((c) => c.name === "eligibleBlock"));
  assert.deepEqual({ ...db.prepare("SELECT eligibleAt, jobId, eligibleBlock FROM referrals WHERE newAgentId = 7").get() }, { eligibleAt: 5, jobId: 6, eligibleBlock: null });
});
