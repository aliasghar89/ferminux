// A pay-in sends on another chain (BNB Chain, Base…) after switchToChain and a balance check: awaits during which the
// user, or the wallet itself, can move to another network. eth_sendTransaction signs on whatever chain the wallet is
// on at that instant, and a quote's deposit address and token exist only on the chain the quote was made for — so the
// chain is read again immediately before the send, and the send is refused if it moved. Imports nothing, so the
// tests run it under plain Node.

/** The one EIP-1193 call this needs. */
export interface Requester {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** Thrown, with nothing sent, when the wallet is not on the chain the transaction was built for. */
export class ChainMovedError extends Error {
  expected: number;
  actual: number | null;
  constructor(expected: number, actual: number | null) {
    super(`The wallet is now on ${actual === null ? "an unknown network" : `chain ${actual}`}, not chain ${expected}, which this payment was quoted for. Nothing was sent — switch back and pay again.`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** eth_sendTransaction, only while the wallet reports `chainId`; resolves to what the wallet returned (the tx hash). */
export async function sendOnChain(eth: Requester, chainId: number, tx: Record<string, string>): Promise<unknown> {
  let actual: number | null = null;
  try {
    const n = parseInt(String(await eth.request({ method: "eth_chainId" })), 16);
    actual = Number.isNaN(n) ? null : n;
  } catch { /* unreadable: refused below like a move */ }
  if (actual !== chainId) throw new ChainMovedError(chainId, actual);
  return eth.request({ method: "eth_sendTransaction", params: [tx] });
}
