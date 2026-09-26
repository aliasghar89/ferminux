// `ferminux-agent serve` collects what the agent has earned (AGENT_AUTO_SETTLE, on by default; =0 turns it off).
//
// Every payout on Ferminux is a PULL: nothing reaches the agent's key until the agent asks. Until 2026-09-25
// no hosted agent ever asked, so Oracle's job #6 sat in Delivered for days after its review window closed and
// every agent's reputation counters under-reported completed work. Each pass, from the agent's own key (the
// same signer that delivers its jobs):
//   1. escrow: jobs addressed to this agent that are Delivered and whose review window has passed (read from
//      the gateway index, then re-checked on chain) → ServiceEscrow.claim(jobId);
//   2. streams paying this key: an ended stream with anything claimable, or a running one once claimable
//      reaches AGENT_SETTLE_STREAM_MIN_FMX (default 1) → StreamPay.claimStream(id);
//   3. subscriptions to this key's plans with started, unclaimed periods → StreamPay.claimSub(id);
//   4. credits: ServiceEscrow, StreamPay and the x402 vault each hold the agent's earnings as `credits`; any
//      balance of at least AGENT_SETTLE_MIN_WITHDRAW_FMX (default 0.01) is withdrawn to the key.
//
// Idempotent: every action is re-checked on chain right before it is sent, so a job someone else settled (the
// client released it, or it was disputed) is skipped, never claimed twice. A failed action backs off per item
// (1 min doubling to 6 h) in DATA_DIR/agent-<id>-settle.json, so a revert or an RPC outage is retried without
// hammering the chain. --dry-run logs what would be claimed and sends nothing.
import { Contract, formatEther, parseEther } from "ethers";
import { STREAM_PAY_ABI, JobStatusEnum, type Ferminux } from "@ferminux/agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SETTLE_INTERVAL_MS = 15 * 60_000;
export const SETTLE_FIRST_DELAY_MS = 60_000;
export const SETTLE_BACKOFF_BASE_MS = 60_000;
export const SETTLE_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const SETTLE_MIN_WITHDRAW_WEI = parseEther("0.01");
export const SETTLE_STREAM_MIN_WEI = parseEther("1");

type Log = { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };

/** Where credits accrue. Each is withdrawn by its own contract's withdraw call. */
export type CreditPool = "escrow" | "streams" | "x402";

/** The slice of the chain and gateway the settle pass uses — narrow so tests can stub it. */
export interface SettleClient {
  /** the signer's address: the agent owner key, and the payee of its streams and plans */
  me: string;
  agentOwner(agentId: number): Promise<string>;
  /** gateway index: this agent's jobs in status Delivered */
  deliveredJobs(agentId: number): Promise<Array<{ id: number }>>;
  escrowJob(jobId: number): Promise<{ agentId: number; status: number; deliveredAt: number }>;
  reviewWindowS(): Promise<number>;
  /** latest block timestamp (unix s) — the clock the contracts use */
  chainNow(): Promise<number>;
  claimJob(jobId: number): Promise<{ tx: string }>;
  /** gateway index: streams whose payee is `me` (null when StreamPay is not deployed) */
  payeeStreams(): Promise<Array<{ id: number }> | null>;
  stream(id: number): Promise<{ payee: string; stop: number; cancelled: boolean }>;
  streamClaimable(id: number): Promise<bigint>;
  claimStream(id: number): Promise<{ tx: string }>;
  /** gateway index: subscriptions to plans whose payee is `me` */
  payeeSubs(): Promise<Array<{ id: number }> | null>;
  dueSubPeriods(id: number): Promise<bigint>;
  claimSub(id: number): Promise<{ tx: string }>;
  credits(pool: CreditPool): Promise<bigint | null>;
  withdraw(pool: CreditPool): Promise<{ tx: string }>;
}

interface ItemState { attempts: number; nextAt: number; lastError?: string; doneAt?: number; tx?: string }
export interface SettleState { items: Record<string, ItemState>; lastRunAt?: number }

