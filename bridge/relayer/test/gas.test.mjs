// Fee planning and retry escalation.
//
// Two things must hold at once: a retry has to be expensive enough that the
// mempool accepts it as a replacement, and no retry may ever exceed the operator's
// absolute ceiling. Those pull in opposite directions, which is why this has tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GWEI, isValidReplacement, planFees, planGasLimit } from '../src/gas.ts';
import { DEFAULT_GAS } from '../src/config.ts';

/** Minimal JsonRpcProvider stand-in: a fixed base fee and tip. */
function stubProvider(baseFeeGwei, tipGwei) {
  return {
    async getBlock() {
      return { baseFeePerGas: BigInt(baseFeeGwei) * GWEI };
    },
    async send(method) {
      if (method === 'eth_maxPriorityFeePerGas') return `0x${(BigInt(tipGwei) * GWEI).toString(16)}`;
      throw new Error(`unexpected ${method}`);
    },
  };
}

const gas = { ...DEFAULT_GAS, maxFeePerGasGwei: 200, priorityFeeGwei: 1, baseFeeMultiplier: 2, escalationPct: 25 };

test('first attempt is baseFee * multiplier + tip', async () => {
  const plan = await planFees(stubProvider(10, 2), gas, 0);
  assert.equal(plan.type, 2);
  assert.equal(plan.maxFeePerGas, 22n * GWEI, '10 * 2 + 2');
  assert.equal(plan.maxPriorityFeePerGas, 2n * GWEI);
  assert.equal(plan.atCeiling, false);
});

test('the node tip wins when it is above the configured floor, and vice versa', async () => {
  const high = await planFees(stubProvider(10, 5), gas, 0);
  assert.equal(high.maxPriorityFeePerGas, 5n * GWEI, 'node suggested more than the floor');
  const low = await planFees(stubProvider(10, 0), gas, 0);
  assert.equal(low.maxPriorityFeePerGas, 1n * GWEI, 'floor applies when the node suggests nothing');
});

test('each attempt escalates by the configured percentage, compounding', async () => {
  const provider = stubProvider(10, 2);
  const a0 = await planFees(provider, gas, 0);
  const a1 = await planFees(provider, gas, 1);
  const a2 = await planFees(provider, gas, 2);
  assert.equal(a1.maxFeePerGas, (a0.maxFeePerGas * 125n) / 100n);
  assert.equal(a2.maxFeePerGas, (a1.maxFeePerGas * 125n) / 100n);
  assert.ok(a1.maxPriorityFeePerGas > a0.maxPriorityFeePerGas, 'the tip escalates too');
});

test('every escalation is a valid mempool replacement of the one before', async () => {
  const provider = stubProvider(10, 2);
  let previous = await planFees(provider, gas, 0);
  for (let attempt = 1; attempt < gas.maxAttempts; attempt++) {
    const next = await planFees(provider, gas, attempt);
    assert.ok(isValidReplacement(previous, next), `attempt ${attempt} beats attempt ${attempt - 1} by >= 10%`);
    previous = next;
  }
});

test('the ceiling clamps and reports itself so the caller stops escalating', async () => {
  const plan = await planFees(stubProvider(500, 5), gas, 3);
  assert.equal(plan.maxFeePerGas, 200n * GWEI, 'clamped to maxFeePerGasGwei');
  assert.equal(plan.atCeiling, true);
  assert.ok(plan.maxPriorityFeePerGas <= plan.maxFeePerGas, 'the tip can never exceed the max fee');
});

test('a legacy chain gets gasPrice instead of the 1559 pair', async () => {
  const legacy = { ...gas, txType: 0 };
  const plan = await planFees(stubProvider(10, 2), legacy, 0);
  assert.equal(plan.type, 0);
  assert.equal(plan.gasPrice, 12n * GWEI, 'base + tip');
  const escalated = await planFees(stubProvider(10, 2), legacy, 1);
  assert.equal(escalated.gasPrice, 15n * GWEI);
  assert.ok(isValidReplacement(plan, escalated));
});

test('gas limit gets head-room but never exceeds the cap', () => {
  assert.equal(planGasLimit(100_000n, { ...gas, gasLimitMultiplier: 1.3, gasLimitCap: 1_000_000 }), 130_000n);
  assert.equal(planGasLimit(900_000n, { ...gas, gasLimitMultiplier: 1.3, gasLimitCap: 1_000_000 }), 1_000_000n);
});

test('a missing base fee falls back instead of throwing', async () => {
  const noBaseFee = {
    async getBlock() {
      return { baseFeePerGas: null };
    },
    async send() {
      throw new Error('not supported');
    },
  };
  const plan = await planFees(noBaseFee, gas, 0);
  assert.equal(plan.baseFee, null);
  assert.ok(plan.maxFeePerGas > 0n, 'still produces a usable plan');
});
