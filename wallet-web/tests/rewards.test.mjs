// Mining-reward parsing and the merged Activity feed.
// Fixtures are trimmed copies of real chain-3961 Blockscout v2 responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBalanceHistory,
  parseValidatedBlocks,
  hasNextPage,
  buildFeed,
  summariseMining,
} from '../src/lib/rewards.ts';
import { parseActivity } from '../src/lib/activity.ts';

const SELF = '0x7F16433359E4eF704E90cE08460c6238E45130f7';
const OTHER = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const REWARD = 6_000_000_000_000_000_000n; // 6 FMX per Ferminux block

const tsFor = (block) => new Date(Date.UTC(2026, 7, 20, 8, 0, 0) + block * 3500).toISOString();

const historyRow = (block, delta, extra = {}) => ({
  block_number: block,
  block_timestamp: tsFor(block),
  delta: String(delta),
  transaction_hash: null,
  value: '27000000000000000000000',
  ...extra,
});

const validatedRow = (height, reward = REWARD) => ({
  height,
  hash: '0x' + height.toString(16).padStart(64, 'a'),
  timestamp: tsFor(height),
  rewards: [{ reward: String(reward), type: 'validator' }],
  miner: { hash: SELF },
});

const txRow = (hash, block, { from = SELF, to = OTHER, value = '1000000000000000000' } = {}) => ({
  hash,
  block_number: block,
  timestamp: tsFor(block),
  from: { hash: from },
  to: { hash: to },
  value,
  status: 'ok',
  raw_input: '0x',
});

/* ---------------- parsers ---------------- */

test('balance history: parses the live coin-balance-history shape', () => {
  const payload = {
    items: [
      {
        block_number: 1516,
        block_timestamp: '2026-08-20T08:46:15Z',
        delta: '6000000000000000000',
        transaction_hash: null,
        value: '27403740062999999559000',
      },
      {
        block_number: 1515,
        block_timestamp: '2026-08-20T08:46:11Z',
        delta: '-1000000000000000000',
        transaction_hash: '0xdeadbeef',
        value: '27397740062999999559000',
      },
    ],
    next_page_params: { block_number: 1468, items_count: 50 },
  };
  const rows = parseBalanceHistory(payload);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    blockNumber: 1516,
    deltaWei: REWARD,
    valueWei: 27403740062999999559000n,
    timestamp: '2026-08-20T08:46:15Z',
    txHash: null,
  });
  assert.equal(rows[1].deltaWei, -1_000_000_000_000_000_000n);
  assert.equal(rows[1].txHash, '0xdeadbeef');
  assert.equal(hasNextPage(payload), true);
});

test('balance history: string block numbers, junk rows and empty payloads', () => {
  assert.equal(parseBalanceHistory({ items: [historyRow('1200', REWARD)] })[0].blockNumber, 1200);
  assert.deepEqual(parseBalanceHistory({ items: [{ nope: 1 }, { block_number: 5 }, { delta: '1' }] }), []);
  assert.deepEqual(parseBalanceHistory(null), []);
  assert.deepEqual(parseBalanceHistory({}), []);
  assert.deepEqual(parseBalanceHistory({ items: 'nope' }), []);
  assert.equal(hasNextPage({ items: [], next_page_params: null }), false);
  assert.equal(hasNextPage(undefined), false);
});

test('validated blocks: sums the rewards array and keeps the block hash', () => {
  const rows = parseValidatedBlocks({
    items: [
      validatedRow(1516),
      { ...validatedRow(1515), rewards: [{ reward: '6000000000000000000' }, { reward: '250000000000000000' }] },
      { ...validatedRow(1514), rewards: undefined },
      { height: null },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rewardWei, REWARD);
  assert.equal(rows[0].height, 1516);
  assert.match(rows[0].hash, /^0x[0-9a-f]{64}$/);
  assert.equal(rows[1].rewardWei, 6_250_000_000_000_000_000n);
  assert.equal(rows[2].rewardWei, 0n); // no reward data → 0, not a crash
  assert.deepEqual(parseValidatedBlocks(null), []);
});

/* ---------------- merge ---------------- */

test('feed: merges transfers and mined blocks newest-first', () => {
  const txs = parseActivity({ items: [txRow('0xt1', 1400), txRow('0xt2', 1200, { from: OTHER, to: SELF })] }, SELF);
  const validated = parseValidatedBlocks({ items: [validatedRow(1500), validatedRow(1300)] });
  const history = parseBalanceHistory({ items: [historyRow(1500, REWARD), historyRow(1300, REWARD)] });

  const feed = buildFeed(txs, history, validated);
  assert.deepEqual(
    feed.map((r) => [r.blockNumber, r.kind]),
    [
      [1500, 'mined'],
      [1400, 'tx'],
      [1300, 'mined'],
      [1200, 'tx'],
    ],
  );
  assert.equal(feed[1].tx.direction, 'out');
  assert.equal(feed[3].tx.direction, 'in');
  assert.equal(feed[0].rewardWei, REWARD);
  assert.equal(feed[0].source, 'validated');
});

test('feed: a validated block and a balance row for the same block yield ONE mined row', () => {
  const validated = parseValidatedBlocks({ items: [validatedRow(1500)] });
  const history = parseBalanceHistory({ items: [historyRow(1500, REWARD)] });
  const feed = buildFeed([], history, validated);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].kind, 'mined');
  assert.equal(feed[0].source, 'validated'); // the exact figure wins over the inferred one
  assert.equal(feed[0].rewardWei, REWARD);
});

