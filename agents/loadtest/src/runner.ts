// The load-test runner: a single-threaded state machine advanced by tick().
//
// A pass walks wallet indices 1 … N − 1 in waves. A wave:
//   fund      the float sends each wave wallet a random amount (95 %: 0.01–1 FMX, 5 %: 1–20 FMX)
//   transfer  each wallet sends 1–3 random amounts to other wallets of the same wave
//   sweep     each wallet sends its whole balance minus the exact gas back to the float
//   verify    balances are read again; anything sweepable left is swept again (up to 3 rounds)
// Every hour (SINK_SWEEP_INTERVAL_S) the float sends what it holds above FLOAT_RESERVE_FMX to the sink
// (Wizrd's main address). When a pass ends (or on DRAIN) a final sweep pass reads the balance of EVERY
// wallet ever activated and sweeps any that can pay its own gas, then the float sends everything (drain,
// or LOOP=false) or everything above its reserve (next pass) to the sink. What stays in a wallet is dust
// that cannot pay for one transfer.
//
// Every transaction: type 2, data = MARKER_DATA (FXLT v1), gas = the exact intrinsic gas, max fee = next
// base fee + tip. Each is written to state.json (with its raw signed bytes) BEFORE it is broadcast; a
// restart rebroadcasts what the node may not have, and counts each nonce once, from its receipt.
import { Transaction, type HDNodeWallet } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { publicConfig } from "./config.js";
import { MARKER_BYTES, MARKER_DATA, MARKER_PREFIX, MARKER_VERSION } from "./marker.js";
import { bumpFees, feesFor, intrinsicGas, maxCost, nextBaseFee, ruleForEstimate, sweepValue, type Fees, type GasRule } from "./gas.js";
import { capFunding, fmx, makeRng, pickRecipients, planTransfers, sampleFunding, sampleTransferCount, type Rng } from "./amounts.js";
import { Keyring, DERIVATION_BASE } from "./wallets.js";
import { hexToBig, hexToNum, RpcError, toHex, type RpcLike } from "./rpc.js";
import { Store, dayOf, tenMinOf, KINDS, SNAP_KEYS, MAX_SNAPS, type Item, type Kind, type PendingTx, type SnapKey, type State, type Wave } from "./state.js";
import { checkChain, floatReason, readIndexCounters, type GuardReport } from "./guards.js";
import { syncAddresses, writeStats, STATS_SCHEMA, ADDRESSES_FILE } from "./publish.js";
import { walkStep, organicLast24h } from "./organic.js";
import type { Logger } from "./log.js";

export type Mode = "starting" | "dry-run" | "running" | "paused" | "halted" | "draining" | "drained";

export interface RunnerDeps {
  rpc: RpcLike;
  log: Logger;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rng?: Rng;
  fileExists?: (p: string) => boolean;
}

