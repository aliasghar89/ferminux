import type { Contract, Interface, JsonRpcProvider, Log, LogDescription } from "ethers";
import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import type { V3ContractKey } from "./config.js";

/**
 * Blocks re-checked every tick: the chain's reorg cap. A node whose head is an authority block refuses a reorg
 * deeper than 64 (README "Max reorg depth"); the old 12 left blocks 13–64 deep unguarded.
 */
export const REORG_DEPTH = 64;
export const DEFAULT_CHUNK_SIZE = 2000;
const ZERO_BYTES32 = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x" + "0".repeat(40);

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
/** A recorded event a reorg removed from the chain, as the events table held it. */
export interface RolledBackEvent {
  /** "registry" | "escrow" | a V3ContractKey */
  contractName: string;
  eventName: string;
  /** parsed event args (bigints as strings) */
  args: Record<string, unknown>;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}
export interface IndexerHooks {
  /** called after the agents row was upserted for a registry event */
  onAgentEvent?: (ev: IndexedAgentEvent) => void;
  /** called after the jobs row was upserted for an escrow event */
  onJobEvent?: (ev: IndexedJobEvent) => void;
  /** called for every decoded log from an Addendum v3 contract */
  onV3Event?: (ev: IndexedV3Event) => void;
  /**
   * Undo what onAgentEvent / onJobEvent wrote for a registry / escrow event a reorg removed. Called newest first,
   * inside the rollback's transaction, while the event's own row is still in `events`.
   */
  onRollback?: (ev: RolledBackEvent) => void;
  /** The same for an Addendum v3 event: undo what onV3Event derived from it. */
  onV3Rollback?: (ev: RolledBackEvent) => void;
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

/**
 * One indexing tick: re-checks the last REORG_DEPTH indexed blocks against the chain, rolls back everything
 * derived from the first block where they differ, and catches up to head.
 *
 * The re-check is one getLogs over the window, compared with the recorded (txHash, logIndex, blockHash) rows.
 * When nothing differs — the normal tick — only logs in new blocks reach a handler; re-running every handler
 * for 64 blocks each tick would cost a state read per agent / job event and a block timestamp per block.
 */
export async function indexOnce(ctx: IndexerContext): Promise<{ head: number; indexedBlock: number }> {
  const head = await ctx.provider.getBlockNumber();
  const lastIndexed = getIndexedBlock(ctx.db, ctx.deployBlock);
  // A head below what we indexed is a lagging node (or a shorter fork, which outgrows our height within a few
  // blocks): wait, and compare once the chain is past us again.
  if (head < lastIndexed) return { head, indexedBlock: lastIndexed };
  const fromBlock = Math.max(ctx.deployBlock, lastIndexed - REORG_DEPTH + 1);

  if (fromBlock > head) {
    return { head, indexedBlock: lastIndexed };
  }

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
  const getLogs = async (start: number, end: number): Promise<Log[]> => {
    const out: Log[] = [];
    for (const [s, e] of chunkRange(start, end, chunkSize)) out.push(...(await ctx.provider.getLogs({ address: addresses, fromBlock: s, toBlock: e })));
    return out;
  };
  // Normally one getLogs covers the window and the new blocks; a backfill (more than a chunk behind) fetches the
  // window alone and the new blocks chunk by chunk below, recording progress after each.
  const together = head - fromBlock < chunkSize;
  const scanned = await getLogs(fromBlock, together ? head : lastIndexed);

  // Rows past lastIndexed come from a tick that died mid-chunk: rolled back with the fork and applied again.
  const forkAt = Math.min(firstDivergence(ctx, scanned, fromBlock, lastIndexed), lastIndexed + 1);
  const touched = rollbackFrom(ctx, forkAt);

  if (together) {
    // Preserve on-chain order: logs the rollback removed come back first, then the new blocks.
    for (const log of scanned) if (log.blockNumber >= forkAt) await handleLog(ctx, log);
  } else {
    for (const log of scanned) if (log.blockNumber >= forkAt && log.blockNumber <= lastIndexed) await handleLog(ctx, log);
    for (const [start, end] of chunkRange(lastIndexed + 1, head, chunkSize)) {
      const logs = await ctx.provider.getLogs({ address: addresses, fromBlock: start, toBlock: end });
      for (const log of logs) await handleLog(ctx, log);
      // progress per chunk: a crash mid-backfill resumes here instead of from lastIndexed
      setMeta(ctx.db, "indexedBlock", String(end));
    }
  }
  if (touched.agents.size || touched.jobs.size) await rederive(ctx, touched, head);

  setMeta(ctx.db, "indexedBlock", String(head));
  return { head, indexedBlock: head };
}

/** events.contractName of every contract this indexer reads logs from */
function watchedNames(ctx: IndexerContext): string[] {
  return ["registry", "escrow", ...(ctx.v3?.contracts.map((c) => c.key) ?? [])];
}

/** registry / escrow / watched v3 contract that emitted `log`, with the decoded event — or null for a log we never record. */
function decodeLog(ctx: IndexerContext, log: Pick<Log, "address" | "topics" | "data">): { contractName: string; parsed: LogDescription; watch?: V3Watch } | null {
  const address = log.address.toLowerCase();
  const watch = address === ctx.registryAddress.toLowerCase() || address === ctx.escrowAddress.toLowerCase() ? undefined : ctx.v3?.contracts.find((c) => c.address.toLowerCase() === address);
  const contractName = address === ctx.registryAddress.toLowerCase() ? "registry" : address === ctx.escrowAddress.toLowerCase() ? "escrow" : watch?.key;
  if (!contractName) return null;
  const iface = watch ? watch.iface : contractName === "registry" ? ctx.registry.interface : ctx.escrow.interface;
  try {
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    return parsed ? { contractName, parsed, watch } : null;
  } catch {
    return null;
  }
}

/**
 * The lowest block in [fromBlock, lastIndexed] where the recorded events and the chain's logs disagree — a
 * recorded log the chain no longer has, a log it has that we never recorded, or the same log in a block with
 * another hash — or Infinity. Rows recorded before blockHash existed match on (txHash, logIndex, blockNumber)
 * and get their hash filled in here.
 */
function firstDivergence(ctx: IndexerContext, scanned: Log[], fromBlock: number, lastIndexed: number): number {
  if (lastIndexed < fromBlock) return Infinity;
  const watched = watchedNames(ctx);
  const stored = ctx.db
    .prepare(`SELECT txHash, logIndex, blockNumber, blockHash FROM events WHERE blockNumber >= ? AND blockNumber <= ? AND contractName IN (${watched.map(() => "?").join(", ")})`)
    .all(fromBlock, lastIndexed, ...watched) as Array<{ txHash: string; logIndex: number; blockNumber: number; blockHash: string | null }>;
  const byKey = new Map(stored.map((r) => [`${r.txHash.toLowerCase()}:${r.logIndex}`, r]));
  const fillHash = ctx.db.prepare("UPDATE events SET blockHash = ? WHERE txHash = ? AND logIndex = ? AND blockHash IS NULL");
  let fork = Infinity;
  const matched = new Set<string>();
  for (const log of scanned) {
    if (log.blockNumber > lastIndexed) break; // new blocks: nothing recorded to compare with
    if (!decodeLog(ctx, log)) continue;
    const key = `${log.transactionHash.toLowerCase()}:${log.index}`;
    const row = byKey.get(key);
    if (row && row.blockNumber === log.blockNumber && (row.blockHash === null || row.blockHash.toLowerCase() === (log.blockHash ?? "").toLowerCase())) {
      matched.add(key);
      if (row.blockHash === null && log.blockHash) fillHash.run(log.blockHash, row.txHash, row.logIndex);
      continue;
    }
    fork = Math.min(fork, log.blockNumber);
  }
  for (const [key, row] of byKey) if (!matched.has(key)) fork = Math.min(fork, row.blockNumber);
  return fork;
}

/**
 * Removes every recorded event at or above `fromBlock`, newest first, undoing what was derived from each (the
 * hooks), in one transaction. Returns the agents / jobs whose rows the removed events had written, for rederive.
 */
function rollbackFrom(ctx: IndexerContext, fromBlock: number): { agents: Set<number>; jobs: Set<number> } {
  const touched = { agents: new Set<number>(), jobs: new Set<number>() };
  if (!Number.isFinite(fromBlock)) return touched;
  // only contracts still watched: rows of one dropped from the config could not be applied again
  const watched = watchedNames(ctx);
  const rows = ctx.db
    .prepare(`SELECT * FROM events WHERE blockNumber >= ? AND contractName IN (${watched.map(() => "?").join(", ")}) ORDER BY blockNumber DESC, logIndex DESC`)
    .all(fromBlock, ...watched) as Array<{
    txHash: string;
    logIndex: number;
    blockNumber: number;
    contractName: string;
    eventName: string;
    argsJSON: string;
  }>;
  if (!rows.length) return touched;
  const del = ctx.db.prepare("DELETE FROM events WHERE txHash = ? AND logIndex = ?");
  ctx.db.transaction(() => {
    for (const r of rows) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(r.argsJSON) as Record<string, unknown>;
      } catch {
        // undecodable row: nothing derived from its args can be undone, the row itself still goes
      }
      const ev: RolledBackEvent = { contractName: r.contractName, eventName: r.eventName, args, blockNumber: r.blockNumber, txHash: r.txHash, logIndex: r.logIndex };
      try {
        if (r.contractName === "registry" || r.contractName === "escrow") {
          if (r.contractName === "registry" && args.id !== undefined) touched.agents.add(Number(args.id));
          if (r.contractName === "escrow" && args.jobId !== undefined) touched.jobs.add(Number(args.jobId));
          ctx.hooks?.onRollback?.(ev);
        } else {
          ctx.hooks?.onV3Rollback?.(ev);
        }
      } catch (err) {
        console.error(`[indexer] rollback of ${r.contractName}.${r.eventName} @ block ${r.blockNumber} failed:`, err);
      }
      del.run(r.txHash, r.logIndex);
    }
    // jobs.tx* name the latest event of each kind: point them at what is left (a re-applied log moves them again)
    for (const id of touched.jobs) repointJobTxs(ctx.db, id);
  })();
  for (const n of [...blockTsCache.keys()]) if (n >= fromBlock) blockTsCache.delete(n);
  console.warn(`[indexer] rolled back ${rows.length} event(s) from block ${fromBlock} (reorg, or a tick that died mid-chunk)`);
  return touched;
}

