// ---------------------------------------------------------------------------
// The pool data layer: read every pair out of the factory, with reserves,
// LP supply and both tokens' metadata, and index them for routing.
//
// One snapshot object is the single source of truth for the Pools list, the
// Liquidity tab and the swap router — so a price shown in one place cannot
// disagree with a price shown in another.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

import { Contract, type ContractRunner } from 'ethers';
import { FACTORY_ABI, PAIR_ABI } from './abi.ts';
import { shortAddress, toChecksum } from './amounts.ts';
import type { HopReserves } from './math.ts';
import { fetchTokenMeta, wfmxToken, type TokenInfo } from './tokens.ts';
import type { DexAddresses } from '../config.ts';
import { PRELOADED_TOKENS } from '../config.ts';

export interface PairSnapshot {
  /** The pool contract (a FerminuxPair, and its own LP ERC-20). */
  pair: string;
  token0: TokenInfo;
  token1: TokenInfo;
  reserve0: bigint;
  reserve1: bigint;
  /** LP tokens in circulation, MINIMUM_LIQUIDITY included. */
  totalSupply: bigint;
  /** Pair's last reserve-update timestamp (uint32, wraps in 2106). */
  blockTimestampLast: number;
}

export function factoryContract(addresses: DexAddresses, runner: ContractRunner): Contract {
  return new Contract(toChecksum(addresses.factory), FACTORY_ABI as unknown as string[], runner);
}

export function pairContract(pair: string, runner: ContractRunner): Contract {
  return new Contract(toChecksum(pair), PAIR_ABI as unknown as string[], runner);
}

// ---------------------------------------------------------------- metadata --

/**
 * Token metadata cache. Pools are permissionless, so a pair can hold a token
 * whose `symbol()` reverts; that must degrade to a placeholder row rather than
 * blank the whole page.
 */
export class TokenMetaCache {
  private readonly byAddress = new Map<string, TokenInfo>();

  constructor(wfmxAddress?: string) {
    if (wfmxAddress) this.put(wfmxToken(wfmxAddress));
    for (const t of PRELOADED_TOKENS) {
      this.put({ kind: 'erc20', address: toChecksum(t.address), symbol: t.symbol, name: t.name, decimals: t.decimals });
    }
  }

  put(token: TokenInfo): void {
    this.byAddress.set(token.address.toLowerCase(), token);
  }

  peek(address: string): TokenInfo | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  all(): TokenInfo[] {
    return [...this.byAddress.values()];
  }

  /** Cached read; never throws — an unreadable token comes back flagged. */
  async get(runner: ContractRunner, address: string): Promise<TokenInfo> {
    const checksummed = toChecksum(address);
    const hit = this.byAddress.get(checksummed.toLowerCase());
    if (hit) return hit;
    let meta: TokenInfo;
    try {
      meta = await fetchTokenMeta(runner, checksummed);
    } catch {
      meta = {
        kind: 'erc20',
        address: checksummed,
        symbol: shortAddress(checksummed, 6, 4),
        name: 'Unreadable token metadata',
        decimals: 18,
        metadataFailed: true,
      };
    }
    this.put(meta);
    return meta;
  }
}

// ------------------------------------------------------------------ reads --

export async function fetchPairCount(runner: ContractRunner, addresses: DexAddresses): Promise<number> {
  return Number((await factoryContract(addresses, runner).allPairsLength()) as bigint);
}

export async function fetchPairsPage(
  runner: ContractRunner,
  addresses: DexAddresses,
  offset: number,
  limit: number,
): Promise<string[]> {
  const page = (await factoryContract(addresses, runner).pairsPage(offset, limit)) as string[];
  return page.map((a) => toChecksum(a));
}

/** The pool for two tokens, or null when it does not exist yet. */
export async function findPair(
  runner: ContractRunner,
  addresses: DexAddresses,
  tokenA: string,
  tokenB: string,
): Promise<string | null> {
  const pair = (await factoryContract(addresses, runner).getPair(toChecksum(tokenA), toChecksum(tokenB))) as string;
  return /^0x0{40}$/i.test(pair) ? null : toChecksum(pair);
}

