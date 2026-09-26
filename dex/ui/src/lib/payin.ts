// ---------------------------------------------------------------------------
// Pay with any coin: buy FMX with USDC, USDT or a network's own coin on seven
// other networks, through the project's pay-in (agents/gateway/src/v3/payin.ts,
// served at ferminux.net/api/payin, the same service ferminux.net/buy-fmx uses).
//
// The DEX's pools only hold FMX, USDF and AZNT on chain 3961, so "swap USDT for
// FMX" is not a pool trade: it is a quote from the pay-in, a transfer of EXACTLY
// the quoted amount to the pay-in's deposit address on the paying network, and
// FMX sent by the pay-in to the quote's recipient on Ferminux once that
// network has confirmed the transfer. One way only: nothing here sells FMX.
//
// THE ONE RULE: a deposit is matched to its quote by its exact amount (and by
// the sender the quote names). A payment of any other amount, or from any other
// address, matches no quote and lands in the deposit wallet unattributed. So
// the wallet is only ever asked to send `sendExactly` from `from`, never the
// amount that was typed, never a rounded figure, never twice for one quote.
//
// Everything the wallet is asked to sign is checked here first against values
// pinned in this file (chain ids, token contracts, decimals) and in config.ts
// (the deposit address): a quote that names anything else is refused, whatever
// the API says. A drift test (tests/payin.test.mjs) reads the gateway's own
// table and fails if the two disagree.
//
// No browser globals: fetch is passed in (defaulting to the global one), so the
// unit tests drive every function here without a browser.
// ---------------------------------------------------------------------------

import { Interface, formatUnits, getAddress } from 'ethers';
import { CHAIN_RPC_URLS } from '../../../../shared/fxwallet/chains.ts';
import { PAYIN_DEPOSIT_ADDRESS } from '../config.ts';

export type PayChainKey = 'eth' | 'bsc' | 'base' | 'arbitrum' | 'polygon' | 'optimism' | 'avalanche';
export type PayAssetSymbol = 'USDC' | 'USDT' | 'ETH' | 'BNB' | 'POL' | 'AVAX';

export interface PayAsset {
  symbol: PayAssetSymbol;
  name: string;
  /** 'erc20' is a token contract; 'native' is the network's own coin. Named as the pay-in API names them. */
  kind: 'erc20' | 'native';
  /** Checksummed contract, null for the native coin. */
  token: string | null;
  decimals: number;
  /** Counted as 1 USD by the pay-in. */
  stable: boolean;
}

export interface PayChain {
  key: PayChainKey;
  chainId: number;
  chainIdHex: string;
  name: string;
  /** The tag shown beside an asset (the Ferminux Wallet's short names). */
  short: string;
  explorer: string;
  /** Confirmations the pay-in waits for before it sends FMX. */
  confirmations: number;
  native: { symbol: PayAssetSymbol; name: string; decimals: number };
  /** USDT, USDC, then the native coin. */
  assets: PayAsset[];
  /** Public read endpoints, in order (shared/fxwallet/chains.ts). */
  rpcUrls: readonly string[];
}

export interface PaySelection {
  chain: PayChainKey;
  asset: PayAssetSymbol;
}

const stable = (symbol: 'USDC' | 'USDT', token: string, decimals: number): PayAsset => ({
  symbol,
  name: symbol === 'USDC' ? 'USD Coin' : 'Tether USD',
  kind: 'erc20',
  token,
  decimals,
  stable: true,
});
const nativeAsset = (symbol: PayAssetSymbol, name: string): PayAsset => ({ symbol, name, kind: 'native', token: null, decimals: 18, stable: false });

function chain(
  key: PayChainKey,
  chainId: number,
  name: string,
  short: string,
  explorer: string,
  confirmations: number,
  nativeSym: PayAssetSymbol,
  nativeName: string,
  usdt: [string, number],
  usdc: [string, number],
): PayChain {
  return {
    key,
    chainId,
    chainIdHex: '0x' + chainId.toString(16),
    name,
    short,
    explorer,
    confirmations,
    native: { symbol: nativeSym, name: nativeName, decimals: 18 },
    assets: [stable('USDT', usdt[0], usdt[1]), stable('USDC', usdc[0], usdc[1]), nativeAsset(nativeSym, nativeName)],
    rpcUrls: CHAIN_RPC_URLS[chainId] ?? [],
  };
}

/**
 * The seven networks the pay-in takes, with the contracts it watches: the
 * gateway's PAYIN_CHAINS, restated (tests/payin.test.mjs keeps them equal).
 * Cheapest transfers first; Ethereum last. BNB Smart Chain's USDT and USDC
 * have 18 decimals, everywhere else 6.
 */
export const PAY_CHAINS: readonly PayChain[] = [
  chain('bsc', 56, 'BNB Smart Chain', 'BSC', 'https://bscscan.com', 12, 'BNB', 'BNB',
    ['0x55d398326f99059fF775485246999027B3197955', 18], ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18]),
  chain('base', 8453, 'Base', 'BASE', 'https://basescan.org', 20, 'ETH', 'Ether',
    ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6], ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6]),
  chain('arbitrum', 42161, 'Arbitrum One', 'ARB', 'https://arbiscan.io', 20, 'ETH', 'Ether',
    ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6], ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6]),
  chain('polygon', 137, 'Polygon', 'POL', 'https://polygonscan.com', 60, 'POL', 'POL',
    ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6], ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6]),
  chain('optimism', 10, 'Optimism', 'OP', 'https://optimistic.etherscan.io', 20, 'ETH', 'Ether',
    ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6], ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6]),
  chain('avalanche', 43114, 'Avalanche C-Chain', 'AVAX', 'https://snowtrace.io', 6, 'AVAX', 'Avalanche',
    ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6], ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6]),
  chain('eth', 1, 'Ethereum', 'ETH', 'https://etherscan.io', 6, 'ETH', 'Ether',
    ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 6], ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6]),
];

export function payChain(key: string): PayChain | null {
  return PAY_CHAINS.find((c) => c.key === key) ?? null;
}

