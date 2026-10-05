// Regression tests for the 2026-09-24 bridge audit, relayer half.
//
//   log capability split   an endpoint that refuses eth_getLogs must leave the
//                          LOG set only. Before, one flag carried both, so the
//                          BSC dataseed / publicnode refusals demoted every BSC
//                          endpoint and the checkpoint-registry eth_call read
//                          "0 healthy endpoints" for ten days.
//   range refusals         archive / span refusals skip the endpoint for that
//                          chunk; they are not evidence it is broken.
//   incremental cursor     a catch-up that fails part-way keeps what it read.
//   scan health            a frozen scanner pauses the published verdict.
//   work-and-time guard    authority-signed blocks can never meet a work
//                          threshold; the monitor must say so, not wait forever.
//   whole-number config    a fractional priorityFeeGwei fails at startup.
//   alert log throttle     the same alert every poll is one line a window.
//
// Every fake node binds an ephemeral port on 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, ZeroAddress, getAddress } from 'ethers';

import { Alerter } from '../src/alerts.ts';
import { BRIDGE_ABI } from '../src/abi.ts';
import { ChainClient, LOGS_RETRY_MS, isRangeRefusal } from '../src/chain.ts';
import { INSECURE_ACKNOWLEDGEMENT, parseConfig } from '../src/config.ts';
import { openStore } from '../src/db.ts';
import { createLogger } from '../src/logger.ts';
import { RelayerService, serialQueue, withScanVerdict } from '../src/service.ts';
import { Metrics } from '../src/metrics.ts';
import { transferIdOf } from '../src/transfer.ts';
import { Watcher, scanHealth } from '../src/watcher.ts';

const BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHAIN_A = 3961;
const CHAIN_B = 56;
const iface = new Interface(BRIDGE_ABI);

function capturingLogger(level = 'debug') {
  const lines = [];
  const logger = createLogger(level, 'json', {}, (line) => lines.push(line));
  return { logger, lines };
}
const silent = () => capturingLogger('error').logger;

function alerter(throttleMs = 0, logger = silent()) {
  return new Alerter({ alerts: { webhookUrl: null, minSeverity: 'critical', throttleMs }, network: 'test' }, 'test', logger);
}

/**
 * A JSON-RPC node whose eth_getLogs answer is decided per request by `logs`,
 * which gets (fromBlock, toBlock) and returns a result array, or
 * { error: {code, message} }, or { http: status, body }.
 */
async function fakeNode({ head = 200, logs = () => [] } = {}) {
  const state = { head, logs, calls: { eth_getLogs: 0, eth_call: 0 } };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = JSON.parse(raw);
      state.calls[p.method] = (state.calls[p.method] ?? 0) + 1;
      const reply = (body, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      switch (p.method) {
        case 'eth_chainId':
          return reply({ jsonrpc: '2.0', id: p.id, result: `0x${CHAIN_A.toString(16)}` });
        case 'eth_blockNumber':
          return reply({ jsonrpc: '2.0', id: p.id, result: `0x${state.head.toString(16)}` });
        case 'eth_call':
          return reply({ jsonrpc: '2.0', id: p.id, result: `0x${'00'.repeat(31)}01` });
        case 'eth_getLogs': {
          const f = p.params[0];
          const out = state.logs(Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock)));
          if (Array.isArray(out)) return reply({ jsonrpc: '2.0', id: p.id, result: out });
          if (out.http) return reply(out.body, out.http);
          return reply({ jsonrpc: '2.0', id: p.id, error: out.error });
        }
        default:
          return reply({ jsonrpc: '2.0', id: p.id, error: { code: -32601, message: `unsupported ${p.method}` } });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () =>
      new Promise((r) => {
        server.closeIdleConnections?.();
        server.close(r);
        server.closeAllConnections?.();
      }),
  };
}

function chainFor(urls, { maxBlockRange = 50, confirmations = 3, alerts = alerter() } = {}) {
  const cfg = parseConfig(
    JSON.stringify({
      network: 'test',
      chains: [
        {
          name: 'a',
          chainId: CHAIN_A,
          rpcUrls: urls,
          minAgreeingEndpoints: 2,
          bridgeAddress: BRIDGE,
          confirmations,
          maxBlockRange,
          pollIntervalMs: 500,
          limits: { default: { maxPerTransfer: '10000000000000000000', dailyCap: '100000000000000000000' }, tokens: {} },
        },
        {
          name: 'b',
          chainId: CHAIN_B,
          rpcUrls: ['http://node-b1.example:8545', 'http://node-b2.example:8545', 'http://node-b3.example:8545'],
          bridgeAddress: BRIDGE,
          confirmations: 3,
          limits: { default: { maxPerTransfer: '10000000000000000000', dailyCap: '100000000000000000000' }, tokens: {} },
        },
      ],
      insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
    }),
    'x',
  );
  return new ChainClient(cfg.chains.find((c) => c.chainId === CHAIN_A), silent(), alerts);
}

