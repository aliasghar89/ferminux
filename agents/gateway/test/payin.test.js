// Pay-in v2 (multi-asset, multi-chain, web3): quote math, dust / unique-amount logic, route contract
// (assets, quote for stables + native across chains, v1 {usdc} alias, bounds, status view with explorer
// links), the CoinGecko price feed (with a PancakeSwap fallback for BNB/ETH, no fallback for POL/AVAX), the
// FMX market reference (the Ferminux DEX first, PancakeSwap's wFMX pool second, with the bridge's live state),
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
  priceDexPool, bridgeStateFrom, dexSwapUrl,
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
  constructor(now) { super("http://127.0.0.1:1", { fixedPriceUsd: "0.52", now, ferminuxRpcUrl: "http://127.0.0.1:1" }); this.reads = 0; this.cgCalls = 0; }
  async fetchCoingecko() { this.cgCalls++; throw new Error("no network in tests"); }
  // chain 3961 and the bridge report are never reached from tests unless a test stubs them in
  async readDexPools() { throw new Error("no chain 3961 in tests"); }
  async fetchBridgeStatus() { throw new Error("no network in tests"); }
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

/** Every chain gets a fake provider. A chain is only offered once its scanner has completed a scan, so by
 * default setup runs one watcher tick; `{ prime: false }` starts from a boot that has not scanned yet. */
async function setup(feed, { prime = true, cfg: over = {} } = {}) {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  const priceFeed = feed ?? new StubFeed(() => nowMs);
  const chains = Object.fromEntries(PAYIN_CHAIN_SLUGS.map((c) => [c, fakeChain()]));
  const { app, v3, payin } = await buildServer({ db, cfg: { ...cfg, ...over }, workers: false, logger: false, commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) }, v3: { priceFeed, payinProviderFor: (c) => chains[c]?.provider } });
  await app.ready();
  if (prime) await payin.tick();
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

