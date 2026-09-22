import { useEffect, useMemo, useState } from 'react';
import { Contract } from 'ethers';
import type { ChainConfig } from '../config.ts';
import { explorerAddressUrl } from '../config.ts';
import { ERC20_ABI } from '../lib/abi.ts';
import {
  buildApproveTx,
  buildSendTx,
  isNativeToken,
  parseSentFromReceipt,
  requiresAllowance,
  routeMirrors,
  TokenKind,
  type RegistryEntry,
} from '../lib/bridge.ts';
import {
  checkAmount,
  checkRecipient,
  formatAmount,
  formatAmountExact,
  formatBps,
  formatDuration,
  maxBridgeable,
  quoteTransfer,
  secondsUntilCapacity,
  shortAddress,
} from '../lib/amounts.ts';
import { estimateEtaSeconds } from '../lib/status.ts';
import { assessLiveness, livenessForChain, type RelayerStatus } from '../lib/liveness.ts';
import type { TransferRecord } from '../lib/transfers.ts';
import type { BridgeData } from '../state/useBridgeData.ts';
import { useRail } from '../state/useRail.ts';
import { useNow } from '../state/useNow.ts';
import type { WalletState } from '../state/wallet.ts';
import { Badge, ExternalLink, Skeleton, Spinner, shortenError } from '../components/ui.tsx';

/** Gas the send() call is assumed to need when reserving native headroom. */
const SEND_GAS_ESTIMATE = 220_000n;

type Phase =
  | { kind: 'edit' }
  | { kind: 'approving' }
  | { kind: 'approve-mining'; hash: string }
  | { kind: 'sending' }
  | { kind: 'send-mining'; hash: string }
  | { kind: 'sent'; hash: string; transferId: string }
  | { kind: 'error'; message: string; at: 'approve' | 'send' };

