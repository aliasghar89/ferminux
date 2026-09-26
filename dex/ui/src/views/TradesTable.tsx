import { DEX_ADDRESSES } from '../config.ts';
import { TxLink } from '../components/ui.tsx';
import { formatAmount, formatTimestamp } from '../lib/amounts.ts';
import { formatAgo, poolSymbol } from '../lib/format.ts';
import type { Trade } from '../lib/market.ts';
import { formatUsd } from '../lib/prices.ts';

/** Newest-first list of pool swaps, straight from the pools' Swap events. */
export function TradesTable({
  trades,
  now,
  showPool,
  limit = 20,
  emptyText = 'No trades yet.',
}: {
  trades: Trade[];
  now: number;
  showPool?: boolean;
  limit?: number;
  emptyText?: string;
}) {
  const wfmx = DEX_ADDRESSES.wfmx;
  const rows = [...trades].reverse().slice(0, limit);
  if (rows.length === 0) return <p className="card-pad muted small">{emptyText}</p>;
  return (
    <div className="table-wrap">
      <table className="table" data-testid="trades-table">
        <thead>
          <tr>
            <th scope="col" className="hide-xs">
              Time
            </th>
            <th scope="col">Trade</th>
            <th scope="col" className="r">
              Value
            </th>
            <th scope="col" className="r hide-sm">
              Transaction
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const sIn = poolSymbol(t.tokenIn, wfmx);
            const sOut = poolSymbol(t.tokenOut, wfmx);
            return (
              <tr key={`${t.txHash}-${t.logIndex}`}>
                <td className="nowrap hide-xs" title={t.time !== null ? formatTimestamp(t.time) : undefined}>
                  <span className="mono small">{formatAgo(t.time, now)}</span>
                </td>
                <td>
                  <span className="trade-cell">
                    <span className={'side-tag ' + (sOut === 'FMX' ? 'side-buy' : sIn === 'FMX' ? 'side-sell' : '')}>
                      {sOut === 'FMX' ? 'Buy FMX' : sIn === 'FMX' ? 'Sell FMX' : `${sIn} → ${sOut}`}
                    </span>
                    <span className="mono small">
                      {formatAmount(t.amountIn, t.tokenIn.decimals, 4)} {sIn} → {formatAmount(t.amountOut, t.tokenOut.decimals, 4)} {sOut}
                    </span>
                    <span className="faint small">
                      <span className="show-xs mono">{formatAgo(t.time, now)}</span>
                      {showPool && <span className="hide-xs">{`${sIn}/${sOut} pool`}</span>}
                    </span>
                  </span>
                </td>
                <td className="r mono">{formatUsd(t.usdE18)}</td>
                <td className="r hide-sm">
                  <TxLink hash={t.txHash} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
