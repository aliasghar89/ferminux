// Regression tests for the 2026-08-20 red-team findings, off-chain half.
//
// One test per finding, each written so that it FAILS against the code as it
// was audited:
//
//   healthCheck() no-op          a dead endpoint must be demoted, and a
//                                wrong-chain endpoint must be rejected — both
//                                were invisible because staticNetwork makes
//                                getNetwork() answer without dialling
//   single-source confirmation   one endpoint agreeing with itself is not a
//                                quorum, at config time and at signing time
//   open HTTP API                no token on a routable bind must not start;
//                                unauthenticated calls must be refused; a
//                                flood must be throttled
//   env-var keystore password    must be refused unless explicitly allowed
//   consumed 24h capacity        must be released on every reject path
//
// Everything here binds 127.0.0.1 on 8592-8595 and frees the port again. The
// RPC endpoints are hand-written JSON-RPC servers rather than anvil, so the
// suite stays dependency-free and can serve deliberately wrong answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, ZeroAddress, getAddress } from 'ethers';

import { Alerter } from '../src/alerts.ts';
import { BRIDGE_ABI } from '../src/abi.ts';
import { ChainClient } from '../src/chain.ts';
import { INSECURE_ACKNOWLEDGEMENT, parseConfig } from '../src/config.ts';
import { AUTHENTICATED_RATE_MULTIPLIER, RelayerHttpServer, TokenBucketLimiter } from '../src/http.ts';
import { assertNoEnvPassword, loadKey, readPassword } from '../src/keystore.ts';
import { VolumeLimiter, windowKey } from '../src/limits.ts';
import { Logger, createLogger } from '../src/logger.ts';
import { Metrics } from '../src/metrics.ts';
import { digestFor, transferIdOf } from '../src/transfer.ts';
import { releaseCapacity, verifyForSigning } from '../src/verify.ts';

/** The real CLI entry point, for the tests that must observe a whole process. */
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');

const BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHAIN_A = 3961;
const CHAIN_B = 56;

/**
 * Ports this file owns. Nothing else in the suite binds a fixed port.
 *
 * Every fake node LISTENS on 127.0.0.1, and some are ADDRESSED as `localhost`.
 * That USED to be how these fixtures satisfied the "distinct hosts" rule — two
 * hostname strings, one machine, which is precisely the hole the independence
 * check closes. They no longer get to pretend: a chain built out of loopback
 * nodes carries the acknowledgement sentence and states its floor explicitly
 * (see localChain), because on one machine there is genuinely only one witness
 * however the URLs are spelled.
 */
const P = { rpcA: 8592, rpcB: 8593, rpcSpare: 8594, http: 8595 };
const DEAD = `http://localhost:${8594}`; // nothing is listening here unless a test binds it

const iface = new Interface(BRIDGE_ABI);

// ------------------------------------------------------------------- plumbing

/**
 * A logger that writes into an array instead of stdout. Nothing here hijacks
 * process.stdout: the test runner is using it, and a global swap swallows the
 * runner's own reporting for anything that logs asynchronously.
 */
function capturingLogger(level = 'debug') {
  const lines = [];
  const logger = createLogger(level, 'json', {}, (line) => lines.push(line));
  return { logger, lines, text: () => lines.join('') };
}

const silentLogger = () => capturingLogger('error').logger;

function silentAlerter(cfg) {
  return new Alerter(
    cfg ?? { alerts: { webhookUrl: null, minSeverity: 'critical', throttleMs: 0 }, network: 'test' },
    'test',
    silentLogger(),
  );
}

/** Record every alert an Alerter fires, without losing its normal behaviour. */
function watchAlerts(alerts) {
  const fired = [];
  const real = alerts.fire.bind(alerts);
  alerts.fire = (a) => {
    fired.push(a);
    return real(a);
  };
  return fired;
}

/**
 * A JSON-RPC endpoint that answers exactly what the test tells it to. This is
 * how a "dead" and a "wrong chain" endpoint are produced without depending on
 * anvil, and how a lying endpoint is produced without a proxy.
 */
async function fakeRpc(port, opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const state = {
    chainId: opts.chainId ?? CHAIN_A,
    blockNumber: opts.blockNumber ?? 200,
    logs: opts.logs ?? [],
    failEverything: opts.failEverything ?? false,
    hits: {},
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end('{}');
        return;
      }
      const answer = (p) => {
        state.hits[p.method] = (state.hits[p.method] ?? 0) + 1;
        if (state.failEverything && p.method !== 'eth_chainId') {
          return { jsonrpc: '2.0', id: p.id, error: { code: -32000, message: 'node is broken' } };
        }
        switch (p.method) {
          case 'eth_chainId':
            return { jsonrpc: '2.0', id: p.id, result: `0x${state.chainId.toString(16)}` };
          case 'eth_blockNumber':
            return { jsonrpc: '2.0', id: p.id, result: `0x${state.blockNumber.toString(16)}` };
          case 'eth_getLogs':
            return { jsonrpc: '2.0', id: p.id, result: state.logs };
          case 'eth_getBlockByNumber':
            return { jsonrpc: '2.0', id: p.id, result: null };
          default:
            return { jsonrpc: '2.0', id: p.id, error: { code: -32601, message: `unsupported: ${p.method}` } };
        }
      };
      const out = Array.isArray(payload) ? payload.map(answer) : answer(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://${host}:${port}`,
    state,
    close: () =>
      new Promise((r) => {
        // Idle keep-alive sockets are closed with a FIN, not destroyed, so a
        // client pool evicts them cleanly instead of discovering them with a
        // reset on the next test's request against the same port.
        server.closeIdleConnections?.();
        server.close(r);
        server.closeAllConnections?.();
      }),
  };
}

