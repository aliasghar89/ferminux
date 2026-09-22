// `serve --auto-claim`: the merged GET /api/work watcher — capability query,
// local pre-filter, bounty claims, arena entries, jobs left to the serve loop,
// the 10-min claim interval, the per-day cap, persistence across a restart,
// and --dry-run writing nothing at all.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoClaimTick, buildCapabilityQuery, matchesProfile, ACTIONABLE_KINDS } from "../dist/autoclaim.js";
import { loadWatchState } from "../dist/watch.js";

const log = { info() {}, warn() {}, error() {} };
const profile = { agentId: 7, name: () => "Scribe", description: "Summarises documents", capabilities: ["summarize", "translate"] };

function item(over) {
  return {
    kind: "bounty",
    refId: 1,
    title: "",
    summary: "",
    tags: [],
    rewardWei: "1000000000000000000",
    rewardFmx: "1",
    postedAt: 1_000,
    deadline: null,
    agentId: null,
    claims: 0,
    url: "https://ferminux.net/bounties/?id=1",
    api: "/api/bounties/1",
    action: "POST /api/bounties/1/claims {agentId, pitch}",
    ...over,
    id: over.id ?? `${over.kind ?? "bounty"}:${over.refId ?? 1}`,
  };
}

/** A handler that says yes to anything mentioning summarise/translate and writes a pitch. */
function modelHandler(seen) {
  return async (input) => {
    const user = input.messages[1].content;
    assert.match(input.messages[0].content, /Capabilities: summarize, translate/);
    seen?.push(user.split("\n")[0]);
    const match = /summari[sz]e|translate/i.test(user);
    return { ok: true, output: JSON.stringify({ match, pitch: match ? `I will do: ${user.split("\n")[0]}` : "" }) };
  };
}

test("buildCapabilityQuery / matchesProfile", () => {
  assert.equal(buildCapabilityQuery(["summarize", " translate "], "Summarises  documents"), "summarize translate Summarises documents");
  assert.equal(buildCapabilityQuery([], "Does things"), "Does things");
  assert.equal(buildCapabilityQuery([], ""), "");
  assert.equal(buildCapabilityQuery(["a".repeat(300)], "x").length, 200);

  const caps = ["summarize", "translate"];
  assert.equal(matchesProfile({ title: "Translate the docs", summary: "", tags: [] }, caps), true);
  assert.equal(matchesProfile({ title: "x", summary: "y", tags: ["summarize"] }, caps), true);
  assert.equal(matchesProfile({ title: "Train a model", summary: "gpu", tags: [] }, caps), false);
  assert.equal(matchesProfile({ title: "Train a model", summary: "gpu", tags: [] }, []), true); // no capabilities listed -> take everything
  assert.deepEqual([...ACTIONABLE_KINDS], ["job", "bounty", "arena"]);
});

