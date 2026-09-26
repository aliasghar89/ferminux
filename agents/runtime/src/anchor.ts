// `--anchor-memory` — FRC-100 memory anchoring on a cadence, with no human in
// the loop.
//
// Every write to the agent's private KV store appends an immutable header to its
// log. This loop folds the headers written since the last anchor into one merkle
// root and commits that root on chain from the agent's own key. One transaction
// covers the whole batch, which is why the cadence is hourly rather than
// per-write: at the chain's 1 gwei floor an anchor costs about 0.000075 FMX, and
// anchoring per write would pay that over and over for no extra proof.
//
// WHAT AN ANCHOR PROVES, exactly: that a record existed at position N of this
// agent's log no later than the block its root was anchored in, and that nothing
// was inserted, altered or silently dropped before it. It does NOT prove the
// agent wrote down everything that happened. An anchored log is still a
// self-curated diary — which is why an AI-CV weights counterparty-written facts
// (escrow settlements, FRC-8004 feedback, x402 settlements) above it.
import type { Ferminux } from "@ferminux/agent";
import type { SendQueue } from "./settle.js";

/** Hourly. One transaction per batch, so a tighter cadence buys latency, not proof. */
export const ANCHOR_INTERVAL_MS = 60 * 60_000;
/** Never anchor more often than this, whatever the caller asks for. */
export const ANCHOR_MIN_INTERVAL_MS = 60_000;
/** Records per batch. Keeps proofs shallow and calldata sane. */
export const ANCHOR_BATCH = 512;

type Log = { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };

export interface AnchorOptions {
  fmx: Ferminux;
  agentId: number;
  log: Log;
  intervalMs?: number;
  batch?: number;
  /** build the batch and log the root, send nothing */
  dryRun?: boolean;
  /** The runtime's one send queue for this key (settle.ts agentSendQueue). The anchor is a transaction from the
   * same key that delivers jobs and collects pay: sent beside them it could take the same nonce. */
  queue?: SendQueue;
}

export interface AnchorTickResult {
  status: "anchored" | "nothing-to-anchor" | "dry-run" | "not-deployed" | "failed";
  root?: string;
  count?: number;
  fromSeq?: number;
  toSeq?: number;
  tx?: string | null;
  reason?: string;
}

/**
 * One anchoring pass. Safe to call at any time: with nothing new to anchor it
 * reports `nothing-to-anchor` and spends nothing, and a batch that was built but
 * never anchored comes back unchanged rather than forking the log.
 */
export async function anchorTick(opts: AnchorOptions): Promise<AnchorTickResult> {
  const { fmx, agentId, log } = opts;
  try {
    const build = () => fmx.memory.anchor({ agentId, limit: opts.batch ?? ANCHOR_BATCH, send: !opts.dryRun });
    const res = opts.queue && !opts.dryRun ? await opts.queue(build) : await build();
    if (opts.dryRun) {
      log.info({ root: res.root, count: res.count, fromSeq: res.fromSeq, toSeq: res.toSeq }, "anchor-memory (dry run): batch built, nothing sent");
      return { status: "dry-run", root: res.root, count: res.count, fromSeq: res.fromSeq, toSeq: res.toSeq };
    }
    log.info({ root: res.root, count: res.count, fromSeq: res.fromSeq, toSeq: res.toSeq, tx: res.tx }, "memory anchored");
    return { status: "anchored", root: res.root, count: res.count, fromSeq: res.fromSeq, toSeq: res.toSeq, tx: res.tx };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // 409 from the gateway: every record is already in a batch. The common case
    // on a quiet hour, and not a problem.
    if (/nothing to anchor/i.test(message)) return { status: "nothing-to-anchor" };
    if (/not deployed/i.test(message)) {
      return { status: "not-deployed", reason: "MemoryAnchor is not deployed on this network yet — memory keeps working, unanchored" };
    }
    log.warn({ err: message }, "memory anchor failed — will retry on the next tick");
    return { status: "failed", reason: message };
  }
}

/**
 * Starts the cadence. Returns a stop function; call it on shutdown, after which
 * a final pass runs so a session's last writes are not left unanchored.
 */
export function startMemoryAnchor(opts: AnchorOptions): () => Promise<void> {
  const interval = Math.max(opts.intervalMs ?? ANCHOR_INTERVAL_MS, ANCHOR_MIN_INTERVAL_MS);
  let stopped = false;
  let warnedNotDeployed = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    const res = await anchorTick(opts);
    if (res.status === "not-deployed" && !warnedNotDeployed) {
      warnedNotDeployed = true;
      opts.log.warn({ reason: res.reason }, "--anchor-memory: nothing to anchor to yet");
    }
  };

  const loop = () => {
    timer = setTimeout(async () => {
      await tick();
      if (!stopped) loop();
    }, interval);
    timer.unref?.();
  };

  opts.log.info({ intervalMinutes: Math.round(interval / 60_000), agentId: opts.agentId, dryRun: opts.dryRun === true }, "--anchor-memory: memory will be anchored on a cadence");
  void tick();
  loop();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopped = false;
    // A final pass so the last writes of a session are anchored before exit.
    await tick().catch(() => undefined);
    stopped = true;
  };
}
