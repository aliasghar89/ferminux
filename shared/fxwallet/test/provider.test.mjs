// Unit tests for the Ferminux Wallet provider (shared/fxwallet/provider.ts),
// driven through a fake window: window.open returns a fake popup whose
// postMessage lands in a scripted "wallet", and the wallet answers by
// dispatching message events on the fake window — with the origin and source
// a real browser would stamp on them.
//
// Run: node --test shared/fxwallet/test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFerminuxWalletProvider, parseSession, isPhoneLike, resolveWalletUrls, OFFICIAL_WALLET_URLS } from '../provider.ts';
import { ERR } from '../errors.ts';
import { PROTOCOL } from '../protocol.ts';

const WALLET = 'https://wallet.example';
const DAPP = 'https://dapp.example';
const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

/** A fake browser window plus a scripted wallet on the other end of window.open. */
function harness({ wallet, block = false, storage = memoryStorage(), fetchImpl, walletOrigins = [WALLET], origin = DAPP } = {}) {
  const listeners = new Map();
  const timers = new Set();
  const opened = [];
  const win = {
    location: { origin },
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126', maxTouchPoints: 0 },
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t).add(fn);
    },
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    clearInterval: (id) => {
      clearInterval(id);
      timers.delete(id);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    open(url, name, features) {
      if (block) return null;
      const popup = {
        closed: false,
        url,
        name,
        features,
        inbox: [],
        targets: [],
        postMessage(msg, targetOrigin) {
          assert.ok(walletOrigins.includes(targetOrigin), 'the dApp must post to a wallet origin only');
          this.inbox.push(msg);
          this.targets.push(targetOrigin);
          queueMicrotask(() => wallet?.onRequest?.(msg, reply, popup));
        },
        close() {
          this.closed = true;
        },
      };
      const reply = (data, { origin = WALLET, source = popup } = {}) => dispatch('message', { data, origin, source });
      opened.push(popup);
      queueMicrotask(() => (wallet?.onOpen ?? ((r) => r({ protocol: PROTOCOL, type: 'ready' })))(reply, popup));
      return popup;
    },
  };
  function dispatch(type, event) {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  }
  const env = {
    window: win,
    storage,
    fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) })),
  };
  const cleanup = () => {
    for (const id of timers) clearInterval(id);
  };
  return { env, opened, storage, dispatch, cleanup };
}

/** A wallet that approves connect with A1 and answers other methods from a table. */
function approvingWallet(answers = {}) {
  return {
    seen: [],
    onRequest(msg, reply) {
      this.seen.push(msg);
      reply({ protocol: PROTOCOL, type: 'ack', id: msg.id });
      if (msg.method === 'eth_requestAccounts') return reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A1] });
      if (msg.method in answers) {
        const a = answers[msg.method];
        return reply({ protocol: PROTOCOL, type: 'response', id: msg.id, ...(a.error ? { error: a.error } : { result: a.result }) });
      }
      reply({ protocol: PROTOCOL, type: 'response', id: msg.id, error: { code: 4200, message: 'nope' } });
    },
  };
}

test('a fresh provider knows 3961 and no account, and routes nothing to the popup for it', async () => {
  const h = harness({});
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  assert.equal(p.isFerminuxWallet, true);
  assert.equal(p.walletOrigin, WALLET);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  assert.equal(await p.request({ method: 'eth_chainId' }), '0xf79');
  assert.equal(h.opened.length, 0, 'eth_accounts / eth_chainId never open the wallet');
  h.cleanup();
});

test('eth_requestAccounts opens the wallet with the dApp origin, remembers the account and emits events', async () => {
  const wallet = approvingWallet();
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, appName: 'Test dApp', statusFrame: false });
  const events = [];
  p.on('connect', (e) => events.push(['connect', e.chainId]));
  p.on('accountsChanged', (a) => events.push(['accountsChanged', a]));

  const accounts = await p.request({ method: 'eth_requestAccounts' });
  assert.deepEqual(accounts, [A1]);
  assert.equal(h.opened.length, 1);
  const url = new URL(h.opened[0].url);
  assert.equal(url.origin + url.pathname, `${WALLET}/connect.html`);
  const hash = new URLSearchParams(url.hash.slice(1));
  assert.equal(hash.get('origin'), DAPP);
  assert.equal(hash.get('app'), 'Test dApp');
  assert.match(h.opened[0].features, /popup=yes,width=420,height=720/);
  assert.equal(wallet.seen[0].chainId, 3961);
  assert.deepEqual(events, [['connect', '0xf79'], ['accountsChanged', [A1]]]);
  assert.deepEqual(parseSession(h.storage.dump()[`ferminux.fxwallet.session.v1|${WALLET}`], 3961), { accounts: [A1], chainId: 3961 });

  // Already connected: no second window.
  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), [A1]);
  assert.equal(h.opened.length, 1);
  h.cleanup();
});

