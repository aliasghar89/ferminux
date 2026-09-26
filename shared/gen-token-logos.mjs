#!/usr/bin/env node
// 256 × 256 PNG token logos for the token list, written to both places the sites serve /assets/brand/ from
// (site/assets/brand for ferminux.com, agents/web/public/assets/brand for ferminux.net). Many wallets and token
// trackers accept only raster logoURIs, so the list points at these; the SVGs stay for the apps.
//
//   fmx-256.png   the FMX token icon, brand/dist/fmx-token-256.png as built by brand/build.py (the owner's artwork)
//   wfmx-256.png  the same icon with a green outer ring, so Wrapped FMX (the DEX wrapper on 3961, and wFMX on BNB
//                 Chain) is never mistaken for the native coin; derived from brand/dist/fmx-token.svg
//   usdf-256.png  the existing usdf-round.svg, rasterized unchanged
//   aznt-256.png  the existing aznt-round.svg, rasterized unchanged
//
//   node shared/gen-token-logos.mjs        (needs rsvg-convert, like brand/build.py: brew install librsvg)
//
// Then `node shared/gen-tokenlist.mjs` so the list points at them, and `--check` to prove both copies agree.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIRS = [join(root, 'site/assets/brand'), join(root, 'agents/web/public/assets/brand')];
const DIST = join(root, 'brand/dist');

/** The token icon's outer ring, and the WFMX one that replaces it. */
const RING = '<circle cx="320" cy="320" r="304" fill="none" stroke="#0B2A20" stroke-width="10"/>';
const WRAP_RING = '<circle cx="320" cy="320" r="296" fill="none" stroke="#02D181" stroke-width="24"/>';

export function wfmxSvg(tokenSvg) {
  if (!tokenSvg.includes(RING)) throw new Error('brand/dist/fmx-token.svg no longer has the ring this derives WFMX from; update RING');
  return tokenSvg
    .replace(RING, WRAP_RING)
    .replace('aria-label="Ferminux"><title>Ferminux</title>', 'aria-label="Wrapped FMX"><title>Wrapped FMX (WFMX)</title>');
}

function rasterize(svgPath, pngPath) {
  execFileSync('rsvg-convert', ['-w', '256', '-h', '256', svgPath, '-o', pngPath], { stdio: 'inherit' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tmp = mkdtempSync(join(tmpdir(), 'fmx-logos-'));
  try {
    const wfmx = join(tmp, 'wfmx.svg');
    writeFileSync(wfmx, wfmxSvg(readFileSync(join(DIST, 'fmx-token.svg'), 'utf8')));
    rasterize(wfmx, join(tmp, 'wfmx-256.png'));
    // the stablecoin art lives in site/assets/brand; both output dirs hold identical copies of it
    rasterize(join(OUT_DIRS[0], 'usdf-round.svg'), join(tmp, 'usdf-256.png'));
    rasterize(join(OUT_DIRS[0], 'aznt-round.svg'), join(tmp, 'aznt-256.png'));
    copyFileSync(join(DIST, 'fmx-token-256.png'), join(tmp, 'fmx-256.png'));
    for (const dir of OUT_DIRS) {
      for (const f of ['fmx-256.png', 'wfmx-256.png', 'usdf-256.png', 'aznt-256.png']) copyFileSync(join(tmp, f), join(dir, f));
      console.log(`wrote ${dir}/{fmx,wfmx,usdf,aznt}-256.png`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
