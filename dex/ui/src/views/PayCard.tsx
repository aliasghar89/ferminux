// Swap in "Buy FMX with <coin> on <network>" mode.
//
// The pool swap card's twin: the same field boxes and one primary action, but
// the coin is paid on another network through the pay-in and the FMX arrives
// on Ferminux (lib/payin.ts has the rules). Four screens in one card: the
// amount form, the review (the exact amount, the deposit address, the network,
// the recipient and the clock), the send (switch the wallet, check the
// balance and the chain again, send exactly the quoted amount), and the
// tracker that follows the quote to the FMX transfer, across reloads.
import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'ethers';
import { DEX_ADDRESSES, FMX_USD_E18, PAYIN_API_URL } from '../config.ts';
import { CopyButton, Modal, Notice, Spinner, StatRow, TxLink } from '../components/ui.tsx';
import { PayAddressLink, PayCoin, PaySteps, PayTxLink, clock, payAmount, type StepItem } from '../components/PayParts.tsx';
import { TokenLogo } from '../components/TokenLogo.tsx';
import { IconArrowDown, IconChevronDown, IconChevronRight, IconLock } from '../components/icons.tsx';
import { formatAmount, isAddress, shortAddress, toChecksum } from '../lib/amounts.ts';
import { formatUsd, formatUsdPrice } from '../lib/prices.ts';
import {
  MIN_SECONDS_TO_SEND,
  PAYIN_DEFAULTS,
  PayApiError,
  allInPriceE18,
  applyStatus,
  balanceOf,
  balanceShortfall,
  checkPayAmount,
  clearSending,
  confirmOpenQuote,
  distinctFrom,
  estimateFmxOut,
  fetchPayStatus,
  isFinished,
  markSending,
  markSent,
  maxSpendable,
  maybeSent,
  newTrack,
  payAsset,
  payChain,
  readPayBalances,
  recentUnits,
  requestPayQuote,
  sameAddress,
  secondsLeft,
  sendRefusal,
  trackStep,
  usdValueE18,
  validateQuote,
  visiblePurchases,
  type PayQuoteRequest,
  type PaySelection,
  type PayTrack,
} from '../lib/payin.ts';
import { PayWalletError, ensurePayChain, sendPayment } from '../lib/payWallet.ts';
import { isUserRejection } from '../../../../shared/fxwallet/network.ts';
import { chainName } from '../../../../shared/fxwallet/chains.ts';
import { nativeToken } from '../lib/tokens.ts';
import { readableError } from '../lib/wallet.ts';
import { refreshPayAssets, usePayBalances, type PayAssetsState, type PayTracksState } from '../state/usePayin.ts';
import type { WalletSession } from '../state/useWallet.ts';

const E18 = 10n ** 18n;
const BUY_FMX_URL = 'https://ferminux.net/buy-fmx/';

/** Every digit the coin can express, with the thousands grouped: "9.999999999999999997", "1,250.5", "10". */
export function exactAmount(units: bigint, decimals: number): string {
  const [w, f = '0'] = formatUnits(units, decimals).split('.');
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f === '0' ? grouped : `${grouped}.${f}`;
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return on ? now : Date.now();
}

type SendStep = 'switch' | 'add' | 'balance' | 'check' | 'confirm';
const STEP_TEXT: Record<SendStep, (net: string) => string> = {
  switch: (net) => `Approve switching your wallet to ${net}.`,
  add: (net) => `Approve adding ${net} to your wallet.`,
  balance: (net) => `Checking your balance and the network fee on ${net}.`,
  check: (net) => `Checking with the pay-in that ${net} is taking payments and this quote is still open.`,
  confirm: () => 'Confirm the transfer in your wallet.',
};

export function statusText(t: PayTrack, now: number): string {
  switch (t.status) {
    case 'quoted':
      if (t.sentTx) return 'Payment sent, waiting for it to be seen';
      if (maybeSent(t)) return 'Check your wallet: a payment may have been sent';
      return secondsLeft(t, now) > 0 ? 'Waiting for your payment' : 'Quote closed';
    case 'seen':
      return `Payment seen, ${Math.min(t.confirmations, t.required)}/${t.required} confirmations`;
    case 'confirmed':
      return 'Confirmed, sending FMX';
    case 'paid':
      return 'FMX delivered';
    case 'expired':
      return 'Quote expired';
    case 'failed':
      return 'Failed at the pay-in';
    case 'superseded':
      return t.sentTx ? 'Replaced, still following your payment' : 'Replaced by a newer quote';
  }
}

