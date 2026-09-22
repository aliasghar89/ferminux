// Pay-in v2 (multi-asset, multi-chain, web3): quote math, dust / unique-amount logic, route contract
// (assets, quote for stables + native across chains, v1 {usdc} alias, bounds, status view with explorer
// links), the CoinGecko price feed (with a PancakeSwap fallback for BNB/ETH, no fallback for POL/AVAX),
// and the watcher attributing ERC-20 logs + native block transactions through seen → confirmed with fake
// providers for two chains (bsc + arbitrum, different confirmation depths).
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, zeroPadValue, id as topicId } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import {
  PriceFeed, PAYIN_CHAINS, PAYIN_CHAIN_SLUGS, PAYIN_SPREAD_BPS, PAYIN_MIN_USD, PAYIN_MAX_USD,
  parseDecimalE, formatUnits, parseAmount, usdValueE18, fmxOutFor, pickUniqueUnits, checkUsdBounds, backfillPayinUnits,
} from "../dist/v3/payin.js";

const E18 = 10n ** 18n;
const HOT = new Wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"); // throwaway
const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const TRANSFER = topicId("Transfer(address,address,uint256)");

const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719", deployBlock: 0,
  dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1",
  payinRpcUrls: Object.fromEntries(PAYIN_CHAIN_SLUGS.map((c) => [c, "http://127.0.0.1:1"])),
  payinDeposits: {},
  webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9,
  payinHotKey: HOT.privateKey, payinPriceUsd: "0.52",
};

/** PriceFeed with CoinGecko stubbed off (forces the PancakeSwap fallback path for BNB/ETH, deterministically)
 * and the PancakeSwap reads stubbed: BNB 800 USD, ETH 2800 USD (via ETH/WBNB) and 2790 (ETH/USDT). */
class StubFeed extends PriceFeed {
  constructor(now) { super("http://127.0.0.1:1", { fixedPriceUsd: "0.52", now }); this.reads = 0; this.cgCalls = 0; }
  async fetchCoingecko() { this.cgCalls++; throw new Error("no network in tests"); }
  async readBnbUsd() { this.reads++; return 800n * E18; }
  async pairPrice(pair, token) {
    this.reads++;
    if (pair === "0x74E4716E431f45807DCF19f284c7aA99F18a4fbc") return (35n * E18) / 10n; // ETH = 3.5 BNB
    if (pair === "0x531FEbfeb9a61D948c384ACFBe6dCc51057AEa7e") return 2790n * E18;
    throw new Error("unexpected pair " + pair + " " + token);
  }
}

/** PriceFeed whose CoinGecko call succeeds, for POL/AVAX (which have no PancakeSwap fallback). */
class LiveStubFeed extends StubFeed {
  async fetchCoingecko() {
    this.cgCalls++;
    return { ethereum: { usd: 2800 }, binancecoin: { usd: 800 }, "matic-network": { usd: 0.4 }, "avalanche-2": { usd: 22.5 } };
  }
}

/** Fake chain: blocks with native txs + ERC-20 logs, head advances on demand. */
function fakeChain() {
  const st = { head: 1000, blocks: new Map(), logs: [], receipts: new Map(), blockCalls: [] };
  const provider = {
    async getBlockNumber() { return st.head; },
    async getLogs(f) { return st.logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock && f.address.map((a) => a.toLowerCase()).includes(l.address.toLowerCase())); },
    async getBlock(n, full) { st.blockCalls.push(n); assert.equal(full, true); return { number: n, prefetchedTransactions: st.blocks.get(n) ?? [] }; },
    async getTransactionReceipt(h) { return st.receipts.get(h) ?? { status: 1 }; },
    destroy() {},
  };
  return { st, provider };
}

