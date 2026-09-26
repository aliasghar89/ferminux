// Unit tests for the connect window's pure logic (src/connect/): request
// parsing, the first-look screen, the connected-sites store, calldata
// decoding and the signatures it produces.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyMessage, verifyTypedData, Interface, MaxUint256, parseEther, hexlify, toUtf8Bytes } from 'ethers';

import { parsePersonalSign, parseTypedDataV4, parseTxRequest, parseWatchAsset, parseQuantity, printableText } from '../src/connect/requests.ts';
import { screenRequest, siweDomainMismatch, needsKey, permitWarning } from '../src/connect/screen.ts';
import {
  parseSites,
  serializeSites,
  withSite,
  withoutSite,
  touched,
  approvedAccounts,
  normalizeOrigin,
  isSecureOrigin,
  isSameSite,
  relativeTime,
} from '../src/connect/sites.ts';
import { decodeCalldata, isUnlimited, selectorOf } from '../src/connect/decode.ts';
import { signPersonal, signTyped } from '../src/connect/execute.ts';
import { FRAME_VAULT_KEY } from '../src/connect/frame.ts';
import { VAULT_KEY } from '../src/lib/vault.ts';
import { readHash } from '../src/connect/channel.ts';
import { otherWalletUrls, walletPlace, handOffUrl } from '../src/connect/origins.ts';
import { WALLET_CONNECT_URLS } from '../src/config.ts';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const W = new Wallet(KEY);
const A = W.address;
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const DAPP = 'https://dex.ferminux.net';

const approved = (accounts = [A]) => withSite([], DAPP, 'Ferminux DEX', accounts, 1000);

/* ---------------- personal_sign ---------------- */

test('personal_sign: hex and text messages, both param orders, bad input refused', async () => {
  const hex = hexlify(toUtf8Bytes('Hello Ferminux'));
  const r1 = parsePersonalSign([hex, A]);
  assert.equal(r1.address, A);
  assert.equal(r1.text, 'Hello Ferminux');
  const r2 = parsePersonalSign([A.toLowerCase(), hex]);
  assert.equal(r2.address, A, 'address first is accepted and checksummed');
  const r3 = parsePersonalSign(['plain text', A]);
  assert.equal(r3.text, 'plain text');
  assert.equal(parsePersonalSign(['0x00ff01', A]).text, null, 'binary bytes are shown as hex');
  assert.throws(() => parsePersonalSign(['hi']), /takes \[message, address\]/);
  assert.throws(() => parsePersonalSign([{}, A]), /must be a string/);
  const sig = await signPersonal(KEY, r1);
  assert.equal(verifyMessage('Hello Ferminux', sig), A, 'a hex message is signed as the bytes it encodes');
});

test('printableText refuses control and bidi characters', () => {
  assert.equal(printableText(toUtf8Bytes('line 1\nline 2\ttab')), 'line 1\nline 2\ttab');
  assert.equal(printableText(toUtf8Bytes('evil‮txt')), null);
  assert.equal(printableText(new Uint8Array([0xff, 0xfe])), null);
});

/* ---------------- typed data ---------------- */

const TYPED = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Voucher: [
      { name: 'payer', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    Unused: [{ name: 'x', type: 'uint256' }],
  },
  primaryType: 'Voucher',
  domain: { name: 'X402Vault', version: '1', chainId: 3961, verifyingContract: '0x8751000000000000000000000000000000000001' },
  message: { payer: A, amount: '1000' },
};

