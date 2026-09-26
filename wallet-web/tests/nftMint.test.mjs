// Minting Ferminux Agents and Ferminux Citizens from the wallet: the mint
// transaction builder, the one-batch pre-check (id exists, not minted, sale
// open, exact price, balance) and the decision it feeds, against a fake chain
// that answers like the two contracts do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, parseEther } from 'ethers';
import {
  MINT_COLLECTIONS,
  MINT_METHOD,
  artSources,
  buildMintCall,
  collectionArt,
  completePieces,
  encodeMint,
  loadPieces,
  mintCollection,
  mintProblem,
  parseCollection,
  piecePrice,
  readMintPreflight,
  readMintState,
  tierIndex,
  tierName,
} from '../src/lib/nftMint.ts';

const ME = '0xc0A5Eb613f859f072554F29f1Ab7400265af15aB';
const OTHER = '0x7F16433359E4eF704E90cE08460c6238E45130f7';
const ZERO = '0x0000000000000000000000000000000000000000';
const CIT = mintCollection('citizens');
const AGE = mintCollection('agents');
const PRICES = [50n, 100n, 250n, 500n].map((p) => p * 10n ** 18n);

const citizensAbi = new Interface([
  'function mint(uint256) payable',
  'function price(uint256) view returns (uint256)',
  'function priceOfTier(uint256) view returns (uint256)',
  'function tierOf(uint256) view returns (uint8)',
  'function totalIds() view returns (uint256)',
  'function paused() view returns (bool)',
  'function minted(uint256) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function tokensInfo(uint256,uint256) view returns (uint8[],address[])',
]);
const agentsAbi = new Interface([
  'function mint(uint256) payable',
  'function price() view returns (uint256)',
  'function paused() view returns (bool)',
  'function minted(uint256) view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
]);
const revert = (id) => ({ id, error: { code: 3, message: 'execution reverted: custom error 0x…' } });

/**
 * A fake Ferminux Citizens: tiers[i] is id i+1's tier, owners maps id → owner.
 * Every eth_call is decoded and answered like the contract; the balance comes
 * from `balances`. `seen` records each batch.
 */
function citizensChain({ tiers, owners = {}, paused = false, prices = PRICES, balances = {}, seen = [], drop = [] }) {
  return async (calls) => {
    seen.push(calls);
    return calls.flatMap((c) => {
      if (drop.includes(c.id)) return [];
      if (c.method === 'eth_getBalance') return [{ id: c.id, result: '0x' + (balances[c.params[0]] ?? 0n).toString(16) }];
      assert.equal(c.params[0].to.toLowerCase(), CIT.address.toLowerCase(), 'every read goes to the Citizens contract');
      const tx = citizensAbi.parseTransaction({ data: c.params[0].data });
      const n = tiers.length;
      const id = tx.args.length > 0 ? Number(tx.args[0]) : null;
      const exists = id !== null && id >= 1 && id <= n;
      const ok = (fn, v) => ({ id: c.id, result: citizensAbi.encodeFunctionResult(fn, v) });
      switch (tx.name) {
        case 'paused':
          return [ok('paused', [paused])];
        case 'totalIds':
          return [ok('totalIds', [n])];
        case 'priceOfTier':
          return [ok('priceOfTier', [prices[id]])];
        case 'price':
          return [exists ? ok('price', [prices[tiers[id - 1]]]) : revert(c.id)];
        case 'tierOf':
          return [exists ? ok('tierOf', [tiers[id - 1]]) : revert(c.id)];
        case 'minted':
          return [ok('minted', [!!owners[id]])];
        case 'ownerOf':
          return [owners[id] ? ok('ownerOf', [owners[id]]) : revert(c.id)];
        case 'tokensInfo': {
          const to = Math.min(n, Number(tx.args[1] > BigInt(n) ? BigInt(n) : tx.args[1]));
          const ids = Array.from({ length: to }, (_, i) => i + 1);
          return [ok('tokensInfo', [ids.map((i) => tiers[i - 1]), ids.map((i) => owners[i] ?? ZERO)])];
        }
        default:
          throw new Error(`unexpected ${tx.name}`);
      }
    });
  };
}