test('a phone gets a tab (no window features)', async () => {
  const h = harness({ wallet: approvingWallet() });
  h.env.window.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 };
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await p.request({ method: 'eth_requestAccounts' });
  assert.equal(h.opened[0].features, undefined);
  assert.equal(isPhoneLike({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), true, 'iPadOS');
  h.cleanup();
});

test('messages from any other origin or window are ignored', async () => {
  let replyRef;
  const wallet = {
    onRequest(msg, reply, popup) {
      replyRef = { msg, reply, popup };
    },
  };
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  const pending = p.request({ method: 'eth_requestAccounts' });
  await new Promise((r) => setTimeout(r, 10));
  const { msg, reply } = replyRef;
  // Forged from another origin, and from another window of the right origin.
  reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A2] }, { origin: 'https://evil.example' });
  reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A2] }, { source: {} });
  // Then the real answer.
  reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A1] });
  assert.deepEqual(await pending, [A1]);
  h.cleanup();
});

test('signing needs a connected account; the wallet gets the chain with every request', async () => {
  const wallet = approvingWallet({ personal_sign: { result: '0x' + 'ab'.repeat(65) } });
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await assert.rejects(p.request({ method: 'personal_sign', params: ['0x68656c6c6f', A1] }), (e) => e.code === ERR.UNAUTHORIZED);
  await p.request({ method: 'eth_requestAccounts' });
  await assert.rejects(p.request({ method: 'personal_sign', params: ['0x68656c6c6f', A2] }), (e) => e.code === ERR.UNAUTHORIZED, 'an account the site was not given');
  const sig = await p.request({ method: 'personal_sign', params: ['0x68656c6c6f', A1] });
  assert.equal(sig, '0x' + 'ab'.repeat(65));
  assert.equal(wallet.seen.at(-1).method, 'personal_sign');
  assert.equal(wallet.seen.at(-1).chainId, 3961);
  // A message that is itself 20 bytes of hex is the message, not the account: the address slot decides.
  assert.equal(await p.request({ method: 'personal_sign', params: [A2, A1] }), '0x' + 'ab'.repeat(65));
  // The legacy [address, message] order still names the account.
  assert.equal(await p.request({ method: 'personal_sign', params: [A1, '0x68656c6c6f'] }), '0x' + 'ab'.repeat(65));
  h.cleanup();
});

test('eth_sendTransaction fills in `from`, refuses a chainId that is not the current chain', async () => {
  const wallet = approvingWallet({ eth_sendTransaction: { result: '0x' + '12'.repeat(32) } });
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await p.request({ method: 'eth_requestAccounts' });
  const hash = await p.request({ method: 'eth_sendTransaction', params: [{ to: A2, value: '0x1' }] });
  assert.equal(hash, '0x' + '12'.repeat(32));
  assert.equal(wallet.seen.at(-1).params[0].from, A1);
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ to: A2, chainId: '0x1' }] }), (e) => e.code === ERR.INVALID_PARAMS);
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ to: A2, value: 1n }] }), (e) => e.code === ERR.INVALID_PARAMS, 'BigInt cannot cross postMessage as JSON');
  h.cleanup();
});

