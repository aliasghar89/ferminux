// Per-chain client over N independent RPC endpoints.
//
// The endpoints in a chain's `rpcUrls` are NOT a failover list. They are a
// quorum. A relayer that talks to one node is a relayer that believes whatever
// that node says, and "whatever that node says" is exactly what an eclipse
// attack manufactures. So:
//
//   * every endpoint is probed for the right chain id before it is used at all,
//     with a REAL round trip (see healthCheck) — not a local lookup
//   * the divergence monitor compares the block hash each endpoint reports at
//     the same confirmed height; a mismatch is a chain split or an eclipse and
//     it pages a human (alert kind: rpc_divergence)
//   * when the validator is about to sign, it re-reads the log from EVERY
//     healthy endpoint, requires them to agree byte for byte, AND requires at
//     least `minAgreeingEndpoints` of them to have answered (config.ts). One
//     endpoint agreeing with itself is not a quorum.
//
// Reads that only inform (head height, gas price) may come from one endpoint,
// and fail over to the next healthy one when it errors.
// Reads that lead to a signature may not.
//
// LIVENESS, and why it is not getNetwork(): every provider here is built with
// `staticNetwork`, which is correct for signing (the chain id can never be
// silently swapped underneath a signature) but makes `getNetwork()` resolve
// from a local constant WITHOUT dialling. A dead endpoint answers it happily.
// Health is therefore decided by an explicit `eth_chainId` round trip under a
// timeout, and any endpoint whose real data call throws is demoted on the spot.

import { Contract, Interface, JsonRpcProvider, Network, type Log } from 'ethers';
import { BRIDGE_ABI, decodeTokenConfig, type BridgeContract, type OnChainTokenConfig } from './abi.ts';
import type { ChainConfig } from './config.ts';
import { staticProviderKey } from './independence.ts';
import type { Alerter } from './alerts.ts';
import type { Logger } from './logger.ts';
import { decodeSentLog, type SentEvent } from './transfer.ts';

export interface Endpoint {
  url: string;
  /** host:port, for log lines only. */
  host: string;
  /**
   * The OPERATOR behind this endpoint (independence.ts). Two endpoints sharing
   * this key are one source of truth however differently they are spelled.
   * Config refuses any set where one provider holds `minAgreeingEndpoints`
   * endpoints, so `agreed >= minAgreeingEndpoints` here always spans at least
   * two operators without this path having to re-derive it.
   */
  operator: string;
  provider: JsonRpcProvider;
  healthy: boolean;
  lastError: string | null;
  lastCheckedAt: number;
  /** Last time this endpoint answered a probe correctly. 0 = never. */
  lastOkAt: number;
  /** Reset to 0 by a successful probe; used only for operator visibility. */
  consecutiveFailures: number;
  /**
   * Whether this endpoint serves eth_getLogs. Tracked APART from `healthy`:
   * public nodes routinely answer eth_chainId and eth_call while refusing
   * getLogs outright (bsc-dataseed: -32005 "limit exceeded" even for one block).
   * When one flag carried both, every getLogs refusal demoted the endpoint for
   * EVERYTHING, and the checkpoint-registry read — a plain eth_call that all
   * three BSC endpoints serve — failed with "0 healthy endpoints" from
   * 2026-09-14 on, so the validators refused to sign in both directions.
   */
  logsOk: boolean;
  /** When logsOk last went false; the endpoint is retried for logs LOGS_RETRY_MS later. */
  logsFailedAt: number;
  logsError: string | null;
}

/** How long an endpoint that failed a log read sits out of log reads before one retry. */
export const LOGS_RETRY_MS = 5 * 60_000;

function textsOf(err: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || err === null || err === undefined) return out;
  if (typeof err === 'string') {
    out.push(err);
    return out;
  }
  if (err instanceof AggregateError) for (const e of err.errors) textsOf(e, depth + 1, out);
  const e = err as { message?: unknown; shortMessage?: unknown; error?: unknown; info?: { responseBody?: unknown } };
  for (const v of [e.message, e.shortMessage, e.info?.responseBody]) if (typeof v === 'string') out.push(v);
  if (e.error !== undefined) textsOf(e.error, depth + 1, out);
  return out;
}

