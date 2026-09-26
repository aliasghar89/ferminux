#!/usr/bin/env node
// Measures, from any RPC for chain 3961, the two supply inputs that the gateway cannot derive from a formula:
//
//   1. The pre-authority era's issuance (blocks 1..159,999). The Ethash engine paid a block reward plus the
//      standard uncle and nephew rewards (chain/consensus/powhash/consensus.go accumulateRewards), and how many
//      uncles were included is a fact of history, not of the schedule. That era is closed, so this is measured
//      once and pinned in src/supply.ts as POW_ERA.
//   2. The EIP-1559 base fee burned (baseFeePerGas × gasUsed, every block from 1). London is active from genesis,
//      so every transaction destroys a little FMX. The gateway keeps this total current itself (src/supply.ts
//      BurnTracker); the figure measured here is the checkpoint it starts from (BURN_CHECKPOINT).
//
// Read-only: eth_blockNumber, eth_getUncleCountByBlockNumber, eth_getUncleByBlockNumberAndIndex, eth_feeHistory,
// eth_getBlockByNumber, eth_getBalance. It sends nothing and signs nothing.
//
//   node scripts/measure-supply.mjs [--rpc https://rpc.ferminux.net] [--through <block>] [--out file.json]
//
// It also cross-checks the closed-form authority-era issuance against the reward sink's balance: the sink is
// credited 50 % of every authority block reward in state and has never been withdrawn from, so its balance at
// block B is half of the authority issuance through B plus whatever was sent to it directly. The only such
// transfer is 0.001 FMX (tx 0xdd94…ffa9, block 21,045), so sinkExcessWei must print 1000000000000000 at every
// block; anything else means the formula is wrong or the sink moved.
import { writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const RPC = arg("--rpc", "https://rpc.ferminux.net");
const OUT = arg("--out", "");
const POSA_BLOCK = 160_000;
const EMISSION_FORK = 20_000;
const HALVING = 4_500_000;
const E18 = 10n ** 18n;
const SINK = "0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6";
const FINALITY = 64; // chain/params FerminuxMaxReorgDepth

const hex = (n) => "0x" + n.toString(16);
let rid = 0;
async function batch(calls, tries = 5) {
  const body = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: ++rid, method, params }));
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const byId = new Map((Array.isArray(j) ? j : [j]).map((x) => [x.id, x]));
      return body.map((b) => {
        const x = byId.get(b.id);
        if (!x || x.error) throw new Error(`${b.method} ${JSON.stringify(b.params)}: ${x?.error?.message ?? "no reply"}`);
        return x.result;
      });
    } catch (err) {
      if (attempt >= tries) throw err;
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
}
const one = async (method, params) => (await batch([[method, params]]))[0];

/** chain/consensus/powhash/ferminux.go FerminuxBlockReward */
function powReward(n) {
  if (n < EMISSION_FORK) return 6n * E18;
  const era = Math.floor(n / HALVING);
  return era > 60 ? 0n : E18 >> BigInt(era);
}

const head = Number(await one("eth_blockNumber", []));
const through = Number(arg("--through", String(head - FINALITY)));
console.error(`rpc ${RPC} · head ${head} · measuring through block ${through}`);

