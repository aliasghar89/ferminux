// The validator's rolling volume window.
//
// The maths must match FerminuxBridge._usage() exactly:
//     used_now = used − used × (now − updatedAt) / WINDOW
// If the off-chain fence drains faster than the on-chain one, the validator
// signs things the contract then rejects; if it drains slower, transfers stall
// for no reason. Both are bugs, so both are tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolumeLimiter, WINDOW_MS, decayedUsage, windowKey } from '../src/limits.ts';

/** In-memory Store stub — only the window methods are exercised here. */
function stubStore() {
  const windows = new Map();
  return {
    driver: 'journal',
    getWindow: (key) => windows.get(key) ?? null,
    putWindow: (w) => windows.set(w.key, { ...w }),
  };
}

test('decay is linear and reaches exactly zero at the window edge', () => {
  const used = 1000n;
  const t0 = 1_000_000;
  assert.equal(decayedUsage(used, t0, t0), 1000n, 'no time passed');
  assert.equal(decayedUsage(used, t0, t0 + WINDOW_MS / 2), 500n, 'half the window, half the usage');
  assert.equal(decayedUsage(used, t0, t0 + WINDOW_MS / 4), 750n, 'a quarter of the window');
  assert.equal(decayedUsage(used, t0, t0 + WINDOW_MS), 0n, 'exactly at the edge');
  assert.equal(decayedUsage(used, t0, t0 + WINDOW_MS * 10), 0n, 'long past the edge');
});

test('capacity never jumps — there is no boundary to sit on', () => {
  const t0 = 1_000_000;
  let previous = decayedUsage(1_000_000n, t0, t0);
  for (let i = 1; i <= 240; i++) {
    const now = t0 + (WINDOW_MS / 240) * i;
    const current = decayedUsage(1_000_000n, t0, now);
    const step = previous - current;
    assert.ok(step >= 0n, 'usage never increases with time');
    // Each 6-minute step releases the same ~0.42% of the bucket. A calendar-day
    // cap would release 100% in one step; this must never do that.
    assert.ok(step <= 1_000_000n / 200n, `step ${step} is a smooth drain, not a cliff`);
    previous = current;
  }
  assert.equal(previous, 0n);
});

test('tryConsume enforces the cap and persists what it consumed', () => {
  const store = stubStore();
  const limiter = new VolumeLimiter(store);
  const key = windowKey(3961, '0x0000000000000000000000000000000000000000', 'out');
  const now = 5_000_000;

  assert.equal(limiter.tryConsume(key, 100n, 60n, now).ok, true);
  assert.equal(limiter.usage(key, now), 60n);

  const over = limiter.tryConsume(key, 100n, 50n, now);
  assert.equal(over.ok, false);
  assert.match(over.reason, /24h volume cap exceeded/);
  assert.equal(limiter.usage(key, now), 60n, 'a refused consume must not consume');

  assert.equal(limiter.tryConsume(key, 100n, 40n, now).ok, true, 'exactly at the cap is allowed');
  assert.equal(limiter.usage(key, now), 100n);
});

test('an unconfigured cap refuses by default', () => {
  const limiter = new VolumeLimiter(stubStore());
  const result = limiter.tryConsume('k', 0n, 1n, 1000);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no cap configured/);
});

test('capacity comes back as the window drains', () => {
  const store = stubStore();
  const limiter = new VolumeLimiter(store);
  const t0 = 9_000_000;
  assert.equal(limiter.tryConsume('k', 100n, 100n, t0).ok, true);
  assert.equal(limiter.tryConsume('k', 100n, 1n, t0).ok, false, 'full bucket');
  assert.equal(limiter.tryConsume('k', 100n, 40n, t0 + WINDOW_MS / 2).ok, true, 'half drained after 12h');
  assert.equal(limiter.tryConsume('k', 100n, 1n, t0 + WINDOW_MS * 2).ok, true, 'fully drained after 48h');
});

test('release gives capacity back when a signature is abandoned', () => {
  const limiter = new VolumeLimiter(stubStore());
  const now = 1_000;
  limiter.tryConsume('k', 100n, 80n, now);
  limiter.release('k', 80n, now);
  assert.equal(limiter.usage('k', now), 0n);
  limiter.release('k', 999n, now);
  assert.equal(limiter.usage('k', now), 0n, 'release never goes negative');
});

test('outbound and inbound buckets are independent, per chain and per token', () => {
  const keys = new Set([
    windowKey(3961, '0xabc0000000000000000000000000000000000000', 'out'),
    windowKey(3961, '0xabc0000000000000000000000000000000000000', 'in'),
    windowKey(56, '0xabc0000000000000000000000000000000000000', 'out'),
    windowKey(3961, '0xdef0000000000000000000000000000000000000', 'out'),
  ]);
  assert.equal(keys.size, 4, 'no two of these may collide');
  assert.equal(
    windowKey(3961, '0xABC0000000000000000000000000000000000000', 'out'),
    windowKey(3961, '0xabc0000000000000000000000000000000000000', 'out'),
    'address case must not create a second bucket',
  );
});
