// Finality: work-and-time, the pace monitor, and the weak-subjectivity
// checkpoint — every refusal path, plus the config rules that make the mode
// explicit.
//
// The chains here are hand-built header chains served by tiny JSON-RPC fakes
// on port 0 (two per chain, because the monitor reads through the same quorum
// the validator signs on). The clock is injected, so "hours have passed" is a
// number rather than a sleep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, ZeroAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';

import { Alerter } from '../src/alerts.ts';
import { ChainClient } from '../src/chain.ts';
import { DEFAULT_PACE, INSECURE_ACKNOWLEDGEMENT, parseConfig } from '../src/config.ts';
import { FinalityMonitor, REGISTRY_ABI, needsFinalityMonitor, unmonitoredFinalityStatus } from '../src/finality.ts';
import { openStore } from '../src/db.ts';
import { Metrics } from '../src/metrics.ts';
import { RelayerService } from '../src/service.ts';
import { VolumeLimiter } from '../src/limits.ts';
import { createLogger } from '../src/logger.ts';
import { digestFor, transferIdOf } from '../src/transfer.ts';
import { FINALITY_CODES, verifyForSigning } from '../src/verify.ts';

const SRC = 3961;
const REG = 56;
const BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const REGISTRY = '0x1111111111111111111111111111111111111111';
const registryIface = new Interface(REGISTRY_ABI);

const silentLogger = () => createLogger('error', 'json', {}, () => {});
function alerter() {
  const a = new Alerter({ alerts: { webhookUrl: null, minSeverity: 'critical', throttleMs: 0 }, network: 'test' }, 'test', silentLogger());
  const fired = [];
  const real = a.fire.bind(a);
  a.fire = (x) => {
    fired.push(x);
    return real(x);
  };
  return { a, fired };
}

// ------------------------------------------------------------- header chains

const BASE_TS = 1_800_000_000; // seconds

/** A linear chain of `length` headers from genesis with a fixed gap and difficulty. */
function buildChain({ length, gapSec = 7, difficulty = 1_000n, tag = 'main', from = null, gapsSec = null }) {
  const headers = from ? from.slice() : [];
  let parent = headers.length > 0 ? headers[headers.length - 1] : null;
  while (headers.length < length) {
    const number = headers.length;
    const gap = gapsSec ? (gapsSec[number] ?? gapSec) : gapSec;
    const timestamp = parent ? parent.timestamp + gap : BASE_TS;
    const parentHash = parent ? parent.hash : `0x${'00'.repeat(32)}`;
    const hash = keccak256(toUtf8Bytes(`${tag}:${number}:${parentHash}:${timestamp}`));
    const h = { number, hash, parentHash, timestamp, difficulty };
    headers.push(h);
    parent = h;
  }
  return headers;
}

function rpcBlock(h) {
  return {
    hash: h.hash,
    parentHash: h.parentHash,
    number: `0x${h.number.toString(16)}`,
    timestamp: `0x${h.timestamp.toString(16)}`,
    nonce: '0x0000000000000000',
    difficulty: `0x${h.difficulty.toString(16)}`,
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    miner: ZeroAddress,
    extraData: '0x',
    baseFeePerGas: '0x1',
    transactions: [],
    sha3Uncles: `0x${'00'.repeat(32)}`,
    stateRoot: `0x${'00'.repeat(32)}`,
    receiptsRoot: `0x${'00'.repeat(32)}`,
    transactionsRoot: `0x${'00'.repeat(32)}`,
    logsBloom: `0x${'00'.repeat(256)}`,
    mixHash: `0x${'00'.repeat(32)}`,
    size: '0x200',
    totalDifficulty: '0x0',
    uncles: [],
  };
}

/**
 * Shared chain state for one or more fake endpoints. `byNumber` is what the
 * canonical lookup returns; `byHash` includes everything ever served, so a
 * fork can be walked by hash even when it is not canonical.
 */
function chainState(headers, chainId = SRC) {
  const state = { chainId, byNumber: new Map(), byHash: new Map(), failBlocks: false, failCalls: false, registry: null };
  state.load = (hs) => {
    for (const h of hs) {
      state.byNumber.set(h.number, h);
      state.byHash.set(h.hash, h);
    }
    state.head = Math.max(...state.byNumber.keys());
  };
  state.load(headers);
  return state;
}

async function fakeRpc(state) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = JSON.parse(body);
      const reply = (result) => ({ jsonrpc: '2.0', id: p.id, result });
      const error = (message) => ({ jsonrpc: '2.0', id: p.id, error: { code: -32000, message } });
      let out;
      switch (p.method) {
        case 'eth_chainId':
          out = reply(`0x${state.chainId.toString(16)}`);
          break;
        case 'eth_blockNumber':
          out = state.failBlocks ? error('node is broken') : reply(`0x${state.head.toString(16)}`);
          break;
        case 'eth_getBlockByNumber': {
          if (state.failBlocks) {
            out = error('node is broken');
            break;
          }
          const tag = p.params[0];
          const n = tag === 'latest' ? state.head : Number(BigInt(tag));
          const h = state.byNumber.get(n);
          out = reply(h ? rpcBlock(h) : null);
          break;
        }
        case 'eth_getBlockByHash': {
          if (state.failBlocks) {
            out = error('node is broken');
            break;
          }
          const h = state.byHash.get(String(p.params[0]).toLowerCase());
          out = reply(h ? rpcBlock(h) : null);
          break;
        }
        case 'eth_call': {
          if (state.failCalls || !state.registry) {
            out = state.failCalls ? error('node is broken') : reply('0x');
            break;
          }
          const data = String(p.params[0].data);
          if (data.startsWith(registryIface.getFunction('latest').selector)) {
            const r = state.registry;
            out = reply(registryIface.encodeFunctionResult('latest', [r.number, r.hash, r.attestedAt]));
          } else {
            out = reply('0x');
          }
          break;
        }
        default:
          out = { jsonrpc: '2.0', id: p.id, error: { code: -32601, message: `unsupported: ${p.method}` } };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeIdleConnections?.();
        server.close(r);
        server.closeAllConnections?.();
      }),
  };
}

