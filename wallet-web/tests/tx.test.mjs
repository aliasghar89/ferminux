// prepareTransaction must size gas by ASKING the node, not by guessing from the
// shape of the call. Two mainnet deposits to the FoundationLock reverted out of
// gas because a bare value transfer (no calldata) was assumed to be a transfer
// to a plain account and given 21000 — a contract's receive() needs more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTransaction, NATIVE_TRANSFER_GAS } from '../src/lib/tx.ts';

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
