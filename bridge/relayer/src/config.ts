// Configuration: load, validate, apply env overrides, refuse to start on anything
// ambiguous. A bridge relayer that boots with a half-understood config is a
// bridge relayer that signs something nobody intended, so every unknown field is
// an error and every security-relevant value has an explicit default written
// down here rather than an implicit one buried in code.
//
// Secrets are NEVER read from this file: keys come from an encrypted keystore
// (src/keystore.ts), passwords from a file or the environment.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getAddress, isAddress } from 'ethers';
import { autoMinAgreeing, groupEndpoints, identify, independenceProblems } from './independence.ts';
import type { LogLevel } from './logger.ts';

export type FinalityTag = 'finalized' | 'safe' | null;

export interface GasConfig {
  /** Hard ceiling on maxFeePerGas. The submitter never signs above this. */
  maxFeePerGasGwei: number;
  /** Floor for the priority fee; the node's suggestion wins if it is higher. */
  priorityFeeGwei: number;
  /** maxFee = baseFee * multiplier + tip. 2 survives two full base-fee doublings. */
  baseFeeMultiplier: number;
  /** Head-room applied to eth_estimateGas. */
  gasLimitMultiplier: number;
  /** Absolute gas-limit ceiling, so a broken estimate cannot burn the balance. */
  gasLimitCap: number;
  /** Per-retry fee bump, percent. Must be >= 10 or nodes reject the replacement. */
  escalationPct: number;
  /** Attempts (including the first) before the submitter gives up and alerts. */
  maxAttempts: number;
  /** How long to wait for a receipt before escalating. */
  receiptTimeoutMs: number;
  /** 2 = EIP-1559 (Ferminux and every chain listed here). 0 = legacy fallback. */
  txType: 0 | 2;
}

export interface TokenLimit {
  maxPerTransfer: bigint;
  dailyCap: bigint;
}

export interface ChainLimits {
  /** Applied to any token without an explicit entry. */
  default: TokenLimit;
  /** Keyed by lowercase local token address; 0x00..00 is the native coin. */
  tokens: Record<string, TokenLimit>;
}

/**
 * How a SOURCE block on this chain becomes final enough to sign against.
 *
 *   count          the legacy rule: `confirmations` blocks (plus `finalityTag`
 *                  where the chain has one). Right for chains with a real
 *                  finality gadget (BSC, Ethereum, the L2s). WRONG for a chain
 *                  without one, because a block COUNT prices nothing: on PoW the
 *                  block time swings with hashrate, and on an authority chain a
 *                  reorg costs zero work however deep it is.
 *   work-and-time  PoW without a finality gadget (Ferminux today). A block is
 *                  settled only when the chain has accumulated `workThreshold`
 *                  of total difficulty on top of it AND `timeFloorMs` of wall
 *                  clock has passed since it was mined. The pace monitor applies.
 *   checkpoint     authority chains (Ferminux after the Clique fork, where
 *                  difficulty is 1 or 2 per block and work means nothing). The
 *                  signed checkpoint registry is the SOLE finality source: a
 *                  transfer is signable only when its block is at or below the
 *                  latest multisig-attested checkpoint. The pace monitor applies.
 *
 * `confirmations` is a FLOOR under every mode and is never lowered by any of
 * them. A checkpoint registry, when configured, is enforced in every mode.
 */
export type FinalityMode = 'count' | 'work-and-time' | 'checkpoint';

export interface CheckpointConfig {
  /** CheckpointRegistry address on `registryChainId`. */
  registryAddress: string;
  /** The chain the registry lives on — the destination with real finality (BSC). */
  registryChainId: number;
  /** A checkpoint attested longer ago than this is stale and the validator refuses. */
  maxAgeMs: number;
}

export interface PaceConfig {
  /** Nominal block interval. */
  targetBlockTimeMs: number;
  /** Inter-block gaps sampled for the median. */
  window: number;
  /** DEGRADED when median gap > degradedFactor * targetBlockTimeMs. */
  degradedFactor: number;
  /** DEGRADED when the head is older than this — a stall, not just slow pace. */
  stallAfterMs: number;
}

export interface FinalityConfig {
  mode: FinalityMode;
  /** work-and-time only: total difficulty that must accumulate ABOVE the source block. */
  workThreshold: bigint;
  /** work-and-time only: wall clock that must pass after the source block's timestamp. */
  timeFloorMs: number;
  /** Longest header walk the monitor will do per transfer; older blocks are refused as unverifiable. */
  maxWalkBlocks: number;
  /** null in `count` mode without a registry. */
  pace: PaceConfig | null;
  checkpoint: CheckpointConfig | null;
}

export interface ChainConfig {
  name: string;
  chainId: number;
  /** Every URL is queried independently — they are a quorum, not a failover list. */
  rpcUrls: string[];
  /**
   * How many endpoints must independently show the SAME log before this node
   * will sign. Defaults to a majority of the configured PROVIDERS (see
   * independence.ts), never below 2 — one endpoint agreeing with itself is not
   * corroboration, it is the eclipse attack. Below 2 requires the insecure
   * acknowledgement.
   *
   * Config also refuses any set where one provider holds this many endpoints on
   * its own, so `agreed >= minAgreeingEndpoints` implies at least two operators
   * corroborated the log.
   */
  minAgreeingEndpoints: number;
  /** Budget for the per-cycle `eth_chainId` liveness probe on each endpoint. */
  rpcProbeTimeoutMs: number;
  bridgeAddress: string;
  /** Optional pin. If set, the live DOMAIN_SEPARATOR() must equal it or we stop. */
  domainSeparator: string | null;
  confirmations: number;
  /** If set, a block also has to be at or below this tag before it counts. */
  finalityTag: FinalityTag;
  pollIntervalMs: number;
  startBlock: number;
  /** eth_getLogs range chunk. Public RPCs cap this; 2000 is safe nearly everywhere. */
  maxBlockRange: number;
  enabled: boolean;
  gas: GasConfig;
  limits: ChainLimits;
  finality: FinalityConfig;
}

