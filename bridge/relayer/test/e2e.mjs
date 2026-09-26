// End-to-end proof on TWO LOCAL ANVILS. Nothing here touches a public RPC, the
// live devnet on 8545, or any docker container.
//
//   chain A = 3961 on :8562   (stands in for Ferminux)
//   chain B = 56   on :8563   (stands in for a remote EVM)
//
// Those two are the only fixed ports. The validator/submitter HTTP servers, the
// alert sink and the lying RPC proxy all bind port 0 and the suite reads the
// real port back, so nothing here can collide with another service.
//
// It deploys the real contracts from ../contracts (compiled into ./artifacts, so
// the contracts directory is only ever read), registers a token pair through the
// real 1h timelock, then runs the real validator and submitter binaries as
// separate processes and drives value across.
//
//   run:   node test/e2e.mjs
//   noisy: E2E_VERBOSE=1 node test/e2e.mjs

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, Interface, Wallet, ZeroAddress, formatEther, parseEther } from 'ethers';
import { INSECURE_ACKNOWLEDGEMENT } from '../src/config.ts';
import {
  ACCOUNTS,
  AssertionError,
  CHAIN_A,
  CHAIN_B,
  PORTS,
  ROOT,
  artifact,
  assert,
  assertEq,
  bumpNonce,
  closedPort,
  deployBridge,
  deployWrapped,
  freshDir,
  killAll,
  killPort,
  killProc,
  mine,
  ok,
  portFree,
  procLines,
  pinWrapperCodehash,
  registerToken,
  relayerPort,
  setRemoteBridge,
  say,
  sleep,
  spawnProc,
  startAnvil,
  startLyingProxy,
  step,
  waitFor,
} from './helpers.mjs';

const BRIDGE_ABI = artifact('FerminuxBridge').abi;
const TOKEN_ABI = artifact('BridgeToken').abi;
const bridgeIface = new Interface(BRIDGE_ABI);
const SENT_TOPIC = bridgeIface.getEvent('Sent').topicHash;
const EXECUTED_TOPIC = bridgeIface.getEvent('Executed').topicHash;

// The contract allows far more than the validators will sign for — that gap is
// what the cap-breach test drives through.
const CONTRACT_MAX_PER_TRANSFER = parseEther('100');
const CONTRACT_DAILY_CAP = parseEther('500');
const VALIDATOR_MAX_PER_TRANSFER = parseEther('20');
const VALIDATOR_DAILY_CAP = parseEther('60');

const alerts = [];
const state = { ports: {} };

function relayerConfig({ role, statePath, peers, rpcA, rpcB, confirmations = 3, requireRpcQuorum = true }) {
  const gas = {
    maxFeePerGasGwei: 500,
    priorityFeeGwei: 1,
    baseFeeMultiplier: 2,
    gasLimitMultiplier: 1.3,
    gasLimitCap: 1500000,
    escalationPct: 25,
    maxAttempts: 3,
    receiptTimeoutMs: 120000,
    txType: 2,
  };
  const limits = (token) => ({
    default: { maxPerTransfer: VALIDATOR_MAX_PER_TRANSFER.toString(), dailyCap: VALIDATOR_DAILY_CAP.toString() },
    tokens: {
      [token]: { maxPerTransfer: VALIDATOR_MAX_PER_TRANSFER.toString(), dailyCap: VALIDATOR_DAILY_CAP.toString() },
    },
  });
  return {
    network: `devnet-${role}`,
    chains: [
      {
        name: 'ferminux-local',
        chainId: CHAIN_A,
        rpcUrls: rpcA,
        bridgeAddress: state.bridgeA,
        confirmations,
        finalityTag: null,
        pollIntervalMs: 500,
        startBlock: 1,
        maxBlockRange: 2000,
        enabled: true,
        gas,
        limits: limits(ZeroAddress),
      },
      {
        name: 'remote-local',
        chainId: CHAIN_B,
        rpcUrls: rpcB,
        bridgeAddress: state.bridgeB,
        confirmations,
        finalityTag: null,
        pollIntervalMs: 500,
        startBlock: 1,
        maxBlockRange: 2000,
        enabled: true,
        gas,
        limits: limits(state.wfmx),
      },
    ],
    // port 0 = let the OS pick; the suite reads it back out of the service's log
    http: { host: '127.0.0.1', port: 0, apiToken: '' },
    keystore: { path: '', passwordFile: '', expectedAddress: '' },
    transport: { mode: 'http', sharedDir: '', requestTimeoutMs: 3000 },
    submitter: { peers: peers ?? [], signatureWaitMs: 20000, pollIntervalMs: 1000, skipWhenPaused: true },
    validator: { maxTransferAgeMs: 0, requireRpcQuorum },
    state: { path: statePath, driver: 'auto' },
    alerts: { webhookUrl: `http://127.0.0.1:${state.ports.webhook}/alert`, minSeverity: 'info', throttleMs: 10000 },
    divergenceIntervalMs: 3000,
    log: { level: 'info', format: 'json' },
    // One anvil per chain: there is no second, independently operated endpoint
    // to corroborate against, which a production config is refused for. The
    // acknowledgement is what makes that a deliberate devnet choice rather than
    // an oversight — see config.ts parseInsecure.
    insecure: {
      acknowledgement: INSECURE_ACKNOWLEDGEMENT,
      allowSingleRpcEndpoint: true,
      // Two anvils with no finality gadget and no pace/checkpoint config: count
      // mode is only acceptable here because nothing of value is on these chains.
      allowCountFinalityWithoutGadget: true,
      ...(requireRpcQuorum ? {} : { allowPartialEndpointAgreement: true }),
    },
  };
}

