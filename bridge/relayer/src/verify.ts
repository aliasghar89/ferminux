// Independent verification. This is the file that decides whether a key signs.
//
// The rule the whole design rests on: a validator attests ONLY to what it has
// itself observed on a chain it is configured for, at a depth it considers
// settled, against a bridge address it has pinned. It never signs because a peer
// asked it to, never signs a transfer it cannot re-read, and never signs a
// digest it did not compute locally.
//
// Every check below is a refusal, not a warning. If you find yourself wanting to
// downgrade one to a log line, you are removing the reason this service exists.

import { getAddress } from 'ethers';
import { TOKEN_KIND_UNREGISTERED, type OnChainTokenConfig } from './abi.ts';
import type { ChainClient } from './chain.ts';
import { limitFor, type RelayerConfig } from './config.ts';
import type { StoredTransfer } from './db.ts';
import { needsFinalityMonitor, type FinalityMonitor } from './finality.ts';
import { VolumeLimiter, windowKey } from './limits.ts';
import { digestFor, domainSeparatorFor, transferIdOf } from './transfer.ts';
import type { Alerter } from './alerts.ts';
import type { Logger } from './logger.ts';

export type RefusalCode =
  | 'not_confirmed'
  | 'src_chain_unconfigured'
  | 'dst_chain_unconfigured'
  | 'same_chain'
  | 'transfer_id_mismatch'
  | 'digest_mismatch'
  | 'domain_mismatch'
  | 'already_processed'
  | 'dst_token_unregistered'
  | 'dst_token_paused'
  | 'route_mismatch'
  | 'over_contract_cap'
  | 'over_local_per_transfer_cap'
  | 'over_local_daily_cap'
  | 'too_old'
  | 'bridge_paused'
  | 'rpc_error'
  // finality.ts — the source block is not settled enough, or cannot be shown to be
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

/** Refusals that describe the source chain's state rather than the transfer. All retryable. */
export const FINALITY_CODES: RefusalCode[] = [
  'not_final',
  'pace_degraded',
  'pace_unknown',
  'checkpoint_unavailable',
  'checkpoint_missing',
  'checkpoint_stale',
  'checkpoint_behind',
  'checkpoint_mismatch',
  'src_block_reorged',
  'finality_unverifiable',
];

/**
 * The 24h capacity a passing verification consumed, so the caller can hand it
 * back if it then decides not to sign. Consumption happens BEFORE signing on
 * purpose — a crash in between must lose capacity, not safety — but every path
 * that abandons the signature afterwards has to release it, or the validator
 * slowly starves itself of its own budget and refuses legitimate transfers.
 */
export interface ConsumedCapacity {
  outKey: string;
  inKey: string;
  amount: bigint;
}

export interface VerifyResult {
  ok: boolean;
  code: RefusalCode | null;
  reason: string | null;
  /** The digest this node computed locally. Only set when ok. */
  digest: string | null;
  /** Present when the destination reports the transfer already executed. */
  alreadyProcessed: boolean;
  /** Set only when this call durably consumed capacity. See releaseCapacity(). */
  consumed: ConsumedCapacity | null;
}

/** Give back what verifyForSigning consumed. Idempotent per result object. */
export function releaseCapacity(ctx: VerifyContext, consumed: ConsumedCapacity | null): void {
  if (!consumed) return;
  ctx.limiter.release(consumed.outKey, consumed.amount);
  ctx.limiter.release(consumed.inKey, consumed.amount);
  ctx.log.info('released 24h capacity for an abandoned signature', {
    outKey: consumed.outKey,
    inKey: consumed.inKey,
    amount: consumed.amount.toString(),
  });
}

export interface VerifyContext {
  cfg: RelayerConfig;
  chains: Map<number, ChainClient>;
  limiter: VolumeLimiter;
  alerts: Alerter;
  log: Logger;
  /**
   * Per-source-chain finality monitors (finality.ts). A chain whose config calls
   * for one (needsFinalityMonitor) but has none here is REFUSED, not waved
   * through: the absence of the check is not the passing of the check.
   */
  finality?: Map<number, FinalityMonitor>;
}

function refuse(code: RefusalCode, reason: string, alreadyProcessed = false): VerifyResult {
  return { ok: false, code, reason, digest: null, alreadyProcessed, consumed: null };
}

/**
 * Full pre-signature verification.
 *
 * @param consumeCaps when true (the validator's real path) a passing transfer
 *        consumes local 24h capacity durably. Pass false for dry-run checks
 *        (`--role check`, the HTTP /verify probe) so inspection cannot eat
 *        capacity that a real transfer then needs.
 */
