// The registry read, and the one struct whose SHAPE has moved.
//
// TokenConfig briefly carried a `lossy` bool for the LOSSY token class. v1
// settles STRICT only and the field is gone, which makes this the first struct
// in the contract to have changed arity — and an ABI in this repo is
// hand-written, so nothing else pins it to the Solidity source.
//
// Two things are proved here:
//
//   1. the layout this relayer decodes is EXACTLY the struct in
//      contracts/src/FerminuxBridge.sol, checked against the source itself, so
//      a future field cannot be added on one side only
//   2. decoding is driven by the RETURN DATA, not by faith in the fragment: a
//      pre-v1 deployment still reads correctly, and anything else is named
//      rather than mis-decoded into a plausible-looking wrong answer
//
// (2) matters because the failure it replaces is silent. Decoding six words out
// of seven yields kind=CANONICAL, paused=false, remoteChainId=0 and a
// remoteToken of 0x...0038 — a registry that looks readable and routes nowhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Interface, getAddress } from 'ethers';

import { BRIDGE_ABI, decodeTokenConfig } from '../src/abi.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = resolve(HERE, '..', '..', 'contracts', 'src', 'FerminuxBridge.sol');
const coder = AbiCoder.defaultAbiCoder();

const V1 = ['uint8', 'bool', 'uint64', 'address', 'uint256', 'uint256'];
const WITH_LOSSY = ['uint8', 'bool', 'bool', 'uint64', 'address', 'uint256', 'uint256'];

const SAMPLE = {
  kind: 1,
  paused: false,
  remoteChainId: 56,
  remoteToken: getAddress(`0x${'22'.repeat(20)}`),
  maxPerTransfer: 25_000n * 10n ** 18n,
  dailyCap: 100_000n * 10n ** 18n,
};

const encodeV1 = (o = SAMPLE) => coder.encode(V1, [o.kind, o.paused, o.remoteChainId, o.remoteToken, o.maxPerTransfer, o.dailyCap]);
const encodeLegacy = (lossy, o = SAMPLE) =>
  coder.encode(WITH_LOSSY, [o.kind, o.paused, lossy, o.remoteChainId, o.remoteToken, o.maxPerTransfer, o.dailyCap]);

/** The Solidity member types of `struct TokenConfig`, read from the source. */
function structFromSource() {
  const src = readFileSync(CONTRACT, 'utf8');
  const body = /struct TokenConfig\s*\{([^}]*)\}/.exec(src);
  assert.ok(body, 'struct TokenConfig not found in FerminuxBridge.sol');
  return body[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.endsWith(';'))
    .map((line) => {
      const [type] = line.replace(/;$/, '').split(/\s+/);
      // The enum is a uint8 on the wire; everything else is already an ABI type.
      return type === 'TokenKind' ? 'uint8' : type;
    });
}

test('tokenConfig: the decoded layout is the struct in FerminuxBridge.sol, member for member', () => {
  assert.deepEqual(
    structFromSource(),
    V1,
    'the contract struct and the layout this relayer decodes have drifted — fix the layout, not this test',
  );
});

test('tokenConfig: the ethers fragment agrees with the same struct', () => {
  // The fragment is what bridge.tokenConfig() would decode through. It is no
  // longer on the read path, but leaving it wrong would be a trap for the next
  // caller who reaches for it.
  const out = new Interface(BRIDGE_ABI).getFunction('tokenConfig').outputs[0];
  assert.deepEqual(out.components.map((c) => c.type), V1);
  assert.deepEqual(out.components.map((c) => c.name), ['kind', 'paused', 'remoteChainId', 'remoteToken', 'maxPerTransfer', 'dailyCap']);
  assert.ok(!out.components.some((c) => c.name === 'lossy'), 'the LOSSY class is gone from the contract; it is gone from here');
});

test('tokenConfig: a v1 answer round-trips', () => {
  const cfg = decodeTokenConfig(encodeV1());
  assert.equal(cfg.kind, 1n);
  assert.equal(cfg.paused, false);
  assert.equal(cfg.remoteChainId, 56n);
  assert.equal(cfg.remoteToken, SAMPLE.remoteToken);
  assert.equal(cfg.maxPerTransfer, SAMPLE.maxPerTransfer);
  assert.equal(cfg.dailyCap, SAMPLE.dailyCap);
});

test('tokenConfig: a pre-v1 answer with the removed lossy bool still reads correctly', () => {
  for (const lossy of [false, true]) {
    const cfg = decodeTokenConfig(encodeLegacy(lossy));
    assert.equal(cfg.remoteChainId, 56n, 'remoteChainId is read from where it actually is, not from the retired bool');
    assert.equal(cfg.remoteToken, SAMPLE.remoteToken);
    assert.equal(cfg.maxPerTransfer, SAMPLE.maxPerTransfer);
    assert.equal(cfg.dailyCap, SAMPLE.dailyCap);
    assert.ok(!('lossy' in cfg), 'and the retired field is not carried forward into this build');
  }
});

test('tokenConfig: mis-decoding the older shape is exactly what this avoids', () => {
  // What the fragment alone would have produced: six of seven words.
  const wrong = coder.decode(V1, encodeLegacy(false).slice(0, 2 + 6 * 64));
  assert.equal(Number(wrong[2]), 0, 'remoteChainId read out of the lossy bool');
  assert.notEqual(getAddress(String(wrong[3])), SAMPLE.remoteToken, 'and remoteToken read out of remoteChainId');
});

test('tokenConfig: an unknown arity is named, not guessed at', () => {
  const eight = coder.encode([...WITH_LOSSY, 'uint256'], [1, false, false, 56, SAMPLE.remoteToken, 1n, 2n, 3n]);
  assert.throws(() => decodeTokenConfig(eight), /returned 8 field\(s\); this relayer understands 6/);
});

test('tokenConfig: no code at the address is a sentence, not a buffer overrun', () => {
  assert.throws(() => decodeTokenConfig('0x'), /returned no data/);
  assert.throws(() => decodeTokenConfig('0xdeadbeef'), /not a whole number of words/);
  assert.throws(() => decodeTokenConfig('nonsense'), /not hex data/);
});