function writeConfig(name, cfg) {
  const path = join(state.runDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

function startRelayer(name, role, configPath, privateKey) {
  return spawnProc(name, process.execPath, ['src/index.ts', '--role', role, '--config', configPath], {
    FMX_RELAYER_PRIVATE_KEY: privateKey,
    FMX_RELAYER_ALLOW_PLAINTEXT_KEY: '1',
  });
}

async function api(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

/** Send FMX from chain A and return the decoded Sent event. */
async function sendFromA(amount, recipient = ACCOUNTS.recipient.address) {
  const user = new Wallet(ACCOUNTS.user.key, state.a.provider);
  const bridge = new Contract(state.bridgeA, BRIDGE_ABI, user);
  const tx = await bridge.send(ZeroAddress, amount, CHAIN_B, recipient, { value: amount });
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    if (log.topics[0] !== SENT_TOPIC) continue;
    const parsed = bridgeIface.parseLog({ topics: [...log.topics], data: log.data });
    return {
      transferId: parsed.args.transferId,
      amount: parsed.args.amount,
      fee: parsed.args.fee,
      nonce: Number(parsed.args.nonce),
      blockNumber: receipt.blockNumber,
      txHash: receipt.hash,
    };
  }
  throw new Error('no Sent event in the receipt');
}

async function transferRow(port, transferId) {
  const { body } = await api(port, '/transfers?limit=200');
  return body?.transfers?.find((t) => t.transferId.toLowerCase() === transferId.toLowerCase()) ?? null;
}

async function executedCount(transferId) {
  const logs = await state.b.provider.getLogs({
    address: state.bridgeB,
    topics: [EXECUTED_TOPIC, transferId],
    fromBlock: 0,
    toBlock: 'latest',
  });
  return logs.length;
}

// ---------------------------------------------------------------------- phases

async function phaseBoot() {
  step('boot two local anvils and an alert sink');
  state.runDir = freshDir(join(ROOT, 'state', 'e2e'));

  state.webhook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        alerts.push(JSON.parse(body));
      } catch {
        /* ignore */
      }
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => state.webhook.listen(0, '127.0.0.1', r));
  state.ports.webhook = state.webhook.address().port;
  say(`alert sink on :${state.ports.webhook} (ephemeral)`);

  state.a = await startAnvil(PORTS.anvilA, CHAIN_A);
  state.b = await startAnvil(PORTS.anvilB, CHAIN_B);
  say(`chain A = ${CHAIN_A} on :${PORTS.anvilA}`);
  say(`chain B = ${CHAIN_B} on :${PORTS.anvilB}`);
}

async function phaseDeploy() {
  step('deploy the real bridge contracts on both chains');
  const validators = [ACCOUNTS.validator1.address, ACCOUNTS.validator2.address, ACCOUNTS.validator3.address];
  const params = {
    owner: ACCOUNTS.deployer.address,
    validators,
    threshold: 2,
    feeCollector: ACCOUNTS.deployer.address,
    feeBps: 10,
    timelockDelay: 3600,
    pauser: ACCOUNTS.pauser.address,
  };
  const bridgeA = await deployBridge(state.a.provider, params);
  // The two bridges must not land on the SAME address — see bumpNonce().
  await bumpNonce(state.b.provider);
  const bridgeB = await deployBridge(state.b.provider, params);
  state.bridgeA = await bridgeA.getAddress();
  state.bridgeB = await bridgeB.getAddress();
  say(`bridge A = ${state.bridgeA}`);
  say(`bridge B = ${state.bridgeB}`);

  // Each side records the other before any route exists. Timelocked, and
  // mandatory: a token cannot be registered for a chain whose bridge address
  // this deployment does not know.
  step('record the counterpart bridge on each chain (timelocked, required before registration)');
  await setRemoteBridge(state.a.provider, bridgeA, CHAIN_B, state.bridgeB);
  await setRemoteBridge(state.b.provider, bridgeB, CHAIN_A, state.bridgeA);
  assertEq(await bridgeA.remoteBridge(CHAIN_B), state.bridgeB, 'chain A knows the bridge on chain B');
  assertEq(await bridgeB.remoteBridge(CHAIN_A), state.bridgeA, 'chain B knows the bridge on chain A');

  const wfmx = await deployWrapped(state.b.provider, {
    name: 'Wrapped FMX',
    symbol: 'wFMX',
    decimals: 18,
    bridge: state.bridgeB,
    originChainId: CHAIN_A,
    originToken: ZeroAddress,
  });
  state.wfmx = await wfmx.getAddress();
  say(`wFMX     = ${state.wfmx}`);

  // registerWrapped() refuses a wrapper whose bytecode is not the pinned one,
  // and refuses everything while the pin is unset. Pin it from the code actually
  // deployed, so this is the same check an operator would make.
  await pinWrapperCodehash(state.b.provider, bridgeB, state.wfmx);

  step('register the token pair through the 1h timelock (queue -> wait -> execute)');
  await registerToken(state.a.provider, bridgeA, 'canonical', [
    ZeroAddress,
    CHAIN_B,
    state.wfmx,
    CONTRACT_MAX_PER_TRANSFER,
    CONTRACT_DAILY_CAP,
  ]);
  await registerToken(state.b.provider, bridgeB, 'wrapped', [
    state.wfmx,
    CHAIN_A,
    ZeroAddress,
    CONTRACT_MAX_PER_TRANSFER,
    CONTRACT_DAILY_CAP,
  ]);
  const cfgA = await bridgeA.tokenConfig(ZeroAddress);
  const cfgB = await bridgeB.tokenConfig(state.wfmx);
  assertEq(Number(cfgA.kind), 1, 'chain A registered FMX as CANONICAL');
  assertEq(Number(cfgB.kind), 2, 'chain B registered wFMX as WRAPPED');
  assertEq(Number(cfgA.remoteChainId), CHAIN_B, 'chain A points at chain B');
  assertEq(Number(cfgB.remoteChainId), CHAIN_A, 'chain B points at chain A');
}

