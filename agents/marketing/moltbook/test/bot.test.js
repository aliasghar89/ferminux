// Outreach-bot behaviour fixed after the 2026-09-24 audit: reply scope + caps, no canned out-of-scope replies,
// duplicate-post detection, confident-only verification answers, template honesty, the LLM circuit breaker.
import test from "node:test";
import assert from "node:assert/strict";
const SRC = new URL("../src", import.meta.url).href;
const { handlePostActivity } = await import(`${SRC}/dm.js`);
const { publish, contentHash } = await import(`${SRC}/heartbeat.js`);
const { heuristicSolveDetailed } = await import(`${SRC}/verify.js`);
const { renderTemplate, normTitle, data: dataTemplates, replypost } = await import(`${SRC}/templates.js`);
const { makeLlmComplete, llmAvailable } = await import(`${SRC}/llm.js`);
const { answerQuestion, looksLikeQuestion } = await import(`${SRC}/faq.js`);
const { loadConfig } = await import(`${SRC}/config.js`);

const logger = { info() {}, warn() {}, error() {}, write_action() {} };
function freshState() {
  return { published: [{ postId: "OURS", title: "x" }], queue: { posted: {} }, replies: { answeredCommentIds: [], answeredDmIds: [] }, comments: { dailyCounts: {} }, content: { usedTitles: [] }, posts: { dailyCounts: {} } };
}

test("replies: only our posts or direct replies to us, only questions, caps, silent when no answer, stop on 429", async () => {
  const cfg = { ...loadConfig({}), agentName: "ferminux" };
  const posted = [];
  const threads = {
    OURS: [
      { id: "c1", author: { name: "alice" }, content: "How do I register on Ferminux?" },
      { id: "c2", author: { name: "alice" }, content: "And what about the faucet?" }, // same author: capped at 1 per thread
      { id: "c3", author: { name: "bob" }, content: "nice post" }, // not a question
      { id: "c4", author: { name: "carol" }, content: "What is your favourite colour?" }, // question, no answer without LLM
    ],
    THEIRS: [
      { id: "t1", author: { name: "lucifer" }, content: "Is tokenizing the boundary worth it?" }, // top-level on a stranger's thread
      { id: "t2", author: { name: "ferminux" }, content: "our comment", replies: [
        { id: "t3", author: { name: "dave" }, content: "How do agents get paid through the escrow?" }, // direct reply to us
      ] },
    ],
  };
  const client = {
    postComments: async (id) => ({ comments: threads[id] }),
    createComment: async (postId, { content, parent_id }) => { posted.push({ postId, parent_id, content }); return { comment: { id: "r" + posted.length }, verified: true }; },
    markPostRead: async () => ({}),
  };
  const state = freshState();
  const home = { activity_on_your_posts: [{ post_id: "OURS" }, { post_id: "THEIRS" }] };
  const res = await handlePostActivity({ client, cfg, state, home, facts: "", llmComplete: null, logger, dryRun: false });
  assert.deepEqual(posted.map((p) => p.parent_id), ["c1", "t3"], JSON.stringify(res));
  assert.ok(!posted.some((p) => /outside what I can answer/.test(p.content)));
  // everything evaluated is marked, so the next heartbeat does nothing
  const again = await handlePostActivity({ client, cfg, state, home, facts: "", llmComplete: null, logger, dryRun: false });
  assert.equal(posted.length, 2);
  assert.ok(again.every((r) => r.action !== "replied"));

  // a 429 stops the loop at once
  const s2 = freshState();
  let calls = 0;
  const c429 = { ...client, createComment: async () => { calls++; const e = new Error("rate limited"); e.status = 429; throw e; } };
  threads.OURS2 = [{ id: "q1", author: { name: "a" }, content: "How do I register?" }, { id: "q2", author: { name: "b" }, content: "What does x402 cost?" }];
  s2.published.push({ postId: "OURS2", title: "y" });
  await handlePostActivity({ client: c429, cfg, state: s2, home: { activity_on_your_posts: [{ post_id: "OURS2" }] }, facts: "", llmComplete: null, logger, dryRun: false });
  assert.equal(calls, 1);
});

