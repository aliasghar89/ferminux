// Unit tests: marker, gas math, amounts, derivation and the seed file.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HDNodeWallet, Mnemonic } from "ethers";
import { MARKER_BYTES, MARKER_DATA, MARKER_PREFIX, isMarked, markerVersion } from "../dist/marker.js";
import { intrinsicGas, ruleForEstimate, feesFor, effectiveGasPrice, sweepValue, sweepRemainder, nextBaseFee, bumpFees, maxCost } from "../dist/gas.js";
import { makeRng, sampleFunding, capFunding, planTransfers, pickRecipients, uniformAmount, DEFAULT_AMOUNTS, GRANULE, parseFmx, fmx, WEI } from "../dist/amounts.js";
import { Keyring, loadOrCreateSeed, addressFromXpub, DERIVATION_BASE } from "../dist/wallets.js";
import { loadConfig } from "../dist/config.js";
import { makeLogger } from "../dist/log.js";
import { syncAddresses } from "../dist/publish.js";
import { PHRASE, tmp } from "./helpers.mjs";

test("marker: FXLT + version byte, recognised on any input that starts with it", () => {
  assert.equal(MARKER_PREFIX, "0x46584c54");
  assert.equal(Buffer.from(MARKER_PREFIX.slice(2), "hex").toString("ascii"), "FXLT");
  assert.equal(MARKER_DATA, "0x46584c5401");
  assert.deepEqual([...MARKER_BYTES], [0x46, 0x58, 0x4c, 0x54, 0x01]);
  assert.ok(isMarked("0x46584C5401"));
  assert.ok(isMarked("0x46584c5402ff"));
  assert.ok(!isMarked("0x"));
  assert.ok(!isMarked("0xa9059cbb"));
  assert.ok(!isMarked(null));
  assert.equal(markerVersion(MARKER_DATA), 1);
  assert.equal(markerVersion("0x1234"), null);
});

test("gas: a marked transfer costs 21,080 gas on 3961 (london) and 21,200 under the EIP-7623 floor", () => {
  assert.equal(intrinsicGas(MARKER_BYTES, "london"), 21_080n);
  assert.equal(intrinsicGas(MARKER_BYTES, "prague"), 21_200n);
  assert.equal(intrinsicGas(new Uint8Array([]), "london"), 21_000n);
  assert.equal(intrinsicGas(new Uint8Array([0, 0, 1]), "london"), 21_000n + 8n + 16n);
  // live chain 3961 answered 0x5258 for eth_estimateGas on a marked transfer (2026-09-25)
  assert.equal(ruleForEstimate(0x5258n, MARKER_BYTES), "london");
  assert.equal(ruleForEstimate(21_200n, MARKER_BYTES), "prague");
  assert.equal(ruleForEstimate(21_000n, MARKER_BYTES), null);
});

test("gas: a sweep at base fee + tip leaves exactly zero; a lower base fee leaves less than one transfer's gas", () => {
  const gas = 21_080n;
  const fees = feesFor(7n, 10n ** 9n);
  assert.equal(fees.maxFeePerGas, 1_000_000_007n);
  for (const bal of [WEI / 100n, 123_456_789_012_345_678n, 20n * WEI + 1n, gas * fees.maxFeePerGas + 1n]) {
    const v = sweepValue(bal, gas, fees);
    assert.equal(sweepRemainder(bal, v, gas, fees, 7n), 0n, `balance ${bal}`);
    const lower = sweepRemainder(bal, v, gas, fees, 6n);
    assert.ok(lower > 0n && lower < gas * fees.maxFeePerGas);
  }
  // dust: cannot pay its own gas → not swept
  assert.equal(sweepValue(gas * fees.maxFeePerGas, gas, fees), 0n);
  assert.equal(sweepValue(1n, gas, fees), 0n);
  assert.equal(effectiveGasPrice(7n, fees), fees.maxFeePerGas);
  assert.equal(maxCost(gas, fees), 21_080n * 1_000_000_007n);
});

