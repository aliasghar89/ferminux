// The Ferminux token registry — one tracked list, consumed by every surface.
//
// WHY THIS EXISTS. The same tokens were declared in four places: the wallet's
// DEFAULT_TOKENS, the DEX's PRELOADED_TOKENS, the DEX's CANONICAL_TOKENS, and
// the published site/assets/brand/tokenlist.json. They had already drifted —
// USDF was deployed with 500,000 supply and listed in three of the four, but
// NOT in the wallet, so anyone holding it saw nothing and had to add it by
// address to know it was there. Nothing was broken enough to fail; it was just
// wrong in one place.
//
// Adding a token to a chain is one fact. It belongs in one file. Listing wBNB
// after the bridge's BNB route is registered should be one entry here, not four
// edits that can each be forgotten independently.
//
// This module must stay importable under plain Node — no browser globals, no
// import.meta — so every app's test suite can read it directly and the
// tokenlist.json generator can run without a bundler.

export interface TokenEntry {
  /** Contract address on Ferminux (chain 3961), EIP-55 checksummed. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Filename under site/assets/brand/, served from https://ferminux.net. */
  logo: string;
  /**
   * Deployed by Ferminux and administered by the project multisig.
   *
   * This is a CLAIM THE PROJECT MAKES, not a description. The DEX shows it as a
   * first-party badge, so every true here says "we stand behind how this token
   * behaves". Bridged assets are first-party in the same sense: the wrapper is
   * our contract and the bridge is our deployment.
   */
  firstParty: boolean;
  /**
   * Present when the token is an IOU for an asset that is canonical on another
   * chain. Its value is the promise that collateral on that chain is still
   * there and still releasable — worth surfacing, not hiding.
   */
  bridgedFrom?: { chainId: number; chainName: string; asset: string };
  /** Offer it in selectors before any pool has been read. */
  preload: boolean;
}

/**
 * Tokens on Ferminux (chain 3961).
 *
 * WFMX is the WETH-style wrapper for the native coin that the DEX pairs
 * against — NOT the bridge's wFMX on BSC, which is a different contract with
 * the same name. Keeping both straight matters: one is a wrapper for pooling,
 * the other is an IOU on a foreign chain.
 */
export const FERMINUX_CHAIN_ID = 3961;

export const TOKENS: TokenEntry[] = [
  {
    address: '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae',
    symbol: 'WFMX',
    name: 'Wrapped FMX',
    decimals: 18,
    logo: 'fmx-round.svg',
    firstParty: true,
    // The DEX adds this at runtime from its own router config too; listed here
    // so the wallet and the published list agree that it exists.
    preload: false,
  },
  {
    address: '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178',
    symbol: 'AZNT',
    name: 'Ferminux Manat',
    decimals: 6,
    logo: 'aznt-round.svg',
    firstParty: true,
    preload: true,
  },
  {
    address: '0xCd032A609e34121D1881E8DE7355b2c2c7092363',
    symbol: 'USDF',
    name: 'Ferminux Dollar',
    decimals: 6,
    logo: 'usdf-round.svg',
    firstParty: true,
    preload: true,
  },
  // ---------------------------------------------------------------------
  // wBNB goes here once the bridge's BNB route is registered.
  //
  // It is NOT listed yet because the address does not exist. The route is
  // registered on the NEW bridge pair as part of the wFMX migration — route
  // registration is once-only with no unregister, so standing it up on the
  // current pair would mean abandoning it with those bridges and deploying a
  // third time. See bridge/contracts/script/wfmx-migration-e2e.sh step 7,
  // which proves the whole route end to end.
  //
  //   {
  //     address: '0x…',            // the BridgeToken wrapper on Ferminux
  //     symbol: 'wBNB', name: 'Wrapped BNB', decimals: 18,
  //     logo: 'bnb-round.svg', firstParty: true, preload: true,
  //     bridgedFrom: { chainId: 56, chainName: 'BNB Smart Chain', asset: 'BNB' },
  //   },
  // ---------------------------------------------------------------------
];

/** Addresses the project vouches for, lowercased for case-insensitive lookup. */
export const FIRST_PARTY_ADDRESSES: readonly string[] = TOKENS.filter((t) => t.firstParty).map((t) =>
  t.address.toLowerCase(),
);

export function isFirstParty(address: string | undefined | null): boolean {
  return !!address && FIRST_PARTY_ADDRESSES.includes(address.toLowerCase());
}

/** Tokens a selector should offer before any pool has been read. */
export function preloadTokens(): TokenEntry[] {
  return TOKENS.filter((t) => t.preload);
}

/**
 * Tokens the wallet shows out of the box — all of them.
 *
 * WFMX is included even though it is a DEX artifact most users never hold
 * deliberately: a wrap that is never unwrapped leaves a real balance, and a
 * wallet that does not show it recreates the exact problem this file was
 * written for. Clutter is cheaper than invisible funds.
 */
export function walletTokens(): TokenEntry[] {
  return TOKENS;
}

export function logoUrl(t: TokenEntry, origin = 'https://ferminux.net'): string {
  return `${origin}/assets/brand/${t.logo}`;
}

export function bySymbol(symbol: string): TokenEntry | undefined {
  return TOKENS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}
