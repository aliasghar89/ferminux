// Buy FMX with a coin on another network, through the Ferminux pay-in
// (agents/gateway/src/v3/payin.ts: GET /api/payin/assets, POST /api/payin/quote,
// GET /api/payin/{id}). No browser globals beyond `fetch` — runs under Node for
// the unit tests.
//
// How the pay-in works, and why every check below exists:
//   • A quote names an EXACT amount (`sendExactly`, token units) that is unique
//     among the open quotes on that network and coin. The deposit is matched to
//     the quote BY THAT AMOUNT (and by the sender the quote declared), so the
//     wallet sends exactly `sendExactly` — never a rounded or re-typed figure —
//     and always declares itself as the sender (`from`).
//   • FMX goes to the recipient written in the quote (`to`), not to whoever
//     sends. The quote the gateway returns is checked against what was asked:
//     network, chain id, coin, token contract, decimals, recipient, sender,
//     amount (the gateway only ever subtracts a few units of dust) and the FMX
//     figure recomputed from the quote's own USD value, price and spread.
//   • Token contracts and decimals come from this wallet's own chain list
//     (lib/chains.ts, itself checked against payin.ts by tests/chains.test.mjs),
//     never from the API: a pay-in answer that names a different contract is
//     refused, it is not followed. BNB Smart Chain's USDT and USDC have 18
//     decimals, the other networks' 6.
//   • A quote is valid for 15 minutes; the wallet refuses to sign one with less
//     than PAYIN_MIN_LEFT_S left, so a transfer cannot land after it expired.

import { Interface, getAddress } from 'ethers';
import { FOREIGN_CHAINS, type ChainDef } from './chains.ts';
import { encodeTokenTransfer } from './tokens.ts';
import { formatAmount, formatAmountExact } from './validate.ts';

const E18 = 10n ** 18n;

/** Least time a quote must still have when the wallet signs its transfer. */
export const PAYIN_MIN_LEFT_S = 60;
/** The gateway steps an exact amount down (rarely up) by a unit per colliding open quote; more than this is not dust. */
export const PAYIN_MAX_DUST_UNITS = 1000n;
/** Status poll cadence while a purchase is open. */
export const PAYIN_POLL_MS = 10_000;
/** The gateway keeps matching a deposit to a quote this long past its expiry (payin.ts: expiresAt >= t - 600). */
export const PAYIN_MATCH_GRACE_S = 600;
export const PAYIN_RECORDS_KEY = 'ferminux.wallet.payin.v1';
export const PAYIN_RECORDS_CAP = 50;

/** Cheapest networks first; Ethereum last (its fee alone can exceed a small purchase). */
export const PAYIN_NETWORK_ORDER = ['bsc', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche', 'eth'] as const;

export type PayinStatusName = 'quoted' | 'seen' | 'confirmed' | 'paid' | 'expired' | 'failed' | 'superseded';
export const PAYIN_STATUSES: readonly PayinStatusName[] = ['quoted', 'seen', 'confirmed', 'paid', 'expired', 'failed', 'superseded'];

/* ------------------------------------------------------------------ */
/* The coins this wallet can pay with                                  */
/* ------------------------------------------------------------------ */

export interface PayinCoin {
  /** This wallet's own definition of the network (id, RPCs, explorer). */
  chain: ChainDef;
  /** USDT, USDC or the network's native coin (ETH, BNB, POL, AVAX). */
  symbol: string;
  name: string;
  kind: 'erc20' | 'native';
  /** Token contract (EIP-55) from this wallet's chain list; null for the native coin. */
  address: string | null;
  decimals: number;
  stable: boolean;
}

/** USDT, USDC, then the native coin, as this wallet knows them on `chain`. */
export function payinCoins(chain: ChainDef): PayinCoin[] {
  const out: PayinCoin[] = [];
  for (const sym of ['USDT', 'USDC']) {
    const t = chain.tokens.find((x) => x.symbol === sym);
    if (t) out.push({ chain, symbol: sym, name: t.name, kind: 'erc20', address: getAddress(t.address), decimals: t.decimals, stable: true });
  }
  out.push({ chain, symbol: chain.native.symbol, name: chain.native.name, kind: 'native', address: null, decimals: chain.native.decimals, stable: false });
  return out;
}

/** The pay-in networks in picker order (this wallet's chain defs). */
export function payinNetworks(): ChainDef[] {
  return PAYIN_NETWORK_ORDER.map((k) => FOREIGN_CHAINS.find((c) => c.key === k)).filter((c): c is ChainDef => c !== undefined);
}

export function payinCoin(chainKey: string, symbol: string): PayinCoin | null {
  const chain = FOREIGN_CHAINS.find((c) => c.key === chainKey);
  if (!chain) return null;
  return payinCoins(chain).find((c) => c.symbol === symbol) ?? null;
}

export const payinCoinKey = (c: { chain: { key: string }; symbol: string }) => `${c.chain.key}:${c.symbol}`;

/* ------------------------------------------------------------------ */
/* Decimal helpers (exact, bigint)                                     */
/* ------------------------------------------------------------------ */

/** A non-negative decimal string with at most `decimals` places → units. Null when malformed. */
export function parseDecimalUnits(text: unknown, decimals: number): bigint | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,40})(?:\.(\d{1,36}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    // "25.000" at 2 decimals is still exact; only non-zero digits past the scale are refused
    if (/[^0]/.test(frac.slice(decimals))) return null;
  }
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'));
}

