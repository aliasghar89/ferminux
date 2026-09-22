// Addendum v3 route tests: x402 402 flow + facilitator, webhooks (set/mine/
// delivery HMAC/delete), private memory (+ over-quota 402), compute listings,
// A2A card + JSON-RPC, ERC-8004 registration, signed audit export, relay /
// pay-in / v3 reads degrading cleanly while the contracts are not deployed.
// Stubbed fetches target *.example hosts that never resolve; the SSRF guard (src/net.ts) is exercised explicitly in security.test.js.
process.env.ALLOW_PRIVATE_FETCH = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Wallet, keccak256, toUtf8Bytes, verifyMessage, verifyTypedData, concat } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage, canonicalJson, COMMONS_ACTIONS } from "../dist/commons/sign.js";
import { canonicalMessageRaw } from "../dist/commons/sign-v3.js";
import { X402_DOMAIN_NAME, X402_DOMAIN_VERSION, X402_VOUCHER_TYPES } from "../dist/abi-v3.js";
import { leafHash, merkleRoot } from "../dist/v3/audit.js";

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

const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // owns Active agent 7 "Scribe"
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // payer
const ZERO = "0x0000000000000000000000000000000000000000";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

async function setup() {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt, jobsCompleted, ratingCount, ratingSum, card, online) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(
    7, alice.address, "Scribe Bot", "https://scribe.example", 1, 1_758_000_000, 12, 4, 18,
    JSON.stringify({ ferminux: 1, agentId: 7, name: "Scribe Bot", description: "Summarises things", capabilities: ["summarize", "translate"], pricePerCall: "1000000000000000", version: "2.1.0" }),
  );
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?, ?, ?, ?, ?, ?)").run(8, bob.address, "Free Bot", "https://free.example", 1, 1_758_000_100);
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, createdAt, status, txRequested) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(1, 7, bob.address, "1000000000000000000", "0x" + "11".repeat(32), "fmx://payload/0x" + "11".repeat(32), 1_758_100_000, 1, "0x" + "aa".repeat(32));
  db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run("0x" + "aa".repeat(32), 0, 100, "escrow", "JobRequested", JSON.stringify({ jobId: "1", agentId: "7", client: bob.address, amount: "1000000000000000000" }), 1_758_100_000);
  db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run("0x" + "bb".repeat(32), 0, 50, "registry", "AgentRegistered", JSON.stringify({ id: "7", owner: alice.address, name: "Scribe Bot" }), 1_758_000_000);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/invoke")) {
      return new Response(JSON.stringify({ echo: JSON.parse(init.body.toString()), payer: init.headers["x-ferminux-payer"] ?? null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("hook.fail")) return new Response("nope", { status: 500 });
    return new Response("ok", { status: 200 });
  };
  const { app, activity, webhooks, v3 } = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) }, v3: { fetchImpl } });
  await app.ready();
  const clock = { get: () => nowMs, advance: (ms) => (nowMs += ms), s: () => Math.floor(nowMs / 1000) };
  const signed = async (wallet, action, payload = {}) => {
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  };
  const headers = async (wallet, action, raw = "") => {
    const ts = clock.s();
    const sig = await wallet.signMessage(raw === "{}" ? canonicalMessage(action, wallet.address, ts, {}) : canonicalMessageRaw(action, wallet.address, ts, raw));
    return { "x-ferminux-address": wallet.address, "x-ferminux-ts": String(ts), "x-ferminux-sig": sig };
  };
  const inject = (method, url, body, hdrs = {}) => app.inject({ method, url, headers: { "content-type": "application/json", ...hdrs }, payload: body === undefined ? undefined : JSON.stringify(body) });
  const voucher = async (wallet, { payee, amount, nonce, expiry, ref }) => {
    const v = { payer: wallet.address, payee, amount: String(amount), nonce: String(nonce), expiry, ref: ref ?? "0x" + "00".repeat(32) };
    const signature = await wallet.signTypedData({ name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: 3961, verifyingContract: ZERO }, X402_VOUCHER_TYPES, { ...v, amount: BigInt(v.amount), nonce: BigInt(v.nonce) });
    return { scheme: "ferminux-voucher", network: "ferminux:3961", payload: { voucher: v, signature } };
  };
  return { app, db, activity, webhooks, v3, clock, signed, headers, inject, calls, voucher };
}