async function setup(feed) {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  const priceFeed = feed ?? new StubFeed(() => nowMs);
  const chains = { bsc: fakeChain(), arbitrum: fakeChain() };
  const { app, v3, payin } = await buildServer({ db, cfg, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) }, v3: { priceFeed, payinProviderFor: (c) => chains[c]?.provider } });
  await app.ready();
  const inject = (method, url, body) => app.inject({ method, url, headers: { "content-type": "application/json" }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { app, db, v3, feed: priceFeed, chains, inject, watcher: payin, clock: { advance: (ms) => (nowMs += ms), s: () => Math.floor(nowMs / 1000) } };
}

test("quote math: decimals, USD value, spread, bounds", () => {
  assert.equal(parseDecimalE("10.00", 18), 10n * E18);
  assert.equal(parseDecimalE("0.000001", 6), 1n);
  assert.equal(parseDecimalE("0.0000001", 6), null, "more decimals than the token has");
  assert.equal(parseDecimalE("1e3", 18), null);
  assert.equal(formatUnits(10n * E18 + 1n, 18), "10.000000000000000001");
  assert.equal(formatUnits(2_500_000n, 6), "2.5");
  assert.equal(formatUnits(3n * E18, 18), "3.0");
  assert.throws(() => parseAmount("0", "USDC", 6), /positive/);
  assert.throws(() => parseAmount("abc", "BNB", 18), /BNB amount/);
  // 0.02 BNB at 800 USD = 16 USD
  assert.equal(usdValueE18(parseDecimalE("0.02", 18), 18, 800n * E18), 16n * E18);
  // 10 USDC on Ethereum/Base/Arbitrum/Polygon/Optimism/Avalanche (6 dec) = 10 USD
  assert.equal(usdValueE18(10_000_000n, 6, E18), 10n * E18);
  // 10 USD at 0.52 USD/FMX with 2 % spread = 18.846153… FMX
  const out = fmxOutFor(10n * E18, (52n * E18) / 100n);
  assert.equal(formatUnits(out, 18).slice(0, 9), "18.846153");
  assert.equal(PAYIN_SPREAD_BPS, 200n);
  assert.throws(() => checkUsdBounds((99n * E18) / 100n), /between 1 and 10000/);
  assert.throws(() => checkUsdBounds(10_001n * E18), /between/);
  checkUsdBounds(E18); checkUsdBounds(10_000n * E18);
  assert.equal(PAYIN_MIN_USD, 1); assert.equal(PAYIN_MAX_USD, 10_000);
});

test("dust: pickUniqueUnits steps DOWN past every open amount (never asks for more than the payer typed)", () => {
  const ten = 10n * E18;
  assert.equal(pickUniqueUnits(ten, []), ten);
  assert.equal(pickUniqueUnits(ten, [ten.toString()]), ten - 1n);
  assert.equal(pickUniqueUnits(ten, [ten.toString(), (ten - 1n).toString(), (ten - 2n).toString()]), ten - 3n);
  assert.equal(pickUniqueUnits(ten, [(ten - 1n).toString()]), ten, "only exact collisions matter");
  assert.equal(pickUniqueUnits(10_000_000n, ["10000000"]), 9_999_999n, "6-dec tokens lose one unit of dust, never gain one");
  // exhausted every unit down to 1 (practically impossible) → falls back to stepping up so it still returns > 0
  const allTaken = Array.from({ length: 10 }, (_, i) => String(i + 1)); // "1".."10"
  assert.equal(pickUniqueUnits(10n, allTaken), 11n, "downward room exhausted falls back to stepping up");
});

test("asset table: 7 chains, verified USDC/USDT addresses + decimals, native symbol + confirmations", () => {
  assert.deepEqual(PAYIN_CHAIN_SLUGS, ["eth", "bsc", "base", "arbitrum", "polygon", "optimism", "avalanche"]);
  const expect = {
    eth: { chainId: 1, native: "ETH", confirmations: 6, usdcDec: 6, usdtDec: 6 },
    bsc: { chainId: 56, native: "BNB", confirmations: 12, usdcDec: 18, usdtDec: 18 },
    base: { chainId: 8453, native: "ETH", confirmations: 20, usdcDec: 6, usdtDec: 6 },
    arbitrum: { chainId: 42161, native: "ETH", confirmations: 20, usdcDec: 6, usdtDec: 6 },
    polygon: { chainId: 137, native: "POL", confirmations: 60, usdcDec: 6, usdtDec: 6 },
    optimism: { chainId: 10, native: "ETH", confirmations: 20, usdcDec: 6, usdtDec: 6 },
    avalanche: { chainId: 43114, native: "AVAX", confirmations: 6, usdcDec: 6, usdtDec: 6 },
  };
  for (const [chain, e] of Object.entries(expect)) {
    const c = PAYIN_CHAINS[chain];
    assert.equal(c.chainId, e.chainId, chain);
    assert.equal(c.native, e.native, chain);
    assert.equal(c.confirmations, e.confirmations, chain);
    assert.equal(c.assets.USDC.decimals, e.usdcDec, `${chain} USDC decimals`);
    assert.equal(c.assets.USDT.decimals, e.usdtDec, `${chain} USDT decimals`);
    assert.equal(c.assets.USDC.kind, "erc20"); assert.equal(c.assets.USDT.kind, "erc20");
    assert.match(c.assets.USDC.address, /^0x[0-9a-fA-F]{40}$/, `${chain} USDC address`);
    assert.match(c.assets.USDT.address, /^0x[0-9a-fA-F]{40}$/, `${chain} USDT address`);
    assert.equal(c.assets[e.native].kind, "native");
  }
  // no address collisions across chains except where a chain legitimately shares one (none expected)
  const seen = new Set();
  for (const chain of PAYIN_CHAIN_SLUGS) for (const sym of ["USDC", "USDT"]) {
    const key = `${chain}:${PAYIN_CHAINS[chain].assets[sym].address.toLowerCase()}`;
    assert.ok(!seen.has(key)); seen.add(key);
  }
});

test("price feed: fixed FMX price wins, CoinGecko primary for all 4 native coins, PancakeSwap fallback for BNB/ETH, POL/AVAX have none", async () => {
  let now = 0;
  const feed = new StubFeed(() => now); // CoinGecko always throws in this stub
  assert.equal((await feed.price()).priceE18, (52n * E18) / 100n);
  assert.equal(await feed.assetUsd("USDC"), E18); assert.equal(await feed.assetUsd("USDT"), E18);
  assert.equal(await feed.assetUsd("BNB"), 800n * E18);
  assert.equal(await feed.assetUsd("ETH"), 2800n * E18);
  await assert.rejects(feed.nativeUsd("POL"), /price unavailable for POL/, "no PancakeSwap fallback for POL");
  await assert.rejects(feed.nativeUsd("AVAX"), /price unavailable for AVAX/, "no PancakeSwap fallback for AVAX");
  const reads = feed.reads;
  await feed.assetUsd("BNB"); await feed.assetUsd("ETH");
  assert.equal(feed.reads, reads, "cached");
  now += 61_000;
  await feed.assetUsd("BNB");
  assert.ok(feed.reads > reads, "refreshed after 60 s");
  // a manipulated ETH/WBNB pool is refused (fallback cross-check)
  class Bad extends StubFeed { async pairPrice(pair, t) { return pair === "0x74E4716E431f45807DCF19f284c7aA99F18a4fbc" ? 5n * E18 : super.pairPrice(pair, t); } }
  await assert.rejects(new Bad(() => 0).assetUsd("ETH"), /disagree/);
  feed.destroy();

  // CoinGecko available → prices every native coin from one call, including POL/AVAX
  const live = new LiveStubFeed(() => 0);
  assert.equal(await live.nativeUsd("POL"), 4n * E18 / 10n);
  assert.equal(await live.nativeUsd("AVAX"), (225n * E18) / 10n);
  assert.equal(await live.nativeUsd("BNB"), 800n * E18);
  assert.equal(live.cgCalls, 1, "one CoinGecko call prices BNB too (cached), no PancakeSwap read needed");
  assert.equal(live.reads, 0, "PancakeSwap fallback never touched when CoinGecko answers");
  live.destroy();
});

test("routes: assets across 7 chains, stable + native quotes, v1 alias, dust on collision, bounds, status view", async (t) => {
  const { app, inject, clock, db } = await setup();
  t.after(() => app.close());
  const assets = (await inject("GET", "/api/payin/assets")).json();
  assert.equal(assets.enabled, true);
  assert.equal(assets.priceUsdPerFmx, "0.52");
  assert.deepEqual(assets.chains.map((c) => c.chain), ["eth", "bsc", "base", "arbitrum", "polygon", "optimism", "avalanche"]);
  for (const c of assets.chains) assert.deepEqual(c.assets.map((a) => a.symbol).sort(), [PAYIN_CHAINS[c.chain].native, "USDC", "USDT"].sort());
  assert.equal(assets.chains.find((c) => c.chain === "bsc").depositAddress, HOT.address);
  assert.equal(assets.chains.find((c) => c.chain === "eth").confirmations, 6);
  assert.equal(assets.chains.find((c) => c.chain === "polygon").confirmations, 60);
  assert.equal(assets.chains.find((c) => c.chain === "avalanche").confirmations, 6);
  assert.equal(assets.chains.find((c) => c.chain === "base").confirmations, 20);
  assert.equal(assets.chains.find((c) => c.chain === "optimism").confirmations, 20);
  assert.equal(assets.chains.find((c) => c.chain === "optimism").explorer, "https://optimistic.etherscan.io");
  assert.equal(assets.chains.find((c) => c.chain === "avalanche").explorer, "https://snowtrace.io");

  const carol = Wallet.createRandom(); const dave = Wallet.createRandom();

  // USDT on Ethereum, 6 decimals
  const q1 = await inject("POST", "/api/payin/quote", { chain: "eth", asset: "usdt", amount: "10", to: alice.address, from: bob.address });
  assert.equal(q1.statusCode, 201, q1.body);
  const j1 = q1.json();
  assert.equal(j1.asset, "USDT"); assert.equal(j1.token, PAYIN_CHAINS.eth.assets.USDT.address); assert.equal(j1.decimals, 6);
  assert.equal(j1.sendExactly, "10000000"); assert.equal(j1.amount, "10.0"); assert.equal(j1.dustUnits, "0"); assert.equal(j1.dustDirection, "none");
  assert.equal(j1.usd, "10.0"); assert.equal(j1.assetUsd, "1.0"); assert.equal(j1.priceUsdPerFmx, "0.52");
  assert.equal(j1.fmxOutFormatted.slice(0, 9), "18.846153");
  assert.equal(j1.expiresAt, clock.s() + 900); assert.equal(j1.expires, 900); assert.equal(j1.chainId, 1);
  assert.equal(j1.confirmations, 6); assert.equal(j1.explorer, "https://etherscan.io"); assert.equal(j1.usdc, undefined);
  // same target (alice), NO payer declared → never supersedes j1 (supersede is strictly payer===payer; see
  // the dedicated "supersede" test — matching by recipient alone was the fixed 2026-09-22 vulnerability). This
  // collides with j1's amount instead and steps DOWN, never up, so the payer is never asked to send more than
  // they typed (verified 2026-09-22: an add-dust quote for exactly a payer's whole 5.0 USDT balance made their
  // wallet revert the transfer).
  const j2 = (await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDT", amount: "10", to: alice.address })).json();
  assert.equal(j2.sendExactly, "9999999"); assert.equal(j2.amount, "9.999999"); assert.equal(j2.dustUnits, "1"); assert.equal(j2.dustDirection, "down");
  assert.equal((await inject("GET", `/api/payin/${j1.quoteId}`)).json().status, "quoted", "j1 is untouched — no payer declared on j2, so nothing can supersede");
  // a THIRD request (still no payer, a different target) collides with both j1 and j2 and steps down again
  const j2b = (await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDT", amount: "10", to: bob.address })).json();
  assert.equal(j2b.sendExactly, "9999998"); assert.equal(j2b.amount, "9.999998"); assert.equal(j2b.dustUnits, "2"); assert.equal(j2b.dustDirection, "down");
  assert.equal(j2b.amountRequested, "10.0");
  assert.match(j2b.note, /less than you asked for/);
  // other chain / asset: no collision
  const j3 = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDT", amount: "10", to: alice.address })).json();
  assert.equal(j3.sendExactly, (10n * E18).toString()); assert.equal(j3.decimals, 18); assert.equal(j3.confirmations, 12);
  // v1 alias {usdc}
  const v1 = (await inject("POST", "/api/payin/quote", { chain: "bsc", usdc: "25.50", to: alice.address })).json();
  assert.equal(v1.asset, "USDC"); assert.equal(v1.usdc, "25.5"); assert.equal(v1.usdcToken, PAYIN_CHAINS.bsc.assets.USDC.address); assert.equal(v1.usdcDecimals, 18);
  assert.equal(v1.sendExactly, (255n * E18) / 10n + "");
  // native BNB: 0.02 BNB at 800 USD = 16 USD → 16 × 0.98 / 0.52 FMX
  const bnb = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "BNB", amount: "0.02", to: alice.address })).json();
  assert.equal(bnb.assetKind, "native"); assert.equal(bnb.token, null); assert.equal(bnb.usd, "16.0"); assert.equal(bnb.assetUsd, "800.0");
  assert.equal(bnb.sendExactly, (2n * E18) / 100n + "");
  assert.equal(bnb.fmxOutFormatted.slice(0, 9), "30.153846");
  assert.match(bnb.note, /EOA/);
  // native ETH on Arbitrum: 0.001 ETH = 2.8 USD, 20 confirmations required
  const eth = (await inject("POST", "/api/payin/quote", { chain: "arbitrum", asset: "ETH", amount: "0.001", to: alice.address })).json();
  assert.equal(eth.usd, "2.8"); assert.equal(eth.assetUsd, "2800.0"); assert.equal(eth.confirmations, 20); assert.equal(eth.chainId, 42161);
  // bounds in USD equivalent
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "BNB", amount: "0.001", to: alice.address })).statusCode, 400, "0.8 USD");
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "arbitrum", asset: "ETH", amount: "4", to: alice.address })).statusCode, 400, "11,200 USD");
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDC", amount: "0.5", to: alice.address })).statusCode, 400);
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDC", amount: "10000.000001", to: alice.address })).statusCode, 400);
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "eth", asset: "BNB", amount: "1", to: alice.address })).statusCode, 400, "BNB is not on Ethereum");
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDC", amount: "1.0000001", to: alice.address })).statusCode, 400, "7 decimals on a 6-dec token");
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDC", amount: "5", to: "nope" })).statusCode, 400);
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "solana", asset: "USDC", amount: "5", to: alice.address })).statusCode, 400, "unknown chain");
  // POL/AVAX have no PancakeSwap fallback → 503 when CoinGecko is down (this test's StubFeed always throws)
  const pol503 = await inject("POST", "/api/payin/quote", { chain: "polygon", asset: "POL", amount: "10", to: alice.address });
  assert.equal(pol503.statusCode, 503);
  const avax503 = await inject("POST", "/api/payin/quote", { chain: "avalanche", asset: "AVAX", amount: "1", to: alice.address });
  assert.equal(avax503.statusCode, 503);
  // a stable on Polygon doesn't need a native price at all, even though POL itself is unpriced right now
  const pol = (await inject("POST", "/api/payin/quote", { chain: "polygon", asset: "USDC", amount: "5", to: alice.address })).json();
  assert.equal(pol.confirmations, 60); assert.equal(pol.chainId, 137);

  // status view (j2b carries the subtracted dust)
  const s = (await inject("GET", `/api/payin/${j2b.quoteId}`)).json();
  assert.equal(s.status, "quoted"); assert.equal(s.asset, "USDT"); assert.equal(s.sendExactly, "9999998"); assert.equal(s.sendExactlyFormatted, "9.999998");
  assert.equal(s.usd, "9.999998"); assert.equal(s.fmxOutFormatted.slice(0, 5), "18.84"); assert.equal(s.required, 6);
  assert.deepEqual(s.txHashes, { deposit: null, fmx: null }); assert.equal(s.enabled, true);
  // still-open quotes (j1: 10000000, j2: 9999999, j2b: 9999998) reserve their amount for 10 min past expiry;
  // a fresh target (dave) that collides with all three steps down three times
  clock.advance(16 * 60_000);
  const late = (await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDT", amount: "10", to: dave.address })).json();
  assert.equal(late.sendExactly, "9999997", "10 min grace keeps j1's, j2's and j2b's amounts reserved"); assert.equal(late.dustDirection, "down");
  // past the grace, j1/j2/j2b no longer reserve their amount — a fresh target (carol) gets it clean again
  // (late's own row, still active with a different target, is untouched and doesn't collide with 10000000)
  clock.advance(11 * 60_000);
  const later = (await inject("POST", "/api/payin/quote", { chain: "eth", asset: "USDT", amount: "10", to: carol.address })).json();
  assert.equal(later.sendExactly, "10000000", "after the grace the exact amount is free again"); assert.equal(later.dustDirection, "none");
  // v1 rows without amountUnits are back-filled at boot
  db.prepare("INSERT INTO payins (quoteId, chain, usdc, usdcUnits, fmxOut, priceUsdPerFmx, target, depositAddress, status, createdAt, expiresAt) VALUES ('q_v1', 'bsc', '12.5', '12500000', '1', '0.52', ?, ?, 'quoted', 1, 2)").run(alice.address, HOT.address);
  backfillPayinUnits(db);
  const v1row = db.prepare("SELECT asset, amount, amountUnits, usd FROM payins WHERE quoteId = 'q_v1'").get();
  assert.deepEqual(v1row, { asset: "USDC", amount: "12.5", amountUnits: (125n * E18) / 10n + "", usd: "12.5" });
});

