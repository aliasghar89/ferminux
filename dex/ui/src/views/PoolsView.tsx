import { useMemo, useState } from 'react';
import { DEX_ADDRESSES } from '../config.ts';
import { LineChart, Legend } from '../components/Chart.tsx';
import { AddressLink, EmptyState, Figure, Notice, Segmented, Skeleton } from '../components/ui.tsx';
import { PairLogos, TokenLogo } from '../components/TokenLogo.tsx';
import { IconBack, IconLock, IconSearch, IconUnlock } from '../components/icons.tsx';
import {
  formatAmount,
  formatPpmPercent,
  formatRelativeFuture,
  formatTimestamp,
  shortAddress,
} from '../lib/amounts.ts';
import { formatNumber, formatUsdNumber, orderedTokens, poolName, poolSymbol } from '../lib/format.ts';
import type { Position } from '../lib/liquidity.ts';
import { lockState, type LockSummary } from '../lib/locker.ts';
import { poolPriceSeries } from '../lib/market.ts';
import { PPM } from '../lib/math.ts';
import type { PairSnapshot } from '../lib/pairs.ts';
import { E18, formatUsd, formatUsdPrice, poolFmxUsdE18, poolPriceE18, poolValue } from '../lib/prices.ts';
import type { MarketData } from '../state/useMarket.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { PositionsState } from '../state/usePositions.ts';
import type { Page } from '../state/useRoute.ts';
import { RANGES, rangeStart, type Range } from './ChartsView.tsx';
import { TradesTable } from './TradesTable.tsx';

type Nav = (to: { page: Page; pool?: string | null; pairA?: string | null; pairB?: string | null }) => void;

function aprText(ppm: bigint | null | undefined): string {
  return ppm === null || ppm === undefined ? '—' : `${(Number(ppm) / 10_000).toFixed(2)}%`;
}

/** LOCKED (share of LP, unlock date) or NOT LOCKED: the number a buyer checks first. */
export function LockBadge({ lock, chainTime, full }: { lock: LockSummary | null; chainTime: number | null; full?: boolean }) {
  if (!lock) return <span className="badge">lock unknown</span>;
  if (lock.lockedNow > 0n) {
    return (
      <span className="badge badge-lock" title={lock.earliestUnlock ? `Earliest unlock ${formatTimestamp(lock.earliestUnlock)}` : undefined} data-testid="lock-badge">
        <IconLock />
        Locked {formatPpmPercent(lock.lockedPpm, 1)}
        {full && lock.earliestUnlock !== null && <span className="badge-sub">until {formatTimestamp(lock.earliestUnlock).replace(/, \d\d:\d\d UTC$/, '').replace(/ \d\d:\d\d UTC$/, '')}</span>}
        {!full && lock.earliestUnlock !== null && <span className="badge-sub">{formatRelativeFuture(lock.earliestUnlock, chainTime ?? undefined)}</span>}
      </span>
    );
  }
  return (
    <span className="badge badge-open" data-testid="unlock-badge">
      <IconUnlock />
      Not locked
    </span>
  );
}

type SortKey = 'tvl' | 'vol' | 'apr';

export function PoolsView({
  route,
  pools,
  market,
  positions,
  chainTime,
  account,
  navigate,
}: {
  route: { pool: string | null };
  pools: PoolsState;
  market: MarketData;
  positions: PositionsState;
  chainTime: number | null;
  account: string | null;
  navigate: Nav;
}) {
  if (route.pool) {
    const pool = pools.pairs.find((p) => p.pair.toLowerCase() === route.pool!.toLowerCase());
    if (!pool) {
      return (
        <div className="page">
          <BackLink navigate={navigate} />
          {pools.status === 'ready' ? (
            <EmptyState title="No such pool">
              <p className="small">The factory has no pool at {shortAddress(route.pool)}.</p>
            </EmptyState>
          ) : (
            <EmptyState title="Reading the pool" />
          )}
        </div>
      );
    }
    return <PoolDetail pool={pool} pools={pools} market={market} positions={positions} chainTime={chainTime} account={account} navigate={navigate} />;
  }
  return <PoolList pools={pools} market={market} positions={positions} chainTime={chainTime} navigate={navigate} />;
}

function BackLink({ navigate }: { navigate: Nav }) {
  return (
    <a
      className="back-link"
      href="?tab=pools"
      onClick={(e) => {
        e.preventDefault();
        navigate({ page: 'pools' });
      }}
    >
      <IconBack /> Pools
    </a>
  );
}

