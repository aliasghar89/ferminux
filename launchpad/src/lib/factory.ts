// ---------------------------------------------------------------------------
// TokenFactory data layer.
//
// This module is the ONLY place the app talks to the contracts, and it is
// imported unchanged by scripts/e2e.mjs — the e2e test exercises exactly the
// code paths the UI runs in production. Keep it free of browser/Vite globals.
// ---------------------------------------------------------------------------

import { Contract, ZeroAddress, formatUnits } from "ethers";
import type { ContractRunner } from "ethers";

export const FACTORY_ABI = [
  "function launchFee() view returns (uint256)",
  "function feeCollector() view returns (address)",
  "function totalLaunched() view returns (uint256)",
  "function tokenCount() view returns (uint256)",
  "function isFactoryToken(address token) view returns (bool)",
  "function tokensOf(address creator) view returns (address[])",
  "function tokensPage(uint256 offset, uint256 limit) view returns (tuple(address token, address creator, string name, string symbol, uint256 createdAt, bool mintable)[])",
  "function launch(string name_, string symbol_, uint8 decimals_, uint256 initialSupply, uint256 maxSupply, bool mintable_) payable returns (address)",
  "event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 initialSupply, bool mintable)",
] as const;

export const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function mintable() view returns (bool)",
  "function renounceOwnership()",
] as const;

/** One row of the on-chain registry (TokenFactory.tokens). */
export interface RegistryEntry {
  token: string;
  creator: string;
  name: string;
  symbol: string;
  /** unix seconds */
  createdAt: number;
  mintable: boolean;
}

/** Registry row + live state read from the token contract itself. */
export interface TokenDetails extends RegistryEntry {
  owner: string;
  totalSupply: bigint;
  decimals: number;
  maxSupply: bigint;
}

export interface TrustBadges {
  /** Listed in the factory registry — unmodified, known bytecode. */
  factoryVerified: boolean;
  /** owner() == address(0): nobody can ever mint again. */
  renounced: boolean;
  /** mintable == false: supply fixed at launch, forever. */
  fixedSupply: boolean;
}

export interface LaunchParams {
  name: string;
  symbol: string;
  decimals: number;
  /** raw units (already scaled by decimals) */
  initialSupply: bigint;
  /** raw units; 0n = uncapped */
  maxSupply: bigint;
  mintable: boolean;
}

export function factoryContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, FACTORY_ABI, runner);
}

export function tokenContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, TOKEN_ABI, runner);
}

/** Live launch fee in wei — never hardcode this in the UI. */
export async function getLaunchFee(factory: Contract): Promise<bigint> {
  return await factory.launchFee();
}

/** Where launch fees go: feeCollector() on the factory. */
export async function getFeeCollector(factory: Contract): Promise<string> {
  return await factory.feeCollector();
}

/**
 * True when the collector is an address no one holds a key for, so every fee
 * paid to it is gone for good. The live factory's collector is 0x…dEaD (set by
 * the multisig at block 2143); it is read live rather than assumed, so a
 * devnet or a later factory with a real collector is described correctly.
 */
export function isBurnAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ZeroAddress || a === "0x000000000000000000000000000000000000dead";
}

export async function getTokenCount(factory: Contract): Promise<number> {
  return Number(await factory.tokenCount());
}

/**
 * Newest-first pagination on top of the ascending on-chain registry.
 * Page 0 holds the most recently launched tokens.
 */
export async function getTokensNewestFirst(
  factory: Contract,
  page: number,
  pageSize: number,
): Promise<{ entries: RegistryEntry[]; total: number }> {
  if (page < 0 || pageSize <= 0) throw new Error("bad page/pageSize");
  const total = await getTokenCount(factory);
  const end = total - page * pageSize; // exclusive, in ascending order
  if (end <= 0) return { entries: [], total };
  const start = Math.max(0, end - pageSize);
  const raw = await factory.tokensPage(BigInt(start), BigInt(end - start));
  const ascending: RegistryEntry[] = raw.map(
    (r: { token: string; creator: string; name: string; symbol: string; createdAt: bigint; mintable: boolean }) => ({
      token: r.token,
      creator: r.creator,
      name: r.name,
      symbol: r.symbol,
      createdAt: Number(r.createdAt),
      mintable: r.mintable,
    }),
  );
  return { entries: ascending.reverse(), total };
}

/** Fetch live per-token state (owner / supply / decimals / cap). */
export async function getTokenDetails(
  runner: ContractRunner,
  entry: RegistryEntry,
): Promise<TokenDetails> {
  const token = tokenContract(entry.token, runner);
  const [owner, totalSupply, decimals, maxSupply] = await Promise.all([
    token.owner() as Promise<string>,
    token.totalSupply() as Promise<bigint>,
    token.decimals() as Promise<bigint>,
    token.maxSupply() as Promise<bigint>,
  ]);
  return { ...entry, owner, totalSupply, decimals: Number(decimals), maxSupply };
}

/** Trust-badge logic — single source of truth for UI and tests. */
export function trustBadges(d: Pick<TokenDetails, "owner" | "mintable">): TrustBadges {
  return {
    factoryVerified: true, // every entry comes from the factory registry
    renounced: d.owner === ZeroAddress,
    fixedSupply: !d.mintable,
  };
}

/**
 * Launch a token through the factory, paying `fee` wei of native FMX.
 * Returns the new token address parsed from the TokenLaunched event.
 */
export async function launchToken(
  factory: Contract,
  params: LaunchParams,
  fee: bigint,
): Promise<{ token: string; txHash: string }> {
  const tx = await factory.launch(
    params.name,
    params.symbol,
    params.decimals,
    params.initialSupply,
    params.maxSupply,
    params.mintable,
    { value: fee },
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("launch transaction failed");
  const factoryAddress = (await factory.getAddress()).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factoryAddress) continue;
    const parsed = factory.interface.parseLog(log);
    if (parsed?.name === "TokenLaunched") {
      return { token: parsed.args.token as string, txHash: receipt.hash };
    }
  }
  throw new Error("TokenLaunched event not found in receipt");
}

// ------------------------------------------------------------- formatting

/** "10 FMX" from 10_000000000000000000n — trims trailing zeros. */
export function formatFmx(wei: bigint): string {
  return `${trimDecimal(formatUnits(wei, 18))} FMX`;
}

/** Token amount with thousands separators, e.g. 1,000,000. */
export function formatAmount(raw: bigint, decimals: number): string {
  const s = trimDecimal(formatUnits(raw, decimals));
  const [int, frac] = s.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

function trimDecimal(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
