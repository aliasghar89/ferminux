// Chain-aware fees for the multi-chain Send: the Ferminux tip floor, zero tips
// elsewhere, legacy chains, and the OP-stack L1 data fee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Transaction, Wallet } from 'ethers';
import {
  HOME_FEE_POLICY,
  OP_GAS_PRICE_ORACLE,
  feePolicyFor,
  gasLimitFor,
  getFeeInfo,
  nativeTransferMaxFee,
  prepareTransaction,
  signPrepared,
} from '../src/lib/tx.ts';
import { FERMINUX_CHAIN, chainById } from '../src/lib/chains.ts';

const FROM = '0x7F16433359E4eF704E90cE08460c6238E45130f7';
const TO = '0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d';

/** Scriptable node: base fee, tip answer (or throw), gas price, L1 oracle. */
function chainProvider({ base, tip, gasPrice, oracle, estimate = 21000n }) {
  return {
    getBlock: async () => ({ baseFeePerGas: base }),
    send: async (method) => {
      if (method === 'eth_maxPriorityFeePerGas') {
        if (tip instanceof Error) throw tip;
        return '0x' + tip.toString(16);
      }
      if (method === 'eth_gasPrice') return '0x' + gasPrice.toString(16);
      throw new Error(`unexpected rpc ${method}`);
    },
    call: async (tx) => {
      assert.equal(tx.to, OP_GAS_PRICE_ORACLE);
      if (!oracle) throw new Error('no oracle');
      return oracle(tx.data);
    },
    getTransactionCount: async () => 3,
    estimateGas: async () => estimate,
  };
}

test('fee policy: Ferminux keeps the 1 gwei tip floor; other chains trust the node', () => {
  assert.equal(feePolicyFor(FERMINUX_CHAIN, 3961), HOME_FEE_POLICY);
  assert.deepEqual(feePolicyFor(chainById(42161), 3961), { tipFloor: null, opStackL1Fee: false });
  assert.deepEqual(feePolicyFor(chainById(8453), 3961), { tipFloor: null, opStackL1Fee: true });
});

test('Ferminux: a node tip under 1 gwei is raised to the floor the signers enforce', async () => {
  const f = await getFeeInfo(chainProvider({ base: 7n, tip: 500_000_000n }));
  assert.equal(f.maxPriorityFeePerGas, 1_000_000_000n);
  assert.equal(f.maxFeePerGas, 14n + 1_000_000_000n);
  const g = await getFeeInfo(chainProvider({ base: 7n, tip: new Error('nope') }));
  assert.equal(g.maxPriorityFeePerGas, 1_000_000_000n);
});

test('Ethereum: a zero (or tiny) suggested tip is raised to 0.05 gwei; a higher one is kept', async () => {
  const eth = feePolicyFor(chainById(1), 3961);
  assert.deepEqual(eth, { tipFloor: null, opStackL1Fee: false, minTip: 50_000_000n });
  const zero = await getFeeInfo(chainProvider({ base: 3_000_000_000n, tip: 0n }), eth);
  assert.equal(zero.maxPriorityFeePerGas, 50_000_000n);
  assert.equal(zero.maxFeePerGas, 6_000_000_000n + 50_000_000n);
  const low = await getFeeInfo(chainProvider({ base: 3_000_000_000n, tip: 1_000_000n }), eth);
  assert.equal(low.maxPriorityFeePerGas, 50_000_000n);
  const high = await getFeeInfo(chainProvider({ base: 3_000_000_000n, tip: 2_000_000_000n }), eth);
  assert.equal(high.maxPriorityFeePerGas, 2_000_000_000n);
  // the node cannot say and gasPrice is at the base fee: still the minimum, never 0
  const none = await getFeeInfo(chainProvider({ base: 3_000_000_000n, tip: new Error('nope'), gasPrice: 3_000_000_000n }), eth);
  assert.equal(none.maxPriorityFeePerGas, 50_000_000n);
});

test('Arbitrum: a zero tip stays zero (no 50x inflated worst-case fee)', async () => {
  const f = await getFeeInfo(chainProvider({ base: 20_026_000n, tip: 0n }), feePolicyFor(chainById(42161), 3961));
  assert.equal(f.maxPriorityFeePerGas, 0n);
  assert.equal(f.maxFeePerGas, 40_052_000n);
  assert.equal(f.gasPrice, undefined);
});

test('BSC (base fee 0): max fee is the tip; tip falls back to gasPrice − base when the node lacks the method', async () => {
  const f = await getFeeInfo(chainProvider({ base: 0n, tip: 50_000_000n }), feePolicyFor(chainById(56), 3961));
  assert.equal(f.maxFeePerGas, 50_000_000n);
  const g = await getFeeInfo(
    chainProvider({ base: 100n, tip: new Error('method not found'), gasPrice: 1_100n }),
    feePolicyFor(chainById(56), 3961),
  );
  assert.equal(g.maxPriorityFeePerGas, 1_000n);
  assert.equal(g.maxFeePerGas, 1_200n);
});