test("faq: no out-of-scope fallback; 'worth' needs FMX context", async () => {
  assert.equal((await answerQuestion({ text: "What is your favourite colour?", llmComplete: null, facts: "" })).text, null);
  assert.equal((await answerQuestion({ text: "Is tokenizing the boundary worth it?", llmComplete: null, facts: "" })).text, null);
  assert.match((await answerQuestion({ text: "Is FMX worth buying?", llmComplete: null, facts: "" })).text, /wFMX/);
  assert.equal(looksLikeQuestion("nice post"), false);
  assert.equal(looksLikeQuestion("How do I register?"), true);
});

test("publish: a returned existing post is a duplicate — no counters, title marked used", async () => {
  const state = { ...freshState(), published: [{ postId: "p-old", title: "Old title here" }] };
  const client = { createPost: async () => ({ post: { id: "p-old", created_at: new Date(Date.now() - 3600_000).toISOString() }, message: "You already posted this! Here is your existing post." }) };
  const r = await publish({ client, state, logger, submolt: "general", title: "A brand new title for a post", content: "body", meta: {} });
  assert.equal(r.duplicate, true);
  assert.deepEqual(state.posts.dailyCounts, {});
  assert.equal(state.posts.lastPostAt, undefined);
  // the same content again is refused locally, no API call
  let called = false;
  const r2 = await publish({ client: { createPost: async () => { called = true; } }, state, logger, submolt: "philosophy", title: "A brand new title for a post", content: "body", meta: {} });
  assert.equal(r2.duplicate, true);
  assert.equal(called, false);
  // a genuinely new post counts
  const r3 = await publish({ client: { createPost: async () => ({ post: { id: "p-new", created_at: new Date().toISOString() }, verified: true }) }, state, logger, submolt: "general", title: "Something else entirely new", content: "other", meta: {} });
  assert.equal(r3.duplicate, undefined);
  assert.equal(Object.values(state.posts.dailyCounts)[0], 1);
  assert.equal(typeof contentHash("a", "b"), "string");
});

test("verification heuristic: confident only with 2 numbers and one strong operation", () => {
  assert.deepEqual(heuristicSolveDetailed("A lobster swims at twenty meters per second and accelerates by five, what is the new speed?"), { value: 25, confident: true });
  assert.equal(heuristicSolveDetailed("lobster has twenty claws and each of three friends shares them").confident, false);
  assert.equal(heuristicSolveDetailed("twenty times three").value, 60);
});

test("templates: stream post only for an open stream; used titles are skipped; reply-post titles are the angle's own", () => {
  const d = { statsPretty: { agents: 13, activeAgents: 4, jobs: 6, x402Settlements: 3 }, streams: { total: 3, sample: [{ id: 3, status: "cancelled", ratePerSecFmx: "0.000002315" }] } };
  assert.equal(dataTemplates[1](d), null, "a cancelled stream is never presented as paying");
  const thread = { id: "abc", author: "neo_konsi_s2bw", title: "Reputation is broken: karma farms everywhere", content: "trust" };
  const out = renderTemplate("replypost", {}, { thread, usedTitles: new Set(), replyAuthors: {} }, {});
  assert.equal(out.title, "Reputation that anyone can write for free is a popularity score");
  assert.equal(out.threadAuthor, "neo_konsi_s2bw");
  assert.equal(renderTemplate("replypost", {}, { thread, usedTitles: new Set([normTitle(out.title)]), replyAuthors: {} }, {}), null);
  assert.equal(renderTemplate("replypost", {}, { thread, usedTitles: new Set(), replyAuthors: { neo_konsi_s2bw: new Date().toISOString() } }, {}), null);
});

test("llm circuit breaker opens on 402 and reports unavailable", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("Insufficient Balance", { status: 402 }); };
  try {
    const llm = makeLlmComplete({ llmEnabled: true, llmBaseUrl: "https://llm.example", llmApiKey: "k", llmModel: "m" }, logger);
    assert.equal(llmAvailable(llm), true);
    await assert.rejects(llm("s", "u"), /402/);
    assert.equal(llmAvailable(llm), false);
    await assert.rejects(llm("s", "u"), /disabled until/);
    assert.equal(calls, 1, "no second paid call while open");
  } finally {
    globalThis.fetch = realFetch;
  }
});
