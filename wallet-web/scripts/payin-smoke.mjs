#!/usr/bin/env node
// Browser smoke of Swap → You pay → Other networks (buy FMX through the pay-in),
// at phone (390×844, touch) and desktop (1440×900) sizes, with EVERYTHING the
// page talks to mocked on one local origin — nothing reaches a real network:
//
//   /rpc/<chainId>     a JSON-RPC mock per chain (Ferminux 3961 and the seven
//                      pay-in networks): balances through Multicall3 / batches,
//                      fees, estimates, nonces, eth_sendRawTransaction (every
//                      raw transaction is kept and decoded), receipts
//   /api/payin/*       a pay-in mock with the gateway's own rules and
//                      arithmetic: the asset list (recorded, Polygon switched
//                      off), quotes (exact unique amounts stepped DOWN by dust,
//                      USD limits, 2% spread at $0.52, superseding the same
//                      payer's open quote), status that moves quoted → seen
//                      when the RPC mock receives the exact payment from the
//                      quote's sender, then → confirmed → paid on the test's cue
//   /explorer/*        the Ferminux explorer, answering 404
//
// Checked, at both sizes: the picker's Other networks section (seven networks,
// USDT/USDC/native each, balances read on each network, an unavailable
// network's rows disabled), the buy form (FMX locked on the output side with
// its one-line note, rate incl. the spread, USD limits, confirmations,
// recipient), the guards (under $1, more than the balance, no gas on the
// network, a quote with under a minute left → re-quote, a recipient change
// only behind a warning and an acknowledgement), the review screen (exact
// amount, deposit address, token contract, recipient, expiry, fee), and that
// the ONE transaction signed pays exactly `sendExactly` to the deposit address
// (BNB Smart Chain USDT: transfer() at 18 decimals; Base ETH: the native value)
// on the right chain id from the wallet's address; then the tracker through
// seen → confirmed → paid with explorer links, surviving a reload (phone), and
// the Ferminux DEX swap form still quoting FMX → USDF from its pool. No
// horizontal scroll at 320–430 px; no uncaught page errors.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/payin-smoke.mjs
//
// Skips cleanly (exit 0) without Playwright. Screenshots go to SMOKE_OUT
// (default: a temp dir, printed at the end).

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Interface, Transaction, Wallet, getAddress, keccak256, parseUnits, formatUnits, AbiCoder } from 'ethers';
import { DEX } from '../src/lib/swap.ts';
import { FOREIGN_CHAINS, MULTICALL3_ADDRESS } from '../src/lib/chains.ts';
import { payinCoin } from '../src/lib/payin.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.SMOKE_PORT ?? 28611);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'violet harbour 3961 lantern';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

// A public, well-known development key (anvil account #1): never holds anything real.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ME = new Wallet(KEY).address;
const OTHER = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const ASSETS = JSON.parse(readFileSync(new URL('../tests/fixtures/payin-assets.json', import.meta.url), 'utf8'));
const DEPOSIT = getAddress(ASSETS.chains[0].depositAddress);
const USDF = getAddress('0xCd032A609e34121D1881E8DE7355b2c2c7092363');
const POOL = getAddress('0x5555555555555555555555555555555555555555');
const E18 = 10n ** 18n;
const NATIVE_USD = { ETH: '2500', BNB: '600', POL: '0.5', AVAX: '30' };

let n = 0;
const ok = (m) => console.log(`  ✓ ${String(++n).padStart(2)}. ${m}`);
const info = (m) => console.log(`       · ${m}`);
const skip = (why) => {
  console.log(`payin-smoke SKIPPED: ${why}`);
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

/* ------------------------------------------------------------------ */
/* Chain mocks                                                         */
/* ------------------------------------------------------------------ */

const hex = (v) => '0x' + BigInt(v).toString(16);
const word = (v) => AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
const erc20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 value) returns (bool)']);
const multicall = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const factory = new Interface(['function getPair(address, address) view returns (address)']);
const pairIface = new Interface(['function getReserves() view returns (uint112, uint112, uint32)']);
const oracle = new Interface(['function getL1FeeUpperBound(uint256) view returns (uint256)']);
const OP_ORACLE = '0x420000000000000000000000000000000000000f';

const tokenOf = (chainKey, sym) => payinCoin(chainKey, sym).address.toLowerCase();

/** Balances the mock reports for ANY holder (there is one wallet under test). */
const state = {
  chains: {
    3961: { native: parseUnits('10', 18), tokens: {} },
    1: { native: parseUnits('0.02', 18), tokens: {} },
    56: { native: parseUnits('0.5', 18), tokens: { [tokenOf('bsc', 'USDT')]: parseUnits('120', 18) } },
    8453: { native: parseUnits('0.2', 18), tokens: { [tokenOf('base', 'USDC')]: parseUnits('50', 6) } },
    42161: { native: 0n, tokens: {} },
    137: { native: 0n, tokens: { [tokenOf('polygon', 'USDT')]: parseUnits('5', 6) } },
    10: { native: 0n, tokens: {} },
    43114: { native: 0n, tokens: { [tokenOf('avalanche', 'USDT')]: parseUnits('30', 6) } },
  },
  nonce: {},
  /** every raw transaction received: { chainId, raw, tx, hash } */
  sent: [],
  receipts: new Map(),
  started: Date.now(),
};

