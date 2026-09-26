// The idle auto-lock rule (lib/idle.ts) and the cross-window lock signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleTracker } from '../src/lib/idle.ts';
import { parseLockSignal } from '../src/lib/lockSignal.ts';

const MIN = 60_000;

function rig(idleMs) {
  let t = 1_000_000;
  let locks = 0;
  const tracker = createIdleTracker(idleMs, () => (locks += 1), () => t);
  return { tracker, advance: (ms) => (t += ms), locks: () => locks };
}

test('idle: activity inside the window renews it; silence past it locks once', () => {
  const r = rig(MIN);
  r.advance(50_000);
  r.tracker.activity();
  r.advance(50_000);
  r.tracker.check();
  assert.equal(r.locks(), 0, 'renewed by the tap at 50 s');
  r.advance(10_001);
  r.tracker.check();
  r.tracker.check();
  assert.equal(r.locks(), 1, 'locks once');
});

test('idle: the first touch after timers were frozen locks instead of renewing', () => {
  // A backgrounded app or frozen tab ran no timer for two hours; the touch that
  // brings it back arrives before the overdue tick.
  const r = rig(MIN);
  r.advance(2 * 3600_000);
  r.tracker.activity();
  assert.equal(r.locks(), 1);
  r.advance(5_000);
  r.tracker.check();
  assert.equal(r.locks(), 1, 'no second lock, and the stale deadline was not renewed');
});

test('idle: coming back to the page judges the deadline at once', () => {
  const r = rig(MIN);
  r.advance(MIN - 1);
  r.tracker.check();
  assert.equal(r.locks(), 0);
  r.advance(1);
  r.tracker.check();
  assert.equal(r.locks(), 1);
});

test('lock signal: only the lock message is honoured', () => {
  assert.equal(parseLockSignal({ type: 'lock' }), 'lock');
  for (const junk of [null, undefined, 'lock', {}, { type: 'unlock' }, { type: ['lock'] }]) {
    assert.equal(parseLockSignal(junk), null);
  }
});
