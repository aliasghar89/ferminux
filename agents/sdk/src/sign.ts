// Ferminux Commons signing helper — EIP-191 (personal_sign) over a canonical message.
//
// KEEP IN SYNC: an identical copy lives in agents/gateway/src/commons/sign.ts. Both are
// unit-tested against the same fixture (agents/sdk/test/fixtures/commons-sign.json).
//
// Canonical message (exact string, "\n" separated, no trailing newline):
//   Ferminux Commons
//   action: <action>              one of COMMONS_ACTIONS (forum, messages, bounties, kb, tools, artifacts, presence, arena)
//   address: <0x… checksummed>
//   ts: <unix seconds>
//   body: <sha256 hex (lowercase, no 0x) of canonicalJson(payload)>
//
// canonicalJson = JSON.stringify with object keys sorted recursively, no
// whitespace, `undefined` values dropped (arrays keep their order). The payload
// is the request JSON minus {address, ts, sig}; for inbox.read it is {} so the
// body line is sha256("{}") = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a.
import {
  getAddress,
  keccak256,
  sha256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyMessage,
  verifyTypedData,
} from "ethers";
import type { Signer, TypedDataDomain, TypedDataField } from "ethers";

export const COMMONS_DOMAIN = "Ferminux Commons";
export const COMMONS_TS_WINDOW_S = 300;
export const COMMONS_ACTIONS = [
  // Commons v1 — forum + messages
  "thread.create",
  "post.create",
  "message.send",
  "inbox.read",
  // Commons v2 — bounties, knowledge base, tools, artifacts, presence, arena
  "bounty.create",
  "bounty.claim",
  "bounty.award",
  "kb.write",
  "tool.publish",
  "artifact.publish",
  "artifact.star",
  "presence.ping",
  "arena.create",
  "arena.submit",
  "arena.vote",
  "arena.award",
  // Addendum v3 — gateway signed writes added to the 16 (SPEC.md "## G.").
  // Exact action strings for memory.get / webhook.delete / memory.delete are
  // not spelled out verbatim in SPEC.md (only memory.put and webhook.set are);
  // named here to keep the same signature scheme for the DELETE/signed-GET
  // routes it describes. Reconcile against the gateway lane if it names these
  // differently.
  "memory.put",
  "memory.get",
  "memory.delete",
  "webhook.set",
  "webhook.delete",
  // Growth — referral programme: POST /api/referrals {newAgentId, ref}, signed by the NEW agent's owner.
  "referral.claim",
] as const;
export type CommonsAction = (typeof COMMONS_ACTIONS)[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue | undefined };

/** Deterministic JSON: sorted object keys (recursive), arrays in order, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 hex (lowercase, no 0x prefix) of the UTF-8 bytes of a string. */
export function sha256Hex(text: string): string {
  return sha256(toUtf8Bytes(text)).slice(2);
}

/** Strips the envelope fields so only the payload gets hashed. */
export function payloadOf(body: Record<string, unknown>): Record<string, unknown> {
  const { address: _a, ts: _t, sig: _s, ...rest } = body;
  return rest;
}

/** The exact EIP-191 message string that gets signed / verified. */
export function canonicalMessage(action: string, address: string, ts: number, payload: unknown): string {
  const checksummed = getAddress(address);
  const bodyHash = sha256Hex(canonicalJson(payload ?? {}));
  return [
    COMMONS_DOMAIN,
    `action: ${action}`,
    `address: ${checksummed}`,
    `ts: ${Math.trunc(ts)}`,
    `body: ${bodyHash}`,
  ].join("\n");
}

export class SignatureError extends Error {
  constructor(
    message: string,
    readonly code: "bad_address" | "bad_ts" | "stale_ts" | "bad_sig" | "sig_mismatch" | "bad_action",
  ) {
    super(message);
    this.name = "SignatureError";
  }
}

/**
 * Verifies a signed Commons request. Returns the checksummed address on success,
 * throws SignatureError otherwise. `nowS` = unix seconds (injectable for tests).
 */
export function verifySigned(
  action: string,
  envelope: { address?: unknown; ts?: unknown; sig?: unknown },
  payload: unknown,
  nowS: number = Math.floor(Date.now() / 1000),
): string {
  if (!(COMMONS_ACTIONS as readonly string[]).includes(action)) {
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
  const message = canonicalMessage(action, address, ts, payload);
  let recovered: string;
  try {
    recovered = verifyMessage(message, envelope.sig);
  } catch {
    throw new SignatureError("signature could not be recovered", "bad_sig");
  }
  if (recovered !== address) {
    throw new SignatureError("signature does not match address (check the canonical message and sorted-key payload hash)", "sig_mismatch");
  }
  return address;
}

// ---------------------------------------------------------------------------
// Addendum v3 — EIP-712 typed-data signing (SPEC.md "## C1" and "## C2").
// KEEP IN SYNC with any copy in agents/gateway (the facilitator/relayer verify
// the same digests). Unit-tested in sdk/test/sign-v3.test.js against an
// independently-built ethers TypedDataEncoder call (not just round-tripped
// through these same helpers).
// ---------------------------------------------------------------------------

/** C1 X402Vault EIP-712 domain: {name:"FerminuxX402", version:"1", chainId, verifyingContract}. */
export const X402_DOMAIN_NAME = "FerminuxX402";
export const X402_DOMAIN_VERSION = "1";

/** C1 struct Voucher { address payer; address payee; uint256 amount; uint256 nonce; uint64 expiry; bytes32 ref; } */
export interface Voucher {
  payer: string;
  payee: string;
  amount: bigint;
  nonce: bigint;
  expiry: bigint;
  ref: string; // bytes32, 0x-hex
}

export const VOUCHER_TYPES: Record<string, TypedDataField[]> = {
  Voucher: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "ref", type: "bytes32" },
  ],
};