test("gas: next base fee follows EIP-1559 (7 wei holds under light load on a 100M block)", () => {
  assert.equal(nextBaseFee({ baseFee: 7n, gasUsed: 300_000n, gasLimit: 100_000_000n }), 7n);
  assert.equal(nextBaseFee({ baseFee: 7n, gasUsed: 0n, gasLimit: 100_000_000n }), 7n);
  assert.equal(nextBaseFee({ baseFee: 7n, gasUsed: 100_000_000n, gasLimit: 100_000_000n }), 8n);
  assert.equal(nextBaseFee({ baseFee: 1000n, gasUsed: 0n, gasLimit: 100_000_000n }), 875n);
  const b = bumpFees({ maxFeePerGas: 1_000_000_007n, maxPriorityFeePerGas: 1_000_000_000n }, 7n);
  assert.ok(b.maxPriorityFeePerGas * 10n >= 11n * 1_000_000_000n);
  assert.ok(b.maxFeePerGas * 10n >= 11n * 1_000_000_007n);
  assert.ok(b.maxFeePerGas >= 7n + b.maxPriorityFeePerGas);
});

test("amounts: 95 % in 0.01–1 FMX, 5 % in 1–20 FMX, on the 0.0001 grid", () => {
  const rng = makeRng(42);
  const n = 200_000;
  let large = 0, sumSmall = 0n, cSmall = 0;
  for (let i = 0; i < n; i++) {
    const a = sampleFunding(rng);
    assert.ok(a >= WEI / 100n && a <= 20n * WEI, `out of range: ${a}`);
    assert.equal(a % GRANULE, 0n);
    if (a > WEI) large++;
    else { sumSmall += a; cSmall++; }
  }
  const share = large / n;
  assert.ok(share > 0.046 && share < 0.054, `large share ${share}`);
  const meanSmall = Number(sumSmall / BigInt(cSmall)) / 1e18;
  assert.ok(meanSmall > 0.49 && meanSmall < 0.52, `small mean ${meanSmall}`);
  // the band edges are reachable
  const r2 = makeRng(1);
  let lo = WEI, hi = 0n;
  for (let i = 0; i < 50_000; i++) { const a = uniformAmount(r2, WEI / 100n, WEI, GRANULE); if (a < lo) lo = a; if (a > hi) hi = a; }
  assert.ok(lo < WEI / 100n + 10n * GRANULE && hi > WEI - 10n * GRANULE);
});

test("amounts: funding is capped by the float's headroom; transfers never eat the gas reserve", () => {
  assert.equal(capFunding(5n * WEI, 10n * WEI), 5n * WEI);
  assert.equal(capFunding(5n * WEI, 3n * WEI + 12345n), 3n * WEI);
  assert.equal(capFunding(5n * WEI, WEI / 200n), null);
  const rng = makeRng(3);
  const reserve = 21_080n * 2_000_000_014n;
  for (let i = 0; i < 5000; i++) {
    const funded = sampleFunding(rng);
    const k = 1 + (i % 3);
    const t = planTransfers(rng, funded, reserve, k);
    const sum = t.reduce((a, b) => a + b, 0n);
    assert.ok(t.length <= k);
    assert.ok(sum <= funded - reserve * BigInt(k + 1), "transfers leave the gas for every send and the sweep");
    for (const x of t) assert.ok(x >= GRANULE && x % GRANULE === 0n);
  }
  const rec = pickRecipients(makeRng(9), 5, [5, 6, 7], 50, 0);
  assert.ok(rec.every((r) => r === 6 || r === 7));
  assert.deepEqual(pickRecipients(makeRng(9), 5, [5], 2, 0), [0, 0]);
  assert.equal(parseFmx("0.01"), WEI / 100n);
  assert.equal(parseFmx("20"), 20n * WEI);
  assert.equal(fmx(1_234_500_000_000_000_000n), "1.2345");
  assert.throws(() => parseFmx("1e3"));
});

test("derivation: m/44'/60'/7'/0/i from the seed, and the same addresses from the published xpub alone", () => {
  const k = new Keyring(PHRASE);
  for (const i of [0, 1, 2, 999, 99_999]) {
    const full = HDNodeWallet.fromPhrase(PHRASE, undefined, `${DERIVATION_BASE}/${i}`);
    assert.equal(k.address(i), full.address, `index ${i}`);
    assert.equal(k.wallet(i).privateKey, full.privateKey);
    assert.equal(addressFromXpub(k.xpub, i), full.address);
  }
  assert.match(k.xpub, /^xpub/);
  assert.ok(!k.xpub.includes(HDNodeWallet.fromPhrase(PHRASE, undefined, DERIVATION_BASE).privateKey.slice(2)));
  assert.equal(new Set(k.range(0, 500)).size, 500);
});

