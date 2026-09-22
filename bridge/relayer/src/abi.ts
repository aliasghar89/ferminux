// Minimal ABI fragments for FerminuxBridge and BridgeToken.
//
// Hand-written on purpose: the relayer must not depend on forge build output at
// runtime, and a short explicit ABI is auditable next to the contract source.
// Every fragment here is copied from bridge/contracts/src/*.sol.
//
// Drift between this file and a live deployment is caught, not assumed away:
//   * verifyDomainSeparator() proves the address really is a FerminuxBridge on
//     the chain we think it is, before any read is trusted (chain.ts)
//   * verify.ts step 6 recomputes the EIP-712 digest locally and compares it
//     with the contract's own hashTransfer(), so a struct or typehash change
//     stops the validator instead of producing a signature over the wrong thing
//   * decodeTokenConfig() below reads the registry from the RETURN DATA rather
//     than trusting a fragment to match, because the TokenConfig struct is the
//     one shape that has actually changed shape during development

import { AbiCoder, getAddress } from 'ethers';

export const BRIDGE_ABI = [
  // ---- events
  'event Sent(bytes32 indexed transferId, uint64 indexed dstChainId, address indexed localToken, uint64 srcChainId, uint64 nonce, address remoteToken, address sender, address recipient, uint256 amount, uint256 fee)',
  'event Executed(bytes32 indexed transferId, uint64 indexed srcChainId, address indexed localToken, address remoteToken, address recipient, uint256 amount, uint256 signatureCount)',
  'event Paused(address indexed account)',
  'event Unpaused(address indexed account)',
  'event TokenPaused(address indexed localToken, address indexed account)',
  'event ActionQueued(uint256 indexed actionId, bytes4 indexed selector, bytes data, uint64 eta)',
  'event ValidatorAdded(address indexed validator)',
  'event ValidatorRemoved(address indexed validator)',
  'event ThresholdChanged(uint256 threshold)',

  // ---- views the relayer trusts over anything in its own config
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function transferIdOf((uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount) t) pure returns (bytes32)',
  'function hashTransfer((uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount) t) view returns (bytes32)',
  'function processed(bytes32 transferId) view returns (bool)',
  'function threshold() view returns (uint256)',
  'function getValidators() view returns (address[])',
  'function isValidator(address) view returns (bool)',
  'function paused() view returns (bool)',
  'function outboundNonce() view returns (uint64)',
  'function tokenConfig(address localToken) view returns ((uint8 kind,bool paused,uint64 remoteChainId,address remoteToken,uint256 maxPerTransfer,uint256 dailyCap))',
  'function remoteBridge(uint64 remoteChainId) view returns (address)',
  'function lockedBalance(address token) view returns (uint256)',
  'function inboundUsage(address localToken) view returns (uint256)',
  'function outboundUsage(address localToken) view returns (uint256)',

  // ---- the one state-changing call the submitter ever makes
  'function execute((uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount) t, (uint8 v,bytes32 r,bytes32 s)[] sigs)',

  // ---- outbound, used by the e2e harness only (never by the service itself)
  'function send(address localToken, uint256 amount, uint64 dstChainId, address recipient) payable returns (bytes32)',
] as const;

/** FerminuxBridge.TokenKind */
export const TOKEN_KIND_UNREGISTERED = 0;
export const TOKEN_KIND_CANONICAL = 1;
export const TOKEN_KIND_WRAPPED = 2;

/** FerminuxBridge.TokenConfig. */
export interface OnChainTokenConfig {
  kind: bigint;
  paused: boolean;
  remoteChainId: bigint;
  remoteToken: string;
  maxPerTransfer: bigint;
  dailyCap: bigint;
}

/**
 * The current TokenConfig layout: every member is a static type, so the return
 * data of `tokenConfig()` is exactly one 32-byte word per member.
 */
const TOKEN_CONFIG_LAYOUT = ['uint8', 'bool', 'uint64', 'address', 'uint256', 'uint256'] as const;

/**
 * The layout that existed while the bridge carried a LOSSY token class. That
 * class was removed — v1 settles STRICT only — so nothing should ever answer
 * with this shape. It is named here so that if something does, this process says
 * WHICH contract it is talking to instead of silently reading `remoteChainId`
 * out of the old `lossy` bool and refusing every transfer for the wrong reason.
 */