test('switching chains is local, limited to the 8 known chains, and emits chainChanged', async () => {
  const h = harness({ wallet: approvingWallet() });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  const changes = [];
  p.on('chainChanged', (c) => changes.push(c));
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x38');
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  assert.deepEqual(changes, ['0x38'], 'no event when nothing changed');
  await assert.rejects(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x5' }] }), (e) => e.code === ERR.UNRECOGNIZED_CHAIN);
  assert.equal(await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xa4b1', rpcUrls: ['https://evil.example'] }] }), null);
  await assert.rejects(p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x5' }] }), (e) => e.code === ERR.INVALID_PARAMS);
  assert.equal(h.opened.length, 0, 'none of this needs the wallet window');
  h.cleanup();
});

test('reads go to the RPC of the current chain, never the popup; errors keep their code and data', async () => {
  const calls = [];
  const h = harness({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push([url, body.method]);
      if (url.includes('down')) throw new Error('ECONNREFUSED');
      if (body.method === 'eth_call') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x2a' }) };
    },
  });
  const p = createFerminuxWalletProvider({
    env: h.env,
    walletUrl: `${WALLET}/connect.html`,
    statusFrame: false,
    rpcUrls: { 3961: ['https://down.example', 'https://up.example'], 56: ['https://bsc.example'] },
  });
  assert.equal(await p.request({ method: 'eth_blockNumber' }), '0x2a');
  assert.deepEqual(calls.slice(0, 2), [['https://down.example', 'eth_blockNumber'], ['https://up.example', 'eth_blockNumber']]);
  await p.request({ method: 'eth_getBalance', params: [A1, 'latest'] });
  assert.equal(calls.at(-1)[0], 'https://up.example', 'stays on the endpoint that answered');
  await assert.rejects(p.request({ method: 'eth_call', params: [{ to: A1 }, 'latest'] }), (e) => e.code === 3 && e.data === '0x08c379a0');
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  await p.request({ method: 'eth_blockNumber' });
  assert.equal(calls.at(-1)[0], 'https://bsc.example');
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  await assert.rejects(p.request({ method: 'eth_blockNumber' }), (e) => e.code === ERR.CHAIN_DISCONNECTED, 'no RPC configured for chain 1 on this site');
  await assert.rejects(p.request({ method: 'debug_traceTransaction', params: [] }), (e) => e.code === ERR.UNSUPPORTED_METHOD);
  await assert.rejects(p.request({ method: 'eth_sign', params: [A1, '0x00'] }), (e) => e.code === ERR.UNSUPPORTED_METHOD);
  assert.equal(h.opened.length, 0);
  h.cleanup();
});

test('a remembered session reconnects silently on the next page load', async () => {
  const storage = memoryStorage();
  const h1 = harness({ wallet: approvingWallet(), storage });
  const p1 = createFerminuxWalletProvider({ env: h1.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await p1.request({ method: 'eth_requestAccounts' });
  await p1.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
  h1.cleanup();

  const h2 = harness({ storage });
  const p2 = createFerminuxWalletProvider({ env: h2.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  assert.deepEqual(await p2.request({ method: 'eth_accounts' }), [A1]);
  assert.equal(await p2.request({ method: 'eth_chainId' }), '0x2105');
  assert.equal(p2.isConnected(), true);
  assert.equal(h2.opened.length, 0);

  // A session stored for a different wallet origin is not this one.
  const h3 = harness({ storage });
  const p3 = createFerminuxWalletProvider({ env: h3.env, walletUrl: 'https://other-wallet.example/connect.html', statusFrame: false });
  assert.deepEqual(await p3.request({ method: 'eth_accounts' }), []);
  h2.cleanup();
  h3.cleanup();
});

test('4100 from the wallet (site revoked) clears the session and emits disconnect', async () => {
  const wallet = approvingWallet({ personal_sign: { error: { code: 4100, message: 'This site is not connected.' } } });
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await p.request({ method: 'eth_requestAccounts' });
  const seen = [];
  p.on('accountsChanged', (a) => seen.push(a));
  p.on('disconnect', (e) => seen.push(e.code));
  await assert.rejects(p.request({ method: 'personal_sign', params: ['0x00', A1] }), (e) => e.code === 4100);
  assert.deepEqual(seen, [[], ERR.DISCONNECTED]);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  assert.deepEqual(Object.keys(h.storage.dump()), [`ferminux.fxwallet.wallet.v1|${WALLET}`], 'the session is gone; only which wallet origin to open stays');
  h.cleanup();
});

test('closing the wallet window rejects with 4001', async () => {
  const wallet = {
    onRequest(msg, reply, popup) {
      reply({ protocol: PROTOCOL, type: 'ack', id: msg.id });
      setTimeout(() => (popup.closed = true), 20); // the user closes it
    },
  };
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  const t0 = Date.now();
  await assert.rejects(p.request({ method: 'eth_requestAccounts' }), (e) => e.code === ERR.USER_REJECTED);
  assert.ok(Date.now() - t0 >= 600, 'waits a grace period for a response already in flight');
  h.cleanup();
});

test('a response posted just before the window closed still wins', async () => {
  const wallet = {
    onRequest(msg, reply, popup) {
      reply({ protocol: PROTOCOL, type: 'ack', id: msg.id });
      popup.closed = true;
      setTimeout(() => reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A1] }), 300);
    },
  };
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), [A1]);
  h.cleanup();
});

test('one open window serves several requests; a reloaded wallet gets the queue again', async () => {
  let readyCount = 0;
  const wallet = {
    onOpen(reply) {
      readyCount += 1;
      reply({ protocol: PROTOCOL, type: 'ready' });
    },
    received: [],
    onRequest(msg, reply) {
      this.received.push(msg.id);
      if (this.received.length === 1) {
        // the page reloads before answering: it sends ready again
        setTimeout(() => reply({ protocol: PROTOCOL, type: 'ready' }), 5);
        return;
      }
      reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A1] });
    },
  };
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), [A1]);
  assert.equal(wallet.received.length, 2, 'the request was re-sent to the reloaded page');
  assert.equal(wallet.received[0], wallet.received[1], 'with the same id');
  assert.equal(readyCount, 1);
  assert.equal(h.opened.length, 1);
  h.cleanup();
});