test("v3 actions live in COMMONS_ACTIONS (SDK-identical list)", () => {
  for (const a of ["memory.put", "memory.get", "memory.delete", "webhook.set", "webhook.delete"]) assert.ok(COMMONS_ACTIONS.includes(a), a);
});

test("x402: 402 challenge → signed voucher → proxied invoke, replay refused, facilitator verify/settle", async (t) => {
  const { app, clock, inject, calls, voucher } = await setup();
  t.after(() => app.close());

  const sup = (await inject("GET", "/api/x402/supported")).json();
  assert.equal(sup.x402Version, 1);
  assert.equal(sup.kinds[0].scheme, "ferminux-voucher");
  assert.equal(sup.kinds[0].network, "ferminux:3961");
  assert.equal(sup.disabled, true); // vault not deployed

  const first = await inject("POST", "/a/scribe-bot/invoke", { text: "hello" });
  assert.equal(first.statusCode, 402, first.body);
  const req = unb64(first.headers["payment-required"]);
  assert.deepEqual(req, first.json());
  assert.equal(req.x402Version, 1);
  const acc = req.accepts[0];
  assert.equal(acc.scheme, "ferminux-voucher");
  assert.equal(acc.network, "ferminux:3961");
  assert.equal(acc.asset, "FMX");
  assert.equal(acc.payTo, alice.address);
  assert.equal(acc.maxAmountRequired, "1000000000000000");
  assert.equal(acc.maxTimeoutSeconds, 300);
  assert.equal(acc.resource, "https://ferminux.net/a/scribe-bot/invoke");
  assert.equal(acc.extra.vault, null);
  assert.ok(Number.isInteger(acc.extra.nonceHint));

  const pay = await voucher(bob, { payee: acc.payTo, amount: acc.maxAmountRequired, nonce: acc.extra.nonceHint, expiry: clock.s() + 300, ref: keccak256(toUtf8Bytes(acc.resource)) });
  const paid = await inject("POST", "/a/scribe-bot/invoke", { text: "hello" }, { PAYMENT: b64(pay) });
  assert.equal(paid.statusCode, 200, paid.body);
  const resp = unb64(paid.headers["payment-response"]);
  assert.equal(resp.success, true);
  assert.equal(resp.nonce, String(acc.extra.nonceHint));
  assert.equal(paid.json().payer, bob.address);
  assert.deepEqual(paid.json().echo, { text: "hello" });
  assert.ok(calls.some((c) => c.url === "https://scribe.example/invoke"));

  const replay = await inject("POST", "/a/scribe-bot/invoke", { text: "again" }, { PAYMENT: b64(pay) });
  assert.equal(replay.statusCode, 402);
  assert.match(replay.json().error, /nonce already used/);

  // underpaid / wrong payee / expired / bad signature
  const low = await voucher(bob, { payee: acc.payTo, amount: "1", nonce: 2, expiry: clock.s() + 300 });
  assert.match((await inject("POST", "/a/7/invoke", {}, { PAYMENT: b64(low) })).json().error, /below required/);
  const wrongPayee = await voucher(bob, { payee: bob.address, amount: acc.maxAmountRequired, nonce: 3, expiry: clock.s() + 300 });
  assert.match((await inject("POST", "/a/7/invoke", {}, { PAYMENT: b64(wrongPayee) })).json().error, /payee must be/);
  const expired = await voucher(bob, { payee: acc.payTo, amount: acc.maxAmountRequired, nonce: 4, expiry: clock.s() - 1 });
  assert.match((await inject("POST", "/a/7/invoke", {}, { PAYMENT: b64(expired) })).json().error, /expired/);
  const forged = await voucher(bob, { payee: acc.payTo, amount: acc.maxAmountRequired, nonce: 5, expiry: clock.s() + 300 });
  forged.payload.voucher.payer = alice.address;
  assert.match((await inject("POST", "/a/7/invoke", {}, { PAYMENT: b64(forged) })).json().error, /invalid signature/);

  // facilitator endpoints, both the header form and the SDK's bare {voucher, signature}
  const v6 = await voucher(bob, { payee: alice.address, amount: "5", nonce: 6, expiry: clock.s() + 300 });
  const ver = (await inject("POST", "/api/x402/verify", { payment: v6 })).json();
  assert.equal(ver.isValid, true);
  assert.equal(ver.ok, true);
  const bare = (await inject("POST", "/api/x402/verify", { voucher: v6.payload.voucher, signature: v6.payload.signature, paymentRequirements: { payTo: bob.address } })).json();
  assert.equal(bare.isValid, false);
  assert.match(bare.reason, /payee/);
  const settled = (await inject("POST", "/api/x402/settle", { voucher: v6.payload.voucher, signature: v6.payload.signature })).json();
  assert.equal(settled.success, true);
  assert.equal(settled.nonce, "6");
  assert.equal(settled.queued, false); // no vault → stored as unsettleable
  const payer = (await inject("GET", `/api/x402/payer/${bob.address}`)).json();
  assert.equal(payer.vouchers.length, 2);
  assert.ok(payer.vouchers.every((v) => v.status === "unsettleable"));

  // free agent (no pricePerCall) passes straight through
  assert.equal((await inject("POST", "/a/free-bot/invoke", { q: 1 })).statusCode, 200);
});

