// The runner end to end on the in-memory chain: waves, sweeps, the final sweep, the sink, restarts,
// guards, dry-run, HALT and fee bumps. Every run ends with the same audit: every transaction from a
// load-test wallet carries the marker, the counters equal what is in the blocks, and every coin that
// went in is back at the sink minus gas and dust smaller than one transfer's gas.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MARKER_DATA } from "../dist/marker.js";
import { TransportError } from "../dist/rpc.js";
import { world, drive, addrOf, SINK, WEI } from "./helpers.mjs";

const ONE_TRANSFER_GAS = 21_080n * (7n + 10n ** 9n);

function audit(w, runner, { floatIn, sinkBefore, wallets }) {
  const lt = new Map();
  for (let i = 0; i < wallets; i++) lt.set(addrOf(i).toLowerCase(), i);
  const inBlocks = w.chain.blockTxs();
  const ours = inBlocks.filter((t) => lt.has(t.from.toLowerCase()));
  for (const t of ours) assert.equal(t.data, MARKER_DATA, `tx ${t.hash} from a load-test wallet carries the marker`);
  for (const t of inBlocks.filter((x) => x.data?.startsWith("0x46584c54"))) assert.ok(lt.has(t.from.toLowerCase()), "only load-test wallets use the marker");
  const c = runner.s.counters;
  assert.equal(c.transactions, ours.length, "counted transactions = marked transactions in blocks");
  assert.equal(c.failed, 0);
  const vol = ours.reduce((a, t) => a + t.value, 0n);
  const gas = ours.reduce((a, t) => a + BigInt(t.receipt.gasUsed) * BigInt(t.receipt.effectiveGasPrice), 0n);
  assert.equal(BigInt(c.volumeWei), vol, "volume");
  assert.equal(BigInt(c.gasWei), gas, "gas");
  for (const t of ours) assert.equal(BigInt(t.receipt.gasUsed), 21_080n, "exact gas per transfer");
  const byDay = {};
  for (const t of ours) { const d = new Date(t.timestamp * 1000).toISOString().slice(0, 10); byDay[d] = (byDay[d] ?? 0) + 1; }
  assert.deepEqual(runner.s.daily, byDay, "per-day counts by block time");
  const kinds = runner.s.counters.byKind;
  assert.equal(Object.values(kinds).reduce((a, b) => a + b, 0), c.transactions);
  // nothing stranded
  let dust = 0n, maxDust = 0n;
  for (let i = 0; i < wallets; i++) {
    const b = w.chain.balance(addrOf(i));
    assert.ok(b < ONE_TRANSFER_GAS, `wallet ${i} keeps ${b} wei (must be below one transfer's gas)`);
    dust += b;
    if (b > maxDust) maxDust = b;
  }
  const sinkAfter = w.chain.balance(SINK);
  assert.equal(sinkAfter - sinkBefore, floatIn - gas - dust, "every coin is at the sink, minus gas and dust");
  return { txs: ours.length, gas, dust, maxDust, sinkGain: sinkAfter - sinkBefore };
}

test("a full pass on 40 wallets: waves, transfers, sweeps, final sweep, everything back at the sink", async (t) => {
  const w = world(t, { SINK_SWEEP_INTERVAL_S: "4", RATE_TX_PER_S: "30" });
  const floatIn = 100n * WEI;
  const sinkBefore = 5n * WEI;
  w.chain.fund(SINK, sinkBefore);
  const r = w.make();
  w.chain.fund(r.floatAddr, floatIn);
  await r.start();
  await drive(w, r, { until: (x) => x.s.drained });
  const a = audit(w, r, { floatIn, sinkBefore, wallets: 40 });
  assert.equal(r.s.highestActivated, 39);
  const st = JSON.parse(readFileSync(join(w.env.PUBLIC_DIR, "stats.json"), "utf8"));
  assert.equal(st.counters.transactions, a.txs);
  assert.equal(st.counters.addresses, 40);
  assert.equal(st.wallets.activated, 39);
  assert.equal(st.marker.data, MARKER_DATA);
  assert.equal(st.float.address, addrOf(0));
  assert.match(st.derivation.xpub, /^xpub/);
  assert.equal(readFileSync(join(w.env.PUBLIC_DIR, "addresses.bin")).length, 40 * 20);
  // periodic sink sweeps happened during the pass, not only at the end
  assert.ok(r.s.sinkTransfers.length >= 2, `sink transfers: ${r.s.sinkTransfers.length}`);
  // every kind of transaction happened
  for (const k of ["fund", "transfer", "sweep", "sink"]) assert.ok(r.s.counters.byKind[k] > 0, k);
  // the float is empty at the end
  assert.ok(w.chain.balance(r.floatAddr) < ONE_TRANSFER_GAS);
  // the seed never reached the log
  assert.ok(w.lines.every((l) => !l.includes("test test test")));
});

