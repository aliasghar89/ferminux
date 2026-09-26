// fmx.citizens (Ferminux Citizens, FMXC): list/get/price/tier over a stubbed contract, the mint pre-checks
// (nothing is sent when the contract would revert or the wallet is short), and the MCP tools. No chain, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Wallet, parseEther } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ferminux, CITIZEN_TIERS, CITIZENS_ABI, checkCitizenId, citizenTierIndex, citizenTierName, NETWORKS } from "../dist/index.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const HOLDER = "0x4660E707371db34E8229A66b1e141053F61b2AD4";

/** A FerminuxCitizens stand-in: ids 1..total, tiers per id, prices per tier, owners, a balance for the key. */
function withStub(state) {
  const fmx = new Ferminux({ privateKey: state.readOnly ? undefined : Wallet.createRandom().privateKey });
  const sent = [];
  const reads = [];
  const owner = (id) => state.owners[id] ?? ZERO;
  const c = {
    totalIds: async () => (reads.push("totalIds"), BigInt(state.total)),
    paused: async () => (reads.push("paused"), state.paused),
    priceOfTier: async (t) => state.prices[Number(t)],
    tierOf: async (id) => { if (id < 1 || id > state.total) throw new Error("BadId"); return BigInt(state.tiers[id] ?? 0); },
    price: async (id) => { if (id < 1 || id > state.total) throw new Error("BadId"); return state.prices[state.tiers[id] ?? 0]; },
    minted: async (id) => owner(id) !== ZERO,
    ownerOf: async (id) => { if (owner(id) === ZERO) throw new Error("BadId"); return owner(id); },
    tokenURI: async (id) => `https://ferminux.net/nft/citizens/meta/${id}.json`,
    tokensInfo: async (from, to) => {
      reads.push(`tokensInfo(${from},${to})`);
      const ids = Array.from({ length: Number(to) - Number(from) + 1 }, (_, i) => Number(from) + i);
      return [ids.map((id) => BigInt(state.tiers[id] ?? 0)), ids.map(owner)];
    },
    mint: async (id, o) => {
      sent.push([id, o.value]);
      return {
        hash: "0xabc",
        wait: async () => {
          // what ethers v6 does with a reverted transaction: wait() throws CALL_EXCEPTION carrying the receipt
          if (state.status === 0 && state.throwOnRevert) throw Object.assign(new Error("transaction execution reverted"), { code: "CALL_EXCEPTION", receipt: { hash: "0xdef", status: 0 } });
          return { hash: "0xabc", status: state.status ?? 1 };
        },
      };
    },
  };
  Object.defineProperty(fmx.citizens, "contract", { value: c });
  Object.defineProperty(fmx, "provider", { value: { getBalance: async () => state.balance ?? parseEther("1000") } });
  return { fmx, sent, reads };
}

const META = [
  { id: 1, name: "Sakura Bloom #1", image: "https://ferminux.net/nft/citizens/images/1.jpg", attributes: [{ trait_type: "Tier", value: "Rare" }, { trait_type: "Series", value: "Citizens" }] },
  { id: 2, name: "Neon Fox #2", image: "https://ferminux.net/nft/citizens/images/2.jpg", attributes: [{ trait_type: "Tier", value: "Common" }, { trait_type: "Series", value: "Crew" }] },
];
function stubFetch(t) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("/nft/citizens/collection.json")) return new Response(JSON.stringify(META), { status: 200 });
    if (/\/nft\/citizens\/meta\/\d+\.json$/.test(String(url))) return new Response(JSON.stringify(META[0]), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  t.after(() => { globalThis.fetch = real; });
  return urls;
}

const base = () => ({
  total: 5,
  paused: false,
  prices: [parseEther("50"), parseEther("100"), parseEther("250"), 0n], // Legendary not for sale here
  tiers: { 1: 1, 2: 0, 3: 2, 4: 3, 5: 1 },
  owners: { 3: HOLDER },
});

