import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES, PRICE_IMPACT_CONFIRM_BPS, PRICE_IMPACT_WARN_BPS } from '../config.ts';
import { MobileHandoff } from '../components/MobileHandoff.tsx';
import { Modal, Notice, Spinner, StatRow, TxStatus, type TxPhase } from '../components/ui.tsx';
import {
  formatAmount,
  formatBpsPercent,
  formatFull,
  formatPpmPercent,
  parseAmount,
  priceFromReserves,
} from '../lib/amounts.ts';
import { maxNativeSpendable } from '../lib/gas.ts';
import { FEE_BPS } from '../lib/math.ts';
import { hopReserves } from '../lib/pairs.ts';
import {
  allowanceShortfall,
  executeSwap,
  impactLevel,
  planSwap,
  quoteSwap,
  unwrapFmx,
  wrapDirection,
  wrapFmx,
  type SwapQuote,
} from '../lib/swap.ts';
import { approveToken, sameToken, tokenKey, type TokenInfo } from '../lib/tokens.ts';
import { readableError } from '../lib/wallet.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { WalletSession } from '../state/useWallet.ts';
import { TokenSelect } from './TokenSelect.tsx';
import { DEFAULT_TRADE_SETTINGS, TradeSettings, type TradeSettingsValue } from './TradeSettings.tsx';

