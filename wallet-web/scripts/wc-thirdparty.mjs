#!/usr/bin/env node
// Ferminux Wallet as the wallet of real, third-party dApps over WalletConnect.
//
// For each dApp (PancakeSwap on BNB Chain, Uniswap on Ethereum):
//   1. a local Ferminux Wallet build (WALLET_DIST, built with VITE_WC_PROJECT_ID)
//      creates a throwaway wallet;
//   2. the dApp's own "Connect wallet" → WalletConnect → "Copy link" gives the
//      wc: pairing link;
//   3. the link is pasted into the wallet's Connect tab — or, with --via-link,
//      opened as https://<wallet>/wc?uri=… the way a WalletConnect modal opens a
//      listed web wallet (the wallet unlocks, then pairs) — and the proposal is
//      reviewed (Verify must say the domain is verified) and approved;
//   4. the dApp must show the wallet's address.
// Any signing request that arrives is REJECTED; nothing is signed or sent.
// Screenshots of each step go to OUT.
//
//   WALLET_DIST=dist PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//   node scripts/wc-thirdparty.mjs [--via-link] [pancakeswap] [uniswap]
//
// Needs the network (the dApps and the WalletConnect relay are real). The
// dApps' markup is theirs and changes: a failure here can be a moved button,
// so read the screenshots before blaming the wallet. Skips (exit 0) without
// Playwright or a build.

