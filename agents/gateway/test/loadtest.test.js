// Wizrd's labelled load test: /api/loadtest/stats, /api/loadtest/address/:addr, /api/loadtest/manifest,
// read from the runner's public files (stats.json + addresses.bin), with the membership checked against the
// published xpub.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDNodeWallet } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { LoadtestReader } from "../dist/loadtest.js";

const PHRASE = "test test test test test test test test test test test junk";
const SINK = "0xD7175A244a3Eab83f574135318d037Fb6221C358";
const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1", payinRpcUrls: {}, payinDeposits: {}, webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9,
};
const base = HDNodeWallet.fromPhrase(PHRASE, undefined, "m/44'/60'/7'/0");
const addr = (i) => base.deriveChild(i).address;

function writeRun(dir, { highest = 10, inFile = highest + 1, tamper = null } = {}) {
  const buf = Buffer.alloc(inFile * 20);
  for (let i = 0; i < inFile; i++) Buffer.from(addr(i).slice(2), "hex").copy(buf, i * 20);
  if (tamper !== null) Buffer.from("11".repeat(20), "hex").copy(buf, tamper * 20);
  writeFileSync(join(dir, "addresses.bin"), buf);
  writeFileSync(join(dir, "stats.json"), JSON.stringify({
    schema: "wizrd-loadtest/1", mode: "running", updatedAt: 1790300000, startedAt: 1790290000, sink: SINK, rate: 2,
    float: { address: addr(0) }, derivation: { path: "m/44'/60'/7'/0/i", xpub: base.neuter().extendedKey },
    wallets: { planned: 100000, activated: highest, highestIndex: highest }, counters: { transactions: 1234, addresses: highest + 1 }, daily: { "2026-09-25": 1234 }, last24h: 1200,
  }));
}

async function server(t, dir) {
  const prev = process.env.LOADTEST_DIR;
  process.env.LOADTEST_DIR = dir;
  const { app } = await buildServer({ db: openMemoryDb(), cfg, workers: false, logger: false, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  if (prev === undefined) delete process.env.LOADTEST_DIR; else process.env.LOADTEST_DIR = prev;
  t.after(() => app.close());
  return app;
}

test("load test not started: the routes answer honestly, nothing is a load-test wallet", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await server(t, dir);
  const s = (await app.inject({ method: "GET", url: "/api/loadtest/stats" })).json();
  assert.equal(s.deployed, false);
  assert.equal(s.manifest, "https://ferminux.net/.well-known/wizrd-loadtest.json");
  const a = (await app.inject({ method: "GET", url: `/api/loadtest/address/${addr(3)}` })).json();
  assert.equal(a.loadtest, false);
  assert.equal(a.available, false);
  const m = (await app.inject({ method: "GET", url: "/api/loadtest/manifest" })).json();
  assert.equal(m.status, "not started");
  assert.equal(m.marker.prefix, "0x46584c54");
});

test("counters, membership up to the highest activated index, the float, the sink, CORS for the explorer", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeRun(dir, { highest: 10, inFile: 20 });
  const app = await server(t, dir);
  const res = await app.inject({ method: "GET", url: "/api/loadtest/stats", headers: { origin: "https://explorer.ferminux.net" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  const s = res.json();
  assert.equal(s.deployed, true);
  assert.equal(s.counters.transactions, 1234);
  assert.equal(s.daily["2026-09-25"], 1234);
  assert.equal(s.membership.loaded, 11);
  const look = async (a) => (await app.inject({ method: "GET", url: `/api/loadtest/address/${a}` })).json();
  const w5 = await look(addr(5).toLowerCase());
  assert.deepEqual([w5.loadtest, w5.index, w5.role, w5.address], [true, 5, "wallet", addr(5)]);
  const f = await look(addr(0));
  assert.deepEqual([f.loadtest, f.index, f.role], [true, 0, "float"]);
  const beyond = await look(addr(15)); // in the file but not activated yet
  assert.equal(beyond.loadtest, false);
  const sink = await look(SINK);
  assert.deepEqual([sink.loadtest, sink.role], [false, "sink"]);
  const other = await look("0x000000000000000000000000000000000000dEaD");
  assert.deepEqual([other.loadtest, other.role], [false, null]);
  const bad = await app.inject({ method: "GET", url: "/api/loadtest/address/0x1234" });
  assert.equal(bad.statusCode, 400);
  // an ICAP string (ethers' isAddress takes it) is a 400 too, never a 500
  const icap = await app.inject({ method: "GET", url: "/api/loadtest/address/XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS" });
  assert.equal(icap.statusCode, 400);
  // any hex case answers, a wrong mixed-case checksum included
  const upper = await look("0x" + addr(5).slice(2).toUpperCase());
  assert.deepEqual([upper.loadtest, upper.index], [true, 5]);
  const pre = await app.inject({ method: "OPTIONS", url: `/api/loadtest/address/${addr(1)}`, headers: { origin: "https://explorer.ferminux.net", "access-control-request-method": "GET" } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers["access-control-allow-origin"], "*");
  const m = (await app.inject({ method: "GET", url: "/api/loadtest/manifest" })).json();
  assert.equal(m.addresses.float, addr(0));
  assert.equal(m.addresses.derivation.xpub, base.neuter().extendedKey);
  assert.equal(m.addresses.derivation.activatedUpTo, 10);
  assert.equal(m.startDate, new Date(1790290000 * 1000).toISOString());
  assert.equal(m.operator.sink, SINK);
  assert.ok(m.verify.length >= 3);
  // words: no mining vocabulary, no Ethereum branding, no PoS
  const txt = JSON.stringify(m);
  assert.ok(!/min(e|ed|er|ers|ing)\b/i.test(txt) && !/ethereum|ERC-|proof of stake|\bPoS\b/i.test(txt), txt);
});

test("the membership refreshes as waves activate, and a tampered addresses.bin is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  try {
    writeRun(dir, { highest: 4 });
    let now = 1_000_000;
    const r = new LoadtestReader(dir, () => now);
    assert.equal(r.lookup(addr(4)).loadtest, true);
    assert.equal(r.lookup(addr(7)).loadtest, false);
    writeRun(dir, { highest: 9 });
    utimesSync(join(dir, "stats.json"), new Date(), new Date(Date.now() + 5000));
    assert.equal(r.lookup(addr(7)).loadtest, false, "cached for 2 s");
    now += 2500;
    assert.equal(r.lookup(addr(7)).loadtest, true);
    assert.equal(r.size(), 10);
    // an entry that does not derive from the xpub: nothing is claimed
    const dir2 = mkdtempSync(join(tmpdir(), "lt-"));
    writeRun(dir2, { highest: 6, tamper: 6 });
    const r2 = new LoadtestReader(dir2, () => now);
    assert.equal(r2.lookup(addr(1)).loadtest, false);
    assert.match(r2.problem(), /does not derive from the published xpub/);
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverable: openapi documents the three routes and llms.txt links the manifest", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await server(t, dir);
  const spec = (await app.inject({ method: "GET", url: "/api/openapi.json" })).json();
  for (const p of ["/api/loadtest/stats", "/api/loadtest/address/{addr}", "/api/loadtest/manifest"]) assert.ok(spec.paths[p]?.get, p);
  const llms = (await app.inject({ method: "GET", url: "/api/discovery/llms.txt" })).body;
  assert.ok(llms.includes("https://ferminux.net/.well-known/wizrd-loadtest.json"));
  assert.ok(llms.includes("0x46584c5401"));
});
