// Swap → You pay → Other networks: buy FMX with USDT, USDC or the native coin
// of one of the seven other networks this wallet holds, through the Ferminux
// pay-in (lib/payin.ts). FMX arrives on the Ferminux Network; the other side
// is locked to FMX (selling FMX into these coins is not offered).
//
// Get quote → one review screen (the quote and the transfer that pays it:
// network, token contract, deposit address, the exact amount, recipient,
// expiry, fee) → Sign → the tracker (SwapPanel shows it from the stored
// purchase). The transfer is an ordinary transaction through the wallet's own
// pipeline (lib/tx.ts prepareTransaction → signPrepared), built from the
// quote's exact `sendExactly` only and checked against the quote once when
// prepared and again right before signing, together with the expiry, the
// network's availability, the quote's own status and fresh balances.

import { useEffect, useRef, useState } from 'react';
import { isError, keccak256 } from 'ethers';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { payinSending, type PayinAssetsApi, type PayinRecordsApi } from '../state/usePayin.ts';
import { CHAIN_ID, PAYIN_API_URL } from '../config.ts';
import { FERMINUX_CHAIN } from '../lib/chains.ts';
import { findByAddress } from '../lib/accounts.ts';
import { balanceFor } from '../lib/portfolio.ts';
import { providerFor } from '../lib/providers.ts';
import { fetchTokenBalance } from '../lib/tokens.ts';
import { feePolicyFor, nativeTransferMaxFee, prepareTransaction, signPrepared, type PreparedTx } from '../lib/tx.ts';
import { checkAddress, checkAmount, formatAmount, formatAmountExact, formatGwei, shortAddress } from '../lib/validate.ts';
import type { LocalTx, LocalTxStatus } from '../lib/localActivity.ts';
import {
  PayinApiError,
  canStillPay,
  estimateStableFmx,
  expiryProblem,
  fetchPayinStatus,
  fmtUsdLimit,
  fmxForUsd,
  formatCountdown,
  networkOf,
  parseDecimalUnits,
  payinCall,
  payinFundsProblem,
  payinTxProblem,
  recordFromQuote,
  requestPayinQuote,
  secondsLeft,
  stableBoundsProblem,
  withLocalPay,
  withStatus,
  type PayinCoin,
  type PayinQuote,
} from '../lib/payin.ts';
import { AssetGlyph, ChainBadge } from '../components/ChainBadge.tsx';
import { Spinner } from '../components/ui.tsx';
import { IconCheck, IconChevronDown, IconClock, IconClose, IconLock, IconSwap } from '../components/icons.tsx';
import { ChainBanner, shortenError } from './SendPanel.tsx';
import { CoinGlyph, useNowS } from './PayinParts.tsx';

interface Funds {
  native: bigint;
  token: bigint | null;
}

type Step = 'checking' | 'signing' | null;

/** What blocks signing, and what fixes it: reading again (a top-up, a network hiccup) or a new quote. */
interface Problem {
  text: string;
  fix: 'recheck' | 'requote';
}

type Phase =
  | { kind: 'edit' }
  | { kind: 'working'; label: string }
  | { kind: 'review'; quote: PayinQuote; prepared: PreparedTx | null; funds: Funds | null; problem: Problem | null; step: Step }
  | { kind: 'failed'; message: string; quote: PayinQuote | null };

const nowSec = () => Math.floor(Date.now() / 1000);
const msg = (e: unknown, fallback: string) => (e instanceof Error ? shortenError(e.message) : fallback);

/**
 * The node answered the broadcast and refused it (insufficient funds, nonce, fee too low, any other JSON-RPC
 * error answer): the transfer did not enter the network and the quote may be paid again. A timeout, a lost
 * connection or an HTTP error from a gateway is not a refusal: the transfer may have gone out.
 */
function refusedByNode(e: unknown): boolean {
  if (isError(e, 'INSUFFICIENT_FUNDS') || isError(e, 'NONCE_EXPIRED') || isError(e, 'REPLACEMENT_UNDERPRICED') || isError(e, 'UNSUPPORTED_OPERATION')) return true;
  const inner = (e as { error?: { code?: unknown } } | null)?.error;
  return (isError(e, 'UNKNOWN_ERROR') || isError(e, 'CALL_EXCEPTION')) && typeof inner?.code === 'number';
}

