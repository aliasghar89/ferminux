// Addendum v3 contract ABIs (ethers v6 human-readable fragments), coded
// against SPEC.md "Addendum v3 — Agent Economy". Where the spec names an
// event without its full signature (StreamPay, ArbiterPool, FRC-8004
// reference registries, AgentTokenFactory Bought/Sold/…) the fragments below
// are our best reading of the reference implementations. When the contracts
// lane lands `contracts/abi/<Name>.json`, loadV3Abi() prefers that file, so
// the gateway follows the as-built ABI without a code change.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface, type InterfaceAbi } from "ethers";
import { agentsRoot, type V3ContractKey } from "./config.js";

export const VOUCHER_TUPLE = "tuple(address payer, address payee, uint256 amount, uint256 nonce, uint64 expiry, bytes32 ref)";

/** EIP-712 domain + types for X402Vault vouchers (verifyingContract filled in at runtime). */
export const X402_DOMAIN_NAME = "FerminuxX402";
export const X402_DOMAIN_VERSION = "1";
export const X402_VOUCHER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Voucher: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "ref", type: "bytes32" },
  ],
};

/** EIP-712 domain + types for AgentAccount.executeWithSig. */
export const ACCOUNT_DOMAIN_NAME = "FerminuxAgentAccount";
export const ACCOUNT_DOMAIN_VERSION = "1";
export const ACCOUNT_EXECUTE_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Execute: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

export const X402_VAULT_ABI = [
  "function deposit() payable",
  "function depositFor(address payer) payable",
  "function requestUnlock()",
  "function withdraw(uint256 amount)",
  `function settle(${VOUCHER_TUPLE} v, bytes sig)`,
  `function settleBatch(${VOUCHER_TUPLE}[] vs, bytes[] sigs)`,
  "function withdrawCredits()",
  `function verify(${VOUCHER_TUPLE} v, bytes sig) view returns (bool ok, string reason)`,
  "function balance(address payer) view returns (uint256)",
  "function unlockAt(address payer) view returns (uint256)",
  "function used(address payer, uint256 nonce) view returns (bool)",
  "function credits(address payee) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function governance() view returns (address)",
  "event Deposited(address indexed payer, uint256 amount)",
  "event Settled(address indexed payer, address indexed payee, uint256 amount, uint256 fee, uint256 nonce, bytes32 ref)",
  "event Skipped(address indexed payer, uint256 nonce, string reason)",
  "event UnlockRequested(address indexed payer, uint64 at)",
  "event Withdrawn(address indexed to, uint256 amount)",
] as const;

export const AGENT_ACCOUNT_ABI = [
  "function initialize(address owner_)",
  "function addSession(address key, uint256 capPerDay, uint64 expiry, address[] targets)",
  "function revokeSession(address key)",
  "function execute(address to, uint256 value, bytes data) returns (bytes)",
  "function executeBatch(address[] to, uint256[] value, bytes[] data)",
  "function executeWithSig(address to, uint256 value, bytes data, uint64 deadline, bytes sig) returns (bytes)",
  "function isValidSignature(bytes32 hash, bytes sig) view returns (bytes4)",
  "function transferOwnership(address newOwner)",
  "function owner() view returns (address)",
  "function nonce() view returns (uint256)",
  "function sessions(address key) view returns (uint256 capPerDay, uint256 spentToday, uint64 dayStart, uint64 expiry, bool anyTarget)",
  "function allowedTarget(address key, address target) view returns (bool)",
  "event SessionAdded(address indexed key, uint256 capPerDay, uint64 expiry)",
  "event SessionRevoked(address indexed key)",
  "event Executed(address indexed by, address indexed to, uint256 value, bool ok)",
] as const;

export const ACCOUNT_FACTORY_ABI = [
  "function create(address owner, bytes32 salt) returns (address account)",
  "function predict(address owner, bytes32 salt) view returns (address)",
  "function implementation() view returns (address)",
  "function isAccount(address) view returns (bool)",
  "event AccountCreated(address indexed owner, address indexed account)",
] as const;

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
  "function isSubscribed(uint256 planId, address payer) view returns (bool)",
  "function credits(address account) view returns (uint256)",
  "function withdraw()",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "event StreamOpened(uint256 indexed id, address indexed payer, address indexed payee, uint256 ratePerSec, uint256 deposit, uint64 start, uint64 stop)",
  "event StreamToppedUp(uint256 indexed id, uint256 amount, uint64 stop)",
  "event StreamClaimed(uint256 indexed id, uint256 payeeAmount, uint256 fee)",
  "event StreamCancelled(uint256 indexed id, address indexed by, uint256 payeeAmount, uint256 fee, uint256 refund)",
  "event PlanCreated(uint256 indexed planId, address indexed payee, uint256 pricePerPeriod, uint64 period, string metadataURI)",
  "event PlanActiveSet(uint256 indexed planId, bool active)",
  "event Subscribed(uint256 indexed subId, uint256 indexed planId, address indexed payer, uint32 periods, uint64 paidThrough)",
  "event SubRenewed(uint256 indexed subId, uint32 periods, uint64 paidThrough)",
  "event SubCancelled(uint256 indexed subId, uint256 refund)",
  "event SubClaimed(uint256 indexed subId, uint256 amount)",
  "event Withdrawn(address indexed to, uint256 amount)",
] as const;

