// The Swap screen's pieces: the token picker, the settings sheet, the two
// confirm screens (approval, then the swap or wrap itself) and the pools list.
// The confirm screens are the wallet's confirm screen — the same banner, table,
// checks and transaction details as Send and Mint — filled with what a swap signs.

import { useMemo, useState } from 'react';
import type { AssetRef } from '../lib/portfolio.ts';
import { FERMINUX_CHAIN, explorerAddressUrl } from '../lib/chains.ts';
import { formatAmount, formatAmountExact, formatGwei, shortAddress } from '../lib/validate.ts';
import type { PreparedTx } from '../lib/tx.ts';
import {
  DEX,
  FEE_BPS,
  METHOD_SIGNATURE,
  SLIPPAGE_PRESETS_BPS,
  formatImpactPpm,
  formatPercentBps,
  impactLevel,
  isWfmx,
  parseDeadlineMinutes,
  parseSlippagePercent,
  slippageNote,
  tokenKey,
  type ApprovalMode,
  type Pool,
  type Route,
  type SwapKind,
  type SwapPreflight,
  type SwapSettings,
} from '../lib/swap.ts';
import { Modal, Spinner } from '../components/ui.tsx';
import { AssetGlyph } from '../components/ChainBadge.tsx';
import { IconCheck, IconChevronDown, IconExternal } from '../components/icons.tsx';
import { ChainBanner } from './SendPanel.tsx';

export const fmt = (wei: bigint, t: { decimals: number }, digits = 6) => formatAmount(wei, t.decimals, digits);

export function Glyph({ token }: { token: AssetRef }) {
  return <AssetGlyph symbol={token.symbol} native={token.address === null} home />;
}

/** "USDF → WFMX → AZNT": the route by symbol, with this swap's own ends as picked. */
export function routeSymbols(route: Route, tokenIn: AssetRef, tokenOut: AssetRef, known: AssetRef[]): string[] {
  return route.path.map((a, i) => {
    if (i === 0) return tokenIn.symbol;
    if (i === route.path.length - 1) return tokenOut.symbol;
    const k = known.find((t) => t.address && t.address.toLowerCase() === a.toLowerCase());
    return k ? k.symbol : isWfmx(a) ? 'WFMX' : shortAddress(a);
  });
}

export function RouteLine({ symbols, testId }: { symbols: string[]; testId?: string }) {
  return (
    <span className="route-line" data-testid={testId} data-hops={symbols.length - 1}>
      {symbols.map((s, i) => (
        <span key={`${s}-${i}`} className="route-part">
          {i > 0 && (
            <span className="route-arrow" aria-hidden="true">
              →
            </span>
          )}
          <span className="route-step">{s}</span>
        </span>
      ))}
    </span>
  );
}

