// A plain number is an FMX amount everywhere in the SDK (CLI --price/--reward, MCP tools, register/hire).
// JavaScript prints numbers below 1e-6 or from 1e21 in exponent form, which parseEther refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";
import { toWei, plainDecimal } from "../dist/v3/shared.js";

test("toWei: numbers are FMX, including the ones JavaScript prints in exponent form", () => {
  assert.equal(toWei(1), parseEther("1"));
  assert.equal(toWei(0.5), parseEther("0.5"));
  assert.equal(toWei(1e-7), 100_000_000_000n);
  assert.equal(toWei(0.0000005), 500_000_000_000n);
  assert.equal(toWei(1e-18), 1n);
  assert.equal(toWei(1e21), 10n ** 39n);
  assert.equal(toWei(2.5e21), 25n * 10n ** 38n);
  // strings and bigints stay wei
  assert.equal(toWei("1000"), 1000n);
  assert.equal(toWei(7n), 7n);
  assert.throws(() => toWei(Number.NaN), /not an FMX amount/);
  assert.throws(() => toWei(1e-19)); // below one wei: refused, never rounded
});

test("plainDecimal", () => {
  assert.equal(plainDecimal(1.25e-7), "0.000000125");
  assert.equal(plainDecimal(-3e-7), "-0.0000003");
  assert.equal(plainDecimal(1.5e21), "1500000000000000000000");
  assert.equal(plainDecimal(42.5), "42.5");
});
