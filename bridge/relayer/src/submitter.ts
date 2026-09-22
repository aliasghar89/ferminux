// SUBMITTER role.
//
// Collects validator signatures, checks the destination for idempotency,
// simulates, then relays. It holds no attesting power at all: its key pays gas
// and nothing else. Anyone can run one — `execute()` is permissionless — which
// is exactly why the submitter is the component you are allowed to lose.
//
// The no-double-submit guarantee, precisely:
//
//   1. before anything is signed, the destination is asked `processed(id)`.
//      True -> record and stop. This alone handles "someone else relayed it".
//   2. `execute()` is simulated with staticCall from the submitter's own address.
//      A revert is recorded and alerted, never broadcast.
//   3. an account nonce is allocated ONCE per transfer and persisted with the
//      signed raw transaction BEFORE the broadcast. Every retry re-signs at the
//      SAME nonce with a higher fee, so the mempool holds a set of mutually
//      exclusive transactions and at most one of them can ever be mined.
//   4. a crash between signing and broadcasting leaves the attempt on disk; the
//      next start finds it, looks it up by hash, and either sees it mined or
//      re-broadcasts the identical bytes.
//
// The contract is the final backstop: `processed[transferId]` is set before any
// token moves, so even a submitter that ignored all of the above could at worst
// waste gas on a reverting transaction.

import { Transaction, getAddress, type TransactionReceipt } from 'ethers';
import type { Alerter } from './alerts.ts';
import type { ChainClient } from './chain.ts';
import type { RelayerConfig } from './config.ts';
import type { Store, StoredSubmission, StoredTransfer, SubmissionAttempt } from './db.ts';
import { planFees, planGasLimit } from './gas.ts';
import { loadKey, type LoadedKey } from './keystore.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import { RelayerService } from './service.ts';
import { HttpTransport, SharedDirTransport, verifyPayload } from './transport.ts';
import { digestFor, toSolidityTuple } from './transfer.ts';

/** Backoff before retrying a submission whose simulation failed. */
const FAILED_RETRY_MS = 60_000;

/**
 * Choose the signatures that go into ONE execute() bundle.
 *
 * The rule this encodes: a bundle is only ever as good as the validator set it
 * is measured against at the moment it lands. `_verifySignatures()` requires
 * `isValidator[signer]` for EVERY signature and reverts the whole call on the
 * first one that fails — so a single attestation from a validator who has since
 * been rotated out takes an otherwise perfect quorum down with it. Signatures
 * are therefore re-sliced against a freshly-read validator set before every
 * submission and every retry, never collected once and replayed.
 *
 * Pure and exported so that rule is testable against a rotation without a chain,
 * a key or a mempool.
 *
 * @param stored     every signature this node holds for the transfer
 * @param validators the destination's validator set, read from the destination
 * @param threshold  the destination's live threshold
 */
export function selectSignatures(
  stored: ReadonlyArray<{ signer: string; signature: string }>,
  validators: readonly string[],
  threshold: number,
): { sigs: Array<{ signer: string; signature: string }>; dropped: string[] } {
  const current = new Set<string>();
  for (const v of validators) {
    try {
      current.add(getAddress(v));
    } catch {
      // Not an address. It cannot equal a recovered signer either, so leaving it
      // out is the same decision, made without throwing inside a poll loop.
    }
  }

  const seen = new Set<string>();
  const usable: Array<{ signer: string; signature: string }> = [];
  const dropped: string[] = [];
  for (const s of stored) {
    let signer: string;
    try {
      signer = getAddress(s.signer);
    } catch {
      dropped.push(s.signer);
      continue;
    }
    if (seen.has(signer)) continue; // a repeated signer is its own contract revert
    if (!current.has(signer)) {
      dropped.push(signer);
      continue;
    }
    seen.add(signer);
    usable.push({ signer, signature: s.signature });
  }

  // Deterministic order, by numeric address. execute() accepts any order, but a
  // stable one makes a retry rebuild byte-identical calldata — and it must not
  // depend on the host's collation, which `localeCompare` over mixed-case
  // checksummed hex does.
  usable.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));

  // Exactly `threshold` and no more: every extra signature is extra gas and one
  // more signer who could be rotated out before the transaction is mined.
  return { sigs: threshold > 0 ? usable.slice(0, threshold) : usable, dropped };
}

