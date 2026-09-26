// WalletConnect session/request bookkeeping around an injected WalletKit.
// Pure: the kit is passed in (the real one in the browser, a mock in tests), so
// every path — proposal, approval, request, response, disconnect, account
// switch — is unit-tested without the relay.
//
// The controller never signs. It queues what a dApp asks for, and the UI
// answers each item with an explicit user decision: approve (with the result
// the UI produced — a signature or a transaction hash) or reject.

import type { ChainDef } from './chains.ts';
import { CHAINS, caip2 } from './chains.ts';
import {
  SDK_ERRORS,
  namespacesFor,
  refusal,
  reviewProposal,
  reviewRequest,
  sessionAddresses,
  sessionChainIds,
  type DappInfo,
  type ProposalLike,
  type ProposalReview,
  type RequestEventLike,
  type RequestView,
  type RpcError,
  type SessionLike,
  type SessionNamespace,
  dappInfo,
} from './walletconnect.ts';

/** The WalletKit surface this controller uses. */
export interface KitLike {
  on(event: 'session_proposal', listener: (p: ProposalLike) => void): unknown;
  on(event: 'session_request', listener: (r: RequestEventLike) => void): unknown;
  on(event: 'session_delete', listener: (e: { topic: string }) => void): unknown;
  on(event: 'proposal_expire', listener: (e: { id: number }) => void): unknown;
  on(event: 'session_request_expire', listener: (e: { id: number }) => void): unknown;
  pair(p: { uri: string }): Promise<unknown>;
  approveSession(p: { id: number; namespaces: Record<string, SessionNamespace> }): Promise<unknown>;
  rejectSession(p: { id: number; reason: RpcError }): Promise<unknown>;
  respondSessionRequest(p: {
    topic: string;
    response: { id: number; jsonrpc: '2.0'; result?: unknown; error?: RpcError };
  }): Promise<unknown>;
  getActiveSessions(): Record<string, SessionLike>;
  getPendingSessionRequests(): RequestEventLike[];
  disconnectSession(p: { topic: string; reason: RpcError }): Promise<unknown>;
  updateSession(p: { topic: string; namespaces: Record<string, SessionNamespace> }): Promise<unknown>;
  emitSessionEvent(p: { topic: string; event: { name: string; data: unknown }; chainId: string }): Promise<unknown>;
}

export interface SessionSummary {
  topic: string;
  dapp: DappInfo;
  chainIds: number[];
  addresses: string[];
  expiresAt: number | null;
}

export interface WcState {
  sessions: SessionSummary[];
  /** Oldest first; the UI shows the head. */
  proposals: ProposalReview[];
  requests: RequestView[];
  /** A one-line message for the Connect tab (auto-refusals, expiries). */
  notice: string | null;
}

export interface ControllerOptions {
  /** The active account, or null while locked. */
  getAddress: () => string | null;
  onChange: (state: WcState) => void;
  /** Told whether any session exists, so the next unlock knows to reconnect. */
  onUsed?: (used: boolean) => void;
  chains?: ChainDef[];
  now?: () => number;
}

export class WcController {
  private readonly kit: KitLike;
  private readonly opts: ControllerOptions;
  private readonly chains: ChainDef[];
  private proposalsRaw: ProposalLike[] = [];
  private requestsRaw: RequestEventLike[] = [];
  private notice: string | null = null;
  private started = false;

  constructor(kit: KitLike, opts: ControllerOptions) {
    this.kit = kit;
    this.opts = opts;
    this.chains = opts.chains ?? CHAINS;
  }

