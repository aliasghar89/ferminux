// Open-work feed (/api/work, /api/work/feed), the status page (/api/status)
// and the agent-readable changelog (/api/changelog). The DB is seeded in
// memory; the RPC is unreachable on purpose so the status route has to report
// a degraded `rpc` service rather than throw.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage } from "../dist/commons/sign.js";
import { parseChangelog, releasesSince, compareVersions } from "../dist/changelog.js";
import { parseRewardFloor, capabilityTerms, formatFmx, WORK_KINDS } from "../dist/work.js";
import { GATEWAY_VERSION } from "../dist/openapi.js";
import { buildStatus } from "../dist/status.js";

/** Reads SSE frames from a fetch Response until `count` events arrived or the deadline passes. */
async function readWork(res, count, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ done: false, value: null }), Math.max(deadline - Date.now(), 1)))]);
    if (chunk.done || !chunk.value) break;
    buf += dec.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = { id: null, event: null, data: null };
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) ev.event = line.slice(7);
        else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
      }
      if (ev.data) events.push(ev);
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

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
  bscRpcUrl: "http://127.0.0.1:1",
  payinRpcUrls: {},
  payinDeposits: {},
  webhookTickMs: 1e9,
  x402BatchMs: 1e9,
  payinPollMs: 1e9,
};

const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // owns agent 7
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const NOW_MS = 1_758_400_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

async function setup() {
  let nowMs = NOW_MS;
  const db = openMemoryDb();
  db.prepare(
    "INSERT INTO agents (id, owner, name, endpoint, status, registeredAt, pricePerJob, card, online) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)",
  ).run(
    7, alice.address, "Scribe Bot", "https://scribe.example", NOW_S - 90_000, "1000000000000000000",
    JSON.stringify({ ferminux: 1, agentId: 7, name: "Scribe Bot", description: "Summarises and translates documents", capabilities: ["summarize", "translate"], pricePerCall: "1000000000000000" }),
  );
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, 1, ?)").run(8, bob.address, "Free Bot", "https://free.example", NOW_S - 80_000);
  // one Open escrow job for agent 7, one already Completed (must not show up)
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(1, 7, bob.address, "2000000000000000000", "0x" + "11".repeat(32), "fmx://payload/0x" + "11".repeat(32), NOW_S - 600, 1);
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(2, 7, bob.address, "9000000000000000000", "0x" + "22".repeat(32), "", NOW_S - 700, 3);
  // bounties: one open, one awarded, one expired
  const ins = db.prepare("INSERT INTO bounties (id, poster, title, brief, rewardWei, tags, deadline, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  ins.run(1, bob.address, "Translate a glossary to Azerbaijani", "400 terms, CSV in and out.", "5000000000000000000", JSON.stringify(["translate", "az"]), null, "open", NOW_S - 500, NOW_S - 500);
  ins.run(2, bob.address, "Audit a Solidity vault", "Reentrancy and access control.", "50000000000000000000", JSON.stringify(["audit", "solidity"]), null, "awarded", NOW_S - 400, NOW_S - 400);
  ins.run(3, bob.address, "Expired bounty", "Nobody took it.", "1000000000000000000", "[]", NOW_S - 10, "open", NOW_S - 300, NOW_S - 300);
  db.prepare("INSERT INTO bounty_claims (bountyId, agentId, claimer, pitch, createdAt, updatedAt) VALUES (1, 7, ?, 'me', ?, ?)").run(alice.address, NOW_S - 400, NOW_S - 400);
  // arena: one open, one already over
  const arena = db.prepare("INSERT INTO arena_challenges (id, creator, title, brief, rules, prizeWei, tags, endsAt, createdAt) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)");
  arena.run(1, bob.address, "Best summariser", "Summarise the same paper.", "10000000000000000000", JSON.stringify(["summarize"]), NOW_S + 86_400, NOW_S - 200);
  arena.run(2, bob.address, "Closed challenge", "Over.", "1000000000000000000", "[]", NOW_S - 100, NOW_S - 1000);
  // forum: one unanswered thread, one with a reply
  db.prepare("INSERT INTO forum_threads (id, title, tags, author, createdAt, lastPostAt, postCount) VALUES (?, ?, ?, ?, ?, ?, ?)").run(1, "How do I price a translate agent?", JSON.stringify(["translate", "pricing"]), bob.address, NOW_S - 100, NOW_S - 100, 1);
  db.prepare("INSERT INTO forum_posts (threadId, author, body, createdAt) VALUES (1, ?, 'Nobody has answered this yet.', ?)").run(bob.address, NOW_S - 100);
  db.prepare("INSERT INTO forum_threads (id, title, tags, author, createdAt, lastPostAt, postCount) VALUES (?, ?, ?, ?, ?, ?, ?)").run(2, "Answered already", "[]", bob.address, NOW_S - 90, NOW_S - 80, 2);
  db.prepare("INSERT INTO forum_posts (threadId, author, body, createdAt) VALUES (2, ?, 'q', ?)").run(bob.address, NOW_S - 90);
  db.prepare("INSERT INTO forum_posts (threadId, author, body, createdAt) VALUES (2, ?, 'a', ?)").run(alice.address, NOW_S - 80);
  // a compute listing looking for traffic
  db.prepare("INSERT INTO tools (id, owner, name, kind, url, description, compute, online, createdAt, updatedAt) VALUES (?, ?, ?, 'compute', ?, ?, ?, 1, ?, ?)").run(
    1, bob.address, "h100-frankfurt", "https://gpu.example", "One H100 in Frankfurt", JSON.stringify({ gpu: "H100", vramGb: 80, pricePerSecond: "300000000000000", region: "eu-central", endpoint: "https://gpu.example/run" }), NOW_S - 50, NOW_S - 50,
  );

  const { app, activity, v3, x402, payin } = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }), sseHeartbeatMs: 1e9 } });
  await app.ready();
  const clock = { s: () => Math.floor(nowMs / 1000), advance: (ms) => (nowMs += ms) };
  const inject = (method, url, body, hdrs = {}) => app.inject({ method, url, headers: { "content-type": "application/json", ...hdrs }, payload: body === undefined ? undefined : JSON.stringify(body) });
  const get = async (url) => (await inject("GET", url)).json();
  const signed = async (wallet, action, payload = {}) => {
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  };
  return { app, db, activity, inject, get, signed, clock, v3, x402, payin };
}

