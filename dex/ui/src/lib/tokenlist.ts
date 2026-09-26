// ---------------------------------------------------------------------------
// The token list the picker starts from: the repo's registry (shared/tokens.ts,
// the same source site/assets/brand/tokenlist.json is generated from), plus
// native FMX. Pool tokens and tokens the user imported by address are merged
// in by the app; those carry no first-party claim.
//
// Logos: the registry names one SVG per token (site/assets/brand/*-round.svg).
// The app bundles byte-identical copies under src/assets/tokens/ so it fetches
// nothing from another host; tests/tokenlist.test.mjs fails if they drift.
//
// No browser globals.
// ---------------------------------------------------------------------------

import { TOKENS, isFirstParty } from '../../../../shared/tokens.ts';
import { toChecksum } from './amounts.ts';
import { nativeToken, tokenKey, wfmxToken, type TokenInfo } from './tokens.ts';

/** Logo keys the app bundles (components/TokenLogo.tsx maps them to files). */
export type LogoKey = 'fmx' | 'aznt' | 'usdf';

const LOGO_BY_FILE: Record<string, LogoKey> = {
  'fmx-round.svg': 'fmx',
  'aznt-round.svg': 'aznt',
  'usdf-round.svg': 'usdf',
};

/** The registry file each bundled logo copies, for the drift test. */
export const BUNDLED_LOGOS: Record<LogoKey, string> = { fmx: 'fmx-round.svg', aznt: 'aznt-round.svg', usdf: 'usdf-round.svg' };

/** Which bundled logo a token shows; null draws a monogram. Native FMX and WFMX share the FMX coin. */
export function logoFor(token: Pick<TokenInfo, 'kind' | 'address'>, wfmx: string): LogoKey | null {
  if (token.kind === 'native' || token.address.toLowerCase() === wfmx.toLowerCase()) return 'fmx';
  const entry = TOKENS.find((t) => t.address.toLowerCase() === token.address.toLowerCase());
  return entry ? (LOGO_BY_FILE[entry.logo] ?? null) : null;
}

/** First-party: FMX itself, or a registry token the project stands behind. */
export function isListed(token: Pick<TokenInfo, 'kind' | 'address'>): boolean {
  return token.kind === 'native' || isFirstParty(token.address);
}

/**
 * FMX, WFMX, then every registry token that is on offer before any pool is
 * read, in registry order. These head the picker as the common bases.
 */
export function listedTokens(wfmx: string): TokenInfo[] {
  const out: TokenInfo[] = [nativeToken(wfmx), wfmxToken(wfmx)];
  for (const t of TOKENS) {
    if (t.address.toLowerCase() === wfmx.toLowerCase()) continue;
    out.push({ kind: 'erc20', address: toChecksum(t.address), symbol: t.symbol, name: t.name, decimals: t.decimals });
  }
  return out;
}

/**
 * Picker order: listed tokens first (FMX, then by the user's balance, then
 * the registry's order), then everything else by balance, then symbol.
 */
export function sortForPicker(tokens: TokenInfo[], balances: Map<string, bigint>, wfmx: string): TokenInfo[] {
  const listedOrder = new Map(listedTokens(wfmx).map((t, i) => [tokenKey(t), i]));
  const has = (t: TokenInfo) => (balances.get(tokenKey(t)) ?? 0n) > 0n;
  return [...tokens].sort((a, b) => {
    const la = listedOrder.has(tokenKey(a));
    const lb = listedOrder.has(tokenKey(b));
    if (la !== lb) return la ? -1 : 1;
    if (a.kind === 'native' || b.kind === 'native') return a.kind === 'native' ? -1 : 1;
    if (has(a) !== has(b)) return has(a) ? -1 : 1;
    if (la && lb) return listedOrder.get(tokenKey(a))! - listedOrder.get(tokenKey(b))!;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** Case-insensitive search over symbol, name and address. An exact symbol match ranks first. */
export function searchTokens(tokens: TokenInfo[], query: string): TokenInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return tokens;
  const hits = tokens.filter(
    (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase() === q || (q.length >= 6 && t.address.toLowerCase().includes(q)),
  );
  return hits.sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q));
}