export function payAsset(chainKey: string, symbol: string): PayAsset | null {
  return payChain(chainKey)?.assets.find((a) => a.symbol === symbol) ?? null;
}

export function isPaySelection(v: unknown): v is PaySelection {
  const s = v as PaySelection | null;
  return !!s && typeof s === 'object' && payAsset(String(s.chain), String(s.asset)) !== null;
}

/** Defaults the pay-in publishes; /api/payin/assets overrides them when it answers. */
export const PAYIN_DEFAULTS = { spreadBps: 200, minUsd: 1, maxUsd: 10_000, expiresS: 900 } as const;

/** A send is refused with less than this left on the quote. */
export const MIN_SECONDS_TO_SEND = 60;

/** Most units a quote may differ from what was typed (the pay-in steps down one unit per open duplicate). */
export const MAX_DUST_UNITS = 10_000n;

const E18 = 10n ** 18n;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isTxHash(v: unknown): v is string {
  return typeof v === 'string' && HASH_RE.test(v);
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && ADDRESS_RE.test(a) && ADDRESS_RE.test(b) && a.toLowerCase() === b.toLowerCase();
}

/** The pinned deposit address, or null when this build has none that parses. */
export function depositAddress(): string | null {
  return ADDRESS_RE.test(PAYIN_DEPOSIT_ADDRESS) ? getAddress(PAYIN_DEPOSIT_ADDRESS) : null;
}

/** Explorer link on the paying network, for a hash that is one. */
export function payTxUrl(chainKey: PayChainKey, hash: string): string | null {
  const c = payChain(chainKey);
  return c && isTxHash(hash) ? `${c.explorer}/tx/${hash}` : null;
}

export function payAddressUrl(chainKey: PayChainKey, address: string): string | null {
  const c = payChain(chainKey);
  return c && ADDRESS_RE.test(address) ? `${c.explorer}/address/${address}` : null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** "0.52" → 0.52e18. Up to 18 decimals; anything else is null. */
export function parseDecimalE18(v: unknown): bigint | null {
  return parseDecimalUnits(v, 18);
}

/** A decimal string as exact units at `decimals`; null when it does not fit. */
export function parseDecimalUnits(v: unknown, decimals: number): bigint | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,40})(?:\.(\d{1,78}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + (frac ? BigInt(frac.padEnd(decimals, '0')) : 0n);
}

function uint(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) return null;
  return BigInt(v);
}

/** USD (1e18) of `units` of an asset worth `assetUsdE18` per whole coin: the gateway's usdValueE18. */
export function usdValueE18(units: bigint, decimals: number, assetUsdE18: bigint): bigint {
  return (units * assetUsdE18) / 10n ** BigInt(decimals);
}

/** FMX (wei) for a USD value: usd × (1 − spread) / price. The gateway's fmxOutFor, to the wei. */
export function fmxOutFor(usdE18: bigint, priceE18: bigint, spreadBps: number): bigint {
  if (priceE18 <= 0n) throw new Error('bad FMX price');
  return (usdE18 * E18 * (10_000n - BigInt(spreadBps))) / (10_000n * priceE18);
}

/** What one FMX costs all in, the spread included: price / (1 − spread). */
export function allInPriceE18(priceE18: bigint, spreadBps: number): bigint {
  return (priceE18 * 10_000n) / (10_000n - BigInt(spreadBps));
}

export type AmountCheck = { ok: true; units: bigint; text: string } | { ok: false; error: string };

/**
 * A typed amount as exact units of `asset`, and the canonical decimal string
 * the quote route is sent. Stablecoins count 1 USD each, so their USD bounds
 * are checked here; a native coin's are checked by the quote, at its live price.
 */
export function checkPayAmount(input: string, asset: PayAsset, limits: { minUsd: number; maxUsd: number } = PAYIN_DEFAULTS): AmountCheck {
  const raw = input.trim().replace(/,/g, '');
  if (raw === '') return { ok: false, error: 'Enter an amount.' };
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { ok: false, error: 'Numbers only (use . for decimals).' };
  const [whole = '', fraction = ''] = raw.split('.');
  if (fraction.length > asset.decimals) {
    return { ok: false, error: `${asset.symbol} here has ${asset.decimals} decimals: that is more precision than it can hold.` };
  }
  if (whole.replace(/^0+/, '').length > 15) return { ok: false, error: 'That amount is too large.' };
  const units = parseDecimalUnits((whole === '' ? '0' : whole) + (fraction ? '.' + fraction : ''), asset.decimals);
  if (units === null || units <= 0n) return { ok: false, error: 'Amount must be greater than zero.' };
  if (asset.stable) {
    const one = 10n ** BigInt(asset.decimals);
    const min = (BigInt(Math.round(limits.minUsd * 1e6)) * one) / 1_000_000n;
    const max = (BigInt(Math.round(limits.maxUsd * 1e6)) * one) / 1_000_000n;
    if (units < min) return { ok: false, error: `The pay-in takes at least $${limits.minUsd.toLocaleString('en-US')} per quote.` };
    if (units > max) return { ok: false, error: `The pay-in takes at most $${limits.maxUsd.toLocaleString('en-US')} per quote.` };
  }
  return { ok: true, units, text: formatUnits(units, asset.decimals) };
}

/** FMX a stablecoin amount buys before any quote is asked for (the quote has the last word). */
export function estimateFmxOut(units: bigint, asset: PayAsset, priceE18: bigint | null, spreadBps: number): bigint | null {
  if (!asset.stable || priceE18 === null || priceE18 <= 0n || units <= 0n) return null;
  return fmxOutFor(usdValueE18(units, asset.decimals, E18), priceE18, spreadBps);
}

// ---------------------------------------------------------------------------
// GET /api/payin/assets
// ---------------------------------------------------------------------------

export interface PayChainState {
  /** Takes quotes now: the pay-in is on, its scanner for this network is current, and it matches this app's table. */
  available: boolean;
  reason: string | null;
  confirmations: number;
}

