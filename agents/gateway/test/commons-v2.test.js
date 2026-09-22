// Commons v2 route tests: bounties, knowledge base, tools, artifacts, presence,
// activity, leaderboard, arena, ideas board. Fastify inject, in-memory SQLite,
// fake clock. Every resource: happy path + auth failure + validation.
// Stubbed fetches target *.example hosts that never resolve; the SSRF guard (src/net.ts) is exercised explicitly in security.test.js.
process.env.ALLOW_PRIVATE_FETCH = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage, COMMONS_ACTIONS } from "../dist/commons/sign.js";
import { hasKbFts } from "../dist/commons/schema.js";
import { ftsQuery } from "../dist/commons/kb.js";

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
};

const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // owns Active agent 7
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // plain wallet
const carol = new Wallet("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // owns Paused agent 8
const dave = new Wallet("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"); // owns Active agent 9

async function setup() {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt, jobsCompleted, ratingCount, ratingSum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    7, alice.address, "Scribe", "https://scribe.example", 1, 1_758_000_000, 12, 4, 18,
  );
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(8, carol.address, "Idle", "", 2, 1_758_000_100);
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(9, dave.address, "Judge", "https://judge.example", 1, 1_758_000_200);
  const { app, activity } = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  const clock = { get: () => nowMs, advance: (ms) => (nowMs += ms), s: () => Math.floor(nowMs / 1000) };
  async function signed(wallet, action, payload = {}, tsOverride) {
    const ts = tsOverride ?? clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  }
  const post = (url, body) => app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
  const put = (url, body) => app.inject({ method: "PUT", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
  const get = async (url) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, json: res.statusCode === 200 ? res.json() : res.body, res };
  };
  // each signed write from the same wallet needs a fresh second (1 write/s)
  const w = async (wallet, method, url, action, payload) => {
    clock.advance(1100);
    const body = await signed(wallet, action, payload);
    return (method === "PUT" ? put : post)(url, body);
  };
  return { app, db, activity, clock, signed, post, put, get, w };
}

test("COMMONS_ACTIONS contains every v2 action", () => {
  for (const a of ["bounty.create", "bounty.claim", "bounty.award", "kb.write", "tool.publish", "artifact.publish", "artifact.star", "presence.ping", "arena.create", "arena.submit", "arena.vote", "arena.award"]) {
    assert.ok(COMMONS_ACTIONS.includes(a), a);
  }
  assert.equal(COMMONS_ACTIONS.length, 22); // 16 Commons + 5 Addendum v3 (memory.put/get/delete, webhook.set/delete) + referral.claim
});

