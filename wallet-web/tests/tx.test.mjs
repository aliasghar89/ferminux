// prepareTransaction must size gas by ASKING the node, not by guessing from the
// shape of the call. Two mainnet deposits to the FoundationLock reverted out of
// gas because a bare value transfer (no calldata) was assumed to be a transfer
// to a plain account and given 21000 — a contract's receive() needs more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTransaction, receiptOf, NATIVE_TRANSFER_GAS } from '../src/lib/tx.ts';

const FROM = '0x7F16433359E4eF704E90cE08460c6238E45130f7';
const TO = '0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d';

/** The minimum surface prepareTransaction touches, with a scriptable estimate. */
function fakeProvider(estimate) {
  return {
    getBlock: async () => ({ baseFeePerGas: 7n }),
    send: async (method) => {
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00'; // 1 gwei
      throw new Error(`unexpected rpc ${method}`);
    },
    getTransactionCount: async () => 12,
    estimateGas: async (tx) => {
      assert.equal(tx.to, TO);
      assert.equal(tx.from, FROM);
      const r = estimate(tx);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('a plain account still gets exactly 21000', async () => {
  const tx = await prepareTransaction(fakeProvider(() => 21000n), 3961, FROM, TO, 10n ** 18n);
  assert.equal(tx.gasLimit, NATIVE_TRANSFER_GAS);
});

test('a contract with receive() gets the estimate plus headroom, never 21000', async () => {
  // 22789 is what the FoundationLock actually estimates to on mainnet.
  const tx = await prepareTransaction(fakeProvider(() => 22789n), 3961, FROM, TO, 10n ** 18n);
  assert.equal(tx.gasLimit, (22789n * 12n) / 10n);
  assert.ok(tx.gasLimit > NATIVE_TRANSFER_GAS);
  assert.equal(tx.maxFeeWei, tx.gasLimit * tx.maxFeePerGas);
});

test('the floor applies when an estimate comes in under 21000', async () => {
  const tx = await prepareTransaction(fakeProvider(() => 15000n), 3961, FROM, TO, 10n ** 18n);
  assert.equal(tx.gasLimit, NATIVE_TRANSFER_GAS);
});

test('calldata is still estimated the same way', async () => {
  const tx = await prepareTransaction(fakeProvider(() => 50000n), 3961, FROM, TO, 0n, '0xa9059cbb');
  assert.equal(tx.gasLimit, 60000n);
});

test('an estimate that reverts refuses to prepare, with the reason', async () => {
  const err = Object.assign(new Error('execution reverted'), { reason: 'LOCK: still locked' });
  await assert.rejects(
    prepareTransaction(fakeProvider(() => err), 3961, FROM, TO, 10n ** 18n),
    /This transaction would fail: LOCK: still locked/,
  );
});

test('fee fields are carried through unchanged', async () => {
  const tx = await prepareTransaction(fakeProvider(() => 21000n), 3961, FROM, TO, 5n);
  assert.equal(tx.nonce, 12);
  assert.equal(tx.chainId, 3961);
  assert.equal(tx.maxPriorityFeePerGas, 1_000_000_000n);
  assert.equal(tx.maxFeePerGas, 7n * 2n + 1_000_000_000n);
});

test('receiptOf: a reverted receipt comes back (ethers v6 wait() throws it as CALL_EXCEPTION)', async () => {
  const ok = { status: 1, hash: '0xaa' };
  assert.equal(await receiptOf({ wait: async () => ok }), ok);
  const reverted = { status: 0, hash: '0xbb' };
  const callException = Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION', receipt: reverted });
  assert.equal(await receiptOf({ wait: async () => { throw callException; } }), reverted);
  // Anything else (a dropped connection, a replaced transaction) is still an error.
  const net = Object.assign(new Error('network error'), { code: 'NETWORK_ERROR' });
  await assert.rejects(receiptOf({ wait: async () => { throw net; } }), /network error/);
  const noReceipt = Object.assign(new Error('estimate failed'), { code: 'CALL_EXCEPTION', receipt: null });
  await assert.rejects(receiptOf({ wait: async () => { throw noReceipt; } }), /estimate failed/);
});

test('receiptOf: against real ethers — a reverted receipt from the node is returned, not thrown', async () => {
  const { JsonRpcProvider, TransactionResponse } = await import('ethers');
  const hash = '0x' + 'cd'.repeat(32);
  const rcpt = {
    transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + 'ef'.repeat(32), blockNumber: '0x10',
    from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
    contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x0', effectiveGasPrice: '0x1', type: '0x2',
  };
  const provider = new JsonRpcProvider('http://127.0.0.1:1', 3961, { staticNetwork: true, batchMaxCount: 1 });
  provider._send = async (payload) => {
    const one = (p) => {
      if (p.method === 'eth_getTransactionReceipt') return { id: p.id, jsonrpc: '2.0', result: rcpt };
      if (p.method === 'eth_blockNumber') return { id: p.id, jsonrpc: '2.0', result: '0x10' };
      if (p.method === 'eth_chainId') return { id: p.id, jsonrpc: '2.0', result: '0xf79' };
      return { id: p.id, jsonrpc: '2.0', error: { code: -32601, message: 'no' } };
    };
    return Array.isArray(payload) ? payload.map(one) : [one(payload)];
  };
  const response = new TransactionResponse(
    { hash, blockNumber: null, blockHash: null, index: 0, type: 2, to: rcpt.to, from: rcpt.from, nonce: 0, gasLimit: 21000n, gasPrice: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: null, data: '0x', value: 0n, chainId: 3961n, signature: { r: '0x' + '01'.repeat(32), s: '0x' + '01'.repeat(32), yParity: 0, networkV: null }, accessList: [], blobVersionedHashes: null, authorizationList: null },
    provider,
  );
  await assert.rejects(response.wait(), (e) => e.code === 'CALL_EXCEPTION', 'ethers still throws on a revert');
  const r = await receiptOf(response);
  assert.equal(r.status, 0);
  assert.equal(r.hash, hash);
  provider.destroy();
});