function agentsChain({ owners = {}, paused = false, price = 50n * 10n ** 18n, balances = {}, seen = [] }) {
  return async (calls) => {
    seen.push(calls);
    return calls.map((c) => {
      if (c.method === 'eth_getBalance') return { id: c.id, result: '0x' + (balances[c.params[0]] ?? 0n).toString(16) };
      const tx = agentsAbi.parseTransaction({ data: c.params[0].data });
      const ok = (fn, v) => ({ id: c.id, result: agentsAbi.encodeFunctionResult(fn, v) });
      const id = tx.args.length > 0 ? Number(tx.args[0]) : null;
      if (tx.name === 'paused') return ok('paused', [paused]);
      if (tx.name === 'price') return ok('price', [price]);
      if (tx.name === 'minted') return ok('minted', [!!owners[id]]);
      if (tx.name === 'ownerOf') return owners[id] ? ok('ownerOf', [owners[id]]) : revert(c.id);
      throw new Error(`unexpected ${tx.name}`);
    });
  };
}

test('the two collections are the deployed Ferminux Agents and Ferminux Citizens on chain 3961', () => {
  assert.equal(AGE.address, '0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd');
  assert.equal(AGE.symbol, 'FMXA');
  assert.equal(AGE.maxId, 41);
  assert.equal(AGE.pricing, 'fixed');
  assert.equal(CIT.address, '0x5672AF1a567a46BAaFeb66959b7A95666E7f4252');
  assert.equal(CIT.symbol, 'FMXC');
  assert.equal(CIT.pricing, 'tier');
  assert.deepEqual(MINT_COLLECTIONS.map((c) => c.key), ['citizens', 'agents']);
  for (const c of MINT_COLLECTIONS) assert.match(c.base, /^https:\/\/ferminux\.net\/nft\//, 'metadata and art come from ferminux.net only (CSP connect-src)');
});

test('encodeMint / buildMintCall: mint(uint256) with exactly the price as value', () => {
  assert.equal(MINT_METHOD, 'mint(uint256)');
  const data = encodeMint(44);
  assert.equal(data.slice(0, 10), '0xa0712d68', 'selector of mint(uint256)');
  assert.equal(BigInt('0x' + data.slice(10)), 44n);
  assert.throws(() => encodeMint(0), /start at 1/);

  const call = buildMintCall(CIT, 44, PRICES[3], 3961);
  assert.deepEqual(call, { chainId: 3961, to: CIT.address, value: parseEther('500'), data });
  assert.equal(agentsAbi.parseTransaction({ data: call.data }).name, 'mint');
  const lower = buildMintCall({ ...AGE, address: AGE.address.toLowerCase() }, 2, parseEther('50'), 3961);
  assert.equal(lower.to, getAddress(AGE.address), 'the contract address is checksummed');
  assert.throws(() => buildMintCall(CIT, 1, 0n, 3961), /no price/);
  // The collections exist on chain 3961 only: no mint is built for any other chain id.
  assert.throws(() => buildMintCall(CIT, 44, PRICES[3], 1), /chain 3961\) only/);
  assert.throws(() => buildMintCall(AGE, 2, parseEther('50'), 31337), /chain 3961\) only/);
});

test('Citizens pre-check: ONE batch — sale flag, count, exact price(id), tier, minted, owner and the balance', async () => {
  const seen = [];
  const tiers = [1, 0, 3, 2, 0];
  const t = citizensChain({ tiers, owners: { 2: OTHER }, balances: { [ME]: parseEther('600') }, seen });
  const pf = await readMintPreflight(t, CIT, 3, ME);
  assert.equal(seen.length, 1, 'one round trip');
  assert.ok(seen[0].some((c) => c.method === 'eth_getBalance' && c.params[0] === ME && c.params[1] === 'latest'));
  assert.deepEqual(pf, { tokenId: 3, exists: true, minted: false, owner: null, paused: false, price: parseEther('500'), tier: 3, totalIds: 5, balance: parseEther('600') });
  assert.equal(mintProblem(CIT, pf, ME), null);
  assert.equal(mintProblem(CIT, pf, ME, { feeWei: parseEther('0.001') }), null);

  const taken = await readMintPreflight(t, CIT, 2, ME);
  assert.equal(taken.minted, true);
  assert.equal(taken.owner, OTHER);
  assert.equal(taken.price, parseEther('50'));
});

