/* Wizrd's labelled network load test (agents/loadtest; manifest https://ferminux.net/.well-known/wizrd-loadtest.json).
   Every one of its transactions is a plain FMX transfer whose input starts with the FXLT marker 0x46584c54. Anyone
   can put those four bytes in an input, so the marker alone labels nothing: a transaction carries the chip only
   when its SENDER is one of the load test's wallets, asked of the gateway (GET /api/loadtest/address/:a, cached
   10 min, the same check that labels wallet pages). A marked row paints unlabelled and is upgraded in place once
   the answer is in (`hydrateMethods`); a sender already asked about labels at once.
   The network totals leave the load test out; its own count is shown beside them, labelled
   (GET /api/loadtest/stats, cached 60 s, read again when a figure has moved since):
   - transactions (total and last 24 h): the runner's chain walk (stats.organic), every transaction in the
     blocks that is not the load test's. Exact at any rate; used whenever the walk is current.
   - addresses, and transactions when the walk is not current: the index's figure minus the load-test count
     recorded for exactly that figure (stats.indexSnapshot: the runner reads the index every few seconds and,
     when a figure changes, records what of ours it can hold). A figure the runner has not read yet was counted
     moments ago and holds about our live count. One it cannot pair yet shows the last figure it could, and
     failing that the index's own, each saying so in its title.
   Only when the counters can't be read at all are figures labelled as possibly including the load test. The
   gateway answers CORS * and ferminux.net is already in connect-src (see gateway.ts), so nothing here needs a
   proxy. */
import "./styles/loadtest.css";
import { html, type Html } from "./ui/html";
import { getJson, ApiError } from "./api";
import { swr } from "./cache";
import { GW_BASE } from "./gateway";
import { int, relTime } from "./format";
import { lc } from "./util";

export const LT_MARKER = "0x46584c54";
export const LT_MANIFEST = "https://ferminux.net/.well-known/wizrd-loadtest.json";
const LT_WHY = "A labelled network load test run by Wizrd (agent #12). Its transactions carry the FXLT marker and are not counted as usage.";

/** True when a transaction's input starts with the FXLT marker. On its own this proves nothing: see isLoadTestTx. */
export const isLoadTestInput = (input: string | null | undefined) => typeof input === "string" && input.slice(0, 10).toLowerCase() === LT_MARKER;

/* ---------------------------------------------------------------- the sender check */

type LtTx = { raw_input?: string | null; from?: { hash: string } | null };
/** Senders already asked about (lower case): the gateway's answer and when it came, kept as long as ltAddress's. */
const ltSenders = new Map<string, { yes: boolean; at: number }>();
const senderKnown = (a: string): boolean | undefined => {
  const e = ltSenders.get(lc(a));
  return e && Date.now() - e.at < 600_000 ? e.yes : undefined;
};
/** A load-test transaction: the FXLT marker in the input AND a sender the gateway lists as a load-test wallet. */
export const isLoadTestTx = (tx: LtTx) => isLoadTestInput(tx.raw_input) && !!tx.from?.hash && senderKnown(tx.from.hash) === true;
/** Marked, but its sender has not been asked about yet (paint it unlabelled, then ask: ltSender). */
export const ltSenderPending = (tx: LtTx) => isLoadTestInput(tx.raw_input) && !!tx.from?.hash && senderKnown(tx.from.hash) === undefined;
/** Is `a` a load-test wallet? False when the gateway cannot say (it stays unlabelled; asked again next time). */
export async function ltSender(a: string, signal?: AbortSignal): Promise<boolean> {
  const known = senderKnown(a);
  if (known !== undefined) return known;
  try {
    const yes = (await ltAddress(a, signal)).loadtest === true;
    ltSenders.set(lc(a), { yes, at: Date.now() });
    return yes;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return false;
  }
}

/** The chip: a span in dense lists (the row is already a link), a link to the manifest on detail pages. */
export const ltChip = (link = false): Html => link
  ? html`<a class="lt-chip" href="${LT_MANIFEST}" rel="noopener" title="${LT_WHY} Opens the manifest.">Wizrd load test</a>`
  : html`<span class="lt-chip" title="${LT_WHY}">Wizrd load test</span>`;

/* ---------------------------------------------------------------- gateway reads */

/** An index figure and the load-test count it holds (agents/loadtest Runner.readIndex): `lt` is the middle of
 *  [lo, hi], our counts at the reads before and after the recount; lo null = no earlier read (not used). */
