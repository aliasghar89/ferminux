// src/market.ts under plain Node: the buy table and the LP lock line on /trade/.
import test from "node:test";
import assert from "node:assert/strict";
import { DEX, DEX_QUOTES, amountOut, buyFmx, lockedShare, spotUsdPerFmx } from "../src/market.ts";

// the WFMX/AZNT pool as read on 2026-09-26 (block 412,463)
const POOL = { wfmxReserve: 138767184453857319492643n, quoteReserve: 45100000000n, quoteDecimals: 6, usdPerQuote: 1 / 1.7 };

test("amountOut is the router's getAmountOut (0.30% fee on the input)", () => {
  // UniswapV2Library.getAmountOut(1000, 10000, 10000) = 906
  assert.equal(amountOut(1000n, 10000n, 10000n), 906n);
  assert.equal(amountOut(0n, 10n, 10n), 0n);
  assert.equal(amountOut(1n, 0n, 10n), 0n);
});

test("spot price and the buy table for the live pool", () => {
  assert.ok(Math.abs(spotUsdPerFmx(POOL) - 0.19118) < 0.0001);
  const r100 = buyFmx(100, POOL), r1k = buyFmx(1_000, POOL), r10k = buyFmx(10_000, POOL);
  assert.ok(r100 && r1k && r10k);
  assert.equal(Math.round(r100.fmx), 520);
  assert.equal(Math.round(r1k.fmx), 5026);
  assert.equal(Math.round(r10k.fmx), 37905);
  // the fee alone costs 0.3%, so even a small buy sits above spot; the average price rises with size
  assert.ok(r100.impactPct > 0.3 && r100.impactPct < r1k.impactPct && r1k.impactPct < r10k.impactPct);
  assert.ok(Math.abs(r10k.impactPct - 38.0) < 0.1);
  assert.equal(buyFmx(0, POOL), null);
  assert.equal(buyFmx(100, { ...POOL, quoteReserve: 0n }), null);
});

test("lockedShare floors, skips withdrawn and expired locks, and names the earliest unlock", () => {
  const supply = 79056941504209483n; // the pair's LP supply, 1,000 units of it burned at the first mint
  const lock = { amount: 79056941504208483n, unlockAt: 1_818_720_000n, withdrawn: false };
  const now = 1_790_380_000;
  assert.deepEqual(lockedShare([lock], supply, now), { pct: 99.99, lockedUntil: 1_818_720_000 });
  assert.deepEqual(lockedShare([{ ...lock, withdrawn: true }], supply, now), { pct: 0, lockedUntil: null });
  assert.deepEqual(lockedShare([{ ...lock, unlockAt: now - 1 }], supply, now), { pct: 0, lockedUntil: null });
  assert.deepEqual(lockedShare([lock, { amount: 0n, unlockAt: 1_800_000_000n, withdrawn: false }], supply, now).lockedUntil, 1_800_000_000);
  assert.deepEqual(lockedShare([], 0n, now), { pct: 0, lockedUntil: null });
});

test("the DEX addresses agree with the gateway's constants", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../gateway/src/constants.ts", import.meta.url), "utf8");
  for (const k of ["factory", "router", "wfmx", "locker"]) assert.match(src, new RegExp(`${k}: "${DEX[k]}"`), k);
  for (const q of DEX_QUOTES) assert.ok(src.includes(q.address), q.symbol);
});
