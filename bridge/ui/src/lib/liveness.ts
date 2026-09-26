// Source-chain liveness and weak-subjectivity checkpoints, as reported by the
// relayer's /status endpoint.
//
// Why this exists: a fixed confirmation COUNT ("Confirming 12/64") is the wrong
// primitive twice over. On the PoW chain the block pace swings from 7 s to
// infinity — during the 2026-08-21 stall the app sat on "Confirming 12/64" for
// hours with no explanation. After the Clique fork no count prices a reorg at
// all, so validators will only sign up to the latest multisig-attested
// checkpoint. This module turns what the relayer MEASURED (block pace, the
// signing verdict, checkpoint lag) into what the user should be told.
//
// THE SHAPE IS THE RELAYER'S, not ours: per chain, `finality` is exactly
// FinalityMonitor.status() from bridge/relayer/src/finality.ts —
//
//   finality: {
//     mode: 'work-and-time' | 'checkpoint' | 'count',
//     pace:       { state, targetBlockTimeMs, medianGapMs, samples, headNumber, headAgeMs, reason, ... } | null,
//     checkpoint: { state, number, hash, attestedAt(ms), ageMs, maxAgeMs, lagBlocks, hashVerified, reason, ... } | null,
//     signing:    { paused, reason },
//   }
//
// and, per chain, an optional `scan` { lagging, lagBlocks, reason } saying
// whether the relayer is still seeing transfers sent from that chain; the
// document carries a top-level `generatedAt` (unix ms). The fixture at
// tests/fixtures/relayer-status.json is a capture of that output and the
// relayer's own suite asserts its key sets against the emitter, so the two
// sides cannot drift apart silently again.
//
// Everything here is pure and defensive: the document may be missing, partial,
// stale or malformed, and in every one of those cases the answer is "unknown"
// — the UI then falls back to the plain confirmation count rather than
// crashing or inventing a reassurance. A chain whose `finality` block lacks the
// signing verdict is UNKNOWN, never "ok". Driven by tests/liveness.test.mjs.

import type { ChainConfig } from '../config.ts';

/** How the relayer decides a source block is final on this chain. */
export type FinalityMode = 'work' | 'checkpoint' | 'count';

export type PaceState = 'ok' | 'degraded' | 'unknown';

export interface PaceReport {
  /** The relayer's own verdict on the pace. */
  state: PaceState;
  /** Nominal block interval the chain is supposed to keep. */
  targetSeconds: number;
  /** Median of the last `sampleBlocks` inter-block gaps; null when unmeasured. */
  medianGapSeconds: number | null;
  sampleBlocks: number;
  headBlock: number | null;
  /** Seconds since the head block, as the relayer measured it. */
  headAgeSeconds: number | null;
  /** The relayer's sentence for a non-ok state. */
  reason: string | null;
}

export type CheckpointState = 'ok' | 'missing' | 'stale' | 'mismatch' | 'unreadable' | 'unconfigured';

export interface CheckpointReport {
  state: CheckpointState;
  /** Latest multisig-attested source block, or null if none has ever been published. */
  blockNumber: number | null;
  blockHash: string | null;
  /** Unix seconds when the checkpoint was attested on the destination chain. */
  attestedAt: number | null;
  /** Age as the relayer computed it, seconds. */
  ageSeconds: number | null;
  /** Source head minus attested block, as the relayer computed it. */
  lagBlocks: number | null;
  /** Relayer's configured maximum checkpoint age. */
  maxAgeSeconds: number | null;
  /** The relayer's own verdict: too old to sign against. */
  stale: boolean;
  /** true = hash matched the relayer's own view; false = MISMATCH (reorg); null = not checked. */
  verified: boolean | null;
  reason: string | null;
}

export interface SigningReport {
  /** THE verdict: true whenever this validator will not sign right now. */
  paused: boolean;
  reason: string | null;
}

/**
 * Is the relayer still SEEING transfers sent from this chain? scanHealth() in
 * bridge/relayer/src/watcher.ts. Optional: a relayer that predates it simply
 * omits the block.
 */
export interface ScanReport {
  lagging: boolean;
  lagBlocks: number | null;
  reason: string | null;
}

