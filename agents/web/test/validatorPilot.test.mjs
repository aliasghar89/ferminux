// src/validatorPilot.ts under plain Node: where the hub comes from, the seat proof the validator app prints (both
// its formats, wrapped by a console, and every way it can be wrong), a seat's state in words, the downloads'
// checksums, and the constants and ABI fragments against the contracts' own source. scripts/validators-e2e.mjs
// checks the same fragments against a fresh compile and runs the page against a deployed pilot on a fork.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SigningKey, Wallet, keccak256, toUtf8Bytes } from "ethers";
import {
  ACTIVATION_DELAY, CHAIN_ID, CHECKPOINT_INTERVAL, ELIGIBILITY_DELAY, ENODE_TAG, HUB_ABI, HUB_NAME, HUB_VERSION, JAIL_WINDOW, LENS_ABI,
  MIN_ELIGIBLE_FOR_CERT, PACKAGES, REVERT_TEXT, SEAT_DEPOSIT_WEI, UNBONDING_PERIOD, UNJAIL_DELAY,
  attesterKeyDigest, checkSeatProof, enodeDigest, hubIface, lensIface, parseSeatProof, parseSha256Sums, pickHub, revertName, seatPhase, toSeatAccess,
} from "../src/validatorPilot.ts";

const src = (p) => readFileSync(new URL(`../../contracts/src/validators/${p}`, import.meta.url), "utf8");
const HUB = "0x00000000000000000000000000000000000b0b01"; // a made-up hub: these proofs work for no real contract
const key = (label) => new SigningKey(keccak256(toUtf8Bytes(`validators-page-unit/${label}`)));
const addrOf = (k) => new Wallet(k.privateKey).address;
const OWNER = addrOf(key("owner")), OTHER = addrOf(key("other"));

/** A seat proof made the way fmx-validator makes it, printed in its text layout (seatproof.go) or as --json. */
function makeProof(owner, { hub = HUB, chainId = CHAIN_ID, label = "a" } = {}) {
  const att = key(`attester-${label}`), node = key(`node-${label}`);
  const attester = addrOf(att);
  const p = {
    hub, chainId, owner, attester,
    attesterSig: att.sign(attesterKeyDigest(hub, owner, attester, chainId)).serialized,
    enodePubkey: `0x${node.publicKey.slice(4)}`,
    enodeSig: node.sign(enodeDigest(hub, owner, attester, chainId)).serialized,
  };
  p.calldata = hubIface.encodeFunctionData("openSeat", [p.attester, p.attesterSig, p.enodePubkey, p.enodeSig]);
  const json = JSON.stringify({ ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : v])), value: "2000 FMX (2000000000000000000000 wei)", access: { inviteOnly: true, invited: true, denied: false, seatsPaused: false, occupiedSeats: 0, maxSeats: 20, reason: "" }, accessNote: `${owner} is invited to the pilot; 0 of 20 seats are taken.` }, null, 2);
  const text = `Checked on the hub: ${owner} is invited to
the pilot; 0 of 20 seats are taken.

Open a seat from the owner wallet ${owner}:

  to        ${hub}  (ValidatorHub, chain ${chainId})
  value     exactly 2,000 FMX
  data      ${p.calldata}

or call openSeat(attester, attesterSig, enodePubkey, enodeSig) with:

  attester     ${attester}
  attesterSig  ${p.attesterSig}
  enodePubkey  ${p.enodePubkey}
  enodeSig     ${p.enodeSig}

These proofs only work for this owner, this hub and this chain. The seat
activates about 24 hours after the deposit and counts toward certification
after 7 days. This machine never needs the owner wallet's key.
`;
  return { p, json, text };
}
const wrap = (t, n = 80) => t.split("\n").map((l) => l.match(new RegExp(`.{1,${n}}`, "g"))?.join("\n") ?? "").join("\n");
const ctx = { hub: HUB, owner: OWNER };

