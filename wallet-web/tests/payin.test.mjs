// Buying FMX with a coin on another network through the Ferminux pay-in:
// decimals (BNB Smart Chain's USDT/USDC have 18, the rest 6), the asset list
// checked against the wallet's own chain list, quote validation (every field
// the gateway answers is checked against what was asked and against the
// quote's own arithmetic), expiry, the exact transfer that pays a quote (and
// the transaction actually signed for it), the status state machine and the
// purchases this device remembers. Quotes are built with the gateway's own
// arithmetic (agents/gateway/src/v3/payin.ts) — no live quote is ever
// requested; the asset list is a recording of GET /api/payin/assets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, Transaction, Wallet, getAddress, parseUnits } from 'ethers';
import {
  PAYIN_MAX_DUST_UNITS,
  PAYIN_MIN_LEFT_S,
  PAYIN_NETWORK_ORDER,
  PAYIN_RECORDS_CAP,
  PAYIN_STATUSES,
  PayinApiError,
  canStillPay,
  estimateStableFmx,
  expiryProblem,
  fetchPayinAssets,
  fetchPayinStatus,
  fmxForUsd,
  formatCountdown,
  isOpen,
  networkOf,
  parseDecimalUnits,
  parsePayinAssets,
  parsePayinQuote,
  parsePayinRecords,
  parsePayinStatus,
  payinCall,
  payinCoin,
  payinCoins,
  payinFundsProblem,
  payinNetworks,
  payinTxProblem,
  quoteBody,
  quoteFromRecord,
  recordFromQuote,
  recordsFrom,
  requestPayinQuote,
  secondsLeft,
  serializePayinRecords,
  stableBoundsProblem,
  trackerStep,
  withLocalPay,
  withRecord,
  withStatus,
} from '../src/lib/payin.ts';
import { FOREIGN_CHAINS } from '../src/lib/chains.ts';
import { signPrepared } from '../src/lib/tx.ts';

const GATEWAY = readFileSync(new URL('../../agents/gateway/src/v3/payin.ts', import.meta.url), 'utf8');
const ASSETS_JSON = JSON.parse(readFileSync(new URL('./fixtures/payin-assets.json', import.meta.url), 'utf8'));
const DEPOSIT = getAddress('0xc2a7B343a8a9ef2eC5D15c31225A64AC9FDC05Fa');
const ME = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const OTHER = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const BSC_USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');
const NOW = 1_790_399_100;
const E18 = 10n ** 18n;

/* ---------------- the gateway's arithmetic, restated for fixtures ---------------- */

