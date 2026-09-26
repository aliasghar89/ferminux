import { DEX_ADDRESSES, PRELOADED_TOKENS } from '../config.ts';
import { PairLogos, TokenLogo } from '../components/TokenLogo.tsx';
import { IconChevronRight } from '../components/icons.tsx';
import { formatAmount, priceFromReserves } from '../lib/amounts.ts';
import { formatUsd, formatUsdPrice, poolFmxUsdE18 } from '../lib/prices.ts';
import { orientedReserves, pairKey } from '../lib/pairs.ts';
import { nativeToken, wfmxToken } from '../lib/tokens.ts';
import type { MarketData } from '../state/useMarket.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { Page } from '../state/useRoute.ts';

/**
 * FMX against each first-party token: the pool's price (and what it makes FMX
 * in USD, through the token's peg) where a pool exists, and "no pool yet"
 * where it does not, so a missing market is visible rather than absent.
 */
export function MarketsList({
  pools,
  market,
  navigate,
}: {
  pools: PoolsState;
  market: MarketData;
  navigate: (to: { page: Page; pool?: string | null }) => void;
}) {
  const wfmx = DEX_ADDRESSES.wfmx;
  const fmx = nativeToken(wfmx);
  const rows = PRELOADED_TOKENS.map((token) => {
    const snapshot = pools.index.get(pairKey(wfmx, token.address)) ?? null;
    const seeded = snapshot !== null && snapshot.reserve0 > 0n && snapshot.reserve1 > 0n;
    return { token, snapshot: seeded ? snapshot : null };
  }).sort((a, b) => Number(b.snapshot !== null) - Number(a.snapshot !== null));

  return (
    <section className="card" aria-labelledby="markets-h" data-testid="fmx-markets">
      <div className="card-head">
        <h2 id="markets-h" className="card-title-sm">
          FMX markets
        </h2>
      </div>
      <ul className="rows">
        {rows.map(({ token, snapshot }) => {
          const tokenInfo = { kind: 'erc20' as const, address: token.address, symbol: token.symbol };
          if (!snapshot) {
            return (
              <li key={token.address} className="row" data-testid={`market-${token.symbol}`}>
                <PairLogos a={fmx} b={tokenInfo} size={22} />
                <span className="row-main">
                  <span className="row-title">FMX / {token.symbol}</span>
                  <span className="row-sub">No pool yet. The first deposit sets its price.</span>
                </span>
                <a className="btn btn-sm" href={`?tab=liquidity&a=FMX&b=${token.address}`}>
                  Add liquidity
                </a>
              </li>
            );
          }
          const { own: fmxReserve, other: tokenReserve } = orientedReserves(snapshot, wfmx);
          const price = priceFromReserves(fmxReserve, 18, tokenReserve, token.decimals, 6);
          const usd = poolFmxUsdE18(snapshot, wfmx, market.pegs);
          const stats = market.stats.get(snapshot.pair.toLowerCase());
          return (
            <li key={token.address} className="row row-link" data-testid={`market-${token.symbol}`}>
              <button className="row-btn" onClick={() => navigate({ page: 'pools', pool: snapshot.pair })}>
                <PairLogos a={fmx} b={tokenInfo} size={22} />
                <span className="row-main">
                  <span className="row-title">FMX / {token.symbol}</span>
                  <span className="row-sub mono">
                    {formatAmount(fmxReserve, 18, 0)} FMX · {formatAmount(tokenReserve, token.decimals, 0)} {token.symbol}
                  </span>
                </span>
                <span className="row-side">
                  <span className="mono">
                    {price} {token.symbol}
                  </span>
                  <span className="mono faint small">
                    {usd !== null ? formatUsdPrice(usd) : ''}
                    {stats ? ` · TVL ${formatUsd(stats.tvlUsdE18, { compact: true })}` : ''}
                  </span>
                </span>
                <IconChevronRight />
              </button>
            </li>
          );
        })}
        <li className="row" data-testid="market-WFMX">
          <TokenLogo token={wfmxToken(wfmx)} size={22} />
          <span className="row-main">
            <span className="row-title">WFMX</span>
            <span className="row-sub">The FRC-20 wrapper the pools hold. 1 WFMX = 1 FMX, wrap and unwrap in Swap.</span>
          </span>
          <a className="btn btn-sm" href="?inputCurrency=FMX&outputCurrency=WFMX">
            Wrap
          </a>
        </li>
      </ul>
    </section>
  );
}
