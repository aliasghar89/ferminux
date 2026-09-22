// The shared token registry (shared/tokens.ts).
//
// This is the file that stopped four hand-maintained lists from disagreeing.
// They already had: USDF was deployed with 500,000 supply, listed in the DEX
// and in the published token list, and MISSING from the wallet — so a holder
// opening the wallet saw nothing and had to know the contract address to find
// their own balance. Nothing failed; it was just wrong in one place.
//
// These tests guard the properties that made that possible, and the ones that
// would make adding wBNB after the bridge's BNB route go wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';

import {
  FERMINUX_CHAIN_ID,
  FIRST_PARTY_ADDRESSES,
  TOKENS,
  bySymbol,
  isFirstParty,
  preloadTokens,
  walletTokens,
} from '../../../shared/tokens.ts';

test('registry: every address is EIP-55 checksummed, so lookups cannot miss on case', () => {
  for (const t of TOKENS) {
    assert.equal(getAddress(t.address), t.address, `${t.symbol} is not checksummed`);
  }
});

test('registry: no address appears twice — a duplicate silently shadows one entry', () => {
  const seen = new Set();
  for (const t of TOKENS) {
    const key = t.address.toLowerCase();
    assert.equal(seen.has(key), false, `${t.symbol} duplicates ${key}`);
    seen.add(key);
  }
});

test('registry: no symbol appears twice on this chain', () => {
  const symbols = TOKENS.map((t) => t.symbol);
  assert.equal(new Set(symbols).size, symbols.length, `duplicate symbol in ${symbols}`);
});

test('registry: decimals are plausible — a wrong one misprices every balance shown', () => {
  for (const t of TOKENS) {
    assert.ok(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18, `${t.symbol}: ${t.decimals}`);
  }
  // The two stablecoins are 6-decimal; treating them as 18 would show every
  // balance as a millionth of itself.
  assert.equal(bySymbol('AZNT').decimals, 6);
  assert.equal(bySymbol('USDF').decimals, 6);
  assert.equal(bySymbol('WFMX').decimals, 18);
});

test('wallet: USDF is shown out of the box — the regression, stated directly', () => {
  const symbols = walletTokens().map((t) => t.symbol);
  assert.ok(symbols.includes('USDF'), `USDF must be a default wallet token, got ${symbols}`);
});

test('wallet: shows every known token, so no balance can be invisible', () => {
  assert.equal(walletTokens().length, TOKENS.length);
});

test('preload: WFMX is NOT preloaded — the DEX adds it at runtime and would double it', () => {
  assert.equal(
    preloadTokens().some((t) => t.symbol === 'WFMX'),
    false,
  );
});

test('preload: the tradeable stablecoins are offered before any pool is read', () => {
  const symbols = preloadTokens().map((t) => t.symbol).sort();
  assert.deepEqual(symbols, ['AZNT', 'USDF']);
});

test('first-party: the derived address list matches the flag, and is lowercased for lookup', () => {
  const expected = TOKENS.filter((t) => t.firstParty).map((t) => t.address.toLowerCase());
  assert.deepEqual([...FIRST_PARTY_ADDRESSES].sort(), expected.sort());
  for (const a of FIRST_PARTY_ADDRESSES) assert.equal(a, a.toLowerCase());
});

test('first-party: the check is case-insensitive — it is fed addresses from chain reads and user input', () => {
  const t = bySymbol('USDF');
  assert.equal(isFirstParty(t.address), true);
  assert.equal(isFirstParty(t.address.toLowerCase()), true);
  assert.equal(isFirstParty(t.address.toUpperCase().replace('0X', '0x')), true);
});

test('first-party: an unknown address is not vouched for, and neither is nothing', () => {
  assert.equal(isFirstParty('0x000000000000000000000000000000000000dEaD'), false);
  assert.equal(isFirstParty(undefined), false);
  assert.equal(isFirstParty(null), false);
  assert.equal(isFirstParty(''), false);
});

test('bridged assets carry their origin, so an IOU is never presented as the real asset', () => {
  for (const t of TOKENS) {
    if (!t.bridgedFrom) continue;
    assert.ok(t.bridgedFrom.chainId > 0, `${t.symbol} has no origin chain id`);
    assert.ok(t.bridgedFrom.asset, `${t.symbol} does not name the asset it mirrors`);
    assert.notEqual(t.bridgedFrom.chainId, FERMINUX_CHAIN_ID, `${t.symbol} cannot be bridged from its own chain`);
  }
});

test('chain id is Ferminux — this registry describes 3961 and nothing else', () => {
  // wFMX on BSC shares a name with WFMX here and is a different contract. It is
  // added by the tokenlist generator, deliberately outside this registry.
  assert.equal(FERMINUX_CHAIN_ID, 3961);
  assert.equal(
    TOKENS.some((t) => t.address === '0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0'),
    false,
    "BSC's wFMX must not be listed as a Ferminux token",
  );
});