const isUintString = (v: unknown): v is string => typeof v === 'string' && /^\d{1,78}$/.test(v);
const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const sameAddress = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/* ------------------------------------------------------------------ */
/* GET /api/payin/assets                                               */
/* ------------------------------------------------------------------ */

export interface PayinNetwork {
  key: string;
  chainId: number;
  confirmations: number;
  depositAddress: string | null;
  /** Taking quotes right now (its deposit scanner has completed a recent scan). */
  available: boolean;
  /** Why not, when not available. */
  reason: string | null;
  /** Coins the pay-in offers here AND whose contract and decimals match this wallet's. */
  coins: string[];
}

export interface PayinAssets {
  enabled: boolean;
  /** Operator-fixed USD per FMX (decimal string), null when the quote follows the market. */
  priceUsdPerFmx: string | null;
  spreadBps: number;
  minUsd: number;
  maxUsd: number;
  /** Quote validity, seconds. */
  expires: number;
  networks: PayinNetwork[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate the asset list against this wallet's own chain list. A network
 * whose chain id differs, or a coin whose contract or decimals differ, is not
 * offered (with the reason) — the wallet never pays a contract it did not
 * already know.
 */
export function parsePayinAssets(raw: unknown): Parsed<PayinAssets> {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'The pay-in answered with something that is not an asset list.' };
  if (typeof r.enabled !== 'boolean') return { ok: false, error: 'The pay-in asset list has no "enabled" flag.' };
  const spreadBps = Number(r.spreadBps);
  const minUsd = Number(r.minUsd);
  const maxUsd = Number(r.maxUsd);
  const expires = Number(r.expires ?? 900);
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > 1000) return { ok: false, error: 'The pay-in asset list has no sensible spread.' };
  if (!(minUsd > 0) || !(maxUsd >= minUsd) || !Number.isFinite(maxUsd)) return { ok: false, error: 'The pay-in asset list has no sensible USD limits.' };
  if (!Number.isInteger(expires) || expires < 60 || expires > 86_400) return { ok: false, error: 'The pay-in asset list has no sensible quote validity.' };
  let priceUsdPerFmx: string | null = null;
  if (r.priceUsdPerFmx !== null && r.priceUsdPerFmx !== undefined) {
    const p = parseDecimalUnits(r.priceUsdPerFmx, 18);
    if (p === null || p <= 0n) return { ok: false, error: 'The pay-in asset list has an unreadable FMX price.' };
    priceUsdPerFmx = String(r.priceUsdPerFmx);
  }
  const listed = Array.isArray(r.chains) ? (r.chains as Array<Record<string, unknown>>) : [];
  const networks: PayinNetwork[] = [];
  for (const chain of payinNetworks()) {
    const c = listed.find((x) => x && x.chain === chain.key);
    if (!c) {
      networks.push({ key: chain.key, chainId: chain.id, confirmations: 0, depositAddress: null, available: false, reason: 'not listed by the pay-in', coins: [] });
      continue;
    }
    const confirmations = Number(c.confirmations);
    const depositAddress = isAddress(c.depositAddress) ? getAddress(c.depositAddress) : null;
    let reason: string | null = null;
    if (Number(c.chainId) !== chain.id) reason = `the pay-in names chain ${String(c.chainId)} for ${chain.name}, not ${chain.id}`;
    else if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 1000) reason = 'the pay-in lists no confirmation depth';
    else if (!depositAddress) reason = 'the pay-in lists no deposit address';
    const coins: string[] = [];
    const mismatched: string[] = [];
    const offered = Array.isArray(c.assets) ? (c.assets as Array<Record<string, unknown>>) : [];
    for (const coin of payinCoins(chain)) {
      const a = offered.find((x) => x && x.symbol === coin.symbol);
      if (!a) continue;
      const kindOk = a.kind === coin.kind;
      const tokenOk = coin.kind === 'native' ? a.token === null || a.token === undefined : sameAddress(a.token as string, coin.address);
      if (kindOk && tokenOk && Number(a.decimals) === coin.decimals) coins.push(coin.symbol);
      else mismatched.push(coin.symbol);
    }
    if (!reason && coins.length === 0) reason = mismatched.length ? `the pay-in's ${mismatched.join('/')} contract does not match this wallet's` : 'no coin offered';
    const serverUp = c.available !== false && r.enabled === true;
    if (!reason && !serverUp) {
      const why = typeof c.unavailableReason === 'string' ? c.unavailableReason.slice(0, 200) : null;
      reason = r.enabled ? why ?? 'its deposit scanner is not reaching this network right now' : 'pay-in is switched off';
    }
    networks.push({
      key: chain.key,
      chainId: chain.id,
      confirmations: Number.isInteger(confirmations) ? confirmations : 0,
      depositAddress,
      available: reason === null,
      reason,
      coins,
    });
  }
  return { ok: true, value: { enabled: r.enabled, priceUsdPerFmx, spreadBps, minUsd, maxUsd, expires, networks } };
}

