// Move FMX between Ferminux and BSC without leaving the DEX.
//
// Everything that decides an amount comes from the bridge app's lib/ — the
// quote, the caps, the allowance rule, the transfer id, the Sent parser. This
// file is the part that is genuinely DEX-specific: a single-chain app learning
// to hold a wallet on two chains at once.
//
// THE HARD PART IS NOT THE BRIDGE CALLS. It is that the rest of this app assumes
// chain 3961 — useWallet().wrongChain is defined against it, and switchChain()
// always goes home. The outbound leg happens to agree with that assumption; the
// return leg does not, and a user who lands here from a swap is on the wrong
// chain for half of what this panel offers. So the panel owns its own notion of
// "the chain this leg needs" and never borrows the app's.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Contract, JsonRpcProvider } from 'ethers';
import {
  buildApproveTx,
  buildSendTx,
  parseSentFromReceipt,
  readBridgeConfig,
  readRailState,
  readRegistry,
  requiresAllowance,
  routeMirrors,
  type BridgeConfig,
  type RailState,
  type RegistryEntry,
} from '@bridge/lib/bridge.ts';
import { ERC20_ABI } from '@bridge/lib/abi.ts';
import {
  checkAmount,
  checkRecipient,
  decayedUsage,
  formatAmount,
  formatAmountExact,
  formatBps,
  maxBridgeable,
  quoteTransfer,
} from '@bridge/lib/amounts.ts';
import type { ChainConfig } from '@bridge/config.ts';
import { assessLiveness, livenessForChain } from '@bridge/lib/liveness.ts';
import {
  BRIDGE_APP_URL,
  BSC,
  FERMINUX,
  RELAYER_STATUS_URL,
  bridgeReady,
  otherChain,
  switchTo,
} from '../lib/bridgeChains.ts';
import { bridgeGate } from '../lib/bridgeGate.ts';
import { useBridgeStatus } from '../state/useBridgeStatus.ts';
import { Notice, Spinner, StatRow } from '../components/ui.tsx';
import type { WalletSession } from '../state/useWallet.ts';

type Phase =
  | { kind: 'edit' }
  | { kind: 'switching' }
  | { kind: 'approving'; hash?: string }
  | { kind: 'sending'; hash?: string }
  | { kind: 'sent'; hash: string; transferId: string; amount: bigint }
  | { kind: 'error'; message: string };

/** Read-only provider per chain. The panel reads both ends regardless of where
 *  the wallet is pointed — that is how it can tell you the return leg is capped
 *  before you switch networks to find out. */
function useReadProvider(chain: ChainConfig): JsonRpcProvider | null {
  return useMemo(() => {
    if (!chain.rpcUrls[0]) return null;
    return new JsonRpcProvider(chain.rpcUrls[0], chain.chainId, { staticNetwork: true });
  }, [chain]);
}

