/* Exact transaction counts per address (QA data #6, #12). The index's `transactions_count` (on /counters and on
   the /addresses list) is a cached counter that drifts: 32 for an address with 30 transactions, 24 for one with
   25, empty for some. The index's own transaction list is right, so we count that:
   - /tabs-counters counts the list exactly up to 50 (it answers 51 for "more"): one request;
   - above 50, page through /addresses/:a/transactions (50 per page, cursor paging) and count the rows. The
     busiest address on chain 3961 has under 500 transactions (10 pages). Capped at MAX_PAGES; past that we
     keep the index's counter and say so.
   Results are cached 60 s per address, and at most 3 addresses are counted at once. */
import { api } from "./api";
import { swr } from "./cache";
import { lc } from "./util";
import type { PageParams } from "./types";

const MAX_PAGES = 40;

export interface TxCount { n: number; exact: boolean }

let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

async function pageCount(a: string, signal: AbortSignal): Promise<TxCount | null> {
  let n = 0;
  let next: PageParams | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const p = await api.addressTxs(a, null, next, { signal });
    n += p.items.length;
    if (!p.next_page_params) return { n, exact: true };
    next = p.next_page_params;
  }
  return null;
}

/**
 * The exact number of transactions the index lists for an address (from, to or created). `counter` is the
 * index's own counter, used only when the list is too long to count here (then `exact` is false).
 */
export function txCount(addr: string, o: { signal?: AbortSignal; counter?: string | number | null } = {}): Promise<TxCount> {
  const a = lc(addr);
  return swr<TxCount>(`count:txs:${a}`, 60_000, (s) => slot(async () => {
    const t = await api.addressTabsCounters(addr, { signal: s });
    if (!t.transactions_count.capped) return { n: t.transactions_count.n, exact: true };
    const counted = await pageCount(addr, s);
    if (counted) return counted;
    const c = Number(o.counter);
    return { n: Number.isFinite(c) && c > 50 ? c : 50, exact: false };
  }), { signal: o.signal });
}
