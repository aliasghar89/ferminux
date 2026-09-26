import { useMemo, useState } from 'react';
import { DEX_ADDRESSES } from '../config.ts';
import { BarChart, Legend, LineChart, type Series } from '../components/Chart.tsx';
import { Figure, Segmented, Skeleton } from '../components/ui.tsx';
import { PairLogos } from '../components/TokenLogo.tsx';
import { formatAmount } from '../lib/amounts.ts';
import { formatAgo, formatUsdNumber, orderedTokens, poolName, poolSymbol } from '../lib/format.ts';
import { DAY, bucketSums, poolPriceSeries, tvlSeries, type Trade } from '../lib/market.ts';
import { e18ToNumber, formatUsd, formatUsdPrice, poolFmxUsdE18 } from '../lib/prices.ts';
import type { PairSnapshot } from '../lib/pairs.ts';
import type { MarketData } from '../state/useMarket.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { Page } from '../state/useRoute.ts';
import { TradesTable } from './TradesTable.tsx';

export type Range = '1D' | '7D' | '30D' | 'ALL';
export const RANGES: ReadonlyArray<readonly [Range, string]> = [
  ['1D', '24H'],
  ['7D', '7D'],
  ['30D', '30D'],
  ['ALL', 'All'],
];

export function rangeStart(range: Range, now: number, first: number | null): number {
  if (range === '1D') return now - DAY;
  if (range === '7D') return now - 7 * DAY;
  if (range === '30D') return now - 30 * DAY;
  // Everything there is, from the first recorded point, never less than an hour.
  if (first === null) return now - 30 * DAY;
  const span = Math.max(3600, now - first);
  return now - Math.ceil(span * 1.04);
}

/** Every seeded WFMX pool against a pegged token, deepest first, with its FMX-in-USD history. */
function fmxPoolSeries(market: MarketData, pools: PoolsState) {
  const wfmx = DEX_ADDRESSES.wfmx.toLowerCase();
  const list: Array<{ pool: PairSnapshot; usd: bigint; points: ReturnType<typeof poolPriceSeries>; tvl: bigint }> = [];
  for (const p of pools.pairs) {
    const usd = poolFmxUsdE18(p, wfmx, market.pegs);
    if (usd === null) continue;
    const other = p.token0.address.toLowerCase() === wfmx ? p.token1 : p.token0;
    const peg = market.pegs.get(other.address.toLowerCase())!;
    list.push({
      pool: p,
      usd,
      points: poolPriceSeries(market.syncs, p, wfmx, market.clock, peg.usdE18),
      tvl: market.stats.get(p.pair.toLowerCase())?.tvlUsdE18 ?? 0n,
    });
  }
  return list.sort((a, b) => (b.tvl > a.tvl ? 1 : b.tvl < a.tvl ? -1 : 0));
}

/**
 * FMX in USD over time, as each pool against a pegged token has priced it
 * (from every reserve change on chain), against the official price.
 */