test("bounties", async (t) => {
  const { app, clock, signed, post, get, w } = await setup();
  t.after(() => app.close());
  let bountyId;

  await t.test("create → 201 open, list/sort/search, get with claims", async () => {
    const res = await post("/api/bounties", await signed(bob, "bounty.create", { title: "Summarise 10 PDFs", brief: "Ten **PDFs**, one paragraph each.", rewardWei: "2000000000000000000", tags: ["Summarize", "pdf"], deadline: clock.s() + 86400 }));
    assert.equal(res.statusCode, 201, res.body);
    const j = res.json();
    bountyId = j.id;
    assert.equal(j.status, "open");
    assert.equal(j.rewardWei, "2000000000000000000");
    assert.deepEqual(j.tags, ["summarize", "pdf"]);
    assert.deepEqual(j.poster, { address: bob.address, name: null, agentId: null });
    assert.deepEqual(j.author, j.poster); // alias for the web normaliser
    assert.deepEqual(j.claims, []);
    assert.equal(j.claimCount, 0);
    const r2 = await w(alice, "POST", "/api/bounties", "bounty.create", { title: "Cheap one", brief: "small", rewardWei: "5" });
    assert.equal(r2.statusCode, 201);
    const list = (await get("/api/bounties?status=open&sort=reward")).json;
    assert.equal(list.total, 2);
    assert.equal(list.items[0].id, bountyId); // 2 FMX before 5 wei
    assert.equal((await get("/api/bounties?q=pdf")).json.total, 1);
    assert.equal((await get("/api/bounties?tag=PDF")).json.total, 1);
    assert.equal((await get("/api/bounties?status=nope")).status, 400);
    assert.equal((await get("/api/bounties/999")).status, 404);
  });

  await t.test("validation: missing reward / bad wei / past deadline / oversize brief", async () => {
    clock.advance(1100);
    assert.equal((await post("/api/bounties", await signed(bob, "bounty.create", { title: "x", brief: "y" }))).statusCode, 400);
    assert.equal((await post("/api/bounties", await signed(bob, "bounty.create", { title: "x", brief: "y", rewardWei: "1.5" }))).statusCode, 400);
    assert.equal((await post("/api/bounties", await signed(bob, "bounty.create", { title: "x", brief: "y", rewardWei: "1", deadline: clock.s() - 1 }))).statusCode, 400);
    assert.equal((await post("/api/bounties", await signed(bob, "bounty.create", { title: "x", brief: "y".repeat(16 * 1024 + 1), rewardWei: "1" }))).statusCode, 413);
  });

  await t.test("auth: tampered payload → 401, unsigned → 401", async () => {
    const body = await signed(bob, "bounty.create", { title: "x", brief: "y", rewardWei: "1" });
    body.rewardWei = "999";
    const res = await post("/api/bounties", body);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "sig_mismatch");
    assert.equal((await post("/api/bounties", { title: "x", brief: "y", rewardWei: "1" })).statusCode, 401);
  });

  await t.test("claim: must own the agent; poster cannot claim; re-claim updates pitch", async () => {
    const r1 = await w(alice, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 7, pitch: "I read PDFs for a living." });
    assert.equal(r1.statusCode, 201, r1.body);
    assert.equal(r1.json().agentName, "Scribe");
    assert.deepEqual(r1.json().agent, { agentId: 7, name: "Scribe" });
    assert.deepEqual(r1.json().claimer, { address: alice.address, name: "Scribe", agentId: 7 });
    const notOwner = await w(bob, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 7, pitch: "mine?" });
    assert.equal(notOwner.statusCode, 403);
    assert.equal(notOwner.json().code, "not_owner");
    const missingAgent = await w(bob, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 999, pitch: "x" });
    assert.equal(missingAgent.statusCode, 404);
    const again = await w(alice, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 7, pitch: "Updated pitch." });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().id, r1.json().id);
    const detail = (await get(`/api/bounties/${bountyId}`)).json;
    assert.equal(detail.claims.length, 1);
    assert.equal(detail.claims[0].pitch, "Updated pitch.");
    assert.equal(detail.claimCount, 1);
    // dave (Judge) claims too
    assert.equal((await w(dave, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 9, pitch: "Me too" })).statusCode, 201);
    // bad pitch
    assert.equal((await w(dave, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 9, pitch: "" })).statusCode, 400);
  });

  await t.test("award: poster only; links jobId when indexed; status awarded; claims closed", async () => {
    const notPoster = await w(alice, "POST", `/api/bounties/${bountyId}/award`, "bounty.award", { agentId: 7 });
    assert.equal(notPoster.statusCode, 403);
    assert.equal(notPoster.json().code, "not_poster");
    const res = await w(bob, "POST", `/api/bounties/${bountyId}/award`, "bounty.award", { agentId: 7, jobId: 41 }); // job 41 not indexed yet: accepted
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, "awarded");
    assert.equal(res.json().awardedAgentId, 7);
    assert.equal(res.json().awardedAgentName, "Scribe");
    assert.equal(res.json().jobId, 41);
    assert.equal(res.json().jobStatus, null);
    const late = await w(dave, "POST", `/api/bounties/${bountyId}/claims`, "bounty.claim", { agentId: 9, pitch: "late" });
    assert.equal(late.statusCode, 409);
    assert.equal((await get("/api/bounties?status=awarded")).json.total, 1);
    assert.equal((await get("/api/bounties?status=open")).json.total, 1);
  });

  await t.test("award: unknown agent → 404", async () => {
    const r = await w(bob, "POST", `/api/bounties/${bountyId}/award`, "bounty.award", { agentId: 999 });
    assert.equal(r.statusCode, 404);
  });

  await t.test("activity carries bounty.create/claim/award", async () => {
    const items = (await get("/api/activity?type=bounty.")).json.items;
    const types = items.map((e) => e.type);
    assert.ok(types.includes("bounty.create") && types.includes("bounty.claim") && types.includes("bounty.award"));
    const award = items.find((e) => e.type === "bounty.award");
    assert.equal(award.actor.address, bob.address);
    assert.equal(award.data.agentName, "Scribe");
    assert.deepEqual(award.ref, { kind: "bounty", id: String(bountyId) });
  });
});

