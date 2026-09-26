// Multi-asset, multi-chain → FMX pay-in. Quote: operator-fixed USD price per FMX (PAYIN_PRICE_USD; the
// Ferminux DEX pool only as a fallback), 2 % spread, 15-minute validity, deposit to the treasury hot wallet on any of 7
// EVM chains (Ethereum, BNB Chain, Base, Arbitrum One, Polygon, Optimism, Avalanche C-Chain). Assets per
// chain: USDC + USDT (ERC-20, 1 USD) and the chain's native coin (ETH / BNB / POL / AVAX), priced from
// CoinGecko (cached 60 s) with a PancakeSwap V2 (BSC) fallback for BNB/ETH when CoinGecko is unreachable;
// POL/AVAX have no fallback and the quote answers 503 if CoinGecko is down. Watcher: one poll loop shared
// across all enabled chains; every tick scans ERC-20 Transfer logs to the deposit address for both stables
// and, while a native quote is open, each new block's transactions to the deposit address; after the chain's
// required confirmations sends `fmxOut` on 3961 from PAYIN_HOT_KEY to the address the payer named in the
// quote. Every open quote on a (chain, asset) carries a UNIQUE exact amount (dust is SUBTRACTED on collision,
// never added, so a quote never asks for more than the payer typed). A new quote supersedes the SAME
// payer's other still-open quotes on this (chain, asset) — never by recipient (`to`) alone, since the route
// is unauthenticated and an attacker naming a victim's address as `to` must not be able to invalidate the
// victim's real open quote. Attribution is amount-first and considers both 'quoted' and 'superseded' rows,
// so a deposit still lands correctly even on a quote that was superseded in the meantime; when a candidate
// declares a payer, only that exact sender may match it (an unknown sender never falls back to an arbitrary
// candidate). Payout to the FMX hot wallet reserves its nonce in the row before sending and recovers instead
// of resending after a crash between send and the 'paid' write. Disabled (503) without the key.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Contract, JsonRpcProvider, getAddress, id as topicId, zeroPadValue } from "ethers";
import { HttpError } from "../commons/context.js";
import { DEX_QUOTE_TOKENS, FERMINUX_DEX, FIXED_CONTRACTS } from "../constants.js";
import { getMeta, setMeta } from "../db.js";
import type { V3Context } from "./context.js";

export const PAYIN_SPREAD_BPS = 200n;
export const PAYIN_QUOTE_TTL_S = 15 * 60;
/** Per-quote bounds in USD equivalent (stables at 1 USD, native coins at the live price). */
export const PAYIN_MIN_USD = 1;
export const PAYIN_MAX_USD = 10_000;
export const PAYIN_PRICE_CACHE_MS = 60_000;
export const PAYIN_LOOKBACK_BLOCKS = 200;
export const PAYIN_CHUNK_BLOCKS = 2000;
/** Floor for the adaptive getLogs range: providers that cap a range get halved down to this, never below. */
export const PAYIN_MIN_CHUNK_BLOCKS = 50;
/** getLogs ranges per chain per tick, so a recovered or first-run scanner catches up in minutes, not hours. */
export const PAYIN_MAX_CHUNKS_PER_TICK = 5;
/** A chain is unavailable after this many failed scans in a row (≈1 min at the 20 s poll)… */
export const PAYIN_UNHEALTHY_AFTER_FAILS = 3;
/** …or when its last good scan is older than this (and older than 3 polls). */
export const PAYIN_STALE_S = 300;
/** First scan on a chain (no cursor yet) looks back far enough to cover every quote from the last 24 h. */
export const PAYIN_MAX_BACKFILL_S = 24 * 3600;
/** Rough block times (s) — only used to size the first-scan lookback, where overshooting is harmless. */
export const PAYIN_BLOCK_TIME_S: Record<string, number> = { eth: 12, bsc: 0.45, base: 2, arbitrum: 0.25, polygon: 2, optimism: 2, avalanche: 2 };
/** Native-coin detection fetches full blocks; cap per tick so a backlog cannot stall the watcher. */
export const PAYIN_NATIVE_BLOCKS_PER_TICK = 60;
/** The two PancakeSwap reads behind the ETH fallback price must agree within this, else it is refused (manipulation guard). */
export const PAYIN_ETH_XCHECK_BPS = 500n;
/** Timeout for the CoinGecko price call. */
export const PAYIN_HTTP_TIMEOUT_MS = 5000;
/** A failed market read (Ferminux DEX, PancakeSwap pool) is remembered this long. GET /api/payin/market is public:
 *  without it every request during an RPC outage re-read every pool, each call waiting out the RPC's timeout. */
export const PAYIN_MARKET_ERROR_CACHE_MS = 15_000;
const E18 = 10n ** 18n;

// ---- PancakeSwap V2 pools on BSC — fallback native-coin price source when CoinGecko is unreachable (BNB/ETH only) ----
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BSC_ETH = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8"; // Binance-peg ETH
const WBNB_USDT_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // WBNB/USDT — 50k WBNB / 40M USDT
const ETH_WBNB_PAIR = "0x74E4716E431f45807DCF19f284c7aA99F18a4fbc"; // ETH/WBNB — 626 ETH / 2.16k WBNB (most liquid ETH V2 pool)
const ETH_USDT_PAIR = "0x531FEbfeb9a61D948c384ACFBe6dCc51057AEa7e"; // ETH/USDT — 159 ETH / 442k USDT (cross-check)
const TRANSFER_TOPIC = topicId("Transfer(address,address,uint256)");
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,matic-network,avalanche-2&vs_currencies=usd";
const COINGECKO_IDS: Record<NativeSymbol, string> = { ETH: "ethereum", BNB: "binancecoin", POL: "matic-network", AVAX: "avalanche-2" };

export type NativeSymbol = "ETH" | "BNB" | "POL" | "AVAX";
export type PayinAsset = "USDC" | "USDT" | NativeSymbol;
export interface PayinAssetInfo { kind: "erc20" | "native"; address: string | null; decimals: number; stable: boolean }