test("pickHub: env, then the record for chain 3961, else none; 'off' forces none", () => {
  const rec = { chainId: 3961, validatorHub: "0xf77cb4075e8e73e81414687823554b76ad294409", validatorHubLens: "0x6d70fa65595e1baf3b82d1cd9312240f79bcea9e", deployBlock: 419268 };
  assert.deepEqual(pickHub({}, rec), { hub: "0xf77cB4075E8e73e81414687823554B76aD294409", lens: "0x6D70Fa65595E1Baf3b82d1CD9312240f79bCeA9E", deployBlock: 419268, source: "record" });
  assert.equal(pickHub({}, { ...rec, chainId: 39610 }), null, "a lab record never turns the page on");
  assert.equal(pickHub({}, { ...rec, validatorHubLens: "0x12" }), null);
  assert.equal(pickHub({}, null), null);
  assert.equal(pickHub({ hub: "off" }, rec), null);
  const e = pickHub({ hub: HUB, lens: OTHER, deployBlock: "7" }, rec);
  assert.equal(e.source, "env"); assert.equal(e.deployBlock, 7); assert.equal(e.lens, OTHER);
  assert.equal(pickHub({ hub: HUB }, rec).source, "record", "the env needs both addresses");
});

test("parseSeatProof + checkSeatProof: the text and --json outputs, also wrapped by a console", () => {
  const { p, json, text } = makeProof(OWNER);
  for (const [name, t] of [["text", text], ["json", json], ["text wrapped at 80", wrap(text)], ["json wrapped at 64", wrap(json, 64)], ["text with CRLF", text.replace(/\n/g, "\r\n")]]) {
    const r = parseSeatProof(t);
    assert.ok(r.ok, `${name}: ${r.error}`);
    assert.equal(r.proof.attester, p.attester, name);
    assert.equal(r.proof.hub?.toLowerCase(), HUB.toLowerCase(), name);
    assert.equal(r.proof.owner, OWNER, name);
    assert.equal(r.proof.chainId, CHAIN_ID, name);
    const c = checkSeatProof(r.proof, ctx);
    assert.ok(c.ok, `${name}: ${c.error}`);
    assert.equal(c.checked.attester, p.attester);
    assert.equal(c.checked.enodePubkey, p.enodePubkey.toLowerCase());
  }
  // "Checked on the hub: <owner>" is not the hub
  assert.equal(parseSeatProof(text).proof.hub.toLowerCase(), HUB.toLowerCase());
});

test("parseSeatProof: only the calldata, only an address, or a cut paste", () => {
  const { p, text } = makeProof(OWNER);
  const cd = parseSeatProof(`data ${p.calldata}`);
  assert.ok(cd.ok); assert.equal(cd.proof.attester, p.attester); assert.equal(cd.proof.enodeSig, p.enodeSig.toLowerCase());
  assert.ok(checkSeatProof(cd.proof, ctx).ok, "a bare calldata paste still checks (no hub or owner named)");
  assert.match(parseSeatProof(p.attester).error, /only an address/);
  assert.match(parseSeatProof(text.slice(0, text.indexOf("attesterSig  0x") + 40).replace(/data {6}0x[0-9a-f]+/i, "")).error, /missing: .*attesterSig/);
  assert.match(parseSeatProof("").error, /Paste/);
});

