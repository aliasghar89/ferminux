import { useCallback, useEffect, useState } from 'react';
import { fetchActivity, type ActivityItem } from '../lib/activity.ts';
import {
  buildFeed,
  fetchBlockRewardData,
  summariseSigning,
  type FeedRow,
  type SigningSummary,
} from '../lib/rewards.ts';
import { EXPLORER_URL, NATIVE_SYMBOL } from '../config.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { Identicon } from '../components/Identicon.tsx';
import { IconAlert, IconExternal, IconReceive, IconSend, IconCheck, IconRefresh } from '../components/icons.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      rows: FeedRow[];
      signing: SigningSummary | null;
      /** true when the transactions endpoint failed but block-reward data came through. */
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
    // Transactions and block rewards are independent sources. Either alone is
    // enough to render a feed; only losing both is "history unavailable".
    const [txsResult, rewardResult] = await Promise.allSettled([
      fetchActivity(EXPLORER_URL, address),
      fetchBlockRewardData(EXPLORER_URL, address),
    ]);

    const txs: ActivityItem[] = txsResult.status === 'fulfilled' ? txsResult.value : [];
    const rewards =
      rewardResult.status === 'fulfilled'
        ? rewardResult.value
        : { history: [], validated: [], available: false, complete: true };

    if (txsResult.status === 'rejected' && !rewards.available) {
      setState({ kind: 'unavailable' });
      return;
    }

    const rows = buildFeed(txs, rewards.history, rewards.validated);
    setState({
      kind: 'ready',
      rows,
      signing: summariseSigning(rows, { complete: rewards.complete }),
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
      <div className="list">
        <ul className="row-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <span className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%' }} />
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
      </div>
      </>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <>
      {context}
      <div className="list empty-state">
        <div className="ic-wrap">
          <IconAlert />
        </div>
        <div className="title">History unavailable</div>
        The explorer API could not be reached. Balances and sending keep working over RPC.
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>
            <IconRefresh /> Retry
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
        <div className="list empty-state">
          <div className="title">No activity yet</div>
          Transfers and block rewards for {label} will appear here once the explorer has indexed them.
        </div>
      </>
    );
  }

  return (
    <>
      {context}
      {state.signing && <SigningCard summary={state.signing} />}
      {state.txsMissing && (
        <div className="notice">
          Showing block rewards only — the transactions endpoint did not respond.{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
        </div>
      )}
      <div className="list">
        <ul className="row-list">
          {state.rows.map((row) => (row.kind === 'signed' ? <SignedRow key={row.id} row={row} /> : <TxRow key={row.id} tx={row.tx} />))}
        </ul>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

function SigningCard({ summary }: { summary: SigningSummary }) {
  return (
    <div className="signing-card" data-testid="signing-card">
      <div className="signing-head">
        <span className="tx-ic signed" aria-hidden="true" style={{ width: 32, height: 32 }}>
          <IconCheck />
        </span>
        <span className="signing-title">Blocks this address signed</span>
      </div>
      <div className="signing-stats">
        <div>
          <div className="k">Blocks signed</div>
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
      <div className="signing-note">
        {summary.complete
          ? `Covers blocks ${summary.lowestBlock.toLocaleString('en-US')}–${summary.highestBlock.toLocaleString('en-US')} — everything the explorer returned for this address.`
          : `Covers blocks ${summary.lowestBlock.toLocaleString('en-US')}–${summary.highestBlock.toLocaleString('en-US')} only — the explorer holds more history than one page, so this is not an all-time total.`}
        {summary.hasInferred && ' Some rewards are inferred from balance changes rather than read from the block record.'}
        {summary.unknownRewards > 0 &&
          ` ${summary.unknownRewards} recently confirmed block${summary.unknownRewards === 1 ? ' has' : 's have'} no reward figure from the explorer yet and ${summary.unknownRewards === 1 ? 'is' : 'are'} not included in the total.`}
      </div>
    </div>
  );
}

function SignedRow({ row }: { row: Extract<FeedRow, { kind: 'signed' }> }) {
  return (
    <li className="row-signed">
      <span className="tx-ic signed" aria-hidden="true">
        <IconCheck />
      </span>
      <div className="row-main">
        <div className="row-title">
          Block reward
          <span className="mono faint" style={{ fontWeight: 400, fontSize: 12.5 }}>
            #{row.blockNumber.toLocaleString('en-US')}
          </span>
        </div>
        <div className="row-sub">
          {row.timestamp ? timeAgo(row.timestamp) : 'time unknown'}
          {row.source === 'balance' && ' · inferred from balance change'}
          {row.rewardWei === 0n && ' · reward not yet indexed'}
        </div>
      </div>
      <div
        className="row-value num signed-value"
        title={row.rewardWei > 0n ? `${formatAmountExact(row.rewardWei)} ${NATIVE_SYMBOL}` : 'The explorer has not published this block’s reward yet.'}
      >
        {row.rewardWei > 0n ? `+${formatAmount(row.rewardWei)} ${NATIVE_SYMBOL}` : '—'}
      </div>
      <div className="row-actions">
        <a
          className="row-link"
          href={`${EXPLORER_URL}/block/${row.blockNumber}`}
          target="_blank"
          rel="noreferrer noopener"
          title={`Block ${row.blockNumber} on the explorer`}
          aria-label={`Block ${row.blockNumber} on the explorer`}
        >
          <IconExternal />
        </a>
      </div>
    </li>
  );
}

function TxRow({ tx }: { tx: ActivityItem }) {
  const counterparty = tx.direction === 'in' ? tx.from : tx.to;
  const failed = tx.success === false;
  const kind = failed ? 'Failed' : tx.direction === 'in' ? 'Received' : tx.direction === 'self' ? 'To yourself' : tx.isContractCall ? 'Contract call' : 'Sent';
  return (
    <li>
      <span className={'tx-ic' + (failed ? ' fail' : tx.direction === 'in' ? ' in' : '')} aria-hidden="true">
        {failed ? <IconAlert /> : tx.direction === 'in' ? <IconReceive /> : <IconSend />}
      </span>
      <div className="row-main">
        <div className="row-title">
          {kind}
        </div>
        <div className="row-sub">
          {tx.direction === 'in' ? 'from ' : 'to '}
          <span className="mono">{counterparty ? shortAddress(counterparty) : 'contract creation'}</span>
          {' · '}
          {tx.timestamp ? timeAgo(tx.timestamp) : 'pending'}
        </div>
      </div>
      <div className={'row-value' + (tx.direction === 'in' && !failed ? ' in' : '')}>
        {tx.valueWei > 0n ? `${tx.direction === 'in' ? '+' : '−'}${formatAmount(tx.valueWei)} ${NATIVE_SYMBOL}` : '—'}
      </div>
      <div className="row-actions">
        <a className="row-link" href={`${EXPLORER_URL}/tx/${tx.hash}`} target="_blank" rel="noreferrer noopener" aria-label="View on the explorer" title="View on the explorer">
          <IconExternal />
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
