// Transaction preparation (EIP-1559; legacy only where a chain has no base
// fee), signing and broadcast.
// No browser globals — runs under Node for the e2e suite.
// Signing is done OFFLINE with an explicit chainId (never taken from the RPC),
// so a malicious endpoint cannot trick the wallet into signing for another chain.

import { Interface, Transaction, Wallet, type JsonRpcProvider, type TransactionReceipt, type TransactionResponse } from 'ethers';
import { txMaxFeeWei } from './validate.ts';

export const NATIVE_TRANSFER_GAS = 21000n;

export interface FeeInfo {
  /** Latest block base fee (null if the RPC omits it). */
  baseFee: bigint | null;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  /**
   * Set only on a chain whose blocks carry no base fee (pre-London): the
   * transaction is then signed as type 0 at this gas price.
   */
  gasPrice?: bigint | null;
}

const ONE_GWEI = 1_000_000_000n;

/**
 * How fees are read on one chain.
 *
 * Ferminux signers drop transactions tipping under 1 gwei, so the home chain
 * floors the tip there. That floor is wrong anywhere else — Arbitrum's
 * suggested tip IS zero, and a 1 gwei tip there would inflate the worst-case
 * fee ~50× and turn funded accounts into "insufficient gas" — so other chains
 * take the node's answer as it is.
 */
export interface FeePolicy {
  /** Minimum tip, also used when the node cannot answer; null = trust the node. */
  tipFloor: bigint | null;
  /** OP-stack chain: add the L1 data fee upper bound to the worst-case fee. */
  opStackL1Fee: boolean;
  /** With tipFloor null: a suggested tip under this is raised to it (ChainDef.minTipWei). */
  minTip?: bigint;
}

export const HOME_FEE_POLICY: FeePolicy = { tipFloor: ONE_GWEI, opStackL1Fee: false };

export function feePolicyFor(chain: { id: number; opStackL1Fee: boolean; minTipWei?: bigint }, homeChainId: number): FeePolicy {
  if (chain.id === homeChainId) return HOME_FEE_POLICY;
  return { tipFloor: null, opStackL1Fee: chain.opStackL1Fee, ...(chain.minTipWei !== undefined ? { minTip: chain.minTipWei } : {}) };
}

/** Read current fee conditions: base fee from the head block, tip from the node. */
export async function getFeeInfo(provider: Pick<JsonRpcProvider, 'getBlock' | 'send'>, policy: FeePolicy = HOME_FEE_POLICY): Promise<FeeInfo> {
  const block = await provider.getBlock('latest');
  const baseFee = block?.baseFeePerGas ?? null;

  if (policy.tipFloor !== null) {
    let tip: bigint;
    try {
      tip = BigInt(await provider.send('eth_maxPriorityFeePerGas', []));
    } catch {
      tip = policy.tipFloor;
    }
    // A tip under the floor is dropped by the signers — it used to be floored
    // only when it was zero, so a node suggesting 0.5 gwei produced a
    // transaction that sat unconfirmed forever.
    if (tip < policy.tipFloor) tip = policy.tipFloor;
    const base = baseFee ?? ONE_GWEI;
    // Headroom for two consecutive max base-fee increases, plus the tip.
    const maxFeePerGas = base * 2n + tip;
    return { baseFee, maxPriorityFeePerGas: tip, maxFeePerGas };
  }

  if (baseFee === null) {
    // No EIP-1559 on this chain: a legacy transaction at the node's price.
    const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
    return { baseFee: null, maxPriorityFeePerGas: gasPrice, maxFeePerGas: gasPrice, gasPrice };
  }
  let tip: bigint;
  try {
    tip = BigInt(await provider.send('eth_maxPriorityFeePerGas', []));
  } catch {
    try {
      const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
      tip = gasPrice > baseFee ? gasPrice - baseFee : 0n;
    } catch {
      tip = 0n;
    }
  }
  if (tip < 0n) tip = 0n;
  // Ethereum's node often suggests a zero tip, and a zero-tip transaction can
  // wait indefinitely: the chain's minimum applies (never on Arbitrum, where 0 is right).
  if (policy.minTip !== undefined && tip < policy.minTip) tip = policy.minTip;
  return { baseFee, maxPriorityFeePerGas: tip, maxFeePerGas: baseFee * 2n + tip };
}

/** OP-stack GasPriceOracle predeploy (Base, Optimism). */
export const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const gasPriceOracle = new Interface([
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
  'function getL1Fee(bytes data) view returns (uint256)',
]);