/** One pool: both tokens, both reserves, LP supply. */
export async function loadPair(
  runner: ContractRunner,
  pair: string,
  cache: TokenMetaCache,
): Promise<PairSnapshot> {
  const contract = pairContract(pair, runner);
  const [token0Address, token1Address, reserves, totalSupply] = await Promise.all([
    contract.token0() as Promise<string>,
    contract.token1() as Promise<string>,
    contract.getReserves() as Promise<[bigint, bigint, bigint]>,
    contract.totalSupply() as Promise<bigint>,
  ]);
  const [token0, token1] = await Promise.all([
    cache.get(runner, token0Address),
    cache.get(runner, token1Address),
  ]);
  return {
    pair: toChecksum(pair),
    token0,
    token1,
    reserve0: reserves[0],
    reserve1: reserves[1],
    totalSupply,
    blockTimestampLast: Number(reserves[2]),
  };
}

/**
 * Every pool in the factory, newest first (the factory appends, so the list is
 * reversed). Pages through `pairsPage` so one broken RPC response cannot lose
 * the whole registry.
 */
export async function loadAllPairs(
  runner: ContractRunner,
  addresses: DexAddresses,
  cache: TokenMetaCache,
  pageSize = 25,
): Promise<PairSnapshot[]> {
  const count = await fetchPairCount(runner, addresses);
  const addressesOut: string[] = [];
  for (let offset = 0; offset < count; offset += pageSize) {
    addressesOut.push(...(await fetchPairsPage(runner, addresses, offset, pageSize)));
  }
  const snapshots = await Promise.all(addressesOut.map((p) => loadPair(runner, p, cache)));
  return snapshots.reverse();
}

/** LP balance of `owner` in a pool. */
export async function fetchLpBalance(runner: ContractRunner, pair: string, owner: string): Promise<bigint> {
  return (await pairContract(pair, runner).balanceOf(toChecksum(owner))) as bigint;
}

/** LP allowance granted to the router (removing liquidity needs one). */
export async function fetchLpAllowance(
  runner: ContractRunner,
  pair: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return (await pairContract(pair, runner).allowance(toChecksum(owner), toChecksum(spender))) as bigint;
}

export async function approveLp(
  signer: ContractRunner,
  pair: string,
  spender: string,
  amount: bigint,
): Promise<{ hash: string; wait: () => Promise<unknown> }> {
  const tx = await pairContract(pair, signer).approve(toChecksum(spender), amount);
  return tx as unknown as { hash: string; wait: () => Promise<unknown> };
}

// ----------------------------------------------------------------- index ----

/** Address-ordered key for a pool, matching the contracts' token0/token1 sort. */
export function pairKey(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? `${a}/${b}` : `${b}/${a}`;
}

export type PairIndex = Map<string, PairSnapshot>;

export function buildPairIndex(pairs: PairSnapshot[]): PairIndex {
  const index: PairIndex = new Map();
  for (const p of pairs) index.set(pairKey(p.token0.address, p.token1.address), p);
  return index;
}

/**
 * Reserves for one hop, oriented so `reserveIn` belongs to `tokenIn`.
 * Returns null when the pool does not exist or has never been seeded.
 */
export function hopReserves(index: PairIndex, tokenIn: string, tokenOut: string): HopReserves | null {
  const snapshot = index.get(pairKey(tokenIn, tokenOut));
  if (!snapshot) return null;
  if (snapshot.reserve0 <= 0n || snapshot.reserve1 <= 0n) return null;
  const inIsToken0 = snapshot.token0.address.toLowerCase() === tokenIn.toLowerCase();
  return inIsToken0
    ? { reserveIn: snapshot.reserve0, reserveOut: snapshot.reserve1 }
    : { reserveIn: snapshot.reserve1, reserveOut: snapshot.reserve0 };
}

/** Every distinct token that appears in at least one pool. */
export function tokensFromPairs(pairs: PairSnapshot[]): TokenInfo[] {
  const seen = new Map<string, TokenInfo>();
  for (const p of pairs) {
    seen.set(p.token0.address.toLowerCase(), p.token0);
    seen.set(p.token1.address.toLowerCase(), p.token1);
  }
  return [...seen.values()];
}

/** Reserves of a snapshot in the caller's token order. */
export function orientedReserves(snapshot: PairSnapshot, tokenAddress: string): { own: bigint; other: bigint } {
  const isToken0 = snapshot.token0.address.toLowerCase() === tokenAddress.toLowerCase();
  return isToken0
    ? { own: snapshot.reserve0, other: snapshot.reserve1 }
    : { own: snapshot.reserve1, other: snapshot.reserve0 };
}