test("helpers: tiers and id checks", () => {
  assert.deepEqual([...CITIZEN_TIERS], ["Common", "Rare", "Epic", "Legendary"]);
  assert.equal(citizenTierName(2), "Epic");
  assert.equal(citizenTierName(4), null);
  assert.equal(citizenTierIndex(" legendary "), 3);
  assert.equal(citizenTierIndex("mythic"), -1);
  assert.equal(checkCitizenId(1), "");
  assert.equal(checkCitizenId(136, 136), "");
  assert.match(checkCitizenId(0), /start at 1; got 0/);
  assert.match(checkCitizenId(1.5), /start at 1/);
  assert.match(checkCitizenId(137, 136), /run 1–136 today/);
  assert.ok(CITIZENS_ABI.some((f) => f.startsWith("function tokensInfo(")));
  assert.ok(CITIZENS_ABI.includes("function price(uint256 tokenId) view returns (uint256)"));
});

test("the deployed collection is the default address", () => {
  assert.equal(NETWORKS[3961].citizens, "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252");
  const fmx = new Ferminux({});
  assert.equal(fmx.citizens.address, "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252");
  assert.equal(new Ferminux({ citizens: "0x0000000000000000000000000000000000000001" }).citizensAddress, "0x0000000000000000000000000000000000000001");
  assert.throws(() => new Ferminux({ citizens: ZERO }).citizens.contract, /no contract address/);
});

test("list: one tokensInfo call for the range, live tiers and prices, metadata joined, filters", async (t) => {
  const urls = stubFetch(t);
  const { fmx, reads } = withStub(base());
  const all = await fmx.citizens.list();
  assert.equal(all.length, 5);
  assert.ok(reads.includes("tokensInfo(1,5)"));
  assert.deepEqual(urls, ["https://ferminux.net/nft/citizens/collection.json"]);
  assert.deepEqual(all[0], { id: 1, name: "Sakura Bloom #1", tier: "Rare", tierIndex: 1, series: "Citizens", priceWei: parseEther("100").toString(), priceFmx: "100.0", forSale: true, minted: false, owner: null, image: "https://ferminux.net/nft/citizens/images/1.jpg", url: "https://ferminux.net/nfts/citizens/?id=1" });
  assert.equal(all[2].owner, HOLDER);
  assert.equal(all[4].name, "Citizen #5", "an id without metadata still lists");
  assert.equal(all[4].image, "https://ferminux.net/nft/citizens/images/5.jpg");

  const rare = await fmx.citizens.list({ tier: "rare" });
  assert.deepEqual(rare.map((c) => c.id), [1, 5]);
  const open = await fmx.citizens.list({ available: true });
  assert.deepEqual(open.map((c) => c.id), [1, 2, 5], "minted #3 and not-for-sale Legendary #4 are left out");
  assert.deepEqual((await fmx.citizens.list({ from: 4, to: 99 })).map((c) => c.id), [4, 5], "the range is clamped to totalIds");
  await assert.rejects(fmx.citizens.list({ tier: "Mythic" }), /tiers are Common, Rare, Epic, Legendary/);

  const tiers = await fmx.citizens.tierPrices();
  assert.deepEqual(tiers.map((x) => [x.tier, x.priceFmx, x.forSale]), [["Common", "50.0", true], ["Rare", "100.0", true], ["Epic", "250.0", true], ["Legendary", "0.0", false]]);
});

test("get / price / tier", async (t) => {
  stubFetch(t);
  const { fmx } = withStub(base());
  const g = await fmx.citizens.get(3);
  assert.equal(g.tier, "Epic");
  assert.equal(g.priceFmx, "250.0");
  assert.equal(g.owner, HOLDER);
  assert.equal(g.tokenURI, "https://ferminux.net/nft/citizens/meta/3.json");
  assert.equal((await fmx.citizens.get(1)).tokenURI, null, "no tokenURI before the mint");
  assert.equal(await fmx.citizens.price(1), parseEther("100"));
  assert.deepEqual(await fmx.citizens.tier(4), { tierIndex: 3, tier: "Legendary" });
  await assert.rejects(fmx.citizens.get(6), /run 1–5 today/);
  await assert.rejects(fmx.citizens.price(0), /start at 1/);
});