function repointJobTxs(db: Db, id: number): void {
  const latest = (names: string[]) =>
    (
      db
        .prepare(`SELECT txHash FROM events WHERE contractName = 'escrow' AND eventName IN (${names.map(() => "?").join(", ")}) AND json_extract(argsJSON, '$.jobId') = ? ORDER BY blockNumber DESC, logIndex DESC LIMIT 1`)
        .get(...names, String(id)) as { txHash: string } | undefined
    )?.txHash ?? null;
  db.prepare("UPDATE jobs SET txRequested = ?, txDelivered = ?, txClosed = ? WHERE id = ?").run(latest(["JobRequested"]), latest(["JobDelivered"]), latest(["JobCompleted", "JobRefunded", "JobResolved"]), id);
}

/** Agents / jobs a rollback touched, re-read from the chain at head; one the chain no longer has loses its row. */
async function rederive(ctx: IndexerContext, touched: { agents: Set<number>; jobs: Set<number> }, head: number): Promise<void> {
  for (const id of touched.agents) {
    try {
      // the registry answers an empty struct for an id it never registered: the registration was reorged out
      const agent = await readAtBlock(`getAgent(${id})`, head, (o) => ctx.registry.getAgent(BigInt(id), o));
      if (String(agent.owner).toLowerCase() === ZERO_ADDRESS) ctx.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      else await refreshAgent(ctx, BigInt(id), head);
    } catch (err) {
      console.error(`[indexer] re-reading agent ${id} after a reorg failed:`, err);
    }
  }
  for (const id of touched.jobs) {
    try {
      const job = await readAtBlock(`getJob(${id})`, head, (o) => ctx.escrow.getJob(BigInt(id), o));
      if (String(job.client).toLowerCase() === ZERO_ADDRESS) ctx.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      else await refreshJob(ctx, BigInt(id), head, "", "");
    } catch (err) {
      console.error(`[indexer] re-reading job ${id} after a reorg failed:`, err);
    }
  }
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
      `INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts, blockHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txHash, logIndex) DO UPDATE SET
         blockNumber=excluded.blockNumber, contractName=excluded.contractName,
         eventName=excluded.eventName, argsJSON=excluded.argsJSON, ts=excluded.ts, blockHash=excluded.blockHash`,
    )
    .run(log.transactionHash, log.index, log.blockNumber, watch.key, parsed.name, JSON.stringify(serializeArgs(parsed)), ts, log.blockHash ?? null);
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
      `INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts, blockHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txHash, logIndex) DO UPDATE SET
         blockNumber=excluded.blockNumber, contractName=excluded.contractName,
         eventName=excluded.eventName, argsJSON=excluded.argsJSON, ts=excluded.ts, blockHash=excluded.blockHash`,
    )
    .run(
      log.transactionHash,
      log.index,
      log.blockNumber,
      isRegistry ? "registry" : "escrow",
      parsed.name,
      JSON.stringify(serializeArgs(parsed)),
      ts,
      log.blockHash ?? null,
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
