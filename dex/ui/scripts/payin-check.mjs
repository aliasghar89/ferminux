#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Browser check of "pay with any coin" on the built DEX. Nothing real is
// touched: the pay-in API (ferminux.net/api/payin) is a mock that behaves like
// the gateway (exact-amount quotes with dust stepped down, deposits attributed
// by exact amount and sender, quoted → seen → confirmed → paid); the seven
// networks' public endpoints answer from fixed balances; chain 3961 is a tiny
// local JSON-RPC; the wallet is a scripted injected provider that records
// every transaction it is asked to send and never broadcasts anything.
//
//   • the "You pay" picker lists USDT / USDC / the native coin on each network
//     with the wallet's balance there; a paused network cannot be picked
//   • picking one turns Swap into "Buy FMX with <coin> on <network>", FMX locked
//   • quote → review (exact amount, deposit address, network, recipient, clock)
//     → the wallet is switched to that network (added first when unknown) →
//     it sends EXACTLY sendExactly: the right token contract or native value,
//     the right deposit address, on the right chain, from the quoting account
//   • 18-decimal USDT on BNB Smart Chain, 6-decimal USDC on Base, native AVAX
//   • the tracker follows seen → confirmed → paid with explorer links, and
//     survives a reload; "Switch back to Ferminux" puts the wallet home
//   • guards: <60 s left, a wallet that drifts off the network before sending,
//     amounts outside $1–$10,000, not enough balance, a paused network
//   • 320 / 390 / 1440 px: no horizontal scroll in any of these states
//   • no console errors
//
//   npm run ui:payin      PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs (or PLAYWRIGHT_DIR)
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DEPOSIT = '0xc2a7B343a8a9ef2eC5D15c31225A64AC9FDC05Fa';
const E18 = 10n ** 18n;
const PRICE = 520_000_000_000_000_000n;
const WIDTHS = [320, 390, 1440];
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const ASSETS = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/payin-assets.json'), 'utf8'));

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}. ${msg}`);
const skip = (why) => {
  console.log(`payin-check SKIPPED: ${why}`);
  process.exit(0);
};

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    process.env.PLAYWRIGHT_DIR && join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs'),
    join(ROOT, 'node_modules/playwright/index.mjs'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return import(c);
  return null;
}

// ---- the seven networks: what the gateway pins, and what this wallet holds there ----
const CHAINS = Object.fromEntries(ASSETS.chains.map((c) => [c.chain, c]));
const HOST_CHAIN = {
  'ethereum-rpc.publicnode.com': 1, 'eth.drpc.org': 1,
  'bsc-dataseed.bnbchain.org': 56, 'bsc-rpc.publicnode.com': 56,
  'mainnet.base.org': 8453, 'base-rpc.publicnode.com': 8453,
  'arb1.arbitrum.io': 42161, 'arbitrum-one-rpc.publicnode.com': 42161,
  'polygon-bor-rpc.publicnode.com': 137, 'polygon.drpc.org': 137,
  'mainnet.optimism.io': 10, 'optimism-rpc.publicnode.com': 10,
  'api.avax.network': 43114, 'avalanche-c-chain-rpc.publicnode.com': 43114,
};
const tokenAddr = (chain, sym) => CHAINS[chain].assets.find((a) => a.symbol === sym).token.toLowerCase();
const HOLDINGS = {
  1: { native: 2n * 10n ** 16n, tokens: {} },
  56: { native: 5n * 10n ** 16n, tokens: { [tokenAddr('bsc', 'USDT')]: 250n * E18, [tokenAddr('bsc', 'USDC')]: 0n } },
  8453: { native: 2n * 10n ** 16n, tokens: { [tokenAddr('base', 'USDC')]: 100_000_000n } },
  42161: { native: 10n ** 16n, tokens: {} },
  137: { native: 50n * E18, tokens: {} },
  10: { native: 10n ** 16n, tokens: {} },
  43114: { native: 3n * E18, tokens: {} },
};
const ASSET_USD = { ETH: 2500n * E18, BNB: 600n * E18, POL: E18 / 2n, AVAX: 30n * E18, USDC: E18, USDT: E18 };

function payRpc(chainId, body) {
  const one = ({ id, method, params }) => {
    const h = HOLDINGS[chainId] ?? { native: 0n, tokens: {} };
    const hex = (v) => '0x' + v.toString(16);
    switch (method) {
      case 'eth_chainId':
        return { id, result: hex(BigInt(chainId)) };
      case 'eth_gasPrice':
        return { id, result: hex(1_000_000_000n) };
      case 'eth_getBalance':
        return { id, result: hex(params[0].toLowerCase() === ME.toLowerCase() ? h.native : 0n) };
      case 'eth_call': {
        const to = String(params[0].to).toLowerCase();
        const who = '0x' + String(params[0].data).slice(-40);
        const bal = who.toLowerCase() === ME.toLowerCase() ? (h.tokens[to] ?? 0n) : 0n;
        return { id, result: '0x' + bal.toString(16).padStart(64, '0') };
      }
      default:
        return { id, error: { code: -32601, message: `mock: ${method}` } };
    }
  };
  return Array.isArray(body) ? body.map((b) => ({ jsonrpc: '2.0', ...one(b) })) : { jsonrpc: '2.0', ...one(body) };
}

// ---- chain 3961: just enough for the page to render with no pools ----
function ferminuxRpc(body) {
  const now = Math.floor(Date.now() / 1000);
  const block = {
    number: '0x4e20', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x' + now.toString(16),
    nonce: '0x0000000000000000', difficulty: '0x1', totalDifficulty: '0x1', gasLimit: '0x5f5e100', gasUsed: '0x0',
    miner: '0x' + '00'.repeat(20), extraData: '0x', baseFeePerGas: '0x0', transactions: [], uncles: [],
    sha3Uncles: '0x' + '33'.repeat(32), stateRoot: '0x' + '44'.repeat(32), receiptsRoot: '0x' + '55'.repeat(32),
    transactionsRoot: '0x' + '66'.repeat(32), logsBloom: '0x' + '00'.repeat(256), mixHash: '0x' + '00'.repeat(32), size: '0x200',
  };
  const one = ({ id, method }) => {
    switch (method) {
      case 'eth_chainId': return { id, result: '0xf79' };
      case 'net_version': return { id, result: '3961' };
      case 'eth_blockNumber': return { id, result: '0x4e20' };
      case 'eth_getBlockByNumber': case 'eth_getBlockByHash': return { id, result: block };
      case 'eth_call': return { id, result: '0x' + '0'.repeat(64) };
      case 'eth_getLogs': return { id, result: [] };
      case 'eth_getBalance': return { id, result: '0x0' };
      case 'eth_gasPrice': return { id, result: '0x3b9aca00' };
      case 'eth_maxPriorityFeePerGas': return { id, result: '0x0' };
      case 'eth_getTransactionCount': return { id, result: '0x0' };
      default: return { id, error: { code: -32601, message: `mock: ${method}` } };
    }
  };
  return Array.isArray(body) ? body.map((b) => ({ jsonrpc: '2.0', ...one(b) })) : { jsonrpc: '2.0', ...one(body) };
}

// ---- the pay-in: a mock of agents/gateway/src/v3/payin.ts ----
const payin = {
  quotes: new Map(),
  requests: [],
  driftOn: null,
  others: new Set(),
  unattributed: [],
  expiresNext: null,
  assets: (() => {
    const a = JSON.parse(JSON.stringify(ASSETS));
    const polygon = a.chains.find((c) => c.chain === 'polygon');
    polygon.available = false;
    polygon.unavailableReason = 'deposit scanner is not reaching this chain right now, pay on another chain';
    a.availableChains = a.availableChains.filter((c) => c !== 'polygon');
    return a;
  })(),
};

const fmtUnits = (u, d) => {
  const D = 10n ** BigInt(d);
  const f = (u % D).toString().padStart(d, '0').replace(/0+$/, '');
  return `${u / D}.${f || '0'}`;
};
const parseUnits = (s, d) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 10n ** BigInt(d) + (f ? BigInt(f.padEnd(d, '0')) : 0n);
};

function quote(body) {
  const c = CHAINS[body.chain];
  if (!c) return [400, { error: 'chain must be one of …' }];
  if (!c.available || c.chain === 'polygon') return [503, { error: `pay-in on ${c.name} is temporarily unavailable (scanner); pay on bsc`, unavailable: true }];
  const a = c.assets.find((x) => x.symbol === body.asset);
  const wanted = parseUnits(body.amount, a.decimals);
  // As the gateway does: this payer's older open quote on the same coin is superseded (it stays
  // matchable), then the amount steps DOWN past every OPEN quote's amount. Other customers are
  // taken to hold the three amounts right at the one asked for.
  for (const s of payin.quotes.values()) {
    if (s.status === 'quoted' && s.q.chain === body.chain && s.q.asset === body.asset && s.q.from.toLowerCase() === body.from.toLowerCase()) s.status = 'superseded';
  }
  const open = new Set([...payin.quotes.values()].filter((s) => s.status === 'quoted' && s.q.chain === body.chain && s.q.asset === body.asset).map((s) => s.q.sendExactly));
  // A typed amount (6 decimals or fewer): other customers hold it and the two units under it.
  if ((body.amount.split('.')[1] ?? '').length <= 6) for (let i = 0n; i < 3n; i++) payin.others.add(`${body.chain}:${body.asset}:${wanted - i}`);
  let units = wanted;
  while (open.has(units.toString()) || payin.others.has(`${body.chain}:${body.asset}:${units}`)) units -= 1n;
  const usdE18 = (units * ASSET_USD[a.symbol]) / 10n ** BigInt(a.decimals);
  const usd = Number(usdE18) / 1e18;
  if (usd < 1 || usd > 10_000) return [400, { error: `amount must be worth between 1 and 10000 USD (this is ≈ ${usd.toFixed(2)} USD)` }];
  const fmxOut = (usdE18 * E18 * 9800n) / (10_000n * PRICE);
  const quoteId = 'q_' + randomBytes(8).toString('hex');
  const t = Math.floor(Date.now() / 1000);
  const expires = payin.expiresNext ?? 900;
  payin.expiresNext = null;
  const q = {
    quoteId, chain: body.chain, chainId: c.chainId, chainName: c.name, asset: a.symbol, assetKind: a.kind, token: a.token, decimals: a.decimals,
    amount: fmtUnits(units, a.decimals), amountRequested: fmtUnits(wanted, a.decimals), dustUnits: '3', dustDirection: 'down',
    sendExactly: units.toString(), sendExactlyFormatted: fmtUnits(units, a.decimals), usd: fmtUnits(usdE18, 18), assetUsd: fmtUnits(ASSET_USD[a.symbol], 18),
    depositAddress: DEPOSIT, fmxOut: fmxOut.toString(), fmxOutFormatted: fmtUnits(fmxOut, 18), priceUsdPerFmx: '0.52', spreadBps: 200,
    to: body.to, from: body.from, expiresAt: t + expires, expires, confirmations: c.confirmations, status: 'quoted', explorer: c.explorer, note: 'Send exactly …',
  };
  payin.quotes.set(quoteId, { q, status: 'quoted', txIn: null, polls: 0, txOut: null });
  return [201, q];
}

function status(quoteId) {
  const s = payin.quotes.get(quoteId);
  if (!s) return [404, { error: 'quote not found' }];
  if (s.txIn && s.status !== 'paid') {
    s.polls += 1;
    s.status = s.polls <= 1 ? 'seen' : s.polls <= 2 ? 'seen' : s.polls <= 3 ? 'confirmed' : 'paid';
    if (s.status === 'paid' && !s.txOut) s.txOut = '0x' + randomBytes(32).toString('hex');
  }
  const c = CHAINS[s.q.chain];
  const conf = s.status === 'seen' ? (s.polls <= 1 ? 3 : 9) : s.status === 'quoted' ? 0 : c.confirmations;
  return [200, {
    quoteId, chain: s.q.chain, chainId: c.chainId, asset: s.q.asset, assetKind: s.q.assetKind, token: s.q.token, decimals: s.q.decimals,
    amount: s.q.amount, amountUnits: s.q.sendExactly, sendExactly: s.q.sendExactly, sendExactlyFormatted: s.q.sendExactlyFormatted,
    usd: s.q.usd, fmxOut: s.q.fmxOut, fmxOutFormatted: s.q.fmxOutFormatted, priceUsdPerFmx: '0.52', target: s.q.to, payer: s.q.from,
    depositAddress: DEPOSIT, status: s.status, txHashIn: s.txIn, blockIn: s.txIn ? 100 : null, confirmations: conf, required: c.confirmations,
    txHashOut: s.txOut,
    txHashes: {
      deposit: s.txIn ? { chain: s.q.chain, chainId: c.chainId, hash: s.txIn, url: `${c.explorer}/tx/${s.txIn}` } : null,
      fmx: s.txOut ? { chain: 'ferminux', chainId: 3961, hash: s.txOut, url: `https://explorer.ferminux.net/tx/${s.txOut}` } : null,
    },
    error: null, createdAt: 0, expiresAt: s.q.expiresAt, seenAt: null, paidAt: null, enabled: true,
  }];
}

