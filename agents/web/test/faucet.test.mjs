// src/faucet.ts under plain Node (Node 22.18+ strips the types). The gateway enforces the same rules
// (agents/gateway/src/v3/faucet.ts); these check what the page says before and after it asks.
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import { checkFaucetAddress, faucetRefusal, leadingZeroBits, powOk, retryMinutes, solvePow, transfersFor, waitText } from "../src/faucet.ts";

const ADDR = "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252";
const LIMITS = { enabled: true, dripFmx: "0.5", perAddress: "1 per 24 h", perIp: "10 per day", globalPerDay: 100, usedToday: 3, relayerReserveFmx: "50.0", pow: null };

test("checkFaucetAddress: any case, a checksum when mixed, never the zero address", () => {
  assert.deepEqual(checkFaucetAddress(ADDR), { ok: true, value: ADDR });
  assert.deepEqual(checkFaucetAddress(`  ${ADDR.toLowerCase()} `), { ok: true, value: ADDR });
  assert.equal(checkFaucetAddress("0x5672aF1a567a46BAaFeb66959b7A95666E7f4252").ok, false);
  assert.match(checkFaucetAddress("0x5672aF1a567a46BAaFeb66959b7A95666E7f4252").error, /checksum/);
  assert.match(checkFaucetAddress("").error, /Enter the address/);
  assert.match(checkFaucetAddress("0x123").error, /40 characters/);
  assert.match(checkFaucetAddress(`0x${"0".repeat(40)}`).error, /zero address/);
});

test("faucetRefusal: every gateway code reads as a sentence with what to do next", () => {
  assert.equal(faucetRefusal({ status: 429, code: "faucet_cooldown", message: "already dripped to this address; retry in 1375 min" }, LIMITS),
    "This address already received gas in the last 24 hours. It can ask again in 22 h 55 min.");
  assert.equal(faucetRefusal({ status: 429, code: "faucet_ip_limit", message: "faucet limit for this IP reached today" }, LIMITS),
    "This connection has used its 10 requests for today. The count resets at 00:00 UTC.");
  assert.equal(faucetRefusal({ status: 503, code: "faucet_daily_cap", message: "faucet is empty for today" }, LIMITS),
    "Today's faucet budget is spent: all 100 drips for the day are gone. It resets at 00:00 UTC.");
  assert.match(faucetRefusal({ status: 503, code: "faucet_reserve", message: "faucet paused: …" }, LIMITS), /^The faucet is paused\./);
  assert.equal(faucetRefusal({ status: 400, code: "faucet_not_needed", message: "address already holds 3.0 FMX — the faucet is for empty wallets" }, LIMITS),
    "Address already holds 3.0 FMX. The faucet only funds empty keys (below 0.5 FMX).");
  assert.equal(faucetRefusal({ status: 400, code: "faucet_used_key", message: "address has already sent 4 transaction(s) — the faucet only funds fresh keys" }, LIMITS),
    "Address has already sent 4 transaction(s). The faucet only funds keys that have never sent a transaction.");
  assert.match(faucetRefusal({ status: 400, code: "faucet_pow", message: "anti-abuse puzzle required" }, LIMITS), /puzzle answer was not accepted/);
  // the per-connection rate limiter and a switched-off gateway send no code
  assert.equal(faucetRefusal({ status: 429, message: "Rate limit exceeded, retry in 1 minute" }, LIMITS), "Too many requests from this connection. Wait a minute, then try again.");
  assert.equal(faucetRefusal({ status: 503, message: "faucet disabled (RELAYER_KEY unset)" }, LIMITS), "The faucet is switched off on this gateway right now.");
  assert.equal(faucetRefusal({ status: 400, message: "address must be a 0x address" }, null), "That is not a valid address.");
  // no limits read: the defaults still make a sentence
  assert.match(faucetRefusal({ status: 503, code: "faucet_daily_cap", message: "" }, null), /all drips for the day/);
});

test("retryMinutes and waitText", () => {
  assert.equal(retryMinutes("already dripped to this address; retry in 12 min"), 12);
  assert.equal(retryMinutes("something else"), null);
  assert.equal(waitText(40), "40 min");
  assert.equal(waitText(120), "2 h");
  assert.equal(waitText(1375), "22 h 55 min");
});

test("the anti-abuse puzzle matches the gateway's powBits", async () => {
  assert.equal(leadingZeroBits("0x" + "0".repeat(64)), 256);
  assert.equal(leadingZeroBits("0x0f" + "f".repeat(62)), 4);
  assert.equal(leadingZeroBits("0x1f" + "f".repeat(62)), 3);
  assert.equal(leadingZeroBits("0x8f" + "f".repeat(62)), 0);
  const pow = await solvePow(ADDR, 10);
  assert.ok(powOk(ADDR, pow, 10));
  // the gateway lower-cases the address before hashing
  assert.ok(leadingZeroBits(keccak256(toUtf8Bytes(`${ADDR.toLowerCase()}:${pow}`))) >= 10);
});

test("transfersFor: 0.5 FMX at 7 wei base fee + 1 gwei tip", () => {
  assert.equal(transfersFor(5n * 10n ** 17n, 1_000_000_007n), 23_809);
  assert.equal(transfersFor(5n * 10n ** 17n, 0n), 0);
});
