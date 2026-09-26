// Finality: when is a SOURCE block settled enough that a key may sign against it?
//
// The answer used to be a block COUNT (`confirmations`), and a count is the
// wrong primitive twice over:
//
//   * on a PoW chain without a finality gadget the block time is not a
//     constant. During the 2026-08-21 Ferminux stall the bridge sat on
//     "Confirming 12/64" for hours, telling nobody anything — 64 blocks is
//     7.5 minutes at nominal pace and forever at zero pace;
//   * on an authority chain (Ferminux after the Clique fork) a reorg costs no
//     work at all, so there is no count that prices one. Deep history is just
//     the founders' keys.
//
// So the rule is now, per chain and explicit in config (config.ts FinalityMode):
//
//   work-and-time   accumulated difficulty above the block >= workThreshold
//                   AND wall clock since the block >= timeFloorMs
//   checkpoint      the block is at or below the latest multisig-attested
//                   checkpoint in the CheckpointRegistry on BSC, whose hash
//                   matches what THIS node sees at that height on the source
//                   chain (a mismatch is a detected reorg)
//
// and under both, a PACE monitor: the median of the last N inter-block gaps,
// and the age of the head. When either says the chain is far below its
// nominal pace the chain is DEGRADED, this node refuses to sign, and /status
// says so with the measurement — never a progress bar that does not move.
//
// `confirmations` remains a floor beneath all of this (the watcher still
// promotes nothing shallower). Nothing here lowers it.
//
// Every read that feeds a decision goes through the chain's endpoint QUORUM:
// a header is accepted when at least `minAgreeingEndpoints` endpoints return
// the same (number, hash, parentHash, timestamp, difficulty), and the registry
// value when that many agree byte for byte with nobody contradicting them.
// Headers are cached by HASH — a hash is immutable, so the cache can never
// serve a reorged-away block as current — and the walk from head to the source
// block follows parentHash links, so the work summed is the work on top of the
// block this node actually confirmed.
//
// Everything fails CLOSED. Cannot measure pace: refuse. Cannot read the
// registry: refuse. Registry and chain disagree: refuse and page a human.

import { Interface, type Block } from 'ethers';
import type { Alerter } from './alerts.ts';
import { errorText, type ChainClient } from './chain.ts';
import type { CheckpointConfig, FinalityConfig } from './config.ts';
import type { Logger } from './logger.ts';

export const REGISTRY_ABI = [
  'function latest() view returns (uint64 number, bytes32 blockHash, uint64 attestedAt)',
  'function checkpointAt(uint64 number) view returns (bytes32 blockHash, uint64 attestedAt)',
  'function latestNumber() view returns (uint64)',
] as const;

const registryInterface = new Interface(REGISTRY_ABI as unknown as string[]);

export interface Header {
  number: number;
  hash: string;
  parentHash: string;
  /** Seconds, as on chain. */
  timestamp: number;
  difficulty: bigint;
}

export type PaceState = 'ok' | 'degraded' | 'unknown';

export interface PaceReport {
  state: PaceState;
  targetBlockTimeMs: number;
  degradedFactor: number;
  stallAfterMs: number;
  /** Median inter-block gap over the window, ms. null when unmeasured. */
  medianGapMs: number | null;
  maxGapMs: number | null;
  samples: number;
  headNumber: number | null;
  headHash: string | null;
  /** now - head.timestamp. The "is it stalled right now" number. */
  headAgeMs: number | null;
  measuredAt: number;
  reason: string | null;
}

export type CheckpointState = 'ok' | 'missing' | 'stale' | 'mismatch' | 'unreadable' | 'unconfigured';

export interface CheckpointReport {
  state: CheckpointState;
  registryAddress: string | null;
  registryChainId: number | null;
  number: number | null;
  hash: string | null;
  /** ms epoch, from the registry's attestedAt. */
  attestedAt: number | null;
  ageMs: number | null;
  maxAgeMs: number | null;
  /** Source-chain head minus the checkpoint height: how far behind the chain the attestation is. */
  lagBlocks: number | null;
  /** True only when this node read the same hash at that height on the source chain. */
  hashVerified: boolean;
  checkedAt: number;
  reason: string | null;
}

export type FinalityCode =
  | 'not_final'
  | 'pace_degraded'
  | 'pace_unknown'
  | 'checkpoint_unavailable'
  | 'checkpoint_missing'
  | 'checkpoint_stale'
  | 'checkpoint_behind'
  | 'checkpoint_mismatch'
  | 'src_block_reorged'
  | 'finality_unverifiable';