import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, access } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const DIST = resolve(process.env.WALLET_DIST ?? 'dist');
const PORT = Number(process.env.PORT ?? 8641);
const VIA_LINK = process.argv.includes('--via-link');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WANT = ARGS.length ? ARGS : ['pancakeswap', 'uniswap'];
const PASSWORD = 'third-party walletconnect 3961';
// A desktop Chrome user agent: some dApps serve nothing to "HeadlessChrome".
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const skip = (why) => {
  console.log(`wc-thirdparty SKIPPED: ${why}`);
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

/** Each dApp: how to reach its WalletConnect link, and the chain it connects on. */
const DAPPS = {
  pancakeswap: {
    url: 'https://pancakeswap.finance/swap',
    chain: 'BNB Chain',
    settle: 5000,
    async openWalletConnect(page) {
      await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
      await page.waitForTimeout(1500);
      await page.getByText('More Wallets').click();
      await page.waitForTimeout(1500);
      await page.getByText('WalletConnect', { exact: true }).first().click();
    },
  },
  uniswap: {
    url: 'https://app.uniswap.org/swap',
    chain: 'Ethereum',
    settle: 12000,
    async openWalletConnect(page) {
      await page.getByTestId('navbar-connect-wallet').first().click();
      await page.waitForTimeout(2500);
      await page.getByText('Other wallets', { exact: true }).last().click({ force: true });
      await page.waitForTimeout(2500);
      await page.getByText('WalletConnect', { exact: true }).last().click({ force: true });
    },
  },
};

/** "Copy link" in the WalletConnect modal, read back from the clipboard (the QR's own uri as a fallback). */
async function copyWcLink(page) {
  const copy = page.getByText('Copy link').last();
  await copy.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await copy.click({ force: true });
  await page.waitForTimeout(500);
  let uri = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (!/^wc:/.test(uri)) {
    uri = await page.evaluate(() => {
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          const u = el.getAttribute?.('uri');
          if (u && u.startsWith('wc:')) return u;
          if (el.shadowRoot) {
            const r = walk(el.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      };
      return walk(document);
    });
  }
  assert.match(uri ?? '', /^wc:[0-9a-f]{64}@2\?/, 'a WalletConnect v2 link');
  return uri;
}

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

/** Refuse whatever a dApp asks the wallet to sign or send, for as long as the run lasts. */
function rejectRequests(page, log) {
  let on = true;
  (async () => {
    while (on) {
      const req = await page.$('[data-testid=wc-request]').catch(() => null);
      if (req) {
        log.push(await req.getAttribute('data-method'));
        await page.click('[data-testid=wc-reject]').catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return () => {
    on = false;
  };
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) skip('Playwright not found (set PLAYWRIGHT_MODULE)');
  if (!(await access(join(DIST, 'index.html')).then(() => true, () => false))) skip(`no wallet build at ${DIST}`);
  const out = process.env.OUT ?? (await mkdtemp(join(tmpdir(), 'wc-thirdparty-')));
  await mkdir(out, { recursive: true });

  // The wallet serves /wc like the production host (an unknown path gets index.html).
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    let f = join(DIST, p === '/' ? 'index.html' : p);
    let body = await readFile(f).catch(() => null);
    if (!body) body = await readFile((f = join(DIST, 'index.html'))).catch(() => null);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true });
  let failures = 0;
  try {
    for (const name of WANT) {
      const dapp = DAPPS[name];
      if (!dapp) throw new Error(`unknown dApp ${name}`);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, userAgent: UA });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
      const shot = (page, label) => page.screenshot({ path: join(out, `${name}${VIA_LINK ? '-link' : ''}-${label}.png`) });
      try {
        const wallet = await ctx.newPage();
        await wallet.goto(`http://localhost:${PORT}/`);
        const me = await createWallet(wallet, VIA_LINK);

        const site = await ctx.newPage();
        await site.goto(dapp.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await site.waitForTimeout(dapp.settle);
        await dapp.openWalletConnect(site);
        const uri = await copyWcLink(site);
        await shot(site, '1-dapp-walletconnect');

        await wallet.bringToFront();
        if (VIA_LINK) {
          // What AppKit opens for a wallet listed with web-app link https://<wallet>:
          // <link>/wc?uri=<encoded wc: uri>.
          await wallet.goto(`http://localhost:${PORT}/wc?uri=${encodeURIComponent(uri)}`);
          await wallet.fill('#unlock-pw', PASSWORD);
          await wallet.click('[data-testid=unlock-submit]');
          assert.equal(new URL(wallet.url()).search, '', 'the pairing code is taken out of the address bar');
        } else {
          await wallet.click('[data-testid=tab-connect]');
          await wallet.fill('#wc-uri', uri);
          await wallet.click('[data-testid=wc-pair]');
        }
        await wallet.waitForSelector('[data-testid=wc-proposal]', { timeout: 60000 });
        const proposal = await wallet.textContent('[data-testid=wc-proposal]');
        await shot(wallet, '2-wallet-proposal');
        assert.match(proposal, /Verified domain/i, 'WalletConnect Verify vouches for the dApp origin');
        assert.ok(proposal.includes(dapp.chain) || proposal.includes('BNB Smart Chain'), `${dapp.chain} is shared`);
        await wallet.click('[data-testid=wc-proposal-approve]');
        if (VIA_LINK) await wallet.click('[data-testid=tab-connect]');
        await wallet.waitForSelector('[data-testid=wc-sessions] li', { timeout: 60000 });
        const requests = [];
        const stop = rejectRequests(wallet, requests);
        await shot(wallet, '3-wallet-session');

        await site.bringToFront();
        const short = me.slice(2, 6).toLowerCase();
        await site.waitForFunction((s) => document.body.innerText.toLowerCase().includes(s), short, { timeout: 60000 });
        await site.waitForTimeout(3000);
        await shot(site, '4-dapp-connected');
        stop();
        console.log(`  ✓ ${name}: connected ${me} on ${dapp.chain}${VIA_LINK ? ' (via the /wc?uri= link)' : ''}${requests.length ? `; refused ${requests.join(', ')}` : ''}`);
      } catch (e) {
        failures += 1;
        console.log(`  ✗ ${name}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`wc-thirdparty: ${WANT.length - failures}/${WANT.length} dApps connected. Screenshots: ${out}`);
  if (failures) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
