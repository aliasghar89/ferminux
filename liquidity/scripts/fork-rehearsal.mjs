#!/usr/bin/env node
// fork-rehearsal.mjs — end-to-end rehearsal of the whole go-live sequence
// against a LOCAL anvil fork of a real chain. Nothing touches the real chain;
// the fork RPC only serves reads.
//
//   node scripts/fork-rehearsal.mjs --chain bsc  --port 8603
//   node scripts/fork-rehearsal.mjs --chain base --port 8604
//
// What it proves, in order:
//   1. the broadcast gate: create-pool refuses without --broadcast/--yes
//   2. pair creation + initial liquidity via the REAL DEX contracts (forked)
//   3. pool-state readback
//   4. LiquidityLocker deploy + LP lock + on-chain lock proof
//   5. withdraw before maturity REVERTS ("LOCKER: still locked")
// and records the real gasUsed of every step for the runbook's cost table.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { parseArgs, fail, hr, chainConfig, loadArtifact, ROOT, PAIR_ABI } from "../lib/common.mjs";

const SPEC = {
  chain: { required: true, hint: "bsc|base|...", desc: "chain key from chains.json to fork" },
  port: { required: true, hint: "8603", desc: "local port for anvil (use YOUR assigned ports)" },
  "fork-url": { hint: "url", desc: "upstream RPC to fork (default: chains.json defaultRpc)" },
};
const opts = parseArgs(process.argv, SPEC);
const cfg = chainConfig(opts.chain);
const forkUrl = opts["fork-url"] ?? cfg.defaultRpc;
const port = Number(opts.port);
const local = `http://127.0.0.1:${port}`;

// anvil's well-known dev account #0 — a PUBLIC key, safe only on local forks.
const DEV_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

mkdirSync(join(ROOT, "rehearsal-logs"), { recursive: true });
const logFile = join(ROOT, "rehearsal-logs", `${opts.chain}-${new Date().toISOString().slice(0, 10)}.log`);
const log = (s) => { console.log(s); appendFileSync(logFile, s + "\n"); };

