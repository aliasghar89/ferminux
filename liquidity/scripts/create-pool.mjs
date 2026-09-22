#!/usr/bin/env node
// create-pool.mjs — create a Uniswap-v2-compatible wFMX pair on a remote chain
// and add the initial liquidity at a chosen opening price.
//
//   DRY RUN (default): full plan + every safety check, nothing signed or sent.
//   BROADCAST: requires --broadcast AND --yes AND PRIVATE_KEY in env.
//
// Examples
//   # plan a $50k USDT pool at $0.52/FMX on BSC (dry run):
//   node scripts/create-pool.mjs --chain bsc --token 0xWFMX --quote 0xUSDT \
//        --quote-amount 50000 --price 0.52
//
//   # rehearse for real against a local anvil fork of BSC:
//   PRIVATE_KEY=0x... node scripts/create-pool.mjs --chain bsc --rpc http://127.0.0.1:8603 \
//        --token 0x... --quote 0x... --quote-amount 50000 --price 0.52 --broadcast --yes

import { ethers } from "ethers";
import {
  parseArgs, usage, fail, hr, fmt,
  chainConfig, connect, requireSigner, broadcastGate, verifyDexDeployment,
  tokenInfo, sendStep,
  ROUTER_ABI, FACTORY_ABI, PAIR_ABI, WNATIVE_ABI,
} from "../lib/common.mjs";

const SPEC = {
  chain: { required: true, hint: "bsc|ethereum|base|arbitrum|polygon", desc: "target chain key from chains.json" },
  token: { required: true, hint: "address", desc: "wFMX token address on the remote chain (bridge-minted)" },
  quote: { required: true, hint: "address", desc: "quote token address (USDT/USDC/wrapped-native). This is what sellers take OUT of the pool." },
  "quote-amount": { required: true, hint: "decimal", desc: "quote tokens to deposit (human units, e.g. 50000)" },
  price: { hint: "decimal", desc: "opening price in quote per wFMX (e.g. 0.52). Mutually exclusive with --token-amount." },
  "token-amount": { hint: "decimal", desc: "explicit wFMX amount instead of --price" },
  "lp-recipient": { hint: "address", desc: "address that receives the LP tokens (default: signer / 0x0 in dry run)" },
  "slippage-bps": { default: "50", hint: "bps", desc: "amountMin tolerance for addLiquidity (50 = 0.5%)" },
  rpc: { hint: "url", desc: "RPC override (e.g. a local anvil fork). Must serve the chain's chainId." },
  broadcast: { bool: true, desc: "actually send transactions (also needs --yes and PRIVATE_KEY)" },
  yes: { bool: true, desc: "second confirmation: 'I read the dry run, real funds will move'" },
};

const opts = parseArgs(process.argv, SPEC);
const cfg = chainConfig(opts.chain);

if (!opts.price && !opts["token-amount"]) fail("give either --price or --token-amount\n\n" + usage(SPEC));
if (opts.price && opts["token-amount"]) fail("--price and --token-amount are mutually exclusive");
for (const k of ["token", "quote", "lp-recipient"]) {
  if (opts[k] && !ethers.isAddress(opts[k])) fail(`--${k} '${opts[k]}' is not a valid address`);
}
if (opts.token.toLowerCase() === opts.quote.toLowerCase()) fail("--token and --quote are the same address");

const live = broadcastGate(opts);

const { provider, url } = await connect(cfg, opts.rpc);
hr(`CREATE POOL — ${cfg.dex} on ${cfg.name} (chainId ${cfg.chainId})`);
console.log(`mode:      ${live ? "BROADCAST — real transactions will be sent" : "DRY RUN — nothing will be sent"}`);
console.log(`rpc:       ${url}`);
console.log(`router:    ${cfg.router}`);
console.log(`factory:   ${cfg.factory}`);

// --- safety: the DEX really is where chains.json says it is -----------------
const router = await verifyDexDeployment(provider, cfg);
console.log("check:     code present at router+factory, router.factory() matches chains.json");

