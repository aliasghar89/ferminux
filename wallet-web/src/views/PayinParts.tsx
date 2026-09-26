// Pieces of "Buy FMX with a coin on another network" (the pay-in): the
// picker's Other networks section, the coin glyph, the list of this account's
// purchases and the status tracker (quoted → seen → confirmed → paid).

import { useEffect, useState } from 'react';
import { FERMINUX_CHAIN, explorerAddressUrl, explorerTxUrl, type ChainDef } from '../lib/chains.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import {
  canStillPay,
  formatCountdown,
  networkOf,
  payinCoin,
  payinCoinKey,
  payinCoins,
  payinNetworks,
  secondsLeft,
  trackerStep,
  type PayinAssets,
  type PayinCoin,
  type PayinRecord,
} from '../lib/payin.ts';
import { AssetGlyph, ChainBadge } from '../components/ChainBadge.tsx';
import { CopyButton, Spinner } from '../components/ui.tsx';
import { IconCheck, IconChevronRight, IconClose, IconExternal } from '../components/icons.tsx';

/** Whole seconds, ticking every `periodMs` while mounted. */
export function useNowS(periodMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

/** A coin's monogram; `corner` adds its network's tag (left off where the network is named beside it). */
export function CoinGlyph({ coin, corner = true }: { coin: PayinCoin; corner?: boolean }) {
  return <AssetGlyph symbol={coin.symbol} native={coin.kind === 'native'} home={false} chain={corner ? coin.chain : undefined} />;
}

export const fmxText = (wei: bigint | string, digits = 4) => formatAmount(BigInt(wei), 18, digits);

/* ------------------------------------------------------------------ */
/* Picker section                                                      */
/* ------------------------------------------------------------------ */

function coinMatches(c: PayinCoin, query: string): boolean {
  const s = query.trim().toLowerCase();
  const chain = c.chain;
  return !s || c.symbol.toLowerCase().includes(s) || c.name.toLowerCase().includes(s) || chain.name.toLowerCase().includes(s) || chain.short.toLowerCase() === s;
}

/** Whether the Other networks section has anything for this search. */
export function payinPickerMatches(query: string): boolean {
  return payinNetworks().some((chain) => payinCoins(chain).some((c) => coinMatches(c, query)));
}

export function PayinPickerSection({
  query,
  assets,
  state,
  balanceOf,
  selected,
  onPick,
}: {
  query: string;
  assets: PayinAssets | null;
  state: 'loading' | 'ok' | 'error';
  balanceOf: (chainId: number, address: string | null) => bigint | null;
  /** payinCoinKey of the coin in use, if buying. */
  selected: string | null;
  onPick: (coinKey: string) => void;
}) {
  const off = assets !== null && !assets.enabled;
  const groups = payinNetworks()
    .map((chain) => ({
      chain,
      net: networkOf(assets, chain.key),
      coins: payinCoins(chain).filter((c) => coinMatches(c, query)),
    }))
    .filter((g) => g.coins.length > 0);
  if (groups.length === 0) return null;
  return (
    <>
      <li className="token-section-head" data-testid="payin-section">
        <span>Other networks</span>
        <span className="faint">
          {off ? 'pay-in switched off' : state === 'loading' && !assets ? 'checking networks…' : state === 'error' && !assets ? 'availability unknown' : 'buys FMX, paid on that network'}
        </span>
      </li>
      {groups.map(({ chain, net, coins }) => {
        // Unknown availability (list not read yet, or unreadable) is offered: the quote route has the last word.
        const down = off || (net !== null && !net.available);
        return [
          <li key={`${chain.key}-head`} className="token-net-head" data-testid={`payin-net-${chain.key}`} data-available={down ? 'false' : 'true'}>
            <ChainBadge chain={chain} withName />
            <span className="token-net-note">
              {down ? (net?.reason ? `Not taking payments: ${net.reason}` : 'Not taking payments right now') : net ? `${net.confirmations} confirmations` : ''}
            </span>
          </li>,
          ...coins.map((c) => {
            const key = payinCoinKey(c);
            const coinDown = down || (net !== null && !net.coins.includes(c.symbol));
            const bal = balanceOf(chain.id, c.address);
            return (
              <li key={key}>
                <button
                  className="token-row"
                  data-testid={`swap-pick-payin-${chain.key}-${c.symbol}`}
                  aria-current={key === selected ? 'true' : undefined}
                  disabled={coinDown}
                  onClick={() => onPick(key)}
                >
                  <CoinGlyph coin={c} />
                  <span className="token-row-main">
                    <span className="token-row-sym">{c.symbol}</span>
                    <span className="token-row-name">
                      {c.kind === 'native' ? 'Native coin' : c.name} · {chain.name}
                    </span>
                  </span>
                  <span className="token-row-bal num">{bal === null ? '—' : formatAmount(bal, c.decimals, 4)}</span>
                </button>
              </li>
            );
          }),
        ];
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Purchases                                                           */
/* ------------------------------------------------------------------ */

const STATUS_TEXT: Record<string, string> = {
  quoted: 'Waiting for payment',
  seen: 'Payment seen',
  confirmed: 'Sending FMX',
  paid: 'FMX delivered',
  expired: 'Expired',
  failed: 'Failed',
  superseded: 'Replaced',
};

/** A purchase worth listing: paid for (or being paid), or a quote that can still be paid. */
export function listed(r: PayinRecord, nowS: number): boolean {
  return r.localState !== 'none' || r.status === 'seen' || r.status === 'confirmed' || r.status === 'paid' || canStillPay(r, nowS);
}

export function statusTag(r: PayinRecord, nowS: number): { text: string; tone: 'ok' | 'bad' | 'wait' | 'open' } {
  const { done, bad } = trackerStep(r);
  if (done === 4) return { text: STATUS_TEXT.paid!, tone: 'ok' };
  if (bad === 'reverted') return { text: 'Transfer reverted', tone: 'bad' };
  if (bad === 'dropped') return { text: 'Not sent', tone: 'bad' };
  if (bad) return { text: STATUS_TEXT[bad] ?? bad, tone: 'bad' };
  if (r.status === 'quoted' && r.localState === 'none') return { text: canStillPay(r, nowS) ? 'Not paid yet' : 'Expired', tone: 'open' };
  if (r.status === 'seen') return { text: `Confirming ${r.confirmations}/${r.required}`, tone: 'wait' };
  if (r.status === 'confirmed') return { text: STATUS_TEXT.confirmed!, tone: 'wait' };
  return { text: r.localState === 'signed' ? 'Checking transfer' : 'Sent · waiting', tone: 'wait' };
}

export function PurchasesList({ records, nowS, onOpen }: { records: PayinRecord[]; nowS: number; onOpen: (quoteId: string) => void }) {
  const shown = records.filter((r) => listed(r, nowS)).slice(0, 8);
  if (shown.length === 0) return null;
  return (
    <section className="panel buy-purchases" aria-label="Your FMX purchases" data-testid="payin-purchases">
      <div className="panel-head">
        <h2>FMX purchases</h2>
        <span className="spacer" />
        <span className="small faint">this device</span>
      </div>
      <ul className="row-list">
        {shown.map((r) => {
          const coin = payinCoin(r.chain, r.asset);
          if (!coin) return null;
          const tag = statusTag(r, nowS);
          return (
            <li key={r.quoteId}>
              <button className="purchase-row" data-testid={`payin-purchase-${r.quoteId}`} data-status={r.status} onClick={() => onOpen(r.quoteId)}>
                <CoinGlyph coin={coin} />
                <span className="row-main">
                  <span className="row-title">
                    <span className="num">{formatAmount(BigInt(r.sendExactly), r.decimals, 6)}</span> {coin.symbol}
                    <span className="faint" aria-hidden="true">→</span>
                    <span className="num">{fmxText(r.fmxOut, 2)}</span> FMX
                  </span>
                  <span className="row-sub">
                    {coin.chain.name} · {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                <span className={`dir-badge ${tag.tone === 'ok' ? 'dir-in' : tag.tone === 'bad' ? 'dir-fail' : tag.tone === 'open' ? 'dir-signed' : 'dir-out'}`}>{tag.text}</span>
                <IconChevronRight />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tracker                                                             */
/* ------------------------------------------------------------------ */

function TxLink({ chain, hash, testId }: { chain: ChainDef; hash: string; testId?: string }) {
  return (
    <a className="track-link" href={explorerTxUrl(chain, hash)} target="_blank" rel="noreferrer noopener" data-testid={testId} title={`View on ${chain.explorer.name}`}>
      <span className="mono">
        {hash.slice(0, 10)}…{hash.slice(-6)}
      </span>
      <IconExternal />
    </a>
  );
}

export function PayinTracker({
  record: r,
  onBack,
  onPay,
  onBuyAgain,
}: {
  record: PayinRecord;
  onBack: () => void;
  /** Review and pay a quote this wallet has not paid yet. */
  onPay: () => void;
  onBuyAgain: () => void;
}) {
  const nowS = useNowS();
  const coin = payinCoin(r.chain, r.asset);
  if (!coin) return null;
  const chain = coin.chain;
  const { done, bad } = trackerStep(r);
  const amount = `${formatAmountExact(BigInt(r.sendExactly), r.decimals)} ${coin.symbol}`;
  const fmx = `${fmxText(r.fmxOut, 6)} FMX`;
  const unpaid = r.status === 'quoted' && r.localState === 'none';
  const left = secondsLeft(r.expiresAt, nowS);
  const payable = canStillPay(r, nowS);

  let icon: 'ok' | 'bad' | 'wait' | 'idle' = 'wait';
  let title: string;
  let body: string;
  if (done === 4) {
    icon = 'ok';
    title = 'FMX delivered';
    body = `${fmx} sent to ${shortAddress(r.to)} on the Ferminux Network.`;
  } else if (bad === 'failed') {
    icon = 'bad';
    title = 'The pay-in could not complete this purchase';
    body = `${r.error ?? 'No reason was given.'} Keep the quote id ${r.quoteId} and contact support.`;
  } else if (bad === 'expired') {
    icon = 'bad';
    title = 'Quote expired';
    body =
      r.localState === 'none'
        ? 'Nothing was sent for this quote. Get a new quote to buy.'
        : `The quote expired before the pay-in saw your transfer. Keep the quote id ${r.quoteId} and contact support: the transfer is on ${chain.name}.`;
  } else if (bad === 'reverted') {
    icon = 'bad';
    title = `Transfer reverted on ${chain.name}`;
    body = 'Nothing was paid; only the network fee was spent. Get a new quote to try again.';
  } else if (bad === 'dropped') {
    icon = 'bad';
    title = `Transfer not found on ${chain.name}`;
    body = 'This wallet signed it, but it never reached the network, so nothing was paid. Get a new quote to try again.';
  } else if (bad === 'superseded') {
    icon = 'bad';
    title = 'Replaced by a newer quote';
    body = 'You asked for a newer quote on the same network and coin. Nothing was sent for this one.';
  } else if (unpaid) {
    icon = 'idle';
    title = payable ? 'Not paid yet' : 'Quote about to expire';
    body = payable ? `Pay within ${formatCountdown(left)} to keep this quote.` : 'Less than a minute is left on this quote: get a new one.';
  } else if (r.status === 'seen') {
    title = 'Payment seen, confirming';
    body = `${r.confirmations}/${r.required} confirmations on ${chain.name}. FMX is sent once they are in.`;
  } else if (r.status === 'confirmed') {
    title = 'Confirmed, sending FMX';
    body = `The pay-in is sending ${fmx} to ${shortAddress(r.to)} on the Ferminux Network.`;
  } else if (r.localState === 'signed') {
    title = 'Checking your transfer';
    body = `Looking for the transfer on ${chain.name}…`;
  } else {
    title = 'Transfer sent';
    body = `Waiting for the pay-in to see it on ${chain.name}. It checks the network every few seconds; FMX follows after ${r.required} confirmations.`;
  }

  const steps = [
    `Sent on ${chain.name}`,
    'Seen by the pay-in',
    r.status === 'seen' ? `Confirming · ${r.confirmations}/${r.required}` : `Confirmed · ${r.required} confirmations`,
    'FMX delivered on Ferminux',
  ];
  const depositOther = r.depositTx && r.depositTx !== r.localTx ? r.depositTx : null;

  return (
    <div className="swap-flow" data-testid="payin-track" data-status={r.status} data-local={r.localState} data-done={done} data-bad={bad ?? ''}>
      <div className="panel send-card">
        <div className="tx-state">
          <div className={'state-ic' + (icon === 'ok' ? ' ok' : icon === 'bad' ? ' bad' : '')}>
            {icon === 'ok' ? <IconCheck /> : icon === 'bad' ? <IconClose /> : icon === 'wait' ? <Spinner /> : <span className="num track-clock">{formatCountdown(left)}</span>}
          </div>
          <h3 data-testid="payin-track-title">{title}</h3>
          <p style={{ overflowWrap: 'anywhere' }}>{body}</p>
        </div>

        <ol className="track-steps" aria-label="Purchase progress">
          {steps.map((label, i) => {
            const state = bad && i === done ? 'bad' : i < done ? 'done' : i === done && !unpaid && !bad ? 'on' : '';
            return (
              <li key={i} data-testid={`payin-step-${i + 1}`} data-state={state || 'todo'}>
                <span className={'track-dot ' + state}>{state === 'done' ? <IconCheck /> : state === 'bad' ? <IconClose /> : i + 1}</span>
                <span className={'track-label' + (state === '' ? ' faint' : '')}>
                  {label}
                  {i === 0 && r.localTx && <TxLink chain={chain} hash={r.localTx} testId="payin-local-tx" />}
                  {i === 1 && depositOther && <TxLink chain={chain} hash={depositOther} testId="payin-deposit-tx" />}
                  {i === 3 && r.fmxTx && <TxLink chain={FERMINUX_CHAIN} hash={r.fmxTx} testId="payin-fmx-tx" />}
                  {i === 3 && !r.fmxTx && r.note && done === 4 && <span className="small faint"> · {r.note}</span>}
                </span>
              </li>
            );
          })}
        </ol>

        <table className="confirm-table" style={{ marginBottom: 0 }}>
          <tbody>
            <tr>
              <th>{unpaid ? 'Send exactly' : 'Sent'}</th>
              <td className="num" data-testid="payin-track-amount">
                {amount} <span className="muted">· {chain.name}</span>
              </td>
            </tr>
            <tr>
              <th>You receive</th>
              <td className="num">{fmx}</td>
            </tr>
            <tr>
              <th>FMX recipient</th>
              <td className="mono">{r.to}</td>
            </tr>
            <tr>
              <th>Deposit address</th>
              <td>
                <a className="mono" href={explorerAddressUrl(chain, r.depositAddress)} target="_blank" rel="noreferrer noopener">
                  {r.depositAddress}
                </a>
              </td>
            </tr>
            <tr>
              <th>Quote id</th>
              <td>
                <span className="mono" data-testid="payin-track-id">
                  {r.quoteId}
                </span>{' '}
                <CopyButton text={r.quoteId} label="Copy quote id" iconOnly />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="cta-bar">
        {unpaid && payable ? (
          <div className="actions-split">
            <button className="btn" onClick={onBack}>
              Back
            </button>
            <button className="btn btn-primary" data-testid="payin-track-pay" onClick={onPay}>
              Review and pay
            </button>
          </div>
        ) : done === 4 || bad ? (
          <div className="actions-split">
            <button className="btn" data-testid="payin-track-back" onClick={onBack}>
              Back to Swap
            </button>
            <button className="btn btn-primary" data-testid="payin-buy-again" onClick={onBuyAgain}>
              {done === 4 ? 'Buy more FMX' : 'Get a new quote'}
            </button>
          </div>
        ) : (
          <button className="btn btn-block" data-testid="payin-track-back" onClick={onBack}>
            Back to Swap
          </button>
        )}
      </div>
      {!bad && done < 4 && <p className="small faint track-foot">This screen checks every 10 seconds; after a reload it is under Swap → FMX purchases.</p>}
    </div>
  );
}