test("knowledge base", async (t) => {
  const { app, db, clock, signed, put, get, w } = await setup();
  t.after(() => app.close());

  await t.test("seed pages exist, authored by Ferminux (zero address), with real content", async () => {
    const list = (await get("/api/kb")).json;
    const slugs = list.items.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ["ferminux-network", "how-to-hire", "how-to-register", "signing"]);
    assert.equal(list.total, 4);
    const page = (await get("/api/kb/ferminux-network")).json;
    assert.deepEqual(page.createdBy, { address: "0x0000000000000000000000000000000000000000", name: "Ferminux", agentId: null });
    assert.equal(page.rev, 1);
    for (const needle of ["3961", cfg.registry, cfg.escrow, "https://rpc.ferminux.net", "0xf4dE70068031DA17347cd19aCaa841013751B3c0", "Clique"]) assert.ok(page.body.includes(needle), needle);
    const signing = (await get("/api/kb/signing")).json;
    assert.ok(signing.body.includes("Ferminux Commons") && signing.body.includes("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"));
    for (const a of COMMONS_ACTIONS) assert.ok(signing.body.includes(a), `signing page missing ${a}`);
    const hire = (await get("/api/kb/how-to-hire")).json;
    assert.ok(hire.body.includes("requestJob") && hire.body.includes("fmx.hire"));
    const reg = (await get("/api/kb/how-to-register")).json;
    assert.ok(reg.body.includes("ferminux-agent register") && reg.body.includes("minBond"));
    assert.equal((await get("/api/kb/nope-nope")).status, 404);
    assert.equal((await get("/api/kb/Bad_Slug")).status, 400);
    // seeding again is a no-op (revisions untouched)
    const { seedKb } = await import("../dist/commons/kb.js");
    assert.deepEqual(seedKb(db, cfg), []);
    assert.equal((await get("/api/kb/signing")).json.rev, 1);
  });

  let firstRev;
  await t.test("PUT creates (201) then revises (200); history lists revisions; rev=N returns a body", async () => {
    const r1 = await w(alice, "PUT", "/api/kb/pdf-tips", "kb.write", { title: "PDF tips", body: "# PDF tips\n\nUse `pdftotext -layout` for tables.", summary: "How to read PDFs well" });
    assert.equal(r1.statusCode, 201, r1.body);
    assert.equal(r1.json().rev, 1);
    assert.deepEqual(r1.json().updatedBy, { address: alice.address, name: "Scribe", agentId: 7 });
    firstRev = r1.json();
    const r2 = await w(bob, "PUT", "/api/kb/pdf-tips", "kb.write", { title: "PDF tips (v2)", body: "# PDF tips\n\nUse `pdftotext -layout` for tables. OCR scanned ones with tesseract." });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().rev, 2);
    assert.equal(r2.json().createdBy.address, alice.address);
    assert.equal(r2.json().updatedBy.address, bob.address);
    assert.equal(r2.json().summary, "");
    const h = (await get("/api/kb/pdf-tips/history")).json;
    assert.equal(h.rev, 2);
    assert.deepEqual(h.items.map((x) => x.rev), [2, 1]);
    assert.equal(h.items[1].author.address, alice.address);
    const old = (await get("/api/kb/pdf-tips/history?rev=1")).json;
    assert.equal(old.body, firstRev.body);
    assert.equal((await get("/api/kb/pdf-tips/history?rev=9")).status, 404);
    assert.equal((await get("/api/kb/missing/history")).status, 404);
  });

  await t.test("validation + auth: bad slug, empty body, >64 KiB, bad sig, action mismatch", async () => {
    clock.advance(1100);
    assert.equal((await put("/api/kb/x", await signed(alice, "kb.write", { title: "t", body: "b" }))).statusCode, 400);
    assert.equal((await put("/api/kb/ok-slug", await signed(alice, "kb.write", { title: "t", body: "  " }))).statusCode, 400);
    assert.equal((await put("/api/kb/ok-slug", await signed(alice, "kb.write", { title: "t", body: "x".repeat(64 * 1024 + 1) }))).statusCode, 413);
    assert.equal((await put("/api/kb/ok-slug", await signed(alice, "kb.write", { title: "t", body: "x".repeat(64 * 1024) }))).statusCode, 201);
    clock.advance(1100);
    assert.equal((await put("/api/kb/ok-slug", await signed(alice, "thread.create", { title: "t", body: "b" }))).statusCode, 401);
    const tampered = await signed(alice, "kb.write", { title: "t", body: "b" });
    tampered.body = "evil";
    assert.equal((await put("/api/kb/ok-slug", tampered)).statusCode, 401);
  });

  await t.test("full-text search (FTS5) ranks and snippets; LIKE-safe on odd input", async () => {
    assert.ok(hasKbFts(db), "better-sqlite3 should ship FTS5");
    assert.equal(ftsQuery('pdf "tables" OR x'), '"pdf"* "tables"* "OR"* "x"*');
    const r = (await get("/api/kb?q=tesseract")).json;
    assert.equal(r.fts, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].slug, "pdf-tips");
    assert.match(r.items[0].snippet, /\[tesseract\]/);
    const esc = (await get("/api/kb?q=escrow")).json;
    assert.ok(esc.items.length >= 2);
    assert.ok(esc.items.every((p) => typeof p.rank === "number"));
    const weird = (await get(`/api/kb?q=${encodeURIComponent('"(*&^ OR NOT ---')}`)).json;
    assert.ok(Array.isArray(weird.items));
    assert.equal((await get("/api/kb?q=zzzzqqqq")).json.items.length, 0);
  });
});

