import { useState } from 'react';
import type { ChainState } from '../App.tsx';
import type { TokenRow } from '../state/useTokens.ts';
import type { AccountsApi } from '../state/useAccounts.ts';
import { findByAddress } from '../lib/accounts.ts';
import { Identicon } from '../components/Identicon.tsx';
import { CHAIN_ID, EXPLORER_URL, NATIVE_SYMBOL } from '../config.ts';
import {
  checkAddress,
  checkAmount,
  formatAmount,
  formatAmountExact,
  maxSendableWei,
  shortAddress,
} from '../lib/validate.ts';
import {
  prepareTransaction,
  signAndBroadcast,
  getFeeInfo,
  NATIVE_TRANSFER_GAS,
  type PreparedTx,
} from '../lib/tx.ts';
import { prepareTokenTransfer, type TokenMeta } from '../lib/tokens.ts';
import type { QrTarget } from '../lib/qr.ts';
import { Spinner } from '../components/ui.tsx';
import { ScannerModal } from './ScannerModal.tsx';

type Phase =
  | { kind: 'edit' }
  | { kind: 'preparing' }
  | { kind: 'confirm'; prepared: PreparedTx }
  | { kind: 'submitting'; prepared: PreparedTx }
  | { kind: 'pending'; hash: string }
  | { kind: 'confirmed'; hash: string }
  | { kind: 'failed'; message: string; hash?: string };

