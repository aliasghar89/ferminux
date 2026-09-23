// Addendum v3 — Agent Economy: shared helpers for the fmx.x402 / fmx.account /
// fmx.streams / fmx.disputes / fmx.reputation / fmx.validation / fmx.tokens /
// fmx.memory / fmx.webhooks / fmx.payin / fmx.audit / fmx.compute modules.
//
// These modules take a `GatewayClient` (a structural subset of the `Ferminux`
// class in ../index.ts) rather than importing the `Ferminux` class itself, to
// keep index.ts -> v3/* a one-way dependency (no import cycle).
import { Contract, parseEther, type ContractRunner, type Signer } from "ethers";

export type AmountLike = bigint | string | number;

/**
 * Ferminux signers enforce a 1 gwei minimum priority fee while the EIP-1559 base
 * fee sits at a few wei (see ../index.ts's `FerminuxWallet` doc comment —
 * this constant + helper are the shared source of truth so every v3 signer
 * (SessionAccountWallet, GaslessAccountSigner) keeps the same floor). A tx
 * that follows the raw fee-history suggestion (often 1 wei) is accepted by the
 * RPC node but never confirmed.
 */
export const MIN_PRIORITY_FEE = 1_000_000_000n;

export interface FeeProvider {
  getFeeData(): Promise<{ maxPriorityFeePerGas: bigint | null }>;
  getBlock(tag: string): Promise<{ baseFeePerGas: bigint | null } | null>;
}

export async function withMinPriorityFee(provider: FeeProvider, tx: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req = { ...tx };
  if (req.gasPrice == null && req.maxFeePerGas == null && req.maxPriorityFeePerGas == null) {
    const fee = await provider.getFeeData();
    const tip = fee.maxPriorityFeePerGas != null && fee.maxPriorityFeePerGas > MIN_PRIORITY_FEE ? fee.maxPriorityFeePerGas : MIN_PRIORITY_FEE;
    const block = await provider.getBlock("latest");
    const base = block?.baseFeePerGas ?? 0n;
    req.maxPriorityFeePerGas = tip;
    req.maxFeePerGas = base * 2n + tip;
  }
  return req;
}

/** Amount in wei (bigint or a decimal-integer string), or a plain number meaning FMX. */
export function toWei(amount: AmountLike): bigint {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") return parseEther(amount.toString());
  return BigInt(amount);
}

export function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, typeof v === "boolean" ? (v ? "1" : "") : String(v));
  }
  const str = q.toString();
  return str ? `?${str}` : "";
}

export function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Thrown by every v3 feature when its contract address is missing from NETWORKS
 * / deployments.3961.json (message is exactly "not deployed" so MCP tools can
 * surface `{error: err.message}` == `{error: "not deployed"}` unchanged). */
export class NotDeployed extends Error {
  constructor(readonly contractKey: string) {
    super("not deployed");
    this.name = "NotDeployed";
  }
}

export function requireAddress(key: string, value: string | undefined): string {
  if (!value) throw new NotDeployed(key);
  return value;
}

/** Structural subset of `Ferminux` that v3 modules depend on (no import of the concrete class). */
export interface GatewayClient {
  readonly gatewayUrl: string;
  readonly provider: ContractRunner & { getNetwork: () => Promise<{ chainId: bigint }> };
  readonly runner: ContractRunner;
  readonly signer?: Signer & { address: string };
  readonly chainId: number;
  readonly address: string | undefined;
  readonly v3: V3Addresses;
  /** per-request spend cap for fmx.fetch / fmx.x402.pay (wei); undefined = the SDK default (1 FMX) */
  readonly x402MaxPerRequest?: bigint;
  requireSigner(): Signer & { address: string };
  sign(action: string, payload?: Record<string, unknown>, ts?: number): Promise<{ address: string; ts: number; sig: string }>;
  gatewayGet<T>(path: string): Promise<T>;
  gatewayPost<T>(path: string, body: unknown, method?: "POST" | "PUT" | "DELETE"): Promise<T>;
  gatewaySignedPost<T>(path: string, action: string, payload: Record<string, unknown>): Promise<T>;
  gatewaySignedRequest<T>(method: "POST" | "PUT" | "DELETE", path: string, action: string, payload: Record<string, unknown>): Promise<T>;
  gatewaySignedGet<T>(path: string, action: string): Promise<T>;
}

export interface V3Addresses {
  x402Vault: string;
  accountFactory: string;
  accountImpl: string;
  streamPay: string;
  arbiterPool: string;
  identity8004: string;
  reputation8004: string;
  validation8004: string;
  tokenFactory: string;
  /** The record layer — AI-CV / AI-LinkedIn. "" until DeployCV lands. */
  memoryAnchor: string;
  endorsements: string;
}

/** Lazily builds (and caches) an ethers Contract once its address is known; throws NotDeployed before that. */
export function lazyContract(key: string, getAddr: () => string, abi: readonly string[], runner: ContractRunner): () => Contract {
  let c: Contract | undefined;
  return () => {
    if (!c) c = new Contract(requireAddress(key, getAddr()), abi as string[], runner);
    return c;
  };
}

interface ReceiptLike {
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}

/** Finds and decodes the first log matching `eventName` emitted by `contract` in a receipt. */
export function findEventArgs(contract: Contract, receipt: ReceiptLike, eventName: string): Record<string, unknown> | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== (contract.target as string).toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === eventName) return parsed.args as unknown as Record<string, unknown>;
    } catch {
      // not one of this contract's events — ignore
    }
  }
  return undefined;
}
