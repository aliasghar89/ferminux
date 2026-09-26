// STAKE: pick a tier, see the real rate and the real runway, lock FMX with a
// confirmation that says exactly what will happen — and never implies a return
// the pool cannot pay.

import { useEffect, useMemo, useState } from 'react';
import { EXPLORER_URL, NATIVE_SYMBOL, STAKING_VAULT_ADDRESS } from '../config.ts';
import type { ChainState } from '../state/useChain.ts';
import type { WalletState } from '../state/useWallet.ts';
import type { Poll, VaultData } from '../state/useStakingData.ts';
import { stake, fetchDenied, humanizeTxError, type Tier } from '../lib/staking.ts';
import {
  effectiveAprBps,
  weightedUnits,
  projectedRewardsWei,
  runwaySeconds,
  poolCoversProjection,
  maxStakeableWei,
} from '../lib/math.ts';
import { checkAmount } from '../lib/validate.ts';
import { formatFMX, formatBps, formatWeight, formatDuration, formatDateTime, formatMonths } from '../lib/format.ts';
import { Modal, Spinner, Skeleton } from '../components/ui.tsx';

const TIER_NAMES = ['Flexible', 'Locked 90 days', 'Locked 180 days', 'Validator track'];

type TxPhase =
  | { phase: 'idle' }
  | { phase: 'confirm' }
  | { phase: 'signing' }
  | { phase: 'pending'; hash: string }
  | { phase: 'done'; hash: string; amountWei: bigint; tierId: number }
  | { phase: 'error'; message: string };

