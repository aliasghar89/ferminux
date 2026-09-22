// Protocol vectors.
//
// Every constant below was produced by the REAL contracts during test/e2e.mjs
// and is pinned here so a refactor cannot silently change what gets signed:
//
//   transferId       taken from the `Sent` event's indexed topic on chain A
//   digest           cross-checked against FerminuxBridge.hashTransfer() on
//                    chain B before the validator signed it (src/verify.ts)
//   domainSeparator  compared to the live DOMAIN_SEPARATOR() at startup
//
// If one of these changes, signatures produced by this relayer stop verifying
// on chain. There is no "update the fixture" fix; there is only a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes, Wallet } from 'ethers';
import {
  HALF_CURVE_ORDER,
  TRANSFER_TYPEHASH,
  TRANSFER_TYPES,
  digestFor,
  domainFor,
  domainSeparatorFor,
  parseTransfer,
  recoverSigner,
  serializeTransfer,
  toSolidityTuple,
  transferIdOf,
  typedValue,
} from '../src/transfer.ts';

const BRIDGE_B = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const TRANSFER_1 = {
  srcChainId: 3961,
  dstChainId: 56,
  nonce: 1,
  srcToken: '0x0000000000000000000000000000000000000000',
  dstToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  sender: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  recipient: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  amount: 9990000000000000000n,
};
const TRANSFER_1_ID = '0xe68c83e60233111e9eb70f8c32630bec2ebe43abe4d1e278faeb6106f9274b5b';

const TRANSFER_2 = { ...TRANSFER_1, nonce: 2, amount: 3996000000000000000n };
const TRANSFER_2_ID = '0xa4dcdc3b611f8be0fd923ee954a8b413444ca79aed67857edb405b96497e6a69';
const TRANSFER_2_DIGEST = '0xa91f8fa82cacf035f8622d4f7935a766617a1b0ea4a55fddad1d16fbcc610374';

test('TRANSFER_TYPEHASH matches the string in FerminuxBridge.sol', () => {
  const fromContract =
    'BridgeTransfer(bytes32 transferId,uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount)';
  assert.equal(TRANSFER_TYPEHASH, keccak256(toUtf8Bytes(fromContract)));
});

test('transferId matches the id the contract indexed on chain', () => {
  assert.equal(transferIdOf(TRANSFER_1), TRANSFER_1_ID);
  assert.equal(transferIdOf(TRANSFER_2), TRANSFER_2_ID);
});

test('transferId changes when any single field changes', () => {
  const base = transferIdOf(TRANSFER_1);
  const mutations = [
    { ...TRANSFER_1, srcChainId: 3962 },
    { ...TRANSFER_1, dstChainId: 57 },
    { ...TRANSFER_1, nonce: 2 },
    { ...TRANSFER_1, srcToken: '0x0000000000000000000000000000000000000001' },
    { ...TRANSFER_1, dstToken: '0x0000000000000000000000000000000000000002' },
    { ...TRANSFER_1, sender: '0x0000000000000000000000000000000000000003' },
    { ...TRANSFER_1, recipient: '0x0000000000000000000000000000000000000004' },
    { ...TRANSFER_1, amount: TRANSFER_1.amount + 1n },
  ];
  for (const m of mutations) assert.notEqual(transferIdOf(m), base);
});

test('domain separator matches the live DOMAIN_SEPARATOR() on both chains', () => {
  assert.equal(domainSeparatorFor(56, BRIDGE_B), '0xfe032a97a476fada48d914f976463b155a767437197d0dbd91b1fd2dc3a9668c');
  assert.equal(domainSeparatorFor(3961, BRIDGE_B), '0x94b85f714adcc93c25656d2bc0030da1f7695be61693d8e8de7b5854830a8b3e');
});

test('digest matches FerminuxBridge.hashTransfer() for the same transfer', () => {
  assert.equal(digestFor(TRANSFER_2, BRIDGE_B), TRANSFER_2_DIGEST);
});

test('a signature is worthless on another chain or another deployment', () => {
  const onB = digestFor(TRANSFER_2, BRIDGE_B);
  const otherBridge = digestFor(TRANSFER_2, '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
  const otherChain = digestFor({ ...TRANSFER_2, dstChainId: 137 }, BRIDGE_B);
  assert.notEqual(onB, otherBridge, 'same chain, different bridge address must differ');
  assert.notEqual(onB, otherChain, 'same bridge, different chain must differ');
});

test('sign -> recover round trip, and the tuple the contract expects', async () => {
  const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const signature = await wallet.signTypedData(domainFor(56, BRIDGE_B), TRANSFER_TYPES, typedValue(TRANSFER_2));
  assert.equal(recoverSigner(TRANSFER_2_DIGEST, signature), wallet.address);

  const tuple = toSolidityTuple(signature);
  assert.ok(tuple.v === 27 || tuple.v === 28, 'v must be 27 or 28');
  assert.ok(BigInt(tuple.s) <= HALF_CURVE_ORDER, 's must be in the lower half of the curve order');
});

test('a malleable (high-s) signature is rejected, not silently accepted', async () => {
  const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const signature = await wallet.signTypedData(domainFor(56, BRIDGE_B), TRANSFER_TYPES, typedValue(TRANSFER_2));
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const flippedS = (N - s).toString(16).padStart(64, '0');
  const flippedV = signature.slice(130, 132) === '1b' ? '1c' : '1b';
  const malleable = `0x${r}${flippedS}${flippedV}`;
  assert.throws(() => recoverSigner(TRANSFER_2_DIGEST, malleable), /malleable/);
  assert.throws(() => toSolidityTuple(malleable), /malleable/);
});

test('serialize/parse is lossless and parse rejects junk', () => {
  const round = parseTransfer(serializeTransfer(TRANSFER_1));
  assert.deepEqual(round, { ...TRANSFER_1, srcToken: '0x0000000000000000000000000000000000000000' });

  assert.throws(() => parseTransfer(null), /object/);
  assert.throws(() => parseTransfer({ ...serializeTransfer(TRANSFER_1), amount: '0' }), /amount/);
  assert.throws(() => parseTransfer({ ...serializeTransfer(TRANSFER_1), sender: 'nope' }), /sender|address|checksum/i);
  assert.throws(() => parseTransfer({ ...serializeTransfer(TRANSFER_1), srcChainId: '-1' }), /srcChainId/);
});