test('eth_signTypedData_v4: parses a JSON string, drops unused types, signs what ethers verifies', async () => {
  const req = parseTypedDataV4([A, JSON.stringify(TYPED)]);
  assert.equal(req.primaryType, 'Voucher');
  assert.equal(req.domainChainId, 3961);
  assert.deepEqual(Object.keys(req.types), ['Voucher']);
  const sig = await signTyped(KEY, req);
  assert.equal(verifyTypedData(req.domain, req.types, req.message, sig), A);
  assert.throws(() => parseTypedDataV4([A, '{nope']), /not valid JSON/);
  assert.throws(() => parseTypedDataV4([A, { ...TYPED, primaryType: 'Missing' }]), /not in types/);
  assert.throws(() => parseTypedDataV4([A, { ...TYPED, message: { payer: 'nope', amount: '1' } }]), /eth_signTypedData_v4/);
  // A chainId the wallet cannot read is refused, never treated as "no chain named".
  assert.throws(() => parseTypedDataV4([A, { ...TYPED, domain: { ...TYPED.domain, chainId: '0x' + 'f'.repeat(20) } }]), /domain.chainId/);
  const { chainId: _omit, ...noChain } = TYPED.domain;
  assert.equal(parseTypedDataV4([A, { ...TYPED, types: { ...TYPED.types, EIP712Domain: TYPED.types.EIP712Domain.filter((f) => f.name !== 'chainId') }, domain: noChain }]).domainChainId, null);
});

/* ---------------- transactions ---------------- */

test('eth_sendTransaction params: quantities, data/input, contract creation, limits', () => {
  const tx = parseTxRequest([{ from: A.toLowerCase(), to: B, value: '0xde0b6b3a7640000', data: '0xABCD', gas: '0x5208' }]);
  assert.equal(tx.from, A);
  assert.equal(tx.value, 10n ** 18n);
  assert.equal(tx.data, '0xabcd');
  assert.equal(tx.gas, 21000n);
  assert.equal(parseTxRequest([{ from: A, to: B, input: '0x12' }]).data, '0x12');
  assert.equal(parseTxRequest([{ from: A, data: '0x6000' }]).to, null, 'no `to` = contract creation');
  assert.throws(() => parseTxRequest([{ from: A }]), /no recipient/);
  assert.throws(() => parseTxRequest([{ from: A, to: B, data: '0x123' }]), /hex bytes/);
  assert.throws(() => parseTxRequest([{ from: A, to: B, gas: '0x10' }]), /gas must be between/);
  assert.throws(() => parseTxRequest([{ from: 'me', to: B }]), /from must be an address/);
  assert.equal(parseQuantity('12', 'x'), 12n);
  assert.equal(parseQuantity(undefined, 'x'), null);
  assert.throws(() => parseQuantity(-1, 'value'), /non-negative/);
  assert.throws(() => parseQuantity('1.5', 'value'), /hex quantity/);
});

test('wallet_watchAsset params (EIP-747)', () => {
  const t = parseWatchAsset({ type: 'ERC20', options: { address: B.toLowerCase(), symbol: 'USDF', decimals: 18 } });
  assert.deepEqual(t, { address: B, symbol: 'USDF', decimals: 18 });
  assert.equal(parseWatchAsset([{ type: 'ERC20', options: { address: B, symbol: 'X', decimals: '6' } }]).decimals, 6);
  assert.throws(() => parseWatchAsset({ type: 'ERC721', options: {} }), /FRC-20/);
  assert.throws(() => parseWatchAsset({ type: 'ERC20', options: { address: B, symbol: 'TOOLONGSYMBOL', decimals: 18 } }), /1 to 11/);
});

/* ---------------- screen ---------------- */

