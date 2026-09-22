// Gateway client for Addendum v3, aligned to the real gateway (gateway/src/v3/*.ts, read 2026-09-21
// after the gateway lane landed — this replaces an earlier inferred version of this file). Mirrors
// api.ts's shape: real fetch in production, a dynamic import of ./mockEconomy when VITE_MOCK=1 so the
// mock module is tree-shaken out of the production bundle.
//
// What's NOT a REST route (confirmed against gateway/src/v3/reads.ts, x402.ts, server.ts):
//  - No /disputes/cases/:id or /disputes/pool — /api/disputes is filtered client-side by id here;
//    pool state (stake/arbiterCount/minStake/…) and a case's per-arbiter votes are read on-chain.
//  - No /agents/:id/reputation or /agents/:id/validations — GET /api/agents/:id embeds `validation`
//    (count/avgResponse/latest) and `links` (a2a/erc8004/audit) directly; the reputation *summary* is
//    read on-chain via ReputationRegistry8004.getSummary (no off-chain mirror is exposed).
//  - No /x402/payer/:addr/vouchers — voucher history is inside the payer view itself.
//  - No /tokens/:id or /tokens/:symbol/distributions — GET /api/tokens?agentId= filters the list;
//    curve params (base/slope/reserve/price) and a holder's claimable share are read on-chain
//    (AgentTokenFactory.getCurve/price/claimable) since the gateway only indexes buy/sell counters.
import { REPUTATION_8004_ABI, ARBITER_POOL_ABI, TOKEN_FACTORY_ABI, AGENT_TOKEN_ABI, STREAM_PAY_ABI, X402_VAULT_ABI, type Abi } from "./abi";
import { api } from "./api";
import { config, reputation8004Deployed, arbiterDeployed, tokenFactoryDeployed, streamsDeployed, vaultDeployed } from "./config";
import type { SignedFields } from "./sign";
import { contractRead } from "./wallet";
import type {
  AccountRow, AccountView, AgentTokenRow, AgentTokenView, ArbiterCase, ArbiterPoolView, ComputeListing, MemoryKeyView, MemoryQuota,
  PayinAssets, PayinQuote, PayinQuoteRequest, PayinStatus, PlanView, ReputationSummary, StreamView, SubView, WebhookEvent, WebhookView, X402PayerView, X402Resource,
} from "./types";

export class ApiError extends Error { constructor(message: string, public status = 0) { super(message); } }
const planNames = new Map<string, Promise<string | null>>();

const MOCK = import.meta.env.VITE_MOCK === "1";
type MockEconomy = typeof import("./mockEconomy");
let mockMod: Promise<MockEconomy> | null = null;
function mock(): Promise<MockEconomy> { if (!mockMod) mockMod = import("./mockEconomy"); return mockMod; }
/** Mock-only writes: the literal MOCK check lets Rollup drop the mockEconomy chunk from production builds. */
function mk(): Promise<MockEconomy> { if (!MOCK) return Promise.reject(new ApiError("Demo-only action.")); return mock(); }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(config.gateway + path, { ...init, headers: { accept: "application/json", ...(init?.headers || {}) } }); }
  catch { throw new ApiError("The gateway is unreachable. Check your connection or try again in a moment."); }
  if (!r.ok) {
    let msg = `Gateway error ${r.status}`;
    try { const j = await r.json(); if (j && (j.error || j.message)) msg = String(j.error || j.message); } catch { /* ignore */ }
    if (r.status === 404) msg = "Not found.";
    throw new ApiError(msg, r.status);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}