const TOKEN_CONFIG_LAYOUT_WITH_LOSSY = ['uint8', 'bool', 'bool', 'uint64', 'address', 'uint256', 'uint256'] as const;

/**
 * Decode `tokenConfig()` return data without trusting a fragment to match.
 *
 * A static tuple is length-discriminated: 6 words is this build's registry, 7 is
 * a pre-v1 deployment that still has the removed `lossy` field. Reading the
 * length first means an arity change is reported as an arity change — the
 * alternative is ethers decoding six words out of seven and handing back a
 * `remoteToken` of 0x…0038, which reads like a routing bug and is not one.
 */
export function decodeTokenConfig(data: string): OnChainTokenConfig {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error(`tokenConfig() returned something that is not hex data: ${String(data).slice(0, 32)}`);
  }
  const bytes = (data.length - 2) / 2;
  if (bytes === 0) {
    throw new Error('tokenConfig() returned no data — the bridge address holds no contract on this chain');
  }
  if (bytes % 32 !== 0) throw new Error(`tokenConfig() returned ${bytes} bytes, which is not a whole number of words`);
  const words = bytes / 32;

  const layout =
    words === TOKEN_CONFIG_LAYOUT.length
      ? TOKEN_CONFIG_LAYOUT
      : words === TOKEN_CONFIG_LAYOUT_WITH_LOSSY.length
        ? TOKEN_CONFIG_LAYOUT_WITH_LOSSY
        : null;
  if (!layout) {
    throw new Error(
      `tokenConfig() returned ${words} field(s); this relayer understands ${TOKEN_CONFIG_LAYOUT.length}. ` +
        'The destination bridge is not the contract this build was written against — check the address and the deployed version.',
    );
  }

  const v = AbiCoder.defaultAbiCoder().decode([...layout], data);
  // Drop the retired `lossy` bool if this is the older shape; every other field
  // keeps its position, so one offset covers the whole difference.
  const off = layout === TOKEN_CONFIG_LAYOUT_WITH_LOSSY ? 1 : 0;
  return {
    kind: BigInt(v[0] as bigint | number),
    paused: Boolean(v[1]),
    remoteChainId: BigInt(v[2 + off] as bigint | number),
    remoteToken: getAddress(String(v[3 + off])),
    maxPerTransfer: BigInt(v[4 + off] as bigint),
    dailyCap: BigInt(v[5 + off] as bigint),
  };
}

/**
 * The subset of FerminuxBridge this service calls, typed.
 *
 * ethers' Contract is an index-signature proxy, so without this every call site
 * would be `possibly undefined` — and, worse, a typo in a method name would be a
 * runtime surprise instead of a compile error. In a process that holds a signing
 * key, "runtime surprise" is not an acceptable failure mode.
 */
export interface BridgeContract {
  DOMAIN_SEPARATOR(): Promise<string>;
  processed(transferId: string): Promise<boolean>;
  threshold(): Promise<bigint>;
  getValidators(): Promise<string[]>;
  isValidator(account: string): Promise<boolean>;
  paused(): Promise<boolean>;
  outboundNonce(): Promise<bigint>;
  lockedBalance(token: string): Promise<bigint>;
  inboundUsage(token: string): Promise<bigint>;
  outboundUsage(token: string): Promise<bigint>;
  tokenConfig(localToken: string): Promise<OnChainTokenConfig>;
  hashTransfer(transfer: readonly unknown[]): Promise<string>;
  transferIdOf(transfer: readonly unknown[]): Promise<string>;
  execute: {
    (transfer: readonly unknown[], sigs: readonly unknown[], overrides?: Record<string, unknown>): Promise<{ hash: string; wait(): Promise<unknown> }>;
    staticCall(transfer: readonly unknown[], sigs: readonly unknown[], overrides?: Record<string, unknown>): Promise<unknown>;
    estimateGas(transfer: readonly unknown[], sigs: readonly unknown[], overrides?: Record<string, unknown>): Promise<bigint>;
    populateTransaction(transfer: readonly unknown[], sigs: readonly unknown[]): Promise<{ to?: string | null; data?: string }>;
  };
  send: {
    (localToken: string, amount: bigint, dstChainId: number, recipient: string, overrides?: Record<string, unknown>): Promise<{ hash: string; wait(): Promise<unknown> }>;
  };
}
