// Input validation + fee math. Pure functions, no browser globals.

import { getAddress, parseUnits, formatUnits } from 'ethers';

export type AddressCheck = { ok: true; address: string } | { ok: false; error: string };

/** Validate a recipient address with EIP-55 checksum enforcement. */
export function checkAddress(input: string): AddressCheck {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Recipient address is required.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return { ok: false, error: 'An address is 0x followed by 40 hex characters.' };
  }
  try {
    // getAddress accepts all-lowercase/all-uppercase and rejects a bad
    // mixed-case checksum — exactly EIP-55 semantics.
    return { ok: true, address: getAddress(s.toLowerCase() === s || s.slice(2).toUpperCase() === s.slice(2) ? s.toLowerCase() : s) };
  } catch {
    return { ok: false, error: 'Checksum mismatch — re-copy the address; one or more characters are wrong.' };
  }
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * A recipient the Send form refuses outright, or null.
 *
 * - The zero address: whatever is sent there is burned.
 * - For a token, any token contract the wallet lists on that network, the
 *   token's own included. transfer() to a token contract succeeds on AZNT,
 *   USDF, USDT and most other tokens, and nothing can move the tokens out
 *   again. The Asset screen's "Copy contract address" sits one tap from Send,
 *   which made pasting it as the recipient the easiest way to lose a balance.
 *
 * A native send to a token contract is left alone: WFMX takes FMX to wrap it,
 * and a contract that cannot take the coin fails the gas estimate.
 */
export function sendRecipientProblem(
  recipient: string,
  token: { address: string; symbol: string } | null,
  tokenContracts: readonly { address: string | null; symbol: string }[],
): string | null {
  const to = recipient.toLowerCase();
  if (to === ZERO_ADDRESS) return 'That is the zero address: anything sent there is burned.';
  if (!token) return null;
  if (to === token.address.toLowerCase()) {
    return `That is the ${token.symbol} contract itself, not an account. Tokens sent to it are lost for good — check the recipient address.`;
  }
  const other = tokenContracts.find((t) => t.address !== null && t.address.toLowerCase() === to);
  if (other) {
    return `That is the ${other.symbol} token contract, not an account. Tokens sent to it are lost for good — check the recipient address.`;
  }
  return null;
}

/**
 * True when `code` (eth_getCode) belongs to an account a person holds: no code,
 * or an EIP-7702 delegation (0xef0100 ‖ address), which is still a keyed account.
 */
export function isPersonalAccountCode(code: string): boolean {
  const c = code.toLowerCase();
  return c === '0x' || (c.startsWith('0xef0100') && c.length === 2 + 46);
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

/** Worst-case fee for a transaction in wei. */
export function txMaxFeeWei(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  return gasLimit * maxFeePerGas;
}

/** Largest value sendable from `balance` after reserving worst-case gas. Never negative. */
export function maxSendableWei(balance: bigint, gasLimit: bigint, maxFeePerGas: bigint): bigint {
  const headroom = txMaxFeeWei(gasLimit, maxFeePerGas);
  return balance > headroom ? balance - headroom : 0n;
}

/**
 * Format base units for display: trims trailing zeros, caps fraction digits.
 * Never rounds *up* (truncates), so a displayed balance is never overstated.
 */
export function formatAmount(wei: bigint, decimals = 18, maxFraction = 6): string {
  const full = formatUnits(wei, decimals);
  const [whole, frac = ''] = full.split('.');
  const trimmed = frac.slice(0, maxFraction).replace(/0+$/, '');
  const wholeGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (trimmed === '') {
    // If we truncated a non-zero fraction to nothing, show it isn't exactly whole.
    const hadMore = frac.replace(/0+$/, '').length > 0;
    return hadMore ? `${wholeGrouped}.000000` : wholeGrouped;
  }
  return `${wholeGrouped}.${trimmed}`;
}

/** Full-precision string (for tooltips / confirm screens). */
export function formatAmountExact(wei: bigint, decimals = 18): string {
  return formatUnits(wei, decimals);
}

/**
 * Format a wei-per-gas price in gwei with 2 decimals. A non-zero price under
 * 0.01 gwei (Ferminux's base fee is a few wei) reads "<0.01", not "0".
 */
export function formatGwei(weiPerGas: bigint): string {
  if (weiPerGas > 0n && weiPerGas < 10_000_000n) return '<0.01';
  const gwei = formatUnits(weiPerGas, 9);
  const [w, f = ''] = gwei.split('.');
  const frac = f.slice(0, 2).replace(/0+$/, '');
  return frac ? `${w}.${frac}` : w;
}

export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}
