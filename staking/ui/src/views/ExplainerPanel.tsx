// HOW IT WORKS — the honest explainer. Ferminux runs on authority consensus
// (Clique proof-of-authority), staking does not secure the chain, the rewards
// come from a prefunded pool, and every trusted component is named as such.
// Copy follows staking/DESIGN.md, corrected for the consensus decision: never
// describe a stake-elected signer set or a proof-of-stake transition.

import type { ChainState } from '../state/useChain.ts';
import type { Poll, VaultData } from '../state/useStakingData.ts';
import { runwaySeconds } from '../lib/math.ts';
import { formatFMX, formatMonths } from '../lib/format.ts';

// `chain` stays in the props (App passes it) for figures this panel may read again later.
export function ExplainerPanel({ vault }: { vault: Poll<VaultData>; chain: ChainState }) {
  const o = vault.data?.overview ?? null;
  const runway = o ? runwaySeconds(o.rewardPoolWei, o.totalWeightedUnitsWei, o.dripPerYearWei) : null;

  return (
    <div className="panel-body">
      <div className="explainer">
        <h3>What staking does today — and what it does not</h3>
        <p>
          Ferminux uses authority consensus (Clique proof-of-authority): a set of authorised signers, operated by
          the foundation, confirms a block every 7 seconds in rotation. <strong>Staking does not secure the
          chain</strong> — locking FMX adds zero consensus security, and we will not tell you otherwise. FMX staking
          is a yield programme funded from the ecosystem allocation. What staking actually does now:
        </p>
        <ul>
          <li>
            <strong>Records who runs infrastructure.</strong> Validator-track bonds, registered node keys and
            measured uptime are kept in the node registry and earn the validator tier&apos;s rate. They do not
            choose the signers: the signer set stays the authorised set the foundation operates, and staking gives
            no seat in it.
          </li>
          <li>
            <strong>Supports the network.</strong> Registered nodes add block propagation, RPC capacity and data
            redundancy. That is real service — but it is <em>service, not security</em>.
          </li>
          <li>
            <strong>Identifies operators.</strong> Twelve months of uptime history separates people who can run
            infrastructure from people who filled in a form.
          </li>
        </ul>

        <h3>Where the rewards come from</h3>
        <p>
          Not from thin air, and not paid out of block rewards. The pool is a{' '}
          <strong>one-time transfer from the ecosystem allocation</strong>, held by the vault and paid out at up to
          10%/yr per weighted unit, bounded by a hard drip cap
          {o && <> of {formatFMX(o.dripPerYearWei, 0)} FMX/yr</>}. Two honest consequences:
        </p>
        <ul>
          <li>
            <strong>The pool is finite and fail-closed.</strong> Rewards are paid only from its actual balance
            {o && (
              <>
                {' '}
                — right now <span className="num">{formatFMX(o.rewardPoolWei, 0)} FMX</span>, which funds{' '}
                {runway === null ? 'rewards indefinitely because nothing is staked yet' : formatMonths(runway)} at the
                current stake
              </>
            )}
            . If it empties, accrual stops. No IOUs, no minting. Principal is never touched.
          </li>
          <li>
            <strong>The advertised APY is a cap, not a floor.</strong> Once total weighted stake passes the drip
            knee, every tier&apos;s rate scales down pro-rata. The app always shows the live effective rate.
          </li>
        </ul>
        <p>
          Yields are quoted in FMX only. FMX has no liquid market yet; any USD figure you may have seen elsewhere
          is an internal mark, not a price, and we make no USD promises.
        </p>

        <h3>What is trusted, plainly</h3>
        <ul>
          <li>
            <strong>Uptime attestation is an operator-run oracle.</strong> Liveness cannot be proven trustlessly on
            this chain, so a team-run watchtower posts signed daily attestations with published challenge logs. Its
            power is deliberately bounded: it can only move the validator tier between 2.0× and 3.0× — it can never
            touch principal or slash.
          </li>
          <li>
            <strong>Supply is concentrated.</strong> Most FMX is currently founder-held; premine wallets are
            excluded from staking rewards by contract.
          </li>
          <li>
            <strong>The vault is deliberately boring.</strong> No upgradeability, no delegatecall, owner (a 2-of-3
            multisig) can never move staked principal, parameter changes sit behind a 48-hour timelock, and the
            code targets the Paris EVM with an external audit before deployment.
          </li>
        </ul>

        <p className="small muted" style={{ marginTop: 20, marginBottom: 0 }}>
          Locks bind. Emergency exit from a locked tier forfeits all unclaimed rewards plus 5% of principal — into
          the pool, for everyone else. If that sounds harsh, it is the price of the weights being real.
        </p>
      </div>
    </div>
  );
}
