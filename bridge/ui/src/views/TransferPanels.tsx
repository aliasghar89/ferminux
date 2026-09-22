import { FALLBACK_CONFIRMATIONS, chainByKey, explorerAddressUrl, explorerTxUrl } from '../config.ts';
import { formatAgo, formatAmount, formatDuration, shortHash } from '../lib/amounts.ts';
import { estimateEtaSeconds, etaRemainingSeconds, isOverdue, statusFromRecord, type TransferStatus } from '../lib/status.ts';
import { assessLiveness, describeWait, livenessForChain, type RelayerStatus } from '../lib/liveness.ts';
import { inFlight, settled, type TransferRecord } from '../lib/transfers.ts';
import { Badge, CopyButton, ExternalLink, ProgressBar } from '../components/ui.tsx';

/** Transfers still moving — polled on both chains until the destination lands. */
export function ActiveTransfers({
  records,
  statuses,
  now,
  ephemeral,
  liveness = null,
}: {
  records: TransferRecord[];
  statuses: Record<string, TransferStatus>;
  now: number;
  ephemeral: boolean;
  liveness?: RelayerStatus | null;
}) {
  const active = inFlight(records);
  if (active.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>In flight ({active.length})</h2>
        <span className="spacer" />
        <span className="small muted">Polling both chains</span>
      </div>
      <div>
        {active.map((r) => (
          <TransferCard key={r.txHash} record={r} status={statuses[r.txHash]} now={now} liveness={liveness} />
        ))}
      </div>
      {ephemeral && (
        <div className="panel-foot">
          Storage is unavailable in this browser, so these transfers are held in memory only — copy the transfer id if
          you may need to reload.
        </div>
      )}
    </section>
  );
}

/** Everything that reached a final state, newest first. */
export function HistoryPanel({
  records,
  statuses,
  now,
  onClear,
}: {
  records: TransferRecord[];
  statuses: Record<string, TransferStatus>;
  now: number;
  onClear: () => void;
}) {
  const past = settled(records);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>History</h2>
        <span className="spacer" />
        {past.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {past.length === 0 ? (
        <div className="empty-state">
          <div className="title">No completed transfers yet</div>
          Transfers you make in this browser are kept here, with the state each one finished in.
        </div>
      ) : (
        <div>
          {past.map((r) => (
            <TransferCard key={r.txHash} record={r} status={statuses[r.txHash]} now={now} compact />
          ))}
        </div>
      )}
    </section>
  );
}

