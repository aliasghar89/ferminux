// The chain registry: endpoints and confirmation counts.
//
// Both of these have been wrong in a shipped build. The confirmation table told
// users a Ferminux transfer had settled at 12 blocks while no validator would
// sign before 64; the endpoint list carried two providers per chain, and two of
// them had stopped answering altogether (eth.llamarpc.com, polygon-rpc.com).
//
// This app's list is an ordered FALLBACK — the first endpoint that answers with
// the right chain id wins — so a dead entry costs a probe timeout rather than a
// witness. That is still worth a test, because the list is also what
// check-dist.mjs derives the network allowlist from, and because the numbers
// below have to keep matching the relayer's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAINS, FALLBACK_CONFIRMATIONS, RELAYER_CONFIRMATIONS, chainByKey } from '../src/config.ts';

/** Endpoints that were shipped here and no longer answer. */
const RETIRED = ['eth.llamarpc.com', 'polygon-rpc.com', 'rpc.ankr.com'];

test('every remote chain offers at least three RPC endpoints to fall back through', () => {
  for (const chain of CHAINS.filter((c) => c.key !== 'ferminux')) {
    assert.ok(
      chain.rpcUrls.length >= 3,
      `${chain.key} lists ${chain.rpcUrls.length} endpoint(s): ${chain.rpcUrls.join(', ')}`,
    );
  }
});

test('the home chain has one operator, and the list does not pretend otherwise', () => {
  // rpc.ferminux.net and ferminux.net are the same machine, so
  // these two URLs are a fallback against a broken vhost or path, not against an
  // operator outage. That is acceptable for a read-only app and NOT acceptable
  // for a validator: relayer/config/chains.example.json lists only one of them
  // and requires two operator-run nodes alongside it.
  assert.deepEqual(chainByKey('ferminux').rpcUrls, ['https://rpc.ferminux.net', 'https://ferminux.net/rpc']);
});

test('endpoints known to be dead do not come back', () => {
  for (const chain of CHAINS) {
    for (const url of chain.rpcUrls) {
      const host = new URL(url).host;
      assert.ok(!RETIRED.includes(host), `${chain.key} lists retired endpoint ${host}`);
    }
  }
});

test('every endpoint is an https URL, or Ferminux-local plain http', () => {
  for (const chain of CHAINS) {
    for (const url of chain.rpcUrls) {
      assert.match(url, /^https:\/\//, `${chain.key}: ${url} must be TLS — a wallet page on http mixed content is broken anyway`);
    }
  }
});

test('the confirmation table matches the relayer, Ferminux deepest of all', () => {
  assert.equal(RELAYER_CONFIRMATIONS.ferminux, 64, 'the node\'s 64-block reorg cap at 7 s blocks: ~7.5 minutes');
  assert.equal(chainByKey('ferminux').confirmations, 64);
  assert.equal(chainByKey('ethereum').confirmations, 32);
  assert.equal(chainByKey('polygon').confirmations, 128);
  assert.equal(chainByKey('arbitrum').confirmations, 300);
  assert.equal(chainByKey('base').confirmations, 180);
  assert.equal(chainByKey('bsc').confirmations, 20);
  assert.equal(
    FALLBACK_CONFIRMATIONS,
    Math.max(...Object.values(RELAYER_CONFIRMATIONS)),
    'an unknown chain gets the DEEPEST wait, because guessing low understates reorg risk',
  );
});