/** A syntactically real `Sent` log for a transfer the test invents. */
function sentLog({ blockNumber = 100, blockHash = `0x${'ab'.repeat(32)}`, amount = 10n ** 18n, nonce = 1 } = {}) {
  const transfer = {
    srcChainId: CHAIN_A,
    dstChainId: CHAIN_B,
    nonce,
    srcToken: ZeroAddress,
    dstToken: getAddress(`0x${'22'.repeat(20)}`),
    sender: getAddress(`0x${'33'.repeat(20)}`),
    recipient: getAddress(`0x${'44'.repeat(20)}`),
    amount,
  };
  const transferId = transferIdOf(transfer);
  const { data, topics } = iface.encodeEventLog('Sent', [
    transferId,
    transfer.dstChainId,
    transfer.srcToken,
    transfer.srcChainId,
    transfer.nonce,
    transfer.dstToken,
    transfer.sender,
    transfer.recipient,
    transfer.amount,
    0n,
  ]);
  return {
    transfer,
    transferId,
    blockHash,
    blockNumber,
    log: {
      address: BRIDGE,
      topics,
      data,
      blockNumber: `0x${blockNumber.toString(16)}`,
      blockHash,
      transactionHash: `0x${'cd'.repeat(32)}`,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    },
  };
}

// Three endpoints on three registrable domains per chain: the shape a
// production config has to have now, so the generic fixtures are held to it.
const THREE_A = ['http://node-a1.example:8545', 'http://node-a2.example:8545', 'http://node-a3.example:8545'];
const THREE_B = ['http://node-b1.example:8545', 'http://node-b2.example:8545', 'http://node-b3.example:8545'];

function configText({ rpcA, rpcB = THREE_B, minAgreeA, ...overrides } = {}) {
  return JSON.stringify({
    network: 'test',
    chains: [
      {
        name: 'a',
        chainId: CHAIN_A,
        rpcUrls: rpcA ?? THREE_A,
        ...(minAgreeA === undefined ? {} : { minAgreeingEndpoints: minAgreeA }),
        bridgeAddress: BRIDGE,
        confirmations: 3,
        pollIntervalMs: 500,
        limits: { default: { maxPerTransfer: '10000000000000000000', dailyCap: '100000000000000000000' }, tokens: {} },
      },
      {
        name: 'b',
        chainId: CHAIN_B,
        rpcUrls: rpcB,
        bridgeAddress: BRIDGE,
        confirmations: 3,
        limits: { default: { maxPerTransfer: '10000000000000000000', dailyCap: '100000000000000000000' }, tokens: {} },
      },
    ],
    // Gadget-less chains in plain count mode: refused for production since the
    // finality work, so the generic fixture says so (finality.test.mjs covers
    // the refusal itself).
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowCountFinalityWithoutGadget: true },
    ...overrides,
  });
}

const parse = (o) => parseConfig(configText(o), 'x');

/**
 * A chain whose endpoints are fake nodes on THIS machine.
 *
 * 127.0.0.1 and localhost are one provider — the independence check says so and
 * refuses to count them twice — so these fixtures declare that openly with the
 * acknowledgement sentence instead of dressing one node up as a quorum. The
 * floor is then stated explicitly, because the behaviour under test is what
 * happens at a floor of 2, not how the floor is derived.
 */
const localChain = (urls, minAgreeA = 2, extra = {}) =>
  parse({
    rpcA: urls,
    minAgreeA,
    ...extra,
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true, ...(extra.insecure ?? {}) },
  });

function chainClientFor(cfg, chainId, alerts) {
  return new ChainClient(
    cfg.chains.find((c) => c.chainId === chainId),
    silentLogger(),
    alerts ?? silentAlerter(cfg),
  );
}

/**
 * Close every provider's sockets. These tests rebind the same ports over and
 * over; a keep-alive socket left open to a server that has since been closed
 * shows up as an unrelated ECONNRESET in whichever test runs next.
 */
function dispose(...chains) {
  for (const chain of chains) {
    for (const e of chain.endpoints) e.provider.destroy();
  }
}

// ============================================================================
// FINDING: no enforced minimum of independent RPC endpoints
// ============================================================================

test('config: an enabled chain with ONE rpc endpoint does not start', () => {
  assert.throws(
    () => parse({ rpcA: ['http://only-one.example:8545'] }),
    /only 1 endpoint\(s\) configured/,
    'a single endpoint is a single source of truth, which is what an eclipse manufactures',
  );
});

test('config: two endpoints on the SAME host are one source wearing two hats', () => {
  assert.throws(
    () => parse({ rpcA: ['http://node-a.example:8545', 'http://node-a.example:8546'] }),
    /resolve to ONE provider/,
  );
});

// The shipped configuration this closes gave every chain TWO endpoints against
// a floor of two, so an attacker who took down ONE public provider stopped that
// validator signing — permanently, and against the safe default. Two endpoints
// cannot be reconciled with a floor of two: the reconciliation is a third
// provider, and the parser now insists on it.
test('config: two providers with a floor of two is refused — one outage would halt the chain', () => {
  assert.throws(
    () => parse({ rpcA: ['http://node-a.example:8545', 'http://node-b.example:8545'] }),
    /a single provider outage would HALT this chain/,
  );
  assert.doesNotThrow(() =>
    parse({ rpcA: ['http://node-a.example:8545', 'http://node-b.example:8545', 'http://node-c.example:8545'] }),
  );
});

test('config: a provider that could meet the floor on its own is refused', () => {
  // 4 endpoints, 3 providers, floor 2 — but "provider-x" holds two of them, so
  // provider-x alone could satisfy the floor and sign with nobody corroborating.
  assert.throws(
    () =>
      parse({
        rpcA: [
          'http://a.provider-x.example:8545',
          'http://b.provider-x.example:8545',
          'http://node.provider-y.example:8545',
          'http://node.provider-z.example:8545',
        ],
      }),
    /alone holds 2 endpoint\(s\), which meets minAgreeingEndpoints \(2\) on its own/,
  );
});

