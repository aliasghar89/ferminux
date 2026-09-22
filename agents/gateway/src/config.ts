import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/config.js -> ../.. = agents/gateway/dist -> agents/gateway -> agents/
export const agentsRoot = join(__dirname, "..", "..");

/** deployments.3961.json keys for the Addendum v3 contracts (all optional until deployed). */
export const V3_CONTRACT_KEYS = [
  "x402Vault",
  "accountFactory",
  "accountImpl",
  "streamPay",
  "arbiterPool",
  "identity8004",
  "reputation8004",
  "validation8004",
  "tokenFactory",
] as const;
export type V3ContractKey = (typeof V3_CONTRACT_KEYS)[number];
export type V3Contracts = Partial<Record<V3ContractKey, string>>;

interface DeploymentDefaults extends V3Contracts {
  registry?: string;
  escrow?: string;
  deployBlock?: number;
  v3DeployBlock?: number;
}

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v !== ZERO_ADDRESS;
}

function loadDeploymentDefaults(): DeploymentDefaults {
  const candidates = [join(agentsRoot, "deployments.3961.json"), join(agentsRoot, "deployments.json")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      const out: DeploymentDefaults = { registry: j.registry, escrow: j.escrow, deployBlock: j.deployBlock };
      for (const key of V3_CONTRACT_KEYS) if (isAddress(j[key])) out[key] = j[key];
      if (typeof j.v3DeployBlock === "number") out.v3DeployBlock = j.v3DeployBlock;
      return out;
    } catch (err) {
      console.warn(`[config] failed to parse ${path}:`, (err as Error).message);
    }
  }
  return {};
}

export interface GatewayConfig {
  rpcUrl: string;
  registry: string;
  escrow: string;
  deployBlock: number;
  dataDir: string;
  port: number;
  publicUrl: string;
  pollMs: number;
  probeMs: number;
  /** tools-registry probe interval (ms), default 10 min */
  toolProbeMs: number;

  // ---- Addendum v3 (every field optional: features degrade to {disabled:true} when missing) ----
  /** v3 contract addresses from deployments.3961.json (env X402_VAULT, ACCOUNT_FACTORY, … override) */
  v3?: V3Contracts;
  /** first block to scan for v3 contract events */
  v3DeployBlock?: number;
  /** x402 facilitator settlement key (calls X402Vault.settleBatch); unset = facilitator disabled */
  facilitatorKey?: string;
  /** USDC pay-in: FMX hot wallet key on 3961 (also the deposit address on every pay-in chain unless overridden) */
  payinHotKey?: string;
  /** deposit-address override per pay-in chain slug (PAYIN_DEPOSIT_<CHAIN>); unset chains use the hot wallet address */
  payinDeposits: Record<string, string>;
  /** operator-fixed USD price per FMX for pay-in quotes (PAYIN_PRICE_USD, decimal string); unset = wFMX pool price */
  payinPriceUsd?: string;
  /** floor for the pool-derived price (PAYIN_MIN_PRICE_USD) */
  payinMinPriceUsd?: string;
  /** RPC URL per pay-in chain slug (<CHAIN>_RPC_URL); bsc also feeds the PriceFeed's PancakeSwap reads */
  payinRpcUrls: Record<string, string>;
  bscRpcUrl: string;
  /** gas sponsorship relayer key (AgentAccount.executeWithSig / factory.create) */
  relayerKey?: string;
  /** audit export signing key; unset = ephemeral key generated at boot */
  gatewaySigningKey?: string;
  /** Oracle agent key: posts ValidationRegistry8004.validationRequest for delivered jobs whose agent names it as validator */
  oracleKey?: string;
  /** webhook delivery worker interval (ms) */
  webhookTickMs: number;
  /** x402 settlement batch interval (ms) */
  x402BatchMs: number;
  /** pay-in watcher interval (ms) */
  payinPollMs: number;

