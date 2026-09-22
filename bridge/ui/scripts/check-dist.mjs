#!/usr/bin/env node
// Guard: the shipped bundle must reach NOTHING except the endpoints this app is
// configured to dial — no CDN scripts, no external fonts, no analytics, no
// remote images. The allowlist is DERIVED from src/config.ts rather than typed
// out here, so it can never drift from what the app actually uses: add a chain
// and its RPC is allowed automatically; leave a stray CDN in and the build dies.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, DOCS_URL, RELAYER_STATUS_URL } from '../src/config.ts';

const DIST = new URL('../dist', import.meta.url).pathname;

const ALLOWED_HOSTS = new Set();
function allow(url) {
  try {
    ALLOWED_HOSTS.add(new URL(url).host);
  } catch {
    /* not a URL — ignore */
  }
}
for (const chain of CHAINS) {
  for (const rpc of chain.rpcUrls) allow(rpc);
  allow(chain.explorerUrl);
}
allow(DOCS_URL);
allow(RELAYER_STATUS_URL); // relative by default — `new URL` throws and nothing is added

const INERT_HOSTS = new Set([
  // Never fetched at runtime — string constants inside bundled libraries.
  'www.w3.org', // XML/SVG namespace identifiers
  'reactjs.org', // React production error-decoder link text
  'react.dev', // React production error-decoder link text
  'links.ethers.org', // ethers error documentation link text
  'github.com', // package metadata strings
  'eips.ethereum.org', // EIP references inside ethers error text
  'gateway.ipfs.io', // ethers' default IPFS gateway — only ENS/avatar paths use it, which this app never calls
  'gasstation.polygon.technology', // ethers Polygon fee plugin constant, registered per chain id, never dialled here
  'gasstation-testnet.polygon.technology',
  'localhost', // library development-default string
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(html|js|css|json|svg|txt|map)$/.test(name)) yield p;
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

console.log(`check-dist: allowed hosts from src/config.ts → ${[...ALLOWED_HOSTS].sort().join(', ')}`);
for (const [key, kind] of seen) {
  console.log(`${kind === 'inert' ? '  (inert)  ' : '  VIOLATION'} ${key}`);
}
if (bad > 0) {
  console.error(`\ncheck-dist: ${bad} unexpected external URL host(s) in dist/ — build rejected.`);
  process.exit(1);
}
console.log('check-dist: no unexpected external URLs in dist/.');
