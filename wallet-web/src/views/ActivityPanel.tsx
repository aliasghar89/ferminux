import { useCallback, useEffect, useState } from 'react';
import { fetchActivity, type ActivityItem } from '../lib/activity.ts';
import {
  buildFeed,
  fetchMiningData,
  summariseMining,
  type FeedRow,
  type MiningSummary,
} from '../lib/rewards.ts';
import { EXPLORER_URL, NATIVE_SYMBOL } from '../config.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { Identicon } from '../components/Identicon.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      rows: FeedRow[];
      mining: MiningSummary | null;
      /** true when the transactions endpoint failed but mining data came through. */
      txsMissing: boolean;
    };

export function ActivityPanel({
  address,
  label,
  refreshKey,
}: {
  address: string;
  /** The active account this history belongs to — the feed is per-account. */
  label: string;
  refreshKey: number;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    // Transactions and mining rewards are independent sources. Either alone is
    // enough to render a feed; only losing both is "history unavailable".
    const [txsResult, miningResult] = await Promise.allSettled([
      fetchActivity(EXPLORER_URL, address),
      fetchMiningData(EXPLORER_URL, address),
    ]);

    const txs: ActivityItem[] = txsResult.status === 'fulfilled' ? txsResult.value : [];
    const mining =
      miningResult.status === 'fulfilled'
        ? miningResult.value
        : { history: [], validated: [], available: false, complete: true };

    if (txsResult.status === 'rejected' && !mining.available) {
      setState({ kind: 'unavailable' });
      return;
    }

    const rows = buildFeed(txs, mining.history, mining.validated);
    setState({
      kind: 'ready',
      rows,
      mining: summariseMining(rows, { complete: mining.complete }),
      txsMissing: txsResult.status === 'rejected',
    });
  }, [address]);

  useEffect(() => {
    void load();
  }, [load, attempt, refreshKey]);

  const context = (
    <div className="holder-line holder-line-inset">
      <Identicon address={address} size={20} />
      <span>
        Activity for <strong>{label}</strong> <span className="mono muted">{shortAddress(address)}</span>
      </span>
    </div>
  );

  if (state.kind === 'loading') {
    return (
      <>
      {context}
      <ul className="row-list" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <span className="skeleton" style={{ width: 42, height: 20 }} />
            <div className="row-main">
              <span className="skeleton" style={{ width: 140 }}>
                loading
              </span>
            </div>
            <span className="skeleton" style={{ width: 90 }}>
              0.0
            </span>
          </li>
        ))}
      </ul>
      </>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <>
      {context}
      <div className="empty-state">
        <div className="title">History unavailable</div>
        The explorer API could not be reached. Balances and sending keep working over RPC.
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
        </div>
      </div>
      </>
    );
  }

  if (state.rows.length === 0) {
    return (
      <>
        {context}
        <div className="empty-state">
          <div className="title">No activity yet</div>
          Transfers and mined block rewards for {label} will appear here once the explorer has indexed them.
        </div>
      </>
    );
  }

  return (
    <>
      {context}
      {state.mining && <MiningCard summary={state.mining} />}
      {state.txsMissing && (
        <div className="notice" style={{ margin: '16px 20px 0' }}>
          Showing mined block rewards only — the transactions endpoint did not respond.{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
        </div>
      )}
      <ul className="row-list">
        {state.rows.map((row) => (row.kind === 'mined' ? <MinedRow key={row.id} row={row} /> : <TxRow key={row.id} tx={row.tx} />))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ */

function MiningCard({ summary }: { summary: MiningSummary }) {
  return (
    <div className="mining-card" data-testid="mining-card">
      <div className="mining-head">
        <span className="dir-badge dir-mined">MINED</span>
        <span className="mining-title">Mining rewards</span>
      </div>
      <div className="mining-stats">
        <div>
          <div className="k">Blocks mined</div>
          <div className="v num">{summary.blocks.toLocaleString('en-US')}</div>
        </div>
        <div>
          <div className="k">Rewards earned</div>
          <div className="v num" title={`${formatAmountExact(summary.totalWei)} ${NATIVE_SYMBOL}`}>
            {formatAmount(summary.totalWei)} <span className="u">{NATIVE_SYMBOL}</span>
          </div>
        </div>
        <div>
          <div className="k">Most recent</div>
          <div className="v">{summary.latestTimestamp ? timeAgo(summary.latestTimestamp) : '—'}</div>
        </div>
      </div>
      <div className="mining-note">
        {summary.complete
          ? `Covers blocks ${summary.lowestBlock.toLocaleString('en-US')}–${summary.highestBlock.toLocaleString('en-US')} — everything the explorer returned for this address.`
          : `Covers blocks ${summary.lowestBlock.toLocaleString('en-US')}–${summary.highestBlock.toLocaleString('en-US')} only — the explorer holds more history than one page, so this is not an all-time total.`}
        {summary.hasInferred && ' Some rewards are inferred from balance changes rather than read from the block record.'}
        {summary.unknownRewards > 0 &&
          ` ${summary.unknownRewards} recently mined block${summary.unknownRewards === 1 ? ' has' : 's have'} no reward figure from the explorer yet and ${summary.unknownRewards === 1 ? 'is' : 'are'} not included in the total.`}
      </div>
    </div>
  );
}

function MinedRow({ row }: { row: Extract<FeedRow, { kind: 'mined' }> }) {
  return (
    <li className="row-mined">
      <span className="dir-badge dir-mined">MINED</span>
      <div className="row-main">
        <div className="row-title num" style={{ fontSize: 13 }}>
          Block #{row.blockNumber.toLocaleString('en-US')}
          <span className="muted small" style={{ fontWeight: 400 }}>
            · block reward
          </span>
        </div>
        <div className="row-sub">
          {row.timestamp ? timeAgo(row.timestamp) : 'time unknown'}
          {row.source === 'balance' && ' · inferred from balance change'}
          {row.rewardWei === 0n && ' · reward not yet indexed'}
        </div>
      </div>
      <div
        className="row-value num mined-value"
        title={row.rewardWei > 0n ? `${formatAmountExact(row.rewardWei)} ${NATIVE_SYMBOL}` : 'The explorer has not published this block’s reward yet.'}
      >
        {row.rewardWei > 0n ? `+${formatAmount(row.rewardWei)} ${NATIVE_SYMBOL}` : '—'}
      </div>
      <div className="row-actions">
        <a
          className="btn btn-ghost btn-sm"
          href={`${EXPLORER_URL}/block/${row.blockNumber}`}
          target="_blank"
          rel="noreferrer noopener"
          title={`Block ${row.blockNumber} on the explorer`}
        >
          ↗
        </a>
      </div>
    </li>
  );
}

function TxRow({ tx }: { tx: ActivityItem }) {
  const counterparty = tx.direction === 'in' ? tx.from : tx.to;
  return (
    <li>
      <span
        className={
          'dir-badge ' + (tx.success === false ? 'dir-fail' : tx.direction === 'in' ? 'dir-in' : 'dir-out')
        }
      >
        {tx.success === false ? 'FAIL' : tx.direction === 'in' ? 'IN' : tx.direction === 'self' ? 'SELF' : 'OUT'}
      </span>
      <div className="row-main">
        <div className="row-title mono" style={{ fontSize: 13 }}>
          {counterparty ? shortAddress(counterparty) : 'Contract creation'}
          {tx.isContractCall && <span className="muted small"> · contract call</span>}
        </div>
        <div className="row-sub">{tx.timestamp ? timeAgo(tx.timestamp) : 'pending'}</div>
      </div>
      <div className="row-value num">
        {tx.valueWei > 0n ? `${tx.direction === 'in' ? '+' : '−'}${formatAmount(tx.valueWei)} ${NATIVE_SYMBOL}` : '—'}
      </div>
      <div className="row-actions">
        <a
          className="btn btn-ghost btn-sm"
          href={`${EXPLORER_URL}/tx/${tx.hash}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          ↗
        </a>
      </div>
    </li>
  );
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