test('config: a disabled chain may still hold a single-endpoint placeholder', () => {
  const raw = JSON.parse(configText());
  raw.chains[0].rpcUrls = ['http://only-one.example:8545'];
  raw.chains[0].enabled = false;
  assert.doesNotThrow(() => parseConfig(JSON.stringify(raw), 'x'));
});

test('config: minAgreeingEndpoints defaults to a majority of PROVIDERS, never below 2', () => {
  const three = parse({ rpcA: ['http://a1.example', 'http://a2.example', 'http://a3.example'] });
  assert.equal(three.chains[0].minAgreeingEndpoints, 2, '3 providers: a majority is 2, so one may be down');
  const five = parse({ rpcA: ['http://a1.example', 'http://a2.example', 'http://a3.example', 'http://a4.example', 'http://a5.example'] });
  assert.equal(five.chains[0].minAgreeingEndpoints, 3, '5 providers: a majority is 3');
  // Counting URLs instead of providers is the bug: these six URLs are three
  // operators. The auto floor is a majority of THREE (= 2), and since each
  // operator holds two endpoints — enough to meet a floor of 2 by itself — the
  // set is refused until the floor is raised.
  const sixUrlsThreeOperators = [
    'http://a.x.example',
    'http://b.x.example',
    'http://a.y.example',
    'http://b.y.example',
    'http://a.z.example',
    'http://b.z.example',
  ];
  assert.throws(() => parse({ rpcA: sixUrlsThreeOperators }), /alone holds 2 endpoint\(s\)/);
  const raised = parse({ rpcA: sixUrlsThreeOperators, minAgreeA: 3 });
  assert.equal(raised.chains[0].minAgreeingEndpoints, 3, 'raising the floor above any one operator makes the set sound');
});

// ============================================================================
// FINDING: the independence check was a hostname STRING comparison
// ============================================================================

test('config: 127.0.0.1 and localhost are ONE node, not two independent endpoints', () => {
  // The verifier's exact case. It used to pass as "2 endpoints on 2 distinct
  // hosts" and satisfy the whole eclipse argument with one process.
  assert.throws(
    () => parse({ rpcA: ['http://127.0.0.1:8596', 'http://localhost:8596'] }),
    /resolve to ONE provider/,
    'two spellings of this machine are one witness',
  );
  assert.throws(
    () => parse({ rpcA: ['http://127.0.0.1:8596', 'http://localhost:8597', 'http://127.0.0.2:8598'] }),
    /resolve to ONE provider/,
    'and a third loopback alias does not make it three',
  );
});

test('config: two hostnames under one registrable domain are one operator', () => {
  assert.throws(
    () => parse({ rpcA: ['https://rpc.example.com', 'https://backup.example.com'] }),
    /resolve to ONE provider/,
  );
  // Multi-label public suffixes are handled, so three UK registrants are three
  // operators and not one "co.uk".
  assert.doesNotThrow(() => parse({ rpcA: ['https://rpc.a.co.uk', 'https://rpc.b.co.uk', 'https://rpc.c.co.uk'] }));
  // Sub-delegated suffixes are deliberately NOT expanded the same way: two
  // tenants of one platform are different customers on one piece of
  // infrastructure, and the conservative reading is the safe one.
  assert.throws(
    () => parse({ rpcA: ['https://a.vercel.app', 'https://b.vercel.app', 'https://c.vercel.app'] }),
    /resolve to ONE provider/,
  );
});

test('config: minAgreeingEndpoints cannot be lowered to 1, and cannot exceed the endpoints', () => {
  const one = JSON.parse(configText());
  one.chains[0].minAgreeingEndpoints = 1;
  assert.throws(() => parseConfig(JSON.stringify(one), 'x'), /must be at least 2/);

  const tooMany = JSON.parse(configText());
  tooMany.chains[0].minAgreeingEndpoints = 5;
  assert.throws(() => parseConfig(JSON.stringify(tooMany), 'x'), /could never confirm anything/);
});

test('config: the insecure switches need the acknowledgement sentence, spelled out', () => {
  // A bare boolean is exactly what gets flipped by someone who does not know
  // what it does, so the flag alone is refused.
  assert.throws(
    () => parse({ rpcA: ['http://only-one.example:8545'], insecure: { allowSingleRpcEndpoint: true } }),
    /insecure\.acknowledgement/,
  );
  assert.throws(
    () =>
      parse({
        rpcA: ['http://only-one.example:8545'],
        insecure: { acknowledgement: 'I understand', allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
      }),
    /must be exactly/,
  );
  const ok = parse({
    rpcA: ['http://only-one.example:8545'],
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
  });
  assert.equal(ok.chains[0].minAgreeingEndpoints, 1, 'a devnet with one anvil confirms from that one anvil');
  assert.equal(ok.insecure.acknowledged, true);
});

test('config: requireRpcQuorum=false is refused unless it is acknowledged as unsafe', () => {
  assert.throws(() => parse({ validator: { requireRpcQuorum: false } }), /allowPartialEndpointAgreement/);
  assert.doesNotThrow(() =>
    parse({
      validator: { requireRpcQuorum: false },
      insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowPartialEndpointAgreement: true, allowCountFinalityWithoutGadget: true },
    }),
  );
});

// ============================================================================
// FINDING [HIGH]: healthCheck() is a no-op — staticNetwork means no dial
// ============================================================================

test('chain: a DEAD endpoint is demoted, even though getNetwork() still answers', async () => {
  const alive = await fakeRpc(P.rpcA, { chainId: CHAIN_A });
  try {
    const cfg = localChain([alive.url, DEAD]);
    const chain = chainClientFor(cfg, CHAIN_A);

    // The bug, stated as an assertion: this is what healthCheck() used to trust.
    const local = await chain.endpoints[1].provider.getNetwork();
    assert.equal(Number(local.chainId), CHAIN_A, 'getNetwork() answers from staticNetwork without dialling — it always did');

    await chain.healthCheck();
    assert.equal(chain.endpoints[0].healthy, true, 'the live endpoint is healthy');
    assert.equal(chain.endpoints[1].healthy, false, 'the dead endpoint is NOT healthy');
    assert.match(chain.endpoints[1].lastError, /ECONNREFUSED|refused|timed out/, 'and it says WHY, rather than logging an empty AggregateError message');
    assert.equal(chain.healthyEndpoints.length, 1);
    dispose(chain);
  } finally {
    await alive.close();
  }
});