test("checkSeatProof: another wallet, another hub, another chain, the owner as attester, a changed signature", () => {
  const mine = parseSeatProof(makeProof(OWNER).json).proof;
  assert.match(checkSeatProof(mine, { hub: HUB, owner: OTHER }).error, /made for the wallet .* connected wallet is/);
  const otherHub = "0x00000000000000000000000000000000000b0b02";
  assert.match(checkSeatProof(mine, { hub: otherHub, owner: OWNER }).error, /made for the contract .* init --hub/);
  assert.match(checkSeatProof(parseSeatProof(makeProof(OWNER, { chainId: 39610 }).json).proof, ctx).error, /chain 39610/);
  // no names in the paste (calldata only): a proof for another owner fails on its signature instead
  const bare = parseSeatProof(`data ${makeProof(OTHER).p.calldata}`).proof;
  assert.match(checkSeatProof(bare, ctx).error, /attester signature does not match/);
  const selfie = { ...mine, attester: OWNER };
  assert.match(checkSeatProof(selfie, ctx).error, /same as the wallet/);
  const flip = (h) => `${h.slice(0, 20)}${h[20] === "0" ? "1" : "0"}${h.slice(21)}`;
  assert.match(checkSeatProof({ ...mine, attesterSig: flip(mine.attesterSig) }, ctx).error, /attester signature/);
  assert.match(checkSeatProof({ ...mine, enodeSig: flip(mine.enodeSig) }, ctx).error, /node signature/);
  const other = makeProof(OWNER, { label: "b" }).p;
  assert.match(checkSeatProof({ ...mine, enodePubkey: other.enodePubkey.toLowerCase() }, ctx).error, /node signature/);
});

test("seat access and hub errors in words", () => {
  assert.deepEqual(toSeatAccess([3n, true, false, false, false, 4n, 20n]), { reason: "not-invited", allowlistOnly: true, allowlisted: false, denied: false, seatsPaused: false, occupied: 4, max: 20 });
  assert.equal(toSeatAccess([4n, true, true, false, false, 20n, 20n]).reason, "full");
  assert.equal(toSeatAccess([0n, false, false, false, false, 1n, 20n]).reason, "open");
  for (const e of ["NotAllowlisted", "SeatsFull", "Denied", "WrongDeposit", "KeyUsed", "BadPossession", "Paused"]) {
    assert.equal(revertName(hubIface.encodeErrorResult(e, [])), e);
    assert.ok(REVERT_TEXT[e], e);
  }
  assert.equal(revertName("0x12345678"), null);
  assert.equal(revertName(undefined), null);
});

test("seatPhase: every state a seat can be in", () => {
  const base = { id: 3, claimable: 0n, lastAttestedCp: 0, activationBlock: 500_000, countedSince: 0, status: 1, jailed: false, owner: OWNER, unjailBlock: 0, unbondEndBlock: 0, slashState: 0, attester: OTHER, deposit: SEAT_DEPOSIT_WEI };
  const at = (s, head) => seatPhase({ ...base, ...s }, head);
  assert.equal(at({}, 500_000 - ACTIVATION_DELAY).key, "starting");
  assert.match(at({}, 500_000 - ACTIVATION_DELAY).detail, /block 500,000, in about 24 hours/);
  assert.equal(at({}, 500_100).key, "active");
  assert.equal(at({}, 501_000).key, "silent");
  const att = at({ lastAttestedCp: 2505 }, 501_100);
  assert.equal(att.key, "attesting");
  assert.match(att.detail, /block 501,000/);
  assert.match(att.detail, new RegExp(`from block ${(500_000 + ELIGIBILITY_DELAY).toLocaleString("en-US")}`));
  assert.match(at({ lastAttestedCp: 3000, countedSince: 586_400 }, 600_100).detail, /Counted toward certification since block 586,400/);
  assert.equal(at({ jailed: true, unjailBlock: 520_000 }, 510_000).key, "paused");
  assert.match(at({ jailed: true, unjailBlock: 520_000 }, 520_001).detail, /can resume it now/);
  assert.equal(at({ status: 2, unbondEndBlock: 700_000 }, 600_000).key, "leaving");
  assert.equal(at({ status: 2, unbondEndBlock: 700_000 }, 700_000).key, "withdrawable");
  assert.equal(at({ status: 2, unbondEndBlock: 700_000, slashState: 1 }, 700_000).key, "leaving", "a pending slash blocks the withdrawal");
  assert.equal(at({ status: 3 }, 800_000).key, "closed");
  assert.equal(at({ status: 0 }, 1).key, "none");
});

