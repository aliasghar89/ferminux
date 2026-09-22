// Activity bus: SSE stream over a real socket (replay via Last-Event-ID / ?since,
// live events, heartbeat), indexer hooks (dedup across reorg re-scans, bounty
// lifecycle: awarded → completed, refunded → open, auto-link via fmx://bounty/<id>).
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage } from "../dist/commons/sign.js";
import { ActivityBus, sseFrame } from "../dist/commons/activity.js";
import { makeIndexerHooks } from "../dist/commons/hooks.js";
import { applyJobToBounties } from "../dist/commons/bounties.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
};
const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

async function setup(opts = {}) {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(7, alice.address, "Scribe", "https://scribe.example", 1, 1_758_000_000);
  const built = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, sseHeartbeatMs: opts.heartbeatMs ?? 25_000, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await built.app.ready();
  const clock = { advance: (ms) => (nowMs += ms), s: () => Math.floor(nowMs / 1000) };
  const signed = async (wallet, action, payload = {}) => {
    clock.advance(1100);
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  };
  const post = (url, body) => built.app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
  return { ...built, db, clock, signed, post };
}

/** Reads SSE frames from a fetch Response until `count` events (not comments) arrived or timeout. */
async function readEvents(res, count, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  const comments = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ done: false, value: null }), deadline - Date.now()))]);
    if (chunk.done) break;
    if (!chunk.value) break;
    buf += dec.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = { id: null, event: null, data: null };
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) comments.push(line);
        else if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) ev.event = line.slice(7);
        else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
      }
      if (ev.data) events.push(ev);
    }
  }
  await reader.cancel().catch(() => {});
  return { events, comments };
}

test("ActivityBus: emit/list/dedup/subscribe + sseFrame", () => {
  const db = openMemoryDb();
  const bus = new ActivityBus(db, () => 1_000_000_000);
  const got = [];
  const off = bus.subscribe((e) => got.push(e.id));
  const a = bus.emit("kb.write", { actor: alice.address, ref: { kind: "kb", id: "x" }, data: { slug: "x" } });
  assert.equal(a.id, 1);
  assert.equal(a.ts, 1_000_000);
  assert.deepEqual(a.actor, { address: alice.address, name: null, agentId: null });
  assert.deepEqual(a.ref, { kind: "kb", id: "x" });
  const b = bus.emit("job.completed", { data: { jobId: 5 }, dedupKey: "JobCompleted:0xabc:0", ts: 999 });
  assert.equal(b.id, 2);
  assert.equal(bus.emit("job.completed", { data: { jobId: 5 }, dedupKey: "JobCompleted:0xabc:0" }), null); // dedup
  assert.equal(bus.has("JobCompleted:0xabc:0"), true);
  assert.deepEqual(got, [1, 2]);
  off();
  bus.emit("tool.publish", { data: {} });
  assert.deepEqual(got, [1, 2]);
  assert.deepEqual(bus.list().map((e) => e.id), [3, 2, 1]);
  assert.deepEqual(bus.list({ ascending: true, sinceId: 1 }).map((e) => e.id), [2, 3]);
  assert.deepEqual(bus.list({ since: 999 }).map((e) => e.id), [3, 1]);
  assert.deepEqual(bus.list({ type: "job." }).map((e) => e.id), [2]);
  assert.deepEqual(bus.list({ actor: alice.address.toLowerCase() }).map((e) => e.id), [1]);
  const frame = sseFrame(a);
  assert.ok(frame.startsWith("id: 1\nevent: kb.write\ndata: {") && frame.endsWith("}\n\n"));
});

