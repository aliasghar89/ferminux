// Render the Ferminux markdown docs into a self-contained static site.
//
//   npm --prefix . ci            (once; installs marked)
//   node build-docs.mjs [outDir]      default: ./dist
//
// Output: one .html per docs/*.md (README.md -> index.html), a redirect page for
// every retired slug in REDIRECTS, robots.txt, sitemap.xml and the two logo files.
// Every heading gets a GitHub-style id, so links like faq.md#where-does-fmx-trade-and-why
// land on the section.
//
// No CDN, no external fonts, no analytics: the output is HTML + one inline
// stylesheet, matching the light institutional language of ferminux.net
// (canonical palette: site/security.html). White background, hairline borders,
// tabular numerals, 6px radius, amber for links only.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
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

const CSS = `
:root{
  --bg:#ffffff;
  --surface:#fbfbfa;
  --border:#e3e3e0;
  --hairline:#efefec;
  --ink:#16181c;
  --muted:#5b6169;
  --faint:#8b9198;
  --accent:#a8761c;
  --ok:#1f7a45;
  --warn:#a33a1f;
  --r:6px;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.7;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(168,118,28,.35)}
a:hover{border-bottom-color:var(--accent)}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px;display:grid;grid-template-columns:220px 1fr;gap:48px}
header{border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:5}
.hd{max-width:1120px;margin:0 auto;padding:0 24px;height:56px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.01em;color:var(--ink);border:0}
.brand:hover{border:0}
.mark{width:14px;height:16px;background:url(/fmx-mark.svg) center/contain no-repeat}
.brand span{color:var(--muted);font-weight:400}
.hd nav{margin-left:auto;display:flex;gap:20px;font-size:13.5px}
.hd nav a{color:var(--muted);border:0}.hd nav a:hover{color:var(--ink)}
aside{padding:36px 0}
aside ul{list-style:none;margin:0;padding:0;position:sticky;top:92px;border-right:1px solid var(--hairline)}
aside li{margin:0}
aside a{display:block;padding:6px 14px 6px 0;color:var(--muted);font-size:14px;border:0}
aside a:hover{color:var(--ink)}
aside a.on{color:var(--ink);font-weight:600;margin-left:-1px;border-left:2px solid var(--ink);padding-left:12px}
main{padding:36px 0 88px;min-width:0;max-width:72ch}
main h1{font-size:30px;line-height:1.2;letter-spacing:-.02em;margin:8px 0 10px;font-weight:650}
main h1+p{font-size:16.5px;color:var(--muted)}
main h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
  font-weight:600;margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--hairline)}
main h3{font-size:15.5px;margin:24px 0 5px;font-weight:600;letter-spacing:-.01em}
main h1,main h2,main h3{scroll-margin-top:72px}
p{margin:0 0 14px}
main li{margin-bottom:6px}
code{font-family:var(--mono);font-size:13.5px;background:var(--surface);border:1px solid var(--hairline);border-radius:4px;padding:1px 5px;font-variant-numeric:tabular-nums}
:not(pre)>code{overflow-wrap:anywhere}
pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:13px 15px;overflow-x:auto;margin:6px 0 16px}
pre code{background:none;border:0;padding:0;font-size:12.8px;line-height:1.65}
table{border-collapse:collapse;width:100%;margin:6px 0 18px;font-size:14.5px;font-variant-numeric:tabular-nums;display:block;overflow-x:auto}
th{text-align:left;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);
  font-weight:600;padding:0 14px 8px 0;border-bottom:1px solid var(--border)}
td{padding:11px 14px 11px 0;border-bottom:1px solid var(--hairline);vertical-align:top}
td:last-child,th:last-child{padding-right:0}
tr:last-child td{border-bottom:0}
blockquote{margin:6px 0 16px;padding:13px 16px;border:1px solid var(--border);border-left:3px solid var(--border);
  border-radius:var(--r);background:var(--surface);color:var(--muted)}
blockquote p:last-child{margin-bottom:0}
hr{border:0;border-top:1px solid var(--hairline);margin:28px 0}
img{max-width:100%}
footer{border-top:1px solid var(--border);color:var(--faint);font-size:13px;padding:22px 24px 44px;text-align:center}
footer a{color:var(--muted);border:0}footer a:hover{color:var(--ink)}
@media(max-width:820px){
  header{position:static}
  .hd{height:auto;min-height:56px;padding:10px 16px;row-gap:6px}
  .hd nav{margin-left:0;gap:16px}
  .wrap{grid-template-columns:1fr;gap:0;padding:0 16px}
  main h1,main h2,main h3{scroll-margin-top:12px}
  aside{padding:0}
  aside ul{position:static;display:flex;flex-wrap:wrap;gap:2px 18px;padding:16px 0;border-right:0;border-bottom:1px solid var(--hairline)}
  aside a.on{border-left:0;margin-left:0;padding-left:0}
  main{padding-top:24px}
  main h1{font-size:25px}
}
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urlFor = (slug) => `${SITE}/${slug === 'index' ? '' : slug}`;

function page(title, bodyHtml, slug, description) {
  const nav = NAV.map(([s, label]) =>
    `<li><a href="/${s === 'index' ? '' : s}"${s === slug ? ' class="on"' : ''}>${label}</a></li>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Ferminux docs</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${urlFor(slug)}">
<meta property="og:title" content="${esc(title)} — Ferminux docs">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${urlFor(slug)}">
<meta property="og:type" content="article">
<meta name="color-scheme" content="light">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head><body>
<header><div class="hd">
  <a class="brand" href="/"><span class="mark"></span>Ferminux <span>docs</span></a>
  <nav>
    <a href="https://ferminux.net">Home</a>
    <a href="https://explorer.ferminux.net">Explorer</a>
    <a href="https://dex.ferminux.net">DEX</a>
    <a href="https://wallet.ferminux.net">Wallet</a>
  </nav>
</div></header>
<div class="wrap">
  <aside><ul>${nav}</ul></aside>
  <main>${bodyHtml}</main>
</div>
<footer>Ferminux · chain 3961 · <a href="https://ferminux.net">ferminux.net</a> · <a href="https://explorer.ferminux.net">explorer</a> · RPC <code>https://rpc.ferminux.net</code></footer>
</body></html>`;
}

// Markdown links between docs point at *.md; rewrite them to clean paths.
function fixLinks(html) {
  return html
    .replace(/href="README\.md"/g, 'href="/"')
    .replace(/href="([a-z0-9-]+)\.md"/g, 'href="/$1"')
    .replace(/href="([a-z0-9-]+)\.md#/g, 'href="/$1#');
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
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;margin:48px 24px;color:#16181c">
<p>This page has moved to <a href="/${to}" style="color:#a8761c">${target.replace('https://', '')}</a>.</p>
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
  const html = fixLinks(render(md));
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
// The logo files from the brand artwork, served next to the pages.
for (const f of ['favicon.svg', 'fmx-mark.svg']) copyFileSync(join(here, 'brand', f), join(outDir, f));
console.log(`rendered ${slugs.length} pages + ${Object.keys(REDIRECTS).length} redirect -> ${outDir}`);