const dispose = (chain) => chain.endpoints.forEach((e) => e.provider.destroy());

function sentLog(blockNumber, nonce = 1) {
  const transfer = {
    srcChainId: CHAIN_A,
    dstChainId: CHAIN_B,
    nonce,
    srcToken: ZeroAddress,
    dstToken: getAddress(`0x${'22'.repeat(20)}`),
    sender: getAddress(`0x${'33'.repeat(20)}`),
    recipient: getAddress(`0x${'44'.repeat(20)}`),
    amount: 10n ** 18n,
  };
  const transferId = transferIdOf(transfer);
  const { data, topics } = iface.encodeEventLog('Sent', [
    transferId, transfer.dstChainId, transfer.srcToken, transfer.srcChainId, transfer.nonce,
    transfer.dstToken, transfer.sender, transfer.recipient, transfer.amount, 0n,
  ]);
  const blockHash = `0x${blockNumber.toString(16).padStart(64, '0')}`;
  return {
    transferId,
    blockNumber,
    blockHash,
    log: {
      address: BRIDGE, topics, data,
      blockNumber: `0x${blockNumber.toString(16)}`, blockHash,
      transactionHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    },
  };
}

const LIMIT = { error: { code: -32005, message: 'limit exceeded' } };
const ARCHIVE_403 = { http: 403, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Archive requests require a personal token.' } } };

// ------------------------------------------------------------------ classification

test('range refusal: span and archive refusals are recognised, a bare "limit exceeded" is not', () => {
  assert.equal(isRangeRefusal(new Error('ranges over 10000 blocks are not supported on free plan')), true);
  assert.equal(isRangeRefusal(new Error('eth_getLogs is limited to 0 - 50 blocks range')), true);
  assert.equal(isRangeRefusal(new Error('query returned more than 10000 results')), true);
  assert.equal(isRangeRefusal({ shortMessage: 'server response 403 Forbidden', info: { responseBody: '{"error":{"message":"Archive requests require a personal token"}}' } }), true);
  assert.equal(isRangeRefusal({ shortMessage: 'could not coalesce error', error: { code: -32005, message: 'limit exceeded' } }), false);
  assert.equal(isRangeRefusal(new Error('connect ECONNREFUSED 127.0.0.1:8545')), false);
});

// ------------------------------------------------------------------ capability split

test('logs: an endpoint that refuses eth_getLogs leaves the LOG set only — calls and the quorum floor keep it', async () => {
  const ev = sentLog(150);
  const refuses = await fakeNode({ logs: () => LIMIT });
  const b = await fakeNode({ logs: (from, to) => (from <= 150 && to >= 150 ? [ev.log] : []) });
  const c = await fakeNode({ logs: (from, to) => (from <= 150 && to >= 150 ? [ev.log] : []) });
  const chain = chainFor([refuses.url, b.url, c.url]);
  try {
    await chain.healthCheck();
    const found = await chain.scanSent(100, 180);
    assert.equal(found.length, 1, 'the scan failed over past the refusing endpoint');
    assert.equal(chain.endpoints[0].healthy, true, 'still healthy: it answers eth_chainId and eth_call');
    assert.equal(chain.endpoints[0].logsOk, false, 'but out of log reads');
    assert.equal(chain.healthyEndpoints.length, 3, 'every endpoint still counts for headers and the checkpoint registry');
    assert.equal(chain.logEndpoints.length, 2);

    const check = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, true);
    assert.equal(check.status, 'ok', `requireRpcQuorum no longer waits on a node that serves no logs: ${check.reason}`);
    assert.equal(check.agreed, 2);

    // ...and it is retried after the window, not written off forever.
    chain.endpoints[0].logsFailedAt -= LOGS_RETRY_MS + 1;
    assert.equal(chain.logEndpoints.length, 3, 'due a retry');
  } finally {
    dispose(chain);
    await Promise.all([refuses.close(), b.close(), c.close()]);
  }
});

