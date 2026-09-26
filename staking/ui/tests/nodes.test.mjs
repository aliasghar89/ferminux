// enode parsing + register-form validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes } from 'ethers';
import { parseEnode, enodeToId, checkConsensusAddress } from '../src/lib/nodes.ts';

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

test('nodes: the on-chain id is keccak256 of the lowercase pubkey — host/port do not matter', () => {
  const id = enodeToId(ENODE);
  assert.equal(id, keccak256(toUtf8Bytes(PUBKEY.toLowerCase())));
  // Same key from a different IP / port / case is the SAME node identity.
  assert.equal(enodeToId(`enode://${PUBKEY.toUpperCase()}@10.0.0.9:30999`), id);
  assert.equal(enodeToId('garbage'), null);
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
