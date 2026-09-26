// Deep links (src/lib/deeplink.ts): ?inputCurrency=…&outputCurrency=…&tab=…
//
// ferminux.net and ferminux.com open a swap here with the pool's stablecoin in
// and FMX out. A link is someone else's text, so it may only SELECT a token the
// app already lists, and a SYMBOL may only select a first-party token.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { linkedPair, parseDexLink, resolveLinkToken } from '../src/lib/deeplink.ts';

const WFMX = '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae';
const AZNT = '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178';
const USDF = '0xCd032A609e34121D1881E8DE7355b2c2c7092363';
const FAKE = '0x1111111111111111111111111111111111111111';

const fmx = { kind: 'native', address: WFMX, symbol: 'FMX', name: 'Ferminux', decimals: 18 };
const wfmx = { kind: 'erc20', address: WFMX, symbol: 'WFMX', name: 'Wrapped FMX', decimals: 18 };
const aznt = { kind: 'erc20', address: AZNT, symbol: 'AZNT', name: 'Ferminux Manat', decimals: 6 };
const usdf = { kind: 'erc20', address: USDF, symbol: 'USDF', name: 'Ferminux Dollar', decimals: 6 };
// someone's pool token that copies a first-party symbol
const impostor = { kind: 'erc20', address: FAKE, symbol: 'USDF', name: 'Totally USDF', decimals: 6 };
const TOKENS = [fmx, wfmx, impostor, aznt, usdf];
const FIRST_PARTY = new Set([WFMX, AZNT, USDF].map((a) => a.toLowerCase()));
const trusted = (t) => t.kind === 'native' || FIRST_PARTY.has(t.address.toLowerCase());
// FMX's counterpart: the first ERC-20 that is not WFMX and has a pool — here AZNT, the only live pool
const counterpart = () => aznt;

test('parse: V2-style names, short aliases, tab whitelist, leading ? optional', () => {
  assert.deepEqual(parseDexLink(`?inputCurrency=${AZNT}&outputCurrency=FMX`), { input: AZNT, output: 'FMX', tab: null });
  assert.deepEqual(parseDexLink('in=USDF&out=fmx&tab=Pools'), { input: 'USDF', output: 'fmx', tab: 'pools' });
  assert.equal(parseDexLink('?tab=bridge').tab, null, 'only swap, liquidity and pools can be opened by a link');
  assert.deepEqual(parseDexLink(''), { input: null, output: null, tab: null });
});

test('resolve: addresses match listed ERC-20s (WFMX, not native FMX); symbols only first-party; nothing is imported', () => {
  assert.equal(resolveLinkToken(AZNT, TOKENS, trusted), aznt);
  assert.equal(resolveLinkToken(AZNT.toLowerCase(), TOKENS, trusted), aznt, 'case-insensitive');
  assert.equal(resolveLinkToken(WFMX, TOKENS, trusted), wfmx, "the wrapper's address is WFMX");
  assert.equal(resolveLinkToken('FMX', TOKENS, trusted), fmx);
  assert.equal(resolveLinkToken('native', TOKENS, trusted), fmx);
  assert.equal(resolveLinkToken('usdf', TOKENS, trusted), usdf, 'the first-party USDF, never the impostor listed before it');
  assert.equal(resolveLinkToken(FAKE, TOKENS, trusted), impostor, 'an explicit address still selects a listed pool token');
  assert.equal(resolveLinkToken('0x2222222222222222222222222222222222222222', TOKENS, trusted), null, 'an unlisted address is not imported');
  assert.equal(resolveLinkToken('SCAM', TOKENS, trusted), null);
  assert.equal(resolveLinkToken(null, TOKENS, trusted), null);
});

test('pair: both sides, one side filled with FMX or its counterpart, duplicates and wraps', () => {
  const pair = (search) => linkedPair(parseDexLink(search), TOKENS, trusted, counterpart);
  // the link the websites use: buy FMX with the pool's stablecoin
  assert.deepEqual(pair(`?inputCurrency=${AZNT}&outputCurrency=FMX`), { tokenIn: aznt, tokenOut: fmx });
  // only the output: FMX out is paid for with FMX's counterpart; anything else out is paid for with FMX
  assert.deepEqual(pair('?outputCurrency=FMX'), { tokenIn: aznt, tokenOut: fmx });
  assert.deepEqual(pair('?outputCurrency=USDF'), { tokenIn: fmx, tokenOut: usdf });
  // only the input
  assert.deepEqual(pair('?inputCurrency=AZNT'), { tokenIn: aznt, tokenOut: fmx });
  assert.deepEqual(pair('?inputCurrency=FMX'), { tokenIn: fmx, tokenOut: aznt });
  // WFMX alone pairs with FMX's counterpart, not with FMX (that would be an unwrap)
  assert.deepEqual(pair('?inputCurrency=WFMX'), { tokenIn: wfmx, tokenOut: aznt });
  // an explicit wrap is honoured
  assert.deepEqual(pair('?inputCurrency=FMX&outputCurrency=WFMX'), { tokenIn: fmx, tokenOut: wfmx });
  // the same token twice keeps the input
  assert.deepEqual(pair('?inputCurrency=AZNT&outputCurrency=AZNT'), { tokenIn: aznt, tokenOut: fmx });
  // nothing usable
  assert.equal(pair('?inputCurrency=SCAM&outputCurrency=0x2222222222222222222222222222222222222222'), null);
  assert.equal(pair(''), null);
});
