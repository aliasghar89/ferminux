#!/usr/bin/env node
// Integration run on a LOCAL anvil fork of chain 3961. Nothing here can reach mainnet: the runner's RPC is
// the fork on 127.0.0.1 (checked below), and the fork is thrown away at the end.
//
//   anvil --fork-url https://rpc.ferminux.net --chain-id 3961 --hardfork london --block-time 1 --port <free>
//
// What it proves, with N wallets (default 1000) at a high rate:
//   - every transaction a load-test wallet sent carries the FXLT marker, and only they carry it;
//   - the runner's counters (transactions, per kind, volume, gas, per day, addresses) equal the blocks;
//   - a SIGKILL mid-run and a restart lose and double-count nothing;
//   - a signer-guard trip pauses the sends and health resumes them; HALT stops them;
//   - after the final sweep every FMX that went in is at the sink (Wizrd's address) minus exactly the gas
//     paid, and no wallet keeps more than one transfer's gas.
// Usage: node scripts/integration.mjs [--wallets 1000] [--rate 60] [--out DIR]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { loadOrCreateSeed, Keyring } from "../dist/wallets.js";
import { MARKER_DATA, MARKER_PREFIX } from "../dist/marker.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const N = Number(args.wallets ?? 1000);
const RATE = Number(args.rate ?? 60);
const OUT = args.out ?? join(tmpdir(), `fxlt-integration-${Date.now()}`);
const FORK_URL = args.fork ?? "https://rpc.ferminux.net";
const SINK = "0xD7175A244a3Eab83f574135318d037Fb6221C358";
const WEI = 10n ** 18n;
const FLOAT_IN = 250n * WEI;

mkdirSync(OUT, { recursive: true });
const DATA = join(OUT, "data"), PUB = join(OUT, "public");
rmSync(DATA, { recursive: true, force: true });
rmSync(PUB, { recursive: true, force: true });
const report = { startedAt: new Date().toISOString(), wallets: N, rate: RATE, out: OUT, events: [], checks: {} };
const note = (e, extra = {}) => { const r = { t: new Date().toISOString(), e, ...extra }; report.events.push(r); console.log(`[integration] ${e}`, Object.keys(extra).length ? JSON.stringify(extra) : ""); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

let rpcUrl;
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
async function batch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 100) {
    const chunk = calls.slice(i, i + 100).map((c, k) => ({ jsonrpc: "2.0", id: i + k, method: c[0], params: c[1] }));
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk) }).then((x) => x.json());
    const byId = new Map(r.map((x) => [x.id, x]));
    chunk.forEach((c) => { const x = byId.get(c.id); if (x?.error) throw new Error(`${c.method}: ${x.error.message}`); out.push(x?.result); });
  }
  return out;
}