test("autoClaimTick: claims bounties, queues own jobs, enters the arena, honours both caps, remembers across restarts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-autoclaim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "watch.json");
  let nowMs = 10_000_000;

  const claims = [];
  const submissions = [];
  const queries = [];
  const items = [
    item({ kind: "job", refId: 5, agentId: 7, title: "Summarize this deck", rewardFmx: "3" }),
    item({ kind: "job", refId: 9, agentId: 99, title: "Summarize someone else's deck" }),
    item({ kind: "question", refId: 2, title: "How do I translate a PDF?" }),
    item({ kind: "bounty", refId: 14, title: "Translate, but expired", deadline: 9_000 }),
    item({ kind: "bounty", refId: 12, title: "Translate the az docs", tags: ["translate", "az"], rewardWei: "2500000000000000000", rewardFmx: "2.5" }),
    item({ kind: "bounty", refId: 13, title: "Train a GPU model", tags: ["gpu"] }),
    item({ kind: "arena", refId: 3, title: "Summarize the whitepaper", rewardFmx: "10" }),
  ];

  const fmx = {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    bounties: { list: async () => ({ items: [] }), claim: async (c) => { claims.push(c); return { id: 1 }; } },
    arena: { challenges: async () => ({ items: [] }), submit: async (s) => { submissions.push(s); return { id: 1 }; } },
    presence: { ping: async () => ({}) },
  };
  const work = {
    list: async (q) => {
      queries.push(q);
      return { items, total: items.length, counts: {}, now: Math.floor(nowMs / 1000) };
    },
  };
  const asked = [];
  const opts = { fmx, work, handler: modelHandler(asked), profile, statePath, log, now: () => nowMs };

  // pass 1 — job #5 queued (never claimed), bounty #12 claimed, then the
  // 10-min interval ends the pass before the arena challenge is even asked.
  let r = await autoClaimTick(opts);
  assert.deepEqual(r.queued, [5]);
  assert.deepEqual(r.claimed, [12]);
  assert.deepEqual(r.submitted, []);
  assert.equal(r.considered, 1);
  assert.equal(r.skipped, 4); // job #9, the question, the expired bounty, the off-profile one
  assert.equal(r.capped, true);
  assert.deepEqual(claims, [{ bountyId: 12, agentId: 7, pitch: "I will do: Bounty #12: Translate the az docs" }]);
  assert.deepEqual(asked, ["Bounty #12: Translate the az docs"]); // the off-profile bounty never cost a model call

  // the capability query is built from AGENT_CAPABILITIES + AGENT_DESCRIPTION
  assert.deepEqual(queries[0], {
    capability: "summarize translate Summarises documents",
    minReward: undefined,
    kind: "job,bounty,arena",
    agentId: 7,
    limit: 50,
  });

  let st = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(st.work["job:5"].decision, "queued");
  assert.equal(st.work["bounty:12"].decision, "claimed");
  assert.equal(st.bounties["12"].decision, "claimed"); // mirrored, so the bounty watcher never re-claims it
  assert.deepEqual(st.autoClaims, [nowMs]);
  assert.equal(st.lastClaimAt, nowMs);

  // pass 2, immediately: everything already decided, nothing asked, nothing claimed
  r = await autoClaimTick(opts);
  assert.deepEqual(r, { considered: 0, claimed: [], submitted: [], queued: [], declined: [], wouldClaim: [], skipped: 6, capped: true });
  assert.equal(claims.length, 1);

  // pass 3, after the interval: the arena challenge is entered
  nowMs += 10 * 60_000 + 1;
  r = await autoClaimTick(opts);
  assert.deepEqual(r.submitted, [3]);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].challengeId, 3);
  assert.equal(submissions[0].agentId, 7);
  assert.match(submissions[0].note, /Scribe \(agent #7\)/);
  st = loadWatchState(statePath);
  assert.equal(st.work["arena:3"].decision, "submitted");
  assert.equal(st.challenges["3"].decision, "submitted");
  assert.equal(st.autoClaims.length, 2);

  // pass 4, a restart much later: state on disk means nothing is claimed twice
  nowMs += 6 * 60 * 60_000;
  r = await autoClaimTick({ ...opts, statePath });
  assert.equal(r.claimed.length, 0);
  assert.equal(r.submitted.length, 0);
  assert.equal(r.considered, 0);
  assert.equal(claims.length, 1);
  assert.equal(submissions.length, 1);

  // a model that says no is recorded as declined and never asked again
  items.push(item({ kind: "bounty", refId: 20, title: "Translate into Klingon" }));
  const noHandler = async () => ({ ok: true, output: '{"match": false}' });
  r = await autoClaimTick({ ...opts, handler: noHandler });
  assert.deepEqual(r.declined, ["bounty:20"]);
  assert.equal(loadWatchState(statePath).work["bounty:20"].decision, "declined");
  nowMs += 60 * 60_000;
  r = await autoClaimTick(opts);
  assert.equal(r.considered, 0);

  // a failing claim is recorded as failed, not retried
  items.push(item({ kind: "bounty", refId: 21, title: "Translate the FAQ" }));
  r = await autoClaimTick({ ...opts, fmx: { ...fmx, bounties: { ...fmx.bounties, claim: async () => { throw new Error("409 not open"); } } } });
  assert.deepEqual(r.claimed, []);
  assert.equal(loadWatchState(statePath).work["bounty:21"].decision, "failed");

  // a model error is transient: nothing persisted, retried next pass
  items.push(item({ kind: "bounty", refId: 22, title: "Translate the changelog" }));
  nowMs += 60 * 60_000;
  r = await autoClaimTick({ ...opts, handler: async () => { throw new Error("upstream 500"); } });
  assert.equal(r.considered, 1);
  assert.equal(loadWatchState(statePath).work["bounty:22"], undefined);
});

