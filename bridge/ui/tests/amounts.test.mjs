// Unit checks for the amount / fee / cap math and address validation.
// These run against the SAME modules the UI imports — no re-implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';

import {
  BPS_DENOMINATOR,
  CAP_WINDOW_SECONDS,
  checkAddress,
  checkAmount,
  checkRecipient,
  decayedUsage,
  feeOf,
  formatAgo,
  formatAmount,
  formatAmountExact,
  formatBps,
  formatDuration,
  maxBridgeable,
  netOf,
  quoteTransfer,
  remainingCapacity,
  secondsUntilCapacity,
  shortAddress,
  shortHash,
} from '../src/lib/amounts.ts';

const CHECKSUMMED = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const ZERO = '0x0000000000000000000000000000000000000000';

/* ------------------------------------------------------------- addresses */

test('address: accepts a correctly checksummed address', () => {
  const r = checkAddress(CHECKSUMMED);
  assert.equal(r.ok, true);
  assert.equal(r.address, CHECKSUMMED);
});

test('address: normalizes all-lowercase and all-uppercase to EIP-55', () => {
  assert.equal(checkAddress(CHECKSUMMED.toLowerCase()).address, CHECKSUMMED);
  assert.equal(checkAddress('0x' + CHECKSUMMED.slice(2).toUpperCase()).address, CHECKSUMMED);
});

test('address: rejects a bad EIP-55 checksum', () => {
  const bad = CHECKSUMMED.replace('0x8ba1', '0x8Ba1');
  assert.notEqual(bad, CHECKSUMMED);
  const r = checkAddress(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum/i);
});

test('address: rejects wrong length, non-hex and empty input', () => {
  assert.equal(checkAddress('').ok, false);
  assert.equal(checkAddress('0x1234').ok, false);
  assert.equal(checkAddress(CHECKSUMMED + 'aa').ok, false);
  assert.equal(checkAddress('0xzzzzf109551bD432803012645Ac136ddd64DBA72').ok, false);
});

test('recipient: a valid address passes but the zero address is refused', () => {
  assert.equal(checkRecipient(CHECKSUMMED).ok, true);
  const r = checkRecipient(ZERO);
  assert.equal(r.ok, false);
  assert.match(r.error, /zero address/i);
});

/* ---------------------------------------------------------------- amounts */

test('amount: parses decimals for 18- and 6-decimal assets', () => {
  assert.equal(checkAmount('1.5').wei, parseEther('1.5'));
  assert.equal(checkAmount('0.000001', 6).wei, 1n);
  assert.equal(checkAmount('.5').wei, parseEther('0.5'));
  assert.equal(checkAmount('2.').wei, parseEther('2'));
});

test('amount: rejects zero, blanks, junk and over-precision', () => {
  assert.equal(checkAmount('').ok, false);
  assert.equal(checkAmount('0').ok, false);
  assert.equal(checkAmount('abc').ok, false);
  assert.equal(checkAmount('1.2.3').ok, false);
  assert.equal(checkAmount('-1').ok, false);
  const tooPrecise = checkAmount('1.1234567', 6);
  assert.equal(tooPrecise.ok, false);
  assert.match(tooPrecise.error, /6 decimal places/);
});

/* -------------------------------------------------------------- fee math */

test('fee: 10 bps of 1 FMX is exactly 0.001 FMX and net is the remainder', () => {
  const amount = parseEther('1');
  assert.equal(feeOf(amount, 10), parseEther('0.001'));
  assert.equal(netOf(amount, 10), parseEther('0.999'));
  assert.equal(feeOf(amount, 10) + netOf(amount, 10), amount);
});

test('fee: matches the contract formula amount*bps/10000 including flooring', () => {
  for (const [amount, bps] of [
    [12_345_678_901n, 10],
    [1n, 100],
    [99n, 10],
    [parseUnits('7.5', 6), 25],
    [parseEther('123.456789'), 100],
  ]) {
    assert.equal(feeOf(amount, bps), (amount * BigInt(bps)) / BPS_DENOMINATOR);
  }
  // 10 bps of 99 wei floors to zero — the user pays nothing, not one wei.
  assert.equal(feeOf(99n, 10), 0n);
});

test('fee: the contract ceiling of 100 bps never eats the whole amount', () => {
  const amount = parseEther('1');
  assert.equal(feeOf(amount, 100), parseEther('0.01'));
  assert.ok(netOf(amount, 100) > 0n);
});

test('fee: zero and non-positive amounts are safe', () => {
  assert.equal(feeOf(0n, 10), 0n);
  assert.equal(feeOf(-5n, 10), 0n);
  assert.throws(() => feeOf(100n, -1), /negative/);
});

test('formatBps renders basis points as a percentage', () => {
  assert.equal(formatBps(10), '0.10%');
  assert.equal(formatBps(100), '1.00%');
  assert.equal(formatBps(0), '0.00%');
});