export const ARBITER_POOL_ABI = [
  "function joinPool() payable",
  "function leavePool()",
  "function openCase(uint256 jobId, string evidenceURI) payable",
  "function submitEvidence(uint256 caseId, string uri)",
  "function vote(uint256 caseId, uint16 clientBps)",
  "function close(uint256 caseId)",
  "function forward(address target, bytes data) returns (bytes)",
  "function setParams(uint256 minStake, uint64 votingWindow, uint8 quorum)",
  "function minStake() view returns (uint256)",
  "function votingWindow() view returns (uint64)",
  "function quorum() view returns (uint8)",
  "function stake(address arbiter) view returns (uint256)",
  "event ArbiterJoined(address indexed arbiter, uint256 stake)",
  "event ArbiterLeft(address indexed arbiter, uint256 stake)",
  "event CaseOpened(uint256 indexed caseId, uint256 indexed jobId, address indexed opener, string evidenceURI)",
  "event EvidenceSubmitted(uint256 indexed caseId, address indexed by, string uri)",
  "event Voted(uint256 indexed caseId, address indexed arbiter, uint16 clientBps)",
  "event CaseClosed(uint256 indexed caseId, uint256 indexed jobId, uint16 clientBps)",
] as const;

export const IDENTITY_8004_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function agentURI(uint256 agentId) view returns (string)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
] as const;

export const REPUTATION_8004_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function syncFromEscrow(uint256 jobId)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string responseURI, bytes32 responseHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)",
  "event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)",
] as const;

export const VALIDATION_8004_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 avgResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[])",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
] as const;

export const TOKEN_FACTORY_ABI = [
  "function launch(uint256 agentId, string symbol, uint256 base, uint256 slope) returns (address token)",
  "function buy(address token, uint256 minOut) payable",
  "function sell(address token, uint256 amount, uint256 minFmx)",
  "function quoteBuy(address token, uint256 fmxIn) view returns (uint256 out)",
  "function quoteSell(address token, uint256 amountIn) view returns (uint256 fmxOut)",
  "function distribute(address token) payable",
  "function claimDistribution(address token)",
  "function tokenOf(uint256 agentId) view returns (address)",
  "event Launched(uint256 indexed agentId, address indexed token, string symbol)",
  "event Bought(address indexed token, address indexed buyer, uint256 fmxIn, uint256 tokensOut, uint256 fee)",
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fmxOut)",
  "event Distributed(address indexed token, address indexed by, uint256 amount)",
  "event Claimed(address indexed token, address indexed holder, uint256 amount)",
] as const;

/** FRC-100 MemoryAnchor: append-only merkle commitments over an agent's memory records. */
export const MEMORY_ANCHOR_ABI = [
  "function anchor(uint256 agentId, bytes32 root, bytes32 prevRoot, uint32 count, string uri) returns (uint64 seq)",
  "function anchorFor(uint256 agentId, bytes32 root, bytes32 prevRoot, uint32 count, string uri, uint64 deadline, bytes sig) returns (uint64 seq)",
  "function setAnchorer(uint256 agentId, address who, bool allowed)",
  "function head(uint256 agentId) view returns (bytes32 root, uint64 seq, uint64 totalRecords, uint64 anchoredAt)",
  "function anchorCount(uint256 agentId) view returns (uint64)",
  "function getAnchor(uint256 agentId, uint64 seq) view returns (tuple(bytes32 root, bytes32 prevRoot, uint64 seq, uint32 count, uint64 totalRecords, uint64 ts, string uri))",
  "function canAnchor(uint256 agentId, address who) view returns (bool)",
  "function nonceOf(uint256 agentId) view returns (uint256)",
  "function leafOf(bytes32 recordHash) pure returns (bytes32)",
  "function recordLeaf(bytes record) pure returns (bytes32)",
  "function computeRoot(bytes32[] leaves) pure returns (bytes32)",
  "function verify(bytes32 root, bytes record, bytes32[] proof, uint256 index, uint256 count) pure returns (bool)",
  "function verifyLeaf(bytes32 root, bytes32 leaf, bytes32[] proof, uint256 index, uint256 count) pure returns (bool)",
  "function verifyRecord(uint256 agentId, uint64 seq, bytes record, bytes32[] proof, uint256 index) view returns (bool)",
  "function verifyAgainstHead(uint256 agentId, bytes record, bytes32[] proof, uint256 index) view returns (bool)",
  "function NAME() pure returns (string)",
  "function VERSION() pure returns (string)",
  "event MemoryAnchored(uint256 indexed agentId, uint64 indexed seq, bytes32 indexed root, bytes32 prevRoot, uint32 count, uint64 totalRecords, address anchoredBy, string uri)",
  "event AnchorerSet(uint256 indexed agentId, address indexed who, bool allowed)",
] as const;

