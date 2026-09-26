import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES, isCanonicalToken } from '../config.ts';
import { EmptyState, Notice, Segmented, Spinner, StatRow, TxStatus, runTx, type TxPhase } from '../components/ui.tsx';
import { PairLogos } from '../components/TokenLogo.tsx';
import { TokenAmountField } from '../components/TradeParts.tsx';
import { IconChevronDown, IconPlus, IconSettings } from '../components/icons.tsx';
import {
  formatAmount,
  formatBpsPercent,
  formatFull,
  formatPpmPercent,
  formatRelativeFuture,
  formatTimestamp,
  parseAmount,
  priceFromReserves,
  shortAddress,
} from '../lib/amounts.ts';
import { poolName, poolSymbol } from '../lib/format.ts';
import { maxNativeSpendable } from '../lib/gas.ts';
import {
  addLiquidity,
  createPair,
  quoteAddLiquidity,
  quoteRemoveLiquidity,
  removeLiquidity,
  type AddLiquidityQuote,
  type Position,
} from '../lib/liquidity.ts';
import { lockState } from '../lib/locker.ts';
import { approveLp, fetchLpAllowance, orientedReserves, pairKey, type PairSnapshot } from '../lib/pairs.ts';
import { formatUsd, poolValue, valueUsdE18, type PriceTable } from '../lib/prices.ts';
import { isFactoryToken } from '../lib/registry.ts';
import {
  MAX_UINT256,
  approveToken,
  fetchAllowance,
  sameToken,
  tokenKey,
  type TokenInfo,
} from '../lib/tokens.ts';
import { ferminuxSigner, readableError } from '../lib/wallet.ts';
import type { MarketData } from '../state/useMarket.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { PositionsState } from '../state/usePositions.ts';
import type { TradeSettings } from '../state/useSettings.ts';
import type { WalletSession } from '../state/useWallet.ts';
import { LockBadge } from './PoolsView.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { TokenPicker } from './TokenPicker.tsx';

function usdText(prices: PriceTable, token: TokenInfo | null, amount: bigint): string | null {
  if (!token || amount <= 0n) return null;
  const b = prices.get(token.address.toLowerCase());
  return b ? `≈ ${formatUsd(valueUsdE18(amount, token.decimals, b.usdE18))}` : null;
}

/** "FMX" or an address from a link → a token the app lists (never an import). */
function resolveParam(param: string | null, tokens: TokenInfo[]): TokenInfo | null {
  if (!param) return null;
  if (param.toUpperCase() === 'FMX') return tokens.find((t) => t.kind === 'native') ?? null;
  return tokens.find((t) => t.kind === 'erc20' && t.address.toLowerCase() === param.toLowerCase()) ?? null;
}

interface Props {
  provider: JsonRpcProvider | null;
  pools: PoolsState;
  market: MarketData;
  wallet: WalletSession;
  tokens: TokenInfo[];
  balances: Map<string, bigint>;
  positions: PositionsState;
  settings: TradeSettings;
  onSettings: (s: TradeSettings) => void;
  pair: { a: string | null; b: string | null };
  chainTime: number | null;
  onImportToken: (token: TokenInfo) => void;
  onChainChanged: () => void;
}

export function LiquidityView(props: Props) {
  const [preset, setPreset] = useState<{ a: string | null; b: string | null; n: number }>({ ...props.pair, n: 0 });
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Liquidity</h1>
          <p className="page-sub">Deposit both tokens of a pool at its current price and earn 0.30% of every trade through it.</p>
        </div>
      </div>
      <div className="liq-layout">
        <AddLiquidityCard {...props} preset={preset} />
        <div className="liq-side">
          <PositionsCard {...props} onAddMore={(p) => setPreset({ a: p.a, b: p.b, n: preset.n + 1 })} />
          <LockedCard {...props} />
        </div>
      </div>
    </div>
  );
}

