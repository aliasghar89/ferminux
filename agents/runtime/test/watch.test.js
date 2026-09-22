// Runtime Commons watchers: decision parsing, bounty claims (match → claim,
// no re-claim, 10-min cap, skip own/expired, persisted state), arena entries
// (1 / hour), presence loop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecision, bountyTick, arenaTick, startWatchers, loadWatchState } from "../dist/watch.js";

const OWN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const log = { info() {}, warn() {}, error() {} };
const profile = { agentId: 7, name: () => "Scribe", description: "Summarises documents", capabilities: ["summarize", "translate"] };

test("parseDecision: JSON anywhere, yes/no fallback", () => {
  assert.deepEqual(parseDecision('Sure! {"match": true, "pitch": "I can do it."}'), { match: true, pitch: "I can do it." });
  assert.deepEqual(parseDecision('{"match":"no","pitch":"x"}'), { match: false, pitch: "x" });
  assert.deepEqual(parseDecision('{"match": true, "output": "haiku here"}'), { match: true, pitch: "haiku here" });
  assert.deepEqual(parseDecision("YES\nBecause I summarise."), { match: true, pitch: "Because I summarise." });
  assert.equal(parseDecision("No, not my area.").match, false);
  assert.equal(parseDecision("").match, false);
});

test("bountyTick: claims a match, declines a non-match, never re-evaluates, honours the 10 min cap, skips own/expired", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "watch.json");
  let nowMs = 10_000_000;
  const claims = [];
  const asked = [];
  const bounties = [
    { id: 1, title: "Summarise PDFs", brief: "ten pdfs", rewardWei: "2000000000000000000", tags: ["summarize"], deadline: null, poster: { address: OTHER }, claimCount: 0 },
    { id: 2, title: "Train a model", brief: "gpu work", rewardWei: "5", tags: [], deadline: null, poster: { address: OTHER }, claimCount: 0 },
    { id: 3, title: "Own bounty", brief: "mine", rewardWei: "1", tags: [], deadline: null, poster: { address: OWN }, claimCount: 0 },
    { id: 4, title: "Expired", brief: "late", rewardWei: "1", tags: [], deadline: 9_000, poster: { address: OTHER }, claimCount: 0 },
    { id: 5, title: "Translate", brief: "fr→en", rewardWei: "1", tags: ["translate"], deadline: null, poster: { address: OTHER }, claimCount: 0 },
  ];
  const fmx = {
    address: OWN,
    bounties: { list: async () => ({ items: bounties }), claim: async (c) => { claims.push(c); return { id: 99 }; } },
    arena: { challenges: async () => ({ items: [] }), submit: async () => ({}) },
    presence: { ping: async () => ({}) },
  };
  const handler = async (input) => {
    const user = input.messages[1].content;
    asked.push(Number(user.match(/Bounty #(\d+)/)[1]));
    assert.match(input.messages[0].content, /Capabilities: summarize, translate/);
    const match = /Summarise|Translate/.test(user);
    return { ok: true, output: JSON.stringify({ match, pitch: match ? `I will do: ${user.split("\n")[0]}` : "" }) };
  };
  const opts = { fmx, handler, profile, statePath, log, now: () => nowMs };

  // pass 1: #1 matches → claimed; the cap stops the pass before #2 is even asked
  let r = await bountyTick(opts);
  assert.deepEqual(r, { considered: 1, claimed: 1, declined: [] });
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0], { bountyId: 1, agentId: 7, pitch: "I will do: Bounty #1: Summarise PDFs" });
  assert.deepEqual(asked, [1]);
  let st = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(st.bounties["1"].decision, "claimed");
  assert.equal(st.lastClaimAt, nowMs);

  // pass 2 within 10 min: cap holds, nothing asked
  nowMs += 5 * 60_000;
  r = await bountyTick(opts);
  assert.deepEqual(r, { considered: 0, claimed: null, declined: [] });
  assert.deepEqual(asked, [1]);

  // pass 3 after 10 min: #2 declined (persisted), #3 own + #4 expired skipped, #5 claimed
  nowMs += 5 * 60_000 + 1;
  r = await bountyTick(opts);
  assert.deepEqual(r, { considered: 2, claimed: 5, declined: [2] });
  assert.deepEqual(asked, [1, 2, 5]);
  assert.equal(claims.length, 2);
  st = loadWatchState(statePath);
  assert.equal(st.bounties["2"].decision, "declined");
  assert.equal(st.bounties["3"], undefined);
  assert.equal(st.bounties["5"].decision, "claimed");

  // pass 4 much later: nothing new — #1/#2/#5 remembered, #3/#4 skipped
  nowMs += 60 * 60_000;
  r = await bountyTick(opts);
  assert.deepEqual(r, { considered: 0, claimed: null, declined: [] });
  assert.equal(claims.length, 2);

  // a failing claim is recorded as failed and not retried
  bounties.push({ id: 6, title: "Summarise again", brief: "x", rewardWei: "1", tags: [], deadline: null, poster: { address: OTHER }, claimCount: 0 });
  fmx.bounties.claim = async () => { throw new Error("409 not open"); };
  r = await bountyTick(opts);
  assert.deepEqual(r, { considered: 1, claimed: null, declined: [] });
  assert.equal(loadWatchState(statePath).bounties["6"].decision, "failed");
  nowMs += 60 * 60_000;
  r = await bountyTick(opts);
  assert.equal(r.considered, 0);

  // a model error is transient: not persisted, retried next pass
  bounties.push({ id: 7, title: "Summarise once more", brief: "x", rewardWei: "1", tags: [], deadline: null, poster: { address: OTHER }, claimCount: 0 });
  const flaky = { ...opts, handler: async () => { throw new Error("upstream 500"); } };
  r = await bountyTick(flaky);
  assert.deepEqual(r, { considered: 1, claimed: null, declined: [] });
  assert.equal(loadWatchState(statePath).bounties["7"], undefined);
});

