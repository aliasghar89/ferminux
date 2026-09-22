import test from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler, usageSeverity, limitChangeSeverity, fmtAmount, EVENT_SEVERITY, EdgeTracker } from '../reconcile.mjs';

const FMX = 3961;
const BSC = 56;
const ID = (n) => '0x' + String(n).padStart(64, '0');

function mk(grace = 100) {
  return new Reconciler({ graceBlocks: grace });
}

test('graceBlocks must be a positive integer', () => {
  assert.throws(() => new Reconciler({ graceBlocks: 0 }), /positive integer/);
  assert.throws(() => new Reconciler({ graceBlocks: -1 }), /positive integer/);
  assert.throws(() => new Reconciler({ graceBlocks: 1.5 }), /positive integer/);
});

test('a Sent then a matching Executed reconciles cleanly', () => {
  const r = mk();
  r.recordSent({ transferId: ID(1), chainId: FMX, block: 10, amount: 100n, recipient: '0xr', sender: '0xs' });
  const f = r.recordExecuted({ transferId: ID(1), chainId: BSC, srcChainId: FMX, block: 5, amount: 100n, recipient: '0xr', srcHead: 10 });
  assert.equal(f.kind, 'matched');
  assert.equal(r.overdue(new Map([[FMX, 99999]])).length, 0, 'a matched transfer must never go overdue');
});

test('an Executed seen BEFORE its Sent is not an alarm — it is the normal case', () => {
  const r = mk(100);
  // Destination confirms first; the source Sent has not been scanned yet.
  const f = r.recordExecuted({ transferId: ID(2), chainId: BSC, srcChainId: FMX, block: 5, amount: 50n, recipient: '0xr', srcHead: 1000 });
  assert.equal(f, null, 'no verdict is possible yet');
  assert.equal(r.overdue(new Map([[FMX, 1000]])).length, 0, 'silent while the source has not advanced');
  assert.equal(r.overdue(new Map([[FMX, 1099]])).length, 0, 'still silent one block short of the grace window');

  // Then the Sent arrives, and the pending item resolves with no alarm ever fired.
  r.recordSent({ transferId: ID(2), chainId: FMX, block: 990, amount: 50n, recipient: '0xr', sender: '0xs' });
  assert.equal(r.overdue(new Map([[FMX, 99999]])).length, 0, 'a late Sent must clear the pending entry');
});

