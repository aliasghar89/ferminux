// The network fee of a pay-in purchase, before the quote and at Review, on
// each of the seven pay-in networks, against a JSON-RPC mock per chain behind
// a real ethers provider (nothing reaches a network).
//
// The gap this closes: the check before a quote tested the coin amount with a
// fee of zero, and the fee checks after it ignored an L1 data fee that could
// not be read. So an account on Base or Optimism holding enough ETH for the
// gas but not for the L1 data fee, or an Arbitrum account whose transfer's
// estimate carries a large L1 component, was sent to a quote it could not
// pay. The budget is now the exact transfer (eth_estimateGas), priced by the
// same tx.ts machinery as every send in the wallet, and a fee that cannot be
// read stops the purchase instead of counting as zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, JsonRpcProvider, Network, getAddress, parseUnits } from 'ethers';
import { checkPayinFunds, payinCall, payinCoin, payinFeeBudget, payinFundsProblem } from '../src/lib/payin.ts';
import { FOREIGN_CHAINS } from '../src/lib/chains.ts';
import { OP_GAS_PRICE_ORACLE, feePolicyFor, gasLimitFor, prepareTransaction } from '../src/lib/tx.ts';
import { prepareTokenTransfer } from '../src/lib/tokens.ts';

const ME = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const DEPOSIT = getAddress('0xc2a7B343a8a9ef2eC5D15c31225A64AC9FDC05Fa');
const GWEI = 1_000_000_000n;
const hex = (v) => '0x' + BigInt(v).toString(16);
const word = (v) => AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
const erc20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 value) returns (bool)']);
const oracleIface = new Interface([
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
  'function getL1Fee(bytes data) view returns (uint256)',
]);
const rpcError = (message, code = -32000) => Object.assign(new Error(message), { code });

/**
 * One chain's node. `estimate(tx)` answers eth_estimateGas (and can revert);
 * `oracle` answers the OP-stack GasPriceOracle: { upperBound(size) } after
 * Fjord, { l1Fee(bytes) } before it, or nothing (the call reverts).
 */
class ChainMock extends JsonRpcProvider {
  constructor(chainId, cfg) {
    const net = Network.from(chainId);
    super('http://rpc.invalid', net, { staticNetwork: net, cacheTimeout: -1, batchMaxCount: 1 });
    this.cfg = cfg;
    this.log = [];
  }
  async _send(payload) {
    return (Array.isArray(payload) ? payload : [payload]).map((p) => {
      this.log.push({ method: p.method, params: p.params });
      try {
        return { id: p.id, result: this.answer(p.method, p.params ?? []) };
      } catch (e) {
        return { id: p.id, error: { code: e.code ?? -32000, message: e.message } };
      }
    });
  }
  answer(method, params) {
    const c = this.cfg;
    switch (method) {
      case 'eth_chainId':
        return hex(this._network.chainId);
      case 'eth_getBlockByNumber':
        if (c.blockDown) throw rpcError('upstream request timeout');
        return block(c.base);
      case 'eth_maxPriorityFeePerGas':
        if (c.tip instanceof Error) throw c.tip;
        return hex(c.tip);
      case 'eth_gasPrice':
        return hex(c.gasPrice ?? c.base ?? GWEI);
      case 'eth_getBalance':
        return hex(c.native);
      case 'eth_getTransactionCount':
        return hex(7);
      case 'eth_estimateGas':
        return hex(c.estimate(params[0], c));
      case 'eth_call': {
        const { to, data } = params[0];
        if (to.toLowerCase() === OP_GAS_PRICE_ORACLE.toLowerCase()) {
          const call = oracleIface.parseTransaction({ data });
          if (call.name === 'getL1FeeUpperBound' && c.oracle?.upperBound) {
            this.l1Size = BigInt(call.args[0]);
            return oracleIface.encodeFunctionResult('getL1FeeUpperBound', [c.oracle.upperBound(this.l1Size)]);
          }
          if (call.name === 'getL1Fee' && c.oracle?.l1Fee) return oracleIface.encodeFunctionResult('getL1Fee', [c.oracle.l1Fee(call.args[0])]);
          throw rpcError('execution reverted', 3);
        }
        if (data.slice(0, 10) === erc20.getFunction('balanceOf').selector) return word(c.tokens?.[to.toLowerCase()] ?? 0n);
        throw rpcError(`eth_call to ${to} not mocked`);
      }
      default:
        throw rpcError(`method ${method} not mocked`, -32601);
    }
  }
  /** The eth_estimateGas requests this node answered. */
  estimates() {
    return this.log.filter((x) => x.method === 'eth_estimateGas').map((x) => x.params[0]);
  }
}

