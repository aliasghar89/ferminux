// Multi-chain balance reads: one request per chain, Multicall3 where deployed,
// a plain JSON-RPC batch where not, the chain id checked in the same request,
// endpoint fallback, and a per-chain error that never touches other chains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, getAddress } from 'ethers';
import {
  assetKey,
  balanceFor,
  buildPortfolio,
  chainAssets,
  decodeMulticallBalances,
  decodeUint,
  encodeMulticallBalances,
  readChainBalances,
} from '../src/lib/portfolio.ts';
import { CHAINS, FERMINUX_CHAIN, MULTICALL3_ADDRESS, chainById } from '../src/lib/chains.ts';

const HOLDER = '0x7F16433359E4eF704E90cE08460c6238E45130f7';
const BSC = chainById(56);
const coder = AbiCoder.defaultAbiCoder();
const mc = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const word = (n) => coder.encode(['uint256'], [n]);
const CUSTOM = { chainId: 56, address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE', name: 'PancakeSwap Token', decimals: 18 };

/** A fake Multicall3 chain: answers eth_chainId and aggregate3 from a table. */
function multicallTransport(chainIdHex, values, seen = []) {
  return () => async (calls) => {
    seen.push(calls);
    return calls.map((c) => {
      if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: chainIdHex };
      assert.equal(c.method, 'eth_call');
      assert.equal(c.params[0].to, MULTICALL3_ADDRESS);
      const [inner] = mc.decodeFunctionData('aggregate3', c.params[0].data);
      const rows = inner.map((_, i) => (values[i] === null ? [false, '0x'] : [true, word(values[i])]));
      return { jsonrpc: '2.0', id: c.id, result: mc.encodeFunctionResult('aggregate3', [rows]) };
    });
  };
}

test('chainAssets: native first, listed tokens, then custom ones for that chain only, deduplicated', () => {
  const dupe = { ...CUSTOM, address: BSC.tokens[0].address.toLowerCase(), symbol: 'FAKE' };
  const other = { ...CUSTOM, chainId: 1 };
  const assets = chainAssets(BSC, [CUSTOM, dupe, other]);
  assert.deepEqual(assets.map((a) => a.symbol), ['BNB', 'USDC', 'USDT', 'CAKE']);
  assert.equal(assets[0].address, null);
  assert.deepEqual(assets.map((a) => a.source), ['native', 'listed', 'listed', 'custom']);
  const home = chainAssets(FERMINUX_CHAIN, []);
  assert.equal(home[0].symbol, 'FMX');
  assert.ok(home.some((a) => a.symbol === 'USDF'));
});

test('encode/decode: aggregate3 carries getEthBalance for native and balanceOf per token', () => {
  const assets = chainAssets(BSC, []);
  const data = encodeMulticallBalances(HOLDER, assets);
  const [calls] = mc.decodeFunctionData('aggregate3', data);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].target, MULTICALL3_ADDRESS);
  assert.equal(calls[0].callData.slice(0, 10), mc.getFunction('getEthBalance').selector);
  assert.equal(calls[1].target, getAddress(BSC.tokens[0].address));
  assert.equal(calls[1].callData.slice(0, 10), '0x70a08231');
  for (const c of calls) assert.equal(c.allowFailure, true);

  const result = mc.encodeFunctionResult('aggregate3', [[[true, word(5n)], [false, '0x'], [true, '0x']]]);
  assert.deepEqual(decodeMulticallBalances(result, 3), [5n, null, null], 'a failed call and an empty return are both "no answer"');
  assert.equal(decodeUint('0x'), null);
  assert.equal(decodeUint(word(2n ** 255n)), 2n ** 255n);
});

test('multicall chain: ONE request carrying eth_chainId + one eth_call, exact 256-bit values', async () => {
  const seen = [];
  const big = 2n ** 200n + 7n;
  const assets = chainAssets(BSC, [CUSTOM]);
  const r = await readChainBalances(BSC, HOLDER, assets, { transportFor: multicallTransport('0x38', [big, 0n, 12n, null], seen) });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1, 'one HTTP request for the whole chain');
  assert.deepEqual(seen[0].map((c) => c.method), ['eth_chainId', 'eth_call']);
  assert.equal(r.balances.get(assetKey(56, null)), big);
  assert.equal(r.balances.get(assetKey(56, BSC.tokens[0].address)), 0n);
  assert.equal(r.balances.get(assetKey(56, BSC.tokens[1].address)), 12n);
  assert.deepEqual(r.failed, [assetKey(56, CUSTOM.address)]);
  assert.equal(r.rpcUrl, BSC.rpcUrls[0]);
});

