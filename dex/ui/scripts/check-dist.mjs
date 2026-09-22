#!/usr/bin/env node
// Guard: the shipped bundle must contain no external URLs other than the
// configured Ferminux endpoints (RPC + explorer). Inert library strings
// (spec namespaces, error-doc links that are never fetched) are allowlisted
// explicitly so anything new fails the build and gets reviewed.
//
// This is what "no CDNs" means in practice: if a dependency ever starts
// pulling a font, an icon set or a price feed from someone else's server, the
// build stops here instead of shipping a page that phones home.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;

const ALLOWED_HOSTS = new Set([
  // runtime endpoints (config defaults)
  'rpc.ferminux.net',
  'ferminux.net',
  'explorer.ferminux.net',
  // The bridge panel reads and writes the BSC side of the FMX <-> wFMX route,
  // so these are fetched at runtime like the Ferminux ones. Reviewed when the
  // panel was added; they are the same public endpoints the bridge app uses.
  'bsc-dataseed.bnbchain.org',
  'bsc-rpc.publicnode.com',
  'bscscan.com',
]);

const INERT_HOSTS = new Set([
  // never fetched at runtime — string constants inside libraries
  'www.w3.org', // XML/SVG namespace identifiers
  'reactjs.org', // React prod error-decoder link text
  'react.dev', // React prod error-decoder link text
  'links.ethers.org', // ethers error documentation link text
  'github.com', // package metadata strings
  'eips.ethereum.org', // EIP reference in ethers error text
  'gateway.ipfs.io', // ethers' default IPFS gateway constant — only ENS/avatar paths the DEX never calls
  'gasstation.polygon.technology', // ethers Polygon fee plugin constant — registered only for Polygon chain ids
  'gasstation-testnet.polygon.technology', // same, testnet variant
  'localhost', // library development-default string
  // The phone hand-off deep link (src/lib/handoff.ts): shown to the user as a
  // QR / tap target so their phone opens this page inside MetaMask Mobile's
  // browser. The page itself never fetches it — no request ever leaves for
  // this host. Reviewed as part of the QR hand-off feature.
  'metamask.app.link',
]);

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