/**
 * Is this getLogs failure a refusal of THE RANGE asked for — archive depth, or a
 * span cap — rather than of the endpoint? Such an endpoint may serve the next
 * range, and certainly still serves eth_call, so it must not be demoted for
 * it; the chunk is simply retried on the next endpoint. The text is matched
 * across ethers' wrapper AND the node's own response body, because a publicnode
 * archive refusal arrives as "server response 403 Forbidden" with the reason
 * only in the body.
 *
 * A bare "limit exceeded" is NOT treated as a range refusal: bsc-dataseed
 * returns it for a single block at the head, i.e. it does not serve logs at all.
 */
export function isRangeRefusal(err: unknown): boolean {
  const text = textsOf(err).join(' | ');
  return /archive|block range|blocks range|range (is )?too (large|wide|big)|ranges over|exceed(s|ed)? (the )?max(imum)? (block )?range|query returned more than|too many blocks|range limit|limited to \d+ ?- ?\d+ blocks/i.test(text);
}

/**
 * Race a promise against a timer. A hung TCP connection is indistinguishable
 * from a slow node until you put a clock on it, and an endpoint that cannot
 * answer `eth_chainId` inside the probe budget is not one this node can use.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A message a human can act on, out of whatever a provider threw.
 *
 * Node's happy-eyeballs dialler rejects with an AggregateError whose own
 * `.message` is the EMPTY STRING, and ethers wraps failures in an outer error
 * carrying the real one under `.error`. Both end up logged as `err: ""`, which
 * is how an unreachable endpoint reads as "something happened" instead of
 * "connection refused" — and that is precisely the line an operator greps for
 * at 03:00.
 */
export function errorText(err: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (err instanceof AggregateError) {
    const parts = [...new Set(err.errors.map((e) => errorText(e, depth + 1)).filter(Boolean))];
    return err.message || parts.join('; ') || 'all connection attempts failed';
  }
  const e = err as { message?: string; shortMessage?: string; code?: string | number; error?: unknown } | null;
  const parts: string[] = [];
  const base = e?.shortMessage || e?.message || '';
  if (base) parts.push(e?.code !== undefined && !base.includes(String(e.code)) ? `${base} (${e.code})` : base);
  // ethers reports a node's own JSON-RPC error as "could not coalesce error",
  // keeping the useful half — the node's message — under `.error`. That half is
  // the one that says which endpoint is broken and how.
  const inner = e?.error === undefined || e?.error === null ? '' : errorText(e.error, depth + 1);
  if (inner && !parts.some((p) => p.includes(inner))) parts.push(inner);
  return parts.join(': ') || String(err);
}

export interface DivergenceReport {
  diverged: boolean;
  height: number;
  /** blockHash -> endpoint urls reporting it. >1 key means disagreement. */
  hashes: Record<string, string[]>;
  unreachable: string[];
}

const bridgeInterface = new Interface(BRIDGE_ABI as unknown as string[]);
const SENT_TOPIC = bridgeInterface.getEvent('Sent')?.topicHash as string;

export class ChainClient {
  readonly config: ChainConfig;
  readonly endpoints: Endpoint[];
  private readonly log: Logger;
  private readonly alerts: Alerter;
  /** Highest head height observed, used to detect a node serving stale state. */
  private highWaterHead = 0;

  constructor(config: ChainConfig, log: Logger, alerts: Alerter) {
    this.config = config;
    this.log = log.child({ chain: config.name, chainId: config.chainId });
    this.alerts = alerts;
    const network = Network.from({ chainId: config.chainId, name: config.name });
    this.endpoints = config.rpcUrls.map((url) => ({
      url,
      host: hostOf(url),
      operator: staticProviderKey(url),
      // cacheTimeout -1: never serve a cached response. A relayer that acts on a
      // 250ms-stale receipt can double-submit.
      // staticNetwork: the chain id is pinned for every signing path. It is NOT
      // a liveness signal — see healthCheck().
      provider: new JsonRpcProvider(url, network, { staticNetwork: network, cacheTimeout: -1, batchMaxCount: 1 }),
      healthy: false,
      lastError: null,
      lastCheckedAt: 0,
      lastOkAt: 0,
      consecutiveFailures: 0,
      logsOk: true,
      logsFailedAt: 0,
      logsError: null,
    }));
  }

  /** How many endpoints must independently show a log before this node signs. */
  get minAgreeingEndpoints(): number {
    return this.config.minAgreeingEndpoints;
  }

