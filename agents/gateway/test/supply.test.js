// FMX supply: the schedule re-derived from the consensus rules, the pinned pre-authority figures, the burn
// tracker, the one-block snapshot, the plain-number routes listing sites poll, and the CoinGecko-shaped record the
// explorer reads. No network: the chain is a fake JSON-RPC client.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AbiCoder, Interface } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb, getMeta } from "../dist/db.js";
import { PriceFeed } from "../dist/v3/payin.js";
import {
  E18, GENESIS_WEI, POSA_BLOCK, POW_ERA, BURN_CHECKPOINT, SUPPLY_EXCLUSIONS, SUPPLY_RECONCILIATION, FOUNDATION_LOCK, FMX_VESTING, REWARD_SINK, CG_COIN_ID,
  scheduleReward, authorityReward, authorityIssuedThrough, preAuthorityBaseReward, maxSupplyWei, fmxString, plainNumber, extraFoundationFromEnv,
  BurnTracker, SupplyService,
} from "../dist/supply.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1", payinRpcUrls: {}, payinDeposits: {}, webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9,
};
const hex = (n) => "0x" + BigInt(n).toString(16);
const fmx = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n;
const VIEWS = new Interface(["function releasable() view returns (uint256)", "function remaining() view returns (uint256)"]);
const coder = AbiCoder.defaultAbiCoder();

/** A fake chain: head, per-block gas and base fee, balances, the two views; it records every block tag it is asked. */
function fakeChain({ head = 413_300, gas = {}, balances = {}, releasable = 0n, remaining = 1000n, fail = false } = {}) {
  const tags = new Set();
  const calls = [];
  const chain = {
    head, gas, balances, releasable, remaining, fail, tags, calls,
    async send(method, params) {
      calls.push(method);
      if (chain.fail) throw new Error("rpc down");
      switch (method) {
        case "eth_blockNumber": return hex(chain.head);
        case "eth_feeHistory": {
          const count = Number(params[0]), newest = Number(params[1]);
          const oldest = newest - count + 1;
          return { oldestBlock: hex(oldest), gasUsedRatio: Array.from({ length: count }, (_, i) => (chain.gas[oldest + i] ? 0.01 : 0)) };
        }
        case "eth_getBlockByNumber": {
          const n = Number(params[0]);
          const g = chain.gas[n];
          return { number: hex(n), timestamp: hex(1_790_000_000 + n * 7), gasUsed: hex(g?.gas ?? 0), baseFeePerGas: hex(g?.fee ?? 7) };
        }
        case "eth_getBalance": tags.add(params[1]); return hex(chain.balances[params[0].toLowerCase()] ?? 0n);
        case "eth_call": {
          tags.add(params[1]);
          const to = params[0].to.toLowerCase();
          if (to === FMX_VESTING.toLowerCase()) return coder.encode(["uint256"], [chain.releasable]);
          if (to === FOUNDATION_LOCK.toLowerCase()) return coder.encode(["uint256"], [chain.remaining]);
          throw new Error("unexpected eth_call " + to);
        }
        default: throw new Error("unexpected " + method);
      }
    },
  };
  return chain;
}

// ---------------------------------------------------------------------------------------------- the schedule

