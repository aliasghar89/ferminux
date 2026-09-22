// The transfer status machine.
//
// A transfer is NOT complete when the source transaction confirms — it is
// complete when the DESTINATION bridge has marked its transferId processed.
// Everything in between is honestly labelled as what it is: waiting for source
// confirmations, then waiting for validators and a relayer. Nothing here
// pretends to know more than the two chains have actually said.
// Pure functions, no browser globals — driven directly by tests/status.test.mjs.

import type { ChainConfig } from '../config.ts';
import { RELAY_OVERHEAD_SECONDS } from '../config.ts';
import type { TransferPhase, TransferRecord } from './transfers.ts';
import type { ChainLiveness } from './liveness.ts';

export interface StatusInput {
  /** null while the source transaction is still unmined. */
  receiptStatus: 0 | 1 | null;
  receiptBlockNumber: number | null;
  /** Current head of the SOURCE chain. */
  srcBlockNumber: number | null;
  /** processed(transferId) on the DESTINATION bridge. null = not yet known. */
  destinationProcessed: boolean | null;
  /** false when the destination chain has no configured bridge address. */
  destinationKnown: boolean;
  requiredConfirmations: number;
}

export interface TransferStatus {
  phase: TransferPhase;
  confirmations: number;
  required: number;
  /** Short label for the status pill. */
  label: string;
  /** One honest sentence about what is happening and who is acting. */
  detail: string;
  /** 0..1 for the progress bar. */
  progress: number;
  terminal: boolean;
}

/**
 * Derive the phase from evidence only:
 *   destination says processed        -> complete   (authoritative, checked first)
 *   source receipt says status 0      -> reverted   (nothing left the wallet)
 *   no receipt yet                    -> submitted
 *   receipt, confs < required         -> confirming
 *   receipt, confs >= required        -> executing
 * A destination we cannot query at all is reported as unverifiable rather than
 * being quietly shown as pending forever.
 */
export function deriveStatus(input: StatusInput): TransferStatus {
  const {
    receiptStatus,
    receiptBlockNumber,
    srcBlockNumber,
    destinationProcessed,
    destinationKnown,
    requiredConfirmations,
  } = input;
  const required = Math.max(1, requiredConfirmations);

  const confirmations =
    receiptBlockNumber !== null && srcBlockNumber !== null
      ? Math.max(0, srcBlockNumber - receiptBlockNumber + 1)
      : 0;

  if (destinationProcessed === true) {
    return {
      phase: 'complete',
      confirmations,
      required,
      label: 'Complete',
      detail: 'The destination bridge has executed this transfer. The funds are in the recipient wallet.',
      progress: 1,
      terminal: true,
    };
  }

  if (receiptStatus === 0) {
    return {
      phase: 'reverted',
      confirmations,
      required,
      label: 'Failed',
      detail: 'The source transaction reverted. Nothing was locked or burned — only the gas was spent.',
      progress: 0,
      terminal: true,
    };
  }

  if (receiptStatus === null) {
    return {
      phase: 'submitted',
      confirmations: 0,
      required,
      label: 'Pending',
      detail: 'Waiting for the source chain to include the transaction.',
      progress: 0.05,
      terminal: false,
    };
  }

  if (confirmations < required) {
    return {
      phase: 'confirming',
      confirmations,
      required,
      label: `Confirming ${confirmations}/${required}`,
      detail: `Mined on the source chain. Validators wait for ${required} confirmations before attesting, so a reorg cannot mint on the other side.`,
      progress: 0.1 + 0.5 * (confirmations / required),
      terminal: false,
    };
  }

  if (!destinationKnown) {
    return {
      phase: 'unverifiable',
      confirmations,
      required,
      label: 'Unverifiable',
      detail:
        'The source transaction is confirmed, but no bridge address is configured for the destination chain, so this app cannot confirm delivery. Check the destination explorer.',
      progress: 0.6,
      terminal: true,
    };
  }

  return {
    phase: 'executing',
    confirmations,
    required,
    label: 'Executing',
    detail:
      'Confirmed on the source chain. Validators are signing; any relayer can then submit the transfer to the destination bridge.',
    progress: destinationProcessed === null ? 0.65 : 0.75,
    terminal: false,
  };
}

