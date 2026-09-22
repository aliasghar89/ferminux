// Addendum v3 x402 client tests: fmx.fetch / fmx.x402.pay() 402 handshake
// (sign a Voucher, retry once with the PAYMENT header) against a tiny local
// HTTP stub playing the priced resource server. The Fastify `requirePayment`
// server middleware (the facilitator side of this same handshake) is
// integration-tested in runtime/test/x402.test.js, where fastify is an actual
// dependency.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Wallet, keccak256, verifyTypedData } from "ethers";
import { Ferminux } from "../dist/index.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const VAULT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PAYEE = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function b64(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function unb64(s) {
  return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
}

/** A priced resource: 402 once (no PAYMENT header), 200 with the decoded voucher once paid. */
function stubResource(opts = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const payment = req.headers["payment"];
    if (!payment) {
      const challenge = {
        x402Version: 1,
        accepts: [
          {
            scheme: "ferminux-voucher",
            network: opts.network ?? "ferminux:3961",
            asset: "FMX",
            payTo: PAYEE,
            maxAmountRequired: opts.amount ?? "1000000000000000000",
            resource: "/invoke",
            description: "1 FMX per call",
            mimeType: "application/json",
            maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
            extra: { vault: opts.vault ?? VAULT, nonceHint: opts.nonceHint },
          },
        ],
      };
      res.writeHead(402, { "content-type": "application/json", "payment-required": b64(challenge) });
      res.end(JSON.stringify(challenge));
      return;
    }
    const decoded = unb64(payment);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, decoded }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/invoke` })));
}

test("fmx.fetch: request → 402 → signs a Voucher matching the challenge → retries once with PAYMENT → 200", async (t) => {
  const stub = await stubResource({ nonceHint: 777 });
  t.after(() => stub.server.close());
  const fmx = new Ferminux({ privateKey: KEY, x402Vault: VAULT });
  t.after(() => fmx.provider.destroy());

  const res = await fmx.fetch(stub.url, { method: "GET" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // exactly one 402 then one paid retry
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0].headers.payment, undefined);
  assert.ok(stub.requests[1].headers.payment);

  const payment = unb64(stub.requests[1].headers.payment);
  assert.equal(payment.scheme, "ferminux-voucher");
  assert.equal(payment.network, "ferminux:3961");
  const v = payment.payload.voucher;
  assert.equal(v.payer, new Wallet(KEY).address);
  assert.equal(v.payee, PAYEE);
  assert.equal(v.amount, "1000000000000000000");
  assert.equal(v.nonce, "777"); // honours the server's nonceHint
  assert.equal(body.decoded.payload.voucher.nonce, "777");

  // signature verifies against the exact domain/type the server would check
  const domain = { name: "FerminuxX402", version: "1", chainId: 3961, verifyingContract: VAULT };
  const types = {
    Voucher: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint64" },
      { name: "ref", type: "bytes32" },
    ],
  };
  const msg = { payer: v.payer, payee: v.payee, amount: BigInt(v.amount), nonce: BigInt(v.nonce), expiry: BigInt(v.expiry), ref: v.ref };
  assert.equal(verifyTypedData(domain, types, msg, payment.payload.signature), v.payer);
  assert.equal(v.ref, keccak256(new TextEncoder().encode("/invoke")));
});

test("fmx.fetch: a non-402 response is returned untouched (no signer needed)", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const fmx = new Ferminux(); // read-only, no privateKey
  t.after(() => fmx.provider.destroy());
  const res = await fmx.fetch(`http://127.0.0.1:${server.address().port}/free`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("fmx.fetch: 402 without a signer throws a clear read-only error instead of hanging", async (t) => {
  const stub = await stubResource();
  t.after(() => stub.server.close());
  const fmx = new Ferminux({ x402Vault: VAULT }); // no privateKey
  t.after(() => fmx.provider.destroy());
  await assert.rejects(() => fmx.fetch(stub.url), /read-only/);
});

test("fmx.x402.pay(customFetch) wraps an arbitrary fetch-like function, not just globalThis.fetch", async (t) => {
  const stub = await stubResource({ nonceHint: 5 });
  t.after(() => stub.server.close());
  const fmx = new Ferminux({ privateKey: KEY, x402Vault: VAULT });
  t.after(() => fmx.provider.destroy());
  const calls = [];
  const customFetch = (input, init) => {
    calls.push(String(input));
    return fetch(input, init);
  };
  const paidFetch = fmx.x402.pay(customFetch);
  const res = await paidFetch(stub.url);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2); // the wrapped fetch is used for both the probe and the retry
});