export interface FinalityVerdict {
  ok: boolean;
  code: FinalityCode | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

/** The slice of a stored transfer the monitor needs. */
export interface SourceAnchor {
  srcBlockNumber: number;
  srcBlockHash: string;
}

export interface FinalityMonitorOptions {
  chain: ChainClient;
  /** The chain the CheckpointRegistry lives on. Required when cfg.checkpoint is set. */
  registryChain: ChainClient | null;
  cfg: FinalityConfig;
  log: Logger;
  alerts: Alerter;
  /** Injectable clock for tests. */
  now?: () => number;
}

const HEADER_CACHE_MAX = 16_384;

/**
 * Head difficulty at or below this means the blocks are authority-signed
 * (Clique: 2 in turn, 1 out of turn), not produced by work. Summed over the
 * whole 4,096-block walk that is at most ~8,192 — against a workThreshold of
 * 7.8e10 — so "work-and-time" on such a chain refuses every transfer forever,
 * silently, as 'not_final'. Ferminux crossed this line at block 160,000.
 */
export const AUTHORITY_DIFFICULTY_MAX = 2n;

function toHeader(b: Block): Header {
  return {
    number: b.number,
    hash: String(b.hash).toLowerCase(),
    parentHash: String(b.parentHash).toLowerCase(),
    timestamp: Number(b.timestamp),
    difficulty: BigInt(b.difficulty ?? 0n),
  };
}

function headerKey(h: Header): string {
  return `${h.number}|${h.hash}|${h.parentHash}|${h.timestamp}|${h.difficulty.toString()}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export class FinalityMonitor {
  readonly chain: ChainClient;
  readonly cfg: FinalityConfig;
  private readonly registryChain: ChainClient | null;
  private readonly log: Logger;
  private readonly alerts: Alerter;
  private readonly now: () => number;
  private readonly headers = new Map<string, Header>();
  private head: Header | null = null;
  /** Set once measurePace sees authority-signed heads while the mode is work-and-time. */
  private workModeImpossible = false;
  private pace: PaceReport;
  private checkpoint: CheckpointReport;
  private lastRefreshAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(opts: FinalityMonitorOptions) {
    this.chain = opts.chain;
    this.cfg = opts.cfg;
    this.registryChain = opts.registryChain;
    this.log = opts.log.child({ component: 'finality', chain: opts.chain.name });
    this.alerts = opts.alerts;
    this.now = opts.now ?? (() => Date.now());
    if (this.cfg.checkpoint && !this.registryChain) {
      throw new Error(`chain ${this.chain.name}: checkpoint registry chain ${this.cfg.checkpoint.registryChainId} is not available to this node`);
    }
    const pace = this.cfg.pace;
    this.pace = {
      state: 'unknown',
      targetBlockTimeMs: pace?.targetBlockTimeMs ?? 0,
      degradedFactor: pace?.degradedFactor ?? 0,
      stallAfterMs: pace?.stallAfterMs ?? 0,
      medianGapMs: null,
      maxGapMs: null,
      samples: 0,
      headNumber: null,
      headHash: null,
      headAgeMs: null,
      measuredAt: 0,
      reason: 'not measured yet',
    };
    this.checkpoint = {
      state: this.cfg.checkpoint ? 'unreadable' : 'unconfigured',
      registryAddress: this.cfg.checkpoint?.registryAddress ?? null,
      registryChainId: this.cfg.checkpoint?.registryChainId ?? null,
      number: null,
      hash: null,
      attestedAt: null,
      ageMs: null,
      maxAgeMs: this.cfg.checkpoint?.maxAgeMs ?? null,
      lagBlocks: null,
      hashVerified: false,
      checkedAt: 0,
      reason: this.cfg.checkpoint ? 'not read yet' : null,
    };
  }

  get paceReport(): PaceReport {
    return this.pace;
  }

  get checkpointReport(): CheckpointReport {
    return this.checkpoint;
  }

  /** True once the head shows authority-signed blocks while the mode is work-and-time. */
  get workModeUnsatisfiable(): boolean {
    return this.workModeImpossible;
  }

  // ------------------------------------------------------------------ reads

  /**
   * One header, agreed by the endpoint quorum. `ref` is a number (canonical
   * lookup — endpoints may briefly disagree at the tip, so the largest agreeing
   * group wins provided it meets the floor) or a hash (content lookup — any
   * disagreement at all is a lying node, and is refused).
   */
  async quorumHeader(ref: number | string): Promise<{ header: Header | null; reason: string | null }> {
    const byHash = typeof ref === 'string';
    if (byHash) {
      const cached = this.headers.get(ref.toLowerCase());
      if (cached) return { header: cached, reason: null };
    }
    const endpoints = this.chain.healthyEndpoints;
    const min = this.chain.minAgreeingEndpoints;
    if (endpoints.length < min) {
      return { header: null, reason: `only ${endpoints.length} of ${this.chain.endpoints.length} endpoints are healthy; ${min} must agree on a header` };
    }
    const groups = new Map<string, { header: Header; urls: string[] }>();
    const problems: string[] = [];
    // Every endpoint in parallel: a walk of N headers is N round trips, not 3N.
    const answers = await Promise.all(
      endpoints.map(async (e) => {
        try {
          return { e, block: await e.provider.getBlock(ref), err: null as unknown };
        } catch (err) {
          return { e, block: null, err };
        }
      }),
    );
    for (const { e, block, err } of answers) {
      if (err !== null) {
        problems.push(`${e.url}: ${errorText(err)}`);
        continue;
      }
      if (!block) {
        problems.push(`${e.url}: no block ${ref}`);
        continue;
      }
      const h = toHeader(block);
      if (byHash && h.hash !== ref.toLowerCase()) {
        problems.push(`${e.url}: returned hash ${h.hash} for a lookup of ${ref}`);
        continue;
      }
      const key = headerKey(h);
      const g = groups.get(key);
      if (g) g.urls.push(e.url);
      else groups.set(key, { header: h, urls: [e.url] });
    }
    if (groups.size === 0) return { header: null, reason: problems.join('; ') || `no endpoint returned block ${ref}` };
    if (byHash && groups.size > 1) {
      // Same hash, different contents: somebody is lying about a header body.
      this.alerts.fire({
        kind: 'rpc_divergence',
        severity: 'critical',
        message: 'RPC endpoints return different header contents for the same block hash',
        key: `header-divergence:${this.chain.chainId}:${ref}`,
        fields: { chain: this.chain.name, hash: ref, groups: [...groups.values()].map((g) => ({ urls: g.urls, number: g.header.number, timestamp: g.header.timestamp, difficulty: g.header.difficulty.toString() })) },
      });
      return { header: null, reason: `endpoints disagree about the contents of block ${ref}` };
    }
    const best = [...groups.values()].sort((a, b) => b.urls.length - a.urls.length)[0] as { header: Header; urls: string[] };
    if (best.urls.length < min) {
      return {
        header: null,
        reason: `only ${best.urls.length} endpoint(s) agree on block ${ref}, ${min} required${problems.length ? `: ${problems.join('; ')}` : ''}`,
      };
    }
    this.remember(best.header);
    return { header: best.header, reason: null };
  }

  private remember(h: Header): void {
    if (this.headers.has(h.hash)) return;
    if (this.headers.size >= HEADER_CACHE_MAX) {
      const oldest = this.headers.keys().next().value;
      if (oldest !== undefined) this.headers.delete(oldest);
    }
    this.headers.set(h.hash, h);
  }

  /**
   * Walk parentHash links from `from` down to height `toNumber` (inclusive),
   * at most `maxBlocks` steps. Returns the headers from `from` downwards. If
   * the walk stops short, `reached` is false and the caller decides what a
   * partial sum is worth.
   */
  private async walk(from: Header, toNumber: number, maxBlocks: number): Promise<{ headers: Header[]; reached: boolean; reason: string | null }> {
    const headers: Header[] = [from];
    let cur = from;
    while (cur.number > toNumber) {
      if (headers.length > maxBlocks) return { headers, reached: false, reason: `walk exceeded ${maxBlocks} blocks` };
      const { header: parent, reason } = await this.quorumHeader(cur.parentHash);
      if (!parent) return { headers, reached: false, reason: `parent of block ${cur.number} (${cur.parentHash}) unavailable: ${reason}` };
      if (parent.number !== cur.number - 1) {
        return { headers, reached: false, reason: `parent of block ${cur.number} reports height ${parent.number}` };
      }
      headers.push(parent);
      cur = parent;
    }
    return { headers, reached: true, reason: null };
  }

  /** Lowest head number among the endpoints that answered, once at least the floor has. */
  private async quorumHeadNumber(): Promise<{ head: number | null; reason: string | null }> {
    const endpoints = this.chain.healthyEndpoints;
    const min = this.chain.minAgreeingEndpoints;
    const heads: number[] = [];
    const problems: string[] = [];
    await Promise.all(
      endpoints.map(async (e) => {
        try {
          heads.push(await e.provider.getBlockNumber());
        } catch (err) {
          problems.push(`${e.url}: ${errorText(err)}`);
        }
      }),
    );
    if (heads.length < min) {
      return { head: null, reason: `only ${heads.length} endpoint(s) reported a head, ${min} required${problems.length ? `: ${problems.join('; ')}` : ''}` };
    }
    return { head: Math.min(...heads), reason: null };
  }

  // ---------------------------------------------------------------- refresh

  /** Re-measure pace and re-read the checkpoint. Coalesces concurrent callers. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const now = this.now();
    try {
      await this.measurePace(now);
      if (this.cfg.checkpoint) await this.readCheckpoint(this.cfg.checkpoint, now);
    } catch (err) {
      // Anything that escapes the measurements (a malformed block, an alerter
      // that throws) must not leave the PREVIOUS 'ok' reports standing: reset
      // both to their refusing states so the next assess() says no.
      const reason = `refresh threw: ${errorText(err)}`;
      this.pace = { ...this.pace, state: 'unknown', measuredAt: now, reason };
      if (this.cfg.checkpoint) this.checkpoint = { ...this.checkpoint, state: 'unreadable', hashVerified: false, checkedAt: now, reason };
      throw err;
    } finally {
      // Stamped AFTER the measurements, so a refresh that throws is re-tried by
      // the next assess() rather than trusted for another maxReportAgeMs.
      this.lastRefreshAt = now;
    }
  }

  private async measurePace(now: number): Promise<void> {
    const pace = this.cfg.pace;
    if (!pace) return;
    const previous = this.pace.state;
    const fail = (reason: string): void => {
      this.pace = { ...this.pace, state: 'unknown', measuredAt: now, reason };
      this.transition(previous, 'unknown', reason);
    };

    const { head: headNumber, reason: headReason } = await this.quorumHeadNumber();
    if (headNumber === null) return fail(`head unknown: ${headReason}`);
    const { header: head, reason } = await this.quorumHeader(headNumber);
    if (!head) return fail(`head header unavailable: ${reason}`);
    this.head = head;
    this.checkWorkModeFeasible(head);

    const walked = await this.walk(head, Math.max(head.number - pace.window, 0), pace.window + 1);
    // A walk that stopped short — a parent that did not reach quorum — is not a
    // smaller sample, it is no sample: two fast blocks at the tip must not
    // stand in for the window. Partial == unknown.
    if (!walked.reached) return fail(`cannot measure pace: ${walked.reason}`);
    if (walked.headers.length < 2) return fail('cannot measure pace: chain too short');
    const gaps: number[] = [];
    for (let i = 0; i + 1 < walked.headers.length; i++) {
      const child = walked.headers[i] as Header;
      const parent = walked.headers[i + 1] as Header;
      gaps.push(Math.max(child.timestamp - parent.timestamp, 0) * 1000);
    }
    const medianGapMs = median(gaps);
    const maxGapMs = Math.max(...gaps);
    const headAgeMs = Math.max(now - head.timestamp * 1000, 0);

    let state: PaceState = 'ok';
    let why: string | null = null;
    if (medianGapMs > pace.targetBlockTimeMs * pace.degradedFactor) {
      state = 'degraded';
      why = `median block gap ${Math.round(medianGapMs / 1000)}s over the last ${gaps.length} blocks is more than ${pace.degradedFactor}x the ${pace.targetBlockTimeMs / 1000}s target`;
    } else if (headAgeMs > pace.stallAfterMs) {
      state = 'degraded';
      why = `no block for ${Math.round(headAgeMs / 1000)}s (head ${head.number}); stall threshold is ${pace.stallAfterMs / 1000}s`;
    }
    this.pace = {
      ...this.pace,
      state,
      medianGapMs,
      maxGapMs,
      samples: gaps.length,
      headNumber: head.number,
      headHash: head.hash,
      headAgeMs,
      measuredAt: now,
      reason: why,
    };
    this.transition(previous, state, why);
  }

  /**
   * A config guard that can only be evaluated against the live chain: refuse to
   * pretend "work-and-time" is a finality rule once the source blocks carry no
   * work. Loud once (critical alert), then visible in /status as the signing
   * reason, until the operator switches the chain to "checkpoint".
   */
  private checkWorkModeFeasible(head: Header): void {
    if (this.cfg.mode !== 'work-and-time') return;
    const impossible = head.difficulty <= AUTHORITY_DIFFICULTY_MAX;
    if (impossible && !this.workModeImpossible) {
      this.alerts.fire({
        kind: 'chain_degraded',
        severity: 'critical',
        message: `finality mode "work-and-time" can never be met on ${this.chain.name}: its blocks are authority-signed (difficulty ${head.difficulty}); set finality.mode to "checkpoint"`,
        key: `work-mode-impossible:${this.chain.chainId}`,
        fields: { chain: this.chain.name, head: head.number, difficulty: head.difficulty.toString(), workThreshold: this.cfg.workThreshold.toString() },
      });
    }
    this.workModeImpossible = impossible;
  }

  private workModeReason(): string {
    return `finality mode "work-and-time" cannot be met on ${this.chain.name}: its blocks are authority-signed (difficulty <= ${AUTHORITY_DIFFICULTY_MAX}), so no transfer can accumulate the ${this.cfg.workThreshold} work threshold. The operator must switch this chain to "checkpoint" finality.`;
  }

  private transition(from: PaceState, to: PaceState, reason: string | null): void {
    if (from === to) return;
    if (to === 'ok') {
      this.log.info('source chain pace recovered — signing resumes', { medianGapMs: this.pace.medianGapMs, headAgeMs: this.pace.headAgeMs });
      this.alerts.fire({
        kind: 'chain_degraded',
        severity: 'info',
        message: 'source chain pace recovered; transfers resume',
        key: `pace-recovered:${this.chain.chainId}`,
        fields: { chain: this.chain.name, medianGapMs: this.pace.medianGapMs, headNumber: this.pace.headNumber },
      });
      return;
    }
    this.log.warn(to === 'degraded' ? 'source chain DEGRADED — refusing to sign until it recovers' : 'source chain pace UNKNOWN — refusing to sign', { reason });
    this.alerts.fire({
      kind: 'chain_degraded',
      severity: 'critical',
      message:
        to === 'degraded'
          ? 'source chain is producing blocks far below its nominal pace; this validator will not sign until it recovers'
          : 'source chain pace cannot be measured; this validator will not sign until it can',
      key: `pace-${to}:${this.chain.chainId}`,
      fields: { chain: this.chain.name, reason, medianGapMs: this.pace.medianGapMs, headAgeMs: this.pace.headAgeMs, headNumber: this.pace.headNumber },
    });
  }

  /** latest() from the registry, agreed by the registry chain's quorum. */
  private async readRegistryLatest(ck: CheckpointConfig): Promise<{ value: { number: number; hash: string; attestedAt: number } | null; reason: string | null }> {
    const reg = this.registryChain as ChainClient;
    const endpoints = reg.healthyEndpoints;
    const min = reg.minAgreeingEndpoints;
    if (endpoints.length < min) {
      return { value: null, reason: `registry chain ${reg.name}: only ${endpoints.length} healthy endpoint(s), ${min} required` };
    }
    const data = registryInterface.encodeFunctionData('latest');
    const groups = new Map<string, { value: { number: number; hash: string; attestedAt: number }; urls: string[] }>();
    const problems: string[] = [];
    const answers = await Promise.all(
      endpoints.map(async (e) => {
        try {
          return { e, raw: await e.provider.call({ to: ck.registryAddress, data }), err: null as unknown };
        } catch (err) {
          return { e, raw: null, err };
        }
      }),
    );
    for (const { e, raw, err } of answers) {
      if (err !== null) {
        problems.push(`${e.url}: ${errorText(err)}`);
        continue;
      }
      if (!raw || raw === '0x') {
        problems.push(`${e.url}: empty return data — no CheckpointRegistry at ${ck.registryAddress}?`);
        continue;
      }
      try {
        const [n, h, at] = registryInterface.decodeFunctionResult('latest', raw) as unknown as [bigint, string, bigint];
        const value = { number: Number(n), hash: String(h).toLowerCase(), attestedAt: Number(at) * 1000 };
        const key = `${value.number}|${value.hash}|${value.attestedAt}`;
        const g = groups.get(key);
        if (g) g.urls.push(e.url);
        else groups.set(key, { value, urls: [e.url] });
      } catch (decodeErr) {
        problems.push(`${e.url}: undecodable latest() return data: ${errorText(decodeErr)}`);
      }
    }
    if (groups.size === 0) return { value: null, reason: problems.join('; ') || 'no endpoint answered' };
    if (groups.size > 1) {
      // A publish that one node has and another has not yet is the benign
      // cause; refusing for one poll costs nothing. A permanent split is
      // something else, and the alert says so.
      this.alerts.fire({
        kind: 'checkpoint',
        severity: 'warn',
        message: 'registry chain endpoints disagree about the latest checkpoint',
        key: `ckpt-divergence:${this.chain.chainId}`,
        fields: { registry: ck.registryAddress, views: [...groups.values()].map((g) => ({ urls: g.urls, ...g.value })) },
      });
      return { value: null, reason: `registry endpoints disagree: ${[...groups.values()].map((g) => `${g.urls.join(',')} -> #${g.value.number}`).join('; ')}` };
    }
    const only = [...groups.values()][0] as { value: { number: number; hash: string; attestedAt: number }; urls: string[] };
    if (only.urls.length < min) {
      return { value: null, reason: `only ${only.urls.length} registry endpoint(s) answered, ${min} required${problems.length ? `: ${problems.join('; ')}` : ''}` };
    }
    return { value: only.value, reason: null };
  }

  private async readCheckpoint(ck: CheckpointConfig, now: number): Promise<void> {
    const previous = this.checkpoint.state;
    const base = { registryAddress: ck.registryAddress, registryChainId: ck.registryChainId, maxAgeMs: ck.maxAgeMs, checkedAt: now };
    const set = (r: Omit<CheckpointReport, keyof typeof base>): void => {
      this.checkpoint = { ...base, ...r };
      if (r.state !== previous) {
        if (r.state === 'ok') {
          this.log.info('checkpoint verified', { number: r.number, hash: r.hash, lagBlocks: r.lagBlocks, ageMs: r.ageMs });
        } else {
          this.alerts.fire({
            kind: 'checkpoint',
            severity: r.state === 'mismatch' ? 'critical' : 'warn',
            message:
              r.state === 'mismatch'
                ? 'REORG DETECTED: the attested checkpoint hash differs from the chain this node sees — refusing to sign'
                : `checkpoint ${r.state}: this validator will not sign until a fresh checkpoint is published and verified`,
            key: `ckpt-${r.state}:${this.chain.chainId}`,
            fields: { chain: this.chain.name, registry: ck.registryAddress, ...r },
          });
        }
      }
    };

    const { value, reason } = await this.readRegistryLatest(ck);
    if (!value) {
      return set({ state: 'unreadable', number: null, hash: null, attestedAt: null, ageMs: null, lagBlocks: null, hashVerified: false, reason });
    }
    const lagBlocks = this.head ? this.head.number - value.number : null;
    const ageMs = Math.max(now - value.attestedAt, 0);
    const common = { number: value.number, hash: value.hash, attestedAt: value.attestedAt, ageMs, lagBlocks };
    if (value.number === 0) {
      return set({ ...common, state: 'missing', hashVerified: false, reason: 'the registry holds no checkpoint yet' });
    }
    // Verify the hash FIRST: a stale checkpoint that also mismatches is a reorg,
    // and that is the louder of the two facts.
    const { header, reason: hreason } = await this.quorumHeader(value.number);
    if (!header) {
      return set({ ...common, state: 'unreadable', hashVerified: false, reason: `cannot read block ${value.number} on ${this.chain.name}: ${hreason}` });
    }
    if (header.hash !== value.hash) {
      return set({
        ...common,
        state: 'mismatch',
        hashVerified: false,
        reason: `registry attests ${value.hash} at block ${value.number}, this node sees ${header.hash} — the chain has been rewritten across the checkpoint`,
      });
    }
    if (ageMs > ck.maxAgeMs) {
      return set({
        ...common,
        state: 'stale',
        hashVerified: true,
        reason: `checkpoint #${value.number} was attested ${Math.round(ageMs / 60_000)} min ago; max age is ${Math.round(ck.maxAgeMs / 60_000)} min`,
      });
    }
    set({ ...common, state: 'ok', hashVerified: true, reason: null });
  }

  // ----------------------------------------------------------------- verdict

  /**
   * May a transfer anchored at this source block be signed NOW? Every `false`
   * is a refusal; the validator treats all of them as retryable and keeps the
   * transfer pending, because each can clear on its own (blocks arrive, a
   * checkpoint is published) — except that a mismatch or a reorged source
   * block also pages a human, because those do not clear on their own.
   */
  async assess(anchor: SourceAnchor, maxReportAgeMs: number): Promise<FinalityVerdict> {
    const now = this.now();
    if (now - this.lastRefreshAt > maxReportAgeMs || this.head === null) await this.refresh();
    const verdict = (ok: boolean, code: FinalityCode | null, reason: string | null, detail: Record<string, unknown> = {}): FinalityVerdict => ({
      ok,
      code,
      reason,
      detail: { mode: this.cfg.mode, srcBlock: anchor.srcBlockNumber, ...detail },
    });

    // ---- pace: a chain that is not producing blocks is not one to sign against
    if (this.cfg.pace) {
      if (this.pace.state === 'unknown') return verdict(false, 'pace_unknown', `source chain pace cannot be measured: ${this.pace.reason}`);
      if (this.pace.state === 'degraded') {
        return verdict(false, 'pace_degraded', `Ferminux is producing blocks slowly; transfers are paused until it recovers (${this.pace.reason})`, {
          medianGapMs: this.pace.medianGapMs,
          headAgeMs: this.pace.headAgeMs,
        });
      }
    }

    // ---- checkpoint: the attested ceiling, in every mode that configures one
    if (this.cfg.checkpoint) {
      const ck = this.checkpoint;
      switch (ck.state) {
        case 'unreadable':
          return verdict(false, 'checkpoint_unavailable', `checkpoint registry unreadable: ${ck.reason}`);
        case 'missing':
          return verdict(false, 'checkpoint_missing', 'no checkpoint has been published yet');
        case 'mismatch':
          return verdict(false, 'checkpoint_mismatch', ck.reason, { checkpoint: ck.number, attested: ck.hash });
        case 'stale':
          return verdict(false, 'checkpoint_stale', ck.reason, { checkpoint: ck.number, ageMs: ck.ageMs });
        case 'unconfigured':
          return verdict(false, 'checkpoint_unavailable', 'checkpoint configured but never read');
        case 'ok':
          break;
      }
      if (ck.number === null || anchor.srcBlockNumber > ck.number) {
        return verdict(
          false,
          'checkpoint_behind',
          `source block ${anchor.srcBlockNumber} is above the latest attested checkpoint #${ck.number}; waiting for the next checkpoint`,
          { checkpoint: ck.number, blocksAboveCheckpoint: ck.number === null ? null : anchor.srcBlockNumber - ck.number, lagBlocks: ck.lagBlocks },
        );
      }
    }

    // ---- the source block itself must still be canonical by quorum
    const { header: src, reason: srcReason } = await this.quorumHeader(anchor.srcBlockNumber);
    if (!src) return verdict(false, 'finality_unverifiable', `cannot read source block ${anchor.srcBlockNumber}: ${srcReason}`);
    if (src.hash !== anchor.srcBlockHash.toLowerCase()) {
      this.alerts.fire({
        kind: 'reorg',
        severity: 'critical',
        message: 'source block of a confirmed transfer is no longer canonical — refusing to sign',
        key: `reorg-src:${this.chain.chainId}:${anchor.srcBlockNumber}:${anchor.srcBlockHash}`,
        fields: { chain: this.chain.name, block: anchor.srcBlockNumber, expected: anchor.srcBlockHash, canonical: src.hash },
      });
      return verdict(false, 'src_block_reorged', `block ${anchor.srcBlockNumber} is now ${src.hash}, transfer was anchored at ${anchor.srcBlockHash}`);
    }

    if (this.cfg.mode !== 'work-and-time') {
      return verdict(true, null, null, this.cfg.checkpoint ? { checkpoint: this.checkpoint.number } : {});
    }

    // ---- work-and-time
    if (this.workModeImpossible) return verdict(false, 'not_final', this.workModeReason());
    const head = this.head as Header;
    if (head.number <= anchor.srcBlockNumber) {
      return verdict(false, 'not_final', `head ${head.number} is not above source block ${anchor.srcBlockNumber}`);
    }
    const walked = await this.walk(head, anchor.srcBlockNumber + 1, this.cfg.maxWalkBlocks);
    if (!walked.reached && walked.headers.length <= this.cfg.maxWalkBlocks) {
      return verdict(false, 'finality_unverifiable', `cannot walk from head ${head.number} to block ${anchor.srcBlockNumber}: ${walked.reason}`);
    }
    if (walked.reached) {
      const lowest = walked.headers[walked.headers.length - 1] as Header;
      if (lowest.parentHash !== src.hash) {
        this.alerts.fire({
          kind: 'reorg',
          severity: 'critical',
          message: 'head does not descend from the source block of a confirmed transfer — refusing to sign',
          key: `reorg-ancestry:${this.chain.chainId}:${anchor.srcBlockNumber}`,
          fields: { chain: this.chain.name, block: anchor.srcBlockNumber, expected: src.hash, parentOfNext: lowest.parentHash, head: head.number },
        });
        return verdict(false, 'src_block_reorged', `block ${anchor.srcBlockNumber + 1} on the current head's chain has parent ${lowest.parentHash}, not ${src.hash}`);
      }
    }
    // When the walk stopped at the cap, this is a LOWER bound on the work above
    // the source block — every header summed is still above it. Enough is enough.
    let work = 0n;
    for (const h of walked.headers) work += h.difficulty;
    const elapsedMs = Math.max(now - src.timestamp * 1000, 0);
    const detail = {
      work: work.toString(),
      workThreshold: this.cfg.workThreshold.toString(),
      blocksAbove: walked.headers.length,
      elapsedMs,
      timeFloorMs: this.cfg.timeFloorMs,
      walkComplete: walked.reached,
    };
    if (work < this.cfg.workThreshold) {
      const perBlock = walked.headers.length > 0 ? work / BigInt(walked.headers.length) : 0n;
      const remaining = perBlock > 0n ? Number((this.cfg.workThreshold - work + perBlock - 1n) / perBlock) : null;
      return verdict(
        false,
        'not_final',
        `accumulated work ${work} of ${this.cfg.workThreshold} above block ${anchor.srcBlockNumber} (${walked.headers.length} blocks${remaining !== null ? `, ~${remaining} more at current difficulty` : ''})`,
        detail,
      );
    }
    if (elapsedMs < this.cfg.timeFloorMs) {
      return verdict(
        false,
        'not_final',
        `work threshold met but only ${Math.round(elapsedMs / 1000)}s of the ${Math.round(this.cfg.timeFloorMs / 1000)}s time floor have passed since block ${anchor.srcBlockNumber}`,
        detail,
      );
    }
    return verdict(true, null, null, detail);
  }

  // ------------------------------------------------------------------ status

  status(): Record<string, unknown> {
    return {
      mode: this.cfg.mode,
      confirmationsFloor: this.chain.config.confirmations,
      work:
        this.cfg.mode === 'work-and-time'
          ? { threshold: this.cfg.workThreshold.toString(), timeFloorMs: this.cfg.timeFloorMs, maxWalkBlocks: this.cfg.maxWalkBlocks }
          : null,
      pace: this.cfg.pace ? this.pace : null,
      checkpoint: this.cfg.checkpoint ? this.checkpoint : null,
      /** The single line a UI should show while a transfer waits. */
      signing: this.signingSummary(),
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  /** Human sentence for the UI: why this node is or is not signing right now. */
  signingSummary(): { paused: boolean; reason: string | null } {
    if (this.cfg.pace && this.pace.state === 'unknown') return { paused: true, reason: `Pace of ${this.chain.name} cannot be measured: ${this.pace.reason}` };
    if (this.cfg.pace && this.pace.state === 'degraded') {
      return { paused: true, reason: `${this.chain.name} is producing blocks slowly; transfers are paused until it recovers (${this.pace.reason})` };
    }
    if (this.cfg.checkpoint && this.checkpoint.state !== 'ok') {
      return { paused: true, reason: `Checkpoint ${this.checkpoint.state}: ${this.checkpoint.reason ?? 'transfers are paused until a fresh checkpoint is verified'}` };
    }
    if (this.workModeImpossible) return { paused: true, reason: this.workModeReason() };
    return { paused: false, reason: null };
  }
}

/** Does this chain's config call for a monitor at all? */
export function needsFinalityMonitor(cfg: FinalityConfig): boolean {
  return cfg.mode !== 'count' || cfg.checkpoint !== null;
}

/**
 * The /status `finality` block for a chain that has NO monitor (count mode
 * with a real finality tag). Same keys as FinalityMonitor.status() so the UI
 * parses one shape; `signing.paused` is false because nothing here pauses.
 */
export function unmonitoredFinalityStatus(cfg: FinalityConfig, confirmations: number): Record<string, unknown> {
  return {
    mode: cfg.mode,
    confirmationsFloor: confirmations,
    work: null,
    pace: null,
    checkpoint: null,
    signing: { paused: false, reason: null },
    lastRefreshAt: 0,
  };
}
