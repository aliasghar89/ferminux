// The bridge data layer: read the on-chain registry, read the rails, build the
// transactions, identify a transfer, and ask the destination whether it landed.
//
// NOTHING here is hardcoded per token — the token list, the fee, the caps and
// the route all come from the bridge contract itself, so a registry change on
// chain is visible in the UI without a redeploy of this app.
// No browser globals — the e2e suite drives these exact functions under Node.

import {
  AbiCoder,
  Contract,
  Interface,
  TypedDataEncoder,
  ZeroAddress,
  getAddress,
  keccak256,
  type JsonRpcProvider,
  type Provider,
  type TransactionReceipt,
} from 'ethers';
import {
  BRIDGE_ABI,
  BRIDGE_TOKEN_ABI,
  EIP712_NAME,
  EIP712_VERSION,
  ERC20_ABI,
  TRANSFER_TYPES,
  decodeTokenConfig,
  type DecodedTokenConfig,
} from './abi.ts';
import type { ChainConfig } from '../config.ts';

const bridgeInterface = new Interface(BRIDGE_ABI as unknown as string[]);
const erc20Interface = new Interface(ERC20_ABI as unknown as string[]);
const coder = AbiCoder.defaultAbiCoder();

export const NATIVE = ZeroAddress;

export function isNativeToken(address: string): boolean {
  return address.toLowerCase() === NATIVE.toLowerCase();
}

// ------------------------------------------------------------------- types
/**
 * Mirrors the TokenKind enum in FerminuxBridge.sol. A const object rather than
 * a TS `enum` so the module runs unmodified under Node's type stripping, which
 * is how the test suites drive this exact file.
 */
export const TokenKind = {
  UNREGISTERED: 0,
  CANONICAL: 1,
  WRAPPED: 2,
} as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export interface AssetMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

export interface RegistryEntry {
  /** Token address on THIS chain. ZeroAddress = the chain's native coin. */
  localToken: string;
  kind: TokenKind;
  paused: boolean;
  remoteChainId: number;
  /** Address on the remote chain. ZeroAddress = their native coin. */
  remoteToken: string;
  maxPerTransfer: bigint;
  dailyCap: bigint;
  meta: AssetMeta;
}

export interface BridgeConfig {
  address: string;
  chainId: number;
  paused: boolean;
  feeBps: bigint;
  threshold: number;
  validatorCount: number;
  owner: string;
  feeCollector: string;
  timelockDelaySeconds: number;
}

export interface RailState {
  /** Outbound usage in the rolling window, as the contract reports it now. */
  usage: bigint;
  /** Timestamp of the block the usage was read at — the UI decays from here. */
  atSeconds: number;
  dailyCap: bigint;
  maxPerTransfer: bigint;
  paused: boolean;
  balance: bigint | null;
  /** Allowance of the bridge over the user's tokens. null for the native coin. */
  allowance: bigint | null;
}

export interface BridgeTransferStruct {
  srcChainId: number;
  dstChainId: number;
  nonce: number;
  srcToken: string;
  dstToken: string;
  sender: string;
  recipient: string;
  amount: bigint;
}

export interface SentEvent extends BridgeTransferStruct {
  transferId: string;
  fee: bigint;
}

// ------------------------------------------------------------------ reading
export function bridgeContract(address: string, runner: Provider): Contract {
  return new Contract(getAddress(address), BRIDGE_ABI as unknown as string[], runner);
}

/** Global bridge parameters — fee, quorum, pause, ownership. */
export async function readBridgeConfig(provider: JsonRpcProvider, address: string): Promise<BridgeConfig> {
  const code = await provider.getCode(getAddress(address));
  if (code === '0x') {
    throw new Error(`No bridge contract is deployed at ${address} on this chain.`);
  }
  const c = bridgeContract(address, provider);
  const [paused, feeBps, threshold, validatorCount, owner, feeCollector, timelockDelay, network] = await Promise.all([
    c.paused() as Promise<boolean>,
    c.feeBps() as Promise<bigint>,
    c.threshold() as Promise<bigint>,
    c.validatorCount() as Promise<bigint>,
    c.owner() as Promise<string>,
    c.feeCollector() as Promise<string>,
    c.timelockDelay() as Promise<bigint>,
    provider.getNetwork(),
  ]);
  return {
    address: getAddress(address),
    chainId: Number(network.chainId),
    paused,
    feeBps,
    threshold: Number(threshold),
    validatorCount: Number(validatorCount),
    owner,
    feeCollector,
    timelockDelaySeconds: Number(timelockDelay),
  };
}

/** Metadata for one local asset. Native coins come from the chain config. */
export async function readAssetMeta(
  provider: JsonRpcProvider,
  chain: ChainConfig,
  token: string,
): Promise<AssetMeta> {
  if (isNativeToken(token)) {
    return {
      address: NATIVE,
      name: chain.native.name,
      symbol: chain.native.symbol,
      decimals: chain.native.decimals,
      isNative: true,
    };
  }
  const address = getAddress(token);
  const c = new Contract(address, ERC20_ABI as unknown as string[], provider);
  const [name, symbol, decimals] = await Promise.all([
    c.name() as Promise<string>,
    c.symbol() as Promise<string>,
    c.decimals() as Promise<bigint | number>,
  ]);
  return { address, name, symbol, decimals: Number(decimals), isNative: false };
}

