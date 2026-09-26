// src/validatorForm.ts under plain Node (Node 22.18+ strips the types). The gateway runs the same checks.
import test from "node:test";
import assert from "node:assert/strict";
import { checkAddress, checkContact, checkForm, checkSeats } from "../src/validatorForm.ts";

const CHECKSUMMED = "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252";

test("checkAddress: any case is accepted, a broken checksum is a typo", () => {
  assert.deepEqual(checkAddress(CHECKSUMMED), { ok: true, value: CHECKSUMMED });
  assert.deepEqual(checkAddress(` ${CHECKSUMMED.toLowerCase()} `), { ok: true, value: CHECKSUMMED });
  assert.deepEqual(checkAddress(`0x${CHECKSUMMED.slice(2).toUpperCase()}`), { ok: true, value: CHECKSUMMED });
  assert.equal(checkAddress("0x5672aF1a567a46BAaFeb66959b7A95666E7f4252").ok, false);
  assert.match(checkAddress("0x5672aF1a567a46BAaFeb66959b7A95666E7f4252").error, /checksum/);
  assert.equal(checkAddress("5672AF1a567a46BAaFeb66959b7A95666E7f4252").ok, false);
  assert.equal(checkAddress("").ok, false);
  assert.equal(checkAddress(`0x${"0".repeat(40)}`).ok, false);
});

test("checkSeats and checkContact", () => {
  assert.deepEqual(checkSeats("3"), { ok: true, value: 3 });
  for (const bad of ["0", "11", "2.5", "", "x"]) assert.equal(checkSeats(bad).ok, false, bad);
  assert.deepEqual(checkContact(""), { ok: true, value: null });
  assert.deepEqual(checkContact("me@example.com"), { ok: true, value: "me@example.com" });
  assert.deepEqual(checkContact("t.me/ferminux_ops"), { ok: true, value: "@ferminux_ops" });
  assert.deepEqual(checkContact("ferminux_ops"), { ok: true, value: "@ferminux_ops" });
  assert.equal(checkContact("@abc").ok, false);
  assert.equal(checkContact("not a contact").ok, false);
});

test("checkForm: a contact needs consent; no contact sends consent false", () => {
  const base = { address: CHECKSUMMED.toLowerCase(), platform: "linux", seats: "2", contact: "", consent: false };
  assert.deepEqual(checkForm(base), { ok: true, body: { address: CHECKSUMMED, platform: "linux", seats: 2, consent: false } });
  assert.deepEqual(checkForm({ ...base, contact: "@ferminux_ops", consent: true }), { ok: true, body: { address: CHECKSUMMED, platform: "linux", seats: 2, contact: "@ferminux_ops", consent: true } });
  const noConsent = checkForm({ ...base, contact: "me@example.com" });
  assert.equal(noConsent.ok, false);
  assert.ok(noConsent.errors.consent);
  const all = checkForm({ address: "0x12", platform: "mac", seats: "0", contact: "??", consent: false });
  assert.deepEqual(Object.keys(all.errors).sort(), ["address", "contact", "platform", "seats"]);
});
