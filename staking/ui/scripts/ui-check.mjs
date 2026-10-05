#!/usr/bin/env node
// Browser check for the staking UI.
//
// Builds the real bundle against a local anvil (port 8612) with the real
// contracts from ../../contracts deployed and seeded (two stakers, one
// registered node with a finalized ≥95% uptime epoch), serves dist, and drives
// it in headless Chromium:
//
//   • stats strip shows the REAL totals (staked / positions / nodes / settled pool)
//   • tier cards show live APY caps
//   • connect via session key (in-memory only; localStorage stays empty)
//   • full stake flow: amount → review (honest confirm table) → sign → done
//   • the new position appears under Positions with claim/unstake actions
//   • the node roster shows the seeded node with bond + uptime + boost
//   • register a node: stake a validator bond in the UI, sign the digest the
//     form shows with the node key, paste it back, see it confirmed
//   • emergency-exit that bond: the node leaves the roster but is still
//     offered for deregistration, and deregisters
//   • the explainer says, verbatim, that staking does not secure the chain
//
// Requirements (both optional — the script SKIPS cleanly without them):
//   • anvil            (foundry)
//   • playwright-core  PLAYWRIGHT_DIR=/dir/containing/node_modules/playwright-core
//     CHROME_PATH=/path/to/chrome (defaults to the ms-playwright cache)
//
// Ports: 8612 (anvil) and 8613 (static server), both released on exit.
// Screenshots land in scripts/../ui-shots (or UI_SHOTS_DIR).

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile as readFileP, mkdir as mkdirP } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Wallet, ContractFactory, JsonRpcProvider, Network, SigningKey, parseEther } from 'ethers';
import { registrationDigest, enodePubkeyBytes } from '../src/lib/nodes.ts';
import { settledRewardPool } from '../src/lib/staking.ts';
import { formatFMX } from '../src/lib/format.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = join(ROOT, '../contracts');
const RPC_PORT = 8612;
const WEB_PORT = 8613;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const DEAD_EXPLORER = 'http://127.0.0.1:9';
const SHOTS = process.env.UI_SHOTS_DIR ?? join(ROOT, 'ui-shots');

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let n = 0;
const ok = (m) => console.log(`  ✓ ${String(++n).padStart(2)}. ${m}`);
const skip = (why) => {
  console.log(`ui-check SKIPPED: ${why}`);
  process.exit(0);
};