test('chain: an endpoint on the WRONG chain is rejected, not merely noted', async () => {
  const right = await fakeRpc(P.rpcA, { chainId: CHAIN_A });
  const wrong = await fakeRpc(P.rpcSpare, { chainId: CHAIN_B, host: 'localhost' });
  try {
    const cfg = localChain([right.url, wrong.url]);
    const alerts = silentAlerter(cfg);
    const fired = watchAlerts(alerts);
    const chain = chainClientFor(cfg, CHAIN_A, alerts);

    await chain.healthCheck();
    assert.equal(chain.endpoints[0].healthy, true, `the honest endpoint answered: ${chain.endpoints[0].lastError}`);
    assert.equal(chain.endpoints[1].healthy, false, 'an endpoint on another chain is not a degraded endpoint, it is a different chain');
    assert.match(chain.endpoints[1].lastError, /reports chain id 56, expected 3961/);
    // This alert branch was unreachable dead code before the probe was real.
    assert.ok(
      fired.some((a) => a.kind === 'rpc_unhealthy' && a.severity === 'critical' && /wrong chain/i.test(a.message)),
      'the wrong-chain alert actually fires',
    );
    dispose(chain);
  } finally {
    await right.close();
    await wrong.close();
  }
});

test('chain: an endpoint that comes back is put back into rotation automatically', async () => {
  const steady = await fakeRpc(P.rpcA, { chainId: CHAIN_A });
  let flaky = await fakeRpc(P.rpcB, { chainId: CHAIN_A, host: 'localhost' });
  try {
    const cfg = localChain([steady.url, flaky.url]);
    const chain = chainClientFor(cfg, CHAIN_A);

    await chain.healthCheck();
    assert.equal(chain.healthyEndpoints.length, 2, 'both up');

    await flaky.close();
    await chain.healthCheck();
    assert.equal(chain.healthyEndpoints.length, 1, 'one went away');

    flaky = await fakeRpc(P.rpcB, { chainId: CHAIN_A, host: 'localhost' });
    await chain.healthCheck();
    assert.equal(chain.healthyEndpoints.length, 2, 'and came back without a restart or an operator');
    assert.equal(chain.endpoints[1].consecutiveFailures, 0, 'the failure counter resets on recovery');
    dispose(chain);
  } finally {
    await steady.close();
    await flaky.close().catch(() => {});
  }
});

test('chain: a healthy-but-broken endpoint is demoted by the data call that fails', async () => {
  const good = await fakeRpc(P.rpcA, { chainId: CHAIN_A, blockNumber: 500 });
  const broken = await fakeRpc(P.rpcB, { chainId: CHAIN_A, failEverything: true, host: 'localhost' });
  try {
    const cfg = localChain([broken.url, good.url]); // broken FIRST, as in the audit
    const chain = chainClientFor(cfg, CHAIN_A);
    await chain.healthCheck();
    assert.equal(chain.healthyEndpoints.length, 2, 'it answers eth_chainId, so the probe passes');

    // Previously requireEndpoint() returned healthyEndpoints[0] and the whole
    // poll threw. Now the read fails over and the bad endpoint is demoted.
    const head = await chain.getBlockNumber();
    assert.equal(head, 500, 'the head came from the endpoint that actually works');
    assert.equal(chain.endpoints[0].healthy, false, 'the endpoint that threw is out of the set');
    assert.match(chain.endpoints[0].lastError, /node is broken/);
    dispose(chain);
  } finally {
    await good.close();
    await broken.close();
  }
});

// ============================================================================
// FINDING: never confirm from a single surviving endpoint
// ============================================================================

test('chain: with one of two endpoints dead, a transfer is NOT confirmed from the survivor', async () => {
  const ev = sentLog();
  const alive = await fakeRpc(P.rpcA, { chainId: CHAIN_A, logs: [ev.log] });
  try {
    const cfg = localChain([alive.url, DEAD]);
    const chain = chainClientFor(cfg, CHAIN_A);
    assert.equal(chain.minAgreeingEndpoints, 2);

    await chain.healthCheck();
    assert.equal(chain.healthyEndpoints.length, 1, `only the attacker-chosen survivor is up (${chain.endpoints.map((e) => `${e.url}=${e.healthy}:${e.lastError}`).join(' ')})`);

    const check = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, true);
    assert.equal(check.status, 'unavailable', 'refusal, not a signature');
    assert.match(check.reason, /2 independent confirmations are required/);

    // ...and not with requireRpcQuorum turned off either. That is the exact
    // combination the audit used to mint unbacked tokens: DoS the honest
    // endpoints, serve a fabricated Sent from the one you control.
    const lax = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, false);
    assert.equal(lax.status, 'unavailable', 'requireRpcQuorum=false is not a way around the floor');
    dispose(chain);
  } finally {
    await alive.close();
  }
});