test("tools registry", async (t) => {
  const { app, db, clock, signed, post, get, w } = await setup();
  t.after(() => app.close());
  let toolId;

  await t.test("publish → 201; re-publish same (owner,name) → 200 update; list/get/filter", async () => {
    const r1 = await post("/api/tools", await signed(alice, "tool.publish", { name: "pdf-extract", kind: "http", url: "https://scribe.example/pdf", description: "Extract text from PDFs", schema: { input: { type: "string" } } }));
    assert.equal(r1.statusCode, 201, r1.body);
    toolId = r1.json().id;
    assert.deepEqual(r1.json().owner, { address: alice.address, name: "Scribe", agentId: 7 });
    assert.deepEqual(r1.json().schema, { input: { type: "string" } });
    assert.equal(r1.json().online, false);
    const r2 = await w(alice, "POST", "/api/tools", "tool.publish", { name: "pdf-extract", kind: "mcp", url: "https://scribe.example/mcp" });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().id, toolId);
    assert.equal(r2.json().kind, "mcp");
    assert.equal(r2.json().schema, null);
    const r3 = await w(bob, "POST", "/api/tools", "tool.publish", { name: "pdf-extract", kind: "a2a", url: "https://bob.example/a2a" });
    assert.equal(r3.statusCode, 201); // different owner → different tool
    assert.equal((await get("/api/tools")).json.total, 2);
    assert.equal((await get("/api/tools?kind=mcp")).json.total, 1);
    assert.equal((await get("/api/tools?q=bob.example")).json.total, 1);
    assert.equal((await get(`/api/tools/${toolId}`)).json.name, "pdf-extract");
    assert.equal((await get("/api/tools/999")).status, 404);
    assert.equal((await get("/api/tools?kind=x")).status, 400);
  });

  await t.test("validation + auth", async () => {
    clock.advance(1100);
    assert.equal((await post("/api/tools", await signed(alice, "tool.publish", { name: "bad name!", kind: "http", url: "https://x.example" }))).statusCode, 400);
    assert.equal((await post("/api/tools", await signed(alice, "tool.publish", { name: "ok", kind: "grpc", url: "https://x.example" }))).statusCode, 400);
    assert.equal((await post("/api/tools", await signed(alice, "tool.publish", { name: "ok", kind: "http", url: "ftp://x.example" }))).statusCode, 400);
    assert.equal((await post("/api/tools", await signed(alice, "tool.publish", { name: "ok", kind: "http", url: "https://x.example", schema: [1] }))).statusCode, 400);
    assert.equal((await post("/api/tools", { name: "ok", kind: "http", url: "https://x.example" })).statusCode, 401);
  });

  await t.test("probe: HEAD 405 then GET 200 → online; network error → offline", async () => {
    const { probeUrl, probeTool } = await import("../dist/commons/tools.js");
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push(init.method);
      if (init.method === "HEAD") return new Response(null, { status: 405 });
      return new Response("ok", { status: 200 });
    };
    assert.equal(await probeUrl("https://x.example", fakeFetch), true);
    assert.deepEqual(calls, ["HEAD", "GET"]);
    assert.equal(await probeUrl("https://x.example", async () => new Response(null, { status: 401 })), true); // HEAD 401 → GET 401 → up
    assert.equal(await probeUrl("https://x.example", async () => new Response(null, { status: 204 })), true);
    assert.equal(await probeUrl("https://x.example", async () => new Response(null, { status: 503 })), false);
    assert.equal(await probeUrl("https://x.example", async () => new Response(null, { status: 404 })), false);
    assert.equal(await probeUrl("https://x.example", async () => { throw new Error("ECONNREFUSED"); }), false);
    // publish-time probe (stubbed 200) marked the tool online
    await new Promise((r) => setTimeout(r, 20));
    const tool = (await get(`/api/tools/${toolId}`)).json;
    assert.equal(tool.online, true);
    assert.ok(tool.lastSeen > 0);
    assert.equal((await get("/api/tools?online=1")).json.total, 2);
    // a failing probe flips it offline
    assert.equal(await probeTool(db, { id: toolId, url: "https://scribe.example/mcp" }, async () => { throw new Error("ECONNREFUSED"); }), false);
    assert.equal((await get(`/api/tools/${toolId}`)).json.online, false);
  });
});

test("artifacts", async (t) => {
  const { app, clock, signed, post, get, w } = await setup();
  t.after(() => app.close());
  let artifactId;
  const content = JSON.stringify({ prompt: "You are a careful summariser." });
  const hash = keccak256(toUtf8Bytes(content));

  await t.test("publish requires a stored payloadHash or https url", async () => {
    const missing = await post("/api/artifacts", await signed(alice, "artifact.publish", { name: "Summariser prompt", kind: "prompt", payloadHash: hash }));
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().code, "unknown_payload");
    const up = await app.inject({ method: "POST", url: "/api/payloads", headers: { "content-type": "application/json" }, payload: content });
    assert.equal(up.json().hash, hash);
    const res = await post("/api/artifacts", await signed(alice, "artifact.publish", { name: "Summariser prompt", kind: "prompt", payloadHash: hash, license: "MIT", tags: ["prompt", "Summarize"], description: "A prompt." }));
    assert.equal(res.statusCode, 201, res.body);
    artifactId = res.json().id;
    assert.equal(res.json().payloadURI, `fmx://payload/${hash}`);
    assert.equal(res.json().payloadSize, content.length);
    assert.equal(res.json().payloadContentType, "application/json");
    assert.equal(res.json().stars, 0);
    const byUrl = await w(bob, "POST", "/api/artifacts", "artifact.publish", { name: "Big dataset", kind: "dataset", url: "https://data.example/set.parquet" });
    assert.equal(byUrl.statusCode, 201);
    assert.equal(byUrl.json().payloadHash, null);
    clock.advance(1100);
    assert.equal((await post("/api/artifacts", await signed(bob, "artifact.publish", { name: "x", kind: "dataset", url: "http://insecure.example/x" }))).statusCode, 400);
    assert.equal((await post("/api/artifacts", await signed(bob, "artifact.publish", { name: "x", kind: "dataset" }))).statusCode, 400);
    assert.equal((await post("/api/artifacts", await signed(bob, "artifact.publish", { name: "x", kind: "video", url: "https://x.example" }))).statusCode, 400);
    assert.equal((await post("/api/artifacts", { name: "x", kind: "dataset", url: "https://x.example" })).statusCode, 401);
  });

  await t.test("list/get/filter", async () => {
    assert.equal((await get("/api/artifacts")).json.total, 2);
    assert.equal((await get("/api/artifacts?kind=prompt")).json.total, 1);
    assert.equal((await get("/api/artifacts?tag=summarize")).json.total, 1);
    assert.equal((await get("/api/artifacts?q=parquet")).json.total, 1);
    const d = (await get(`/api/artifacts/${artifactId}`)).json;
    assert.deepEqual(d.stargazers, []);
    assert.equal((await get("/api/artifacts/999")).status, 404);
  });

  await t.test("star: one per address, second is a no-op 200, stars counted", async () => {
    const r1 = await w(bob, "POST", `/api/artifacts/${artifactId}/star`, "artifact.star", {});
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(r1.json().stars, 1);
    assert.equal(r1.json().changed, true);
    const r2 = await w(bob, "POST", `/api/artifacts/${artifactId}/star`, "artifact.star", {});
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().stars, 1);
    assert.equal(r2.json().changed, false);
    const r3 = await w(dave, "POST", `/api/artifacts/${artifactId}/star`, "artifact.star", {});
    assert.equal(r3.json().stars, 2);
    const d = (await get(`/api/artifacts/${artifactId}`)).json;
    assert.equal(d.stargazers.length, 2);
    assert.equal(d.starred, undefined);
    assert.equal((await get(`/api/artifacts/${artifactId}?viewer=${bob.address.toLowerCase()}`)).json.starred, true);
    assert.equal((await get(`/api/artifacts/${artifactId}?viewer=${alice.address}`)).json.starred, false);
    assert.deepEqual(Object.keys(r1.json()).filter((k) => ["stars", "starred"].includes(k)).sort(), ["starred", "stars"]);
    assert.equal((await get("/api/artifacts?sort=stars")).json.items[0].id, artifactId);
    assert.equal((await w(bob, "POST", "/api/artifacts/999/star", "artifact.star", {})).statusCode, 404);
    const stars = (await get("/api/activity?type=artifact.star")).json.items;
    assert.equal(stars.length, 2); // no-op star emitted nothing
    assert.equal(stars[0].data.owner.name, "Scribe"); // owner expanded to Author
  });
});

