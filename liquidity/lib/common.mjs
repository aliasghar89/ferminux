// Shared plumbing for the Ferminux remote-liquidity scripts.
//
// Design rule enforced here: every script is a DRY RUN by default. Nothing is
// signed or sent unless the caller passes BOTH --broadcast and --yes, and a
// PRIVATE_KEY is supplied via environment (never via argv — argv leaks into
// shell history and `ps`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const __dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dir, "..");

export const CHAINS = JSON.parse(readFileSync(join(ROOT, "chains.json"), "utf8"));

export const FERMINUX_CHAIN_ID = 3961n; // never broadcast there with this tooling

// ---------------------------------------------------------------------------
// ABIs (minimal, human-readable). The router/factory/pair ABI is the
// Uniswap-v2 interface, which PancakeSwap v2 and QuickSwap v2 share verbatim
// for every function used here.
// ---------------------------------------------------------------------------
export const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB, uint liquidity)",
];
export const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
  "function createPair(address tokenA, address tokenB) returns (address)",
  "function allPairsLength() view returns (uint)",
];
export const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint)",
  "function balanceOf(address) view returns (uint)",
  "function approve(address spender, uint value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint)",
];
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint)",
  "function balanceOf(address) view returns (uint)",
  "function approve(address spender, uint value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint)",
  "function transfer(address to, uint value) returns (bool)",
];
export const WNATIVE_ABI = [...ERC20_ABI, "function deposit() payable"];

export function loadArtifact(name) {
  return JSON.parse(readFileSync(join(ROOT, "artifacts", `${name}.json`), "utf8"));
}

// ---------------------------------------------------------------------------
// argv parsing: --flag value | --flag (boolean)
// ---------------------------------------------------------------------------
export function parseArgs(argv, spec) {
  const out = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) fail(`unexpected argument '${a}'`);
    const key = a.slice(2);
    if (!(key in spec)) fail(`unknown flag --${key}\n\n${usage(spec)}`);
    if (spec[key].bool) {
      out[key] = true;
    } else {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) fail(`--${key} needs a value`);
      out[key] = v;
    }
  }
  for (const [k, s] of Object.entries(spec)) {
    if (s.required && !(k in out)) fail(`missing required flag --${k}\n\n${usage(spec)}`);
    if (!(k in out) && "default" in s) out[k] = s.default;
  }
  return out;
}

export function usage(spec) {
  const lines = Object.entries(spec).map(
    ([k, s]) =>
      `  --${k}${s.bool ? "" : " <" + (s.hint ?? "value") + ">"}${s.required ? "  (required)" : "default" in s ? `  [default: ${s.default}]` : ""}\n      ${s.desc ?? ""}`,
  );
  return `flags:\n${lines.join("\n")}`;
}

export function fail(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// chain / provider / signer
// ---------------------------------------------------------------------------
export function chainConfig(key) {
  const c = CHAINS[key];
  if (!c) fail(`unknown --chain '${key}'. Known: ${Object.keys(CHAINS).join(", ")}`);
  return c;
}

export async function connect(cfg, rpcOverride) {
  const url = rpcOverride ?? cfg.defaultRpc;
  const provider = new ethers.JsonRpcProvider(url);
  const net = await provider.getNetwork();
  if (net.chainId !== BigInt(cfg.chainId)) {
    fail(
      `RPC ${url} reports chainId ${net.chainId}, expected ${cfg.chainId} (${cfg.name}). ` +
        `A fork of ${cfg.name} keeps its chainId, so this also rejects forks of the wrong chain.`,
    );
  }
  if (net.chainId === FERMINUX_CHAIN_ID) {
    fail("this tooling never targets Ferminux mainnet (chainId 3961)");
  }
  return { provider, url };
}

export function requireSigner(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) fail("broadcasting needs PRIVATE_KEY in the environment (never pass keys as CLI args)");
  try {
    // NonceManager: correct nonces for back-to-back sends, and immunity to the
    // provider's short request-coalescing window returning a stale count.
    return new ethers.NonceManager(new ethers.Wallet(pk, provider));
  } catch {
    fail("PRIVATE_KEY is not a valid secp256k1 private key");
  }
}

// The broadcast gate. Call before ANY state-changing send.
export function broadcastGate(opts) {
  if (opts.broadcast && opts.yes) return true;
  if (opts.broadcast && !opts.yes) {
    console.log(
      "\n--broadcast given without --yes. Refusing.\n" +
        "Re-run with BOTH --broadcast AND --yes once you have read the dry-run output\n" +
        "and accept that real funds will move on a public chain.",
    );
    process.exit(2);
  }
  return false; // plain dry run
}

// Sanity: router and factory must be real deployed code and must agree.
export async function verifyDexDeployment(provider, cfg) {
  const routerCode = await provider.getCode(cfg.router);
  const factoryCode = await provider.getCode(cfg.factory);
  if (routerCode === "0x") fail(`no code at router ${cfg.router} on ${cfg.name}`);
  if (factoryCode === "0x") fail(`no code at factory ${cfg.factory} on ${cfg.name}`);
  const router = new ethers.Contract(cfg.router, ROUTER_ABI, provider);
  const onchainFactory = await router.factory();
  if (onchainFactory.toLowerCase() !== cfg.factory.toLowerCase()) {
    fail(
      `router.factory() returned ${onchainFactory}, but chains.json says ${cfg.factory}. ` +
        "chains.json is wrong or the RPC is lying — stop and investigate.",
    );
  }
  return router;
}

export async function tokenInfo(provider, addr) {
  const t = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    t.symbol().catch(() => "???"),
    t.decimals(),
  ]);
  return { contract: t, symbol, decimals: Number(decimals) };
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
export const fmt = {
  units: (raw, dec, dp = 6) => {
    const s = ethers.formatUnits(raw, dec);
    const [i, f = ""] = s.split(".");
    return f ? `${i}.${f.slice(0, dp)}` : i;
  },
  usd: (n) =>
    "$" +
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (n, dp = 2) => `${(n * 100).toFixed(dp)}%`,
};

export function hr(title = "") {
  const line = "-".repeat(74);
  console.log(title ? `\n${line}\n${title}\n${line}` : line);
}

export async function sendStep(label, txPromise) {
  process.stdout.write(`  ${label} ... `);
  const tx = await txPromise;
  const rc = await tx.wait();
  console.log(`mined in block ${rc.blockNumber}, gasUsed=${rc.gasUsed}, tx=${rc.hash}`);
  return rc;
}
