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
//   node shared/gen-tokenlist.mjs           write it
//   node shared/gen-tokenlist.mjs --check   fail if the file is out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FERMINUX_CHAIN_ID, TOKENS, logoUrl } from './tokens.ts';

const OUT = fileURLToPath(new URL('../site/assets/brand/tokenlist.json', import.meta.url));

/** The bridge's wFMX wrapper on BSC — chain 56, not part of the 3961 registry. */
const BSC_WFMX = {
  chainId: 56,
  address: '0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0',
  name: 'Wrapped FMX',
  symbol: 'wFMX',
  decimals: 18,
  logoURI: 'https://ferminux.net/assets/brand/fmx-round.svg',
};

const list = {
  name: 'Ferminux',
  // Not Date.now(): a timestamp that moves on every run makes --check fail for
  // no reason and produces a diff whenever anyone regenerates. It changes when
  // the token set changes, which is what a consumer actually cares about.
  timestamp: '2026-08-27T00:00:00.000Z',
  version: { major: 1, minor: 1, patch: 0 },
  logoURI: 'https://ferminux.net/assets/brand/fmx-round.svg',
  keywords: ['ferminux', 'fmx', 'bridge'],
  tokens: [
    ...TOKENS.map((t) => ({
      chainId: FERMINUX_CHAIN_ID,
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      logoURI: logoUrl(t),
      ...(t.bridgedFrom
        ? { extensions: { bridgedFromChainId: t.bridgedFrom.chainId, bridgedFromAsset: t.bridgedFrom.asset } }
        : {}),
    })),
    BSC_WFMX,
  ],
};

const json = `${JSON.stringify(list, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== json) {
    console.error('tokenlist.json is out of date with shared/tokens.ts — run: node shared/gen-tokenlist.mjs');
    process.exit(1);
  }
  console.log('tokenlist.json is up to date.');
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} — ${list.tokens.length} tokens`);
}