test('pop-up blocked without a DOM: the request fails with a clear error instead of hanging', async () => {
  const h = harness({ block: true });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await assert.rejects(p.request({ method: 'eth_requestAccounts' }), (e) => e.code === ERR.RESOURCE_UNAVAILABLE && /blocked/.test(e.message));
  h.cleanup();
});

test('disconnect forgets the site and emits accountsChanged([]) + disconnect', async () => {
  const h = harness({ wallet: approvingWallet() });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await p.request({ method: 'eth_requestAccounts' });
  const seen = [];
  p.on('accountsChanged', (a) => seen.push(a));
  p.on('disconnect', (e) => seen.push(e.code));
  await p.disconnect();
  assert.deepEqual(seen, [[], 4900]);
  assert.equal(p.isConnected(), false);
  h.cleanup();
});

test('disconnect with no status frame asks the wallet window to forget the site (a dApp on another site)', async () => {
  const wallet = approvingWallet({ wallet_revokePermissions: { result: null } });
  const h = harness({ wallet });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  await p.request({ method: 'eth_requestAccounts' });
  h.opened[0].closed = true; // the connect window closed itself
  await p.disconnect();
  assert.equal(p.isConnected(), false, 'disconnected here at once');
  assert.equal(h.opened.length, 2, 'the window opened synchronously, inside the click');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(wallet.seen.at(-1).method, 'wallet_revokePermissions');
  assert.deepEqual(new URLSearchParams(new URL(h.opened[1].url).hash.slice(1)).get('origin'), DAPP);
  // A dApp with nothing connected has nothing to revoke: no window.
  await p.disconnect();
  assert.equal(h.opened.length, 2);
  h.cleanup();
});

