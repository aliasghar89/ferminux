// EIP-1559 transaction preparation, signing and broadcast.
// No browser globals — runs under Node for the e2e suite.
// Signing is done OFFLINE with an explicit chainId (never taken from the RPC),
// so a malicious endpoint cannot trick the wallet into signing for another chain.

import { Wallet, type JsonRpcProvider, type TransactionResponse } from 'ethers';
import { txMaxFeeWei } from './validate.ts';

export const NATIVE_TRANSFER_GAS = 21000n;

export interface FeeInfo {
  /** Latest block base fee (null if the RPC omits it). */
  baseFee: bigint | null;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

const ONE_GWEI = 1_000_000_000n;

/** Read current fee conditions: base fee from the head block, tip from the node. */
export async function getFeeInfo(provider: JsonRpcProvider): Promise<FeeInfo> {
  const block = await provider.getBlock('latest');
  const baseFee = block?.baseFeePerGas ?? null;
  let tip: bigint;
  try {
    tip = BigInt(await provider.send('eth_maxPriorityFeePerGas', []));
  } catch {
    tip = ONE_GWEI;
  }
  if (tip <= 0n) tip = ONE_GWEI;
  const base = baseFee ?? ONE_GWEI;
  // Headroom for two consecutive max base-fee increases, plus the tip.
  const maxFeePerGas = base * 2n + tip;
  return { baseFee, maxPriorityFeePerGas: tip, maxFeePerGas };
}

export interface PreparedTx {
  chainId: number;
  from: string;
  to: string;
  valueWei: bigint;
  data: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFee: bigint | null;
  /** Worst-case fee (gasLimit × maxFeePerGas) in wei. */
  maxFeeWei: bigint;
}

/** Best human-readable reason from an ethers v6 estimate/call failure. */
function revertReason(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; info?: { error?: { message?: string } }; message?: string };
  return err?.reason || err?.info?.error?.message || err?.shortMessage || err?.message || String(e);
}

/**
 * Build a fully-specified type-2 transaction: nonce, gas limit and fee fields
 * are all resolved here so the confirm screen shows exactly what gets signed.
 */
export async function prepareTransaction(
  provider: JsonRpcProvider,
  chainId: number,
  from: string,
  to: string,
  valueWei: bigint,
  data = '0x',
): Promise<PreparedTx> {
  const fees = await getFeeInfo(provider);
  // ALWAYS estimate. "No calldata" does not mean "plain account": a contract
  // with receive() takes a bare value transfer and needs more than 21000 gas
  // to run it. Hardcoding 21000 for data === '0x' sent every deposit to the
  // FoundationLock out of gas — two reverted on mainnet before this was found.
  // An EOA estimates to exactly 21000, so the floor below is the only case the
  // estimate can ever come in under, and a contract estimates to what it needs.
  // If the estimate itself fails, the call would revert: surface that instead
  // of signing a transaction we already know will fail.
  let estimate: bigint;
  try {
    estimate = await provider.estimateGas({ from, to, value: valueWei, data });
  } catch (e) {
    throw new Error(`This transaction would fail: ${revertReason(e)}`);
  }
  // Exactly 21000 is the signature of a plain-account transfer: deterministic,
  // nothing to run, no headroom needed — keep it so the common case is
  // unchanged and "Max" math stays exact. Anything else ran code, gets +20%.
  const gasLimit =
    estimate === NATIVE_TRANSFER_GAS
      ? NATIVE_TRANSFER_GAS
      : ((estimate * 12n) / 10n > NATIVE_TRANSFER_GAS ? (estimate * 12n) / 10n : NATIVE_TRANSFER_GAS);
  const nonce = await provider.getTransactionCount(from, 'pending');
  return {
    chainId,
    from,
    to,
    valueWei,
    data,
    nonce,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    baseFee: fees.baseFee,
    maxFeeWei: txMaxFeeWei(gasLimit, fees.maxFeePerGas),
  };
}

export interface SentTx {
  hash: string;
  /** The raw signed transaction that was broadcast. */
  raw: string;
  response: TransactionResponse;
}

/**
 * Sign the prepared transaction offline and broadcast the raw bytes.
 * The chainId in `prepared` (always 3961 in production) is signed verbatim.
 */
export async function signAndBroadcast(
  privateKey: string,
  provider: JsonRpcProvider,
  prepared: PreparedTx,
): Promise<SentTx> {
  const signer = new Wallet(privateKey);
  if (signer.address.toLowerCase() !== prepared.from.toLowerCase()) {
    throw new Error('Signer does not match the prepared transaction sender.');
  }
  const raw = await signer.signTransaction({
    type: 2,
    chainId: prepared.chainId,
    to: prepared.to,
    value: prepared.valueWei,
    data: prepared.data,
    nonce: prepared.nonce,
    gasLimit: prepared.gasLimit,
    maxFeePerGas: prepared.maxFeePerGas,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
  });
  const response = await provider.broadcastTransaction(raw);
  return { hash: response.hash, raw, response };
}
