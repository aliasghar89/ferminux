// The same wallet at its other origin. One build is served at
// https://wallet.ferminux.net and at https://ferminux.net/wallet/, and a
// browser keeps a vault at the origin where it was created: a connect window
// opened at the one without it offers to continue at the other, with the same
// #origin=…&app=… (the dApp accepts the window from both and re-sends its
// request there). Pure: the Node tests drive it directly.

/** The connect pages at the wallet's other origins, when `here` is one of `urls`. */
export function otherWalletUrls(here: { origin: string; pathname: string }, urls: readonly string[]): string[] {
  const parsed = urls.flatMap((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' || u.protocol === 'http:' ? [u] : [];
    } catch {
      return [];
    }
  });
  const mine = parsed.find((u) => u.origin === here.origin && u.pathname === here.pathname);
  if (!mine) return [];
  return parsed.filter((u) => u.origin !== mine.origin).map((u) => `${u.origin}${u.pathname}`);
}

/** "ferminux.net/wallet", "wallet.ferminux.net": where a person knows their wallet from. */
export function walletPlace(connectUrl: string): string {
  const u = new URL(connectUrl);
  const path = u.pathname.replace(/\/connect\.html$/, '').replace(/\/+$/, '');
  return `${u.host}${path}`;
}

/** The other origin's connect page with this window's request parameters (the hash) carried over. */
export function handOffUrl(connectUrl: string, hash: string): string {
  const u = new URL(connectUrl);
  u.hash = hash.replace(/^#/, '');
  return u.href;
}