test("presence + activity + leaderboard", async (t) => {
  const { app, db, clock, signed, post, get, w } = await setup();
  t.after(() => app.close());

  await t.test("presence ping → online for 5 min with agent name; expires; bad sig 401", async () => {
    const r = await post("/api/presence", await signed(alice, "presence.ping", { status: "idle, taking jobs" }));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().name, "Scribe");
    assert.equal(r.json().ttl, 300);
    await w(bob, "POST", "/api/presence", "presence.ping", {});
    let p = (await get("/api/presence")).json;
    assert.equal(p.items.length, 2);
    assert.equal(p.items[0].address, bob.address); // most recent first
    assert.equal(p.items[1].status, "idle, taking jobs");
    clock.advance(299_000);
    assert.equal((await get("/api/presence")).json.items.length, 2); // both inside the 300 s TTL
    clock.advance(1_000);
    assert.equal((await get("/api/presence")).json.items.length, 1); // alice expired (pinged 1 s earlier than bob)
    clock.advance(1_000);
    assert.equal((await get("/api/presence")).json.items.length, 0);
    clock.advance(1100);
    const bad = await signed(alice, "presence.ping", { status: "x" });
    bad.status = "y";
    assert.equal((await post("/api/presence", bad)).statusCode, 401);
    assert.equal((await post("/api/presence", await signed(alice, "presence.ping", { status: "s".repeat(141) }))).statusCode, 400);
    // presence pings are NOT activity
    assert.equal((await get("/api/activity")).json.items.filter((e) => e.type.startsWith("presence")).length, 0);
  });

  await t.test("activity: since / sinceId / type / actor filters, newest first, message shows no body", async () => {
    const t0 = clock.s();
    clock.advance(5000);
    await w(alice, "POST", "/api/forum/threads", "thread.create", { title: "Hello", body: "secret body text", tags: ["idea"] });
    await w(bob, "POST", "/api/messages", "message.send", { to: 7, subject: "Q", body: "private body" });
    const all = (await get("/api/activity")).json;
    assert.ok(all.items.length >= 2);
    assert.equal(all.items[0].type, "message.send");
    assert.equal(all.items[1].type, "thread.create");
    assert.ok(all.items[0].id > all.items[1].id);
    const msg = all.items[0];
    assert.equal(msg.at, msg.ts); // alias
    assert.deepEqual(msg.actor, { address: bob.address, name: null, agentId: null });
    assert.deepEqual(msg.data.to, { address: alice.address, name: "Scribe", agentId: 7 });
    assert.equal(msg.data.subject, "Q");
    assert.ok(!JSON.stringify(msg).includes("private body"));
    assert.ok(!JSON.stringify(all.items[1]).includes("secret body text") || all.items[1].data.excerpt.startsWith("secret")); // excerpt only, ≤120 chars
    const since = (await get(`/api/activity?since=${t0}`)).json;
    assert.equal(since.items.length, 2);
    const sinceId = (await get(`/api/activity?sinceId=${all.items[1].id}`)).json;
    assert.deepEqual(sinceId.items.map((e) => e.id), [all.items[0].id]);
    assert.equal((await get("/api/activity?type=thread.create")).json.items.length, 1);
    assert.equal((await get("/api/activity?type=message.")).json.items.length, 1);
    assert.equal((await get(`/api/activity?actor=${bob.address.toLowerCase()}`)).json.items.length, 1);
    assert.equal(since.now, clock.s());
  });

  await t.test("leaderboard: 30d vs all-time; metrics and score math", async () => {
    // Scribe: 12 completed jobs all-time (agents table), rating 4.5; add jobs rows: 2 recent completed, 1 old completed
    const now = clock.s();
    const ins = db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt, deliveredAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run(1, 7, bob.address, "1", 3, now - 86400, now - 86000);
    ins.run(2, 7, bob.address, "1", 3, now - 2 * 86400, now - 2 * 86400 + 100);
    ins.run(3, 7, bob.address, "1", 3, now - 40 * 86400, now - 40 * 86400 + 100);
    ins.run(4, 9, bob.address, "1", 1, now - 100, null); // open, not counted
    const ev = db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON) VALUES (?, ?, ?, ?, ?, ?)");
    ev.run("0xa", 0, 1, "escrow", "JobCompleted", JSON.stringify({ jobId: "1", agentPayout: "1", fee: "0", rating: "5" }));
    ev.run("0xb", 0, 1, "escrow", "JobCompleted", JSON.stringify({ jobId: "2", agentPayout: "1", fee: "0", rating: "4" }));
    ev.run("0xc", 0, 1, "escrow", "JobCompleted", JSON.stringify({ jobId: "3", agentPayout: "1", fee: "0", rating: "1" }));
    // bob: 1 forum post (message doesn't count), 1 star given (counts for alice as received), alice: kb edit + artifact
    await w(alice, "PUT", "/api/kb/notes", "kb.write", { title: "Notes", body: "n" });
    await w(alice, "POST", "/api/artifacts", "artifact.publish", { name: "A", kind: "code", url: "https://x.example/a" });
    const art = (await get("/api/artifacts")).json.items[0];
    await w(bob, "POST", `/api/artifacts/${art.id}/star`, "artifact.star", {});
    const lb = (await get("/api/leaderboard")).json;
    assert.deepEqual(Object.keys(lb.periods), ["30d", "all"]);
    const a30 = lb.periods["30d"].find((e) => e.address === alice.address);
    const aAll = lb.periods.all.find((e) => e.address === alice.address);
    assert.equal(a30.name, "Scribe");
    assert.equal(a30.completedJobs, 2);
    assert.equal(a30.ratingAvg, 4.5); // (5+4)/2 from events within window
    assert.equal(a30.ratingCount, 2);
    assert.equal(a30.forumPosts, 1);
    assert.equal(a30.kbEdits, 1);
    assert.equal(a30.artifacts, 1);
    assert.equal(a30.starsReceived, 1);
    assert.equal(a30.arenaWins, 0);
    assert.equal(a30.score, 2 * 10 + 1 * 1 + 1 * 3 + 1 * 5 + 1 * 2 + 4.5 * 4);
    assert.equal(a30.rank, 1);
    assert.equal(aAll.completedJobs, 3);
    assert.equal(aAll.ratingAvg, 4.5); // agents table: 18/4
    assert.equal(aAll.ratingCount, 4);
    const b = lb.periods.all.find((e) => e.address === bob.address);
    assert.equal(b, undefined); // bob only sent a message and gave a star: no metric of his own → no entry
    assert.ok(!lb.periods.all.some((e) => e.address === "0x0000000000000000000000000000000000000000")); // seed edits excluded
    assert.equal(lb.weights.completedJobs, 10);
  });
});

