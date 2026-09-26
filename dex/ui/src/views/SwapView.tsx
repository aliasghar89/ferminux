import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES, PRICE_IMPACT_CONFIRM_BPS, PRICE_IMPACT_WARN_BPS, isCanonicalToken } from '../config.ts';
import { Modal, Notice, Spinner, StatRow, TxStatus, runTx, type TxPhase } from '../components/ui.tsx';
import { RouteTrace, TokenAmountField, routeTokens } from '../components/TradeParts.tsx';
import { IconArrowDown, IconChevronDown, IconSettings, IconSwap } from '../components/icons.tsx';
import {
  formatAmount,
  formatBpsPercent,
  formatFull,
  formatPpmPercent,
  parseAmount,
  priceFromReserves,
  shortAddress,
} from '../lib/amounts.ts';
import { maxNativeSpendable } from '../lib/gas.ts';
import { FEE_BPS } from '../lib/math.ts';
import { linkedPair, type DexLink } from '../lib/deeplink.ts';
import { E18, formatUsd, formatUsdPrice, valueUsdE18, type PriceTable } from '../lib/prices.ts';
import { hasRoute } from '../lib/route.ts';
import { isListed } from '../lib/tokenlist.ts';
import {
  executeSwap,
  impactLevel,
  planSwap,
  quoteSwap,
  unwrapFmx,
  wrapDirection,
  wrapFmx,
  type SwapQuote,
} from '../lib/swap.ts';
import {
  MAX_UINT256,
  approveToken,
  fetchAllowance,
  isUnlimitedAllowance,
  sameToken,
  tokenKey,
  type TokenInfo,
} from '../lib/tokens.ts';
import { ferminuxSigner, readableError } from '../lib/wallet.ts';
import type { MarketData } from '../state/useMarket.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { TradeSettings } from '../state/useSettings.ts';
import type { WalletSession } from '../state/useWallet.ts';
import type { Page } from '../state/useRoute.ts';
import { TokenPicker } from './TokenPicker.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { FmxPriceCard } from './ChartsView.tsx';
import { MarketsList } from './MarketsList.tsx';

function usdText(prices: PriceTable, token: TokenInfo | null, amount: bigint): string | null {
  if (!token || amount <= 0n) return null;
  const b = prices.get(token.address.toLowerCase());
  return b ? `≈ ${formatUsd(valueUsdE18(amount, token.decimals, b.usdE18))}` : null;
}

export function SwapView(props: {
  provider: JsonRpcProvider | null;
  pools: PoolsState;
  market: MarketData;
  wallet: WalletSession;
  tokens: TokenInfo[];
  balances: Map<string, bigint>;
  settings: TradeSettings;
  onSettings: (s: TradeSettings) => void;
  link?: DexLink;
  onImportToken: (token: TokenInfo) => void;
  onChainChanged: () => void;
  navigate: (to: { page: Page; pool?: string | null }) => void;
}) {
  return (
    <div className="page page-swap">
      <div className="swap-layout">
        <div className="swap-main">
          <SwapCard {...props} />
        </div>
        <div className="swap-side">
          <FmxPriceCard market={props.market} pools={props.pools} compact />
          <MarketsList pools={props.pools} market={props.market} navigate={props.navigate} />
        </div>
      </div>
    </div>
  );
}

