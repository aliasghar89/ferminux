// The shipped default must be a working app.
//
// This is a regression test for an outage, not a unit test for a regex. The
// bundle served at ferminux.net/bridge/ was built with no VITE_BRIDGE_* set,
// because `.env.*` is gitignored and the addresses existed only in an untracked
// file on whoever built last. Every chain failed isChainLive(), liveChains()
// came back empty, defaultRoute() needs two and returned null, and the page
// rendered an empty shell — with no error anywhere, because a chain with no
// address is indistinguishable from a chain that is not deployed yet.
//
// The deployed addresses are tracked constants now. These tests fail if anyone
// puts them back behind env alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAINS, chainById, isChainLive, liveChains } from '../src/config.ts';

test('shipped default: at least two chains are live, or the app has no route to offer', () => {
  const live = liveChains();
  assert.ok(live.length >= 2, `defaultRoute() needs two live chains, got ${live.length}: ${live.map((c) => c.key)}`);
});

test('shipped default: the live pair is exactly the deployed FMX <-> wFMX route', () => {
  const keys = liveChains().map((c) => c.key).sort();
  assert.deepEqual(keys, ['bsc', 'ferminux']);
});

test('shipped default: both live chains carry a real 40-hex address, not a placeholder', () => {
  for (const c of liveChains()) {
    assert.match(c.bridgeAddress, /^0x[0-9a-fA-F]{40}$/, `${c.key} has no usable address`);
    assert.notEqual(c.bridgeAddress, `0x${'0'.repeat(40)}`, `${c.key} is the zero address`);
  }
});

test('undeployed chains stay dark, so "live" keeps meaning deployed', () => {
  for (const key of ['ethereum', 'polygon', 'arbitrum', 'base']) {
    const c = CHAINS.find((x) => x.key === key);
    assert.ok(c, `${key} should still be listed as a possible chain`);
    assert.equal(isChainLive(c), false, `${key} has no deployment and must not read as live`);
  }
});

test('the live chains resolve by id — the lookup the wallet uses after a network switch', () => {
  for (const c of liveChains()) {
    assert.equal(chainById(c.chainId)?.key, c.key);
  }
  assert.equal(chainById(3961)?.key, 'ferminux');
  assert.equal(chainById(56)?.key, 'bsc');
});
