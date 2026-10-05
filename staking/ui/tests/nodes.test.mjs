// enode parsing, the node identity and possession proof NodeRegistry checks,
// and register-form validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SigningKey, Wallet, concat, getBytes, keccak256, toBeHex, toUtf8Bytes, zeroPadValue } from 'ethers';
import {
  parseEnode,
  enodePubkeyBytes,
  enodeToNodeAddress,
  registrationDigest,
  checkPossessionSignature,
  checkConsensusAddress,
} from '../src/lib/nodes.ts';

const PUBKEY =
  'a979fb575495b8d6db44f750317d0f4622bf4c2aa3365d6af7c284339968eef29b69ad0dce72a4d8db5ebb4968de0e3bec910127f134779fbcb0cb6d3331163c';
const ENODE = `enode://${PUBKEY}@203.0.113.7:30303`;

test('nodes: parses a well-formed enode URL', () => {
  const parsed = parseEnode(ENODE);
  assert.ok(parsed);
  assert.equal(parsed.pubkey, PUBKEY.toLowerCase());
  assert.equal(parsed.host, '203.0.113.7');
  assert.equal(parsed.port, 30_303);
});

test('nodes: accepts a discport query and surrounding whitespace', () => {
  const parsed = parseEnode(`  ${ENODE}?discport=30301  `);
  assert.ok(parsed);
  assert.equal(parsed.port, 30_303);
});

test('nodes: rejects malformed enode URLs', () => {
  assert.equal(parseEnode(''), null);
  assert.equal(parseEnode('enode://tooshort@1.2.3.4:30303'), null);
  assert.equal(parseEnode(`enode://${PUBKEY}@1.2.3.4`), null); // no port
  assert.equal(parseEnode(`enode://${PUBKEY}@1.2.3.4:99999`), null); // bad port
  assert.equal(parseEnode(`http://${PUBKEY}@1.2.3.4:30303`), null);
  assert.equal(parseEnode(`enode://${PUBKEY.slice(0, 127)}g@1.2.3.4:30303`), null); // non-hex
});

// A node key whose enode we can build, so identity and signatures are checkable.
const NODE_KEY = new SigningKey('0x' + '11'.repeat(32));
const NODE_ENODE = `enode://${NODE_KEY.publicKey.slice(4)}@198.51.100.4:30303`;
const NODE_ADDRESS = new Wallet(NODE_KEY.privateKey).address;

test('nodes: registerNode takes the 64-byte pubkey from the enode, without the 0x04 prefix', () => {
  assert.equal(enodePubkeyBytes(ENODE), `0x${PUBKEY}`);
  assert.equal(getBytes(enodePubkeyBytes(NODE_ENODE)).length, 64);
  assert.equal(enodePubkeyBytes('garbage'), null);
});

test('nodes: the node address is the registry derivation, keccak256(pubkey)[12:] — host/port/case do not matter', () => {
  // address(uint160(uint256(keccak256(pubkey)))) is the Ethereum address of the key itself.
  assert.equal(enodeToNodeAddress(NODE_ENODE), NODE_ADDRESS);
  const id = enodeToNodeAddress(ENODE);
  assert.equal(id.toLowerCase(), '0x' + keccak256(`0x${PUBKEY}`).slice(-40));
  assert.equal(enodeToNodeAddress(`enode://${PUBKEY.toUpperCase()}@10.0.0.9:30999`), id);
  assert.equal(enodeToNodeAddress('garbage'), null);
});

const REGISTRY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const OPERATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CONSENSUS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

