// The wire protocol, recomputed locally from first principles.
//
// Nothing in this file asks a chain, a peer or a config file what a transfer id
// or a signing digest is. Every value is derived here from the transfer fields,
// exactly as FerminuxBridge.sol derives them, and the on-chain values are then
// used only to CHECK this computation (src/verify.ts). A relayer that computes
// its digest by asking the contract can be pointed at a malicious contract; a
// relayer that computes it locally and compares cannot.
//
// Contract references:
//   transferIdOf()  -> keccak256(abi.encode(srcChainId, dstChainId, nonce,
//                       srcToken, dstToken, sender, recipient, amount))
//   hashTransfer()  -> EIP-712 over TRANSFER_TYPEHASH with transferId as the
//                      first member, domain = (name "FerminuxBridge", version
//                      "1", chainId = DESTINATION chain, verifyingContract =
//                      the destination bridge).

import {
  AbiCoder,
  Signature,
  TypedDataEncoder,
  getAddress,
  keccak256,
  recoverAddress,
  type Log,
  type TypedDataDomain,
} from 'ethers';

/** Exactly FerminuxBridge.BridgeTransfer. `amount` is the NET credited amount. */
export interface BridgeTransfer {
  srcChainId: number;
  dstChainId: number;
  nonce: number;
  srcToken: string;
  dstToken: string;
  sender: string;
  recipient: string;
  amount: bigint;
}

