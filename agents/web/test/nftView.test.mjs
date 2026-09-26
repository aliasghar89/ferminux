// src/nftView.ts under plain Node (the module has no imports). Run: npm test -w web — needs Node 22.18+ / 23.6+,
// which import .ts by stripping types (CI builds web on Node 20 and does not run this).
import test from "node:test";
import assert from "node:assert/strict";
import { artSources, citizensQuery, inCitizensFilter, inFilter, ownerLabel, parseCitizensFilter, pickShowcase, shortAddr, tierIndex, tierName, TIERS } from "../src/nftView.ts";

const TREASURY = "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB";
const GOV = "0x910BD467D8576277f8f96DF47428377FFD94fEfe";
const TOOLBOX_OWNER = "0x4660E707371db34E8229A66b1e141053F61b2AD4";
const book = {
  treasury: TREASURY,
  governance: GOV,
  agents: [
    { id: 7, name: "Later", owner: TOOLBOX_OWNER },
    { id: 1, name: "Toolbox", owner: TOOLBOX_OWNER },
    { id: 2, name: "Scribe", owner: "0x6beE9D8F7f4B701d54dE273138F6994183707DD9" },
  ],
  wallets: [
    { account: "0x4C53CFD7820B2bd806D9Fc3671AC474ee532FC13", owner: "0x6beE9D8F7f4B701d54dE273138F6994183707DD9" },
    { account: "0x1111111111111111111111111111111111111111", owner: "0x2222222222222222222222222222222222222222" },
  ],
};

test("ownerLabel names the treasury, governance, agents and agent wallets", () => {
  assert.deepEqual(ownerLabel(TREASURY.toLowerCase(), book), { name: "Ferminux treasury", kind: "treasury" });
  assert.deepEqual(ownerLabel(GOV, book), { name: "Ferminux governance", kind: "governance" });
  // several agents on one owner: the first registered (lowest id) names the address, case-insensitively
  assert.deepEqual(ownerLabel(TOOLBOX_OWNER.toUpperCase().replace("0X", "0x"), book), { name: "Toolbox", kind: "agent", agentId: 1 });
  assert.deepEqual(ownerLabel("0x4c53cfd7820b2bd806d9fc3671ac474ee532fc13", book), { name: "Scribe wallet", kind: "agent-wallet", agentId: 2 });
  assert.deepEqual(ownerLabel("0x1111111111111111111111111111111111111111", book), { name: "Agent wallet", kind: "agent-wallet" });
});

test("ownerLabel: the connected wallet is 'You', a stranger is the short address", () => {
  assert.deepEqual(ownerLabel(TOOLBOX_OWNER, book, TOOLBOX_OWNER.toLowerCase()), { name: "You", kind: "you" });
  assert.deepEqual(ownerLabel(TREASURY, book, TREASURY), { name: "You", kind: "you" });
  const x = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";
  assert.deepEqual(ownerLabel(x, book, null), { name: "0x8Ba1…BA72", kind: "address" });
  assert.deepEqual(ownerLabel(x, { treasury: TREASURY, agents: [], wallets: [] }), { name: "0x8Ba1…BA72", kind: "address" });
  assert.equal(shortAddr("0xabc"), "0xabc");
});

test("ownerLabel: a self-chosen agent name cannot pose as You or the treasury", () => {
  const x = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";
  const b = (name) => ({ treasury: TREASURY, agents: [{ id: 9, name, owner: x }], wallets: [{ account: "0x3333333333333333333333333333333333333333", owner: x }] });
  for (const n of ["You", "  ferminux treasury ", "Ferminux governance", "Ferminux", ""]) {
    assert.deepEqual(ownerLabel(x, b(n)), { name: "Agent #9", kind: "agent", agentId: 9 });
  }
  assert.equal(ownerLabel("0x3333333333333333333333333333333333333333", b("You")).name, "Agent #9 wallet");
  assert.equal(ownerLabel(x, b("Youthful")).name, "Youthful");
});

test("inFilter: unknown status counts as available, never as minted", () => {
  const minted = { minted: true }, free = { minted: false };
  assert.deepEqual(["all", "available", "minted"].map((f) => inFilter(f, minted)), [true, false, true]);
  assert.deepEqual(["all", "available", "minted"].map((f) => inFilter(f, free)), [true, true, false]);
  assert.deepEqual(["all", "available", "minted"].map((f) => inFilter(f, undefined)), [true, true, false]);
});