// ------------------------------------------------------------------ config

function configText({ finality = {}, srcExtra = {}, regExtra = {}, srcUrls, regUrls, chains } = {}) {
  const urlsA = srcUrls ?? ['http://127.0.0.1:1', 'http://127.0.0.1:2', 'http://127.0.0.1:3'];
  const urlsB = regUrls ?? ['http://127.0.0.1:4', 'http://127.0.0.1:5', 'http://127.0.0.1:6'];
  const limits = { default: { maxPerTransfer: '10000000000000000000', dailyCap: '100000000000000000000' }, tokens: {} };
  return JSON.stringify({
    network: 'test',
    chains: chains ?? [
      { name: 'src', chainId: SRC, rpcUrls: urlsA, minAgreeingEndpoints: 2, bridgeAddress: BRIDGE, confirmations: 3, pollIntervalMs: 500, limits, finality, ...srcExtra },
      { name: 'reg', chainId: REG, rpcUrls: urlsB, minAgreeingEndpoints: 2, bridgeAddress: BRIDGE, confirmations: 3, pollIntervalMs: 500, limits, ...regExtra },
    ],
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
  });
}
const parse = (o) => parseConfig(configText(o), 'x');

const WORK_AND_TIME = { mode: 'work-and-time', workThreshold: '10000', timeFloorMs: 60_000, pace: { targetBlockTimeMs: 7_000, window: 8, degradedFactor: 4, stallAfterMs: 120_000 } };
const CHECKPOINT = (extra = {}) => ({
  mode: 'checkpoint',
  pace: { targetBlockTimeMs: 7_000, window: 8, degradedFactor: 4, stallAfterMs: 120_000 },
  checkpoint: { registryAddress: REGISTRY, registryChainId: REG, maxAgeMs: 3_600_000, ...extra },
});

test('config: finality.mode must be one of the three named modes', () => {
  assert.throws(() => parse({ finality: { mode: 'vibes' } }), /must be "count", "work-and-time" or "checkpoint"/);
});

test('config: absent finality block means count mode with no monitor — but only under the devnet switch', () => {
  const cfg = parse({});
  assert.equal(cfg.chains[0].finality.mode, 'count');
  assert.equal(cfg.chains[0].finality.pace, null);
  assert.equal(cfg.chains[0].finality.checkpoint, null);
  assert.equal(needsFinalityMonitor(cfg.chains[0].finality), false);
});

test('config: an ENABLED chain without a finality gadget must name its mode — a pre-existing chains.json gets a startup error, not silent count mode', () => {
  // The operator's real chains.json predates the finality block. Restarting the
  // three validators on it must fail loudly, not boot with no pace monitor and
  // no checkpoint enforcement.
  const raw = JSON.parse(configText({}));
  delete raw.insecure.allowCountFinalityWithoutGadget;
  assert.throws(() => parseConfig(JSON.stringify(raw), 'x'), /chains\[0\]\.finality\.mode: is "count" on an enabled chain with no finality gadget[\s\S]*chains\.example\.json/);
  // Spelling the mode out is what fixes it.
  const fixed = JSON.parse(configText({ finality: WORK_AND_TIME }));
  delete fixed.insecure.allowCountFinalityWithoutGadget;
  fixed.chains[1].finalityTag = 'finalized';
  assert.equal(parseConfig(JSON.stringify(fixed), 'x').chains[0].finality.mode, 'work-and-time');
  // An explicit "count" is refused the same way as an absent block.
  const explicit = JSON.parse(configText({ finality: { mode: 'count' } }));
  delete explicit.insecure.allowCountFinalityWithoutGadget;
  explicit.chains[1].finalityTag = 'finalized';
  assert.throws(() => parseConfig(JSON.stringify(explicit), 'x'), /no finality gadget/);
  // Count mode stays valid for a chain that HAS a gadget, and for a disabled slot.
  const tagged = JSON.parse(configText({}));
  delete tagged.insecure.allowCountFinalityWithoutGadget;
  tagged.chains[0].finalityTag = 'finalized';
  tagged.chains[1].finalityTag = 'safe';
  assert.equal(parseConfig(JSON.stringify(tagged), 'x').chains[0].finality.mode, 'count');
  const disabled = JSON.parse(configText({}));
  delete disabled.insecure.allowCountFinalityWithoutGadget;
  disabled.chains[0].enabled = false;
  disabled.chains[1].finalityTag = 'finalized';
  assert.doesNotThrow(() => parseConfig(JSON.stringify(disabled), 'x'));
  // The devnet switch needs the acknowledgement sentence like every other one.
  assert.throws(
    () => parseConfig(JSON.stringify({ ...raw, insecure: { allowCountFinalityWithoutGadget: true } }), 'x'),
    /insecure\.allowCountFinalityWithoutGadget.*insecure\.acknowledgement/,
  );
});