// 2026-09-24 audit: eth/bsc/polygon scanners had failed every poll since launch (dead RPC defaults, bsc-dataseed
// refusing eth_getLogs) while /api/payin/assets, the quote route and /api/status all said ok. The rule is now
// positive: a chain is offered only after its scanner has COMPLETED a scan, recently.
test("scanner health: nothing is offered before a completed scan; a failing getLogs keeps the native scan running, marks the chain unavailable after 3 polls (assets, quote 503, status) and halves the range; recovery resumes from the cursor and finds the deposit made during the outage", async (t) => {
  const { app, inject, chains, watcher, clock } = await setup(undefined, { prime: false });
  t.after(() => app.close());
  const { st: bsc, provider } = chains.bsc;

  // a fresh boot has not scanned anything yet: no chain may take money
  let assets = (await inject("GET", "/api/payin/assets")).json();
  assert.deepEqual(assets.availableChains, []);
  assert.ok(assets.chains.every((c) => c.available === false && /not completed a scan/.test(c.unavailableReason)));
  let refused = await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDT", amount: "5", to: alice.address });
  assert.equal(refused.statusCode, 503);
  assert.match(refused.json().error, /not completed a scan yet/);
  assert.match(watcher.chainHealth("bsc").reason, /not completed a scan/);

  // one completed scan → offered
  await watcher.tick();
  assert.equal(watcher.chainHealth("bsc").ok, true);
  assert.equal(watcher.chainHealth("bsc").reason, null);
  assert.equal((await inject("GET", "/api/payin/assets")).json().availableChains.length, 7);

  let logsFail = true;
  const ranges = [];
  const realGetLogs = provider.getLogs.bind(provider);
  provider.getLogs = async (f) => { ranges.push(f.toBlock - f.fromBlock + 1); if (logsFail) throw new Error('{"code":-32005,"message":"limit exceeded"}'); return realGetLogs(f); };
  const usdt = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDT", amount: "5", to: alice.address, from: bob.address })).json();
  const bnb = (await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "BNB", amount: "0.05", to: alice.address, from: bob.address })).json();
  assert.ok(usdt.quoteId && bnb.quoteId);

  // a BNB deposit lands while getLogs is refused: the native scan must still see it
  bsc.head = 1001;
  bsc.blocks.set(1001, [{ hash: "0x" + "e1".repeat(32), from: bob.address, to: HOT.address, value: BigInt(bnb.sendExactly) }]);
  await watcher.tick();
  assert.equal((await inject("GET", `/api/payin/${bnb.quoteId}`)).json().status, "seen", "native deposit seen even though the ERC-20 getLogs failed");
  let h = watcher.chainHealth("bsc");
  assert.equal(h.consecutiveFailures, 1);
  assert.equal(h.ok, true, "one failed poll after a recent completed scan is not an outage");
  assert.match(h.lastError, /limit exceeded/);

  // the USDT deposit is made during the outage; the head runs well ahead of the scanner's cursor
  bsc.head = 4000;
  bsc.logs.push({ address: PAYIN_CHAINS.bsc.assets.USDT.address, topics: [TRANSFER, zeroPadValue(bob.address, 32), zeroPadValue(HOT.address, 32)], data: "0x" + BigInt(usdt.sendExactly).toString(16).padStart(64, "0"), transactionHash: "0x" + "f1".repeat(32), index: 0, blockNumber: 1800 });
  ranges.length = 0;
  await watcher.tick();
  await watcher.tick();
  h = watcher.chainHealth("bsc");
  assert.equal(h.ok, false, "3 failed polls in a row → unavailable");
  assert.match(h.reason, /failed its last 3 scans/);
  assert.deepEqual(ranges, [1000, 500], "the range halves on each refusal");
  assert.equal(h.chunkBlocks, 250);

  assets = (await inject("GET", "/api/payin/assets")).json();
  const bscRow = assets.chains.find((c) => c.chain === "bsc");
  assert.equal(bscRow.available, false);
  assert.match(bscRow.unavailableReason, /scanner/);
  assert.ok(!assets.availableChains.includes("bsc"));
  assert.ok(assets.availableChains.includes("arbitrum"), "a healthy chain stays available");
  refused = await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "5", to: alice.address });
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().unavailable, true);
  assert.ok(refused.json().availableChains.includes("arbitrum"));
  const s = (await inject("GET", "/api/status")).json(); // read once: /api/status caches its answer
  assert.equal(s.services.payin.ok, false);
  assert.ok(s.degraded.includes("payin"));
  assert.ok(s.services.payin.unavailableChains.includes("bsc"));
  assert.equal(s.services.payin.chains.bsc.consecutiveFailures, 3);
  assert.match(s.services.payin.chains.bsc.reason, /failed its last 3 scans/);
  assert.equal(s.services.payin.chains.arbitrum.ok, true);

  // recovery: the scan resumes from its cursor (it never advanced while failing), so the outage deposit is found
  logsFail = false;
  clock.advance(60_000);
  await watcher.tick();
  h = watcher.chainHealth("bsc");
  assert.equal(h.ok, true);
  assert.equal(h.consecutiveFailures, 0);
  const u = (await inject("GET", `/api/payin/${usdt.quoteId}`)).json();
  assert.equal(u.status, "confirmed", "the deposit made during the outage is attributed (and already deep enough) once the scanner recovers");
  assert.equal(u.txHashIn, "0x" + "f1".repeat(32));
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "5", to: alice.address })).statusCode, 201);
});

test("scanner health: a scanner that stops completing scans without ever throwing (a hung RPC) goes stale and is withdrawn", async (t) => {
  const { app, inject, watcher, clock } = await setup(undefined, { cfg: { payinPollMs: 20_000 } }); // stale after max(300 s, 3 polls)
  t.after(() => app.close());
  assert.equal(watcher.chainHealth("base").ok, true);
  clock.advance(299_000);
  assert.equal(watcher.chainHealth("base").ok, true, "inside the 300 s window");
  clock.advance(2_000); // no tick completed for 301 s, and not a single error recorded
  const h = watcher.chainHealth("base");
  assert.equal(h.ok, false);
  assert.equal(h.consecutiveFailures, 0);
  assert.match(h.reason, /last completed scan is 301 s old/);
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "base", asset: "USDC", amount: "5", to: alice.address })).statusCode, 503);
  assert.deepEqual((await inject("GET", "/api/payin/assets")).json().availableChains, []);
  await watcher.tick();
  assert.equal(watcher.chainHealth("base").ok, true, "a completed scan brings it back");
});