export function StakePanel({
  chain,
  wallet,
  vault,
  balance,
  deployed,
  now,
  onConnect,
  onDone,
}: {
  chain: ChainState;
  wallet: WalletState;
  vault: Poll<VaultData>;
  balance: Poll<bigint>;
  deployed: boolean;
  now: number;
  onConnect: () => void;
  onDone: () => void;
}) {
  const [tierId, setTierId] = useState(0);
  const [amountRaw, setAmountRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const [tx, setTx] = useState<TxPhase>({ phase: 'idle' });
  const [denied, setDenied] = useState(false);

  const tiers = vault.data?.tiers ?? null;
  const overview = vault.data?.overview ?? null;
  const tier: Tier | null = tiers?.[tierId] ?? null;

  // Premine wallets are excluded by contract — say so before they try.
  useEffect(() => {
    setDenied(false);
    if (!chain.provider || !wallet.address || !deployed) return;
    let alive = true;
    fetchDenied(chain.provider, STAKING_VAULT_ADDRESS, wallet.address)
      .then((d) => {
        if (alive) setDenied(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chain.provider, wallet.address, deployed]);

  const amount = checkAmount(amountRaw);
  const amountError = touched && !amount.ok ? amount.error : null;
  const belowMin = amount.ok && tier !== null && amount.wei < tier.minStakeWei;
  const overBalance = amount.ok && balance.data !== null && amount.wei > balance.data;

  // Live effective APY per tier — cap scaled by the drip when it binds,
  // INCLUDING the dilution the user's own stake would add.
  const liveApr = (t: Tier): bigint | null => {
    if (!overview) return null;
    return effectiveAprBps(t.weightBps, overview.totalWeightedUnitsWei, overview.dripPerYearWei);
  };
  const aprAfterMyStake = useMemo(() => {
    if (!overview || !tier || !amount.ok) return null;
    const units = overview.totalWeightedUnitsWei + weightedUnits(amount.wei, tier.weightBps);
    return effectiveAprBps(tier.weightBps, units, overview.dripPerYearWei);
  }, [overview, tier, amount]);

  const runway = overview ? runwaySeconds(overview.rewardPoolWei, overview.totalWeightedUnitsWei, overview.dripPerYearWei) : null;
  const poolCoversLock =
    overview && tier
      ? poolCoversProjection(
          overview.rewardPoolWei,
          overview.totalWeightedUnitsWei,
          overview.dripPerYearWei,
          tier.lockSeconds > 0n ? tier.lockSeconds : 30n * 86_400n,
        )
      : true;

  const unlockAt = tier ? now + Number(tier.lockSeconds) : now;
  const horizonSeconds = tier && tier.lockSeconds > 0n ? tier.lockSeconds : 30n * 86_400n;
  const projected =
    amount.ok && aprAfterMyStake !== null ? projectedRewardsWei(amount.wei, aprAfterMyStake, horizonSeconds) : null;

  const onMax = async () => {
    if (!chain.provider || balance.data === null) return;
    try {
      const fees = await chain.provider.getFeeData();
      setAmountRaw(formatFMXPlain(maxStakeableWei(balance.data, fees.maxFeePerGas ?? 2_000_000_000n)));
      setTouched(true);
    } catch {
      // fee read failed — leave the field untouched rather than guessing
    }
  };

  const canReview =
    deployed &&
    wallet.address !== null &&
    !denied &&
    amount.ok &&
    !belowMin &&
    !overBalance &&
    tier !== null &&
    overview !== null &&
    chain.status === 'ok';

  const submit = async () => {
    if (!chain.provider || !amount.ok || tier === null) return;
    setTx({ phase: 'signing' });
    try {
      const signer = await wallet.getSigner(chain.provider);
      const resp = await stake(signer, STAKING_VAULT_ADDRESS, tier.id, amount.wei);
      setTx({ phase: 'pending', hash: resp.hash });
      const receipt = await resp.wait();
      if (receipt?.status !== 1) throw new Error('Transaction reverted on chain.');
      // Keep the staked amount in the tx state: the input is cleared on close,
      // and the success screen must keep showing what actually happened.
      setTx({ phase: 'done', hash: resp.hash, amountWei: amount.wei, tierId: tier.id });
      onDone();
    } catch (e) {
      setTx({ phase: 'error', message: humanizeTxError(e) });
    }
  };

  return (
    <div className="panel-body">
      {vault.error && !vault.data && (
        <div className="notice notice-danger" role="alert">
          Could not load staking data: {vault.error}{' '}
          <button className="btn btn-sm" onClick={vault.refresh} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      )}
      {denied && (
        <div className="notice notice-warn">
          This address is on the premine deny list — treasury, ecosystem, ops and vesting wallets are excluded from
          staking rewards by contract.
        </div>
      )}

      {/* tier cards */}
      <div className="tier-grid">
        {tiers === null
          ? Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="tier-card" aria-hidden="true">
                <div className="tier-head">
                  <Skeleton width={110} />
                  <span className="tier-apy">
                    <Skeleton width={48} />
                  </span>
                </div>
                <Skeleton width={160} />
              </div>
            ))
          : tiers.map((t) => {
              const apr = liveApr(t);
              const capped = apr !== null && apr < t.aprCapBps;
              return (
                <button
                  key={t.id}
                  className={'tier-card' + (tierId === t.id ? ' is-selected' : '')}
                  onClick={() => setTierId(t.id)}
                  role="radio"
                  aria-checked={tierId === t.id}
                >
                  <div className="tier-head">
                    <span className="tier-name">{TIER_NAMES[t.id] ?? `Tier ${t.id}`}</span>
                    <span className="tier-weight num">{formatWeight(t.weightBps)}</span>
                    <span className="tier-apy num">
                      {apr === null ? '…' : formatBps(apr)}
                      <span className="cap">{capped ? `cap ${formatBps(t.aprCapBps)}` : 'APY'}</span>
                    </span>
                  </div>
                  <div className="tier-sub">
                    {t.lockSeconds === 0n
                      ? 'No lock — exit any time via the 7-day cooldown'
                      : `Locks for ${formatDuration(Number(t.lockSeconds))} — until ${formatDateTime(now + Number(t.lockSeconds))}`}
                  </div>
                  {(t.minStakeWei > 0n || t.requiresNode) && (
                    <div className="tier-req">
                      {t.minStakeWei > 0n && `Min ${formatFMX(t.minStakeWei, 0)} FMX bond`}
                      {t.minStakeWei > 0n && t.requiresNode && ' · '}
                      {t.requiresNode && 'requires a registered node (Nodes tab)'}
                    </div>
                  )}
                </button>
              );
            })}
      </div>

      {/* pool honesty line — always visible on the stake screen */}
      {overview && (
        <div className="runway-line">
          <span>
            Reward pool <strong className="num">{formatFMX(overview.rewardPoolWei, 0)} FMX</strong>
          </span>
          <span className="muted">·</span>
          <span>
            {runway === null
              ? 'nothing staked yet — the pool is untouched'
              : `funds ${formatMonths(runway)} of rewards at current stake`}
          </span>
          <span className="muted">·</span>
          <span>accrual stops if the pool empties — principal is never touched</span>
        </div>
      )}
      {!poolCoversLock && (
        <div className="notice notice-warn">
          Honesty check: at the current outlay the reward pool would run out before this tier&apos;s lock ends.
          Rewards would stop accruing at that point (your principal is unaffected). The multisig can top the pool
          up, but that is a promise by people, not by this contract.
        </div>
      )}

      {/* amount */}
      <div className="field">
        <label htmlFor="stake-amount">Amount to stake</label>
        <div className="input-row">
          <input
            id="stake-amount"
            className={'input input-mono num' + (amountError || belowMin || overBalance ? ' input-error' : '')}
            placeholder="0.0"
            inputMode="decimal"
            autoComplete="off"
            value={amountRaw}
            onChange={(e) => {
              setAmountRaw(e.target.value);
              setTouched(true);
            }}
          />
          <button className="btn" onClick={() => void onMax()} disabled={balance.data === null}>
            Max
          </button>
        </div>
        {amountError && <div className="field-error">{amountError}</div>}
        {belowMin && tier && (
          <div className="field-error">
            {TIER_NAMES[tier.id]} needs at least {formatFMX(tier.minStakeWei, 0)} FMX.
          </div>
        )}
        {overBalance && <div className="field-error">More than your balance.</div>}
        {wallet.address && balance.data !== null && !overBalance && (
          <div className="field-hint num">
            Balance {formatFMX(balance.data)} {NATIVE_SYMBOL} — FMX is the native coin, so there is no token
            approval step: staking is a single transaction.
          </div>
        )}
      </div>

      {/* the plain-words statement */}
      {tier && amount.ok && !belowMin && !overBalance && (
        <div className="notice">
          You are locking <strong className="num">{formatFMX(amount.wei)} FMX</strong>{' '}
          {tier.lockSeconds === 0n ? (
            <>with no lock — you can start the 7-day exit cooldown at any time.</>
          ) : (
            <>
              until <strong>{formatDateTime(unlockAt)}</strong> ({formatDuration(Number(tier.lockSeconds))}).
              Leaving early forfeits all unclaimed rewards plus 5% of principal.
            </>
          )}{' '}
          At today&apos;s effective rate ({aprAfterMyStake !== null ? formatBps(aprAfterMyStake) : '…'}, including
          your own dilution) that projects to{' '}
          <strong className="num">{projected !== null ? formatFMX(projected) : '…'} FMX</strong> over{' '}
          {formatDuration(Number(horizonSeconds))} — a projection, not a promise: the rate falls as more FMX is
          staked and stops if the pool empties.
        </div>
      )}

      {!deployed ? (
        <button className="btn btn-lg btn-block" disabled>
          Staking not live yet
        </button>
      ) : wallet.address === null ? (
        <button className="btn btn-primary btn-lg btn-block" onClick={onConnect}>
          Connect a wallet to stake
        </button>
      ) : (
        <button className="btn btn-primary btn-lg btn-block" disabled={!canReview} onClick={() => setTx({ phase: 'confirm' })}>
          Review stake
        </button>
      )}

      {/* confirm + progress modal */}
      {tx.phase !== 'idle' && tier && (tx.phase === 'done' || tx.phase === 'error' || amount.ok) && (
        <Modal
          title={
            tx.phase === 'confirm'
              ? 'Confirm stake'
              : tx.phase === 'signing'
                ? 'Waiting for signature'
                : tx.phase === 'pending'
                  ? 'Broadcasting'
                  : tx.phase === 'done'
                    ? 'Staked'
                    : 'Stake failed'
          }
          onClose={() => setTx({ phase: 'idle' })}
        >
          {(tx.phase === 'confirm' || tx.phase === 'signing' || tx.phase === 'pending') && amount.ok && (
            <>
              <table className="confirm-table">
                <tbody>
                  <tr>
                    <th>Stake</th>
                    <td className="em num">{formatFMX(amount.wei)} FMX</td>
                  </tr>
                  <tr>
                    <th>Tier</th>
                    <td>
                      {TIER_NAMES[tier.id]} ({formatWeight(tier.weightBps)})
                    </td>
                  </tr>
                  <tr>
                    <th>Locked until</th>
                    <td>{tier.lockSeconds === 0n ? 'no lock' : formatDateTime(unlockAt)}</td>
                  </tr>
                  <tr>
                    <th>Effective APY now</th>
                    <td className="num">
                      {aprAfterMyStake !== null ? formatBps(aprAfterMyStake) : '…'} (cap {formatBps(tier.aprCapBps)})
                    </td>
                  </tr>
                  <tr>
                    <th>Projected over {formatDuration(Number(horizonSeconds))}</th>
                    <td className="num">{projected !== null ? `${formatFMX(projected)} FMX` : '…'}</td>
                  </tr>
                  <tr>
                    <th>Exit</th>
                    <td>7-day cooldown, no rewards during it</td>
                  </tr>
                  <tr>
                    <th>Early exit{tier.lockSeconds === 0n ? '' : ' (before unlock)'}</th>
                    <td>{tier.lockSeconds === 0n ? 'n/a — no lock' : 'forfeits unclaimed rewards + 5% principal'}</td>
                  </tr>
                </tbody>
              </table>
              <p className="small muted">
                The projection assumes today&apos;s rate for the whole period. It falls as more FMX is staked, and
                accrual stops entirely if the reward pool runs dry. Principal is only ever moved by you.
              </p>
              {tx.phase === 'confirm' ? (
                <button className="btn btn-primary btn-lg btn-block" onClick={() => void submit()}>
                  Sign and stake {formatFMX(amount.wei)} FMX
                </button>
              ) : (
                <p className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Spinner />
                  {tx.phase === 'signing' ? 'Waiting for your wallet…' : 'Waiting for the chain to confirm…'}
                </p>
              )}
            </>
          )}
          {tx.phase === 'done' && (
            <>
              <div className="notice notice-success">
                Staked {formatFMX(tx.amountWei)} FMX into {TIER_NAMES[tx.tierId] ?? `tier ${tx.tierId}`}. It is now
                visible under Positions.
              </div>
              <p className="small">
                <a href={`${EXPLORER_URL}/tx/${tx.hash}`} target="_blank" rel="noreferrer noopener">
                  View transaction ↗
                </a>
              </p>
              <button
                className="btn btn-block"
                onClick={() => {
                  setAmountRaw('');
                  setTouched(false);
                  setTx({ phase: 'idle' });
                }}
              >
                Done
              </button>
            </>
          )}
          {tx.phase === 'error' && (
            <>
              <div className="notice notice-danger" role="alert">
                {tx.message}
              </div>
              <button className="btn btn-block" onClick={() => setTx({ phase: 'confirm' })}>
                Back
              </button>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

/** Plain (ungrouped) decimal string for prefilling the input. */
function formatFMXPlain(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
