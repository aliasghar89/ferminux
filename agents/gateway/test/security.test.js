// Security audit regressions: outbound-fetch SSRF guard (net.ts), x402
// settlement-horizon checks, invoke proxy hygiene (secret stays in-cluster,
// active content types neutralised, oversize bodies capped), signed DELETEs
// bound to their resource + single-use, SSE connection caps, faucet PoW,
// paginated job lists, v3 indexer idempotency under a reorg re-scan.
// Stubbed fetches target *.example hosts that never resolve; the SSRF guard (src/net.ts) is exercised explicitly in security.test.js.
process.env.ALLOW_PRIVATE_FETCH = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage } from "../dist/commons/sign.js";
import { canonicalMessageRaw } from "../dist/commons/sign-v3.js";
import { X402_DOMAIN_NAME, X402_DOMAIN_VERSION, X402_VOUCHER_TYPES } from "../dist/abi-v3.js";
import { isPrivateIp, checkPublicUrlSync, safeFetch, readCapped } from "../dist/net.js";
import { powBits } from "../dist/v3/faucet.js";
import { safeContentType } from "../dist/v3/a2a.js";
import { applyV3Event } from "../dist/v3/indexer-v3.js";
import { ActivityBus } from "../dist/commons/activity.js";
import { WebhookBus } from "../dist/v3/webhooks.js";
import { X402_MIN_EXPIRY_S } from "../dist/v3/x402.js";

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
  payinRpcUrls: { eth: "http://127.0.0.1:1", bsc: "http://127.0.0.1:1", base: "http://127.0.0.1:1", arbitrum: "http://127.0.0.1:1", polygon: "http://127.0.0.1:1", optimism: "http://127.0.0.1:1", avalanche: "http://127.0.0.1:1" },
  payinDeposits: {},
  webhookTickMs: 1e9,
  x402BatchMs: 1e9,
  payinPollMs: 1e9,
};
const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // owns agent 7
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const ZERO = "0x0000000000000000000000000000000000000000";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

async function setup(opts = {}) {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt, card, online) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").run(
    7, alice.address, "Scribe Bot", opts.endpoint ?? "https://scribe.example", 1, 1_758_000_000,
    JSON.stringify({ ferminux: 1, agentId: 7, name: "Scribe Bot", pricePerCall: opts.price ?? "0" }),
  );
  const calls = [];
  const fetchImpl = opts.fetchImpl ?? (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(opts.body ?? JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": opts.contentType ?? "application/json" } });
  });
  const { app, activity } = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) }, v3: { fetchImpl } });
  await app.ready();
  const clock = { s: () => Math.floor(nowMs / 1000), advance: (ms) => (nowMs += ms) };
  const signed = async (wallet, action, payload = {}) => {
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  };
  const headers = async (wallet, action) => {
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessageRaw(action, wallet.address, ts, ""));
    return { "x-ferminux-address": wallet.address, "x-ferminux-ts": String(ts), "x-ferminux-sig": sig };
  };
  const inject = (method, url, body, hdrs = {}) => app.inject({ method, url, headers: { "content-type": "application/json", ...hdrs }, payload: body === undefined ? undefined : JSON.stringify(body) });
  const voucher = async (wallet, { payee, amount, nonce, expiry }) => {
    const v = { payer: wallet.address, payee, amount: String(amount), nonce: String(nonce), expiry, ref: "0x" + "00".repeat(32) };
    const signature = await wallet.signTypedData({ name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: 3961, verifyingContract: ZERO }, X402_VOUCHER_TYPES, { ...v, amount: BigInt(v.amount), nonce: BigInt(v.nonce) });
    return { scheme: "ferminux-voucher", network: "ferminux:3961", payload: { voucher: v, signature } };
  };
  return { app, db, activity, clock, signed, headers, inject, voucher, calls };
}

test("net: private / loopback / link-local / metadata / mapped addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPrivateIp(ip), false, ip);
  assert.equal(isPrivateIp("not-an-ip"), true);
});