export interface PayAssetsInfo {
  enabled: boolean;
  /** The operator's FMX price, when the pay-in publishes one. */
  priceE18: bigint | null;
  spreadBps: number;
  minUsd: number;
  maxUsd: number;
  expiresS: number;
  chains: Record<PayChainKey, PayChainState>;
}

/**
 * Read the asset list. A network is offered only when the pay-in says it is
 * available AND it lists the same deposit address, token contracts and
 * decimals this app has pinned: any difference fails closed for that network.
 */
export function parseAssetsResponse(json: unknown): PayAssetsInfo {
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.enabled !== 'boolean' || !Array.isArray(o.chains)) {
    throw new Error('The pay-in answered with something that is not its asset list.');
  }
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);
  const spreadBps = num(o.spreadBps, 0, 1000, PAYIN_DEFAULTS.spreadBps);
  const deposit = depositAddress();
  const chains = {} as Record<PayChainKey, PayChainState>;
  for (const pinned of PAY_CHAINS) {
    const entry = (o.chains as Array<Record<string, unknown>>).find((c) => c && c.chain === pinned.key);
    let reason: string | null = null;
    if (!o.enabled) reason = 'the pay-in is offline';
    else if (!entry) reason = 'not listed by the pay-in';
    else if (entry.chainId !== pinned.chainId) reason = 'the pay-in lists a different chain id';
    else if (!deposit || !sameAddress(String(entry.depositAddress ?? ''), deposit)) reason = 'the pay-in lists a deposit address this app does not know';
    else {
      const listed = Array.isArray(entry.assets) ? (entry.assets as Array<Record<string, unknown>>) : [];
      for (const a of pinned.assets) {
        const l = listed.find((x) => x && x.symbol === a.symbol);
        const tokenOk = a.kind === 'native' ? l?.token === null || l?.token === undefined : sameAddress(String(l?.token ?? ''), a.token);
        if (!l || l.kind !== a.kind || l.decimals !== a.decimals || !tokenOk) {
          reason = `the pay-in lists ${a.symbol} differently from this app`;
          break;
        }
      }
      if (!reason && entry.available === false) {
        reason = typeof entry.unavailableReason === 'string' && entry.unavailableReason.trim()
          ? entry.unavailableReason.trim().slice(0, 200)
          : 'its deposit scanner is not current';
      }
    }
    const conf = entry && typeof entry.confirmations === 'number' && entry.confirmations > 0 && entry.confirmations <= 1000 ? entry.confirmations : pinned.confirmations;
    chains[pinned.key] = { available: reason === null, reason, confirmations: conf };
  }
  const price = parseDecimalE18(o.priceUsdPerFmx);
  return {
    enabled: o.enabled,
    priceE18: price !== null && price > 0n ? price : null,
    spreadBps,
    minUsd: num(o.minUsd, 0, 1e9, PAYIN_DEFAULTS.minUsd),
    maxUsd: num(o.maxUsd, 0, 1e9, PAYIN_DEFAULTS.maxUsd),
    expiresS: num(o.expires, 60, 3600, PAYIN_DEFAULTS.expiresS),
    chains,
  };
}

// ---------------------------------------------------------------------------
// POST /api/payin/quote
// ---------------------------------------------------------------------------

export interface PayQuoteRequest {
  chain: PayChainKey;
  asset: PayAssetSymbol;
  /** Exact units asked for: what was typed, or a few units under it (see distinctFrom). */
  units: bigint;
  /** What was typed, when `units` was moved off it. */
  typedUnits?: bigint;
  /** FMX recipient on Ferminux. */
  to: string;
  /** The wallet that will pay: the only sender the pay-in will match to this quote. */
  from: string;
}

export function quoteRequestBody(req: PayQuoteRequest): { chain: string; asset: string; amount: string; to: string; from: string } {
  const a = payAsset(req.chain, req.asset);
  if (!a) throw new Error(`${req.asset} on ${req.chain} is not offered.`);
  if (req.units <= 0n) throw new Error('Enter an amount.');
  return { chain: req.chain, asset: req.asset, amount: formatUnits(req.units, a.decimals), to: getAddress(req.to), from: getAddress(req.from) };
}

export interface PayQuote {
  quoteId: string;
  chain: PayChainKey;
  chainId: number;
  asset: PayAssetSymbol;
  kind: 'erc20' | 'native';
  /** Checksummed contract (null for a native coin): always the pinned one. */
  token: string | null;
  decimals: number;
  /** The one amount the wallet may send, in units. */
  sendExactly: bigint;
  /** What was typed. */
  requested: bigint;
  depositAddress: string;
  fmxOut: bigint;
  priceE18: bigint;
  spreadBps: number;
  usdE18: bigint;
  assetUsdE18: bigint;
  /** FMX recipient on Ferminux. */
  to: string;
  /** The paying wallet. */
  from: string;
  confirmations: number;
  expiresS: number;
  /** Server clock, unix seconds (shown only; the local deadline decides). */
  expiresAt: number;
  /** Local clock: when the request left + the quote's lifetime, so a skewed clock can only make it earlier. */
  deadlineMs: number;
}

export type QuoteCheck = { ok: true; quote: PayQuote } | { ok: false; error: string };

export interface QuoteContext {
  /** Date.now() just before the request was sent. */
  requestedAtMs: number;
  /** The published FMX price from /assets, when known: a quote at any other price is refused. */
  priceE18: bigint | null;
  spreadBps: number;
  minUsd: number;
  maxUsd: number;
}

/**
 * Accept a quote only when every figure the wallet will act on is the one this
 * app expects: the network and its chain id, the pinned token contract and
 * decimals, the pinned deposit address, the recipient and sender that were
 * asked for, an amount within a few units of the one typed, and an FMX figure
 * that recomputes to the wei from the quote's own USD value, price and spread.
 */
