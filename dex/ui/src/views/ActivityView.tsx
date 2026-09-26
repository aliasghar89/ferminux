import { useMemo, useState } from 'react';
import { DEX_ADDRESSES } from '../config.ts';
import { EmptyState, Notice, Segmented, Spinner, TxLink } from '../components/ui.tsx';
import { PairLogos, TokenLogo } from '../components/TokenLogo.tsx';
import { IconKey } from '../components/icons.tsx';
import { formatAmount, formatTimestamp, shortAddress } from '../lib/amounts.ts';
import { formatAgo, formatDay, poolName, poolSymbol } from '../lib/format.ts';
import type { ActivityItem } from '../lib/history.ts';
import { isUnlimitedAllowance, nativeToken } from '../lib/tokens.ts';
import type { ActivityState } from '../state/useActivity.ts';
import type { WalletSession } from '../state/useWallet.ts';

type Filter = 'all' | 'swaps' | 'liquidity' | 'other';

const FILTERS: ReadonlyArray<readonly [Filter, string]> = [
  ['all', 'All'],
  ['swaps', 'Swaps'],
  ['liquidity', 'Liquidity'],
  ['other', 'Other'],
];

function matches(item: ActivityItem, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'swaps') return item.kind === 'swap';
  if (f === 'liquidity') return item.kind === 'add' || item.kind === 'remove';
  return item.kind === 'wrap' || item.kind === 'unwrap' || item.kind === 'approve';
}

/** The connected account's transactions on this DEX, read from the chain. */
export function ActivityView({ wallet, activity, now }: { wallet: WalletSession; activity: ActivityState; now: number }) {
  const [filter, setFilter] = useState<Filter>('all');
  const groups = useMemo(() => {
    const list = (activity.items ?? []).filter((i) => matches(i, filter));
    const byDay = new Map<string, ActivityItem[]>();
    for (const it of list) {
      const key = it.time !== null ? formatDay(it.time) : 'Undated';
      const g = byDay.get(key) ?? [];
      g.push(it);
      byDay.set(key, g);
    }
    return [...byDay.entries()];
  }, [activity.items, filter]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="page-sub">
            {wallet.address ? (
              <>
                Swaps, deposits, withdrawals, wraps and approvals signed by <span className="mono">{shortAddress(wallet.address, 6, 4)}</span>, read from the chain.
              </>
            ) : (
              'Your swaps, deposits and approvals on this DEX, read from the chain.'
            )}
          </p>
        </div>
        <span className="spacer" />
        {wallet.address && (
          <button className="btn btn-sm" onClick={activity.reload} disabled={activity.loading}>
            {activity.loading && <Spinner />} Refresh
          </button>
        )}
      </div>

      {!wallet.address ? (
        <section className="card">
          <EmptyState title="No wallet connected" action={<button className="btn btn-primary" onClick={wallet.connect}>Connect wallet</button>}>
            <p className="small">Connect to see the transactions this account has made on the Ferminux DEX.</p>
          </EmptyState>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <Segmented value={filter} options={FILTERS} onChange={setFilter} label="Filter activity" size="sm" />
          </div>
          {activity.error && (
            <Notice kind="danger" role="alert">
              Could not read the history: {activity.error}
            </Notice>
          )}
          <section className="card" data-testid="activity">
            {activity.items === null ? (
              <p className="card-pad muted small">
                <Spinner /> Reading this account&rsquo;s transactions from the chain
              </p>
            ) : groups.length === 0 ? (
              <EmptyState title={filter === 'all' ? 'No DEX activity yet' : 'Nothing of this kind yet'}>
                <p className="small">Transactions this account signs on the Ferminux DEX appear here once they are in a block.</p>
              </EmptyState>
            ) : (
              groups.map(([day, items]) => (
                <div key={day} className="activity-group">
                  <h2 className="activity-day label">{day}</h2>
                  <ul className="rows rows-flush">
                    {items.map((it) => (
                      <li key={it.txHash} className="row activity-row" data-testid={`activity-${it.kind}`}>
                        <ActivityIcon item={it} />
                        <span className="row-main">
                          <span className="row-title">{title(it)}</span>
                          <span className="row-sub mono">{detail(it)}</span>
                        </span>
                        <span className="row-side">
                          <span className="small" title={it.time !== null ? formatTimestamp(it.time) : undefined}>
                            {formatAgo(it.time, now)}
                          </span>
                          <TxLink hash={it.txHash} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ActivityIcon({ item }: { item: ActivityItem }) {
  if (item.kind === 'swap') {
    return <PairLogos a={item.tokenIn} b={item.tokenOut} size={24} />;
  }
  if (item.kind === 'add' || item.kind === 'remove') {
    return <PairLogos a={item.pool.token0} b={item.pool.token1} size={24} />;
  }
  if (item.kind === 'wrap' || item.kind === 'unwrap') {
    return (
      <span className="activity-icon">
        <TokenLogo token={nativeToken(DEX_ADDRESSES.wfmx)} size={24} />
      </span>
    );
  }
  return (
    <span className="activity-icon icon-disc">
      <IconKey />
    </span>
  );
}

function title(it: ActivityItem) {
  const wfmx = DEX_ADDRESSES.wfmx;
  switch (it.kind) {
    case 'swap':
      return (
        <>
          Swapped {it.tokenIn.symbol} for {it.tokenOut.symbol}
        </>
      );
    case 'add':
      return (
        <>
          Added liquidity to {poolName(it.pool, wfmx)}
        </>
      );
    case 'remove':
      return (
        <>
          Removed liquidity from {poolName(it.pool, wfmx)}
        </>
      );
    case 'wrap':
      return (
        <>
          Wrapped FMX
        </>
      );
    case 'unwrap':
      return (
        <>
          Unwrapped WFMX
        </>
      );
    default:
      return (
        <>
          Approved {it.tokenLabel} for the {it.spender}
        </>
      );
  }
}

function detail(it: ActivityItem): string {
  const wfmx = DEX_ADDRESSES.wfmx;
  switch (it.kind) {
    case 'swap':
      return `${formatAmount(it.amountIn, it.tokenIn.decimals, 6)} ${it.tokenIn.symbol} → ${formatAmount(it.amountOut, it.tokenOut.decimals, 6)} ${it.tokenOut.symbol}${
        it.route.length > 2 ? ` · via ${it.route.slice(1, -1).join(', ')}` : ''
      }`;
    case 'add':
    case 'remove': {
      const s0 = it.native ? poolSymbol(it.pool.token0, wfmx) : it.pool.token0.symbol;
      const s1 = it.native ? poolSymbol(it.pool.token1, wfmx) : it.pool.token1.symbol;
      return `${formatAmount(it.amount0, it.pool.token0.decimals, 6)} ${s0} + ${formatAmount(it.amount1, it.pool.token1.decimals, 6)} ${s1}`;
    }
    case 'wrap':
    case 'unwrap':
      return `${formatAmount(it.amount, 18, 6)} ${it.kind === 'wrap' ? 'FMX → WFMX' : 'WFMX → FMX'}`;
    default:
      return isUnlimitedAllowance(it.amount) ? 'unlimited' : it.amount === 0n ? 'revoked (0)' : `${formatAmount(it.amount, it.decimals, 6)} ${it.tokenLabel}`;
  }
}
