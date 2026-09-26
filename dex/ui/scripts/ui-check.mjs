#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Browser check of the built DEX against an anvil FORK of chain 3961.
//
// The fork carries the live contracts and pool; scripts/fork.mjs adds the
// $0.52 USDF market. The REAL production bundle is built against the fork
// (only the RPC URL differs from the shipped build), served, and driven in
// Chrome with a minimal injected EIP-1193 provider that forwards to anvil,
// whose dev accounts are unlocked, so the page really signs and anvil really
// confirms. Checked:
//
//   • shell, live block height, the five pages and the pool detail render
//   • Pools: every pool with TVL at the $0.52 basis, LOCKED / Not locked
//   • Charts: the official $0.52 and a line per FMX pool; Analytics KPIs
//   • Swap: live quote, route, impact, minimum received, settings; a large
//     FMX → USDF order routes through AZNT; token picker search
//   • wallet: connect through the chooser; a swap signed in the page settles
//     on chain; a USDF → FMX swap walks the approve-then-swap flow
//   • a wallet that moved off chain 3961 mid-review is refused before signing
//   • Liquidity: add at the pool ratio, the position appears, remove 50%
//   • Activity: the account's swaps and deposits, read from the chain
//   • at 320, 390 and 1440 px every page fits: no horizontal scroll
//   • no console errors; a build with blanked addresses says "Not configured"
//
//   npm run ui       PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs (or PLAYWRIGHT_DIR)
//
// Skips cleanly (exit 0) without anvil or Playwright. Nothing leaves 127.0.0.1
// except the fork's own reads of rpc.ferminux.net.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { formatUnits } from 'ethers';

