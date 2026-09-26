// Multi-chain balances for one holder.
// No browser globals beyond `fetch` (via the injectable batch transport).
//
// Every chain is read independently, in ONE HTTP request per chain:
//   • where Multicall3 is deployed, [eth_chainId, eth_call(aggregate3(…))] —
//     the native balance (getEthBalance) and every token's balanceOf in one call;
//   • where it is not (Ferminux, checked 2026-09-25: no code at the canonical
//     address), [eth_chainId, eth_getBalance, eth_call(balanceOf) × N] as one
//     JSON-RPC batch.
// eth_chainId rides along in the same request so an endpoint answering for the
// wrong network is caught instead of showing another chain's balances.
// Each chain has its own timeout and its own error; one slow or dead chain
// never holds up the others (the caller runs them concurrently).

import { Interface, getAddress } from 'ethers';
import { MULTICALL3_ADDRESS, type ChainDef, type ChainToken } from './chains.ts';
import { httpBatchTransport, type BatchTransport, type JsonRpcCall, type JsonRpcReply } from './balances.ts';

export type AssetSource = 'native' | 'listed' | 'custom';

export interface AssetRef {
  chainId: number;
  /** Token contract, EIP-55; null for the chain's native coin. */
  address: string | null;
  symbol: string;
  name: string;
  decimals: number;
  source: AssetSource;
}

/** A token the user added by address, on any supported chain. */
export interface CustomToken extends ChainToken {
  chainId: number;
}

export function assetKey(chainId: number, address: string | null): string {
  return `${chainId}:${address ? address.toLowerCase() : 'native'}`;
}

/** Native coin first, then the chain's listed tokens, then the user's own — deduplicated by address. */
export function chainAssets(chain: ChainDef, custom: CustomToken[]): AssetRef[] {
  const out: AssetRef[] = [
    {
      chainId: chain.id,
      address: null,
      symbol: chain.native.symbol,
      name: chain.native.name,
      decimals: chain.native.decimals,
      source: 'native',
    },
  ];
  const seen = new Set<string>();
  for (const t of chain.tokens) {
    const lower = t.address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ chainId: chain.id, address: getAddress(t.address), symbol: t.symbol, name: t.name, decimals: t.decimals, source: 'listed' });
  }
  for (const t of custom) {
    if (t.chainId !== chain.id) continue;
    const lower = t.address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ chainId: chain.id, address: getAddress(t.address), symbol: t.symbol, name: t.name, decimals: t.decimals, source: 'custom' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

const erc20 = new Interface(['function balanceOf(address owner) view returns (uint256)']);
const multicall = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

export function encodeBalanceOf(holder: string): string {
  return erc20.encodeFunctionData('balanceOf', [getAddress(holder)]);
}

/** One aggregate3 call reading the native balance (via Multicall3 itself) and every token. */
export function encodeMulticallBalances(holder: string, assets: AssetRef[]): string {
  const h = getAddress(holder);
  const calls = assets.map((a) =>
    a.address === null
      ? { target: MULTICALL3_ADDRESS, allowFailure: true, callData: multicall.encodeFunctionData('getEthBalance', [h]) }
      : { target: a.address, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [h]) },
  );
  return multicall.encodeFunctionData('aggregate3', [calls]);
}

/** A uint256 return value; anything shorter than one word is not an answer. */
export function decodeUint(returnData: string): bigint | null {
  if (typeof returnData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(returnData)) return null;
  if (returnData.length < 2 + 64) return null;
  return BigInt('0x' + returnData.slice(2, 66));
}

/** Decode aggregate3's result into one balance (or null) per asset, in order. */
export function decodeMulticallBalances(result: string, count: number): (bigint | null)[] {
  const [rows] = multicall.decodeFunctionResult('aggregate3', result) as unknown as [
    Array<{ success: boolean; returnData: string }>,
  ];
  const out: (bigint | null)[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = rows[i];
    out.push(r && r.success ? decodeUint(r.returnData) : null);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export type ChainReading =
  | {
      chainId: number;
      ok: true;
      /** assetKey → balance in base units. Assets whose read failed are absent. */
      balances: Map<string, bigint>;
      /** assetKeys that did not answer (e.g. a token address with no contract). */
      failed: string[];
      rpcUrl: string;
      at: number;
    }
  | { chainId: number; ok: false; error: string; at: number };

export interface ReadOptions {
  /** Per-endpoint request timeout. */
  timeoutMs?: number;
  /** Injectable for tests: url → transport. */
  transportFor?: (url: string, timeoutMs: number) => BatchTransport;
  now?: () => number;
}

function byId(replies: JsonRpcReply[]): Map<number, JsonRpcReply> {
  const m = new Map<number, JsonRpcReply>();
  for (const r of Array.isArray(replies) ? replies : [replies]) {
    if (r && typeof r.id === 'number') m.set(r.id, r);
  }
  return m;
}

function hexQuantity(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  return BigInt(v);
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError' || /abort/i.test(e.message)) return 'timed out';
    return e.message;
  }
  return String(e);
}

/** Read one endpoint. Throws on any transport-level or chain-id problem. */
async function readVia(
  transport: BatchTransport,
  chain: ChainDef,
  holder: string,
  assets: AssetRef[],
): Promise<{ balances: Map<string, bigint>; failed: string[] }> {
  const h = getAddress(holder);
  const calls: JsonRpcCall[] = [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }];
  if (chain.multicall3) {
    calls.push({
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_call',
      params: [{ to: MULTICALL3_ADDRESS, data: encodeMulticallBalances(h, assets) }, 'latest'],
    });
  } else {
    assets.forEach((a, i) => {
      calls.push(
        a.address === null
          ? { jsonrpc: '2.0', id: i + 2, method: 'eth_getBalance', params: [h, 'latest'] }
          : { jsonrpc: '2.0', id: i + 2, method: 'eth_call', params: [{ to: a.address, data: encodeBalanceOf(h) }, 'latest'] },
      );
    });
  }

  const replies = byId(await transport(calls));
  const idReply = replies.get(1);
  const reported = hexQuantity(idReply?.result);
  if (reported === null) {
    throw new Error(idReply?.error?.message ? `RPC error: ${idReply.error.message}` : 'RPC gave no usable answer');
  }
  if (reported !== BigInt(chain.id)) {
    throw new Error(`RPC answered for chain ${reported.toString()}, not ${chain.id}`);
  }

  const balances = new Map<string, bigint>();
  const failed: string[] = [];
  if (chain.multicall3) {
    const r = replies.get(2);
    if (!r || r.error || typeof r.result !== 'string') {
      throw new Error(r?.error?.message ? `Multicall failed: ${r.error.message}` : 'Multicall returned nothing');
    }
    const values = decodeMulticallBalances(r.result, assets.length);
    assets.forEach((a, i) => {
      const k = assetKey(chain.id, a.address);
      const v = values[i];
      if (v === null) failed.push(k);
      else balances.set(k, v);
    });
  } else {
    assets.forEach((a, i) => {
      const k = assetKey(chain.id, a.address);
      const r = replies.get(i + 2);
      const v = r && !r.error ? (a.address === null ? hexQuantity(r.result) : decodeUint(r.result as string)) : null;
      if (v === null) failed.push(k);
      else balances.set(k, v);
    });
    // Every read failing is an endpoint problem, not N broken tokens.
    if (balances.size === 0 && assets.length > 0) throw new Error('RPC did not answer any balance read');
  }
  return { balances, failed };
}

