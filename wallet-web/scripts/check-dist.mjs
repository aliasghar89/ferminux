#!/usr/bin/env node
// Guard: the shipped bundle must contain no external URLs other than the
// configured endpoints (Ferminux RPC + explorer, and the public RPCs of the
// seven other supported networks). Inert library strings (spec namespaces,
// error-doc links that are never fetched) and link-only hosts are allowlisted
// explicitly so anything new fails the build and gets reviewed.
//
// WebSocket URLs (ws:// wss://) are checked too: the WalletConnect relay is one.
//
// WalletConnect's hosts are allowed ONLY outside what a page loads up front:
// the SDK is a lazily loaded chunk, fetched when the user pairs a site (or
// unlocks a device that already has sessions). A WalletConnect host in the
// entry script, or in a chunk the page modulepreloads (its static imports),
// would mean the SDK started loading for everyone — that fails the build.
//
//   node scripts/check-dist.mjs            the web build (dist/)
//   node scripts/check-dist.mjs dist-app   the app build (scripts/app-build.mjs runs this)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : new URL('../dist', import.meta.url).pathname;

const ALLOWED_HOSTS = new Set([
  // runtime endpoints (config defaults)
  'rpc.ferminux.net',
  'ferminux.net',
  'explorer.ferminux.net',
  // this wallet's own other origin (config.ts WALLET_CONNECT_URLS): only ever a navigation of the connect window
  'wallet.ferminux.net',
  // Public, keyless, CORS-enabled RPCs of the seven other supported networks
  // (src/lib/chains.ts): balances are read and transactions sent through them.
  'ethereum-rpc.publicnode.com',
  'eth.drpc.org',
  'bsc-rpc.publicnode.com',
  'bsc-dataseed.bnbchain.org',
  'base-rpc.publicnode.com',
  'mainnet.base.org',
  'arbitrum-one-rpc.publicnode.com',
  'arb1.arbitrum.io',
  'polygon-bor-rpc.publicnode.com',
  'polygon.drpc.org',
  'optimism-rpc.publicnode.com',
  'mainnet.optimism.io',
  'avalanche-c-chain-rpc.publicnode.com',
  'api.avax.network',
]);

// Block explorers of the other networks: only ever the target of a link the
// user clicks ("View on BscScan ↗"). The wallet never fetches from them.
const LINK_HOSTS = new Set([
  'etherscan.io',
  'bscscan.com',
  'basescan.org',
  'arbiscan.io',
  'polygonscan.com',
  'optimistic.etherscan.io',
  'snowtrace.io',
]);

// WalletConnect v2 (Reown WalletKit), lazily loaded chunk only.
const WALLETCONNECT_HOSTS = new Set([
  'relay.walletconnect.org',   // wss relay: session traffic (end-to-end encrypted)
  'relay.walletconnect.com',   // legacy relay host constant
  'verify.walletconnect.org',  // Verify API: the origin shown on every request
  'verify.walletconnect.com',  // legacy Verify host constant
  'rpc.walletconnect.org',     // SDK's blockchain API constant (1271 checks for sign-in flows this wallet does not use)
  'pulse.walletconnect.org',   // telemetry endpoint — never called: telemetryEnabled: false, and the INIT post is skipped (useWalletConnect.ts); not in the nginx CSP
  'echo.walletconnect.com',    // push-notification server — only used by registerDeviceToken, never called
  'api.pay.walletconnect.com', // WalletKit Pay — never called
  'oxlib.sh',                  // ox library error-doc link text
  't.me',                      // SDK deep-link constant (Telegram mini-app redirects) — never followed
]);

const INERT_HOSTS = new Set([
  // never fetched at runtime — string constants inside libraries
  'www.w3.org',            // XML/SVG namespace identifiers
  'reactjs.org',           // React prod error-decoder link text
  'react.dev',             // React prod error-decoder link text
  'links.ethers.org',      // ethers error documentation link text
  'github.com',            // package metadata strings
  'eips.ethereum.org',     // EIP reference in ethers error text
  'gateway.ipfs.io',       // ethers' default IPFS gateway constant — only used by ENS/avatar code paths the wallet never calls
  'gasstation.polygon.technology',         // ethers Polygon fee plugin constant — the wallet builds its providers with a static network and computes fees itself
  'gasstation-testnet.polygon.technology', // same, testnet variant
  'localhost',             // library development-default string; the wallet only ever dials the configured RPC/explorer
  'wallet.ferminux.net',   // first-party: named in the scanner's "camera needs HTTPS" explanation so the user knows where to open the wallet. Prose, never fetched.
  // The phone hand-off deep link (src/lib/handoff.ts): shown to the user as a
  // QR / tap target so their phone opens this page inside MetaMask Mobile's
  // browser. The page itself never fetches it — no request ever leaves for
  // this host. Reviewed as part of the QR hand-off feature.
  'metamask.app.link',
  // The app build only (dist-app): Capacitor's "/*! Capacitor: https://capacitorjs.com/ - MIT License */" banner.
  'capacitorjs.com',
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(html|js|css|json|svg|txt)$/.test(name)) yield p;
  }
}

// Everything the pages load up front: the entry script of the wallet
// (index.html) and of the connect window the dApps open (connect.html), and
// every chunk they modulepreload — Vite lists an entry's static imports that
// way, and those load on every visit just like the entry itself.
const entryFiles = new Set();
for (const page of ['index.html', 'connect.html']) {
  let html;
  try {
    html = readFileSync(join(DIST, page), 'utf8');
  } catch {
    continue;
  }
  for (const m of html.matchAll(/<script[^>]+src="\.?\/?([^"]+)"/g)) entryFiles.add(join(DIST, m[1]));
  for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\.?\/?([^"]+)"/g)) entryFiles.add(join(DIST, m[1]));
}
if (entryFiles.size === 0) {
  console.error(`check-dist: could not find the entry script in ${DIST}/index.html.`);
  process.exit(1);
}

let bad = 0;
const seen = new Map();
for (const file of walk(DIST)) {
  const text = readFileSync(file, 'utf8');
  const isEntry = entryFiles.has(file);
  for (const m of text.matchAll(/(?:https?|wss?):\/\/[a-zA-Z0-9.-]+/g)) {
    const host = m[0].replace(/^[a-z]+:\/\//, '');
    const key = `${host} (${file.slice(DIST.length + 1)})`;
    if (ALLOWED_HOSTS.has(host)) continue;
    let kind = null;
    if (LINK_HOSTS.has(host)) kind = 'link';
    else if (INERT_HOSTS.has(host)) kind = 'inert';
    else if (WALLETCONNECT_HOSTS.has(host)) kind = isEntry ? 'VIOLATION (WalletConnect host in a chunk every visit loads)' : 'walletconnect (lazy chunk)';
    if (kind && !kind.startsWith('VIOLATION')) {
      if (!seen.has(key)) seen.set(key, kind);
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, kind ?? 'VIOLATION');
      bad += 1;
    }
  }
}

for (const [key, kind] of seen) {
  const tag = kind.startsWith('VIOLATION') ? `  ${kind}` : `  (${kind})`;
  console.log(`${tag.padEnd(30)} ${key}`);
}
if (bad > 0) {
  console.error(`\ncheck-dist: ${bad} unexpected external URL host(s) found in ${DIST} — build rejected.`);
  process.exit(1);
}
console.log(`check-dist: no unexpected external URLs in ${DIST}.`);
