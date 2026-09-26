// Deep links into the wallet: what a URL the app (or the web wallet) was
// opened with asks for.
//
// Pure module: no browser globals, no Capacitor. The same code classifies the
// Android intent / iOS URL the app receives and the https://wallet.ferminux.net/wc
// page the web wallet is opened at, and the Node unit tests run it directly.
//
// Accepted shapes
//   wc:<topic>@2?relay-protocol=irn&symKey=<hex>…     a pairing code  -> wc-pair
//   wc:<topic>@2 (no symKey)                           "open the wallet, a request waits" -> wc-request
//   ferminuxwallet://wc?uri=<encoded wc: uri>          our own scheme (WalletConnect `redirect.native`)
//   ferminuxwallet://wc?requestId=…&sessionTopic=…     a dApp sending the user back for a request
//   https://wallet.ferminux.net/wc?uri=…               app link / universal link, same query
//   https://ferminux.net/wallet/wc?uri=…               the wallet's second origin
// Anything else is null: the app ignores links it does not understand.
//
// A pairing only ever creates a *proposal*; the user still approves it in the
// wallet, so a link from anywhere can at most put a question on screen.

export const APP_SCHEME = 'ferminuxwallet';

/** Hosts whose /wc path is the wallet's app link (Android App Links / iOS universal links). */
export const APP_LINK_HOSTS: readonly string[] = ['wallet.ferminux.net', 'ferminux.net'];

export type DeepLink =
  /** A WalletConnect pairing code: pair, then show the proposal. */
  | { kind: 'wc-pair'; uri: string }
  /** A dApp sent the user here for a pending request (sign / send); nothing to pair. */
  | { kind: 'wc-request'; requestId: string | null; sessionTopic: string | null }
  /** The wallet's own link with nothing in it: just open the app. */
  | { kind: 'open' };

const WC_PAIR = /^wc:[0-9a-f]{64}@2\?/i;

function classifyWc(uri: string): DeepLink | null {
  const s = uri.trim();
  if (!/^wc:/i.test(s)) return null;
  const at = /^wc:([^@?]+)@(\d+)\??(.*)$/i.exec(s);
  if (!at) return null;
  const params = new URLSearchParams(at[3]);
  if (WC_PAIR.test(s) && params.get('symKey')) return { kind: 'wc-pair', uri: s };
  // A bare "wc:<topic>@2" (or with only relay params) is the WalletConnect
  // convention for "bring the wallet forward": the request itself arrives over the relay.
  return { kind: 'wc-request', requestId: params.get('requestId'), sessionTopic: params.get('sessionTopic') ?? at[1] };
}

/** `uri=` may arrive encoded once or twice (some dApp kits encode the whole link again). */
function unwrap(value: string): string {
  let v = value.trim();
  for (let i = 0; i < 2 && /^wc%3a/i.test(v); i += 1) {
    try {
      v = decodeURIComponent(v);
    } catch {
      break;
    }
  }
  return v;
}

function isWalletPath(pathname: string): boolean {
  // /wc, /wc/, /wallet/wc, /wallet/wc/ (the second origin serves the wallet under /wallet/)
  return /^\/(?:wallet\/)?wc\/?$/i.test(pathname);
}

/**
 * Classify a link the wallet was opened with. `extraHosts` lets a test or
 * a staging build accept its own origin (e.g. http://localhost:5173/wc).
 */
export function parseDeepLink(raw: string | null | undefined, extraHosts: readonly string[] = []): DeepLink | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (input === '' || input.length > 4096) return null;

  if (/^wc:/i.test(input)) return classifyWc(input);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  let ours = false;
  if (scheme === APP_SCHEME) {
    // ferminuxwallet://wc?… parses with host "wc"; ferminuxwallet:///wc?… or ferminuxwallet:wc?… with a path.
    const target = (url.host || url.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase();
    if (target !== 'wc' && target !== '') return null;
    ours = true;
  } else if (scheme === 'https' || scheme === 'http') {
    const host = url.host.toLowerCase();
    const known = APP_LINK_HOSTS.includes(host) && scheme === 'https';
    if (!known && !extraHosts.map((h) => h.toLowerCase()).includes(host)) return null;
    if (!isWalletPath(url.pathname)) return null;
    ours = true;
  }
  if (!ours) return null;

  const uri = url.searchParams.get('uri');
  if (uri) return classifyWc(unwrap(uri));
  const requestId = url.searchParams.get('requestId');
  const sessionTopic = url.searchParams.get('sessionTopic');
  if (requestId || sessionTopic) return { kind: 'wc-request', requestId, sessionTopic };
  return { kind: 'open' };
}

/**
 * The same link can reach the app twice (the launch intent, then the
 * appUrlOpen event on some Android versions). Remember what was handled for a
 * short while and drop repeats.
 */
export function createDeduper(windowMs = 5_000, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (link: DeepLink): boolean => {
    const key = link.kind === 'wc-pair' ? link.uri : link.kind === 'wc-request' ? `req:${link.requestId}:${link.sessionTopic}` : 'open';
    const t = now();
    for (const [k, at] of seen) if (t - at > windowMs) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, t);
    return true;
  };
}
