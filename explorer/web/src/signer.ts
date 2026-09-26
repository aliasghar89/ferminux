/* Who confirmed a block (surfaces/explorer.md §6.1, §6.2; API.md §0 #1, §5).
   For the newest ~50 blocks the index reports signer 0x0 and no rewards; the chain is the authority.
   - signersFor(heights): cache hits first, the misses as ONE batched `clique_getSigner(hex n)` per tick.
     A confirmed block's signer never changes, so heights deeper than the 64-block reorg cap are cached
     for good (LRU); newer ones for 30 s (Clique out-of-turn races do fork near the head).
   - Fallback when the node's clique_* namespace fails: recover locally from the header seal. That code
     lives in the lazy recover.ts chunk (ethers), so the home page never loads ethers.
   - Signer numbers come from the vanity "fmx-signer<k>" in extraData, never from list position. The map
     is seeded from contracts.3961.json and refreshed from the chain once per hour. */
import { LRU, swr, TTL } from "./cache";
import { rpc, RpcError, type RawBlock } from "./rpc";
import { api } from "./api";
import { POSA_BLOCK, SIGNER_SEED } from "./known";
import { asciiOf } from "./format";
import { lc } from "./util";

const REORG_CAP = 64;
const deep = new LRU<number, string>(20_000);
const near = new Map<number, { a: string; at: number }>();
let headHint = 0;
/** head.ts tells us the head so we know which heights are final. */
export const noteHead = (n: number) => { if (n > headHint) headHint = n; };

/* ---------------------------------------------------------------- numbers and display */

const numbers = new Map<string, number>(SIGNER_SEED.map((s) => [lc(s.address), s.n]));
const display = new Map<string, string>(SIGNER_SEED.map((s) => [lc(s.address), s.address]));
/** Signer k for an address ("fmx-signer<k>"), or null when it isn't a known signer. */
export const signerNo = (addr: string | null | undefined) => (addr ? numbers.get(lc(addr)) ?? null : null);
/** "Signer 1" or null. */
export const signerName = (addr: string | null | undefined) => { const k = signerNo(addr); return k ? `Signer ${k}` : null; };
/** The address as we display it (checksummed when the book has it). */
export const signerAddr = (addr: string) => display.get(lc(addr)) ?? addr;

/** The 32-byte vanity at the head of extraData, ASCII with NULs trimmed ("fmx-signer5"). */
export const vanityOf = (extraData: string) => asciiOf(extraData.slice(0, 2 + 64));
export const vanityNo = (vanity: string | null) => { const m = vanity?.match(/fmx-signer(\d+)/); return m ? Number(m[1]) : null; };
/** The 65-byte seal at the end of extraData. */
export const sealOf = (extraData: string) => "0x" + extraData.slice(-130);
/** The signer list carried by epoch checkpoints (extraData 197 B: every 30,000 blocks from 180,000). */
export function checkpointSigners(extraData: string): string[] {
  const body = extraData.slice(2 + 64, extraData.length - 130);
  const out: string[] = [];
  for (let i = 0; i + 40 <= body.length; i += 40) out.push("0x" + body.slice(i, i + 40));
  return out;
}
/** difficulty 2 = in turn, 1 = out of turn. Never compute the rota. */
export const inTurn = (difficulty: string | number | null | undefined) => difficulty != null && Number(difficulty) === 2;

/** The authorised signer set (clique_getSigners), cached 60 s. Lower-case addresses. */
export const authorisedSigners = (signal?: AbortSignal) => swr("rpc:clique_getSigners", TTL.signers, (s) => rpc.cliqueGetSigners(s), { signal });
export const cliqueStatus = (signal?: AbortSignal) => swr("rpc:clique_status", 30_000, (s) => rpc.cliqueStatus(s), { signal });