test("mint: every sure revert, and a short balance, fail before anything is sent", async () => {
  const s = base();
  const { fmx, sent } = withStub(s);
  await assert.rejects(fmx.citizens.mint(0), /start at 1; got 0/);
  await assert.rejects(fmx.citizens.mint(Number("x")), /got NaN/);
  await assert.rejects(fmx.citizens.mint(6), /run 1–5 today/);
  await assert.rejects(fmx.citizens.mint(3), /#3 is already minted \(owner 0x4660/);
  await assert.rejects(fmx.citizens.mint(4), /#4 is Legendary, and that tier is not for sale/);
  s.balance = parseEther("99.9");
  await assert.rejects(fmx.citizens.mint(1), /costs 100\.0 FMX plus gas; 0x[0-9a-fA-F]{40} holds 99\.9 FMX/);
  s.balance = undefined;
  s.paused = true;
  await assert.rejects(fmx.citizens.mint(1), /paused/);
  assert.equal(sent.length, 0);
});

test("mint: sends exactly the tier price and reports a lost race as a revert with its hash", async () => {
  const s = base();
  const { fmx, sent } = withStub(s);
  const r = await fmx.citizens.mint(3 - 1); // #2, Common
  assert.deepEqual(sent, [[2, parseEther("50")]]);
  assert.equal(r.tx, "0xabc");
  assert.equal(r.tier, "Common");
  assert.equal(r.paidFmx, "50.0");
  assert.equal(r.owner, fmx.address);
  s.status = 0;
  await assert.rejects(fmx.citizens.mint(5), /mint\(5\) reverted \(0xabc\); another wallet may have minted it/);
  s.throwOnRevert = true;
  await assert.rejects(fmx.citizens.mint(5), /mint\(5\) reverted \(0xdef\); another wallet may have minted it/);
});

test("mint: a read-only client refuses a bad id without the chain, and any id without a key", async () => {
  const { fmx, reads } = withStub({ ...base(), readOnly: true });
  await assert.rejects(fmx.citizens.mint(0), /start at 1/);
  await assert.rejects(fmx.citizens.mint(2), /read-only/);
  assert.deepEqual(reads, [], "nothing was read for a mint that could not be signed");
});

test("MCP: the three Citizens tools are served, and minting without a key is a JSON error, not a crash", async (t) => {
  const env = { ...process.env };
  delete env.FERMINUX_PRIVATE_KEY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/mcp.js", import.meta.url))], env, stderr: "ignore" });
  const client = new Client({ name: "citizens-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((x) => [x.name, x]));
  for (const name of ["fmx_nft_list", "fmx_nft_mint", "fmx_citizens_list", "fmx_citizen_get", "fmx_citizen_mint"]) assert.ok(byName.has(name), name);
  assert.deepEqual(Object.keys(byName.get("fmx_citizens_list").inputSchema.properties).sort(), ["available", "from", "tier", "to"]);
  assert.deepEqual(byName.get("fmx_citizens_list").inputSchema.properties.tier.enum, ["Common", "Rare", "Epic", "Legendary"]);
  assert.deepEqual(byName.get("fmx_citizen_mint").inputSchema.required, ["id"]);
  assert.match(byName.get("fmx_citizen_mint").description, /Checks first/);
  const r = await client.callTool({ name: "fmx_citizen_mint", arguments: { id: 5 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /read-only/);

  // the server's self-description follows the copy rules
  const instructions = client.getInstructions() ?? "";
  assert.doesNotMatch(instructions, /five authorised|unchanged|\bmin(ed|ing|er)\b/i);
  assert.match(instructions, /set of authorised signers/);
  assert.match(instructions, /Paris target \(no PUSH0\)/);
});
