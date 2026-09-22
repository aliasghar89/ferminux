// Shared contract ABI fragments (ethers v6 human-readable ABI).
// SOURCE OF TRUTH: agents/sdk/src/abi.ts — copied verbatim into agents/gateway/src/abi.ts.
// Keep both files byte-identical when the spec's ABI changes. See agents/SPEC.md.

export const REGISTRY_ABI = [
  "function register(string name, string endpoint, string metadataURI, uint256 pricePerJob) payable returns (uint256 id)",
  "function update(uint256 id, string endpoint, string metadataURI, uint256 pricePerJob)",
  "function setStatus(uint256 id, uint8 status)",
  "function retire(uint256 id)",
  "function withdrawBond(uint256 id)",
  "function topUpBond(uint256 id) payable",
  "function transferOwnership(uint256 id, address newOwner)",
  "function slash(uint256 id, uint256 amount, address to, string reason)",
  "function recordOutcome(uint256 id, bool success, uint8 rating)",
  "function setMinBond(uint256 minBond_)",
  "function setEscrow(address escrow_)",
  "function setGovernance(address governance_)",
  "function getAgent(uint256 id) view returns (tuple(address owner, string name, string endpoint, string metadataURI, uint256 pricePerJob, uint256 bond, uint64 registeredAt, uint64 retiredAt, uint8 status, uint32 jobsCompleted, uint32 jobsFailed, uint32 ratingCount, uint32 ratingSum) agent)",
  "function isActive(uint256 id) view returns (bool)",
  "function minBond() view returns (uint256)",
  "function BOND_COOLDOWN() view returns (uint64)",
  "function governance() view returns (address)",
  "function escrow() view returns (address)",
  "function nextId() view returns (uint256)",
  "event AgentRegistered(uint256 indexed id, address indexed owner, string name, string endpoint, string metadataURI, uint256 pricePerJob, uint256 bond)",
  "event AgentUpdated(uint256 indexed id, string endpoint, string metadataURI, uint256 pricePerJob)",
  "event AgentStatusChanged(uint256 indexed id, uint8 status)",
  "event BondChanged(uint256 indexed id, uint256 bond)",
  "event AgentSlashed(uint256 indexed id, uint256 amount, address to, string reason)",
  "event OutcomeRecorded(uint256 indexed id, bool success, uint8 rating)",
  "event OwnershipTransferred(uint256 indexed id, address indexed from, address indexed to)",
] as const;

export const ESCROW_ABI = [
  "function requestJob(uint256 agentId, bytes32 inputHash, string inputURI) payable returns (uint256 jobId)",
  "function deliver(uint256 jobId, bytes32 outputHash, string outputURI)",
  "function release(uint256 jobId, uint8 rating)",
  "function claim(uint256 jobId)",
  "function refund(uint256 jobId)",
  "function cancel(uint256 jobId)",
  "function dispute(uint256 jobId)",
  "function resolve(uint256 jobId, uint16 clientBps)",
  "function withdraw()",
  "function getJob(uint256 id) view returns (tuple(uint256 agentId, address client, uint256 amount, bytes32 inputHash, bytes32 outputHash, string inputURI, string outputURI, uint64 createdAt, uint64 deliveredAt, uint8 status) job)",
  "function setFee(uint16 bps)",
  "function setWindows(uint64 delivery, uint64 review)",
  "function setFeeRecipient(address recipient)",
  "function setGovernance(address governance_)",
  "function registry() view returns (address)",
  "function governance() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function deliveryWindow() view returns (uint64)",
  "function reviewWindow() view returns (uint64)",
  "function credits(address account) view returns (uint256)",
  "function nextJobId() view returns (uint256)",
  "event JobRequested(uint256 indexed jobId, uint256 indexed agentId, address indexed client, uint256 amount, bytes32 inputHash, string inputURI)",
  "event JobDelivered(uint256 indexed jobId, bytes32 outputHash, string outputURI)",
  "event JobCompleted(uint256 indexed jobId, uint256 agentPayout, uint256 fee, uint8 rating)",
  "event JobRefunded(uint256 indexed jobId, uint256 amount, bool byAgent)",
  "event JobDisputed(uint256 indexed jobId)",
  "event JobResolved(uint256 indexed jobId, uint256 clientAmount, uint256 agentPayout, uint256 fee)",
  "event Withdrawn(address indexed to, uint256 amount)",
] as const;

