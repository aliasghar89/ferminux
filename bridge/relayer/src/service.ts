// Shared plumbing for both roles: chain clients, watchers, durable state, the
// HTTP surface, the divergence monitor and the reconciler.
//
// Both roles run the SAME watcher over the SAME independent verification path.
// The difference between them is only what they do with a confirmed transfer:
// a validator signs it with a key that can authorise value, a submitter spends
// gas relaying signatures that already exist. That is why they are separate
// processes on separate hosts with separate keys, and why this file contains
// nothing role-specific.

import { ChainClient } from './chain.ts';
import type { RelayerConfig } from './config.ts';
import type { Store, StoredTransfer } from './db.ts';
import { FinalityMonitor, needsFinalityMonitor, unmonitoredFinalityStatus } from './finality.ts';
import { RelayerHttpServer } from './http.ts';
import { VolumeLimiter } from './limits.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import type { Alerter } from './alerts.ts';
import { Watcher } from './watcher.ts';
import { domainSeparatorFor } from './transfer.ts';

export interface RoleHooks {
  /** Called for every transfer that reaches `confirmed`. */
  onConfirmed(transfer: StoredTransfer): Promise<void>;
  /** Periodic role work (submitting, retrying). Called every tickIntervalMs. */
  tick?(): Promise<void>;
  /** Validator only: serve this node's attestation for a transfer id. */
  signatures?(transferId: string): Record<string, unknown> | null;
  /** Extra fields for /health and /status. */
  extraStatus?(): Record<string, unknown>;
  /** Extra readiness condition; false makes /health return 503. */
  ready?(): boolean;
}

export interface ServiceOptions {
  cfg: RelayerConfig;
  role: 'validator' | 'submitter';
  log: Logger;
  alerts: Alerter;
  store: Store;
  metrics: Metrics;
  hooks: RoleHooks;
  /** How often to run hooks.tick(). */
  tickIntervalMs: number;
}

export class RelayerService {
  readonly cfg: RelayerConfig;
  readonly role: 'validator' | 'submitter';
  readonly log: Logger;
  readonly alerts: Alerter;
  readonly store: Store;
  readonly metrics: Metrics;
  readonly limiter: VolumeLimiter;
  readonly chains = new Map<number, ChainClient>();
  /** Source chains whose finality rule goes beyond a block count (finality.ts). */
  readonly finality = new Map<number, FinalityMonitor>();
  readonly watchers: Watcher[] = [];
  private readonly hooks: RoleHooks;
  private readonly tickIntervalMs: number;
  private http: RelayerHttpServer | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private readonly startedAt = Date.now();