test("webhooks: set, list (both body-hash conventions), HMAC delivery + retry, delete via body envelope", async (t) => {
  const { app, clock, signed, headers, inject, calls, activity, webhooks } = await setup();
  t.after(() => app.close());

  const secret = "s3cret-s3cret-s3cret-s3cret";
  const set = await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url: "https://hook.example/in", secret, events: ["job.delivered", "dm.received", "stream.opened"] }));
  assert.equal(set.statusCode, 201, set.body);
  const hookId = set.json().id;
  assert.deepEqual(set.json().events, ["job.delivered", "dm.received", "stream.opened"]);
  clock.advance(1100);
  assert.equal((await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url: "https://hook.example/in", secret, events: ["nope"] }))).statusCode, 400);
  assert.equal((await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url: "https://hook.example/in", secret: "short", events: ["job.delivered"] }))).statusCode, 400);
  clock.advance(1100);
  const failing = await inject("POST", "/api/webhooks", await signed(alice, "webhook.set", { url: "https://hook.fail/in", secret, events: ["job.delivered"] }));
  assert.equal(failing.statusCode, 201);

  const mine = await inject("GET", "/api/webhooks/mine", undefined, await headers(alice, "webhook.set"));
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal(mine.json().items.length, 2);
  const mineSdk = await inject("GET", "/api/webhooks/mine", undefined, await headers(alice, "webhook.set", "{}"));
  assert.equal(mineSdk.statusCode, 200, mineSdk.body);
  assert.equal((await inject("GET", "/api/webhooks/mine", undefined, await headers(bob, "webhook.set"))).json().items.length, 0);
  assert.equal((await inject("GET", "/api/webhooks/mine")).statusCode, 401);

  // a job.delivered activity for agent 7 → deliveries for both of alice's hooks
  activity.emit("job.delivered", { actor: alice.address, ref: { kind: "job", id: 1 }, data: { jobId: 1, agentId: 7, owner: alice.address, client: bob.address, tx: "0x" + "cc".repeat(32) } });
  activity.emit("job.delivered", { actor: alice.address, ref: { kind: "job", id: 1 }, data: { jobId: 1, agentId: 7, owner: alice.address, client: bob.address, tx: "0x" + "cc".repeat(32) }, dedupKey: "job.delivered:x" });
  const before = calls.length;
  await webhooks.tick();
  const deliveries = calls.slice(before);
  assert.equal(deliveries.length, 2);
  const ok = deliveries.find((c) => c.url === "https://hook.example/in");
  assert.ok(ok);
  const body = ok.init.body;
  assert.equal(ok.init.headers["x-ferminux-signature"], `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  assert.equal(ok.init.headers["x-ferminux-event"], "job.delivered");
  const payload = JSON.parse(body);
  assert.equal(payload.event, "job.delivered");
  assert.equal(payload.data.jobId, 1);
  assert.equal(payload.data.owner, alice.address);
  // the failing hook is retried after 10 s, then 60 s, then 10 min, then failed
  const after = (await inject("GET", "/api/webhooks/mine?deliveries=10", undefined, await headers(alice, "webhook.set"))).json();
  const okHook = after.items.find((h) => h.id === hookId);
  assert.deepEqual(okHook.deliveries, { pending: 0, ok: 1, failed: 0 });
  const failHook = after.items.find((h) => h.id !== hookId);
  assert.deepEqual(failHook.deliveries, { pending: 1, ok: 0, failed: 0 });
  await webhooks.tick();
  assert.equal(calls.length, before + 2, "not due yet");
  clock.advance(11_000);
  await webhooks.tick();
  clock.advance(61_000);
  await webhooks.tick();
  clock.advance(601_000);
  await webhooks.tick();
  const final = (await inject("GET", "/api/webhooks/mine", undefined, await headers(alice, "webhook.set"))).json();
  assert.deepEqual(final.items.find((h) => h.id !== hookId).deliveries, { pending: 0, ok: 0, failed: 1 });
  assert.equal(final.deliveries.find((d) => d.webhookId !== hookId).attempts, 4);

  // dm.received carries the body to the recipient
  clock.advance(1100);
  const dm = await inject("POST", "/api/messages", await signed(bob, "message.send", { to: 7, body: "psst", subject: "hi" }));
  assert.equal(dm.statusCode, 201, dm.body);
  const b2 = calls.length;
  await webhooks.tick();
  const dmCall = calls.slice(b2).find((c) => c.init.headers["x-ferminux-event"] === "dm.received");
  assert.ok(dmCall);
  assert.equal(JSON.parse(dmCall.init.body).data.body, "psst");

  // delete: SDK-style JSON body envelope, owner only
  clock.advance(1100);
  assert.equal((await inject("DELETE", `/api/webhooks/${hookId}`, await signed(bob, "webhook.delete", {}))).statusCode, 403);
  const del = await inject("DELETE", `/api/webhooks/${hookId}`, await signed(alice, "webhook.delete", {}));
  assert.equal(del.statusCode, 200, del.body);
  assert.equal((await inject("GET", "/api/webhooks/mine", undefined, await headers(alice, "webhook.set"))).json().items.length, 1);
});

test("memory: put/get/list/delete, limits, over-quota 402 paid with a voucher", async (t) => {
  const { app, db, clock, signed, headers, inject, voucher } = await setup();
  t.after(() => app.close());

  const put = await inject("PUT", "/api/memory/notes", await signed(alice, "memory.put", { value: { a: 1, b: "two" } }));
  assert.equal(put.statusCode, 201, put.body);
  assert.equal(put.json().usedBytes, put.json().size);
  assert.equal(put.json().quotaBytes, 5 * 1024 * 1024);
  const get = await inject("GET", "/api/memory/notes", undefined, await headers(alice, "memory.get"));
  assert.equal(get.statusCode, 200, get.body);
  assert.deepEqual(get.json().value, { a: 1, b: "two" });
  assert.equal((await inject("GET", "/api/memory/notes", undefined, await headers(bob, "memory.get"))).statusCode, 404); // private per address
  assert.equal((await inject("GET", "/api/memory/notes")).statusCode, 401);
  clock.advance(1100);
  const put2 = await inject("PUT", "/api/memory/notes", await signed(alice, "memory.put", { value: "plain text" }));
  assert.equal(put2.statusCode, 200);
  assert.equal((await inject("GET", "/api/memory/notes", undefined, await headers(alice, "memory.get", "{}"))).json().value, "plain text");
  const list = (await inject("GET", "/api/memory", undefined, await headers(alice, "memory.get"))).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].key, "notes");
  assert.equal(list.items[0].bytes, list.items[0].size);
  clock.advance(1100);
  assert.equal((await inject("PUT", "/api/memory/bad%20key", await signed(alice, "memory.put", { value: 1 }))).statusCode, 400);
  assert.equal((await inject("PUT", "/api/memory/big", await signed(alice, "memory.put", { value: "x".repeat(64 * 1024 + 1) }))).statusCode, 413);

  // over quota: 5 MB already used → 402 for 0.01 FMX per 64 KB to the treasury; pay → credit + write
  db.prepare("INSERT INTO memory (address, key, value, size, createdAt, updatedAt) VALUES (?, 'blob', 'x', ?, 1, 1)").run(alice.address, 5 * 1024 * 1024);
  clock.advance(1100);
  const body = await signed(alice, "memory.put", { value: "y".repeat(1000) });
  const need = await inject("PUT", "/api/memory/extra", body);
  assert.equal(need.statusCode, 402, need.body);
  const acc = need.json().accepts[0];
  assert.equal(acc.payTo, "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB");
  assert.equal(acc.maxAmountRequired, "10000000000000000");
  const pay = await voucher(alice, { payee: acc.payTo, amount: acc.maxAmountRequired, nonce: acc.extra.nonceHint, expiry: clock.s() + 300 });
  const paid = await inject("PUT", "/api/memory/extra", body, { PAYMENT: b64(pay) });
  assert.equal(paid.statusCode, 201, paid.body);
  assert.deepEqual(paid.json().paid, { blocks: 1, bytes: 65536 });
  assert.equal(paid.json().paidBytes, 65536);
  clock.advance(1100);
  // within the paid block now → no 402
  assert.equal((await inject("PUT", "/api/memory/extra2", await signed(alice, "memory.put", { value: "z".repeat(1000) }))).statusCode, 201);

  clock.advance(1100); // DELETE is a write: flood limit + single-use signature apply
  const del = await inject("DELETE", "/api/memory/notes", await signed(alice, "memory.delete", {}));
  assert.equal(del.statusCode, 200, del.body);
  clock.advance(1100);
  assert.equal((await inject("DELETE", "/api/memory/notes", undefined, await headers(alice, "memory.delete"))).statusCode, 404);
});

test("compute listings via tools kind=compute", async (t) => {
  const { app, signed, inject } = await setup();
  t.after(() => app.close());
  const pub = await inject("POST", "/api/tools", await signed(alice, "tool.publish", { name: "h100-box", kind: "compute", gpu: "H100 SXM", vramGb: 80, pricePerSecond: "50000000000000", region: "eu-central", endpoint: "https://gpu.example/run", description: "one H100" }));
  assert.equal(pub.statusCode, 201, pub.body);
  assert.equal(pub.json().kind, "compute");
  assert.equal(pub.json().url, "https://gpu.example/run");
  assert.deepEqual(pub.json().compute, { gpu: "H100 SXM", vramGb: 80, pricePerSecond: "50000000000000", region: "eu-central", endpoint: "https://gpu.example/run" });
  const list = (await inject("GET", "/api/compute?gpu=h100&minVramGb=40&maxPricePerSecond=60000000000000")).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].gpu, "H100 SXM");
  assert.equal((await inject("GET", "/api/compute?region=us")).json().total, 0);
  assert.equal((await inject("GET", `/api/compute/${pub.json().id}`)).json().vramGb, 80);
  assert.equal((await inject("GET", "/api/tools?kind=compute")).json().total, 1);
});

test("A2A card + JSON-RPC tasks/send, ERC-8004 registration", async (t) => {
  const { app, inject, clock, voucher } = await setup();
  t.after(() => app.close());
  const card = (await inject("GET", "/a/scribe-bot/.well-known/agent.json")).json();
  assert.equal(card.name, "Scribe Bot");
  assert.equal(card.url, "https://ferminux.net/a/scribe-bot/a2a");
  assert.equal(card.version, "2.1.0");
  assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: true, stateTransitionHistory: false });
  assert.deepEqual(card.skills.map((s) => s.id), ["summarize", "translate"]);
  assert.deepEqual(card.authentication.schemes, ["x402-ferminux"]);
  assert.equal(card.ferminux.pricePerCall, "1000000000000000");
  assert.equal((await inject("GET", "/a/7/.well-known/agent.json")).json().name, "Scribe Bot");
  assert.equal((await inject("GET", "/a/nobody/.well-known/agent.json")).statusCode, 404);

  const rpc = (msg, extra = {}) => ({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { id: "t1", message: { role: "user", parts: [{ type: "text", text: msg }] }, ...extra } });
  assert.equal((await inject("POST", "/a/scribe-bot/a2a", rpc("hi"))).statusCode, 402);
  assert.equal((await inject("POST", "/a/scribe-bot/a2a", { jsonrpc: "2.0", id: 2, method: "tasks/get", params: {} })).json().error.code, -32601);
  // pre-funded open job → no payment needed
  const viaJob = await inject("POST", "/a/scribe-bot/a2a", rpc("summarise this", { metadata: { jobId: 1 } }));
  assert.equal(viaJob.statusCode, 200, viaJob.body);
  const r = viaJob.json().result;
  assert.equal(r.id, "t1");
  assert.equal(r.status.state, "completed");
  assert.equal(r.artifacts[0].parts[0].type, "data");
  assert.equal(r.artifacts[0].parts[0].data.echo.text, "summarise this");
  assert.equal(r.artifacts[0].parts[0].data.echo.jobId, 1);
  assert.equal((await inject("POST", "/a/scribe-bot/a2a", rpc("x", { metadata: { jobId: 99 } }))).json().error.code, -32602);
  // paid
  const pay = await voucher(bob, { payee: alice.address, amount: "1000000000000000", nonce: 77, expiry: clock.s() + 300 });
  const paidRpc = await inject("POST", "/a/scribe-bot/a2a", rpc("paid call"), { PAYMENT: b64(pay) });
  assert.equal(paidRpc.statusCode, 200, paidRpc.body);
  assert.equal(paidRpc.json().result.artifacts[0].parts[0].data.payer, bob.address);

  const reg = (await inject("GET", "/api/agents/7/erc8004.json")).json();
  assert.equal(reg.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(reg.name, "Scribe Bot");
  assert.deepEqual(reg.services.map((s) => s.name), ["ferminux", "a2a", "mcp", "x402", "gateway"]);
  assert.equal(reg.services[1].endpoint, "https://ferminux.net/a/scribe-bot/.well-known/agent.json");
  assert.deepEqual(reg.registrations, []); // identity registry not deployed yet
  assert.deepEqual(reg.supportedTrust, ["reputation", "validation"]);
  assert.equal((await inject("GET", "/api/agents/99/erc8004.json")).statusCode, 404);
});

test("audit.jsonl: signed merkle root (default) and per-line sigs with ?sign=lines", async (t) => {
  const { app, inject, signed, clock } = await setup();
  t.after(() => app.close());
  clock.advance(1100);
  await inject("POST", "/api/forum/threads", await signed(alice, "thread.create", { title: "hello", body: "world" }));
  const health = (await inject("GET", "/api/health")).json();
  assert.match(health.signer, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(health.signerEphemeral, true);
  assert.deepEqual(health.v3.deployed, []);
  const res = await inject("GET", "/api/agents/7/audit.jsonl");
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers["content-type"], /x-ndjson/);
  const lines = res.body.trim().split("\n").map((l) => JSON.parse(l));
  const footer = lines.pop();
  assert.equal(footer.leaves, lines.length);
  assert.ok(lines.length >= 3);
  assert.deepEqual(new Set(lines.map((l) => l.kind)), new Set(["chain", "commons"]));
  // default: lines carry no sig of their own — the signed merkle root covers them all
  const leaves = [];
  lines.forEach((l, i) => {
    assert.equal(l.seq, i + 1);
    assert.equal(l.sig, undefined);
    leaves.push(leafHash(l));
  });
  assert.equal(merkleRoot(leaves), footer.merkleRoot);
  assert.equal(res.headers["x-ferminux-merkle-root"], footer.merkleRoot);
  assert.equal(res.headers["x-ferminux-signed"], "root");
  assert.equal(footer.signedLines, false);
  const { sig: fsig, ...frest } = footer;
  assert.equal(verifyMessage(canonicalJson(frest), fsig), health.signer);

  // ?sign=lines: every line verifies on its own, and the root still matches
  const signedRes = await inject("GET", "/api/agents/7/audit.jsonl?sign=lines");
  assert.equal(signedRes.statusCode, 200, signedRes.body);
  assert.equal(signedRes.headers["x-ferminux-signed"], "lines+root");
  const signedLines = signedRes.body.trim().split("\n").map((l) => JSON.parse(l));
  const signedFooter = signedLines.pop();
  assert.equal(signedFooter.signedLines, true);
  const signedLeaves = [];
  for (const l of signedLines) {
    const { sig, ...rest } = l;
    assert.equal(verifyMessage(canonicalJson(rest), sig), health.signer);
    signedLeaves.push(leafHash(rest));
  }
  assert.equal(merkleRoot(signedLeaves), signedFooter.merkleRoot);
  assert.equal(signedFooter.merkleRoot, footer.merkleRoot);
  assert.equal((await inject("GET", "/api/agents/7/audit.jsonl?sign=nope")).statusCode, 400);
  // block filter keeps only chain lines in range; time filter keeps commons lines
  const blk = (await inject("GET", "/api/agents/7/audit.jsonl?from=60&to=200")).body.trim().split("\n").map((l) => JSON.parse(l));
  blk.pop();
  assert.ok(blk.every((l) => l.kind === "chain" && l.block >= 60));
  assert.equal(blk.length, 1);
});

test("not-deployed / disabled degradation: relay, accounts, payin, v3 reads, stats", async (t) => {
  const { app, inject } = await setup();
  t.after(() => app.close());
  const relay = await inject("POST", "/api/relay", { account: alice.address, to: cfg.registry, deadline: 9e9, sig: "0x" + "11".repeat(65) });
  assert.equal(relay.statusCode, 503);
  assert.deepEqual(relay.json().disabled, true);
  assert.equal(relay.json().reason, "not deployed");
  assert.equal((await inject("POST", "/api/accounts/create", { owner: alice.address })).statusCode, 503);
  assert.equal((await inject("GET", "/api/relay")).json().enabled, false);
  const quote = await inject("POST", "/api/payin/quote", { chain: "base", usdc: "10.00", to: alice.address });
  assert.equal(quote.statusCode, 503);
  assert.equal(quote.json().reason, "pay-in disabled");
  assert.equal((await inject("GET", "/api/payin/q_nope")).statusCode, 404);
  for (const url of ["/api/streams", "/api/streams/plans", "/api/streams/subs", "/api/disputes?open=1", "/api/tokens", "/api/accounts"]) {
    const j = (await inject("GET", url)).json();
    assert.equal(j.disabled, true, url);
    assert.equal(j.reason, "not deployed", url);
    assert.deepEqual(j.items, [], url);
  }
  const stats = (await inject("GET", "/api/stats")).json();
  assert.equal(stats.x402VolumeWei, "0");
  assert.equal(stats.streamsOpen, 0);
  assert.equal(stats.subsActive, 0);
  assert.equal(stats.casesOpen, 0);
  assert.equal(stats.tokensLaunched, 0);
  const m = (await inject("GET", "/api/discovery/ferminux.json")).json();
  assert.equal(m.contracts.x402Vault, null);
  assert.equal(m.x402.scheme, "ferminux-voucher");
  assert.ok(m.signing.actions.includes("memory.put"));
  const llms = (await inject("GET", "/api/discovery/llms.txt")).body;
  for (const needle of ["/api/x402/supported", "/a/{slug}/a2a", "erc8004.json", "audit.jsonl", "/api/payin/quote", "/api/relay", "webhook.set", "memory.put", "PAYMENT-REQUIRED"]) assert.ok(llms.includes(needle), needle);
});
