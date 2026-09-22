// Addendum v3: end-to-end x402 handshake against a REAL Fastify app —
// `fmx.x402.requirePayment(price).fastify` as a preHandler on a priced route,
// a tiny stub gateway facilitator (node:http, simulating POST /api/x402/verify
// + /api/x402/settle), and the SDK's `fmx.fetch` client wrapper driving the
// full round trip (probe -> 402 -> sign a Voucher -> retry -> 200).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Fastify from "fastify";
import { Wallet } from "ethers";
import { Ferminux } from "@ferminux/agent";

const SERVER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // agent owner / payee
const CLIENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // caller / payer
const VAULT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

function stubFacilitator(opts = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push({ path: req.url, body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/x402/verify") {
        res.end(JSON.stringify(opts.verify ?? { ok: true }));
      } else if (req.url === "/api/x402/settle") {
        res.end(JSON.stringify(opts.settle ?? { success: true, txHash: "0xdeadbeef" }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/api` })),
  );
}

async function startInvokeApp(fmx, price) {
  const app = Fastify();
  let handlerCalls = 0;
  app.post("/invoke", { preHandler: fmx.x402.requirePayment(price, { resource: "/invoke", description: "test agent — pay-per-call" }).fastify }, async (request) => {
    handlerCalls++;
    return { ok: true, echoed: request.body };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, calls: () => handlerCalls };
}

test("requirePayment: 402 challenge -> facilitator verify+settle -> PAYMENT-RESPONSE -> handler runs exactly once", async (t) => {
  const gw = await stubFacilitator();
  t.after(() => gw.server.close());

  const server = new Ferminux({ privateKey: SERVER_KEY, gateway: gw.url, x402Vault: VAULT });
  t.after(() => server.provider.destroy());
  const { app, base, calls } = await startInvokeApp(server, 1);
  t.after(() => app.close());

  const client = new Ferminux({ privateKey: CLIENT_KEY, x402Vault: VAULT });
  t.after(() => client.provider.destroy());

  const res = await client.fetch(`${base}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, echoed: { hello: "world" } });
  assert.equal(calls(), 1); // the handler never runs before payment is verified

  const paymentResponseHeader = res.headers.get("payment-response");
  assert.ok(paymentResponseHeader);
  const decoded = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf8"));
  assert.equal(decoded.success, true);
  assert.equal(decoded.txHash, "0xdeadbeef");

  // exactly one verify, one settle, in that order, carrying the signed voucher
  assert.equal(gw.calls.length, 2);
  assert.equal(gw.calls[0].path, "/api/x402/verify");
  assert.equal(gw.calls[1].path, "/api/x402/settle");
  assert.equal(gw.calls[0].body.voucher.amount, "1000000000000000000");
  assert.equal(gw.calls[0].body.voucher.payer, new Wallet(CLIENT_KEY).address);
  assert.equal(gw.calls[0].body.voucher.payee, new Wallet(SERVER_KEY).address);
  assert.deepEqual(gw.calls[0].body.voucher, gw.calls[1].body.voucher);
  assert.equal(gw.calls[0].body.signature, gw.calls[1].body.signature);
});

test("requirePayment: facilitator rejects the voucher -> the handler never runs, client sees a 402 both times", async (t) => {
  const gw = await stubFacilitator({ verify: { ok: false, reason: "insufficient balance" } });
  t.after(() => gw.server.close());

  const server = new Ferminux({ privateKey: SERVER_KEY, gateway: gw.url, x402Vault: VAULT });
  t.after(() => server.provider.destroy());
  const { app, base, calls } = await startInvokeApp(server, 1);
  t.after(() => app.close());

  const client = new Ferminux({ privateKey: CLIENT_KEY, x402Vault: VAULT });
  t.after(() => client.provider.destroy());

  const res = await client.fetch(`${base}/invoke`, { method: "POST" });
  assert.equal(res.status, 402); // fmx.fetch retries exactly once; the retry is rejected too
  assert.equal(calls(), 0);
  assert.equal(gw.calls.length, 1); // settle is never queued for a failed verify
  assert.equal(gw.calls[0].path, "/api/x402/verify");
});

test("requirePayment: no PAYMENT header -> 402 with a well-formed challenge (no facilitator call)", async (t) => {
  const gw = await stubFacilitator();
  t.after(() => gw.server.close());
  const server = new Ferminux({ privateKey: SERVER_KEY, gateway: gw.url, x402Vault: VAULT });
  t.after(() => server.provider.destroy());
  const { app, base } = await startInvokeApp(server, 0.5); // AmountLike: a number means FMX (a string means wei)
  t.after(() => app.close());

  const res = await fetch(`${base}/invoke`, { method: "POST" });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.x402Version, 1);
  const accept = body.accepts[0];
  assert.equal(accept.scheme, "ferminux-voucher");
  assert.equal(accept.network, "ferminux:3961");
  assert.equal(accept.payTo, new Wallet(SERVER_KEY).address);
  assert.equal(accept.maxAmountRequired, "500000000000000000");
  assert.equal(accept.extra.vault, VAULT);
  assert.equal(gw.calls.length, 0);

  const headerChallenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
  assert.deepEqual(headerChallenge, body);
});
