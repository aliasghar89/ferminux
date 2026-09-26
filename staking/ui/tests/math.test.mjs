// APY / reward / runway / countdown math — anchored to the worked numbers in
// staking/DESIGN.md so the UI can never drift from the approved economics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BPS,
  BASE_UNIT_APR_BPS,
  SECONDS_PER_YEAR,
  weightedUnits,
  perUnitAprBps,
  effectiveAprBps,
  annualOutlayWei,
  runwaySeconds,
  depletionDateMs,
  projectedRewardsWei,
  poolCoversProjection,
  countdown,
  secondsUntilBlock,
  maxStakeableWei,
  STAKE_GAS_LIMIT,
} from '../src/lib/math.ts';

const FMX = 10n ** 18n;
const DRIP = 1_200_000n * FMX; // 1.2M FMX/yr drip cap (DESIGN §1)

/* ---------------- weighted units ---------------- */

test('math: weighted units are amount × weight', () => {
  assert.equal(weightedUnits(100n * FMX, 10_000n), 100n * FMX); // 1.0×
  assert.equal(weightedUnits(100n * FMX, 15_000n), 150n * FMX); // 1.5×
  assert.equal(weightedUnits(100n * FMX, 30_000n), 300n * FMX); // 3.0×
  assert.equal(weightedUnits(0n, 30_000n), 0n);
  assert.throws(() => weightedUnits(-1n, 10_000n), /negative/);
});

/* ---------------- effective APY ---------------- */

test('math: below 12M weighted units every tier pays its cap', () => {
  // 12M units is where the 1.2M/yr drip cap starts binding (drip ÷ 10%).
  const units = 8_250_000n * FMX;
  assert.equal(perUnitAprBps(units, DRIP), BASE_UNIT_APR_BPS);
  assert.equal(effectiveAprBps(10_000n, units, DRIP), 1_000n); // flexible 10%
  assert.equal(effectiveAprBps(15_000n, units, DRIP), 1_500n); // 90d 15%
  assert.equal(effectiveAprBps(20_000n, units, DRIP), 2_000n); // 180d 20%
  assert.equal(effectiveAprBps(30_000n, units, DRIP), 3_000n); // validator 30%
});

test('math: DESIGN §7.2 — at 15M units the drip cap scales flexible to 8%, validator to 24%', () => {
  const units = 15_000_000n * FMX;
  assert.equal(effectiveAprBps(10_000n, units, DRIP), 800n);
  assert.equal(effectiveAprBps(30_000n, units, DRIP), 2_400n);
});

test('math: with nothing staked the cap rate is shown (no dilution yet)', () => {
  assert.equal(perUnitAprBps(0n, DRIP), BASE_UNIT_APR_BPS);
  assert.equal(effectiveAprBps(30_000n, 0n, DRIP), 3_000n);
});

/* ---------------- outlay + runway (DESIGN §1 runway table) ---------------- */

test('math: DESIGN §1 target scenario — 5M staked mix → 825k/yr outlay, 21.8 months on 1.5M', () => {
  // 2M flex ×1.0 + 1.5M ×1.5 + 0.5M ×2.0 + 1M validator ×3.0 = 8.25M units
  const units =
    weightedUnits(2_000_000n * FMX, 10_000n) +
    weightedUnits(1_500_000n * FMX, 15_000n) +
    weightedUnits(500_000n * FMX, 20_000n) +
    weightedUnits(1_000_000n * FMX, 30_000n);
  assert.equal(units, 8_250_000n * FMX);
  assert.equal(annualOutlayWei(units, DRIP), 825_000n * FMX);

  const pool = 1_500_000n * FMX;
  const runway = runwaySeconds(pool, units, DRIP);
  const months = Number(runway) / 2_629_800;
  assert.ok(Math.abs(months - 21.8) < 0.05, `runway ${months} months ≈ 21.8`);
});

test('math: DESIGN §1 hot scenario — drip cap binds → 15.0-month hard floor', () => {
  const units = 14_000_000n * FMX; // ≥12M weighted units
  assert.equal(annualOutlayWei(units, DRIP), DRIP);
  const runway = runwaySeconds(1_500_000n * FMX, units, DRIP);
  const months = Number(runway) / 2_629_800;
  assert.ok(Math.abs(months - 15.0) < 0.05, `runway ${months} months ≈ 15.0`);
});