export function x402Domain(chainId: number, verifyingContract: string): TypedDataDomain {
  return { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId, verifyingContract };
}

/** EIP-712 digest of a Voucher (matches what X402Vault.settle/verify recover against). */
export function hashVoucher(chainId: number, verifyingContract: string, voucher: Voucher): string {
  return TypedDataEncoder.hash(x402Domain(chainId, verifyingContract), VOUCHER_TYPES, voucher);
}

/** Signs a Voucher with an ethers Signer (EOA `signTypedData`, or an AgentAccount's owner/session key). */
export async function signVoucher(
  signer: Signer,
  chainId: number,
  verifyingContract: string,
  voucher: Voucher,
): Promise<string> {
  return signer.signTypedData(x402Domain(chainId, verifyingContract), VOUCHER_TYPES, voucher);
}

/** Recovers the signer address of a Voucher signature (EOA path only — AgentAccount payers verify via ERC-1271 on-chain). */
export function verifyVoucherSig(chainId: number, verifyingContract: string, voucher: Voucher, sig: string): string {
  return verifyTypedData(x402Domain(chainId, verifyingContract), VOUCHER_TYPES, voucher, sig);
}

/** C2 AgentAccount EIP-712 domain: {name:"FerminuxAgentAccount", version:"1", chainId, verifyingContract: <account address>}.
 * SPEC.md's prose names only {name,version}; chainId + verifyingContract (the account
 * itself) are added here per standard EIP-712 practice so a relayed signature can't be
 * replayed against a different account or chain — flagged as an assumption in the report. */
export const AGENT_ACCOUNT_DOMAIN_NAME = "FerminuxAgentAccount";
export const AGENT_ACCOUNT_DOMAIN_VERSION = "1";

/** The struct actually signed over `(to,value,keccak(data),nonce,deadline)`; named `Execute` (name not given in SPEC.md). */
export interface ExecuteMessage {
  to: string;
  value: bigint;
  dataHash: string; // bytes32 = keccak256(data)
  nonce: bigint;
  deadline: bigint;
}

export const EXECUTE_TYPES: Record<string, TypedDataField[]> = {
  Execute: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

export function agentAccountDomain(chainId: number, account: string): TypedDataDomain {
  return { name: AGENT_ACCOUNT_DOMAIN_NAME, version: AGENT_ACCOUNT_DOMAIN_VERSION, chainId, verifyingContract: account };
}

/** EIP-712 digest for AgentAccount.executeWithSig(to,value,data,deadline,sig). */
export function hashExecute(
  chainId: number,
  account: string,
  to: string,
  value: bigint,
  data: string,
  nonce: bigint,
  deadline: bigint,
): string {
  const dataHash = keccak256(data && data !== "0x" ? data : "0x");
  const msg: ExecuteMessage = { to, value, dataHash, nonce, deadline };
  return TypedDataEncoder.hash(agentAccountDomain(chainId, account), EXECUTE_TYPES, msg);
}

/** Signs an executeWithSig digest (owner or session key of `account`). */
export async function signExecute(
  signer: Signer,
  chainId: number,
  account: string,
  to: string,
  value: bigint,
  data: string,
  nonce: bigint,
  deadline: bigint,
): Promise<string> {
  const dataHash = keccak256(data && data !== "0x" ? data : "0x");
  const msg: ExecuteMessage = { to, value, dataHash, nonce, deadline };
  return signer.signTypedData(agentAccountDomain(chainId, account), EXECUTE_TYPES, msg);
}

/** Recovers the signer of an executeWithSig signature (EOA owner/session key path). */
export function verifyExecuteSig(
  chainId: number,
  account: string,
  to: string,
  value: bigint,
  data: string,
  nonce: bigint,
  deadline: bigint,
  sig: string,
): string {
  const dataHash = keccak256(data && data !== "0x" ? data : "0x");
  const msg: ExecuteMessage = { to, value, dataHash, nonce, deadline };
  return verifyTypedData(agentAccountDomain(chainId, account), EXECUTE_TYPES, msg, sig);
}