test("supersede (2026-09-22 security fix): matches ONLY the same declared payer, never `to` alone; a deposit still lands correctly on a superseded quote; an undeclared/mismatched sender never falls back to an arbitrary candidate", async (t) => {
  const { app, inject, db, chains, watcher } = await setup();
  t.after(() => app.close());
  const { st: bsc } = chains.bsc;
  const log = (address, from, units, blockNumber, i) => ({ address, topics: [TRANSFER, zeroPadValue(from, 32), zeroPadValue(HOT.address, 32)], data: "0x" + units.toString(16).padStart(64, "0"), transactionHash: "0x" + (i + 200).toString(16).padStart(64, "0"), index: i, blockNumber });

  const q1 = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "5", to: alice.address, from: alice.address })).json();
  assert.equal(q1.sendExactly, (5n * E18).toString()); assert.equal(q1.dustDirection, "none");
  // SAME payer (alice), a DIFFERENT `to` AND a different amount (so it doesn't just reclaim q1's own freed
  // amount, which would make the deposit-attribution check below ambiguous) — still supersedes: matching is
  // by payer identity, never by recipient.
  const q2 = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "7", to: bob.address, from: alice.address })).json();
  assert.equal((await inject("GET", `/api/payin/${q1.quoteId}`)).json().status, "superseded", "same payer (alice), different `to` — still superseded");
  assert.equal(q2.sendExactly, (7n * E18).toString(), "q2 gets its own clean amount, not dusted against q1");

  // The fixed vulnerability: an unauthenticated request naming a VICTIM's address as `to`, with no payer of
  // its own (or a different declared payer), must NEVER supersede the victim's real open quote.
  const victim = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDT", amount: "3", to: alice.address, from: alice.address })).json();
  const attackNoPayer = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDT", amount: "3", to: alice.address })).json();
  assert.equal((await inject("GET", `/api/payin/${victim.quoteId}`)).json().status, "quoted", "no payer declared on the attacker's request → victim's quote is untouched");
  assert.equal(attackNoPayer.sendExactly, (3n * E18 - 1n).toString(), "attacker's request collides with the victim's amount and is dusted down, never supersedes");
  await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDT", amount: "3", to: alice.address, from: bob.address }); // a DIFFERENT declared payer
  assert.equal((await inject("GET", `/api/payin/${victim.quoteId}`)).json().status, "quoted", "a different declared payer → victim's quote is still untouched");

  // Even so, the victim's real deposit still lands: attribution considers 'superseded' rows too. Simulate a
  // stranger (dead address) paying q1's exact amount, then the real payer (alice) doing the same.
  bsc.head = 1001;
  bsc.logs.push(log(PAYIN_CHAINS.bsc.assets.USDC.address, "0x000000000000000000000000000000000000dEaD", BigInt(q1.sendExactly), 1001, 0));
  bsc.logs.push(log(PAYIN_CHAINS.bsc.assets.USDC.address, alice.address, BigInt(q1.sendExactly), 1001, 1));
  await watcher.tick();
  const q1Status = (await inject("GET", `/api/payin/${q1.quoteId}`)).json();
  assert.equal(q1Status.status, "seen", "q1 is superseded but still receives its own deposit — superseding never loses funds");
  assert.equal(q1Status.txHashIn, "0x" + (1 + 200).toString(16).padStart(64, "0"), "matched alice's transfer, not the stranger's identical-amount one");
  assert.equal(db.prepare("SELECT quoteId FROM payin_transfers WHERE txHash = ?").get("0x" + (0 + 200).toString(16).padStart(64, "0")).quoteId, null, "the stranger's deposit (q1 declares payer=alice) never falls back to an arbitrary candidate");

  // simulate a deposit already seen on chain for q2 (bypassing the watcher for a direct, deterministic check)
  db.prepare("UPDATE payins SET status = 'seen', txHashIn = ?, blockIn = 100, seenAt = 1 WHERE quoteId = ?").run("0x" + "ab".repeat(32), q2.quoteId);
  // a third request from the SAME payer (alice) for the same chain+asset must NOT touch q2 — its money may
  // already be in flight to it — even though q2's exact amount is otherwise a perfectly normal, un-dusted quote
  const q3 = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "5", to: alice.address, from: alice.address })).json();
  assert.equal((await inject("GET", `/api/payin/${q2.quoteId}`)).json().status, "seen", "q2 (already seen on chain) is left alone, not superseded");
  assert.equal(q3.sendExactly, (5n * E18).toString(), "q3 is unrelated to q2 (which is no longer 'quoted', so no collision) and gets a clean amount");
});

