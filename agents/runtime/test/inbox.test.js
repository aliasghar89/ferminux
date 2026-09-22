// Runtime POST /inbox: append to inbox.jsonl, auto-reply guards (self, per-sender cap, depth).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Wallet } from "ethers";
import { registerInbox, shouldAutoReply, replyDepth } from "../dist/inbox.js";

const own = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("replyDepth counts Re: prefixes", () => {
  assert.equal(replyDepth(undefined), 0);
  assert.equal(replyDepth("hello"), 0);
  assert.equal(replyDepth("Re: hello"), 1);
  assert.equal(replyDepth("RE: re:  hello"), 2);
});

test("shouldAutoReply guards", () => {
  const seen = new Map();
  const T = 100_000; // clock well past the 60 s cap measured against "never replied" (0)
  const base = { id: 1, from: { address: other }, subject: "hi", body: "yo" };
  assert.equal(shouldAutoReply({ ...base, from: { address: own.address } }, own.address, seen, T).ok, false);
  assert.equal(shouldAutoReply({ ...base, from: own.address.toLowerCase() }, own.address, seen, T).ok, false);
  assert.equal(shouldAutoReply({ ...base, body: "  " }, own.address, seen, T).ok, false);
  assert.equal(shouldAutoReply({ ...base, subject: "Re: Re: hi" }, own.address, seen, T).ok, false);
  assert.equal(shouldAutoReply({ ...base, subject: "Re: hi" }, own.address, seen, T).ok, true);
  const d = shouldAutoReply(base, own.address, seen, T);
  assert.deepEqual(d, { ok: true, sender: other });
  seen.set(other.toLowerCase(), T);
  assert.match(shouldAutoReply(base, own.address, seen, T + 59_999).reason, /rate cap/);
  assert.equal(shouldAutoReply(base, own.address, seen, T + 60_000).ok, true);
});

test("POST /inbox appends jsonl and auto-replies through fmx.messages.send with a 60 s per-sender cap", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let nowMs = 5_000_000;
  const sent = [];
  const fmx = {
    requireSigner: () => ({ address: own.address }),
    messages: { send: async (m) => { sent.push(m); return { id: 99, ...m }; } },
  };
  const handler = async (input) => {
    const msgs = input.messages;
    assert.equal(msgs[0].role, "system");
    assert.match(msgs[0].content, /replying to a direct message/);
    return { ok: true, output: `auto: ${msgs[1].content.split("\n\n")[1]}` };
  };
  const app = Fastify({ logger: false });
  registerInbox(app, {
    fmx, inboxPath: join(dir, "inbox.jsonl"), agentName: () => "Scribe", agentId: 7,
    handlerName: "llm", handler, autoreply: true, now: () => nowMs,
  });
  await app.ready();
  t.after(() => app.close());

  const msg = { id: 1, from: { address: other, name: null, agentId: null }, to: { address: own.address }, subject: "hi", body: "what do you do?", createdAt: 1 };
  let res = await app.inject({ method: "POST", url: "/inbox", payload: msg });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, id: 1, autoreply: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { to: other, body: "auto: what do you do?", subject: "Re: hi" });

  // second message from the same sender inside 60 s: stored, not answered
  nowMs += 10_000;
  res = await app.inject({ method: "POST", url: "/inbox", payload: { ...msg, id: 2, body: "again" } });
  assert.deepEqual(res.json(), { ok: true, id: 2, autoreply: false });
  // from self: never answered
  res = await app.inject({ method: "POST", url: "/inbox", payload: { ...msg, id: 3, from: { address: own.address } } });
  assert.deepEqual(res.json(), { ok: true, id: 3, autoreply: false });
  // after the cap window: answered again
  nowMs += 60_000;
  res = await app.inject({ method: "POST", url: "/inbox", payload: { ...msg, id: 4, body: "later", subject: "" } });
  assert.deepEqual(res.json(), { ok: true, id: 4, autoreply: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, "Re: message to Scribe");

  const lines = readFileSync(join(dir, "inbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].receivedAt, 5000);
  assert.equal(lines[3].body, "later");
});

test("POST /inbox with echo handler never auto-replies even with autoreply on", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const app = Fastify({ logger: false });
  registerInbox(app, {
    fmx: { requireSigner: () => ({ address: own.address }), messages: { send: async (m) => sent.push(m) } },
    inboxPath: join(dir, "inbox.jsonl"), agentName: () => "Echo", agentId: 1, handlerName: "echo",
    handler: async () => ({ ok: true, output: "x" }), autoreply: true,
  });
  await app.ready();
  t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/inbox", payload: { id: 5, from: { address: other }, body: "hi" } });
  assert.deepEqual(res.json(), { ok: true, id: 5, autoreply: false });
  assert.equal(sent.length, 0);
});
