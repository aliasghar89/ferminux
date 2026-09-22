#!/usr/bin/env node
// -----------------------------------------------------------------------------
// End-to-end data-layer test for the Ferminux Bridge web app.
//
// Starts TWO throwaway anvils — 8564 (chain 3961, stands in for Ferminux) and
// 8565 (chain 56, stands in for a remote EVM) — deploys the REAL bridge
// contracts from ../../contracts to both, registers a native and an ERC-20
// route through the timelock, and then drives the app's OWN modules
// (src/lib/*.ts — the same files the React components import) through a full
// transfer in each direction:
//
//   1  ports free, two anvils up, RPC fallback skips a dead endpoint
//   2  bridges deployed on both chains; readBridgeConfig sees fee/quorum/pause
//   3  wrappers deployed; both sides registered through the 48h-style timelock
//   4  readRegistry lists the assets FROM CHAIN (nothing hardcoded)
//   5  routeMirrors accepts the mirrored pair and rejects a broken one
//   6  quoteTransfer's fee/cap math agrees with the contract, before sending
//   7  native send: buildSendTx -> Sent event -> transferId (lib == contract)
//   8  status machine: Pending -> Confirming n/N -> Executing (dst not processed)
//   9  EIP-712 digest from the lib == the destination contract's hashTransfer
//  10  a real 2-of-3 relay flips processed -> status machine reaches Complete
//  11  replay and single-signature relays are refused
//  12  ERC-20 leg: allowance read -> buildApproveTx -> buildSendTx -> Sent
//  13  the return leg: burn the wrapper on B, release the collateral on A
//  14  rails: per-transfer cap and 24h cap refuse in the UI AND on chain
//  15  persistence: a record round-trips storage and the phase updates
//  16  pause is immediate and the quote blocks on it
//  17  anvils down, ports free again
//
// Usage: npm run e2e     (needs `anvil` on PATH and Node >= 23)
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import {
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Signature,
  Wallet,
  ZeroAddress,
  keccak256,
  parseEther,
  parseUnits,
} from 'ethers';

// ---- the app's own modules, imported exactly as the components import them ---
import { CHAINS, chainByKey } from '../src/config.ts';
import { connectRpc, probeRpc, chainConnection, dropAllConnections } from '../src/lib/rpc.ts';
import {
  TokenKind,
  buildApproveTx,
  requiresAllowance,
  buildSendTx,
  computeTransferId,
  isProcessed,
  parseSentFromReceipt,
  readBridgeConfig,
  readRailState,
  readRegistry,
  readWrapperProvenance,
  routeMirrors,
  transferDigest,
} from '../src/lib/bridge.ts';
import {
  decayedUsage,
  feeOf,
  formatAmount,
  maxBridgeable,
  quoteTransfer,
  remainingCapacity,
} from '../src/lib/amounts.ts';
import { deriveStatus, estimateEtaSeconds, statusFromRecord } from '../src/lib/status.ts';
import { isInFlight, loadTransfers, patchTransfer, saveTransfers, upsertTransfer } from '../src/lib/transfers.ts';
import { TRANSFER_TYPES, EIP712_NAME, EIP712_VERSION } from '../src/lib/abi.ts';

// ------------------------------------------------------------------ constants
// Overridable so this suite can be run alongside anything else that happens to
// want these two ports; the defaults are what the README documents.
const PORT_A = Number(process.env.FMX_UI_E2E_PORT_A ?? 8564); // Ferminux stand-in
const PORT_B = Number(process.env.FMX_UI_E2E_PORT_B ?? 8565); // remote EVM stand-in
const CHAIN_A = 3961;
const CHAIN_B = 56;
const RPC_A = `http://127.0.0.1:${PORT_A}`;
const RPC_B = `http://127.0.0.1:${PORT_B}`;

// Well-known anvil dev keys — public test keys, local chains only.
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // #0 owner
  validator1: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // #1
  validator2: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // #2
  validator3: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // #3
  pauser: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // #4
  user: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
  relayer: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // #6
};

const ART = (p) => fileURLToPath(new URL(`../../contracts/out/${p}`, import.meta.url));
const BRIDGE_ART = JSON.parse(readFileSync(ART('FerminuxBridge.sol/FerminuxBridge.json'), 'utf8'));
const WTOKEN_ART = JSON.parse(readFileSync(ART('BridgeToken.sol/BridgeToken.json'), 'utf8'));
const MOCK_ART = JSON.parse(readFileSync(ART('Mocks.sol/MockERC20.json'), 'utf8'));
const bridgeAbi = new Interface(BRIDGE_ART.abi);

const TIMELOCK = 3600; // the contract's MIN_TIMELOCK_DELAY; 48h in production
const FEE_BPS = 10n;

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)}. ${msg}`);
}
function section(title) {
  console.log(`\n== ${title}`);
}

// ------------------------------------------------------------------- helpers
function portFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      sock.destroy();
      resolve(free);
    };
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
    setTimeout(() => done(true), 1500);
  });
}

async function waitForAnvil(url, chainId) {
  for (let i = 0; i < 80; i++) {
    if (await probeRpc(url, chainId, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil did not become ready on ${url}`);
}

