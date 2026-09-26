// 2026-09-24 audit hardening: default per-IP rate limit, the shared per-IP Commons write budget, payload
// quotas + retention, agents.db snapshots, and the alert state machine.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildServer } from "../dist/server.js";
import { openDb, openMemoryDb } from "../dist/db.js";
import { prunePayloads, storePayloadDetailed } from "../dist/payloads.js";
import { backupOnce } from "../dist/backup.js";
import { AlertState, describeEvent } from "../dist/alerts.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1", payinRpcUrls: {}, payinDeposits: {}, webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9,
};

async function setup() {
  const db = openMemoryDb();
  const { app } = await buildServer({ db, cfg, workers: false, logger: false, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  return { app, db };
}

test("every route has a default per-IP limit; routes with their own keep theirs", async (t) => {
  const { app } = await setup();
  t.after(() => app.close());
  const stats = await app.inject({ method: "GET", url: "/api/stats" });
  assert.equal(stats.headers["x-ratelimit-limit"], "300");
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.headers["x-ratelimit-limit"], "300");
  const status = await app.inject({ method: "GET", url: "/api/status" });
  assert.equal(status.headers["x-ratelimit-limit"], "120");
});

test("Commons writes share one per-IP budget across routes (a fresh key per write no longer bypasses it)", async (t) => {
  const { app } = await setup();
  t.after(() => app.close());
  const urls = ["/api/forum/threads", "/api/kb/some-page", "/api/bounties", "/api/messages", "/api/tools", "/api/artifacts"];
  const codes = [];
  for (let i = 0; i < 31; i++) {
    const url = urls[i % urls.length];
    const res = await app.inject({ method: url.startsWith("/api/kb") ? "PUT" : "POST", url, headers: { "content-type": "application/json" }, payload: "{}" });
    codes.push(res.statusCode);
  }
  assert.ok(codes.slice(0, 30).every((c) => c !== 429), codes.join(","));
  assert.equal(codes[30], 429);
  // reads are not counted
  assert.equal((await app.inject({ method: "GET", url: "/api/forum/threads" })).statusCode, 200);
});

test("payloads: per-IP daily byte budget (duplicates are free) and a global cap", async (t) => {
  process.env.PAYLOADS_MAX_BYTES_PER_IP_PER_DAY = "600";
  process.env.PAYLOADS_MAX_TOTAL_BYTES = "1000";
  const { app } = await setup();
  delete process.env.PAYLOADS_MAX_BYTES_PER_IP_PER_DAY;
  delete process.env.PAYLOADS_MAX_TOTAL_BYTES;
  t.after(() => app.close());
  const up = (body, ip = "203.0.113.1") => app.inject({ method: "POST", url: "/api/payloads", headers: { "content-type": "text/plain", "x-forwarded-for": ip }, payload: body });
  const a = await up("a".repeat(500));
  assert.equal(a.statusCode, 200, a.body);
  assert.deepEqual(Object.keys(a.json()).sort(), ["hash", "size", "uri"], "response shape unchanged");
  assert.equal((await up("a".repeat(500))).statusCode, 200, "the same bytes again cost nothing");
  const over = await up("b".repeat(200));
  assert.equal(over.statusCode, 429);
  assert.match(over.json().error, /budget/);
  const other = await up("c".repeat(450), "203.0.113.2");
  assert.equal(other.statusCode, 200);
  const full = await up("d".repeat(100), "203.0.113.3");
  assert.equal(full.statusCode, 507, "global cap: 950 stored + 100 > 1000");
});

test("prunePayloads deletes only old payloads nothing references", () => {
  const db = openMemoryDb();
  const old = Date.now() - 40 * 86_400_000;
  const mk = (s) => {
    const r = storePayloadDetailed(db, Buffer.from(s), "text/plain");
    db.prepare("UPDATE payloads SET createdAt = ? WHERE hash = ?").run(old, r.hash);
    return r.hash;
  };
  const jobInput = mk("job input");
  const artifact = mk("artifact bytes");
  const orphan = mk("nobody refers to me");
  const fresh = storePayloadDetailed(db, Buffer.from("new and unreferenced"), "text/plain").hash;
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, createdAt, status) VALUES (1, 7, '0x0', '1', ?, ?, 1, 1)").run(jobInput, `fmx://payload/${jobInput}`);
  db.prepare("INSERT INTO artifacts (owner, name, description, license, kind, payloadHash, url, tags, stars, createdAt) VALUES ('0x0', 'a', '', 'MIT', 'code', ?, '', '[]', 0, 1)").run(artifact.toUpperCase().replace("0X", "0x"));
  const r = prunePayloads(db, { ttlDays: 30 });
  assert.equal(r.deleted, 1);
  const left = db.prepare("SELECT hash FROM payloads").all().map((x) => x.hash).sort();
  assert.deepEqual(left, [jobInput, artifact, fresh].sort());
  assert.ok(!left.includes(orphan));
});