function SwapCard({
  provider,
  pools,
  market,
  wallet,
  tokens,
  balances,
  settings,
  onSettings,
  link,
  onImportToken,
  onChainChanged,
}: Parameters<typeof SwapView>[0]) {
  const [tokenIn, setTokenIn] = useState<TokenInfo | null>(null);
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(null);
  const [amountText, setAmountText] = useState('');
  const [picking, setPicking] = useState<'in' | 'out' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rawQuote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // The router allowance, tagged with the account and token it was read for:
  // an unknown allowance is never taken as enough.
  const [allowanceRead, setAllowanceRead] = useState<{ key: string; value: bigint } | null>(null);
  const [phase, setPhase] = useState<TxPhase>({ state: 'idle' });
  const [reviewing, setReviewing] = useState(false);
  // What the trader saw when the review opened: a re-quote that pays less must be accepted again.
  const [reviewedOut, setReviewedOut] = useState<bigint | null>(null);
  const [invert, setInvert] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  // True until the trader picks a token: the selection is the app's default
  // (or the deep link's) and is re-chosen as the pools arrive.
  const [autoSelect, setAutoSelect] = useState(true);

  useEffect(() => {
    if (!autoSelect || tokens.length === 0) return;
    const native = tokens.find((t) => t.kind === 'native') ?? tokens[0];
    const counterpart = (from: TokenInfo): TokenInfo | null => {
      const others = tokens.filter((t) => t.kind !== 'native' && t.address.toLowerCase() !== from.address.toLowerCase());
      const prefer = ['USDF', 'AZNT'];
      const routable = others.filter((t) => hasRoute(pools.index, from.address, t.address, { maxHops: settings.maxHops }));
      for (const sym of prefer) {
        const hit = routable.find((t) => t.symbol === sym && isCanonicalToken(t.address));
        if (hit) return hit;
      }
      return routable[0] ?? others.find((t) => isCanonicalToken(t.address)) ?? others[0] ?? null;
    };
    const trusted = (t: TokenInfo) =>
      t.kind === 'native' || t.address.toLowerCase() === DEX_ADDRESSES.wfmx.toLowerCase() || isCanonicalToken(t.address);
    const linked = link ? linkedPair(link, tokens, trusted, counterpart) : null;
    const nextIn = linked?.tokenIn ?? native;
    const nextOut = linked ? linked.tokenOut : counterpart(native);
    if (!sameToken(nextIn, tokenIn)) setTokenIn(nextIn);
    if (!sameToken(nextOut, tokenOut) && !(nextOut === null && tokenOut === null)) setTokenOut(nextOut);
    if (pools.status === 'ready') setAutoSelect(false);
  }, [tokens, pools.index, pools.status, autoSelect, link, tokenIn, tokenOut, settings.maxHops]);

  const parsed = tokenIn && amountText.trim() !== '' ? parseAmount(amountText, tokenIn.decimals) : null;
  const amountIn = parsed?.ok ? parsed.wei : 0n;
  const wrap = tokenIn && tokenOut ? wrapDirection(tokenIn, tokenOut) : null;
  const balanceIn = tokenIn ? balances.get(tokenKey(tokenIn)) : undefined;
  const balanceOut = tokenOut ? balances.get(tokenKey(tokenOut)) : undefined;
  const insufficient = balanceIn !== undefined && amountIn > balanceIn;
  // Only a quote for exactly what is on screen may be shown or signed: while a
  // new amount is being quoted, the previous quote is withheld, never reused.
  const quote =
    rawQuote && tokenIn && tokenOut && rawQuote.amountIn === amountIn && rawQuote.slippageBps === settings.slippageBps && sameToken(rawQuote.tokenIn, tokenIn) && sameToken(rawQuote.tokenOut, tokenOut)
      ? rawQuote
      : null;

  // ---- live quote: debounced on typing, re-run on every pool refresh ------
  useEffect(() => {
    if (!provider || !tokenIn || !tokenOut || amountIn <= 0n || wrap) {
      setQuote(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }
    let alive = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const q = await quoteSwap(provider, DEX_ADDRESSES, pools.index, tokenIn, tokenOut, amountIn, {
          slippageBps: settings.slippageBps,
          maxHops: settings.maxHops,
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
    };
  }, [provider, tokenIn, tokenOut, amountIn, settings.slippageBps, settings.maxHops, pools.index, wrap]);

  // ---- allowance ----------------------------------------------------------
  const allowanceKey = wallet.address && tokenIn ? `${wallet.address.toLowerCase()}:${tokenKey(tokenIn)}` : '';
  const refreshAllowance = useCallback(async () => {
    if (!provider || !wallet.address || !tokenIn || tokenIn.kind === 'native' || wrap) return;
    const key = `${wallet.address.toLowerCase()}:${tokenKey(tokenIn)}`;
    try {
      setAllowanceRead({ key, value: await fetchAllowance(provider, tokenIn, wallet.address, DEX_ADDRESSES.router) });
    } catch {
      // Unreadable: ask for an approval rather than send a swap that may revert.
      setAllowanceRead({ key, value: 0n });
    }
  }, [provider, wallet.address, tokenIn, wrap]);
  useEffect(() => {
    void refreshAllowance();
  }, [refreshAllowance]);

  const allowance = allowanceRead && allowanceRead.key === allowanceKey ? allowanceRead.value : null;
  const allowanceUnknown = !wrap && tokenIn?.kind === 'erc20' && Boolean(wallet.address) && allowance === null;
  const needsApproval = !wrap && tokenIn?.kind === 'erc20' && allowance !== null && amountIn > 0n && allowance < amountIn;
  const level = quote ? impactLevel(quote.priceImpactBps) : 'ok';
  const busy = phase.state === 'signing' || phase.state === 'pending';
  const canTrade = Boolean(wallet.wallet) && !wallet.wrongChain;
  // A wallet that leaves Ferminux closes the review: it must not come back armed after a switch.
  useEffect(() => {
    if (!canTrade) setReviewing(false);
  }, [canTrade]);

  const outText = wrap
    ? amountIn > 0n
      ? formatFull(amountIn, 18)
      : ''
    : quote
      ? formatAmount(quote.amountOut, quote.tokenOut.decimals, 8).replace(/,/g, '')
      : '';

  // Rate and the FMX-in-USD this fill implies (when one side is FMX and the other has a peg).
  const rate = useMemo(() => {
    if (!quote) return null;
    const [a, b, amtA, amtB] = invert
      ? [quote.tokenOut, quote.tokenIn, quote.amountOut, quote.amountIn]
      : [quote.tokenIn, quote.tokenOut, quote.amountIn, quote.amountOut];
    const text = priceFromReserves(amtA, a.decimals, amtB, b.decimals, 6);
    return text ? `1 ${a.symbol} = ${text} ${b.symbol}` : null;
  }, [quote, invert]);

  const fmxFill = useMemo(() => {
    if (!quote) return null;
    const w = DEX_ADDRESSES.wfmx.toLowerCase();
    const isFmx = (t: TokenInfo) => t.address.toLowerCase() === w;
    const peg = (t: TokenInfo) => market.pegs.get(t.address.toLowerCase());
    let fmxAmount: bigint;
    let other: TokenInfo;
    let otherAmount: bigint;
    if (isFmx(quote.tokenIn) && !isFmx(quote.tokenOut)) [fmxAmount, other, otherAmount] = [quote.amountIn, quote.tokenOut, quote.amountOut];
    else if (isFmx(quote.tokenOut) && !isFmx(quote.tokenIn)) [fmxAmount, other, otherAmount] = [quote.amountOut, quote.tokenIn, quote.amountIn];
    else return null;
    const p = peg(other);
    if (!p || p.kind !== 'peg' || fmxAmount <= 0n) return null;
    const usd = valueUsdE18(otherAmount, other.decimals, p.usdE18);
    return (usd * E18) / fmxAmount;
  }, [quote, market.pegs]);
  const official = market.pegs.get(DEX_ADDRESSES.wfmx.toLowerCase())?.usdE18 ?? null;
  const fillOff = fmxFill !== null && official !== null && official > 0n ? Number(((fmxFill - official) * 10_000n) / official) / 100 : null;

  const flip = () => {
    setAutoSelect(false);
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountText(quote && !wrap ? formatFull(quote.amountOut, quote.tokenOut.decimals) : amountText);
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

  const after = () => {
    onChainChanged();
    void refreshAllowance();
  };

  const doApprove = async () => {
    if (!wallet.wallet || !tokenIn) return;
    const amount = settings.unlimitedApprovals ? MAX_UINT256 : amountIn;
    await runTx(
      setPhase,
      `Approve ${tokenIn.symbol}`,
      async () => approveToken(await ferminuxSigner(wallet.wallet!), tokenIn, DEX_ADDRESSES.router, amount),
      settings.unlimitedApprovals
        ? `Approved the router for unlimited ${tokenIn.symbol}.`
        : `Approved the router for exactly ${formatAmount(amountIn, tokenIn.decimals)} ${tokenIn.symbol}.`,
      readableError,
      after,
    );
  };

  const doSwap = async () => {
    if (!wallet.wallet || !quote || !wallet.address) return;
    if (reviewedOut !== null && quote.amountOut < reviewedOut) return; // the review asks to accept the new price first
    setReviewing(false);
    const ok = await runTx(
      setPhase,
      'Swap',
      async () => executeSwap(await ferminuxSigner(wallet.wallet!), DEX_ADDRESSES, quote, wallet.address!, settings.deadlineMinutes),
      `Swapped ${formatAmount(quote.amountIn, quote.tokenIn.decimals)} ${quote.tokenIn.symbol} for ${formatAmount(quote.amountOut, quote.tokenOut.decimals)} ${quote.tokenOut.symbol}.`,
      readableError,
      after,
    );
    if (ok) {
      setAmountText('');
      setQuote(null);
    }
  };

  const doWrap = async () => {
    if (!wallet.wallet || amountIn <= 0n) return;
    const ok = await runTx(
      setPhase,
      wrap === 'wrap' ? 'Wrap' : 'Unwrap',
      async () => {
        const signer = await ferminuxSigner(wallet.wallet!);
        return wrap === 'wrap' ? wrapFmx(signer, DEX_ADDRESSES, amountIn) : unwrapFmx(signer, DEX_ADDRESSES, amountIn);
      },
      wrap === 'wrap' ? `Wrapped ${formatAmount(amountIn, 18)} FMX into WFMX.` : `Unwrapped ${formatAmount(amountIn, 18)} WFMX into FMX.`,
      readableError,
      after,
    );
    if (ok) setAmountText('');
  };

  // ---- the one primary action --------------------------------------------
  let action: { label: string; onClick?: () => void; disabled: boolean; kind: 'primary' | 'secondary' } = {
    label: 'Enter an amount',
    disabled: true,
    kind: 'primary',
  };
  if (!wallet.wallet) action = { label: wallet.connecting ? 'Connecting' : 'Connect wallet', onClick: wallet.connect, disabled: wallet.connecting, kind: 'primary' };
  else if (wallet.wrongChain) action = { label: 'Switch to Ferminux', onClick: () => void wallet.switchChain(), disabled: false, kind: 'primary' };
  else if (!tokenIn || !tokenOut) action = { label: 'Select a token', disabled: true, kind: 'primary' };
  else if (parsed && !parsed.ok) action = { label: 'Enter a valid amount', disabled: true, kind: 'primary' };
  else if (amountIn <= 0n) action = { label: 'Enter an amount', disabled: true, kind: 'primary' };
  else if (insufficient) action = { label: `Not enough ${tokenIn.symbol}`, disabled: true, kind: 'primary' };
  else if (wrap) action = { label: wrap === 'wrap' ? 'Wrap FMX' : 'Unwrap WFMX', onClick: () => void doWrap(), disabled: busy, kind: 'primary' };
  else if (quoteError) action = { label: /No pool route/.test(quoteError) ? 'No route for this pair' : 'Cannot quote this trade', disabled: true, kind: 'primary' };
  else if (!quote) action = { label: 'Fetching the best route', disabled: true, kind: 'primary' };
  else if (allowanceUnknown) action = { label: `Checking ${tokenIn.symbol} approval`, disabled: true, kind: 'primary' };
  else if (needsApproval) action = { label: `Approve ${tokenIn.symbol}`, onClick: () => void doApprove(), disabled: busy, kind: 'primary' };
  else {
    const reviewed = quote.amountOut;
    action = {
      label: level === 'severe' ? 'Review high-impact swap' : 'Review swap',
      onClick: () => {
        setReviewedOut(reviewed);
        setReviewing(true);
      },
      disabled: busy,
      kind: 'primary',
    };
  }

  const pickerSelect = (token: TokenInfo) => {
    setAutoSelect(false);
    if (picking === 'in') {
      if (sameToken(token, tokenOut)) setTokenOut(tokenIn);
      setTokenIn(token);
    } else {
      if (sameToken(token, tokenIn)) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setPicking(null);
    setQuote(null);
  };

  const inError =
    parsed && !parsed.ok ? parsed.error : insufficient && tokenIn ? `More than your ${tokenIn.symbol} balance.${tokenIn.kind === 'native' ? ' Keep some FMX for the fee, too.' : ''}` : null;

  return (
    <section className="card swap-card" aria-labelledby="swap-h" data-testid="swap-card">
      <div className="card-head">
        <h1 id="swap-h" className="card-title">
          Swap
        </h1>
        <span className="spacer" />
        <button className="settings-btn" onClick={() => setSettingsOpen(true)} aria-label={`Trade settings: ${formatBpsPercent(settings.slippageBps)} slippage, ${settings.deadlineMinutes} minute deadline`} data-testid="settings-btn">
          <span className="mono">{formatBpsPercent(settings.slippageBps)}</span>
          <IconSettings />
        </button>
      </div>

      <TxStatus phase={phase} onDismiss={() => setPhase({ state: 'idle' })} />

      <div className="swap-fields">
        <TokenAmountField
          label="You pay"
          token={tokenIn}
          onPickToken={() => setPicking('in')}
          value={amountText}
          onChange={setAmountText}
          balance={balanceIn}
          onMax={() => void setMax()}
          usd={usdText(market.prices, tokenIn, amountIn)}
          error={inError}
          testId="field-in"
        />
        <button type="button" className="flip-btn" onClick={flip} aria-label="Switch the two tokens" disabled={!tokenIn || !tokenOut} data-testid="flip">
          <IconArrowDown />
        </button>
        <TokenAmountField
          label="You receive"
          token={tokenOut}
          onPickToken={() => setPicking('out')}
          value={outText}
          readOnly
          pending={quoting && !quote}
          balance={balanceOut}
          usd={quote ? usdText(market.prices, quote.tokenOut, quote.amountOut) : wrap ? usdText(market.prices, tokenOut, amountIn) : null}
          testId="field-out"
        />
      </div>

      {wrap && amountIn > 0n && (
        <Notice>
          FMX and WFMX are the same coin: WFMX is the FRC-20 wrapper the pools hold. This {wrap} is exactly 1:1 through
          the wrapper contract. No pool, no fee, no price impact.
        </Notice>
      )}

      {quoteError && !wrap && amountIn > 0n && (
        <Notice kind="danger" role="alert">
          {quoteError}
        </Notice>
      )}

      {quote && !wrap && (
        <div className="quote" data-testid="quote">
          <div className="quote-head">
            <button className="rate-btn mono" onClick={() => setInvert((v) => !v)} aria-label="Flip the rate" data-testid="rate">
              {rate ?? '—'}
              <IconSwap />
            </button>
            <button className="quote-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
              <span className={'impact-chip impact-' + level}>{formatPpmPercent(quote.priceImpactPpm)} impact</span>
              <IconChevronDown />
            </button>
          </div>
          {detailsOpen && (
            <div className="quote-body">
              <StatRow
                label="Price impact"
                value={formatPpmPercent(quote.priceImpactPpm)}
                tone={level === 'severe' ? 'danger' : level === 'warn' ? 'warn' : undefined}
                hint="How far below the pools' current price this trade fills, the 0.30% fee per pool included."
                testId="row-impact"
              />
              <StatRow
                label={`Minimum received (${formatBpsPercent(quote.slippageBps)} slippage)`}
                value={`${formatAmount(quote.minimumReceived, quote.tokenOut.decimals, 8)} ${quote.tokenOut.symbol}`}
                hint="The router reverts rather than settle below this."
                testId="row-min"
              />
              <StatRow
                label="Liquidity provider fee"
                value={`${(quote.totalFeeBps / 100).toFixed(2)}% · ${quote.route.hops.length} × ${FEE_BPS} bps`}
                hint="Charged on the input of each pool and left there for its liquidity providers."
                testId="row-fee"
              />
              {fmxFill !== null && (
                <StatRow
                  label="FMX price in this fill"
                  value={
                    <>
                      {formatUsdPrice(fmxFill)}
                      {fillOff !== null && Math.abs(fillOff) >= 1 && (
                        <span className="faint"> · {fillOff > 0 ? '+' : ''}{fillOff.toFixed(1)}% vs official</span>
                      )}
                    </>
                  }
                  hint="The USD per FMX this trade pays or receives, through the paired token's peg, fee and impact included."
                />
              )}
              <div className="route-row">
                <span className="stat-label">
                  Route · {quote.route.hops.length} pool{quote.route.hops.length === 1 ? '' : 's'}
                </span>
                <RouteTrace tokens={routeTokens(quote.route.path, quote.tokenIn, quote.tokenOut, tokens)} testId="route" />
                <span className="route-note faint">
                  Best of {quote.routesConsidered} path{quote.routesConsidered === 1 ? '' : 's'} over every pool,
                  {quote.alternatives.length > 0 ? ` ${quote.alternatives.length + 1} re-priced by the router.` : ' priced by the router.'}
                  {!quote.localMatchesChain && ' Reserves moved while quoting: these are the router’s numbers.'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {quote && level === 'warn' && (
        <Notice kind="warn" title={`Price impact ${formatPpmPercent(quote.priceImpactPpm)}`}>
          The pools are shallow for this size: you move the price against yourself by more than {PRICE_IMPACT_WARN_BPS / 100}%. A
          smaller trade fills closer to the pool price.
        </Notice>
      )}
      {quote && level === 'severe' && (
        <Notice kind="danger" title={`Price impact ${formatPpmPercent(quote.priceImpactPpm)}`}>
          You would give up about {formatPpmPercent(quote.priceImpactPpm)} of this trade to the pool&rsquo;s price moving. Above{' '}
          {PRICE_IMPACT_CONFIRM_BPS / 100}% the review asks you to type a confirmation.
        </Notice>
      )}

      {needsApproval && canTrade && tokenIn && (
        <div className="approve-steps" data-testid="approve-steps">
          <ol className="steps">
            <li className="is-current">
              <span className="step-n mono">1</span> Approve {tokenIn.symbol}
            </li>
            <li>
              <span className="step-n mono">2</span> Swap
            </li>
          </ol>
          <p className="field-hint">
            {settings.unlimitedApprovals ? (
              <>
                Unlimited approval is on: the router may move any amount of {tokenIn.symbol} from this wallet until you
                revoke it.{' '}
              </>
            ) : (
              <>
                The router may move exactly {formatAmount(amountIn, tokenIn.decimals)} {tokenIn.symbol}, this trade and
                nothing more.{' '}
              </>
            )}
            {allowance !== null && allowance > 0n && (
              <>Currently approved: {isUnlimitedAllowance(allowance) ? 'unlimited' : formatAmount(allowance, tokenIn.decimals)}. </>
            )}
            <button className="link-btn" onClick={() => setSettingsOpen(true)}>
              Change
            </button>
          </p>
        </div>
      )}

      <button
        className={'btn btn-lg btn-block ' + (action.kind === 'primary' ? 'btn-primary' : '')}
        disabled={action.disabled}
        onClick={action.onClick}
        data-testid="swap-action"
      >
        {busy && <Spinner />}
        {action.label}
      </button>

      {picking && (
        <TokenPicker
          tokens={tokens}
          balances={balances}
          prices={market.prices}
          provider={provider}
          selected={picking === 'in' ? tokenIn : tokenOut}
          other={picking === 'in' ? tokenOut : tokenIn}
          onImport={onImportToken}
          onSelect={pickerSelect}
          onClose={() => setPicking(null)}
        />
      )}
      {settingsOpen && <SettingsModal value={settings} onChange={onSettings} onClose={() => setSettingsOpen(false)} />}
      {reviewing && quote && canTrade && (
        <ReviewSwap
          quote={quote}
          tokens={tokens}
          prices={market.prices}
          settings={settings}
          account={wallet.address ?? ''}
          reviewedOut={reviewedOut ?? quote.amountOut}
          onAccept={() => setReviewedOut(quote.amountOut)}
          onCancel={() => setReviewing(false)}
          onConfirm={() => void doSwap()}
        />
      )}
    </section>
  );
}

/**
 * The last look before signing: both amounts, every bound the router will
 * enforce, the route and the exact call. Above 10% impact the confirmation is
 * typed, not a second click.
 */
function ReviewSwap({
  quote,
  tokens,
  prices,
  settings,
  account,
  reviewedOut,
  onAccept,
  onCancel,
  onConfirm,
}: {
  quote: SwapQuote;
  tokens: TokenInfo[];
  prices: PriceTable;
  settings: TradeSettings;
  account: string;
  /** The output shown when the review opened, or last accepted. */
  reviewedOut: bigint;
  onAccept: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const level = impactLevel(quote.priceImpactBps);
  const plan = planSwap(quote, settings.deadlineMinutes);
  const severe = level === 'severe';
  // The quote refreshes with every pool read while this dialog is open. A
  // better fill needs nothing; a worse one is shown and must be accepted.
  const worse = quote.amountOut < reviewedOut;
  const ok = !worse && (!severe || typed.trim().toLowerCase() === 'i understand');
  const unlisted = [quote.tokenIn, quote.tokenOut].filter((t) => !isListed(t));
  return (
    <Modal
      title={severe ? 'High price impact' : 'Review swap'}
      onClose={onCancel}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          {worse ? (
            <button className="btn btn-primary push" onClick={onAccept} data-testid="accept-price">
              Accept new price
            </button>
          ) : (
            <button className="btn btn-primary push" disabled={!ok} onClick={onConfirm} data-testid="confirm-swap">
              {severe ? 'Swap anyway' : 'Confirm swap'}
            </button>
          )}
        </div>
      }
    >
      <div className="review-amounts">
        <div className="review-side">
          <span className="label">You pay</span>
          <span className="review-figure mono">
            {formatAmount(quote.amountIn, quote.tokenIn.decimals, 8)} <span className="muted">{quote.tokenIn.symbol}</span>
          </span>
          <span className="faint mono small">{usdText(prices, quote.tokenIn, quote.amountIn) ?? ' '}</span>
        </div>
        <div className="review-arrow" aria-hidden="true">
          <IconArrowDown />
        </div>
        <div className="review-side">
          <span className="label">You receive</span>
          <span className="review-figure mono">
            {formatAmount(quote.amountOut, quote.tokenOut.decimals, 8)} <span className="muted">{quote.tokenOut.symbol}</span>
          </span>
          <span className="faint mono small">{usdText(prices, quote.tokenOut, quote.amountOut) ?? ' '}</span>
        </div>
      </div>
      {worse && (
        <Notice kind="warn" role="alert" title="Price updated">
          The pools moved while you were reviewing: you now receive {formatAmount(quote.amountOut, quote.tokenOut.decimals, 8)}{' '}
          {quote.tokenOut.symbol}, down from {formatAmount(reviewedOut, quote.tokenOut.decimals, 8)}. Accept the new price to continue.
        </Notice>
      )}
      {unlisted.length > 0 && (
        <Notice kind="warn" title={`${unlisted.map((t) => t.symbol).join(' and ')} ${unlisted.length > 1 ? 'are' : 'is'} not on the Ferminux list`}>
          Anyone can deploy a token with any name. Check{' '}
          {unlisted.map((t, i) => (
            <span key={t.address}>
              {i > 0 ? ' and ' : ''}
              <span className="mono break">{t.address}</span>
            </span>
          ))}{' '}
          against the project&rsquo;s own published address before you swap.
        </Notice>
      )}
      <RouteTrace tokens={routeTokens(quote.route.path, quote.tokenIn, quote.tokenOut, tokens)} />
      <div className="review-rows">
        <StatRow
          label="Price impact"
          value={formatPpmPercent(quote.priceImpactPpm)}
          tone={severe ? 'danger' : level === 'warn' ? 'warn' : undefined}
        />
        <StatRow label="Minimum received" value={`${formatAmount(quote.minimumReceived, quote.tokenOut.decimals, 8)} ${quote.tokenOut.symbol}`} />
        <StatRow label="Liquidity provider fee" value={`${(quote.totalFeeBps / 100).toFixed(2)}%`} />
        <StatRow label="Slippage tolerance" value={formatBpsPercent(quote.slippageBps)} />
        <StatRow label="Deadline" value={`${settings.deadlineMinutes} min`} />
        <StatRow label="Recipient" value={<span className="mono">{shortAddress(account, 6, 4)} (you)</span>} />
        <StatRow label="Router call" value={<span className="mono">{plan.method}</span>} />
      </div>
      {severe && (
        <>
          <Notice kind="danger">
            This trade fills {formatPpmPercent(quote.priceImpactPpm)} below the pools&rsquo; current price. That is not a fee
            paid to anyone: it is the price moving because the trade takes a large share of the pools&rsquo; depth.
          </Notice>
          <div className="field">
            <label htmlFor="impact-confirm" className="field-label">
              Type <strong>I understand</strong> to continue
            </label>
            <input id="impact-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="I understand" autoComplete="off" />
          </div>
        </>
      )}
    </Modal>
  );
}
