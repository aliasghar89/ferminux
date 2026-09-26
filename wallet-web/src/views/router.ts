// In-page routes for the unlocked wallet, kept in the URL hash so the browser
// (and a phone's back gesture) steps back through screens. Only the index
// page uses this; connect.html has its own hash protocol and never loads it.

import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'nfts'; view?: NftsView }
  | { name: 'activity' }
  | { name: 'connect' }
  | { name: 'settings' }
  | { name: 'send' }
  | { name: 'swap' }
  | { name: 'asset'; chainId: number; address: string | null };

export type TopRoute = 'home' | 'nfts' | 'activity' | 'connect' | 'settings';

/** The NFTs tab's two halves: what this account holds, and the Ferminux collections to mint from. */
export type NftsView = 'yours' | 'mint';

export function routeToHash(r: Route): string {
  if (r.name === 'home') return '#/';
  if (r.name === 'asset') return `#/asset/${r.chainId}/${r.address ?? 'native'}`;
  if (r.name === 'nfts' && r.view === 'mint') return '#/nfts/mint';
  return `#/${r.name}`;
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'nfts':
      return parts[1] === 'mint' ? { name: 'nfts', view: 'mint' } : { name: 'nfts' };
    case 'activity':
    case 'connect':
    case 'settings':
    case 'send':
    case 'swap':
      return { name: parts[0] };
    case 'asset': {
      const chainId = Number(parts[1]);
      const addr = parts[2];
      if (Number.isSafeInteger(chainId) && chainId > 0 && addr && (addr === 'native' || /^0x[0-9a-fA-F]{40}$/.test(addr))) {
        return { name: 'asset', chainId, address: addr === 'native' ? null : addr };
      }
      return { name: 'home' };
    }
    default:
      return { name: 'home' };
  }
}

/** The tab a route belongs to (for the active marker). */
export function topOf(r: Route): TopRoute {
  if (r.name === 'asset' || r.name === 'send' || r.name === 'swap') return 'home';
  return r.name;
}

/** Screens this page pushed: back() only walks back through our own entries. */
let depth = 0;

export function useRoute(): [Route, (r: Route, opts?: { replace?: boolean }) => void, () => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onPop = () => {
      depth = Math.max(0, depth - 1);
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((r: Route, opts?: { replace?: boolean }) => {
    const hash = routeToHash(r);
    try {
      if (opts?.replace) window.history.replaceState(null, '', hash);
      else if (window.location.hash !== hash) {
        window.history.pushState(null, '', hash);
        depth += 1;
      }
    } catch {
      /* sandboxed frame: state still changes */
    }
    setRoute(r);
    window.scrollTo({ top: 0 });
  }, []);

  /** Back within the wallet: history when we pushed, home otherwise. */
  const back = useCallback(() => {
    if (depth > 0) window.history.back();
    else go({ name: 'home' }, { replace: true });
  }, [go]);

  return [route, go, back];
}