export function BridgePanel({ wallet }: { wallet: WalletSession }) {
  const [srcKey, setSrcKey] = useState<string>(FERMINUX.key);
  const src = srcKey === FERMINUX.key ? FERMINUX : BSC;
  const dst = otherChain(src);

  const srcProvider = useReadProvider(src);
  const dstProvider = useReadProvider(dst);

  const [srcEntry, setSrcEntry] = useState<RegistryEntry | null>(null);
  const [dstEntry, setDstEntry] = useState<RegistryEntry | null>(null);
  const [cfg, setCfg] = useState<BridgeConfig | null>(null);
  const [rail, setRail] = useState<RailState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [amountText, setAmountText] = useState('');
  const [recipientText, setRecipientText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });

  const ready = bridgeReady();
  const relayer = useBridgeStatus(RELAYER_STATUS_URL, ready);

  // --- read both ends -------------------------------------------------------
  const load = useCallback(async () => {
    if (!ready || !srcProvider || !dstProvider) return;
    setLoadError(null);
    try {
      const [srcReg, dstReg, bcfg] = await Promise.all([
        readRegistry(srcProvider, src, src.bridgeAddress),
        readRegistry(dstProvider, dst, dst.bridgeAddress),
        readBridgeConfig(srcProvider, src.bridgeAddress),
      ]);
      // The route this panel offers is the native coin of whichever chain is the
      // source: FMX out of Ferminux, and the wFMX wrapper back out of BSC. Ask
      // the registry which local token that is rather than hardcoding either.
      const entry =
        srcReg.find((e) => e.meta.isNative) ??
        srcReg.find((e) => routeMirrors(e, dstReg[0], src.chainId)) ??
        srcReg[0] ??
        null;
      const mirror = entry ? (dstReg.find((e) => e.remoteToken.toLowerCase() === entry.localToken.toLowerCase()) ?? null) : null;
      setSrcEntry(entry);
      setDstEntry(mirror);
      setCfg(bcfg);
      if (entry) {
        setRail(await readRailState(srcProvider, src.bridgeAddress, entry, wallet.address));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [ready, srcProvider, dstProvider, src, dst, wallet.address]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  // --- quote ----------------------------------------------------------------
  const decimals = srcEntry?.meta.decimals ?? 18;
  const amountCheck = checkAmount(amountText, decimals);
  const amountWei = amountCheck.ok ? amountCheck.wei : 0n;
  const recipient = checkRecipient(recipientText.trim() === '' ? (wallet.address ?? '') : recipientText);

  const usage = useMemo(() => {
    if (!rail) return 0n;
    return decayedUsage(rail.usage, BigInt(rail.atSeconds), BigInt(Math.floor(Date.now() / 1000)));
  }, [rail]);

  const quote = useMemo(() => {
    if (!srcEntry || !rail || !cfg) return null;
    return quoteTransfer({
      amountWei,
      feeBps: cfg.feeBps,
      maxPerTransfer: rail.maxPerTransfer,
      dailyCap: rail.dailyCap,
      usage,
      balance: rail.balance ?? 0n,
      decimals,
      symbol: srcEntry.meta.symbol,
      isNative: srcEntry.meta.isNative,
      // The quote already knows how to refuse a paused bridge or rail; it only
      // has to be told. Both flags are read on every load above.
      bridgePaused: cfg.paused,
      tokenPaused: rail.paused || srcEntry.paused,
    });
  }, [srcEntry, rail, cfg, amountWei, usage, decimals]);

  // --- can the far side actually deliver? -------------------------------------
  // Caps and pause flags say whether the SOURCE bridge accepts a deposit. They do
  // not say whether validators will sign it. See lib/bridgeGate.ts.
  const srcVerdict = relayer.status
    ? assessLiveness(livenessForChain(relayer.status, src.chainId), src.short, Date.now() / 1000)
    : null;
  const gate = bridgeGate({
    srcName: src.short,
    bridgePaused: cfg ? cfg.paused : null,
    tokenPaused: rail ? rail.paused || (srcEntry?.paused ?? false) : null,
    reportUsable: relayer.status !== null,
    reportError: relayer.settled ? relayer.error : 'checking the validators\u2019 status report',
    srcVerdict,
  });

  const needsApproval =
    srcEntry !== null &&
    requiresAllowance(srcEntry) &&
    rail !== null &&
    (rail.allowance ?? 0n) < amountWei;

  const onSrcChain = wallet.wallet !== null && wallet.wallet.chainId === src.chainId;
  const busy = phase.kind === 'switching' || phase.kind === 'approving' || phase.kind === 'sending';

  async function useMax() {
    if (!rail || !srcEntry) return;
    setAmountText(
      formatAmountExact(
        maxBridgeable({
          balance: rail.balance ?? 0n,
          maxPerTransfer: rail.maxPerTransfer,
          dailyCap: rail.dailyCap,
          usage,
          isNative: srcEntry.meta.isNative,
          // Leave gas behind on the source chain, or the send cannot be paid for.
          gasReserveWei: srcEntry.meta.isNative ? 10n ** 16n : 0n,
        }),
        decimals,
      ),
    );
  }

  async function submit() {
    if (!gate.open || !srcEntry || !wallet.wallet || !recipient.ok || !quote?.ok) return;
    const eth = wallet.wallet.provider;

    // 1. the wallet must be on the source chain — for the return leg this is
    //    BSC, which the rest of this app would call "wrong".
    if (!onSrcChain) {
      setPhase({ kind: 'switching' });
      try {
        await switchTo(src, wallet.eip1193 ?? undefined);
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Network switch declined.' });
        return;
      }
    }

    const signer = await eth.getSigner();

    // 2. allowance. Both kinds need one: a canonical token is pulled with
    //    transferFrom, a wrapped one is burned against the same allowance.
    if (requiresAllowance(srcEntry)) {
      let allowance = rail?.allowance ?? 0n;
      try {
        const token = new Contract(srcEntry.localToken, ERC20_ABI as unknown as string[], signer);
        allowance = (await token.allowance(wallet.address, src.bridgeAddress)) as bigint;
      } catch {
        /* fall back to the polled value */
      }
      if (allowance < amountWei) {
        setPhase({ kind: 'approving' });
        try {
          const res = await signer.sendTransaction(buildApproveTx(srcEntry.localToken, src.bridgeAddress, amountWei));
          setPhase({ kind: 'approving', hash: res.hash });
          const rc = await res.wait(1);
          if (!rc || rc.status !== 1) {
            setPhase({ kind: 'error', message: 'The approval transaction reverted.' });
            return;
          }
        } catch (err) {
          setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Approval failed.' });
          return;
        }
      }
    }

    // 3. send
    setPhase({ kind: 'sending' });
    try {
      const res = await signer.sendTransaction(
        buildSendTx(src.bridgeAddress, srcEntry.localToken, amountWei, dst.chainId, recipient.address),
      );
      setPhase({ kind: 'sending', hash: res.hash });
      const rc = await res.wait(1);
      if (!rc || rc.status !== 1) {
        setPhase({ kind: 'error', message: 'The bridge transaction reverted.' });
        return;
      }
      const sent = parseSentFromReceipt(rc, src.bridgeAddress);
      setPhase(
        sent
          ? { kind: 'sent', hash: res.hash, transferId: sent.transferId, amount: sent.amount }
          : { kind: 'error', message: 'The transaction succeeded but emitted no Sent event.' },
      );
      setAmountText('');
      void load();
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Send failed.' });
    }
  }

  // --- render ---------------------------------------------------------------
  if (!ready) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Bridge</h2>
        </div>
        <div className="panel-body">
          <Notice kind="warn" role="status">
            <strong>The bridge is not configured in this build.</strong> Bridging needs the deployed bridge
            addresses for both chains. Until they are set there is no route to offer, so this panel says so
            rather than showing a form that cannot work.
          </Notice>
        </div>
      </section>
    );
  }

  const sendLabel = !wallet.wallet
    ? 'Connect a wallet'
    : !gate.open && !busy
      ? 'Bridging unavailable'
      : phase.kind === 'switching'
      ? 'Switching network…'
      : phase.kind === 'approving'
        ? 'Approving…'
        : phase.kind === 'sending'
          ? 'Bridging…'
          : `Bridge to ${dst.short}`;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Bridge</h2>
        <span className="spacer" />
        <span className="muted small">
          {src.short} → {dst.short}
        </span>
      </div>

      <div className="panel-body">
        {loadError && (
          <Notice kind="danger" role="alert">
            Could not read the bridge on {src.short}: {loadError}
          </Notice>
        )}

        {/* Rendered before the registry read finishes: whether the validators
            are signing does not depend on it, and a user should not have to
            wait for two RPCs to learn the route is closed. */}
        {!gate.open && relayer.settled && (
          <div data-testid="bridge-gate">
            <Notice kind="warn" role="status">
              <strong>Bridging is unavailable from {src.short} right now.</strong> {gate.reason}{' '}
              <a href={BRIDGE_APP_URL} target="_blank" rel="noopener noreferrer">
                Bridge status ↗
              </a>
            </Notice>
          </div>
        )}
        {gate.open && gate.note && (
          <Notice kind="plain" role="status">
            {gate.note}
          </Notice>
        )}

        {srcEntry === null && !loadError && (
          <p className="muted">
            <Spinner /> Reading the {src.short} registry…
          </p>
        )}

        {srcEntry && (
          <>
            <div className="amount-box">
              <div className="amount-head">
                <span>From {src.name}</span>
                <span className="push">
                  {rail?.balance !== null && rail?.balance !== undefined && (
                    <>
                      Balance <span className="num">{formatAmount(rail.balance, decimals, 6)}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => void useMax()} disabled={busy}>
                        Max
                      </button>
                    </>
                  )}
                </span>
              </div>
              <div className="amount-row">
                <input
                  className="amount-input num"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder="0.0"
                  aria-label={`Amount of ${srcEntry.meta.symbol} to bridge`}
                  disabled={busy}
                />
                <span className="token-button" aria-hidden="true">
                  {srcEntry.meta.symbol}
                </span>
              </div>
              {!amountCheck.ok && amountText.trim() !== '' && <p className="field-error">{amountCheck.error}</p>}
            </div>

            {/* Same control the swap form uses to reverse a pair — here it
                reverses the direction of travel, which is the same gesture. */}
            <div className="flip-row">
              <button
                className="flip-btn"
                aria-label={`Bridge from ${dst.name} instead`}
                disabled={busy}
                onClick={() => {
                  setSrcKey(dst.key);
                  setPhase({ kind: 'edit' });
                  setAmountText('');
                  setSrcEntry(null);
                  setRail(null);
                }}
              >
                ↓
              </button>
            </div>

            <div className="amount-box">
              <div className="amount-head">
                <span>To {dst.name}</span>
              </div>
              <div className="amount-row">
                <div className="amount-output num" aria-live="polite">
                  {quote && amountWei > 0n ? (
                    formatAmount(quote.netWei, decimals)
                  ) : (
                    <span className="muted">0.0</span>
                  )}
                </div>
                <span className="token-button" aria-hidden="true">
                  {dstEntry?.meta.symbol ?? srcEntry.meta.symbol}
                </span>
              </div>
            </div>

            <div className="field">
              <label htmlFor="bridge-recipient">Recipient on {dst.short}</label>
              <input
                id="bridge-recipient"
                className="input input-mono"
                value={recipientText}
                onChange={(e) => setRecipientText(e.target.value)}
                placeholder={wallet.address ?? '0x…'}
                disabled={busy}
              />
              {recipientText.trim() === '' ? (
                <p className="field-hint">Leave empty to send to your own address.</p>
              ) : (
                !recipient.ok && <p className="field-error">{recipient.error}</p>
              )}
            </div>

            {quote && amountWei > 0n && (
              <div className="quote-box">
                <StatRow
                  label={`Bridge fee (${cfg ? formatBps(cfg.feeBps) : '—'})`}
                  value={`${formatAmount(quote.feeWei, decimals)} ${srcEntry.meta.symbol}`}
                  hint="Taken on the source chain. The amount signed for the far side is what is left."
                />
                <StatRow
                  label={`Arrives on ${dst.short}`}
                  value={`${formatAmount(quote.netWei, decimals)} ${dstEntry?.meta.symbol ?? srcEntry.meta.symbol}`}
                />
                <StatRow
                  label="Estimated time"
                  value={`~${Math.round((src.confirmations * src.blockSeconds + 90) / 60)} min`}
                  hint="Source confirmations plus validator and relayer latency. Not a guarantee."
                />
              </div>
            )}

            {quote && !quote.ok && amountWei > 0n && (
              <Notice kind="warn" role="alert">
                {quote.problems.join(' ')}
              </Notice>
            )}

            {/* The whole reason this panel keeps its own chain state: on the
                return leg the chain it needs is BSC, which the rest of this app
                would call "wrong". */}
            {wallet.wallet && !onSrcChain && (
              <Notice kind="warn" role="status">
                Your wallet is on another network. Sending will switch it to {src.name} first.
              </Notice>
            )}

            {needsApproval && (
              <Notice kind="plain" role="status">
                This takes two transactions: an approval, then the bridge send.
                {!srcEntry.meta.isNative && ` ${srcEntry.meta.symbol} is burned against that approval.`}
              </Notice>
            )}

            <div className="action-stack">
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                disabled={busy || !gate.open || !wallet.wallet || !quote?.ok || !recipient.ok || amountWei === 0n}
                onClick={() => void submit()}
              >
                {sendLabel}
              </button>
            </div>

            {phase.kind === 'error' && (
              <Notice kind="danger" role="alert">
                {phase.message}
              </Notice>
            )}

            {phase.kind === 'sent' && (
              <Notice kind="success" role="status">
                Locked {formatAmount(phase.amount, decimals)} {srcEntry.meta.symbol} on {src.short}. Validators
                sign it and it lands on {dst.short} shortly.{' '}
                <a href={`${src.explorerUrl}/tx/${phase.hash}`} target="_blank" rel="noopener noreferrer">
                  View transaction ↗
                </a>
              </Notice>
            )}
          </>
        )}
      </div>
    </section>
  );
}
