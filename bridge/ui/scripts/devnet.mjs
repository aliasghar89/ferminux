#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Local two-chain devnet for developing and eyeballing the bridge UI.
//
// Starts two throwaway anvils — 8564 (chain 3961, Ferminux) and 8565 (chain 56,
// BSC) — deploys the real bridge contracts from ../../contracts to both,
// deploys a mock ERC-20 plus its wrappers, registers both routes through the
// timelock, and then prints the VITE_ environment the app needs. It stays in
// the foreground; Ctrl-C stops both anvils.
//
//   node scripts/devnet.mjs                 # start it, keep the terminal open
//   VITE_BRIDGE_FERMINUX=… npm run dev      # in another terminal, with the printed env
//
// NEVER points at a public RPC and never deploys anywhere but these two anvils.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, Interface, Wallet, ZeroAddress, parseEther, parseUnits } from 'ethers';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';

const PORT_A = 8564;
const PORT_B = 8565;
const CHAIN_A = 3961;
const CHAIN_B = 56;
const RPC_A = `http://127.0.0.1:${PORT_A}`;
const RPC_B = `http://127.0.0.1:${PORT_B}`;
const TIMELOCK = 3600;

const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0
const VALIDATORS = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
];
const PAUSER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'; // anvil #4
const USER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'; // anvil #5 — fund this one in your wallet

const ART = (p) => fileURLToPath(new URL(`../../contracts/out/${p}`, import.meta.url));
const BRIDGE_ART = JSON.parse(readFileSync(ART('FerminuxBridge.sol/FerminuxBridge.json'), 'utf8'));
const WTOKEN_ART = JSON.parse(readFileSync(ART('BridgeToken.sol/BridgeToken.json'), 'utf8'));
const MOCK_ART = JSON.parse(readFileSync(ART('Mocks.sol/MockERC20.json'), 'utf8'));
const bridgeAbi = new Interface(BRIDGE_ART.abi);

function startAnvil(port, chainId) {
  const p = spawn('anvil', ['--port', String(port), '--chain-id', String(chainId), '--silent'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return p;
}

async function waitFor(url, chainId) {
  for (let i = 0; i < 80; i++) {
    if (await probeRpc(url, chainId, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil never came up on ${url}`);
}

async function deploy(artifact, args, signer) {
  const f = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c.getAddress();
}

async function timelocked(bridge, owner, provider, fn, args) {
  const id = await bridge.actionCount();
  await (await bridge.connect(owner).queue(bridgeAbi.encodeFunctionData(fn, args))).wait();
  await provider.send('evm_increaseTime', [TIMELOCK + 60]);
  await provider.send('evm_mine', []);
  await (await bridge.connect(owner).executeAction(id)).wait();
}

const anvilA = startAnvil(PORT_A, CHAIN_A);
const anvilB = startAnvil(PORT_B, CHAIN_B);
const stop = () => {
  anvilA.kill('SIGTERM');
  anvilB.kill('SIGTERM');
};
process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});

try {
  await Promise.all([waitFor(RPC_A, CHAIN_A), waitFor(RPC_B, CHAIN_B)]);
  const { provider: providerA } = await connectRpc([RPC_A], CHAIN_A);
  const { provider: providerB } = await connectRpc([RPC_B], CHAIN_B);
  const ownerA = new Wallet(DEPLOYER, providerA);
  const ownerB = new Wallet(DEPLOYER, providerB);

  const ctor = (owner) => [owner, VALIDATORS, 2, owner, 10, TIMELOCK, PAUSER];
  const bridgeAAddr = await deploy(BRIDGE_ART, ctor(ownerA.address), ownerA);
  const bridgeBAddr = await deploy(BRIDGE_ART, ctor(ownerB.address), ownerB);
  const bridgeA = new Contract(bridgeAAddr, BRIDGE_ART.abi, providerA);
  const bridgeB = new Contract(bridgeBAddr, BRIDGE_ART.abi, providerB);

  const aznt = await deploy(MOCK_ART, ['Ferminux Manat', 'AZNT', 6], ownerA);
  await (await new Contract(aznt, MOCK_ART.abi, ownerA).mint(USER, parseUnits('25000', 6))).wait();
  const wfmx = await deploy(WTOKEN_ART, ['Wrapped FMX', 'wFMX', 18, bridgeBAddr, CHAIN_A, ZeroAddress], ownerB);
  const waznt = await deploy(WTOKEN_ART, ['Wrapped AZNT', 'wAZNT', 6, bridgeBAddr, CHAIN_A, aznt], ownerB);

  await timelocked(bridgeA, ownerA, providerA, 'registerCanonical', [
    ZeroAddress,
    CHAIN_B,
    wfmx,
    parseEther('100'),
    parseEther('250'),
  ]);
  await timelocked(bridgeA, ownerA, providerA, 'registerCanonical', [
    aznt,
    CHAIN_B,
    waznt,
    parseUnits('1000', 6),
    parseUnits('5000', 6),
  ]);
  await timelocked(bridgeB, ownerB, providerB, 'registerWrapped', [
    wfmx,
    CHAIN_A,
    ZeroAddress,
    parseEther('100'),
    parseEther('250'),
  ]);
  await timelocked(bridgeB, ownerB, providerB, 'registerWrapped', [
    waznt,
    CHAIN_A,
    aznt,
    parseUnits('1000', 6),
    parseUnits('5000', 6),
  ]);

  console.log(`
devnet ready

  chain 3961 (Ferminux stand-in)  ${RPC_A}
  chain   56 (BSC stand-in)       ${RPC_B}

  bridge on 3961   ${bridgeAAddr}
  bridge on 56     ${bridgeBAddr}
  AZNT on 3961     ${aznt}
  wFMX on 56       ${wfmx}
  wAZNT on 56      ${waznt}
  funded user      ${USER}  (anvil #5)

Run the UI against it:

  VITE_RPC_FERMINUX=${RPC_A} \\
  VITE_RPC_BSC=${RPC_B} \\
  VITE_BRIDGE_FERMINUX=${bridgeAAddr} \\
  VITE_BRIDGE_BSC=${bridgeBAddr} \\
  npm run dev

Ctrl-C stops both anvils.
`);
} catch (err) {
  console.error('devnet failed:', err);
  stop();
  process.exit(1);
}

// Keep the process (and therefore both anvils) alive until it is signalled.
// A never-resolving top-level await would let Node exit with code 13 as soon as
// the loop drains, taking the anvils with it — a timer handle does not.
const keepAlive = setInterval(() => {}, 60_000);
process.on('exit', () => clearInterval(keepAlive));
