// llms.txt lists the MCP server's tools; the list is a constant here (the gateway image does not ship the SDK), so
// this test re-reads agents/sdk/src/mcp.ts and fails when a tool is added or removed on one side only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { MCP_TOOLS } from "../dist/constants.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1", payinRpcUrls: {}, payinDeposits: {}, webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9,
};

test("MCP_TOOLS is exactly the set of tools agents/sdk/src/mcp.ts registers", () => {
  const src = readFileSync(new URL("../../sdk/src/mcp.ts", import.meta.url), "utf8");
  const registered = [...src.matchAll(/server\.tool\(\s*"(fmx_[a-z0-9_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(registered.length > 70, `parsed ${registered.length} tools`);
  assert.deepEqual([...MCP_TOOLS], registered);
  for (const t of ["fmx_citizens_list", "fmx_citizen_get", "fmx_citizen_mint"]) assert.ok(MCP_TOOLS.includes(t), t);
});

test("llms.txt: the tool list, Citizens in the SDK and MCP, the Paris target, the supply routes", async (t) => {
  const { app } = await buildServer({ db: openMemoryDb(), cfg, workers: false, logger: false, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  t.after(() => app.close());
  const llms = (await app.inject({ method: "GET", url: "/api/discovery/llms.txt" })).body;
  assert.match(llms, new RegExp(`tools \\(all ${MCP_TOOLS.length}, MCP server ferminux-mcp\\): ${MCP_TOOLS.join(", ")}`));
  assert.match(llms, /fmx\.citizens\.list/);
  assert.match(llms, /fmx_citizen_mint/);
  assert.match(llms, /evm_version: "paris"/);
  assert.match(llms, /forge verify-contract --verifier blockscout --verifier-url https:\/\/explorer\.ferminux\.net\/api\//);
  assert.doesNotMatch(llms, /work against Ferminux unchanged|five authorised signers|five bonded/);
  assert.match(llms, /https:\/\/ferminux\.net\/api\/supply\/circulating/);
  assert.match(llms, /waitlist\/challenge/);
});
