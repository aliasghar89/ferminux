// Vault data-layer helpers that mirror FMXStaking.sol: the settled reward pool
// (_accrue's pool charge), the lock rule (_lockExpired), which positions stay
// listed, and the require-string → plain-words mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledRewardPool, isLocked, isVisiblePosition, humanizeTxError } from '../src/lib/staking.ts';

const FMX = 10n ** 18n;
const YEAR = 31_536_000n;
const DRIP = 1_200_000n * FMX;

/* ---------------- settled reward pool ---------------- */

test('staking: settled pool charges tier-cap accrual — 1,000 FMX at 1.0× for a year costs 100 FMX', () => {
  const s = { rewardPool: 150_000n * FMX, totalUnits: 1_000n * FMX * 10n, dripPerYear: DRIP, lastAccrual: 1_000n };
  assert.equal(settledRewardPool(s, 1_000n + YEAR), 149_900n * FMX);
});

test('staking: settled pool charges the drip cap once it binds (15M weighted FMX → 1.2M/yr, not 1.5M)', () => {
  const s = { rewardPool: 2_000_000n * FMX, totalUnits: 15_000_000n * FMX * 10n, dripPerYear: DRIP, lastAccrual: 0n };
  assert.equal(settledRewardPool(s, YEAR), 800_000n * FMX);
});

test('staking: settled pool is fail-closed — it stops at the floor, never below zero', () => {
  const s = { rewardPool: 100n * FMX, totalUnits: 15_000_000n * FMX * 10n, dripPerYear: DRIP, lastAccrual: 0n };
  const left = settledRewardPool(s, YEAR);
  assert.ok(left >= 0n && left < 10n ** 9n, `only rounding dust is left (${left} wei)`);
  // A further year changes nothing that is not already gone.
  assert.ok(settledRewardPool({ ...s, rewardPool: left }, 2n * YEAR) <= left);
});

test('staking: settled pool is the raw pool when nothing accrues', () => {
  const s = { rewardPool: 5n * FMX, totalUnits: 10n * FMX, dripPerYear: DRIP, lastAccrual: 500n };
  assert.equal(settledRewardPool(s, 500n), 5n * FMX); // same second
  assert.equal(settledRewardPool(s, 400n), 5n * FMX); // head older than the last accrual
  assert.equal(settledRewardPool({ ...s, totalUnits: 0n }, 10_000n), 5n * FMX); // nothing staked
  assert.equal(settledRewardPool({ ...s, rewardPool: 0n }, 10_000n), 0n); // empty pool
});

/* ---------------- locks ---------------- */

test('staking: a time lock ends at lockEnd exactly (block.timestamp >= lockEnd)', () => {
  const p = { unlockTime: 2_000, unlockBlock: 0 };
  assert.equal(isLocked(p, 1_999, 10), true);
  assert.equal(isLocked(p, 2_000, 10), false);
});

test('staking: the validator-track lock is a block height, and an unknown head counts as locked', () => {
  const p = { unlockTime: 0, unlockBlock: 4_680_000 };
  assert.equal(isLocked(p, 9_999_999_999, 4_679_999), true);
  assert.equal(isLocked(p, 0, 4_680_000), false);
  assert.equal(isLocked(p, 0, null), true);
});

test('staking: a flexible position is never locked', () => {
  assert.equal(isLocked({ unlockTime: 0, unlockBlock: 0 }, 0, null), false);
});

/* ---------------- visibility ---------------- */

test('staking: withdrawn positions stay listed while they still hold claimable rewards', () => {
  assert.equal(isVisiblePosition({ state: 'active', pendingRewardsWei: 0n }), true);
  assert.equal(isVisiblePosition({ state: 'cooling', pendingRewardsWei: 0n }), true);
  assert.equal(isVisiblePosition({ state: 'withdrawn', pendingRewardsWei: 1n }), true);
  assert.equal(isVisiblePosition({ state: 'withdrawn', pendingRewardsWei: 0n }), false);
});

/* ---------------- error mapping ---------------- */

test('staking: the contract require strings map to plain words', () => {
  const says = (reason) => humanizeTxError(new Error(`execution reverted: "${reason}"`));
  assert.match(says('STK: staker denied'), /premine deny list/);
  assert.match(says('STK: below validator minimum'), /minimum stake/);
  assert.match(says('STK: deposits paused'), /paused/);
  assert.match(says('STK: lock not expired'), /still locked/);
  assert.match(says('STK: cooldown not over'), /has not finished/);
  assert.match(says('STK: not in cooldown'), /Start the unstake first/);
  assert.match(says('STK: nothing to claim'), /No rewards/);
  assert.match(says('NR: not a validator-track position'), /validator-track/);
  assert.match(says('NR: position already bonds a node'), /already bonds a node/);
  assert.match(says('NR: invalid possession signature'), /node key/);
});

test('staking: a wallet rejection is not mistaken for the premine deny list', () => {
  assert.equal(
    humanizeTxError(new Error('MetaMask Tx Signature: User denied transaction signature.')),
    'Transaction rejected in the wallet.',
  );
});
