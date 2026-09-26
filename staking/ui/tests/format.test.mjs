// Display formatting — numbers, durations, ages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFMX,
  formatBps,
  formatWeight,
  formatDuration,
  formatCountdown,
  formatMonths,
  formatAgo,
  shortAddress,
} from '../src/lib/format.ts';
import { countdown } from '../src/lib/math.ts';

const FMX = 10n ** 18n;

test('format: FMX amounts group thousands and trim the fraction', () => {
  assert.equal(formatFMX(0n), '0');
  assert.equal(formatFMX(1_500_000n * FMX), '1,500,000');
  assert.equal(formatFMX(1234n * FMX + FMX / 2n), '1,234.5');
  assert.equal(formatFMX(FMX / 10_000n), '0.0001');
  // truncates (never rounds up): 0.00005 at 4 places shows as 0
  assert.equal(formatFMX(FMX / 20_000n), '0');
  assert.equal(formatFMX(25_000n * FMX, 2), '25,000');
});

test('format: bps → percent', () => {
  assert.equal(formatBps(1_000n), '10%');
  assert.equal(formatBps(1_500n), '15%');
  assert.equal(formatBps(800n), '8%');
  assert.equal(formatBps(1_234n), '12.34%');
  assert.equal(formatBps(1_230n), '12.3%');
  assert.equal(formatBps(0n), '0%');
});

test('format: weight bps → multiplier', () => {
  assert.equal(formatWeight(10_000n), '1×');
  assert.equal(formatWeight(15_000n), '1.5×');
  assert.equal(formatWeight(30_000n), '3×');
});

test('format: durations show the two most significant units', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(90), '1m 30s');
  assert.equal(formatDuration(3_600), '1h');
  assert.equal(formatDuration(3_660), '1h 1m');
  assert.equal(formatDuration(90 * 86_400 + 4 * 3_600), '90d 4h');
  assert.equal(formatDuration(90 * 86_400), '90d');
});

test('format: countdown renders remaining time, then "unlocked"', () => {
  assert.equal(formatCountdown(countdown(0, 90 * 86_400)), '90d');
  assert.equal(formatCountdown(countdown(100, 100)), 'unlocked');
  assert.equal(formatCountdown(countdown(500, 100)), 'unlocked');
});

test('format: runway months', () => {
  assert.equal(formatMonths(2_629_800n * 15n), '~15.0 months');
  assert.equal(formatMonths(2_629_800n * 1_500n), '10+ years');
});

test('format: last-seen ages', () => {
  assert.equal(formatAgo(0, 1_000_000), 'never');
  assert.equal(formatAgo(1_000_000, 1_000_030), 'just now');
  assert.equal(formatAgo(1_000_000, 1_000_000 + 300), '5m ago');
  assert.equal(formatAgo(1_000_000, 1_000_000 + 2 * 86_400), '2d ago');
});

test('format: address shortening leaves non-addresses alone', () => {
  assert.equal(
    shortAddress('0xc0A5Eb613f859f072554F29f1Ab7400265af15aB'),
    '0xc0A5…15aB',
  );
  assert.equal(shortAddress('not-an-address'), 'not-an-address');
});