function block(chainId) {
  const number = 1_000_000 + Math.floor((Date.now() - state.started) / 1000);
  return {
    number: hex(number),
    hash: keccak256('0x' + number.toString(16).padStart(8, '0') + chainId.toString(16).padStart(8, '0')),
    parentHash: '0x' + '11'.repeat(32),
    timestamp: hex(Math.floor(Date.now() / 1000)),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: hex(30_000_000),
    gasUsed: '0x0',
    miner: '0x' + '00'.repeat(20),
    extraData: '0x',
    baseFeePerGas: hex(chainId === 3961 ? 7 : 1_000_000_000),
    transactions: [],
    stateRoot: '0x' + '22'.repeat(32),
    receiptsRoot: '0x' + '33'.repeat(32),
    transactionsRoot: '0x' + '44'.repeat(32),
    sha3Uncles: '0x' + '55'.repeat(32),
    logsBloom: '0x' + '00'.repeat(256),
    mixHash: '0x' + '66'.repeat(32),
    size: '0x100',
    uncles: [],
  };
}

function ethCall(chainId, { to, data }) {
  const c = state.chains[chainId];
  const target = (to ?? '').toLowerCase();
  const sel = (data ?? '0x').slice(0, 10).toLowerCase();
  if (target === MULTICALL3_ADDRESS.toLowerCase() && sel === multicall.getFunction('aggregate3').selector) {
    const [calls] = multicall.decodeFunctionData('aggregate3', data);
    const out = calls.map((call) => {
      const cs = call.callData.slice(0, 10).toLowerCase();
      if (call.target.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() && cs === multicall.getFunction('getEthBalance').selector) return [true, word(c.native)];
      if (cs === erc20.getFunction('balanceOf').selector) return [true, word(c.tokens[call.target.toLowerCase()] ?? 0n)];
      return [false, '0x'];
    });
    return multicall.encodeFunctionResult('aggregate3', [out]);
  }
  if (sel === erc20.getFunction('balanceOf').selector) return word(c.tokens[target] ?? 0n);
  if (chainId === 3961 && target === DEX.factory.toLowerCase() && sel === factory.getFunction('getPair').selector) {
    const [a, b] = factory.decodeFunctionData('getPair', data).map((x) => x.toLowerCase());
    const pair = [a, b].sort().join() === [DEX.wfmx.toLowerCase(), USDF.toLowerCase()].sort().join();
    return AbiCoder.defaultAbiCoder().encode(['address'], [pair ? POOL : '0x' + '00'.repeat(20)]);
  }
  if (chainId === 3961 && target === POOL.toLowerCase() && sel === pairIface.getFunction('getReserves').selector) {
    // token0 = WFMX (lower address): 480,769.23 FMX against 250,000 USDF = $0.52
    return pairIface.encodeFunctionResult('getReserves', [parseUnits('480769.23', 18), parseUnits('250000', 6), Math.floor(Date.now() / 1000)]);
  }
  if (target === OP_ORACLE && sel === oracle.getFunction('getL1FeeUpperBound').selector) return word(3_000_000_000_000n);
  return word(0n);
}

function receiptFor(chainId, hash) {
  const s = state.sent.find((x) => x.hash === hash && x.chainId === chainId);
  if (!s) return null;
  const b = block(chainId);
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: b.hash,
    blockNumber: hex(BigInt(b.number) - 1n),
    from: s.tx.from,
    to: s.tx.to,
    cumulativeGasUsed: hex(52_000),
    gasUsed: hex(52_000),
    effectiveGasPrice: hex(1_000_000_000),
    contractAddress: null,
    logs: [],
    logsBloom: '0x' + '00'.repeat(256),
    type: '0x2',
    status: '0x1',
  };
}

function rpc(chainId, req) {
  const c = state.chains[chainId];
  const p = req.params ?? [];
  switch (req.method) {
    case 'eth_chainId':
      return hex(chainId);
    case 'net_version':
      return String(chainId);
    case 'eth_blockNumber':
      return block(chainId).number;
    case 'eth_getBlockByNumber':
      return block(chainId);
    case 'eth_getBalance':
      return hex(c.native);
    case 'eth_call':
      return ethCall(chainId, p[0]);
    case 'eth_getCode':
      return '0x';
    case 'eth_estimateGas': {
      const t = p[0] ?? {};
      if (t.data && t.data !== '0x') {
        const sel = t.data.slice(0, 10).toLowerCase();
        if (sel === erc20.getFunction('transfer').selector) {
          const [, amount] = erc20.decodeFunctionData('transfer', t.data);
          if ((c.tokens[(t.to ?? '').toLowerCase()] ?? 0n) < amount) throw Object.assign(new Error('execution reverted: transfer amount exceeds balance'), { code: 3 });
        }
        return hex(52_000);
      }
      if (BigInt(t.value ?? 0) > c.native) throw Object.assign(new Error('insufficient funds for transfer'), { code: -32000 });
      return hex(21_000);
    }
    case 'eth_getTransactionCount':
      return hex(state.nonce[chainId] ?? 0);
    case 'eth_maxPriorityFeePerGas':
      return hex(chainId === 3961 ? 1_000_000_000 : 100_000_000);
    case 'eth_gasPrice':
      return hex(1_100_000_000);
    case 'eth_feeHistory':
      return { oldestBlock: block(chainId).number, baseFeePerGas: [hex(1e9), hex(1e9)], gasUsedRatio: [0.5], reward: [[hex(1e8)]] };
    case 'eth_sendRawTransaction': {
      const raw = p[0];
      const tx = Transaction.from(raw);
      const hash = keccak256(raw);
      state.sent.push({ chainId, raw, tx, hash });
      state.nonce[chainId] = (state.nonce[chainId] ?? 0) + 1;
      if (tx.data && tx.data !== '0x') {
        const [to, amount] = erc20.decodeFunctionData('transfer', tx.data);
        const k = tx.to.toLowerCase();
        c.tokens[k] = (c.tokens[k] ?? 0n) - amount;
        payin.onDeposit(chainId, k, to, amount, tx.from, hash);
      } else {
        c.native -= tx.value;
        payin.onDeposit(chainId, null, tx.to, tx.value, tx.from, hash);
      }
      return hash;
    }
    case 'eth_getTransactionReceipt':
      return receiptFor(chainId, p[0]);
    case 'eth_getTransactionByHash': {
      const s = state.sent.find((x) => x.hash === p[0] && x.chainId === chainId);
      if (!s) return null;
      return { hash: s.hash, from: s.tx.from, to: s.tx.to, value: hex(s.tx.value), input: s.tx.data, nonce: hex(s.tx.nonce), gas: hex(s.tx.gasLimit), chainId: hex(chainId), type: '0x2', maxFeePerGas: hex(s.tx.maxFeePerGas), maxPriorityFeePerGas: hex(s.tx.maxPriorityFeePerGas), blockHash: null, blockNumber: null, transactionIndex: null, v: '0x0', r: '0x' + '1'.repeat(64), s: '0x' + '1'.repeat(64), accessList: [] };
    }
    default:
      throw Object.assign(new Error(`method ${req.method} not mocked`), { code: -32601 });
  }
}

