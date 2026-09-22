// Amount / fee / cap math and input validation.
//
// Every function here is PURE and mirrors FerminuxBridge.sol exactly, so the
// number the user is shown before signing is the number the contract computes:
//   fee  = amount * feeBps / BPS_DENOMINATOR      (integer division, floors)
//   net  = amount - fee
//   cap  = a continuously-draining 24 h bucket, not a calendar day
// No browser globals — these run under Node in tests/amounts.test.mjs.

import { getAddress, parseUnits, formatUnits } from 'ethers';

export const BPS_DENOMINATOR = 10_000n;
/** WINDOW in FerminuxBridge.sol. */
export const CAP_WINDOW_SECONDS = 86_400n;

// ------------------------------------------------------------------ validation
export type AddressCheck = { ok: true; address: string } | { ok: false; error: string };

/** Validate an address with EIP-55 checksum enforcement (same rules as the wallet). */
export function checkAddress(input: string): AddressCheck {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Recipient address is required.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return { ok: false, error: 'An address is 0x followed by 40 hex characters.' };
  }
  const allOneCase = s.toLowerCase() === s || s.slice(2).toUpperCase() === s.slice(2);
  try {
    // getAddress accepts an all-lowercase / all-uppercase address (it carries no
    // checksum information) and rejects a bad mixed-case one — EIP-55 semantics.
    return { ok: true, address: getAddress(allOneCase ? s.toLowerCase() : s) };
  } catch {
    return { ok: false, error: 'Checksum mismatch — re-copy the address; one or more characters are wrong.' };
  }
}

/**
 * Reject the burn address as a bridge recipient: `execute()` requires a non-zero
 * recipient, so a transfer to 0x0 could never be delivered and the funds would
 * be locked on the source chain forever.
 */
export function checkRecipient(input: string): AddressCheck {
  const r = checkAddress(input);
  if (!r.ok) return r;
  if (/^0x0{40}$/i.test(r.address)) {
    return { ok: false, error: 'The zero address cannot receive a transfer — it would be unrecoverable.' };
  }
  return r;
}

export type AmountCheck = { ok: true; wei: bigint } | { ok: false; error: string };

/** Parse a decimal amount string into base units, strictly. */
export function checkAmount(input: string, decimals = 18): AmountCheck {
  let s = input.trim();
  if (s === '') return { ok: false, error: 'Amount is required.' };
  if (!/^\d*\.?\d*$/.test(s) || s === '.') {
    return { ok: false, error: 'Enter a plain decimal number (digits and one dot).' };
  }
  if (s.startsWith('.')) s = '0' + s;
  if (s.endsWith('.')) s = s.slice(0, -1);
  const frac = s.split('.')[1] ?? '';
  if (frac.length > decimals) {
    return { ok: false, error: `Too precise — this asset has ${decimals} decimal places.` };
  }
  let wei: bigint;
  try {
    wei = parseUnits(s, decimals);
  } catch {
    return { ok: false, error: 'Invalid amount.' };
  }
  if (wei <= 0n) return { ok: false, error: 'Amount must be greater than zero.' };
  return { ok: true, wei };
}

// ------------------------------------------------------------------- fee math
/** fee = amount * feeBps / 10000, floored — byte-for-byte the contract's math. */
export function feeOf(amountWei: bigint, feeBps: bigint | number): bigint {
  const bps = BigInt(feeBps);
  if (bps < 0n) throw new Error('feeBps cannot be negative');
  if (amountWei <= 0n) return 0n;
  return (amountWei * bps) / BPS_DENOMINATOR;
}

/** What actually arrives on the destination chain. */
export function netOf(amountWei: bigint, feeBps: bigint | number): bigint {
  return amountWei - feeOf(amountWei, feeBps);
}

/** Basis points as a percentage string, e.g. 10 -> "0.10%". */
export function formatBps(bps: bigint | number): string {
  const n = Number(bps) / 100;
  return `${n.toFixed(2)}%`;
}