export function networkOf(assets: PayinAssets | null, key: string): PayinNetwork | null {
  return assets?.networks.find((n) => n.key === key) ?? null;
}

/* ------------------------------------------------------------------ */
/* Before the quote: bounds, balance, estimate                          */
/* ------------------------------------------------------------------ */

/** USD value of a stablecoin amount (1 USD per unit), 1e18. */
export function stableUsdE18(units: bigint, decimals: number): bigint {
  return (units * E18) / 10n ** BigInt(decimals);
}

/** A stablecoin amount outside the pay-in's USD limits (natives are priced by the quote, which applies the same rule). */
export function stableBoundsProblem(units: bigint, decimals: number, minUsd: number, maxUsd: number): string | null {
  const usd = stableUsdE18(units, decimals);
  const min = BigInt(Math.round(minUsd * 1e6)) * 10n ** 12n;
  const max = BigInt(Math.round(maxUsd * 1e6)) * 10n ** 12n;
  if (usd < min) return `The pay-in takes at least $${fmtUsdLimit(minUsd)} per purchase.`;
  if (usd > max) return `The pay-in takes at most $${fmtUsdLimit(maxUsd)} per purchase. Buy in several parts.`;
  return null;
}

export const fmtUsdLimit = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** FMX (wei) for `usdE18` at `priceUsdPerFmx` after the spread — the gateway's own fmxOutFor(). */
export function fmxForUsd(usdE18: bigint, priceE18: bigint, spreadBps: number): bigint {
  if (priceE18 <= 0n) return 0n;
  return (usdE18 * E18 * (10_000n - BigInt(spreadBps))) / (10_000n * priceE18);
}

/** What a stablecoin amount buys at the listed price, before the quote (null when the price is not fixed). */
export function estimateStableFmx(units: bigint, decimals: number, assets: PayinAssets | null): bigint | null {
  if (!assets?.priceUsdPerFmx) return null;
  const price = parseDecimalUnits(assets.priceUsdPerFmx, 18);
  if (price === null || price <= 0n) return null;
  return fmxForUsd(stableUsdE18(units, decimals), price, assets.spreadBps);
}

/**
 * Whether this account can pay `amount` of the coin plus the network fee, from
 * balances read on that network. `maxFeeWei` is the prepared transaction's
 * worst case; before a transaction exists, pass 0n to test the amount alone.
 */
