import type { ChainConfig } from '../config.ts';
import { formatDuration } from '../lib/amounts.ts';
import { assessLiveness, livenessForChain, liveSourceWaitSeconds, type RelayerStatus } from '../lib/liveness.ts';

/**
 * The source chain's live condition, in the user's terms: is it producing
 * blocks at pace, and how far behind is the attested checkpoint. Renders
 * nothing when there is no report — the confirmation count still shows on
 * each transfer, exactly as before.
 */
export function ChainHealth({
  chain,
  status,
  now,
  statusError,
}: {
  chain: ChainConfig;
  status: RelayerStatus | null;
  now: number;
  statusError: string | null;
}) {
  const live = livenessForChain(status, chain.chainId);
  const verdict = assessLiveness(live, chain.short, now / 1000);

  if (verdict.state === 'unknown') {
    if (!statusError) return null;
    return (
      <p className="health-foot muted" role="status">
        Live block-pace report unavailable ({statusError}); showing plain confirmation counts.
      </p>
    );
  }

  const wait = liveSourceWaitSeconds(live, verdict, chain.confirmations, chain.blockSeconds);
  const cp = live?.checkpoint ?? null;
  const tone = verdict.paused ? 'health-paused' : verdict.state === 'slow' ? 'health-slow' : 'health-ok';

  return (
    <div className={`health ${tone}`} role={verdict.paused ? 'alert' : 'status'}>
      <div className="health-head">
        <span className={'dot ' + (verdict.paused ? 'dot-bad' : verdict.state === 'slow' ? 'dot-warn' : 'dot-ok')} />
        <strong>
          {verdict.paused ? `Transfers from ${chain.short} are paused` : verdict.state === 'slow' ? `${chain.short} is slow` : `${chain.short} is healthy`}
        </strong>
      </div>
      <p className="health-msg">{verdict.message}</p>
      <dl className="health-kv num">
        {verdict.medianGapSeconds !== null && verdict.targetSeconds !== null && (
          <>
            <dt>Block pace</dt>
            <dd>
              {fmt(verdict.medianGapSeconds)} median · target {fmt(verdict.targetSeconds)}
              {live?.pace?.sampleBlocks ? ` · last ${live.pace.sampleBlocks} blocks` : ''}
            </dd>
          </>
        )}
        {verdict.checkpointEnforced && (
          <>
            <dt>Checkpoint</dt>
            <dd>
              {cp && cp.blockNumber !== null
                ? `block ${cp.blockNumber}${cp.lagBlocks !== null ? ` · ${cp.lagBlocks} block${cp.lagBlocks === 1 ? '' : 's'} behind head` : ''}${
                    cp.attestedAt !== null ? ` · attested ${formatDuration(Math.max(0, now / 1000 - cp.attestedAt))} ago` : ''
                  }${cp.state !== 'ok' ? ` · ${cp.state}` : ''}`
                : 'none published'}
            </dd>
          </>
        )}
        <dt>Finality rule</dt>
        <dd>
          {verdict.checkpointMode
            ? 'multisig-attested checkpoint only'
            : `${chain.confirmations} confirmations of accumulated work, at the measured pace${verdict.checkpointEnforced ? ', and never above the attested checkpoint' : ''}`}
        </dd>
        {!verdict.paused && wait !== null && (
          <>
            <dt>Source wait now</dt>
            <dd>about {formatDuration(wait)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function fmt(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds * 10) / 10} s`;
  return formatDuration(seconds);
}