/** A `Sent` log, decoded and anchored to the block it was mined in. */
export interface SentEvent {
  transfer: BridgeTransfer;
  transferId: string;
  fee: bigint;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export const EIP712_DOMAIN_NAME = 'FerminuxBridge';
export const EIP712_DOMAIN_VERSION = '1';

/**
 * EIP-712 struct definition. The member order and types must match
 * FerminuxBridge.TRANSFER_TYPEHASH byte for byte; assertTypehash() proves it.
 */
export const TRANSFER_TYPES = {
  BridgeTransfer: [
    { name: 'transferId', type: 'bytes32' },
    { name: 'srcChainId', type: 'uint64' },
    { name: 'dstChainId', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'srcToken', type: 'address' },
    { name: 'dstToken', type: 'address' },
    { name: 'sender', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

const TRANSFER_TYPEHASH_STRING =
  'BridgeTransfer(bytes32 transferId,uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount)';

/** keccak256 of the type string in the contract. */
export const TRANSFER_TYPEHASH = keccak256(Buffer.from(TRANSFER_TYPEHASH_STRING, 'utf8'));

const coder = AbiCoder.defaultAbiCoder();

/** Globally unique transfer id — same preimage as FerminuxBridge.transferIdOf(). */
export function transferIdOf(t: BridgeTransfer): string {
  return keccak256(
    coder.encode(
      ['uint64', 'uint64', 'uint64', 'address', 'address', 'address', 'address', 'uint256'],
      [
        t.srcChainId,
        t.dstChainId,
        t.nonce,
        getAddress(t.srcToken),
        getAddress(t.dstToken),
        getAddress(t.sender),
        getAddress(t.recipient),
        t.amount,
      ],
    ),
  );
}

/**
 * The EIP-712 domain a signature is bound to. chainId is the DESTINATION chain
 * and verifyingContract is the DESTINATION bridge, so a signature produced for
 * one chain — or for a different deployment on the same chain — is worthless
 * anywhere else. Both arguments come from the caller's pinned config, never
 * from a peer and never from the transfer itself.
 */
export function domainFor(dstChainId: number, dstBridgeAddress: string): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: dstChainId,
    verifyingContract: getAddress(dstBridgeAddress),
  };
}

/** keccak256 of the abi-encoded EIP712Domain struct — comparable to the contract's. */
export function domainSeparatorFor(dstChainId: number, dstBridgeAddress: string): string {
  return TypedDataEncoder.hashDomain(domainFor(dstChainId, dstBridgeAddress));
}

/** The typed-data value object (transferId is a signed member, not a wrapper). */
export function typedValue(t: BridgeTransfer): Record<string, unknown> {
  return {
    transferId: transferIdOf(t),
    srcChainId: t.srcChainId,
    dstChainId: t.dstChainId,
    nonce: t.nonce,
    srcToken: getAddress(t.srcToken),
    dstToken: getAddress(t.dstToken),
    sender: getAddress(t.sender),
    recipient: getAddress(t.recipient),
    amount: t.amount,
  };
}

/**
 * The exact 32 bytes a validator signs — computed locally, identical to
 * FerminuxBridge.hashTransfer(t) executed on the destination chain.
 */
export function digestFor(t: BridgeTransfer, dstBridgeAddress: string): string {
  return TypedDataEncoder.hash(
    domainFor(t.dstChainId, dstBridgeAddress),
    TRANSFER_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    typedValue(t),
  );
}

/** secp256k1 n/2 — FerminuxBridge.HALF_CURVE_ORDER. */
export const HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Parse a 65-byte compact signature, rejecting exactly what FerminuxBridge's
 * _recover() rejects — and saying so in our own words, because this message ends
 * up in an operator's alert. Malleability matters here as much as on-chain:
 * (r, n−s) recovers a DIFFERENT address, so accepting a high-s signature into the
 * local store could let a peer occupy a validator's slot with a signature that
 * then reverts the whole execute() transaction.
 */
function parseSignature(signature: string): Signature {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('signature must be 65 bytes of hex');
  if (BigInt(`0x${signature.slice(66, 130)}`) > HALF_CURVE_ORDER) throw new Error('malleable signature (s > n/2)');
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new Error(`non-canonical v=${v} (must be 27 or 28)`);
  return Signature.from(signature);
}

/** Recover the signer of a 65-byte compact signature over `digest`. */
export function recoverSigner(digest: string, signature: string): string {
  return getAddress(recoverAddress(digest, parseSignature(signature)));
}

/** Split a 65-byte signature into the (v, r, s) tuple `execute()` expects. */
export function toSolidityTuple(signature: string): { v: number; r: string; s: string } {
  const sig = parseSignature(signature);
  return { v: sig.v, r: sig.r, s: sig.s };
}

/** Stable, human-readable key for a route. */
export function routeKey(srcChainId: number, dstChainId: number): string {
  return `${srcChainId}->${dstChainId}`;
}

/**
 * Decode a `Sent` log into a transfer, and verify the transfer id the contract
 * indexed matches the one we compute from the payload. A mismatch means either
 * the ABI drifted or the log did not come from a FerminuxBridge — both are
 * refuse-and-alert conditions, never "probably fine".
 */
export function decodeSentLog(log: Log, decoded: {
  transferId: string;
  dstChainId: bigint;
  localToken: string;
  srcChainId: bigint;
  nonce: bigint;
  remoteToken: string;
  sender: string;
  recipient: string;
  amount: bigint;
  fee: bigint;
}): SentEvent {
  const transfer: BridgeTransfer = {
    srcChainId: Number(decoded.srcChainId),
    dstChainId: Number(decoded.dstChainId),
    nonce: Number(decoded.nonce),
    srcToken: getAddress(decoded.localToken),
    dstToken: getAddress(decoded.remoteToken),
    sender: getAddress(decoded.sender),
    recipient: getAddress(decoded.recipient),
    amount: decoded.amount,
  };
  const computed = transferIdOf(transfer);
  if (computed.toLowerCase() !== decoded.transferId.toLowerCase()) {
    throw new Error(
      `transferId mismatch: event says ${decoded.transferId}, recomputed ${computed} ` +
        `(tx ${log.transactionHash} log ${log.index})`,
    );
  }
  return {
    transfer,
    transferId: computed,
    fee: decoded.fee,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.index,
  };
}

/** JSON-safe form for the durable store and the signature transport. */
export function serializeTransfer(t: BridgeTransfer): Record<string, string | number> {
  return {
    srcChainId: t.srcChainId,
    dstChainId: t.dstChainId,
    nonce: t.nonce,
    srcToken: t.srcToken,
    dstToken: t.dstToken,
    sender: t.sender,
    recipient: t.recipient,
    amount: t.amount.toString(),
  };
}

/**
 * Parse an untrusted transfer object (peer HTTP body, shared file, DB row).
 * Every field is type-checked and range-checked; a peer must never be able to
 * make this function produce a transfer the local node did not already believe in.
 */
export function parseTransfer(raw: unknown): BridgeTransfer {
  if (!raw || typeof raw !== 'object') throw new Error('transfer must be an object');
  const o = raw as Record<string, unknown>;
  const num = (k: string, max: bigint): number => {
    const v = o[k];
    const n = typeof v === 'string' || typeof v === 'number' ? BigInt(v) : null;
    if (n === null || n < 0n || n > max) throw new Error(`transfer.${k} invalid`);
    return Number(n);
  };
  const addr = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string') throw new Error(`transfer.${k} must be a string`);
    return getAddress(v);
  };
  const amountRaw = o.amount;
  if (typeof amountRaw !== 'string' && typeof amountRaw !== 'number') throw new Error('transfer.amount invalid');
  const amount = BigInt(amountRaw);
  if (amount <= 0n || amount > (1n << 256n) - 1n) throw new Error('transfer.amount out of range');
  const MAX_U64 = (1n << 64n) - 1n;
  return {
    srcChainId: num('srcChainId', MAX_U64),
    dstChainId: num('dstChainId', MAX_U64),
    nonce: num('nonce', MAX_U64),
    srcToken: addr('srcToken'),
    dstToken: addr('dstToken'),
    sender: addr('sender'),
    recipient: addr('recipient'),
    amount,
  };
}