test("restarts at random points (including between signing and broadcasting) count every nonce once", async (t) => {
  const w = world(t, { WALLETS: "60", RATE_TX_PER_S: "10" });
  const floatIn = 80n * WEI;
  w.chain.fund(SINK, 0n);
  let r = w.make(11);
  w.chain.fund(r.floatAddr, floatIn);
  await r.start();
  let restarts = 0;
  // a transport failure on a broadcast leaves a signed transaction in the log that the node never saw
  w.chain.failNext.push({ method: "eth_sendRawTransaction", error: new TransportError("socket hang up") });
  for (let round = 0; round < 12 && !r.s.drained; round++) {
    const ticks = 12 + round * 7;
    for (let i = 0; i < ticks && !r.s.drained; i++) {
      await r.tick();
      w.advance(250);
      if (i % 4 === 0) w.chain.confirmBlock();
    }
    if (r.s.drained) break;
    // crash: the process dies; a new one starts from state.json and the seed
    r = w.make(100 + round);
    await r.start();
    restarts++;
    if (round === 2) w.chain.failNext.push({ method: "eth_sendRawTransaction", error: new TransportError("ECONNRESET") });
  }
  await drive(w, r, { until: (x) => x.s.drained });
  assert.ok(restarts >= 3, `restarts: ${restarts}`);
  audit(w, r, { floatIn, sinkBefore: 0n, wallets: 60 });
});

test("guards: stale head, too few signers, a full pool, a lagging or unreachable explorer and a dry float each pause; health resumes", async (t) => {
  const w = world(t, { WALLETS: "400", MAX_FLOAT_IN_FLIGHT_FMX: "20" });
  const r = w.make();
  w.chain.fund(r.floatAddr, 60n * WEI);
  await r.start();
  const sends = () => w.chain.count("eth_sendRawTransaction");
  await drive(w, r, { until: () => sends() > 20, maxTicks: 400 });

  const expectPause = async (why, set, clear) => {
    set();
    await drive(w, r, { until: (x) => x.mode === "paused", maxTicks: 100 });
    const st = r.stats();
    assert.equal(st.paused, true);
    assert.match(st.pauseReason, why);
    assert.match(st.lastPause.reason, why);
    const before = sends();
    for (let i = 0; i < 30; i++) { await r.tick(); w.advance(250); if (i % 4 === 0) w.chain.confirmBlock(); }
    assert.equal(sends(), before, `nothing is sent while paused (${why})`);
    clear();
    await drive(w, r, { until: (x) => x.mode === "running", maxTicks: 200 });
    await drive(w, r, { until: () => sends() > before, maxTicks: 200 });
  };
  await expectPause(/head is \d+ s old/, () => { w.chain.headTimestampOverride = Math.floor(w.clock() / 1000) - 45; }, () => { w.chain.headTimestampOverride = null; });
  await expectPause(/2 of 5 signers confirming/, () => { w.chain.signersActive = 2; }, () => { w.chain.signersActive = 3; });
  await expectPause(/2500 transactions pending/, () => { w.chain.poolPendingOverride = 2500; }, () => { w.chain.poolPendingOverride = null; });
  await expectPause(/explorer index is 150 blocks behind/, () => { w.fetchOpts.explorerLag = 150; }, () => { w.fetchOpts.explorerLag = 0; });
  await expectPause(/explorer index unreachable/, () => { w.fetchOpts.explorerDown = true; }, () => { w.fetchOpts.explorerDown = false; });
  // no clique namespace on the RPC: the gateway's /api/status answers instead (and can pause too)
  await expectPause(/1 of 5 signers confirming/, () => { w.chain.noClique = true; w.fetchOpts.gatewayActive = 1; }, () => { w.fetchOpts.gatewayActive = 3; });
  assert.equal(r.stats().guards.signers.source, "gateway");
  w.chain.noClique = false;
  // unreadable signers is a pause too (fail closed)
  await expectPause(/signer activity unreadable/, () => { w.chain.noClique = true; w.fetchOpts.gatewayActive = "x"; }, () => { w.chain.noClique = false; w.fetchOpts.gatewayActive = null; });
});

