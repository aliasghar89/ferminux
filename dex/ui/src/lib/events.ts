// ---------------------------------------------------------------------------
// Pool events, read straight from the chain with eth_getLogs.
//
// Everything the Charts, Analytics, pool pages and Activity show that is not a
// live reserve comes from here: every Swap, Mint and Burn a pool has emitted,
// each paired with the Sync that precedes it in the same transaction (the pool
// calls _update, which emits Sync, before it emits Swap/Mint/Burn), so every
// event carries the reserves the pool held right after it.
//
// Three pieces:
//   - decoders: one raw log in, one typed event out (pure, unit-tested with
//     hand-encoded fixtures);
//   - scanLogs: eth_getLogs over a block range, split in half and retried on
//     any error, so a node that caps the range or the response size still
//     answers;
//   - BlockClock: block number → timestamp, fetched per block (batched) and
//     cached, with interpolation between known blocks when a scan touches more
//     blocks than is sensible to fetch one by one.
//
// No browser globals: the e2e suites drive these modules against anvil.
// ---------------------------------------------------------------------------

import { AbiCoder, getAddress, id } from 'ethers';

export const TOPICS = {
  swap: id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  sync: id('Sync(uint112,uint112)'),
  mint: id('Mint(address,uint256,uint256)'),
  burn: id('Burn(address,uint256,uint256,address)'),
  transfer: id('Transfer(address,address,uint256)'),
  approval: id('Approval(address,address,uint256)'),
  deposit: id('Deposit(address,uint256)'),
  withdrawal: id('Withdrawal(address,uint256)'),
} as const;

/** 32-byte topic for an address (for eth_getLogs topic filters). */
export function addressTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

export const ZERO_TOPIC = '0x' + '0'.repeat(64);

function topicAddress(topic: string): string {
  return getAddress('0x' + topic.slice(-40));
}

/** The fields of an eth_getLogs entry this module uses, with numbers already decoded. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface LogFilter {
  address: string | string[];
  topics?: Array<string | string[] | null>;
}

/** Anything that answers eth_getLogs; an ethers provider via `rpcLogSource`, or a fixture. */
export interface LogSource {
  getLogs(filter: LogFilter & { fromBlock: number; toBlock: number }): Promise<RawLog[]>;
}

/** Anything that answers a raw JSON-RPC call (ethers' JsonRpcProvider.send). */
export interface RpcSender {
  send(method: string, params: unknown[]): Promise<unknown>;
}

const hex = (n: number) => '0x' + Math.max(0, Math.floor(n)).toString(16);

export function rpcLogSource(provider: RpcSender): LogSource {
  return {
    async getLogs({ address, topics, fromBlock, toBlock }) {
      const raw = (await provider.send('eth_getLogs', [
        { address, topics: topics ?? [], fromBlock: hex(fromBlock), toBlock: hex(toBlock) },
      ])) as Array<{ address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string; removed?: boolean }>;
      if (!Array.isArray(raw)) throw new Error('eth_getLogs returned no list');
      return raw
        .filter((l) => !l.removed)
        .map((l) => ({
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: Number(BigInt(l.blockNumber)),
          logIndex: Number(BigInt(l.logIndex)),
          transactionHash: l.transactionHash,
        }));
    },
  };
}

/** Blocks per eth_getLogs call before any splitting. The live node answers the whole chain in one. */
export const LOG_CHUNK = 250_000;

/**
 * eth_getLogs over [fromBlock, toBlock], in chunks of `chunk` blocks; a chunk
 * that errors (range cap, response cap, timeout) is split in half and retried,
 * down to a single block, which then throws. Logs come back sorted by
 * (block, logIndex).
 */
export async function scanLogs(
  source: LogSource,
  filter: LogFilter,
  fromBlock: number,
  toBlock: number,
  chunk = LOG_CHUNK,
): Promise<RawLog[]> {
  if (toBlock < fromBlock) return [];
  const out: RawLog[] = [];
  const run = async (a: number, b: number): Promise<void> => {
    try {
      out.push(...(await source.getLogs({ ...filter, fromBlock: a, toBlock: b })));
    } catch (err) {
      if (a === b) throw err;
      const mid = a + Math.floor((b - a) / 2);
      await run(a, mid);
      await run(mid + 1, b);
    }
  };
  for (let a = fromBlock; a <= toBlock; a += chunk) {
    await run(a, Math.min(toBlock, a + chunk - 1));
  }
  return out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
}

// ------------------------------------------------------------- decoding -----

const coder = AbiCoder.defaultAbiCoder();

export interface SwapLog {
  kind: 'swap';
  pair: string;
  block: number;
  logIndex: number;
  txHash: string;
  /** Who called swap() — the router for every trade made through it. */
  sender: string;
  /** Who received the output: the trader, the next pool of a route, or the router (native FMX out). */
  to: string;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}

export interface LiquidityLog {
  kind: 'mint' | 'burn';
  pair: string;
  block: number;
  logIndex: number;
  txHash: string;
  sender: string;
  /** Burn only: who received the tokens. */
  to: string | null;
  amount0: bigint;
  amount1: bigint;
}

export interface SyncLog {
  kind: 'sync';
  pair: string;
  block: number;
  logIndex: number;
  txHash: string;
  reserve0: bigint;
  reserve1: bigint;
}

export type PoolLog = SwapLog | LiquidityLog | SyncLog;

const base = (l: RawLog) => ({
  pair: l.address.toLowerCase(),
  block: l.blockNumber,
  logIndex: l.logIndex,
  txHash: l.transactionHash.toLowerCase(),
});