  /** Subscribe to the kit and pick up anything that arrived while the page was closed. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.kit.on('session_proposal', (p) => {
      this.proposalsRaw = [...this.proposalsRaw.filter((x) => x.id !== p.id), p];
      this.emit();
    });
    this.kit.on('session_request', (r) => void this.onRequest(r));
    this.kit.on('session_delete', ({ topic }) => {
      this.requestsRaw = this.requestsRaw.filter((r) => r.topic !== topic);
      this.emit();
    });
    this.kit.on('proposal_expire', ({ id }) => {
      if (this.proposalsRaw.some((p) => p.id === id)) this.notice = 'A connection request expired before it was answered.';
      this.proposalsRaw = this.proposalsRaw.filter((p) => p.id !== id);
      this.emit();
    });
    this.kit.on('session_request_expire', ({ id }) => {
      if (this.requestsRaw.some((r) => r.id === id)) this.notice = 'A request from a connected site expired before it was answered.';
      this.requestsRaw = this.requestsRaw.filter((r) => r.id !== id);
      this.emit();
    });
    for (const r of this.kit.getPendingSessionRequests() ?? []) void this.onRequest(r);
    this.emit();
  }

  /** Current view; proposals and requests are re-reviewed against the active account every time. */
  state(): WcState {
    const address = this.opts.getAddress();
    const sessions = this.kit.getActiveSessions() ?? {};
    const summaries: SessionSummary[] = Object.values(sessions).map((s) => ({
      topic: s.topic,
      dapp: dappInfo(s.peer?.metadata),
      chainIds: sessionChainIds(s),
      addresses: sessionAddresses(s),
      expiresAt: typeof s.expiry === 'number' ? s.expiry * 1000 : null,
    }));
    return {
      sessions: summaries,
      proposals: address ? this.proposalsRaw.map((p) => reviewProposal(p, address, this.chains)) : [],
      requests: address ? this.requestsRaw.map((r) => reviewRequest(r, sessions[r.topic], address, this.chains)) : [],
      notice: this.notice,
    };
  }

  private emit(): void {
    const s = this.state();
    this.opts.onUsed?.(s.sessions.length > 0);
    this.opts.onChange(s);
  }

  clearNotice(): void {
    this.notice = null;
    this.emit();
  }

  private async onRequest(r: RequestEventLike): Promise<void> {
    if (this.requestsRaw.some((x) => x.id === r.id)) return;
    const address = this.opts.getAddress();
    const session = this.kit.getActiveSessions()?.[r.topic];
    // A method this wallet never implements is refused at once — there is
    // nothing for the user to decide. Everything else waits for the user,
    // including requests with blockers: they are shown so the user sees what
    // was refused and why.
    if (address) {
      const view = reviewRequest(r, session, address, this.chains);
      if (view.detail.kind === 'unsupported' && view.blockers[0]?.startsWith('This wallet does not support')) {
        this.notice = `Refused "${view.method}" from ${view.dapp.name}: not supported by this wallet.`;
        await this.respond(r.topic, r.id, { error: refusal(view) });
        this.emit();
        return;
      }
    }
    this.requestsRaw = [...this.requestsRaw, r];
    this.emit();
  }

  async pair(uri: string): Promise<void> {
    await this.kit.pair({ uri });
  }

  async approveProposal(id: number): Promise<void> {
    const address = this.opts.getAddress();
    const raw = this.proposalsRaw.find((p) => p.id === id);
    if (!address || !raw) throw new Error('That connection request is no longer pending.');
    const review = reviewProposal(raw, address, this.chains);
    if (!review.namespaces) throw new Error(review.blockers[0] ?? 'This connection cannot be approved.');
    try {
      await this.kit.approveSession({ id, namespaces: review.namespaces });
    } finally {
      this.proposalsRaw = this.proposalsRaw.filter((p) => p.id !== id);
      this.emit();
    }
  }

  async rejectProposal(id: number): Promise<void> {
    const raw = this.proposalsRaw.find((p) => p.id === id);
    this.proposalsRaw = this.proposalsRaw.filter((p) => p.id !== id);
    this.emit();
    if (!raw) return;
    const address = this.opts.getAddress();
    const blocked = address ? reviewProposal(raw, address, this.chains).blockers.length > 0 : false;
    await this.kit.rejectSession({ id, reason: blocked ? { ...SDK_ERRORS.UNSUPPORTED_CHAINS } : { ...SDK_ERRORS.USER_REJECTED } });
  }

  private async respond(topic: string, id: number, body: { result?: unknown; error?: RpcError }): Promise<void> {
    await this.kit.respondSessionRequest({
      topic,
      response: body.error ? { id, jsonrpc: '2.0', error: body.error } : { id, jsonrpc: '2.0', result: body.result ?? null },
    });
  }

  private take(id: number): RequestEventLike {
    const raw = this.requestsRaw.find((r) => r.id === id);
    if (!raw) throw new Error('That request is no longer pending.');
    return raw;
  }

  private drop(id: number): void {
    this.requestsRaw = this.requestsRaw.filter((r) => r.id !== id);
    this.emit();
  }

  /** Answer an approved request with the result the UI produced (signature, tx hash). */
  async approveRequest(id: number, result: unknown): Promise<void> {
    const raw = this.take(id);
    try {
      await this.respond(raw.topic, id, { result });
    } finally {
      this.drop(id);
    }
  }

