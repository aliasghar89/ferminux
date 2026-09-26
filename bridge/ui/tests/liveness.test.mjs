// The liveness layer: block pace, DEGRADED, checkpoint lag — what replaces the
// fixed "Confirming n/64". Same module the UI renders from.
//
// The failure being fixed: during the 2026-08-21 stall the app sat on
// "Confirming 12/64" for hours. Every branch here is either "say plainly why it
// is paused, with the number" or "with no report, fall back to the count and
// never crash".
//
// The fixture is a capture of the relayer's real /status output (its suite
// asserts the key sets against the emitter). A second fixture below is the
// relayer's exact DEGRADED + checkpoint-mismatch report, which an earlier UI
// rendered as "Ferminux is healthy / Confirming 11/64" because it read fields
// the relayer never sent. That must never happen again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SLOW_PACE_FACTOR,
  STATUS_MAX_AGE_MS,
  assessLiveness,
  canSend,
  describeWait,
  isStatusFresh,
  liveSourceWaitSeconds,
  livenessForChain,
  parseRelayerStatus,
} from '../src/lib/liveness.ts';
import { chainByKey, RELAYER_STATUS_URL } from '../src/config.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/relayer-status.json', import.meta.url), 'utf8'));
const NOW_S = FIXTURE.generatedAt / 1000;

const clone = (x) => JSON.parse(JSON.stringify(x));

/** The relayer document with the ferminux `finality` block edited in place. */
function docWith(edit) {
  const doc = clone(FIXTURE);
  const fx = doc.chains.find((c) => c.chainId === 3961);
  edit(fx.finality, fx, doc);
  return doc;
}

function ferminux(edit = () => {}) {
  return livenessForChain(parseRelayerStatus(docWith(edit)), 3961);
}

/** What the relayer emits when the chain is stalled AND the checkpoint hash mismatches. */
const DEGRADED_AND_MISMATCH = docWith((f) => {
  f.pace = {
    ...f.pace,
    state: 'degraded',
    medianGapMs: 190_000,
    maxGapMs: 600_000,
    samples: 32,
    headAgeMs: 1_200_000,
    reason: 'median block gap 190s over the last 32 blocks is more than 4x the 7s target',
  };
  f.checkpoint = {
    ...f.checkpoint,
    state: 'mismatch',
    hashVerified: false,
    reason: 'registry attests 0x6f1a… at block 412000, this node sees 0xdead… — the chain has been rewritten across the checkpoint',
  };
  f.signing = { paused: true, reason: 'ferminux is producing blocks slowly; transfers are paused until it recovers (median block gap 190s…)' };
});

/* ----------------------------------------------------------------- parsing */

test('parse: the captured relayer document lands where the UI reads it', () => {
  const doc = parseRelayerStatus(FIXTURE);
  assert.ok(doc);
  assert.equal(doc.generatedAt, FIXTURE.generatedAt);
  const f = livenessForChain(doc, 3961);
  assert.equal(f.finalityMode, 'work', 'work-and-time maps to work');
  assert.equal(f.confirmations, 64);
  assert.equal(f.pace.state, 'ok');
  assert.equal(f.pace.medianGapSeconds, 8.5);
  assert.equal(f.pace.targetSeconds, 7);
  assert.equal(f.pace.sampleBlocks, 32);
  assert.equal(f.pace.headBlock, 412345);
  assert.equal(f.pace.headAgeSeconds, 10);
  assert.deepEqual(f.signing, { paused: false, reason: null });
  assert.equal(f.checkpoint.state, 'ok');
  assert.equal(f.checkpoint.blockNumber, 412000);
  assert.equal(f.checkpoint.lagBlocks, 345);
  assert.equal(f.checkpoint.attestedAt, 1755819000);
  assert.equal(f.checkpoint.ageSeconds, 1800);
  assert.equal(f.checkpoint.maxAgeSeconds, 21600);
  assert.equal(f.checkpoint.verified, true);
  assert.equal(f.checkpoint.stale, false);
  const bsc = livenessForChain(doc, 56);
  assert.equal(bsc.finalityMode, 'count');
  assert.equal(bsc.pace, null);
  assert.equal(bsc.checkpoint, null);
  assert.deepEqual(bsc.signing, { paused: false, reason: null });
});