test('no-multicall chain (Ferminux): one JSON-RPC batch of eth_getBalance + balanceOf calls, matched by id', async () => {
  const assets = chainAssets(FERMINUX_CHAIN, []);
  const seen = [];
  const transportFor = () => async (calls) => {
    seen.push(calls);
    // Answer out of order: matching must be by id.
    return [...calls].reverse().map((c) => {
      if (c.method === 'eth_chainId') return { id: c.id, result: '0xf79' };
      if (c.method === 'eth_getBalance') {
        assert.equal(c.params[0], HOLDER);
        return { id: c.id, result: '0xde0b6b3a7640000' };
      }
      assert.equal(c.params[0].data.slice(0, 10), '0x70a08231');
      return c.id === 3 ? { id: c.id, error: { code: -32000, message: 'execution reverted' } } : { id: c.id, result: word(BigInt(c.id)) };
    });
  };
  const r = await readChainBalances(FERMINUX_CHAIN, HOLDER, assets, { transportFor });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, assets.length + 1);
  assert.equal(r.balances.get(assetKey(3961, null)), 10n ** 18n);
  assert.equal(r.balances.get(assetKey(3961, assets[1].address)), undefined);
  assert.deepEqual(r.failed, [assetKey(3961, assets[1].address)]);
  assert.equal(r.balances.get(assetKey(3961, assets[2].address)), 4n);
});

test('an endpoint answering for the wrong chain is refused and the next endpoint is tried', async () => {
  const urls = [];
  const transportFor = (url) => {
    urls.push(url);
    return url === BSC.rpcUrls[0]
      ? multicallTransport('0x1', [1n, 1n, 1n])()
      : multicallTransport('0x38', [2n, 3n, 4n])();
  };
  const r = await readChainBalances(BSC, HOLDER, chainAssets(BSC, []), { transportFor });
  assert.equal(r.ok, true);
  assert.deepEqual(urls, BSC.rpcUrls);
  assert.equal(r.rpcUrl, BSC.rpcUrls[1]);
  assert.equal(r.balances.get(assetKey(56, null)), 2n);
});

test('every endpoint failing gives ok:false with the reason — never a throw', async () => {
  const transportFor = () => async () => {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  const r = await readChainBalances(BSC, HOLDER, chainAssets(BSC, []), { transportFor, now: () => 42 });
  assert.deepEqual(r, { chainId: 56, ok: false, error: 'timed out', at: 42 });

  const wrong = await readChainBalances(BSC, HOLDER, chainAssets(BSC, []), { transportFor: multicallTransport('0x89', [1n, 1n, 1n]) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /answered for chain 137, not 56/);
});

test('chains are independent: one hanging chain does not delay or poison the others', async () => {
  const slow = chainById(1);
  const fast = chainById(56);
  const transportFor = (url, timeoutMs) =>
    url.includes('ethereum') || url.includes('eth.drpc')
      ? () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), timeoutMs))
      : multicallTransport('0x38', [9n, 0n, 0n])();
  const started = Date.now();
  const [a, b] = await Promise.all([
    readChainBalances(slow, HOLDER, chainAssets(slow, []), { transportFor, timeoutMs: 60 }),
    readChainBalances(fast, HOLDER, chainAssets(fast, []), { transportFor, timeoutMs: 60 }),
  ]);
  assert.equal(a.ok, false);
  assert.equal(a.error, 'timed out');
  assert.equal(b.ok, true);
  assert.ok(Date.now() - started < 1000);
});

test('buildPortfolio: zero balances hidden by default (custom tokens always shown), per-chain filter, stale on failure', () => {
  const bscAssets = chainAssets(BSC, [CUSTOM]);
  const eth = chainById(1);
  const ethAssets = chainAssets(eth, []);
  const assetsByChain = new Map([
    [56, bscAssets],
    [1, ethAssets],
  ]);
  const good = {
    chainId: 56,
    ok: true,
    balances: new Map([
      [assetKey(56, null), 5n],
      [assetKey(56, bscAssets[1].address), 0n],
      [assetKey(56, bscAssets[2].address), 0n],
      [assetKey(56, CUSTOM.address), 0n],
    ]),
    failed: [],
    rpcUrl: 'x',
    at: 1000,
  };
  const latest = new Map([
    [56, { chainId: 56, ok: false, error: 'timed out', at: 2000 }],
  ]);
  const lastGood = new Map([[56, good]]);
  const chains = [BSC, eth];

  const hidden = buildPortfolio(chains, assetsByChain, latest, lastGood, { hideZero: true, chainId: null });
  assert.equal(hidden.length, 2);
  const [g56, g1] = hidden;
  assert.equal(g56.status, 'error');
  assert.equal(g56.stale, true, 'failed refresh keeps the last good values, flagged');
  assert.equal(g56.error, 'timed out');
  assert.deepEqual(g56.rows.map((r) => r.asset.symbol), ['BNB', 'CAKE']);
  assert.equal(g56.hiddenZero, 2);
  assert.equal(g1.status, 'loading');
  assert.equal(g1.rows.length, 3, 'unknown balances are never hidden');
  assert.ok(g1.rows.every((r) => r.balance === null));

  const shown = buildPortfolio(chains, assetsByChain, latest, lastGood, { hideZero: false, chainId: 56 });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].rows.length, 4);
  assert.equal(shown[0].hiddenZero, 0);

  assert.equal(balanceFor(lastGood, 56, null), 5n);
  assert.equal(balanceFor(lastGood, 56, CUSTOM.address.toLowerCase()), 0n);
  assert.equal(balanceFor(lastGood, 1, null), null);
});

test('every supported chain produces a group', () => {
  const groups = buildPortfolio(CHAINS, new Map(), new Map(), new Map(), { hideZero: true, chainId: null });
  assert.equal(groups.length, 8);
});