// enum AgentRegistry.Status
export const AgentStatus = {
  None: 0,
  Active: 1,
  Paused: 2,
  Retired: 3,
} as const;
export const AgentStatusName = ["None", "Active", "Paused", "Retired"] as const;

// enum ServiceEscrow.JobStatus
export const JobStatusEnum = {
  None: 0,
  Open: 1,
  Delivered: 2,
  Completed: 3,
  Refunded: 4,
  Disputed: 5,
  Resolved: 6,
} as const;
export const JobStatusName = [
  "None",
  "Open",
  "Delivered",
  "Completed",
  "Refunded",
  "Disputed",
  "Resolved",
] as const;

// ---------------------------------------------------------------------------
// Addendum v3 — Agent Economy (SPEC.md "## C1"–"## C6"). These fragments are
// generated from the AS-BUILT ABIs the contracts lane published under
// contracts/abi/<Name>.json (via `new Interface(json).forEach{Function,Event}
// -> fragment.format("full")`), not hand-transcribed from SPEC.md — so they
// are byte-accurate to the deployed bytecode's selectors, including a few
// names SPEC.md's prose didn't spell out exactly (e.g. StreamPay's
// getStream/getPlan/getSub instead of public mapping getters, ArbiterPool's
// getCase, and the ERC-8004 registries' real multi-arg read shapes). Not
// deployed yet as of this writing (deployments.3961.json has no v3 keys) —
// see networks.ts / v3/shared.ts's NotDeployed.
// ---------------------------------------------------------------------------

/** C1 — X402Vault: pay-per-request in native FMX (EIP-712 vouchers, see sign.ts). */
export const X402_VAULT_ABI = [
  "function deposit() payable",
  "function depositFor(address payer) payable",
  "function requestUnlock()",
  "function withdraw(uint256 amount)",
  "function settle(tuple(address payer, address payee, uint256 amount, uint256 nonce, uint64 expiry, bytes32 ref) v, bytes sig)",
  "function settleBatch(tuple(address payer, address payee, uint256 amount, uint256 nonce, uint64 expiry, bytes32 ref)[] vs, bytes[] sigs)",
  "function withdrawCredits()",
  "function verify(tuple(address payer, address payee, uint256 amount, uint256 nonce, uint64 expiry, bytes32 ref) v, bytes sig) view returns (bool ok, string reason)",
  "function hashVoucher(tuple(address payer, address payee, uint256 amount, uint256 nonce, uint64 expiry, bytes32 ref) v) view returns (bytes32)",
  "function balance(address) view returns (uint256)",
  "function unlockAt(address) view returns (uint256)",
  "function used(address, uint256) view returns (bool)",
  "function credits(address) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function governance() view returns (address)",
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function VOUCHER_TYPEHASH() view returns (bytes32)",
  "function UNLOCK_DELAY() view returns (uint64)",
  "function setFee(uint16 bps)",
  "function setFeeRecipient(address recipient)",
  "function setGovernance(address newGovernance)",
  "event Deposited(address indexed payer, uint256 amount)",
  "event Settled(address indexed payer, address indexed payee, uint256 amount, uint256 fee, uint256 nonce, bytes32 ref)",
  "event Skipped(address indexed payer, uint256 nonce, string reason)",
  "event UnlockRequested(address indexed payer, uint64 at)",
  "event Withdrawn(address indexed to, uint256 amount)",
  "event CreditsWithdrawn(address indexed to, uint256 amount)",
] as const;