test("the float guard: an empty float with nothing out pauses until it is funded", async (t) => {
  const w = world(t, { WALLETS: "50" });
  const r = w.make();
  w.chain.fund(r.floatAddr, WEI / 2n); // 0.5 FMX, below FLOAT_MIN_FMX=1
  await r.start();
  await drive(w, r, { until: (x) => x.mode === "paused", maxTicks: 100 });
  assert.match(r.stats().pauseReason, /float holds 0\.5 FMX, below its 1 FMX minimum/);
  assert.equal(w.chain.count("eth_sendRawTransaction"), 0);
  w.chain.fund(r.floatAddr, 50n * WEI);
  await drive(w, r, { until: () => w.chain.count("eth_sendRawTransaction") > 0, maxTicks: 200 });
});

test("dry-run (the default): plans and logs, signs and sends nothing, keeps no progress", async (t) => {
  const w = world(t, { LOADTEST_ENABLED: "" });
  const r = w.make();
  w.chain.fund(r.floatAddr, 100n * WEI);
  await r.start();
  for (let i = 0; i < 400; i++) { await r.tick(); w.advance(250); if (i % 4 === 0) w.chain.confirmBlock(); }
  assert.equal(r.mode, "dry-run");
  assert.equal(w.chain.count("eth_sendRawTransaction"), 0);
  assert.equal(r.s.nextIndex, 1);
  assert.equal(r.s.counters.transactions, 0);
  assert.equal(existsSync(join(w.env.DATA_DIR, "state.json")), false, "no progress is written");
  const planned = w.lines.filter((l) => l.includes("dry-run: would run wave"));
  assert.ok(planned.length >= 3, `planned waves: ${planned.length}`);
  assert.ok(w.lines.some((l) => l.includes("DRY-RUN")));
  const st = JSON.parse(readFileSync(join(w.env.PUBLIC_DIR, "stats.json"), "utf8"));
  assert.equal(st.mode, "dry-run");
  assert.equal(st.enabled, false);
});

test("HALT on the volume stops sending until it is removed; DRAIN brings every coin home and stops", async (t) => {
  const w = world(t, { WALLETS: "400", LOOP: "true" });
  const floatIn = 100n * WEI;
  const r = w.make();
  w.chain.fund(r.floatAddr, floatIn);
  await r.start();
  await drive(w, r, { until: () => w.chain.count("eth_sendRawTransaction") > 30, maxTicks: 400 });
  mkdirSync(w.env.DATA_DIR, { recursive: true });
  writeFileSync(join(w.env.DATA_DIR, "HALT"), "");
  await r.tick();
  assert.equal(r.mode, "halted");
  const before = w.chain.count("eth_sendRawTransaction");
  for (let i = 0; i < 60; i++) { await r.tick(); w.advance(250); if (i % 4 === 0) w.chain.confirmBlock(); }
  assert.equal(w.chain.count("eth_sendRawTransaction"), before);
  rmSync(join(w.env.DATA_DIR, "HALT"));
  await drive(w, r, { until: () => w.chain.count("eth_sendRawTransaction") > before, maxTicks: 100 });
  // drain in the middle of a pass
  writeFileSync(join(w.env.DATA_DIR, "DRAIN"), "");
  await drive(w, r, { until: (x) => x.s.drained && x.mode === "drained" });
  assert.ok(r.s.nextIndex < 400, "the pass was cut short");
  audit(w, r, { floatIn, sinkBefore: 0n, wallets: r.s.highestActivated + 1 });
  // lifting the drain carries on where it stopped
  rmSync(join(w.env.DATA_DIR, "DRAIN"));
  w.chain.fund(r.floatAddr, 50n * WEI);
  const next = r.s.nextIndex;
  await drive(w, r, { until: (x) => x.s.nextIndex > next, maxTicks: 300 });
});