test('logs: a failing single-block re-read takes the endpoint out of the log set for the next round', async () => {
  const ev = sentLog(150);
  const flaky = await fakeNode({ logs: () => LIMIT });
  const b = await fakeNode({ logs: () => [ev.log] });
  const c = await fakeNode({ logs: () => [ev.log] });
  const chain = chainFor([flaky.url, b.url, c.url]);
  try {
    await chain.healthCheck();
    const first = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, true);
    assert.equal(first.status, 'unavailable', 'strict mode still refuses the round in which a witness errored');
    assert.equal(chain.endpoints[0].logsOk, false);
    const second = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, true);
    assert.equal(second.status, 'ok', 'next round it is not asked, and the two that serve logs decide');
  } finally {
    dispose(chain);
    await Promise.all([flaky.close(), b.close(), c.close()]);
  }
});

test('logs: an archive refusal (HTTP 403 + body) skips that chunk only; the endpoint keeps serving logs', async () => {
  // Recent blocks fine, deep ones refused — publicnode without a token.
  const shallow = await fakeNode({ logs: (from) => (from < 150 ? ARCHIVE_403 : []) });
  const deep = await fakeNode({ logs: () => [] });
  const chain = chainFor([shallow.url, deep.url]);
  try {
    await chain.healthCheck();
    await chain.scanSent(100, 199);
    assert.equal(chain.endpoints[0].logsOk, true, 'a range refusal is not a broken endpoint');
    assert.equal(chain.endpoints[0].healthy, true);
    assert.ok(deep.state.calls.eth_getLogs >= 1, 'the refused chunk went to the next endpoint');
  } finally {
    dispose(chain);
    await Promise.all([shallow.close(), deep.close()]);
  }
});

// ------------------------------------------------------------------ incremental cursor

test('watcher: a catch-up that fails part-way keeps the chunks it already read', async () => {
  const ev = sentLog(120);
  const serve = (from, to) => (from >= 160 ? LIMIT : from <= 120 && to >= 120 ? [ev.log] : []);
  const a = await fakeNode({ head: 300, logs: serve });
  const b = await fakeNode({ head: 300, logs: serve });
  const dir = mkdtempSync(join(tmpdir(), 'fmx-scan-'));
  const chain = chainFor([a.url, b.url], { maxBlockRange: 20, confirmations: 3 });
  const store = await openStore(join(dir, 'r.db'), 'journal');
  try {
    store.setCursor(CHAIN_A, 99);
    const w = new Watcher({ chain, store, log: silent(), alerts: alerter(), requireRpcQuorum: false, onConfirmed: () => {} });
    await w.pollOnce();
    assert.match(w.stats.lastError ?? '', /getLogs\(160\.\.179\)/, 'the scan failed at the chunk the nodes refuse');
    assert.equal(store.getCursor(CHAIN_A), 159, 'progress up to the last good chunk was persisted, not thrown away');
    assert.equal(store.getTransfer(ev.transferId)?.status, 'seen', 'the event found on the way is stored');
    assert.equal(w.stats.lastSuccessAt, 0, 'a failed poll is not a success');
  } finally {
    dispose(chain);
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
    await Promise.all([a.close(), b.close()]);
  }
});

test('watcher: the cursor never moves past the settled height, even when the scan reaches the head', async () => {
  const a = await fakeNode({ head: 130, logs: () => [] });
  const b = await fakeNode({ head: 130, logs: () => [] });
  const dir = mkdtempSync(join(tmpdir(), 'fmx-scan-'));
  const chain = chainFor([a.url, b.url], { maxBlockRange: 20, confirmations: 5 });
  const store = await openStore(join(dir, 'r.db'), 'journal');
  try {
    store.setCursor(CHAIN_A, 99);
    const w = new Watcher({ chain, store, log: silent(), alerts: alerter(), requireRpcQuorum: false, onConfirmed: () => {} });
    await w.pollOnce();
    assert.equal(w.stats.lastError, null);
    assert.equal(store.getCursor(CHAIN_A), 125, 'head 130 minus 5 confirmations: the unsettled tail is re-read next poll');
    assert.ok(w.stats.lastSuccessAt > 0);
  } finally {
    dispose(chain);
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
    await Promise.all([a.close(), b.close()]);
  }
});

// ------------------------------------------------------------------ per-chain confirmation pass