test("schedule: the consensus reward table, re-derived", () => {
  assert.equal(scheduleReward(1), 6n * E18);
  assert.equal(scheduleReward(19_999), 6n * E18);
  assert.equal(scheduleReward(20_000), E18, "the Emission fork cut the reward to 1 FMX");
  assert.equal(scheduleReward(4_499_999), E18);
  assert.equal(scheduleReward(4_500_000), E18 / 2n, "the first halving is at block 4,500,000 (absolute height)");
  assert.equal(scheduleReward(9_000_000), E18 / 4n);
  assert.equal(scheduleReward(4_500_000 * 61), 0n, "past era 60 the reward is gone");
  assert.equal(authorityReward(POSA_BLOCK), E18 / 4n, "authority blocks pay a quarter of the schedule");
  assert.equal(authorityReward(4_500_000), E18 / 8n);

  // pre-authority base rewards: 19,999 blocks at 6 FMX + 140,000 at 1 FMX
  assert.equal(preAuthorityBaseReward(), 259_994n * E18);
  assert.equal(POW_ERA.baseRewardWei, preAuthorityBaseReward(), "the pinned base reward is the schedule's");
  assert.equal(POW_ERA.issuedWei, POW_ERA.baseRewardWei + POW_ERA.uncleRewardWei + POW_ERA.nephewRewardWei, "issued = base + uncle + nephew");
  assert.equal(POW_ERA.toBlock, POSA_BLOCK - 1);

  assert.equal(authorityIssuedThrough(POSA_BLOCK - 1), 0n);
  assert.equal(authorityIssuedThrough(POSA_BLOCK), E18 / 4n);
  assert.equal(authorityIssuedThrough(413_163), 253_164n * (E18 / 4n), "the figure the sink cross-check used (half of it: 31,645.5 FMX)");
  assert.equal(authorityIssuedThrough(4_499_999), 4_340_000n * (E18 / 4n));
  assert.equal(authorityIssuedThrough(4_500_000), 4_340_000n * (E18 / 4n) + E18 / 8n);

  // the whole schedule, by brute force over eras, independently of authorityIssuedThrough's loop
  let all = 4_340_000n * (E18 / 4n);
  for (let e = 1; e <= 60; e++) all += 4_500_000n * ((E18 >> BigInt(e)) / 4n);
  assert.equal(maxSupplyWei(), GENESIS_WEI + POW_ERA.issuedWei + all);
  // ~32.515M: README's "a little under 32.5M" left out the 44,985.875 FMX of uncle and nephew rewards
  assert.ok(maxSupplyWei() > 32_514_000n * E18 && maxSupplyWei() < 32_515_000n * E18, fmxString(maxSupplyWei()));
  assert.equal(POW_ERA.uncleRewardWei + POW_ERA.nephewRewardWei, fmx(44_985.875));
});

test("genesis: 30,000,000 FMX is exactly the alloc of genesis/genesis.json", () => {
  const g = JSON.parse(readFileSync(new URL("../../../genesis/genesis.json", import.meta.url), "utf8"));
  const sum = Object.values(g.alloc).reduce((a, v) => a + BigInt(v.balance), 0n);
  assert.equal(sum, GENESIS_WEI);
  // the genesis wallets that are still foundation-held are excluded from circulating; the team wallet sent its
  // allocation to FMXVesting, which is excluded by its unvested amount instead
  const excluded = new Set(SUPPLY_EXCLUSIONS.map((e) => e.address.toLowerCase()));
  const genesisWallets = Object.keys(g.alloc).map((a) => a.toLowerCase());
  assert.deepEqual(genesisWallets.filter((a) => !excluded.has(a)), ["0x86e286684ae5899a941142d143949c444f9fe831"]);
});

test("formatting: full-precision strings and the plain number listing sites read", () => {
  assert.equal(fmxString(0n), "0");
  assert.equal(fmxString(30_000_000n * E18), "30000000");
  assert.equal(fmxString(POW_ERA.issuedWei), "304979.875");
  assert.equal(fmxString(2_567_336_314_603_710n), "0.00256733631460371");
  assert.equal(plainNumber(2_567_336_314_603_710n), "0.00256733", "8 decimals, truncated");
  assert.equal(plainNumber(123n * E18 + 999_999_999_999_999_999n), "123.99999999", "never rounded up");
  assert.equal(plainNumber(7n * E18), "7");
  assert.equal(plainNumber(-5n), "0");
});

test("SUPPLY_FOUNDATION_WALLETS: extra foundation-held addresses, bad and duplicate entries skipped", () => {
  const r = extraFoundationFromEnv(" 0x7f16433359e4ef704e90ce08460c6238e45130f7:Ops hot wallet, junk, 0xc0A5Eb613f859f072554F29f1Ab7400265af15aB:dup, 0xc2a7B343a8a9ef2eC5D15c31225A64AC9FDC05Fa ");
  assert.deepEqual(r.map((e) => [e.address, e.label, e.category]), [
    ["0x7F16433359E4eF704E90cE08460c6238E45130f7", "Ops hot wallet", "foundation"],
    ["0xc2a7B343a8a9ef2eC5D15c31225A64AC9FDC05Fa", "Foundation wallet", "foundation"],
  ]);
  assert.deepEqual(extraFoundationFromEnv(""), []);
  assert.deepEqual(extraFoundationFromEnv(undefined), []);
});

// ---------------------------------------------------------------------------------------------- burn tracker

