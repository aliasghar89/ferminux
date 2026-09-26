// Input validation + fee helpers. Pure functions, no browser globals.
// checkAmount / checkAddress follow wallet-web's semantics exactly.

import { getAddress, parseUnits, formatUnits } from 'ethers';

export type AddressCheck = { ok: true; address: string } | { ok: false; error: string };

/** Validate an address with EIP-55 checksum enforcement. */
export function checkAddress(input: string): AddressCheck {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Address is required.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return { ok: false, error: 'An address is 0x followed by 40 hex characters.' };
  }
  try {
    return {
      ok: true,
      address: getAddress(
        s.toLowerCase() === s || s.slice(2).toUpperCase() === s.slice(2) ? s.toLowerCase() : s,
      ),
    };
  } catch {
    return { ok: false, error: 'Checksum mismatch — re-copy the address; one or more characters are wrong.' };
  }
}

export type AmountCheck = { ok: true; wei: bigint } | { ok: false; error: string };

/** Parse a decimal FMX amount string into wei, strictly. */
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
    return { ok: false, error: `Too precise — FMX has ${decimals} decimal places.` };
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

/** Format a wei-per-gas price in gwei with 2 decimals. */
export function formatGwei(weiPerGas: bigint): string {
  const gwei = formatUnits(weiPerGas, 9);
  const [w, f = ''] = gwei.split('.');
  const frac = f.slice(0, 2).replace(/0+$/, '');
  return frac ? `${w}.${frac}` : w;
}
