// "The wallet was locked here": every other tab and connect window of this
// wallet (same origin, BroadcastChannel) drops the keys it decrypted from the
// stored vault, so pressing Lock before walking away locks the wallet, not
// one tab of it. ("Forget this device" needs no message: the vault's removal
// reaches the other windows as a storage event.) Carries nothing but the word.
// No browser globals at import time: the Node tests import parseLockSignal.

const CHANNEL = 'ferminux-wallet-lock';

export function parseLockSignal(data: unknown): 'lock' | null {
  return (data as { type?: unknown } | null)?.type === 'lock' ? 'lock' : null;
}

let sender: BroadcastChannel | null = null;

/** Tell the other windows. Best-effort: without BroadcastChannel each window still has its idle lock. */
export function announceLock(): void {
  try {
    sender ??= new BroadcastChannel(CHANNEL);
    sender.postMessage({ type: 'lock' });
  } catch {
    /* no BroadcastChannel */
  }
}

/** Call `fn` whenever another window of this wallet is locked by hand. */
export function onLockAnnounced(fn: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const bc = new BroadcastChannel(CHANNEL);
  bc.onmessage = (e: MessageEvent) => {
    if (parseLockSignal(e.data)) fn();
  };
  return () => bc.close();
}
