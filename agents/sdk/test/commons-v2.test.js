// SDK Commons v2: fmx.stream() SSE parsing + resume, activity/leaderboard GETs,
// signed writes carry the right action, jobs.input() falls back to inputHash
// for bounty hires (inputURI fmx://bounty/<id>). Stub gateway on a local port.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { keccak256, toUtf8Bytes } from "ethers";
import { Ferminux, verifySigned } from "../dist/index.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function stubGateway() {
  const calls = [];
  const streams = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const isJson = (req.headers["content-type"] || "").includes("json") && url.pathname !== "/api/payloads";
      calls.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: isJson && body ? JSON.parse(body) : body || null });
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": hello\n\n");
        const sinceId = Number(req.headers["last-event-id"] || url.searchParams.get("sinceId") || 0);
        for (const id of [1, 2, 3]) if (id > sinceId) res.write(`id: ${id}\nevent: kb.write\ndata: {"id":${id},"type":"kb.write","ts":${id},"actor":null,"ref":null,"data":{"slug":"p${id}"}}\n\n`);
        streams.push(res);
        return;
      }
      if (url.pathname === "/api/activity") return json(200, { items: [{ id: 9, type: "job.completed", ts: 1, actor: null, ref: null, data: {} }], since: 0, sinceId: 0, now: 2 });
      if (url.pathname === "/api/leaderboard") return json(200, { periods: { "30d": [], all: [] }, weights: {}, since30d: 0, generatedAt: 1 });
      if (url.pathname === "/api/jobs/5") return json(200, { id: 5, inputURI: "fmx://bounty/3", inputHash: keccak256(toUtf8Bytes("brief")), status: "Open" });
      if (url.pathname.startsWith("/api/payloads/")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("brief"); }
      if (url.pathname === "/api/payloads" && req.method === "POST") return json(200, { hash: keccak256(toUtf8Bytes(body)), uri: "fmx://payload/x", size: body.length });
      if (req.method === "POST" || req.method === "PUT") return json(201, { ok: true, echo: JSON.parse(body) });
      json(404, { error: "nope" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, streams, url: `http://127.0.0.1:${server.address().port}/api` })));
}

test("fmx.stream parses SSE frames, resumes from the last id on reconnect, and stops", async (t) => {
  const gw = await stubGateway();
  t.after(() => gw.server.close());
  const fmx = new Ferminux({ gateway: gw.url });
  t.after(() => fmx.provider.destroy());
  const got = [];
  const stop = fmx.stream((ev) => got.push(ev), { sinceId: 1 });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(got.map((e) => e.id), [2, 3]);
  assert.match(gw.calls[0].path, /sinceId=1/);
  assert.equal(gw.calls[0].headers["last-event-id"], "1");
  // server drops the connection → client reconnects with Last-Event-ID: 3 (after its 3 s backoff)
  gw.streams[0].end();
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(gw.calls.filter((c) => c.path.startsWith("/api/stream")).length, 2);
  assert.equal(gw.calls[1].headers["last-event-id"], "3");
  assert.deepEqual(got.map((e) => e.id), [2, 3]); // nothing newer replayed
  stop();
  await new Promise((r) => setTimeout(r, 50));
});

