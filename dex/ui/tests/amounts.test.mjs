// Unit tests for parsing and display.
//
// The rule these enforce: no displayed number is ever rounded UP, and a
// mixed-decimals pair (AZNT has 6, FMX has 18) prices correctly in both
// directions. Getting the second one wrong misprices by 10^12.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';

import {
  formatAmount,
  formatBpsPercent,
  formatFull,
  formatPpmPercent,
  formatRelativeFuture,
  formatTimestamp,
  isAddress,
  parseAmount,
  percentToBps,
  priceFromReserves,
  shortAddress,
  trimSignificant,
} from '../src/lib/amounts.ts';
import { maxNativeSpendable, FALLBACK_MAX_FEE_WEI, SWAP_GAS_HEADROOM } from '../src/lib/gas.ts';

test('parseAmount accepts what a token can hold and rejects the rest', () => {
  assert.deepEqual(parseAmount('1.5', 18), { ok: true, wei: parseEther('1.5') });
  assert.deepEqual(parseAmount('0.000001', 6), { ok: true, wei: 1n });
  assert.deepEqual(parseAmount('  12  ', 6), { ok: true, wei: 12_000_000n });

  assert.equal(parseAmount('', 18).ok, false);
  assert.equal(parseAmount('.', 18).ok, false);
  assert.equal(parseAmount('1.2.3', 18).ok, false);
  assert.equal(parseAmount('-1', 18).ok, false);
  assert.equal(parseAmount('1e18', 18).ok, false);
  assert.equal(parseAmount('0', 18).ok, false, 'zero is not a tradeable amount');

  // 7 decimals into a 6-decimal token would silently truncate a digit.
  const tooPrecise = parseAmount('1.0000001', 6);
  assert.equal(tooPrecise.ok, false);
  assert.match(tooPrecise.error, /6 decimals/);
});

test('formatAmount truncates, never rounds up, and never shows dust as zero', () => {
  assert.equal(formatAmount(parseEther('1234.56789'), 18, 4), '1,234.5678');
  assert.equal(formatAmount(parseEther('0.1'), 18), '0.1');
  assert.equal(formatAmount(0n, 18), '0');
  assert.equal(formatAmount(1n, 18, 6), '<0.000001', 'one wei is not zero');
  assert.equal(formatAmount(parseUnits('7', 6), 6), '7');
  assert.equal(formatAmount(-parseEther('2.5'), 18), '-2.5');
  assert.equal(formatFull(1n, 18), '0.000000000000000001');
});

test('priceFromReserves handles a 6-decimal token against an 18-decimal one', () => {
  const aznt = parseUnits('1000', 6); // 1,000 AZNT
  const fmx = parseEther('500'); // 500 FMX
  assert.equal(priceFromReserves(aznt, 6, fmx, 18), '0.5', '1 AZNT = 0.5 FMX');
  assert.equal(priceFromReserves(fmx, 18, aznt, 6), '2', '1 FMX = 2 AZNT');
  assert.equal(priceFromReserves(0n, 6, fmx, 18), null, 'an empty pool has no price');
  assert.equal(priceFromReserves(aznt, 6, 0n, 18), null);
});

test('trimSignificant keeps significant figures without rounding up', () => {
  assert.equal(trimSignificant('1234.5678', 8), '1234.5678');
  assert.equal(trimSignificant('1234.5678', 6), '1234.56');
  assert.equal(trimSignificant('0.000123456789', 5), '0.00012345');
  assert.equal(trimSignificant('0.000000', 6), '0');
  assert.equal(trimSignificant('42', 4), '42');
});

test('percentages convert both ways', () => {
  assert.equal(formatBpsPercent(50), '0.5%');
  assert.equal(formatBpsPercent(10), '0.1%');
  assert.equal(formatBpsPercent(100), '1%');
  assert.equal(formatBpsPercent(0), '0%');
  assert.equal(percentToBps('0.5'), 50);
  assert.equal(percentToBps('12.34'), 1234);
  assert.equal(percentToBps(''), null);
  assert.equal(percentToBps('abc'), null);

  assert.equal(formatPpmPercent(3_000n), '0.30%'); // 30 bps
  assert.equal(formatPpmPercent(1_000_000n), '100.00%');
  assert.equal(formatPpmPercent(12n, 4), '0.0012%');
  assert.equal(formatPpmPercent(0n), '0.00%');
});

test('addresses are validated and shortened', () => {
  const address = '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178';
  assert.equal(isAddress(address), true);
  assert.equal(isAddress('0x1234'), false);
  assert.equal(isAddress('not an address'), false);
  assert.equal(shortAddress(address), '0xFc81…4178');
});

test('timestamps render in UTC and read as a distance', () => {
  assert.match(formatTimestamp(1_800_000_000), /2027 \d{2}:\d{2} UTC$/);
  assert.equal(formatRelativeFuture(1_000_000 + 3 * 24 * 3600, 1_000_000), 'in 3 days');
  assert.equal(formatRelativeFuture(1_000_000 + 3600, 1_000_000), 'in 1 hour');
  assert.equal(formatRelativeFuture(1_000_000 + 400 * 24 * 3600, 1_000_000), 'in 1 year');
  assert.equal(formatRelativeFuture(999_000, 1_000_000), 'matured');
});

test('Max on native FMX always leaves enough for the fee', () => {
  const balance = parseEther('10');
  const maxFee = 2_000_000_000n; // 2 gwei
  const spendable = maxNativeSpendable(balance, maxFee);
  assert.equal(spendable, balance - maxFee * SWAP_GAS_HEADROOM);
  assert.ok(spendable < balance);
  // No fee data from the node → fall back to a pessimistic cap, still safe.
  assert.equal(maxNativeSpendable(balance, null), balance - FALLBACK_MAX_FEE_WEI * SWAP_GAS_HEADROOM);
  // A balance smaller than the reserve cannot fund any swap at all.
  assert.equal(maxNativeSpendable(1000n, maxFee), 0n);
});