/**
 * One token's registry entry, decoded from the raw return data.
 *
 * Deliberately NOT `contract.tokenConfig()`: see decodeTokenConfig() in abi.ts.
 * The struct lost a field between builds, and an ethers Contract answers a
 * shape it did not expect with a buffer overrun — which, inside the
 * `Promise.all` in readRegistry(), is a blank screen for every asset rather
 * than a bad reading of one.
 */
export async function readTokenConfig(
  provider: Provider,
  bridgeAddress: string,
  localToken: string,
): Promise<DecodedTokenConfig> {
  const data = bridgeInterface.encodeFunctionData('tokenConfig', [localToken]);
  return decodeTokenConfig(await provider.call({ to: getAddress(bridgeAddress), data }));
}

/**
 * The whole registry of the bridge on this chain, read from chain.
 * Tokens whose metadata cannot be read are still listed (with a placeholder
 * symbol) rather than silently dropped — a registered asset the UI cannot
 * describe is something the user should see, not something to hide.
 */
export async function readRegistry(
  provider: JsonRpcProvider,
  chain: ChainConfig,
  bridgeAddress: string,
): Promise<RegistryEntry[]> {
  const c = bridgeContract(bridgeAddress, provider);
  const count = Number((await c.registeredTokenCount()) as bigint);
  const addresses = await Promise.all(
    Array.from({ length: count }, (_, i) => c.registeredTokens(i) as Promise<string>),
  );
  const entries = await Promise.all(
    addresses.map(async (localToken): Promise<RegistryEntry> => {
      const cfg = await readTokenConfig(provider, bridgeAddress, localToken);
      let meta: AssetMeta;
      try {
        meta = await readAssetMeta(provider, chain, localToken);
      } catch {
        meta = {
          address: isNativeToken(localToken) ? NATIVE : getAddress(localToken),
          name: 'Unreadable token metadata',
          symbol: '???',
          decimals: 18,
          isNative: isNativeToken(localToken),
        };
      }
      return {
        localToken: isNativeToken(localToken) ? NATIVE : getAddress(localToken),
        kind: cfg.kind as TokenKind,
        paused: cfg.paused,
        remoteChainId: cfg.remoteChainId,
        remoteToken: cfg.remoteToken,
        maxPerTransfer: cfg.maxPerTransfer,
        dailyCap: cfg.dailyCap,
        meta,
      };
    }),
  );
  return entries;
}

/** Balance, allowance and the live rail state for one asset and one user. */
export async function readRailState(
  provider: JsonRpcProvider,
  bridgeAddress: string,
  entry: RegistryEntry,
  account: string | null,
): Promise<RailState> {
  const c = bridgeContract(bridgeAddress, provider);
  const native = isNativeToken(entry.localToken);
  const [usage, cfg, block] = await Promise.all([
    c.outboundUsage(entry.localToken) as Promise<bigint>,
    readTokenConfig(provider, bridgeAddress, entry.localToken),
    provider.getBlock('latest'),
  ]);

  let balance: bigint | null = null;
  let allowance: bigint | null = null;
  if (account) {
    if (native) {
      balance = await provider.getBalance(account);
    } else {
      const token = new Contract(entry.localToken, ERC20_ABI as unknown as string[], provider);
      [balance, allowance] = await Promise.all([
        token.balanceOf(account) as Promise<bigint>,
        token.allowance(account, getAddress(bridgeAddress)) as Promise<bigint>,
      ]);
    }
  }

  return {
    usage,
    atSeconds: block ? Number(block.timestamp) : Math.floor(Date.now() / 1000),
    dailyCap: cfg.dailyCap,
    maxPerTransfer: cfg.maxPerTransfer,
    paused: cfg.paused,
    balance,
    allowance,
  };
}

/** Provenance of a wrapped asset — which canonical asset it claims to mirror. */
export async function readWrapperProvenance(
  provider: JsonRpcProvider,
  token: string,
): Promise<{ bridge: string; originChainId: number; originToken: string } | null> {
  try {
    const c = new Contract(getAddress(token), BRIDGE_TOKEN_ABI as unknown as string[], provider);
    const [bridge, originChainId, originToken] = await Promise.all([
      c.bridge() as Promise<string>,
      c.originChainId() as Promise<bigint>,
      c.originToken() as Promise<string>,
    ]);
    return { bridge, originChainId: Number(originChainId), originToken };
  } catch {
    return null;
  }
}

export async function isProcessed(
  provider: JsonRpcProvider,
  bridgeAddress: string,
  transferId: string,
): Promise<boolean> {
  const c = bridgeContract(bridgeAddress, provider);
  return (await c.processed(transferId)) as boolean;
}

/**
 * The destination side of a route, as the destination bridge sees it.
 * A route is only usable when the two registrations mirror each other exactly;
 * `execute()` reverts otherwise, so this is worth checking before a user pays.
 */
