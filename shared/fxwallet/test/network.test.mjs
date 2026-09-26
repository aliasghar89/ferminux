// ensureFerminuxChain (shared/fxwallet/network.ts) against scripted wallets:
// an extension that knows 3961, one that must add it, one that adds without
// switching, people who say no, wallets that cannot add networks, and
// WalletConnect sessions that do or do not grow to include 3961.
//
// Run: node --test shared/fxwallet/test/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChainSetupError,
  FERMINUX_ADD_CHAIN_PARAMS,
  FERMINUX_NETWORK_DETAILS,
  ensureFerminuxChain,
  isUserRejection,
  manualNetworkText,
  sessionHasChain,
} from '../network.ts';
import { walletConnectInitOptions, FEATURED_WALLETCONNECT_WALLETS, FERMINUX_APP_ICON_URL } from '../connector.ts';

const ME = '0x1111111111111111111111111111111111111111';

/**
 * A scripted wallet. `knows` = chains it has; `onSwitch`/`onAdd` may throw or
 * change state. Every request is logged.
 */
function wallet({ chain = 1, knows = [1, 56], onSwitch, onAdd, wc = null } = {}) {
  const w = {
    chain,
    knows: new Set(knows),
    log: [],
    isWalletConnect: wc ? true : undefined,
    session: wc ?? undefined,
    async request({ method, params }) {
      w.log.push(method);
      if (method === 'eth_chainId') return '0x' + w.chain.toString(16);
      if (method === 'wallet_switchEthereumChain') {
        const id = parseInt(params[0].chainId, 16);
        if (onSwitch) return onSwitch(w, id);
        if (!w.knows.has(id)) throw Object.assign(new Error(`Unrecognized chain ID "${params[0].chainId}".`), { code: 4902 });
        w.chain = id;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        w.added = params[0];
        if (onAdd) return onAdd(w, params[0]);
        const id = parseInt(params[0].chainId, 16);
        w.knows.add(id);
        w.chain = id; // like MetaMask: adding also switches
        return null;
      }
      throw Object.assign(new Error('unsupported'), { code: 4200 });
    },
  };
  return w;
}

test('the add-chain parameters are the public Ferminux network', () => {
  assert.deepEqual(FERMINUX_ADD_CHAIN_PARAMS, {
    chainId: '0xf79',
    chainName: 'Ferminux',
    nativeCurrency: { name: 'Ferminux', symbol: 'FMX', decimals: 18 },
    rpcUrls: ['https://rpc.ferminux.net'],
    blockExplorerUrls: ['https://explorer.ferminux.net'],
    iconUrls: ['https://ferminux.net/assets/brand/favicon.svg', 'https://ferminux.net/assets/brand/icon-512.png'],
  });
  const text = manualNetworkText();
  for (const [, v] of FERMINUX_NETWORK_DETAILS) assert.ok(text.includes(v), v);
  assert.ok(text.includes('Chain ID: 3961'));
});

test('already on Ferminux: nothing is asked', async () => {
  const w = wallet({ chain: 3961, knows: [3961] });
  await ensureFerminuxChain(w);
  assert.deepEqual(w.log, ['eth_chainId']);
});

test('a wallet that knows Ferminux is switched', async () => {
  const w = wallet({ chain: 1, knows: [1, 3961] });
  const steps = [];
  await ensureFerminuxChain(w, { onStep: (s) => steps.push(s) });
  assert.equal(w.chain, 3961);
  assert.deepEqual(steps, ['switch']);
  assert.equal(w.log.includes('wallet_addEthereumChain'), false);
});

test('a wallet that has never seen Ferminux: 4902, then the network is added', async () => {
  const w = wallet({ chain: 56 });
  const steps = [];
  await ensureFerminuxChain(w, { onStep: (s) => steps.push(s) });
  assert.equal(w.chain, 3961);
  assert.deepEqual(steps, ['switch', 'add']);
  assert.deepEqual(w.added, FERMINUX_ADD_CHAIN_PARAMS);
});

test('"Unrecognized chain" under -32603, or no switch method at all, still leads to adding', async () => {
  const w1 = wallet({ onSwitch: () => { throw { code: -32603, message: 'Unrecognized chain ID 0xf79' }; }, onAdd: (w) => { w.chain = 3961; } });
  await ensureFerminuxChain(w1);
  assert.equal(w1.chain, 3961);
  const w2 = wallet({ onSwitch: () => { throw new Error('Missing or invalid. request() method: wallet_switchEthereumChain'); }, onAdd: (w) => { w.chain = 3961; } });
  await ensureFerminuxChain(w2);
  assert.equal(w2.chain, 3961);
});

test('a wallet that adds without switching is asked to switch once more', async () => {
  let switches = 0;
  const w = wallet({
    onSwitch: (w, id) => {
      switches += 1;
      if (!w.knows.has(id)) throw { code: 4902, message: 'unknown chain' };
      w.chain = id;
      return null;
    },
    onAdd: (w, p) => { w.knows.add(parseInt(p.chainId, 16)); return null; },
  });
  await ensureFerminuxChain(w, { settleMs: 300 });
  assert.equal(w.chain, 3961);
  assert.equal(switches, 2);
});

