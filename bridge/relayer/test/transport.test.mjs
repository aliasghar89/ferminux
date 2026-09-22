// Signature transport verification.
//
// This is the boundary where untrusted bytes from another machine become a
// signature this node will put in a transaction. Every test here is an attempt
// to get something past it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { buildPayload, verifyPayload } from '../src/transport.ts';
import { TRANSFER_TYPES, digestFor, domainFor, typedValue } from '../src/transfer.ts';

const BRIDGE_B = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TRANSFER = {
  srcChainId: 3961,
  dstChainId: 56,
  nonce: 2,
  srcToken: '0x0000000000000000000000000000000000000000',
  dstToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  sender: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  recipient: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  amount: 3996000000000000000n,
};
const TRANSFER_ID = '0xa4dcdc3b611f8be0fd923ee954a8b413444ca79aed67857edb405b96497e6a69';
const VALIDATOR = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ATTACKER = new Wallet('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');

const expected = { transferId: TRANSFER_ID, transfer: TRANSFER, dstBridgeAddress: BRIDGE_B };

async function sign(wallet, transfer = TRANSFER, bridge = BRIDGE_B, chainId = transfer.dstChainId) {
  return wallet.signTypedData(domainFor(chainId, bridge), TRANSFER_TYPES, typedValue(transfer));
}

test('a well-formed payload verifies and recovers the real signer', async () => {
  const sig = await sign(VALIDATOR);
  const payload = buildPayload(TRANSFER, TRANSFER_ID, digestFor(TRANSFER, BRIDGE_B), VALIDATOR.address, sig);
  const result = verifyPayload(payload, expected);
  assert.equal(result.signer, VALIDATOR.address);
  assert.equal(result.signature, sig);
});

test('the claimed signer field is never trusted', async () => {
  const sig = await sign(ATTACKER);
  const payload = buildPayload(TRANSFER, TRANSFER_ID, digestFor(TRANSFER, BRIDGE_B), VALIDATOR.address, sig);
  assert.throws(() => verifyPayload(payload, expected), /claims signer .* recovers to/);
});

test('a payload for a different transfer id is refused', async () => {
  const sig = await sign(VALIDATOR);
  const payload = buildPayload(TRANSFER, TRANSFER_ID, digestFor(TRANSFER, BRIDGE_B), VALIDATOR.address, sig);
  payload.transferId = `0x${'11'.repeat(32)}`;
  assert.throws(() => verifyPayload(payload, expected), /not the one requested/);
});

test('a peer that alters one field of the transfer is caught', async () => {
  const tampered = { ...TRANSFER, recipient: ATTACKER.address };
  const sig = await sign(VALIDATOR, tampered);
  const payload = buildPayload(tampered, TRANSFER_ID, digestFor(tampered, BRIDGE_B), VALIDATOR.address, sig);
  assert.throws(() => verifyPayload(payload, expected), /hashes to|transfer\.recipient/);
});

test('a signature made for another chain does not verify here', async () => {
  const sig = await sign(VALIDATOR, TRANSFER, BRIDGE_B, 137);
  const payload = buildPayload(TRANSFER, TRANSFER_ID, digestFor(TRANSFER, BRIDGE_B), VALIDATOR.address, sig);
  assert.throws(() => verifyPayload(payload, expected), /recovers to/);
});

test('a signature made for another bridge deployment does not verify here', async () => {
  const sig = await sign(VALIDATOR, TRANSFER, '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
  const payload = buildPayload(TRANSFER, TRANSFER_ID, digestFor(TRANSFER, BRIDGE_B), VALIDATOR.address, sig);
  assert.throws(() => verifyPayload(payload, expected), /recovers to/);
});

test('a peer that reports a different digest than we compute is refused', async () => {
  const sig = await sign(VALIDATOR);
  const payload = buildPayload(TRANSFER, TRANSFER_ID, `0x${'22'.repeat(32)}`, VALIDATOR.address, sig);
  assert.throws(() => verifyPayload(payload, expected), /peer signed digest/);
});

test('junk shapes are refused rather than crashing', () => {
  assert.throws(() => verifyPayload(null, expected), /not an object/);
  assert.throws(() => verifyPayload({}, expected), /65-byte hex/);
  assert.throws(() => verifyPayload({ signature: '0x1234' }, expected), /65-byte hex/);
  assert.throws(
    () => verifyPayload({ signature: `0x${'ab'.repeat(65)}`, transferId: TRANSFER_ID, transfer: 'nope' }, expected),
    /transfer must be an object/,
  );
});
