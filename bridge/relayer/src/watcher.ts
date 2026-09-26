// Source-chain watcher. Shared by both roles.
//
// The scan window is deliberately re-derived from the chain on every poll rather
// than remembered:
//
//   persisted cursor  = last SETTLED block fully processed (survives restart)
//   scanned each poll = [cursor + 1 .. head]
//
// So the last `confirmations` blocks are re-read on every single poll. If a reorg
// replaces them, the next poll simply sees the new truth — there is no cached
// "pending" list to go stale, and a transfer that vanishes from the canonical
// chain is caught by the confirmation re-read instead of being signed.
//
// A transfer moves: seen -> confirmed (survived confirmations + a multi-endpoint
// re-read) or seen -> orphaned (the log is gone or changed; alerts as a reorg).

import type { ChainClient } from './chain.ts';
import type { Store, StoredTransfer } from './db.ts';
import type { Logger } from './logger.ts';
import type { Alerter } from './alerts.ts';
import type { SentEvent } from './transfer.ts';

export interface WatcherOptions {
  chain: ChainClient;
  store: Store;
  log: Logger;
  alerts: Alerter;
  /** validator.requireRpcQuorum — every healthy endpoint must show the log. */
  requireRpcQuorum: boolean;
  /** Called once per transfer the moment it reaches `confirmed`. */
  onConfirmed: (transfer: StoredTransfer) => Promise<void> | void;
}

export interface WatcherStats {
  head: number;
  settled: number;
  cursor: number;
  seen: number;
  confirmed: number;
  orphaned: number;
  lastPollAt: number;
  /** Last poll that scanned up to the head and ran the confirmation pass. 0 = never. */
  lastSuccessAt: number;
  lastError: string | null;
}

/**
 * Is this chain's scanner keeping up? Published per chain in /status as
 * `scan`, and folded into `finality.signing` by the service: a validator whose
 * scanner is days behind will not sign a transfer sent now, whatever the
 * finality rule says — it has not SEEN it. That is exactly the 2026-09-14 BSC
 * failure: the cursor froze, /status kept saying "signing, not paused", and the
 * UI would have quoted a normal ETA for a burn nobody would ever observe.
 *
 * Lagging when the watcher has not completed a full poll within `staleMs`, or
 * its cursor sits more than `confirmations + 2 * maxBlockRange` blocks under
 * the head. Pure, so it is tested directly.
 */
export interface ScanHealth {
  head: number;
  cursor: number;
  lagBlocks: number | null;
  lastPollAt: number;
  lastSuccessAt: number;
  lagging: boolean;
  reason: string | null;
}

export function scanHealth(
  stats: Pick<WatcherStats, 'head' | 'cursor' | 'lastPollAt' | 'lastSuccessAt'>,
  chain: { name: string; confirmations: number; maxBlockRange: number; pollIntervalMs: number },
  now: number,
): ScanHealth {
  const staleMs = Math.max(10 * 60_000, 20 * chain.pollIntervalMs);
  const lagBlocks = stats.head > 0 ? Math.max(stats.head - stats.cursor, 0) : null;
  const base = { head: stats.head, cursor: stats.cursor, lagBlocks, lastPollAt: stats.lastPollAt, lastSuccessAt: stats.lastSuccessAt };
  if (stats.lastSuccessAt === 0) {
    return { ...base, lagging: true, reason: `the ${chain.name} scanner has not completed a scan yet` };
  }
  const idleMs = now - stats.lastSuccessAt;
  if (idleMs > staleMs) {
    return {
      ...base,
      lagging: true,
      reason: `the ${chain.name} scanner has not completed a scan for ${Math.round(idleMs / 60_000)} min (cursor ${stats.cursor}, head ${stats.head}); transfers sent now are not being seen`,
    };
  }
  const slack = chain.confirmations + 2 * chain.maxBlockRange;
  if (lagBlocks !== null && lagBlocks > slack) {
    return {
      ...base,
      lagging: true,
      reason: `the ${chain.name} scanner is ${lagBlocks} blocks behind the head (allowed ${slack}); it is catching up`,
    };
  }
  return { ...base, lagging: false, reason: null };
}