export function PayCard({
  selection,
  wallet,
  tracks,
  assets,
  onPickToken,
  onExit,
}: {
  selection: PaySelection;
  wallet: WalletSession;
  tracks: PayTracksState;
  assets: PayAssetsState;
  onPickToken: () => void;
  onExit: () => void;
}) {
  const chain = payChain(selection.chain)!;
  const asset = payAsset(selection.chain, selection.asset)!;
  const info = assets.info;
  const chainState = info?.chains[chain.key] ?? null;
  const priceE18 = info?.priceE18 ?? FMX_USD_E18;
  const spreadBps = info?.spreadBps ?? PAYIN_DEFAULTS.spreadBps;
  const limits = { minUsd: info?.minUsd ?? PAYIN_DEFAULTS.minUsd, maxUsd: info?.maxUsd ?? PAYIN_DEFAULTS.maxUsd };
  const { balances, refresh: refreshBalances } = usePayBalances(wallet.address, [chain.key], true);
  const bal = balances[chain.key] ?? null;
  const balance = balanceOf(bal, asset);

  const active = tracks.active && tracks.active.quote.chain === chain.key && tracks.active.quote.asset === asset.symbol ? tracks.active : null;

  const [amountText, setAmountText] = useState('');
  const [editingTo, setEditingTo] = useState(false);
  const [toText, setToText] = useState('');
  const [toAck, setToAck] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [sendStep, setSendStep] = useState<SendStep | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [resendAck, setResendAck] = useState(false);

  const reviewTrack = reviewId ? (tracks.tracks.find((t) => t.quote.quoteId === reviewId) ?? null) : null;
  const tracksRef = useRef(tracks.tracks);
  tracksRef.current = tracks.tracks;
  const latest = (id: string) => tracksRef.current.find((t) => t.quote.quoteId === id) ?? null;
  const now = useNow((active !== null && !isFinished(active, Date.now())) || reviewTrack !== null);

  // A new coin or network starts a fresh form.
  useEffect(() => {
    setQuoteError(null);
  }, [chain.key, asset.symbol]);

  // ---- the form -------------------------------------------------------------
  const check = amountText.trim() === '' ? null : checkPayAmount(amountText, asset, limits);
  const units = check?.ok ? check.units : 0n;
  const estimate = estimateFmxOut(units, asset, priceE18, spreadBps);
  const custom = editingTo && toText.trim() !== '';
  const toValid = !custom || isAddress(toText);
  const recipient = custom ? (toValid ? toChecksum(toText) : null) : wallet.address;
  const toOther = recipient !== null && wallet.address !== null && !sameAddress(recipient, wallet.address);
  const recipientOk = recipient !== null && (!toOther || toAck);
  const insufficient = balance !== undefined && units > balance;

  const getQuote = async (typed: bigint, to: string) => {
    if (!wallet.address) return;
    setQuoting(true);
    setQuoteError(null);
    setSendError(null);
    // Never an amount one of this wallet's replaced quotes still holds (lib/payin.ts, recentUnits).
    const sel = { chain: chain.key, asset: asset.symbol, from: wallet.address };
    const want = distinctFrom(typed, recentUnits(tracksRef.current, sel, Date.now()));
    const req: PayQuoteRequest = { ...sel, units: want, typedUnits: typed, to };
    const requestedAtMs = Date.now();
    try {
      const raw = await requestPayQuote(PAYIN_API_URL, req);
      const r = validateQuote(raw, req, { requestedAtMs, priceE18: info?.priceE18 ?? null, spreadBps, ...limits });
      if (!r.ok) {
        setQuoteError(r.error);
        return;
      }
      // The quote this replaces stays in the store: the pay-in can still match its amount for a while.
      const t = newTrack(r.quote);
      tracks.put(t);
      tracks.setActive(t.quote.quoteId);
      setResendAck(false);
      setReviewId(t.quote.quoteId);
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : String(err));
      if (err instanceof PayApiError && err.unavailable) assets.reload();
    } finally {
      setQuoting(false);
    }
  };

  const doSend = async (id: string) => {
    const t0 = latest(id);
    if (!t0) return;
    setSendError(null);
    const provider = wallet.eip1193;
    if (!provider || !wallet.address) {
      setSendError('Connect your wallet first.');
      return;
    }
    if (!sameAddress(wallet.address, t0.quote.from)) {
      setSendError(`This quote is for payment from ${t0.quote.from}, and your wallet is connected as ${wallet.address}. Switch back to that account, or get a new quote.`);
      return;
    }
    const refused = sendRefusal(t0, Date.now());
    if (refused) {
      setSendError(refused);
      return;
    }
    if (maybeSent(t0) && !resendAck) {
      setSendError('Check your wallet’s activity first, then tick the box below.');
      return;
    }
    const mark = Date.now();
    let marked = false;
    try {
      setSendStep('switch');
      await ensurePayChain(provider, chain, { onStep: (s) => setSendStep(s) });
      setSendStep('balance');
      const b = await readPayBalances(chain, t0.quote.from).catch(() => null);
      const short = balanceShortfall(t0.quote, b);
      if (short) throw new PayWalletError(short, true);
      // The wallet dialogs take time, and this page's copy of the quote may be one a reload brought back or
      // another tab or device has since replaced. So the pay-in is asked, now: the network must still be
      // taking payments (a payment made while its deposit scanner is behind can outlive the quote and land
      // unmatched), and the quote must still be open there for exactly this amount, recipient and payer,
      // unpaid and more than a minute from closing.
      setSendStep('check');
      const fresh = await refreshPayAssets().catch(() => null);
      const known = fresh ?? assets.info;
      const net = known?.chains[chain.key] ?? null;
      if (known && !known.enabled) {
        throw new PayWalletError('The pay-in is not taking payments right now. Nothing was sent: keep this quote and try again shortly.', true);
      }
      if (net && !net.available) {
        throw new PayWalletError(
          `${chain.name} is not taking payments right now${net.reason ? ` (${net.reason})` : ''}. Nothing was sent: a payment now might not be matched to your quote. Try again shortly, or pay on another network.`,
          true,
        );
      }
      let raw: unknown;
      try {
        raw = await fetchPayStatus(PAYIN_API_URL, id);
      } catch (err) {
        throw new PayWalletError(`Nothing was sent: this quote could not be checked with the pay-in just now (${readableError(err)}). Try again.`, true);
      }
      const current = latest(id);
      if (!current) throw new PayWalletError('This quote is no longer open.', true);
      const checked = confirmOpenQuote(current, raw, Date.now());
      tracks.update(id, (t) => {
        try {
          return applyStatus(t, raw, Date.now());
        } catch {
          return t;
        }
      });
      if (checked.refusal) throw new PayWalletError(checked.refusal, true);
      const t1 = checked.track;
      if (maybeSent(t1) && t1.sendingAt !== t0.sendingAt) {
        throw new PayWalletError('Another tab or window started paying this quote. Nothing was sent from here: check your wallet’s activity first.', true);
      }
      setSendStep('confirm');
      tracks.update(id, (t) => markSending(t, mark));
      marked = true;
      const { hash } = await sendPayment(provider, t1.quote);
      tracks.update(id, (t) => markSent(t, hash, Date.now()));
      setReviewId(null);
      setAmountText('');
      tracks.pollNow(id);
      refreshBalances();
    } catch (err) {
      const notSent = err instanceof PayWalletError ? err.notSent : isUserRejection(err);
      if (marked && notSent) tracks.update(id, (t) => (t.sendingAt === mark ? clearSending(t) : t));
      const msg = err instanceof PayWalletError ? err.message : readableError(err);
      setSendError(notSent ? msg : `${msg} If your wallet shows the transfer as sent, do not send it again: this page keeps following the quote.`);
    } finally {
      setSendStep(null);
    }
  };

  // ---- the one primary action -------------------------------------------------
  let action: { label: string; onClick?: () => void; disabled: boolean } = { label: 'Enter an amount', disabled: true };
  if (!wallet.wallet) action = { label: wallet.connecting ? 'Connecting' : 'Connect wallet', onClick: wallet.connect, disabled: wallet.connecting };
  else if (info && !info.enabled) action = { label: 'The pay-in is offline', disabled: true };
  else if (chainState && !chainState.available) action = { label: `Paused on ${chain.name}`, disabled: true };
  else if (check && !check.ok) action = { label: 'Enter a valid amount', disabled: true };
  else if (!check) action = { label: 'Enter an amount', disabled: true };
  else if (!recipient) action = { label: 'Enter a valid FMX address', disabled: true };
  else if (!recipientOk) action = { label: 'Confirm the FMX address', disabled: true };
  else if (insufficient) action = { label: `Not enough ${asset.symbol} on ${chain.short}`, disabled: true };
  else if (quoting) action = { label: 'Getting a quote', disabled: true };
  else action = { label: 'Get quote', onClick: () => void getQuote(units, recipient), disabled: false };

  const setMax = () => {
    const m = maxSpendable(asset, bal);
    if (m !== null) setAmountText(formatUnits(m, asset.decimals).replace(/\.0$/, ''));
  };

  const fmxToken = nativeToken(DEX_ADDRESSES.wfmx);
  const usdIn = asset.stable && units > 0n ? formatUsd(usdValueE18(units, asset.decimals, E18)) : null;
  const allIn = allInPriceE18(priceE18, spreadBps);

  const review =
    reviewTrack && (
      <ReviewPayment
        track={reviewTrack}
        now={now}
        sendStep={sendStep}
        sendError={sendError}
        resendAck={resendAck}
        onResendAck={setResendAck}
        quoting={quoting}
        onSend={() => void doSend(reviewTrack.quote.quoteId)}
        onRequote={() => void getQuote(reviewTrack.quote.requested, reviewTrack.quote.to)}
        onCancel={() => {
          if (sendStep) return;
          setReviewId(null);
          setSendError(null);
        }}
      />
    );

  const head = (
    <div className="card-head">
      <h1 id="swap-h" className="card-title">
        Swap
      </h1>
      <span className="spacer" />
      <span className="pay-badge mono">Pay-in</span>
    </div>
  );

  // ---- a quote in progress: the tracker ------------------------------------------
  if (active) {
    return (
      <section className="card swap-card pay-card" aria-labelledby="swap-h" data-testid="pay-card">
        {head}
        <PayTracker
          track={active}
          now={now}
          wallet={wallet}
          onReview={() => {
            setSendError(null);
            setReviewId(active.quote.quoteId);
          }}
          onRequote={() => void getQuote(active.quote.requested, active.quote.to)}
          quoting={quoting}
          quoteError={quoteError}
          onClose={() => tracks.setActive(null)}
          onBuyMore={() => {
            tracks.setActive(null);
            setQuoteError(null);
          }}
          onExit={onExit}
        />
        {review}
      </section>
    );
  }

  // ---- the form ---------------------------------------------------------------------
  return (
    <section className="card swap-card pay-card" aria-labelledby="swap-h" data-testid="pay-card">
      {head}
      <div className="pay-mode" data-testid="pay-mode">
        <span className="pay-mode-title">
          Buy FMX with {asset.symbol} on {chain.name}
        </span>
        <button type="button" className="link-btn" onClick={onExit} data-testid="pay-exit">
          Swap on Ferminux instead
        </button>
      </div>

      <div className="swap-fields">
        <div className={'field-box' + (check && !check.ok ? ' has-error' : '')} data-testid="pay-in">
          <div className="field-box-head">
            <span className="field-box-label">You pay</span>
            {wallet.address && (
              <span className="field-box-balance">
                <span className="bal-word">On {chain.short}</span>{' '}
                <span className="mono" data-testid="pay-balance">
                  {balance !== undefined ? payAmount(balance, asset, 4) : bal ? '—' : '…'}
                </span>
                {balance !== undefined && balance > 0n && (
                  <button type="button" className="max-btn" onClick={setMax}>
                    Max
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="field-box-row">
            <input
              className="amount-input"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value.replace(',', '.'))}
              aria-label={`You pay, amount in ${asset.symbol} on ${chain.name}`}
            />
            <button type="button" className="token-btn pay-token-btn" onClick={onPickToken} aria-label={`You pay: ${asset.symbol} on ${chain.name}. Change`} data-testid="pay-token">
              <PayCoin asset={asset} chain={chain} size={24} />
              <span>{asset.symbol}</span>
              <IconChevronDown />
            </button>
          </div>
          <div className="field-box-foot">
            <span className="mono faint">{usdIn ? `≈ ${usdIn}` : asset.stable ? ' ' : `${asset.symbol} is priced when you get the quote`}</span>
          </div>
          {check && !check.ok && <div className="field-error">{check.error}</div>}
          {check?.ok && insufficient && (
            <div className="field-error">
              More than your {asset.symbol} on {chain.name}.{asset.kind === 'native' ? ` Keep some ${asset.symbol} for the network fee, too.` : ''}
            </div>
          )}
        </div>
        <div className="flip-btn flip-static" aria-hidden="true">
          <IconArrowDown />
        </div>
        <div className="field-box is-locked" data-testid="pay-out">
          <div className="field-box-head">
            <span className="field-box-label">You receive</span>
            <span className="field-box-balance faint">on Ferminux</span>
          </div>
          <div className="field-box-row">
            <output className={'amount-input amount-output' + (estimate ? '' : ' is-empty')} aria-live="polite" aria-label="You receive, FMX">
              {estimate ? formatAmount(estimate, 18, 6).replace(/,/g, '') : '0'}
            </output>
            <span className="token-btn token-btn-static" aria-label="You receive FMX on Ferminux: fixed for this payment">
              <TokenLogo token={fmxToken} size={24} />
              <span>FMX</span>
              <IconLock />
            </span>
          </div>
          <div className="field-box-foot">
            <span className="mono faint">{estimate ? `before the quote, at ${formatUsdPrice(priceE18)} + ${spreadBps / 100}%` : ' '}</span>
          </div>
        </div>
      </div>
      <p className="field-hint pay-oneway">
        One way only: selling FMX into {asset.symbol} on {chain.name} is not offered yet.
      </p>

      <div className="quote-flat pay-facts" data-testid="pay-facts">
        <StatRow
          label="Rate"
          value={`1 FMX = ${formatUsdPrice(allIn)}`}
          hint={`${formatUsdPrice(priceE18)}, the official FMX price set by the operator, plus the pay-in's ${spreadBps / 100}% spread.`}
          testId="pay-rate"
        />
        {asset.stable && <StatRow label={`1 ${asset.symbol} buys`} value={`${formatAmount(estimateFmxOut(10n ** BigInt(asset.decimals), asset, priceE18, spreadBps) ?? 0n, 18, 4)} FMX`} />}
        <StatRow label="Per quote" value={`$${limits.minUsd.toLocaleString('en-US')} to $${limits.maxUsd.toLocaleString('en-US')}`} testId="pay-limits" />
        <StatRow
          label="Network fee"
          value={`in ${chain.native.symbol}, on top`}
          hint={`Your wallet pays the ${chain.name} fee for the transfer. The FMX arrives in full: the pay-in pays the Ferminux fee.`}
        />
        <StatRow label="Confirmations" value={`${chainState?.confirmations ?? chain.confirmations} on ${chain.short}`} hint={`FMX is sent once ${chain.name} has confirmed your payment this many times.`} />
        <StatRow label="Quote valid" value={`${Math.round((info?.expiresS ?? PAYIN_DEFAULTS.expiresS) / 60)} min`} hint="From when the quote is issued. Paying needs at least a minute left." />
        <StatRow
          label="FMX to"
          value={
            recipient ? (
              <span className="pay-to">
                <span className="mono">{shortAddress(recipient, 6, 4)}</span>
                <span className="faint">{toOther ? ' (another address)' : ' (this wallet)'}</span>
              </span>
            ) : (
              <span className="faint">{wallet.address ? 'not a valid address' : 'your connected wallet'}</span>
            )
          }
          testId="pay-recipient"
        />
        {wallet.address && !editingTo && (
          <div className="pay-to-change">
            <button type="button" className="link-btn" onClick={() => setEditingTo(true)} data-testid="pay-to-edit">
              Send the FMX to another address
            </button>
          </div>
        )}
      </div>

      {editingTo && (
        <div className="pay-recipient-edit" data-testid="pay-to-form">
          <label className="field-label" htmlFor="pay-to">
            FMX recipient on Ferminux
          </label>
          <input
            id="pay-to"
            className="input input-mono"
            value={toText}
            placeholder="0x… on Ferminux (chain 3961)"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setToText(e.target.value);
              setToAck(false);
            }}
          />
          {custom && !toValid && <div className="field-error">Not a valid address.</div>}
          <Notice kind="warn" title="FMX to another address">
            The FMX is sent to this address on Ferminux Network and cannot be taken back. Use an address you control on Ferminux (chain
            3961): not an exchange deposit address, and not a contract that cannot move FMX.
          </Notice>
          {toOther && (
            <label className="check-row">
              <input type="checkbox" checked={toAck} onChange={(e) => setToAck(e.target.checked)} data-testid="pay-to-ack" />
              <span>I control {shortAddress(recipient!, 6, 4)} on Ferminux.</span>
            </label>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setEditingTo(false);
              setToText('');
              setToAck(false);
            }}
          >
            Send it to this wallet instead
          </button>
        </div>
      )}

      <Notice title="Do not send from an exchange">
        The payment is matched to your quote by its exact amount and must come from this wallet. The FMX goes to the address above, not
        to whoever sends.
      </Notice>
      {chainState && !chainState.available && chainState.reason && (
        <Notice kind="warn" role="status">
          {chain.name} is not taking payments right now: {chainState.reason}. Pick another network.
        </Notice>
      )}
      {quoteError && (
        <Notice kind="danger" role="alert">
          {quoteError}
        </Notice>
      )}

      <button className="btn btn-lg btn-block btn-primary" disabled={action.disabled} onClick={action.onClick} data-testid="pay-action">
        {quoting && <Spinner />}
        {action.label}
      </button>
      <p className="field-hint pay-manual">
        Wallet cannot switch networks?{' '}
        <a href={BUY_FMX_URL} target="_blank" rel="noopener noreferrer">
          Pay by hand on ferminux.net
        </a>
        .
      </p>
      {review}
    </section>
  );
}