/** Token bucket: `rate` sends per second, bursts up to max(1, rate). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly rate: number, private readonly now: () => number) {
    this.tokens = Math.max(1, rate);
    this.last = now();
  }
  private refill() {
    const t = this.now();
    this.tokens = Math.min(Math.max(1, this.rate), this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

const PERMANENT = /insufficient funds|intrinsic gas too low|gas limit|exceeds block gas limit|max fee per gas less than block base fee|fee cap less than block base fee|transaction underpriced|invalid sender|invalid chain id|chain ?id|tip above fee cap|max priority fee per gas higher|oversized data/i;
const KNOWN = /already known|known transaction|already imported|replacement transaction underpriced|transaction already exists/i;
const NONCE_LOW = /nonce too low|nonce has already been used|old nonce/i;

const MAX_VARIANTS = 5;
const MAX_SWEEP_ROUNDS = 3;

export class Runner {
  readonly store: Store;
  readonly keys: Keyring;
  readonly floatAddr: string;
  mode: Mode = "starting";
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: Rng;
  private readonly exists: (p: string) => boolean;
  private readonly bucket: TokenBucket;
  private gas: bigint;
  private gasRule: GasRule | null = null;
  private preflightOk = false;
  private preflightTriedAt = 0;
  private paused = false;
  private pauseReason: string | null = null;
  private pauseSince: number | null = null;
  private okStreak = 0;
  private nextGuardAt = 0;
  private lastGuard: GuardReport | null = null;
  private head: { n: number; baseFee: bigint; gasUsed: bigint; gasLimit: bigint; at: number } | null = null;
  private floatBalance: bigint | null = null;
  private blockTs = new Map<number, number>();
  private lastPublish = 0;
  private dirty = true;
  private dry = { nextAt: 0, cursor: 0, waves: 0 };
  private nextHeartbeat = 0;
  private sendErrors = new Map<string, number>();
  private nextIndexReadAt = 0;
  private warnedOut = false;
  /** the organic walk (organic.ts): its own view of the head, its pace, and the load-test addresses */
  private walkHead: { n: number; at: number } | null = null;
  private nextWalkAt = 0;
  private lastWalkSave = 0;
  private ltSet = new Set<string>();
  private ltSetTop = -1;

  constructor(readonly cfg: Config, phrase: string, readonly deps: RunnerDeps) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rng = deps.rng ?? makeRng(Math.floor(Math.random() * 2 ** 31));
    this.exists = deps.fileExists ?? existsSync;
    this.keys = new Keyring(phrase);
    this.floatAddr = this.keys.address(0);
    this.store = new Store(join(cfg.dataDir, "state.json"), this.nowS());
    this.bucket = new TokenBucket(cfg.rate, this.nowMs);
    this.gas = intrinsicGas(MARKER_BYTES, "london");
    if (cfg.sink.toLowerCase() === this.floatAddr.toLowerCase()) throw new Error("SINK is the float: it must be an address outside the load-test branch");
  }

  get s(): State { return this.store.state; }
  private nowS() { return Math.floor(this.nowMs() / 1000); }
  private log() { return this.deps.log; }

  /* ------------------------------------------------------------------ control */

  private halted(): boolean { return this.exists(join(this.cfg.dataDir, "HALT")); }
  private draining(): boolean { return this.cfg.drainEnv || this.exists(join(this.cfg.dataDir, "DRAIN")); }

  private setMode(m: Mode) {
    if (m === this.mode) return;
    this.log().info("mode", { from: this.mode, to: m });
    this.mode = m;
    this.dirty = true;
  }

  private pause(reason: string) {
    this.okStreak = 0;
    if (this.paused && this.pauseReason === reason) return;
    if (!this.paused) this.pauseSince = this.nowS();
    this.paused = true;
    this.pauseReason = reason;
    this.s.lastPause = { reason, at: this.nowS() };
    this.dirty = true;
    this.log().warn("paused", { reason });
  }

  private resume() {
    if (!this.paused) return;
    this.log().info("resumed", { after: this.pauseReason, pausedS: this.pauseSince ? this.nowS() - this.pauseSince : null });
    this.paused = false;
    this.pauseReason = null;
    this.pauseSince = null;
    this.dirty = true;
  }

  /* ------------------------------------------------------------------ start */

  /** Publish the public files and log the plan. Reads only. */
  async start(): Promise<void> {
    syncAddresses(this.cfg.publicDir, this.s.highestActivated, (i) => this.keys.address(i));
    this.log().info("start", { ...publicConfig(this.cfg), float: this.floatAddr, xpub: this.keys.xpub, path: `${DERIVATION_BASE}/i`, state: { pass: this.s.pass, nextIndex: this.s.nextIndex, highestActivated: this.s.highestActivated, pending: this.s.pending.length, waves: this.s.waves.length } });
    if (!this.cfg.enabled) this.log().info("DRY-RUN: planning and logging only; nothing is signed or sent. Set LOADTEST_ENABLED=true to run.");
    this.publish(true); // before the first RPC read: the public files exist even while the node is unreachable
    await this.preflight();
    this.publish(true);
  }

  /** Chain id, gas rule, sink and float checks. Sets preflightOk; failures pause (live) or just log (dry-run). */
  async preflight(): Promise<boolean> {
    this.preflightTriedAt = this.nowS();
    try {
      const [chainId, est, sinkCode, floatNonce, bal] = await this.deps.rpc.batch([
        { method: "eth_chainId" },
        { method: "eth_estimateGas", params: [{ from: this.floatAddr, to: this.keys.address(1), value: "0x0", data: MARKER_DATA }] },
        { method: "eth_getCode", params: [this.cfg.sink, "latest"] },
        { method: "eth_getTransactionCount", params: [this.floatAddr, "pending"] },
        { method: "eth_getBalance", params: [this.floatAddr, "latest"] },
      ]);
      const problems: string[] = [];
      if (chainId instanceof RpcError || hexToNum(chainId) !== this.cfg.chainId) problems.push(`RPC chain id ${chainId instanceof RpcError ? "unreadable" : hexToNum(chainId)} is not ${this.cfg.chainId}`);
      if (est instanceof RpcError) problems.push(`eth_estimateGas failed: ${est.message}`);
      else {
        const rule = ruleForEstimate(hexToBig(est), MARKER_BYTES);
        if (!rule) problems.push(`a marked transfer estimates ${hexToBig(est)} gas, which matches no known rule (london ${intrinsicGas(MARKER_BYTES, "london")}, prague ${intrinsicGas(MARKER_BYTES, "prague")})`);
        else { this.gasRule = rule; this.gas = intrinsicGas(MARKER_BYTES, rule); }
      }
      if (sinkCode instanceof RpcError) problems.push("sink code unreadable");
      else if (sinkCode !== "0x" && sinkCode !== "0x0") problems.push(`sink ${this.cfg.sink} has code: sweeps need a plain account`);
      if (!(floatNonce instanceof RpcError)) {
        const n = hexToNum(floatNonce);
        this.s.floatNonce = Math.max(this.s.floatNonce ?? 0, this.maxPendingNonce(0) + 1, n);
      } else problems.push("float nonce unreadable");
      if (!(bal instanceof RpcError)) this.floatBalance = hexToBig(bal);
      this.log().info("preflight", { ok: !problems.length, problems, gasRule: this.gasRule, gasPerTransfer: this.gas, floatNonce: this.s.floatNonce, floatBalanceFmx: this.floatBalance === null ? null : fmx(this.floatBalance) });
      this.preflightOk = problems.length === 0;
      if (!this.preflightOk && this.cfg.enabled) this.pause(`preflight: ${problems.join("; ")}`);
      return this.preflightOk;
    } catch (e) {
      this.preflightOk = false;
      if (this.cfg.enabled) this.pause(`preflight: ${(e as Error).message}`);
      else this.log().warn("preflight failed", { error: (e as Error).message });
      return false;
    }
  }

  /* ------------------------------------------------------------------ loop */

  async run(stop: AbortSignal): Promise<void> {
    await this.start();
    let backoff = 1000;
    while (!stop.aborted) {
      try {
        await this.tick();
        backoff = 1000;
      } catch (e) {
        this.log().error("tick failed", { error: (e as Error).message });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
      if (!stop.aborted) await this.sleep(this.cfg.tickMs);
    }
    this.store.save();
    this.publish(true);
    this.log().info("stopped", { counters: this.s.counters, pending: this.s.pending.length });
  }

  async tick(): Promise<void> {
    const now = this.nowS();
    if (now >= this.nextHeartbeat) { this.heartbeat(); this.nextHeartbeat = now + 60; }
    // reads only, in every mode: the organic count and the index's figures move whether or not we send
    await this.walkOrganic();
    if (now >= this.nextIndexReadAt) await this.readIndex();
    if (!this.cfg.enabled) {
      this.setMode("dry-run");
      // switched off mid-run: the transactions already sent still land, so their receipts are still read
      // (reads only) and the public counters stay right. Coins out in waves wait in their wallets until
      // LOADTEST_ENABLED=true again; DRAIN (not dry-run) is how the test is ended for good.
      if (this.s.pending.length) await this.pollPending();
      if (!this.warnedOut && (this.s.waves.length || this.s.pending.length)) {
        this.warnedOut = true;
        this.log().warn("dry-run with a live run in progress: coins in these waves stay in their wallets until LOADTEST_ENABLED=true; use DRAIN to end the test", { waves: this.s.waves.length, pending: this.s.pending.length, inFlightFmx: fmx(this.inFlight()) });
      }
      await this.dryTick();
      this.publish();
      return;
    }
    // receipts are read in every mode (reads only), so the counters stay right while paused or halted
    await this.pollPending();
    if (this.halted()) { this.setMode("halted"); this.publish(); return; }
    const drain = this.draining();
    // drained and asked to stay so: nothing to send, so nothing to guard
    if (this.s.drained && (drain || (!this.cfg.loop && this.s.nextIndex >= this.cfg.wallets))) { this.setMode("drained"); this.publish(); return; }
    if (now >= this.nextGuardAt) await this.runGuards();
    if (this.paused) { this.setMode("paused"); this.publish(); return; }
    if (!this.preflightOk) {
      if (now - this.preflightTriedAt >= this.cfg.guardIntervalS) await this.preflight();
      if (!this.preflightOk) { this.setMode("paused"); this.publish(); return; }
    }
    if (this.s.firstLiveAt === null) { this.s.firstLiveAt = now; this.dirty = true; }
    if (this.s.drained) {
      // the drain request was lifted: carry on
      this.s.drained = false;
      if (this.s.nextIndex >= this.cfg.wallets) { this.s.pass++; this.s.nextIndex = 1; }
      this.store.save();
    }
    this.setMode(drain ? "draining" : "running");
    await this.refreshHead();
    // nothing of ours can be in a block up to this head: the organic walk looks for load-test transactions above it
    if (this.s.ltFromBlock === null && this.head) { this.s.ltFromBlock = this.head.n; this.store.save(); }
    await this.resendStale();
    for (const w of [...this.s.waves]) await this.advanceWave(w);
    const passDone = this.s.nextIndex >= this.cfg.wallets && this.s.waves.length === 0;
    if (!this.s.finalSweep && this.s.waves.length === 0 && (drain || passDone)) {
      this.s.finalSweep = { reason: drain ? "drain" : "pass", pass: this.s.pass, cursor: 1, upTo: this.s.highestActivated, queue: [], inflight: [], closing: false };
      this.store.save();
      this.log().info("final sweep pass: start", { reason: this.s.finalSweep.reason, pass: this.s.pass, wallets: this.s.highestActivated });
    }
    if (this.s.finalSweep) await this.finalSweepStep();
    else if (!drain) {
      await this.maybeStartWave();
      await this.maybeSinkSweep();
    }
    this.publish();
  }

  /* ------------------------------------------------------------------ guards */

  private async runGuards(): Promise<void> {
    this.nextGuardAt = this.nowS() + this.cfg.guardIntervalS;
    const r = await checkChain(this.cfg, { rpc: this.deps.rpc, fetchImpl: this.deps.fetchImpl, nowS: () => this.nowS() });
    this.lastGuard = r;
    if (r.head !== null && r.baseFee !== null && r.gasUsed !== null && r.gasLimit !== null) this.head = { n: r.head, baseFee: r.baseFee, gasUsed: r.gasUsed, gasLimit: r.gasLimit, at: this.nowMs() };
    const reasons = [...r.reasons];
    try {
      this.floatBalance = hexToBig(await this.deps.rpc.call("eth_getBalance", [this.floatAddr, "latest"]));
    } catch { this.floatBalance = null; }
    // the float guard does not apply while the float is being emptied on purpose
    if (!this.s.finalSweep && !this.s.drained && !this.draining()) {
      const fr = floatReason(this.cfg, this.floatBalance, this.inFlight());
      if (fr) reasons.push(fr);
    }
    if (reasons.length) this.pause(reasons.join("; "));
    else if (this.paused && ++this.okStreak >= 2) this.resume();
    else if (!this.paused) this.okStreak = 0;
    this.dirty = true;
  }

  private addressCount(): number {
    const a = this.s.highestActivated;
    return a + (a > 0 || this.s.floatUsed ? 1 : 0);
  }

  /** Load-test addresses that have been in a block: the float and every wallet funded at least once (a wave's
   *  wallets are activated before their funding lands, so addressCount runs a little ahead of the index). */
  private addressesOnChain(): number {
    const funded = Math.min(this.s.counters.byKind.fund, this.s.highestActivated);
    return funded + (funded > 0 || this.s.floatUsed ? 1 : 0);
  }

  /**
   * The explorer index caches its network totals and recounts them on a timer (every 5 min on
   * explorer.ferminux.net; Blockscout's defaults are 2 h, 30 min and 1 h). "Index total − our live counter" is
   * then wrong by everything sent since the index last counted. So the index's figures are read every
   * INDEX_READ_INTERVAL_S, and when one CHANGES (the index recounted since the previous read) the figure is
   * recorded with our counts at the previous read (lo) and at this one (hi): the recount happened in between,
   * so the figure holds lo … hi of ours, and `lt` is the middle. The last read is kept in state.json, so the
   * first recount after a restart is bracketed too. A figure with no previous read has lo = null (unknown),
   * except while nothing of ours exists yet (then it holds none: lo = hi = 0). The explorer subtracts `lt` of
   * the snapshot that matches the figure it shows (explorer/web/src/loadtest.ts).
   */
  private async readIndex(): Promise<void> {
    if (!this.cfg.explorerApi) return;
    this.nextIndexReadAt = this.nowS() + this.cfg.indexReadIntervalS;
    const idx = await readIndexCounters(this.cfg, this.deps.fetchImpl);
    const lt: Record<SnapKey, number> = { transactions: this.s.counters.transactions, addresses: this.addressesOnChain(), last24h: this.last24h() };
    const now = this.nowS();
    const prev = this.s.indexRead;
    const legacy = prev ? undefined : this.s.indexSeen;
    const fig: Partial<Record<SnapKey, number>> = {};
    const ltAt = { ...lt };
    let changed = false;
    for (const k of SNAP_KEYS) {
      const v = idx[k];
      if (v === null) {
        // unreadable this time: the bracket for its next change starts at the last read that saw it
        if (prev?.fig[k] !== undefined) { fig[k] = prev.fig[k]; ltAt[k] = prev.lt[k]; }
        continue;
      }
      fig[k] = v;
      const before = prev ? prev.fig[k] : legacy?.[k];
      if (before === v) continue;
      let lo: number | null = prev && before !== undefined ? prev.lt[k] : null;
      if (lt[k] === 0) lo = 0;
      const list = this.s.indexSnap[k];
      list.push({ index: v, lt: lo === null ? lt[k] : Math.floor((lo + lt[k]) / 2), at: now, lo, hi: lt[k] });
      if (list.length > MAX_SNAPS) list.splice(0, list.length - MAX_SNAPS);
      changed = true;
    }
    // kept on disk whenever our counts moved, so a restart brackets the next recount from this read
    const moved = !prev || SNAP_KEYS.some((k) => prev.lt[k] !== ltAt[k] || prev.fig[k] !== fig[k]);
    this.s.indexRead = { at: now, fig, lt: ltAt };
    if (this.s.indexSeen) { delete this.s.indexSeen; changed = true; }
    if (changed || moved) this.persist();
    if (changed) this.dirty = true;
  }

  /** Is this lower-case address one of ours (index 0 … highest activated)? addresses.bin first: deriving a
   *  hundred thousand keys would hold the loop for a minute. */
  private isLt(a: string): boolean {
    const top = this.s.highestActivated;
    if (this.ltSetTop < top) {
      if (this.ltSetTop < 0) {
        try {
          const buf = readFileSync(join(this.cfg.publicDir, ADDRESSES_FILE));
          const n = Math.min(top + 1, Math.floor(buf.length / 20));
          if (n > 0 && "0x" + buf.subarray(0, 20).toString("hex") === this.floatAddr.toLowerCase()) {
            for (let i = 0; i < n; i++) this.ltSet.add("0x" + buf.subarray(i * 20, i * 20 + 20).toString("hex"));
            this.ltSetTop = n - 1;
          }
        } catch { /* derived below */ }
      }
      for (let i = this.ltSetTop + 1; i <= top; i++) this.ltSet.add(this.keys.address(i).toLowerCase());
      this.ltSetTop = top;
    }
    return this.ltSet.has(a);
  }

  /**
   * One step of the organic walk (organic.ts): every transaction on chain that is not the load test's, counted
   * from the blocks themselves. Reads only. While it catches up (the first start walks the whole chain: a few
   * hundred batched calls) it takes one step every half second; after that one step per new block.
   */
  private async walkOrganic(): Promise<void> {
    if (!this.cfg.organicWalk) return;
    const nowMs = this.nowMs();
    if (nowMs < this.nextWalkAt) return;
    try {
      if (!this.walkHead || nowMs - this.walkHead.at >= 3000) this.walkHead = { n: hexToNum(await this.deps.rpc.call("eth_blockNumber")), at: nowMs };
    } catch {
      this.nextWalkAt = nowMs + 5000;
      return;
    }
    const head = this.walkHead.n;
    // live from before ltFromBlock with nothing confirmed yet: what was sent can only be in recent blocks
    if (this.s.ltFromBlock === null && (this.s.firstLiveAt !== null || this.s.pending.length)) this.s.ltFromBlock = Math.max(0, head - 2000);
    const o = this.s.organic;
    const target = head - this.cfg.organicConfirmations;
    const moved = await walkStep(o, target, { rpc: this.deps.rpc, ltFrom: this.s.ltFromBlock ?? Infinity, isLt: (a) => this.isLt(a), nowS: this.nowS() });
    if (!moved) {
      if (o.cursor < target) this.nextWalkAt = nowMs + 5000; // a failed read: try again in a while
      return;
    }
    this.nextWalkAt = o.cursor < target - 50 ? nowMs + 500 : 0;
    this.dirty = true;
    if (nowMs - this.lastWalkSave >= 15_000 || o.cursor >= target) { this.persist(); this.lastWalkSave = nowMs; }
  }

  /** Save what the reads learned. Dry-run keeps no progress on disk: there it lives in memory (and in stats). */
  private persist() {
    if (this.cfg.enabled) this.store.save();
  }

  private async refreshHead(): Promise<void> {
    if (this.head && this.nowMs() - this.head.at < 3000) return;
    const b = await this.deps.rpc.call<{ number: string; baseFeePerGas?: string; gasUsed: string; gasLimit: string }>("eth_getBlockByNumber", ["latest", false]);
    if (!b || !b.baseFeePerGas) throw new Error("head block without a base fee");
    this.head = { n: hexToNum(b.number), baseFee: hexToBig(b.baseFeePerGas), gasUsed: hexToBig(b.gasUsed), gasLimit: hexToBig(b.gasLimit), at: this.nowMs() };
  }

  /** Fees for inclusion in the next block: its base fee (EIP-1559 from the head) + the tip. */
  private fees(): Fees {
    if (!this.head) throw new Error("no head yet");
    return feesFor(nextBaseFee({ baseFee: this.head.baseFee, gasUsed: this.head.gasUsed, gasLimit: this.head.gasLimit }), this.cfg.tipWei);
  }
  /** Gas set aside per planned transaction when planning transfers: twice today's price, generous on purpose. */
  private reservePerTx(): bigint {
    const f = this.fees();
    return this.gas * f.maxFeePerGas * 2n;
  }

  /* ------------------------------------------------------------------ bookkeeping */

  private inFlight(): bigint {
    return this.s.waves.reduce((a, w) => a + BigInt(w.fundedWei), 0n);
  }
  /** Funding the float still has to send (planned or not yet in a block). */
  private floatCommitted(): bigint {
    let c = 0n;
    for (const w of this.s.waves) for (const it of w.items) if (it.kind === "fund" && (it.status === "planned" || it.status === "sent")) c += BigInt(it.value);
    return c;
  }
  /**
   * What the float still owes against its LATEST balance: funding not yet in a block (planned or pending)
   * plus the value of every other pending float transaction and the gas of all of them.
   */
  private floatOwed(): bigint {
    const pendingOut = this.s.pending.filter((p) => p.from === 0).reduce((a, p) => {
      const v = p.variants[p.variants.length - 1];
      return a + (p.kind === "fund" ? 0n : BigInt(v.value)) + this.gas * BigInt(v.maxFee);
    }, 0n);
    return this.floatCommitted() + pendingOut;
  }
  private maxPendingNonce(from: number): number {
    let m = -1;
    for (const p of this.s.pending) if (p.from === from && p.nonce > m) m = p.nonce;
    return m;
  }
  private floatHasPending(): boolean { return this.s.pending.some((p) => p.from === 0); }
  private addr(i: number): string { return this.keys.address(i); }

  /* ------------------------------------------------------------------ waves */

  /** Plan the next wave from `start`: indices, funding and transfers. Pure except for the RNG. */
  private planWave(start: number, headroom: bigint): { indices: number[]; items: Item[]; funded: bigint } | null {
    const indices: number[] = [];
    const funding: bigint[] = [];
    let room = headroom;
    for (let i = start; i < this.cfg.wallets && indices.length < this.cfg.waveSize; i++) {
      const amt = capFunding(sampleFunding(this.rng, this.cfg.amounts), room, this.cfg.amounts);
      if (amt === null) break;
      indices.push(i);
      funding.push(amt);
      room -= amt;
    }
    if (!indices.length) return null;
    const items: Item[] = indices.map((i, k) => ({ kind: "fund", from: 0, to: i, value: funding[k].toString(), status: "planned" }));
    const reserve = this.reservePerTx();
    indices.forEach((i, k) => {
      const count = sampleTransferCount(this.rng);
      const amounts = planTransfers(this.rng, funding[k], reserve, count, this.cfg.amounts.granule);
      const to = pickRecipients(this.rng, i, indices, amounts.length, 0);
      amounts.forEach((v, j) => items.push({ kind: "transfer", from: i, to: to[j], value: v.toString(), status: "planned" }));
    });
    return { indices, items, funded: funding.reduce((a, b) => a + b, 0n) };
  }

  private async maybeStartWave(): Promise<void> {
    if (this.s.waves.length >= this.cfg.maxActiveWaves || this.s.nextIndex >= this.cfg.wallets) return;
    // the float's balance right now, minus what it still owes to waves in flight and a gas float of its own
    let bal: bigint;
    try { bal = hexToBig(await this.deps.rpc.call("eth_getBalance", [this.floatAddr, "latest"])); } catch { return; }
    this.floatBalance = bal;
    const ownGas = maxCost(this.gas, this.fees()) * 50n;
    const free = bal - this.floatOwed() - ownGas;
    const headroom = [this.cfg.maxInFlightWei - this.inFlight(), free].reduce((a, b) => (a < b ? a : b));
    const plan = this.planWave(this.s.nextIndex, headroom);
    if (!plan) return;
    const w: Wave = { id: ++this.s.waveSeq, pass: this.s.pass, indices: plan.indices, phase: "fund", items: plan.items, nonces: {}, fundedWei: plan.funded.toString(), createdAt: this.nowS(), sweepRounds: 0 };
    this.s.waves.push(w);
    this.s.nextIndex = plan.indices[plan.indices.length - 1] + 1;
    const top = plan.indices[plan.indices.length - 1];
    if (top > this.s.highestActivated) this.s.highestActivated = top;
    this.store.save();
    syncAddresses(this.cfg.publicDir, this.s.highestActivated, (i) => this.keys.address(i));
    this.dirty = true;
    this.log().info("wave: start", { wave: w.id, pass: w.pass, from: plan.indices[0], to: top, wallets: plan.indices.length, fundFmx: fmx(plan.funded), transfers: plan.items.filter((x) => x.kind === "transfer").length });
  }

  private async advanceWave(w: Wave): Promise<void> {
    const items = (kind: Item["kind"]) => w.items.map((it, k) => ({ it, k })).filter((x) => x.it.kind === kind);
    const settled = (xs: { it: Item }[]) => xs.every((x) => x.it.status === "done" || x.it.status === "failed");

    if (w.phase === "fund") {
      for (const { it, k } of items("fund")) {
        if (it.status !== "planned") continue;
        if (!(await this.sendItem(w, k))) return;
      }
      if (!settled(items("fund"))) return;
      // wallets whose funding failed sit this wave out
      const unfunded = new Set(items("fund").filter((x) => x.it.status === "failed").map((x) => x.it.to));
      for (const { it } of items("transfer")) if (unfunded.has(it.from)) it.status = "failed";
      const senders = [...new Set(items("transfer").filter((x) => x.it.status === "planned").map((x) => x.it.from))];
      if (senders.length) {
        const res = await this.deps.rpc.batch(senders.map((i) => ({ method: "eth_getTransactionCount", params: [this.addr(i), "pending"] })));
        if (res.some((r) => r instanceof RpcError)) return;
        senders.forEach((i, k) => { w.nonces[String(i)] = hexToNum(res[k]); });
      }
      w.phase = "transfer";
      this.store.save();
    }

    if (w.phase === "transfer") {
      for (const { it, k } of items("transfer")) {
        if (it.status !== "planned") continue;
        if (!(await this.sendItem(w, k))) return;
      }
      if (!settled(items("transfer"))) return;
      w.phase = "sweep";
      this.store.save();
    }

    if (w.phase === "sweep") {
      if (!items("sweep").some((x) => x.it.status === "planned" || x.it.status === "sent")) {
        // plan this round's sweeps from the chain's balances (every transfer into these wallets is in a block)
        const ok = await this.planSweeps(w);
        if (!ok) return;
      }
      for (const { it, k } of items("sweep")) {
        if (it.status !== "planned") continue;
        if (!(await this.sendItem(w, k))) return;
      }
      if (!settled(items("sweep"))) return;
      w.phase = "verify";
      this.store.save();
    }

    if (w.phase === "verify") {
      const bals = await this.balances(w.indices);
      if (!bals) return;
      const fees = this.fees();
      const left = w.indices.filter((i, k) => sweepValue(bals[k], this.gas, fees) > 0n);
      if (left.length && w.sweepRounds < MAX_SWEEP_ROUNDS) {
        this.log().warn("wave: sweeping again", { wave: w.id, wallets: left.length, round: w.sweepRounds + 1 });
        w.phase = "sweep";
        this.store.save();
        return;
      }
      if (left.length) this.log().warn("wave: balances left for the final sweep pass", { wave: w.id, wallets: left });
      w.phase = "done";
      this.s.waves = this.s.waves.filter((x) => x !== w);
      this.store.save();
      this.dirty = true;
      const dust = bals.reduce((a, b) => a + b, 0n);
      this.log().info("wave: done", { wave: w.id, wallets: w.indices.length, txs: w.items.filter((x) => x.status === "done").length, failed: w.items.filter((x) => x.status === "failed").length, dustWei: dust });
    }
  }

  private async balances(indices: number[]): Promise<bigint[] | null> {
    const res = await this.deps.rpc.batch(indices.map((i) => ({ method: "eth_getBalance", params: [this.addr(i), "latest"] })));
    if (res.some((r) => r instanceof RpcError)) return null;
    return res.map(hexToBig);
  }

  private async planSweeps(w: Wave): Promise<boolean> {
    const bals = await this.balances(w.indices);
    if (!bals) return false;
    const fees = this.fees();
    // nonces: after a sweep round, re-read them (a landed sweep moved them on)
    if (w.sweepRounds > 0 || w.indices.some((i) => w.nonces[String(i)] === undefined)) {
      const res = await this.deps.rpc.batch(w.indices.map((i) => ({ method: "eth_getTransactionCount", params: [this.addr(i), "pending"] })));
      if (res.some((r) => r instanceof RpcError)) return false;
      w.indices.forEach((i, k) => { w.nonces[String(i)] = hexToNum(res[k]); });
    }
    w.sweepRounds++;
    w.indices.forEach((i, k) => {
      const v = sweepValue(bals[k], this.gas, fees);
      if (v > 0n) w.items.push({ kind: "sweep", from: i, to: 0, value: v.toString(), status: "planned", balance: bals[k].toString() });
    });
    this.store.save();
    return true;
  }

  /* ------------------------------------------------------------------ sending */

  /** Sign, log-ahead and broadcast wave item k. Returns false when out of send budget (stop this tick). */
  private async sendItem(w: Wave, k: number): Promise<boolean> {
    const it = w.items[k];
    // one unaccepted transaction per sender at a time: a rejection then only ever hits the newest nonce
    if (this.s.pending.some((p) => p.from === it.from && !p.accepted)) return true;
    const fromFloat = it.from === 0;
    if (fromFloat && this.s.floatNonce === null) return false; // re-read by the next preflight
    if (!fromFloat && w.nonces[String(it.from)] === undefined) {
      w.nonces[String(it.from)] = hexToNum(await this.deps.rpc.call("eth_getTransactionCount", [this.addr(it.from), "pending"]));
    }
    if (!this.bucket.tryTake()) return false;
    const fees = this.fees();
    const nonce = fromFloat ? this.s.floatNonce! : w.nonces[String(it.from)];
    let value = BigInt(it.value);
    let balance: bigint | undefined;
    if (it.kind === "sweep") {
      balance = it.balance !== undefined ? BigInt(it.balance) : undefined;
      if (balance !== undefined) value = sweepValue(balance, this.gas, fees);
      if (value <= 0n) { it.status = "failed"; return true; }
      it.value = value.toString();
    }
    const p = this.sign(it.kind, it.from, this.addr(it.to), value, nonce, fees, w.id, k, balance);
    it.status = "sent";
    it.hash = p.variants[0].hash;
    if (fromFloat) this.s.floatNonce = nonce + 1; else w.nonces[String(it.from)] = nonce + 1;
    this.s.pending.push(p);
    this.store.save(); // write-ahead: the signed bytes are on disk before the node sees them
    const r = await this.broadcast(p, p.variants[0]);
    if (r === "rejected") {
      // not in the pool and never will be: drop it, give the nonce back, try the item again later
      this.s.pending = this.s.pending.filter((x) => x !== p);
      if (fromFloat) { if (this.s.floatNonce === nonce + 1) this.s.floatNonce = nonce; }
      else if (w.nonces[String(it.from)] === nonce + 1) w.nonces[String(it.from)] = nonce;
      const tries = (this.sendErrors.get(`${w.id}:${k}`) ?? 0) + 1;
      this.sendErrors.set(`${w.id}:${k}`, tries);
      it.status = tries >= 3 ? "failed" : "planned";
      delete it.hash;
      this.store.save();
      return false;
    }
    return true;
  }

  private sign(kind: Kind, from: number, to: string, value: bigint, nonce: number, fees: Fees, wave: number | null, item: number | null, balance?: bigint): PendingTx {
    const wallet: HDNodeWallet = this.keys.wallet(from);
    const tx = Transaction.from({
      type: 2, chainId: BigInt(this.cfg.chainId), nonce, to, value, data: MARKER_DATA, gasLimit: this.gas,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    tx.signature = wallet.signingKey.sign(tx.unsignedHash);
    const now = this.nowS();
    return {
      id: `${from}:${nonce}`, kind, from, to, nonce, wave, item,
      variants: [{ hash: tx.hash!, raw: tx.serialized, maxFee: fees.maxFeePerGas.toString(), tip: fees.maxPriorityFeePerGas.toString(), value: value.toString(), at: now }],
      accepted: false, firstAt: now, lastBroadcastAt: now, ...(balance !== undefined ? { balance: balance.toString() } : {}),
    };
  }

  /** "ok": in the pool (or already in a block); "retry": transport trouble, try again later; "rejected": never. */
  private async broadcast(p: PendingTx, v: PendingTx["variants"][number]): Promise<"ok" | "retry" | "rejected"> {
    p.lastBroadcastAt = this.nowS();
    try {
      await this.deps.rpc.call("eth_sendRawTransaction", [v.raw]);
      p.accepted = true;
      return "ok";
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (e instanceof RpcError) {
        if (KNOWN.test(msg)) { p.accepted = true; return "ok"; }
        if (NONCE_LOW.test(msg)) { p.accepted = true; return "ok"; } // landed already, or lost: pollPending/resendStale decide
        if (PERMANENT.test(msg) || !p.accepted) {
          this.log().warn("broadcast rejected", { kind: p.kind, from: p.from, nonce: p.nonce, error: msg.slice(0, 200) });
          return p.accepted ? "retry" : "rejected";
        }
      }
      this.log().warn("broadcast failed, will retry", { kind: p.kind, from: p.from, nonce: p.nonce, error: msg.slice(0, 200) });
      return "retry";
    }
  }

  /** Rebroadcast what the node may have dropped; replace (fee bump) what sits too long without a block. */
  private async resendStale(): Promise<void> {
    const now = this.nowS();
    for (const p of [...this.s.pending]) {
      const last = p.variants[p.variants.length - 1];
      if (!p.accepted) {
        if (now - p.lastBroadcastAt < 5) continue;
        const r = await this.broadcast(p, last);
        if (r === "rejected") this.dropRejected(p);
        continue;
      }
      if (now - p.firstAt >= this.cfg.stuckAfterS * p.variants.length && p.variants.length < MAX_VARIANTS) {
        // is the nonce still open? (a landed variant shows up in pollPending first)
        const count = hexToNum(await this.deps.rpc.call("eth_getTransactionCount", [this.addr(p.from), "latest"]));
        if (count > p.nonce) {
          if (now - p.lastBroadcastAt >= this.cfg.receiptTimeoutS) this.markLost(p, "nonce used but no receipt for any variant");
          continue;
        }
        if (!this.bucket.tryTake()) return;
        const old = { maxFeePerGas: BigInt(last.maxFee), maxPriorityFeePerGas: BigInt(last.tip) };
        const fees = bumpFees(old, this.fees().maxFeePerGas - this.cfg.tipWei);
        let value = BigInt(last.value);
        if (p.balance !== undefined) value = sweepValue(BigInt(p.balance), this.gas, fees); // sweeps stay exact
        if (value <= 0n) continue;
        const nv = this.sign(p.kind, p.from, p.to, value, p.nonce, fees, p.wave, p.item).variants[0];
        p.variants.push(nv);
        this.store.save();
        this.log().warn("fee bump", { kind: p.kind, from: p.from, nonce: p.nonce, variants: p.variants.length, maxFee: fees.maxFeePerGas });
        await this.broadcast(p, nv);
        continue;
      }
      if (now - p.lastBroadcastAt >= this.cfg.receiptTimeoutS) {
        await this.broadcast(p, last); // idempotent: the node answers "already known" or takes it back
      }
    }
  }

  private dropRejected(p: PendingTx) {
    this.s.pending = this.s.pending.filter((x) => x !== p);
    if (p.from === 0 && this.s.floatNonce === p.nonce + 1) this.s.floatNonce = p.nonce;
    const w = p.wave !== null ? this.s.waves.find((x) => x.id === p.wave) : undefined;
    if (w && p.item !== null) {
      const it = w.items[p.item];
      it.status = "planned";
      delete it.hash;
      if (p.from !== 0 && w.nonces[String(p.from)] === p.nonce + 1) w.nonces[String(p.from)] = p.nonce;
    }
    if (p.kind === "final" && this.s.finalSweep) this.s.finalSweep.inflight = this.s.finalSweep.inflight.filter((i) => i !== p.from);
    if (p.kind === "sink" && this.s.finalSweep?.closing) this.s.finalSweep.closing = false;
    this.store.save();
  }

  private markLost(p: PendingTx, why: string) {
    this.log().error("transaction lost", { kind: p.kind, from: p.from, nonce: p.nonce, why, hashes: p.variants.map((v) => v.hash) });
    this.s.pending = this.s.pending.filter((x) => x !== p);
    const w = p.wave !== null ? this.s.waves.find((x) => x.id === p.wave) : undefined;
    if (w && p.item !== null) w.items[p.item].status = "failed";
    if (w && p.from !== 0) delete w.nonces[String(p.from)]; // re-read before this wallet's next send
    if (p.kind === "final" && this.s.finalSweep) this.s.finalSweep.inflight = this.s.finalSweep.inflight.filter((i) => i !== p.from);
    // a lost closing transfer did not empty the float: send it again, never record the pass as drained
    if (p.kind === "sink" && this.s.finalSweep?.closing) this.s.finalSweep.closing = false;
    if (p.from === 0) { this.s.floatNonce = null; this.preflightOk = false; } // re-read by the next preflight
    this.store.save();
  }

  /* ------------------------------------------------------------------ receipts → counters */

  async pollPending(): Promise<void> {
    if (!this.s.pending.length) return;
    const refs: { p: PendingTx; v: PendingTx["variants"][number] }[] = [];
    for (const p of this.s.pending) for (const v of p.variants) refs.push({ p, v });
    const res = await this.deps.rpc.batch(refs.slice(0, 1000).map((r) => ({ method: "eth_getTransactionReceipt", params: [r.v.hash] })));
    const landed = new Map<PendingTx, { v: PendingTx["variants"][number]; rc: { blockNumber: string; gasUsed: string; effectiveGasPrice?: string; status: string } }>();
    res.forEach((rc, k) => {
      if (!rc || rc instanceof RpcError) return;
      landed.set(refs[k].p, { v: refs[k].v, rc: rc as { blockNumber: string; gasUsed: string; effectiveGasPrice?: string; status: string } });
    });
    if (!landed.size) return;
    // block times, for the per-day counts (UTC, by block time, as the explorer counts days)
    const need = [...new Set([...landed.values()].map((x) => hexToNum(x.rc.blockNumber)))].filter((n) => !this.blockTs.has(n));
    if (need.length) {
      const bs = await this.deps.rpc.batch(need.map((n) => ({ method: "eth_getBlockByNumber", params: [toHex(n), false] })));
      bs.forEach((b, k) => { if (b && !(b instanceof RpcError)) this.blockTs.set(need[k], hexToNum((b as { timestamp: string }).timestamp)); });
      if (this.blockTs.size > 5000) for (const key of [...this.blockTs.keys()].slice(0, 2500)) this.blockTs.delete(key);
    }
    for (const [p, { v, rc }] of landed) {
      const bn = hexToNum(rc.blockNumber);
      const ts = this.blockTs.get(bn);
      if (ts === undefined) continue; // next poll
      this.confirm(p, v, { block: bn, ts, gasUsed: hexToBig(rc.gasUsed), price: rc.effectiveGasPrice ? hexToBig(rc.effectiveGasPrice) : BigInt(v.maxFee), ok: rc.status === "0x1" });
    }
    this.store.save();
    this.dirty = true;
  }

  private confirm(p: PendingTx, v: PendingTx["variants"][number], r: { block: number; ts: number; gasUsed: bigint; price: bigint; ok: boolean }) {
    this.s.pending = this.s.pending.filter((x) => x !== p);
    const c = this.s.counters;
    c.transactions++;
    c.byKind[p.kind]++;
    if (!r.ok) c.failed++;
    if (r.ok) c.volumeWei = (BigInt(c.volumeWei) + BigInt(v.value)).toString();
    c.gasWei = (BigInt(c.gasWei) + r.gasUsed * r.price).toString();
    const day = dayOf(r.ts);
    this.s.daily[day] = (this.s.daily[day] ?? 0) + 1;
    const b = tenMinOf(r.ts);
    this.s.tenMin[b] = (this.s.tenMin[b] ?? 0) + 1;
    const floor = Math.floor(r.ts / 600) - 288;
    for (const k of Object.keys(this.s.tenMin)) if (Number(k) < floor) delete this.s.tenMin[k];
    if (!this.s.firstTx || r.block < this.s.firstTx.block) this.s.firstTx = { at: r.ts, block: r.block };
    if (!this.s.lastTx || r.block >= this.s.lastTx.block) this.s.lastTx = { at: r.ts, block: r.block };
    if (p.from === 0) this.s.floatUsed = true;
    const w = p.wave !== null ? this.s.waves.find((x) => x.id === p.wave) : undefined;
    if (w && p.item !== null) {
      const it = w.items[p.item];
      it.status = r.ok ? "done" : "failed";
      it.hash = v.hash;
      it.value = v.value;
    }
    if (p.kind === "final" && this.s.finalSweep) this.s.finalSweep.inflight = this.s.finalSweep.inflight.filter((i) => i !== p.from);
    if (p.kind === "sink" && r.ok) {
      this.s.sinkTransfers.push({ hash: v.hash, valueWei: v.value, at: r.ts, block: r.block });
      if (this.s.sinkTransfers.length > 200) this.s.sinkTransfers.splice(0, this.s.sinkTransfers.length - 200);
      this.log().info("sink transfer", { hash: v.hash, fmx: fmx(BigInt(v.value)), sink: this.cfg.sink });
    }
  }

  /* ------------------------------------------------------------------ the float → the sink */

  private async maybeSinkSweep(): Promise<void> {
    const now = this.nowS();
    if (now - this.s.lastSinkSweepAt < this.cfg.sinkSweepIntervalS) return;
    if (this.s.floatNonce === null || !this.preflightOk) return; // the next preflight re-reads the float's nonce
    if (this.s.pending.some((p) => p.from === 0 && !p.accepted)) return; // one unaccepted float tx at a time
    let bal: bigint;
    try { bal = hexToBig(await this.deps.rpc.call("eth_getBalance", [this.floatAddr, "latest"])); } catch { return; }
    this.s.lastSinkSweepAt = now;
    this.dirty = true;
    const fees = this.fees();
    const surplus = bal - this.cfg.floatReserveWei - this.floatOwed() - maxCost(this.gas, fees);
    if (surplus < this.cfg.sinkSweepMinWei) { this.store.save(); return; }
    await this.sendFloatToSink(surplus, fees, undefined);
  }

  private async sendFloatToSink(value: bigint, fees: Fees, balance: bigint | undefined): Promise<boolean> {
    // markLost earlier in this same tick clears the float's nonce until the next preflight re-reads it: signing
    // with it would have taken nonce 0 (answered "nonce too low", which reads as accepted)
    const nonce = this.s.floatNonce;
    if (nonce === null || !this.preflightOk) return false;
    if (!this.bucket.tryTake()) return false;
    const p = this.sign("sink", 0, this.cfg.sink, value, nonce, fees, null, null, balance);
    this.s.floatNonce = nonce + 1;
    this.s.pending.push(p);
    this.store.save();
    const r = await this.broadcast(p, p.variants[0]);
    if (r === "rejected") { this.dropRejected(p); return false; }
    this.log().info("float → sink sent", { fmx: fmx(value), hash: p.variants[0].hash, all: balance !== undefined });
    return true;
  }

  /* ------------------------------------------------------------------ the final sweep pass */

  private async finalSweepStep(): Promise<void> {
    const fs = this.s.finalSweep!;
    // 1. drain this batch's queue
    while (fs.queue.length) {
      if (!this.bucket.tryTake()) return;
      const q = fs.queue[0];
      const fees = this.fees();
      const value = sweepValue(BigInt(q.balance), this.gas, fees);
      fs.queue.shift();
      if (value <= 0n) continue;
      const p = this.sign("final", q.i, this.floatAddr, value, q.nonce, fees, null, null, BigInt(q.balance));
      this.s.pending.push(p);
      fs.inflight.push(q.i);
      this.store.save();
      const r = await this.broadcast(p, p.variants[0]);
      if (r === "rejected") {
        this.dropRejected(p);
        const tries = (this.sendErrors.get(`final:${q.i}`) ?? 0) + 1;
        this.sendErrors.set(`final:${q.i}`, tries);
        if (tries < 3) fs.queue.push(q);
        else this.log().warn("final sweep: wallet skipped after 3 rejections", { wallet: q.i });
        this.store.save();
        return;
      }
    }
    if (fs.inflight.length) return; // wait for this batch to land
    // 2. next batch
    if (fs.cursor <= fs.upTo) {
      const idx: number[] = [];
      for (let i = fs.cursor; i <= fs.upTo && idx.length < this.cfg.finalSweepBatch; i++) idx.push(i);
      const bals = await this.balances(idx);
      if (!bals) return;
      const fees = this.fees();
      const sweepable = idx.map((i, k) => ({ i, b: bals[k] })).filter((x) => sweepValue(x.b, this.gas, fees) > 0n);
      if (sweepable.length) {
        const ns = await this.deps.rpc.batch(sweepable.map((x) => ({ method: "eth_getTransactionCount", params: [this.addr(x.i), "pending"] })));
        if (ns.some((r) => r instanceof RpcError)) return;
        fs.queue = sweepable.map((x, k) => ({ i: x.i, nonce: hexToNum(ns[k]), balance: x.b.toString() }));
      }
      fs.cursor = idx[idx.length - 1] + 1;
      this.store.save();
      return;
    }
    // 3. every wallet is swept: the float's closing transfer to the sink
    if (this.floatHasPending()) return;
    if (!fs.closing) {
      let bal: bigint;
      try { bal = hexToBig(await this.deps.rpc.call("eth_getBalance", [this.floatAddr, "latest"])); } catch { return; }
      const fees = this.fees();
      const all = fs.reason === "drain" || !this.cfg.loop;
      const value = all ? sweepValue(bal, this.gas, fees) : bal - this.cfg.floatReserveWei - maxCost(this.gas, fees);
      if (value > 0n && (all || value >= this.cfg.sinkSweepMinWei)) {
        fs.closing = true;
        this.store.save();
        if (!(await this.sendFloatToSink(value, fees, all ? bal : undefined))) { fs.closing = false; this.store.save(); }
        return;
      }
      fs.closing = true;
    }
    // 4. done
    const all = fs.reason === "drain" || !this.cfg.loop;
    this.log().info("final sweep pass: done", { reason: fs.reason, pass: fs.pass, wallets: fs.upTo, counters: this.s.counters });
    this.s.finalSweep = null;
    this.s.lastSinkSweepAt = this.nowS();
    if (all) this.s.drained = true;
    else { this.s.pass++; this.s.nextIndex = 1; }
    this.store.save();
    if (all) this.setMode("drained");
    this.publish(true);
  }

  /* ------------------------------------------------------------------ dry run */

  private async dryTick(): Promise<void> {
    const now = this.nowS();
    if (now >= this.nextGuardAt) {
      this.nextGuardAt = now + this.cfg.guardIntervalS;
      const r = await checkChain(this.cfg, { rpc: this.deps.rpc, fetchImpl: this.deps.fetchImpl, nowS: () => this.nowS() });
      const changed = !this.lastGuard || this.lastGuard.ok !== r.ok || this.lastGuard.reasons.join() !== r.reasons.join();
      this.lastGuard = r;
      if (r.head !== null && r.baseFee !== null && r.gasUsed !== null && r.gasLimit !== null) this.head = { n: r.head, baseFee: r.baseFee, gasUsed: r.gasUsed, gasLimit: r.gasLimit, at: this.nowMs() };
      if (changed) this.log().info("dry-run: guards", { ok: r.ok, reasons: r.reasons, head: r.head, headAgeS: r.headAgeS, signers: r.signers, txpoolPending: r.txpoolPending, explorerLag: r.explorerLag });
      this.dirty = true;
    }
    if (!this.head || now < this.dry.nextAt) return;
    // one planned wave per interval the live runner would need for it at RATE
    const start = this.s.nextIndex + this.dry.cursor >= this.cfg.wallets ? 1 : this.s.nextIndex + this.dry.cursor;
    const plan = this.planWave(start, this.cfg.maxInFlightWei);
    if (!plan) return;
    const txs = plan.items.length + plan.indices.length; // fund + transfers + one sweep each
    this.dry.cursor = plan.indices[plan.indices.length - 1] + 1 - this.s.nextIndex;
    this.dry.waves++;
    this.dry.nextAt = now + Math.max(5, Math.ceil(txs / this.cfg.rate));
    this.log().info("dry-run: would run wave", { wave: this.dry.waves, from: plan.indices[0], to: plan.indices[plan.indices.length - 1], fundFmx: fmx(plan.funded), transfers: plan.items.filter((x) => x.kind === "transfer").length, txs, guardsOk: this.lastGuard?.ok ?? null });
  }

  /* ------------------------------------------------------------------ publishing */

  private heartbeat() {
    this.log().info("heartbeat", { mode: this.mode, paused: this.pauseReason, pass: this.s.pass, nextIndex: this.s.nextIndex, waves: this.s.waves.length, pending: this.s.pending.length, txs: this.s.counters.transactions, organicThrough: this.s.organic.cursor, floatFmx: this.floatBalance === null ? null : fmx(this.floatBalance), inFlightFmx: fmx(this.inFlight()) });
  }

  last24h(): number {
    const from = Math.floor(this.nowS() / 600) - 143; // the current bucket and the 143 before it
    let n = 0;
    for (const [k, v] of Object.entries(this.s.tenMin)) if (Number(k) >= from) n += v;
    return n;
  }

  stats() {
    const s = this.s;
    const activated = s.highestActivated;
    return {
      schema: STATS_SCHEMA,
      updatedAt: this.nowS(),
      mode: this.mode,
      enabled: this.cfg.enabled,
      paused: this.paused,
      pauseReason: this.pauseReason,
      pausedSince: this.pauseSince,
      lastPause: s.lastPause,
      purpose: "Labelled network load test run by Wizrd (agent #12). Not organic usage: excluded from the network's public usage numbers.",
      chainId: this.cfg.chainId,
      marker: { prefix: MARKER_PREFIX, ascii: "FXLT", version: MARKER_VERSION, data: MARKER_DATA },
      sink: this.cfg.sink,
      float: {
        address: this.floatAddr,
        balanceWei: this.floatBalance === null ? null : this.floatBalance.toString(),
        inFlightWei: this.inFlight().toString(),
        reserveWei: this.cfg.floatReserveWei.toString(),
        minWei: this.cfg.floatMinWei.toString(),
        maxInFlightWei: this.cfg.maxInFlightWei.toString(),
      },
      derivation: { path: `${DERIVATION_BASE}/i`, xpub: this.keys.xpub, float: 0, wallets: `1..${this.cfg.wallets - 1}` },
      wallets: { planned: this.cfg.wallets, activated, highestIndex: activated, nextIndex: s.nextIndex, pass: s.pass, activeWaves: s.waves.length },
      counters: {
        transactions: s.counters.transactions,
        byKind: Object.fromEntries(KINDS.map((k) => [k, s.counters.byKind[k]])),
        failed: s.counters.failed,
        volumeWei: s.counters.volumeWei,
        gasWei: s.counters.gasWei,
        addresses: this.addressCount(),
        addressesOnChain: this.addressesOnChain(),
        pending: s.pending.length,
      },
      // every transaction on chain that is not the load test's, counted from the blocks (organic.ts)
      organic: this.organicStats(),
      // the explorer index's own totals, each with the load-test count that belongs to it (see readIndex),
      // and the figures at the last read (a figure the explorer shows that is not here was counted after it)
      indexSnapshot: { transactions: s.indexSnap.transactions, addresses: s.indexSnap.addresses, last24h: s.indexSnap.last24h },
      indexRead: s.indexRead ? { at: s.indexRead.at, ...s.indexRead.fig } : null,
      daily: s.daily,
      last24h: this.last24h(),
      firstTx: s.firstTx,
      lastTx: s.lastTx,
      startedAt: s.firstLiveAt,
      createdAt: s.createdAt,
      rate: this.cfg.rate,
      gas: { perTransfer: this.gas.toString(), rule: this.gasRule, tipWei: this.cfg.tipWei.toString() },
      guards: this.lastGuard ? { ok: this.lastGuard.ok, reasons: this.lastGuard.reasons, head: this.lastGuard.head, headAgeS: this.lastGuard.headAgeS, signers: this.lastGuard.signers, txpoolPending: this.lastGuard.txpoolPending, explorerLag: this.lastGuard.explorerLag, at: this.lastGuard.at } : null,
      finalSweep: s.finalSweep ? { reason: s.finalSweep.reason, cursor: s.finalSweep.cursor, upTo: s.finalSweep.upTo } : null,
      drained: s.drained,
      sinkTransfers: s.sinkTransfers.slice(-20),
    };
  }

  private organicStats() {
    if (!this.cfg.organicWalk) return null;
    const o = this.s.organic;
    if (o.readyAt === null) return { ready: false, throughBlock: o.cursor };
    return { ready: true, throughBlock: o.cursor, transactions: o.total, last24h: organicLast24h(o, this.nowS()), loadtest: o.loadtest, at: o.at, confirmations: this.cfg.organicConfirmations };
  }

  publish(force = false) {
    const now = this.nowMs();
    if (!force && (!this.dirty || now - this.lastPublish < this.cfg.publishIntervalS * 1000)) return;
    try {
      writeStats(this.cfg.publicDir, this.stats());
      this.lastPublish = now;
      this.dirty = false;
    } catch (e) {
      this.log().error("publish failed", { error: (e as Error).message });
    }
  }
}