// ------------------------------------------------------------------ cap math
/**
 * The contract's draining bucket, replayed locally:
 *   used_now = used - used * elapsed / WINDOW   (0 once WINDOW has passed)
 * Lets the UI show capacity recovering between polls instead of a stale figure.
 *
 * Exact at the moment of the read. Extrapolated forward it is an ESTIMATE by a
 * few parts per million: the contract decays the raw stored `used` from its own
 * `updatedAt`, which is not exposed, so this re-decays the already-decayed value
 * the view function returned — and the base timestamp itself can be one block
 * out, because nodes evaluate eth_call against the pending block. Over a 12 s
 * poll interval the difference is negligible, and the contract is always the
 * authority: `quoteTransfer` only ever advises, `send()` decides.
 */
export function decayedUsage(
  used: bigint,
  updatedAt: bigint | number,
  nowSeconds: bigint | number,
  windowSeconds: bigint = CAP_WINDOW_SECONDS,
): bigint {
  const last = BigInt(updatedAt);
  if (last === 0n || used <= 0n) return 0n;
  const now = BigInt(nowSeconds);
  if (now <= last) return used; // clock skew: never under-report usage
  const elapsed = now - last;
  if (elapsed >= windowSeconds) return 0n;
  return used - (used * elapsed) / windowSeconds;
}

/** Capacity still available in the rolling window. Never negative. */
export function remainingCapacity(dailyCap: bigint, usage: bigint): bigint {
  return dailyCap > usage ? dailyCap - usage : 0n;
}

/**
 * Seconds until `wanted` capacity is available again, given the linear drain.
 * Returns null if the cap itself is smaller than `wanted` (waiting never helps).
 */
export function secondsUntilCapacity(
  dailyCap: bigint,
  usage: bigint,
  wanted: bigint,
  windowSeconds: bigint = CAP_WINDOW_SECONDS,
): number | null {
  if (wanted <= remainingCapacity(dailyCap, usage)) return 0;
  if (wanted > dailyCap) return null;
  // need usage <= dailyCap - wanted; usage decays linearly to 0 over the window
  const target = dailyCap - wanted;
  if (usage <= 0n) return 0;
  // usage * (1 - t/W) <= target  =>  t >= W * (usage - target) / usage
  const seconds = (windowSeconds * (usage - target) + usage - 1n) / usage; // ceil
  return Number(seconds);
}

// ------------------------------------------------------------------- quoting
export interface QuoteInput {
  amountWei: bigint;
  feeBps: bigint | number;
  maxPerTransfer: bigint;
  dailyCap: bigint;
  /** Outbound usage on the source bridge, already decayed to "now". */
  usage: bigint;
  /** null = not yet known (still loading). Never blocks on an unknown balance. */
  balance: bigint | null;
  decimals: number;
  symbol: string;
  /** Native coin transfers must also leave gas for the send() transaction. */
  isNative: boolean;
  gasReserveWei?: bigint;
  bridgePaused?: boolean;
  tokenPaused?: boolean;
}

export interface Quote {
  ok: boolean;
  feeWei: bigint;
  netWei: bigint;
  remaining: bigint;
  /** Capacity left in the window if this transfer goes through. */
  remainingAfter: bigint;
  /** Blocking reasons, most actionable first. Empty when ok. */
  problems: string[];
}

/**
 * Everything the user must know BEFORE committing: the fee, the exact amount
 * that will arrive, and whether the rails will accept it. The checks and their
 * order mirror send() in FerminuxBridge.sol, so a quote that says "ok" is a
 * transaction that does not revert on the bridge's own requires.
 */
