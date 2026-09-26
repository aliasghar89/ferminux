// The send gate on the Bridge panel.
//
// The panel used to check only caps, balance and recipient. The bridge could be
// paused on-chain, or its validators could have stopped signing, and the DEX
// would still take the deposit: locked on the source chain, nothing arriving.
// This pins the rule that closes the gate, using the bridge app's real
// liveness parser and verdict so the two apps cannot disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeGate } from '../src/lib/bridgeGate.ts';
import { BRIDGE_TAB_ENABLED, RELAYER_STATUS_URL } from '../src/lib/bridgeChains.ts';
import { assessLiveness, livenessForChain, parseRelayerStatus } from '../../../bridge/ui/src/lib/liveness.ts';

const NOW_MS = 1_790_271_901_631;

/** Shape of ferminux.net/bridge/status.json as captured on 2026-09-24. */
function report({ ferminuxPaused, reason = null, checkpointState = 'ok' }) {
  return parseRelayerStatus({
    generatedAt: NOW_MS,
    chains: [
      {
        name: 'ferminux',
        chainId: 3961,
        confirmations: 64,
        finality: {
          mode: 'work-and-time',
          pace: { state: 'ok', targetBlockTimeMs: 7000, medianGapMs: 7000, samples: 32, headNumber: 396827, headAgeMs: 6173, reason: null },
          checkpoint:
            checkpointState === 'ok'
              ? { state: 'ok', number: 396700, hash: '0xabc', attestedAt: NOW_MS - 60_000, ageMs: 60_000, maxAgeMs: 21_600_000, lagBlocks: 127, hashVerified: true, reason: null }
              : { state: checkpointState, number: null, hash: null, attestedAt: null, ageMs: null, maxAgeMs: 21_600_000, lagBlocks: null, hashVerified: false, reason: 'registry chain bsc: only 0 healthy endpoint(s), 2 required' },
          signing: { paused: ferminuxPaused, reason },
        },
      },
      { name: 'bsc', chainId: 56, confirmations: 20, finality: { mode: 'count', pace: null, checkpoint: null, signing: { paused: false, reason: null } } },
    ],
  });
}

function gateFor(status, chainId, name, extra = {}) {
  const srcVerdict = status ? assessLiveness(livenessForChain(status, chainId), name, NOW_MS / 1000) : null;
  return bridgeGate({
    srcName: name,
    bridgePaused: false,
    tokenPaused: false,
    reportUsable: status !== null,
    reportError: null,
    srcVerdict,
    ...extra,
  });
}

test('flag: the Bridge tab is OFF unless the build opts in', () => {
  assert.equal(BRIDGE_TAB_ENABLED, false);
});

test('flag: the status report URL is absolute, so dex.ferminux.net does not read its own index.html', () => {
  assert.match(RELAYER_STATUS_URL, /^https:\/\/ferminux\.net\/bridge\/status\.json$/);
});

test('closed: the report of 2026-09-24 (Ferminux checkpoint unreadable, signing paused)', () => {
  const s = report({ ferminuxPaused: true, reason: 'Checkpoint unreadable', checkpointState: 'unreadable' });
  const g = gateFor(s, 3961, 'Ferminux');
  assert.equal(g.open, false);
  assert.match(g.reason, /paused/i);
});

test('open: the return leg from BSC in that same report is signing', () => {
  const s = report({ ferminuxPaused: true, reason: 'Checkpoint unreadable', checkpointState: 'unreadable' });
  const g = gateFor(s, 56, 'BSC');
  assert.equal(g.open, true);
  assert.equal(g.reason, null);
});

test('open: a healthy report with nothing paused', () => {
  const g = gateFor(report({ ferminuxPaused: false }), 3961, 'Ferminux');
  assert.deepEqual(g, { open: true, reason: null, note: null });
});

test('closed: no report at all (network error, CORS, stale) — fail closed, say why', () => {
  const g = bridgeGate({
    srcName: 'Ferminux',
    bridgePaused: false,
    tokenPaused: false,
    reportUsable: false,
    reportError: 'the status report is stale',
    srcVerdict: null,
  });
  assert.equal(g.open, false);
  assert.match(g.reason, /stale/);
});

test('closed: a report that says nothing about the source chain', () => {
  const s = parseRelayerStatus({ generatedAt: NOW_MS, chains: [] });
  const g = gateFor(s, 3961, 'Ferminux');
  assert.equal(g.open, false);
  assert.match(g.reason, /no signing verdict/);
});

test('closed: the bridge contract is paused, even when validators are signing', () => {
  const g = gateFor(report({ ferminuxPaused: false }), 3961, 'Ferminux', { bridgePaused: true });
  assert.equal(g.open, false);
  assert.match(g.reason, /bridge contract on Ferminux is paused/);
});

test('closed: the token rail is paused, even when validators are signing', () => {
  const g = gateFor(report({ ferminuxPaused: false }), 3961, 'Ferminux', { tokenPaused: true });
  assert.equal(g.open, false);
  assert.match(g.reason, /route is paused/);
});

test('not yet read: unknown pause flags do not open the gate on their own', () => {
  const g = bridgeGate({
    srcName: 'Ferminux',
    bridgePaused: null,
    tokenPaused: null,
    reportUsable: false,
    reportError: null,
    srcVerdict: null,
  });
  assert.equal(g.open, false);
});