test('screen: connect, auto-answer for approved sites, refusals for everything else', () => {
  const sites = approved();
  const avail = [A, B];
  const base = { origin: DAPP, chainId: 3961 };
  assert.deepEqual(screenRequest({ ...base, method: 'eth_requestAccounts', params: [] }, [], avail), { action: 'review', kind: 'connect' });
  assert.deepEqual(screenRequest({ ...base, method: 'eth_requestAccounts', params: [] }, sites, avail), { action: 'reply', result: [A] });
  // A removed account does not count as approved.
  assert.deepEqual(screenRequest({ ...base, method: 'eth_requestAccounts', params: [] }, sites, [B]), { action: 'review', kind: 'connect' });

  const code = (s) => (s.action === 'error' ? s.error.code : s.action);
  assert.equal(code(screenRequest({ ...base, method: 'personal_sign', params: ['0x00', A] }, [], avail)), 4100, 'unapproved site');
  assert.equal(code(screenRequest({ ...base, origin: 'https://evil.example', method: 'personal_sign', params: ['0x00', A] }, sites, avail)), 4100);
  assert.equal(code(screenRequest({ ...base, method: 'personal_sign', params: ['0x00', B] }, sites, avail)), 4100, 'account not given to the site');
  assert.equal(code(screenRequest({ ...base, method: 'eth_sign', params: [] }, sites, avail)), 4200);
  assert.equal(code(screenRequest({ ...base, chainId: 5, method: 'personal_sign', params: ['0x00', A] }, sites, avail)), 4901);
  assert.equal(code(screenRequest({ ...base, method: 'personal_sign', params: ['0x00', A] }, sites, avail)), 'review');
  assert.equal(code(screenRequest({ ...base, method: 'eth_sendTransaction', params: [{ from: A, to: B, chainId: '0x38' }] }, sites, avail)), -32602);
  assert.equal(code(screenRequest({ ...base, chainId: 56, method: 'eth_sendTransaction', params: [{ from: A, to: B, chainId: '0x38' }] }, sites, avail)), 'review');
  assert.equal(code(screenRequest({ ...base, chainId: 56, method: 'eth_signTypedData_v4', params: [A, TYPED] }, sites, avail)), -32602, 'typed data for 3961 while on 56');
  assert.equal(code(screenRequest({ ...base, chainId: 56, method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: B, symbol: 'X', decimals: 1 } } }, sites, avail)), -32602);
  assert.equal(needsKey('watch'), false);
  assert.equal(needsKey('tx'), true);
});

test('SIWE: a sign-in for another domain is flagged', () => {
  const msg = (d) => `${d} wants you to sign in with your Ethereum account:\n${A}\n\nURI: https://${d}`;
  assert.equal(siweDomainMismatch(msg('dex.ferminux.net'), DAPP), null);
  assert.equal(siweDomainMismatch(msg('bank.example'), DAPP), 'bank.example');
  assert.equal(siweDomainMismatch('just a message', DAPP), null);
  // EIP-4361 allows a scheme before the domain.
  assert.equal(siweDomainMismatch(msg('https://dex.ferminux.net'), DAPP), null);
  assert.equal(siweDomainMismatch(msg('https://bank.example'), DAPP), 'bank.example');
});

/* ---------------- sites ---------------- */

test('sites store: round trip, re-approval keeps the first connect time, revoke, junk dropped', () => {
  let sites = withSite([], DAPP, 'DEX', [A], 1000);
  sites = withSite(sites, 'https://ferminux.net', 'Ferminux', [B], 2000);
  sites = withSite(sites, DAPP, 'DEX', [B], 3000);
  assert.equal(sites[0].origin, DAPP, 'newest first');
  assert.equal(sites[0].connectedAt, 1000);
  assert.deepEqual(sites[0].accounts, [B]);
  assert.deepEqual(parseSites(serializeSites(sites)), sites);
  assert.equal(touched(sites, DAPP, 9000)[0].lastUsedAt, 9000);
  assert.deepEqual(withoutSite(sites, DAPP).map((s) => s.origin), ['https://ferminux.net']);
  const junk = JSON.stringify({
    version: 1,
    sites: [
      { origin: 'javascript:alert(1)', accounts: [A] },
      { origin: 'https://ok.example/path', accounts: [A] },
      { origin: 'https://ok.example', accounts: ['nope'] },
      { origin: 'https://ok.example', accounts: [A], name: 7 },
    ],
  });
  assert.deepEqual(parseSites(junk).map((s) => [s.origin, s.name]), [['https://ok.example', '']]);
  assert.deepEqual(parseSites('{"version":2,"sites":[]}'), []);
  assert.deepEqual(approvedAccounts(sites[0], [A]), []);
});

test('origins: canonical http(s) only; secure means https or a local host', () => {
  assert.equal(normalizeOrigin('https://dex.ferminux.net'), 'https://dex.ferminux.net');
  assert.equal(normalizeOrigin('https://dex.ferminux.net/'), null);
  assert.equal(normalizeOrigin('null'), null);
  assert.equal(normalizeOrigin('file://x'), null);
  assert.equal(isSecureOrigin('http://localhost:5173'), true);
  assert.equal(isSecureOrigin('http://dex.example'), false);
});

