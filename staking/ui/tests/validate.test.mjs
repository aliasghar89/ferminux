// Amount / address validation used by the stake form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAmount, checkAddress, formatGwei } from '../src/lib/validate.ts';

test('validate: plain decimal amounts parse to wei', () => {
  assert.deepEqual(checkAmount('1'), { ok: true, wei: 10n ** 18n });
  assert.deepEqual(checkAmount('0.5'), { ok: true, wei: 5n * 10n ** 17n });
  assert.deepEqual(checkAmount('.5'), { ok: true, wei: 5n * 10n ** 17n });
  assert.deepEqual(checkAmount('25000'), { ok: true, wei: 25_000n * 10n ** 18n });
});

test('validate: rejects empty, non-numeric, over-precise and zero amounts', () => {
  assert.equal(checkAmount('').ok, false);
  assert.equal(checkAmount('abc').ok, false);
  assert.equal(checkAmount('1,5').ok, false);
  assert.equal(checkAmount('1e5').ok, false);
  assert.equal(checkAmount('-1').ok, false);
  assert.equal(checkAmount('.').ok, false);
  assert.equal(checkAmount('0').ok, false);
  assert.equal(checkAmount('0.' + '0'.repeat(18) + '1').ok, false); // 19 decimal places
});

test('validate: address checksum enforcement', () => {
  assert.equal(checkAddress('0x910BD467D8576277f8f96DF47428377FFD94fEfe').ok, true);
  assert.equal(checkAddress('0x910bd467d8576277f8f96df47428377ffd94fefe').ok, true);
  assert.equal(checkAddress('0x910BD467D8576277f8f96DF47428377FFD94fEfE').ok, false); // wrong checksum
  assert.equal(checkAddress('').ok, false);
});

test('validate: gwei formatting', () => {
  assert.equal(formatGwei(1_000_000_000n), '1');
  assert.equal(formatGwei(1_250_000_000n), '1.25');
  assert.equal(formatGwei(875_000_000n), '0.87');
});
