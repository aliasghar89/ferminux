import { DEX_ADDRESSES, PRELOADED_TOKENS } from '../config.ts';
import { AddressLink } from '../components/ui.tsx';
import { formatAmount, formatTimestamp, priceFromReserves } from '../lib/amounts.ts';
import { orientedReserves, pairKey } from '../lib/pairs.ts';
import type { PoolsState } from '../state/usePools.ts';

/**
 * FMX against each first-party token, in one place: the pool's price and depth
 * where a pool exists, and a plain "no pool yet" where it does not — so a
 * missing market is visible instead of simply absent from the list. WFMX gets
 * its own line because it is not a market at all: it is FMX, 1:1.
 *
 * "Swap" is a deep link (?inputCurrency=…&outputCurrency=FMX) so the same URL
 * works from ferminux.net, ferminux.com and a bookmark.
 */
export function FmxMarkets({ pools }: { pools: PoolsState }) {
  const wfmx = DEX_ADDRESSES.wfmx;
  const rows = PRELOADED_TOKENS.map((token) => {
    const snapshot = pools.index.get(pairKey(wfmx, token.address)) ?? null;
    const seeded = snapshot !== null && snapshot.reserve0 > 0n && snapshot.reserve1 > 0n;
    return { token, snapshot: seeded ? snapshot : null };
  }).sort((a, b) => Number(b.snapshot !== null) - Number(a.snapshot !== null));

  return (
    <section className="panel" aria-labelledby="fmx-markets-h" data-testid="fmx-markets">
      <div className="panel-head">
        <h2 id="fmx-markets-h">FMX markets</h2>
        <span className="spacer" />
        <span className="muted small">{pools.status === 'ready' ? 'read from the pools' : 'reading…'}</span>
      </div>
      <ul className="row-list">
        {rows.map(({ token, snapshot }) => {
          if (!snapshot) {
            return (
              <li key={token.address} data-testid={`market-${token.symbol}`}>
                <span className="row-main">
                  <span className="row-title">
                    FMX / {token.symbol} <span className="tag">no pool yet</span>
                  </span>
                  <span className="row-sub">
                    Nobody has seeded this pool. The first liquidity provider sets its opening price.
                  </span>
                </span>
                <a className="btn btn-sm" href="?tab=liquidity">
                  Add liquidity
                </a>
              </li>
            );
          }
          const { own: fmxReserve, other: tokenReserve } = orientedReserves(snapshot, wfmx);
          const price = priceFromReserves(fmxReserve, 18, tokenReserve, token.decimals, 6);
          return (
            <li key={token.address} data-testid={`market-${token.symbol}`}>
              <span className="row-main">
                <span className="row-title num">
                  FMX / {token.symbol}
                  <span>
                    1 FMX = {price} {token.symbol}
                  </span>
                </span>
                <span className="row-sub num">
                  {formatAmount(fmxReserve, 18, 2)} FMX + {formatAmount(tokenReserve, token.decimals, 2)} {token.symbol} in
                  the pool · last trade {formatTimestamp(snapshot.blockTimestampLast)} ·{' '}
                  <AddressLink address={snapshot.pair} />
                </span>
              </span>
              <a className="btn btn-sm" href={`?inputCurrency=${token.address}&outputCurrency=FMX`}>
                Swap
              </a>
            </li>
          );
        })}
        <li data-testid="market-WFMX">
          <span className="row-main">
            <span className="row-title num">
              WFMX <span>1 WFMX = 1 FMX</span>
            </span>
            <span className="row-sub">
              The FRC-20 wrapper the pools hold. Wrap and unwrap in Swap at exactly 1:1: no pool, no fee.
            </span>
          </span>
          <a className="btn btn-sm" href="?inputCurrency=FMX&outputCurrency=WFMX">
            Wrap
          </a>
        </li>
      </ul>
    </section>
  );
}
