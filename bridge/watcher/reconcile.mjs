/**
 * Reconciliation logic for the bridge watcher, kept free of network and clock so
 * it can be tested exhaustively.
 *
 * THE ONE QUESTION THIS ANSWERS: every `Executed` on a destination chain claims a
 * matching `Sent` happened on the source chain. A forged validator quorum produces
 * an `Executed` with no such `Sent` — that is what minting-out-of-thin-air looks
 * like from the outside, and it is the single event the pauser exists to stop.
 *
 * The hard part is not detecting the mismatch, it is not crying wolf. An honest
 * `Executed` is routinely seen BEFORE its `Sent`: the watcher scans two chains
 * independently, each behind its own confirmation depth, and BSC confirms in ~60s
 * while Ferminux waits ~7.5 minutes. So an unmatched execution is not evidence of
 * anything until the source chain has been scanned far enough forward that the
 * `Sent` could not still be in flight. Until then it is merely PENDING.
 */

/** Severity ranks, low to high. Anything at or above `alert` should wake a human. */
export const SEVERITY = { info: 0, warn: 1, alert: 2, critical: 3 };

/**
 * Governance and safety events, and how loudly each should land.
 *
 * The bias here is deliberate: every event that widens the blast radius is at
 * least `alert`, because the timelock's entire value is the window it gives a
 * human to react, and a window nobody is told about is not a window. Events that
 * only ever SHRINK exposure (pause, a cap decrease) are `warn` — worth knowing,
 * never worth panicking over.
 */
export const EVENT_SEVERITY = {
  // Value movement
  Sent: 'info',
  Executed: 'info',
  ShortDelivery: 'alert',

  // Immediate safety, always operator-initiated
  Paused: 'warn',
  TokenPaused: 'warn',
  Unpaused: 'alert',
  TokenUnpaused: 'alert',
  PauserSet: 'alert',

  // Governance: queued now, effective after the timelock
  ActionQueued: 'alert',
  ActionExecuted: 'alert',
  ActionCanceled: 'warn',

  // Config that changes who or what is trusted
  ValidatorAdded: 'critical',
  ValidatorRemoved: 'critical',
  ThresholdChanged: 'critical',
  OwnershipTransferStarted: 'critical',
  OwnershipTransferred: 'critical',
  OwnershipTransferCanceled: 'warn',
  BridgeTokenCodehashChanged: 'critical',
  RemoteBridgeChanged: 'critical',
  TokenRegistered: 'alert',
  TimelockDelayChanged: 'critical',
  ShortDeliveryAllowed: 'critical',
  ShortDeliveryRevoked: 'warn',
  WrapperBridgeRotationProposed: 'critical',
  WrapperAdopted: 'critical',
  Rescued: 'alert',

  // Money out
  FeeBpsChanged: 'alert',
  FeeCollectorChanged: 'alert',
  FeesWithdrawn: 'warn',
  TokenLimitsChanged: 'warn', // direction is decided in code: a RAISE escalates
};

/**
 * Tracks `Sent` on every chain and matches `Executed` against them.
 *
 * State is a plain object so the caller can JSON it to disk between runs; a
 * watcher that forgets everything on restart would re-alarm on every historical
 * transfer, and an operator who learns to ignore the alarm is worse off than one
 * who never had it.
 */
export class Reconciler {
  /**
   * @param {object} opts
   * @param {number} opts.graceBlocks how far the SOURCE chain must advance past the
   *        block where we first saw an unmatched `Executed` before we call it forged.
   *        Must exceed the source chain's confirmation depth, or an honest transfer
   *        still inside its confirmation window gets reported as theft.
   * @param {number} [opts.retainMatched] how many matched ids to remember, so the
   *        map cannot grow without bound on a busy route.
   */
  constructor({ graceBlocks, retainMatched = 50_000 }) {
    if (!Number.isInteger(graceBlocks) || graceBlocks <= 0) {
      throw new Error('graceBlocks must be a positive integer');
    }
    this.graceBlocks = graceBlocks;
    this.retainMatched = retainMatched;
    /** transferId -> {chainId, block, amount, recipient} */
    this.sent = new Map();
    /** transferId -> {chainId, srcChainId, block, amount, recipient, firstSeenSrcHead} */
    this.pending = new Map();
    /** transferIds already matched, kept only to suppress duplicate work */
    this.matched = new Set();
    /** transferIds already reported as unmatched, so we alarm once, not every tick */
    this.reported = new Set();
  }

  toJSON() {
    return {
      sent: [...this.sent.entries()],
      pending: [...this.pending.entries()],
      matched: [...this.matched],
      reported: [...this.reported],
    };
  }

  static fromJSON(obj, opts) {
    const r = new Reconciler(opts);
    if (!obj) return r;
    r.sent = new Map(obj.sent ?? []);
    r.pending = new Map(obj.pending ?? []);
    r.matched = new Set(obj.matched ?? []);
    r.reported = new Set(obj.reported ?? []);
    return r;
  }

