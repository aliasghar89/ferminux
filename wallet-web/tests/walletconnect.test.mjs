// WalletConnect wallet-side logic with mocks — the relay needs a project id
// this test run does not have, so every decision is exercised directly:
// pairing codes, session proposals, each supported request, signatures that
// verify, and the controller's approve / reject / disconnect / account-switch
// traffic against a fake WalletKit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getBytes, hashMessage, recoverAddress, verifyMessage, verifyTypedData, hexlify, toUtf8Bytes } from 'ethers';
import {
  SDK_ERRORS,
  WC_METHODS,
  buildNamespaces,
  decodeCall,
  parseWcUri,
  printableText,
  refusal,
  reviewProposal,
  reviewRequest,
  sessionAddresses,
  sessionChainIds,
  signForRequest,
  siweDomain,
} from '../src/lib/walletconnect.ts';
import { WcController } from '../src/lib/wcController.ts';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ME = new Wallet(KEY).address; // 0x7099…79C8
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const TOPIC = 'a'.repeat(64);
const SYM = 'b'.repeat(64);
const DAPP = { name: 'Ferminux DEX', description: 'Swap', url: 'https://ferminux.net', icons: ['https://ferminux.net/icon.png', 'http://insecure/icon.png'] };
const VERIFIED = { verified: { origin: 'https://ferminux.net', validation: 'VALID', verifyUrl: 'https://verify.walletconnect.org' } };

/* ---------------- pairing codes ---------------- */

test('parseWcUri: accepts v2 codes, unwraps ?uri= links, refuses v1, junk, damage and expiry', () => {
  const good = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${SYM}&expiryTimestamp=${Math.floor(Date.now() / 1000) + 300}`;
  assert.deepEqual(parseWcUri(`  ${good}  `), { ok: true, uri: good, topic: TOPIC });
  assert.equal(parseWcUri(`https://example.org/wc?uri=${encodeURIComponent(good)}`).ok, true);
  assert.match(parseWcUri('wc:8a5e5bdc-a0e4-4702-ba63-8f1a5655744f@1?bridge=https%3A%2F%2Fbridge&key=41791102999c339c844880b23950704cc43aa840f3739e365323cda4dfa89e7a').error, /v1/);
  assert.match(parseWcUri('0x7F16433359E4eF704E90cE08460c6238E45130f7').error, /not a WalletConnect code/);
  assert.match(parseWcUri('').error, /Paste/);
  assert.match(parseWcUri(`wc:${TOPIC}@2?relay-protocol=irn`).error, /missing key/);
  assert.match(parseWcUri(`wc:xyz@2?symKey=${SYM}`).error, /bad topic/);
  assert.match(parseWcUri(`wc:${TOPIC}@2?symKey=${SYM}&expiryTimestamp=1000`).error, /expired/);
});

/* ---------------- proposals ---------------- */

function proposal(over = {}) {
  return {
    id: 1,
    params: {
      expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      proposer: { publicKey: 'x', metadata: DAPP },
      requiredNamespaces: { eip155: { chains: ['eip155:3961'], methods: ['eth_sendTransaction', 'personal_sign'], events: ['chainChanged'] } },
      optionalNamespaces: { eip155: { chains: ['eip155:56', 'eip155:250'], methods: ['eth_signTypedData_v4', 'eth_getBalance'], events: [] } },
      ...over,
    },
    verifyContext: VERIFIED,
  };
}

// The shape the big wagmi/AppKit dApps send (recorded from PancakeSwap and
// Uniswap on 2026-09-26): nothing required, twenty-odd optional chains, the
// whole EIP-1193 method list and five events.
const WAGMI_METHODS = [
  'eth_accounts', 'eth_requestAccounts', 'eth_sendRawTransaction', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData',
  'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_sendTransaction', 'personal_sign', 'wallet_switchEthereumChain',
  'wallet_addEthereumChain', 'wallet_getPermissions', 'wallet_requestPermissions', 'wallet_registerOnboarding',
  'wallet_watchAsset', 'wallet_scanQRCode', 'wallet_sendCalls', 'wallet_getCapabilities', 'wallet_getCallsStatus',
  'wallet_showCallsStatus',
];
const wagmiProposal = (chains) =>
  proposal({
    proposer: { publicKey: 'x', metadata: { name: 'Exchange | PancakeSwap', description: 'DEX', url: 'https://pancakeswap.finance', icons: [] } },
    requiredNamespaces: {},
    optionalNamespaces: { eip155: { chains: chains.map((c) => `eip155:${c}`), methods: WAGMI_METHODS, events: ['chainChanged', 'accountsChanged', 'message', 'disconnect', 'connect'] } },
  });

