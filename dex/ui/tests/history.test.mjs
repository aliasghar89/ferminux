// Account history on hand-built logs: which transactions are the account's,
// and how each becomes one line (native FMX in and out recognised, routes
// read hop by hop, approvals only for the router and the locker).

import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, parseEther, parseUnits } from 'ethers';

import { BlockClock, TOPICS, ZERO_TOPIC, addressTopic, decodePoolLog } from '../src/lib/events.ts';
import { loadAccountActivity } from '../src/lib/history.ts';
import { nativeToken } from '../src/lib/tokens.ts';

const coder = AbiCoder.defaultAbiCoder();
const WFMX = '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae';
const USDF = '0xCd032A609e34121D1881E8DE7355b2c2c7092363';
const AZNT = '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178';
const ROUTER = '0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f';
const LOCKER = '0xe588c594388B978E64B69E2Dd91CC7E302763951';
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const P_WU = '0x1111111111111111111111111111111111111111'; // WFMX/USDF
const P_WA = '0x2222222222222222222222222222222222222222'; // WFMX/AZNT
const tok = (address, symbol, decimals) => ({ kind: 'erc20', address, symbol, name: symbol, decimals });
const tW = tok(WFMX, 'WFMX', 18);
const tU = tok(USDF, 'USDF', 6);
const tA = tok(AZNT, 'AZNT', 6);
const pools = [
  { pair: P_WU, token0: tW, token1: tU, reserve0: 1n, reserve1: 1n, totalSupply: 1n, blockTimestampLast: 0 },
  { pair: P_WA, token0: tW, token1: tA, reserve0: 1n, reserve1: 1n, totalSupply: 1n, blockTimestampLast: 0 },
];
const h = (n) => '0x' + n.toString(16).padStart(64, '0');
const log = (address, topics, types, values, block, logIndex, txn) => ({
  address,
  topics,
  data: coder.encode(types, values),
  blockNumber: block,
  logIndex,
  transactionHash: h(txn),
});
const swapT = (to) => [TOPICS.swap, addressTopic(ROUTER), addressTopic(to)];
const U4 = ['uint256', 'uint256', 'uint256', 'uint256'];

const logs = [
  // tx 1 (mine, 100 FMX sent with it): FMX → USDF through one pool
  log(P_WU, swapT(ME), U4, [parseEther('100'), 0n, 0n, parseUnits('51.7', 6)], 10, 1, 1),
  // tx 2 (mine): 50 USDF → FMX, paid to the router (native out)
  log(P_WU, swapT(ROUTER), U4, [0n, parseUnits('50', 6), parseEther('96'), 0n], 20, 1, 2),
  // tx 3 (mine): AZNT → WFMX → USDF, two pools, to me
  log(P_WA, swapT(P_WU), U4, [0n, parseUnits('88', 6), parseEther('99'), 0n], 30, 1, 3),
  log(P_WU, swapT(ME), U4, [parseEther('99'), 0n, 0n, parseUnits('51', 6)], 30, 3, 3),
  // tx 4 (someone else, paying the router): not mine
  log(P_WU, swapT(ROUTER), U4, [0n, parseUnits('10', 6), parseEther('19'), 0n], 40, 1, 4),
  // tx 5 (mine): add liquidity, LP minted to me
  log(P_WU, [TOPICS.mint, addressTopic(ROUTER)], ['uint256', 'uint256'], [parseEther('10'), parseUnits('5.2', 6)], 50, 2, 5),
  log(P_WU, [TOPICS.transfer, ZERO_TOPIC, addressTopic(ME)], ['uint256'], [12345n], 50, 3, 5),
  // tx 6 (mine): remove liquidity unwrapped to FMX (Burn pays the router)
  log(P_WU, [TOPICS.burn, addressTopic(ROUTER), addressTopic(ROUTER)], ['uint256', 'uint256'], [parseEther('5'), parseUnits('2.6', 6)], 60, 2, 6),
  // tx 7 (mine): wrap
  log(WFMX, [TOPICS.deposit, addressTopic(ME)], ['uint256'], [parseEther('3')], 70, 0, 7),
  // tx 8 (mine): approve USDF for the router (unlimited)
  log(USDF, [TOPICS.approval, addressTopic(ME), addressTopic(ROUTER)], ['uint256'], [2n ** 256n - 1n], 80, 0, 8),
  // tx 9 (mine): approve USDF for some other contract: not a DEX action
  log(USDF, [TOPICS.approval, addressTopic(ME), addressTopic(OTHER)], ['uint256'], [5n], 90, 0, 9),
];
const txs = {
  1: { from: ME, to: ROUTER, value: parseEther('100') },
  2: { from: ME, to: ROUTER, value: 0n },
  3: { from: ME, to: ROUTER, value: 0n },
  4: { from: OTHER, to: ROUTER, value: 0n },
  5: { from: ME, to: ROUTER, value: parseEther('10') },
  6: { from: ME, to: ROUTER, value: 0n },
  7: { from: ME, to: WFMX, value: parseEther('3') },
  8: { from: ME, to: USDF, value: 0n },
  9: { from: ME, to: USDF, value: 0n },
};

