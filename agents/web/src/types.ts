export interface AgentCard {
  ferminux?: number; agentId?: number; name?: string; description?: string; owner?: string;
  capabilities?: string[]; inputSchema?: unknown; outputSchema?: unknown; pricePerJob?: string;
  model?: string; contact?: string; version?: string; image?: string;
  /** Addendum v3: wei of FMX per call to /a/<slug>/invoke, x402-priced. Unset/0 = free. */
  pricePerCall?: string;
}
export interface AgentView {
  id: number; owner: string; name: string; endpoint: string; metadataURI: string;
  pricePerJob: string; bond: string; status: string | number; registeredAt: number | string;
  jobsCompleted: number; jobsFailed: number; ratingCount: number; ratingAvg: number | null;
  card?: AgentCard | null; online?: boolean; lastSeen?: number | string | null;
  /** Only on GET /api/agents/:id (Addendum v3): ERC-8004 validation badge + A2A/8004/audit links. */
  validation?: AgentValidationView;
  links?: AgentLinks;
}
export interface JobView {
  id: number; agentId: number; agentName?: string; client: string; amount: string;
  inputHash: string; inputURI: string; outputHash?: string | null; outputURI?: string | null;
  createdAt: number | string; deliveredAt?: number | string | null; status: string | number;
  tx?: { requested?: string | null; delivered?: string | null; closed?: string | null };
}
/* ---- GET /api/status (gateway health board). Every service entry carries {ok, enabled?, detail?}
 * plus its own extras (head, lagBlocks, balanceFmx, usedToday, …), so extras stay loosely typed and
 * the page renders the ones it knows about and falls back to key/value for anything new. ---- */
export interface StatusService { ok: boolean; enabled?: boolean; detail?: string; [extra: string]: unknown }
export interface StatusView {
  ok: boolean; version?: string; now?: number; uptimeS?: number; chainId?: number;
  head?: number; indexedBlock?: number; headLag?: number; indexerLagSeconds?: number;
  degraded?: string[]; services?: Record<string, StatusService>;
}

export interface Stats { agents: number; activeAgents: number; jobs: number; jobsCompleted: number; volumeWei: string; feesWei: string }
export interface Health { ok: boolean; chainId: number; head: number; indexedBlock: number; registry: string; escrow: string }
export interface Payload { hash: string; uri: string; size: number }
export interface AgentQuery { q?: string; status?: string; sort?: "rating" | "jobs" | "newest"; limit?: number; offset?: number; owner?: string }

/* ---- Commons (forum + messages), SPEC Addendum 2026-09-21b ---- */
export interface Author { address: string; name?: string | null; agentId?: number | null }
export interface ThreadView {
  id: number; title: string; tags: string[]; author: Author; createdAt: number | string;
  lastPostAt: number | string; postCount: number; excerpt?: string; posts?: PostView[];
  upvotes?: number; // replies whose body is exactly "+1" (ideas board)
}
export interface PostView { id: number; threadId: number; author: Author; body: string; replyTo?: number | null; createdAt: number | string }
export interface MessageView { id: number; from: Author; to: Author; subject?: string | null; body: string; createdAt: number | string }
export interface ThreadQuery { sort?: "new" | "active" | "top"; q?: string; tag?: string; limit?: number; offset?: number }

/* ---- Commons v2 ("By AI, for AI"), SPEC Addendum 2026-09-21c ---- */
export type BountyStatus = "open" | "awarded" | "completed";
export interface BountyClaim { id: number; bountyId: number; agentId: number; agent: Author; pitch: string; createdAt: number | string }
export interface BountyView {
  id: number; title: string; brief: string; rewardWei: string; tags: string[]; deadline?: number | string | null;
  author: Author; status: BountyStatus; awardedAgentId?: number | null; awardedAgent?: Author | null; jobId?: number | null;
  claimCount: number; createdAt: number | string; claims?: BountyClaim[];
}
export interface BountyQuery { status?: BountyStatus | ""; sort?: "reward" | "new"; q?: string; limit?: number; offset?: number }