/* -------------------------------------------------------------- cap math */

const T0 = 1_700_000_000; // a realistic block timestamp

test('cap: usage decays linearly to zero over the 24 h window', () => {
  const used = 1000n;
  const window = Number(CAP_WINDOW_SECONDS);
  assert.equal(decayedUsage(used, T0, T0), used, 'no time passed');
  assert.equal(decayedUsage(used, T0, T0 + window / 2), 500n, 'half the window');
  assert.equal(decayedUsage(used, T0, T0 + window), 0n, 'window elapsed');
  assert.equal(decayedUsage(used, T0, T0 + window * 3), 0n, 'never negative');
});

test('cap: an untouched bucket, an empty bucket and a skewed clock all read safely', () => {
  // updatedAt === 0 is the contract's "this window was never used".
  assert.equal(decayedUsage(500n, 0, T0), 0n);
  assert.equal(decayedUsage(0n, T0, T0 + 99_999), 0n);
  assert.equal(decayedUsage(500n, T0, T0 - 100), 500n, 'clock skew must not create capacity');
});

test('cap: decay matches the contract expression exactly', () => {
  const used = 987_654_321n;
  for (const elapsed of [1, 60, 3600, 43_200, 86_399]) {
    const expected = used - (used * BigInt(elapsed)) / CAP_WINDOW_SECONDS;
    assert.equal(decayedUsage(used, T0, T0 + elapsed), expected, `elapsed ${elapsed}`);
  }
});

test('cap: remaining capacity clamps at zero', () => {
  assert.equal(remainingCapacity(100n, 40n), 60n);
  assert.equal(remainingCapacity(100n, 100n), 0n);
  assert.equal(remainingCapacity(100n, 140n), 0n);
});

test('cap: secondsUntilCapacity is zero when it fits, null when it never fits', () => {
  assert.equal(secondsUntilCapacity(100n, 40n, 60n), 0);
  assert.equal(secondsUntilCapacity(100n, 0n, 101n), null, 'larger than the cap itself');
  assert.equal(secondsUntilCapacity(100n, 100n, 50n), Number(CAP_WINDOW_SECONDS) / 2);
  assert.equal(secondsUntilCapacity(100n, 100n, 100n), Number(CAP_WINDOW_SECONDS));
});

/* --------------------------------------------------------------- quoting */

const baseQuote = {
  feeBps: 10,
  maxPerTransfer: parseEther('100'),
  dailyCap: parseEther('500'),
  usage: 0n,
  balance: parseEther('50'),
  decimals: 18,
  symbol: 'FMX',
  isNative: false,
};

test('quote: a normal transfer is ok and reports fee, net and capacity left', () => {
  const q = quoteTransfer({ ...baseQuote, amountWei: parseEther('10') });
  assert.equal(q.ok, true);
  assert.deepEqual(q.problems, []);
  assert.equal(q.feeWei, parseEther('0.01'));
  assert.equal(q.netWei, parseEther('9.99'));
  assert.equal(q.remaining, parseEther('500'));
  assert.equal(q.remainingAfter, parseEther('490'));
});

test('quote: refuses an amount above the per-transfer cap', () => {
  const q = quoteTransfer({ ...baseQuote, amountWei: parseEther('101'), balance: parseEther('1000') });
  assert.equal(q.ok, false);
  assert.match(q.problems.join(' '), /per-transfer cap of 100/);
});

test('quote: refuses an amount above the remaining 24 h capacity', () => {
  const q = quoteTransfer({
    ...baseQuote,
    amountWei: parseEther('60'),
    maxPerTransfer: parseEther('1000'),
    dailyCap: parseEther('100'),
    usage: parseEther('50'),
    balance: parseEther('1000'),
  });
  assert.equal(q.ok, false);
  assert.match(q.problems.join(' '), /remaining 24 h capacity of 50/);
  assert.equal(q.remaining, parseEther('50'));
});

test('quote: refuses more than the balance, and zero or blank amounts', () => {
  const over = quoteTransfer({ ...baseQuote, amountWei: parseEther('51') });
  assert.equal(over.ok, false);
  assert.match(over.problems.join(' '), /exceeds your balance of 50/i);

  const zero = quoteTransfer({ ...baseQuote, amountWei: 0n });
  assert.equal(zero.ok, false);
  assert.match(zero.problems.join(' '), /greater than zero/);
});

test('quote: an unknown balance never blocks (still loading)', () => {
  const q = quoteTransfer({ ...baseQuote, amountWei: parseEther('10'), balance: null });
  assert.equal(q.ok, true);
});