test("first scan with no cursor still backfills from the oldest recent quote (a quote row that predates the cursor, e.g. issued by an older build) instead of head-200", async (t) => {
  const { app, db, inject, chains, watcher, clock } = await setup(undefined, { prime: false });
  t.after(() => app.close());
  const { st: bsc, provider } = chains.bsc;
  const ranges = [];
  const realGetLogs = provider.getLogs.bind(provider);
  provider.getLogs = async (f) => { ranges.push([f.fromBlock, f.toBlock]); return realGetLogs(f); };
  const units = 5n * E18;
  const t0 = clock.s() - 600; // quoted 10 minutes ago
  db.prepare("INSERT INTO payins (quoteId, chain, usdc, usdcUnits, asset, amount, amountUnits, usd, fmxOut, priceUsdPerFmx, target, payer, depositAddress, status, createdAt, expiresAt) VALUES ('q_legacy', 'bsc', '5.0', '5000000', 'USDT', '5.0', ?, '5.0', ?, '0.52', ?, ?, ?, 'quoted', ?, ?)")
    .run(units.toString(), (9n * E18).toString(), alice.address, bob.address, HOT.address, t0, t0 + 900);
  bsc.head = 100_000;
  bsc.logs.push({ address: PAYIN_CHAINS.bsc.assets.USDT.address, topics: [TRANSFER, zeroPadValue(bob.address, 32), zeroPadValue(HOT.address, 32)], data: "0x" + units.toString(16).padStart(64, "0"), transactionHash: "0x" + "a7".repeat(32), index: 0, blockNumber: 98_700 });
  await watcher.tick();
  assert.equal(ranges[0][0], 100_000 - Math.ceil((600 + 600) / 0.45) + 1, "starts from the quote's age (+10 min margin) in BSC blocks, not head-200");
  assert.equal((await inject("GET", "/api/payin/q_legacy")).json().status, "confirmed");
});

// The live WFMX/AZNT pool on the Ferminux DEX as read on 2026-09-26: 138,767.18… WFMX against 45,100 AZNT.
const DEX_AZNT_PAIR = "0xbab12e7B817F0686e11949eC06697235DC146845";
const AZNT = "0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178";
const USDF = "0xCd032A609e34121D1881E8DE7355b2c2c7092363";
const LIVE_AZNT_POOL = { pair: DEX_AZNT_PAIR, quoteToken: AZNT, reserveW: 138767184453857319492643n, reserveQ: 45_100_000_000n, lastTradeAt: 1_787_791_430 };
const AZN_USD_E18 = 10n ** 20n / 170n; // 1 USD = 1.70 AZN

test("Ferminux DEX pool pricing: quote-token price, USD through the peg, depth; unknown or empty pools are not priced", () => {
  const p = priceDexPool(LIVE_AZNT_POOL, 1_000);
  const inQuote = (45_100_000_000n * E18 * E18) / (10n ** 6n * 138767184453857319492643n);
  assert.equal(p.priceInQuoteE18, inQuote);
  assert.equal(formatUnits(p.priceInQuoteE18, 18).slice(0, 6), "0.3250", "0.3250 AZNT per FMX");
  assert.equal(p.priceE18, (inQuote * AZN_USD_E18) / E18);
  assert.equal(formatUnits(p.priceE18, 18).slice(0, 6), "0.1911", "≈ 0.19 USD per FMX at 1.70 AZN per USD");
  assert.equal(p.liquidityUsdE18, 2n * 45_100n * AZN_USD_E18, "both sides: 2 × 45,100 AZNT in USD");
  assert.equal(formatUnits(p.liquidityUsdE18, 18).slice(0, 8), "53058.82");
  assert.equal(p.quoteSymbol, "AZNT");
  assert.match(p.usdBasis, /1 AZNT = 1 AZN; 1 USD = 1\.70 AZN/);
  assert.equal(p.at, 1_000);
  // USDF is 1 USD, so its price in quote IS the USD price
  const u = priceDexPool({ pair: "0x" + "11".repeat(20), quoteToken: USDF, reserveW: 10_000n * E18, reserveQ: 5_000_000_000n, lastTradeAt: 1 }, 1);
  assert.equal(u.priceE18, E18 / 2n);
  assert.equal(u.priceInQuoteE18, E18 / 2n);
  assert.equal(u.liquidityUsdE18, 10_000n * E18);
  // a pool against a token that is not a first-party stable has no USD price, and an empty pool has no price at all
  assert.equal(priceDexPool({ ...LIVE_AZNT_POOL, quoteToken: "0x" + "22".repeat(20) }, 1), null);
  assert.equal(priceDexPool({ ...LIVE_AZNT_POOL, reserveQ: 0n }, 1), null);
  assert.equal(dexSwapUrl(AZNT), `https://dex.ferminux.net/?inputCurrency=${AZNT}&outputCurrency=FMX`);
});

