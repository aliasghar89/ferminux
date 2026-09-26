// fmx.nfts.mint(): the checks it runs before sending (no chain: the collection contract is a stub).
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Ferminux, checkNftId, NFT_MAX_ID } from "../dist/index.js";

function withStub(state) {
  const fmx = new Ferminux({ privateKey: Wallet.createRandom().privateKey });
  const sent = [];
  const nft = {
    price: async () => state.price,
    paused: async () => state.paused,
    minted: async (id) => state.minted.has(id),
    ownerOf: async (id) => { if (!state.minted.has(id)) throw new Error("BadId"); return "0x4660E707371db34E8229A66b1e141053F61b2AD4"; },
    mint: async (id, o) => { sent.push([id, o.value]); return { hash: "0xabc", wait: async () => ({ hash: "0xabc", status: state.status ?? 1 }) }; },
  };
  Object.defineProperty(fmx, "nft", { value: nft });
  return { fmx, sent };
}

test("checkNftId accepts 1..41 only", () => {
  assert.equal(NFT_MAX_ID, 41);
  assert.equal(checkNftId(1), "");
  assert.equal(checkNftId(41), "");
  for (const bad of [0, 42, -1, 1.5, Number.NaN]) assert.match(checkNftId(bad), /ids run 1–41/);
});

test("mint: bad id, paused and taken ids fail before anything is sent", async () => {
  const s = { price: 50n * 10n ** 18n, paused: false, minted: new Set([10, 41]) };
  const { fmx, sent } = withStub(s);
  await assert.rejects(fmx.nfts.mint(0), /ids run 1–41; got 0/);
  await assert.rejects(fmx.nfts.mint(Number("x")), /got NaN/);
  await assert.rejects(fmx.nfts.mint(10), /#10 is already minted \(owner 0x4660/);
  s.paused = true;
  await assert.rejects(fmx.nfts.mint(3), /paused/);
  assert.equal(sent.length, 0);
});

test("mint: sends exactly price() and reports a revert", async () => {
  const s = { price: 60n * 10n ** 18n, paused: false, minted: new Set() };
  const { fmx, sent } = withStub(s);
  const r = await fmx.nfts.mint(3);
  assert.deepEqual(sent, [[3, 60n * 10n ** 18n]]);
  assert.equal(r.tx, "0xabc");
  assert.equal(r.id, 3);
  s.status = 0;
  await assert.rejects(fmx.nfts.mint(4), /mint\(4\) reverted/);
});

test("mint: read-only client still refuses before reading the chain", async () => {
  const fmx = new Ferminux({});
  await assert.rejects(fmx.nfts.mint(99), /ids run 1–41/);
  await assert.rejects(fmx.nfts.mint(3), /read-only/);
});
