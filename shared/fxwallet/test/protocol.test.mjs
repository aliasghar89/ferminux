// Protocol parsing, the chain registry and the icon.
// Run: node --test shared/fxwallet/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PROTOCOL, parseDappMessage, parseWalletMessage, READ_METHODS, POPUP_METHODS } from '../protocol.ts';
import { CHAIN_META, CHAIN_RPC_URLS, KNOWN_CHAIN_IDS, parseChainId } from '../chains.ts';
import { FERMINUX_WALLET_ICON } from '../icon.ts';
import { toRpcError, fromRpcError } from '../errors.ts';
import { legacyWalletName } from '../discovery.ts';
import { safeIcon } from '../connector.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('dApp messages: only well-formed requests survive', () => {
  const ok = { protocol: PROTOCOL, type: 'request', id: 'abc123', method: 'personal_sign', params: ['0x00'], chainId: 3961, appName: 'x'.repeat(200) };
  const parsed = parseDappMessage(ok);
  assert.equal(parsed.method, 'personal_sign');
  assert.equal(parsed.appName.length, 60, 'appName is display text and is capped');
  assert.equal(parseDappMessage({ ...ok, protocol: 'other' }), null);
  assert.equal(parseDappMessage({ ...ok, id: 'has space' }), null);
  assert.equal(parseDappMessage({ ...ok, chainId: '3961' }), null);
  assert.equal(parseDappMessage({ ...ok, method: '' }), null);
  assert.equal(parseDappMessage('string'), null);
  assert.equal(parseDappMessage(null), null);
  assert.deepEqual(parseDappMessage({ protocol: PROTOCOL, type: 'status', junk: 1 }), { protocol: PROTOCOL, type: 'status' });
});

test('wallet messages: responses carry either a result or a well-formed error', () => {
  assert.deepEqual(parseWalletMessage({ protocol: PROTOCOL, type: 'response', id: 'a1', result: ['0x1'] }), {
    protocol: PROTOCOL,
    type: 'response',
    id: 'a1',
    result: ['0x1'],
  });
  const err = parseWalletMessage({ protocol: PROTOCOL, type: 'response', id: 'a1', error: { code: 4001, message: 'no' } });
  assert.deepEqual(err.error, { code: 4001, message: 'no' });
  assert.equal(parseWalletMessage({ protocol: PROTOCOL, type: 'response', id: 'a1', error: { code: 'x' } }), null);
  const st = parseWalletMessage({ protocol: PROTOCOL, type: 'status', authoritative: 1, approved: true, accounts: ['0x' + '1'.repeat(40), 'junk'] });
  assert.equal(st.authoritative, false, 'only a literal true is authoritative');
  assert.deepEqual(st.accounts, ['0x' + '1'.repeat(40)]);
  assert.equal(parseWalletMessage({ protocol: PROTOCOL, type: 'unknown' }), null);
});

test('no method is both read-only and wallet-routed', () => {
  for (const m of POPUP_METHODS) assert.equal(READ_METHODS.has(m), false, m);
  for (const m of ['eth_sign', 'eth_signTransaction', 'eth_accounts', 'personal_sign']) assert.equal(READ_METHODS.has(m), false, m);
});

test('the chain registry matches the pay-in chains of the gateway', () => {
  const payin = readFileSync(`${root}agents/gateway/src/v3/payin.ts`, 'utf8');
  const ids = [...payin.matchAll(/^    chainId: (\d+), name: "([^"]+)"/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.equal(ids.length, 7);
  for (const [id, name] of ids) {
    assert.ok(KNOWN_CHAIN_IDS.includes(id), `chain ${id} known`);
    assert.equal(CHAIN_META[id].name, name);
  }
  assert.deepEqual([...KNOWN_CHAIN_IDS].sort((a, b) => a - b), [1, 10, 56, 137, 3961, 8453, 42161, 43114]);
  for (const id of KNOWN_CHAIN_IDS) {
    assert.ok(CHAIN_RPC_URLS[id]?.length > 0, `RPC for ${id}`);
    for (const u of CHAIN_RPC_URLS[id]) assert.match(u, /^https:\/\//);
  }
});

test('chain ids parse from hex, decimal strings and numbers only', () => {
  assert.equal(parseChainId('0xf79'), 3961);
  assert.equal(parseChainId('0xF79'), 3961);
  assert.equal(parseChainId('3961'), 3961);
  assert.equal(parseChainId(56), 56);
  assert.equal(parseChainId('0x'), null);
  assert.equal(parseChainId('ff'), null);
  assert.equal(parseChainId(-1), null);
  assert.equal(parseChainId(1.5), null);
  assert.equal(parseChainId(undefined), null);
});

test('the EIP-6963 icon is the brand favicon, byte for byte', () => {
  const svg = readFileSync(`${root}wallet-web/public/favicon.svg`);
  assert.ok(FERMINUX_WALLET_ICON.startsWith('data:image/svg+xml;base64,'));
  assert.deepEqual(Buffer.from(FERMINUX_WALLET_ICON.split(',')[1], 'base64'), svg);
});

test('errors cross the boundary as plain JSON', () => {
  const e = toRpcError(Object.assign(new Error('execution reverted'), { code: 3, data: '0x08c379a0' }));
  assert.deepEqual(e, { code: 3, message: 'execution reverted', data: '0x08c379a0' });
  assert.equal(toRpcError(new Error('x')).code, -32603);
  assert.equal(toRpcError({ code: 1.5, message: '' }).message, 'Internal error');
  const back = fromRpcError({ code: 4001, message: 'rejected' });
  assert.equal(back.code, 4001);
  assert.equal(fromRpcError(null).code, -32603);
});

test('legacy wallets are named by their flags; remote icons are refused', () => {
  assert.equal(legacyWalletName({ isMetaMask: true, isRabby: true }), 'Rabby');
  assert.equal(legacyWalletName({ isMetaMask: true }), 'MetaMask');
  assert.equal(legacyWalletName({}), 'Browser wallet');
  assert.equal(safeIcon('https://tracker.example/i.png'), '');
  assert.equal(safeIcon('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeIcon('data:text/html,<script>'), '');
});
