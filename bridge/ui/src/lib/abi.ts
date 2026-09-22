// Human-readable ABI fragments for the exact contracts in ../../contracts/src.
// Only the functions and events this app actually uses are listed — an ABI is a
// trust surface, so it stays as small as the feature set allows.
// No browser globals: this module is imported by the Node test suites.

import { AbiCoder, getAddress } from 'ethers';

/** FerminuxBridge — src/FerminuxBridge.sol */
export const BRIDGE_ABI = [
  // --- config / views
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function feeCollector() view returns (address)',
  'function threshold() view returns (uint256)',
  'function validatorCount() view returns (uint256)',
  'function getValidators() view returns (address[])',
  'function timelockDelay() view returns (uint64)',
  'function outboundNonce() view returns (uint64)',
  'function BPS_DENOMINATOR() view returns (uint256)',
  'function MAX_FEE_BPS() view returns (uint256)',
  'function WINDOW() view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  // --- registry
  'function registeredTokenCount() view returns (uint256)',
  'function registeredTokens(uint256) view returns (address)',
  'function tokenConfig(address localToken) view returns (tuple(uint8 kind, bool paused, uint64 remoteChainId, address remoteToken, uint256 maxPerTransfer, uint256 dailyCap))',
  'function remoteBridge(uint64 remoteChainId) view returns (address)',
  // --- rails
  'function outboundUsage(address localToken) view returns (uint256)',
  'function inboundUsage(address localToken) view returns (uint256)',
  'function lockedBalance(address token) view returns (uint256)',
  // --- transfers
  'function processed(bytes32 transferId) view returns (bool)',
  'function transferIdOf(tuple(uint64 srcChainId, uint64 dstChainId, uint64 nonce, address srcToken, address dstToken, address sender, address recipient, uint256 amount) t) pure returns (bytes32)',
  'function hashTransfer(tuple(uint64 srcChainId, uint64 dstChainId, uint64 nonce, address srcToken, address dstToken, address sender, address recipient, uint256 amount) t) view returns (bytes32)',
  'function send(address localToken, uint256 amount, uint64 dstChainId, address recipient) payable returns (bytes32 transferId)',
  'function execute(tuple(uint64 srcChainId, uint64 dstChainId, uint64 nonce, address srcToken, address dstToken, address sender, address recipient, uint256 amount) t, tuple(uint8 v, bytes32 r, bytes32 s)[] sigs)',
  // --- events
  'event Sent(bytes32 indexed transferId, uint64 indexed dstChainId, address indexed localToken, uint64 srcChainId, uint64 nonce, address remoteToken, address sender, address recipient, uint256 amount, uint256 fee)',
  'event Executed(bytes32 indexed transferId, uint64 indexed srcChainId, address indexed localToken, address remoteToken, address recipient, uint256 amount, uint256 signatureCount)',
] as const;

/**
 * TokenConfig, decoded from `tokenConfig()`'s RETURN DATA rather than through
 * the fragment above.
 *
 * Every member of the struct is a static type, so the answer is exactly one
 * 32-byte word per member and the word COUNT identifies the layout. That is
 * worth using, because this struct is the one shape in the contract that has
 * changed during development: it briefly carried a `lossy` bool for the LOSSY
 * token class, which v1 does not have. An ethers Contract cannot tell a shorter
 * tuple from a shorter answer — it either throws a buffer overrun that surfaces
 * as a blank app, or reads six of seven words and hands back a `remoteToken` of
 * 0x…0038. Reading the length first means the app renders against either
 * deployment, and says precisely what it found when it is neither.
 */
const TOKEN_CONFIG_LAYOUT = ['uint8', 'bool', 'uint64', 'address', 'uint256', 'uint256'] as const;
/** The pre-v1 layout, with the removed `lossy` bool in third position. */
const TOKEN_CONFIG_LAYOUT_WITH_LOSSY = ['uint8', 'bool', 'bool', 'uint64', 'address', 'uint256', 'uint256'] as const;

export interface DecodedTokenConfig {
  kind: number;
  paused: boolean;
  remoteChainId: number;
  remoteToken: string;
  maxPerTransfer: bigint;
  dailyCap: bigint;
}

export function decodeTokenConfig(data: string): DecodedTokenConfig {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error(`tokenConfig() did not return hex data: ${String(data).slice(0, 32)}`);
  }
  const bytes = (data.length - 2) / 2;
  if (bytes === 0) throw new Error('tokenConfig() returned no data — no bridge contract at this address on this chain');
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
      `tokenConfig() returned ${words} field(s); this app understands ${TOKEN_CONFIG_LAYOUT.length}. ` +
        'This bridge address is not the contract this build was written against.',
    );
  }

  const v = AbiCoder.defaultAbiCoder().decode([...layout], data);
  // One offset covers the whole difference: dropping `lossy` shifts nothing else.
  const off = layout === TOKEN_CONFIG_LAYOUT_WITH_LOSSY ? 1 : 0;
  return {
    kind: Number(v[0]),
    paused: Boolean(v[1]),
    remoteChainId: Number(v[2 + off]),
    remoteToken: getAddress(String(v[3 + off])),
    maxPerTransfer: BigInt(v[4 + off] as bigint),
    dailyCap: BigInt(v[5 + off] as bigint),
  };
}

/** The ERC-20 surface the bridge UI needs (metadata, balance, allowance, approve). */
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
] as const;

/** BridgeToken provenance — proves which asset a wrapper claims to mirror. */
export const BRIDGE_TOKEN_ABI = [
  'function bridge() view returns (address)',
  'function originChainId() view returns (uint64)',
  'function originToken() view returns (address)',
] as const;

/** EIP-712 type of the struct validators sign. Must mirror TRANSFER_TYPEHASH. */
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

export const EIP712_NAME = 'FerminuxBridge';
export const EIP712_VERSION = '1';

/** The zero address — the registry's stand-in for a chain's native coin. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