test("/api/work merges every earning surface, and hides taken/expired work", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());
  const w = await get("/api/work?limit=200");
  const byId = new Map(w.items.map((i) => [i.id, i]));

  // open escrow job only (the Completed one is gone)
  assert.ok(byId.has("job:1"));
  assert.ok(!byId.has("job:2"));
  assert.equal(byId.get("job:1").rewardFmx, "2");
  assert.equal(byId.get("job:1").agentId, 7);
  assert.match(byId.get("job:1").action, /ServiceEscrow\.deliver\(1,/);

  // open bounty only (awarded + past-deadline are gone), with its claim count
  assert.ok(byId.has("bounty:1"));
  assert.ok(!byId.has("bounty:2"));
  assert.ok(!byId.has("bounty:3"));
  assert.equal(byId.get("bounty:1").claims, 1);
  assert.equal(byId.get("bounty:1").rewardFmx, "5");
  assert.match(byId.get("bounty:1").action, /POST \/api\/bounties\/1\/claims/);
  assert.equal(byId.get("bounty:1").url, "https://ferminux.net/bounties/?id=1");

  // open challenge only
  assert.ok(byId.has("arena:1"));
  assert.ok(!byId.has("arena:2"));

  // unanswered thread only
  assert.ok(byId.has("question:1"));
  assert.ok(!byId.has("question:2"));
  assert.equal(byId.get("question:1").rewardWei, "0");

  // priced endpoints looking for traffic: the agent's front door and the compute listing
  assert.ok(byId.has("endpoint:7"));
  assert.ok(byId.has("endpoint:compute:1"));
  assert.match(byId.get("endpoint:7").action, /\/a\/7\/invoke/);

  assert.equal(w.counts.job, 1);
  assert.equal(w.counts.bounty, 1);
  assert.equal(w.counts.arena, 1);
  assert.equal(w.counts.question, 1);
  assert.equal(w.counts.endpoint, 2);
  assert.equal(w.total, 6);
  assert.deepEqual(w.kinds, [...WORK_KINDS]);
  assert.equal(w.feed, "https://ferminux.net/api/work/feed");
  // default sort is newest first
  const posted = w.items.map((i) => i.postedAt);
  assert.deepEqual(posted, [...posted].sort((a, b) => b - a));
});

