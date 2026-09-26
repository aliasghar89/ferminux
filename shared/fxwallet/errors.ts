// EIP-1193 / EIP-1474 error codes, and the error class the provider throws.
// Pure module: no browser globals.

export const ERR = {
  /** EIP-1193: the user rejected the request. */
  USER_REJECTED: 4001,
  /** EIP-1193: the method or account has not been authorised by the user. */
  UNAUTHORIZED: 4100,
  /** EIP-1193: the provider does not support the method. */
  UNSUPPORTED_METHOD: 4200,
  /** EIP-1193: the provider is disconnected from all chains. */
  DISCONNECTED: 4900,
  /** EIP-1193: the provider is not connected to the requested chain. */
  CHAIN_DISCONNECTED: 4901,
  /** EIP-3326: the chain has not been added to the wallet. */
  UNRECOGNIZED_CHAIN: 4902,
  /** EIP-1474 */
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** EIP-1474: a request of this kind is already pending. */
  RESOURCE_UNAVAILABLE: -32002,
} as const;

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class ProviderRpcError extends Error implements RpcErrorShape {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProviderRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** Serialise any thrown value into the {code, message, data} that crosses postMessage. */
export function toRpcError(e: unknown, fallbackCode: number = ERR.INTERNAL): RpcErrorShape {
  const err = e as { code?: unknown; message?: unknown; data?: unknown } | null;
  const code = typeof err?.code === 'number' && Number.isInteger(err.code) ? err.code : fallbackCode;
  const message = typeof err?.message === 'string' && err.message !== '' ? err.message : 'Internal error';
  const out: RpcErrorShape = { code, message: message.slice(0, 500) };
  if (err?.data !== undefined) {
    // Only plain JSON crosses the boundary; revert data is a hex string.
    try {
      out.data = JSON.parse(JSON.stringify(err.data));
    } catch {
      /* drop what cannot be cloned */
    }
  }
  return out;
}

/** Rebuild a ProviderRpcError from its wire form, refusing anything malformed. */
export function fromRpcError(shape: unknown): ProviderRpcError {
  const s = shape as Partial<RpcErrorShape> | null;
  const code = typeof s?.code === 'number' && Number.isInteger(s.code) ? s.code : ERR.INTERNAL;
  const message = typeof s?.message === 'string' ? s.message.slice(0, 500) : 'The wallet returned an error.';
  return new ProviderRpcError(code, message, s?.data);
}
