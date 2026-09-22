// The configuration gate on the Bridge tab.
//
// This exists because of a real outage rather than for coverage. The bridge app
// at ferminux.net/bridge/ was built with no VITE_BRIDGE_* set, so every chain
// failed the same address test, the app had nothing to route between, and it
// served an empty shell for weeks. Nothing failed and nothing said anything:
// an unconfigured chain looks exactly like a chain that is not live yet.
//
// The panel now refuses to render a form it cannot honour, and this pins the
// predicate that decides it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BSC, FERMINUX, isConfigured, otherChain } from '../src/lib/bridgeChains.ts';

const REAL = '0xe162eeDa683f067d4Ebf61060Fa322332a779EF4';

function withAddress(chain, bridgeAddress) {
  return { ...chain, bridgeAddress };
}

test('configured: a 40-hex address is the only thing that counts as deployed', () => {
  assert.equal(isConfigured(withAddress(FERMINUX, REAL)), true);
});

test('configured: an unset address is NOT configured — the outage in one line', () => {
  assert.equal(isConfigured(withAddress(FERMINUX, '')), false);
});

test('configured: near-misses are refused, not coerced', () => {
  for (const bad of [
    '0x', // the prefix alone
    'e162eeDa683f067d4Ebf61060Fa322332a779EF4', // no 0x
    '0xe162eeDa683f067d4Ebf61060Fa322332a779EF', // 39 nibbles
    '0xe162eeDa683f067d4Ebf61060Fa322332a779EF4A', // 41 nibbles
    '0xZZ62eeDa683f067d4Ebf61060Fa322332a779EF4', // not hex
    '  ', // whitespace, which .trim() in the config turns into empty
  ]) {
    assert.equal(isConfigured(withAddress(BSC, bad)), false, `${JSON.stringify(bad)} must not pass`);
  }
});

test('configured: case is not significant — EIP-55 checksums mix both', () => {
  assert.equal(isConfigured(withAddress(BSC, REAL.toLowerCase())), true);
  assert.equal(isConfigured(withAddress(BSC, REAL.toUpperCase().replace('0X', '0x'))), true);
});

test('direction: the two chains are each other’s counterpart', () => {
  assert.equal(otherChain(FERMINUX).key, BSC.key);
  assert.equal(otherChain(BSC).key, FERMINUX.key);
});

test('direction: flipping twice returns to the start, so the toggle cannot strand a user', () => {
  assert.equal(otherChain(otherChain(FERMINUX)).key, FERMINUX.key);
  assert.equal(otherChain(otherChain(BSC)).key, BSC.key);
});

test('chains: the ids and hex ids agree, or wallet_switchEthereumChain silently targets the wrong network', () => {
  assert.equal(FERMINUX.chainId, Number(FERMINUX.chainIdHex));
  assert.equal(BSC.chainId, Number(BSC.chainIdHex));
  assert.equal(BSC.chainId, 56);
});

test('chains: each end has at least one RPC and an explorer with no trailing slash', () => {
  for (const c of [FERMINUX, BSC]) {
    assert.ok(c.rpcUrls.length > 0, `${c.key} has no RPC`);
    assert.ok(c.rpcUrls.every((u) => u.startsWith('https://')), `${c.key} has a non-https RPC`);
    assert.equal(c.explorerUrl.endsWith('/'), false, `${c.key} explorer has a trailing slash`);
  }
});