test("parseSha256Sums: sha256sum text and binary mode", () => {
  const h = "ab".repeat(32);
  const m = parseSha256Sums(`${h}  ${PACKAGES[0].file}\n${h.toUpperCase()} *${PACKAGES[1].file}\r\nnot a line\n`);
  assert.equal(m.get(PACKAGES[0].file), h);
  assert.equal(m.get(PACKAGES[1].file), h);
  assert.equal(m.size, 2);
});

test("constants and names match ValidatorHub.sol", () => {
  const hub = src("ValidatorHub.sol").replace(/_/g, "");
  const num = (name) => Number(new RegExp(`constant ${name} = ([0-9]+)`).exec(hub)?.[1]);
  assert.match(hub, /constant SEATDEPOSIT = 2000 ether/);
  assert.equal(SEAT_DEPOSIT_WEI, 2000n * 10n ** 18n);
  for (const [n, v] of [["ACTIVATIONDELAY", ACTIVATION_DELAY], ["ELIGIBILITYDELAY", ELIGIBILITY_DELAY], ["UNBONDINGPERIOD", UNBONDING_PERIOD], ["UNJAILDELAY", UNJAIL_DELAY],
    ["CHECKPOINTINTERVAL", CHECKPOINT_INTERVAL], ["JAILWINDOW", JAIL_WINDOW], ["MINELIGIBLEFORCERT", MIN_ELIGIBLE_FOR_CERT]]) assert.equal(num(n), v, n);
  const raw = src("ValidatorHub.sol");
  assert.ok(raw.includes(`NAME = "${HUB_NAME}"`) && raw.includes(`VERSION = "${HUB_VERSION}"`));
  assert.ok(raw.includes('keccak256("AttesterKey(address owner,address attester)")'));
  assert.ok(raw.includes(`abi.encodePacked("${ENODE_TAG}", block.chainid, address(this), seatOwner, attester)`));
  // every function, event and error the page uses is declared in the hub
  for (const f of hubIface.fragments) {
    const decl = f.type === "function" ? new RegExp(`function ${f.name}\\(|public[^;]* ${f.name};`) : new RegExp(`${f.type} ${f.name}\\(`);
    assert.match(raw, decl, `${f.type} ${f.name}`);
  }
});

test("the lens's tuples keep the contracts' field order (ABI tuples are positional)", () => {
  const fields = (text, struct) => [...new RegExp(`struct ${struct} \\{([\\s\\S]*?)\\n    \\}`).exec(text)[1].matchAll(/^\s*(?:u?int\d+|bool|address|bytes32)\s+(\w+);/gm)].map((m) => m[1]);
  const lensSrc = src("ValidatorHubLens.sol");
  assert.deepEqual(lensIface.getFunction("seat").outputs[0].components.map((c) => c.name), fields(src("ValidatorHub.sol"), "Seat"));
  assert.deepEqual(lensIface.getFunction("seatAccess").outputs[0].components.map((c) => c.name), fields(lensSrc, "SeatAccess"));
  for (const f of lensIface.fragments) assert.match(lensSrc, new RegExp(`function ${f.name}\\(`), f.name);
  assert.equal(HUB_ABI.length > 10 && LENS_ABI.length === 3, true);
});

test("the page's copy keeps the naming rules", () => {
  const web = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const text = [web("validators/index.html").replace(/<!--[\s\S]*?-->/g, ""), web("src/pages/validators.ts"), web("src/validatorPilot.ts"), web("src/validatorForm.ts")].join("\n");
  assert.doesNotMatch(text, /\bERC-?\d/i);
  assert.doesNotMatch(text, /\bmin(ing|er|ers|ed)\b/i);
  assert.doesNotMatch(text, /proof[- ]of[- ]stake/i);
  assert.doesNotMatch(text, /Ethereum/);
  assert.match(web("validators/index.html"), /Pilot: invite-only, up to 20 seats, 2,000 FMX each; opening to everyone after an external audit\./);
});
