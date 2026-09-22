// Unit checks for the transfer status machine and the arrival estimate.
// Same module the UI renders from — no parallel implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStatus, estimateEtaSeconds, etaRemainingSeconds, isOverdue, statusFromRecord } from '../src/lib/status.ts';
import { RELAYER_CONFIRMATIONS, chainByKey, RELAY_OVERHEAD_SECONDS } from '../src/config.ts';

const base = {
  receiptStatus: null,
  receiptBlockNumber: null,
  srcBlockNumber: null,
  destinationProcessed: null,
  destinationKnown: true,
  requiredConfirmations: 12,
};

test('status: an unmined transaction is Pending', () => {
  const s = deriveStatus(base);
  assert.equal(s.phase, 'submitted');
  assert.equal(s.label, 'Pending');
  assert.equal(s.terminal, false);
  assert.ok(s.progress > 0 && s.progress < 0.2);
});

test('status: a mined transaction counts confirmations and reports n/N', () => {
  const s = deriveStatus({ ...base, receiptStatus: 1, receiptBlockNumber: 100, srcBlockNumber: 103 });
  assert.equal(s.phase, 'confirming');
  assert.equal(s.confirmations, 4, 'the including block counts as the first confirmation');
  assert.equal(s.required, 12);
  assert.equal(s.label, 'Confirming 4/12');
});

test('status: reaching the required depth moves to Executing', () => {
  const s = deriveStatus({
    ...base,
    receiptStatus: 1,
    receiptBlockNumber: 100,
    srcBlockNumber: 111,
    destinationProcessed: false,
  });
  assert.equal(s.phase, 'executing');
  assert.equal(s.confirmations, 12);
  assert.match(s.detail, /validators/i);
});

test('status: the destination bridge is authoritative for Complete', () => {
  const s = deriveStatus({
    ...base,
    receiptStatus: 1,
    receiptBlockNumber: 100,
    srcBlockNumber: 101,
    destinationProcessed: true,
  });
  assert.equal(s.phase, 'complete');
  assert.equal(s.terminal, true);
  assert.equal(s.progress, 1);
});

test('status: a reverted source transaction is terminal and says nothing was taken', () => {
  const s = deriveStatus({ ...base, receiptStatus: 0, receiptBlockNumber: 100, srcBlockNumber: 100 });
  assert.equal(s.phase, 'reverted');
  assert.equal(s.terminal, true);
  assert.match(s.detail, /nothing was locked or burned/i);
});

test('status: a confirmed transfer to an unconfigured destination is Unverifiable, not "pending forever"', () => {
  const s = deriveStatus({
    ...base,
    receiptStatus: 1,
    receiptBlockNumber: 100,
    srcBlockNumber: 200,
    destinationKnown: false,
  });
  assert.equal(s.phase, 'unverifiable');
  assert.equal(s.terminal, true);
  assert.match(s.detail, /cannot confirm delivery/i);
});

test('status: a destination RPC outage keeps the transfer in Executing, never Complete', () => {
  const s = deriveStatus({
    ...base,
    receiptStatus: 1,
    receiptBlockNumber: 100,
    srcBlockNumber: 200,
    destinationProcessed: null,
  });
  assert.equal(s.phase, 'executing');
  assert.equal(s.terminal, false);
});

test('status: progress only ever moves forward along the happy path', () => {
  const seq = [
    deriveStatus(base),
    deriveStatus({ ...base, receiptStatus: 1, receiptBlockNumber: 100, srcBlockNumber: 100 }),
    deriveStatus({ ...base, receiptStatus: 1, receiptBlockNumber: 100, srcBlockNumber: 106 }),
    deriveStatus({ ...base, receiptStatus: 1, receiptBlockNumber: 100, srcBlockNumber: 111, destinationProcessed: false }),
    deriveStatus({ ...base, receiptStatus: 1, receiptBlockNumber: 100, srcBlockNumber: 112, destinationProcessed: true }),
  ];
  const phases = seq.map((s) => s.phase);
  assert.deepEqual(phases, ['submitted', 'confirming', 'confirming', 'executing', 'complete']);
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i].progress > seq[i - 1].progress, `step ${i} must advance the bar`);
  }
});

test('status: requiredConfirmations is floored at 1 so a 0 config cannot divide by zero', () => {
  const s = deriveStatus({ ...base, receiptStatus: 1, receiptBlockNumber: 5, srcBlockNumber: 5, requiredConfirmations: 0 });
  assert.equal(s.required, 1);
  assert.ok(Number.isFinite(s.progress));
});

/* ------------------------------------------------- rehydration from storage */

