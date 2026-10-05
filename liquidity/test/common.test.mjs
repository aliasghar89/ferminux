// lib/common.mjs and the create-pool argument checks. No network: the bad-argument runs must stop before connect().
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bpsArg, sendStep } from "../lib/common.mjs";

const CREATE_POOL = fileURLToPath(new URL("../scripts/create-pool.mjs", import.meta.url));

test("sendStep reports a step as confirmed in its block", async (t) => {
  const out = [];
  t.mock.method(process.stdout, "write", (s) => { out.push(String(s)); return true; });
  t.mock.method(console, "log", (s) => { out.push(`${s}\n`); });
  const rc = await sendStep("approve wFMX", Promise.resolve({ wait: async () => ({ blockNumber: 42, gasUsed: 46000n, hash: "0xab" }) }));
  assert.equal(rc.blockNumber, 42);
  assert.equal(out.join(""), "  approve wFMX ... confirmed in block 42, gasUsed=46000, tx=0xab\n");
  // fork-rehearsal harvests its gas table from exactly this line
  const rehearsal = readFileSync(new URL("../scripts/fork-rehearsal.mjs", import.meta.url), "utf8");
  const harvest = new RegExp(/text\.matchAll\(\/(\^[^\n]+?)\/gm\)/.exec(rehearsal)[1], "gm");
  assert.deepEqual([...out.join("").matchAll(harvest)].map((m) => [m[1], m[2]]), [["approve wFMX", "46000"]]);
});

test("bpsArg: a whole number of basis points from 0 to 10000", () => {
  assert.equal(bpsArg("0", "slippage-bps"), 0n);
  assert.equal(bpsArg("50", "slippage-bps"), 50n);
  assert.equal(bpsArg("10000", "slippage-bps"), 10000n);
});

test("create-pool refuses a --slippage-bps that is not an integer 0..10000, before touching any RPC", () => {
  const base = ["--chain", "bsc", "--token", "0x" + "11".repeat(20), "--quote", "0x" + "22".repeat(20), "--quote-amount", "1", "--price", "1", "--rpc", "http://127.0.0.1:9"];
  for (const bad of ["0.5", "-50", "10001", "20000", "abc", "1e3"]) {
    const r = spawnSync(process.execPath, [CREATE_POOL, ...base, "--slippage-bps", bad], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 1, `${bad}: ${r.stderr || r.error}`);
    assert.match(r.stderr, /--slippage-bps must be a whole number of basis points from 0 to 10000/, bad);
    assert.doesNotMatch(r.stdout, /CREATE POOL/, `${bad}: stopped before connecting`);
  }
});
