// The two new public-data lists: tokens added by address (any chain) and the
// log of transactions sent on chains without a keyless history API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CUSTOM_TOKENS,
  cleanTokenText,
  isListedToken,
  legacyAddressesToResolve,
  normalizeCustomToken,
  parseCustomTokens,
  serializeCustomTokens,
  withCustomToken,
  withoutCustomToken,
} from '../src/lib/customTokens.ts';
import {
  LOCAL_ACTIVITY_CAP,
  localTxFor,
  parseLocalActivity,
  serializeLocalActivity,
  withLocalTx,
  withLocalTxStatus,
} from '../src/lib/localActivity.ts';
import { cleanText } from '../src/lib/text.ts';
import { FERMINUX_CHAIN } from '../src/lib/chains.ts';

const CAKE = { chainId: 56, address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', symbol: 'CAKE', name: 'PancakeSwap Token', decimals: 18 };

test('text hygiene: bidi overrides, zero-width marks and controls are stripped', () => {
  const rlo = String.fromCharCode(0x202e);
  const zw = String.fromCharCode(0x200b);
  assert.equal(cleanTokenText(`US${rlo}DC${zw}`, 16), 'USDC');
  assert.equal(cleanTokenText('  Tether\n\tUSD  ', 48), 'Tether USD');
  assert.equal(cleanTokenText('X'.repeat(40), 16), 'X'.repeat(16));
  assert.equal(cleanText(`a${String.fromCharCode(0x2066)}b`, 10), 'a b');
  assert.equal(cleanText('abcdef', 3), 'abc…');
  assert.equal(cleanTokenText(42, 10), '');
});

test('custom tokens: normalize, checksum, reject junk and unsupported chains', () => {
  const t = normalizeCustomToken(CAKE);
  assert.equal(t.address, '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82');
  assert.equal(normalizeCustomToken({ ...CAKE, chainId: 250 }), null, 'unsupported chain');
  assert.equal(normalizeCustomToken({ ...CAKE, address: '0x123' }), null);
  assert.equal(normalizeCustomToken({ ...CAKE, decimals: 99 }), null);
  assert.equal(normalizeCustomToken({ ...CAKE, symbol: String.fromCharCode(0x200b) }), null, 'an invisible symbol is no symbol');
  assert.equal(normalizeCustomToken({ ...CAKE, name: '' }).name, 'CAKE');
});

test('custom tokens: add / duplicate / listed / remove / cap / round trip', () => {
  let r = withCustomToken([], CAKE);
  assert.equal(r.ok, true);
  const list = r.tokens;
  r = withCustomToken(list, { ...CAKE, address: CAKE.address.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(r, { ok: false, error: 'This token is already in your list.' });
  r = withCustomToken(list, { ...CAKE, address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT' });
  assert.equal(r.ok, false, 'USDT is listed on BSC already');
  assert.ok(isListedToken(3961, FERMINUX_CHAIN.tokens[0].address.toLowerCase()));
  const sameAddressOtherChain = withCustomToken(list, { ...CAKE, chainId: 1 });
  assert.equal(sameAddressOtherChain.ok, true, 'the same address on another chain is another token');

  assert.deepEqual(parseCustomTokens(serializeCustomTokens(sameAddressOtherChain.tokens)), sameAddressOtherChain.tokens);
  assert.deepEqual(withoutCustomToken(sameAddressOtherChain.tokens, 56, CAKE.address), [sameAddressOtherChain.tokens[1]]);
  assert.deepEqual(parseCustomTokens('not json'), []);
  assert.deepEqual(parseCustomTokens('{"a":1}'), []);

  const many = Array.from({ length: MAX_CUSTOM_TOKENS }, (_, i) => ({ ...CAKE, address: '0x' + (i + 1).toString(16).padStart(40, '0') }));
  assert.equal(withCustomToken(many.map(normalizeCustomToken), { ...CAKE, address: '0x' + 'f'.repeat(40) }).ok, false);
});

test('v1 token list migration: only unlisted, unknown Ferminux addresses need resolving', () => {
  const listed = FERMINUX_CHAIN.tokens[0].address;
  const extra = '0x1111111111111111111111111111111111111111';
  const already = { chainId: 3961, address: '0x2222222222222222222222222222222222222222', symbol: 'X', name: 'X', decimals: 18 };
  const raw = JSON.stringify([listed.toLowerCase(), extra, extra.toUpperCase().replace('0X', '0x'), already.address, 'junk', 7]);
  assert.deepEqual(legacyAddressesToResolve(raw, 3961, [already]), [extra]);
  assert.deepEqual(legacyAddressesToResolve(null, 3961, []), []);
  assert.deepEqual(legacyAddressesToResolve('{', 3961, []), []);
});

const tx = (over = {}) => ({
  chainId: 56,
  hash: '0x' + 'ab'.repeat(32),
  from: '0x7F16433359E4eF704E90cE08460c6238E45130f7',
  to: '0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d',
  kind: 'native',
  symbol: 'BNB',
  amount: '1000',
  decimals: 18,
  contract: null,
  status: 'pending',
  createdAt: 1000,
  ...over,
});

test('local activity: record, update status, filter by sender and chain, newest first', () => {
  let list = withLocalTx([], tx());
  list = withLocalTx(list, tx({ hash: '0x' + 'cd'.repeat(32), chainId: 1, symbol: 'ETH', createdAt: 2000 }));
  list = withLocalTx(list, tx({ from: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', hash: '0x' + 'ef'.repeat(32), createdAt: 3000 }));
  assert.deepEqual(list.map((t) => t.createdAt), [3000, 2000, 1000]);
  assert.equal(localTxFor(list, '0x7f16433359e4ef704e90ce08460c6238e45130f7').length, 2, 'case-insensitive sender match');
  assert.equal(localTxFor(list, '0x7F16433359E4eF704E90cE08460c6238E45130f7', 56).length, 1);

  list = withLocalTxStatus(list, 56, ('0x' + 'AB'.repeat(32)), 'confirmed');
  assert.equal(list.find((t) => t.chainId === 56 && t.hash.startsWith('0xab')).status, 'confirmed');
  // Re-recording the same chain+hash replaces, never duplicates.
  list = withLocalTx(list, tx({ status: 'failed' }));
  assert.equal(list.filter((t) => t.hash === '0x' + 'ab'.repeat(32)).length, 1);

  assert.deepEqual(parseLocalActivity(serializeLocalActivity(list)), list);
});

test('local activity: junk rows are dropped, the log is capped', () => {
  assert.deepEqual(parseLocalActivity(JSON.stringify([tx({ chainId: 250 }), tx({ hash: '0x12' }), tx({ amount: '-1' }), tx({ kind: 'x' })])), []);
  assert.deepEqual(parseLocalActivity('nope'), []);
  let list = [];
  for (let i = 0; i < LOCAL_ACTIVITY_CAP + 5; i += 1) {
    list = withLocalTx(list, tx({ hash: '0x' + i.toString(16).padStart(64, '0'), createdAt: i }));
  }
  assert.equal(list.length, LOCAL_ACTIVITY_CAP);
  assert.equal(list[0].createdAt, LOCAL_ACTIVITY_CAP + 4, 'oldest rows fall off first');
});
