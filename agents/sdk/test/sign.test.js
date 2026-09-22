// Canonical-message tests for sdk/src/sign.ts against the shared fixture
// (sdk/test/fixtures/commons-sign.json). The gateway runs the same vector.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Wallet, verifyMessage } from "ethers";
import { canonicalJson, canonicalMessage, sha256Hex, verifySigned, SignatureError, COMMONS_ACTIONS } from "../dist/sign.js";
import { Ferminux } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "commons-sign.json"), "utf8"));

test("canonicalJson sorts keys recursively and keeps array order", () => {
  assert.equal(canonicalJson(fx.payload), fx.canonicalJson);
  assert.equal(canonicalJson({ b: 1, a: undefined, c: [3, { z: 0, y: undefined }] }), '{"b":1,"c":[3,{"z":0}]}');
  assert.equal(canonicalJson({}), "{}");
});

test("sha256Hex of {} matches the spec constant", () => {
  assert.equal(sha256Hex("{}"), fx.emptyPayloadHash);
  assert.equal(sha256Hex(fx.canonicalJson), fx.bodyHash);
});

test("canonicalMessage equals the fixture (address checksummed even if given lowercase)", () => {
  assert.equal(canonicalMessage(fx.action, fx.address.toLowerCase(), fx.ts, fx.payload), fx.message);
  assert.equal(canonicalMessage("inbox.read", fx.address, fx.ts, {}).split("\n")[4], `body: ${fx.emptyPayloadHash}`);
});

test("fixture signature recovers the fixture address and is reproduced by signing", async () => {
  assert.equal(verifyMessage(fx.message, fx.sig), fx.address);
  const w = new Wallet(fx.privateKey);
  assert.equal(await w.signMessage(fx.message), fx.sig);
});

test("verifySigned accepts the vector inside the ts window and rejects outside", () => {
  const env = { address: fx.address, ts: fx.ts, sig: fx.sig };
  assert.equal(verifySigned(fx.action, env, fx.payload, fx.ts + 299), fx.address);
  assert.throws(() => verifySigned(fx.action, env, fx.payload, fx.ts + 301), (e) => e instanceof SignatureError && e.code === "stale_ts");
  assert.throws(() => verifySigned(fx.action, env, { ...fx.payload, title: "x" }, fx.ts), (e) => e.code === "sig_mismatch");
  assert.throws(() => verifySigned("post.create", env, fx.payload, fx.ts), (e) => e.code === "sig_mismatch");
  assert.throws(() => verifySigned("nope", env, fx.payload, fx.ts), (e) => e.code === "bad_action");
});

test("every COMMONS_ACTIONS entry has a fixture vector that canonicalises, hashes, signs and verifies", async () => {
  const w = new Wallet(fx.privateKey);
  assert.deepEqual([...COMMONS_ACTIONS], fx.actions);
  assert.equal(fx.vectors.length + 1, COMMONS_ACTIONS.length);
  for (const v of fx.vectors) {
    assert.ok(COMMONS_ACTIONS.includes(v.action), v.action);
    assert.equal(canonicalJson(v.payload), v.canonicalJson, v.action);
    assert.equal(sha256Hex(v.canonicalJson), v.bodyHash, v.action);
    assert.equal(canonicalMessage(v.action, fx.address, fx.ts, v.payload), v.message, v.action);
    assert.equal(v.message.split("\n")[1], `action: ${v.action}`);
    assert.equal(verifyMessage(v.message, v.sig), fx.address, v.action);
    assert.equal(await w.signMessage(v.message), v.sig, v.action);
    assert.equal(verifySigned(v.action, { address: fx.address, ts: fx.ts, sig: v.sig }, v.payload, fx.ts), fx.address, v.action);
    // a signature for one action never verifies for another
    const other = COMMONS_ACTIONS.find((a) => a !== v.action);
    assert.throws(() => verifySigned(other, { address: fx.address, ts: fx.ts, sig: v.sig }, v.payload, fx.ts), (e) => e.code === "sig_mismatch");
  }
});

test("fmx.sign() produces the fixture envelope for the fixture ts", async () => {
  const fmx = new Ferminux({ privateKey: fx.privateKey });
  const env = await fmx.sign(fx.action, fx.payload, fx.ts);
  assert.deepEqual(env, { address: fx.address, ts: fx.ts, sig: fx.sig });
  fmx.provider.destroy();
});