function block(base) {
  return {
    number: '0x10',
    hash: '0x' + 'ab'.repeat(32),
    parentHash: '0x' + '11'.repeat(32),
    timestamp: hex(1_790_399_100),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: hex(30_000_000),
    gasUsed: '0x0',
    miner: '0x' + '00'.repeat(20),
    extraData: '0x',
    ...(base === null ? {} : { baseFeePerGas: hex(base) }),
    transactions: [],
    stateRoot: '0x' + '22'.repeat(32),
    receiptsRoot: '0x' + '33'.repeat(32),
    transactionsRoot: '0x' + '44'.repeat(32),
    sha3Uncles: '0x' + '55'.repeat(32),
    logsBloom: '0x' + '00'.repeat(256),
    mixHash: '0x' + '66'.repeat(32),
    size: '0x100',
    uncles: [],
  };
}

/** A token transfer estimates to `gas`, and reverts past the sender's balance, as a real token does. */
const tokenGas = (gas) => (tx, c) => {
  if (tx.data && tx.data !== '0x') {
    const [, amount] = erc20.decodeFunctionData('transfer', tx.data);
    if ((c.tokens?.[tx.to.toLowerCase()] ?? 0n) < amount) throw rpcError('execution reverted: transfer amount exceeds balance', 3);
    return gas;
  }
  if (BigInt(tx.value ?? 0) > c.native) throw rpcError('insufficient funds for transfer');
  return 21_000n;
};

const chain = (key) => FOREIGN_CHAINS.find((c) => c.key === key);

/**
 * The seven pay-in networks with fee conditions of their kind. `perGas` is
 * the max fee per gas the wallet should sign with there; `gas` what a stable
 * transfer estimates to on that network.
 */
const NETWORKS = [
  // Ethereum: the node suggests a zero tip, the wallet raises it to 0.05 gwei
  { key: 'eth', coin: 'USDT', amount: '25', base: 3n * GWEI, tip: 0n, perGas: 6n * GWEI + 50_000_000n, gas: 46_109n },
  // BNB Smart Chain: base fee 0, 18-decimal stables
  { key: 'bsc', coin: 'USDT', amount: '25', base: 0n, tip: 50_000_000n, perGas: 50_000_000n, gas: 34_446n },
  // Base: OP-stack, the L1 data fee on top (Fjord oracle, priced by size)
  { key: 'base', coin: 'USDC', amount: '25', base: 5_000_000n, tip: 1_000_000n, perGas: 11_000_000n, gas: 44_917n, oracle: { upperBound: (size) => size * 16n * 1_200_000n } },
  // Arbitrum One: zero tip, and a gas estimate that carries the L1 component (far above a plain transfer's)
  { key: 'arbitrum', coin: 'USDC', amount: '25', base: 10_000_000n, tip: 0n, perGas: 20_000_000n, gas: 562_310n },
  // Polygon
  { key: 'polygon', coin: 'USDT', amount: '25', base: 30n * GWEI, tip: 30n * GWEI, perGas: 90n * GWEI, gas: 45_171n },
  // Optimism: OP-stack, a pre-Fjord oracle (getL1Fee + 25 %)
  { key: 'optimism', coin: 'USDC', amount: '25', base: 1_000_000n, tip: 1_000_000n, perGas: 3_000_000n, gas: 44_917n, oracle: { l1Fee: () => 80_000_000_000n } },
  // Avalanche C-Chain
  { key: 'avalanche', coin: 'USDT', amount: '25', base: 25n * GWEI, tip: GWEI, perGas: 51n * GWEI, gas: 44_925n },
];

function mockFor(n, over = {}) {
  const coin = payinCoin(n.key, n.coin);
  const amount = parseUnits(n.amount, coin.decimals);
  const cfg = {
    base: n.base,
    tip: n.tip,
    native: 10n ** 18n,
    tokens: coin.address ? { [coin.address.toLowerCase()]: amount * 2n } : {},
    estimate: tokenGas(n.gas),
    oracle: n.oracle,
    ...over,
  };
  return { coin, amount, provider: new ChainMock(chain(n.key).id, cfg) };
}

