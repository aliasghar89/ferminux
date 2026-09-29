// src/multicall.ts under plain Node against a fake Multicall3 that decodes aggregate3 and answers each read with the
// compiled Ferminux Agents / Citizens ABIs. Run: npm test -w web (Node 22.18+ / 23.6+ strips the types).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Interface, getAddress } from "ethers";
import { CHUNK, MULTICALL3, MULTICALL3_ABI, mintStatuses, multicall, multicallValues } from "../src/multicall.ts";

const abi = (n) => JSON.parse(readFileSync(new URL(`../../contracts/abi/${n}.json`, import.meta.url), "utf8"));
const AGENTS = new Interface(abi("FerminuxAgents"));
const CITIZENS = new Interface(abi("FerminuxCitizens"));
const MC = new Interface(MULTICALL3_ABI);
const NFT = "0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd";
const CIT = "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252";
const TREASURY = "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB";
const ALICE = "0x8ba1f109551bd432803012645ac136ddd64dba72";

class Revert extends Error {}
/** A fake node: eth_call to MULTICALL3 runs each sub-call against `contracts` (address → {iface, fns}); a handler
 *  that throws Revert is a reverting call, a target with no entry is an address without code (success, empty data). */
function fakeChain(contracts, { raw } = {}) {
  const calls = [];
  const caller = {
    async call(tx) {
      calls.push(tx);
      if (raw) return raw(tx);
      assert.equal(tx.to, MULTICALL3);
      const [reads] = MC.decodeFunctionData("aggregate3", tx.data);
      const out = reads.map(([target, allowFailure, data]) => {
        assert.equal(allowFailure, true, "every read allows failure");
        const c = contracts[target.toLowerCase()];
        if (!c) return [true, "0x"];
        const p = c.iface.parseTransaction({ data });
        try { return [true, c.iface.encodeFunctionResult(p.name, c.fns[p.name](...p.args))]; }
        catch (e) { if (e instanceof Revert) return [false, "0x"]; throw e; }
      });
      return MC.encodeFunctionResult("aggregate3", [out]);
    },
  };
  return { caller, calls };
}

const owners = new Map([[3, ALICE], [17, ALICE], [41, TREASURY]]);
const agents = {
  iface: AGENTS,
  fns: {
    minted: (id) => [owners.has(Number(id))],
    ownerOf: (id) => { const o = owners.get(Number(id)); if (!o) throw new Revert(); return [o]; },
    price: () => [50n * 10n ** 18n],
    paused: () => [false],
    totalSupply: () => [BigInt(owners.size)],
  },
};

test("mintStatuses: 41 ids in one eth_call; ownerOf's revert on a free id does not fail the batch", async () => {
  const { caller, calls } = fakeChain({ [NFT.toLowerCase()]: agents });
  const ids = Array.from({ length: 41 }, (_, i) => i + 1);
  const st = await mintStatuses(caller, NFT, AGENTS, ids);
  assert.equal(calls.length, 1);
  assert.equal(MC.decodeFunctionData("aggregate3", calls[0].data)[0].length, 82);
  assert.deepEqual(st.filter((s) => s.minted).map((s) => s.id), [3, 17, 41]);
  assert.deepEqual(st[2], { id: 3, minted: true, owner: getAddress(ALICE) });
  assert.deepEqual(st[40], { id: 41, minted: true, owner: TREASURY });
  assert.deepEqual(st[0], { id: 1, minted: false, owner: null });
  assert.deepEqual(st.map((s) => s.id), ids, "order kept");
});

test("mintStatuses keeps the caller's id order (the home strip passes a shuffled list)", async () => {
  const { caller } = fakeChain({ [NFT.toLowerCase()]: agents });
  const st = await mintStatuses(caller, NFT, AGENTS, [41, 5, 3]);
  assert.deepEqual(st.map((s) => [s.id, s.minted]), [[41, true], [5, false], [3, true]]);
});