test("watcher: ERC-20 logs for both stables + native block scan → seen → confirmed on two chains (bsc 12 conf, arbitrum 20 conf), payer preference, dust attribution", async (t) => {
  const { app, inject, chains, clock, db, watcher } = await setup();
  t.after(() => app.close());
  const { st: bsc } = chains.bsc;
  const { st: arb } = chains.arbitrum;
  // two open BNB quotes with the same requested amount, different targets (no supersede) → dust distinguishes
  // them, SUBTRACTED from the second one (never added)
  const a = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "BNB", amount: "0.05", to: alice.address, from: alice.address })).json();
  const b = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "BNB", amount: "0.05", to: bob.address })).json();
  assert.equal(BigInt(a.sendExactly) - BigInt(b.sendExactly), 1n);
  // USDT on Arbitrum + USDC on BSC
  const u = (await inject("POST", "/api/payin/quote", { chain: "arbitrum", asset: "USDT", amount: "7.25", to: alice.address })).json();
  const c = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "3", to: bob.address })).json();

  // first tick: nothing on chain yet → native cursor parks at head, ERC-20 cursor at head
  await watcher.tick();
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'payin:bsc:lastNativeBlock'").get().value, "1000");
  // block 1001: bob pays b's exact amount (dusted) from bob (b has no declared payer, so any sender matches);
  // a stranger pays a's exact amount — but a declares payer=alice, so this must NOT match (security fix,
  // 2026-09-22: it used to fall back to an arbitrary candidate); alice (a's real declared payer) then pays the
  // same amount and correctly matches; also an unrelated tx and a reverted one.
  bsc.head = 1001;
  bsc.blocks.set(1001, [
    { hash: "0x" + "b1".repeat(32), from: bob.address, to: HOT.address.toLowerCase(), value: BigInt(b.sendExactly) },
    { hash: "0x" + "a1".repeat(32), from: "0x000000000000000000000000000000000000dEaD", to: HOT.address, value: BigInt(a.sendExactly) },
    { hash: "0x" + "a2".repeat(32), from: alice.address, to: HOT.address, value: BigInt(a.sendExactly) },
    { hash: "0x" + "cc".repeat(32), from: bob.address, to: alice.address, value: BigInt(a.sendExactly) },
    { hash: "0x" + "dd".repeat(32), from: bob.address, to: HOT.address, value: BigInt(a.sendExactly) },
  ]);
  bsc.receipts.set("0x" + "dd".repeat(32), { status: 0 });
  // ERC-20: USDC log on BSC for c, USDT log on Arbitrum for u (both in the deposit topic)
  const log = (address, from, units, blockNumber, i) => ({ address, topics: [TRANSFER, zeroPadValue(from, 32), zeroPadValue(HOT.address, 32)], data: "0x" + units.toString(16).padStart(64, "0"), transactionHash: "0x" + (i + 10).toString(16).padStart(64, "0"), index: i, blockNumber });
  bsc.logs.push(log(PAYIN_CHAINS.bsc.assets.USDC.address, bob.address, BigInt(c.sendExactly), 1001, 0));
  bsc.logs.push(log(PAYIN_CHAINS.bsc.assets.USDT.address, bob.address, BigInt(c.sendExactly), 1001, 1)); // wrong token → unmatched
  arb.head = 2001;
  arb.logs.push(log(PAYIN_CHAINS.arbitrum.assets.USDT.address, alice.address, BigInt(u.sendExactly), 2001, 0));
  await watcher.tick();
  const st = async (id) => (await inject("GET", `/api/payin/${id}`)).json();
  const sa = await st(a.quoteId), sb = await st(b.quoteId), su = await st(u.quoteId), sc = await st(c.quoteId);
  assert.equal(sb.status, "seen"); assert.equal(sb.txHashIn, "0x" + "b1".repeat(32)); assert.equal(sb.payer, bob.address); assert.equal(sb.confirmations, 1);
  assert.equal(sa.status, "seen"); assert.equal(sa.txHashIn, "0x" + "a2".repeat(32), "a declares payer=alice — only alice's transfer matched, not the stranger's identical-amount deposit");
  assert.equal(su.status, "seen"); assert.equal(su.txHashes.deposit.url, "https://arbiscan.io/tx/" + su.txHashIn);
  assert.equal(sc.status, "seen"); assert.equal(sc.txHashes.deposit.chainId, 56);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM payin_transfers WHERE quoteId IS NULL").get().c, 2, "the USDT log with USDC's amount, and the stranger's wrong-payer deposit, both stay unattributed");
  assert.equal(db.prepare("SELECT asset FROM payin_transfers WHERE txHash = ?").get("0x" + "b1".repeat(32)).asset, "BNB");
  // confirmations: BSC needs 12, Arbitrum needs 20 — advance BSC's head 12 blocks (confirms) but Arbitrum only 12 (not yet)
  bsc.head = 1012; arb.head = 2012;
  await watcher.tick();
  for (const id of [a.quoteId, b.quoteId, c.quoteId]) {
    const s = await st(id);
    assert.equal(s.status, "confirmed", id); assert.equal(s.confirmations, 12); assert.ok(s.error, "payout attempted and recorded its failure");
  }
  const suMid = await st(u.quoteId);
  assert.equal(suMid.status, "seen", "arbitrum requires 20 confirmations, only 12 seen so far"); assert.equal(suMid.confirmations, 12);
  arb.head = 2020;
  await watcher.tick();
  const suDone = await st(u.quoteId);
  assert.equal(suDone.status, "confirmed"); assert.equal(suDone.confirmations, 20);
  // a quote that nobody paid expires 10 min after expiresAt
  const z = (await inject("POST", "/api/payin/quote", { chain: "arbitrum", asset: "USDC", amount: "2", to: alice.address })).json();
  clock.advance(26 * 60_000);
  await watcher.tick();
  assert.equal((await st(z.quoteId)).status, "expired");
  // native scan is skipped while no native quote is open (no full-block fetches after the confirmed ones)
  const calls = bsc.blockCalls.length;
  bsc.head = 1013;
  await watcher.tick();
  assert.equal(bsc.blockCalls.length, calls);
});

