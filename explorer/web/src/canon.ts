/* Canonical block counts (QA data #5). The index's blocks-confirmed counter (`validations_count`) counts every
   block an address confirmed or produced, including forked blocks (replaced at the same height) and proof-of-
   work uncles. "Blocks confirmed" on this explorer means canonical blocks, so we subtract them:
   - the snapshot in data/noncanonical.3961.json (scripts/noncanonical.mjs), per address;
   - plus any forked block the index recorded above the snapshot's maxHeight, read from the newest pages of
     /blocks?type=reorg (one request in the normal case; cached 60 s).
   Uncles are all below block 160,000, so that half of the snapshot never changes. */
import snap from "./data/noncanonical.3961.json";
import { api } from "./api";
import { swr } from "./cache";
import { isAbort, lc } from "./util";
import type { PageParams } from "./types";

const reorgBase = snap.reorg.byAddr as Record<string, number>;
const uncleBase = snap.uncle.byAddr as Record<string, number>;

/** Forked blocks newer than the snapshot, per address (lower-case). At most 5 pages (250 new forks). */
const freshReorgs = (signal?: AbortSignal) => swr("canon:reorgs-after-snapshot", 60_000, async (s) => {
  const by: Record<string, number> = {};
  let next: PageParams | null = null;
  for (let i = 0; i < 5; i++) {
    const p = await api.blocks("reorg", next, { signal: s });
    let past = false;
    for (const b of p.items) {
      if (b.height <= snap.reorg.maxHeight) { past = true; break; }
      const a = lc(b.signer?.hash ?? b.producer?.hash ?? "");
      if (a) by[a] = (by[a] ?? 0) + 1;
    }
    if (past || !p.next_page_params) break;
    next = p.next_page_params;
  }
  return by;
}, { signal });

export interface NonCanonical { forked: number; uncles: number }

/** How many of an address's recorded blocks are not canonical. The snapshot alone when the index can't answer. */
export async function nonCanonical(addr: string, signal?: AbortSignal): Promise<NonCanonical> {
  const a = lc(addr);
  let fresh = 0;
  try { fresh = (await freshReorgs(signal))[a] ?? 0; } catch (e) { if (isAbort(e)) throw e; }
  return { forked: (reorgBase[a] ?? 0) + fresh, uncles: uncleBase[a] ?? 0 };
}

/** The index's counter minus the non-canonical blocks, never below 0. */
export const canonicalCount = (raw: number, nc: NonCanonical) => Math.max(0, raw - nc.forked - nc.uncles);

/** "excludes 3 forked blocks" / "excludes 16,110 uncle blocks", or "" when there is nothing to exclude. */
export function excludedText(nc: NonCanonical): string {
  const parts: string[] = [];
  if (nc.forked) parts.push(`${nc.forked.toLocaleString("en-US")} forked`);
  if (nc.uncles) parts.push(`${nc.uncles.toLocaleString("en-US")} uncle`);
  return parts.length ? `excludes ${parts.join(" and ")} block${nc.forked + nc.uncles === 1 ? "" : "s"}` : "";
}
