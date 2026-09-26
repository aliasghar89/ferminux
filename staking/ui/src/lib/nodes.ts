// NodeRegistry data layer — the network roster and the register-a-node flow.
// No browser globals; exercised by the e2e suite under Node.
//
// ABI STATUS: coded to staking/DESIGN.md §5 (the design names the contract
// ValidatorRegistry; the roster the UI shows is its node list) and to the e2e
// fixture. Reconcile when the real contract lands in /staking/contracts.

import { Contract, keccak256, toUtf8Bytes, type ContractRunner, type Provider, type Signer, type TransactionResponse } from 'ethers';
import { checkAddress } from './validate.ts';

export const NODE_REGISTRY_ABI = [
  'function nodeCount() view returns (uint256)',
  'function getNodes() view returns (tuple(uint256 id, address operator, address consensusAddr, bytes32 enodeId, uint256 positionId, uint256 bond, uint256 registeredAt, uint256 lastSeen, uint256 uptimeBps, bool active)[])',
  'function registerNode(uint256 positionId, address consensusAddr, bytes32 enodeId) returns (uint256 id)',
  'function deregister(uint256 nodeId)',
  'function minBond() view returns (uint256)',
  'function validatorTier() view returns (uint256)',
  'event NodeRegistered(uint256 indexed id, address indexed operator, address consensusAddr, bytes32 enodeId, uint256 positionId)',
  'event NodeDeregistered(uint256 indexed id, address indexed operator)',
  'event UptimeAttested(uint256 indexed id, uint256 uptimeBps, uint256 timestamp)',
] as const;

export function registryContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, NODE_REGISTRY_ABI as unknown as string[], runner);
}

export interface NetworkNode {
  id: bigint;
  operator: string;
  consensusAddr: string;
  enodeId: string;
  positionId: bigint;
  bondWei: bigint;
  registeredAt: number;
  /** Unix seconds of the last watchtower attestation covering this node; 0 = none yet. */
  lastSeen: number;
  /** Attested uptime for the latest epoch, in bps. */
  uptimeBps: bigint;
  active: boolean;
}

export async function fetchRoster(provider: Provider, registryAddress: string): Promise<NetworkNode[]> {
  const registry = registryContract(registryAddress, provider);
  const raw = (await registry.getNodes()) as Array<
    [bigint, string, string, string, bigint, bigint, bigint, bigint, bigint, boolean]
  >;
  return raw.map((n) => ({
    id: n[0],
    operator: n[1],
    consensusAddr: n[2],
    enodeId: n[3],
    positionId: n[4],
    bondWei: n[5],
    registeredAt: Number(n[6]),
    lastSeen: Number(n[7]),
    uptimeBps: n[8],
    active: n[9],
  }));
}

export async function fetchRegistryParams(
  provider: Provider,
  registryAddress: string,
): Promise<{ minBondWei: bigint; validatorTier: number }> {
  const registry = registryContract(registryAddress, provider);
  const [minBond, tier] = await Promise.all([
    registry.minBond() as Promise<bigint>,
    registry.validatorTier() as Promise<bigint>,
  ]);
  return { minBondWei: minBond, validatorTier: Number(tier) };
}

/** Explicit gas ceiling — see the note on GAS_LIMITS in staking.ts. */
export const REGISTER_GAS_LIMIT = 350_000n;

export async function registerNode(
  signer: Signer,
  registryAddress: string,
  positionId: bigint,
  consensusAddr: string,
  enodeId: string,
): Promise<TransactionResponse> {
  const registry = registryContract(registryAddress, signer);
  // Preflight surfaces the require string gas-free; the pinned limit avoids
  // estimate-drift out-of-gas (see GAS_LIMITS in staking.ts).
  await registry.registerNode.staticCall(positionId, consensusAddr, enodeId);
  return (await registry.registerNode(positionId, consensusAddr, enodeId, {
    gasLimit: REGISTER_GAS_LIMIT,
  })) as TransactionResponse;
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

/**
 * The bytes32 node identity stored on-chain: keccak256 of the lowercase
 * public key (host/port change with reconnects; the key is the identity).
 */
export function enodeToId(url: string): string | null {
  const parsed = parseEnode(url);
  if (!parsed) return null;
  return keccak256(toUtf8Bytes(parsed.pubkey));
}

/** Consensus-address field validation for the register form (EIP-55 checked, checksummed result). */
export function checkConsensusAddress(raw: string): { ok: true; address: string } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: false, error: 'Enter the consensus signing address.' };
  return checkAddress(raw);
}