test('config: the shipped example keeps the ferminux row in an explicit mode and every gadget-less enabled chain would be refused', () => {
  const path = new URL('../config/chains.example.json', import.meta.url);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const fmx = raw.chains.find((c) => c.chainId === SRC);
  assert.equal(fmx.finalityTag, null);
  // checkpoint since the authority fork: work-and-time can never be met on
  // difficulty-1/2 blocks (see the work-and-time guard test above).
  assert.equal(fmx.finality.mode, 'checkpoint');
  assert.equal(fmx.finality.workThreshold, undefined, 'refused outside work-and-time, so absent');
  for (const c of raw.chains) {
    if (c.chainId !== SRC) assert.notEqual(c.finalityTag, null, `${c.name} has a finality tag, so count mode is legitimate there`);
  }
});

test('config: work-and-time requires an explicit work threshold and a non-zero time floor', () => {
  assert.throws(() => parse({ finality: { mode: 'work-and-time', timeFloorMs: 1000 } }), /workThreshold.*is required/);
  assert.throws(() => parse({ finality: { mode: 'work-and-time', workThreshold: '0', timeFloorMs: 1000 } }), /workThreshold.*must be > 0/);
  assert.throws(() => parse({ finality: { mode: 'work-and-time', workThreshold: '10' } }), /timeFloorMs.*is required/);
  assert.throws(() => parse({ finality: { mode: 'work-and-time', workThreshold: '10', timeFloorMs: 0 } }), /work without a clock/);
  const cfg = parse({ finality: WORK_AND_TIME });
  assert.equal(cfg.chains[0].finality.workThreshold, 10000n);
  assert.equal(cfg.chains[0].finality.pace.window, 8);
  assert.equal(needsFinalityMonitor(cfg.chains[0].finality), true);
});

test('config: work fields are refused outside work-and-time mode', () => {
  assert.throws(() => parse({ finality: { mode: 'count', workThreshold: '10' } }), /only applies in "work-and-time" mode/);
});

test('config: checkpoint mode requires a registry', () => {
  assert.throws(() => parse({ finality: { mode: 'checkpoint' } }), /checkpoint.*is required in "checkpoint" mode/);
});

test('config: the registry must live on a DIFFERENT, enabled chain', () => {
  assert.throws(() => parse({ finality: CHECKPOINT({ registryChainId: SRC }) }), /must be a DIFFERENT chain/);
  assert.throws(() => parse({ finality: CHECKPOINT({ registryChainId: 999 }) }), /not an enabled chain in this config/);
  assert.throws(() => parse({ finality: CHECKPOINT(), regExtra: { enabled: false } }), /not an enabled chain in this config/);
  assert.throws(() => parse({ finality: CHECKPOINT({ registryAddress: ZeroAddress }) }), /registryAddress/);
});

test('config: a checkpoint registry is enforced in count mode too, and pace defaults apply', () => {
  const cfg = parse({ finality: { mode: 'count', checkpoint: { registryAddress: REGISTRY, registryChainId: REG } } });
  assert.equal(cfg.chains[0].finality.checkpoint.maxAgeMs, 21_600_000);
  assert.deepEqual(cfg.chains[0].finality.pace, DEFAULT_PACE);
  assert.equal(needsFinalityMonitor(cfg.chains[0].finality), true);
});

test('config: pace settings in plain count mode are a mistake, and a stall shorter than a slow block is too', () => {
  assert.throws(() => parse({ finality: { mode: 'count', pace: { window: 8 } } }), /has no effect in "count" mode/);
  assert.throws(() => parse({ finality: { ...WORK_AND_TIME, pace: { targetBlockTimeMs: 7000, degradedFactor: 4, stallAfterMs: 10_000 } } }), /stallAfterMs.*at least targetBlockTimeMs \* degradedFactor/);
});

// ----------------------------------------------------------------- fixtures

/**
 * Two endpoints per chain on the given states. Returns a ready monitor plus
 * the pieces a test needs to bend.
 */
async function rig({ finality, srcState, regState = null, now }) {
  const srcA = await fakeRpc(srcState);
  const srcB = await fakeRpc(srcState.alt ?? srcState);
  const regs = regState ? [await fakeRpc(regState), await fakeRpc(regState.alt ?? regState)] : [];
  const cfg = parse({
    finality,
    srcUrls: [srcA.url, srcB.url],
    regUrls: regs.length ? regs.map((r) => r.url) : undefined,
  });
  const { a, fired } = alerter();
  const src = new ChainClient(cfg.chains[0], silentLogger(), a);
  const reg = new ChainClient(cfg.chains[1], silentLogger(), a);
  await src.healthCheck();
  if (regs.length) await reg.healthCheck();
  const clock = { now };
  const monitor = new FinalityMonitor({
    chain: src,
    registryChain: cfg.chains[0].finality.checkpoint ? reg : null,
    cfg: cfg.chains[0].finality,
    log: silentLogger(),
    alerts: a,
    now: () => clock.now,
  });
  const close = async () => {
    for (const e of [...src.endpoints, ...reg.endpoints]) e.provider.destroy();
    await Promise.all([srcA.close(), srcB.close(), ...regs.map((r) => r.close())]);
  };
  return { monitor, cfg, src, reg, clock, fired, close, servers: { srcA, srcB, regs } };
}

const msAfter = (headers, plusSec = 1) => (headers[headers.length - 1].timestamp + plusSec) * 1000;

// ---------------------------------------------------------------------- pace

test('pace: a chain at nominal pace is OK and a deep, old block is final', async () => {
  const chain = buildChain({ length: 60 }); // 7s gaps, difficulty 1000
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    await r.monitor.refresh();
    const pace = r.monitor.paceReport;
    assert.equal(pace.state, 'ok', pace.reason ?? '');
    assert.equal(pace.medianGapMs, 7_000);
    assert.equal(pace.samples, 8);
    assert.equal(pace.headNumber, 59);
    // block 40: 19 blocks above it = 19000 work > 10000, and 19*7s = 133s > 60s
    const v = await r.monitor.assess({ srcBlockNumber: 40, srcBlockHash: chain[40].hash }, 0);
    assert.equal(v.ok, true, v.reason ?? '');
    assert.equal(v.detail.work, '19000');
    assert.equal(v.detail.blocksAbove, 19);
    assert.equal(r.monitor.signingSummary().paused, false);
  } finally {
    await r.close();
  }
});

