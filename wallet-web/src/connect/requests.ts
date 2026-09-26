// Turning a dApp's request params into something the connect window can show
// and sign — strictly. Every function throws a ProviderRpcError(-32602) with a
// sentence a developer can act on, and never passes anything through that it
// did not check. No browser globals: the Node tests import this file directly.

import { getAddress, getBytes, hexlify, isHexString, toUtf8Bytes, toUtf8String, TypedDataEncoder, type TypedDataField } from 'ethers';
import { ERR, ProviderRpcError } from '../../../shared/fxwallet/errors.ts';
import { parseChainId } from '../../../shared/fxwallet/chains.ts';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function invalid(message: string): ProviderRpcError {
  return new ProviderRpcError(ERR.INVALID_PARAMS, message);
}

function isAddress(v: unknown): v is string {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

function checksum(v: string): string {
  // A mixed-case address with a wrong checksum is a typo, not an address.
  try {
    return getAddress(v);
  } catch {
    throw invalid(`${v} has an invalid checksum.`);
  }
}

/* ------------------------------------------------------------------ */
/* personal_sign                                                       */
/* ------------------------------------------------------------------ */

export interface PersonalSignRequest {
  address: string;
  /** Exactly the bytes that get signed (EIP-191 prefix added at signing). */
  bytes: Uint8Array;
  hex: string;
  /** The message as text when it is printable UTF-8, else null (shown as hex). */
  text: string | null;
}

/** Printable UTF-8, or null. Control characters other than tab/newline mean "show hex". */
export function printableText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return '';
  let text: string;
  try {
    text = toUtf8String(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(text)) return null;
  return text;
}

export function parsePersonalSign(params: unknown): PersonalSignRequest {
  const p = Array.isArray(params) ? params : [];
  // The standard order is [message, address]; a few libraries send
  // [address, message]. Only swap when exactly one of the two is an address.
  let [data, address] = p;
  if (isAddress(data) && !isAddress(address)) [data, address] = [address, data];
  if (!isAddress(address)) throw invalid('personal_sign takes [message, address].');
  if (typeof data !== 'string') throw invalid('personal_sign: the message must be a string (hex or text).');
  const bytes = isHexString(data) && data.length % 2 === 0 ? getBytes(data) : toUtf8Bytes(data);
  if (bytes.length > 64 * 1024) throw invalid('personal_sign: the message is larger than 64 KiB.');
  return { address: checksum(address), bytes, hex: hexlify(bytes), text: printableText(bytes) };
}

/* ------------------------------------------------------------------ */
/* eth_signTypedData_v4                                                */
/* ------------------------------------------------------------------ */

export interface TypedDataRequest {
  address: string;
  domain: Record<string, unknown>;
  /** Without EIP712Domain — the shape ethers signs with. */
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
  /** domain.chainId, when the domain names one. */
  domainChainId: number | null;
}

export function parseTypedDataV4(params: unknown): TypedDataRequest {
  const p = Array.isArray(params) ? params : [];
  const [address, raw] = p;
  if (!isAddress(address)) throw invalid('eth_signTypedData_v4 takes [address, typedData].');
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw invalid('eth_signTypedData_v4: typedData is not valid JSON.');
    }
  }
  const o = obj as { types?: unknown; primaryType?: unknown; domain?: unknown; message?: unknown } | null;
  if (!o || typeof o !== 'object') throw invalid('eth_signTypedData_v4: typedData must be an object.');
  if (!o.types || typeof o.types !== 'object') throw invalid('eth_signTypedData_v4: missing types.');
  if (typeof o.primaryType !== 'string' || o.primaryType === 'EIP712Domain') throw invalid('eth_signTypedData_v4: missing primaryType.');
  if (!o.domain || typeof o.domain !== 'object') throw invalid('eth_signTypedData_v4: missing domain.');
  if (!o.message || typeof o.message !== 'object') throw invalid('eth_signTypedData_v4: missing message.');

  const types: Record<string, TypedDataField[]> = {};
  for (const [name, fields] of Object.entries(o.types as Record<string, unknown>)) {
    if (name === 'EIP712Domain') continue;
    if (!Array.isArray(fields)) throw invalid(`eth_signTypedData_v4: type ${name} is not a field list.`);
    types[name] = fields.map((f) => {
      const field = f as { name?: unknown; type?: unknown };
      if (typeof field?.name !== 'string' || typeof field?.type !== 'string') throw invalid(`eth_signTypedData_v4: bad field in ${name}.`);
      return { name: field.name, type: field.type };
    });
  }
  if (!types[o.primaryType]) throw invalid(`eth_signTypedData_v4: primaryType ${o.primaryType} is not in types.`);
  // Only the primary type's own graph is signed. Extra entries in `types` are
  // legal in v4 but ethers refuses unused types, so keep just what is reachable.
  const seen = new Set<string>();
  const walk = (t: string) => {
    const base = t.replace(/(\[\d*\])+$/, '');
    if (!types[base] || seen.has(base)) return;
    seen.add(base);
    for (const f of types[base]!) walk(f.type);
  };
  walk(o.primaryType);
  const reachable: Record<string, TypedDataField[]> = {};
  for (const t of seen) reachable[t] = types[t]!;
  const domain = { ...(o.domain as Record<string, unknown>) };
  const message = o.message as Record<string, unknown>;
  // Let the encoder check the whole structure now, so a malformed request is
  // refused before the user is asked to look at it.
  try {
    TypedDataEncoder.hash(domain as never, reachable, message);
  } catch (e) {
    throw invalid(`eth_signTypedData_v4: ${(e as Error).message?.split(' (')[0] ?? 'invalid typed data'}`);
  }
  const domainChainId = domain.chainId === undefined ? null : parseChainId(typeof domain.chainId === 'bigint' ? Number(domain.chainId) : domain.chainId);
  // A chainId the wallet cannot read must not pass as "no chain named": the
  // cross-chain check and the Chain row both key off domainChainId.
  if (domain.chainId !== undefined && domainChainId === null) throw invalid('eth_signTypedData_v4: domain.chainId is not a valid chain id.');
  return { address: checksum(address), domain, types: reachable, primaryType: o.primaryType, message, domainChainId };
}

