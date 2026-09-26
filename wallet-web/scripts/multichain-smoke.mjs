#!/usr/bin/env node
// Browser smoke for the MULTI-CHAIN wallet, at phone (390×844, touch) and
// desktop (1440×900) sizes.
//
//   1. forks Ferminux (chain 3961) and BNB Smart Chain (chain 56) into two local
//      anvils — nothing is ever sent to a public chain;
//   2. builds the real bundle with Ferminux and BSC pointed at the forks; the
//      other six networks keep their public RPCs (read-only balance reads);
//   3. creates a wallet, funds it ON THE FORKS (anvil_setBalance / storage
//      writes), and checks that the Assets tab reads every network;
//   4. sends the native coin and a token on each fork through the UI and checks
//      the recipient's balance on the fork; moves Ferminux Agents #41 to the
//      wallet on the 3961 fork (impersonating its holder — fork only), checks
//      the NFTs tab shows it with its tokenURI image, and sends it on;
//   5. drives WalletConnect with a scripted stand-in for WalletKit (the relay
//      needs a project id): a session proposal, personal_sign (signature
//      recovered and checked), eth_sendTransaction on the BSC fork, and a
//      network switch — each through its confirm modal;
//   6. checks there is no horizontal scroll from 320 to 430 px.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/multichain-smoke.mjs
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
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  keccak256,
  parseEther,
  parseUnits,
  toBeHex,
  verifyMessage,
  zeroPadValue,
} from 'ethers';
import { FERMINUX_CHAIN, chainById } from '../src/lib/chains.ts';
import { KNOWN_COLLECTIONS } from '../src/lib/nft.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FMX_PORT = Number(process.env.SMOKE_FMX_PORT ?? 8561);
const BSC_PORT = Number(process.env.SMOKE_BSC_PORT ?? 8562);
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 8573);
const FMX_RPC = `http://127.0.0.1:${FMX_PORT}`;
const BSC_RPC = `http://127.0.0.1:${BSC_PORT}`;
const BSC = chainById(56);
const USDF = FERMINUX_CHAIN.tokens.find((t) => t.symbol === 'USDF');
const USDT_BSC = BSC.tokens.find((t) => t.symbol === 'USDT');
const AGENTS = KNOWN_COLLECTIONS[0].address;
const PASSWORD = 'multichain smoke 3961';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const ERC20 = ['function balanceOf(address) view returns (uint256)'];