/** C2 — AgentAccount: EIP-1167 clone instance (policy wallet + session keys + ERC-1271). */
export const AGENT_ACCOUNT_ABI = [
  "function initialize(address owner_)",
  "function addSession(address key, uint256 capPerDay, uint64 expiry, address[] targets)",
  "function revokeSession(address key)",
  "function execute(address to, uint256 value, bytes data) returns (bytes)",
  "function executeBatch(address[] to, uint256[] value, bytes[] data)",
  "function executeWithSig(address to, uint256 value, bytes data, uint64 deadline, bytes sig) returns (bytes)",
  "function hashExecute(address to, uint256 value, bytes32 dataHash, uint256 nonce_, uint64 deadline) view returns (bytes32)",
  "function isValidSignature(bytes32 hash, bytes sig) view returns (bytes4)",
  "function isSigner(address key) view returns (bool)",
  "function transferOwnership(address newOwner)",
  "function owner() view returns (address)",
  "function nonce() view returns (uint256)",
  "function sessions(address) view returns (uint256 capPerDay, uint256 spentToday, uint64 dayStart, uint64 expiry, bool anyTarget)",
  "function sessionTargets(address key) view returns (address[])",
  "function allowedTarget(address, address) view returns (bool)",
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function EXECUTE_TYPEHASH() view returns (bytes32)",
  "event SessionAdded(address indexed key, uint256 capPerDay, uint64 expiry)",
  "event SessionRevoked(address indexed key)",
  "event Executed(address indexed by, address indexed to, uint256 value, bool ok)",
  "event Initialized(address indexed owner)",
  "event OwnershipTransferred(address indexed previous, address indexed current)",
  "event Received(address indexed from, uint256 amount)",
] as const;

/** C2 — AgentAccountFactory: EIP-1167 minimal-proxy deployer for AgentAccount. */
export const AGENT_ACCOUNT_FACTORY_ABI = [
  "function create(address owner, bytes32 salt) returns (address account)",
  "function predict(address owner, bytes32 salt) view returns (address)",
  "function implementation() view returns (address)",
  "function isAccount(address) view returns (bool)",
  "function accountCount(address) view returns (uint256)",
  "event AccountCreated(address indexed owner, address indexed account)",
] as const;

/** C3 — StreamPay: per-second payment streams + subscription plans. */
export const STREAM_PAY_ABI = [
  "function openStream(address payee, uint256 ratePerSec) payable returns (uint256 id)",
  "function topUp(uint256 id) payable",
  "function cancelStream(uint256 id)",
  "function claimable(uint256 id) view returns (uint256)",
  "function claimStream(uint256 id)",
  "function createPlan(uint256 pricePerPeriod, uint64 period, string metadataURI) returns (uint256 planId)",
  "function setPlanActive(uint256 planId, bool active)",
  "function subscribe(uint256 planId, uint32 periods) payable returns (uint256 subId)",
  "function renew(uint256 subId, uint32 periods) payable",
  "function cancelSub(uint256 subId)",
  "function claimSub(uint256 subId)",
  "function dueSubPeriods(uint256 subId) view returns (uint256)",
  "function isSubscribed(uint256 planId, address payer) view returns (bool)",
  "function subOf(uint256, address) view returns (uint256)",
  "function credits(address) view returns (uint256)",
  "function withdraw()",
  "function feeBps() view returns (uint16)",
  "function getStream(uint256 id) view returns (tuple(address payer, address payee, uint256 ratePerSec, uint256 deposit, uint256 withdrawn, uint64 start, uint64 stop, bool cancelled))",
  "function getPlan(uint256 planId) view returns (tuple(address payee, uint256 pricePerPeriod, uint64 period, bool active, string metadataURI))",
  "function getSub(uint256 subId) view returns (tuple(uint256 planId, address payer, uint64 paidThrough, bool cancelled, uint256 prepaid))",
  "function nextStreamId() view returns (uint256)",
  "function nextPlanId() view returns (uint256)",
  "function nextSubId() view returns (uint256)",
  "function setFee(uint16 bps)",
  "function setFeeRecipient(address recipient)",
  "function setGovernance(address newGovernance)",
  "event StreamOpened(uint256 indexed id, address indexed payer, address indexed payee, uint256 ratePerSec, uint256 deposit, uint64 start, uint64 stop)",
  "event StreamToppedUp(uint256 indexed id, uint256 amount, uint256 deposit, uint64 stop)",
  "event StreamClaimed(uint256 indexed id, uint256 payeeAmount, uint256 fee)",
  "event StreamCancelled(uint256 indexed id, address indexed by, uint256 payeeAmount, uint256 fee, uint256 refund)",
  "event PlanCreated(uint256 indexed planId, address indexed payee, uint256 pricePerPeriod, uint64 period, string metadataURI)",
  "event PlanActiveSet(uint256 indexed planId, bool active)",
  "event Subscribed(uint256 indexed subId, uint256 indexed planId, address indexed payer, uint32 periods, uint64 paidThrough)",
  "event SubRenewed(uint256 indexed subId, uint32 periods, uint64 paidThrough)",
  "event SubCancelled(uint256 indexed subId, uint256 refund)",
  "event SubClaimed(uint256 indexed subId, uint256 periods, uint256 payeeAmount, uint256 fee)",
  "event Withdrawn(address indexed to, uint256 amount)",
] as const;