test("watcher: another chain's backlog of seen transfers cannot starve this chain's confirmations", async () => {
  // Before: the pass fetched the 1000 oldest `seen` rows of ANY chain and then
  // kept this chain's. 1000 older rows from chain B left chain A with nothing.
  const dir = mkdtempSync(join(tmpdir(), 'fmx-scan-'));
  const store = await openStore(join(dir, 'r.db'), 'sqlite');
  const checked = [];
  const confirmed = [];
  const chain = {
    name: 'a',
    chainId: CHAIN_A,
    config: { confirmations: 3, startBlock: 0, pollIntervalMs: 500 },
    healthyEndpoints: [{}],
    healthCheck: async () => {},
    getBlockNumber: async () => 200,
    settledHeight: async () => 197,
    scanSent: async () => [],
    confirmSentAcrossEndpoints: async (id) => {
      checked.push(id);
      return { status: 'ok', agreed: 1, checked: 1, reason: null };
    },
  };
  const row = (transferId, srcChainId, firstSeenAt) => ({
    transferId,
    transfer: {
      srcChainId,
      dstChainId: srcChainId === CHAIN_A ? CHAIN_B : CHAIN_A,
      nonce: 1,
      srcToken: ZeroAddress,
      dstToken: getAddress(`0x${'22'.repeat(20)}`),
      sender: getAddress(`0x${'33'.repeat(20)}`),
      recipient: getAddress(`0x${'44'.repeat(20)}`),
      amount: 10n ** 18n,
    },
    fee: 0n,
    srcBlockNumber: 100,
    srcBlockHash: `0x${'aa'.repeat(32)}`,
    srcTxHash: `0x${'bb'.repeat(32)}`,
    srcLogIndex: 0,
    status: 'seen',
    reason: null,
    firstSeenAt,
    confirmedAt: null,
    executedAt: null,
    executedTxHash: null,
    updatedAt: firstSeenAt,
  });
  try {
    const t0 = Date.now() - 3_600_000;
    for (let i = 0; i < 1000; i++) store.putTransfer(row(`0x${i.toString(16).padStart(64, '0')}`, CHAIN_B, t0 + i));
    const mine = `0x${'ab'.repeat(32)}`;
    store.putTransfer(row(mine, CHAIN_A, t0 + 5_000));
    store.setCursor(CHAIN_A, 199);

    const w = new Watcher({ chain, store, log: silent(), alerts: alerter(), requireRpcQuorum: false, onConfirmed: (t) => confirmed.push(t.transferId) });
    await w.pollOnce();
    assert.equal(w.stats.lastError, null);
    assert.deepEqual(checked, [mine], "only this chain's transfer is re-read, and it is reached");
    assert.deepEqual(confirmed, [mine]);
    assert.equal(store.getTransfer(mine)?.status, 'confirmed');
    assert.equal(store.listTransfers({ status: ['seen'], limit: 2000 }).length, 1000, "chain B's rows are left for chain B's watcher");
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ scan health

test('scan health: frozen, never-run and far-behind scanners are lagging; a current one is not', () => {
  const chain = { name: 'bsc', confirmations: 20, maxBlockRange: 2000, pollIntervalMs: 3000 };
  const now = 1_790_000_000_000;
  const fresh = scanHealth({ head: 1_000_000, cursor: 999_980, lastPollAt: now, lastSuccessAt: now - 5_000 }, chain, now);
  assert.equal(fresh.lagging, false);
  assert.equal(fresh.lagBlocks, 20);

  const never = scanHealth({ head: 0, cursor: 0, lastPollAt: 0, lastSuccessAt: 0 }, chain, now);
  assert.equal(never.lagging, true);

  // The 2026-09-14 BSC shape: polling every 3 s, every poll failing, cursor frozen.
  const frozen = scanHealth({ head: 123_798_022, cursor: 121_862_043, lastPollAt: now, lastSuccessAt: now - 10 * 86_400_000 }, chain, now);
  assert.equal(frozen.lagging, true);
  assert.match(frozen.reason, /not completed a scan for/);
  assert.equal(frozen.lagBlocks, 1_935_979);

  const behind = scanHealth({ head: 1_000_000, cursor: 900_000, lastPollAt: now, lastSuccessAt: now }, chain, now);
  assert.equal(behind.lagging, true, 'polls succeed but the cursor is far under the head');
});

test('scan health: a lagging scanner pauses the published verdict; a more specific pause keeps its reason', () => {
  const lagging = { head: 10, cursor: 1, lagBlocks: 9, lastPollAt: 1, lastSuccessAt: 0, lagging: true, reason: 'the bsc scanner has not completed a scan yet' };
  const ok = { ...lagging, lagging: false, reason: null };
  const open = { mode: 'count', signing: { paused: false, reason: null } };
  const stale = { mode: 'checkpoint', signing: { paused: true, reason: 'Checkpoint stale: …' } };

  assert.deepEqual(withScanVerdict(open, ok), open, 'nothing to add');
  const paused = withScanVerdict(open, lagging);
  assert.equal(paused.signing.paused, true);
  assert.match(paused.signing.reason, /^Scanner behind: /);
  assert.deepEqual(Object.keys(paused.signing).sort(), ['paused', 'reason'], 'same shape the UI parses');
  assert.equal(withScanVerdict(stale, lagging).signing.reason, 'Checkpoint stale: …');
});

// ------------------------------------------------------------------ config + alerts

test('config: a fractional value in a whole-number field fails at startup, not inside planFees', () => {
  const doc = (priorityFeeGwei) =>
    JSON.stringify({
      network: 'test',
      chains: [CHAIN_A, CHAIN_B].map((chainId, i) => ({
        name: `c${i}`,
        chainId,
        rpcUrls: [`http://n${i}a.example:8545`, `http://n${i}b.example:8545`, `http://n${i}c.example:8545`],
        bridgeAddress: BRIDGE,
        confirmations: 3,
        gas: { priorityFeeGwei },
        limits: { default: { maxPerTransfer: '1', dailyCap: '2' }, tokens: {} },
      })),
      insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowCountFinalityWithoutGadget: true },
    });
  assert.throws(() => parseConfig(doc(0.05), 'x'), /priorityFeeGwei.*whole number/);
  assert.equal(parseConfig(doc(0), 'x').chains[0].gas.priorityFeeGwei, 0, '0 = take the node\'s own tip (0.05 gwei on BSC)');
});

test('alerts: the same alert every poll is logged once per throttle window, with a count', () => {
  const { logger, lines } = capturingLogger('debug');
  const a = alerter(60_000, logger);
  for (let i = 0; i < 50; i++) a.fire({ kind: 'rpc_unhealthy', severity: 'warn', message: 'RPC endpoint unusable', key: 'call-failed:http://x' });
  assert.equal(lines.length, 1, 'one line, not fifty');
  assert.equal(a.counts.get('rpc_unhealthy'), 50, 'the metric still counts every one');
  a.fire({ kind: 'rpc_unhealthy', severity: 'warn', message: 'another endpoint', key: 'call-failed:http://y' });
  assert.equal(lines.length, 2, 'a different key is a different line');
});

test('scan health: the UI fixture carries exactly the keys scanHealth() emits', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('../../ui/tests/fixtures/relayer-status.json', import.meta.url), 'utf8'));
  const emitted = Object.keys(scanHealth({ head: 1, cursor: 1, lastPollAt: 1, lastSuccessAt: 1 }, { name: 'x', confirmations: 1, maxBlockRange: 1, pollIntervalMs: 1 }, 1)).sort();
  for (const c of fixture.chains) assert.deepEqual(Object.keys(c.scan).sort(), emitted, `${c.name}.scan`);
});