test('chain: two agreeing endpoints out of three DO confirm — one down is survivable', async () => {
  const ev = sentLog();
  const a = await fakeRpc(P.rpcA, { chainId: CHAIN_A, logs: [ev.log] });
  const b = await fakeRpc(P.rpcB, { chainId: CHAIN_A, logs: [ev.log], host: 'localhost' });
  try {
    const cfg = localChain([a.url, b.url, DEAD]);
    const chain = chainClientFor(cfg, CHAIN_A);
    assert.equal(chain.minAgreeingEndpoints, 2, 'the floor these fixtures state explicitly');

    await chain.healthCheck();
    assert.equal(chain.healthyEndpoints.length, 2);

    const check = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, true);
    // The availability half of the HIGH: before the fix the dead endpoint stayed
    // "healthy", counted as errored, and requireRpcQuorum=true deferred forever.
    assert.equal(check.status, 'ok', 'the dead endpoint is excluded, the two live ones agree, the validator can sign');
    assert.equal(check.agreed, 2);
    dispose(chain);
  } finally {
    await a.close();
    await b.close();
  }
});

test('chain: endpoints that DISAGREE are a split, never a signature', async () => {
  const ev = sentLog();
  const honest = await fakeRpc(P.rpcA, { chainId: CHAIN_A, logs: [ev.log] });
  const eclipsing = await fakeRpc(P.rpcB, { chainId: CHAIN_A, logs: [], host: 'localhost' }); // hides the log
  try {
    const cfg = localChain([honest.url, eclipsing.url]);
    const chain = chainClientFor(cfg, CHAIN_A);
    await chain.healthCheck();
    const check = await chain.confirmSentAcrossEndpoints(ev.transferId, ev.blockNumber, ev.blockHash, true);
    assert.equal(check.status, 'quorum_failed');
    assert.equal(check.agreed, 1);
    dispose(chain);
  } finally {
    await honest.close();
    await eclipsing.close();
  }
});

// ============================================================================
// FINDING: unauthenticated, unthrottled HTTP API with an empty default token
// ============================================================================

test('config: an empty apiToken on a routable bind is a startup failure', () => {
  assert.throws(() => parse({ http: { host: '0.0.0.0', port: 8564, apiToken: '' } }), /reachable from the network/);
  assert.throws(() => parse({ http: { host: '10.0.0.7', port: 8564 } }), /reachable from the network/);
  // Loopback with no token is the local-devnet shape and stays allowed.
  const loopback = parse({ http: { host: '127.0.0.1', port: 8564, apiToken: '' } });
  assert.equal(loopback.http.apiToken, null, 'an empty string is normalised to "no token", never to a token of length 0');
  assert.doesNotThrow(() => parse({ http: { host: '0.0.0.0', port: 8564, apiToken: 'a'.repeat(32) } }));
});

test('config: a token short enough to guess, or copied out of the template, is refused', () => {
  assert.throws(() => parse({ http: { host: '0.0.0.0', apiToken: 'abc123' } }), /at least 16 characters/);
  // A placeholder that PASSES validation is worse than an empty token: it looks
  // configured. This is the literal value in deploy/*.env.example.
  assert.throws(
    () => parse({ http: { host: '0.0.0.0', apiToken: `REPLACE_ME_${'0'.repeat(62)}` } }),
    /looks like a placeholder/,
  );
  assert.doesNotThrow(() => parse({ http: { host: '0.0.0.0', apiToken: 'a3f9'.repeat(16) } }));
});

/**
 * Raw HTTP with `agent: false` — no connection pooling. fetch() keeps a
 * keep-alive socket per origin, and these tests deliberately bind the same port
 * over and over, so a pooled socket to a server that has already been closed
 * shows up as an ECONNRESET that has nothing to do with what is being tested.
 */
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function withHttp(opts, fn) {
  const metrics = new Metrics();
  const server = new RelayerHttpServer({
    host: '127.0.0.1',
    port: P.http,
    apiToken: opts.apiToken ?? null,
    rateLimit: opts.rateLimit ?? { burst: 1000, refillPerSecond: 1000, maxClients: 64 },
    maxConnections: 64,
    metrics,
    log: silentLogger(),
    handlers: {
      health: () => ({ ok: true, body: { ok: true } }),
      status: () => ({ role: 'validator', inFlightBook: 'sender, recipient, amount, status' }),
      transfers: () => [{ transferId: '0x00', sender: '0xdead' }],
      signatures: () => null,
    },
  });
  const port = await server.listen();
  try {
    return await fn(port, server, metrics);
  } finally {
    await server.close();
  }
}

test('http: without the bearer token, everything except /health is refused', async () => {
  const token = 'x'.repeat(32);
  await withHttp({ apiToken: token }, async (port) => {
    // /health stays open: a health check that needs a secret is one nobody wires up.
    assert.equal((await rawRequest(port, { path: '/health' })).status, 200);

    for (const path of ['/status', '/metrics', '/transfers', `/signatures?transferId=0x${'11'.repeat(32)}`, '/']) {
      const res = await rawRequest(port, { path });
      assert.equal(res.status, 401, `${path} must refuse an unauthenticated caller`);
      assert.ok(!/sender|recipient|inFlightBook/.test(res.body), `${path} must not leak the transfer book in its refusal`);
    }

    assert.equal((await rawRequest(port, { path: '/status', headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await rawRequest(port, { path: '/status', headers: { authorization: token } })).status, 401, 'the Bearer prefix is required');

    const good = await rawRequest(port, { path: '/status', headers: { authorization: `Bearer ${token}` } });
    assert.equal(good.status, 200);
    assert.match(good.body, /inFlightBook/);
  });
});

test('http: with no token at all, the surface is open — which is why config.ts gates the bind', async () => {
  await withHttp({ apiToken: null }, async (port) => {
    assert.equal((await rawRequest(port, { path: '/status' })).status, 200);
  });
});

test('http: an anonymous flood is throttled, the 429 says when to return, and the bucket refills', async () => {
  // A token must be configured for a caller to count as anonymous: with no
  // token at all every caller is "authorized" (that shape is loopback-only by
  // config rule) and gets the generous bucket.
  const opts = { apiToken: 'q'.repeat(32), rateLimit: { burst: 5, refillPerSecond: 20, maxClients: 16 } };
  await withHttp(opts, async (port, server) => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await rawRequest(port, { path: '/health' })).status);
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200], 'the burst is honoured');
    assert.ok(codes.includes(429), `then the limiter trips: ${codes.join(',')}`);
    assert.ok(server.throttledCount > 0);

    const limited = await rawRequest(port, { path: '/health' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1, 'a 429 tells the caller when to come back');

    // Rate limiting applies to /health too — the only unauthenticated route —
    // because an anonymous caller must not be able to spend this process's
    // sockets and CPU keeping a validator from answering the submitter. It is
    // also checked BEFORE auth, so a flood of wrong tokens is throttled rather
    // than answered with 401 as fast as it can arrive.
    assert.equal((await rawRequest(port, { path: '/metrics' })).status, 429, 'the bucket is per client, not per route');
    assert.equal(
      (await rawRequest(port, { path: '/status', headers: { authorization: 'Bearer wrong' } })).status,
      429,
      'a flood of guesses is throttled before it is answered',
    );

    await new Promise((r) => setTimeout(r, 300)); // 20/s => ~6 tokens
    assert.equal((await rawRequest(port, { path: '/health' })).status, 200, 'a throttle is not a ban');
  });
});