/** 7 EVM chains, verified token addresses/decimals (cast call symbol()/decimals() against each chain's public RPC, 2026-09-22). */
export const PAYIN_CHAINS = {
  eth: {
    chainId: 1, name: "Ethereum", explorer: "https://etherscan.io", native: "ETH" as PayinAsset, confirmations: 6,
    assets: {
      USDC: { kind: "erc20", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, stable: true },
      USDT: { kind: "erc20", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, stable: true },
      ETH: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
  bsc: {
    chainId: 56, name: "BNB Smart Chain", explorer: "https://bscscan.com", native: "BNB" as PayinAsset, confirmations: 12,
    assets: {
      USDC: { kind: "erc20", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, stable: true },
      USDT: { kind: "erc20", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, stable: true },
      BNB: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
  base: {
    chainId: 8453, name: "Base", explorer: "https://basescan.org", native: "ETH" as PayinAsset, confirmations: 20,
    assets: {
      USDC: { kind: "erc20", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, stable: true },
      USDT: { kind: "erc20", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, stable: true },
      ETH: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
  arbitrum: {
    chainId: 42161, name: "Arbitrum One", explorer: "https://arbiscan.io", native: "ETH" as PayinAsset, confirmations: 20,
    assets: {
      USDC: { kind: "erc20", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, stable: true },
      USDT: { kind: "erc20", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, stable: true },
      ETH: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
  polygon: {
    chainId: 137, name: "Polygon", explorer: "https://polygonscan.com", native: "POL" as PayinAsset, confirmations: 60,
    assets: {
      USDC: { kind: "erc20", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, stable: true },
      USDT: { kind: "erc20", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, stable: true },
      POL: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
  optimism: {
    chainId: 10, name: "Optimism", explorer: "https://optimistic.etherscan.io", native: "ETH" as PayinAsset, confirmations: 20,
    assets: {
      USDC: { kind: "erc20", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, stable: true },
      USDT: { kind: "erc20", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, stable: true },
      ETH: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
  avalanche: {
    chainId: 43114, name: "Avalanche C-Chain", explorer: "https://snowtrace.io", native: "AVAX" as PayinAsset, confirmations: 6,
    assets: {
      USDC: { kind: "erc20", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, stable: true },
      USDT: { kind: "erc20", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, stable: true },
      AVAX: { kind: "native", address: null, decimals: 18, stable: false },
    } as Record<string, PayinAssetInfo>,
  },
} as const;
export type PayinChain = keyof typeof PAYIN_CHAINS;
export const PAYIN_CHAIN_SLUGS = Object.keys(PAYIN_CHAINS) as PayinChain[];
export const PAYIN_ASSETS: PayinAsset[] = ["USDC", "USDT", "ETH", "BNB", "POL", "AVAX"];

const PAIR_ABI = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() view returns (address)", "function token1() view returns (address)"];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

export interface PayinRow {
  quoteId: string;
  chain: PayinChain;
  /** legacy (v1) columns: USD value with ≤ 6 decimals and its 6-decimal units */
  usdc: string;
  usdcUnits: string;
  asset: PayinAsset;
  amount: string | null;
  /** exact token units (wei for 18-dec assets) the payer must send — includes dust */
  amountUnits: string | null;
  usd: string | null;
  fmxOut: string;
  priceUsdPerFmx: string;
  target: string;
  payer: string | null;
  depositAddress: string;
  status: "quoted" | "seen" | "confirmed" | "paid" | "expired" | "failed" | "superseded";
  txHashIn: string | null;
  blockIn: number | null;
  confirmations: number;
  txHashOut: string | null;
  /** hot-wallet nonce reserved for the payout tx before it is sent (crash-safe: see PayinWatcher.payout) */
  payoutNonce: number | null;
  error: string | null;
  createdAt: number;
  expiresAt: number;
  seenAt: number | null;
  paidAt: number | null;
}

/* ============================================================== pure quote math (unit-tested) */

export function parseDecimalE(v: string, decimals: number): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + (frac ? BigInt(frac.padEnd(decimals, "0")) : 0n);
}

/** Exact decimal string for `units` at `decimals` (trailing zeros trimmed, at least one fractional digit). */
export function formatUnits(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = units / d;
  const frac = (units % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${frac || "0"}`;
}
export const fmt18 = (v: bigint): string => formatUnits(v, 18);

/** Amount as typed by the user → exact token units. Throws 400 with a human message. */
export function parseAmount(v: unknown, asset: PayinAsset, decimals: number): { units: bigint; text: string } {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  const units = parseDecimalE(s, decimals);
  if (units === null || units <= 0n) throw new HttpError(400, `amount must be a positive decimal ${asset} amount like "10.00" (≤ ${decimals} decimals)`);
  return { units, text: formatUnits(units, decimals) };
}

/** USD value (1e18) of `units` of an asset priced at `assetUsdE18` per whole unit. */
export function usdValueE18(units: bigint, decimals: number, assetUsdE18: bigint): bigint {
  return (units * assetUsdE18) / 10n ** BigInt(decimals);
}

/** fmxOut (wei) = usd × (1 − spread) / priceUsdPerFmx. */
export function fmxOutFor(usdE18: bigint, fmxPriceE18: bigint, spreadBps: bigint = PAYIN_SPREAD_BPS): bigint {
  if (fmxPriceE18 <= 0n) throw new Error("bad FMX price");
  return (usdE18 * E18 * (10_000n - spreadBps)) / (10_000n * fmxPriceE18);
}

/**
 * The exact unit amount to quote for `wanted`, unique against every open quote on the same (chain, asset).
 * Steps DOWN (wanted − 1, − 2, …) never up: a quote must never ask for more than the payer typed, or a
 * wallet whose exact balance equals `wanted` reverts the transfer (verified 2026-09-22: a payer with exactly
 * 5.0 USDT got a dust-added quote for 5.000000000000000003 and the transfer failed). Only when every unit
 * down to 1 is already taken (practically impossible — it would mean thousands of simultaneous open quotes
 * for the same amount) does this fall back to stepping up, so it still always returns a positive amount.
 */
export function pickUniqueUnits(wanted: bigint, taken: Iterable<string>): bigint {
  const set = new Set<string>();
  for (const t of taken) set.add(BigInt(t).toString());
  if (!set.has(wanted.toString())) return wanted;
  let down = wanted - 1n;
  while (down > 0n && set.has(down.toString())) down -= 1n;
  if (down > 0n) return down;
  let up = wanted + 1n; // exhausted every unit down to 1 — fall back so we still return something positive
  while (set.has(up.toString())) up += 1n;
  return up;
}

export function checkUsdBounds(usdE18: bigint): void {
  const usd = Number(usdE18) / 1e18;
  if (usd < PAYIN_MIN_USD || usd > PAYIN_MAX_USD) throw new HttpError(400, `amount must be worth between ${PAYIN_MIN_USD} and ${PAYIN_MAX_USD} USD (this is ≈ ${usd.toFixed(2)} USD)`);
}

function envPriceE18(v: string | undefined): bigint | null {
  if (!v || !/^\d+(\.\d{1,18})?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  return BigInt(w) * E18 + BigInt(f.padEnd(18, "0"));
}

/* ============================================================== price feed */

export interface PriceFeedOptions {
  fixedPriceUsd?: string;
  minPriceUsd?: string;
  now?: () => number;
  /** chain-3961 RPC for the Ferminux DEX reads (the gateway's RPC_URL); default the public endpoint */
  ferminuxRpcUrl?: string;
  /** the bridge relayer's liveness report (BRIDGE_STATUS_URL); default https://ferminux.net/bridge/status.json */
  bridgeStatusUrl?: string;
}

/** The PancakeSwap wFMX pair's raw state: reserves, the quote side's token, and the pool's own last-update time. */
export interface PoolReserves { reserveW: bigint; reserveQ: bigint; quoteDecimals: number; quoteSymbol: string; lastTradeAt: number }

/** An FMX market as a pool shows it: spot USD per FMX, the pool's depth, and when it was read. No floor. */
export interface MarketPrice {
  /** USD per FMX, 1e18, from the reserves (spot: a trade of any size moves it) */
  priceE18: bigint;
  /** both sides of the pool in USD, 1e18 — how much can actually trade near that price */
  liquidityUsdE18: bigint;
  wfmxReserveE18: bigint;
  /** unix s of the pool's last reserve update (its last swap or liquidity change) */
  lastTradeAt: number;
  /** ms, when this was read */
  at: number;
}

/** One WFMX pool on the Ferminux DEX against a first-party stablecoin, raw from the chain. */
export interface DexPoolReserves { pair: string; quoteToken: string; reserveW: bigint; reserveQ: bigint; lastTradeAt: number }

/** A Ferminux DEX pool priced: in its own quote token and in USD through that token's peg. */
export interface DexPool extends MarketPrice {
  pair: string;
  quoteSymbol: string;
  quoteToken: string;
  quoteDecimals: number;
  /** quote-token units in the pool (raw, `quoteDecimals`) */
  quoteReserve: bigint;
  /** quote token per FMX, 1e18 */
  priceInQuoteE18: bigint;
  /** USD per quote token, 1e18, and where that number comes from */
  usdPerQuoteE18: bigint;
  usdBasis: string;
}

/** Every priced FMX pool on the Ferminux DEX, deepest first; `pools[0]` is the market's reference price. */
export interface DexMarket { pools: DexPool[]; at: number }

/** Whether the wFMX bridge is moving anything, per the relayer's own report. Unknown counts as paused. */
export interface BridgeState { paused: boolean; reason: string | null; at: number }

export const PAYIN_MARKET_SOURCE = "PancakeSwap v2 wFMX/WBNB pool on BNB Chain (on-chain reserves)";
export const DEX_MARKET_SOURCE = (quoteSymbol: string) => `Ferminux DEX WFMX/${quoteSymbol} pool on chain 3961 (on-chain reserves)`;
/** A relayer report older than this is not trusted — the same rule as ferminux.net/security.html. */
export const BRIDGE_STATUS_MAX_AGE_MS = 10 * 60_000;
const DEX_FACTORY_ABI = ["function getPair(address, address) view returns (address)"];
const ZERO_ADDRESS = /^0x0{40}$/i;

/** The Ferminux DEX link that opens a swap from `quoteToken` into native FMX. */
export const dexSwapUrl = (quoteToken: string) => `${FERMINUX_DEX.url}/?inputCurrency=${quoteToken}&outputCurrency=FMX`;

/** Price a raw Ferminux DEX pool. Pure: unit-tested without a chain. */
export function priceDexPool(r: DexPoolReserves, at: number): DexPool | null {
  const q = DEX_QUOTE_TOKENS.find((t) => t.address.toLowerCase() === r.quoteToken.toLowerCase());
  if (!q || r.reserveW === 0n || r.reserveQ === 0n) return null;
  const scaleQ = 10n ** BigInt(q.decimals);
  // quote per FMX = (reserveQ / 10^decQ) / (reserveW / 10^18), ×1e18
  const priceInQuoteE18 = (r.reserveQ * E18 * E18) / (scaleQ * r.reserveW);
  const quoteSideUsdE18 = (r.reserveQ * q.usdE18) / scaleQ;
  return {
    pair: r.pair,
    quoteSymbol: q.symbol,
    quoteToken: q.address,
    quoteDecimals: q.decimals,
    quoteReserve: r.reserveQ,
    priceInQuoteE18,
    usdPerQuoteE18: q.usdE18,
    usdBasis: q.usdBasis,
    priceE18: (priceInQuoteE18 * q.usdE18) / E18,
    // an x·y=k pool holds equal value on both sides at its own price, so depth is twice the quote side
    liquidityUsdE18: 2n * quoteSideUsdE18,
    wfmxReserveE18: r.reserveW,
    lastTradeAt: r.lastTradeAt,
    at,
  };
}

/** The relayer report → paused or not. Mirrors ferminux.net/security.html: stale, empty or any chain with
 * signing paused means paused. Pure: unit-tested. */
export function bridgeStateFrom(report: unknown, nowMs: number): BridgeState {
  const s = (report ?? {}) as { generatedAt?: unknown; chains?: unknown };
  const at = Number(s.generatedAt) || 0;
  const chains = Array.isArray(s.chains) ? (s.chains as Array<{ name?: string; finality?: { signing?: { paused?: boolean; reason?: string | null } | null } | null }>) : [];
  if (!at || nowMs - at > BRIDGE_STATUS_MAX_AGE_MS) return { paused: true, reason: "the validators' status report is stale", at: nowMs };
  if (chains.length === 0) return { paused: true, reason: "the validators' status report lists no chains", at: nowMs };
  const off = chains.find((c) => c.finality?.signing?.paused);
  if (off) return { paused: true, reason: `validators are not signing on ${off.name ?? "a chain"}${off.finality?.signing?.reason ? ` (${off.finality.signing.reason})` : ""}`, at: nowMs };
  return { paused: false, reason: null, at: nowMs };
}

/** USD per FMX (operator-fixed, else the Ferminux DEX, else the PancakeSwap wFMX pair) and USD per native coin
 * (CoinGecko, cached 60 s, with a PancakeSwap V2 fallback for BNB/ETH), all 1e18 fixed-point. */
export class PriceFeed {
  private cache: { priceE18: bigint; quoteSymbol: string; at: number } | null = null;
  private marketCache: MarketPrice | null = null;
  private dexCache: DexMarket | null = null;
  private bridgeCache: BridgeState | null = null;
  private readonly reading = new Map<string, Promise<unknown>>();
  private readonly readFailed = new Map<string, { err: Error; at: number }>();
  private readonly native = new Map<NativeSymbol, { usdE18: bigint; at: number }>();
  private readonly provider: JsonRpcProvider;
  private readonly ferminux: JsonRpcProvider;
  private readonly bridgeStatusUrl: string;
  private readonly fixedE18: bigint | null;
  private readonly floorE18: bigint | null;
  private readonly now: () => number;
  constructor(bscRpcUrl: string, opts: PriceFeedOptions | (() => number) = {}) {
    const o = typeof opts === "function" ? { now: opts } : opts;
    this.now = o.now ?? (() => Date.now());
    this.fixedE18 = envPriceE18(o.fixedPriceUsd);
    this.floorE18 = envPriceE18(o.minPriceUsd);
    this.provider = new JsonRpcProvider(bscRpcUrl, { chainId: 56, name: "bnb" }, { staticNetwork: true });
    this.ferminux = new JsonRpcProvider(o.ferminuxRpcUrl ?? "https://rpc.ferminux.net", { chainId: 3961, name: "ferminux" }, { staticNetwork: true });
    this.bridgeStatusUrl = o.bridgeStatusUrl ?? "https://ferminux.net/bridge/status.json";
  }
  get fixed(): boolean {
    return this.fixedE18 !== null;
  }

  /** One read per key at a time (callers on a cold cache share it) and a failure remembered for
   *  PAYIN_MARKET_ERROR_CACHE_MS, so a burst of requests during an outage costs one read, not one each. */
  private shared<T>(key: string, read: () => Promise<T>): Promise<T> {
    const failed = this.readFailed.get(key);
    if (failed && this.now() - failed.at < PAYIN_MARKET_ERROR_CACHE_MS) return Promise.reject(failed.err);
    let p = this.reading.get(key) as Promise<T> | undefined;
    if (!p) {
      p = read()
        .then(
          (v) => { this.readFailed.delete(key); return v; },
          (err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err));
            this.readFailed.set(key, { err: e, at: this.now() });
            throw e;
          },
        )
        .finally(() => this.reading.delete(key));
      this.reading.set(key, p);
    }
    return p;
  }
  async price(): Promise<{ priceE18: bigint; quoteSymbol: string; at: number }> {
    // Operator-fixed USD price (PAYIN_PRICE_USD) wins. Unset, the quote follows the primary market — the Ferminux
    // DEX, falling back to the PancakeSwap wFMX pair only when chain 3961 cannot be read — under the
    // PAYIN_MIN_PRICE_USD floor. A pool's spot price moves with every trade, so a hot wallet holding 1M FMX should
    // run with the fixed price; the floor is the guard when it does not.
    if (this.fixedE18 !== null) return { priceE18: this.fixedE18, quoteSymbol: "USD", at: this.now() };
    if (this.cache && this.now() - this.cache.at < PAYIN_PRICE_CACHE_MS) return this.cache;
    const m = await this.market();
    let priceE18 = m.priceE18;
    if (this.floorE18 !== null && priceE18 < this.floorE18) priceE18 = this.floorE18; // PAYIN_MIN_PRICE_USD guard
    this.cache = { priceE18, quoteSymbol: "USD", at: this.now() };
    return this.cache;
  }

  /** The primary FMX market: the deepest priced pool on the Ferminux DEX; the PancakeSwap wFMX pair only when
   * chain 3961 cannot be read or has no priced pool. */
  async market(): Promise<MarketPrice & { venue: "ferminux-dex" | "pancakeswap" }> {
    try {
      const d = await this.dexMarket();
      return { ...d.pools[0]!, venue: "ferminux-dex" };
    } catch {
      return { ...(await this.pancakeMarket()), venue: "pancakeswap" };
    }
  }

  /** Every FMX pool on the Ferminux DEX priced against a first-party stablecoin, deepest first, cached 60 s. */
  async dexMarket(): Promise<DexMarket> {
    if (this.dexCache && this.now() - this.dexCache.at < PAYIN_PRICE_CACHE_MS) return this.dexCache;
    return this.shared("dex", async () => {
      const at = this.now();
      const pools = (await this.readDexPools()).map((r) => priceDexPool(r, at)).filter((p): p is DexPool => p !== null);
      if (pools.length === 0) throw new Error("no priced FMX pool on the Ferminux DEX");
      pools.sort((a, b) => (b.liquidityUsdE18 > a.liquidityUsdE18 ? 1 : b.liquidityUsdE18 < a.liquidityUsdE18 ? -1 : 0));
      this.dexCache = { pools, at };
      return this.dexCache;
    });
  }

  /** The WFMX pools against each first-party stablecoin, by factory lookup (never by walking the open pair list).
   * Protected (not private) so tests can stub it instead of hitting chain 3961. */
  protected async readDexPools(): Promise<DexPoolReserves[]> {
    const factory = new Contract(FERMINUX_DEX.factory, DEX_FACTORY_ABI, this.ferminux);
    const found = await Promise.all(DEX_QUOTE_TOKENS.map(async (q) => ({ q, pair: (await factory.getPair(FERMINUX_DEX.wfmx, q.address)) as string })));
    const out: DexPoolReserves[] = [];
    for (const { q, pair } of found) {
      if (ZERO_ADDRESS.test(pair)) continue;
      const c = new Contract(pair, PAIR_ABI, this.ferminux);
      const [t0, reserves] = await Promise.all([c.token0() as Promise<string>, c.getReserves() as Promise<[bigint, bigint, bigint]>]);
      const wIs0 = t0.toLowerCase() === FERMINUX_DEX.wfmx.toLowerCase();
      out.push({ pair: getAddress(pair), quoteToken: q.address, reserveW: wIs0 ? reserves[0] : reserves[1], reserveQ: wIs0 ? reserves[1] : reserves[0], lastTradeAt: Number(reserves[2]) });
    }
    return out;
  }

  /**
   * The wFMX pool on PancakeSwap (BNB Chain), in USD, cached 60 s: a secondary venue for the bridged wFMX,
   * published beside the Ferminux DEX price. It is a spot read of a thin pool, so it always travels with its depth
   * and read time, never as a price anyone can buy at in size.
   */
  async pancakeMarket(): Promise<MarketPrice> {
    if (this.marketCache && this.now() - this.marketCache.at < PAYIN_PRICE_CACHE_MS) return this.marketCache;
    return this.shared("pancake", () => this.readPancakeMarket());
  }

  private async readPancakeMarket(): Promise<MarketPrice> {
    const { reserveW, reserveQ, quoteDecimals, quoteSymbol, lastTradeAt } = await this.readPoolReserves();
    if (reserveW === 0n || reserveQ === 0n) throw new Error("empty pair");
    // price = (reserveQ / 10^decQ) / (reserveW / 10^18) → ×1e18; depth = both sides, i.e. 2 × the quote side
    let priceE18 = (reserveQ * E18 * E18) / (10n ** BigInt(quoteDecimals) * reserveW);
    let quoteSideUsdE18 = (reserveQ * E18) / 10n ** BigInt(quoteDecimals);
    if (/^WBNB$/i.test(quoteSymbol)) {
      // pair is quoted in WBNB → convert through the BNB price so the number is USD
      const bnbUsdE18 = await this.nativeUsd("BNB");
      priceE18 = (priceE18 * bnbUsdE18) / E18;
      quoteSideUsdE18 = (quoteSideUsdE18 * bnbUsdE18) / E18;
    } else if (!/^(USDT|USDC|BUSD|USD)$/i.test(quoteSymbol)) {
      throw new Error(`pancake pair is quoted in ${quoteSymbol}, not WBNB or a USD stable`);
    }
    this.marketCache = { priceE18, liquidityUsdE18: 2n * quoteSideUsdE18, wfmxReserveE18: reserveW, lastTradeAt, at: this.now() };
    return this.marketCache;
  }

  /** One read of the wFMX pair. Protected (not private) so tests can stub it instead of hitting BNB Chain. */
  protected async readPoolReserves(): Promise<PoolReserves> {
    const pair = new Contract(FIXED_CONTRACTS.pancakePair, PAIR_ABI, this.provider);
    const [t0, t1, reserves] = await Promise.all([pair.token0() as Promise<string>, pair.token1() as Promise<string>, pair.getReserves() as Promise<[bigint, bigint, bigint]>]);
    const wfmxIs0 = t0.toLowerCase() === FIXED_CONTRACTS.wfmx.toLowerCase();
    if (!wfmxIs0 && t1.toLowerCase() !== FIXED_CONTRACTS.wfmx.toLowerCase()) throw new Error("pancake pair does not contain wFMX");
    const quoteToken = wfmxIs0 ? t1 : t0;
    const erc = new Contract(quoteToken, ERC20_ABI, this.provider);
    // WBNB is known by address: a rate-limited symbol() read must never make a WBNB reserve count as dollars
    // (that would publish a market price ~600x too low beside the quote for the whole cache window)
    const isWbnb = quoteToken.toLowerCase() === WBNB.toLowerCase();
    const [decQ, symbol] = await Promise.all([erc.decimals() as Promise<bigint>, isWbnb ? Promise.resolve("WBNB") : (erc.symbol() as Promise<string>).catch(() => "USD")]);
    return {
      reserveW: wfmxIs0 ? reserves[0] : reserves[1],
      reserveQ: wfmxIs0 ? reserves[1] : reserves[0],
      quoteDecimals: Number(decQ),
      quoteSymbol: symbol,
      lastTradeAt: Number(reserves[2]),
    };
  }

  /** Is the wFMX bridge moving anything? From the relayer's report, cached 60 s; unreadable counts as paused. */
  async bridgeStatus(): Promise<BridgeState> {
    if (this.bridgeCache && this.now() - this.bridgeCache.at < PAYIN_PRICE_CACHE_MS) return this.bridgeCache;
    let state: BridgeState;
    try {
      state = bridgeStateFrom(await this.fetchBridgeStatus(), this.now());
    } catch (err) {
      state = { paused: true, reason: `the validators' status report could not be read (${(err as Error).message.slice(0, 80)})`, at: this.now() };
    }
    this.bridgeCache = state;
    return state;
  }

  /** Protected (not private) so tests can stub it instead of fetching. */
  protected async fetchBridgeStatus(): Promise<unknown> {
    const res = await fetch(this.bridgeStatusUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PAYIN_HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  }

  /** USD per whole asset unit, 1e18: stables are exactly 1; native coins from `nativeUsd`. */
  async assetUsd(asset: PayinAsset): Promise<bigint> {
    if (asset === "USDC" || asset === "USDT") return E18;
    return this.nativeUsd(asset as NativeSymbol);
  }

  /** CoinGecko (cached 60 s) first; BNB/ETH fall back to a PancakeSwap V2 read when CoinGecko is unreachable.
   * POL/AVAX have no fallback — the error from CoinGecko propagates (route answers 503). */
  async nativeUsd(asset: NativeSymbol): Promise<bigint> {
    const hit = this.native.get(asset);
    if (hit && this.now() - hit.at < PAYIN_PRICE_CACHE_MS) return hit.usdE18;
    try {
      return await this.readCoingeckoUsd(asset);
    } catch (err) {
      let usdE18: bigint;
      if (asset === "BNB") usdE18 = await this.readBnbUsd();
      else if (asset === "ETH") usdE18 = await this.readEthUsd();
      else throw new Error(`price unavailable for ${asset}: ${(err as Error).message}`);
      if (usdE18 <= 0n) throw new Error(`bad ${asset} price`);
      this.native.set(asset, { usdE18, at: this.now() });
      return usdE18;
    }
  }

  /** One call prices all four native coins; every result is cached so a later lookup in the same tick is free.
   * Protected (not private) so tests can stub it instead of hitting the network. */
  protected async fetchCoingecko(): Promise<Record<string, { usd?: number }>> {
    const res = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(PAYIN_HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`coingecko http ${res.status}`);
    return (await res.json()) as Record<string, { usd?: number }>;
  }

  private async readCoingeckoUsd(asset: NativeSymbol): Promise<bigint> {
    const data = await this.fetchCoingecko();
    let wanted: bigint | null = null;
    for (const [sym, id] of Object.entries(COINGECKO_IDS) as [NativeSymbol, string][]) {
      const price = data[id]?.usd;
      if (typeof price !== "number" || !(price > 0)) continue;
      const usdE18 = BigInt(Math.round(price * 1e6)) * 10n ** 12n;
      this.native.set(sym, { usdE18, at: this.now() });
      if (sym === asset) wanted = usdE18;
    }
    if (wanted === null) throw new Error(`coingecko missing a price for ${asset}`);
    return wanted;
  }

  /** price of token A in token B (both 18 decimals), 1e18, from a V2 pair's reserves. */
  protected async pairPrice(pair: string, tokenA: string): Promise<bigint> {
    const c = new Contract(pair, PAIR_ABI, this.provider);
    const [t0, reserves] = await Promise.all([c.token0() as Promise<string>, c.getReserves() as Promise<[bigint, bigint, bigint]>]);
    const aIs0 = t0.toLowerCase() === tokenA.toLowerCase();
    const rA = aIs0 ? reserves[0] : reserves[1];
    const rB = aIs0 ? reserves[1] : reserves[0];
    if (rA === 0n || rB === 0n) throw new Error(`empty pair ${pair}`);
    return (rB * E18) / rA;
  }
  protected async readBnbUsd(): Promise<bigint> {
    return this.pairPrice(WBNB_USDT_PAIR, WBNB); // USDT and WBNB are both 18-dec on BSC
  }
  protected async readEthUsd(): Promise<bigint> {
    // primary: ETH/WBNB (deepest V2 ETH pool) × WBNB/USDT; cross-check against ETH/USDT — refuse if they disagree.
    const [ethBnb, bnbUsd, ethUsdDirect] = await Promise.all([this.pairPrice(ETH_WBNB_PAIR, BSC_ETH), this.nativeUsd("BNB"), this.pairPrice(ETH_USDT_PAIR, BSC_ETH)]);
    const ethUsd = (ethBnb * bnbUsd) / E18;
    const diff = ethUsd > ethUsdDirect ? ethUsd - ethUsdDirect : ethUsdDirect - ethUsd;
    if (diff * 10_000n > ethUsdDirect * PAYIN_ETH_XCHECK_BPS) throw new Error(`ETH price sources disagree (${fmt18(ethUsd)} vs ${fmt18(ethUsdDirect)} USD)`);
    return ethUsd;
  }
  destroy() {
    this.provider.destroy();
    this.ferminux.destroy();
  }
}

/** Kept for callers of the v1 API (`usdc` field): 6-decimal USD units. */
export function parseUsdc(v: unknown): { units: bigint; text: string } {
  const { units, text } = parseAmount(v, "USDC", 6);
  return { units, text };
}

/* ============================================================== watcher */

/** The slice of an ethers provider the watcher uses; tests pass a fake. */
export interface PayinProviderLike {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address: string[]; topics: (string | null)[]; fromBlock: number; toBlock: number }): Promise<Array<{ address: string; topics: readonly string[]; data: string; transactionHash: string; index: number; blockNumber: number }>>;
  getBlock(n: number, prefetchTxs: true): Promise<{ number: number; prefetchedTransactions: Array<{ hash: string; from: string; to: string | null; value: bigint }> } | null>;
  getTransactionReceipt(hash: string): Promise<{ status: number | null } | null>;
  destroy(): void;
}

export interface PayinWatcherOptions { providerFor?: (chain: PayinChain) => PayinProviderLike }

/** Scanner health for one pay-in chain, as /api/status, /api/payin/assets and the quote route see it. */
export interface PayinChainHealth {
  ok: boolean;
  /** why the chain is not offered (null while ok): no completed scan yet, failing, or last good scan too old */
  reason: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** current getLogs range (halved while a provider refuses the range) */
  chunkBlocks: number;
  /** which of the configured RPC URLs is in use (0-based) and how many there are — never the URL itself */
  rpcIndex: number;
  rpcCount: number;
}

interface ChainState {
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  chunkBlocks: number;
  rpcIndex: number;
}

/** Idempotent: adds the payoutNonce column for DBs created before crash-safe payout existed. */
function ensurePayoutNonceColumn(db: V3Context["db"]): void {
  const cols = db.prepare("PRAGMA table_info(payins)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "payoutNonce")) db.exec("ALTER TABLE payins ADD COLUMN payoutNonce INTEGER");
}

/** "a,b , c" → ["a","b","c"] */
export function rpcList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((u) => u.trim()).filter(Boolean);
}

export class PayinWatcher {
  private readonly providers = new Map<PayinChain, PayinProviderLike>();
  private readonly state = new Map<PayinChain, ChainState>();
  constructor(private readonly ctx: V3Context, private readonly opts: PayinWatcherOptions = {}) {
    ensurePayoutNonceColumn(ctx.db);
    for (const chain of PAYIN_CHAIN_SLUGS) this.state.set(chain, { lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, chunkBlocks: PAYIN_CHUNK_BLOCKS, rpcIndex: 0 });
  }

  get enabled(): boolean {
    return !!this.ctx.payinHot;
  }
  depositAddress(chain: PayinChain): string | null {
    if (!this.ctx.payinHot) return null;
    return this.ctx.cfg.payinDeposits?.[chain] ?? this.ctx.payinHot.address;
  }
  private rpcUrls(chain: PayinChain): string[] {
    const list = rpcList(this.ctx.cfg.payinRpcUrls?.[chain]);
    return list.length ? list : ["http://127.0.0.1:1"];
  }
  private provider(chain: PayinChain): PayinProviderLike {
    let p = this.providers.get(chain);
    if (!p) {
      const urls = this.rpcUrls(chain);
      const rpcUrl = urls[this.state.get(chain)!.rpcIndex % urls.length]!;
      p = this.opts.providerFor?.(chain) ?? (new JsonRpcProvider(rpcUrl, { chainId: PAYIN_CHAINS[chain].chainId, name: chain }, { staticNetwork: true }) as unknown as PayinProviderLike);
      this.providers.set(chain, p);
    }
    return p;
  }
  /** After a failed scan, move to the next configured RPC URL (if there is more than one). */
  private rotateProvider(chain: PayinChain): void {
    if (this.opts.providerFor) return;
    const urls = this.rpcUrls(chain);
    if (urls.length < 2) return;
    const st = this.state.get(chain)!;
    st.rpcIndex = (st.rpcIndex + 1) % urls.length;
    this.providers.get(chain)?.destroy();
    this.providers.delete(chain);
  }

  /**
   * Is this chain's deposit scanner working? A chain is offered only while its scanner has COMPLETED a scan
   * recently (within PAYIN_STALE_S) and has not failed PAYIN_UNHEALTHY_AFTER_FAILS scans in a row since.
   * Anything else is unavailable: no quote is issued for it and /api/status turns degraded. That includes
   * a chain that has never completed a scan (a fresh boot refuses its quotes for the one poll it takes) and
   * a scanner that hangs without ever throwing — the rule used to be "presumed healthy until it fails",
   * which could not see either. The audit behind this (2026-09-24): three chains failed every 20 s poll for
   * days while the quote route, the asset list and /api/status all said "ok", so a buyer could pay and
   * never be credited.
   */
  chainHealth(chain: PayinChain): PayinChainHealth {
    const st = this.state.get(chain)!;
    const now = this.ctx.nowS();
    const staleS = Math.max(PAYIN_STALE_S, Math.ceil((3 * (this.ctx.cfg.payinPollMs || 20_000)) / 1000));
    const reason =
      st.lastOkAt === null ? (st.consecutiveFailures > 0 ? `deposit scanner has failed ${st.consecutiveFailures} scan(s) and never completed one` : "deposit scanner has not completed a scan yet")
      : st.consecutiveFailures >= PAYIN_UNHEALTHY_AFTER_FAILS ? `deposit scanner failed its last ${st.consecutiveFailures} scans`
      : now - st.lastOkAt > staleS ? `deposit scanner's last completed scan is ${now - st.lastOkAt} s old`
      : null;
    return {
      ok: reason === null,
      reason,
      lastOkAt: st.lastOkAt,
      lastErrorAt: st.lastErrorAt,
      lastError: st.lastError,
      consecutiveFailures: st.consecutiveFailures,
      chunkBlocks: st.chunkBlocks,
      rpcIndex: st.rpcIndex,
      rpcCount: this.opts.providerFor ? 1 : this.rpcUrls(chain).length,
    };
  }
  chainAvailable(chain: PayinChain): boolean {
    return this.enabled && this.chainHealth(chain).ok;
  }
  /** Every chain's scanner health (slug → health). */
  health(): Record<PayinChain, PayinChainHealth> {
    return Object.fromEntries(PAYIN_CHAIN_SLUGS.map((c) => [c, this.chainHealth(c)])) as Record<PayinChain, PayinChainHealth>;
  }

  /** Units an open quote on (chain, asset) already claims — used to pick a unique amount for a new one. */
  openUnits(chain: PayinChain, asset: PayinAsset): string[] {
    const t = this.ctx.nowS();
    return (this.ctx.db.prepare("SELECT amountUnits FROM payins WHERE chain = ? AND asset = ? AND status = 'quoted' AND expiresAt >= ? AND amountUnits IS NOT NULL").all(chain, asset, t - 600) as Array<{ amountUnits: string }>).map((r) => r.amountUnits);
  }

  /** One watcher pass: scan new Transfer logs + native transfers on every chain, pay out confirmed ones, expire stale quotes. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const db = this.ctx.db;
    const t = this.ctx.nowS();
    db.prepare("UPDATE payins SET status = 'expired' WHERE status = 'quoted' AND expiresAt < ?").run(t - 600);
    for (const chain of PAYIN_CHAIN_SLUGS) {
      const st = this.state.get(chain)!;
      try {
        await this.scan(chain);
        if (st.consecutiveFailures > 0) console.warn(`[payin] ${chain} scan recovered after ${st.consecutiveFailures} failed polls`);
        st.consecutiveFailures = 0;
        st.lastOkAt = this.ctx.nowS();
      } catch (err) {
        st.consecutiveFailures += 1;
        st.lastErrorAt = this.ctx.nowS();
        st.lastError = (err as Error).message.slice(0, 300);
        // one line on the first failure, then one every ~15 min — the old log line on every 20 s poll
        // (≈4,300 a day per dead chain) buried everything else in a json-file log capped at 100 MB
        if (st.consecutiveFailures === 1 || st.consecutiveFailures % 45 === 0) {
          console.error(`[payin] ${chain} scan failed (${st.consecutiveFailures} in a row):`, st.lastError);
        }
        this.rotateProvider(chain);
      }
    }
    await this.payout();
  }

  /** Attribute one deposit (ERC-20 log or native tx) to the oldest matching quote with the same exact amount.
   * Considers both 'quoted' and 'superseded' rows — superseding a quote (see the route below) is only a UX
   * nicety for retries and must never cause a real deposit to go unattributed. When a candidate declares a
   * payer, ONLY a transfer from that exact address may match it — there is no fallback to an arbitrary
   * candidate, so a deposit from an unknown sender is left unattributed rather than credited to the wrong
   * quote's recipient. Candidates with no declared payer remain matchable by amount alone. */
  private attribute(chain: PayinChain, asset: PayinAsset, units: bigint, fromAddr: string, txHash: string, logIndex: number, blockNumber: number, head: number): boolean {
    const db = this.ctx.db;
    const t = this.ctx.nowS();
    const already = db.prepare("SELECT quoteId FROM payin_transfers WHERE chain = ? AND txHash = ? AND logIndex = ?").get(chain, txHash, logIndex);
    if (already) return false;
    const candidates = db
      .prepare("SELECT quoteId, payer FROM payins WHERE chain = ? AND asset = ? AND status IN ('quoted', 'superseded') AND amountUnits = ? AND expiresAt >= ? ORDER BY createdAt ASC")
      .all(chain, asset, units.toString(), t - 600) as Array<{ quoteId: string; payer: string | null }>;
    const match = candidates.find((c) => c.payer && c.payer.toLowerCase() === fromAddr.toLowerCase()) ?? candidates.find((c) => !c.payer);
    db.prepare("INSERT OR IGNORE INTO payin_transfers (chain, txHash, logIndex, fromAddr, units, blockNumber, asset, quoteId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(chain, txHash, logIndex, fromAddr, units.toString(), blockNumber, asset, match?.quoteId ?? null, t);
    if (!match) {
      console.warn(`[payin] ${chain} ${asset} deposit ${txHash} from ${fromAddr} matched no open quote — recorded unattributed for manual review`);
      return false;
    }
    db.prepare("UPDATE payins SET status = 'seen', txHashIn = ?, blockIn = ?, payer = COALESCE(payer, ?), seenAt = ?, confirmations = ? WHERE quoteId = ?").run(txHash, blockNumber, fromAddr, t, Math.max(0, head - blockNumber + 1), match.quoteId);
    return true;
  }

  /** Where a chain's very first ERC-20 scan starts: far enough back to cover every quote on it from the last
   * 24 h. Without this a scanner that had never succeeded started at head−200 once fixed, and every deposit
   * made during the outage stayed invisible. Overshooting only costs a few extra getLogs ranges. */
  private firstScanFrom(chain: PayinChain, head: number): number {
    const t = this.ctx.nowS();
    const oldest = (this.ctx.db.prepare("SELECT MIN(createdAt) AS m FROM payins WHERE chain = ? AND createdAt >= ?").get(chain, t - PAYIN_MAX_BACKFILL_S) as { m: number | null }).m;
    let lookback = PAYIN_LOOKBACK_BLOCKS;
    if (oldest !== null && oldest !== undefined) {
      const secs = Math.min(Math.max(t - oldest, 0) + 600, PAYIN_MAX_BACKFILL_S);
      lookback = Math.max(lookback, Math.ceil(secs / (PAYIN_BLOCK_TIME_S[chain] ?? 2)));
    }
    return Math.max(head - lookback, 0);
  }

  private async scan(chain: PayinChain): Promise<void> {
    const db = this.ctx.db;
    const deposit = this.depositAddress(chain);
    if (!deposit) return;
    const provider = this.provider(chain);
    const head = await provider.getBlockNumber();
    const info = PAYIN_CHAINS[chain];
    const st = this.state.get(chain)!;
    const tokens = Object.entries(info.assets).filter(([, a]) => a.kind === "erc20") as Array<[PayinAsset, PayinAssetInfo]>;
    const assetByToken = new Map(tokens.map(([sym, a]) => [a.address!.toLowerCase(), sym]));
    // The ERC-20 and native scans are independent: a provider that refuses eth_getLogs (bsc-dataseed) must not
    // also blind the native-coin scan, which only needs full blocks. Both run; the first error is rethrown so
    // the chain's health still records the failure.
    let firstErr: unknown = null;

    // ---- ERC-20 stables: Transfer logs to the deposit address (both tokens in one filter) ----
    try {
      const metaKey = `payin:${chain}:lastBlock`;
      const stored = getMeta(db, metaKey);
      let last = stored !== undefined ? Number(stored) : this.firstScanFrom(chain, head);
      for (let i = 0; i < PAYIN_MAX_CHUNKS_PER_TICK && last < head; i++) {
        const from = last + 1;
        const to = Math.min(head, from + st.chunkBlocks - 1);
        let logs: Awaited<ReturnType<PayinProviderLike["getLogs"]>>;
        try {
          logs = await provider.getLogs({ address: tokens.map(([, a]) => a.address!), topics: [TRANSFER_TOPIC, null, zeroPadValue(deposit, 32)], fromBlock: from, toBlock: to });
        } catch (err) {
          // many public providers cap the range (10 / 50 / 500 / 10 000 blocks): halve it for the next try
          st.chunkBlocks = Math.max(PAYIN_MIN_CHUNK_BLOCKS, Math.floor(st.chunkBlocks / 2));
          throw err;
        }
        for (const log of logs) {
          const asset = assetByToken.get(log.address.toLowerCase());
          if (!asset || !log.topics[1]) continue;
          const fromAddr = getAddress("0x" + log.topics[1].slice(26));
          this.attribute(chain, asset, BigInt(log.data), fromAddr, log.transactionHash, log.index, log.blockNumber, head);
        }
        setMeta(db, metaKey, String(to));
        last = to;
      }
      if (stored === undefined && last >= head) setMeta(db, metaKey, String(head));
    } catch (err) {
      firstErr ??= err;
    }

    // ---- native coin: full blocks, only while a native quote is (or was, since the cursor last moved) open ----
    try {
      const nativeKey = `payin:${chain}:lastNativeBlock`;
      const nativeAtKey = `payin:${chain}:lastNativeAt`;
      const now = this.ctx.nowS();
      // A quote that was open at any point since the cursor last advanced keeps the scan going: after an
      // outage the cursor must not jump to head past a deposit made for a quote that expired meanwhile.
      const sinceS = Number(getMeta(db, nativeAtKey) ?? now);
      const openNative = (db.prepare("SELECT COUNT(*) AS c FROM payins WHERE chain = ? AND asset = ? AND status IN ('quoted', 'superseded', 'expired') AND expiresAt >= ?").get(chain, info.native, Math.min(sinceS, now) - 600) as { c: number }).c;
      const lastNative = Number(getMeta(db, nativeKey) ?? head - 1);
      if (openNative === 0) {
        setMeta(db, nativeKey, String(head));
        setMeta(db, nativeAtKey, String(now));
      } else {
        const nFrom = Math.min(lastNative + 1, head);
        const nTo = Math.min(head, nFrom + PAYIN_NATIVE_BLOCKS_PER_TICK - 1);
        const depositLc = deposit.toLowerCase();
        let scannedTo = nFrom - 1;
        for (let n = nFrom; n <= nTo; n += 5) {
          const batch = await Promise.all(Array.from({ length: Math.min(5, nTo - n + 1) }, (_, i) => provider.getBlock(n + i, true)));
          for (const block of batch) {
            if (!block) throw new Error(`block ${n} not available yet`);
            for (const tx of block.prefetchedTransactions) {
              if (!tx.to || tx.to.toLowerCase() !== depositLc || tx.value <= 0n) continue;
              const receipt = await provider.getTransactionReceipt(tx.hash).catch(() => null);
              if (receipt && receipt.status === 0) continue; // reverted (deposit address is a contract)
              this.attribute(chain, info.native, tx.value, getAddress(tx.from), tx.hash, -1, block.number, head);
            }
            scannedTo = Math.max(scannedTo, block.number);
          }
        }
        if (scannedTo >= nFrom) {
          setMeta(db, nativeKey, String(scannedTo));
          if (scannedTo >= head) setMeta(db, nativeAtKey, String(now));
        }
      }
    } catch (err) {
      firstErr ??= err;
    }

    // ---- confirmations for seen rows on this chain (confirmation depth is chain-specific) ----
    const seen = db.prepare("SELECT quoteId, blockIn FROM payins WHERE chain = ? AND status = 'seen'").all(chain) as Array<{ quoteId: string; blockIn: number }>;
    for (const r of seen) {
      const conf = Math.max(0, head - r.blockIn + 1);
      db.prepare("UPDATE payins SET confirmations = ?, status = CASE WHEN ? >= ? THEN 'confirmed' ELSE status END WHERE quoteId = ?").run(conf, conf, info.confirmations, r.quoteId);
    }
    if (firstErr) throw firstErr;
  }

  /** Deposits recorded with no matching quote (paid too late, wrong amount, wrong sender) — each needs a manual refund or credit. */
  unattributedCount(sinceS: number): number {
    try {
      return (this.ctx.db.prepare("SELECT COUNT(*) AS c FROM payin_transfers WHERE quoteId IS NULL AND createdAt >= ?").get(sinceS) as { c: number }).c;
    } catch {
      return 0;
    }
  }

  /**
   * One payout per confirmed row, crash-safe exactly like ReferralPayout.transfer (gateway/src/commons/
   * referrals.ts): the hot wallet's nonce is reserved in the row (payoutNonce) BEFORE sending, and the send
   * uses that explicit nonce. If the process crashes between the send and the 'paid' write, the next tick
   * sees the reserved nonce: if the chain has already included it (this hot wallet is used by this worker
   * only, sequentially, so its nonce only ever advances from here) the transfer already happened and is
   * recorded as recovered, never resent; otherwise it is (re-)sent with that same nonce, which can never
   * double-pay.
   */
  private async payout(): Promise<void> {
    const hot = this.ctx.payinHot;
    if (!hot) return;
    const db = this.ctx.db;
    const rows = db.prepare("SELECT * FROM payins WHERE status = 'confirmed' ORDER BY seenAt ASC LIMIT 10").all() as PayinRow[];
    for (const r of rows) {
      try {
        const amount = BigInt(r.fmxOut);
        if (r.payoutNonce !== null && r.payoutNonce !== undefined) {
          const latest = await this.ctx.provider.getTransactionCount(hot.address, "latest");
          if (latest > r.payoutNonce) {
            const hash = `recovered:nonce:${r.payoutNonce}`;
            db.prepare("UPDATE payins SET status = 'paid', txHashOut = ?, paidAt = ?, error = NULL WHERE quoteId = ?").run(hash, this.ctx.nowS(), r.quoteId);
            this.ctx.activity.emit("payin.paid", { actor: r.target, ref: { kind: "payin", id: r.quoteId }, data: { quoteId: r.quoteId, chain: r.chain, asset: r.asset, amount: r.amount ?? r.usdc, usd: r.usd ?? r.usdc, usdc: r.usdc, fmxOut: r.fmxOut, to: r.target, tx: hash } });
            continue;
          }
        }
        const bal = await this.ctx.provider.getBalance(hot.address);
        if (bal < amount + 10n ** 16n) {
          db.prepare("UPDATE payins SET error = ? WHERE quoteId = ?").run(`hot wallet underfunded: ${fmt18(bal)} FMX < ${fmt18(amount)} FMX`, r.quoteId);
          console.error(`[payin] hot wallet ${hot.address} underfunded for quote ${r.quoteId}`);
          continue;
        }
        let nonce = r.payoutNonce;
        if (nonce === null || nonce === undefined) {
          nonce = await this.ctx.provider.getTransactionCount(hot.address, "pending");
          db.prepare("UPDATE payins SET payoutNonce = ? WHERE quoteId = ?").run(nonce, r.quoteId);
        }
        const tx = await hot.sendTransaction({ to: r.target, value: amount, nonce, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n });
        db.prepare("UPDATE payins SET status = 'paid', txHashOut = ?, paidAt = ?, error = NULL WHERE quoteId = ?").run(tx.hash, this.ctx.nowS(), r.quoteId);
        this.ctx.activity.emit("payin.paid", { actor: r.target, ref: { kind: "payin", id: r.quoteId }, data: { quoteId: r.quoteId, chain: r.chain, asset: r.asset, amount: r.amount ?? r.usdc, usd: r.usd ?? r.usdc, usdc: r.usdc, fmxOut: r.fmxOut, to: r.target, tx: tx.hash } });
      } catch (err) {
        db.prepare("UPDATE payins SET error = ? WHERE quoteId = ?").run((err as Error).message.slice(0, 200), r.quoteId);
      }
    }
  }

  start(intervalMs: number): () => void {
    if (!this.enabled) return () => undefined;
    let stopped = false;
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await this.tick();
      } catch (err) {
        console.error("[payin] tick failed:", err);
      } finally {
        running = false;
      }
    };
    const handle = setInterval(run, intervalMs);
    handle.unref?.();
    void run();
    return () => {
      stopped = true;
      clearInterval(handle);
      for (const p of this.providers.values()) p.destroy();
    };
  }
}

/** v1 rows (asset USDC, no amountUnits) get their exact units back-filled so the v2 matcher still sees them. */
export function backfillPayinUnits(db: V3Context["db"]): void {
  const rows = db.prepare("SELECT quoteId, chain, usdc, usdcUnits FROM payins WHERE amountUnits IS NULL").all() as Array<{ quoteId: string; chain: PayinChain; usdc: string; usdcUnits: string }>;
  const upd = db.prepare("UPDATE payins SET asset = 'USDC', amount = ?, amountUnits = ?, usd = ? WHERE quoteId = ?");
  for (const r of rows) {
    const dec = PAYIN_CHAINS[r.chain]?.assets.USDC?.decimals ?? 18;
    const units = BigInt(r.usdcUnits) * 10n ** BigInt(dec - 6);
    upd.run(r.usdc, units.toString(), r.usdc, r.quoteId);
  }
}

/* ============================================================== routes */

export const explorerTxUrl = (chain: PayinChain, hash: string) => `${PAYIN_CHAINS[chain].explorer}/tx/${hash}`;

export function statusView(row: PayinRow, enabled: boolean) {
  const info = PAYIN_CHAINS[row.chain];
  const a = info.assets[row.asset] ?? info.assets.USDC!;
  const units = row.amountUnits ?? (BigInt(row.usdcUnits) * 10n ** BigInt(Math.max(0, a.decimals - 6))).toString();
  return {
    ...row,
    amount: row.amount ?? row.usdc,
    amountUnits: units,
    sendExactly: units,
    sendExactlyFormatted: formatUnits(BigInt(units), a.decimals),
    usd: row.usd ?? row.usdc,
    chainId: info.chainId,
    assetKind: a.kind,
    token: a.address,
    decimals: a.decimals,
    fmxOutFormatted: fmt18(BigInt(row.fmxOut)),
    txHashes: {
      deposit: row.txHashIn ? { chain: row.chain, chainId: info.chainId, hash: row.txHashIn, url: explorerTxUrl(row.chain, row.txHashIn) } : null,
      fmx: row.txHashOut ? { chain: "ferminux", chainId: 3961, hash: row.txHashOut, url: `https://explorer.ferminux.net/tx/${row.txHashOut}` } : null,
    },
    required: info.confirmations,
    enabled,
    ...(enabled ? {} : { disabled: true, reason: "pay-in disabled" }),
  };
}

export function registerPayinRoutes(app: FastifyInstance, ctx: V3Context, watcher: PayinWatcher, feed: PriceFeed): void {
  const { db, commons } = ctx;
  backfillPayinUnits(db);

  app.get("/api/payin/assets", async () => ({
    enabled: watcher.enabled,
    priceUsdPerFmx: feed.fixed ? await feed.price().then((p) => fmt18(p.priceE18)).catch(() => null) : null,
    spreadBps: Number(PAYIN_SPREAD_BPS),
    minUsd: PAYIN_MIN_USD,
    maxUsd: PAYIN_MAX_USD,
    expires: PAYIN_QUOTE_TTL_S,
    chains: PAYIN_CHAIN_SLUGS.map((chain) => {
      const c = PAYIN_CHAINS[chain];
      const h = watcher.chainHealth(chain);
      const available = watcher.enabled && h.ok;
      return {
        chain, chainId: c.chainId, name: c.name, explorer: c.explorer, confirmations: c.confirmations, depositAddress: watcher.depositAddress(chain),
        assets: Object.entries(c.assets).map(([symbol, a]) => ({ symbol, kind: a.kind, token: a.address, decimals: a.decimals, stable: a.stable })),
        // a chain whose deposit scanner has not completed a recent scan takes no new quotes — pay-in UIs
        // must not offer it (ferminux.net/buy-fmx and ferminux.com list only `available` chains)
        available,
        lastScanAt: h.lastOkAt,
        ...(available || !watcher.enabled ? {} : { unavailableReason: `${h.reason ?? "deposit scanner is not reaching this chain right now"} — pay on another chain` }),
      };
    }),
    availableChains: watcher.enabled ? PAYIN_CHAIN_SLUGS.filter((c) => watcher.chainAvailable(c)) : [],
  }));

  // The market reference shown beside the quote. Its own route so a slow chain read never delays the asset list;
  // the pages render the quote first and add this line when (if) it answers. The top level is the PRIMARY market:
  // the deepest FMX pool on the Ferminux DEX (chain 3961). PancakeSwap's wFMX pool on BNB Chain rides along under
  // `secondary`, with the bridge's live state, and takes the top level only when chain 3961 cannot be read.
  app.get("/api/payin/market", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_req, reply) => {
    const [dex, pancake, bridge] = await Promise.allSettled([feed.dexMarket(), feed.pancakeMarket(), feed.bridgeStatus()]);
    const quote = feed.fixed ? await feed.price().then((p) => p.priceE18).catch(() => null) : null;
    // signed: + means the pay-in quote is above the primary market's spot price
    const gap = (m: MarketPrice) => (quote === null || m.priceE18 === 0n ? null : Number(((quote - m.priceE18) * 10_000n) / m.priceE18) / 100);
    const bridgeState: BridgeState = bridge.status === "fulfilled" ? bridge.value : { paused: true, reason: "the validators' status report could not be read", at: Date.now() };
    const pancakeView = (m: MarketPrice) => ({
      venue: "pancakeswap" as const,
      source: PAYIN_MARKET_SOURCE,
      chain: "bsc",
      chainId: 56,
      pair: FIXED_CONTRACTS.pancakePair,
      token: FIXED_CONTRACTS.wfmx,
      usdPerFmx: fmt18(m.priceE18),
      liquidityUsd: fmt18(m.liquidityUsdE18),
      wfmxReserve: fmt18(m.wfmxReserveE18),
      lastTradeAt: m.lastTradeAt,
      at: Math.floor(m.at / 1000),
      swapUrl: `https://pancakeswap.finance/swap?chain=bsc&outputCurrency=${FIXED_CONTRACTS.wfmx}`,
      // wFMX is native FMX only through the bridge: say whether it is moving, from the validators' own report
      bridgePaused: bridgeState.paused,
      bridgeReason: bridgeState.reason,
      bridgeStatusUrl: "https://ferminux.net/security.html#status",
    });
    const poolView = (p: DexPool) => ({
      pair: p.pair,
      quoteSymbol: p.quoteSymbol,
      quoteToken: p.quoteToken,
      quoteReserve: formatUnits(p.quoteReserve, p.quoteDecimals),
      priceInQuote: fmt18(p.priceInQuoteE18),
      usdPerQuote: fmt18(p.usdPerQuoteE18),
      usdBasis: p.usdBasis,
      usdPerFmx: fmt18(p.priceE18),
      liquidityUsd: fmt18(p.liquidityUsdE18),
      wfmxReserve: fmt18(p.wfmxReserveE18),
      lastTradeAt: p.lastTradeAt,
      swapUrl: dexSwapUrl(p.quoteToken),
      poolUrl: `https://explorer.ferminux.net/address/${p.pair}`,
    });

    if (dex.status === "fulfilled") {
      const top = dex.value.pools[0]!;
      return {
        ...poolView(top),
        source: DEX_MARKET_SOURCE(top.quoteSymbol),
        venue: "ferminux-dex",
        chain: "ferminux",
        chainId: 3961,
        token: FERMINUX_DEX.wfmx,
        dexUrl: FERMINUX_DEX.url,
        at: Math.floor(top.at / 1000),
        pools: dex.value.pools.map(poolView),
        quoteUsdPerFmx: quote === null ? null : fmt18(quote),
        quoteVsMarketPct: gap(top),
        note: `Spot price of the deepest FMX pool on the Ferminux DEX, read from its reserves: a trade of size moves it. USD is through ${top.quoteSymbol} (${top.usdBasis}). The pay-in quote is set by the operator, not read from this pool.`,
        secondary: pancake.status === "fulfilled" ? pancakeView(pancake.value) : null,
      };
    }
    if (pancake.status === "fulfilled") {
      // chain 3961 did not answer: the BNB Chain pool stands in, labelled as what it is
      return {
        ...pancakeView(pancake.value),
        quoteUsdPerFmx: quote === null ? null : fmt18(quote),
        quoteVsMarketPct: gap(pancake.value),
        note: "The Ferminux DEX could not be read just now, so this is the wFMX pool on BNB Chain: a thin pool whose price moves sharply with trade size. The pay-in quote is set by the operator, not read from it.",
        primaryError: `Ferminux DEX unreadable: ${(dex.reason as Error).message.slice(0, 120)}`,
        secondary: null,
      };
    }
    return reply.code(503).send({
      error: `market price unavailable: Ferminux DEX: ${(dex.reason as Error).message.slice(0, 100)}; PancakeSwap: ${(pancake.reason as Error).message.slice(0, 100)}`,
      source: "Ferminux DEX (chain 3961), then the PancakeSwap wFMX/WBNB pool (BNB Chain)",
    });
  });

  app.post("/api/payin/quote", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      if (!watcher.enabled) return reply.code(503).send({ disabled: true, reason: "pay-in disabled", error: "pay-in disabled (PAYIN_HOT_KEY unset)" });
      const body = commons.parseJson(req);
      const chain = String(body.chain ?? "") as PayinChain;
      if (!(chain in PAYIN_CHAINS)) throw new HttpError(400, `chain must be one of ${PAYIN_CHAIN_SLUGS.join("|")}`);
      const info = PAYIN_CHAINS[chain];
      // Never take money on a chain we cannot currently see: the deposit would sit unattributed in the hot
      // wallet until someone refunds it by hand.
      if (!watcher.chainAvailable(chain)) {
        const others = PAYIN_CHAIN_SLUGS.filter((c) => watcher.chainAvailable(c));
        const why = watcher.chainHealth(chain).reason ?? "its deposit scanner is failing";
        return reply.code(503).send({ error: `pay-in on ${info.name} is temporarily unavailable (${why}); pay on ${others.length ? others.join(", ") : "another chain later"}`, chain, unavailable: true, availableChains: others });
      }
      // v1 callers send {usdc}; v2 sends {asset, amount}
      const legacy = body.asset === undefined && body.amount === undefined && body.usdc !== undefined;
      const asset = (legacy ? "USDC" : String(body.asset ?? "USDC").toUpperCase()) as PayinAsset;
      const a = info.assets[asset];
      if (!a) throw new HttpError(400, `asset must be one of ${Object.keys(info.assets).join("|")} on ${info.name}`);
      const { units: wantedUnits } = parseAmount(legacy ? body.usdc : body.amount, asset, a.decimals);
      let target: string;
      try {
        target = getAddress(String(body.to ?? body.target ?? body.address));
      } catch {
        throw new HttpError(400, "to must be the 3961 address that receives FMX");
      }
      let payer: string | null = null;
      if (body.from !== undefined && body.from !== null && body.from !== "") {
        try {
          payer = getAddress(String(body.from));
        } catch {
          throw new HttpError(400, `from must be a 0x address (the wallet that will send ${asset})`);
        }
      }
      let price: { priceE18: bigint };
      let assetUsdE18: bigint;
      try {
        [price, assetUsdE18] = await Promise.all([feed.price(), feed.assetUsd(asset)]);
      } catch (err) {
        throw new HttpError(503, `price unavailable: ${(err as Error).message.slice(0, 120)}`);
      }
      checkUsdBounds(usdValueE18(wantedUnits, a.decimals, assetUsdE18));
      const t = ctx.nowS();
      // Supersede this SAME payer's own older OPEN quotes on this (chain, asset): a retry ("I fat-fingered
      // the amount", "let me try again") should free the exact amount it asked for instead of colliding with
      // itself and needing dust. Matching is strictly payer === payer — NEVER by recipient (`to`) alone: this
      // route is unauthenticated, so an attacker who only knows a victim's address could otherwise POST
      // {to: <victim>} and knock the victim's real open quote out of the open set right before their deposit
      // lands. (Even if a payer value is spoofed, this stays safe: attribute() above still matches a deposit
      // to a superseded quote by amount + payer, so superseding is a UX nicety, never a way to lose funds.)
      // Only 'quoted' rows are touched — once a deposit has been SEEN on chain for a quote it is left alone.
      if (payer) {
        db.prepare("UPDATE payins SET status = 'superseded', error = 'superseded by a newer quote from the same payer' WHERE chain = ? AND asset = ? AND status = 'quoted' AND expiresAt >= ? AND payer = ?").run(chain, asset, t - 600, payer);
      }
      // unique exact amount per open quote on this (chain, asset), stepping DOWN from what was asked (never
      // up — a quote must never ask for more than the payer typed, or an exact-balance transfer reverts).
      const units = pickUniqueUnits(wantedUnits, watcher.openUnits(chain, asset));
      const usdE18 = usdValueE18(units, a.decimals, assetUsdE18);
      const fmxOut = fmxOutFor(usdE18, price.priceE18);
      const usdText = formatUnits(usdE18, 18);
      const usd6 = usdE18 / 10n ** 12n; // legacy 6-decimal USD columns
      const quoteId = `q_${randomBytes(8).toString("hex")}`;
      const depositAddress = watcher.depositAddress(chain)!;
      const amountText = formatUnits(units, a.decimals);
      db.prepare(
        "INSERT INTO payins (quoteId, chain, usdc, usdcUnits, asset, amount, amountUnits, usd, fmxOut, priceUsdPerFmx, target, payer, depositAddress, status, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)",
      ).run(quoteId, chain, formatUnits(usd6, 6), usd6.toString(), asset, amountText, units.toString(), usdText, fmxOut.toString(), fmt18(price.priceE18), target, payer, depositAddress, t, t + PAYIN_QUOTE_TTL_S);
      const diff = wantedUnits - units; // > 0: quoted for less than asked (normal case) · < 0: rare upward fallback
      const dustDirection: "down" | "up" | "none" = diff > 0n ? "down" : diff < 0n ? "up" : "none";
      const dustUnits = (diff >= 0n ? diff : -diff).toString();
      return reply.code(201).send({
        quoteId, chain, chainId: info.chainId, chainName: info.name, asset, assetKind: a.kind, token: a.address, decimals: a.decimals,
        amount: amountText, amountRequested: formatUnits(wantedUnits, a.decimals), dustUnits, dustDirection,
        sendExactly: units.toString(), sendExactlyFormatted: amountText,
        usd: usdText, assetUsd: fmt18(assetUsdE18),
        depositAddress, fmxOut: fmxOut.toString(), fmxOutFormatted: fmt18(fmxOut), priceUsdPerFmx: fmt18(price.priceE18), spreadBps: Number(PAYIN_SPREAD_BPS), to: target, from: payer,
        expiresAt: t + PAYIN_QUOTE_TTL_S, expires: PAYIN_QUOTE_TTL_S, confirmations: info.confirmations, status: "quoted",
        explorer: info.explorer,
        // v1 fields (USDC callers)
        ...(asset === "USDC" ? { usdc: amountText, usdcToken: a.address, usdcDecimals: a.decimals } : {}),
        note: `Send exactly ${amountText} ${asset} on ${info.name} to ${depositAddress} before expiresAt${dustDirection === "down" ? ` (${dustUnits} units less than you asked for, so this exact amount is matched only to this quote)` : dustDirection === "up" ? ` (${dustUnits} units more than you asked for — every smaller unique amount was already taken)` : ""}; FMX is sent to ${target} after ${info.confirmations} confirmations. ${a.kind === "native" ? "Send from a normal wallet (EOA) — internal transfers from contracts are not detected. " : ""}Track at /api/payin/${quoteId}.`,
      });
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get<{ Params: { quoteId: string } }>("/api/payin/:quoteId", async (req, reply) => {
    const row = db.prepare("SELECT * FROM payins WHERE quoteId = ?").get(req.params.quoteId) as PayinRow | undefined;
    if (!row) return reply.code(404).send({ error: "quote not found" });
    return statusView(row, watcher.enabled);
  });
}