export interface PeerConfig {
  name: string;
  /** Base URL of a validator's HTTP API, e.g. http://10.0.0.7:8564 */
  url: string;
  /** Optional bearer token. Transport auth only — signatures self-authenticate. */
  token: string | null;
}

/** Per-IP token bucket for the HTTP surface. */
export interface RateLimitConfig {
  /** Bucket size: how many requests one client may make back to back. */
  burst: number;
  /** Sustained rate, requests per second per client. */
  refillPerSecond: number;
  /** Distinct client addresses tracked before the oldest are evicted. */
  maxClients: number;
}

/**
 * Deliberately awkward escape hatches. Each one turns off a defence that the
 * rest of this service is built around, so none of them is a bare boolean: the
 * operator has to write the acknowledgement sentence out, in the config file
 * that is checked in and reviewed, before any of them is honoured.
 */
export interface InsecureConfig {
  acknowledged: boolean;
  /**
   * Permit an enabled chain whose endpoint set fails the independence rules —
   * one endpoint, several aliases of one provider, or no spare provider to lose.
   * This is the devnet switch: one anvil per chain, and no eclipse detection at
   * all. It also turns off the DNS-backed startup check.
   */
  allowSingleRpcEndpoint: boolean;
  /** Permit validator.requireRpcQuorum = false. */
  allowPartialEndpointAgreement: boolean;
  /**
   * Permit an ENABLED chain that has no finality gadget (finalityTag null) to
   * run in plain `count` mode — no pace monitor, no checkpoint. A block count is
   * the primitive the 2026-08-21 stall proved wrong, so outside a devnet the
   * mode has to be spelled out: work-and-time or checkpoint.
   */
  allowCountFinalityWithoutGadget: boolean;
}

export const INSECURE_ACKNOWLEDGEMENT = 'I understand this disables eclipse protection';