test("seed file: created once with 0600 and 24 words, reused after, never printed", (t) => {
  const dir = tmp(t);
  const f = join(dir, "data", "seed.txt");
  const a = loadOrCreateSeed(f);
  assert.equal(a.created, true);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(a.phrase.split(" ").length, 24);
  assert.ok(Mnemonic.isValidMnemonic(a.phrase));
  const b = loadOrCreateSeed(f);
  assert.equal(b.created, false);
  assert.equal(b.phrase, a.phrase);
  chmodSync(f, 0o644);
  loadOrCreateSeed(f);
  assert.equal(statSync(f).mode & 0o777, 0o600, "permissions are put back to 0600");
  writeFileSync(join(dir, "bad.txt"), "not a phrase");
  assert.throws(() => loadOrCreateSeed(join(dir, "bad.txt")), /valid BIP-39/);
  // the logger refuses a line that carries the phrase
  const lines = [];
  const log = makeLogger("info", (l) => lines.push(l));
  log.secret(a.phrase);
  log.info("oops", { phrase: a.phrase });
  log.info("partial", { s: a.phrase.split(" ").slice(0, 3).join(" ") });
  assert.ok(lines.every((l) => !l.includes(a.phrase.split(" ").slice(0, 3).join(" "))));
  assert.match(lines[0], /suppressed/);
});

test("addresses.bin: 20 bytes per wallet, appended as waves activate, rewritten for a different seed", (t) => {
  const dir = tmp(t);
  const k = new Keyring(PHRASE);
  syncAddresses(dir, 0, (i) => k.address(i));
  assert.equal(statSync(join(dir, "addresses.bin")).size, 20);
  syncAddresses(dir, 41, (i) => k.address(i));
  const buf = readFileSync(join(dir, "addresses.bin"));
  assert.equal(buf.length, 42 * 20);
  for (const i of [0, 1, 17, 41]) assert.equal("0x" + buf.subarray(i * 20, i * 20 + 20).toString("hex"), k.address(i).toLowerCase());
  const other = new Keyring("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  syncAddresses(dir, 3, (i) => other.address(i));
  const b2 = readFileSync(join(dir, "addresses.bin"));
  assert.equal(b2.length, 80);
  assert.equal("0x" + b2.subarray(0, 20).toString("hex"), other.address(0).toLowerCase());
  assert.ok(existsSync(join(dir, "addresses.bin")));
});

test("config: dry-run by default, 2 tx/s, Wizrd's address as the sink, high rates need an explicit flag", () => {
  const c = loadConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.rate, 2);
  assert.equal(c.wallets, 100_000);
  assert.equal(c.sink, "0xD7175A244a3Eab83f574135318d037Fb6221C358");
  assert.equal(c.tipWei, 1_000_000_000n);
  assert.throws(() => loadConfig({ RATE_TX_PER_S: "50" }), /RATE_TX_PER_S/);
  assert.equal(loadConfig({ RATE_TX_PER_S: "50", LOADTEST_ALLOW_HIGH_RATE: "1" }).rate, 50);
  assert.throws(() => loadConfig({ SIGNER_SOURCE: "off" }), /test chains only/);
  assert.throws(() => loadConfig({ SINK: "0x123" }), /not an address/);
  assert.equal(loadConfig({ LOADTEST_ENABLED: "true" }).enabled, true);
});

test("guards: a txpool answer without a hex pending count fails the guard (never reads as an empty pool)", async () => {
  const { checkChain } = await import("../dist/guards.js");
  const cfg = loadConfig({ LOADTEST_ALLOW_HIGH_RATE: "1", SIGNER_SOURCE: "off", EXPLORER_API: "off" });
  const now = 1_790_000_000;
  const rpcWith = (pool) => ({
    call: async () => { throw new Error("unused"); },
    batch: async () => [{ number: "0x10", timestamp: "0x" + (now - 3).toString(16), baseFeePerGas: "0x7", gasUsed: "0x0", gasLimit: "0x5f5e100" }, null, pool],
  });
  for (const bad of [{}, { pending: null }, { pending: "12" }, { pending: 5 }]) {
    const r = await checkChain(cfg, { rpc: rpcWith(bad), nowS: () => now });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.reasons.some((x) => /txpool_status unreadable/.test(x)));
  }
  const ok = await checkChain(cfg, { rpc: rpcWith({ pending: "0x3", queued: "0x0" }), nowS: () => now });
  assert.equal(ok.ok, true, ok.reasons.join());
  assert.equal(ok.txpoolPending, 3);
});

