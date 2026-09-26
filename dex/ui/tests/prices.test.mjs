// USD valuation: the bases every dollar figure on the DEX uses.
//
// FMX at the official $0.52, and the pegged tokens exactly as the gateway's
// market logic values them (agents/gateway/src/constants.ts DEX_QUOTE_TOKENS):
// a test here imports that file and fails if the two ever disagree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';

import { FMX_USD_E18 } from '../src/config.ts';
import {
  E18,
  PEGS,
  baseTable,
  e18ToNumber,
  feeAprPpm,
  formatUsd,
  formatUsdPrice,
  poolFmxUsdE18,
  poolPriceE18,
  poolValue,
  priceTable,
  valueUsdE18,
} from '../src/lib/prices.ts';
import { buildPairIndex } from '../src/lib/pairs.ts';
import { DEX_QUOTE_TOKENS } from '../../../agents/gateway/src/constants.ts';

const WFMX = '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae';
const USDF = '0xCd032A609e34121D1881E8DE7355b2c2c7092363';
const AZNT = '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178';
const X = '0x9999999999999999999999999999999999999999';
const tok = (address, symbol, decimals) => ({ kind: 'erc20', address, symbol, name: symbol, decimals });
const tW = tok(WFMX, 'WFMX', 18);
const tU = tok(USDF, 'USDF', 6);
const tA = tok(AZNT, 'AZNT', 6);
const tX = tok(X, 'XXX', 18);
const pool = (token0, token1, reserve0, reserve1) => ({ pair: '0x' + 'cd'.repeat(20), token0, token1, reserve0, reserve1, totalSupply: 1n, blockTimestampLast: 0 });

test('the official FMX price is $0.52', () => {
  assert.equal(FMX_USD_E18, 520_000_000_000_000_000n);
  const t = baseTable(WFMX);
  assert.equal(t.get(WFMX.toLowerCase()).usdE18, FMX_USD_E18);
  assert.equal(t.get(WFMX.toLowerCase()).kind, 'official');
});

test("the pegs are the gateway's, to the wei and word for word", () => {
  assert.equal(PEGS.length, DEX_QUOTE_TOKENS.length);
  for (const g of DEX_QUOTE_TOKENS) {
    const mine = PEGS.find((p) => p.address.toLowerCase() === g.address.toLowerCase());
    assert.ok(mine, `${g.symbol} has a peg here`);
    assert.equal(mine.usdE18, g.usdE18, `${g.symbol}: same USD per token`);
    assert.equal(mine.basis, g.usdBasis, `${g.symbol}: same stated basis`);
  }
  // 1 AZNT = 1 AZN and 1 USD = 1.70 AZN.
  assert.equal(PEGS.find((p) => p.symbol === 'AZNT').usdE18, (10n ** 20n) / 170n);
});

test('valueUsdE18 scales by the token decimals', () => {
  assert.equal(valueUsdE18(parseUnits('100', 6), 6, E18), 100n * E18);
  assert.equal(valueUsdE18(parseEther('100'), 18, FMX_USD_E18), 52n * E18);
});

test('a pool is valued side by side at each side basis', () => {
  // The live pool on 2026-09-26: ~138,767 WFMX and 45,100 AZNT.
  const p = pool(tW, tA, parseEther('138767'), parseUnits('45100', 6));
  const t = baseTable(WFMX);
  const v = poolValue(p, t);
  assert.equal(v.side0UsdE18, valueUsdE18(parseEther('138767'), 18, FMX_USD_E18));
  assert.equal(v.side1UsdE18, valueUsdE18(parseUnits('45100', 6), 6, (10n ** 20n) / 170n));
  assert.equal(v.tvlUsdE18, v.side0UsdE18 + v.side1UsdE18);
  assert.equal(v.estimated, false);
  // $72,158.84 of FMX + $26,529.41 of AZNT
  assert.equal(formatUsd(v.tvlUsdE18), '$98,688.25');
});

test('one unvalued side: the pool is taken as equal value on both sides, and marked', () => {
  const p = pool(tU, tX, parseUnits('500', 6), parseEther('2000'));
  const v = poolValue(p, baseTable(WFMX));
  assert.equal(v.tvlUsdE18, 1000n * E18);
  assert.equal(v.estimated, true);
  assert.equal(poolValue(pool(tX, tok('0x' + '77'.repeat(20), 'Y', 18), 1n, 1n), baseTable(WFMX)).tvlUsdE18, null);
});

test('priceTable derives an unvalued token through its deepest pool against a valued one', () => {
  const shallow = pool(tU, tX, parseUnits('10', 6), parseEther('10')); // $1 per X
  const deep = pool(tW, tX, parseEther('100000'), parseEther('26000')); // X = 100000/26000 FMX = $2.00
  const t = priceTable(buildPairIndex([shallow, deep]), baseTable(WFMX));
  const x = t.get(X.toLowerCase());
  assert.equal(x.kind, 'derived');
  assert.equal(x.usdE18, 2n * E18, 'the deeper pool wins');
  assert.match(x.basis, /WFMX\/XXX/);
});

test('poolFmxUsdE18: FMX in USD as one pool prices it, through the peg', () => {
  const t = baseTable(WFMX);
  const atOfficial = pool(tW, tU, parseEther('50000'), parseUnits('26000', 6));
  assert.equal(poolFmxUsdE18(atOfficial, WFMX, t), FMX_USD_E18);
  const live = pool(tW, tA, parseEther('138767'), parseUnits('45100', 6));
  const usd = poolFmxUsdE18(live, WFMX, t);
  assert.ok(Math.abs(e18ToNumber(usd) - 0.1912) < 0.0001, `≈ $0.1912, got ${e18ToNumber(usd)}`);
  assert.equal(poolFmxUsdE18(pool(tU, tA, 1n, 1n), WFMX, t), null, 'not an FMX pool');
  assert.equal(poolPriceE18(atOfficial, USDF), (50000n * E18) / 26000n, 'USDF priced in FMX');
});

test('fee APR annualises fees against TVL, not compounded', () => {
  // $10 of fees in a day on $36,500 of liquidity = 10%.
  assert.equal(feeAprPpm(10n * E18, 36_500n * E18, 1), 100_000n);
  assert.equal(feeAprPpm(70n * E18, 36_500n * E18, 7), 100_000n);
  assert.equal(feeAprPpm(1n, null, 1), null);
  assert.equal(feeAprPpm(1n, 0n, 1), null);
});

test('formatUsd truncates, never rounds up, and says <$0.01 for dust', () => {
  assert.equal(formatUsd(1_999_999_999_999_999_999n), '$1.99');
  assert.equal(formatUsd(123_456_789n * E18), '$123,456,789.00');
  assert.equal(formatUsd(98_688n * E18, { compact: true }), '$98.6K');
  assert.equal(formatUsd(1_240_000n * E18, { compact: true }), '$1.24M');
  assert.equal(formatUsd(5n), '<$0.01');
  assert.equal(formatUsd(0n), '$0');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsdPrice(FMX_USD_E18), '$0.5200');
  assert.equal(formatUsdPrice(12_345_678_900_000n), '$0.00001234');
});
