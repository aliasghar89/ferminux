#!/usr/bin/env node
// Live, READ-ONLY check against the real Ferminux Network explorer.
//
// Drives the wallet's own modules (src/lib/activity.ts + src/lib/rewards.ts —
// the exact code the Activity tab runs) against a live address and prints the
// feed the UI would render, so signed-block rows can be verified against the
// chain rather than against a fixture.
//
// Sends nothing. Signs nothing. Only GETs the Blockscout REST API.
//
//   node scripts/live-activity.mjs [address]
//
// Default address: 0x7F16433359E4eF704E90cE08460c6238E45130f7 (a pre-fork block producer).

import { EXPLORER_URL, NATIVE_SYMBOL, CHAIN_ID } from '../src/config.ts';
import { fetchActivity } from '../src/lib/activity.ts';
import { fetchBlockRewardData, buildFeed, summariseSigning } from '../src/lib/rewards.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../src/lib/validate.ts';

const address = process.argv[2] ?? '0x7F16433359E4eF704E90cE08460c6238E45130f7';

const fmt = (wei) => `${formatAmount(wei)} ${NATIVE_SYMBOL}`;

console.log(`Ferminux Network · chain ${CHAIN_ID} · explorer ${EXPLORER_URL}`);
console.log(`Address ${address}\n`);

const [txsResult, rewardResult] = await Promise.allSettled([
  fetchActivity(EXPLORER_URL, address),
  fetchBlockRewardData(EXPLORER_URL, address),
]);

const txs = txsResult.status === 'fulfilled' ? txsResult.value : [];
const rewards =
  rewardResult.status === 'fulfilled'
    ? rewardResult.value
    : { history: [], validated: [], available: false, complete: true };

console.log(
  `sources: transactions=${txsResult.status === 'fulfilled' ? `${txs.length} item(s)` : `FAILED (${txsResult.reason?.message ?? txsResult.reason})`}` +
    ` · coin-balance-history=${rewards.history.length} row(s)` +
    ` · blocks-validated=${rewards.validated.length} block(s)` +
    ` · complete-window=${rewards.complete}`,
);

if (txsResult.status === 'rejected' && !rewards.available) {
  console.error('\nBoth explorer endpoints failed — the wallet would render "History unavailable".');
  process.exit(1);
}

const feed = buildFeed(txs, rewards.history, rewards.validated);
const summary = summariseSigning(feed, { complete: rewards.complete });

console.log('\n--- Block-reward summary card (rendered only when this is non-null) ---');
if (!summary) {
  console.log('(hidden — this address has signed nothing in the fetched window)');
} else {
  console.log(`  Blocks signed    ${summary.blocks.toLocaleString('en-US')}`);
  console.log(`  Rewards earned  ${fmt(summary.totalWei)}   (exact: ${formatAmountExact(summary.totalWei)})`);
  console.log(`  Most recent     ${summary.latestTimestamp ?? '—'}`);
  console.log(
    `  Note            Covers blocks ${summary.lowestBlock}–${summary.highestBlock}` +
      (summary.complete ? ' — everything the explorer returned.' : ' only — NOT an all-time total.') +
      (summary.hasInferred ? ' Some rewards inferred from balance changes.' : '') +
      (summary.unknownRewards > 0
        ? ` ${summary.unknownRewards} block(s) have no reward figure yet and are excluded from the total.`
        : ''),
  );
}

console.log('\n--- Activity feed (first 25 rows, newest first) ---');
for (const row of feed.slice(0, 25)) {
  if (row.kind === 'signed') {
    console.log(
      `  MINED   block #${String(row.blockNumber).padStart(7)}  ` +
        `+${fmt(row.rewardWei).padStart(14)}  ${row.timestamp ?? 'time unknown'}  [${row.source}]`,
    );
  } else {
    const tx = row.tx;
    const label = tx.success === false ? 'FAIL ' : tx.direction === 'in' ? 'IN   ' : tx.direction === 'self' ? 'SELF ' : 'OUT  ';
    const counterparty = tx.direction === 'in' ? tx.from : tx.to;
    console.log(
      `  ${label}   block #${String(tx.blockNumber ?? 'pending').padStart(7)}  ` +
        `${(tx.direction === 'in' ? '+' : '-') + fmt(tx.valueWei)}`.padStart(15) +
        `  ${tx.timestamp ?? 'pending'}  ${counterparty ? shortAddress(counterparty) : 'contract creation'}`,
    );
  }
}
if (feed.length > 25) console.log(`  … ${feed.length - 25} more row(s)`);
if (feed.length === 0) console.log('  (empty — the wallet would show the "No activity yet" state)');

/* ---------------- assertions ---------------- */

const signedRows = feed.filter((r) => r.kind === 'signed');
const txRows = feed.filter((r) => r.kind === 'tx');
const blocks = feed.map((r) => r.blockNumber ?? Number.MAX_SAFE_INTEGER);
const ordered = blocks.every((b, i) => i === 0 || blocks[i - 1] >= b);
const noDupes = new Set(feed.map((r) => r.id)).size === feed.length;

console.log('\n--- Checks ---');
const results = [
  ['Signed-block rows present', signedRows.length > 0],
  ['Transfer rows present', txRows.length > 0],
  ['Feed is newest-first', ordered],
  ['No duplicate rows', noDupes],
  ['No signed-block row reports a negative reward', signedRows.every((r) => r.rewardWei >= 0n)],
  [
    'Block rewards are the expected 6 FMX',
    signedRows.filter((r) => r.rewardWei === 6n * 10n ** 18n).length > 0,
  ],
  [
    'At most a handful of rewards are still un-indexed',
    signedRows.filter((r) => r.rewardWei === 0n).length <= signedRows.length / 4,
  ],
];
let failed = 0;
for (const [label, pass] of results) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed += 1;
}

const rewardHistogram = new Map();
for (const r of signedRows) {
  const key = formatAmountExact(r.rewardWei);
  rewardHistogram.set(key, (rewardHistogram.get(key) ?? 0) + 1);
}
console.log('\n  Distinct reward amounts seen:');
for (const [amount, count] of [...rewardHistogram].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${count.toString().padStart(4)} × ${amount} ${NATIVE_SYMBOL}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed (read-only; nothing was signed or broadcast).');
