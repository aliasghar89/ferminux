import type { Contract, Interface, JsonRpcProvider, Log, LogDescription } from "ethers";
import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import type { V3ContractKey } from "./config.js";

export const REORG_DEPTH = 12;
export const DEFAULT_CHUNK_SIZE = 2000;
const ZERO_BYTES32 = "0x" + "0".repeat(64);

export interface IndexedAgentEvent {
  eventName: string;
  id: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  /** block timestamp (unix seconds) */
  ts: number;
}
export interface IndexedJobEvent {
  eventName: string;
  jobId: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  ts: number;
  /** parsed event args (bigints as strings) */
  args: Record<string, unknown>;
}
export interface IndexedV3Event {
  key: V3ContractKey;
  parsed: LogDescription;
  args: Record<string, unknown>;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  ts: number;
}
export interface IndexerHooks {
  /** called after the agents row was upserted for a registry event */
  onAgentEvent?: (ev: IndexedAgentEvent) => void;
  /** called after the jobs row was upserted for an escrow event */
  onJobEvent?: (ev: IndexedJobEvent) => void;
  /** called for every decoded log from an Addendum v3 contract */
  onV3Event?: (ev: IndexedV3Event) => void;
}
/** An Addendum v3 contract to watch (present only when its address is deployed). */
export interface V3Watch {
  key: V3ContractKey;
  address: string;
  iface: Interface;
}

export interface IndexerContext {
  provider: JsonRpcProvider;
  registry: Contract;
  escrow: Contract;
  registryAddress: string;
  escrowAddress: string;
  db: Db;
  deployBlock: number;
  chunkSize?: number;
  /** activity / bounty hooks (server.ts); absent in unit tests */
  hooks?: IndexerHooks;
  /** Addendum v3 contracts (only the deployed ones) and the block to backfill from */
  v3?: { contracts: V3Watch[]; deployBlock?: number };
}

/** Block timestamps are fetched lazily (one RPC per distinct block) and cached per process. */
const blockTsCache = new Map<number, number>();
async function blockTimestamp(provider: JsonRpcProvider, blockNumber: number): Promise<number> {
  const cached = blockTsCache.get(blockNumber);
  if (cached !== undefined) return cached;
  try {
    const block = await provider.getBlock(blockNumber);
    const ts = block?.timestamp ?? Math.floor(Date.now() / 1000);
    if (blockTsCache.size > 5000) blockTsCache.clear();
    blockTsCache.set(blockNumber, ts);
    return ts;
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

/**
 * Splits [fromBlock, toBlock] into contiguous, inclusive chunks of at most
 * `chunkSize` blocks each. Pure function — used by getLogs polling and unit
 * tested directly.
 */
export function chunkRange(fromBlock: number, toBlock: number, chunkSize: number): Array<[number, number]> {
  if (chunkSize <= 0) throw new Error("chunkRange: chunkSize must be > 0");
  if (fromBlock > toBlock) return [];
  const chunks: Array<[number, number]> = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    chunks.push([start, end]);
    start = end + 1;
  }
  return chunks;
}

function getIndexedBlock(db: Db, deployBlock: number): number {
  const v = getMeta(db, "indexedBlock");
  return v !== undefined ? Number(v) : deployBlock - 1;
}

function stringifyValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(stringifyValue);
  return v;
}

function serializeArgs(parsed: LogDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  parsed.fragment.inputs.forEach((input, i) => {
    const key = input.name || String(i);
    out[key] = stringifyValue(parsed.args[i]);
  });
  return out;
}

