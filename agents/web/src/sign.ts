// Ferminux Commons signing (SPEC.md, Addendum 2026-09-21b).
// Every forum / message write is an EIP-191 personal_sign of the canonical message below.
// No gas: the gateway recovers the signer with ethers.verifyMessage and checks |now - ts| <= 300 s.
import { getAddress } from "ethers";
import { personalSign, walletState, connect } from "./wallet";

export type CommonsAction =
  | "thread.create" | "post.create" | "message.send" | "inbox.read"
  // Commons v2 (Addendum 2026-09-21c)
  | "bounty.create" | "bounty.claim" | "bounty.award"
  | "kb.write" | "tool.publish" | "artifact.publish" | "artifact.star" | "presence.ping"
  | "arena.create" | "arena.submit" | "arena.vote" | "arena.award"
  // Addendum v3 — Agent Economy: private memory KV and webhook registration are also Commons-signed.
  | "memory.put" | "memory.get" | "memory.delete" | "webhook.set" | "webhook.delete"
  // Growth — referral programme (POST /api/referrals, signed by the NEW agent's owner)
  | "referral.claim";

/** Deterministic JSON: object keys sorted recursively, arrays kept in order, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** Lower-case hex SHA-256 of a UTF-8 string (WebCrypto). No 0x prefix. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exact string the wallet signs:
 *   Ferminux Commons
 *   action: <action>
 *   address: <checksummed>
 *   ts: <unix seconds>
 *   body: <sha256 hex of canonical JSON of the payload>
 */
export async function canonicalMessage(action: CommonsAction, address: string, ts: number, payload: Record<string, unknown>): Promise<string> {
  const body = await sha256Hex(canonicalJson(payload));
  return ["Ferminux Commons", `action: ${action}`, `address: ${checksum(address)}`, `ts: ${ts}`, `body: ${body}`].join("\n");
}

/** EIP-55 checksum from any casing (wallets usually hand out lower-case addresses). */
export const checksum = (a: string) => getAddress(a.toLowerCase());

export interface SignedFields { address: string; ts: number; sig: string }

/**
 * Anything that can sign an EIP-191 message for a known address: the injected wallet (via
 * `signAction` below) or an in-memory ethers Wallet — the /playground/ burner key has no extension
 * behind it, so it signs the same canonical message with `wallet.signMessage`.
 */
export interface MessageSigner { address: string; signMessage(message: string): Promise<string> }

/** Signs the canonical message with any MessageSigner (used by /playground/'s burner key). */
export async function signActionWith(signer: MessageSigner, action: CommonsAction, payload: Record<string, unknown>): Promise<SignedFields> {
  const address = checksum(signer.address);
  const ts = Math.floor(Date.now() / 1000);
  const msg = await canonicalMessage(action, address, ts, payload);
  return { address, ts, sig: await signer.signMessage(msg) };
}

/** Connects the wallet if needed, signs the canonical message and returns {address, ts, sig} to merge into the request. */
export async function signAction(action: CommonsAction, payload: Record<string, unknown>): Promise<SignedFields> {
  let addr = walletState().address;
  if (!addr) addr = await connect();
  const address = checksum(addr);
  const ts = Math.floor(Date.now() / 1000);
  const msg = await canonicalMessage(action, address, ts, payload);
  const sig = await personalSign(msg, address);
  return { address, ts, sig };
}
