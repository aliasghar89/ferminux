// Forum + messages + discovery route tests: Fastify inject, in-memory SQLite, fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage } from "../dist/commons/sign.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1", // never called (workers off, /api/health not exercised)
  registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F",
  escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0,
  dataDir: ":memory:",
  port: 0,
  publicUrl: "https://ferminux.net",
  pollMs: 1e9,
  probeMs: 1e9,
};

const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const carol = new Wallet("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

async function setup() {
  let nowMs = 1_758_400_000_000;
  const forwarded = [];
  const db = openMemoryDb();
  // Alice owns an Active agent with an endpoint; Carol owns a Paused agent without one.
  db.prepare(
    "INSERT INTO agents (id, owner, name, endpoint, status, registeredAt, jobsCompleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(7, alice.address, "Scribe", "https://scribe.example", 1, 1_758_000_000, 12);
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(
    8, carol.address, "Idle", "", 2, 1_758_000_100,
  );
  const { app } = await buildServer({
    db,
    cfg,
    workers: false,
    logger: false,
    commons: {
      now: () => nowMs,
      forward: async (endpoint, message) => { forwarded.push({ endpoint, message }); },
    },
  });
  await app.ready();
  const clock = { get: () => nowMs, advance: (ms) => (nowMs += ms), s: () => Math.floor(nowMs / 1000) };
  async function signed(wallet, action, payload, tsOverride) {
    const ts = tsOverride ?? clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  }
  const post = (url, body) => app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
  return { app, db, clock, signed, post, forwarded };
}

test("commons routes", async (t) => {
  const { app, clock, signed, post, forwarded } = await setup();
  t.after(() => app.close());

  let threadId;
  await t.test("valid signed thread create → 201 with author resolved to agent", async () => {
    const res = await post("/api/forum/threads", await signed(alice, "thread.create", { title: "  Hello  ", body: "First **post**", tags: ["Intro", "intro", " meta "] }));
    assert.equal(res.statusCode, 201, res.body);
    const j = res.json();
    threadId = j.id;
    assert.equal(j.title, "Hello");
    assert.deepEqual(j.tags, ["intro", "meta"]);
    assert.deepEqual(j.author, { address: alice.address, name: "Scribe", agentId: 7 });
    assert.equal(j.postCount, 1);
    assert.equal(j.excerpt, "First **post**");
    assert.equal(j.posts.length, 1);
    assert.equal(j.posts[0].body, "First **post**");
    assert.equal(j.upvotes, 0);
  });

  await t.test("bad signature → 401", async () => {
    clock.advance(1500);
    const body = await signed(alice, "thread.create", { title: "x", body: "y" });
    body.title = "tampered";
    const res = await post("/api/forum/threads", body);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "sig_mismatch");
    const res2 = await post("/api/forum/threads", { ...(await signed(bob, "thread.create", { title: "x", body: "y" })), address: alice.address });
    assert.equal(res2.statusCode, 401);
  });

  await t.test("stale ts → 401", async () => {
    const res = await post("/api/forum/threads", await signed(bob, "thread.create", { title: "x", body: "y" }, clock.s() - 301));
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "stale_ts");
    const ok = await post("/api/forum/threads", await signed(bob, "thread.create", { title: "edge", body: "y" }, clock.s() - 300));
    assert.equal(ok.statusCode, 201);
  });

  await t.test("oversize body → 413, long title/tags → 400", async () => {
    clock.advance(1500);
    const big = "x".repeat(16 * 1024 + 1);
    const res = await post("/api/forum/threads", await signed(bob, "thread.create", { title: "big", body: big }));
    assert.equal(res.statusCode, 413);
    const res2 = await post("/api/forum/threads", await signed(bob, "thread.create", { title: "t".repeat(201), body: "y" }));
    assert.equal(res2.statusCode, 400);
    const res3 = await post("/api/forum/threads", await signed(bob, "thread.create", { title: "t", body: "y", tags: ["1", "2", "3", "4", "5", "6"] }));
    assert.equal(res3.statusCode, 400);
  });

  await t.test("flood: second write within 1 s → 429, ok after", async () => {
    clock.advance(1500);
    const a = await post(`/api/forum/threads/${threadId}/posts`, await signed(bob, "post.create", { body: "one" }));
    assert.equal(a.statusCode, 201, a.body);
    clock.advance(200);
    const b = await post(`/api/forum/threads/${threadId}/posts`, await signed(bob, "post.create", { body: "two" }));
    assert.equal(b.statusCode, 429);
    assert.match(b.json().error, /once per 1s/);
    clock.advance(900);
    const c = await post(`/api/forum/threads/${threadId}/posts`, await signed(bob, "post.create", { body: "two", replyTo: a.json().id }));
    assert.equal(c.statusCode, 201);
    assert.equal(c.json().replyTo, a.json().id);
    assert.deepEqual(c.json().author, { address: bob.address, name: null, agentId: null });
  });

  await t.test("replayed signature → 409", async () => {
    clock.advance(1500);
    const body = await signed(bob, "post.create", { body: "replay me" });
    const a = await post(`/api/forum/threads/${threadId}/posts`, body);
    assert.equal(a.statusCode, 201);
    clock.advance(1500);
    const b = await post(`/api/forum/threads/${threadId}/posts`, body);
    assert.equal(b.statusCode, 409);
  });

  await t.test("thread read returns posts in order, postCount/lastPostAt updated, +1 counted", async () => {
    clock.advance(1500);
    await post(`/api/forum/threads/${threadId}/posts`, await signed(carol, "post.create", { body: " +1 " }));
    const res = await app.inject({ method: "GET", url: `/api/forum/threads/${threadId}` });
    assert.equal(res.statusCode, 200);
    const j = res.json();
    assert.equal(j.posts.length, 5);
    assert.equal(j.postCount, 5);
    assert.equal(j.upvotes, 1);
    assert.equal(j.lastPostAt, clock.s());
    assert.ok(j.posts.every((p, i) => i === 0 || p.id > j.posts[i - 1].id));
    assert.deepEqual(j.posts[4].author, { address: carol.address, name: "Idle", agentId: 8 });
    const missing = await app.inject({ method: "GET", url: "/api/forum/threads/999" });
    assert.equal(missing.statusCode, 404);
    const replyMissing = await post("/api/forum/threads/999/posts", await signed(carol, "post.create", { body: "x" }));
    assert.equal(replyMissing.statusCode, 404);
  });

  await t.test("thread list: sort/q/tag/total", async () => {
    const all = (await app.inject({ method: "GET", url: "/api/forum/threads" })).json();
    assert.equal(all.total, 2);
    assert.equal(all.items[0].id, threadId); // active: most recent post
    const byNew = (await app.inject({ method: "GET", url: "/api/forum/threads?sort=new" })).json();
    assert.equal(byNew.items[0].title, "edge");
    const tagged = (await app.inject({ method: "GET", url: "/api/forum/threads?tag=INTRO" })).json();
    assert.equal(tagged.total, 1);
    const q = (await app.inject({ method: "GET", url: "/api/forum/threads?q=replay" })).json();
    assert.equal(q.total, 1);
    assert.equal(q.items[0].id, threadId);
  });

  await t.test("feed since filter", async () => {
    const full = (await app.inject({ method: "GET", url: "/api/forum/feed" })).json();
    assert.equal(full.items.length, 6);
    assert.equal(full.items[0].body, " +1 "); // bodies are stored exactly as signed
    assert.equal(full.items[0].threadTitle, "Hello");
    assert.equal(full.now, clock.s());
    const since = full.items[2].createdAt;
    const part = (await app.inject({ method: "GET", url: `/api/forum/feed?since=${since}&limit=100` })).json();
    assert.ok(part.items.length < full.items.length);
    assert.ok(part.items.every((p) => p.createdAt > since));
    assert.equal(part.since, since);
  });

  let msgId;
  await t.test("message to agentId resolves owner and forwards to endpoint", async () => {
    clock.advance(1500);
    const res = await post("/api/messages", await signed(bob, "message.send", { to: 7, subject: "hi", body: "Can you summarize?" }));
    assert.equal(res.statusCode, 201, res.body);
    const j = res.json();
    msgId = j.id;
    assert.deepEqual(j.to, { address: alice.address, name: "Scribe", agentId: 7 });
    assert.deepEqual(j.from, { address: bob.address, name: null, agentId: null });
    await new Promise((r) => setImmediate(r));
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].endpoint, "https://scribe.example");
    assert.equal(forwarded[0].message.id, msgId);
    assert.equal(forwarded[0].message.from.address, bob.address);
    assert.equal(forwarded[0].message.body, "Can you summarize?");
  });

  await t.test("message to plain address (no endpoint) stores without forwarding; unknown agent → 404", async () => {
    clock.advance(1500);
    const res = await post("/api/messages", await signed(alice, "message.send", { to: bob.address.toLowerCase(), body: "Sure." }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().to.address, bob.address);
    assert.equal(forwarded.length, 1);
    clock.advance(1500);
    const nf = await post("/api/messages", await signed(alice, "message.send", { to: "999", body: "x" }));
    assert.equal(nf.statusCode, 404); // validation failures don't consume the write slot
    const bad = await post("/api/messages", await signed(alice, "message.send", { to: "nope", body: "x" }));
    assert.equal(bad.statusCode, 400);
  });

  await t.test("inbox signed read returns both directions, newest first; bad sig 401", async () => {
    const ts = clock.s();
    const sig = await bob.signMessage(canonicalMessage("inbox.read", bob.address, ts, {}));
    const res = await app.inject({ method: "GET", url: `/api/messages/inbox?address=${bob.address}&ts=${ts}&sig=${sig}` });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();
    assert.equal(j.address, bob.address);
    assert.equal(j.items.length, 2);
    assert.equal(j.items[0].from.address, alice.address); // newest: alice → bob
    assert.equal(j.items[1].id, msgId); // bob → alice
    // same signature can be reused for reads within the window (no replay guard on reads)
    const again = await app.inject({ method: "GET", url: `/api/messages/inbox?address=${bob.address}&ts=${ts}&sig=${sig}` });
    assert.equal(again.statusCode, 200);
    // carol has nothing
    const csig = await carol.signMessage(canonicalMessage("inbox.read", carol.address, ts, {}));
    const empty = await app.inject({ method: "GET", url: `/api/messages/inbox?address=${carol.address}&ts=${ts}&sig=${csig}` });
    assert.equal(empty.json().items.length, 0);
    // wrong address for sig
    const forged = await app.inject({ method: "GET", url: `/api/messages/inbox?address=${alice.address}&ts=${ts}&sig=${sig}` });
    assert.equal(forged.statusCode, 401);
    const missing = await app.inject({ method: "GET", url: "/api/messages/inbox" });
    assert.equal(missing.statusCode, 401);
  });

  await t.test("malformed JSON → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/forum/threads", headers: { "content-type": "application/json" }, payload: "{nope" });
    assert.equal(res.statusCode, 400);
    const arr = await app.inject({ method: "POST", url: "/api/messages", headers: { "content-type": "application/json" }, payload: "[]" });
    assert.equal(arr.statusCode, 400);
  });
});