const gasTable = [];
function harvestGas(label, text) {
  for (const m of text.matchAll(/^\s*(.+?) \.\.\. mined in block \d+, gasUsed=(\d+)/gm)) gasTable.push({ phase: label, step: m[1], gas: Number(m[2]) });
  for (const m of text.matchAll(/LiquidityLocker deployed at \S+ \(gasUsed=(\d+)/g)) gasTable.push({ phase: label, step: "deploy LiquidityLocker", gas: Number(m[1]) });
}

function runChild(label, script, args, { expectExit = 0, env = {} } = {}) {
  log(`\n>>> ${label}: node ${script} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  log(out.trimEnd());
  if (r.status !== expectExit) {
    anvil?.kill();
    fail(`${label}: expected exit ${expectExit}, got ${r.status}`);
  }
  log(`<<< ${label}: exit ${r.status} (expected ${expectExit}) — OK`);
  harvestGas(label, out);
  return out;
}

// --- 1. start anvil ---------------------------------------------------------
hr(`FORK REHEARSAL — ${cfg.name} (${cfg.dex}) forked from ${forkUrl} on :${port}`);
log(`log file: ${logFile}`);

const probe = spawnSync("bash", ["-c", `nc -z 127.0.0.1 ${port} </dev/null 2>/dev/null`]);
if (probe.status === 0) fail(`port ${port} is already in use — refusing to start anvil there`);

const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent"], { stdio: "ignore" });
let anvilDead = false;
anvil.on("exit", () => { anvilDead = true; });
const provider = new ethers.JsonRpcProvider(local, undefined, { polling: true, pollingInterval: 250 });
let ready = false;
for (let i = 0; i < 120 && !ready && !anvilDead; i++) {
  try { await provider.getBlockNumber(); ready = true; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!ready) { anvil.kill(); fail(`anvil did not come up on :${port} (upstream ${forkUrl} unreachable?)`); }
const net = await provider.getNetwork();
const head = await provider.getBlockNumber();
log(`anvil up: chainId ${net.chainId} (expect ${cfg.chainId}), forked at block ${head}`);
if (net.chainId !== BigInt(cfg.chainId)) { anvil.kill(); fail("fork reports wrong chainId"); }

try {
  const wallet = new ethers.NonceManager(new ethers.Wallet(DEV_PK, provider));
  const me = await wallet.getAddress();
  log(`dev wallet: ${me} balance ${ethers.formatEther(await provider.getBalance(me))} ${cfg.nativeSymbol}`);

  // --- 2. deploy a stand-in wFMX (the real one will be the bridge mint) -----
  const mockArt = loadArtifact("MockERC20");
  const mock = await new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, wallet)
    .deploy("Wrapped FMX (rehearsal)", "wFMX", 18);
  await mock.deploymentTransaction().wait();
  const wfmx = await mock.getAddress();
  await (await mock.mint(me, ethers.parseEther("1000000"))).wait();
  log(`stand-in wFMX deployed at ${wfmx}, minted 1,000,000 to dev wallet`);
  log(`quote for the rehearsal: ${cfg.wrappedNativeSymbol} at ${cfg.wrappedNative} (create-pool wraps native automatically)`);

  const common = ["--chain", opts.chain, "--rpc", local, "--token", wfmx, "--quote", cfg.wrappedNative];
  const poolArgs = [...common, "--quote-amount", "100", "--price", "0.001"]; // 100 wNative + 100,000 wFMX

  // --- 3. prove the safety gate ---------------------------------------------
  runChild("gate A (dry run, no flags)", "create-pool.mjs", poolArgs, { expectExit: 0, env: { PRIVATE_KEY: "" } });
  runChild("gate B (--broadcast without --yes)", "create-pool.mjs", [...poolArgs, "--broadcast"], { expectExit: 2, env: { PRIVATE_KEY: DEV_PK } });

  // --- 4. the real thing, on the fork ---------------------------------------
  const created = runChild("create-pool broadcast", "create-pool.mjs", [...poolArgs, "--broadcast", "--yes"], { env: { PRIVATE_KEY: DEV_PK } });
  const pairAddr = created.match(/^pair:\s+(0x[0-9a-fA-F]{40})/m)?.[1];
  if (!pairAddr) throw new Error("could not parse pair address from create-pool output");

  runChild("pool-state readback", "pool-state.mjs", ["--chain", opts.chain, "--rpc", local, "--pair", pairAddr, "--holder", me]);

  const unlock = String(Math.floor(Date.now() / 1000) + 365 * 86400);
  const locked = runChild("lock-lp broadcast", "lock-lp.mjs",
    ["--chain", opts.chain, "--rpc", local, "--pair", pairAddr, "--amount", "all", "--unlock", unlock, "--broadcast", "--yes"],
    { env: { PRIVATE_KEY: DEV_PK } });
  const lockerAddr = locked.match(/^locker:\s+(0x[0-9a-fA-F]{40})/m)?.[1];
  if (!lockerAddr) throw new Error("could not parse locker address from lock-lp output");

  // --- 5. the lock actually locks -------------------------------------------
  hr("NEGATIVE CHECK — withdraw before maturity must revert");
  const locker = new ethers.Contract(lockerAddr, loadArtifact("LiquidityLocker").abi, wallet);
  let reverted = false, reason = "";
  try { await locker.withdraw.staticCall(0, me); } catch (e) { reverted = true; reason = e.reason ?? e.shortMessage ?? String(e); }
  if (!reverted) throw new Error("SECURITY FAIL: withdraw before unlockAt did NOT revert");
  log(`withdraw(0) before maturity reverted as required: ${reason}`);
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  log(`LP now held by locker: ${ethers.formatEther(await pair.balanceOf(lockerAddr))} (dev wallet holds ${ethers.formatEther(await pair.balanceOf(me))})`);

  // --- 6. gas table ----------------------------------------------------------
  hr("MEASURED GAS (real receipts on the fork)");
  let total = 0;
  for (const g of gasTable) { log(`  ${String(g.gas).padStart(9)}  ${g.step}  [${g.phase}]`); total += g.gas; }
  log(`  ${String(total).padStart(9)}  TOTAL`);
  log(`\nREHEARSAL PASSED on ${cfg.name} fork. Full transcript: ${logFile}`);
} catch (e) {
  log(`REHEARSAL FAILED: ${e.stack ?? e}`);
  process.exitCode = 1;
} finally {
  anvil.kill();
}
