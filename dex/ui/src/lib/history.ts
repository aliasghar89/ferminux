// ---------------------------------------------------------------------------
// One account's DEX history, read from the chain: swaps, liquidity added and
// removed, wraps and unwraps, and approvals it gave the router or the locker.
//
// A pool's logs say where output went, not who signed. So the history is
// assembled in two steps:
//   1. collect candidate transactions: pool logs whose recipient is the
//      account (a swap's `to`, a Burn's `to`, LP minted to it), WFMX
//      Deposit/Withdrawal and token Approval logs it emitted, and every pool
//      log whose recipient was the ROUTER (a sale into native FMX, or a
//      removal unwrapped to FMX, pays the router, which forwards the coin);
//   2. read each candidate transaction once (eth_getTransactionByHash, cached
//      forever: a confirmed transaction never changes) and keep the ones the
//      account signed.
// Each kept transaction becomes one item, built from the pool events in it.
//
// No browser globals.
// ---------------------------------------------------------------------------

import { getAddress } from 'ethers';
import {
  BlockClock,
  TOPICS,
  ZERO_TOPIC,
  addressTopic,
  assemblePoolEvents,
  decodePoolLog,
  scanLogs,
  type LogSource,
  type PoolEvent,
  type RawLog,
  type RpcSender,
} from './events.ts';
import type { MarketState } from './market.ts';
import type { PairSnapshot } from './pairs.ts';
import { nativeToken, type TokenInfo } from './tokens.ts';

export interface TxInfo {
  from: string;
  to: string | null;
  /** Native FMX sent with the transaction, wei. */
  value: bigint;
}

export type ActivityItem =
  | {
      kind: 'swap';
      txHash: string;
      block: number;
      time: number | null;
      tokenIn: TokenInfo;
      amountIn: bigint;
      tokenOut: TokenInfo;
      amountOut: bigint;
      /** Token symbols along the route, first to last. */
      route: string[];
    }
  | {
      kind: 'add' | 'remove';
      txHash: string;
      block: number;
      time: number | null;
      pool: PairSnapshot;
      amount0: bigint;
      amount1: bigint;
      /** Remove: whether the WFMX side was paid out as native FMX. */
      native: boolean;
    }
  | { kind: 'wrap' | 'unwrap'; txHash: string; block: number; time: number | null; amount: bigint }
  | {
      kind: 'approve';
      txHash: string;
      block: number;
      time: number | null;
      tokenLabel: string;
      decimals: number;
      spender: 'router' | 'locker';
      amount: bigint;
    };

export interface HistoryContext {
  source: LogSource;
  rpc: RpcSender;
  clock: BlockClock;
  account: string;
  pools: PairSnapshot[];
  tokens: TokenInfo[];
  wfmx: string;
  router: string;
  locker: string;
  market: MarketState;
  fromBlock: number;
  head: number;
  /** Transactions already read, by lowercase hash. Filled in place. */
  txCache: Map<string, TxInfo>;
}

async function readTx(rpc: RpcSender, hash: string): Promise<TxInfo | null> {
  const tx = (await rpc.send('eth_getTransactionByHash', [hash])) as { from?: string; to?: string | null; value?: string } | null;
  if (!tx?.from) return null;
  return { from: getAddress(tx.from), to: tx.to ? getAddress(tx.to) : null, value: BigInt(tx.value ?? '0x0') };
}

/** Read every hash not yet in `cache`, a batch at a time. */
export async function fillTxCache(rpc: RpcSender, hashes: string[], cache: Map<string, TxInfo>, batch = 40): Promise<void> {
  const missing = [...new Set(hashes.map((h) => h.toLowerCase()))].filter((h) => !cache.has(h));
  for (let i = 0; i < missing.length; i += batch) {
    const slice = missing.slice(i, i + batch);
    const txs = await Promise.all(slice.map((h) => readTx(rpc, h).catch(() => null)));
    txs.forEach((tx, j) => {
      if (tx) cache.set(slice[j], tx);
    });
  }
}