export function quoteTransfer(input: QuoteInput): Quote {
  const {
    amountWei,
    feeBps,
    maxPerTransfer,
    dailyCap,
    usage,
    balance,
    decimals,
    symbol,
    isNative,
    gasReserveWei = 0n,
    bridgePaused = false,
    tokenPaused = false,
  } = input;

  const remaining = remainingCapacity(dailyCap, usage);
  const feeWei = feeOf(amountWei > 0n ? amountWei : 0n, feeBps);
  const netWei = amountWei > 0n ? amountWei - feeWei : 0n;
  const problems: string[] = [];

  if (bridgePaused) problems.push('The bridge is paused. No transfer can be sent right now.');
  if (tokenPaused) problems.push(`${symbol} is paused on this bridge. No transfer of this asset can be sent.`);

  if (amountWei <= 0n) {
    problems.push('Enter an amount greater than zero.');
  } else {
    if (maxPerTransfer > 0n && amountWei > maxPerTransfer) {
      problems.push(
        `Above the per-transfer cap of ${formatAmount(maxPerTransfer, decimals)} ${symbol}. Split it into smaller transfers.`,
      );
    }
    if (amountWei > remaining) {
      problems.push(
        `Above the remaining 24 h capacity of ${formatAmount(remaining, decimals)} ${symbol}. Capacity refills continuously.`,
      );
    }
    if (netWei <= 0n) {
      problems.push('Too small — the bridge fee would consume the whole amount.');
    }
    if (balance !== null) {
      if (amountWei > balance) {
        problems.push(`Exceeds your balance of ${formatAmount(balance, decimals)} ${symbol}.`);
      } else if (isNative && amountWei + gasReserveWei > balance) {
        problems.push('Leaves nothing for gas. Use Max, which reserves the network fee.');
      }
    }
  }

  return {
    ok: problems.length === 0,
    feeWei,
    netWei,
    remaining,
    remainingAfter: amountWei > 0n && amountWei <= remaining ? remaining - amountWei : remaining,
    problems,
  };
}

/**
 * Largest amount this user can actually bridge right now: the tightest of
 * balance (minus gas headroom for the native coin), the per-transfer cap and
 * the remaining 24 h capacity.
 */
export function maxBridgeable(input: {
  balance: bigint;
  maxPerTransfer: bigint;
  dailyCap: bigint;
  usage: bigint;
  isNative: boolean;
  gasReserveWei?: bigint;
}): bigint {
  const { balance, maxPerTransfer, dailyCap, usage, isNative, gasReserveWei = 0n } = input;
  const spendable = isNative ? (balance > gasReserveWei ? balance - gasReserveWei : 0n) : balance;
  let max = spendable;
  if (maxPerTransfer > 0n && maxPerTransfer < max) max = maxPerTransfer;
  const remaining = remainingCapacity(dailyCap, usage);
  if (remaining < max) max = remaining;
  return max > 0n ? max : 0n;
}

// ---------------------------------------------------------------- formatting
/**
 * Format base units for display: groups thousands, truncates (never rounds up)
 * so a displayed balance is never overstated.
 */
export function formatAmount(wei: bigint, decimals = 18, maxFraction = 6): string {
  const full = formatUnits(wei, decimals);
  const [whole, frac = ''] = full.split('.');
  const trimmed = frac.slice(0, maxFraction).replace(/0+$/, '');
  const wholeGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (trimmed === '') {
    const hadMore = frac.replace(/0+$/, '').length > 0;
    return hadMore ? `${wholeGrouped}.${'0'.repeat(Math.min(maxFraction, 6))}` : wholeGrouped;
  }
  return `${wholeGrouped}.${trimmed}`;
}

/** Full-precision string — used on confirm screens where truncation would lie. */
export function formatAmountExact(wei: bigint, decimals = 18): string {
  return formatUnits(wei, decimals);
}

export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

export function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

/** "about 4 minutes", "about 1 hour 10 minutes" — honest, never a fake countdown. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  const h = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rem === 0 ? h : `${h} ${rem} minute${rem === 1 ? '' : 's'}`;
}

/** Compact relative time for the history list. */
export function formatAgo(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