export function validateQuote(raw: unknown, req: PayQuoteRequest, ctx: QuoteContext): QuoteCheck {
  const bad = (why: string): QuoteCheck => ({ ok: false, error: `The pay-in's quote was refused: ${why}. Nothing was sent.` });
  const q = raw as Record<string, unknown> | null;
  if (!q || typeof q !== 'object') return bad('it is not a quote');
  const pinnedChain = payChain(req.chain);
  const pinned = payAsset(req.chain, req.asset);
  if (!pinnedChain || !pinned) return bad('that network or coin is not offered');
  const quoteId = q.quoteId;
  if (typeof quoteId !== 'string' || !/^q_[A-Za-z0-9]{6,64}$/.test(quoteId)) return bad('it has no usable quote id');
  if (q.chain !== req.chain || q.chainId !== pinnedChain.chainId) return bad(`it is for another network than ${pinnedChain.name}`);
  if (q.asset !== req.asset || q.assetKind !== pinned.kind) return bad(`it is for another coin than ${pinned.symbol}`);
  if (pinned.kind === 'erc20' ? !sameAddress(String(q.token ?? ''), pinned.token) : q.token !== null && q.token !== undefined) {
    return bad(`it names a ${pinned.symbol} contract this app does not know`);
  }
  if (q.decimals !== pinned.decimals) return bad(`it counts ${pinned.symbol} in ${String(q.decimals)} decimals, not ${pinned.decimals}`);
  const deposit = depositAddress();
  if (!deposit || !sameAddress(String(q.depositAddress ?? ''), deposit)) return bad('it names a deposit address this app does not know');
  if (!sameAddress(String(q.to ?? ''), req.to)) return bad('it credits another FMX address than the one asked for');
  if (!sameAddress(String(q.from ?? ''), req.from)) return bad('it names another paying wallet than yours');
  if (q.status !== 'quoted') return bad('it is not open');

  const units = uint(q.sendExactly);
  if (units === null || units <= 0n) return bad('it has no amount to send');
  if (q.sendExactlyFormatted !== undefined && parseDecimalUnits(q.sendExactlyFormatted, pinned.decimals) !== units) {
    return bad('its two ways of writing the amount disagree');
  }
  if (units > req.units) {
    if (q.dustDirection !== 'up' || units - req.units > MAX_DUST_UNITS) return bad('it asks for more than you typed');
  } else if (req.units - units > MAX_DUST_UNITS) {
    return bad('its amount is further from what you typed than a quote may be');
  }

  const usdE18 = parseDecimalE18(q.usd);
  const assetUsdE18 = parseDecimalE18(q.assetUsd);
  const priceE18 = parseDecimalE18(q.priceUsdPerFmx);
  const spreadBps = q.spreadBps;
  if (usdE18 === null || assetUsdE18 === null || assetUsdE18 <= 0n) return bad('it has no USD value');
  if (pinned.stable && assetUsdE18 !== E18) return bad(`it does not count ${pinned.symbol} as 1 USD`);
  if (usdE18 !== usdValueE18(units, pinned.decimals, assetUsdE18)) return bad('its USD value does not add up');
  if (priceE18 === null || priceE18 <= 0n) return bad('it has no FMX price');
  if (ctx.priceE18 !== null && priceE18 !== ctx.priceE18) return bad('its FMX price differs from the published one');
  if (typeof spreadBps !== 'number' || !Number.isInteger(spreadBps) || spreadBps !== ctx.spreadBps) return bad('its spread differs from the published one');
  const fmxOut = uint(q.fmxOut);
  if (fmxOut === null || fmxOut <= 0n || fmxOut !== fmxOutFor(usdE18, priceE18, spreadBps)) return bad('its FMX amount does not add up');
  const usdMin = (BigInt(Math.round(ctx.minUsd * 1e6)) * E18 * 99n) / 1_000_000n / 100n;
  const usdMax = (BigInt(Math.round(ctx.maxUsd * 1e6)) * E18 * 101n) / 1_000_000n / 100n;
  if (usdE18 < usdMin || usdE18 > usdMax) return bad('it is outside the per-quote limits');

  const expiresS = q.expires;
  if (typeof expiresS !== 'number' || !Number.isFinite(expiresS) || expiresS < 60 || expiresS > 3600) return bad('it has no usable lifetime');
  const expiresAt = typeof q.expiresAt === 'number' && Number.isFinite(q.expiresAt) ? q.expiresAt : Math.floor(ctx.requestedAtMs / 1000) + expiresS;
  const confirmations =
    typeof q.confirmations === 'number' && Number.isInteger(q.confirmations) && q.confirmations > 0 && q.confirmations <= 1000 ? q.confirmations : pinnedChain.confirmations;

  return {
    ok: true,
    quote: {
      quoteId,
      chain: req.chain,
      chainId: pinnedChain.chainId,
      asset: req.asset,
      kind: pinned.kind,
      token: pinned.token,
      decimals: pinned.decimals,
      sendExactly: units,
      requested: req.typedUnits ?? req.units,
      depositAddress: deposit,
      fmxOut,
      priceE18,
      spreadBps,
      usdE18,
      assetUsdE18,
      to: getAddress(req.to),
      from: getAddress(req.from),
      confirmations,
      expiresS,
      expiresAt,
      deadlineMs: ctx.requestedAtMs + expiresS * 1000,
    },
  };
}

// ---------------------------------------------------------------------------
// The transfer
// ---------------------------------------------------------------------------

const TRANSFER = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

export interface PayTx {
  from: string;
  to: string;
  /** 0x-hex wei. */
  value: string;
  data?: string;
}

/**
 * The one transaction a quote allows: a token transfer of `sendExactly` to the
 * deposit address (sent to the pinned contract, no value), or `sendExactly` of
 * the native coin straight to the deposit address. Built from the validated
 * quote only; the typed amount never reaches here.
 */
