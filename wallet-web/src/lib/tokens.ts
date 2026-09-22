// ERC-20 support: metadata, balances, transfer encoding.
// No browser globals — runs under Node for the e2e suite.

import { Contract, Interface, getAddress, type JsonRpcProvider } from 'ethers';
import { prepareTransaction, type PreparedTx } from './tx.ts';

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
] as const;

const erc20Interface = new Interface(ERC20_ABI as unknown as string[]);

export interface TokenMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Read a token's metadata from chain. Throws with a readable message if the
 * address has no code or does not answer the ERC-20 interface.
 */
export async function fetchTokenMeta(provider: JsonRpcProvider, address: string): Promise<TokenMeta> {
  const checksummed = getAddress(address);
  const code = await provider.getCode(checksummed);
  if (code === '0x') {
    throw new Error('No contract is deployed at this address.');
  }
  const contract = new Contract(checksummed, ERC20_ABI as unknown as string[], provider);
  try {
    const [name, symbol, decimals] = await Promise.all([
      contract.name() as Promise<string>,
      contract.symbol() as Promise<string>,
      contract.decimals() as Promise<bigint | number>,
    ]);
    return { address: checksummed, name, symbol, decimals: Number(decimals) };
  } catch {
    throw new Error('Contract does not implement the ERC-20 interface (name/symbol/decimals).');
  }
}

export async function fetchTokenBalance(
  provider: JsonRpcProvider,
  tokenAddress: string,
  holder: string,
): Promise<bigint> {
  const contract = new Contract(getAddress(tokenAddress), ERC20_ABI as unknown as string[], provider);
  return (await contract.balanceOf(holder)) as bigint;
}

/** ABI-encode transfer(to, amount). */
export function encodeTokenTransfer(to: string, amountWei: bigint): string {
  return erc20Interface.encodeFunctionData('transfer', [getAddress(to), amountWei]);
}

/**
 * Build a type-2 transaction that calls transfer() on the token contract.
 * Value is zero; the recipient is encoded in calldata.
 */
export async function prepareTokenTransfer(
  provider: JsonRpcProvider,
  chainId: number,
  from: string,
  tokenAddress: string,
  to: string,
  amountWei: bigint,
): Promise<PreparedTx> {
  const data = encodeTokenTransfer(to, amountWei);
  return prepareTransaction(provider, chainId, from, getAddress(tokenAddress), 0n, data);
}