// ---------------------------------------------------------------- anvil
const anvilPort = await freePort();
rpcUrl = `http://127.0.0.1:${anvilPort}`;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw new Error("refusing: the runner RPC must be the local fork");
const anvilLog = createWriteStream(join(OUT, "anvil.log"));
const anvil = spawn("anvil", ["--fork-url", FORK_URL, "--chain-id", "3961", "--hardfork", "london", "--block-time", "1", "--port", String(anvilPort), "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
anvil.stdout.pipe(anvilLog);
anvil.stderr.pipe(anvilLog);
const cleanup = [];
cleanup.push(() => anvil.kill("SIGTERM"));
process.on("exit", () => cleanup.forEach((f) => { try { f(); } catch { /* */ } }));
for (let i = 0; ; i++) {
  try { if ((await rpc("eth_chainId")) === "0xf79") break; } catch { /* starting */ }
  if (i > 120) throw new Error("anvil did not start");
  await sleep(500);
}
const forkBlock = Number(BigInt(await rpc("eth_blockNumber")));
note("anvil fork up", { port: anvilPort, forkBlock, hardfork: "london" });

// ---------------------------------------------------------------- the load-test seed, the float and the sink
const { phrase } = loadOrCreateSeed(join(DATA, "seed.txt"));
const keys = new Keyring(phrase);
const float = keys.address(0);
const lt = new Map();
for (let i = 0; i < N; i++) lt.set(keys.address(i).toLowerCase(), i);
const dev = (await rpc("eth_accounts"))[0];
const fundHash = await rpc("eth_sendTransaction", [{ from: dev, to: float, value: "0x" + FLOAT_IN.toString(16) }]);
for (let i = 0; !(await rpc("eth_getTransactionReceipt", [fundHash])); i++) { if (i > 60) throw new Error("float funding not confirmed"); await sleep(500); }
const sinkBefore = BigInt(await rpc("eth_getBalance", [SINK, "latest"]));
note("float funded by the owner (a dev account on the fork)", { float, fmx: Number(FLOAT_IN / WEI), sinkBeforeWei: sinkBefore.toString() });

// ---------------------------------------------------------------- the gateway status + explorer index stand-ins
const mock = { signersActive: 3, requests: 0 };
const mockPort = await freePort();
const mockSrv = createServer(async (req, res) => {
  mock.requests++;
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/status")) { res.end(JSON.stringify({ services: { chain: { signers: { active: mock.signersActive, total: 5 } } } })); return; }
  if (req.url.startsWith("/api/v2/main-page/blocks")) { const h = Number(BigInt(await rpc("eth_blockNumber"))); res.end(JSON.stringify([{ height: h }, { height: h - 1 }])); return; }
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => mockSrv.listen(mockPort, "127.0.0.1", r));
cleanup.push(() => mockSrv.close());

// ---------------------------------------------------------------- the runner
const env = {
  ...process.env, LOADTEST_ENABLED: "true", LOADTEST_ALLOW_HIGH_RATE: "1", RPC_URL: rpcUrl, CHAIN_ID: "3961",
  STATUS_URL: `http://127.0.0.1:${mockPort}/api/status`, EXPLORER_API: `http://127.0.0.1:${mockPort}/api/v2`, SIGNER_SOURCE: "auto",
  SINK, WALLETS: String(N), RATE_TX_PER_S: String(RATE), WAVE_SIZE: "50", MAX_ACTIVE_WAVES: "6", MAX_FLOAT_IN_FLIGHT_FMX: "150",
  FLOAT_RESERVE_FMX: "30", FLOAT_MIN_FMX: "1", SINK_SWEEP_INTERVAL_S: "20", SINK_SWEEP_MIN_FMX: "1", LOOP: "false",
  GUARD_INTERVAL_S: "2", RECEIPT_TIMEOUT_S: "30", STUCK_AFTER_S: "60", DATA_DIR: DATA, PUBLIC_DIR: PUB, TICK_MS: "40", PUBLISH_INTERVAL_S: "1",
  // the organic walk would read every block below the fork from the fork's upstream (mainnet RPC): off here,
  // it is covered by the unit tests
  ORGANIC_WALK: "false",
};
let runner = null;
let runnerLogN = 0;
function startRunner() {
  const log = createWriteStream(join(OUT, `runner-${++runnerLogN}.log`));
  const p = spawn(process.execPath, [join(here, "..", "dist", "main.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.pipe(log);
  p.stderr.pipe(log);
  runner = p;
  cleanup.push(() => p.kill("SIGKILL"));
  return p;
}
const stats = () => { try { return JSON.parse(readFileSync(join(PUB, "stats.json"), "utf8")); } catch { return null; } };
async function waitFor(what, pred, timeoutMs = 20 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const s = stats();
    if (s && pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what} (last mode ${s?.mode})`);
    await sleep(250);
  }
}

const t0 = Date.now();
startRunner();
note("runner started", { env: { WALLETS: N, RATE_TX_PER_S: RATE } });

// 1. crash (SIGKILL) at about a quarter of the pass, restart from state.json
await waitFor("25 % activated", (s) => s.wallets.activated >= Math.floor(N / 4));
const beforeKill = stats();
runner.kill("SIGKILL");
await sleep(1500);
note("SIGKILL mid-run", { activated: beforeKill.wallets.activated, txs: beforeKill.counters.transactions, pending: beforeKill.counters.pending });
startRunner();
note("runner restarted from state.json");

// 2. the signer guard: 2 of 5 → pause, nothing sent; 3 of 5 → resume
await waitFor("50 % activated", (s) => s.wallets.activated >= Math.floor(N / 2));
mock.signersActive = 2;
const paused = await waitFor("paused on signers", (s) => s.paused && /2 of 5 signers/.test(s.pauseReason ?? ""), 60_000);
const headAtPause = Number(BigInt(await rpc("eth_blockNumber")));
await sleep(6000);
const pauseWindow = await countMarked(headAtPause + 2, Number(BigInt(await rpc("eth_blockNumber"))));
note("signer guard tripped", { reason: paused.pauseReason, markedTxsInBlocksWhilePaused: pauseWindow });
report.checks.pausedSendsNothing = pauseWindow === 0;
mock.signersActive = 3;
await waitFor("resumed", (s) => !s.paused && s.mode === "running", 60_000);
note("resumed after two healthy checks");

// 3. HALT file
await waitFor("65 % activated", (s) => s.wallets.activated >= Math.floor(N * 0.65));
writeFileSync(join(DATA, "HALT"), "");
await waitFor("halted", (s) => s.mode === "halted", 30_000);
const haltHead = Number(BigInt(await rpc("eth_blockNumber")));
await sleep(5000);
const haltWindow = await countMarked(haltHead + 2, Number(BigInt(await rpc("eth_blockNumber"))));
rmSync(join(DATA, "HALT"));
await waitFor("running after HALT", (s) => s.mode === "running", 30_000);
note("HALT honoured", { markedTxsInBlocksWhileHalted: haltWindow });
report.checks.haltSendsNothing = haltWindow === 0;

// 4. to the end: every wallet activated, final sweep, float → sink, drained
const final = await waitFor("drained", (s) => s.mode === "drained" && s.drained);
const elapsedS = (Date.now() - t0) / 1000;
runner.kill("SIGTERM");
await sleep(1000);
note("drained", { elapsedS, txs: final.counters.transactions });

// ---------------------------------------------------------------- audit against the blocks
async function countMarked(from, to) {
  if (to < from) return 0;
  let n = 0;
  const bs = await batch(Array.from({ length: to - from + 1 }, (_, k) => ["eth_getBlockByNumber", ["0x" + (from + k).toString(16), true]]));
  for (const b of bs) for (const t of b?.transactions ?? []) if ((t.input ?? "").startsWith(MARKER_PREFIX)) n++;
  return n;
}
const head = Number(BigInt(await rpc("eth_blockNumber")));
const blocks = await batch(Array.from({ length: head - forkBlock }, (_, k) => ["eth_getBlockByNumber", ["0x" + (forkBlock + 1 + k).toString(16), true]]));
const all = blocks.flatMap((b) => b.transactions.map((t) => ({ ...t, ts: Number(BigInt(b.timestamp)) })));
const ours = all.filter((t) => lt.has(t.from.toLowerCase()));
const marked = all.filter((t) => (t.input ?? "").toLowerCase().startsWith(MARKER_PREFIX));
const receipts = await batch(ours.map((t) => ["eth_getTransactionReceipt", [t.hash]]));
const gas = receipts.reduce((a, r) => a + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 0n);
const vol = ours.reduce((a, t, k) => a + (receipts[k].status === "0x1" ? BigInt(t.value) : 0n), 0n);
const byDay = {};
for (const t of ours) { const d = new Date(t.ts * 1000).toISOString().slice(0, 10); byDay[d] = (byDay[d] ?? 0) + 1; }
const seen = new Set();
for (const t of ours) { seen.add(t.from.toLowerCase()); if (lt.has(t.to.toLowerCase())) seen.add(t.to.toLowerCase()); }
const bals = await batch([...lt.keys()].map((a) => ["eth_getBalance", [a, "latest"]]));
const oneTransferGas = 21_080n * (7n + 10n ** 9n);
let dust = 0n, maxDust = 0n, overDust = 0;
for (const b of bals) { const v = BigInt(b); dust += v; if (v > maxDust) maxDust = v; if (v >= oneTransferGas) overDust++; }
const sinkAfter = BigInt(await rpc("eth_getBalance", [SINK, "latest"]));
const fundAmounts = ours.filter((t) => t.from.toLowerCase() === float.toLowerCase() && t.to.toLowerCase() !== SINK.toLowerCase()).map((t) => BigInt(t.value));
const large = fundAmounts.filter((v) => v > WEI).length;
const c = final.counters;
const kinds = {};
for (const t of ours) kinds[t.to.toLowerCase() === SINK.toLowerCase() ? "sink" : "other"] = (kinds[t.to.toLowerCase() === SINK.toLowerCase() ? "sink" : "other"] ?? 0) + 1;

const checks = {
  everyLoadTestTxMarked: ours.every((t) => t.input === MARKER_DATA),
  onlyLoadTestWalletsMarked: marked.every((t) => lt.has(t.from.toLowerCase())),
  exactGasPerTx: receipts.every((r) => BigInt(r.gasUsed) === 21_080n),
  allSucceeded: receipts.every((r) => r.status === "0x1"),
  countersTransactions: c.transactions === ours.length,
  countersVolume: BigInt(c.volumeWei) === vol,
  countersGas: BigInt(c.gasWei) === gas,
  countersDaily: JSON.stringify(Object.entries(final.daily).sort()) === JSON.stringify(Object.entries(byDay).sort()),
  countersSinkKind: c.byKind.sink === (kinds.sink ?? 0),
  countersAddresses: c.addresses === seen.size && seen.size === N,
  noWalletAboveOneTransferGas: overDust === 0,
  sinkGotEverything: sinkAfter - sinkBefore === FLOAT_IN - gas - dust,
  fundingInRange: fundAmounts.every((v) => v >= WEI / 100n && v <= 20n * WEI),
};
Object.assign(report.checks, checks);
report.result = {
  elapsedS, achievedTxPerS: +(ours.length / elapsedS).toFixed(2), blocks: head - forkBlock, loadTestTxs: ours.length, byKind: c.byKind,
  gasFmx: Number(gas) / 1e18, volumeFmx: Number(vol) / 1e18, dustWei: dust.toString(), maxDustWei: maxDust.toString(),
  sinkGainFmx: Number(sinkAfter - sinkBefore) / 1e18, floatInFmx: Number(FLOAT_IN / WEI), fundings: fundAmounts.length,
  largeFundingShare: +(large / fundAmounts.length).toFixed(4), sinkTransfers: final.sinkTransfers.length, restarts: runnerLogN - 1,
  lastPause: final.lastPause, pass: final.wallets.pass,
};
report.ok = Object.values(report.checks).every(Boolean);
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, checks: report.checks, result: report.result }, null, 2));
process.exit(report.ok ? 0 : 1);