test('proposal: a large dApp (PancakeSwap / Uniswap shape) is approved on the networks both sides have', () => {
  const r = reviewProposal(wagmiProposal([56, 97, 1, 5, 11155111, 324, 42161, 421614, 59144, 8453, 84532, 204, 5611, 534351, 143, 10143]), ME);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.approvedChainIds, [56, 1, 42161, 8453], 'the dApp order is kept: its first chain becomes the session chain');
  assert.deepEqual(r.chains.map((c) => c.chainId), [56, 1, 42161, 8453]);
  assert.equal(r.otherChains, 12, 'test and foreign networks are counted, not listed');
  const ns = r.namespaces.eip155;
  assert.deepEqual(ns.accounts, [56, 1, 42161, 8453].map((c) => `eip155:${c}:${ME}`));
  assert.deepEqual([...ns.methods].sort(), [...WC_METHODS].sort(), 'only methods this wallet services are granted');
  assert.deepEqual(ns.events, ['chainChanged', 'accountsChanged']);
});

test('proposal: nothing requested is usable -> every network stays listed and Ferminux is shared', () => {
  const r = reviewProposal(wagmiProposal([250, 97]), ME);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.chains.map((c) => c.chainId), [250, 97]);
  assert.equal(r.otherChains, 0);
  assert.deepEqual(r.approvedChainIds, [3961]);
});

test('proposal: grants the active account on requested supported chains only; unsupported optional chains are dropped', () => {
  const r = reviewProposal(proposal(), ME);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.approvedChainIds, [3961, 56]);
  // An optional network the wallet does not use is counted, not listed.
  assert.equal(r.chains.find((c) => c.chainId === 250), undefined);
  assert.equal(r.otherChains, 1);
  assert.deepEqual(r.chains.map((c) => c.chainId), [3961, 56]);
  assert.deepEqual(r.namespaces.eip155.chains, ['eip155:3961', 'eip155:56']);
  assert.deepEqual(r.namespaces.eip155.accounts, [`eip155:3961:${ME}`, `eip155:56:${ME}`]);
  for (const m of WC_METHODS) assert.ok(r.namespaces.eip155.methods.includes(m), m);
  assert.equal(r.namespaces.eip155.methods.includes('eth_getBalance'), false, 'optional methods we cannot service are not granted');
  assert.deepEqual(r.namespaces.eip155.events, ['chainChanged', 'accountsChanged']);
  assert.equal(r.dapp.name, 'Ferminux DEX');
  assert.equal(r.dapp.icon, 'https://ferminux.net/icon.png', 'only an https icon is used');
  assert.equal(r.verify.status, 'valid');
});

test('proposal: an unsupported REQUIRED chain or namespace blocks approval with a reason', () => {
  const r = reviewProposal(proposal({ requiredNamespaces: { eip155: { chains: ['eip155:250'], methods: [], events: [] } } }), ME);
  assert.equal(r.namespaces, null);
  assert.match(r.blockers.join(' '), /requires Chain 250/);
  const s = reviewProposal(proposal({ requiredNamespaces: { solana: { chains: ['solana:mainnet'], methods: [], events: [] } } }), ME);
  assert.match(s.blockers.join(' '), /"solana"/);
});

test('proposal: chain-scoped keys (eip155:1) and an empty request (defaults to Ferminux) both work', () => {
  const r = reviewProposal(proposal({ requiredNamespaces: { 'eip155:1': { methods: ['personal_sign'], events: [] } }, optionalNamespaces: {} }), ME);
  assert.deepEqual(r.approvedChainIds, [1]);
  const e = reviewProposal(proposal({ requiredNamespaces: {}, optionalNamespaces: {} }), ME);
  assert.deepEqual(e.approvedChainIds, [3961]);
  assert.deepEqual(e.blockers, []);
});

