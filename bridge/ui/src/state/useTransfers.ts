// In-flight transfer tracking: persist every transfer, then poll BOTH chains
// until the destination bridge says it landed.
//
// The source chain answers "was my transaction mined and how deep is it".
// Only the destination bridge can answer "did my money arrive" — so that is
// what is polled, rather than assuming success after n confirmations.

import { useCallback, useEffect, useRef, useState } from 'react';
import { FALLBACK_CONFIRMATIONS, POLL_MS, chainByKey } from '../config.ts';
import { chainConnection } from '../lib/rpc.ts';
import { isProcessed } from '../lib/bridge.ts';
import { deriveStatus, statusFromRecord, type TransferStatus } from '../lib/status.ts';
import {
  browserStore,
  inFlight,
  isInFlight,
  loadTransfers,
  patchTransfer,
  saveTransfers,
  upsertTransfer,
  type KeyValueStore,
  type TransferRecord,
} from '../lib/transfers.ts';

export interface TransfersApi {
  records: TransferRecord[];
  statuses: Record<string, TransferStatus>;
  /** True when storage is unavailable — transfers live for this session only. */
  ephemeral: boolean;
  add: (record: TransferRecord) => void;
  patch: (txHash: string, patch: Partial<TransferRecord>) => void;
  remove: (txHash: string) => void;
  refresh: () => void;
}

export function useTransfers(): TransfersApi {
  const storeRef = useRef<KeyValueStore | null>(null);
  if (storeRef.current === null) storeRef.current = browserStore();
  const store = storeRef.current;

  const [records, setRecords] = useState<TransferRecord[]>(() => (store ? loadTransfers(store) : []));
  const [statuses, setStatuses] = useState<Record<string, TransferStatus>>({});
  const [epoch, setEpoch] = useState(0);

  const recordsRef = useRef(records);
  recordsRef.current = records;

  const commit = useCallback(
    (next: TransferRecord[]) => {
      if (store) saveTransfers(store, next);
      return next;
    },
    [store],
  );

  const add = useCallback(
    (record: TransferRecord) => setRecords((prev) => commit(upsertTransfer(prev, record))),
    [commit],
  );
  const patch = useCallback(
    (txHash: string, p: Partial<TransferRecord>) => setRecords((prev) => commit(patchTransfer(prev, txHash, p))),
    [commit],
  );
  const remove = useCallback(
    (txHash: string) =>
      setRecords((prev) => commit(prev.filter((r) => r.txHash.toLowerCase() !== txHash.toLowerCase()))),
    [commit],
  );
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  // Seed a status for every record from what was persisted, so a reload shows
  // the last known truth immediately instead of an empty card.
  useEffect(() => {
    setStatuses((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of recordsRef.current) {
        if (!next[r.txHash]) {
          const chain = chainByKey(r.srcChainKey);
          next[r.txHash] = statusFromRecord(r, chain?.confirmations ?? FALLBACK_CONFIRMATIONS);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [records]);

  // Poll the in-flight set. Keyed on the hash list so patching a record does
  // not restart the loop, and a settled transfer drops out of it.
  const pendingKey = inFlight(records)
    .map((r) => r.txHash)
    .join(',');

  useEffect(() => {
    if (pendingKey === '') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollOne = async (record: TransferRecord) => {
      const srcChain = chainByKey(record.srcChainKey);
      const dstChain = chainByKey(record.dstChainKey);
      if (!srcChain) return;

      const { provider } = await chainConnection(srcChain);
      const [receipt, head] = await Promise.all([
        provider.getTransactionReceipt(record.txHash),
        provider.getBlockNumber(),
      ]);

      const destinationKnown = Boolean(dstChain && record.dstBridge && record.transferId);
      let destinationProcessed: boolean | null = null;
      const confirmed =
        receipt !== null && receipt.status === 1 && head - receipt.blockNumber + 1 >= srcChain.confirmations;
      if (destinationKnown && confirmed && dstChain) {
        try {
          const dst = await chainConnection(dstChain);
          destinationProcessed = await isProcessed(dst.provider, record.dstBridge, record.transferId);
        } catch {
          destinationProcessed = null; // destination RPC down: stay in Executing
        }
      }

      const status = deriveStatus({
        receiptStatus: receipt === null ? null : receipt.status === 1 ? 1 : 0,
        receiptBlockNumber: receipt?.blockNumber ?? null,
        srcBlockNumber: head,
        destinationProcessed,
        destinationKnown,
        requiredConfirmations: srcChain.confirmations,
      });

      if (!alive) return;
      setStatuses((prev) => ({ ...prev, [record.txHash]: status }));
      if (status.phase !== record.phase || (receipt && record.txBlockNumber !== receipt.blockNumber)) {
        patch(record.txHash, { phase: status.phase, txBlockNumber: receipt?.blockNumber ?? record.txBlockNumber });
      }
    };

    const tick = async () => {
      const pending = recordsRef.current.filter(isInFlight);
      await Promise.allSettled(pending.map((r) => pollOne(r)));
      if (alive) timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pendingKey, epoch, patch]);

  return { records, statuses, ephemeral: store === null, add, patch, remove, refresh };
}