test("a transaction the signers will not include gets a fee-bumped replacement; the sweep stays exact", async (t) => {
  const w = world(t, { WALLETS: "12", WAVE_SIZE: "11", STUCK_AFTER_S: "10" });
  const floatIn = 30n * WEI;
  const r = w.make();
  w.chain.fund(r.floatAddr, floatIn);
  await r.start();
  let held = null;
  await drive(w, r, {
    until: (x) => x.s.drained,
    onTick: () => {
      if (held) return;
      // hold the first sweep that reaches the pool
      for (const [h, p] of w.chain.pool) {
        const it = r.s.pending.find((x) => x.variants.some((v) => v.hash === h));
        if (it && it.kind === "sweep") { held = h; w.chain.hold.add(h); break; }
      }
    },
  });
  assert.ok(held, "a sweep was held");
  assert.ok(w.lines.some((l) => l.includes("fee bump")), "a replacement was signed");
  assert.equal(w.chain.receipts.has(held), false, "the held variant never landed");
  audit(w, r, { floatIn, sinkBefore: 0n, wallets: 12 });
});

test("LOOP: a finished pass keeps the float's reserve, sends the rest to the sink and starts over on the same wallets", async (t) => {
  const w = world(t, { WALLETS: "15", WAVE_SIZE: "7", LOOP: "true", FLOAT_RESERVE_FMX: "10", SINK_SWEEP_INTERVAL_S: "100000" });
  const floatIn = 40n * WEI;
  const r = w.make();
  w.chain.fund(r.floatAddr, floatIn);
  await r.start();
  await drive(w, r, { until: (x) => x.s.pass === 2 && x.s.nextIndex > 1 && x.s.waves.length === 0 });
  assert.equal(r.s.drained, false);
  assert.equal(r.s.sinkTransfers.length, 1, "one closing transfer at the end of pass 1");
  const floatLeft = w.chain.balance(r.floatAddr);
  // the reserve, minus the gas pass 2 has spent since (a wave of 7 wallets: well under 0.01 FMX)
  assert.ok(floatLeft <= 10n * WEI && floatLeft > 10n * WEI - WEI / 100n, `the float keeps its reserve: ${floatLeft}`);
  assert.ok(w.chain.nonce(addrOf(1)) >= 2, "pass 2 reused wallet 1");
  // stop cleanly and audit: every coin is back at the sink
  writeFileSync(join(w.env.DATA_DIR, "DRAIN"), "");
  await drive(w, r, { until: (x) => x.s.drained });
  audit(w, r, { floatIn, sinkBefore: 0n, wallets: 15 });
  assert.equal(r.stats().counters.addresses, 15);
});

