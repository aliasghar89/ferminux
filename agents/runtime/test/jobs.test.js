// A job the agent cannot serve is declined on chain (ServiceEscrow.cancel → the client is credited in full)
// instead of being delivered as ok:true — Oracle used to charge 0.1 FMX for its help menu (audit 2026-09-24).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOneJob, isRefusal } from "../dist/jobs.js";
import { loadState } from "../dist/state.js";
import { chainHandler } from "../dist/handlers/chain.js";

const log = { info() {}, warn() {}, error() {} };
const OPEN = 1, DELIVERED = 2;

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "fmx-jobs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "agent-3-jobs.json");
}
function client(over = {}) {
  const calls = [];
  const c = {
    calls,
    status: async () => OPEN,
    input: async () => "what is the weather in Baku?",
    deliver: async (jobId, output) => { calls.push(["deliver", jobId, output]); return { tx: "0xd" }; },
    cancel: async (jobId) => { calls.push(["cancel", jobId]); return { tx: "0xc" }; },
    ...over,
  };
  return c;
}

test("jobs: a refusal ({ok:false}) is declined on chain, never delivered, and recorded with its reason", async (t) => {
  const statePath = tmp(t);
  const c = client();
  const out = await handleOneJob(c, 6, statePath, async () => ({ ok: false, op: "unknown", error: "unrecognised request" }), log, { retryDelayMs: 0 });
  assert.equal(out, "declined");
  assert.deepEqual(c.calls, [["cancel", 6]]);
  const st = loadState(statePath)["6"];
  assert.equal(st.status, "declined");
  assert.equal(st.reason, "unrecognised request");
  assert.equal(st.tx, "0xc");
  assert.equal(await handleOneJob(c, 6, statePath, async () => ({ ok: true }), log), "already", "never handled twice");
});

test("jobs: a served request is delivered as before", async (t) => {
  const c = client();
  const out = await handleOneJob(c, 7, tmp(t), async () => ({ ok: true, output: "42" }), log, { retryDelayMs: 0 });
  assert.equal(out, "delivered");
  assert.deepEqual(c.calls, [["deliver", 7, { ok: true, output: "42" }]]);
});

test("jobs: a handler that throws on every attempt declines the job; a failed DELIVERY of real work stays open (abandoned)", async (t) => {
  const c = client();
  let runs = 0;
  assert.equal(await handleOneJob(c, 8, tmp(t), async () => { runs++; throw new Error("model down"); }, log, { retryDelayMs: 0 }), "declined");
  assert.equal(runs, 3);
  assert.deepEqual(c.calls, [["cancel", 8]]);

  const c2 = client({ deliver: async () => { throw new Error("nonce too low"); } });
  const path2 = tmp(t);
  assert.equal(await handleOneJob(c2, 9, path2, async () => ({ ok: true, output: "done" }), log, { retryDelayMs: 0 }), "abandoned");
  assert.deepEqual(c2.calls, [], "the work exists: not cancelled, the client can still refund() after the window");
  assert.equal(loadState(path2)["9"].status, "abandoned");

  const c3 = client({ cancel: async () => { throw new Error("rpc down"); } });
  assert.equal(await handleOneJob(c3, 10, tmp(t), async () => ({ ok: false, error: "nope" }), log, { retryDelayMs: 0 }), "abandoned", "if the decline itself fails the job is left for the client's refund()");
});