export interface ChainLiveness {
  chainId: number;
  name: string | null;
  confirmations: number | null;
  finalityMode: FinalityMode | null;
  pace: PaceReport | null;
  checkpoint: CheckpointReport | null;
  /** null when the relayer did not report a verdict — the chain is then UNKNOWN, never ok. */
  signing: SigningReport | null;
  /** null when not reported. */
  scan: ScanReport | null;
}

export interface RelayerStatus {
  /** Unix milliseconds the document was generated, or null if not stated. */
  generatedAt: number | null;
  chains: ChainLiveness[];
}

/** Median gap above this multiple of the target is "slower than usual" (still signing). */
export const SLOW_PACE_FACTOR = 2;

/** A status document older than this is treated as absent — stale reassurance is worse than none. */
export const STATUS_MAX_AGE_MS = 5 * 60 * 1000;

// ------------------------------------------------------------------ parsing

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function timestampMs(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n < 1e12 ? n * 1000 : n; // seconds vs milliseconds
  const s = str(v);
  if (s) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function msToSeconds(v: unknown): number | null {
  const n = num(v);
  return n === null || n < 0 ? null : n / 1000;
}

const PACE_STATES: readonly PaceState[] = ['ok', 'degraded', 'unknown'];
const CHECKPOINT_STATES: readonly CheckpointState[] = ['ok', 'missing', 'stale', 'mismatch', 'unreadable', 'unconfigured'];

function parseMode(v: unknown): FinalityMode | null {
  if (v === 'work-and-time' || v === 'work') return 'work';
  if (v === 'checkpoint') return 'checkpoint';
  if (v === 'count') return 'count';
  return null;
}

function parsePace(v: unknown): PaceReport | null {
  const p = obj(v);
  if (!p) return null;
  const state = p.state;
  if (!PACE_STATES.includes(state as PaceState)) return null;
  const targetSeconds = msToSeconds(p.targetBlockTimeMs);
  if (targetSeconds === null || targetSeconds <= 0) return null;
  return {
    state: state as PaceState,
    targetSeconds,
    medianGapSeconds: msToSeconds(p.medianGapMs),
    sampleBlocks: num(p.samples) ?? 0,
    headBlock: num(p.headNumber),
    headAgeSeconds: msToSeconds(p.headAgeMs),
    reason: str(p.reason),
  };
}

function parseCheckpoint(v: unknown): CheckpointReport | null {
  const c = obj(v);
  if (!c) return null;
  const state = c.state;
  if (!CHECKPOINT_STATES.includes(state as CheckpointState)) return null;
  const hashVerified = bool(c.hashVerified);
  const number = num(c.number);
  return {
    state: state as CheckpointState,
    // The registry reports 0 while empty; the relayer calls that 'missing'.
    blockNumber: number !== null && number > 0 ? number : null,
    blockHash: str(c.hash),
    attestedAt: c.attestedAt === null || c.attestedAt === undefined ? null : msToSeconds(timestampMs(c.attestedAt)),
    ageSeconds: msToSeconds(c.ageMs),
    lagBlocks: num(c.lagBlocks),
    maxAgeSeconds: msToSeconds(c.maxAgeMs),
    stale: state === 'stale',
    verified: state === 'mismatch' ? false : hashVerified === true ? true : null,
    reason: str(c.reason),
  };
}

function parseSigning(v: unknown): SigningReport | null {
  const s = obj(v);
  if (!s) return null;
  const paused = bool(s.paused);
  if (paused === null) return null;
  return { paused, reason: str(s.reason) };
}

function parseScan(v: unknown): ScanReport | null {
  const s = obj(v);
  if (!s) return null;
  const lagging = bool(s.lagging);
  if (lagging === null) return null;
  return { lagging, lagBlocks: num(s.lagBlocks), reason: str(s.reason) };
}

function parseChain(v: unknown): ChainLiveness | null {
  const c = obj(v);
  if (!c) return null;
  const chainId = num(c.chainId);
  if (chainId === null) return null;
  const f = obj(c.finality);
  return {
    chainId,
    name: str(c.name),
    confirmations: num(c.confirmations),
    finalityMode: f ? parseMode(f.mode) : null,
    pace: f ? parsePace(f.pace) : null,
    checkpoint: f ? parseCheckpoint(f.checkpoint) : null,
    signing: f ? parseSigning(f.signing) : null,
    scan: parseScan(c.scan),
  };
}

/**
 * Accept whatever the relayer sent and keep only what is well-formed. Never
 * throws. Returns null only when the document is not an object with a `chains`
 * array at all.
 */
export function parseRelayerStatus(raw: unknown): RelayerStatus | null {
  const doc = obj(raw);
  if (!doc || !Array.isArray(doc.chains)) return null;
  return {
    generatedAt: timestampMs(doc.generatedAt),
    chains: doc.chains.map(parseChain).filter((c): c is ChainLiveness => c !== null),
  };
}

/**
 * A document the app should still act on: present, stamped, and not older than
 * STATUS_MAX_AGE_MS. A MISSING stamp is stale, not fresh: a status.json that a
 * cron stopped rewriting must not be trusted forever.
 */
export function isStatusFresh(status: RelayerStatus | null, nowMs: number, maxAgeMs: number = STATUS_MAX_AGE_MS): boolean {
  if (!status) return false;
  if (status.generatedAt === null) return false;
  return nowMs - status.generatedAt <= maxAgeMs;
}

export function livenessForChain(status: RelayerStatus | null, chainId: number): ChainLiveness | null {
  return status?.chains.find((c) => c.chainId === chainId) ?? null;
}

// ------------------------------------------------------------------ verdicts

export type LivenessState =
  /** No usable measurement — render the plain confirmation count. */
  | 'unknown'
  /** Validators are signing; pace within tolerance; checkpoint (if used) fresh and verified. */
  | 'ok'
  /** Blocks are slow but the relayer is still signing. */
  | 'slow'
  /** Relayer refuses to sign: pace far below nominal (or stalled). */
  | 'degraded'
  /** A registry is configured but no checkpoint has been published. */
  | 'checkpoint-missing'
  /** Checkpoint exists but is older than the relayer's max age. */
  | 'checkpoint-stale'
  /** Checkpoint hash does not match the relayer's own view: a reorg was detected. */
  | 'checkpoint-mismatch'
  /** Relayer refuses to sign for another stated reason (pace unmeasurable, registry unreadable). */
  | 'paused';

export interface LivenessVerdict {
  state: LivenessState;
  /** True whenever validators will NOT sign right now. */
  paused: boolean;
  /** One plain sentence, safe to show next to a transfer. */
  message: string;
  /** "12 s median vs 7 s target" or null when no pace was measured. */
  paceText: string | null;
  /** Measured median gap, or null. */
  medianGapSeconds: number | null;
  targetSeconds: number | null;
  /** Head minus latest attested checkpoint, or null when not applicable. */
  checkpointLagBlocks: number | null;
  /** Whether the checkpoint rule is the sole finality source on this chain. */
  checkpointMode: boolean;
  /** Whether a checkpoint registry is enforced on this chain at all (any mode). */
  checkpointEnforced: boolean;
}

function paceText(p: PaceReport | null): string | null {
  if (!p || p.medianGapSeconds === null) return null;
  return `${formatSeconds(p.medianGapSeconds)} median between blocks vs ${formatSeconds(p.targetSeconds)} target`;
}

function formatSeconds(s: number): string {
  if (s < 90) return `${Math.round(s * 10) / 10} s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m * 10) / 10} min`;
  return `${Math.round((m / 60) * 10) / 10} h`;
}

/**
 * The one judgement the UI renders from. `chainName` is what the user calls the
 * chain; `nowSeconds` is used only to age a checkpoint the relayer did not
 * already mark stale.
 *
 * `signing.paused` is authoritative, and every specific refusal the relayer
 * reports (mismatch, degraded, unmeasured, missing/stale/unreadable checkpoint)
 * ALSO pauses on its own — the two can only agree, and if they ever did not,
 * the safe reading wins.
 */
export function assessLiveness(live: ChainLiveness | null, chainName: string, nowSeconds: number): LivenessVerdict {
  const none: LivenessVerdict = {
    state: 'unknown',
    paused: false,
    message: '',
    paceText: null,
    medianGapSeconds: null,
    targetSeconds: null,
    checkpointLagBlocks: null,
    checkpointMode: false,
    checkpointEnforced: false,
  };
  if (!live || !live.signing) return none;

  const pace = live.pace;
  const cp = live.checkpoint;
  const base: LivenessVerdict = {
    ...none,
    paceText: paceText(pace),
    medianGapSeconds: pace?.medianGapSeconds ?? null,
    targetSeconds: pace?.targetSeconds ?? null,
    checkpointLagBlocks: cp?.lagBlocks ?? null,
    checkpointMode: live.finalityMode === 'checkpoint',
    checkpointEnforced: cp !== null,
  };
  const relayerReason = live.signing.reason ? ` (${live.signing.reason})` : '';

  // Order matters: a detected reorg is the loudest thing we can know.
  if (cp && (cp.state === 'mismatch' || cp.verified === false)) {
    return {
      ...base,
      state: 'checkpoint-mismatch',
      paused: true,
      message: `The latest attested checkpoint for ${chainName} does not match the chain validators see. That is a detected reorg: transfers are paused until the operators publish a new checkpoint.`,
    };
  }

  if (pace && pace.state === 'degraded') {
    const measured = base.paceText ? ` Measured: ${base.paceText}.` : '';
    const stalled = pace.headAgeSeconds !== null && pace.medianGapSeconds !== null && pace.headAgeSeconds > 4 * pace.targetSeconds ? ` No block for ${formatSeconds(pace.headAgeSeconds)}.` : '';
    const reason = pace.reason ? ` (${pace.reason})` : '';
    return {
      ...base,
      state: 'degraded',
      paused: true,
      message: `${chainName} is producing blocks slowly; transfers are paused until it recovers.${measured}${stalled}${reason}`,
    };
  }

  if (pace && pace.state === 'unknown') {
    const reason = pace.reason ? ` (${pace.reason})` : '';
    return {
      ...base,
      state: 'paused',
      paused: true,
      message: `Validators cannot measure the block pace of ${chainName} right now, so transfers are paused until they can.${reason}`,
    };
  }

  // A configured registry is enforced in EVERY mode, so these pause regardless
  // of whether the checkpoint is the sole finality source.
  if (cp) {
    if (cp.state === 'missing' || cp.blockNumber === null) {
      return {
        ...base,
        state: 'checkpoint-missing',
        paused: true,
        message: `No attested checkpoint has been published for ${chainName} yet. Validators only sign up to the latest checkpoint, so transfers are paused until the operators publish one.`,
      };
    }
    const ageSeconds = cp.ageSeconds ?? (cp.attestedAt !== null ? Math.max(0, nowSeconds - cp.attestedAt) : null);
    const tooOld = cp.stale || (cp.maxAgeSeconds !== null && ageSeconds !== null && ageSeconds > cp.maxAgeSeconds);
    if (tooOld) {
      const age = ageSeconds !== null ? ` The last one is ${formatSeconds(ageSeconds)} old` : '';
      const max = cp.maxAgeSeconds !== null ? ` (limit ${formatSeconds(cp.maxAgeSeconds)})` : '';
      return {
        ...base,
        state: 'checkpoint-stale',
        paused: true,
        message: `The attested checkpoint for ${chainName} is stale.${age}${max}. Validators refuse to sign against a stale checkpoint, so transfers are paused until a new one is published.`,
      };
    }
    if (cp.state !== 'ok') {
      const reason = cp.reason ? ` (${cp.reason})` : relayerReason;
      return {
        ...base,
        state: 'paused',
        paused: true,
        message: `Validators cannot read the attested checkpoint for ${chainName} right now, so transfers are paused until they can.${reason}`,
      };
    }
  }

  // A scanner that is days behind never sees a transfer sent now. The relayer
  // folds this into signing.paused itself; reading it here as well means an
  // older relayer that only reports `scan` still cannot be quoted as healthy.
  if (live.scan?.lagging) {
    const reason = live.scan.reason ? ` (${live.scan.reason})` : relayerReason;
    return {
      ...base,
      state: 'paused',
      paused: true,
      message: `Validators are not seeing new transfers from ${chainName} right now, so transfers are paused until they catch up.${reason}`,
    };
  }

  if (live.signing.paused) {
    return {
      ...base,
      state: 'paused',
      paused: true,
      message: `Transfers from ${chainName} are paused by the validators${relayerReason || '.'}`,
    };
  }

  if (pace && pace.medianGapSeconds !== null && pace.medianGapSeconds > SLOW_PACE_FACTOR * pace.targetSeconds) {
    return {
      ...base,
      state: 'slow',
      paused: false,
      message: `${chainName} is producing blocks slower than usual (${base.paceText}). Transfers still settle, but later than the typical estimate.`,
    };
  }

  return {
    ...base,
    state: 'ok',
    paused: false,
    message: base.paceText ? `${chainName} block pace is normal (${base.paceText}).` : `${chainName} is healthy.`,
  };
}

// ------------------------------------------------------- per-transfer wait

export interface TransferWait {
  /** What the user is actually waiting on right now. */
  kind: 'paused' | 'checkpoint' | 'work' | 'count' | 'none';
  label: string;
  detail: string;
  /** 0..1 progress through the source-side wait, when it can be expressed. */
  progress: number | null;
  /** Blocks the attested checkpoint still has to advance to cover this transfer. */
  blocksAboveCheckpoint: number | null;
  /** Seconds, measured pace applied; null when it cannot be estimated. */
  expectedSeconds: number | null;
}

/**
 * What a transfer mined at `sourceBlock` is waiting on, given the chain's live
 * measurements. Returns kind 'none' when there is nothing to add over the plain
 * confirmation count (no measurement at all).
 */
export function describeWait(
  live: ChainLiveness | null,
  verdict: LivenessVerdict,
  sourceBlock: number | null,
  headBlock: number | null,
  requiredConfirmations: number,
  nominalBlockSeconds: number,
): TransferWait {
  const noneWait: TransferWait = {
    kind: 'none',
    label: '',
    detail: '',
    progress: null,
    blocksAboveCheckpoint: null,
    expectedSeconds: null,
  };
  if (!live || verdict.state === 'unknown') return noneWait;

  const gap = live.pace?.medianGapSeconds ?? nominalBlockSeconds;
  const required = Math.max(1, requiredConfirmations);

  if (verdict.paused) {
    return {
      ...noneWait,
      kind: 'paused',
      label: 'Paused',
      detail: verdict.message,
      progress: null,
    };
  }

  // The checkpoint ceiling applies in EVERY mode that configures a registry:
  // a transfer above the attested block is not signed, however deep it is.
  const cp = live.checkpoint;
  if (cp && cp.blockNumber !== null) {
    const attested = cp.blockNumber;
    const lag = cp.lagBlocks;
    if (sourceBlock !== null && sourceBlock > attested) {
      const above = sourceBlock - attested;
      return {
        ...noneWait,
        kind: 'checkpoint',
        label: 'Awaiting checkpoint',
        detail:
          `Mined in block ${sourceBlock}; the latest attested checkpoint is block ${attested}, ${above} block${above === 1 ? '' : 's'} behind this transfer` +
          (lag !== null ? ` and ${lag} behind the chain head` : '') +
          `. Validators sign only up to the checkpoint, so the wait is for the operators' next attestation — not for a block count.`,
        progress: lag !== null && lag > 0 ? Math.max(0, Math.min(1, 1 - above / Math.max(lag, above))) : 0,
        blocksAboveCheckpoint: above,
        expectedSeconds: null,
      };
    }
    if (verdict.checkpointMode) {
      if (sourceBlock === null) {
        return {
          ...noneWait,
          kind: 'checkpoint',
          label: 'Awaiting checkpoint',
          detail: `Waiting for the source receipt. Validators sign only up to attested checkpoint ${attested}.`,
          progress: 0,
          blocksAboveCheckpoint: null,
          expectedSeconds: null,
        };
      }
      return {
        ...noneWait,
        kind: 'checkpoint',
        label: 'Checkpointed',
        detail: `Covered by attested checkpoint ${attested}. Validators can sign; a relayer then submits to the destination bridge.`,
        progress: 1,
        blocksAboveCheckpoint: 0,
        expectedSeconds: 0,
      };
    }
  }

  // Work / count mode with a live pace: the count is still what the validator
  // waits for, but the TIME it takes is the measured pace, not the nominal one.
  const have = sourceBlock !== null && headBlock !== null ? Math.max(0, headBlock - sourceBlock + 1) : 0;
  const left = Math.max(0, required - have);
  return {
    ...noneWait,
    kind: 'work',
    label: left > 0 ? `Confirming ${have}/${required}` : 'Confirmed',
    detail:
      left > 0
        ? `${left} more block${left === 1 ? '' : 's'} at the ${live.pace?.medianGapSeconds !== null && live.pace?.medianGapSeconds !== undefined ? 'measured' : 'nominal'} pace of ${formatSeconds(gap)} per block — about ${formatSeconds(left * gap)}.${
            verdict.state === 'slow' ? ` ${verdict.message}` : ''
          }`
        : 'Deep enough at the current pace. Validators are signing.',
    progress: Math.min(1, have / required),
    blocksAboveCheckpoint: null,
    expectedSeconds: Math.round(left * gap),
  };
}

/**
 * Source-side seconds to expect for a NEW transfer: the confirmation count at
 * the measured pace, or null when validators are paused (there is no honest
 * number to give). With no measurement, falls back to the nominal pace.
 */
export function liveSourceWaitSeconds(
  live: ChainLiveness | null,
  verdict: LivenessVerdict,
  requiredConfirmations: number,
  nominalBlockSeconds: number,
): number | null {
  if (verdict.paused) return null;
  const gap = live?.pace?.medianGapSeconds ?? nominalBlockSeconds;
  if (verdict.checkpointMode) {
    // Checkpoints are published on the operators' cadence; the lag tells how far
    // behind they run, which is the best available proxy for the wait.
    const lag = live?.checkpoint?.lagBlocks;
    return lag !== null && lag !== undefined ? Math.round(Math.max(lag, 1) * gap) : null;
  }
  return Math.round(Math.max(1, requiredConfirmations) * gap);
}

// ------------------------------------------------------------- send gate

export interface SendGate {
  ok: boolean;
  /** Why sending is disabled, in one sentence; null when ok. */
  reason: string | null;
}

/**
 * May the app let a user lock or burn on `chainId` RIGHT NOW?
 *
 * Everything above only EXPLAINS a wait; this decides whether to create one.
 * The contract has no refund path: a send() that no validator will sign locks
 * the coins until the operators repair the bridge, with no upper bound. So the
 * gate fails CLOSED — no report, a stale report, a chain the report does not
 * cover, no signing verdict, or any pause all refuse. The page used to let a
 * user submit while its own panel said "validators are not signing"
 * (srcVerdict.paused only changed the ETA text), and with no report at all it
 * submitted on the plain confirmation count.
 *
 * Shared by the bridge app and the DEX bridge panel, which imports this module
 * through the @bridge alias.
 */
export function canSend(status: RelayerStatus | null, chainId: number, chainName: string, nowMs: number): SendGate {
  if (!status) {
    return { ok: false, reason: `The validator status report is unavailable, so this page cannot confirm that transfers from ${chainName} would be signed. Sending is disabled until it is back.` };
  }
  if (!isStatusFresh(status, nowMs)) {
    return { ok: false, reason: `The validator status report is out of date, so this page cannot confirm that transfers from ${chainName} would be signed. Sending is disabled until it refreshes.` };
  }
  const live = livenessForChain(status, chainId);
  const verdict = assessLiveness(live, chainName, nowMs / 1000);
  if (verdict.state === 'unknown') {
    return { ok: false, reason: `The validators do not report on ${chainName}, so sending from it is disabled.` };
  }
  if (verdict.paused) return { ok: false, reason: verdict.message };
  return { ok: true, reason: null };
}

export function chainLivenessFromConfig(chain: ChainConfig, status: RelayerStatus | null): ChainLiveness | null {
  return livenessForChain(status, chain.chainId);
}