export function buildPayTx(q: PayQuote): PayTx {
  const pinned = payAsset(q.chain, q.asset);
  const deposit = depositAddress();
  if (!pinned || !deposit || !sameAddress(q.depositAddress, deposit) || pinned.kind !== q.kind || pinned.decimals !== q.decimals) {
    throw new Error('This quote does not match the pay-in this app knows. Nothing was sent.');
  }
  if (q.sendExactly <= 0n) throw new Error('This quote has no amount to send.');
  if (pinned.kind === 'native') {
    return { from: getAddress(q.from), to: deposit, value: '0x' + q.sendExactly.toString(16) };
  }
  if (!sameAddress(q.token, pinned.token)) throw new Error('This quote names a token contract this app does not know. Nothing was sent.');
  return {
    from: getAddress(q.from),
    to: getAddress(pinned.token!),
    value: '0x0',
    data: TRANSFER.encodeFunctionData('transfer', [deposit, q.sendExactly]),
  };
}

/** Gas each kind of transfer is budgeted, with room: a coin send, and a token transfer (USDT on Ethereum is the costliest, ~63k). */
export const PAY_GAS_LIMIT = { native: 21_000n, erc20: 90_000n } as const;

/** The fee a transfer may cost at `gasPrice`, with a quarter on top for a price that moves while the wallet is open. */
export function gasReserve(kind: 'erc20' | 'native', gasPrice: bigint): bigint {
  return (PAY_GAS_LIMIT[kind] * gasPrice * 5n) / 4n;
}

export interface PayBalances {
  /** The network's own coin, in wei; null when it could not be read. */
  native: bigint | null;
  /** Token balances by symbol; null when unread. */
  tokens: Partial<Record<PayAssetSymbol, bigint | null>>;
  gasPrice: bigint | null;
  at: number;
}

/** The balance of `asset` in `b`, or undefined when it was not read. */
export function balanceOf(b: PayBalances | null | undefined, asset: PayAsset): bigint | undefined {
  if (!b) return undefined;
  const v = asset.kind === 'native' ? b.native : b.tokens[asset.symbol];
  return v === null || v === undefined ? undefined : v;
}

/**
 * Why this wallet cannot make the payment, or null when it can (or when the
 * balances could not be read, in which case the wallet itself is the judge).
 */
export function balanceShortfall(q: Pick<PayQuote, 'kind' | 'asset' | 'sendExactly' | 'decimals' | 'chain'>, b: PayBalances | null): string | null {
  const c = payChain(q.chain);
  const a = payAsset(q.chain, q.asset);
  if (!b || !c || !a) return null;
  const nativeSym = c.native.symbol;
  const fee = b.gasPrice !== null ? gasReserve(q.kind, b.gasPrice) : null;
  const has = balanceOf(b, a);
  if (has !== undefined && has < q.sendExactly) {
    return `You have ${formatUnits(has, q.decimals)} ${q.asset} on ${c.name}; this quote needs exactly ${formatUnits(q.sendExactly, q.decimals)}.`;
  }
  if (q.kind === 'native') {
    if (has !== undefined && fee !== null && has < q.sendExactly + fee) {
      return `After sending ${formatUnits(q.sendExactly, q.decimals)} ${q.asset} there is not enough left for the ${c.name} network fee (about ${formatUnits(fee, 18)} ${nativeSym}). Get a quote for a little less.`;
    }
    return null;
  }
  if (b.native !== null && fee !== null && b.native < fee) {
    return `Not enough ${nativeSym} on ${c.name} for the network fee: about ${formatUnits(fee, 18)} ${nativeSym} is needed beside your ${q.asset}.`;
  }
  if (b.native !== null && b.native === 0n) return `No ${nativeSym} on ${c.name} for the network fee: a little is needed beside your ${q.asset}.`;
  return null;
}

/** The most of `asset` a "Max" may fill in: the whole token balance, or the coin balance less two fee budgets. */
export function maxSpendable(asset: PayAsset, b: PayBalances | null): bigint | null {
  const has = balanceOf(b, asset);
  if (has === undefined) return null;
  if (asset.kind === 'erc20') return has;
  const fee = b?.gasPrice !== null && b?.gasPrice !== undefined ? gasReserve('native', b.gasPrice) * 2n : 0n;
  return has > fee ? has - fee : 0n;
}

// ---------------------------------------------------------------------------
// Reading balances on the paying network (public endpoints, no wallet needed)
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init);

/** One JSON-RPC call, trying each endpoint in turn. */
export async function payRpc(urls: readonly string[], method: string, params: unknown[], fetchImpl: FetchLike = defaultFetch, timeoutMs = 6000): Promise<unknown> {
  let last: unknown = new Error('no endpoint');
  for (const url of urls) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller?.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? 'RPC error');
      return body.result;
    } catch (err) {
      last = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function hexUint(v: unknown): bigint | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null;
}

/** Balances of `owner` on one paying network: its coin, USDT, USDC and the gas price. Unreadable values are null. */
export async function readPayBalances(c: PayChain, owner: string, fetchImpl: FetchLike = defaultFetch): Promise<PayBalances> {
  const who = getAddress(owner);
  const call = (method: string, params: unknown[]) => payRpc(c.rpcUrls, method, params, fetchImpl).then(hexUint, () => null);
  const balanceData = '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0');
  const tokens = c.assets.filter((a) => a.kind === 'erc20');
  const [native, gasPrice, ...tokenBalances] = await Promise.all([
    call('eth_getBalance', [who, 'latest']),
    call('eth_gasPrice', []),
    ...tokens.map((a) => call('eth_call', [{ to: a.token, data: balanceData }, 'latest'])),
  ]);
  const out: PayBalances = { native, gasPrice, tokens: {}, at: Date.now() };
  tokens.forEach((a, i) => {
    out.tokens[a.symbol] = tokenBalances[i] ?? null;
  });
  return out;
}

// ---------------------------------------------------------------------------
// The pay-in API
// ---------------------------------------------------------------------------

export class PayApiError extends Error {
  readonly status: number;
  /** The network is paused (503 "temporarily unavailable"): re-read the asset list. */
  readonly unavailable: boolean;
  constructor(status: number, message: string, unavailable = false) {
    super(message);
    this.name = 'PayApiError';
    this.status = status;
    this.unavailable = unavailable;
  }
}