test("bridge state from the relayer report: stale, empty or any chain not signing is paused; unknown is paused", () => {
  const now = 1_790_000_000_000;
  const chain = (name, paused, reason = null) => ({ name, finality: { signing: { paused, reason } } });
  assert.deepEqual(bridgeStateFrom({ generatedAt: now - 60_000, chains: [chain("ferminux", false), chain("bsc", false)] }, now), { paused: false, reason: null, at: now });
  const off = bridgeStateFrom({ generatedAt: now - 60_000, chains: [chain("ferminux", false), chain("bsc", true, "checkpoint unreadable")] }, now);
  assert.equal(off.paused, true);
  assert.match(off.reason, /not signing on bsc \(checkpoint unreadable\)/);
  assert.equal(bridgeStateFrom({ generatedAt: now - 11 * 60_000, chains: [chain("ferminux", false)] }, now).paused, true, "a report older than 10 min is not trusted");
  assert.equal(bridgeStateFrom({ generatedAt: now, chains: [] }, now).paused, true);
  assert.equal(bridgeStateFrom(null, now).paused, true);
});

/** StubFeed with the Ferminux DEX, the PancakeSwap pool and the bridge report stubbed in. */
class MarketFeed extends StubFeed {
  constructor(now) { super(now); this.dexReads = 0; this.poolReads = 0; this.bridgeReads = 0; this.dexFail = false; this.pancakeFail = false; this.dexPools = [LIVE_AZNT_POOL]; this.bridgeReport = null; }
  async readDexPools() { this.dexReads++; if (this.dexFail) throw new Error("rpc.ferminux.net down"); return this.dexPools; }
  async readPoolReserves() {
    this.poolReads++;
    if (this.pancakeFail) throw new Error("bsc rpc down");
    // 123.55 wFMX against 0.064 WBNB; WBNB = 800 USD (StubFeed) → 0.4144… USD per wFMX, 102.4 USD deep
    return { reserveW: (12355n * E18) / 100n, reserveQ: (64n * E18) / 1000n, quoteDecimals: 18, quoteSymbol: "WBNB", lastTradeAt: 1_758_390_000 };
  }
  async fetchBridgeStatus() { this.bridgeReads++; if (!this.bridgeReport) throw new Error("status.json unreachable"); return this.bridgeReport; }
}