test("payout: crash-safe hot-wallet nonce reservation (mirrors ReferralPayout.transfer) — reserved before sending, recovered from chain on restart, never double-paid", async (t) => {
  const { app, db, v3, watcher } = await setup();
  t.after(() => app.close());
  const ins = db.prepare(
    "INSERT INTO payins (quoteId, chain, usdc, usdcUnits, fmxOut, priceUsdPerFmx, target, depositAddress, status, createdAt, expiresAt, seenAt, payoutNonce) VALUES (?, 'bsc', '5', '5000000', ?, '0.52', ?, ?, 'confirmed', 1, 900, 1, ?)",
  );
  v3.provider.getBalance = async () => 10n ** 20n; // plenty of FMX

  // row 1: no nonce reserved yet — payout() must reserve the wallet's next ("pending") nonce and send with it
  ins.run("q_payout1", (1n * E18).toString(), alice.address, HOT.address, null);
  let sent = [];
  v3.provider.getTransactionCount = async (_addr, tag) => (tag === "pending" ? 7 : 6);
  v3.payinHot.sendTransaction = async (tx) => { sent.push(tx.nonce); return { hash: `0xsent${tx.nonce}` }; };
  await watcher.tick();
  assert.deepEqual(sent, [7]);
  let r1 = db.prepare("SELECT status, txHashOut, payoutNonce FROM payins WHERE quoteId = 'q_payout1'").get();
  assert.equal(r1.status, "paid"); assert.equal(r1.txHashOut, "0xsent7"); assert.equal(r1.payoutNonce, 7);

  // row 2: nonce 8 was already reserved (simulating a crash between send and the 'paid' write) and the chain
  // shows it has since been included (latest > 8) — must be recovered, NEVER re-sent
  ins.run("q_payout2", (2n * E18).toString(), bob.address, HOT.address, 8);
  sent = [];
  v3.provider.getTransactionCount = async (_addr, tag) => (tag === "pending" ? 9 : 9); // latest=9 > reserved 8
  await watcher.tick();
  assert.deepEqual(sent, [], "nonce 8 was already mined — recovered, never resent");
  let r2 = db.prepare("SELECT status, txHashOut FROM payins WHERE quoteId = 'q_payout2'").get();
  assert.equal(r2.status, "paid"); assert.equal(r2.txHashOut, "recovered:nonce:8");

  // row 3: nonce 9 was reserved but has NOT landed yet (latest is not > 9) — must be (re-)sent with that SAME
  // reserved nonce, never a freshly-fetched one (that would double-spend if the first send does land later)
  ins.run("q_payout3", (3n * E18).toString(), bob.address, HOT.address, 9);
  sent = [];
  v3.provider.getTransactionCount = async (_addr, tag) => (tag === "pending" ? 10 : 9); // latest still 9, not > 9
  await watcher.tick();
  assert.deepEqual(sent, [9], "not yet mined — resent with the SAME reserved nonce, not a new one");
  let r3 = db.prepare("SELECT status, txHashOut, payoutNonce FROM payins WHERE quoteId = 'q_payout3'").get();
  assert.equal(r3.status, "paid"); assert.equal(r3.txHashOut, "0xsent9"); assert.equal(r3.payoutNonce, 9);
});