  get name(): string {
    return this.config.name;
  }

  get chainId(): number {
    return this.config.chainId;
  }

  get healthyEndpoints(): Endpoint[] {
    return this.endpoints.filter((e) => e.healthy);
  }

  /**
   * Healthy endpoints that serve eth_getLogs, plus any that failed a log read
   * more than LOGS_RETRY_MS ago and are due one more try. Log reads (discovery
   * and the pre-signing re-read) use this set; every other read uses
   * healthyEndpoints, so a node that cannot serve logs still counts as a
   * witness for headers and for the checkpoint registry.
   */
  get logEndpoints(): Endpoint[] {
    const now = Date.now();
    return this.endpoints.filter((e) => e.healthy && (e.logsOk || now - e.logsFailedAt >= LOGS_RETRY_MS));
  }

  private markLogsUnusable(e: Endpoint, message: string): void {
    const was = e.logsOk;
    e.logsOk = false;
    e.logsFailedAt = Date.now();
    e.logsError = message;
    // Once per transition, not once per poll: the same refusal every 3 seconds
    // was ~280k journal lines a day per service and buried everything else.
    if (!was) return;
    this.log.warn('rpc endpoint cannot serve eth_getLogs — excluded from log reads, still used for calls', { url: e.url, err: message });
    this.alerts.fire({
      kind: 'rpc_unhealthy',
      severity: 'warn',
      message: 'RPC endpoint cannot serve eth_getLogs',
      key: `logs:${e.url}`,
      fields: { chain: this.config.name, url: e.url, err: message, retryAfterMs: LOGS_RETRY_MS },
    });
  }

  private markLogsOk(e: Endpoint): void {
    if (e.logsOk) return;
    e.logsOk = true;
    e.logsError = null;
    this.log.info('rpc endpoint serves eth_getLogs again', { url: e.url });
  }

  /**
   * Probe every endpoint with a REAL `eth_chainId` round trip, under a timeout.
   *
   * This must never be `getNetwork()`: with `staticNetwork` set (and it is set,
   * deliberately, for every provider here) ethers answers getNetwork() from a
   * local constant and never dials, so an endpoint pointed at a closed port
   * reports the right chain id forever. That made this function a no-op, made
   * the wrong-chain branch below unreachable, and let one dead endpoint stall a
   * validator indefinitely under requireRpcQuorum.
   *
   * An endpoint that answers with the wrong chain id is not "degraded", it is a
   * different chain, and it stays unhealthy until it starts telling the truth.
   * Recovery is automatic in both cases: this runs every poll and a single good
   * answer puts the endpoint straight back into rotation.
   */
  async healthCheck(): Promise<void> {
    await Promise.all(this.endpoints.map((e) => this.probeEndpoint(e)));

    const healthy = this.healthyEndpoints.length;
    if (healthy < this.config.minAgreeingEndpoints) {
      this.alerts.fire({
        kind: 'rpc_unhealthy',
        severity: 'critical',
        message: 'too few healthy RPC endpoints to confirm a transfer independently — this node cannot sign until one returns',
        key: `belowfloor:${this.config.chainId}`,
        fields: {
          chain: this.config.name,
          healthy,
          configured: this.endpoints.length,
          required: this.config.minAgreeingEndpoints,
          unhealthy: this.endpoints.filter((e) => !e.healthy).map((e) => ({ url: e.url, lastError: e.lastError })),
        },
      });
    }
  }