test("multicallValues: the Agents facts and the Citizens facts, each in one eth_call", async () => {
  const citizens = {
    iface: CITIZENS,
    fns: { paused: () => [true], totalSupply: () => [4n], totalIds: () => [136n], priceOfTier: (t) => [[50n, 100n, 250n, 500n][Number(t)] * 10n ** 18n] },
  };
  const { caller, calls } = fakeChain({ [NFT.toLowerCase()]: agents, [CIT.toLowerCase()]: citizens });
  const a = await multicallValues(caller, ["price", "paused", "totalSupply"].map((fn) => ({ target: NFT, iface: AGENTS, fn })));
  assert.deepEqual(a, [50n * 10n ** 18n, false, 3n]);
  const r = (fn, args = []) => ({ target: CIT, iface: CITIZENS, fn, args });
  const c = await multicallValues(caller, [r("paused"), r("totalSupply"), r("totalIds"), ...[0, 1, 2, 3].map((t) => r("priceOfTier", [t]))]);
  assert.deepEqual(c, [true, 4n, 136n, 50n * 10n ** 18n, 100n * 10n ** 18n, 250n * 10n ** 18n, 500n * 10n ** 18n]);
  assert.equal(calls.length, 2);
});

test("a read that reverts or returns nothing is null; the strict helpers throw so the caller falls back", async () => {
  const broken = { iface: AGENTS, fns: { ...agents.fns, minted: (id) => { if (Number(id) === 2) throw new Revert(); return agents.fns.minted(id); } } };
  const { caller } = fakeChain({ [NFT.toLowerCase()]: broken });
  const out = await multicall(caller, [1, 2].map((id) => ({ target: NFT, iface: AGENTS, fn: "minted", args: [id] })));
  assert.equal(out[0][0], false);
  assert.equal(out[1], null);
  await assert.rejects(mintStatuses(caller, NFT, AGENTS, [1, 2]), /minted\(2\)/);
  // an address with no code answers success with empty data: that does not decode, so it is a failure too
  const nowhere = "0x000000000000000000000000000000000000dEaD";
  assert.deepEqual(await multicall(caller, [{ target: nowhere, iface: AGENTS, fn: "price" }]), [null]);
  await assert.rejects(multicallValues(caller, [{ target: nowhere, iface: AGENTS, fn: "price" }]), /price\(\) failed/);
});

test("the multicall itself failing rejects: no Multicall3 at the address, an RPC error, a short answer", async () => {
  const reads = [1, 2, 3].map((id) => ({ target: NFT, iface: AGENTS, fn: "minted", args: [id] }));
  await assert.rejects(multicall(fakeChain({}, { raw: async () => "0x" }).caller, reads));
  await assert.rejects(multicall(fakeChain({}, { raw: async () => { throw new Error("rate limited"); } }).caller, reads), /rate limited/);
  const short = MC.encodeFunctionResult("aggregate3", [[[true, AGENTS.encodeFunctionResult("minted", [true])]]]);
  await assert.rejects(multicall(fakeChain({}, { raw: async () => short }).caller, reads), /1 results for 3 reads/);
  await assert.rejects(mintStatuses(fakeChain({}, { raw: async () => "0x" }).caller, NFT, AGENTS, [1]));
});

test("large lists split into parallel aggregate3 calls of CHUNK reads, results in order", async () => {
  const { caller, calls } = fakeChain({ [NFT.toLowerCase()]: agents });
  const ids = Array.from({ length: 300 }, (_, i) => i + 1);
  const st = await mintStatuses(caller, NFT, AGENTS, ids);
  assert.equal(calls.length, Math.ceil((ids.length * 2) / CHUNK));
  assert.deepEqual(st.map((s) => s.id), ids);
  assert.deepEqual(st.filter((s) => s.minted).map((s) => s.id), [3, 17, 41]);
  assert.deepEqual(await multicall(caller, []), []);
});
