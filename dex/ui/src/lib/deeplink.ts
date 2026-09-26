// ---------------------------------------------------------------------------
// Deep links: open the app on a given tab with a given pair selected.
//
//   https://dex.ferminux.net/?inputCurrency=<address|symbol>&outputCurrency=<address|symbol>&tab=swap
//
// The parameter names are the ones every V2-style DEX front end uses, so a link
// written for one works here. ferminux.net and ferminux.com link "Swap on
// Ferminux DEX" with the pool's stablecoin in and FMX out.
//
// A link is somebody else's text, so it can only SELECT what the app already
// lists — never import a token. An address resolves only to a token the list
// already holds (a pool token, a first-party token, or one this browser
// imported itself); a symbol resolves only to FMX, WFMX or a first-party token,
// because a symbol is free for anyone to copy and a link saying "USDF" must
// never land on an impostor that happens to share the name.
//
// No browser globals — imported unchanged by the unit tests.
// ---------------------------------------------------------------------------

import { isWrapPair, sameToken, type TokenInfo } from './tokens.ts';

export type LinkTab = 'swap' | 'liquidity' | 'pools';

export interface DexLink {
  input: string | null;
  output: string | null;
  tab: LinkTab | null;
}

const TABS: readonly LinkTab[] = ['swap', 'liquidity', 'pools'];
/** What a link may call the native coin, besides its own symbol. */
const NATIVE_ALIASES = new Set(['fmx', 'native']);

/** Read the link out of a query string (`location.search`, with or without the leading "?"). */
export function parseDexLink(search: string): DexLink {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const v = params.get(n)?.trim();
      if (v) return v.slice(0, 64);
    }
    return null;
  };
  const tab = pick('tab')?.toLowerCase() ?? null;
  return {
    input: pick('inputCurrency', 'in'),
    output: pick('outputCurrency', 'out'),
    tab: tab && (TABS as readonly string[]).includes(tab) ? (tab as LinkTab) : null,
  };
}

/**
 * One link value → a token the app already lists, or null.
 * `trusted` says whether a token may be selected by SYMBOL (FMX, WFMX and the
 * first-party registry); addresses match any listed ERC-20.
 */
export function resolveLinkToken(
  value: string | null,
  tokens: TokenInfo[],
  trusted: (token: TokenInfo) => boolean,
): TokenInfo | null {
  if (!value) return null;
  const v = value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
    // An address names the ERC-20 at that address — WFMX, not native FMX, for the wrapper's own address.
    return tokens.find((t) => t.kind === 'erc20' && t.address.toLowerCase() === v.toLowerCase()) ?? null;
  }
  const lower = v.toLowerCase();
  if (NATIVE_ALIASES.has(lower)) return tokens.find((t) => t.kind === 'native') ?? null;
  return tokens.find((t) => t.kind === 'erc20' && t.symbol.toLowerCase() === lower && trusted(t)) ?? null;
}

/**
 * The pair a link asks for, with the side it leaves out filled in: the other
 * side of an FMX pair is FMX's counterpart (`counterpart`), and the other side
 * of anything else is FMX. Returns null when the link names nothing usable; a
 * link naming the same token twice keeps only the input. A side that cannot be
 * filled comes back null for the caller's own default.
 */
export function linkedPair(
  link: DexLink,
  tokens: TokenInfo[],
  trusted: (token: TokenInfo) => boolean,
  counterpart: (native: TokenInfo) => TokenInfo | null,
): { tokenIn: TokenInfo | null; tokenOut: TokenInfo | null } | null {
  const native = tokens.find((t) => t.kind === 'native') ?? null;
  const a = resolveLinkToken(link.input, tokens, trusted);
  let b = resolveLinkToken(link.output, tokens, trusted);
  if (a && b && sameToken(a, b)) b = null;
  if (!a && !b) return null;
  if (a && b) return { tokenIn: a, tokenOut: b };
  const fill = (given: TokenInfo): TokenInfo | null => {
    if (given.kind === 'native') return counterpart(given);
    // WFMX → FMX would be an unwrap, not a trade: give it FMX's counterpart instead
    if (native && isWrapPair(native, given)) return counterpart(native);
    return native;
  };
  if (a) return { tokenIn: a, tokenOut: fill(a) };
  return { tokenIn: fill(b!), tokenOut: b };
}
