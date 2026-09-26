// Preparing and signing what a dApp asked for, with the key held in the
// connect window's memory. Transactions are fully resolved here (nonce, gas,
// fees from the wallet's own RPC) so the confirm screen shows exactly what
// gets signed, and they are signed offline with the chain id the request
// carried — the RPC cannot talk the wallet into another chain.

import { Contract, Wallet, type JsonRpcProvider } from 'ethers';
import { feePolicyFor, getFeeInfo, NATIVE_TRANSFER_GAS } from '../lib/tx.ts';
import { chainById } from '../lib/chains.ts';
import { txMaxFeeWei } from '../lib/validate.ts';
import { CHAIN_ID, RPC_URLS } from '../config.ts';
import { connectRpc } from '../lib/rpc.ts';
import { CHAIN_RPC_URLS } from '../../../shared/fxwallet/chains.ts';
import type { PersonalSignRequest, TxRequest, TypedDataRequest } from './requests.ts';

/* ---------------- one RPC per chain ---------------- */

/** The wallet's own endpoints for a chain: its configured list for Ferminux, the shared public list otherwise. */
export function rpcUrlsFor(chainId: number): string[] {
  return chainId === CHAIN_ID ? [...RPC_URLS] : [...(CHAIN_RPC_URLS[chainId] ?? [])];
}

const providers = new Map<number, Promise<JsonRpcProvider>>();

export function providerFor(chainId: number): Promise<JsonRpcProvider> {
  let p = providers.get(chainId);
  if (!p) {
    const urls = rpcUrlsFor(chainId);
    p = urls.length === 0 ? Promise.reject(new Error(`No RPC endpoint for chain ${chainId}.`)) : connectRpc(urls, chainId).then((c) => c.provider);
    providers.set(chainId, p);
    // A failed probe must not be cached: the next request tries again.
    p.catch(() => providers.delete(chainId));
  }
  return p;
}

/* ---------------- transactions ---------------- */

export class WouldFailError extends Error {}

function revertReason(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; info?: { error?: { message?: string } }; message?: string };
  return err?.reason || err?.info?.error?.message || err?.shortMessage || err?.message || String(e);
}

export interface PreparedCall {
  chainId: number;
  from: string;
  to: string | null;
  value: bigint;
  data: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** gasLimit × maxFeePerGas: the most this can cost in fees. */
  maxFeeWei: bigint;
  balance: bigint;
  /** `to` has code (a contract call rather than a plain transfer). */
  toIsContract: boolean;
}

/**
 * Resolve every field of the transaction. The fee comes from the wallet, by
 * the same per-chain policy as its own Send (the 1 gwei tip floor Ferminux
 * signers require; the node's tip elsewhere, raised to the chain's minimum
 * where it has one); a gas limit suggested by the dApp is kept only when it
 * covers the estimate.
 */
export async function prepareCall(provider: JsonRpcProvider, chainId: number, req: TxRequest): Promise<PreparedCall> {
  const chain = chainById(chainId);
  const [fees, balance, nonce, code] = await Promise.all([
    getFeeInfo(provider, feePolicyFor(chain ?? { id: chainId, opStackL1Fee: false }, CHAIN_ID)),
    provider.getBalance(req.from),
    provider.getTransactionCount(req.from, 'pending'),
    req.to ? provider.getCode(req.to) : Promise.resolve('0x'),
  ]);
  let estimate: bigint;
  try {
    estimate = await provider.estimateGas({ from: req.from, to: req.to ?? undefined, value: req.value, data: req.data });
  } catch (e) {
    throw new WouldFailError(revertReason(e));
  }
  // Same policy as the wallet's own send screen: exactly 21000 is a plain
  // transfer and needs no headroom; anything that runs code gets +20%.
  const policy = estimate === NATIVE_TRANSFER_GAS ? estimate : (estimate * 12n) / 10n;
  const gasLimit = req.gas !== null && req.gas >= estimate ? req.gas : policy;
  return {
    chainId,
    from: req.from,
    to: req.to,
    value: req.value,
    data: req.data,
    nonce,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeeWei: txMaxFeeWei(gasLimit, fees.maxFeePerGas),
    balance,
    toIsContract: code !== '0x',
  };
}

export async function signAndSend(privateKey: string, provider: JsonRpcProvider, p: PreparedCall): Promise<string> {
  const signer = new Wallet(privateKey);
  if (signer.address.toLowerCase() !== p.from.toLowerCase()) throw new Error('Signer does not match the requested account.');
  const raw = await signer.signTransaction({
    type: 2,
    chainId: p.chainId,
    to: p.to,
    value: p.value,
    data: p.data,
    nonce: p.nonce,
    gasLimit: p.gasLimit,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
  });
  const res = await provider.broadcastTransaction(raw);
  return res.hash;
}

/* ---------------- messages ---------------- */

export function signPersonal(privateKey: string, req: PersonalSignRequest): Promise<string> {
  // Raw bytes, so a hex message is signed as the bytes it encodes.
  return new Wallet(privateKey).signMessage(req.bytes);
}

export function signTyped(privateKey: string, req: TypedDataRequest): Promise<string> {
  return new Wallet(privateKey).signTypedData(req.domain as never, req.types, req.message);
}

/* ---------------- token facts for the confirm screen ---------------- */

export interface TokenFacts {
  symbol: string;
  decimals: number;
}

/** symbol()/decimals() of a contract, or null for anything that is not an FRC-20. */
export async function tokenFacts(provider: JsonRpcProvider, address: string): Promise<TokenFacts | null> {
  const c = new Contract(address, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], provider);
  try {
    const [symbol, decimals] = await Promise.all([c.symbol() as Promise<string>, c.decimals() as Promise<bigint>]);
    const d = Number(decimals);
    if (!Number.isInteger(d) || d > 36) return null;
    return { symbol: String(symbol).replace(/[^\x20-\x7e]/g, '').slice(0, 16) || '?', decimals: d };
  } catch {
    return null;
  }
}