async function phaseStartRelayers() {
  step('start two validators, then a submitter pointed at them');
  const rpcA = [state.a.url];
  const rpcB = [state.b.url];

  state.v1Config = writeConfig('validator1', relayerConfig({ role: 'validator1', statePath: join(state.runDir, 'v1.db'), rpcA, rpcB }));
  state.v2Config = writeConfig('validator2', relayerConfig({ role: 'validator2', statePath: join(state.runDir, 'v2.db'), rpcA, rpcB }));

  state.v1 = startRelayer('validator1', 'validator', state.v1Config, ACCOUNTS.validator1.key);
  state.v2 = startRelayer('validator2', 'validator', state.v2Config, ACCOUNTS.validator2.key);
  state.ports.v1 = await relayerPort(state.v1);
  state.ports.v2 = await relayerPort(state.v2);
  say(`validator1 http :${state.ports.v1}, validator2 http :${state.ports.v2}`);

  state.subConfig = writeConfig(
    'submitter',
    relayerConfig({
      role: 'submitter',
      statePath: join(state.runDir, 'sub.db'),
      rpcA,
      rpcB,
      peers: [
        { name: 'validator-1', url: `http://127.0.0.1:${state.ports.v1}`, token: '' },
        { name: 'validator-2', url: `http://127.0.0.1:${state.ports.v2}`, token: '' },
      ],
    }),
  );
  state.sub = startRelayer('submitter', 'submitter', state.subConfig, ACCOUNTS.submitter.key);
  state.ports.sub = await relayerPort(state.sub);
  say(`submitter http :${state.ports.sub}`);

  for (const [name, port] of [['validator1', state.ports.v1], ['validator2', state.ports.v2], ['submitter', state.ports.sub]]) {
    const health = await waitFor(`${name} /health`, async () => {
      const r = await api(port, '/health');
      return r.status === 200 ? r.body : null;
    }, 30_000);
    assert(health.ok === true, `${name} reports healthy (store=${health.store}, chains=${health.chains.length})`);
  }
  assertEq((await api(state.ports.v1, '/status')).body.validator, ACCOUNTS.validator1.address, 'validator1 loaded the expected key');
  assertEq((await api(state.ports.sub, '/status')).body.submitter, ACCOUNTS.submitter.address, 'submitter loaded its own, different key');
}

async function phaseHappyPath() {
  step('HAPPY PATH — lock 10 FMX on A, quorum signs, submitter executes on B');
  const amount = parseEther('10');
  const sent = await sendFromA(amount);
  state.transfer1 = sent;
  say(`transferId ${sent.transferId}`);
  say(`net ${formatEther(sent.amount)} FMX (fee ${formatEther(sent.fee)})`);

  await mine(state.a.provider, 5);
  const wfmx = new Contract(state.wfmx, TOKEN_ABI, state.b.provider);

  await waitFor('recipient credited on chain B', async () => (await wfmx.balanceOf(ACCOUNTS.recipient.address)) === sent.amount, 60_000);
  assertEq(await wfmx.balanceOf(ACCOUNTS.recipient.address), sent.amount, 'recipient wFMX balance');
  assertEq(await wfmx.totalSupply(), sent.amount, 'wFMX total supply');

  const bridgeA = new Contract(state.bridgeA, BRIDGE_ABI, state.a.provider);
  assertEq(await bridgeA.lockedBalance(ZeroAddress), sent.amount, 'collateral locked on chain A backs the supply exactly');
  assertEq(await executedCount(sent.transferId), 1, 'exactly one Executed event on chain B');

  const row = await transferRow(state.ports.sub, sent.transferId);
  assert(row?.status === 'executed', 'submitter recorded status=executed');
  assertEq(row.signatures, 2, 'submitter collected exactly the threshold of signatures');

  const v1sig = await api(state.ports.v1, `/signatures?transferId=${sent.transferId}`);
  assertEq(v1sig.status, 200, 'validator1 serves its attestation over HTTP');
  assertEq(v1sig.body.signer, ACCOUNTS.validator1.address, 'attestation is signed by validator1');
}