export function BuyPanel({
  api,
  portfolio,
  coin,
  payin,
  records,
  resume,
  onResumeUsed,
  onOpenPicker,
  onTrack,
  onSent,
  onRecord,
  onStatus,
  purchases,
  rail,
}: {
  api: AccountsApi;
  portfolio: PortfolioApi;
  coin: PayinCoin;
  payin: PayinAssetsApi;
  records: PayinRecordsApi;
  /** A stored quote to review and pay (from the tracker). */
  resume: PayinQuote | null;
  onResumeUsed: () => void;
  onOpenPicker: () => void;
  onTrack: (quoteId: string) => void;
  onSent: (chainId: number) => void;
  onRecord: (tx: LocalTx) => void;
  onStatus: (chainId: number, hash: string, status: LocalTxStatus) => void;
  /** This account's purchases, under the form. */
  purchases: JSX.Element | null;
  /** The right-hand column on a wide screen. */
  rail: JSX.Element | null;
}) {
  const wallet = api.active;
  const chain = coin.chain;
  const nat = chain.native;
  const assets = payin.assets;
  const net = networkOf(assets, chain.key);
  const bal = balanceFor(portfolio.lastGood, chain.id, coin.address);
  const natBal = balanceFor(portfolio.lastGood, chain.id, null);
  const fmxBal = balanceFor(portfolio.lastGood, CHAIN_ID, null);
  const nowS = useNowS();

  const [amount, setAmount] = useState('');
  const [to, setTo] = useState(wallet.address);
  const [toEdit, setToEdit] = useState(false);
  const [toDraft, setToDraft] = useState('');
  const [toAck, setToAck] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [maxBusy, setMaxBusy] = useState(false);
  const [phase, setPhaseState] = useState<Phase>({ kind: 'edit' });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const setPhase = (p: Phase) => {
    if (alive.current) setPhaseState(p);
  };

  // "Review and pay" on a stored quote: straight to its review screen, once, and only while
  // this wallet has sent nothing for it.
  useEffect(() => {
    if (!resume) return;
    onResumeUsed();
    setAmount(formatAmountExact(resume.sendExactly, resume.decimals).replace(/\.0$/, ''));
    setTo(resume.to);
    const rec = records.get(resume.quoteId);
    if (!rec || !canStillPay(rec, nowSec())) {
      setFormError('That quote can no longer be paid from here. Get a new quote.');
      return;
    }
    void prepare(resume);
    // once, on mount
  }, []);

  const own = findByAddress(api.accounts, to);
  const recipientIsActive = to.toLowerCase() === wallet.address.toLowerCase();

  /* ---------------- the live form ---------------- */

  const amt = amount.trim() === '' ? null : checkAmount(amount, coin.decimals);
  const units = amt?.ok ? amt.wei : null;
  const estimate = units !== null && coin.stable ? estimateStableFmx(units, coin.decimals, assets) : null;
  const bounds = units !== null && coin.stable && assets ? stableBoundsProblem(units, coin.decimals, assets.minUsd, assets.maxUsd) : null;
  const over = units !== null && bal !== null && units > bal;
  const netProblem = !assets
    ? null
    : !assets.enabled
      ? 'The Ferminux pay-in is switched off right now.'
      : net && !net.available
        ? `${chain.name} is not taking payments right now: ${net.reason ?? 'its deposit scanner is not reaching it'}. Pay on another network.`
        : net && !net.coins.includes(coin.symbol)
          ? `${coin.symbol} on ${chain.name} is not offered by the pay-in right now.`
          : null;
  const price = assets?.priceUsdPerFmx ? parseDecimalUnits(assets.priceUsdPerFmx, 18) : null;
  const spreadBps = assets?.spreadBps ?? 200;
  const perUnit = coin.stable && price ? fmxForUsd(10n ** 18n, price, spreadBps) : null;

  async function useMax() {
    setFormError(null);
    if (bal === null) return setFormError(`${coin.symbol} balance on ${chain.name} unknown: cannot compute Max.`);
    const cap = coin.stable && assets ? BigInt(Math.floor(assets.maxUsd)) * 10n ** BigInt(coin.decimals) : null;
    if (coin.kind === 'erc20') {
      const v = cap !== null && bal > cap ? cap : bal;
      setAmount(formatAmountExact(v, coin.decimals).replace(/\.0$/, ''));
      return;
    }
    setMaxBusy(true);
    try {
      const provider = await providerFor(chain);
      const { feeWei } = await nativeTransferMaxFee(provider, chain.id, net?.depositAddress ?? wallet.address, feePolicyFor(chain, CHAIN_ID), { from: wallet.address, valueWei: bal });
      // a little more than the worst case, so the review never finds the balance a few wei short
      const reserve = feeWei + feeWei / 5n;
      if (bal <= reserve) return setFormError(`This ${nat.symbol} balance does not cover the ${chain.name} network fee.`);
      setAmount(formatAmountExact(bal - reserve, coin.decimals).replace(/\.0$/, ''));
    } catch {
      setFormError(`Could not read the ${chain.name} network fee to compute Max.`);
    } finally {
      setMaxBusy(false);
    }
  }

  /* ---------------- quote → prepare → sign ---------------- */

  async function readFunds(q: Pick<PayinQuote, 'kind' | 'token'>): Promise<Funds> {
    const provider = await providerFor(chain);
    const [native, token] = await Promise.all([
      provider.getBalance(wallet.address),
      q.kind === 'erc20' && q.token ? fetchTokenBalance(provider, q.token, wallet.address) : Promise.resolve(null),
    ]);
    return { native, token };
  }

  async function getQuote(want: bigint) {
    setFormError(null);
    const recipient = checkAddress(to);
    if (!recipient.ok) return setFormError(`FMX recipient: ${recipient.error}`);
    setPhase({ kind: 'working', label: 'Checking the pay-in…' });
    const listing = await payin.fresh(60_000);
    const n = networkOf(listing, chain.key);
    const stop = (why: string) => {
      setPhase({ kind: 'edit' });
      setFormError(why);
    };
    if (listing && !listing.enabled) return stop('The Ferminux pay-in is switched off right now.');
    if (n && !n.available) return stop(`${chain.name} is not taking payments right now: ${n.reason ?? 'its deposit scanner is not reaching it'}. Pay on another network.`);
    if (n && !n.coins.includes(coin.symbol)) return stop(`${coin.symbol} on ${chain.name} is not offered by the pay-in right now.`);
    if (coin.stable && listing) {
      const b = stableBoundsProblem(want, coin.decimals, listing.minUsd, listing.maxUsd);
      if (b) return stop(b);
    }
    const pre = payinFundsProblem({ coin, chain, amount: want, tokenBalance: coin.kind === 'erc20' ? bal : null, nativeBalance: natBal, maxFeeWei: 0n });
    if (pre) return stop(pre);
    setPhase({ kind: 'working', label: 'Getting a quote…' });
    let q: PayinQuote;
    try {
      q = await requestPayinQuote(PAYIN_API_URL, { chain: chain.key, asset: coin.symbol, units: want, to: recipient.address, from: wallet.address }, { assets: listing, nowS: nowSec });
    } catch (e) {
      if (e instanceof PayinApiError && e.unavailable) void payin.reload();
      return stop(msg(e, 'The pay-in did not answer with a quote.'));
    }
    records.put(recordFromQuote(q, Date.now()));
    await prepare(q);
  }

  /** The transfer that pays `q`, prepared on its network, with balances read there. */
  async function prepare(q: PayinQuote) {
    setPhase({ kind: 'working', label: `Preparing the transfer on ${chain.name}…` });
    const review = (prepared: PreparedTx | null, funds: Funds | null, text: string | null, fix: Problem['fix'] = 'recheck') =>
      setPhase({ kind: 'review', quote: q, prepared, funds, problem: text ? { text, fix } : null, step: null });
    let funds: Funds;
    try {
      funds = await readFunds(q);
    } catch (e) {
      return review(null, null, `Could not read this account on ${chain.name}: ${msg(e, 'no answer')}.`);
    }
    const pre = payinFundsProblem({ coin, chain, amount: q.sendExactly, tokenBalance: funds.token, nativeBalance: funds.native, maxFeeWei: 0n });
    if (pre) return review(null, funds, pre);
    const call = payinCall(q);
    let prepared: PreparedTx;
    try {
      const provider = await providerFor(chain);
      prepared = await prepareTransaction(provider, chain.id, wallet.address, call.to, call.value, call.data, feePolicyFor(chain, CHAIN_ID));
    } catch (e) {
      return review(null, funds, msg(e, 'The transfer could not be prepared.'));
    }
    const bad = payinTxProblem(prepared, q);
    if (bad) return review(null, funds, `The prepared transfer does not pay this quote exactly (${bad}). Nothing was signed.`, 'requote');
    const withFee = payinFundsProblem({ coin, chain, amount: q.sendExactly, tokenBalance: funds.token, nativeBalance: funds.native, maxFeeWei: prepared.maxFeeWei });
    review(prepared, funds, withFee);
  }

  async function sign(ph: Extract<Phase, { kind: 'review' }>) {
    const q = ph.quote;
    const prepared = ph.prepared;
    if (!prepared) return;
    const refuse = (text: string, fix: Problem['fix'] = 'recheck') => setPhase({ ...ph, problem: { text, fix }, step: null });
    setPhase({ ...ph, problem: null, step: 'checking' });
    // The quote is for this form's network and coin, and names this account as the sender: the pay-in
    // matches the deposit to the quote by amount AND payer, so a transfer from any other account is never credited.
    if (q.chain !== chain.key || q.chainId !== chain.id || q.asset !== coin.symbol || q.kind !== coin.kind) {
      return refuse(`This quote is for ${q.asset} on ${q.chain}, not ${coin.symbol} on ${chain.name}. Nothing was signed.`, 'requote');
    }
    if (q.from.toLowerCase() !== wallet.address.toLowerCase() || prepared.from.toLowerCase() !== q.from.toLowerCase()) {
      return refuse('This quote names another account as the sender. Get a new quote from this account. Nothing was signed.', 'requote');
    }
    // Never twice: a quote this wallet already signed a transfer for is not paid again. The stored purchase
    // is also where the transfer's hash is kept before the broadcast, so a quote without one is not signed.
    const stored = records.get(q.quoteId);
    if (!stored) return refuse('This quote is not in this wallet’s purchase list. Get a new quote. Nothing was signed.', 'requote');
    if (payinSending.has(q.quoteId) || stored.localState !== 'none') {
      return refuse('This wallet has already sent a transfer for this quote: follow it under FMX purchases. Nothing was signed.', 'requote');
    }
    // What is signed below (q) and what the pay-in is asked about (the stored purchase) are the same quote.
    if (
      stored.depositAddress.toLowerCase() !== q.depositAddress.toLowerCase() ||
      stored.sendExactly !== q.sendExactly.toString() ||
      stored.to.toLowerCase() !== q.to.toLowerCase() ||
      stored.from.toLowerCase() !== q.from.toLowerCase()
    ) {
      return refuse('This quote differs from the stored purchase. Get a new quote. Nothing was signed.', 'requote');
    }

    const short = () => {
      const e = expiryProblem(q.expiresAt, nowSec());
      return e === 'expired'
        ? 'This quote has expired. Get a new quote. Nothing was signed.'
        : e === 'short'
          ? 'Less than a minute is left on this quote: too little for the transfer to be seen in time. Get a new quote. Nothing was signed.'
          : null;
    };
    const s0 = short();
    if (s0) return refuse(s0, 'requote');

    // The network still takes payments, at the same deposit address. Not knowing is a refusal: a deposit
    // on a network whose scanner is down can sit unattributed past the quote's matching window.
    const listing = await payin.reload();
    if (!listing) return refuse(`Could not confirm with the Ferminux pay-in that ${chain.name} is taking payments (${payin.error ?? 'no answer'}). Nothing was signed.`);
    const n = networkOf(listing, chain.key);
    if (!listing.enabled || !n || !n.available) return refuse(`${chain.name} stopped taking payments (${n?.reason ?? 'pay-in switched off'}). Nothing was signed.`);
    if (!n.depositAddress || n.depositAddress.toLowerCase() !== q.depositAddress.toLowerCase()) return refuse('The pay-in lists a different deposit address than this quote. Get a new quote. Nothing was signed.', 'requote');
    // The quote is still open at the pay-in, for this deposit address, amount, recipient and sender.
    try {
      const s = await fetchPayinStatus(PAYIN_API_URL, stored);
      records.update(stored.quoteId, (r) => withStatus(r, s));
      if (s.status !== 'quoted') {
        return refuse(
          s.status === 'superseded'
            ? 'This quote was replaced by a newer one for the same network and coin. Nothing was signed.'
            : `The pay-in reports this quote as ${s.status}. Nothing was signed.`,
          'requote',
        );
      }
    } catch (e) {
      return refuse(`The pay-in could not confirm this quote is still open (${msg(e, 'no answer')}). Nothing was signed.`);
    }
    // Fresh balances against the worst-case fee.
    let funds: Funds;
    try {
      funds = await readFunds(q);
    } catch (e) {
      return refuse(`Could not read this account on ${chain.name} (${msg(e, 'no answer')}). Nothing was signed.`);
    }
    const fp = payinFundsProblem({ coin, chain, amount: q.sendExactly, tokenBalance: funds.token, nativeBalance: funds.native, maxFeeWei: prepared.maxFeeWei });
    if (fp) return refuse(`${fp} Nothing was signed.`);
    const bad = payinTxProblem(prepared, q);
    if (bad) return refuse(`The transfer does not pay this quote exactly (${bad}). Nothing was signed.`, 'requote');
    const s1 = short();
    if (s1) return refuse(s1, 'requote');

    setPhase({ ...ph, funds, problem: null, step: 'signing' });
    let raw: string;
    try {
      raw = await signPrepared(wallet.privateKey, prepared);
    } catch (e) {
      return setPhase({ kind: 'failed', message: msg(e, 'The transfer could not be signed.'), quote: q });
    }
    // The hash is known before the broadcast and stored first: a wallet closed mid-send
    // finds the transfer on its network next time instead of offering to pay twice.
    const hash = keccak256(raw);
    payinSending.add(q.quoteId);
    records.update(q.quoteId, (r) => withLocalPay(r, hash, 'signed'));
    const provider = await providerFor(chain);
    try {
      await provider.broadcastTransaction(raw);
    } catch (e) {
      const known = await provider.getTransaction(hash).catch(() => null);
      if (!known) {
        if (refusedByNode(e)) {
          records.update(q.quoteId, (r) => withLocalPay(r, null, 'none', msg(e, 'broadcast failed')));
          payinSending.delete(q.quoteId);
          return setPhase({ kind: 'failed', message: `Not sent: ${msg(e, 'the network refused the transfer')}. Nothing left this account.`, quote: q });
        }
        // No answer (timeout, dropped connection, a gateway error): the transfer may still have reached the
        // network. It stays 'signed' with its hash, so this quote is never paid a second time; the tracker
        // looks for it on the network and shows sent or "not found" in a few seconds.
        records.update(q.quoteId, (r) => withLocalPay(r, hash, 'signed', `No answer from ${chain.name} when sending: ${msg(e, 'no answer')}`));
        payinSending.delete(q.quoteId);
        onTrack(q.quoteId);
        return;
      }
    }
    records.update(q.quoteId, (r) => withLocalPay(r, hash, 'sent'));
    payinSending.delete(q.quoteId);
    onRecord({
      chainId: chain.id,
      hash,
      from: wallet.address,
      to: q.depositAddress,
      kind: q.kind === 'native' ? 'native' : 'token',
      symbol: coin.symbol,
      amount: q.sendExactly.toString(),
      decimals: q.decimals,
      contract: q.token,
      status: 'pending',
      createdAt: Date.now(),
    });
    onTrack(q.quoteId);
    // waitForTransaction hands back a reverted receipt as it is.
    void provider
      .waitForTransaction(hash, 1, 20 * 60_000)
      .then((receipt) => {
        if (!receipt) return;
        const ok = receipt.status === 1;
        records.update(q.quoteId, (r) => (r.localState === 'sent' || r.localState === 'signed' ? withLocalPay(r, hash, ok ? 'included' : 'reverted', ok ? null : 'The transfer reverted.') : r));
        onStatus(chain.id, hash, ok ? 'confirmed' : 'failed');
        onSent(chain.id);
      })
      .catch(() => undefined);
  }

  /* ---------------- render: review ---------------- */

  if (phase.kind === 'review') {
    return <Review ph={phase} coin={coin} wallet={wallet} own={findByAddress(api.accounts, phase.quote.to)?.label ?? null} nowS={nowS}
      onBack={() => setPhase({ kind: 'edit' })}
      onSign={() => void sign(phase)}
      onRequote={() => void getQuote(phase.quote.requested)}
      onRecheck={() => void prepare(phase.quote)}
    />;
  }

  if (phase.kind === 'failed') {
    const q = phase.quote;
    return (
      <div className="swap-flow" data-testid="payin-failed">
        <div className="panel send-card">
          <div className="tx-state">
            <div className="state-ic bad">
              <IconClose />
            </div>
            <h3>Not sent</h3>
            <p style={{ overflowWrap: 'anywhere' }}>{phase.message}</p>
          </div>
        </div>
        <div className="cta-bar">
          <button className="btn btn-block" data-testid="payin-failed-back" onClick={() => (q && !expiryProblem(q.expiresAt, nowSec()) ? void prepare(q) : setPhase({ kind: 'edit' }))}>
            Back
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- render: the form ---------------- */

  const working = phase.kind === 'working';
  let cta = 'Get quote';
  let ctaDisabled = working;
  if (amount.trim() === '') {
    cta = 'Enter an amount';
    ctaDisabled = true;
  } else if (!amt?.ok) ctaDisabled = true;
  else if (netProblem) {
    cta = `Not available on ${chain.name}`;
    ctaDisabled = true;
  } else if (over) {
    cta = `Not enough ${coin.symbol}`;
    ctaDisabled = true;
  } else if (bounds) ctaDisabled = true;
  else if (toEdit) ctaDisabled = true;

  const recipientLabel = recipientIsActive ? `This account · ${wallet.label}` : own ? `Your account · ${own.label}` : 'Not an account in this wallet';

  return (
    <div className="swap-grid">
      <div style={{ minWidth: 0 }}>
        <div className="panel swap-card" data-testid="payin-form" data-chain={chain.key} data-asset={coin.symbol}>
          <div className="swap-card-head">
            <ChainBadge chain={chain} />
            <span className="swap-venue" data-testid="payin-title">
              Buy FMX with {coin.symbol} <span className="faint">on {chain.name}</span>
            </span>
          </div>

          <div className="swap-leg">
            <div className="swap-leg-head">
              <span>You pay</span>
              <span className="push" />
              <span className="num" data-testid="payin-bal">
                {bal === null ? `Balance — on ${chain.short}` : `Balance ${formatAmount(bal, coin.decimals, 6)} on ${chain.short}`}
              </span>
              <button className="btn btn-ghost btn-sm swap-max" data-testid="payin-max" onClick={() => void useMax()} disabled={working || maxBusy || bal === null || bal === 0n}>
                {maxBusy ? <Spinner /> : 'Max'}
              </button>
            </div>
            <div className="swap-leg-row">
              <input
                className="swap-amount"
                data-testid="payin-amount"
                placeholder="0"
                inputMode="decimal"
                autoComplete="off"
                aria-label={`Amount of ${coin.symbol} to pay on ${chain.name}`}
                aria-invalid={(amt && !amt.ok) || over || bounds ? true : undefined}
                value={amount}
                disabled={working}
                onChange={(e) => {
                  setAmount(e.target.value.replace(',', '.'));
                  setFormError(null);
                }}
              />
              <button className="token-btn" data-testid="payin-token-in" onClick={onOpenPicker} disabled={working} aria-label={`Pay with ${coin.symbol} on ${chain.name}. Change`}>
                <CoinGlyph coin={coin} corner={false} />
                <span>{coin.symbol}</span>
                <span className="token-btn-net">{chain.short}</span>
                <IconChevronDown />
              </button>
            </div>
          </div>

          <div className="swap-flip-row">
            <button className="swap-flip hit-44" disabled aria-label="Selling FMX into these coins is not offered yet" title="Selling FMX into these coins is not offered yet">
              <IconSwap />
            </button>
          </div>

          <div className="swap-leg">
            <div className="swap-leg-head">
              <span>You receive{coin.stable ? ' (estimated)' : ''}</span>
              <span className="push" />
              <span className="num">{fmxBal === null ? 'Balance —' : `Balance ${formatAmount(fmxBal, 18, 6)}`}</span>
            </div>
            <div className="swap-leg-row">
              <output className={'swap-amount swap-out' + (estimate === null ? ' is-empty' : '')} data-testid="payin-out" aria-live="polite">
                {estimate !== null ? formatAmount(estimate, 18, 6) : '0'}
              </output>
              <span className="token-btn token-btn-locked" data-testid="payin-token-out" aria-label="You receive FMX on the Ferminux Network (fixed)">
                <AssetGlyph symbol="FMX" native home />
                <span>FMX</span>
                <IconLock />
              </span>
            </div>
            <p className="buy-lock-note" data-testid="payin-lock-note">
              FMX on the Ferminux Network. Selling FMX into these coins is not offered yet.
            </p>
          </div>

          <div className="swap-rate" data-testid="payin-rate">
            <span className="swap-rate-btn">
              {perUnit !== null
                ? `1 ${coin.symbol} ≈ ${formatAmount(perUnit, 18, 6)} FMX`
                : coin.stable
                  ? 'Priced when you get the quote'
                  : `${coin.symbol} is priced when you get the quote`}
            </span>
          </div>

          <dl className="swap-facts" data-testid="payin-facts">
            <div>
              <dt>Price</dt>
              <dd className="num" data-testid="payin-price">
                {assets?.priceUsdPerFmx ? `$${assets.priceUsdPerFmx} per FMX` : 'set at quote time'} · {(spreadBps / 100).toFixed(spreadBps % 100 ? 1 : 0)}% spread included
              </dd>
            </div>
            <div>
              <dt>Limits</dt>
              <dd className="num" data-testid="payin-limits">
                {assets ? `$${fmtUsdLimit(assets.minUsd)} – $${fmtUsdLimit(assets.maxUsd)} per purchase` : '—'}
              </dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>
                In {nat.symbol} on {chain.name}, shown before you sign
              </dd>
            </div>
            <div>
              <dt>Confirmations</dt>
              <dd className="num" data-testid="payin-confirmations">
                {net?.confirmations ? `${net.confirmations} on ${chain.name}` : '—'}
              </dd>
            </div>
            <div>
              <dt>Quote valid</dt>
              <dd className="num">{assets ? `${Math.round(assets.expires / 60)} min` : '15 min'}</dd>
            </div>
            <div>
              <dt>FMX to</dt>
              <dd>
                <span className="mono" data-testid="payin-recipient" title={to}>
                  {shortAddress(to)}
                </span>{' '}
                <span className={recipientIsActive ? 'faint' : 'impact-warn'} data-testid="payin-recipient-label">
                  · {recipientLabel}
                </span>{' '}
                {!toEdit && (
                  <button
                    className="link-btn"
                    data-testid="payin-recipient-change"
                    onClick={() => {
                      setToEdit(true);
                      setToDraft('');
                      setToAck(false);
                    }}
                    disabled={working}
                  >
                    Change
                  </button>
                )}
              </dd>
            </div>
          </dl>

          {toEdit && (
            <div className="buy-recipient" data-testid="payin-recipient-edit">
              <div className="notice notice-danger" style={{ marginBottom: 12 }}>
                <strong>FMX goes to this address, and only this address.</strong> Not back to this wallet, and not to whoever pays. Enter
                an address you control on the Ferminux Network: FMX sent to a wrong address cannot be recovered or refunded.
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label htmlFor="payin-to">FMX recipient on Ferminux</label>
                <input
                  id="payin-to"
                  className="input input-mono"
                  data-testid="payin-recipient-input"
                  placeholder="0x…"
                  value={toDraft}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setToDraft(e.target.value)}
                />
                {toDraft.trim() !== '' && !checkAddress(toDraft).ok && <div className="field-error">{(checkAddress(toDraft) as { error: string }).error}</div>}
              </div>
              <label className="check-row" style={{ marginBottom: 12 }}>
                <input type="checkbox" data-testid="payin-recipient-ack" checked={toAck} onChange={(e) => setToAck(e.target.checked)} />
                <span>I control this address on the Ferminux Network.</span>
              </label>
              <div className="actions-row">
                <button
                  className="btn btn-sm"
                  data-testid="payin-recipient-keep"
                  onClick={() => {
                    setToEdit(false);
                    setTo(wallet.address);
                  }}
                >
                  Use this account
                </button>
                <span className="push" />
                <button
                  className="btn btn-sm btn-primary"
                  data-testid="payin-recipient-apply"
                  disabled={!toAck || !checkAddress(toDraft).ok}
                  onClick={() => {
                    const c = checkAddress(toDraft);
                    if (!c.ok) return;
                    setTo(c.address);
                    setToEdit(false);
                  }}
                >
                  Send FMX there
                </button>
              </div>
            </div>
          )}

          <div className="notice buy-exchange" data-testid="payin-exchange-note">
            <strong>Do not send from an exchange.</strong> The pay-in matches the payment by its exact amount and by this wallet as the
            sender, and sends the FMX to the recipient above, not to whoever pays. This wallet sends it for you.
          </div>

          {amt && !amt.ok && <div className="field-error">{amt.error}</div>}
          {bounds && (
            <div className="field-error" data-testid="payin-bounds">
              {bounds}
            </div>
          )}
          {netProblem && (
            <div className="notice notice-warn" style={{ margin: '12px 0 0' }} data-testid="payin-net-problem">
              {netProblem}
            </div>
          )}
          {natBal === 0n && (
            <div className="notice notice-warn" style={{ margin: '12px 0 0' }} data-testid="payin-no-gas">
              This account has no {nat.symbol} on {chain.name}, so it cannot pay the network fee there. Fees on {chain.name} are paid in{' '}
              {nat.symbol}.
            </div>
          )}
          {formError && (
            <div className="field-error" data-testid="payin-form-error" style={{ marginTop: 12 }}>
              {formError}
            </div>
          )}
          {payin.state === 'error' && !assets && (
            <div className="field-error" style={{ marginTop: 12 }}>
              {payin.error}
            </div>
          )}
        </div>

        <p className="swap-scope small" data-testid="payin-scope">
          Bought through the Ferminux pay-in: this wallet sends {coin.symbol} on {chain.name} to the pay-in’s deposit address, and FMX
          arrives on the Ferminux Network (chain {FERMINUX_CHAIN.id}) after the network’s confirmations. Swaps between Ferminux tokens
          stay on the Ferminux DEX: pick one under You pay.
        </p>

        {purchases}

        <div className="cta-bar">
          <button
            className="btn btn-primary btn-block"
            data-testid="payin-quote"
            disabled={ctaDisabled}
            onClick={() => {
              if (units !== null) void getQuote(units);
            }}
          >
            {working ? (
              <>
                <Spinner /> {phase.kind === 'working' ? phase.label : 'Working…'}
              </>
            ) : (
              cta
            )}
          </button>
        </div>
      </div>
      {rail && <aside className="swap-rail">{rail}</aside>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review: the quote and the transfer that pays it                     */
/* ------------------------------------------------------------------ */

function Review({
  ph,
  coin,
  wallet,
  own,
  nowS,
  onBack,
  onSign,
  onRequote,
  onRecheck,
}: {
  ph: Extract<Phase, { kind: 'review' }>;
  coin: PayinCoin;
  wallet: { label: string; address: string };
  /** The recipient's label when it is one of this wallet's accounts. */
  own: string | null;
  nowS: number;
  onBack: () => void;
  onSign: () => void;
  onRequote: () => void;
  onRecheck: () => void;
}) {
  const { quote: q, prepared: p, funds, problem, step } = ph;
  const chain = coin.chain;
  const nat = chain.native;
  const left = secondsLeft(q.expiresAt, nowS);
  const exp = expiryProblem(q.expiresAt, nowS);
  const exact = formatAmountExact(q.sendExactly, q.decimals);
  const fee = p ? `${formatAmount(p.maxFeeWei, nat.decimals, 8)} ${nat.symbol}` : '—';
  const toIsActive = q.to.toLowerCase() === wallet.address.toLowerCase();
  const usd = parseDecimalUnits(q.usd, 18);
  return (
    <div className="swap-flow" data-testid="payin-review" data-chain-id={q.chainId} data-quote={q.quoteId}>
      <div className="panel send-card">
        <ChainBanner chain={chain} />
        <div className={'payin-expiry' + (left < 120 ? ' is-short' : '')} data-testid="payin-expiry" data-left={left} role="timer">
          <IconClock />
          <span>
            Quote <span className="mono">{q.quoteId}</span>
          </span>
          <span className="push" />
          <strong className="num">{exp === 'expired' ? 'expired' : `${formatCountdown(left)} left`}</strong>
        </div>
        <div className="confirm-amount">
          <div className="label">Send exactly</div>
          <div className={'v num' + (exact.length > 14 ? ' is-long' : '')} data-testid="payin-send-exactly">
            {exact}
            <span className="u">{coin.symbol}</span>
          </div>
          <div className="to">
            to the Ferminux pay-in on {chain.name} <span className="mono">{shortAddress(q.depositAddress)}</span>
          </div>
          {q.dustDirection !== 'none' && (
            <div className="small faint" style={{ marginTop: 6 }} data-testid="payin-dust">
              {q.dustDirection === 'down' ? 'A few units less' : 'A few units more'} than {formatAmountExact(q.requested, q.decimals)} typed: this exact figure is
              how the payment is told apart from other open quotes.
            </div>
          )}
        </div>
        <div className="confirm-legs">
          <div className="confirm-leg">
            <AssetGlyph symbol="FMX" native home />
            <div style={{ minWidth: 0 }}>
              <div className="k">You receive on the Ferminux Network</div>
              <div className="v num" data-testid="payin-fmx-out-short" title={`${formatAmountExact(q.fmxOut, 18)} FMX`}>
                {formatAmount(q.fmxOut, 18, 6)}
                <span className="u">FMX</span>
              </div>
              <div className="k">
                to {toIsActive ? 'this account' : own ? `your account ${own}` : 'an address outside this wallet'} · {shortAddress(q.to)}
              </div>
            </div>
          </div>
        </div>
        <table className="confirm-table">
          <tbody>
            <tr>
              <th>From</th>
              <td>
                {wallet.label} <span className="mono muted">{shortAddress(wallet.address)}</span>
              </td>
            </tr>
            <tr>
              <th>To</th>
              <td>
                <span className="mono" data-testid="payin-deposit">
                  {q.depositAddress}
                </span>
                <span className="muted small"> · pay-in deposit address</span>
              </td>
            </tr>
            <tr>
              <th>Asset</th>
              <td>{coin.kind === 'native' ? `${nat.symbol} · native coin` : `${coin.symbol} · ${coin.name}`}</td>
            </tr>
            {q.token && (
              <tr>
                <th>Token contract</th>
                <td className="mono" data-testid="payin-token">
                  {q.token}
                </td>
              </tr>
            )}
            <tr>
              <th>Amount</th>
              <td className="num" data-testid="payin-amount-exact">
                {exact} {coin.symbol} <span className="muted">· exactly as quoted</span>
              </td>
            </tr>
            <tr>
              <th>You receive</th>
              <td className="num" data-testid="payin-fmx-out">
                {formatAmountExact(q.fmxOut, 18)} FMX <span className="muted">· on the Ferminux Network</span>
              </td>
            </tr>
            <tr>
              <th>FMX recipient</th>
              <td>
                <span className="mono" data-testid="payin-review-recipient">
                  {q.to}
                </span>
                {!toIsActive && (
                  <span className="small impact-warn" data-testid="payin-review-recipient-warn">
                    {' '}
                    · {own ? `your account ${own}, not the one paying` : 'not an account in this wallet'}
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Price</th>
              <td className="num">
                ${q.priceUsdPerFmx} per FMX · {(q.spreadBps / 100).toFixed(q.spreadBps % 100 ? 1 : 0)}% spread included
                {usd !== null && <span className="muted"> · worth ${formatAmount(usd, 18, 2)}</span>}
              </td>
            </tr>
            <tr>
              <th>Confirmations</th>
              <td className="num">
                {q.confirmations} on {chain.name}
              </td>
            </tr>
            <tr>
              <th>Network fee (max)</th>
              <td className="num" data-testid="payin-fee">
                {fee}
                {p?.l1FeeWei !== undefined && <span className="muted"> · incl. L1 data fee</span>}
                {p?.l1FeeUnknown && <span className="muted"> · plus an L1 data fee that could not be read</span>}
              </td>
            </tr>
            <tr>
              <th>Max total debit</th>
              <td className="em num">
                {!p ? '—' : coin.kind === 'native' ? `${formatAmountExact(q.sendExactly + p.maxFeeWei, nat.decimals)} ${nat.symbol}` : `${exact} ${coin.symbol} + ${fee}`}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="notice notice-warn" data-testid="payin-review-exchange">
          <strong>Do not send from an exchange.</strong> The payment is matched by this exact amount and by this wallet as the sender; the
          FMX goes to the recipient above, not to whoever pays.
        </div>
        {problem && (
          <div className="notice notice-danger" data-testid="payin-problem" data-fix={problem.fix}>
            {problem.text}
          </div>
        )}
        {exp && (
          <div className="notice notice-danger" data-testid="payin-expired">
            {exp === 'expired' ? 'This quote has expired.' : 'Less than a minute is left on this quote: too little for the transfer to be seen in time.'} Get a new
            quote; nothing is signed for this one.
          </div>
        )}
        <ul className="check-list" data-testid="payin-checks" aria-label="Checked">
          <li>
            <IconCheck />
            <span>Quote matches what you asked: {chain.name}, {coin.symbol}{q.token ? ` at ${shortAddress(q.token)}` : ''}, exact amount, recipient</span>
          </li>
          <li>
            <IconCheck />
            <span>FMX figure recomputed from the quote’s price and spread</span>
          </li>
          {funds && (
            <li>
              <IconCheck />
              <span>
                Balance {coin.kind === 'erc20' && funds.token !== null ? formatAmount(funds.token, coin.decimals, 6) : formatAmount(funds.native, nat.decimals, 6)} {coin.symbol} on{' '}
                {chain.name}
              </span>
            </li>
          )}
          {funds && coin.kind === 'erc20' && (
            <li>
              <IconCheck />
              <span>
                {nat.symbol} for the network fee: {formatAmount(funds.native, nat.decimals, 6)} {nat.symbol}
              </span>
            </li>
          )}
          <li>
            <IconCheck />
            <span>
              Signed for {chain.name} only (chain {chain.id})
            </span>
          </li>
        </ul>
        {p && (
          <details className="details">
            <summary>
              Transaction details <IconChevronDown />
            </summary>
            <table className="confirm-table">
              <tbody>
                <tr>
                  <th>Chain ID</th>
                  <td className="num">{p.chainId}</td>
                </tr>
                <tr>
                  <th>Nonce</th>
                  <td className="num">{p.nonce}</td>
                </tr>
                <tr>
                  <th>Gas limit</th>
                  <td className="num">{p.gasLimit.toString()}</td>
                </tr>
                <tr>
                  <th>Fee type</th>
                  <td className="num">
                    {p.type === 0
                      ? `Legacy · ${formatGwei(p.gasPrice ?? 0n)} gwei`
                      : `EIP-1559 · max ${formatGwei(p.maxFeePerGas)} gwei, tip ${formatGwei(p.maxPriorityFeePerGas)} gwei`}
                  </td>
                </tr>
                <tr>
                  <th>{coin.kind === 'native' ? 'Value' : 'Calldata'}</th>
                  <td className="mono">{coin.kind === 'native' ? `${p.valueWei.toString()} wei` : p.data}</td>
                </tr>
              </tbody>
            </table>
          </details>
        )}
        <p className="small muted mb-0">
          Review carefully: these are exactly the values that will be signed. The quote, the network and your balances are checked once more
          before signing.
        </p>
      </div>
      <div className="cta-bar">
        <div className="actions-split">
          <button className="btn" data-testid="payin-review-back" onClick={onBack} disabled={step !== null}>
            Back
          </button>
          {exp || problem?.fix === 'requote' ? (
            <button className="btn btn-primary" data-testid="payin-requote" onClick={onRequote}>
              Get a new quote
            </button>
          ) : problem ? (
            <button className="btn btn-primary" data-testid="payin-recheck" onClick={onRecheck}>
              Check again
            </button>
          ) : (
            <button className="btn btn-primary" data-testid="payin-sign" onClick={onSign} disabled={step !== null || !p}>
              {step ? (
                <>
                  <Spinner /> {step === 'checking' ? 'Checking…' : 'Signing…'}
                </>
              ) : (
                `Sign & send on ${chain.name}`
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

