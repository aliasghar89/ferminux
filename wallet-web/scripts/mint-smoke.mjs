#!/usr/bin/env node
// Browser smoke of NFTs → Mint, at phone (390×844, touch) and desktop
// (1440×900) sizes, against a local anvil FORK of Ferminux (chain 3961):
//
//   1. builds the real bundle with the Ferminux RPC pointed at the fork
//      (metadata and artwork still come from ferminux.net, as in production);
//   2. creates a wallet in the page and funds it ON THE FORK only
//      (anvil_setBalance) — nothing is ever sent to the public chain;
//   3. browses Ferminux Citizens, filters Legendary, opens a piece, and is
//      refused with an "Add FMX" path while the balance is short (Receive opens);
//   4. funds the wallet, mints that Legendary (500 FMX) through the confirm
//      screen (contract, mint(uint256), exact value, fee, pre-checks), checks
//      ownerOf and the balance on the fork, the explorer link, and that
//      Your NFTs lists it;
//   5. mints a Ferminux Agents piece the same way (price());
//   6. the already-minted race three ways, each id taken on the fork by a
//      throwaway key: before Review (pre-check), between the confirm screen
//      and Sign (re-check, nothing broadcast), and in the same block (the
//      wallet's transaction reverts and the sheet says it lost the race);
//   7. no horizontal scroll on the phone, no uncaught page errors.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/mint-smoke.mjs
//
// Skips cleanly (exit 0) without anvil or Playwright. Screenshots go to
// SMOKE_OUT (default: a temp dir, printed at the end).

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther, parseUnits, toBeHex } from 'ethers';
import { mintCollection } from '../src/lib/nftMint.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FMX_PORT = Number(process.env.SMOKE_FMX_PORT ?? 8581);
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 8583);
const FMX_RPC = `http://127.0.0.1:${FMX_PORT}`;
const CIT = mintCollection('citizens');
const AGE = mintCollection('agents');
const PASSWORD = 'mint smoke 3961 fork';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CIT_ABI = [
  'function tokensInfo(uint256,uint256) view returns (uint8[],address[])',
  'function totalIds() view returns (uint256)',
  'function price(uint256) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function mint(uint256) payable',
];
const AGE_ABI = ['function price() view returns (uint256)', 'function minted(uint256) view returns (bool)', 'function ownerOf(uint256) view returns (address)', 'function mint(uint256) payable'];

let n = 0;
const ok = (m) => console.log(`  ✓ ${String(++n).padStart(2)}. ${m}`);
const info = (m) => console.log(`       · ${m}`);
const skip = (why) => {
  console.log(`mint-smoke SKIPPED: ${why}`);
  process.exit(0);
};

async function loadPlaywright() {
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) {
    try {
      const mod = await import(spec);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch {
      /* next */
    }
  }
  return null;
}