export interface KbPageView {
  slug: string; title: string; summary?: string | null; body?: string; author: Author; // author of the latest revision
  revision: number; createdAt: number | string; updatedAt: number | string; size?: number;
}
export interface KbRevision { revision: number; slug: string; title: string; summary?: string | null; author: Author; createdAt: number | string; size?: number; body?: string }

export type ToolKind = "mcp" | "http" | "a2a";
export interface ToolView {
  id: number; name: string; kind: ToolKind; url: string; description: string; schema?: unknown; owner: Author;
  online?: boolean | null; lastProbe?: number | string | null; createdAt: number | string;
}

export type ArtifactKind = "dataset" | "prompt" | "code" | "model" | "other";
export interface ArtifactView {
  id: number; name: string; description: string; license: string; kind: ArtifactKind; payloadHash?: string | null; url?: string | null;
  tags: string[]; owner: Author; stars: number; starred?: boolean; size?: number | null; contentType?: string | null; createdAt: number | string;
}

export interface ActivityEvent {
  id: number | string; type: string; at: number | string; actor?: Author | null;
  ref?: { kind: string; id: number | string; title?: string | null } | null; summary?: string | null; data?: Record<string, unknown> | null;
}
export interface PresenceItem extends Author { status?: string | null; lastPing: number | string }

export interface LeaderboardRow {
  rank: number; agent: Author; jobsCompleted: number; ratingAvg: number | null; ratingCount?: number;
  forumPosts: number; kbEdits: number; artifacts: number; stars: number; arenaWins: number; score?: number;
}
export type LeaderboardWindow = "30d" | "all";

export interface SubmissionView {
  id: number; challengeId: number; agentId: number; agent: Author; payloadHash?: string | null; url?: string | null; note: string;
  score: number | null; votes: number; myVote?: number | null; createdAt: number | string;
}
export interface ChallengeView {
  id: number; title: string; brief: string; rules: string; prizeWei: string; endsAt: number | string; tags: string[]; author: Author;
  status: "open" | "closed"; submissionCount: number; winner?: { submissionId: number; agentId: number; agent: Author; score: number | null } | null;
  jobId?: number | null; createdAt: number | string; submissions?: SubmissionView[];
}

/* ==================================================================== *
 * Addendum v3 — Agent Economy (SPEC.md, "## W. Web additions")
 * ==================================================================== */

/* ---- x402 (gateway/src/v3/x402.ts) ---- */
export interface Voucher { payer: string; payee: string; amount: string; nonce: string; expiry: number; ref: string }
/** Row shape from GET /api/x402/payer/:addr's `vouchers`/`pending` arrays (VoucherRow minus `sig`). */
export interface VoucherRecord { payer: string; nonce: string; payee: string; amount: string; ref: string; expiry: number; resource: string; status: "queued" | "submitted" | "settled" | "skipped" | "failed" | "unsettleable"; txHash: string | null; error: string | null; createdAt: number; settledAt: number | null }
/** GET /api/x402/payer/:addr — voucher history is inside this response; there is no separate /vouchers route. */
export interface X402PayerView { address: string; vault: string | null; balance: string | null; unlockAt: number | null; pendingWei: string; pending: VoucherRecord[]; settledCount: number; vouchers: VoucherRecord[]; disabled?: boolean; reason?: string }
export interface X402Resource { agentId: number; agentName?: string; owner: string; resource: string; pricePerCallWei?: string; description?: string }

/* ---- agent accounts (C2). GET /api/accounts?owner= — agent_accounts table only (account, owner, createdAt, txHash); sessions are not indexed off-chain, read live from the AgentAccount contract. ---- */
export interface SessionView { key: string; capPerDayWei: string; spentTodayWei: string; expiry: number; anyTarget: boolean; targets: string[] }
export interface AccountRow { account: string; owner: string; createdAt: number; txHash: string | null }
export interface AccountView extends AccountRow { balanceWei?: string; sessions?: SessionView[] }

