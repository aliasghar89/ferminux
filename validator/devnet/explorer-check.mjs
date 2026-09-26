// Render the explorer's validator pages against the devnet: serves a local explorer build (built with
// VITE_RPC=http://127.0.0.1:39545 and the devnet hub + lens, see explorer.sh) on 127.0.0.1 with the
// same SPA fallback nginx uses, opens each page in headless Chromium at desktop and phone widths,
// and saves a screenshot and the rendered text of each. Nothing leaves this machine: every other
// request (the Blockscout /api the chrome may ask for) is answered 404 locally.
//   node explorer-check.mjs <dist dir> <out dir> <path> [path...]
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "..", "..", "explorer/web/package.json"));
const { chromium } = require("@playwright/test");

const [dist, out, ...paths] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain", ".png": "image/png" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let f = join(dist, decodeURIComponent(url.pathname));
  if (url.pathname.startsWith("/api")) { res.writeHead(404); return res.end(); }
  if (!existsSync(f) || statSync(f).isDirectory()) {
    f = /^\/validators(\/|$)/.test(url.pathname) ? join(dist, "validators.html") : join(dist, "index.html");
  }
  res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(4319, "127.0.0.1", r));

const browser = await chromium.launch();
const report = [];
for (const [label, vp] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport: vp });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const p of paths) {
    await page.goto(`http://127.0.0.1:4319${p}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(4000);
    const name = `${label}${p.replace(/[^a-z0-9]+/gi, "_")}`;
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    const text = (await page.innerText("main").catch(() => page.innerText("body"))).replace(/\n{3,}/g, "\n\n");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    writeFileSync(join(out, `${name}.txt`), text);
    report.push({ viewport: label, path: p, title: await page.title(), horizontalOverflowPx: overflow, textChars: text.length, errors: errors.splice(0) });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(JSON.stringify(report, null, 1));