let numbersAt = 0;
/** Re-read each authorised signer's number from the vanity of the last block it confirmed. Idle-time, hourly. */
export async function refreshSignerNumbers(signal?: AbortSignal) {
  if (Date.now() - numbersAt < 3_600_000) return;
  numbersAt = Date.now();
  try {
    const learn = (a: string, b: RawBlock | null) => { const k = b && vanityNo(vanityOf(b.extraData)); if (k) numbers.set(lc(a), k); };
    // 1 · one RPC batch: the set, the head and the 7 headers below it with their signers (covers the active rota)
    const [set, head] = await Promise.all([authorisedSigners(signal), rpc.block("latest", signal)]);
    const top = head ? Number(BigInt(head.number)) : 0;
    const ns = top ? Array.from({ length: 8 }, (_, i) => top - i).filter((n) => n >= POSA_BLOCK) : [];
    const [hs, ss] = await Promise.all([Promise.all(ns.map((n) => rpc.block(n, signal).catch(() => null))), signersFor(ns, signal)]);
    const seen = new Set<string>();
    ns.forEach((n, i) => { const a = ss.get(n); if (a) { seen.add(lc(a)); learn(a, hs[i]); } });
    // 2 · signers idle in those headers: their last confirmed block from the index, then its header
    const idle = set.filter((a) => !seen.has(lc(a)));
    const heights = await Promise.all(idle.map((a) => api.addressBlocksConfirmed(a, null, { signal }).then((p) => p.items[0]?.height ?? null).catch(() => null)));
    const heads = await Promise.all(heights.map((h) => (h ? rpc.block(h, signal).catch(() => null) : null)));
    heads.forEach((b, i) => learn(idle[i], b));
  } catch { numbersAt = 0; /* keep the seed; try again next time */ }
}

/* ---------------------------------------------------------------- signer of a block */

function cached(n: number): string | undefined {
  const d = deep.get(n); if (d) return d;
  const x = near.get(n);
  if (x && Date.now() - x.at < 30_000) return x.a;
  return undefined;
}
function remember(n: number, a: string) {
  if (headHint && n <= headHint - REORG_CAP) deep.set(n, a);
  else { near.set(n, { a, at: Date.now() }); if (near.size > 400) near.delete(near.keys().next().value as number); }
}

/**
 * Signers for many heights at once (lower-case addresses). Heights below 160,000 map to null (the
 * proof-of-work producer is the index's `producer`). A height whose signer can't be read is absent
 * from the map: render "—" with the title RPC_DOWN.
 */
export async function signersFor(heights: number[], signal?: AbortSignal): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const miss: number[] = [];
  for (const n of new Set(heights)) {
    if (n < POSA_BLOCK) { out.set(n, null); continue; }
    const c = cached(n);
    if (c) out.set(n, c); else miss.push(n);
  }
  if (!miss.length) return out;
  const res = await Promise.allSettled(miss.map((n) => rpc.cliqueGetSigner(n, signal)));
  const failed: number[] = [];
  res.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) { remember(miss[i], r.value); out.set(miss[i], r.value); }
    else failed.push(miss[i]);
  });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // The clique namespace failed (not a rate limit): recover from the headers instead.
  const namespaceDown = res.some((r) => r.status === "rejected" && r.reason instanceof RpcError && r.reason.kind === "rpc");
  if (failed.length && namespaceDown) {
    try {
      const { signerOf } = await import("./recover");
      const hs = await Promise.all(failed.map((n) => rpc.block(n, signal).catch(() => null)));
      hs.forEach((h, i) => {
        if (!h) return;
        const a = signerOf(h);
        if (a) { remember(failed[i], a.toLowerCase()); out.set(failed[i], a.toLowerCase()); }
      });
    } catch { /* chunk or RPC failed: leave them absent */ }
  }
  return out;
}
export const signerAt = async (n: number, signal?: AbortSignal) => (await signersFor([n], signal)).get(n);

/** Recover from a header we already hold (block page: we read extraData anyway). */
export async function signerFromHeader(h: RawBlock): Promise<string | null> {
  const n = Number(BigInt(h.number));
  if (n < POSA_BLOCK) return null;
  const c = cached(n); if (c) return c;
  const { signerOf } = await import("./recover");
  const a = signerOf(h)?.toLowerCase() ?? null;
  if (a) remember(n, a);
  return a;
}

/* ---------------------------------------------------------------- rewards (§6.2) */

export interface Split { total: bigint; signer: bigint; sink: bigint; treasury: bigint }
/** Per block from 160,000: (1 FMX >> floor(n / 4,500,000)) / 4, split signer 40 %, reward sink 50 %, treasury 10 %.
 *  The signer also receives the tips (`priority_fee`). Tag the result PER SCHEDULE: deterministic, not read. */
export function scheduleReward(height: number): Split | null {
  if (height < POSA_BLOCK) return null;
  const total = (10n ** 18n >> BigInt(Math.floor(height / 4_500_000))) / 4n;
  return { total, signer: (total * 40n) / 100n, sink: (total * 50n) / 100n, treasury: (total * 10n) / 100n };
}