test('proposal: required methods outside our set are granted (the protocol demands it) and answered "unsupported" later', () => {
  const r = reviewProposal(proposal({ requiredNamespaces: { eip155: { chains: ['eip155:3961'], methods: ['eth_signTransaction'], events: ['message'] } } }), ME);
  assert.ok(r.namespaces.eip155.methods.includes('eth_signTransaction'));
  assert.ok(r.namespaces.eip155.events.includes('message'));
});

test('verify: an origin that does not match the claimed URL, or a scam flag, is surfaced', () => {
  const spoof = reviewProposal({ ...proposal(), verifyContext: { verified: { origin: 'https://ferminux-airdrop.example', validation: 'UNKNOWN' } } }, ME);
  assert.equal(spoof.verify.status, 'invalid');
  assert.equal(spoof.verify.mismatch, true);
  const scam = reviewProposal({ ...proposal(), verifyContext: { verified: { origin: 'https://ferminux.net', validation: 'VALID', isScam: true } } }, ME);
  assert.equal(scam.verify.status, 'scam');
  // A scam-flagged site gets Reject only: approving would hand it the address.
  assert.match(scam.blockers.join(' '), /known scam/);
  assert.equal(scam.namespaces, null);
});

test('verify: with no Verify answer the origin is unknown, not the URL the site claims', () => {
  // What the SDK hands over when Verify cannot resolve: validation UNKNOWN, origin = the claimed metadata.url.
  const unknown = reviewProposal({ ...proposal(), verifyContext: { verified: { origin: DAPP.url, validation: 'UNKNOWN' } } }, ME);
  assert.equal(unknown.verify.status, 'unknown');
  assert.equal(unknown.verify.origin, '');
  assert.equal(reviewProposal({ ...proposal(), verifyContext: undefined }, ME).verify.origin, '');
  assert.equal(reviewProposal(proposal(), ME).verify.origin, 'https://ferminux.net');
  // A sign-in for another domain is still caught, against the claimed host.
  const siwe = 'evil.example wants you to sign in with your Ethereum account:\n' + ME + '\n\nURI: https://evil.example\nNonce: 1';
  const v = reviewRequest({ ...req('personal_sign', [siwe, ME]), verifyContext: { verified: { origin: DAPP.url, validation: 'UNKNOWN' } } }, session(), ME);
  assert.match(v.warnings.join(' '), /for evil\.example, but the site calls itself ferminux\.net/);
});

/* ---------------- requests ---------------- */

const session = (chains = [3961, 56], address = ME) => ({
  topic: TOPIC,
  expiry: Math.floor(Date.now() / 1000) + 86400,
  peer: { metadata: DAPP },
  namespaces: buildNamespaces(chains, address, [...WC_METHODS], ['chainChanged', 'accountsChanged']),
});
const req = (method, params, chainId = 'eip155:3961', id = 7) => ({
  id,
  topic: TOPIC,
  params: { request: { method, params }, chainId },
  verifyContext: VERIFIED,
});

test('session helpers read chains and addresses', () => {
  assert.deepEqual(sessionChainIds(session()), [3961, 56]);
  assert.deepEqual(sessionAddresses(session()), [ME.toLowerCase()]);
});

test('personal_sign: text shown, signature verifies, swapped params tolerated, foreign signer blocked', async () => {
  const msg = 'Sign in to Ferminux DEX\nNonce: 42';
  const v = reviewRequest(req('personal_sign', [hexlify(toUtf8Bytes(msg)), ME]), session(), ME);
  assert.deepEqual(v.blockers, []);
  assert.equal(v.detail.text, msg);
  assert.equal(v.chain.id, 3961);
  const sig = await signForRequest(v, KEY);
  assert.equal(verifyMessage(msg, sig), ME);

  const swapped = reviewRequest(req('personal_sign', [ME, msg]), session(), ME);
  assert.equal(swapped.detail.text, msg);

  const foreign = reviewRequest(req('personal_sign', ['0x1234', OTHER]), session(), ME);
  assert.match(foreign.blockers[0], /not the active account/);
  await assert.rejects(signForRequest(foreign, KEY), /cannot be signed/);
});