test('pace: median gap far above target is DEGRADED — refuse, alert, and say so in plain words', async () => {
  // 40 normal blocks, then 12 blocks at 40s each: the window (8) is all slow.
  const gaps = {};
  for (let i = 40; i < 52; i++) gaps[i] = 40;
  const chain = buildChain({ length: 52, gapsSec: gaps });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    await r.monitor.refresh();
    const pace = r.monitor.paceReport;
    assert.equal(pace.state, 'degraded');
    assert.equal(pace.medianGapMs, 40_000);
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'pace_degraded');
    assert.match(v.reason, /producing blocks slowly; transfers are paused until it recovers/);
    assert.match(v.reason, /median block gap 40s/);
    const alert = r.fired.find((a) => a.kind === 'chain_degraded');
    assert.ok(alert, 'operators are paged');
    assert.equal(alert.severity, 'critical');
    const summary = r.monitor.signingSummary();
    assert.equal(summary.paused, true);
    assert.match(summary.reason, /producing blocks slowly/);
    assert.equal(r.monitor.status().pace.medianGapMs, 40_000, '/status carries the measurement');
  } finally {
    await r.close();
  }
});

test('pace: a stalled head (no block for longer than stallAfterMs) is DEGRADED even when past gaps were fine', async () => {
  const chain = buildChain({ length: 60 });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain, 10 * 60) }); // 10 minutes of silence
  try {
    await r.monitor.refresh();
    const pace = r.monitor.paceReport;
    assert.equal(pace.state, 'degraded');
    assert.equal(pace.medianGapMs, 7_000, 'the history looks healthy');
    assert.ok(pace.headAgeMs >= 600_000);
    assert.match(pace.reason, /no block for 600s/);
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'pace_degraded');
  } finally {
    await r.close();
  }
});

test('pace: recovery is noticed and announced', async () => {
  const chain = buildChain({ length: 60 });
  const state = chainState(chain);
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(chain, 10 * 60) });
  try {
    await r.monitor.refresh();
    assert.equal(r.monitor.paceReport.state, 'degraded');
    // The chain resumes: new blocks at nominal pace, starting from the stall point.
    const gaps = { 60: 600 };
    const resumed = buildChain({ length: 75, from: chain, gapsSec: gaps });
    state.load(resumed);
    r.clock.now = msAfter(resumed);
    await r.monitor.refresh();
    assert.equal(r.monitor.paceReport.state, 'ok', r.monitor.paceReport.reason ?? '');
    const recovered = r.fired.find((a) => a.kind === 'chain_degraded' && a.severity === 'info');
    assert.ok(recovered, 'the recovery is announced');
  } finally {
    await r.close();
  }
});

test('pace: when the endpoints cannot serve headers the pace is UNKNOWN and nothing is signed', async () => {
  const chain = buildChain({ length: 60 });
  const state = chainState(chain);
  state.failBlocks = true;
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(chain) });
  try {
    await r.monitor.refresh();
    assert.equal(r.monitor.paceReport.state, 'unknown');
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'pace_unknown');
  } finally {
    await r.close();
  }
});

test('pace: one endpoint alone cannot establish a head — the floor of two applies to headers too', async () => {
  const chain = buildChain({ length: 60 });
  const state = chainState(chain);
  const other = chainState(chain);
  other.failBlocks = true;
  state.alt = other;
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(chain) });
  try {
    await r.monitor.refresh();
    assert.equal(r.monitor.paceReport.state, 'unknown');
    assert.match(r.monitor.paceReport.reason, /only 1 endpoint\(s\) reported a head, 2 required/);
  } finally {
    await r.close();
  }
});

// ------------------------------------------------------------- work and time

test('work: not enough accumulated difficulty above the block is not_final, with the shortfall spelled out', async () => {
  const chain = buildChain({ length: 60 });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    // block 54: 5 blocks above = 5000 < 10000
    const v = await r.monitor.assess({ srcBlockNumber: 54, srcBlockHash: chain[54].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'not_final');
    assert.match(v.reason, /accumulated work 5000 of 10000/);
    assert.match(v.reason, /~5 more at current difficulty/);
  } finally {
    await r.close();
  }
});

test('work: on authority-signed blocks (difficulty <= 2) work-and-time says it can never finalise, and pauses', async () => {
  // Ferminux after block 160,000 under the live 2026-09-24 config: difficulty
  // 1-2 per block, workThreshold 7.8e10. It used to answer "not_final" with a
  // shortfall of ~39 billion blocks, and /status said "not paused".
  const chain = buildChain({ length: 60, difficulty: 2n });
  const fired = [];
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  const real = r.monitor.alerts.fire.bind(r.monitor.alerts);
  r.monitor.alerts.fire = (a) => (fired.push(a), real(a));
  try {
    await r.monitor.refresh();
    const summary = r.monitor.signingSummary();
    assert.equal(summary.paused, true);
    assert.match(summary.reason, /can(not|never) be met.*"checkpoint"/s);
    const v = await r.monitor.assess({ srcBlockNumber: 20, srcBlockHash: chain[20].hash }, 0);
    assert.equal(v.ok, false);
    assert.match(v.reason, /authority-signed/);
    assert.equal(fired.filter((a) => a.key?.startsWith('work-mode-impossible')).length, 1, 'one critical alert, not one per refresh');
    await r.monitor.refresh();
    assert.equal(fired.filter((a) => a.key?.startsWith('work-mode-impossible')).length, 1);
  } finally {
    await r.close();
  }
});