test('an Executed with no Sent after the grace window IS reported, exactly once', () => {
  const r = mk(100);
  r.recordExecuted({ transferId: ID(3), chainId: BSC, srcChainId: FMX, block: 5, amount: 777n, recipient: '0xthief', srcHead: 1000 });

  assert.equal(r.overdue(new Map([[FMX, 1099]])).length, 0);
  const found = r.overdue(new Map([[FMX, 1100]]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unmatched-execution');
  assert.equal(found[0].transferId, ID(3));
  assert.equal(found[0].recipient, '0xthief');

  assert.equal(r.overdue(new Map([[FMX, 2000]])).length, 0, 'must not re-report — a repeating alarm gets muted');
});

test('an unreachable source chain produces silence, never a false alarm', () => {
  const r = mk(10);
  r.recordExecuted({ transferId: ID(4), chainId: BSC, srcChainId: FMX, block: 5, amount: 1n, recipient: '0xr', srcHead: 100 });
  // Source head unknown: our own RPC is down, which says nothing about the transfer.
  assert.equal(r.overdue(new Map()).length, 0);
  assert.equal(r.overdue(new Map([[BSC, 99999]])).length, 0, 'only the SOURCE chain head decides');
  // Once the source is readable again and has advanced, the verdict lands.
  assert.equal(r.overdue(new Map([[FMX, 110]])).length, 1);
});

test('an amount that differs between Sent and Executed is caught immediately', () => {
  const r = mk();
  r.recordSent({ transferId: ID(5), chainId: FMX, block: 1, amount: 100n, recipient: '0xr', sender: '0xs' });
  const f = r.recordExecuted({ transferId: ID(5), chainId: BSC, srcChainId: FMX, block: 2, amount: 101n, recipient: '0xr', srcHead: 1 });
  assert.equal(f.kind, 'amount-mismatch');
  assert.equal(f.sentAmount, 100n);
  assert.equal(f.executedAmount, 101n);
});

test('state survives a JSON round trip, amounts included', () => {
  const r = mk(100);
  r.recordSent({ transferId: ID(6), chainId: FMX, block: 1, amount: 12345n, recipient: '0xr', sender: '0xs' });
  r.recordExecuted({ transferId: ID(7), chainId: BSC, srcChainId: FMX, block: 2, amount: 9n, recipient: '0xr', srcHead: 500 });

  const wire = JSON.parse(JSON.stringify(r.toJSON(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const back = Reconciler.fromJSON(wire, { graceBlocks: 100 });
  for (const m of [back.sent, back.pending]) {
    for (const [, v] of m) if (typeof v.amount === 'string') v.amount = BigInt(v.amount);
  }

  // The restored watcher must still match a later Executed against the stored Sent,
  // and must still be holding the pending one.
  const f = back.recordExecuted({ transferId: ID(6), chainId: BSC, srcChainId: FMX, block: 3, amount: 12345n, recipient: '0xr', srcHead: 1 });
  assert.equal(f.kind, 'matched', 'a restarted watcher must not lose the Sent side');
  assert.equal(back.overdue(new Map([[FMX, 600]])).length, 1, 'and must still be holding the unmatched one');
});

test('a restarted watcher does not re-alarm on something it already reported', () => {
  const r = mk(10);
  r.recordExecuted({ transferId: ID(8), chainId: BSC, srcChainId: FMX, block: 1, amount: 5n, recipient: '0xr', srcHead: 100 });
  assert.equal(r.overdue(new Map([[FMX, 200]])).length, 1);
  const wire = JSON.parse(JSON.stringify(r.toJSON(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const back = Reconciler.fromJSON(wire, { graceBlocks: 10 });
  assert.equal(back.overdue(new Map([[FMX, 300]])).length, 0, 'the report must survive a restart');
});

test('the matched set is bounded so a busy route cannot exhaust memory', () => {
  const r = new Reconciler({ graceBlocks: 10, retainMatched: 5 });
  for (let i = 0; i < 50; i++) {
    r.recordSent({ transferId: ID(100 + i), chainId: FMX, block: i, amount: 1n, recipient: '0xr', sender: '0xs' });
    r.recordExecuted({ transferId: ID(100 + i), chainId: BSC, srcChainId: FMX, block: i, amount: 1n, recipient: '0xr', srcHead: i });
  }
  assert.ok(r.matched.size <= 5, `matched grew to ${r.matched.size}`);
  assert.equal(r.sent.size, 0, 'matched Sents are released');
});

test('raising a cap is critical; lowering one is not', () => {
  assert.equal(limitChangeSeverity({ oldMax: 100n, oldDaily: 500n, newMax: 200n, newDaily: 500n }), 'critical');
  assert.equal(limitChangeSeverity({ oldMax: 100n, oldDaily: 500n, newMax: 100n, newDaily: 600n }), 'critical');
  assert.equal(limitChangeSeverity({ oldMax: 100n, oldDaily: 500n, newMax: 50n, newDaily: 250n }), 'warn');
  assert.equal(limitChangeSeverity({ oldMax: 100n, oldDaily: 500n, newMax: 100n, newDaily: 500n }), 'warn');
  assert.equal(limitChangeSeverity({ oldMax: null, oldDaily: null, newMax: 1n, newDaily: 2n }), 'alert');
});

test('cap pressure escalates at 70% and 90%, and a zero cap never divides', () => {
  assert.equal(usageSeverity(0n, 100n), null);
  assert.equal(usageSeverity(69n, 100n), null);
  assert.equal(usageSeverity(70n, 100n).severity, 'warn');
  assert.equal(usageSeverity(89n, 100n).severity, 'warn');
  assert.equal(usageSeverity(90n, 100n).severity, 'alert');
  assert.equal(usageSeverity(100n, 100n).severity, 'alert');
  assert.equal(usageSeverity(5n, 0n), null, 'a zero cap must not divide by zero');
});

test('every event that widens the blast radius is at least alert', () => {
  const widening = [
    'Unpaused', 'TokenUnpaused', 'PauserSet', 'ValidatorAdded', 'ValidatorRemoved',
    'ThresholdChanged', 'OwnershipTransferStarted', 'OwnershipTransferred',
    'BridgeTokenCodehashChanged', 'RemoteBridgeChanged', 'TimelockDelayChanged',
    'ShortDeliveryAllowed', 'WrapperBridgeRotationProposed', 'WrapperAdopted',
    'ActionQueued', 'Rescued', 'FeeCollectorChanged',
  ];
  for (const e of widening) {
    assert.ok(EVENT_SEVERITY[e], `${e} has no severity assigned`);
    assert.ok(
      ['alert', 'critical'].includes(EVENT_SEVERITY[e]),
      `${e} is ${EVENT_SEVERITY[e]}, but it widens the blast radius and must wake someone`
    );
  }
});

test('amounts render readably at 18 decimals', () => {
  assert.equal(fmtAmount(10n ** 18n), '1');
  assert.equal(fmtAmount(1500n * 10n ** 15n), '1.5');
  assert.equal(fmtAmount(1234567n * 10n ** 18n), '1,234,567');
  assert.equal(fmtAmount(0n), '0');
  assert.equal(fmtAmount(1n), '0.000000000000000001');
  assert.equal(fmtAmount(100n * 10n ** 6n, 6), '100');
});

test('two chains reconcile independently and do not cross-talk', () => {
  const r = mk(10);
  // Same nonce space, different chains: these must never be confused for each other.
  r.recordSent({ transferId: ID(20), chainId: FMX, block: 1, amount: 1n, recipient: '0xr', sender: '0xs' });
  r.recordExecuted({ transferId: ID(21), chainId: FMX, srcChainId: BSC, block: 1, amount: 1n, recipient: '0xr', srcHead: 100 });

  // The BSC-sourced execution is unmatched and should alarm on BSC's head, not FMX's.
  assert.equal(r.overdue(new Map([[FMX, 99999]])).length, 0, 'the wrong chain head must not trigger it');
  assert.equal(r.overdue(new Map([[BSC, 110]])).length, 1);
});

test('EdgeTracker: a level that stays the same is reported once, not every poll', () => {
  const e = new EdgeTracker();
  assert.deepEqual(e.transition('k', 'warn'), { kind: 'raise', from: null, to: 'warn' });
  assert.equal(e.transition('k', 'warn'), null);
  assert.equal(e.transition('k', 'warn'), null);
});

test('EdgeTracker: escalation, de-escalation and clear are each one event', () => {
  const e = new EdgeTracker();
  e.transition('k', 'warn');
  assert.deepEqual(e.transition('k', 'alert'), { kind: 'change', from: 'warn', to: 'alert' });
  assert.equal(e.transition('k', 'alert'), null);
  assert.deepEqual(e.transition('k', 'warn'), { kind: 'change', from: 'alert', to: 'warn' });
  assert.deepEqual(e.transition('k', null), { kind: 'clear', from: 'warn', to: null });
  assert.equal(e.transition('k', null), null, 'clearing twice says nothing the second time');
  assert.deepEqual(e.transition('k', 'warn'), { kind: 'raise', from: null, to: 'warn' }, 'can raise again after a clear');
});

test('EdgeTracker: keys are independent and a never-raised key clears silently', () => {
  const e = new EdgeTracker();
  assert.equal(e.transition('never', null), null);
  e.transition('a', 'warn');
  assert.deepEqual(e.transition('b', 'alert'), { kind: 'raise', from: null, to: 'alert' });
  assert.equal(e.transition('a', 'warn'), null);
  assert.equal(e.levels.size, 2);
});

test('EdgeTracker composes with usageSeverity across the 70/90 bands', () => {
  const e = new EdgeTracker();
  const cap = 500n * 10n ** 18n;
  const at = (pct) => e.transition('cap', usageSeverity((cap * BigInt(pct)) / 100n, cap)?.severity ?? null);
  assert.equal(at(50), null);
  assert.equal(at(82)?.kind, 'raise');
  assert.equal(at(82), null);
  assert.equal(at(81), null);
  assert.equal(at(95)?.kind, 'change');
  assert.equal(at(60)?.kind, 'clear');
});
