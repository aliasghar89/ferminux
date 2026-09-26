// Writes public/sitemap.xml (surfaces/explorer.md §10): the static routes, the contract book, the signers,
// the tokens and the agent owners. Hermetic on purpose: it reads the committed address book and the
// fixtures (refresh them with `sh fixtures/fetch.sh`), so a build never depends on the network.
//   node scripts/sitemap.mjs      (runs before every `npm run build`)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://explorer.ferminux.net";
const json = (p) => (existsSync(resolve(root, p)) ? JSON.parse(readFileSync(resolve(root, p), "utf8")) : null);

const book = json("src/data/contracts.3961.json");
const tokens = json("fixtures/lists/tokens.json")?.items ?? [];
const agents = json("fixtures/address/agent-owner/gateway-agents.json")?.items ?? [];

const urls = new Set(["/", "/blocks", "/txs", "/tokens", "/accounts", "/verified-contracts", "/stats", "/token-transfers", "/api-docs", "/contract-verification"]);
for (const c of book.contracts) urls.add(`/address/${c.address}`);
for (const a of book.accounts) urls.add(`/address/${a.address}`);
for (const s of book.signers) urls.add(`/address/${s.address}`);
for (const t of tokens) urls.add(`/token/${t.address_hash}`);
for (const a of agents) urls.add(`/address/${a.owner}`);
// the Step 1 validator pages exist only once both contracts are in the book (src/validators/config.ts)
if (book.validatorHub && book.validatorHubLens) urls.add("/validators");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...urls].map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}
</urlset>
`;
writeFileSync(resolve(root, "public/sitemap.xml"), xml);
console.log(`sitemap.xml: ${urls.size} URLs`);
