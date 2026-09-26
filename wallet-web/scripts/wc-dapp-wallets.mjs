#!/usr/bin/env node
// A Ferminux dApp over WalletConnect, against wallets that do NOT know chain
// 3961 — over the real WalletConnect relay.
//
// Each "wallet" below is a Reown WalletKit client in this process, scripted to
// answer the way a family of real wallets does:
//
//   metamask   knows only its built-in chains; wallet_switchEthereumChain to
//              3961 -> 4902; wallet_addEthereumChain -> adds, puts 3961 in the
//              session (session_update) and emits chainChanged. MetaMask
//              Mobile, Trust, OKX, Bitget, SafePal, Coinbase Wallet behave so.
//   eventfirst the same, but chainChanged arrives before the session_update
//              (the WalletConnect provider then briefly has no account).
//   known      the person added Ferminux before: 3961 is approved in the session.
//   noupdate   adds and switches, but never puts 3961 in the session.
//   rainbow    cannot add networks from a site: wallet_addEthereumChain -> 4200.
//   rejects    the person says no to adding the network (4001).
//
// It serves a dApp build (DAPP_DIST, built with VITE_WC_PROJECT_ID), opens it
// in Chromium, chooses WalletConnect in the dApp's own wallet chooser, copies
// the wc: link from the WalletConnect modal ("Copy link"), pairs the scripted
// wallet with it, and checks what the dApp shows afterwards. Nothing is signed
// or sent; the wallet keys are throwaway.
//
//   DAPP_DIST=../dex/ui/dist DAPP=dex WC_PROJECT_ID=… \
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/wc-dapp-wallets.mjs [profile…]
//
// Screenshots go to OUT (default: a temp dir). Skips (exit 0) without
// Playwright or a project id.

import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

const PROJECT_ID = (process.env.WC_PROJECT_ID ?? '').trim();
const DIST = resolve(process.env.DAPP_DIST ?? '../dex/ui/dist');
const DAPP = process.env.DAPP ?? 'dex';
const PORT = Number(process.env.PORT ?? 8642);
const PROFILES = process.argv.slice(2).length ? process.argv.slice(2) : ['metamask', 'eventfirst', 'known', 'noupdate', 'rainbow', 'rejects'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const skip = (why) => {
  console.log(`wc-dapp-wallets SKIPPED: ${why}`);
  process.exit(0);
};

async function loadPlaywright() {
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) {
    try {
      const mod = await import(spec);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch {
      /* next */
    }
  }
  return null;
}

/* ---------------- the scripted wallets ---------------- */

const BUILT_IN = [1, 56, 137, 10, 42161, 8453, 43114];
const PROFILE = {
  metamask: { name: 'Test wallet (MetaMask-like)', knows: BUILT_IN, add: 'accept', sessionUpdate: true },
  eventfirst: { name: 'Test wallet (event before update)', knows: BUILT_IN, add: 'accept', sessionUpdate: true, eventFirst: true },
  known: { name: 'Test wallet (Ferminux already added)', knows: [...BUILT_IN, 3961], add: 'accept', sessionUpdate: true },
  noupdate: { name: 'Test wallet (no session update)', knows: BUILT_IN, add: 'accept', sessionUpdate: false },
  rainbow: { name: 'Test wallet (Rainbow-like)', knows: BUILT_IN, add: 'unsupported', sessionUpdate: true },
  rejects: { name: 'Test wallet (person declines)', knows: BUILT_IN, add: 'reject', sessionUpdate: true },
};

function memoryStorage() {
  const m = new Map();
  return {
    getKeys: async () => [...m.keys()],
    getEntries: async () => [...m.entries()].map(([k, v]) => [k, JSON.parse(v)]),
    getItem: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : undefined),
    setItem: async (k, v) => void m.set(k, JSON.stringify(v)),
    removeItem: async (k) => void m.delete(k),
  };
}