/** One indexing tick: catches up to head, re-scanning the last REORG_DEPTH blocks. */
export async function indexOnce(ctx: IndexerContext): Promise<{ head: number; indexedBlock: number }> {
  const head = await ctx.provider.getBlockNumber();
  const lastIndexed = getIndexedBlock(ctx.db, ctx.deployBlock);
  const fromBlock = Math.max(ctx.deployBlock, lastIndexed - REORG_DEPTH + 1);

  if (fromBlock > head) {
    return { head, indexedBlock: lastIndexed };
  }

  // Reorg safety: drop any previously recorded events in the re-scan window
  // (and anything beyond, in case a prior tick was interrupted) before
  // re-inserting from the chain's current view.
  ctx.db.prepare("DELETE FROM events WHERE blockNumber >= ?").run(fromBlock);

  const chunkSize = ctx.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const v3 = ctx.v3?.contracts ?? [];
  // One-off v3 backfill: the v3 contracts were deployed after the base indexer
  // passed their deploy block, so scan [v3DeployBlock, fromBlock) for them once.
  const v3From = ctx.v3?.deployBlock;
  const v3Key = v3.map((c) => c.address.toLowerCase()).sort().join(",");
  if (v3.length && v3From !== undefined && v3From < fromBlock && getMeta(ctx.db, "v3Backfilled") !== v3Key) {
    for (const [start, end] of chunkRange(v3From, fromBlock - 1, chunkSize)) {
      const logs = await ctx.provider.getLogs({ address: v3.map((c) => c.address), fromBlock: start, toBlock: end });
      for (const log of logs) await handleLog(ctx, log);
    }
    setMeta(ctx.db, "v3Backfilled", v3Key);
  }

  const addresses = [ctx.registryAddress, ctx.escrowAddress, ...v3.map((c) => c.address)];
  for (const [start, end] of chunkRange(fromBlock, head, chunkSize)) {
    const logs = await ctx.provider.getLogs({
      address: addresses,
      fromBlock: start,
      toBlock: end,
    });
    // Preserve on-chain order within the chunk.
    for (const log of logs) {
      await handleLog(ctx, log);
    }
    // progress per chunk: a crash mid-backfill resumes here instead of from lastIndexed (the events DELETE above
    // only covers the reorg window, and every handler is idempotent on (txHash, logIndex))
    setMeta(ctx.db, "indexedBlock", String(end));
  }

  setMeta(ctx.db, "indexedBlock", String(head));
  return { head, indexedBlock: head };
}

/**
 * Contract state read at the event's block, or at `latest` when the RPC is not
 * an archive node ("missing trie node" / "state not available"). The latest
 * state is always at least as new as the event's, and every later event for
 * the same id re-reads it anyway.
 */
async function readAtBlock<T>(label: string, blockNumber: number, read: (overrides: { blockTag?: number }) => Promise<T>): Promise<T> {
  try {
    return await read({ blockTag: blockNumber });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!/missing trie node|state (is )?not available|pruned|historical state|not found|unsupported block|BAD_DATA|CALL_EXCEPTION/i.test(msg)) throw err;
    console.warn(`[indexer] ${label} @ block ${blockNumber} failed (${msg.slice(0, 80)}) — reading latest state instead`);
    return read({});
  }
}

async function handleV3Log(ctx: IndexerContext, watch: V3Watch, log: Log): Promise<void> {
  let parsed: LogDescription | null;
  try {
    parsed = watch.iface.parseLog({ topics: log.topics as string[], data: log.data });
  } catch {
    return;
  }
  if (!parsed) return;
  const ts = await blockTimestamp(ctx.provider, log.blockNumber);
  ctx.db
    .prepare(
      `INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txHash, logIndex) DO UPDATE SET
         blockNumber=excluded.blockNumber, contractName=excluded.contractName,
         eventName=excluded.eventName, argsJSON=excluded.argsJSON, ts=excluded.ts`,
    )
    .run(log.transactionHash, log.index, log.blockNumber, watch.key, parsed.name, JSON.stringify(serializeArgs(parsed)), ts);
  try {
    ctx.hooks?.onV3Event?.({ key: watch.key, parsed, args: serializeArgs(parsed), blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.index, ts });
  } catch (err) {
    console.error(`[indexer] v3 hook failed for ${watch.key}.${parsed.name} @ block ${log.blockNumber}:`, err);
  }
}