test('http: the submitter is not throttled alongside the anonymous flood it is being protected from', async () => {
  // The submitter polls every validator for every in-flight transfer on every
  // tick. Throttling it would stall signature collection — which is the outage
  // the limiter exists to prevent, arrived at from the other direction.
  const token = 'z'.repeat(32);
  await withHttp({ apiToken: token, rateLimit: { burst: 5, refillPerSecond: 20, maxClients: 16 } }, async (port) => {
    const headers = { authorization: `Bearer ${token}` };
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push((await rawRequest(port, { path: '/status', headers })).status);
    assert.ok(
      codes.every((c) => c === 200),
      `a token holder gets ${AUTHENTICATED_RATE_MULTIPLIER}x the budget: ${[...new Set(codes)].join(',')}`,
    );
    // ...and the anonymous bucket is separate, so the flood still gets stopped.
    const anon = [];
    for (let i = 0; i < 12; i++) anon.push((await rawRequest(port, { path: '/health' })).status);
    assert.ok(anon.includes(429), `the anonymous bucket is untouched by the authenticated one: ${anon.join(',')}`);
  });
});

test('http: an over-long request line, a body, and a non-GET method are all refused', async () => {
  await withHttp({}, async (port) => {
    const long = await rawRequest(port, { path: `/status?x=${'a'.repeat(4000)}` });
    assert.equal(long.status, 414, 'the request line is capped before anything parses it');

    const body = 'x'.repeat(4096);
    const withBody = await rawRequest(port, {
      path: '/status',
      headers: { 'content-length': String(body.length) },
      body,
    });
    assert.equal(withBody.status, 413, 'a read-only API refuses a body rather than draining it');

    assert.equal((await rawRequest(port, { method: 'POST', path: '/status' })).status, 405);
    assert.equal((await rawRequest(port, { method: 'DELETE', path: '/transfers' })).status, 405);
  });
});