const matchTopic = (want, got) => want === null || want === undefined || (Array.isArray(want) ? want.includes(got) : want === got);
const source = {
  async getLogs({ address, topics = [], fromBlock, toBlock }) {
    const addrs = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
    return logs.filter(
      (l) =>
        addrs.includes(l.address.toLowerCase()) &&
        l.blockNumber >= fromBlock &&
        l.blockNumber <= toBlock &&
        topics.every((t, i) => matchTopic(t, l.topics[i])),
    );
  },
};
const rpc = {
  async send(method, params) {
    if (method === 'eth_getTransactionByHash') {
      const t = txs[Number(BigInt(params[0]))];
      return t ? { from: t.from, to: t.to, value: '0x' + t.value.toString(16) } : null;
    }
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + (1_800_000_000 + Number(BigInt(params[0])) * 7).toString(16) };
    throw new Error(method);
  },
};
const market = { version: 1, scanned: {}, logs: logs.map(decodePoolLog).filter(Boolean) };

test('history: one line per transaction the account signed, oldest last', async () => {
  const items = await loadAccountActivity({
    source,
    rpc,
    clock: new BlockClock(),
    account: ME,
    pools,
    tokens: [nativeToken(WFMX), tW, tU, tA],
    wfmx: WFMX,
    router: ROUTER,
    locker: LOCKER,
    market,
    fromBlock: 0,
    head: 100,
    txCache: new Map(),
  });
  assert.deepEqual(
    items.map((i) => i.kind),
    ['approve', 'wrap', 'remove', 'add', 'swap', 'swap', 'swap'],
    'the other account’s trade and the non-DEX approval are left out',
  );
  const [approve, wrap, remove, add, s3, s2, s1] = items;
  assert.equal(s1.tokenIn.symbol, 'FMX', 'value was sent: native FMX in');
  assert.equal(s1.tokenOut.symbol, 'USDF');
  assert.equal(s2.tokenIn.symbol, 'USDF');
  assert.equal(s2.tokenOut.symbol, 'FMX', 'paid to the router: native FMX out');
  assert.equal(s2.amountOut, parseEther('96'));
  assert.deepEqual(s3.route, ['AZNT', 'WFMX', 'USDF'], 'two pools, read hop by hop');
  assert.equal(s3.amountIn, parseUnits('88', 6));
  assert.equal(s3.amountOut, parseUnits('51', 6));
  assert.equal(add.pool.pair, P_WU);
  assert.equal(add.amount1, parseUnits('5.2', 6));
  assert.equal(remove.native, true, 'the removal paid FMX, not WFMX');
  assert.equal(wrap.amount, parseEther('3'));
  assert.equal(approve.spender, 'router');
  assert.equal(approve.tokenLabel, 'USDF');
  assert.equal(approve.amount, 2n ** 256n - 1n);
  assert.ok(items.every((i) => i.time === 1_800_000_000 + i.block * 7), 'dated from the block');
});
