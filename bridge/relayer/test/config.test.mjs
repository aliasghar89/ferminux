// Config parsing. Every one of these is a refusal to start, not a warning:
// a bridge relayer that boots with a half-understood config signs something
// nobody intended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSECURE_ACKNOWLEDGEMENT, chainById, limitFor, parseConfig } from '../src/config.ts';
import { groupEndpoints, identify } from '../src/independence.ts';
import { ROOT } from './helpers.mjs';

const BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

// Three endpoints per chain, on three registrable domains — the shape a
// production config is now required to have. Two would be refused: the floor is
// 2, so losing one provider would stop this node signing altogether.
function base(overrides = {}) {
  return JSON.stringify({
    network: 'test',
    chains: [
      {
        name: 'a',
        chainId: 3961,
        rpcUrls: ['http://node-a1.example:8545', 'http://node-a2.example:8545', 'http://node-a3.example:8545'],
        bridgeAddress: BRIDGE,
        confirmations: 3,
        limits: { default: { maxPerTransfer: '10', dailyCap: '100' }, tokens: {} },
      },
      {
        name: 'b',
        chainId: 56,
        rpcUrls: ['http://node-b1.example:8545', 'http://node-b2.example:8545', 'http://node-b3.example:8545'],
        bridgeAddress: BRIDGE,
        confirmations: 3,
        limits: { default: { maxPerTransfer: '10', dailyCap: '100' }, tokens: {} },
      },
    ],
    // The generic fixtures are gadget-less chains in plain count mode, which a
    // production config is now refused for (see 'an enabled chain without a
    // finality gadget must name its finality mode' below). Said explicitly.
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowCountFinalityWithoutGadget: true },
    ...overrides,
  });
}

test('the shipped example parses', () => {
  const path = join(ROOT, 'config', 'chains.example.json');
  const cfg = parseConfig(readFileSync(path, 'utf8'), path);
  assert.equal(cfg.chains.length, 11);
  assert.ok(chainById(cfg, 3961), 'Ferminux 3961 is present');
  assert.equal(chainById(cfg, 3961).confirmations, 64);
  assert.equal(chainById(cfg, 1).finalityTag, 'finalized');
  assert.equal(chainById(cfg, 137).confirmations, 128);
});

// The finding this closes: the file shipped TWO endpoints per chain against a
// floor of two, so killing one provider stopped a validator signing — the exact
// exploit, against the default configuration. Every chain now carries three
// providers, and this test switches them all on to prove the file passes the
// rules it will be held to on the day somebody sets enabled=true.
test('the shipped example survives being switched on: three independent providers per chain', () => {
  const path = join(ROOT, 'config', 'chains.example.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const chain of raw.chains) {
    chain.enabled = true;
    chain.bridgeAddress = BRIDGE;
    // The checkpoint registry is a placeholder for the same reason bridgeAddress
    // is: not deployed yet. Enabling without filling it in is refused (below).
    if (chain.finality?.checkpoint) chain.finality.checkpoint.registryAddress = BRIDGE;
  }
  const cfg = parseConfig(JSON.stringify(raw), path);
  assert.equal(cfg.chains.length, 11);
  const fmx = chainById(cfg, 3961);
  assert.equal(fmx.finality.mode, 'work-and-time', 'Ferminux ships with work-and-time, not a bare count');
  assert.equal(fmx.finality.checkpoint.registryChainId, 56, 'and a checkpoint registry on BSC');
  assert.equal(fmx.confirmations, 64, 'the 64-block floor is untouched');
  for (const chain of cfg.chains) {
    const groups = groupEndpoints(identify(chain.rpcUrls));
    const largest = Math.max(...groups.map((g) => g.urls.length));
    assert.ok(chain.rpcUrls.length >= 3, `${chain.name} ships only ${chain.rpcUrls.length} endpoint(s)`);
    assert.equal(groups.length, 3, `${chain.name} has ${groups.length} independent provider(s): ${groups.map((g) => g.label).join(', ')}`);
    assert.equal(chain.minAgreeingEndpoints, 2, `${chain.name}: a majority of three providers is two`);
    assert.ok(largest < chain.minAgreeingEndpoints, `${chain.name}: no single provider may meet the floor alone`);
    assert.ok(
      chain.rpcUrls.length - largest >= chain.minAgreeingEndpoints,
      `${chain.name}: losing one provider must still leave the floor reachable`,
    );
  }
});