function answer(chainId, req) {
  try {
    return { jsonrpc: '2.0', id: req.id, result: rpc(chainId, req) };
  } catch (e) {
    return { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32000, message: e.message } };
  }
}

/* ------------------------------------------------------------------ */
/* Pay-in mock: the gateway's rules (agents/gateway/src/v3/payin.ts)    */
/* ------------------------------------------------------------------ */

const gwFormat = (units, decimals) => {
  const d = 10n ** BigInt(decimals);
  const frac = (units % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${units / d}.${frac || '0'}`;
};

const payin = {
  quotes: new Map(),
  bodies: [],
  /** Seconds a new quote lives (the gateway's 900; the test shortens one to hit the under-a-minute guard). */
  nextTtl: 900,
  /** Units of dust the next quote on a (chain, asset) is stepped down by, as if other open quotes held those amounts. */
  collisions: { 'bsc:USDT': 3n, 'base:ETH': 2n },
  seq: 0,
  assets() {
    const a = JSON.parse(JSON.stringify(ASSETS));
    const poly = a.chains.find((c) => c.chain === 'polygon');
    poly.available = false;
    poly.unavailableReason = 'deposit scanner failed its last 3 scans — pay on another chain';
    a.availableChains = a.availableChains.filter((c) => c !== 'polygon');
    return a;
  },
  quote(body) {
    this.bodies.push(body);
    const chain = ASSETS.chains.find((c) => c.chain === body.chain);
    if (!chain) return [400, { error: 'chain must be one of eth|bsc|…' }];
    if (body.chain === 'polygon') return [503, { error: 'pay-in on Polygon is temporarily unavailable (deposit scanner failed its last 3 scans); pay on eth, bsc, base', unavailable: true }];
    const coin = payinCoin(body.chain, body.asset);
    if (!coin) return [400, { error: `asset must be one of USDC|USDT|… on ${chain.name}` }];
    const wanted = parseUnits(String(body.amount), coin.decimals);
    const assetUsdE18 = coin.stable ? E18 : parseUnits(NATIVE_USD[coin.symbol], 18);
    const usdCheck = (wanted * assetUsdE18) / 10n ** BigInt(coin.decimals);
    if (usdCheck < E18 || usdCheck > 10_000n * E18) return [400, { error: `amount must be worth between 1 and 10000 USD (this is ≈ ${formatUnits(usdCheck, 18)} USD)` }];
    const to = getAddress(body.to);
    const from = body.from ? getAddress(body.from) : null;
    const now = Math.floor(Date.now() / 1000);
    // a new quote supersedes the same payer's open quotes on this (chain, asset)
    for (const q of this.quotes.values()) if (q.status === 'quoted' && q.chain === body.chain && q.asset === body.asset && q.from === from) q.status = 'superseded';
    const units = wanted - (this.collisions[`${body.chain}:${body.asset}`] ?? 0n);
    const usdE18 = (units * assetUsdE18) / 10n ** BigInt(coin.decimals);
    const priceE18 = parseUnits('0.52', 18);
    const fmxOut = (usdE18 * E18 * 9800n) / (10_000n * priceE18);
    const quoteId = `q_${(++this.seq).toString(16).padStart(16, 'a')}`;
    const text = gwFormat(units, coin.decimals);
    const q = {
      quoteId, chain: body.chain, chainId: coin.chain.id, chainName: coin.chain.name, asset: coin.symbol, assetKind: coin.kind, token: coin.address, decimals: coin.decimals,
      amount: text, amountRequested: gwFormat(wanted, coin.decimals), dustUnits: String(wanted - units), dustDirection: wanted > units ? 'down' : 'none',
      sendExactly: units.toString(), sendExactlyFormatted: text, usd: gwFormat(usdE18, 18), assetUsd: gwFormat(assetUsdE18, 18),
      depositAddress: DEPOSIT, fmxOut: fmxOut.toString(), fmxOutFormatted: gwFormat(fmxOut, 18), priceUsdPerFmx: '0.52', spreadBps: 200, to, from,
      expiresAt: now + this.nextTtl, expires: 900, confirmations: chain.confirmations, status: 'quoted', explorer: chain.explorer, note: `Send exactly ${text} ${coin.symbol}`,
    };
    this.nextTtl = 900;
    this.quotes.set(quoteId, { ...q, txHashIn: null, txHashOut: null, seenConfirmations: 0 });
    return [201, q];
  },
  status(id) {
    const q = this.quotes.get(id);
    if (!q) return [404, { error: 'quote not found' }];
    return [
      200,
      {
        quoteId: q.quoteId, chain: q.chain, asset: q.asset, amount: q.amount, amountUnits: q.sendExactly, sendExactly: q.sendExactly, sendExactlyFormatted: q.sendExactlyFormatted,
        usd: q.usd, fmxOut: q.fmxOut, target: q.to, payer: q.from, depositAddress: q.depositAddress, status: q.status, txHashIn: q.txHashIn, confirmations: q.seenConfirmations,
        txHashOut: q.txHashOut, error: null, chainId: q.chainId, required: q.confirmations, enabled: true,
        txHashes: {
          deposit: q.txHashIn ? { chain: q.chain, chainId: q.chainId, hash: q.txHashIn, url: `${q.explorer}/tx/${q.txHashIn}` } : null,
          fmx: q.txHashOut ? { chain: 'ferminux', chainId: 3961, hash: q.txHashOut, url: `https://explorer.ferminux.net/tx/${q.txHashOut}` } : null,
        },
      },
    ];
  },
  /** The watcher: a transfer to the deposit address is attributed by exact amount, and only from the quote's payer. */
  onDeposit(chainId, tokenLower, to, amount, from, hash) {
    if (getAddress(to) !== DEPOSIT) return;
    for (const q of this.quotes.values()) {
      if (q.chainId !== chainId || !['quoted', 'superseded'].includes(q.status)) continue;
      if ((q.token ? q.token.toLowerCase() : null) !== tokenLower) continue;
      if (BigInt(q.sendExactly) !== amount || q.from !== getAddress(from)) continue;
      q.status = 'seen';
      q.txHashIn = hash;
      q.seenConfirmations = 1;
      return;
    }
  },
  advance(id, status, extra = {}) {
    const q = this.quotes.get(id);
    q.status = status;
    if (status === 'confirmed') q.seenConfirmations = q.confirmations;
    Object.assign(q, extra);
  },
};

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

