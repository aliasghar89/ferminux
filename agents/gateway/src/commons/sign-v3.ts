// Addendum v3 signed requests. The v3 actions (memory.put/get/delete,
// webhook.set/delete) live in COMMONS_ACTIONS in ./sign.ts (byte-identical to
// the SDK copy). This module adds the signed GET/DELETE variant: same
// canonical message, but the body line hashes the raw empty string "" (spec
// "## G. Memory") — with "{}" (the SDK's `sign(action, {})`) accepted too.
import { getAddress, verifyMessage } from "ethers";
import { COMMONS_ACTIONS, COMMONS_TS_WINDOW_S, SignatureError, canonicalMessage, sha256Hex } from "./sign.js";

export const V3_ACTIONS = ["memory.put", "memory.get", "memory.delete", "memory.anchor", "webhook.set", "webhook.delete"] as const;
export type V3Action = (typeof V3_ACTIONS)[number];

/** Every signed action the gateway accepts (the 16 Commons actions + the 5 v3 ones, all in COMMONS_ACTIONS). */
export const ALL_ACTIONS = COMMONS_ACTIONS;
export type AnyAction = (typeof ALL_ACTIONS)[number];

/** sha256 of the empty string — the body line for signed GET/DELETE requests (memory, webhooks). */
export const EMPTY_BODY_HASH = sha256Hex("");

/**
 * verifySigned() that also accepts a raw-string `payload`, whose sha256 is used
 * verbatim as the body line (signed GET/DELETE hash the empty string, not "{}").
 * Same checks and error codes as ./sign.ts.
 */
export function verifySignedAny(
  action: string,
  envelope: { address?: unknown; ts?: unknown; sig?: unknown },
  payload: unknown,
  nowS: number = Math.floor(Date.now() / 1000),
): string {
  if (!(ALL_ACTIONS as readonly string[]).includes(action)) {
    throw new SignatureError(`unknown action "${action}"`, "bad_action");
  }
  let address: string;
  try {
    if (typeof envelope.address !== "string") throw new Error("missing");
    address = getAddress(envelope.address);
  } catch {
    throw new SignatureError("address must be a valid 0x address", "bad_address");
  }
  const ts = typeof envelope.ts === "string" ? Number(envelope.ts) : envelope.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isInteger(ts)) {
    throw new SignatureError("ts must be an integer unix timestamp in seconds", "bad_ts");
  }
  if (Math.abs(nowS - ts) > COMMONS_TS_WINDOW_S) {
    throw new SignatureError(`ts is outside the ±${COMMONS_TS_WINDOW_S}s window (server now=${nowS})`, "stale_ts");
  }
  if (typeof envelope.sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(envelope.sig)) {
    throw new SignatureError("sig must be a 65-byte 0x hex EIP-191 signature", "bad_sig");
  }
  const message = typeof payload === "string" ? canonicalMessageRaw(action, address, ts, payload) : canonicalMessage(action, address, ts, payload);
  let recovered: string;
  try {
    recovered = verifyMessage(message, envelope.sig);
  } catch {
    throw new SignatureError("signature could not be recovered", "bad_sig");
  }
  if (recovered !== address) {
    throw new SignatureError("signature does not match address (check the canonical message and body hash)", "sig_mismatch");
  }
  return address;
}

/** Canonical message whose body line is the sha256 of a raw string (e.g. "" for signed GETs). */
export function canonicalMessageRaw(action: string, address: string, ts: number, rawBody: string): string {
  return ["Ferminux Commons", `action: ${action}`, `address: ${getAddress(address)}`, `ts: ${Math.trunc(ts)}`, `body: ${sha256Hex(rawBody)}`].join("\n");
}
