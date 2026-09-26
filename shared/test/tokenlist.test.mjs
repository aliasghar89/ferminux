// The published token list (site/assets/brand/tokenlist.json and its ferminux.net copy): generated from
// shared/tokens.ts, raster logos only, one version for both copies.
//   node --test shared/test/tokenlist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOKEN_LIST, LIST_LOGOS, pngSize } from '../gen-tokenlist.mjs';
import { wfmxSvg } from '../gen-token-logos.mjs';
import { TOKENS } from '../tokens.ts';

const at = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const DIRS = ['site/assets/brand/', 'agents/web/public/assets/brand/'];

test('both published copies are exactly the generated list', () => {
  const json = `${JSON.stringify(TOKEN_LIST, null, 2)}\n`;
  for (const d of DIRS) assert.equal(readFileSync(at(`${d}tokenlist.json`), 'utf8'), json, `${d}tokenlist.json — run node shared/gen-tokenlist.mjs`);
});

test('every logo is a 256 × 256 PNG present on both sites', () => {
  const urls = [TOKEN_LIST.logoURI, ...TOKEN_LIST.tokens.map((t) => t.logoURI)];
  for (const u of urls) {
    assert.match(u, /^https:\/\/ferminux\.net\/assets\/brand\/[a-z]+-256\.png$/, u);
    const f = u.split('/').pop();
    for (const d of DIRS) assert.deepEqual(pngSize(readFileSync(at(`${d}${f}`))), { width: 256, height: 256 }, `${d}${f}`);
  }
  // WFMX must not look like the native coin
  assert.notDeepEqual(readFileSync(at('site/assets/brand/wfmx-256.png')), readFileSync(at('site/assets/brand/fmx-256.png')));
  // the FMX icon is the brand build's, byte for byte
  assert.deepEqual(readFileSync(at('site/assets/brand/fmx-256.png')), readFileSync(at('brand/dist/fmx-token-256.png')));
});

test('list shape: tokenlists.org fields, mixed-case (checksummed) addresses, a registry entry for every 3961 token', () => {
  assert.deepEqual(TOKEN_LIST.version, { major: 1, minor: 1, patch: 1 });
  assert.ok(!Number.isNaN(Date.parse(TOKEN_LIST.timestamp)));
  for (const t of TOKEN_LIST.tokens) {
    assert.match(t.address, /^0x(?=[0-9a-fA-F]*[a-f])(?=[0-9a-fA-F]*[A-F])[0-9a-fA-F]{40}$/, t.address);
    assert.ok(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 255);
    assert.ok(t.symbol in LIST_LOGOS, t.symbol);
  }
  const listed3961 = TOKEN_LIST.tokens.filter((t) => t.chainId === 3961).map((t) => t.address).sort();
  assert.deepEqual(listed3961, TOKENS.map((t) => t.address).sort());
  assert.ok(TOKEN_LIST.tokens.some((t) => t.chainId === 56 && t.symbol === 'wFMX' && t.logoURI.endsWith('/wfmx-256.png')));
});

test('the WFMX mark is the token icon with the wrap ring, nothing else changed', () => {
  const src = readFileSync(at('brand/dist/fmx-token.svg'), 'utf8');
  const w = wfmxSvg(src);
  assert.notEqual(w, src);
  assert.match(w, /stroke="#02D181" stroke-width="24"/);
  assert.match(w, /<title>Wrapped FMX \(WFMX\)<\/title>/);
  assert.equal(w.replace(/<circle cx="320" cy="320" r="296"[^>]*\/>/, '').replace(/aria-label="[^"]*"><title>[^<]*<\/title>/, ''), src.replace(/<circle cx="320" cy="320" r="304"[^>]*\/>/, '').replace(/aria-label="[^"]*"><title>[^<]*<\/title>/, ''));
  assert.throws(() => wfmxSvg('<svg/>'), /no longer has the ring/);
});