export interface LtSnap { index: number; lt: number; at: number; lo?: number | null; hi?: number }
export type LtKey = "transactions" | "addresses" | "last24h";
/** The runner's chain walk (agents/loadtest/src/organic.ts): organic transactions through `throughBlock`. */
export interface LtOrganic { ready: boolean; throughBlock: number; transactions?: number; last24h?: number; loadtest?: number; at?: number }
export interface LtStats {
  deployed: boolean;
  available?: boolean;
  mode?: string;
  updatedAt?: number;
  counters?: { transactions: number; addresses: number; addressesOnChain?: number };
  daily?: Record<string, number>;
  last24h?: number;
  lastTx?: { at: number; block: number } | null;
  organic?: LtOrganic | null;
  indexSnapshot?: Partial<Record<LtKey, LtSnap[]>>;
  indexRead?: ({ at: number } & Partial<Record<LtKey, number>>) | null;
  manifest?: string;
}
export interface LtAddress { address: string; loadtest: boolean; index: number | null; role: "float" | "wallet" | "sink" | null }

let ltReadAt = 0; // when the counters in the cache were fetched (ms)
const statsUrl = `${GW_BASE}/loadtest/stats`;
export const ltStats = (signal?: AbortSignal, fresh = false) => swr<LtStats>(statsUrl, 60_000, (s) => getJson<LtStats>(statsUrl, s, { retries: 1 }).then((v) => { ltReadAt = Date.now(); return v; }), { signal, fresh });
export const ltAddress = (a: string, signal?: AbortSignal) => swr<LtAddress>(`${GW_BASE}/loadtest/address/${lc(a)}`, 600_000, (s) => getJson<LtAddress>(`${GW_BASE}/loadtest/address/${lc(a)}`, s, { retries: 1 }), { signal });
/** The counters, or null when the gateway didn't answer (never throws, except on abort). A gateway without the
 *  routes (404) has no load test to subtract: that reads as "not deployed", not as "unknown". */
export const ltStatsOrNull = (signal?: AbortSignal, fresh = false): Promise<LtStats | null> => ltStats(signal, fresh).catch((e) => {
  if (e instanceof DOMException && e.name === "AbortError") throw e;
  if (e instanceof ApiError && e.kind === "not_found") return { deployed: false };
  return null;
});
/**
 * The counters for these index figures. A figure the cached counters can't pair (the index recounted after
 * they were fetched) is worth one fresh read: the runner has usually recorded it within seconds.
 */
export async function ltStatsFor(signal: AbortSignal | undefined, figs: Partial<Record<LtKey, string | number | null | undefined>>): Promise<LtStats | null> {
  const lt = await ltStatsOrNull(signal);
  if (!lt?.deployed || Date.now() - ltReadAt < 10_000) return lt;
  const unpaired = (Object.keys(figs) as LtKey[]).some((k) => {
    const t = num(figs[k]);
    if (t === null || (k !== "addresses" && chainFigure(lt, k) !== null)) return false;
    return !lt.indexSnapshot?.[k]?.some((x) => Number(x?.index) === t);
  });
  return unpaired ? (await ltStatsOrNull(signal, true)) ?? lt : lt;
}

/* ---------------------------------------------------------------- organic figures */

/**
 * "exact": without the load test (from the chain walk, or the index's figure minus what it holds);
 * "approx": the index's figure holds between lo and hi of ours and that doubt is large next to what is left
 * (a small figure counted while the load test was sending fast): the middle of the range, shown with ≈;
 * "earlier": the index's newest figure can't be paired yet, so the last one that could is shown (asOf);
 * "reported": nothing to pair it with yet: the index's own figure; "unknown": the counters can't be read;
 * "none": no load test to leave out.
 */
export type LtState = "none" | "exact" | "approx" | "earlier" | "reported" | "unknown";
export interface Organic { n: number | null; state: LtState; src?: "chain" | "index"; asOf?: number; through?: number; excluded?: number; range?: [number, number] }

