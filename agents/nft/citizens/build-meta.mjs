#!/usr/bin/env node
// Ferminux Citizens: regenerates everything served under https://ferminux.net/nft/citizens/ from tiers.json.
//
//   node build-meta.mjs          writes meta/<id>.json, collection.json and contract.json
//   node build-meta.mjs --check  writes nothing; exits 1 if any output is stale or any input is wrong
//
// tiers.json is the only hand-edited file: collection config (name, symbol, prices, royalty, series) and one entry
// per token (id, source file, hashes, name, tier, series, traits). meta/<id>.json is what the contract's tokenURI
// points at; collection.json is the same objects plus "id" in one array for the gallery; contract.json is the
// collection-level metadata behind contractURI(). A token still marked needsReview blocks the build: a placeholder
// name must never reach a marketplace.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");
const db = JSON.parse(readFileSync(join(dir, "tiers.json"), "utf8"));
const C = db.collection;
const TIERS = C.tiers.map((t) => t.name);
const TRAITS = ["Species", "Background", "Headgear", "Outfit", "Accent"];
const problems = [];
const stale = [];

const put = (rel, text) => {
  const file = join(dir, rel);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  if (check) stale.push(rel);
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
};
const json = (v) => JSON.stringify(v, null, 2) + "\n";
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const article = (w) => (/^[AEIOU]/i.test(w) ? "an" : "a");

// ---- collection config ----
if (!C.name || !C.symbol) problems.push("collection.name / collection.symbol missing");
if (!/^https:\/\/[^\s]+[^/]$/.test(C.base ?? "")) problems.push(`collection.base must be an https URL without a trailing slash: ${C.base}`);
if (TIERS.join() !== "Common,Rare,Epic,Legendary") problems.push(`collection.tiers must be Common, Rare, Epic, Legendary in that order (the contract's tier index): ${TIERS}`);
for (const t of C.tiers) if (!(Number.isInteger(t.price) && t.price >= 0)) problems.push(`tier ${t.name}: price must be a whole number of FMX`);
if (!(Number.isInteger(C.royaltyBps) && C.royaltyBps >= 0 && C.royaltyBps <= 1000)) problems.push("collection.royaltyBps must be 0..1000");
if (!/^0x[0-9a-fA-F]{40}$/.test(C.royaltyReceiver ?? "")) problems.push("collection.royaltyReceiver must be an address");

// ---- tokens ----
const tokens = [...db.tokens].sort((a, b) => a.id - b.id);
const review = tokens.filter((t) => t.needsReview).map((t) => t.id);
if (review.length) problems.push(`needsReview is still true for #${review.join(", #")}: set name, tier, series and traits, then needsReview:false`);
const seenName = new Map();
const metas = [];
tokens.forEach((t, i) => {
  const id = t.id;
  if (id !== i + 1) problems.push(`ids must run 1..N without gaps: position ${i + 1} holds #${id}`);
  if (!t.name || !t.name.trim()) problems.push(`#${id}: name is empty`);
  else if (/#\d/.test(t.name)) problems.push(`#${id}: name must not carry a number ("${t.name}"); " #${id}" is added`);
  const key = (t.name ?? "").trim().toLowerCase();
  if (key && seenName.has(key)) problems.push(`#${id}: name "${t.name}" is already #${seenName.get(key)}`);
  seenName.set(key, id);
  if (!TIERS.includes(t.tier)) problems.push(`#${id}: tier "${t.tier}" is not one of ${TIERS.join("/")}`);
  if (!C.series?.[t.series]) problems.push(`#${id}: series "${t.series}" is not described in collection.series`);
  for (const k of TRAITS) if (!t.traits?.[k]) problems.push(`#${id}: trait ${k} is empty`);
  const jpg = join(dir, "images", `${id}.jpg`);
  if (!existsSync(jpg)) problems.push(`images/${id}.jpg is missing`);
  else if (sha(jpg) !== t.sha256) problems.push(`images/${id}.jpg does not match its sha256 in tiers.json`);
  for (const v of ["256.webp", "512.webp", "256.avif", "512.avif"]) if (!existsSync(join(dir, "images", `${id}-${v}`))) problems.push(`images/${id}-${v} is missing (re-run ingest)`);

  const species = (t.traits?.Species ?? "").toLowerCase();
  const meta = {
    name: `${t.name} #${id}`,
    description: `${t.name}: ${article(t.tier ?? "")} ${t.tier} ${species} from the ${t.series} series of ${C.name}, one-of-one FRC-721 portraits on Ferminux Network (chain 3961). Token #${id} exists exactly once.`,
    image: `${C.base}/images/${id}.jpg`,
    external_url: `${C.page}?id=${id}`,
    attributes: [
      { trait_type: "Tier", value: t.tier },
      { trait_type: "Series", value: t.series },
      ...TRAITS.map((k) => ({ trait_type: k, value: t.traits?.[k] ?? "" })),
      { trait_type: "Edition", value: "1/1" },
    ],
  };
  metas.push(meta);
  put(`meta/${id}.json`, json(meta));
});

// a meta file for an id that is not in tiers.json would be served for a token that does not exist
if (existsSync(join(dir, "meta"))) {
  for (const f of readdirSync(join(dir, "meta"))) {
    const id = Number(f.replace(/\.json$/, ""));
    if (!(Number.isInteger(id) && id >= 1 && id <= tokens.length)) problems.push(`meta/${f} has no token in tiers.json (delete it)`);
  }
}

put("collection.json", JSON.stringify(metas.map((m, i) => ({ id: i + 1, ...m })), null, 1) + "\n");

const contract = {
  name: C.name,
  symbol: C.symbol,
  description: C.description,
  image: `${C.base}/images/collection.jpg`,
  banner_image: `${C.base}/images/banner.jpg`,
  external_link: C.page,
  seller_fee_basis_points: C.royaltyBps,
  fee_recipient: C.royaltyReceiver,
};
for (const img of ["collection.jpg", "banner.jpg"]) if (!existsSync(join(dir, "images", img))) problems.push(`images/${img} is missing (run node build-og.mjs)`);
put("contract.json", json(contract));

if (stale.length) problems.push(`stale (run node build-meta.mjs): ${stale.length > 6 ? `${stale.slice(0, 6).join(", ")} and ${stale.length - 6} more` : stale.join(", ")}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
const count = Object.fromEntries(TIERS.map((n) => [n, tokens.filter((t) => t.tier === n).length]));
console.log(`${tokens.length} tokens ${check ? "checked" : "written"}: meta/1-${tokens.length}.json, collection.json, contract.json — ${TIERS.map((n) => `${count[n]} ${n}`).join(", ")}`);