export function routeMirrors(src: RegistryEntry, dst: RegistryEntry | undefined, srcChainId: number): boolean {
  if (!dst) return false;
  return (
    dst.remoteChainId === srcChainId &&
    dst.remoteToken.toLowerCase() === src.localToken.toLowerCase() &&
    dst.localToken.toLowerCase() === src.remoteToken.toLowerCase() &&
    ((src.kind === TokenKind.CANONICAL && dst.kind === TokenKind.WRAPPED) ||
      (src.kind === TokenKind.WRAPPED && dst.kind === TokenKind.CANONICAL))
  );
}

// -------------------------------------------------------------- transaction
export interface TxRequest {
  to: string;
  data: string;
  value: bigint;
}

/**
 * Whether this asset needs an approve() before send().
 *
 * Both registered kinds consume an allowance, for different reasons, and the UI
 * used to exempt WRAPPED on the belief that a burn is not a pull. It is: the
 * wrapper's burn() debits the holder's allowance exactly as transferFrom would,
 * so that no bridge — including one installed by a later rotation — can move a
 * balance nobody granted it. Skipping the approval sent every bridge-back
 * straight into "WTOKEN: burn exceeds allowance".
 *
 * The native coin is the only exemption, because it arrives as msg.value and
 * there is nothing to approve.
 */
export function requiresAllowance(entry: Pick<RegistryEntry, 'meta'>): boolean {
  return !entry.meta.isNative;
}

/** ERC-20 approve(bridge, amount). */
export function buildApproveTx(token: string, bridgeAddress: string, amountWei: bigint): TxRequest {
  return {
    to: getAddress(token),
    data: erc20Interface.encodeFunctionData('approve', [getAddress(bridgeAddress), amountWei]),
    value: 0n,
  };
}

/**
 * send(localToken, amount, dstChainId, recipient).
 * The native coin is passed as localToken = address(0) with msg.value = amount;
 * an ERC-20 is passed with msg.value = 0 (the contract rejects anything else).
 */
export function buildSendTx(
  bridgeAddress: string,
  localToken: string,
  amountWei: bigint,
  dstChainId: number,
  recipient: string,
): TxRequest {
  const token = isNativeToken(localToken) ? NATIVE : getAddress(localToken);
  return {
    to: getAddress(bridgeAddress),
    data: bridgeInterface.encodeFunctionData('send', [token, amountWei, dstChainId, getAddress(recipient)]),
    value: isNativeToken(localToken) ? amountWei : 0n,
  };
}

// ---------------------------------------------------------------- identity
/**
 * transferId = keccak256(abi.encode(srcChainId, dstChainId, nonce, srcToken,
 * dstToken, sender, recipient, amount)) — the same bytes the contract hashes in
 * transferIdOf(). Computed locally so the UI can identify a transfer without
 * trusting the event it just parsed.
 */
export function computeTransferId(t: BridgeTransferStruct): string {
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
 * The EIP-712 digest validators sign. The domain binds the DESTINATION chain id
 * and the destination bridge address, so a signature is worthless on any other
 * chain or any other deployment. Exposed so the UI (and the e2e suite) can
 * verify a digest against the destination contract's own hashTransfer().
 */
export function transferDigest(
  dstChainId: number,
  dstBridgeAddress: string,
  t: BridgeTransferStruct,
): string {
  const domain = {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: dstChainId,
    verifyingContract: getAddress(dstBridgeAddress),
  };
  return TypedDataEncoder.hash(domain, TRANSFER_TYPES as unknown as Record<string, { name: string; type: string }[]>, {
    transferId: computeTransferId(t),
    srcChainId: t.srcChainId,
    dstChainId: t.dstChainId,
    nonce: t.nonce,
    srcToken: getAddress(t.srcToken),
    dstToken: getAddress(t.dstToken),
    sender: getAddress(t.sender),
    recipient: getAddress(t.recipient),
    amount: t.amount,
  });
}

/**
 * Pull the Sent event out of the source receipt. The event — not the calldata —
 * is the truth: `Sent.amount` is NET of the bridge fee, so it is lower than what
 * the user typed, and it is the figure the validators sign and the destination
 * releases. (It is never lower for any other reason: the deposit either settles
 * the exact amount asked for or reverts — see the `inexact transfer` require in
 * FerminuxBridge.send().)
 */
export function parseSentFromReceipt(receipt: TransactionReceipt, bridgeAddress: string): SentEvent | null {
  const bridge = getAddress(bridgeAddress).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== bridge) continue;
    let parsed;
    try {
      parsed = bridgeInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'Sent') continue;
    const a = parsed.args;
    return {
      transferId: a.transferId as string,
      srcChainId: Number(a.srcChainId as bigint),
      dstChainId: Number(a.dstChainId as bigint),
      nonce: Number(a.nonce as bigint),
      srcToken: a.localToken as string,
      dstToken: a.remoteToken as string,
      sender: a.sender as string,
      recipient: a.recipient as string,
      amount: a.amount as bigint,
      fee: a.fee as bigint,
    };
  }
  return null;
}
