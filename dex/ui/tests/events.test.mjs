// Pool event decoding, log scanning and the market record, on hand-encoded
// logs: the same bytes a FerminuxPair emits. The fork e2e runs the same code
// over chain 3961's real history.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, parseEther, parseUnits } from 'ethers';

import {
  BlockClock,
  TOPICS,
  addressTopic,
  assemblePoolEvents,
  decodePoolLog,
  scanLogs,
} from '../src/lib/events.ts';
import {
  bucketSums,
  deserializeMarket,
  emptyMarket,
  feeUsdE18,
  marketOverview,
  poolPriceSeries,
  poolStats,
  refreshMarket,
  serializeMarket,
  syncLogs,
  tradeUsdE18,
  tradesFrom,
  tvlSeries,
} from '../src/lib/market.ts';
import { E18, baseTable } from '../src/lib/prices.ts';

const coder = AbiCoder.defaultAbiCoder();
const WFMX = '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae';
const USDF = '0xCd032A609e34121D1881E8DE7355b2c2c7092363';
const PAIR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROUTER = '0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f';
const TRADER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const tok = (address, symbol, decimals) => ({ kind: 'erc20', address, symbol, name: symbol, decimals });
// Sorted like the factory: USDF (0xCd…) < WFMX? No: 0x8a… < 0xCd…, so WFMX is token0.
const pool = { pair: PAIR, token0: tok(WFMX, 'WFMX', 18), token1: tok(USDF, 'USDF', 6), reserve0: parseEther('50000'), reserve1: parseUnits('26000', 6), totalSupply: 1n, blockTimestampLast: 0 };

const sync = (block, logIndex, tx, r0, r1) => ({
  address: PAIR,
  topics: [TOPICS.sync],
  data: coder.encode(['uint112', 'uint112'], [r0, r1]),
  blockNumber: block,
  logIndex,
  transactionHash: tx,
});
const swap = (block, logIndex, tx, a0i, a1i, a0o, a1o, to = TRADER) => ({
  address: PAIR,
  topics: [TOPICS.swap, addressTopic(ROUTER), addressTopic(to)],
  data: coder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [a0i, a1i, a0o, a1o]),
  blockNumber: block,
  logIndex,
  transactionHash: tx,
});
const mint = (block, logIndex, tx, a0, a1) => ({
  address: PAIR,
  topics: [TOPICS.mint, addressTopic(ROUTER)],
  data: coder.encode(['uint256', 'uint256'], [a0, a1]),
  blockNumber: block,
  logIndex,
  transactionHash: tx,
});
const tx = (n) => '0x' + n.toString(16).padStart(64, '0');

// A pool seeded at $0.52, then one buy of FMX with 520 USDF, then one sale of 100 FMX.
const seedLogs = [
  sync(100, 0, tx(1), parseEther('50000'), parseUnits('26000', 6)),
  mint(100, 1, tx(1), parseEther('50000'), parseUnits('26000', 6)),
];
const buy = [sync(200, 3, tx(2), parseEther('49010.3'), parseUnits('26520', 6)), swap(200, 4, tx(2), 0n, parseUnits('520', 6), parseEther('989.7'), 0n)];
const sell = [sync(300, 0, tx(3), parseEther('49110.3'), parseUnits('26467.4', 6)), swap(300, 1, tx(3), parseEther('100'), 0n, 0n, parseUnits('52.6', 6), ROUTER)];
const all = [...seedLogs, ...buy, ...sell];

