// The hand-written human-readable ABIs in src/lib/abi.ts against the compiled
// staking/contracts/abi/*.json (`forge inspect <Name> abi --json`; the e2e
// re-checks those files against a fresh `forge build`). A fragment whose types
// differ from the compiled one has a different selector, so the call reverts on
// chain while the app still type-checks — this is the test that catches it.
// Compared by selector (functions), output types, and topic + indexing (events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { FMX_STAKING_ABI, NODE_REGISTRY_ABI } from '../src/lib/abi.ts';

const PAIRS = [
  ['FMX_STAKING_ABI', FMX_STAKING_ABI, 'FMXStaking'],
  ['NODE_REGISTRY_ABI', NODE_REGISTRY_ABI, 'NodeRegistry'],
];

for (const [name, fragments, contract] of PAIRS) {
  test(`abi: ${name} matches staking/contracts/abi/${contract}.json`, () => {
    const compiled = JSON.parse(
      readFileSync(new URL(`../../contracts/abi/${contract}.json`, import.meta.url), 'utf8'),
    );
    const real = new Interface(compiled);
    const ours = new Interface(fragments);
    let functions = 0;
    ours.forEachFunction((f) => {
      functions += 1;
      const sig = f.format('sighash');
      const r = real.getFunction(sig);
      assert.ok(r, `${contract} has no function ${sig}`);
      assert.equal(
        f.outputs.map((o) => o.format('sighash')).join(','),
        r.outputs.map((o) => o.format('sighash')).join(','),
        `${sig} outputs`,
      );
      assert.equal(f.payable, r.payable, `${sig} payability`);
    });
    assert.ok(functions > 0, `${name} lists no functions`);
    ours.forEachEvent((e) => {
      const sig = e.format('sighash');
      const r = real.getEvent(sig);
      assert.ok(r, `${contract} has no event ${sig}`);
      assert.deepEqual(
        e.inputs.map((i) => !!i.indexed),
        r.inputs.map((i) => !!i.indexed),
        `${sig} indexed params`,
      );
    });
  });
}