/**
 * The last look before the wallet is asked: the exact amount, where it goes,
 * on which network, who gets the FMX, and how long the quote has left.
 */
function ReviewPayment({
  track,
  now,
  sendStep,
  sendError,
  resendAck,
  onResendAck,
  quoting,
  onSend,
  onRequote,
  onCancel,
}: {
  track: PayTrack;
  now: number;
  sendStep: SendStep | null;
  sendError: string | null;
  resendAck: boolean;
  onResendAck: (v: boolean) => void;
  quoting: boolean;
  onSend: () => void;
  onRequote: () => void;
  onCancel: () => void;
}) {
  const q = track.quote;
  const chain = payChain(q.chain)!;
  const asset = payAsset(q.chain, q.asset)!;
  const left = secondsLeft(track, now);
  const refusal = sendRefusal(track, now);
  const expiredish = refusal !== null && track.status === 'quoted' && !track.sentTx && left < MIN_SECONDS_TO_SEND;
  const dust = q.requested - q.sendExactly;
  const busy = sendStep !== null;
  const doubt = maybeSent(track);
  return (
    <Modal
      title="Review payment"
      onClose={onCancel}
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {expiredish ? (
            <button className="btn btn-primary push" onClick={onRequote} disabled={quoting} data-testid="pay-requote">
              {quoting && <Spinner />} Get a new quote
            </button>
          ) : (
            <button className="btn btn-primary push" onClick={onSend} disabled={busy || refusal !== null || (doubt && !resendAck)} data-testid="pay-send">
              {busy && <Spinner />} Send payment
            </button>
          )}
        </div>
      }
    >
      <div className="review-amounts" data-testid="pay-review">
        <div className="review-side">
          <span className="label">You send exactly</span>
          <span className="review-figure mono" data-testid="pay-exact">
            {exactAmount(q.sendExactly, q.decimals)} <span className="muted">{q.asset}</span>
          </span>
          <span className="faint small">
            on {chain.name} · {formatUsd(q.usdE18)}
          </span>
        </div>
        <div className="review-arrow" aria-hidden="true">
          <IconArrowDown />
        </div>
        <div className="review-side">
          <span className="label">You receive</span>
          <span className="review-figure mono" data-testid="pay-fmx">
            {formatAmount(q.fmxOut, 18, 8)} <span className="muted">FMX</span>
          </span>
          <span className="faint small">on Ferminux Network, sent by the pay-in</span>
        </div>
      </div>
      {dust !== 0n && (
        <p className="field-hint">
          That is {(dust > 0n ? dust : -dust).toString()} unit{dust === 1n || dust === -1n ? '' : 's'} {dust > 0n ? 'less' : 'more'} than you typed, so
          this payment can be told apart from other open quotes. Your wallet sends it exactly as shown.
        </p>
      )}
      <div className="review-rows">
        <StatRow label="Network" value={`${chain.name} · chain ${chain.chainId}`} testId="pay-review-network" />
        <StatRow label="Deposit address" value={<PayAddressLink chain={q.chain} address={q.depositAddress} />} testId="pay-review-deposit" />
        {q.token && <StatRow label={`${q.asset} contract`} value={<PayAddressLink chain={q.chain} address={q.token} />} />}
        <StatRow label="From" value={<span className="mono">{shortAddress(q.from, 6, 4)} (this wallet)</span>} />
        <StatRow label="FMX to" value={<span className="mono break">{q.to}</span>} testId="pay-review-to" />
        <StatRow label="Price" value={`${formatUsdPrice(q.priceE18)} per FMX + ${q.spreadBps / 100}%`} />
        {!asset.stable && <StatRow label={`${q.asset} price`} value={formatUsdPrice(q.assetUsdE18)} />}
        <StatRow label="Confirmations" value={`${q.confirmations} on ${chain.short}`} />
        <StatRow label="Expires in" value={<span className="mono" role="timer">{clock(left)}</span>} tone={left < 120 ? 'warn' : undefined} testId="pay-review-clock" />
        <StatRow label="Quote id" value={<span className="pay-qid"><span className="mono">{q.quoteId}</span><CopyButton text={q.quoteId} iconOnly label="Copy the quote id" /></span>} />
      </div>
      <Notice kind="warn" title="Do not send from an exchange">
        This payment is matched to your quote by its exact amount, and only when it comes from {shortAddress(q.from, 6, 4)}. A withdrawal
        from an exchange comes from the exchange&rsquo;s address, so it would not be matched. The FMX goes to the address above, not to
        whoever sends.
      </Notice>
      {asset.kind === 'native' && (
        <p className="field-hint">Send from a normal wallet address: a {q.asset} payment made from inside a smart-contract wallet is not detected.</p>
      )}
      {doubt && (
        <Notice kind="danger" title="A payment may already have gone out">
          This page asked your wallet to pay this quote {track.sendingAt ? `at ${new Date(track.sendingAt).toLocaleTimeString()}` : 'earlier'} and
          never heard back. Look at your wallet&rsquo;s activity on {chain.name} first: a second payment of the same amount would not be matched.
          <label className="check-row">
            <input type="checkbox" checked={resendAck} onChange={(e) => onResendAck(e.target.checked)} />
            <span>I checked: no payment for this quote was sent.</span>
          </label>
        </Notice>
      )}
      {refusal && !busy && (
        <Notice kind={expiredish ? 'warn' : 'danger'} role="alert">
          {refusal}
        </Notice>
      )}
      {sendStep && (
        <div className="tx-status" role="status" data-testid="pay-step">
          <Spinner /> <span>{STEP_TEXT[sendStep](chain.name)}</span>
        </div>
      )}
      {sendError && (
        <Notice kind="danger" role="alert">
          {sendError}
        </Notice>
      )}
    </Modal>
  );
}

