// Unit checks: address validation, 18-decimal amount parsing, fee math.
// Runs with the plain Node test runner against the SAME modules the UI uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAddress,
  checkAmount,
  txMaxFeeWei,
  maxSendableWei,
  formatAmount,
  formatAmountExact,
  formatGwei,
  shortAddress,
  sendRecipientProblem,
  isPersonalAccountCode,
  ZERO_ADDRESS,
} from '../src/lib/validate.ts';
import { FERMINUX_CHAIN, chainById } from '../src/lib/chains.ts';
import { chainAssets } from '../src/lib/portfolio.ts';
import { parseActivity } from '../src/lib/activity.ts';

const CHECKSUMMED = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

test('address: accepts a correctly checksummed address', () => {
  const r = checkAddress(CHECKSUMMED);
  assert.equal(r.ok, true);
  assert.equal(r.address, CHECKSUMMED);
});

test('address: normalizes an all-lowercase address to EIP-55', () => {
  const r = checkAddress(CHECKSUMMED.toLowerCase());
  assert.equal(r.ok, true);
  assert.equal(r.address, CHECKSUMMED);
});

test('address: accepts all-uppercase hex (no checksum information)', () => {
  const r = checkAddress('0x' + CHECKSUMMED.slice(2).toUpperCase());
  assert.equal(r.ok, true);
  assert.equal(r.address, CHECKSUMMED);
});

test('address: rejects a bad EIP-55 checksum (one letter case-flipped)', () => {
  const bad = CHECKSUMMED.replace('0x8ba1', '0x8Ba1'); // flip one letter's case
  assert.notEqual(bad, CHECKSUMMED);
  const r = checkAddress(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum/i);
});

test('address: trims surrounding whitespace', () => {
  const r = checkAddress(`  ${CHECKSUMMED}\n`);
  assert.equal(r.ok, true);
});

test('address: rejects empty, short, unprefixed and non-hex input', () => {
  for (const input of ['', '0x123', CHECKSUMMED.slice(2), '0xZZ1f109551bD432803012645Ac136ddd64DBA72', '0x8ba1f109551bD432803012645Ac136ddd64DBA7']) {
    assert.equal(checkAddress(input).ok, false, `should reject: ${JSON.stringify(input)}`);
  }
});

test('amount: whole and fractional parsing (18 decimals)', () => {
  assert.equal(checkAmount('1').wei, 10n ** 18n);
  assert.equal(checkAmount('0.5').wei, 5n * 10n ** 17n);
  assert.equal(checkAmount('.5').wei, 5n * 10n ** 17n);
  assert.equal(checkAmount('1.').wei, 10n ** 18n);
  assert.equal(checkAmount(' 2.25 ').wei, 2_250_000_000_000_000_000n);
});

test('amount: 18th-decimal edge cases', () => {
  assert.equal(checkAmount('0.000000000000000001').wei, 1n); // 1 wei
  assert.equal(checkAmount('1.000000000000000001').wei, 10n ** 18n + 1n);
  const tooPrecise = checkAmount('0.0000000000000000001'); // 19 decimals
  assert.equal(tooPrecise.ok, false);
  assert.match(tooPrecise.error, /decimal/i);
});

test('amount: respects token decimals', () => {
  assert.equal(checkAmount('1.123456', 6).wei, 1_123_456n);
  assert.equal(checkAmount('1.1234567', 6).ok, false);
  assert.equal(checkAmount('1', 0).wei, 1n);
  assert.equal(checkAmount('1.5', 0).ok, false);
});

test('amount: rejects zero, negatives, exponents and garbage', () => {
  for (const input of ['0', '0.0', '0.000000000000000000', '-1', '1e5', 'abc', '1,5', '', '.', '1.2.3', '0x10', 'NaN', 'Infinity']) {
    assert.equal(checkAmount(input).ok, false, `should reject: ${JSON.stringify(input)}`);
  }
});

test('amount: very large values survive as exact bigints', () => {
  const r = checkAmount('123456789012345678901234567890');
  assert.equal(r.ok, true);
  assert.equal(r.wei, 123456789012345678901234567890n * 10n ** 18n);
});

test('fee math: txMaxFeeWei is gasLimit × maxFeePerGas', () => {
  assert.equal(txMaxFeeWei(21000n, 2_000_000_000n), 42_000_000_000_000n);
});

test('fee math: maxSendableWei reserves worst-case gas and never goes negative', () => {
  const fee = txMaxFeeWei(21000n, 2_000_000_000n);
  assert.equal(maxSendableWei(10n ** 18n, 21000n, 2_000_000_000n), 10n ** 18n - fee);
  assert.equal(maxSendableWei(fee, 21000n, 2_000_000_000n), 0n); // exactly the fee → nothing sendable
  assert.equal(maxSendableWei(fee - 1n, 21000n, 2_000_000_000n), 0n);
  assert.equal(maxSendableWei(0n, 21000n, 2_000_000_000n), 0n);
});