test("jobs: a job no longer Open is skipped; an unreadable status is not recorded, so the next poll retries it", async (t) => {
  const c = client({ status: async () => DELIVERED });
  assert.equal(await handleOneJob(c, 11, tmp(t), async () => ({ ok: true }), log, { retryDelayMs: 0 }), "skipped");
  const path = tmp(t);
  const c2 = client({ status: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await handleOneJob(c2, 12, path, async () => ({ ok: true }), log, { retryDelayMs: 0 }), "abandoned");
  assert.equal(loadState(path)["12"], undefined);
});

test("chain handler: plain language or an unknown op is a refusal; the op list only for an explicit help", async () => {
  const q = await chainHandler("what is the price of FMX today?");
  assert.equal(q.ok, false);
  assert.equal(q.op, "unknown");
  assert.match(q.error, /send "help"/);
  assert.equal(isRefusal(q), true);
  const bad = await chainHandler({ op: "price" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /"price"/);
  assert.equal((await chainHandler("")).ok, false);
  assert.equal((await chainHandler({ address: "0x0" })).ok, false, "an object without an op is not a request either");
  const help = await chainHandler("help");
  assert.equal(help.ok, true);
  assert.equal(help.op, "help");
  assert.ok(Array.isArray(help.ops) && help.ops.includes("balance"));
  assert.equal((await chainHandler({ op: "help" })).ok, true);
  assert.equal((await chainHandler({ text: "HELP" })).ok, true);
  assert.equal(isRefusal({ ok: true }), false);
});

test("jobs: the poll and a webhook on the same job run the handler once; parallel jobs keep each other's outcomes", async (t) => {
  const statePath = tmp(t);
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { runs++; await gate; return { ok: true, output: "done" }; };
  const c = client();
  const first = handleOneJob(c, 20, statePath, slow, log, { retryDelayMs: 0 });
  const second = await handleOneJob(c, 20, statePath, slow, log, { retryDelayMs: 0 });
  assert.equal(second, "already", "a second caller does not start the same job while the first is on it");
  // another job finishes while job 20 is still running: its outcome must survive job 20's save
  assert.equal(await handleOneJob(c, 21, statePath, async () => ({ ok: true }), log, { retryDelayMs: 0 }), "delivered");
  release();
  assert.equal(await first, "delivered");
  assert.equal(runs, 1);
  const st = loadState(statePath);
  assert.equal(st["20"].status, "delivered");
  assert.equal(st["21"]?.status, "delivered", "job 21's entry was not erased by job 20's stale copy");
  assert.deepEqual(c.calls.filter((x) => x[0] === "deliver").map((x) => x[1]).sort(), [20, 21]);
});

test("chain handler validate: answers only the request filed for that job, addressed to this key, for the job's agent", async () => {
  const { validateRefusal, expectedRequestHash } = await import("../dist/handlers/chain.js");
  const me = "0x1111111111111111111111111111111111111111";
  const outputHash = "0x" + "ab".repeat(32);
  const job = { agentId: 3, outputHash, outputURI: "ipfs://out" };
  const H = outputHash;
  assert.equal(expectedRequestHash(9, job), outputHash);
  assert.equal(validateRefusal(me, 9, job, H, { validatorAddress: me, agentId: 3 }), null, "the gateway's own request for job 9");
  assert.equal(validateRefusal(me.toUpperCase().replace("0X", "0x"), 9, job, H.toUpperCase().replace("0X", "0x"), { validatorAddress: me, agentId: 3 }), null, "case does not matter");
  assert.match(validateRefusal(me, 9, job, H, null), /no validation request/);
  assert.match(validateRefusal(me, 9, job, H, { validatorAddress: "0x2222222222222222222222222222222222222222", agentId: 3 }), /names validator/);
  // an owner's request for their own agent 5, answered with job 9 of agent 3: bought reputation
  assert.match(validateRefusal(me, 9, job, H, { validatorAddress: me, agentId: 5 }), /is for agent 5; job 9 belongs to agent 3/);
  // a second request for the same job under another hash: one validation per job
  assert.match(validateRefusal(me, 9, job, "0x" + "cd".repeat(32), { validatorAddress: me, agentId: 3 }), /not the one filed for job 9/);
  // no output hash: the gateway hashes the output URI, else fmx://job/<id>
  const { keccak256, toUtf8Bytes } = await import("ethers");
  assert.equal(expectedRequestHash(9, { outputHash: null, outputURI: "ipfs://out" }), keccak256(toUtf8Bytes("ipfs://out")));
  assert.equal(expectedRequestHash(9, { outputHash: null, outputURI: null }), keccak256(toUtf8Bytes("fmx://job/9")));
  // a malformed hash is refused before anything is read
  const bad = await chainHandler({ op: "validate", jobId: 9, requestHash: "0x1234" });
  assert.equal(bad.ok, false);
});