/**
 * Rebuild a status from a persisted record alone — used on page load, before
 * the first poll has come back, and for settled transfers that are never
 * polled again. It reports the last thing the chains actually said, so a
 * reloaded page never shows a transfer as further along than it was.
 */
export function statusFromRecord(record: TransferRecord, requiredConfirmations: number): TransferStatus {
  const required = Math.max(1, requiredConfirmations);
  switch (record.phase) {
    case 'complete':
      return deriveStatus({
        receiptStatus: 1,
        receiptBlockNumber: record.txBlockNumber,
        srcBlockNumber: null,
        destinationProcessed: true,
        destinationKnown: true,
        requiredConfirmations: required,
      });
    case 'reverted':
      return deriveStatus({
        receiptStatus: 0,
        receiptBlockNumber: record.txBlockNumber,
        srcBlockNumber: null,
        destinationProcessed: false,
        destinationKnown: true,
        requiredConfirmations: required,
      });
    case 'unverifiable':
      return deriveStatus({
        receiptStatus: 1,
        receiptBlockNumber: 0,
        srcBlockNumber: required,
        destinationProcessed: null,
        destinationKnown: false,
        requiredConfirmations: required,
      });
    case 'executing':
      return deriveStatus({
        receiptStatus: 1,
        receiptBlockNumber: 0,
        srcBlockNumber: required,
        destinationProcessed: false,
        destinationKnown: true,
        requiredConfirmations: required,
      });
    case 'confirming':
      return deriveStatus({
        receiptStatus: 1,
        receiptBlockNumber: 0,
        srcBlockNumber: 0,
        destinationProcessed: false,
        destinationKnown: true,
        requiredConfirmations: required,
      });
    default:
      return deriveStatus({
        receiptStatus: null,
        receiptBlockNumber: null,
        srcBlockNumber: null,
        destinationProcessed: null,
        destinationKnown: true,
        requiredConfirmations: required,
      });
  }
}

/**
 * Honest end-to-end estimate: the source confirmations the relayers wait for,
 * plus validator/relayer latency, plus one destination block for inclusion.
 * It is an estimate of the normal path — it is not a deadline, and the UI must
 * never present it as one.
 */
export function estimateEtaSeconds(src: ChainConfig, dst: ChainConfig, live: ChainLiveness | null = null): number {
  // With a live pace report, the source wait is priced at the MEASURED median
  // gap rather than the nominal block time — the number that was wrong by
  // hours during the 2026-08-21 stall. Checkpoint-mode chains wait on the
  // operators' attestation cadence instead; the current lag is the best proxy.
  const gap = live?.pace?.medianGapSeconds ?? src.blockSeconds;
  const blocks =
    live?.finalityMode === 'checkpoint' && live.checkpoint?.lagBlocks != null
      ? Math.max(live.checkpoint.lagBlocks, 1)
      : src.confirmations;
  const sourceWait = blocks * gap;
  const destinationInclusion = Math.max(dst.blockSeconds, dst.blockSeconds * 2);
  return Math.round(sourceWait + RELAY_OVERHEAD_SECONDS + destinationInclusion);
}

/** Seconds still expected, from the moment the source transaction was sent. */
export function etaRemainingSeconds(record: TransferRecord, total: number, nowMs: number): number {
  const elapsed = Math.max(0, (nowMs - record.createdAt) / 1000);
  return Math.max(0, Math.round(total - elapsed));
}

/**
 * A transfer that is confirmed on the source but has not landed after several
 * times the normal window is not "still fine" — say so.
 */
export function isOverdue(record: TransferRecord, total: number, nowMs: number, factor = 4): boolean {
  if (record.phase !== 'executing' && record.phase !== 'confirming') return false;
  return nowMs - record.createdAt > total * factor * 1000;
}
