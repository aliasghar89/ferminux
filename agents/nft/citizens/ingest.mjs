#!/usr/bin/env node
// Appends a folder of artwork to Ferminux Citizens as the next token ids.
//
//   node ingest.mjs <folder> [--start N] [--series NAME] [--dry-run]
//
// Files are taken in byte order of their names (the order `LC_ALL=C ls` prints), so a re-run or a second machine
// numbers the same folder the same way. For each image, id = next free id:
//   images/<id>.jpg                    the full-size JPEG (a byte copy when the source already is one)
//   images/<id>-{256,512}.{avif,webp}  gallery copies (same encoder settings as ../build-images.sh)
// and tiers.json gets a placeholder entry with needsReview: true (name, tier and traits are for a person to set;
// build-meta.mjs refuses to publish while any entry still needs review).
//
// --start N  asserts the first id this folder gets (a guard against ingesting into the wrong place). Re-running a
//            folder that is already in tiers.json is safe: files whose sha256 is already there are skipped.
// --series   pre-fills the Series trait for every new entry.
// Needs ffmpeg, cwebp (libwebp) and avifenc (libavif).
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const TIERS_FILE = join(dir, "tiers.json");
const IMAGES = join(dir, "images");
const EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const dry = args.includes("--dry-run"); if (dry) args.splice(args.indexOf("--dry-run"), 1);
const startArg = flag("--start");
const series = flag("--series") ?? "";
const folder = args[0];
if (!folder || args.length !== 1) {
  console.error("usage: node ingest.mjs <folder> [--start N] [--series NAME] [--dry-run]");
  process.exit(2);
}
const src = resolve(folder);
if (!existsSync(src)) { console.error(`no such folder: ${src}`); process.exit(2); }

const db = JSON.parse(readFileSync(TIERS_FILE, "utf8"));
const tokens = db.tokens;
const nextId = tokens.length ? Math.max(...tokens.map((t) => t.id)) + 1 : 1;
const known = new Map(tokens.map((t) => [t.sourceSha256, t.id]));

// byte order of the file name (JS string comparison of ASCII names = C locale)
const files = readdirSync(src).filter((f) => !f.startsWith(".") && EXT.has(extname(f).toLowerCase())).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (!files.length) { console.error(`no images in ${src}`); process.exit(2); }

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const fresh = [];
for (const f of files) {
  const buf = readFileSync(join(src, f));
  const h = sha(buf);
  if (known.has(h)) { console.log(`skip ${f}: already token #${known.get(h)}`); continue; }
  if (fresh.some((x) => x.h === h)) { console.log(`skip ${f}: duplicate of ${fresh.find((x) => x.h === h).f} in this folder`); continue; }
  fresh.push({ f, h, buf });
}
if (startArg !== undefined && fresh.length && Number(startArg) !== nextId) {
  console.error(`--start ${startArg} but the next free id is ${nextId} (tiers.json has ${tokens.length} tokens). Nothing written.`);
  process.exit(1);
}
if (!fresh.length) { console.log("nothing new in this folder"); process.exit(0); }

const probe = (file) => {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file], { encoding: "utf8" }).trim();
  const [w, h] = out.split("x").map(Number);
  return { w, h };
};

console.log(`${fresh.length} new image(s) from ${basename(src)} -> ids ${nextId}..${nextId + fresh.length - 1}${dry ? " (dry run)" : ""}`);
const plan = fresh.map((x, i) => ({ ...x, id: nextId + i, dims: probe(join(src, x.f)) }));
for (const p of plan) {
  const note = p.dims.w !== p.dims.h ? `  NOT SQUARE (${p.dims.w}x${p.dims.h}): center-cropped` : "";
  console.log(`  #${p.id}  ${p.f}${note}`);
}
if (dry) process.exit(0);

mkdirSync(IMAGES, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "citizens-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

async function encode(p) {
  const input = join(src, p.f);
  const jpg = join(IMAGES, `${p.id}.jpg`);
  const isJpeg = /\.jpe?g$/i.test(p.f);
  const square = p.dims.w === p.dims.h;
  // the full-size JPEG: the original bytes when possible, so its hash is the provenance record
  if (isJpeg && square) copyFileSync(input, jpg);
  else {
    const s = Math.min(p.dims.w, p.dims.h);
    await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", `crop=${s}:${s}`, "-q:v", "2", jpg]);
  }
  for (const w of [256, 512]) {
    const png = join(tmp, `${p.id}-${w}.png`);
    await run("ffmpeg", ["-v", "error", "-y", "-i", jpg, "-vf", `scale=${w}:${w}:flags=lanczos`, png]);
    await run("cwebp", ["-quiet", "-q", "80", "-m", "6", png, "-o", join(IMAGES, `${p.id}-${w}.webp`)]);
    await run("avifenc", ["-q", "60", "-s", "4", "--sharpyuv", png, join(IMAGES, `${p.id}-${w}.avif`)]);
  }
  return { id: p.id, sha256: sha(readFileSync(jpg)) };
}

// four encoders at a time
const results = new Map();
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < plan.length) {
    const p = plan[next++];
    const r = await encode(p);
    results.set(r.id, r.sha256);
    process.stdout.write(`.`);
  }
}));
process.stdout.write("\n");

for (const p of plan) {
  tokens.push({
    id: p.id,
    source: { folder: basename(src), file: p.f },
    sourceSha256: p.h,
    sha256: results.get(p.id),
    name: "",
    tier: "Common",
    series,
    traits: { Species: "", Background: "", Headgear: "", Outfit: "", Accent: "" },
    needsReview: true,
  });
}
tokens.sort((a, b) => a.id - b.id);
writeFileSync(TIERS_FILE, JSON.stringify(db, null, 2) + "\n");
console.log(`tiers.json: ${tokens.length} tokens; review #${nextId}-#${nextId + plan.length - 1} (name, tier, series, traits), set needsReview:false, then node build-meta.mjs`);