export function ImpactText({ ppm }: { ppm: bigint }) {
  const level = impactLevel(Number(ppm / 100n));
  return (
    <span className={level === 'ok' ? '' : level === 'warn' ? 'impact-warn' : 'impact-severe'} data-level={level}>
      {formatImpactPpm(ppm)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Token picker                                                        */
/* ------------------------------------------------------------------ */

export function TokenPicker({
  side,
  tokens,
  balances,
  selected,
  other,
  hiddenCount,
  onPick,
  onClose,
}: {
  side: 'in' | 'out';
  tokens: AssetRef[];
  balances: Map<string, bigint | null>;
  selected: string;
  other: string;
  /** Tokens added under Assets that have no pool yet (not offered). */
  hiddenCount: number;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return tokens;
    return tokens.filter((t) => t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || (t.address ?? '').toLowerCase() === s);
  }, [q, tokens]);
  return (
    <Modal title={side === 'in' ? 'You pay' : 'You receive'} onClose={onClose}>
      <div data-testid="swap-picker" data-side={side}>
        <input
          className="input"
          placeholder="Search by name, symbol or address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="Search tokens"
          style={{ marginBottom: 12 }}
        />
        {shown.length === 0 ? (
          <div className="empty-state" style={{ padding: '20px 8px' }}>
            No token on the Ferminux Network matches “{q.trim()}”.
          </div>
        ) : (
          <ul className="token-list">
            {shown.map((t) => {
              const key = tokenKey(t);
              const bal = balances.get(key) ?? null;
              return (
                <li key={key}>
                  <button
                    className="token-row"
                    data-testid={`swap-pick-${key}`}
                    aria-current={key === selected ? 'true' : undefined}
                    onClick={() => onPick(key)}
                  >
                    <Glyph token={t} />
                    <span className="token-row-main">
                      <span className="token-row-sym">
                        {t.symbol}
                        {key === other && <span className="acct-tag">{side === 'in' ? 'RECEIVING' : 'PAYING'}</span>}
                        {t.source === 'custom' && <span className="acct-tag">ADDED</span>}
                      </span>
                      <span className="token-row-name">
                        {t.address === null ? 'Native coin' : t.name}
                        {t.address && <span className="mono"> · {shortAddress(t.address)}</span>}
                      </span>
                    </span>
                    <span className="token-row-bal num">{bal === null ? '—' : fmt(bal, t, 4)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="small faint" style={{ margin: '14px 4px 0', lineHeight: 1.55 }}>
          Tokens on the Ferminux Network with a Ferminux DEX pool. Add another token by its contract address under Assets; it is
          offered here once it has a pool.
          {hiddenCount > 0 && ` ${hiddenCount} added token${hiddenCount === 1 ? ' has' : 's have'} no pool yet.`}
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function SwapSettingsSheet({
  settings,
  onChange,
  onClose,
}: {
  settings: SwapSettings;
  onChange: (s: SwapSettings) => void;
  onClose: () => void;
}) {
  const preset = (SLIPPAGE_PRESETS_BPS as readonly number[]).includes(settings.slippageBps);
  const [custom, setCustom] = useState(preset ? '' : formatPercentBps(settings.slippageBps).replace('%', ''));
  const [customError, setCustomError] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(String(settings.deadlineMin));
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  const note = slippageNote(settings.slippageBps);

  const setApproval = (approval: ApprovalMode) => onChange({ ...settings, approval });

  return (
    <Modal title="Swap settings" onClose={onClose}>
      <div data-testid="swap-settings">
        <div className="field">
          <span className="field-label">Slippage tolerance</span>
          <div className="slip-row">
            <div className="seg" role="group" aria-label="Slippage presets">
              {SLIPPAGE_PRESETS_BPS.map((bps) => (
                <button
                  key={bps}
                  aria-pressed={settings.slippageBps === bps}
                  data-testid={`swap-slip-${bps}`}
                  onClick={() => {
                    setCustom('');
                    setCustomError(null);
                    onChange({ ...settings, slippageBps: bps });
                  }}
                >
                  {formatPercentBps(bps)}
                </button>
              ))}
            </div>
            <div className={'amount-shell slip-custom' + (customError ? ' is-error' : '')}>
              <input
                className="amount-input"
                inputMode="decimal"
                placeholder="Custom"
                aria-label="Custom slippage in percent"
                data-testid="swap-slip-custom"
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  if (e.target.value.trim() === '') {
                    setCustomError(null);
                    return;
                  }
                  const r = parseSlippagePercent(e.target.value);
                  if (r.ok) {
                    setCustomError(null);
                    onChange({ ...settings, slippageBps: r.bps });
                  } else setCustomError(r.error);
                }}
              />
              <span className="amount-unit">%</span>
            </div>
          </div>
          {customError && <div className="field-error">{customError}</div>}
          <div className="field-hint">
            The swap reverts, instead of settling, if the price moves against you by more than this between review and inclusion.
          </div>
          {note && (
            <div className="notice notice-warn" style={{ marginTop: 10, marginBottom: 0 }} data-testid="swap-slip-note">
              {note}
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="swap-deadline">Deadline</label>
          <div className={'amount-shell slip-custom' + (deadlineError ? ' is-error' : '')} style={{ maxWidth: 200 }}>
            <input
              id="swap-deadline"
              className="amount-input"
              inputMode="numeric"
              value={deadline}
              onChange={(e) => {
                setDeadline(e.target.value);
                const r = parseDeadlineMinutes(e.target.value);
                if (r.ok) {
                  setDeadlineError(null);
                  onChange({ ...settings, deadlineMin: r.minutes });
                } else setDeadlineError(r.error);
              }}
            />
            <span className="amount-unit">min</span>
          </div>
          {deadlineError && <div className="field-error">{deadlineError}</div>}
          <div className="field-hint">Counted from the chain’s latest block, not this device’s clock. After it the router refuses the swap.</div>
        </div>

        <div className="field mb-0">
          <span className="field-label">Approval</span>
          <div className="seg" role="group" aria-label="Approval amount">
            <button aria-pressed={settings.approval === 'exact'} data-testid="swap-approval-exact" onClick={() => setApproval('exact')}>
              Exact amount
            </button>
            <button aria-pressed={settings.approval === 'unlimited'} data-testid="swap-approval-unlimited" onClick={() => setApproval('unlimited')}>
              Unlimited
            </button>
          </div>
          <div className="field-hint">
            Before a token is swapped the first time, the router needs permission to take it. Exact grants this swap’s amount and
            nothing more.
          </div>
          {settings.approval === 'unlimited' && (
            <div className="notice notice-danger" style={{ marginTop: 10, marginBottom: 0 }}>
              <strong>Unlimited:</strong> the router could move all of that token from this account, now and later, until you set
              the allowance back. Saves one approval per swap; exact is the safer default.
            </div>
          )}
        </div>

        <button className="btn btn-primary btn-block" style={{ marginTop: 20 }} onClick={onClose} data-testid="swap-settings-done">
          Done
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Confirm screens                                                     */
/* ------------------------------------------------------------------ */

function TxDetails({ p, extra }: { p: PreparedTx; extra?: JSX.Element }) {
  return (
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
              EIP-1559 · max {formatGwei(p.maxFeePerGas)} gwei, tip {formatGwei(p.maxPriorityFeePerGas)} gwei
            </td>
          </tr>
          {extra}
          <tr>
            <th>Calldata</th>
            <td className="mono">{p.data}</td>
          </tr>
        </tbody>
      </table>
    </details>
  );
}

function Actions({
  step,
  onBack,
  onSign,
  label,
  testId,
}: {
  step: 'checking' | 'signing' | null;
  onBack: () => void;
  onSign: () => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="cta-bar">
      <div className="actions-split">
        <button className="btn" onClick={onBack} disabled={step !== null}>
          Back
        </button>
        <button className="btn btn-primary" data-testid={testId} onClick={onSign} disabled={step !== null}>
          {step ? (
            <>
              <Spinner /> {step === 'checking' ? 'Checking…' : 'Signing…'}
            </>
          ) : (
            label
          )}
        </button>
      </div>
    </div>
  );
}

export function StepBar({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="swap-steps" data-testid="swap-steps">
      <div className="steps" aria-hidden="true" style={{ marginBottom: 8 }}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i < step ? 'on' : ''} />
        ))}
      </div>
      <div className="label">
        Step {step} of {total} · {label}
      </div>
    </div>
  );
}

const fmxFee = (p: PreparedTx) => `${formatAmount(p.maxFeeWei, 18, 8)} FMX`;

export function ApproveConfirm({
  token,
  amount,
  mode,
  wallet,
  prepared: p,
  step,
  onBack,
  onSign,
}: {
  token: AssetRef;
  amount: bigint;
  mode: ApprovalMode;
  wallet: { label: string; address: string };
  prepared: PreparedTx;
  step: 'checking' | 'signing' | null;
  onBack: () => void;
  onSign: () => void;
}) {
  const unlimited = mode === 'unlimited';
  return (
    <div data-testid="swap-approve-review">
      <div className="panel send-card">
        <StepBar step={1} total={2} label={`Approve ${token.symbol}`} />
        <ChainBanner chain={FERMINUX_CHAIN} />
        <div className="confirm-amount">
          <div className="label">Allow the Ferminux DEX router to take</div>
          <div className="v num" data-testid="swap-approve-amount">
            {unlimited ? 'Unlimited' : formatAmountExact(amount, token.decimals)}
            <span className="u">{token.symbol}</span>
          </div>
          <div className="to">{unlimited ? 'for this swap and every later one, until you set the allowance back' : 'once, for the swap you review next'}</div>
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
              <th>Contract</th>
              <td>
                <span className="mono" data-testid="swap-approve-contract">
                  {p.to}
                </span>
                <span className="muted small">
                  {' '}
                  · {token.symbol}
                  {token.source === 'custom' ? ', a token you added (not listed)' : ''}
                </span>
              </td>
            </tr>
            <tr>
              <th>Method</th>
              <td className="mono" data-testid="swap-approve-method">
                {METHOD_SIGNATURE.approve}
              </td>
            </tr>
            <tr>
              <th>Spender</th>
              <td>
                <span className="mono" data-testid="swap-approve-spender">
                  {DEX.router}
                </span>
                <span className="muted small"> · Ferminux DEX router</span>
              </td>
            </tr>
            <tr>
              <th>Amount</th>
              <td className="num">
                {unlimited ? (
                  <strong style={{ color: 'var(--warn)' }}>Unlimited</strong>
                ) : (
                  <>
                    {formatAmountExact(amount, token.decimals)} {token.symbol} <span className="muted">· exactly this swap</span>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <th>Network fee (max)</th>
              <td className="num" data-testid="swap-approve-fee">
                {fmxFee(p)}
              </td>
            </tr>
          </tbody>
        </table>
        {unlimited ? (
          <div className="notice notice-danger" data-testid="swap-approve-unlimited">
            <strong>Unlimited approval:</strong> the router could move ALL of this account’s {token.symbol}, now and later, until you
            set the allowance back. Change it to Exact in swap settings if you did not mean this.
          </div>
        ) : (
          <p className="small muted">
            An exact approval: the router can take {formatAmount(amount, token.decimals)} {token.symbol} and nothing more; the swap
            uses it up. Nothing is swapped by this step.
          </p>
        )}
        <TxDetails p={p} />
        <p className="small muted mb-0">Review carefully: these are exactly the values that will be signed.</p>
      </div>
      <Actions step={step} onBack={onBack} onSign={onSign} label={`Sign approval on Ferminux`} testId="swap-approve-confirm" />
    </div>
  );
}

/**
 * A token the user added by address reports its own symbol, so an added "USDF"
 * reads exactly like the listed one: the confirm screen names it as added,
 * with its contract, next to the amount.
 */
function AddedTokenLine({ token, testId }: { token: AssetRef; testId: string }) {
  if (token.source !== 'custom' || !token.address) return null;
  return (
    <div className="k" data-testid={testId} style={{ color: 'var(--warn)' }}>
      Added by you, not listed · <span className="mono">{shortAddress(token.address)}</span>
    </div>
  );
}

export interface SwapPlanView {
  kind: SwapKind;
  /** The method signed, as the call builder named it. */
  method: string;
  tokenIn: AssetRef;
  tokenOut: AssetRef;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  route: Route | null;
  routeSymbols: string[];
  impactPpm: bigint;
  slippageBps: number;
  deadline: bigint | null;
}

export function SwapConfirm({
  plan,
  wallet,
  prepared: p,
  pf,
  note,
  twoStep,
  step,
  onBack,
  onSign,
}: {
  plan: SwapPlanView;
  wallet: { label: string; address: string };
  prepared: PreparedTx;
  pf: SwapPreflight;
  /** Shown above the screen (e.g. "USDF approved"). */
  note?: string | null;
  /** This swap followed an approval: show step 2 of 2. */
  twoStep: boolean;
  step: 'checking' | 'signing' | null;
  onBack: () => void;
  onSign: () => void;
}) {
  const { tokenIn, tokenOut } = plan;
  const wrap = plan.kind !== 'swap';
  const hops = plan.route?.hops.length ?? 0;
  const secondsLeft = plan.deadline !== null ? Number(plan.deadline) - pf.blockTime : 0;
  const verb = plan.kind === 'wrap' ? 'wrap' : plan.kind === 'unwrap' ? 'unwrap' : 'swap';
  return (
    <div data-testid="swap-review" data-kind={plan.kind}>
      {note && (
        <div className="notice notice-success" data-testid="swap-approved-note">
          {note}
        </div>
      )}
      <div className="panel send-card">
        {twoStep && <StepBar step={2} total={2} label="Swap" />}
        <ChainBanner chain={FERMINUX_CHAIN} />
        <div className="confirm-legs">
          <div className="confirm-leg">
            <Glyph token={tokenIn} />
            <div style={{ minWidth: 0 }}>
              <div className="k">You pay</div>
              <div className="v num" data-testid="swap-confirm-in">
                {formatAmountExact(plan.amountIn, tokenIn.decimals)}
                <span className="u">{tokenIn.symbol}</span>
              </div>
              <AddedTokenLine token={tokenIn} testId="swap-confirm-in-added" />
            </div>
          </div>
          <div className="confirm-leg">
            <Glyph token={tokenOut} />
            <div style={{ minWidth: 0 }}>
              <div className="k">{wrap ? 'You receive' : 'You receive (expected)'}</div>
              <div className="v num" data-testid="swap-confirm-out">
                {formatAmountExact(plan.expectedOut, tokenOut.decimals)}
                <span className="u">{tokenOut.symbol}</span>
              </div>
              {!wrap && (
                <div className="k" data-testid="swap-confirm-min">
                  at least {formatAmountExact(plan.minOut, tokenOut.decimals)} {tokenOut.symbol}
                </div>
              )}
              <AddedTokenLine token={tokenOut} testId="swap-confirm-out-added" />
            </div>
          </div>
        </div>
        {(tokenIn.source === 'custom' || tokenOut.source === 'custom') && (
          <div className="notice notice-warn" data-testid="swap-confirm-added-note">
            {[tokenIn, tokenOut]
              .filter((t) => t.source === 'custom')
              .map((t) => `${t.symbol} here is the token you added by address, ${t.address}`)
              .join('; ')}
            . An added token's name and symbol are whatever its contract reports, and the wallet does not vouch for it: check
            the address is the one you meant.
          </div>
        )}
        <table className="confirm-table">
          <tbody>
            <tr>
              <th>From</th>
              <td>
                {wallet.label} <span className="mono muted">{shortAddress(wallet.address)}</span>
              </td>
            </tr>
            <tr>
              <th>Contract</th>
              <td>
                <span className="mono" data-testid="swap-confirm-contract">
                  {p.to}
                </span>
                <span className="muted small"> · {wrap ? 'WFMX' : 'Ferminux DEX router'}</span>
              </td>
            </tr>
            <tr>
              <th>Method</th>
              <td className="mono" data-testid="swap-confirm-method">
                {plan.method}
              </td>
            </tr>
            {plan.kind === 'swap' && (
              <>
                <tr>
                  <th>Route</th>
                  <td>
                    <RouteLine symbols={plan.routeSymbols} testId="swap-confirm-route" />
                  </td>
                </tr>
                <tr>
                  <th>Minimum received</th>
                  <td className="num">
                    {formatAmountExact(plan.minOut, tokenOut.decimals)} {tokenOut.symbol}{' '}
                    <span className="muted">· slippage {formatPercentBps(plan.slippageBps)}</span>
                  </td>
                </tr>
                <tr>
                  <th>Price impact</th>
                  <td className="num" data-testid="swap-confirm-impact">
                    <ImpactText ppm={plan.impactPpm} />
                  </td>
                </tr>
                <tr>
                  <th>Pool fees</th>
                  <td className="num">
                    {formatPercentBps(FEE_BPS * hops)}{' '}
                    <span className="muted">
                      · {formatPercentBps(FEE_BPS)} × {hops} pool{hops === 1 ? '' : 's'}, to liquidity providers
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>Recipient</th>
                  <td>
                    This account <span className="mono muted">{shortAddress(wallet.address)}</span>
                  </td>
                </tr>
                <tr>
                  <th>Deadline</th>
                  <td className="num">
                    in {Math.max(0, Math.round(secondsLeft / 60))} min <span className="muted">· block time {plan.deadline?.toString()}</span>
                  </td>
                </tr>
              </>
            )}
            <tr>
              <th>Network fee (max)</th>
              <td className="num" data-testid="swap-confirm-fee">
                {fmxFee(p)}
              </td>
            </tr>
            <tr>
              <th>Max total debit</th>
              <td className="em num">
                {tokenIn.address === null
                  ? `${formatAmountExact(plan.amountIn + p.maxFeeWei, 18)} FMX`
                  : `${formatAmountExact(plan.amountIn, tokenIn.decimals)} ${tokenIn.symbol} + ${fmxFee(p)}`}
              </td>
            </tr>
          </tbody>
        </table>
        {plan.kind === 'swap' && impactLevel(Number(plan.impactPpm / 100n)) !== 'ok' && (
          <div className={'notice ' + (impactLevel(Number(plan.impactPpm / 100n)) === 'severe' ? 'notice-danger' : 'notice-warn')} data-testid="swap-confirm-impact-note">
            This size moves the pool price by {formatImpactPpm(plan.impactPpm)}: you get that much less than the current price, on top of
            the pool fee. A smaller amount, or several smaller swaps, loses less.
          </div>
        )}
        <ul className="check-list" data-testid="swap-checks" aria-label="Checked just now">
          {plan.kind === 'swap' ? (
            <li>
              <IconCheck />
              <span>
                Quote read from the router just now: {fmt(plan.expectedOut, tokenOut)} {tokenOut.symbol}
              </span>
            </li>
          ) : (
            <li>
              <IconCheck />
              <span>1 : 1 through the WFMX contract · no pool, no slippage</span>
            </li>
          )}
          <li>
            <IconCheck />
            <span>
              Balance {fmt(pf.balanceIn, tokenIn, 4)} {tokenIn.symbol} covers {fmt(plan.amountIn, tokenIn)} {tokenIn.symbol}
              {tokenIn.address === null ? ' and the worst-case fee' : ''}
            </span>
          </li>
          {tokenIn.address !== null && (
            <li>
              <IconCheck />
              <span>FMX for the network fee: {fmt(pf.nativeBalance, { decimals: 18 }, 4)} FMX</span>
            </li>
          )}
          {pf.allowance !== null && (
            <li>
              <IconCheck />
              <span>
                The router may take {fmt(plan.amountIn, tokenIn)} {tokenIn.symbol}
              </span>
            </li>
          )}
          <li>
            <IconCheck />
            <span>Signed for the Ferminux Network only; the {tokenOut.symbol} goes to this account</span>
          </li>
        </ul>
        <TxDetails
          p={p}
          extra={
            plan.route ? (
              <tr>
                <th>Path</th>
                <td className="mono">{plan.route.path.join(' → ')}</td>
              </tr>
            ) : undefined
          }
        />
        <p className="small muted mb-0">
          Review carefully: these are exactly the values that will be signed.{' '}
          {plan.kind === 'swap' ? 'The quote is read once more before signing.' : ''}
        </p>
      </div>
      <Actions step={step} onBack={onBack} onSign={onSign} label={`Sign & ${verb} on Ferminux`} testId="swap-confirm" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pools                                                               */
/* ------------------------------------------------------------------ */

export function PoolsList({ pools, known, error }: { pools: Pool[] | null; known: AssetRef[]; error: string | null }) {
  const sym = (a: string) => known.find((t) => t.address && t.address.toLowerCase() === a.toLowerCase())?.symbol ?? (isWfmx(a) ? 'WFMX' : shortAddress(a));
  const dec = (a: string) => known.find((t) => t.address && t.address.toLowerCase() === a.toLowerCase())?.decimals ?? 18;
  const live = (pools ?? []).filter((p) => p.reserve0 > 0n && p.reserve1 > 0n);
  // WFMX first on each line, so every FMX market reads "1 WFMX = …".
  const lines = live.map((p) => {
    const flip = isWfmx(p.token1);
    const [a, b, ra, rb] = flip ? [p.token1, p.token0, p.reserve1, p.reserve0] : [p.token0, p.token1, p.reserve0, p.reserve1];
    return { p, a, b, ra, rb };
  });
  return (
    <section className="panel swap-pools" aria-label="Ferminux DEX pools" data-testid="swap-pools">
      <div className="panel-head">
        <h2>Pools</h2>
        <span className="spacer" />
        <a className="small" href={explorerAddressUrl(FERMINUX_CHAIN, DEX.router)} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Router <IconExternal />
        </a>
      </div>
      {pools === null ? (
        <div className="panel-body small muted">{error ?? 'Reading the Ferminux DEX…'}</div>
      ) : lines.length === 0 ? (
        <div className="panel-body small muted">No pool between these tokens holds liquidity yet.</div>
      ) : (
        <ul className="row-list">
          {lines.map(({ p, a, b, ra, rb }) => {
            const price = rb * 10n ** BigInt(dec(a)) * 10n ** 18n / (ra * 10n ** BigInt(dec(b)));
            return (
              <li key={p.pair} data-testid={`swap-pool-${p.pair.toLowerCase()}`}>
                <div className="row-main">
                  <div className="row-title">
                    {sym(a)} / {sym(b)}
                  </div>
                  <div className="row-sub num">
                    {formatAmount(ra, dec(a), 2)} {sym(a)} · {formatAmount(rb, dec(b), 2)} {sym(b)}
                  </div>
                </div>
                <div className="row-value">
                  {formatAmount(price, 18, price >= 10n ** 18n ? 4 : 6)}
                  <span className="sub">
                    {sym(b)} per {sym(a)}
                  </span>
                </div>
                <a className="row-link" href={explorerAddressUrl(FERMINUX_CHAIN, p.pair)} target="_blank" rel="noreferrer noopener" aria-label={`${sym(a)}/${sym(b)} pool on the explorer`}>
                  <IconExternal />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {error && pools !== null && <div className="panel-body small" style={{ color: 'var(--warn)', paddingTop: 0 }}>Last refresh failed: {error}</div>}
    </section>
  );
}
