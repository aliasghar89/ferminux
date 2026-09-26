#!/usr/bin/env node
// Browser smoke of Home → Swap, at phone (390×844, touch) and desktop
// (1440×900) sizes, against a local anvil FORK of Ferminux (chain 3961):
//
//   1. forks the chain and, ON THE FORK ONLY, seeds a WFMX/USDF pool at the
//      official $0.52 per FMX from the treasury (impersonated) unless the chain
//      already has one — nothing is ever sent to the public chain;
//   2. builds the real bundle with the Ferminux RPC pointed at the fork;
//   3. phone: creates a wallet, funds it on the fork, and swaps
//        FMX → USDF   (one pool, FMX attached, no approval),
//        USDF → AZNT  (exact approval as step 1, then a route through WFMX),
//        AZNT → FMX   (Max, exact approval, swapExactTokensForFMX),
//      checking each quote against the router's own getAmountsOut, each
//      confirm screen (contract, method, amounts, minimum, fee, route), each
//      receipt, balance and allowance on the fork, and that a price that moves
//      past the tolerance between the confirm screen and Sign is refused with
//      nothing broadcast;
//   4. seeds a USDF/AZNT pool at the gateway's basis (1 USD = 1.70 AZN) on the
//      fork, then desktop: FMX → AZNT picks whichever route pays most (checked
//      against every candidate on the router), a severe price impact needs an
//      explicit acknowledgement, FMX → WFMX is a wrap (deposit()), and an asset
//      screen's Swap button starts the form from that asset;
//   5. no horizontal scroll at 320–430 px, no uncaught page errors.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/swap-smoke.mjs
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
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, getAddress, parseEther, parseUnits, toBeHex } from 'ethers';
import { DEX, candidatePaths, indexPools, readPools, routeBases } from '../src/lib/swap.ts';
import { formatAmount } from '../src/lib/validate.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FMX_PORT = Number(process.env.SMOKE_FMX_PORT ?? 28591);
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 28593);
const FMX_RPC = `http://127.0.0.1:${FMX_PORT}`;
const PASSWORD = 'swap smoke 3961 fork';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

const WFMX = getAddress(DEX.wfmx);
const USDF = getAddress('0xCd032A609e34121D1881E8DE7355b2c2c7092363');
const AZNT = getAddress('0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178');
/** Holds ~10.2M FMX and 500,000 USDF on chain 3961; impersonated on the fork only. */
const TREASURY = getAddress('0xc0A5Eb613f859f072554F29f1Ab7400265af15aB');
/** Holds the AZNT float; impersonated on the fork only. */
const AZNT_OPS = getAddress('0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE');
/** The official FMX price (the pay-in price) and the gateway's AZN basis (agents/gateway/src/constants.ts). */
const USD_PER_FMX = { num: 52n, den: 100n };
const AZN_PER_USD = { num: 170n, den: 100n };

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
];
const ROUTER = [
  'function addLiquidityFMX(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountFMXMin, uint256 minLiquidity, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 minLiquidity, address to, uint256 deadline) returns (uint256, uint256, uint256)',
  'function swapExactFMXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
];
const FACTORY = ['function getPair(address,address) view returns (address)'];

let n = 0;
const ok = (m) => console.log(`  ✓ ${String(++n).padStart(2)}. ${m}`);
const info = (m) => console.log(`       · ${m}`);
const skip = (why) => {
  console.log(`swap-smoke SKIPPED: ${why}`);
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
  const p = new JsonRpcProvider(url, undefined, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 250 });
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

/** A signer for `address` on the fork (anvil_impersonateAccount), with gas. */
async function impersonate(fmx, address) {
  await fmx.send('anvil_impersonateAccount', [address]);
  const bal = await fmx.getBalance(address);
  if (bal < parseEther('10')) await fmx.send('anvil_setBalance', [address, toBeHex(parseEther('10'))]);
  return fmx.getSigner(address);
}

const deadline = async (fmx) => BigInt((await fmx.getBlock('latest')).timestamp) + 3600n;
const pairOf = (fmx, a, b) => new Contract(DEX.factory, FACTORY, fmx).getPair(a, b);
const exists = (addr) => !/^0x0{40}$/i.test(addr);

