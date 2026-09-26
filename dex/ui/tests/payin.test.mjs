// Pay with any coin (src/lib/payin.ts, src/lib/payWallet.ts).
//
// What these pin down: the seven networks and their contracts equal the
// gateway's own table; amounts are exact units at each coin's decimals (BNB
// Smart Chain's USDT and USDC have 18, not 6); a quote is accepted only when
// every figure the wallet acts on is the pinned one and the FMX figure
// recomputes to the wei; the one transfer a quote allows is built from
// sendExactly and nothing else; the status tracker never goes backwards and
// never lets a quote be paid twice; the wallet is switched, and checked again,
// before anything is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';

import { PAYIN_DEPOSIT_ADDRESS } from '../src/config.ts';
import {
  MAX_DUST_UNITS,
  PAYIN_DEFAULTS,
  PAY_CHAINS,
  PayApiError,
  allInPriceE18,
  applyStatus,
  balanceShortfall,
  buildPayTx,
  checkPayAmount,
  confirmOpenQuote,
  estimateFmxOut,
  fetchPayAssets,
  fetchPayStatus,
  fmxOutFor,
  gasReserve,
  isFinished,
  markSending,
  markSent,
  maxSpendable,
  maybeSent,
  newTrack,
  parseAssetsResponse,
  parseStore,
  payAsset,
  payChain,
  quoteRequestBody,
  readPayBalances,
  recentUnits,
  distinctFrom,
  visiblePurchases,
  requestPayQuote,
  sendRefusal,
  serializeStore,
  trackStep,
  upsertTrack,
  validateQuote,
} from '../src/lib/payin.ts';
import { addChainParams, assertReadyToPay, ensurePayChain, sendPayment } from '../src/lib/payWallet.ts';

const E18 = 10n ** 18n;
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const DEPOSIT = '0xc2a7B343a8a9ef2eC5D15c31225A64AC9FDC05Fa';
const ASSETS = JSON.parse(readFileSync(new URL('./fixtures/payin-assets.json', import.meta.url), 'utf8'));
const PRICE = 520_000_000_000_000_000n; // $0.52

// ---------------------------------------------------------------------------
// The gateway's table, read from its source
// ---------------------------------------------------------------------------