test("net: checkPublicUrlSync rejects literal private hosts, credentials, odd schemes; accepts public https", () => {
  const prev = process.env.ALLOW_PRIVATE_FETCH;
  delete process.env.ALLOW_PRIVATE_FETCH;
  try {
    for (const bad of ["http://127.0.0.1:8790/api", "http://localhost/x", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://metadata.google.internal/", "http://10.0.0.1/", "http://2130706433/", "http://0x7f000001/", "ftp://example.com/", "javascript:alert(1)", "https://user:pw@example.com/", "http://svc.internal/", "http://box.local/"]) {
      assert.throws(() => checkPublicUrlSync(bad), (e) => e.status === 400, bad);
    }
    assert.equal(checkPublicUrlSync("https://hooks.example.com/x?y=1").hostname, "hooks.example.com");
    assert.equal(checkPublicUrlSync("http://93.184.216.34/").hostname, "93.184.216.34");
  } finally {
    if (prev !== undefined) process.env.ALLOW_PRIVATE_FETCH = prev;
  }
});

test("net: safeFetch follows ≤ 3 redirects, never into private space, and drops headers across origins", async () => {
  const prev = process.env.ALLOW_PRIVATE_FETCH;
  delete process.env.ALLOW_PRIVATE_FETCH;
  try {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), headers: init.headers, method: init.method, redirect: init.redirect });
      if (String(url) === "http://93.184.216.34/a") return new Response(null, { status: 302, headers: { location: "http://93.184.216.35/b" } });
      if (String(url) === "http://93.184.216.35/b") return new Response(null, { status: 307, headers: { location: "http://10.0.0.1/secret" } });
      if (String(url) === "http://93.184.216.36/loop") return new Response(null, { status: 302, headers: { location: "http://93.184.216.36/loop" } });
      return new Response("ok", { status: 200 });
    };
    await assert.rejects(safeFetch("http://93.184.216.34/a", { method: "POST", body: "x", headers: { "x-secret": "s" }, fetchImpl }), (e) => e.code === "private_url");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].redirect, "manual");
    assert.equal(seen[1].headers, undefined); // cross-origin hop: request headers stripped
    assert.equal(seen[1].method, "GET"); // 302 → GET without body
    await assert.rejects(safeFetch("http://93.184.216.36/loop", { fetchImpl }), /too many redirects/);
    await assert.rejects(safeFetch("http://127.0.0.1:1/", { fetchImpl }), (e) => e.code === "private_url");
    assert.equal((await safeFetch("http://93.184.216.37/ok", { fetchImpl })).status, 200);
  } finally {
    if (prev !== undefined) process.env.ALLOW_PRIVATE_FETCH = prev;
  }
});

test("net: readCapped stops reading past the cap", async () => {
  const big = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1024)); c.close(); } }));
  await assert.rejects(readCapped(big, 4096), /exceeded/);
  const small = new Response("hello");
  assert.equal((await readCapped(small, 4096)).toString(), "hello");
});

test("webhooks: private / loopback / metadata URLs are refused at registration", async (t) => {
  const prev = process.env.ALLOW_PRIVATE_FETCH;
  delete process.env.ALLOW_PRIVATE_FETCH;
  const { app, signed, inject, clock } = await setup();
  t.after(() => { app.close(); if (prev !== undefined) process.env.ALLOW_PRIVATE_FETCH = prev; });
  for (const url of ["http://127.0.0.1:8790/api/health", "http://169.254.169.254/latest/meta-data/", "http://localhost:9000/", "http://10.0.0.5/hook", "http://[::1]/"]) {
    clock.advance(1100);
    const r = await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url, secret: "0123456789abcdef", events: ["job.requested"] }));
    assert.equal(r.statusCode, 400, url);
    assert.equal(r.json().code, "private_url", url);
  }
});

test("x402: vouchers that expire inside the settlement horizon are refused; supported() advertises the window", async (t) => {
  const { app, inject, clock, voucher } = await setup({ price: "1000000000000000" });
  t.after(() => app.close());
  const need = await inject("POST", "/a/7/invoke", { text: "hi" });
  assert.equal(need.statusCode, 402);
  const acc = need.json().accepts[0];
  assert.equal(acc.maxTimeoutSeconds, 300);
  const soon = await voucher(bob, { payee: acc.payTo, amount: acc.maxAmountRequired, nonce: 1, expiry: clock.s() + X402_MIN_EXPIRY_S - 1 });
  const r = await inject("POST", "/a/7/invoke", { text: "hi" }, { PAYMENT: b64(soon) });
  assert.equal(r.statusCode, 402);
  assert.match(r.json().error, /expires too soon/);
  const ok = await voucher(bob, { payee: acc.payTo, amount: acc.maxAmountRequired, nonce: 1, expiry: clock.s() + X402_MIN_EXPIRY_S });
  assert.equal((await inject("POST", "/a/7/invoke", { text: "hi" }, { PAYMENT: b64(ok) })).statusCode, 200);
  const sup = (await inject("GET", "/api/x402/supported")).json();
  assert.deepEqual(sup.voucher, { maxTimeoutSeconds: 300, minExpirySeconds: X402_MIN_EXPIRY_S });
  assert.equal(sup.batch.queued, 0); // vault not deployed → unsettleable, nothing queued
  const health = (await inject("GET", "/api/health")).json();
  assert.equal(health.v3.facilitatorLowFunds, false);
  assert.equal(health.v3.facilitatorBalance, null);
});

