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

/** Format a wei-per-gas price in gwei with 2 decimals. */
export function formatGwei(weiPerGas: bigint): string {
  const gwei = formatUnits(weiPerGas, 9);
  const [w, f = ''] = gwei.split('.');
  const frac = f.slice(0, 2).replace(/0+$/, '');
  return frac ? `${w}.${frac}` : w;
}

export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}