test("burn tracker: exact baseFee × gasUsed of the blocks that used gas, persisted, resumable", async () => {
  const cp = { block: 1000, burnedWei: 5n };
  const chain = fakeChain({ gas: { 1001: { gas: 21_000, fee: 7 }, 2000: { gas: 100_000, fee: 1_000_000_000 }, 3500: { gas: 50_000, fee: 9 } } });
  const db = openMemoryDb();
  const t1 = new BurnTracker(chain, db, cp);
  assert.deepEqual(t1.state, { through: 1000, burnedWei: 5n });
  await t1.syncTo(2500);
  assert.deepEqual(t1.state, { through: 2500, burnedWei: 5n + 21_000n * 7n + 100_000n * 1_000_000_000n });
  assert.ok(chain.calls.filter((m) => m === "eth_feeHistory").length === 2, "1,024 blocks per eth_feeHistory");
  assert.equal(chain.calls.filter((m) => m === "eth_getBlockByNumber").length, 2, "only blocks that used gas are fetched");
  assert.deepEqual(JSON.parse(getMeta(db, "supply.burn")), { through: 2500, burnedWei: String(5n + 147_000n + 100_000_000_000_000n) });

  // a restart resumes from the DB, not from the checkpoint
  const t2 = new BurnTracker(chain, db, cp);
  assert.equal(t2.state.through, 2500);
  await t2.syncTo(4000);
  assert.equal(t2.state.burnedWei, 5n + 147_000n + 100_000_000_000_000n + 450_000n);

  // maxChunks bounds one call; the next call continues
  const t3 = new BurnTracker(chain, undefined, cp);
  await t3.syncTo(10_000, 2);
  assert.equal(t3.state.through, 1000 + 2048);

  // a saved position behind the checkpoint (an older build's) is dropped
  const db2 = openMemoryDb();
  db2.prepare("INSERT INTO meta (key, value) VALUES ('supply.burn', ?)").run(JSON.stringify({ through: 10, burnedWei: "1" }));
  assert.deepEqual(new BurnTracker(chain, db2, cp).state, { through: 1000, burnedWei: 5n });

  // a node that answers other blocks than asked is refused, not trusted
  const liar = { send: async (m, p) => (m === "eth_feeHistory" ? { oldestBlock: hex(5), gasUsedRatio: [0] } : chain.send(m, p)) };
  await assert.rejects(new BurnTracker(liar, undefined, cp).syncTo(1100), /eth_feeHistory answered/);
});

// ---------------------------------------------------------------------------------------------- the snapshot

const BAL = {
  [FOUNDATION_LOCK.toLowerCase()]: fmx(150_292),
  [FMX_VESTING.toLowerCase()]: fmx(5_000_000),
  ["0xc0a5eb613f859f072554f29f1ab7400265af15ab"]: fmx(10_230_133.469),
  [REWARD_SINK.toLowerCase()]: fmx(31_647.126),
  ["0xeedd7368290a17ab2aa3f298ff24bb99d581e787"]: fmx(6_000_000),
  ["0x040f1e90ef72b364141d91c3c0314ac3b5ecd0ae"]: fmx(3_745_499.971),
  ["0x34f5366014ef292fd5ff9ffde81d47819ef65cfc"]: fmx(1_960_102.943),
  ["0xf4de70068031da17347cd19acaa841013751b3c0"]: fmx(10_000),
  ["0x000000000000000000000000000000000000dead"]: fmx(1),
};

test("snapshot: total and circulating from one block, every exclusion listed", async () => {
  const chain = fakeChain({ head: 413_300, balances: { ...BAL }, gas: { 413_200: { gas: 1_000_000, fee: 7 } } });
  let now = 1_000_000;
  const svc = new SupplyService({ rpc: chain, now: () => now, extra: [], checkpoint: BURN_CHECKPOINT });
  const s = await svc.snapshot();
  const asOf = 413_300 - 64;
  assert.equal(s.asOfBlock, asOf);
  assert.deepEqual([...chain.tags], [hex(asOf)], "every balance and view is read at the same block");
  const burned = BURN_CHECKPOINT.burnedWei + 7_000_000n;
  const total = GENESIS_WEI + POW_ERA.issuedWei + authorityIssuedThrough(asOf) - burned - fmx(1);
  assert.equal(s.wei.total, total.toString());
  assert.equal(s.components.burnedBaseFees.throughBlock, asOf);
  assert.equal(s.components.burnedBaseFees.wei, burned.toString());
  assert.equal(s.components.burnAddresses.wei, fmx(1).toString());
  const excluded = Object.values(BAL).reduce((a, b) => a + b, 0n) - fmx(1);
  assert.equal(s.wei.circulating, (total - excluded).toString());
  assert.equal(s.excluded.length, SUPPLY_EXCLUSIONS.length);
  assert.equal(s.excluded[0].category, "locked", "FoundationLock is locked while remaining() > 0");
  assert.equal(s.excluded[1].category, "vesting");
  assert.equal(s.excludedTotals.locked, "150292");
  assert.equal(s.excludedTotals.vesting, "5000000");
  assert.equal(s.wei.max, maxSupplyWei().toString());
  assert.equal(s.reconciliation.length, SUPPLY_RECONCILIATION.length);
  assert.match(s.reconciliation.join(" "), /34,600,000/);
  // staking/DESIGN.md's 34.6M is 1 FMX a block until a hand-off at block 4,500,000, not the launch reward continuing
  const r346 = s.reconciliation.find((l) => l.includes("34,600,000"));
  assert.match(r346, /block 4,500,000/);
  assert.doesNotMatch(r346, /6 FMX a block would continue/);
  assert.match(s.components.authorityIssuance.blocks, new RegExp(`^160000-${asOf}$`));

  // cached for 60 s; then recomputed
  chain.head += 10;
  assert.equal((await svc.snapshot()).asOfBlock, asOf);
  now += 61_000;
  assert.equal((await svc.snapshot()).asOfBlock, asOf + 10);
});

