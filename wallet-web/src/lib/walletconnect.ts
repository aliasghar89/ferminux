// WalletConnect v2, wallet side: the decisions, not the transport.
// Pure: no browser globals, no WalletConnect SDK import — every function here
// takes plain objects shaped like the SDK's events, so the unit tests drive it
// with mocks (the relay cannot be reached without a project id).
//
// What lives here:
//   • parseWcUri       — is this a pairing code we can use?
//   • reviewProposal   — what a dApp asks for, whether we can grant it, and the
//                        exact namespaces to approve (active account only,
//                        supported chains only)
//   • reviewRequest    — decode one request into what the confirm modal shows,
//                        plus the reasons it must be refused outright
//   • signForRequest   — produce the signature for an approved signing request
//
// Nothing here signs without being called from an explicit user approval, and
// nothing here ever logs a key or a message.

import {
  Interface,
  TypedDataEncoder,
  Wallet,
  getAddress,
  getBytes,
  hexlify,
  isHexString,
  toUtf8Bytes,
  toUtf8String,
} from 'ethers';
import { CHAINS, caip2, parseCaip2, type ChainDef } from './chains.ts';
import { INVISIBLE_RE, UNREADABLE_RE } from './text.ts';

/** Requests this wallet can service. */
export const WC_METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
] as const;
export const WC_EVENTS = ['chainChanged', 'accountsChanged'] as const;

/** WalletConnect SDK error codes (the values @walletconnect/utils getSdkError returns). */
export const SDK_ERRORS = {
  USER_REJECTED: { code: 5000, message: 'User rejected.' },
  UNSUPPORTED_CHAINS: { code: 5100, message: 'Unsupported chains.' },
  UNSUPPORTED_METHODS: { code: 5101, message: 'Unsupported methods.' },
  UNSUPPORTED_ACCOUNTS: { code: 5103, message: 'Unsupported accounts.' },
  UNSUPPORTED_NAMESPACE_KEY: { code: 5104, message: 'Unsupported namespace key.' },
  USER_DISCONNECTED: { code: 6000, message: 'User disconnected.' },
} as const;