test('every pay-in network is covered here, and Base and Optimism are the OP-stack ones', () => {
  assert.deepEqual(NETWORKS.map((n) => n.key).sort(), FOREIGN_CHAINS.map((c) => c.key).sort());
  assert.deepEqual(FOREIGN_CHAINS.filter((c) => c.opStackL1Fee).map((c) => c.key).sort(), ['base', 'optimism']);
});

for (const n of NETWORKS) {
  test(`${n.key}: the fee before a quote is the exact transfer's, priced as Send prices it`, async () => {
    const { coin, amount, provider } = mockFor(n);
    try {
      const budget = await payinFeeBudget(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });

      // the network was asked about the exact transfer: transfer(deposit, amount) on the token, from this wallet
      const [est] = provider.estimates();
      assert.equal(getAddress(est.from), ME);
      assert.equal(getAddress(est.to), coin.address);
      assert.equal(BigInt(est.value ?? 0), 0n);
      assert.equal(est.data, payinCall({ kind: coin.kind, token: coin.address, depositAddress: DEPOSIT, sendExactly: amount }).data);
      const [to, value] = erc20.decodeFunctionData('transfer', est.data);
      assert.deepEqual([to, value], [DEPOSIT, amount]);

      assert.equal(budget.gasLimit, gasLimitFor(n.gas), 'the estimate with the same headroom Review signs');
      assert.equal(budget.fees.maxFeePerGas, n.perGas);
      const gasFee = gasLimitFor(n.gas) * n.perGas;
      if (chain(n.key).opStackL1Fee) {
        assert.ok(budget.l1FeeWei > 0n, 'an L1 data fee on an OP-stack chain');
        assert.equal(budget.maxFeeWei, gasFee + budget.l1FeeWei);
        assert.equal(budget.l1FeeUnknown, undefined);
      } else {
        assert.equal(budget.maxFeeWei, gasFee);
        assert.equal(budget.l1FeeWei, undefined);
      }

      // the same transfer through the normal Send path (prepareTokenTransfer → prepareTransaction)
      const sent = await prepareTokenTransfer(provider, chain(n.key).id, ME, coin.address, DEPOSIT, amount, feePolicyFor(chain(n.key), 3961));
      assert.equal(sent.gasLimit, budget.gasLimit);
      assert.equal(sent.maxFeePerGas, budget.fees.maxFeePerGas);
      assert.equal(sent.l1FeeUnknown, budget.l1FeeUnknown);
      // sized with a nonce no account reaches, the check before a quote never budgets less than Review
      assert.ok(budget.maxFeeWei >= sent.maxFeeWei, `${budget.maxFeeWei} ≥ ${sent.maxFeeWei}`);
      assert.ok(budget.maxFeeWei - sent.maxFeeWei <= sent.maxFeeWei / 50n, 'and only by the nonce bytes');
    } finally {
      provider.destroy();
    }
  });

  test(`${n.key}: an account holding the fee to the wei gets a quote; one wei less does not`, async () => {
    const probe = mockFor(n);
    const { maxFeeWei } = await payinFeeBudget(probe.provider, { coin: probe.coin, from: ME, depositAddress: DEPOSIT, amount: probe.amount });
    probe.provider.destroy();
    for (const [native, ok] of [[maxFeeWei, true], [maxFeeWei - 1n, false]]) {
      const { coin, amount, provider } = mockFor(n, { native });
      try {
        const r = await checkPayinFunds(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
        assert.equal(r.native, native);
        assert.equal(r.token, amount * 2n);
        if (ok) assert.equal(r.problem, null);
        else assert.match(r.problem, new RegExp(`Not enough ${chain(n.key).native.symbol} on ${chain(n.key).name} for the network fee`));
      } finally {
        provider.destroy();
      }
    }
  });
}

