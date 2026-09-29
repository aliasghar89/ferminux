// Render the Ferminux markdown docs into a self-contained static site.
//
//   npm --prefix . ci            (once; installs marked)
//   node build-docs.mjs [outDir]      default: ./dist
//
// Output: one .html per docs/*.md (README.md -> index.html), a redirect page for
// every retired slug in REDIRECTS, robots.txt, sitemap.xml, the brand files (BRAND)
// and the three self-hosted fonts. Every heading gets a GitHub-style id, so links
// like faq.md#where-does-fmx-trade-and-why land on the section.
//
// No CDN, no third-party fonts, no analytics: the output is HTML + one inline
// stylesheet in the dark design system the other Ferminux sites use
// (.ui-craft/tokens.md: black canvas, one green, Sora / Inter / JetBrains Mono).
//
// The logo is never redrawn here. docs/brand/ holds copies of files that
// brand/build.py (and brand/make-ico.py) generate into brand/dist/: sprite.html (the
// #fx-mark and #fx-word symbols, inlined into every page), the favicons and the
// share card. brand/dist/ is not committed, so the copies are; when the brand is
// rebuilt the build names every copy that no longer matches (see checkBrand).

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ? resolve(process.argv[2]) : join(here, 'dist');

const SITE = 'https://docs.ferminux.net';

const NAV = [
  ['index', 'Overview'],
  ['run-a-node', 'Run a node'],
  ['add-network', 'Add the network'],
  ['developers', 'Deploy a contract'],
  ['faq', 'FAQ'],
  ['troubleshooting', 'Troubleshooting'],
];

// Retired pages: the old URL keeps working and forwards to its replacement.
// mining: the pre-fork page. Nothing on chain 3961 is produced that way since block
// 160,000, so its readers are sent to the node page.
const REDIRECTS = {
  mining: 'run-a-node',
};

// Published name -> file in docs/brand/ (a copy of brand/dist/<same name>).
const BRAND = {
  'favicon.ico': 'favicon.ico',
  'favicon.svg': 'favicon.svg',
  'favicon-32.png': 'favicon-32.png',
  'apple-touch-icon.png': 'favicon-180.png',
  'fmx-mark.svg': 'fmx-mark.svg',
  'fmx-og-dark.png': 'fmx-og-dark-1200.png',
};
const FONTS = ['inter-latin-var.woff2', 'jetbrains-mono-latin-var.woff2', 'sora-latin-600.woff2'];

// The gradients plus #fx-mark and #fx-word, exactly as brand/build.py wrote them.
const SPRITE = readFileSync(join(here, 'brand', 'sprite.html'), 'utf8').trim();

const HEAD_ICONS = `<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#000000">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

// Tokens: the values of .ui-craft/tokens.md §8b that these pages use. Change them
// there first, then here.
const CSS = `
@font-face{font-family:"Inter";font-style:normal;font-weight:400 600;font-display:swap;src:url(/fonts/inter-latin-var.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400 500;font-display:swap;src:url(/fonts/jetbrains-mono-latin-var.woff2) format("woff2")}
@font-face{font-family:"Sora";font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/sora-latin-600.woff2) format("woff2")}
@font-face{font-family:"Inter Fallback";src:local("Arial"),local("Helvetica Neue"),local("Helvetica");size-adjust:107.1%;ascent-override:90.4%;descent-override:22.5%;line-gap-override:0%}
@font-face{font-family:"JetBrains Mono Fallback";src:local("Menlo"),local("Consolas"),local("Courier New");size-adjust:99.5%;ascent-override:102.5%;descent-override:30.2%;line-gap-override:0%}
@font-face{font-family:"Sora Fallback";src:local("Arial"),local("Helvetica");size-adjust:111%;ascent-override:90%;descent-override:26.5%;line-gap-override:0%}
:root{
  color-scheme:dark;
  --bg:#000000;--surface:#0c110f;--surface-2:#131a17;--surface-3:#19211d;
  --border:#232d29;--border-strong:#5b6862;--hairline:#1b2420;
  --ink:#ecf2ef;--muted:#a4b1ab;--faint:#84928c;--on-accent:#03140c;
  --accent:#05ee93;--accent-hover:#5cf5b8;--accent-soft:#0a241a;--accent-border:#155c40;
  --code-bg:#070b09;--code-ink:#dce6e1;
  --r-xs:4px;--r:6px;--r-md:10px;--r-card:14px;--r-pill:999px;
  --elev-1:inset 0 1px 0 rgba(236,242,239,.04);
  --display:"Sora","Sora Fallback",Inter,system-ui,sans-serif;
  --sans:Inter,"Inter Fallback",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:"JetBrains Mono","JetBrains Mono Fallback",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --fs-label:11.5px;--fs-code:13px;
  --dur-1:120ms;--ease-std:cubic-bezier(.4,0,.2,1);
  --container:1120px;--header-h:64px;--sticky-top:calc(var(--header-h) + 12px);
}
@media(max-width:480px){:root{--fs-label:11px;--fs-code:12.5px}}
*{box-sizing:border-box}
/* no tabular-nums on body: Inter's tabular set widens the hyphen too ("proof - of - authority");
   only table cells without a hyphen (td.n, see numCells) and code keep tabular figures */