export function SwapPanel({
  provider,
  pools,
  wallet,
  tokens,
  balances,
  bases,
  onImportToken,
  onChainChanged,
}: {
  provider: JsonRpcProvider | null;
  pools: PoolsState;
  wallet: WalletSession;
  tokens: TokenInfo[];
  balances: Map<string, bigint>;
  /** Intermediate tokens the router may hop through. */
  bases: string[];
  onImportToken: (token: TokenInfo) => void;
  onChainChanged: () => void;
}) {
  const [tokenIn, setTokenIn] = useState<TokenInfo | null>(null);
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(null);
  const [amountText, setAmountText] = useState('');
  const [settings, setSettings] = useState<TradeSettingsValue>(DEFAULT_TRADE_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selecting, setSelecting] = useState<'in' | 'out' | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [shortfall, setShortfall] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<TxPhase>({ state: 'idle' });
  const [confirmSevere, setConfirmSevere] = useState(false);

  // ---- default selection: FMX → the first token that has a pool with it ----
  // Preloaded tokens can exist in the list without a pool (AZNT is configured
  // before anyone seeds AZNT/FMX), so prefer a counterpart that is actually
  // tradeable and only then fall back to the first ERC-20 in the list.
  useEffect(() => {
    if (tokenIn || tokens.length === 0) return;
    const native = tokens.find((t) => t.kind === 'native') ?? tokens[0];
    setTokenIn(native);
    const others = tokens.filter((t) => t.kind !== 'native' && t.symbol !== 'WFMX');
    const tradeable = others.find((t) => hopReserves(pools.index, native.address, t.address) !== null);
    setTokenOut(tradeable ?? others[0] ?? null);
  }, [tokens, tokenIn, pools.index]);

  const parsed = tokenIn ? parseAmount(amountText, tokenIn.decimals) : null;
  const amountIn = parsed?.ok ? parsed.wei : 0n;
  const wrap = tokenIn && tokenOut ? wrapDirection(tokenIn, tokenOut) : null;

  const balanceIn = tokenIn ? balances.get(tokenKey(tokenIn)) : undefined;
  const insufficient = balanceIn !== undefined && amountIn > balanceIn;

  // ---- live quote (debounced) -------------------------------------------
  useEffect(() => {
    if (!provider || !tokenIn || !tokenOut || amountIn <= 0n || wrap) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let alive = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const q = await quoteSwap(provider, DEX_ADDRESSES, pools.index, tokenIn, tokenOut, amountIn, {
          slippageBps: settings.slippageBps,
          bases,
        });
        if (!alive) return;
        setQuote(q);
        setQuoteError(null);
      } catch (err) {
        if (!alive) return;
        setQuote(null);
        setQuoteError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setQuoting(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      setQuoting(false);
    };
  }, [provider, tokenIn, tokenOut, amountIn, settings.slippageBps, pools.index, bases, wrap]);

  // ---- allowance --------------------------------------------------------
  const refreshAllowance = useCallback(async () => {
    if (!provider || !wallet.address || !tokenIn || amountIn <= 0n || wrap === 'wrap') {
      setShortfall(null);
      return;
    }
    try {
      setShortfall(await allowanceShortfall(provider, DEX_ADDRESSES, tokenIn, wallet.address, amountIn));
    } catch {
      setShortfall(null);
    }
  }, [provider, wallet.address, tokenIn, amountIn, wrap]);

  useEffect(() => {
    void refreshAllowance();
  }, [refreshAllowance]);

  // WFMX unwrap needs no allowance (it burns the caller's own balance).
  const needsApproval = wrap === null && shortfall !== null && shortfall > 0n;

  const spot = useMemo(() => {
    if (!tokenIn || !tokenOut) return null;
    if (wrap) return '1';
    const hop = hopReserves(pools.index, tokenIn.address, tokenOut.address);
    if (!hop) return null;
    return priceFromReserves(hop.reserveIn, tokenIn.decimals, hop.reserveOut, tokenOut.decimals, 6);
  }, [pools.index, tokenIn, tokenOut, wrap]);

  const level = quote ? impactLevel(quote.priceImpactBps) : 'ok';

  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountText('');
    setQuote(null);
  };

  const setMax = async () => {
    if (!tokenIn || balanceIn === undefined) return;
    if (tokenIn.kind !== 'native') {
      setAmountText(formatFull(balanceIn, tokenIn.decimals));
      return;
    }
    let maxFee: bigint | null = null;
    try {
      maxFee = (await provider?.getFeeData())?.maxFeePerGas ?? null;
    } catch {
      maxFee = null;
    }
    setAmountText(formatFull(maxNativeSpendable(balanceIn, maxFee), tokenIn.decimals));
  };

  const runTx = async (
    send: () => Promise<{ hash: string; wait: () => Promise<unknown> }>,
    doneMessage: string,
  ) => {
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

  const doApprove = async () => {
    if (!wallet.wallet || !tokenIn) return;
    await runTx(
      () => approveToken(wallet.wallet!.signer, tokenIn, DEX_ADDRESSES.router, amountIn),
      `Approved ${formatAmount(amountIn, tokenIn.decimals)} ${tokenIn.symbol} for the router.`,
    );
  };

  const doSwap = async () => {
    if (!wallet.wallet || !quote || !wallet.address) return;
    setConfirmSevere(false);
    await runTx(
      () => executeSwap(wallet.wallet!.signer, DEX_ADDRESSES, quote, wallet.address!, settings.deadlineMinutes),
      `Swapped ${formatAmount(quote.amountIn, quote.tokenIn.decimals)} ${quote.tokenIn.symbol} for ${formatAmount(
        quote.amountOut,
        quote.tokenOut.decimals,
      )} ${quote.tokenOut.symbol}.`,
    );
    setAmountText('');
    setQuote(null);
  };

  const doWrap = async () => {
    if (!wallet.wallet || !tokenIn || amountIn <= 0n) return;
    if (wrap === 'wrap') {
      await runTx(
        () => wrapFmx(wallet.wallet!.signer, DEX_ADDRESSES, amountIn),
        `Wrapped ${formatAmount(amountIn, 18)} FMX into WFMX.`,
      );
    } else {
      await runTx(
        () => unwrapFmx(wallet.wallet!.signer, DEX_ADDRESSES, amountIn),
        `Unwrapped ${formatAmount(amountIn, 18)} WFMX back into FMX.`,
      );
    }
    setAmountText('');
  };

  const busy = phase.state === 'signing' || phase.state === 'pending';
  const canTrade = Boolean(wallet.wallet) && !wallet.wrongChain;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Swap</h2>
          <span className="spacer" />
          <button
            className={'btn btn-ghost btn-sm' + (settingsOpen ? ' is-on' : '')}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            {formatBpsPercent(settings.slippageBps)} slippage · {settings.deadlineMinutes}m
          </button>
        </div>

        {settingsOpen && (
          <div className="panel-inset">
            <TradeSettings value={settings} onChange={setSettings} idPrefix="swap" />
          </div>
        )}

        <div className="panel-body">
          <TxStatus phase={phase} onDismiss={() => setPhase({ state: 'idle' })} />

          {/* ---------------- sell ---------------- */}
          <div className="amount-box">
            <div className="amount-head">
              <span>You pay</span>
              <span className="push">
                {balanceIn !== undefined && tokenIn ? (
                  <>
                    Balance <span className="num">{formatAmount(balanceIn, tokenIn.decimals, 6)}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => void setMax()}>
                      Max
                    </button>
                  </>
                ) : null}
              </span>
            </div>
            <div className="amount-row">
              <input
                className="amount-input num"
                inputMode="decimal"
                placeholder="0.0"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-label="Amount to sell"
              />
              <button className="token-button" onClick={() => setSelecting('in')} disabled={tokens.length === 0}>
                {tokenIn ? tokenIn.symbol : 'Select'} <span className="caret">▾</span>
              </button>
            </div>
            {parsed && !parsed.ok && amountText.trim() !== '' && <p className="field-error">{parsed.error}</p>}
            {insufficient && tokenIn && (
              <p className="field-error">
                More than your {tokenIn.symbol} balance.
                {tokenIn.kind === 'native' && ' Leave some FMX for gas, too.'}
              </p>
            )}
          </div>

          <div className="flip-row">
            <button className="flip-btn" onClick={flip} aria-label="Swap the two tokens" disabled={!tokenIn || !tokenOut}>
              ↓
            </button>
          </div>

          {/* ---------------- buy ---------------- */}
          <div className="amount-box">
            <div className="amount-head">
              <span>You receive</span>
              <span className="push">
                {tokenOut && balances.get(tokenKey(tokenOut)) !== undefined && (
                  <>
                    Balance{' '}
                    <span className="num">{formatAmount(balances.get(tokenKey(tokenOut))!, tokenOut.decimals, 6)}</span>
                  </>
                )}
              </span>
            </div>
            <div className="amount-row">
              <div className="amount-output num" aria-live="polite">
                {wrap && amountIn > 0n ? (
                  formatAmount(amountIn, 18, 8)
                ) : quoting && !quote ? (
                  <Spinner />
                ) : quote ? (
                  formatAmount(quote.amountOut, quote.tokenOut.decimals, 8)
                ) : (
                  <span className="muted">0.0</span>
                )}
              </div>
              <button className="token-button" onClick={() => setSelecting('out')} disabled={tokens.length === 0}>
                {tokenOut ? tokenOut.symbol : 'Select'} <span className="caret">▾</span>
              </button>
            </div>
          </div>

          {/* ---------------- wrap notice ---------------- */}
          {wrap && (
            <Notice kind="warn">
              FMX and WFMX are the same coin: WFMX is the ERC-20 wrapper the pools hold. This is a{' '}
              {wrap === 'wrap' ? 'wrap' : 'unwrap'} at exactly 1:1 — no pool, no fee, no price impact, no slippage
              setting involved.
            </Notice>
          )}

          {/* ---------------- quote detail ---------------- */}
          {quoteError && !wrap && amountIn > 0n && (
            <Notice kind="danger" role="alert">
              {quoteError}
            </Notice>
          )}

          {quote && !wrap && (
            <div className="quote-box">
              <StatRow
                label="Rate"
                value={
                  <>
                    1 {quote.tokenIn.symbol} ={' '}
                    {priceFromReserves(quote.amountIn, quote.tokenIn.decimals, quote.amountOut, quote.tokenOut.decimals, 6) ??
                      '—'}{' '}
                    {quote.tokenOut.symbol}
                  </>
                }
                hint="The average price this trade actually fills at, fee and impact included."
              />
              {spot && (
                <StatRow
                  label="Pool price"
                  value={
                    <>
                      1 {quote.tokenIn.symbol} = {spot} {quote.tokenOut.symbol}
                    </>
                  }
                  hint="The ratio the pool holds right now, before your trade moves it."
                />
              )}
              <StatRow
                label="Price impact"
                value={formatPpmPercent(quote.priceImpactPpm)}
                tone={level === 'severe' ? 'danger' : level === 'warn' ? 'warn' : undefined}
                hint="How far below the current pool ratio this trade fills, including the 0.30% fee per hop."
              />
              <StatRow
                label={`Minimum received (${formatBpsPercent(quote.slippageBps)} slippage)`}
                value={
                  <>
                    {formatAmount(quote.minimumReceived, quote.tokenOut.decimals, 8)} {quote.tokenOut.symbol}
                  </>
                }
                hint="The router reverts rather than settle below this."
              />
              <StatRow
                label="Liquidity provider fee"
                value={`${(quote.totalFeeBps / 100).toFixed(2)}% (${quote.route.hops.length} × ${FEE_BPS} bps)`}
                hint="Charged on the input and left in the pool — it goes to liquidity providers, not to the protocol."
              />
              <StatRow
                label="Route"
                value={
                  <span className="route-line">
                    {quote.route.path.map((address, i) => {
                      const token =
                        i === 0
                          ? quote.tokenIn
                          : i === quote.route.path.length - 1
                            ? quote.tokenOut
                            : (tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? null);
                      return (
                        <span key={`${address}-${i}`}>
                          {i > 0 && <span className="route-arrow">→</span>}
                          {token ? token.symbol : address.slice(0, 8)}
                        </span>
                      );
                    })}
                  </span>
                }
                hint={
                  quote.route.hops.length > 1
                    ? 'Two pools: the fee and the impact are paid in each of them.'
                    : 'A single pool.'
                }
              />
              {!quote.localMatchesChain && (
                <p className="field-hint">
                  Reserves moved while quoting — the figures above are the router's own, re-read just now.
                </p>
              )}
            </div>
          )}

          {quote && level === 'warn' && (
            <Notice kind="warn">
              Price impact {formatPpmPercent(quote.priceImpactPpm)}. This pool is shallow relative to your trade — you
              are moving the price against yourself by more than {PRICE_IMPACT_WARN_BPS / 100}%. A smaller trade fills
              closer to the pool price.
            </Notice>
          )}
          {quote && level === 'severe' && (
            <Notice kind="danger">
              Price impact {formatPpmPercent(quote.priceImpactPpm)} — you would lose roughly{' '}
              {formatPpmPercent(quote.priceImpactPpm)} of your money to this trade the moment it settles. Anything above{' '}
              {PRICE_IMPACT_CONFIRM_BPS / 100}% needs a typed confirmation below.
            </Notice>
          )}

          {/* ---------------- actions ---------------- */}
          <div className="action-stack">
            {!wallet.hasInjected && (
              <MobileHandoff
                hasInjected={wallet.hasInjected}
                lede="Browsing pools and prices needs no wallet; trading does."
              />
            )}
            {wallet.hasInjected && !wallet.wallet && (
              <button className="btn btn-primary btn-block btn-lg" onClick={() => void wallet.connect()} disabled={wallet.connecting}>
                {wallet.connecting ? <Spinner /> : null} Connect wallet
              </button>
            )}
            {wallet.wallet && wallet.wrongChain && (
              <button className="btn btn-primary btn-block btn-lg" onClick={() => void wallet.switchChain()}>
                Switch to Ferminux (3961)
              </button>
            )}

            {canTrade && wrap && (
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={busy || amountIn <= 0n || insufficient}
                onClick={() => void doWrap()}
              >
                {busy ? <Spinner /> : null} {wrap === 'wrap' ? 'Wrap FMX' : 'Unwrap WFMX'}
              </button>
            )}

            {canTrade && !wrap && needsApproval && (
              <button className="btn btn-block btn-lg" disabled={busy || !quote} onClick={() => void doApprove()}>
                {busy ? <Spinner /> : null} Approve {tokenIn?.symbol}
              </button>
            )}

            {canTrade && !wrap && (
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={busy || !quote || needsApproval || insufficient}
                onClick={() => (level === 'severe' ? setConfirmSevere(true) : void doSwap())}
              >
                {busy ? <Spinner /> : null}
                {!quote ? 'Enter an amount' : needsApproval ? `Approve ${tokenIn?.symbol} first` : 'Swap'}
              </button>
            )}

            {canTrade && !wrap && needsApproval && tokenIn && shortfall !== null && (
              <p className="field-hint">
                The router can currently move {formatAmount(amountIn - shortfall, tokenIn.decimals)} {tokenIn.symbol} on
                your behalf. Approving grants it exactly {formatAmount(amountIn, tokenIn.decimals)} {tokenIn.symbol} —
                this trade and nothing more.
              </p>
            )}
          </div>
        </div>
      </section>

      {selecting && (
        <TokenSelect
          tokens={tokens}
          balances={balances}
          provider={provider}
          exclude={selecting === 'in' ? tokenOut : tokenIn}
          onImport={onImportToken}
          onSelect={(token) => {
            if (selecting === 'in') {
              if (sameToken(token, tokenOut)) setTokenOut(tokenIn);
              setTokenIn(token);
            } else {
              if (sameToken(token, tokenIn)) setTokenIn(tokenOut);
              setTokenOut(token);
            }
            setSelecting(null);
            setQuote(null);
          }}
          onClose={() => setSelecting(null)}
        />
      )}

      {confirmSevere && quote && (
        <SevereImpactConfirm quote={quote} onCancel={() => setConfirmSevere(false)} onConfirm={() => void doSwap()} />
      )}
    </>
  );
}