test('personal_sign: binary data is shown as hex with a warning; a sign-in message for another domain is flagged', () => {
  const bin = reviewRequest(req('personal_sign', ['0x00ff10', ME]), session(), ME);
  assert.equal(bin.detail.text, null);
  assert.equal(bin.detail.hex, '0x00ff10');
  assert.match(bin.warnings.join(' '), /not readable text/);

  const siwe = 'evil.example wants you to sign in with your Ethereum account:\n' + ME + '\n\nURI: https://evil.example\nNonce: 1';
  assert.equal(siweDomain(siwe), 'evil.example');
  const v = reviewRequest(req('personal_sign', [siwe, ME]), session(), ME);
  assert.match(v.warnings.join(' '), /for evil\.example, but the request came from ferminux\.net/);
  assert.equal(printableText(new Uint8Array([0xe2, 0x80, 0xae])), null, 'a bidi override makes text unreadable');
});

test('eth_sign: refused as unsupported and never offered in a session', () => {
  const hash = hashMessage('anything');
  const v = reviewRequest(req('eth_sign', [ME, hash]), session(), ME);
  assert.equal(v.detail.kind, 'unsupported');
  assert.match(v.blockers[0], /does not support "eth_sign"/);
  assert.equal(refusal(v).code, 5101);
  assert.equal(WC_METHODS.includes('eth_sign'), false);
});

const typed = (chainId = 3961, primaryType = 'Mail') => ({
  domain: { name: 'Ferminux Mail', version: '1', chainId, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  primaryType,
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    [primaryType]: [
      { name: 'to', type: 'address' },
      { name: 'contents', type: 'string' },
      { name: 'amounts', type: 'uint256[]' },
    ],
  },
  message: { to: OTHER, contents: 'Hello', amounts: ['1', '2'] },
});

test('eth_signTypedData_v4: decoded domain and fields, signature verifies, chain mismatch blocked, permits warned', async () => {
  const data = typed();
  const v = reviewRequest(req('eth_signTypedData_v4', [ME, JSON.stringify(data)]), session(), ME);
  assert.deepEqual(v.blockers, []);
  assert.equal(v.detail.primaryType, 'Mail');
  assert.equal(v.detail.domain.chainId, 3961);
  assert.equal(v.detail.domain.verifyingContract, '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC');
  assert.deepEqual(v.detail.fields.map((f) => f.path), ['to', 'contents', 'amounts[0]', 'amounts[1]']);
  const sig = await signForRequest(v, KEY);
  const types = { ...data.types };
  delete types.EIP712Domain;
  assert.equal(verifyTypedData(data.domain, types, data.message, sig), ME);

  const wrongChain = reviewRequest(req('eth_signTypedData_v4', [ME, JSON.stringify(typed(1))]), session(), ME);
  assert.match(wrongChain.blockers[0], /for chain 1, but the request is for Ferminux/);

  const permit = reviewRequest(req('eth_signTypedData_v4', [ME, typed(3961, 'Permit')]), session(), ME);
  assert.match(permit.warnings.join(' '), /token permit/);

  const broken = reviewRequest(req('eth_signTypedData_v4', [ME, '{"types":{}}']), session(), ME);
  assert.equal(broken.detail.kind, 'unsupported');
  const misfit = reviewRequest(req('eth_signTypedData_v4', [ME, { ...data, message: { to: 'nope' } }]), session(), ME);
  assert.match(misfit.blockers[0], /does not match its own schema/);

  // A permit relabelled as something harmless: the key would sign the Permit
  // (the root of `types`) while the modal showed "Mail" and no permit warning.
  const disguised = { ...typed(3961, 'Permit'), primaryType: 'Mail' };
  const d = reviewRequest(req('eth_signTypedData_v4', [ME, disguised]), session(), ME);
  assert.equal(d.detail.kind, 'unsupported');
  assert.match(d.blockers[0], /names "Mail" as its type, but what would be signed is "Permit"/);
});

