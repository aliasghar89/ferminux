// /bridge/ (2026-09-29) replaces the old bridge app shell with an honest "the bridge is paused" page in the site's
// chrome. It is a Vite entry, linked from the header, the footer, the sitemap and llms.txt; it warns against sending
// to the bridge contracts, prints only addresses the bridge's own records name, never offers a PancakeSwap swap,
// and keeps the naming rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const web = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const repo = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const html = web("bridge/index.html");
const text = html.replace(/<!--[\s\S]*?-->/g, "");

test("a Vite entry with its canonical URL, its script and the shared chrome (the official logo comes with @header)", () => {
  assert.match(web("vite.config.ts"), /resolve\(root, "bridge\/index\.html"\)/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ferminux\.net\/bridge\/">/);
  assert.match(html, /src="\/src\/pages\/bridge\.ts"/);
  for (const hook of ["<!-- @head -->", "<!-- @header -->", "<!-- @footer -->"]) assert.ok(html.includes(hook), hook);
  assert.match(web("src/partials/header.html"), /<use href="#fx-mark"\/>[\s\S]*<use href="#fx-word"\/>/);
});

test("linked from the header, the footer, the sitemap, llms.txt and llms-full.txt", () => {
  assert.match(web("src/partials/header.html"), /data-nav="bridge" href="\/bridge\/"/);
  assert.ok(web("src/partials/footer.html").includes('href="/bridge/"'));
  assert.ok(web("public/sitemap.xml").includes("<loc>https://ferminux.net/bridge/</loc>"));
  assert.ok(web("public/llms.txt").includes("https://ferminux.net/bridge/"));
  assert.ok(web("public/llms-full.txt").includes("/bridge/"));
});

test("says it is paused, warns against sending, and names the plan and the alternatives", () => {
  assert.match(text, /<h1>The bridge is paused<\/h1>/);
  assert.match(text, /Do not send FMX or wFMX to the bridge contracts/);
  assert.match(text, /11 September 2026/);
  assert.match(text, /bridge v2/i);
  assert.match(text, /There is no date\./);
  assert.ok(text.includes('href="/buy-fmx/"'), "buy-fmx route");
  assert.ok(text.includes('href="https://dex.ferminux.net"'), "DEX route");
  assert.ok(!/<form\b/i.test(text), "no transfer form");
});

test("every address on the page is one the bridge's own records name", () => {
  const known = [repo("bridge/ui/src/config.ts"), repo("bridge/relayer/config/chains.json"), web("whitepaper/index.html")].join("\n").toLowerCase();
  const addrs = new Set([...text.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]).filter((a) => !/^0x0{40}$/.test(a)));
  assert.ok(addrs.size >= 5, `addresses: ${addrs.size}`);
  for (const a of addrs) assert.ok(known.includes(a.toLowerCase()), `${a} is not in the bridge records`);
  assert.ok(addrs.has("0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0"), "wFMX");
});

test("no PancakeSwap swap link, and the naming rules hold", () => {
  assert.ok(!/href="https:\/\/pancakeswap\.finance/.test(text));
  assert.doesNotMatch(text, /\bERC-?\d/i);
  assert.doesNotMatch(text, /\bmin(ing|er|ers|ed)\b/i);
  assert.doesNotMatch(text, /proof[- ]of[- ]stake/i);
  assert.doesNotMatch(text, /Ethereum/);
  assert.doesNotMatch(text, /trustless/i);
});