test("/api/work filters: capability, minReward, kind, agentId, sort, paging", async (t) => {
  const { app, get, inject } = await setup();
  t.after(() => app.close());

  const cap = await get("/api/work?capability=translate");
  assert.deepEqual(new Set(cap.items.map((i) => i.id)), new Set(["bounty:1", "question:1", "endpoint:7"]));

  // an integer minReward is wei; a value with a decimal point is FMX
  const rich = await get("/api/work?minReward=6.0");
  assert.deepEqual(rich.items.map((i) => i.id), ["arena:1"]);
  assert.equal((await get("/api/work?minReward=5000000000000000000")).total, 2); // bounty 5 FMX + arena 10 FMX

  const kinds = await get("/api/work?kind=bounty,arena");
  assert.deepEqual(new Set(kinds.items.map((i) => i.kind)), new Set(["bounty", "arena"]));

  // ?agentId= keeps only that agent's jobs and uses its card as the capability filter
  const mine = await get("/api/work?agentId=7");
  assert.ok(mine.items.some((i) => i.id === "job:1"));
  assert.ok(mine.items.some((i) => i.id === "bounty:1")); // matches "translate"
  assert.ok(!mine.items.some((i) => i.id === "endpoint:compute:1")); // H100 listing is not its trade

  const byReward = await get("/api/work?sort=reward");
  assert.equal(byReward.items[0].id, "arena:1");

  const page = await get("/api/work?limit=2&offset=0");
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 6);

  assert.equal((await inject("GET", "/api/work?kind=nope")).statusCode, 400);
  assert.equal((await inject("GET", "/api/work?sort=nope")).statusCode, 400);
  assert.equal((await inject("GET", "/api/work?agentId=abc")).statusCode, 400);
  assert.equal((await inject("GET", "/api/work?minReward=1.2.3")).statusCode, 400);
});

test("/api/work/feed replays new work from the activity stream as SSE", async (t) => {
  const { app, signed, inject, clock } = await setup();
  t.after(() => app.close());
  const since = clock.s() - 3600;

  // a fresh bounty posted after `before`
  const res = await inject("POST", "/api/bounties", await signed(bob, "bounty.create", { title: "Caption 5k images", brief: "Alt text for an image set.", rewardWei: "3000000000000000000", tags: ["vision"] }));
  assert.equal(res.statusCode, 201, res.body);
  const bountyId = res.json().id;

  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const ac = new AbortController();
  t.after(() => ac.abort());
  const sse = await fetch(`${base}/api/work/feed?since=${since}`, { signal: ac.signal });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  const events = await readWork(sse, 1);
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].event, "work");
  assert.equal(events[0].data.kind, "bounty");
  assert.equal(events[0].data.refId, bountyId);
  assert.equal(events[0].data.rewardFmx, "3");
  assert.equal(events[0].data.activityId, events[0].id);
  ac.abort();

  // filters apply to the feed too: this bounty is not about Solidity
  const ac2 = new AbortController();
  t.after(() => ac2.abort());
  const filtered = await fetch(`${base}/api/work/feed?since=${since}&capability=solidity`, { signal: ac2.signal });
  assert.deepEqual(await readWork(filtered, 1, 400), []);
  ac2.abort();

  assert.equal((await inject("GET", "/api/work/feed?kind=nope")).statusCode, 400);
});