// --- token metadata ---------------------------------------------------------
const tok = await tokenInfo(provider, opts.token);
const qt = await tokenInfo(provider, opts.quote);
console.log(`token:     ${opts.token}  ${tok.symbol} (${tok.decimals} decimals)`);
console.log(`quote:     ${opts.quote}  ${qt.symbol} (${qt.decimals} decimals)`);
if (tok.decimals !== 18) console.log(`NOTE: wFMX is expected to be 18 decimals; this token has ${tok.decimals}. Double-check it is the bridge mint.`);

// --- amounts ----------------------------------------------------------------
const quoteRaw = ethers.parseUnits(opts["quote-amount"], qt.decimals);
let tokenRaw;
let priceStr;
if (opts.price) {
  // tokenRaw = quoteRaw / price, computed in integer math at 18 digits of price precision
  const priceScaled = ethers.parseUnits(opts.price, 18);
  tokenRaw = (quoteRaw * 10n ** BigInt(tok.decimals) * 10n ** 18n) / (priceScaled * 10n ** BigInt(qt.decimals));
  priceStr = opts.price;
} else {
  tokenRaw = ethers.parseUnits(opts["token-amount"], tok.decimals);
  const p = Number(opts["quote-amount"]) / Number(opts["token-amount"]);
  priceStr = p.toPrecision(8);
}
if (tokenRaw === 0n || quoteRaw === 0n) fail("computed a zero deposit amount — check --price / amounts");

const slipBps = BigInt(opts["slippage-bps"]);
const tokenMin = (tokenRaw * (10000n - slipBps)) / 10000n;
const quoteMin = (quoteRaw * (10000n - slipBps)) / 10000n;

hr("PLANNED DEPOSIT");
console.log(`opening price:   ${priceStr} ${qt.symbol} per ${tok.symbol}`);
console.log(`deposit:         ${fmt.units(tokenRaw, tok.decimals)} ${tok.symbol}  +  ${fmt.units(quoteRaw, qt.decimals)} ${qt.symbol}`);
console.log(`addLiquidity min ${fmt.units(tokenMin, tok.decimals)} ${tok.symbol} / ${fmt.units(quoteMin, qt.decimals)} ${qt.symbol}  (${opts["slippage-bps"]} bps tolerance)`);

