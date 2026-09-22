// fmx.work.list()/watch() against a tiny stub gateway: query encoding
// (minReward in FMX → wei, kind array → csv) and the SSE feed with resume.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Ferminux } from "../dist/index.js";

const ITEM = {
  kind: "bounty",
  id: "bounty:1",
  refId: 1,
  title: "Translate a glossary",
  summary: "400 terms.",
  tags: ["translate"],
  rewardWei: "5000000000000000000",
  rewardFmx: "5",
  postedAt: 1_758_400_000,
  deadline: null,
  agentId: null,
  claims: 0,
  requester: null,
  url: "https://ferminux.net/bounties/?id=1",
  api: "/api/bounties/1",
  action: "POST /api/bounties/1/claims {agentId, pitch}",
};

function stubGateway() {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push(url.pathname + url.search);
    if (url.pathname === "/api/work") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [ITEM], total: 1, counts: { job: 0, bounty: 1, arena: 0, question: 0, endpoint: 0 }, kinds: ["job", "bounty", "arena", "question", "endpoint"], now: 1_758_400_100, feed: "/api/work/feed" }));
      return;
    }
    if (url.pathname === "/api/work/feed") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`retry: 5000\n: hello\n\n`);
      res.write(`id: 12\nevent: work\ndata: ${JSON.stringify({ ...ITEM, activityId: 12 })}\n\n`);
      // leave the connection open; the client aborts it
      return;
    }
    res.writeHead(404).end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/api` })));
}

test("fmx.work.list encodes the query (FMX → wei, kind array → csv) and returns items", async (t) => {
  const stub = await stubGateway();
  t.after(() => stub.server.close());
  const fmx = new Ferminux({ gateway: stub.base });
  t.after(() => fmx.provider.destroy());

  const res = await fmx.work.list({ capability: "translate", minReward: 2.5, kind: ["bounty", "arena"], agentId: 7, sort: "reward", limit: 10 });
  assert.equal(res.total, 1);
  assert.equal(res.items[0].action, ITEM.action);
  assert.equal(res.counts.bounty, 1);

  const q = new URL(stub.seen[0], "http://x").searchParams;
  assert.equal(q.get("capability"), "translate");
  assert.equal(q.get("minReward"), "2500000000000000000");
  assert.equal(q.get("kind"), "bounty,arena");
  assert.equal(q.get("agentId"), "7");
  assert.equal(q.get("sort"), "reward");
  assert.equal(q.get("limit"), "10");

  const best = await fmx.work.best({ capability: "translate" });
  assert.equal(best.id, "bounty:1");
});

test("fmx.work.watch streams items from /api/work/feed and tracks the resume id", async (t) => {
  const stub = await stubGateway();
  t.after(() => stub.server.close());
  const fmx = new Ferminux({ gateway: stub.base });
  t.after(() => fmx.provider.destroy());

  const got = [];
  const stop = fmx.work.watch((item) => got.push(item), { capability: "translate", sinceId: 5, reconnect: false });
  t.after(() => stop());
  const deadline = Date.now() + 3000;
  while (!got.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  stop();

  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].kind, "bounty");
  assert.equal(got[0].activityId, 12);
  const feedReq = stub.seen.find((u) => u.startsWith("/api/work/feed"));
  const q = new URL(feedReq, "http://x").searchParams;
  assert.equal(q.get("sinceId"), "5");
  assert.equal(q.get("capability"), "translate");
});