test("fmx.fetch guard rails: per-request cap, foreign vault, wrong network, voucher lifetime clamp", async (t) => {
  const fmx = new Ferminux({ privateKey: KEY, x402Vault: VAULT });
  t.after(() => fmx.provider.destroy());

  // 1 FMX default cap: a 402 asking for 1 FMX + 1 wei is refused, nothing is signed
  const greedy = await stubResource({ amount: "1000000000000000001" });
  t.after(() => greedy.server.close());
  await assert.rejects(() => fmx.fetch(greedy.url), /per-request cap/);
  assert.equal(greedy.requests.length, 1);
  // …unless the caller raises the cap (2 FMX)
  const res = await fmx.x402.pay(fetch, { maxAmount: 2 })(greedy.url);
  assert.equal(res.status, 200);
  const capped = new Ferminux({ privateKey: KEY, x402Vault: VAULT, x402MaxPerRequest: "1000" });
  t.after(() => capped.provider.destroy());
  await assert.rejects(() => capped.fetch(greedy.url), /per-request cap/);

  // a 402 naming a different verifying contract is never signed for
  const foreign = await stubResource({ vault: "0x0000000000000000000000000000000000000BAD" });
  t.after(() => foreign.server.close());
  await assert.rejects(() => fmx.fetch(foreign.url), /foreign contract/);

  // another chain's network id
  const other = await stubResource({ network: "ferminux:1" });
  t.after(() => other.server.close());
  await assert.rejects(() => fmx.fetch(other.url), /network/);

  // lifetime: a 5 s hint is raised to the 90 s floor, a 10-year hint is clamped to 1 h
  const short = await stubResource({ maxTimeoutSeconds: 5, nonceHint: 1 });
  t.after(() => short.server.close());
  const now = Math.floor(Date.now() / 1000);
  const sBody = await (await fmx.fetch(short.url)).json();
  assert.ok(Number(sBody.decoded.payload.voucher.expiry) >= now + 90);
  const long = await stubResource({ maxTimeoutSeconds: 10 * 365 * 86400, nonceHint: 2 });
  t.after(() => long.server.close());
  const lBody = await (await fmx.fetch(long.url)).json();
  assert.ok(Number(lBody.decoded.payload.voucher.expiry) <= now + 3600 + 5);
});

test("fmx.fetch never re-sends a voucher across a redirect", async (t) => {
  const fmx = new Ferminux({ privateKey: KEY, x402Vault: VAULT });
  t.after(() => fmx.provider.destroy());

  // 1) the paid retry is redirected: redirect:"manual" stops it, the PAYMENT header never reaches the target
  const sink = { hits: 0 };
  const sinkServer = createServer((req, res) => {
    sink.hits++;
    sink.payment = req.headers["payment"] ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ stolen: !!req.headers["payment"] }));
  });
  await new Promise((r) => sinkServer.listen(0, "127.0.0.1", r));
  t.after(() => sinkServer.close());
  const sinkUrl = `http://127.0.0.1:${sinkServer.address().port}/collect`;

  const baiting = createServer((req, res) => {
    if (!req.headers["payment"]) {
      const challenge = { x402Version: 1, accepts: [{ scheme: "ferminux-voucher", network: "ferminux:3961", asset: "FMX", payTo: PAYEE, maxAmountRequired: "1000000000000000000", resource: "/invoke", maxTimeoutSeconds: 120, extra: { vault: VAULT, nonceHint: 42 } }] };
      res.writeHead(402, { "content-type": "application/json", "payment-required": b64(challenge) });
      res.end(JSON.stringify(challenge));
      return;
    }
    res.writeHead(302, { location: sinkUrl });
    res.end();
  });
  await new Promise((r) => baiting.listen(0, "127.0.0.1", r));
  t.after(() => baiting.close());
  await assert.rejects(() => fmx.fetch(`http://127.0.0.1:${baiting.address().port}/invoke`), /redirect/i);
  assert.equal(sink.hits, 0, "the voucher must never reach the redirect target");

  // 2) a 402 that only arrives after a cross-origin redirect is refused before anything is signed
  const priced = await stubResource({ nonceHint: 9 });
  t.after(() => priced.server.close());
  const redirector = createServer((req, res) => {
    res.writeHead(302, { location: priced.url });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
  t.after(() => redirector.close());
  await assert.rejects(() => fmx.fetch(`http://127.0.0.1:${redirector.address().port}/invoke`), /different origin|other than the one that was called/);
  assert.equal(priced.requests.length, 1, "only the unpaid probe should have reached the priced resource");
});