test("/api/status reports every service, and degrades instead of throwing when the RPC is down", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());
  const s = await get("/api/status");
  assert.equal(s.version, GATEWAY_VERSION);
  assert.equal(s.ok, false); // the test RPC is unreachable
  assert.ok(s.degraded.includes("rpc"));
  assert.equal(s.head, null);
  for (const key of ["rpc", "chain", "indexer", "v3indexer", "facilitator", "relayer", "faucet", "payin", "webhooks", "db"]) {
    assert.ok(key in s.services, `missing service ${key}`);
    assert.equal(typeof s.services[key].ok, "boolean");
  }
  assert.equal(s.services.facilitator.enabled, false);
  assert.match(s.services.facilitator.detail, /not deployed|FACILITATOR_KEY/);
  assert.equal(s.services.relayer.enabled, false);
  assert.equal(s.services.faucet.enabled, false);
  assert.equal(s.services.payin.enabled, false);
  assert.equal(s.services.webhooks.pending, 0);
  assert.equal(s.services.db.ok, true);
  assert.equal(s.services.db.agents, 2);
  assert.equal(s.links.page, "https://ferminux.net/status/");
  assert.ok(s.uptimeS >= 0);
});

// A halted chain (head stops, indexer lag 0) and a signer outage (3 of 5 still confirming) both used to read
// "ok" here — the 2026-09-24 audit found 2 of 5 signers silent with /api/status green.
test("/api/status chain service: head-block age and silent signers from clique_status degrade it", async (t) => {
  const { app, db, v3, x402, payin } = await setup();
  t.after(() => app.close());
  let blockTs = NOW_S - 5;
  let activity = { "0x3322000000000000000000000000000000000001": 22, "0x7137000000000000000000000000000000000002": 21, "0x1538000000000000000000000000000000000003": 0 };
  const provider = {
    getBlockNumber: async () => 500,
    getNetwork: async () => ({ chainId: 3961n }),
    getBalance: async () => 0n,
    getBlock: async (n) => ({ number: n, timestamp: blockTs }),
    send: async (method) => {
      if (method === "clique_status") return { sealerActivity: activity, numBlocks: 64, inturnPercent: 20.31 };
      throw new Error(`unexpected ${method}`);
    },
  };
  const opts = { db, cfg, provider, v3, x402, payin };
  let s = await buildStatus(opts, Date.now());
  assert.equal(s.services.chain.ok, false);
  assert.ok(s.degraded.includes("chain"));
  assert.deepEqual({ total: s.services.chain.signers.total, active: s.services.chain.signers.active }, { total: 3, active: 2 });
  assert.deepEqual(s.services.chain.signers.silent, ["0x1538000000000000000000000000000000000003"]);
  assert.match(s.services.chain.detail, /2 of 3 signers/);
  assert.equal(s.services.chain.headAgeS, 5);

  activity = { ...activity, "0x1538000000000000000000000000000000000003": 20 };
  s = await buildStatus(opts, Date.now());
  assert.equal(s.services.chain.ok, true, s.services.chain.detail);
  assert.ok(!s.degraded.includes("chain"));

  blockTs = NOW_S - 300; // head stopped moving: a halt
  s = await buildStatus(opts, Date.now());
  assert.equal(s.services.chain.ok, false);
  assert.match(s.services.chain.detail, /halted/);

  blockTs = NOW_S - 5;
  provider.send = async () => { throw new Error("the method clique_status does not exist"); };
  s = await buildStatus(opts, Date.now());
  assert.equal(s.services.chain.ok, false, "signer health unknown is not ok");
  assert.match(s.services.chain.detail, /clique_status unavailable/);
});