/** An organic figure as text: "10,802", "≈ 20", or "—". */
export const orgText = (o: Organic): string => (o.n === null ? "—" : `${o.state === "approx" ? "≈ " : ""}${int(o.n)}`);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const nowS = () => Date.now() / 1000;
/** The runner stopped publishing (the test is over and its service gone, or it is down). */
const stale = (lt: LtStats) => nowS() - Number(lt.updatedAt ?? 0) > 900;
/** Has the load test put anything on chain? */
/** The test has been stopped for good (DRAIN finished): the notes beside the totals go away; rows keep their chip. */
const ended = (lt: LtStats) => lt.mode === "drained" || (lt as { drained?: boolean }).drained === true;
const active = (lt: LtStats) => Number(lt.counters?.transactions ?? 0) > 0 || Object.values(lt.indexSnapshot ?? {}).some((l) => l?.some((x) => Number(x?.lt) > 0));
/** Our live count for a key. */
function live(lt: LtStats, key: LtKey): number {
  if (key === "last24h") {
    // a runner gone for more than a day has nothing left in the window
    if (stale(lt) && Number(lt.lastTx?.at ?? 0) < nowS() - 86_400) return 0;
    return Number(lt.last24h ?? 0) || 0;
  }
  if (key === "addresses") return Number(lt.counters?.addressesOnChain ?? lt.counters?.addresses ?? 0) || 0;
  return Number(lt.counters?.transactions ?? 0) || 0;
}
/** The chain walk's figure, when the walk is current. */
function chainFigure(lt: LtStats, key: "transactions" | "last24h"): number | null {
  const o = lt.organic;
  if (!o?.ready || stale(lt) || Number(lt.updatedAt ?? 0) - Number(o.at ?? 0) > 300) return null;
  return num(key === "transactions" ? o.transactions : o.last24h);
}
const usable = (x: LtSnap) => x.lo !== null || !Number(x.hi);
/** What of ours the index's figure `t` holds: its snapshot's count (and range); our live count for a figure the
 *  runner has not read yet (counted moments ago); null when it can't be told. */
function ltIn(lt: LtStats, key: LtKey, t: number): { x: number; lo?: number; hi?: number } | null {
  const snaps = lt.indexSnapshot?.[key];
  if (Array.isArray(snaps)) for (let i = snaps.length - 1; i >= 0; i--) {
    const sn = snaps[i];
    if (Number(sn?.index) !== t) continue;
    if (!usable(sn)) return null;
    const lo = num(sn.lo), hi = num(sn.hi);
    return lo !== null && hi !== null ? { x: Number(sn.lt) || 0, lo, hi } : { x: Number(sn.lt) || 0 };
  }
  if (lt.indexRead && num(lt.indexRead[key]) === t) return null;
  return { x: live(lt, key) };
}
/** The newest figure that could be paired, without the load test. */
function lastPaired(lt: LtStats, key: LtKey): { n: number; at: number } | null {
  const snaps = lt.indexSnapshot?.[key] ?? [];
  for (let i = snaps.length - 1; i >= 0; i--) {
    const x = snaps[i];
    if (x && usable(x) && Number(x.index) - Number(x.lt) >= 0) return { n: Number(x.index) - Number(x.lt), at: Number(x.at) };
  }
  return null;
}

/** A network figure without the load test: `total` is the index's figure for `key`. */
export function organic(total: string | number | null | undefined, lt: LtStats | null, key: LtKey): Organic {
  const t = num(total);
  if (lt === null) return { n: t, state: "unknown" };
  if (!lt.deployed || !active(lt)) return { n: t, state: "none" };
  if (key !== "addresses") {
    const c = chainFigure(lt, key);
    if (c !== null) return { n: c, state: "exact", src: "chain", through: lt.organic?.throughBlock };
  }
  if (t === null) return { n: null, state: "none" };
  const m = ltIn(lt, key, t);
  if (m && m.lo !== undefined && m.hi !== undefined) {
    const n = t - m.x, a = Math.max(0, t - m.hi), b = Math.max(0, t - m.lo);
    if (n >= 0 && (b - a) / 2 <= Math.max(5, n * 0.05)) return { n, state: "exact", src: "index", excluded: m.x };
    return { n: Math.round((a + b) / 2), state: "approx", src: "index", range: [a, b] };
  }
  if (m && t - m.x >= 0) return { n: t - m.x, state: "exact", src: "index", excluded: m.x };
  const e = lastPaired(lt, key);
  if (e) return { n: e.n, state: "earlier", asOf: e.at };
  return { n: t, state: "reported" };
}

/** The title on an organic figure (what it is, and where it comes from). */
export function organicTitle(o: Organic, what: string): string | undefined {
  if (o.state === "exact" && o.src === "chain") return `Every ${what === "addresses" ? "address" : "transaction"} on chain except Wizrd's load test, counted from the blocks${o.through !== undefined ? ` through block ${int(o.through)}` : ""}`;
  if (o.state === "exact") return `The index's count without Wizrd's load test (${int(o.excluded ?? 0)} load-test ${what})`;
  if (o.state === "approx" && o.range) return `Between ${int(o.range[0])} and ${int(o.range[1])} without Wizrd's load test: the index counted these while the load test was sending, so its share is known only to within that range`;
  if (o.state === "earlier") return `Without Wizrd's load test, from the index's count ${o.asOf ? relTime(o.asOf) : "before"}; its newest count can't be paired with the load test, the next one (every 5 minutes) will be`;
  if (o.state === "reported") return `The index's own count: Wizrd's load test is taken out from its next count (every 5 minutes)`;
  if (o.state === "unknown") return `May include Wizrd load-test ${what}: their count is unavailable from ferminux.net right now`;
  return undefined;
}

