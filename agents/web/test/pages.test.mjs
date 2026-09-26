// The three pages this site added on 2026-09-26 (/faucet/, /trade/, /developers/) are built, linked from the
// header, the footer, the sitemap and llms.txt, and the addresses they print match the deployment records.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const web = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const repo = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const PAGES = ["faucet", "trade", "developers"];

test("each page is a Vite entry with its own canonical URL and script", () => {
  const vite = web("vite.config.ts");
  for (const p of PAGES) {
    assert.match(vite, new RegExp(`resolve\\(root, "${p}/index.html"\\)`), p);
    const html = web(`${p}/index.html`);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://ferminux.net/${p}/">`), p);
    assert.match(html, new RegExp(`src="/src/pages/${p}.ts"`), p);
    for (const hook of ["<!-- @head -->", "<!-- @header -->", "<!-- @footer -->"]) assert.ok(html.includes(hook), `${p} ${hook}`);
  }
});

test("linked from the header, the footer, the sitemap, llms.txt and llms-full.txt", () => {
  const header = web("src/partials/header.html"), footer = web("src/partials/footer.html");
  const sitemap = web("public/sitemap.xml"), llms = web("public/llms.txt"), llmsFull = web("public/llms-full.txt");
  for (const p of PAGES) {
    assert.match(header, new RegExp(`data-nav="${p}" href="/${p}/"`), `header ${p}`);
    assert.ok(footer.includes(`href="/${p}/"`), `footer ${p}`);
    assert.ok(sitemap.includes(`<loc>https://ferminux.net/${p}/</loc>`), `sitemap ${p}`);
    assert.ok(llms.includes(`/${p}/`), `llms.txt ${p}`);
    assert.ok(llmsFull.includes(`/${p}/`), `llms-full.txt ${p}`);
  }
});

test("the developer page's address table matches the deployment records", () => {
  const html = web("developers/index.html");
  const rows = [...html.matchAll(/<tr><td>([^<]+)<\/td><td data-addr="(0x[0-9a-fA-F]{40})">/g)].map((m) => [m[1], m[2]]);
  assert.ok(rows.length >= 20, `rows: ${rows.length}`);
  const known = [
    repo("agents/deployments.3961.json"), repo("agents/deployments-citizens.3961.json"), repo("agents/gateway/src/constants.ts"),
    repo("dex/ui/src/config.ts"), web("src/config.ts"), web("src/market.ts"),
  ].join("\n");
  for (const [name, addr] of rows) assert.ok(known.includes(addr), `${name} ${addr} is not in any deployment record`);
  // every address the site's own config names is on the page
  const cfg = JSON.parse(repo("agents/deployments.3961.json"));
  for (const k of ["registry", "escrow", "nft", "x402Vault", "accountFactory", "streamPay", "arbiterPool", "identity8004", "reputation8004", "validation8004", "tokenFactory"]) {
    assert.ok(html.includes(`data-addr="${cfg[k]}"`), k);
  }
});

test("the trade page names PancakeSwap second and never links to its swap", () => {
  const html = web("trade/index.html");
  assert.ok(html.indexOf('id="dex"') < html.indexOf('id="pancakeswap"'));
  assert.ok(!/href="https:\/\/pancakeswap\.finance/.test(html));
  assert.match(html, /The bridge is paused\./);
});

test("public copy on the new pages keeps the naming rules", () => {
  for (const p of PAGES) {
    const text = web(`${p}/index.html`).replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(text, /\bERC-?\d/i, p);
    assert.doesNotMatch(text, /\bmin(ing|er|ers|ed)\b/i, p);
    assert.doesNotMatch(text, /proof[- ]of[- ]stake|five bonded/i, p);
    assert.doesNotMatch(text, /Ethereum/, p);
  }
});

test("no public copy claims existing compilers work unchanged", () => {
  for (const f of ["public/llms.txt", "public/llms-full.txt", "docs/index.html"]) assert.doesNotMatch(web(f), /work against Ferminux unchanged/, f);
});