  constructor(opts: ServiceOptions) {
    this.cfg = opts.cfg;
    this.role = opts.role;
    this.log = opts.log;
    this.alerts = opts.alerts;
    this.store = opts.store;
    this.metrics = opts.metrics;
    this.hooks = opts.hooks;
    this.tickIntervalMs = opts.tickIntervalMs;
    this.limiter = new VolumeLimiter(opts.store);

    for (const chain of this.cfg.chains) {
      if (!chain.enabled) continue;
      this.chains.set(chain.chainId, new ChainClient(chain, this.log, this.alerts));
    }
    if (this.chains.size < 2) {
      throw new Error(
        `only ${this.chains.size} chain(s) enabled in the config — a bridge with one side is not a bridge. ` +
          'Set "enabled": true (and a bridgeAddress) on at least two chains.',
      );
    }

    for (const client of this.chains.values()) {
      if (!needsFinalityMonitor(client.config.finality)) continue;
      const ck = client.config.finality.checkpoint;
      this.finality.set(
        client.chainId,
        new FinalityMonitor({
          chain: client,
          registryChain: ck ? (this.chains.get(ck.registryChainId) ?? null) : null,
          cfg: client.config.finality,
          log: this.log,
          alerts: this.alerts,
        }),
      );
    }

    for (const client of this.chains.values()) {
      this.watchers.push(
        new Watcher({
          chain: client,
          store: this.store,
          log: this.log,
          alerts: this.alerts,
          requireRpcQuorum: this.cfg.validator.requireRpcQuorum,
          onConfirmed: (t) => this.hooks.onConfirmed(t),
        }),
      );
    }

    this.metrics.describe('relayer_transfers_total', 'Transfers by lifecycle status');
    this.metrics.describe('relayer_chain_head', 'Latest head block observed per chain');
    this.metrics.describe('relayer_chain_settled', 'Latest settled (confirmed) block per chain');
    this.metrics.describe('relayer_chain_cursor', 'Persisted scan cursor per chain');
    this.metrics.describe('relayer_rpc_healthy', 'Healthy RPC endpoints per chain');
    this.metrics.describe('relayer_rpc_configured', 'Configured RPC endpoints per chain');
    this.metrics.describe('relayer_rpc_required', 'Endpoints that must agree before this node signs (alert when healthy < required)');
    this.metrics.describe('relayer_alerts_total', 'Alerts fired by kind');
    this.metrics.describe('relayer_up', '1 while the service is running');
    this.metrics.describe('relayer_pace_degraded', '1 while the source chain is DEGRADED or unmeasurable and this node refuses to sign');
    this.metrics.describe('relayer_pace_median_gap_ms', 'Median inter-block gap over the pace window');
    this.metrics.describe('relayer_head_age_ms', 'Age of the source chain head');
    this.metrics.describe('relayer_checkpoint_number', 'Latest verified checkpoint height (0 when none is usable)');
    this.metrics.describe('relayer_checkpoint_lag_blocks', 'Source head minus the latest checkpoint');
    this.metrics.describe('relayer_checkpoint_age_ms', 'Age of the latest checkpoint');
    this.metrics.describe('relayer_checkpoint_ok', '1 while the checkpoint is readable, fresh and hash-verified');
  }

  /** Re-measure pace and re-read checkpoints for every monitored chain. */
  async refreshFinality(): Promise<void> {
    for (const m of this.finality.values()) {
      try {
        await m.refresh();
      } catch (err) {
        this.log.warn('finality refresh failed', { chain: m.chain.name, err: (err as Error).message });
      }
    }
  }

  /**
   * Startup self-checks that must pass before this node touches a key.
   * A failure here is fatal on purpose: a bridge relayer that starts "degraded"
   * is a bridge relayer nobody notices is wrong.
   */
  async preflight(): Promise<void> {
    for (const client of this.chains.values()) {
      await client.healthCheck();
      if (client.healthyEndpoints.length === 0) {
        throw new Error(`chain ${client.name} (${client.chainId}): no RPC endpoint answered with the right chain id`);
      }
      if (client.healthyEndpoints.length < client.minAgreeingEndpoints) {
        throw new Error(
          `chain ${client.name} (${client.chainId}): ${client.healthyEndpoints.length} of ${client.endpoints.length} endpoints ` +
            `answered, but ${client.minAgreeingEndpoints} independent confirmations are required before this node will sign. ` +
            `Unhealthy: ${client.endpoints.filter((e) => !e.healthy).map((e) => `${e.url} (${e.lastError})`).join(', ')}`,
        );
      }
      const expected = domainSeparatorFor(client.chainId, client.config.bridgeAddress);
      const domain = await client.verifyDomainSeparator(expected);
      if (!domain.ok) {
        throw new Error(
          `chain ${client.name} (${client.chainId}): bridge at ${client.config.bridgeAddress} has domain separator ` +
            `${domain.onChain ?? 'unreadable'}, expected ${expected} (${domain.reason ?? ''}). ` +
            'Wrong address, wrong chain, or not a FerminuxBridge.',
        );
      }
      this.log.info('bridge verified', {
        chain: client.name,
        chainId: client.chainId,
        bridge: client.config.bridgeAddress,
        domainSeparator: expected,
        confirmations: client.config.confirmations,
        finalityTag: client.config.finalityTag,
        finalityMode: client.config.finality.mode,
        endpoints: `${client.healthyEndpoints.length}/${client.endpoints.length}`,
        minAgreeingEndpoints: client.minAgreeingEndpoints,
      });
    }
    // First measurement before any key is touched. Not fatal when it comes back
    // degraded or unreadable — that is a refusal at sign time, which is the
    // design — but loud, so an operator starting a validator into a stalled
    // chain or an empty registry sees it at once.
    await this.refreshFinality();
    for (const m of this.finality.values()) {
      const summary = m.signingSummary();
      this.log[summary.paused ? 'warn' : 'info']('finality', { chain: m.chain.name, ...m.status() });
    }
  }