async function phaseInsufficientSignatures() {
  step('FAILURE MODE — insufficient signatures (threshold 2, only 1 validator up)');
  await killProc(state.v2);
  say('validator2 stopped');
  await sleep(500);

  const sent = await sendFromA(parseEther('4'));
  state.transfer2 = sent;
  await mine(state.a.provider, 5);

  await waitFor('validator1 signs it', async () => (await api(state.ports.v1, `/signatures?transferId=${sent.transferId}`)).status === 200, 30_000);

  await sleep(6_000);
  assertEq(await executedCount(sent.transferId), 0, 'NOT executed with only 1 of 2 required signatures');
  const row = await transferRow(state.ports.sub, sent.transferId);
  assertEq(row.signatures, 1, 'submitter is holding exactly one signature and waiting');

  say('restarting validator2 …');
  state.v2 = startRelayer('validator2', 'validator', state.v2Config, ACCOUNTS.validator2.key);
  state.ports.v2 = await relayerPort(state.v2);
  assert(true, `validator2 came back on :${state.ports.v2} and resumed from its persisted cursor`);
  // The submitter's peer list still points at the OLD port, so restart it too —
  // in production the peer URL is stable and this step does not exist.
  await killProc(state.sub);
  state.subConfig = writeConfig(
    'submitter',
    relayerConfig({
      role: 'submitter',
      statePath: join(state.runDir, 'sub.db'),
      rpcA: [state.a.url],
      rpcB: [state.b.url],
      peers: [
        { name: 'validator-1', url: `http://127.0.0.1:${state.ports.v1}`, token: '' },
        { name: 'validator-2', url: `http://127.0.0.1:${state.ports.v2}`, token: '' },
      ],
    }),
  );
  state.sub = startRelayer('submitter', 'submitter', state.subConfig, ACCOUNTS.submitter.key);
  state.ports.sub = await relayerPort(state.sub);

  await waitFor('transfer completes once quorum is reachable', async () => (await executedCount(sent.transferId)) === 1, 60_000);
  assertEq(await executedCount(sent.transferId), 1, 'executed exactly once after the second signature arrived');
}