async function handleLog(ctx: IndexerContext, log: Log): Promise<void> {
  const isRegistry = log.address.toLowerCase() === ctx.registryAddress.toLowerCase();
  const isEscrow = log.address.toLowerCase() === ctx.escrowAddress.toLowerCase();
  if (!isRegistry && !isEscrow) {
    const watch = ctx.v3?.contracts.find((c) => c.address.toLowerCase() === log.address.toLowerCase());
    if (watch) await handleV3Log(ctx, watch, log);
    return;
  }

  const iface = isRegistry ? ctx.registry.interface : ctx.escrow.interface;
  let parsed: LogDescription | null;
  try {
    parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
  } catch {
    return;
  }
  if (!parsed) return;

  const ts = await blockTimestamp(ctx.provider, log.blockNumber);
  ctx.db
    .prepare(
      `INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txHash, logIndex) DO UPDATE SET
         blockNumber=excluded.blockNumber, contractName=excluded.contractName,
         eventName=excluded.eventName, argsJSON=excluded.argsJSON, ts=excluded.ts`,
    )
    .run(
      log.transactionHash,
      log.index,
      log.blockNumber,
      isRegistry ? "registry" : "escrow",
      parsed.name,
      JSON.stringify(serializeArgs(parsed)),
      ts,
    );

  try {
    if (isRegistry) {
      const idArg = parsed.args.id as bigint | undefined;
      if (idArg !== undefined) {
        await refreshAgent(ctx, idArg, log.blockNumber);
        if (ctx.hooks?.onAgentEvent) {
          ctx.hooks.onAgentEvent({ eventName: parsed.name, id: Number(idArg), blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.index, ts });
        }
      }
    } else {
      const jobIdArg = parsed.args.jobId as bigint | undefined;
      if (jobIdArg !== undefined) {
        await refreshJob(ctx, jobIdArg, log.blockNumber, log.transactionHash, parsed.name);
        if (ctx.hooks?.onJobEvent) {
          ctx.hooks.onJobEvent({
            eventName: parsed.name,
            jobId: Number(jobIdArg),
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.index,
            ts,
            args: serializeArgs(parsed),
          });
        }
      }
    }
  } catch (err) {
    // Never let a single bad event kill the indexing loop.
    console.error(`[indexer] failed to refresh state for ${parsed.name} @ block ${log.blockNumber}:`, err);
  }
}

async function refreshAgent(ctx: IndexerContext, id: bigint, blockNumber: number): Promise<void> {
  const agent = await readAtBlock(`getAgent(${id})`, blockNumber, (o) => ctx.registry.getAgent(id, o));
  const idNum = Number(id);
  const existing = ctx.db.prepare("SELECT card, online, lastSeen FROM agents WHERE id = ?").get(idNum) as
    | { card: string | null; online: number; lastSeen: number | null }
    | undefined;

  ctx.db
    .prepare(
      `INSERT INTO agents (id, owner, name, endpoint, metadataURI, pricePerJob, bond, status, registeredAt, retiredAt,
         jobsCompleted, jobsFailed, ratingCount, ratingSum, card, online, lastSeen, updatedAtBlock)
       VALUES (@id,@owner,@name,@endpoint,@metadataURI,@pricePerJob,@bond,@status,@registeredAt,@retiredAt,
         @jobsCompleted,@jobsFailed,@ratingCount,@ratingSum,@card,@online,@lastSeen,@updatedAtBlock)
       ON CONFLICT(id) DO UPDATE SET
         owner=excluded.owner, name=excluded.name, endpoint=excluded.endpoint, metadataURI=excluded.metadataURI,
         pricePerJob=excluded.pricePerJob, bond=excluded.bond, status=excluded.status,
         registeredAt=excluded.registeredAt, retiredAt=excluded.retiredAt,
         jobsCompleted=excluded.jobsCompleted, jobsFailed=excluded.jobsFailed,
         ratingCount=excluded.ratingCount, ratingSum=excluded.ratingSum, updatedAtBlock=excluded.updatedAtBlock`,
    )
    .run({
      id: idNum,
      owner: agent.owner,
      name: agent.name,
      endpoint: agent.endpoint,
      metadataURI: agent.metadataURI,
      pricePerJob: (agent.pricePerJob as bigint).toString(),
      bond: (agent.bond as bigint).toString(),
      status: Number(agent.status),
      registeredAt: Number(agent.registeredAt),
      retiredAt: Number(agent.retiredAt),
      jobsCompleted: Number(agent.jobsCompleted),
      jobsFailed: Number(agent.jobsFailed),
      ratingCount: Number(agent.ratingCount),
      ratingSum: Number(agent.ratingSum),
      card: existing?.card ?? null,
      online: existing?.online ?? 0,
      lastSeen: existing?.lastSeen ?? null,
      updatedAtBlock: blockNumber,
    });
}