/** WFMX/USDF at $0.52 per FMX, from the treasury, on the fork. Returns what the pool holds. */
async function seedFmxUsdf(fmx) {
  if (exists(await pairOf(fmx, WFMX, USDF))) return { seeded: false };
  const t = await impersonate(fmx, TREASURY);
  const usdf = new Contract(USDF, ERC20, t);
  const usd = 100_000n * 10n ** 6n;
  assert.ok((await usdf.balanceOf(TREASURY)) >= usd, 'the treasury holds the USDF for the pool');
  const fmxAmount = (usd * 10n ** 12n * USD_PER_FMX.den) / USD_PER_FMX.num; // 192,307.69… FMX
  await (await usdf.approve(DEX.router, usd)).wait();
  const router = new Contract(DEX.router, ROUTER, t);
  await (await router.addLiquidityFMX(USDF, usd, usd, fmxAmount, 0n, TREASURY, await deadline(fmx), { value: fmxAmount })).wait();
  return { seeded: true, usd, fmxAmount };
}

/** USDF/AZNT at 1.70 AZNT per USDF (1 AZNT = 1 AZN, 1 USD = 1.70 AZN), on the fork. */
async function seedUsdfAznt(fmx) {
  if (exists(await pairOf(fmx, USDF, AZNT))) return { seeded: false };
  const ops = await impersonate(fmx, AZNT_OPS);
  const usd = 10_000n * 10n ** 6n;
  const azn = (usd * AZN_PER_USD.num) / AZN_PER_USD.den;
  await (await new Contract(AZNT, ERC20, ops).transfer(TREASURY, azn)).wait();
  const t = await impersonate(fmx, TREASURY);
  await (await new Contract(USDF, ERC20, t).approve(DEX.router, usd)).wait();
  await (await new Contract(AZNT, ERC20, t).approve(DEX.router, azn)).wait();
  await (await new Contract(DEX.router, ROUTER, t).addLiquidity(USDF, AZNT, usd, azn, usd, azn, 0n, TREASURY, await deadline(fmx))).wait();
  return { seeded: true, usd, azn };
}

/** The router's best output for this size over every candidate route, and that route. */
async function routerBest(fmx, from, to, amountIn) {
  const pools = await readPools(async (calls) => {
    const res = await fetch(FMX_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls) });
    return res.json();
  }, [USDF, AZNT]);
  const router = new Contract(DEX.router, ROUTER, fmx);
  let best = null;
  for (const path of candidatePaths(indexPools(pools), from, to, routeBases())) {
    const out = (await router.getAmountsOut(amountIn, path)).at(-1);
    if (!best || out > best.out || (out === best.out && path.length < best.path.length)) best = { path, out };
  }
  return best;
}

const bal = (fmx, token, who) => (token ? new Contract(token, ERC20, fmx).balanceOf(who) : fmx.getBalance(who));
const allowance = (fmx, token, who) => new Contract(token, ERC20, fmx).allowance(who, DEX.router);
const txt = async (page, sel) => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
const num = (s) => s.replace(/[^0-9.]/g, '');

/** The page under test, so a failure can leave a screenshot and the open dialog's text. */
let current = null;

async function createWallet(page, tap) {
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
  return getAddress((await page.getAttribute('[data-testid=active-address]', 'data-address')).trim());
}

/** Pick a token on one side through the picker. */
async function pick(page, tap, side, key) {
  await tap(`[data-testid=swap-token-${side}]`);
  await page.waitForSelector(`[data-testid=swap-picker][data-side=${side}]`);
  await tap(`[data-testid=swap-pick-${key}]`);
  await page.waitForSelector('[data-testid=swap-picker]', { state: 'detached' });
}

/** Wait for the form's balance of the paying token to show `min` or more (the portfolio refreshes every 10 s). */
async function waitBalanceIn(page, min, decimals) {
  await page.waitForFunction(
    ([m, d]) => {
      const el = document.querySelector('[data-testid=swap-bal-in]');
      const v = el && /Balance ([\d,.]+)/.exec(el.textContent);
      if (!v) return false;
      const [w, f = ''] = v[1].replace(/,/g, '').split('.');
      const units = BigInt(w) * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0');
      return units >= BigInt(m);
    },
    [String(min), decimals],
    { timeout: 40000 },
  );
}