/** C4 — ArbiterPool: dispute arbitration for ServiceEscrow. */
export const ARBITER_POOL_ABI = [
  "function joinPool() payable",
  "function leavePool()",
  "function openCase(uint256 jobId, string evidenceURI) payable returns (uint256 caseId)",
  "function submitEvidence(uint256 caseId, string uri)",
  "function vote(uint256 caseId, uint16 clientBps)",
  "function close(uint256 caseId)",
  "function forward(address target, bytes data) returns (bytes ret)",
  "function setParams(uint256 minStake_, uint64 votingWindow_, uint8 quorum_)",
  "function minStake() view returns (uint256)",
  "function votingWindow() view returns (uint64)",
  "function quorum() view returns (uint8)",
  "function stake(address) view returns (uint256)",
  "function credits(address) view returns (uint256)",
  "function withdraw()",
  "function isArbiter(address a) view returns (bool)",
  "function arbiterCount() view returns (uint256)",
  "function leaveAt(address) view returns (uint64)",
  "function pendingVotes(address) view returns (uint256)",
  "function getCase(uint256 caseId) view returns (tuple(uint256 jobId, address opener, string evidenceURI, uint64 openedAt, uint16 result, uint8 votes, bool closed))",
  "function getEvidence(uint256 caseId) view returns (string[])",
  "function getVote(uint256 caseId, address arbiter) view returns (bool cast, uint16 clientBps)",
  "function getVoters(uint256 caseId) view returns (address[])",
  "function nextCaseId() view returns (uint256)",
  "function registry() view returns (address)",
  "function escrow() view returns (address)",
  "event ArbiterJoined(address indexed arbiter, uint256 stake)",
  "event ArbiterLeaving(address indexed arbiter, uint64 at)",
  "event ArbiterLeft(address indexed arbiter, uint256 stake)",
  "event CaseOpened(uint256 indexed caseId, uint256 indexed jobId, address indexed opener, string evidenceURI)",
  "event EvidenceSubmitted(uint256 indexed caseId, address indexed by, string uri)",
  "event Voted(uint256 indexed caseId, address indexed arbiter, uint16 clientBps)",
  "event CaseClosed(uint256 indexed caseId, uint256 indexed jobId, uint16 clientBps)",
  "event Rewarded(uint256 indexed caseId, address indexed arbiter, uint256 amount)",
  "event Withdrawn(address indexed to, uint256 amount)",
] as const;

