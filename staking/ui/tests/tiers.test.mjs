// lib/tiers.ts is the app's one static copy of the vault's tier shape (the ABI
// carries no enum names). This asserts it against FMXStaking.sol itself — enum
// order, which constant defines each tier's lock and minimum, and the weight /
// rate scales — so the copy cannot drift from the contract. The numbers
// themselves are read on chain at runtime; the e2e checks those reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TIER_IDS,
  TIER_SPECS,
  WEIGHT_TENTHS_PER_X,
  weightBpsFromTenths,
  unitsFromVault,
} from '../src/lib/tiers.ts';
import { BASE_UNIT_APR_BPS, BPS, weightedUnits } from '../src/lib/math.ts';

const SOL = readFileSync(new URL('../../contracts/src/FMXStaking.sol', import.meta.url), 'utf8');

function constant(name) {
  const m = new RegExp(`uint256\\s+(?:public|internal)\\s+constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`).exec(SOL);
  assert.ok(m, `FMXStaking.sol declares no numeric constant ${name}`);
  return BigInt(m[1].replace(/_/g, ''));
}

test('tiers: TIER_SPECS follows the Solidity Tier enum, member for member, in order', () => {
  const m = /enum\s+Tier\s*\{([^}]*)\}/.exec(SOL);
  assert.ok(m, 'enum Tier not found in FMXStaking.sol');
  const members = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(TIER_SPECS.map((t) => t.key), members);
  TIER_SPECS.forEach((t, i) => {
    assert.equal(t.id, i, `${t.key} id`);
    assert.equal(TIER_IDS[t.key], i, `TIER_IDS.${t.key}`);
  });
  assert.equal(Object.keys(TIER_IDS).length, members.length);
});

test('tiers: each lock is the constant the contract uses for that tier', () => {
  const ws = '\\s*';
  for (const t of TIER_SPECS) {
    const setsLockEnd = new RegExp(`tier${ws}==${ws}Tier\\.${t.key}\\)${ws}lockEnd${ws}=${ws}uint64\\(block\\.timestamp${ws}\\+${ws}(\\w+)\\)`).exec(SOL);
    if (t.lock === 'LOCK_90' || t.lock === 'LOCK_180') {
      assert.ok(setsLockEnd, `stake() sets no time lock for Tier.${t.key}`);
      assert.equal(setsLockEnd[1], t.lock, `Tier.${t.key} lock constant`);
    } else {
      assert.equal(setsLockEnd, null, `stake() sets a time lock for Tier.${t.key}, which the app treats as ${t.lock}`);
    }
    const expiry = new RegExp(`p\\.tier${ws}==${ws}Tier\\.${t.key}\\)${ws}return${ws}([^;]+);`).exec(SOL);
    if (t.lock === 'none') {
      assert.ok(expiry && expiry[1].trim() === 'true', `_lockExpired does not treat Tier.${t.key} as unlocked`);
    } else if (t.lock === 'VALIDATOR_LOCK_BLOCK') {
      assert.ok(expiry, `_lockExpired has no rule for Tier.${t.key}`);
      assert.equal(expiry[1].replace(/\s+/g, ' ').trim(), 'block.number >= VALIDATOR_LOCK_BLOCK');
    }
  }
});

test('tiers: the only minimum stake() enforces is the one TIER_SPECS names', () => {
  const minimums = new Map(
    [...SOL.matchAll(/tier\s*==\s*Tier\.(\w+)\)\s*\{\s*require\(\s*msg\.value\s*>=\s*(\w+)/g)].map((m) => [m[1], m[2]]),
  );
  for (const t of TIER_SPECS) {
    assert.equal(minimums.get(t.key) ?? null, t.minStake, `Tier.${t.key} minimum`);
  }
});

test('tiers: weight tenths and the 1%/yr-per-tenth accrual convert exactly to math.ts bps', () => {
  // W_FLEX is 1.0×, so the vault's tenths-per-1.0× is its value.
  assert.equal(constant('W_FLEX'), WEIGHT_TENTHS_PER_X);
  assert.match(SOL, /return\s+W_FLEX\s*;/);
  // _accrue releases totalUnits / (100 * YEAR) per second: 1%/yr per tenth,
  // so one 1.0× unit earns WEIGHT_TENTHS_PER_X % a year.
  assert.match(SOL, /\(totalUnits\s*\*\s*dt\)\s*\/\s*\(100\s*\*\s*YEAR\)/);
  assert.equal(BASE_UNIT_APR_BPS, (WEIGHT_TENTHS_PER_X * BPS) / 100n);
  // The source weights land on the bps the APY math is written in.
  assert.equal(weightBpsFromTenths(constant('W_FLEX')), 10_000n);
  assert.equal(weightBpsFromTenths(constant('W_90')), 15_000n);
  assert.equal(weightBpsFromTenths(constant('W_180')), 20_000n);
  assert.equal(weightBpsFromTenths(constant('W_VAL')), 20_000n);
  assert.equal(weightBpsFromTenths(constant('W_VAL_BOOST')), 30_000n);
  // Vault units (amount × tenths) and math.ts units (amount × bps / 10000) agree.
  const amount = 1_234n * 10n ** 18n;
  assert.equal(unitsFromVault(amount * constant('W_90')), weightedUnits(amount, 15_000n));
});