export function SendPanel({
  api,
  chain,
  nativeBalance,
  tokens,
  asset,
  onAssetChange,
  onSent,
}: {
  api: AccountsApi;
  chain: ChainState;
  nativeBalance: bigint | null;
  tokens: TokenRow[];
  asset: TokenMeta | null;
  onAssetChange: (m: TokenMeta | null) => void;
  onSent: () => void;
}) {
  const wallet = api.active;
  const ownAccounts = api.accounts.filter((a) => a.id !== wallet.id);
  const [ownOpen, setOwnOpen] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [maxBusy, setMaxBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNotice, setScanNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const provider = chain.provider;
  const decimals = asset?.decimals ?? 18;
  const symbol = asset?.symbol ?? NATIVE_SYMBOL;
  const tokenRow = asset ? tokens.find((t) => t.address === asset.address.toLowerCase()) : undefined;
  const assetBalance = asset ? (tokenRow?.balance ?? null) : nativeBalance;

  function reset(keepFields = false) {
    setPhase({ kind: 'edit' });
    setFormError(null);
    setOwnOpen(false);
    if (!keepFields) {
      setTo('');
      setAmount('');
      setToError(null);
      setAmountError(null);
      setScanNotice(null);
    }
  }

  /**
   * Apply a scanned/pasted payment code to the form.
   *
   * An EIP-681 `value` is always denominated in the NATIVE coin, so a code that
   * carries one also forces the asset back to FMX — silently filling a wei
   * figure into a token amount field would be a way to send the wrong asset.
   * A bare address carries no asset information, so the current selection is
   * left alone.
   */
  function applyScan(target: QrTarget) {
    setToError(null);
    setFormError(null);

    if (target.kind === 'address') {
      setTo(target.address);
      if (target.amount === undefined) {
        setScanNotice({ tone: 'ok', text: 'Recipient filled from the scanned code.' });
        return;
      }
      if (asset !== null) onAssetChange(null);
      setAmount(formatAmountExact(target.amount));
      setAmountError(null);
      setScanNotice({
        tone: 'ok',
        text: `Payment request read — ${formatAmountExact(target.amount)} ${NATIVE_SYMBOL} to ${target.address}.`,
      });
      return;
    }

    // ERC-20 transfer request.
    setTo(target.address);
    const row = tokens.find((t) => t.address === target.tokenAddress.toLowerCase() && t.meta);
    if (!row?.meta) {
      setScanNotice({
        tone: 'warn',
        text: `The recipient was filled in, but this code requests token ${target.tokenAddress}, which is not in your token list. Add it under Tokens, then scan again to have the amount filled too.`,
      });
      return;
    }
    onAssetChange(row.meta);
    if (target.amount === undefined) {
      setScanNotice({ tone: 'ok', text: `Token request read — asset switched to ${row.meta.symbol}.` });
      return;
    }
    setAmount(formatAmountExact(target.amount, row.meta.decimals));
    setAmountError(null);
    setScanNotice({
      tone: 'ok',
      text: `Token request read — ${formatAmountExact(target.amount, row.meta.decimals)} ${row.meta.symbol} to ${target.address}.`,
    });
  }

  async function useMax() {
    if (!provider) return;
    setAmountError(null);
    setMaxBusy(true);
    try {
      if (asset) {
        if (tokenRow?.balance == null) {
          setAmountError('Token balance unknown — cannot compute max.');
          return;
        }
        setAmount(formatAmountExact(tokenRow.balance, decimals));
      } else {
        if (nativeBalance === null) {
          setAmountError('Balance unknown — cannot compute max.');
          return;
        }
        const fees = await getFeeInfo(provider);
        const max = maxSendableWei(nativeBalance, NATIVE_TRANSFER_GAS, fees.maxFeePerGas);
        if (max === 0n) {
          setAmountError('Balance does not cover the network fee.');
          return;
        }
        setAmount(formatAmountExact(max));
      }
    } catch {
      setAmountError('Could not fetch fee data to compute max.');
    } finally {
      setMaxBusy(false);
    }
  }

  async function review() {
    setFormError(null);
    const addr = checkAddress(to);
    setToError(addr.ok ? null : addr.error);
    const amt = checkAmount(amount, decimals);
    setAmountError(amt.ok ? null : amt.error);
    if (!addr.ok || !amt.ok) return;
    if (!provider) {
      setFormError('Not connected to the network.');
      return;
    }
    if (asset && assetBalance !== null && amt.wei > assetBalance) {
      setAmountError(`Exceeds your ${symbol} balance (${formatAmount(assetBalance, decimals)}).`);
      return;
    }
    if (!asset && nativeBalance !== null && amt.wei > nativeBalance) {
      setAmountError(`Exceeds your balance (${formatAmount(nativeBalance)} ${NATIVE_SYMBOL}).`);
      return;
    }
    setPhase({ kind: 'preparing' });
    try {
      const prepared = asset
        ? await prepareTokenTransfer(provider, CHAIN_ID, wallet.address, asset.address, addr.address, amt.wei)
        : await prepareTransaction(provider, CHAIN_ID, wallet.address, addr.address, amt.wei);
      // Worst-case affordability check against the native balance.
      const nativeDebit = prepared.valueWei + prepared.maxFeeWei;
      if (nativeBalance !== null && nativeDebit > nativeBalance) {
        setPhase({ kind: 'edit' });
        setFormError(
          `Amount plus worst-case fee (${formatAmount(prepared.maxFeeWei, 18, 8)} ${NATIVE_SYMBOL}) exceeds your balance. Use Max to account for fees.`,
        );
        return;
      }
      setPhase({ kind: 'confirm', prepared });
    } catch (e) {
      setPhase({ kind: 'edit' });
      setFormError(e instanceof Error ? shortenError(e.message) : 'Could not prepare the transaction.');
    }
  }

  async function submit(prepared: PreparedTx) {
    if (!provider) return;
    setPhase({ kind: 'submitting', prepared });
    try {
      const sent = await signAndBroadcast(wallet.privateKey, provider, prepared);
      setPhase({ kind: 'pending', hash: sent.hash });
      const receipt = await sent.response.wait();
      if (receipt && receipt.status === 1) {
        setPhase({ kind: 'confirmed', hash: sent.hash });
      } else {
        setPhase({ kind: 'failed', message: 'Transaction was included in a block but reverted.', hash: sent.hash });
      }
      onSent();
    } catch (e) {
      setPhase({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Broadcast failed.' });
    }
  }

  /* ---------------- render ---------------- */

  if (phase.kind === 'confirm' || phase.kind === 'submitting') {
    const p = phase.prepared;
    const isToken = asset !== null;
    const toCheck = checkAddress(to);
    const recipientDisplay = isToken ? (toCheck.ok ? toCheck.address : '') : p.to;
    return (
      <div>
        <p className="small muted">
          Review carefully — the values below are exactly what will be signed.
        </p>
        <table className="confirm-table">
          <tbody>
            <tr>
              <th>From</th>
              <td>
                {wallet.label} <span className="mono muted">{shortAddress(wallet.address)}</span>
              </td>
            </tr>
            <tr>
              <th>Asset</th>
              <td>{isToken ? `${asset.symbol} — ${asset.name}` : `${NATIVE_SYMBOL} (native coin)`}</td>
            </tr>
            {isToken && (
              <tr>
                <th>Token contract</th>
                <td className="mono">{asset.address}</td>
              </tr>
            )}
            <tr>
              <th>To</th>
              <td className="mono">{recipientDisplay}</td>
            </tr>
            <tr>
              <th>Amount</th>
              <td className="em num">
                {isToken ? `${amount.trim()} ${asset.symbol}` : `${formatAmountExact(p.valueWei)} ${NATIVE_SYMBOL}`}
              </td>
            </tr>
            <tr>
              <th>Network fee (max)</th>
              <td className="num">
                {formatAmount(p.maxFeeWei, 18, 8)} {NATIVE_SYMBOL}
              </td>
            </tr>
            <tr>
              <th>Max total debit</th>
              <td className="em num">
                {isToken
                  ? `${amount.trim()} ${asset.symbol} + ${formatAmount(p.maxFeeWei, 18, 8)} ${NATIVE_SYMBOL}`
                  : `${formatAmountExact(p.valueWei + p.maxFeeWei)} ${NATIVE_SYMBOL}`}
              </td>
            </tr>
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
          </tbody>
        </table>
        <div className="actions-row">
          <button className="btn" onClick={() => reset(true)} disabled={phase.kind === 'submitting'}>
            Back
          </button>
          <span className="push" />
          <button
            className="btn btn-primary"
            onClick={() => void submit(p)}
            disabled={phase.kind === 'submitting'}
          >
            {phase.kind === 'submitting' ? (
              <>
                <Spinner /> Signing…
              </>
            ) : (
              'Sign & send'
            )}
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'pending') {
    return (
      <TxStatus
        title="Transaction submitted"
        hash={phase.hash}
        body="Waiting for confirmation on the Ferminux Network…"
        spinner
      />
    );
  }

  if (phase.kind === 'confirmed') {
    return (
      <div>
        <div className="notice notice-success">Transaction confirmed.</div>
        <HashLine hash={phase.hash} />
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => reset()}>
          Send another
        </button>
      </div>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <div>
        <div className="notice notice-danger">{phase.message}</div>
        {phase.hash && <HashLine hash={phase.hash} />}
        <button className="btn" style={{ marginTop: 16 }} onClick={() => reset(true)}>
          Back to edit
        </button>
      </div>
    );
  }

  // edit / preparing
  const preparing = phase.kind === 'preparing';
  const recipientCheck = to.trim() === '' ? null : checkAddress(to);
  const recipientOwn =
    recipientCheck?.ok === true ? findByAddress(api.accounts, recipientCheck.address) : undefined;
  return (
    <div>
      <div className="send-from">
        <Identicon address={wallet.address} size={20} />
        <span>
          Sending from <strong>{wallet.label}</strong>{' '}
          <span className="mono muted">{shortAddress(wallet.address)}</span>
        </span>
      </div>

      <div className="field">
        <label htmlFor="send-asset">Asset</label>
        <select
          id="send-asset"
          className="input"
          value={asset ? asset.address.toLowerCase() : 'native'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'native') onAssetChange(null);
            else {
              const row = tokens.find((t) => t.address === v);
              if (row?.meta) onAssetChange(row.meta);
            }
            setAmountError(null);
          }}
          disabled={preparing}
        >
          <option value="native">{NATIVE_SYMBOL} — native coin</option>
          {tokens
            .filter((t) => t.meta)
            .map((t) => (
              <option key={t.address} value={t.address}>
                {t.meta!.symbol} — {t.meta!.name}
              </option>
            ))}
        </select>
        {assetBalance !== null && (
          <div className="field-hint num">
            Available: {formatAmount(assetBalance, decimals)} {symbol}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="send-to">Recipient address</label>
        <div className="input-row">
          <input
            id="send-to"
            className={'input input-mono' + (toError ? ' input-error' : '')}
            placeholder="0x…"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setToError(null);
              setScanNotice(null);
            }}
            onBlur={() => {
              if (to.trim() !== '') {
                const c = checkAddress(to);
                setToError(c.ok ? null : c.error);
              }
            }}
            disabled={preparing}
            spellCheck={false}
            autoComplete="off"
          />
          {ownAccounts.length > 0 && (
            <button
              className="btn"
              type="button"
              data-testid="own-accounts-open"
              aria-expanded={ownOpen}
              onClick={() => setOwnOpen((o) => !o)}
              disabled={preparing}
              title="Send to another account in this wallet"
            >
              My accounts
            </button>
          )}
          <button
            className="btn"
            type="button"
            data-testid="scan-open"
            onClick={() => setScanOpen(true)}
            disabled={preparing}
            title="Scan a QR code with the camera, an image, or a pasted link"
          >
            <ScanGlyph /> Scan
          </button>
        </div>
        {toError && <div className="field-error">{toError}</div>}

        {ownOpen && ownAccounts.length > 0 && (
          <div className="own-picker" data-testid="own-picker">
            <div className="own-picker-head">Your accounts on this device</div>
            <ul>
              {ownAccounts.map((account) => (
                <li key={account.id}>
                  <button
                    type="button"
                    data-testid={`own-pick-${account.address.toLowerCase()}`}
                    onClick={() => {
                      setTo(account.address);
                      setToError(null);
                      setOwnOpen(false);
                      setScanNotice({
                        tone: 'ok',
                        text: `Recipient set to your own account "${account.label}".`,
                      });
                    }}
                  >
                    <Identicon address={account.address} size={22} />
                    <span className="own-picker-main">
                      <span className="own-picker-label">{account.label}</span>
                      <span className="own-picker-addr mono">{shortAddress(account.address)}</span>
                    </span>
                    <span className="acct-tag">
                      {account.kind === 'hd' ? `HD #${account.index}` : 'IMPORTED'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recipientOwn && (
          <div className="field-hint own-hint">
            <Identicon address={recipientOwn.address} size={16} /> This is your own account “{recipientOwn.label}”
            {recipientOwn.id === wallet.id ? ' — the active one, so this would be a transfer to yourself.' : '.'}
          </div>
        )}
      </div>

      {scanNotice && (
        <div
          className={'notice ' + (scanNotice.tone === 'warn' ? 'notice-warn' : '')}
          style={{ marginTop: -4 }}
        >
          {scanNotice.text}
        </div>
      )}

      <div className="field">
        <label htmlFor="send-amount">Amount</label>
        <div className="input-row">
          <input
            id="send-amount"
            className={'input num' + (amountError ? ' input-error' : '')}
            placeholder="0.0"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountError(null);
            }}
            disabled={preparing}
            autoComplete="off"
          />
          <button className="btn" onClick={() => void useMax()} disabled={preparing || maxBusy || !provider}>
            {maxBusy ? <Spinner /> : 'Max'}
          </button>
        </div>
        {amountError && <div className="field-error">{amountError}</div>}
        {!asset && (
          <div className="field-hint">Max reserves worst-case gas (21,000 × current max fee) so the send cannot fail on fees.</div>
        )}
      </div>

      {formError && <div className="field-error" style={{ marginBottom: 14 }}>{formError}</div>}

      <button
        className="btn btn-primary"
        onClick={() => void review()}
        disabled={preparing || !provider || to.trim() === '' || amount.trim() === ''}
      >
        {preparing ? (
          <>
            <Spinner /> Preparing…
          </>
        ) : (
          'Review transaction'
        )}
      </button>
      {!provider && <div className="field-hint" style={{ marginTop: 10 }}>Sending is disabled while offline.</div>}

      {scanOpen && <ScannerModal onClose={() => setScanOpen(false)} onResult={applyScan} />}
    </div>
  );
}

/** 20×20 viewfinder glyph — inline SVG, no icon font, no network. */
function ScanGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2 7V4a2 2 0 0 1 2-2h3M13 2h3a2 2 0 0 1 2 2v3M18 13v3a2 2 0 0 1-2 2h-3M7 18H4a2 2 0 0 1-2-2v-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M2 10h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

function HashLine({ hash }: { hash: string }) {
  return (
    <p className="small" style={{ wordBreak: 'break-all' }}>
      <span className="muted">Tx </span>
      <span className="mono">{hash}</span>{' '}
      <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer noopener">
        View on explorer ↗
      </a>
    </p>
  );
}

function TxStatus({ title, hash, body, spinner }: { title: string; hash: string; body: string; spinner?: boolean }) {
  return (
    <div>
      <p style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 550 }}>
        {spinner && <Spinner />} {title}
      </p>
      <p className="small muted">{body}</p>
      <HashLine hash={hash} />
    </div>
  );
}

/** Trim noisy RPC error strings to something a human can act on. */
function shortenError(message: string): string {
  const cut = message.split(/\s*\(action=|\s*\[ See:/)[0];
  return cut.length > 220 ? cut.slice(0, 220) + '…' : cut;
}
