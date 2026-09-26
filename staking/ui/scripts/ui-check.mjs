#!/usr/bin/env node
// Browser check for the staking UI.
//
// Builds the real bundle against a local anvil (port 8612) with the fixture
// contracts deployed and seeded (two stakers, one registered + attested node),
// serves dist, and drives it in headless Chromium:
//
//   • stats strip shows the REAL totals (staked / stakers / nodes / pool)
//   • tier cards show live APY caps
//   • connect via session key (in-memory only; localStorage stays empty)
//   • full stake flow: amount → review (honest confirm table) → sign → done
//   • the new position appears under Positions with claim/unstake actions
//   • the node roster shows the seeded node with bond + uptime
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
import { Wallet, ContractFactory, JsonRpcProvider, Network, parseEther } from 'ethers';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
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
  return JSON.parse(readFileSync(join(FIXTURES, `out/${name}.sol/${name}.json`), 'utf8'));
}

async function main() {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).error) skip('anvil is not installed');
  const pw = await loadPlaywright();
  if (!pw) skip('playwright-core is not resolvable (set PLAYWRIGHT_DIR)');
  if (!existsSync(CHROME)) skip(`no Chromium at ${CHROME} (set CHROME_PATH)`);
  await mkdirP(SHOTS, { recursive: true });

  execFileSync('forge', ['build'], { cwd: FIXTURES, stdio: 'pipe' });

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

  const vaultArt = artifact('StakingVaultFixture');
  const vault = await new ContractFactory(vaultArt.abi, vaultArt.bytecode.object, deployer).deploy(
    parseEther('1200000'),
    7 * 86_400,
    365 * 86_400,
    [],
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  const regArt = artifact('NodeRegistryFixture');
  const registry = await new ContractFactory(regArt.abi, regArt.bytecode.object, deployer).deploy(
    vaultAddr,
    3,
    parseEther('25000'),
    deployer.address,
  );
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();

  // Explicit gas limits: the accrual-timestamp write makes bare estimates
  // undershoot by a few thousand gas when the block timestamp moves between
  // estimation and execution (same reason the UI lib pins its own limits).
  const gl = { gasLimit: 500_000n };
  await (await vault.fundPool({ value: parseEther('150000'), ...gl })).wait();
  await (await vault.connect(alice).stake(0, { value: parseEther('1000'), ...gl })).wait();
  await (await vault.connect(bob).stake(3, { value: parseEther('25000'), ...gl })).wait();
  const enodeId = '0x' + 'ab'.repeat(32);
  await (await registry.connect(bob).registerNode(1, Wallet.createRandom().address, enodeId, gl)).wait();
  await (await registry.attest([0], [9_800], gl)).wait();
  ok(`anvil :${RPC_PORT} seeded — pool 150k, 2 stakers (1k flex + 25k validator), 1 attested node`);

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
    assert.equal(await strip.locator('.stat').nth(1).locator('.v').innerText(), '2'); // stakers
    assert.equal(await strip.locator('.stat').nth(2).locator('.v').innerText(), '1'); // bonded nodes
    await strip.locator('text=150,000').waitFor(); // reward pool
    const runwayText = await strip.locator('.stat').nth(3).locator('.sub').innerText();
    assert.match(runwayText, /runs ~\d+(\.\d+)? months|10\+ years/, `runway shown honestly (${runwayText})`);
    ok(`stats strip: 26,000 FMX staked · 2 stakers · 1 node · 150,000 pool (${runwayText})`);

    // --- tier cards with APY ---
    await page.locator('.tier-card', { hasText: 'Validator track' }).waitFor();
    await page.locator('.tier-card', { hasText: '30%' }).waitFor();
    await page.locator('text=Min 25,000 FMX bond').waitFor();
    await page.screenshot({ path: join(SHOTS, '1-stake.png') });
    ok('tier cards: 4 tiers with live APY, validator minimum + node requirement shown');

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
    ok('stats strip re-read from chain: total staked now 26,500 FMX');

    // --- node roster ---
    await page.click('[role=tab]:has-text("Nodes")');
    await page.locator('.roster-table').waitFor();
    await page.locator('td', { hasText: '25,000 FMX' }).waitFor();
    await page.locator('td', { hasText: '98%' }).waitFor();
    await page.locator('text=not a count of distinct operators').waitFor();
    await page.screenshot({ path: join(SHOTS, '4-nodes.png') });
    ok('nodes: roster shows the bonded node (25,000 FMX, 98% uptime) with the distinct-operator honesty note');

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
