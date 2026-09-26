// FMX supply, computed from chain 3961 — the plain-number endpoints listing sites poll, a JSON breakdown anyone
// can re-derive, and a CoinGecko-shaped coin record the self-hosted explorer can read its market data from.
//
//   GET /api/supply                       the whole breakdown (JSON): every input, every excluded address, the block
//   GET /api/supply/total                 plain number, whole FMX (text/plain) · ?format=json for a small JSON body
//   GET /api/supply/circulating           plain number, whole FMX (text/plain) · ?format=json
//   GET /api/supply/max                   plain number, whole FMX (text/plain) · ?format=json
//   GET /api/market/coingecko/coins/:id   CoinGecko /coins/{id} response shape (id "ferminux"): price, market cap,
//                                         supply, image. Blockscout's CoinGecko market source reads it when
//                                         MARKET_COINGECKO_BASE_URL points here (explorer/envs/backend.env).
//   GET /api/market/coingecko/coins/:id/market_chart   the same shape's history route: no history is kept, so
//                                         the arrays are empty (the explorer's history fetcher stays off).
//
// THE DEFINITIONS (also in SUPPLY_DEFINITIONS, returned by /api/supply and printed in the API docs):
//
//   total       = genesis allocations (30,000,000 FMX, genesis/genesis.json)
//               + pre-authority issuance, blocks 1..159,999 (block, uncle and nephew rewards; measured once by
//                 scripts/measure-supply.mjs, since uncles are history, not schedule: POW_ERA below)
//               + authority issuance, blocks 160,000..B (the consensus schedule, a closed form: 0.25 FMX a block
//                 today, halving at every multiple of 4,500,000)
//               − EIP-1559 base fees burned through B (a checkpoint measured by the same script, then tracked here
//                 block by block with eth_feeHistory)
//               − the balances of the burn addresses 0x…0000 and 0x…dEaD
//   circulating = total − FMX that is contract-locked (FoundationLock), unvested (FMXVesting) or held by the
//                 foundation (treasury, reward sink, multisig, the genesis reserve wallets, the faucet contract,
//                 and any address in SUPPLY_FOUNDATION_WALLETS). Every excluded address and its balance is listed.
//   max         = the emission schedule's limit: genesis + pre-authority issuance + every authority block reward
//                 until the reward rounds to zero. Burns make the real total lower.
//
// B is the head minus 64 blocks (the chain's maximum reorg depth), so every figure in one answer is read at the
// same block, and that block can no longer change. The whole answer is cached for 60 s.
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAddress, Interface } from "ethers";
import type { Db } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import { CHAIN, FERMINUX_DEX, FIXED_CONTRACTS } from "./constants.js";

export const E18 = 10n ** 18n;

/** The genesis alloc of genesis/genesis.json: five accounts, 30,000,000 FMX (a test re-sums the file). */
export const GENESIS_WEI = 30_000_000n * E18;
/** chain/params FerminuxChainConfig.PosaBlock: the first block confirmed by the authority signer set. */
export const POSA_BLOCK = 160_000;
/** chain/consensus/powhash/ferminux.go FerminuxEmissionForkBlock: 6 FMX a block before it, 1 FMX (halving) after. */
export const EMISSION_FORK_BLOCK = 20_000;
/** chain/consensus/powhash/ferminux.go FerminuxHalvingInterval, anchored to absolute height. */
export const HALVING_INTERVAL = 4_500_000;
/** chain/params FerminuxMaxReorgDepth: a block this deep can no longer be replaced. */
export const FINALITY_DEPTH = 64;
/** chain/consensus/posa rewardDivisor: the authority reward is the schedule's reward divided by four. */
export const POSA_REWARD_DIVISOR = 4n;

/**
 * The pre-authority era (blocks 1..159,999), measured by `node scripts/measure-supply.mjs` on 2026-09-26 against
 * rpc.ferminux.net. The era is closed, so these numbers never change; the base reward is re-derived from the
 * schedule by a test, and the uncle figures are what the chain's blocks record: 16,299 uncles in 11,318 blocks,
 * each paying the uncle's coinbase (U + 8 − N) / 8 of the block reward and the including block's coinbase 1/32 more.
 */