test('the shipped example refuses to enable Ferminux while the checkpoint registry is a placeholder', () => {
  const path = join(ROOT, 'config', 'chains.example.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const chain of raw.chains) {
    chain.enabled = true;
    chain.bridgeAddress = BRIDGE;
  }
  assert.throws(() => parseConfig(JSON.stringify(raw), path), /checkpoint\.registryAddress: must be the CheckpointRegistry address/);
});

test('unknown keys are a hard error, not silently ignored', () => {
  assert.throws(() => parseConfig(base({ confirmations: 3 }), 'x'), /not a known setting/);
  const withTypo = JSON.parse(base());
  withTypo.chains[0].confirmation = 3;
  assert.throws(() => parseConfig(JSON.stringify(withTypo), 'x'), /confirmation.*not a known setting/);
});

test('keys starting with _ or $ are treated as comments', () => {
  const cfg = JSON.parse(base());
  cfg._note = 'hello';
  cfg.chains[0]._why = 'because';
  cfg.$schema = './x.json';
  assert.doesNotThrow(() => parseConfig(JSON.stringify(cfg), 'x'));
});

test('an enabled chain must carry a real bridge address', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].bridgeAddress = '';
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /valid address/);
  cfg.chains[0].bridgeAddress = '0x0000000000000000000000000000000000000000';
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /zero address/);
});

test('a disabled chain may hold an empty slot', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].bridgeAddress = '';
  cfg.chains[0].enabled = false;
  assert.doesNotThrow(() => parseConfig(JSON.stringify(cfg), 'x'));
});

test('zero confirmations is refused unless a finality tag replaces them', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].confirmations = 0;
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /zero-confirmation bridging/);
  cfg.chains[0].finalityTag = 'finalized';
  assert.doesNotThrow(() => parseConfig(JSON.stringify(cfg), 'x'));
});

test('confirmations must be stated explicitly for an enabled chain', () => {
  const cfg = JSON.parse(base());
  delete cfg.chains[0].confirmations;
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /required/);
});

test('duplicate chain ids are refused', () => {
  const cfg = JSON.parse(base());
  cfg.chains[1].chainId = 3961;
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /duplicate chainId/);
});

test('amounts must be decimal strings in the smallest unit', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].limits.default.maxPerTransfer = 1e21;
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /quoted strings/);
  cfg.chains[0].limits.default.maxPerTransfer = '10.5';
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /decimal string/);
});

test('a daily cap below the per-transfer cap is a contradiction', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].limits.default = { maxPerTransfer: '100', dailyCap: '10' };
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /must be >= maxPerTransfer/);
});

test('per-token limits override the chain default', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].limits.tokens = { '0x0000000000000000000000000000000000000000': { maxPerTransfer: '5', dailyCap: '50' } };
  const parsed = parseConfig(JSON.stringify(cfg), 'x');
  const chain = chainById(parsed, 3961);
  assert.equal(limitFor(chain, '0x0000000000000000000000000000000000000000').maxPerTransfer, 5n);
  assert.equal(limitFor(chain, '0x1111111111111111111111111111111111111111').maxPerTransfer, 10n);
});

test('environment overrides replace RPCs and bridge addresses per chain', () => {
  process.env.FMX_RELAYER_RPC_3961 = 'http://env-a.example:9,http://env-b.example:10,http://env-c.example:11';
  process.env.FMX_RELAYER_BRIDGE_3961 = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
  try {
    const parsed = parseConfig(base(), 'x');
    const chain = chainById(parsed, 3961);
    assert.deepEqual(chain.rpcUrls, ['http://env-a.example:9', 'http://env-b.example:10', 'http://env-c.example:11']);
    assert.equal(chain.bridgeAddress, '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
  } finally {
    delete process.env.FMX_RELAYER_RPC_3961;
    delete process.env.FMX_RELAYER_BRIDGE_3961;
  }
});

test('escalationPct below 10 is refused — a smaller bump cannot replace a tx', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].gas = { escalationPct: 5 };
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /between 10 and 500/);
});

test('a pinned domain separator must be 32 bytes of hex', () => {
  const cfg = JSON.parse(base());
  cfg.chains[0].domainSeparator = '0x1234';
  assert.throws(() => parseConfig(JSON.stringify(cfg), 'x'), /32-byte hex/);
});
