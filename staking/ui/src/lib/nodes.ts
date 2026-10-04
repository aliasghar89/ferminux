// NodeRegistry data layer — the network roster and the register-a-node flow
// for ../../contracts/src/NodeRegistry.sol (ABI fragments: ./abi.ts).
// No browser globals; exercised by the e2e suite under Node against the real
// contract deployed on a local anvil.

import {
  Contract,
  Signature,
  dataSlice,
  getAddress,
  keccak256,
  recoverAddress,
  solidityPackedKeccak256,
  type ContractRunner,
  type Provider,
  type Signer,
  type TransactionResponse,
} from 'ethers';
import { NODE_REGISTRY_ABI } from './abi.ts';
import { checkAddress } from './validate.ts';

export function registryContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, NODE_REGISTRY_ABI as unknown as string[], runner);
}

export interface NetworkNode {
  id: bigint;
  operator: string;
  consensusAddr: string;
  /** Address derived from the node's devp2p public key — its identity in the registry. */
  nodeAddress: string;
  /** Live bond of the linked validator-track position. */
  bondWei: bigint;
  /** The linked position carries the uptime boost (2.0× → 3.0×) right now. */
  boosted: boolean;
  /** End of the latest finalized epoch in which the node scored above zero; 0 = never. */
  lastSeen: number;
  /** Score in the latest finalized epoch that included the node, in bps. */
  uptimeBps: bigint;
}

export interface RegistryParams {
  /** Minimum bond per node (= the vault's MIN_VALIDATOR_STAKE). */
  minBondWei: bigint;
  /** Epoch score that switches the boost on (BOOST_THRESHOLD_BPS). */
  boostThresholdBps: bigint;
  /** A posted epoch takes effect only after this window (DISPUTE_WINDOW). */
  disputeWindowSeconds: number;
}

/**
 * The live roster: listActiveNodes() returns only nodes whose bonding position
 * is still Active and at or above the minimum — a node whose bond exited is
 * not shown as live.
 */
export async function fetchRoster(provider: Provider, registryAddress: string): Promise<NetworkNode[]> {
  const registry = registryContract(registryAddress, provider);
  const raw = (await registry.listActiveNodes()) as Array<{
    nodeId: bigint;
    operator: string;
    consensusAddr: string;
    nodeAddress: string;
    stake: bigint;
    boosted: boolean;
    lastSeen: bigint;
    lastUptimeBps: bigint;
  }>;
  return raw.map((n) => ({
    id: n.nodeId,
    operator: n.operator,
    consensusAddr: n.consensusAddr,
    nodeAddress: n.nodeAddress,
    bondWei: n.stake,
    boosted: n.boosted,
    lastSeen: Number(n.lastSeen),
    uptimeBps: n.lastUptimeBps,
  }));
}

export async function fetchRegistryParams(provider: Provider, registryAddress: string): Promise<RegistryParams> {
  const registry = registryContract(registryAddress, provider);
  const [minBond, threshold, window] = await Promise.all([
    registry.minBond() as Promise<bigint>,
    registry.BOOST_THRESHOLD_BPS() as Promise<bigint>,
    registry.DISPUTE_WINDOW() as Promise<bigint>,
  ]);
  return { minBondWei: minBond, boostThresholdBps: threshold, disputeWindowSeconds: Number(window) };
}

/** Which of these positions already bond a node (nodeIdByPosition ≠ 0) — one node per position. */
export async function fetchBondedPositions(
  provider: Provider,
  registryAddress: string,
  positionIds: bigint[],
): Promise<Set<string>> {
  const registry = registryContract(registryAddress, provider);
  const nodeIds = await Promise.all(positionIds.map((id) => registry.nodeIdByPosition(id) as Promise<bigint>));
  return new Set(positionIds.filter((_, i) => nodeIds[i] !== 0n).map((id) => id.toString()));
}

/* ------------------------------------------------------------------ *
 * Registration — the node key proves possession
 * ------------------------------------------------------------------ */

/**
 * The digest the node key signs: NodeRegistry.registrationDigest(), computed
 * locally. It binds chain, registry, operator (the wallet that sends the
 * registration), consensus address and position, so a signature can never be
 * replayed for another registration. Signed RAW — the contract runs ecrecover
 * on this hash directly, with no "\x19Ethereum Signed Message" prefix.
 */
export function registrationDigest(
  chainId: number | bigint,
  registryAddress: string,
  operator: string,
  consensusAddr: string,
  positionId: bigint,
): string {
  return solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'address', 'uint256'],
    ['FMX_NODE_REG_V1', chainId, registryAddress, operator, consensusAddr, positionId],
  );
}