/**
 * Upper bound of the L1 data fee an OP-stack chain charges on top of gas.
 * Uses getL1FeeUpperBound (Fjord and later) and falls back to getL1Fee on the
 * unsigned transaction plus 25 %. Null when the oracle cannot be read — the
 * caller says so rather than pretending the fee is zero.
 */
export async function estimateOpL1Fee(
  provider: Pick<JsonRpcProvider, 'call'>,
  unsignedSerialized: string,
): Promise<bigint | null> {
  const size = BigInt((unsignedSerialized.length - 2) / 2);
  try {
    const out = await provider.call({
      to: OP_GAS_PRICE_ORACLE,
      data: gasPriceOracle.encodeFunctionData('getL1FeeUpperBound', [size]),
    });
    return BigInt(gasPriceOracle.decodeFunctionResult('getL1FeeUpperBound', out)[0]);
  } catch {
    /* pre-Fjord oracle: fall through */
  }
  try {
    const out = await provider.call({
      to: OP_GAS_PRICE_ORACLE,
      data: gasPriceOracle.encodeFunctionData('getL1Fee', [unsignedSerialized]),
    });
    const fee = BigInt(gasPriceOracle.decodeFunctionResult('getL1Fee', out)[0]);
    return (fee * 125n) / 100n;
  } catch {
    return null;
  }
}

interface UnsignedParts {
  chainId: number;
  to: string;
  valueWei: bigint;
  data: string;
  nonce: number;
  gasLimit: bigint;
  fees: FeeInfo;
}

function unsignedFor(p: UnsignedParts): string {
  const legacy = p.fees.gasPrice != null;
  return Transaction.from({
    type: legacy ? 0 : 2,
    chainId: p.chainId,
    to: p.to,
    value: p.valueWei,
    data: p.data,
    nonce: p.nonce,
    gasLimit: p.gasLimit,
    ...(legacy
      ? { gasPrice: p.fees.gasPrice as bigint }
      : { maxFeePerGas: p.fees.maxFeePerGas, maxPriorityFeePerGas: p.fees.maxPriorityFeePerGas }),
  }).unsignedSerialized;
}

/**
 * Nonce used to size a transaction that has none yet (a fee estimate, not a
 * signature): three RLP bytes, more than any real account's nonce takes, so
 * the L1 data fee sized with it is never below the one Review sizes.
 */
const SIZING_NONCE = 1 << 20;

/** What one transaction may cost at worst, in the chain's native coin. */
export interface FeeBudget {
  gasLimit: bigint;
  fees: FeeInfo;
  /**
   * gasLimit × maxFeePerGas (× gasPrice on a legacy chain), plus the L1 data
   * fee upper bound on an OP-stack chain.
   */
  maxFeeWei: bigint;
  /** OP-stack L1 data fee upper bound, already included in maxFeeWei. */
  l1FeeWei?: bigint;
  /** OP-stack chain whose L1 fee oracle could not be read: maxFeeWei excludes that fee. */
  l1FeeUnknown?: boolean;
}

/**
 * The worst-case fee of a fully sized transaction. Send, Max, WalletConnect
 * requests and the pay-in (its check before a quote and the transfer that
 * pays it) all budget through here, so none can leave out the L1 data fee
 * another one counts.
 */
async function worstCaseFee(
  provider: Pick<JsonRpcProvider, 'call'>,
  p: UnsignedParts,
  policy: FeePolicy,
): Promise<Pick<FeeBudget, 'maxFeeWei' | 'l1FeeWei' | 'l1FeeUnknown'>> {
  const maxFeeWei = txMaxFeeWei(p.gasLimit, p.fees.gasPrice ?? p.fees.maxFeePerGas);
  if (!policy.opStackL1Fee) return { maxFeeWei };
  const l1 = await estimateOpL1Fee(provider, unsignedFor(p));
  if (l1 === null) return { maxFeeWei, l1FeeUnknown: true };
  return { maxFeeWei: maxFeeWei + l1, l1FeeWei: l1 };
}

/**
 * The gas limit signed for an exact call, from the node's own estimate.
 * ALWAYS estimated. "No calldata" does not mean "plain account": a contract
 * with receive() takes a bare value transfer and needs more than 21000 gas to
 * run it. Hardcoding 21000 for data === '0x' sent every deposit to the
 * FoundationLock out of gas — two reverted on mainnet before this was found.
 * On Arbitrum the estimate also carries the transaction's L1 component, which
 * no fixed per-call figure would. If the estimate itself fails, the call would
 * revert: that is surfaced instead of signing a transaction already known to fail.
 */