test("snapshot: vested FMX circulates, an opened lock is foundation-held, a dead RPC serves the last answer as stale", async () => {
  const chain = fakeChain({ head: 413_300, balances: { ...BAL }, releasable: fmx(250_000), remaining: 0n });
  let now = 5_000_000;
  const svc = new SupplyService({ rpc: chain, now: () => now, extra: [], checkpoint: BURN_CHECKPOINT });
  const s = await svc.snapshot();
  assert.equal(s.excluded[1].excluded, "4750000", "only the unvested part is excluded");
  assert.equal(s.excluded[0].category, "foundation");
  assert.equal(s.excludedTotals.locked, "0");

  chain.fail = true;
  now += 120_000;
  const stale = await svc.snapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.wei.total, s.wei.total);
  now += 3_600_000;
  await assert.rejects(svc.snapshot(), /rpc down/, "an answer over an hour old is not served");
});

test("snapshot: a burn tracker far behind reads at the oldest state the node keeps and says how far burns go", async () => {
  const chain = fakeChain({ head: 600_000, balances: { ...BAL } });
  const svc = new SupplyService({ rpc: chain, extra: [], checkpoint: { block: 413_163, burnedWei: 0n } });
  svc.burn.syncTo = async function () {}; // stuck
  const s = await svc.snapshot();
  assert.equal(s.asOfBlock, 600_000 - 120);
  assert.equal(s.components.burnedBaseFees.throughBlock, 413_163);
});

// ---------------------------------------------------------------------------------------------- routes

class FakeFeed extends PriceFeed {
  constructor() { super("http://127.0.0.1:1", { ferminuxRpcUrl: "http://127.0.0.1:1" }); this.down = false; }
  async market() { if (this.down) throw new Error("down"); return { priceE18: E18 / 2n, venue: "ferminux-dex", at: 1_790_000_000_000, liquidityUsdE18: 0n, wfmxReserveE18: 0n, lastTradeAt: 0 }; }
  async fetchCoingecko() { throw new Error("offline"); }
  async readDexPools() { throw new Error("offline"); }
  async fetchBridgeStatus() { throw new Error("offline"); }
}