test("artSources: AVIF and WebP at 256/512 beside the canonical PNG", () => {
  const s = artSources("https://ferminux.net/nft/agents", 10);
  assert.equal(s.png, "https://ferminux.net/nft/agents/images/10.png");
  assert.equal(s.avif, "https://ferminux.net/nft/agents/images/10-256.avif 256w, https://ferminux.net/nft/agents/images/10-512.avif 512w");
  assert.equal(s.webp, "https://ferminux.net/nft/agents/images/10-256.webp 256w, https://ferminux.net/nft/agents/images/10-512.webp 512w");
});

test("artSources: Citizens use the full-size JPEG as the canonical file", () => {
  const s = artSources("https://ferminux.net/nft/citizens", 7, "jpg");
  assert.equal(s.png, "https://ferminux.net/nft/citizens/images/7.jpg");
  assert.equal(s.webp, "https://ferminux.net/nft/citizens/images/7-256.webp 256w, https://ferminux.net/nft/citizens/images/7-512.webp 512w");
});

test("tiers: index and name follow the contract's order", () => {
  assert.deepEqual([...TIERS], ["Common", "Rare", "Epic", "Legendary"]);
  assert.equal(tierIndex("legendary"), 3);
  assert.equal(tierIndex("Mythic"), -1);
  assert.equal(tierName(1), "Rare");
  assert.equal(tierName(4), null);
  assert.equal(tierName(undefined), null);
});

test("Citizens filters round-trip through the query string and ignore junk", () => {
  const series = ["Citizens", "Crew", "Guardians"];
  assert.deepEqual(parseCitizensFilter("?filter=available&tier=epic&series=crew", series), { avail: "available", tier: "Epic", series: "Crew" });
  assert.deepEqual(parseCitizensFilter("?filter=sold&tier=Mythic&series=Nope", series), { avail: "all", tier: "all", series: "all" });
  assert.equal(citizensQuery({ avail: "minted", tier: "Rare", series: "all" }), "?filter=minted&tier=Rare");
  assert.equal(citizensQuery({ avail: "all", tier: "all", series: "all" }), "");
  const f = parseCitizensFilter(citizensQuery({ avail: "available", tier: "Legendary", series: "Guardians" }), series);
  assert.deepEqual(f, { avail: "available", tier: "Legendary", series: "Guardians" });
});

test("inCitizensFilter combines availability, tier and series", () => {
  const f = { avail: "available", tier: "Rare", series: "Crew" };
  assert.equal(inCitizensFilter(f, { tier: "Rare", series: "Crew" }, { minted: false }), true);
  assert.equal(inCitizensFilter(f, { tier: "Rare", series: "Crew" }, { minted: true }), false);
  assert.equal(inCitizensFilter(f, { tier: "Epic", series: "Crew" }, undefined), false);
  assert.equal(inCitizensFilter(f, { tier: "Rare", series: "Guardians" }, undefined), false);
  assert.equal(inCitizensFilter({ avail: "all", tier: "all", series: "all" }, { tier: null, series: "" }, { minted: true }), true);
});

test("pickShowcase: Legendary and Epic only, unminted first in showcase order, a Legendary leads", () => {
  const items = [
    { id: 1, tier: 1, minted: false }, { id: 2, tier: 2, minted: false }, { id: 3, tier: 3, minted: true },
    { id: 7, tier: 2, minted: false }, { id: 8, tier: 3, minted: false }, { id: 9, tier: 0, minted: false },
    { id: 20, tier: 3, minted: false }, { id: 26, tier: 2, minted: true },
  ];
  // showcase lists 3 (minted) first: it drops behind every unminted pick; 2 (Epic) is next in the list but a Legendary leads
  assert.deepEqual(pickShowcase(items, [3, 2, 8, 26, 7], 9), [8, 2, 7, 20, 3, 26]);
  assert.deepEqual(pickShowcase(items, [3, 2, 8, 26, 7], 3), [8, 2, 7]);
  assert.deepEqual(pickShowcase(items, [], 4), [8, 20, 2, 7], "no showcase: Legendary then Epic, by id");
  assert.deepEqual(pickShowcase([{ id: 5, tier: 2, minted: false }], [5], 9), [5], "no Legendary left: an Epic leads");
});