function PoolList({
  pools,
  market,
  positions,
  chainTime,
  navigate,
}: {
  pools: PoolsState;
  market: MarketData;
  positions: PositionsState;
  chainTime: number | null;
  navigate: Nav;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('tvl');
  const wfmx = DEX_ADDRESSES.wfmx;
  const shareOf = useMemo(() => {
    const m = new Map<string, Position>();
    for (const p of positions.positions ?? []) m.set(p.snapshot.pair.toLowerCase(), p);
    return m;
  }, [positions.positions]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = pools.pairs.filter(
      (p) =>
        !q ||
        poolName(p, wfmx).toLowerCase().includes(q) ||
        [p.token0, p.token1].some((t) => t.symbol.toLowerCase().includes(q) || t.address.toLowerCase() === q) ||
        p.pair.toLowerCase() === q,
    );
    const key = (p: PairSnapshot) => {
      const s = market.stats.get(p.pair.toLowerCase());
      return sort === 'tvl' ? (s?.tvlUsdE18 ?? -1n) : sort === 'vol' ? (s?.volume24hUsdE18 ?? -1n) : (s?.apr7dPpm ?? -1n);
    };
    return [...list].sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
  }, [pools.pairs, query, sort, market.stats, wfmx]);

  const o = market.overview;
  const th = (k: SortKey, label: string, cls = '') => (
    <th scope="col" className={'r ' + cls} aria-sort={sort === k ? 'descending' : 'none'}>
      <button className={'th-sort' + (sort === k ? ' is-active' : '')} onClick={() => setSort(k)}>
        {label}
      </button>
    </th>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Pools</h1>
          <p className="page-sub mono">
            {pools.pairs.length} pool{pools.pairs.length === 1 ? '' : 's'} · TVL {formatUsd(o.tvlUsdE18, { compact: true })} · 24h volume{' '}
            {formatUsd(o.volume24hUsdE18, { compact: true })}
          </p>
        </div>
        <span className="spacer" />
        <a
          className="btn btn-primary btn-sm"
          href="?tab=liquidity"
          onClick={(e) => {
            e.preventDefault();
            navigate({ page: 'liquidity' });
          }}
        >
          Add liquidity
        </a>
      </div>

      <div className="toolbar">
        <div className="search-field search-inline">
          <IconSearch />
          <input className="input input-search" placeholder="Filter by token or address" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter pools" />
        </div>
      </div>

      {pools.status === 'error' && (
        <Notice kind="danger" role="alert">
          Could not read the pool registry: {pools.error}
        </Notice>
      )}

      <section className="card" data-testid="pools-table">
        {pools.status !== 'ready' && pools.pairs.length === 0 ? (
          <div className="card-pad">
            <Skeleton width="40%" /> <span className="muted small">Reading the factory</span>
          </div>
        ) : pools.pairs.length === 0 ? (
          <EmptyState title="No pools yet">
            <p className="small">The factory has never created a pair. The first liquidity provider sets the price.</p>
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing matches that filter" />
        ) : (
          <div className="table-wrap">
            <table className="table table-pools">
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  {th('tvl', 'TVL')}
                  {th('vol', 'Volume 24h', 'hide-xs')}
                  <th scope="col" className="r hide-md">
                    Fees 24h
                  </th>
                  {th('apr', 'Fee APR 7d', 'hide-sm')}
                  <th scope="col" className="r hide-md">
                    Your share
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const s = market.stats.get(p.pair.toLowerCase());
                  const [a, b] = orderedTokens(p, wfmx);
                  const mine = shareOf.get(p.pair.toLowerCase());
                  const seeded = p.reserve0 > 0n && p.reserve1 > 0n;
                  return (
                    <tr key={p.pair} className="tr-link" onClick={() => navigate({ page: 'pools', pool: p.pair })} data-testid="pool-row">
                      <td>
                        <span className="cell-pair">
                          <PairLogos a={{ ...a, symbol: poolSymbol(a, wfmx) }} b={b} size={24} />
                          <span className="cell-pair-text">
                            <a
                              className="pool-link"
                              href={`?tab=pools&pool=${p.pair}`}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                navigate({ page: 'pools', pool: p.pair });
                              }}
                            >
                              {poolName(p, wfmx)}
                            </a>
                            <span className="cell-badges">
                              <span className="badge badge-quiet mono">0.30%</span>
                              {seeded ? <LockBadge lock={pools.locks.get(p.pair.toLowerCase()) ?? null} chainTime={chainTime} /> : <span className="badge">empty</span>}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="r mono">
                        {formatUsd(s?.tvlUsdE18 ?? null, { compact: true })}
                        {s?.tvlEstimated && <span className="faint" title="Only one side has a USD basis; the other is taken as equal."> est.</span>}
                      </td>
                      <td className="r mono hide-xs">{formatUsd(s?.volume24hUsdE18 ?? 0n, { compact: true })}</td>
                      <td className="r mono hide-md">{formatUsd(s?.fees24hUsdE18 ?? 0n, { compact: true })}</td>
                      <td className="r mono hide-sm">{aprText(s?.apr7dPpm)}</td>
                      <td className="r mono hide-md">{mine ? formatPpmPercent(mine.shareOfPoolPpm, 3) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="footnote">
        TVL values each side of a pool at its own basis: FMX at the official price, 1 USDF = $1, 1 AZNT = 1 AZN at 1.70 AZN
        per USD. Volume and fees are summed from the pools&rsquo; Swap events; fee APR annualises the last 7 days&rsquo; 0.30%
        fees against today&rsquo;s TVL and is not compounded. <strong>Locked</strong> is the share of LP supply held by the
        LiquidityLocker with an unlock date still in the future.
      </p>
    </div>
  );
}

function PoolDetail({
  pool,
  pools,
  market,
  positions,
  chainTime,
  account,
  navigate,
}: {
  pool: PairSnapshot;
  pools: PoolsState;
  market: MarketData;
  positions: PositionsState;
  chainTime: number | null;
  account: string | null;
  navigate: Nav;
}) {
  const wfmx = DEX_ADDRESSES.wfmx;
  const [a, b] = orderedTokens(pool, wfmx);
  const [base, setBase] = useState<'a' | 'b'>('a');
  const [unit, setUnit] = useState<'quote' | 'usd'>('usd');
  const [range, setRange] = useState<Range>('ALL');
  const stats = market.stats.get(pool.pair.toLowerCase());
  const lock = pools.locks.get(pool.pair.toLowerCase()) ?? null;
  const value = poolValue(pool, market.prices);
  const seeded = pool.reserve0 > 0n && pool.reserve1 > 0n;
  const baseToken = base === 'a' ? a : b;
  const quoteToken = base === 'a' ? b : a;
  const quoteUsd = market.prices.get(quoteToken.address.toLowerCase())?.usdE18;
  const usdMode = unit === 'usd' && quoteUsd !== undefined;
  const series = useMemo(
    () => poolPriceSeries(market.syncs, pool, baseToken.address, market.clock, usdMode ? quoteUsd : undefined),
    [market.syncs, market.clock, pool, baseToken.address, usdMode, quoteUsd],
  );
  const first = series[0]?.t ?? null;
  const from = rangeStart(range, market.now, first);
  const price = poolPriceE18(pool, baseToken.address);
  const priceUsd = price !== null && quoteUsd !== undefined ? (price * quoteUsd) / E18 : null;
  const fmxUsd = poolFmxUsdE18(pool, wfmx, market.pegs);
  const official = market.pegs.get(wfmx.toLowerCase())?.usdE18 ?? null;
  const showOfficial = usdMode && baseToken.address.toLowerCase() === wfmx.toLowerCase() && official !== null;
  const mine = (positions.positions ?? []).find((p) => p.snapshot.pair.toLowerCase() === pool.pair.toLowerCase()) ?? null;
  const trades = market.trades.filter((t) => t.pair === pool.pair.toLowerCase());
  const isA0 = pool.token0.address.toLowerCase() === a.address.toLowerCase();
  const [ra, rb] = isA0 ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0];
  const [va, vb] = isA0 ? [value.side0UsdE18, value.side1UsdE18] : [value.side1UsdE18, value.side0UsdE18];
  const share = va !== null && vb !== null && va + vb > 0n ? Number((va * 1000n) / (va + vb)) / 10 : null;
  const symA = poolSymbol(a, wfmx);
  const mineValue =
    mine && value.tvlUsdE18 !== null && pool.totalSupply > 0n ? (value.tvlUsdE18 * mine.lpBalance) / pool.totalSupply : null;

  return (
    <div className="page" data-testid="pool-detail">
      <BackLink navigate={navigate} />
      <div className="pool-head">
        <PairLogos a={{ ...a, symbol: symA }} b={b} size={36} />
        <div className="pool-head-text">
          <h1>{poolName(pool, wfmx)}</h1>
          <div className="cell-badges">
            <span className="badge badge-quiet mono">0.30% fee</span>
            {seeded && <LockBadge lock={lock} chainTime={chainTime} full />}
            <AddressLink address={pool.pair} />
          </div>
        </div>
        <span className="spacer" />
        <div className="pool-actions">
          <a className="btn btn-sm" href={`./?inputCurrency=${b.address}&outputCurrency=${a.kind === 'erc20' && a.address.toLowerCase() === wfmx.toLowerCase() ? 'FMX' : a.address}`}>
            Swap
          </a>
          <a
            className="btn btn-primary btn-sm"
            href={`?tab=liquidity&a=${a.address}&b=${b.address}`}
            onClick={(e) => {
              e.preventDefault();
              navigate({ page: 'liquidity', pairA: a.address.toLowerCase() === wfmx.toLowerCase() ? 'FMX' : a.address, pairB: b.address });
            }}
          >
            Add liquidity
          </a>
        </div>
      </div>

      <div className="figures figures-5">
        <Figure
          label="TVL"
          value={formatUsd(value.tvlUsdE18)}
          sub={value.estimated ? 'one side valued, the other taken as equal' : 'both sides at their basis'}
          testId="pool-tvl"
        />
        <Figure label="Volume 24h" value={formatUsd(stats?.volume24hUsdE18 ?? 0n)} sub={`${stats?.trades24h ?? 0} trades · 7d ${formatUsd(stats?.volume7dUsdE18 ?? 0n, { compact: true })}`} />
        <Figure label="Fees 24h" value={formatUsd(stats?.fees24hUsdE18 ?? 0n)} sub={`7d ${formatUsd(stats?.fees7dUsdE18 ?? 0n)}`} />
        <Figure label="Fee APR" value={aprText(stats?.apr7dPpm)} sub={`7d basis · 24h ${aprText(stats?.apr24hPpm)}`} testId="pool-apr" />
        <Figure
          label="Your position"
          value={mine ? formatPpmPercent(mine.shareOfPoolPpm, 4) : account ? '—' : 'Not connected'}
          sub={mine ? `${formatUsd(mineValue)} · ${formatAmount(mine.lpBalance, 18, 6)} LP` : account ? 'no LP tokens in this pool' : 'connect a wallet to see it'}
          testId="pool-mine"
        />
      </div>

      <div className="grid-detail">
        <section className="card chart-card" aria-labelledby="pool-chart-h">
          <div className="chart-card-head">
            <div className="chart-title-block">
              <h2 id="pool-chart-h" className="card-title-sm">
                Price of {poolSymbol(baseToken, wfmx)}
              </h2>
              <div className="price-line">
                <span className="price-big mono">
                  {usdMode ? formatUsdPrice(priceUsd) : price !== null ? `${formatAmount(price, 18, 6)}` : '—'}
                </span>
                {!usdMode && <span className="price-tag">{poolSymbol(quoteToken, wfmx)}</span>}
              </div>
              {usdMode && price !== null && (
                <div className="price-sub mono">
                  {formatAmount(price, 18, 6)} {poolSymbol(quoteToken, wfmx)} · {market.prices.get(quoteToken.address.toLowerCase())?.basis}
                </div>
              )}
            </div>
            <div className="chart-controls">
              <Segmented
                value={base}
                options={[
                  ['a', symA],
                  ['b', b.symbol],
                ]}
                onChange={setBase}
                label="Price of"
                size="sm"
              />
              {quoteUsd !== undefined && (
                <Segmented
                  value={unit}
                  options={[
                    ['usd', 'USD'],
                    ['quote', poolSymbol(quoteToken, wfmx)],
                  ]}
                  onChange={setUnit}
                  label="Unit"
                  size="sm"
                />
              )}
              <Segmented value={range} options={RANGES} onChange={setRange} label="Range" size="sm" />
            </div>
          </div>
          <LineChart
            series={[{ id: 'price', label: `${poolSymbol(baseToken, wfmx)} price`, points: series, tone: 'accent', step: true, area: true }]}
            from={from}
            to={market.now}
            height={280}
            formatY={(v) => (usdMode ? formatUsdNumber(v) : formatNumber(v))}
            reference={showOfficial ? { value: Number(official) / 1e18, label: `Official ${formatUsdPrice(official)}` } : undefined}
            summary={`Price of ${poolSymbol(baseToken, wfmx)} in the ${poolName(pool, wfmx)} pool after every reserve change.`}
            testId="pool-chart"
          />
          {showOfficial && (
            <Legend
              items={[
                { id: 'p', label: 'Pool price', tone: 'accent', value: formatUsdPrice(fmxUsd) },
                { id: 'o', label: 'Official price', tone: 'faint', dashed: true, value: formatUsdPrice(official) },
              ]}
            />
          )}
        </section>

        <section className="card" aria-labelledby="reserves-h">
          <div className="card-head">
            <h2 id="reserves-h" className="card-title-sm">
              Reserves
            </h2>
          </div>
          <div className="card-pad reserves">
            {[
              [a, ra, va, symA],
              [b, rb, vb, b.symbol],
            ].map(([t, r, v, sym]) => (
              <div key={String(sym)} className="reserve-row">
                <TokenLogo token={t as typeof a} size={24} />
                <span className="reserve-main">
                  <span className="mono">{formatAmount(r as bigint, (t as typeof a).decimals, 4)}</span> <span className="muted">{String(sym)}</span>
                </span>
                <span className="mono faint">{formatUsd(v as bigint | null)}</span>
              </div>
            ))}
            {share !== null && (
              <div className="split" aria-label={`${symA} side ${share}% of the pool's value at the stated bases`}>
                <span className="split-a" style={{ width: `${share}%` }} />
              </div>
            )}
            {share !== null && (
              <p className="field-hint">
                {symA} side {share.toFixed(1)}% · {b.symbol} side {(100 - share).toFixed(1)}% of the value at the stated bases.
                {Math.abs(share - 50) > 5 && ' A pool at the official price would hold equal value on both sides.'}
              </p>
            )}
            <div className="kv">
              <div>
                <span className="label">LP supply</span>
                <span className="mono">{formatAmount(pool.totalSupply, 18, 6)}</span>
              </div>
              <div>
                <span className="label">Holds</span>
                <span>
                  {a.address.toLowerCase() === wfmx.toLowerCase() ? 'WFMX (FMX, wrapped 1:1)' : a.symbol} and {b.symbol}
                </span>
              </div>
              <div>
                <span className="label">Last reserve change</span>
                <span className="mono small">{pool.blockTimestampLast ? formatTimestamp(pool.blockTimestampLast) : '—'}</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="trades-h">
        <div className="card-head">
          <h2 id="trades-h" className="card-title-sm">
            Recent trades
          </h2>
          <span className="spacer" />
          <span className="faint small mono">{stats?.tradesAll ?? 0} all time</span>
        </div>
        <TradesTable trades={trades} now={market.now} limit={30} emptyText="No trades in this pool yet." />
      </section>

      <LocksSection pool={pool} lock={lock} chainTime={chainTime} />
    </div>
  );
}

function LocksSection({ pool, lock, chainTime }: { pool: PairSnapshot; lock: LockSummary | null; chainTime: number | null }) {
  return (
    <section className="card" aria-labelledby="locks-h" data-testid="locks">
      <div className="card-head">
        <h2 id="locks-h" className="card-title-sm">
          Locked liquidity
        </h2>
      </div>
      <div className="card-pad">
        {lock && lock.held > lock.lockedNow && (
          <Notice kind="warn">
            The locker holds {formatAmount(lock.held, 18, 6)} LP for this pool but only {formatAmount(lock.lockedNow, 18, 6)} is
            still time-locked. The rest has matured and can be withdrawn in the next block. A matured lock is not a lock.
          </Notice>
        )}
        {lock && lock.all.length > 0 ? (
          <ul className="rows rows-flush">
            {lock.all.map((record) => {
              const state = lockState(record, chainTime ?? lock.asOf);
              const share = pool.totalSupply > 0n ? (record.amount * PPM) / pool.totalSupply : 0n;
              return (
                <li key={String(record.id)} className="row">
                  <span className="row-main">
                    <span className="row-title">
                      Lock #{String(record.id)}{' '}
                      <span className={'badge ' + (state === 'locked' ? 'badge-lock' : state === 'matured' ? 'badge-warn' : '')}>{state}</span>
                    </span>
                    <span className="row-sub">
                      owner {shortAddress(record.owner)} · locked {formatTimestamp(record.lockedAt)} · unlocks {formatTimestamp(record.unlockAt)}
                    </span>
                  </span>
                  <span className="row-side">
                    <span className="mono">{formatAmount(record.amount, 18, 6)} LP</span>
                    <span className="mono faint small">{formatPpmPercent(share, 2)} of supply</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">
            No LP tokens from this pool have been sent to the LiquidityLocker. Whoever holds the LP can withdraw the whole pool
            at any time.
          </p>
        )}
      </div>
    </section>
  );
}