test("activity / leaderboard / signed v2 writes hit the right routes with the right actions", async (t) => {
  const gw = await stubGateway();
  t.after(() => gw.server.close());
  const fmx = new Ferminux({ gateway: gw.url, privateKey: KEY });
  t.after(() => fmx.provider.destroy());
  const act = await fmx.activity({ since: 10, type: "job." });
  assert.equal(act.items[0].type, "job.completed");
  assert.equal(gw.calls.at(-1).path, "/api/activity?since=10&type=job.");
  await fmx.leaderboard({ limit: 5 });
  assert.equal(gw.calls.at(-1).path, "/api/leaderboard?limit=5");

  const now = Math.floor(Date.now() / 1000);
  const check = (call, action, method, path) => {
    assert.equal(call.method, method);
    assert.equal(call.path, path);
    const { address, ts, sig, ...payload } = call.body;
    assert.equal(verifySigned(action, { address, ts, sig }, payload, now), fmx.address);
    return payload;
  };
  await fmx.bounties.create({ title: "T", brief: "B", reward: 2, tags: ["x"] });
  assert.deepEqual(check(gw.calls.at(-1), "bounty.create", "POST", "/api/bounties"), { title: "T", brief: "B", rewardWei: "2000000000000000000", tags: ["x"] });
  await fmx.bounties.claim({ bountyId: 1, agentId: 7n, pitch: "p" });
  check(gw.calls.at(-1), "bounty.claim", "POST", "/api/bounties/1/claims");
  await fmx.bounties.award({ bountyId: 1, agentId: 7 });
  assert.deepEqual(check(gw.calls.at(-1), "bounty.award", "POST", "/api/bounties/1/award"), { agentId: 7 });
  await fmx.kb.write({ slug: "s", title: "t", body: "b" });
  assert.deepEqual(check(gw.calls.at(-1), "kb.write", "PUT", "/api/kb/s"), { title: "t", body: "b" });
  await fmx.tools.publish({ name: "n", kind: "mcp", url: "https://x.example" });
  check(gw.calls.at(-1), "tool.publish", "POST", "/api/tools");
  await fmx.artifacts.publish({ name: "a", kind: "prompt", content: "hello" });
  const ap = check(gw.calls.at(-1), "artifact.publish", "POST", "/api/artifacts");
  assert.equal(ap.payloadHash, keccak256(toUtf8Bytes("hello"))); // content uploaded first
  assert.equal(gw.calls.at(-2).path, "/api/payloads");
  await fmx.artifacts.star(4);
  assert.deepEqual(check(gw.calls.at(-1), "artifact.star", "POST", "/api/artifacts/4/star"), {});
  await fmx.presence.ping("idle");
  assert.deepEqual(check(gw.calls.at(-1), "presence.ping", "POST", "/api/presence"), { status: "idle" });
  await fmx.arena.create({ title: "c", brief: "b", endsAt: now + 3600, prize: "5" });
  assert.deepEqual(check(gw.calls.at(-1), "arena.create", "POST", "/api/arena/challenges"), { title: "c", brief: "b", prizeWei: "5", endsAt: now + 3600 });
  await fmx.arena.submit({ challengeId: 2, agentId: 7, url: "https://x.example/o" });
  check(gw.calls.at(-1), "arena.submit", "POST", "/api/arena/challenges/2/submissions");
  await fmx.arena.vote({ submissionId: 9, score: 8 });
  assert.deepEqual(check(gw.calls.at(-1), "arena.vote", "POST", "/api/arena/submissions/9/vote"), { score: 8 });
  await fmx.arena.award({ challengeId: 2, agentId: 7, jobId: 41 });
  assert.deepEqual(check(gw.calls.at(-1), "arena.award", "POST", "/api/arena/challenges/2/award"), { agentId: 7, jobId: 41 });

  // read-only client refuses writes
  const ro = new Ferminux({ gateway: gw.url });
  t.after(() => ro.provider.destroy());
  await assert.rejects(() => ro.presence.ping(), /read-only/);
});

test("jobs.input() uses inputHash when inputURI is fmx://bounty/<id>", async (t) => {
  const gw = await stubGateway();
  t.after(() => gw.server.close());
  const fmx = new Ferminux({ gateway: gw.url });
  t.after(() => fmx.provider.destroy());
  assert.equal(await fmx.jobs.input(5), "brief");
  assert.equal(gw.calls.at(-1).path, `/api/payloads/${keccak256(toUtf8Bytes("brief"))}`);
  await assert.rejects(() => fmx.fetchPayload("fmx://bounty/3"), /does not reference a payload/);
});
