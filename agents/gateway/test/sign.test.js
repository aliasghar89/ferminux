// gateway/src/commons/sign.ts must agree byte-for-byte with sdk/src/sign.ts.
// Both run against the same fixture: sdk/test/fixtures/commons-sign.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyMessage } from "ethers";
import { canonicalJson, canonicalMessage, sha256Hex, verifySigned, SignatureError, COMMONS_ACTIONS } from "../dist/commons/sign.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "..", "..", "sdk", "test", "fixtures", "commons-sign.json"), "utf8"));

test("gateway and sdk sign.ts sources are identical (modulo the KEEP IN SYNC pointer line)", () => {
  const norm = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !l.includes("KEEP IN SYNC")).join("\n");
  assert.equal(norm(join(here, "..", "src", "commons", "sign.ts")), norm(join(here, "..", "..", "sdk", "src", "sign.ts")));
});

test("canonicalJson + sha256 match the fixture", () => {
  assert.equal(canonicalJson(fx.payload), fx.canonicalJson);
  assert.equal(sha256Hex(fx.canonicalJson), fx.bodyHash);
  assert.equal(sha256Hex("{}"), fx.emptyPayloadHash);
});

test("canonicalMessage matches the fixture and the fixture sig verifies", () => {
  assert.equal(canonicalMessage(fx.action, fx.address, fx.ts, fx.payload), fx.message);
  assert.equal(verifyMessage(fx.message, fx.sig), fx.address);
  assert.equal(verifySigned(fx.action, { address: fx.address.toLowerCase(), ts: String(fx.ts), sig: fx.sig }, fx.payload, fx.ts), fx.address);
});

test("verifySigned error codes", () => {
  const env = { address: fx.address, ts: fx.ts, sig: fx.sig };
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof SignatureError); return e.code; } return null; };
  assert.equal(code(() => verifySigned(fx.action, env, fx.payload, fx.ts - 301)), "stale_ts");
  assert.equal(code(() => verifySigned(fx.action, { ...env, address: "0x123" }, fx.payload, fx.ts)), "bad_address");
  assert.equal(code(() => verifySigned(fx.action, { ...env, ts: 1.5 }, fx.payload, fx.ts)), "bad_ts");
  assert.equal(code(() => verifySigned(fx.action, { ...env, sig: "0xzz" }, fx.payload, fx.ts)), "bad_sig");
  assert.equal(code(() => verifySigned(fx.action, { ...env, sig: "0x" + "11".repeat(65) }, fx.payload, fx.ts)), "bad_sig");
  assert.equal(code(() => verifySigned(fx.action, env, { ...fx.payload, body: "tampered" }, fx.ts)), "sig_mismatch");
});

test("every COMMONS_ACTIONS entry is covered by a fixture vector that verifies", () => {
  assert.deepEqual([...COMMONS_ACTIONS], fx.actions);
  assert.equal(fx.vectors.length + 1, COMMONS_ACTIONS.length);
  for (const v of fx.vectors) {
    assert.equal(canonicalJson(v.payload), v.canonicalJson, v.action);
    assert.equal(canonicalMessage(v.action, fx.address, fx.ts, v.payload), v.message, v.action);
    assert.equal(verifySigned(v.action, { address: fx.address, ts: fx.ts, sig: v.sig }, v.payload, fx.ts), fx.address, v.action);
  }
});