export async function verifyForSigning(
  ctx: VerifyContext,
  stored: StoredTransfer,
  consumeCaps = true,
): Promise<VerifyResult> {
  const t = stored.transfer;

  if (stored.status !== 'confirmed') {
    return refuse('not_confirmed', `transfer status is "${stored.status}", not "confirmed"`);
  }

  // ---- 1. both ends must be chains THIS node is configured for -------------
  const src = ctx.chains.get(t.srcChainId);
  if (!src || !src.config.enabled) {
    return refuse('src_chain_unconfigured', `source chain ${t.srcChainId} is not configured on this validator`);
  }
  const dst = ctx.chains.get(t.dstChainId);
  if (!dst || !dst.config.enabled) {
    return refuse('dst_chain_unconfigured', `destination chain ${t.dstChainId} is not configured on this validator`);
  }
  if (t.srcChainId === t.dstChainId) return refuse('same_chain', 'src and dst chain ids are equal');

  // ---- 2. the id must be OURS, recomputed from the fields ------------------
  const recomputed = transferIdOf(t);
  if (recomputed.toLowerCase() !== stored.transferId.toLowerCase()) {
    ctx.alerts.fire({
      kind: 'signature_mismatch',
      severity: 'critical',
      message: 'stored transfer id does not match a local recompute',
      key: `idmismatch:${stored.transferId}`,
      fields: { transferId: stored.transferId, recomputed },
    });
    return refuse('transfer_id_mismatch', `recomputed id ${recomputed} != ${stored.transferId}`);
  }

  // ---- 2b. the SOURCE block must be final by the source chain's own rule ---
  // `confirmations` got it to 'confirmed'; that is the floor, not the line. On
  // a chain configured for work-and-time or checkpoint finality the monitor
  // has the last word, and "no monitor" is a refusal, never a pass.
  if (needsFinalityMonitor(src.config.finality)) {
    const monitor = ctx.finality?.get(src.chainId);
    if (!monitor) {
      return refuse('finality_unverifiable', `source chain ${src.name} requires ${src.config.finality.mode} finality but this node has no finality monitor for it`);
    }
    const maxReportAge = Math.max(src.config.pollIntervalMs, 1_000);
    let verdict;
    try {
      verdict = await monitor.assess({ srcBlockNumber: stored.srcBlockNumber, srcBlockHash: stored.srcBlockHash }, maxReportAge);
    } catch (err) {
      return refuse('finality_unverifiable', `finality check threw: ${(err as Error).message}`);
    }
    if (!verdict.ok) return refuse(verdict.code ?? 'finality_unverifiable', verdict.reason ?? 'source block is not final');
  }

  // ---- 3. age ------------------------------------------------------------
  if (ctx.cfg.validator.maxTransferAgeMs > 0) {
    const age = Date.now() - stored.firstSeenAt;
    if (age > ctx.cfg.validator.maxTransferAgeMs) {
      return refuse('too_old', `first seen ${Math.round(age / 1000)}s ago, limit ${Math.round(ctx.cfg.validator.maxTransferAgeMs / 1000)}s`);
    }
  }

  // ---- 4. the destination bridge must be the deployment we think it is -----
  const expectedDomain = domainSeparatorFor(t.dstChainId, dst.config.bridgeAddress);
  const domain = await dst.verifyDomainSeparator(expectedDomain);
  if (!domain.ok) {
    ctx.alerts.fire({
      kind: 'domain_mismatch',
      severity: 'critical',
      message: 'destination bridge EIP-712 domain separator does not match — wrong address, wrong chain, or an impostor contract',
      key: `domain:${t.dstChainId}:${dst.config.bridgeAddress}`,
      fields: { dstChainId: t.dstChainId, bridge: dst.config.bridgeAddress, expected: expectedDomain, onChain: domain.onChain, reason: domain.reason },
    });
    return refuse('domain_mismatch', domain.reason ?? 'domain separator mismatch');
  }

  // ---- 5. destination-side state ------------------------------------------
  let processed: boolean;
  let paused: boolean;
  let cfgOnChain: OnChainTokenConfig;
  let onChainDigest: string;
  try {
    const bridge = dst.bridge();
    const tuple = [t.srcChainId, t.dstChainId, t.nonce, t.srcToken, t.dstToken, t.sender, t.recipient, t.amount];
    [processed, paused, cfgOnChain, onChainDigest] = await Promise.all([
      bridge.processed(stored.transferId) as Promise<boolean>,
      bridge.paused() as Promise<boolean>,
      // Decoded from the return data, not through a fragment — see
      // ChainClient.readTokenConfig(). A registry whose shape has moved must say
      // so, not quietly answer with six of seven words.
      dst.readTokenConfig(t.dstToken),
      bridge.hashTransfer(tuple) as Promise<string>,
    ]);
  } catch (err) {
    return refuse('rpc_error', `destination read failed: ${(err as Error).message}`);
  }

  if (processed) {
    return { ok: false, code: 'already_processed', reason: 'destination already executed this transfer', digest: null, alreadyProcessed: true, consumed: null };
  }
  if (paused) return refuse('bridge_paused', 'destination bridge is paused');

  if (Number(cfgOnChain.kind) === TOKEN_KIND_UNREGISTERED) {
    return refuse('dst_token_unregistered', `destination token ${t.dstToken} is not registered on the destination bridge`);
  }
  if (cfgOnChain.paused) return refuse('dst_token_paused', `destination token ${t.dstToken} is paused`);
  if (Number(cfgOnChain.remoteChainId) !== t.srcChainId) {
    return refuse('route_mismatch', `destination registry says remoteChainId ${cfgOnChain.remoteChainId}, transfer says ${t.srcChainId}`);
  }
  if (getAddress(cfgOnChain.remoteToken) !== getAddress(t.srcToken)) {
    return refuse('route_mismatch', `destination registry says remoteToken ${cfgOnChain.remoteToken}, transfer says ${t.srcToken}`);
  }
  if (t.amount > cfgOnChain.maxPerTransfer) {
    return refuse('over_contract_cap', `amount ${t.amount} exceeds the destination contract's maxPerTransfer ${cfgOnChain.maxPerTransfer}`);
  }

  // ---- 6. the digest: computed locally, cross-checked against the contract --
  const digest = digestFor(t, dst.config.bridgeAddress);
  if (digest.toLowerCase() !== String(onChainDigest).toLowerCase()) {
    ctx.alerts.fire({
      kind: 'signature_mismatch',
      severity: 'critical',
      message: 'locally computed EIP-712 digest differs from the destination contract — ABI drift or an impostor bridge',
      key: `digest:${stored.transferId}`,
      fields: { transferId: stored.transferId, local: digest, onChain: onChainDigest, bridge: dst.config.bridgeAddress },
    });
    return refuse('digest_mismatch', `local digest ${digest} != contract ${onChainDigest}`);
  }

  // ---- 7. this node's OWN caps, tighter than or equal to the chain's -------
  const srcLimit = limitFor(src.config, t.srcToken);
  const dstLimit = limitFor(dst.config, t.dstToken);
  if (srcLimit.maxPerTransfer > 0n && t.amount > srcLimit.maxPerTransfer) {
    return capBreach(ctx, stored, 'source', t.amount, srcLimit.maxPerTransfer);
  }
  if (dstLimit.maxPerTransfer > 0n && t.amount > dstLimit.maxPerTransfer) {
    return capBreach(ctx, stored, 'destination', t.amount, dstLimit.maxPerTransfer);
  }
  if (srcLimit.maxPerTransfer === 0n || dstLimit.maxPerTransfer === 0n) {
    return refuse('over_local_per_transfer_cap', 'no local limit configured for this token on one side — refusing by default');
  }

  const outKey = windowKey(t.srcChainId, t.srcToken, 'out');
  const inKey = windowKey(t.dstChainId, t.dstToken, 'in');
  if (!consumeCaps) {
    const outUsed = ctx.limiter.usage(outKey) + t.amount;
    const inUsed = ctx.limiter.usage(inKey) + t.amount;
    if (outUsed > srcLimit.dailyCap) return refuse('over_local_daily_cap', `outbound 24h cap would be exceeded: ${outUsed} > ${srcLimit.dailyCap}`);
    if (inUsed > dstLimit.dailyCap) return refuse('over_local_daily_cap', `inbound 24h cap would be exceeded: ${inUsed} > ${dstLimit.dailyCap}`);
    return { ok: true, code: null, reason: null, digest, alreadyProcessed: false, consumed: null };
  }

  const out = ctx.limiter.tryConsume(outKey, srcLimit.dailyCap, t.amount);
  if (!out.ok) {
    ctx.alerts.fire({
      kind: 'cap_breach',
      severity: 'warn',
      message: 'refused to sign: outbound 24h volume cap',
      key: `cap-out:${t.srcChainId}:${t.srcToken}`,
      fields: { transferId: stored.transferId, chainId: t.srcChainId, token: t.srcToken, amount: t.amount, used: out.usedBefore, cap: out.cap },
    });
    return refuse('over_local_daily_cap', out.reason ?? 'outbound cap');
  }
  const inbound = ctx.limiter.tryConsume(inKey, dstLimit.dailyCap, t.amount);
  if (!inbound.ok) {
    // Give the outbound capacity back — we are not signing, so nothing was used.
    ctx.limiter.release(outKey, t.amount);
    ctx.alerts.fire({
      kind: 'cap_breach',
      severity: 'warn',
      message: 'refused to sign: inbound 24h volume cap',
      key: `cap-in:${t.dstChainId}:${t.dstToken}`,
      fields: { transferId: stored.transferId, chainId: t.dstChainId, token: t.dstToken, amount: t.amount, used: inbound.usedBefore, cap: inbound.cap },
    });
    return refuse('over_local_daily_cap', inbound.reason ?? 'inbound cap');
  }

  return { ok: true, code: null, reason: null, digest, alreadyProcessed: false, consumed: { outKey, inKey, amount: t.amount } };
}

function capBreach(ctx: VerifyContext, stored: StoredTransfer, side: string, amount: bigint, cap: bigint): VerifyResult {
  ctx.alerts.fire({
    kind: 'cap_breach',
    severity: 'warn',
    message: `refused to sign: amount over the local ${side} per-transfer cap`,
    key: `cap-per:${stored.transferId}`,
    fields: { transferId: stored.transferId, side, amount, cap },
  });
  return refuse('over_local_per_transfer_cap', `amount ${amount} exceeds the local ${side} per-transfer cap ${cap}`);
}