async function refreshJob(
  ctx: IndexerContext,
  jobId: bigint,
  blockNumber: number,
  txHash: string,
  eventName: string,
): Promise<void> {
  const job = await readAtBlock(`getJob(${jobId})`, blockNumber, (o) => ctx.escrow.getJob(jobId, o));
  const idNum = Number(jobId);
  const existing = ctx.db.prepare("SELECT txRequested, txDelivered, txClosed FROM jobs WHERE id = ?").get(idNum) as
    | { txRequested: string | null; txDelivered: string | null; txClosed: string | null }
    | undefined;

  let txRequested = existing?.txRequested ?? null;
  let txDelivered = existing?.txDelivered ?? null;
  let txClosed = existing?.txClosed ?? null;
  if (eventName === "JobRequested") txRequested = txHash;
  if (eventName === "JobDelivered") txDelivered = txHash;
  if (eventName === "JobCompleted" || eventName === "JobRefunded" || eventName === "JobResolved") txClosed = txHash;

  const outputHash = job.outputHash as string;
  const deliveredAtNum = Number(job.deliveredAt);

  ctx.db
    .prepare(
      `INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, outputHash, outputURI, createdAt,
         deliveredAt, status, txRequested, txDelivered, txClosed, updatedAtBlock)
       VALUES (@id,@agentId,@client,@amount,@inputHash,@inputURI,@outputHash,@outputURI,@createdAt,
         @deliveredAt,@status,@txRequested,@txDelivered,@txClosed,@updatedAtBlock)
       ON CONFLICT(id) DO UPDATE SET
         agentId=excluded.agentId, client=excluded.client, amount=excluded.amount, inputHash=excluded.inputHash,
         inputURI=excluded.inputURI, outputHash=excluded.outputHash, outputURI=excluded.outputURI,
         createdAt=excluded.createdAt, deliveredAt=excluded.deliveredAt, status=excluded.status,
         txRequested=excluded.txRequested, txDelivered=excluded.txDelivered, txClosed=excluded.txClosed,
         updatedAtBlock=excluded.updatedAtBlock`,
    )
    .run({
      id: idNum,
      agentId: Number(job.agentId),
      client: job.client,
      amount: (job.amount as bigint).toString(),
      inputHash: job.inputHash,
      inputURI: job.inputURI,
      outputHash: outputHash && outputHash !== ZERO_BYTES32 ? outputHash : null,
      outputURI: job.outputURI || null,
      createdAt: Number(job.createdAt),
      deliveredAt: deliveredAtNum > 0 ? deliveredAtNum : null,
      status: Number(job.status),
      txRequested,
      txDelivered,
      txClosed,
      updatedAtBlock: blockNumber,
    });
}

/** Starts the poll loop. Never overlaps ticks; logs and continues on error. */
export function startIndexer(ctx: IndexerContext, pollMs: number): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await indexOnce(ctx);
    } catch (err) {
      console.error("[indexer] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, pollMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