/** C5 — IdentityRegistry8004: ERC-8004 identity view over AgentRegistry (register() always reverts — use AgentRegistry.register). */
export const IDENTITY_8004_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function agentURI(uint256 agentId) view returns (string)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256 count)",
  "function registry() view returns (address)",
  "function getVersion() pure returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
] as const;

/** C5 — ReputationRegistry8004. Feedback is indexed per (agentId, clientAddress) — most reads take a `clientAddresses` filter (pass [] for no filter). */
export const REPUTATION_8004_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function syncFromEscrow(uint256 jobId) returns (uint64 feedbackIndex)",
  "function syncedJob(uint256) view returns (bool)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] responders) view returns (uint64 count)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string responseURI, bytes32 responseHash)",
  "function identityRegistry() view returns (address)",
  "function escrow() view returns (address)",
  "function getVersion() pure returns (string)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)",
  "event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)",
  "event EscrowSynced(uint256 indexed jobId, uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value)",
] as const;

/** C5 — ValidationRegistry8004: verifiable-delivery validation requests/responses. */
export const VALIDATION_8004_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 avgResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[])",
  "function hasResponse(bytes32 requestHash) view returns (bool)",
  "function identityRegistry() view returns (address)",
  "function getVersion() pure returns (string)",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
] as const;

/** C6 — AgentTokenFactory: bonding-curve agent tokens (linear curve, priced in FMX). Sell proceeds are pull-payment: `credits`/`withdraw()`. */
export const AGENT_TOKEN_FACTORY_ABI = [
  "function launch(uint256 agentId, string symbol, uint256 base, uint256 slope) returns (address token)",
  "function buy(address token, uint256 minOut) payable",
  "function sell(address token, uint256 amount, uint256 minFmx)",
  "function quoteBuy(address token, uint256 fmxIn) view returns (uint256 out)",
  "function quoteSell(address token, uint256 amountIn) view returns (uint256 fmxOut)",
  "function distribute(address token) payable",
  "function claimDistribution(address token)",
  "function claimable(address token, address holder) view returns (uint256)",
  "function tokenOf(uint256) view returns (address)",
  "function tokens(uint256) view returns (address)",
  "function tokenCount() view returns (uint256)",
  "function getCurve(address token) view returns (tuple(uint256 agentId, uint256 base, uint256 slope, uint256 reserve))",
  "function credits(address) view returns (uint256)",
  "function withdraw()",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function governance() view returns (address)",
  "function registry() view returns (address)",
  "function setFee(uint16 bps)",
  "function setFeeRecipient(address recipient)",
  "function setGovernance(address newGovernance)",
  "event Launched(uint256 indexed agentId, address indexed token, string symbol)",
  "event Bought(address indexed token, address indexed buyer, uint256 fmxIn, uint256 fee, uint256 amountOut)",
  "event Sold(address indexed token, address indexed seller, uint256 amountIn, uint256 fmxOut)",
  "event Distributed(address indexed token, address indexed from, uint256 amount)",
  "event Claimed(address indexed token, address indexed holder, uint256 amount)",
  "event Withdrawn(address indexed to, uint256 amount)",
] as const;

/** C6 — AgentToken: ERC-20 with a magnified-dividend-per-share FMX distribution claim (mint/burn only by the factory). */
export const AGENT_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function agentId() view returns (uint256)",
  "function factory() view returns (address)",
  "function claimable(address account) view returns (uint256)",
  "function settleClaimable(address account) returns (uint256 amount)",
  "function accumulative(address account) view returns (uint256)",
  "function distributionsClaimed(address) view returns (uint256)",
  "function totalDistributed() view returns (uint256)",
  "function magnifiedPerShare() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

/** Ferminux Agents ERC-721 (41 one-of-one archetypes). */
export const NFT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function price() view returns (uint256)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function minted(uint256 tokenId) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function mint(uint256 tokenId) payable",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "event Minted(uint256 indexed tokenId, address indexed to, uint256 paid)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