async function server(chain) {
  const supply = new SupplyService({ rpc: chain, extra: [], checkpoint: BURN_CHECKPOINT });
  const feed = new FakeFeed();
  const { app } = await buildServer({ db: openMemoryDb(), cfg, workers: false, logger: false, supply, v3: { priceFeed: feed }, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  return { app, feed, supply };
}

test("routes: plain numbers for listing sites, ?format=json, the breakdown, and 503 without a chain", async (t) => {
  const chain = fakeChain({ head: 413_300, balances: { ...BAL } });
  const { app, supply } = await server(chain);
  t.after(() => app.close());
  const s = await supply.snapshot();

  const total = await app.inject({ method: "GET", url: "/api/supply/total" });
  assert.equal(total.statusCode, 200);
  assert.match(total.headers["content-type"], /^text\/plain/);
  assert.match(total.body, /^\d+(\.\d{1,8})?$/, "a bare number, nothing else");
  assert.equal(total.body, plainNumber(BigInt(s.wei.total)));
  assert.match(total.headers["cache-control"], /max-age=60/);
  const circ = await app.inject({ method: "GET", url: "/api/supply/circulating" });
  assert.equal(circ.body, plainNumber(BigInt(s.wei.circulating)));
  assert.ok(Number(circ.body) > 0 && Number(circ.body) < Number(total.body));
  const max = await app.inject({ method: "GET", url: "/api/supply/max" });
  assert.equal(max.body, plainNumber(maxSupplyWei()));

  const j = (await app.inject({ method: "GET", url: "/api/supply/circulating?format=json" })).json();
  assert.equal(j.circulatingSupply, s.circulatingSupply);
  assert.equal(j.asOfBlock, s.asOfBlock);
  assert.match(j.definition, /FoundationLock/);
  assert.equal((await app.inject({ method: "GET", url: "/api/supply/total?format=xml" })).statusCode, 400);

  const full = (await app.inject({ method: "GET", url: "/api/supply" })).json();
  assert.equal(full.totalSupply, s.totalSupply);
  assert.equal(full.chainId, 3961);
  assert.ok(full.excluded.every((e) => /^0x[0-9a-fA-F]{40}$/.test(e.address) && e.label && e.note));

  const spec = (await app.inject({ method: "GET", url: "/api/openapi.json" })).json();
  for (const p of ["/api/supply", "/api/supply/total", "/api/supply/circulating", "/api/supply/max", "/api/market/coingecko/coins/{id}", "/api/market/coingecko/coins/{id}/market_chart"]) assert.ok(spec.paths[p]?.get, p);
  const tag = spec.tags.find((x) => x.name === "supply");
  assert.match(tag.description, /30,000,000 FMX is the genesis allocation/);
  assert.match(tag.description, /32,515,000/);
  assert.match(tag.description, /34,600,000/);
  const llms = (await app.inject({ method: "GET", url: "/api/discovery/llms.txt" })).body;
  assert.match(llms, /\/api\/supply\/circulating/);
  assert.match(llms, /32,515,000/);

  // no chain, no cache: 503 in the format that was asked for
  const dead = await server(fakeChain({ fail: true }));
  t.after(() => dead.app.close());
  const r = await dead.app.inject({ method: "GET", url: "/api/supply/total" });
  assert.equal(r.statusCode, 503);
  assert.match(r.headers["content-type"], /^text\/plain/);
  assert.match(r.body, /supply unavailable/);
  assert.equal((await dead.app.inject({ method: "GET", url: "/api/supply/total?format=json" })).json().code, "chain_unavailable");
  assert.equal((await dead.app.inject({ method: "GET", url: "/api/supply" })).statusCode, 503);
});

test("CoinGecko-shaped coin record: what Blockscout's market source parses", async (t) => {
  const chain = fakeChain({ head: 413_300, balances: { ...BAL } });
  const { app, feed, supply } = await server(chain);
  t.after(() => app.close());
  const s = await supply.snapshot();
  const r = await app.inject({ method: "GET", url: `/api/market/coingecko/coins/${CG_COIN_ID}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false` });
  assert.equal(r.statusCode, 200, r.body);
  const c = r.json();
  // the fields Explorer.Market.Source.CoinGecko.do_fetch_coin reads (Blockscout 9.0.2)
  assert.equal(c.name, "Ferminux");
  assert.equal(c.symbol.toUpperCase(), "FMX");
  assert.equal(c.image.small, "https://ferminux.net/assets/brand/fmx-256.png");
  assert.equal(c.market_data.current_price.usd, 0.5);
  assert.equal(c.market_data.circulating_supply, Number(s.circulatingSupply));
  assert.equal(c.market_data.total_supply, Number(s.totalSupply));
  assert.ok(Math.abs(c.market_data.market_cap.usd - Number(s.circulatingSupply) * 0.5) < 1, "market cap = price × circulating");
  assert.ok(!Number.isNaN(Date.parse(c.market_data.last_updated)));
  assert.equal(typeof c.market_data.total_volume, "object");
  assert.equal(c.ferminux.priceVenue, "ferminux-dex");

  // no price: the supply still comes through, the price fields are empty rather than invented
  feed.down = true;
  const np = (await app.inject({ method: "GET", url: `/api/market/coingecko/coins/${CG_COIN_ID}` })).json();
  assert.deepEqual(np.market_data.current_price, {});
  assert.deepEqual(np.market_data.market_cap, {});
  assert.equal(np.market_data.total_supply, Number(s.totalSupply));

  assert.equal((await app.inject({ method: "GET", url: "/api/market/coingecko/coins/bitcoin" })).statusCode, 404);
  const chart = await app.inject({ method: "GET", url: `/api/market/coingecko/coins/${CG_COIN_ID}/market_chart?vs_currency=usd&days=365` });
  assert.deepEqual(chart.json(), { prices: [], market_caps: [], total_volumes: [] });
});
