// The registry read, and the one struct whose SHAPE has moved.
//
// TokenConfig briefly carried a `lossy` bool for the LOSSY token class. v1
// settles STRICT only and the field is gone. This app's ABI is hand-written, so
// without a check here nothing ties it to the Solidity source — and the failure
// mode is the worst kind for a UI: `contract.tokenConfig()` against a tuple it
// did not expect throws a buffer overrun inside the Promise.all in
// readRegistry(), which is not "one token looks odd", it is an empty app.
//
// So the read is driven by the RETURN DATA (decodeTokenConfig), and the layout
// is checked against contracts/src/FerminuxBridge.sol itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Interface, getAddress } from 'ethers';

import { BRIDGE_ABI, decodeTokenConfig } from '../src/lib/abi.ts';

const CONTRACT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'src', 'FerminuxBridge.sol');
const coder = AbiCoder.defaultAbiCoder();

const V1 = ['uint8', 'bool', 'uint64', 'address', 'uint256', 'uint256'];
const WITH_LOSSY = ['uint8', 'bool', 'bool', 'uint64', 'address', 'uint256', 'uint256'];

const SAMPLE = {
  kind: 2,
  paused: true,
  remoteChainId: 3961,
  remoteToken: getAddress(`0x${'ab'.repeat(20)}`),
  maxPerTransfer: 25_000n * 10n ** 18n,
  dailyCap: 100_000n * 10n ** 18n,
};

const encodeV1 = () =>
  coder.encode(V1, [SAMPLE.kind, SAMPLE.paused, SAMPLE.remoteChainId, SAMPLE.remoteToken, SAMPLE.maxPerTransfer, SAMPLE.dailyCap]);
const encodeLegacy = (lossy) =>
  coder.encode(WITH_LOSSY, [
    SAMPLE.kind,
    SAMPLE.paused,
    lossy,
    SAMPLE.remoteChainId,
    SAMPLE.remoteToken,
    SAMPLE.maxPerTransfer,
    SAMPLE.dailyCap,
  ]);

/** The Solidity member types of `struct TokenConfig`, read from the source. */
function structFromSource() {
  const body = /struct TokenConfig\s*\{([^}]*)\}/.exec(readFileSync(CONTRACT, 'utf8'));
  assert.ok(body, 'struct TokenConfig not found in FerminuxBridge.sol');
  return body[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.endsWith(';'))
    .map((line) => {
      const [type] = line.replace(/;$/, '').split(/\s+/);
      return type === 'TokenKind' ? 'uint8' : type; // the enum is a uint8 on the wire
    });
}

test('tokenConfig: the layout this app decodes is the struct in FerminuxBridge.sol', () => {
  assert.deepEqual(structFromSource(), V1, 'the contract struct and this app have drifted — fix the layout, not this test');
});

test('tokenConfig: the ABI fragment carries the same six fields, and no lossy', () => {
  const out = new Interface(BRIDGE_ABI).getFunction('tokenConfig').outputs[0];
  assert.deepEqual(out.components.map((c) => c.type), V1);
  assert.deepEqual(out.components.map((c) => c.name), ['kind', 'paused', 'remoteChainId', 'remoteToken', 'maxPerTransfer', 'dailyCap']);
});

test('tokenConfig: the current six-field answer decodes', () => {
  const cfg = decodeTokenConfig(encodeV1());
  assert.deepEqual(cfg, SAMPLE);
});

test('tokenConfig: a pre-v1 answer that still carries lossy does not break the app', () => {
  for (const lossy of [false, true]) {
    // The shorter/longer tuple is the whole finding: this must READ, not throw,
    // and it must not read remoteChainId out of the retired bool.
    assert.deepEqual(decodeTokenConfig(encodeLegacy(lossy)), SAMPLE);
  }
});

test('tokenConfig: an answer of neither shape is reported, not rendered', () => {
  const nine = coder.encode([...WITH_LOSSY, 'uint256', 'uint256'], [1, false, false, 1, SAMPLE.remoteToken, 1n, 2n, 3n, 4n]);
  assert.throws(() => decodeTokenConfig(nine), /returned 9 field\(s\); this app understands 6/);
  assert.throws(() => decodeTokenConfig('0x'), /returned no data/);
  assert.throws(() => decodeTokenConfig('0x1234'), /not a whole number of words/);
  assert.throws(() => decodeTokenConfig(undefined), /did not return hex data/);
});
