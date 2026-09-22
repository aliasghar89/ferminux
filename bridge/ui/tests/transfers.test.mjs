// Unit checks for transfer persistence: a refresh must never lose an in-flight
// transfer, and a corrupted store must never stop the app from loading.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RECORDS,
  findTransfer,
  inFlight,
  isInFlight,
  isTransferRecord,
  loadTransfers,
  patchTransfer,
  saveTransfers,
  settled,
  upsertTransfer,
} from '../src/lib/transfers.ts';

const KEY = 'test.transfers';

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
}

function record(overrides = {}) {
  return {
    transferId: '0x' + '11'.repeat(32),
    srcChainKey: 'ferminux',
    dstChainKey: 'bsc',
    srcChainId: 3961,
    dstChainId: 56,
    srcBridge: '0x' + '22'.repeat(20),
    dstBridge: '0x' + '33'.repeat(20),
    srcToken: '0x0000000000000000000000000000000000000000',
    dstToken: '0x' + '44'.repeat(20),
    symbol: 'FMX',
    dstSymbol: 'wFMX',
    decimals: 18,
    sender: '0x' + '55'.repeat(20),
    recipient: '0x' + '66'.repeat(20),
    sentWei: '1000000000000000000',
    amountWei: '999000000000000000',
    feeWei: '1000000000000000',
    nonce: 1,
    txHash: '0x' + '77'.repeat(32),
    txBlockNumber: 10,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    phase: 'confirming',
    ...overrides,
  };
}

function hashOf(n) {
  return '0x' + n.toString(16).padStart(64, '0');
}

test('store: an empty store loads as an empty list', () => {
  assert.deepEqual(loadTransfers(fakeStore(), KEY), []);
});

test('store: a saved transfer survives a reload byte for byte', () => {
  const store = fakeStore();
  const r = record();
  saveTransfers(store, [r], KEY);
  const back = loadTransfers(store, KEY);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], r);
});

test('store: corrupt JSON, a non-array and non-records are all discarded silently', () => {
  assert.deepEqual(loadTransfers(fakeStore({ [KEY]: 'not json {' }), KEY), []);
  assert.deepEqual(loadTransfers(fakeStore({ [KEY]: '{"a":1}' }), KEY), []);
  assert.deepEqual(loadTransfers(fakeStore({ [KEY]: '[1,2,"x",null]' }), KEY), []);
});

test('store: a mixed array keeps only the well-formed records', () => {
  const good = record();
  const store = fakeStore({ [KEY]: JSON.stringify([good, { txHash: 'nope' }, null, { ...good, amountWei: 1 }]) });
  const back = loadTransfers(store, KEY);
  assert.equal(back.length, 1);
  assert.equal(back[0].txHash, good.txHash);
});

test('store: record validation rejects bad hashes, bad phases and numeric amounts', () => {
  assert.equal(isTransferRecord(record()), true);
  assert.equal(isTransferRecord(record({ txHash: '0x123' })), false);
  assert.equal(isTransferRecord(record({ phase: 'teleporting' })), false);
  assert.equal(isTransferRecord(record({ amountWei: 1_000 })), false, 'amounts must stay strings, not lose precision');
  assert.equal(isTransferRecord(record({ sentWei: '1.5' })), false);
  assert.equal(isTransferRecord(null), false);
  assert.equal(isTransferRecord('x'), false);
});

test('store: a storage backend that throws never breaks load or save', () => {
  const hostile = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.deepEqual(loadTransfers(hostile, KEY), []);
  assert.doesNotThrow(() => saveTransfers(hostile, [record()], KEY));
});

test('upsert: puts the newest first and replaces by transaction hash', () => {
  const a = record({ txHash: hashOf(1) });
  const b = record({ txHash: hashOf(2) });
  let list = upsertTransfer([], a);
  list = upsertTransfer(list, b);
  assert.deepEqual(list.map((r) => r.txHash), [b.txHash, a.txHash]);

  const updated = { ...a, phase: 'complete' };
  list = upsertTransfer(list, updated);
  assert.equal(list.length, 2, 'the same hash must not duplicate');
  assert.equal(list[0].phase, 'complete');
});

test('upsert: matching a hash is case-insensitive', () => {
  const a = record({ txHash: '0x' + 'ab'.repeat(32) });
  const shouty = record({ txHash: '0x' + 'AB'.repeat(32), phase: 'complete' });
  const list = upsertTransfer([a], shouty);
  assert.equal(list.length, 1);
  assert.equal(list[0].phase, 'complete');
});

test('upsert: the list is capped so history cannot grow without bound', () => {
  let list = [];
  for (let i = 0; i < MAX_RECORDS + 25; i++) list = upsertTransfer(list, record({ txHash: hashOf(i) }));
  assert.equal(list.length, MAX_RECORDS);
  assert.equal(list[0].txHash, hashOf(MAX_RECORDS + 24), 'newest survives');
});

test('patch: merges fields, stamps updatedAt and leaves other records alone', () => {
  const a = record({ txHash: hashOf(1) });
  const b = record({ txHash: hashOf(2), phase: 'submitted' });
  const next = patchTransfer([a, b], b.txHash, { phase: 'complete' }, 1_700_000_999_000);
  assert.equal(next[0], a, 'untouched records keep their identity');
  assert.equal(next[1].phase, 'complete');
  assert.equal(next[1].updatedAt, 1_700_000_999_000);
});

test('patch: a no-op patch returns the SAME array so React does not re-render', () => {
  const a = record({ txHash: hashOf(1), phase: 'confirming' });
  const same = patchTransfer([a], a.txHash, { phase: 'confirming' }, Date.now());
  assert.equal(same[0], a);
  assert.equal(same.length, 1);
});

test('patch: an unknown hash changes nothing', () => {
  const a = record({ txHash: hashOf(1) });
  const next = patchTransfer([a], hashOf(9), { phase: 'complete' });
  assert.deepEqual(next, [a]);
});

test('find: locates a record by hash regardless of case', () => {
  const a = record({ txHash: '0x' + 'cd'.repeat(32) });
  assert.equal(findTransfer([a], '0x' + 'CD'.repeat(32)).txHash, a.txHash);
  assert.equal(findTransfer([a], hashOf(5)), undefined);
});

test('split: in-flight and settled partition the list exactly once', () => {
  const list = [
    record({ txHash: hashOf(1), phase: 'submitted' }),
    record({ txHash: hashOf(2), phase: 'confirming' }),
    record({ txHash: hashOf(3), phase: 'executing' }),
    record({ txHash: hashOf(4), phase: 'complete' }),
    record({ txHash: hashOf(5), phase: 'reverted' }),
    record({ txHash: hashOf(6), phase: 'unverifiable' }),
  ];
  assert.equal(inFlight(list).length, 3);
  assert.equal(settled(list).length, 3);
  assert.equal(inFlight(list).length + settled(list).length, list.length);
  assert.equal(isInFlight(list[0]), true);
  assert.equal(isInFlight(list[3]), false);
});

test('store: saving also caps the list before it reaches storage', () => {
  const store = fakeStore();
  const many = Array.from({ length: MAX_RECORDS + 10 }, (_, i) => record({ txHash: hashOf(i) }));
  const saved = saveTransfers(store, many, KEY);
  assert.equal(saved.length, MAX_RECORDS);
  assert.equal(JSON.parse(store.getItem(KEY)).length, MAX_RECORDS);
});