function gatewayChains() {
  const src = readFileSync(new URL('../../../agents/gateway/src/v3/payin.ts', import.meta.url), 'utf8');
  const block = /export const PAYIN_CHAINS = \{([\s\S]*?)\n\} as const;/.exec(src)?.[1];
  assert.ok(block, 'PAYIN_CHAINS found in agents/gateway/src/v3/payin.ts');
  const out = {};
  const chainRe = /(\w+): \{\s*chainId: (\d+), name: "([^"]+)", explorer: "([^"]+)", native: "(\w+)" as PayinAsset, confirmations: (\d+),\s*assets: \{([\s\S]*?)\} as Record/g;
  for (const m of block.matchAll(chainRe)) {
    const assets = {};
    for (const a of m[7].matchAll(/(\w+): \{ kind: "(erc20|native)", address: (null|"0x[0-9a-fA-F]{40}"), decimals: (\d+), stable: (true|false) \}/g)) {
      assets[a[1]] = { kind: a[2], token: a[3] === 'null' ? null : a[3].slice(1, -1), decimals: Number(a[4]), stable: a[5] === 'true' };
    }
    out[m[1]] = { chainId: Number(m[2]), name: m[3], explorer: m[4], native: m[5], confirmations: Number(m[6]), assets };
  }
  const num = (name) => {
    const m = new RegExp(`export const ${name} = ([0-9_ *]+)n?;`).exec(src);
    assert.ok(m, `${name} found`);
    return m[1].split('*').map((x) => Number(x.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1);
  };
  return { chains: out, spreadBps: num('PAYIN_SPREAD_BPS'), ttl: num('PAYIN_QUOTE_TTL_S'), minUsd: num('PAYIN_MIN_USD'), maxUsd: num('PAYIN_MAX_USD') };
}

test('drift: the seven networks, contracts, decimals and confirmations equal the gateway’s PAYIN_CHAINS', () => {
  const g = gatewayChains();
  assert.deepEqual(Object.keys(g.chains).sort(), PAY_CHAINS.map((c) => c.key).sort());
  for (const c of PAY_CHAINS) {
    const gc = g.chains[c.key];
    assert.equal(c.chainId, gc.chainId, `${c.key} chain id`);
    assert.equal(c.name, gc.name, `${c.key} name`);
    assert.equal(c.explorer, gc.explorer, `${c.key} explorer`);
    assert.equal(c.confirmations, gc.confirmations, `${c.key} confirmations`);
    assert.equal(c.native.symbol, gc.native, `${c.key} native coin`);
    assert.equal(c.chainIdHex, '0x' + c.chainId.toString(16));
    assert.ok(c.rpcUrls.length >= 1 && c.rpcUrls.every((u) => u.startsWith('https://')), `${c.key} has public read endpoints`);
    assert.deepEqual(c.assets.map((a) => a.symbol).sort(), Object.keys(gc.assets).sort(), `${c.key} assets`);
    for (const a of c.assets) {
      const ga = gc.assets[a.symbol];
      assert.equal(a.kind, ga.kind, `${c.key} ${a.symbol} kind`);
      assert.equal(a.token, ga.token, `${c.key} ${a.symbol} contract`);
      assert.equal(a.decimals, ga.decimals, `${c.key} ${a.symbol} decimals`);
      assert.equal(a.stable, ga.stable, `${c.key} ${a.symbol} stable`);
    }
  }
  assert.equal(PAYIN_DEFAULTS.spreadBps, g.spreadBps);
  assert.equal(PAYIN_DEFAULTS.expiresS, g.ttl);
  assert.equal(PAYIN_DEFAULTS.minUsd, g.minUsd);
  assert.equal(PAYIN_DEFAULTS.maxUsd, g.maxUsd);
});

test('drift: BNB Smart Chain USDT and USDC are 18 decimals, every other stablecoin 6', () => {
  for (const c of PAY_CHAINS) {
    for (const a of c.assets.filter((x) => x.stable)) assert.equal(a.decimals, c.key === 'bsc' ? 18 : 6, `${c.key} ${a.symbol}`);
  }
  assert.equal(PAYIN_DEPOSIT_ADDRESS, DEPOSIT, 'the pinned deposit address is the live one');
});

test('assets: the recorded live list offers all seven networks at $0.52 and 2%', () => {
  const info = parseAssetsResponse(ASSETS);
  assert.equal(info.enabled, true);
  assert.equal(info.priceE18, PRICE);
  assert.equal(info.spreadBps, 200);
  assert.equal(info.minUsd, 1);
  assert.equal(info.maxUsd, 10_000);
  for (const c of PAY_CHAINS) assert.equal(info.chains[c.key].available, true, `${c.key} available`);
  assert.equal(info.chains.bsc.confirmations, 12);
});

test('assets: a paused scanner, a different contract or deposit address, or a disabled pay-in each fail closed', () => {
  const clone = () => JSON.parse(JSON.stringify(ASSETS));
  const paused = clone();
  paused.chains.find((c) => c.chain === 'polygon').available = false;
  paused.chains.find((c) => c.chain === 'polygon').unavailableReason = 'deposit scanner is not reaching this chain right now — pay on another chain';
  let info = parseAssetsResponse(paused);
  assert.equal(info.chains.polygon.available, false);
  assert.match(info.chains.polygon.reason, /scanner/);
  assert.equal(info.chains.bsc.available, true);

  const token = clone();
  token.chains.find((c) => c.chain === 'bsc').assets.find((a) => a.symbol === 'USDT').token = OTHER;
  info = parseAssetsResponse(token);
  assert.equal(info.chains.bsc.available, false);
  assert.match(info.chains.bsc.reason, /USDT/);

  const decimals = clone();
  decimals.chains.find((c) => c.chain === 'bsc').assets.find((a) => a.symbol === 'USDC').decimals = 6;
  assert.equal(parseAssetsResponse(decimals).chains.bsc.available, false);

  const deposit = clone();
  deposit.chains.find((c) => c.chain === 'base').depositAddress = OTHER;
  info = parseAssetsResponse(deposit);
  assert.equal(info.chains.base.available, false);
  assert.match(info.chains.base.reason, /deposit address/);

  const off = clone();
  off.enabled = false;
  info = parseAssetsResponse(off);
  assert.ok(PAY_CHAINS.every((c) => !info.chains[c.key].available));

  assert.throws(() => parseAssetsResponse({ hello: 1 }), /asset list/);
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

test('amounts: exact units at each coin’s decimals, BSC USDT at 18', () => {
  const bscUsdt = payAsset('bsc', 'USDT');
  const baseUsdc = payAsset('base', 'USDC');
  const eth = payAsset('eth', 'ETH');
  let r = checkPayAmount('10', bscUsdt);
  assert.deepEqual(r, { ok: true, units: 10n * E18, text: '10.0' });
  r = checkPayAmount('10', baseUsdc);
  assert.deepEqual(r, { ok: true, units: 10_000_000n, text: '10.0' });
  r = checkPayAmount('1,250.5', baseUsdc);
  assert.deepEqual(r, { ok: true, units: 1_250_500_000n, text: '1250.5' });
  r = checkPayAmount('12.123456789012345678', bscUsdt);
  assert.equal(r.ok, true);
  assert.equal(r.units, 12_123_456_789_012_345_678n);
  assert.equal(checkPayAmount('1.1234567', baseUsdc).ok, false, '7 decimals on a 6-decimal USDC');
  assert.match(checkPayAmount('1.1234567', baseUsdc).error, /6 decimals/);
  assert.match(checkPayAmount('0.5', bscUsdt).error, /at least \$1/);
  assert.match(checkPayAmount('10000.000001', baseUsdc).error, /at most \$10,000/);
  assert.equal(checkPayAmount('10000', baseUsdc).ok, true);
  assert.equal(checkPayAmount('1', baseUsdc).ok, true);
  assert.equal(checkPayAmount('0.001', eth).ok, true, 'a native coin’s USD bounds are the quote’s to check');
  assert.equal(checkPayAmount('.5', eth).units, 5n * 10n ** 17n);
  for (const badInput of ['', 'abc', '1e5', '-1', '0', '1.2.3', '.']) assert.equal(checkPayAmount(badInput, eth).ok, false, badInput);
  assert.match(checkPayAmount('1234567890123456', eth).error, /too large/);
});

test('amounts: FMX out mirrors the gateway to the wei; the estimate and the all-in price', () => {
  assert.equal(fmxOutFor(10n * E18, PRICE, 200), 18_846_153_846_153_846_153n);
  assert.equal(fmxOutFor(1n * E18, PRICE, 200), 1_884_615_384_615_384_615n);
  assert.equal(fmxOutFor(10_000n * E18, PRICE, 200), 18_846_153_846_153_846_153_846n);
  assert.equal(estimateFmxOut(10n * E18, payAsset('bsc', 'USDT'), PRICE, 200), 18_846_153_846_153_846_153n);
  assert.equal(estimateFmxOut(10_000_000n, payAsset('base', 'USDC'), PRICE, 200), 18_846_153_846_153_846_153n, '6 and 18 decimals buy the same FMX');
  assert.equal(estimateFmxOut(10n ** 18n, payAsset('bsc', 'BNB'), PRICE, 200), null, 'a native coin is priced by the quote');
  assert.equal(allInPriceE18(PRICE, 200), 530_612_244_897_959_183n);
  assert.throws(() => fmxOutFor(E18, 0n, 200));
});

// ---------------------------------------------------------------------------
// Quotes: a mock of the gateway's POST /api/payin/quote
// ---------------------------------------------------------------------------

function fmt(units, decimals) {
  const d = 10n ** BigInt(decimals);
  const frac = (units % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${units / d}.${frac || '0'}`;
}

/** What the gateway answers for `req`, with `dust` units stepped down and optional overrides. */
function gatewayQuote(req, { dust = 0n, assetUsdE18 = E18, override = {}, nowS = 1_790_400_000 } = {}) {
  const c = payChain(req.chain);
  const a = payAsset(req.chain, req.asset);
  const units = req.units - dust;
  const usdE18 = (units * assetUsdE18) / 10n ** BigInt(a.decimals);
  const fmxOut = (usdE18 * E18 * (10_000n - 200n)) / (10_000n * PRICE);
  return {
    quoteId: 'q_0123456789abcdef',
    chain: req.chain,
    chainId: c.chainId,
    chainName: c.name,
    asset: req.asset,
    assetKind: a.kind,
    token: a.token,
    decimals: a.decimals,
    amount: fmt(units, a.decimals),
    amountRequested: fmt(req.units, a.decimals),
    dustUnits: dust.toString(),
    dustDirection: dust > 0n ? 'down' : 'none',
    sendExactly: units.toString(),
    sendExactlyFormatted: fmt(units, a.decimals),
    usd: fmt(usdE18, 18),
    assetUsd: fmt(assetUsdE18, 18),
    depositAddress: DEPOSIT,
    fmxOut: fmxOut.toString(),
    fmxOutFormatted: fmt(fmxOut, 18),
    priceUsdPerFmx: '0.52',
    spreadBps: 200,
    to: req.to,
    from: req.from,
    expiresAt: nowS + 900,
    expires: 900,
    confirmations: c.confirmations,
    status: 'quoted',
    explorer: c.explorer,
    note: 'Send exactly …',
    ...override,
  };
}

const CTX = { requestedAtMs: 1_790_400_000_000, priceE18: PRICE, spreadBps: 200, minUsd: 1, maxUsd: 10_000 };
const REQ_BSC = { chain: 'bsc', asset: 'USDT', units: 10n * E18, to: ME, from: ME };

test('quote: the request body carries the canonical amount, checksummed addresses and the payer', () => {
  assert.deepEqual(quoteRequestBody(REQ_BSC), { chain: 'bsc', asset: 'USDT', amount: '10.0', to: ME, from: ME });
  assert.deepEqual(quoteRequestBody({ ...REQ_BSC, chain: 'base', asset: 'USDC', units: 2_500_000n, to: ME.toLowerCase() }).amount, '2.5');
  assert.throws(() => quoteRequestBody({ ...REQ_BSC, asset: 'POL' }), /not offered/);
});

test('quote: a gateway quote with dust stepped down is accepted as exactly what the wallet sends (18-dec BSC USDT)', () => {
  const r = validateQuote(gatewayQuote(REQ_BSC, { dust: 3n }), REQ_BSC, CTX);
  assert.equal(r.ok, true, r.error);
  const q = r.quote;
  assert.equal(q.sendExactly, 10n * E18 - 3n);
  assert.equal(q.requested, 10n * E18);
  assert.equal(q.decimals, 18);
  assert.equal(q.token, '0x55d398326f99059fF775485246999027B3197955');
  assert.equal(q.depositAddress, DEPOSIT);
  assert.equal(q.fmxOut, fmxOutFor(((10n * E18 - 3n) * E18) / E18, PRICE, 200));
  assert.equal(q.deadlineMs, CTX.requestedAtMs + 900_000, 'the deadline runs on the local clock from when the request left');
  assert.equal(q.confirmations, 12);
});

test('quote: a native coin priced live is accepted when its USD value and FMX recompute', () => {
  const req = { chain: 'bsc', asset: 'BNB', units: 5n * 10n ** 16n, to: ME, from: ME }; // 0.05 BNB
  const quote = gatewayQuote(req, { assetUsdE18: 600n * E18, dust: 1n });
  const r = validateQuote(quote, req, CTX);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.quote.kind, 'native');
  assert.equal(r.quote.token, null);
  assert.equal(r.quote.usdE18, ((5n * 10n ** 16n - 1n) * 600n * E18) / E18);
});

test('quote: everything the wallet would act on must be the pinned or requested value', () => {
  const cases = [
    [{ token: OTHER }, /contract/],
    [{ depositAddress: OTHER }, /deposit address/],
    [{ chainId: 1 }, /another network/],
    [{ chain: 'eth' }, /another network/],
    [{ asset: 'USDC' }, /another coin/],
    [{ assetKind: 'native' }, /another coin/],
    [{ decimals: 6 }, /decimals/],
    [{ to: OTHER }, /FMX address/],
    [{ from: OTHER }, /paying wallet/],
    [{ from: null }, /paying wallet/],
    [{ status: 'seen' }, /not open/],
    [{ quoteId: 'x' }, /quote id/],
    [{ quoteId: 'q_../../x' }, /quote id/],
    [{ sendExactly: (10n * E18 + 1n).toString(), sendExactlyFormatted: undefined }, /more than you typed/],
    [{ sendExactly: (10n * E18 - MAX_DUST_UNITS - 1n).toString(), sendExactlyFormatted: undefined }, /further from what you typed/],
    [{ sendExactly: '0', sendExactlyFormatted: undefined }, /no amount/],
    [{ sendExactlyFormatted: '10.5' }, /two ways/],
    [{ fmxOut: (18_846_153_846_153_846_153n + 1n).toString() }, /FMX amount/],
    [{ priceUsdPerFmx: '0.25' }, /FMX price/],
    [{ spreadBps: 100 }, /spread/],
    [{ assetUsd: '0.99' }, /1 USD/],
    [{ usd: '11.0' }, /USD value/],
    [{ expires: 5 }, /lifetime/],
  ];
  for (const [override, why] of cases) {
    const r = validateQuote(gatewayQuote(REQ_BSC, { override }), REQ_BSC, CTX);
    assert.equal(r.ok, false, JSON.stringify(override));
    assert.match(r.error, why, JSON.stringify(override));
    assert.match(r.error, /Nothing was sent/);
  }
  assert.equal(validateQuote(null, REQ_BSC, CTX).ok, false);
  const up = gatewayQuote(REQ_BSC, { override: { sendExactly: (10n * E18 + 2n).toString(), sendExactlyFormatted: undefined, dustDirection: 'up' } });
  const fixed = { ...up, usd: fmt(10n * E18 + 2n, 18), fmxOut: fmxOutFor(10n * E18 + 2n, PRICE, 200).toString() };
  assert.equal(validateQuote(fixed, REQ_BSC, CTX).ok, true, 'the gateway’s rare upward step, a few units, when it says so');
  assert.equal(validateQuote(gatewayQuote(REQ_BSC), REQ_BSC, { ...CTX, priceE18: null }).ok, true, 'no published price: the quote’s own must still add up');
});

// ---------------------------------------------------------------------------
// The transfer
// ---------------------------------------------------------------------------

function acceptedQuote(req = REQ_BSC, opts = {}) {
  const r = validateQuote(gatewayQuote(req, opts), req, CTX);
  assert.equal(r.ok, true, r.error);
  return r.quote;
}

test('transfer: a token payment is transfer(deposit, sendExactly) sent to the pinned contract, with no value', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  const tx = buildPayTx(q);
  const units = 10n * E18 - 3n;
  assert.equal(tx.to, '0x55d398326f99059fF775485246999027B3197955');
  assert.equal(tx.from, ME);
  assert.equal(tx.value, '0x0');
  const expected = '0xa9059cbb' + DEPOSIT.slice(2).toLowerCase().padStart(64, '0') + units.toString(16).padStart(64, '0');
  assert.equal(tx.data, expected);
  const decoded = new Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', tx.data);
  assert.equal(decoded[0], DEPOSIT);
  assert.equal(decoded[1], units, 'exactly sendExactly, 18 decimals');

  const baseReq = { chain: 'base', asset: 'USDC', units: 25_000_000n, to: ME, from: ME };
  const b = buildPayTx(acceptedQuote(baseReq, { dust: 2n }));
  assert.equal(b.to, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(new Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', b.data)[1], 24_999_998n);
});

test('transfer: a native payment is sendExactly straight to the deposit address, no data', () => {
  const req = { chain: 'avalanche', asset: 'AVAX', units: 123_456_789_012_345_678n, to: ME, from: ME };
  const q = acceptedQuote(req, { assetUsdE18: 30n * E18, dust: 5n });
  const tx = buildPayTx(q);
  assert.deepEqual(tx, { from: ME, to: DEPOSIT, value: '0x' + (123_456_789_012_345_673n).toString(16) });
});

test('transfer: a quote tampered after validation is refused rather than sent', () => {
  const q = acceptedQuote();
  assert.throws(() => buildPayTx({ ...q, depositAddress: OTHER }), /does not match/);
  assert.throws(() => buildPayTx({ ...q, token: OTHER }), /token contract/);
  assert.throws(() => buildPayTx({ ...q, decimals: 6 }), /does not match/);
  assert.throws(() => buildPayTx({ ...q, sendExactly: 0n }), /no amount/);
});

// ---------------------------------------------------------------------------
// Balance and fee checks
// ---------------------------------------------------------------------------

test('balance: the token, then the fee on that network; a native coin must cover both', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  const gasPrice = 1_000_000_000n; // 1 gwei
  const ok = { native: 10n ** 16n, tokens: { USDT: 20n * E18, USDC: 0n }, gasPrice, at: 0 };
  assert.equal(balanceShortfall(q, ok), null);
  assert.match(balanceShortfall(q, { ...ok, tokens: { USDT: 5n * E18 } }), /You have 5\.0 USDT on BNB Smart Chain; this quote needs exactly 9\.999999999999999997/);
  assert.match(balanceShortfall(q, { ...ok, native: 1000n }), /Not enough BNB .* network fee/);
  assert.match(balanceShortfall(q, { ...ok, native: 0n, gasPrice: null }), /No BNB/);
  assert.equal(balanceShortfall(q, { native: null, tokens: {}, gasPrice: null, at: 0 }), null, 'unread balances: the wallet is the judge');

  const nq = acceptedQuote({ chain: 'bsc', asset: 'BNB', units: 5n * 10n ** 16n, to: ME, from: ME }, { assetUsdE18: 600n * E18 });
  const fee = gasReserve('native', gasPrice);
  assert.equal(fee, 26_250_000_000_000n);
  assert.equal(balanceShortfall(nq, { native: 5n * 10n ** 16n + fee, tokens: {}, gasPrice, at: 0 }), null);
  assert.match(balanceShortfall(nq, { native: 5n * 10n ** 16n + fee - 1n, tokens: {}, gasPrice, at: 0 }), /network fee/);
  assert.match(balanceShortfall(nq, { native: 10n ** 16n, tokens: {}, gasPrice, at: 0 }), /You have 0\.01 BNB/);

  assert.equal(maxSpendable(payAsset('bsc', 'USDT'), ok), 20n * E18);
  assert.equal(maxSpendable(payAsset('bsc', 'BNB'), ok), 10n ** 16n - 2n * fee);
  assert.equal(maxSpendable(payAsset('bsc', 'BNB'), { ...ok, native: 1n }), 0n);
  assert.equal(maxSpendable(payAsset('bsc', 'USDC'), { ...ok, tokens: {} }), null);
});

test('balance: reads each network over its public endpoints, falling back, with unreadable values null', async () => {
  const bsc = payChain('bsc');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([url, body.method]);
    if (url === bsc.rpcUrls[0]) return { ok: false, status: 502, json: async () => ({}) };
    if (body.method === 'eth_getBalance') return { ok: true, status: 200, json: async () => ({ result: '0x2386f26fc10000' }) };
    if (body.method === 'eth_gasPrice') return { ok: true, status: 200, json: async () => ({ result: '0x3b9aca00' }) };
    if (body.params[0].to === '0x55d398326f99059fF775485246999027B3197955') {
      assert.equal(body.params[0].data, '0x70a08231' + ME.slice(2).toLowerCase().padStart(64, '0'));
      return { ok: true, status: 200, json: async () => ({ result: '0x' + (20n * E18).toString(16).padStart(64, '0') }) };
    }
    return { ok: true, status: 200, json: async () => ({ error: { message: 'execution reverted' } }) };
  };
  const b = await readPayBalances(bsc, ME, fetchImpl);
  assert.equal(b.native, 10n ** 16n);
  assert.equal(b.gasPrice, 1_000_000_000n);
  assert.equal(b.tokens.USDT, 20n * E18);
  assert.equal(b.tokens.USDC, null);
  assert.ok(calls.some(([u]) => u === bsc.rpcUrls[1]), 'fell back to the second endpoint');
});

// ---------------------------------------------------------------------------
// The API client
// ---------------------------------------------------------------------------

test('api: asset list, quote and status go to the pay-in; errors come back readable', async () => {
  const seen = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  let next = reply(200, ASSETS);
  const fetchImpl = async (url, init) => {
    seen.push([url, init?.method, init?.body]);
    return next;
  };
  const info = await fetchPayAssets('https://ferminux.net/api/payin', fetchImpl);
  assert.equal(info.priceE18, PRICE);
  next = reply(201, gatewayQuote(REQ_BSC));
  await requestPayQuote('https://ferminux.net/api/payin', REQ_BSC, fetchImpl);
  assert.equal(seen[1][0], 'https://ferminux.net/api/payin/quote');
  assert.equal(seen[1][1], 'POST');
  assert.deepEqual(JSON.parse(seen[1][2]), { chain: 'bsc', asset: 'USDT', amount: '10.0', to: ME, from: ME });

  next = reply(503, { error: 'pay-in on Polygon is temporarily unavailable (scanner); pay on bsc', unavailable: true });
  await assert.rejects(requestPayQuote('https://x', REQ_BSC, fetchImpl), (e) => e instanceof PayApiError && e.unavailable && /Polygon/.test(e.message));
  next = reply(503, { error: 'price unavailable: coingecko down' });
  await assert.rejects(requestPayQuote('https://x', REQ_BSC, fetchImpl), (e) => !e.unavailable && /not taking payments right now/.test(e.message));
  next = reply(400, { error: 'amount must be worth between 1 and 10000 USD (this is ≈ 0.40 USD)' });
  await assert.rejects(requestPayQuote('https://x', REQ_BSC, fetchImpl), /between 1 and 10000 USD/);
  next = reply(429, {});
  await assert.rejects(requestPayQuote('https://x', REQ_BSC, fetchImpl), /Too many/);
  await assert.rejects(fetchPayStatus('https://x', '../assets', fetchImpl), /Not a quote id/);
  await assert.rejects(fetchPayAssets('https://x', async () => { throw new TypeError('fetch failed'); }), /Could not reach the pay-in/);
});

// ---------------------------------------------------------------------------
// The tracker's state machine
// ---------------------------------------------------------------------------

const H1 = '0x' + '1'.repeat(64);
const H2 = '0x' + '2'.repeat(64);
const status = (q, s, extra = {}) => ({
  quoteId: q.quoteId,
  chain: q.chain,
  asset: q.asset,
  target: q.to,
  sendExactly: q.sendExactly.toString(),
  status: s,
  confirmations: 0,
  required: q.confirmations,
  txHashIn: null,
  txHashOut: null,
  error: null,
  ...extra,
});

test('tracker: send only an open quote with a minute left, once', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  const t0 = newTrack(q);
  const at = (secsLeft) => q.deadlineMs - secsLeft * 1000;
  assert.equal(sendRefusal(t0, at(600)), null);
  assert.equal(sendRefusal(t0, at(61)), null);
  assert.match(sendRefusal(t0, at(59)), /Less than a minute/);
  assert.match(sendRefusal(t0, at(0)), /expired/);
  assert.match(sendRefusal(t0, at(-5)), /expired/);

  const sending = markSending(t0, at(500));
  assert.equal(maybeSent(sending), true, 'a send in flight when the page reloads may have gone out');
  const sent = markSent(sending, H1, at(499));
  assert.equal(sent.sentTx, H1);
  assert.equal(maybeSent(sent), false);
  assert.match(sendRefusal(sent, at(400)), /already been paid/);
  assert.throws(() => markSent(t0, 'not-a-hash', 0), /transaction hash/);

  for (const s of ['seen', 'confirmed', 'paid']) assert.match(sendRefusal({ ...t0, status: s }, at(600)), /already arrived/);
  assert.match(sendRefusal({ ...t0, status: 'superseded' }, at(600)), /replaced/);
  assert.match(sendRefusal({ ...t0, status: 'expired' }, at(600)), /expired/);
  assert.match(sendRefusal({ ...t0, status: 'failed' }, at(600)), /failed/);
});

test('tracker: quoted → sent → seen → confirmed → paid, never backwards, paid is final', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  let t = markSent(newTrack(q), H1, 1);
  assert.equal(trackStep(t), 1);
  t = applyStatus(t, status(q, 'quoted'), 2);
  assert.equal(t.status, 'quoted');
  assert.equal(trackStep(t), 1);
  t = applyStatus(t, status(q, 'seen', { confirmations: 3, txHashIn: H1 }), 3);
  assert.equal(t.status, 'seen');
  assert.equal(t.confirmations, 3);
  assert.equal(t.depositTx, H1);
  assert.equal(trackStep(t), 2);
  t = applyStatus(t, status(q, 'quoted'), 4);
  assert.equal(t.status, 'seen', 'a stale read does not undo a seen payment');
  t = applyStatus(t, status(q, 'seen', { confirmations: 2 }), 5);
  assert.equal(t.confirmations, 3, 'confirmations only go up');
  t = applyStatus(t, status(q, 'confirmed', { confirmations: 12, txHashIn: H1 }), 6);
  assert.equal(trackStep(t), 3);
  assert.equal(isFinished(t, 6), false);
  t = applyStatus(t, status(q, 'paid', { confirmations: 12, txHashIn: H1, txHashOut: H2, txHashes: { deposit: { hash: H1 }, fmx: { hash: H2 } } }), 7);
  assert.equal(t.status, 'paid');
  assert.equal(t.fmxTx, H2);
  assert.equal(trackStep(t), 4);
  assert.equal(isFinished(t, 7), true);
  t = applyStatus(t, status(q, 'failed', { error: 'late' }), 8);
  assert.equal(t.status, 'paid');
  assert.equal(t.checkedAt, 8);
});

test('tracker: expiry, supersession and failure; an answer about another quote is refused', () => {
  const q = acceptedQuote();
  const t = newTrack(q);
  assert.equal(isFinished(applyStatus(t, status(q, 'expired'), 1), 1), true);
  assert.equal(isFinished(applyStatus(t, status(q, 'superseded'), 1), 1), true, 'a replaced quote nobody paid is over');
  const sentThenSuperseded = applyStatus(markSent(t, H1, 1), status(q, 'superseded'), 2);
  assert.equal(isFinished(sentThenSuperseded, 2), false, 'a paid quote that was replaced can still be matched: keep following it');
  assert.equal(applyStatus(sentThenSuperseded, status(q, 'seen'), 3).status, 'seen');
  const failed = applyStatus(t, status(q, 'failed', { error: 'payout failed: out of gas' }), 1);
  assert.equal(failed.error, 'payout failed: out of gas');
  assert.equal(isFinished(failed, 1), true);
  assert.equal(isFinished(t, q.deadlineMs + 12 * 60_000), true, 'an unpaid quote is over once the pay-in stops matching it');
  assert.equal(isFinished(markSending(t, 1), q.deadlineMs + 12 * 60_000), false, 'unless a send may have gone out');
  assert.throws(() => applyStatus(t, { ...status(q, 'seen'), quoteId: 'q_ffffffffffffffff' }, 1), /another quote/);
  assert.throws(() => applyStatus(t, { ...status(q, 'seen'), target: OTHER }, 1), /another FMX recipient/);
  assert.throws(() => applyStatus(t, { ...status(q, 'seen'), sendExactly: '1' }, 1), /another amount/);
  assert.throws(() => applyStatus(t, { ...status(q, 'seen'), status: 'teleported' }, 1), /unknown status/);
  assert.equal(applyStatus(t, status(q, 'seen', { txHashIn: 'javascript:alert(1)' }), 1).depositTx, null, 'only a real hash becomes a link');
});

test('pre-send: the pay-in must still hold the quote open for this amount, recipient, payer, contract and deposit', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  const t = newTrack(q);
  const now = q.deadlineMs - 600_000;
  // What GET /api/payin/{id} answers for an open quote (the gateway's statusView).
  const live = (extra = {}) =>
    status(q, 'quoted', { chainId: 56, token: q.token, decimals: 18, depositAddress: DEPOSIT, payer: ME, assetKind: 'erc20', ...extra });
  const ok = confirmOpenQuote(t, live(), now);
  assert.equal(ok.refusal, null);
  assert.equal(ok.track.checkedAt, now);

  const refused = [
    [{ sendExactly: (q.sendExactly + 1n).toString() }, /another amount/],
    [{ sendExactly: undefined, amountUnits: undefined }, /no amount/],
    [{ target: OTHER }, /another FMX recipient/],
    [{ target: undefined }, /another FMX recipient/],
    [{ depositAddress: OTHER }, /deposit address/],
    [{ depositAddress: undefined }, /deposit address/],
    [{ token: OTHER }, /contract/],
    [{ decimals: 6 }, /decimals/],
    [{ chainId: 1 }, /another network/],
    [{ payer: OTHER }, /another paying wallet/],
    [{ quoteId: 'q_ffffffffffffffff' }, /another quote/],
    [{ status: 'superseded' }, /replaced/],
    [{ status: 'expired' }, /expired/],
    [{ status: 'seen', txHashIn: H1 }, /already arrived/],
  ];
  for (const [extra, why] of refused) {
    const r = confirmOpenQuote(t, live(extra), now);
    assert.match(r.refusal ?? '', why, JSON.stringify(extra));
    assert.match(r.refusal, /Nothing was sent|Get a new quote|Do not send/);
  }
  assert.match(confirmOpenQuote(t, live(), q.deadlineMs - 30_000).refusal, /Less than a minute/, 'the local clock still decides expiry');
  assert.equal(confirmOpenQuote(t, live({ payer: null }), now).refusal, null, 'a quote without a declared payer is not a mismatch');

  // A native quote: the pay-in names no contract.
  const nq = acceptedQuote({ chain: 'avalanche', asset: 'AVAX', units: 5n * 10n ** 17n, to: ME, from: ME }, { assetUsdE18: 20n * E18, dust: 3n });
  const nlive = (extra = {}) => status(nq, 'quoted', { chainId: 43114, token: null, decimals: 18, depositAddress: DEPOSIT, payer: ME, ...extra });
  assert.equal(confirmOpenQuote(newTrack(nq), nlive(), nq.deadlineMs - 600_000).refusal, null);
  assert.match(confirmOpenQuote(newTrack(nq), nlive({ token: OTHER }), nq.deadlineMs - 600_000).refusal, /contract/);
});

test('tracker: the store survives a reload and drops anything that no longer matches the pinned pay-in', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  const t = markSent(newTrack(q), H1, q.deadlineMs - 800_000);
  const store = upsertTrack({ active: null, tracks: [] }, t);
  const text = serializeStore({ ...store, active: q.quoteId });
  const back = parseStore(text, q.deadlineMs - 700_000);
  assert.equal(back.active, q.quoteId);
  assert.equal(back.tracks.length, 1);
  assert.deepEqual(back.tracks[0], t);
  assert.equal(back.tracks[0].quote.sendExactly, 10n * E18 - 3n);

  const raw = JSON.parse(text);
  raw.tracks[0].quote.depositAddress = OTHER;
  assert.equal(parseStore(JSON.stringify(raw), 0).tracks.length, 0, 'another deposit address');
  const raw2 = JSON.parse(text);
  raw2.tracks[0].quote.token = OTHER;
  assert.equal(parseStore(JSON.stringify(raw2), 0).tracks.length, 0, 'another token contract');
  const raw3 = JSON.parse(text);
  raw3.tracks[0].quote.sendExactly = 'lots';
  assert.equal(parseStore(JSON.stringify(raw3), 0).tracks.length, 0, 'an unreadable amount');
  assert.deepEqual(parseStore('{not json', 0), { active: null, tracks: [] });
  assert.deepEqual(parseStore(null, 0), { active: null, tracks: [] });
  const paid = { ...t, status: 'paid', checkedAt: 0 };
  assert.equal(parseStore(serializeStore({ active: null, tracks: [paid] }), 8 * 24 * 3600_000).tracks.length, 0, 'finished purchases are kept a week');
});

// ---------------------------------------------------------------------------
// The wallet: switch, check again, send exactly the quote's transfer
// ---------------------------------------------------------------------------

function fakeWallet({ chainId = 3961, account = ME, known = [3961, 56, 1], reject = null } = {}) {
  const state = { chainId, account, known: new Set(known), log: [], sent: [] };
  state.provider = {
    async request({ method, params }) {
      state.log.push(method);
      if (reject && reject === method) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      switch (method) {
        case 'eth_chainId':
          return '0x' + state.chainId.toString(16);
        case 'eth_accounts':
          return [state.account];
        case 'wallet_switchEthereumChain': {
          const id = Number(BigInt(params[0].chainId));
          if (!state.known.has(id)) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
          state.chainId = id;
          return null;
        }
        case 'wallet_addEthereumChain':
          state.known.add(Number(BigInt(params[0].chainId)));
          state.added = params[0];
          return null;
        case 'eth_sendTransaction':
          state.sent.push(params[0]);
          return '0x' + 'ab'.repeat(32);
        default:
          throw new Error('unexpected ' + method);
      }
    },
  };
  return state;
}

test('wallet: switches to the paying network, adding it first when the wallet does not know it', async () => {
  const w = fakeWallet({ known: [3961] });
  await ensurePayChain(w.provider, payChain('base'), { settleMs: 50 });
  assert.equal(w.chainId, 8453);
  assert.deepEqual(w.added, addChainParams(payChain('base')));
  assert.equal(w.added.rpcUrls[0], 'https://mainnet.base.org');
  const already = fakeWallet({ chainId: 56 });
  await ensurePayChain(already.provider, payChain('bsc'), { settleMs: 50 });
  assert.deepEqual(already.log, ['eth_chainId'], 'already there: nothing asked');
  const no = fakeWallet({ reject: 'wallet_switchEthereumChain' });
  await assert.rejects(ensurePayChain(no.provider, payChain('bsc'), { settleMs: 50 }), (e) => e.notSent && /not switched to BNB Smart Chain/.test(e.message));
});

test('wallet: the chain and account are checked again right before sending, and the transfer is exactly the quote’s', async () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n });
  const wrongChain = fakeWallet({ chainId: 3961 });
  await assert.rejects(sendPayment(wrongChain.provider, q), (e) => e.notSent && /chain 3961, not BNB Smart Chain/.test(e.message));
  assert.equal(wrongChain.sent.length, 0);
  const wrongAccount = fakeWallet({ chainId: 56, account: OTHER });
  await assert.rejects(assertReadyToPay(wrongAccount.provider, q), /payment from 0x7099/);
  await assert.rejects(sendPayment(wrongAccount.provider, q), /Nothing was sent/);
  assert.equal(wrongAccount.sent.length, 0);

  const w = fakeWallet({ chainId: 56 });
  const { hash, tx } = await sendPayment(w.provider, q);
  assert.equal(hash, '0x' + 'ab'.repeat(32));
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0], tx);
  assert.deepEqual(w.sent[0], buildPayTx(q));
  assert.equal(new Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', w.sent[0].data)[1], 10n * E18 - 3n);
  assert.deepEqual(w.log, ['eth_chainId', 'eth_accounts', 'eth_sendTransaction'], 'checked, then sent: nothing else');

  const rejects = fakeWallet({ chainId: 56, reject: 'eth_sendTransaction' });
  await assert.rejects(sendPayment(rejects.provider, q), (e) => e.notSent && /rejected/.test(e.message));
});

test('re-quoting: never an amount a replaced quote of this wallet can still be matched at', () => {
  const q = acceptedQuote(REQ_BSC, { dust: 3n }); // 10 USDT − 3 units, as the pay-in stepped it
  const t = newTrack(q);
  const now = q.deadlineMs - 60_000;
  const sel = { chain: 'bsc', asset: 'USDT', from: ME };
  assert.deepEqual(recentUnits([t], sel, now), [10n * E18 - 3n]);
  // Asking 10 again would let the pay-in step down onto the old amount: ask one unit under it.
  assert.equal(distinctFrom(10n * E18, recentUnits([t], sel, now)), 10n * E18 - 4n);
  assert.equal(distinctFrom(10n * E18, [10n * E18 - 3n, 10n * E18 - 9n]), 10n * E18 - 10n, 'under the lowest nearby one');
  assert.equal(distinctFrom(10n * E18, [2n * E18]), 10n * E18, 'a far-off amount cannot be reached');
  assert.equal(distinctFrom(10n * E18, [11n * E18]), 10n * E18, 'an amount above cannot be reached');
  assert.equal(distinctFrom(10n * E18, []), 10n * E18);
  assert.deepEqual(recentUnits([t], { ...sel, asset: 'USDC' }, now), [], 'another coin');
  assert.deepEqual(recentUnits([t], { ...sel, from: OTHER }, now), [], 'another payer');
  assert.deepEqual(recentUnits([{ ...t, status: 'paid' }], sel, now), [], 'a paid quote is no longer matched');
  assert.deepEqual(recentUnits([{ ...t, status: 'superseded' }], sel, now), [10n * E18 - 3n], 'a replaced one still is');
  assert.deepEqual(recentUnits([t], sel, q.deadlineMs + 16 * 60_000), [], 'after the pay-in’s ten-minute grace');
});

test('purchases list: paid, in flight or still open; a closed quote nobody paid is left out', () => {
  const q = acceptedQuote();
  const t = newTrack(q);
  const now = q.deadlineMs - 60_000;
  assert.equal(visiblePurchases([t], now).length, 1, 'open');
  assert.equal(visiblePurchases([t], q.deadlineMs + 1).length, 0, 'closed unpaid');
  assert.equal(visiblePurchases([{ ...t, status: 'superseded' }], now).length, 0, 'replaced unpaid');
  assert.equal(visiblePurchases([markSent(t, H1, now)], q.deadlineMs + 1).length, 1, 'sent');
  assert.equal(visiblePurchases([{ ...t, status: 'paid' }], q.deadlineMs + 1).length, 1, 'paid');
});