test('parse: garbage never throws — it becomes "unknown"', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}, { chains: 'nope' }, { chains: [null, 1, { name: 'no id' }] }]) {
    const doc = parseRelayerStatus(raw);
    if (doc) assert.deepEqual(doc.chains, []);
    assert.equal(assessLiveness(livenessForChain(doc, 3961), 'Ferminux', NOW_S).state, 'unknown');
  }
});

test('parse: a chain without a finality block, or without a signing verdict, is UNKNOWN — never ok', () => {
  // The regression: an object with a chainId and nothing the UI understands used
  // to fall through to 'ok' and "Ferminux is healthy".
  for (const chain of [
    { chainId: 3961 },
    { chainId: 3961, finality: {} },
    { chainId: 3961, finality: { mode: 'work-and-time', pace: null, checkpoint: null } },
    { chainId: 3961, finality: { mode: 'work-and-time', signing: { paused: 'no' } } },
    { chainId: 3961, finalityMode: 'work', pace: { targetSeconds: 7, medianGapSeconds: 8 }, degraded: false },
  ]) {
    const live = livenessForChain(parseRelayerStatus({ generatedAt: FIXTURE.generatedAt, chains: [chain] }), 3961);
    assert.ok(live, 'the chain row is kept');
    assert.equal(live.signing, null);
    const v = assessLiveness(live, 'Ferminux', NOW_S);
    assert.equal(v.state, 'unknown', JSON.stringify(chain));
    assert.equal(v.paused, false);
    assert.equal(describeWait(live, v, 100, 110, 64, 7).kind, 'none', 'falls back to the plain count');
  }
});

test('parse: a pace with an unknown state or a zero target is dropped, not divided by', () => {
  assert.equal(ferminux((f) => (f.pace.targetBlockTimeMs = 0)).pace, null);
  assert.equal(ferminux((f) => (f.pace.state = 'vibes')).pace, null);
  assert.equal(ferminux((f) => (f.checkpoint.state = 'vibes')).checkpoint, null);
  // An unmeasured pace keeps its state and a null median.
  const un = ferminux((f) => Object.assign(f.pace, { state: 'unknown', medianGapMs: null, headAgeMs: null }));
  assert.equal(un.pace.state, 'unknown');
  assert.equal(un.pace.medianGapSeconds, null);
});

test('parse: generatedAt accepts seconds, milliseconds and ISO-8601', () => {
  assert.equal(parseRelayerStatus({ generatedAt: 1755820800, chains: [] }).generatedAt, 1755820800000);
  assert.equal(parseRelayerStatus({ generatedAt: 1755820800000, chains: [] }).generatedAt, 1755820800000);
  assert.equal(parseRelayerStatus({ generatedAt: '2025-08-22T00:00:00.000Z', chains: [] }).generatedAt, 1755820800000);
  assert.equal(parseRelayerStatus({ chains: [] }).generatedAt, null);
});

test('freshness: an old report is discarded, and so is one WITHOUT a timestamp', () => {
  const doc = parseRelayerStatus(FIXTURE);
  assert.equal(isStatusFresh(doc, FIXTURE.generatedAt + 1000), true);
  assert.equal(isStatusFresh(doc, FIXTURE.generatedAt + STATUS_MAX_AGE_MS + 1), false);
  assert.equal(isStatusFresh(parseRelayerStatus({ chains: [] }), Date.now()), false, 'a status.json a cron stopped rewriting is not trusted forever');
  assert.equal(isStatusFresh(null, Date.now()), false);
});

/* ---------------------------------------------------------------- verdicts */

test('verdict: no report at all is unknown and not paused — the old count still shows', () => {
  const v = assessLiveness(null, 'Ferminux', NOW_S);
  assert.equal(v.state, 'unknown');
  assert.equal(v.paused, false);
});