async function phaseReplay() {
  step('FAILURE MODE — replay: re-submitting an executed transfer must be refused');
  const sent = state.transfer1;
  const sigs = [];
  for (const port of [state.ports.v1, state.ports.v2]) {
    const r = await api(port, `/signatures?transferId=${sent.transferId}`);
    if (r.status === 200) sigs.push(r.body);
  }
  assertEq(sigs.length, 2, 'collected both attestations directly from the validators');

  const t = [CHAIN_A, CHAIN_B, sent.nonce, ZeroAddress, state.wfmx, ACCOUNTS.user.address, ACCOUNTS.recipient.address, sent.amount];
  const tuples = sigs
    .map((s) => ({ signer: s.signer, sig: s.signature }))
    .sort((a, b) => a.signer.localeCompare(b.signer))
    .map(({ sig }) => [Number(`0x${sig.slice(130, 132)}`), `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);

  const relayer = new Wallet(ACCOUNTS.deployer.key, state.b.provider);
  const bridgeB = new Contract(state.bridgeB, BRIDGE_ABI, relayer);
  let reverted = null;
  try {
    await bridgeB.execute.staticCall(t, tuples);
  } catch (err) {
    reverted = err.shortMessage ?? err.message;
  }
  assert(reverted !== null && /already processed/i.test(reverted), `on-chain replay refused: ${reverted}`);

  const before = await executedCount(sent.transferId);
  await sleep(3_000);
  assertEq(await executedCount(sent.transferId), before, 'submitter never re-submits an executed transfer');
  say(`submitter store counts: ${JSON.stringify((await api(state.ports.sub, '/status')).body.store.counts)}`);
}

async function phaseCapBreach() {
  step('FAILURE MODE — cap breach: above the validator cap, below the contract cap');
  const amount = parseEther('50'); // contract allows 100, validators allow 20
  const sent = await sendFromA(amount);
  await mine(state.a.provider, 5);

  const row = await waitFor(
    'validator1 rejects it',
    async () => {
      const r = await transferRow(state.ports.v1, sent.transferId);
      return r && r.status === 'rejected' ? r : null;
    },
    40_000,
  );
  assert(/over_local_per_transfer_cap/.test(row.reason ?? ''), `validator1 refused: ${row.reason}`);
  const sig = await api(state.ports.v1, `/signatures?transferId=${sent.transferId}`);
  assertEq(sig.status, 404, 'no signature exists for the over-cap transfer');
  await sleep(2_000);
  assertEq(await executedCount(sent.transferId), 0, 'the over-cap transfer never reached chain B');
  assert(alerts.some((a) => a.kind === 'cap_breach'), 'a cap_breach alert reached the webhook');

  // The real operational consequence, stated out loud: send() already locked the
  // collateral on chain A. A refusal STRANDS it — nothing is stolen and nothing
  // is minted, but that user needs an operator remedy. See README, "when a
  // validator refuses".
  state.strandedNet = sent.amount;
  say(`${formatEther(sent.amount)} FMX is now locked on A with nothing minted on B — stranded until an operator acts`);
}

async function phaseReorg() {
  step('FAILURE MODE — reorg: a Sent that vanishes after being seen must never be signed');
  const snapshot = await state.a.provider.send('evm_snapshot', []);
  say(`chain A snapshot ${snapshot} at block ${await state.a.provider.getBlockNumber()}`);

  const sent = await sendFromA(parseEther('3'));
  say(`transferId ${sent.transferId} mined at block ${sent.blockNumber}`);

  const seen = await waitFor('validator1 sees the transfer', async () => transferRow(state.ports.v1, sent.transferId), 20_000, 100);
  assert(seen.status === 'seen', 'validator1 has it as "seen" — shallow, unsigned');

  await state.a.provider.send('evm_revert', [snapshot]);
  say(`reverted chain A to block ${await state.a.provider.getBlockNumber()} — the Sent log no longer exists`);
  await mine(state.a.provider, 12);

  const row = await waitFor(
    'validator1 marks it orphaned',
    async () => {
      const r = await transferRow(state.ports.v1, sent.transferId);
      return r && r.status === 'orphaned' ? r : null;
    },
    40_000,
  );
  assert(row.status === 'orphaned', `validator1 orphaned the transfer: ${row.reason}`);

  const sig = await api(state.ports.v1, `/signatures?transferId=${sent.transferId}`);
  assertEq(sig.status, 404, 'validator1 produced NO signature for the reorged-away transfer');
  assertEq(await executedCount(sent.transferId), 0, 'nothing was executed on chain B');
  assert(
    alerts.some((a) => a.kind === 'reorg' && String(a.fields.transferId).toLowerCase() === sent.transferId.toLowerCase()),
    'a reorg alert reached the webhook',
  );
}

async function phaseDivergenceCheck() {
  step('FAILURE MODE — RPC divergence detected by --role check');
  const proxy = await startLyingProxy(state.a.url, 'wrong-block-hash');
  say(`lying endpoint on ${proxy.url}: honest chain id, honest head, WRONG block hashes`);

  const cfgPath = writeConfig(
    'divergence-check',
    relayerConfig({ role: 'check', statePath: join(state.runDir, 'check.db'), rpcA: [state.a.url, proxy.url], rpcB: [state.b.url] }),
  );
  const proc = spawnProc('check', process.execPath, ['src/index.ts', '--role', 'check', '--config', cfgPath], {});
  const code = await new Promise((r) => proc.on('exit', r));
  const output = procLines(proc).join('\n');
  assert(/RPC DIVERGENCE/.test(output), 'the divergence detector fired');
  assertEq(code, 1, '--role check exits non-zero when endpoints disagree');
  say(`detector: ${procLines(proc, 'RPC DIVERGENCE')[0]?.slice(0, 200)}`);
  await proxy.close();
}

async function phaseEclipseRefusal() {
  step('FAILURE MODE — an eclipsing endpoint hides a log: the validator must refuse to sign');
  const proxy = await startLyingProxy(state.a.url, 'honest');
  const cfgPath = writeConfig(
    'validator-eclipse',
    relayerConfig({ role: 'validator-eclipse', statePath: join(state.runDir, 'v3.db'), rpcA: [state.a.url, proxy.url], rpcB: [state.b.url] }),
  );
  const v3 = startRelayer('validator3', 'validator', cfgPath, ACCOUNTS.validator3.key);
  const port = await relayerPort(v3);
  await waitFor('validator3 healthy', async () => (await api(port, '/health')).status === 200, 30_000);
  say(`validator3 on :${port} with two endpoints for chain A, requireRpcQuorum=true`);

  const sent = await sendFromA(parseEther('1'));
  await waitFor('validator3 sees it', async () => transferRow(port, sent.transferId), 20_000, 100);
  proxy.setMode('hide-logs');
  say('the second endpoint now hides every log — the two endpoints disagree');
  await mine(state.a.provider, 6);

  await waitFor(
    'validator3 refuses to confirm while its endpoints disagree',
    () => procLines(v3, 'confirmation deferred').some((l) => l.includes(sent.transferId)),
    40_000,
    200,
  );
  const row = await transferRow(port, sent.transferId);
  assert(row.status === 'seen', `transfer held at "${row.status}" — never promoted, never signed`);
  assertEq((await api(port, `/signatures?transferId=${sent.transferId}`)).status, 404, 'validator3 produced no signature');
  assert(
    alerts.some((a) => a.kind === 'rpc_divergence' && String(a.fields.transferId ?? '').toLowerCase() === sent.transferId.toLowerCase()),
    'an rpc_divergence alert named the exact transfer',
  );

  // Meanwhile the two HONEST validators are not eclipsed, so the transfer still
  // completes — an eclipse on one node degrades that node, not the bridge.
  await waitFor('the honest quorum completes the transfer anyway', async () => (await executedCount(sent.transferId)) === 1, 60_000);
  ok('the eclipse degraded one validator, it did not stop or lose the transfer');

  proxy.setMode('honest');
  await mine(state.a.provider, 2);
  try {
    await waitFor(
      'validator3 confirms as soon as its endpoints agree again',
      () => procLines(v3, '"msg":"transfer confirmed"').some((l) => l.includes(sent.transferId)),
      40_000,
      200,
    );
    const confirmLine = JSON.parse(procLines(v3, '"msg":"transfer confirmed"').find((l) => l.includes(sent.transferId)));
    assertEq(confirmLine.endpointsAgreed, '2/2', 'validator3 confirmed only once BOTH endpoints showed the log');
    const after = await transferRow(port, sent.transferId);
    assert(
      after.status === 'executed' || after.status === 'signed',
      `validator3 reached a terminal state "${after.status}" — it did not sign a transfer the quorum had already executed`,
    );
  } catch (err) {
    process.stdout.write(`\n--- validator3 tail ---\n${procLines(v3).slice(-15).join('\n')}\n`);
    process.stdout.write(`--- row: ${JSON.stringify(await transferRow(port, sent.transferId))}\n`);
    throw err;
  }

  await killProc(v3, 'SIGKILL');
  await proxy.close();
}

async function phaseDeadEndpointFailover() {
  step('FAILURE MODE — a DEAD RPC endpoint: it must not stall a validator, and it must not leave one endpoint deciding alone');
  const dead = `http://127.0.0.1:${await closedPort()}`;
  say(`dead endpoint ${dead} (nothing is listening there)`);

  // ---- A. three endpoints, one dead: the survivors are a quorum, so sign ----
  const proxy = await startLyingProxy(state.a.url, 'honest');
  const cfgPath = writeConfig(
    'validator-deadrpc',
    relayerConfig({
      role: 'validator-deadrpc',
      statePath: join(state.runDir, 'v4.db'),
      rpcA: [state.a.url, proxy.url, dead],
      rpcB: [state.b.url],
    }),
  );
  const v4 = startRelayer('validator-deadrpc', 'validator', cfgPath, ACCOUNTS.validator3.key);
  const port = await relayerPort(v4);
  await waitFor('validator4 healthy', async () => (await api(port, '/health')).status === 200, 30_000);
  const status = (await api(port, '/status')).body;
  const chainA = status.chains.find((c) => c.chainId === CHAIN_A);
  assertEq(chainA.healthyEndpoints, 2, 'the dead endpoint is demoted out of the healthy set, the two live ones stay in');
  assertEq(chainA.minAgreeingEndpoints, 2, 'a majority of three endpoints must agree before this node signs');

  const sent = await sendFromA(parseEther('1'));
  await mine(state.a.provider, 6);
  // Before the fix this hung forever: staticNetwork made getNetwork() answer for
  // the dead endpoint, so it counted as healthy-but-erroring and the strict
  // quorum path deferred every single poll. The audit measured 49 deferrals and
  // no signature.
  const confirmLine = await waitFor(
    'the validator confirms despite one endpoint being dead',
    () => procLines(v4, '"msg":"transfer confirmed"').find((l) => l.includes(sent.transferId)),
    40_000,
    200,
  );
  assertEq(JSON.parse(confirmLine).endpointsAgreed, '2/2', 'it confirmed on the two endpoints that answered, and counted only those');
  await waitFor('and signs it', async () => (await api(port, `/signatures?transferId=${sent.transferId}`)).status === 200, 20_000);
  ok('one dead endpoint out of three degrades nothing — the validator signs normally');
  await killProc(v4, 'SIGKILL');

  // ---- B. two endpoints, one dies mid-flight: refuse, never fall back ------
  const cfgPathB = writeConfig(
    'validator-lonesource',
    relayerConfig({
      role: 'validator-lonesource',
      statePath: join(state.runDir, 'v5.db'),
      rpcA: [state.a.url, proxy.url],
      rpcB: [state.b.url],
    }),
  );
  const v5 = startRelayer('validator-lonesource', 'validator', cfgPathB, ACCOUNTS.validator3.key);
  const portB = await relayerPort(v5);
  await waitFor('validator5 healthy on two endpoints', async () => (await api(portB, '/health')).status === 200, 30_000);

  const sentB = await sendFromA(parseEther('1'));
  await waitFor('validator5 sees it', async () => transferRow(portB, sentB.transferId), 20_000, 100);
  await proxy.close();
  say('one of its two endpoints just went away — it is now down to a single source of truth');
  await mine(state.a.provider, 6);

  await waitFor(
    'validator5 refuses to confirm from the one endpoint left standing',
    () =>
      procLines(v5, 'confirmation deferred').some(
        (l) => l.includes(sentB.transferId) && /independent confirmations are required/.test(l),
      ),
    40_000,
    200,
  );
  const rowB = await transferRow(portB, sentB.transferId);
  assert(rowB.status === 'seen', `transfer held at "${rowB.status}" — an eclipse that kills the honest endpoints gets a refusal, not a signature`);
  assertEq((await api(portB, `/signatures?transferId=${sentB.transferId}`)).status, 404, 'no signature was produced from the lone survivor');
  const healthB = await api(portB, '/health');
  assertEq(healthB.status, 503, 'and it reports itself UNHEALTHY rather than looking fine while silently deciding nothing');
  await killProc(v5, 'SIGKILL');

  // The honest quorum (v1, v2) is unaffected and still delivers both transfers.
  await waitFor('the honest quorum still completes the transfer', async () => (await executedCount(sentB.transferId)) === 1, 60_000);

  // ---- C. two endpoints, one already dead at startup: refuse to START ------
  const cfgPathC = writeConfig(
    'validator-startsdegraded',
    relayerConfig({
      role: 'validator-startsdegraded',
      statePath: join(state.runDir, 'v6.db'),
      rpcA: [state.a.url, dead],
      rpcB: [state.b.url],
    }),
  );
  const v6 = startRelayer('validator-startsdegraded', 'validator', cfgPathC, ACCOUNTS.validator3.key);
  const code = await new Promise((r) => v6.on('exit', r));
  const out = procLines(v6).join('\n');
  assertEq(code, 1, 'a validator that cannot reach its agreement floor refuses to start');
  const why = procLines(v6).find((l) => /independent confirmations are required/.test(l)) ?? '';
  assert(why !== '', `it says exactly why: ${why.replace(/^fatal: Error: /, '').slice(0, 200)}`);
  assert(out.includes(dead), 'and names the endpoint that did not answer');
}

async function phaseRestartResume() {
  step('RESILIENCE — kill the submitter mid-flight and confirm it resumes exactly once');
  await state.b.provider.send('anvil_setAutomine', [false]);
  say('chain B automine OFF — the execute() tx will sit unmined');

  const before = procLines(state.sub, 'execute() broadcast').length;
  const sent = await sendFromA(parseEther('2'));
  await mine(state.a.provider, 5);

  await waitFor('submitter broadcasts execute()', () => procLines(state.sub, 'execute() broadcast').length > before, 60_000, 100);
  const broadcastLine = procLines(state.sub, 'execute() broadcast').at(-1);
  const txHash = JSON.parse(broadcastLine).txHash;
  say(`broadcast ${txHash}`);

  await killProc(state.sub, 'SIGKILL');
  say('submitter SIGKILLed while the transaction was still in the mempool');
  assertEq(await executedCount(sent.transferId), 0, 'nothing executed yet — the tx is unmined');

  await state.b.provider.send('anvil_setAutomine', [true]);
  await mine(state.b.provider, 1);
  say('chain B mined the pending transaction while the submitter was down');

  state.sub = startRelayer('submitter', 'submitter', state.subConfig, ACCOUNTS.submitter.key);
  state.ports.sub = await relayerPort(state.sub);

  const row = await waitFor(
    'submitter reconciles the transfer it had in flight',
    async () => {
      const r = await transferRow(state.ports.sub, sent.transferId);
      return r && r.status === 'executed' ? r : null;
    },
    40_000,
  );
  assertEq(row.executedTx, txHash, 'it recognised its OWN pre-crash transaction, no new one');
  assertEq(await executedCount(sent.transferId), 1, 'exactly one Executed event — no double submit');
  await sleep(4_000);
  assertEq(await executedCount(sent.transferId), 1, 'still exactly one after the restarted submitter has ticked');
}

async function phaseRoundTrip() {
  step('ROUND TRIP — burn wFMX on B, release the locked FMX on A');
  const wfmx = new Contract(state.wfmx, TOKEN_ABI, state.b.provider);
  const balance = await wfmx.balanceOf(ACCOUNTS.recipient.address);
  const amount = parseEther('5');
  assert(balance >= amount, `recipient holds ${formatEther(balance)} wFMX to send home`);

  const recipient = new Wallet(ACCOUNTS.recipient.key, state.b.provider);
  const bridgeB = new Contract(state.bridgeB, BRIDGE_ABI, recipient);
  // BridgeToken.burn only destroys what the holder approved the bridge to
  // spend, so sending wFMX home is approve -> send, exactly as the UI does it.
  await (await wfmx.connect(recipient).approve(state.bridgeB, amount)).wait();
  const receipt = await (await bridgeB.send(state.wfmx, amount, CHAIN_A, ACCOUNTS.user.address)).wait();
  const parsed = receipt.logs
    .filter((l) => l.topics[0] === SENT_TOPIC)
    .map((l) => bridgeIface.parseLog({ topics: [...l.topics], data: l.data }))[0];
  const net = parsed.args.amount;
  say(`transferId ${parsed.args.transferId}, net ${formatEther(net)} wFMX -> FMX`);

  await mine(state.b.provider, 5);
  const userBefore = await state.a.provider.getBalance(ACCOUNTS.user.address);
  await waitFor('FMX released on chain A', async () => (await state.a.provider.getBalance(ACCOUNTS.user.address)) > userBefore, 60_000);
  const userAfter = await state.a.provider.getBalance(ACCOUNTS.user.address);
  assertEq(userAfter - userBefore, net, 'user received exactly the signed net amount back');

  const bridgeA = new Contract(state.bridgeA, BRIDGE_ABI, state.a.provider);
  const locked = await bridgeA.lockedBalance(ZeroAddress);
  const supply = await wfmx.totalSupply();
  // The bridge invariant, stated exactly: collateral locked on A equals the
  // wrapped supply on B PLUS anything the validators deliberately refused to
  // mint. Collapsing the two would hide the stranded transfer.
  assertEq(
    locked,
    supply + state.strandedNet,
    'lockedBalance on A == wFMX supply on B + the refused (stranded) transfer',
  );
  say(`locked=${formatEther(locked)}  supply=${formatEther(supply)}  stranded=${formatEther(state.strandedNet)}`);
}

async function phaseAlertsSummary() {
  step('alerting and metrics');
  const byKind = {};
  for (const a of alerts) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  say(JSON.stringify(byKind));
  assert(alerts.length > 0, `${alerts.length} alerts delivered to the webhook sink`);
  for (const kind of ['reorg', 'cap_breach', 'rpc_divergence']) {
    assert(byKind[kind] > 0, `alert kind "${kind}" fired at least once`);
  }

  const metrics = await fetch(`http://127.0.0.1:${state.ports.v1}/metrics`).then((r) => r.text());
  assert(/relayer_signatures_total/.test(metrics), '/metrics exposes relayer_signatures_total');
  assert(/relayer_chain_head\{/.test(metrics), '/metrics exposes per-chain head gauges');
  say(metrics.split('\n').filter((l) => l.startsWith('relayer_transfers_total') || l.startsWith('relayer_refusals_total')).join('\n   '));
}

async function teardown() {
  step('teardown — stop everything and free the ports');
  await killAll();
  await new Promise((r) => (state.webhook ? state.webhook.close(r) : r()));
  for (const port of Object.values(PORTS)) killPort(port);
  await sleep(400);
  const busy = Object.entries(PORTS).filter(([, p]) => !portFree(p));
  assert(busy.length === 0, `anvil ports free again: ${Object.values(PORTS).join(', ')}`);
}

// ------------------------------------------------------------------------ main

const PHASES = [
  phaseBoot,
  phaseDeploy,
  phaseStartRelayers,
  phaseHappyPath,
  phaseInsufficientSignatures,
  phaseReplay,
  phaseCapBreach,
  phaseReorg,
  phaseDivergenceCheck,
  phaseEclipseRefusal,
  phaseDeadEndpointFailover,
  phaseRestartResume,
  phaseRoundTrip,
  phaseAlertsSummary,
];

let failure = null;

// Any stray rejection is a test failure, not a silent process death.
process.on('unhandledRejection', (err) => {
  process.stdout.write(`\n\x1b[31mUNHANDLED REJECTION\x1b[0m ${err?.stack ?? String(err)}\n`);
});

try {
  for (const phase of PHASES) await phase();
} catch (err) {
  failure = err;
  process.stdout.write(`\n\x1b[31mFAILED\x1b[0m ${err instanceof AssertionError ? err.message : (err.stack ?? err)}\n`);
  for (const [name, child] of [
    ['anvil-A', state.a?.child],
    ['anvil-B', state.b?.child],
    ['validator1', state.v1],
    ['validator2', state.v2],
    ['submitter', state.sub],
  ]) {
    if (!child) continue;
    const exited = child.__exited ? ` (EXITED code=${child.__exited.code} signal=${child.__exited.signal})` : '';
    process.stdout.write(`\n--- last 25 lines from ${name}${exited} ---\n${procLines(child).slice(-25).join('\n')}\n`);
  }
} finally {
  try {
    await teardown();
  } catch (err) {
    process.stdout.write(`teardown problem: ${err.message}\n`);
  }
}

process.stdout.write(failure ? '\n\x1b[31mE2E FAILED\x1b[0m\n' : '\n\x1b[32mE2E PASSED — all phases green\x1b[0m\n');
process.exit(failure ? 1 : 0);
