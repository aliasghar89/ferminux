// What the runner publishes for everyone (PUBLIC_DIR, mounted read-only into the gateway):
//   stats.json      the counters, the pause state, the float and sink, the marker and the xpub
//   addresses.bin   20 bytes per wallet, indices 0 … highestActivated (the membership set)
// Nothing here is secret. The seed and state.json stay on the private volume.
import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync, fsyncSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./state.js";

export const STATS_FILE = "stats.json";
export const ADDRESSES_FILE = "addresses.bin";
export const STATS_SCHEMA = "wizrd-loadtest/1";

const hex20 = (a: string) => Buffer.from(a.slice(2), "hex");

/**
 * Make addresses.bin hold exactly indices 0 … upTo (inclusive) of `addressOf`. Appends what is missing; rewrites
 * the file when its first entry is not wallet 0 (a different seed) or it is longer than it should be.
 */
export function syncAddresses(dir: string, upTo: number, addressOf: (i: number) => string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ADDRESSES_FILE);
  const want = (upTo + 1) * 20;
  let have = existsSync(file) ? statSync(file).size : 0;
  if (have % 20 !== 0 || have > want) have = -1;
  else if (have >= 20) {
    const first = readFileSync(file).subarray(0, 20);
    if (!first.equals(hex20(addressOf(0)))) have = -1;
  }
  if (have < 0) {
    const all = Buffer.alloc(want);
    for (let i = 0; i <= upTo; i++) hex20(addressOf(i)).copy(all, i * 20);
    writeAtomic(file, all, 0o644);
    return;
  }
  if (have === want) return;
  const from = have / 20;
  const add = Buffer.alloc(want - have);
  for (let i = from; i <= upTo; i++) hex20(addressOf(i)).copy(add, (i - from) * 20);
  const fd = openSync(file, "a", 0o644);
  try {
    writeSync(fd, add);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeStats(dir: string, stats: unknown): void {
  writeAtomic(join(dir, STATS_FILE), JSON.stringify(stats, null, 1), 0o644);
}