test('feed: a reward and a transfer in the same block are not double-counted', () => {
  // The address mined 1500 AND received 2 FMX in it. Blockscout reports a
  // single net delta of 8 FMX for that block.
  const txs = parseActivity(
    { items: [txRow('0xmix', 1500, { from: OTHER, to: SELF, value: '2000000000000000000' })] },
    SELF,
  );
  const history = parseBalanceHistory({ items: [historyRow(1500, 8_000_000_000_000_000_000n)] });

  // Without /blocks-validated the net delta is NOT promoted to a mined row:
  // the transfer already explains a credit in that block.
  const inferredOnly = buildFeed(txs, history, []);
  assert.deepEqual(inferredOnly.map((r) => r.kind), ['tx']);
  assert.equal(summariseMining(inferredOnly), null);

  // With /blocks-validated the exact 6 FMX reward is shown alongside the
  // transfer — one row each, transfer first, and no 8 FMX phantom.
  const withValidated = buildFeed(txs, history, parseValidatedBlocks({ items: [validatedRow(1500)] }));
  assert.deepEqual(withValidated.map((r) => [r.blockNumber, r.kind]), [[1500, 'tx'], [1500, 'mined']]);
  assert.equal(withValidated[1].rewardWei, REWARD);
  assert.equal(summariseMining(withValidated).totalWei, REWARD);
});

test('feed: a validated block with no reward figure yet falls back to its balance credit', () => {
  // Observed on the live chain: Blockscout indexes a block before it computes
  // the reward, returning `rewards: []` for the newest blocks.
  const validated = parseValidatedBlocks({
    items: [{ ...validatedRow(1694), rewards: [] }, validatedRow(1693), { ...validatedRow(1692), rewards: [] }],
  });
  const history = parseBalanceHistory({ items: [historyRow(1694, REWARD)] }); // 1692 is outside the window
  const feed = buildFeed([], history, validated);

  assert.equal(feed.length, 3);
  assert.equal(feed[0].blockNumber, 1694);
  assert.equal(feed[0].rewardWei, REWARD, 'reward recovered from the balance credit');
  assert.equal(feed[0].source, 'balance', 'and honestly marked as inferred');
  assert.equal(feed[1].rewardWei, REWARD);
  assert.equal(feed[1].source, 'validated');
  assert.equal(feed[2].rewardWei, 0n, 'no figure and no credit → unknown, never invented');

  const s = summariseMining(feed);
  assert.equal(s.blocks, 3);
  assert.equal(s.totalWei, 2n * REWARD, 'an unknown reward contributes nothing to the total');
  assert.equal(s.unknownRewards, 1);
  assert.equal(s.hasInferred, true);
});

test('feed: the reward fallback never borrows a credit a transfer already explains', () => {
  const txs = parseActivity(
    { items: [txRow('0xin', 1694, { from: OTHER, to: SELF, value: '5000000000000000000' })] },
    SELF,
  );
  const validated = parseValidatedBlocks({ items: [{ ...validatedRow(1694), rewards: [] }] });
  const history = parseBalanceHistory({ items: [historyRow(1694, 5_000_000_000_000_000_000n)] });
  const feed = buildFeed(txs, history, validated);
  const mined = feed.find((r) => r.kind === 'mined');
  assert.equal(mined.rewardWei, 0n, 'the 5 FMX belongs to the transfer row, not to the block reward');
  assert.equal(mined.source, 'validated');
  assert.equal(summariseMining(feed).unknownRewards, 1);
});