test('another tab connecting or disconnecting is followed through the storage event', async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html`, statusFrame: false });
  const key = `ferminux.fxwallet.session.v1|${WALLET}`;
  const value = JSON.stringify({ accounts: [A2], chainId: 3961 });
  h.dispatch('storage', { key, newValue: value });
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A2]);
  h.dispatch('storage', { key, newValue: null });
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  h.cleanup();
});

test('parseSession rejects junk and unknown chains', () => {
  assert.equal(parseSession(null, 3961), null);
  assert.equal(parseSession('{', 3961), null);
  assert.equal(parseSession(JSON.stringify({ accounts: ['0xnope'] }), 3961), null);
  assert.deepEqual(parseSession(JSON.stringify({ accounts: [A1], chainId: 5 }), 3961), { accounts: [A1], chainId: 3961 });
});

/* ---------------- status frame (same-site revoke detection) ---------------- */

function fakeDocument() {
  const frames = [];
  const doc = {
    body: {
      appendChild(el) {
        frames.push(el);
        queueMicrotask(() => el.listeners.load?.());
      },
    },
    createElement(tag) {
      return {
        tag,
        style: {},
        attrs: {},
        listeners: {},
        removed: false,
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        addEventListener(t, fn) {
          this.listeners[t] = fn;
        },
        remove() {
          this.removed = true;
        },
        contentWindow: {
          inbox: [],
          postMessage(m, o) {
            assert.equal(o, WALLET, 'the frame is only ever addressed by the wallet origin');
            this.inbox.push(m.type);
          },
        },
      };
    },
    addEventListener() {},
  };
  return { doc, frames };
}

function rememberedHarness() {
  const storage = memoryStorage();
  storage.setItem(`ferminux.fxwallet.session.v1|${WALLET}`, JSON.stringify({ accounts: [A1], chainId: 3961 }));
  const h = harness({ storage });
  const { doc, frames } = fakeDocument();
  h.env.window.document = doc;
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: `${WALLET}/connect.html` });
  const fromFrame = (f, data) => h.dispatch('message', { data: { protocol: PROTOCOL, ...data }, origin: WALLET, source: f.contentWindow });
  return { h, p, frames, fromFrame };
}

test('status frame: a remembered session asks the wallet, and a revoked site is disconnected', async () => {
  const { h, p, frames, fromFrame } = rememberedHarness();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, `${WALLET}/connect.html#fxw-frame`);
  assert.deepEqual(frames[0].contentWindow.inbox, ['status'], 'asked on load');
  fromFrame(frames[0], { type: 'ready' });
  assert.deepEqual(frames[0].contentWindow.inbox, ['status', 'status'], 'asked again once the frame listens');
  const seen = [];
  p.on('disconnect', (e) => seen.push(e.code));
  // A forged answer from another origin changes nothing.
  h.dispatch('message', {
    data: { protocol: PROTOCOL, type: 'status', authoritative: true, approved: false, accounts: [] },
    origin: 'https://evil.example',
    source: frames[0].contentWindow,
  });
  assert.equal(p.isConnected(), true);
  fromFrame(frames[0], { type: 'status', authoritative: true, approved: false, accounts: [] });
  assert.equal(p.isConnected(), false);
  assert.deepEqual(seen, [4900]);
  assert.equal(frames[0].removed, true);
  h.cleanup();
});

test('status frame: a cross-site (non-authoritative) answer keeps the session and drops the frame', async () => {
  const { h, p, frames, fromFrame } = rememberedHarness();
  await new Promise((r) => setTimeout(r, 5));
  fromFrame(frames[0], { type: 'status', authoritative: false, approved: false, accounts: [] });
  assert.equal(p.isConnected(), true);
  assert.equal(frames[0].removed, true);
  h.cleanup();
});

test('disconnect keeps the frame until the wallet confirms it forgot the site', async () => {
  const { h, p, frames, fromFrame } = rememberedHarness();
  await new Promise((r) => setTimeout(r, 5));
  // the frame reads the wallet's own storage (a dApp on the wallet's site): it carries the forget
  fromFrame(frames[0], { type: 'status', authoritative: true, approved: true, accounts: [A1] });
  await p.disconnect();
  assert.equal(h.opened.length, 0, 'no wallet window needed');
  assert.equal(p.isConnected(), false);
  assert.equal(frames[0].removed, false, 'still there to deliver the forget');
  assert.deepEqual(frames[0].contentWindow.inbox.slice(-1), ['forget']);
  fromFrame(frames[0], { type: 'ready' });
  assert.deepEqual(frames[0].contentWindow.inbox.slice(-2), ['forget', 'forget'], 're-sent when a late frame starts listening');
  fromFrame(frames[0], { type: 'status', authoritative: true, approved: false, accounts: [] });
  assert.equal(frames[0].removed, true, 'removed once confirmed');
  h.cleanup();
});