test('nodes: registrationDigest packs exactly what NodeRegistry.registrationDigest hashes', () => {
  // abi.encodePacked("FMX_NODE_REG_V1", block.chainid, address(this), operator, consensusAddr, positionId)
  const packed = concat([
    toUtf8Bytes('FMX_NODE_REG_V1'),
    zeroPadValue(toBeHex(3961), 32),
    REGISTRY,
    OPERATOR,
    CONSENSUS,
    zeroPadValue(toBeHex(7), 32),
  ]);
  assert.equal(registrationDigest(3961, REGISTRY, OPERATOR, CONSENSUS, 7n), keccak256(packed));
  // Every bound field changes the digest — a signature cannot be replayed elsewhere.
  const base = registrationDigest(3961, REGISTRY, OPERATOR, CONSENSUS, 7n);
  assert.notEqual(registrationDigest(1, REGISTRY, OPERATOR, CONSENSUS, 7n), base);
  assert.notEqual(registrationDigest(3961, OPERATOR, OPERATOR, CONSENSUS, 7n), base);
  assert.notEqual(registrationDigest(3961, REGISTRY, CONSENSUS, CONSENSUS, 7n), base);
  assert.notEqual(registrationDigest(3961, REGISTRY, OPERATOR, OPERATOR, 7n), base);
  assert.notEqual(registrationDigest(3961, REGISTRY, OPERATOR, CONSENSUS, 8n), base);
});

test('nodes: a raw signature by the node key over the digest passes the possession check', () => {
  const digest = registrationDigest(3961, REGISTRY, OPERATOR, CONSENSUS, 7n);
  const sig = NODE_KEY.sign(digest);
  const check = checkPossessionSignature(sig.serialized, digest, NODE_ADDRESS);
  assert.equal(check.ok, true);
  assert.equal(check.v, sig.v);
  assert.equal(check.r, sig.r);
  assert.equal(check.s, sig.s);
  // Without the 0x and with whitespace, as pasted from a terminal.
  assert.equal(checkPossessionSignature(`  ${sig.serialized.slice(2)}\n`, digest, NODE_ADDRESS).ok, true);
});

test('nodes: the possession check refuses the wrong key, a stale digest, a prefixed signature and junk', () => {
  const digest = registrationDigest(3961, REGISTRY, OPERATOR, CONSENSUS, 7n);
  const otherKey = new SigningKey('0x' + '22'.repeat(32));
  assert.equal(checkPossessionSignature(otherKey.sign(digest).serialized, digest, NODE_ADDRESS).ok, false);
  const stale = registrationDigest(3961, REGISTRY, OPERATOR, CONSENSUS, 8n);
  assert.equal(checkPossessionSignature(NODE_KEY.sign(stale).serialized, digest, NODE_ADDRESS).ok, false);
  // The registry ecrecovers the RAW digest: a personal_sign-style signature does not recover to the node.
  const prefixed = new Wallet(NODE_KEY.privateKey).signMessageSync(getBytes(digest));
  assert.equal(checkPossessionSignature(prefixed, digest, NODE_ADDRESS).ok, false);
  assert.match(checkPossessionSignature('', digest, NODE_ADDRESS).error, /Paste the signature/);
  assert.match(checkPossessionSignature('0x1234', digest, NODE_ADDRESS).error, /65 bytes/);
  assert.equal(checkPossessionSignature('0x' + '00'.repeat(65), digest, NODE_ADDRESS).ok, false);
});

test('nodes: consensus-address validation enforces checksum', () => {
  const good = checkConsensusAddress('0xc0A5Eb613f859f072554F29f1Ab7400265af15aB');
  assert.equal(good.ok, true);
  assert.equal(good.address, '0xc0A5Eb613f859f072554F29f1Ab7400265af15aB');
  // all-lowercase is accepted and checksummed
  const lower = checkConsensusAddress('0xc0a5eb613f859f072554f29f1ab7400265af15ab');
  assert.equal(lower.ok, true);
  assert.equal(lower.address, '0xc0A5Eb613f859f072554F29f1Ab7400265af15aB');
  // bad mixed-case checksum is rejected
  assert.equal(checkConsensusAddress('0xC0a5eb613f859f072554f29f1ab7400265af15ab').ok, false);
  assert.equal(checkConsensusAddress('').ok, false);
  assert.equal(checkConsensusAddress('0x1234').ok, false);
});