export const POW_ERA = {
  fromBlock: 1,
  toBlock: POSA_BLOCK - 1,
  baseRewardWei: 259_994n * E18,
  unclesIncluded: 16_299,
  blocksWithUncles: 11_318,
  uncleRewardWei: 42_792n * E18,
  nephewRewardWei: 2_193_875n * 10n ** 15n,
  issuedWei: 304_979_875n * 10n ** 15n,
  measuredAt: "2026-09-26",
} as const;

/** EIP-1559 base fees burned in blocks 1..block, measured by the same script; the tracker continues from here. */
export const BURN_CHECKPOINT = { block: 413_163, burnedWei: 2_567_336_314_603_710n, measuredAt: "2026-09-26" } as const;

export const BURN_ADDRESSES = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"] as const;

export const FOUNDATION_LOCK = "0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d";
export const FMX_VESTING = "0x6F488FB1f382Bc96Fef8bBfCa28A9647E5Fe430B";
export const REWARD_SINK = "0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6";

export type ExclusionCategory = "locked" | "vesting" | "foundation";
export interface SupplyExclusion {
  address: string;
  label: string;
  /** how the excluded amount is read: the whole balance, the unvested part, or the lock's balance while it is shut */
  kind: "balance" | "vesting" | "lock";
  category: ExclusionCategory;
  note: string;
}

/** Who holds FMX that is not in public hands. Order is the order /api/supply lists them in. */
export const SUPPLY_EXCLUSIONS: readonly SupplyExclusion[] = [
  { address: FOUNDATION_LOCK, label: "FoundationLock", kind: "lock", category: "locked", note: "Time-locked vault: nothing can leave before unlockAt (2027-08-21 19:26 UTC); after that only its owner, the multisig, can withdraw. Counted as foundation-held once it opens." },
  { address: FMX_VESTING, label: "FMXVesting (team allocation)", kind: "vesting", category: "vesting", note: "5,000,000 FMX vesting linearly over 1,080 days from 2026-08-20 (fully vested 2029-08-04), with nothing releasable before the 180-day cliff on 2027-02-16, when the first sixth vests at once. The unvested part is excluded; FMX that has vested counts as circulating." },
  { address: FIXED_CONTRACTS.treasury, label: "Treasury", kind: "balance", category: "foundation", note: "Genesis treasury allocation (12,000,000 FMX) plus 10 % of every authority block reward." },
  { address: REWARD_SINK, label: "FMXRewardSink", kind: "balance", category: "foundation", note: "Receives 50 % of every authority block reward; only the multisig can withdraw." },
  { address: FIXED_CONTRACTS.multisig, label: "Ferminux multisig", kind: "balance", category: "foundation", note: "Owner of the treasury contracts." },
  { address: "0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787", label: "Ecosystem and listings reserve (genesis)", kind: "balance", category: "foundation", note: "Genesis allocation of 6,000,000 FMX for developer grants, listings and bounties." },
  { address: "0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE", label: "AZNT liquidity and market operations (genesis)", kind: "balance", category: "foundation", note: "Genesis allocation of 4,000,000 FMX." },
  { address: "0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC", label: "Community, faucet and airdrops (genesis)", kind: "balance", category: "foundation", note: "Genesis allocation of 3,000,000 FMX." },
  { address: FIXED_CONTRACTS.faucet, label: "Faucet contract", kind: "balance", category: "foundation", note: "FMX waiting to be dripped to new keys." },
];

/**
 * The three supply figures that appear in this repository, reconciled. Served by /api/supply as `reconciliation`
 * and printed in the OpenAPI description and llms.txt.
 */
export const SUPPLY_RECONCILIATION = [
  "30,000,000 FMX is the genesis allocation (genesis/genesis.json): what existed at block 0, not the supply today.",
  "The emission schedule adds about 2,515,000 FMX in total, so total supply converges to about 32,515,000 FMX (GET /api/supply/max). The README's \"a little under 32,500,000\" counts only the schedule's base block rewards and leaves out the 44,986 FMX of uncle and nephew rewards paid before block 160,000.",
  "34,600,000 FMX (staking/DESIGN.md) was a projection of supply at a hand-off planned for block 4,500,000, assuming the full 1 FMX block reward (in force since the Emission fork at block 20,000) would be paid until then. The authority fork came at block 160,000 instead and divided the reward by four, so supply never approaches that figure.",
  "The explorer's own \"coinsupply\" figure is the sum of the address balances it has indexed, which is incomplete on a pruned node; this API computes supply from the chain's rules and its blocks instead.",
] as const;