test("config: the tip cannot go below the signers' 1 gwei minimum", () => {
  assert.throws(() => loadConfig({ TIP_GWEI: "0" }), /TIP_GWEI/);
  assert.equal(loadConfig({}).tipWei, 10n ** 9n);
});

test("organic walk: old blocks by count, recent ones by block, load-test era with every transaction; a failed read is retried", async () => {
  const { walkStep, freshOrganic, organicLast24h, RECENT } = await import("../dist/organic.js");
  const now = 1_790_000_000;
  const LT = "0x" + "11".repeat(20), OTHER = "0x" + "22".repeat(20);
  const head = RECENT + 1200, ltFrom = RECENT + 1100;
  // every 100th block holds transactions: 3 before the load test; after it, 2 of ours (marked) + 1 marked from
  // someone else + 1 plain; block n's time: 7 s per block, the head now
  const txsOf = (n) => (n % 100 ? [] : n < ltFrom
    ? [{ from: OTHER, input: "0x" }, { from: OTHER, input: "0x" }, { from: OTHER, input: "0x" }]
    : [{ from: LT, input: "0x46584c5401" }, { from: LT, input: "0x46584C5401" }, { from: OTHER, input: "0x46584c5401" }, { from: OTHER, input: "0x" }]);
  const tsOf = (n) => now - (head - n) * 7;
  const seen = new Map();
  let fail = 1;
  const rpc = {
    call: async () => { throw new Error("unused"); },
    batch: async (calls) => calls.map((c) => {
      seen.set(c.method, (seen.get(c.method) ?? 0) + 1);
      const n = Number(BigInt(c.params[0]));
      if (c.method === "eth_getBlockTransactionCountByNumber") return "0x" + txsOf(n).length.toString(16);
      if (c.method === "eth_getBlockByNumber") {
        if (c.params[1] && fail-- > 0) return null; // one unreadable block: the whole step is redone
        return { timestamp: "0x" + tsOf(n).toString(16), transactions: c.params[1] ? txsOf(n) : txsOf(n).map((_, i) => `0x${n}${i}`) };
      }
      throw new Error(c.method);
    }),
  };
  const st = freshOrganic();
  const target = head - 12;
  let steps = 0;
  while (st.cursor < target && steps++ < 1000) await walkStep(st, target, { rpc, ltFrom, isLt: (a) => a === LT, nowS: now });
  assert.equal(st.cursor, target);
  assert.ok(st.readyAt !== null);
  let organic = 0, lt = 0, day = 0;
  for (let n = 0; n <= target; n++) {
    const x = txsOf(n);
    const ours = x.filter((t) => t.from === LT).length;
    organic += x.length - ours; lt += ours;
    if (tsOf(n) >= (Math.floor(now / 600) - 143) * 600) day += x.length - ours;
  }
  assert.equal(st.total, organic);
  assert.equal(st.loadtest, lt);
  assert.equal(organicLast24h(st, now), day, "the last 24 h from the 10-minute buckets");
  assert.ok(seen.get("eth_getBlockTransactionCountByNumber") >= 1000, "old blocks: counts only");
  assert.ok(Object.keys(st.ten).every((k) => Number(k) >= Math.floor(now / 600) - 288), "48 h of buckets kept");
  // caught up: nothing more to read
  assert.equal(await walkStep(st, target, { rpc, ltFrom, isLt: (a) => a === LT, nowS: now }), false);
});

test("state: a run from before the organic walk gets its load-test era from its first confirmed block", async () => {
  const { Store } = await import("../dist/state.js");
  const legacy = { v: 1, createdAt: 1, firstLiveAt: 5, counters: { transactions: 3 }, firstTx: { at: 6, block: 407325 }, indexSnap: { transactions: [], addresses: [], last24h: [] }, indexSeen: { transactions: 10775 } };
  const s = Store.parse(JSON.stringify(legacy));
  assert.equal(s.ltFromBlock, 407305);
  assert.deepEqual(s.organic, { cursor: -1, total: 0, loadtest: 0, ten: {}, readyAt: null, at: 0 });
  assert.equal(s.indexRead, null);
  assert.deepEqual(s.indexSeen, { transactions: 10775 }, "kept for the first read, which migrates it");
  assert.equal(Store.parse(JSON.stringify({ ...legacy, firstTx: null })).ltFromBlock, null);
});