/** Endorsements: agent→agent capability endorsements, weighted by arm's-length paid evidence. */
export const ENDORSEMENTS_ABI = [
  "function endorse(uint256 fromAgentId, uint256 toAgentId, string capability, string uri, uint256 evidenceJobId) returns (uint256 id)",
  "function endorseFor(uint256 fromAgentId, uint256 toAgentId, string capability, string uri, uint256 evidenceJobId, uint64 deadline, bytes sig) returns (uint256 id)",
  "function revoke(uint256 id)",
  "function summary(uint256 toAgentId) view returns (tuple(uint32 total, uint32 backed, uint32 unbacked, uint32 revoked, uint128 weight))",
  "function capabilitySummary(uint256 toAgentId, string capability) view returns (tuple(uint32 total, uint32 backed, uint32 unbacked, uint32 revoked, uint128 weight))",
  "function quoteWeight(uint256 fromAgentId, uint256 toAgentId, uint256 evidenceJobId) view returns (uint32 weight, uint8 basis, uint256 evidenceAmountWei)",
  "function isRelated(address a, address b) view returns (bool)",
  "function capabilityIdOf(string capability) pure returns (bytes32)",
  "function receivedCount(uint256 toAgentId) view returns (uint256)",
  "function givenCount(uint256 fromAgentId) view returns (uint256)",
  "event Endorsed(uint256 indexed id, uint256 indexed fromAgentId, uint256 indexed toAgentId, bytes32 capabilityId, string capability, uint8 basis, uint32 weight, uint64 evidenceJobId, uint256 evidenceAmountWei, string uri)",
  "event EndorsementRevoked(uint256 indexed id, uint256 indexed fromAgentId, uint256 indexed toAgentId, uint32 weight)",
] as const;

/** deployments key → contracts/abi/<Name>.json + spec fallback fragments. */
export const V3_ABI_SOURCES: Record<V3ContractKey, { file: string; fallback: readonly string[] }> = {
  x402Vault: { file: "X402Vault", fallback: X402_VAULT_ABI },
  accountFactory: { file: "AgentAccountFactory", fallback: ACCOUNT_FACTORY_ABI },
  accountImpl: { file: "AgentAccount", fallback: AGENT_ACCOUNT_ABI },
  streamPay: { file: "StreamPay", fallback: STREAM_PAY_ABI },
  arbiterPool: { file: "ArbiterPool", fallback: ARBITER_POOL_ABI },
  identity8004: { file: "IdentityRegistry8004", fallback: IDENTITY_8004_ABI },
  reputation8004: { file: "ReputationRegistry8004", fallback: REPUTATION_8004_ABI },
  validation8004: { file: "ValidationRegistry8004", fallback: VALIDATION_8004_ABI },
  tokenFactory: { file: "AgentTokenFactory", fallback: TOKEN_FACTORY_ABI },
  memoryAnchor: { file: "MemoryAnchor", fallback: MEMORY_ANCHOR_ABI },
  endorsements: { file: "Endorsements", fallback: ENDORSEMENTS_ABI },
};

const abiCache = new Map<V3ContractKey, { abi: InterfaceAbi; source: "file" | "spec" }>();

/** ABI for a v3 contract: the as-built JSON when present, else the spec fragments. */
export function loadV3Abi(key: V3ContractKey): { abi: InterfaceAbi; source: "file" | "spec" } {
  const cached = abiCache.get(key);
  if (cached) return cached;
  const src = V3_ABI_SOURCES[key];
  const path = join(agentsRoot, "contracts", "abi", `${src.file}.json`);
  let out: { abi: InterfaceAbi; source: "file" | "spec" } = { abi: [...src.fallback], source: "spec" };
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      const arr = Array.isArray(j) ? j : Array.isArray(j?.abi) ? j.abi : null;
      if (arr && arr.length) out = { abi: arr, source: "file" };
    } catch (err) {
      console.warn(`[abi-v3] failed to parse ${path}, using spec fragments:`, (err as Error).message);
    }
  }
  abiCache.set(key, out);
  return out;
}

export function v3Interface(key: V3ContractKey): Interface {
  return new Interface(loadV3Abi(key).abi);
}
