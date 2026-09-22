#!/usr/bin/env node
// lock-lp.mjs — deploy the Ferminux LiquidityLocker on a remote chain (or use
// one already deployed) and time-lock LP tokens in it, then print the exact
// commands ANY third party can run to verify the lock without trusting us.
//
//   DRY RUN by default. --broadcast --yes + PRIVATE_KEY to execute.
//
//   node scripts/lock-lp.mjs --chain bsc --pair 0xPAIR --amount all --unlock 2027-09-01
//   node scripts/lock-lp.mjs --chain bsc --pair 0xPAIR --amount 12.5 --unlock 1788230400 --locker 0xEXISTING
//
// Why our own locker instead of UNCX/Team Finance is a per-chain decision:
// see LOCKING.md.

import { ethers } from "ethers";
import {
  parseArgs, fail, hr, fmt,
  chainConfig, connect, requireSigner, broadcastGate, loadArtifact, sendStep,
  PAIR_ABI,
} from "../lib/common.mjs";

const SPEC = {
  chain: { required: true, hint: "bsc|ethereum|base|arbitrum|polygon", desc: "chain key from chains.json" },
  pair: { required: true, hint: "address", desc: "the LP token (pair) to lock" },
  amount: { required: true, hint: "all|decimal", desc: "'all' locks the wallet's full LP balance" },
  unlock: { required: true, hint: "YYYY-MM-DD|unix", desc: "unlock timestamp (UTC midnight if a date)" },
  locker: { hint: "address", desc: "existing LiquidityLocker; omit to deploy a fresh one" },
  rpc: { hint: "url", desc: "RPC override (e.g. local anvil fork)" },
  broadcast: { bool: true, desc: "actually send transactions (also needs --yes and PRIVATE_KEY)" },
  yes: { bool: true, desc: "second confirmation flag" },
};

const opts = parseArgs(process.argv, SPEC);
const cfg = chainConfig(opts.chain);
if (!ethers.isAddress(opts.pair)) fail("--pair is not a valid address");
if (opts.locker && !ethers.isAddress(opts.locker)) fail("--locker is not a valid address");

// unlock time
let unlockAt;
if (/^\d{4}-\d{2}-\d{2}$/.test(opts.unlock)) unlockAt = BigInt(Math.floor(Date.parse(opts.unlock + "T00:00:00Z") / 1000));
else if (/^\d+$/.test(opts.unlock)) unlockAt = BigInt(opts.unlock);
else fail("--unlock must be YYYY-MM-DD or a unix timestamp");
const nowSec = BigInt(Math.floor(Date.now() / 1000));
if (unlockAt <= nowSec) fail(`unlock time ${unlockAt} is in the past`);
const lockDays = Number(unlockAt - nowSec) / 86400;

const live = broadcastGate(opts);
const { provider, url } = await connect(cfg, opts.rpc);

hr(`LOCK LP — ${cfg.name} (chainId ${cfg.chainId})`);
console.log(`mode:      ${live ? "BROADCAST" : "DRY RUN — nothing will be sent"}`);
console.log(`rpc:       ${url}`);
console.log(`pair/LP:   ${opts.pair}`);
console.log(`unlockAt:  ${unlockAt} (${new Date(Number(unlockAt) * 1000).toISOString()}, ~${lockDays.toFixed(1)} days from now)`);
if (lockDays < 180) console.log("WARNING: locks under 6 months read as weak commitment. 12 months is the credible minimum.");

const art = loadArtifact("LiquidityLocker");
const pair = new ethers.Contract(opts.pair, PAIR_ABI, provider);
if ((await provider.getCode(opts.pair)) === "0x") fail("no code at --pair on this chain");

const signer = live ? requireSigner(provider) : null;
const me = signer ? await signer.getAddress() : null;

let amountRaw = null;
if (me) {
  const bal = await pair.balanceOf(me);
  console.log(`wallet:    ${me}`);
  console.log(`LP held:   ${fmt.units(bal, 18)}`);
  amountRaw = opts.amount === "all" ? bal : ethers.parseUnits(opts.amount, 18);
  if (amountRaw === 0n) fail("nothing to lock (LP balance is zero?)");
  if (amountRaw > bal) fail(`wallet holds ${fmt.units(bal, 18)} LP, cannot lock ${opts.amount}`);
} else {
  console.log(`amount:    ${opts.amount} LP (balances unchecked in dry run without PRIVATE_KEY)`);
}

hr("TRANSACTION PLAN");
let n = 1;
if (!opts.locker) {
  console.log(`${n++}. deploy LiquidityLocker (artifact from dex/contracts: solc 0.8.24, paris, no admin, no owner, no escape hatch)`);
} else {
  console.log(`- reuse LiquidityLocker at ${opts.locker}`);
  if ((await provider.getCode(opts.locker)) === "0x") fail("no code at --locker");
}
console.log(`${n++}. pair.approve(locker, amount)`);
console.log(`${n++}. locker.lock(pair, amount, ${unlockAt})  -> emits Locked(id, ...)`);

if (!live) {
  hr("DRY RUN COMPLETE — NOTHING WAS SENT");
  console.log("Re-run with --broadcast --yes (PRIVATE_KEY in env) after rehearsing on a fork.");
  process.exit(0);
}

hr("BROADCASTING");
let lockerAddr = opts.locker;
if (!lockerAddr) {
  const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await f.deploy();
  const rc = await c.deploymentTransaction().wait();
  lockerAddr = await c.getAddress();
  console.log(`  LiquidityLocker deployed at ${lockerAddr} (gasUsed=${rc.gasUsed}, tx=${rc.hash})`);
}
const locker = new ethers.Contract(lockerAddr, art.abi, signer);

await sendStep("approve LP to locker", pair.connect(signer).approve(lockerAddr, amountRaw));
const id = await locker.lock.staticCall(opts.pair, amountRaw, unlockAt);
console.log(`  lock simulation OK — lock id will be ${id}`);
await sendStep("lock", locker.lock(opts.pair, amountRaw, unlockAt));

hr("LOCK PROOF — what a buyer verifies");
const lk = await locker.getLock(id);
const total = await locker.totalLockedForTokenAt(opts.pair, nowSec);
console.log(`locker:      ${lockerAddr}`);
console.log(`lock id:     ${lk.id}`);
console.log(`token (LP):  ${lk.token}`);
console.log(`owner:       ${lk.owner}`);
console.log(`amount:      ${fmt.units(lk.amount, 18)} LP`);
console.log(`lockedAt:    ${lk.lockedAt} | unlockAt: ${lk.unlockAt} (${new Date(Number(lk.unlockAt) * 1000).toISOString()})`);
console.log(`still locked for this pair right now: ${fmt.units(total, 18)} LP`);
console.log("\nAnyone can verify with no trust in us:");
console.log(`  cast call ${lockerAddr} "locksForToken(address)((uint256,address,address,uint256,uint64,uint64,bool)[])" ${opts.pair} --rpc-url <public rpc>`);
console.log(`  cast call ${opts.pair} "balanceOf(address)(uint256)" ${lockerAddr} --rpc-url <public rpc>   # LP actually sits in the locker`);
console.log("\nThen (mainnet only): verify the locker's source on the chain explorer so the two");
console.log("calls above are readable in the explorer UI — see LOCKING.md step-by-step.");
