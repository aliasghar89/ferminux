// QR payload parsing + raw-image decoding.
//
// Pure module: no browser globals (no window/document/navigator), no network.
// The exact same code runs in the UI, in the Node unit tests and in the
// live-chain check script. The camera plumbing lives in the view layer.

import jsQRModule from 'jsqr';
import { getAddress } from 'ethers';
import { CHAIN_ID } from '../config.ts';

// jsqr ships a UMD bundle: `module.exports` is the function AND carries a
// `.default`. Normalise so both the Vite interop and Node's CJS interop work.
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ??
  jsQRModule) as typeof jsQRModule;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type QrTarget =
  | {
      kind: 'address';
      /** EIP-55 checksummed recipient. */
      address: string;
      /** Native FMX amount in wei, when the code carried one. */
      amount?: bigint;
      /** Chain id the code declared, when it declared one. */
      chainId?: number;
    }
  | {
      kind: 'erc20-transfer';
      /** EIP-55 checksummed recipient (the `address` argument). */
      address: string;
      /** EIP-55 checksummed ERC-20 contract (the EIP-681 target). */
      tokenAddress: string;
      /** Token amount in the token's own base units (the `uint256` argument). */
      amount?: bigint;
      chainId?: number;
    };

export type QrErrorCode =
  | 'empty'
  | 'unsupported-scheme'
  | 'unsupported-function'
  | 'bad-address'
  | 'wrong-chain'
  | 'bad-amount'
  | 'malformed';

export type QrParse = { ok: true; target: QrTarget } | { ok: false; code: QrErrorCode; error: string };

/** Chains a user is plausibly holding a QR code from — named so the error can say what went wrong. */
const KNOWN_CHAINS: Record<number, string> = {
  1: 'Ethereum mainnet',
  10: 'OP Mainnet',
  56: 'BNB Smart Chain',
  100: 'Gnosis',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche C-Chain',
  11155111: 'Sepolia testnet',
};

function chainLabel(id: number): string {
  const name = KNOWN_CHAINS[id];
  return name ? `${name} (chain ${id})` : `chain ${id}`;
}

function fail(code: QrErrorCode, error: string): QrParse {
  return { ok: false, code, error };
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * EIP-55 validation with the same semantics as the Send form: an
 * all-lowercase or all-uppercase address carries no checksum information and
 * is accepted (and normalised); a mixed-case address must checksum.
 */
export function checksumAddress(input: string): string | null {
  const s = input.trim();
  if (!ADDRESS_RE.test(s)) return null;
  const body = s.slice(2);
  const noChecksumInfo = body === body.toLowerCase() || body === body.toUpperCase();
  try {
    return getAddress(noChecksumInfo ? s.toLowerCase() : s);
  } catch {
    return null;
  }
}

/**
 * EIP-681 `Number`: `[0-9]+ ["." [0-9]+] [ ("e"|"E") [0-9]+ ]`, denominated in
 * the smallest unit (wei for `value`, base units for `uint256`). Scientific
 * notation is the common encoding — `2.014e18` must come back as exactly
 * 2014000000000000000 wei, so this is done in integer arithmetic, never floats.
 *
 * Returns null for anything that is not a whole number of base units.
 */
export function parseEip681Number(raw: string): bigint | null {
  const s = raw.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]\+?(\d+))?$/.exec(s);
  if (!m) return null;
  const whole = m[1];
  const frac = m[2] ?? '';
  const exp = m[3] !== undefined ? Number(m[3]) : 0;
  if (!Number.isSafeInteger(exp) || exp > 1000) return null;
  const shift = exp - frac.length;
  // A negative shift means the code asked for a fraction of a base unit, which
  // is not representable — reject rather than silently truncating value.
  if (shift < 0) return null;
  const digits = whole + frac;
  return BigInt(digits) * 10n ** BigInt(shift);
}

