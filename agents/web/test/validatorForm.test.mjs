// src/validatorForm.ts under plain Node (Node 22.18+ strips the types). The gateway runs the same checks, and the
// signed text must be the gateway's waitlistMessage exactly (compared below when agents/gateway/dist is built).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Wallet, verifyMessage } from "ethers";
import { checkAddress, checkChallenge, checkContact, checkForm, checkSeats, challengeQuery, waitlistMessage } from "../src/validatorForm.ts";

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
  assert.deepEqual(checkContact(" Me.Name@Example.COM "), { ok: true, value: "Me.Name@example.com" }, "the gateway lowercases the domain; the signed text must match it");
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

const BODY = { address: CHECKSUMMED, platform: "windows", seats: 3, contact: "@ferminux_ops", consent: true };
const NONCE = "0123456789abcdef0123456789abcdef";

test("waitlistMessage: every field, the nonce and the expiry, one per line", () => {
  assert.equal(waitlistMessage(BODY, NONCE, 1_900_000_000), [
    "Ferminux validator waitlist",
    "Sign to put this address on the waitlist for validator seats. Signing is free and sends no transaction.",
    "site: ferminux.net",
    `address: ${CHECKSUMMED}`, "platform: windows", "seats: 3", "contact: @ferminux_ops", "consent: yes",
    `nonce: ${NONCE}`, "expires: 1900000000",
  ].join("\n"));
  assert.match(waitlistMessage({ ...BODY, contact: undefined, consent: false }, NONCE, 1), /contact: none\nconsent: no/);
  const q = new URLSearchParams(challengeQuery(BODY));
  assert.deepEqual(Object.fromEntries(q), { address: CHECKSUMMED, platform: "windows", seats: "3", consent: "true", contact: "@ferminux_ops" });
  assert.equal(new URLSearchParams(challengeQuery({ ...BODY, contact: undefined, consent: false })).has("contact"), false);
});

test("checkChallenge: sign only the sign-up this page is sending", () => {
  const now = 1_800_000_000, expires = now + 600;
  const good = { message: waitlistMessage(BODY, NONCE, expires), nonce: NONCE, expires };
  assert.deepEqual(checkChallenge(BODY, good, now), { ok: true, message: good.message, nonce: NONCE, expires });
  assert.match(checkChallenge({ ...BODY, seats: 4 }, good, now).error, /different text/);
  assert.match(checkChallenge(BODY, { ...good, message: good.message.replace("windows", "linux") }, now).error, /different text/);
  assert.match(checkChallenge(BODY, { ...good, nonce: "xyz" }, now).error, /unreadable/);
  assert.match(checkChallenge(BODY, { ...good, expires: now - 1 }, now).error, /expiry/);
  assert.match(checkChallenge(BODY, { ...good, expires: now + 3600 }, now).error, /expiry/);
  assert.match(checkChallenge(BODY, null, now).error, /unreadable/);
});

test("a signature over the page's text recovers to the listed address", async () => {
  const w = Wallet.createRandom();
  const body = { ...BODY, address: w.address };
  const msg = waitlistMessage(body, NONCE, 1_900_000_000);
  assert.equal(verifyMessage(msg, await w.signMessage(msg)), w.address);
});

const GW = new URL("../../gateway/dist/validators.js", import.meta.url);
test("the page's text is the gateway's waitlistMessage", { skip: existsSync(GW) ? false : "agents/gateway/dist is not built (npm run build there)" }, async () => {
  const gw = await import(GW.href);
  for (const raw of [BODY, { ...BODY, contact: "Me@Example.COM" }, { address: CHECKSUMMED.toLowerCase(), platform: "both", seats: "10", contact: "", consent: false }]) {
    const checked = checkForm({ ...raw, contact: raw.contact ?? "", consent: raw.consent });
    assert.ok(checked.ok);
    const entry = gw.parseWaitlistBody(checked.body);
    assert.equal(waitlistMessage(checked.body, NONCE, 1_900_000_000), gw.waitlistMessage(entry, NONCE, 1_900_000_000));
  }
});
