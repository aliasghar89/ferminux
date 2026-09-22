#!/usr/bin/env node
// pool-state.mjs — read-only: print the live state of a wFMX pool.
//
//   node scripts/pool-state.mjs --chain bsc --token 0xWFMX --quote 0xUSDT [--holder 0x...] [--rpc URL]
//   node scripts/pool-state.mjs --chain bsc --pair 0xPAIR [--holder 0x...]

import { ethers } from "ethers";
import {
  parseArgs, fail, hr, fmt,
  chainConfig, connect, tokenInfo,
  FACTORY_ABI, PAIR_ABI,
} from "../lib/common.mjs";

const SPEC = {
  chain: { required: true, hint: "bsc|ethereum|base|arbitrum|polygon", desc: "chain key from chains.json" },
  token: { hint: "address", desc: "wFMX address (with --quote, resolves pair via factory)" },
  quote: { hint: "address", desc: "quote token address" },
  pair: { hint: "address", desc: "pair address directly (alternative to token+quote)" },
  holder: { hint: "address", desc: "also print this address's LP position" },
  rpc: { hint: "url", desc: "RPC override" },
};

const opts = parseArgs(process.argv, SPEC);
const cfg = chainConfig(opts.chain);
const { provider, url } = await connect(cfg, opts.rpc);

let pairAddr = opts.pair;
if (!pairAddr) {
  if (!opts.token || !opts.quote) fail("give --pair, or both --token and --quote");
  const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider);
  pairAddr = await factory.getPair(opts.token, opts.quote);
  if (pairAddr === ethers.ZeroAddress) fail("factory has no pair for that token/quote");
}

const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
const [t0a, t1a, [r0, r1, tsLast], lpSupply] = await Promise.all([
  pair.token0(), pair.token1(), pair.getReserves(), pair.totalSupply(),
]);
const t0 = await tokenInfo(provider, t0a);
const t1 = await tokenInfo(provider, t1a);

hr(`POOL STATE — ${cfg.dex} on ${cfg.name} via ${url}`);
console.log(`pair:         ${pairAddr}`);
console.log(`token0:       ${t0a}  ${t0.symbol} (${t0.decimals} dec)`);
console.log(`token1:       ${t1a}  ${t1.symbol} (${t1.decimals} dec)`);
console.log(`reserves:     ${fmt.units(r0, t0.decimals)} ${t0.symbol}  /  ${fmt.units(r1, t1.decimals)} ${t1.symbol}`);
const p01 = Number(ethers.formatUnits(r1, t1.decimals)) / Number(ethers.formatUnits(r0, t0.decimals));
if (r0 > 0n && r1 > 0n) {
  console.log(`spot price:   1 ${t0.symbol} = ${p01.toPrecision(8)} ${t1.symbol}`);
  console.log(`              1 ${t1.symbol} = ${(1 / p01).toPrecision(8)} ${t0.symbol}`);
} else {
  console.log("spot price:   pool is EMPTY — no price yet");
}
console.log(`LP supply:    ${fmt.units(lpSupply, 18)}`);
console.log(`last update:  reserve timestamp ${tsLast} (${new Date(Number(tsLast) * 1000).toISOString()})`);

if (opts.holder) {
  const bal = await pair.balanceOf(opts.holder);
  const pct = lpSupply > 0n ? Number((bal * 1000000n) / lpSupply) / 10000 : 0;
  console.log(`\nholder ${opts.holder}`);
  console.log(`  LP balance: ${fmt.units(bal, 18)}  (${pct}% of supply)`);
  if (lpSupply > 0n && bal > 0n) {
    console.log(`  redeemable: ${fmt.units((r0 * bal) / lpSupply, t0.decimals)} ${t0.symbol} + ${fmt.units((r1 * bal) / lpSupply, t1.decimals)} ${t1.symbol}`);
  }
}
