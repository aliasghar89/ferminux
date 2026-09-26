// The four numbers that make the network look alive or dead. They are real
// contract reads or they are a dash — never an estimate.

import type { Poll, VaultData, RosterData } from '../state/useStakingData.ts';
import { runwaySeconds } from '../lib/math.ts';
import { formatFMX, formatMonths } from '../lib/format.ts';
import { Skeleton } from '../components/ui.tsx';

export function StatsHeader({
  vault,
  roster,
  deployed,
}: {
  vault: Poll<VaultData>;
  roster: Poll<RosterData>;
  deployed: boolean;
}) {
  const o = vault.data?.overview ?? null;
  const activeNodes = roster.data ? roster.data.nodes.filter((n) => n.active).length : null;
  const runway = o ? runwaySeconds(o.rewardPoolWei, o.totalWeightedUnitsWei, o.dripPerYearWei) : null;

  const value = (loading: boolean, content: React.ReactNode) => {
    if (!deployed) return <span className="muted">—</span>;
    if (loading) return <Skeleton width={72} />;
    return content;
  };

  return (
    <div className="stats-strip">
      <div className="stats-strip-inner">
        <div className="stat">
          <div className="k">Total staked</div>
          <div className="v">
            {value(
              vault.loading,
              o ? (
                <>
                  {formatFMX(o.totalStakedWei, 0)}
                  <span className="u">FMX</span>
                </>
              ) : (
                <span className="muted">—</span>
              ),
            )}
          </div>
        </div>
        <div className="stat">
          <div className="k">Stakers</div>
          <div className="v">{value(vault.loading, o ? o.stakerCount.toLocaleString('en-US') : <span className="muted">—</span>)}</div>
        </div>
        <div className="stat">
          <div className="k">Bonded nodes</div>
          <div className="v">{value(roster.loading, activeNodes !== null ? activeNodes.toLocaleString('en-US') : <span className="muted">—</span>)}</div>
          <div className="sub">on-chain bonds, not distinct operators</div>
        </div>
        <div className="stat">
          <div className="k">Reward pool</div>
          <div className="v">
            {value(
              vault.loading,
              o ? (
                <>
                  {formatFMX(o.rewardPoolWei, 0)}
                  <span className="u">FMX</span>
                </>
              ) : (
                <span className="muted">—</span>
              ),
            )}
          </div>
          {deployed && o && (
            <div className="sub">
              {runway === null ? 'no outlay yet — nothing staked' : `runs ${formatMonths(runway)} at current stake`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