async function estimatedGasLimit(
  provider: Pick<JsonRpcProvider, 'estimateGas'>,
  call: { from: string; to: string; valueWei: bigint; data: string },
): Promise<bigint> {
  let estimate: bigint;
  try {
    estimate = await provider.estimateGas({ from: call.from, to: call.to, value: call.valueWei, data: call.data });
  } catch (e) {
    throw new Error(`This transaction would fail: ${revertReason(e)}`);
  }
  return gasLimitFor(estimate);
}

/**
 * The worst-case fee of one exact call before anything is signed, computed
 * exactly as prepareTransaction computes it (same fee read, same gas estimate
 * and headroom, same L1 data fee) with a sizing nonce in place of the
 * account's. Throws "This transaction would fail: …" when the node cannot
 * estimate the call: there is no fee to budget for a call that reverts.
 */
export async function estimateMaxFee(
  provider: Pick<JsonRpcProvider, 'getBlock' | 'send' | 'estimateGas' | 'call'>,
  chainId: number,
  call: { from: string; to: string; valueWei: bigint; data: string },
  policy: FeePolicy = HOME_FEE_POLICY,
): Promise<FeeBudget> {
  const fees = await getFeeInfo(provider, policy);
  const gasLimit = await estimatedGasLimit(provider, call);
  const fee = await worstCaseFee(provider, { chainId, to: call.to, valueWei: call.valueWei, data: call.data, nonce: SIZING_NONCE, gasLimit, fees }, policy);
  return { gasLimit, fees, ...fee };
}

/**
 * The gas limit prepareTransaction signs for a given estimate. Exactly 21000 is
 * the signature of a plain-account transfer: deterministic, nothing to run, no
 * headroom needed. Anything else ran code (or, on Arbitrum, carries its L1
 * component in gas) and gets +20%.
 */
export function gasLimitFor(estimate: bigint): bigint {
  if (estimate === NATIVE_TRANSFER_GAS) return NATIVE_TRANSFER_GAS;
  const padded = (estimate * 12n) / 10n;
  return padded > NATIVE_TRANSFER_GAS ? padded : NATIVE_TRANSFER_GAS;
}

/**
 * Worst-case fee of a plain native transfer — what "Max" has to leave behind.
 * Includes the L1 data fee on an OP-stack chain.
 *
 * With `from`, the gas is estimated the way Review will estimate it (at
 * `valueWei`, the largest value Max can produce) instead of assumed to be
 * 21000: an Arbitrum transfer estimates ~21,900, and a Max that reserved
 * 21000 × fee was then refused at Review as "amount plus fee exceeds your
 * balance" — every time. An estimate that is not exactly 21000 can move a
 * little between Max and Review, so it keeps a further 10% in reserve.
 */
export async function nativeTransferMaxFee(
  provider: JsonRpcProvider,
  chainId: number,
  to: string,
  policy: FeePolicy = HOME_FEE_POLICY,
  estimateFrom?: { from: string; valueWei: bigint },
): Promise<{ feeWei: bigint; l1FeeUnknown: boolean }> {
  const fees = await getFeeInfo(provider, policy);
  let gasLimit = NATIVE_TRANSFER_GAS;
  if (estimateFrom) {
    let estimate = NATIVE_TRANSFER_GAS;
    try {
      estimate = await provider.estimateGas({ from: estimateFrom.from, to, value: estimateFrom.valueWei, data: '0x' });
    } catch {
      try {
        estimate = await provider.estimateGas({ from: estimateFrom.from, to, value: 0n, data: '0x' });
      } catch {
        /* Review estimates again and says why if the transfer cannot run */
      }
    }
    gasLimit = gasLimitFor(estimate);
    if (gasLimit !== NATIVE_TRANSFER_GAS) gasLimit = (gasLimit * 11n) / 10n;
  }
  // valueWei 10^24 and the sizing nonce: the largest a Max transfer can serialize to
  const fee = await worstCaseFee(provider, { chainId, to, valueWei: 10n ** 24n, data: '0x', nonce: SIZING_NONCE, gasLimit, fees }, policy);
  return { feeWei: fee.maxFeeWei, l1FeeUnknown: fee.l1FeeUnknown === true };
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
  /**
   * Worst-case fee in wei: gasLimit × maxFeePerGas (× gasPrice for a legacy
   * transaction), plus the L1 data fee upper bound on an OP-stack chain.
   */
  maxFeeWei: bigint;
  /** 0 = legacy (gasPrice), 2 = EIP-1559. Absent means 2. */
  type?: 0 | 2;
  /** Legacy transactions only. */
  gasPrice?: bigint;
  /** OP-stack L1 data fee upper bound, already included in maxFeeWei. */
  l1FeeWei?: bigint;
  /** OP-stack chain whose L1 fee oracle could not be read: maxFeeWei excludes that fee. */
  l1FeeUnknown?: boolean;
}