test("arena", async (t) => {
  const { app, clock, signed, post, get, w } = await setup();
  t.after(() => app.close());
  let challengeId;
  let subAlice;
  let subBob;

  await t.test("create: endsAt window validation; list open/closed", async () => {
    const now = clock.s();
    assert.equal((await post("/api/arena/challenges", await signed(dave, "arena.create", { title: "Best haiku", brief: "Write a haiku about escrow.", endsAt: now + 60 }))).statusCode, 400);
    assert.equal((await post("/api/arena/challenges", await signed(dave, "arena.create", { title: "Best haiku", brief: "x", endsAt: now + 91 * 86400 }))).statusCode, 400);
    assert.equal((await post("/api/arena/challenges", { title: "Best haiku", brief: "x", endsAt: now + 3600 })).statusCode, 401);
    const res = await post("/api/arena/challenges", await signed(dave, "arena.create", { title: "Best haiku", brief: "Write a haiku about escrow.", rules: "17 syllables", prizeWei: "1000000000000000000", endsAt: now + 3600, tags: ["Poetry"] }));
    assert.equal(res.statusCode, 201, res.body);
    challengeId = res.json().id;
    assert.equal(res.json().status, "open");
    assert.deepEqual(res.json().tags, ["poetry"]);
    assert.deepEqual(res.json().submissions, []);
    assert.equal(res.json().creator.name, "Judge");
    assert.deepEqual(res.json().author, res.json().creator);
    assert.equal((await get("/api/arena/challenges?status=open")).json.total, 1);
    assert.equal((await get("/api/arena/challenges?status=closed")).json.total, 0);
    assert.equal((await get("/api/arena/challenges?status=x")).status, 400);
  });

  await t.test("submit: payload or url; agentId must be owned; one per address", async () => {
    const up = await app.inject({ method: "POST", url: "/api/payloads", headers: { "content-type": "text/plain" }, payload: "escrow holds the coin / seven seconds pass / payment flows" });
    const hash = up.json().hash;
    const r1 = await w(alice, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", { agentId: 7, payloadHash: hash, note: "haiku" });
    assert.equal(r1.statusCode, 201, r1.body);
    subAlice = r1.json().id;
    assert.equal(r1.json().agentName, "Scribe");
    assert.deepEqual(r1.json().agent, { agentId: 7, name: "Scribe" });
    assert.deepEqual(r1.json().author, { address: alice.address, name: "Scribe", agentId: 7 });
    assert.equal(r1.json().myVote, undefined);
    assert.equal(r1.json().payloadURI, `fmx://payload/${hash}`);
    assert.equal(r1.json().votes, 0);
    assert.equal(r1.json().score, null);
    assert.equal(r1.json().rank, 1);
    const r2 = await w(bob, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", { url: "https://bob.example/haiku.txt" });
    assert.equal(r2.statusCode, 201);
    subBob = r2.json().id;
    assert.equal(r2.json().agent, null);
    assert.equal((await w(bob, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", { url: "https://bob.example/2.txt" })).statusCode, 409);
    assert.equal((await w(carol, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", { agentId: 7, url: "https://c.example" })).statusCode, 403);
    assert.equal((await w(carol, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", { payloadHash: "0x" + "ab".repeat(32) })).statusCode, 400);
    assert.equal((await w(carol, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", {})).statusCode, 400);
    assert.equal((await w(carol, "POST", `/api/arena/challenges/999/submissions`, "arena.submit", { url: "https://c.example" })).statusCode, 404);
  });

  await t.test("vote: weight 2 for Active-agent owners, 1 otherwise; no self-vote; re-vote updates; range check", async () => {
    // dave (Active agent 9) votes 10 on bob's; bob (plain) votes 10 on alice's → alice 10 pts, bob 20 pts
    const v1 = await w(dave, "POST", `/api/arena/submissions/${subBob}/vote`, "arena.vote", { score: 10 });
    assert.equal(v1.statusCode, 200, v1.body);
    assert.deepEqual(v1.json().yourVote, { score: 10, weight: 2, updated: false });
    assert.equal(v1.json().points, 20);
    assert.equal(v1.json().score, 10);
    const v2 = await w(bob, "POST", `/api/arena/submissions/${subAlice}/vote`, "arena.vote", { score: 10 });
    assert.deepEqual(v2.json().yourVote, { score: 10, weight: 1, updated: false });
    assert.equal(v2.json().points, 10);
    // carol owns a PAUSED agent → weight 1
    const v3 = await w(carol, "POST", `/api/arena/submissions/${subAlice}/vote`, "arena.vote", { score: 8 });
    assert.equal(v3.json().yourVote.weight, 1);
    assert.equal(v3.json().points, 18);
    assert.equal(v3.json().score, 9);
    // self vote
    const self = await w(alice, "POST", `/api/arena/submissions/${subAlice}/vote`, "arena.vote", { score: 10 });
    assert.equal(self.statusCode, 403);
    assert.equal(self.json().code, "self_vote");
    // re-vote updates (dave lowers bob to 5 → 10 pts)
    const v4 = await w(dave, "POST", `/api/arena/submissions/${subBob}/vote`, "arena.vote", { score: 5 });
    assert.deepEqual(v4.json().yourVote, { score: 5, weight: 2, updated: true });
    assert.equal(v4.json().points, 10);
    assert.equal(v4.json().votes, 1);
    assert.equal((await w(dave, "POST", `/api/arena/submissions/${subBob}/vote`, "arena.vote", { score: 11 })).statusCode, 400);
    assert.equal((await w(dave, "POST", `/api/arena/submissions/${subBob}/vote`, "arena.vote", { score: 0 })).statusCode, 400);
    assert.equal((await w(dave, "POST", `/api/arena/submissions/999/vote`, "arena.vote", { score: 5 })).statusCode, 404);
    const d = (await get(`/api/arena/challenges/${challengeId}`)).json;
    assert.deepEqual(d.submissions.map((s) => [s.id, s.rank, s.points]), [[subAlice, 1, 18], [subBob, 2, 10]]);
    assert.equal(d.voteCount, 3);
    assert.equal(d.winnerSubmissionId, null);
    // viewer: dave voted 5 on bob's, nothing on alice's
    const v = (await get(`/api/arena/challenges/${challengeId}?viewer=${dave.address.toLowerCase()}`)).json;
    assert.deepEqual(v.submissions.map((s) => [s.id, s.myVote]), [[subAlice, null], [subBob, 5]]);
    assert.deepEqual(v.myVotes, { [String(subBob)]: 5 });
    assert.equal(v.viewer, dave.address.toLowerCase());
    // award before endsAt → 409
    const early = await w(dave, "POST", `/api/arena/challenges/${challengeId}/award`, "arena.award", { agentId: 7 });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().code, "not_closed");
  });

  await t.test("freeze at endsAt: winner stored once, votes/submissions rejected, arena.close emitted", async () => {
    clock.advance(3600 * 1000 + 1000);
    const d = (await get(`/api/arena/challenges/${challengeId}`)).json;
    assert.equal(d.status, "closed");
    assert.equal(d.winnerSubmissionId, subAlice);
    assert.equal(d.winner.submitter.name, "Scribe");
    assert.equal(d.closedAt, d.endsAt);
    const late = await w(dave, "POST", `/api/arena/submissions/${subAlice}/vote`, "arena.vote", { score: 1 });
    assert.equal(late.statusCode, 409);
    assert.equal((await w(carol, "POST", `/api/arena/challenges/${challengeId}/submissions`, "arena.submit", { url: "https://c.example" })).statusCode, 409);
    assert.equal((await get("/api/arena/challenges?status=closed")).json.total, 1);
    assert.equal((await get("/api/arena/challenges?status=open")).json.total, 0);
    const closes = (await get("/api/activity?type=arena.close")).json.items;
    assert.equal(closes.length, 1);
    assert.equal(closes[0].data.winnerSubmissionId, subAlice);
    assert.equal(closes[0].data.winner.address, alice.address);
    assert.equal(closes[0].ts, d.endsAt);
    // reading again does not re-emit or change the winner
    await get(`/api/arena/challenges/${challengeId}`);
    assert.equal((await get("/api/activity?type=arena.close")).json.items.length, 1);
    // leaderboard counts the win
    const lb = (await get("/api/leaderboard")).json;
    assert.equal(lb.periods.all.find((e) => e.address === alice.address).arenaWins, 1);
  });

  await t.test("award: creator only, after endsAt; links agent + job; status awarded; activity arena.award", async () => {
    const notCreator = await w(alice, "POST", `/api/arena/challenges/${challengeId}/award`, "arena.award", { agentId: 7 });
    assert.equal(notCreator.statusCode, 403);
    assert.equal(notCreator.json().code, "not_creator");
    assert.equal((await w(dave, "POST", `/api/arena/challenges/${challengeId}/award`, "arena.award", { agentId: 999 })).statusCode, 404);
    assert.equal((await w(dave, "POST", `/api/arena/challenges/${challengeId}/award`, "arena.award", { agentId: "x" })).statusCode, 400);
    const res = await w(dave, "POST", `/api/arena/challenges/${challengeId}/award`, "arena.award", { agentId: 7, jobId: 77 });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, "awarded");
    assert.equal(res.json().awardedAgentId, 7);
    assert.equal(res.json().awardedAgentName, "Scribe");
    assert.equal(res.json().jobId, 77);
    assert.equal(res.json().jobStatus, null); // not indexed yet
    assert.equal(res.json().winnerSubmissionId, subAlice);
    assert.ok(res.json().awardedAt > 0);
    const d = (await get(`/api/arena/challenges/${challengeId}`)).json;
    assert.equal(d.status, "awarded");
    assert.equal((await get("/api/arena/challenges?status=closed")).json.items[0].status, "awarded");
    const ev = (await get("/api/activity?type=arena.award")).json.items;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor.name, "Judge");
    assert.equal(ev[0].data.agentName, "Scribe");
    assert.equal(ev[0].data.jobId, 77);
    // unsigned → 401
    assert.equal((await post(`/api/arena/challenges/${challengeId}/award`, { agentId: 7 })).statusCode, 401);
  });

  await t.test("a challenge with no votes closes without a winner", async () => {
    const now = clock.s();
    const c = await w(dave, "POST", "/api/arena/challenges", "arena.create", { title: "Empty", brief: "x", endsAt: now + 700 });
    assert.equal(c.statusCode, 201);
    await w(bob, "POST", `/api/arena/challenges/${c.json().id}/submissions`, "arena.submit", { url: "https://bob.example/x" });
    clock.advance(701_000);
    const d = (await get(`/api/arena/challenges/${c.json().id}`)).json;
    assert.equal(d.status, "closed");
    assert.equal(d.winnerSubmissionId, null);
    assert.equal(d.winner, null);
  });
});

test("ideas board: tag=idea with sort=top ranks by +1 upvotes", async (t) => {
  const { app, get, w } = await setup();
  t.after(() => app.close());
  const a = (await w(alice, "POST", "/api/forum/threads", "thread.create", { title: "Idea A", body: "a", tags: ["idea"] })).json();
  const b = (await w(bob, "POST", "/api/forum/threads", "thread.create", { title: "Idea B", body: "b", tags: ["idea"] })).json();
  const c = (await w(carol, "POST", "/api/forum/threads", "thread.create", { title: "Not an idea", body: "c" })).json();
  // B: 2 upvotes; A: 1 upvote + 2 plain replies (more posts, fewer upvotes); C: 3 plain replies
  await w(alice, "POST", `/api/forum/threads/${b.id}/posts`, "post.create", { body: "+1" });
  await w(carol, "POST", `/api/forum/threads/${b.id}/posts`, "post.create", { body: " +1 " });
  await w(bob, "POST", `/api/forum/threads/${a.id}/posts`, "post.create", { body: "+1" });
  await w(carol, "POST", `/api/forum/threads/${a.id}/posts`, "post.create", { body: "nice" });
  await w(dave, "POST", `/api/forum/threads/${a.id}/posts`, "post.create", { body: "also nice" });
  for (const wl of [alice, bob, dave]) await w(wl, "POST", `/api/forum/threads/${c.id}/posts`, "post.create", { body: "chat" });
  const ideas = (await get("/api/forum/threads?tag=idea&sort=top")).json;
  assert.equal(ideas.total, 2);
  assert.deepEqual(ideas.items.map((x) => [x.title, x.upvotes]), [["Idea B", 2], ["Idea A", 1]]);
  const top = (await get("/api/forum/threads?sort=top")).json;
  assert.deepEqual(top.items.map((x) => x.title), ["Idea B", "Idea A", "Not an idea"]);
  const active = (await get("/api/forum/threads")).json;
  assert.equal(active.items[0].title, "Not an idea"); // default order unchanged
  const posts = (await get("/api/activity?type=post.create")).json.items;
  assert.equal(posts.filter((e) => e.data.upvote).length, 3);
});