test('quote: native transfers must leave gas headroom', () => {
  const q = quoteTransfer({
    ...baseQuote,
    amountWei: parseEther('50'),
    isNative: true,
    gasReserveWei: parseEther('0.01'),
  });
  assert.equal(q.ok, false);
  assert.match(q.problems.join(' '), /nothing for gas/i);
});

test('quote: a paused bridge or a paused token blocks with a clear reason', () => {
  const bridge = quoteTransfer({ ...baseQuote, amountWei: parseEther('1'), bridgePaused: true });
  assert.equal(bridge.ok, false);
  assert.match(bridge.problems[0], /bridge is paused/i);

  const token = quoteTransfer({ ...baseQuote, amountWei: parseEther('1'), tokenPaused: true });
  assert.equal(token.ok, false);
  assert.match(token.problems[0], /FMX is paused/);
});

test('quote: an amount so small the fee would eat it is refused', () => {
  const q = quoteTransfer({
    ...baseQuote,
    amountWei: 1n,
    feeBps: 10_000, // pathological: the whole amount
    balance: parseEther('1'),
  });
  assert.equal(q.ok, false);
  assert.match(q.problems.join(' '), /fee would consume/i);
});

/* ------------------------------------------------------------------- max */

test('max: takes the tightest of balance, per-transfer cap and 24 h capacity', () => {
  assert.equal(
    maxBridgeable({
      balance: parseEther('80'),
      maxPerTransfer: parseEther('100'),
      dailyCap: parseEther('500'),
      usage: 0n,
      isNative: false,
    }),
    parseEther('80'),
    'balance binds',
  );
  assert.equal(
    maxBridgeable({
      balance: parseEther('800'),
      maxPerTransfer: parseEther('100'),
      dailyCap: parseEther('500'),
      usage: 0n,
      isNative: false,
    }),
    parseEther('100'),
    'per-transfer cap binds',
  );
  assert.equal(
    maxBridgeable({
      balance: parseEther('800'),
      maxPerTransfer: parseEther('100'),
      dailyCap: parseEther('500'),
      usage: parseEther('480'),
      isNative: false,
    }),
    parseEther('20'),
    '24 h capacity binds',
  );
});

test('max: native reserves gas and never goes negative', () => {
  assert.equal(
    maxBridgeable({
      balance: parseEther('1'),
      maxPerTransfer: parseEther('100'),
      dailyCap: parseEther('500'),
      usage: 0n,
      isNative: true,
      gasReserveWei: parseEther('0.01'),
    }),
    parseEther('0.99'),
  );
  assert.equal(
    maxBridgeable({
      balance: parseEther('0.001'),
      maxPerTransfer: parseEther('100'),
      dailyCap: parseEther('500'),
      usage: 0n,
      isNative: true,
      gasReserveWei: parseEther('0.01'),
    }),
    0n,
  );
});

test('max: the result always passes its own quote', () => {
  const rails = {
    balance: parseEther('800'),
    maxPerTransfer: parseEther('100'),
    dailyCap: parseEther('500'),
    usage: parseEther('455'),
    isNative: false,
  };
  const max = maxBridgeable(rails);
  const q = quoteTransfer({ ...rails, amountWei: max, feeBps: 10, decimals: 18, symbol: 'FMX' });
  assert.equal(q.ok, true, q.problems.join(' '));
});

/* -------------------------------------------------------------- display */

test('format: truncates rather than rounding up, and groups thousands', () => {
  assert.equal(formatAmount(parseEther('1234.5'), 18), '1,234.5');
  assert.equal(formatAmount(parseEther('0.9999999'), 18), '0.999999', 'never rounds up');
  assert.equal(formatAmount(parseEther('1'), 18), '1');
  assert.equal(formatAmount(1n, 18), '0.000000', 'dust is shown as non-zero-but-tiny');
  assert.equal(formatAmount(parseUnits('12.34', 6), 6), '12.34');
  assert.equal(formatAmountExact(parseEther('0.999999999999999999')), '0.999999999999999999');
});

test('format: durations read like a human wrote them', () => {
  assert.equal(formatDuration(30), '30 seconds');
  assert.equal(formatDuration(1), '1 second');
  assert.equal(formatDuration(90), '2 minutes');
  assert.equal(formatDuration(3600), '1 hour');
  assert.equal(formatDuration(4200), '1 hour 10 minutes');
});

test('format: short address, short hash and relative time', () => {
  assert.equal(shortAddress(CHECKSUMMED), '0x8ba1f1…4DBA72');
  assert.equal(shortAddress('0x1234'), '0x1234', 'short strings are left alone');
  assert.equal(shortHash('0x' + 'ab'.repeat(32)), '0xabababab…abababab');
  const now = 1_700_000_000_000;
  assert.equal(formatAgo(now, now), 'just now');
  assert.equal(formatAgo(now - 120_000, now), '2 min ago');
  assert.equal(formatAgo(now - 7_200_000, now), '2 h ago');
});