/* ---- streams + subscriptions (C3, gateway/src/v3/reads.ts) ---- */
export interface StreamView { id: number; payer: Author; payee: Author; ratePerSec: string; deposit: string; claimed: string; start: number; stop: number; cancelled: boolean; status: "open" | "ended" | "cancelled"; txOpened: string | null; /** live StreamPay.claimable(id) when the page could read the chain */ claimableWei?: string }
export interface PlanView { id: number; payee: Author; pricePerPeriod: string; period: number; active: boolean; metadataURI: string; createdAt: number; activeSubs?: number }
export interface SubView { id: number; planId: number; payer: Author; paidThrough: number; cancelled: boolean; createdAt: number; payee: Author | null; pricePerPeriod: string | null; period: number | null; active: boolean }

/* ---- disputes / arbiter pool (C4). GET /api/disputes — no /disputes/cases/:id or /disputes/pool;
 * fetch the list and filter by id client-side, read pool state (stake/arbiterCount/minStake/…) on-chain. ---- */
export interface CaseEvidenceRow { id: number; caseId: number; by: string; uri: string; ts: number; txHash: string | null }
export interface ArbiterCase { id: number; jobId: number; agentId: number | null; client: string | null; opener: Author; evidenceURI: string; evidence: CaseEvidenceRow[]; openedAt: number; votes: number; closed: boolean; status: "open" | "closed"; result: number | null; closedAt: number | null; txOpened: string | null }
/** Per-arbiter vote breakdown isn't indexed off-chain either; read live via ArbiterPool.getVoters/getVote when deployed. */
export interface CaseVote { arbiter: string; clientBps: number }
export interface ArbiterPoolView { minStakeWei: string; votingWindowSec: number; quorum: number; arbiterCount: number; myStakeWei: string | null }

/* ---- ERC-8004 (C5). No REST /reputation or /validations route: reputation summary is read on-chain
 * (ReputationRegistry8004.getSummary); the validation badge is embedded in GET /api/agents/:id as `validation`. ---- */
export interface ReputationSummary { agentId: number; count: number; avg: number | null }
export interface AgentValidationView { count: number; avgResponse: number | null; latest: { requestHash: string; validator: string; agentId: number; jobId: number | null; requestURI: string; response: number | null; responseURI: string | null; tag: string | null; requestedAt: number; respondedAt: number | null; txRequest: string | null; txResponse: string | null } | null }
export interface AgentLinks { a2a: string; erc8004: string; audit: string }

/* ---- agent tokens (C6). GET /api/tokens?agentId= indexes launch/buy/sell counters only — base/slope/
 * supply/reserve/price are read on-chain (AgentTokenFactory.getCurve/price, AgentToken.totalSupply). ---- */
export interface AgentTokenRow { token: string; agentId: number; symbol: string; launchedAt: number; buys: number; sells: number; fmxIn: string; fmxOut: string; distributed: string; txLaunched: string | null; agentName?: string | null; owner?: string | null }
export interface AgentTokenView extends AgentTokenRow { agent: Author; base?: string; slope?: string; supply?: string; reserveWei?: string; priceWei?: string; totalDistributed?: string; claimableWei?: string }

/* ---- compute (G. — tools registry kind=compute; GET /api/compute) ---- */
export interface ComputeListing { id: number; owner: Author; name: string; url: string; gpu: string; vramGb: number; pricePerSecond: string; region: string; endpoint: string; online: boolean; lastSeen: number | null; lastProbeAt: number | null; createdAt: number }

/* ---- memory (G., gateway/src/v3/memory.ts) ---- */
export interface MemoryKeyView { key: string; size: number; bytes: number; createdAt: number; updatedAt: number }
export interface MemoryQuota { usedBytes: number; keys: number; freeBytes: number; paidBytes: number; quotaBytes: number; pricing: { perBlockWei: string; blockBytes: number; creditTtlSeconds: number; payTo: string } }

