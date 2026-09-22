// VALIDATOR role.
//
// Watches the source chains it is configured for, verifies every `Sent` event
// against its OWN RPC endpoints, waits the configured confirmations, re-reads
// the log to be sure it survived, and only then signs the EIP-712 digest that
// the destination bridge will check.
//
// What this process will not do, at all, ever:
//   * sign anything it did not observe itself (there is no "please sign this"
//     endpoint — the HTTP surface is read-only)
//   * sign a transfer on a chain it is not configured for
//   * sign against a bridge address whose EIP-712 domain separator it has not
//     verified against a local derivation
//   * sign an amount above its own configured caps, whatever the contract allows
//   * sign a digest it did not compute itself from the transfer fields
//
// A compromised validator host is one signature. With threshold 2-of-3 that is
// nothing on its own; the response is still pause() first, rotate second. See
// the runbook in README.md.

import { getAddress } from 'ethers';
import type { Alerter } from './alerts.ts';
import type { RelayerConfig } from './config.ts';
import type { Store, StoredTransfer } from './db.ts';
import { loadKey, type LoadedKey } from './keystore.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import { RelayerService } from './service.ts';
import { SharedDirTransport, buildPayload } from './transport.ts';
import { TRANSFER_TYPES, digestFor, domainFor, recoverSigner, serializeTransfer, typedValue } from './transfer.ts';
import { FINALITY_CODES, releaseCapacity, verifyForSigning, type RefusalCode, type VerifyContext } from './verify.ts';

/**
 * Refusals that can legitimately clear on their own; everything else is final.
 * Every finality refusal is here: blocks arrive, pace recovers, a checkpoint
 * gets published. The two that do NOT clear on their own (a checkpoint hash
 * mismatch, a reorged source block) page a human from finality.ts and stay
 * pending rather than being marked rejected, so that nothing is silently
 * discarded on the word of a chain view that may itself be the anomaly.
 */
const RETRYABLE: RefusalCode[] = ['rpc_error', 'bridge_paused', 'dst_token_paused', 'over_local_daily_cap', 'not_confirmed', ...FINALITY_CODES];

export interface ValidatorHandle {
  service: RelayerService;
  address: string;
  stop(): Promise<void>;
}