test("arenaTick: submits the generated output as a payload (max 1 / hour), declines non-matches", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "watch.json");
  let nowMs = 50_000_000;
  const submitted = [];
  const challenges = [
    { id: 1, title: "Best haiku", brief: "haiku about escrow", rules: "17 syllables", prizeWei: "1000000000000000000", endsAt: 60_000, creator: { address: OTHER }, submissionCount: 0 },
    { id: 2, title: "Chess engine", brief: "write one", rules: "", prizeWei: "0", endsAt: 60_000, creator: { address: OTHER }, submissionCount: 0 },
    { id: 3, title: "Second haiku", brief: "haiku about bonds", rules: "", prizeWei: "0", endsAt: 60_000, creator: { address: OTHER }, submissionCount: 0 },
    { id: 4, title: "Ended", brief: "x", rules: "", prizeWei: "0", endsAt: 49_000, creator: { address: OTHER }, submissionCount: 0 },
  ];
  const fmx = {
    address: OWN,
    bounties: { list: async () => ({ items: [] }), claim: async () => ({}) },
    arena: { challenges: async () => ({ items: challenges }), submit: async (s) => { submitted.push(s); return { id: 1 }; } },
    presence: { ping: async () => ({}) },
  };
  const handler = async (input) => {
    const user = input.messages[1].content;
    assert.match(input.messages[0].content, /arena challenge/);
    const match = /haiku/i.test(user);
    return { ok: true, output: match ? '{"match": true, "output": "escrow holds the coin\\nseven seconds pass\\npayment flows"}' : '{"match": false}' };
  };
  const opts = { fmx, handler, profile, statePath, log, now: () => nowMs };
  let r = await arenaTick(opts);
  assert.deepEqual(r, { considered: 1, submitted: 1, declined: [] });
  assert.equal(submitted[0].challengeId, 1);
  assert.equal(submitted[0].agentId, 7);
  assert.match(submitted[0].content, /escrow holds the coin/);
  assert.match(submitted[0].note, /Scribe \(agent #7\)/);
  nowMs += 30 * 60_000;
  r = await arenaTick(opts);
  assert.deepEqual(r, { considered: 0, submitted: null, declined: [] }); // 1 / hour cap
  nowMs += 30 * 60_000 + 1;
  r = await arenaTick(opts);
  assert.deepEqual(r, { considered: 2, submitted: 3, declined: [2] });
  assert.equal(submitted.length, 2);
  const st = loadWatchState(statePath);
  assert.equal(st.challenges["4"], undefined); // ended: skipped, never evaluated
  assert.equal(st.challenges["2"].decision, "declined");
});

test("startWatchers: presence pings immediately and on the interval; bounty loop runs when enabled; stop clears timers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pings = [];
  let lists = 0;
  const fmx = {
    address: OWN,
    bounties: { list: async () => { lists++; return { items: [] }; }, claim: async () => ({}) },
    arena: { challenges: async () => ({ items: [] }), submit: async () => ({}) },
    presence: { ping: async (s) => { pings.push(s); return {}; } },
  };
  const stop = startWatchers({
    fmx, handler: async () => ({ ok: true, output: "no" }), profile, statePath: join(dir, "w.json"), log,
    presence: true, bounties: true, arena: false, status: () => "serving", intervals: { presenceMs: 30, bountyMs: 30 },
  });
  await new Promise((r) => setTimeout(r, 80));
  stop();
  const pAfter = pings.length;
  const lAfter = lists;
  assert.ok(pAfter >= 2 && pAfter <= 4, `pings=${pAfter}`);
  assert.deepEqual(pings[0], "serving");
  assert.ok(lAfter >= 2, `lists=${lAfter}`);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(pings.length, pAfter); // stopped
  assert.equal(lists, lAfter);
});

test("webhook receiver guards: HMAC constant-time verify, ±10 min replay window, ids single-use, constant-time secret compare", async () => {
  const { verifyWebhookSignature, acceptDelivery, secretEquals } = await import("../dist/watch.js");
  const { createHmac } = await import("node:crypto");
  const secret = "0123456789abcdef";
  const body = JSON.stringify({ id: "job.requested:0xabc:1", event: "job.requested", ts: 1000, webhookId: 1, data: { jobId: 5 } });
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyWebhookSignature(secret, body, good), true);
  assert.equal(verifyWebhookSignature(secret, body, good.slice("sha256=".length)), true); // bare hex accepted
  assert.equal(verifyWebhookSignature(secret, body + " ", good), false);
  assert.equal(verifyWebhookSignature(secret, body, "sha256=zz"), false);
  assert.equal(verifyWebhookSignature(secret, body, undefined), false);
  assert.equal(acceptDelivery({ id: "d1", ts: 1000 }, 1000), true);
  assert.equal(acceptDelivery({ id: "d1", ts: 1000 }, 1001), false); // replay of the same id
  assert.equal(acceptDelivery({ id: "d2", ts: 1000 }, 1000 + 601), false); // too old
  assert.equal(acceptDelivery({ id: "d3", ts: 1000 + 601 }, 1000), false); // from the future
  assert.equal(acceptDelivery({ ts: 1000 }, 1000), false); // no id
  assert.equal(acceptDelivery({ id: "d4", ts: 1000 + 30 }, 1000), true);
  assert.equal(secretEquals("abc", "abc"), true);
  assert.equal(secretEquals("abd", "abc"), false);
  assert.equal(secretEquals(undefined, "abc"), false);
  assert.equal(secretEquals(["abc"], "abc"), false);
});
