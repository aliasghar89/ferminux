import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES } from '../config.ts';
import { AddressLink, EmptyState, Notice, Spinner, StatRow, TxStatus, type TxPhase } from '../components/ui.tsx';
import { formatAmount, formatPpmPercent, formatRelativeFuture, formatTimestamp, shortAddress } from '../lib/amounts.ts';
import { loadPositions, quoteRemoveLiquidity, removeLiquidity, type Position } from '../lib/liquidity.ts';
import { approveLp, fetchLpAllowance } from '../lib/pairs.ts';
import { loadOwnerLocks, lockState, type LockRecord } from '../lib/locker.ts';
import { readableError } from '../lib/wallet.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { WalletSession } from '../state/useWallet.ts';
import { DEFAULT_TRADE_SETTINGS, TradeSettings, type TradeSettingsValue } from './TradeSettings.tsx';

/** Your LP positions: what they are worth now, and how to take them out. */
export function PositionsPanel({
  provider,
  pools,
  wallet,
  chainTimestamp,
  onChainChanged,
}: {
  provider: JsonRpcProvider | null;
  pools: PoolsState;
  wallet: WalletSession;
  chainTimestamp: number | null;
  onChainChanged: () => void;
}) {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [locks, setLocks] = useState<LockRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPair, setOpenPair] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!provider || !wallet.address || pools.pairs.length === 0) {
      setPositions(wallet.address ? [] : null);
      setLocks([]);
      return;
    }
    setLoading(true);
    try {
      const [found, owned] = await Promise.all([
        loadPositions(provider, pools.pairs, wallet.address),
        loadOwnerLocks(provider, DEX_ADDRESSES, wallet.address),
      ]);
      setPositions(found);
      setLocks(owned);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [provider, wallet.address, pools.pairs]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!wallet.address) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Your positions</h2>
        </div>
        <EmptyState title="No wallet connected">
          <p className="small">Connect a wallet to see the pools you have deposited into.</p>
        </EmptyState>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Your positions</h2>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner /> : null} Refresh
          </button>
        </div>

        {error && (
          <div className="panel-body">
            <Notice kind="danger" role="alert">
              {error}
            </Notice>
          </div>
        )}

        {positions === null || (loading && positions.length === 0) ? (
          <EmptyState title="Loading positions…" />
        ) : positions.length === 0 ? (
          <EmptyState title="No liquidity positions">
            <p className="small">
              You hold no LP tokens in any Ferminux pool. Add liquidity to earn a share of the 0.30% trading fee.
            </p>
          </EmptyState>
        ) : (
          <ul className="position-list">
            {positions.map((position) => (
              <li key={position.snapshot.pair}>
                <PositionRow
                  position={position}
                  provider={provider}
                  wallet={wallet}
                  isOpen={openPair === position.snapshot.pair}
                  onToggle={() =>
                    setOpenPair((current) => (current === position.snapshot.pair ? null : position.snapshot.pair))
                  }
                  onChainChanged={() => {
                    onChainChanged();
                    void load();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Your locked LP</h2>
        </div>
        {locks.length === 0 ? (
          <EmptyState title="No locked positions">
            <p className="small">
              LP tokens you send to the LiquidityLocker appear here with their unlock date. A locked position still
              belongs to you — it simply cannot be withdrawn early, by you or by anyone.
            </p>
          </EmptyState>
        ) : (
          <ul className="row-list">
            {locks.map((lock) => {
              const state = lockState(lock, chainTimestamp ?? undefined);
              const pool = pools.pairs.find((p) => p.pair.toLowerCase() === lock.token.toLowerCase());
              return (
                <li key={String(lock.id)}>
                  <span className="row-main">
                    <span className="row-title">
                      {pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : shortAddress(lock.token)}
                      <span className={`tag ${state === 'locked' ? 'tag-lock' : state === 'matured' ? 'tag-warn' : ''}`}>
                        {state}
                      </span>
                    </span>
                    <span className="row-sub">
                      Lock #{String(lock.id)} · unlocks {formatTimestamp(lock.unlockAt)} (
                      {formatRelativeFuture(lock.unlockAt, chainTimestamp ?? undefined)})
                    </span>
                  </span>
                  <span className="row-value num">{formatAmount(lock.amount, 18, 6)} LP</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

const PERCENT_PRESETS = [25, 50, 75, 100];

function PositionRow({
  position,
  provider,
  wallet,
  isOpen,
  onToggle,
  onChainChanged,
}: {
  position: Position;
  provider: JsonRpcProvider | null;
  wallet: WalletSession;
  isOpen: boolean;
  onToggle: () => void;
  onChainChanged: () => void;
}) {
  const { snapshot } = position;
  const [percent, setPercent] = useState(50);
  const [settings, setSettings] = useState<TradeSettingsValue>(DEFAULT_TRADE_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unwrap, setUnwrap] = useState(true);
  const [lpAllowance, setLpAllowance] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<TxPhase>({ state: 'idle' });

  const hasWfmx =
    snapshot.token0.address.toLowerCase() === DEX_ADDRESSES.wfmx.toLowerCase() ||
    snapshot.token1.address.toLowerCase() === DEX_ADDRESSES.wfmx.toLowerCase();

  const quote = useMemo(() => {
    try {
      return quoteRemoveLiquidity(snapshot, position.lpBalance, percent, settings.slippageBps);
    } catch {
      return null;
    }
  }, [snapshot, position.lpBalance, percent, settings.slippageBps]);

  const refreshAllowance = useCallback(async () => {
    if (!provider || !wallet.address) return;
    try {
      setLpAllowance(await fetchLpAllowance(provider, snapshot.pair, wallet.address, DEX_ADDRESSES.router));
    } catch {
      setLpAllowance(null);
    }
  }, [provider, wallet.address, snapshot.pair]);

  useEffect(() => {
    if (isOpen) void refreshAllowance();
  }, [isOpen, refreshAllowance]);

  const needsLpApproval = quote !== null && lpAllowance !== null && lpAllowance < quote.liquidity;
  const busy = phase.state === 'signing' || phase.state === 'pending';

  const runTx = async (send: () => Promise<{ hash: string; wait: () => Promise<unknown> }>, doneMessage: string) => {
    setPhase({ state: 'signing' });
    try {
      const tx = await send();
      setPhase({ state: 'pending', hash: tx.hash });
      await tx.wait();
      setPhase({ state: 'done', hash: tx.hash, message: doneMessage });
      onChainChanged();
      void refreshAllowance();
    } catch (err) {
      setPhase({ state: 'error', message: readableError(err) });
    }
  };

  return (
    <div className={'position' + (isOpen ? ' is-open' : '')}>
      <button className="position-head" onClick={onToggle} aria-expanded={isOpen}>
        <span className="position-pair">
          {snapshot.token0.symbol}/{snapshot.token1.symbol}
        </span>
        <span className="position-share num">{formatPpmPercent(position.shareOfPoolPpm, 4)} of pool</span>
        <span className="position-amounts num">
          {formatAmount(position.pooled0, snapshot.token0.decimals, 4)} {snapshot.token0.symbol} ·{' '}
          {formatAmount(position.pooled1, snapshot.token1.decimals, 4)} {snapshot.token1.symbol}
        </span>
        <span className="caret">{isOpen ? '▴' : '▾'}</span>
      </button>

      {isOpen && (
        <div className="position-body">
          <TxStatus phase={phase} onDismiss={() => setPhase({ state: 'idle' })} />

          <StatRow label="LP tokens held" value={`${formatAmount(position.lpBalance, 18, 8)} LP`} />
          <StatRow label="Pool" value={<AddressLink address={snapshot.pair} />} />

          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor={`remove-${snapshot.pair}`}>Remove {percent}% of this position</label>
            <input
              id={`remove-${snapshot.pair}`}
              className="slider"
              type="range"
              min={1}
              max={100}
              step={1}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
            />
            <div className="seg-row" style={{ marginTop: 8 }}>
              {PERCENT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={'seg' + (percent === p ? ' is-on' : '')}
                  onClick={() => setPercent(p)}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>

          {quote && (
            <div className="quote-box">
              <StatRow label="LP burned" value={`${formatAmount(quote.liquidity, 18, 8)} LP`} />
              <StatRow
                label="You receive"
                value={`${formatAmount(quote.amount0, snapshot.token0.decimals, 8)} ${
                  snapshot.token0.symbol
                } · ${formatAmount(quote.amount1, snapshot.token1.decimals, 8)} ${snapshot.token1.symbol}`}
                hint="Your share of the reserves as they stand now — not what you deposited."
              />
              <StatRow
                label="Minimum received"
                value={`${formatAmount(quote.amount0Min, snapshot.token0.decimals, 8)} ${
                  snapshot.token0.symbol
                } · ${formatAmount(quote.amount1Min, snapshot.token1.decimals, 8)} ${snapshot.token1.symbol}`}
              />
            </div>
          )}

          {hasWfmx && (
            <label className="check-row" style={{ margin: '12px 0' }}>
              <input type="checkbox" checked={unwrap} onChange={(e) => setUnwrap(e.target.checked)} />
              <span>Unwrap WFMX back to native FMX on the way out</span>
            </label>
          )}

          <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
            Settings
          </button>
          {settingsOpen && <TradeSettings value={settings} onChange={setSettings} idPrefix={`rm-${snapshot.pair}`} />}

          <div className="action-stack">
            {needsLpApproval && (
              <button
                className="btn btn-block"
                disabled={busy || !quote}
                onClick={() =>
                  void runTx(
                    () => approveLp(wallet.wallet!.signer, snapshot.pair, DEX_ADDRESSES.router, quote!.liquidity),
                    'Approved the router to burn those LP tokens.',
                  )
                }
              >
                {busy ? <Spinner /> : null} Approve LP tokens
              </button>
            )}
            <button
              className="btn btn-primary btn-block"
              disabled={busy || !quote || needsLpApproval || !wallet.wallet || wallet.wrongChain}
              onClick={() =>
                void runTx(
                  () =>
                    removeLiquidity(
                      wallet.wallet!.signer,
                      DEX_ADDRESSES,
                      snapshot,
                      quote!,
                      wallet.address!,
                      settings.deadlineMinutes,
                      { unwrapNative: hasWfmx && unwrap, wfmx: DEX_ADDRESSES.wfmx },
                    ),
                  `Removed ${percent}% of your ${snapshot.token0.symbol}/${snapshot.token1.symbol} position.`,
                )
              }
            >
              {busy ? <Spinner /> : null} Remove liquidity
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
