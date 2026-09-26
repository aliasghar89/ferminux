// Direct chain reads for the record pages (consensus, security). They read the nodes themselves, never
// the gateway's indexer, and every caller degrades to an em-dash when a read fails: a record page must
// never show a reassuring figure it could not actually fetch.
import { config } from "./config";

let rpcId = 0;
/** One JSON-RPC call with an 8 s ceiling. Throws on transport errors and on JSON-RPC errors. */
export async function rpcAt<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || "RPC error");
  if (j.result === undefined || j.result === null) throw new Error("empty result");
  return j.result;
}
/** The public Ferminux node. */
export const rpc = <T>(method: string, params: unknown[] = []) => rpcAt<T>(config.rpc, method, params);

/** eth_call at `latest`; tries each URL in turn and returns the first answer that is not empty. */
export async function ethCall(urls: string | string[], to: string, data: string): Promise<string> {
  let last: unknown = new Error("no endpoint");
  for (const u of Array.isArray(urls) ? urls : [urls]) {
    try {
      const out = await rpcAt<string>(u, "eth_call", [{ to, data }, "latest"]);
      if (out && out !== "0x") return out;
      last = new Error("empty return");
    } catch (e) { last = e; }
  }
  throw last;
}

/** 18-decimal (or `dp`) fixed-point hex → "1,234.5678" with at most `max` fractional digits. */
export function units(hex: string | bigint, dp = 18, max = 6): string {
  const v = typeof hex === "bigint" ? hex : BigInt(hex);
  const base = 10n ** BigInt(dp);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % base).toString().padStart(dp, "0").slice(0, max).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** ABI word helpers for hand-decoded returns (no ABI coder needed for these few reads). */
export const words = (hex: string): string[] => hex.slice(2).match(/.{64}/g) ?? [];
export const wordAddr = (w: string) => `0x${w.slice(24)}`;
export const pad32 = (hexNo0x: string) => hexNo0x.padStart(64, "0");
