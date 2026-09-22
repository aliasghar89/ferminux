#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Browser check for the Ferminux DEX UI.
//
// Builds the REAL bundle against a local anvil that has the AMM deployed and
// two pools seeded (one of them with 60% of its LP time-locked), serves it, and
// drives it in headless Chromium:
//
//   • the shell renders and the footer reports a live block height
//   • Pools lists both pools with reserves, price and the LOCKED badge, and
//     expands to the individual locks
//   • Swap quotes live through the router: amount out, price impact, minimum
//     received, and the slippage/deadline settings change the numbers
//   • a large trade raises the >3% warning and the >10% typed confirmation
//   • the token selector filters and switches tokens
//   • an injected wallet connects and a REAL swap is signed and mined — the
//     on-chain balance is checked afterwards
//   • Liquidity shows the connected account's positions
//   • the page is checked at 390 px wide for horizontal overflow
//   • the SHIPPED default (no addresses configured) renders the "Not
//     configured" screen naming all four missing addresses
//   • the Bridge tab mounts across the @bridge alias, shows its direction, and
//     offers no send until a wallet is connected
//
// Screenshots are written next to the temporary build and the path is printed.
//
//   node scripts/ui-check.mjs        (or: npm run ui)
//
// Requirements — ALL optional; the script skips cleanly (exit 0) without them:
//   • anvil (foundry) on PATH
//   • playwright-core:  PLAYWRIGHT_DIR=/dir/containing/node_modules/playwright-core
//   • a Chromium build: CHROME_PATH=/path/to/binary
//     (both are auto-detected from the usual caches on this workstation)
//
// Ports: anvil on 8602 (this component's assigned port); the static server
// takes an OS-assigned ephemeral port so it cannot collide with anything.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Contract, ContractFactory, Wallet, formatEther, parseEther, parseUnits } from 'ethers';

import { CHAIN_ID } from '../src/config.ts';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';
import { approveToken, fetchBalance, nativeToken } from '../src/lib/tokens.ts';
import { addLiquidity, quoteAddLiquidity } from '../src/lib/liquidity.ts';
import { TokenMetaCache, approveLp, fetchLpBalance, findPair } from '../src/lib/pairs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RPC_PORT = 8602;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Deliberately dead: exercises the "explorer link never fetched" path.
const DEAD_EXPLORER = 'http://127.0.0.1:9';

const DEX_OUT = (name, contract = name) =>
  fileURLToPath(new URL(`../../contracts/out/${name}.sol/${contract}.json`, import.meta.url));
const CORE_OUT = (name) => fileURLToPath(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url));

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}. ${msg}`);
const skip = (why) => {
  console.log(`ui-check SKIPPED: ${why}`);
  process.exit(0);
};

// ------------------------------------------------------------ discovery ----

async function findPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_DIR,
    join(homedir(), 'karvan-invest'),
    join(homedir(), 'claude-code-video-toolkit', 'playwright'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const entry = join(dir, 'node_modules', 'playwright-core', 'index.js');
    if (existsSync(entry)) return (await import(`file://${entry}`)).default ?? (await import(`file://${entry}`));
  }
  return null;
}