export async function loadAccountActivity(ctx: HistoryContext): Promise<ActivityItem[]> {
  const account = getAddress(ctx.account);
  const acct = addressTopic(account);
  const pairAddrs = ctx.pools.map((p) => p.pair);
  const tokenAddrs = ctx.tokens.filter((t) => t.kind === 'erc20').map((t) => t.address);

  const direct: RawLog[] = [];
  if (pairAddrs.length > 0) {
    direct.push(
      ...(await scanLogs(ctx.source, { address: pairAddrs, topics: [[TOPICS.swap, TOPICS.burn], null, acct] }, ctx.fromBlock, ctx.head)),
      ...(await scanLogs(ctx.source, { address: pairAddrs, topics: [TOPICS.transfer, ZERO_TOPIC, acct] }, ctx.fromBlock, ctx.head)),
    );
  }
  const own = await scanLogs(
    ctx.source,
    {
      address: [...new Set([ctx.wfmx, ...tokenAddrs, ...pairAddrs].map((a) => a.toLowerCase()))],
      topics: [[TOPICS.deposit, TOPICS.withdrawal, TOPICS.approval], acct],
    },
    ctx.fromBlock,
    ctx.head,
  );

  // Pool events paying the router: native-FMX sales and FMX-unwrapping removals.
  const router = ctx.router.toLowerCase();
  const { events } = assemblePoolEvents(ctx.market.logs);
  const viaRouter = events.filter(
    (e) => (e.kind === 'swap' && e.to.toLowerCase() === router) || (e.kind === 'burn' && e.to?.toLowerCase() === router),
  );

  const candidates = new Set<string>([
    ...direct.map((l) => l.transactionHash.toLowerCase()),
    ...own.map((l) => l.transactionHash.toLowerCase()),
    ...viaRouter.map((e) => e.txHash),
  ]);
  await fillTxCache(ctx.rpc, [...candidates], ctx.txCache);

  const signed = [...candidates].filter((h) => ctx.txCache.get(h)?.from === account);
  const byTx = new Map<string, { events: PoolEvent[]; own: RawLog[]; direct: RawLog[] }>();
  for (const h of signed) byTx.set(h, { events: [], own: [], direct: [] });
  for (const e of events) byTx.get(e.txHash)?.events.push(e);
  for (const l of own) byTx.get(l.transactionHash.toLowerCase())?.own.push(l);
  for (const l of direct) byTx.get(l.transactionHash.toLowerCase())?.direct.push(l);

  // A transaction newer than the market record: read its pool logs directly.
  for (const [h, bucket] of byTx) {
    if (bucket.events.length === 0 && bucket.direct.length > 0) {
      const block = bucket.direct[0].blockNumber;
      const raw = await scanLogs(ctx.source, { address: pairAddrs, topics: [[TOPICS.swap, TOPICS.sync, TOPICS.mint, TOPICS.burn]] }, block, block);
      const decoded = raw.filter((r) => r.transactionHash.toLowerCase() === h).map(decodePoolLog).filter((x) => x !== null);
      bucket.events = assemblePoolEvents(decoded).events;
    }
  }

  const poolsByAddr = new Map(ctx.pools.map((p) => [p.pair.toLowerCase(), p]));
  const tokensByAddr = new Map<string, TokenInfo>();
  for (const t of ctx.tokens) if (t.kind === 'erc20') tokensByAddr.set(t.address.toLowerCase(), t);
  const native = nativeToken(ctx.wfmx);
  const wfmx = ctx.wfmx.toLowerCase();

  const items: ActivityItem[] = [];
  for (const [hash, bucket] of byTx) {
    const tx = ctx.txCache.get(hash)!;
    const blockOf = bucket.events[0]?.block ?? bucket.own[0]?.blockNumber ?? bucket.direct[0]?.blockNumber;
    if (blockOf === undefined) continue;
    const time = ctx.clock.at(blockOf);
    const swaps = bucket.events.filter((e) => e.kind === 'swap').sort((a, b) => a.logIndex - b.logIndex);
    const mints = bucket.events.filter((e) => e.kind === 'mint');
    const burns = bucket.events.filter((e) => e.kind === 'burn');

    if (swaps.length > 0) {
      const first = swaps[0];
      const last = swaps[swaps.length - 1];
      const p0 = poolsByAddr.get(first.pair);
      const p1 = poolsByAddr.get(last.pair);
      if (!p0 || !p1 || first.kind !== 'swap' || last.kind !== 'swap') continue;
      const inIs0 = first.amount0In > 0n;
      const outIs0 = last.amount0Out > 0n;
      let tokenIn = inIs0 ? p0.token0 : p0.token1;
      let tokenOut = outIs0 ? p1.token0 : p1.token1;
      // FMX, not WFMX, when the router wrapped the input (value sent) or unwrapped the output (paid to the router).
      if (tokenIn.address.toLowerCase() === wfmx && tx.value > 0n) tokenIn = native;
      if (tokenOut.address.toLowerCase() === wfmx && last.to.toLowerCase() === router) tokenOut = native;
      const route = [tokenIn.symbol];
      for (const s of swaps) {
        if (s.kind !== 'swap') continue;
        const p = poolsByAddr.get(s.pair);
        if (p) route.push((s.amount0Out > 0n ? p.token0 : p.token1).symbol);
      }
      route[route.length - 1] = tokenOut.symbol;
      items.push({
        kind: 'swap',
        txHash: hash,
        block: blockOf,
        time,
        tokenIn,
        amountIn: inIs0 ? first.amount0In : first.amount1In,
        tokenOut,
        amountOut: outIs0 ? last.amount0Out : last.amount1Out,
        route,
      });
      continue;
    }
    if (mints.length > 0 || burns.length > 0) {
      const e = (mints[0] ?? burns[0]) as PoolEvent & { amount0: bigint; amount1: bigint };
      const pool = poolsByAddr.get(e.pair);
      if (!pool) continue;
      items.push({
        kind: mints.length > 0 ? 'add' : 'remove',
        txHash: hash,
        block: blockOf,
        time,
        pool,
        amount0: e.amount0,
        amount1: e.amount1,
        native: e.kind === 'burn' ? e.to?.toLowerCase() === router : tx.value > 0n,
      });
      continue;
    }
    const dep = bucket.own.find((l) => l.topics[0] === TOPICS.deposit && l.address.toLowerCase() === wfmx);
    const wd = bucket.own.find((l) => l.topics[0] === TOPICS.withdrawal && l.address.toLowerCase() === wfmx);
    if (dep || wd) {
      const l = (dep ?? wd)!;
      items.push({ kind: dep ? 'wrap' : 'unwrap', txHash: hash, block: blockOf, time, amount: BigInt(l.data) });
      continue;
    }
    const approval = bucket.own.find((l) => l.topics[0] === TOPICS.approval);
    if (approval && approval.topics[2]) {
      const spender = getAddress('0x' + approval.topics[2].slice(-40)).toLowerCase();
      const label = spender === router ? 'router' : spender === ctx.locker.toLowerCase() ? 'locker' : null;
      if (!label) continue;
      const addr = approval.address.toLowerCase();
      const pool = poolsByAddr.get(addr);
      const token = tokensByAddr.get(addr);
      items.push({
        kind: 'approve',
        txHash: hash,
        block: blockOf,
        time,
        tokenLabel: pool ? `${pool.token0.symbol}/${pool.token1.symbol} LP` : (token?.symbol ?? approval.address),
        decimals: pool ? 18 : (token?.decimals ?? 18),
        spender: label,
        amount: BigInt(approval.data),
      });
    }
  }
  await ctx.clock.ensure(ctx.rpc, items.map((i) => i.block));
  for (const it of items) it.time = ctx.clock.at(it.block);
  return items.sort((a, b) => b.block - a.block);
}
