// First look at every request, before anything is shown: answer what can be
// answered without the user (an already-approved site asking for accounts),
// refuse what must be refused (unknown chain, unapproved site or account,
// malformed params), and pass the rest to a review screen with its params
// parsed. Pure: the Node tests drive it directly.

import { ERR, ProviderRpcError } from '../../../shared/fxwallet/errors.ts';
import { FERMINUX_CHAIN_ID, chainName, isKnownChain } from '../../../shared/fxwallet/chains.ts';
import { POPUP_METHODS, REVOKE_METHOD } from '../../../shared/fxwallet/protocol.ts';
import {
  parsePersonalSign,
  parseTxRequest,
  parseTypedDataV4,
  parseWatchAsset,
  type PersonalSignRequest,
  type TxRequest,
  type TypedDataRequest,
  type WatchAssetRequest,
} from './requests.ts';
import { approvedAccounts, findSite, type ConnectedSite } from './sites.ts';

export interface ScreenInput {
  origin: string;
  method: string;
  params: unknown;
  chainId: number;
}

export type Screened =
  | { action: 'reply'; result: unknown }
  /** The site disconnected itself: remove its approval (its verified origin only), answer null. */
  | { action: 'revoke' }
  | { action: 'error'; error: ProviderRpcError }
  | { action: 'review'; kind: 'connect' }
  | { action: 'review'; kind: 'sign'; request: PersonalSignRequest }
  | { action: 'review'; kind: 'typed'; request: TypedDataRequest }
  | { action: 'review'; kind: 'tx'; request: TxRequest }
  | { action: 'review'; kind: 'watch'; request: WatchAssetRequest };

export type ReviewKind = Extract<Screened, { action: 'review' }>['kind'];

const fail = (code: number, message: string): Screened => ({ action: 'error', error: new ProviderRpcError(code, message) });

/**
 * @param sites     the approved-sites list
 * @param available addresses this device can sign for (the vault's accounts)
 */
export function screenRequest(req: ScreenInput, sites: ConnectedSite[], available: string[]): Screened {
  // A dApp's "Disconnect" (sent through this window when its status frame
  // cannot reach this storage). It can only ever remove the requester's own
  // approval, so it needs no confirmation, no key and no known chain.
  if (req.method === REVOKE_METHOD) return { action: 'revoke' };
  if (!POPUP_METHODS.has(req.method)) return fail(ERR.UNSUPPORTED_METHOD, `Ferminux Wallet does not support ${req.method}.`);
  if (!isKnownChain(req.chainId)) {
    return fail(ERR.CHAIN_DISCONNECTED, `Ferminux Wallet does not sign for chain ${req.chainId}.`);
  }
  const allowed = approvedAccounts(findSite(sites, req.origin), available);
  const isAllowed = (address: string) => allowed.some((a) => a.toLowerCase() === address.toLowerCase());

  if (req.method === 'eth_requestAccounts') {
    // Already approved: answer at once, like any wallet does for a known site.
    return allowed.length > 0 ? { action: 'reply', result: allowed } : { action: 'review', kind: 'connect' };
  }
  if (allowed.length === 0) return fail(ERR.UNAUTHORIZED, 'This site is not connected to Ferminux Wallet. Connect it first.');

  try {
    switch (req.method) {
      case 'personal_sign': {
        const request = parsePersonalSign(req.params);
        if (!isAllowed(request.address)) return fail(ERR.UNAUTHORIZED, 'That account is not connected to this site.');
        return { action: 'review', kind: 'sign', request };
      }
      case 'eth_signTypedData_v4': {
        const request = parseTypedDataV4(req.params);
        if (!isAllowed(request.address)) return fail(ERR.UNAUTHORIZED, 'That account is not connected to this site.');
        // A signature for another chain could be replayed there: refuse it.
        if (request.domainChainId !== null && request.domainChainId !== req.chainId) {
          return fail(
            ERR.INVALID_PARAMS,
            `The typed data is for chain ${request.domainChainId}, but the site is on ${chainName(req.chainId)} (${req.chainId}).`,
          );
        }
        return { action: 'review', kind: 'typed', request };
      }
      case 'eth_sendTransaction': {
        const request = parseTxRequest(req.params);
        if (!isAllowed(request.from)) return fail(ERR.UNAUTHORIZED, 'That account is not connected to this site.');
        if (request.chainId !== null && request.chainId !== req.chainId) {
          return fail(ERR.INVALID_PARAMS, `The transaction names chain ${request.chainId}, but the site is on ${req.chainId}.`);
        }
        return { action: 'review', kind: 'tx', request };
      }
      case 'wallet_watchAsset': {
        const request = parseWatchAsset(req.params);
        if (req.chainId !== FERMINUX_CHAIN_ID) {
          return fail(ERR.INVALID_PARAMS, 'Ferminux Wallet tracks tokens on Ferminux Network (3961) only. Switch the site to 3961 first.');
        }
        return { action: 'review', kind: 'watch', request };
      }
      default:
        return fail(ERR.UNSUPPORTED_METHOD, `Ferminux Wallet does not support ${req.method}.`);
    }
  } catch (e) {
    if (e instanceof ProviderRpcError) return { action: 'error', error: e };
    return fail(ERR.INVALID_PARAMS, (e as Error)?.message ?? 'Invalid request.');
  }
}

/** Reviews that sign with a key, so the vault must be unlocked first. */
export function needsKey(kind: ReviewKind): boolean {
  return kind !== 'watch';
}

/**
 * EIP-2612 / Permit2 / DAI-style permit primary types: a signature on one is a
 * gasless, off-chain token approval — the modern drainer's tool, since it costs
 * the victim no gas and produces no on-chain transaction to review.
 */
export const PERMIT_TYPES: ReadonlySet<string> = new Set([
  'Permit',
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
  'PermitBatchWitnessTransferFrom',
]);

/**
 * The warning to show for a typed-data request that is a token permit, else
 * null. The WalletConnect path (reviewRequest) flags these too; the connect
 * window must not be the softer door.
 */
export function permitWarning(request: TypedDataRequest): string | null {
  const name = typeof request.domain.name === 'string' ? request.domain.name : '';
  if (!PERMIT_TYPES.has(request.primaryType) && !/permit2/i.test(name)) return null;
  return 'This is a token permit: signing it lets the named spender move your tokens later, with no further confirmation and no transaction you would see. Check the spender, amount and deadline, and reject it unless you started this.';
}

/**
 * Sign-In with Ethereum (EIP-4361) messages begin "<domain> wants you to sign
 * in…". A sign-in naming a different domain than the requesting site is the
 * classic phishing relay; returns the named domain when it does not match.
 */
export function siweDomainMismatch(text: string | null, origin: string): string | null {
  if (!text) return null;
  // EIP-4361 allows an optional scheme before the domain ("https://example.com wants you…").
  const m = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your /.exec(text);
  if (!m) return null;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return m[1]!;
  }
  return m[1]!.toLowerCase() === host.toLowerCase() ? null : m[1]!;
}