export type SignatureCheck =
  | { ok: true; v: number; r: string; s: string }
  | { ok: false; error: string };

/**
 * Validate a pasted 65-byte possession signature BEFORE any transaction: it
 * must recover, over `digest`, to the address the registry derives from the
 * node's public key. Catches a signature from the wrong key or over a stale
 * digest (another position, consensus address or wallet) without spending gas.
 */
export function checkPossessionSignature(raw: string, digest: string, nodeAddress: string): SignatureCheck {
  const s = raw.trim();
  if (s === '') return { ok: false, error: 'Paste the signature the node key produced.' };
  const hex = s.startsWith('0x') ? s : `0x${s}`;
  if (!/^0x[0-9a-fA-F]{130}$/.test(hex)) {
    return { ok: false, error: 'A signature is 65 bytes: 0x followed by 130 hex characters (r, s, v).' };
  }
  let sig: Signature;
  let recovered: string;
  try {
    sig = Signature.from(hex);
    recovered = recoverAddress(digest, sig);
  } catch {
    return { ok: false, error: 'Not a valid secp256k1 signature.' };
  }
  if (recovered !== getAddress(nodeAddress)) {
    return {
      ok: false,
      error: 'This signature was not made by the node key in the enode URL over the digest shown — sign that digest with that node key.',
    };
  }
  return { ok: true, v: sig.v, r: sig.r, s: sig.s };
}

/** Explicit gas ceilings — see the note on GAS_LIMITS in staking.ts. */
export const REGISTER_GAS_LIMIT = 450_000n;
export const DEREGISTER_GAS_LIMIT = 200_000n;

export async function registerNode(
  signer: Signer,
  registryAddress: string,
  args: { pubkey: string; consensusAddr: string; positionId: bigint; signature: { v: number; r: string; s: string } },
): Promise<TransactionResponse> {
  const registry = registryContract(registryAddress, signer);
  const { pubkey, consensusAddr, positionId, signature } = args;
  const callArgs = [pubkey, consensusAddr, positionId, signature.v, signature.r, signature.s] as const;
  // Preflight surfaces the require string gas-free; the pinned limit avoids
  // estimate-drift out-of-gas (see GAS_LIMITS in staking.ts).
  await registry.registerNode.staticCall(...callArgs);
  return (await registry.registerNode(...callArgs, { gasLimit: REGISTER_GAS_LIMIT })) as TransactionResponse;
}

/** Free the node's bindings; any active uptime boost on its bond is dropped. */
export async function deregisterNode(
  signer: Signer,
  registryAddress: string,
  nodeId: bigint,
): Promise<TransactionResponse> {
  const registry = registryContract(registryAddress, signer);
  await registry.deregisterNode.staticCall(nodeId);
  return (await registry.deregisterNode(nodeId, { gasLimit: DEREGISTER_GAS_LIMIT })) as TransactionResponse;
}

/* ------------------------------------------------------------------ *
 * enode parsing — pure, unit-tested
 * ------------------------------------------------------------------ */

export interface ParsedEnode {
  /** 128-hex-char node public key. */
  pubkey: string;
  host: string;
  port: number;
}

/**
 * Parse an enode URL as printed by `admin.nodeInfo.enode` in the desktop app:
 * enode://<128 hex chars>@host:port[?discport=…]
 * Returns null rather than throwing — the form turns null into a field error.
 */
export function parseEnode(url: string): ParsedEnode | null {
  const m = /^enode:\/\/([0-9a-fA-F]{128})@([^:@\s]+):(\d{1,5})(?:\?.*)?$/.exec(url.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65_535) return null;
  return { pubkey: m[1].toLowerCase(), host: m[2], port };
}

/** The 64-byte public key registerNode() takes (no 0x04 prefix), as 0x-hex. */
export function enodePubkeyBytes(url: string): string | null {
  const parsed = parseEnode(url);
  return parsed ? `0x${parsed.pubkey}` : null;
}

/**
 * The node's on-chain identity, derived exactly as registerNode() does:
 * address(uint160(uint256(keccak256(pubkey)))). Host and port change with
 * reconnects; the key is the identity.
 */
export function enodeToNodeAddress(url: string): string | null {
  const pubkey = enodePubkeyBytes(url);
  if (!pubkey) return null;
  return getAddress(dataSlice(keccak256(pubkey), 12));
}

/** Consensus-address field validation for the register form (EIP-55 checked, checksummed result). */
export function checkConsensusAddress(raw: string): { ok: true; address: string } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: false, error: 'Enter the consensus signing address.' };
  return checkAddress(raw);
}