test('eth_sendTransaction: value/data decoded, approvals warned, deploys and foreign senders refused', () => {
  const usdt = '0x55d398326f99059fF775485246999027B3197955';
  const approve = '0x095ea7b3' + OTHER.slice(2).toLowerCase().padStart(64, '0') + 'f'.repeat(64);
  const v = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: usdt, data: approve, value: '0x0', gas: '0x5208' }], 'eip155:56'), session(), ME);
  assert.deepEqual(v.blockers, []);
  assert.equal(v.chain.name, 'BNB Smart Chain');
  assert.equal(v.detail.decoded.kind, 'token-approve');
  assert.equal(v.detail.decoded.unlimited, true);
  assert.equal(v.detail.gas, 21000n);
  assert.match(v.dangers.join(' '), /Unlimited approval/);
  assert.doesNotMatch(v.warnings.join(' '), /Unlimited approval/, 'a danger, not a caution');

  const plain = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER, value: '0xde0b6b3a7640000' }]), session(), ME);
  assert.equal(plain.detail.valueWei, 10n ** 18n);
  assert.equal(plain.detail.decoded, null);

  assert.match(reviewRequest(req('eth_sendTransaction', [{ from: ME, data: '0x6080' }]), session(), ME).blockers[0], /deployment/);
  assert.match(reviewRequest(req('eth_sendTransaction', [{ from: OTHER, to: OTHER }]), session(), ME).blockers[0], /not the active account/);
  assert.match(reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER, value: 'lots' }]), session(), ME).blockers[0], /unreadable/);
  assert.match(reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER }], 'eip155:1'), session(), ME).blockers[0], /Ethereum was not approved/);
  assert.match(reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER }], 'eip155:250'), session(), ME).blockers[0], /does not support/);
});

test('eth_sendTransaction: a chainId inside the transaction must be the request chain', () => {
  // Built for Ethereum, sent on the BSC envelope: the key would sign it for BSC.
  const wrong = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER, value: '0x1', chainId: '0x1' }], 'eip155:56'), session(), ME);
  assert.match(wrong.blockers.join(' '), /transaction is for chain 1, but the request is for BNB Smart Chain \(56\)/);
  assert.match(reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER, chainId: 'bsc' }], 'eip155:56'), session(), ME).blockers.join(' '), /unreadable chain id/);
  // The same chain, in any encoding, is fine; so is no chainId at all.
  for (const chainId of ['0x38', '56', 56, undefined, null]) {
    assert.deepEqual(reviewRequest(req('eth_sendTransaction', [{ from: ME, to: OTHER, value: '0x1', chainId }], 'eip155:56'), session(), ME).blockers, [], String(chainId));
  }
});

test('increaseAllowance is decoded as an allowance grant and an unlimited one is a danger', () => {
  const usdt = '0x55d398326f99059fF775485246999027B3197955';
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  // increaseAllowance(OTHER, MAX): a drainer's substitute for approve(OTHER, MAX)
  const unlimited = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: usdt, data: '0x39509351' + addr(OTHER) + 'f'.repeat(64), value: '0x0' }], 'eip155:56'), session(), ME);
  assert.deepEqual(unlimited.blockers, []);
  assert.equal(unlimited.detail.decoded.kind, 'token-increase-allowance');
  assert.equal(unlimited.detail.decoded.unlimited, true);
  assert.match(unlimited.dangers.join(' '), /Unlimited approval/);
  const small = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: usdt, data: '0x39509351' + addr(OTHER) + (5n).toString(16).padStart(64, '0'), value: '0x0' }], 'eip155:56'), session(), ME);
  assert.equal(small.detail.decoded.kind, 'token-increase-allowance');
  assert.equal(small.detail.decoded.unlimited, false);
  assert.deepEqual(small.dangers, [], 'a finite increase is not a danger');
});

test('setApprovalForAll(true) is a danger that names the operator; revoking it is not', () => {
  const nft = '0x' + '84'.repeat(20); // an NFT collection
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const all = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: nft, data: '0xa22cb465' + addr(OTHER) + '1'.padStart(64, '0') }]), session(), ME);
  assert.deepEqual(all.blockers, []);
  assert.equal(all.dangers.length, 1);
  assert.match(all.dangers[0], /EVERY NFT you hold in this collection/);
  assert.ok(all.dangers[0].includes(OTHER), 'the operator is named in full');
  const off = reviewRequest(req('eth_sendTransaction', [{ from: ME, to: nft, data: '0xa22cb465' + addr(OTHER) + '0'.padStart(64, '0') }]), session(), ME);
  assert.deepEqual(off.dangers, []);
});