test("invoke proxy: gateway secret never leaves the cluster, active content types are neutralised, oversize bodies are refused", async (t) => {
  process.env.GATEWAY_INVOKE_SECRET = "s3cret";
  const html = await setup({ contentType: "text/html", body: "<script>alert(1)</script>" });
  t.after(() => { html.app.close(); delete process.env.GATEWAY_INVOKE_SECRET; });
  const r = await html.inject("POST", "/a/7/invoke", { text: "hi" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(html.calls[0].init.headers["x-ferminux-gateway-secret"], undefined); // third-party endpoint: no secret
  assert.equal(html.calls[0].init.headers["x-ferminux-agent-id"], "7");
  assert.equal(safeContentType("application/json; charset=utf-8"), "application/json; charset=utf-8");
  assert.equal(safeContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeContentType(null), "application/octet-stream");

  const huge = await setup({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 1100; i++) c.enqueue(new Uint8Array(1024)); c.close(); } }), { status: 200, headers: { "content-type": "application/json" } }) });
  t.after(() => huge.app.close());
  const big = await huge.inject("POST", "/a/7/invoke", { text: "hi" });
  assert.equal(big.statusCode, 502);
  assert.match(big.json().error, /over 1 MiB/);
});

test("signed DELETE: resource bound into the signature, single-use (replay → 409)", async (t) => {
  const { app, signed, inject, clock } = await setup();
  t.after(() => app.close());
  clock.advance(1100);
  assert.equal((await inject("PUT", "/api/memory/a", await signed(alice, "memory.put", { key: "a", value: 1 }))).statusCode, 201);
  clock.advance(1100);
  assert.equal((await inject("PUT", "/api/memory/b", await signed(alice, "memory.put", { key: "b", value: 2 }))).statusCode, 201);
  clock.advance(1100);
  // a PUT signed for key "a" cannot be pointed at key "b"
  assert.equal((await inject("PUT", "/api/memory/b", await signed(alice, "memory.put", { key: "a", value: 3 }))).statusCode, 400);
  clock.advance(1100);
  const del = await signed(alice, "memory.delete", { key: "a" });
  assert.equal((await inject("DELETE", "/api/memory/b", del)).statusCode, 400); // signed for "a", aimed at "b"
  assert.equal((await inject("DELETE", "/api/memory/a", del)).statusCode, 200);
  clock.advance(1100);
  assert.equal((await inject("DELETE", "/api/memory/a", del)).statusCode, 409); // replay of the same signature
  assert.equal((await inject("GET", "/api/memory", undefined, await (async () => { const ts = clock.s(); return { "x-ferminux-address": alice.address, "x-ferminux-ts": String(ts), "x-ferminux-sig": await alice.signMessage(canonicalMessageRaw("memory.get", alice.address, ts, "")) }; })())).json().items.length, 1);

  clock.advance(1100);
  const hook = await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url: "https://hooks.example.com/a", secret: "0123456789abcdef", events: ["job.requested"] }));
  assert.equal(hook.statusCode, 201, hook.body);
  clock.advance(1100);
  const hook2 = await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url: "https://hooks.example.com/b", secret: "0123456789abcdef", events: ["job.requested"] }));
  clock.advance(1100);
  const rm = await signed(alice, "webhook.delete", { id: hook.json().id });
  assert.equal((await inject("DELETE", `/api/webhooks/${hook2.json().id}`, rm)).statusCode, 400); // bound to the other id
  assert.equal((await inject("DELETE", `/api/webhooks/${hook.json().id}`, rm)).statusCode, 200);
  clock.advance(1100);
  assert.equal((await inject("DELETE", `/api/webhooks/${hook.json().id}`, rm)).statusCode, 409);
});

test("job lists are paginated (limit/offset, newest first)", async (t) => {
  const { app, db, inject } = await setup();
  t.after(() => app.close());
  const ins = db.prepare("INSERT INTO jobs (id, agentId, client, amount, status, createdAt) VALUES (?, 7, ?, '1', 1, ?)");
  for (let i = 1; i <= 30; i++) ins.run(i, bob.address, 1000 + i);
  assert.equal((await inject("GET", "/api/jobs?limit=10")).json().items.length, 10);
  assert.equal((await inject("GET", "/api/jobs?limit=10&offset=25")).json().items.length, 5);
  assert.equal((await inject("GET", "/api/jobs?limit=10")).json().items[0].id, 30);
  assert.equal((await inject("GET", "/api/agents/7/jobs?limit=3")).json().items.length, 3);
  assert.equal((await inject("GET", "/api/agents/7/jobs")).json().items.length, 30);
});