function AddLiquidityCard({
  provider,
  pools,
  market,
  wallet,
  tokens,
  balances,
  settings,
  onSettings,
  preset,
  onImportToken,
  onChainChanged,
  positions,
}: Props & { preset: { a: string | null; b: string | null; n: number } }) {
  const [tokenA, setTokenA] = useState<TokenInfo | null>(null);
  const [tokenB, setTokenB] = useState<TokenInfo | null>(null);
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [side, setSide] = useState<'A' | 'B'>('A');
  const [picking, setPicking] = useState<'A' | 'B' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [allowRead, setAllowRead] = useState<{ key: string; a: bigint; b: bigint } | null>(null);
  const [unverified, setUnverified] = useState<TokenInfo[]>([]);
  const [phase, setPhase] = useState<TxPhase>({ state: 'idle' });
  const [presetApplied, setPresetApplied] = useState(-1);
  // True while the pair on screen is the app's own default: it is re-chosen as the pools arrive.
  const [auto, setAuto] = useState(true);

  // A preset pair (a link, or "Add more" on a position) wins; otherwise FMX and
  // the first listed token it has a pool with (USDF, then AZNT).
  useEffect(() => {
    if (tokens.length === 0) return;
    if (presetApplied !== preset.n) {
      const a = resolveParam(preset.a, tokens);
      const b = resolveParam(preset.b, tokens);
      if (a && b && !sameToken(a, b)) {
        setTokenA(a);
        setTokenB(b);
        setTextA('');
        setTextB('');
        setPresetApplied(preset.n);
        setAuto(false);
        return;
      }
      // A link may name a pool token that is not read yet: wait for the pools.
      if ((preset.a || preset.b) && pools.status !== 'ready') return;
      setPresetApplied(preset.n);
    }
    if (!auto) return;
    const native = tokens.find((t) => t.kind === 'native') ?? tokens[0];
    const others = tokens.filter((t) => t.kind !== 'native' && t.address.toLowerCase() !== DEX_ADDRESSES.wfmx.toLowerCase());
    const pooled = ['USDF', 'AZNT']
      .map((sym) => others.find((t) => t.symbol === sym && isCanonicalToken(t.address) && pools.index.has(pairKey(native.address, t.address))))
      .find(Boolean);
    const nextB = pooled ?? others.find((t) => pools.index.has(pairKey(native.address, t.address))) ?? others[0] ?? null;
    if (!sameToken(native, tokenA)) setTokenA(native);
    if (!sameToken(nextB, tokenB)) setTokenB(nextB);
    if (pools.status === 'ready') setAuto(false);
  }, [tokens, pools.index, pools.status, preset, presetApplied, auto, tokenA, tokenB]);

  const snapshot: PairSnapshot | null = useMemo(() => {
    if (!tokenA || !tokenB) return null;
    return pools.index.get(pairKey(tokenA.address, tokenB.address)) ?? null;
  }, [pools.index, tokenA, tokenB]);
  const poolIsEmpty = !snapshot || snapshot.reserve0 <= 0n || snapshot.reserve1 <= 0n || snapshot.totalSupply <= 0n;

  const parsedA = tokenA && textA.trim() !== '' ? parseAmount(textA, tokenA.decimals) : null;
  const parsedB = tokenB && textB.trim() !== '' ? parseAmount(textB, tokenB.decimals) : null;
  const amountA = parsedA?.ok ? parsedA.wei : 0n;
  const amountB = parsedB?.ok ? parsedB.wei : 0n;

  // In a live pool the second amount is derived from the ratio, never typed.
  const quote: AddLiquidityQuote | null = useMemo(() => {
    if (!tokenA || !tokenB || sameToken(tokenA, tokenB)) return null;
    try {
      if (poolIsEmpty) {
        if (amountA <= 0n || amountB <= 0n) return null;
        return quoteAddLiquidity(snapshot, tokenA, tokenB, 'A', amountA, settings.slippageBps, amountB);
      }
      const typed = side === 'A' ? amountA : amountB;
      if (typed <= 0n) return null;
      return quoteAddLiquidity(snapshot, tokenA, tokenB, side, typed, settings.slippageBps);
    } catch {
      return null;
    }
  }, [snapshot, poolIsEmpty, tokenA, tokenB, side, amountA, amountB, settings.slippageBps]);

  useEffect(() => {
    if (!quote || poolIsEmpty || !tokenA || !tokenB) return;
    if (side === 'A') {
      const next = formatFull(quote.amountB, tokenB.decimals);
      setTextB((c) => (c === next ? c : next));
    } else {
      const next = formatFull(quote.amountA, tokenA.decimals);
      setTextA((c) => (c === next ? c : next));
    }
  }, [quote, poolIsEmpty, side, tokenA, tokenB]);

  const refreshAllowances = useCallback(async () => {
    if (!provider || !wallet.address || !tokenA || !tokenB) return;
    const key = `${wallet.address.toLowerCase()}:${tokenKey(tokenA)}:${tokenKey(tokenB)}`;
    try {
      const [a, b] = await Promise.all([
        fetchAllowance(provider, tokenA, wallet.address, DEX_ADDRESSES.router),
        fetchAllowance(provider, tokenB, wallet.address, DEX_ADDRESSES.router),
      ]);
      setAllowRead({ key, a, b });
    } catch {
      // Unreadable: ask for approvals rather than send a deposit that may revert.
      setAllowRead({ key, a: 0n, b: 0n });
    }
  }, [provider, wallet.address, tokenA, tokenB]);
  useEffect(() => {
    void refreshAllowances();
  }, [refreshAllowances]);

  // Any deposited token that is neither first-party nor minted by the launchpad
  // TokenFactory is flagged; an unreadable registry counts as not verified.
  useEffect(() => {
    let cancelled = false;
    const candidates = [tokenA, tokenB].filter((t): t is TokenInfo => !!t && t.kind === 'erc20' && !isCanonicalToken(t.address));
    if (!provider || candidates.length === 0) {
      setUnverified([]);
      return;
    }
    void Promise.all(candidates.map((t) => isFactoryToken(provider, t.address))).then((flags) => {
      if (!cancelled) setUnverified(candidates.filter((_, i) => flags[i] !== true));
    });
    return () => {
      cancelled = true;
    };
  }, [provider, tokenA, tokenB]);

  const balanceA = tokenA ? balances.get(tokenKey(tokenA)) : undefined;
  const balanceB = tokenB ? balances.get(tokenKey(tokenB)) : undefined;
  const shortA = balanceA !== undefined && quote ? quote.amountA > balanceA : false;
  const shortB = balanceB !== undefined && quote ? quote.amountB > balanceB : false;
  const allowKey = wallet.address && tokenA && tokenB ? `${wallet.address.toLowerCase()}:${tokenKey(tokenA)}:${tokenKey(tokenB)}` : '';
  const allow = allowRead && allowRead.key === allowKey ? allowRead : null;
  const allowUnknown = Boolean(wallet.address) && allow === null && (tokenA?.kind === 'erc20' || tokenB?.kind === 'erc20');
  const needA = quote !== null && tokenA?.kind === 'erc20' && allow !== null && allow.a < quote.amountA;
  const needB = quote !== null && tokenB?.kind === 'erc20' && allow !== null && allow.b < quote.amountB;
  const busy = phase.state === 'signing' || phase.state === 'pending';
  const canTrade = Boolean(wallet.wallet) && !wallet.wrongChain;

  const priceText =
    snapshot && !poolIsEmpty && tokenA && tokenB
      ? priceFromReserves(orientedReserves(snapshot, tokenA.address).own, tokenA.decimals, orientedReserves(snapshot, tokenA.address).other, tokenB.decimals, 6)
      : null;
  const openingPrice = poolIsEmpty && quote && tokenA && tokenB ? priceFromReserves(quote.amountA, tokenA.decimals, quote.amountB, tokenB.decimals, 6) : null;
  const lpValue =
    quote && quote.lpMinted !== null && snapshot && snapshot.totalSupply > 0n
      ? (() => {
          const v = poolValue(snapshot, market.prices).tvlUsdE18;
          return v === null ? null : (v * quote.lpMinted!) / snapshot.totalSupply;
        })()
      : null;

  const after = () => {
    onChainChanged();
    positions.reload();
    void refreshAllowances();
  };

  const approve = async (token: TokenInfo, amount: bigint) => {
    if (!wallet.wallet) return;
    const value = settings.unlimitedApprovals ? MAX_UINT256 : amount;
    await runTx(
      setPhase,
      `Approve ${token.symbol}`,
      async () => approveToken(await ferminuxSigner(wallet.wallet!), token, DEX_ADDRESSES.router, value),
      settings.unlimitedApprovals ? `Approved unlimited ${token.symbol}.` : `Approved exactly ${formatAmount(amount, token.decimals)} ${token.symbol}.`,
      readableError,
      after,
    );
  };

  const add = async () => {
    if (!wallet.wallet || !quote || !wallet.address) return;
    const ok = await runTx(
      setPhase,
      'Add liquidity',
      async () => addLiquidity(await ferminuxSigner(wallet.wallet!), DEX_ADDRESSES, quote, wallet.address!, settings.deadlineMinutes),
      `${poolIsEmpty ? 'Pool created and seeded with' : 'Added'} ${formatAmount(quote.amountA, quote.tokenA.decimals)} ${quote.tokenA.symbol} + ${formatAmount(quote.amountB, quote.tokenB.decimals)} ${quote.tokenB.symbol}.`,
      readableError,
      after,
    );
    if (ok) {
      setTextA('');
      setTextB('');
      setAcknowledged(false);
    }
  };

  const createEmpty = async () => {
    if (!wallet.wallet || !tokenA || !tokenB) return;
    await runTx(
      setPhase,
      'Create pool',
      async () => createPair(await ferminuxSigner(wallet.wallet!), DEX_ADDRESSES, tokenA, tokenB),
      `Created an empty ${tokenA.symbol}/${tokenB.symbol} pool. It has no price until someone deposits.`,
      readableError,
      after,
    );
  };

  const maxA = async () => {
    if (!tokenA || balanceA === undefined) return;
    setSide('A');
    if (tokenA.kind !== 'native') return setTextA(formatFull(balanceA, tokenA.decimals));
    const fee = await provider?.getFeeData().then((f) => f.maxFeePerGas).catch(() => null);
    setTextA(formatFull(maxNativeSpendable(balanceA, fee ?? null), tokenA.decimals));
  };
  const maxB = async () => {
    if (!tokenB || balanceB === undefined) return;
    setSide('B');
    if (tokenB.kind !== 'native') return setTextB(formatFull(balanceB, tokenB.decimals));
    const fee = await provider?.getFeeData().then((f) => f.maxFeePerGas).catch(() => null);
    setTextB(formatFull(maxNativeSpendable(balanceB, fee ?? null), tokenB.decimals));
  };

  let action: { label: string; onClick?: () => void; disabled: boolean } = { label: 'Enter an amount', disabled: true };
  if (!wallet.wallet) action = { label: 'Connect wallet', onClick: wallet.connect, disabled: wallet.connecting };
  else if (wallet.wrongChain) action = { label: 'Switch to Ferminux', onClick: () => void wallet.switchChain(), disabled: false };
  else if (!tokenA || !tokenB) action = { label: 'Select two tokens', disabled: true };
  else if (sameToken(tokenA, tokenB) || tokenA.address.toLowerCase() === tokenB.address.toLowerCase()) action = { label: 'Pick two different tokens', disabled: true };
  else if (!quote) action = { label: poolIsEmpty ? 'Enter both amounts' : 'Enter an amount', disabled: true };
  else if (shortA) action = { label: `Not enough ${tokenA.symbol}`, disabled: true };
  else if (shortB) action = { label: `Not enough ${tokenB.symbol}`, disabled: true };
  else if (allowUnknown) action = { label: 'Checking approvals', disabled: true };
  else if (needA) action = { label: `Approve ${tokenA.symbol}`, onClick: () => void approve(tokenA, quote.amountA), disabled: busy };
  else if (needB) action = { label: `Approve ${tokenB.symbol}`, onClick: () => void approve(tokenB, quote.amountB), disabled: busy };
  else if (poolIsEmpty && !acknowledged) action = { label: 'Confirm the opening price below', disabled: true };
  else action = { label: poolIsEmpty ? 'Create pool and deposit' : 'Add liquidity', onClick: () => void add(), disabled: busy };

  const wrongPair = tokenA && tokenB && tokenA.address.toLowerCase() === tokenB.address.toLowerCase();

  return (
    <section className="card liq-card" aria-labelledby="add-h" data-testid="add-liquidity">
      <div className="card-head">
        <h2 id="add-h" className="card-title">
          Add liquidity
        </h2>
        <span className="spacer" />
        <button className="settings-btn" onClick={() => setSettingsOpen(true)} aria-label="Trade settings">
          <span className="mono">{formatBpsPercent(settings.slippageBps)}</span>
          <IconSettings />
        </button>
      </div>
      <TxStatus phase={phase} onDismiss={() => setPhase({ state: 'idle' })} />

      {unverified.length > 0 && (
        <Notice kind="warn" role="alert" title={`${unverified.map((t) => t.symbol).join(' and ')} ${unverified.length > 1 ? 'are' : 'is'} not on the Ferminux list`}>
          Not first-party and not made by the Ferminux TokenFactory, so the contract can behave however its author wrote
          it. The router rejects a deposit that would hand you dust LP, but no router check makes an untrusted token safe:
          it controls its own side of the pool and can mint, tax, blacklist or freeze after you deposit.
        </Notice>
      )}

      <div className="swap-fields">
        <TokenAmountField
          label="Deposit"
          token={tokenA}
          onPickToken={() => setPicking('A')}
          value={textA}
          onChange={(t) => {
            setSide('A');
            setTextA(t);
          }}
          balance={balanceA}
          onMax={() => void maxA()}
          usd={usdText(market.prices, tokenA, quote?.amountA ?? amountA)}
          error={parsedA && !parsedA.ok ? parsedA.error : shortA && tokenA ? `More than your ${tokenA.symbol} balance.` : null}
          testId="liq-a"
        />
        <span className="flip-btn flip-static" aria-hidden="true">
          <IconPlus />
        </span>
        <TokenAmountField
          label="Deposit"
          token={tokenB}
          onPickToken={() => setPicking('B')}
          value={textB}
          onChange={(t) => {
            setSide('B');
            setTextB(t);
          }}
          balance={balanceB}
          onMax={() => void maxB()}
          usd={usdText(market.prices, tokenB, quote?.amountB ?? amountB)}
          error={parsedB && !parsedB.ok ? parsedB.error : shortB && tokenB ? `More than your ${tokenB.symbol} balance.` : null}
          testId="liq-b"
        />
      </div>

      {!poolIsEmpty && snapshot && tokenA && tokenB && (
        <div className="quote-body quote-flat" data-testid="liq-quote">
          <StatRow label="Pool price" value={`1 ${tokenA.symbol} = ${priceText ?? '—'} ${tokenB.symbol}`} hint="Your deposit must match it: the second amount is computed, not chosen." />
          {quote && (
            <>
              <StatRow label="Share of pool after" value={formatPpmPercent(quote.shareOfPoolPpm, 4)} testId="liq-share" />
              <StatRow label="LP tokens" value={`${quote.lpMinted !== null ? formatAmount(quote.lpMinted, 18, 8) : '—'}${lpValue !== null ? ` · ${formatUsd(lpValue)}` : ''}`} />
              <StatRow label="Minimum LP (slippage)" value={formatAmount(quote.minLiquidity, 18, 8)} hint="The router reverts unless it delivers at least this many LP tokens." />
              <StatRow
                label="Minimum deposited"
                value={`${formatAmount(quote.amountAMin, tokenA.decimals, 6)} ${tokenA.symbol} · ${formatAmount(quote.amountBMin, tokenB.decimals, 6)} ${tokenB.symbol}`}
                hint="If the price moves further than your slippage tolerance before the transaction lands, the router reverts."
              />
            </>
          )}
        </div>
      )}

      {poolIsEmpty && tokenA && tokenB && !wrongPair && (
        <div className="first-deposit" data-testid="new-pool">
          <h3>{snapshot ? 'This pool exists but is empty' : `No ${tokenA.symbol}/${tokenB.symbol} pool yet`}</h3>
          <p className="small">
            You would be the first depositor, and <strong>the ratio you deposit becomes the price</strong>. There is no oracle
            behind it, only what the pool holds.
          </p>
          <p className="small muted">
            If that ratio is off the real market price, arbitrage traders buy the cheap side until it matches, and that profit
            comes out of your deposit.
          </p>
          {openingPrice && quote && (
            <div className="quote-body quote-flat">
              <StatRow label="Opening price you set" value={`1 ${tokenA.symbol} = ${openingPrice} ${tokenB.symbol}`} />
              <StatRow label="Inverse" value={`1 ${tokenB.symbol} = ${priceFromReserves(quote.amountB, tokenB.decimals, quote.amountA, tokenA.decimals, 6) ?? '—'} ${tokenA.symbol}`} />
            </div>
          )}
          <label className="check-row">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>I am setting the opening price, and a wrong ratio will be arbitraged away at my expense.</span>
          </label>
        </div>
      )}

      {canTrade && (needA || needB) && quote && (
        <p className="field-hint">
          {settings.unlimitedApprovals
            ? 'Unlimited approvals are on in settings: the router may move any amount of the approved token until you revoke it.'
            : 'Each approval covers exactly this deposit and nothing more.'}
        </p>
      )}

      <button className="btn btn-primary btn-lg btn-block" disabled={action.disabled} onClick={action.onClick} data-testid="liq-action">
        {busy && <Spinner />}
        {action.label}
      </button>
      {canTrade && poolIsEmpty && !snapshot && tokenA && tokenB && !wrongPair && (
        <button className="btn btn-ghost btn-sm btn-block" disabled={busy} onClick={() => void createEmpty()}>
          Create the empty pool only, without a deposit
        </button>
      )}

      {picking && (
        <TokenPicker
          tokens={tokens}
          balances={balances}
          prices={market.prices}
          provider={provider}
          selected={picking === 'A' ? tokenA : tokenB}
          other={picking === 'A' ? tokenB : tokenA}
          onImport={onImportToken}
          onSelect={(t) => {
            setAuto(false);
            if (picking === 'A') {
              if (sameToken(t, tokenB)) setTokenB(tokenA);
              setTokenA(t);
            } else {
              if (sameToken(t, tokenA)) setTokenA(tokenB);
              setTokenB(t);
            }
            setPicking(null);
            setTextA('');
            setTextB('');
            setAcknowledged(false);
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {settingsOpen && <SettingsModal value={settings} onChange={onSettings} onClose={() => setSettingsOpen(false)} showRouting={false} />}
    </section>
  );
}

function PositionsCard({
  provider,
  pools,
  market,
  wallet,
  positions,
  settings,
  chainTime,
  onChainChanged,
  onAddMore,
}: Props & { onAddMore: (pair: { a: string; b: string }) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const wfmx = DEX_ADDRESSES.wfmx;
  return (
    <section className="card" aria-labelledby="pos-h" data-testid="positions">
      <div className="card-head">
        <h2 id="pos-h" className="card-title-sm">
          Your positions
        </h2>
        <span className="spacer" />
        {positions.loading && <Spinner />}
      </div>
      {!wallet.address ? (
        <EmptyState title="No wallet connected" action={<button className="btn btn-sm" onClick={wallet.connect}>Connect wallet</button>}>
          <p className="small">Connect to see the pools you have deposited into.</p>
        </EmptyState>
      ) : positions.error ? (
        <div className="card-pad">
          <Notice kind="danger" role="alert">
            {positions.error}
          </Notice>
        </div>
      ) : positions.positions === null ? (
        <p className="card-pad muted small">Reading your LP balances</p>
      ) : positions.positions.length === 0 ? (
        <EmptyState title="No positions yet">
          <p className="small">You hold no LP tokens in any Ferminux pool.</p>
        </EmptyState>
      ) : (
        <ul className="positions">
          {positions.positions.map((p) => (
            <li key={p.snapshot.pair}>
              <PositionRow
                position={p}
                provider={provider}
                wallet={wallet}
                market={market}
                settings={settings}
                lock={pools.locks.get(p.snapshot.pair.toLowerCase()) ?? null}
                chainTime={chainTime}
                isOpen={open === p.snapshot.pair}
                onToggle={() => setOpen((c) => (c === p.snapshot.pair ? null : p.snapshot.pair))}
                onAddMore={() => {
                  const [t0, t1] = [p.snapshot.token0, p.snapshot.token1];
                  const isW = (t: TokenInfo) => t.address.toLowerCase() === wfmx.toLowerCase();
                  onAddMore({ a: isW(t0) ? 'FMX' : t0.address, b: isW(t1) ? 'FMX' : t1.address });
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                onChanged={() => {
                  onChainChanged();
                  positions.reload();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PERCENTS = [25, 50, 75, 100] as const;

function PositionRow({
  position,
  provider,
  wallet,
  market,
  settings,
  lock,
  chainTime,
  isOpen,
  onToggle,
  onAddMore,
  onChanged,
}: {
  position: Position;
  provider: JsonRpcProvider | null;
  wallet: WalletSession;
  market: MarketData;
  settings: TradeSettings;
  lock: import('../lib/locker.ts').LockSummary | null;
  chainTime: number | null;
  isOpen: boolean;
  onToggle: () => void;
  onAddMore: () => void;
  onChanged: () => void;
}) {
  const { snapshot } = position;
  const wfmx = DEX_ADDRESSES.wfmx;
  const [percent, setPercent] = useState(50);
  const [unwrap, setUnwrap] = useState(true);
  const [lpAllowance, setLpAllowance] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<TxPhase>({ state: 'idle' });
  const hasWfmx = [snapshot.token0, snapshot.token1].some((t) => t.address.toLowerCase() === wfmx.toLowerCase());
  const tvl = poolValue(snapshot, market.prices).tvlUsdE18;
  const valueUsd = tvl !== null && snapshot.totalSupply > 0n ? (tvl * position.lpBalance) / snapshot.totalSupply : null;
  const sym = (t: TokenInfo) => (hasWfmx && unwrap ? poolSymbol(t, wfmx) : t.symbol);

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
      setLpAllowance(0n); // unreadable: ask for the approval rather than send a burn that may revert
    }
  }, [provider, wallet.address, snapshot.pair]);
  useEffect(() => {
    if (isOpen) void refreshAllowance();
  }, [isOpen, refreshAllowance]);

  const needsApproval = quote !== null && lpAllowance !== null && lpAllowance < quote.liquidity;
  const allowanceUnknown = lpAllowance === null;
  const busy = phase.state === 'signing' || phase.state === 'pending';
  const disabled = busy || !quote || !wallet.wallet || wallet.wrongChain;

  return (
    <div className={'position' + (isOpen ? ' is-open' : '')} data-testid="position">
      <button className="position-head" onClick={onToggle} aria-expanded={isOpen}>
        <PairLogos a={{ ...snapshot.token0, symbol: poolSymbol(snapshot.token0, wfmx) }} b={snapshot.token1} size={24} />
        <span className="position-main">
          <span className="position-title">
            {poolName(snapshot, wfmx)} <LockBadge lock={lock} chainTime={chainTime} />
          </span>
          <span className="position-sub mono">
            {formatAmount(position.pooled0, snapshot.token0.decimals, 4)} {poolSymbol(snapshot.token0, wfmx)} · {formatAmount(position.pooled1, snapshot.token1.decimals, 4)}{' '}
            {poolSymbol(snapshot.token1, wfmx)}
          </span>
        </span>
        <span className="position-side">
          <span className="mono">{formatUsd(valueUsd)}</span>
          <span className="mono faint small">{formatPpmPercent(position.shareOfPoolPpm, 4)} of pool</span>
        </span>
        <IconChevronDown />
      </button>
      {isOpen && (
        <div className="position-body">
          <TxStatus phase={phase} onDismiss={() => setPhase({ state: 'idle' })} />
          <div className="remove-head">
            <span className="label">Remove</span>
            <span className="remove-pct mono" data-testid="remove-pct">
              {percent}%
            </span>
          </div>
          <input
            className="slider"
            type="range"
            min={1}
            max={100}
            step={1}
            value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
            aria-label="Share of this position to remove"
            style={{ ['--pct' as string]: `${percent}%` }}
          />
          <Segmented
            value={String(PERCENTS.includes(percent as (typeof PERCENTS)[number]) ? percent : '') as string}
            options={PERCENTS.map((p) => [String(p), p === 100 ? 'Max' : `${p}%`] as const)}
            onChange={(v) => setPercent(Number(v))}
            label="Remove presets"
            size="sm"
          />
          {quote && (
            <div className="quote-body quote-flat">
              <StatRow label="LP burned" value={`${formatAmount(quote.liquidity, 18, 8)} LP`} />
              <StatRow
                label="You receive"
                value={`${formatAmount(quote.amount0, snapshot.token0.decimals, 6)} ${sym(snapshot.token0)} · ${formatAmount(quote.amount1, snapshot.token1.decimals, 6)} ${sym(snapshot.token1)}`}
                hint="Your share of the reserves as they stand now, not what you deposited."
                testId="remove-receive"
              />
              <StatRow
                label={`Minimum (${formatBpsPercent(settings.slippageBps)} slippage)`}
                value={`${formatAmount(quote.amount0Min, snapshot.token0.decimals, 6)} · ${formatAmount(quote.amount1Min, snapshot.token1.decimals, 6)}`}
              />
            </div>
          )}
          {hasWfmx && (
            <label className="check-row">
              <input type="checkbox" checked={unwrap} onChange={(e) => setUnwrap(e.target.checked)} />
              <span>Receive native FMX (unwrap WFMX on the way out)</span>
            </label>
          )}
          <div className="position-actions">
            {allowanceUnknown ? (
              <button className="btn btn-primary btn-block" disabled>
                Checking LP approval
              </button>
            ) : needsApproval ? (
              <button
                className="btn btn-primary btn-block"
                disabled={disabled}
                onClick={() =>
                  void runTx(
                    setPhase,
                    'Approve LP',
                    async () => approveLp(await ferminuxSigner(wallet.wallet!), snapshot.pair, DEX_ADDRESSES.router, quote!.liquidity),
                    'Approved the router to burn exactly those LP tokens.',
                    readableError,
                    () => void refreshAllowance(),
                  )
                }
              >
                {busy && <Spinner />} Approve LP tokens
              </button>
            ) : (
              <button
                className="btn btn-primary btn-block"
                disabled={disabled}
                data-testid="remove-action"
                onClick={() =>
                  void runTx(
                    setPhase,
                    'Remove liquidity',
                    async () =>
                      removeLiquidity(await ferminuxSigner(wallet.wallet!), DEX_ADDRESSES, snapshot, quote!, wallet.address!, settings.deadlineMinutes, {
                        unwrapNative: hasWfmx && unwrap,
                        wfmx,
                      }),
                    `Removed ${percent}% of your ${poolName(snapshot, wfmx)} position.`,
                    readableError,
                    () => {
                      onChanged();
                      void refreshAllowance();
                    },
                  )
                }
              >
                {busy && <Spinner />} Remove {percent}%
              </button>
            )}
            <button className="btn btn-block" onClick={onAddMore}>
              Add more
            </button>
          </div>
          <p className="field-hint">
            LP tokens {formatAmount(position.lpBalance, 18, 8)} · pool <span className="mono">{shortAddress(snapshot.pair)}</span>
          </p>
        </div>
      )}
    </div>
  );
}

function LockedCard({ wallet, positions, pools, chainTime }: Props) {
  if (!wallet.address) return null;
  const wfmx = DEX_ADDRESSES.wfmx;
  return (
    <section className="card" aria-labelledby="locked-h" data-testid="your-locks">
      <div className="card-head">
        <h2 id="locked-h" className="card-title-sm">
          Your locked LP
        </h2>
      </div>
      {positions.locks.length === 0 ? (
        <p className="card-pad muted small">
          None. LP tokens you lock in the LiquidityLocker appear here with their unlock date; a locked position is still yours,
          it just cannot be withdrawn early by anyone.
        </p>
      ) : (
        <ul className="rows">
          {positions.locks.map((lock) => {
            const state = lockState(lock, chainTime ?? undefined);
            const pool = pools.pairs.find((p) => p.pair.toLowerCase() === lock.token.toLowerCase());
            return (
              <li key={String(lock.id)} className="row">
                <span className="row-main">
                  <span className="row-title">
                    {pool ? poolName(pool, wfmx) : shortAddress(lock.token)}{' '}
                    <span className={'badge ' + (state === 'locked' ? 'badge-lock' : state === 'matured' ? 'badge-warn' : '')}>{state}</span>
                  </span>
                  <span className="row-sub">
                    Lock #{String(lock.id)} · unlocks {formatTimestamp(lock.unlockAt)} ({formatRelativeFuture(lock.unlockAt, chainTime ?? undefined)})
                  </span>
                </span>
                <span className="row-side mono">{formatAmount(lock.amount, 18, 6)} LP</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