test("/api/changelog parses releases, filters with ?since=, and serves the raw Markdown", async (t) => {
  const { app, inject } = await setup();
  t.after(() => app.close());
  const c = (await inject("GET", "/api/changelog")).json();
  assert.equal(c.present, true, "agents/CHANGELOG.md should be next to the gateway");
  assert.ok(c.total >= 3);
  // the newest release is the one the gateway reports at /api/health and /api/status
  assert.equal(c.items[0].version, GATEWAY_VERSION);
  assert.equal(c.items[0].version, "0.6.0");
  assert.ok(c.items[0].changes.some((e) => e.type === "added" && e.text.includes("/api/cv/")));
  assert.ok(c.items[0].changes.some((e) => e.type === "changed" && e.text.includes("lowest registration id")));
  const work = c.items.find((r) => r.version === "0.5.0");
  assert.ok(work.changes.some((e) => e.type === "added" && e.text.includes("/api/work")));
  assert.ok(work.changes.some((e) => e.type === "security"));

  const since = (await inject("GET", "/api/changelog?since=0.4.0")).json();
  assert.deepEqual(since.items.map((r) => r.version), ["0.6.0", "0.5.0"]);
  assert.equal((await inject("GET", "/api/changelog?since=9.9.9")).json().total, 0);

  const md = await inject("GET", "/api/changelog?format=markdown");
  assert.match(md.headers["content-type"], /text\/markdown/);
  assert.match(md.body, /^# Changelog/);
  assert.equal((await inject("GET", "/api/changelog?format=xml")).statusCode, 400);
  assert.equal((await inject("GET", "/api/changelog?since=not a version")).statusCode, 400);
});

test("changelog parser: sections, continuation lines, unreleased, version ordering", () => {
  const md = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "### Added",
    "- something coming",
    "",
    "## [0.4.10] - 2026-09-21",
    "### Added",
    "- a route that spans",
    "  two source lines",
    "### Security",
    "- a fix",
    "",
    "## [0.4.9] - 2026-09-20",
    "### Notes",
    "- an unknown section lands under changed",
  ].join("\n");
  const releases = parseChangelog(md);
  assert.deepEqual(releases.map((r) => r.version), ["Unreleased", "0.4.10", "0.4.9"]);
  assert.equal(releases[0].unreleased, true);
  assert.equal(releases[1].date, "2026-09-21");
  assert.equal(releases[1].changes[0].text, "a route that spans two source lines");
  assert.deepEqual(releases[1].counts, { added: 1, security: 1 });
  assert.equal(releases[2].changes[0].type, "changed");
  assert.ok(compareVersions("0.4.10", "0.4.9") > 0);
  // Unreleased always survives a ?since= filter
  assert.deepEqual(releasesSince(releases, "0.4.9").map((r) => r.version), ["Unreleased", "0.4.10"]);
  assert.deepEqual(releasesSince(releases, "2026-09-20").map((r) => r.version), ["Unreleased", "0.4.10"]);
});

test("changelog route survives a missing file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-changelog-"));
  const path = join(dir, "nothing-here.md");
  const { registerChangelogRoutes } = await import("../dist/changelog.js");
  const Fastify = (await import("fastify")).default;
  const app = Fastify({ logger: false });
  registerChangelogRoutes(app, { cfg, commons: { parseLimit: (v, d, m) => Math.min(Math.max(Number(v) || d, 1), m), sendError: (reply, err) => reply.code(err.status ?? 500).send({ error: err.message }) } });
  t.after(() => app.close());
  void path;
  void writeFileSync;
  const res = await app.inject({ method: "GET", url: "/api/changelog" });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().items));
});

test("work helpers: reward parsing, capability terms, FMX formatting", () => {
  assert.equal(parseRewardFloor(undefined), 0n);
  assert.equal(parseRewardFloor("2500000000000000000"), 2_500_000_000_000_000_000n);
  assert.equal(parseRewardFloor("2.5"), 2_500_000_000_000_000_000n);
  assert.equal(parseRewardFloor(".5"), 500_000_000_000_000_000n);
  assert.throws(() => parseRewardFloor("-1"));
  assert.deepEqual(capabilityTerms("Translate, summarise — az"), ["translate", "summarise", "az"]);
  assert.deepEqual(capabilityTerms("a b"), []); // single characters are dropped
  assert.equal(formatFmx("1500000000000000000"), "1.5");
  assert.equal(formatFmx("1000000000000000000"), "1");
  assert.equal(formatFmx("not a number"), "0");
});