/** Best human-readable reason from an ethers v6 estimate/call failure. */
function revertReason(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; info?: { error?: { message?: string } }; message?: string };
  return err?.reason || err?.info?.error?.message || err?.shortMessage || err?.message || String(e);
}

/**
 * Build a fully-specified transaction (type 2 wherever the chain has a base
 * fee): nonce, gas limit and fee fields are all resolved here so the confirm
 * screen shows exactly what gets signed.
 */
export async function prepareTransaction(
  provider: JsonRpcProvider,
  chainId: number,
  from: string,
  to: string,
  valueWei: bigint,
  data = '0x',
  policy: FeePolicy = HOME_FEE_POLICY,
): Promise<PreparedTx> {
  const fees = await getFeeInfo(provider, policy);
  // Exactly 21000 (a plain-account transfer) is kept as it is, so the common
  // case and "Max" math stay exact; anything that ran code gets +20%.
  const gasLimit = await estimatedGasLimit(provider, { from, to, valueWei, data });
  const nonce = await provider.getTransactionCount(from, 'pending');
  const legacy = fees.gasPrice != null;
  const fee = await worstCaseFee(provider, { chainId, to, valueWei, data, nonce, gasLimit, fees }, policy);
  const prepared: PreparedTx = {
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
    maxFeeWei: fee.maxFeeWei,
  };
  if (legacy) {
    prepared.type = 0;
    prepared.gasPrice = fees.gasPrice as bigint;
  }
  if (fee.l1FeeWei !== undefined) prepared.l1FeeWei = fee.l1FeeWei;
  if (fee.l1FeeUnknown) prepared.l1FeeUnknown = true;
  return prepared;
}

export interface SentTx {
  hash: string;
  /** The raw signed transaction that was broadcast. */
  raw: string;
  response: TransactionResponse;
}

/**
 * Sign the prepared transaction offline. The chainId in `prepared` is signed
 * verbatim — it comes from the wallet's own chain list, never from the RPC.
 */
export async function signPrepared(privateKey: string, prepared: PreparedTx): Promise<string> {
  const signer = new Wallet(privateKey);
  if (signer.address.toLowerCase() !== prepared.from.toLowerCase()) {
    throw new Error('Signer does not match the prepared transaction sender.');
  }
  return signer.signTransaction(
    prepared.type === 0
      ? {
          type: 0,
          chainId: prepared.chainId,
          to: prepared.to,
          value: prepared.valueWei,
          data: prepared.data,
          nonce: prepared.nonce,
          gasLimit: prepared.gasLimit,
          gasPrice: prepared.gasPrice,
        }
      : {
          type: 2,
          chainId: prepared.chainId,
          to: prepared.to,
          value: prepared.valueWei,
          data: prepared.data,
          nonce: prepared.nonce,
          gasLimit: prepared.gasLimit,
          maxFeePerGas: prepared.maxFeePerGas,
          maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
        },
  );
}

/** Sign offline (see signPrepared) and broadcast the raw bytes. */
export async function signAndBroadcast(
  privateKey: string,
  provider: JsonRpcProvider,
  prepared: PreparedTx,
): Promise<SentTx> {
  const raw = await signPrepared(privateKey, prepared);
  const response = await provider.broadcastTransaction(raw);
  return { hash: response.hash, raw, response };
}

/**
 * The receipt of a broadcast transaction, reverted or not. ethers v6's
 * TransactionResponse.wait() does not return a reverted receipt: it throws
 * CALL_EXCEPTION with the receipt attached. A caller that tests
 * `receipt.status === 1` therefore never saw a 0 — a revert surfaced as a raw
 * ethers error instead of "included in a block but reverted", and skipped the
 * bookkeeping after it (activity status, balance refresh).
 */
export async function receiptOf(response: Pick<TransactionResponse, 'wait'>): Promise<TransactionReceipt | null> {
  try {
    return await response.wait();
  } catch (e) {
    const err = e as { code?: string; receipt?: TransactionReceipt | null };
    if (err?.code === 'CALL_EXCEPTION' && err.receipt) return err.receipt;
    throw e;
  }
}
