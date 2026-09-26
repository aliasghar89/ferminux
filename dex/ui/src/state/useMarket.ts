import { useEffect, useMemo, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { CHAIN_ID, DEX_ADDRESSES, DEX_START_BLOCK } from '../config.ts';
import { BlockClock, rpcLogSource, type SyncLog } from '../lib/events.ts';
import type { TxInfo } from '../lib/history.ts';
import {
  deserializeMarket,
  emptyMarket,
  marketOverview,
  poolStats,
  refreshMarket,
  serializeMarket,
  syncLogs,
  tradesFrom,
  type MarketOverview,
  type MarketState,
  type PoolStats,
  type Trade,
} from '../lib/market.ts';
import type { PairSnapshot } from '../lib/pairs.ts';
import { baseTable, priceTable, type PriceTable } from '../lib/prices.ts';
import type { PoolsState } from './usePools.ts';

export interface MarketData {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  record: MarketState;
  clock: BlockClock;
  /** Bases that need no pool: FMX at the official price, the pegged tokens. */
  pegs: PriceTable;
  /** `pegs` plus a derived value for every other pool token. */
  prices: PriceTable;
  pools: Map<string, PairSnapshot>;
  trades: Trade[];
  syncs: SyncLog[];
  stats: Map<string, PoolStats>;
  overview: MarketOverview;
  /** Chain time the figures are computed at (unix seconds). */
  now: number;
  /** Transactions read so far (the Activity page fills it). */
  txCache: Map<string, TxInfo>;
}

const STORE_KEY = `ferminux-dex.market.v1:${CHAIN_ID}:${DEX_ADDRESSES.factory.toLowerCase()}`;

interface Stored {
  market: string;
  clock: Record<string, number>;
  txs: Array<[string, { from: string; to: string | null; value: string }]>;
}

function loadStored(): { market: MarketState; clock: BlockClock; txs: Map<string, TxInfo> } {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Stored;
      const market = deserializeMarket(parsed.market);
      if (market) {
        return {
          market,
          clock: new BlockClock(parsed.clock),
          txs: new Map(parsed.txs.map(([h, t]) => [h, { from: t.from, to: t.to, value: BigInt(t.value) }])),
        };
      }
    }
  } catch {
    /* a fresh scan it is */
  }
  return { market: emptyMarket(), clock: new BlockClock(), txs: new Map() };
}

function save(market: MarketState, clock: BlockClock, txs: Map<string, TxInfo>): void {
  try {
    const stored: Stored = {
      market: serializeMarket(market),
      clock: clock.toJSON(),
      txs: [...txs.entries()].slice(-2000).map(([h, t]) => [h, { from: t.from, to: t.to, value: t.value.toString() }]),
    };
    window.localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    /* storage full or blocked: the record is rebuilt from the chain next visit */
  }
}

/**
 * Every pool's trade and reserve history, brought up to the chain head on each
 * new block and kept in this browser between visits, plus everything derived
 * from it (volume, fees, APR, the overview). The chain is the only source.
 */
export function useMarket(
  provider: JsonRpcProvider | null,
  pools: PoolsState,
  head: number | null,
  chainTime: number | null,
): MarketData {
  const stored = useRef<ReturnType<typeof loadStored> | null>(null);
  if (stored.current === null) stored.current = loadStored();
  const [record, setRecord] = useState<MarketState>(stored.current.market);
  const clock = stored.current.clock;
  const txCache = stored.current.txs;
  const [clockVersion, setClockVersion] = useState(0);
  const [status, setStatus] = useState<MarketData['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const recordRef = useRef(record);
  recordRef.current = record;

  const pairKey = pools.pairs.map((p) => p.pair.toLowerCase()).sort().join(',');

  useEffect(() => {
    if (!provider || head === null || pools.pairs.length === 0 || busy.current) return;
    busy.current = true;
    setStatus((s) => (s === 'ready' ? 'ready' : 'loading'));
    // A cached record from a chain that has since been reset (a devnet) is discarded.
    const current = Object.values(recordRef.current.scanned).some((b) => b > head) ? emptyMarket() : recordRef.current;
    refreshMarket(current, {
      source: rpcLogSource(provider),
      rpc: provider,
      clock,
      pairs: pools.pairs.map((p) => p.pair),
      head,
      startBlock: DEX_START_BLOCK,
    })
      .then((next) => {
        if (!mounted.current) return;
        setRecord(next);
        setClockVersion((v) => v + 1);
        setStatus('ready');
        setError(null);
        save(next, clock, txCache);
      })
      .catch((err) => {
        if (!mounted.current) return;
        setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        busy.current = false;
      });
    // A refresh in flight is never discarded when the next block arrives: it
    // simply finishes, and the block after picks up from where it stopped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, head, pairKey]);

  const now = chainTime ?? Math.floor(Date.now() / 1000);

  const derived = useMemo(() => {
    const byAddr = new Map(pools.pairs.map((p) => [p.pair.toLowerCase(), p]));
    const pegs = baseTable(DEX_ADDRESSES.wfmx);
    const prices = priceTable(pools.index, pegs);
    const trades = tradesFrom(record, byAddr, prices, clock);
    const stats = new Map(pools.pairs.map((p) => [p.pair.toLowerCase(), poolStats(p, trades, prices, now)]));
    return { byAddr, pegs, prices, trades, stats, overview: marketOverview([...stats.values()], trades), syncs: syncLogs(record) };
    // clockVersion: timestamps arrive with the record; `now` moves every block
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, pools.pairs, pools.index, clockVersion, Math.floor(now / 60)]);

  return {
    status,
    error,
    record,
    clock,
    pegs: derived.pegs,
    prices: derived.prices,
    pools: derived.byAddr,
    trades: derived.trades,
    syncs: derived.syncs,
    stats: derived.stats,
    overview: derived.overview,
    now,
    txCache,
  };
}

/** Persist the transaction cache after the Activity page filled it. */
export function persistMarket(m: MarketData): void {
  save(m.record, m.clock, m.txCache);
}