export function FmxPriceCard({ market, pools, compact }: { market: MarketData; pools: PoolsState; compact?: boolean }) {
  const [range, setRange] = useState<Range>(compact ? '30D' : 'ALL');
  const official = market.pegs.get(DEX_ADDRESSES.wfmx.toLowerCase())?.usdE18 ?? null;
  const pools_ = useMemo(() => fmxPoolSeries(market, pools), [market, pools]);
  const first = pools_.flatMap((p) => p.points.map((pt) => pt.t)).reduce<number | null>((a, t) => (a === null || t < a ? t : a), null);
  const from = rangeStart(range, market.now, first);
  const to = market.now;
  const wfmx = DEX_ADDRESSES.wfmx;

  const series: Series[] = pools_.map((p, i) => ({
    id: p.pool.pair,
    label: `${poolName(p.pool, wfmx)} pool`,
    points: p.points,
    tone: i === 0 ? 'accent' : 'muted',
    step: true,
    area: i === 0,
  }));
  const reference = official !== null ? { value: e18ToNumber(official), label: `Official ${formatUsdPrice(official)}` } : undefined;
  const main = pools_[0] ?? null;
  const change = (() => {
    if (!main) return null;
    const pts = main.points;
    const before = [...pts].reverse().find((p) => p.t <= from) ?? pts.find((p) => p.t >= from);
    const last = pts[pts.length - 1];
    if (!before || !last || before.v === 0) return null;
    return ((last.v - before.v) / before.v) * 100;
  })();
  const deviation = main && official ? Number(((main.usd - official) * 10_000n) / official) / 100 : null;
  const loading = market.status !== 'ready' && market.syncs.length === 0;

  return (
    <section className={'card chart-card' + (compact ? ' is-compact' : '')} aria-labelledby="fmx-price-h" data-testid="fmx-price-card">
      <div className="chart-card-head">
        <div className="chart-title-block">
          <h2 id="fmx-price-h" className="card-title-sm">
            FMX price
          </h2>
          <div className="price-line">
            <span className="price-big mono" data-testid="official-price">
              {official !== null ? formatUsdPrice(official) : '—'}
            </span>
            <span className="price-tag">official</span>
          </div>
          {main && (
            <div className="price-sub">
              <span className="mono">{formatUsdPrice(main.usd)}</span> on the {poolName(main.pool, wfmx)} pool
              {deviation !== null && Math.abs(deviation) >= 0.5 && (
                <span className="faint mono"> ({deviation > 0 ? '+' : ''}{deviation.toFixed(1)}% vs official)</span>
              )}
              {change !== null && (
                <span className="faint mono">
                  {' '}
                  · {change >= 0 ? '+' : ''}
                  {change.toFixed(2)}% in {range === 'ALL' ? 'all time' : RANGES.find((r) => r[0] === range)?.[1]}
                </span>
              )}
            </div>
          )}
        </div>
        <Segmented value={range} options={RANGES} onChange={setRange} label="Chart range" size="sm" />
      </div>
      {loading ? (
        <div className="chart-empty" style={{ height: compact ? 180 : 300 }}>
          <Skeleton width="60%" /> Reading pool history from the chain
        </div>
      ) : (
        <LineChart
          series={series}
          from={from}
          to={to}
          height={compact ? 180 : 320}
          formatY={(v) => formatUsdNumber(v)}
          reference={reference}
          summary={
            main
              ? `FMX in USD on the ${poolName(main.pool, wfmx)} pool, now ${formatUsdPrice(main.usd)}; the official price is ${official !== null ? formatUsdPrice(official) : 'unknown'}.`
              : 'No FMX pool against a pegged token yet.'
          }
          emptyText={pools_.length === 0 ? 'No FMX pool against USDF or AZNT yet.' : 'No price change in this range.'}
          testId="fmx-chart"
        />
      )}
      <Legend
        items={[
          ...series.map((s, i) => ({ id: s.id, label: s.label, tone: s.tone, value: formatUsdPrice(pools_[i].usd) })),
          ...(reference ? [{ id: 'official', label: 'Official price (pay-in)', tone: 'faint' as const, dashed: true, value: reference.label.replace('Official ', '') }] : []),
        ]}
      />
    </section>
  );
}

/** The Charts section: FMX price, and the market overview. */
export function ChartsView({
  page,
  market,
  pools,
  navigate,
}: {
  page: 'charts' | 'analytics';
  market: MarketData;
  pools: PoolsState;
  navigate: (to: { page: Page; pool?: string | null }) => void;
}) {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Charts</h1>
        <Segmented
          value={page}
          options={[
            ['charts', 'FMX price'],
            ['analytics', 'Analytics'],
          ]}
          onChange={(p) => navigate({ page: p })}
          label="Charts view"
        />
      </div>
      {page === 'charts' ? <FmxPricePage market={market} pools={pools} navigate={navigate} /> : <AnalyticsPage market={market} pools={pools} navigate={navigate} />}
    </div>
  );
}