export const SUPPLY_DEFINITIONS = {
  total:
    "Genesis allocations (30,000,000 FMX) + block rewards paid so far (pre-authority blocks 1–159,999 including uncle and nephew rewards; authority blocks from 160,000 at 0.25 FMX, halving every 4,500,000 blocks) − EIP-1559 base fees burned − the balances of 0x…0000 and 0x…dEaD.",
  circulating:
    "Total supply minus FMX that is contract-locked (FoundationLock), not yet vested (FMXVesting) or held by the foundation (treasury, reward sink, multisig, the genesis reserve wallets and the faucet contract). Every excluded address and the amount excluded is listed in GET /api/supply.",
  max: "The emission schedule's limit: genesis + every block reward the schedule will ever pay (the reward halves every 4,500,000 blocks until it rounds to zero). Burned fees make the real figure lower.",
  block: "Every figure is read at one block: the head minus 64, the chain's maximum reorg depth, so it can no longer change.",
} as const;

// --------------------------------------------------------------------------------------------- the schedule

/** chain/consensus/powhash/ferminux.go FerminuxBlockReward(n), in wei. */
export function scheduleReward(n: number): bigint {
  if (n < EMISSION_FORK_BLOCK) return 6n * E18;
  const era = Math.floor(n / HALVING_INTERVAL);
  return era > 60 ? 0n : E18 >> BigInt(era);
}

/** chain/consensus/posa BlockReward(n): the authority block reward (signer + sink + treasury), in wei. */
export function authorityReward(n: number): bigint {
  return scheduleReward(n) / POSA_REWARD_DIVISOR;
}

/** Σ authorityReward(n) for n = POSA_BLOCK..through (0 below the fork). `Infinity` sums the whole schedule. */
export function authorityIssuedThrough(through: number): bigint {
  if (through < POSA_BLOCK) return 0n;
  let sum = 0n;
  for (let era = Math.floor(POSA_BLOCK / HALVING_INTERVAL); era <= 61; era++) {
    const lo = Math.max(POSA_BLOCK, era * HALVING_INTERVAL);
    const hi = Math.min(through, (era + 1) * HALVING_INTERVAL - 1);
    if (hi < lo) break;
    sum += BigInt(hi - lo + 1) * authorityReward(lo);
  }
  return sum;
}

/** Σ scheduleReward(n) for n = 1..POSA_BLOCK-1: the pre-authority era's base rewards (no uncles). */
export function preAuthorityBaseReward(): bigint {
  const fork = BigInt(EMISSION_FORK_BLOCK - 1) * 6n * E18;
  return fork + BigInt(POSA_BLOCK - EMISSION_FORK_BLOCK) * E18;
}

/** The schedule's limit: genesis + pre-authority issuance + every authority reward. */
export function maxSupplyWei(): bigint {
  return GENESIS_WEI + POW_ERA.issuedWei + authorityIssuedThrough(Number.MAX_SAFE_INTEGER);
}