export async function startValidator(
  cfg: RelayerConfig,
  log: Logger,
  alerts: Alerter,
  store: Store,
  metrics: Metrics,
): Promise<ValidatorHandle> {
  const key: LoadedKey = await loadKey(cfg.keystore, log);
  const vlog = log.child({ role: 'validator', validator: key.address });

  const sharedDir =
    cfg.transport.mode !== 'http' && cfg.transport.sharedDir
      ? new SharedDirTransport(cfg.transport.sharedDir, vlog)
      : null;

  metrics.describe('relayer_signatures_total', 'Signatures produced by this validator');
  metrics.describe('relayer_refusals_total', 'Transfers this validator refused to sign, by reason');

  let serviceRef: RelayerService | null = null;
  const svc = (): RelayerService => {
    if (!serviceRef) throw new Error('validator service is not initialised');
    return serviceRef;
  };

  const ctx = (): VerifyContext => ({
    cfg,
    chains: svc().chains,
    limiter: svc().limiter,
    alerts,
    log: vlog,
    finality: svc().finality,
  });

  /** Verify then sign one confirmed transfer. Idempotent. */
  async function consider(stored: StoredTransfer): Promise<void> {
    const already = store.getSignatures(stored.transferId).some((s) => s.signer === key.address);
    if (already) {
      if (stored.status === 'confirmed') store.setTransferStatus(stored.transferId, 'signed');
      return;
    }

    const vctx = ctx();
    const result = await verifyForSigning(vctx, stored);
    if (!result.ok) {
      if (result.alreadyProcessed) {
        store.markExecuted(stored.transferId, null);
        vlog.info('transfer already executed on the destination — nothing to sign', { transferId: stored.transferId });
        return;
      }
      const retryable = result.code !== null && RETRYABLE.includes(result.code);
      metrics.inc('relayer_refusals_total', { reason: result.code ?? 'unknown' });
      if (retryable) {
        vlog.warn('deferring signature', { transferId: stored.transferId, code: result.code, reason: result.reason });
        return; // stays 'confirmed', retried on the next tick
      }
      store.setTransferStatus(stored.transferId, 'rejected', `${result.code}: ${result.reason}`);
      vlog.error('REFUSED to sign', { transferId: stored.transferId, code: result.code, reason: result.reason });
      alerts.fire({
        kind: result.code === 'over_local_per_transfer_cap' ? 'cap_breach' : 'signature_mismatch',
        severity: 'critical',
        message: `validator refused to sign a transfer: ${result.code}`,
        key: `refused:${stored.transferId}`,
        fields: {
          transferId: stored.transferId,
          code: result.code,
          reason: result.reason,
          route: `${stored.transfer.srcChainId}->${stored.transfer.dstChainId}`,
          amount: stored.transfer.amount,
        },
      });
      return;
    }

    const dst = svc().chains.get(stored.transfer.dstChainId);
    if (!dst) {
      // verify already guarantees this, belt and braces — but we are past the
      // point where capacity was consumed, so hand it back before leaving.
      releaseCapacity(vctx, result.consumed);
      return;
    }
    const digest = result.digest as string;

    // Everything from here on has already SPENT this node's 24h capacity.
    // Verification consumes before signing on purpose (a crash in between must
    // cost capacity, never safety), which means every way out of this block
    // other than a published signature has to give the capacity back. Otherwise
    // a validator that rejects a handful of transfers quietly ratchets its own
    // budget down and starts refusing legitimate ones.
    try {
      const signature = await key.wallet.signTypedData(
        domainFor(stored.transfer.dstChainId, dst.config.bridgeAddress),
        TRANSFER_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
        typedValue(stored.transfer),
      );

      // Self-check: a signature that does not recover to us is a broken signer or a
      // corrupted key, and publishing it would waste a validator slot at execute().
      const recovered = recoverSigner(digest, signature);
      if (recovered !== key.address) {
        alerts.fire({
          kind: 'signature_mismatch',
          severity: 'critical',
          message: 'own signature does not recover to own address — signer is broken, refusing to publish',
          key: `selfcheck:${stored.transferId}`,
          fields: { transferId: stored.transferId, expected: key.address, recovered },
        });
        releaseCapacity(vctx, result.consumed);
        store.setTransferStatus(stored.transferId, 'rejected', 'self-check failed: signature does not recover to this validator');
        return;
      }
      // And against the digest the destination contract itself derives.
      if (digestFor(stored.transfer, dst.config.bridgeAddress) !== digest) {
        releaseCapacity(vctx, result.consumed);
        store.setTransferStatus(stored.transferId, 'rejected', 'digest changed between verification and signing');
        return;
      }

      store.putSignature({
        transferId: stored.transferId,
        signer: key.address,
        signature,
        origin: 'local',
        createdAt: Date.now(),
      });
      store.setTransferStatus(stored.transferId, 'signed');
      metrics.inc('relayer_signatures_total', { chain: dst.name });

      vlog.info('SIGNED', {
        transferId: stored.transferId,
        route: `${stored.transfer.srcChainId}->${stored.transfer.dstChainId}`,
        dstToken: stored.transfer.dstToken,
        recipient: stored.transfer.recipient,
        amount: stored.transfer.amount.toString(),
        digest,
      });

      sharedDir?.publish(buildPayload(stored.transfer, stored.transferId, digest, key.address, signature));
    } catch (err) {
      // A throw here (a signer that died, a store write that failed) leaves the
      // transfer 'confirmed' and it will be retried on the next tick — which
      // consumes capacity again. Release first, then rethrow.
      releaseCapacity(vctx, result.consumed);
      vlog.error('signing failed after capacity was consumed — capacity released, transfer will be retried', {
        transferId: stored.transferId,
        err: (err as Error).message,
      });
      throw err;
    }
  }

  /** Process everything sitting in `confirmed`, plus reconcile what we signed. */
  async function tick(): Promise<void> {
    for (const t of store.listTransfers({ status: ['confirmed'], limit: 200 })) {
      await consider(t);
    }
    // Close the loop: a signed transfer that the destination has executed is done.
    for (const t of store.listTransfers({ status: ['signed'], limit: 200 })) {
      const dst = svc().chains.get(t.transfer.dstChainId);
      if (!dst || dst.healthyEndpoints.length === 0) continue;
      try {
        if (await dst.bridge().processed(t.transferId)) {
          store.markExecuted(t.transferId, null);
          vlog.info('transfer executed on the destination', { transferId: t.transferId });
        }
      } catch {
        // transient; retried next tick
      }
    }
  }

  serviceRef = new RelayerService({
    cfg,
    role: 'validator',
    log: vlog,
    alerts,
    store,
    metrics,
    tickIntervalMs: Math.max(cfg.submitter.pollIntervalMs, 2_000),
    hooks: {
      onConfirmed: consider,
      tick,
      signatures: (transferId: string) => {
        const stored = store.getTransfer(transferId);
        if (!stored) return null;
        const sig = store.getSignatures(transferId).find((s) => s.signer === key.address);
        if (!sig) return null;
        const dst = svc().chains.get(stored.transfer.dstChainId);
        if (!dst) return null;
        return {
          transferId,
          signer: key.address,
          signature: sig.signature,
          digest: digestFor(stored.transfer, dst.config.bridgeAddress),
          transfer: serializeTransfer(stored.transfer),
          signedAt: sig.createdAt,
        };
      },
      extraStatus: () => ({ validator: key.address, keySource: key.source, transport: cfg.transport.mode }),
    },
  });

  const service = svc();
  await service.preflight();

  // Not fatal, but load-bearing: if this address is not in a bridge's validator
  // set, every signature it produces for that chain is dead weight.
  for (const chain of service.chains.values()) {
    try {
      const validators = (await chain.bridge().getValidators()) as string[];
      const listed = validators.map((v) => getAddress(v)).includes(key.address);
      const threshold = Number(await chain.bridge().threshold());
      vlog.info('destination validator set', {
        chain: chain.name,
        threshold,
        validators: validators.length,
        thisNodeIsAValidator: listed,
      });
      if (!listed) {
        alerts.fire({
          kind: 'lifecycle',
          severity: 'warn',
          message: 'this key is NOT in the bridge validator set — its signatures will be rejected by execute()',
          key: `notvalidator:${chain.chainId}`,
          fields: { chain: chain.name, chainId: chain.chainId, address: key.address },
        });
      }
    } catch (err) {
      vlog.warn('could not read the validator set', { chain: chain.name, err: (err as Error).message });
    }
  }

  await service.start();
  return {
    service,
    address: key.address,
    stop: () => service.stop(),
  };
}