/**
 * Which signers inside an already-broadcast bundle are no longer validators.
 *
 * A non-empty answer means the transaction sitting in the mempool can only
 * revert, however long it is left there — so it is a reason to rebuild NOW
 * rather than after the receipt timeout.
 *
 * `undefined` signers is "unknown", not "none": rows written before the field
 * existed must not be treated as a bundle with nothing stale in it, so they fall
 * back to the timeout path they were written under.
 */
export function staleSigners(signers: readonly string[] | undefined, validators: readonly string[]): string[] {
  if (!signers || signers.length === 0) return [];
  const current = new Set<string>();
  for (const v of validators) {
    try {
      current.add(getAddress(v));
    } catch {
      /* not an address; see selectSignatures */
    }
  }
  return signers.filter((s) => {
    try {
      return !current.has(getAddress(s));
    } catch {
      return true; // unreadable signer in our own record: rebuild rather than trust it
    }
  });
}

export interface SubmitterHandle {
  service: RelayerService;
  address: string;
  stop(): Promise<void>;
}

export async function startSubmitter(
  cfg: RelayerConfig,
  log: Logger,
  alerts: Alerter,
  store: Store,
  metrics: Metrics,
): Promise<SubmitterHandle> {
  const key: LoadedKey = await loadKey(cfg.keystore, log);
  const slog = log.child({ role: 'submitter', submitter: key.address });

  const http =
    cfg.transport.mode !== 'shared-dir' ? new HttpTransport(cfg.submitter.peers, cfg.transport.requestTimeoutMs, slog) : null;
  const sharedDir =
    cfg.transport.mode !== 'http' && cfg.transport.sharedDir ? new SharedDirTransport(cfg.transport.sharedDir, slog) : null;

  metrics.describe('relayer_submissions_sent_total', 'execute() transactions broadcast');
  metrics.describe('relayer_submissions_mined_total', 'execute() transactions mined successfully');
  metrics.describe('relayer_signatures_collected_total', 'Validator signatures accepted from peers');
  metrics.describe('relayer_signatures_rejected_total', 'Signatures rejected during verification, by reason');

  let serviceRef: RelayerService | null = null;
  const svc = (): RelayerService => {
    if (!serviceRef) throw new Error('submitter service is not initialised');
    return serviceRef;
  };

  // ------------------------------------------------------------- signatures

  /**
   * Pull signatures from every configured source and keep the ones that verify
   * against a locally computed digest and a validator address read from the
   * destination chain. A peer can only ever ADD a valid attestation; it can
   * never make this node accept an invalid one, or one for a transfer this node
   * has not itself observed.
   */
  async function collectSignatures(t: StoredTransfer, dst: ChainClient): Promise<void> {
    const payloads: Array<{ peer: string; payload: unknown }> = [];
    if (http) payloads.push(...(await http.collect(t.transferId)));
    if (sharedDir) {
      for (const payload of sharedDir.collect(t.transferId)) payloads.push({ peer: 'shared-dir', payload });
    }
    if (payloads.length === 0) return;

    const known = new Set(store.getSignatures(t.transferId).map((s) => s.signer));
    for (const { peer, payload } of payloads) {
      // A peer answering with a DIFFERENT transfer than the one asked about is
      // either broken or probing. If we have never seen that id on chain, it is
      // the more serious of the two: someone is trying to get this node to relay
      // a transfer no source chain produced.
      const offered = (payload as { transferId?: unknown } | null)?.transferId;
      if (typeof offered === 'string' && offered.toLowerCase() !== t.transferId.toLowerCase()) {
        const seenBefore = store.getTransfer(offered) !== null;
        alerts.fire({
          kind: seenBefore ? 'signature_mismatch' : 'unknown_transfer',
          severity: 'critical',
          message: seenBefore
            ? 'peer answered with a different transfer than the one requested'
            : 'peer offered a signature for a transfer this node has never seen on chain',
          key: `offered:${peer}:${offered}`,
          fields: { peer, requested: t.transferId, offered },
        });
        continue;
      }
      try {
        const { signer, signature } = verifyPayload(payload, {
          transferId: t.transferId,
          transfer: t.transfer,
          dstBridgeAddress: dst.config.bridgeAddress,
        });
        if (known.has(signer)) continue;
        known.add(signer);
        store.putSignature({ transferId: t.transferId, signer, signature, origin: peer, createdAt: Date.now() });
        metrics.inc('relayer_signatures_collected_total', { peer });
        slog.info('signature accepted', { transferId: t.transferId, signer, peer });
      } catch (err) {
        const reason = (err as Error).message;
        metrics.inc('relayer_signatures_rejected_total', { peer });
        alerts.fire({
          kind: 'signature_mismatch',
          severity: 'critical',
          message: 'rejected a signature from a peer',
          key: `sigreject:${t.transferId}:${peer}`,
          fields: { transferId: t.transferId, peer, reason },
        });
      }
    }
  }

  /**
   * Signatures currently usable: in the destination's validator set RIGHT NOW,
   * deduped, capped at the threshold.
   *
   * Read fresh from the destination on every pass, never cached, because the
   * validator set is the one input to a bundle that can change while the bundle
   * is in flight — and _verifySignatures() rejects the WHOLE bundle if a single
   * signer has since been removed. A stale signature left in the set would take
   * a perfectly good quorum down with it.
   */
  async function usableSignatures(
    t: StoredTransfer,
    dst: ChainClient,
  ): Promise<{ threshold: number; validators: string[]; sigs: Array<{ signer: string; signature: string }>; dropped: string[] }> {
    const bridge = dst.bridge();
    const [thresholdRaw, validatorsRaw] = await Promise.all([bridge.threshold(), bridge.getValidators()]);
    const threshold = Number(thresholdRaw);
    const validators = (validatorsRaw as string[]).map((v) => getAddress(v));
    const selected = selectSignatures(store.getSignatures(t.transferId), validators, threshold);
    if (selected.dropped.length > 0) {
      slog.warn('dropping signatures from addresses that are no longer validators', {
        transferId: t.transferId,
        chain: dst.name,
        dropped: selected.dropped,
        kept: selected.sigs.map((s) => s.signer),
        need: threshold,
      });
    }
    return { threshold, validators, ...selected };
  }


  // ------------------------------------------------------------- submission

  /** Nonce allocation that cannot collide with our own in-flight submissions. */
  async function allocateNonce(dst: ChainClient): Promise<number> {
    const chainNonce = await dst.provider().getTransactionCount(key.address, 'pending');
    let localMax = -1;
    for (const s of store.listSubmissions('pending')) {
      if (s.dstChainId === dst.chainId && s.accountNonce > localMax) localMax = s.accountNonce;
    }
    return Math.max(chainNonce, localMax + 1);
  }

  async function advance(t: StoredTransfer): Promise<void> {
    const dst = svc().chains.get(t.transfer.dstChainId);
    if (!dst || dst.healthyEndpoints.length === 0) return;

    // (1) idempotency — ask the chain first, always.
    let processed: boolean;
    try {
      processed = (await dst.bridge().processed(t.transferId)) as boolean;
    } catch (err) {
      slog.warn('processed() read failed', { transferId: t.transferId, err: (err as Error).message });
      return;
    }
    if (processed) {
      const sub = store.getSubmission(t.transferId);
      store.markExecuted(t.transferId, sub?.minedTxHash ?? null);
      slog.info('already executed on the destination — nothing to do', { transferId: t.transferId });
      return;
    }

    if (cfg.submitter.skipWhenPaused) {
      try {
        if ((await dst.bridge().paused()) as boolean) {
          alerts.fire({
            kind: 'bridge_paused',
            severity: 'warn',
            message: 'destination bridge is paused — holding transfers',
            key: `paused:${dst.chainId}`,
            fields: { chain: dst.name, chainId: dst.chainId, transferId: t.transferId },
          });
          return;
        }
      } catch {
        return;
      }
    }

    await collectSignatures(t, dst);
    const { threshold, sigs } = await usableSignatures(t, dst);
    if (sigs.length < threshold) {
      const waited = Date.now() - t.firstSeenAt;
      if (waited > cfg.submitter.signatureWaitMs) {
        alerts.fire({
          kind: 'transfer_stuck',
          severity: 'critical',
          message: 'transfer has not reached a validator quorum',
          key: `stuck:${t.transferId}`,
          fields: {
            transferId: t.transferId,
            have: sigs.length,
            need: threshold,
            waitedSec: Math.round(waited / 1000),
            route: `${t.transfer.srcChainId}->${t.transfer.dstChainId}`,
          },
        });
      }
      slog.debug('waiting for signatures', { transferId: t.transferId, have: sigs.length, need: threshold });
      return;
    }

    const existing = store.getSubmission(t.transferId);
    if (existing && existing.status === 'pending') return; // pollSubmission owns it
    if (existing && existing.attempts.length >= dst.config.gas.maxAttempts && existing.status !== 'mined') {
      return; // exhausted; already alerted
    }
    // A failed simulation is usually a config or quorum problem that a human has
    // to fix. Back off instead of re-simulating on every tick.
    if (existing && existing.status === 'failed' && Date.now() - existing.updatedAt < FAILED_RETRY_MS) return;

    await submit(t, dst, sigs, existing);
  }

  async function submit(
    t: StoredTransfer,
    dst: ChainClient,
    sigs: Array<{ signer: string; signature: string }>,
    existing: StoredSubmission | null,
  ): Promise<void> {
    const tuple = [
      t.transfer.srcChainId,
      t.transfer.dstChainId,
      t.transfer.nonce,
      t.transfer.srcToken,
      t.transfer.dstToken,
      t.transfer.sender,
      t.transfer.recipient,
      t.transfer.amount,
    ];
    const solSigs = sigs.map((s) => {
      const { v, r, s: sHex } = toSolidityTuple(s.signature);
      return [v, r, sHex];
    });

    const bridge = dst.bridgeWith(key.wallet.connect(dst.provider()));

    // (2) simulate. A revert here is a real finding — the signatures, the caps or
    // the registry are not what we think they are — so it alerts and stops.
    try {
      await bridge.execute.staticCall(tuple, solSigs, { from: key.address });
    } catch (err) {
      const reason = decodeRevert(err);
      alerts.fire({
        kind: 'submission_failed',
        severity: 'critical',
        message: 'execute() reverts in simulation — not broadcasting',
        key: `sim:${t.transferId}`,
        fields: {
          transferId: t.transferId,
          chain: dst.name,
          reason,
          signers: sigs.map((s) => s.signer),
          digest: digestFor(t.transfer, dst.config.bridgeAddress),
        },
      });
      slog.error('simulation failed', { transferId: t.transferId, reason });
      store.putSubmission({
        transferId: t.transferId,
        dstChainId: dst.chainId,
        accountNonce: existing?.accountNonce ?? -1,
        attempts: existing?.attempts ?? [],
        status: 'failed',
        minedTxHash: null,
        lastError: `simulation: ${reason}`,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      return;
    }

    const attemptIndex = existing?.attempts.length ?? 0;
    const gas = dst.config.gas;
    const fees = await planFees(dst.provider(), gas, attemptIndex);
    if (fees.atCeiling && attemptIndex > 0) {
      alerts.fire({
        kind: 'submission_failed',
        severity: 'critical',
        message: 'gas ceiling reached — cannot escalate further, transfer is stalled',
        key: `gasceiling:${t.transferId}`,
        fields: { transferId: t.transferId, chain: dst.name, maxFeePerGasGwei: gas.maxFeePerGasGwei },
      });
      return;
    }

    let gasLimit: bigint;
    try {
      gasLimit = planGasLimit(await bridge.execute.estimateGas(tuple, solSigs, { from: key.address }), gas);
    } catch {
      gasLimit = BigInt(gas.gasLimitCap);
    }

    const populated = await bridge.execute.populateTransaction(tuple, solSigs);

    // Nonce rule, in one place:
    //   escalating an UNMINED attempt  -> reuse the nonce (that is what makes the
    //                                     attempts mutually exclusive)
    //   anything else                  -> allocate a fresh one, because a mined-
    //                                     and-reverted attempt already spent it
    const reuseNonce = existing !== null && existing.status === 'pending' && existing.accountNonce >= 0;
    const nonce = reuseNonce ? (existing as StoredSubmission).accountNonce : await allocateNonce(dst);

    const raw = await key.wallet.signTransaction(
      gas.txType === 0
        ? {
            type: 0,
            chainId: dst.chainId,
            to: populated.to as string,
            data: populated.data as string,
            value: 0n,
            nonce,
            gasLimit,
            gasPrice: fees.gasPrice,
          }
        : {
            type: 2,
            chainId: dst.chainId,
            to: populated.to as string,
            data: populated.data as string,
            value: 0n,
            nonce,
            gasLimit,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          },
    );
    const txHash = Transaction.from(raw).hash as string;

    const attempt: SubmissionAttempt = {
      txHash,
      raw,
      maxFeePerGas: (gas.txType === 0 ? fees.gasPrice : fees.maxFeePerGas).toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      gasLimit: gasLimit.toString(),
      sentAt: Date.now(),
      signers: sigs.map((s) => s.signer),
    };

    // (3) DURABLE BEFORE BROADCAST. If the process dies on the next line, the
    // attempt is on disk with its nonce and its exact bytes.
    const record: StoredSubmission = {
      transferId: t.transferId,
      dstChainId: dst.chainId,
      accountNonce: nonce,
      attempts: [...(existing?.attempts ?? []), attempt],
      status: 'pending',
      minedTxHash: null,
      lastError: null,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    store.putSubmission(record);

    try {
      await dst.provider().broadcastTransaction(raw);
      metrics.inc('relayer_submissions_sent_total', { chain: dst.name });
      slog.info('execute() broadcast', {
        transferId: t.transferId,
        chain: dst.name,
        txHash,
        nonce,
        attempt: attemptIndex + 1,
        maxFeePerGas: attempt.maxFeePerGas,
        signers: sigs.map((s) => s.signer),
      });
    } catch (err) {
      const msg = (err as Error).message;
      // "already known" / "nonce too low" mean the bytes are in a mempool or the
      // nonce already landed — both are handled by polling, not by re-signing.
      if (/already known|known transaction|nonce too low|replacement/i.test(msg)) {
        slog.warn('broadcast rejected as duplicate — will poll for the receipt', { transferId: t.transferId, txHash, err: msg });
      } else {
        record.lastError = `broadcast: ${msg}`;
        record.updatedAt = Date.now();
        store.putSubmission(record);
        slog.error('broadcast failed', { transferId: t.transferId, txHash, err: msg });
      }
    }

    await pollSubmission(record);
  }

  /** Check a pending submission's attempts; mark, escalate or give up. */
  async function pollSubmission(sub: StoredSubmission): Promise<void> {
    const dst = svc().chains.get(sub.dstChainId);
    if (!dst || dst.healthyEndpoints.length === 0) return;

    let receipt: TransactionReceipt | null = null;
    let receiptHash: string | null = null;
    for (const attempt of sub.attempts) {
      try {
        const r = await dst.provider().getTransactionReceipt(attempt.txHash);
        if (r) {
          receipt = r;
          receiptHash = attempt.txHash;
          break;
        }
      } catch {
        // keep looking
      }
    }

    if (receipt && receipt.status === 1) {
      store.putSubmission({ ...sub, status: 'mined', minedTxHash: receiptHash, updatedAt: Date.now() });
      store.markExecuted(sub.transferId, receiptHash);
      metrics.inc('relayer_submissions_mined_total', { chain: dst.name });
      slog.info('EXECUTED', {
        transferId: sub.transferId,
        chain: dst.name,
        txHash: receiptHash,
        block: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      });
      return;
    }

    if (receipt && receipt.status === 0) {
      // Mined and reverted: the nonce is spent, so any further attempt needs a
      // fresh one. Recorded as failed and alerted — this should not happen after
      // a successful simulation, and if it does a human needs to know why.
      store.putSubmission({ ...sub, status: 'failed', minedTxHash: receiptHash, lastError: 'reverted on chain', updatedAt: Date.now() });
      alerts.fire({
        kind: 'submission_failed',
        severity: 'critical',
        message: 'execute() reverted on chain after a clean simulation',
        key: `revert:${sub.transferId}`,
        fields: { transferId: sub.transferId, chain: dst.name, txHash: receiptHash },
      });
      return;
    }

    // Still pending: either waiting for a receipt, or holding a bundle that can
    // no longer be mined.
    const last = sub.attempts[sub.attempts.length - 1];
    if (!last) return;
    const waited = Date.now() - last.sentAt;

    const transfer = store.getTransfer(sub.transferId);
    if (!transfer) return;

    // The validator set is re-read here, not only after the receipt timeout,
    // because a rotation is the one thing that can make the transaction already
    // in the mempool UNMINEABLE: _verifySignatures() rejects the whole bundle on
    // a single removed signer, so a set of otherwise-valid attestations dies with
    // it. Waiting out receiptTimeoutMs first would spend that budget — and, with
    // maxAttempts, possibly the whole transfer — on a transaction that can only
    // revert. So: notice the rotation, re-slice, replace at the same nonce.
    const current = await usableSignatures(transfer, dst);
    const staleInFlight = staleSigners(last.signers, current.validators);

    if (staleInFlight.length === 0 && waited < dst.config.gas.receiptTimeoutMs) return;

    // About to rebuild, so ask the peers again FIRST. A rotation that removed a
    // validator usually added one, and that new validator's attestation is
    // exactly what turns the next bundle back into a quorum. advance() — the
    // only other place signatures are collected — deliberately does not run
    // while a submission is `pending`, so without this line a transfer whose
    // quorum was rotated away would sit here waiting for a signature nobody was
    // ever going to ask for.
    let { threshold, sigs } = current;
    if (staleInFlight.length > 0 || sigs.length < threshold) {
      await collectSignatures(transfer, dst);
      ({ threshold, sigs } = await usableSignatures(transfer, dst));
    }

    if (staleInFlight.length > 0) {
      alerts.fire({
        kind: 'submission_failed',
        severity: 'warn',
        message: 'validator rotation left a stale signature in the in-flight bundle — rebuilding it at the same nonce',
        key: `rotation:${sub.transferId}`,
        fields: {
          transferId: sub.transferId,
          chain: dst.name,
          removed: staleInFlight,
          have: sigs.length,
          need: threshold,
          nonce: sub.accountNonce,
        },
      });
    }

    if (sigs.length < threshold) {
      // A rotation can take the quorum with it. That is a WAIT, never an abandon:
      // the transfer is still valid, the remaining or incoming validators can
      // still attest to it, and advance()'s signatureWaitMs alert covers the case
      // where nobody ever does.
      slog.warn('not enough current-validator signatures to (re)submit', {
        transferId: sub.transferId,
        have: sigs.length,
        need: threshold,
      });
      return;
    }

    if (sub.attempts.length >= dst.config.gas.maxAttempts) {
      store.putSubmission({ ...sub, status: 'abandoned', lastError: 'no receipt after the final attempt', updatedAt: Date.now() });
      alerts.fire({
        kind: 'submission_failed',
        severity: 'critical',
        message: 'gave up relaying a transfer after the configured attempts',
        key: `abandoned:${sub.transferId}`,
        fields: { transferId: sub.transferId, chain: dst.name, attempts: sub.attempts.length, lastTx: last.txHash },
      });
      return;
    }

    slog.warn(staleInFlight.length > 0 ? 're-slicing the bundle after a validator rotation' : 'no receipt — escalating gas at the same nonce', {
      transferId: sub.transferId,
      nonce: sub.accountNonce,
      attempt: sub.attempts.length + 1,
      waitedSec: Math.round(waited / 1000),
      signers: sigs.map((s) => s.signer),
    });
    await submit(transfer, dst, sigs, sub);
  }

  /** Peer liveness for /health and /status; refreshed on a slow cadence. */
  let peerHealth: Array<{ peer: string; ok: boolean; detail: string }> = [];
  let lastPingAt = 0;
  const PING_INTERVAL_MS = 30_000;

  async function tick(): Promise<void> {
    if (http && Date.now() - lastPingAt > PING_INTERVAL_MS) {
      lastPingAt = Date.now();
      peerHealth = await http.ping();
      const down = peerHealth.filter((p) => !p.ok);
      if (down.length > 0) {
        slog.warn('validators unreachable', { down: down.map((d) => `${d.peer}: ${d.detail}`) });
      }
    }
    for (const sub of store.listSubmissions('pending')) await pollSubmission(sub);
    for (const t of store.listTransfers({ status: ['confirmed', 'signed'], limit: 200 })) {
      if (!svc().chains.has(t.transfer.dstChainId)) continue;
      await advance(t);
    }
  }

  serviceRef = new RelayerService({
    cfg,
    role: 'submitter',
    log: slog,
    alerts,
    store,
    metrics,
    tickIntervalMs: cfg.submitter.pollIntervalMs,
    hooks: {
      onConfirmed: advance,
      tick,
      extraStatus: () => ({
        submitter: key.address,
        keySource: key.source,
        transport: cfg.transport.mode,
        peers: peerHealth.length > 0 ? peerHealth : cfg.submitter.peers.map((p) => ({ peer: p.name, ok: null, detail: 'not probed yet' })),
      }),
    },
  });

  const service = svc();
  await service.preflight();

  for (const chain of service.chains.values()) {
    const balance = await chain.provider().getBalance(key.address);
    slog.info('gas account', { chain: chain.name, address: key.address, balanceWei: balance.toString() });
    if (balance === 0n) {
      alerts.fire({
        kind: 'lifecycle',
        severity: 'warn',
        message: 'submitter has no balance on a configured chain — it cannot relay there',
        key: `nogas:${chain.chainId}`,
        fields: { chain: chain.name, chainId: chain.chainId, address: key.address },
      });
    }
  }

  await service.start();
  return { service, address: key.address, stop: () => service.stop() };
}

/** Best-effort human reason out of an ethers CALL_EXCEPTION. */
function decodeRevert(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; info?: { error?: { message?: string } }; message?: string };
  return e.reason ?? e.shortMessage ?? e.info?.error?.message ?? e.message ?? String(err);
}