test('Citizens pre-check: an id past totalIds() does not exist (its price() reverts) — not a read failure', async () => {
  const t = citizensChain({ tiers: [0, 0], balances: { [ME]: parseEther('1000') } });
  const pf = await readMintPreflight(t, CIT, 3, ME);
  assert.equal(pf.exists, false);
  assert.equal(pf.price, 0n);
  const p = mintProblem(CIT, pf, ME);
  assert.equal(p.code, 'missing');
  assert.match(p.message, /#3 is not on chain yet \(ids run 1–2\)/);
});

test('a pre-check whose reads did not come back throws instead of reading as "available"', async () => {
  const tiers = [0, 0, 0];
  // minted(id) missing
  await assert.rejects(readMintPreflight(citizensChain({ tiers, drop: [5] }), CIT, 1, ME), /did not answer/);
  // the balance missing
  await assert.rejects(readMintPreflight(citizensChain({ tiers, drop: [90] }), CIT, 1, ME), /did not answer/);
  // price(id) missing for an id that exists
  await assert.rejects(readMintPreflight(citizensChain({ tiers, drop: [3] }), CIT, 1, ME), /did not answer/);
  // a node that answers nothing at all
  await assert.rejects(readMintPreflight(async () => [], AGE, 1, ME), /did not answer/);
});

test('Agents pre-check: price() for every id, minted(id) and owner', async () => {
  const seen = [];
  const t = agentsChain({ owners: { 41: OTHER, 7: ME }, balances: { [ME]: parseEther('60') }, seen });
  const pf = await readMintPreflight(t, AGE, 2, ME);
  assert.equal(seen.length, 1);
  assert.deepEqual(pf, { tokenId: 2, exists: true, minted: false, owner: null, paused: false, price: parseEther('50'), tier: null, totalIds: 41, balance: parseEther('60') });
  assert.equal(mintProblem(AGE, pf, ME, { feeWei: parseEther('0.01') }), null);

  assert.equal(mintProblem(AGE, await readMintPreflight(t, AGE, 41, ME), ME).code, 'taken');
  const yours = mintProblem(AGE, await readMintPreflight(t, AGE, 7, ME), ME);
  assert.equal(yours.code, 'yours');
  assert.match(yours.message, /already in this account/);
  const none = await readMintPreflight(t, AGE, 42, ME);
  assert.equal(none.exists, false);
  assert.match(mintProblem(AGE, none, ME).message, /no #42 in Ferminux Agents \(ids run 1–41\)/);
});

test('mintProblem: paused, not for sale, and the race message for an id someone else just took', async () => {
  const base = { tokenId: 5, exists: true, minted: false, owner: null, paused: false, price: parseEther('100'), tier: 1, totalIds: 136, balance: parseEther('1000') };
  assert.equal(mintProblem(CIT, { ...base, paused: true }, ME).code, 'paused');
  const nfs = mintProblem(CIT, { ...base, price: 0n }, ME);
  assert.equal(nfs.code, 'not-for-sale');
  assert.match(nfs.message, /Rare tier is not for sale/);
  const race = mintProblem(CIT, { ...base, minted: true, owner: OTHER }, ME);
  assert.equal(race.code, 'taken');
  assert.match(race.message, /#5 was just minted by someone else/);
  // the owner compare ignores case
  assert.equal(mintProblem(CIT, { ...base, minted: true, owner: ME.toLowerCase() }, ME).code, 'yours');
});

test('mintProblem: the balance must cover price + worst-case fee, and says by how much it falls short', () => {
  const legendary = { tokenId: 44, exists: true, minted: false, owner: null, paused: false, price: parseEther('500'), tier: 3, totalIds: 136, balance: parseEther('60') };
  const early = mintProblem(CIT, legendary, ME);
  assert.equal(early.code, 'funds');
  assert.equal(early.shortWei, parseEther('440'));
  assert.match(early.message, /holds 60 FMX\. Minting #44 needs 500 FMX plus a small network fee/);

  // exactly the price but nothing for gas: refused once the fee is known
  const fee = 123_456_000_000_000n;
  const exact = { ...legendary, balance: parseEther('500') };
  assert.equal(mintProblem(CIT, exact, ME), null, 'before the fee is known, the price alone is covered');
  const withFee = mintProblem(CIT, exact, ME, { feeWei: fee });
  assert.equal(withFee.code, 'funds');
  assert.equal(withFee.shortWei, fee);
  assert.match(withFee.message, /plus up to 0\.000123 FMX network fee/);
  assert.equal(mintProblem(CIT, { ...legendary, balance: parseEther('500') + fee }, ME, { feeWei: fee }), null);
});

test('mintProblem: a price that changed since the confirm screen is refused before signing', () => {
  const pf = { tokenId: 9, exists: true, minted: false, owner: null, paused: false, price: parseEther('250'), tier: 2, totalIds: 136, balance: parseEther('1000') };
  assert.equal(mintProblem(CIT, pf, ME, { expectPrice: parseEther('250') }), null);
  const changed = mintProblem(CIT, pf, ME, { expectPrice: parseEther('100') });
  assert.equal(changed.code, 'price-changed');
  assert.match(changed.message, /changed to 250 FMX/);
});

test('gallery state, Citizens: prices of every tier and every id’s tier and owner in one batch', async () => {
  const seen = [];
  const st = await readMintState(citizensChain({ tiers: [1, 0, 3], owners: { 3: OTHER }, seen }), CIT);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 7, 'paused, totalIds, four tier prices, tokensInfo');
  assert.deepEqual(st.prices, PRICES);
  assert.equal(st.totalIds, 3);
  assert.deepEqual([...st.statuses], [
    [1, { minted: false, owner: null, tier: 1 }],
    [2, { minted: false, owner: null, tier: 0 }],
    [3, { minted: true, owner: OTHER, tier: 3 }],
  ]);
  // the live tier wins over the metadata's (unminted ids can be re-tiered on chain)
  assert.equal(piecePrice(CIT, st, { id: 1, tier: 'Common' }), PRICES[1]);
  assert.equal(piecePrice(CIT, st, { id: 3, tier: 'Common' }), PRICES[3]);
  assert.equal(piecePrice(CIT, null, { id: 1, tier: 'Common' }), null);
});

test('gallery state, Agents: ownerOf 1..41 in the same batch; a revert is unminted, no answer is unknown', async () => {
  const seen = [];
  const inner = agentsChain({ owners: { 1: OTHER, 41: OTHER }, seen });
  const t = async (calls) => (await inner(calls)).filter((r) => r.id !== 10 + 4); // id 5 unanswered
  const st = await readMintState(t, AGE);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 43);
  assert.deepEqual(st.prices, [parseEther('50')]);
  assert.deepEqual(st.statuses.get(1), { minted: true, owner: OTHER });
  assert.deepEqual(st.statuses.get(2), { minted: false, owner: null });
  assert.equal(st.statuses.has(5), false);
  assert.equal(piecePrice(AGE, st, { id: 2, tier: null }), parseEther('50'));
  await assert.rejects(readMintState(async () => [], AGE), /did not answer the sale check/);
});

test('collection.json: Agents files (no id, a Number trait) and Citizens files (id + Tier) parse to one piece per id', () => {
  const agents = parseCollection([
    { name: 'NEXUS #1', image: 'https://ferminux.net/nft/agents/images/1.png', attributes: [{ trait_type: 'Number', value: 1 }, { trait_type: 'Set', value: 'Genesis 40' }] },
    { name: 'J1 #41', image: 'https://ferminux.net/nft/agents/images/41.png', attributes: [{ trait_type: 'Number', value: 41 }, { trait_type: 'Set', value: 'Legendary' }] },
  ]);
  assert.deepEqual(agents.map((p) => [p.id, p.set, p.tier]), [[1, 'Genesis 40', null], [41, 'Legendary', null]]);
  const cit = parseCollection([
    { id: 3, name: 'Star Admiral #3', attributes: [{ trait_type: 'Tier', value: 'Legendary' }, { trait_type: 'Series', value: 'Citizens' }] },
    { id: 1, name: 'Sakura Bloom #1', attributes: [{ trait_type: 'Tier', value: 'rare' }] },
    { id: 1, name: 'duplicate' },
  ]);
  assert.deepEqual(cit.map((p) => [p.id, p.name, p.tier]), [[1, 'Sakura Bloom #1', 'Rare'], [3, 'Star Admiral #3', 'Legendary']]);
  assert.throws(() => parseCollection([]), /empty/);
  assert.throws(() => parseCollection({}), /not a list/);
  assert.equal(tierIndex('LEGENDARY'), 3);
  assert.equal(tierName(9), null);
});

test('metadata: collection.json from the collection base, missing ids from meta/<id>.json, ids past totalIds dropped', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith('/collection.json')) return { ok: true, json: async () => [1, 2, 4].map((id) => ({ id, name: `C #${id}`, attributes: [{ trait_type: 'Tier', value: 'Common' }] })) };
    const id = Number(/meta\/(\d+)\.json$/.exec(url)[1]);
    return id === 5 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ name: `Late #${id}`, attributes: [{ trait_type: 'Tier', value: 'Epic' }] }) };
  };
  const listed = await loadPieces(CIT, { fetchImpl });
  assert.equal(asked[0], 'https://ferminux.net/nft/citizens/collection.json');
  assert.deepEqual(listed.map((p) => p.id), [1, 2, 4]);
  const done = await completePieces(CIT, listed, 5, { fetchImpl });
  assert.ok(asked.includes('https://ferminux.net/nft/citizens/meta/3.json'));
  assert.deepEqual(done.map((p) => [p.id, p.tier]), [[1, 'Common'], [2, 'Common'], [3, 'Epic'], [4, 'Common']], '#5 has no file yet: not listed');
  const fewer = await completePieces(CIT, listed, 2, { fetchImpl });
  assert.deepEqual(fewer.map((p) => p.id), [1, 2], 'a batch not yet on chain is not for sale');
});