test('verdict: the captured chain is ok, with the measured pace in the text', () => {
  const v = assessLiveness(ferminux(), 'Ferminux', NOW_S);
  assert.equal(v.state, 'ok');
  assert.equal(v.paused, false);
  assert.equal(v.checkpointEnforced, true);
  assert.equal(v.checkpointMode, false);
  assert.match(v.paceText, /8\.5 s median between blocks vs 7 s target/);
});

test('verdict: the relayer DEGRADED + mismatch report is paused as a detected reorg, never "healthy"', () => {
  const live = livenessForChain(parseRelayerStatus(DEGRADED_AND_MISMATCH), 3961);
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.paused, true);
  assert.equal(v.state, 'checkpoint-mismatch', 'the reorg outranks the stall');
  assert.match(v.message, /detected reorg/);
  assert.doesNotMatch(v.message, /healthy/);
  const w = describeWait(live, v, 412334, 412345, 64, 7);
  assert.equal(w.kind, 'paused');
  assert.equal(w.label, 'Paused');
  assert.doesNotMatch(w.label, /\d+\/\d+/, 'never "Confirming 11/64"');
  assert.doesNotMatch(w.detail, /\d+\/\d+/);
});

test('verdict: pace DEGRADED pauses, with the plain sentence and the measured pace', () => {
  const live = ferminux((f) => {
    Object.assign(f.pace, { state: 'degraded', medianGapMs: 190_000, reason: 'median block gap 190s over the last 32 blocks is more than 4x the 7s target' });
    f.signing = { paused: true, reason: 'ferminux is producing blocks slowly' };
  });
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.state, 'degraded');
  assert.equal(v.paused, true);
  assert.match(v.message, /Ferminux is producing blocks slowly; transfers are paused until it recovers/);
  assert.match(v.message, /3\.2 min median/);
  assert.match(v.message, /4x the 7s target/);
  assert.doesNotMatch(v.message, /\d+\/\d+/, 'never "Confirming 12/64"');
});

test('verdict: a stalled head is DEGRADED with the head age spelled out', () => {
  const live = ferminux((f) => {
    Object.assign(f.pace, { state: 'degraded', medianGapMs: 7_000, headAgeMs: 900_000, reason: 'no block for 900s (head 412345); stall threshold is 300s' });
    f.signing = { paused: true, reason: 'stalled' };
  });
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.state, 'degraded');
  assert.match(v.message, /No block for 15 min/);
});

test('verdict: a pace the relayer could not measure is paused — fail closed, with the reason', () => {
  const live = ferminux((f) => {
    Object.assign(f.pace, { state: 'unknown', medianGapMs: null, headAgeMs: null, reason: 'only 1 endpoint(s) agree on block 412345, 2 required' });
    f.signing = { paused: true, reason: 'Pace of ferminux cannot be measured' };
  });
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.state, 'paused');
  assert.equal(v.paused, true);
  assert.match(v.message, /cannot measure the block pace/);
  assert.match(v.message, /2 required/);
  assert.equal(v.paceText, null);
});

test('verdict: a specific refusal pauses even if signing.paused were false — the safe reading wins', () => {
  const live = ferminux((f) => {
    Object.assign(f.pace, { state: 'degraded', medianGapMs: 100_000, reason: 'slow' });
    f.signing = { paused: false, reason: null };
  });
  assert.equal(assessLiveness(live, 'Ferminux', NOW_S).paused, true);
});

test('verdict: signing.paused alone, with no specific cause the UI knows, is still Paused with the relayer sentence', () => {
  const live = ferminux((f) => (f.signing = { paused: true, reason: 'operator hold' }));
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.state, 'paused');
  assert.equal(v.paused, true);
  assert.match(v.message, /operator hold/);
});

test('verdict: slow-but-signing is said, not hidden, and is not paused', () => {
  const live = ferminux((f) => (f.pace.medianGapMs = 7_000 * SLOW_PACE_FACTOR + 1));
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.state, 'slow');
  assert.equal(v.paused, false);
  assert.match(v.message, /slower than usual/);
  assert.equal(assessLiveness(ferminux((f) => (f.pace.medianGapMs = 7_000 * SLOW_PACE_FACTOR)), 'F', NOW_S).state, 'ok');
});

