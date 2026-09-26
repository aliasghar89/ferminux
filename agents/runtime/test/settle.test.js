// Auto-settle: the hosted agents never collected their pay (job #6 sat in Delivered for days after its review
// window, audit 2026-09-24). settleTick claims escrow jobs past review, streams and subscriptions paying the
// agent's key, and withdraws credits — re-checking everything on chain, never twice, with per-item backoff.
// Every client here is a stub: nothing touches a network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleTick, backoffMs, loadSettleState, createSendQueue, pageAll, sdkSettleClient, SETTLE_BACKOFF_MAX_MS } from "../dist/settle.js";
import { anchorTick } from "../dist/anchor.js";

const E18 = 10n ** 18n;
const ME = "0x00000000000000000000000000000000000000A1";
const log = { info() {}, warn() {}, error() {} };
const DELIVERED = 2, COMPLETED = 3;

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "fmx-settle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "agent-3-settle.json");
}

/** A stub chain + gateway: jobs, streams, subs and three credit pools; every write is recorded. */
function world(over = {}) {
  const w = {
    now: 1_790_000_000, // chain clock (s)
    owner: ME,
    jobs: new Map([
      [6, { agentId: 3, status: DELIVERED, deliveredAt: 1_790_000_000 - 90_000 }], // review window (86 400 s) over
      [7, { agentId: 3, status: DELIVERED, deliveredAt: 1_790_000_000 - 3_600 }], // still in review
      [8, { agentId: 3, status: COMPLETED, deliveredAt: 1_789_000_000 }], // the client already released it
    ]),
    indexed: [6, 7, 8],
    streams: new Map([
      [1, { payee: ME, stop: 1_789_999_000, cancelled: false, claimable: 3n * E18 / 10n }], // ended, 0.3 FMX left
      [2, { payee: ME, stop: 1_790_900_000, cancelled: false, claimable: E18 / 10n }], // running, below 1 FMX
      [3, { payee: ME, stop: 1_790_900_000, cancelled: false, claimable: 2n * E18 }], // running, above 1 FMX
      [4, { payee: ME, stop: 1_789_000_000, cancelled: true, claimable: 0n }],
    ]),
    subs: new Map([[11, 2n], [12, 0n]]),
    credits: { escrow: 0n, streams: 0n, x402: 5n * E18 / 100n },
    writes: [],
    fail: new Set(),
    ...over,
  };
  let n = 0;
  const tx = (what) => { if (w.fail.has(what)) throw new Error(`execution reverted: ${what}`); w.writes.push(what); return { tx: `0x${(++n).toString(16).padStart(64, "0")}` }; };
  w.client = {
    me: ME,
    agentOwner: async () => w.owner,
    deliveredJobs: async () => w.indexed.map((id) => ({ id })),
    escrowJob: async (id) => w.jobs.get(id),
    reviewWindowS: async () => 86_400,
    chainNow: async () => w.now,
    claimJob: async (id) => { const r = tx(`claimJob:${id}`); const j = w.jobs.get(id); j.status = COMPLETED; w.credits.escrow += 975n * E18 / 10_000n; return r; },
    payeeStreams: async () => [...w.streams.keys()].map((id) => ({ id })),
    stream: async (id) => w.streams.get(id),
    streamClaimable: async (id) => w.streams.get(id).claimable,
    claimStream: async (id) => { const r = tx(`claimStream:${id}`); const s = w.streams.get(id); w.credits.streams += s.claimable; s.claimable = 0n; return r; },
    payeeSubs: async () => [...w.subs.keys()].map((id) => ({ id })),
    dueSubPeriods: async (id) => w.subs.get(id),
    claimSub: async (id) => { const r = tx(`claimSub:${id}`); w.subs.set(id, 0n); return r; },
    credits: async (pool) => w.credits[pool],
    withdraw: async (pool) => { const r = tx(`withdraw:${pool}`); w.credits[pool] = 0n; return r; },
  };
  return w;
}