/* ------------------------------------------------------------------ */
/* eth_sendTransaction                                                 */
/* ------------------------------------------------------------------ */

export interface TxRequest {
  from: string;
  /** null = contract creation. */
  to: string | null;
  value: bigint;
  data: string;
  /** Gas limit the dApp suggested, if any. */
  gas: bigint | null;
  /** chainId named inside the transaction, if any. */
  chainId: number | null;
}

/** A JSON-RPC quantity: 0x-hex, or (leniently) a decimal string or safe integer. */
export function parseQuantity(v: unknown, what: string): bigint | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw invalid(`${what} must be a non-negative integer.`);
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (s === '0x') return 0n;
    if (/^\d+$/.test(s)) return BigInt(s);
  }
  throw invalid(`${what} must be a hex quantity like "0x1".`);
}

export function parseTxRequest(params: unknown): TxRequest {
  const p = Array.isArray(params) ? params : [];
  const tx = p[0] as Record<string, unknown> | undefined;
  if (!tx || typeof tx !== 'object') throw invalid('eth_sendTransaction takes [transaction].');
  if (!isAddress(tx.from)) throw invalid('eth_sendTransaction: from must be an address.');
  let to: string | null = null;
  if (tx.to !== undefined && tx.to !== null && tx.to !== '') {
    if (!isAddress(tx.to)) throw invalid('eth_sendTransaction: to must be an address.');
    to = checksum(tx.to);
  }
  const value = parseQuantity(tx.value, 'value') ?? 0n;
  const rawData = tx.data ?? tx.input ?? '0x';
  if (typeof rawData !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(rawData)) throw invalid('eth_sendTransaction: data must be 0x-prefixed hex bytes.');
  const data = rawData.toLowerCase();
  if (to === null && data === '0x') throw invalid('eth_sendTransaction: a transaction with no recipient must carry contract code.');
  const gas = parseQuantity(tx.gas ?? tx.gasLimit, 'gas');
  if (gas !== null && (gas < 21000n || gas > 30_000_000n)) throw invalid('eth_sendTransaction: gas must be between 21000 and 30000000.');
  let chainId: number | null = null;
  if (tx.chainId !== undefined && tx.chainId !== null) {
    chainId = parseChainId(tx.chainId);
    if (chainId === null) throw invalid('eth_sendTransaction: chainId is not a valid chain id.');
  }
  return { from: checksum(tx.from), to, value, data, gas, chainId };
}

/* ------------------------------------------------------------------ */
/* wallet_watchAsset (EIP-747)                                         */
/* ------------------------------------------------------------------ */

export interface WatchAssetRequest {
  address: string;
  symbol: string;
  decimals: number;
}

export function parseWatchAsset(params: unknown): WatchAssetRequest {
  const p = (Array.isArray(params) ? params[0] : params) as { type?: unknown; options?: Record<string, unknown> } | undefined;
  // "ERC20" is the EIP-747 wire value; on Ferminux the standard is FRC-20.
  if (!p || p.type !== 'ERC20') throw invalid('wallet_watchAsset: only FRC-20 tokens (type "ERC20") can be added.');
  const o = p.options ?? {};
  if (!isAddress(o.address)) throw invalid('wallet_watchAsset: options.address must be a token address.');
  const symbol = typeof o.symbol === 'string' ? o.symbol.trim() : '';
  if (symbol === '' || symbol.length > 11) throw invalid('wallet_watchAsset: options.symbol must be 1 to 11 characters.');
  const decimals = typeof o.decimals === 'number' ? o.decimals : typeof o.decimals === 'string' ? Number(o.decimals) : NaN;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw invalid('wallet_watchAsset: options.decimals must be an integer from 0 to 36.');
  return { address: checksum(o.address), symbol, decimals };
}