test('recipient: a token is never sent to a token contract the wallet lists (its own included)', () => {
  const assets = chainAssets(FERMINUX_CHAIN, []);
  const usdf = assets.find((a) => a.symbol === 'USDF');
  const aznt = assets.find((a) => a.symbol === 'AZNT');
  // The USDF contract as its own recipient: transfer() succeeds on chain and the tokens are stranded.
  assert.match(sendRecipientProblem(usdf.address, usdf, assets), /USDF contract itself/);
  assert.match(sendRecipientProblem(usdf.address.toLowerCase(), usdf, assets), /USDF contract itself/);
  // Another listed token's contract.
  assert.match(sendRecipientProblem(aznt.address, usdf, assets), /AZNT token contract/);
  // Same on a foreign chain: USDC to the USDT contract on BSC.
  const bsc = chainAssets(chainById(56), []);
  const usdc = bsc.find((a) => a.symbol === 'USDC');
  const usdt = bsc.find((a) => a.symbol === 'USDT');
  assert.match(sendRecipientProblem(usdt.address, usdc, bsc), /USDT token contract/);
  // A user-added token counts as listed.
  const custom = chainAssets(FERMINUX_CHAIN, [{ chainId: 3961, address: '0x1111111111111111111111111111111111111111', symbol: 'CUS', name: 'Custom', decimals: 18 }]);
  assert.match(sendRecipientProblem('0x1111111111111111111111111111111111111111', usdf, custom), /CUS token contract/);
  // An ordinary account is fine.
  assert.equal(sendRecipientProblem(CHECKSUMMED, usdf, assets), null);
});

test('recipient: the zero address is refused; a native send to a token contract is left to the estimate (WFMX wraps)', () => {
  const assets = chainAssets(FERMINUX_CHAIN, []);
  const wfmx = assets.find((a) => a.symbol === 'WFMX');
  assert.match(sendRecipientProblem(ZERO_ADDRESS, null, assets), /zero address/);
  assert.match(sendRecipientProblem(ZERO_ADDRESS, assets.find((a) => a.symbol === 'USDF'), assets), /zero address/);
  assert.equal(sendRecipientProblem(wfmx.address, null, assets), null);
  assert.equal(sendRecipientProblem(CHECKSUMMED, null, assets), null);
});

test('recipient: personal accounts are no code or an EIP-7702 delegation; anything else is a contract', () => {
  assert.equal(isPersonalAccountCode('0x'), true);
  assert.equal(isPersonalAccountCode('0xef0100' + '63fc2ad3d021a4af7e3bb5b8a7c4f1b9c6a2b6c1'), true);
  assert.equal(isPersonalAccountCode('0x6080604052'), false);
  assert.equal(isPersonalAccountCode('0xef0100' + '00'.repeat(21)), false);
});

test('format: display truncates (never overstates) and groups thousands', () => {
  assert.equal(formatAmount(1_500_000_000_000_000_000n), '1.5');
  assert.equal(formatAmount(10n ** 18n), '1');
  assert.equal(formatAmount(1n), '0.000000'); // dust shows as non-whole, not "0"
  assert.equal(formatAmount(1234_567_890_000_000_000_000n), '1,234.56789');
  assert.equal(formatAmountExact(10n ** 18n + 1n), '1.000000000000000001');
});

test('format: gwei and short address helpers', () => {
  assert.equal(formatGwei(1_500_000_000n), '1.5');
  assert.equal(formatGwei(1_000_000_000n), '1');
  // Ferminux's base fee is a few wei: it must not read as zero.
  assert.equal(formatGwei(7n), '<0.01');
  assert.equal(formatGwei(0n), '0');
  assert.equal(formatGwei(50_000_000n), '0.05');
  assert.equal(shortAddress(CHECKSUMMED), '0x8ba1f1…4DBA72');
});

test('activity: parses Blockscout items and classifies direction', () => {
  const self = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
  const payload = {
    items: [
      { hash: '0xaa', from: { hash: self }, to: { hash: '0x' + '1'.repeat(40) }, value: '1000', status: 'ok', timestamp: '2026-08-20T00:00:00Z', raw_input: '0x' },
      { hash: '0xbb', from: { hash: '0x' + '2'.repeat(40) }, to: { hash: self }, value: '5', status: 'error', timestamp: null, raw_input: '0xa9059cbb' },
      { garbage: true },
    ],
  };
  const items = parseActivity(payload, self);
  assert.equal(items.length, 2);
  assert.equal(items[0].direction, 'out');
  assert.equal(items[0].valueWei, 1000n);
  assert.equal(items[0].success, true);
  assert.equal(items[1].direction, 'in');
  assert.equal(items[1].success, false);
  assert.equal(items[1].isContractCall, true);
});

test('activity: malformed payloads yield an empty list, not a crash', () => {
  assert.deepEqual(parseActivity(null, CHECKSUMMED), []);
  assert.deepEqual(parseActivity({}, CHECKSUMMED), []);
  assert.deepEqual(parseActivity({ items: 'nope' }, CHECKSUMMED), []);
});
