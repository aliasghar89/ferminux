// FRC-721 discovery on Ferminux: on-chain ownership is the authority, metadata
// from tokenURI (with the explorer's cached copy as fallback), images loaded
// automatically only from first-party hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, encodeBase64, toUtf8Bytes } from 'ethers';
import {
  KNOWN_COLLECTIONS,
  activeCollections,
  encodeNftTransfer,
  fetchTokenMetadata,
  filterOwned,
  metadataFromJson,
  parseExplorerNfts,
  planImage,
  readTokenUris,
  resolveTokenUri,
  scanCollection,
} from '../src/lib/nft.ts';

const HOLDER = '0xc0A5Eb613f859f072554F29f1Ab7400265af15aB';
const OTHER = '0x7F16433359E4eF704E90cE08460c6238E45130f7';
const AGENTS = KNOWN_COLLECTIONS[0];
const iface = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
]);
const coder = AbiCoder.defaultAbiCoder();

/** Fake chain: ownerOf from a table (unminted ids revert like FerminuxAgents' BadId()). */
function nftTransport(owners, uris = {}, seen = []) {
  return async (calls) => {
    seen.push(calls);
    return calls.map((c) => {
      const tx = iface.parseTransaction({ data: c.params[0].data });
      const id = tx.args[0].toString();
      if (tx.name === 'ownerOf') {
        return owners[id] ? { id: c.id, result: coder.encode(['address'], [owners[id]]) } : { id: c.id, error: { code: 3, message: 'execution reverted' } };
      }
      return uris[id] ? { id: c.id, result: iface.encodeFunctionResult('tokenURI', [uris[id]]) } : { id: c.id, error: { code: 3, message: 'execution reverted' } };
    });
  };
}

test('the Ferminux Agents collection is known: 41 ids, scanned in ONE batch', async () => {
  assert.equal(AGENTS.address, '0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd');
  assert.equal(AGENTS.maxId, 41);
  const seen = [];
  const owned = await scanCollection(nftTransport({ 10: OTHER, 41: HOLDER, 7: HOLDER.toLowerCase() }, {}, seen), AGENTS, HOLDER);
  assert.deepEqual(owned, ['7', '41']);
  assert.equal(seen.length, 1, 'one round trip');
  assert.equal(seen[0].length, 41);
});