const qs = (o: object) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ""; };
const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Signed GET/DELETE: X-Ferminux-Address / -Ts / -Sig headers (commons/context.ts `authenticateHeaders`);
 *  it also accepts ?address=&ts=&sig= or a JSON body, and tries body-hash "" then "{}", so a plain
 *  `signAction(action, {})` (this app's convention) verifies against it either way. */
const signedGet = (signed: SignedFields, method = "GET"): RequestInit => ({ method, headers: { "X-Ferminux-Address": signed.address, "X-Ferminux-Ts": String(signed.ts), "X-Ferminux-Sig": signed.sig } });

export const economy = {
  /* ---- x402 (gateway/src/v3/x402.ts) ---- */
  x402Supported: () => MOCK ? mock().then((m) => m.x402SupportedInfo()) : req<{ x402Version: number; kinds: unknown[]; domain: unknown; disabled?: boolean }>(`/x402/supported`),
  x402Payer: (addr: string): Promise<X402PayerView> => MOCK ? mock().then((m) => m.x402Payer(addr)) : req(`/x402/payer/${addr}`),
  x402Verify: (voucher: unknown, signature: string): Promise<{ isValid: boolean; ok: boolean; invalidReason?: string; reason?: string }> => MOCK ? Promise.resolve({ isValid: true, ok: true }) : req(`/x402/verify`, json({ payment: { scheme: "ferminux-voucher", network: `ferminux:${config.chainId}`, payload: { voucher, signature } } })),
  x402Settle: (voucher: unknown, signature: string): Promise<{ success: boolean; queued: boolean; nonce: string | null; txHash: string | null; errorReason?: string }> => MOCK ? Promise.resolve({ success: true, queued: true, nonce: (voucher as { nonce?: string }).nonce ?? null, txHash: null }) : req(`/x402/settle`, json({ payment: { scheme: "ferminux-voucher", network: `ferminux:${config.chainId}`, payload: { voucher, signature } } })),
  /** Priced resources: not a gateway list — derived client-side from active agents' card.pricePerCall. */
  x402Resources: async (): Promise<{ items: X402Resource[] }> => {
    if (MOCK) return mock().then((m) => m.x402Resources());
    const { items } = await api.agents({ status: "active", limit: 100 });
    const priced = items.filter((a) => a.card?.pricePerCall && BigInt(a.card.pricePerCall) > 0n);
    return { items: priced.map((a) => ({ agentId: a.id, agentName: a.name, owner: a.owner, resource: `/a/${slugify(a.name)}/invoke`, pricePerCallWei: a.card!.pricePerCall, description: a.card?.description })) };
  },

  /* ---- agent accounts (C2 / gas sponsorship). GET /api/accounts?owner= — no sessions field (not
   * indexed off-chain); sessions are read live per-account from AgentAccount by the wallet page. ---- */
  myAccounts: (owner: string): Promise<{ items: AccountRow[] }> => MOCK ? mock().then((m) => m.myAccounts(owner)) : req(`/accounts${qs({ owner })}`),
  /** POST /api/accounts/create — response field is `account`, not `address`. */
  relayCreateAccount: (owner: string): Promise<{ account: string; existing: boolean; txHash: string | null }> => MOCK ? mock().then((m) => m.createAccount(owner)).then((a) => ({ account: a.account, existing: false, txHash: null })) : req(`/accounts/create`, json({ owner })),

  /* ---- streams + subscriptions (C3, gateway/src/v3/reads.ts) ---- */
  /** "My streams" needs two calls (payer=me, payee=me) — the route has no OR filter. Each row is then
   *  refreshed from StreamPay itself (getStream + claimable): the gateway's claimed/cancelled columns
   *  lag the chain (and its indexer currently misses StreamClaimed/StreamCancelled), and the contract's
   *  claimable() is the only fee-exact number. */
  myStreams: async (addr: string): Promise<{ items: StreamView[] }> => {
    if (MOCK) return mock().then((m) => m.myStreams(addr));
    const [asPayer, asPayee] = await Promise.all([req<{ items: StreamView[] }>(`/streams${qs({ payer: addr })}`), req<{ items: StreamView[] }>(`/streams${qs({ payee: addr })}`)]);
    const byId = new Map<number, StreamView>(); for (const s of [...asPayer.items, ...asPayee.items]) byId.set(s.id, s);
    const rows = [...byId.values()].sort((a, b) => b.id - a.id);
    if (!streamsDeployed) return { items: rows };
    const c = contractRead(config.streamPay, STREAM_PAY_ABI);
    return { items: await Promise.all(rows.map(async (s) => {
      try {
        const [st, claimable] = await Promise.all([c.getStream(s.id) as Promise<{ deposit: bigint; withdrawn: bigint; start: bigint; stop: bigint; cancelled: boolean }>, c.claimable(s.id) as Promise<bigint>]);
        const cancelled = Boolean(st.cancelled); const stop = Number(st.stop);
        return { ...s, deposit: st.deposit.toString(), claimed: st.withdrawn.toString(), start: Number(st.start), stop, cancelled, claimableWei: claimable.toString(), status: cancelled ? "cancelled" : Date.now() / 1000 >= stop ? "ended" : "open" } as StreamView;
      } catch { return s; }
    })) };
  },
  myPlans: (addr: string): Promise<{ items: PlanView[] }> => MOCK ? mock().then((m) => m.myPlans(addr)) : req(`/streams/plans${qs({ payee: addr })}`),
  allPlans: (): Promise<{ items: PlanView[] }> => MOCK ? mock().then((m) => m.allPlans()) : req(`/streams/plans${qs({ active: 1 })}`),
  mySubs: (addr: string): Promise<{ items: SubView[] }> => MOCK ? mock().then((m) => m.mySubs(addr)) : req(`/streams/subs${qs({ payer: addr })}`),
  /** Plan display name: plans created here store {name} as a gateway payload (fmx://payload/<hash>). Best effort, cached. */
  planName: async (metadataURI: string | null | undefined): Promise<string | null> => {
    if (!metadataURI || !/^fmx:\/\/payload\/0x[0-9a-fA-F]{64}$/.test(metadataURI)) return null;
    if (planNames.has(metadataURI)) return planNames.get(metadataURI)!;
    const p = (async () => { try { const { text } = await api.payloadText(metadataURI); const j = JSON.parse(text); return typeof j?.name === "string" ? j.name.slice(0, 64) : null; } catch { return null; } })();
    planNames.set(metadataURI, p); return p;
  },

  /* ---- pull-payment credits. StreamPay (claims + cancel refunds), X402Vault (payee earnings),
   * ArbiterPool (rewards, returned stake) and AgentTokenFactory (sell proceeds, distributions) all
   * credit the recipient and expect a withdraw() call — nothing arrives in the wallet by itself. ---- */
  credits: async (contract: "streamPay" | "x402Vault" | "arbiterPool" | "tokenFactory", addr: string): Promise<bigint> => {
    if (MOCK) return 0n;
    const addrOf = { streamPay: config.streamPay, x402Vault: config.x402Vault, arbiterPool: config.arbiterPool, tokenFactory: config.tokenFactory }[contract];
    const abi: Abi = { streamPay: STREAM_PAY_ABI, x402Vault: X402_VAULT_ABI, arbiterPool: ARBITER_POOL_ABI, tokenFactory: TOKEN_FACTORY_ABI }[contract];
    if (!addrOf || /^0x0{40}$/.test(addrOf)) return 0n;
    return (await contractRead(addrOf, abi).credits(addr)) as bigint;
  },

  /* ---- disputes (C4). GET /api/disputes only — filter by id client-side; pool state on-chain. ---- */
  casesList: (status?: string): Promise<{ items: ArbiterCase[] }> => MOCK ? mock().then((m) => m.casesList(status)) : req(`/disputes${qs({ status, limit: 200 })}`),
  arbiterCase: async (id: number): Promise<ArbiterCase> => {
    if (MOCK) return mock().then((m) => m.arbiterCase(id));
    const { items } = await req<{ items: ArbiterCase[] }>(`/disputes${qs({ limit: 200 })}`);
    const c = items.find((x) => x.id === id);
    if (!c) throw new ApiError("Not found.", 404);
    return c;
  },
  /** Not a REST route: minStake/votingWindow/quorum/arbiterCount/stake(addr) read live from ArbiterPool. */
  arbiterPool: async (addr?: string): Promise<ArbiterPoolView> => {
    if (MOCK) return mock().then((m) => m.arbiterPool(addr));
    if (!arbiterDeployed) return { minStakeWei: "0", votingWindowSec: 0, quorum: 0, arbiterCount: 0, myStakeWei: null };
    const c = contractRead(config.arbiterPool, ARBITER_POOL_ABI);
    const [minStake, votingWindow, quorum, arbiterCount, myStake] = await Promise.all([
      c.minStake() as Promise<bigint>, c.votingWindow() as Promise<bigint>, c.quorum() as Promise<bigint>, c.arbiterCount() as Promise<bigint>,
      addr ? (c.stake(addr) as Promise<bigint>) : Promise.resolve(null),
    ]);
    return { minStakeWei: minStake.toString(), votingWindowSec: Number(votingWindow), quorum: Number(quorum), arbiterCount: Number(arbiterCount), myStakeWei: myStake === null ? null : (myStake as bigint).toString() };
  },
  /** Per-arbiter vote breakdown for one case: not indexed off-chain, read live via getVoters/getVote. */
  caseVotes: async (caseId: number): Promise<{ arbiter: string; clientBps: number }[]> => {
    if (MOCK) return mock().then((m) => m.caseVotes(caseId));
    if (!arbiterDeployed) return [];
    const c = contractRead(config.arbiterPool, ARBITER_POOL_ABI);
    const voters = (await c.getVoters(caseId)) as string[];
    return Promise.all(voters.map(async (arbiter) => { const [, clientBps] = (await c.getVote(caseId, arbiter)) as [boolean, bigint]; return { arbiter, clientBps: Number(clientBps) }; }));
  },

  /* ---- ERC-8004 reputation (C5). No REST mirror — read live from ReputationRegistry8004.getSummary.
   * The validation badge does NOT need a call: it's embedded in api.agent(id).validation. ---- */
  reputationSummary: async (agentId: number): Promise<ReputationSummary> => {
    if (MOCK) return mock().then((m) => m.reputationSummary(agentId));
    if (!reputation8004Deployed) return { agentId, count: 0, avg: null };
    const c = contractRead(config.reputation8004, REPUTATION_8004_ABI);
    // getSummary reverts with ClientAddressesRequired() for an empty client list — ask for the clients first.
    const clients = (await c.getClients(agentId)) as string[];
    if (!clients.length) return { agentId, count: 0, avg: null };
    const [count, value, decimals] = (await c.getSummary(agentId, clients, "", "")) as [bigint, bigint, number];
    return { agentId, count: Number(count), avg: Number(count) ? Number(value) / 10 ** Number(decimals) : null };
  },
  erc8004Url: (agentId: number) => `${config.gateway}/agents/${agentId}/erc8004.json`,
  /** Mock only: api.agent(id) doesn't carry `validation`/`links` in mock.ts's fixtures, so agents.ts
   *  asks for them here (real GET /api/agents/:id embeds both already). */
  mockAgentExtras: (agentId: number) => mk().then((m) => ({ validation: m.mockValidationFor(agentId), links: m.mockLinksFor(agentId) })),

  /* ---- agent tokens (C6). GET /api/tokens?agentId= for the indexed row; curve/price/claimable on-chain. ---- */
  tokensList: async (): Promise<{ items: AgentTokenView[] }> => {
    if (MOCK) return mock().then((m) => m.tokensList());
    const { items } = await req<{ items: AgentTokenRow[] }>(`/tokens`);
    return { items: await Promise.all(items.map(hydrateToken)) };
  },
  tokenOf: async (agentId: number): Promise<AgentTokenView | null> => {
    if (MOCK) return mock().then((m) => m.tokenOf(agentId));
    const { items } = await req<{ items: AgentTokenRow[] }>(`/tokens${qs({ agentId })}`);
    const row = items[0]; if (!row) return null;
    return hydrateToken(row);
  },

  /* ---- compute listings (G. — tools registry kind=compute) ---- */
  computeList: (q: { region?: string; q?: string } = {}): Promise<{ items: ComputeListing[]; total: number }> => MOCK ? mock().then((m) => m.computeList(q)) : req(`/compute${qs(q)}`),

  /* ---- memory: private per-address KV, Commons-signed (G., gateway/src/v3/memory.ts) ---- */
  memoryList: (signed: SignedFields): Promise<{ items: MemoryKeyView[] } & MemoryQuota> => MOCK ? mock().then((m) => m.memoryList()) : req(`/memory`, signedGet(signed)),
  memoryGet: (key: string, signed: SignedFields): Promise<{ value: unknown; size: number }> => MOCK ? mock().then((m) => m.memoryGet(key)) : req(`/memory/${encodeURIComponent(key)}`, signedGet(signed)),
  memoryPut: (key: string, signed: SignedFields, value: unknown): Promise<MemoryQuota> => MOCK ? mock().then((m) => m.memoryPut(key, typeof value === "string" ? value : JSON.stringify(value))) : req(`/memory/${encodeURIComponent(key)}`, { ...json({ ...signed, value }), method: "PUT" }),
  memoryDelete: (key: string, signed: SignedFields): Promise<MemoryQuota> => MOCK ? mock().then((m) => m.memoryDelete(key)) : req(`/memory/${encodeURIComponent(key)}`, signedGet(signed, "DELETE")),

  /* ---- webhooks (G.) — not wired into a page (not in the "## W." page list); kept for completeness. ---- */
  webhooksMine: (signed: SignedFields): Promise<{ items: WebhookView[] }> => MOCK ? mock().then((m) => m.webhooksMine()) : req(`/webhooks/mine`, signedGet(signed)),
  webhookSet: (signed: SignedFields, payload: { url: string; secret: string; events: WebhookEvent[] }): Promise<WebhookView> => MOCK ? mock().then((m) => m.webhookSet(payload.url, payload.events)) : req(`/webhooks`, json({ ...signed, ...payload })),
  webhookDelete: (id: number, signed: SignedFields): Promise<void> => MOCK ? mock().then((m) => m.webhookDelete(id)).then(() => undefined) : req(`/webhooks/${id}`, signedGet(signed, "DELETE")),

  /* ---- pay-in USDC -> FMX (G., gateway/src/v3/payin.ts) ---- */
  payinAssets: (): Promise<PayinAssets> => MOCK ? mock().then((m) => m.payinAssets()) : req(`/payin/assets`),
  payinQuote: (p: PayinQuoteRequest): Promise<PayinQuote> => MOCK ? mock().then((m) => m.payinQuote(p)) : req(`/payin/quote`, json({ chain: p.chain, asset: p.asset, amount: p.amount, to: p.to, ...(p.from ? { from: p.from } : {}) })),
  payinStatus: (quoteId: string): Promise<PayinStatus> => MOCK ? mock().then((m) => m.payinStatus(quoteId)) : req(`/payin/${encodeURIComponent(quoteId)}`),

  /* ---- audit export (G.) ---- */
  auditUrl: (agentId: number, range?: { from?: number; to?: number }) => `${config.gateway}/agents/${agentId}/audit.jsonl${qs(range || {})}`,

  /* ---- mock-mode on-chain write simulation ----
   * Pages call these only inside `if (config.mock)` guards, instead of real contractWrite/sendCall,
   * so the demo state (vault balance, sessions, streams, votes, curve reserves…) actually changes and
   * re-renders show it. Routed through the `mock()` dynamic import this module already uses for every
   * read above — a bare `import("../mockEconomy")` from a *page* file resolved to a chunk whose
   * namespace was missing its named exports under this Vite/Rollup config, so every write goes through
   * this one proven-working import site instead. */
  mockDeposit: (amount: bigint) => mk().then((m) => m.x402Deposit(amount)),
  mockPayinSent: (quoteId: string, txHash: string) => mk().then((m) => m.markPayinSent(quoteId, txHash)),
  mockRequestUnlock: () => mk().then((m) => m.x402RequestUnlock()),
  mockWithdraw: (amount: bigint) => mk().then((m) => m.x402Withdraw(amount)),
  mockAddSession: (account: string, key: string, capPerDayWei: string, expiry: number, targets: string[]) => mk().then((m) => m.addSession(account, key, capPerDayWei, expiry, targets)),
  mockRevokeSession: (account: string, key: string) => mk().then((m) => m.revokeSession(account, key)),
  mockLaunchToken: (agentId: number, symbol: string, baseWei: string, slope: string) => mk().then((m) => m.launchToken(agentId, symbol, baseWei, slope)),
  mockQuoteBuy: (symbol: string, fmxIn: bigint) => mk().then((m) => m.quoteBuy(symbol, fmxIn)),
  mockQuoteSell: (symbol: string, amountIn: bigint) => mk().then((m) => m.quoteSell(symbol, amountIn)),
  mockBuyToken: (symbol: string, fmxIn: bigint) => mk().then((m) => m.buyToken(symbol, fmxIn)),
  mockSellToken: (symbol: string, amountIn: bigint) => mk().then((m) => m.sellToken(symbol, amountIn)),
  mockJoinPool: (addr: string, amount: bigint) => mk().then((m) => m.joinPool(addr, amount)),
  mockLeavePool: (addr: string) => mk().then((m) => m.leavePool(addr)),
  mockSubmitEvidence: (caseId: number, by: string, uri: string) => mk().then((m) => m.submitEvidence(caseId, by, uri)),
  mockVoteCase: (caseId: number, by: string, clientBps: number) => mk().then((m) => m.voteCase(caseId, by, clientBps)),
  mockCloseCase: (caseId: number) => mk().then((m) => m.closeCase(caseId)),
  mockSubscribe: (planId: number, periods: number) => mk().then((m) => m.subscribe(planId, periods)),
  mockOpenStream: (payee: string, ratePerSecWei: string, depositWei: string) => mk().then((m) => m.openStream(payee, ratePerSecWei, depositWei)),
  mockClaimStream: (id: number) => mk().then((m) => m.claimStream(id)),
  mockCancelStream: (id: number) => mk().then((m) => m.cancelStream(id)),
  mockCancelSub: (id: number) => mk().then((m) => m.cancelSub(id)),
  mockCreatePlan: (priceWei: string, periodSec: number, name: string) => mk().then((m) => m.createPlan(priceWei, periodSec, name)),
  mockSetPlanActive: (planId: number, active: boolean) => mk().then((m) => m.setPlanActive(planId, active)),
};

/** Matches gateway/src/v3/a2a.ts slugify() exactly (lowercase, NFKD-normalised, non-alphanumerics -> "-"). */
export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agent";
}

async function hydrateToken(row: AgentTokenRow): Promise<AgentTokenView> {
  const agent = { address: row.owner ?? "", name: row.agentName ?? null, agentId: row.agentId };
  if (!tokenFactoryDeployed) return { ...row, agent };
  try {
    const factory = contractRead(config.tokenFactory, TOKEN_FACTORY_ABI);
    const token = contractRead(row.token, AGENT_TOKEN_ABI);
    const [curve, price, supply, totalDistributed] = await Promise.all([
      factory.getCurve(row.token) as Promise<{ base: bigint; slope: bigint; reserve: bigint }>,
      factory.price(row.token) as Promise<bigint>,
      token.totalSupply() as Promise<bigint>,
      token.totalDistributed().catch(() => 0n) as Promise<bigint>,
    ]);
    return { ...row, agent, base: curve.base.toString(), slope: curve.slope.toString(), reserveWei: curve.reserve.toString(), priceWei: price.toString(), supply: supply.toString(), totalDistributed: totalDistributed.toString() };
  } catch { return { ...row, agent }; }
}