test("settle: claims the job past review (never the one in review or already released), ended and large streams, due subs, then withdraws every pool over the floor", async (t) => {
  const statePath = tmp(t);
  const w = world();
  let ms = 1_000_000;
  const r = await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.deepEqual(r.claimedJobs, [6], "job 6's review window is over; 7 is still in review; 8 was released by its client");
  assert.deepEqual(r.claimedStreams, [1, 3], "ended stream 1 (anything claimable) and running stream 3 (≥ 1 FMX); running 2 waits; cancelled 4 has nothing");
  assert.deepEqual(r.claimedSubs, [11]);
  assert.deepEqual(r.withdrawn.map((x) => x.pool), ["escrow", "streams", "x402"]);
  assert.deepEqual(w.writes, ["claimJob:6", "claimStream:1", "claimStream:3", "claimSub:11", "withdraw:escrow", "withdraw:streams", "withdraw:x402"]);
  assert.equal(r.withdrawn.find((x) => x.pool === "streams").wei, (23n * E18 / 10n).toString());

  // idempotent: a second pass sends nothing new, and does not even re-read settled job 8 or claimed job 6
  const reads = [];
  const escrowJob = w.client.escrowJob;
  w.client.escrowJob = async (id) => { reads.push(id); return escrowJob(id); };
  ms += 60_000;
  const r2 = await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.deepEqual([...r2.claimedJobs, ...r2.claimedStreams, ...r2.claimedSubs, ...r2.withdrawn], []);
  assert.equal(w.writes.length, 7);
  assert.deepEqual(reads, [7], "only the job still in review is re-checked");
  const st = loadSettleState(statePath);
  assert.ok(st.items["job:6"].doneAt && st.items["job:6"].tx);
  assert.ok(st.items["job:8"].doneAt, "a job someone else settled is remembered as done");

  // job 7's window closes → claimed on the next pass
  w.now += 86_400;
  ms += 60_000;
  const r3 = await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.deepEqual(r3.claimedJobs, [7]);
});

test("settle: a failed claim backs off (1 min doubling, capped at 6 h) and is retried, never dropped", async (t) => {
  const statePath = tmp(t);
  const w = world({ indexed: [6], streams: new Map(), subs: new Map(), credits: { escrow: 0n, streams: 0n, x402: 0n } });
  w.fail.add("claimJob:6");
  let ms = 5_000_000;
  const r = await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.deepEqual(r.failed, ["job:6"]);
  assert.equal(loadSettleState(statePath).items["job:6"].attempts, 1);
  assert.match(loadSettleState(statePath).items["job:6"].lastError, /execution reverted/);

  ms += 30_000; // inside the 1-minute backoff
  const r2 = await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.deepEqual(r2.backingOff, ["job:6"]);
  assert.equal(w.writes.length, 0);

  ms += 31_000;
  await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.equal(loadSettleState(statePath).items["job:6"].attempts, 2, "retried after the backoff, failed again");
  w.fail.clear();
  ms += 120_001;
  const r4 = await settleTick({ client: w.client, agentId: 3, statePath, log, now: () => ms });
  assert.deepEqual(r4.claimedJobs, [6]);
  assert.deepEqual(r4.withdrawn.map((x) => x.pool), ["escrow"], "the claimed pay is withdrawn in the same pass");

  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(30), SETTLE_BACKOFF_MAX_MS);
});

test("settle: dry run sends and persists nothing; a key that does not own the agent leaves its escrow jobs alone; dust credits stay put", async (t) => {
  const statePath = tmp(t);
  const w = world();
  const r = await settleTick({ client: w.client, agentId: 3, statePath, log, dryRun: true });
  assert.deepEqual(w.writes, []);
  assert.ok(r.wouldSend.includes("job:6") && r.wouldSend.includes("stream:1"));
  assert.equal(existsSync(statePath), false);

  const w2 = world({ owner: "0x00000000000000000000000000000000000000B2", streams: new Map(), subs: new Map(), credits: { escrow: E18 / 1000n, streams: 0n, x402: 0n } });
  const warned = [];
  const r2 = await settleTick({ client: w2.client, agentId: 3, statePath, log: { ...log, warn: (o, m) => warned.push(m) } });
  assert.deepEqual(r2.claimedJobs, []);
  assert.ok(warned.some((m) => /does not own the agent/.test(m)));
  assert.deepEqual(r2.withdrawn, [], "0.001 FMX is below the 0.01 FMX withdraw floor");
  assert.deepEqual(w2.writes, []);
});

test("settle: StreamPay not deployed (null lists and pools) is not an error", async (t) => {
  const statePath = tmp(t);
  const w = world({ indexed: [] });
  w.client.payeeStreams = async () => null;
  w.client.payeeSubs = async () => null;
  w.client.credits = async (pool) => (pool === "escrow" ? 0n : null);
  const r = await settleTick({ client: w.client, agentId: 3, statePath, log });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(w.writes, []);
});