async function payApi(url: string, init: Parameters<FetchLike>[1], fetchImpl: FetchLike): Promise<unknown> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, init);
  } catch {
    throw new PayApiError(0, 'Could not reach the pay-in at ferminux.net. Check your connection and try again.');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = body as { error?: unknown; unavailable?: unknown } | null;
    const said = typeof b?.error === 'string' ? b.error.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const unavailable = res.status === 503 && (b?.unavailable === true || /temporarily unavailable/i.test(said));
    const msg =
      res.status === 429
        ? 'Too many quote requests from this connection. Wait a minute and try again.'
        : res.status === 503 && !unavailable
          ? `The pay-in is not taking payments right now${said ? ` (${said})` : ''}. Try again in a minute.`
          : said || `The pay-in answered with HTTP ${res.status}.`;
    throw new PayApiError(res.status, msg, unavailable);
  }
  return body;
}

export async function fetchPayAssets(base: string, fetchImpl: FetchLike = defaultFetch): Promise<PayAssetsInfo> {
  return parseAssetsResponse(await payApi(`${base}/assets`, { method: 'GET' }, fetchImpl));
}

export async function requestPayQuote(base: string, req: PayQuoteRequest, fetchImpl: FetchLike = defaultFetch): Promise<unknown> {
  return payApi(`${base}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quoteRequestBody(req)) }, fetchImpl);
}

export async function fetchPayStatus(base: string, quoteId: string, fetchImpl: FetchLike = defaultFetch): Promise<unknown> {
  if (!/^q_[A-Za-z0-9]{6,64}$/.test(quoteId)) throw new PayApiError(400, 'Not a quote id.');
  return payApi(`${base}/${quoteId}`, { method: 'GET' }, fetchImpl);
}

// ---------------------------------------------------------------------------
// Following a quote: quoted → (sent) → seen → confirmed → paid
// ---------------------------------------------------------------------------

export type PayStatusName = 'quoted' | 'seen' | 'confirmed' | 'paid' | 'expired' | 'failed' | 'superseded';
const STATUSES: readonly PayStatusName[] = ['quoted', 'seen', 'confirmed', 'paid', 'expired', 'failed', 'superseded'];

/** How far along a status is. A read that is further back than what was already seen is stale and ignored. */
const RANK: Record<PayStatusName, number> = { quoted: 0, superseded: 0, expired: 0, seen: 1, confirmed: 2, paid: 3, failed: 3 };

export interface PayTrack {
  quote: PayQuote;
  status: PayStatusName;
  confirmations: number;
  required: number;
  /** The payment on the paying network, as the pay-in saw it. */
  depositTx: string | null;
  /** The FMX transfer on Ferminux. */
  fmxTx: string | null;
  error: string | null;
  /** The hash the wallet returned for this quote's payment. */
  sentTx: string | null;
  /** Set just before the wallet is asked to send: a reload in between leaves this without a sentTx. */
  sendingAt: number | null;
  sentAt: number | null;
  checkedAt: number | null;
}

export function newTrack(quote: PayQuote): PayTrack {
  return {
    quote,
    status: 'quoted',
    confirmations: 0,
    required: quote.confirmations,
    depositTx: null,
    fmxTx: null,
    error: null,
    sentTx: null,
    sendingAt: null,
    sentAt: null,
    checkedAt: null,
  };
}

/**
 * Fold one GET /api/payin/{id} answer into the track. The answer must be for
 * this quote (id, network, coin, amount, recipient); a status behind the one
 * already seen is a stale read and changes nothing; paid is final.
 */
export function applyStatus(t: PayTrack, raw: unknown, now: number): PayTrack {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') throw new Error('The pay-in answered with something that is not a status.');
  if (s.quoteId !== t.quote.quoteId || s.chain !== t.quote.chain || (s.asset !== undefined && s.asset !== t.quote.asset)) {
    throw new Error('The pay-in answered about another quote.');
  }
  if (s.target !== undefined && !sameAddress(String(s.target), t.quote.to)) throw new Error('The pay-in names another FMX recipient for this quote.');
  const units = uint(s.sendExactly ?? s.amountUnits);
  if (units !== null && units !== t.quote.sendExactly) throw new Error('The pay-in names another amount for this quote.');
  const status = STATUSES.includes(s.status as PayStatusName) ? (s.status as PayStatusName) : null;
  if (!status) throw new Error('The pay-in answered with an unknown status.');

  const next: PayTrack = { ...t, checkedAt: now };
  if (t.status === 'paid') return next;
  const hashes = (s.txHashes ?? {}) as { deposit?: { hash?: unknown } | null; fmx?: { hash?: unknown } | null };
  const depositTx = isTxHash(s.txHashIn) ? s.txHashIn : isTxHash(hashes.deposit?.hash) ? (hashes.deposit!.hash as string) : null;
  const fmxTx = isTxHash(s.txHashOut) ? s.txHashOut : isTxHash(hashes.fmx?.hash) ? (hashes.fmx!.hash as string) : null;
  if (depositTx) next.depositTx = depositTx;
  if (fmxTx) next.fmxTx = fmxTx;
  if (typeof s.required === 'number' && Number.isInteger(s.required) && s.required > 0 && s.required <= 1000) next.required = s.required;
  if (typeof s.confirmations === 'number' && Number.isInteger(s.confirmations) && s.confirmations >= 0) {
    next.confirmations = Math.max(t.confirmations, Math.min(s.confirmations, 1_000_000));
  }
  const stale = RANK[status] < RANK[t.status] || (t.status === 'failed' && status !== 'paid');
  if (!stale) {
    next.status = status;
    next.error = typeof s.error === 'string' && s.error.trim() ? s.error.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  }
  if (next.status === 'confirmed' || next.status === 'paid') next.confirmations = Math.max(next.confirmations, next.required);
  return next;
}

/** Keeps the first mark: a retry must not erase the sign that an earlier attempt may have gone out. */
/**
 * The pay-in matches a deposit to the OLDEST open or replaced quote with the
 * same exact amount and payer, for ten minutes after that quote closes; its
 * unique-amount rule only steps around quotes that are still open. So a new
 * quote from this wallet for an amount one of its replaced quotes also had
 * would have its payment credited to the replaced one, and the new quote would
 * look unpaid. These are the amounts this browser's own quotes can still be
 * matched at, for one network and coin.
 */
export function recentUnits(tracks: readonly PayTrack[], sel: { chain: PayChainKey; asset: PayAssetSymbol; from: string }, now: number): bigint[] {
  return tracks
    .filter(
      (t) =>
        t.quote.chain === sel.chain &&
        t.quote.asset === sel.asset &&
        sameAddress(t.quote.from, sel.from) &&
        (t.status === 'quoted' || t.status === 'superseded') &&
        t.depositTx === null &&
        now <= t.quote.deadlineMs + 15 * 60_000,
    )
    .map((t) => t.quote.sendExactly);
}

/**
 * The amount to ask for. The pay-in steps DOWN from it to the first amount no
 * open quote holds, so any of this wallet's recent amounts at or a few units
 * under it could be landed on. Asking one unit under the lowest of those means
 * the step-down can reach none of them. Nothing near: what was typed.
 */
export function distinctFrom(want: bigint, taken: Iterable<bigint>): bigint {
  let lowest: bigint | null = null;
  for (const u of taken) if (u <= want && want - u <= MAX_DUST_UNITS && (lowest === null || u < lowest)) lowest = u;
  return lowest !== null && lowest > 1n ? lowest - 1n : want;
}

/** What "Your FMX purchases" lists: anything paid, being paid, or still open. A quote nobody paid that closed is left out. */
export function visiblePurchases(tracks: readonly PayTrack[], now: number): PayTrack[] {
  return tracks.filter(
    (t) =>
      t.sentTx !== null ||
      t.sendingAt !== null ||
      t.depositTx !== null ||
      t.status === 'seen' ||
      t.status === 'confirmed' ||
      t.status === 'paid' ||
      t.status === 'failed' ||
      (t.status === 'quoted' && secondsLeft(t, now) > 0),
  );
}

export function markSending(t: PayTrack, now: number): PayTrack {
  return t.sendingAt !== null ? t : { ...t, sendingAt: now };
}

/** The wallet said no, or a check refused before anything was asked: nothing can have been sent. */
export function clearSending(t: PayTrack): PayTrack {
  return { ...t, sendingAt: null };
}

export function markSent(t: PayTrack, hash: string, now: number): PayTrack {
  if (!isTxHash(hash)) throw new Error('The wallet returned something that is not a transaction hash.');
  return { ...t, sentTx: hash, sentAt: now, sendingAt: null };
}

/** A send was started and never reported back (the page reloaded mid-send, or the wallet errored): it may have gone out. */
export function maybeSent(t: PayTrack): boolean {
  return t.sentTx === null && t.sendingAt !== null && t.status === 'quoted';
}

export function secondsLeft(t: PayTrack | PayQuote, now: number): number {
  const q = 'quote' in t ? t.quote : t;
  return Math.floor((q.deadlineMs - now) / 1000);
}

/** Why the wallet must not be asked to pay this quote now, or null when it may. */
export function sendRefusal(t: PayTrack, now: number): string | null {
  if (t.sentTx) return 'This quote has already been paid from your wallet. Do not send it again.';
  if (t.status === 'seen' || t.status === 'confirmed' || t.status === 'paid') return 'A payment for this quote has already arrived. Do not send it again.';
  if (t.status === 'superseded') return 'This quote was replaced by a newer one for the same coin. Get a new quote.';
  if (t.status === 'expired') return 'This quote has expired. Get a new quote.';
  if (t.status === 'failed') return 'This quote failed at the pay-in. Get a new quote.';
  const left = secondsLeft(t, now);
  if (left <= 0) return 'This quote has expired. Get a new quote.';
  if (left < MIN_SECONDS_TO_SEND) return 'Less than a minute is left on this quote: a payment could arrive after it closes. Get a new quote.';
  return null;
}

/**
 * The last word before the wallet is asked: the pay-in's own record of the
 * quote, read just now. The copy this page holds may be one a reload brought
 * back from storage, or one another tab or device has since replaced; it is
 * only paid while the pay-in still holds it open for exactly this amount, to
 * this recipient, from this payer, at the pinned contract and deposit address.
 * Returns the track with the answer folded in, and why it must not be paid
 * (null when it may).
 */
export function confirmOpenQuote(t: PayTrack, raw: unknown, now: number): { track: PayTrack; refusal: string | null } {
  let next: PayTrack;
  try {
    next = applyStatus(t, raw, now);
  } catch (err) {
    return { track: t, refusal: `${err instanceof Error ? err.message : String(err)} Nothing was sent.` };
  }
  const s = raw as Record<string, unknown>;
  const c = payChain(t.quote.chain);
  const pinned = payAsset(t.quote.chain, t.quote.asset);
  const deposit = depositAddress();
  const fail = (why: string) => ({ track: next, refusal: `The pay-in's record of this quote ${why}. Nothing was sent.` });
  if (!c || !pinned || !deposit) return fail('is for a network or coin this app does not offer');
  if (uint(s.sendExactly ?? s.amountUnits) !== t.quote.sendExactly) return fail('has no amount to send');
  if (s.target === undefined || !sameAddress(String(s.target), t.quote.to)) return fail('names another FMX recipient');
  if (!sameAddress(String(s.depositAddress ?? ''), deposit)) return fail('names a deposit address this app does not know');
  if (s.chainId !== undefined && s.chainId !== c.chainId) return fail(`is for another network than ${c.name}`);
  if (s.decimals !== undefined && s.decimals !== pinned.decimals) return fail(`counts ${pinned.symbol} in other decimals`);
  if (s.token !== undefined && (pinned.kind === 'erc20' ? !sameAddress(String(s.token ?? ''), pinned.token) : s.token !== null)) {
    return fail(`names a ${pinned.symbol} contract this app does not know`);
  }
  if (s.payer !== undefined && s.payer !== null && !sameAddress(String(s.payer), t.quote.from)) return fail('names another paying wallet');
  return { track: next, refusal: sendRefusal(next, now) };
}

/** Nothing more will happen to this quote. */
export function isFinished(t: PayTrack, now: number): boolean {
  if (t.status === 'paid' || t.status === 'failed' || t.status === 'expired') return true;
  const neverSent = t.sentTx === null && t.sendingAt === null;
  if (t.status === 'superseded' && neverSent) return true;
  // The pay-in stops matching a quote ten minutes after it closes; an unpaid one is over by then.
  if (t.status === 'quoted' && neverSent && now > t.quote.deadlineMs + 11 * 60_000) return true;
  return false;
}

export function shouldPoll(t: PayTrack, now: number): boolean {
  return !isFinished(t, now);
}

/** Where the four-step tracker stands: 0 waiting for the payment, 1 sent, 2 seen, 3 confirmed, 4 delivered. */
export function trackStep(t: PayTrack): number {
  if (t.status === 'paid') return 4;
  if (t.status === 'confirmed') return 3;
  if (t.status === 'seen') return 2;
  if (t.status === 'failed' && t.depositTx) return 3;
  return t.sentTx ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Keeping open quotes across reloads (serialised; bigints as strings)
// ---------------------------------------------------------------------------

export const PAY_STORE_KEY = 'ferminux-dex.payin.v1';
const MAX_TRACKS = 20;
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;

export interface PayStore {
  active: string | null;
  tracks: PayTrack[];
}

const BIG_QUOTE_FIELDS = ['sendExactly', 'requested', 'fmxOut', 'priceE18', 'usdE18', 'assetUsdE18'] as const;

export function serializeStore(s: PayStore): string {
  return JSON.stringify({
    v: 1,
    active: s.active,
    tracks: s.tracks.map((t) => ({
      ...t,
      quote: Object.fromEntries(Object.entries(t.quote).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
    })),
  });
}

/**
 * Read the store back, keeping only tracks whose quote still matches this
 * app's pinned networks, contracts and deposit address: nothing read from
 * storage can make the wallet pay somewhere this build would not.
 */
export function parseStore(text: string | null, now: number): PayStore {
  const empty: PayStore = { active: null, tracks: [] };
  if (!text) return empty;
  let raw: { active?: unknown; tracks?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!raw || !Array.isArray(raw.tracks)) return empty;
  const deposit = depositAddress();
  const tracks: PayTrack[] = [];
  for (const r of raw.tracks as Array<Record<string, unknown>>) {
    try {
      const q = r.quote as Record<string, unknown>;
      const pinned = payAsset(String(q.chain), String(q.asset));
      const pc = payChain(String(q.chain));
      if (!pinned || !pc || !deposit) continue;
      const big: Record<string, bigint> = {};
      for (const k of BIG_QUOTE_FIELDS) {
        const v = uint(q[k]);
        if (v === null) throw new Error(k);
        big[k] = v;
      }
      if (!sameAddress(String(q.depositAddress), deposit) || q.kind !== pinned.kind || q.decimals !== pinned.decimals) continue;
      if (pinned.kind === 'erc20' ? !sameAddress(String(q.token), pinned.token) : q.token !== null) continue;
      if (typeof q.quoteId !== 'string' || !/^q_[A-Za-z0-9]{6,64}$/.test(q.quoteId)) continue;
      if (!ADDRESS_RE.test(String(q.to)) || !ADDRESS_RE.test(String(q.from))) continue;
      const numOk = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      if (![q.deadlineMs, q.expiresAt, q.expiresS, q.confirmations, q.spreadBps].every(numOk)) continue;
      const quote: PayQuote = {
        quoteId: q.quoteId,
        chain: pc.key,
        chainId: pc.chainId,
        asset: pinned.symbol,
        kind: pinned.kind,
        token: pinned.token,
        decimals: pinned.decimals,
        sendExactly: big.sendExactly!,
        requested: big.requested!,
        depositAddress: deposit,
        fmxOut: big.fmxOut!,
        priceE18: big.priceE18!,
        spreadBps: q.spreadBps as number,
        usdE18: big.usdE18!,
        assetUsdE18: big.assetUsdE18!,
        to: getAddress(String(q.to)),
        from: getAddress(String(q.from)),
        confirmations: q.confirmations as number,
        expiresS: q.expiresS as number,
        expiresAt: q.expiresAt as number,
        deadlineMs: q.deadlineMs as number,
      };
      const status = STATUSES.includes(r.status as PayStatusName) ? (r.status as PayStatusName) : 'quoted';
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const t: PayTrack = {
        quote,
        status,
        confirmations: n(r.confirmations) ?? 0,
        required: n(r.required) ?? quote.confirmations,
        depositTx: isTxHash(r.depositTx) ? r.depositTx : null,
        fmxTx: isTxHash(r.fmxTx) ? r.fmxTx : null,
        error: typeof r.error === 'string' ? r.error.slice(0, 300) : null,
        sentTx: isTxHash(r.sentTx) ? r.sentTx : null,
        sendingAt: n(r.sendingAt),
        sentAt: n(r.sentAt),
        checkedAt: n(r.checkedAt),
      };
      const age = now - (t.checkedAt ?? t.quote.deadlineMs);
      if (isFinished(t, now) && age > KEEP_FINISHED_MS) continue;
      if (!tracks.some((x) => x.quote.quoteId === t.quote.quoteId)) tracks.push(t);
    } catch {
      /* one unreadable entry must not cost the others */
    }
  }
  const kept = tracks.sort((a, b) => b.quote.deadlineMs - a.quote.deadlineMs).slice(0, MAX_TRACKS);
  const active = typeof raw.active === 'string' && kept.some((t) => t.quote.quoteId === raw.active) ? raw.active : null;
  return { active, tracks: kept };
}

/** Add or replace one track (newest first), capped. */
export function upsertTrack(s: PayStore, t: PayTrack): PayStore {
  const rest = s.tracks.filter((x) => x.quote.quoteId !== t.quote.quoteId);
  return { ...s, tracks: [t, ...rest].sort((a, b) => b.quote.deadlineMs - a.quote.deadlineMs).slice(0, MAX_TRACKS) };
}
