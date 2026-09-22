// Batched balance reads: one round trip for the whole account set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAddresses,
  buildBalanceBatch,
  readBalanceBatch,
  fetchBalances,
  totalBalance,
  isTotalComplete,
  balanceOf,
  httpBatchTransport,
} from '../src/lib/balances.ts';

const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const C = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** Transport that counts how many times it was called and with what. */
function spyTransport(handler) {
  const calls = [];
  const transport = async (batch) => {
    calls.push(batch);
    return handler(batch);
  };
  return { transport, calls };
}

const answerAll = (values) => (batch) =>
  batch.map((call) => ({ jsonrpc: '2.0', id: call.id, result: '0x' + (values[call.params[0]] ?? 0n).toString(16) }));

/* ---------------- batching ---------------- */

test('balances: N addresses cost exactly ONE transport round trip', async () => {
  const addresses = Array.from({ length: 12 }, (_, i) => '0x' + String(i).padStart(40, 'a'));
  const values = Object.fromEntries(addresses.map((a, i) => [a.toLowerCase(), BigInt(i) * 10n ** 18n]));
  const { transport, calls } = spyTransport(answerAll(values));

  const snapshot = await fetchBalances(transport, addresses);

  assert.equal(calls.length, 1, 'one batch, not one request per account');
  assert.equal(calls[0].length, 12, 'every address travels in the same batch');
  assert.equal(snapshot.balances.size, 12);
  assert.equal(snapshot.balances.get(addresses[3].toLowerCase()), 3n * 10n ** 18n);
});

test('balances: an empty account list makes no request at all', async () => {
  const { transport, calls } = spyTransport(() => {
    throw new Error('should not be called');
  });
  const snapshot = await fetchBalances(transport, []);
  assert.equal(calls.length, 0);
  assert.equal(snapshot.balances.size, 0);
  assert.deepEqual(snapshot.failed, []);
});

test('balances: the batch is well-formed JSON-RPC with unique ids and one block tag', () => {
  const { calls, order } = buildBalanceBatch([A, B, C], 'latest');
  assert.deepEqual(order, [A, B, C].map((a) => a.toLowerCase()));
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls.map((c) => c.id)).size, 3);
  for (const call of calls) {
    assert.equal(call.jsonrpc, '2.0');
    assert.equal(call.method, 'eth_getBalance');
    assert.equal(call.params.length, 2);
    assert.equal(call.params[1], 'latest', 'all accounts are read at the same height');
  }
});

test('balances: duplicate and differently-cased addresses are read once', async () => {
  const { transport, calls } = spyTransport(answerAll({ [A.toLowerCase()]: 5n }));
  const snapshot = await fetchBalances(transport, [A, A.toLowerCase(), `  ${A.toUpperCase()}  `, '']);
  assert.equal(calls[0].length, 1);
  assert.equal(snapshot.balances.size, 1);
  assert.equal(balanceOf(snapshot, A), 5n);
});

test('balances: normalizeAddresses preserves first-seen order', () => {
  assert.deepEqual(normalizeAddresses([B, A, B, '', '  ']), [B.toLowerCase(), A.toLowerCase()]);
});

/* ---------------- reply handling ---------------- */

test('balances: replies are matched by id, not by position', () => {
  const order = [A, B, C].map((a) => a.toLowerCase());
  const snapshot = readBalanceBatch(order, [
    { id: 3, result: '0x3' },
    { id: 1, result: '0x1' },
    { id: 2, result: '0x2' },
  ]);
  assert.equal(snapshot.balances.get(order[0]), 1n);
  assert.equal(snapshot.balances.get(order[1]), 2n);
  assert.equal(snapshot.balances.get(order[2]), 3n);
});

test('balances: one failing account does not poison the others', () => {
  const order = [A, B, C].map((a) => a.toLowerCase());
  const snapshot = readBalanceBatch(order, [
    { id: 1, result: '0xde0b6b3a7640000' },
    { id: 2, error: { code: -32000, message: 'unknown block' } },
    { id: 3, result: null },
  ]);
  assert.equal(snapshot.balances.get(order[0]), 10n ** 18n);
  assert.deepEqual(snapshot.failed, [order[1], order[2]]);
  assert.equal(balanceOf(snapshot, B), null);
});

test('balances: a missing reply, junk hex or a bare object reply degrade cleanly', () => {
  const order = [A, B].map((a) => a.toLowerCase());
  assert.deepEqual(readBalanceBatch(order, [{ id: 1, result: '0x1' }]).failed, [order[1]]);
  assert.deepEqual(readBalanceBatch(order, [{ id: 1, result: 'not hex' }, { id: 2, result: '0x2' }]).failed, [
    order[0],
  ]);
  const single = readBalanceBatch([order[0]], { id: 1, result: '0x7' });
  assert.equal(single.balances.get(order[0]), 7n, 'a node answering a 1-item batch with an object still works');
});

test('balances: full 256-bit values survive as exact bigints', () => {
  const order = [A.toLowerCase()];
  const huge = (1n << 255n) + 12345n;
  const snapshot = readBalanceBatch(order, [{ id: 1, result: '0x' + huge.toString(16) }]);
  assert.equal(snapshot.balances.get(order[0]), huge);
});

/* ---------------- totals ---------------- */

test('balances: the total sums every account and knows when it is exact', async () => {
  const values = { [A.toLowerCase()]: 10n ** 18n, [B.toLowerCase()]: 25n * 10n ** 17n };
  const { transport } = spyTransport((batch) =>
    batch.map((call) => {
      const value = values[call.params[0]];
      return value === undefined
        ? { id: call.id, error: { message: 'no' } }
        : { id: call.id, result: '0x' + value.toString(16) };
    }),
  );
  const snapshot = await fetchBalances(transport, [A, B, C]);
  assert.equal(totalBalance(snapshot, [A, B, C]), 35n * 10n ** 17n);
  assert.equal(isTotalComplete(snapshot, [A, B, C]), false, 'C could not be read, so the total is a lower bound');
  assert.equal(isTotalComplete(snapshot, [A, B]), true);
  assert.equal(totalBalance(null, [A]), 0n);
  assert.equal(isTotalComplete(null, [A]), false);
  assert.equal(totalBalance(snapshot, []), 0n);
});

test('balances: a repeated address is not double-counted in the total', async () => {
  const { transport } = spyTransport(answerAll({ [A.toLowerCase()]: 4n }));
  const snapshot = await fetchBalances(transport, [A]);
  assert.equal(totalBalance(snapshot, [A, A.toLowerCase(), A.toUpperCase()]), 4n);
});

/* ---------------- HTTP transport ---------------- */

test('balances: the HTTP transport posts one array body and unwraps the reply', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => JSON.parse(init.body).map((c) => ({ id: c.id, result: '0x2a' })),
    };
  };
  try {
    const snapshot = await fetchBalances(httpBatchTransport('https://rpc.example/'), [A, B]);
    assert.equal(seen.length, 1, 'one HTTP POST for the whole set');
    assert.ok(Array.isArray(seen[0].body), 'the body is a JSON-RPC batch array');
    assert.equal(seen[0].body.length, 2);
    assert.equal(snapshot.balances.get(A.toLowerCase()), 42n);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('balances: an HTTP error surfaces as a rejection, not a silent zero', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  try {
    await assert.rejects(fetchBalances(httpBatchTransport('https://rpc.example/'), [A]), /502/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