test("market price: the Ferminux DEX pool is the primary reference; PancakeSwap rides along as a secondary with the bridge's live state", async (t) => {
  let now = 1_758_400_000_000;
  const feed = new MarketFeed(() => now);
  const d = await feed.dexMarket();
  assert.equal(d.pools.length, 1);
  assert.equal(d.pools[0].pair, DEX_AZNT_PAIR);
  await feed.dexMarket();
  assert.equal(feed.dexReads, 1, "cached for 60 s");
  const m = await feed.market();
  assert.equal(m.venue, "ferminux-dex");
  assert.equal(m.priceE18, d.pools[0].priceE18);
  assert.equal((await feed.price()).priceE18, (52n * E18) / 100n, "the quote stays the operator's fixed price");

  const { app, inject } = await setup(feed);
  t.after(() => app.close());
  let r = (await inject("GET", "/api/payin/market")).json();
  assert.equal(r.venue, "ferminux-dex");
  assert.match(r.source, /Ferminux DEX WFMX\/AZNT pool on chain 3961/);
  assert.equal(r.chain, "ferminux");
  assert.equal(r.chainId, 3961);
  assert.equal(r.pair, DEX_AZNT_PAIR);
  assert.equal(r.token, "0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae", "WFMX on chain 3961, not the bridge's wFMX on BNB Chain");
  assert.equal(r.quoteSymbol, "AZNT");
  assert.equal(r.quoteToken, AZNT);
  assert.equal(r.quoteReserve, "45100.0");
  assert.equal(r.wfmxReserve, "138767.184453857319492643");
  assert.equal(r.priceInQuote.slice(0, 6), "0.3250");
  assert.equal(r.usdPerFmx.slice(0, 6), "0.1911");
  assert.equal(r.liquidityUsd.slice(0, 8), "53058.82");
  assert.equal(r.lastTradeAt, 1_787_791_430);
  assert.equal(r.at, Math.floor(1_758_400_000_000 / 1000));
  assert.equal(r.swapUrl, `https://dex.ferminux.net/?inputCurrency=${AZNT}&outputCurrency=FMX`);
  assert.equal(r.poolUrl, `https://explorer.ferminux.net/address/${DEX_AZNT_PAIR}`);
  assert.equal(r.dexUrl, "https://dex.ferminux.net");
  assert.equal(r.pools.length, 1);
  assert.equal(r.quoteUsdPerFmx, "0.52");
  assert.ok(r.quoteVsMarketPct > 170 && r.quoteVsMarketPct < 173, `the quote sits ~172 % above the DEX price (${r.quoteVsMarketPct})`);
  assert.match(r.note, /1 AZNT = 1 AZN; 1 USD = 1\.70 AZN/);
  // secondary: the BNB Chain pool, with the bridge state — unreadable report counts as paused
  assert.equal(r.secondary.venue, "pancakeswap");
  assert.equal(r.secondary.pair, "0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0");
  assert.equal(r.secondary.usdPerFmx.slice(0, 6), "0.4144");
  assert.equal(r.secondary.liquidityUsd, "102.4");
  assert.equal(r.secondary.bridgePaused, true);
  assert.match(r.secondary.bridgeReason, /could not be read/);
  assert.equal((await inject("GET", "/api/payin/assets")).json().priceUsdPerFmx, "0.52", "the asset list is unchanged");

  // a deeper USDF pool takes over as the reference; the bridge report says every chain is signing
  now += 61_000;
  feed.dexPools = [LIVE_AZNT_POOL, { pair: "0x" + "33".repeat(20), quoteToken: USDF, reserveW: 400_000n * E18, reserveQ: 200_000_000_000n, lastTradeAt: 5 }];
  feed.bridgeReport = { generatedAt: now - 5_000, chains: [{ name: "ferminux", finality: { signing: { paused: false } } }, { name: "bsc", finality: { signing: { paused: false } } }] };
  r = (await inject("GET", "/api/payin/market")).json();
  assert.equal(r.quoteSymbol, "USDF");
  assert.equal(r.usdPerFmx, "0.5");
  assert.equal(r.quoteVsMarketPct, 4);
  assert.deepEqual(r.pools.map((p) => p.quoteSymbol), ["USDF", "AZNT"], "deepest first");
  assert.equal(r.secondary.bridgePaused, false);
  assert.equal(r.secondary.bridgeReason, null);

  // PancakeSwap down: the primary still answers, the secondary is simply absent
  now += 61_000;
  feed.pancakeFail = true;
  r = (await inject("GET", "/api/payin/market")).json();
  assert.equal(r.venue, "ferminux-dex");
  assert.equal(r.secondary, null);
});