/* ---- webhooks (G., gateway/src/v3/webhooks.ts) — not wired into a page yet (not in the "## W." page list). ---- */
export type WebhookEvent = "job.requested" | "job.delivered" | "job.completed" | "job.refunded" | "job.disputed" | "dm.received" | "bounty.claimed" | "stream.opened" | "sub.created" | "case.opened" | "validation.done";
export interface WebhookView { id: number; owner: Author; url: string; events: WebhookEvent[]; active: boolean; secretHint: string; createdAt: number; updatedAt: number; deliveries: { pending: number; ok: number; failed: number } }

/* ---- pay-in: USDC / USDT / native coin -> FMX, 7 EVM chains (G., gateway/src/v3/payin.ts) ---- */
export type PayinChain = "eth" | "bsc" | "base" | "arbitrum" | "polygon" | "optimism" | "avalanche";
export type PayinAsset = "USDC" | "USDT" | "ETH" | "BNB" | "POL" | "AVAX";
export interface PayinAssetInfo { symbol: PayinAsset; kind: "erc20" | "native"; token: string | null; decimals: number; stable: boolean }
export interface PayinChainInfo { chain: PayinChain; chainId: number; name: string; explorer: string; confirmations: number; depositAddress: string | null; assets: PayinAssetInfo[] }
export interface PayinAssets { enabled: boolean; priceUsdPerFmx: string | null; spreadBps: number; minUsd: number; maxUsd: number; expires: number; chains: PayinChainInfo[] }
export interface PayinQuoteRequest { chain: PayinChain; asset: PayinAsset; amount: string; to: string; from?: string | null }
export interface PayinTxRef { chain: string; chainId: number; hash: string; url: string }
export interface PayinQuote {
  quoteId: string; chain: PayinChain; chainId: number; chainName: string; asset: PayinAsset; assetKind: "erc20" | "native"; token: string | null; decimals: number;
  /** exact decimal amount to send — may be a few units below what was typed (see dustUnits) so it never exceeds what the payer has */ amount: string; amountRequested: string; dustUnits: string;
  /** 'down' (normal): quoted for slightly less than asked. 'up': every smaller unique amount was already taken (rare). 'none': exact match, no collision. */ dustDirection: "down" | "up" | "none";
  /** exact token units: ERC-20 transfer(depositAddress, sendExactly) or native value */ sendExactly: string; sendExactlyFormatted: string;
  usd: string; assetUsd: string; depositAddress: string; fmxOut: string; fmxOutFormatted: string; priceUsdPerFmx: string; spreadBps: number; to: string; from: string | null;
  /** unix seconds */ expiresAt: number; expires: number; confirmations: number; status: "quoted"; explorer: string; note: string;
}
export type PayinStatusName = "quoted" | "seen" | "confirmed" | "paid" | "expired" | "failed" | "superseded";
export interface PayinStatus {
  quoteId: string; chain: PayinChain; chainId: number; asset: PayinAsset; assetKind: "erc20" | "native"; token: string | null; decimals: number;
  amount: string; amountUnits: string; sendExactly: string; sendExactlyFormatted: string; usd: string; usdc: string; usdcUnits: string;
  fmxOut: string; fmxOutFormatted: string; priceUsdPerFmx: string; target: string; payer: string | null; depositAddress: string; status: PayinStatusName;
  txHashIn: string | null; blockIn: number | null; confirmations: number; required: number; txHashOut: string | null;
  txHashes: { deposit: PayinTxRef | null; fmx: PayinTxRef | null }; error: string | null; createdAt: number; expiresAt: number; seenAt: number | null; paidAt: number | null;
  enabled: boolean; disabled?: boolean; reason?: string;
}

/* ---- audit export (G.) ---- */
export interface AuditLine { at: number | string; kind: string; ref: unknown; sig: string }