function parseChainId(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  let n: number;
  if (/^0x[0-9a-fA-F]+$/.test(s)) n = Number(BigInt(s));
  else if (/^\d+$/.test(s)) n = Number(s);
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/* ------------------------------------------------------------------ *
 * Payload parsing
 * ------------------------------------------------------------------ */

/**
 * Parse whatever a QR code decoded to into something the Send form can use.
 *
 * Accepted:
 *   0xABC…                                        plain address
 *   ethereum:0xABC…                               EIP-681, no chain constraint
 *   ethereum:pay-0xABC…@3961                      EIP-681 with the `pay-` prefix
 *   ethereum:0xABC…@3961?value=1e18&gas=21000     native value in wei
 *   ethereum:0xTOKEN@3961/transfer?address=0xABC…&uint256=1000000
 *
 * Everything else is rejected with an explanation the user can act on.
 */
export function parseQrPayload(raw: string, expectedChainId: number = CHAIN_ID): QrParse {
  const input = (raw ?? '').trim();
  if (input === '') {
    return fail('empty', 'The code is empty — nothing to read.');
  }

  // Plain address (the most common QR in the wild).
  if (ADDRESS_RE.test(input)) {
    const address = checksumAddress(input);
    if (!address) {
      return fail(
        'bad-address',
        'Checksum mismatch — that address is not valid. Ask the sender to re-generate the code.',
      );
    }
    return { ok: true, target: { kind: 'address', address } };
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
  if (!schemeMatch) {
    return fail(
      'malformed',
      'Not a wallet address or payment request. Expected 0x… or an ethereum: payment URI.',
    );
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'ethereum') {
    return fail(
      'unsupported-scheme',
      `That is a "${scheme}:" code, not an Ethereum-style payment request. Ferminux can only pay ethereum: URIs and 0x… addresses.`,
    );
  }

  const body = input.slice(schemeMatch[0].length);
  if (body === '') {
    return fail('malformed', 'The ethereum: code carries no address.');
  }

  const qIndex = body.indexOf('?');
  let path = qIndex === -1 ? body : body.slice(0, qIndex);
  const query = qIndex === -1 ? '' : body.slice(qIndex + 1);

  if (/^pay-/i.test(path)) path = path.slice(4);

  const slashParts = path.split('/');
  if (slashParts.length > 2) {
    return fail('malformed', 'Malformed ethereum: URI — too many path segments.');
  }
  const functionName = slashParts.length === 2 ? slashParts[1].trim() : null;

  const atParts = slashParts[0].split('@');
  if (atParts.length > 2) {
    return fail('malformed', 'Malformed ethereum: URI — the chain id is written more than once.');
  }

  const target = checksumAddress(atParts[0]);
  if (!target) {
    return fail(
      'bad-address',
      ADDRESS_RE.test(atParts[0].trim())
        ? 'Checksum mismatch — the address in that code is not valid.'
        : 'The code does not contain a valid 0x address (0x followed by 40 hex characters).',
    );
  }

  let chainId: number | undefined;
  if (atParts.length === 2) {
    const parsed = parseChainId(atParts[1]);
    if (parsed === null) {
      return fail('malformed', 'Malformed ethereum: URI — the chain id is not a number.');
    }
    if (parsed !== expectedChainId) {
      return fail(
        'wrong-chain',
        `That code is for ${chainLabel(parsed)}. This wallet only sends on the Ferminux Network (chain ${expectedChainId}) — paying it here would send funds to a different network's address.`,
      );
    }
    chainId = parsed;
  }

  const params = new URLSearchParams(query);

  if (functionName === null || functionName === '') {
    let amount: bigint | undefined;
    const value = params.get('value');
    if (value !== null && value.trim() !== '') {
      const wei = parseEip681Number(value);
      if (wei === null) {
        return fail(
          'bad-amount',
          `The requested amount ("${value}") is not a whole number of wei. Enter the amount by hand.`,
        );
      }
      amount = wei;
    }
    return { ok: true, target: { kind: 'address', address: target, ...(amount !== undefined ? { amount } : {}), ...(chainId !== undefined ? { chainId } : {}) } };
  }

  if (functionName.toLowerCase() !== 'transfer') {
    return fail(
      'unsupported-function',
      `That code asks the wallet to call "${functionName}()". Only plain payments and ERC-20 transfer() requests are supported.`,
    );
  }

  const recipientRaw = params.get('address');
  if (recipientRaw === null || recipientRaw.trim() === '') {
    return fail('malformed', 'That ERC-20 transfer code is missing its "address" (recipient) parameter.');
  }
  const recipient = checksumAddress(recipientRaw);
  if (!recipient) {
    return fail('bad-address', 'The recipient address inside that ERC-20 transfer code is not valid.');
  }

  let amount: bigint | undefined;
  const uint256 = params.get('uint256');
  if (uint256 !== null && uint256.trim() !== '') {
    const parsed = parseEip681Number(uint256);
    if (parsed === null) {
      return fail(
        'bad-amount',
        `The requested token amount ("${uint256}") is not a whole number of base units. Enter the amount by hand.`,
      );
    }
    amount = parsed;
  }

  return {
    ok: true,
    target: {
      kind: 'erc20-transfer',
      address: recipient,
      tokenAddress: target,
      ...(amount !== undefined ? { amount } : {}),
      ...(chainId !== undefined ? { chainId } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Building (the receive side)
 * ------------------------------------------------------------------ */

/**
 * Build the EIP-681 URI the Receive QR encodes, so a scan between two Ferminux
 * wallets carries the chain id (and optionally the requested amount) instead of
 * a bare address that could be pasted on any EVM chain.
 */
export function buildEip681Uri(
  address: string,
  opts?: { chainId?: number; amountWei?: bigint },
): string {
  const checksummed = checksumAddress(address) ?? address;
  const chainId = opts?.chainId ?? CHAIN_ID;
  let uri = `ethereum:${checksummed}@${chainId}`;
  if (opts?.amountWei !== undefined && opts.amountWei > 0n) {
    uri += `?value=${opts.amountWei.toString()}`;
  }
  return uri;
}

/* ------------------------------------------------------------------ *
 * Image decoding
 * ------------------------------------------------------------------ */

export interface QrDecodeOptions {
  /** Inversion strategy. Live frames use 'dontInvert' (fast); stills try both. */
  inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
}

/**
 * Decode RGBA pixels to the QR's text payload, or null when no code is present.
 * Takes raw pixel data so it is testable without a DOM: the caller supplies
 * ImageData from a canvas (live camera frame or an uploaded picture).
 */
export function decodeQrImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: QrDecodeOptions,
): string | null {
  if (width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;
  try {
    const result = jsQR(data, width, height, {
      inversionAttempts: opts?.inversionAttempts ?? 'dontInvert',
    });
    return result && typeof result.data === 'string' && result.data !== '' ? result.data : null;
  } catch {
    // jsQR can throw on pathological input; a failed decode is not an error
    // condition for the caller — it just means "no code in this frame".
    return null;
  }
}