function TransferCard({
  record,
  status,
  now,
  compact,
  liveness = null,
}: {
  record: TransferRecord;
  status: TransferStatus | undefined;
  now: number;
  compact?: boolean;
  liveness?: RelayerStatus | null;
}) {
  const src = chainByKey(record.srcChainKey);
  const dst = chainByKey(record.dstChainKey);
  const required = src?.confirmations ?? FALLBACK_CONFIRMATIONS;
  const st = status ?? statusFromRecord(record, required);

  // The live layer: what the source chain is doing RIGHT NOW, from the relayer.
  // Only applies while the source side is still the thing being waited on
  // (confirming / executing). With no report every value below is null and the
  // card renders exactly the plain confirmation count it always did.
  const live = src ? livenessForChain(liveness, src.chainId) : null;
  const verdict = assessLiveness(live, src?.short ?? record.srcChainKey, now / 1000);
  const sourceSide = st.phase === 'confirming' || st.phase === 'executing';
  const wait =
    sourceSide && st.phase === 'confirming'
      ? describeWait(live, verdict, record.txBlockNumber, headFrom(st, record), required, src?.blockSeconds ?? 7)
      : sourceSide && verdict.paused
        ? describeWait(live, verdict, record.txBlockNumber, null, required, src?.blockSeconds ?? 7)
        : null;
  const liveApplies = wait !== null && wait.kind !== 'none';

  const label = liveApplies ? wait.label : st.label;
  const detail = liveApplies ? wait.detail : st.detail;
  const progress = liveApplies && wait.progress !== null ? 0.1 + 0.5 * wait.progress : st.progress;

  const total = src && dst ? estimateEtaSeconds(src, dst, live) : 0;
  const remaining = total > 0 ? etaRemainingSeconds(record, total, now) : 0;
  const overdue = total > 0 && isOverdue(record, total, now);

  const paused = liveApplies && wait.kind === 'paused';
  const tone = st.phase === 'complete' ? 'done' : st.phase === 'reverted' || paused ? 'fail' : 'normal';
  const badgeKind =
    st.phase === 'complete'
      ? 'ok'
      : st.phase === 'reverted' || paused
        ? 'bad'
        : st.phase === 'unverifiable' || wait?.kind === 'checkpoint'
          ? 'wait'
          : 'default';

  return (
    <article className="transfer">
      <div className="transfer-head">
        <span className="transfer-route">
          {src?.short ?? record.srcChainKey} → {dst?.short ?? record.dstChainKey}
        </span>
        <Badge kind={badgeKind}>{label}</Badge>
        <span className="transfer-amount num">
          {formatAmount(BigInt(record.amountWei), record.decimals)} {record.dstSymbol}
        </span>
      </div>

      {!compact && <ProgressBar fraction={progress} tone={tone} />}

      <p className="transfer-detail">{detail}</p>

      {!compact && !st.terminal && liveApplies && wait.kind !== 'paused' && verdict.paceText && (
        <p className="transfer-wait num">
          Block pace: {verdict.paceText}
          {wait.kind === 'checkpoint' && verdict.checkpointLagBlocks !== null
            ? ` · checkpoint ${verdict.checkpointLagBlocks} block${verdict.checkpointLagBlocks === 1 ? '' : 's'} behind head`
            : ''}
        </p>
      )}

      {!compact && !st.terminal && paused && (
        <p className="transfer-wait paused">
          Your funds are locked on {src?.short ?? 'the source chain'} and nothing is lost. Validators will sign once{' '}
          {src?.short ?? 'the source chain'} recovers; no action is needed from you.
        </p>
      )}

      {!compact && !st.terminal && !paused && total > 0 && (
        <p className="transfer-detail muted">
          {overdue
            ? `This is taking longer than the usual ${formatDuration(total)}. The funds are not lost — they are locked on ${src?.short ?? 'the source chain'} until a quorum signs. Contact the operators with the transfer id below.`
            : remaining > 0
              ? `Typically about ${formatDuration(total)} in total${liveApplies ? ' at the measured pace' : ''} — roughly ${formatDuration(remaining)} left.`
              : `Usually done by now; validators may be waiting for a deeper confirmation.`}
        </p>
      )}

      <div className="transfer-links">
        <span className="muted num">
          Sent {formatAmount(BigInt(record.sentWei), record.decimals)} {record.symbol} · fee{' '}
          {formatAmount(BigInt(record.feeWei), record.decimals, 8)} {record.symbol} · {formatAgo(record.createdAt, now)}
        </span>
      </div>

      <div className="transfer-links">
        {src && <ExternalLink href={explorerTxUrl(src, record.txHash)}>Source tx {shortHash(record.txHash)}</ExternalLink>}
        {dst && record.dstBridge && (
          <ExternalLink href={explorerAddressUrl(dst, record.dstBridge)}>Destination bridge</ExternalLink>
        )}
        <span className="muted">
          To {record.recipient.slice(0, 10)}…{record.recipient.slice(-6)}
        </span>
      </div>

      {record.transferId ? (
        <div className="transfer-id">
          Transfer id {record.transferId} <CopyButton text={record.transferId} label="Copy id" />
        </div>
      ) : (
        <div className="transfer-id">
          No transfer id — the Sent event could not be read from the receipt, so this transfer cannot be tracked
          automatically.
        </div>
      )}

      {record.error && <p className="transfer-detail" style={{ color: 'var(--danger)' }}>{record.error}</p>}
    </article>
  );
}

/** Reconstruct the source head the status machine last saw: block + confirmations - 1. */
function headFrom(st: TransferStatus, record: TransferRecord): number | null {
  if (record.txBlockNumber === null) return null;
  return record.txBlockNumber + Math.max(0, st.confirmations - 1);
}