test('work: meeting the threshold with a burst of difficulty does not skip the time floor', async () => {
  // Huge difficulty: one block above the source already carries 10x the threshold.
  const chain = buildChain({ length: 60, difficulty: 100_000n });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    // block 57: 2 blocks above, 14s + 1s elapsed < 60s floor
    const v = await r.monitor.assess({ srcBlockNumber: 57, srcBlockHash: chain[57].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'not_final');
    assert.match(v.reason, /work threshold met but only 15s of the 60s time floor/);
    // block 50: 9 blocks above, 64s elapsed >= 60s floor
    const ok = await r.monitor.assess({ srcBlockNumber: 50, srcBlockHash: chain[50].hash }, 0);
    assert.equal(ok.ok, true, ok.reason ?? '');
  } finally {
    await r.close();
  }
});

test('work: the head must be above the source block', async () => {
  const chain = buildChain({ length: 60 });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 59, srcBlockHash: chain[59].hash }, 0);
    assert.equal(v.code, 'not_final');
  } finally {
    await r.close();
  }
});

test('reorg: a source block whose canonical hash has changed is refused and paged', async () => {
  const chain = buildChain({ length: 60 });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 40, srcBlockHash: `0x${'ee'.repeat(32)}` }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'src_block_reorged');
    assert.ok(r.fired.some((a) => a.kind === 'reorg' && a.severity === 'critical'));
  } finally {
    await r.close();
  }
});

test('reorg: a head that does not DESCEND from the source block is refused even when the by-number lookup still agrees', async () => {
  // Canonical chain C to block 40; fork F shares C[0..39], has its own 40, and
  // extends to 59. The endpoints serve C[40] by number (what the log re-read
  // saw) but F's head — a split view, exactly what an eclipse arranges.
  const c = buildChain({ length: 41 });
  const f = buildChain({ length: 60, from: c.slice(0, 40), tag: 'fork' });
  const state = chainState(c);
  state.load(f.slice(41));
  for (const h of f) state.byHash.set(h.hash, h);
  state.head = 59;
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(f) });
  try {
    await r.monitor.refresh();
    const v = await r.monitor.assess({ srcBlockNumber: 40, srcBlockHash: c[40].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'src_block_reorged');
    assert.match(v.reason, /has parent/);
    assert.ok(r.fired.some((a) => a.kind === 'reorg'));
  } finally {
    await r.close();
  }
});

test('work: a walk that cannot reach the source block is unverifiable, not approved', async () => {
  const chain = buildChain({ length: 60 });
  const state = chainState(chain);
  // Remove the by-hash record for block 45 so the walk breaks between 46 and 45.
  state.byHash.delete(chain[45].hash);
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(chain) });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 30, srcBlockHash: chain[30].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'finality_unverifiable');
    assert.match(v.reason, /cannot walk from head 59 to block 30/);
  } finally {
    await r.close();
  }
});

test('work: endpoints disagreeing about the CONTENTS of one hash is a lying node, and the walk refuses', async () => {
  const chain = buildChain({ length: 60 });
  const state = chainState(chain);
  const liar = chainState(chain);
  const forged = { ...chain[50], difficulty: 10n ** 9n }; // same hash, inflated work
  liar.byHash.set(forged.hash, forged);
  state.alt = liar;
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(chain) });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 40, srcBlockHash: chain[40].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'finality_unverifiable');
    assert.ok(r.fired.some((a) => a.kind === 'rpc_divergence'), 'a lying header body is a divergence alert');
  } finally {
    await r.close();
  }
});

// --------------------------------------------------------------- checkpoint

function registryOn(state, { number, hash, attestedAtMs }) {
  state.registry = { number, hash, attestedAt: Math.floor(attestedAtMs / 1000) };
}

test('checkpoint: a verified, fresh checkpoint admits blocks at or below it and /status shows the lag', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n }); // Clique-like: work means nothing
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 60_000 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    await r.monitor.refresh();
    const ck = r.monitor.checkpointReport;
    assert.equal(ck.state, 'ok', ck.reason ?? '');
    assert.equal(ck.number, 50);
    assert.equal(ck.hashVerified, true);
    assert.equal(ck.lagBlocks, 9);
    assert.equal(ck.ageMs, 60_000);
    const below = await r.monitor.assess({ srcBlockNumber: 50, srcBlockHash: chain[50].hash }, 0);
    assert.equal(below.ok, true, below.reason ?? '');
    assert.equal(below.detail.checkpoint, 50);
    const status = r.monitor.status();
    assert.equal(status.mode, 'checkpoint');
    assert.equal(status.checkpoint.lagBlocks, 9);
    assert.equal(status.signing.paused, false);
  } finally {
    await r.close();
  }
});

test('checkpoint: a source block ABOVE the latest checkpoint waits for the next one', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 60_000 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 51, srcBlockHash: chain[51].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'checkpoint_behind');
    assert.equal(v.detail.blocksAboveCheckpoint, 1);
  } finally {
    await r.close();
  }
});

test('checkpoint: an empty registry is a refusal, not a pass', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 0, hash: `0x${'00'.repeat(32)}`, attestedAtMs: 0 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_missing');
    assert.equal(r.monitor.checkpointReport.state, 'missing');
    assert.ok(r.fired.some((a) => a.kind === 'checkpoint'));
  } finally {
    await r.close();
  }
});