// expected LP for a fresh pool: sqrt(a*b) - 1000 (MINIMUM_LIQUIDITY burned)
function isqrt(n) { if (n < 0n) throw new Error("neg"); if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
const expectedLp = isqrt(tokenRaw * quoteRaw) - 1000n;

// --- existing pair? ---------------------------------------------------------
const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider);
const existingPair = await factory.getPair(opts.token, opts.quote);
let pairExists = existingPair !== ethers.ZeroAddress;
if (pairExists) {
  const pair = new ethers.Contract(existingPair, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  console.log(`\npair ALREADY EXISTS at ${existingPair}`);
  if (r0 > 0n || r1 > 0n) {
    const t0 = (await pair.token0()).toLowerCase();
    const [rTok, rQt] = t0 === opts.token.toLowerCase() ? [r0, r1] : [r1, r0];
    const cur = Number(ethers.formatUnits(rQt, qt.decimals)) / Number(ethers.formatUnits(rTok, tok.decimals));
    console.log(`pool is FUNDED: reserves ${fmt.units(rTok, tok.decimals)} ${tok.symbol} / ${fmt.units(rQt, qt.decimals)} ${qt.symbol} — market price ${cur.toPrecision(6)} ${qt.symbol}/${tok.symbol}`);
    const want = Number(priceStr);
    if (Math.abs(cur - want) / want > 0.01) {
      fail(
        `your target price ${priceStr} differs from the pool's current price ${cur.toPrecision(6)} by >1%.\n` +
          "Adding liquidity does NOT set a price on a funded pool — the router deposits at the POOL's ratio\n" +
          "and any attempt to push a different ratio is free money for arbitrage bots.\n" +
          "Either accept the pool price (re-run with --price " + cur.toPrecision(6) + ") or swap first to move it.",
      );
    }
    console.log("target price is within 1% of pool price — deposit will follow the pool ratio.");
  } else {
    console.log("pair exists but is EMPTY — your deposit still sets the opening price.");
  }
}

// --- signer / balances ------------------------------------------------------
const signer = live ? requireSigner(provider) : null;
const who = signer ? await signer.getAddress() : (opts["lp-recipient"] ?? null);
const lpTo = opts["lp-recipient"] ?? (signer ? await signer.getAddress() : null);

hr("PRE-FLIGHT CHECKS");
const wrapPlan = { needed: false, amount: 0n };
if (who) {
  const [tokBal, qtBal, natBal] = await Promise.all([
    tok.contract.balanceOf(who), qt.contract.balanceOf(who), provider.getBalance(who),
  ]);
  console.log(`wallet:          ${who}`);
  console.log(`  ${tok.symbol} balance:   ${fmt.units(tokBal, tok.decimals)}  (need ${fmt.units(tokenRaw, tok.decimals)}) ${tokBal >= tokenRaw ? "OK" : "INSUFFICIENT"}`);
  console.log(`  ${qt.symbol} balance:   ${fmt.units(qtBal, qt.decimals)}  (need ${fmt.units(quoteRaw, qt.decimals)}) ${qtBal >= quoteRaw ? "OK" : "INSUFFICIENT"}`);
  console.log(`  native balance: ${ethers.formatEther(natBal)} ${cfg.nativeSymbol} (gas)`);
  if (tokBal < tokenRaw) fail(`not enough ${tok.symbol} — bridge-mint the wFMX first`);
  if (qtBal < quoteRaw) {
    if (opts.quote.toLowerCase() === cfg.wrappedNative.toLowerCase() && natBal > quoteRaw - qtBal) {
      wrapPlan.needed = true;
      wrapPlan.amount = quoteRaw - qtBal;
      console.log(`  quote is ${cfg.wrappedNativeSymbol}: will wrap ${ethers.formatEther(wrapPlan.amount)} native via deposit()`);
    } else {
      fail(`not enough ${qt.symbol} in the wallet`);
    }
  }
} else {
  console.log("no PRIVATE_KEY/--lp-recipient given — skipping balance checks (dry run continues)");
}

// --- transaction plan -------------------------------------------------------
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
hr("TRANSACTION PLAN (in order)");
let step = 1;
if (wrapPlan.needed) console.log(`${step++}. ${cfg.wrappedNativeSymbol}.deposit{value: ${ethers.formatEther(wrapPlan.amount)}}()`);
if (!pairExists) console.log(`${step++}. factory.createPair(${tok.symbol}, ${qt.symbol})  -> deploys the pair contract`);
console.log(`${step++}. ${tok.symbol}.approve(router, ${fmt.units(tokenRaw, tok.decimals)})`);
console.log(`${step++}. ${qt.symbol}.approve(router, ${fmt.units(quoteRaw, qt.decimals)})`);
console.log(`${step++}. router.addLiquidity(${tok.symbol}, ${qt.symbol}, desired amounts above, mins above, to=${lpTo ?? "<signer>"}, deadline=+20min)`);
console.log(`\nexpected LP minted: ~${fmt.units(expectedLp, 18)} LP (UNI-V2 style, 18 decimals)`);
console.log("of which 1000 wei of LP is burned forever to the pair itself (MINIMUM_LIQUIDITY).");

// gas estimate for the first actionable step (a fresh state can't estimate later
// steps — they depend on earlier ones being mined)
try {
  const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
  console.log(`\ncurrent gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei ${cfg.nativeSymbol}`);
  if (!pairExists) {
    const est = await factory.createPair.estimateGas(opts.token, opts.quote).catch(() => null);
    if (est) console.log(`createPair estimateGas: ${est} (~${ethers.formatEther(est * gasPrice)} ${cfg.nativeSymbol})`);
  }
} catch { /* estimation is best-effort in dry runs */ }

if (!live) {
  hr("DRY RUN COMPLETE — NOTHING WAS SENT");
  console.log(
    "Rehearse the full broadcast against a local fork first:\n" +
      `  anvil --fork-url <${cfg.name} rpc> --port 860X   # then re-run with --rpc http://127.0.0.1:860X --broadcast --yes\n` +
      "or use scripts/fork-rehearsal.mjs which does the whole dance.\n" +
      "When rehearsed, re-run THIS command adding: --broadcast --yes  (with PRIVATE_KEY in env).",
  );
  process.exit(0);
}

// --- broadcast --------------------------------------------------------------
hr("BROADCASTING");
const routerW = router.connect(signer);
const factoryW = factory.connect(signer);
const tokW = tok.contract.connect(signer);
const qtW = qt.contract.connect(signer);

if (wrapPlan.needed) {
  const wn = new ethers.Contract(cfg.wrappedNative, WNATIVE_ABI, signer);
  await sendStep(`wrap ${ethers.formatEther(wrapPlan.amount)} ${cfg.nativeSymbol}`, wn.deposit({ value: wrapPlan.amount }));
}

let pairAddr = existingPair;
if (!pairExists) {
  // simulate before sending — a revert reason here costs nothing
  pairAddr = await factoryW.createPair.staticCall(opts.token, opts.quote);
  console.log(`  createPair simulation OK — pair will be ${pairAddr}`);
  await sendStep("createPair", factoryW.createPair(opts.token, opts.quote));
  const confirmed = await factory.getPair(opts.token, opts.quote);
  if (confirmed.toLowerCase() !== pairAddr.toLowerCase()) fail(`pair mismatch after create: ${confirmed}`);
  console.log(`  pair confirmed on-chain at ${pairAddr}`);
}

const me = await signer.getAddress();
if ((await tok.contract.allowance(me, cfg.router)) < tokenRaw)
  await sendStep(`approve ${tok.symbol}`, tokW.approve(cfg.router, tokenRaw));
else console.log(`  ${tok.symbol} allowance already sufficient`);
if ((await qt.contract.allowance(me, cfg.router)) < quoteRaw)
  await sendStep(`approve ${qt.symbol}`, qtW.approve(cfg.router, quoteRaw));
else console.log(`  ${qt.symbol} allowance already sufficient`);

// final simulation of the money step, then send
const args = [opts.token, opts.quote, tokenRaw, quoteRaw, tokenMin, quoteMin, lpTo, deadline()];
const sim = await routerW.addLiquidity.staticCall(...args);
console.log(`  addLiquidity simulation OK — would mint ${fmt.units(sim[2], 18)} LP`);
await sendStep("addLiquidity", routerW.addLiquidity(...args));

// --- resulting pool state ---------------------------------------------------
hr("RESULTING POOL STATE");
const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
const [t0, [r0, r1], lpSupply, lpBal] = await Promise.all([
  pair.token0(), pair.getReserves(), pair.totalSupply(), pair.balanceOf(lpTo),
]);
const tokIs0 = t0.toLowerCase() === opts.token.toLowerCase();
const [rTok, rQt] = tokIs0 ? [r0, r1] : [r1, r0];
const spot = Number(ethers.formatUnits(rQt, qt.decimals)) / Number(ethers.formatUnits(rTok, tok.decimals));
console.log(`pair:        ${pairAddr}`);
console.log(`token0:      ${t0} (${tokIs0 ? tok.symbol : qt.symbol})`);
console.log(`reserves:    ${fmt.units(rTok, tok.decimals)} ${tok.symbol} / ${fmt.units(rQt, qt.decimals)} ${qt.symbol}`);
console.log(`spot price:  ${spot.toPrecision(8)} ${qt.symbol} per ${tok.symbol}`);
console.log(`LP supply:   ${fmt.units(lpSupply, 18)} (1000 wei burned to the pair)`);
console.log(`LP held by ${lpTo}: ${fmt.units(lpBal, 18)} (${Number((lpBal * 1000000n) / lpSupply) / 10000}% of supply)`);
console.log(`\nNEXT STEP: lock that LP — scripts/lock-lp.mjs --chain ${opts.chain} --pair ${pairAddr} ... (see LOCKING.md). Unlocked LP in a wallet reads as rug risk to every buyer.`);