test('feed: balance deltas become mined rows only when nothing else explains them', () => {
  const history = parseBalanceHistory({
    items: [
      historyRow(1500, REWARD), // unattributed credit → mined
      historyRow(1499, -REWARD), // a debit is never a reward
      historyRow(1498, 0n), // no change
      historyRow(1497, REWARD, { transaction_hash: '0xabc' }), // attributed to a tx → not a reward
      historyRow(1496, REWARD), // block also contains one of our txs → skipped
    ],
  });
  const txs = parseActivity({ items: [txRow('0xt', 1496)] }, SELF);
  const feed = buildFeed(txs, history, []);
  assert.deepEqual(feed.map((r) => [r.blockNumber, r.kind]), [[1500, 'mined'], [1496, 'tx']]);
  assert.equal(feed[0].source, 'balance');
  assert.equal(feed[0].blockHash, null);
});

test('feed: duplicate transactions are deduped by hash, case-insensitively', () => {
  const txs = parseActivity(
    { items: [txRow('0xAAA', 1500), txRow('0xaaa', 1500), txRow('0xbbb', 1499)] },
    SELF,
  );
  const feed = buildFeed(txs, [], []);
  assert.equal(feed.length, 2);
  assert.deepEqual(feed.map((r) => r.id), ['tx:0xaaa', 'tx:0xbbb']);
});

test('feed: duplicate validated blocks are deduped by height', () => {
  const feed = buildFeed([], [], parseValidatedBlocks({ items: [validatedRow(1500), validatedRow(1500)] }));
  assert.equal(feed.length, 1);
});

test('feed: pending transactions (no block yet) sort above everything', () => {
  const txs = parseActivity(
    { items: [{ ...txRow('0xpend', 0), block_number: null, timestamp: null, status: null }, txRow('0xold', 1400)] },
    SELF,
  );
  const feed = buildFeed(txs, [], parseValidatedBlocks({ items: [validatedRow(9999)] }));
  assert.deepEqual(feed.map((r) => [r.blockNumber, r.kind]), [[null, 'tx'], [9999, 'mined'], [1400, 'tx']]);
  assert.equal(feed[0].tx.success, null);
});

test('feed: empty inputs produce an empty feed and no summary', () => {
  assert.deepEqual(buildFeed([], [], []), []);
  assert.equal(summariseMining([]), null);
  assert.equal(summariseMining(buildFeed(parseActivity({ items: [txRow('0xt', 10)] }, SELF), [], [])), null);
});

test('feed: ordering is stable for rows sharing a block and a timestamp', () => {
  const validated = parseValidatedBlocks({ items: [validatedRow(1500), validatedRow(1501)] });
  const a = buildFeed([], [], validated).map((r) => r.id);
  const b = buildFeed([], [], [...validated].reverse()).map((r) => r.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['mined:1501', 'mined:1500']);
});

/* ---------------- summary ---------------- */

test('summary: totals, window bounds and the most recent reward', () => {
  const validated = parseValidatedBlocks({ items: [1500, 1499, 1498].map((h) => validatedRow(h)) });
  const feed = buildFeed(parseActivity({ items: [txRow('0xt', 1450)] }, SELF), [], validated);
  const s = summariseMining(feed, { complete: false });
  assert.equal(s.blocks, 3);
  assert.equal(s.totalWei, 3n * REWARD);
  assert.equal(s.highestBlock, 1500);
  assert.equal(s.lowestBlock, 1498);
  assert.equal(s.latestTimestamp, tsFor(1500));
  assert.equal(s.complete, false); // must be reported as a window, not an all-time total
  assert.equal(s.hasInferred, false);
});

test('summary: flags inferred rewards and defaults to "windowed"', () => {
  const feed = buildFeed([], parseBalanceHistory({ items: [historyRow(1500, REWARD)] }), []);
  const s = summariseMining(feed);
  assert.equal(s.hasInferred, true);
  assert.equal(s.complete, false);
  assert.equal(summariseMining(feed, { complete: true }).complete, true);
});

test('summary: survives rows with no timestamp', () => {
  const feed = buildFeed([], [], parseValidatedBlocks({ items: [{ ...validatedRow(1500), timestamp: null }] }));
  const s = summariseMining(feed);
  assert.equal(s.blocks, 1);
  assert.equal(s.latestTimestamp, null);
});
