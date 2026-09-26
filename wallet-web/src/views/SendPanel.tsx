import { useEffect, useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { findByAddress } from '../lib/accounts.ts';
import { Identicon } from '../components/Identicon.tsx';
import { ChainBadge } from '../components/ChainBadge.tsx';
import { CHAIN_ID } from '../config.ts';
import { CHAINS, chainById, explorerTxUrl, type ChainDef } from '../lib/chains.ts';
import {
  checkAddress,
  checkAmount,
  formatAmount,
  formatAmountExact,
  formatGwei,
  isPersonalAccountCode,
  maxSendableWei,
  sendRecipientProblem,
  shortAddress,
} from '../lib/validate.ts';
import {
  feePolicyFor,
  nativeTransferMaxFee,
  prepareTransaction,
  receiptOf,
  signAndBroadcast,
  type PreparedTx,
} from '../lib/tx.ts';
import { prepareTokenTransfer } from '../lib/tokens.ts';
import { balanceFor, type AssetRef } from '../lib/portfolio.ts';
import { providerFor } from '../lib/providers.ts';
import type { LocalTx, LocalTxStatus } from '../lib/localActivity.ts';
import type { QrTarget } from '../lib/qr.ts';
import { Spinner } from '../components/ui.tsx';
import { AssetGlyph } from '../components/ChainBadge.tsx';
import { IconCheck, IconChevronDown, IconClose, IconExternal, IconUsers } from '../components/icons.tsx';
import { ScannerModal, paymentScanMode } from './ScannerModal.tsx';

/** What the form is sending: a chain and an asset on it (null address = native coin). */
export interface SendSelection {
  chainId: number;
  asset: string | null;
}

type Phase =
  | { kind: 'edit' }
  | { kind: 'preparing' }
  | { kind: 'confirm'; prepared: PreparedTx; contractRecipient?: boolean }
  | { kind: 'submitting'; prepared: PreparedTx; contractRecipient?: boolean }
  | { kind: 'pending'; hash: string }
  | { kind: 'confirmed'; hash: string }
  | { kind: 'failed'; message: string; hash?: string };

/** The home chain uses App's probed provider; every other chain gets one on demand. */
export async function sendProvider(chain: ChainDef, home: ChainState): Promise<JsonRpcProvider> {
  if (chain.id === CHAIN_ID) {
    if (!home.provider) throw new Error('Not connected to the Ferminux Network.');
    return home.provider;
  }
  return providerFor(chain);
}

export function SendPanel({
  api,
  chain: home,
  portfolio,
  selection,
  onSelectionChange,
  onSent,
  onRecord,
  onStatus,
  initialScan = null,
  onScanUsed,
}: {
  api: AccountsApi;
  chain: ChainState;
  portfolio: PortfolioApi;
  selection: SendSelection;
  onSelectionChange: (s: SendSelection) => void;
  onSent: (chainId: number) => void;
  onRecord: (tx: LocalTx) => void;
  onStatus: (chainId: number, hash: string, status: LocalTxStatus) => void;
  /** A code scanned before this screen opened (Home → Scan): applied once. */
  initialScan?: QrTarget | null;
  onScanUsed?: () => void;
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
  // The chain a submitted transaction went to, fixed at submit time so a later
  // selection change cannot relabel a pending/confirmed screen.
  const [sentChainId, setSentChainId] = useState<number | null>(null);

  const chain = chainById(selection.chainId) ?? CHAINS[0];
  const isHome = chain.id === CHAIN_ID;
  const assets = portfolio.assetsByChain.get(chain.id) ?? [];
  const asset: AssetRef =
    assets.find((a) => (a.address ?? null)?.toLowerCase() === selection.asset?.toLowerCase()) ?? assets[0];
  const isToken = asset.address !== null;
  const decimals = asset.decimals;
  const symbol = asset.symbol;
  const nativeSymbol = chain.native.symbol;
  const assetBalance = balanceFor(portfolio.lastGood, chain.id, asset.address);
  const nativeBalance = balanceFor(portfolio.lastGood, chain.id, null);
  const policy = useMemo(() => feePolicyFor(chain, CHAIN_ID), [chain]);
  const connected = isHome ? home.provider !== null : true;
  const otherChainIds = useMemo(() => CHAINS.filter((c) => c.id !== chain.id).map((c) => c.id), [chain.id]);

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

  function select(next: SendSelection) {
    onSelectionChange(next);
    setAmountError(null);
    setFormError(null);
  }

  /**
   * Apply a scanned/pasted payment code to the form.
   *
   * A code naming another supported network moves the form to that network —
   * paying the address on the currently selected one could send funds where
   * the requester never looks. An EIP-681 `value` is always denominated in the
   * native coin, so a code that carries one also forces the asset back to it.
   * A bare address carries no network or asset, so the selection stays.
   */
  function applyScan(target: QrTarget) {
    setToError(null);
    setFormError(null);
    const targetChain = target.chainId !== undefined ? chainById(target.chainId) : undefined;
    const switched = targetChain && targetChain.id !== chain.id ? targetChain : null;
    const onChain = targetChain ?? chain;
    const prefix = switched ? `Network switched to ${switched.name} — the code is for that network. ` : '';

    if (target.kind === 'address') {
      setTo(target.address);
      if (target.amount === undefined) {
        if (switched) select({ chainId: switched.id, asset: null });
        setScanNotice({ tone: 'ok', text: `${prefix}Recipient filled from the scanned code.` });
        return;
      }
      select({ chainId: onChain.id, asset: null });
      setAmount(formatAmountExact(target.amount, onChain.native.decimals));
      setAmountError(null);
      setScanNotice({
        tone: 'ok',
        text: `${prefix}Payment request read — ${formatAmountExact(target.amount, onChain.native.decimals)} ${onChain.native.symbol} to ${target.address}.`,
      });
      return;
    }

    // Token transfer request.
    setTo(target.address);
    const tokenAsset = (portfolio.assetsByChain.get(onChain.id) ?? []).find(
      (a) => a.address !== null && a.address.toLowerCase() === target.tokenAddress.toLowerCase(),
    );
    if (!tokenAsset) {
      if (switched) select({ chainId: switched.id, asset: null });
      setScanNotice({
        tone: 'warn',
        text: `${prefix}The recipient was filled in, but this code requests token ${target.tokenAddress}, which is not in your list for ${onChain.name}. Add it under Assets, then scan again to have the amount filled too.`,
      });
      return;
    }
    select({ chainId: onChain.id, asset: tokenAsset.address });
    if (target.amount === undefined) {
      setScanNotice({ tone: 'ok', text: `${prefix}Token request read — asset switched to ${tokenAsset.symbol}.` });
      return;
    }
    setAmount(formatAmountExact(target.amount, tokenAsset.decimals));
    setAmountError(null);
    setScanNotice({
      tone: 'ok',
      text: `${prefix}Token request read — ${formatAmountExact(target.amount, tokenAsset.decimals)} ${tokenAsset.symbol} to ${target.address}.`,
    });
  }

  async function useMax() {
    setAmountError(null);
    setMaxBusy(true);
    try {
      if (isToken) {
        if (assetBalance === null) {
          setAmountError('Token balance unknown — cannot compute max.');
          return;
        }
        setAmount(formatAmountExact(assetBalance, decimals));
      } else {
        if (nativeBalance === null) {
          setAmountError('Balance unknown — cannot compute max.');
          return;
        }
        const provider = await sendProvider(chain, home);
        const recipient = checkAddress(to);
        const { feeWei, l1FeeUnknown } = await nativeTransferMaxFee(
          provider,
          chain.id,
          recipient.ok ? recipient.address : wallet.address,
          policy,
          { from: wallet.address, valueWei: nativeBalance },
        );
        const max = maxSendableWei(nativeBalance, 1n, feeWei);
        if (max === 0n) {
          setAmountError(`Balance does not cover the ${chain.name} network fee.`);
          return;
        }
        setAmount(formatAmountExact(max, decimals));
        if (l1FeeUnknown) setAmountError(`${chain.name}'s L1 data fee could not be read; leave a little ${nativeSymbol} spare.`);
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
    const recipientProblem = sendRecipientProblem(addr.address, isToken ? { address: asset.address as string, symbol } : null, assets);
    if (recipientProblem) {
      setToError(recipientProblem);
      return;
    }
    if (isToken && assetBalance !== null && amt.wei > assetBalance) {
      setAmountError(`Exceeds your ${symbol} balance on ${chain.name} (${formatAmount(assetBalance, decimals)}).`);
      return;
    }
    if (!isToken && nativeBalance !== null && amt.wei > nativeBalance) {
      setAmountError(`Exceeds your balance (${formatAmount(nativeBalance, decimals)} ${nativeSymbol} on ${chain.name}).`);
      return;
    }
    setPhase({ kind: 'preparing' });
    try {
      const provider = await sendProvider(chain, home);
      const [prepared, recipientCode] = await Promise.all([
        isToken
          ? prepareTokenTransfer(provider, chain.id, wallet.address, asset.address as string, addr.address, amt.wei, policy)
          : prepareTransaction(provider, chain.id, wallet.address, addr.address, amt.wei, '0x', policy),
        // A token transfer to a contract that does not expect it succeeds and
        // strands the tokens; the confirm screen says so (a native send to such
        // a contract fails its estimate instead).
        isToken ? provider.getCode(addr.address).catch(() => '0x') : Promise.resolve('0x'),
      ]);
      // Worst-case affordability, in the chain's own native coin.
      const nativeDebit = prepared.valueWei + prepared.maxFeeWei;
      if (nativeBalance !== null && nativeDebit > nativeBalance) {
        setPhase({ kind: 'edit' });
        setFormError(
          isToken
            ? `Not enough ${nativeSymbol} on ${chain.name} for the network fee: this needs up to ${formatAmount(prepared.maxFeeWei, chain.native.decimals, 8)} ${nativeSymbol}, the account has ${formatAmount(nativeBalance, chain.native.decimals, 8)} ${nativeSymbol}.`
            : `Amount plus worst-case fee (${formatAmount(prepared.maxFeeWei, chain.native.decimals, 8)} ${nativeSymbol}) exceeds your balance on ${chain.name}. Use Max to account for fees.`,
        );
        return;
      }
      setPhase({ kind: 'confirm', prepared, contractRecipient: !isPersonalAccountCode(recipientCode) });
    } catch (e) {
      setPhase({ kind: 'edit' });
      setFormError(e instanceof Error ? shortenError(e.message) : 'Could not prepare the transaction.');
    }
  }

  async function submit(prepared: PreparedTx, contractRecipient?: boolean) {
    setPhase({ kind: 'submitting', prepared, contractRecipient });
    setSentChainId(chain.id);
    const recipient = checkAddress(to);
    try {
      const provider = await sendProvider(chain, home);
      const sent = await signAndBroadcast(wallet.privateKey, provider, prepared);
      // Ferminux history comes from its explorer; other chains are logged here.
      if (!isHome) {
        const amt = checkAmount(amount, decimals);
        onRecord({
          chainId: chain.id,
          hash: sent.hash,
          from: wallet.address,
          to: recipient.ok ? recipient.address : prepared.to,
          kind: isToken ? 'token' : 'native',
          symbol,
          amount: (isToken ? (amt.ok ? amt.wei : 0n) : prepared.valueWei).toString(),
          decimals,
          contract: isToken ? asset.address : null,
          status: 'pending',
          createdAt: Date.now(),
        });
      }
      setPhase({ kind: 'pending', hash: sent.hash });
      const receipt = await receiptOf(sent.response);
      const ok = !!receipt && receipt.status === 1;
      if (!isHome) onStatus(chain.id, sent.hash, ok ? 'confirmed' : 'failed');
      setPhase(ok ? { kind: 'confirmed', hash: sent.hash } : { kind: 'failed', message: 'Transaction was included in a block but reverted.', hash: sent.hash });
      onSent(chain.id);
    } catch (e) {
      setPhase({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Broadcast failed.' });
    }
  }

  /* ---------------- render ---------------- */

  // A code scanned from Home fills the form once, as if scanned here.
  useEffect(() => {
    if (!initialScan) return;
    applyScan(initialScan);
    onScanUsed?.();
    // Applied once on mount; later scans come through this screen's own scanner.
  }, []);

  const shownChain = (sentChainId !== null && chainById(sentChainId)) || chain;

  if (phase.kind === 'confirm' || phase.kind === 'submitting') {
    const p = phase.prepared;
    const toCheck = checkAddress(to);
    const recipientDisplay = isToken ? (toCheck.ok ? toCheck.address : '') : p.to;
    const feeText = `${formatAmount(p.maxFeeWei, chain.native.decimals, 8)} ${nativeSymbol}`;
    const amountText = isToken ? amount.trim() : formatAmountExact(p.valueWei, decimals);
    return (
      <div data-testid="send-review-card">
        <div className="panel send-card">
          <ChainBanner chain={chain} />
          <div className="confirm-amount">
            <div className="label">You send</div>
            <div className="v num" data-testid="confirm-amount">
              {amountText}
              <span className="u">{isToken ? asset.symbol : nativeSymbol}</span>
            </div>
            <div className="to">
              to <span className="mono">{shortAddress(recipientDisplay || p.to)}</span>
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
                <td className="mono">{recipientDisplay}</td>
              </tr>
              <tr>
                <th>Asset</th>
                <td>{isToken ? `${asset.symbol} · ${asset.name}` : `${nativeSymbol} · native coin`}</td>
              </tr>
              {isToken && (
                <tr>
                  <th>Token contract</th>
                  <td className="mono">{asset.address}</td>
                </tr>
              )}
              <tr>
                <th>Network fee (max)</th>
                <td className="num">
                  {feeText}
                  {p.l1FeeWei !== undefined && <span className="muted"> · incl. L1 data fee</span>}
                  {p.l1FeeUnknown && <span className="muted"> · plus an L1 data fee that could not be read</span>}
                </td>
              </tr>
              <tr>
                <th>Max total debit</th>
                <td className="em num">
                  {isToken
                    ? `${amount.trim()} ${asset.symbol} + ${feeText}`
                    : `${formatAmountExact(p.valueWei + p.maxFeeWei, decimals)} ${nativeSymbol}`}
                </td>
              </tr>
            </tbody>
          </table>
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
              </tbody>
            </table>
          </details>
          {phase.contractRecipient && (
            <div className="notice notice-warn" data-testid="send-contract-recipient">
              The recipient is a contract, not a personal account. {asset.symbol} sent to a contract that is not built to receive it
              cannot be recovered — send only if this contract is meant to take {asset.symbol}.
            </div>
          )}
          <p className="small muted mb-0">Review carefully: these are exactly the values that will be signed.</p>
        </div>
        <div className="cta-bar">
          <div className="actions-split">
            <button className="btn" onClick={() => reset(true)} disabled={phase.kind === 'submitting'}>
              Back
            </button>
            <button
              className="btn btn-primary"
              data-testid="send-confirm"
              onClick={() => void submit(p, phase.contractRecipient)}
              disabled={phase.kind === 'submitting'}
            >
              {phase.kind === 'submitting' ? (
                <>
                  <Spinner /> Signing…
                </>
              ) : (
                `Sign & send on ${chain.name}`
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'pending') {
    return (
      <div className="panel send-card">
        <TxStatus
          title="Transaction submitted"
          chain={shownChain}
          hash={phase.hash}
          body={`Waiting for confirmation on ${shownChain.id === CHAIN_ID ? 'the Ferminux Network' : shownChain.name}…`}
          spinner
        />
      </div>
    );
  }

  if (phase.kind === 'confirmed') {
    return (
      <div data-testid="send-confirmed">
        <div className="panel send-card">
          <div className="tx-state">
            <div className="state-ic ok">
              <IconCheck />
            </div>
            <h3>Sent</h3>
            <p>Transaction confirmed on {shownChain.name}.</p>
            <HashLine chain={shownChain} hash={phase.hash} />
          </div>
        </div>
        <div className="cta-bar">
          <button className="btn btn-primary btn-block" onClick={() => reset()}>
            Send another
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <div>
        <div className="panel send-card">
          <div className="tx-state">
            <div className="state-ic bad">
              <IconClose />
            </div>
            <h3>Not sent</h3>
            <p style={{ overflowWrap: 'anywhere' }}>{phase.message}</p>
            {phase.hash && <HashLine chain={shownChain} hash={phase.hash} />}
          </div>
        </div>
        <div className="cta-bar">
          <button className="btn btn-block" onClick={() => reset(true)}>
            Back to edit
          </button>
        </div>
      </div>
    );
  }

  // edit / preparing
  const preparing = phase.kind === 'preparing';
  const recipientCheck = to.trim() === '' ? null : checkAddress(to);
  const recipientOwn =
    recipientCheck?.ok === true ? findByAddress(api.accounts, recipientCheck.address) : undefined;
  const noGas = nativeBalance === 0n;
  return (
    <div>
      <div className="panel send-card">
        <div className="send-from">
          <Identicon address={wallet.address} size={22} />
          <span>
            From <strong>{wallet.label}</strong> <span className="mono">{shortAddress(wallet.address)}</span>
          </span>
        </div>

        <div className="field-pair" style={{ marginBottom: 18 }}>
          <div className="field">
            <label htmlFor="send-chain">Network</label>
            <select
              id="send-chain"
              className="input"
              value={chain.id}
              onChange={(e) => select({ chainId: Number(e.target.value), asset: null })}
              disabled={preparing}
            >
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="send-asset">Asset</label>
            <select
              id="send-asset"
              className="input"
              value={asset.address ? asset.address.toLowerCase() : 'native'}
              onChange={(e) => select({ chainId: chain.id, asset: e.target.value === 'native' ? null : e.target.value })}
              disabled={preparing}
            >
              {assets.map((a) => (
                <option key={a.address ?? 'native'} value={a.address ? a.address.toLowerCase() : 'native'}>
                  {a.symbol} · {a.address === null ? 'native coin' : a.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="send-available">
          <AssetGlyph symbol={asset.symbol} native={!isToken} home={isHome} chain={chain} />
          {assetBalance !== null ? (
            <span>
              Available <span className="v">{formatAmount(assetBalance, decimals)}</span> {symbol} on {chain.name}
            </span>
          ) : (
            <span>Reading the balance on {chain.name}…</span>
          )}
        </div>
        {noGas && (
          <div className="notice notice-warn" data-testid="no-gas">
            This account has no {nativeSymbol} on {chain.name}, so it cannot pay the network fee there. Fees on{' '}
            {chain.name} are paid in {nativeSymbol}.
          </div>
        )}

        <div className="field">
          <label htmlFor="send-to">Recipient address</label>
          <div className={'input-shell' + (toError ? ' is-error' : '')}>
            <input
              id="send-to"
              className="input input-mono"
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
              aria-invalid={toError ? true : undefined}
            />
            {ownAccounts.length > 0 && (
              <button
                className="icon-btn icon-btn-sm"
                type="button"
                data-testid="own-accounts-open"
                aria-expanded={ownOpen}
                aria-label="Send to another account in this wallet"
                title="My accounts"
                onClick={() => setOwnOpen((o) => !o)}
                disabled={preparing}
              >
                <IconUsers />
              </button>
            )}
            <button
              className="icon-btn icon-btn-sm"
              type="button"
              data-testid="scan-open"
              aria-label="Scan a QR code"
              title="Scan a QR code with the camera, an image, or a pasted link"
              onClick={() => setScanOpen(true)}
              disabled={preparing}
            >
              <ScanGlyph />
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
                      <Identicon address={account.address} size={28} />
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
              {recipientOwn.id === wallet.id ? ', the active one, so this would be a transfer to yourself.' : '.'}
            </div>
          )}
        </div>

        {scanNotice && (
          <div className={'notice ' + (scanNotice.tone === 'warn' ? 'notice-warn' : 'notice-success')}>{scanNotice.text}</div>
        )}

        <div className="field mb-0">
          <label htmlFor="send-amount">Amount</label>
          <div className={'amount-shell' + (amountError ? ' is-error' : '')}>
            <input
              id="send-amount"
              className="amount-input"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setAmountError(null);
              }}
              disabled={preparing}
              autoComplete="off"
              aria-invalid={amountError ? true : undefined}
            />
            <span className="amount-unit">{symbol}</span>
            <button className="btn btn-sm" onClick={() => void useMax()} disabled={preparing || maxBusy || !connected}>
              {maxBusy ? <Spinner /> : 'Max'}
            </button>
          </div>
          {amountError && <div className="field-error">{amountError}</div>}
          {!isToken && (
            <div className="field-hint">
              Max keeps back the worst-case {chain.name} fee{chain.opStackL1Fee ? ' (gas plus the L1 data fee)' : ' (estimated gas × current max fee)'}, so the send cannot fail on fees.
            </div>
          )}
        </div>

        {formError && <div className="field-error" style={{ marginTop: 14 }}>{formError}</div>}
        {!connected && <div className="field-hint" style={{ marginTop: 10 }}>Sending on Ferminux is disabled while offline.</div>}
      </div>

      <div className="cta-bar">
        <button
          className="btn btn-primary btn-block"
          data-testid="send-review"
          onClick={() => void review()}
          disabled={preparing || !connected || to.trim() === '' || amount.trim() === ''}
        >
          {preparing ? (
            <>
              <Spinner /> Preparing…
            </>
          ) : (
            'Review transaction'
          )}
        </button>
      </div>

      {scanOpen && (
        <ScannerModal
          onClose={() => setScanOpen(false)}
          onResult={applyScan}
          mode={paymentScanMode(chain.id, chain.id === CHAIN_ID ? 'the Ferminux Network' : chain.name, otherChainIds)}
        />
      )}
    </div>
  );
}

/**
 * The network, stated before anything else on a confirm screen. `unbound`:
 * a signature that names no chain (personal_sign, eth_sign, typed data without
 * domain.chainId) — asked for on this network, but valid on every one, so the
 * banner must not promise "this network only".
 */
export function ChainBanner({ chain, unbound = false }: { chain: ChainDef; unbound?: boolean }) {
  return (
    <div className="chain-banner" data-testid="chain-banner" data-unbound={unbound ? 'true' : undefined}>
      <ChainBadge chain={chain} />
      <span className="chain-banner-text">
        Network: <strong>{chain.name}</strong> <span className="muted num">· chain {chain.id}</span>
        <span className="chain-banner-sub">
          {unbound
            ? 'Asked for on this network · the signature itself is valid on every network'
            : `Signed for this network only · fees in ${chain.native.symbol}`}
        </span>
      </span>
    </div>
  );
}

/** Viewfinder glyph (the shared icon set's scan icon). */
export function ScanGlyph() {
  return (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M4 12h16" />
    </svg>
  );
}

export function HashLine({ chain, hash }: { chain: ChainDef; hash: string }) {
  return (
    <p className="hash-line">
      <span className="mono" title={hash}>
        {hash.slice(0, 10)}…{hash.slice(-8)}
      </span>
      <a href={explorerTxUrl(chain, hash)} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        View on {chain.explorer.name} <IconExternal />
      </a>
    </p>
  );
}

function TxStatus({
  title,
  chain,
  hash,
  body,
  spinner,
}: {
  title: string;
  chain: ChainDef;
  hash: string;
  body: string;
  spinner?: boolean;
}) {
  return (
    <div className="tx-state">
      <div className="state-ic">{spinner ? <Spinner /> : <IconCheck />}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      <HashLine chain={chain} hash={hash} />
    </div>
  );
}

/** Trim noisy RPC error strings to something a human can act on. */
export function shortenError(message: string): string {
  const cut = message.split(/\s*\(action=|\s*\[ See:/)[0];
  return cut.length > 220 ? cut.slice(0, 220) + '…' : cut;
}