test('checkpoint: older than maxAgeMs is stale — the registry being unfed stops the bridge', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 2 * 3_600_000 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_stale');
    assert.match(v.reason, /attested 120 min ago; max age is 60 min/);
    assert.equal(r.monitor.checkpointReport.hashVerified, true, 'stale but honest');
    assert.equal(r.monitor.signingSummary().paused, true);
  } finally {
    await r.close();
  }
});

test('checkpoint: a hash that differs from what this node sees is a DETECTED REORG — critical, refused', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: `0x${'ee'.repeat(32)}`, attestedAtMs: now - 60_000 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'checkpoint_mismatch');
    assert.match(v.reason, /rewritten across the checkpoint/);
    const alert = r.fired.find((a) => a.kind === 'checkpoint' && a.severity === 'critical');
    assert.ok(alert);
    assert.match(alert.message, /REORG DETECTED/);
  } finally {
    await r.close();
  }
});

test('checkpoint: a mismatch outranks staleness (the louder fact wins)', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: `0x${'ee'.repeat(32)}`, attestedAtMs: now - 9 * 3_600_000 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_mismatch');
  } finally {
    await r.close();
  }
});

test('checkpoint: registry endpoints that disagree are not a quorum', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 60_000 });
  const lagging = chainState([], REG);
  lagging.head = 1;
  registryOn(lagging, { number: 40, hash: chain[40].hash, attestedAtMs: now - 600_000 });
  reg.alt = lagging;
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_unavailable');
    assert.match(v.reason, /registry endpoints disagree/);
  } finally {
    await r.close();
  }
});

test('checkpoint: an unreadable registry (no code, or dead endpoints) is a refusal', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const noCode = chainState([], REG);
  noCode.head = 1; // registry left null -> eth_call returns 0x
  const r1 = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: noCode, now });
  try {
    const v = await r1.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_unavailable');
    assert.match(v.reason, /no CheckpointRegistry at/);
  } finally {
    await r1.close();
  }
  const dead = chainState([], REG);
  dead.head = 1;
  dead.failCalls = true;
  registryOn(dead, { number: 50, hash: chain[50].hash, attestedAtMs: now });
  const r2 = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: dead, now });
  try {
    const v = await r2.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_unavailable');
  } finally {
    await r2.close();
  }
});

test('checkpoint: the source chain must be able to show the checkpointed block, or nothing is verified', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 70, hash: `0x${'aa'.repeat(32)}`, attestedAtMs: now - 60_000 }); // above our head
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'checkpoint_unavailable');
    assert.match(v.reason, /cannot read block 70/);
  } finally {
    await r.close();
  }
});

test('checkpoint: pace still gates checkpoint mode — a stalled authority chain is not signed against', async () => {
  const chain = buildChain({ length: 60, difficulty: 1n });
  const now = msAfter(chain, 3_600);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 60_000 });
  const r = await rig({ finality: CHECKPOINT(), srcState: chainState(chain), regState: reg, now });
  try {
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.code, 'pace_degraded');
  } finally {
    await r.close();
  }
});

test('checkpoint: work-and-time mode ALSO honours a configured registry', async () => {
  const chain = buildChain({ length: 60 });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 30, hash: chain[30].hash, attestedAtMs: now - 60_000 });
  const finality = { ...WORK_AND_TIME, checkpoint: { registryAddress: REGISTRY, registryChainId: REG, maxAgeMs: 3_600_000 } };
  const r = await rig({ finality, srcState: chainState(chain), regState: reg, now });
  try {
    const above = await r.monitor.assess({ srcBlockNumber: 40, srcBlockHash: chain[40].hash }, 0);
    assert.equal(above.code, 'checkpoint_behind', 'plenty of work, but above the checkpoint');
    const below = await r.monitor.assess({ srcBlockNumber: 20, srcBlockHash: chain[20].hash }, 0);
    assert.equal(below.ok, true, below.reason ?? '');
  } finally {
    await r.close();
  }
});

test('checkpoint: a monitor cannot be built without the registry chain', () => {
  const cfg = parse({ finality: CHECKPOINT() });
  const { a } = alerter();
  const src = new ChainClient(cfg.chains[0], silentLogger(), a);
  assert.throws(() => new FinalityMonitor({ chain: src, registryChain: null, cfg: cfg.chains[0].finality, log: silentLogger(), alerts: a }), /registry chain 56 is not available/);
  for (const e of src.endpoints) e.provider.destroy();
});

// ------------------------------------------------------- verify integration

function verifyFixture(cfg, finality) {
  const transfer = {
    srcChainId: SRC,
    dstChainId: REG,
    nonce: 1,
    srcToken: ZeroAddress,
    dstToken: getAddress(`0x${'22'.repeat(20)}`),
    sender: getAddress(`0x${'33'.repeat(20)}`),
    recipient: getAddress(`0x${'44'.repeat(20)}`),
    amount: 10n ** 18n,
  };
  const dstCfg = cfg.chains[1];
  const chains = new Map([
    [SRC, { config: cfg.chains[0], name: 'src', chainId: SRC }],
    [
      REG,
      {
        config: dstCfg,
        verifyDomainSeparator: async () => ({ ok: true, onChain: null, reason: null }),
        readTokenConfig: async () => ({ kind: 2n, paused: false, remoteChainId: BigInt(SRC), remoteToken: transfer.srcToken, maxPerTransfer: 10n ** 21n, dailyCap: 10n ** 22n }),
        bridge: () => ({ processed: async () => false, paused: async () => false, hashTransfer: async () => digestFor(transfer, dstCfg.bridgeAddress) }),
      },
    ],
  ]);
  const windows = new Map();
  const limiter = new VolumeLimiter({ getWindow: (k) => windows.get(k) ?? null, putWindow: (w) => windows.set(w.key, { ...w }) });
  const stored = (srcBlockNumber, srcBlockHash) => ({
    transferId: transferIdOf(transfer),
    transfer,
    fee: 0n,
    srcBlockNumber,
    srcBlockHash,
    srcTxHash: `0x${'cd'.repeat(32)}`,
    srcLogIndex: 0,
    status: 'confirmed',
    reason: null,
    firstSeenAt: Date.now(),
    confirmedAt: Date.now(),
    executedAt: null,
    executedTxHash: null,
    updatedAt: Date.now(),
  });
  const { a } = alerter();
  const ctx = { cfg, chains, limiter, alerts: a, log: silentLogger(), ...(finality ? { finality } : {}) };
  return { ctx, stored };
}