export function TransferForm({
  src,
  dst,
  data,
  wallet,
  onSent,
  liveness = null,
}: {
  src: ChainConfig;
  dst: ChainConfig;
  data: BridgeData;
  wallet: WalletState;
  onSent: (record: TransferRecord) => void;
  /** Relayer liveness report; null falls back to the nominal estimate. */
  liveness?: RelayerStatus | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientTouched, setRecipientTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [gasReserve, setGasReserve] = useState(0n);

  const routes = data.routes;
  const entry: RegistryEntry | null =
    routes.find((r) => r.localToken.toLowerCase() === (selected ?? '').toLowerCase()) ?? routes[0] ?? null;

  const rail = useRail(data.srcProvider, src.bridgeAddress, entry, wallet.address);
  const now = useNow(1000);

  // Default the recipient to the connected account; the user can override it.
  useEffect(() => {
    if (!recipientTouched && wallet.address) setRecipient(wallet.address);
  }, [wallet.address, recipientTouched]);

  // Reset the asset choice when the route changes.
  useEffect(() => {
    setSelected(null);
    setAmount('');
    setPhase({ kind: 'edit' });
  }, [src.key, dst.key]);

  // Native headroom: the send() transaction itself costs gas on the source chain.
  useEffect(() => {
    const provider = data.srcProvider;
    if (!provider || !entry?.meta.isNative) {
      setGasReserve(0n);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const fee = await provider.getFeeData();
        const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
        if (alive) setGasReserve(perGas * SEND_GAS_ESTIMATE);
      } catch {
        if (alive) setGasReserve(0n);
      }
    })();
    return () => {
      alive = false;
    };
  }, [data.srcProvider, entry?.localToken, entry?.meta.isNative]);

  const decimals = entry?.meta.decimals ?? 18;
  const symbol = entry?.meta.symbol ?? '—';
  const remoteEntry = entry
    ? data.dstEntries.find((e) => e.localToken.toLowerCase() === entry.remoteToken.toLowerCase())
    : undefined;
  const remoteSymbol = remoteEntry?.meta.symbol ?? `${symbol} (on ${dst.short})`;
  const mirrored = entry ? routeMirrors(entry, remoteEntry, src.chainId) : false;

  const amountCheck = amount.trim() === '' ? null : checkAmount(amount, decimals);
  const amountWei = amountCheck?.ok ? amountCheck.wei : 0n;
  const recipientCheck = recipient.trim() === '' ? null : checkRecipient(recipient);

  const usage = rail.usageNow(Math.floor(now / 1000));
  const feeBps = data.srcConfig?.feeBps ?? 0n;

  const quote = useMemo(
    () =>
      quoteTransfer({
        amountWei,
        feeBps,
        maxPerTransfer: rail.state?.maxPerTransfer ?? entry?.maxPerTransfer ?? 0n,
        dailyCap: rail.state?.dailyCap ?? entry?.dailyCap ?? 0n,
        usage,
        balance: rail.state?.balance ?? null,
        decimals,
        symbol,
        isNative: entry?.meta.isNative ?? false,
        gasReserveWei: gasReserve,
        bridgePaused: data.srcConfig?.paused ?? false,
        tokenPaused: rail.state?.paused ?? entry?.paused ?? false,
      }),
    [amountWei, feeBps, rail.state, entry, usage, decimals, symbol, gasReserve, data.srcConfig],
  );

  // Arrival estimate at the MEASURED source pace when the relayer reports one;
  // null while validators are paused, because then there is no honest number.
  const srcLive = livenessForChain(liveness, src.chainId);
  const srcVerdict = assessLiveness(srcLive, src.short, now / 1000);
  const etaSeconds = estimateEtaSeconds(src, dst, srcLive);
  const etaText = srcVerdict.paused
    ? `paused — ${src.short} ${
        srcVerdict.state === 'degraded'
          ? 'is producing blocks slowly'
          : srcVerdict.state.startsWith('checkpoint')
            ? 'has no usable checkpoint'
            : 'validators are not signing right now'
      }`
    : `about ${formatDuration(etaSeconds)}${srcLive?.pace ? ' at the current pace' : ''}`;
  // Whichever way the asset moves, an allowance is consumed — see
  // requiresAllowance(). Only the native coin is exempt.
  const usesAllowance = entry !== null && requiresAllowance(entry);
  const needsApproval =
    usesAllowance &&
    rail.state?.allowance !== null &&
    rail.state !== null &&
    (rail.state.allowance ?? 0n) < amountWei;

  const busy =
    phase.kind === 'approving' ||
    phase.kind === 'approve-mining' ||
    phase.kind === 'sending' ||
    phase.kind === 'send-mining';

  const wrongChain = wallet.status === 'connected' && wallet.chainId !== src.chainId;

  async function useMax() {
    if (!rail.state || rail.state.balance === null || !entry) return;
    const max = maxBridgeable({
      balance: rail.state.balance,
      maxPerTransfer: rail.state.maxPerTransfer,
      dailyCap: rail.state.dailyCap,
      usage,
      isNative: entry.meta.isNative,
      gasReserveWei: gasReserve,
    });
    setAmount(formatAmountExact(max, decimals));
  }

  async function submit() {
    if (!entry || !wallet.provider || !wallet.address || !recipientCheck?.ok || !amountCheck?.ok) return;
    const signer = await wallet.provider.getSigner();
    const bridgeAddress = src.bridgeAddress;

    // --- step 1: allowance (canonical ERC-20 only) --------------------------
    if (usesAllowance) {
      let allowance = rail.state?.allowance ?? 0n;
      try {
        // Re-read rather than trust the last poll: an approval may have landed
        // in another tab, and asking twice is cheaper than a failed transfer.
        const token = new Contract(entry.localToken, ERC20_ABI as unknown as string[], wallet.provider);
        allowance = (await token.allowance(wallet.address, bridgeAddress)) as bigint;
      } catch {
        /* fall back to the polled value */
      }
      if (allowance < amountWei) {
        setPhase({ kind: 'approving' });
        try {
          const tx = buildApproveTx(entry.localToken, bridgeAddress, amountWei);
          const res = await signer.sendTransaction(tx);
          setPhase({ kind: 'approve-mining', hash: res.hash });
          const receipt = await res.wait(1);
          if (!receipt || receipt.status !== 1) {
            setPhase({ kind: 'error', message: 'The approval transaction reverted.', at: 'approve' });
            return;
          }
        } catch (err) {
          setPhase({ kind: 'error', message: describeError(err), at: 'approve' });
          return;
        }
      }
    }

    // --- step 2: send -------------------------------------------------------
    setPhase({ kind: 'sending' });
    try {
      const tx = buildSendTx(bridgeAddress, entry.localToken, amountWei, dst.chainId, recipientCheck.address);
      const res = await signer.sendTransaction(tx);
      setPhase({ kind: 'send-mining', hash: res.hash });
      const receipt = await res.wait(1);
      if (!receipt) {
        setPhase({ kind: 'error', message: 'The transaction was dropped before it was mined.', at: 'send' });
        return;
      }
      if (receipt.status !== 1) {
        setPhase({ kind: 'error', message: 'The bridge transaction reverted. Nothing was locked or burned.', at: 'send' });
        return;
      }

      const sent = parseSentFromReceipt(receipt, bridgeAddress);
      const netWei = sent?.amount ?? quote.netWei;
      const feeWei = sent?.fee ?? quote.feeWei;
      const record: TransferRecord = {
        transferId: sent?.transferId ?? '',
        srcChainKey: src.key,
        dstChainKey: dst.key,
        srcChainId: src.chainId,
        dstChainId: dst.chainId,
        srcBridge: bridgeAddress,
        dstBridge: dst.bridgeAddress,
        srcToken: entry.localToken,
        dstToken: entry.remoteToken,
        symbol,
        dstSymbol: remoteSymbol,
        decimals,
        sender: wallet.address,
        recipient: recipientCheck.address,
        sentWei: amountWei.toString(),
        amountWei: netWei.toString(),
        feeWei: feeWei.toString(),
        nonce: sent?.nonce ?? 0,
        txHash: receipt.hash,
        txBlockNumber: receipt.blockNumber,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        phase: 'confirming',
        error: sent ? undefined : 'No Sent event found in the receipt — this transfer cannot be tracked automatically.',
      };
      onSent(record);
      setPhase({ kind: 'sent', hash: receipt.hash, transferId: record.transferId });
      setAmount('');
      rail.refresh();
    } catch (err) {
      setPhase({ kind: 'error', message: describeError(err), at: 'send' });
    }
  }

  /* -------------------------------------------------------------- render */

  if (routes.length === 0) {
    return (
      <div className="empty-state">
        <div className="title">No assets are registered for this route</div>
        The bridge on {src.name} has no token registered with {dst.name} as its destination. Registrations go through a
        48-hour timelock, so this route may simply not be open yet.
      </div>
    );
  }

  if (!entry) return null;

  const capacityWait =
    amountWei > 0n && rail.state
      ? secondsUntilCapacity(rail.state.dailyCap, usage, amountWei)
      : 0;

  return (
    <div>
      {/* ---------------- asset ---------------- */}
      <div className="field">
        <label htmlFor="asset">Asset</label>
        <select
          id="asset"
          className="input"
          value={entry.localToken}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setAmount('');
            setPhase({ kind: 'edit' });
          }}
        >
          {routes.map((r) => (
            <option key={r.localToken} value={r.localToken}>
              {r.meta.symbol} — {r.meta.name}
              {r.meta.isNative ? ' (native coin)' : ''}
              {r.paused ? ' · paused' : ''}
            </option>
          ))}
        </select>
        <div className="field-hint">
          <Badge kind={entry.kind === TokenKind.CANONICAL ? 'canonical' : 'wrapped'}>
            {entry.kind === TokenKind.CANONICAL ? 'Canonical here' : 'Wrapped here'}
          </Badge>{' '}
          {entry.kind === TokenKind.CANONICAL
            ? `The real asset lives on ${src.short}. It is locked in the bridge while it is away.`
            : `An IOU minted by this bridge. It is burned when it goes home to ${dst.short}.`}{' '}
          You receive <strong>{remoteSymbol}</strong> on {dst.name}
          {isNativeToken(entry.remoteToken) ? ' (their native coin)' : ''}.
          {!mirrored && (
            <div className="field-error" style={{ marginTop: 6 }}>
              The destination bridge does not mirror this registration. A transfer would be sent but could not be
              executed on the far side — do not use this route until it is fixed.
            </div>
          )}
        </div>
      </div>

      {/* ---------------- amount ---------------- */}
      <div className="field">
        <label htmlFor="amount">Amount</label>
        <div className="input-row">
          <input
            id="amount"
            className={'input num' + (amountCheck && !amountCheck.ok ? ' input-error' : '')}
            placeholder="0.0"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            disabled={busy}
            onChange={(e) => {
              setAmount(e.target.value);
              if (phase.kind === 'error' || phase.kind === 'sent') setPhase({ kind: 'edit' });
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => void useMax()}
            disabled={busy || rail.state?.balance == null}
          >
            Max
          </button>
        </div>
        {amountCheck && !amountCheck.ok && <div className="field-error">{amountCheck.error}</div>}
        <div className="field-hint">
          {rail.loading && rail.state === null ? (
            <Skeleton width={160} />
          ) : rail.state?.balance != null ? (
            <>
              Balance: <span className="num">{formatAmount(rail.state.balance, decimals)}</span> {symbol}
              {entry.meta.isNative && gasReserve > 0n && (
                <> · Max reserves {formatAmount(gasReserve, 18, 6)} {src.native.symbol} for gas</>
              )}
            </>
          ) : wallet.status === 'connected' ? (
            'Balance unavailable.'
          ) : (
            'Connect a wallet to see your balance.'
          )}
        </div>
      </div>

      {/* ---------------- recipient ---------------- */}
      <div className="field">
        <label htmlFor="recipient">Recipient on {dst.name}</label>
        <input
          id="recipient"
          className={'input input-mono' + (recipientCheck && !recipientCheck.ok ? ' input-error' : '')}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          value={recipient}
          disabled={busy}
          onChange={(e) => {
            setRecipient(e.target.value);
            setRecipientTouched(true);
          }}
        />
        {recipientCheck && !recipientCheck.ok && <div className="field-error">{recipientCheck.error}</div>}
        <div className="field-hint">
          Defaults to your connected address. Bridge transfers cannot be reversed — check this address on{' '}
          {dst.name} before you send.
          {wallet.address && recipient.toLowerCase() !== wallet.address.toLowerCase() && (
            <>
              {' '}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setRecipient(wallet.address as string);
                  setRecipientTouched(true);
                }}
              >
                Use my address
              </button>
            </>
          )}
        </div>
      </div>

      {/* ---------------- quote ---------------- */}
      <table className="kv" style={{ marginTop: 4 }}>
        <tbody>
          <tr>
            <th>Bridge fee ({data.srcConfig ? formatBps(data.srcConfig.feeBps) : '—'})</th>
            <td>
              {amountWei > 0n ? (
                <>
                  {formatAmount(quote.feeWei, decimals, 8)} {symbol}
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </tr>
          <tr>
            <th>You receive on {dst.short}</th>
            <td className="em">
              {amountWei > 0n ? (
                <>
                  {formatAmount(quote.netWei, decimals, 8)} {remoteSymbol}
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </tr>
          <tr>
            <th>Per-transfer cap</th>
            <td>
              {rail.state ? (
                <>
                  {formatAmount(rail.state.maxPerTransfer, decimals)} {symbol}
                </>
              ) : (
                <Skeleton width={90} />
              )}
            </td>
          </tr>
          <tr>
            <th>Remaining 24 h capacity</th>
            <td className={rail.state && quote.remaining < (rail.state.dailyCap / 10n) * 2n ? 'warn' : undefined}>
              {rail.state ? (
                <>
                  {formatAmount(quote.remaining, decimals)} / {formatAmount(rail.state.dailyCap, decimals)} {symbol}
                </>
              ) : (
                <Skeleton width={120} />
              )}
            </td>
          </tr>
          <tr>
            <th>Typical arrival</th>
            <td className={srcVerdict.paused ? 'warn' : undefined}>{etaText}</td>
          </tr>
        </tbody>
      </table>

      {capacityWait !== null && capacityWait > 0 && (
        <div className="field-hint" style={{ marginTop: 8 }}>
          Capacity refills continuously — this amount fits again in about {formatDuration(capacityWait)}.
        </div>
      )}

      {/* ---------------- problems ---------------- */}
      {amountWei > 0n && quote.problems.length > 0 && (
        <div className="notice notice-danger" style={{ marginTop: 16, marginBottom: 0 }} role="alert">
          {quote.problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}

      {rail.error && (
        <div className="notice" style={{ marginTop: 16, marginBottom: 0 }}>
          Live limits could not be refreshed: {rail.error}
        </div>
      )}

      {/* ---------------- progress ---------------- */}
      {(busy || phase.kind === 'sent' || phase.kind === 'error') && (
        <ol className="steps" style={{ marginTop: 18 }}>
          {usesAllowance && (
            <StepRow
              state={
                phase.kind === 'approving' || phase.kind === 'approve-mining'
                  ? 'active'
                  : phase.kind === 'error' && phase.at === 'approve'
                    ? 'failed'
                    : 'done'
              }
              index={1}
              title={`Approve the bridge to move ${symbol}`}
              sub={
                phase.kind === 'approving'
                  ? 'Confirm the approval in your wallet…'
                  : phase.kind === 'approve-mining'
                    ? `Approval submitted — ${phase.hash.slice(0, 10)}…`
                    : phase.kind === 'error' && phase.at === 'approve'
                      ? phase.message
                      : `Allowance covers ${formatAmount(amountWei, decimals)} ${symbol}.`
              }
            />
          )}
          <StepRow
            state={
              phase.kind === 'sending' || phase.kind === 'send-mining'
                ? 'active'
                : phase.kind === 'sent'
                  ? 'done'
                  : phase.kind === 'error' && phase.at === 'send'
                    ? 'failed'
                    : 'idle'
            }
            index={usesAllowance ? 2 : 1}
            title={entry.kind === TokenKind.CANONICAL ? `Lock ${symbol} in the bridge` : `Burn ${symbol}`}
            sub={
              phase.kind === 'sending'
                ? 'Confirm the transfer in your wallet…'
                : phase.kind === 'send-mining'
                  ? `Submitted — waiting for the first confirmation (${phase.hash.slice(0, 10)}…)`
                  : phase.kind === 'sent'
                    ? 'Confirmed on the source chain.'
                    : phase.kind === 'error' && phase.at === 'send'
                      ? phase.message
                      : 'Not started.'
            }
          />
          <StepRow
            state={phase.kind === 'sent' ? 'active' : 'idle'}
            index={usesAllowance ? 3 : 2}
            title={`Validators attest, the destination bridge releases on ${dst.name}`}
            sub={
              phase.kind === 'sent'
                ? 'Tracking below. You can close this page — the transfer is saved in this browser.'
                : srcVerdict.paused
                  ? `Validators are not signing right now: ${srcVerdict.message}`
                  : `Typically about ${formatDuration(etaSeconds)} after the source confirmation.`
            }
          />
        </ol>
      )}

      {phase.kind === 'sent' && (
        <div className="notice notice-success" style={{ marginTop: 4 }}>
          Transfer submitted. It is now tracked under <strong>In flight</strong> below.{' '}
          <ExternalLink href={`${src.explorerUrl}/tx/${phase.hash}`}>Source transaction</ExternalLink>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="notice notice-danger" style={{ marginTop: 16 }} role="alert">
          {phase.message}
        </div>
      )}

      {/* ---------------- action ---------------- */}
      <div className="actions-row" style={{ marginTop: 18 }}>
        <PrimaryAction
          wallet={wallet}
          src={src}
          wrongChain={wrongChain}
          busy={busy}
          phase={phase}
          canSubmit={quote.ok && Boolean(recipientCheck?.ok) && mirrored && !rail.loading}
          needsApproval={needsApproval}
          onSubmit={() => void submit()}
        />
        {entry && !entry.meta.isNative && (
          <span className="small muted">
            <ExternalLink href={explorerAddressUrl(src, entry.localToken)}>
              {shortAddress(entry.localToken)}
            </ExternalLink>
          </span>
        )}
      </div>
    </div>
  );
}

function PrimaryAction({
  wallet,
  src,
  wrongChain,
  busy,
  phase,
  canSubmit,
  needsApproval,
  onSubmit,
}: {
  wallet: WalletState;
  src: ChainConfig;
  wrongChain: boolean;
  busy: boolean;
  phase: Phase;
  canSubmit: boolean;
  needsApproval: boolean;
  onSubmit: () => void;
}) {
  if (wallet.status === 'unavailable') {
    return (
      <button className="btn btn-primary" disabled>
        No wallet detected
      </button>
    );
  }
  if (wallet.status !== 'connected') {
    return (
      <button className="btn btn-primary" onClick={() => void wallet.connect()} disabled={wallet.status === 'connecting'}>
        {wallet.status === 'connecting' ? (
          <>
            <Spinner /> Connecting…
          </>
        ) : (
          'Connect wallet'
        )}
      </button>
    );
  }
  if (wrongChain) {
    return (
      <button className="btn btn-primary" onClick={() => void wallet.switchTo(src)}>
        Switch wallet to {src.name}
      </button>
    );
  }
  const label = busy
    ? phase.kind === 'approving'
      ? 'Approve in wallet…'
      : phase.kind === 'approve-mining'
        ? 'Approving…'
        : phase.kind === 'sending'
          ? 'Confirm in wallet…'
          : 'Bridging…'
    : needsApproval
      ? 'Approve & Bridge'
      : 'Bridge';
  return (
    <button className="btn btn-primary" onClick={onSubmit} disabled={busy || !canSubmit}>
      {busy ? (
        <>
          <Spinner />
          {label}
        </>
      ) : (
        label
      )}
    </button>
  );
}

function StepRow({
  state,
  index,
  title,
  sub,
}: {
  state: 'idle' | 'active' | 'done' | 'failed';
  index: number;
  title: string;
  sub: string;
}) {
  const cls = state === 'active' ? 'active' : state === 'done' ? 'done' : state === 'failed' ? 'active' : '';
  return (
    <li className={cls}>
      <span className="step-mark">{state === 'done' ? '✓' : state === 'failed' ? '×' : index}</span>
      <span className="step-body">
        {title}
        <div className="step-sub">{sub}</div>
      </span>
    </li>
  );
}

function describeError(err: unknown): string {
  const e = err as { code?: number | string; shortMessage?: string; message?: string; reason?: string };
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'Rejected in your wallet. Nothing was sent.';
  if (e?.reason) return shortenError(e.reason);
  return shortenError(e?.shortMessage || e?.message || 'The transaction failed.');
}