test('Base: ETH for the gas but not the L1 data fee is refused before any quote (the gap)', async () => {
  const n = NETWORKS.find((x) => x.key === 'base');
  const gasOnly = gasLimitFor(n.gas) * n.perGas;
  const { coin, amount, provider } = mockFor(n, { native: gasOnly });
  try {
    // what the check before a quote used to test: the amount, with a fee of zero
    assert.equal(payinFundsProblem({ coin, chain: coin.chain, amount, tokenBalance: amount * 2n, nativeBalance: gasOnly, maxFeeWei: 0n }), null);
    const r = await checkPayinFunds(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
    assert.ok(r.budget.l1FeeWei > 0n);
    assert.ok(provider.l1Size > 100n && provider.l1Size < 200n, `L1 fee sized from the unsigned transfer (${provider.l1Size} bytes)`);
    assert.match(r.problem, /Not enough ETH on Base for the network fee/);
  } finally {
    provider.destroy();
  }
});

test('Arbitrum: the gas comes from the estimate, so a large L1 component is budgeted, not a fixed per-transfer figure', async () => {
  const n = NETWORKS.find((x) => x.key === 'arbitrum');
  // enough for an ordinary token transfer's 65,000 gas, far short of what Arbitrum estimates for this one
  const ordinary = 65_000n * n.perGas * 2n;
  const { coin, amount, provider } = mockFor(n, { native: ordinary });
  try {
    const r = await checkPayinFunds(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
    assert.equal(r.budget.gasLimit, gasLimitFor(562_310n));
    assert.equal(r.budget.fees.maxPriorityFeePerGas, 0n, 'no tip floor on Arbitrum');
    assert.match(r.problem, /Not enough ETH on Arbitrum One for the network fee/);
  } finally {
    provider.destroy();
  }
});

test('Optimism: an L1 fee oracle that does not answer stops the purchase, before the quote and at Review', async () => {
  const n = NETWORKS.find((x) => x.key === 'optimism');
  const { coin, amount, provider } = mockFor(n, { oracle: undefined });
  try {
    const r = await checkPayinFunds(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
    assert.equal(r.budget.l1FeeUnknown, true);
    assert.equal(r.budget.maxFeeWei, gasLimitFor(n.gas) * n.perGas, 'the budget leaves the unread fee out…');
    assert.match(r.problem, /Optimism L1 data fee could not be read/, '…so it is not taken as covered, with 1 ETH in the account');

    // Review: the prepared transfer carries the same flag, and the same check refuses it
    const prepared = await prepareTransaction(provider, 10, ME, coin.address, 0n, payinCall({ kind: 'erc20', token: coin.address, depositAddress: DEPOSIT, sendExactly: amount }).data, feePolicyFor(chain('optimism'), 3961));
    assert.equal(prepared.l1FeeUnknown, true);
    const review = payinFundsProblem({ coin, chain: coin.chain, amount, tokenBalance: amount * 2n, nativeBalance: 10n ** 18n, maxFeeWei: prepared.maxFeeWei, l1FeeUnknown: prepared.l1FeeUnknown });
    assert.match(review, /L1 data fee could not be read/);
    // a shortfall that is certain is still named first
    assert.match(payinFundsProblem({ coin, chain: coin.chain, amount, tokenBalance: amount - 1n, nativeBalance: 10n ** 18n, maxFeeWei: 0n, l1FeeUnknown: true }), /this purchase needs 25\.0 USDC/);
    assert.match(payinFundsProblem({ coin, chain: coin.chain, amount, tokenBalance: amount, nativeBalance: 0n, maxFeeWei: 0n, l1FeeUnknown: true }), /no ETH on Optimism/);
  } finally {
    provider.destroy();
  }
});

test('Optimism: the pre-Fjord oracle is read through getL1Fee, plus 25 %', async () => {
  const n = NETWORKS.find((x) => x.key === 'optimism');
  const { coin, amount, provider } = mockFor(n);
  try {
    const b = await payinFeeBudget(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
    assert.equal(b.l1FeeWei, 100_000_000_000n);
    assert.equal(b.maxFeeWei, gasLimitFor(n.gas) * n.perGas + 100_000_000_000n);
  } finally {
    provider.destroy();
  }
});

test('native coin (Base ETH): the exact value to the deposit address is estimated; amount + gas + L1 fee must fit', async () => {
  const n = NETWORKS.find((x) => x.key === 'base');
  const coin = payinCoin('base', 'ETH');
  const amount = parseUnits('0.01', 18);
  const probe = new ChainMock(8453, { base: n.base, tip: n.tip, native: 10n ** 18n, estimate: tokenGas(0n), oracle: n.oracle });
  const budget = await payinFeeBudget(probe, { coin, from: ME, depositAddress: DEPOSIT, amount });
  const [est] = probe.estimates();
  probe.destroy();
  assert.equal(getAddress(est.to), DEPOSIT);
  assert.equal(BigInt(est.value), amount);
  assert.ok(!est.data || est.data === '0x');
  assert.equal(budget.gasLimit, 21_000n, 'a plain transfer keeps exactly 21000');
  assert.equal(budget.maxFeeWei, 21_000n * n.perGas + budget.l1FeeWei);

  for (const [native, re] of [
    [amount + budget.maxFeeWei, null],
    [amount + budget.maxFeeWei - 1n, /plus the network fee .* Buy for a little less/],
    [amount + 21_000n * n.perGas, /plus the network fee/],
  ]) {
    const provider = new ChainMock(8453, { base: n.base, tip: n.tip, native, estimate: tokenGas(0n), oracle: n.oracle });
    try {
      const r = await checkPayinFunds(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
      assert.equal(r.token, null);
      if (re) assert.match(r.problem, re);
      else assert.equal(r.problem, null);
    } finally {
      provider.destroy();
    }
  }
});

test('fail safe: a transfer that would revert, or a fee that cannot be read, asks for no quote', async () => {
  const n = NETWORKS.find((x) => x.key === 'bsc');
  // the token refuses the transfer (the account's balance moved since it was read)
  const reverting = mockFor(n, { estimate: () => { throw rpcError('execution reverted: transfer amount exceeds balance', 3); } });
  await assert.rejects(checkPayinFunds(reverting.provider, { coin: reverting.coin, from: ME, depositAddress: DEPOSIT, amount: reverting.amount }), /This transaction would fail/);
  reverting.provider.destroy();
  // the node does not answer for the head block (no base fee, no price)
  const down = mockFor(n, { blockDown: true });
  await assert.rejects(checkPayinFunds(down.provider, { coin: down.coin, from: ME, depositAddress: DEPOSIT, amount: down.amount }));
  down.provider.destroy();
});

test('a coin amount the account does not hold is named without estimating anything', async () => {
  const n = NETWORKS.find((x) => x.key === 'polygon');
  const { coin, amount, provider } = mockFor(n, { tokens: { [payinCoin('polygon', 'USDT').address.toLowerCase()]: 1_000_000n } });
  try {
    const r = await checkPayinFunds(provider, { coin, from: ME, depositAddress: DEPOSIT, amount });
    assert.match(r.problem, /has 1 USDT on Polygon; this purchase needs 25\.0 USDT/);
    assert.equal(r.budget, null);
    assert.deepEqual(provider.estimates(), []);
  } finally {
    provider.destroy();
  }
});

test('a shortfall too small to show at 8 decimals is written out in full, not as "needs 0.00007594, has 0.00007594"', () => {
  const coin = payinCoin('base', 'USDC');
  const eth = payinCoin('base', 'ETH');
  // figures from a Base fork: 75,190 gas at 1.01 gwei plus a 0.69 gwei L1 data fee, against the gas alone
  const fee = 75_942_594_751_744n;
  const gasOnly = 75_941_900_000_000n;
  const r = payinFundsProblem({ coin, chain: coin.chain, amount: 25_000_000n, tokenBalance: 25_000_000n, nativeBalance: gasOnly, maxFeeWei: fee });
  assert.equal(r, 'Not enough ETH on Base for the network fee: this transfer needs up to 0.000075942594751744 ETH, the account has 0.0000759419 ETH.');
  const far = payinFundsProblem({ coin, chain: coin.chain, amount: 25_000_000n, tokenBalance: 25_000_000n, nativeBalance: 10n ** 12n, maxFeeWei: fee });
  assert.match(far, /needs up to 0\.00007594 ETH, the account has 0\.000001 ETH/, 'far apart: 8 decimals as before');
  const amount = parseUnits('0.01', 18);
  const native = payinFundsProblem({ coin: eth, chain: eth.chain, amount, tokenBalance: null, nativeBalance: amount + fee - 1n, maxFeeWei: fee });
  assert.match(native, /plus the network fee \(up to 0\.000075942594751744 ETH\) is more than the 0\.010075942594751743 ETH/);
});
