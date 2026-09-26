#!/usr/bin/env node
// Generate site/assets/brand/tokenlist.json from the shared registry.
//
// The published token list is the fourth place these tokens were maintained by
// hand, and it disagreed with the wallet. It is derived now: edit
// shared/tokens.ts and re-run this. The BSC-side wFMX entry is added here
// rather than in the registry because the registry describes chain 3961 — wFMX
// on BSC is a different contract that happens to share a name, and conflating
// the two is exactly the confusion this project has already had once.
//
//   node shared/gen-tokenlist.mjs           write it (both copies: ferminux.com and ferminux.net serve one each)
//   node shared/gen-tokenlist.mjs --check   fail if either copy is out of date or a logo is missing (CI)
//
// Logos are 256 × 256 PNGs (shared/gen-token-logos.mjs): many wallets and trackers reject an SVG logoURI. The
// apps keep using the SVGs named in shared/tokens.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FERMINUX_CHAIN_ID, TOKENS } from './tokens.ts';

const BRAND_DIRS = ['../site/assets/brand/', '../agents/web/public/assets/brand/'].map((d) => fileURLToPath(new URL(d, import.meta.url)));
const OUTS = BRAND_DIRS.map((d) => `${d}tokenlist.json`);
const LOGO_BASE = 'https://ferminux.net/assets/brand/';

/** The PNG each listed token points at, by symbol. A token without one fails the build rather than listing an SVG. */
export const LIST_LOGOS = { FMX: 'fmx-256.png', WFMX: 'wfmx-256.png', wFMX: 'wfmx-256.png', USDF: 'usdf-256.png', AZNT: 'aznt-256.png' };
const listLogo = (symbol) => {
  const f = LIST_LOGOS[symbol];
  if (!f) throw new Error(`no PNG logo for ${symbol}: add it to LIST_LOGOS and shared/gen-token-logos.mjs`);
  return `${LOGO_BASE}${f}`;
};

/** The bridge's wFMX wrapper on BSC — chain 56, not part of the 3961 registry. */
const BSC_WFMX = {
  chainId: 56,
  address: '0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0',
  name: 'Wrapped FMX',
  symbol: 'wFMX',
  decimals: 18,
  logoURI: listLogo('wFMX'),
};

const list = {
  name: 'Ferminux',
  // Not Date.now(): a timestamp that moves on every run makes --check fail for
  // no reason and produces a diff whenever anyone regenerates. It changes when
  // the token set changes, which is what a consumer actually cares about.
  timestamp: '2026-09-26T00:00:00.000Z',
  // tokenlists.org semver: a logoURI change is a patch (1.1.1: every logo is a 256 px PNG)
  version: { major: 1, minor: 1, patch: 1 },
  logoURI: listLogo('FMX'),
  keywords: ['ferminux', 'fmx', 'bridge'],
  tokens: [
    ...TOKENS.map((t) => ({
      chainId: FERMINUX_CHAIN_ID,
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      logoURI: listLogo(t.symbol),
      ...(t.bridgedFrom
        ? { extensions: { bridgedFromChainId: t.bridgedFrom.chainId, bridgedFromAsset: t.bridgedFrom.asset } }
        : {}),
    })),
    BSC_WFMX,
  ],
};

const json = `${JSON.stringify(list, null, 2)}\n`;

/** Width and height from a PNG's IHDR chunk, or null when the file is not a PNG. */
export function pngSize(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const logoFiles = [...new Set([list.logoURI, ...list.tokens.map((t) => t.logoURI)].map((u) => u.slice(LOGO_BASE.length)))];

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const out of OUTS) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (current !== json) {
      console.error(`${out} is out of date with shared/tokens.ts — run: node shared/gen-tokenlist.mjs`);
      bad++;
    }
  }
  for (const dir of BRAND_DIRS) {
    for (const f of logoFiles) {
      const size = existsSync(`${dir}${f}`) ? pngSize(readFileSync(`${dir}${f}`)) : null;
      if (!size || size.width !== 256 || size.height !== 256) {
        console.error(`${dir}${f} is missing or not a 256 × 256 PNG — run: node shared/gen-token-logos.mjs`);
        bad++;
      }
    }
  }
  if (bad) process.exit(1);
  console.log(`tokenlist.json is up to date in both places; ${logoFiles.length} logos are 256 × 256 PNGs.`);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const out of OUTS) {
    writeFileSync(out, json);
    console.log(`wrote ${out} — ${list.tokens.length} tokens`);
  }
}

export { list as TOKEN_LIST };