export class Watcher {
  readonly chain: ChainClient;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly alerts: Alerter;
  private readonly requireRpcQuorum: boolean;
  private readonly onConfirmed: WatcherOptions['onConfirmed'];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastFailText: string | null = null;
  private lastFailLogAt = 0;
  private failsSuppressed = 0;
  readonly stats: WatcherStats = {
    head: 0,
    settled: 0,
    cursor: 0,
    seen: 0,
    confirmed: 0,
    orphaned: 0,
    lastPollAt: 0,
    lastSuccessAt: 0,
    lastError: null,
  };

  constructor(opts: WatcherOptions) {
    this.chain = opts.chain;
    this.store = opts.store;
    this.log = opts.log.child({ component: 'watcher', chain: opts.chain.name });
    this.alerts = opts.alerts;
    this.requireRpcQuorum = opts.requireRpcQuorum;
    this.onConfirmed = opts.onConfirmed;
  }

  /** Resume point: persisted cursor, else the configured startBlock, else head. */
  async initCursor(): Promise<number> {
    const stored = this.store.getCursor(this.chain.chainId);
    if (stored !== null) {
      this.stats.cursor = stored;
      this.log.info('resuming from persisted cursor', { cursor: stored });
      return stored;
    }
    const start = this.chain.config.startBlock > 0 ? this.chain.config.startBlock - 1 : Math.max((await this.chain.getBlockNumber()) - 1, 0);
    this.store.setCursor(this.chain.chainId, start);
    this.stats.cursor = start;
    this.log.info('no cursor on record — starting fresh', { cursor: start });
    return start;
  }

