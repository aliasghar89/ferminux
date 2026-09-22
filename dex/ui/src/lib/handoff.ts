// Phone hand-off: getting the current page open inside a wallet app's
// built-in browser, where window.ethereum exists natively.
//
// Why a deep link and not WalletConnect: WalletConnect relays every session
// through servers this project does not control and needs a registered project
// id — both against the self-hosted rule the stack is built on (check-dist
// fails the build on any external URL that could be fetched). The MetaMask
// deep link is a plain https URL shown to the user as a QR or a tap target;
// this page never fetches it. The user's phone follows it, MetaMask opens the
// page in its own browser, and from there the normal injected-provider flow
// takes over.
//
// Pure module: no browser globals. The environment (user agent, provider
// presence) is passed in, so the same code runs in the UI and in the Node
// unit tests.
//
// SHARED FILE — src/lib/handoff.ts is byte-identical in dex/ui and
// wallet-web. If you change one copy, change the other; tests/handoff.test.mjs
// checks they have not drifted.

export const METAMASK_DEEPLINK_BASE = 'https://metamask.app.link/dapp/';

/**
 * The MetaMask Mobile deep link for a page: scanning or tapping it opens the
 * page inside MetaMask's built-in dapp browser. Only http(s) pages can be
 * expressed; anything else returns null and the caller falls back to showing
 * the plain URL.
 */
export function buildMetaMaskDeepLink(pageHref: string): string | null {
  let url: URL;
  try {
    url = new URL(pageHref);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // host (with port), path and query survive; hash and credentials do not.
  return `${METAMASK_DEEPLINK_BASE}${url.host}${url.pathname}${url.search}`;
}

/**
 * Phone or tablet? Decides QR (desktop: scan with the phone's camera) versus
 * tap target (a phone cannot scan its own screen).
 */
export function isMobileUserAgent(userAgent: string, maxTouchPoints = 0): boolean {
  if (/android|iphone|ipad|ipod|windows phone|mobile/i.test(userAgent)) return true;
  // iPadOS 13+ reports a desktop Mac UA; the touch screen gives it away.
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export type HandoffEnvironment =
  /** An injected provider exists (wallet in-app browser, or a desktop extension): connect normally, no hand-off. */
  | 'wallet'
  /** Mobile browser without a provider: offer the deep link as a tap target. */
  | 'phone'
  /** Desktop browser without a provider: offer the deep link as a QR to scan. */
  | 'desktop';

export function classifyHandoff(opts: {
  hasInjected: boolean;
  userAgent: string;
  maxTouchPoints?: number;
}): HandoffEnvironment {
  if (opts.hasInjected) return 'wallet';
  return isMobileUserAgent(opts.userAgent, opts.maxTouchPoints ?? 0) ? 'phone' : 'desktop';
}