function FmxPricePage({ market, pools, navigate }: { market: MarketData; pools: PoolsState; navigate: (to: { page: Page; pool?: string | null }) => void }) {
  const list = useMemo(() => fmxPoolSeries(market, pools), [market, pools]);
  const wfmx = DEX_ADDRESSES.wfmx;
  const fmxTrades = market.trades.filter((t) => list.some((l) => l.pool.pair.toLowerCase() === t.pair));
  const since = (sec: number) => fmxTrades.filter((t) => t.time !== null && t.time > market.now - sec);
  const vol = (ts: Trade[]) => ts.reduce((a, t) => a + (t.usdE18 ?? 0n), 0n);
  return (
    <>
      <FmxPriceCard market={market} pools={pools} />
      <div className="figures" data-testid="fmx-figures">
        <Figure label="FMX volume 24h" value={formatUsd(vol(since(DAY)))} sub={`${since(DAY).length} trades`} />
        <Figure label="FMX volume 7d" value={formatUsd(vol(since(7 * DAY)))} sub={`${since(7 * DAY).length} trades`} />
        <Figure label="FMX pools" value={String(list.length)} sub="against USDF or AZNT" />
        <Figure
          label="Last trade"
          value={fmxTrades.length ? formatAgo(fmxTrades[fmxTrades.length - 1].time, market.now) : '—'}
          sub={fmxTrades.length ? `${fmxTrades.length} trades all time` : 'no trades yet'}
        />
      </div>
      <section className="card" aria-labelledby="by-pool-h">
        <div className="card-head">
          <h2 id="by-pool-h" className="card-title-sm">
            FMX price by pool
          </h2>
        </div>
        {list.length === 0 ? (
          <p className="card-pad muted small">No pool pairs FMX with USDF or AZNT yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  <th scope="col" className="r">
                    Pool price
                  </th>
                  <th scope="col" className="r">
                    In USD
                  </th>
                  <th scope="col" className="r hide-sm">
                    TVL
                  </th>
                  <th scope="col" className="r hide-sm">
                    Basis
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((l) => {
                  const [a, b] = orderedTokens(l.pool, wfmx);
                  const isA0 = l.pool.token0.address.toLowerCase() === a.address.toLowerCase();
                  const [ra, rb] = isA0 ? [l.pool.reserve0, l.pool.reserve1] : [l.pool.reserve1, l.pool.reserve0];
                  const inQuote = (rb * 10n ** 18n * 10n ** BigInt(a.decimals)) / (ra * 10n ** BigInt(b.decimals));
                  return (
                    <tr key={l.pool.pair} className="tr-link" onClick={() => navigate({ page: 'pools', pool: l.pool.pair })}>
                      <td>
                        <span className="cell-pair">
                          <PairLogos a={{ ...a, symbol: poolSymbol(a, wfmx) }} b={b} size={20} />
                          <a
                            href={`?tab=pools&pool=${l.pool.pair}`}
                            onClick={(e) => {
                              e.preventDefault();
                              navigate({ page: 'pools', pool: l.pool.pair });
                            }}
                          >
                            {poolName(l.pool, wfmx)}
                          </a>
                        </span>
                      </td>
                      <td className="r mono">
                        {formatAmount(inQuote, 18, 6)} {b.symbol}
                      </td>
                      <td className="r mono">{formatUsdPrice(l.usd)}</td>
                      <td className="r mono hide-sm">{formatUsd(l.tvl, { compact: true })}</td>
                      <td className="r hide-sm faint small">{market.pegs.get(b.address.toLowerCase())?.basis}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="footnote">
        The pool lines are FMX&rsquo;s price in each pool, from every reserve change the pool has recorded on chain,
        converted to USD through the paired token&rsquo;s peg. The dashed line is the official FMX price, the price the
        pay-in at ferminux.net/buy-fmx sells at; it is set by the operator, not read from a pool.
      </p>
    </>
  );
}

function AnalyticsPage({ market, pools, navigate }: { market: MarketData; pools: PoolsState; navigate: (to: { page: Page; pool?: string | null }) => void }) {
  const [range, setRange] = useState<Range>('ALL');
  const o = market.overview;
  const first = market.syncs.length ? market.clock.at(market.syncs[0].block) : null;
  const from = rangeStart(range, market.now, first);
  const tvl = useMemo(
    () => tvlSeries(market.syncs, market.pools, market.prices, market.clock, range === '1D' ? 3600 : DAY, from, market.now),
    [market, range, from],
  );
  const volDays = Math.min(30, Math.max(7, Math.ceil((market.now - (first ?? market.now)) / DAY) + 1));
  const bars = useMemo(
    () => bucketSums(market.trades, DAY, market.now - volDays * DAY + 1, market.now + 1).map((b) => ({ t: b.t, v: e18ToNumber(b.usdE18) })),
    [market, volDays],
  );
  const loading = market.status !== 'ready' && market.syncs.length === 0;
  const wfmx = DEX_ADDRESSES.wfmx;
  const top = [...pools.pairs]
    .map((p) => ({ p, s: market.stats.get(p.pair.toLowerCase()) }))
    .sort((a, b) => ((b.s?.tvlUsdE18 ?? 0n) > (a.s?.tvlUsdE18 ?? 0n) ? 1 : -1));

  return (
    <>
      <div className="figures figures-6" data-testid="overview">
        <Figure label="Total value locked" value={loading ? <Skeleton width={90} /> : formatUsd(o.tvlUsdE18)} sub={`${o.pricedPools} of ${o.pools} pools valued`} testId="kpi-tvl" />
        <Figure label="Volume 24h" value={formatUsd(o.volume24hUsdE18)} sub={`${o.trades24h} trades`} testId="kpi-vol24" />
        <Figure label="Fees 24h" value={formatUsd(o.fees24hUsdE18)} sub="0.30% to LPs" />
        <Figure label="Volume 7d" value={formatUsd(o.volume7dUsdE18)} />
        <Figure label="Volume all time" value={formatUsd(o.volumeAllUsdE18)} sub={`${o.tradesAll} trades`} />
        <Figure label="Pools" value={String(o.pools)} sub={`${pools.pairs.filter((p) => p.reserve0 > 0n).length} seeded`} />
      </div>

      <div className="grid-2">
        <section className="card chart-card" aria-labelledby="tvl-h">
          <div className="chart-card-head">
            <div className="chart-title-block">
              <h2 id="tvl-h" className="card-title-sm">
                Total value locked
              </h2>
              <div className="price-line">
                <span className="price-big mono">{formatUsd(o.tvlUsdE18)}</span>
              </div>
            </div>
            <Segmented value={range} options={RANGES} onChange={setRange} label="TVL range" size="sm" />
          </div>
          <LineChart
            series={[{ id: 'tvl', label: 'TVL', points: tvl, tone: 'accent', area: true }]}
            from={from}
            to={market.now}
            height={220}
            formatY={(v) => formatUsdNumber(v, true)}
            summary={`Total value locked across all pools, now ${formatUsd(o.tvlUsdE18)}.`}
            testId="tvl-chart"
          />
        </section>
        <section className="card chart-card" aria-labelledby="vol-h">
          <div className="chart-card-head">
            <div className="chart-title-block">
              <h2 id="vol-h" className="card-title-sm">
                Volume by day
              </h2>
              <div className="price-line">
                <span className="price-big mono">{formatUsd(o.volume7dUsdE18)}</span>
                <span className="price-tag">7 days</span>
              </div>
            </div>
          </div>
          <BarChart
            bars={bars}
            bucketSec={DAY}
            height={220}
            formatY={(v) => formatUsdNumber(v, true)}
            label="day's volume"
            summary={`Daily trading volume over the last ${volDays} days, summed over every pool.`}
            testId="volume-chart"
          />
        </section>
      </div>

      <section className="card" aria-labelledby="top-h">
        <div className="card-head">
          <h2 id="top-h" className="card-title-sm">
            Pools
          </h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pool</th>
                <th scope="col" className="r">
                  TVL
                </th>
                <th scope="col" className="r hide-xs">
                  Volume 24h
                </th>
                <th scope="col" className="r hide-sm">
                  Volume 7d
                </th>
                <th scope="col" className="r hide-sm">
                  Fee APR 7d
                </th>
              </tr>
            </thead>
            <tbody>
              {top.map(({ p, s }) => {
                const [a, b] = orderedTokens(p, wfmx);
                return (
                  <tr key={p.pair} className="tr-link" onClick={() => navigate({ page: 'pools', pool: p.pair })}>
                    <td>
                      <span className="cell-pair">
                        <PairLogos a={a} b={b} size={20} />
                        <a
                          href={`?tab=pools&pool=${p.pair}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate({ page: 'pools', pool: p.pair });
                          }}
                        >
                          {poolName(p, wfmx)}
                        </a>
                      </span>
                    </td>
                    <td className="r mono">{formatUsd(s?.tvlUsdE18 ?? null, { compact: true })}</td>
                    <td className="r mono hide-xs">{formatUsd(s?.volume24hUsdE18 ?? 0n, { compact: true })}</td>
                    <td className="r mono hide-sm">{formatUsd(s?.volume7dUsdE18 ?? 0n, { compact: true })}</td>
                    <td className="r mono hide-sm">{s?.apr7dPpm != null ? `${(Number(s.apr7dPpm) / 10_000).toFixed(2)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="recent-h">
        <div className="card-head">
          <h2 id="recent-h" className="card-title-sm">
            Recent trades
          </h2>
          <span className="spacer" />
          <span className="faint small">all pools</span>
        </div>
        <TradesTable trades={market.trades} now={market.now} showPool limit={25} />
      </section>
      <p className="footnote">
        Every figure is read from the chain: reserves from the pools, volume from their Swap events. USD values use the
        official FMX price for FMX, 1 USDF = $1, and 1 AZNT = 1 AZN at 1.70 AZN per USD. A multi-pool trade counts in
        each pool it passes through.
      </p>
    </>
  );
}
