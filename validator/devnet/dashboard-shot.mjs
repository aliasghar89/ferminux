// Screenshot a devnet sidecar's own dashboard. The dashboard binds 127.0.0.1 inside its machine and
// answers only requests addressed to that loopback host, so every request the page makes is fetched
// from inside the container (docker exec ... curl) and handed to headless Chromium.
//   node dashboard-shot.mjs <container> <port> <out dir> <name>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "..", "..", "explorer/web/package.json"));
const { chromium } = require("@playwright/test");
const [container, port, out, name] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || "colima-fmxdev" };

function fetchInside(url) {
  const raw = execFileSync("docker", ["exec", container, "curl", "-s", "-i", url], { env, maxBuffer: 1 << 24 });
  const sep = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, sep).toString().split("\r\n");
  const status = Number(head[0].split(" ")[1]);
  const headers = {};
  for (const l of head.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  return { status, headers, body: raw.subarray(sep + 4) };
}

const browser = await chromium.launch();
for (const [label, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport: vp });
  await page.route(`${base}/**`, (route) => {
    const r = fetchInside(route.request().url());
    route.fulfill({ status: r.status, headers: r.headers, body: r.body });
  });
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(out, `${name}-${label}.png`), fullPage: true });
  if (label === "desktop") writeFileSync(join(out, `${name}.txt`), await page.innerText("body"));
  await page.close();
}
await browser.close();
writeFileSync(join(out, `${name}-api-status.json`), fetchInside(`${base}/api/status`).body);
console.log(`${name}: ${out}`);