/** Transactions per day without the load test's (UTC days, as the index counts them; clamped at 0). */
export function organicDaily<T extends { date: string }>(pts: T[], get: (p: T) => number, lt: LtStats | null): { date: string; n: number; lt: number }[] {
  const d = lt?.deployed ? lt.daily ?? {} : {};
  return pts.map((p) => { const x = Number(d[p.date] ?? 0); return { date: p.date, n: Math.max(0, get(p) - x), lt: x }; });
}

/** The load test's wallets on chain (funded at least once, and the float): the figure left out of Addresses.
 *  An older runner publishes only `addresses`, which also counts wallets planned but not funded yet. */
const ltWallets = (lt: LtStats) => Number(lt.counters?.addressesOnChain ?? lt.counters?.addresses ?? 0) || 0;
const about = html`<a class="link-inline" href="${LT_MANIFEST}" rel="noopener">About ↗</a>`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** One run of inline text, the chip first: it wraps as a sentence on a phone instead of stacking in pieces. */
const line = (body: Html) => html`<span class="lt-text">${ltChip()} ${body} <span class="faint" aria-hidden="true">·</span> ${about}</span>`;
const unavailable = (what: string) => line(html`${what} may include its transactions: their count is unavailable from ferminux.net right now.`);

/**
 * The line beside the totals: "WIZRD LOAD TEST 13,206 transactions · 4,221 wallets — labelled, not counted in
 * the totals · About ↗". Figures that could not be corrected yet say so in their own titles; the line changes
 * only when one is still the index's own count, or when the counters can't be read at all. Empty when there is
 * no load test.
 */
export function ltNote(lt: LtStats | null, ...figs: Organic[]): Html | "" {
  if (lt === null) return figs.some((o) => o.n !== null) ? unavailable("Totals") : "";
  if (!lt.deployed || !active(lt) || ended(lt)) return "";
  const tx = Number(lt.counters?.transactions ?? 0), w = ltWallets(lt);
  const pending = figs.some((o) => o.state === "reported");
  return line(html`<span class="num-mono">${int(tx)}</span> ${plural(tx, "transaction", "transactions")} · <span class="num-mono">${int(w)}</span> ${plural(w, "wallet", "wallets")} — labelled, ${pending ? "left out of the totals from the index's next count" : "not counted in the totals"}`);
}

/** The same for a page with one address total (/accounts): "4,221 wallets — labelled, not counted in this total". */
export function ltWalletsNote(lt: LtStats | null, o: Organic): Html | "" {
  if (lt === null) return o.n !== null ? line(html`This total may include its wallets: their count is unavailable from ferminux.net right now.`) : "";
  if (!lt.deployed || !active(lt) || ended(lt)) return "";
  const w = ltWallets(lt);
  return line(html`<span class="num-mono">${int(w)}</span> ${plural(w, "wallet", "wallets")} — labelled, ${o.state === "reported" ? "left out of this total from the index's next count" : "not counted in this total"}`);
}

/** The note under a per-day chart: the load-test transactions these days leave out. */
export function ltDailyNote(days: { lt: number }[], lt: LtStats | null): Html | "" {
  if (lt === null) return unavailable("Days");
  if (ended(lt)) return "";
  const n = days.reduce((a, d) => a + d.lt, 0);
  if (!n) return "";
  return line(html`<span class="num-mono">${int(n)}</span> ${plural(n, "transaction", "transactions")} on these days — labelled, not counted`);
}

/* ---------------------------------------------------------------- the address label */

/** Fill `host` with the "Wizrd load-test wallet" label when the gateway says `a` is one. Silent otherwise. */
export async function ltAddressLabel(host: HTMLElement | null, a: string, signal: AbortSignal) {
  if (!host) return;
  try {
    const r = await ltAddress(a, signal);
    if (signal.aborted || !r.loadtest) return;
    const what = r.role === "float" ? "Wizrd load-test float" : "Wizrd load-test wallet";
    const idx = r.index !== null ? html` <span class="faint num-mono">#${int(r.index)}</span>` : "";
    host.innerHTML = html`<p class="ad-banner lt-banner">${ltChip()}<span><b>${what}</b>${idx}</span><span class="faint">${r.role === "float" ? "funds the load-test wallets and returns every coin to Wizrd" : "part of a labelled network load test; its transactions are not counted as usage"}</span><a class="link-arrow" href="${LT_MANIFEST}" rel="noopener">Manifest ↗</a></p>`.s;
  } catch { /* the gateway didn't answer: no label (list rows still carry their chip) */ }
}