async function waitRpc(url) {
  const p = new JsonRpcProvider(url, undefined, { staticNetwork: true, cacheTimeout: -1 });
  for (let i = 0; i < 240; i++) {
    try {
      await p.getBlockNumber();
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`anvil at ${url} did not come up`);
}

/** Unminted Citizens ids by tier on the fork, lowest first. */
async function citizensFree(fmx) {
  const c = new Contract(CIT.address, CIT_ABI, fmx);
  const [tiers, owners] = await c.tokensInfo(1n, await c.totalIds());
  const out = [[], [], [], []];
  owners.forEach((o, i) => {
    if (/^0x0{40}$/i.test(o)) out[Number(tiers[i])].push(i + 1);
  });
  return out;
}

/** A throwaway key with FMX on the fork: the "other wallet" of the race checks. */
async function rival(fmx) {
  const w = Wallet.createRandom().connect(fmx);
  await fmx.send('anvil_setBalance', [w.address, toBeHex(parseEther('5000'))]);
  return w;
}

/** The rival mints `id` on the fork (in a block at once unless automine is off). */
async function rivalMint(fmx, who, col, id, opts = {}) {
  const c = new Contract(col.address, col.key === 'citizens' ? CIT_ABI : AGE_ABI, who);
  const price = col.key === 'citizens' ? await c.price(id) : await c.price();
  return c.mint(id, { value: price, ...opts });
}

/** The page under test, so a failure can leave a screenshot and the open dialog's text. */
let current = null;

async function pass(browser, { name, viewport, mobile }, shots, fmx) {
  const ctx = await browser.newContext({
    viewport,
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  // A short pause first: dialogs fade and slide in, and a mid-animation frame is not what anyone sees.
  const shot = async (label) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: !mobile && !(await page.$('.modal')) });
  };
  current = { page, shot };
  const tap = (sel) => (mobile ? page.tap(`${sel} >> visible=true`) : page.click(`${sel} >> visible=true`));

  /* --- a fresh wallet --- */
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'load' });
  await tap('[data-testid=create-wallet]');
  await page.waitForSelector('.mnemonic-grid');
  const words = await page.$$eval('.mnemonic-word', (els) => els.map((e) => e.textContent.replace(/^\d+/, '').trim()));
  await tap('[data-testid=reveal-phrase]');
  await tap('[data-testid=phrase-continue]');
  await page.waitForSelector('[data-quiz-index]');
  for (const group of await page.$$('[data-quiz-index]')) {
    const want = words[Number(await group.getAttribute('data-quiz-index')) - 1];
    for (const opt of await group.$$('.quiz-opt')) if ((await opt.textContent()).trim() === want) await opt.click();
  }
  await tap('[data-testid=confirm-continue]');
  await page.fill('#c-pw', PASSWORD);
  await page.fill('#c-pw2', PASSWORD);
  await tap('[data-testid=encrypt-download]');
  await page.waitForSelector('[data-testid=open-wallet]', { timeout: 180000 });
  await page.waitForSelector('[data-testid=keystore-saved][data-result=downloaded]', { timeout: 10000 }); // the web build says it downloaded
  await tap('[data-testid=open-wallet]');
  await page.waitForSelector('[data-testid=active-address]');
  const me = (await page.getAttribute('[data-testid=active-address]', 'data-address')).trim();
  ok(`[${name}] created a wallet: ${me}`);

  // Short on purpose: 60 FMX covers an Agent (50) but not a Legendary Citizen (500).
  await fmx.send('anvil_setBalance', [me, toBeHex(parseEther('60'))]);

  /* --- browse Citizens, Legendary filter, detail sheet --- */
  const free = await citizensFree(fmx);
  assert.ok(free[3].length >= 2 && free[0].length >= 4, `enough unminted Legendary/Common ids on the fork (${free.map((x) => x.length)})`);
  const legendary = free[3][0];
  await tap('[data-testid=tab-nfts]');
  await tap('[data-testid=nfts-view-mint]');
  await page.waitForSelector('[data-testid=mint-browser][data-collection=citizens]');
  await page.waitForSelector('[data-testid=mint-grid]', { timeout: 60000 });
  assert.match(page.url(), /#\/nfts\/mint$/, 'the Mint view has its own route');
  await tap('[data-testid=mint-tier-legendary]');
  await page.waitForSelector(`[data-testid=mint-card-${legendary}]`, { timeout: 30000 });
  const legendaryCards = await page.$$eval('[data-testid^=mint-card-]', (els) => els.map((e) => e.querySelector('.tier')?.textContent));
  assert.ok(legendaryCards.length >= 1 && legendaryCards.every((t) => t === 'Legendary'), `Legendary filter shows only Legendary: ${legendaryCards.join(',')}`);
  const cardPrice = await page.textContent(`[data-testid=mint-card-${legendary}] .mint-price`);
  assert.equal(cardPrice.trim(), '500 FMX');
  // the artwork: AVIF/WebP sources, lazy, and it decodes
  const pic = await page.$eval(`[data-testid=mint-card-${legendary}] picture`, (p) => ({
    types: [...p.querySelectorAll('source')].map((s) => s.type),
    lazy: p.querySelector('img').getAttribute('loading'),
  }));
  assert.deepEqual(pic.types, ['image/avif', 'image/webp']);
  assert.equal(pic.lazy, 'lazy');
  await page.waitForFunction((id) => {
    const img = document.querySelector(`[data-testid=mint-card-${id}] img`);
    return img && img.complete && img.naturalWidth > 0;
  }, legendary, { timeout: 30000 });
  const chosen = await page.$eval(`[data-testid=mint-card-${legendary}] img`, (i) => i.currentSrc);
  assert.match(chosen, /-(256|512)\.(avif|webp)$/, `a gallery copy was chosen, not the full-size file: ${chosen}`);
  await shot('gallery-legendary');
  ok(`[${name}] Citizens gallery: Legendary filter, #${legendary} at 500 FMX, artwork ${chosen.split('/').pop()} (lazy, AVIF/WebP)`);

  await tap(`[data-testid=mint-card-${legendary}]`);
  await page.waitForSelector(`[data-testid=mint-sheet][data-id="${legendary}"]`);
  assert.match(await page.textContent('[data-testid=mint-price]'), /500 FMX/);
  await shot('sheet');

  /* --- insufficient balance: refused, with an Add FMX path to Receive --- */
  const nonce0 = await fmx.getTransactionCount(me);
  await tap('[data-testid=mint-start]');
  await page.waitForSelector('[data-testid=mint-problem][data-code=funds]', { timeout: 60000 });
  const shortText = await page.textContent('[data-testid=mint-problem]');
  assert.match(shortText, /holds 60 FMX\. Minting #\d+ needs 500 FMX/, shortText);
  assert.match(shortText, /Add at least 440/, shortText);
  await shot('short');
  await tap('[data-testid=mint-add-fmx]');
  await page.waitForSelector('.modal[aria-label="Receive on Ferminux"]');
  assert.ok((await page.textContent('.modal')).includes(me), 'Receive shows this account');
  await shot('add-fmx-receive');
  await page.click('[data-testid=modal-close] >> visible=true');
  assert.equal(await fmx.getTransactionCount(me), nonce0, 'nothing was sent while short');
  ok(`[${name}] 60 FMX vs a 500 FMX Legendary: refused before signing ("${shortText.trim().slice(0, 70)}…"), Add FMX opens Receive`);

  /* --- funded: mint the Legendary through the confirm screen --- */
  await fmx.send('anvil_setBalance', [me, toBeHex(parseEther('1000'))]);
  await page.waitForSelector(`[data-testid=mint-card-${legendary}]`);
  await tap(`[data-testid=mint-card-${legendary}]`);
  await tap('[data-testid=mint-start]');
  await page.waitForSelector('[data-testid=mint-review]', { timeout: 60000 });
  assert.equal((await page.textContent('[data-testid=mint-confirm-contract]')).trim(), CIT.address);
  assert.equal((await page.textContent('[data-testid=mint-confirm-method]')).trim(), `mint(uint256) · tokenId ${legendary}`);
  assert.equal((await page.textContent('[data-testid=mint-confirm-value]')).replace(/\s+/g, ''), '500.0FMX');
  assert.match(await page.textContent('[data-testid=mint-confirm-fee]'), /FMX$/);
  const checks = await page.$$eval('[data-testid=mint-checks] li', (els) => els.map((e) => e.textContent));
  assert.equal(checks.length, 5);
  assert.match(checks.join(' | '), /exists on chain.*Not minted yet.*Sale open.*Price read from the contract: 500 FMX · Legendary.*Balance 1,000 FMX covers/);
  assert.match(await page.textContent('[data-testid=chain-banner]'), /Ferminux.*chain 3961/);
  await shot('confirm-legendary');
  const before = await fmx.getBalance(me);
  await tap('[data-testid=mint-confirm]');
  await page.waitForSelector('[data-testid=mint-done]', { timeout: 60000 });
  const cit = new Contract(CIT.address, CIT_ABI, fmx);
  assert.equal(await cit.ownerOf(legendary), me);
  const spent = before - (await fmx.getBalance(me));
  assert.ok(spent > parseEther('500') && spent < parseEther('500.01'), `paid exactly 500 FMX plus gas (${formatEther(spent)})`);
  const txHref = await page.getAttribute('[data-testid=mint-tx] a', 'href');
  assert.match(txHref, /^https:\/\/explorer\.ferminux\.net\/tx\/0x[0-9a-f]{64}$/);
  const receipt = await fmx.getTransactionReceipt(txHref.split('/').pop());
  assert.equal(receipt.status, 1);
  assert.equal(receipt.to, CIT.address);
  await shot('minted-legendary');
  await tap('[data-testid=mint-see-yours]');
  await page.waitForSelector(`[data-testid=nft-${legendary}]`, { timeout: 60000 });
  assert.match(page.url(), /#\/nfts$/);
  await page.waitForFunction((id) => {
    const img = document.querySelector(`[data-testid=nft-${id}] img`);
    return img && img.complete && img.naturalWidth > 0;
  }, legendary, { timeout: 30000 });
  await shot('yours');
  ok(`[${name}] minted Citizens #${legendary} (Legendary) for exactly 500 FMX + ${formatEther(spent - parseEther('500'))} FMX gas; ownerOf on the fork = this account; explorer link ${txHref.slice(0, 44)}…; listed in Your NFTs`);

  /* --- Ferminux Agents: one price() for every id --- */
  const age = new Contract(AGE.address, AGE_ABI, fmx);
  let agentId = 0;
  for (let i = 2; i <= 40 && !agentId; i++) if (!(await age.minted(i))) agentId = i;
  assert.ok(agentId, 'an unminted agent on the fork');
  await tap('[data-testid=nfts-view-mint]');
  await tap('[data-testid=mint-col-agents]');
  await page.waitForSelector('[data-testid=mint-browser][data-collection=agents] [data-testid=mint-grid]', { timeout: 60000 });
  await tap('[data-testid=mint-avail-available]');
  await page.waitForSelector(`[data-testid=mint-card-${agentId}]`);
  await shot('gallery-agents');
  await tap(`[data-testid=mint-card-${agentId}]`);
  await tap('[data-testid=mint-start]');
  await page.waitForSelector('[data-testid=mint-review]', { timeout: 60000 });
  assert.equal((await page.textContent('[data-testid=mint-confirm-contract]')).trim(), AGE.address);
  assert.equal((await page.textContent('[data-testid=mint-confirm-value]')).replace(/\s+/g, ''), '50.0FMX');
  await shot('confirm-agent');
  await tap('[data-testid=mint-confirm]');
  await page.waitForSelector('[data-testid=mint-done]', { timeout: 60000 });
  assert.equal(await age.ownerOf(agentId), me);
  await page.click('[data-testid=modal-close] >> visible=true');
  await page.waitForSelector(`[data-testid=mint-card-${agentId}][data-minted=true]`, { state: 'attached' }).catch(() => undefined);
  ok(`[${name}] minted Ferminux Agents #${agentId} for price() = 50 FMX; ownerOf on the fork = this account`);

  /* --- race 1: taken before Review → the pre-check refuses, nothing signed --- */
  const other = await rival(fmx);
  await tap('[data-testid=mint-col-citizens]');
  await tap('[data-testid=mint-tier-common]');
  const commons = (await citizensFree(fmx))[0];
  const [r1, r2, r3] = commons;
  await page.waitForSelector(`[data-testid=mint-card-${r1}]`, { timeout: 60000 });
  await tap(`[data-testid=mint-card-${r1}]`);
  await page.waitForSelector(`[data-testid=mint-sheet][data-id="${r1}"] [data-testid=mint-start]`);
  await (await rivalMint(fmx, other, CIT, r1)).wait();
  let nonce = await fmx.getTransactionCount(me);
  await tap('[data-testid=mint-start]');
  await page.waitForSelector('[data-testid=mint-problem][data-code=taken]', { timeout: 60000 });
  assert.match(await page.textContent('[data-testid=mint-problem]'), new RegExp(`#${r1} was just minted by someone else`));
  assert.equal(await fmx.getTransactionCount(me), nonce);
  await shot('race-precheck');
  await tap('[data-testid=mint-back]');
  ok(`[${name}] race before Review: #${r1} taken by another key → "was just minted by someone else", nothing signed`);

  /* --- race 2: taken between the confirm screen and Sign → re-check refuses, nothing broadcast --- */
  await page.waitForSelector(`[data-testid=mint-card-${r2}]`);
  await tap(`[data-testid=mint-card-${r2}]`);
  await tap('[data-testid=mint-start]');
  await page.waitForSelector('[data-testid=mint-review]', { timeout: 60000 });
  await (await rivalMint(fmx, other, CIT, r2)).wait();
  nonce = await fmx.getTransactionCount(me);
  await tap('[data-testid=mint-confirm]');
  await page.waitForSelector('[data-testid=mint-problem][data-code=taken]', { timeout: 60000 });
  assert.equal(await fmx.getTransactionCount(me, 'pending'), nonce, 'the re-check stopped it before broadcast');
  await shot('race-confirm');
  await tap('[data-testid=mint-back]');
  ok(`[${name}] race after the confirm screen: #${r2} taken → refused at Sign by the re-check, nothing broadcast`);

  /* --- race 3: both in the same block, the rival first → the wallet's mint reverts and says so --- */
  await page.waitForSelector(`[data-testid=mint-card-${r3}]`);
  await tap(`[data-testid=mint-card-${r3}]`);
  await tap('[data-testid=mint-start]');
  await page.waitForSelector('[data-testid=mint-review]', { timeout: 60000 });
  const balBefore = await fmx.getBalance(me);
  nonce = await fmx.getTransactionCount(me);
  await fmx.send('evm_setAutomine', [false]);
  try {
    await tap('[data-testid=mint-confirm]');
    for (let i = 0; i < 200 && (await fmx.getTransactionCount(me, 'pending')) === nonce; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await fmx.getTransactionCount(me, 'pending'), nonce + 1, 'the wallet broadcast its mint');
    // A fixed gas limit: anvil estimates against the pending block, where the wallet's mint already holds the id.
    await rivalMint(fmx, other, CIT, r3, { gasLimit: 250000n, maxPriorityFeePerGas: parseUnits('50', 'gwei'), maxFeePerGas: parseUnits('100', 'gwei') });
    await fmx.send('evm_mine', []);
  } finally {
    await fmx.send('evm_setAutomine', [true]);
  }
  await page.waitForSelector('[data-testid=mint-problem][data-code=taken]', { timeout: 60000 });
  const lostText = await page.textContent('[data-testid=mint-problem]');
  assert.match(lostText, /minted by another wallet first\. Your transaction reverted: the 50 FMX was not taken, only the network fee was spent/, lostText);
  assert.equal(await cit.ownerOf(r3), other.address);
  const lost = balBefore - (await fmx.getBalance(me));
  assert.ok(lost > 0n && lost < parseEther('0.01'), `only gas was spent (${formatEther(lost)} FMX)`);
  assert.ok(await page.$('[data-testid=mint-problem] ~ .hash-line a[href*="/tx/0x"]'), 'the reverted transaction links to the explorer');
  await shot('race-block');
  await page.click('[data-testid=modal-close] >> visible=true');
  ok(`[${name}] race in the same block: rival first, the wallet's mint of #${r3} reverted → "minted by another wallet first", ${formatEther(lost)} FMX gas only`);

  if (mobile) {
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      assert.ok(m.doc <= m.win, `${w}px mint gallery: page scrolls sideways (${m.doc} > ${m.win})`);
    }
    await page.setViewportSize(viewport);
    ok(`[${name}] no horizontal scroll on the mint gallery at 320 / 360 / 390 / 430 px`);
  }

  assert.deepEqual(jsErrors, [], `uncaught JS errors: ${jsErrors.join(' | ')}`);
  await ctx.close();
}

async function main() {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).error) skip('anvil is not installed');
  const chromium = await loadPlaywright();
  if (!chromium) skip('Playwright is not resolvable (set PLAYWRIGHT_MODULE)');

  const work = await mkdtemp(join(tmpdir(), 'ferminux-mint-'));
  const dist = join(work, 'dist');
  const shots = process.env.SMOKE_OUT ?? join(work, 'shots');
  await mkdir(shots, { recursive: true });

  const build = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_RPC_URLS: FMX_RPC },
  });
  if (build.status !== 0) throw new Error('vite build failed');

  const fork = spawn('anvil', ['--fork-url', 'https://rpc.ferminux.net', '--chain-id', '3961', '--port', String(FMX_PORT), '--silent'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const server = createServer(async (req, res) => {
    const p = (req.url || '/').split('?')[0];
    try {
      const f = join(dist, p === '/' ? 'index.html' : p);
      res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
      res.end(await readFile(f));
    } catch {
      res.writeHead(404).end();
    }
  });
  let browser;
  try {
    await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));
    const fmx = await waitRpc(FMX_RPC);
    assert.equal((await fmx.getNetwork()).chainId, 3961n);
    // Warm the fork: the first read of each slot goes to the public RPC.
    await citizensFree(fmx);
    ok(`anvil fork of Ferminux 3961 on :${FMX_PORT} (block ${await fmx.getBlockNumber()}); bundle on :${WEB_PORT}`);
    info(`Citizens ${CIT.address}, Agents ${AGE.address}`);

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
    await pass(browser, { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }, shots, fmx);
    await pass(browser, { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false }, shots, fmx);
    console.log(`\nMINT SMOKE: all ${n} checks passed.\nScreenshots: ${shots}`);
  } catch (e) {
    if (current) {
      await current.shot('FAILED').catch(() => undefined);
      const dialog = await current.page.textContent('.modal').catch(() => null);
      if (dialog) console.error(`open dialog: ${dialog.replace(/\s+/g, ' ').slice(0, 600)}`);
      console.error(`screenshot: ${shots}`);
    }
    throw e;
  } finally {
    if (browser) await browser.close();
    server.close();
    fork.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('\nMINT SMOKE FAILED:', e);
  process.exit(1);
});