/** Wei → whole FMX as a decimal string: 18 decimals, trailing zeros trimmed. */
export function fmxString(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / E18;
  const frac = (v % E18).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Wei → the plain number listing sites read: whole FMX, at most 8 decimals, truncated (never rounded up). */
export function plainNumber(wei: bigint): string {
  const v = wei < 0n ? 0n : wei;
  const whole = v / E18;
  const frac = ((v % E18) / 10n ** 10n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** SUPPLY_FOUNDATION_WALLETS="0xabc…:label,0xdef…" → extra foundation-held addresses (bad entries are skipped). */
export function extraFoundationFromEnv(v: string | undefined = process.env.SUPPLY_FOUNDATION_WALLETS): SupplyExclusion[] {
  const out: SupplyExclusion[] = [];
  const known = new Set(SUPPLY_EXCLUSIONS.map((e) => e.address.toLowerCase()));
  for (const part of (v ?? "").split(",")) {
    const [addr, ...rest] = part.trim().split(":");
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    let a: string;
    try {
      a = getAddress(addr.toLowerCase());
    } catch {
      continue;
    }
    if (known.has(a.toLowerCase())) continue;
    known.add(a.toLowerCase());
    const label = rest.join(":").trim().slice(0, 80) || "Foundation wallet";
    out.push({ address: a, label, kind: "balance", category: "foundation", note: "Named by the operator in SUPPLY_FOUNDATION_WALLETS." });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- chain reads

/** The one method the supply code needs from a JSON-RPC client (ethers' JsonRpcProvider has it and batches). */
export interface RpcClient {
  send(method: string, params: unknown[]): Promise<any>;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const VIEWS = new Interface(["function releasable() view returns (uint256)", "function remaining() view returns (uint256)"]);

/**
 * Base fees burned, block by block, from the checkpoint on. One eth_feeHistory call covers 1,024 blocks and says
 * which of them used gas; only those blocks are fetched, for their exact baseFeePerGas × gasUsed. Progress is
 * kept in the gateway DB (meta "supply.burn"), so a restart does not start over.
 */
export class BurnTracker {
  private through: number;
  private burnedWei: bigint;
  private syncing: Promise<void> | null = null;
  constructor(
    private readonly rpc: RpcClient,
    private readonly db?: Db,
    checkpoint: { block: number; burnedWei: bigint } = BURN_CHECKPOINT,
  ) {
    let start: { through: number; burnedWei: bigint } = { through: checkpoint.block, burnedWei: checkpoint.burnedWei };
    const saved = db ? getMeta(db, "supply.burn") : undefined;
    if (saved) {
      try {
        const j = JSON.parse(saved) as { through?: number; burnedWei?: string };
        // a saved position behind the checkpoint (an older build's) is dropped: the checkpoint is further along
        if (Number.isInteger(j.through) && typeof j.burnedWei === "string" && /^\d+$/.test(j.burnedWei) && (j.through as number) >= checkpoint.block) {
          start = { through: j.through as number, burnedWei: BigInt(j.burnedWei) };
        }
      } catch {
        /* a damaged row falls back to the checkpoint */
      }
    }
    this.through = start.through;
    this.burnedWei = start.burnedWei;
  }
  get state(): { through: number; burnedWei: bigint } {
    return { through: this.through, burnedWei: this.burnedWei };
  }
  /** Walks forward to `target` (at most `maxChunks` × 1,024 blocks per call; the next call continues). */
  syncTo(target: number, maxChunks = 64): Promise<void> {
    if (!this.syncing) this.syncing = this.walk(target, maxChunks).finally(() => (this.syncing = null));
    return this.syncing;
  }
  private async walk(target: number, maxChunks: number): Promise<void> {
    for (let chunk = 0; chunk < maxChunks && this.through < target; chunk++) {
      const from = this.through + 1;
      const to = Math.min(target, from + 1023);
      const fh = (await this.rpc.send("eth_feeHistory", [hex(to - from + 1), hex(to), []])) as { oldestBlock: string; gasUsedRatio: number[] };
      const oldest = Number(fh?.oldestBlock);
      if (!Array.isArray(fh?.gasUsedRatio) || oldest !== from || fh.gasUsedRatio.length !== to - from + 1) {
        throw new Error(`eth_feeHistory answered blocks ${oldest}+${fh?.gasUsedRatio?.length ?? 0}, asked ${from}..${to}`);
      }
      const used = fh.gasUsedRatio.map((r, i) => (r > 0 ? from + i : -1)).filter((n) => n >= 0);
      const blocks = (await Promise.all(used.map((n) => this.rpc.send("eth_getBlockByNumber", [hex(n), false])))) as Array<{ baseFeePerGas?: string; gasUsed: string } | null>;
      let add = 0n;
      blocks.forEach((b, i) => {
        if (!b) throw new Error(`block ${used[i]} not found`);
        add += BigInt(b.baseFeePerGas ?? "0x0") * BigInt(b.gasUsed);
      });
      this.burnedWei += add;
      this.through = to;
      if (this.db) setMeta(this.db, "supply.burn", JSON.stringify({ through: this.through, burnedWei: this.burnedWei.toString() }));
    }
  }
}

export interface ExcludedView {
  address: string;
  label: string;
  category: ExclusionCategory;
  balance: string;
  excluded: string;
  excludedWei: string;
  note: string;
}

export interface SupplySnapshot {
  symbol: "FMX";
  decimals: 18;
  chainId: number;
  asOfBlock: number;
  asOfTimestamp: number;
  head: number;
  totalSupply: string;
  circulatingSupply: string;
  maxSupply: string;
  wei: { total: string; circulating: string; max: string };
  components: {
    genesis: { fmx: string; wei: string; source: string };
    preAuthorityIssuance: { fmx: string; wei: string; blocks: string; baseRewardFmx: string; uncleRewardFmx: string; nephewRewardFmx: string; unclesIncluded: number; measuredAt: string };
    authorityIssuance: { fmx: string; wei: string; blocks: string; rewardPerBlockFmx: string };
    burnedBaseFees: { fmx: string; wei: string; throughBlock: number; checkpoint: { block: number; fmx: string } };
    burnAddresses: { fmx: string; wei: string; addresses: readonly string[] };
  };
  excluded: ExcludedView[];
  excludedTotals: Record<ExclusionCategory, string> & { all: string };
  definitions: typeof SUPPLY_DEFINITIONS;
  reconciliation: typeof SUPPLY_RECONCILIATION;
  stale?: boolean;
  computedAt: number;
}

export interface SupplyServiceOptions {
  rpc: RpcClient;
  db?: Db;
  now?: () => number;
  /** extra foundation-held addresses (default SUPPLY_FOUNDATION_WALLETS) */
  extra?: SupplyExclusion[];
  cacheMs?: number;
  /** a last good answer older than this is not served when the chain cannot be read (default 1 h) */
  staleMs?: number;
  checkpoint?: { block: number; burnedWei: bigint };
}

export class SupplyService {
  readonly burn: BurnTracker;
  private readonly exclusions: SupplyExclusion[];
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly staleMs: number;
  private cache: SupplySnapshot | null = null;
  private inflight: Promise<SupplySnapshot> | null = null;
  constructor(private readonly opts: SupplyServiceOptions) {
    this.burn = new BurnTracker(opts.rpc, opts.db, opts.checkpoint);
    this.exclusions = [...SUPPLY_EXCLUSIONS, ...(opts.extra ?? extraFoundationFromEnv())];
    this.now = opts.now ?? (() => Date.now());
    this.cacheMs = opts.cacheMs ?? 60_000;
    this.staleMs = opts.staleMs ?? 3_600_000;
  }

  /** The current snapshot (cached `cacheMs`); when the chain cannot be read, the last good one (≤ staleMs) marked stale. */
  async snapshot(): Promise<SupplySnapshot> {
    if (this.cache && this.now() - this.cache.computedAt < this.cacheMs) return this.cache;
    if (!this.inflight) {
      this.inflight = this.compute()
        .then((s) => (this.cache = s))
        .finally(() => (this.inflight = null));
    }
    try {
      return await this.inflight;
    } catch (err) {
      if (this.cache && this.now() - this.cache.computedAt < this.staleMs) return { ...this.cache, stale: true };
      throw err;
    }
  }

  private async compute(): Promise<SupplySnapshot> {
    const { rpc } = this.opts;
    const head = Number(await rpc.send("eth_blockNumber", []));
    if (!Number.isInteger(head) || head < POSA_BLOCK + FINALITY_DEPTH) throw new Error(`unexpected head ${head}`);
    const target = head - FINALITY_DEPTH;
    await this.burn.syncTo(target);
    // Everything is read at one block. If the burn tracker is still catching up, that block is where it stands,
    // as long as the node still holds that state (pruned nodes keep the last 128 blocks; 120 leaves the head room
    // to move while the reads run). Past that, burns are counted through burnedBaseFees.throughBlock only.
    const burn = this.burn.state;
    const asOf = Math.max(Math.min(target, burn.through), head - 120);
    const tag = hex(asOf);
    const addrs = [...this.exclusions.map((e) => e.address), ...BURN_ADDRESSES];
    const [block, balances, releasableRaw, remainingRaw] = await Promise.all([
      rpc.send("eth_getBlockByNumber", [tag, false]) as Promise<{ timestamp: string } | null>,
      Promise.all(addrs.map((a) => rpc.send("eth_getBalance", [a, tag]).then((v: string) => BigInt(v)))),
      rpc.send("eth_call", [{ to: FMX_VESTING, data: VIEWS.encodeFunctionData("releasable") }, tag]) as Promise<string>,
      rpc.send("eth_call", [{ to: FOUNDATION_LOCK, data: VIEWS.encodeFunctionData("remaining") }, tag]) as Promise<string>,
    ]);
    const releasable = BigInt(VIEWS.decodeFunctionResult("releasable", releasableRaw)[0] as bigint);
    const lockOpen = BigInt(VIEWS.decodeFunctionResult("remaining", remainingRaw)[0] as bigint) === 0n;
    const burnBalances = balances.slice(this.exclusions.length);
    const burnAddrWei = burnBalances.reduce((a, b) => a + b, 0n);
    const burnedWei = burn.burnedWei;
    const authorityWei = authorityIssuedThrough(asOf);
    const total = GENESIS_WEI + POW_ERA.issuedWei + authorityWei - burnedWei - burnAddrWei;

    const totals: Record<ExclusionCategory, bigint> = { locked: 0n, vesting: 0n, foundation: 0n };
    const excluded: ExcludedView[] = this.exclusions.map((e, i) => {
      const bal = balances[i]!;
      let amount = bal;
      let category = e.category;
      if (e.kind === "vesting") amount = bal > releasable ? bal - releasable : 0n;
      if (e.kind === "lock" && lockOpen) category = "foundation";
      totals[category] += amount;
      return { address: getAddress(e.address), label: e.label, category, balance: fmxString(bal), excluded: fmxString(amount), excludedWei: amount.toString(), note: e.note };
    });
    const excludedAll = totals.locked + totals.vesting + totals.foundation;
    const circulating = total - excludedAll;
    const max = maxSupplyWei();
    return {
      symbol: "FMX",
      decimals: 18,
      chainId: CHAIN.chainId,
      asOfBlock: asOf,
      asOfTimestamp: block ? Number(block.timestamp) : 0,
      head,
      totalSupply: fmxString(total),
      circulatingSupply: fmxString(circulating),
      maxSupply: fmxString(max),
      wei: { total: total.toString(), circulating: circulating.toString(), max: max.toString() },
      components: {
        genesis: { fmx: fmxString(GENESIS_WEI), wei: GENESIS_WEI.toString(), source: "genesis/genesis.json alloc: treasury 12,000,000 · ecosystem 6,000,000 · team 5,000,000 · AZNT liquidity 4,000,000 · community 3,000,000" },
        preAuthorityIssuance: {
          fmx: fmxString(POW_ERA.issuedWei),
          wei: POW_ERA.issuedWei.toString(),
          blocks: `${POW_ERA.fromBlock}-${POW_ERA.toBlock}`,
          baseRewardFmx: fmxString(POW_ERA.baseRewardWei),
          uncleRewardFmx: fmxString(POW_ERA.uncleRewardWei),
          nephewRewardFmx: fmxString(POW_ERA.nephewRewardWei),
          unclesIncluded: POW_ERA.unclesIncluded,
          measuredAt: POW_ERA.measuredAt,
        },
        authorityIssuance: { fmx: fmxString(authorityWei), wei: authorityWei.toString(), blocks: `${POSA_BLOCK}-${asOf}`, rewardPerBlockFmx: fmxString(authorityReward(asOf)) },
        burnedBaseFees: { fmx: fmxString(burnedWei), wei: burnedWei.toString(), throughBlock: burn.through, checkpoint: { block: BURN_CHECKPOINT.block, fmx: fmxString(BURN_CHECKPOINT.burnedWei) } },
        burnAddresses: { fmx: fmxString(burnAddrWei), wei: burnAddrWei.toString(), addresses: BURN_ADDRESSES },
      },
      excluded,
      excludedTotals: { locked: fmxString(totals.locked), vesting: fmxString(totals.vesting), foundation: fmxString(totals.foundation), all: fmxString(excludedAll) },
      definitions: SUPPLY_DEFINITIONS,
      reconciliation: SUPPLY_RECONCILIATION,
      computedAt: this.now(),
    };
  }
}

// --------------------------------------------------------------------------------------------- routes

/** CoinGecko coin id the explorer is configured with (MARKET_COINGECKO_COIN_ID). */
export const CG_COIN_ID = "ferminux";
const LOGO = "https://ferminux.net/assets/brand/fmx-256.png";

/** Where the FMX price comes from: the gateway's PriceFeed (the Ferminux DEX first). Injected so tests need no chain. */
export interface MarketPriceSource {
  market(): Promise<{ priceE18: bigint; venue: string; at: number; liquidityUsdE18?: bigint }>;
}

/** priceE18 × supplyWei / 1e36 → a USD number (float; fine for display and for the explorer). */
const usd = (priceE18: bigint, wei: bigint) => Number((priceE18 * wei) / E18 / 10n ** 12n) / 1e6;
const priceNumber = (priceE18: bigint) => Number(priceE18 / 10n ** 6n) / 1e12;

export function registerSupplyRoutes(app: FastifyInstance, svc: SupplyService, price?: MarketPriceSource): void {
  const unavailable = (reply: FastifyReply, err: unknown, plain: boolean) => {
    reply.code(503).header("cache-control", "no-store").header("retry-after", "60");
    const msg = `supply unavailable: the chain could not be read (${(err as Error)?.message ?? String(err)})`;
    return plain ? reply.type("text/plain; charset=utf-8").send(msg) : reply.send({ error: msg, code: "chain_unavailable" });
  };

  app.get("/api/supply", async (_req, reply) => {
    try {
      const s = await svc.snapshot();
      reply.header("cache-control", "public, max-age=60");
      return s;
    } catch (err) {
      return unavailable(reply, err, false);
    }
  });

  const plain = (path: string, pick: (s: SupplySnapshot) => bigint, key: "totalSupply" | "circulatingSupply" | "maxSupply") => {
    app.get<{ Querystring: { format?: string } }>(path, async (req, reply) => {
      const asJson = req.query.format === "json";
      if (req.query.format !== undefined && !asJson && req.query.format !== "text") return reply.code(400).send({ error: "format must be text (default) or json", code: "bad_format" });
      try {
        const s = await svc.snapshot();
        reply.header("cache-control", "public, max-age=60");
        const wei = pick(s);
        if (asJson) return { [key]: fmxString(wei), wei: wei.toString(), symbol: "FMX", decimals: 18, asOfBlock: s.asOfBlock, definition: key === "totalSupply" ? SUPPLY_DEFINITIONS.total : key === "circulatingSupply" ? SUPPLY_DEFINITIONS.circulating : SUPPLY_DEFINITIONS.max, breakdown: "/api/supply", ...(s.stale ? { stale: true } : {}) };
        return reply.type("text/plain; charset=utf-8").send(plainNumber(wei));
      } catch (err) {
        return unavailable(reply, err, !asJson);
      }
    });
  };
  plain("/api/supply/total", (s) => BigInt(s.wei.total), "totalSupply");
  plain("/api/supply/circulating", (s) => BigInt(s.wei.circulating), "circulatingSupply");
  plain("/api/supply/max", (s) => BigInt(s.wei.max), "maxSupply");

  // CoinGecko's /coins/{id} shape, filled with Ferminux's own numbers, for the explorer's market source.
  app.get<{ Params: { id: string } }>("/api/market/coingecko/coins/:id", async (req, reply) => {
    if (req.params.id !== CG_COIN_ID) return reply.code(404).send({ error: "coin not found" });
    let s: SupplySnapshot;
    try {
      s = await svc.snapshot();
    } catch (err) {
      return unavailable(reply, err, false);
    }
    const m = price ? await price.market().catch(() => null) : null;
    const circ = BigInt(s.wei.circulating);
    reply.header("cache-control", "public, max-age=60");
    return {
      id: CG_COIN_ID,
      symbol: "fmx",
      name: "Ferminux",
      image: { thumb: LOGO, small: LOGO, large: "https://ferminux.net/assets/brand/fmx-512.png" },
      market_data: {
        current_price: m ? { usd: priceNumber(m.priceE18) } : {},
        market_cap: m ? { usd: usd(m.priceE18, circ) } : {},
        total_volume: {},
        total_supply: Number(s.totalSupply),
        circulating_supply: Number(s.circulatingSupply),
        max_supply: Number(s.maxSupply),
        last_updated: new Date((m?.at ?? s.computedAt) as number).toISOString(),
      },
      ferminux: {
        note: "Served by the Ferminux gateway in CoinGecko's response shape; not CoinGecko data. Price: the deepest Ferminux DEX pool (PancakeSwap wFMX only when chain 3961 cannot be read). Supply: GET /api/supply.",
        priceVenue: m?.venue ?? null,
        dex: FERMINUX_DEX.url,
        asOfBlock: s.asOfBlock,
        ...(s.stale ? { stale: true } : {}),
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/market/coingecko/coins/:id/market_chart", async (req, reply) => {
    if (req.params.id !== CG_COIN_ID) return reply.code(404).send({ error: "coin not found" });
    reply.header("cache-control", "public, max-age=300");
    return { prices: [], market_caps: [], total_volumes: [] };
  });
}
