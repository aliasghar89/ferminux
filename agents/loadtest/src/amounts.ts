// Amounts: how much each activated wallet is funded with, and how much it passes on.
//
// Funding (per wallet, from the float):
//   95 %  uniform in [0.01, 1] FMX
//    5 %  uniform in [1, 20] FMX     ("sometimes bigger")
// rounded down to 0.0001 FMX, then capped by the float's free headroom (MAX_FLOAT_IN_FLIGHT − what is out).
// Transfers (1–3 per wallet, to other wallets of the same wave): each takes 5–50 % of what is left of the
// wallet's budget = funding − a gas reserve for every transaction the wallet will still send (its transfers
// and its sweep, at twice today's price). The sweep then returns the whole balance, whatever was received.

/** A source of uniform numbers in [0, 1). Seedable, so tests and plans are reproducible. */
export type Rng = () => number;

/** sfc32: small, fast, well-distributed; not for secrets (it only picks amounts and recipients). */
export function makeRng(seed: number): Rng {
  let a = 0x9e3779b9 ^ seed, b = 0x243f6a88 ^ (seed * 31), c = 0xb7e15162 ^ (seed * 17), d = 1 ^ seed;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

export const WEI = 10n ** 18n;
/** Amount granularity: 0.0001 FMX, so amounts read cleanly on the explorer. */
export const GRANULE = 10n ** 14n;

export interface AmountConfig {
  smallMin: bigint;
  smallMax: bigint;
  largeMin: bigint;
  largeMax: bigint;
  /** Share of wallets funded from the large band (0.05). */
  largeShare: number;
  granule: bigint;
}

export const DEFAULT_AMOUNTS: AmountConfig = {
  smallMin: WEI / 100n, // 0.01
  smallMax: WEI, // 1
  largeMin: WEI, // 1
  largeMax: 20n * WEI, // 20
  largeShare: 0.05,
  granule: GRANULE,
};

/** Uniform in [lo, hi], on the granule grid (lo and hi are on the grid). */
export function uniformAmount(rng: Rng, lo: bigint, hi: bigint, granule: bigint): bigint {
  if (hi < lo) throw new Error("empty range");
  const steps = (hi - lo) / granule; // number of granules above lo
  // two draws: 53 bits is plenty for 200,000 steps, but stay exact for any range
  const r = BigInt(Math.floor(rng() * 2 ** 26)) * 2n ** 26n + BigInt(Math.floor(rng() * 2 ** 26));
  const k = (r * (steps + 1n)) / 2n ** 52n;
  return lo + k * granule;
}

/** One funding amount: small band 95 %, large band 5 %. */
export function sampleFunding(rng: Rng, cfg: AmountConfig = DEFAULT_AMOUNTS): bigint {
  const large = rng() < cfg.largeShare;
  return large ? uniformAmount(rng, cfg.largeMin, cfg.largeMax, cfg.granule) : uniformAmount(rng, cfg.smallMin, cfg.smallMax, cfg.granule);
}

/**
 * Cap a sampled amount by the float's free headroom. Returns null when the headroom cannot fund even the
 * smallest amount (the wave waits for sweeps to come back).
 */
export function capFunding(amount: bigint, headroom: bigint, cfg: AmountConfig = DEFAULT_AMOUNTS): bigint | null {
  if (headroom < cfg.smallMin) return null;
  if (amount <= headroom) return amount;
  const capped = (headroom / cfg.granule) * cfg.granule;
  return capped >= cfg.smallMin ? capped : null;
}

/** 1, 2 or 3 transfers. */
export function sampleTransferCount(rng: Rng): number {
  return 1 + Math.floor(rng() * 3);
}

/**
 * Plan a wallet's transfers. `reservePerTx` is the gas set aside for each transaction the wallet will send.
 * The planned total never exceeds funding − reservePerTx × (count + 1): the last "+1" is the sweep.
 * Amounts below one granule are dropped (the wallet then sends fewer transfers).
 */
export function planTransfers(rng: Rng, funded: bigint, reservePerTx: bigint, count: number, granule: bigint = GRANULE): bigint[] {
  let budget = funded - reservePerTx * BigInt(count + 1);
  const out: bigint[] = [];
  for (let j = 0; j < count && budget > 0n; j++) {
    const frac = 0.05 + rng() * 0.45; // 5–50 % of what is left
    const raw = (budget * BigInt(Math.floor(frac * 1e6))) / 1_000_000n;
    const amt = (raw / granule) * granule;
    if (amt < granule) break;
    out.push(amt);
    budget -= amt;
  }
  return out;
}

/** Pick `k` recipients for `from` among `pool` (never `from`); `fallback` when the pool has nobody else. */
export function pickRecipients(rng: Rng, from: number, pool: number[], k: number, fallback: number): number[] {
  const others = pool.filter((i) => i !== from);
  const out: number[] = [];
  for (let j = 0; j < k; j++) out.push(others.length ? others[Math.floor(rng() * others.length)] : fallback);
  return out;
}

/** "0.0123" style FMX for logs and stats (never used for math). */
export function fmx(wei: bigint, dp = 4): string {
  const neg = wei < 0n;
  const w = neg ? -wei : wei;
  const i = w / WEI;
  const f = (w % WEI).toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}

/** Parse "1.5" FMX (config) into wei, exactly. */
export function parseFmx(s: string): bigint {
  const m = /^\s*(\d+)(?:\.(\d{1,18}))?\s*$/.exec(s);
  if (!m) throw new Error(`not an FMX amount: ${JSON.stringify(s)}`);
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}
