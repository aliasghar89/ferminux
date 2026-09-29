// The whitepaper (/whitepaper/, v1.0, 2026-09-27) is a Vite entry, is linked from the footer, the sitemap and
// llms.txt, ships its PDF, keeps the naming rules, and does not repeat the claims the earlier drafts got wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const web = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const repo = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const PDF = "whitepaper/ferminux-whitepaper-v1.0.pdf";
const html = web("whitepaper/index.html");
const text = html.replace(/<!--[\s\S]*?-->/g, "");

test("a Vite entry with its canonical URL, its script and the shared chrome", () => {
  assert.match(web("vite.config.ts"), /resolve\(root, "whitepaper\/index\.html"\)/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ferminux\.net\/whitepaper\/">/);
  assert.match(html, /src="\/src\/pages\/whitepaper\.ts"/);
  for (const hook of ["<!-- @head -->", "<!-- @header -->", "<!-- @footer -->"]) assert.ok(html.includes(hook), hook);
});

test("linked from the footer, the sitemap and llms.txt; the PDF ships and the page links it", () => {
  assert.ok(web("src/partials/footer.html").includes('href="/whitepaper/"'));
  assert.ok(web("public/sitemap.xml").includes("<loc>https://ferminux.net/whitepaper/</loc>"));
  assert.ok(web("public/llms.txt").includes("/whitepaper/"));
  assert.ok(html.includes(`href="/${PDF}"`));
  const pdf = readFileSync(new URL(`../public/${PDF}`, import.meta.url));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 100_000, `pdf is ${pdf.length} bytes`);
});

test("every section is in the contents, in order, with its anchor", () => {
  const ids = ["abstract", "network", "consensus", "fmx", "ecosystem", "security", "roadmap", "verify", "risks", "disclosures", "document"];
  const toc = [...html.matchAll(/<nav class="toc"[\s\S]*?<\/nav>/g)][0][0];
  assert.deepEqual([...toc.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]), ids);
  let at = -1;
  for (const id of ids) { const i = html.indexOf(`<section id="${id}"`); assert.ok(i > at, id); at = i; }
});

test("naming rules: FRC standards, no mining words, proof-of-authority, Ethereum only as a pay-in network", () => {
  assert.doesNotMatch(text, /\bERC-?\d/i);
  assert.doesNotMatch(text, /\bmin(ing|er|ers|ed)\b/i);
  assert.doesNotMatch(text, /proof[- ]of[- ]stake/i);
  assert.match(text, /proof-of-authority/);
  const outsidePayin = text.replace(/<span data-payin-networks>[^<]*<\/span>/g, "");
  assert.doesNotMatch(outsidePayin, /Ethereum/);
  assert.match(text, /<span data-payin-networks>Ethereum,/);
});

test("the earlier drafts' false claims are not repeated as claims", () => {
  // quoted only inside section 10's list of corrections
  const body = text.replace(/<ul class="wp-fix">[\s\S]*?<\/ul>/, "");
  assert.doesNotMatch(body, /fully[- ]collateral/i);
  assert.doesNotMatch(body, /minted only against/i);
  assert.doesNotMatch(body, /hard cap of 100/i);
  assert.doesNotMatch(body, /no price is published/i);
  assert.match(text, /makes no claim that USDF or AZNT is collateralised, backed or redeemable/);
  assert.match(text, /32,514,979\.875/);
  assert.match(text, /0x6F488FB1f382Bc96Fef8bBfCa28A9647E5Fe430B/);
});

test("contract addresses match the deployment records and the node's constants", () => {
  const cfg = JSON.parse(repo("agents/deployments.3961.json"));
  for (const k of ["registry", "escrow", "nft", "x402Vault", "accountFactory", "streamPay", "arbiterPool", "identity8004", "reputation8004", "validation8004", "tokenFactory"]) {
    assert.ok(html.includes(cfg[k]), k);
  }
  assert.ok(html.includes(JSON.parse(repo("agents/deployments-citizens.3961.json")).citizens));
  const params = repo("chain/params/ferminux.go");
  for (const a of ["0xc0A5Eb613f859f072554F29f1Ab7400265af15aB", "0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6", "0x910BD467D8576277f8f96DF47428377FFD94fEfe"]) {
    assert.ok(params.includes(a) && html.includes(a), a);
  }
  assert.match(params, /FerminuxPosaCheckpointHash = common\.HexToHash\("0xfa62e740b3cb3aaa60206476288e2e14d9a9f355a051dda896d87b576fa5af08"\)/);
  assert.ok(html.includes("0xfa62e740b3cb3aaa60206476288e2e14d9a9f355a051dda896d87b576fa5af08"));
  const genesis = JSON.parse(repo("genesis/genesis.json"));
  for (const a of Object.keys(genesis.alloc)) assert.ok(html.toLowerCase().includes(a.toLowerCase()), `genesis ${a}`);
  const canonical = JSON.parse(repo("agents/contracts/script/canonical/manifest.json"));
  for (const c of [...canonical.keyless, ...canonical.create2]) assert.ok(html.includes(c.address), c.name);
});
