// bounties.hire / arena.hire lock the whole reward in a new escrow job on every call: a bounty or challenge
// that already has a live linked job must never be hired a second time. No chain, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { Interface, Wallet } from "ethers";
import { Ferminux, ESCROW_ABI } from "../dist/index.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ESCROW = "0x00000000000000000000000000000000000000e5";

function setup(t, record) {
  const fmx = new Ferminux({ privateKey: KEY, escrow: ESCROW, gateway: "http://gw.test/api" });
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (/\/(bounties|arena\/challenges)\/\d+(\?|$)/.test(u)) return new Response(JSON.stringify(record), { status: 200 });
    if (u.endsWith("/payloads")) return new Response(JSON.stringify({ hash: `0x${"ab".repeat(32)}`, uri: "fmx://payload/x", size: 1 }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => { globalThis.fetch = real; });
  const sent = [];
  const iface = new Interface(ESCROW_ABI);
  const log = iface.encodeEventLog("JobRequested", [41n, 3n, new Wallet(KEY).address, 5n, `0x${"ab".repeat(32)}`, "fmx://x"]);
  Object.defineProperty(fmx, "escrow", {
    value: {
      target: ESCROW,
      interface: iface,
      requestJob: async (...args) => {
        sent.push(args);
        return { wait: async () => ({ hash: "0xfeed", logs: [{ address: ESCROW, topics: log.topics, data: log.data }] }) };
      },
    },
  });
  return { fmx, calls, sent };
}

const bounty = { id: 9, title: "t", brief: "b", rewardWei: "5", status: "awarded", awardedAgentId: 3, jobId: null, jobStatus: null };

test("bounties.hire: hires once, refuses a bounty that already has a live job", async (t) => {
  const fresh = setup(t, bounty);
  assert.deepEqual(await fresh.fmx.bounties.hire({ bountyId: 9 }), { jobId: 41, tx: "0xfeed" });
  assert.equal(fresh.sent.length, 1);

  for (const linked of [{ ...bounty, jobId: 41, jobStatus: "Open" }, { ...bounty, jobId: 41, jobStatus: "Delivered" }, { ...bounty, status: "completed", jobId: 41, jobStatus: "Completed" }]) {
    const s = setup(t, linked);
    await assert.rejects(s.fmx.bounties.hire({ bountyId: 9 }), /already settled by escrow job 41/);
    assert.equal(s.sent.length, 0, "nothing sent on chain");
    assert.ok(!s.calls.some((c) => c.endsWith("/payloads")), "nothing uploaded");
  }
});

test("arena.hire: refuses a challenge whose job is live, allows one whose job was refunded", async (t) => {
  const challenge = { id: 4, title: "c", brief: "b", prizeWei: "5", status: "closed", winner: { agentId: 3 }, awardedAgentId: 3, jobId: 40, jobStatus: "Delivered" };
  const live = setup(t, challenge);
  await assert.rejects(live.fmx.arena.hire({ challengeId: 4 }), /already settled by escrow job 40/);
  assert.equal(live.sent.length, 0);

  const refunded = setup(t, { ...challenge, jobStatus: "Refunded" });
  assert.equal((await refunded.fmx.arena.hire({ challengeId: 4 })).jobId, 41);
  assert.equal(refunded.sent.length, 1);
});

test("a retried award + hire (fmx_bounty_award with hire=true and no jobId) never locks the reward twice", async (t) => {
  // A stub gateway with the award route's own semantics: `jobId = body.jobId ?? null`, and only a completed
  // bounty is refused. An award without a jobId used to unlink the live job, so the next hire() passed.
  const state = { ...bounty, status: "open", awardedAgentId: null };
  const indexed = new Map(); // escrow jobs the gateway has indexed: id → status
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const json = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (method === "GET" && /\/bounties\/9$/.test(u)) return json({ ...state, jobStatus: state.jobId != null ? indexed.get(state.jobId) ?? null : null });
    if (method === "POST" && u.endsWith("/bounties/9/award")) {
      const body = JSON.parse(init.body);
      if (state.status === "completed") return new Response(JSON.stringify({ error: "bounty is already completed" }), { status: 409 });
      Object.assign(state, { status: "awarded", awardedAgentId: body.agentId, jobId: body.jobId ?? null });
      return json(state);
    }
    if (u.endsWith("/payloads")) return json({ hash: `0x${"ab".repeat(32)}`, uri: "fmx://payload/x", size: 1 });
    return json({});
  };
  t.after(() => { globalThis.fetch = real; });
  const fmx = new Ferminux({ privateKey: KEY, escrow: ESCROW, gateway: "http://gw.test/api" });
  t.after(() => fmx.provider.destroy());
  const iface = new Interface(ESCROW_ABI);
  const sent = [];
  Object.defineProperty(fmx, "escrow", {
    value: {
      target: ESCROW,
      interface: iface,
      requestJob: async (...args) => {
        const jobId = 41n + BigInt(sent.length);
        sent.push(args);
        indexed.set(Number(jobId), "Open");
        const log = iface.encodeEventLog("JobRequested", [jobId, 3n, new Wallet(KEY).address, 5n, args[1], args[2]]);
        return { wait: async () => ({ hash: "0xfeed", logs: [{ address: ESCROW, topics: log.topics, data: log.data }] }) };
      },
    },
  });

  // exactly what the MCP tool runs, twice: the second run is a retry after an error or a timeout
  await fmx.bounties.award({ bountyId: 9, agentId: 3 });
  assert.equal((await fmx.bounties.hire({ bountyId: 9, agentId: 3 })).jobId, 41);
  const retried = await fmx.bounties.award({ bountyId: 9, agentId: 3 });
  assert.equal(retried.jobId, 41, "re-awarding keeps the live job linked");
  await assert.rejects(fmx.bounties.hire({ bountyId: 9, agentId: 3 }), /already settled by escrow job 41/);
  assert.equal(sent.length, 1, "one escrow job for one reward");

  // once that job is refunded, the bounty may be awarded and hired again
  indexed.set(41, "Refunded");
  assert.equal((await fmx.bounties.award({ bountyId: 9, agentId: 3 })).jobId, null);
  assert.equal((await fmx.bounties.hire({ bountyId: 9, agentId: 3 })).jobId, 42);
});