async function body(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : null;
}

function serve(dist) {
  return createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      const m = /^\/rpc\/(\d+)$/.exec(path);
      if (m && req.method === 'POST') {
        const chainId = Number(m[1]);
        const b = await body(req);
        return json(200, Array.isArray(b) ? b.map((r) => answer(chainId, r)) : answer(chainId, b));
      }
      if (path === '/api/payin/assets') return json(200, payin.assets());
      if (path === '/api/payin/quote' && req.method === 'POST') return json(...payin.quote(await body(req)));
      const s = /^\/api\/payin\/(q_[A-Za-z0-9]+)$/.exec(path);
      if (s) return json(...payin.status(s[1]));
      if (path.startsWith('/explorer') || path.startsWith('/api/')) return json(404, { message: 'Not found' });
      const f = join(dist, path === '/' ? 'index.html' : path);
      const data = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (!res.headersSent) json(e?.code === 'ENOENT' ? 404 : 500, { error: String(e?.message ?? e) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

const txt = async (page, sel) => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
let current = null;

async function importWallet(page, tap, remember) {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await tap('[data-testid=import-wallet]');
  await tap('[data-testid=import-tab-key]');
  await page.fill('#imp-key', KEY);
  if (remember) {
    await page.check('.check-row input[type=checkbox] >> visible=true');
    await page.fill('#imp-key-pw', PASSWORD);
    await page.fill('#imp-key-pw2', PASSWORD);
  }
  await tap('[data-testid=import-key]');
  await page.waitForSelector('[data-testid=active-address]', { timeout: 120_000 });
  assert.equal(getAddress(await page.getAttribute('[data-testid=active-address]', 'data-address')), ME);
}

async function openSwap(page, tap) {
  await tap('[data-testid=swap-open]');
  await page.waitForSelector('[data-testid=swap-form]');
}

async function pickPayin(page, tap, chain, sym) {
  await tap('[data-testid=swap-token-in], [data-testid=payin-token-in]');
  await page.waitForSelector('[data-testid=swap-picker][data-side=in]');
  await page.waitForSelector('[data-testid=payin-section]');
  await tap(`[data-testid=swap-pick-payin-${chain}-${sym}]`);
  await page.waitForSelector(`[data-testid=payin-form][data-chain=${chain}][data-asset=${sym}]`);
}

async function noSideScroll(page, label) {
  for (const w of [320, 360, 390, 430]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(120);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `${label}: ${over}px of sideways scroll at ${w}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

/** The one transaction received since `before`, decoded. */
function onlyNewTx(before) {
  const fresh = state.sent.slice(before);
  assert.equal(fresh.length, 1, `exactly one transaction broadcast (got ${fresh.length})`);
  return fresh[0];
}

/* ------------------------------------------------------------------ */
/* The passes                                                          */
/* ------------------------------------------------------------------ */

async function phonePass(browser, shots) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  const shot = async (label) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, `phone-${label}.png`), fullPage: !(await page.$('.modal')) });
  };
  current = { page, shot };
  const tap = (sel) => page.tap(`${sel} >> visible=true`);

  await importWallet(page, tap, true);
  ok(`[phone] imported the test key ${ME}, remembered on this device`);

  await openSwap(page, tap);
  assert.equal(await page.getAttribute('[data-testid=swap-form]', 'data-in'), 'native');
  assert.match(await txt(page, '[data-testid=swap-scope]'), /Ferminux Network \(chain 3961\) only/);
  assert.match(await txt(page, '[data-testid=swap-scope]'), /You pay → Other networks/);
  // the DEX swap is untouched: FMX → USDF still quotes from the pool
  await page.fill('[data-testid=swap-amount]', '10');
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid=swap-out]')?.textContent ?? '') && !document.querySelector('[data-testid=swap-out]').classList.contains('is-empty'), null, { timeout: 30_000 });
  const out = Number((await txt(page, '[data-testid=swap-out]')).replace(/,/g, ''));
  assert.ok(out > 5.1 && out < 5.2, `10 FMX → ~5.18 USDF at $0.52 less the pool fee (got ${out})`);
  assert.equal((await txt(page, '[data-testid=swap-route]')).replace(/\s/g, ''), 'FMX→USDF');
  await page.fill('[data-testid=swap-amount]', '');
  ok(`[phone] Swap opens on the Ferminux DEX as before: 10 FMX → ${out} USDF through the WFMX/USDF pool`);

  /* --- the picker --- */
  await tap('[data-testid=swap-token-in]');
  await page.waitForSelector('[data-testid=payin-section]');
  const nets = await page.$$eval('[data-testid^=payin-net-]', (els) => els.map((e) => [e.getAttribute('data-testid').slice(10), e.getAttribute('data-available')]));
  assert.deepEqual(nets.map((x) => x[0]), ['bsc', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche', 'eth']);
  assert.deepEqual(nets.filter((x) => x[1] === 'false').map((x) => x[0]), ['polygon'], 'Polygon is off');
  assert.equal(await page.isDisabled('[data-testid=swap-pick-payin-polygon-USDT]'), true);
  assert.match(await txt(page, '[data-testid=payin-net-polygon]'), /Not taking payments: deposit scanner failed/);
  for (const sym of ['USDT', 'USDC', 'BNB']) assert.ok(await page.$(`[data-testid=swap-pick-payin-bsc-${sym}]`), `BSC ${sym}`);
  for (const sym of ['USDT', 'USDC', 'AVAX']) assert.ok(await page.$(`[data-testid=swap-pick-payin-avalanche-${sym}]`), `AVAX ${sym}`);
  await page.waitForFunction(() => /120/.test(document.querySelector('[data-testid=swap-pick-payin-bsc-USDT] .token-row-bal')?.textContent ?? ''), null, { timeout: 45_000 });
  assert.equal(await txt(page, '[data-testid=swap-pick-payin-base-USDC] .token-row-bal'), '50');
  assert.match(await txt(page, '[data-testid=payin-net-bsc]'), /BNB Smart Chain.*12 confirmations/);
  await shot('picker');
  await page.fill('[data-testid=swap-picker] input', 'avax');
  assert.equal(await page.$('[data-testid=swap-pick-payin-bsc-USDT]'), null, 'search narrows the networks');
  assert.ok(await page.$('[data-testid=swap-pick-payin-avalanche-AVAX]'));
  await page.fill('[data-testid=swap-picker] input', '');
  ok('[phone] You pay → Other networks: 7 networks × USDT/USDC/native with balances read there; Polygon (scanner down) disabled with its reason; search works');

  /* --- BSC USDT, 18 decimals --- */
  await tap('[data-testid=swap-pick-payin-bsc-USDT]');
  await page.waitForSelector('[data-testid=payin-form][data-chain=bsc][data-asset=USDT]');
  assert.match(await txt(page, '[data-testid=payin-title]'), /Buy FMX with USDT on BNB Smart Chain/);
  assert.match(await txt(page, '[data-testid=payin-token-out]'), /FMX/);
  assert.match(await txt(page, '[data-testid=payin-lock-note]'), /Selling FMX into these coins is not offered yet/);
  assert.match(await txt(page, '[data-testid=payin-price]'), /\$0\.52 per FMX · 2% spread included/);
  assert.match(await txt(page, '[data-testid=payin-limits]'), /\$1 – \$10,000 per purchase/);
  assert.match(await txt(page, '[data-testid=payin-confirmations]'), /12 on BNB Smart Chain/);
  assert.match(await txt(page, '[data-testid=payin-recipient-label]'), /This account/);
  assert.match(await txt(page, '[data-testid=payin-exchange-note]'), /Do not send from an exchange/);
  assert.match(await txt(page, '[data-testid=payin-rate]'), /1 USDT ≈ 1\.884615 FMX/);

  await page.fill('[data-testid=payin-amount]', '0.5');
  assert.match(await txt(page, '[data-testid=payin-bounds]'), /at least \$1/);
  assert.equal(await page.isDisabled('[data-testid=payin-quote]'), true);
  await page.fill('[data-testid=payin-amount]', '500');
  assert.match(await txt(page, '[data-testid=payin-quote]'), /Not enough USDT/);
  assert.equal(await page.isDisabled('[data-testid=payin-quote]'), true);
  await page.fill('[data-testid=payin-amount]', '25');
  assert.equal(await txt(page, '[data-testid=payin-out]'), '47.115384');
  assert.equal(await page.isDisabled('[data-testid=payin-quote]'), false);
  await shot('buy-form');
  ok('[phone] BSC USDT: FMX locked on the output with its note; $0.52 + 2% spread, $1–$10,000, 12 confirmations; under $1 and over the balance are refused; 25 USDT ≈ 47.115384 FMX');

  await tap('[data-testid=payin-quote]');
  await page.waitForSelector('[data-testid=payin-review]', { timeout: 30_000 });
  const qBody = payin.bodies.at(-1);
  assert.deepEqual(qBody, { chain: 'bsc', asset: 'USDT', amount: '25.0', to: ME, from: ME }, 'the quote asks for exactly what was typed, from this wallet, FMX to this account');
  const qid = await page.getAttribute('[data-testid=payin-review]', 'data-quote');
  const quote = payin.quotes.get(qid);
  assert.equal(await page.getAttribute('[data-testid=payin-review]', 'data-chain-id'), '56');
  assert.match(await txt(page, '[data-testid=chain-banner]'), /BNB Smart Chain.*chain 56/);
  assert.equal((await txt(page, '[data-testid=payin-send-exactly]')).replace(/\s/g, ''), '24.999999999999999997USDT');
  assert.match(await txt(page, '[data-testid=payin-dust]'), /A few units less than 25\.0 typed/);
  assert.equal(await txt(page, '[data-testid=payin-deposit]'), DEPOSIT);
  assert.equal(await txt(page, '[data-testid=payin-token]'), payinCoin('bsc', 'USDT').address);
  assert.equal(await txt(page, '[data-testid=payin-review-recipient]'), ME);
  assert.match(await txt(page, '[data-testid=payin-fmx-out]'), new RegExp(`^${formatUnits(BigInt(quote.fmxOut), 18).replace('.', '\\.')} FMX`));
  assert.equal((await txt(page, '[data-testid=payin-fmx-out-short]')).replace(/\s/g, ''), '47.115384FMX');
  assert.match(await txt(page, '[data-testid=payin-expiry]'), /1[45]:\d\d left/);
  assert.match(await txt(page, '[data-testid=payin-fee]'), /BNB$/);
  assert.match(await txt(page, '[data-testid=payin-review-exchange]'), /Do not send from an exchange/);
  assert.equal(await page.isDisabled('[data-testid=payin-sign]'), false);
  await shot('review');
  await noSideScroll(page, 'review');
  ok(`[phone] quote ${qid}: send exactly 24.999999999999999997 USDT (3 units of dust) to ${DEPOSIT} on chain 56, token contract, recipient, ${formatUnits(BigInt(quote.fmxOut), 18)} FMX, 15-minute countdown`);

  const before = state.sent.length;
  await tap('[data-testid=payin-sign]');
  await page.waitForSelector('[data-testid=payin-track]', { timeout: 30_000 });
  const sent = onlyNewTx(before);
  assert.equal(sent.chainId, 56, 'broadcast on BNB Smart Chain’s RPC');
  assert.equal(sent.tx.chainId, 56n, 'signed for chain 56');
  assert.equal(sent.tx.from, ME);
  assert.equal(sent.tx.to, payinCoin('bsc', 'USDT').address);
  assert.equal(sent.tx.value, 0n);
  const [payTo, payAmount] = erc20.decodeFunctionData('transfer', sent.tx.data);
  assert.equal(payTo, DEPOSIT);
  assert.equal(payAmount, BigInt(quote.sendExactly));
  assert.equal(payAmount, 24_999_999_999_999_999_997n);
  ok(`[phone] ONE transaction signed: chain 56, transfer(${DEPOSIT}, 24999999999999999997) on BSC USDT from ${ME}`);

  /* --- tracker, across a reload --- */
  await page.waitForSelector('[data-testid=payin-track][data-status=seen]', { timeout: 30_000 });
  assert.equal(await page.getAttribute('[data-testid=payin-step-1]', 'data-state'), 'done');
  assert.equal(await page.getAttribute('[data-testid=payin-local-tx]', 'href'), `https://bscscan.com/tx/${sent.hash}`);
  assert.match(await txt(page, '[data-testid=payin-track-title]'), /Payment seen/);
  await shot('track-seen');
  ok('[phone] tracker: sent (BscScan link) → seen by the pay-in');

  await page.reload({ waitUntil: 'load' });
  await page.fill('#unlock-pw', PASSWORD);
  await tap('[data-testid=unlock-submit]');
  // the reload keeps the #/swap route: unlocking lands straight back on Swap
  await page.waitForSelector('[data-testid=swap-form]', { timeout: 120_000 });
  assert.match(page.url(), /#\/swap$/);
  await page.waitForSelector(`[data-testid=payin-purchase-${qid}][data-status=seen]`);
  await tap(`[data-testid=payin-purchase-${qid}]`);
  await page.waitForSelector('[data-testid=payin-track][data-status=seen]');
  ok('[phone] after a reload and unlock: Swap → FMX purchases lists it, the tracker picks up at "seen"');

  payin.advance(qid, 'confirmed');
  await page.waitForSelector('[data-testid=payin-track][data-status=confirmed]', { timeout: 30_000 });
  const fmxHash = keccak256('0x' + Buffer.from(qid).toString('hex'));
  payin.advance(qid, 'paid', { txHashOut: fmxHash });
  await page.waitForSelector('[data-testid=payin-track][data-status=paid]', { timeout: 30_000 });
  assert.match(await txt(page, '[data-testid=payin-track-title]'), /FMX delivered/);
  assert.equal(await page.getAttribute('[data-testid=payin-fmx-tx]', 'href'), `${ORIGIN}/explorer/tx/${fmxHash}`);
  for (const i of [1, 2, 3, 4]) assert.equal(await page.getAttribute(`[data-testid=payin-step-${i}]`, 'data-state'), 'done', `step ${i}`);
  await shot('track-paid');
  await noSideScroll(page, 'tracker');
  ok('[phone] → confirmed → paid: FMX delivered, the Ferminux explorer link names the payout');

  /* --- guards --- */
  await tap('[data-testid=payin-buy-again]');
  await page.waitForSelector('[data-testid=payin-form][data-chain=bsc]');
  await pickPayin(page, tap, 'avalanche', 'USDT');
  await page.waitForSelector('[data-testid=payin-no-gas]', { timeout: 45_000 });
  await page.fill('[data-testid=payin-amount]', '10');
  await tap('[data-testid=payin-quote]');
  await page.waitForSelector('[data-testid=payin-form-error]');
  assert.match(await txt(page, '[data-testid=payin-form-error]'), /no AVAX on Avalanche C-Chain/);
  assert.equal(payin.bodies.length, 1, 'no quote was asked for');
  ok('[phone] Avalanche USDT with no AVAX for gas: refused before any quote');

  await pickPayin(page, tap, 'base', 'USDC');
  await page.fill('[data-testid=payin-amount]', '10');
  payin.nextTtl = 50;
  await tap('[data-testid=payin-quote]');
  await page.waitForSelector('[data-testid=payin-review]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid=payin-expired]');
  assert.equal(await page.$('[data-testid=payin-sign]'), null, 'no Sign under a minute');
  assert.match(await txt(page, '[data-testid=payin-expired]'), /Less than a minute/);
  const shortId = await page.getAttribute('[data-testid=payin-review]', 'data-quote');
  await shot('review-short');
  const sentBefore = state.sent.length;
  await tap('[data-testid=payin-requote]');
  await page.waitForFunction((id) => {
    const r = document.querySelector('[data-testid=payin-review]');
    return r && r.getAttribute('data-quote') !== id;
  }, shortId, { timeout: 30_000 });
  await page.waitForSelector('[data-testid=payin-sign]');
  assert.equal(payin.quotes.get(shortId).status, 'superseded', 'the short quote was replaced');
  assert.equal(state.sent.length, sentBefore, 'nothing signed for it');
  const openId = await page.getAttribute('[data-testid=payin-review]', 'data-quote');
  await tap('[data-testid=payin-review-back]');
  await page.waitForSelector('[data-testid=payin-form][data-chain=base]');
  ok('[phone] a quote with 50 s left cannot be signed; Get a new quote replaces it (superseded at the pay-in), nothing broadcast');

  // an open, unpaid quote is listed and can be paid from its tracker (and only that quote)
  await page.waitForSelector(`[data-testid=payin-purchase-${openId}]`);
  assert.equal(await page.$(`[data-testid=payin-purchase-${shortId}]`), null, 'the replaced quote is not listed');
  await tap(`[data-testid=payin-purchase-${openId}]`);
  await page.waitForSelector('[data-testid=payin-track][data-status=quoted]');
  assert.match(await txt(page, '[data-testid=payin-track-title]'), /Not paid yet/);
  await shot('track-unpaid');
  await tap('[data-testid=payin-track-pay]');
  await page.waitForSelector(`[data-testid=payin-review][data-quote=${openId}] [data-testid=payin-sign]`, { timeout: 30_000 });
  await tap('[data-testid=payin-review-back]');
  await page.waitForSelector('[data-testid=payin-form][data-chain=base]');
  assert.equal(state.sent.length, sentBefore);
  ok('[phone] an unpaid quote is listed under FMX purchases; its tracker offers Review and pay on that same quote');

  assert.deepEqual(jsErrors, [], `uncaught JS errors: ${jsErrors.join(' | ')}`);
  await ctx.close();
}

async function desktopPass(browser, shots) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  const shot = async (label) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, `desktop-${label}.png`), fullPage: !(await page.$('.modal')) });
  };
  current = { page, shot };
  const tap = (sel) => page.click(`${sel} >> visible=true`);

  await importWallet(page, tap, false);
  await openSwap(page, tap);
  await pickPayin(page, tap, 'base', 'ETH');
  assert.match(await txt(page, '[data-testid=payin-rate]'), /ETH is priced when you get the quote/);
  await page.waitForSelector('[data-testid=payin-howto]');
  await page.fill('[data-testid=payin-amount]', '0.01');

  // recipient: only behind a warning and an acknowledgement
  await tap('[data-testid=payin-recipient-change]');
  await page.waitForSelector('[data-testid=payin-recipient-edit]');
  assert.match(await txt(page, '[data-testid=payin-recipient-edit]'), /cannot be recovered or refunded/);
  await page.fill('[data-testid=payin-recipient-input]', OTHER);
  assert.equal(await page.isDisabled('[data-testid=payin-recipient-apply]'), true, 'not without the acknowledgement');
  assert.equal(await page.isDisabled('[data-testid=payin-quote]'), true, 'no quote while the recipient is being edited');
  await page.check('[data-testid=payin-recipient-ack]');
  await tap('[data-testid=payin-recipient-apply]');
  assert.match(await txt(page, '[data-testid=payin-recipient-label]'), /Not an account in this wallet/);
  await shot('buy-form-recipient');
  ok('[desktop] Base ETH: changing the FMX recipient takes a warning, an acknowledgement, and stays flagged');

  await tap('[data-testid=payin-quote]');
  await page.waitForSelector('[data-testid=payin-review]', { timeout: 30_000 });
  assert.deepEqual(payin.bodies.at(-1), { chain: 'base', asset: 'ETH', amount: '0.01', to: OTHER, from: ME });
  const qid = await page.getAttribute('[data-testid=payin-review]', 'data-quote');
  const quote = payin.quotes.get(qid);
  assert.equal((await txt(page, '[data-testid=payin-send-exactly]')).replace(/\s/g, ''), '0.009999999999999998ETH');
  assert.equal(await txt(page, '[data-testid=payin-review-recipient]'), OTHER);
  assert.match(await txt(page, '[data-testid=payin-review-recipient-warn]'), /not an account in this wallet/);
  assert.match(await txt(page, '[data-testid=payin-fee]'), /ETH · incl\. L1 data fee/);
  assert.equal(await page.$('[data-testid=payin-token]'), null, 'a native payment names no token contract');
  await shot('review');
  const before = state.sent.length;
  await tap('[data-testid=payin-sign]');
  await page.waitForSelector('[data-testid=payin-track]', { timeout: 30_000 });
  const sent = onlyNewTx(before);
  assert.equal(sent.chainId, 8453);
  assert.equal(sent.tx.chainId, 8453n);
  assert.equal(sent.tx.from, ME);
  assert.equal(sent.tx.to, DEPOSIT);
  assert.equal(sent.tx.value, BigInt(quote.sendExactly));
  assert.equal(sent.tx.value, parseUnits('0.01', 18) - 2n);
  assert.equal(sent.tx.data, '0x');
  ok(`[desktop] ONE transaction signed: chain 8453, ${quote.sendExactly} wei of ETH straight to ${DEPOSIT}, no call data`);

  await page.waitForSelector('[data-testid=payin-track][data-status=seen]', { timeout: 30_000 });
  payin.advance(qid, 'paid', { txHashOut: keccak256('0x01') });
  await page.waitForSelector('[data-testid=payin-track][data-status=paid]', { timeout: 30_000 });
  assert.match(await txt(page, '[data-testid=payin-track]'), new RegExp(OTHER));
  await shot('track-paid');
  ok('[desktop] tracker → paid; the FMX went to the recipient in the quote');

  // back to a Ferminux token: the DEX form again
  await tap('[data-testid=payin-track-back]');
  await page.waitForSelector('[data-testid=payin-form]');
  await tap('[data-testid=payin-token-in]');
  await page.waitForSelector('[data-testid=swap-picker]');
  await tap('[data-testid=swap-pick-native]');
  await page.waitForSelector('[data-testid=swap-form][data-in=native]');
  await page.waitForSelector('[data-testid=payin-purchases]');
  await shot('swap-with-purchases');
  ok('[desktop] picking FMX again returns to the Ferminux DEX swap form; purchases listed under it');

  assert.deepEqual(jsErrors, [], `uncaught JS errors: ${jsErrors.join(' | ')}`);
  await ctx.close();
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) skip('Playwright is not resolvable (set PLAYWRIGHT_MODULE)');

  const work = await mkdtemp(join(tmpdir(), 'ferminux-payin-'));
  const dist = join(work, 'dist');
  const shots = process.env.SMOKE_OUT ?? join(work, 'shots');
  await mkdir(shots, { recursive: true });

  const env = {
    ...process.env,
    VITE_RPC_URLS: `${ORIGIN}/rpc/3961`,
    VITE_EXPLORER_URL: `${ORIGIN}/explorer`,
    VITE_PAYIN_API_URL: ORIGIN,
    VITE_WC_PROJECT_ID: '',
  };
  for (const c of FOREIGN_CHAINS) env[`VITE_RPC_${c.key.toUpperCase()}`] = `${ORIGIN}/rpc/${c.id}`;
  const build = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: ROOT, stdio: 'ignore', env });
  if (build.status !== 0) throw new Error('vite build failed');

  const server = serve(dist);
  let browser;
  try {
    await new Promise((r, j) => server.listen(PORT, '127.0.0.1', r).on('error', j));
    ok(`bundle, 8 RPC mocks, pay-in mock and explorer stub on ${ORIGIN}`);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
    await phonePass(browser, shots);
    await desktopPass(browser, shots);
    info(`transactions broadcast: ${state.sent.map((s) => `${s.chainId}:${s.hash.slice(0, 10)}`).join(', ')}`);
    assert.equal(state.sent.length, 2, 'two purchases, two transactions, nothing else');
    console.log(`\nPAYIN SMOKE: all ${n} checks passed.\nScreenshots: ${shots}`);
  } catch (e) {
    if (current) {
      await current.shot('FAILED').catch(() => undefined);
      const on = await current.page
        .textContent('[data-testid=payin-problem], [data-testid=payin-form-error], [data-testid=payin-failed], .modal')
        .catch(() => null);
      if (on) console.error(`on screen: ${on.replace(/\s+/g, ' ').slice(0, 600)}`);
      console.error(`screenshots: ${shots}`);
    }
    throw e;
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error('\nPAYIN SMOKE FAILED:', e);
  process.exit(1);
});