test('http: the token bucket is a rate, not a counter', () => {
  const limiter = new TokenBucketLimiter({ burst: 3, refillPerSecond: 10, maxClients: 4 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('a', t0), true);
  assert.equal(limiter.take('a', t0), true);
  assert.equal(limiter.take('a', t0), true);
  assert.equal(limiter.take('a', t0), false, 'burst exhausted');
  assert.equal(limiter.take('b', t0), true, 'one noisy client does not starve another');
  assert.equal(limiter.take('a', t0 + 100), true, '10/s means a token every 100ms');
  assert.equal(limiter.take('a', t0 + 100), false);
  assert.equal(limiter.take('a', t0 + 10_000), true, 'never refills past the burst, and never below zero');

  // The table must not grow without bound under a spoofed-source flood.
  for (let i = 0; i < 50; i++) limiter.take(`client-${i}`, t0 + 20_000);
  assert.ok(limiter.size <= 4 + 1, `bounded at maxClients, got ${limiter.size}`);
});

// ============================================================================
// FINDING: keystore password from an unprotected environment variable
// ============================================================================

test('keystore: a password file must not be group- or world-readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmx-pw-'));
  try {
    const path = join(dir, 'pw');
    writeFileSync(path, 'correct horse battery staple\n');
    chmodSync(path, 0o644);
    assert.throws(() => readPassword(path), /must not be readable by group or other/);
    chmodSync(path, 0o400);
    assert.equal(readPassword(path), 'correct horse battery staple', 'the trailing newline is stripped, nothing else is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The asymmetry this closes: readPasswordFile() insisted on mode 0400 while the
// environment path took anything, gated behind a flag whoever wrote the unit
// file could set. There is no longer an environment path at all — and, because
// a password that reached process.env is already through /proc/<pid>/environ and
// every child, the variable being PRESENT is the refusal, not the reading of it.

test('keystore: there is no environment path for the password, with or without the old flag', () => {
  const before = { pw: process.env.FMX_RELAYER_PASSWORD, allow: process.env.FMX_RELAYER_ALLOW_ENV_PASSWORD };
  const dir = mkdtempSync(join(tmpdir(), 'fmx-pw-'));
  try {
    const file = join(dir, 'pw');
    writeFileSync(file, 'correct horse battery staple\n');
    chmodSync(file, 0o400);

    process.env.FMX_RELAYER_PASSWORD = 'in-the-environment';
    delete process.env.FMX_RELAYER_ALLOW_ENV_PASSWORD;
    assert.throws(() => readPassword(null), /FMX_RELAYER_PASSWORD is set in the environment/);
    assert.throws(() => assertNoEnvPassword(), /cannot be mode 0400/);

    // Even WITH a perfectly good 0400 file configured. The file would have been
    // used and the variable ignored, which is precisely how a leaked password
    // survives a deployment nobody thinks is leaking one.
    assert.throws(() => readPassword(file), /FMX_RELAYER_PASSWORD is set in the environment/);

    // The old escape hatch is not merely ineffective, it is itself a refusal —
    // a runbook that still exports it fails loudly instead of quietly not working.
    process.env.FMX_RELAYER_ALLOW_ENV_PASSWORD = '1';
    assert.throws(() => readPassword(file), /FMX_RELAYER_ALLOW_ENV_PASSWORD was removed/);
    delete process.env.FMX_RELAYER_PASSWORD;
    assert.throws(
      () => readPassword(file),
      /FMX_RELAYER_ALLOW_ENV_PASSWORD is set in the environment/,
      'permission to do the unsafe thing is refused even with nothing unsafe to do',
    );

    // And with a clean environment the 0400 file is still the supported path.
    delete process.env.FMX_RELAYER_ALLOW_ENV_PASSWORD;
    assert.equal(readPassword(file), 'correct horse battery staple');
    assert.throws(() => readPassword(null), /set keystore.passwordFile/, 'no file, no password, no fallback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (before.pw === undefined) delete process.env.FMX_RELAYER_PASSWORD;
    else process.env.FMX_RELAYER_PASSWORD = before.pw;
    if (before.allow === undefined) delete process.env.FMX_RELAYER_ALLOW_ENV_PASSWORD;
    else process.env.FMX_RELAYER_ALLOW_ENV_PASSWORD = before.allow;
  }
});

test('keystore: no key is loaded while a password sits in the environment, plaintext devnet key included', async () => {
  const before = process.env.FMX_RELAYER_PRIVATE_KEY;
  const beforeAllow = process.env.FMX_RELAYER_ALLOW_PLAINTEXT_KEY;
  const beforePw = process.env.FMX_RELAYER_PASSWORD;
  try {
    // The anvil path, fully permitted — and still refused, because the gate is
    // about what is in the environment, not about which key this run would use.
    process.env.FMX_RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
    process.env.FMX_RELAYER_ALLOW_PLAINTEXT_KEY = '1';
    process.env.FMX_RELAYER_PASSWORD = 'in-the-environment';
    await assert.rejects(
      () => loadKey({ path: null, passwordFile: null, expectedAddress: null }, silentLogger()),
      /FMX_RELAYER_PASSWORD is set in the environment/,
    );
  } finally {
    if (before === undefined) delete process.env.FMX_RELAYER_PRIVATE_KEY;
    else process.env.FMX_RELAYER_PRIVATE_KEY = before;
    if (beforeAllow === undefined) delete process.env.FMX_RELAYER_ALLOW_PLAINTEXT_KEY;
    else process.env.FMX_RELAYER_ALLOW_PLAINTEXT_KEY = beforeAllow;
    if (beforePw === undefined) delete process.env.FMX_RELAYER_PASSWORD;
    else process.env.FMX_RELAYER_PASSWORD = beforePw;
  }
});

/** Run the real CLI in a child process and report exit code + output. */
function runCli(args, env) {
  const clean = { ...process.env };
  delete clean.FMX_RELAYER_PASSWORD;
  delete clean.FMX_RELAYER_ALLOW_ENV_PASSWORD;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...clean, ...env },
  });
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '' };
}

// The proof the fix asks for: not "the function throws", but "the process does
// not start". Every role, before the config is even read.
test('keystore: the PROCESS refuses to start with a password in the environment', () => {
  const missingConfig = join(tmpdir(), 'fmx-does-not-exist.json');

  for (const role of ['validator', 'submitter', 'check', 'keygen']) {
    const refused = runCli(['--role', role, '--config', missingConfig], { FMX_RELAYER_PASSWORD: 'in-the-environment' });
    assert.equal(refused.status, 2, `--role ${role} must exit non-zero`);
    assert.match(refused.stderr, /refusing to start/, `--role ${role}: ${refused.stderr}`);
    assert.match(refused.stderr, /FMX_RELAYER_PASSWORD is set in the environment/);
    assert.ok(!refused.stderr.includes('in-the-environment'), 'and it never echoes the password back');
    assert.ok(!refused.stdout.includes('in-the-environment'));
  }

  // The old permission flag alone is refused too — nothing to leak yet, but a
  // deployment carrying it is one `export` away from leaking.
  const flagOnly = runCli(['--role', 'check', '--config', missingConfig], { FMX_RELAYER_ALLOW_ENV_PASSWORD: '1' });
  assert.equal(flagOnly.status, 2);
  assert.match(flagOnly.stderr, /FMX_RELAYER_ALLOW_ENV_PASSWORD is set in the environment/);

  // Control: with a clean environment the same command gets PAST the gate and
  // fails on the missing config instead. Without this, the test above would pass
  // just as happily against a binary that refuses everything.
  const clean = runCli(['--role', 'check', '--config', missingConfig], {});
  assert.notEqual(clean.status, 0);
  assert.doesNotMatch(clean.stderr, /FMX_RELAYER_PASSWORD/);
  assert.match(clean.stderr, /ENOENT|no such file/i, clean.stderr);
});

test('logger: secret-shaped keys are redacted, token ADDRESSES are not', () => {
  const lines = [];
  const log = new Logger({ level: 'info', format: 'json', sink: (l) => lines.push(l) });
  log.info('leak check', {
    password: 'hunter2',
    FMX_RELAYER_PASSWORD: 'hunter2',
    apiToken: 'bearer-value',
    peerToken: 'peer-value',
    authorization: 'Bearer nope',
    nested: { privateKey: '0xdeadbeef', mnemonic: 'twelve words here' },
    token: '0x0000000000000000000000000000000000000000',
    recipient: '0x1111111111111111111111111111111111111111',
  });
  const output = lines.join('');
  assert.ok(!/hunter2|bearer-value|peer-value|0xdeadbeef|twelve words|Bearer nope/.test(output), `secret leaked: ${output}`);
  assert.equal((output.match(/\[redacted\]/g) ?? []).length, 7);
  assert.match(output, /0x0000000000000000000000000000000000000000/, 'a token address is operational data, not a secret');
  assert.match(output, /0x1111111111111111111111111111111111111111/);
});