export function loadSettleState(path: string): SettleState {
  if (!existsSync(path)) return { items: {} };
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as SettleState;
    return { items: s.items ?? {}, lastRunAt: s.lastRunAt };
  } catch {
    return { items: {} };
  }
}
export function saveSettleState(path: string, state: SettleState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** 1 min, 2, 4, … capped at 6 h. Never gives up: this is the agent's money. */
export function backoffMs(attempts: number): number {
  return Math.min(SETTLE_BACKOFF_MAX_MS, SETTLE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface SettleOptions {
  client: SettleClient;
  agentId: number;
  statePath: string;
  log: Log;
  now?: () => number;
  dryRun?: boolean;
  minWithdrawWei?: bigint;
  streamMinWei?: bigint;
}

export interface SettleResult {
  claimedJobs: number[];
  claimedStreams: number[];
  claimedSubs: number[];
  withdrawn: Array<{ pool: CreditPool; wei: string }>;
  /** dry run: what would have been sent */
  wouldSend: string[];
  /** items skipped because a previous failure's backoff has not elapsed */
  backingOff: string[];
  failed: string[];
}

/**
 * One settle pass. Never throws for a single item — a failure is logged, recorded with its backoff and left for
 * a later pass; only a failure to read the lists themselves (gateway or RPC down) throws to the caller.
 */
export async function settleTick(opts: SettleOptions): Promise<SettleResult> {
  const { client, agentId, log } = opts;
  const now = opts.now ?? (() => Date.now());
  const dry = opts.dryRun === true;
  const minWithdraw = opts.minWithdrawWei ?? SETTLE_MIN_WITHDRAW_WEI;
  const streamMin = opts.streamMinWei ?? SETTLE_STREAM_MIN_WEI;
  const state = loadSettleState(opts.statePath);
  const res: SettleResult = { claimedJobs: [], claimedStreams: [], claimedSubs: [], withdrawn: [], wouldSend: [], backingOff: [], failed: [] };

  const ready = (key: string): boolean => {
    const it = state.items[key];
    if (it?.doneAt) return false;
    if (it && it.nextAt > now()) { res.backingOff.push(key); return false; }
    return true;
  };
  const done = (key: string, tx: string) => { state.items[key] = { attempts: (state.items[key]?.attempts ?? 0) + 1, nextAt: 0, doneAt: now(), tx }; };
  const failed = (key: string, err: unknown) => {
    const attempts = (state.items[key]?.attempts ?? 0) + 1;
    const msg = ((err as Error)?.message ?? String(err)).slice(0, 300);
    state.items[key] = { attempts, nextAt: now() + backoffMs(attempts), lastError: msg };
    res.failed.push(key);
    log.error({ item: key, attempts, retryInS: Math.round(backoffMs(attempts) / 1000), err: msg }, "settle: action failed, backing off");
  };
  /** Runs one on-chain action for `key` unless it is done or backing off; dry run only logs. */
  const act = async (key: string, what: string, send: () => Promise<{ tx: string }>): Promise<boolean> => {
    if (dry) { res.wouldSend.push(key); log.info({ item: key }, `settle (dry run): would ${what}`); return false; }
    try {
      const { tx } = await send();
      done(key, tx);
      log.info({ item: key, tx }, `settle: ${what}`);
      return true;
    } catch (err) {
      failed(key, err);
      return false;
    }
  };

  const me = client.me.toLowerCase();
  const chainNow = await client.chainNow();

  // 1. escrow jobs past their review window
  const owner = (await client.agentOwner(agentId)).toLowerCase();
  if (owner !== me) {
    log.warn({ agentId, owner, signer: client.me }, "settle: this key does not own the agent, so it cannot claim its escrow jobs");
  } else {
    const jobs = await client.deliveredJobs(agentId);
    const windowS = jobs.length ? await client.reviewWindowS() : 0;
    for (const { id } of jobs) {
      const key = `job:${id}`;
      if (!ready(key)) continue;
      let j: { agentId: number; status: number; deliveredAt: number };
      try { j = await client.escrowJob(id); } catch (err) { failed(key, err); continue; }
      if (j.agentId !== agentId || j.status !== JobStatusEnum.Delivered) {
        // released by the client, disputed, or not ours: nothing to claim, and nothing to check again
        state.items[key] = { attempts: 0, nextAt: 0, doneAt: now(), lastError: `status ${j.status}, not Delivered` };
        continue;
      }
      if (chainNow < j.deliveredAt + windowS) continue; // the client can still release or dispute
      if (await act(key, `claimed escrow job ${id}`, () => client.claimJob(id))) res.claimedJobs.push(id);
    }
  }

  // 2. streams paying this key
  for (const { id } of (await client.payeeStreams()) ?? []) {
    const key = `stream:${id}`;
    if (!ready(key)) continue;
    try {
      const s = await client.stream(id);
      if (s.payee.toLowerCase() !== me) continue;
      if (s.cancelled) { state.items[key] = { attempts: 0, nextAt: 0, doneAt: now() }; continue; } // cancel already paid the payee's share
      const claimable = await client.streamClaimable(id);
      const ended = chainNow >= s.stop;
      if (claimable === 0n) { if (ended) state.items[key] = { attempts: 0, nextAt: 0, doneAt: now() }; continue; }
      if (!ended && claimable < streamMin) continue; // a running stream is claimed in lumps, not every pass
      if (await act(key, `claimed stream ${id} (${formatEther(claimable)} FMX)`, () => client.claimStream(id))) {
        res.claimedStreams.push(id);
        if (!ended) delete state.items[key]; // still running: claim again once it accrues more
      }
    } catch (err) {
      failed(key, err);
    }
  }

  // 3. subscriptions to this key's plans: every started, unclaimed period
  for (const { id } of (await client.payeeSubs()) ?? []) {
    const key = `sub:${id}`;
    if (!ready(key)) continue;
    try {
      const due = await client.dueSubPeriods(id);
      if (due === 0n) continue;
      if (await act(key, `claimed ${due} period(s) of subscription ${id}`, () => client.claimSub(id))) {
        res.claimedSubs.push(id);
        delete state.items[key]; // later periods become due again
      }
    } catch (err) {
      failed(key, err);
    }
  }

  // 4. credits → the key
  for (const pool of ["escrow", "streams", "x402"] as CreditPool[]) {
    const key = `withdraw:${pool}`;
    if (!ready(key)) continue;
    try {
      const credits = await client.credits(pool);
      if (credits === null || credits === 0n || credits < minWithdraw) continue;
      if (await act(key, `withdrew ${formatEther(credits)} FMX of ${pool} credits`, () => client.withdraw(pool))) {
        res.withdrawn.push({ pool, wei: credits.toString() });
        delete state.items[key]; // credits accrue again
      }
    } catch (err) {
      failed(key, err);
    }
  }

  state.lastRunAt = now();
  if (!dry) saveSettleState(opts.statePath, state);
  return res;
}

/** Runs one transaction-sending function at a time. The settle loop and the job loop send from the same key;
 * run concurrently, both could read the same pending nonce and one send would fail. Sends are also spaced by
 * `gapMs`: ethers answers an identical RPC read from a 250 ms cache, the pending nonce included, so on a chain
 * that includes a transaction instantly (a local fork or devnet) a back-to-back second send reused the nonce. */
export type SendQueue = <T>(send: () => Promise<T>) => Promise<T>;
export function createSendQueue(gapMs = 300): SendQueue {
  let tail: Promise<unknown> = Promise.resolve();
  const spaced = () => new Promise((r) => setTimeout(r, gapMs));
  return <T>(send: () => Promise<T>) => {
    const run = tail.then(send, send);
    tail = run.then(spaced, spaced);
    return run;
  };
}

/** One agent per process, one key: EVERY transaction the runtime sends from FERMINUX_PRIVATE_KEY goes through
 * this queue — job delivery and cancel (serve.ts), settle claims and withdrawals, memory anchors (anchor.ts) and
 * the chain handler's validation responses. A send that bypasses it can take the same pending nonce as one
 * inside it, and one of the two is refused. */
export const agentSendQueue: SendQueue = createSendQueue();

/** Gateway list pages this long (the gateway's own cap on /api/streams*). */
export const GATEWAY_PAGE = 200;
/** A walk stops here whatever the gateway says: 100 pages of 200 is far past any one agent's history. */
const GATEWAY_MAX_PAGES = 100;

/**
 * Every row of a paged gateway list, following `offset` until a short page. The lists are newest first, so a
 * row added mid-walk pushes older rows down a place: one may be seen twice (deduplicated by id), none is
 * skipped. A page with nothing new ends the walk too, so a gateway that ignores `offset` cannot loop it.
 */
export async function pageAll<T extends { id: number }>(page: (limit: number, offset: number) => Promise<T[]>, limit = GATEWAY_PAGE): Promise<T[]> {
  const seen = new Map<number, T>();
  let offset = 0;
  for (let n = 0; n < GATEWAY_MAX_PAGES; n++) {
    const items = await page(limit, offset);
    let fresh = 0;
    for (const it of items) if (!seen.has(it.id)) { seen.set(it.id, it); fresh++; }
    if (items.length < limit || fresh === 0) break;
    offset += items.length;
  }
  return [...seen.values()];
}

/** The SettleClient over the SDK: the same `fmx` (and so the same signer) that delivers this agent's jobs.
 * Every list is read to the end (pageAll): an agent paid by more than one page of streams used to have its
 * oldest ones — the ended ones with money left in them — fall off the first page and never be claimed. */
export function sdkSettleClient(fmx: Ferminux, queue: SendQueue = agentSendQueue): SettleClient {
  const signer = fmx.requireSigner();
  const streamPay = fmx.v3.streamPay ? new Contract(fmx.v3.streamPay, STREAM_PAY_ABI, fmx.runner) : null;
  const addr = signer.address;
  const list = <T extends { id: number }>(path: string) =>
    pageAll<T>(async (limit, offset) => (await fmx.gatewayGet<{ items: T[] }>(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`)).items);
  return {
    me: addr,
    agentOwner: async (id) => String((await fmx.registry.getAgent(id)).owner),
    deliveredJobs: (id) => list<{ id: number }>(`/agents/${id}/jobs?status=delivered`),
    escrowJob: async (id) => {
      const j = await fmx.escrow.getJob(id);
      return { agentId: Number(j.agentId), status: Number(j.status), deliveredAt: Number(j.deliveredAt) };
    },
    reviewWindowS: async () => Number(await fmx.escrow.reviewWindow()),
    chainNow: async () => {
      const b = await fmx.provider.getBlock("latest");
      if (!b) throw new Error("no latest block");
      return b.timestamp;
    },
    claimJob: (id) => queue(() => fmx.jobs.claim(id)),
    payeeStreams: async () => (streamPay ? list<{ id: number }>(`/streams?payee=${addr}`) : null),
    stream: async (id) => {
      const s = await fmx.streams.get(id);
      return { payee: s.payee, stop: Number(s.stop), cancelled: s.cancelled };
    },
    streamClaimable: (id) => fmx.streams.claimable(id),
    claimStream: (id) => queue(() => fmx.streams.claim(id)),
    payeeSubs: async () => {
      if (!streamPay) return null;
      const plans = await list<{ id: number }>(`/streams/plans?payee=${addr}`);
      const subs: Array<{ id: number }> = [];
      for (const p of plans) {
        const items = await list<{ id: number; cancelled?: boolean }>(`/streams/subs?planId=${p.id}`);
        for (const s of items) if (!s.cancelled) subs.push({ id: s.id });
      }
      return subs;
    },
    dueSubPeriods: async (id) => (streamPay ? BigInt(await streamPay.dueSubPeriods(id)) : 0n),
    claimSub: (id) => queue(() => fmx.streams.plans.claim(id)),
    credits: async (pool) => {
      if (pool === "escrow") return fmx.credits(addr);
      if (pool === "streams") return streamPay ? fmx.streams.credits(addr) : null;
      return fmx.v3.x402Vault ? fmx.x402.credits(addr) : null;
    },
    withdraw: (pool) => queue(() => (pool === "escrow" ? fmx.withdraw() : pool === "streams" ? fmx.streams.withdraw() : fmx.x402.withdrawCredits())),
  };
}

/** Runs settleTick on a cadence (first pass after a minute, so a restart loop cannot spam transactions). */
export function startSettleLoop(opts: SettleOptions & { intervalMs?: number; firstDelayMs?: number }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await settleTick(opts);
      const acted = r.claimedJobs.length + r.claimedStreams.length + r.claimedSubs.length + r.withdrawn.length + r.wouldSend.length;
      if (acted || r.failed.length) opts.log.info({ ...r }, "settle pass");
    } catch (err) {
      opts.log.error({ err: (err as Error)?.message ?? String(err) }, "settle pass could not read its work lists; retrying next pass");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), opts.firstDelayMs ?? SETTLE_FIRST_DELAY_MS);
  const timer = setInterval(() => void run(), Math.max(60_000, opts.intervalMs ?? SETTLE_INTERVAL_MS));
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