  async start(): Promise<void> {
    for (const w of this.watchers) await w.initCursor();

    this.http = new RelayerHttpServer({
      host: this.cfg.http.host,
      port: this.cfg.http.port,
      apiToken: this.cfg.http.apiToken,
      rateLimit: this.cfg.http.rateLimit,
      maxConnections: this.cfg.http.maxConnections,
      metrics: this.metrics,
      log: this.log,
      handlers: {
        health: () => this.health(),
        status: () => this.status(),
        ...(this.hooks.signatures ? { signatures: (id: string) => this.hooks.signatures?.(id) ?? null } : {}),
        transfers: (status, limit) => this.listTransfers(status, limit),
      },
    });
    await this.http.listen();

    for (const w of this.watchers) w.start();

    if (this.cfg.divergenceIntervalMs > 0) {
      this.every(this.cfg.divergenceIntervalMs, async () => {
        for (const client of this.chains.values()) await client.checkDivergence();
      });
    }
    this.every(this.tickIntervalMs, async () => {
      await this.refreshFinality();
      await this.hooks.tick?.();
    });
    this.every(15_000, () => {
      this.refreshMetrics();
      return Promise.resolve();
    });
    this.refreshMetrics();

    this.alerts.fire({
      kind: 'lifecycle',
      severity: 'info',
      message: `${this.role} started`,
      key: `start:${this.role}`,
      fields: { network: this.cfg.network, chains: [...this.chains.keys()], httpPort: this.http.port },
    });
  }

  /** One deterministic pass: poll every chain, then run the role's tick. Used by tests and --once. */
  async runOnce(): Promise<void> {
    for (const w of this.watchers) await w.pollOnce();
    await this.refreshFinality();
    await this.hooks.tick?.();
    this.refreshMetrics();
  }

