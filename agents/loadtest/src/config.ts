// Configuration from the environment. Every knob has a safe default; the service starts in DRY-RUN
// (plans and logs, sends nothing) unless LOADTEST_ENABLED=true.
import { getAddress, isAddress } from "ethers";
import { join } from "node:path";
import { parseFmx, type AmountConfig, DEFAULT_AMOUNTS } from "./amounts.js";

export const WIZRD_MAIN = "0xD7175A244a3Eab83f574135318d037Fb6221C358";

export interface Config {
  enabled: boolean;
  drainEnv: boolean;
  rpcUrl: string;
  chainId: number;
  /** gateway /api/status (signer fallback); "" = none */
  statusUrl: string;
  /** explorer index API base (…/api/v2); "" = explorer guard off */
  explorerApi: string;
  sink: string;
  wallets: number;
  rate: number;
  waveSize: number;
  maxActiveWaves: number;
  tipWei: bigint;
  maxInFlightWei: bigint;
  floatReserveWei: bigint;
  floatMinWei: bigint;
  sinkSweepIntervalS: number;
  sinkSweepMinWei: bigint;
  loop: boolean;
  amounts: AmountConfig;
  guardIntervalS: number;
  maxHeadAgeS: number;
  minSigners: number;
  maxTxpoolPending: number;
  maxExplorerLag: number;
  /** how often the explorer index's totals are read, to pair each recount with our count (Runner.readIndex) */
  indexReadIntervalS: number;
  /** count organic transactions by walking the chain (organic.ts) */
  organicWalk: boolean;
  /** the walk stays this many blocks behind the head (short forks) */
  organicConfirmations: number;
  /** "rpc" = clique_status on RPC_URL, then the gateway; "gateway" = gateway only; "off" = tests only */
  signerSource: "auto" | "rpc" | "gateway" | "off";
  receiptTimeoutS: number;
  stuckAfterS: number;
  finalSweepBatch: number;
  dataDir: string;
  publicDir: string;
  seedFile: string;
  publishIntervalS: number;
  tickMs: number;
  publicUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

type Env = Record<string, string | undefined>;

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v.trim()));
function num(env: Env, k: string, d: number, lo: number, hi: number): number {
  const raw = env[k];
  if (raw === undefined || raw === "") return d;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k}=${raw}: expected a number in [${lo}, ${hi}]`);
  return n;
}
const fmxEnv = (env: Env, k: string, d: string) => parseFmx(env[k] && env[k] !== "" ? env[k]! : d);

export function loadConfig(env: Env = process.env): Config {
  const sinkRaw = env.SINK ?? WIZRD_MAIN;
  if (!isAddress(sinkRaw)) throw new Error(`SINK=${sinkRaw}: not an address`);
  // Two tx/s by default. A higher rate needs LOADTEST_ALLOW_HIGH_RATE=1 (the anvil integration run uses it):
  // the signer set is small and the load must never threaten liveness.
  const allowHigh = bool(env.LOADTEST_ALLOW_HIGH_RATE, false);
  const rate = num(env, "RATE_TX_PER_S", 2, 0.01, allowHigh ? 500 : 10);
  const dataDir = env.DATA_DIR || "/data";
  const small = { min: fmxEnv(env, "AMOUNT_SMALL_MIN_FMX", "0.01"), max: fmxEnv(env, "AMOUNT_SMALL_MAX_FMX", "1") };
  const large = { min: fmxEnv(env, "AMOUNT_LARGE_MIN_FMX", "1"), max: fmxEnv(env, "AMOUNT_LARGE_MAX_FMX", "20") };
  if (small.max < small.min || large.max < large.min) throw new Error("AMOUNT_*: max below min");
  const maxInFlightWei = fmxEnv(env, "MAX_FLOAT_IN_FLIGHT_FMX", "50");
  const cfg: Config = {
    enabled: bool(env.LOADTEST_ENABLED, false),
    drainEnv: bool(env.LOADTEST_DRAIN, false),
    rpcUrl: env.RPC_URL || "http://rpc1:8545",
    chainId: num(env, "CHAIN_ID", 3961, 1, 2 ** 32),
    statusUrl: env.STATUS_URL ?? "http://agents:8790/api/status",
    explorerApi: (env.EXPLORER_API ?? "https://explorer.ferminux.net/api/v2").replace(/\/+$/, "").replace(/^off$/i, ""),
    sink: getAddress(sinkRaw),
    wallets: num(env, "WALLETS", 100_000, 2, 2 ** 31 - 1),
    rate,
    waveSize: num(env, "WAVE_SIZE", 25, 1, 1000),
    maxActiveWaves: num(env, "MAX_ACTIVE_WAVES", 4, 1, 64),
    // the signers take nothing below a 1 gwei tip: a lower one would sit in the pool forever
    tipWei: BigInt(Math.round(num(env, "TIP_GWEI", 1, 1, 1000) * 1e9)),
    maxInFlightWei,
    floatReserveWei: fmxEnv(env, "FLOAT_RESERVE_FMX", "60"),
    floatMinWei: fmxEnv(env, "FLOAT_MIN_FMX", "1"),
    sinkSweepIntervalS: num(env, "SINK_SWEEP_INTERVAL_S", 3600, 1, 30 * 86400),
    sinkSweepMinWei: fmxEnv(env, "SINK_SWEEP_MIN_FMX", "1"),
    loop: bool(env.LOOP, true),
    amounts: {
      ...DEFAULT_AMOUNTS,
      smallMin: small.min, smallMax: small.max, largeMin: large.min, largeMax: large.max,
      largeShare: num(env, "AMOUNT_LARGE_SHARE", 0.05, 0, 1),
    },
    guardIntervalS: num(env, "GUARD_INTERVAL_S", 10, 1, 3600),
    maxHeadAgeS: num(env, "MAX_HEAD_AGE_S", 30, 1, 3600),
    minSigners: num(env, "MIN_SIGNERS", 3, 1, 100),
    maxTxpoolPending: num(env, "MAX_TXPOOL_PENDING", 2000, 1, 1e7),
    maxExplorerLag: num(env, "MAX_EXPLORER_LAG_BLOCKS", 100, 1, 1e7),
    indexReadIntervalS: num(env, "INDEX_READ_INTERVAL_S", 5, 1, 3600),
    organicWalk: bool(env.ORGANIC_WALK, true),
    organicConfirmations: num(env, "ORGANIC_CONFIRMATIONS", 12, 0, 1000),
    signerSource: ((): Config["signerSource"] => {
      const s = (env.SIGNER_SOURCE || "auto").toLowerCase();
      if (s !== "auto" && s !== "rpc" && s !== "gateway" && s !== "off") throw new Error(`SIGNER_SOURCE=${s}: auto | rpc | gateway | off`);
      return s;
    })(),
    receiptTimeoutS: num(env, "RECEIPT_TIMEOUT_S", 120, 1, 86400),
    stuckAfterS: num(env, "STUCK_AFTER_S", 300, 1, 86400),
    finalSweepBatch: num(env, "FINAL_SWEEP_BATCH", 100, 1, 1000),
    dataDir,
    publicDir: env.PUBLIC_DIR || "/public",
    seedFile: env.SEED_FILE || join(dataDir, "seed.txt"),
    publishIntervalS: num(env, "PUBLISH_INTERVAL_S", 5, 0.1, 3600),
    tickMs: num(env, "TICK_MS", 200, 10, 60_000),
    publicUrl: (env.PUBLIC_URL || "https://ferminux.net").replace(/\/+$/, ""),
    logLevel: ((env.LOG_LEVEL || "info").toLowerCase() as Config["logLevel"]),
  };
  if (cfg.maxInFlightWei < cfg.amounts.smallMin) throw new Error("MAX_FLOAT_IN_FLIGHT_FMX is below the smallest funding amount");
  if (cfg.signerSource === "off" && !allowHigh) throw new Error("SIGNER_SOURCE=off is for test chains only (needs LOADTEST_ALLOW_HIGH_RATE=1)");
  return cfg;
}

/** The config as it may be logged and published (no paths to secrets beyond the file name, no keys). */
export function publicConfig(c: Config) {
  return {
    enabled: c.enabled, chainId: c.chainId, sink: c.sink, wallets: c.wallets, rate: c.rate, waveSize: c.waveSize,
    maxActiveWaves: c.maxActiveWaves, tipGwei: Number(c.tipWei) / 1e9, loop: c.loop,
    guards: { maxHeadAgeS: c.maxHeadAgeS, minSigners: c.minSigners, maxTxpoolPending: c.maxTxpoolPending, maxExplorerLag: c.explorerApi ? c.maxExplorerLag : null, signerSource: c.signerSource },
  };
}