let n = 0;
const ok = (m) => console.log(`  ✓ ${String(++n).padStart(2)}. ${m}`);
const info = (m) => console.log(`       · ${m}`);
const skip = (why) => {
  console.log(`multichain-smoke SKIPPED: ${why}`);
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
  const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
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

/**
 * Give `holder` exactly `amount` of `token` on a fork by writing its balance
 * slot: probe mapping slots 0..30 (Solidity layout, then Vyper layout) until
 * balanceOf reads back the value. Local fork only.
 */
async function giveToken(provider, token, holder, amount) {
  const c = new Contract(token, ERC20, provider);
  const coder = AbiCoder.defaultAbiCoder();
  const value = zeroPadValue(toBeHex(amount), 32);
  for (let slot = 0; slot <= 30; slot++) {
    for (const key of [
      keccak256(coder.encode(['address', 'uint256'], [holder, slot])),
      keccak256(coder.encode(['uint256', 'address'], [slot, holder])),
    ]) {
      const prev = await provider.send('eth_getStorageAt', [token, key, 'latest']);
      await provider.send('anvil_setStorageAt', [token, key, value]);
      if ((await c.balanceOf(holder)) === amount) return;
      await provider.send('anvil_setStorageAt', [token, key, prev]);
    }
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

/* ---------- scripted WalletKit stand-in (runs in the page) ---------- */

function installFakeKit() {
  const listeners = {};
  const sessions = {};
  const calls = [];
  const DAPP = { name: 'Smoke dApp', description: 'Test site', url: 'https://smoke.example', icons: [] };
  const VERIFY = { verified: { origin: 'https://smoke.example', validation: 'VALID', verifyUrl: '' } };
  const kit = {
    on(e, fn) {
      (listeners[e] ??= []).push(fn);
    },
    async pair() {
      calls.push(['pair']);
      setTimeout(() => {
        for (const fn of listeners.session_proposal ?? []) {
          fn({
            id: 1,
            params: {
              expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
              proposer: { publicKey: 'x', metadata: DAPP },
              requiredNamespaces: { eip155: { chains: ['eip155:3961'], methods: ['eth_sendTransaction', 'personal_sign'], events: ['chainChanged'] } },
              optionalNamespaces: { eip155: { chains: ['eip155:56', 'eip155:250'], methods: ['eth_signTypedData_v4'], events: [] } },
            },
            verifyContext: VERIFY,
          });
        }
      }, 50);
    },
    async approveSession({ id, namespaces }) {
      calls.push(['approveSession', { id, namespaces }]);
      const topic = 'f'.repeat(64);
      sessions[topic] = { topic, expiry: Math.floor(Date.now() / 1000) + 86400, peer: { metadata: DAPP }, namespaces };
      return sessions[topic];
    },
    async rejectSession(p) {
      calls.push(['rejectSession', p]);
    },
    async respondSessionRequest(p) {
      calls.push(['respond', p]);
    },
    getActiveSessions: () => sessions,
    getPendingSessionRequests: () => [],
    async disconnectSession(p) {
      calls.push(['disconnect', p]);
      delete sessions[p.topic];
      for (const fn of listeners.session_delete ?? []) fn({ topic: p.topic });
    },
    async updateSession(p) {
      calls.push(['update', p]);
      sessions[p.topic] = { ...sessions[p.topic], namespaces: p.namespaces };
    },
    async emitSessionEvent(p) {
      calls.push(['event', p]);
    },
  };
  window.__ferminuxWcTestKit = () => kit;
  window.__wcCalls = calls;
  window.__wcRequest = (id, method, params, chainId) => {
    for (const fn of listeners.session_request ?? []) {
      fn({ id, topic: 'f'.repeat(64), params: { request: { method, params }, chainId }, verifyContext: VERIFY });
    }
  };
}

/* ---------- one full pass in one browser context ---------- */

/** The page under test, so a failure can leave a screenshot and the open dialog's text. */
let current = null;

async function pass(browser, { name, viewport, mobile }, shots, fmx, bsc) {
  const ctx = await browser.newContext({
    viewport,
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    acceptDownloads: true,
  });
  await ctx.addInitScript(installFakeKit);
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  const shot = (label) => page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: true });
  current = { page, shot };
  // Nav items exist twice (sidebar + phone tab bar): act on the visible one.
  const tap = (sel) => (mobile ? page.tap(`${sel} >> visible=true`) : page.click(`${sel} >> visible=true`));

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
  await tap('[data-testid=open-wallet]');
  await page.waitForSelector('[data-testid=active-address]');
  const me = (await page.getAttribute('[data-testid=active-address]', 'data-address')).trim();
  ok(`[${name}] created a wallet: ${me}`);

  // Fund on the forks only.
  await fmx.send('anvil_setBalance', [me, toBeHex(parseEther('5'))]);
  await bsc.send('anvil_setBalance', [me, toBeHex(parseEther('1'))]);
  await giveToken(fmx, USDF.address, me, parseUnits('250', USDF.decimals));
  await giveToken(bsc, USDT_BSC.address, me, parseUnits('40', USDT_BSC.decimals));
  info('funded on the forks: 5 FMX + 250 USDF (3961), 1 BNB + 40 USDT (56)');

  await tap('[data-testid=tab-assets]');
  await page.click('[data-testid=assets-refresh]'); // Refresh after funding
  await page.waitForFunction(
    () => {
      const g = [...document.querySelectorAll('[data-testid^="chain-group-"]')];
      return g.length === 8 && g.every((e) => e.getAttribute('data-status') !== 'loading');
    },
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="asset-3961-USDF"] [data-testid=asset-balance]')?.textContent.includes('250') &&
      document.querySelector('[data-testid="asset-56-USDT"] [data-testid=asset-balance]')?.textContent.includes('40'),
    { timeout: 60000 },
  );
  const statuses = await page.$$eval('[data-testid^="chain-group-"]', (els) => els.map((e) => `${e.getAttribute('data-testid').replace('chain-group-', '')}:${e.getAttribute('data-status')}`));
  assert.ok(statuses.every((s) => s.endsWith(':ok')), `every network read: ${statuses.join(' ')}`);
  const fmxBal = await page.textContent('[data-testid="asset-3961-FMX"] [data-testid=asset-balance]');
  const bnbBal = await page.textContent('[data-testid="asset-56-BNB"] [data-testid=asset-balance]');
  assert.match(fmxBal, /^5/);
  assert.match(bnbBal, /^1/);
  await shot('assets');
  ok(`[${name}] Assets read all 8 networks (${statuses.join(' ')}); FMX 5, USDF 250, BNB 1, USDT 40 shown`);

  const recipient = Wallet.createRandom().address;
  const sendOnce = async (chainId, asset, amount, label) => {
    await tap('[data-testid=tab-assets]');
    await tap('[data-testid=send-open]');
    await page.selectOption('#send-chain', String(chainId));
    await page.selectOption('#send-asset', asset);
    await page.fill('#send-to', recipient);
    await page.fill('#send-amount', amount);
    await tap('[data-testid=send-review]');
    await page.waitForSelector('[data-testid=chain-banner]', { timeout: 60000 });
    const banner = await page.textContent('[data-testid=chain-banner]');
    assert.ok(banner.includes(chainById(chainId).name) && banner.includes(String(chainId)), `banner names the network: ${banner}`);
    await shot(`confirm-${label}`);
    await tap('[data-testid=send-confirm]');
    await page.waitForSelector('[data-testid=send-confirmed]', { timeout: 60000 });
    await shot(`sent-${label}`);
    await page.click('[data-testid=send-confirmed] .btn-primary'); // Send another
  };

  await sendOnce(3961, 'native', '0.5', 'fmx');
  assert.equal(await fmx.getBalance(recipient), parseEther('0.5'));
  ok(`[${name}] sent 0.5 FMX on the 3961 fork; recipient balance checked on chain`);

  await sendOnce(3961, USDF.address.toLowerCase(), '12.5', 'usdf');
  assert.equal(await new Contract(USDF.address, ERC20, fmx).balanceOf(recipient), parseUnits('12.5', USDF.decimals));
  ok(`[${name}] sent 12.5 USDF (FRC-20) on the 3961 fork; recipient balance checked`);

  await sendOnce(56, 'native', '0.01', 'bnb');
  assert.equal(await bsc.getBalance(recipient), parseEther('0.01'));
  ok(`[${name}] sent 0.01 BNB on the BSC fork; recipient balance checked`);

  await sendOnce(56, USDT_BSC.address.toLowerCase(), '3', 'usdt');
  assert.equal(await new Contract(USDT_BSC.address, ERC20, bsc).balanceOf(recipient), parseUnits('3', USDT_BSC.decimals));
  ok(`[${name}] sent 3 USDT on the BSC fork; recipient balance checked`);

  /* --- NFTs: move Ferminux Agents #41 to this wallet ON THE FORK, then send it on through the UI --- */
  const agents = new Contract(
    AGENTS,
    ['function ownerOf(uint256) view returns (address)', 'function safeTransferFrom(address,address,uint256)'],
    fmx,
  );
  const holderNow = await agents.ownerOf(41);
  await fmx.send('anvil_impersonateAccount', [holderNow]);
  await fmx.send('anvil_setBalance', [holderNow, toBeHex(parseEther('1'))]);
  const moveHash = await fmx.send('eth_sendTransaction', [
    { from: holderNow, to: AGENTS, data: agents.interface.encodeFunctionData('safeTransferFrom', [holderNow, me, 41n]) },
  ]);
  await fmx.waitForTransaction(moveHash);
  await fmx.send('anvil_stopImpersonatingAccount', [holderNow]);
  assert.equal(await agents.ownerOf(41), me);
  // Warm the fork: its first read of each ownerOf slot goes to the remote RPC,
  // and 41 cold reads in one batch can outlast the wallet's 10 s NFT timeout.
  await Promise.all(Array.from({ length: 41 }, (_, i) => agents.ownerOf(i + 1).catch(() => null)));
  const citizens = new Contract(KNOWN_COLLECTIONS[1].address, ['function totalIds() view returns (uint256)', 'function tokensInfo(uint256,uint256) view returns (uint8[],address[])'], fmx);
  await citizens.tokensInfo(1n, await citizens.totalIds()).catch(() => null);
  await tap('[data-testid=tab-nfts]');
  await page.waitForSelector('[data-testid=nft-41]', { timeout: 60000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid=nft-41] img.nft-img');
    return img && img.complete && img.naturalWidth > 0;
  }, { timeout: 30000 });
  await shot('nfts');
  await tap('[data-testid=nft-41]');
  await page.fill('#nft-to', recipient);
  await tap('[data-testid=nft-review]');
  await page.waitForSelector('[data-testid=nft-confirm]', { timeout: 60000 });
  await shot('nft-confirm');
  await tap('[data-testid=nft-confirm]');
  await page.waitForSelector('.modal .notice-success', { timeout: 60000 });
  assert.equal(await agents.ownerOf(41), recipient);
  await page.click('[data-testid=modal-close]');
  ok(`[${name}] Ferminux Agents #41 listed with its tokenURI image, sent with safeTransferFrom; ownerOf checked on the fork`);

  await tap('[data-testid=tab-activity]');
  await tap('[data-testid=activity-chain-56]');
  await page.waitForSelector('[data-testid=local-activity-56] li');
  const rows = await page.$$eval('[data-testid=local-activity-56] li', (els) => els.map((e) => e.textContent));
  assert.equal(rows.length, 2);
  const links = await page.$$eval('[data-testid=local-activity-56] a', (els) => els.map((a) => a.getAttribute('href')));
  assert.ok(links.every((h) => h.startsWith('https://bscscan.com/tx/0x')), links.join(' '));
  await shot('activity-bsc');
  ok(`[${name}] Activity on BSC lists both sends from this device, each linking to BscScan`);

  /* --- WalletConnect through the confirm modals --- */
  await tap('[data-testid=tab-connect]');
  await page.fill('#wc-uri', `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`);
  await tap('[data-testid=wc-pair]');
  await page.waitForSelector('[data-testid=wc-proposal]', { timeout: 20000 });
  const proposalText = await page.textContent('[data-testid=wc-proposal]');
  assert.ok(proposalText.includes('Smoke dApp') && proposalText.includes('https://smoke.example'));
  assert.ok(proposalText.includes('BNB Smart Chain') && /1 other network this wallet does not use/.test(proposalText), 'unsupported optional chain counted, not shared');
  await shot('wc-proposal');
  await tap('[data-testid=wc-proposal-approve]');
  await page.waitForSelector('[data-testid=wc-sessions] li');
  const approved = await page.evaluate(() => window.__wcCalls.find((c) => c[0] === 'approveSession')[1].namespaces.eip155);
  assert.deepEqual(approved.chains, ['eip155:3961', 'eip155:56']);
  assert.deepEqual(approved.accounts, [`eip155:3961:${me}`, `eip155:56:${me}`]);
  await shot('wc-sessions');
  ok(`[${name}] WalletConnect proposal shown with dApp, URL and networks; approved for ${approved.chains.join(', ')} only`);

  const message = 'Sign in to Smoke dApp\nNonce: 7';
  await page.evaluate(([m, a]) => window.__wcRequest(11, 'personal_sign', [m, a], 'eip155:3961'), [message, me]);
  await page.waitForSelector('[data-testid=wc-request][data-method=personal_sign]');
  assert.equal((await page.textContent('[data-testid=wc-message]')).trim(), message);
  await shot('wc-personal-sign');
  await tap('[data-testid=wc-approve]');
  await page.waitForFunction(() => window.__wcCalls.some((c) => c[0] === 'respond' && c[1].response.id === 11));
  const sig = await page.evaluate(() => window.__wcCalls.find((c) => c[0] === 'respond' && c[1].response.id === 11)[1].response.result);
  assert.equal(verifyMessage(message, sig), me);
  ok(`[${name}] personal_sign confirmed in its modal; the signature recovers to the active account`);

  const wcTo = Wallet.createRandom().address;
  await page.evaluate(
    ([from, to]) => window.__wcRequest(12, 'eth_sendTransaction', [{ from, to, value: '0x2386f26fc10000' }], 'eip155:56'),
    [me, wcTo],
  );
  await page.waitForSelector('[data-testid=wc-request][data-method=eth_sendTransaction] [data-testid=chain-banner]');
  await page.waitForFunction(() => !document.querySelector('[data-testid=wc-approve]')?.disabled, { timeout: 60000 });
  await shot('wc-send-tx');
  await tap('[data-testid=wc-approve]');
  await page.waitForFunction(() => window.__wcCalls.some((c) => c[0] === 'respond' && c[1].response.id === 12), { timeout: 60000 });
  const txHash = await page.evaluate(() => window.__wcCalls.find((c) => c[0] === 'respond' && c[1].response.id === 12)[1].response.result);
  const receipt = await bsc.waitForTransaction(txHash, 1, 30000);
  assert.equal(receipt.status, 1);
  assert.equal(await bsc.getBalance(wcTo), parseEther('0.01'));
  ok(`[${name}] eth_sendTransaction on BSC confirmed in its modal and mined on the fork (${txHash.slice(0, 12)}…)`);

  await page.evaluate(() => window.__wcRequest(13, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }], 'eip155:3961'));
  await page.waitForSelector('[data-testid=wc-request][data-method=wallet_switchEthereumChain]');
  await shot('wc-switch');
  await tap('[data-testid=wc-approve]');
  await page.waitForFunction(() => window.__wcCalls.some((c) => c[0] === 'respond' && c[1].response.id === 13));
  const switched = await page.evaluate(() => ({
    update: window.__wcCalls.filter((c) => c[0] === 'update').pop()?.[1].namespaces.eip155.chains,
    event: window.__wcCalls.filter((c) => c[0] === 'event').pop()?.[1].event,
  }));
  assert.ok(switched.update.includes('eip155:8453'));
  assert.deepEqual(switched.event, { name: 'chainChanged', data: 8453 });
  ok(`[${name}] wallet_switchEthereumChain → Base: confirmed, session extended, chainChanged emitted`);

  // eth_sign is refused as unsupported (unit-tested in tests/walletconnect.test.mjs); no modal to drive.

  if (mobile) {
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      for (const t of ['assets', 'nfts', 'activity', 'connect', 'settings', 'send']) {
        if (t === 'send') {
          await page.click('[data-testid=tab-assets] >> visible=true');
          await page.click('[data-testid=send-open]');
        } else await page.click(`[data-testid=tab-${t}] >> visible=true`);
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
        assert.ok(m.doc <= m.win, `${w}px ${t}: page scrolls sideways (${m.doc} > ${m.win})`);
      }
    }
    ok(`[${name}] no horizontal scroll at 320 / 360 / 390 / 430 px on any tab`);
  }

  assert.deepEqual(jsErrors, [], `uncaught JS errors: ${jsErrors.join(' | ')}`);
  await ctx.close();
}