/**
 * Read every asset on one chain, trying each RPC endpoint in order. Never
 * throws: a chain that cannot be read comes back as `{ ok: false, error }`.
 */
export async function readChainBalances(
  chain: ChainDef,
  holder: string,
  assets: AssetRef[],
  opts?: ReadOptions,
): Promise<ChainReading> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const now = opts?.now ?? Date.now;
  const transportFor = opts?.transportFor ?? ((url: string, t: number) => httpBatchTransport(url, t));
  let lastError = 'no RPC endpoint configured';
  for (const url of chain.rpcUrls) {
    try {
      const { balances, failed } = await readVia(transportFor(url, timeoutMs), chain, holder, assets);
      return { chainId: chain.id, ok: true, balances, failed, rpcUrl: url, at: now() };
    } catch (e) {
      lastError = describe(e);
    }
  }
  return { chainId: chain.id, ok: false, error: lastError, at: now() };
}

/* ------------------------------------------------------------------ */
/* View model                                                          */
/* ------------------------------------------------------------------ */

export interface PortfolioRow {
  asset: AssetRef;
  /** null = not read yet, or this one asset's read failed. */
  balance: bigint | null;
}

export interface PortfolioGroup {
  chain: ChainDef;
  /** 'loading' until the first reading; after that, the latest reading's outcome. */
  status: 'loading' | 'ok' | 'error';
  error: string | null;
  /** The previous good reading is kept on screen when a refresh fails. */
  stale: boolean;
  rows: PortfolioRow[];
  /** Rows hidden by the zero-balance filter. */
  hiddenZero: number;
  updatedAt: number | null;
}

export interface PortfolioFilter {
  hideZero: boolean;
  /** null = every chain. */
  chainId: number | null;
}

/**
 * Build what the Assets tab renders. `lastGood` holds each chain's most recent
 * successful reading so a failed refresh degrades to "stale", not "empty".
 */
export function buildPortfolio(
  chains: ChainDef[],
  assetsByChain: Map<number, AssetRef[]>,
  latest: Map<number, ChainReading>,
  lastGood: Map<number, Extract<ChainReading, { ok: true }>>,
  filter: PortfolioFilter,
): PortfolioGroup[] {
  const groups: PortfolioGroup[] = [];
  for (const chain of chains) {
    if (filter.chainId !== null && chain.id !== filter.chainId) continue;
    const assets = assetsByChain.get(chain.id) ?? [];
    const reading = latest.get(chain.id);
    const good = lastGood.get(chain.id);
    const status: PortfolioGroup['status'] = !reading ? 'loading' : reading.ok ? 'ok' : 'error';
    const rows: PortfolioRow[] = [];
    let hiddenZero = 0;
    for (const asset of assets) {
      const balance = good?.balances.get(assetKey(chain.id, asset.address)) ?? null;
      // A custom token is always shown: the user added it on purpose. So is
      // an unknown balance — hiding it would hide a read failure.
      if (filter.hideZero && balance === 0n && asset.source !== 'custom') {
        hiddenZero += 1;
        continue;
      }
      rows.push({ asset, balance });
    }
    groups.push({
      chain,
      status,
      error: reading && !reading.ok ? reading.error : null,
      stale: status === 'error' && good !== undefined,
      rows,
      hiddenZero,
      updatedAt: good?.at ?? null,
    });
  }
  return groups;
}

/** Balance of one asset from the last good readings, or null. */
export function balanceFor(
  lastGood: Map<number, Extract<ChainReading, { ok: true }>>,
  chainId: number,
  address: string | null,
): bigint | null {
  return lastGood.get(chainId)?.balances.get(assetKey(chainId, address)) ?? null;
}
