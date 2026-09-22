// Shared helpers for the local devnet suite.
//
// Everything here talks to anvil instances THIS suite started, on the two ports
// this component owns (8562, 8563). Every other listener the suite creates binds
// port 0. It never touches a public RPC, never touches the live devnet on 8545,
// and never touches the docker containers.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, Interface, JsonRpcProvider, Wallet, ZeroAddress, keccak256 } from 'ethers';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const ARTIFACTS = join(ROOT, 'artifacts');
export const CONTRACTS = resolve(ROOT, '..', 'contracts');

/**
 * The ONLY fixed ports this component owns: the two anvils. Everything else in
 * the suite (validator HTTP, submitter HTTP, alert sink, the lying RPC proxy)
 * binds port 0 and the real port is read back from the process log, so this
 * suite cannot collide with anything else running on the machine.
 */
export const PORTS = {
  anvilA: Number(process.env.FMX_E2E_PORT_A ?? 8562),
  anvilB: Number(process.env.FMX_E2E_PORT_B ?? 8563),
};

/** anvil's deterministic dev accounts. Devnet only — these keys are public. */
export const ACCOUNTS = {
  deployer: { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  validator1: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  validator2: { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  validator3: { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
  pauser: { address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' },
  user: { address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' },
  recipient: { address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9', key: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' },
  submitter: { address: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', key: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' },
};

export const CHAIN_A = 3961; // stands in for Ferminux
export const CHAIN_B = 56; // stands in for a remote EVM
export const TIMELOCK_DELAY = 3600; // contract minimum, so the devnet run is quick

let stepNo = 0;
export function step(title) {
  stepNo += 1;
  process.stdout.write(`\n\x1b[1m== ${stepNo}. ${title}\x1b[0m\n`);
}
export function say(msg) {
  process.stdout.write(`   ${msg}\n`);
}
export function ok(msg) {
  process.stdout.write(`   \x1b[32mPASS\x1b[0m ${msg}\n`);
}

export class AssertionError extends Error {}

export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
  ok(msg);
}

export function assertEq(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual.toString() : String(actual);
  const e = typeof expected === 'bigint' ? expected.toString() : String(expected);
  if (a !== e) throw new AssertionError(`${msg}\n     expected: ${e}\n     actual:   ${a}`);
  ok(`${msg} (${a})`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or `timeoutMs` elapses. */
export async function waitFor(label, fn, timeoutMs = 30_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(intervalMs);
  }
  throw new AssertionError(`timed out after ${timeoutMs}ms waiting for: ${label} (last: ${JSON.stringify(last)})`);
}

/** True if nothing is listening on the port. */
export function portFree(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length === 0;
  } catch {
    return true; // lsof exits non-zero when there are no matches
  }
}

/**
 * A port that is guaranteed to have nothing listening on it: bind 0, read back
 * what the OS gave us, release it. Used to point a config at an endpoint that
 * is definitively dead, without hardcoding a number and hoping.
 */
export async function closedPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

export function killPort(port) {
  try {
    const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const pid of out.trim().split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

// ------------------------------------------------------------------- processes

const children = new Set();

export function spawnProc(name, cmd, args, env = {}, logPath = null) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__name = name;
  child.__lines = [];
  const capture = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) child.__lines.push(line);
    }
    if (child.__lines.length > 4000) child.__lines.splice(0, 2000);
    if (process.env.E2E_VERBOSE === '1') process.stdout.write(`[${name}] ${text}`);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => {
    child.__exited = { code, signal, at: Date.now() };
    children.delete(child);
  });
  children.add(child);
  if (logPath) child.__logPath = logPath;
  return child;
}

export function procLines(child, pattern) {
  return child.__lines.filter((l) => (pattern ? l.includes(pattern) : true));
}

export async function killProc(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (child.exitCode === null) child.kill('SIGKILL');
  children.delete(child);
}

export async function killAll() {
  for (const child of [...children]) await killProc(child, 'SIGKILL');
}

// ----------------------------------------------------------------------- anvil

export async function startAnvil(port, chainId, extraArgs = []) {
  killPort(port);
  const child = spawnProc(`anvil:${port}`, 'anvil', ['--port', String(port), '--chain-id', String(chainId), '--silent', ...extraArgs]);
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, { chainId, name: `local-${chainId}` }, { staticNetwork: true, cacheTimeout: -1 });
  await waitFor(`anvil on ${port}`, async () => Number(await provider.send('eth_chainId', [])) === chainId, 20_000, 200);
  return { child, provider, url: `http://127.0.0.1:${port}`, chainId };
}

export function artifact(name) {
  const path = join(ARTIFACTS, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`missing artifact ${path} — run: forge build --root ${CONTRACTS} --out ${ARTIFACTS} --cache-path ${join(ROOT, '.forge-cache')}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Deploy FerminuxBridge exactly as script/DeployBridge.s.sol does. */
export async function deployBridge(provider, { owner, validators, threshold, feeCollector, feeBps, timelockDelay, pauser }) {
  const art = artifact('FerminuxBridge');
  const wallet = new Wallet(ACCOUNTS.deployer.key, provider);
  const factory = new ContractFactory(art.abi, art.bytecode.object, wallet);
  const bridge = await factory.deploy(owner, validators, threshold, feeCollector, feeBps, timelockDelay, pauser);
  await bridge.waitForDeployment();
  return bridge;
}

export async function deployWrapped(provider, { name, symbol, decimals, bridge, originChainId, originToken }) {
  const art = artifact('BridgeToken');
  const wallet = new Wallet(ACCOUNTS.deployer.key, provider);
  const factory = new ContractFactory(art.abi, art.bytecode.object, wallet);
  const token = await factory.deploy(name, symbol, decimals, bridge, originChainId, originToken);
  await token.waitForDeployment();
  return token;
}

/** Queue any timelocked owner action, jump past the delay, execute it. */
export async function timelockAction(provider, bridge, fn, args) {
  const iface = new Interface(artifact('FerminuxBridge').abi);
  const inner = iface.encodeFunctionData(fn, args);
  const owner = new Wallet(ACCOUNTS.deployer.key, provider);
  const asOwner = bridge.connect(owner);
  const actionId = Number(await asOwner.actionCount());
  await (await asOwner.queue(inner)).wait();
  await provider.send('evm_increaseTime', [TIMELOCK_DELAY + 60]);
  await provider.send('evm_mine', []);
  await (await asOwner.executeAction(actionId)).wait();
  return actionId;
}

/**
 * Record the counterpart deployment. MANDATORY before any token can be
 * registered for that chain — `_register` requires `remoteBridge[chain] != 0`,
 * because send()'s "recipient is not the remote bridge" guard has to be able to
 * fire — and timelocked, for the same reason.
 */
export async function setRemoteBridge(provider, bridge, remoteChainId, remoteBridgeAddress) {
  return timelockAction(provider, bridge, 'setRemoteBridge', [remoteChainId, remoteBridgeAddress]);
}

/**
 * Pin the wrapper bytecode this bridge will accept. registerWrapped() fails
 * closed while the pin is unset: a wrapper is trusted to mint and burn, an
 * interface check proves nothing (a proxy can pass on Monday and defect on
 * Tuesday), so the bridge pins the exact runtime code. BridgeToken deliberately
 * has NO immutables, so every wrapper deployment shares one codehash and one pin
 * covers all of them.
 */
export async function pinWrapperCodehash(provider, bridge, wrapperAddress) {
  const code = await provider.getCode(wrapperAddress);
  if (code === '0x') throw new Error(`no code at ${wrapperAddress} — cannot pin a codehash`);
  return timelockAction(provider, bridge, 'setBridgeTokenCodehash', [keccak256(code)]);
}

/** Queue a timelocked registration, jump past the delay, execute it. */
export async function registerToken(provider, bridge, kind, args) {
  return timelockAction(provider, bridge, kind === 'canonical' ? 'registerCanonical' : 'registerWrapped', args);
}

/**
 * Spend one nonce, so the NEXT deployment from this account lands somewhere else.
 *
 * Two fresh anvils with the same deployer produce the same address for their
 * first deployment, and setRemoteBridge() refuses a counterpart equal to
 * `address(this)`: recording ourselves as the remote bridge would make send()'s
 * recipient guard a duplicate of the local check and leave the real remote
 * address unnamed. So the two chains' bridges must not collide.
 */
export async function bumpNonce(provider) {
  const w = new Wallet(ACCOUNTS.deployer.key, provider);
  await (await w.sendTransaction({ to: w.address, value: 0n })).wait();
}

export async function mine(provider, n) {
  await provider.send('anvil_mine', [`0x${n.toString(16)}`]);
}

/**
 * Read the port a spawned relayer actually bound, out of its own JSON log.
 * Used because the suite starts every HTTP server on port 0.
 */
export async function relayerPort(child) {
  const line = await waitFor(`${child.__name} http listening`, () => procLines(child, '"msg":"http listening"')[0], 30_000, 100);
  return JSON.parse(line).port;
}

/**
 * A JSON-RPC proxy that forwards to a real node but LIES in one specific way.
 * This is how the suite produces an eclipse/chain-split without a second chain:
 * the endpoint stays perfectly healthy (honest eth_chainId, honest block number)
 * and only its content is wrong, which is exactly the attack the divergence
 * detector exists for.
 *
 *   mode 'honest'          pure passthrough
 *   mode 'wrong-block-hash' mutates the hash in eth_getBlockByNumber results
 *   mode 'hide-logs'       returns [] for every eth_getLogs
 */
export async function startLyingProxy(targetUrl, initialMode = 'honest') {
  let mode = initialMode;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400).end('{}');
          return;
        }
        try {
          const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const answer = await upstream.json();
          const doctor = (req1, resp) => {
            if (!resp || resp.result === undefined || resp.result === null) return resp;
            if (mode === 'wrong-block-hash' && req1.method === 'eth_getBlockByNumber' && resp.result.hash) {
              resp.result.hash = `0xdead${resp.result.hash.slice(6)}`;
            }
            if (mode === 'hide-logs' && req1.method === 'eth_getLogs') resp.result = [];
            return resp;
          };
          const out = Array.isArray(payload) ? payload.map((p, i) => doctor(p, answer[i])) : doctor(payload, answer);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (err) {
          // Upstream unreachable: answer like a broken node, never crash the suite.
          const id = Array.isArray(payload) ? null : (payload?.id ?? null);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `proxy upstream: ${err.message}` } }));
        }
      })();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    setMode(next) {
      mode = next;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

export function freshDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

export { ZeroAddress };
