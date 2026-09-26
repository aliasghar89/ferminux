#!/usr/bin/env node
// Ferminux Wallet app icons and splash screens, drawn from the brand files
// (brand/dist/fmx-mark.svg — the mark — and favicon.svg — the mark on its
// black rounded tile) onto the black canvas of the design system.
//
//   node scripts/app-assets.mjs        (needs the `sharp` dev dependency)
//
// Writes into the native projects (android/, ios/) — the files are committed,
// so this only needs re-running when the logo changes.
//
// Android
//   mipmap-*/ic_launcher.png              legacy square icon (the favicon tile)
//   mipmap-*/ic_launcher_round.png        legacy round icon
//   mipmap-*/ic_launcher_foreground.png   adaptive icon layer, mark inside the 66dp safe zone
//   mipmap-*/ic_launcher_monochrome.png   Android 13 themed icon (white silhouette)
//   drawable-*/splash_icon.png            Android 12+ splash icon (mark inside the 192dp circle)
//   drawable*/splash.png                  pre-12 splash (black, mark centred)
// iOS
//   AppIcon.appiconset/AppIcon-512@2x.png 1024 px, opaque (App Store rejects alpha)
//   Splash.imageset/splash-2732x2732*.png

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BRAND = join(ROOT, '..', 'brand', 'dist');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const IOS = join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets');

const MARK_SVG = readFileSync(join(BRAND, 'fmx-mark.svg'));
const TILE_SVG = readFileSync(join(BRAND, 'favicon.svg'));
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** The mark rendered `height` px tall on a transparent background. */
async function mark(height) {
  return sharp(MARK_SVG, { density: Math.max(72, Math.ceil((height / 643) * 72 * 1.5)) })
    .resize({ height: Math.round(height) })
    .png()
    .toBuffer();
}

/** A white silhouette of the mark (themed icons). */
async function markMono(height) {
  const colour = await mark(height);
  const { width, height: h } = await sharp(colour).metadata();
  const alpha = await sharp(colour).ensureAlpha().extractChannel('alpha').toBuffer();
  return sharp({ create: { width, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

async function onCanvas(width, height, overlay, background, { circle = false } = {}) {
  const layers = [];
  if (circle) {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 2}" fill="#000"/></svg>`,
    );
    layers.push({ input: svg, gravity: 'center' });
  }
  if (overlay) layers.push({ input: overlay, gravity: 'center' });
  return sharp({ create: { width, height, channels: 4, background: circle ? CLEAR : background } })
    .composite(layers)
    .png()
    .toBuffer();
}

function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log('  ', path.slice(ROOT.length + 1));
}

async function android() {
  if (!existsSync(RES)) {
    console.log('android/ not generated yet — skipped');
    return;
  }
  console.log('android');
  for (const [name, k] of Object.entries(DENSITIES)) {
    const dir = join(RES, `mipmap-${name}`);
    const legacy = Math.round(48 * k);
    write(join(dir, 'ic_launcher.png'), await sharp(TILE_SVG, { density: 72 * k * 2 }).resize(legacy, legacy).png().toBuffer());
    write(join(dir, 'ic_launcher_round.png'), await onCanvas(legacy, legacy, await mark(legacy * 0.56), CLEAR, { circle: true }));
    const adaptive = Math.round(108 * k);
    // 50dp tall: the mark's corners stay inside the 66dp safe circle on every launcher mask.
    write(join(dir, 'ic_launcher_foreground.png'), await onCanvas(adaptive, adaptive, await mark(50 * k), CLEAR));
    write(join(dir, 'ic_launcher_monochrome.png'), await onCanvas(adaptive, adaptive, await markMono(50 * k), CLEAR));
    const splash = Math.round(288 * k);
    // Android 12+ masks the splash icon to a 192dp circle: 116dp tall keeps the mark clear of it.
    write(join(RES, `drawable-${name}`, 'splash_icon.png'), await onCanvas(splash, splash, await mark(116 * k), CLEAR));
  }
  const legacySplash = [
    ['drawable', 480, 320],
    ['drawable-port-mdpi', 320, 480],
    ['drawable-port-hdpi', 480, 800],
    ['drawable-port-xhdpi', 720, 1280],
    ['drawable-port-xxhdpi', 960, 1600],
    ['drawable-port-xxxhdpi', 1280, 1920],
    ['drawable-land-mdpi', 480, 320],
    ['drawable-land-hdpi', 800, 480],
    ['drawable-land-xhdpi', 1280, 720],
    ['drawable-land-xxhdpi', 1600, 960],
    ['drawable-land-xxxhdpi', 1920, 1280],
  ];
  for (const [dir, w, h] of legacySplash) {
    write(join(RES, dir, 'splash.png'), await onCanvas(w, h, await mark(Math.min(w, h) * 0.22), BLACK));
  }
  write(
    join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`,
    ),
  );
  write(join(RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), readFileSync(join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml')));
  write(
    join(RES, 'values', 'ic_launcher_background.xml'),
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#000000</color>
</resources>
`),
  );
}

async function ios() {
  if (!existsSync(IOS)) {
    console.log('ios/ not generated yet — skipped');
    return;
  }
  console.log('ios');
  const icon = await sharp(await onCanvas(1024, 1024, await mark(1024 * 0.6), BLACK)).flatten({ background: '#000000' }).removeAlpha().png().toBuffer();
  write(join(IOS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), icon);
  const splash = await sharp(await onCanvas(2732, 2732, await mark(2732 * 0.1), BLACK)).flatten({ background: '#000000' }).png().toBuffer();
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) write(join(IOS, 'Splash.imageset', f), splash);
}

await android();
await ios();
console.log('app-assets: done');
