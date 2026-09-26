#!/usr/bin/env node
// public/fxwallet.js on a page of another origin: the EIP-6963 announcement a
// dApp's wallet picker sees, then a real connection through the wallet window.
//
//   1. serves the wallet build (WALLET_DIST) on one origin and a bare "dApp"
//      page, which only includes <script src=".../fxwallet.js" async>, on another;
//   2. creates a wallet (remembered on this device, so the window can unlock it);
//   3. on the dApp page: eip6963:requestProvider → exactly one announcement,
//      name "Ferminux Wallet", rdns net.ferminux.wallet, an inline icon, a v4
//      uuid; window.ethereum untouched;
//   4. eth_requestAccounts on the announced provider opens connect.html next to
//      the script; unlock, Connect; the dApp gets the wallet's address, and
//      eth_chainId answers 0xf79 without a window.
//
//   WALLET_DIST=dist PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/embed-check.mjs

import { createServer } from 'node:http';
import { readFile, access, mkdtemp } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const DIST = resolve(process.env.WALLET_DIST ?? 'dist');
const WALLET_PORT = Number(process.env.WALLET_PORT ?? 8644);
const DAPP_PORT = Number(process.env.DAPP_PORT ?? 8645);
const PASSWORD = 'embed check 3961';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

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

const DAPP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Any dApp</title>
<script>
  // What a wallet picker does (EIP-6963): listen, then ask.
  window.announced = [];
  window.addEventListener('eip6963:announceProvider', (e) => window.announced.push(e.detail));
</script>
<script src="http://localhost:${WALLET_PORT}/fxwallet.js" async></script>
</head><body><button id="connect">Connect</button><pre id="out"></pre>
<script>
  document.getElementById('connect').addEventListener('click', () => {
    const d = window.announced.find((x) => x.info.rdns === 'net.ferminux.wallet');
    d.provider.request({ method: 'eth_requestAccounts' }).then(
      (a) => { document.getElementById('out').textContent = 'accounts:' + a.join(','); },
      (e) => { document.getElementById('out').textContent = 'error:' + e.code + ' ' + e.message; },
    );
  });
</script></body></html>`;

async function createWallet(page, remember) {
  await page.click('[data-testid=create-wallet]');
  // The phrase is veiled until revealed; three of its words are then confirmed.
  await page.waitForSelector('.mnemonic-grid');
  const words = await page.$$eval('.mnemonic-word', (els) => els.map((e) => e.textContent.replace(/^\d+/, '').trim()));
  await page.click('[data-testid=reveal-phrase]');
  await page.click('[data-testid=phrase-continue]');
  await page.waitForSelector('[data-quiz-index]');
  for (const group of await page.$$('[data-quiz-index]')) {
    const want = words[Number(await group.getAttribute('data-quiz-index')) - 1];
    for (const opt of await group.$$('.quiz-opt')) if ((await opt.textContent()).trim() === want) await opt.click();
  }
  await page.click('[data-testid=confirm-continue]');
  await page.fill('#c-pw', PASSWORD);
  await page.fill('#c-pw2', PASSWORD);
  // A page reload (a link, the connect window) finds only a remembered wallet to unlock.
  if (remember) await page.getByText('Remember on this device').click();
  await page.click('[data-testid=encrypt-download]');
  await page.waitForSelector('[data-testid=open-wallet]', { timeout: 180000 });
  await page.click('[data-testid=open-wallet]');
  await page.waitForSelector('[data-testid=active-address]');
  const el = await page.$('[data-testid=active-address]');
  return ((await el.getAttribute('data-address')) ?? (await el.textContent())).trim();
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) return console.log('embed-check SKIPPED: Playwright not found (set PLAYWRIGHT_MODULE)');
  if (!(await access(join(DIST, 'fxwallet.js')).then(() => true, () => false))) {
    return console.log(`embed-check SKIPPED: no fxwallet.js in ${DIST} (node shared/fxwallet/build-embed.mjs, then build)`);
  }
  const wallet = createServer(async (req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    let f = join(DIST, p === '/' ? 'index.html' : p);
    let body = await readFile(f).catch(() => null);
    if (!body) body = await readFile((f = join(DIST, 'index.html'))).catch(() => null);
    res.writeHead(body ? 200 : 404, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(body ?? '');
  });
  const dapp = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DAPP_PAGE);
  });
  await new Promise((r) => wallet.listen(WALLET_PORT, '127.0.0.1', r));
  await new Promise((r) => dapp.listen(DAPP_PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true });
  const shots = process.env.OUT ?? (await mkdtemp(join(tmpdir(), 'embed-check-')));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    const w = await ctx.newPage();
    await w.goto(`http://localhost:${WALLET_PORT}/`);
    const me = await createWallet(w, true);

    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${DAPP_PORT}/`);
    await page.waitForFunction(() => window.announced.length > 0);
    // A picker that loads later asks; the wallet answers again, with the same identity.
    await page.evaluate(() => window.dispatchEvent(new Event('eip6963:requestProvider')));
    const info = await page.evaluate(() => ({
      infos: window.announced.map((d) => d.info),
      ethereum: typeof window.ethereum,
      flag: window.announced[0].provider.isFerminuxWallet,
    }));
    assert.equal(info.infos.length, 2, 'announced on load and again on request');
    assert.equal(info.infos[0].uuid, info.infos[1].uuid, 'one uuid per page');
    const i = info.infos[0];
    assert.equal(i.name, 'Ferminux Wallet');
    assert.equal(i.rdns, 'net.ferminux.wallet');
    assert.match(i.icon, /^data:image\/svg\+xml;base64,/);
    assert.match(i.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(info.ethereum, 'undefined', 'window.ethereum is left alone');
    assert.equal(info.flag, true);
    console.log(`  ✓ EIP-6963: ${i.name} (${i.rdns}), uuid ${i.uuid}`);

    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#connect')]);
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).origin, `http://localhost:${WALLET_PORT}`, 'the window is the wallet that served the script');
    await popup.fill('#cx-pw', PASSWORD);
    await popup.click('[data-testid=cx-unlock]');
    await popup.waitForSelector('[data-testid=cx-connect]', { timeout: 60000 });
    const origin = await popup.textContent('[data-testid=cx-origin]');
    assert.ok(origin.includes(`127.0.0.1:${DAPP_PORT}`), 'the window names the requesting origin');
    await popup.screenshot({ path: join(shots, 'embed-connect-window.png') });
    await popup.waitForTimeout(700); // the approve button arms a moment after the review appears
    await popup.click('[data-testid=cx-connect]');
    await page.waitForFunction(() => document.getElementById('out').textContent !== '', null, { timeout: 30000 });
    const out = await page.textContent('#out');
    assert.equal(out.toLowerCase(), `accounts:${me.toLowerCase()}`);
    const chain = await page.evaluate(() => window.announced[0].provider.request({ method: 'eth_chainId' }));
    assert.equal(chain, '0xf79');
    console.log(`  ✓ connected ${me} from http://127.0.0.1:${DAPP_PORT} through the wallet window; eth_chainId ${chain}`);
    console.log(`embed-check passed. Screenshot: ${shots}`);
  } finally {
    await browser.close();
    wallet.close();
    dapp.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