test("market price: PancakeSwap stands in, labelled, only when chain 3961 cannot be read; both down is a 503 that never blocks a quote", async (t) => {
  let now = 1_758_400_000_000;
  const feed = new MarketFeed(() => now);
  feed.dexFail = true;
  const { app, inject } = await setup(feed);
  t.after(() => app.close());
  const r = (await inject("GET", "/api/payin/market")).json();
  assert.equal(r.venue, "pancakeswap");
  assert.match(r.source, /PancakeSwap v2 wFMX\/WBNB pool on BNB Chain/);
  assert.equal(r.chain, "bsc");
  assert.equal(r.pair, "0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0");
  assert.equal(r.usdPerFmx.slice(0, 6), "0.4144");
  assert.equal(r.liquidityUsd, "102.4");
  assert.equal(r.lastTradeAt, 1_758_390_000);
  assert.equal(r.quoteVsMarketPct, 25.48, "the quote is 25.48 % above the pool's spot price");
  assert.equal(r.bridgePaused, true);
  assert.match(r.primaryError, /Ferminux DEX unreadable: rpc\.ferminux\.net down/);
  assert.equal(r.secondary, null);

  now += 61_000;
  feed.pancakeFail = true;
  const down = await inject("GET", "/api/payin/market");
  assert.equal(down.statusCode, 503);
  assert.match(down.json().error, /rpc\.ferminux\.net down/);
  assert.match(down.json().error, /bsc rpc down/);
  assert.equal((await inject("POST", "/api/payin/quote", { chain: "bsc", asset: "USDC", amount: "5", to: alice.address })).statusCode, 201, "a market read failure never blocks a fixed-price quote");
});

test("unfixed pay-in price follows the Ferminux DEX (floored), and PancakeSwap only when chain 3961 is unreadable", async () => {
  const now = 1_758_400_000_000;
  class Unfixed extends PriceFeed {
    constructor(floor) { super("http://127.0.0.1:1", { now: () => now, minPriceUsd: floor, ferminuxRpcUrl: "http://127.0.0.1:1" }); this.dexFail = false; }
    async fetchCoingecko() { return { binancecoin: { usd: 800 } }; }
    async readDexPools() { if (this.dexFail) throw new Error("down"); return [LIVE_AZNT_POOL]; }
    async readPoolReserves() { return { reserveW: (12355n * E18) / 100n, reserveQ: (64n * E18) / 1000n, quoteDecimals: 18, quoteSymbol: "WBNB", lastTradeAt: 1 }; }
    async fetchBridgeStatus() { throw new Error("offline"); }
  }
  const dexPrice = priceDexPool(LIVE_AZNT_POOL, 0).priceE18;
  assert.equal((await new Unfixed(undefined).price()).priceE18, dexPrice);
  assert.equal((await new Unfixed("0.25").price()).priceE18, E18 / 4n, "PAYIN_MIN_PRICE_USD floors it");
  const fallback = new Unfixed(undefined);
  fallback.dexFail = true;
  assert.equal(formatUnits((await fallback.price()).priceE18, 18).slice(0, 6), "0.4144");
});

test("market reads: concurrent callers on a cold cache share one read; a failed read is remembered for 15 s", async () => {
  let now = 1_758_400_000_000;
  const feed = new MarketFeed(() => now);
  await Promise.all([feed.dexMarket(), feed.dexMarket(), feed.dexMarket(), feed.pancakeMarket(), feed.pancakeMarket()]);
  assert.equal(feed.dexReads, 1, "one DEX read for three callers");
  assert.equal(feed.poolReads, 1, "one PancakeSwap read for two callers");

  now += 61_000;
  feed.dexFail = true;
  feed.pancakeFail = true;
  await assert.rejects(feed.dexMarket(), /rpc\.ferminux\.net down/);
  await assert.rejects(feed.pancakeMarket(), /bsc rpc down/);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(feed.dexMarket(), /rpc\.ferminux\.net down/);
    await assert.rejects(feed.pancakeMarket(), /bsc rpc down/);
  }
  assert.equal(feed.dexReads, 2, "an outage costs one read per 15 s, not one per request");
  assert.equal(feed.poolReads, 2);

  feed.dexFail = false;
  feed.pancakeFail = false;
  now += 15_001;
  assert.equal((await feed.dexMarket()).pools.length, 1, "read again once the failure is 15 s old");
  assert.equal((await feed.pancakeMarket()).lastTradeAt, 1_758_390_000);
  assert.equal(feed.dexReads, 3);
});