  // ---- Growth: referral programme ----
  /** GROWTH_KEY — funded wallet that pays referral rewards; unset = rows stay paid=0 ("pending") */
  growthKey?: string;
  /** REFERRAL_REWARD_FMX — FMX paid to EACH owner (referrer + referred) on the referred agent's first completed job; default 10 */
  referralRewardFmx: string;
  /** referral payout worker interval (ms) */
  referralTickMs: number;
  /** REFERRAL_MIN_JOB_FMX — the referred agent's qualifying job must be paid at least this much (default 5) */
  referralMinJobFmx: string;
  /** REFERRAL_MAX_PAYOUTS_PER_REFERRER_PER_DAY — referrals paid per referrer owner per UTC day (default 5) */
  referralMaxPerReferrerPerDay: number;
  /** REFERRAL_MAX_PAYOUTS_PER_DAY — referrals paid network-wide per UTC day (default 50) */
  referralMaxPerDay: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Pay-in chain slugs → default public RPC and env-var name (PAYIN_DEPOSIT_<CHAIN>, <CHAIN>_RPC_URL). */
const PAYIN_RPC_DEFAULTS: Record<string, string> = {
  eth: "https://eth.llamarpc.com",
  bsc: "https://bsc-dataseed.binance.org",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  polygon: "https://polygon-rpc.com",
  optimism: "https://mainnet.optimism.io",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
};
const PAYIN_ENV_SUFFIX: Record<string, string> = {
  eth: "ETH",
  bsc: "BSC",
  base: "BASE",
  arbitrum: "ARBITRUM",
  polygon: "POLYGON",
  optimism: "OPTIMISM",
  avalanche: "AVALANCHE",
};

const V3_ENV: Record<V3ContractKey, string> = {
  x402Vault: "X402_VAULT",
  accountFactory: "ACCOUNT_FACTORY",
  accountImpl: "ACCOUNT_IMPL",
  streamPay: "STREAM_PAY",
  arbiterPool: "ARBITER_POOL",
  identity8004: "IDENTITY_8004",
  reputation8004: "REPUTATION_8004",
  validation8004: "VALIDATION_8004",
  tokenFactory: "TOKEN_FACTORY",
};

function optionalKey(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : undefined;
}

export function loadConfig(): GatewayConfig {
  const fileDefaults = loadDeploymentDefaults();
  const registry = process.env.REGISTRY || fileDefaults.registry || ZERO_ADDRESS;
  const escrow = process.env.ESCROW || fileDefaults.escrow || ZERO_ADDRESS;
  const deployBlock = process.env.DEPLOY_BLOCK
    ? Number(process.env.DEPLOY_BLOCK)
    : (fileDefaults.deployBlock ?? 0);

  if (registry === ZERO_ADDRESS || escrow === ZERO_ADDRESS) {
    console.warn(
      "[config] REGISTRY and/or ESCROW not set (env, or agents/deployments.3961.json) — " +
        "indexer will run against the zero address until configured.",
    );
  }

  const v3: V3Contracts = {};
  for (const key of V3_CONTRACT_KEYS) {
    const env = process.env[V3_ENV[key]];
    const v = isAddress(env) ? env : fileDefaults[key];
    if (v) v3[key] = v;
  }
  const v3DeployBlock = process.env.V3_DEPLOY_BLOCK ? Number(process.env.V3_DEPLOY_BLOCK) : fileDefaults.v3DeployBlock;

  for (const name of ["FACILITATOR_KEY", "PAYIN_HOT_KEY", "RELAYER_KEY", "GATEWAY_SIGNING_KEY", "ORACLE_KEY", "GROWTH_KEY"]) {
    if (process.env[name] && !optionalKey(name)) console.warn(`[config] ${name} is set but not a 32-byte 0x hex key — ignored`);
  }

  const payinRpcUrls: Record<string, string> = {};
  const payinDeposits: Record<string, string> = {};
  for (const [slug, suffix] of Object.entries(PAYIN_ENV_SUFFIX)) {
    payinRpcUrls[slug] = process.env[`${suffix}_RPC_URL`] || PAYIN_RPC_DEFAULTS[slug]!;
    const dep = process.env[`PAYIN_DEPOSIT_${suffix}`];
    if (isAddress(dep)) payinDeposits[slug] = dep;
  }

  return {
    rpcUrl: process.env.RPC_URL || "https://rpc.ferminux.net",
    registry,
    escrow,
    deployBlock,
    dataDir: process.env.DATA_DIR || "./data",
    port: process.env.PORT ? Number(process.env.PORT) : 8790,
    publicUrl: process.env.PUBLIC_URL || "https://ferminux.net",
    pollMs: process.env.POLL_MS ? Number(process.env.POLL_MS) : 4000,
    probeMs: process.env.PROBE_MS ? Number(process.env.PROBE_MS) : 300000,
    toolProbeMs: process.env.TOOL_PROBE_MS ? Number(process.env.TOOL_PROBE_MS) : 600000,
    v3,
    v3DeployBlock,
    facilitatorKey: optionalKey("FACILITATOR_KEY"),
    payinHotKey: optionalKey("PAYIN_HOT_KEY"),
    payinDeposits,
    payinPriceUsd: /^\d+(\.\d{1,18})?$/.test(process.env.PAYIN_PRICE_USD ?? "") ? process.env.PAYIN_PRICE_USD : undefined,
    payinMinPriceUsd: /^\d+(\.\d{1,18})?$/.test(process.env.PAYIN_MIN_PRICE_USD ?? "") ? process.env.PAYIN_MIN_PRICE_USD : undefined,
    payinRpcUrls,
    bscRpcUrl: payinRpcUrls.bsc!,
    relayerKey: optionalKey("RELAYER_KEY"),
    gatewaySigningKey: optionalKey("GATEWAY_SIGNING_KEY"),
    oracleKey: optionalKey("ORACLE_KEY"),
    webhookTickMs: process.env.WEBHOOK_TICK_MS ? Number(process.env.WEBHOOK_TICK_MS) : 5000,
    x402BatchMs: process.env.X402_BATCH_MS ? Number(process.env.X402_BATCH_MS) : 30000,
    payinPollMs: process.env.PAYIN_POLL_MS ? Number(process.env.PAYIN_POLL_MS) : 20000,
    growthKey: optionalKey("GROWTH_KEY"),
    referralRewardFmx: /^\d+(\.\d{1,18})?$/.test(process.env.REFERRAL_REWARD_FMX ?? "") ? (process.env.REFERRAL_REWARD_FMX as string) : "10",
    referralTickMs: process.env.REFERRAL_TICK_MS ? Number(process.env.REFERRAL_TICK_MS) : 30000,
    referralMinJobFmx: /^\d+(\.\d{1,18})?$/.test(process.env.REFERRAL_MIN_JOB_FMX ?? "") ? (process.env.REFERRAL_MIN_JOB_FMX as string) : "5",
    referralMaxPerReferrerPerDay: process.env.REFERRAL_MAX_PAYOUTS_PER_REFERRER_PER_DAY ? Number(process.env.REFERRAL_MAX_PAYOUTS_PER_REFERRER_PER_DAY) : 5,
    referralMaxPerDay: process.env.REFERRAL_MAX_PAYOUTS_PER_DAY ? Number(process.env.REFERRAL_MAX_PAYOUTS_PER_DAY) : 50,
  };
}