html{-webkit-text-size-adjust:100%;background:var(--bg);scrollbar-color:#2a3530 transparent}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.65;
  font-feature-settings:"cv11","ss01";-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
::selection{background:#155c40;color:var(--ink)}
a{color:inherit;text-decoration:none;transition:color var(--dur-1) var(--ease-std)}
a:hover{color:var(--accent-hover)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
strong,b{font-weight:600}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.skip{position:absolute;left:-999px;top:8px;background:var(--accent);color:var(--on-accent);font-weight:600;padding:8px 12px;border-radius:var(--r);z-index:50}
.skip:focus{left:8px;color:var(--on-accent)}

/* header: the brand exactly as on ferminux.net and the explorer (mark 24 px, wordmark 12 px tall),
   then a hairline and the mono section label */
.site-header{position:sticky;top:0;z-index:20;background:rgba(0,0,0,.78);-webkit-backdrop-filter:blur(14px) saturate(140%);
  backdrop-filter:blur(14px) saturate(140%);border-bottom:1px solid var(--hairline)}
@media(prefers-reduced-transparency:reduce){.site-header{background:rgba(0,0,0,.94);-webkit-backdrop-filter:none;backdrop-filter:none}}
.hd{max-width:var(--container);margin:0 auto;padding:0 20px;height:var(--header-h);display:flex;align-items:center;gap:16px}
.brand{display:inline-flex;align-items:center;gap:10px;white-space:nowrap;color:var(--ink);flex:none}
.brand:hover{color:var(--ink)}
.brand .mark{width:24px;height:24px;display:block;flex:none}
.brand-word{display:block;flex:none;width:146px;height:12px}
.brand-sep{width:1px;height:18px;background:var(--border);flex:none}
.brand-sub{font:500 var(--fs-label)/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.sites{margin-left:auto;display:flex;align-items:center;gap:2px;font-size:14px;font-weight:500}
.sites a{display:inline-flex;align-items:center;height:36px;padding:0 12px;border-radius:var(--r);color:var(--muted);
  transition:color var(--dur-1) var(--ease-std),background-color var(--dur-1) var(--ease-std)}
.sites a:hover{color:var(--ink);background:var(--surface)}

/* body: the table of contents and the page, as on ferminux.net/docs */
.wrap{max-width:var(--container);margin:0 auto;padding:0 20px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:56px}
.toc{padding:40px 0}
.toc ul{list-style:none;margin:0;padding:0;position:sticky;top:var(--sticky-top);display:grid;gap:2px;font-size:14px}
.toc a{display:block;padding:6px 10px;border-left:2px solid transparent;color:var(--muted)}
.toc a:hover{color:var(--ink);border-left-color:var(--border-strong)}
.toc a.on{color:var(--ink);font-weight:500;border-left-color:var(--accent)}
main{padding:40px 0 96px;min-width:0;max-width:74ch}
main h1,main h2{font-family:var(--display);font-weight:600;text-wrap:balance}
main h1{font-size:clamp(30px,4.2vw,44px);line-height:1.08;letter-spacing:-.03em;margin:0 0 16px}
main h1+p{font-size:17px;color:var(--muted)}
main h2{font-size:clamp(22px,2.4vw,26px);line-height:1.2;letter-spacing:-.02em;margin:56px 0 16px;padding-bottom:10px;border-bottom:1px solid var(--hairline)}
main h3{font-size:17px;line-height:1.35;font-weight:600;letter-spacing:-.01em;margin:32px 0 8px;text-wrap:balance}
main h4{font-size:14px;font-weight:600;margin:24px 0 6px}
main h1,main h2,main h3,main h4{scroll-margin-top:var(--sticky-top)}
main p,main li{color:var(--muted);font-size:15.5px}
main p{margin:0 0 16px}
main ul,main ol{margin:0 0 16px;padding-left:22px}
main li{margin-bottom:6px}
main li::marker{color:var(--faint)}
main strong{color:var(--ink)}
main a{color:var(--accent);text-decoration:underline;text-decoration-color:var(--accent-border);text-underline-offset:3px;text-decoration-thickness:1px}
main a:hover{color:var(--accent-hover);text-decoration-color:currentColor}
code{font-family:var(--mono);font-size:.875em;background:var(--surface-3);color:var(--ink);padding:1px 5px;border-radius:var(--r-xs)}
:not(pre)>code{overflow-wrap:anywhere}
main a code{color:inherit}
pre{margin:8px 0 20px;background:var(--code-bg);color:var(--code-ink);border:1px solid var(--border);border-radius:var(--r-card);
  padding:16px 18px;font-family:var(--mono);font-size:var(--fs-code);line-height:1.6;overflow:auto;-webkit-overflow-scrolling:touch}
pre code{background:none;padding:0;border-radius:0;font-size:inherit;color:inherit}
.tbl{margin:8px 0 22px;border:1px solid var(--border);border-radius:var(--r-card);background:var(--surface);box-shadow:var(--elev-1);overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:14.5px}
td.n{font-variant-numeric:tabular-nums}
th{text-align:left;font:500 var(--fs-label)/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint);
  padding:10px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:11px 14px;border-bottom:1px solid var(--hairline);vertical-align:top;color:var(--muted)}
td:first-child{color:var(--ink)}
tr:last-child td{border-bottom:0}
blockquote{margin:8px 0 20px;padding:12px 16px;border:1px solid var(--accent-border);border-radius:var(--r-md);background:var(--accent-soft)}
blockquote p{color:var(--ink)}
blockquote p:last-child{margin-bottom:0}
hr{border:0;border-top:1px solid var(--hairline);margin:32px 0}
img{max-width:100%}

footer{border-top:1px solid var(--hairline);color:var(--faint);font-size:13px}
.ft{max-width:var(--container);margin:0 auto;padding:28px 20px 48px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px}
.ft .brand{color:var(--muted)}
.ft .brand .mark{width:20px;height:20px}
.ft .brand-word{width:110px;height:9px}
.ft p{margin:0}
.ft a{color:var(--muted)}
.ft a:hover{color:var(--accent-hover)}
.ft code{font-size:12px}

@media(max-width:899px){
  .site-header{position:static}
  .hd{height:auto;min-height:var(--header-h);padding:12px 16px;flex-wrap:wrap;row-gap:4px}
  .sites{margin-left:-12px;width:calc(100% + 12px);font-size:13.5px}
  .wrap{grid-template-columns:minmax(0,1fr);gap:0;padding:0 16px}
  main h1,main h2,main h3,main h4{scroll-margin-top:12px}
  .toc{padding:16px 0;border-bottom:1px solid var(--hairline)}
  .toc ul{position:static;display:flex;flex-wrap:wrap;gap:6px}
  .toc a{border:1px solid var(--border);border-radius:var(--r-pill);padding:4px 11px;font-size:13px}
  .toc a:hover{border-color:var(--border-strong)}
  .toc a.on{border-color:var(--accent)}
  main{padding-top:28px}
  main h2{margin-top:44px}
  .ft{padding:24px 16px 40px}
}
@media(max-width:420px){.hd .brand .mark{width:22px;height:22px}.hd .brand-word{width:122px;height:10px}.hd .brand{gap:8px}}
`;

// The brand, drawn from the sprite: used in the header and, smaller, in the footer.
const lockup = (label) =>
  `<svg class="mark" width="24" height="24" aria-hidden="true" focusable="false"><use href="#fx-mark"/></svg>` +
  `<svg class="brand-word" width="146" height="12" aria-hidden="true" focusable="false"><use href="#fx-word"/></svg>` +
  (label ? `<span class="brand-sep" aria-hidden="true"></span><span class="brand-sub">${label}</span>` : '');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urlFor = (slug) => `${SITE}/${slug === 'index' ? '' : slug}`;

function page(title, bodyHtml, slug, description) {
  const nav = NAV.map(([s, label]) =>
    `<li><a href="/${s === 'index' ? '' : s}"${s === slug ? ' class="on" aria-current="page"' : ''}>${label}</a></li>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Ferminux docs</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${urlFor(slug)}">
<meta property="og:site_name" content="Ferminux">
<meta property="og:title" content="${esc(title)} — Ferminux docs">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${urlFor(slug)}">
<meta property="og:type" content="article">
<meta property="og:image" content="${SITE}/fmx-og-dark.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Ferminux: AI economy on chain">
<meta name="twitter:card" content="summary_large_image">
${HEAD_ICONS}
<link rel="preload" href="/fonts/inter-latin-var.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${SPRITE}</defs></svg>
<header class="site-header"><div class="hd">
  <a class="brand" href="/" aria-label="Ferminux docs, home">${lockup('Docs')}</a>
  <nav class="sites" aria-label="Ferminux sites">
    <a href="https://ferminux.net">Home</a>
    <a href="https://explorer.ferminux.net">Explorer</a>
    <a href="https://dex.ferminux.net">DEX</a>
    <a href="https://wallet.ferminux.net">Wallet</a>
  </nav>
</div></header>
<div class="wrap">
  <nav class="toc" aria-label="Documentation"><ul>${nav}</ul></nav>
  <main id="main">${bodyHtml}</main>
</div>
<footer><div class="ft">
  <a class="brand" href="https://ferminux.net" aria-label="Ferminux home">${lockup()}</a>
  <p>Chain 3961 · <a href="https://ferminux.net">ferminux.net</a> · <a href="https://explorer.ferminux.net">Explorer</a> · RPC <code>https://rpc.ferminux.net</code></p>
</div></footer>
</body></html>`;
}

// Markdown links between docs point at *.md; rewrite them to clean paths.
function fixLinks(html) {
  return html
    .replace(/href="README\.md"/g, 'href="/"')
    .replace(/href="([a-z0-9-]+)\.md"/g, 'href="/$1"')
    .replace(/href="([a-z0-9-]+)\.md#/g, 'href="/$1#');
}

// A wide table scrolls inside its own frame, so the page never scrolls sideways.
const wrapTables = (html) => html.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, '</table></div>');

// Tabular figures line up a column of numbers, but Inter's tabular set also widens the
// hyphen, so "re-executes" and "JSON-RPC" in a table read "re - executes", "JSON - RPC".
// A cell gets them (class n) only when its text, code aside (monospaced anyway), has no hyphen.
const numCells = (html) => html.replace(/<td([^>]*)>([\s\S]*?)<\/td>/g, (cell, attrs, inner) =>
  /-/.test(inner.replace(/<code>[\s\S]*?<\/code>/g, '').replace(/<[^>]+>/g, '')) ? cell : `<td${attrs} class="n">${inner}</td>`);

// Each docs/brand copy against the file brand/build.py last generated, when brand/dist
// is present (it is not committed, so a fresh clone skips the check).
function checkBrand() {
  const dist = join(here, '..', 'brand', 'dist');
  if (!existsSync(dist)) return;
  const stale = [...new Set([...Object.values(BRAND), 'sprite.html'])].filter((f) =>
    existsSync(join(dist, f)) && !readFileSync(join(dist, f)).equals(readFileSync(join(here, 'brand', f))));
  if (stale.length) {
    console.warn(`docs/brand differs from brand/dist for: ${stale.join(', ')}\n` +
      `  refresh: (cd docs/brand && for f in ${stale.join(' ')}; do cp ../../brand/dist/$f .; done)`);
    process.exitCode = 1;
  }
}

// GitHub-style heading ids: lower case, punctuation dropped, spaces to hyphens,
// "-1", "-2" appended to repeats. Links written against GitHub's rendering of these
// files therefore also work on the site.
function slugify(text, seen) {
  const base = text.toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/g, '')
    .replace(/[^\w\- ]+/g, '')
    .replace(/ /g, '-');
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

function render(md) {
  const seen = new Map();
  const renderer = {
    heading({ tokens, depth, text }) {
      const inner = this.parser.parseInline(tokens);
      const plain = text.replace(/`/g, '');
      return `<h${depth} id="${slugify(plain, seen)}">${inner}</h${depth}>\n`;
    },
  };
  const m = new Marked({ gfm: true });
  m.use({ renderer });
  return m.parse(md);
}