test('decodeCall covers transfer, transferFrom, setApprovalForAll and NFT transfers', () => {
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const n = (x) => x.toString(16).padStart(64, '0');
  assert.deepEqual(decodeCall('0xa9059cbb' + addr(OTHER) + n(5n)), { kind: 'token-transfer', to: OTHER, amount: 5n });
  assert.equal(decodeCall('0x23b872dd' + addr(ME) + addr(OTHER) + n(9n)).kind, 'token-transfer-from');
  assert.deepEqual(decodeCall('0xa22cb465' + addr(OTHER) + n(1n)), { kind: 'approval-for-all', operator: OTHER, approved: true });
  assert.equal(decodeCall('0x42842e0e' + addr(ME) + addr(OTHER) + n(41n)).tokenId, 41n);
  assert.deepEqual(decodeCall('0xdeadbeef'), { kind: 'unknown', selector: '0xdeadbeef' });
  assert.equal(decodeCall('0x'), null);
});

test('switch / add chain: supported chains need approval, unknown chains are refused with 4902', () => {
  const sw = reviewRequest(req('wallet_switchEthereumChain', [{ chainId: '0x38' }]), session([3961]), ME);
  assert.deepEqual(sw.blockers, []);
  assert.equal(sw.detail.target.id, 56);
  assert.equal(sw.detail.inSession, false);

  const unknown = reviewRequest(req('wallet_switchEthereumChain', [{ chainId: '0xfa' }]), session(), ME);
  assert.match(unknown.blockers[0], /not supported/);
  assert.equal(refusal(unknown).code, 4902);

  const add = reviewRequest(req('wallet_addEthereumChain', [{ chainId: '0xa4b1', chainName: 'Arbitrum', rpcUrls: ['https://attacker.example'] }]), session(), ME);
  assert.deepEqual(add.blockers, []);
  assert.match(add.warnings[0], /RPC endpoints; any the site sent are ignored/);
  const addUnknown = reviewRequest(req('wallet_addEthereumChain', [{ chainId: '0x539', chainName: 'Local' }]), session(), ME);
  assert.match(addUnknown.blockers[0], /only uses its built-in networks/);
});

test('anything else is refused as unsupported; a request from a vanished session is refused', () => {
  const v = reviewRequest(req('eth_signTransaction', [{}]), session(), ME);
  assert.deepEqual(refusal(v), SDK_ERRORS.UNSUPPORTED_METHODS);
  const gone = reviewRequest(req('personal_sign', ['0x00', ME]), undefined, ME);
  assert.match(gone.blockers[0], /no longer connected/);
});

/* ---------------- controller with a fake WalletKit ---------------- */

function fakeKit(initialSessions = {}) {
  const listeners = {};
  const calls = [];
  const kit = {
    sessions: { ...initialSessions },
    pending: [],
    calls,
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    fire(event, payload) {
      for (const fn of listeners[event] ?? []) fn(payload);
    },
    async pair(p) {
      calls.push(['pair', p]);
    },
    async approveSession(p) {
      calls.push(['approveSession', p]);
      const s = { topic: 'c'.repeat(64), peer: { metadata: DAPP }, namespaces: p.namespaces };
      kit.sessions[s.topic] = s;
      return s;
    },
    async rejectSession(p) {
      calls.push(['rejectSession', p]);
    },
    async respondSessionRequest(p) {
      calls.push(['respond', p]);
    },
    getActiveSessions: () => kit.sessions,
    getPendingSessionRequests: () => kit.pending,
    async disconnectSession(p) {
      calls.push(['disconnect', p]);
      delete kit.sessions[p.topic];
    },
    async updateSession(p) {
      calls.push(['update', p]);
      kit.sessions[p.topic] = { ...kit.sessions[p.topic], namespaces: p.namespaces };
    },
    async emitSessionEvent(p) {
      calls.push(['event', p]);
    },
  };
  return kit;
}

function controllerWith(kit, address = ME) {
  const states = [];
  const used = [];
  let current = address;
  const c = new WcController(kit, {
    getAddress: () => current,
    onChange: (s) => states.push(s),
    onUsed: (u) => used.push(u),
  });
  c.start();
  return { c, states, used, setAddress: (a) => (current = a), last: () => states[states.length - 1] };
}