  /** The user said no (or the request carried a blocker). */
  async rejectRequest(id: number): Promise<void> {
    const raw = this.take(id);
    const address = this.opts.getAddress();
    const session = this.kit.getActiveSessions()?.[raw.topic];
    const view = address ? reviewRequest(raw, session, address, this.chains) : null;
    const error = view && view.blockers.length > 0 ? refusal(view) : { ...SDK_ERRORS.USER_REJECTED };
    try {
      await this.respond(raw.topic, id, { error });
    } finally {
      this.drop(id);
    }
  }

  /** A request failed after approval (e.g. the broadcast was refused): tell the dApp why. */
  async failRequest(id: number, message: string): Promise<void> {
    const raw = this.take(id);
    try {
      await this.respond(raw.topic, id, { error: { code: -32603, message: message.slice(0, 200) } });
    } finally {
      this.drop(id);
    }
  }

  /**
   * Approve wallet_switchEthereumChain / wallet_addEthereumChain: grant the
   * chain to the session if it is not granted yet, tell the dApp the chain
   * changed, answer null.
   */
  async approveChainRequest(id: number): Promise<void> {
    const raw = this.take(id);
    const address = this.opts.getAddress();
    const sessions = this.kit.getActiveSessions() ?? {};
    const session = sessions[raw.topic];
    if (!address || !session) throw new Error('The session is no longer connected.');
    const view = reviewRequest(raw, session, address, this.chains);
    const d = view.detail;
    if ((d.kind !== 'switch' && d.kind !== 'add') || !d.target || view.blockers.length > 0) {
      throw new Error(view.blockers[0] ?? 'This request cannot be approved.');
    }
    try {
      if (!d.inSession) {
        await this.kit.updateSession({ topic: raw.topic, namespaces: namespacesFor(session, address, d.target.id) });
      }
      await this.kit.emitSessionEvent({
        topic: raw.topic,
        event: { name: 'chainChanged', data: d.target.id },
        chainId: caip2(d.target.id),
      });
      await this.respond(raw.topic, id, { result: null });
    } finally {
      this.drop(id);
    }
  }

  /**
   * End every session (each site is told) and drop everything queued: the
   * wallet is locked with "remember" off, and nothing of it may outlive that.
   */
  async disconnectAll(): Promise<void> {
    const proposals = this.proposalsRaw;
    this.proposalsRaw = [];
    this.requestsRaw = [];
    for (const p of proposals) {
      await this.kit.rejectSession({ id: p.id, reason: { ...SDK_ERRORS.USER_REJECTED } }).catch(() => undefined);
    }
    for (const topic of Object.keys(this.kit.getActiveSessions() ?? {})) {
      await this.kit.disconnectSession({ topic, reason: { ...SDK_ERRORS.USER_DISCONNECTED } }).catch(() => undefined);
    }
    this.emit();
  }

  async disconnect(topic: string): Promise<void> {
    this.requestsRaw = this.requestsRaw.filter((r) => r.topic !== topic);
    try {
      await this.kit.disconnectSession({ topic, reason: { ...SDK_ERRORS.USER_DISCONNECTED } });
    } finally {
      this.emit();
    }
  }

  /**
   * The active account changed. Switching accounts in the wallet shares
   * nothing: a session hears only about an account it was approved for. One
   * approved for several, this one among them, is told this one is active;
   * every other session stays on the account it was approved for, and its
   * requests are refused as "not the active account" until the user switches
   * back or shares this account with it (shareAccount, from the Connect tab).
   */
  async syncAccount(address: string): Promise<void> {
    const me = address.toLowerCase();
    for (const s of Object.values(this.kit.getActiveSessions() ?? {})) {
      const current = sessionAddresses(s);
      if (!current.includes(me) || current[0] === me) continue;
      const first = sessionChainIds(s)[0];
      if (first === undefined) continue;
      try {
        await this.kit.emitSessionEvent({ topic: s.topic, event: { name: 'accountsChanged', data: [address] }, chainId: caip2(first) });
      } catch {
        /* the site keeps the account it had; its requests are still checked per account */
      }
    }
    this.emit();
  }

  /** The user chose to give this site `address` instead of the account it was approved for. */
  async shareAccount(topic: string, address: string): Promise<void> {
    const s = this.kit.getActiveSessions()?.[topic];
    if (!s) throw new Error('The session is no longer connected.');
    try {
      await this.kit.updateSession({ topic, namespaces: namespacesFor(s, address) });
      const first = sessionChainIds(s)[0];
      if (first !== undefined) {
        await this.kit.emitSessionEvent({ topic, event: { name: 'accountsChanged', data: [address] }, chainId: caip2(first) });
      }
    } finally {
      this.emit();
    }
  }
}
