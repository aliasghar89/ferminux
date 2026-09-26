// Writes src/data/noncanonical.3961.json: forked (reorg) and uncle blocks per confirming address, crawled from
// the explorer's index (/api/v2/blocks?type=reorg|uncle). The index's blocks-confirmed counter
// (validations_count) counts them; the explorer subtracts them so "Blocks confirmed" means canonical blocks.
// Uncles are all below block 160,000 (the proof-of-work era is over), so that half never changes. Forks after
// the snapshot's maxHeight are picked up at runtime (src/canon.ts reads the newest page of the reorg list).
//   npm run noncanonical      (network: ~340 index requests, a few minutes)
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = process.env.INDEX ?? "https://explorer.ferminux.net";
const ZERO = "0x" + "0".repeat(40);

async function crawl(type) {
  const rows = [];
  let next = null;
  for (;;) {
    const q = new URLSearchParams({ type, ...(next ?? {}) });
    const r = await fetch(`${INDEX}/api/v2/blocks?${q}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${type}: HTTP ${r.status}`);
    const d = await r.json();
    for (const b of d.items) rows.push({ h: b.height, a: (b.miner?.hash ?? ZERO).toLowerCase() });
    next = d.next_page_params;
    if (!next) return rows;
  }
}
const summary = (rows) => {
  const by = {};
  for (const r of rows) if (r.a !== ZERO) by[r.a] = (by[r.a] ?? 0) + 1;
  return {
    count: rows.length,
    minHeight: Math.min(...rows.map((r) => r.h)),
    maxHeight: Math.max(...rows.map((r) => r.h)),
    byAddr: Object.fromEntries(Object.entries(by).sort((x, y) => y[1] - x[1])),
  };
};
const [reorg, uncle] = await Promise.all([crawl("reorg"), crawl("uncle")]);
const out = {
  note: "Forked (reorg) and uncle blocks per confirming address, from the explorer's index. The index's blocks-confirmed counter counts them; the explorer subtracts them. Regenerate with `npm run noncanonical`.",
  generatedAt: new Date().toISOString().slice(0, 10),
  reorg: summary(reorg),
  uncle: summary(uncle),
};
writeFileSync(resolve(root, "src/data/noncanonical.3961.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`noncanonical: ${reorg.length} forked, ${uncle.length} uncle blocks`);