test('filterOwned: an endpoint that answers no id at all is an error, not an empty holding', async () => {
  const errorObject = async () => [{ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limited' } }];
  await assert.rejects(filterOwned(errorObject, AGENTS.address, ['1', '2'], HOLDER), /did not answer/);
  await assert.rejects(scanCollection(async () => [], AGENTS, HOLDER), /did not answer/);
});

test('filterOwned re-checks explorer-reported ids: stale index entries are dropped', async () => {
  const owned = await filterOwned(nftTransport({ 1: HOLDER, 2: OTHER }), AGENTS.address, ['1', '2', '3'], HOLDER);
  assert.deepEqual(owned, ['1']);
  assert.deepEqual(await filterOwned(nftTransport({}), AGENTS.address, [], HOLDER), []);
});

test('tokenURI batch read', async () => {
  const uris = await readTokenUris(nftTransport({}, { 41: 'https://ferminux.net/nft/agents/meta/41.json' }), AGENTS.address, ['41', '40']);
  assert.deepEqual([...uris], [['41', 'https://ferminux.net/nft/agents/meta/41.json']]);
});

test('resolveTokenUri: data: JSON decoded locally (plain and base64); https fetched; ipfs and http refused', () => {
  const json = { name: 'On-chain #1', image: 'data:image/svg+xml;base64,PHN2Zy8+' };
  const b64 = 'data:application/json;base64,' + encodeBase64(toUtf8Bytes(JSON.stringify(json)));
  assert.deepEqual(resolveTokenUri(b64), { kind: 'inline', json });
  assert.deepEqual(resolveTokenUri('data:application/json,' + encodeURIComponent(JSON.stringify(json))), { kind: 'inline', json });
  assert.equal(resolveTokenUri('data:application/json;base64,!!!').kind, 'unsupported');
  assert.deepEqual(resolveTokenUri('https://ferminux.net/nft/agents/meta/1.json'), { kind: 'https', url: 'https://ferminux.net/nft/agents/meta/1.json' });
  assert.equal(resolveTokenUri('ipfs://bafy/1.json').kind, 'unsupported');
  assert.equal(resolveTokenUri('http://plain.example/1.json').kind, 'unsupported');
});

test('metadata normalisation: name/description/image/attributes, hostile text cleaned, never throws', () => {
  const m = metadataFromJson({
    name: `J1 ${String.fromCharCode(0x202e)}#41`,
    description: 'x'.repeat(1000),
    image: 'https://ferminux.net/nft/agents/images/41.png',
    attributes: [{ trait_type: 'Archetype', value: 'J1' }, { trait_type: 'Number', value: 41 }, { junk: true }],
  });
  assert.equal(m.name, 'J1 #41');
  assert.ok(m.description.length <= 401);
  assert.deepEqual(m.attributes, [
    { trait: 'Archetype', value: 'J1' },
    { trait: 'Number', value: '41' },
  ]);
  assert.deepEqual(metadataFromJson(null), { name: null, description: null, image: null, attributes: [] });
  assert.deepEqual(metadataFromJson('str').attributes, []);
});

test('fetchTokenMetadata: fetches https, times out, and surfaces a non-200', async () => {
  const ok = async (url) => ({ ok: true, json: async () => ({ name: `from ${url}` }) });
  assert.equal((await fetchTokenMetadata('https://ferminux.net/m.json', { fetchImpl: ok })).name, 'from https://ferminux.net/m.json');
  const bad = async () => ({ ok: false, status: 404 });
  await assert.rejects(fetchTokenMetadata('https://ferminux.net/m.json', { fetchImpl: bad }), /404/);
  const hang = (_url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(fetchTokenMetadata('https://ferminux.net/m.json', { fetchImpl: hang, timeoutMs: 30 }), /aborted/);
  await assert.rejects(fetchTokenMetadata('ipfs://x'), /IPFS/);
});

test('explorer list: parsed from the real Blockscout v2 shape, non-721 and junk skipped, deduplicated', () => {
  const item = {
    id: '41',
    image_url: 'https://ferminux.net/nft/agents/images/41.png',
    metadata: { name: 'J1 #41', image: 'https://ferminux.net/nft/agents/images/41.png', attributes: [{ trait_type: 'Edition', value: '1/1' }] },
    token: { address_hash: '0x84fe97c49ffe4227d9ea139b5998c097d9c06ddd', name: 'Ferminux Agents', symbol: 'FMXA', type: 'ERC-721' },
  };
  const parsed = parseExplorerNfts({
    items: [item, item, { ...item, token: { ...item.token, type: 'ERC-1155' } }, { id: 'x', token: item.token }, null],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].contract, AGENTS.address);
  assert.equal(parsed[0].tokenId, '41');
  assert.equal(parsed[0].collection, 'Ferminux Agents');
  assert.equal(parsed[0].metadata.name, 'J1 #41');
  assert.deepEqual(parseExplorerNfts({}), []);
});

test('planImage: first-party and data: images load on their own; other hosts wait for a click; http refused', () => {
  const trusted = ['ferminux.net'];
  assert.deepEqual(planImage('https://ferminux.net/nft/agents/images/1.png', trusted), {
    url: 'https://ferminux.net/nft/agents/images/1.png',
    host: 'ferminux.net',
    autoload: true,
  });
  assert.equal(planImage('https://cdn.ferminux.net/x.png', trusted).autoload, true);
  assert.equal(planImage('https://evilferminux.net/x.png', trusted).autoload, false);
  assert.equal(planImage('https://tracker.example/pixel.png', trusted).autoload, false);
  assert.equal(planImage('data:image/png;base64,iVBORw0KGgo=', trusted).autoload, true);
  assert.equal(planImage('data:text/html,<script>', trusted), null);
  assert.equal(planImage('http://ferminux.net/x.png', trusted), null);
  assert.equal(planImage(null, trusted), null);
});

test('send encodes safeTransferFrom(from, to, id) — the variant that refuses a contract that cannot hold it', () => {
  const data = encodeNftTransfer(HOLDER, OTHER, '41');
  assert.equal(data.slice(0, 10), '0x42842e0e');
  const parsed = iface.parseTransaction({ data });
  assert.equal(parsed.args[0], HOLDER);
  assert.equal(parsed.args[1], OTHER);
  assert.equal(parsed.args[2], 41n);
});

test('Ferminux Citizens is configured but skipped until it has an address', () => {
  const cit = KNOWN_COLLECTIONS.find((c) => c.symbol === 'FMXC');
  assert.ok(cit, 'FMXC is in the config list');
  assert.equal(cit.scan, 'tokensInfo');
  assert.deepEqual(activeCollections().map((c) => c.symbol), cit.address ? ['FMXA', 'FMXC'] : ['FMXA']);
  assert.deepEqual(activeCollections([{ ...cit, address: '0x' + '11'.repeat(20) }]).map((c) => c.symbol), ['FMXC']);
});

test('a growing collection is scanned with ONE tokensInfo call covering every id', async () => {
  const cit = { address: '0x' + '22'.repeat(20), name: 'Ferminux Citizens', symbol: 'FMXC', scan: 'tokensInfo', maxId: 0 };
  const info = new Interface(['function tokensInfo(uint256 fromId, uint256 toId) view returns (uint8[] tiers, address[] owners)']);
  const ZERO = '0x0000000000000000000000000000000000000000';
  const seen = [];
  const transport = async (calls) => {
    seen.push(calls);
    const tx = info.parseTransaction({ data: calls[0].params[0].data });
    assert.equal(tx.args[0], 1n);
    assert.equal(tx.args[1], (1n << 256n) - 1n, 'toId past the end: the contract clamps it to totalIds()');
    return [{ id: 1, result: info.encodeFunctionResult('tokensInfo', [[0, 3, 1, 2], [HOLDER, ZERO, OTHER, HOLDER.toLowerCase()]]) }];
  };
  assert.deepEqual(await scanCollection(transport, cit, HOLDER), ['1', '4']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 1);
  await assert.rejects(scanCollection(async () => [], cit, HOLDER), /did not answer/);
  await assert.rejects(scanCollection(async () => [{ id: 1, error: { code: 3, message: 'execution reverted' } }], cit, HOLDER), /ownership read failed/);
});
