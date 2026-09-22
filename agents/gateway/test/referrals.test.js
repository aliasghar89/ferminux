// Growth — referral programme: claim, eligibility on first completed job,
// payout worker (injected sender), leaderboard with pending/paid counts.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, parseEther } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage } from "../dist/commons/sign.js";
import { ReferralPayout, applyJobToReferrals } from "../dist/commons/referrals.js";

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
  return { app, db, activity, indexerHooks, clock, post, get };
}

test("referrals", async (t) => {
  const { app, db, activity, indexerHooks, clock, post, get } = await setup();
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
    for (const id of [490, 491, 492, 493]) indexerHooks.onJobEvent({ jobId: id, eventName: "JobCompleted", args: {}, ts: clock.s(), txHash: `0x0${id}`, logIndex: 0, blockNumber: 1 });
    assert.equal((await get("/api/referrals/12")).status, "registered");
    assert.equal((await get("/api/referrals/leaderboard")).minJobFmx, "5");
  });

  await t.test("first qualifying completed job (third-party client, ≥ 5 FMX) makes the referral pending (earned, unpaid)", async () => {
    db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(501, 12, client.address, parseEther("5").toString(), 1, clock.s());
    indexerHooks.onJobEvent({ jobId: 501, eventName: "JobRequested", args: {}, ts: clock.s(), txHash: "0x01", logIndex: 0, blockNumber: 1 });
    assert.equal((await get("/api/referrals/12")).status, "registered");
    db.prepare("UPDATE jobs SET status = 3 WHERE id = 501").run(); // Completed
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
    applyJobToReferrals(db, activity, { id: 601, agentId: 14, status: 3, client: newbie.address, amount: parseEther("5").toString() }, clock.s());
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
    applyJobToReferrals(db, activity, { id: 701, agentId: 15, status: 3, client: client.address, amount: parseEther("5").toString() }, clock.s());
    // simulate: nonce 20 was reserved for the first leg and the tx broadcast, then the process died before txNew was written
    db.prepare("UPDATE referrals SET nonceNew = 20 WHERE newAgentId = 15").run();
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
      applyJobToReferrals(db, activity, { id: 800 + i, agentId: 20 + i, status: 3, client: client.address, amount: parseEther("5").toString() }, clock.s());
    }
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

  await t.test("openapi documents the referral routes + action", async () => {
    const spec = await get("/api/openapi.json");
    assert.ok(spec.paths["/api/referrals"].post);
    assert.ok(spec.paths["/api/referrals/leaderboard"].get);
    assert.equal(spec["x-ferminux-signing"].actions["POST /api/referrals"].startsWith("referral.claim"), true);
    assert.ok(spec["x-ferminux-signing"].allActions.includes("referral.claim"));
  });
});
