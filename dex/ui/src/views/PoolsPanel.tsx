import { useMemo, useState } from 'react';
import { AddressLink, EmptyState, Notice, Spinner } from '../components/ui.tsx';
import {
  formatAmount,
  formatPpmPercent,
  formatRelativeFuture,
  formatTimestamp,
  priceFromReserves,
  shortAddress,
} from '../lib/amounts.ts';
import { PPM } from '../lib/math.ts';
import type { PairSnapshot } from '../lib/pairs.ts';
import { lockState, type LockSummary } from '../lib/locker.ts';
import type { PoolsState } from '../state/usePools.ts';

/**
 * Every pool on the network, with the number that matters most to a buyer:
 * how much of the LP supply is time-locked, and until when.
 */
export function PoolsPanel({ pools, chainTimestamp }: { pools: PoolsState; chainTimestamp: number | null }) {
  const [query, setQuery] = useState('');
  const [openPair, setOpenPair] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pools.pairs;
    return pools.pairs.filter(
      (p) =>
        p.token0.symbol.toLowerCase().includes(q) ||
        p.token1.symbol.toLowerCase().includes(q) ||
        p.token0.address.toLowerCase().includes(q) ||
        p.token1.address.toLowerCase().includes(q) ||
        p.pair.toLowerCase().includes(q),
    );
  }, [pools.pairs, query]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Pools</h2>
        <span className="spacer" />
        <span className="muted small num">
          {pools.pairs.length} pool{pools.pairs.length === 1 ? '' : 's'}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={pools.reload} disabled={pools.status === 'loading'}>
          {pools.status === 'loading' ? <Spinner /> : null} Refresh
        </button>
      </div>

      <div className="panel-inset">
        <input
          className="input"
          placeholder="Filter by symbol or address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter pools"
        />
        <p className="field-hint">
          A <span className="tag tag-lock">LOCKED</span> badge means LP tokens are held by the LiquidityLocker until the
          date shown — the liquidity behind that pool cannot be pulled before then, by anyone, including the project.
          No badge means it can be withdrawn at any moment.
        </p>
      </div>

      {pools.status === 'error' && (
        <div className="panel-body">
          <Notice kind="danger" role="alert">
            Could not read the pool registry: {pools.error}
          </Notice>
        </div>
      )}

      {pools.status === 'loading' && pools.pairs.length === 0 && <EmptyState title="Reading the factory…" />}

      {pools.status === 'ready' && pools.pairs.length === 0 && (
        <EmptyState title="No pools yet">
          <p className="small">The factory has never created a pair. The first liquidity provider sets the price.</p>
        </EmptyState>
      )}

      {filtered.length === 0 && pools.pairs.length > 0 && <EmptyState title="Nothing matches that filter" />}

      <ul className="pool-list">
        {filtered.map((snapshot) => (
          <li key={snapshot.pair}>
            <PoolRow
              snapshot={snapshot}
              lock={pools.locks.get(snapshot.pair.toLowerCase()) ?? null}
              chainTimestamp={chainTimestamp}
              isOpen={openPair === snapshot.pair}
              onToggle={() => setOpenPair((c) => (c === snapshot.pair ? null : snapshot.pair))}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PoolRow({
  snapshot,
  lock,
  chainTimestamp,
  isOpen,
  onToggle,
}: {
  snapshot: PairSnapshot;
  lock: LockSummary | null;
  chainTimestamp: number | null;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const price = priceFromReserves(snapshot.reserve0, snapshot.token0.decimals, snapshot.reserve1, snapshot.token1.decimals, 6);
  const inverse = priceFromReserves(snapshot.reserve1, snapshot.token1.decimals, snapshot.reserve0, snapshot.token0.decimals, 6);
  const seeded = snapshot.reserve0 > 0n && snapshot.reserve1 > 0n;
  const lockedPercent = lock ? formatPpmPercent(lock.lockedPpm, 1) : null;
  const isLocked = Boolean(lock && lock.lockedNow > 0n);

  return (
    <div className={'pool' + (isOpen ? ' is-open' : '')}>
      <button className="pool-head" onClick={onToggle} aria-expanded={isOpen}>
        <span className="pool-pair">
          <span className="pool-symbols">
            {snapshot.token0.symbol}/{snapshot.token1.symbol}
          </span>
          <span className="pool-address mono">{shortAddress(snapshot.pair)}</span>
        </span>

        <span className="pool-reserves num">
          {seeded ? (
            <>
              <span>
                {formatAmount(snapshot.reserve0, snapshot.token0.decimals, 4)} {snapshot.token0.symbol}
              </span>
              <span>
                {formatAmount(snapshot.reserve1, snapshot.token1.decimals, 4)} {snapshot.token1.symbol}
              </span>
            </>
          ) : (
            <span className="muted">empty — no price</span>
          )}
        </span>

        <span className="pool-price num">
          {seeded ? (
            <>
              <span>
                1 {snapshot.token0.symbol} = {price} {snapshot.token1.symbol}
              </span>
              <span className="muted">
                1 {snapshot.token1.symbol} = {inverse} {snapshot.token0.symbol}
              </span>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </span>

        <span className="pool-lock">
          {lock === null ? (
            <span className="tag">lock unknown</span>
          ) : isLocked ? (
            <span className="lock-badge">
              <span className="tag tag-lock">LOCKED</span>
              <span className="num">{lockedPercent} of LP</span>
              <span className="muted">
                {lock.earliestUnlock !== null
                  ? `unlocks ${formatRelativeFuture(lock.earliestUnlock, chainTimestamp ?? undefined)}`
                  : ''}
              </span>
            </span>
          ) : (
            <span className="lock-badge">
              <span className="tag tag-open">NOT LOCKED</span>
              <span className="muted">liquidity can be pulled</span>
            </span>
          )}
        </span>

        <span className="caret">{isOpen ? '▴' : '▾'}</span>
      </button>

      {isOpen && (
        <div className="pool-body">
          <div className="pool-grid">
            <div>
              <div className="k">Pool contract</div>
              <div className="v">
                <AddressLink address={snapshot.pair} />
              </div>
            </div>
            <div>
              <div className="k">{snapshot.token0.symbol}</div>
              <div className="v">
                <AddressLink address={snapshot.token0.address} />
                {snapshot.token0.metadataFailed && <span className="tag tag-warn">metadata unreadable</span>}
              </div>
            </div>
            <div>
              <div className="k">{snapshot.token1.symbol}</div>
              <div className="v">
                <AddressLink address={snapshot.token1.address} />
                {snapshot.token1.metadataFailed && <span className="tag tag-warn">metadata unreadable</span>}
              </div>
            </div>
            <div>
              <div className="k">LP supply</div>
              <div className="v num">{formatAmount(snapshot.totalSupply, 18, 8)}</div>
            </div>
            <div>
              <div className="k">Locked now</div>
              <div className="v num">{lock ? `${formatAmount(lock.lockedNow, 18, 8)} LP` : '—'}</div>
            </div>
            <div>
              <div className="k">Held by locker</div>
              <div className="v num">{lock ? `${formatAmount(lock.held, 18, 8)} LP` : '—'}</div>
            </div>
          </div>

          {lock && lock.held > lock.lockedNow && (
            <Notice kind="warn">
              The locker holds {formatAmount(lock.held, 18, 6)} LP for this pool but only{' '}
              {formatAmount(lock.lockedNow, 18, 6)} is still time-locked — the rest has matured and can be withdrawn in
              the next block. A matured lock is not a lock.
            </Notice>
          )}

          {lock && lock.all.length > 0 ? (
            <>
              <h4 className="section-title">Locks on this pool</h4>
              <ul className="row-list">
                {lock.all.map((record) => {
                  const state = lockState(record, chainTimestamp ?? lock.asOf);
                  const share = snapshot.totalSupply > 0n ? (record.amount * PPM) / snapshot.totalSupply : 0n;
                  return (
                    <li key={String(record.id)}>
                      <span className="row-main">
                        <span className="row-title">
                          Lock #{String(record.id)}
                          <span
                            className={`tag ${
                              state === 'locked' ? 'tag-lock' : state === 'matured' ? 'tag-warn' : ''
                            }`}
                          >
                            {state}
                          </span>
                        </span>
                        <span className="row-sub">
                          owner {shortAddress(record.owner)} · locked {formatTimestamp(record.lockedAt)} · unlocks{' '}
                          {formatTimestamp(record.unlockAt)}
                        </span>
                      </span>
                      <span className="row-value num">
                        {formatAmount(record.amount, 18, 6)} LP
                        <span className="sub">{formatPpmPercent(share, 2)} of supply</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="muted small">
              No LP tokens from this pool have ever been sent to the LiquidityLocker. Whoever holds the LP can withdraw
              the whole pool at any time.
            </p>
          )}

          {lock && lock.latestUnlock !== null && (
            <p className="muted small">
              Earliest unlock {formatTimestamp(lock.earliestUnlock ?? 0)} · last unlock {formatTimestamp(lock.latestUnlock)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
