import { useCallback, useEffect, useState } from 'react';

// The app's pages live in the query string, so every link the network already
// publishes (?tab=pools, ?inputCurrency=…&outputCurrency=FMX) keeps working and
// the same dist serves from dex.ferminux.net and ferminux.net/dex/ alike.

export type Page = 'swap' | 'pools' | 'liquidity' | 'charts' | 'analytics' | 'activity' | 'bridge';

const PAGES: readonly Page[] = ['swap', 'pools', 'liquidity', 'charts', 'analytics', 'activity', 'bridge'];

export interface RouteState {
  page: Page;
  /** Pool detail: ?tab=pools&pool=0x… */
  pool: string | null;
  /** Liquidity: preselected pair (?tab=liquidity&a=…&b=…). */
  pairA: string | null;
  pairB: string | null;
}

export function parseRoute(search: string): RouteState {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const tab = (q.get('tab') ?? '').toLowerCase() as Page;
  const pool = q.get('pool');
  return {
    page: PAGES.includes(tab) ? tab : 'swap',
    pool: pool && /^0x[0-9a-fA-F]{40}$/.test(pool) ? pool : null,
    pairA: q.get('a'),
    pairB: q.get('b'),
  };
}

export function routeHref(to: Partial<RouteState> & { page: Page }, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  if (to.page !== 'swap') q.set('tab', to.page);
  if (to.pool) q.set('pool', to.pool);
  if (to.pairA) q.set('a', to.pairA);
  if (to.pairB) q.set('b', to.pairB);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : window.location.pathname;
}

/** History-backed navigation over the query string. */
export function useRoute(): [RouteState, (to: Partial<RouteState> & { page: Page }, extra?: Record<string, string>) => void] {
  const [route, setRoute] = useState<RouteState>(() => parseRoute(window.location.search));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: Partial<RouteState> & { page: Page }, extra: Record<string, string> = {}) => {
    const href = routeHref(to, extra);
    window.history.pushState(null, '', href);
    setRoute(parseRoute(window.location.search));
    window.scrollTo({ top: 0 });
  }, []);
  return [route, navigate];
}