test("faucet: proof-of-work helper counts leading zero bits; fresh-key + pow fields advertised", async (t) => {
  const { app, inject } = await setup();
  t.after(() => app.close());
  const addr = alice.address;
  // brute-force a 12-bit solution and confirm the helper agrees with a direct keccak check
  let pow = 0;
  while (powBits(addr, String(pow)) < 12) pow++;
  const h = keccak256(toUtf8Bytes(`${addr.toLowerCase()}:${pow}`));
  assert.ok(h.startsWith("0x000"));
  assert.ok(powBits(addr, "definitely-not") < 40);
  const st = (await inject("GET", "/api/faucet")).json();
  assert.equal(st.freshKeysOnly, true);
  assert.equal(st.pow, null); // FAUCET_POW_BITS unset
  assert.equal((await inject("POST", "/api/faucet", { address: addr })).statusCode, 503); // no relayer key in tests
});

test("SSE: per-IP and global connection caps answer 503", async (t) => {
  const { app } = await setup();
  t.after(() => app.close());
  const opened = [];
  for (let i = 0; i < 8; i++) {
    const p = app.inject({ method: "GET", url: "/api/stream", headers: { "x-forwarded-for": "203.0.113.9" }, payloadAsStream: true });
    opened.push(p);
  }
  await new Promise((r) => setTimeout(r, 50));
  const over = await app.inject({ method: "GET", url: "/api/stream", headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(over.statusCode, 503);
  assert.equal(over.json().code, "sse_capacity");
  const other = app.inject({ method: "GET", url: "/api/stream", headers: { "x-forwarded-for": "203.0.113.10" }, payloadAsStream: true });
  await new Promise((r) => setTimeout(r, 50));
  void other;
});

test("v3 indexer: increment handlers apply a replayed log exactly once (reorg re-scan / resumed backfill)", () => {
  const db = openMemoryDb();
  const activity = new ActivityBus(db, () => 1_758_400_000_000);
  const webhooks = new WebhookBus(db, () => 1_758_400_000_000, async () => new Response("ok"));
  const deps = { db, activity, webhooks };
  const ev = (key, name, args, logIndex = 0) => ({ key, parsed: { name }, args, blockNumber: 10, txHash: "0x" + "ab".repeat(32), logIndex, ts: 1_758_400_000 });
  applyV3Event(deps, ev("streamPay", "StreamOpened", { id: "1", payer: alice.address, payee: bob.address, ratePerSec: "1", deposit: "100", start: "1", stop: "101" }, 0));
  applyV3Event(deps, ev("streamPay", "StreamClaimed", { id: "1", payeeAmount: "40", fee: "0" }, 1));
  applyV3Event(deps, ev("streamPay", "StreamClaimed", { id: "1", payeeAmount: "40", fee: "0" }, 1)); // same log again
  applyV3Event(deps, ev("streamPay", "StreamToppedUp", { id: "1", amount: "50" }, 2));
  applyV3Event(deps, ev("streamPay", "StreamToppedUp", { id: "1", amount: "50" }, 2));
  const s = db.prepare("SELECT deposit, claimed FROM streams WHERE id = 1").get();
  assert.equal(s.claimed, "40");
  assert.equal(s.deposit, "150");
  applyV3Event(deps, ev("arbiterPool", "CaseOpened", { caseId: "3", jobId: "9", opener: alice.address, evidenceURI: "" }, 3));
  applyV3Event(deps, ev("arbiterPool", "Voted", { caseId: "3" }, 4));
  applyV3Event(deps, ev("arbiterPool", "Voted", { caseId: "3" }, 5)); // a second vote in the SAME block counts
  applyV3Event(deps, ev("arbiterPool", "Voted", { caseId: "3" }, 5)); // replay of it does not
  assert.equal(db.prepare("SELECT votes FROM arbiter_cases WHERE id = 3").get().votes, 2);
});

// 2026-09-24 audit: /api/streams showed claimed "0" for cancelled stream #2 (on-chain withdrawn 0.00081 FMX): the
// cancel's payout never reached `claimed`. Also: SQL CAST(... AS INTEGER) clamps at 2^63-1 wei (≈ 9.22 FMX).
test("v3 indexer: StreamCancelled adds the payee payout to claimed once; big totals stay exact; reconcile repairs old rows", async () => {
  const { reconcileStreamCancels } = await import("../dist/v3/indexer-v3.js");
  const db = openMemoryDb();
  const activity = new ActivityBus(db, () => 1_758_400_000_000);
  const webhooks = new WebhookBus(db, () => 1_758_400_000_000, async () => new Response("ok"));
  const deps = { db, activity, webhooks };
  const ev = (name, args, logIndex, tx = "0x" + "cd".repeat(32)) => ({ key: "streamPay", parsed: { name }, args, blockNumber: 20, txHash: tx, logIndex, ts: 1_758_400_000 });
  applyV3Event(deps, ev("StreamOpened", { id: "3", payer: alice.address, payee: bob.address, ratePerSec: "2314814814815", deposit: "200000000000000000", start: "1", stop: "86401" }, 0));
  applyV3Event(deps, ev("StreamClaimed", { id: "3", payeeAmount: "79398148148177", fee: "1620370370313" }, 1));
  applyV3Event(deps, ev("StreamCancelled", { id: "3", by: alice.address, payeeAmount: "63518518518496", fee: "1296296296296", refund: "1" }, 2));
  applyV3Event(deps, ev("StreamCancelled", { id: "3", by: alice.address, payeeAmount: "63518518518496", fee: "1296296296296", refund: "1" }, 2)); // replay
  assert.equal(db.prepare("SELECT claimed, cancelled FROM streams WHERE id = 3").get().claimed, "145833333333282", "matches getStream(3).withdrawn on chain");
  // > 2^63 wei
  applyV3Event(deps, ev("StreamOpened", { id: "4", payer: alice.address, payee: bob.address, ratePerSec: "1", deposit: "50000000000000000000", start: "1", stop: "2" }, 3));
  applyV3Event(deps, ev("StreamToppedUp", { id: "4", amount: "50000000000000000000" }, 4));
  applyV3Event(deps, ev("StreamClaimed", { id: "4", payeeAmount: "12000000000000000000", fee: "0" }, 5));
  const big = db.prepare("SELECT deposit, claimed FROM streams WHERE id = 4").get();
  assert.equal(big.deposit, "100000000000000000000");
  assert.equal(big.claimed, "12000000000000000000");
  // an old cancel that was indexed before the fix: in `events`, not in v3_counted, claimed still 0
  db.prepare("INSERT INTO streams (id, payer, payee, ratePerSec, deposit, start, stop, cancelled, txOpened, updatedAtBlock) VALUES (2, ?, ?, '1', '1000000000000000', 1, 2, 1, '0x0', 1)").run(alice.address, bob.address);
  db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, 0, 30, 'streamPay', 'StreamCancelled', ?, 1)").run("0x" + "ef".repeat(32), JSON.stringify({ id: "2", by: alice.address, payeeAmount: "793981481481476", fee: "16203703703704", refund: "1" }));
  assert.equal(reconcileStreamCancels(db), 1);
  assert.equal(db.prepare("SELECT claimed FROM streams WHERE id = 2").get().claimed, "810185185185180");
  assert.equal(reconcileStreamCancels(db), 0, "idempotent");
});

test("payload store never serves active content from the gateway origin", async (t) => {
  const { app, inject } = await setup();
  t.after(() => app.close());
  const { servableContentType } = await import("../dist/payloads.js");
  assert.equal(servableContentType("text/html; charset=utf-8"), "text/plain; charset=utf-8");
  assert.equal(servableContentType("image/svg+xml"), "text/plain; charset=utf-8");
  assert.equal(servableContentType("application/xhtml+xml"), "text/plain; charset=utf-8");
  assert.equal(servableContentType("application/javascript"), "text/plain; charset=utf-8");
  assert.equal(servableContentType("application/json"), "application/json");
  assert.equal(servableContentType("text/markdown"), "text/markdown");
  assert.equal(servableContentType("image/png"), "image/png");
  assert.equal(servableContentType("application/vnd.weird"), "application/octet-stream");
  const up = await app.inject({ method: "POST", url: "/api/payloads", headers: { "content-type": "text/html" }, payload: "<script>alert(1)</script>" });
  assert.equal(up.statusCode, 200, up.body);
  const got = await inject("GET", `/api/payloads/${up.json().hash}`);
  assert.equal(got.statusCode, 200);
  assert.match(got.headers["content-type"], /^text\/plain/);
  assert.equal(got.headers["x-content-type-options"], "nosniff");
  assert.match(got.headers["content-security-policy"], /sandbox/);
  assert.equal(got.body, "<script>alert(1)</script>");
});
