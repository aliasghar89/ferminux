// The picker's token list: the repo registry (shared/tokens.ts, which
// site/assets/brand/tokenlist.json is generated from), native FMX first, and
// the bundled logos byte-identical to the published ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TOKENS } from '../../../shared/tokens.ts';
import { BUNDLED_LOGOS, isListed, listedTokens, logoFor, searchTokens, sortForPicker } from '../src/lib/tokenlist.ts';
import { tokenKey } from '../src/lib/tokens.ts';

const WFMX = '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('bundled token logos are byte-identical to site/assets/brand', () => {
  for (const [key, file] of Object.entries(BUNDLED_LOGOS)) {
    const bundled = readFileSync(here(`../src/assets/tokens/${file}`));
    const published = readFileSync(here(`../../../site/assets/brand/${file}`));
    assert.ok(bundled.equals(published), `${key}: src/assets/tokens/${file} has drifted from site/assets/brand/${file}`);
  }
});

test('every registry token that names a bundled logo gets it; FMX and WFMX share the coin', () => {
  for (const t of TOKENS) {
    const key = logoFor({ kind: 'erc20', address: t.address }, WFMX);
    if (Object.values(BUNDLED_LOGOS).includes(t.logo)) assert.ok(key, `${t.symbol} has a logo`);
  }
  assert.equal(logoFor({ kind: 'native', address: WFMX }, WFMX), 'fmx');
  assert.equal(logoFor({ kind: 'erc20', address: WFMX }, WFMX), 'fmx');
  assert.equal(logoFor({ kind: 'erc20', address: '0x' + '12'.repeat(20) }, WFMX), null, 'an unknown token draws a monogram');
});

test('the listed tokens are native FMX, WFMX, then the registry in order', () => {
  const list = listedTokens(WFMX);
  assert.equal(list[0].kind, 'native');
  assert.equal(list[0].symbol, 'FMX');
  assert.equal(list[1].symbol, 'WFMX');
  const rest = TOKENS.filter((t) => t.address.toLowerCase() !== WFMX.toLowerCase()).map((t) => t.symbol);
  assert.deepEqual(list.slice(2).map((t) => t.symbol), rest);
  assert.ok(list.some((t) => t.symbol === 'USDF') && list.some((t) => t.symbol === 'AZNT'));
  assert.equal(new Set(list.map(tokenKey)).size, list.length, 'no duplicates');
  for (const t of list) assert.equal(isListed(t), true);
  assert.equal(isListed({ kind: 'erc20', address: '0x' + '12'.repeat(20) }), false);
});

test('picker order: listed first with FMX on top, then held tokens, then by symbol', () => {
  const listed = listedTokens(WFMX);
  const junk = [
    { kind: 'erc20', address: '0x' + 'aa'.repeat(20), symbol: 'ZED', name: 'Zed', decimals: 18 },
    { kind: 'erc20', address: '0x' + 'bb'.repeat(20), symbol: 'ABC', name: 'Abc', decimals: 18 },
  ];
  const balances = new Map([[tokenKey(junk[0]), 5n]]);
  const sorted = sortForPicker([...junk, ...listed].reverse(), balances, WFMX);
  assert.equal(sorted[0].kind, 'native');
  assert.deepEqual(sorted.slice(-2).map((t) => t.symbol), ['ZED', 'ABC'], 'a held unlisted token before an unheld one');
});

test('search matches symbol, name and full address; an exact symbol ranks first', () => {
  const list = listedTokens(WFMX);
  assert.deepEqual(searchTokens(list, 'usdf').map((t) => t.symbol), ['USDF']);
  assert.ok(searchTokens(list, 'manat').some((t) => t.symbol === 'AZNT'));
  const byAddr = searchTokens(list, TOKENS.find((t) => t.symbol === 'AZNT').address.toLowerCase());
  assert.deepEqual(byAddr.map((t) => t.symbol), ['AZNT']);
  assert.equal(searchTokens(list, 'fmx')[0].symbol, 'FMX');
  assert.equal(searchTokens(list, '').length, list.length);
});