test('same-site: *.ferminux.net share the wallet storage; other sites do not', () => {
  assert.equal(isSameSite('https://dex.ferminux.net', 'https://wallet.ferminux.net'), true);
  assert.equal(isSameSite('https://ferminux.net', 'https://wallet.ferminux.net'), true);
  assert.equal(isSameSite('https://ferminux.com', 'https://wallet.ferminux.net'), false);
  assert.equal(isSameSite('http://dex.ferminux.net', 'https://wallet.ferminux.net'), false, 'schemeful');
  assert.equal(isSameSite('http://localhost:5173', 'http://localhost:5174'), true, 'ports do not matter');
  assert.equal(isSameSite('http://127.0.0.1:5173', 'http://localhost:5174'), false);
});

test('the frame reads the same vault key as the wallet', () => {
  assert.equal(FRAME_VAULT_KEY, VAULT_KEY);
});

test('the window reads the claimed origin from its hash, never a malformed one', () => {
  assert.deepEqual(readHash('#origin=https%3A%2F%2Fdex.ferminux.net&app=DEX'), { origin: DAPP, app: 'DEX' });
  assert.deepEqual(readHash('#origin=https%3A%2F%2Fdex.ferminux.net%2Fpath'), { origin: null, app: '' });
  assert.deepEqual(readHash(''), { origin: null, app: '' });
});

/* ---------------- decode ---------------- */

test('calldata decoding: token calls, router swaps, unknown selectors', () => {
  const erc20 = new Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']);
  const erc20full = new Interface(['function increaseAllowance(address,uint256)']);
  const approve = decodeCalldata(erc20.encodeFunctionData('approve', [B, MaxUint256]));
  assert.equal(approve.name, 'approve');
  assert.equal(approve.args[0].value, B);
  assert.equal(isUnlimited(approve.args[1].raw), true);
  assert.equal(isUnlimited(parseEther('1000000')), false);
  // increaseAllowance grants an allowance just like approve, and a drainer
  // reaches for it precisely to dodge a wallet that only decodes approve().
  const inc = decodeCalldata(erc20full.encodeFunctionData('increaseAllowance', [B, MaxUint256]));
  assert.equal(inc.name, 'increaseAllowance');
  assert.equal(inc.args[0].value, B, 'spender');
  assert.equal(isUnlimited(inc.args[1].raw), true, 'the added amount is flagged unlimited');
  const incSmall = decodeCalldata(erc20full.encodeFunctionData('increaseAllowance', [B, parseEther('1')]));
  assert.equal(isUnlimited(incSmall.args[1].raw), false);
  const router = new Interface(['function swapExactFMXForTokens(uint256,address[],address,uint256)']);
  const swap = decodeCalldata(router.encodeFunctionData('swapExactFMXForTokens', [5n, [A, B], A, 99n]));
  assert.equal(swap.name, 'swapExactFMXForTokens');
  assert.equal(swap.args[1].value, `${A}, ${B}`);
  assert.equal(decodeCalldata('0xdeadbeef00'), null);
  assert.equal(decodeCalldata('0x'), null);
  assert.equal(selectorOf('0xDEADBEEF00'), '0xdeadbeef');
});

test('permitWarning: token permits are flagged in the connect window, plain typed data is not', () => {
  const permit = parseTypedDataV4([A, JSON.stringify({
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    },
    primaryType: 'Permit',
    domain: { name: 'Demo USD', chainId: 3961, verifyingContract: B },
    message: { owner: A, spender: B, value: MaxUint256.toString(), nonce: '0', deadline: '99999999999' },
  })]);
  assert.match(permitWarning(permit), /token permit/i);
  // Permit2 dApps name their whole domain "Permit2" rather than the primary type.
  const permit2 = parseTypedDataV4([A, JSON.stringify({
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PermitSingle: [{ name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    },
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 3961, verifyingContract: B },
    message: { spender: B, sigDeadline: '99999999999' },
  })]);
  assert.match(permitWarning(permit2), /token permit/i);
  assert.equal(permitWarning(parseTypedDataV4([A, JSON.stringify(TYPED)])), null);
});