function startAnvil(port, chainId) {
  const proc = spawn('anvil', ['--port', String(port), '--chain-id', String(chainId), '--silent'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', () => {});
  return proc;
}

/** A ChainConfig of the exact shape src/config.ts produces, pointed at anvil. */
function localChain(key, chainId, rpc, native, confirmations, blockSeconds) {
  return {
    key,
    chainId,
    chainIdHex: '0x' + chainId.toString(16),
    name: key,
    short: key,
    native,
    rpcUrls: [rpc],
    explorerUrl: 'https://explorer.ferminux.net',
    bridgeAddress: '',
    confirmations,
    blockSeconds,
  };
}

async function deploy(artifact, args, signer) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return await c.getAddress();
}

/** Queue a timelocked call, fast-forward past the eta, execute it. */
async function timelockedCall(bridge, ownerSigner, provider, fn, args) {
  const data = bridgeAbi.encodeFunctionData(fn, args);
  const actionId = await bridge.actionCount();
  await (await bridge.connect(ownerSigner).queue(data)).wait();
  await provider.send('evm_increaseTime', [TIMELOCK + 60]);
  await provider.send('evm_mine', []);
  await (await bridge.connect(ownerSigner).executeAction(actionId)).wait();
  return actionId;
}

async function expectRevert(promise, what) {
  try {
    await promise;
  } catch {
    return true;
  }
  throw new Error(`expected a revert: ${what}`);
}

/** Sign a transfer as a validator would — over the app's own digest. */
async function signTransfer(wallet, dstChainId, dstBridge, t) {
  const domain = {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: dstChainId,
    verifyingContract: dstBridge,
  };
  const value = {
    transferId: computeTransferId(t),
    srcChainId: t.srcChainId,
    dstChainId: t.dstChainId,
    nonce: t.nonce,
    srcToken: t.srcToken,
    dstToken: t.dstToken,
    sender: t.sender,
    recipient: t.recipient,
    amount: t.amount,
  };
  const flat = await wallet.signTypedData(domain, TRANSFER_TYPES, value);
  const sig = Signature.from(flat);
  return [sig.v, sig.r, sig.s];
}

function structOf(sent) {
  return {
    srcChainId: sent.srcChainId,
    dstChainId: sent.dstChainId,
    nonce: sent.nonce,
    srcToken: sent.srcToken,
    dstToken: sent.dstToken,
    sender: sent.sender,
    recipient: sent.recipient,
    amount: sent.amount,
  };
}

function tupleOf(t) {
  return [t.srcChainId, t.dstChainId, t.nonce, t.srcToken, t.dstToken, t.sender, t.recipient, t.amount];
}

// --------------------------------------------------------------------- main
async function main() {
  section('0. the shipped chain registry');
  const ferminux = chainByKey('ferminux');
  assert.equal(ferminux.chainId, 3961, 'the home chain must be 3961');
  assert.equal(ferminux.chainIdHex.toLowerCase(), '0xf79');
  assert.equal(ferminux.native.symbol, 'FMX');
  assert.equal(
    CHAINS.every((c) => c.bridgeAddress === '' || /^0x[0-9a-fA-F]{40}$/.test(c.bridgeAddress)),
    true,
    'every bridge address ships empty or is a valid address',
  );
  ok(`config lists ${CHAINS.length} chains; Ferminux = 3961 / 0xf79 / FMX`);

  section('1. two throwaway anvils');
  assert.equal(await portFree(PORT_A), true, `port ${PORT_A} must be free`);
  assert.equal(await portFree(PORT_B), true, `port ${PORT_B} must be free`);
  ok(`ports ${PORT_A} and ${PORT_B} are free`);

  const anvilA = startAnvil(PORT_A, CHAIN_A);
  const anvilB = startAnvil(PORT_B, CHAIN_B);
  const exitA = new Promise((r) => anvilA.once('exit', r));
  const exitB = new Promise((r) => anvilB.once('exit', r));

  try {
    await Promise.all([waitForAnvil(RPC_A, CHAIN_A), waitForAnvil(RPC_B, CHAIN_B)]);
    ok(`anvil up on :${PORT_A} (chain ${CHAIN_A}) and :${PORT_B} (chain ${CHAIN_B})`);

    // --- the app's own RPC layer, including the dead-endpoint fallback ---
    const connA = await connectRpc(['http://127.0.0.1:9', RPC_A], CHAIN_A, 1500);
    const connB = await connectRpc([RPC_B], CHAIN_B, 1500);
    assert.equal(connA.url, RPC_A);
    const providerA = connA.provider;
    const providerB = connB.provider;
    providerA.pollingInterval = 120;
    providerB.pollingInterval = 120;
    assert.equal((await providerA.getNetwork()).chainId, BigInt(CHAIN_A));
    assert.equal((await providerB.getNetwork()).chainId, BigInt(CHAIN_B));
    ok('connectRpc skipped a dead endpoint and health-probed both chains');

    const ownerA = new Wallet(KEYS.deployer, providerA);
    const ownerB = new Wallet(KEYS.deployer, providerB);
    const userA = new Wallet(KEYS.user, providerA);
    const userB = new Wallet(KEYS.user, providerB);
    const pauserA = new Wallet(KEYS.pauser, providerA);
    const relayerB = new Wallet(KEYS.relayer, providerB);
    const relayerA = new Wallet(KEYS.relayer, providerA);
    const validators = [KEYS.validator1, KEYS.validator2, KEYS.validator3].map((k) => new Wallet(k));

    section('2. deploy the real bridge contracts on both chains');
    const ctorArgs = (owner) => [
      owner,
      validators.map((v) => v.address),
      2,
      owner,
      Number(FEE_BPS),
      TIMELOCK,
      new Wallet(KEYS.pauser).address,
    ];
    const bridgeAAddr = await deploy(BRIDGE_ART, ctorArgs(ownerA.address), ownerA);
    // The two deployments must not land on the SAME address: setRemoteBridge
    // refuses a counterpart equal to address(this), because recording ourselves
    // as the remote bridge would make send()'s recipient guard a duplicate of the
    // local check and leave the real remote address unnamed. Two fresh anvils
    // with the same deployer produce the same first-deployment address, so chain
    // B spends one nonce first.
    await (await ownerB.sendTransaction({ to: ownerB.address, value: 0n })).wait();
    const bridgeBAddr = await deploy(BRIDGE_ART, ctorArgs(ownerB.address), ownerB);
    const bridgeA = new Contract(bridgeAAddr, BRIDGE_ART.abi, providerA);
    const bridgeB = new Contract(bridgeBAddr, BRIDGE_ART.abi, providerB);
    assert.notEqual(bridgeAAddr, bridgeBAddr, 'the two bridges must be distinct deployments');
    ok(`FerminuxBridge deployed: A ${bridgeAAddr}  B ${bridgeBAddr}`);

    // Each side records the other. Timelocked, and MANDATORY before any token can
    // be registered for that chain: send()'s "recipient is not the remote bridge"
    // guard has to be able to fire, so a route may not exist for a chain whose
    // bridge address this deployment does not know.
    await timelockedCall(bridgeA, ownerA, providerA, 'setRemoteBridge', [CHAIN_B, bridgeBAddr]);
    await timelockedCall(bridgeB, ownerB, providerB, 'setRemoteBridge', [CHAIN_A, bridgeAAddr]);
    assert.equal(await bridgeA.remoteBridge(CHAIN_B), bridgeBAddr);
    assert.equal(await bridgeB.remoteBridge(CHAIN_A), bridgeAAddr);
    ok('each chain records the counterpart bridge, through the timelock');

    // --- the app reads the bridge config ---
    const cfgA = await readBridgeConfig(providerA, bridgeAAddr);
    const cfgB = await readBridgeConfig(providerB, bridgeBAddr);
    assert.equal(cfgA.chainId, CHAIN_A);
    assert.equal(cfgB.chainId, CHAIN_B);
    assert.equal(cfgA.feeBps, FEE_BPS);
    assert.equal(cfgA.threshold, 2);
    assert.equal(cfgA.validatorCount, 3);
    assert.equal(cfgA.paused, false);
    assert.equal(cfgA.timelockDelaySeconds, TIMELOCK);
    await assert.rejects(
      readBridgeConfig(providerA, new Wallet(KEYS.relayer).address),
      /No bridge contract is deployed/,
      'an address with no code must be reported honestly',
    );
    ok(`readBridgeConfig: fee ${cfgA.feeBps} bps, quorum ${cfgA.threshold}-of-${cfgA.validatorCount}, not paused`);

    section('3. assets and registration through the timelock');
    const aznt = await deploy(MOCK_ART, ['Ferminux Manat', 'AZNT', 6], ownerA);
    const azntToken = new Contract(aznt, MOCK_ART.abi, providerA);
    await (await azntToken.connect(ownerA).mint(userA.address, parseUnits('10000', 6))).wait();

    const wfmx = await deploy(WTOKEN_ART, ['Wrapped FMX', 'wFMX', 18, bridgeBAddr, CHAIN_A, ZeroAddress], ownerB);
    const waznt = await deploy(WTOKEN_ART, ['Wrapped AZNT', 'wAZNT', 6, bridgeBAddr, CHAIN_A, aznt], ownerB);
    ok(`assets: AZNT ${aznt} on A; wFMX ${wfmx} and wAZNT ${waznt} on B`);

    // registerWrapped() fails closed while the wrapper codehash pin is unset: a
    // wrapper is trusted to mint and burn, and an interface check proves nothing
    // because a proxy can pass on Monday and defect on Tuesday. BridgeToken has
    // no immutables, deliberately, so both wrappers share one codehash.
    const wfmxCode = keccak256(await providerB.getCode(wfmx));
    assert.equal(keccak256(await providerB.getCode(waznt)), wfmxCode, 'every wrapper deployment shares one codehash');
    await timelockedCall(bridgeB, ownerB, providerB, 'setBridgeTokenCodehash', [wfmxCode]);
    ok('chain B pins the wrapper bytecode it will accept');

    const NATIVE_MAX = parseEther('100');
    const NATIVE_CAP = parseEther('250');
    const AZNT_MAX = parseUnits('1000', 6);
    const AZNT_CAP = parseUnits('5000', 6);

    // early execution must be refused — proves the timelock is real
    const earlyData = bridgeAbi.encodeFunctionData('registerCanonical', [
      ZeroAddress,
      CHAIN_B,
      wfmx,
      NATIVE_MAX,
      NATIVE_CAP,
    ]);
    const earlyId = await bridgeA.actionCount();
    await (await bridgeA.connect(ownerA).queue(earlyData)).wait();
    await expectRevert(bridgeA.connect(ownerA).executeAction.staticCall(earlyId), 'executing before the eta');
    await providerA.send('evm_increaseTime', [TIMELOCK + 60]);
    await providerA.send('evm_mine', []);
    await (await bridgeA.connect(ownerA).executeAction(earlyId)).wait();
    ok('a queued registration cannot execute before its eta, and executes after it');

    await timelockedCall(bridgeA, ownerA, providerA, 'registerCanonical', [aznt, CHAIN_B, waznt, AZNT_MAX, AZNT_CAP]);
    await timelockedCall(bridgeB, ownerB, providerB, 'registerWrapped', [
      wfmx,
      CHAIN_A,
      ZeroAddress,
      NATIVE_MAX,
      NATIVE_CAP,
    ]);
    await timelockedCall(bridgeB, ownerB, providerB, 'registerWrapped', [waznt, CHAIN_A, aznt, AZNT_MAX, AZNT_CAP]);
    ok('both sides of both routes registered through the timelock');

    section('4. the app reads the registry from chain');
    const chainA = localChain('anvil-a', CHAIN_A, RPC_A, { name: 'Ferminux', symbol: 'FMX', decimals: 18 }, 3, 7);
    const chainB = localChain('anvil-b', CHAIN_B, RPC_B, { name: 'BNB', symbol: 'BNB', decimals: 18 }, 2, 3);
    chainA.bridgeAddress = bridgeAAddr;
    chainB.bridgeAddress = bridgeBAddr;

    const registryA = await readRegistry(providerA, chainA, bridgeAAddr);
    const registryB = await readRegistry(providerB, chainB, bridgeBAddr);
    assert.equal(registryA.length, 2, 'chain A has two registered assets');
    assert.equal(registryB.length, 2, 'chain B has two registered assets');

    const nativeEntry = registryA.find((e) => e.localToken === ZeroAddress);
    const azntEntry = registryA.find((e) => e.localToken.toLowerCase() === aznt.toLowerCase());
    assert.equal(nativeEntry.kind, TokenKind.CANONICAL);
    assert.equal(nativeEntry.meta.symbol, 'FMX', 'the native coin is described from the chain config');
    assert.equal(nativeEntry.meta.isNative, true);
    assert.equal(nativeEntry.remoteChainId, CHAIN_B);
    assert.equal(nativeEntry.remoteToken.toLowerCase(), wfmx.toLowerCase());
    assert.equal(nativeEntry.maxPerTransfer, NATIVE_MAX);
    assert.equal(nativeEntry.dailyCap, NATIVE_CAP);
    assert.equal(azntEntry.meta.symbol, 'AZNT', 'ERC-20 metadata is read over RPC, not hardcoded');
    assert.equal(azntEntry.meta.decimals, 6);

    const wfmxEntry = registryB.find((e) => e.localToken.toLowerCase() === wfmx.toLowerCase());
    assert.equal(wfmxEntry.kind, TokenKind.WRAPPED);
    assert.equal(wfmxEntry.meta.symbol, 'wFMX');
    assert.equal(wfmxEntry.remoteToken, ZeroAddress);
    ok(`readRegistry: A = [${registryA.map((e) => e.meta.symbol)}], B = [${registryB.map((e) => e.meta.symbol)}]`);

    const provenance = await readWrapperProvenance(providerB, wfmx);
    assert.equal(provenance.bridge.toLowerCase(), bridgeBAddr.toLowerCase());
    assert.equal(provenance.originChainId, CHAIN_A);
    assert.equal(provenance.originToken, ZeroAddress);
    ok('wrapper provenance: wFMX mirrors the native coin of chain 3961 and only bridge B can mint it');

    section('5. route mirroring');
    assert.equal(routeMirrors(nativeEntry, wfmxEntry, CHAIN_A), true);
    assert.equal(routeMirrors(nativeEntry, undefined, CHAIN_A), false, 'no destination entry = broken route');
    assert.equal(
      routeMirrors(nativeEntry, registryB.find((e) => e.localToken.toLowerCase() === waznt.toLowerCase()), CHAIN_A),
      false,
      'a mismatched pair must be rejected before the user pays',
    );
    ok('routeMirrors accepts the mirrored pair and rejects a mismatched one');

    section('6. the quote the user sees, before committing');
    const railNative = await readRailState(providerA, bridgeAAddr, nativeEntry, userA.address);
    assert.equal(railNative.usage, 0n);
    assert.equal(railNative.dailyCap, NATIVE_CAP);
    assert.equal(railNative.maxPerTransfer, NATIVE_MAX);
    assert.equal(railNative.allowance, null, 'the native coin needs no allowance');
    assert.ok(railNative.balance > parseEther('100'));

    const amount = parseEther('10');
    const quote = quoteTransfer({
      amountWei: amount,
      feeBps: cfgA.feeBps,
      maxPerTransfer: railNative.maxPerTransfer,
      dailyCap: railNative.dailyCap,
      usage: railNative.usage,
      balance: railNative.balance,
      decimals: 18,
      symbol: 'FMX',
      isNative: true,
      gasReserveWei: parseEther('0.01'),
    });
    assert.equal(quote.ok, true, quote.problems.join(' '));
    assert.equal(quote.feeWei, parseEther('0.01'));
    assert.equal(quote.netWei, parseEther('9.99'));
    assert.equal(quote.remaining, NATIVE_CAP);
    ok(`quote: send 10 FMX, fee ${formatAmount(quote.feeWei, 18, 8)}, arrives ${formatAmount(quote.netWei)} wFMX`);

    section('7. native leg: lock on A');
    const recipient = userB.address;
    const sendTx = buildSendTx(bridgeAAddr, nativeEntry.localToken, amount, CHAIN_B, recipient);
    assert.equal(sendTx.to.toLowerCase(), bridgeAAddr.toLowerCase());
    assert.equal(sendTx.value, amount, 'the native coin travels as msg.value');
    const sendRes = await userA.sendTransaction(sendTx);
    const sendReceipt = await sendRes.wait();
    assert.equal(sendReceipt.status, 1);

    const sent = parseSentFromReceipt(sendReceipt, bridgeAAddr);
    assert.ok(sent, 'the Sent event must be parseable from the receipt');
    assert.equal(sent.amount, quote.netWei, 'the event confirms exactly what the quote promised');
    assert.equal(sent.fee, quote.feeWei);
    assert.equal(sent.srcChainId, CHAIN_A);
    assert.equal(sent.dstChainId, CHAIN_B);
    assert.equal(sent.recipient.toLowerCase(), recipient.toLowerCase());

    const t1 = structOf(sent);
    assert.equal(computeTransferId(t1), sent.transferId, 'the lib computes the same id the contract emitted');
    assert.equal(await bridgeA.transferIdOf(tupleOf(t1)), sent.transferId, 'and the same id the contract computes');
    assert.equal(await bridgeA.lockedBalance(ZeroAddress), quote.netWei, 'only the net amount became collateral');
    assert.equal(await bridgeA.accruedFees(ZeroAddress), quote.feeWei, 'the fee is not collateral');
    ok(`locked 10 FMX; transferId ${sent.transferId.slice(0, 18)}… verified three ways`);

    section('8. status machine while it is in flight');
    const headAfterSend = await providerA.getBlockNumber();
    const processedBefore = await isProcessed(providerB, bridgeBAddr, sent.transferId);
    assert.equal(processedBefore, false, 'the destination has not seen it yet');

    const sPending = deriveStatus({
      receiptStatus: null,
      receiptBlockNumber: null,
      srcBlockNumber: headAfterSend,
      destinationProcessed: null,
      destinationKnown: true,
      requiredConfirmations: chainA.confirmations,
    });
    assert.equal(sPending.phase, 'submitted');

    const sConfirming = deriveStatus({
      receiptStatus: 1,
      receiptBlockNumber: sendReceipt.blockNumber,
      srcBlockNumber: headAfterSend,
      destinationProcessed: processedBefore,
      destinationKnown: true,
      requiredConfirmations: chainA.confirmations,
    });
    assert.equal(sConfirming.phase, 'confirming');
    assert.equal(sConfirming.confirmations, 1);
    assert.equal(sConfirming.label, `Confirming 1/${chainA.confirmations}`);

    await providerA.send('anvil_mine', ['0x5']);
    const deeperHead = await providerA.getBlockNumber();
    const sExecuting = deriveStatus({
      receiptStatus: 1,
      receiptBlockNumber: sendReceipt.blockNumber,
      srcBlockNumber: deeperHead,
      destinationProcessed: await isProcessed(providerB, bridgeBAddr, sent.transferId),
      destinationKnown: true,
      requiredConfirmations: chainA.confirmations,
    });
    assert.equal(sExecuting.phase, 'executing');
    assert.ok(sExecuting.progress > sConfirming.progress);
    ok(`status: Pending → ${sConfirming.label} → Executing (destination says processed=false)`);
    ok(`honest estimate for this route: about ${Math.round(estimateEtaSeconds(chainA, chainB) / 60)} min`);

    section('9. the signature domain binds the destination chain and bridge');
    const libDigest = transferDigest(CHAIN_B, bridgeBAddr, t1);
    const onChainDigest = await bridgeB.hashTransfer(tupleOf(t1));
    assert.equal(libDigest, onChainDigest, 'the app derives the exact digest the destination verifies');
    // Both halves of the binding, proved separately. This used to lean on the two
    // anvils deploying the bridge to the same address by accident; they no longer
    // do (setRemoteBridge refuses a counterpart equal to itself, so the harness
    // makes them differ), and leaning on an accident was never the argument
    // anyway. Hold the ADDRESS fixed and change the chain id, then hold the CHAIN
    // fixed and change the address.
    const wrongChainDigest = transferDigest(CHAIN_A, bridgeBAddr, t1);
    const otherDeployment = new Wallet(KEYS.relayer).address;
    const wrongBridgeDigest = transferDigest(CHAIN_B, otherDeployment, t1);
    assert.notEqual(wrongChainDigest, libDigest, 'the same bridge address on another chain id is another digest');
    assert.notEqual(wrongBridgeDigest, libDigest, 'another deployment on the same chain is another digest');
    assert.notEqual(await bridgeA.DOMAIN_SEPARATOR(), await bridgeB.DOMAIN_SEPARATOR(), 'two deployments, two domains');
    ok('EIP-712 digest matches hashTransfer() and changes with chain id or bridge address');

    section('10. a real 2-of-3 relay lands it');
    const wfmxToken = new Contract(wfmx, WTOKEN_ART.abi, providerB);
    const sigOne = [await signTransfer(validators[0], CHAIN_B, bridgeBAddr, t1)];
    await expectRevert(
      bridgeB.connect(relayerB).execute.staticCall(tupleOf(t1), sigOne),
      'one signature under a 2-of-3 threshold',
    );
    const dup = await signTransfer(validators[0], CHAIN_B, bridgeBAddr, t1);
    await expectRevert(
      bridgeB.connect(relayerB).execute.staticCall(tupleOf(t1), [dup, dup]),
      'the same validator signing twice',
    );
    const sigs = [
      await signTransfer(validators[0], CHAIN_B, bridgeBAddr, t1),
      await signTransfer(validators[1], CHAIN_B, bridgeBAddr, t1),
    ];
    await (await bridgeB.connect(relayerB).execute(tupleOf(t1), sigs)).wait();

    assert.equal(await wfmxToken.balanceOf(recipient), quote.netWei, 'the recipient holds exactly the net amount');
    assert.equal(await wfmxToken.totalSupply(), quote.netWei);
    assert.equal(await bridgeA.lockedBalance(ZeroAddress), await wfmxToken.totalSupply(), 'supply == collateral');
    ok(`relayed with 2 of 3 signatures; recipient holds ${formatAmount(quote.netWei)} wFMX, fully collateralised`);

    const processedAfter = await isProcessed(providerB, bridgeBAddr, sent.transferId);
    assert.equal(processedAfter, true);
    const sComplete = deriveStatus({
      receiptStatus: 1,
      receiptBlockNumber: sendReceipt.blockNumber,
      srcBlockNumber: await providerA.getBlockNumber(),
      destinationProcessed: processedAfter,
      destinationKnown: true,
      requiredConfirmations: chainA.confirmations,
    });
    assert.equal(sComplete.phase, 'complete');
    assert.equal(sComplete.terminal, true);
    assert.equal(sComplete.progress, 1);
    ok('the destination processed flag flipped and the status machine reached Complete');

    section('11. replay protection');
    await expectRevert(bridgeB.connect(relayerB).execute.staticCall(tupleOf(t1), sigs), 'replaying the same transfer');
    ok('the same transfer cannot be executed twice');

    section('12. ERC-20 leg: allowance, approve, send');
    const railAznt = await readRailState(providerA, bridgeAAddr, azntEntry, userA.address);
    assert.equal(railAznt.allowance, 0n, 'a fresh allowance is zero');
    assert.equal(railAznt.balance, parseUnits('10000', 6));

    const azntAmount = parseUnits('500', 6);
    const azntQuote = quoteTransfer({
      amountWei: azntAmount,
      feeBps: cfgA.feeBps,
      maxPerTransfer: railAznt.maxPerTransfer,
      dailyCap: railAznt.dailyCap,
      usage: railAznt.usage,
      balance: railAznt.balance,
      decimals: 6,
      symbol: 'AZNT',
      isNative: false,
    });
    assert.equal(azntQuote.ok, true, azntQuote.problems.join(' '));
    assert.equal(azntQuote.feeWei, parseUnits('0.5', 6));
    assert.equal(azntQuote.netWei, parseUnits('499.5', 6));

    // sending without an allowance must fail — this is why the UI approves first
    await expectRevert(
      userA.call(buildSendTx(bridgeAAddr, aznt, azntAmount, CHAIN_B, recipient)),
      'sending an ERC-20 without an allowance',
    );

    const approveTx = buildApproveTx(aznt, bridgeAAddr, azntAmount);
    await (await userA.sendTransaction(approveTx)).wait();
    const railAfterApprove = await readRailState(providerA, bridgeAAddr, azntEntry, userA.address);
    assert.equal(railAfterApprove.allowance, azntAmount, 'the app sees the new allowance');

    const azntReceipt = await (
      await userA.sendTransaction(buildSendTx(bridgeAAddr, aznt, azntAmount, CHAIN_B, recipient))
    ).wait();
    const azntSent = parseSentFromReceipt(azntReceipt, bridgeAAddr);
    assert.equal(azntSent.amount, azntQuote.netWei);
    assert.equal(azntSent.fee, azntQuote.feeWei);
    assert.equal(azntSent.dstToken.toLowerCase(), waznt.toLowerCase());
    assert.equal(await azntToken.balanceOf(userA.address), parseUnits('9500', 6));
    ok(`approve → bridge: 500 AZNT locked, ${formatAmount(azntQuote.netWei, 6)} wAZNT owed on the far side`);

    const azntSigs = [
      await signTransfer(validators[1], CHAIN_B, bridgeBAddr, structOf(azntSent)),
      await signTransfer(validators[2], CHAIN_B, bridgeBAddr, structOf(azntSent)),
    ];
    await (await bridgeB.connect(relayerB).execute(tupleOf(structOf(azntSent)), azntSigs)).wait();
    const wazntToken = new Contract(waznt, WTOKEN_ART.abi, providerB);
    assert.equal(await wazntToken.balanceOf(recipient), azntQuote.netWei);
    assert.equal(await isProcessed(providerB, bridgeBAddr, azntSent.transferId), true);
    ok('the ERC-20 leg landed too: wAZNT minted to the recipient');

    section('13. the return leg: burn on B, release on A');
    const railWfmx = await readRailState(providerB, bridgeBAddr, wfmxEntry, recipient);
    assert.equal(railWfmx.balance, quote.netWei);
    // A wrapped asset is burned rather than pulled, but the burn debits the
    // holder's allowance all the same — so the return leg is approve-then-send,
    // exactly like the ERC-20 leg above. The UI must agree, or it sends users
    // into "WTOKEN: burn exceeds allowance" with no way out.
    assert.equal(railWfmx.allowance, 0n, 'nothing approved yet');
    assert.equal(requiresAllowance(wfmxEntry), true, 'the UI knows a wrapped return leg needs an approval');

    const backAmount = parseEther('4');
    const backQuote = quoteTransfer({
      amountWei: backAmount,
      feeBps: (await readBridgeConfig(providerB, bridgeBAddr)).feeBps,
      maxPerTransfer: railWfmx.maxPerTransfer,
      dailyCap: railWfmx.dailyCap,
      usage: railWfmx.usage,
      balance: railWfmx.balance,
      decimals: 18,
      symbol: 'wFMX',
      isNative: false,
    });
    assert.equal(backQuote.ok, true, backQuote.problems.join(' '));

    // Sending without the approval must fail — the same proof the ERC-20 leg makes.
    await assert.rejects(
      userB.call({ ...buildSendTx(bridgeBAddr, wfmx, backAmount, CHAIN_A, userA.address), from: userB.address }),
      /burn exceeds allowance/,
      'an unapproved wrapped send is refused',
    );
    await (await userB.sendTransaction(buildApproveTx(wfmx, bridgeBAddr, backAmount))).wait();
    assert.equal(
      (await readRailState(providerB, bridgeBAddr, wfmxEntry, recipient)).allowance,
      backAmount,
      'the approval is visible to the rail the UI reads',
    );

    const backReceipt = await (
      await userB.sendTransaction(buildSendTx(bridgeBAddr, wfmx, backAmount, CHAIN_A, userA.address))
    ).wait();
    const backSent = parseSentFromReceipt(backReceipt, bridgeBAddr);
    assert.equal(backSent.amount, backQuote.netWei);
    assert.equal(backSent.dstToken, ZeroAddress, 'it goes home as the native coin');

    const balBefore = await providerA.getBalance(userA.address);
    const backSigs = [
      await signTransfer(validators[0], CHAIN_A, bridgeAAddr, structOf(backSent)),
      await signTransfer(validators[2], CHAIN_A, bridgeAAddr, structOf(backSent)),
    ];
    await (await bridgeA.connect(relayerA).execute(tupleOf(structOf(backSent)), backSigs)).wait();
    const balAfter = await providerA.getBalance(userA.address);
    assert.equal(balAfter - balBefore, backQuote.netWei, 'the released amount is exactly the signed net amount');
    assert.equal(
      await bridgeA.lockedBalance(ZeroAddress),
      await wfmxToken.totalSupply(),
      'collateral still exactly backs the wrapped supply after the round trip',
    );
    ok(`returned ${formatAmount(backQuote.netWei)} FMX; collateral still equals wrapped supply`);

    section('14. the rails refuse the same things in the UI and on chain');
    const railNow = await readRailState(providerA, bridgeAAddr, nativeEntry, userA.address);
    assert.ok(railNow.usage > 0n, 'the outbound window recorded the send');

    const overPerTransfer = quoteTransfer({
      amountWei: parseEther('101'),
      feeBps: cfgA.feeBps,
      maxPerTransfer: railNow.maxPerTransfer,
      dailyCap: railNow.dailyCap,
      usage: railNow.usage,
      balance: railNow.balance,
      decimals: 18,
      symbol: 'FMX',
      isNative: true,
    });
    assert.equal(overPerTransfer.ok, false);
    assert.match(overPerTransfer.problems.join(' '), /per-transfer cap/);
    await expectRevert(
      userA.call(buildSendTx(bridgeAAddr, ZeroAddress, parseEther('101'), CHAIN_B, recipient)),
      'a send above the per-transfer cap',
    );

    const remaining = remainingCapacity(railNow.dailyCap, railNow.usage);
    const overDaily = quoteTransfer({
      amountWei: remaining + parseEther('1'),
      feeBps: cfgA.feeBps,
      maxPerTransfer: parseEther('100000'),
      dailyCap: railNow.dailyCap,
      usage: railNow.usage,
      balance: railNow.balance,
      decimals: 18,
      symbol: 'FMX',
      isNative: true,
    });
    assert.equal(overDaily.ok, false);
    assert.match(overDaily.problems.join(' '), /24 h capacity/);
    ok(`caps: UI and chain both refuse >100 FMX per transfer; ${formatAmount(remaining)} FMX of daily capacity left`);

    // The local decay model against the contract's own view of the same bucket.
    // At the moment of the read the two agree exactly.
    const block = await providerA.getBlock('latest');
    const localNow = decayedUsage(railNow.usage, railNow.atSeconds, Number(block.timestamp));
    assert.equal(localNow, await bridgeA.outboundUsage(ZeroAddress), 'local decay matches outboundUsage()');

    // Extrapolated far into the future the two drift, for two reasons worth
    // being precise about:
    //   1. the base timestamp can be one block-second off, because a node
    //      evaluates eth_call against the PENDING block while getBlock('latest')
    //      reports the mined one;
    //   2. the contract decays the raw stored `used` from `updatedAt`, while the
    //      app can only re-decay the already-decayed value it was given —
    //      composing two linear decays is not one linear decay.
    // Both are bounded by a couple of seconds of drain, i.e. parts per million
    // of the cap over a 12 s poll interval. The contract is always authoritative.
    await providerA.send('evm_increaseTime', [43_200]);
    await providerA.send('evm_mine', []);
    const halfBlock = await providerA.getBlock('latest');
    const chainHalf = await bridgeA.outboundUsage(ZeroAddress);
    const localHalf = decayedUsage(railNow.usage, railNow.atSeconds, Number(halfBlock.timestamp));
    const perSecond = railNow.usage / 86_400n;
    const drift = localHalf > chainHalf ? localHalf - chainHalf : chainHalf - localHalf;
    assert.ok(
      drift <= perSecond * 3n + 1n,
      `after 12 h the local model is within a few seconds of drain of the contract (drift ${drift})`,
    );
    assert.ok(chainHalf < railNow.usage / 2n + perSecond * 3n, 'roughly half the bucket has drained');
    ok(
      `the 24 h bucket decays locally as it does on chain: exact at t, within ${drift} wei (< ${perSecond * 3n}) at t+12 h`,
    );

    const maxNow = maxBridgeable({
      balance: railNow.balance,
      maxPerTransfer: railNow.maxPerTransfer,
      dailyCap: railNow.dailyCap,
      usage: chainHalf,
      isNative: true,
      gasReserveWei: parseEther('0.01'),
    });
    const maxQuote = quoteTransfer({
      amountWei: maxNow,
      feeBps: cfgA.feeBps,
      maxPerTransfer: railNow.maxPerTransfer,
      dailyCap: railNow.dailyCap,
      usage: chainHalf,
      balance: railNow.balance,
      decimals: 18,
      symbol: 'FMX',
      isNative: true,
      gasReserveWei: parseEther('0.01'),
    });
    assert.equal(maxQuote.ok, true, `Max must always be sendable: ${maxQuote.problems.join(' ')}`);
    await (await userA.sendTransaction(buildSendTx(bridgeAAddr, ZeroAddress, maxNow, CHAIN_B, recipient))).wait();
    ok(`Max computed ${formatAmount(maxNow)} FMX and the chain accepted it`);

    section('15. persistence: a refresh must not lose a transfer');
    const store = (() => {
      const map = new Map();
      return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    })();
    const record = {
      transferId: sent.transferId,
      srcChainKey: chainA.key,
      dstChainKey: chainB.key,
      srcChainId: CHAIN_A,
      dstChainId: CHAIN_B,
      srcBridge: bridgeAAddr,
      dstBridge: bridgeBAddr,
      srcToken: ZeroAddress,
      dstToken: wfmx,
      symbol: 'FMX',
      dstSymbol: 'wFMX',
      decimals: 18,
      sender: userA.address,
      recipient,
      sentWei: amount.toString(),
      amountWei: sent.amount.toString(),
      feeWei: sent.fee.toString(),
      nonce: sent.nonce,
      txHash: sendReceipt.hash,
      txBlockNumber: sendReceipt.blockNumber,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 'confirming',
    };
    saveTransfers(store, upsertTransfer([], record), 'e2e.transfers');
    const reloaded = loadTransfers(store, 'e2e.transfers');
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].transferId, sent.transferId);
    assert.equal(isInFlight(reloaded[0]), true);
    assert.equal(statusFromRecord(reloaded[0], chainA.confirmations).phase, 'confirming');

    const settledList = patchTransfer(reloaded, sendReceipt.hash, { phase: 'complete' });
    saveTransfers(store, settledList, 'e2e.transfers');
    const finalList = loadTransfers(store, 'e2e.transfers');
    assert.equal(finalList[0].phase, 'complete');
    assert.equal(isInFlight(finalList[0]), false);
    assert.equal(statusFromRecord(finalList[0], chainA.confirmations).terminal, true);
    ok('a real transfer round-tripped storage and moved from in-flight to settled');

    section('16. pause is immediate');
    await (await bridgeA.connect(pauserA).pause()).wait();
    const pausedCfg = await readBridgeConfig(providerA, bridgeAAddr);
    assert.equal(pausedCfg.paused, true);
    const pausedQuote = quoteTransfer({
      amountWei: parseEther('1'),
      feeBps: pausedCfg.feeBps,
      maxPerTransfer: railNow.maxPerTransfer,
      dailyCap: railNow.dailyCap,
      usage: 0n,
      balance: railNow.balance,
      decimals: 18,
      symbol: 'FMX',
      isNative: true,
      bridgePaused: pausedCfg.paused,
    });
    assert.equal(pausedQuote.ok, false);
    assert.match(pausedQuote.problems[0], /bridge is paused/i);
    await expectRevert(
      userA.call(buildSendTx(bridgeAAddr, ZeroAddress, parseEther('1'), CHAIN_B, recipient)),
      'sending while paused',
    );
    await (await bridgeA.connect(ownerA).unpause()).wait();
    assert.equal((await readBridgeConfig(providerA, bridgeAAddr)).paused, false);
    ok('the pauser key stopped the bridge instantly; the UI quote refused; the owner reopened it');

    // exercise the shared connection cache the app uses in the browser
    const cached = await chainConnection(chainA);
    assert.equal(cached.chainId, CHAIN_A);
    assert.equal(await chainConnection(chainA), cached, 'connections are shared per chain');
    dropAllConnections();
    ok('the shared per-chain connection cache de-duplicates and can be dropped');

    providerA.destroy();
    providerB.destroy();
  } finally {
    for (const [proc, exit] of [
      [anvilA, exitA],
      [anvilB, exitB],
    ]) {
      proc.kill('SIGTERM');
      await Promise.race([exit, new Promise((r) => setTimeout(r, 5000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await exit;
    }
  }

  section('17. teardown');
  for (const port of [PORT_A, PORT_B]) {
    for (let i = 0; i < 20 && !(await portFree(port)); i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(await portFree(port), true, `port ${port} must be free after the test`);
  }
  ok(`anvils stopped; ports ${PORT_A} and ${PORT_B} are free again`);

  console.log('\nE2E: all checks passed.');
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