test('verify: a chain that requires finality but has no monitor is refused — absence of the check is not a pass', async () => {
  const cfg = parse({ finality: WORK_AND_TIME });
  const { ctx, stored } = verifyFixture(cfg, null);
  const result = await verifyForSigning(ctx, stored(10, `0x${'ab'.repeat(32)}`));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'finality_unverifiable');
  assert.match(result.reason, /no finality monitor/);
});

test('verify: the monitor verdict gates the signature, before any destination read and before capacity is spent', async () => {
  const chain = buildChain({ length: 60 });
  const r = await rig({ finality: WORK_AND_TIME, srcState: chainState(chain), now: msAfter(chain) });
  try {
    const finality = new Map([[SRC, r.monitor]]);
    const { ctx, stored } = verifyFixture(r.cfg, finality);
    const shallow = await verifyForSigning(ctx, stored(56, chain[56].hash));
    assert.equal(shallow.ok, false);
    assert.equal(shallow.code, 'not_final');
    assert.equal(shallow.consumed, null, 'no capacity spent on a refusal');
    const deep = await verifyForSigning(ctx, stored(30, chain[30].hash));
    assert.equal(deep.ok, true, deep.reason ?? '');
    assert.ok(deep.consumed);
  } finally {
    await r.close();
  }
});

test('verify: count-mode chains are untouched by the monitor', async () => {
  const cfg = parse({});
  const { ctx, stored } = verifyFixture(cfg, null);
  const result = await verifyForSigning(ctx, stored(10, `0x${'ab'.repeat(32)}`));
  assert.equal(result.ok, true, result.reason ?? '');
});

test('validator: every finality refusal is retryable — the transfer waits, it is not discarded', () => {
  for (const code of ['not_final', 'pace_degraded', 'pace_unknown', 'checkpoint_unavailable', 'checkpoint_missing', 'checkpoint_stale', 'checkpoint_behind', 'checkpoint_mismatch', 'src_block_reorged', 'finality_unverifiable']) {
    assert.ok(FINALITY_CODES.includes(code), code);
  }
});

// ------------------------------------------------------------ pace: partial walk

test('pace: a walk that stops short of the window is UNKNOWN, not a median of whatever was gathered', async () => {
  // Two fast blocks at the tip, then the third parent lookup fails quorum: the
  // second endpoint has never seen block 56 by hash. The old code averaged the
  // two gaps it had and called the chain healthy.
  const chain = buildChain({ length: 60, gapsSec: { 58: 2, 59: 2 } });
  const state = chainState(chain);
  state.alt = chainState(chain);
  state.alt.byHash.delete(chain[56].hash);
  const r = await rig({ finality: WORK_AND_TIME, srcState: state, now: msAfter(chain) });
  try {
    await r.monitor.refresh();
    const pace = r.monitor.paceReport;
    assert.equal(pace.state, 'unknown');
    assert.match(pace.reason, /cannot measure pace/);
    assert.match(pace.reason, /parent of block 57/);
    assert.equal(pace.medianGapMs, null, 'no partial median is published');
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 0);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'pace_unknown');
  } finally {
    await r.close();
  }
});

// ------------------------------------------------------- refresh that throws

test('refresh: an exception mid-refresh resets the reports to refusing states instead of leaving the old ok standing', async () => {
  const chain = buildChain({ length: 60 });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 60_000 });
  const r = await rig({ finality: { ...WORK_AND_TIME, checkpoint: { registryAddress: REGISTRY, registryChainId: REG, maxAgeMs: 3_600_000 } }, srcState: chainState(chain), regState: reg, now });
  try {
    await r.monitor.refresh();
    assert.equal(r.monitor.paceReport.state, 'ok');
    assert.equal(r.monitor.checkpointReport.state, 'ok');

    // Make the next measurement blow up past the monitor's own error handling.
    const realFire = r.monitor.alerts.fire;
    r.monitor.alerts.fire = () => {
      throw new Error('webhook exploded');
    };
    // Force a state change so transition() fires: stall the chain.
    r.clock.now = now + 10 * 60_000;
    await assert.rejects(r.monitor.refresh(), /webhook exploded/);
    assert.equal(r.monitor.paceReport.state, 'unknown');
    assert.match(r.monitor.paceReport.reason, /refresh threw: .*webhook exploded/);
    assert.equal(r.monitor.checkpointReport.state, 'unreadable');
    assert.equal(r.monitor.checkpointReport.hashVerified, false);
    const v = await r.monitor.assess({ srcBlockNumber: 10, srcBlockHash: chain[10].hash }, 60_000);
    assert.equal(v.ok, false, 'the stale ok is not used for signing');
    assert.equal(v.code, 'pace_unknown');
    assert.equal(r.monitor.status().signing.paused, true);

    // Recovery is just a refresh that completes.
    r.monitor.alerts.fire = realFire;
    r.clock.now = now;
    await r.monitor.refresh();
    assert.equal(r.monitor.paceReport.state, 'ok');
    assert.equal(r.monitor.checkpointReport.state, 'ok');
  } finally {
    await r.close();
  }
});