test('verdict: a missing checkpoint pauses in WORK mode too — the registry is enforced in every mode', () => {
  const live = ferminux((f) => {
    f.checkpoint = { ...f.checkpoint, state: 'missing', number: 0, hash: `0x${'00'.repeat(32)}`, attestedAt: 0, hashVerified: false, reason: 'the registry holds no checkpoint yet' };
    f.signing = { paused: true, reason: 'Checkpoint missing' };
  });
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(live.finalityMode, 'work');
  assert.equal(v.state, 'checkpoint-missing');
  assert.equal(v.paused, true);
  assert.equal(v.checkpointMode, false);
  assert.equal(v.checkpointEnforced, true);
});

test('verdict: a stale checkpoint pauses — by the relayer state, or by age against maxAgeMs', () => {
  assert.equal(assessLiveness(ferminux(), 'Ferminux', NOW_S).state, 'ok', 'fixture checkpoint is 30 min old, limit 6 h');
  const flagged = assessLiveness(
    ferminux((f) => {
      f.checkpoint.state = 'stale';
      f.checkpoint.ageMs = 7 * 3_600_000;
      f.signing = { paused: true, reason: 'Checkpoint stale' };
    }),
    'Ferminux',
    NOW_S,
  );
  assert.equal(flagged.state, 'checkpoint-stale');
  assert.equal(flagged.paused, true);
  assert.match(flagged.message, /7 h old/);
  assert.match(flagged.message, /limit 6 h/);
  // The relayer's own age wins; with none reported the UI ages it itself.
  const aged = assessLiveness(ferminux((f) => (f.checkpoint.ageMs = null)), 'Ferminux', 1755819000 + 21600 + 1);
  assert.equal(aged.state, 'checkpoint-stale');
});

test('verdict: an unreadable registry pauses with the relayer reason', () => {
  const live = ferminux((f) => {
    Object.assign(f.checkpoint, { state: 'unreadable', reason: 'registry chain bsc: only 1 healthy endpoint(s), 2 required' });
    f.signing = { paused: true, reason: 'Checkpoint unreadable' };
  });
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(v.state, 'paused');
  assert.equal(v.paused, true);
  assert.match(v.message, /cannot read the attested checkpoint/);
  assert.match(v.message, /2 required/);
});

test('verdict: a hash mismatch outranks a stalled pace', () => {
  const both = ferminux((f) => {
    Object.assign(f.pace, { state: 'degraded', medianGapMs: 100_000 });
    Object.assign(f.checkpoint, { state: 'mismatch', hashVerified: false });
    f.signing = { paused: true, reason: 'x' };
  });
  assert.equal(assessLiveness(both, 'Ferminux', NOW_S).state, 'checkpoint-mismatch');
});

test('verdict: checkpoint mode is recognised, and a count chain with no monitor is plain ok', () => {
  const cp = ferminux((f) => {
    f.mode = 'checkpoint';
    f.work = null;
  });
  const v = assessLiveness(cp, 'Ferminux', NOW_S);
  assert.equal(v.checkpointMode, true);
  assert.equal(v.state, 'ok');
  const bsc = livenessForChain(parseRelayerStatus(FIXTURE), 56);
  const b = assessLiveness(bsc, 'BSC', NOW_S);
  assert.equal(b.state, 'ok');
  assert.equal(b.paceText, null);
  assert.equal(b.checkpointEnforced, false);
});

/* -------------------------------------------------------- per-transfer wait */

test('wait: no report → kind none, so the card renders the plain count', () => {
  const w = describeWait(null, assessLiveness(null, 'Ferminux', NOW_S), 100, 110, 64, 7);
  assert.equal(w.kind, 'none');
});