test("index snapshots: each recount of the explorer index is paired with the load-test count it contains", async (t) => {
  const w = world(t, { WALLETS: "120", RATE_TX_PER_S: "30", SINK_SWEEP_INTERVAL_S: "4" });
  const ORGANIC = 5000, ORGANIC_ADDRS = 400;
  const marked = () => w.chain.blockTxs().filter((x) => x.data?.startsWith("0x46584c54")).length;
  // the index recounts now and then (Blockscout: every 2 h); in between it keeps answering the old figure
  w.fetchOpts.index = { transactions: ORGANIC, addresses: ORGANIC_ADDRS, last24h: 7 };
  // the figure read before anything was sent holds none of ours
  const recounts = [{ total: ORGANIC, lt: 0 }];
  const r = w.make();
  w.chain.fund(r.floatAddr, 100n * WEI);
  await r.start();
  let worstNaive = 0, first = null;
  await drive(w, r, {
    until: (x) => x.s.drained,
    onTick: (i) => {
      if (i === 0) first = { ...r.s.indexSnap.transactions[0] };
      if (i > 0 && i % 12 === 0) {
        // what "index − live counter" would have shown just before this recount (the old, stale figure)
        worstNaive = Math.max(worstNaive, Math.abs(w.fetchOpts.index.transactions - r.s.counters.transactions - ORGANIC));
        const lt = marked();
        w.fetchOpts.index.transactions = ORGANIC + lt;
        recounts.push({ total: ORGANIC + lt, lt });
      }
    },
  });
  // one more guard read after the pass, so the last recount is seen
  for (let i = 0; i < 20; i++) { await r.tick(); w.advance(250); }
  const snaps = r.s.indexSnap.transactions;
  assert.ok(snaps.length >= 2, `snapshots: ${snaps.length}`);
  assert.equal(first.index, ORGANIC);
  assert.deepEqual([first.lt, first.lo, first.hi], [0, 0, 0], "read before anything was sent: none of ours in it");
  // the recorded count is off by at most the sends of one read interval (30 tx/s × 2 s), the truth lies in
  // [lo, hi], and the organic figure the explorer derives from it (index − recorded count) stays within that
  const slack = 30 * 2;
  let worstSnap = 0;
  for (const s of snaps) {
    const rc = recounts.find((x) => x.total === s.index);
    assert.ok(rc, `snapshot ${s.index} matches a recount`);
    assert.ok(Math.abs(s.lt - rc.lt) <= slack, `recorded ${s.lt} vs ${rc.lt} in the index`);
    assert.ok(s.lo !== null && s.lo <= rc.lt && rc.lt <= s.hi, `${rc.lt} within [${s.lo}, ${s.hi}]`);
    worstSnap = Math.max(worstSnap, Math.abs(s.index - s.lt - ORGANIC));
  }
  assert.ok(worstSnap <= slack, `organic from the snapshots is off by at most ${worstSnap}`);
  assert.ok(worstNaive > worstSnap, `live subtraction from a stale figure is off by up to ${worstNaive}: the reason for snapshots`);
  // stats carry the snapshots and the last read
  const st = JSON.parse(readFileSync(join(w.env.PUBLIC_DIR, "stats.json"), "utf8"));
  assert.deepEqual(st.indexSnapshot.transactions, snaps);
  assert.equal(st.indexRead.transactions, w.fetchOpts.index.transactions);
  // they survive a restart, and so does the last read: a recount while the runner is down is still bracketed
  const r2 = w.make();
  assert.deepEqual(r2.s.indexSnap.transactions, snaps);
  const ours = r2.s.counters.transactions;
  w.fetchOpts.index.transactions += 3; // three organic transactions, counted while we were away
  await r2.start();
  for (let i = 0; i < 12; i++) { await r2.tick(); w.advance(250); }
  const last = r2.s.indexSnap.transactions.at(-1);
  assert.equal(last.index, w.fetchOpts.index.transactions);
  assert.deepEqual([last.lo, last.hi, last.lt], [ours, ours, ours], "bracketed by the read before the restart");
});

test("organic walk: every transaction in the blocks that is not the load test's, counted from the chain", async (t) => {
  const w = world(t, { WALLETS: "60", RATE_TX_PER_S: "30", SINK_SWEEP_INTERVAL_S: "4" });
  // history before the test: 7 blocks, 2 organic transactions each
  for (let i = 0; i < 7; i++) { w.chain.organic(2); w.chain.confirmBlock(); }
  const r = w.make();
  w.chain.fund(r.floatAddr, 100n * WEI);
  await r.start();
  await drive(w, r, {
    until: (x) => x.s.drained,
    onTick: (i) => {
      if (i % 10 === 0) w.chain.organic(1);
      // the marker alone labels nothing: a marked transfer from someone else is organic
      if (i % 25 === 0) w.chain.organic(1, { from: "0x00000000000000000000000000000000000000cc", data: "0x46584c5401" });
    },
  });
  for (let i = 0; i < 8; i++) w.chain.confirmBlock();
  for (let i = 0; i < 40; i++) { await r.tick(); w.advance(250); }
  const o = r.s.organic;
  assert.equal(o.cursor, w.chain.head().number - 2, "walked to the head minus the confirmations");
  const upTo = w.chain.blockTxs().filter((x) => x.block <= o.cursor);
  const organic = upTo.filter((x) => x.organic).length;
  assert.ok(organic > 20, `organic transactions in the test: ${organic}`);
  assert.equal(o.total, organic, "organic = every transaction but the load test's");
  assert.equal(o.loadtest, upTo.length - organic, "load-test transactions found by the walk");
  assert.equal(o.loadtest, r.s.counters.transactions, "and they match the runner's own count");
  const st = JSON.parse(readFileSync(join(w.env.PUBLIC_DIR, "stats.json"), "utf8"));
  assert.equal(st.organic.ready, true);
  assert.equal(st.organic.transactions, organic);
  assert.equal(st.organic.last24h, organic, "all of it inside the last 24 h");
  assert.equal(st.organic.throughBlock, o.cursor);
  // kept across a restart
  const r2 = w.make();
  assert.deepEqual(r2.s.organic, o);
});