/** A transfer the wallet sent, attributed like the gateway does: by network, coin, exact amount and sender. */
function attribute(chainId, tx, hash) {
  const c = Object.values(CHAINS).find((x) => x.chainId === chainId);
  let asset;
  let units;
  let to;
  if (tx.data && tx.data !== '0x') {
    const a = c?.assets.find((x) => x.token && x.token.toLowerCase() === String(tx.to).toLowerCase());
    const [dest, amount] = ERC20.decodeFunctionData('transfer', tx.data);
    asset = a?.symbol;
    units = amount;
    to = dest;
    assert.equal(BigInt(tx.value ?? '0x0'), 0n, 'a token transfer carries no value');
  } else {
    asset = c?.assets.find((x) => x.kind === 'native')?.symbol;
    units = BigInt(tx.value);
    to = tx.to;
  }
  // The gateway's attribute(): the OLDEST open or superseded quote with this exact amount from this sender.
  const match = [...payin.quotes.values()].find(
    (s) => (s.status === 'quoted' || s.status === 'superseded') && CHAINS[s.q.chain].chainId === chainId && s.q.asset === asset && BigInt(s.q.sendExactly) === units &&
      String(to).toLowerCase() === DEPOSIT.toLowerCase() && String(tx.from).toLowerCase() === String(s.q.from).toLowerCase(),
  );
  if (!match) {
    payin.unattributed.push({ chainId, tx });
    return null;
  }
  match.txIn = hash;
  return match.q.quoteId;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

async function main() {
  const pw = await loadPlaywright();
  if (!pw?.chromium) skip('Playwright not found (set PLAYWRIGHT_MODULE or PLAYWRIGHT_DIR)');

  const work = process.env.PAYIN_CHECK_OUT ?? (await mkdtemp(join(tmpdir(), 'ferminux-dex-payin-')));
  await mkdir(work, { recursive: true });
  let port = 0;
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (path === '/rpc') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(ferminuxRpc(JSON.parse(raw))));
    }
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    const file = join(work, 'dist', path === '/' ? 'index.html' : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  // The shipped bundle: the real pay-in URL and network endpoints (intercepted below), a local chain 3961.
  const r = spawnSync('node', [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(work, 'dist'), '--emptyOutDir'], {
    cwd: ROOT,
    env: { ...process.env, VITE_RPC_URLS: `${url}rpc`, VITE_EXPLORER_URL: 'https://explorer.ferminux.net', VITE_PAYIN_POLL_MS: '1000' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
  ok('built the production bundle (shipped pay-in URL and network endpoints, local chain 3961)');

  const browser = await pw.chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
    const sent = [];
    await context.exposeFunction('__walletSent', (chainId, tx, hash) => {
      const quoteId = attribute(chainId, tx, hash);
      sent.push({ chainId, tx, hash, quoteId });
      return quoteId;
    });
    await context.addInitScript(
      ([rpcUrl, account]) => {
        const listeners = {};
        const emit = (ev, v) => (listeners[ev] ?? []).forEach((fn) => fn(v));
        const w = { chainId: 3961, known: new Set([3961, 1, 56, 137, 10, 43114]), added: [], switches: [], n: 0 };
        window.__wallet = w;
        const err = (code, message) => Object.assign(new Error(message), { code });
        window.ethereum = {
          isFerminuxTestShim: true,
          async request({ method, params }) {
            switch (method) {
              case 'eth_requestAccounts':
              case 'eth_accounts':
                return [account];
              case 'eth_chainId':
                return '0x' + w.chainId.toString(16);
              case 'net_version':
                return String(w.chainId);
              case 'wallet_switchEthereumChain': {
                const id = parseInt(params[0].chainId, 16);
                w.switches.push(id);
                if (!w.known.has(id)) throw err(4902, 'Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.');
                if (w.chainId !== id) {
                  w.chainId = id;
                  setTimeout(() => emit('chainChanged', '0x' + id.toString(16)), 0);
                }
                return null;
              }
              case 'wallet_addEthereumChain': {
                const p = params[0];
                w.added.push(p);
                const id = parseInt(p.chainId, 16);
                w.known.add(id);
                w.chainId = id;
                setTimeout(() => emit('chainChanged', p.chainId), 0);
                return null;
              }
              case 'eth_sendTransaction': {
                const hash = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
                await window.__walletSent(w.chainId, params[0], hash);
                return hash;
              }
              default: {
                if (w.chainId !== 3961) throw err(-32601, `test wallet: ${method} off Ferminux`);
                const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++w.n, method, params: params ?? [] }) });
                const json = await res.json();
                if (json.error) throw err(json.error.code, json.error.message);
                return json.result;
              }
            }
          },
          on(ev, fn) {
            (listeners[ev] ??= []).push(fn);
          },
          removeListener(ev, fn) {
            listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
          },
        };
      },
      [`${url}rpc`, ME],
    );

    // Everything off 127.0.0.1 is answered here or refused: nothing leaves this machine.
    let page = null;
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
      const u = new URL(route.request().url());
      if (u.host === 'ferminux.net' && u.pathname.startsWith('/api/payin/')) {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'content-type': 'application/json' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        let result;
        if (u.pathname === '/api/payin/assets') result = [200, payin.assets];
        else if (u.pathname === '/api/payin/quote' && route.request().method() === 'POST') {
          const body = JSON.parse(route.request().postData() ?? '{}');
          payin.requests.push(body);
          result = quote(body);
        } else result = status(u.pathname.slice('/api/payin/'.length));
        return route.fulfill({ status: result[0], headers: cors, body: JSON.stringify(result[1]) });
      }
      const chainId = HOST_CHAIN[u.host];
      if (chainId && route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() ?? '{}');
        // "Drift": while the page reads the balance for its pre-send check, the wallet moves to
        // chain 1 without telling the page. The send that follows must notice and refuse.
        if (payin.driftOn === chainId && [body].flat().some((b) => b.method === 'eth_getBalance')) {
          payin.driftOn = null;
          await page.evaluate(() => {
            window.__wallet.chainId = 1;
          });
        }
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(payRpc(chainId, body)) });
      }
      if (chainId) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
      return route.abort();
    });

    page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/i.test(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = (name) => page.screenshot({ path: join(work, `${name}.png`), fullPage: true });
    const text = (sel) => page.textContent(sel);
    const noScroll = async (label) => {
      const bad = [];
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: w >= 900 ? 950 : 844 });
        await page.waitForTimeout(150);
        const over = await page.evaluate(() => {
          const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const modal = document.querySelector('.modal');
          const inner = modal ? modal.scrollWidth - modal.clientWidth : 0;
          return Math.max(doc, inner);
        });
        if (over > 1) bad.push(`${w}px: ${over}px`);
        await page.screenshot({ path: join(work, `w${w}-${label}.png`), fullPage: !(await page.$('.modal')) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.deepEqual(bad, [], `${label}: horizontal scroll at ${bad.join(', ')}`);
    };

    // ---- connect, open the picker -----------------------------------------------
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=swap-card]');
    await page.click('[data-testid=header-connect]');
    await page.click('[data-testid=choice-injected]');
    await page.waitForSelector('[data-testid=acct-trigger]', { timeout: 20000 });
    await page.click('[data-testid=field-in] .token-btn');
    await page.waitForSelector('[data-testid=pay-networks]');
    await page.waitForFunction(() => /250/.test(document.querySelector('[data-pay="bsc:USDT"]')?.textContent ?? ''), null, { timeout: 15000 });
    const nets = await page.locator('.pay-net').evaluateAll((els) => els.map((e) => e.getAttribute('data-network')));
    assert.deepEqual(nets, ['bsc', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche', 'eth']);
    assert.equal(await page.locator('[data-pay]').count(), 21, 'USDT, USDC and the native coin on seven networks');
    assert.match(await text('[data-network=bsc] .pay-net-head'), /BSC.*BNB Smart Chain.*12 conf/s);
    assert.match(await text('[data-pay="base:USDC"]'), /USDC.*100/s);
    assert.ok(await page.locator('[data-pay="polygon:USDT"]').isDisabled(), 'a paused network cannot be picked');
    assert.match(await text('[data-network=polygon]'), /paused.*deposit scanner/s);
    assert.match(await text('.modal'), /On Ferminux.*FMX.*Other networks/s, 'Ferminux tokens first, then the other networks');
    assert.match(await text('[data-testid=jump-networks]'), /USDT, USDC & more on 7 networks/);
    await page.fill('[data-testid=token-search]', 'usdt');
    assert.equal(await page.locator('[data-pay]').count(), 7, 'search narrows to USDT on each network');
    await page.fill('[data-testid=token-search]', '');
    await noScroll('picker');
    await shot('01-picker');
    ok('picker: "Other networks" lists USDT / USDC / native on 7 networks with the wallet’s balances; Polygon paused and not pickable; search filters');

    // ---- USDT on BNB Smart Chain (18 decimals) ------------------------------------
    await page.click('[data-pay="bsc:USDT"]');
    await page.waitForSelector('[data-testid=pay-card]');
    assert.match(await text('[data-testid=pay-mode]'), /Buy FMX with USDT on BNB Smart Chain/);
    assert.match(await text('[data-testid=pay-out]'), /FMX/);
    assert.match(await text('[data-testid=pay-card]'), /selling FMX into USDT on BNB Smart Chain is not offered yet/);
    assert.match(await text('[data-testid=pay-rate]'), /1 FMX = \$0\.5306/);
    assert.match(await text('[data-testid=pay-limits]'), /\$1 to \$10,000/);
    assert.match(await text('[data-testid=pay-facts]'), /12 on BSC/);
    assert.match(await text('[data-testid=pay-recipient]'), /0x7099…79C8.*this wallet/s);
    await page.waitForFunction(() => /250/.test(document.querySelector('[data-testid=pay-balance]')?.textContent ?? ''));

    await page.fill('[data-testid=pay-in] input', '0.5');
    assert.match(await text('[data-testid=pay-in]'), /at least \$1/);
    assert.ok(await page.locator('[data-testid=pay-action]').isDisabled());
    await page.fill('[data-testid=pay-in] input', '20000');
    assert.match(await text('[data-testid=pay-in]'), /at most \$10,000/);
    await page.fill('[data-testid=pay-in] input', '300');
    assert.match(await text('[data-testid=pay-action]'), /Not enough USDT on BSC/);
    assert.ok(await page.locator('[data-testid=pay-action]').isDisabled());
    await page.fill('[data-testid=pay-in] input', '10');
    assert.match(await text('[data-testid=pay-out] output'), /18\.846153/);
    assert.match(await text('[data-testid=pay-action]'), /Get quote/);
    await noScroll('pay-form');
    await shot('02-pay-form');
    ok('pay mode: FMX locked on the output, one-line "not offered yet", rate $0.5306 with the 2%, $1–$10,000, 12 confirmations; bounds and balance refused before any quote');

    await page.click('[data-testid=pay-action]');
    await page.waitForSelector('[data-testid=pay-review]');
    assert.deepEqual(payin.requests.at(-1), { chain: 'bsc', asset: 'USDT', amount: '10.0', to: ME, from: ME });
    assert.match(await text('[data-testid=pay-exact]'), /9\.999999999999999997\s*USDT/, 'the exact 18-decimal amount, dust included');
    assert.match(await text('[data-testid=pay-review-deposit]'), new RegExp(DEPOSIT));
    assert.match(await text('[data-testid=pay-review-network]'), /BNB Smart Chain · chain 56/);
    assert.match(await text('[data-testid=pay-review-to]'), new RegExp(ME));
    assert.match(await text('[data-testid=pay-review-clock]'), /1[45]:\d\d/);
    assert.match(await text('.modal'), /Do not send from an exchange/);
    assert.match(await text('.modal'), /3 units less than you typed/);
    await noScroll('review');
    await shot('03-review');
    ok('review: exactly 9.999999999999999997 USDT (18 decimals, 3 units of dust), deposit address, BNB Smart Chain · 56, recipient, 15-minute clock, exchange warning');

    await page.click('[data-testid=pay-send]');
    await page.waitForSelector('[data-testid=pay-review]', { state: 'detached', timeout: 20000 });
    assert.equal(sent.length, 1, 'one transaction');
    const t1 = sent[0];
    assert.equal(t1.chainId, 56, 'sent on BNB Smart Chain');
    assert.equal(t1.tx.to.toLowerCase(), tokenAddr('bsc', 'USDT'), 'to the pinned USDT contract');
    assert.equal(t1.tx.from.toLowerCase(), ME.toLowerCase());
    assert.equal(BigInt(t1.tx.value), 0n);
    const [dest1, amt1] = ERC20.decodeFunctionData('transfer', t1.tx.data);
    assert.equal(dest1, DEPOSIT);
    assert.equal(amt1, 10n * E18 - 3n, 'exactly sendExactly');
    assert.ok(!('gas' in t1.tx) && !('chainId' in t1.tx), 'no gas or chain fields: the wallet prices it on that network');
    assert.ok(t1.quoteId, 'the mock pay-in attributed it by exact amount and sender');
    ok('sent: switched the wallet to 56, then transfer(deposit, 9999999999999999997) to BSC USDT from the quoting account, attributed by amount');

    await page.waitForFunction(() => document.querySelector('[data-testid=pay-tracker]')?.getAttribute('data-status') === 'seen', null, { timeout: 15000 });
    assert.match(await text('[data-testid=pay-tracker]'), /BSC tx 0x/);
    await shot('04-tracker-seen');
    await page.waitForFunction(() => document.querySelector('[data-testid=pay-tracker]')?.getAttribute('data-status') === 'paid', null, { timeout: 20000 });
    const done = await text('[data-testid=pay-tracker]');
    assert.match(done, /FMX delivered/);
    assert.match(done, /18\.846153 FMX sent to 0x7099/);
    const fmxLink = await page.getAttribute('[data-testid=pay-tracker] a[href^="https://explorer.ferminux.net/tx/0x"]', 'href');
    assert.match(fmxLink, /^https:\/\/explorer\.ferminux\.net\/tx\/0x[0-9a-f]{64}$/);
    const bscLink = await page.getAttribute('[data-testid=pay-tracker] a[href^="https://bscscan.com/tx/"]', 'href');
    assert.equal(bscLink, `https://bscscan.com/tx/${t1.hash}`);
    assert.match(await text('.banner'), /BNB Smart Chain \(56\), not Ferminux/);
    await noScroll('tracker-paid');
    await shot('05-tracker-paid');
    await page.click('[data-testid=pay-switch-back]');
    await page.waitForFunction(() => window.__wallet.chainId === 3961);
    await page.waitForFunction(() => !document.querySelector('[data-testid=pay-switch-back]'));
    ok('tracker: seen → confirmed → paid, BscScan and explorer.ferminux.net links; "Switch back to Ferminux" put the wallet home');

    // ---- USDC on Base (6 decimals, network unknown to the wallet), across a reload ----
    await page.click('[data-testid=pay-buy-more]');
    await page.click('[data-testid=pay-token]');
    await page.click('[data-pay="base:USDC"]');
    await page.fill('[data-testid=pay-in] input', '25');
    await page.click('[data-testid=pay-action]');
    await page.waitForSelector('[data-testid=pay-review]');
    assert.match(await text('[data-testid=pay-exact]'), /24\.999997\s*USDC/);
    await page.click('.modal-foot .btn:not(.btn-primary)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=pay-tracker][data-status=quoted]', { timeout: 15000 });
    assert.match(await text('[data-testid=pay-status]'), /Waiting for your payment/);
    assert.match(await text('[data-testid=pay-purchases]'), /FMX delivered/, 'the finished purchase is listed too');
    await page.waitForSelector('[data-testid=acct-trigger]', { timeout: 20000 });
    await page.click('[data-testid=pay-open-review]');
    await page.click('[data-testid=pay-send]');
    await page.waitForSelector('[data-testid=pay-review]', { state: 'detached', timeout: 20000 });
    await page.waitForSelector('[data-testid=pay-tracker] a[href^="https://basescan.org/tx/"]', { timeout: 20000 });
    const t2 = sent.at(-1);
    assert.equal(sent.length, 2);
    assert.equal(t2.chainId, 8453);
    assert.equal(t2.tx.to.toLowerCase(), tokenAddr('base', 'USDC'));
    assert.equal(ERC20.decodeFunctionData('transfer', t2.tx.data)[1], 24_999_997n, '6 decimals: 25 USDC less 3 units');
    const addBase = await page.evaluate(() => window.__wallet.added.find((p) => p.chainId === '0x2105'));
    assert.equal(addBase?.chainName, 'Base');
    assert.deepEqual(addBase?.rpcUrls, ['https://mainnet.base.org']);
    assert.ok(t2.quoteId);
    ok('reload kept the open Base quote; the wallet did not know Base, so it was added (chain 8453, mainnet.base.org), then exactly 24.999997 USDC was sent');

    // ---- native AVAX ---------------------------------------------------------------
    await page.waitForFunction(() => document.querySelector('[data-testid=pay-tracker]')?.getAttribute('data-status') === 'paid', null, { timeout: 20000 });
    await page.click('[data-testid=pay-buy-more]');
    await page.click('[data-testid=pay-token]');
    await page.click('[data-pay="avalanche:AVAX"]');
    await page.fill('[data-testid=pay-in] input', '0.5');
    assert.match(await text('[data-testid=pay-in]'), /AVAX is priced when you get the quote/);
    await page.click('[data-testid=pay-action]');
    await page.waitForSelector('[data-testid=pay-review]');
    assert.match(await text('.modal'), /smart-contract wallet is not detected/);
    await page.click('[data-testid=pay-send]');
    await page.waitForSelector('[data-testid=pay-review]', { state: 'detached', timeout: 20000 });
    const t3 = sent.at(-1);
    assert.equal(t3.chainId, 43114);
    assert.deepEqual(Object.keys(t3.tx).sort(), ['from', 'to', 'value']);
    assert.equal(t3.tx.to, DEPOSIT);
    assert.equal(BigInt(t3.tx.value), 5n * 10n ** 17n - 3n, 'exactly sendExactly in wei, straight to the deposit address');
    assert.ok(t3.quoteId);
    ok('native: 0.499999999999999997 AVAX as value straight to the deposit address on 43114, no data');

    // ---- guards -----------------------------------------------------------------
    await page.waitForFunction(() => document.querySelector('[data-testid=pay-tracker]')?.getAttribute('data-status') === 'paid', null, { timeout: 20000 });
    await page.click('[data-testid=pay-buy-more]');
    await page.click('[data-testid=pay-token]');
    await page.click('[data-pay="bsc:USDT"]');
    await page.fill('[data-testid=pay-in] input', '5');
    payin.expiresNext = 60; // the shortest lifetime a quote may carry: under a minute left by the time it is on screen
    await page.click('[data-testid=pay-action]');
    await page.waitForSelector('[data-testid=pay-review]');
    assert.match(await text('.modal'), /Less than a minute is left on this quote/);
    assert.equal(await page.locator('[data-testid=pay-send]').count(), 0, 'no send button');
    await shot('06-short-quote');
    const before = sent.length;
    const short = payin.requests.length;
    await page.click('.modal [data-testid=pay-requote]');
    await page.waitForFunction(() => /1[45]:\d\d/.test(document.querySelector('[data-testid=pay-review-clock]')?.textContent ?? ''), null, { timeout: 15000 });
    assert.equal(sent.length, before, 'nothing sent on the short quote');
    const [shortQ, newQ] = [...payin.quotes.values()].slice(-2);
    assert.equal(shortQ.status, 'superseded');
    assert.notEqual(newQ.q.sendExactly, shortQ.q.sendExactly, 'the new quote cannot share an amount with the replaced one, or its payment would be credited to that one');
    assert.equal(payin.requests[short].amount, '4.999999999999999996', 'asked one unit under the replaced quote’s amount');
    assert.match(await text('.modal'), /4 units less than you typed/);
    ok('a quote with under a minute left cannot be sent; "Get a new quote" replaced it, one unit under the old amount so the payment can only match the new one');

    payin.driftOn = 56;
    await page.click('[data-testid=pay-send]');
    await page.waitForFunction(() => /chain 1, not BNB Smart Chain/.test(document.querySelector('.modal')?.textContent ?? ''), null, { timeout: 20000 });
    assert.equal(sent.length, before, 'nothing sent while the wallet was on another chain');
    await shot('07-drift-refused');
    ok('a wallet that reported BNB Smart Chain and then moved to chain 1 before the send was refused: nothing signed');

    // The network's deposit scanner falls behind after the quote was issued: the pay-in is asked
    // again right before the wallet is, and the payment waits.
    const live = payin.assets;
    payin.assets = JSON.parse(JSON.stringify(live));
    Object.assign(payin.assets.chains.find((c) => c.chain === 'bsc'), { available: false, unavailableReason: 'deposit scanner failed its last 3 scans — pay on another chain' });
    await page.click('[data-testid=pay-send]');
    await page.waitForFunction(() => /BNB Smart Chain is not taking payments right now/.test(document.querySelector('.modal')?.textContent ?? ''), null, { timeout: 20000 });
    assert.equal(sent.length, before, 'nothing sent while the network was paused');
    payin.assets = live;
    ok('a network paused after the quote was issued: the pre-send check with the pay-in refused, nothing signed');

    await page.click('[data-testid=pay-send]');
    await page.waitForSelector('[data-testid=pay-review]', { state: 'detached', timeout: 20000 });
    assert.equal(sent.length, before + 1);
    assert.equal(ERC20.decodeFunctionData('transfer', sent.at(-1).tx.data)[1], 5n * E18 - 4n);
    assert.equal(sent.at(-1).quoteId, newQ.q.quoteId, 'credited to the new quote, not the replaced one');
    await page.waitForFunction(() => document.querySelector('[data-testid=pay-tracker]')?.getAttribute('data-status') === 'paid', null, { timeout: 20000 });
    await page.click('[data-testid=pay-buy-more]');
    await page.click('[data-testid=pay-token]');
    await page.click('[data-pay="bsc:USDC"]');
    await page.fill('[data-testid=pay-in] input', '5');
    assert.match(await text('[data-testid=pay-action]'), /Not enough USDC on BSC/);
    ok('after the drift, a retry sent exactly 4.999999999999999996 USDT, credited to the new quote; USDC with a zero balance is refused before quoting');

    // ---- back to the pool swap ------------------------------------------------------
    await page.click('[data-testid=pay-exit]');
    await page.waitForSelector('[data-testid=swap-card] [data-testid=field-in]');
    assert.match(await text('[data-testid=field-in] .token-btn'), /FMX/);
    assert.match(await text('[data-testid=pay-purchases]'), /Your FMX purchases/);
    await noScroll('swap-with-purchases');
    assert.equal(payin.unattributed.length, 0, 'every payment matched its quote');
    assert.equal(sent.length, 4);
    assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
    ok(`back to the pool swap card unchanged; 4 payments, all matched; no horizontal scroll at ${WIDTHS.join('/')} px; no console errors`);
    console.log(`  screenshots: ${work}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