test('wait: paused chains say Paused with the reason, never a count', () => {
  const live = ferminux((f) => {
    Object.assign(f.pace, { state: 'degraded', medianGapMs: 100_000 });
    f.signing = { paused: true, reason: 'slow' };
  });
  const w = describeWait(live, assessLiveness(live, 'Ferminux', NOW_S), 100, 112, 64, 7);
  assert.equal(w.kind, 'paused');
  assert.equal(w.label, 'Paused');
  assert.match(w.detail, /paused until it recovers/);
  assert.doesNotMatch(w.label, /\d+\/\d+/);
});

test('wait: work mode prices the remaining blocks at the MEASURED pace, not the nominal one', () => {
  const live = ferminux(); // 8.5 s measured vs 7 s nominal; checkpoint 412000
  const w = describeWait(live, assessLiveness(live, 'Ferminux', NOW_S), 411900, 411911, 64, 7);
  assert.equal(w.kind, 'work');
  assert.equal(w.label, 'Confirming 12/64');
  assert.equal(w.expectedSeconds, Math.round(52 * 8.5));
  assert.match(w.detail, /52 more blocks/);
  assert.match(w.detail, /measured pace of 8\.5 s per block/);
  assert.ok(w.progress > 0.18 && w.progress < 0.19);
});

test('wait: work mode at depth is Confirmed with zero left', () => {
  const live = ferminux();
  const w = describeWait(live, assessLiveness(live, 'Ferminux', NOW_S), 411900, 411963, 64, 7);
  assert.equal(w.label, 'Confirmed');
  assert.equal(w.expectedSeconds, 0);
  assert.equal(w.progress, 1);
});

test('wait: in WORK mode a deep transfer ABOVE the attested checkpoint is Awaiting checkpoint, not Confirmed', () => {
  const live = ferminux(); // checkpoint 412000, lag 345, head 412345
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  const w = describeWait(live, v, 412100, 412345, 64, 7);
  assert.equal(w.kind, 'checkpoint');
  assert.equal(w.label, 'Awaiting checkpoint');
  assert.equal(w.blocksAboveCheckpoint, 100);
  assert.match(w.detail, /100 blocks behind this transfer/);
  assert.match(w.detail, /345 behind the chain head/);
  assert.match(w.detail, /not for a block count/);
  assert.equal(w.expectedSeconds, null, 'operators publish on their own cadence — no fake number');
});

test('wait: checkpoint mode — above the checkpoint waits, at or below is Checkpointed', () => {
  const live = ferminux((f) => (f.mode = 'checkpoint'));
  const v = assessLiveness(live, 'Ferminux', NOW_S);
  assert.equal(describeWait(live, v, 412100, 412345, 64, 7).label, 'Awaiting checkpoint');
  const w = describeWait(live, v, 412000, 412345, 64, 7);
  assert.equal(w.label, 'Checkpointed');
  assert.equal(w.blocksAboveCheckpoint, 0);
  assert.equal(w.progress, 1);
});

test('wait: a transfer with no block number yet in checkpoint mode is not falsely Checkpointed', () => {
  const live = ferminux((f) => (f.mode = 'checkpoint'));
  const w = describeWait(live, assessLiveness(live, 'Ferminux', NOW_S), null, 412345, 64, 7);
  assert.equal(w.kind, 'checkpoint');
  assert.equal(w.label, 'Awaiting checkpoint');
  assert.equal(w.progress, 0);
});

test('wait: a count chain with no pace report prices the count at the nominal pace', () => {
  const bsc = livenessForChain(parseRelayerStatus(FIXTURE), 56);
  const w = describeWait(bsc, assessLiveness(bsc, 'BSC', NOW_S), 100, 110, 20, 3);
  assert.equal(w.kind, 'work');
  assert.equal(w.label, 'Confirming 11/20');
  assert.match(w.detail, /nominal pace of 3 s per block/);
  assert.equal(w.expectedSeconds, 27);
});

/* ------------------------------------------------------------ form estimate */