test('a chain without a base fee is prepared and signed as a legacy type-0 transaction', async () => {
  const key = Wallet.createRandom().privateKey;
  const w = new Wallet(key);
  const policy = { tipFloor: null, opStackL1Fee: false };
  const p = await prepareTransaction(chainProvider({ base: null, gasPrice: 5_000_000_000n }), 56, w.address, TO, 1n, '0x', policy);
  assert.equal(p.type, 0);
  assert.equal(p.gasPrice, 5_000_000_000n);
  assert.equal(p.maxFeeWei, 21000n * 5_000_000_000n);
  const parsed = Transaction.from(await signPrepared(key, p));
  assert.equal(parsed.type, 0);
  assert.equal(parsed.chainId, 56n);
  assert.equal(parsed.gasPrice, 5_000_000_000n);
});

test('the chain id signed is the one prepared, and only the sender key can sign it', async () => {
  const key = Wallet.createRandom().privateKey;
  const w = new Wallet(key);
  const p = await prepareTransaction(chainProvider({ base: 1000n, tip: 5n }), 137, w.address, TO, 7n, '0x', feePolicyFor(chainById(137), 3961));
  const parsed = Transaction.from(await signPrepared(key, p));
  assert.equal(parsed.type, 2);
  assert.equal(parsed.chainId, 137n);
  assert.equal(parsed.maxFeePerGas, 2005n);
  assert.equal(parsed.from, w.address);
  await assert.rejects(signPrepared(Wallet.createRandom().privateKey, p), /Signer does not match/);
});

const oracleIface = new Interface([
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
  'function getL1Fee(bytes data) view returns (uint256)',
]);

test('OP-stack: the L1 data fee upper bound is added to the worst-case fee, sized from the unsigned tx', async () => {
  let askedSize = null;
  const oracle = (data) => {
    const parsed = oracleIface.parseTransaction({ data });
    assert.equal(parsed.name, 'getL1FeeUpperBound');
    askedSize = parsed.args[0];
    return oracleIface.encodeFunctionResult('getL1FeeUpperBound', [777n]);
  };
  const policy = feePolicyFor(chainById(8453), 3961);
  const p = await prepareTransaction(chainProvider({ base: 5_000_000n, tip: 1_000_000n, oracle }), 8453, FROM, TO, 1n, '0x', policy);
  assert.equal(p.l1FeeWei, 777n);
  assert.equal(p.maxFeeWei, 21000n * 11_000_000n + 777n);
  assert.ok(askedSize > 40n && askedSize < 200n, `unsigned size ${askedSize}`);

  const max = await nativeTransferMaxFee(chainProvider({ base: 5_000_000n, tip: 1_000_000n, oracle }), 8453, TO, policy);
  assert.equal(max.feeWei, 21000n * 11_000_000n + 777n);
  assert.equal(max.l1FeeUnknown, false);
});

test('OP-stack: pre-Fjord oracle falls back to getL1Fee + 25 %; no oracle at all is flagged, not silently zero', async () => {
  const oldOracle = (data) => {
    const parsed = oracleIface.parseTransaction({ data });
    if (parsed.name === 'getL1FeeUpperBound') throw new Error('execution reverted');
    return oracleIface.encodeFunctionResult('getL1Fee', [400n]);
  };
  const policy = feePolicyFor(chainById(10), 3961);
  const p = await prepareTransaction(chainProvider({ base: 1n, tip: 1n, oracle: oldOracle }), 10, FROM, TO, 1n, '0x', policy);
  assert.equal(p.l1FeeWei, 500n);
  const q = await prepareTransaction(chainProvider({ base: 1n, tip: 1n }), 10, FROM, TO, 1n, '0x', policy);
  assert.equal(q.l1FeeUnknown, true);
  assert.equal(q.l1FeeWei, undefined);
  assert.equal(q.maxFeeWei, 21000n * 3n);
});

test('native Max on Ferminux is still exactly 21000 × max fee', async () => {
  const r = await nativeTransferMaxFee(chainProvider({ base: 7n, tip: 1_000_000_000n }), 3961, TO);
  assert.equal(r.feeWei, 21000n * (14n + 1_000_000_000n));
  assert.equal(r.l1FeeUnknown, false);
});

test('Arbitrum: Max reserves the estimated gas, so Review of that Max amount is affordable', async () => {
  // A plain Arbitrum transfer estimates above 21000 (its L1 component is paid in gas).
  const policy = feePolicyFor(chainById(42161), 3961);
  const provider = chainProvider({ base: 20_000_000n, tip: 0n, estimate: 21_906n });
  const balance = 10n ** 15n;
  const max = await nativeTransferMaxFee(provider, 42161, TO, policy, { from: FROM, valueWei: balance });
  const prepared = await prepareTransaction(provider, 42161, FROM, TO, balance - max.feeWei, '0x', policy);
  assert.equal(prepared.gasLimit, gasLimitFor(21_906n));
  assert.ok(prepared.valueWei + prepared.maxFeeWei <= balance, 'the Max amount must pass Review');
  // Without an estimate (the old behaviour) Max reserved 21000 gas and Review refused it.
  const old = await nativeTransferMaxFee(provider, 42161, TO, policy);
  assert.ok(balance - old.feeWei + prepared.maxFeeWei > balance);
});

test('Max falls back to 21000 gas when the node cannot estimate', async () => {
  const provider = { ...chainProvider({ base: 7n, tip: 1_000_000_000n }), estimateGas: async () => { throw new Error('nope'); } };
  const r = await nativeTransferMaxFee(provider, 3961, TO, HOME_FEE_POLICY, { from: FROM, valueWei: 10n ** 18n });
  assert.equal(r.feeWei, 21000n * (14n + 1_000_000_000n));
});