/** payin.ts formatUnits: trailing zeros trimmed, at least one fractional digit. */
function gwFormat(units, decimals) {
  const d = 10n ** BigInt(decimals);
  const frac = (units % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${units / d}.${frac || '0'}`;
}

/** A POST /api/payin/quote reply exactly as registerPayinRoutes builds it (dust subtracted per colliding open quote). */
function gatewayQuote({ chain, asset, amount, to = ME, from = ME, taken = 0n, assetUsd = null, price = '0.52', nowS = NOW }) {
  const coin = payinCoin(chain, asset);
  const wanted = parseUnits(amount, coin.decimals);
  const units = wanted - taken;
  const assetUsdE18 = coin.stable ? E18 : parseUnits(assetUsd, 18);
  const usdE18 = (units * assetUsdE18) / 10n ** BigInt(coin.decimals);
  const priceE18 = parseUnits(price, 18);
  const fmxOut = (usdE18 * E18 * (10_000n - 200n)) / (10_000n * priceE18);
  const text = gwFormat(units, coin.decimals);
  return {
    quoteId: 'q_0123456789abcdef',
    chain,
    chainId: coin.chain.id,
    chainName: coin.chain.name,
    asset,
    assetKind: coin.kind,
    token: coin.address,
    decimals: coin.decimals,
    amount: text,
    amountRequested: gwFormat(wanted, coin.decimals),
    dustUnits: String(taken),
    dustDirection: taken > 0n ? 'down' : 'none',
    sendExactly: units.toString(),
    sendExactlyFormatted: text,
    usd: gwFormat(usdE18, 18),
    assetUsd: gwFormat(assetUsdE18, 18),
    depositAddress: DEPOSIT,
    fmxOut: fmxOut.toString(),
    fmxOutFormatted: gwFormat(fmxOut, 18),
    priceUsdPerFmx: price,
    spreadBps: 200,
    to,
    from,
    expiresAt: nowS + 900,
    expires: 900,
    confirmations: coin.chain.id === 56 ? 12 : coin.chain.id === 8453 ? 20 : 6,
    status: 'quoted',
    explorer: coin.chain.explorer.url,
    note: `Send exactly ${text} ${asset} …`,
  };
}

/** GET /api/payin/{id}: statusView(row) — the row's columns plus the derived fields the wallet reads. */
function gatewayStatus(q, patch = {}) {
  const base = {
    quoteId: q.quoteId,
    chain: q.chain,
    asset: q.asset,
    amount: q.amount,
    amountUnits: q.sendExactly,
    sendExactly: q.sendExactly,
    sendExactlyFormatted: q.sendExactlyFormatted,
    fmxOut: q.fmxOut,
    target: q.to,
    payer: q.from,
    depositAddress: q.depositAddress,
    status: 'quoted',
    txHashIn: null,
    blockIn: null,
    confirmations: 0,
    txHashOut: null,
    error: null,
    required: q.confirmations,
    chainId: q.chainId,
    enabled: true,
  };
  const s = { ...base, ...patch };
  s.txHashes = {
    deposit: s.txHashIn ? { chain: s.chain, chainId: q.chainId, hash: s.txHashIn, url: `x/tx/${s.txHashIn}` } : null,
    fmx: s.txHashOut ? { chain: 'ferminux', chainId: 3961, hash: s.txHashOut, url: `y/tx/${s.txHashOut}` } : null,
  };
  return s;
}

const assets = () => {
  const r = parsePayinAssets(ASSETS_JSON);
  assert.ok(r.ok, r.error);
  return r.value;
};
const req = (chain, asset, amount, extra = {}) => ({ chain, asset, units: parseUnits(amount, payinCoin(chain, asset).decimals), to: ME, from: ME, ...extra });
const quoteOk = (raw, r, opts = {}) => {
  const out = parsePayinQuote(raw, r, { assets: assets(), nowS: NOW, ...opts });
  assert.ok(out.ok, out.ok ? '' : out.error);
  return out.value;
};
const quoteBad = (raw, r, pattern) => {
  const out = parsePayinQuote(raw, r, { assets: assets(), nowS: NOW });
  assert.equal(out.ok, false, 'refused');
  if (pattern) assert.match(out.error, pattern);
  assert.match(out.error, /Nothing was sent/);
};

/* ---------------- coins and decimals ---------------- */

test('the coins per network are USDT, USDC and the native coin, from the wallet’s own chain list', () => {
  assert.deepEqual(payinNetworks().map((c) => c.key), [...PAYIN_NETWORK_ORDER]);
  assert.equal(payinNetworks().length, 7);
  for (const chain of FOREIGN_CHAINS) {
    const coins = payinCoins(chain);
    assert.deepEqual(coins.map((c) => c.symbol), ['USDT', 'USDC', chain.native.symbol], chain.key);
    assert.equal(coins[2].kind, 'native');
    assert.equal(coins[2].address, null);
    assert.equal(coins[2].decimals, 18);
  }
  const bscUsdt = payinCoin('bsc', 'USDT');
  assert.equal(bscUsdt.address, BSC_USDT);
  assert.equal(bscUsdt.decimals, 18, 'BNB Smart Chain USDT has 18 decimals');
  assert.equal(payinCoin('bsc', 'USDC').decimals, 18);
  for (const k of ['eth', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche']) {
    assert.equal(payinCoin(k, 'USDT').decimals, 6, k);
    assert.equal(payinCoin(k, 'USDC').decimals, 6, k);
  }
  assert.equal(payinCoin('bsc', 'ETH'), null);
  assert.equal(payinCoin('ferminux', 'USDT'), null);
});

test('decimal strings convert exactly, at 18 and at 6 decimals', () => {
  assert.equal(parseDecimalUnits('25', 18), 25n * E18);
  assert.equal(parseDecimalUnits('24.999999999999999997', 18), 25n * E18 - 3n);
  assert.equal(parseDecimalUnits('0.52', 18), 520_000_000_000_000_000n);
  assert.equal(parseDecimalUnits('25.5', 6), 25_500_000n);
  assert.equal(parseDecimalUnits('25.0000001', 6), null, 'more precision than the coin has');
  assert.equal(parseDecimalUnits('25.000', 2), 2500n, 'trailing zeros past the scale are still exact');
  for (const bad of ['', '-1', '1e18', '0x10', ' ', '1.2.3', null, 5]) assert.equal(parseDecimalUnits(bad, 18), null, String(bad));
  // the body sent to the gateway carries the typed units exactly, in the coin's own decimals
  assert.equal(quoteBody(req('bsc', 'USDT', '25'), payinCoin('bsc', 'USDT')).amount, '25.0');
  assert.equal(quoteBody(req('bsc', 'USDT', '0.000000000000000001'), payinCoin('bsc', 'USDT')).amount, '0.000000000000000001');
  assert.equal(quoteBody(req('base', 'USDC', '12.345678'), payinCoin('base', 'USDC')).amount, '12.345678');
});

/* ---------------- the asset list ---------------- */

test('the recorded asset list parses: all seven networks, 0.52 per FMX, 2% spread, $1–$10,000', () => {
  const a = assets();
  assert.equal(a.enabled, true);
  assert.equal(a.priceUsdPerFmx, '0.52');
  assert.equal(a.spreadBps, 200);
  assert.equal(a.minUsd, 1);
  assert.equal(a.maxUsd, 10_000);
  assert.equal(a.expires, 900);
  assert.deepEqual(a.networks.map((n) => n.key), [...PAYIN_NETWORK_ORDER]);
  for (const n of a.networks) {
    assert.equal(n.available, true, n.key);
    assert.equal(n.depositAddress, DEPOSIT);
    assert.equal(n.coins.length, 3, n.key);
  }
  assert.equal(networkOf(a, 'bsc').confirmations, 12);
  assert.equal(networkOf(a, 'polygon').confirmations, 60);
});

test('a network the pay-in cannot scan, or that disagrees with this wallet, is not offered', () => {
  const clone = () => JSON.parse(JSON.stringify(ASSETS_JSON));
  const byKey = (j, k) => j.chains.find((c) => c.chain === k);

  let j = clone();
  byKey(j, 'polygon').available = false;
  byKey(j, 'polygon').unavailableReason = 'deposit scanner failed its last 3 scans — pay on another chain';
  let n = networkOf(parsePayinAssets(j).value, 'polygon');
  assert.equal(n.available, false);
  assert.match(n.reason, /scanner failed/);

  j = clone();
  byKey(j, 'bsc').assets.find((x) => x.symbol === 'USDT').token = '0x1111111111111111111111111111111111111111';
  n = networkOf(parsePayinAssets(j).value, 'bsc');
  assert.equal(n.available, true, 'the rest of the network is fine');
  assert.deepEqual(n.coins, ['USDC', 'BNB'], 'a USDT contract the wallet does not know is never offered');

  j = clone();
  byKey(j, 'bsc').assets.find((x) => x.symbol === 'USDT').decimals = 6;
  assert.deepEqual(networkOf(parsePayinAssets(j).value, 'bsc').coins, ['USDC', 'BNB'], 'wrong decimals: not offered');

  j = clone();
  byKey(j, 'base').chainId = 1;
  n = networkOf(parsePayinAssets(j).value, 'base');
  assert.equal(n.available, false);
  assert.match(n.reason, /chain 1/);

  j = clone();
  byKey(j, 'eth').depositAddress = null;
  assert.equal(networkOf(parsePayinAssets(j).value, 'eth').available, false);

  j = clone();
  j.chains = j.chains.filter((c) => c.chain !== 'avalanche');
  assert.equal(networkOf(parsePayinAssets(j).value, 'avalanche').available, false);

  j = clone();
  j.enabled = false;
  assert.ok(parsePayinAssets(j).value.networks.every((x) => !x.available));

  for (const bad of [null, 'x', {}, { ...clone(), spreadBps: 9000 }, { ...clone(), minUsd: 0 }, { ...clone(), priceUsdPerFmx: 'cheap' }]) {
    assert.equal(parsePayinAssets(bad).ok, false);
  }
});

/* ---------------- before the quote ---------------- */

test('USD limits apply to the exact stablecoin amount, 18 decimals included', () => {
  const dec18 = payinCoin('bsc', 'USDT').decimals;
  assert.match(stableBoundsProblem(parseUnits('0.999999999999999999', 18), dec18, 1, 10_000), /at least \$1/);
  assert.equal(stableBoundsProblem(parseUnits('1', 18), dec18, 1, 10_000), null);
  assert.equal(stableBoundsProblem(parseUnits('10000', 18), dec18, 1, 10_000), null);
  assert.match(stableBoundsProblem(parseUnits('10000.000000000000000001', 18), dec18, 1, 10_000), /at most \$10,000/);
  assert.match(stableBoundsProblem(parseUnits('0.5', 6), 6, 1, 10_000), /at least/);
  assert.equal(stableBoundsProblem(parseUnits('50', 6), 6, 1, 10_000), null);
});

test('the estimate is the gateway’s own fmxOut formula at the listed price', () => {
  // 25 USD × 0.98 / 0.52 = 47.115384615384615384… FMX, rounded down
  const est = estimateStableFmx(parseUnits('25', 18), 18, assets());
  assert.equal(est, 47_115_384_615_384_615_384n);
  assert.equal(estimateStableFmx(parseUnits('25', 6), 6, assets()), est, 'same USD, same FMX, whatever the decimals');
  assert.equal(fmxForUsd(E18, parseUnits('0.52', 18), 200), 1_884_615_384_615_384_615n, '1 USD buys 1.8846… FMX');
  assert.equal(estimateStableFmx(parseUnits('25', 6), 6, { ...assets(), priceUsdPerFmx: null }), null, 'no fixed price: priced at quote time');
});

test('funds: the coin itself, then the network fee in the native coin', () => {
  const bsc = FOREIGN_CHAINS.find((c) => c.key === 'bsc');
  const usdt = payinCoin('bsc', 'USDT');
  const bnb = payinCoin('bsc', 'BNB');
  const amount = parseUnits('25', 18);
  const fee = parseUnits('0.0002', 18);
  const f = (o) => payinFundsProblem({ coin: usdt, chain: bsc, amount, tokenBalance: amount, nativeBalance: E18, maxFeeWei: fee, ...o });
  assert.equal(f({}), null);
  assert.match(f({ tokenBalance: amount - 1n }), /has 24\.999999 USDT on BNB Smart Chain; this purchase needs 25\.0 USDT/);
  assert.match(f({ nativeBalance: 0n }), /no BNB on BNB Smart Chain/);
  assert.match(f({ nativeBalance: fee - 1n }), /Not enough BNB .* network fee/);
  assert.equal(f({ tokenBalance: null, nativeBalance: null }), null, 'unknown balances are read again at review');
  const n = (o) => payinFundsProblem({ coin: bnb, chain: bsc, amount: parseUnits('0.05', 18), tokenBalance: null, nativeBalance: parseUnits('0.05', 18) + fee, maxFeeWei: fee, ...o });
  assert.equal(n({}), null);
  assert.match(n({ nativeBalance: parseUnits('0.05', 18) + fee - 1n }), /plus the network fee/);
  assert.match(n({ nativeBalance: parseUnits('0.04', 18) }), /this purchase needs 0\.05 BNB/);
});

/* ---------------- the quote ---------------- */

test('a BNB Smart Chain USDT quote (18 decimals, 3 units of dust) is accepted exactly as the gateway sends it', () => {
  const raw = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', taken: 3n });
  const q = quoteOk(raw, req('bsc', 'USDT', '25'));
  assert.equal(q.sendExactly, 25n * E18 - 3n);
  assert.equal(q.dustDirection, 'down');
  assert.equal(q.token, BSC_USDT);
  assert.equal(q.decimals, 18);
  assert.equal(q.chainId, 56);
  assert.equal(q.depositAddress, DEPOSIT);
  assert.equal(q.to, ME);
  assert.equal(q.from, ME);
  assert.equal(q.fmxOut, BigInt(raw.fmxOut));
  assert.equal(q.expiresAt, NOW + 900);
  assert.equal(q.confirmations, 12);
});

test('a native quote is accepted when its USD value and FMX follow from its own coin price', () => {
  const raw = gatewayQuote({ chain: 'base', asset: 'ETH', amount: '0.01', assetUsd: '2500' });
  const q = quoteOk(raw, req('base', 'ETH', '0.01'));
  assert.equal(q.kind, 'native');
  assert.equal(q.token, null);
  assert.equal(q.sendExactly, parseUnits('0.01', 18));
  assert.equal(raw.usd, '25.0');
  quoteBad({ ...raw, assetUsd: '2600.0' }, req('base', 'ETH', '0.01'), /USD value/);
});

test('a quote that differs from what was asked in any way is refused, nothing sent', () => {
  const r = req('bsc', 'USDT', '25');
  const good = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', taken: 3n });
  quoteBad({ ...good, to: OTHER }, r, /FMX recipient/);
  quoteBad({ ...good, from: OTHER }, r, /sender/);
  quoteBad({ ...good, from: null }, r, /sender/);
  quoteBad({ ...good, token: '0x1111111111111111111111111111111111111111' }, r, /token contract/);
  quoteBad({ ...good, decimals: 6 }, r, /decimals 6, not 18/);
  quoteBad({ ...good, chainId: 1 }, r, /chain id 1, not 56/);
  quoteBad({ ...good, chain: 'eth' }, r, /network/);
  quoteBad({ ...good, asset: 'USDC' }, r, /coin/);
  quoteBad({ ...good, assetKind: 'native' }, r, /coin kind/);
  quoteBad({ ...good, sendExactly: (25n * E18 - PAYIN_MAX_DUST_UNITS - 1n).toString() }, r, /asks for/);
  quoteBad({ ...good, sendExactly: (26n * E18).toString() }, r, /asks for 26\.0 USDT/);
  quoteBad({ ...good, sendExactly: '0' }, r, /amount/);
  quoteBad({ ...good, sendExactly: '25.0' }, r, /amount/);
  quoteBad({ ...good, fmxOut: (BigInt(good.fmxOut) + 1n).toString() }, r, /FMX amount does not follow/);
  quoteBad({ ...good, spreadBps: 100 }, r, /FMX amount does not follow/);
  quoteBad({ ...good, priceUsdPerFmx: '0.26' }, r, /FMX amount does not follow/);
  quoteBad({ ...good, usd: '26.0' }, r, /USD value/);
  quoteBad({ ...good, expiresAt: NOW }, r, /expiry/);
  quoteBad({ ...good, expiresAt: NOW + 200_000 }, r, /expiry/);
  quoteBad({ ...good, depositAddress: OTHER }, r, /differs from the listed one/);
  quoteBad({ ...good, depositAddress: 'nope' }, r, /deposit address/);
  quoteBad({ ...good, quoteId: '../admin' }, r, /quote id/);
  quoteBad({ ...good, confirmations: 0 }, r, /confirmations/);
  quoteBad(null, r);
  // without an asset list to compare against, the deposit address is taken from the quote (still checked well-formed)
  const noList = parsePayinQuote({ ...good, depositAddress: OTHER }, r, { assets: null, nowS: NOW });
  assert.ok(noList.ok);
  assert.equal(noList.value.depositAddress, OTHER);
});

/* ---------------- expiry ---------------- */

test('a quote with under a minute left is not signed', () => {
  const exp = NOW + 900;
  assert.equal(PAYIN_MIN_LEFT_S, 60);
  assert.equal(expiryProblem(exp, NOW), null);
  assert.equal(expiryProblem(exp, exp - 60), null);
  assert.equal(expiryProblem(exp, exp - 59), 'short');
  assert.equal(expiryProblem(exp, exp - 1), 'short');
  assert.equal(expiryProblem(exp, exp), 'expired');
  assert.equal(expiryProblem(exp, exp + 5), 'expired');
  assert.equal(secondsLeft(exp, NOW), 900);
  assert.equal(secondsLeft(exp, exp + 10), 0);
  assert.equal(formatCountdown(900), '15:00');
  assert.equal(formatCountdown(59.9), '00:59');
  assert.equal(formatCountdown(-3), '00:00');
});

test('the countdown runs on this device’s clock: a clock behind the pay-in’s cannot stretch a quote', () => {
  const raw = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25' });
  // the device clock is 20 minutes behind the gateway: the server's expiresAt would read as 35 minutes left
  const slow = quoteOk(raw, req('bsc', 'USDT', '25'), { nowS: NOW - 1200 });
  assert.equal(slow.expiresAt, NOW - 1200 + 900, 'anchored at this device’s now + the quote’s validity');
  assert.equal(expiryProblem(slow.expiresAt, NOW - 1200 + 841), 'short', 'refused a minute before the real expiry');
  // same clocks: unchanged; a quote without `expires` keeps the gateway's figure
  assert.equal(quoteOk(raw, req('bsc', 'USDT', '25')).expiresAt, NOW + 900);
  assert.equal(quoteOk({ ...raw, expires: undefined }, req('bsc', 'USDT', '25'), { nowS: NOW - 1200 }).expiresAt, NOW + 900);
  // a clock running ahead past the whole validity: refused, with the clock named
  const fast = parsePayinQuote(raw, req('bsc', 'USDT', '25'), { assets: assets(), nowS: NOW + 901 });
  assert.equal(fast.ok, false);
  assert.match(fast.error, /clock/);
});

/* ---------------- the transfer ---------------- */

const erc20 = new Interface(['function transfer(address to, uint256 value) returns (bool)']);

test('the transfer pays exactly sendExactly: transfer() on the token, or the native value to the deposit', () => {
  const q = quoteOk(gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', taken: 3n }), req('bsc', 'USDT', '25'));
  const c = payinCall(q);
  assert.equal(c.to, BSC_USDT);
  assert.equal(c.value, 0n);
  const [to, value] = erc20.decodeFunctionData('transfer', c.data);
  assert.equal(to, DEPOSIT);
  assert.equal(value, 24_999_999_999_999_999_997n);
  const tx = { chainId: 56, to: c.to, valueWei: c.value, data: c.data };
  assert.equal(payinTxProblem(tx, q), null);
  assert.match(payinTxProblem({ ...tx, chainId: 1 }, q), /chain 1/);
  assert.match(payinTxProblem({ ...tx, to: payinCoin('bsc', 'USDC').address }, q), /coin contract/);
  assert.match(payinTxProblem({ ...tx, valueWei: 1n }, q), /no native value/);
  assert.match(payinTxProblem({ ...tx, data: erc20.encodeFunctionData('transfer', [DEPOSIT, 25n * E18]) }, q), /exact quoted amount/, 'the rounded 25 is refused');
  assert.match(payinTxProblem({ ...tx, data: erc20.encodeFunctionData('transfer', [OTHER, value]) }, q), /deposit address/);
  assert.match(payinTxProblem({ ...tx, data: c.data + '00' }, q), /not transfer/);
  assert.match(payinTxProblem({ ...tx, data: '0x095ea7b3' + c.data.slice(10) }, q), /not transfer/, 'approve() is not a payment');

  const n = quoteOk(gatewayQuote({ chain: 'base', asset: 'ETH', amount: '0.01', assetUsd: '2500', taken: 2n }), req('base', 'ETH', '0.01'));
  const nc = payinCall(n);
  assert.deepEqual(nc, { to: DEPOSIT, value: parseUnits('0.01', 18) - 2n, data: '0x' });
  const ntx = { chainId: 8453, to: nc.to, valueWei: nc.value, data: nc.data };
  assert.equal(payinTxProblem(ntx, n), null);
  assert.match(payinTxProblem({ ...ntx, valueWei: parseUnits('0.01', 18) }, n), /exact quoted amount/);
  assert.match(payinTxProblem({ ...ntx, to: OTHER }, n), /deposit address/);
  assert.match(payinTxProblem({ ...ntx, data: '0x00' }, n), /no call data/);
  assert.match(payinTxProblem({ ...ntx, chainId: 10 }, n), /chain 10/);
});

test('the transaction the wallet signs for a quote carries exactly that payment, on that chain id', async () => {
  const w = Wallet.createRandom();
  const q = quoteOk(gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', from: w.address, taken: 3n }), req('bsc', 'USDT', '25', { from: w.address }));
  const c = payinCall(q);
  const prepared = {
    chainId: 56, from: w.address, to: c.to, valueWei: c.value, data: c.data, nonce: 7, gasLimit: 62_000n,
    maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n, baseFee: 1_000_000_000n, maxFeeWei: 124_000_000_000_000n,
  };
  assert.equal(payinTxProblem(prepared, q), null);
  const raw = await signPrepared(w.privateKey, prepared);
  const tx = Transaction.from(raw);
  assert.equal(tx.chainId, 56n);
  assert.equal(tx.from, w.address);
  assert.equal(tx.to, BSC_USDT);
  assert.equal(tx.value, 0n);
  const [to, amount] = erc20.decodeFunctionData('transfer', tx.data);
  assert.equal(to, DEPOSIT);
  assert.equal(amount, q.sendExactly);
});

/* ---------------- status and the state machine ---------------- */

const H = (c) => '0x' + c.repeat(64);

test('status answers are checked to be about this purchase', () => {
  const raw = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', taken: 3n });
  const rec = recordFromQuote(quoteOk(raw, req('bsc', 'USDT', '25')), NOW * 1000);
  const seen = parsePayinStatus(gatewayStatus(raw, { status: 'seen', txHashIn: H('a'), confirmations: 4 }), rec);
  assert.ok(seen.ok);
  assert.deepEqual(
    { status: seen.value.status, confirmations: seen.value.confirmations, required: seen.value.required, depositTx: seen.value.depositTx },
    { status: 'seen', confirmations: 4, required: 12, depositTx: H('a') },
  );
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), quoteId: 'q_ffffffffffffffff' }, rec).ok, false);
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), sendExactly: (25n * E18).toString() }, rec).ok, false, 'another amount');
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), target: OTHER }, rec).ok, false, 'another recipient');
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), chain: 'eth' }, rec).ok, false);
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), status: 'refunded' }, rec).ok, false);
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), depositAddress: OTHER }, rec).ok, false, 'another deposit address');
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), depositAddress: undefined }, rec).ok, false, 'no deposit address');
  assert.equal(parsePayinStatus({ ...gatewayStatus(raw), payer: OTHER }, rec).ok, false, 'another sender');
  assert.ok(parsePayinStatus({ ...gatewayStatus(raw), payer: null }, rec).ok, 'a quote without a declared payer (v1) is still read');
  const recovered = parsePayinStatus(gatewayStatus(raw, { status: 'paid', txHashOut: 'recovered:nonce:41' }), rec);
  assert.equal(recovered.value.fmxTx, null);
  assert.match(recovered.value.fmxNote, /recovered/);
});

test('status only moves forward: quoted → seen → confirmed → paid, and paid is final', () => {
  const raw = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25' });
  let rec = recordFromQuote(quoteOk(raw, req('bsc', 'USDT', '25')), NOW * 1000);
  const st = (patch) => parsePayinStatus(gatewayStatus(raw, patch), rec).value;
  assert.deepEqual(trackerStep(rec), { done: 0, bad: null });
  rec = withLocalPay(rec, H('a'), 'sent');
  assert.deepEqual(trackerStep(rec), { done: 1, bad: null });
  rec = withStatus(rec, st({ status: 'seen', txHashIn: H('a'), confirmations: 3 }));
  assert.equal(rec.status, 'seen');
  assert.equal(rec.confirmations, 3);
  assert.equal(rec.depositTx, H('a'));
  assert.deepEqual(trackerStep(rec), { done: 2, bad: null });
  rec = withStatus(rec, st({ status: 'seen', txHashIn: H('a'), confirmations: 2 }));
  assert.equal(rec.confirmations, 3, 'a slower poll never lowers the count');
  rec = withStatus(rec, st({ status: 'confirmed', txHashIn: H('a'), confirmations: 12 }));
  assert.deepEqual(trackerStep(rec), { done: 3, bad: null });
  rec = withStatus(rec, st({ status: 'seen', txHashIn: H('a'), confirmations: 11 }));
  assert.equal(rec.status, 'confirmed', 'no step back');
  rec = withStatus(rec, st({ status: 'expired' }));
  assert.equal(rec.status, 'confirmed', 'a seen payment never turns expired');
  rec = withStatus(rec, st({ status: 'paid', txHashIn: H('a'), txHashOut: H('b'), confirmations: 12 }));
  assert.equal(rec.status, 'paid');
  assert.equal(rec.fmxTx, H('b'));
  assert.deepEqual(trackerStep(rec), { done: 4, bad: null });
  assert.equal(isOpen(rec, NOW), false);
  const after = withStatus(rec, st({ status: 'failed', error: 'x' }));
  assert.equal(after, rec, 'paid is final');
});

test('unpaid, superseded, expired, failed, reverted and lost purchases', () => {
  const raw = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25' });
  const fresh = recordFromQuote(quoteOk(raw, req('bsc', 'USDT', '25')), NOW * 1000);
  const st = (patch) => parsePayinStatus(gatewayStatus(raw, patch), fresh).value;

  assert.equal(canStillPay(fresh, NOW), true);
  assert.equal(canStillPay(fresh, fresh.expiresAt - 30), false, 'under a minute: no');
  assert.equal(canStillPay(withLocalPay(fresh, H('c'), 'sent'), NOW), false, 'already paid from here: never twice');
  assert.equal(canStillPay(withLocalPay(fresh, H('c'), 'signed'), NOW), false, 'signed on an earlier visit: never twice');
  assert.equal(isOpen(fresh, NOW), true);
  assert.equal(isOpen(fresh, fresh.expiresAt + 600 + 121), false, 'past the gateway’s matching window');

  const sup = withStatus(fresh, st({ status: 'superseded' }));
  assert.deepEqual(trackerStep(sup), { done: 0, bad: 'superseded' });
  assert.equal(isOpen(sup, NOW), false, 'a replaced quote nobody paid is not polled');
  const supPaid = withStatus(withLocalPay(fresh, H('c'), 'sent'), st({ status: 'superseded' }));
  assert.equal(isOpen(supPaid, NOW), true, 'the gateway still matches a deposit to a superseded quote');
  assert.equal(withStatus(supPaid, st({ status: 'seen', txHashIn: H('c'), confirmations: 1 })).status, 'seen');

  const exp = withStatus(fresh, st({ status: 'expired' }));
  assert.deepEqual(trackerStep(exp), { done: 0, bad: 'expired' });
  assert.equal(isOpen(exp, NOW), false);

  const failed = withStatus(fresh, st({ status: 'failed', error: 'hot wallet underfunded' }));
  assert.deepEqual(trackerStep(failed), { done: 0, bad: 'failed' });
  assert.equal(failed.error, 'hot wallet underfunded');

  assert.deepEqual(trackerStep(withLocalPay(fresh, H('d'), 'reverted', 'reverted')), { done: 0, bad: 'reverted' });
  assert.deepEqual(trackerStep(withLocalPay(fresh, H('d'), 'dropped')), { done: 0, bad: 'dropped' });
  assert.deepEqual(trackerStep(withLocalPay(fresh, H('d'), 'signed')), { done: 0, bad: null }, 'signed is not yet sent');
  assert.equal(isOpen(withLocalPay(fresh, H('d'), 'reverted'), NOW), true, 'still polled: the gateway has the last word');

  assert.deepEqual([...PAYIN_STATUSES].sort(), ['confirmed', 'expired', 'failed', 'paid', 'quoted', 'seen', 'superseded']);
});

/* ---------------- purchases on this device ---------------- */

test('purchases survive a round trip through storage, garbage does not', () => {
  const q = quoteOk(gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', taken: 3n }), req('bsc', 'USDT', '25'));
  const rec = withLocalPay(recordFromQuote(q, NOW * 1000), H('a'), 'sent');
  const list = withRecord([], rec);
  const back = parsePayinRecords(serializePayinRecords(list));
  assert.deepEqual(back, list);
  assert.equal(back[0].sendExactly, '24999999999999999997', 'the exact amount, not a float');
  const again = quoteFromRecord(back[0]);
  assert.equal(again.sendExactly, q.sendExactly);
  assert.equal(again.spreadBps, 200);
  assert.equal(again.token, BSC_USDT);
  assert.equal(payinTxProblem({ chainId: 56, ...(({ to, value, data }) => ({ to, valueWei: value, data }))(payinCall(again)) }, again), null);

  const junk = [
    { ...rec, quoteId: 'nope' },
    { ...rec, quoteId: 'q_aaaaaaaaaaaaaaaa', token: '0x1111111111111111111111111111111111111111' },
    { ...rec, quoteId: 'q_bbbbbbbbbbbbbbbb', decimals: 6 },
    { ...rec, quoteId: 'q_cccccccccccccccc', sendExactly: '1.5' },
    { ...rec, quoteId: 'q_dddddddddddddddd', status: 'refunded' },
    { ...rec, quoteId: 'q_eeeeeeeeeeeeeeee', chain: 'ferminux' },
    'x',
    null,
  ];
  assert.equal(parsePayinRecords(JSON.stringify([...junk, rec])).length, 1);
  assert.deepEqual(parsePayinRecords('{'), []);
  assert.deepEqual(parsePayinRecords(null), []);

  let many = [];
  for (let i = 0; i < PAYIN_RECORDS_CAP + 5; i++) many = withRecord(many, { ...rec, quoteId: `q_${String(i).padStart(16, '0')}`, createdAt: i });
  assert.equal(many.length, PAYIN_RECORDS_CAP);
  assert.equal(many[0].createdAt, PAYIN_RECORDS_CAP + 4, 'newest first');
  assert.equal(withRecord(list, { ...rec, status: 'seen' }).length, 1, 'same quote id replaces');
  assert.equal(recordsFrom(list, ME.toLowerCase()).length, 1);
  assert.equal(recordsFrom(list, OTHER).length, 0, 'another account’s purchases are not shown');
});

/* ---------------- HTTP ---------------- */

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const hit = routes[`${init.method ?? 'GET'} ${new URL(url).pathname}`];
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    const [status, body] = typeof hit === 'function' ? hit(init) : hit;
    return { ok: status >= 200 && status < 300, status, json: async () => (body === undefined ? Promise.reject(new Error('no json')) : body) };
  };
}

test('the client asks for exactly what the gateway takes and surfaces its errors', async () => {
  const calls = [];
  const good = gatewayQuote({ chain: 'bsc', asset: 'USDT', amount: '25', taken: 3n });
  const f = fakeFetch(
    {
      'GET /api/payin/assets': [200, ASSETS_JSON],
      'POST /api/payin/quote': [201, good],
      'GET /api/payin/q_0123456789abcdef': [200, gatewayStatus(good, { status: 'seen', txHashIn: H('9'), confirmations: 1 })],
    },
    calls,
  );
  const a = await fetchPayinAssets('https://pay.test', f);
  const q = await requestPayinQuote('https://pay.test', req('bsc', 'USDT', '25'), { assets: a, nowS: () => NOW, fetchImpl: f });
  assert.equal(q.sendExactly, 25n * E18 - 3n);
  assert.deepEqual(calls[1], { url: 'https://pay.test/api/payin/quote', method: 'POST', body: { chain: 'bsc', asset: 'USDT', amount: '25.0', to: ME, from: ME } });
  const s = await fetchPayinStatus('https://pay.test', recordFromQuote(q, 0), f);
  assert.equal(s.status, 'seen');

  const unavailable = fakeFetch({ 'POST /api/payin/quote': [503, { error: 'pay-in on BNB Smart Chain is temporarily unavailable (…)', unavailable: true }] });
  await assert.rejects(
    requestPayinQuote('https://pay.test', req('bsc', 'USDT', '25'), { assets: a, nowS: () => NOW, fetchImpl: unavailable }),
    (e) => e instanceof PayinApiError && e.unavailable && /temporarily unavailable/.test(e.message),
  );
  const tooSmall = fakeFetch({ 'POST /api/payin/quote': [400, { error: 'amount must be worth between 1 and 10000 USD (this is ≈ 0.25 USD)' }] });
  await assert.rejects(
    requestPayinQuote('https://pay.test', req('base', 'ETH', '0.0001'), { assets: a, nowS: () => NOW, fetchImpl: tooSmall }),
    (e) => e instanceof PayinApiError && !e.unavailable && /between 1 and 10000 USD/.test(e.message),
  );
  const lying = fakeFetch({ 'POST /api/payin/quote': [201, { ...good, to: OTHER }] });
  await assert.rejects(requestPayinQuote('https://pay.test', req('bsc', 'USDT', '25'), { assets: a, nowS: () => NOW, fetchImpl: lying }), /FMX recipient/);
  const down = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(fetchPayinAssets('https://pay.test', down), /could not be reached/);
  const html = fakeFetch({ 'GET /api/payin/assets': [200, undefined] });
  await assert.rejects(fetchPayinAssets('https://pay.test', html), /not JSON/);
});

/* ---------------- drift against the gateway source ---------------- */

test('the gateway still answers with the fields and rules this wallet relies on', () => {
  for (const route of ['app.get("/api/payin/assets"', 'app.post("/api/payin/quote"', '"/api/payin/:quoteId"']) assert.ok(GATEWAY.includes(route), route);
  const reply = GATEWAY.slice(GATEWAY.indexOf('return reply.code(201).send({'), GATEWAY.indexOf('} catch (err) {', GATEWAY.indexOf('return reply.code(201).send({')));
  for (const key of ['quoteId', 'chainId', 'assetKind', 'token', 'decimals', 'sendExactly', 'depositAddress', 'fmxOut', 'priceUsdPerFmx', 'spreadBps', 'to: target', 'from: payer', 'expiresAt', 'confirmations', 'usd: usdText', 'assetUsd']) {
    assert.ok(reply.includes(key), `quote reply has ${key}`);
  }
  assert.match(GATEWAY, /status: "quoted" \| "seen" \| "confirmed" \| "paid" \| "expired" \| "failed" \| "superseded";/);
  assert.match(GATEWAY, /export const PAYIN_SPREAD_BPS = 200n;/);
  assert.match(GATEWAY, /export const PAYIN_QUOTE_TTL_S = 15 \* 60;/);
  assert.match(GATEWAY, /const from = typeof|body\.from/, 'the quote route takes the payer as `from`');
  // dust is stepped DOWN (never more than typed) — the wallet's amount check assumes it
  assert.match(GATEWAY, /let down = wanted - 1n;/);
  // a deposit is matched by exact amount, and only from the declared payer
  assert.match(GATEWAY, /amountUnits = \?/);
  assert.match(GATEWAY, /c\.payer\.toLowerCase\(\) === fromAddr\.toLowerCase\(\)/);
  // the status view the tracker reads
  const view = GATEWAY.slice(GATEWAY.indexOf('export function statusView'), GATEWAY.indexOf('export function registerPayinRoutes'));
  for (const key of ['sendExactly: units', 'txHashes', 'required: info.confirmations']) assert.ok(view.includes(key), `status view has ${key}`);
});
