// Validator waitlist (ferminux.net/validators/): sign-ups signed by the key of the listed address, validation and
// dedupe, the per-IP limit, the public count (totals only, never a contact), the operator-only export behind a
// signed GET, and the rows from before signatures were required.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { buildServer } from "../dist/server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import Database from "better-sqlite3";
import { openDb, openMemoryDb } from "../dist/db.js";
import { sha256Hex } from "../dist/commons/sign.js";
import { parseContact, parseWaitlistAddress, validatorOperatorsFromEnv, waitlistMessage, parseWaitlistBody, WAITLIST_SIG_TTL_S } from "../dist/validators.js";

const cfg = {
  rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1", payinRpcUrls: {}, payinDeposits: {}, webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9,
};
const operator = Wallet.createRandom();
const stranger = Wallet.createRandom();

async function setup(operators, kbOperators, { signatures, db = openMemoryDb() } = {}) {
  const prev = process.env.VALIDATOR_OPERATOR_ADDRESSES;
  const prevKb = process.env.KB_OPERATOR_ADDRESSES;
  const prevSig = process.env.VALIDATOR_WAITLIST_SIGNATURES;
  process.env.VALIDATOR_OPERATOR_ADDRESSES = operators ?? "";
  if (kbOperators) process.env.KB_OPERATOR_ADDRESSES = kbOperators; else delete process.env.KB_OPERATOR_ADDRESSES;
  if (signatures) process.env.VALIDATOR_WAITLIST_SIGNATURES = signatures; else delete process.env.VALIDATOR_WAITLIST_SIGNATURES;
  const { app } = await buildServer({ db, cfg, workers: false, logger: false, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
  await app.ready();
  if (prev === undefined) delete process.env.VALIDATOR_OPERATOR_ADDRESSES; else process.env.VALIDATOR_OPERATOR_ADDRESSES = prev;
  if (prevKb !== undefined) process.env.KB_OPERATOR_ADDRESSES = prevKb; else delete process.env.KB_OPERATOR_ADDRESSES;
  if (prevSig !== undefined) process.env.VALIDATOR_WAITLIST_SIGNATURES = prevSig; else delete process.env.VALIDATOR_WAITLIST_SIGNATURES;
  return { app, db };
}

const post = (app, body, ip = "203.0.113.10") =>
  app.inject({ method: "POST", url: "/api/validators/waitlist", headers: { "content-type": "application/json", "x-forwarded-for": ip }, payload: JSON.stringify(body) });

/** Signs the sign-up the way a client must: the challenge text for these fields, personal_sign by `wallet`. */
async function signed(app, wallet, fields) {
  const qs = new URLSearchParams(Object.entries({ address: wallet.address, ...fields }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const ch = await app.inject({ method: "GET", url: `/api/validators/waitlist/challenge?${qs}` });
  assert.equal(ch.statusCode, 200, ch.body);
  const { message, nonce, expires } = ch.json();
  return { address: wallet.address, ...fields, nonce, expires, sig: await wallet.signMessage(message) };
}

/** A signed sign-up; `address` may be a Wallet (signs) or a string (sent unsigned). */
async function join(app, body, ip) {
  if (body.address instanceof Wallet || body.address?.signMessage) {
    const { address: w, ...fields } = body;
    return post(app, await signed(app, w, fields), ip);
  }
  return post(app, body, ip);
}
const addr = () => Wallet.createRandom();

async function signedExport(app, wallet, { query = "", ts = Math.floor(Date.now() / 1000), body = "" } = {}) {
  const msg = ["Ferminux Commons", "action: validators.export", `address: ${wallet.address}`, `ts: ${ts}`, `body: ${sha256Hex(body)}`].join("\n");
  const sig = await wallet.signMessage(msg);
  const headers = { "x-ferminux-address": wallet.address, "x-ferminux-ts": String(ts), "x-ferminux-sig": sig };
  return { sig, res: await app.inject({ method: "GET", url: `/api/validators/waitlist/export${query}`, headers }), headers };
}

test("parsers: checksum-tolerant addresses and the two contact kinds", () => {
  const a = Wallet.createRandom().address;
  assert.equal(parseWaitlistAddress(a.toLowerCase()), a, "lowercase is taken as typed and checksummed");
  assert.equal(parseWaitlistAddress(`0x${a.slice(2).toUpperCase()}`), a, "all-uppercase too");
  assert.equal(parseWaitlistAddress(` ${a} `), a);
  // one letter's case flipped in a checksummed address: a typo the checksum catches
  assert.equal(parseWaitlistAddress("0x5672AF1a567a46BAaFeb66959b7A95666E7f4252"), "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252");
  assert.throws(() => parseWaitlistAddress("0x5672aF1a567a46BAaFeb66959b7A95666E7f4252"), /checksum/);
  assert.throws(() => parseWaitlistAddress("0x123"), /40 hex/);
  assert.throws(() => parseWaitlistAddress(`0x${"0".repeat(40)}`), /zero address/);
  assert.deepEqual(parseContact("User.Name+v@Example.COM"), { contact: "User.Name+v@example.com", kind: "email" });
  assert.deepEqual(parseContact("@ferminux_ops"), { contact: "@ferminux_ops", kind: "telegram" });
  assert.deepEqual(parseContact("ferminux_ops"), { contact: "@ferminux_ops", kind: "telegram" });
  assert.deepEqual(parseContact("https://t.me/ferminux_ops"), { contact: "@ferminux_ops", kind: "telegram" });
  assert.equal(parseContact("   "), null);
  assert.throws(() => parseContact("call me maybe"), /e-mail address or a Telegram handle/);
  assert.throws(() => parseContact("@abc"), /Telegram handle/, "Telegram handles are 5-32 characters");
  assert.deepEqual(validatorOperatorsFromEnv({ VALIDATOR_OPERATOR_ADDRESSES: ` ${operator.address} ,junk` }), [operator.address.toLowerCase()]);
  assert.deepEqual(validatorOperatorsFromEnv({ VALIDATOR_OPERATOR_ADDRESSES: "", KB_OPERATOR_ADDRESSES: operator.address }), [], "KB operators are not waitlist operators: the export (contacts) stays off");
});

test("sign-up: validates, stores once per address, and never echoes the contact", async (t) => {
  const { app } = await setup(operator.address);
  t.after(() => app.close());
  const w = addr();
  const a = w.address;
  const ok = await join(app, { address: w, platform: "Windows", seats: "3", contact: "@validator_one", consent: true });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json(), { ok: true, status: "added", total: 1 });
  assert.doesNotMatch(ok.body, /validator_one/);

  // the first signed entry stands: a resubmission, even one signed by the same key, changes nothing
  const again = await join(app, { address: w, platform: "linux", seats: 9, contact: "other@example.com", consent: true });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { ok: true, status: "already", total: 1 });

  // validation runs on the POST as it does on the challenge (the address is any string here: unsigned bodies
  // are refused for the signature only after the fields pass)
  const bad = async (body, code) => {
    const r = await post(app, { address: addr().address, platform: "linux", seats: 1, ...body });
    assert.equal(r.statusCode, 400, `${JSON.stringify(body)} → ${r.body}`);
    assert.equal(r.json().code, code, r.body);
  };
  await bad({ address: "0x1234" }, "bad_address");
  await bad({ address: undefined }, "bad_address");
  await bad({ platform: "mac" }, "bad_platform");
  await bad({ seats: 0 }, "bad_seats");
  await bad({ seats: 11 }, "bad_seats");
  await bad({ seats: 2.5 }, "bad_seats");
  await bad({ contact: "not a contact" }, "bad_contact");
  await bad({ contact: "me@example.com" }, "consent_required");
  await bad({ contact: "me@example.com", consent: false }, "consent_required");
  const noJson = await app.inject({ method: "POST", url: "/api/validators/waitlist", headers: { "content-type": "application/json" }, payload: "{nope" });
  assert.equal(noJson.statusCode, 400);

  // no contact: the consent box may stay empty
  const quiet = await join(app, { address: addr(), platform: "both", seats: 10 });
  assert.equal(quiet.statusCode, 201, quiet.body);

  // unsigned: refused, and it does not reveal whether the address is listed
  const unsigned = await post(app, { address: a, platform: "linux", seats: 1 });
  assert.equal(unsigned.statusCode, 401, unsigned.body);
  assert.equal(unsigned.json().code, "signature_required");
  assert.doesNotMatch(unsigned.body, /already/);

  const count = await app.inject({ method: "GET", url: "/api/validators/waitlist/count" });
  assert.equal(count.statusCode, 200);
  const c = count.json();
  assert.equal(c.total, 2);
  assert.equal(c.seats, 13);
  assert.equal(c.verified, 2);
  assert.deepEqual(c.byPlatform, { windows: 1, linux: 0, both: 1 });
  assert.match(count.headers["cache-control"], /max-age=30/);
  assert.doesNotMatch(count.body, /0x[0-9a-fA-F]{40}|@/, "the public count carries no address and no contact");

  // what the export shows proves the resubmission did not overwrite the first entry
  const { res } = await signedExport(app, operator);
  assert.equal(res.statusCode, 200, res.body);
  const first = res.json().items.find((i) => i.address === a);
  assert.ok(first.signedAt > 0);
  assert.deepEqual({ ...first, createdAt: 0, signedAt: 0 }, { address: a, platform: "windows", seats: 3, contact: "@validator_one", contactKind: "telegram", consent: true, createdAt: 0, verified: true, signedAt: 0 });
});

test("sign-up signature: only the key of the listed address, over these exact fields, before it expires", async (t) => {
  const { app } = await setup(operator.address);
  t.after(() => app.close());
  const victim = addr();
  const attacker = addr();

  // the attacker signs a challenge for the victim's address with the attacker's own key
  const forged = await signed(app, attacker, { platform: "linux", seats: 1 });
  const r1 = await post(app, { ...forged, address: victim.address });
  assert.equal(r1.statusCode, 401, r1.body);
  assert.equal(r1.json().code, "sig_mismatch");

  // a genuine signature cannot be reused for other fields
  const real = await signed(app, victim, { platform: "linux", seats: 1, contact: "victim@example.com", consent: true });
  for (const change of [{ seats: 5 }, { platform: "windows" }, { contact: "attacker@example.com" }, { consent: false, contact: undefined }, { nonce: "ab".repeat(16) }]) {
    const r = await post(app, { ...real, ...change });
    assert.ok([400, 401].includes(r.statusCode), `${JSON.stringify(change)} → ${r.statusCode} ${r.body}`);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/validators/waitlist/count" })).json().total, 0);

  // expiry: in the past, or further ahead than the challenge ever issues
  const now = Math.floor(Date.now() / 1000);
  const entry = parseWaitlistBody({ address: victim.address, platform: "linux", seats: 1 });
  const nonce = "0123456789abcdef";
  const old = await post(app, { address: victim.address, platform: "linux", seats: 1, nonce, expires: now - 1, sig: await victim.signMessage(waitlistMessage(entry, nonce, now - 1)) });
  assert.equal(old.statusCode, 401);
  assert.equal(old.json().code, "sig_expired");
  const far = now + WAITLIST_SIG_TTL_S * 10;
  const tooFar = await post(app, { address: victim.address, platform: "linux", seats: 1, nonce, expires: far, sig: await victim.signMessage(waitlistMessage(entry, nonce, far)) });
  assert.equal(tooFar.statusCode, 401);
  assert.equal(tooFar.json().code, "bad_expires");
  const shape = await post(app, { address: victim.address, platform: "linux", seats: 1, nonce: "xyz", expires: now + 60, sig: "0x00" });
  assert.equal(shape.statusCode, 400);
  assert.equal(shape.json().code, "bad_nonce");

  // a client may build the text itself (documented format, any fresh nonce) instead of asking for a challenge
  const own = now + 300;
  const self = await post(app, { address: victim.address.toLowerCase(), platform: "LINUX", seats: "1", nonce, expires: own, sig: await victim.signMessage(waitlistMessage(entry, nonce, own)) });
  assert.equal(self.statusCode, 201, self.body);
  const text = waitlistMessage(entry, nonce, own);
  assert.match(text, /^Ferminux validator waitlist\n/);
  assert.match(text, new RegExp(`address: ${victim.address}\\n`));
  assert.match(text, /\ncontact: none\nconsent: no\n/);

  // the challenge validates the same fields and is never cached
  const badCh = await app.inject({ method: "GET", url: `/api/validators/waitlist/challenge?address=${victim.address}&platform=mac&seats=1` });
  assert.equal(badCh.statusCode, 400);
  assert.equal(badCh.json().code, "bad_platform");
  const ch = await app.inject({ method: "GET", url: `/api/validators/waitlist/challenge?address=${victim.address}&platform=linux&seats=1` });
  assert.equal(ch.headers["cache-control"], "no-store");
  assert.ok(ch.json().expires - now <= WAITLIST_SIG_TTL_S + 5);
});

test("rows from before signatures: kept, counted, exported as unverified, and claimable by their own key only", async (t) => {
  // a waitlist DB file created by the previous gateway (no sig columns) with one unsigned row in it, then opened
  // by this one the way the server opens it (openDb runs every migration)
  const dir = mkdtempSync(pathJoin(tmpdir(), "fmx-waitlist-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new Database(pathJoin(dir, "agents.db"));
  legacy.exec(`CREATE TABLE validator_waitlist (address TEXT PRIMARY KEY, addressChecksum TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('windows','linux','both')), seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 10), contact TEXT, contactKind TEXT CHECK (contactKind IN ('email','telegram')), consent INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)`);
  const owner = addr();
  legacy.prepare("INSERT INTO validator_waitlist VALUES (?, ?, 'both', 4, 'planted@example.com', 'email', 1, 1790000000)").run(owner.address.toLowerCase(), owner.address);
  legacy.close();
  const db = openDb(dir);
  const { app } = await setup(operator.address, undefined, { db });
  t.after(() => app.close());

  let c = (await app.inject({ method: "GET", url: "/api/validators/waitlist/count" })).json();
  assert.equal(c.total, 1);
  assert.equal(c.verified, 0);
  let ex = (await signedExport(app, operator)).res.json();
  assert.deepEqual({ ...ex.items[0] }, { address: owner.address, platform: "both", seats: 4, contact: "planted@example.com", contactKind: "email", consent: true, createdAt: 1790000000, verified: false, signedAt: null });

  // someone else's key cannot touch it; the owner's key replaces it
  const stranger2 = addr();
  const forged = await signed(app, stranger2, { platform: "linux", seats: 1 });
  assert.equal((await post(app, { ...forged, address: owner.address })).statusCode, 401);
  const claim = await join(app, { address: owner, platform: "linux", seats: 2, contact: "@real_owner", consent: true });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.deepEqual(claim.json(), { ok: true, status: "verified", total: 1 });
  // and from then on the signed entry stands
  const after = await join(app, { address: owner, platform: "windows", seats: 9 });
  assert.equal(after.json().status, "already");

  c = (await app.inject({ method: "GET", url: "/api/validators/waitlist/count" })).json();
  assert.equal(c.verified, 1);
  await new Promise((r) => setTimeout(r, 1100));
  ex = (await signedExport(app, operator)).res.json();
  const row = ex.items[0];
  assert.equal(row.verified, true);
  assert.equal(row.contact, "@real_owner");
  assert.equal(row.seats, 2);
  assert.equal(row.createdAt, 1790000000, "the original sign-up time is kept");
});

test("VALIDATOR_WAITLIST_SIGNATURES=optional: unsigned sign-ups are stored unverified (rollout window)", async (t) => {
  const { app } = await setup(operator.address, undefined, { signatures: "optional" });
  t.after(() => app.close());
  const plain = addr();
  const r = await post(app, { address: plain.address, platform: "linux", seats: 1 });
  assert.equal(r.statusCode, 201, r.body);
  // a signed sign-up still verifies, and still claims an unsigned row of its own address
  const claim = await join(app, { address: plain, platform: "both", seats: 3 });
  assert.equal(claim.json().status, "verified");
  const bad = await signed(app, addr(), { platform: "linux", seats: 1 });
  assert.equal((await post(app, { ...bad, address: addr().address })).statusCode, 401, "a wrong signature is refused even when signatures are optional");
  const c = (await app.inject({ method: "GET", url: "/api/validators/waitlist/count" })).json();
  assert.deepEqual([c.total, c.verified], [1, 1]);
});

test("sign-up: at most 5 new addresses per IP per hour; listed addresses and other IPs are unaffected", async (t) => {
  const { app } = await setup(operator.address);
  t.after(() => app.close());
  const ip = "198.51.100.7";
  const listed = addr();
  assert.equal((await join(app, { address: listed, platform: "linux", seats: 1 }, ip)).statusCode, 201);
  const refused = addr();
  for (let i = 0; i < 4; i++) assert.equal((await join(app, { address: addr(), platform: "linux", seats: 1 }, ip)).statusCode, 201);
  const sixthBody = await signed(app, refused, { platform: "linux", seats: 1 });
  const sixth = await post(app, sixthBody, ip);
  assert.equal(sixth.statusCode, 429, sixth.body);
  assert.equal(sixth.json().code, "ip_rate_limited");
  assert.ok(Number(sixth.headers["retry-after"]) > 0);
  // the refused sign-up did not use up its signature: the same body goes through from another network
  assert.equal((await post(app, sixthBody, "198.51.100.9")).statusCode, 201);
  assert.equal((await join(app, { address: listed, platform: "linux", seats: 1 }, ip)).statusCode, 200, "a resubmission is not a new sign-up");
  assert.equal((await join(app, { address: addr(), platform: "windows", seats: 2 }, "198.51.100.8")).statusCode, 201);
  assert.equal((await app.inject({ method: "GET", url: "/api/validators/waitlist/count" })).json().total, 7);
});

test("export: operators only, signed, single-use; JSON and CSV", async (t) => {
  const { app } = await setup(`${operator.address},0x${"1".repeat(40)}`);
  t.after(() => app.close());
  assert.equal((await join(app, { address: addr(), platform: "linux", seats: 2, contact: "=cmd@evil.example.com", consent: true })).statusCode, 201);

  const none = await app.inject({ method: "GET", url: "/api/validators/waitlist/export" });
  assert.equal(none.statusCode, 401);
  assert.doesNotMatch(none.body, /evil/);

  const notOp = await signedExport(app, stranger);
  assert.equal(notOp.res.statusCode, 403);
  assert.equal(notOp.res.json().code, "not_operator");

  const stale = await signedExport(app, operator, { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(stale.res.statusCode, 401);

  const good = await signedExport(app, operator);
  assert.equal(good.res.statusCode, 200, good.res.body);
  const j = good.res.json();
  assert.equal(j.total, 1);
  assert.equal(j.exportedBy, operator.address);
  assert.equal(j.items[0].contact, "=cmd@evil.example.com");
  assert.equal(good.res.headers["cache-control"], "no-store");

  await new Promise((r) => setTimeout(r, 1100)); // past the shared 1 signed request/s per address, so the 409 is the replay guard
  const replay = await app.inject({ method: "GET", url: "/api/validators/waitlist/export", headers: good.headers });
  assert.equal(replay.statusCode, 409, "an export signature works once");

  await new Promise((r) => setTimeout(r, 1100)); // the shared 1 signed request/s per address
  const csv = await signedExport(app, operator, { query: "?format=csv", body: "{}" });
  assert.equal(csv.res.statusCode, 200, csv.res.body);
  assert.match(csv.res.headers["content-type"], /text\/csv/);
  const lines = csv.res.body.trim().split("\n");
  assert.equal(lines[0], "address,platform,seats,contact,contactKind,consent,createdAt,verified,signedAt");
  assert.match(lines[1], /"'=cmd@evil\.example\.com"/, "a formula-looking cell is neutralised");

  await new Promise((r) => setTimeout(r, 1100));
  const typo = await signedExport(app, operator, { query: "?format=xlsx" });
  assert.equal(typo.res.statusCode, 400);
  assert.equal(typo.res.json().code, "bad_format");
  const retry = await app.inject({ method: "GET", url: "/api/validators/waitlist/export", headers: typo.headers });
  assert.equal(retry.statusCode, 200, "a typo in ?format does not spend the signature");
});

test("export: disabled until an operator address is configured (a KB operator is not one)", async (t) => {
  const { app } = await setup("", operator.address);
  t.after(() => app.close());
  const r = await signedExport(app, operator);
  assert.equal(r.res.statusCode, 503);
  assert.equal(r.res.json().code, "disabled");
});

test("openapi documents the four routes and the signature", async (t) => {
  const { app } = await setup(operator.address);
  t.after(() => app.close());
  const spec = (await app.inject({ method: "GET", url: "/api/openapi.json" })).json();
  assert.ok(spec.paths["/api/validators/waitlist"].post);
  assert.deepEqual(spec.paths["/api/validators/waitlist"].post.requestBody.content["application/json"].schema.required, ["address", "platform", "seats", "nonce", "expires", "sig"]);
  assert.ok(spec.paths["/api/validators/waitlist/challenge"].get);
  assert.ok(spec.paths["/api/validators/waitlist/count"].get);
  assert.ok(spec.paths["/api/validators/waitlist/export"].get);
  const llms = (await app.inject({ method: "GET", url: "/api/discovery/llms.txt" })).body;
  assert.match(llms, /\/api\/validators\/waitlist\/count/);
  assert.doesNotMatch(llms, /five authorised signers/);
});