test("send queue: sends from one key never overlap, and a failed send does not block the next", async () => {
  const q = createSendQueue();
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  const send = (name, ms, fail = false) => q(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--; order.push(name);
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([send("deliver", 20), send("claim", 5, true), send("withdraw", 1)]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ["deliver", "claim", "withdraw"]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("pageAll: follows offset to the end, drops a row seen twice, stops on a page with nothing new", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ id: 450 - i })); // newest first, like the gateway
  const asked = [];
  const all = await pageAll(async (limit, offset) => { asked.push(offset); return rows.slice(offset, offset + limit); });
  assert.equal(all.length, 450);
  assert.deepEqual(asked, [0, 200, 400]);
  assert.ok(all.some((r) => r.id === 1), "the oldest row is read");

  // a row inserted at the head between two pages shifts the next page by one: seen twice, counted once
  const live = rows.slice();
  const shifted = await pageAll(async (limit, offset) => { const page = live.slice(offset, offset + limit); if (offset === 0) live.unshift({ id: 451 }); return page; });
  assert.equal(shifted.length, 450);
  assert.equal(new Set(shifted.map((r) => r.id)).size, 450);

  // a gateway that ignores offset returns the same page forever: the walk ends at the second page
  let calls = 0;
  const stuck = await pageAll(async (limit) => { calls++; return rows.slice(0, limit); });
  assert.equal(stuck.length, 200);
  assert.equal(calls, 2);
});

/** An SDK client stub: a signer, StreamPay deployed, and a gateway that pages like /api/streams (200 max). */
function sdkStub({ streams = 0, plans = 0, subsPerPlan = 0, delivered = 0 } = {}) {
  const paths = [];
  const page = (n, url) => {
    const q = new URL(url, "http://gw").searchParams;
    const limit = Math.min(Number(q.get("limit") ?? 50), 200), offset = Number(q.get("offset") ?? 0);
    return Array.from({ length: n }, (_, i) => ({ id: n - i })).slice(offset, offset + limit);
  };
  const sends = [];
  const fmx = {
    requireSigner: () => ({ address: ME }),
    v3: { streamPay: "0x00000000000000000000000000000000000000B2", x402Vault: null },
    runner: null,
    registry: { getAgent: async () => ({ owner: ME }) },
    gatewayGet: async (path) => {
      paths.push(path);
      if (path.startsWith("/streams/plans")) return { items: page(plans, path) };
      if (path.startsWith("/streams/subs")) return { items: page(subsPerPlan, path) };
      if (path.startsWith("/streams")) return { items: page(streams, path) };
      if (path.startsWith("/agents/")) return { items: page(delivered, path) };
      throw new Error(`unexpected ${path}`);
    },
    jobs: { claim: async (id) => { sends.push(`claimJob:${id}`); return { tx: "0x01" }; } },
  };
  return { fmx, paths, sends };
}

test("settle client: reads every page of payee streams, plans, subs and delivered jobs (not just the newest 200)", async () => {
  const { fmx, paths } = sdkStub({ streams: 401, plans: 3, subsPerPlan: 205, delivered: 250 });
  const c = sdkSettleClient(fmx, createSendQueue(0));
  const streams = await c.payeeStreams();
  assert.equal(streams.length, 401);
  assert.ok(streams.some((s) => s.id === 1), "stream 1, the oldest, was on page 3");
  assert.deepEqual(paths.filter((p) => p.startsWith("/streams?")), [
    `/streams?payee=${ME}&limit=200&offset=0`,
    `/streams?payee=${ME}&limit=200&offset=200`,
    `/streams?payee=${ME}&limit=200&offset=400`,
  ]);
  assert.equal((await c.payeeSubs()).length, 3 * 205);
  assert.equal((await c.deliveredJobs(3)).length, 250);
});

test("one key, one queue: a memory anchor and a settle claim never send at the same time", async () => {
  const q = createSendQueue(0);
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  const busy = async (name, ms) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--; order.push(name);
  };
  const { fmx } = sdkStub();
  fmx.jobs.claim = async (id) => { await busy(`claim:${id}`, 15); return { tx: "0x01" }; };
  fmx.memory = { anchor: async (args) => { await busy("anchor", 1); return { root: "0x" + "ab".repeat(32), count: 1, fromSeq: 1, toSeq: 1, tx: "0x02", send: args.send }; } };
  const c = sdkSettleClient(fmx, q);
  const [, anchored] = await Promise.all([c.claimJob(6), anchorTick({ fmx, agentId: 3, log, queue: q })]);
  assert.equal(anchored.status, "anchored");
  assert.equal(maxInFlight, 1, "the anchor waited for the claim");
  assert.deepEqual(order, ["claim:6", "anchor"]);

  // a dry run sends nothing, so it does not wait in the queue
  let queued = 0;
  const spy = (fn) => { queued++; return fn(); };
  await anchorTick({ fmx, agentId: 3, log, queue: spy, dryRun: true });
  assert.equal(queued, 0);
  await anchorTick({ fmx, agentId: 3, log, queue: spy });
  assert.equal(queued, 1);
});