  /** Record an outbound lock/burn. Returns nothing; `Sent` is never itself an alarm. */
  recordSent({ transferId, chainId, block, amount, recipient, sender }) {
    this.sent.set(transferId, { chainId, block, amount, recipient, sender });
    // An execution we could not explain a moment ago may be explainable now.
    if (this.pending.has(transferId)) {
      this.pending.delete(transferId);
      this.reported.delete(transferId);
      this._markMatched(transferId);
    }
  }

  /**
   * Record an inbound release/mint.
   * @returns {null | {kind:'matched'|'amount-mismatch', ...}} an immediate finding,
   *          or null when the verdict has to wait for the source chain to catch up.
   */
  recordExecuted({ transferId, chainId, srcChainId, block, amount, recipient, srcHead }) {
    const origin = this.sent.get(transferId);
    if (origin) {
      this._markMatched(transferId);
      // The amounts must agree exactly: `Sent.amount` is already net of the fee,
      // and `Executed.amount` is what the destination actually credited.
      if (origin.amount !== amount) {
        return {
          kind: 'amount-mismatch',
          transferId,
          chainId,
          srcChainId,
          sentAmount: origin.amount,
          executedAmount: amount,
          recipient,
        };
      }
      return { kind: 'matched', transferId, chainId, srcChainId, amount, recipient };
    }
    // No `Sent` yet. Could be honest lag, could be forgery — the source chain's
    // own progress is what decides, so record where it stood when we first looked.
    if (!this.pending.has(transferId)) {
      this.pending.set(transferId, {
        chainId,
        srcChainId,
        block,
        amount,
        recipient,
        firstSeenSrcHead: srcHead,
      });
    }
    return null;
  }

  /**
   * Ask which pending executions have now waited long enough to be called forged.
   * @param {Map<number, number>} srcHeads current scanned head per chain id.
   * @returns {Array<object>} findings, each reported at most once.
   */
  overdue(srcHeads) {
    const out = [];
    for (const [transferId, p] of this.pending) {
      if (this.reported.has(transferId)) continue;
      const head = srcHeads.get(Number(p.srcChainId));
      // If we have never successfully scanned the source chain we cannot conclude
      // anything. Staying silent is correct: an alarm that fires because our own
      // RPC is down teaches the operator to ignore alarms.
      if (head == null) continue;
      if (head - p.firstSeenSrcHead >= this.graceBlocks) {
        this.reported.add(transferId);
        out.push({
          kind: 'unmatched-execution',
          transferId,
          chainId: p.chainId,
          srcChainId: p.srcChainId,
          block: p.block,
          amount: p.amount,
          recipient: p.recipient,
          scannedPast: head - p.firstSeenSrcHead,
        });
      }
    }
    return out;
  }

  _markMatched(transferId) {
    this.matched.add(transferId);
    this.sent.delete(transferId);
    if (this.matched.size > this.retainMatched) {
      // Sets iterate in insertion order, so this drops the oldest.
      const drop = this.matched.size - this.retainMatched;
      let i = 0;
      for (const id of this.matched) {
        if (i++ >= drop) break;
        this.matched.delete(id);
      }
    }
  }
}

/**
 * Decide how loudly a cap-limit change should land.
 *
 * A RAISE enlarges what a forged quorum can steal, so it is `critical`; a lowering
 * is a defensive act and only worth noting. `immediate` distinguishes the instant
 * `decreaseTokenLimits` path from the timelocked setter.
 */
export function limitChangeSeverity({ oldMax, oldDaily, newMax, newDaily }) {
  if (oldMax == null || oldDaily == null) return 'alert'; // first registration
  const raised = newMax > oldMax || newDaily > oldDaily;
  return raised ? 'critical' : 'warn';
}

/**
 * Rolling-window pressure. Returns a severity once usage crosses a threshold, so
 * the operator hears about a route filling up before users start seeing reverts.
 */
export function usageSeverity(used, cap) {
  if (cap === 0n) return null;
  const pct = Number((used * 100n) / cap);
  if (pct >= 90) return { severity: 'alert', pct };
  if (pct >= 70) return { severity: 'warn', pct };
  return null;
}

/**
 * Edge detector for level-type conditions (cap pressure, paused, ...).
 *
 * A condition that is true on every poll must not be emitted on every poll: a
 * route sitting at 82% of its daily cap for a day produced one identical WARN
 * every two minutes, which is exactly the noise that buries the one line that
 * matters. `transition(key, level)` reports only when the level CHANGES for
 * that key — null → warn (raise), warn → alert (escalate), alert → warn
 * (de-escalate), anything → null (clear) — and stays silent otherwise.
 * Not persisted: after a restart the first poll re-raises whatever is still
 * true, which is the right thing to say once.
 */
export class EdgeTracker {
  constructor() { this.levels = new Map(); }
  transition(key, level) {
    const prev = this.levels.get(key) ?? null;
    const next = level ?? null;
    if (prev === next) return null;
    if (next === null) this.levels.delete(key); else this.levels.set(key, next);
    if (prev === null) return { kind: 'raise', from: prev, to: next };
    if (next === null) return { kind: 'clear', from: prev, to: next };
    return { kind: 'change', from: prev, to: next };
  }
}

/** Render a bigint token amount with `decimals` places, trimmed, for humans. */
export function fmtAmount(v, decimals = 18) {
  const neg = v < 0n;
  let x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = (x % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}