  private async probeEndpoint(e: Endpoint): Promise<void> {
    e.lastCheckedAt = Date.now();
    let last: unknown;
    // Two attempts, because the first one can fail for a reason that says
    // nothing about the endpoint: an HTTP keep-alive socket the peer closed
    // between our last call and this one is reset on reuse (ECONNRESET), which
    // is routine against load-balanced public RPCs. Demoting on that single
    // event would flap an endpoint in and out of the quorum, and a validator
    // that keeps losing its agreement floor keeps refusing to sign.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await withTimeout(
          e.provider.send('eth_chainId', []) as Promise<string>,
          this.config.rpcProbeTimeoutMs,
          `eth_chainId on ${e.url}`,
        );
        const reported = Number(BigInt(String(raw)));
        if (!Number.isSafeInteger(reported) || reported <= 0) {
          this.markUnhealthy(e, `endpoint returned an unusable chain id: ${String(raw)}`, 'wrong-chain');
          return;
        }
        if (reported !== this.config.chainId) {
          // Not a retry case: a node on another chain will keep saying so.
          this.markUnhealthy(e, `endpoint reports chain id ${reported}, expected ${this.config.chainId}`, 'wrong-chain', {
            reported,
          });
          return;
        }
        if (!e.healthy) {
          this.log.info('rpc endpoint healthy', { url: e.url, afterFailures: e.consecutiveFailures });
        }
        e.healthy = true;
        e.lastError = null;
        e.lastOkAt = Date.now();
        e.consecutiveFailures = 0;
        return;
      } catch (err) {
        last = err;
      }
    }
    this.markUnhealthy(e, errorText(last), 'unreachable');
  }

  /**
   * Demote an endpoint. Called from the probe AND from every real data call, so
   * an endpoint that passes the handshake but cannot serve `eth_getLogs` is
   * taken out of the set instead of poisoning every quorum decision with an
   * error that reads as "waiting for all endpoints" forever.
   */
  private markUnhealthy(
    e: Endpoint,
    message: string,
    reason: 'unreachable' | 'wrong-chain' | 'call-failed',
    extra: Record<string, unknown> = {},
  ): void {
    const was = e.healthy;
    e.healthy = false;
    e.lastError = message;
    e.consecutiveFailures += 1;
    if (was) this.log.warn('rpc endpoint went unhealthy', { url: e.url, reason, err: message });
    this.alerts.fire({
      kind: 'rpc_unhealthy',
      severity: reason === 'wrong-chain' ? 'critical' : 'warn',
      message: reason === 'wrong-chain' ? 'RPC endpoint is on the wrong chain' : 'RPC endpoint unusable',
      key: `${reason}:${e.url}`,
      fields: { chain: this.config.name, url: e.url, reason, err: message, ...extra },
    });
  }

  private requireEndpoint(): Endpoint {
    const e = this.healthyEndpoints[0];
    if (!e) throw new Error(`chain ${this.config.name}: no healthy RPC endpoint`);
    return e;
  }

  /**
   * Run a read on the healthy endpoints in order, demoting any that throw, and
   * only failing when none of them can answer. Informational reads (head, gas,
   * a settled block) are allowed to come from whichever node is up; nothing
   * here feeds a signature — that path is confirmSentAcrossEndpoints, which
   * requires agreement rather than a first answer.
   */
  private async withFailover<T>(what: string, fn: (endpoint: Endpoint) => Promise<T>, demote = true): Promise<T> {
    const endpoints = this.healthyEndpoints;
    if (endpoints.length === 0) throw new Error(`chain ${this.config.name}: no healthy RPC endpoint`);
    let last: Error | null = null;
    for (const e of endpoints) {
      try {
        return await fn(e);
      } catch (err) {
        last = err as Error;
        // `demote: false` is for reads a node may legitimately not support (a
        // finality tag on a chain that has none). Not answering an optional
        // question is not evidence the endpoint is unusable.
        if (demote) this.markUnhealthy(e, `${what}: ${errorText(err)}`, 'call-failed');
      }
    }
    throw new Error(`chain ${this.config.name}: ${what} failed on all ${endpoints.length} healthy endpoint(s): ${errorText(last)}`);
  }

  /** Read-only contract bound to one endpoint. */
  bridgeOn(endpoint: Endpoint): BridgeContract {
    return new Contract(this.config.bridgeAddress, BRIDGE_ABI as unknown as string[], endpoint.provider) as unknown as BridgeContract;
  }

  /** Read-only contract on the first healthy endpoint. */
  bridge(): BridgeContract {
    return this.bridgeOn(this.requireEndpoint());
  }

  /** Contract bound to a signer (submitter only). */
  bridgeWith(signer: import('ethers').Signer): BridgeContract {
    return new Contract(this.config.bridgeAddress, BRIDGE_ABI as unknown as string[], signer) as unknown as BridgeContract;
  }

  provider(): JsonRpcProvider {
    return this.requireEndpoint().provider;
  }

  /**
   * Read one token's registry entry from the RETURN DATA, not through a decoded
   * fragment.
   *
   * TokenConfig is the one struct in this contract whose shape has changed
   * during development (the LOSSY class was added and then removed), and an
   * ethers Contract cannot tell a shorter tuple from a shorter answer: it either
   * throws a buffer overrun or silently reads the wrong six words. Going through
   * the raw call means an arity mismatch is named, and a deployment that predates
   * the removal still decodes correctly instead of taking the relayer down.
   */
  async readTokenConfig(localToken: string): Promise<OnChainTokenConfig> {
    const data = bridgeInterface.encodeFunctionData('tokenConfig', [localToken]);
    const raw = await this.withFailover('tokenConfig', (e) => e.provider.call({ to: this.config.bridgeAddress, data }));
    return decodeTokenConfig(raw);
  }

  async getBlockNumber(): Promise<number> {
    const n = await this.withFailover('eth_blockNumber', (e) => e.provider.getBlockNumber());
    // A node that goes BACKWARDS further than a plausible reorg is either
    // resyncing or lying. It cannot rewind our cursor — that only ever moves
    // forward — but it is worth saying out loud, because the usual cause is an
    // endpoint that was quietly swapped for a different node.
    if (n + this.config.confirmations * 2 < this.highWaterHead) {
      this.alerts.fire({
        kind: 'rpc_unhealthy',
        severity: 'critical',
        message: 'RPC head went backwards far past the confirmation depth — resyncing node, or a different node behind the same URL',
        key: `rewind:${this.config.chainId}`,
        fields: { chain: this.config.name, head: n, previousHigh: this.highWaterHead, confirmations: this.config.confirmations },
      });
    }
    if (n > this.highWaterHead) this.highWaterHead = n;
    return n;
  }

  /**
   * Height a block must be at or below to count as settled: `head - confirmations`,
   * and additionally at or below the chain's finality tag when one is configured.
   * Returns -1 when nothing is settled yet.
   */
  /** Consecutive polls in which the finality tag could not be read. 0 when healthy. */
  finalityTagFailures = 0;
  /** When the current degraded stretch began, or null when the tag is readable. */
  finalityTagDegradedSince: number | null = null;

  async settledHeight(): Promise<number> {
    const head = await this.getBlockNumber();
    let settled = head - this.config.confirmations;
    if (this.config.finalityTag) {
      // This block FAILS OPEN, deliberately but dangerously: if the tag cannot
      // be read, the safety line silently drops from "finalized" to
      // `confirmations` alone — on BSC that is finality replaced by ~60
      // seconds. It used to do so invisibly: the catch logged at DEBUG, and a
      // null return (a provider answering with no block for the tag) logged
      // NOTHING. A degraded safety line that says nothing is the same failure
      // as a monitor reporting health it never established.
      //
      // Behaviour is unchanged here on purpose — making it fail CLOSED can halt
      // transfers, which is an operator's decision, not a logging fix. What
      // changes is that the degradation is now loud and visible in status().
      let tagged = null;
      let why = '';
      try {
        tagged = await this.withFailover(
          `getBlock(${this.config.finalityTag})`,
          (e) => e.provider.getBlock(this.config.finalityTag as string),
          false,
        );
        if (!tagged) why = 'every endpoint returned no block for the tag';
      } catch (err) {
        why = errorText(err);
      }
      if (tagged) {
        if (tagged.number < settled) settled = tagged.number;
        if (this.finalityTagFailures > 0) {
          this.log.warn('finality tag readable again', {
            tag: this.config.finalityTag, afterFailures: this.finalityTagFailures });
        }
        this.finalityTagFailures = 0;
        this.finalityTagDegradedSince = null;
      } else {
        this.finalityTagFailures += 1;
        if (this.finalityTagDegradedSince === null) this.finalityTagDegradedSince = Date.now();
        this.log.warn('FINALITY TAG UNREADABLE — safety line degraded to confirmations only', {
          tag: this.config.finalityTag,
          confirmationsOnly: this.config.confirmations,
          consecutiveFailures: this.finalityTagFailures,
          degradedForMs: Date.now() - this.finalityTagDegradedSince,
          why,
        });
      }
    }
    return settled;
  }

  /** Raw `Sent` logs in [fromBlock, toBlock] from one endpoint. */
  async sentLogsFrom(endpoint: Endpoint, fromBlock: number, toBlock: number): Promise<Log[]> {
    return endpoint.provider.getLogs({
      address: this.config.bridgeAddress,
      topics: [SENT_TOPIC],
      fromBlock,
      toBlock,
    });
  }

  /** Decode `Sent` logs, verifying the indexed transfer id against a local recompute. */
  decodeSent(logs: Log[]): SentEvent[] {
    const out: SentEvent[] = [];
    for (const log of logs) {
      const parsed = bridgeInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'Sent') continue;
      out.push(
        decodeSentLog(log, {
          transferId: parsed.args.transferId as string,
          dstChainId: parsed.args.dstChainId as bigint,
          localToken: parsed.args.localToken as string,
          srcChainId: parsed.args.srcChainId as bigint,
          nonce: parsed.args.nonce as bigint,
          remoteToken: parsed.args.remoteToken as string,
          sender: parsed.args.sender as string,
          recipient: parsed.args.recipient as string,
          amount: parsed.args.amount as bigint,
          fee: parsed.args.fee as bigint,
        }),
      );
    }
    return out;
  }

  /**
   * Scan a range on a healthy endpoint, chunked to maxBlockRange, failing over
   * chunk by chunk. Discovery only: everything found here is `seen`, and has to
   * survive confirmSentAcrossEndpoints before it can be signed, so a single
   * endpoint answering this is not a trust decision.
   */
  async scanSent(
    fromBlock: number,
    toBlock: number,
    /**
     * Called after each chunk is read, with the chunk's last block and its
     * events, BEFORE the next chunk is requested. Lets the watcher persist
     * progress chunk by chunk: a 1.9M-block catch-up that fails at chunk 900
     * must not throw away the 899 chunks it already read.
     */
    onChunk?: (end: number, events: SentEvent[]) => void | Promise<void>,
  ): Promise<SentEvent[]> {
    const out: SentEvent[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.config.maxBlockRange) {
      const end = Math.min(start + this.config.maxBlockRange - 1, toBlock);
      const events = this.decodeSent(await this.logsWithFailover(start, end));
      out.push(...events);
      if (onChunk) await onChunk(end, events);
    }
    return out;
  }

  /**
   * One chunk of `Sent` logs from the first log-serving endpoint that answers.
   * A range refusal skips the endpoint for this chunk only; any other failure
   * takes it out of LOG reads (not out of the chain) until LOGS_RETRY_MS.
   */
  private async logsWithFailover(start: number, end: number): Promise<Log[]> {
    const endpoints = this.logEndpoints;
    if (endpoints.length === 0) {
      const why = this.endpoints.map((e) => `${e.host}: ${e.healthy ? (e.logsError ?? 'ok') : (e.lastError ?? 'unhealthy')}`).join('; ');
      throw new Error(`chain ${this.config.name}: no healthy endpoint serves eth_getLogs (${why})`);
    }
    const problems: string[] = [];
    for (const e of endpoints) {
      try {
        const logs = await this.sentLogsFrom(e, start, end);
        this.markLogsOk(e);
        return logs;
      } catch (err) {
        const text = errorText(err);
        problems.push(`${e.host}: ${text}`);
        if (!isRangeRefusal(err)) this.markLogsUnusable(e, `getLogs(${start}..${end}): ${text}`);
      }
    }
    throw new Error(`chain ${this.config.name}: getLogs(${start}..${end}) failed on all ${endpoints.length} log-serving endpoint(s): ${problems.join('; ')}`);
  }

  /**
   * Re-read ONE transfer's log across every healthy endpoint and require them to
   * agree on transfer id and block hash. This is the check that makes a signature
   * safe against both a reorg (the log moved or vanished) and a lying node (only
   * one endpoint has ever seen it).
   *
   * The four outcomes are deliberately distinct, because the right response to
   * each is different:
   *
   *   ok             at least `minAgreeingEndpoints` endpoints showed the same
   *                  log and none contradicted it. Sign.
   *   vanished       every endpoint answered, none has the log any more, or the
   *                  block hash changed. The chain rewrote history past the
   *                  confirmation depth -> this transfer is dead, alert as reorg.
   *   quorum_failed  endpoints DISAGREE: some show it, some do not. That is a
   *                  chain split or an eclipse, not a reorg. Never sign, page a
   *                  human, and keep the transfer pending — it may be fine.
   *   unavailable    too few endpoints could answer to decide anything. Try
   *                  again later, decide nothing, and NEVER fall back to
   *                  trusting the one node that is still talking: that is the
   *                  eclipse. An attacker who controls one configured endpoint
   *                  and can DoS the rest gets refusal, not a signature.
   *
   * Collapsing quorum_failed into vanished would let a single lying endpoint
   * make an honest validator discard real transfers, which is a denial of
   * service with extra steps.
   */
  async confirmSentAcrossEndpoints(
    transferId: string,
    blockNumber: number,
    blockHash: string,
    requireAll: boolean,
  ): Promise<{ status: 'ok' | 'vanished' | 'quorum_failed' | 'unavailable'; reason: string | null; agreed: number; checked: number }> {
    // Only endpoints that serve logs are asked. One that cannot is not a
    // witness to a log, and leaving it in made requireRpcQuorum wait on it
    // forever; it still counts for headers and registry reads.
    const endpoints = this.logEndpoints;
    const minAgree = this.config.minAgreeingEndpoints;
    if (endpoints.length === 0) return { status: 'unavailable', reason: 'no healthy endpoint', agreed: 0, checked: 0 };
    if (endpoints.length < minAgree) {
      // Not enough independent sources are up to make this decision at all.
      // Refusing here is the whole point: the alternative is signing on the
      // word of whichever endpoints an attacker chose to leave standing.
      return {
        status: 'unavailable',
        reason: `only ${endpoints.length} of ${this.endpoints.length} endpoints are healthy; ${minAgree} independent confirmations are required`,
        agreed: 0,
        checked: 0,
      };
    }

    let agreed = 0;
    let missing = 0;
    let errored = 0;
    const disagreements: string[] = [];

    for (const e of endpoints) {
      try {
        const logs = await this.sentLogsFrom(e, blockNumber, blockNumber);
        this.markLogsOk(e);
        const events = this.decodeSent(logs);
        const match = events.find((ev) => ev.transferId.toLowerCase() === transferId.toLowerCase());
        if (!match) {
          missing++;
          disagreements.push(`${e.url}: log absent at block ${blockNumber}`);
          continue;
        }
        if (match.blockHash.toLowerCase() !== blockHash.toLowerCase()) {
          missing++;
          disagreements.push(`${e.url}: block hash ${match.blockHash} != ${blockHash}`);
          continue;
        }
        agreed++;
      } catch (err) {
        errored++;
        disagreements.push(`${e.url}: ${errorText(err)}`);
        // A one-block read cannot be a range problem: this endpoint does not
        // serve logs right now. Out of the log set until the retry window.
        this.markLogsUnusable(e, `getLogs(${blockNumber}): ${errorText(err)}`);
      }
    }
    const checked = agreed + missing + errored;

    // Contradiction beats everything: some endpoints show it, some do not. That
    // is a split or an eclipse, never a signature.
    if (agreed > 0 && missing > 0) {
      this.alerts.fire({
        kind: 'rpc_divergence',
        severity: 'critical',
        message: 'RPC endpoints disagree about a bridge transfer — chain split or eclipse',
        key: `divergence-transfer:${transferId}`,
        fields: { chain: this.config.name, transferId, blockNumber, agreed, missing, errored, disagreements },
      });
      return { status: 'quorum_failed', reason: `endpoints disagree: ${disagreements.join('; ')}`, agreed, checked };
    }

    // Everybody answered and nobody has it: the chain rewrote history.
    if (agreed === 0 && missing > 0 && errored === 0) {
      return { status: 'vanished', reason: disagreements.join('; '), agreed, checked };
    }

    if (agreed === 0) {
      return { status: 'unavailable', reason: disagreements.join('; ') || 'no endpoint answered', agreed, checked };
    }

    // agreed > 0 and nothing contradicted it. The remaining question is whether
    // ENOUGH independent endpoints said so.
    if (agreed < minAgree) {
      this.alerts.fire({
        kind: 'rpc_unhealthy',
        severity: 'warn',
        message: 'too few RPC endpoints could confirm a transfer — refusing to attest on a single source',
        key: `belowfloor-transfer:${transferId}`,
        fields: { chain: this.config.name, transferId, blockNumber, agreed, required: minAgree, errored, disagreements },
      });
      return {
        status: 'unavailable',
        reason: `only ${agreed} endpoint(s) confirmed, ${minAgree} required${disagreements.length > 0 ? `: ${disagreements.join('; ')}` : ''}`,
        agreed,
        checked,
      };
    }

    if (errored > 0 && requireAll) {
      // Strict mode waits for a full house even though the floor is already met.
      return { status: 'unavailable', reason: `waiting for all endpoints: ${disagreements.join('; ')}`, agreed, checked };
    }

    return { status: 'ok', reason: null, agreed, checked };
  }

  /**
   * Compare the block hash every endpoint reports at a settled height. Endpoints
   * on the same chain MUST return the same hash there; if they do not, the node
   * set has split (or one of them is feeding this relayer a private fork) and no
   * signature produced from that view can be trusted.
   */
  async checkDivergence(): Promise<DivergenceReport> {
    const endpoints = this.healthyEndpoints;
    const empty: DivergenceReport = { diverged: false, height: 0, hashes: {}, unreachable: [] };
    if (endpoints.length < 2) return empty;

    let height = 0;
    for (const e of endpoints) {
      try {
        const n = await e.provider.getBlockNumber();
        height = height === 0 ? n : Math.min(height, n);
      } catch {
        // counted below
      }
    }
    // Compare at a depth every honest endpoint should have settled on.
    height = Math.max(height - this.config.confirmations, 0);
    if (height === 0) return empty;

    const hashes: Record<string, string[]> = {};
    const unreachable: string[] = [];
    for (const e of endpoints) {
      try {
        const block = await e.provider.getBlock(height);
        if (!block) {
          unreachable.push(e.url);
          continue;
        }
        (hashes[block.hash as string] ??= []).push(e.url);
      } catch (err) {
        unreachable.push(`${e.url}: ${errorText(err)}`);
      }
    }

    const diverged = Object.keys(hashes).length > 1;
    if (diverged) {
      this.alerts.fire({
        kind: 'rpc_divergence',
        severity: 'critical',
        message: 'RPC endpoints report different block hashes at the same settled height — chain split or eclipse',
        key: `divergence:${this.config.chainId}:${height}`,
        fields: { chain: this.config.name, chainId: this.config.chainId, height, hashes },
      });
    }
    return { diverged, height, hashes, unreachable };
  }

  /**
   * Confirm the bridge deployment is the one this relayer thinks it is: the live
   * EIP-712 domain separator must equal the one we derive locally from
   * (chainId, bridgeAddress), and the pinned value in config when present.
   * A validator that skips this can be phished into signing for an attacker's
   * bridge at an address it was tricked into configuring.
   */
  async verifyDomainSeparator(expected: string): Promise<{ ok: boolean; onChain: string | null; reason: string | null }> {
    try {
      const onChain = String(await this.bridge().DOMAIN_SEPARATOR()).toLowerCase();
      if (onChain !== expected.toLowerCase()) {
        return { ok: false, onChain, reason: `on-chain ${onChain} != locally derived ${expected.toLowerCase()}` };
      }
      if (this.config.domainSeparator && this.config.domainSeparator !== onChain) {
        return { ok: false, onChain, reason: `on-chain ${onChain} != pinned ${this.config.domainSeparator}` };
      }
      return { ok: true, onChain, reason: null };
    } catch (err) {
      return { ok: false, onChain: null, reason: errorText(err) };
    }
  }

  status(): Record<string, unknown> {
    return {
      name: this.config.name,
      chainId: this.config.chainId,
      bridge: this.config.bridgeAddress,
      // Surfaced so a degraded safety line is visible to the watcher and the
      // status page, not only in a log line nobody tails.
      finalityTagDegraded: this.finalityTagFailures > 0,
      finalityTagFailures: this.finalityTagFailures,
      finalityTagDegradedForMs: this.finalityTagDegradedSince === null ? 0 : Date.now() - this.finalityTagDegradedSince,
      confirmations: this.config.confirmations,
      finalityTag: this.config.finalityTag,
      minAgreeingEndpoints: this.config.minAgreeingEndpoints,
      healthyEndpoints: this.healthyEndpoints.length,
      logEndpoints: this.logEndpoints.length,
      endpoints: this.endpoints.map((e) => ({
        url: e.url,
        host: e.host,
        healthy: e.healthy,
        lastError: e.lastError,
        lastCheckedAt: e.lastCheckedAt,
        lastOkAt: e.lastOkAt,
        consecutiveFailures: e.consecutiveFailures,
        logsOk: e.logsOk,
        logsError: e.logsError,
      })),
    };
  }
}

export { SENT_TOPIC, bridgeInterface };