test("backupOnce writes a verified snapshot + agents-latest.db and keeps N dated files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, "data"));
  t.after(() => db.close());
  db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'kept')").run();
  const out = join(dir, "backups");
  const r1 = await backupOnce(db, out, 2, new Date("2026-09-20T03:00:00Z"));
  assert.ok(r1.bytes > 0);
  await backupOnce(db, out, 2, new Date("2026-09-21T03:00:00Z"));
  await backupOnce(db, out, 2, new Date("2026-09-22T03:00:00Z"));
  const files = readdirSync(out).filter((f) => f.endsWith(".db")).sort();
  assert.deepEqual(files, ["agents-2026-09-21.db", "agents-2026-09-22.db", "agents-latest.db"]);
  const latest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
  assert.equal(latest.file, "agents-2026-09-22.db");
  assert.ok(existsSync(join(out, "agents-latest.db")));
  const copy = new Database(join(out, "agents-latest.db"), { readonly: true });
  assert.equal(copy.prepare("SELECT value FROM meta WHERE key = 'probe'").get().value, "kept");
  copy.close();
});

test("alert state: degraded/recovered transitions, reminders, low funds, unattributed deposits, hourly cap", () => {
  const st = new AlertState(3600, 25);
  const rep = (degraded, extra = {}) => ({ degraded, services: { payin: { ok: !degraded.includes("payin"), detail: "deposit scanner failing on bsc", unattributed7d: extra.un ?? 0 }, chain: { ok: !degraded.includes("chain"), detail: "2 of 5 signers" }, relayer: { enabled: true, balanceFmx: String(extra.relayer ?? 197), address: "0xR" }, facilitator: { enabled: false } } });
  assert.deepEqual(st.evaluate(rep([]), 1000), []);
  assert.deepEqual(st.evaluate(rep(["payin", "chain"]), 1060), ["DEGRADED payin: deposit scanner failing on bsc", "DEGRADED chain: 2 of 5 signers"]);
  assert.deepEqual(st.evaluate(rep(["payin", "chain"]), 1120), [], "no repeat inside the reminder window");
  assert.deepEqual(st.evaluate(rep(["payin"]), 1180), ["RECOVERED chain"]);
  assert.match(st.evaluate(rep(["payin"]), 1060 + 3600)[0], /STILL DEGRADED payin/);
  assert.deepEqual(st.evaluate(rep([], { relayer: 20 }), 5000), ["RECOVERED payin", "LOW FUNDS relayer 0xR: 20 FMX (alert floor 25 FMX)"]);
  assert.match(st.evaluate(rep([], { relayer: 20, un: 2 }), 5060)[0], /2 new deposit\(s\) matched no quote/);
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (st.allow(9000)) allowed++;
  assert.equal(allowed, 30);
  const msg = describeEvent({ id: 1, type: "bounty.claim", ts: 1, at: 1, actor: { address: "0x38A358681199a42B11085A46cEF390D7C26FF68d", name: "PrismaQuill-FMX", agentId: 13 }, ref: { kind: "bounty", id: "5" }, data: { bountyId: 5, pitch: "Delivered a Python SDK" } }, "https://ferminux.net");
  assert.match(msg, /claimed bounty #5: Delivered a Python SDK/);
  assert.match(msg, /#13/);
});

test("faucet: stops at the relayer reserve so gasless relays keep their gas; default cap 100/day", async (t) => {
  const db = openMemoryDb();
  const { app, v3 } = await buildServer({ db, cfg: { ...cfg, relayerKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" }, workers: false, logger: false, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  t.after(() => app.close());
  let relayerBal = 10n ** 18n * 502n / 10n; // 50.2 FMX: one drip would take it under the 50 FMX reserve
  v3.provider.getBalance = async (a) => (a === v3.relayer.address ? relayerBal : 0n);
  v3.provider.getTransactionCount = async () => 0;
  v3.provider.getFeeData = async () => ({ maxFeePerGas: 2_000_000_000n });
  v3.relayer.sendTransaction = async () => ({ hash: "0x" + "ab".repeat(32) });
  const info = (await app.inject({ method: "GET", url: "/api/faucet" })).json();
  assert.equal(info.globalPerDay, 100);
  assert.equal(info.relayerReserveFmx, "50.0");
  const fresh = "0x000000000000000000000000000000000000bEEF";
  const paused = await app.inject({ method: "POST", url: "/api/faucet", headers: { "content-type": "application/json" }, payload: JSON.stringify({ address: fresh }) });
  assert.equal(paused.statusCode, 503);
  assert.equal(paused.json().code, "faucet_reserve");
  relayerBal = 10n ** 18n * 197n;
  const ok = await app.inject({ method: "POST", url: "/api/faucet", headers: { "content-type": "application/json" }, payload: JSON.stringify({ address: fresh }) });
  assert.equal(ok.statusCode, 202, ok.body);
});

test("job views carry reviewDeadline / claimableAt for Delivered jobs", async (t) => {
  const { app, db } = await setup();
  t.after(() => app.close());
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, createdAt, deliveredAt, status) VALUES (6, 3, '0xF61d0000000000000000000000000000000f2847', '100000000000000000', '0x11', '', 1790000000, 1790027929, 2)").run();
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, createdAt, status) VALUES (7, 3, '0xF61d0000000000000000000000000000000f2847', '1', '0x11', '', 1790000000, 1)").run();
  const j6 = (await app.inject({ method: "GET", url: "/api/jobs/6" })).json();
  assert.equal(j6.reviewDeadline, 1790027929 + 86400);
  assert.equal(j6.claimableAt, 1790027929 + 86400);
  const j7 = (await app.inject({ method: "GET", url: "/api/jobs/7" })).json();
  assert.equal(j7.reviewDeadline, null);
  assert.equal(j7.claimableAt, null);
});

test("HOUSE_AGENT_IDS: the operator's own agents' bounty claims are labelled and not counted as competition", async (t) => {
  process.env.HOUSE_AGENT_IDS = "12";
  const { app, db } = await setup();
  t.after(() => { delete process.env.HOUSE_AGENT_IDS; return app.close(); });
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO bounties (id, poster, title, brief, rewardWei, tags, deadline, status, createdAt, updatedAt) VALUES (5, '0x4660E707371db34E8229A66b1e141053F61b2AD4', 'Python SDK', 'port it', '800000000000000000000', '[]', NULL, 'open', ?, ?)").run(now, now);
  db.prepare("INSERT INTO bounty_claims (bountyId, agentId, claimer, pitch, createdAt, updatedAt) VALUES (5, 12, '0xD7175A244a3Eab83f574135318d037Fb6221C358', 'I will', ?, ?)").run(now, now);
  db.prepare("INSERT INTO bounty_claims (bountyId, agentId, claimer, pitch, createdAt, updatedAt) VALUES (5, 13, '0x38A358681199a42B11085A46cEF390D7C26FF68d', 'Delivered', ?, ?)").run(now, now);
  const b = (await app.inject({ method: "GET", url: "/api/bounties/5" })).json();
  assert.equal(b.claimCount, 1);
  assert.equal(b.houseClaimCount, 1);
  assert.deepEqual(b.claims.map((c) => [c.agentId, c.house]), [[12, true], [13, false]]);
  const w = (await app.inject({ method: "GET", url: "/api/work?kind=bounty" })).json();
  assert.equal(w.items.find((i) => i.refId === 5).claims, 1);
});