function record(phase) {
  return {
    transferId: '0x' + '11'.repeat(32),
    srcChainKey: 'ferminux',
    dstChainKey: 'bsc',
    srcChainId: 3961,
    dstChainId: 56,
    srcBridge: '0x' + '22'.repeat(20),
    dstBridge: '0x' + '33'.repeat(20),
    srcToken: '0x0000000000000000000000000000000000000000',
    dstToken: '0x' + '44'.repeat(20),
    symbol: 'FMX',
    dstSymbol: 'wFMX',
    decimals: 18,
    sender: '0x' + '55'.repeat(20),
    recipient: '0x' + '66'.repeat(20),
    sentWei: '1000000000000000000',
    amountWei: '999000000000000000',
    feeWei: '1000000000000000',
    nonce: 1,
    txHash: '0x' + '77'.repeat(32),
    txBlockNumber: 10,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    phase,
  };
}

test('status: a reloaded page shows the persisted phase, not a fresher one', () => {
  for (const phase of ['submitted', 'confirming', 'executing', 'complete', 'reverted', 'unverifiable']) {
    const s = statusFromRecord(record(phase), 12);
    assert.equal(s.phase, phase, `phase ${phase} must survive a reload`);
  }
});

test('status: rehydrated terminal phases are marked terminal', () => {
  assert.equal(statusFromRecord(record('complete'), 12).terminal, true);
  assert.equal(statusFromRecord(record('reverted'), 12).terminal, true);
  assert.equal(statusFromRecord(record('unverifiable'), 12).terminal, true);
  assert.equal(statusFromRecord(record('executing'), 12).terminal, false);
});

/* ---------------------------------------------------------------- estimate */

test('eta: derived from source confirmations, relay overhead and destination blocks', () => {
  const ferminux = chainByKey('ferminux');
  const bsc = chainByKey('bsc');
  const eta = estimateEtaSeconds(ferminux, bsc);
  const expected = ferminux.confirmations * ferminux.blockSeconds + RELAY_OVERHEAD_SECONDS + bsc.blockSeconds * 2;
  assert.equal(eta, Math.round(expected));
  assert.ok(eta > 0);
});

test('eta: the source chain reorg budget dominates the estimate', () => {
  const ferminux = chainByKey('ferminux');
  const bsc = chainByKey('bsc');
  // Ferminux is Ethash PoW with no finality gadget and little hashrate, so it
  // carries the DEEPEST wait in the set (64 x 7s), not the shallowest. Bridging
  // out of Ferminux therefore takes materially longer than bridging into it,
  // and the estimate has to say so — this is the same number the relayer waits.
  assert.ok(
    estimateEtaSeconds(ferminux, bsc) > estimateEtaSeconds(bsc, ferminux),
    'leaving Ferminux is slower than arriving, because the source confirmations are what dominate',
  );
});

test('eta: every chain the UI offers uses the relayer confirmation depth, not a shallower guess', () => {
  for (const [key, expected] of Object.entries(RELAYER_CONFIRMATIONS)) {
    assert.equal(chainByKey(key).confirmations, expected, `${key} must match the relayer's reorg budget`);
  }
  // The specific regression: 12 confirmations on Ferminux told a user their
  // transfer had "enough confirmations" roughly six times sooner than any
  // validator would sign it.
  assert.equal(chainByKey('ferminux').confirmations, 64);
});

test('eta: the remaining estimate counts down and clamps at zero', () => {
  const r = record('executing');
  assert.equal(etaRemainingSeconds(r, 300, r.createdAt), 300);
  assert.equal(etaRemainingSeconds(r, 300, r.createdAt + 120_000), 180);
  assert.equal(etaRemainingSeconds(r, 300, r.createdAt + 900_000), 0);
});

test('overdue: only in-flight transfers can be overdue, and only well past the estimate', () => {
  const r = record('executing');
  assert.equal(isOverdue(r, 300, r.createdAt + 300_000), false, 'one estimate is not overdue');
  assert.equal(isOverdue(r, 300, r.createdAt + 1_500_000), true, 'five estimates is');
  assert.equal(isOverdue(record('complete'), 300, r.createdAt + 9_000_000), false);
  assert.equal(isOverdue(record('reverted'), 300, r.createdAt + 9_000_000), false);
});

test('eta: a live pace report re-prices the source wait at the measured gap; checkpoint mode uses the lag', () => {
  const ferminux = chainByKey('ferminux');
  const bsc = chainByKey('bsc');
  const nominal = estimateEtaSeconds(ferminux, bsc);
  const slow = { chainId: 3961, name: null, finalityMode: 'work', degraded: false, degradedReason: null, checkpoint: null,
    pace: { targetSeconds: 7, medianGapSeconds: 14, sampleBlocks: 32, headBlock: null, headTimestamp: null } };
  assert.equal(estimateEtaSeconds(ferminux, bsc, slow) - nominal, 64 * 7, 'twice the gap adds 64 x 7 s');
  const cp = { ...slow, finalityMode: 'checkpoint', checkpoint: { blockNumber: 100, blockHash: null, attestedAt: null, lagBlocks: 10, maxAgeSeconds: null, stale: false, verified: true } };
  assert.equal(estimateEtaSeconds(ferminux, bsc, cp), Math.round(10 * 14 + RELAY_OVERHEAD_SECONDS + bsc.blockSeconds * 2));
  assert.equal(estimateEtaSeconds(ferminux, bsc, null), nominal, 'no report: unchanged');
});
