// POST /invoke and POST /a2a share one gate: x402 when PRICE_PER_CALL is set (the gateway secret skips it),
// 404 when it is not. /a2a used to run the handler with no check at all (audit 2026-09-24).
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerDirectCallRoutes, extractA2AInput } from "../dist/direct.js";

const rpc = (text) => ({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { id: "t1", message: { role: "user", parts: [{ type: "text", text }] } } });

async function build(priced) {
  const runs = [];
  const app = Fastify({ logger: false });
  // stub gate: the real one is fmx.x402.requirePayment() + the gateway-secret bypass in serve.ts
  const gate = (resource) => async (request, reply) => {
    if (request.headers["x-ferminux-gateway-secret"] === "s3cret") return;
    if (!request.headers.payment) return reply.code(402).send({ x402Version: 1, accepts: [{ resource }] });
  };
  registerDirectCallRoutes(app, {
    handler: async (input) => { runs.push(input); return { ok: true, output: `echo ${JSON.stringify(input)}` }; },
    gate: priced ? gate : null,
    notForSale: async () => ({ ok: false, error: "this agent does not sell direct calls" }),
  });
  await app.ready();
  return { app, runs };
}

test("priced agent: /a2a without payment is 402 and never runs the handler; paid or gateway-forwarded runs it", async (t) => {
  const { app, runs } = await build(true);
  t.after(() => app.close());
  const free = await app.inject({ method: "POST", url: "/a2a", payload: rpc("hi") });
  assert.equal(free.statusCode, 402);
  assert.equal(free.json().accepts[0].resource, "/a2a");
  assert.equal(runs.length, 0);
  const paid = await app.inject({ method: "POST", url: "/a2a", payload: rpc("hi"), headers: { payment: "voucher" } });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.json().result.status.state, "completed");
  const viaGateway = await app.inject({ method: "POST", url: "/a2a", payload: rpc("hi"), headers: { "x-ferminux-gateway-secret": "s3cret" } });
  assert.equal(viaGateway.statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/invoke", payload: { text: "x" } })).statusCode, 402);
  assert.equal(runs.length, 2);
});

test("unpriced agent: /a2a and /invoke both answer 404 and never run the handler", async (t) => {
  const { app, runs } = await build(false);
  t.after(() => app.close());
  const a = await app.inject({ method: "POST", url: "/a2a", payload: rpc("hi") });
  assert.equal(a.statusCode, 404);
  assert.match(a.json().error, /does not sell direct calls/);
  assert.equal((await app.inject({ method: "POST", url: "/invoke", payload: { text: "x" } })).statusCode, 404);
  assert.equal(runs.length, 0);
});

test("extractA2AInput: text parts joined, else the data part, else params.input", () => {
  assert.equal(extractA2AInput({ message: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }), "a\nb");
  assert.deepEqual(extractA2AInput({ message: { parts: [{ type: "data", data: { x: 1 } }] } }), { x: 1 });
  assert.equal(extractA2AInput({ input: "raw" }), "raw");
  assert.equal(extractA2AInput(null), "");
});

test("a refusal ({ok:false}) answers 422 on /invoke and a failed task on /a2a, so the gateway releases the caller's voucher", async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  registerDirectCallRoutes(app, {
    handler: async (input) => (JSON.stringify(input).includes("help") ? { ok: true, op: "help" } : { ok: false, op: "unknown", error: "unrecognised request" }),
    gate: () => async () => {},
    notForSale: async () => ({ ok: false }),
  });
  await app.ready();
  const inv = await app.inject({ method: "POST", url: "/invoke", payload: { text: "what is the weather" } });
  assert.equal(inv.statusCode, 422);
  assert.equal(inv.json().ok, false);
  const a2a = await app.inject({ method: "POST", url: "/a2a", payload: rpc("what is the weather") });
  assert.equal(a2a.statusCode, 422);
  assert.equal(a2a.json().result.status.state, "failed");
  assert.equal((await app.inject({ method: "POST", url: "/invoke", payload: { text: "help" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/a2a", payload: rpc("help") })).json().result.status.state, "completed");
});