test('estimate: new-transfer source wait uses measured pace; paused → null; checkpoint → lag', () => {
  const fx = chainByKey('ferminux');
  const ok = ferminux();
  assert.equal(liveSourceWaitSeconds(ok, assessLiveness(ok, 'F', NOW_S), fx.confirmations, fx.blockSeconds), Math.round(64 * 8.5));
  const paused = ferminux((f) => (f.signing = { paused: true, reason: 'hold' }));
  assert.equal(liveSourceWaitSeconds(paused, assessLiveness(paused, 'F', NOW_S), 64, 7), null);
  const cp = ferminux((f) => (f.mode = 'checkpoint'));
  assert.equal(liveSourceWaitSeconds(cp, assessLiveness(cp, 'F', NOW_S), 64, 7), Math.round(345 * 8.5));
  assert.equal(liveSourceWaitSeconds(null, assessLiveness(null, 'F', NOW_S), 64, 7), 64 * 7, 'no report: nominal');
});

/* ------------------------------------------------------------------ config */

test('config: the status URL is relative by default, so the build guard has no new host to allow', () => {
  assert.ok(!/^https?:\/\//.test(RELAYER_STATUS_URL), RELAYER_STATUS_URL);
});

// ----------------------------------------------------------------- send gate
//
// The finding this closes (2026-09-24 audit): the form's submit button ignored
// the verdict it displayed. With validators refusing to sign, a user could
// still lock FMX or burn wFMX into a bridge that has no refund path.

const NOW_MS = FIXTURE.generatedAt;

test('gate: a fresh report with a healthy source chain lets the user send', () => {
  const g = canSend(parseRelayerStatus(FIXTURE), 3961, 'Ferminux', NOW_MS);
  assert.deepEqual(g, { ok: true, reason: null });
});

test('gate: no report, a stale report, or an unreported chain refuses — fail closed', () => {
  assert.equal(canSend(null, 3961, 'Ferminux', NOW_MS).ok, false);
  assert.match(canSend(null, 3961, 'Ferminux', NOW_MS).reason, /unavailable/);
  const stale = canSend(parseRelayerStatus(FIXTURE), 3961, 'Ferminux', NOW_MS + STATUS_MAX_AGE_MS + 1);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /out of date/);
  const other = canSend(parseRelayerStatus(FIXTURE), 137, 'Polygon', NOW_MS);
  assert.equal(other.ok, false, 'a chain the validators do not report on');
});

test('gate: any pause refuses, with the same sentence the health panel shows', () => {
  // The live 2026-09-24 state: checkpoint attested 320 h ago.
  const doc = docWith((f) => {
    f.checkpoint.state = 'stale';
    f.checkpoint.ageMs = 320 * 3_600_000;
    f.checkpoint.reason = 'checkpoint #232337 was attested 19157 min ago; max age is 360 min';
    f.signing = { paused: true, reason: 'Checkpoint stale: …' };
  });
  const g = canSend(parseRelayerStatus(doc), 3961, 'Ferminux', NOW_MS);
  assert.equal(g.ok, false);
  assert.match(g.reason, /stale/);
});

test('gate: a lagging scanner refuses even when the relayer still says "not paused"', () => {
  // The live 2026-09-24 BSC row: count mode, signing not paused, cursor 1.9M
  // blocks behind. An older relayer publishes scan without folding it in.
  const doc = clone(FIXTURE);
  const bsc = doc.chains.find((c) => c.chainId === 56);
  bsc.scan = { ...bsc.scan, lagging: true, lagBlocks: 1_935_979, reason: 'the bsc scanner has not completed a scan for 14400 min' };
  const status = parseRelayerStatus(doc);
  const verdict = assessLiveness(livenessForChain(status, 56), 'BSC', NOW_S);
  assert.equal(verdict.paused, true);
  assert.match(verdict.message, /not seeing new transfers from BSC/);
  assert.equal(canSend(status, 56, 'BSC', NOW_MS).ok, false);
  // Without the scan block (an older relayer) the chain is judged on signing alone.
  delete bsc.scan;
  assert.equal(canSend(parseRelayerStatus(doc), 56, 'BSC', NOW_MS).ok, true);
});