export interface RelayerConfig {
  /** Free-form label that shows up in every log line and alert. */
  network: string;
  chains: ChainConfig[];
  http: { host: string; port: number; apiToken: string | null; rateLimit: RateLimitConfig; maxConnections: number };
  keystore: { path: string | null; passwordFile: string | null; expectedAddress: string | null };
  transport: { mode: 'http' | 'shared-dir' | 'both'; sharedDir: string | null; requestTimeoutMs: number };
  submitter: {
    peers: PeerConfig[];
    /** How long to keep collecting signatures before alerting on a stuck transfer. */
    signatureWaitMs: number;
    pollIntervalMs: number;
    /** Refuse to submit if the destination bridge reports itself paused. */
    skipWhenPaused: boolean;
  };
  validator: {
    /** Refuse to sign a transfer whose source block is older than this. 0 = no limit. */
    maxTransferAgeMs: number;
    /** With >1 RPC per chain, require ALL healthy endpoints to show the log. */
    requireRpcQuorum: boolean;
  };
  state: { path: string; driver: 'auto' | 'sqlite' | 'journal' };
  alerts: { webhookUrl: string | null; minSeverity: 'info' | 'warn' | 'critical'; throttleMs: number };
  /** Cross-endpoint agreement check interval. 0 disables (never do this in prod). */
  divergenceIntervalMs: number;
  log: { level: LogLevel; format: 'json' | 'text' };
  insecure: InsecureConfig;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export const DEFAULT_GAS: GasConfig = {
  maxFeePerGasGwei: 200,
  priorityFeeGwei: 1,
  baseFeeMultiplier: 2,
  gasLimitMultiplier: 1.3,
  gasLimitCap: 1_500_000,
  escalationPct: 25,
  maxAttempts: 4,
  receiptTimeoutMs: 180_000,
  txType: 2,
};

// --------------------------------------------------------------------- helpers

class ConfigError extends Error {}

function fail(path: string, message: string): never {
  throw new ConfigError(`config ${path}: ${message}`);
}

function str(o: Record<string, unknown>, key: string, path: string, fallback?: string): string {
  const v = o[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    fail(`${path}.${key}`, 'is required');
  }
  if (typeof v !== 'string') fail(`${path}.${key}`, 'must be a string');
  return v;
}

function int(o: Record<string, unknown>, key: string, path: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${key}`, 'must be a number');
  if (v < min || v > max) fail(`${path}.${key}`, `must be between ${min} and ${max}`);
  return v;
}

function bool(o: Record<string, unknown>, key: string, path: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
  return v;
}

function obj(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) fail(key, 'must be an object');
  return v as Record<string, unknown>;
}

function bigintStr(v: unknown, path: string): bigint {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) fail(path, 'amounts above 2^53 must be quoted strings');
    return BigInt(v);
  }
  if (typeof v !== 'string' || !/^\d+$/.test(v)) fail(path, 'must be a decimal string in the token\'s smallest unit');
  return BigInt(v);
}

function rejectUnknown(o: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(o)) {
    if (key.startsWith('_') || key.startsWith('$')) continue; // comments / $schema
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not a known setting (typo?)');
  }
}

function envList(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

// ------------------------------------------------------------------ chain load

function parseLimits(raw: Record<string, unknown>, path: string): ChainLimits {
  rejectUnknown(raw, ['default', 'tokens'], path);
  const def = obj(raw, 'default');
  const limit = (o: Record<string, unknown>, p: string): TokenLimit => {
    rejectUnknown(o, ['maxPerTransfer', 'dailyCap'], p);
    const maxPerTransfer = bigintStr(o.maxPerTransfer, `${p}.maxPerTransfer`);
    const dailyCap = bigintStr(o.dailyCap, `${p}.dailyCap`);
    if (maxPerTransfer <= 0n) fail(`${p}.maxPerTransfer`, 'must be > 0');
    if (dailyCap < maxPerTransfer) fail(`${p}.dailyCap`, 'must be >= maxPerTransfer');
    return { maxPerTransfer, dailyCap };
  };
  const tokensRaw = obj(raw, 'tokens');
  const tokens: Record<string, TokenLimit> = {};
  for (const [addr, v] of Object.entries(tokensRaw)) {
    if (!isAddress(addr)) fail(`${path}.tokens.${addr}`, 'is not an address');
    if (typeof v !== 'object' || v === null) fail(`${path}.tokens.${addr}`, 'must be an object');
    tokens[getAddress(addr).toLowerCase()] = limit(v as Record<string, unknown>, `${path}.tokens.${addr}`);
  }
  return {
    default: Object.keys(def).length > 0 ? limit(def, `${path}.default`) : { maxPerTransfer: 0n, dailyCap: 0n },
    tokens,
  };
}

function parseGas(raw: Record<string, unknown>, path: string): GasConfig {
  rejectUnknown(
    raw,
    ['maxFeePerGasGwei', 'priorityFeeGwei', 'baseFeeMultiplier', 'gasLimitMultiplier', 'gasLimitCap', 'escalationPct', 'maxAttempts', 'receiptTimeoutMs', 'txType'],
    path,
  );
  const txType = int(raw, 'txType', path, DEFAULT_GAS.txType, 0, 2);
  if (txType !== 0 && txType !== 2) fail(`${path}.txType`, 'must be 0 (legacy) or 2 (EIP-1559)');
  const gas: GasConfig = {
    maxFeePerGasGwei: int(raw, 'maxFeePerGasGwei', path, DEFAULT_GAS.maxFeePerGasGwei, 1),
    priorityFeeGwei: int(raw, 'priorityFeeGwei', path, DEFAULT_GAS.priorityFeeGwei, 0),
    baseFeeMultiplier: int(raw, 'baseFeeMultiplier', path, DEFAULT_GAS.baseFeeMultiplier, 1, 10),
    gasLimitMultiplier: (raw.gasLimitMultiplier as number | undefined) ?? DEFAULT_GAS.gasLimitMultiplier,
    gasLimitCap: int(raw, 'gasLimitCap', path, DEFAULT_GAS.gasLimitCap, 100_000),
    escalationPct: int(raw, 'escalationPct', path, DEFAULT_GAS.escalationPct, 10, 500),
    maxAttempts: int(raw, 'maxAttempts', path, DEFAULT_GAS.maxAttempts, 1, 20),
    receiptTimeoutMs: int(raw, 'receiptTimeoutMs', path, DEFAULT_GAS.receiptTimeoutMs, 5_000),
    txType: txType as 0 | 2,
  };
  if (typeof gas.gasLimitMultiplier !== 'number' || gas.gasLimitMultiplier < 1 || gas.gasLimitMultiplier > 5) {
    fail(`${path}.gasLimitMultiplier`, 'must be a number between 1 and 5');
  }
  return gas;
}

export const DEFAULT_PACE: PaceConfig = {
  targetBlockTimeMs: 7_000,
  window: 32,
  degradedFactor: 4,
  stallAfterMs: 300_000,
};

/**
 * The finality block. Absent means `count`, which is what every chain WITH a
 * finality gadget (finalityTag set) wants. A chain WITHOUT one — Ferminux — has
 * no such fallback: an enabled gadget-less chain must name work-and-time or
 * checkpoint, or startup fails, because a config file written before this
 * block existed would otherwise boot three validators with none of the
 * protection and no error. Anything else has to be spelled out, including the
 * numbers, because a default work threshold is a number nobody reasoned about.
 */
function parseFinality(
  raw: Record<string, unknown>,
  path: string,
  chainId: number,
  pollIntervalMs: number,
  enabled: boolean,
  finalityTag: FinalityTag,
  insecure: InsecureConfig,
): FinalityConfig {
  rejectUnknown(raw, ['mode', 'workThreshold', 'timeFloorMs', 'maxWalkBlocks', 'pace', 'checkpoint'], path);
  const mode = str(raw, 'mode', path, 'count');
  if (mode !== 'count' && mode !== 'work-and-time' && mode !== 'checkpoint') {
    fail(`${path}.mode`, 'must be "count", "work-and-time" or "checkpoint"');
  }
  if (enabled && finalityTag === null && mode === 'count' && !insecure.allowCountFinalityWithoutGadget) {
    fail(
      `${path}.mode`,
      `is "count" on an enabled chain with no finality gadget (finalityTag is null). A block count is the primitive that left the bridge on ` +
        `"Confirming 12/64" for hours during the 2026-08-21 stall and prices no reorg at all on an authority chain, so the mode must be explicit: ` +
        `set finality.mode to "work-and-time" (PoW) or "checkpoint" (authority chains) — see the ferminux row of config/chains.example.json. ` +
        `For a local devnet ONLY, set insecure.allowCountFinalityWithoutGadget together with insecure.acknowledgement = "${INSECURE_ACKNOWLEDGEMENT}"`,
    );
  }

  const ckRaw = obj(raw, 'checkpoint');
  let checkpoint: CheckpointConfig | null = null;
  if (Object.keys(ckRaw).length > 0) {
    rejectUnknown(ckRaw, ['registryAddress', 'registryChainId', 'maxAgeMs'], `${path}.checkpoint`);
    const addr = str(ckRaw, 'registryAddress', `${path}.checkpoint`, '');
    // Same rule as bridgeAddress: a disabled chain may hold an empty placeholder
    // (the shipped example does, until the registry is deployed); switching the
    // chain on without filling it in is a startup failure, not a silent skip.
    if (!addr && !enabled) {
      // placeholder — nothing reads a disabled chain
    } else if (!addr || !isAddress(addr) || getAddress(addr) === ZERO) {
      fail(`${path}.checkpoint.registryAddress`, 'must be the CheckpointRegistry address on the registry chain before this chain can be enabled');
    }
    const registryChainId = int(ckRaw, 'registryChainId', `${path}.checkpoint`, 0, 1);
    if (registryChainId === 0) fail(`${path}.checkpoint.registryChainId`, 'is required');
    if (registryChainId === chainId) {
      fail(
        `${path}.checkpoint.registryChainId`,
        'must be a DIFFERENT chain: a checkpoint stored on the chain it attests reorgs away together with the history it was meant to pin',
      );
    }
    checkpoint = {
      registryAddress: addr ? getAddress(addr) : ZERO,
      registryChainId,
      // 6h default; long enough for an operator to publish once per shift, short
      // enough that a registry nobody feeds stops the bridge the same day.
      maxAgeMs: int(ckRaw, 'maxAgeMs', `${path}.checkpoint`, 21_600_000, 60_000),
    };
  }
  if (mode === 'checkpoint' && checkpoint === null) {
    fail(`${path}.checkpoint`, 'is required in "checkpoint" mode — the registry is the only finality source there');
  }

  const paceRaw = obj(raw, 'pace');
  rejectUnknown(paceRaw, ['targetBlockTimeMs', 'window', 'degradedFactor', 'stallAfterMs'], `${path}.pace`);
  const needsPace = mode !== 'count' || checkpoint !== null;
  if (!needsPace && Object.keys(paceRaw).length > 0) {
    fail(`${path}.pace`, 'has no effect in "count" mode without a checkpoint registry — remove it or pick a mode');
  }
  const pace: PaceConfig | null = needsPace
    ? {
        targetBlockTimeMs: int(paceRaw, 'targetBlockTimeMs', `${path}.pace`, DEFAULT_PACE.targetBlockTimeMs, 100),
        window: int(paceRaw, 'window', `${path}.pace`, DEFAULT_PACE.window, 4, 1_024),
        degradedFactor: int(paceRaw, 'degradedFactor', `${path}.pace`, DEFAULT_PACE.degradedFactor, 2, 100),
        stallAfterMs: int(paceRaw, 'stallAfterMs', `${path}.pace`, DEFAULT_PACE.stallAfterMs, 1_000),
      }
    : null;
  if (pace && pace.stallAfterMs < pace.targetBlockTimeMs * pace.degradedFactor) {
    fail(`${path}.pace.stallAfterMs`, 'must be at least targetBlockTimeMs * degradedFactor, or an ordinary slow block reads as a stall');
  }
  if (pace && pace.stallAfterMs < pollIntervalMs * 2) {
    fail(`${path}.pace.stallAfterMs`, 'must be at least twice pollIntervalMs');
  }

  let workThreshold = 0n;
  let timeFloorMs = 0;
  if (mode === 'work-and-time') {
    if (raw.workThreshold === undefined || raw.workThreshold === null) {
      fail(`${path}.workThreshold`, 'is required in "work-and-time" mode: the total difficulty that must accumulate above a source block (read recent blocks with eth_getBlockByNumber and multiply)');
    }
    workThreshold = bigintStr(raw.workThreshold, `${path}.workThreshold`);
    if (workThreshold <= 0n) fail(`${path}.workThreshold`, 'must be > 0');
    timeFloorMs = int(raw, 'timeFloorMs', path, -1, 0);
    if (timeFloorMs < 0) fail(`${path}.timeFloorMs`, 'is required in "work-and-time" mode');
    if (timeFloorMs === 0) fail(`${path}.timeFloorMs`, 'must be > 0 — work without a clock lets a burst of rented hashrate confirm instantly');
  } else if (raw.workThreshold !== undefined || raw.timeFloorMs !== undefined) {
    fail(`${path}.workThreshold`, `only applies in "work-and-time" mode (mode is "${mode}")`);
  }

  return {
    mode,
    workThreshold,
    timeFloorMs,
    maxWalkBlocks: int(raw, 'maxWalkBlocks', path, 4_096, 16, 1_000_000),
    pace,
    checkpoint,
  };
}

function parseChain(raw: unknown, index: number, insecure: InsecureConfig): ChainConfig {
  const path = `chains[${index}]`;
  if (typeof raw !== 'object' || raw === null) fail(path, 'must be an object');
  const o = raw as Record<string, unknown>;
  rejectUnknown(
    o,
    [
      'name',
      'chainId',
      'rpcUrls',
      'minAgreeingEndpoints',
      'rpcProbeTimeoutMs',
      'bridgeAddress',
      'domainSeparator',
      'confirmations',
      'finalityTag',
      'pollIntervalMs',
      'startBlock',
      'maxBlockRange',
      'enabled',
      'gas',
      'limits',
      'finality',
      'notes',
    ],
    path,
  );

  const chainId = int(o, 'chainId', path, 0, 1);
  if (chainId === 0) fail(`${path}.chainId`, 'is required and must be > 0');

  const rpcFromEnv = envList(`FMX_RELAYER_RPC_${chainId}`);
  const rpcUrls = rpcFromEnv ?? (Array.isArray(o.rpcUrls) ? (o.rpcUrls as unknown[]) : fail(`${path}.rpcUrls`, 'must be an array'));
  const urls = rpcUrls.map((u, i) => {
    if (typeof u !== 'string' || !/^https?:\/\//.test(u)) fail(`${path}.rpcUrls[${i}]`, 'must be an http(s) URL');
    return u.replace(/\/+$/, '');
  });

  const enabledFlag = bool(o, 'enabled', path, true);
  const bridgeEnv = process.env[`FMX_RELAYER_BRIDGE_${chainId}`];
  const bridgeRaw = bridgeEnv ?? str(o, 'bridgeAddress', path, '');
  // A chain that is switched off may carry an empty address — that is how the
  // shipped example holds a slot for a chain the bridge is not deployed on yet.
  // Enabling it without filling the address in is a startup failure.
  if (!bridgeRaw && !enabledFlag) {
    // placeholder, never used: nothing reads a disabled chain
  } else if (!bridgeRaw || !isAddress(bridgeRaw)) {
    fail(`${path}.bridgeAddress`, 'must be a valid address before this chain can be enabled');
  } else if (getAddress(bridgeRaw) === ZERO) {
    fail(`${path}.bridgeAddress`, 'must not be the zero address');
  }
  const bridgeAddress = bridgeRaw && isAddress(bridgeRaw) ? getAddress(bridgeRaw) : ZERO;

  const finalityRaw = o.finalityTag;
  let finalityTag: FinalityTag = null;
  if (finalityRaw !== undefined && finalityRaw !== null) {
    if (finalityRaw !== 'finalized' && finalityRaw !== 'safe') {
      fail(`${path}.finalityTag`, 'must be "finalized", "safe" or null');
    }
    finalityTag = finalityRaw;
  }

  const domainSeparatorRaw = o.domainSeparator;
  let domainSeparator: string | null = null;
  if (domainSeparatorRaw !== undefined && domainSeparatorRaw !== null && domainSeparatorRaw !== '') {
    if (typeof domainSeparatorRaw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(domainSeparatorRaw)) {
      fail(`${path}.domainSeparator`, 'must be a 32-byte hex string');
    }
    domainSeparator = domainSeparatorRaw.toLowerCase();
  }

  const enabled = enabledFlag;
  const confirmations = int(o, 'confirmations', path, -1, 0);
  if (enabled && confirmations < 0) fail(`${path}.confirmations`, 'is required — see the reorg table in the README');
  if (enabled && confirmations === 0 && finalityTag === null) {
    fail(`${path}.confirmations`, 'must be > 0 unless finalityTag is set — zero-confirmation bridging is theft with extra steps');
  }
  if (enabled && urls.length === 0) fail(`${path}.rpcUrls`, 'needs at least one endpoint');

  // ---- independent endpoints ------------------------------------------------
  // A validator with one source of truth signs whatever that source says, and
  // manufacturing what a single source says is exactly what an eclipse attack
  // is. The count that matters is therefore not hostname strings — 127.0.0.1
  // and localhost are two strings and one node — but PROVIDERS: loopback
  // aliases collapse, and two names under one registrable domain are one
  // operator with one outage and one abuse desk. See independence.ts; the
  // remaining half of the question (do these names resolve to the same box?)
  // needs DNS and runs in checkEndpointIndependence() at startup.
  const providers = groupEndpoints(identify(urls));

  // ---- how many must AGREE before this node signs ---------------------------
  // A majority of the PROVIDERS, never below 2. Counting URLs here would let one
  // operator's two endpoints carry the floor between them.
  const autoMinAgree = autoMinAgreeing(providers.length, urls.length);
  const minAgreeRaw = int(o, 'minAgreeingEndpoints', path, 0, 0, 64);
  const minAgreeingEndpoints = minAgreeRaw > 0 ? minAgreeRaw : autoMinAgree;
  if (enabled) {
    if (minAgreeingEndpoints > urls.length) {
      fail(
        `${path}.minAgreeingEndpoints`,
        `is ${minAgreeingEndpoints} but only ${urls.length} endpoint(s) are configured — this chain could never confirm anything`,
      );
    }
    // Independence before the floor: when a set collapses to one provider the
    // useful sentence is "these are the same node", not a remark about a number
    // the operator never chose.
    if (!insecure.allowSingleRpcEndpoint) {
      const problems = independenceProblems({ urls, minAgreeingEndpoints, groups: providers });
      if (problems.length > 0) {
        fail(
          `${path}.rpcUrls`,
          `${problems.join('. ')}. Independence is what the whole design rests on — fix the endpoint set, or, for a ` +
            'local devnet ONLY, set insecure.allowSingleRpcEndpoint together with ' +
            `insecure.acknowledgement = "${INSECURE_ACKNOWLEDGEMENT}"`,
        );
      }
    }
    if (minAgreeingEndpoints < 2 && !insecure.allowSingleRpcEndpoint) {
      fail(
        `${path}.minAgreeingEndpoints`,
        'must be at least 2: confirming a transfer from a single endpoint is the eclipse attack this service exists to refuse',
      );
    }
  }

  const pollIntervalMs = int(o, 'pollIntervalMs', path, 5_000, 500);
  return {
    name: str(o, 'name', path, `chain-${chainId}`),
    chainId,
    rpcUrls: urls,
    minAgreeingEndpoints,
    rpcProbeTimeoutMs: int(o, 'rpcProbeTimeoutMs', path, 5_000, 250, 60_000),
    bridgeAddress,
    domainSeparator,
    confirmations: Math.max(confirmations, 0),
    finalityTag,
    pollIntervalMs,
    startBlock: int(o, 'startBlock', path, 0, 0),
    maxBlockRange: int(o, 'maxBlockRange', path, 2_000, 1, 100_000),
    enabled,
    gas: parseGas(obj(o, 'gas'), `${path}.gas`),
    limits: parseLimits(obj(o, 'limits'), `${path}.limits`),
    finality: parseFinality(obj(o, 'finality'), `${path}.finality`, chainId, pollIntervalMs, enabled, finalityTag, insecure),
  };
}

// ------------------------------------------------------------------- top level

/**
 * The escape hatches. Every flag here removes a defence, so a bare `true` is
 * not enough: `acknowledgement` must be the exact sentence. A boolean can be
 * flipped by someone who does not know what it does; a sentence cannot be
 * typed by accident, and it survives in the config file for the next reviewer
 * to find.
 */
function parseInsecure(raw: Record<string, unknown>): InsecureConfig {
  rejectUnknown(raw, ['acknowledgement', 'allowSingleRpcEndpoint', 'allowPartialEndpointAgreement', 'allowCountFinalityWithoutGadget'], 'insecure');
  const ackRaw = raw.acknowledgement;
  const acknowledged = ackRaw === INSECURE_ACKNOWLEDGEMENT;
  if (ackRaw !== undefined && ackRaw !== null && ackRaw !== '' && !acknowledged) {
    fail('insecure.acknowledgement', `must be exactly "${INSECURE_ACKNOWLEDGEMENT}" (or absent)`);
  }
  const wanted = {
    allowSingleRpcEndpoint: bool(raw, 'allowSingleRpcEndpoint', 'insecure', false),
    allowPartialEndpointAgreement: bool(raw, 'allowPartialEndpointAgreement', 'insecure', false),
    allowCountFinalityWithoutGadget: bool(raw, 'allowCountFinalityWithoutGadget', 'insecure', false),
  };
  for (const [key, value] of Object.entries(wanted)) {
    if (value && !acknowledged) {
      fail(
        `insecure.${key}`,
        `is set but insecure.acknowledgement is not "${INSECURE_ACKNOWLEDGEMENT}". ` +
          'This switch removes a defence the rest of the relayer depends on; say so explicitly or do not set it',
      );
    }
  }
  return { acknowledged, ...wanted };
}

/** Bind addresses that are only reachable from the machine itself. */
function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
}

export function parseConfig(rawText: string, configPath: string): RelayerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new ConfigError(`config ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`config ${configPath} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  rejectUnknown(
    o,
    ['network', 'chains', 'http', 'keystore', 'transport', 'submitter', 'validator', 'state', 'alerts', 'divergenceIntervalMs', 'log', 'insecure', 'notes'],
    'root',
  );

  // Parsed FIRST: the chain validation below asks it whether the deliberately
  // unsafe shapes are permitted.
  const insecure = parseInsecure(obj(o, 'insecure'));

  const chainsRaw = o.chains;
  if (!Array.isArray(chainsRaw) || chainsRaw.length === 0) fail('chains', 'must be a non-empty array');
  const chains = chainsRaw.map((c, i) => parseChain(c, i, insecure));
  const seen = new Set<number>();
  for (const c of chains) {
    if (seen.has(c.chainId)) fail('chains', `duplicate chainId ${c.chainId}`);
    seen.add(c.chainId);
  }
  // A registry on a chain this node does not watch is a registry this node
  // cannot read through a quorum, and "cannot read" is a refusal at sign time.
  // Say so now, before a validator starts and silently signs nothing.
  for (const c of chains) {
    const ck = c.finality.checkpoint;
    if (!c.enabled || !ck) continue;
    const reg = chains.find((r) => r.chainId === ck.registryChainId);
    if (!reg || !reg.enabled) {
      fail(
        `chains[${chains.indexOf(c)}].finality.checkpoint.registryChainId`,
        `is ${ck.registryChainId}, which is not an enabled chain in this config — the registry is read through that chain's RPC quorum`,
      );
    }
  }
  // NOTE: "at least two chains enabled" is enforced in RelayerService, not here,
  // so that `--role check` can be run against a config whose remote side is not
  // deployed yet (the shipped example is exactly that).

  const base = dirname(resolve(configPath));
  const rel = (p: string): string => (isAbsolute(p) ? p : resolve(base, p));

  const httpRaw = obj(o, 'http');
  rejectUnknown(httpRaw, ['host', 'port', 'apiToken', 'rateLimit', 'maxConnections'], 'http');
  const keystoreRaw = obj(o, 'keystore');
  rejectUnknown(keystoreRaw, ['path', 'passwordFile', 'expectedAddress'], 'keystore');
  const transportRaw = obj(o, 'transport');
  rejectUnknown(transportRaw, ['mode', 'sharedDir', 'requestTimeoutMs'], 'transport');
  const submitterRaw = obj(o, 'submitter');
  rejectUnknown(submitterRaw, ['peers', 'signatureWaitMs', 'pollIntervalMs', 'skipWhenPaused'], 'submitter');
  const validatorRaw = obj(o, 'validator');
  rejectUnknown(validatorRaw, ['maxTransferAgeMs', 'requireRpcQuorum'], 'validator');
  const stateRaw = obj(o, 'state');
  rejectUnknown(stateRaw, ['path', 'driver'], 'state');
  const alertsRaw = obj(o, 'alerts');
  rejectUnknown(alertsRaw, ['webhookUrl', 'minSeverity', 'throttleMs'], 'alerts');
  const logRaw = obj(o, 'log');
  rejectUnknown(logRaw, ['level', 'format'], 'log');

  const mode = str(transportRaw, 'mode', 'transport', 'http');
  if (mode !== 'http' && mode !== 'shared-dir' && mode !== 'both') {
    fail('transport.mode', 'must be "http", "shared-dir" or "both"');
  }
  const sharedDirRaw = process.env.FMX_RELAYER_SHARED_DIR ?? (transportRaw.sharedDir as string | undefined) ?? null;
  if ((mode === 'shared-dir' || mode === 'both') && !sharedDirRaw) {
    fail('transport.sharedDir', 'is required when transport.mode includes shared-dir');
  }

  const peersRaw = Array.isArray(submitterRaw.peers) ? (submitterRaw.peers as unknown[]) : [];
  const peersFromEnv = envList('FMX_RELAYER_PEERS');
  const peers: PeerConfig[] = peersFromEnv
    ? peersFromEnv.map((url, i) => ({ name: `peer${i + 1}`, url: url.replace(/\/+$/, ''), token: null }))
    : peersRaw.map((p, i) => {
        if (typeof p !== 'object' || p === null) fail(`submitter.peers[${i}]`, 'must be an object');
        const po = p as Record<string, unknown>;
        rejectUnknown(po, ['name', 'url', 'token'], `submitter.peers[${i}]`);
        const url = str(po, 'url', `submitter.peers[${i}]`);
        if (!/^https?:\/\//.test(url)) fail(`submitter.peers[${i}].url`, 'must be an http(s) URL');
        return {
          name: str(po, 'name', `submitter.peers[${i}]`, `peer${i + 1}`),
          url: url.replace(/\/+$/, ''),
          token: (po.token as string | undefined) ?? null,
        };
      });

  const severity = str(alertsRaw, 'minSeverity', 'alerts', 'warn');
  if (severity !== 'info' && severity !== 'warn' && severity !== 'critical') {
    fail('alerts.minSeverity', 'must be "info", "warn" or "critical"');
  }
  const driver = str(stateRaw, 'driver', 'state', 'auto');
  if (driver !== 'auto' && driver !== 'sqlite' && driver !== 'journal') {
    fail('state.driver', 'must be "auto", "sqlite" or "journal"');
  }
  const level = str(logRaw, 'level', 'log', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) fail('log.level', 'must be debug|info|warn|error');
  const format = str(logRaw, 'format', 'log', 'json');
  if (format !== 'json' && format !== 'text') fail('log.format', 'must be "json" or "text"');

  const expectedAddress = (process.env.FMX_RELAYER_ADDRESS ?? (keystoreRaw.expectedAddress as string | undefined)) || null;
  if (expectedAddress && !isAddress(expectedAddress)) fail('keystore.expectedAddress', 'must be an address');

  // ---- HTTP surface ---------------------------------------------------------
  // /status and /transfers describe every transfer in flight — who sent what to
  // whom, and how far along it is. An empty token means no authentication at
  // all, which is survivable on loopback and is an open door on any other
  // interface, so that combination does not start.
  const httpHost = process.env.FMX_RELAYER_HTTP_HOST ?? str(httpRaw, 'host', 'http', '127.0.0.1');
  const apiTokenRaw = process.env.FMX_RELAYER_API_TOKEN ?? (httpRaw.apiToken as string | undefined) ?? null;
  const apiToken = apiTokenRaw !== null && apiTokenRaw.trim() !== '' ? apiTokenRaw.trim() : null;
  if (apiToken !== null && apiToken.length < 16) {
    fail('http.apiToken', 'must be at least 16 characters — generate one with: openssl rand -hex 32');
  }
  // A template value that PASSES validation is worse than an empty one: it
  // looks configured. The shipped env files carry an obvious placeholder, and
  // this is what stops it reaching production.
  if (apiToken !== null && /replace[_-]?me|change[_-]?me|your[_-]?token|example|secret|password/i.test(apiToken)) {
    fail(
      'http.apiToken',
      'looks like a placeholder from an env template, not a generated secret. Run: openssl rand -hex 32',
    );
  }
  if (apiToken === null && !isLoopbackBind(httpHost)) {
    fail(
      'http.apiToken',
      `is empty while http.host is "${httpHost}", which is reachable from the network. /status, /metrics, /signatures ` +
        'and /transfers would be served to anyone who can reach the port. Set http.apiToken (or FMX_RELAYER_API_TOKEN) ' +
        'to a random 32-byte hex string, or bind 127.0.0.1',
    );
  }

  const rateLimitRaw = obj(httpRaw, 'rateLimit');
  rejectUnknown(rateLimitRaw, ['burst', 'refillPerSecond', 'maxClients'], 'http.rateLimit');
  const rateLimit: RateLimitConfig = {
    burst: int(rateLimitRaw, 'burst', 'http.rateLimit', 60, 1, 100_000),
    refillPerSecond: int(rateLimitRaw, 'refillPerSecond', 'http.rateLimit', 10, 1, 100_000),
    maxClients: int(rateLimitRaw, 'maxClients', 'http.rateLimit', 4_096, 16, 1_000_000),
  };

  // ---- validator agreement policy -------------------------------------------
  const requireRpcQuorum = bool(validatorRaw, 'requireRpcQuorum', 'validator', true);
  if (!requireRpcQuorum && !insecure.allowPartialEndpointAgreement) {
    fail(
      'validator.requireRpcQuorum',
      'false lets this node attest while some of its endpoints are unreachable. The per-chain minAgreeingEndpoints ' +
        'floor still applies, so this is no longer a one-node decision — but it is still weaker than the design ' +
        `intends. Set insecure.allowPartialEndpointAgreement with insecure.acknowledgement = "${INSECURE_ACKNOWLEDGEMENT}" ` +
        'if that is genuinely what you want',
    );
  }

  return {
    network: str(o, 'network', 'root', 'ferminux-bridge'),
    chains,
    http: {
      host: httpHost,
      port: Number(process.env.FMX_RELAYER_HTTP_PORT ?? int(httpRaw, 'port', 'http', 8564, 0, 65535)),
      apiToken,
      rateLimit,
      maxConnections: int(httpRaw, 'maxConnections', 'http', 256, 8, 65_536),
    },
    keystore: {
      path: (process.env.FMX_RELAYER_KEYSTORE ?? (keystoreRaw.path as string | undefined) ?? null) as string | null,
      passwordFile: (process.env.FMX_RELAYER_PASSWORD_FILE ?? (keystoreRaw.passwordFile as string | undefined) ?? null) as string | null,
      expectedAddress: expectedAddress ? getAddress(expectedAddress) : null,
    },
    transport: {
      mode: (process.env.FMX_RELAYER_TRANSPORT as 'http' | 'shared-dir' | 'both' | undefined) ?? mode,
      sharedDir: sharedDirRaw ? rel(sharedDirRaw) : null,
      requestTimeoutMs: int(transportRaw, 'requestTimeoutMs', 'transport', 8_000, 500),
    },
    submitter: {
      peers,
      signatureWaitMs: int(submitterRaw, 'signatureWaitMs', 'submitter', 900_000, 1_000),
      pollIntervalMs: int(submitterRaw, 'pollIntervalMs', 'submitter', 5_000, 250),
      skipWhenPaused: bool(submitterRaw, 'skipWhenPaused', 'submitter', true),
    },
    validator: {
      maxTransferAgeMs: int(validatorRaw, 'maxTransferAgeMs', 'validator', 0, 0),
      requireRpcQuorum,
    },
    state: {
      path: rel(process.env.FMX_RELAYER_STATE ?? str(stateRaw, 'path', 'state', './state/relayer.db')),
      driver: driver as 'auto' | 'sqlite' | 'journal',
    },
    alerts: {
      webhookUrl: process.env.FMX_RELAYER_ALERT_WEBHOOK ?? (alertsRaw.webhookUrl as string | undefined) ?? null,
      minSeverity: severity as 'info' | 'warn' | 'critical',
      throttleMs: int(alertsRaw, 'throttleMs', 'alerts', 60_000, 0),
    },
    divergenceIntervalMs: int(o, 'divergenceIntervalMs', 'root', 60_000, 0),
    log: {
      level: (process.env.FMX_RELAYER_LOG_LEVEL as LogLevel | undefined) ?? (level as LogLevel),
      format: (process.env.FMX_RELAYER_LOG_FORMAT as 'json' | 'text' | undefined) ?? (format as 'json' | 'text'),
    },
    insecure,
  };
}

export function loadConfig(configPath: string): RelayerConfig {
  const resolved = resolve(configPath);
  return parseConfig(readFileSync(resolved, 'utf8'), resolved);
}

/** Look up the chain entry for a chain id, or undefined if not configured. */
export function chainById(cfg: RelayerConfig, chainId: number): ChainConfig | undefined {
  return cfg.chains.find((c) => c.chainId === chainId);
}

/** Effective per-token limit on a chain, falling back to the chain default. */
export function limitFor(chain: ChainConfig, token: string): TokenLimit {
  return chain.limits.tokens[token.toLowerCase()] ?? chain.limits.default;
}

export { ConfigError, ZERO as ZERO_ADDRESS };