export interface RpcError {
  code: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Shapes (the subset of the SDK's types this module reads)            */
/* ------------------------------------------------------------------ */

export interface DappMetadata {
  name?: string;
  description?: string;
  url?: string;
  icons?: string[];
}

export interface VerifyContextLike {
  verified?: { origin?: string; validation?: string; isScam?: boolean | null };
}

export interface NamespaceRequest {
  chains?: string[];
  methods?: string[];
  events?: string[];
}

export interface ProposalLike {
  id: number;
  params: {
    expiryTimestamp?: number;
    proposer: { metadata: DappMetadata };
    requiredNamespaces?: Record<string, NamespaceRequest>;
    optionalNamespaces?: Record<string, NamespaceRequest>;
  };
  verifyContext?: VerifyContextLike;
}

export interface SessionNamespace {
  chains?: string[];
  accounts: string[];
  methods: string[];
  events: string[];
}

export interface SessionLike {
  topic: string;
  expiry?: number;
  peer: { metadata: DappMetadata };
  namespaces: Record<string, SessionNamespace>;
}

export interface RequestEventLike {
  id: number;
  topic: string;
  params: { request: { method: string; params?: unknown; expiryTimestamp?: number }; chainId: string };
  verifyContext?: VerifyContextLike;
}

/* ------------------------------------------------------------------ */
/* Pairing URI                                                         */
/* ------------------------------------------------------------------ */

export type WcUriCheck = { ok: true; uri: string; topic: string } | { ok: false; error: string };

/**
 * Accept a WalletConnect v2 pairing code: `wc:<topic>@2?relay-protocol=irn&symKey=<key>…`.
 * A link that wraps one (`…?uri=wc%3A…`, as some dApps show) is unwrapped.
 */
export function parseWcUri(input: string): WcUriCheck {
  let s = (input ?? '').trim();
  if (s === '') return { ok: false, error: 'Paste the WalletConnect code the site shows (it starts with wc:).' };
  if (!/^wc:/i.test(s)) {
    const wrapped = /[?&]uri=([^&#]+)/.exec(s);
    if (wrapped) {
      try {
        s = decodeURIComponent(wrapped[1]).trim();
      } catch {
        /* fall through to the error below */
      }
    }
  }
  if (!/^wc:/i.test(s)) {
    return { ok: false, error: 'That is not a WalletConnect code. It should start with "wc:" — use the site’s WalletConnect option and copy its code.' };
  }
  const m = /^wc:([^@?]+)@(\d+)\??(.*)$/i.exec(s);
  if (!m) return { ok: false, error: 'That WalletConnect code is incomplete. Copy it again from the site.' };
  const [, topic, version, query] = m;
  if (version === '1') {
    return { ok: false, error: 'That is an old WalletConnect v1 code, and v1 no longer works. Reload the site and connect again to get a new code.' };
  }
  if (version !== '2') return { ok: false, error: `Unsupported WalletConnect version (${version}).` };
  if (!/^[0-9a-f]{64}$/i.test(topic)) return { ok: false, error: 'That WalletConnect code is damaged (bad topic). Copy it again.' };
  const params = new URLSearchParams(query);
  const symKey = params.get('symKey');
  if (!symKey || !/^[0-9a-f]{64}$/i.test(symKey)) {
    return { ok: false, error: 'That WalletConnect code is damaged (missing key). Copy it again.' };
  }
  const expiry = Number(params.get('expiryTimestamp'));
  if (Number.isFinite(expiry) && expiry > 0 && expiry * 1000 < Date.now()) {
    return { ok: false, error: 'That WalletConnect code has expired. Ask the site for a new one.' };
  }
  return { ok: true, uri: s, topic: topic.toLowerCase() };
}

/* ------------------------------------------------------------------ */
/* dApp identity                                                       */
/* ------------------------------------------------------------------ */

export interface DappInfo {
  name: string;
  url: string;
  host: string;
  icon: string | null;
  description: string;
}

function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .replace(INVISIBLE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** The dApp as it describes ITSELF — shown, but never trusted on its own. */
export function dappInfo(meta: DappMetadata | undefined): DappInfo {
  const url = clean(meta?.url, 200);
  const icon = (meta?.icons ?? []).find((i) => typeof i === 'string' && /^https:\/\//i.test(i.trim())) ?? null;
  return {
    name: clean(meta?.name, 60) || 'Unnamed site',
    url,
    host: hostOf(url),
    icon: icon ? icon.trim() : null,
    description: clean(meta?.description, 200),
  };
}

export interface VerifyView {
  /**
   * The origin WalletConnect's Verify service saw the request come from, or ''
   * when Verify could not tell (the modal then says "an unknown origin").
   */
  origin: string;
  status: 'valid' | 'unknown' | 'invalid' | 'scam';
  /** The verified origin does not match the URL the site claims. */
  mismatch: boolean;
}

export function verifyView(ctx: VerifyContextLike | undefined, dapp: DappInfo): VerifyView {
  const v = ctx?.verified;
  // When Verify has no answer the SDK still fills `origin` — with the URL the
  // site claims for itself (validation UNKNOWN). Shown as "Request from …"
  // next to that claim it would read as a checked origin, so only an origin
  // Verify actually resolved (VALID, INVALID, or a scam verdict) is kept.
  const resolved = v?.validation === 'VALID' || v?.validation === 'INVALID' || !!v?.isScam;
  const origin = clean(v?.origin, 200);
  const originHost = hostOf(origin);
  const mismatch = originHost !== '' && dapp.host !== '' && originHost !== dapp.host;
  let status: VerifyView['status'] = 'unknown';
  if (v?.isScam) status = 'scam';
  else if (v?.validation === 'INVALID' || mismatch) status = 'invalid';
  else if (v?.validation === 'VALID') status = 'valid';
  return { origin: resolved || mismatch ? origin : '', status, mismatch };
}

/* ------------------------------------------------------------------ */
/* Session proposal                                                    */
/* ------------------------------------------------------------------ */

export interface RequestedChain {
  caip: string;
  chainId: number | null;
  name: string;
  supported: boolean;
  required: boolean;
}

export interface ProposalReview {
  id: number;
  dapp: DappInfo;
  verify: VerifyView;
  expiresAt: number | null;
  /**
   * The networks to show: every requested one this wallet supports, and every
   * required one (supported or not — those are blockers). Optional networks it
   * does not support are left out and only counted in `otherChains`: large
   * dApps list twenty or more, and none of them is shared.
   */
  chains: RequestedChain[];
  /** Optional networks the site named that this wallet does not use (not shared, not listed). */
  otherChains: number;
  /** Chains the approval will grant (supported ∩ requested; Ferminux if nothing was requested). */
  approvedChainIds: number[];
  methods: string[];
  /** Reasons approval is impossible; the modal then offers Reject only. */
  blockers: string[];
  /** Exactly what approveSession receives; null when blocked. */
  namespaces: Record<string, SessionNamespace> | null;
}

interface FlatNamespace {
  namespace: string;
  chains: string[];
  methods: string[];
  events: string[];
}

/** Flatten `eip155` and chain-scoped keys like `eip155:1` into one shape. */
function flatten(ns: Record<string, NamespaceRequest> | undefined): FlatNamespace[] {
  const out: FlatNamespace[] = [];
  for (const [key, value] of Object.entries(ns ?? {})) {
    const [namespace] = key.split(':');
    const chains = key.includes(':') ? [key] : Array.isArray(value?.chains) ? value.chains.map(String) : [];
    out.push({
      namespace,
      chains,
      methods: Array.isArray(value?.methods) ? value.methods.map(String) : [],
      events: Array.isArray(value?.events) ? value.events.map(String) : [],
    });
  }
  return out;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** The namespaces a session grants: one account (the active one) on each chain. */
export function buildNamespaces(
  chainIds: number[],
  address: string,
  methods: string[],
  events: string[],
): Record<string, SessionNamespace> {
  const a = getAddress(address);
  const ids = uniq(chainIds);
  return {
    eip155: {
      chains: ids.map(caip2),
      accounts: ids.map((id) => `${caip2(id)}:${a}`),
      methods: uniq(methods),
      events: uniq(events),
    },
  };
}

export function reviewProposal(
  proposal: ProposalLike,
  address: string,
  supported: ChainDef[] = CHAINS,
  homeChainId: number = supported[0].id,
): ProposalReview {
  const dapp = dappInfo(proposal.params.proposer?.metadata);
  const verify = verifyView(proposal.verifyContext, dapp);
  const required = flatten(proposal.params.requiredNamespaces);
  const optional = flatten(proposal.params.optionalNamespaces);
  const blockers: string[] = [];

  for (const ns of required) {
    if (ns.namespace !== 'eip155') {
      blockers.push(`The site requires "${clean(ns.namespace, 20)}" accounts, which this wallet does not hold.`);
    }
  }

  const chains: RequestedChain[] = [];
  const addChain = (caip: string, isRequired: boolean) => {
    const existing = chains.find((c) => c.caip === caip);
    if (existing) {
      existing.required = existing.required || isRequired;
      return;
    }
    const id = parseCaip2(caip);
    const def = id === null ? undefined : supported.find((c) => c.id === id);
    chains.push({
      caip,
      chainId: id,
      name: def ? def.name : id !== null ? `Chain ${id}` : clean(caip, 40),
      supported: !!def,
      required: isRequired,
    });
  };
  for (const ns of required) if (ns.namespace === 'eip155') ns.chains.forEach((c) => addChain(c, true));
  for (const ns of optional) if (ns.namespace === 'eip155') ns.chains.forEach((c) => addChain(c, false));

  for (const c of chains) {
    if (c.required && !c.supported) blockers.push(`The site requires ${c.name}, which this wallet does not support.`);
  }
  // Every request from such a session would be refused (reviewRequest); the
  // connection itself would still hand the site this address.
  if (verify.status === 'scam') blockers.push('WalletConnect flagged this site as a known scam.');

  let approvedChainIds = chains.filter((c) => c.supported && c.chainId !== null).map((c) => c.chainId as number);
  if (approvedChainIds.length === 0 && !chains.some((c) => c.required)) approvedChainIds = [homeChainId];
  if (approvedChainIds.length === 0) blockers.push('None of the networks the site asked for are supported.');

  const requiredEip155 = required.filter((n) => n.namespace === 'eip155');
  const optionalEip155 = optional.filter((n) => n.namespace === 'eip155');
  const ours = WC_METHODS as readonly string[];
  // Required methods must all be granted or the protocol refuses the session;
  // one this wallet cannot service is answered "unsupported" when it is called.
  const methods = uniq([
    ...ours,
    ...requiredEip155.flatMap((n) => n.methods),
    ...optionalEip155.flatMap((n) => n.methods).filter((m) => ours.includes(m)),
  ]);
  const events = uniq([...WC_EVENTS, ...requiredEip155.flatMap((n) => n.events)]);

  // When nothing requested is usable the full list stays, so the reason is visible.
  const shown = chains.filter((c) => c.supported || c.required);
  const listed = shown.length > 0 ? shown : chains;

  return {
    id: proposal.id,
    dapp,
    verify,
    expiresAt: typeof proposal.params.expiryTimestamp === 'number' ? proposal.params.expiryTimestamp * 1000 : null,
    chains: listed,
    otherChains: chains.length - listed.length,
    approvedChainIds,
    methods,
    blockers,
    namespaces: blockers.length === 0 ? buildNamespaces(approvedChainIds, address, methods, events) : null,
  };
}

/** Chain ids a live session grants. */
export function sessionChainIds(session: SessionLike): number[] {
  const ns = session.namespaces?.eip155;
  if (!ns) return [];
  const fromChains = (ns.chains ?? []).map(parseCaip2);
  const fromAccounts = ns.accounts.map((a) => parseCaip2(a.split(':').slice(0, 2).join(':')));
  return uniq([...fromChains, ...fromAccounts].filter((x): x is number => x !== null));
}

/** Addresses a live session exposes. */
export function sessionAddresses(session: SessionLike): string[] {
  const ns = session.namespaces?.eip155;
  if (!ns) return [];
  return uniq(ns.accounts.map((a) => a.split(':')[2]).filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase()));
}

/** The same session with its account moved to `address` (and optionally one more chain). */
export function namespacesFor(session: SessionLike, address: string, addChainId?: number): Record<string, SessionNamespace> {
  const ns = session.namespaces.eip155;
  const ids = uniq([...sessionChainIds(session), ...(addChainId !== undefined ? [addChainId] : [])]);
  return buildNamespaces(ids, address, ns?.methods ?? [...WC_METHODS], ns?.events ?? [...WC_EVENTS]);
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export type DecodedCall =
  | { kind: 'token-transfer'; to: string; amount: bigint }
  | { kind: 'token-approve'; spender: string; amount: bigint; unlimited: boolean }
  | { kind: 'token-increase-allowance'; spender: string; amount: bigint; unlimited: boolean }
  | { kind: 'token-transfer-from'; from: string; to: string; amount: bigint }
  | { kind: 'approval-for-all'; operator: string; approved: boolean }
  | { kind: 'nft-transfer'; from: string; to: string; tokenId: bigint }
  | { kind: 'unknown'; selector: string };

const callIface = new Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  // increaseAllowance grants an allowance exactly like approve; a drainer uses
  // it to slip past a wallet that only spells out approve().
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
]);

const UNLIMITED = 2n ** 255n;

/** Decode the calls whose consequences a user must see spelled out. */
export function decodeCall(data: string): DecodedCall | null {
  if (!data || data === '0x') return null;
  const selector = data.slice(0, 10).toLowerCase();
  try {
    const parsed = callIface.parseTransaction({ data });
    if (!parsed) return { kind: 'unknown', selector };
    const a = parsed.args;
    switch (parsed.name) {
      case 'transfer':
        return { kind: 'token-transfer', to: getAddress(a[0]), amount: BigInt(a[1]) };
      case 'approve':
        return { kind: 'token-approve', spender: getAddress(a[0]), amount: BigInt(a[1]), unlimited: BigInt(a[1]) >= UNLIMITED };
      case 'increaseAllowance':
        return { kind: 'token-increase-allowance', spender: getAddress(a[0]), amount: BigInt(a[1]), unlimited: BigInt(a[1]) >= UNLIMITED };
      case 'transferFrom':
        return { kind: 'token-transfer-from', from: getAddress(a[0]), to: getAddress(a[1]), amount: BigInt(a[2]) };
      case 'setApprovalForAll':
        return { kind: 'approval-for-all', operator: getAddress(a[0]), approved: Boolean(a[1]) };
      case 'safeTransferFrom':
        return { kind: 'nft-transfer', from: getAddress(a[0]), to: getAddress(a[1]), tokenId: BigInt(a[2]) };
      default:
        return { kind: 'unknown', selector };
    }
  } catch {
    return { kind: 'unknown', selector };
  }
}

export interface TypedField {
  path: string;
  value: string;
}

export type RequestDetail =
  | { kind: 'message'; text: string | null; hex: string; siweDomain: string | null }
  | { kind: 'eth_sign'; hash: string }
  | {
      kind: 'typed';
      primaryType: string;
      domain: { name: string | null; version: string | null; chainId: number | null; verifyingContract: string | null };
      fields: TypedField[];
      /** Parsed payload for signing (EIP712Domain removed from types). */
      payload: { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, unknown> };
    }
  | { kind: 'tx'; from: string; to: string; valueWei: bigint; data: string; decoded: DecodedCall | null; gas: bigint | null }
  | { kind: 'switch'; targetId: number | null; target: ChainDef | null; inSession: boolean }
  | { kind: 'add'; targetId: number | null; target: ChainDef | null; requestedName: string; inSession: boolean }
  | { kind: 'unsupported' };

export interface RequestView {
  id: number;
  topic: string;
  method: string;
  dapp: DappInfo;
  verify: VerifyView;
  /** The chain the request names (for switch/add: the chain the dApp is on now). */
  chain: ChainDef | null;
  /** The account that would sign. */
  address: string;
  detail: RequestDetail;
  /** Non-empty = refuse only; each line says why. */
  blockers: string[];
  warnings: string[];
  /**
   * Approvable, but it hands over more than this one transaction: an unlimited
   * token approval, control of a whole NFT collection. Shown as a danger
   * notice, not a caution.
   */
  dangers?: string[];
  expiresAt: number | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PERMIT_TYPES = new Set([
  'Permit',
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
  'PermitBatchWitnessTransferFrom',
]);

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === 'string' && ADDRESS_RE.test(a) && a.toLowerCase() === b.toLowerCase();
}

function quantity(v: unknown): bigint | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) return BigInt(v.trim());
  throw new Error('bad quantity');
}

function chainIdFrom(v: unknown): number | null {
  try {
    const q = quantity(v);
    if (q === null || q <= 0n || q > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(q);
  } catch {
    return null;
  }
}

/** Printable UTF-8, or null (then the modal shows the hex). */
export function printableText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return '';
  let s: string;
  try {
    s = toUtf8String(bytes);
  } catch {
    return null;
  }
  if (UNREADABLE_RE.test(s)) return null;
  return s;
}

/** EIP-4361 sign-in message → the domain it names, else null. */
export function siweDomain(text: string | null): string | null {
  if (!text) return null;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:\n/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function flattenTyped(value: unknown, path: string, out: TypedField[], depth: number): void {
  if (out.length >= 80) return;
  if (depth > 6) {
    out.push({ path, value: '…' });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.push({ path, value: '[]' });
    value.slice(0, 20).forEach((v, i) => flattenTyped(v, `${path}[${i}]`, out, depth + 1));
    if (value.length > 20) out.push({ path: `${path}[…]`, value: `${value.length - 20} more` });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flattenTyped(v, path ? `${path}.${k}` : k, out, depth + 1);
    return;
  }
  out.push({ path, value: clean(String(value), 200) });
}

function invalid(base: Omit<RequestView, 'detail' | 'blockers' | 'warnings'>, reason: string): RequestView {
  return { ...base, detail: { kind: 'unsupported' }, blockers: [reason], warnings: [] };
}

/**
 * Decode one session_request for the confirm modal. Never throws: malformed
 * input comes back with a blocker explaining why it cannot be approved.
 */
export function reviewRequest(
  event: RequestEventLike,
  session: SessionLike | undefined,
  activeAddress: string,
  supported: ChainDef[] = CHAINS,
): RequestView {
  const method = String(event.params?.request?.method ?? '');
  const params = event.params?.request?.params;
  const dapp = dappInfo(session?.peer?.metadata);
  const verify = verifyView(event.verifyContext, dapp);
  const requestChainId = parseCaip2(String(event.params?.chainId ?? ''));
  const chain = requestChainId === null ? null : (supported.find((c) => c.id === requestChainId) ?? null);
  const expiry = event.params?.request?.expiryTimestamp;
  const base = {
    id: event.id,
    topic: event.topic,
    method,
    dapp,
    verify,
    chain,
    address: getAddress(activeAddress),
    expiresAt: typeof expiry === 'number' ? expiry * 1000 : null,
  };
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!session) return invalid(base, 'This request belongs to a session that is no longer connected.');

  const grantedChains = sessionChainIds(session);
  const needsChain = method !== 'wallet_switchEthereumChain' && method !== 'wallet_addEthereumChain';
  if (needsChain) {
    if (!chain) blockers.push(`The request is for ${requestChainId === null ? 'an unknown network' : `chain ${requestChainId}`}, which this wallet does not support.`);
    else if (!grantedChains.includes(chain.id)) blockers.push(`${chain.name} was not approved for this site.`);
  }
  if (verify.status === 'scam') blockers.push('WalletConnect flagged this site as a known scam.');
  if (verify.mismatch) warnings.push(`The request came from ${verify.origin}, not the address the site claims (${dapp.url}).`);

  const p = Array.isArray(params) ? params : [];
  switch (method) {
    case 'personal_sign': {
      // Spec order is [message, address]; some sites send them swapped.
      let [msg, addr] = p as unknown[];
      if (typeof msg === 'string' && ADDRESS_RE.test(msg) && !(typeof addr === 'string' && ADDRESS_RE.test(addr))) [msg, addr] = [addr, msg];
      if (typeof msg !== 'string') return invalid(base, 'The message to sign is missing.');
      if (!sameAddress(addr, activeAddress)) blockers.push(`The site asks for a signature from ${String(addr)}, which is not the active account.`);
      const bytes = isHexString(msg) ? getBytes(msg) : toUtf8Bytes(msg);
      const text = printableText(bytes);
      const domain = siweDomain(text);
      // Verify's origin when it has one, else the host the site claims.
      const verifiedHost = hostOf(verify.origin);
      const originHost = verifiedHost || dapp.host;
      if (domain && originHost && domain !== originHost) {
        warnings.push(
          verifiedHost
            ? `This sign-in message is for ${domain}, but the request came from ${originHost}. Signing it could log someone else in as you.`
            : `This sign-in message is for ${domain}, but the site calls itself ${originHost}. Signing it could log someone else in as you.`,
        );
      }
      if (text === null) warnings.push('The message is not readable text. Only sign data you understand.');
      return { ...base, detail: { kind: 'message', text, hex: hexlify(bytes), siweDomain: domain }, blockers, warnings };
    }
    case 'eth_sign':
      // Blind signing of a raw 32-byte hash can authorise a transaction that empties the account on any
      // network, and no screen can show what it means. Refused outright (MetaMask removed it too); the
      // method is not offered in any session, and the connect window refuses it as well.
      return invalid(base, 'This wallet does not support "eth_sign": it signs a raw hash that could be a transaction emptying this account. Ask the site to use personal_sign or typed data.');
    case 'eth_signTypedData_v4': {
      const [addr, raw] = p as unknown[];
      if (!sameAddress(addr, activeAddress)) blockers.push(`The site asks for a signature from ${String(addr)}, which is not the active account.`);
      let parsed: { domain?: Record<string, unknown>; types?: Record<string, Array<{ name: string; type: string }>>; primaryType?: string; message?: Record<string, unknown> };
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as typeof parsed);
      } catch {
        return invalid(base, 'The typed data is not valid JSON.');
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.types || !parsed.message || typeof parsed.primaryType !== 'string') {
        return invalid(base, 'The typed data is missing its types, primaryType or message.');
      }
      const types = { ...parsed.types };
      delete types.EIP712Domain;
      const domain = parsed.domain ?? {};
      let signedType: string;
      try {
        // Throws on a malformed schema or a message that does not fit it.
        TypedDataEncoder.hash(domain, types, parsed.message);
        signedType = TypedDataEncoder.getPrimaryType(types);
      } catch (e) {
        return invalid(base, `The typed data does not match its own schema: ${clean(e instanceof Error ? e.message : String(e), 160)}`);
      }
      // The signature covers the root of `types`, whatever primaryType claims.
      // A label that differs would show one type (and skip the permit warning)
      // while the key signs another.
      if (signedType !== parsed.primaryType) {
        return invalid(base, `The typed data names "${clean(parsed.primaryType, 60)}" as its type, but what would be signed is "${clean(signedType, 60)}".`);
      }
      const domainChainId = domain.chainId === undefined ? null : chainIdFrom(domain.chainId);
      if (domain.chainId !== undefined && domainChainId === null) blockers.push('The typed data names an unreadable chain id.');
      if (domainChainId !== null && chain && domainChainId !== chain.id) {
        blockers.push(`The typed data is for chain ${domainChainId}, but the request is for ${chain.name} (${chain.id}).`);
      }
      const verifyingContract =
        typeof domain.verifyingContract === 'string' && ADDRESS_RE.test(domain.verifyingContract) ? getAddress(domain.verifyingContract.toLowerCase()) : null;
      if (PERMIT_TYPES.has(parsed.primaryType) || /permit2/i.test(String(domain.name ?? ''))) {
        warnings.push('This is a token permit: it lets the named spender move your tokens later without another confirmation from you. Check the spender, amount and deadline.');
      }
      const fields: TypedField[] = [];
      flattenTyped(parsed.message, '', fields, 0);
      return {
        ...base,
        detail: {
          kind: 'typed',
          primaryType: clean(parsed.primaryType, 60),
          domain: {
            name: typeof domain.name === 'string' ? clean(domain.name, 80) : null,
            version: typeof domain.version === 'string' ? clean(domain.version, 20) : null,
            chainId: domainChainId,
            verifyingContract,
          },
          fields,
          payload: { domain, types, message: parsed.message },
        },
        blockers,
        warnings,
      };
    }
    case 'eth_sendTransaction': {
      const tx = (p[0] ?? null) as Record<string, unknown> | null;
      if (!tx || typeof tx !== 'object') return invalid(base, 'The transaction is missing.');
      if (tx.from !== undefined && !sameAddress(tx.from, activeAddress)) {
        blockers.push(`The transaction is from ${String(tx.from)}, which is not the active account.`);
      }
      if (typeof tx.to !== 'string' || !ADDRESS_RE.test(tx.to)) {
        return invalid(base, tx.to === undefined || tx.to === null ? 'Contract deployment requests are not supported.' : 'The transaction recipient is not a valid address.');
      }
      let valueWei: bigint;
      let gas: bigint | null;
      try {
        valueWei = quantity(tx.value) ?? 0n;
        gas = quantity(tx.gas ?? tx.gasLimit);
      } catch {
        return invalid(base, 'The transaction carries an unreadable value or gas field.');
      }
      // The key signs for the request's chain (the banner shows it). A chainId
      // inside the transaction that names another one means the site built it
      // for that network — sending it here moves funds where it never looks.
      // The connect window and the dApp provider refuse the same mismatch.
      if (tx.chainId !== undefined && tx.chainId !== null) {
        const txChainId = chainIdFrom(tx.chainId);
        if (txChainId === null) blockers.push('The transaction names an unreadable chain id.');
        else if (chain && txChainId !== chain.id) {
          blockers.push(`The transaction is for chain ${txChainId}, but the request is for ${chain.name} (${chain.id}).`);
        }
      }
      const data = typeof tx.data === 'string' ? tx.data : typeof tx.input === 'string' ? tx.input : '0x';
      if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return invalid(base, 'The transaction data is not valid hex.');
      const decoded = decodeCall(data);
      const dangers: string[] = [];
      if (decoded?.kind === 'token-approve' && decoded.unlimited) {
        dangers.push('Unlimited approval: the spender could move ALL of this token from your account, now and later, until you revoke it.');
      }
      if (decoded?.kind === 'token-increase-allowance' && decoded.unlimited) {
        dangers.push('Unlimited approval (increaseAllowance): the spender could move ALL of this token from your account, now and later, until you revoke it.');
      }
      if (decoded?.kind === 'approval-for-all' && decoded.approved) {
        dangers.push(
          `This lets ${decoded.operator} move EVERY NFT you hold in this collection, now and later, without asking you again. Approve it only for a marketplace or contract you trust, and revoke it when you are done.`,
        );
      }
      return {
        ...base,
        detail: { kind: 'tx', from: getAddress(activeAddress), to: getAddress(tx.to.toLowerCase()), valueWei, data: data.toLowerCase(), decoded, gas },
        blockers,
        warnings,
        dangers,
      };
    }
    case 'wallet_switchEthereumChain': {
      const target = (p[0] ?? null) as { chainId?: unknown } | null;
      const targetId = chainIdFrom(target?.chainId);
      const def = targetId === null ? null : (supported.find((c) => c.id === targetId) ?? null);
      if (!def) blockers.push(targetId === null ? 'The site did not say which network to switch to.' : `Chain ${targetId} is not supported by this wallet.`);
      return { ...base, detail: { kind: 'switch', targetId, target: def, inSession: def ? grantedChains.includes(def.id) : false }, blockers, warnings };
    }
    case 'wallet_addEthereumChain': {
      const target = (p[0] ?? null) as { chainId?: unknown; chainName?: unknown } | null;
      const targetId = chainIdFrom(target?.chainId);
      const def = targetId === null ? null : (supported.find((c) => c.id === targetId) ?? null);
      const requestedName = clean(target?.chainName, 60);
      if (!def) {
        blockers.push(
          targetId === null
            ? 'The site did not say which network to add.'
            : `This wallet only uses its built-in networks, and chain ${targetId}${requestedName ? ` (${requestedName})` : ''} is not one of them.`,
        );
      } else {
        warnings.push(`${def.name} is built in. The wallet keeps using its own RPC endpoints; any the site sent are ignored.`);
      }
      return {
        ...base,
        detail: { kind: 'add', targetId, target: def, requestedName, inSession: def ? grantedChains.includes(def.id) : false },
        blockers,
        warnings,
      };
    }
    default:
      return invalid(base, `This wallet does not support "${clean(method, 60)}".`);
  }
}

/** True for the methods whose approval produces a signature from the key. */
export function isSigningRequest(view: RequestView): boolean {
  return view.detail.kind === 'message' || view.detail.kind === 'eth_sign' || view.detail.kind === 'typed';
}

/**
 * Sign an APPROVED signing request. Refuses anything that still has a blocker
 * — the modal hides the button, this is the second lock.
 */
export async function signForRequest(view: RequestView, privateKey: string): Promise<string> {
  if (view.blockers.length > 0) throw new Error('This request cannot be signed.');
  const wallet = new Wallet(privateKey);
  if (wallet.address.toLowerCase() !== view.address.toLowerCase()) throw new Error('The active key does not match the requested account.');
  const d = view.detail;
  switch (d.kind) {
    case 'message':
      return wallet.signMessage(getBytes(d.hex));
    case 'eth_sign':
      return wallet.signingKey.sign(d.hash).serialized;
    case 'typed':
      return wallet.signTypedData(d.payload.domain, d.payload.types, d.payload.message);
    default:
      throw new Error(`${view.method} is not a signing request.`);
  }
}

export function userRejected(): RpcError {
  return { ...SDK_ERRORS.USER_REJECTED };
}

/** Error for a request refused on a blocker (not by the user's choice). */
export function refusal(view: RequestView): RpcError {
  if (view.detail.kind === 'unsupported' && view.blockers[0]?.startsWith('This wallet does not support')) {
    return { ...SDK_ERRORS.UNSUPPORTED_METHODS };
  }
  if ((view.detail.kind === 'switch' || view.detail.kind === 'add') && view.detail.target === null) {
    return { code: 4902, message: 'Unrecognized chain: this wallet only supports its built-in networks.' };
  }
  return { code: -32602, message: view.blockers[0] ?? 'Invalid request.' };
}