test("switched to dry-run mid-run: nothing more is sent, but the transactions already out are still counted", async (t) => {
  const w = world(t, { WALLETS: "200" });
  const r = w.make();
  w.chain.fund(r.floatAddr, 100n * WEI);
  await r.start();
  await drive(w, r, { until: (x) => x.s.pending.length > 3 && x.s.waves.length > 0, maxTicks: 400 });
  const sent = w.chain.count("eth_sendRawTransaction");
  w.env.LOADTEST_ENABLED = "false";
  const d = w.make();
  await d.start();
  for (let i = 0; i < 80; i++) { await d.tick(); w.advance(250); if (i % 4 === 0) w.chain.confirmBlock(); }
  assert.equal(d.mode, "dry-run");
  assert.equal(w.chain.count("eth_sendRawTransaction"), sent, "dry-run sends nothing");
  assert.equal(d.s.pending.length, 0, "every transaction already sent was read from its receipt");
  const ours = w.chain.blockTxs().filter((x) => x.data?.startsWith("0x46584c54")).length;
  assert.equal(d.stats().counters.transactions, ours, "the public counter matches the blocks");
  assert.ok(w.lines.some((l) => l.includes("dry-run with a live run in progress")));
  // enabled again: it carries on and ends with every coin home
  w.env.LOADTEST_ENABLED = "true";
  w.env.WALLETS = "200";
  const r2 = w.make();
  await r2.start();
  writeFileSync(join(w.env.DATA_DIR, "DRAIN"), "");
  await drive(w, r2, { until: (x) => x.s.drained });
  audit(w, r2, { floatIn: 100n * WEI, sinkBefore: 0n, wallets: r2.s.highestActivated + 1 });
});

test("a lost closing transfer is sent again, never recorded as drained; no float send while its nonce is being re-read", async (t) => {
  const w = world(t, { WALLETS: "3" });
  const r = w.make();
  w.chain.fund(r.floatAddr, 20n * WEI);
  await r.start();
  await drive(w, r, { until: (x) => x.s.finalSweep?.closing === true && x.s.pending.some((p) => p.kind === "sink") });
  const p = r.s.pending.find((x) => x.kind === "sink");
  for (const v of p.variants) w.chain.pool.delete(v.hash); // the node dropped it: no variant will ever land
  r.markLost(p, "test: no receipt for any variant");
  assert.equal(r.s.finalSweep.closing, false, "the closing transfer will be sent again");
  assert.equal(r.s.floatNonce, null);
  // the same tick goes on: nothing may be signed from the float until the next preflight re-reads its nonce
  const sends = w.chain.count("eth_sendRawTransaction");
  assert.equal(await r.sendFloatToSink(WEI, { maxFeePerGas: 10n ** 9n + 7n, maxPriorityFeePerGas: 10n ** 9n }, undefined), false);
  assert.equal(w.chain.count("eth_sendRawTransaction"), sends);
  assert.ok(!r.s.pending.some((x) => x.kind === "sink"));
  await drive(w, r, { until: (x) => x.s.drained });
  assert.ok(w.chain.balance(r.floatAddr) < 21_080n * (7n + 10n ** 9n), "the float was emptied to the sink after all");
});