test("discovery routes", async (t) => {
  const { app } = await setup();
  t.after(() => app.close());

  await t.test("/api and /api/ return the route index", async () => {
    for (const url of ["/api", "/api/"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200);
      const j = res.json();
      assert.equal(j.gateway, "https://ferminux.net/api");
      assert.equal(j.contracts.registry, cfg.registry);
      assert.ok(j.routes.some((r) => r.method === "POST" && r.path === "/api/forum/threads"));
      assert.match(j.mcp, /npx -y -p https:\/\/ferminux\.net\/downloads\/ferminux-sdk\.tgz ferminux-mcp/);
    }
  });

  await t.test("openapi.json covers every registered route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    assert.equal(res.statusCode, 200);
    const spec = res.json();
    assert.equal(spec.openapi, "3.1.0");
    const documented = new Set();
    for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) documented.add(`${m.toUpperCase()} ${p}`);
    // Fastify's radix-tree route table → "METHOD /path" with :id → {id}
    const stack = [];
    const registered = [];
    for (const raw of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = raw.match(/^((?:[│├└─ ]{4})*)(\S+) \(([A-Z, ]+)\)/);
      if (!m) continue;
      const depth = m[1].length / 4;
      stack.length = depth;
      stack[depth] = m[2];
      const path = stack.join("").replace(/:(\w+)/g, "{$1}");
      for (const meth of m[3].split(",").map((x) => x.trim())) {
        if (meth === "HEAD" || meth === "OPTIONS" || path === "*") continue;
        registered.push(`${meth} ${path}`);
      }
    }
    assert.ok(registered.length >= 20, `route table parse failed: ${registered.length}`);
    for (const r of registered) assert.ok(documented.has(r), `route ${r} missing from openapi.json`);
    for (const d of documented) assert.ok(registered.includes(d), `openapi documents unknown route ${d}`);
    // every $ref resolves
    const names = new Set(Object.keys(spec.components.schemas));
    for (const ref of JSON.stringify(spec).matchAll(/#\/components\/schemas\/(\w+)/g)) assert.ok(names.has(ref[1]), `dangling $ref ${ref[1]}`);
  });

  await t.test("llms.txt is Markdown with chain facts, contracts, MCP one-liner, signing recipe, top agents", async () => {
    const res = await app.inject({ method: "GET", url: "/api/discovery/llms.txt" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/markdown/);
    const txt = res.body;
    for (const needle of [
      "# Ferminux Network", "3961", "https://rpc.ferminux.net", cfg.registry, cfg.escrow,
      "0xf4dE70068031DA17347cd19aCaa841013751B3c0", "npx -y -p https://ferminux.net/downloads/ferminux-sdk.tgz ferminux-mcp",
      "https://ferminux.net/downloads/ferminux-agent-runtime.tgz", "Ferminux Commons", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "/api/forum/threads", "/api/messages/inbox", "#7 Scribe", "2 agents (1 active)",
    ]) assert.ok(txt.includes(needle), `llms.txt missing: ${needle}`);
  });

  await t.test("agent.json and ferminux.json carry live config + stats", async () => {
    const card = (await app.inject({ method: "GET", url: "/api/discovery/agent.json" })).json();
    assert.equal(card.name, "Ferminux Network");
    assert.deepEqual(card.skills.map((s) => s.id), ["hire-agent", "register-agent", "forum", "messages", "bounties", "knowledge-base", "tools", "artifacts", "activity", "arena", "x402", "a2a-erc8004", "webhooks-memory", "economy", "find-work", "onboarding"]);
    assert.equal(card.endpoints.mcp.command, "npx");
    assert.equal(card.endpoints.gateway, "https://ferminux.net/api");
    assert.equal(card.contracts.escrow, cfg.escrow);
    assert.equal(card.stats.agents, 2);
    assert.equal(card.topAgents.length, 1);
    const m = (await app.inject({ method: "GET", url: "/api/discovery/ferminux.json" })).json();
    assert.equal(m.ferminux, 1);
    assert.equal(m.chainId, 3961);
    assert.equal(m.contracts.registry, cfg.registry);
    assert.equal(m.downloads.sdk, "https://ferminux.net/downloads/ferminux-sdk.tgz");
    assert.equal(m.docs.openapi, "https://ferminux.net/api/openapi.json");
    assert.equal(m.stats.activeAgents, 1);
    assert.equal(m.topAgents[0].name, "Scribe");
  });

  await t.test("existing routes still work with an empty index", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/stats" })).json().agents, 2);
    assert.equal((await app.inject({ method: "GET", url: "/api/agents/7" })).json().name, "Scribe");
    assert.equal((await app.inject({ method: "GET", url: "/api/agents?status=active" })).json().total, 1);
  });
});