/** One pool log → typed event, or null for a topic this module does not model. */
export function decodePoolLog(l: RawLog): PoolLog | null {
  const t0 = l.topics[0]?.toLowerCase();
  try {
    if (t0 === TOPICS.swap) {
      const [a0i, a1i, a0o, a1o] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], l.data);
      return {
        kind: 'swap',
        ...base(l),
        sender: topicAddress(l.topics[1]),
        to: topicAddress(l.topics[2]),
        amount0In: BigInt(a0i),
        amount1In: BigInt(a1i),
        amount0Out: BigInt(a0o),
        amount1Out: BigInt(a1o),
      };
    }
    if (t0 === TOPICS.sync) {
      const [r0, r1] = coder.decode(['uint112', 'uint112'], l.data);
      return { kind: 'sync', ...base(l), reserve0: BigInt(r0), reserve1: BigInt(r1) };
    }
    if (t0 === TOPICS.mint || t0 === TOPICS.burn) {
      const [a0, a1] = coder.decode(['uint256', 'uint256'], l.data);
      return {
        kind: t0 === TOPICS.mint ? 'mint' : 'burn',
        ...base(l),
        sender: topicAddress(l.topics[1]),
        to: t0 === TOPICS.burn && l.topics[2] ? topicAddress(l.topics[2]) : null,
        amount0: BigInt(a0),
        amount1: BigInt(a1),
      };
    }
  } catch {
    return null; // malformed data from a contract that only looks like a pool
  }
  return null;
}

/** A Swap/Mint/Burn with the reserves the pool held right after it. */
export type PoolEvent = (SwapLog | LiquidityLog) & { reserve0: bigint | null; reserve1: bigint | null };

/**
 * Pair every Swap/Mint/Burn with the Sync the pool emitted just before it in
 * the same transaction. Input need not be sorted. Syncs are returned too, as
 * the reserve history (a Sync with no event after it is a bare sync()).
 */
export function assemblePoolEvents(logs: PoolLog[]): { events: PoolEvent[]; syncs: SyncLog[] } {
  const sorted = [...logs].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const lastSync = new Map<string, SyncLog>();
  const events: PoolEvent[] = [];
  const syncs: SyncLog[] = [];
  for (const l of sorted) {
    if (l.kind === 'sync') {
      lastSync.set(l.pair, l);
      syncs.push(l);
      continue;
    }
    const s = lastSync.get(l.pair);
    const fresh = s && s.txHash === l.txHash && s.logIndex < l.logIndex;
    events.push({ ...l, reserve0: fresh ? s.reserve0 : null, reserve1: fresh ? s.reserve1 : null });
  }
  return { events, syncs };
}

// ------------------------------------------------------------- the clock ----

/** Target block time on chain 3961 (Clique, 7 s period). Used only to extrapolate. */
export const BLOCK_TIME_SEC = 7;

/**
 * Block number → unix seconds.
 *
 * `ensure` fetches the exact timestamp of every block it is given (as batched
 * eth_getBlockByNumber calls), up to `maxExact` of the most recent ones; older
 * blocks beyond that are placed by linear interpolation between the nearest
 * fetched blocks, so a chart over thousands of trades costs a bounded number of
 * requests. `at` answers from the cache and interpolates otherwise.
 */
export class BlockClock {
  private readonly known = new Map<number, number>();

  constructor(seed?: Record<string, number> | Map<number, number>) {
    if (seed instanceof Map) for (const [b, t] of seed) this.known.set(b, t);
    else if (seed) for (const [b, t] of Object.entries(seed)) this.known.set(Number(b), t);
  }

  set(block: number, timestamp: number): void {
    this.known.set(block, timestamp);
  }

  has(block: number): boolean {
    return this.known.has(block);
  }

  /** Serialisable copy of every exact timestamp held. */
  toJSON(): Record<string, number> {
    return Object.fromEntries([...this.known.entries()].map(([b, t]) => [String(b), t]));
  }

  get size(): number {
    return this.known.size;
  }

  async ensure(rpc: RpcSender, blocks: number[], maxExact = 800, batch = 50): Promise<void> {
    const missing = [...new Set(blocks)].filter((b) => !this.known.has(b)).sort((a, b) => b - a);
    let wanted = missing.slice(0, maxExact);
    // Beyond the cap, fetch evenly spaced anchors among the older blocks to interpolate between.
    const rest = missing.slice(maxExact);
    if (rest.length > 0) {
      const step = Math.max(1, Math.floor(rest.length / 64));
      wanted = wanted.concat(rest.filter((_, i) => i % step === 0), [rest[rest.length - 1]]);
    }
    for (let i = 0; i < wanted.length; i += batch) {
      const slice = wanted.slice(i, i + batch);
      const results = await Promise.all(
        slice.map((b) =>
          rpc.send('eth_getBlockByNumber', [hex(b), false]).then(
            (r) => r as { timestamp?: string } | null,
            () => null,
          ),
        ),
      );
      results.forEach((r, j) => {
        if (r?.timestamp) this.known.set(slice[j], Number(BigInt(r.timestamp)));
      });
    }
  }

  /** Exact when known; otherwise interpolated between (or extrapolated from) the nearest known blocks. */
  at(block: number): number | null {
    const exact = this.known.get(block);
    if (exact !== undefined) return exact;
    if (this.known.size === 0) return null;
    let below: [number, number] | null = null;
    let above: [number, number] | null = null;
    for (const [b, t] of this.known) {
      if (b < block && (!below || b > below[0])) below = [b, t];
      if (b > block && (!above || b < above[0])) above = [b, t];
    }
    if (below && above) {
      return Math.round(below[1] + ((above[1] - below[1]) * (block - below[0])) / (above[0] - below[0]));
    }
    if (below) return below[1] + (block - below[0]) * BLOCK_TIME_SEC;
    if (above) return above[1] - (above[0] - block) * BLOCK_TIME_SEC;
    return null;
  }
}
