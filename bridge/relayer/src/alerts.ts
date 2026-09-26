// Alerting. A webhook POST per event, de-duplicated by key so a broken RPC does
// not page someone 4,000 times an hour.
//
// The alert taxonomy is deliberately small and every entry is something a human
// must look at. If an alert fires and the correct response is "ignore it", the
// alert is a bug.

import type { Logger } from './logger.ts';
import type { RelayerConfig } from './config.ts';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export type AlertKind =
  /** A transfer exceeded a configured cap. The validator refused to sign it. */
  | 'cap_breach'
  /** A signature did not recover to a known validator, or did not match our digest. */
  | 'signature_mismatch'
  /** A peer offered a signature for a transfer this node has never seen on chain. */
  | 'unknown_transfer'
  /** Two RPC endpoints for the SAME chain disagree. Chain split or eclipse attempt. */
  | 'rpc_divergence'
  /** The live DOMAIN_SEPARATOR() does not match the pinned/derived one. */
  | 'domain_mismatch'
  /** A confirmed log vanished or changed after N confirmations — deep reorg. */
  | 'reorg'
  /** execute() reverted in simulation, or every submission attempt failed. */
  | 'submission_failed'
  /** A transfer has been waiting for a quorum longer than signatureWaitMs. */
  | 'transfer_stuck'
  /** The bridge reports itself paused. */
  | 'bridge_paused'
  /** An RPC endpoint is unreachable or lying about its chain id. */
  | 'rpc_unhealthy'
  /** A source chain is producing blocks far below its nominal pace, or has stalled. Signing is paused. */
  | 'chain_degraded'
  /** The weak-subjectivity checkpoint is missing, stale, unreadable or contradicts the chain this node sees. */
  | 'checkpoint'
  /** Process lifecycle: started, shutting down, unhandled failure. */
  | 'lifecycle';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  /** De-dup key; identical keys are throttled. Defaults to kind. */
  key?: string;
  fields?: Record<string, unknown>;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { info: 10, warn: 20, critical: 30 };

export class Alerter {
  private readonly log: Logger;
  private readonly webhookUrl: string | null;
  private readonly minSeverity: AlertSeverity;
  private readonly throttleMs: number;
  private readonly network: string;
  private readonly role: string;
  private readonly lastSent = new Map<string, number>();
  /** Per-key log throttle: when the line was last written, and how many were swallowed since. */
  private readonly lastLogged = new Map<string, { at: number; suppressed: number }>();
  /** Counters exposed on /metrics. */
  readonly counts = new Map<AlertKind, number>();

  constructor(cfg: RelayerConfig, role: string, log: Logger) {
    this.log = log.child({ component: 'alerts' });
    this.webhookUrl = cfg.alerts.webhookUrl;
    this.minSeverity = cfg.alerts.minSeverity;
    this.throttleMs = cfg.alerts.throttleMs;
    this.network = cfg.network;
    this.role = role;
  }

  /**
   * Fire an alert. Never throws and never blocks the caller's critical path —
   * a webhook outage must not stop the relayer from refusing to sign.
   */
  fire(alert: Alert): void {
    this.counts.set(alert.kind, (this.counts.get(alert.kind) ?? 0) + 1);
    const key = alert.key ?? alert.kind;
    const now = Date.now();

    // The LOG line is throttled per key exactly like the webhook. It used not
    // to be: one unusable RPC endpoint re-alerting on every 3-second poll wrote
    // ~280k lines a day per service, filled the 4 GB journal and pushed two
    // weeks of history out of it. The counter above still counts every one,
    // and the next line that is written says how many it stands for.
    const logged = this.lastLogged.get(key);
    if (this.throttleMs > 0 && logged && now - logged.at < this.throttleMs) {
      logged.suppressed++;
    } else {
      const line = { alert: alert.kind, severity: alert.severity, ...alert.fields, ...(logged?.suppressed ? { repeatsSuppressed: logged.suppressed } : {}) };
      if (alert.severity === 'critical') this.log.error(alert.message, line);
      else if (alert.severity === 'warn') this.log.warn(alert.message, line);
      else this.log.info(alert.message, line);
      this.lastLogged.set(key, { at: now, suppressed: 0 });
    }

    if (!this.webhookUrl) return;
    if (SEVERITY_ORDER[alert.severity] < SEVERITY_ORDER[this.minSeverity]) return;

    const last = this.lastSent.get(key) ?? 0;
    if (this.throttleMs > 0 && now - last < this.throttleMs) return;
    this.lastSent.set(key, now);

    void this.post({
      ts: new Date(now).toISOString(),
      network: this.network,
      role: this.role,
      kind: alert.kind,
      severity: alert.severity,
      message: alert.message,
      fields: jsonSafe(alert.fields ?? {}),
    });
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(this.webhookUrl as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) this.log.warn('alert webhook rejected', { status: res.status });
    } catch (err) {
      this.log.warn('alert webhook failed', { err: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
}

function jsonSafe(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'bigint' ? val.toString() : val;
  return out;
}