/**
 * Above 10% impact the trade is not a mistake the UI can round away — the
 * trader is paying a tenth of their money to move a shallow pool. The
 * confirmation is deliberately typed, not a second click.
 */
function SevereImpactConfirm({
  quote,
  onCancel,
  onConfirm,
}: {
  quote: SwapQuote;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const plan = planSwap(quote, 20);
  return (
    <Modal title="High price impact" onClose={onCancel}>
      <Notice kind="danger">
        This trade fills {formatPpmPercent(quote.priceImpactPpm)} below the pool's current price. That is not a fee you
        pay to anyone — it is the pool's price moving because you are taking a large fraction of its depth.
      </Notice>
      <StatRow
        label="You pay"
        value={`${formatAmount(quote.amountIn, quote.tokenIn.decimals, 8)} ${quote.tokenIn.symbol}`}
      />
      <StatRow
        label="You receive (quoted)"
        value={`${formatAmount(quote.amountOut, quote.tokenOut.decimals, 8)} ${quote.tokenOut.symbol}`}
      />
      <StatRow
        label="Minimum received"
        value={`${formatAmount(quote.minimumReceived, quote.tokenOut.decimals, 8)} ${quote.tokenOut.symbol}`}
      />
      <StatRow label="Price impact" value={formatPpmPercent(quote.priceImpactPpm)} tone="danger" />
      <StatRow label="Router call" value={plan.method} />
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="impact-confirm">
          Type <strong>I understand</strong> to continue.
        </label>
        <input
          id="impact-confirm"
          className="input"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          placeholder="I understand"
        />
      </div>
      <div className="actions-row">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn btn-primary push"
          disabled={typed.trim().toLowerCase() !== 'i understand'}
          onClick={onConfirm}
        >
          Swap anyway
        </button>
      </div>
    </Modal>
  );
}
