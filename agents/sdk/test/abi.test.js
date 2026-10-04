// The hand-written human-readable ABIs in src/abi.ts against the compiled contracts/abi/*.json.
// A fragment whose types differ from the compiled one has a different selector, so the call
// reverts on chain while every stubbed-contract test still passes — this is the only place
// that catches it. Compared by selector (functions), topic + indexing (events) and output types.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import * as sdk from "../dist/index.js";

const PAIRS = {
  REGISTRY_ABI: "AgentRegistry",
  ESCROW_ABI: "ServiceEscrow",
  X402_VAULT_ABI: "X402Vault",
  AGENT_ACCOUNT_ABI: "AgentAccount",
  AGENT_ACCOUNT_FACTORY_ABI: "AgentAccountFactory",
  STREAM_PAY_ABI: "StreamPay",
  ARBITER_POOL_ABI: "ArbiterPool",
  IDENTITY_8004_ABI: "IdentityRegistry8004",
  REPUTATION_8004_ABI: "ReputationRegistry8004",
  VALIDATION_8004_ABI: "ValidationRegistry8004",
  AGENT_TOKEN_FACTORY_ABI: "AgentTokenFactory",
  AGENT_TOKEN_ABI: "AgentToken",
  NFT_ABI: "FerminuxAgents",
  CITIZENS_ABI: "FerminuxCitizens",
  MEMORY_ANCHOR_ABI: "MemoryAnchor",
  ENDORSEMENTS_ABI: "Endorsements",
};

for (const [name, contract] of Object.entries(PAIRS)) {
  test(`${name} matches contracts/abi/${contract}.json`, () => {
    let compiled = JSON.parse(readFileSync(new URL(`../../contracts/abi/${contract}.json`, import.meta.url), "utf8"));
    if (compiled.abi) compiled = compiled.abi;
    const real = new Interface(compiled);
    const ours = new Interface(sdk[name]);
    ours.forEachFunction((f) => {
      const sig = f.format("sighash");
      const r = real.getFunction(sig);
      assert.ok(r, `${contract} has no function ${sig}`);
      assert.equal(f.outputs.map((o) => o.format("sighash")).join(","), r.outputs.map((o) => o.format("sighash")).join(","), `${sig} outputs`);
    });
    ours.forEachEvent((e) => {
      const sig = e.format("sighash");
      const r = real.getEvent(sig);
      assert.ok(r, `${contract} has no event ${sig}`);
      assert.deepEqual(e.inputs.map((i) => !!i.indexed), r.inputs.map((i) => !!i.indexed), `${sig} indexed params`);
    });
  });
}