test('relative time for the sites list', () => {
  const now = 10_000_000;
  assert.equal(relativeTime(now - 5_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(relativeTime(0, now), '—');
});

test('screen: a site disconnecting itself is a revoke of its own approval, whatever the chain or approval state', () => {
  const base = { origin: DAPP, chainId: 3961, params: [{ eth_accounts: {} }] };
  assert.deepEqual(screenRequest({ ...base, method: 'wallet_revokePermissions' }, approved(), [A]), { action: 'revoke' });
  assert.deepEqual(screenRequest({ ...base, method: 'wallet_revokePermissions', chainId: 5 }, [], []), { action: 'revoke' }, 'nothing to remove is still an answer');
  // the approval removed is the requester's (its verified origin), never another site's
  const two = withSite(approved(), 'https://other.example', 'Other', [A], 2000);
  assert.deepEqual(withoutSite(two, DAPP).map((x) => x.origin), ['https://other.example']);
});

test('switching the active account shares nothing: a site sees only the account it was given', () => {
  // The screen never reads which account is active: approval is per site, per account.
  const sites = approved([A]);
  const base = { origin: DAPP, chainId: 3961 };
  assert.deepEqual(screenRequest({ ...base, method: 'eth_requestAccounts', params: [] }, sites, [B, A]), { action: 'reply', result: [A] });
  assert.equal(screenRequest({ ...base, method: 'personal_sign', params: ['0x00', B] }, sites, [B, A]).error.code, 4100);
});

test('wallet origins: the connect window knows the wallet\'s other address, and carries the request there', () => {
  assert.deepEqual(WALLET_CONNECT_URLS, ['https://wallet.ferminux.net/connect.html', 'https://ferminux.net/wallet/connect.html']);
  assert.deepEqual(otherWalletUrls({ origin: 'https://wallet.ferminux.net', pathname: '/connect.html' }, WALLET_CONNECT_URLS), ['https://ferminux.net/wallet/connect.html']);
  assert.deepEqual(otherWalletUrls({ origin: 'https://ferminux.net', pathname: '/wallet/connect.html' }, WALLET_CONNECT_URLS), ['https://wallet.ferminux.net/connect.html']);
  assert.deepEqual(otherWalletUrls({ origin: 'http://localhost:5173', pathname: '/connect.html' }, WALLET_CONNECT_URLS), [], 'a page not in the list offers nothing');
  assert.deepEqual(otherWalletUrls({ origin: 'https://ferminux.net', pathname: '/connect.html' }, WALLET_CONNECT_URLS), [], 'exact path, not just the origin');
  assert.equal(walletPlace('https://ferminux.net/wallet/connect.html'), 'ferminux.net/wallet');
  assert.equal(walletPlace('https://wallet.ferminux.net/connect.html'), 'wallet.ferminux.net');
  const hash = '#origin=https%3A%2F%2Fdex.ferminux.net&app=Ferminux+DEX';
  const to = handOffUrl('https://ferminux.net/wallet/connect.html', hash);
  assert.equal(to, 'https://ferminux.net/wallet/connect.html' + hash);
  assert.deepEqual(readHash(new URL(to).hash), { origin: 'https://dex.ferminux.net', app: 'Ferminux DEX' });
});

test('the "transaction sent" signal between wallet windows carries public data only, and junk is dropped', async () => {
  const { parseTxSignal } = await import('../src/lib/txSignal.ts');
  const good = { chainId: 3961, from: A, hash: '0x' + 'ab'.repeat(32) };
  assert.deepEqual(parseTxSignal(good), good);
  assert.deepEqual(parseTxSignal({ ...good, privateKey: KEY }), good, 'nothing else rides along');
  assert.equal(parseTxSignal({ ...good, hash: '0x12' }), null);
  assert.equal(parseTxSignal({ ...good, from: 'me' }), null);
  assert.equal(parseTxSignal({ ...good, chainId: -1 }), null);
  assert.equal(parseTxSignal('x'), null);
});