// ---- 1. pre-authority era: base + uncle + nephew rewards ------------------------------------------------------
let base = 0n;
for (let n = 1; n < POSA_BLOCK; n++) base += powReward(n);
const withUncles = [];
const STEP = 500;
for (let from = 1; from < POSA_BLOCK; from += STEP) {
  const to = Math.min(POSA_BLOCK - 1, from + STEP - 1);
  const calls = [];
  for (let n = from; n <= to; n++) calls.push(["eth_getUncleCountByBlockNumber", [hex(n)]]);
  const res = await batch(calls);
  res.forEach((c, i) => { if (Number(c) > 0) withUncles.push([from + i, Number(c)]); });
  if ((from - 1) % 20_000 === 0) console.error(`  uncles: scanned to ${to}, ${withUncles.length} blocks with uncles so far`);
}
const uncleCalls = withUncles.flatMap(([n, c]) => Array.from({ length: c }, (_, i) => ["eth_getUncleByBlockNumberAndIndex", [hex(n), hex(i)], n]));
let uncleReward = 0n, nephewReward = 0n;
for (let i = 0; i < uncleCalls.length; i += 200) {
  const part = uncleCalls.slice(i, i + 200);
  const res = await batch(part.map(([m, p]) => [m, p]));
  res.forEach((u, k) => {
    const n = part[k][2];
    const un = Number(u.number);
    const R = powReward(n);
    uncleReward += (BigInt(un + 8 - n) * R) / 8n;
    nephewReward += R / 32n;
  });
}
const powIssued = base + uncleReward + nephewReward;

// ---- 2. burned base fees, blocks 1..through ----------------------------------------------------------------
let burned = 0n, blocksWithGas = 0, maxBaseFee = 0n;
const gasBlocks = [];
for (let newest = through; newest >= 1; newest -= 1024) {
  const count = Math.min(1024, newest);
  const fh = await one("eth_feeHistory", [hex(count), hex(newest), []]);
  const oldest = Number(fh.oldestBlock);
  fh.gasUsedRatio.forEach((r, i) => { if (r > 0 && oldest + i >= 1) gasBlocks.push(oldest + i); });
}
gasBlocks.sort((a, b) => a - b);
for (let i = 0; i < gasBlocks.length; i += 100) {
  const part = gasBlocks.slice(i, i + 100);
  const res = await batch(part.map((n) => ["eth_getBlockByNumber", [hex(n), false]]));
  for (const b of res) {
    const fee = BigInt(b.baseFeePerGas ?? 0), gas = BigInt(b.gasUsed);
    if (gas > 0n) blocksWithGas++;
    if (fee > maxBaseFee) maxBaseFee = fee;
    burned += fee * gas;
  }
  if (i % 5000 === 0) console.error(`  burn: ${i}/${gasBlocks.length} blocks with gas read`);
}

// ---- 3. cross-check: sink balance = 50 % of the authority issuance ------------------------------------------
let posaIssued = 0n;
for (let e = 0; e <= 61; e++) {
  const lo = Math.max(POSA_BLOCK, e * HALVING), hi = Math.min(through, (e + 1) * HALVING - 1);
  if (hi < lo) continue;
  const R = e > 60 ? 0n : (E18 >> BigInt(e)) / 4n;
  posaIssued += BigInt(hi - lo + 1) * R;
}
const sinkBal = BigInt(await one("eth_getBalance", [SINK, hex(through)]));
const sinkExpected = (posaIssued * 50n) / 100n; // per block the split floors; R/4 is a multiple of 100 wei in every era used so far

const out = {
  measuredAt: new Date().toISOString(),
  rpc: RPC,
  head,
  through,
  powEra: {
    fromBlock: 1,
    toBlock: POSA_BLOCK - 1,
    baseRewardWei: base.toString(),
    unclesIncluded: uncleCalls.length,
    blocksWithUncles: withUncles.length,
    uncleRewardWei: uncleReward.toString(),
    nephewRewardWei: nephewReward.toString(),
    issuedWei: powIssued.toString(),
  },
  burn: { throughBlock: through, burnedWei: burned.toString(), blocksWithGas, maxBaseFeeWei: maxBaseFee.toString() },
  crossCheck: {
    posaIssuedWei: posaIssued.toString(),
    sinkBalanceWei: sinkBal.toString(),
    sinkExpectedWei: sinkExpected.toString(),
    sinkExcessWei: (sinkBal - sinkExpected).toString(),
  },
};
const json = JSON.stringify(out, null, 2);
console.log(json);
if (OUT) writeFileSync(OUT, json + "\n");