export function payinFundsProblem(p: {
  coin: Pick<PayinCoin, 'kind' | 'symbol' | 'decimals'>;
  chain: Pick<ChainDef, 'name' | 'native'>;
  amount: bigint;
  tokenBalance: bigint | null;
  nativeBalance: bigint | null;
  maxFeeWei: bigint;
  l1FeeUnknown?: boolean;
}): string | null {
  const nat = p.chain.native;
  const n = (v: bigint) => formatAmount(v, nat.decimals, 8);
  if (p.coin.kind === 'native') {
    if (p.nativeBalance === null) return null;
    if (p.nativeBalance < p.amount) return `This account has ${formatAmount(p.nativeBalance, nat.decimals, 8)} ${nat.symbol} on ${p.chain.name}; this purchase needs ${formatAmountExact(p.amount, nat.decimals)} ${nat.symbol}.`;
    if (p.nativeBalance < p.amount + p.maxFeeWei) return `${formatAmountExact(p.amount, nat.decimals)} ${nat.symbol} plus the network fee (up to ${n(p.maxFeeWei)} ${nat.symbol}) is more than the ${n(p.nativeBalance)} ${nat.symbol} this account holds on ${p.chain.name}. Buy for a little less.`;
    return null;
  }
  if (p.tokenBalance !== null && p.tokenBalance < p.amount) {
    return `This account has ${formatAmount(p.tokenBalance, p.coin.decimals, 6)} ${p.coin.symbol} on ${p.chain.name}; this purchase needs ${formatAmountExact(p.amount, p.coin.decimals)} ${p.coin.symbol}.`;
  }
  if (p.nativeBalance !== null) {
    if (p.nativeBalance === 0n) return `This account has no ${nat.symbol} on ${p.chain.name}, so it cannot pay the network fee there. Fees on ${p.chain.name} are paid in ${nat.symbol}.`;
    if (p.nativeBalance < p.maxFeeWei) return `Not enough ${nat.symbol} on ${p.chain.name} for the network fee: this transfer needs up to ${n(p.maxFeeWei)} ${nat.symbol}, the account has ${n(p.nativeBalance)} ${nat.symbol}.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* POST /api/payin/quote                                               */
/* ------------------------------------------------------------------ */

export interface PayinRequest {
  chain: string;
  asset: string;
  /** Exact units the user typed. */
  units: bigint;
  /** FMX recipient on Ferminux. */
  to: string;
  /** The sending account on the pay-in network (this wallet). */
  from: string;
}

/** The JSON body the gateway's quote route takes. */
export function quoteBody(req: PayinRequest, coin: PayinCoin): { chain: string; asset: string; amount: string; to: string; from: string } {
  return { chain: req.chain, asset: req.asset, amount: formatAmountExact(req.units, coin.decimals), to: getAddress(req.to), from: getAddress(req.from) };
}

export interface PayinQuote {
  quoteId: string;
  chain: string;
  chainId: number;
  asset: string;
  kind: 'erc20' | 'native';
  /** This wallet's contract for the coin (checked equal to the gateway's); null for a native coin. */
  token: string | null;
  decimals: number;
  requested: bigint;
  /** The exact units to send — the only amount the wallet ever signs. */
  sendExactly: bigint;
  dustDirection: 'down' | 'up' | 'none';
  depositAddress: string;
  to: string;
  from: string;
  fmxOut: bigint;
  usd: string;
  assetUsd: string | null;
  priceUsdPerFmx: string;
  spreadBps: number;
  /** Unix seconds. */
  expiresAt: number;
  confirmations: number;
}

/**
 * Check the gateway's quote against what was asked, and against itself. Any
 * mismatch refuses the quote: nothing is signed for it.
 */
export function parsePayinQuote(raw: unknown, req: PayinRequest, opts: { assets?: PayinAssets | null; nowS: number }): Parsed<PayinQuote> {
  const q = raw as Record<string, unknown> | null;
  const bad = (why: string): Parsed<PayinQuote> => ({ ok: false, error: `The pay-in's quote does not match what was asked (${why}). Nothing was sent.` });
  if (!q || typeof q !== 'object') return bad('no quote');
  const coin = payinCoin(req.chain, req.asset);
  if (!coin) return bad(`unknown coin ${req.asset} on ${req.chain}`);
  if (typeof q.quoteId !== 'string' || !/^q_[A-Za-z0-9]{6,64}$/.test(q.quoteId)) return bad('quote id');
  if (q.chain !== req.chain) return bad('network');
  if (Number(q.chainId) !== coin.chain.id) return bad(`chain id ${String(q.chainId)}, not ${coin.chain.id}`);
  if (q.asset !== req.asset) return bad('coin');
  if (q.assetKind !== coin.kind) return bad('coin kind');
  if (coin.kind === 'erc20' ? !sameAddress(q.token as string, coin.address) : q.token !== null && q.token !== undefined) return bad('token contract');
  if (Number(q.decimals) !== coin.decimals) return bad(`decimals ${String(q.decimals)}, not ${coin.decimals}`);
  if (!isUintString(q.sendExactly)) return bad('amount');
  const sendExactly = BigInt(q.sendExactly);
  if (sendExactly <= 0n) return bad('amount');
  const diff = sendExactly > req.units ? sendExactly - req.units : req.units - sendExactly;
  if (diff > PAYIN_MAX_DUST_UNITS) return bad(`asks for ${formatAmountExact(sendExactly, coin.decimals)} ${coin.symbol}, you asked for ${formatAmountExact(req.units, coin.decimals)}`);
  if (!isAddress(q.depositAddress)) return bad('deposit address');
  const depositAddress = getAddress(q.depositAddress);
  const listed = networkOf(opts.assets ?? null, req.chain)?.depositAddress ?? null;
  if (listed && !sameAddress(listed, depositAddress)) return bad('deposit address differs from the listed one');
  if (!isAddress(q.to) || !sameAddress(q.to, req.to)) return bad('FMX recipient');
  if (!isAddress(q.from) || !sameAddress(q.from, req.from)) return bad('sender');
  if (!isUintString(q.fmxOut) || BigInt(q.fmxOut) <= 0n) return bad('FMX amount');
  const fmxOut = BigInt(q.fmxOut);
  const serverExpiresAt = Number(q.expiresAt);
  if (!Number.isInteger(serverExpiresAt) || serverExpiresAt > opts.nowS + 86_400) return bad('expiry');
  if (serverExpiresAt <= opts.nowS) return bad("expiry: already past on this device's clock; check the date and time settings");
  // The gateway's expiresAt is on ITS clock. A device clock running behind would count down from a later
  // time and let a quote be signed after the pay-in stopped matching it, so the countdown is anchored to this
  // device's own clock from the quote's validity (`expires`, seconds): whichever ends first.
  const ttl = Number(q.expires);
  const expiresAt = Number.isInteger(ttl) && ttl > 0 && ttl <= 86_400 ? Math.min(serverExpiresAt, opts.nowS + ttl) : serverExpiresAt;
  const spreadBps = Number(q.spreadBps);
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > 1000) return bad('spread');
  const price = parseDecimalUnits(q.priceUsdPerFmx, 18);
  const usd = parseDecimalUnits(q.usd, 18);
  if (price === null || price <= 0n || usd === null) return bad('price');
  // The quote's own arithmetic, as the gateway does it: USD value of the exact amount, then FMX after the spread.
  let assetUsd: string | null = null;
  if (coin.stable) {
    if (usd !== stableUsdE18(sendExactly, coin.decimals)) return bad('USD value');
  } else {
    const per = parseDecimalUnits(q.assetUsd, 18);
    if (per === null || per <= 0n) return bad(`${coin.symbol} price`);
    if (usd !== (sendExactly * per) / 10n ** BigInt(coin.decimals)) return bad('USD value');
    assetUsd = String(q.assetUsd);
  }
  if (fmxForUsd(usd, price, spreadBps) !== fmxOut) return bad('FMX amount does not follow from the price and spread');
  const confirmations = Number(q.confirmations);
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 1000) return bad('confirmations');
  return {
    ok: true,
    value: {
      quoteId: q.quoteId,
      chain: req.chain,
      chainId: coin.chain.id,
      asset: coin.symbol,
      kind: coin.kind,
      token: coin.address,
      decimals: coin.decimals,
      requested: req.units,
      sendExactly,
      dustDirection: sendExactly < req.units ? 'down' : sendExactly > req.units ? 'up' : 'none',
      depositAddress,
      to: getAddress(q.to),
      from: getAddress(q.from),
      fmxOut,
      usd: String(q.usd),
      assetUsd,
      priceUsdPerFmx: String(q.priceUsdPerFmx),
      spreadBps,
      expiresAt,
      confirmations,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

export function secondsLeft(expiresAt: number, nowS: number): number {
  return Math.max(0, Math.floor(expiresAt - nowS));
}

/** 'expired', 'short' (under PAYIN_MIN_LEFT_S: get a new quote) or null (fine to sign). */
export function expiryProblem(expiresAt: number, nowS: number): 'expired' | 'short' | null {
  const left = expiresAt - nowS;
  if (left <= 0) return 'expired';
  if (left < PAYIN_MIN_LEFT_S) return 'short';
  return null;
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* The transfer                                                        */
/* ------------------------------------------------------------------ */

const erc20 = new Interface(['function transfer(address to, uint256 value) returns (bool)']);

/** The one call that pays a quote: transfer(deposit, sendExactly) on the token, or sendExactly of the native coin to the deposit. */
export function payinCall(q: Pick<PayinQuote, 'kind' | 'token' | 'depositAddress' | 'sendExactly'>): { to: string; value: bigint; data: string } {
  if (q.kind === 'native') return { to: getAddress(q.depositAddress), value: q.sendExactly, data: '0x' };
  if (!q.token) throw new Error('No token contract for this coin.');
  return { to: getAddress(q.token), value: 0n, data: encodeTokenTransfer(q.depositAddress, q.sendExactly) };
}

/**
 * Null when the prepared transaction pays exactly this quote — right chain,
 * right contract, exactly `sendExactly` to the deposit address and nothing
 * else — otherwise why not. Run on the prepared transaction and again right
 * before signing.
 */
export function payinTxProblem(
  tx: { chainId: number; to: string; valueWei: bigint; data: string },
  q: Pick<PayinQuote, 'chainId' | 'kind' | 'token' | 'depositAddress' | 'sendExactly' | 'chain'>,
): string | null {
  const coinChain = FOREIGN_CHAINS.find((c) => c.key === q.chain);
  if (!coinChain || coinChain.id !== q.chainId) return 'the quote names a network this wallet does not pay on';
  if (tx.chainId !== q.chainId) return `signed for chain ${tx.chainId}, the quote is on ${q.chainId}`;
  if (q.kind === 'native') {
    if (!sameAddress(tx.to, q.depositAddress)) return 'not addressed to the deposit address';
    if (tx.valueWei !== q.sendExactly) return 'the value is not the exact quoted amount';
    if (tx.data !== '0x' && tx.data !== '') return 'a native payment carries no call data';
    return null;
  }
  if (!sameAddress(tx.to, q.token)) return 'not addressed to the coin contract';
  if (tx.valueWei !== 0n) return 'a token payment carries no native value';
  let decoded: { to: string; value: bigint };
  try {
    if (tx.data.slice(0, 10).toLowerCase() !== '0xa9059cbb' || tx.data.length !== 2 + 8 + 128) return 'the call is not transfer(address,uint256)';
    const [to, value] = erc20.decodeFunctionData('transfer', tx.data) as unknown as [string, bigint];
    decoded = { to, value };
  } catch {
    return 'the call data does not decode';
  }
  if (!sameAddress(decoded.to, q.depositAddress)) return 'the transfer is not to the deposit address';
  if (decoded.value !== q.sendExactly) return 'the transfer is not the exact quoted amount';
  return null;
}

/* ------------------------------------------------------------------ */
/* GET /api/payin/{id}                                                 */
/* ------------------------------------------------------------------ */

export interface PayinStatusView {
  quoteId: string;
  status: PayinStatusName;
  confirmations: number;
  required: number;
  depositTx: string | null;
  /** The FMX payout on Ferminux: a transaction hash, or null. */
  fmxTx: string | null;
  /** Set when the gateway recorded a recovered payout without a hash. */
  fmxNote: string | null;
  error: string | null;
}

/**
 * A status answer, checked to be about this purchase (same quote, network, coin, exact amount, recipient,
 * deposit address and payer). Read right before signing, it is the pay-in's own word that a stored quote
 * still pays that deposit address from this sender, so a stale or altered local copy is never paid.
 */
export function parsePayinStatus(raw: unknown, rec: Pick<PayinRecord, 'quoteId' | 'chain' | 'asset' | 'sendExactly' | 'to' | 'depositAddress' | 'from'>): Parsed<PayinStatusView> {
  const s = raw as Record<string, unknown> | null;
  const bad = (why: string): Parsed<PayinStatusView> => ({ ok: false, error: `The pay-in's status answer is not about this purchase (${why}).` });
  if (!s || typeof s !== 'object') return bad('empty');
  if (s.quoteId !== rec.quoteId) return bad('quote id');
  if (!PAYIN_STATUSES.includes(s.status as PayinStatusName)) return bad(`status ${String(s.status)}`);
  if (s.chain !== rec.chain) return bad('network');
  if ((s.asset ?? 'USDC') !== rec.asset) return bad('coin');
  const units = s.sendExactly ?? s.amountUnits;
  if (!isUintString(units) || units !== rec.sendExactly) return bad('amount');
  if (!isAddress(s.target) || !sameAddress(s.target, rec.to)) return bad('recipient');
  if (!isAddress(s.depositAddress) || !sameAddress(s.depositAddress, rec.depositAddress)) return bad('deposit address');
  // a quote this wallet asked for always declares its payer; the gateway only fills a missing one in
  if (s.payer !== null && s.payer !== undefined && (!isAddress(s.payer) || !sameAddress(s.payer, rec.from))) return bad('sender');
  const hashes = (s.txHashes ?? {}) as { deposit?: { hash?: unknown } | null; fmx?: { hash?: unknown } | null };
  const dep = hashes.deposit?.hash ?? s.txHashIn;
  const out = hashes.fmx?.hash ?? s.txHashOut;
  const conf = Number(s.confirmations);
  const required = Number(s.required);
  return {
    ok: true,
    value: {
      quoteId: rec.quoteId,
      status: s.status as PayinStatusName,
      confirmations: Number.isInteger(conf) && conf >= 0 ? conf : 0,
      required: Number.isInteger(required) && required > 0 ? required : 0,
      depositTx: isHash(dep) ? dep.toLowerCase() : null,
      fmxTx: isHash(out) ? out.toLowerCase() : null,
      fmxNote: typeof out === 'string' && !isHash(out) && out !== '' ? 'recorded as delivered (recovered payout)' : null,
      error: typeof s.error === 'string' && s.error !== '' ? s.error.slice(0, 200) : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Purchases, as this device remembers them                            */
/* ------------------------------------------------------------------ */

/** What this wallet did with its own transfer for a quote. */
export type LocalPayState = 'none' | 'signed' | 'sent' | 'included' | 'reverted' | 'dropped';

export interface PayinRecord {
  quoteId: string;
  chain: string;
  chainId: number;
  asset: string;
  kind: 'erc20' | 'native';
  token: string | null;
  decimals: number;
  /** Units as a decimal string (bigint does not survive JSON). */
  sendExactly: string;
  depositAddress: string;
  to: string;
  from: string;
  fmxOut: string;
  priceUsdPerFmx: string;
  spreadBps: number;
  usd: string;
  expiresAt: number;
  required: number;
  createdAt: number;
  status: PayinStatusName;
  confirmations: number;
  localTx: string | null;
  localState: LocalPayState;
  depositTx: string | null;
  fmxTx: string | null;
  note: string | null;
  error: string | null;
}

export function recordFromQuote(q: PayinQuote, nowMs: number): PayinRecord {
  return {
    quoteId: q.quoteId,
    chain: q.chain,
    chainId: q.chainId,
    asset: q.asset,
    kind: q.kind,
    token: q.token,
    decimals: q.decimals,
    sendExactly: q.sendExactly.toString(),
    depositAddress: q.depositAddress,
    to: q.to,
    from: q.from,
    fmxOut: q.fmxOut.toString(),
    priceUsdPerFmx: q.priceUsdPerFmx,
    spreadBps: q.spreadBps,
    usd: q.usd,
    expiresAt: q.expiresAt,
    required: q.confirmations,
    createdAt: nowMs,
    status: 'quoted',
    confirmations: 0,
    localTx: null,
    localState: 'none',
    depositTx: null,
    fmxTx: null,
    note: null,
    error: null,
  };
}

/** A stored purchase back as a quote, for "Review and pay" after a reload. */
export function quoteFromRecord(r: PayinRecord): PayinQuote {
  const sendExactly = BigInt(r.sendExactly);
  return {
    quoteId: r.quoteId,
    chain: r.chain,
    chainId: r.chainId,
    asset: r.asset,
    kind: r.kind,
    token: r.token,
    decimals: r.decimals,
    requested: sendExactly,
    sendExactly,
    dustDirection: 'none',
    depositAddress: r.depositAddress,
    to: r.to,
    from: r.from,
    fmxOut: BigInt(r.fmxOut),
    usd: r.usd,
    assetUsd: null,
    priceUsdPerFmx: r.priceUsdPerFmx,
    spreadBps: r.spreadBps,
    expiresAt: r.expiresAt,
    confirmations: r.required,
  };
}

const RANK: Record<PayinStatusName, number> = { quoted: 0, superseded: 0, seen: 1, confirmed: 2, paid: 3, expired: -1, failed: -1 };

/**
 * Fold a status answer into a purchase. Progress only moves forward: a slower
 * poll answering "seen" after "confirmed" is ignored, and "paid" is final.
 * "superseded" is not final — the gateway still matches a deposit to a
 * superseded quote — while "expired" can only follow a quote nobody paid.
 */
export function withStatus(r: PayinRecord, s: PayinStatusView): PayinRecord {
  if (s.quoteId !== r.quoteId || r.status === 'paid') return r;
  let status: PayinStatusName = r.status;
  const next = s.status;
  if (next === 'failed') status = 'failed';
  else if (next === 'expired') status = RANK[r.status] <= 0 ? 'expired' : r.status;
  else if (RANK[next] >= RANK[r.status] || r.status === 'expired' || r.status === 'failed') status = next;
  const moved = status === next;
  return {
    ...r,
    status,
    confirmations: moved ? Math.max(s.confirmations, status === r.status ? r.confirmations : 0) : r.confirmations,
    required: s.required > 0 ? s.required : r.required,
    depositTx: s.depositTx ?? r.depositTx,
    fmxTx: s.fmxTx ?? r.fmxTx,
    note: s.fmxNote ?? r.note,
    error: s.error ?? (status === 'paid' ? null : r.error),
  };
}

export function withLocalPay(r: PayinRecord, hash: string | null, state: LocalPayState, error: string | null = null): PayinRecord {
  return { ...r, localTx: hash ? hash.toLowerCase() : null, localState: state, error };
}

/** Worth polling: not paid, not failed, and (if never paid by this wallet) still inside the gateway's matching window. */
export function isOpen(r: PayinRecord, nowS: number): boolean {
  if (r.status === 'paid' || r.status === 'failed' || r.status === 'expired') return false;
  if (r.status === 'seen' || r.status === 'confirmed') return true;
  // a transfer this wallet reverted or lost is still polled until the window closes: the
  // status is the gateway's word, the local reading only this wallet's view of one network
  if (r.status === 'superseded' && r.localState === 'none') return false;
  // one more poll after the gateway's grace window turns an unpaid quote into 'expired' on screen
  return nowS <= r.expiresAt + PAYIN_MATCH_GRACE_S + 120;
}

/** Signed but not yet paid for: this wallet can still pay it ("Review and pay"). */
export function canStillPay(r: PayinRecord, nowS: number): boolean {
  return r.status === 'quoted' && r.localState === 'none' && expiryProblem(r.expiresAt, nowS) === null;
}

export type TrackBad = 'expired' | 'failed' | 'superseded' | 'reverted' | 'dropped';

/** The tracker's four steps: sent on the network → seen → confirmed → FMX delivered. */
export function trackerStep(r: PayinRecord): { done: number; bad: TrackBad | null } {
  // 'signed' is not counted: until the network knows the hash, the transfer may never have left this device
  const sent = r.localState === 'sent' || r.localState === 'included';
  const done = r.status === 'paid' ? 4 : r.status === 'confirmed' ? 3 : r.status === 'seen' ? 2 : sent ? 1 : 0;
  let bad: TrackBad | null = null;
  if (r.status === 'failed') bad = 'failed';
  else if (r.status === 'expired') bad = 'expired';
  else if (done < 2 && r.localState === 'reverted') bad = 'reverted';
  else if (done < 2 && r.localState === 'dropped') bad = 'dropped';
  else if (r.status === 'superseded' && done < 2) bad = 'superseded';
  return { done, bad };
}

function normalizeRecord(raw: unknown): PayinRecord | null {
  const r = raw as Partial<PayinRecord> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.quoteId !== 'string' || !/^q_[A-Za-z0-9]{6,64}$/.test(r.quoteId)) return null;
  const coin = typeof r.chain === 'string' && typeof r.asset === 'string' ? payinCoin(r.chain, r.asset) : null;
  if (!coin || r.chainId !== coin.chain.id || r.kind !== coin.kind || r.decimals !== coin.decimals) return null;
  if (coin.kind === 'erc20' ? !sameAddress(r.token, coin.address) : r.token !== null) return null;
  if (!isUintString(r.sendExactly) || !isUintString(r.fmxOut)) return null;
  if (!isAddress(r.depositAddress) || !isAddress(r.to) || !isAddress(r.from)) return null;
  if (!PAYIN_STATUSES.includes(r.status as PayinStatusName)) return null;
  const states: LocalPayState[] = ['none', 'signed', 'sent', 'included', 'reverted', 'dropped'];
  if (!states.includes(r.localState as LocalPayState)) return null;
  if (r.localTx != null && !isHash(r.localTx)) return null;
  if (!Number.isInteger(r.expiresAt) || !Number.isFinite(r.createdAt)) return null;
  const txOrNull = (v: unknown) => (isHash(v) ? v.toLowerCase() : null);
  const text = (v: unknown, n: number) => (typeof v === 'string' && v !== '' ? v.slice(0, n) : null);
  return {
    quoteId: r.quoteId,
    chain: coin.chain.key,
    chainId: coin.chain.id,
    asset: coin.symbol,
    kind: coin.kind,
    token: coin.address,
    decimals: coin.decimals,
    sendExactly: r.sendExactly,
    depositAddress: getAddress(r.depositAddress),
    to: getAddress(r.to),
    from: getAddress(r.from),
    fmxOut: r.fmxOut,
    priceUsdPerFmx: text(r.priceUsdPerFmx, 40) ?? '0',
    spreadBps: Number.isInteger(r.spreadBps) && (r.spreadBps as number) >= 0 && (r.spreadBps as number) <= 1000 ? (r.spreadBps as number) : 0,
    usd: text(r.usd, 60) ?? '0',
    expiresAt: r.expiresAt as number,
    required: Number.isInteger(r.required) ? (r.required as number) : 0,
    createdAt: r.createdAt as number,
    status: r.status as PayinStatusName,
    confirmations: Number.isInteger(r.confirmations) ? (r.confirmations as number) : 0,
    localTx: r.localTx ? r.localTx.toLowerCase() : null,
    localState: r.localState as LocalPayState,
    depositTx: txOrNull(r.depositTx),
    fmxTx: txOrNull(r.fmxTx),
    note: text(r.note, 120),
    error: text(r.error, 240),
  };
}

export function parsePayinRecords(raw: string | null): PayinRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PayinRecord[] = [];
  for (const item of parsed) {
    const r = normalizeRecord(item);
    if (r && !out.some((o) => o.quoteId === r.quoteId)) out.push(r);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, PAYIN_RECORDS_CAP);
}

export function serializePayinRecords(list: PayinRecord[]): string {
  return JSON.stringify(list);
}

/** Insert or replace by quote id, newest first, capped. */
export function withRecord(list: PayinRecord[], rec: PayinRecord): PayinRecord[] {
  const r = normalizeRecord(rec);
  if (!r) return list;
  return [r, ...list.filter((o) => o.quoteId !== r.quoteId)].sort((a, b) => b.createdAt - a.createdAt).slice(0, PAYIN_RECORDS_CAP);
}

/** Purchases this account paid for (or quoted) from this device. */
export function recordsFrom(list: PayinRecord[], address: string): PayinRecord[] {
  return list.filter((r) => sameAddress(r.from, address));
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export class PayinApiError extends Error {
  readonly status: number;
  /** 503: pay-in off, or this network's deposit scanner is not reaching it right now. */
  readonly unavailable: boolean;
  constructor(message: string, status: number, unavailable = false) {
    super(message);
    this.status = status;
    this.unavailable = unavailable;
  }
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function call(url: string, init: { method?: string; body?: unknown } = {}, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new PayinApiError('The Ferminux pay-in could not be reached. Check the connection and try again.', 0);
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; reason?: unknown; unavailable?: unknown; disabled?: unknown };
    const msg = typeof b.error === 'string' ? b.error : typeof b.reason === 'string' ? b.reason : `The pay-in answered HTTP ${res.status}.`;
    throw new PayinApiError(msg.slice(0, 300), res.status, res.status === 503);
  }
  if (body === null) throw new PayinApiError('The pay-in answered with something that is not JSON.', res.status);
  return body;
}

export async function fetchPayinAssets(base: string, fetchImpl?: FetchLike): Promise<PayinAssets> {
  const r = parsePayinAssets(await call(`${base}/api/payin/assets`, {}, fetchImpl));
  if (!r.ok) throw new PayinApiError(r.error, 200);
  return r.value;
}

export async function requestPayinQuote(base: string, req: PayinRequest, opts: { assets: PayinAssets | null; nowS: () => number; fetchImpl?: FetchLike }): Promise<PayinQuote> {
  const coin = payinCoin(req.chain, req.asset);
  if (!coin) throw new PayinApiError(`${req.asset} on ${req.chain} is not a coin this wallet pays with.`, 0);
  const raw = await call(`${base}/api/payin/quote`, { method: 'POST', body: quoteBody(req, coin) }, opts.fetchImpl);
  const q = parsePayinQuote(raw, req, { assets: opts.assets, nowS: opts.nowS() });
  if (!q.ok) throw new PayinApiError(q.error, 200);
  return q.value;
}

export async function fetchPayinStatus(base: string, rec: PayinRecord, fetchImpl?: FetchLike): Promise<PayinStatusView> {
  const s = parsePayinStatus(await call(`${base}/api/payin/${encodeURIComponent(rec.quoteId)}`, {}, fetchImpl), rec);
  if (!s.ok) throw new PayinApiError(s.error, 200);
  return s.value;
}