/** Type an amount and wait until the quote is on screen (and, with `want`, until it is exactly that text). */
async function quoteFor(page, amount, want) {
  await page.fill('[data-testid=swap-amount]', amount);
  await page.waitForFunction(
    (w) => {
      const o = document.querySelector('[data-testid=swap-out]');
      if (!o || o.classList.contains('is-empty') || !/\d/.test(o.textContent) || o.textContent === '…') return false;
      return !w || o.textContent.replace(/[^0-9.]/g, '') === w;
    },
    want ?? null,
    { timeout: 30000 },
  );
}

async function pass(browser, { name, viewport, mobile }, shots, fmx, ctx0) {
  const ctx = await browser.newContext({
    viewport,
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  const shot = async (label) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: !mobile && !(await page.$('.modal')) });
  };
  current = { page, shot };
  const tap = (sel) => (mobile ? page.tap(`${sel} >> visible=true`) : page.click(`${sel} >> visible=true`));
  const executed = [];

  const me = await createWallet(page, tap);
  await fmx.send('anvil_setBalance', [me, toBeHex(parseEther('5000'))]);
  ok(`[${name}] created a wallet ${me}; 5,000 FMX on the fork`);

  /* --- Home: Swap next to Send / Receive --- */
  const actions = await page.$$eval('.hero-actions .btn', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(actions, ['Send', 'Receive', 'Swap', 'Scan']);
  await shot('home');
  await tap('[data-testid=swap-open]');
  await page.waitForSelector('[data-testid=swap-form][data-in=native]');
  assert.match(page.url(), /#\/swap$/);
  assert.equal(await page.getAttribute('[data-testid=swap-form]', 'data-out'), USDF.toLowerCase(), 'FMX → USDF by default');
  const scope = await txt(page, '[data-testid=swap-scope]');
  assert.match(scope, /Ferminux Network \(chain 3961\) only/);
  assert.match(scope, /other networks this wallet holds is not offered/);
  await waitBalanceIn(page, parseEther('4000'), 18);
  ok(`[${name}] Home shows Send · Receive · Swap · Scan; Swap opens #/swap with FMX → USDF and says other networks are not offered`);

  if (mobile) {
    /* --- FMX → USDF: one pool, FMX attached, no approval --- */
    const want = await new Contract(DEX.router, ROUTER, fmx).getAmountsOut(parseEther('1000'), [WFMX, USDF]);
    await quoteFor(page, '1000', formatAmount(want[1], 6, 8).replace(/,/g, ''));
    assert.equal(num(await txt(page, '[data-testid=swap-out]')), formatAmount(want[1], 6, 8).replace(/,/g, ''), 'the quote on screen is the router’s');
    assert.equal(await page.getAttribute('[data-testid=swap-route]', 'data-hops'), '1');
    assert.equal((await txt(page, '[data-testid=swap-route]')).replace(/\s/g, ''), 'FMX→USDF');
    const rate = await txt(page, '[data-testid=swap-rate]');
    assert.match(rate, /^1 FMX = [\d.,]+ USDF$/, rate);
    assert.match(await txt(page, '[data-testid=swap-min]'), new RegExp(`^${formatAmount((want[1] * 9950n) / 10000n, 6, 8).replace(/[.]/g, '\\.')} USDF$`));
    await shot('form-fmx-usdf');

    await tap('[data-testid=swap-settings-open]');
    await page.waitForSelector('[data-testid=swap-settings]');
    assert.equal(await page.getAttribute('[data-testid=swap-slip-50]', 'aria-pressed'), 'true', '0.5% by default');
    assert.equal(await page.getAttribute('[data-testid=swap-approval-exact]', 'aria-pressed'), 'true', 'exact approvals by default');
    await shot('settings');
    await tap('[data-testid=swap-settings-done]');

    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=swap]', { timeout: 60000 });
    assert.equal(await txt(page, '[data-testid=swap-confirm-contract]'), DEX.router);
    assert.equal(await txt(page, '[data-testid=swap-confirm-method]'), 'swapExactFMXForTokens(uint256,address[],address,uint256)');
    assert.equal((await txt(page, '[data-testid=swap-confirm-in]')).replace(/\s/g, ''), '1000.0FMX');
    assert.match(await txt(page, '[data-testid=swap-confirm-fee]'), /FMX$/);
    assert.match(await txt(page, '[data-testid=chain-banner]'), /Ferminux.*chain 3961/);
    assert.match(await txt(page, '[data-testid=swap-checks]'), /Quote read from the router just now/);
    assert.equal(await page.$('[data-testid=swap-steps]'), null, 'FMX needs no approval step');
    await shot('confirm-fmx-usdf');
    const usdf0 = await bal(fmx, USDF, me);
    await tap('[data-testid=swap-confirm]');
    await page.waitForSelector('[data-testid=swap-done]', { timeout: 60000 });
    const got1 = (await bal(fmx, USDF, me)) - usdf0;
    assert.ok(got1 >= (want[1] * 9950n) / 10000n, 'received at least the minimum');
    assert.equal(num(await txt(page, '[data-testid=swap-done-received]')), formatAmount(got1, 6, 6).replace(/,/g, ''));
    const href = await page.getAttribute('[data-testid=swap-tx] a', 'href');
    assert.match(href, /^https:\/\/explorer\.ferminux\.net\/tx\/0x[0-9a-f]{64}$/);
    const r1 = await fmx.getTransactionReceipt(href.split('/').pop());
    assert.equal(r1.status, 1);
    assert.equal(r1.to, DEX.router);
    executed.push({ route: 'FMX → USDF', hops: 1 });
    await shot('done-fmx-usdf');
    ok(`[${name}] FMX → USDF: 1,000 FMX → ${formatUnits(got1, 6)} USDF (router quote ${formatUnits(want[1], 6)}), swapExactFMXForTokens on the router, receipt ok`);

    /* --- USDF → AZNT: exact approval, then the best route --- */
    await tap('[data-testid=swap-again]');
    await page.waitForSelector('[data-testid=swap-form]');
    await pick(page, tap, 'in', USDF.toLowerCase());
    await pick(page, tap, 'out', AZNT.toLowerCase());
    await waitBalanceIn(page, 100n * 10n ** 6n, 6);
    const usdfIn = 100n * 10n ** 6n;
    const best2 = await routerBest(fmx, USDF, AZNT, usdfIn);
    await quoteFor(page, '100', formatAmount(best2.out, 6, 8).replace(/,/g, ''));
    const hops2 = Number(await page.getAttribute('[data-testid=swap-route]', 'data-hops'));
    assert.equal(hops2, best2.path.length - 1, `the route on screen is the router’s best (${best2.path.length - 1} pools)`);
    if (!ctx0.usdfAzntOnChain) assert.equal(hops2, 2, 'no USDF/AZNT pool: the route goes through WFMX');
    assert.equal(num(await txt(page, '[data-testid=swap-out]')), formatAmount(best2.out, 6, 8).replace(/,/g, ''));
    await shot('form-usdf-aznt');
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-approve-review]', { timeout: 60000 });
    assert.equal(await txt(page, '[data-testid=swap-approve-contract]'), USDF);
    assert.equal(await txt(page, '[data-testid=swap-approve-method]'), 'approve(address,uint256)');
    assert.equal(await txt(page, '[data-testid=swap-approve-spender]'), DEX.router);
    assert.equal((await txt(page, '[data-testid=swap-approve-amount]')).replace(/\s/g, ''), '100.0USDF');
    assert.match(await txt(page, '[data-testid=swap-steps]'), /Step 1 of 2 · Approve USDF/);
    await shot('approve-usdf');
    await tap('[data-testid=swap-approve-confirm]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=swap]', { timeout: 90000 });
    assert.equal(await allowance(fmx, USDF, me), usdfIn, 'exactly 100 USDF approved to the router');
    assert.match(await txt(page, '[data-testid=swap-approved-note]'), /USDF approved to the Ferminux DEX router for exactly 100 USDF/);
    assert.match(await txt(page, '[data-testid=swap-steps]'), /Step 2 of 2 · Swap/);
    assert.equal(await txt(page, '[data-testid=swap-confirm-method]'), 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)');
    assert.equal(await page.getAttribute('[data-testid=swap-confirm-route]', 'data-hops'), String(hops2));
    await shot('confirm-usdf-aznt');
    const aznt0 = await bal(fmx, AZNT, me);
    await tap('[data-testid=swap-confirm]');
    await page.waitForSelector('[data-testid=swap-done]', { timeout: 60000 });
    const got2 = (await bal(fmx, AZNT, me)) - aznt0;
    assert.ok(got2 > 0n);
    assert.equal(num(await txt(page, '[data-testid=swap-done-received]')), formatAmount(got2, 6, 6).replace(/,/g, ''));
    assert.equal(await allowance(fmx, USDF, me), 0n, 'the exact approval was used up');
    executed.push({ route: await txt(page, '[data-testid=swap-done-text]'), hops: hops2 });
    ok(`[${name}] USDF → AZNT: approve(router, exactly 100 USDF) as step 1, then ${hops2} pool(s) → ${formatUnits(got2, 6)} AZNT; allowance back to 0`);

    /* --- AZNT → FMX: Max, approval, swapExactTokensForFMX --- */
    await tap('[data-testid=swap-again]');
    await pick(page, tap, 'in', AZNT.toLowerCase());
    await pick(page, tap, 'out', 'native');
    await waitBalanceIn(page, got2, 6);
    await tap('[data-testid=swap-max]');
    assert.equal(await page.inputValue('[data-testid=swap-amount]'), formatUnits(got2, 6).replace(/\.0$/, ''));
    await page.waitForSelector('[data-testid=swap-route]');
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-approve-review]', { timeout: 60000 });
    await tap('[data-testid=swap-approve-confirm]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=swap]', { timeout: 90000 });
    assert.equal(await txt(page, '[data-testid=swap-confirm-method]'), 'swapExactTokensForFMX(uint256,uint256,address[],address,uint256)');
    const fmx0 = await fmx.getBalance(me);
    await tap('[data-testid=swap-confirm]');
    await page.waitForSelector('[data-testid=swap-done]', { timeout: 60000 });
    assert.equal(await bal(fmx, AZNT, me), 0n, 'Max sold every AZNT');
    const fmxGain = (await fmx.getBalance(me)) - fmx0;
    assert.ok(fmxGain > 0n, 'FMX arrived (net of the fee)');
    executed.push({ route: 'AZNT → FMX', hops: 1 });
    ok(`[${name}] AZNT → FMX: Max (${formatUnits(got2, 6)} AZNT), exact approval, swapExactTokensForFMX → +${formatEther(fmxGain)} FMX net of fees`);

    /* --- the price moves past the tolerance between the confirm screen and Sign --- */
    await tap('[data-testid=swap-again]');
    await pick(page, tap, 'in', 'native');
    await pick(page, tap, 'out', USDF.toLowerCase());
    await quoteFor(page, '500');
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=swap]', { timeout: 60000 });
    const rival = Wallet.createRandom().connect(fmx);
    await fmx.send('anvil_setBalance', [rival.address, toBeHex(parseEther('50000'))]);
    const rr = new Contract(DEX.router, ROUTER, rival);
    await (await rr.swapExactFMXForTokens(0n, [WFMX, USDF], rival.address, await deadline(fmx), { value: parseEther('20000') })).wait();
    const nonce = await fmx.getTransactionCount(me, 'pending');
    await tap('[data-testid=swap-confirm]');
    await page.waitForSelector('[data-testid=swap-problem][data-code=moved]', { timeout: 60000 });
    const moved = await txt(page, '[data-testid=swap-problem]');
    assert.match(moved, /The price moved: this swap would now pay .* USDF, below your minimum of .* USDF\. Nothing was signed\./, moved);
    assert.equal(await fmx.getTransactionCount(me, 'pending'), nonce, 'nothing was broadcast');
    await shot('price-moved');
    ok(`[${name}] a 20,000 FMX trade lands between the confirm screen and Sign: refused ("${moved.slice(0, 60)}…"), nothing broadcast`);
    await tap('[data-testid=swap-problem-back]');
    await page.waitForSelector('[data-testid=swap-form]');

    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      assert.ok(m.doc <= m.win, `${w}px swap form: page scrolls sideways (${m.doc} > ${m.win})`);
    }
    await page.setViewportSize(viewport);
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-review]', { timeout: 60000 });
    for (const w of [320, 390]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      assert.ok(m.doc <= m.win, `${w}px swap confirm: page scrolls sideways (${m.doc} > ${m.win})`);
    }
    await page.setViewportSize(viewport);
    ok(`[${name}] no horizontal scroll on the swap form (320 / 360 / 390 / 430 px) or its confirm screen (320 / 390 px)`);
  } else {
    /* --- FMX → AZNT: whichever route pays most --- */
    await pick(page, tap, 'out', AZNT.toLowerCase());
    const best = await routerBest(fmx, WFMX, AZNT, parseEther('1000'));
    await quoteFor(page, '1000', formatAmount(best.out, 6, 8).replace(/,/g, ''));
    const hops = Number(await page.getAttribute('[data-testid=swap-route]', 'data-hops'));
    assert.equal(hops, best.path.length - 1, `the route on screen is the router's best: ${best.path.join(' → ')}`);
    assert.equal(num(await txt(page, '[data-testid=swap-out]')), formatAmount(best.out, 6, 8).replace(/,/g, ''));
    await page.waitForSelector('[data-testid=swap-pools] li');
    await shot('form-fmx-aznt');
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=swap]', { timeout: 60000 });
    await shot('confirm-fmx-aznt');
    const a0 = await bal(fmx, AZNT, me);
    await tap('[data-testid=swap-confirm]');
    await page.waitForSelector('[data-testid=swap-done]', { timeout: 60000 });
    const gotA = (await bal(fmx, AZNT, me)) - a0;
    assert.ok(gotA >= (best.out * 9950n) / 10000n);
    executed.push({ route: best.path.length === 3 ? 'FMX → USDF → AZNT' : 'FMX → AZNT', hops });
    await shot('done-fmx-aznt');
    ok(`[${name}] FMX → AZNT over ${hops} pool(s) (the best of every candidate on the router): 1,000 FMX → ${formatUnits(gotA, 6)} AZNT`);

    /* --- a severe price impact needs an explicit acknowledgement --- */
    await tap('[data-testid=swap-again]');
    await pick(page, tap, 'out', USDF.toLowerCase());
    await fmx.send('anvil_setBalance', [me, toBeHex(parseEther('200000'))]);
    await waitBalanceIn(page, parseEther('150000'), 18);
    await quoteFor(page, '100000');
    await page.waitForSelector('[data-testid=swap-impact-severe]');
    assert.equal(await page.isDisabled('[data-testid=swap-review]'), true, 'Review waits for the acknowledgement');
    assert.equal(await page.getAttribute('[data-testid=swap-impact] [data-level]', 'data-level'), 'severe');
    await shot('impact-severe');
    await page.check('[data-testid=swap-impact-ack]');
    assert.equal(await page.isDisabled('[data-testid=swap-review]'), false);
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=swap]', { timeout: 60000 });
    await page.waitForSelector('[data-testid=swap-confirm-impact-note]');
    assert.equal(await page.getAttribute('[data-testid=swap-confirm-impact] [data-level]', 'data-level'), 'severe');
    await shot('confirm-impact');
    await tap('.cta-bar .actions-split .btn:not(.btn-primary)');
    await page.waitForSelector('[data-testid=swap-form]');
    ok(`[${name}] 100,000 FMX into the USDF pool: severe price impact flagged, Review locked until acknowledged, repeated on the confirm screen (not signed)`);

    /* --- FMX → WFMX is a wrap --- */
    await pick(page, tap, 'out', WFMX.toLowerCase());
    await quoteFor(page, '10');
    assert.match(await txt(page, '[data-testid=swap-wrap-note]'), /1 : 1/);
    await tap('[data-testid=swap-review]');
    await page.waitForSelector('[data-testid=swap-review][data-kind=wrap]', { timeout: 60000 });
    assert.equal(await txt(page, '[data-testid=swap-confirm-contract]'), WFMX);
    assert.equal(await txt(page, '[data-testid=swap-confirm-method]'), 'deposit()');
    const w0 = await bal(fmx, WFMX, me);
    await tap('[data-testid=swap-confirm]');
    await page.waitForSelector('[data-testid=swap-done]', { timeout: 60000 });
    assert.equal((await bal(fmx, WFMX, me)) - w0, parseEther('10'));
    ok(`[${name}] FMX → WFMX is a wrap: deposit() on WFMX, exactly 10 WFMX received`);

    /* --- an asset screen's Swap button --- */
    // Hash navigation, not a reload: this wallet is session-only, so a reload would lock it.
    await page.evaluate((h) => {
      window.location.hash = h;
    }, `#/asset/3961/${AZNT}`);
    await page.waitForSelector('[data-testid=asset-swap]');
    await tap('[data-testid=asset-swap]');
    await page.waitForSelector(`[data-testid=swap-form][data-in="${AZNT.toLowerCase()}"][data-out=native]`);
    await page.evaluate(() => {
      window.location.hash = '#/asset/56/native';
    });
    await page.waitForSelector('[data-testid=asset-send]');
    assert.equal(await page.$('[data-testid=asset-swap]'), null, 'no Swap on another network');
    ok(`[${name}] AZNT's asset screen opens Swap selling AZNT for FMX; a BNB Smart Chain asset has no Swap button`);
  }

  assert.deepEqual(jsErrors, [], `uncaught JS errors: ${jsErrors.join(' | ')}`);
  await ctx.close();
  return executed;
}