  private every(ms: number, fn: () => Promise<void>): void {
    const run = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.log.error('periodic task failed', { err: (err as Error).message });
      }
      if (!this.stopped) this.timers.push(setTimeout(() => void run(), ms));
    };
    this.timers.push(setTimeout(() => void run(), ms));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const w of this.watchers) w.stop();
    if (this.http) await this.http.close();
    this.metrics.set('relayer_up', 0, { role: this.role });
  }

  get httpPort(): number {
    return this.http?.port ?? 0;
  }

  // ------------------------------------------------------------------ status

  private health(): { ok: boolean; body: Record<string, unknown> } {
    const chains = [...this.chains.values()].map((c) => ({
      name: c.name,
      chainId: c.chainId,
      healthyEndpoints: c.healthyEndpoints.length,
      totalEndpoints: c.endpoints.length,
      minAgreeingEndpoints: c.minAgreeingEndpoints,
    }));
    // Not "at least one endpoint answers" but "enough endpoints answer to make
    // an independent decision". A node below its own agreement floor cannot
    // confirm anything and must say so, rather than looking healthy while it
    // silently defers every transfer.
    const allChainsUp = chains.every((c) => c.healthyEndpoints >= c.minAgreeingEndpoints);
    const roleReady = this.hooks.ready?.() ?? true;
    const ok = allChainsUp && roleReady;
    return {
      ok,
      body: {
        ok,
        role: this.role,
        network: this.cfg.network,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        store: this.store.driver,
        chains,
        ...(this.hooks.extraStatus?.() ?? {}),
      },
    };
  }

  private status(): Record<string, unknown> {
    return {
      role: this.role,
      network: this.cfg.network,
      // Unix ms. The UI discards a document older than its STATUS_MAX_AGE_MS
      // and treats a MISSING stamp as stale, so a status.json that stops being
      // rewritten cannot be trusted forever.
      generatedAt: Date.now(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      store: { driver: this.store.driver, counts: this.store.counts() },
      chains: [...this.chains.values()].map((c) => {
        const w = this.watchers.find((x) => x.chain.chainId === c.chainId);
        const m = this.finality.get(c.chainId);
        // `finality` is what the UI reads to explain a waiting transfer: the
        // pace measurement and the checkpoint lag, plus one plain sentence.
        return { ...c.status(), watcher: w?.stats ?? null, finality: m ? m.status() : unmonitoredFinalityStatus(c.config.finality, c.config.confirmations) };
      }),
      ...(this.hooks.extraStatus?.() ?? {}),
    };
  }

  private listTransfers(status: string | null, limit: number): unknown[] {
    const filter = status ? { status: [status as StoredTransfer['status']], limit } : { limit };
    return this.store.listTransfers(filter).map((t) => ({
      transferId: t.transferId,
      route: `${t.transfer.srcChainId}->${t.transfer.dstChainId}`,
      srcToken: t.transfer.srcToken,
      dstToken: t.transfer.dstToken,
      sender: t.transfer.sender,
      recipient: t.transfer.recipient,
      amount: t.transfer.amount.toString(),
      status: t.status,
      reason: t.reason,
      srcBlock: t.srcBlockNumber,
      srcTx: t.srcTxHash,
      signatures: this.store.getSignatures(t.transferId).length,
      executedTx: t.executedTxHash,
    }));
  }

  refreshMetrics(): void {
    this.metrics.set('relayer_up', 1, { role: this.role });
    for (const [status, n] of Object.entries(this.store.counts())) {
      if (status.startsWith('transfers_')) {
        this.metrics.set('relayer_transfers_total', n, { status: status.replace('transfers_', '') });
      } else if (status.startsWith('submissions_')) {
        this.metrics.set('relayer_submissions_total', n, { status: status.replace('submissions_', '') });
      } else {
        // Namespaced so a store gauge cannot collide with a role counter of the
        // same name (relayer_signatures_total is a counter in the validator).
        this.metrics.set(`relayer_store_${status}_total`, n);
      }
    }
    for (const w of this.watchers) {
      const labels = { chain: w.chain.name, chain_id: w.chain.chainId };
      this.metrics.set('relayer_chain_head', w.stats.head, labels);
      this.metrics.set('relayer_chain_settled', w.stats.settled, labels);
      this.metrics.set('relayer_chain_cursor', w.stats.cursor, labels);
      this.metrics.set('relayer_rpc_healthy', w.chain.healthyEndpoints.length, labels);
      this.metrics.set('relayer_rpc_configured', w.chain.endpoints.length, labels);
      // Alert on relayer_rpc_healthy < relayer_rpc_required: below this floor
      // the node confirms nothing, and it is silent about it apart from a
      // per-transfer "confirmation deferred" line.
      this.metrics.set('relayer_rpc_required', w.chain.minAgreeingEndpoints, labels);
    }
    for (const m of this.finality.values()) {
      const labels = { chain: m.chain.name, chain_id: m.chain.chainId };
      const pace = m.paceReport;
      if (m.cfg.pace) {
        this.metrics.set('relayer_pace_degraded', pace.state === 'ok' ? 0 : 1, labels);
        if (pace.medianGapMs !== null) this.metrics.set('relayer_pace_median_gap_ms', pace.medianGapMs, labels);
        if (pace.headAgeMs !== null) this.metrics.set('relayer_head_age_ms', pace.headAgeMs, labels);
      }
      const ck = m.checkpointReport;
      if (m.cfg.checkpoint) {
        this.metrics.set('relayer_checkpoint_ok', ck.state === 'ok' ? 1 : 0, labels);
        this.metrics.set('relayer_checkpoint_number', ck.state === 'ok' && ck.number !== null ? ck.number : 0, labels);
        if (ck.lagBlocks !== null) this.metrics.set('relayer_checkpoint_lag_blocks', ck.lagBlocks, labels);
        if (ck.ageMs !== null) this.metrics.set('relayer_checkpoint_age_ms', ck.ageMs, labels);
      }
    }
    for (const [kind, n] of this.alerts.counts) this.metrics.set('relayer_alerts_total', n, { kind });
  }
}
