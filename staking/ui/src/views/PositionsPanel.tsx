// POSITIONS: principal, accrued rewards, unlock countdown, claim / unstake /
// withdraw — and emergency exit clearly marked with exactly what it forfeits.

import { useState } from 'react';
import { EXPLORER_URL, STAKING_VAULT_ADDRESS } from '../config.ts';
import type { ChainState } from '../state/useChain.ts';
import type { WalletState } from '../state/useWallet.ts';
import type { Poll, VaultData } from '../state/useStakingData.ts';
import {
  claim,
  beginUnstake,
  withdraw,
  emergencyExit,
  humanizeTxError,
  type Position,
} from '../lib/staking.ts';
import { countdown } from '../lib/math.ts';
import { formatFMX, formatCountdown, formatDateTime } from '../lib/format.ts';
import { Modal, Spinner, Skeleton } from '../components/ui.tsx';

const TIER_NAMES = ['Flexible', 'Locked 90d', 'Locked 180d', 'Validator'];

type Busy = { id: bigint; action: string } | null;

export function PositionsPanel({
  chain,
  wallet,
  vault,
  positions,
  deployed,
  now,
  onConnect,
  onDone,
}: {
  chain: ChainState;
  wallet: WalletState;
  vault: Poll<VaultData>;
  positions: Poll<Position[]>;
  deployed: boolean;
  now: number;
  onConnect: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [emergencyFor, setEmergencyFor] = useState<Position | null>(null);
  const penaltyBps = vault.data?.overview.emergencyPenaltyBps ?? 500n;

  const run = async (p: Position, action: string, fn: () => Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
    if (!chain.provider) return;
    setBusy({ id: p.id, action });
    setError(null);
    try {
      const resp = await fn();
      const receipt = (await resp.wait()) as { status?: number } | null;
      if (receipt?.status !== 1) throw new Error('Transaction reverted on chain.');
      setLastTx(resp.hash);
      onDone();
    } catch (e) {
      setError(humanizeTxError(e));
    } finally {
      setBusy(null);
      setEmergencyFor(null);
    }
  };

  const signer = () => wallet.getSigner(chain.provider!);

  if (!deployed) {
    return (
      <div className="empty-state">
        <div className="title">Staking is not live yet</div>
        Positions will appear here once the contracts are deployed.
      </div>
    );
  }
  if (wallet.address === null) {
    return (
      <div className="empty-state">
        <div className="title">No wallet connected</div>
        <p className="mb-0">Connect a wallet to see your stakes.</p>
        <p style={{ marginTop: 14 }}>
          <button className="btn btn-primary" onClick={onConnect}>
            Connect wallet
          </button>
        </p>
      </div>
    );
  }
  if (positions.loading) {
    return (
      <div className="panel-body">
        <Skeleton width={280} />
        <div style={{ marginTop: 10 }}>
          <Skeleton width={220} />
        </div>
      </div>
    );
  }
  if (positions.error && !positions.data) {
    return (
      <div className="panel-body">
        <div className="notice notice-danger mb-0" role="alert">
          Could not load your positions: {positions.error}{' '}
          <button className="btn btn-sm" onClick={positions.refresh} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const open = (positions.data ?? []).filter((p) => p.state !== 'withdrawn');
  if (open.length === 0) {
    return (
      <div className="empty-state">
        <div className="title">No stakes yet</div>
        Stake FMX on the Stake tab and your position will show up here.
      </div>
    );
  }

  return (
    <>
      {(error || lastTx) && (
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          {error && (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          )}
          {lastTx && !error && (
            <div className="notice notice-success">
              Confirmed.{' '}
              <a href={`${EXPLORER_URL}/tx/${lastTx}`} target="_blank" rel="noreferrer noopener">
                View transaction ↗
              </a>
            </div>
          )}
        </div>
      )}
      <ul className="row-list">
        {open.map((p) => {
          const locked = p.state === 'active' && p.unlockTime > now;
          const cooling = p.state === 'cooling';
          const coolDone = cooling && p.cooldownEnd <= now;
          const isBusy = (action: string) => busy !== null && busy.id === p.id && busy.action === action;
          const anyBusy = busy !== null;
          return (
            <li key={p.id.toString()}>
              <div className="row-main">
                <div className="row-title">
                  {TIER_NAMES[p.tier] ?? `Tier ${p.tier}`}
                  <span
                    className={
                      'state-badge ' + (cooling ? 'state-cooling' : locked ? 'state-locked' : 'state-active')
                    }
                  >
                    {cooling ? (coolDone ? 'COOLDOWN OVER' : 'COOLING DOWN') : locked ? 'LOCKED' : 'ACTIVE'}
                  </span>
                </div>
                <div className="row-sub">
                  {cooling
                    ? coolDone
                      ? 'Cooldown finished — withdraw your principal.'
                      : `Withdrawable in ${formatCountdown(countdown(now, p.cooldownEnd))} (${formatDateTime(p.cooldownEnd)}). No rewards accrue during cooldown.`
                    : locked
                      ? `Unlocks in ${formatCountdown(countdown(now, p.unlockTime))} (${formatDateTime(p.unlockTime)})`
                      : 'Unlocked — exit starts a 7-day cooldown.'}
                </div>
              </div>
              <div className="row-value num">
                {formatFMX(p.amountWei)} FMX
                <span className="sub">+{formatFMX(p.pendingRewardsWei)} accrued</span>
              </div>
              <div className="row-actions">
                {p.pendingRewardsWei > 0n && (
                  <button
                    className="btn btn-sm"
                    disabled={anyBusy}
                    onClick={() => void run(p, 'claim', async () => claim(await signer(), STAKING_VAULT_ADDRESS, p.id))}
                  >
                    {isBusy('claim') ? <Spinner /> : 'Claim'}
                  </button>
                )}
                {p.state === 'active' && !locked && (
                  <button
                    className="btn btn-sm"
                    disabled={anyBusy}
                    onClick={() =>
                      void run(p, 'unstake', async () => beginUnstake(await signer(), STAKING_VAULT_ADDRESS, p.id))
                    }
                  >
                    {isBusy('unstake') ? <Spinner /> : 'Start unstake'}
                  </button>
                )}
                {cooling && (
                  <button
                    className="btn btn-sm"
                    disabled={anyBusy || !coolDone}
                    title={coolDone ? undefined : 'Available when the cooldown ends'}
                    onClick={() =>
                      void run(p, 'withdraw', async () => withdraw(await signer(), STAKING_VAULT_ADDRESS, p.id))
                    }
                  >
                    {isBusy('withdraw') ? <Spinner /> : 'Withdraw'}
                  </button>
                )}
                {p.state === 'active' && locked && (
                  <button className="btn btn-sm btn-danger-ghost" disabled={anyBusy} onClick={() => setEmergencyFor(p)}>
                    Emergency exit
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {emergencyFor && (
        <Modal title="Emergency exit — read this" onClose={() => setEmergencyFor(null)}>
          <div className="notice notice-danger">
            This position is locked until <strong>{formatDateTime(emergencyFor.unlockTime)}</strong>. Leaving now
            forfeits, irreversibly:
          </div>
          <table className="confirm-table">
            <tbody>
              <tr>
                <th>All unclaimed rewards</th>
                <td className="num">−{formatFMX(emergencyFor.pendingRewardsWei)} FMX</td>
              </tr>
              <tr>
                <th>{Number(penaltyBps) / 100}% of principal</th>
                <td className="num">−{formatFMX((emergencyFor.amountWei * penaltyBps) / 10_000n)} FMX</td>
              </tr>
              <tr>
                <th className="em">You get back (after 7-day cooldown)</th>
                <td className="em num">
                  {formatFMX(emergencyFor.amountWei - (emergencyFor.amountWei * penaltyBps) / 10_000n)} FMX
                </td>
              </tr>
            </tbody>
          </table>
          <p className="small muted">
            Both forfeits go back into the reward pool for the remaining stakers. The 7-day cooldown still applies
            before you can withdraw.
          </p>
          <div className="actions-row">
            <button className="btn" onClick={() => setEmergencyFor(null)}>
              Keep the stake
            </button>
            <button
              className="btn btn-danger-ghost push"
              disabled={busy !== null}
              onClick={() =>
                void run(emergencyFor, 'emergency', async () =>
                  emergencyExit(await signer(), STAKING_VAULT_ADDRESS, emergencyFor.id),
                )
              }
            >
              {busy?.action === 'emergency' ? <Spinner /> : 'Forfeit and exit'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