test('controller: proposal → approve sends exactly the reviewed namespaces; the session is listed and "used" is recorded', async () => {
  const kit = fakeKit();
  const { c, last, used } = controllerWith(kit);
  kit.fire('session_proposal', proposal());
  assert.equal(last().proposals.length, 1);
  await c.approveProposal(1);
  const [name, p] = kit.calls.find((x) => x[0] === 'approveSession');
  assert.equal(name, 'approveSession');
  assert.deepEqual(p.namespaces, reviewProposal(proposal(), ME).namespaces);
  assert.equal(last().proposals.length, 0);
  assert.equal(last().sessions.length, 1);
  assert.deepEqual(last().sessions[0].chainIds, [3961, 56]);
  assert.equal(used[used.length - 1], true);
});

test('controller: reject a proposal (user choice → 5000; blocked → 5100); nothing approved', async () => {
  const kit = fakeKit();
  const { c } = controllerWith(kit);
  kit.fire('session_proposal', proposal());
  await c.rejectProposal(1);
  kit.fire('session_proposal', { ...proposal({ requiredNamespaces: { eip155: { chains: ['eip155:250'], methods: [], events: [] } } }), id: 2 });
  await c.rejectProposal(2);
  assert.deepEqual(kit.calls.map((x) => [x[0], x[1].reason.code]), [['rejectSession', 5000], ['rejectSession', 5100]]);
  await assert.rejects(c.approveProposal(3), /no longer pending/);
});

test('controller: a request waits for the user; approve responds with the result, reject with 5000', async () => {
  const kit = fakeKit({ [TOPIC]: session() });
  const { c, last } = controllerWith(kit);
  kit.fire('session_request', req('personal_sign', ['0x68656c6c6f', ME], 'eip155:3961', 11));
  kit.fire('session_request', req('personal_sign', ['0x68656c6c6f', ME], 'eip155:3961', 12));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(last().requests.map((r) => r.id), [11, 12]);
  assert.equal(kit.calls.length, 0, 'nothing is answered without the user');

  const sig = await signForRequest(last().requests[0], KEY);
  await c.approveRequest(11, sig);
  await c.rejectRequest(12);
  const responses = kit.calls.filter((x) => x[0] === 'respond').map((x) => x[1]);
  assert.deepEqual(responses[0], { topic: TOPIC, response: { id: 11, jsonrpc: '2.0', result: sig } });
  assert.deepEqual(responses[1], { topic: TOPIC, response: { id: 12, jsonrpc: '2.0', error: SDK_ERRORS.USER_REJECTED } });
  assert.equal(last().requests.length, 0);
});

test('controller: unsupported methods are refused at once; blocked requests are refused with their reason', async () => {
  const kit = fakeKit({ [TOPIC]: session() });
  const { c, last } = controllerWith(kit);
  kit.fire('session_request', req('eth_signTransaction', [{}], 'eip155:3961', 21));
  await new Promise((r) => setImmediate(r));
  assert.equal(last().requests.length, 0);
  assert.match(last().notice, /not supported/);
  assert.deepEqual(kit.calls[0][1].response.error, SDK_ERRORS.UNSUPPORTED_METHODS);

  kit.fire('session_request', req('personal_sign', ['0x00', OTHER], 'eip155:3961', 22));
  await new Promise((r) => setImmediate(r));
  assert.equal(last().requests.length, 1, 'shown to the user so they see what was refused');
  await c.rejectRequest(22);
  assert.equal(kit.calls[1][1].response.error.code, -32602);
});

test('controller: switching to a chain outside the session grants it, emits chainChanged, answers null', async () => {
  const kit = fakeKit({ [TOPIC]: session([3961]) });
  const { c } = controllerWith(kit);
  kit.fire('session_request', req('wallet_switchEthereumChain', [{ chainId: '0x2105' }], 'eip155:3961', 31));
  await new Promise((r) => setImmediate(r));
  await c.approveChainRequest(31);
  const names = kit.calls.map((x) => x[0]);
  assert.deepEqual(names, ['update', 'event', 'respond']);
  assert.deepEqual(kit.calls[0][1].namespaces.eip155.chains, ['eip155:3961', 'eip155:8453']);
  assert.deepEqual(kit.calls[1][1], { topic: TOPIC, event: { name: 'chainChanged', data: 8453 }, chainId: 'eip155:8453' });
  assert.deepEqual(kit.calls[2][1].response, { id: 31, jsonrpc: '2.0', result: null });
});