test('artwork: AVIF and WebP copies at 256/512 px for the collections’ own files, nothing for other images', () => {
  const s = artSources('https://ferminux.net/nft/citizens/images/44.jpg', CIT.base, 44, 'jpg');
  assert.deepEqual(s, {
    avif: 'https://ferminux.net/nft/citizens/images/44-256.avif 256w, https://ferminux.net/nft/citizens/images/44-512.avif 512w',
    webp: 'https://ferminux.net/nft/citizens/images/44-256.webp 256w, https://ferminux.net/nft/citizens/images/44-512.webp 512w',
    src: 'https://ferminux.net/nft/citizens/images/44.jpg',
  });
  assert.equal(artSources(null, AGE.base, 2, 'png').src, 'https://ferminux.net/nft/agents/images/2.png', 'no image in the metadata: the collection file');
  assert.equal(artSources('https://example.com/2.png', AGE.base, 2, 'png'), null);
  assert.equal(collectionArt('https://ferminux.net/nft/agents/images/41.png').avif.split(', ')[0], 'https://ferminux.net/nft/agents/images/41-256.avif 256w');
  assert.equal(collectionArt('https://ferminux.net/nft/agents/images/41.jpg'), null);
  assert.equal(collectionArt('https://evil.example/nft/agents/images/41.png'), null);
  assert.equal(collectionArt(null), null);
});