test("autoClaimTick: the per-day cap stops the pass and survives a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-autoclaim-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "watch.json");
  let nowMs = 100_000_000;
  const claims = [];
  const items = Array.from({ length: 5 }, (_, i) => item({ kind: "bounty", refId: 30 + i, title: `Translate document ${i}` }));
  const fmx = {
    bounties: { list: async () => ({ items: [] }), claim: async (c) => { claims.push(c); return { id: 1 }; } },
    arena: { challenges: async () => ({ items: [] }), submit: async () => ({}) },
    presence: { ping: async () => ({}) },
  };
  const work = { list: async () => ({ items, total: items.length, counts: {}, now: 0 }) };
  const opts = { fmx, work, handler: modelHandler(), profile, statePath, log, now: () => nowMs, claimIntervalMs: 0, maxPerDay: 2 };

  let r = await autoClaimTick(opts);
  assert.deepEqual(r.claimed, [30, 31]);
  assert.equal(r.capped, true);
  assert.equal(claims.length, 2);

  // still capped an hour later, and still capped after a restart (the timestamps are on disk)
  nowMs += 60 * 60_000;
  r = await autoClaimTick(opts);
  assert.deepEqual(r.claimed, []);
  assert.equal(r.capped, true);
  assert.deepEqual(loadWatchState(statePath).autoClaims.length, 2);

  // the window is a rolling 24 h: once the first two age out, claiming resumes
  nowMs += 24 * 60 * 60_000;
  r = await autoClaimTick(opts);
  assert.deepEqual(r.claimed, [32, 33]);
  assert.equal(claims.length, 4);
});

test("autoClaimTick --dry-run: logs the exact claim and writes nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fmx-autoclaim-dry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "watch.json");
  const claims = [];
  const submissions = [];
  const logged = [];
  const items = [
    item({ kind: "job", refId: 5, agentId: 7, title: "Summarize this deck" }),
    item({ kind: "bounty", refId: 12, title: "Translate the az docs", rewardWei: "2500000000000000000", rewardFmx: "2.5" }),
    item({ kind: "arena", refId: 3, title: "Summarize the whitepaper", rewardFmx: "10" }),
    item({ kind: "bounty", refId: 13, title: "Train a GPU model" }),
  ];
  const fmx = {
    bounties: { list: async () => ({ items: [] }), claim: async (c) => { claims.push(c); return {}; } },
    arena: { challenges: async () => ({ items: [] }), submit: async (s) => { submissions.push(s); return {}; } },
    presence: { ping: async () => ({}) },
  };
  const work = { list: async () => ({ items, total: items.length, counts: {}, now: 0 }) };
  const dryLog = { info: (o, m) => logged.push([o, m]), warn() {}, error() {} };
  const opts = {
    fmx,
    work,
    handler: modelHandler(),
    profile,
    statePath,
    log: dryLog,
    now: () => 200_000_000,
    claimIntervalMs: 0,
    dryRun: true,
  };

  const r = await autoClaimTick(opts);
  assert.equal(claims.length, 0);
  assert.equal(submissions.length, 0);
  assert.equal(existsSync(statePath), false); // nothing on disk at all
  assert.deepEqual(r.queued, [5]);
  assert.deepEqual(
    r.wouldClaim.map((w) => ({ id: w.id, kind: w.kind, title: w.title, rewardFmx: w.rewardFmx })),
    [
      { id: "bounty:12", kind: "bounty", title: "Translate the az docs", rewardFmx: "2.5" },
      { id: "arena:3", kind: "arena", title: "Summarize the whitepaper", rewardFmx: "10" },
    ],
  );
  assert.match(r.wouldClaim[0].pitch, /I will do: Bounty #12/);

  // the pitch and the reward reach the log, not just the return value
  const preview = logged.find(([, msg]) => msg === "auto-claim dry run: would claim");
  assert.ok(preview);
  assert.equal(preview[0].id, "bounty:12");
  assert.match(preview[0].pitch, /I will do/);

  // a second dry pass is identical — nothing was remembered
  const again = await autoClaimTick(opts);
  assert.equal(again.wouldClaim.length, 2);

  // and the in-memory interval cap is applied exactly as a real run would
  const capped = await autoClaimTick({ ...opts, claimIntervalMs: 10 * 60_000 });
  assert.equal(capped.wouldClaim.length, 1);
  assert.equal(capped.capped, true);
});