/** Following one quote: sent → seen → confirmed → delivered, with a link at each step. */
function PayTracker({
  track,
  now,
  wallet,
  onReview,
  onRequote,
  quoting,
  quoteError,
  onClose,
  onBuyMore,
  onExit,
}: {
  track: PayTrack;
  now: number;
  wallet: WalletSession;
  onReview: () => void;
  onRequote: () => void;
  quoting: boolean;
  quoteError: string | null;
  onClose: () => void;
  onBuyMore: () => void;
  onExit: () => void;
}) {
  const q = track.quote;
  const chain = payChain(q.chain)!;
  const asset = payAsset(q.chain, q.asset)!;
  const step = trackStep(track);
  const left = secondsLeft(track, now);
  const bad = track.status === 'failed' || track.status === 'expired' || (track.status === 'superseded' && !track.sentTx);
  const unsent = track.status === 'quoted' && !track.sentTx;
  const payTx = track.depositTx ?? track.sentTx;
  // Never offered once a payment for this quote went out or arrived: a quote that closed on a payment in
  // flight is a case for support (the notice says so), and a new quote would ask for that money again.
  const canRequote = !track.sentTx && !track.depositTx && (bad || (unsent && left < MIN_SECONDS_TO_SEND));
  const state = (i: number): StepItem['state'] => (i < step ? 'done' : i === step ? (bad ? 'bad' : 'current') : 'todo');
  const items: StepItem[] = [
    {
      label: track.sentTx || step > 0 ? 'Payment sent' : 'Send your payment',
      detail: payTx ? (
        <PayTxLink chain={q.chain} hash={payTx} label={`${chain.short} tx ${shortAddress(payTx, 8, 6)}`} />
      ) : unsent && left > 0 ? (
        <span className="mono">{clock(left)} left</span>
      ) : undefined,
      state: state(0),
    },
    { label: `Seen on ${chain.name}`, state: state(1) },
    {
      label: step >= 3 ? 'Confirmed' : 'Confirming',
      detail: step >= 2 ? <span className="mono">{Math.min(track.confirmations, track.required)}/{track.required}</span> : <span className="mono">{track.required} needed</span>,
      state: state(2),
    },
    {
      label: 'FMX delivered',
      detail: track.fmxTx ? <TxLink hash={track.fmxTx} label={`Ferminux tx ${shortAddress(track.fmxTx, 8, 6)}`} /> : undefined,
      state: state(3),
    },
  ];
  const awayFromFerminux = wallet.wallet !== null && wallet.wrongChain ? wallet.wallet.chainId : null;
  return (
    <div className="pay-tracker" data-testid="pay-tracker" data-status={track.status}>
      <div className="pay-track-head">
        <PayCoin asset={asset} chain={chain} size={36} />
        <div className="pay-track-title">
          <span className="pay-track-amount mono">{formatAmount(q.fmxOut, 18, 4)} FMX</span>
          <span className="faint small">
            for {exactAmount(q.sendExactly, q.decimals)} {q.asset} on {chain.name}
          </span>
        </div>
      </div>
      <p className={'pay-track-status' + (bad ? ' is-bad' : track.status === 'paid' ? ' is-done' : '')} role="status" data-testid="pay-status">
        {statusText(track, now)}
      </p>
      <PaySteps items={items} label="Payment progress" />

      {track.status === 'paid' && (
        <Notice kind="success" title="Done">
          {formatAmount(q.fmxOut, 18, 6)} FMX sent to <span className="mono">{shortAddress(q.to, 6, 4)}</span> on Ferminux.{' '}
          {track.fmxTx && <TxLink hash={track.fmxTx} label="View on explorer.ferminux.net" />}
        </Notice>
      )}
      {track.status === 'failed' && (
        <Notice kind="danger" title="The pay-in could not finish this">
          {track.error ?? 'No reason was given.'} Keep the quote id <span className="mono">{q.quoteId}</span> and the transaction hash for support.
        </Notice>
      )}
      {track.status === 'expired' && (
        <Notice kind="warn">
          {track.sentTx
            ? `This quote closed before your payment was seen. Keep the quote id ${q.quoteId} and your transaction hash and contact support: do not send again.`
            : 'This quote expired before a payment was seen. Nothing was sent from this page.'}
        </Notice>
      )}
      {track.status === 'superseded' && !track.sentTx && <Notice kind="warn">This quote was replaced by a newer one for the same coin. Do not pay it.</Notice>}
      {maybeSent(track) && (
        <Notice kind="danger" title="Check your wallet">
          This page asked your wallet to pay this quote and never heard back. If your wallet shows the transfer, wait here: it will be
          seen. Send again only if it does not.
        </Notice>
      )}
      {track.error && track.status !== 'failed' && <p className="field-hint">{track.error}</p>}
      {quoteError && (
        <Notice kind="danger" role="alert">
          {quoteError}
        </Notice>
      )}

      <div className="review-rows pay-track-rows">
        <StatRow label="You pay" value={`${exactAmount(q.sendExactly, q.decimals)} ${q.asset}`} />
        <StatRow label="FMX to" value={<span className="mono">{shortAddress(q.to, 6, 4)}</span>} />
        <StatRow label="Quote id" value={<span className="pay-qid"><span className="mono">{q.quoteId}</span><CopyButton text={q.quoteId} iconOnly label="Copy the quote id" /></span>} testId="pay-qid" />
      </div>

      {awayFromFerminux !== null && (
        <div className="pay-switch-back" role="status">
          <span>Your wallet is on {chainName(awayFromFerminux)}. Switch it back to use FMX on Ferminux.</span>
          <button className="btn btn-sm" onClick={() => void wallet.switchChain()} data-testid="pay-switch-back">
            Switch back to Ferminux
          </button>
        </div>
      )}

      <div className="pay-track-actions">
        {unsent && left > 0 && (
          <button className="btn btn-lg btn-block btn-primary" onClick={onReview} data-testid="pay-open-review">
            Review and send
          </button>
        )}
        {canRequote && (
          <button className="btn btn-lg btn-block btn-primary" onClick={onRequote} disabled={quoting || !wallet.address} data-testid="pay-requote">
            {quoting && <Spinner />} Get a new quote
          </button>
        )}
        <div className="pay-track-links">
          {unsent && !maybeSent(track) ? (
            <button className="link-btn" onClick={onClose} data-testid="pay-close">
              Close for now
            </button>
          ) : (
            <button className="link-btn" onClick={onBuyMore} data-testid="pay-buy-more">
              Buy more FMX
            </button>
          )}
          <button className="link-btn" onClick={onExit}>
            Swap on Ferminux
          </button>
        </div>
      </div>
    </div>
  );
}