async function loadPlaywright() {
  const candidates = [
    'playwright-core',
    ...(process.env.PLAYWRIGHT_DIR ? [join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright-core/index.js')] : []),
  ];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function artifact(name) {
  return JSON.parse(readFileSync(join(CONTRACTS, `out/${name}.sol/${name}.json`), 'utf8'));
}

async function main() {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).error) skip('anvil is not installed');
  const pw = await loadPlaywright();
  if (!pw) skip('playwright-core is not resolvable (set PLAYWRIGHT_DIR)');
  if (!existsSync(CHROME)) skip(`no Chromium at ${CHROME} (set CHROME_PATH)`);
  await mkdirP(SHOTS, { recursive: true });

  execFileSync('forge', ['build'], { cwd: CONTRACTS, stdio: 'pipe' });

  // --- anvil + seeded chain state ---
  const anvil = spawn(
    'anvil',
    ['--port', String(RPC_PORT), '--chain-id', '3961', '--balance', '100000000', '--silent'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const network = Network.from({ chainId: 3961, name: 'ferminux' });
  const provider = new JsonRpcProvider(RPC, network, { staticNetwork: network, cacheTimeout: -1 });
  for (let i = 0; i < 60; i++) {
    try {
      await provider.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const [deployer, alice, bob] = KEYS.map((k) => new Wallet(k, provider));

  const vaultArt = artifact('FMXStaking');
  const vault = await new ContractFactory(vaultArt.abi, vaultArt.bytecode.object, deployer).deploy(
    deployer.address,
    [],
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  const regArt = artifact('NodeRegistry');
  const registry = await new ContractFactory(regArt.abi, regArt.bytecode.object, deployer).deploy(
    vaultAddr,
    deployer.address,
    deployer.address,
  );
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();

  // Explicit gas limits: the accrual-timestamp write makes bare estimates
  // undershoot by a few thousand gas when the block timestamp moves between
  // estimation and execution (same reason the UI lib pins its own limits).
  const gl = { gasLimit: 500_000n };
  await (await vault.initNodeRegistry(registryAddr, gl)).wait();
  await (await vault.fundRewards({ value: parseEther('150000'), ...gl })).wait();
  await (await vault.connect(alice).stake(0, { value: parseEther('1000'), ...gl })).wait();
  await (await vault.connect(bob).stake(3, { value: parseEther('25000'), ...gl })).wait();
  // Node registration: the node key signs the registry's digest (possession proof).
  const nodeKey = new SigningKey('0x' + '5a'.repeat(32));
  const pubkey = enodePubkeyBytes(`enode://${nodeKey.publicKey.slice(4)}@203.0.113.7:30303`);
  const consensusAddr = Wallet.createRandom().address;
  const sig = nodeKey.sign(registrationDigest(3961, registryAddr, bob.address, consensusAddr, 1n));
  await (await registry.connect(bob).registerNode(pubkey, consensusAddr, 1, sig.v, sig.r, sig.s, gl)).wait();
  // One ≥95% epoch, through the 7-day dispute window, finalized.
  const epoch = Math.floor((await provider.getBlock('latest')).timestamp / 86_400) - 1;
  await (await registry.postEpoch(epoch, '0x' + 'ee'.repeat(32), [1], [9_800], gl)).wait();
  await provider.send('evm_increaseTime', [7 * 86_400 + 1]);
  await (await registry.finalizeEpoch(epoch, gl)).wait();
  // The pool the strip must show: the vault's own accrual settled to the head
  // block, the same number the next transaction would leave behind.
  const headTs = BigInt((await provider.getBlock('latest')).timestamp);
  const expectedPool = formatFMX(
    settledRewardPool(
      {
        rewardPool: await vault.rewardPool(),
        totalUnits: await vault.totalUnits(),
        dripPerYear: await vault.dripPerYear(),
        lastAccrual: await vault.lastAccrual(),
      },
      headTs,
    ),
    0,
  );
  ok(`anvil :${RPC_PORT} seeded — pool 150k, 2 positions (1k flex + 25k validator), 1 node boosted by a finalized 98% epoch`);

  // --- build against this deployment ---
  const build = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-ui-check', '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_RPC_URLS: RPC,
      VITE_EXPLORER_URL: DEAD_EXPLORER,
      VITE_STAKING_VAULT: vaultAddr,
      VITE_NODE_REGISTRY: registryAddr,
    },
  });
  if (build.status !== 0) throw new Error('vite build failed');
  const dist = join(ROOT, 'dist-ui-check');
  ok('bundle built against the local deployment');

  const server = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    try {
      const file = join(dist, path === '/' ? 'index.html' : path);
      const body = await readFileP(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));

  const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`);

    // --- stats strip: real numbers ---
    await page.waitForSelector('text=Ferminux · 3961', { timeout: 15_000 });
    const strip = page.locator('.stats-strip');
    await strip.locator('text=26,000').waitFor({ timeout: 15_000 }); // total staked
    assert.equal(await strip.locator('.stat').nth(1).locator('.v').innerText(), '2'); // positions
    await strip.locator('text=not distinct stakers').waitFor();
    assert.equal(await strip.locator('.stat').nth(2).locator('.v').innerText(), '1'); // bonded nodes
    await strip.locator(`text=${expectedPool}`).waitFor(); // reward pool, settled to the head block
    const runwayText = await strip.locator('.stat').nth(3).locator('.sub').innerText();
    assert.match(runwayText, /runs ~\d+(\.\d+)? months|10\+ years/, `runway shown honestly (${runwayText})`);
    ok(`stats strip: 26,000 FMX staked · 2 positions · 1 node · ${expectedPool} pool settled to the head (${runwayText})`);

    // --- tier cards with APY ---
    const validatorCard = page.locator('.tier-card', { hasText: 'Validator track' });
    await validatorCard.locator('text=20%').waitFor();
    await validatorCard.locator('text=cap 30%').waitFor();
    await validatorCard.locator('text=Locked until block 4,680,000').waitFor();
    await page.locator('text=Min 25,000 FMX bond').waitFor();
    await page.screenshot({ path: join(SHOTS, '1-stake.png') });
    ok('tier cards: 4 tiers with live APY; validator 20% base, 30% boosted cap, block-height lock, 25k minimum');

    // --- connect a session key (dave) ---
    await page.click('button:has-text("Connect wallet")');
    await page.click('button:has-text("Session key")');
    await page.fill('#connect-secret', KEYS[3]);
    await page.click('button:has-text("Unlock")');
    await page.waitForSelector('.wallet-chip', { timeout: 10_000 });
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    assert.equal(stored, '[]', 'localStorage must hold nothing (keys live in memory only)');
    ok('session key connected; localStorage is empty — nothing persisted');

    // --- stake 500 FMX flexible ---
    await page.click('.tier-card >> nth=0');
    await page.fill('#stake-amount', '500');
    await page.locator('text=You are locking').waitFor();
    await page.click('button:has-text("Review stake")');
    await page.locator('.confirm-table').waitFor();
    await page.locator('text=7-day cooldown').first().waitFor();
    await page.screenshot({ path: join(SHOTS, '2-confirm.png') });
    await page.click('button:has-text("Sign and stake")');
    await page.locator('.notice-success', { hasText: 'Staked 500 FMX' }).waitFor({ timeout: 20_000 });
    await page.click('.modal button:has-text("Done")');
    ok('stake flow: honest confirm table → signed → confirmed on chain');

    // --- position appears ---
    await page.click('[role=tab]:has-text("Positions")');
    await page.locator('.row-list li', { hasText: 'Flexible' }).waitFor({ timeout: 15_000 });
    await page.locator('.state-badge', { hasText: 'ACTIVE' }).waitFor();
    await page.locator('text=500 FMX').waitFor();
    await page.locator('button:has-text("Start unstake")').waitFor();
    await page.screenshot({ path: join(SHOTS, '3-positions.png') });
    ok('positions: the new 500 FMX stake shows ACTIVE with unstake action');

    // --- stats updated to include the new stake ---
    await page.locator('.stats-strip >> text=26,500').waitFor({ timeout: 15_000 });
    assert.equal(await strip.locator('.stat').nth(1).locator('.v').innerText(), '3'); // positions
    ok('stats strip re-read from chain: total staked now 26,500 FMX across 3 positions');

    // --- node roster ---
    await page.click('[role=tab]:has-text("Nodes")');
    await page.locator('.roster-table').waitFor();
    await page.locator('td', { hasText: '25,000 FMX' }).waitFor();
    await page.locator('td', { hasText: '98%' }).waitFor();
    assert.equal(await page.locator('.roster-table tbody tr').first().locator('td').nth(4).innerText(), 'on'); // boost
    await page.locator('text=not a count of distinct operators').waitFor();
    await page.screenshot({ path: join(SHOTS, '4-nodes.png') });
    // This wallet holds no validator-track position: the form says so instead of asking for a node key.
    await page.click('button:has-text("Register a node")');
    await page.locator('.modal', { hasText: 'You have none right' }).waitFor({ timeout: 10_000 });
    await page.click('.modal button:has-text("Close")');
    ok('nodes: roster shows the bonded node (25,000 FMX, 98% uptime, boost on); register form refuses a wallet with no bond');

    // --- register a node through the form: stake a validator bond in the UI,
    //     sign the digest the form SHOWS with the node key, paste it back ---
    await page.click('[role=tab]:has-text("Stake")');
    await page.click('.tier-card:has-text("Validator track")');
    await page.fill('#stake-amount', '25000');
    await page.click('button:has-text("Review stake")');
    await page.click('button:has-text("Sign and stake")');
    await page.locator('.notice-success', { hasText: 'Staked 25,000 FMX' }).waitFor({ timeout: 20_000 });
    await page.click('.modal button:has-text("Done")');
    await page.click('[role=tab]:has-text("Nodes")');
    await page.click('button:has-text("Register a node")');
    const daveNode = new SigningKey('0x' + '7c'.repeat(32));
    await page.fill('#reg-consensus', Wallet.createRandom().address);
    await page.fill('#reg-enode', `enode://${daveNode.publicKey.slice(4)}@198.51.100.9:30303`);
    const shownDigest = /0x[0-9a-f]{64}/.exec(await page.locator('.modal code').innerText())[0];
    await page.fill('#reg-sig', daveNode.sign(shownDigest).serialized);
    await page.screenshot({ path: join(SHOTS, '4b-register.png') });
    await page.click('.modal button:has-text("Register node")');
    await page.locator('.modal .notice-success', { hasText: 'Node registered' }).waitFor({ timeout: 20_000 });
    await page.click('.modal button:has-text("Done")');
    await page.locator('.roster-table tbody tr').nth(1).waitFor({ timeout: 15_000 });
    ok('register a node: validator bond staked in the UI, the digest it shows signed by the node key, registered on chain');

    // --- that bond exits: its node leaves the roster but stays registered, and
    //     Deregister is still offered for it outside the roster ---
    await page.click('[role=tab]:has-text("Positions")');
    await page.click('button:has-text("Emergency exit")');
    await page.click('.modal button:has-text("Forfeit and exit")');
    await page.locator('.state-badge', { hasText: 'COOLING DOWN' }).waitFor({ timeout: 20_000 });
    await page.click('[role=tab]:has-text("Nodes")');
    const outside = page.locator('.notice', { hasText: 'Your nodes outside the roster' });
    await outside.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.roster-table').first().locator('tbody tr').count(), 1, 'only the seeded node is live');
    await page.screenshot({ path: join(SHOTS, '4c-outside-roster.png') });
    await outside.locator('button:has-text("Deregister")').click();
    await page.locator('.modal', { hasText: 'registered again on an active validator-track bond' }).waitFor();
    await page.click('.modal button:has-text("Deregister node")');
    await page.locator('.modal .notice-success', { hasText: 'deregistered' }).waitFor({ timeout: 20_000 });
    await page.click('.modal button:has-text("Done")');
    await outside.waitFor({ state: 'detached', timeout: 15_000 });
    ok('exited bond: its node leaves the roster, is listed outside it, and deregisters from there');

    // --- explainer honesty ---
    await page.click('[role=tab]:has-text("How it works")');
    await page.locator('text=staking does not secure the chain').waitFor();
    await page.locator('text=fail-closed').waitFor();
    await page.screenshot({ path: join(SHOTS, '5-explainer.png') });
    ok('explainer: says outright that staking does not secure the chain and the pool is fail-closed');

    assert.deepEqual(errors, [], `no uncaught page errors (got: ${errors.join(' | ')})`);
    ok('zero uncaught browser errors across the whole run');
  } finally {
    await browser.close();
    server.close();
    provider.destroy();
    anvil.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
  }

  console.log(`\nui-check: all checks passed. Screenshots in ${SHOTS}`);
}

main().catch((err) => {
  console.error('\nui-check FAILED:', err);
  process.exit(1);
});