async function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/puppeteer/chrome')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of (await readdir(root)).sort().reverse()) {
      for (const suffix of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const candidate = join(root, dir, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

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

async function deploy(artifactPath, signer, args = []) {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return { address: await contract.getAddress(), abi: artifact.abi };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

// ----------------------------------------------------------------- main ----

async function main() {
  if (spawnSync('anvil', ['--version']).error) skip('anvil is not on PATH');
  const playwright = await findPlaywright();
  if (!playwright?.chromium) skip('playwright-core not found (set PLAYWRIGHT_DIR)');
  const chromePath = await findChrome();
  if (!chromePath) skip('no Chromium build found (set CHROME_PATH)');
  if (!(await portFree(RPC_PORT))) skip(`port ${RPC_PORT} is busy — stop the dev server or the e2e first`);

  const workDir = await mkdtemp(join(tmpdir(), 'ferminux-dex-ui-'));
  const distDir = join(workDir, 'dist');
  // The static server serves whatever this points at, so the same page URL can
  // be re-used for the second, deliberately unconfigured build.
  let distRoot = distDir;

  const anvil = spawn(
    'anvil',
    ['--port', String(RPC_PORT), '--chain-id', String(CHAIN_ID), '--balance', '100000', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const anvilExit = new Promise((resolve) => anvil.once('exit', resolve));
  let server = null;
  let browser = null;

  try {
    for (let i = 0; i < 60 && !(await probeRpc(RPC, CHAIN_ID, 1000)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    ok(`anvil up on :${RPC_PORT}`);

    // --- devnet: deploy the AMM, seed two pools, lock most of one pool's LP --
    const { provider } = await connectRpc([RPC], CHAIN_ID, 3000);
    const deployer = new Wallet(KEY0, provider);
    const wfmx = await deploy(DEX_OUT('WFMX'), deployer);
    const factory = await deploy(DEX_OUT('FerminuxFactory'), deployer, [deployer.address]);
    const router = await deploy(DEX_OUT('FerminuxRouter'), deployer, [factory.address, wfmx.address]);
    const locker = await deploy(DEX_OUT('LiquidityLocker'), deployer);
    const addresses = { factory: factory.address, router: router.address, wfmx: wfmx.address, locker: locker.address };

    const seed = await deploy(DEX_OUT('SeedPool.s', 'SeedDemoToken'), deployer, [
      deployer.address,
      parseEther('1000000'),
    ]);
    const aznt = await deploy(CORE_OUT('AZNT'), deployer, [deployer.address]);
    const azntAdmin = new Contract(aznt.address, aznt.abi, deployer);
    await (await azntAdmin.grantRole(await azntAdmin.MINTER(), deployer.address)).wait();
    await (await azntAdmin.mint(deployer.address, parseUnits('500000', 6))).wait();

    const cache = new TokenMetaCache(addresses.wfmx);
    const seedToken = await cache.get(provider, seed.address);
    const azntToken = await cache.get(provider, aznt.address);
    const fmx = nativeToken(addresses.wfmx);

    await (await approveToken(deployer, seedToken, addresses.router, parseEther('100000'))).wait();
    await (await approveToken(deployer, azntToken, addresses.router, parseUnits('100000', 6))).wait();
    await (
      await addLiquidity(
        deployer,
        addresses,
        quoteAddLiquidity(null, seedToken, fmx, 'A', parseEther('10000'), 50, parseEther('5000')),
        deployer.address,
        20,
      )
    ).wait();
    await (
      await addLiquidity(
        deployer,
        addresses,
        quoteAddLiquidity(null, azntToken, fmx, 'A', parseUnits('20000', 6), 50, parseEther('10000')),
        deployer.address,
        20,
      )
    ).wait();

    const seedPair = await findPair(provider, addresses, seedToken.address, addresses.wfmx);
    const lp = await fetchLpBalance(provider, seedPair, deployer.address);
    const lockAmount = (lp * 60n) / 100n;
    await (await approveLp(deployer, seedPair, addresses.locker, lockAmount)).wait();
    const lockerWrite = new Contract(addresses.locker, locker.abi, deployer);
    const unlockAt = (await provider.getBlock('latest')).timestamp + 365 * 24 * 3600;
    await (await lockerWrite.lock(seedPair, lockAmount, unlockAt)).wait();
    ok('devnet ready: 2 pools seeded, 60% of the SEED/FMX LP locked for a year');

    // --- build the real bundle against this devnet ---------------------------
    const build = spawnSync('node', [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', distDir], {
      cwd: ROOT,
      env: {
        ...process.env,
        VITE_RPC_URLS: RPC,
        VITE_EXPLORER_URL: DEAD_EXPLORER,
        VITE_FACTORY_ADDRESS: addresses.factory,
        VITE_ROUTER_ADDRESS: addresses.router,
        VITE_WFMX_ADDRESS: addresses.wfmx,
        VITE_LOCKER_ADDRESS: addresses.locker,
      },
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`vite build failed:\n${build.stdout}\n${build.stderr}`);
    ok('built the production bundle against the devnet addresses');

    // --- serve it -----------------------------------------------------------
    server = createServer(async (req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      // The app ships no favicon; answer the browser's automatic request so the
      // console-error assertion below only ever sees real application errors.
      if (path === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      const file = join(distRoot, path === '/' ? 'index.html' : path);
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const webPort = server.address().port;
    const pageUrl = `http://127.0.0.1:${webPort}/`;

    // --- browser ------------------------------------------------------------
    browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });

    // A minimal EIP-1193 provider that forwards to anvil, whose dev accounts
    // are unlocked — so the page really signs and really mines.
    await context.addInitScript((rpcUrl) => {
      let id = 0;
      window.ethereum = {
        isFerminuxTestShim: true,
        async request({ method, params }) {
          const call = method === 'eth_requestAccounts' ? 'eth_accounts' : method;
          const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: call, params: params ?? [] }),
          });
          const json = await res.json();
          if (json.error) {
            const err = new Error(json.error.message);
            err.code = json.error.code;
            throw err;
          }
          return json.result;
        },
        on() {},
        removeListener() {},
      };
    }, RPC);

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(pageUrl, { waitUntil: 'networkidle' });

    await page.waitForSelector('.brand');
    assert.match(await page.textContent('.brand'), /Ferminux/);
    await page.waitForFunction(() => /Block [1-9]/.test(document.querySelector('.app-footer')?.textContent ?? ''), {
      timeout: 15000,
    });
    ok('shell rendered; footer reports a live block height from the devnet');

    // --- Bridge tab -------------------------------------------------------
    // The panel reads two live chains, so nothing here asserts on registry
    // content — that belongs to the bridge app's own e2e against two anvils.
    // What this pins is that the tab exists, mounts without throwing, and knows
    // its direction. The mount is the part that regressed: the panel imports
    // across package boundaries via the @bridge alias, and a broken alias fails
    // at runtime with a blank tab, not at build time.
    await page.click('.tab:has-text("Bridge")');
    await page.waitForSelector('.panel');
    const bridgeText = await page.textContent('.panel');
    assert.match(bridgeText, /Ferminux\s*→\s*BSC/, 'the Bridge tab must render its direction control');
    assert.doesNotMatch(bridgeText, /not configured/i, 'the deployed addresses are tracked defaults, so it must be configured');
    // No wallet is connected at this point in the run.
    const bridgeBtn = page.locator('.panel button.btn-primary');
    assert.equal(await bridgeBtn.textContent(), 'Connect a wallet', 'no send may be offered without a wallet');
    assert.equal(await bridgeBtn.isDisabled(), true, 'and it must be disabled');
    await page.screenshot({ path: join(workDir, '00-bridge.png'), fullPage: true });
    ok('Bridge tab mounts across the @bridge alias, shows Ferminux → BSC, and gates on a wallet');

    // --- Pools --------------------------------------------------------------
    await page.click('.tab:has-text("Pools")');
    await page.waitForSelector('.pool-head');
    const poolCount = await page.locator('.pool-head').count();
    assert.equal(poolCount, 2, `expected 2 pools, saw ${poolCount}`);
    const lockedBadges = await page.locator('.tag-lock').count();
    assert.ok(lockedBadges >= 1, 'the SEED/FMX pool must show a LOCKED badge');
    const lockedRow = page.locator('.pool', { has: page.locator('.tag-lock') }).first();
    assert.match(await lockedRow.textContent(), /of LP/, 'the badge states what share of LP supply is locked');
    assert.match(await lockedRow.textContent(), /unlocks in \d+ (year|month|day)/, 'and when it unlocks');
    const notLocked = await page.locator('.tag-open').count();
    assert.equal(notLocked, 1, 'the unlocked pool must be labelled NOT LOCKED');
    await lockedRow.locator('.pool-head').click();
    await page.waitForSelector('.pool-body');
    assert.match(await page.textContent('.pool-body'), /Lock #0/, 'the lock breakdown lists the individual lock');
    await page.screenshot({ path: join(workDir, '01-pools.png'), fullPage: true });
    ok(`Pools: 2 pools, LOCKED badge with share + unlock date, lock breakdown expanded`);

    // --- Swap: live quote ---------------------------------------------------
    await page.click('.tab:has-text("Swap")');
    await page.waitForSelector('.amount-input');
    await page.fill('.amount-input', '5');
    await page.waitForSelector('.quote-box', { timeout: 15000 });
    const quoteText = await page.textContent('.quote-box');
    assert.match(quoteText, /Price impact/);
    assert.match(quoteText, /Minimum received/);
    assert.match(quoteText, /Liquidity provider fee/);
    assert.match(quoteText, /0\.30%/, 'one hop = 0.30%');
    const outText = await page.textContent('.amount-output');
    assert.match(outText, /^9\.96/, `expected ~9.96 SEED out, saw "${outText}"`);
    assert.match(quoteText, /0\.39%/, 'the published 39 bps impact for this trade size');
    await page.screenshot({ path: join(workDir, '02-swap-quote.png'), fullPage: true });
    ok(`Swap: 5 FMX quoted live through the router → ${outText.trim()} SEED, impact 0.39%`);

    // --- Swap: settings change the bound ------------------------------------
    const minBefore = await page.locator('.stat-row', { hasText: 'Minimum received' }).textContent();
    await page.click('.panel-head .btn-ghost');
    await page.waitForSelector('.settings-box');
    await page.click('.seg:has-text("1%")');
    await page.waitForTimeout(400);
    const minAfter = await page.locator('.stat-row', { hasText: 'Minimum received' }).textContent();
    assert.notEqual(minBefore, minAfter, 'a wider slippage tolerance must lower the minimum received');
    assert.match(minAfter, /1%/);
    await page.fill('#swap-deadline', '5');
    assert.match(await page.textContent('.panel-head .btn-ghost'), /1% slippage · 5m/);
    await page.click('.seg:has-text("0.5%")');
    await page.click('.panel-head .btn-ghost');
    ok('Swap settings: slippage presets and the deadline update the quote and the header');

    // --- Swap: impact warnings ----------------------------------------------
    await page.fill('.amount-input', '200');
    await page.waitForFunction(
      () => document.body.textContent.includes('This pool is shallow relative to your trade'),
      { timeout: 15000 },
    );
    ok('a 200 FMX trade raises the >3% price-impact warning');

    await page.fill('.amount-input', '1200');
    await page.waitForFunction(() => document.body.textContent.includes('needs a typed confirmation'), {
      timeout: 15000,
    });
    await page.screenshot({ path: join(workDir, '03-swap-severe.png'), fullPage: true });
    ok('a 1200 FMX trade raises the >10% danger notice');

    // --- connect the injected wallet ---------------------------------------
    await page.click('.app-header .btn:has-text("Connect")');
    await page.waitForFunction(() => /0x[0-9a-fA-F]{4}…/.test(document.querySelector('.app-header')?.textContent ?? ''), {
      timeout: 15000,
    });
    ok('connected the injected wallet; the header shows the account');

    // The severe-impact swap must demand a typed confirmation.
    await page.click('.action-stack .btn-primary:has-text("Swap")');
    await page.waitForSelector('.modal:has-text("High price impact")');
    const confirmButton = page.locator('.modal .btn-primary:has-text("Swap anyway")');
    assert.equal(await confirmButton.isDisabled(), true, 'the confirm button starts disabled');
    await page.fill('#impact-confirm', 'I understand');
    assert.equal(await confirmButton.isDisabled(), false);
    await page.screenshot({ path: join(workDir, '04-impact-confirm.png') });
    await page.click('.modal .btn:has-text("Cancel")');
    ok('the >10% confirmation modal really blocks until "I understand" is typed');

    // --- token selector ------------------------------------------------------
    await page.locator('.amount-box').nth(1).locator('.token-button').click();
    await page.waitForSelector('.token-list');
    await page.fill('.modal .input', 'AZNT');
    await page.waitForSelector('.token-row:has-text("AZNT")');
    await page.screenshot({ path: join(workDir, '05-token-select.png') });
    await page.click('.token-row:has-text("AZNT")');
    await page.waitForFunction(
      () => document.querySelectorAll('.token-button')[1]?.textContent.includes('AZNT'),
      { timeout: 10000 },
    );
    ok('token selector filtered to AZNT and switched the output token');

    // --- a REAL swap, signed in the page ------------------------------------
    await page.locator('.amount-box').nth(1).locator('.token-button').click();
    await page.waitForSelector('.token-list');
    await page.fill('.modal .input', 'SEED');
    await page.click('.token-row:has-text("SEED")');
    await page.fill('.amount-input', '5');
    await page.waitForSelector('.quote-box', { timeout: 15000 });

    const traderBefore = await fetchBalance(provider, seedToken, deployer.address);
    await page.click('.action-stack .btn-primary:has-text("Swap")');
    await page.waitForFunction(() => document.body.textContent.includes('Swapped'), { timeout: 30000 });
    const traderAfter = await fetchBalance(provider, seedToken, deployer.address);
    assert.ok(traderAfter > traderBefore, 'the SEED balance must actually have grown on chain');
    await page.screenshot({ path: join(workDir, '06-swap-done.png'), fullPage: true });
    ok(`swapped 5 FMX in the browser: +${formatEther(traderAfter - traderBefore).slice(0, 8)} SEED confirmed on chain`);

    // --- Liquidity ----------------------------------------------------------
    await page.click('.tab:has-text("Liquidity")');
    await page.waitForSelector('.position-head', { timeout: 20000 });
    const positionCount = await page.locator('.position-head').count();
    assert.equal(positionCount, 2, `expected 2 LP positions, saw ${positionCount}`);
    assert.match(await page.textContent('.position-head'), /of pool/);
    await page.locator('.position-head').first().click();
    await page.waitForSelector('.slider');
    assert.match(await page.textContent('.position-body'), /You receive/);
    // The locked LP section must show the year-long lock.
    assert.match(await page.textContent('body'), /Your locked LP/);
    await page.screenshot({ path: join(workDir, '07-liquidity.png'), fullPage: true });
    ok('Liquidity: 2 positions with share of pool, remove-slider quote, and the locked-LP list');

    // --- new-pair explainer --------------------------------------------------
    // The B side already defaults to SEED (the pooled counterpart), so switching
    // A to the devnet AZNT asks for a SEED/AZNT pool, which does not exist.
    await page.locator('.amount-box').first().locator('.token-button').click();
    await page.waitForSelector('.token-list');
    await page.fill('.modal .input', 'AZNT');
    await page.locator('.token-row:has-text("AZNT")').last().click();
    await page.waitForSelector('.new-pool-box', { timeout: 10000 });
    const newPoolText = await page.textContent('.new-pool-box');
    assert.match(newPoolText, /The ratio you deposit becomes the price/);
    assert.match(newPoolText, /arbitrage/);
    await page.screenshot({ path: join(workDir, '08-new-pool.png'), fullPage: true });
    ok('picking a pair with no pool shows the first-depositor explanation and the acknowledgement');

    // --- responsive ---------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('.tab:has-text("Pools")');
    await page.waitForSelector('.pool-head');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px at 390px wide`);
    await page.screenshot({ path: join(workDir, '09-mobile-pools.png'), fullPage: true });
    ok('at 390px wide the page does not scroll horizontally');

    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
    ok('no console errors or unhandled page exceptions during the whole run');

    // --- an unconfigured build renders the "Not configured" screen ----------
    // The shipped defaults carry the live mainnet addresses since the 2026-08-20
    // deployment, so the unconfigured state is now produced explicitly: blank
    // VITE_ addresses ('' is not nullish, so it overrides the defaults and
    // fails the 0x… validation) — exactly what a devnet operator building
    // against not-yet-deployed contracts sees.
    const plainDist = join(workDir, 'dist-unconfigured');
    const plainBuild = spawnSync(
      'node',
      [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', plainDist],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          VITE_RPC_URLS: RPC,
          VITE_FACTORY_ADDRESS: '',
          VITE_ROUTER_ADDRESS: '',
          VITE_WFMX_ADDRESS: '',
          VITE_LOCKER_ADDRESS: '',
        },
        encoding: 'utf8',
      },
    );
    if (plainBuild.status !== 0) throw new Error(`unconfigured build failed:\n${plainBuild.stderr}`);
    distRoot = plainDist; // the static server reads this on the next request
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.panel-head:has-text("Not configured")');
    const missingRows = await page.locator('.row-title').count();
    assert.equal(missingRows, 4, 'all four unset addresses must be named');
    assert.equal(await page.locator('.tabs').count(), 0, 'no tabs are offered with nothing to read');
    await page.screenshot({ path: join(workDir, '10-not-configured.png'), fullPage: true });
    ok('a build with blanked addresses renders the "Not configured" screen naming all four');

    console.log(`\nScreenshots: ${workDir}`);
    provider.destroy();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
    anvil.kill('SIGTERM');
    await Promise.race([anvilExit, new Promise((r) => setTimeout(r, 5000))]);
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
    await anvilExit;
  }

  console.log('\nUI check: all assertions passed.');
}

main().catch((err) => {
  console.error('\nUI CHECK FAILED:', err);
  process.exit(1);
});