/** Every quote this browser is following, newest first. */
export function PayPurchases({ tracks, onOpen }: { tracks: PayTracksState; onOpen: (t: PayTrack) => void }) {
  const now = Date.now();
  const shown = visiblePurchases(tracks.tracks, now);
  const anyFinished = shown.some((t) => isFinished(t, now));
  if (shown.length === 0) return null;
  return (
    <section className="card pay-purchases" aria-labelledby="pay-purchases-h" data-testid="pay-purchases">
      <div className="card-head">
        <h2 id="pay-purchases-h" className="card-title card-title-sm">
          Your FMX purchases
        </h2>
        <span className="spacer" />
        {anyFinished && (
          <button className="btn btn-ghost btn-sm" onClick={tracks.clearFinished}>
            Clear finished
          </button>
        )}
      </div>
      <ul className="rows">
        {shown.map((t) => {
          const chain = payChain(t.quote.chain)!;
          const asset = payAsset(t.quote.chain, t.quote.asset)!;
          return (
            <li key={t.quote.quoteId} className="row row-link">
              <button className="row-btn" onClick={() => onOpen(t)} data-quote={t.quote.quoteId}>
                <PayCoin asset={asset} chain={chain} size={32} />
                <span className="row-main">
                  <span className="row-title">
                    <span className="mono">{formatAmount(t.quote.fmxOut, 18, 4)} FMX</span>
                    <span className={'tag' + (t.status === 'failed' || t.status === 'expired' ? ' tag-warn' : '')}>{statusText(t, now)}</span>
                  </span>
                  <span className="row-sub">
                    {exactAmount(t.quote.sendExactly, t.quote.decimals)} {t.quote.asset} on {chain.name}
                  </span>
                </span>
                <IconChevronRight />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