async function main() {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).error) skip('anvil is not installed');
  const chromium = await loadPlaywright();
  if (!chromium) skip('Playwright is not resolvable (set PLAYWRIGHT_MODULE)');

  const work = await mkdtemp(join(tmpdir(), 'ferminux-multichain-'));
  const dist = join(work, 'dist');
  const shots = process.env.SMOKE_OUT ?? join(work, 'shots');
  await mkdir(shots, { recursive: true });

  const build = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_RPC_URLS: FMX_RPC, VITE_RPC_BSC: BSC_RPC, VITE_WC_TEST_KIT: '1' },
  });
  if (build.status !== 0) throw new Error('vite build failed');

  const forks = [
    spawn('anvil', ['--fork-url', 'https://rpc.ferminux.net', '--chain-id', '3961', '--port', String(FMX_PORT), '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] }),
    spawn('anvil', ['--fork-url', 'https://bsc-rpc.publicnode.com', '--chain-id', '56', '--port', String(BSC_PORT), '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] }),
  ];
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
    const bsc = await waitRpc(BSC_RPC);
    assert.equal((await fmx.getNetwork()).chainId, 3961n);
    assert.equal((await bsc.getNetwork()).chainId, 56n);
    ok(`anvil forks up: Ferminux 3961 on :${FMX_PORT}, BSC 56 on :${BSC_PORT}; bundle on :${WEB_PORT}`);

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
    await pass(browser, { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }, shots, fmx, bsc);
    await pass(browser, { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false }, shots, fmx, bsc);
    console.log(`\nMULTICHAIN SMOKE: all ${n} checks passed.\nScreenshots: ${shots}`);
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
    for (const f of forks) f.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('\nMULTICHAIN SMOKE FAILED:', e);
  process.exit(1);
});