async function scriptedWallet(profileName) {
  const profile = PROFILE[profileName];
  const { Core } = await import('@walletconnect/core');
  const { WalletKit } = await import('@reown/walletkit');
  const core = new Core({ projectId: PROJECT_ID, storage: memoryStorage(), customStoragePrefix: `sim-${profileName}-${Date.now()}`, telemetryEnabled: false });
  const kit = await WalletKit.init({
    core,
    metadata: { name: profile.name, description: 'Scripted test wallet', url: 'https://example.invalid', icons: [] },
  });
  const address = Wallet.createRandom().address;
  const log = [];
  let chain = null;
  let proposalSeen = null;

  kit.on('session_proposal', async (p) => {
    proposalSeen = p.params;
    const req = p.params.requiredNamespaces?.eip155?.chains ?? [];
    const opt = p.params.optionalNamespaces?.eip155?.chains ?? [];
    // A real wallet refuses a session whose REQUIRED chains it does not know.
    const unknownRequired = req.filter((c) => !profile.knows.includes(Number(c.split(':')[1])));
    if (unknownRequired.length) {
      log.push(['reject-proposal', unknownRequired]);
      await kit.rejectSession({ id: p.id, reason: { code: 5100, message: 'Unsupported chains.' } });
      return;
    }
    const ids = [...new Set([...req, ...opt].map((c) => Number(c.split(':')[1])))].filter((id) => profile.knows.includes(id));
    // Wallets put the chain they are on first; ours "is on" Ethereum.
    ids.sort((a, b) => (a === 1 ? -1 : b === 1 ? 1 : 0));
    chain = ids[0];
    const methods = [...new Set([...(p.params.optionalNamespaces?.eip155?.methods ?? []), ...(p.params.requiredNamespaces?.eip155?.methods ?? [])])];
    await kit.approveSession({
      id: p.id,
      namespaces: {
        eip155: {
          chains: ids.map((i) => `eip155:${i}`),
          accounts: ids.map((i) => `eip155:${i}:${address}`),
          methods,
          events: ['chainChanged', 'accountsChanged'],
        },
      },
    });
    log.push(['approved', ids]);
  });

  kit.on('session_request', async (r) => {
    const { topic, id, params } = r;
    const { method, params: rp } = params.request;
    log.push([method, params.chainId, rp?.[0]]);
    const respond = (body) => kit.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', ...body } });
    const session = kit.getActiveSessions()[topic];
    const known = new Set(profile.knows);
    if (method === 'wallet_switchEthereumChain') {
      const target = parseInt(rp[0].chainId, 16);
      if (!known.has(target)) return respond({ error: { code: 4902, message: `Unrecognized chain ID "${rp[0].chainId}". Try adding the chain using wallet_addEthereumChain first.` } });
      const changed = chain !== target;
      chain = target;
      if (profile.sessionUpdate) await addToSession(topic, session, target);
      // Like a real wallet: chainChanged only when the chain actually changed.
      if (changed) {
        const on = profile.sessionUpdate ? target : Number(session.namespaces.eip155.chains?.[0]?.split(':')[1] ?? 1);
        await kit.emitSessionEvent({ topic, event: { name: 'chainChanged', data: target }, chainId: `eip155:${on}` }).catch(() => {});
      }
      return respond({ result: null });
    }
    if (method === 'wallet_addEthereumChain') {
      const p = rp[0];
      if (profile.add === 'unsupported') return respond({ error: { code: 4200, message: 'The method "wallet_addEthereumChain" is not supported.' } });
      if (profile.add === 'reject') return respond({ error: { code: 4001, message: 'User rejected the request.' } });
      // What MetaMask checks before it shows "Add network".
      assert.equal(typeof p.chainName, 'string');
      assert.ok(p.chainName.length > 0);
      assert.equal(p.nativeCurrency.decimals, 18);
      assert.ok(/^https:\/\//.test(p.rpcUrls[0]));
      const target = parseInt(p.chainId, 16);
      known.add(target);
      profile.knows = [...known];
      chain = target;
      const first = `eip155:${session.namespaces.eip155.chains?.[0]?.split(':')[1] ?? 1}`;
      if (profile.eventFirst) {
        await kit.emitSessionEvent({ topic, event: { name: 'chainChanged', data: target }, chainId: first }).catch(() => {});
        await respond({ result: null });
        await new Promise((r) => setTimeout(r, 600));
        await addToSession(topic, session, target);
        return;
      }
      if (profile.sessionUpdate) await addToSession(topic, session, target);
      await kit.emitSessionEvent({ topic, event: { name: 'chainChanged', data: target }, chainId: profile.sessionUpdate ? `eip155:${target}` : first }).catch(() => {});
      return respond({ result: null });
    }
    // Nothing else is ever approved here: this wallet signs nothing.
    return respond({ error: { code: 4001, message: 'User rejected the request.' } });
  });

  async function addToSession(topic, session, target) {
    const ns = session.namespaces.eip155;
    const caip = `eip155:${target}`;
    if ((ns.chains ?? []).includes(caip)) return;
    await kit.updateSession({
      topic,
      namespaces: {
        eip155: { ...ns, chains: [...(ns.chains ?? []), caip], accounts: [...ns.accounts, `${caip}:${address}`] },
      },
    });
    log.push(['session_update', target]);
  }

  return {
    address,
    log,
    proposal: () => proposalSeen,
    pair: (uri) => kit.pair({ uri }),
    close: async () => {
      const bounded = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      for (const topic of Object.keys(kit.getActiveSessions())) {
        await bounded(kit.disconnectSession({ topic, reason: { code: 6000, message: 'User disconnected.' } }));
      }
      core.heartbeat?.stop?.();
      await bounded(core.relayer.transportClose());
    },
  };
}

/* ---------------- the dApp ---------------- */

const DAPPS = {
  // Connect → chooser → WalletConnect; the page then reports its state as text.
  dex: {
    open: async (page) => {
      await page.getByTestId('header-connect').click();
      await page.getByTestId('choice-walletconnect').click();
    },
    connected: (text, addr) => text.toLowerCase().includes(addr.slice(2, 6).toLowerCase()),
  },
  launchpad: {
    open: async (page) => {
      await page.getByTestId('header-connect').click();
      await page.getByTestId('choice-walletconnect').click();
    },
    connected: (text, addr) => text.toLowerCase().includes(addr.slice(2, 6).toLowerCase()),
  },
  agents: {
    open: async (page) => {
      await page.locator('#nav-connect').click();
      await page.getByTestId('choice-walletconnect').click();
    },
    connected: (text, addr) => text.toLowerCase().includes(addr.slice(2, 6).toLowerCase()),
  },
};

async function copyWcLink(page) {
  // The WalletConnect modal (Reown AppKit) lives in shadow DOM; getByText pierces it.
  const copy = page.getByText('Copy link').last();
  await copy.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await copy.click({ force: true });
  await page.waitForTimeout(400);
  let uri = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (!/^wc:/.test(uri)) {
    uri = await page.evaluate(() => {
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          const u = el.getAttribute?.('uri');
          if (u && u.startsWith('wc:')) return u;
          if (el.shadowRoot) {
            const r = walk(el.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      };
      return walk(document);
    });
  }
  assert.match(uri ?? '', /^wc:[0-9a-f]{64}@2\?/, 'a WalletConnect v2 link');
  return uri;
}

async function main() {
  if (!PROJECT_ID) skip('set WC_PROJECT_ID (a Reown project id)');
  const chromium = await loadPlaywright();
  if (!chromium) skip('Playwright not found (set PLAYWRIGHT_MODULE)');
  const dapp = DAPPS[DAPP];
  if (!dapp) throw new Error(`unknown DAPP ${DAPP}`);
  const out = process.env.OUT ?? (await mkdtemp(join(tmpdir(), 'wc-dapp-wallets-')));
  await mkdir(out, { recursive: true });

  const server = createServer(async (req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    let f = join(DIST, p.endsWith('/') ? `${p}index.html` : p);
    let body = await readFile(f).catch(() => null);
    if (!body) body = await readFile((f = join(DIST, p, 'index.html'))).catch(() => null);
    if (!body) body = await readFile((f = join(DIST, 'index.html'))).catch(() => null);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true });
  const results = [];
  try {
    for (const name of PROFILES) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`   [${name} pageerror] ${String(e?.stack ?? e).slice(0, 400)}`));
      if (process.env.DEBUG) page.on('console', (m) => console.log(`   [${name} console.${m.type()}] ${m.text().slice(0, 300)}`));
      const wallet = await scriptedWallet(name);
      try {
        await page.goto(`http://localhost:${PORT}${process.env.DAPP_PATH ?? '/'}`);
        await page.waitForTimeout(1500);
        await dapp.open(page);
        const uri = await copyWcLink(page);
        await page.screenshot({ path: join(out, `${DAPP}-${name}-1-modal.png`) });
        await wallet.pair(uri);
        // Let the connect, the automatic switch/add and the session update settle.
        await page.waitForTimeout(12000);
        await page.screenshot({ path: join(out, `${DAPP}-${name}-2-after.png`), fullPage: false });
        const text = await page.evaluate(() => document.body.innerText);
        const prop = wallet.proposal();
        results.push({ name, text, log: wallet.log, prop, address: wallet.address });
        console.log(`\n== ${DAPP} × ${name}  (${wallet.address})`);
        console.log('   proposal required:', JSON.stringify(prop?.requiredNamespaces ?? {}), ' optional chains:', (prop?.optionalNamespaces?.eip155?.chains ?? []).join(','));
        for (const l of wallet.log) console.log('   wallet:', JSON.stringify(l).slice(0, 220));
        const lines = text.split('\n').filter((l) => /Ferminux|wallet|chain|3961|network|reject|switch|connect again|Chain ID/i.test(l)).slice(0, 12);
        for (const l of lines) console.log('   page:', l.slice(0, 260));
      } finally {
        await wallet.close();
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Assertions on what each wallet family must end in.
  for (const r of results) {
    const approved = r.log.find((l) => l[0] === 'approved');
    assert.ok(approved, `${r.name}: the wallet approved the session`);
    assert.deepEqual(Object.keys(r.prop.requiredNamespaces ?? {}), [], `${r.name}: nothing is required`);
    assert.ok(r.prop.optionalNamespaces.eip155.chains.includes('eip155:3961'), `${r.name}: 3961 is proposed (optional)`);
    const methods = r.log.map((l) => l[0]);
    if (r.name === 'known') {
      assert.equal(methods.includes('wallet_addEthereumChain'), false, 'known: no add needed');
      assert.ok(!/not Ferminux|Wrong network/i.test(r.text), 'known: on Ferminux');
    }
    if (r.name === 'metamask' || r.name === 'eventfirst') {
      assert.ok(methods.includes('wallet_switchEthereumChain') && methods.includes('wallet_addEthereumChain'), 'metamask: switch then add');
      const add = r.log.find((l) => l[0] === 'wallet_addEthereumChain')[2];
      assert.equal(add.chainId, '0xf79');
      assert.equal(add.chainName, 'Ferminux');
      assert.deepEqual(add.nativeCurrency, { name: 'Ferminux', symbol: 'FMX', decimals: 18 });
      assert.deepEqual(add.rpcUrls, ['https://rpc.ferminux.net']);
      assert.deepEqual(add.blockExplorerUrls, ['https://explorer.ferminux.net']);
      assert.ok(add.iconUrls.every((u) => u.startsWith('https://ferminux.net/')));
      assert.ok(!/not Ferminux|Wrong network/i.test(r.text), 'metamask: on Ferminux after adding');
    }
    if (r.name === 'noupdate') assert.match(r.text, /did not share the network with this site/);
    if (r.name === 'rainbow') assert.match(r.text, /could not add Ferminux from this site[\s\S]*Chain ID: 3961/);
    if (r.name === 'rejects') assert.match(r.text, /not switched to Ferminux[\s\S]*Chain ID: 3961/);
    assert.ok(DAPPS[DAPP].connected(r.text, r.address), `${r.name}: the dApp shows the connected address`);
  }
  console.log(`\nwc-dapp-wallets: ${results.length} wallet families passed on ${DAPP}. Screenshots: ${out}`);
}

// The WalletConnect clients keep timers running: exit explicitly either way.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
