// The wallet's chain list must match the pay-in chains the gateway accepts —
// same ids, same explorers, same native coins, same USDC/USDT contracts and
// decimals. payin.ts is server code (fastify, sqlite), so it is read as text
// here rather than imported; any drift between the two fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'ethers';
import {
  CHAINS,
  FERMINUX_CHAIN,
  FOREIGN_CHAINS,
  caip2,
  chainById,
  chainLabel,
  chainNamesSentence,
  explorerTxUrl,
  parseCaip2,
} from '../src/lib/chains.ts';
import { DEFAULT_TOKENS } from '../src/config.ts';

const PAYIN = readFileSync(new URL('../../agents/gateway/src/v3/payin.ts', import.meta.url), 'utf8');

/** Parse PAYIN_CHAINS out of the source: slug → { chainId, name, explorer, native, assets }. */
function payinChains() {
  const block = PAYIN.slice(PAYIN.indexOf('export const PAYIN_CHAINS'), PAYIN.indexOf('} as const;'));
  const out = {};
  const re = /\n  (\w+): \{\n    chainId: (\d+), name: "([^"]+)", explorer: "([^"]+)", native: "(\w+)"[^\n]*\n    assets: \{\n([\s\S]*?)\n    \}/g;
  for (const m of block.matchAll(re)) {
    const assets = {};
    for (const a of m[6].matchAll(/(\w+): \{ kind: "(\w+)", address: (?:"(0x[0-9a-fA-F]{40})"|null), decimals: (\d+)/g)) {
      assets[a[1]] = { kind: a[2], address: a[3] ?? null, decimals: Number(a[4]) };
    }
    out[m[1]] = { chainId: Number(m[2]), name: m[3], explorer: m[4], native: m[5], assets };
  }
  return out;
}

test('the parser really read seven pay-in chains (guards against a vacuous comparison)', () => {
  const p = payinChains();
  assert.deepEqual(Object.keys(p), ['eth', 'bsc', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche']);
  for (const c of Object.values(p)) assert.equal(Object.keys(c.assets).length, 3);
});

test('every pay-in chain is in the wallet with the same id, name, explorer, native coin and stables', () => {
  const p = payinChains();
  assert.equal(FOREIGN_CHAINS.length, Object.keys(p).length);
  for (const [slug, want] of Object.entries(p)) {
    const got = FOREIGN_CHAINS.find((c) => c.key === slug);
    assert.ok(got, `wallet is missing pay-in chain ${slug}`);
    assert.equal(got.id, want.chainId, slug);
    assert.equal(got.name, want.name, slug);
    assert.equal(got.explorer.url, want.explorer, slug);
    assert.equal(got.native.symbol, want.native, slug);
    assert.equal(got.native.decimals, want.assets[want.native].decimals, slug);
    for (const sym of ['USDC', 'USDT']) {
      const t = got.tokens.find((x) => x.symbol === sym);
      assert.ok(t, `${slug} ${sym}`);
      assert.equal(t.address, want.assets[sym].address, `${slug} ${sym} address`);
      assert.equal(t.decimals, want.assets[sym].decimals, `${slug} ${sym} decimals`);
    }
  }
});

test('Ferminux is first, uses the configured RPC/explorer, and lists the shared FRC-20 registry', () => {
  assert.equal(CHAINS[0], FERMINUX_CHAIN);
  assert.equal(FERMINUX_CHAIN.id, 3961);
  assert.equal(FERMINUX_CHAIN.native.symbol, 'FMX');
  assert.equal(FERMINUX_CHAIN.multicall3, false, 'Multicall3 is not deployed on 3961');
  assert.deepEqual(
    FERMINUX_CHAIN.tokens.map((t) => t.symbol),
    DEFAULT_TOKENS.map((t) => t.symbol),
  );
  for (const s of ['USDF', 'AZNT', 'WFMX']) assert.ok(FERMINUX_CHAIN.tokens.some((t) => t.symbol === s), s);
});

test('chain definitions are well-formed: unique ids, checksummed tokens, https endpoints, two RPCs each', () => {
  assert.equal(new Set(CHAINS.map((c) => c.id)).size, CHAINS.length);
  for (const c of FOREIGN_CHAINS) {
    assert.ok(c.rpcUrls.length >= 2, `${c.key} has a fallback RPC`);
    for (const u of c.rpcUrls) assert.match(u, /^https:\/\//);
    assert.match(c.explorer.url, /^https:\/\/[^/]+$/);
    assert.equal(c.multicall3, true);
    for (const t of c.tokens) assert.equal(t.address, getAddress(t.address));
  }
  assert.deepEqual(
    CHAINS.filter((c) => c.opStackL1Fee).map((c) => c.key),
    ['base', 'optimism'],
  );
});

test('lookups, labels and CAIP-2 round trips', () => {
  assert.equal(chainById(56).name, 'BNB Smart Chain');
  assert.equal(chainById(999), undefined);
  assert.equal(chainLabel(42161), 'Arbitrum One (42161)');
  assert.equal(chainLabel(7), 'chain 7');
  assert.equal(caip2(8453), 'eip155:8453');
  assert.equal(parseCaip2('eip155:3961'), 3961);
  assert.equal(parseCaip2('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), null);
  assert.equal(parseCaip2('eip155:0'), null);
  assert.equal(parseCaip2('eip155:abc'), null);
  assert.equal(explorerTxUrl(chainById(10), '0xabc'), 'https://optimistic.etherscan.io/tx/0xabc');
  assert.equal(chainNamesSentence(CHAINS.slice(0, 3)), 'Ferminux, Ethereum and BNB Smart Chain');
});
