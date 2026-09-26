// "A transaction just left this wallet": the connect window tells the wallet's
// open tabs (same origin, BroadcastChannel), so their balances, activity and
// NFTs follow at once and again when it lands, instead of on the next poll.
// Public data only (chain, sender, hash). No browser globals at import time:
// the Node tests import parseTxSignal.

const CHANNEL = 'ferminux-wallet-tx';

export interface TxSignal {
  chainId: number;
  from: string;
  hash: string;
}

export function parseTxSignal(data: unknown): TxSignal | null {
  const o = data as Partial<TxSignal> | null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.chainId !== 'number' || !Number.isSafeInteger(o.chainId) || o.chainId <= 0) return null;
  if (typeof o.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.from)) return null;
  if (typeof o.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.hash)) return null;
  return { chainId: o.chainId, from: o.from, hash: o.hash };
}

let sender: BroadcastChannel | null = null;

/** Announce a transaction this window sent. Best-effort: without BroadcastChannel the tabs' polls catch up. */
export function announceTx(s: TxSignal): void {
  try {
    sender ??= new BroadcastChannel(CHANNEL);
    sender.postMessage(s);
  } catch {
    /* no BroadcastChannel */
  }
}

/** Call `fn` for every transaction another window of this wallet announces. */
export function onTxAnnounced(fn: (s: TxSignal) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const bc = new BroadcastChannel(CHANNEL);
  bc.onmessage = (e: MessageEvent) => {
    const s = parseTxSignal(e.data);
    if (s) fn(s);
  };
  return () => bc.close();
}
