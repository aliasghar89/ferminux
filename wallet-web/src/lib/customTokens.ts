// Tokens the user added by contract address, on any supported chain.
// Pure: parsing, validation and list edits. Storage lives in state/storage.ts.
//
// Only public data is stored: chain id, contract address and the metadata the
// contract itself reported (symbol, name, decimals).

import { getAddress } from 'ethers';
import { chainById } from './chains.ts';
import type { CustomToken } from './portfolio.ts';
import { INVISIBLE_RE } from './text.ts';

export const CUSTOM_TOKENS_KEY = 'ferminux.wallet.tokens.v2';
/** The single-chain list the wallet stored before it was multi-chain: bare 3961 addresses. */
export const LEGACY_TOKENS_KEY = 'ferminux.wallet.tokens.v1';
export const MAX_CUSTOM_TOKENS = 100;

const SYMBOL_MAX = 16;
const NAME_MAX = 48;

/** Token metadata is attacker-controlled text: strip controls/bidi marks and cap the length. */
export function cleanTokenText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Whitespace controls separate words; every other invisible is deleted, so
  // "US<RLO>DC" cannot render as a lookalike.
  const cleaned = raw
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/** Validate one stored/fetched record; null if it is not usable. */
export function normalizeCustomToken(raw: unknown): CustomToken | null {
  const r = raw as Partial<CustomToken> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.chainId !== 'number' || !chainById(r.chainId)) return null;
  if (typeof r.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) return null;
  const decimals = Number(r.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const symbol = cleanTokenText(r.symbol, SYMBOL_MAX);
  if (symbol === '') return null;
  let address: string;
  try {
    address = getAddress(r.address.toLowerCase());
  } catch {
    return null;
  }
  return { chainId: r.chainId, address, symbol, name: cleanTokenText(r.name, NAME_MAX) || symbol, decimals };
}

export function parseCustomTokens(raw: string | null): CustomToken[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CustomToken[] = [];
  for (const item of parsed) {
    const t = normalizeCustomToken(item);
    if (t && !out.some((o) => sameToken(o, t))) out.push(t);
  }
  return out.slice(0, MAX_CUSTOM_TOKENS);
}

export function serializeCustomTokens(tokens: CustomToken[]): string {
  return JSON.stringify(tokens.map(({ chainId, address, symbol, name, decimals }) => ({ chainId, address, symbol, name, decimals })));
}

export function sameToken(a: { chainId: number; address: string }, b: { chainId: number; address: string }): boolean {
  return a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase();
}

/** True when the chain already lists this contract out of the box. */
export function isListedToken(chainId: number, address: string): boolean {
  const chain = chainById(chainId);
  return !!chain && chain.tokens.some((t) => t.address.toLowerCase() === address.toLowerCase());
}

export type AddCheck = { ok: true; tokens: CustomToken[] } | { ok: false; error: string };

export function withCustomToken(tokens: CustomToken[], token: CustomToken): AddCheck {
  const t = normalizeCustomToken(token);
  if (!t) return { ok: false, error: 'That token reported metadata this wallet cannot use.' };
  if (isListedToken(t.chainId, t.address)) return { ok: false, error: 'This token is already listed on that network.' };
  if (tokens.some((o) => sameToken(o, t))) return { ok: false, error: 'This token is already in your list.' };
  if (tokens.length >= MAX_CUSTOM_TOKENS) return { ok: false, error: `You can add up to ${MAX_CUSTOM_TOKENS} tokens.` };
  return { ok: true, tokens: [...tokens, t] };
}

export function withoutCustomToken(tokens: CustomToken[], chainId: number, address: string): CustomToken[] {
  return tokens.filter((t) => !sameToken(t, { chainId, address }));
}

/**
 * The v1 list held bare Ferminux addresses (listed tokens included). The ones
 * that are not listed still need their metadata read from chain before they
 * can become v2 records; this returns just those addresses.
 */
export function legacyAddressesToResolve(legacyRaw: string | null, homeChainId: number, current: CustomToken[]): string[] {
  if (!legacyRaw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacyRaw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const a of parsed) {
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
    if (isListedToken(homeChainId, a)) continue;
    if (current.some((t) => sameToken(t, { chainId: homeChainId, address: a }))) continue;
    if (out.some((o) => o.toLowerCase() === a.toLowerCase())) continue;
    out.push(getAddress(a.toLowerCase()));
  }
  return out;
}
