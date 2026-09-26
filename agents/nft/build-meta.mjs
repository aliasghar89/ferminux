#!/usr/bin/env node
// Normalises meta/<id>.json for all 41 tokens and rebuilds collection.json from them (same order, same
// bytes), so the per-token files the contract's tokenURI points at and the gallery's single array cannot
// drift. `--check` writes nothing and exits 1 on any problem (run it before copying agents/nft/ to the site).
//
// Traits: every token is a one-of-one, so "Edition" is "1/1" on all 41 (it used to read "Genesis 40" on
// 1-40, which is the set, not an edition size). The set is its own trait: "Genesis 40" for the archetypes,
// "Legendary" for #41. external_url opens the token itself on ferminux.net, not the gallery's first page.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const MAX_ID = 41;
const IMG = "https://ferminux.net/nft/agents/images/";
const APP = "https://ferminux.net/nfts/";
const check = process.argv.includes("--check");

// Python's json.dumps(ensure_ascii=True) wrote the originals; keep their bytes stable across runs.
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const dump = (v, indent) => ascii(JSON.stringify(v, null, indent));

const problems = [];
const metas = [];
for (let id = 1; id <= MAX_ID; id++) {
  const file = join(dir, "meta", `${id}.json`);
  if (!existsSync(file)) { problems.push(`meta/${id}.json is missing`); continue; }
  const m = JSON.parse(readFileSync(file, "utf8"));
  const attr = (t) => m.attributes?.find((a) => a.trait_type === t)?.value;
  const legendary = attr("Category") === "Legendary";
  const set = attr("Set") ?? (legendary ? "Legendary" : "Genesis 40");
  const out = {
    name: m.name,
    description: m.description,
    image: `${IMG}${id}.png`,
    external_url: `${APP}?id=${id}`,
    attributes: [
      { trait_type: "Archetype", value: attr("Archetype") },
      { trait_type: "Category", value: attr("Category") },
      { trait_type: "Number", value: id },
      { trait_type: "Set", value: set },
      { trait_type: "Edition", value: "1/1" },
    ],
  };
  if (typeof out.name !== "string" || !out.name.endsWith(` #${id}`)) problems.push(`#${id}: name "${out.name}" does not end in " #${id}"`);
  if (typeof out.description !== "string" || out.description.length < 20) problems.push(`#${id}: description missing or too short`);
  if (!attr("Archetype") || !attr("Category")) problems.push(`#${id}: Archetype/Category trait missing`);
  if (attr("Number") !== id) problems.push(`#${id}: Number trait is ${attr("Number")}`);
  if (m.image !== out.image) problems.push(`#${id}: image is ${m.image}, expected ${out.image}`);
  if (!existsSync(join(dir, "images", `${id}.png`))) problems.push(`images/${id}.png is missing`);
  for (const v of ["256.webp", "512.webp", "256.avif", "512.avif"]) if (!existsSync(join(dir, "images", `${id}-${v}`))) problems.push(`images/${id}-${v} is missing (run build-images.sh)`);
  if ((id === MAX_ID) !== legendary) problems.push(`#${id}: only #${MAX_ID} is the Legendary`);
  const text = dump(out, 2);
  if (readFileSync(file, "utf8") !== text) {
    if (check) problems.push(`meta/${id}.json is not normalised (run node build-meta.mjs)`);
    else writeFileSync(file, text);
  }
  metas.push(out);
}
const names = new Set(metas.map((m) => m.attributes[0].value));
if (names.size !== metas.length) problems.push("two tokens share an Archetype");
const coll = dump(metas, 1);
const collFile = join(dir, "collection.json");
if (!existsSync(collFile) || readFileSync(collFile, "utf8") !== coll) {
  if (check) problems.push("collection.json does not match meta/*.json (run node build-meta.mjs)");
  else writeFileSync(collFile, coll);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`${metas.length} tokens ${check ? "checked" : "written"}: meta/1-${MAX_ID}.json + collection.json`);