test('the event topics are the FerminuxPair signatures', () => {
  assert.equal(TOPICS.swap, '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
  assert.equal(TOPICS.sync, '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
  assert.equal(TOPICS.mint, '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f');
  assert.equal(addressTopic(TRADER), '0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8');
});

test('decodePoolLog reads Swap, Sync and Mint, and ignores anything else', () => {
  const s = decodePoolLog(buy[1]);
  assert.equal(s.kind, 'swap');
  assert.equal(s.to, TRADER);
  assert.equal(s.sender, ROUTER);
  assert.equal(s.amount1In, parseUnits('520', 6));
  assert.equal(s.amount0Out, parseEther('989.7'));
  const y = decodePoolLog(buy[0]);
  assert.equal(y.kind, 'sync');
  assert.equal(y.reserve1, parseUnits('26520', 6));
  assert.equal(decodePoolLog(seedLogs[1]).kind, 'mint');
  assert.equal(decodePoolLog({ ...buy[1], topics: [TOPICS.transfer] }), null);
  assert.equal(decodePoolLog({ ...buy[1], data: '0x1234' }), null, 'malformed data is dropped, not thrown');
});

test('assemblePoolEvents attaches the Sync that precedes each event in the same transaction', () => {
  const { events, syncs } = assemblePoolEvents(all.map(decodePoolLog).reverse());
  assert.equal(syncs.length, 3);
  assert.deepEqual(events.map((e) => e.kind), ['mint', 'swap', 'swap']);
  assert.equal(events[1].reserve1, parseUnits('26520', 6));
  // A Swap whose tx has no Sync before it gets no reserves rather than someone else's.
  const orphan = assemblePoolEvents([decodePoolLog(sync(1, 0, tx(9), 1n, 1n)), decodePoolLog(swap(2, 0, tx(10), 1n, 0n, 0n, 1n))]);
  assert.equal(orphan.events[0].reserve0, null);
});

test('scanLogs splits a range the node refuses, down to what it accepts', async () => {
  const calls = [];
  const source = {
    async getLogs({ fromBlock, toBlock }) {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock > 99) throw new Error('query returned more than 10000 results');
      return all.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const logs = await scanLogs(source, { address: PAIR }, 0, 399);
  assert.equal(logs.length, all.length);
  assert.ok(calls.length > 4, 'it split');
  assert.deepEqual(logs.map((l) => l.blockNumber), [100, 100, 200, 200, 300, 300], 'sorted');
  await assert.rejects(scanLogs({ getLogs: async () => { throw new Error('down'); } }, { address: PAIR }, 5, 5), /down/);
});

test('BlockClock: exact where fetched, interpolated between, extrapolated at 7 s', async () => {
  const rpc = { send: async (_m, [hex]) => ({ timestamp: '0x' + (1_000_000 + Number(BigInt(hex)) * 7).toString(16) }) };
  const clock = new BlockClock();
  await clock.ensure(rpc, [100, 300]);
  assert.equal(clock.at(100), 1_000_700);
  assert.equal(clock.at(200), 1_001_400, 'interpolated');
  assert.equal(clock.at(310), 1_002_170, 'extrapolated');
  const again = new BlockClock(clock.toJSON());
  assert.equal(again.at(300), 1_002_100, 'serialises');
  // Past the cap it fetches anchors, not every block.
  let n = 0;
  const counting = { send: async (m, p) => ((n += 1), rpc.send(m, p)) };
  const many = Array.from({ length: 5000 }, (_, i) => i + 1);
  await new BlockClock().ensure(counting, many, 100);
  assert.ok(n < 200, `bounded requests, made ${n}`);
});

async function record() {
  const clock = new BlockClock();
  const rpc = { send: async (_m, [hex]) => ({ timestamp: '0x' + (2_000_000_000 + Number(BigInt(hex)) * 60).toString(16) }) };
  const source = { getLogs: async ({ fromBlock, toBlock }) => all.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock) };
  const state = await refreshMarket(emptyMarket(), { source, rpc, clock, pairs: [PAIR], head: 400, startBlock: 50 });
  return { state, clock, source, rpc };
}

test('refreshMarket records every log once, and a second pass adds nothing', async () => {
  const { state, clock, source, rpc } = await record();
  assert.equal(state.logs.length, all.length);
  assert.equal(state.scanned[PAIR], 400 - 6, 'the last few blocks stay open for a reorg');
  const again = await refreshMarket(state, { source, rpc, clock, pairs: [PAIR], head: 410, startBlock: 50 });
  assert.equal(again.logs.length, all.length);
  const round = deserializeMarket(serializeMarket(again));
  assert.deepEqual(round, again, 'bigints survive the JSON round trip');
  assert.equal(deserializeMarket('{"version":2}'), null);
});

test('trades, volume and fees are read at the pegged side', async () => {
  const { state, clock } = await record();
  const prices = baseTable(WFMX);
  const trades = tradesFrom(state, new Map([[PAIR, pool]]), prices, clock);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].tokenIn.symbol, 'USDF');
  assert.equal(trades[0].amountOut, parseEther('989.7'));
  assert.equal(trades[0].usdE18, 520n * E18, 'the USDF side, at $1');
  assert.equal(trades[1].usdE18, (526n * E18) / 10n);
  assert.equal(tradeUsdE18(decodePoolLog(sell[1]), pool, prices), (526n * E18) / 10n);
  const now = 2_000_000_000 + 300 * 60 + 100;
  const stats = poolStats(pool, trades, prices, now);
  assert.equal(stats.volume24hUsdE18, 520n * E18 + (526n * E18) / 10n);
  assert.equal(stats.fees24hUsdE18, feeUsdE18(stats.volume24hUsdE18));
  assert.equal(stats.tvlUsdE18, 52_000n * E18, '50,000 FMX at $0.52 + 26,000 USDF');
  assert.equal(stats.tradesAll, 2);
  assert.ok(stats.apr24hPpm > 0n);
  const later = poolStats(pool, trades, prices, now + 8 * 86_400);
  assert.equal(later.volume24hUsdE18, 0n, 'old trades fall out of the window');
  const o = marketOverview([stats], trades);
  assert.equal(o.volumeAllUsdE18, stats.volume24hUsdE18);
  assert.equal(o.tvlUsdE18, 52_000n * E18);
});

test('price and TVL series come from the Sync history', async () => {
  const { state, clock } = await record();
  const syncs = syncLogs(state);
  const usd = poolPriceSeries(syncs, pool, WFMX, clock, E18);
  assert.equal(usd.length, 3);
  assert.ok(Math.abs(usd[0].v - 0.52) < 1e-12, 'opens at $0.52');
  assert.ok(usd[1].v > usd[0].v, 'a buy lifts the price');
  const inFmx = poolPriceSeries(syncs, pool, USDF, clock);
  assert.ok(Math.abs(inFmx[0].v - 1 / 0.52) < 1e-9, 'the inverse view');
  const t0 = clock.at(100);
  const tvl = tvlSeries(syncs, new Map([[PAIR, pool]]), baseTable(WFMX), clock, 3600, t0 - 3600, t0 + 6 * 3600);
  assert.equal(tvl[0].v, 0, 'nothing before the first deposit');
  assert.ok(Math.abs(tvl[tvl.length - 1].v - 52_000) < 60, 'about $52,000 after');
  const buckets = bucketSums([{ time: 10, usdE18: 1n }, { time: 15, usdE18: 2n }, { time: 25, usdE18: 4n }, { time: null, usdE18: 8n }], 10, 10, 30);
  assert.deepEqual(buckets.map((b) => b.usdE18), [3n, 4n]);
});