// --------------------------------------------------------- /status contract

/** Every key path in an object, recursively, as "a.b.c" — the SHAPE without the values. */
function keyPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  const out = [];
  for (const k of Object.keys(value).sort()) out.push(...keyPaths(value[k], prefix ? `${prefix}.${k}` : k));
  return out;
}

const UI_FIXTURE = new URL('../../ui/tests/fixtures/relayer-status.json', import.meta.url);

test('status: the UI fixture is a faithful capture — same key paths as FinalityMonitor.status() in every state', async () => {
  const fixture = JSON.parse(readFileSync(UI_FIXTURE, 'utf8'));
  assert.equal(typeof fixture.generatedAt, 'number', 'the document is stamped');
  const fmx = fixture.chains.find((c) => c.chainId === SRC);
  const bsc = fixture.chains.find((c) => c.chainId === REG);
  for (const key of ['name', 'chainId', 'confirmations', 'finality']) assert.ok(key in fmx, `chains[].${key}`);

  const chain = buildChain({ length: 60 });
  const now = msAfter(chain);
  const reg = chainState([], REG);
  reg.head = 1;
  registryOn(reg, { number: 50, hash: chain[50].hash, attestedAtMs: now - 60_000 });
  const r = await rig({ finality: { ...WORK_AND_TIME, checkpoint: { registryAddress: REGISTRY, registryChainId: REG, maxAgeMs: 3_600_000 } }, srcState: chainState(chain), regState: reg, now });
  try {
    await r.monitor.refresh();
    const live = r.monitor.status();
    assert.equal(live.mode, 'work-and-time');
    assert.deepEqual(keyPaths(fmx.finality), keyPaths(live), 'ferminux row: work-and-time + registry, healthy');
    // The fields the UI's liveness.ts reads, by name, so a rename on either side fails here.
    for (const k of ['state', 'targetBlockTimeMs', 'medianGapMs', 'headAgeMs', 'samples', 'headNumber', 'reason']) assert.ok(k in live.pace, `pace.${k}`);
    for (const k of ['state', 'number', 'hash', 'attestedAt', 'ageMs', 'maxAgeMs', 'lagBlocks', 'hashVerified', 'reason']) assert.ok(k in live.checkpoint, `checkpoint.${k}`);
    assert.deepEqual(Object.keys(live.signing).sort(), ['paused', 'reason']);

    // Degraded + mismatch keeps the same shape (null-able values, never absent keys).
    r.servers.regs.forEach(() => {});
    registryOn(reg, { number: 50, hash: chain[20].hash, attestedAtMs: now - 60_000 });
    r.clock.now = now + 10 * 60_000;
    await r.monitor.refresh();
    const bad = r.monitor.status();
    assert.equal(bad.pace.state, 'degraded');
    assert.equal(bad.checkpoint.state, 'mismatch');
    assert.equal(bad.signing.paused, true);
    assert.deepEqual(keyPaths(bad), keyPaths(live));
  } finally {
    await r.close();
  }

  // A count chain with a real finality tag has no monitor; its block is the same shape with nulls.
  const plain = unmonitoredFinalityStatus({ mode: 'count', workThreshold: 0n, timeFloorMs: 0, maxWalkBlocks: 4096, pace: null, checkpoint: null }, 20);
  assert.deepEqual(keyPaths(bsc.finality), keyPaths(plain), 'bsc row: count, unmonitored');
});

test('status: RelayerService.status() stamps generatedAt and nests the finality block under chains[]', async () => {
  const cfg = parse({
    finality: { ...WORK_AND_TIME, checkpoint: { registryAddress: REGISTRY, registryChainId: REG, maxAgeMs: 3_600_000 } },
    srcExtra: { finalityTag: null },
    regExtra: { finalityTag: 'finalized' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'fmx-finality-status-'));
  const store = await openStore(join(dir, 'relayer.db'), 'journal');
  const { a } = alerter();
  const service = new RelayerService({
    cfg,
    role: 'validator',
    log: silentLogger(),
    alerts: a,
    store,
    metrics: new Metrics(),
    hooks: { onConfirmed: async () => {} },
    tickIntervalMs: 1_000,
  });
  try {
    const before = Date.now();
    const status = service.status();
    assert.ok(typeof status.generatedAt === 'number' && status.generatedAt >= before && status.generatedAt <= Date.now(), 'generatedAt is unix ms, now');
    const fixture = JSON.parse(readFileSync(UI_FIXTURE, 'utf8'));
    const src = status.chains.find((c) => c.chainId === SRC);
    const reg = status.chains.find((c) => c.chainId === REG);
    assert.equal(src.finality.mode, 'work-and-time');
    assert.deepEqual(keyPaths(src.finality), keyPaths(fixture.chains.find((c) => c.chainId === SRC).finality), 'monitored chain, before its first refresh');
    assert.deepEqual(keyPaths(reg.finality), keyPaths(fixture.chains.find((c) => c.chainId === REG).finality), 'unmonitored chain');
    assert.equal(src.finality.signing.paused, true, 'before the first measurement the verdict is paused, not ok');
    for (const key of ['name', 'chainId', 'confirmations']) assert.ok(key in src, `chains[].${key}`);
  } finally {
    await service.stop();
    store.close();
    for (const c of service.chains.values()) for (const e of c.endpoints) e.provider.destroy();
  }
});