// ============================================================================
// FINDING: 24h capacity consumed but not released on the reject paths
// ============================================================================

/** Minimal chain doubles: verify.ts only needs config + these four reads. */
function verifyFixture({ processed = false, paused = false } = {}) {
  const transfer = {
    srcChainId: CHAIN_A,
    dstChainId: CHAIN_B,
    nonce: 7,
    srcToken: ZeroAddress,
    dstToken: getAddress(`0x${'22'.repeat(20)}`),
    sender: getAddress(`0x${'33'.repeat(20)}`),
    recipient: getAddress(`0x${'44'.repeat(20)}`),
    amount: 5n * 10n ** 18n,
  };
  const cfg = parse({});
  const chainCfg = (id) => cfg.chains.find((c) => c.chainId === id);
  const dstCfg = chainCfg(CHAIN_B);
  const chains = new Map([
    [CHAIN_A, { config: chainCfg(CHAIN_A) }],
    [
      CHAIN_B,
      {
        config: dstCfg,
        verifyDomainSeparator: async () => ({ ok: true, onChain: null, reason: null }),
        // The registry is read from return data now (ChainClient.readTokenConfig),
        // not off a decoded fragment, so the double lives beside bridge() rather
        // than inside it.
        readTokenConfig: async () => ({
          kind: 2n,
          paused: false,
          remoteChainId: BigInt(CHAIN_A),
          remoteToken: transfer.srcToken,
          maxPerTransfer: 10n ** 21n,
          dailyCap: 10n ** 22n,
        }),
        bridge: () => ({
          processed: async () => processed,
          paused: async () => paused,
          hashTransfer: async () => digestFor(transfer, dstCfg.bridgeAddress),
        }),
      },
    ],
  ]);
  const windows = new Map();
  const limiter = new VolumeLimiter({
    getWindow: (k) => windows.get(k) ?? null,
    putWindow: (w) => windows.set(w.key, { ...w }),
  });
  const stored = {
    transferId: transferIdOf(transfer),
    transfer,
    fee: 0n,
    srcBlockNumber: 10,
    srcBlockHash: `0x${'ab'.repeat(32)}`,
    srcTxHash: `0x${'cd'.repeat(32)}`,
    srcLogIndex: 0,
    status: 'confirmed',
    reason: null,
    firstSeenAt: Date.now(),
    confirmedAt: Date.now(),
    executedAt: null,
    executedTxHash: null,
    updatedAt: Date.now(),
  };
  const ctx = { cfg, chains, limiter, alerts: silentAlerter(cfg), log: silentLogger() };
  return { ctx, stored, transfer, limiter };
}

test('capacity: a verified transfer consumes both windows and REPORTS what it consumed', async () => {
  const { ctx, stored, transfer, limiter } = verifyFixture();
  const outKey = windowKey(transfer.srcChainId, transfer.srcToken, 'out');
  const inKey = windowKey(transfer.dstChainId, transfer.dstToken, 'in');

  // Read the windows as of BEFORE the call: the bucket drains linearly and
  // continuously (no calendar edge to sit on and spend the cap twice), so a
  // reading taken a few milliseconds later is legitimately a few wei lower.
  const t = Date.now();
  const result = await verifyForSigning(ctx, stored);
  assert.equal(result.ok, true, result.reason ?? '');
  assert.equal(limiter.usage(outKey, t), transfer.amount);
  assert.equal(limiter.usage(inKey, t), transfer.amount);
  assert.deepEqual(result.consumed, { outKey, inKey, amount: transfer.amount });
});

test('capacity: a transfer rejected AFTER verification gives its capacity back', async () => {
  const { ctx, stored, transfer, limiter } = verifyFixture();
  const outKey = windowKey(transfer.srcChainId, transfer.srcToken, 'out');
  const inKey = windowKey(transfer.dstChainId, transfer.dstToken, 'in');

  const t = Date.now();
  const result = await verifyForSigning(ctx, stored);
  assert.equal(limiter.usage(outKey, t), transfer.amount, 'consumed before signing, as designed');

  // This is the self-check-failed / digest-changed branch in validator.ts, and
  // the "anything threw after consumption" case with it.
  releaseCapacity(ctx, result.consumed);

  assert.equal(limiter.usage(outKey), 0n, 'the outbound window is whole again');
  assert.equal(limiter.usage(inKey), 0n, 'and the inbound one');
});

test('capacity: repeated reject-and-release does not ratchet the budget down', async () => {
  // The lived consequence of the bug: a validator that rejects a few transfers
  // quietly loses budget and starts refusing legitimate ones. 24 rejections of
  // 5 FMX against a 100 FMX cap would have exhausted it permanently.
  const { ctx, stored, transfer, limiter } = verifyFixture();
  const outKey = windowKey(transfer.srcChainId, transfer.srcToken, 'out');
  for (let i = 0; i < 40; i++) {
    const result = await verifyForSigning(ctx, stored);
    assert.equal(result.ok, true, `round ${i} still fits inside the daily cap`);
    releaseCapacity(ctx, result.consumed);
  }
  assert.equal(limiter.usage(outKey), 0n, '40 rejected transfers cost this validator nothing');

  const final = await verifyForSigning(ctx, stored);
  assert.equal(final.ok, true, 'and a legitimate transfer still gets signed afterwards');
});

test('capacity: a dry-run verification consumes nothing to release', async () => {
  const { ctx, stored, transfer, limiter } = verifyFixture();
  const result = await verifyForSigning(ctx, stored, false);
  assert.equal(result.ok, true);
  assert.equal(result.consumed, null);
  assert.equal(limiter.usage(windowKey(transfer.srcChainId, transfer.srcToken, 'out')), 0n);
});