test('math: no stake → no outlay → indefinite runway (null), and depletion passes null through', () => {
  assert.equal(annualOutlayWei(0n, DRIP), 0n);
  assert.equal(runwaySeconds(1_500_000n * FMX, 0n, DRIP), null);
  assert.equal(depletionDateMs(Date.now(), null), null);
});

test('math: depletion date is now + runway', () => {
  const now = 1_700_000_000_000;
  assert.equal(depletionDateMs(now, 86_400n), now + 86_400_000);
});

/* ---------------- projections (DESIGN §7.2 worked earnings) ---------------- */

test('math: DESIGN §7.2 — 10,000 FMX at Locked-180 (20%) earns 2,000 FMX/yr', () => {
  assert.equal(projectedRewardsWei(10_000n * FMX, 2_000n, SECONDS_PER_YEAR), 2_000n * FMX);
});

test('math: DESIGN §7.2 — 25,000 FMX validator bond at 30% earns 7,500 FMX/yr', () => {
  assert.equal(projectedRewardsWei(25_000n * FMX, 3_000n, SECONDS_PER_YEAR), 7_500n * FMX);
});

test('math: projections scale linearly with time and never round up', () => {
  const year = projectedRewardsWei(10_000n * FMX, 1_000n, SECONDS_PER_YEAR);
  const half = projectedRewardsWei(10_000n * FMX, 1_000n, SECONDS_PER_YEAR / 2n);
  assert.equal(half * 2n, year);
  // 1 wei for 1 second at 10% must floor to zero, not invent a wei.
  assert.equal(projectedRewardsWei(1n, 1_000n, 1n), 0n);
  assert.throws(() => projectedRewardsWei(1n, 1_000n, -1n), /negative/);
});

test('math: poolCoversProjection is honest about a thin pool', () => {
  const lock = 180n * 86_400n;
  // Big pool, small stake → covered.
  assert.equal(poolCoversProjection(1_500_000n * FMX, 1_000_000n * FMX, DRIP, lock), true);
  // Pool that cannot fund the lock period at current outlay → not covered.
  const units = 14_000_000n * FMX; // drip cap binds: 1.2M/yr outlay
  const thinPool = 100_000n * FMX; // ~1 month of runway
  assert.equal(poolCoversProjection(thinPool, units, DRIP, lock), false);
  // Empty pool never covers anything.
  assert.equal(poolCoversProjection(0n, 0n, DRIP, 0n), false);
});

/* ---------------- countdowns ---------------- */

test('math: countdown decomposes remaining time', () => {
  const c = countdown(1_000, 1_000 + 2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
  assert.deepEqual(c, { done: false, totalSeconds: 183_845, days: 2, hours: 3, minutes: 4, seconds: 5 });
});

test('math: countdown clamps at zero once the target has passed', () => {
  const c = countdown(5_000, 4_000);
  assert.equal(c.done, true);
  assert.equal(c.totalSeconds, 0);
});

test('math: secondsUntilBlock uses the 7.2s target cadence', () => {
  assert.equal(secondsUntilBlock(11_800, 4_500_000, 7.2), (4_500_000 - 11_800) * 7.2);
  assert.equal(secondsUntilBlock(5_000_000, 4_500_000, 7.2), 0);
});

/* ---------------- MAX button fee headroom ---------------- */

test('math: maxStakeableWei reserves stake-gas headroom and never goes negative', () => {
  const fee = 2n * 10n ** 9n; // 2 gwei
  const headroom = STAKE_GAS_LIMIT * fee;
  assert.equal(maxStakeableWei(FMX, fee), FMX - headroom);
  assert.equal(maxStakeableWei(headroom, fee), 0n);
  assert.equal(maxStakeableWei(0n, fee), 0n);
});

/* ---------------- constants sanity ---------------- */

test('math: constants match the design', () => {
  assert.equal(BPS, 10_000n);
  assert.equal(BASE_UNIT_APR_BPS, 1_000n); // weight × 10%/yr = tier cap
  assert.equal(SECONDS_PER_YEAR, 31_536_000n);
});
