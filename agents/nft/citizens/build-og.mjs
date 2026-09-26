#!/usr/bin/env node
// Mosaics of the artwork, from the ids listed in tiers.json collection.showcase:
//   images/collection.jpg   1024x1024  contract.json "image" (the collection avatar on marketplaces)
//   images/banner.jpg       1400x350   contract.json "banner_image"
//   ../../web/public/assets/citizens-og.jpg  1200x630  og:image of ferminux.net/nfts/citizens/
// Tiles sit on the site's black with a 4 px gap. Needs ffmpeg. Re-run only when the showcase changes.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const { collection } = JSON.parse(readFileSync(join(dir, "tiers.json"), "utf8"));
const show = collection.showcase ?? {};

function mosaic(ids, { cols, tile, gap, width, height }, out) {
  const rows = Math.ceil(ids.length / cols);
  const gridW = cols * tile + (cols - 1) * gap, gridH = rows * tile + (rows - 1) * gap;
  if (gridW > width || gridH > height) throw new Error(`${out}: ${cols}x${rows} tiles of ${tile} do not fit ${width}x${height}`);
  const inputs = [], scale = [], layout = [];
  ids.forEach((id, i) => {
    const f = join(dir, "images", `${id}.jpg`);
    if (!existsSync(f)) throw new Error(`images/${id}.jpg is missing`);
    inputs.push("-i", f);
    scale.push(`[${i}:v]scale=${tile}:${tile}:flags=lanczos,setsar=1[t${i}]`);
    layout.push(`${(i % cols) * (tile + gap)}_${Math.floor(i / cols) * (tile + gap)}`);
  });
  const px = Math.floor((width - gridW) / 2), py = Math.floor((height - gridH) / 2);
  const graph = `${scale.join(";")};${ids.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${ids.length}:layout=${layout.join("|")}:fill=black,pad=${width}:${height}:${px}:${py}:black[out]`;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "3", out]);
  console.log(`${out.replace(dir + "/", "")}: ${ids.length} tiles`);
}

mosaic(show.square, { cols: 4, tile: 253, gap: 4, width: 1024, height: 1024 }, join(dir, "images", "collection.jpg"));
mosaic(show.banner, { cols: 8, tile: 171, gap: 4, width: 1400, height: 350 }, join(dir, "images", "banner.jpg"));
mosaic(show.og, { cols: 8, tile: 146, gap: 4, width: 1200, height: 630 }, resolve(dir, "../../web/public/assets/citizens-og.jpg"));