test('controller: switching the active account shares it with no site; a session keeps the account it was approved for', async () => {
  const kit = fakeKit({ [TOPIC]: session([3961, 56]) });
  const { c, setAddress, last } = controllerWith(kit);
  setAddress(OTHER);
  await c.syncAccount(OTHER);
  assert.deepEqual(kit.calls, [], 'no updateSession, no accountsChanged: the site never learns OTHER');
  assert.deepEqual(last().sessions[0].addresses, [ME.toLowerCase()]);
  // its requests for ME are refused while OTHER is active, and answerable again after switching back
  kit.fire('session_request', req('personal_sign', ['0x00', ME], 'eip155:3961', 61));
  await new Promise((r) => setImmediate(r));
  assert.match(last().requests[0].blockers[0], /not the active account/);
  setAddress(ME);
  await c.syncAccount(ME);
  assert.deepEqual(kit.calls.filter((x) => x[0] !== 'respond'), [], 'switching back needs no event either: the site never left ME');
  assert.deepEqual(c.state().requests[0].blockers, []);
});

test('controller: a session approved for several accounts is told when one of them becomes active', async () => {
  const multi = session([3961]);
  multi.namespaces.eip155.accounts = [`eip155:3961:${ME}`, `eip155:3961:${OTHER}`];
  const kit = fakeKit({ [TOPIC]: multi });
  const { c } = controllerWith(kit);
  await c.syncAccount(OTHER);
  assert.deepEqual(kit.calls.map((x) => [x[0], x[1].event]), [['event', { name: 'accountsChanged', data: [OTHER] }]]);
});

test('controller: sharing the active account with a site is an explicit choice (shareAccount)', async () => {
  const kit = fakeKit({ [TOPIC]: session([3961, 56]) });
  const { c } = controllerWith(kit);
  await c.shareAccount(TOPIC, OTHER);
  assert.deepEqual(kit.calls[0][1].namespaces.eip155.accounts, [`eip155:3961:${OTHER}`, `eip155:56:${OTHER}`]);
  assert.deepEqual(kit.calls[1][1].event, { name: 'accountsChanged', data: [OTHER] });
  await assert.rejects(c.shareAccount('f'.repeat(64), OTHER), /no longer connected/);
});

test('controller: disconnect drops the session and its queued requests; expiry clears the queue with a notice', async () => {
  const kit = fakeKit({ [TOPIC]: session() });
  const { c, last, used } = controllerWith(kit);
  kit.fire('session_request', req('personal_sign', ['0x00', ME], 'eip155:3961', 41));
  kit.fire('session_request', req('personal_sign', ['0x00', ME], 'eip155:3961', 42));
  await new Promise((r) => setImmediate(r));
  kit.fire('session_request_expire', { id: 42 });
  assert.match(last().notice, /expired/);
  await c.disconnect(TOPIC);
  assert.deepEqual(kit.calls[0], ['disconnect', { topic: TOPIC, reason: SDK_ERRORS.USER_DISCONNECTED }]);
  assert.equal(last().requests.length, 0);
  assert.equal(last().sessions.length, 0);
  assert.equal(used[used.length - 1], false);
});

test('controller: requests that arrived while the page was closed are picked up; nothing is shown while locked', async () => {
  const kit = fakeKit({ [TOPIC]: session() });
  kit.pending = [req('personal_sign', ['0x00', ME], 'eip155:3961', 51)];
  const { last, setAddress, c } = controllerWith(kit);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(last().requests.map((r) => r.id), [51]);
  setAddress(null);
  assert.deepEqual(c.state().requests, [], 'locked: nothing to approve');
  setAddress(ME);
  assert.equal(c.state().requests.length, 1, 'unlocked again: still waiting');
});

test('signForRequest refuses a key that is not the reviewed account', async () => {
  const v = reviewRequest(req('personal_sign', ['0x00', ME]), session(), ME);
  await assert.rejects(signForRequest(v, Wallet.createRandom().privateKey), /does not match/);
  assert.ok(getBytes(v.detail.hex).length === 1);
});