async function main() {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).error) skip('anvil is not installed');
  const chromium = await loadPlaywright();
  if (!chromium) skip('Playwright is not resolvable (set PLAYWRIGHT_MODULE)');

  const work = await mkdtemp(join(tmpdir(), 'ferminux-swap-'));
  const dist = join(work, 'dist');
  const shots = process.env.SMOKE_OUT ?? join(work, 'shots');
  await mkdir(shots, { recursive: true });

  const build = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_RPC_URLS: FMX_RPC },
  });
  if (build.status !== 0) throw new Error('vite build failed');

  // Another process on the fork's port would be tested (and killed) instead of ours.
  const taken = await fetch(FMX_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`port ${FMX_PORT} is already in use: set SMOKE_FMX_PORT`);
  const fork = spawn('anvil', ['--fork-url', process.env.FORK_URL ?? 'https://rpc.ferminux.net', '--chain-id', '3961', '--port', String(FMX_PORT), '--silent'], {
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
    ok(`anvil fork of Ferminux 3961 on :${FMX_PORT} (block ${await fmx.getBlockNumber()}); bundle on :${WEB_PORT}`);

    const usdfAzntOnChain = exists(await pairOf(fmx, USDF, AZNT));
    const s1 = await seedFmxUsdf(fmx);
    const pUsd = await readPools(async (calls) => (await fetch(FMX_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls) })).json(), [USDF, AZNT]);
    const wu = pUsd.find((p) => [p.token0, p.token1].every((t) => [WFMX, USDF].includes(getAddress(t))));
    const [rw, ru] = getAddress(wu.token0) === WFMX ? [wu.reserve0, wu.reserve1] : [wu.reserve1, wu.reserve0];
    const price = Number(ru * 10n ** 12n * 10000n / rw) / 10000;
    ok(
      s1.seeded
        ? `seeded WFMX/USDF on the fork from the treasury: ${formatEther(s1.fmxAmount)} FMX + ${formatUnits(s1.usd, 6)} USDF = $${price} per FMX`
        : `WFMX/USDF already on chain 3961: $${price} per FMX (not reseeded)`,
    );
    if (s1.seeded) assert.equal(price, 0.52);
    info(`USDF/AZNT pool on chain 3961 before the smoke: ${usdfAzntOnChain ? 'yes' : 'no'}`);

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
    const phone = await pass(browser, { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true }, shots, fmx, { usdfAzntOnChain });

    const s2 = await seedUsdfAznt(fmx);
    ok(
      s2.seeded
        ? `seeded USDF/AZNT on the fork at the gateway basis (1 USD = 1.70 AZN): ${formatUnits(s2.usd, 6)} USDF + ${formatUnits(s2.azn, 6)} AZNT`
        : 'USDF/AZNT already on chain 3961 (not reseeded)',
    );
    const desk = await pass(browser, { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false }, shots, fmx, { usdfAzntOnChain: true });
    const all = [...phone, ...desk];
    info(`swaps executed: ${all.map((s) => `${s.route} (${s.hops})`).join('; ')}`);
    assert.ok(all.some((s) => s.hops >= 2), 'at least one swap went through more than one pool');
    console.log(`\nSWAP SMOKE: all ${n} checks passed.\nScreenshots: ${shots}`);
  } catch (e) {
    if (current) {
      await current.shot('FAILED').catch(() => undefined);
      const dialog = await current.page.textContent('.modal').catch(() => null);
      if (dialog) console.error(`open dialog: ${dialog.replace(/\s+/g, ' ').slice(0, 600)}`);
      const problem = await current.page.textContent('[data-testid=swap-problem], [data-testid=swap-failed], [data-testid=swap-form-error]').catch(() => null);
      if (problem) console.error(`on screen: ${problem.replace(/\s+/g, ' ').slice(0, 600)}`);
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
  console.error('\nSWAP SMOKE FAILED:', e);
  process.exit(1);
});
