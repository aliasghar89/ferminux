// ---------------------------------------------------------------------------
// The token model, and every ERC-20 read/write the app performs.
//
// Native FMX is modelled as a token with `kind: 'native'` whose `address` is
// the WFMX contract — because that IS the token the pools hold. Routing can
// therefore treat both alike, while the swap/liquidity code switches on `kind`
// to pick the payable router entry point.
//
// No browser globals — imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

import { Contract, type ContractRunner, type ContractTransactionResponse } from 'ethers';
import { ERC20_ABI } from './abi.ts';
import { toChecksum } from './amounts.ts';
import { NATIVE_DECIMALS, NATIVE_NAME, NATIVE_SYMBOL } from '../config.ts';

export interface TokenInfo {
  /** 'native' is FMX itself; 'erc20' is any contract, WFMX included. */
  kind: 'native' | 'erc20';
  /** Checksummed. For native FMX this is the WFMX address. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /**
   * Set when name/symbol/decimals could not be read and placeholders are being
   * shown instead. Anything displaying an amount in this token must say so —
   * a wrong `decimals` is a wrong number by a factor of a billion.
   */
  metadataFailed?: boolean;
}

/** Native FMX, priced through the WFMX pools. */
export function nativeToken(wfmxAddress: string): TokenInfo {
  return {
    kind: 'native',
    address: toChecksum(wfmxAddress),
    symbol: NATIVE_SYMBOL,
    name: NATIVE_NAME,
    decimals: NATIVE_DECIMALS,
  };
}

/** Wrapped FMX as a plain ERC-20 (what a pool actually holds). */
export function wfmxToken(wfmxAddress: string): TokenInfo {
  return {
    kind: 'erc20',
    address: toChecksum(wfmxAddress),
    symbol: 'WFMX',
    name: 'Wrapped FMX',
    decimals: 18,
  };
}

/** Stable identity for lists, maps and equality — native ≠ WFMX. */
export function tokenKey(token: TokenInfo): string {
  return token.kind === 'native' ? 'native' : token.address.toLowerCase();
}

export function sameToken(a: TokenInfo | null, b: TokenInfo | null): boolean {
  if (!a || !b) return false;
  return tokenKey(a) === tokenKey(b);
}

/** True when this pair of selections is a WFMX wrap/unwrap, not a pool trade. */
export function isWrapPair(from: TokenInfo, to: TokenInfo): 'wrap' | 'unwrap' | null {
  if (from.address.toLowerCase() !== to.address.toLowerCase()) return null;
  if (from.kind === 'native' && to.kind === 'erc20') return 'wrap';
  if (from.kind === 'erc20' && to.kind === 'native') return 'unwrap';
  return null;
}

export function erc20(address: string, runner: ContractRunner): Contract {
  return new Contract(toChecksum(address), ERC20_ABI as unknown as string[], runner);
}

/**
 * Read a token's metadata from chain. Throws with a readable message if the
 * address has no code or does not answer the ERC-20 interface.
 */
export async function fetchTokenMeta(runner: ContractRunner, address: string): Promise<TokenInfo> {
  const checksummed = toChecksum(address);
  const provider = runner.provider;
  if (!provider) throw new Error('No provider available to read token metadata.');
  const code = await provider.getCode(checksummed);
  if (code === '0x') throw new Error('No contract is deployed at this address.');
  const contract = erc20(checksummed, runner);
  try {
    const [name, symbol, decimals] = await Promise.all([
      contract.name() as Promise<string>,
      contract.symbol() as Promise<string>,
      contract.decimals() as Promise<bigint | number>,
    ]);
    return { kind: 'erc20', address: checksummed, name, symbol, decimals: Number(decimals) };
  } catch {
    throw new Error('Contract does not implement the ERC-20 interface (name/symbol/decimals).');
  }
}

/** Balance of `owner` in `token`, native or ERC-20. */
export async function fetchBalance(runner: ContractRunner, token: TokenInfo, owner: string): Promise<bigint> {
  if (token.kind === 'native') {
    const provider = runner.provider;
    if (!provider) throw new Error('No provider available to read the FMX balance.');
    return provider.getBalance(toChecksum(owner));
  }
  return (await erc20(token.address, runner).balanceOf(toChecksum(owner))) as bigint;
}

/**
 * How much of `token` the owner has already approved to `spender`.
 * Native FMX needs no approval, so it reports an unbounded allowance.
 */
export async function fetchAllowance(
  runner: ContractRunner,
  token: TokenInfo,
  owner: string,
  spender: string,
): Promise<bigint> {
  if (token.kind === 'native') return 2n ** 256n - 1n;
  return (await erc20(token.address, runner).allowance(toChecksum(owner), toChecksum(spender))) as bigint;
}

/**
 * Approve exactly `amount` — not an unbounded allowance. Costs one approval
 * per trade and in exchange the router can never move more than the trade
 * the user actually signed for.
 */
export async function approveToken(
  signer: ContractRunner,
  token: TokenInfo,
  spender: string,
  amount: bigint,
): Promise<ContractTransactionResponse> {
  if (token.kind === 'native') throw new Error('Native FMX does not need an approval.');
  return (await erc20(token.address, signer).approve(
    toChecksum(spender),
    amount,
  )) as ContractTransactionResponse;
}

/** Total supply of an ERC-20 (used for LP tokens). */
export async function fetchTotalSupply(runner: ContractRunner, address: string): Promise<bigint> {
  return (await erc20(address, runner).totalSupply()) as bigint;
}