test('disconnect before the frame has answered goes through the wallet window (the frame may never answer)', async () => {
  const { h, p, frames } = rememberedHarness();
  await new Promise((r) => setTimeout(r, 5));
  await p.disconnect();
  assert.equal(p.isConnected(), false);
  assert.equal(frames[0].removed, true, 'the unanswered frame is simply dropped');
  assert.equal(h.opened.length, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(h.opened[0].inbox.map((m) => m.method), ['wallet_revokePermissions']);
  h.cleanup();
});

/* ---------------- one wallet, two origins ---------------- */

const TWIN = 'https://twin.example';
const TWIN_URL = `${TWIN}/wallet/connect.html`;

test('the wallet window may move to the wallet\'s other origin: the queue follows it there, and that origin opens first next time', async () => {
  const storage = memoryStorage();
  // The window opens at WALLET (no vault there), the user sends it to TWIN, TWIN approves.
  const wallet = {
    seen: [],
    onRequest(msg, reply, popup) {
      this.seen.push([popup.targets.at(-1), msg.method]);
      if (popup.targets.at(-1) === WALLET) {
        reply({ protocol: PROTOCOL, type: 'ack', id: msg.id });
        // An answer from the new origin before it said ready is not heard.
        reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A2] }, { origin: TWIN });
        // "My wallet is at twin.example": the same window, now on the other origin.
        setTimeout(() => reply({ protocol: PROTOCOL, type: 'ready' }, { origin: TWIN }), 5);
        return;
      }
      reply({ protocol: PROTOCOL, type: 'ack', id: msg.id }, { origin: TWIN });
      // The old origin can no longer answer for this window.
      reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A2] }, { origin: WALLET });
      reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A1] }, { origin: TWIN });
    },
  };
  const h = harness({ wallet, storage, walletOrigins: [WALLET, TWIN] });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: [`${WALLET}/connect.html`, TWIN_URL], statusFrame: false });
  assert.deepEqual(p.walletOrigins, [WALLET, TWIN]);
  assert.equal(p.walletOrigin, WALLET);
  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), [A1]);
  assert.deepEqual(wallet.seen, [[WALLET, 'eth_requestAccounts'], [TWIN, 'eth_requestAccounts']], 're-sent, to the new origin only');
  assert.equal(p.walletOrigin, TWIN);
  assert.equal(new URL(h.opened[0].url).origin, WALLET);
  h.cleanup();

  // Next visit: the session loads as before, and the next window opens at the origin that connected.
  const h2 = harness({ wallet: approvingWallet({ personal_sign: { result: '0x' + 'cd'.repeat(65) } }), storage, walletOrigins: [WALLET, TWIN] });
  const p2 = createFerminuxWalletProvider({ env: h2.env, walletUrl: [`${WALLET}/connect.html`, TWIN_URL], statusFrame: false });
  assert.deepEqual(await p2.request({ method: 'eth_accounts' }), [A1]);
  assert.equal(p2.walletOrigin, TWIN);
  const pending = p2.request({ method: 'personal_sign', params: ['0x00', A1] });
  assert.equal(new URL(h2.opened[0].url).origin + new URL(h2.opened[0].url).pathname, TWIN_URL);
  h2.opened[0].closed = true;
  await assert.rejects(pending, (e) => e.code === ERR.USER_REJECTED);
  h2.cleanup();
});

test('only the exact wallet origins are heard: a look-alike origin, or the right origin in another window, is not', async () => {
  let ref;
  const h = harness({ wallet: { onRequest: (msg, reply) => (ref = { msg, reply }) }, walletOrigins: [WALLET, TWIN] });
  const p = createFerminuxWalletProvider({ env: h.env, walletUrl: [`${WALLET}/connect.html`, TWIN_URL], statusFrame: false });
  const pending = p.request({ method: 'eth_requestAccounts' });
  await new Promise((r) => setTimeout(r, 5));
  const { msg, reply } = ref;
  for (const origin of [`${WALLET}.evil.example`, 'https://evil.example', TWIN.replace('https', 'http')]) {
    reply({ protocol: PROTOCOL, type: 'ready' }, { origin });
    reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A2] }, { origin });
  }
  reply({ protocol: PROTOCOL, type: 'ready' }, { origin: TWIN, source: {} });
  reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A2] }, { origin: TWIN, source: {} });
  reply({ protocol: PROTOCOL, type: 'response', id: msg.id, result: [A1] });
  assert.deepEqual(await pending, [A1]);
  assert.equal(p.walletOrigin, WALLET);
  h.cleanup();
});

test('the official wallet URL brings its other origin with it; a custom one stands alone', () => {
  assert.deepEqual(resolveWalletUrls(undefined).map(String), OFFICIAL_WALLET_URLS);
  assert.deepEqual(resolveWalletUrls('https://ferminux.net/wallet/connect.html').map((u) => u.origin), ['https://ferminux.net', 'https://wallet.ferminux.net']);
  assert.deepEqual(resolveWalletUrls('http://127.0.0.1:5301/connect.html, http://localhost:5302/wallet/connect.html#x').map(String), [
    'http://127.0.0.1:5301/connect.html',
    'http://localhost:5302/wallet/connect.html',
  ]);
  assert.deepEqual(resolveWalletUrls(`${WALLET}/connect.html`).map(String), [`${WALLET}/connect.html`]);
  assert.deepEqual(resolveWalletUrls([`${WALLET}/connect.html`, `${WALLET}/other/connect.html`]).map(String), [`${WALLET}/connect.html`], 'one page per origin');
});