import { DEX_ADDRESSES } from '../src/config.ts';
import { fetchBalance, fetchAllowance } from '../src/lib/tokens.ts';
import { USDF, forkProvider, haveAnvil, seedMarket, startFork } from './fork.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.DEX_TEST_PORT) || 8602;
const DEAD_EXPLORER = 'http://127.0.0.1:9';
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil dev account #1: unlocked on the fork
const WIDTHS = [320, 390, 1440];

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}. ${msg}`);
const skip = (why) => {
  console.log(`ui-check SKIPPED: ${why}`);
  process.exit(0);
};

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    process.env.PLAYWRIGHT_DIR && join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs'),
    process.env.PLAYWRIGHT_DIR && join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright-core/index.mjs'),
    join(ROOT, 'node_modules/playwright/index.mjs'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return import(c);
  return null;
}

const PAUSED_STATUS = (now) => ({
  generatedAt: now,
  chains: [
    {
      name: 'ferminux',
      chainId: 3961,
      confirmations: 64,
      finality: {
        mode: 'work-and-time',
        pace: { state: 'ok', targetBlockTimeMs: 7000, medianGapMs: 7000, samples: 32, headNumber: 1, headAgeMs: 1000, reason: null },
        checkpoint: { state: 'unreadable', number: null, hash: null, attestedAt: null, ageMs: null, maxAgeMs: 21600000, lagBlocks: null, hashVerified: false, reason: 'fixture' },
        signing: { paused: true, reason: 'fixture: checkpoint unreadable' },
      },
    },
    { name: 'bsc', chainId: 56, confirmations: 20, finality: { mode: 'count', pace: null, checkpoint: null, signing: { paused: false, reason: null } } },
  ],
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

function build(outDir, env) {
  const r = spawnSync('node', [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
}

async function main() {
  if (!haveAnvil()) skip('anvil is not on PATH');
  const pw = await loadPlaywright();
  if (!pw?.chromium) skip('Playwright not found (set PLAYWRIGHT_MODULE or PLAYWRIGHT_DIR)');

  const work = await mkdtemp(join(tmpdir(), 'ferminux-dex-ui-'));
  const fork = await startFork(PORT);
  let server = null;
  let browser = null;
  let provider = null;
  let page = null;
  try {
    provider = await forkProvider(fork.rpc);
    const m = await seedMarket(provider);
    ok(`fork of chain 3961 on :${PORT} with the $0.52 market (WFMX/USDF, WFMX/AZNT moved to $0.52, AZNT/USDF)`);

    let distRoot = join(work, 'dist');
    build(distRoot, { VITE_RPC_URLS: fork.rpc, VITE_EXPLORER_URL: DEAD_EXPLORER, VITE_ENABLE_BRIDGE: '1', VITE_RELAYER_STATUS_URL: './status.json' });
    ok('built the production bundle against the fork (shipped contract addresses, local RPC)');

    server = createServer(async (req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (path === '/favicon.ico') return void res.writeHead(204).end();
      if (path === '/status.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(PAUSED_STATUS(Date.now())));
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
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;

    browser = await pw.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addInitScript(
      ([rpcUrl, account]) => {
        let id = 0;
        const listeners = {};
        window.ethereum = {
          isFerminuxTestShim: true,
          async request({ method, params }) {
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
            // A wallet that has moved to another chain before the page heard about it.
            if (method === 'eth_chainId' && window.__chainOverride) return window.__chainOverride;
            const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
            const json = await res.json();
            if (json.error) {
              const err = new Error(json.error.message);
              err.code = json.error.code;
              err.data = json.error.data;
              throw err;
            }
            return json.result;
          },
          on(ev, fn) {
            (listeners[ev] ??= []).push(fn);
          },
          removeListener() {},
        };
      },
      [fork.rpc, ME],
    );
    page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/bsc|bnbchain|publicnode|ERR_NAME_NOT_RESOLVED|Failed to load resource/i.test(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = (name) => page.screenshot({ path: join(work, `${name}.png`), fullPage: true });
    const go = async (search) => {
      await page.goto(url + search, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topbar');
    };

    // ---- shell ------------------------------------------------------------
    await go('');
    await page.waitForFunction(() => /Block [1-9]/.test(document.querySelector('[data-testid=foot-block]')?.textContent ?? ''), null, { timeout: 30000 });
    assert.match(await page.textContent('.topnav'), /Swap.*Pools.*Liquidity.*Charts.*Activity/s);
    ok('shell: one-bar header with the five pages, live block height in the footer');

    // ---- Pools --------------------------------------------------------------
    await go('?tab=pools');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=pool-row]').length >= 3, null, { timeout: 30000 });
    await page.waitForFunction(() => !/lock unknown/.test(document.querySelector('[data-testid=pools-table]')?.textContent ?? ''), null, { timeout: 30000 });
    const rows = await page.locator('[data-testid=pool-row]').allTextContents();
    if (process.env.DEBUG_UI) console.log(rows);
    assert.ok(rows.some((r) => /FMX \/ AZNT/.test(r) && /Locked 99\.9/.test(r)), 'the live pool shows LOCKED 99.9%');
    assert.ok(rows.some((r) => /FMX \/ USDF/.test(r) && /Not locked/.test(r)), 'the fork pool shows Not locked');
    assert.ok(rows.some((r) => /USDF \/ AZNT|AZNT \/ USDF/.test(r)), 'AZNT/USDF is listed');
    const usdfRow = rows.find((r) => /FMX \/ USDF/.test(r));
    assert.match(usdfRow, /\$52\.0K/, 'WFMX/USDF TVL = 50,000 FMX × $0.52 + 26,000 USDF');
    await shot('01-pools');
    ok(`Pools: ${rows.length} pools, TVL at the $0.52 basis ($52.0K for WFMX/USDF), LOCKED 99.9% on the live pool`);

    await go(`?tab=pools&pool=${m.usdfPair}`);
    await page.waitForSelector('[data-testid=pool-detail]');
    await page.waitForSelector('[data-testid=pool-chart] svg', { timeout: 30000 });
    const detail = await page.textContent('[data-testid=pool-detail]');
    assert.match(detail, /Reserves/);
    assert.match(detail, /Official \$0\.5200/, 'the USD view of FMX carries the official reference');
    assert.match(detail, /Recent trades/);
    await shot('02-pool-detail');
    ok('pool detail: price chart from the pool’s Sync history with the official $0.52 line, reserves, trades, locks');

    // ---- Charts / Analytics --------------------------------------------------
    await go('?tab=charts');
    await page.waitForSelector('[data-testid=fmx-chart] svg', { timeout: 30000 });
    assert.equal((await page.textContent('[data-testid=official-price]')).trim(), '$0.5200');
    const lines = await page.locator('[data-testid=fmx-chart] path.chart-line').count();
    assert.ok(lines >= 2, `one line per FMX pool against a peg, saw ${lines}`);
    await shot('03-charts');
    await go('?tab=analytics');
    await page.waitForSelector('[data-testid=tvl-chart]');
    await page.waitForFunction(() => /\$[\d,]+\.\d\d/.test(document.querySelector('[data-testid=kpi-tvl]')?.textContent ?? ''), null, { timeout: 30000 });
    const kpi = await page.textContent('[data-testid=kpi-tvl]');
    assert.match(kpi, /\$[\d,]+\.\d\d/);
    await page.waitForSelector('[data-testid=volume-chart] svg');
    await shot('04-analytics');
    ok(`Charts: official $0.5200 with ${lines} pool lines; Analytics: TVL ${kpi.replace(/[^$\d,.]/g, '')}, TVL and volume charts`);

    // ---- Swap: quotes --------------------------------------------------------
    await go('');
    await page.waitForFunction(() => /USDF/.test(document.querySelector('[data-testid=field-out]')?.textContent ?? ''), null, { timeout: 30000 });
    await page.fill('[data-testid=field-in] input', '100');
    await page.waitForSelector('[data-testid=quote]', { timeout: 30000 });
    assert.match(await page.textContent('[data-testid=route]'), /FMX.*USDF/s);
    assert.equal(await page.locator('[data-testid=route] .route-node').count(), 2, '100 FMX goes direct');
    const out100 = Number((await page.textContent('[data-testid=field-out] output')).replace(/,/g, ''));
    assert.ok(out100 > 51 && out100 < 52, `≈ 51.7 USDF for 100 FMX at $0.52, saw ${out100}`);
    const min1 = await page.textContent('[data-testid=row-min]');
    await page.click('[data-testid=settings-btn]');
    await page.click('.modal .seg button:text-is("1%")');
    await page.click('.modal [aria-label=Close]');
    await page.waitForFunction((before) => document.querySelector('[data-testid=row-min]')?.textContent !== before, min1, { timeout: 15000 });
    assert.match(await page.textContent('[data-testid=row-min]'), /1%/);
    await page.click('[data-testid=settings-btn]');
    await page.click('.modal .seg button:text-is("0.5%")');
    await page.click('.modal [aria-label=Close]');
    ok(`Swap: 100 FMX quoted live → ${out100} USDF direct; slippage setting moves the minimum received`);

    await page.fill('[data-testid=field-in] input', '3000');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=route] .route-node').length === 3, null, { timeout: 30000 });
    assert.match(await page.textContent('[data-testid=route]'), /FMX.*AZNT.*USDF/s);
    await shot('05-swap-multihop');
    ok('a 3,000 FMX order routes FMX → AZNT → USDF, as the router prices it best');

    await page.click('[data-testid=field-out] .token-btn');
    await page.fill('[data-testid=token-search]', 'AZNT');
    await page.click('.token-row[data-symbol=AZNT]');
    await page.waitForFunction(() => /AZNT/.test(document.querySelector('[data-testid=field-out] .token-btn')?.textContent ?? ''));
    await page.click('[data-testid=field-out] .token-btn');
    await page.fill('[data-testid=token-search]', 'USDF');
    await page.click('.token-row[data-symbol=USDF]');
    ok('token picker: search filters, selection switches the output token');

    // ---- wallet and a real swap ---------------------------------------------
    await page.click('[data-testid=header-connect]');
    await page.click('[data-testid=choice-injected]');
    await page.waitForSelector('[data-testid=acct-trigger]', { timeout: 20000 });
    ok('connected through the chooser (Ferminux Wallet listed first, the injected wallet used)');

    await page.fill('[data-testid=field-in] input', '100');
    await page.waitForFunction(() => /Review swap/.test(document.querySelector('[data-testid=swap-action]')?.textContent ?? ''), null, { timeout: 30000 });
    const usdf = { kind: 'erc20', address: USDF, symbol: 'USDF', name: 'USDF', decimals: 6 };
    const before = await fetchBalance(provider, usdf, ME);
    await page.click('[data-testid=swap-action]');
    await page.waitForSelector('.modal:has-text("Review swap")');
    await shot('06-review');
    await page.click('[data-testid=confirm-swap]');
    await page.waitForSelector('[data-testid=tx-done]', { timeout: 60000 });
    const gained = (await fetchBalance(provider, usdf, ME)) - before;
    assert.ok(gained > 51_000_000n, `USDF arrived on chain: ${formatUnits(gained, 6)}`);
    ok(`swapped 100 FMX in the page: +${formatUnits(gained, 6)} USDF on chain`);

    // The wallet switches to chain 56 while the review is open, and the page has not heard yet:
    // the send asks the wallet first and refuses, so nothing is signed on the wrong chain.
    await page.fill('[data-testid=field-in] input', '10');
    await page.waitForFunction(() => /Review swap/.test(document.querySelector('[data-testid=swap-action]')?.textContent ?? ''), null, { timeout: 30000 });
    const nonceBefore = await provider.getTransactionCount(ME);
    await page.click('[data-testid=swap-action]');
    await page.waitForSelector('[data-testid=confirm-swap]');
    await page.evaluate(() => {
      window.__chainOverride = '0x38';
    });
    await page.click('[data-testid=confirm-swap]');
    await page.waitForFunction(() => /not Ferminux/.test(document.querySelector('[data-testid=tx-error]')?.textContent ?? ''), null, { timeout: 15000 });
    await page.evaluate(() => {
      window.__chainOverride = null;
    });
    assert.equal(await provider.getTransactionCount(ME), nonceBefore, 'nothing was sent while the wallet was on another chain');
    ok('a wallet that left Ferminux while the review was open is refused before anything is signed');

    // USDF → FMX needs an approval first: exact amount by default.
    await page.click('[data-testid=flip]');
    await page.fill('[data-testid=field-in] input', '20');
    await page.waitForFunction(() => /Approve USDF/.test(document.querySelector('[data-testid=swap-action]')?.textContent ?? ''), null, { timeout: 30000 });
    assert.match(await page.textContent('[data-testid=approve-steps]'), /exactly 20 USDF/);
    await page.click('[data-testid=swap-action]');
    await page.waitForFunction(() => /Review swap/.test(document.querySelector('[data-testid=swap-action]')?.textContent ?? ''), null, { timeout: 60000 });
    assert.equal(await fetchAllowance(provider, usdf, ME, DEX_ADDRESSES.router), 20_000_000n, 'the router may move exactly 20 USDF');
    const fmxBefore = await provider.getBalance(ME);
    await page.click('[data-testid=swap-action]');
    await page.click('[data-testid=confirm-swap]');
    await page.waitForFunction(() => /Swapped 20 USDF/.test(document.querySelector('[data-testid=tx-done]')?.textContent ?? ''), null, { timeout: 60000 });
    assert.ok((await provider.getBalance(ME)) > fmxBefore, 'native FMX arrived');
    assert.equal(await fetchAllowance(provider, usdf, ME, DEX_ADDRESSES.router), 0n, 'the exact approval was used up');
    ok('USDF → FMX: approve exactly 20 USDF, then swap; native FMX received, allowance back to 0');

    // ---- Liquidity ----------------------------------------------------------
    await go('?tab=liquidity');
    await page.waitForFunction(() => /USDF/.test(document.querySelector('[data-testid=liq-b] .token-btn')?.textContent ?? ''), null, { timeout: 30000 });
    await page.fill('[data-testid=liq-a] input', '50');
    await page.waitForFunction(() => Number(document.querySelector('[data-testid=liq-b] input')?.value) > 25, null, { timeout: 15000 });
    const derived = Number(await page.inputValue('[data-testid=liq-b] input'));
    assert.ok(Math.abs(derived - 26) < 0.5, `50 FMX pairs with ≈ 26 USDF at the pool ratio, saw ${derived}`);
    await page.click('[data-testid=liq-action]'); // Approve USDF
    await page.waitForFunction(() => /Add liquidity/.test(document.querySelector('[data-testid=liq-action]')?.textContent ?? ''), null, { timeout: 60000 });
    await page.click('[data-testid=liq-action]');
    await page.waitForFunction(() => /Added 50 FMX/.test(document.body.textContent ?? ''), null, { timeout: 60000 });
    await page.waitForSelector('[data-testid=position]', { timeout: 30000 });
    await page.locator('[data-testid=position] .position-head').first().click();
    await page.click('.position-body .seg button:text-is("50%")');
    assert.match(await page.textContent('[data-testid=remove-receive]'), /FMX.*USDF/s);
    await shot('07-liquidity');
    await page.locator('.position-body .btn-primary').first().click(); // approve LP
    await page.waitForSelector('[data-testid=remove-action]', { timeout: 60000 });
    await page.click('[data-testid=remove-action]');
    await page.waitForFunction(() => /Removed 50%/.test(document.body.textContent ?? ''), null, { timeout: 60000 });
    ok(`Liquidity: 50 FMX + ${derived} USDF added at the ratio, position listed, 50% removed`);

    // ---- Activity -----------------------------------------------------------
    await go('?tab=activity');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=activity-swap]').length >= 2, null, { timeout: 60000 });
    const act = await page.textContent('[data-testid=activity]');
    assert.match(act, /Swapped FMX for USDF/);
    assert.match(act, /Swapped USDF for FMX/);
    assert.match(act, /Added liquidity/);
    assert.match(act, /Removed liquidity/);
    assert.match(act, /Approved USDF for the router/);
    await shot('08-activity');
    ok('Activity: both swaps, the deposit, the withdrawal and the approvals, read from the chain');

    // ---- Bridge tab (opt-in build) -------------------------------------------
    await go('?tab=bridge');
    await page.waitForSelector('[data-testid=bridge-gate]', { timeout: 30000 });
    assert.match(await page.textContent('[data-testid=bridge-gate]'), /unavailable from Ferminux.*paused/is);
    ok('Bridge tab (VITE_ENABLE_BRIDGE=1) mounts and gates on the relayer report');

    // ---- every page at 320 / 390 / 1440 --------------------------------------
    const pages = ['', '?tab=pools', `?tab=pools&pool=${m.usdfPair}`, '?tab=liquidity', '?tab=charts', '?tab=analytics', '?tab=activity'];
    const overflowed = [];
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w < 800 ? 740 : 950 });
      for (const p of pages) {
        await go(p);
        await page.waitForTimeout(1500);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) overflowed.push(`${w}px ${p || 'swap'}: ${over}px`);
        await page.screenshot({ path: join(work, `w${w}-${(p || 'swap').replace(/[^a-z0-9]+/gi, '_')}.png`), fullPage: true });
      }
    }
    assert.deepEqual(overflowed, [], `horizontal scroll: ${overflowed.join('; ')}`);
    ok(`no horizontal scroll on ${pages.length} pages × ${WIDTHS.join('/')} px`);

    assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
    ok('no console errors or page exceptions');

    // ---- a build with blanked addresses ---------------------------------------
    distRoot = join(work, 'dist-unconfigured');
    build(distRoot, { VITE_RPC_URLS: fork.rpc, VITE_FACTORY_ADDRESS: '', VITE_ROUTER_ADDRESS: '', VITE_WFMX_ADDRESS: '', VITE_LOCKER_ADDRESS: '' });
    await page.setViewportSize({ width: 1440, height: 950 });
    await go('');
    await page.waitForSelector('[data-testid=not-configured]');
    assert.equal(await page.locator('[data-testid=not-configured] .row').count(), 4);
    ok('a build with blanked addresses says "Not configured" and names all four');

    console.log(`\nScreenshots: ${work}`);
  } catch (err) {
    if (page) {
      await page.screenshot({ path: join(work, 'FAILED.png'), fullPage: true }).catch(() => {});
      console.error(`\nState at failure: ${join(work, 'FAILED.png')}`);
    }
    // Any transaction that reverted on the fork, with the reason the trace gives.
    if (provider) {
      const head = await provider.getBlockNumber().catch(() => 0);
      for (let b = head; b > head - 12 && b > 0; b--) {
        const block = await provider.getBlock(b).catch(() => null);
        for (const h of block?.transactions ?? []) {
          const r = await provider.getTransactionReceipt(h).catch(() => null);
          if (r && r.status === 0) {
            const t = await provider.getTransaction(h);
            const trace = await provider.send('debug_traceTransaction', [h, { tracer: 'callTracer' }]).catch((e) => ({ error: String(e) }));
            console.error(`reverted ${h} to ${t.to} gas ${r.gasUsed}/${t.gasLimit} error ${trace.error ?? ''} ${trace.revertReason ?? ''} output ${String(trace.output ?? '').slice(0, 200)}`);
            console.error(JSON.stringify(trace).slice(0, 1500));
          }
        }
      }
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
    provider?.destroy();
    await fork.stop();
  }
  console.log('\nUI check: all assertions passed.');
}

main().catch((err) => {
  console.error('\nUI CHECK FAILED:', err);
  process.exit(1);
});