test("GET /api/stream: replays since Last-Event-ID / ?since, pushes live events, heartbeats", async (t) => {
  const { app, clock, signed, post } = await setup({ heartbeatMs: 150 });
  t.after(() => app.close());
  const t0 = clock.s();
  clock.advance(2000);
  await post("/api/forum/threads", await signed(alice, "thread.create", { title: "one", body: "1" }));
  await post("/api/forum/threads", await signed(alice, "thread.create", { title: "two", body: "2" }));
  await post("/api/forum/threads", await signed(bob, "thread.create", { title: "three", body: "3" }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // replay from Last-Event-ID = 1 → events 2,3 then live
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream`, { headers: { "last-event-id": "1" }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const first = await readEvents(res, 2);
  assert.deepEqual(first.events.map((e) => [e.id, e.event, e.data.data.title]), [[2, "thread.create", "two"], [3, "thread.create", "three"]]);
  ac.abort();

  // ?since=t0 replays all three, then a live message.send arrives (public parts only), plus heartbeats
  const ac2 = new AbortController();
  const res2 = await fetch(`${base}/api/stream?since=${t0}`, { signal: ac2.signal });
  const reader = res2.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen = [];
  const commentLines = [];
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        for (const l of frame.split("\n")) if (l.startsWith(":")) commentLines.push(l);
        if (data) seen.push(JSON.parse(data.slice(6)));
      }
    }
  };
  const pumping = pump().catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen.map((e) => e.id), [1, 2, 3]);
  await post("/api/messages", await signed(bob, "message.send", { to: 7, subject: "hey", body: "SECRET" }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(seen.length, 4);
  assert.equal(seen[3].type, "message.send");
  assert.equal(seen[3].data.subject, "hey");
  assert.equal(seen[3].data.to.name, "Scribe");
  assert.ok(!JSON.stringify(seen[3]).includes("SECRET"));
  assert.ok(commentLines.some((l) => l.startsWith(": ping")), "heartbeat comment expected");
  ac2.abort();
  await pumping;
  await new Promise((r) => setTimeout(r, 20));

  // type filter on the stream only forwards matching live events
  const ac3 = new AbortController();
  const res3 = await fetch(`${base}/api/stream?type=kb.write`, { signal: ac3.signal });
  const p3 = readEvents(res3, 1, 1500);
  await post("/api/forum/threads", await signed(alice, "thread.create", { title: "ignored", body: "x" }));
  await app.inject({ method: "PUT", url: "/api/kb/from-stream", headers: { "content-type": "application/json" }, payload: JSON.stringify(await signed(alice, "kb.write", { title: "S", body: "b" })) });
  const r3 = await p3;
  assert.equal(r3.events.length, 1);
  assert.equal(r3.events[0].event, "kb.write");
  ac3.abort();
});

test("indexer hooks: activity with dedup + bounty lifecycle (award → complete, refund → reopen, auto-link)", async (t) => {
  const { app, db, activity, indexerHooks, clock, signed, post } = await setup();
  t.after(() => app.close());
  // bob posts a bounty, alice (agent 7) claims, bob awards agent 7 without a jobId
  const b = (await post("/api/bounties", await signed(bob, "bounty.create", { title: "Work", brief: "do it", rewardWei: "1000" }))).json();
  await post(`/api/bounties/${b.id}/claims`, await signed(alice, "bounty.claim", { agentId: 7, pitch: "me" }));
  const awarded = (await post(`/api/bounties/${b.id}/award`, await signed(bob, "bounty.award", { agentId: 7 }))).json();
  assert.equal(awarded.status, "awarded");
  assert.equal(awarded.jobId, null);

  // the indexer sees bob's requestJob citing the bounty → auto-link
  const insJob = db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, status, createdAt, deliveredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, deliveredAt = excluded.deliveredAt");
  insJob.run(50, 7, bob.address, "1000", "0x" + "11".repeat(32), `fmx://bounty/${b.id}`, 1, clock.s(), null);
  indexerHooks.onJobEvent({ eventName: "JobRequested", jobId: 50, blockNumber: 100, txHash: "0xaaa", logIndex: 0, ts: 1_758_500_000, args: { jobId: "50", agentId: "7", client: bob.address, amount: "1000" } });
  let row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(b.id);
  assert.equal(row.status, "awarded");
  assert.equal(row.jobId, 50);
  assert.equal(row.awardedAgentId, 7);
  let ev = activity.list({ type: "job.requested" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].ts, 1_758_500_000);
  assert.equal(ev[0].data.agentName, "Scribe");
  assert.equal(ev[0].data.client.address, bob.address);
  assert.equal(ev[0].actor.address, bob.address);

  // reorg re-scan replays the same log → no duplicate activity
  indexerHooks.onJobEvent({ eventName: "JobRequested", jobId: 50, blockNumber: 100, txHash: "0xaaa", logIndex: 0, ts: 1_758_500_000, args: {} });
  assert.equal(activity.list({ type: "job.requested" }).length, 1);

  // delivered (actor = agent owner), then completed with a rating → bounty completed
  insJob.run(50, 7, bob.address, "1000", "0x" + "11".repeat(32), `fmx://bounty/${b.id}`, 2, clock.s(), 1_758_500_100);
  indexerHooks.onJobEvent({ eventName: "JobDelivered", jobId: 50, blockNumber: 101, txHash: "0xbbb", logIndex: 0, ts: 1_758_500_100, args: {} });
  assert.equal(activity.list({ type: "job.delivered" })[0].actor.address, alice.address);
  insJob.run(50, 7, bob.address, "1000", "0x" + "11".repeat(32), `fmx://bounty/${b.id}`, 3, clock.s(), 1_758_500_100);
  indexerHooks.onJobEvent({ eventName: "JobCompleted", jobId: 50, blockNumber: 102, txHash: "0xccc", logIndex: 1, ts: 1_758_500_200, args: { jobId: "50", agentPayout: "975", fee: "25", rating: "5" } });
  row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(b.id);
  assert.equal(row.status, "completed");
  assert.equal(row.completedAt, 1_758_500_200);
  const completed = activity.list({ type: "job.completed" });
  assert.equal(completed[0].data.rating, 5);
  const bc = activity.list({ type: "bounty.complete" });
  assert.equal(bc.length, 1);
  assert.equal(bc[0].data.bountyId, b.id);
  assert.equal(bc[0].ts, 1_758_500_200);
  // replay of the completion is a no-op (dedup on both the job event and the bounty transition)
  indexerHooks.onJobEvent({ eventName: "JobCompleted", jobId: 50, blockNumber: 102, txHash: "0xccc", logIndex: 1, ts: 1_758_500_200, args: { rating: "5" } });
  assert.equal(activity.list({ type: "job.completed" }).length, 1);
  assert.equal(activity.list({ type: "bounty.complete" }).length, 1);
  const detail = (await app.inject({ method: "GET", url: `/api/bounties/${b.id}` })).json();
  assert.equal(detail.status, "completed");
  assert.equal(detail.jobStatus, "Completed");
  assert.equal((await app.inject({ method: "GET", url: "/api/bounties?status=completed" })).json().total, 1);

  // second bounty: awarded with an explicit jobId, then the job is refunded → back to open
  const b2 = (await post("/api/bounties", await signed(bob, "bounty.create", { title: "Work 2", brief: "again", rewardWei: "1" }))).json();
  insJob.run(51, 7, bob.address, "1", "0x" + "22".repeat(32), "fmx://payload/0x22", 1, clock.s(), null);
  const aw2 = await post(`/api/bounties/${b2.id}/award`, await signed(bob, "bounty.award", { agentId: 7, jobId: 51 }));
  assert.equal(aw2.statusCode, 200, aw2.body);
  assert.equal(aw2.json().jobStatus, "Open");
  insJob.run(51, 7, bob.address, "1", "0x" + "22".repeat(32), "fmx://payload/0x22", 4, clock.s(), null);
  indexerHooks.onJobEvent({ eventName: "JobRefunded", jobId: 51, blockNumber: 110, txHash: "0xddd", logIndex: 0, ts: 1_758_600_000, args: { jobId: "51", amount: "1", byAgent: "true" } });
  row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(b2.id);
  assert.equal(row.status, "open");
  assert.equal(row.jobId, null);
  assert.equal(row.awardedAgentId, null);
  const reopen = activity.list({ type: "bounty.reopen" });
  assert.equal(reopen.length, 1);
  assert.equal(reopen[0].data.reason, "refunded");
  assert.equal(activity.list({ type: "job.refunded" })[0].actor.address, alice.address); // cancelled by the agent
  assert.equal(activity.list({ type: "job.refunded" })[0].data.byAgent, true);

  // award with a job that belongs to another client → 403; wrong agent → 400
  insJob.run(52, 7, alice.address, "1", "0x" + "33".repeat(32), "", 1, clock.s(), null);
  const wrongClient = await post(`/api/bounties/${b2.id}/award`, await signed(bob, "bounty.award", { agentId: 7, jobId: 52 }));
  assert.equal(wrongClient.statusCode, 403);
  insJob.run(53, 9, bob.address, "1", "0x" + "44".repeat(32), "", 1, clock.s(), null);
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (9, ?, 'Other', '', 1, 1)").run(alice.address);
  const wrongAgent = await post(`/api/bounties/${b2.id}/award`, await signed(bob, "bounty.award", { agentId: 7, jobId: 53 }));
  assert.equal(wrongAgent.statusCode, 400);

  // agent registry events
  indexerHooks.onAgentEvent({ eventName: "AgentRegistered", id: 7, blockNumber: 5, txHash: "0xeee", logIndex: 0, ts: 1_758_000_000 });
  indexerHooks.onAgentEvent({ eventName: "AgentUpdated", id: 7, blockNumber: 6, txHash: "0xfff", logIndex: 0, ts: 1_758_000_010 });
  indexerHooks.onAgentEvent({ eventName: "AgentUpdated", id: 7, blockNumber: 6, txHash: "0xfff", logIndex: 0, ts: 1_758_000_010 });
  assert.equal(activity.list({ type: "agent." }).length, 2);
  assert.equal(activity.list({ type: "agent.registered" })[0].data.name, "Scribe");

  // arena: a creator's job citing fmx://arena/<id> links as the award (dedup on replay)
  const { applyJobToArena } = await import("../dist/commons/arena.js");
  db.prepare("INSERT INTO arena_challenges (id, creator, title, brief, prizeWei, endsAt, winnerSubmissionId, closedAt, createdAt) VALUES (1, ?, 'Haiku', 'b', '5', 100, NULL, 100, 1)").run(bob.address);
  applyJobToArena(db, activity, { id: 70, agentId: 7, client: bob.address, inputURI: "fmx://arena/1" }, 200);
  applyJobToArena(db, activity, { id: 70, agentId: 7, client: bob.address, inputURI: "fmx://arena/1" }, 200);
  const ch = db.prepare("SELECT * FROM arena_challenges WHERE id = 1").get();
  assert.equal(ch.jobId, 70);
  assert.equal(ch.awardedAgentId, 7);
  assert.equal(activity.list({ type: "arena.award" }).length, 1);
  applyJobToArena(db, activity, { id: 71, agentId: 7, client: alice.address, inputURI: "fmx://arena/1" }, 201); // not the creator
  assert.equal(db.prepare("SELECT jobId FROM arena_challenges WHERE id = 1").get().jobId, 70);
  assert.equal((await app.inject({ method: "GET", url: "/api/arena/challenges/1" })).json().status, "awarded");

  // applyJobToBounties ignores a citing job from a non-poster
  const b3 = (await post("/api/bounties", await signed(bob, "bounty.create", { title: "Work 3", brief: "x", rewardWei: "1" }))).json();
  applyJobToBounties(db, activity, { id: 60, agentId: 7, client: alice.address, amount: "1", inputURI: `fmx://bounty/${b3.id}`, status: 1 }, 1);
  assert.equal(db.prepare("SELECT status FROM bounties WHERE id = ?").get(b3.id).status, "open");
});

test("leaderboard math: computeLeaderboard windows and weights", async () => {
  const { computeLeaderboard, WEIGHTS } = await import("../dist/commons/leaderboard.js");
  const db = openMemoryDb();
  const A = alice.address;
  const B = bob.address;
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt, ratingCount, ratingSum) VALUES (1, ?, 'A', '', 1, 1, 2, 8)").run(A);
  const now = 20_000_000;
  const j = db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt, deliveredAt) VALUES (?, 1, ?, '1', ?, ?, ?)");
  j.run(1, B, 3, now - 10, now - 5); // completed, recent
  j.run(2, B, 3, now - 40 * 86400, null); // completed, old (no deliveredAt → createdAt)
  j.run(3, B, 2, now - 10, now - 5); // delivered only
  db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON) VALUES ('0x1', 0, 1, 'escrow', 'JobCompleted', ?)").run(JSON.stringify({ jobId: "1", rating: "3" }));
  db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON) VALUES ('0x2', 0, 1, 'escrow', 'JobCompleted', ?)").run(JSON.stringify({ jobId: "2", rating: "5" }));
  db.prepare("INSERT INTO forum_threads (id, title, tags, author, createdAt, lastPostAt) VALUES (1, 't', '[]', ?, ?, ?)").run(B, now, now);
  db.prepare("INSERT INTO forum_posts (threadId, author, body, createdAt) VALUES (1, ?, 'x', ?)").run(B, now - 1);
  db.prepare("INSERT INTO forum_posts (threadId, author, body, createdAt) VALUES (1, ?, 'y', ?)").run(B, now - 50 * 86400);
  db.prepare("INSERT INTO kb_revisions (slug, rev, title, summary, body, author, createdAt) VALUES ('s', 1, 't', '', 'b', ?, ?)").run(A, now);
  db.prepare("INSERT INTO artifacts (id, owner, name, kind, createdAt) VALUES (1, ?, 'x', 'code', ?)").run(A, now - 60 * 86400);
  db.prepare("INSERT INTO artifact_stars (artifactId, address, createdAt) VALUES (1, ?, ?)").run(B, now - 1);
  db.prepare("INSERT INTO artifact_stars (artifactId, address, createdAt) VALUES (1, ?, ?)").run("0x0000000000000000000000000000000000000001", now - 60 * 86400);
  db.prepare("INSERT INTO arena_challenges (id, creator, title, brief, endsAt, winnerSubmissionId, closedAt, createdAt) VALUES (1, ?, 'c', 'b', ?, 1, ?, 1)").run(B, now - 100, now - 100);
  db.prepare("INSERT INTO arena_submissions (id, challengeId, submitter, createdAt) VALUES (1, 1, ?, 1)").run(A);

  const all = computeLeaderboard(db, 0);
  const a = all.find((e) => e.address === A);
  assert.equal(a.completedJobs, 2);
  assert.equal(a.ratingAvg, 4); // agents table 8/2
  assert.equal(a.kbEdits, 1);
  assert.equal(a.artifacts, 1);
  assert.equal(a.starsReceived, 2);
  assert.equal(a.arenaWins, 1);
  assert.equal(a.score, 2 * WEIGHTS.completedJobs + WEIGHTS.kbEdits + WEIGHTS.artifacts + 2 * WEIGHTS.starsReceived + WEIGHTS.arenaWins + 4 * WEIGHTS.ratingBonus);
  const b = all.find((e) => e.address === B);
  assert.equal(b.forumPosts, 2);
  assert.equal(b.score, 2);
  assert.deepEqual(all.map((e) => e.rank), [1, 2]);
  assert.equal(all[0].address, A);

  const recent = computeLeaderboard(db, now - 30 * 86400);
  const a30 = recent.find((e) => e.address === A);
  assert.equal(a30.completedJobs, 1);
  assert.equal(a30.ratingAvg, 3); // only job 1's rating is inside the window
  assert.equal(a30.artifacts, 0);
  assert.equal(a30.starsReceived, 1);
  assert.equal(a30.arenaWins, 1);
  assert.equal(recent.find((e) => e.address === B).forumPosts, 1);
  assert.equal(computeLeaderboard(db, 0, 1).length, 1);
});
