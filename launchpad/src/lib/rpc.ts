// ---------------------------------------------------------------------------
// Read-endpoint selection.
//
// The launchpad used to read through one hard-coded endpoint with no fallback:
// if that host failed, the fee showed "unavailable" and the registry was empty
// even though the second endpoint on the same chain was up.
// ---------------------------------------------------------------------------

/** First endpoint that answers eth_chainId with `chainId`, or null if none does. */
export async function pickRpc(urls: string[], chainId: number, timeoutMs = 5000): Promise<string | null> {
  for (const url of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: unknown };
        if (typeof body.result === "string" && Number(BigInt(body.result)) === chainId) return url;
      }
    } catch {
      /* try the next endpoint */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