  start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      await this.pollOnce();
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.chain.config.pollIntervalMs);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One full scan + confirmation pass. Safe to call directly (tests, --once). */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.chain.healthCheck();
      if (this.chain.healthyEndpoints.length === 0) {
        this.stats.lastError = 'no healthy RPC endpoint';
        return;
      }
      const cursor = this.store.getCursor(this.chain.chainId) ?? (await this.initCursor());
      const head = await this.chain.getBlockNumber();
      const settled = await this.chain.settledHeight();
      this.stats.head = head;
      this.stats.settled = settled;
      this.stats.cursor = cursor;

      let saved = cursor;
      if (head > cursor) {
        // Record and checkpoint chunk by chunk. The cursor may only move over
        // blocks that are both SCANNED and SETTLED — never past `settled`, so
        // the unsettled tail is still re-read every poll exactly as before —
        // and every event in those blocks is already stored as `seen`, so the
        // confirmation pass below (or the next poll's) picks it up from the
        // store, not from the scan. What changes: a long catch-up that fails
        // part-way keeps the ground it covered instead of restarting at the
        // old cursor on every poll, which is how the BSC scanner stayed on
        // block 121862043 for ten days.
        const events = await this.chain.scanSent(cursor + 1, head, (end, chunk) => {
          for (const ev of chunk) this.record(ev);
          const safe = Math.min(end, settled);
          if (safe > saved) {
            this.store.setCursor(this.chain.chainId, safe);
            this.stats.cursor = safe;
            saved = safe;
          }
        });
        if (events.length > 0) {
          this.log.debug('scanned', { from: cursor + 1, to: head, found: events.length });
        }
      }

      await this.confirmPending(settled);

      if (settled > saved) {
        this.store.setCursor(this.chain.chainId, settled);
        this.stats.cursor = settled;
      }
      this.stats.lastError = null;
      this.stats.lastSuccessAt = Date.now();
    } catch (err) {
      this.stats.lastError = (err as Error).message;
      // Same failure every poll: say it once a minute, with a count, not every
      // 3 seconds (a frozen BSC scan was ~1,100 identical lines an hour).
      const now = Date.now();
      if (this.stats.lastError !== this.lastFailText || now - this.lastFailLogAt >= 60_000) {
        this.log.warn('poll failed', { err: this.stats.lastError, ...(this.failsSuppressed > 0 ? { repeatsSuppressed: this.failsSuppressed } : {}) });
        this.lastFailText = this.stats.lastError;
        this.lastFailLogAt = now;
        this.failsSuppressed = 0;
      } else {
        this.failsSuppressed++;
      }
    } finally {
      this.stats.lastPollAt = Date.now();
      this.running = false;
    }
  }

  /** Insert a newly-observed Sent, or refresh the anchor of one still 'seen'. */
  private record(ev: SentEvent): void {
    const existing = this.store.getTransfer(ev.transferId);
    const now = Date.now();
    if (!existing) {
      this.store.putTransfer({
        transferId: ev.transferId,
        transfer: ev.transfer,
        fee: ev.fee,
        srcBlockNumber: ev.blockNumber,
        srcBlockHash: ev.blockHash,
        srcTxHash: ev.txHash,
        srcLogIndex: ev.logIndex,
        status: 'seen',
        reason: null,
        firstSeenAt: now,
        confirmedAt: null,
        executedAt: null,
        executedTxHash: null,
        updatedAt: now,
      });
      this.stats.seen++;
      this.log.info('transfer seen', {
        transferId: ev.transferId,
        route: `${ev.transfer.srcChainId}->${ev.transfer.dstChainId}`,
        amount: ev.transfer.amount.toString(),
        block: ev.blockNumber,
        tx: ev.txHash,
      });
      return;
    }
    if (existing.status !== 'seen') return; // confirmed/executed rows are anchored, never re-anchored
    if (existing.srcBlockHash.toLowerCase() !== ev.blockHash.toLowerCase()) {
      // Same transfer id, different block: a reorg moved it. Re-anchor while it
      // is still shallow — this is normal, and exactly why we re-scan.
      this.log.warn('transfer re-anchored to a new block', {
        transferId: ev.transferId,
        was: existing.srcBlockHash,
        now: ev.blockHash,
      });
      this.store.putTransfer({ ...existing, srcBlockNumber: ev.blockNumber, srcBlockHash: ev.blockHash, srcTxHash: ev.txHash, srcLogIndex: ev.logIndex, updatedAt: Date.now() });
    }
  }

  /** Promote every 'seen' transfer buried deep enough — or bury it. */
  private async confirmPending(settled: number): Promise<void> {
    const pending = this.store.listTransfers({ status: ['seen'], limit: 1000 }).filter((t) => t.transfer.srcChainId === this.chain.chainId);
    for (const t of pending) {
      if (t.srcBlockNumber > settled) continue;

      const check = await this.chain.confirmSentAcrossEndpoints(
        t.transferId,
        t.srcBlockNumber,
        t.srcBlockHash,
        this.requireRpcQuorum,
      );

      if (check.status === 'vanished') {
        // Every endpoint agrees the log is gone after `confirmations` blocks:
        // the chain rewrote history deeper than we were told it could. The
        // transfer is dead to this node until a human looks at it.
        this.store.setTransferStatus(t.transferId, 'orphaned', check.reason);
        this.stats.orphaned++;
        this.alerts.fire({
          kind: 'reorg',
          severity: 'critical',
          message: 'confirmed transfer vanished or moved after the confirmation depth — deep reorg',
          key: `reorg:${t.transferId}`,
          fields: {
            chain: this.chain.name,
            transferId: t.transferId,
            block: t.srcBlockNumber,
            blockHash: t.srcBlockHash,
            confirmations: this.chain.config.confirmations,
            detail: check.reason,
          },
        });
        continue;
      }

      if (check.status !== 'ok') {
        // quorum_failed (already alerted as rpc_divergence) or unavailable.
        // Decide nothing: the transfer stays pending and unsigned.
        this.log.warn('confirmation deferred', {
          transferId: t.transferId,
          status: check.status,
          reason: check.reason,
        });
        continue;
      }

      this.store.setTransferStatus(t.transferId, 'confirmed');
      this.stats.confirmed++;
      this.log.info('transfer confirmed', {
        transferId: t.transferId,
        block: t.srcBlockNumber,
        depth: settled - t.srcBlockNumber + this.chain.config.confirmations,
        endpointsAgreed: `${check.agreed}/${check.checked}`,
      });
      const fresh = this.store.getTransfer(t.transferId);
      if (fresh) await this.onConfirmed(fresh);
    }
  }
}
