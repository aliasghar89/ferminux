#!/usr/bin/env node
// Guard: the shipped bundle must contain no external URLs other than the
// configured Ferminux endpoints (RPC + explorer). Inert library strings
// (spec namespaces, error-doc links that are never fetched) are allowlisted
// explicitly so anything new fails the build and gets reviewed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;

const ALLOWED_HOSTS = new Set([
  // runtime endpoints (config defaults)
  'rpc.ferminux.net',
  'ferminux.net',
  'explorer.ferminux.net',
]);

const INERT_HOSTS = new Set([
  // never fetched at runtime — string constants inside libraries
  'www.w3.org',            // XML/SVG namespace identifiers
  'reactjs.org',           // React prod error-decoder link text
  'react.dev',             // React prod error-decoder link text
  'links.ethers.org',      // ethers error documentation link text
  'github.com',            // package metadata strings
  'eips.ethereum.org',     // EIP reference in ethers error text
  'gateway.ipfs.io',       // ethers' default IPFS gateway constant — only used by ENS/avatar code paths this app never calls
  'gasstation.polygon.technology',         // ethers Polygon fee plugin constant — only registered for Polygon chain ids, never for chain 3961
  'gasstation-testnet.polygon.technology', // same, testnet variant
  'localhost',             // library development-default string; the app only ever dials the configured RPC/explorer
]);

// "Connect with Ferminux Wallet" (shared/fxwallet): the wallet window is
// opened on this host, and a hidden status frame of it tells a returning
// visitor whether the wallet still approves this site.
ALLOWED_HOSTS.add('wallet.ferminux.net');

// WalletConnect is opt-in: a build without VITE_WC_PROJECT_ID never bundles
// it, and this list stays out of the check. With a project id the page talks
// to the WalletConnect relay, verify and RPC services and loads the Reown QR
// modal (its API and fonts) — that is what enabling it means — and the
// package tree carries documentation and wallet-directory strings that are
// never fetched. Reviewed with @walletconnect/ethereum-provider 2.25.
const WALLETCONNECT_HOSTS = [
  // runtime
  'rpc.walletconnect.org', 'pulse.walletconnect.org', 'verify.walletconnect.org', 'verify.walletconnect.com',
  'echo.walletconnect.com', 'secure.walletconnect.org', 'secure-mobile.walletconnect.org',
  'secure-mobile.walletconnect.com', 'api.web3modal.org', 'fonts.reown.com',
  // inert library strings (docs, wallet directory, examples)
  'walletconnect.org', 'reown.com', 'dashboard.reown.com', 'dashboard.reown.com.', '4byte.sourcify.dev', 'oxlib.sh',
  'viem.sh', 'abitype.dev', 'docs.soliditylang.org', 't.me', 'solflare.com', 'phantom.app', 'meldcrypto.com',
  'ipfs.io', 'arweave.net', 'go.cb-w.com', 'app.safe.global', 'app.binance.com', 'metamask.app.link', '127.0.0.1',
];
if ((process.env.VITE_WC_PROJECT_ID ?? '').trim() !== '') for (const h of WALLETCONNECT_HOSTS) ALLOWED_HOSTS.add(h);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(html|js|css|json|svg|txt)$/.test(name)) yield p;
  }
}

let bad = 0;
const seen = new Map();
for (const file of walk(DIST)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)) {
    const host = m[0].replace(/^https?:\/\//, '');
    const key = `${host} (${file.slice(DIST.length + 1)})`;
    if (ALLOWED_HOSTS.has(host)) continue;
    if (INERT_HOSTS.has(host)) {
      if (!seen.has(key)) seen.set(key, 'inert');
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, 'VIOLATION');
      bad += 1;
    }
  }
}

for (const [key, kind] of seen) {
  console.log(`${kind === 'inert' ? '  (inert)  ' : '  VIOLATION'} ${key}`);
}
if (bad > 0) {
  console.error(`\ncheck-dist: ${bad} unexpected external URL host(s) found in dist/ — build rejected.`);
  process.exit(1);
}
console.log('check-dist: no unexpected external URLs in dist/.');