// ------------------------------------------------------------------ role work is serial

test('serialQueue: one call at a time, in order, and a throw does not wedge the queue', async () => {
  const q = serialQueue();
  const order = [];
  let active = 0;
  let peak = 0;
  const job = (name, ms, fail = false) => q(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, ms));
    order.push(name);
    active--;
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([job('a', 30), job('b', 5, true), job('c', 1)]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

/** Two chains on unreachable hosts: enough for a RelayerService to construct. */
const serviceDoc = () =>
  JSON.stringify({
    network: 'test',
    chains: [CHAIN_A, CHAIN_B].map((chainId, i) => ({
      name: `c${i}`,
      chainId,
      rpcUrls: [`http://n${i}a.example:8545`, `http://n${i}b.example:8545`, `http://n${i}c.example:8545`],
      bridgeAddress: BRIDGE,
      confirmations: 3,
      limits: { default: { maxPerTransfer: '1', dailyCap: '2' }, tokens: {} },
    })),
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowCountFinalityWithoutGadget: true },
  });

test('service: a watcher\'s onConfirmed never runs concurrently with the role tick', async () => {
  // Both used to run free: the validator verified the same transfer twice and
  // consumed its 24h capacity twice for one signature, and the submitter's two
  // allocateNonce() calls could hand two transfers the same account nonce.
  const doc = serviceDoc();
  const dir = mkdtempSync(join(tmpdir(), 'svc-serial-'));
  const store = await openStore(join(dir, 'r.db'), 'journal');
  let active = 0;
  let peak = 0;
  const busy = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  };
  const service = new RelayerService({
    cfg: parseConfig(doc, 'x'),
    role: 'validator',
    log: silent(),
    alerts: alerter(),
    store,
    metrics: new Metrics(),
    tickIntervalMs: 1_000,
    hooks: { onConfirmed: busy, tick: busy },
  });
  try {
    const onConfirmed = service.watchers[0].onConfirmed;
    await Promise.all([onConfirmed({}), service.runTick(), onConfirmed({}), service.runTick()]);
    assert.equal(peak, 1, 'role work overlapped');
  } finally {
    for (const c of service.chains.values()) dispose(c);
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service: a confirmation is queued behind the role tick, never awaited by the scan', async () => {
  // Awaiting the queued hook froze the source chain's poll for the rest of a
  // tick — minutes, on a destination endpoint that passes the probe and hangs on
  // eth_call — so lastSuccessAt went stale and /status published "Scanner
  // behind" for every route out of that chain, not only the impaired one.
  const dir = mkdtempSync(join(tmpdir(), 'svc-queue-'));
  const store = await openStore(join(dir, 'r.db'), 'journal');
  let release;
  const gate = new Promise((r) => (release = r));
  let active = 0;
  let peak = 0;
  const handled = [];
  const service = new RelayerService({
    cfg: parseConfig(serviceDoc(), 'x'),
    role: 'validator',
    log: silent(),
    alerts: alerter(),
    store,
    metrics: new Metrics(),
    tickIntervalMs: 1_000,
    hooks: {
      onConfirmed: async (t) => {
        active++;
        peak = Math.max(peak, active);
        handled.push(t.transferId);
        active--;
      },
      tick: async () => {
        active++;
        peak = Math.max(peak, active);
        await gate; // a tick stuck on a hung destination read
        active--;
      },
    },
  });
  const chain = {
    name: 'a',
    chainId: CHAIN_A,
    config: { confirmations: 3, startBlock: 0, pollIntervalMs: 500 },
    healthyEndpoints: [{}],
    healthCheck: async () => {},
    getBlockNumber: async () => 200,
    settledHeight: async () => 197,
    scanSent: async () => [],
    confirmSentAcrossEndpoints: async () => ({ status: 'ok', agreed: 1, checked: 1, reason: null }),
  };
  const id = `0x${'ab'.repeat(32)}`;
  const now = Date.now();
  store.putTransfer({
    transferId: id,
    transfer: {
      srcChainId: CHAIN_A,
      dstChainId: CHAIN_B,
      nonce: 1,
      srcToken: ZeroAddress,
      dstToken: getAddress(`0x${'22'.repeat(20)}`),
      sender: getAddress(`0x${'33'.repeat(20)}`),
      recipient: getAddress(`0x${'44'.repeat(20)}`),
      amount: 10n ** 18n,
    },
    fee: 0n,
    srcBlockNumber: 100,
    srcBlockHash: `0x${'aa'.repeat(32)}`,
    srcTxHash: `0x${'bb'.repeat(32)}`,
    srcLogIndex: 0,
    status: 'seen',
    reason: null,
    firstSeenAt: now,
    confirmedAt: null,
    executedAt: null,
    executedTxHash: null,
    updatedAt: now,
  });
  store.setCursor(CHAIN_A, 199);
  const tickDone = service.runTick();
  try {
    const w = new Watcher({ chain, store, log: silent(), alerts: alerter(), requireRpcQuorum: false, onConfirmed: service.watchers[0].onConfirmed });
    const polled = await Promise.race([w.pollOnce().then(() => 'polled'), new Promise((r) => setTimeout(() => r('blocked'), 1_000))]);
    assert.equal(polled, 'polled', 'the scan finished while the tick was still running');
    assert.equal(w.stats.lastError, null);
    assert.ok(w.stats.lastSuccessAt > 0, 'and counts as a completed scan');
    assert.equal(store.getTransfer(id)?.status, 'confirmed');
    assert.deepEqual(handled, [], 'the role work waits for the tick in flight');

    release();
    await tickDone;
    await service.runTick(); // FIFO: settles after everything queued before it
    assert.deepEqual(handled, [id], 'and then runs, once');
    assert.equal(peak, 1, 'never beside the tick');
  } finally {
    release();
    await tickDone;
    for (const c of service.chains.values()) dispose(c);
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