test('saying no to the switch or to adding: rejected, with the details to add it by hand', async () => {
  for (const make of [
    () => wallet({ onSwitch: () => { throw { code: 4001, message: 'User rejected the request.' }; } }),
    () => wallet({ onAdd: () => { throw { code: 5000, message: 'User rejected.' }; } }),
    () => wallet({ onAdd: () => { throw new Error('User denied network addition'); } }),
  ]) {
    const err = await ensureFerminuxChain(make()).then(() => null, (e) => e);
    assert.ok(err instanceof ChainSetupError);
    assert.equal(err.reason, 'rejected');
    assert.equal(err.manual, true);
    assert.match(err.message, /Chain ID: 3961/);
    assert.match(err.message, /https:\/\/rpc\.ferminux\.net/);
  }
});

test('a wallet that cannot add networks from a site: unsupported, names the wallet, offers Ferminux Wallet', async () => {
  const session = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`] } }, peer: { metadata: { name: 'Rainbow' } } };
  const w = wallet({ wc: session, onAdd: () => { throw new Error('Missing or invalid. request() method: wallet_addEthereumChain'); } });
  const err = await ensureFerminuxChain(w).then(() => null, (e) => e);
  assert.equal(err.reason, 'unsupported');
  assert.match(err.message, /^Rainbow could not add Ferminux/);
  assert.match(err.message, /Ferminux Wallet/);
  assert.match(err.message, /Network name: Ferminux/);
});

test('a request already open in the wallet: pending, and nothing else is sent', async () => {
  const w = wallet({ onSwitch: () => { throw { code: -32002, message: 'Request of type wallet_switchEthereumChain already pending' }; } });
  const err = await ensureFerminuxChain(w).then(() => null, (e) => e);
  assert.equal(err.reason, 'pending');
  assert.equal(w.log.includes('wallet_addEthereumChain'), false);
});

test('WalletConnect: the session must grow to include 3961 before it counts', async () => {
  const session = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`, `eip155:56:${ME}`], methods: [], events: [] } }, peer: { metadata: { name: 'MetaMask Wallet' } } };
  const w = wallet({
    wc: session,
    onAdd: (w) => {
      w.chain = 3961;
      // MetaMask Mobile answers first and sends session_update a moment later.
      setTimeout(() => session.namespaces.eip155.accounts.push(`eip155:3961:${ME}`), 150);
      return null;
    },
  });
  assert.equal(sessionHasChain(w), false);
  await ensureFerminuxChain(w, { settleMs: 2000 });
  assert.equal(sessionHasChain(w), true);
});

test('WalletConnect: switched but never shared with the session -> "session", reconnect', async () => {
  const session = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`] } }, peer: { metadata: { name: 'Trust Wallet' } } };
  const w = wallet({ wc: session });
  const err = await ensureFerminuxChain(w, { settleMs: 300 }).then(() => null, (e) => e);
  assert.equal(err.reason, 'session');
  assert.match(err.message, /^Trust Wallet switched to Ferminux/);
  assert.match(err.message, /connect again/);
  // The provider is put back on a chain the session has an account on.
  assert.equal(w.chain, 1);
});

test('accepted but never switched: timeout with the manual details', async () => {
  const w = wallet({ onSwitch: () => null });
  const err = await ensureFerminuxChain(w, { settleMs: 300 }).then(() => null, (e) => e);
  assert.equal(err.reason, 'timeout');
  assert.match(err.message, /Chain ID: 3961/);
});

test('user rejection is recognised in every shape wallets use', () => {
  assert.ok(isUserRejection({ code: 4001 }));
  assert.ok(isUserRejection({ code: 5000, message: 'User rejected.' }));
  assert.ok(isUserRejection(new Error('User rejected the request.')));
  assert.ok(isUserRejection({ error: { code: 4001 } }));
  assert.equal(isUserRejection({ code: 4902, message: 'Unrecognized chain' }), false);
});

test('WalletConnect proposal: every chain optional, 3961 first, RPCs for reads, popular wallets featured', () => {
  const o = walletConnectInitOptions(
    { appName: 'Ferminux DEX', rpcUrls: { 3961: ['https://rpc.ferminux.net'], 56: ['https://bsc-dataseed.bnbchain.org'] }, theme: 'light' },
    { projectId: 'p', load: async () => ({}), metadata: { name: 'Ferminux DEX', description: 'd', url: 'https://dex.ferminux.net', icons: [] } },
  );
  assert.equal(o.chains, undefined, 'no required chains: a wallet refuses a session whose required chains it does not know');
  assert.deepEqual(o.optionalChains, [3961, 1, 56, 8453, 42161, 137, 10, 43114]);
  assert.equal(o.rpcMap[3961], 'https://rpc.ferminux.net');
  assert.equal(o.rpcMap[56], 'https://bsc-dataseed.bnbchain.org');
  assert.equal(o.qrModalOptions.themeMode, 'light');
  assert.deepEqual(o.qrModalOptions.explorerRecommendedWalletIds, [...FEATURED_WALLETCONNECT_WALLETS]);
  assert.equal(o.qrModalOptions.explorerRecommendedWalletIds[0], 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96');
  assert.deepEqual(o.metadata.icons, [FERMINUX_APP_ICON_URL], 'a wallet is never shown a blank icon');
  assert.equal(o.telemetryEnabled, false);
});