// The page's first paragraph, as plain text, for the meta description.
function describe(md) {
  const para = md.split(/\n{2,}/).find((b) => b.trim() && !/^(#|\||```|>|-|\d+\.)/.test(b.trim())) || '';
  const text = para.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, '')}…` : text;
}

function redirectPage(from, to) {
  const target = urlFor(to);
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moved — Ferminux docs</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${target}">
<meta http-equiv="refresh" content="0; url=/${to}">
${HEAD_ICONS}
</head><body style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 24px;background:#000;color:#ecf2ef">
<p>This page has moved to <a href="/${to}" style="color:#05ee93">${target.replace('https://', '')}</a>.</p>
<script>location.replace('/${to}' + location.hash);</script>
</body></html>`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const files = readdirSync(here).filter((f) => f.endsWith('.md'));
const slugs = [];
for (const f of files) {
  const slug = basename(f, '.md') === 'README' ? 'index' : basename(f, '.md');
  if (REDIRECTS[slug]) throw new Error(`${f} exists but ${slug} is listed in REDIRECTS`);
  const md = readFileSync(join(here, f), 'utf8');
  const html = numCells(wrapTables(fixLinks(render(md))));
  const title = (md.match(/^#\s+(.+)$/m) || [, slug])[1].replace(/\s[—-]\s.*$/, '').trim();
  writeFileSync(join(outDir, `${slug}.html`), page(title, html, slug, describe(md)));
  slugs.push(slug);
}
for (const [from, to] of Object.entries(REDIRECTS)) {
  if (!slugs.includes(to)) throw new Error(`redirect ${from} -> ${to}: no such page`);
  writeFileSync(join(outDir, `${from}.html`), redirectPage(from, to));
}
// Served as plain files by the docs vhost (try_files $uri first).
writeFileSync(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const order = NAV.map(([s]) => s).filter((s) => slugs.includes(s)).concat(slugs.filter((s) => !NAV.some(([n]) => n === s)));
writeFileSync(join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${order.map((s) => `  <url><loc>${urlFor(s)}</loc></url>`).join('\n')}
</urlset>
`);
// The brand files and fonts, served next to the pages. /favicon.ico and
// /apple-touch-icon.png are also fetched by browsers that never read the <link> tags.
for (const [to, from] of Object.entries(BRAND)) copyFileSync(join(here, 'brand', from), join(outDir, to));
mkdirSync(join(outDir, 'fonts'));
for (const f of FONTS) copyFileSync(join(here, 'fonts', f), join(outDir, 'fonts', f));
checkBrand();
console.log(`rendered ${slugs.length} pages + ${Object.keys(REDIRECTS).length} redirect -> ${outDir}`);
