// Ferminux AI-CV — the verifiable working record of an agent.
//
// A CV is a W3C Verifiable Credentials 2.0 document whose
// `credentialSubject.record[]` is an array of typed claims. Each claim is a
// merkle leaf; one EIP-712 signature covers a fixed 11-field `AgentCV` struct
// carrying `claimsRoot` and `documentHash`.
//
// THE GOVERNING RULE: the signature authenticates the author; the chain
// authenticates the claim. A CV is self-issued — the agent signs its own CV —
// and that signature proves only "this key assembled and published this
// document". Every economic claim is proved separately by a transaction a
// stranger fetches from a public RPC. Ferminux is not the trust root anywhere
// in the verification path.
//
// `verifyCv()` is therefore a pure function of (document, RPC). It never calls
// a Ferminux service, and the whole algorithm is reproducible from the
// document alone. Byte-compatibility with the gateway is not incidental:
//   leaf         = keccak256(utf8(canonicalJson(claim without {leaf, path})))
//   claimsRoot   = merkle(leaves)      // pairwise keccak256(concat(l,r)),
//                                      // an odd node pairs with itself
//   documentHash = keccak256(utf8(canonicalJson(document without "proof")))
// which is byte-for-byte the construction already shipped in
// gateway/src/v3/audit.ts, over the canonicalJson in ../sign.ts (RFC 8785 JCS
// for JSON values). No new canonicalizer exists anywhere in the stack.
import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  TypedDataEncoder,
  concat,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
  type EventFragment,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { canonicalJson } from "../sign.js";
import {
  AGENT_TOKEN_FACTORY_ABI,
  ARBITER_POOL_ABI,
  ESCROW_ABI,
  IDENTITY_8004_ABI,
  REGISTRY_ABI,
  REPUTATION_8004_ABI,
  STREAM_PAY_ABI,
  VALIDATION_8004_ABI,
  X402_VAULT_ABI,
} from "../abi.js";
import { NETWORKS } from "../networks.js";
import { lazyContract, qs, requireAddress, type GatewayClient } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CV_CONTEXT = ["https://www.w3.org/ns/credentials/v2", "https://ferminux.net/api/ns/aicv/v1"] as const;
export const CV_VC_CONTEXT = "https://www.w3.org/ns/credentials/v2";
export const CV_TYPE = ["VerifiableCredential", "FerminuxAgentCV"] as const;
export const CV_SCHEMA_URL = "https://ferminux.net/api/ns/aicv/v1/schema.json";

/** EIP-712 domain of the AgentCV struct; `verifyingContract` is IdentityRegistry8004. */
export const CV_DOMAIN_NAME = "Ferminux AI-CV";
export const CV_DOMAIN_VERSION = "1";
export const CV_PRIMARY_TYPE = "AgentCV";

/**
 * Not a registered Data Integrity cryptosuite, and `proofValue` carries 0x-hex
 * rather than multibase — a generic VC verifier will refuse the proof (it would
 * refuse any unregistered suite). That deviation is the price of the signer
 * being the on-chain identity: secp256k1 + keccak is what owns the agent, and
 * no registered suite covers it. The verification algorithm is reproducible
 * from the document alone, which is the property that actually matters.
 */
export const CV_CRYPTOSUITE = "eip712-jcs-2026";

/** IdentityRegistry8004 metadata keys. Only `agentWallet` is reserved on chain, so both are free. */
export const CV_METADATA_KEY = "cv";
export const MEMORY_METADATA_KEY = "mem";

/** A CV is a point-in-time snapshot; 90 days bounds how stale a cached copy can get. */
export const CV_DEFAULT_TTL_S = 90 * 86_400;

export const AGENT_CV_TYPES: Record<string, TypedDataField[]> = {
  AgentCV: [
    { name: "chainId", type: "uint256" },
    { name: "registry", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "subject", type: "address" },
    { name: "claimsRoot", type: "bytes32" },
    { name: "documentHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "asOfBlock", type: "uint64" },
    { name: "asOfBlockHash", type: "bytes32" },
    { name: "uri", type: "string" },
  ],
};

/** Trust tiers, most trustworthy first. A verifier sets a floor and drops everything below it. */
export const CV_TRUST_TIERS = ["chain", "gateway", "selfAttested"] as const;
export type CvTrust = (typeof CV_TRUST_TIERS)[number];

/** v1 claim vocabulary. `MemoryAnchor` is emitted by `fmx.memory.anchor()`. */
export const CV_CLAIM_TYPES = [
  "Registration",
  "EscrowJob",
  "X402Receipt",
  "X402Payment",
  "Stream",
  "SubscriptionPlan",
  "Feedback",
  "Validation",
  "Dispute",
  "Slash",
  "Contribution",
  "Capability",
  "MemoryAnchor",
] as const;
export type CvClaimType = (typeof CV_CLAIM_TYPES)[number] | (string & {});

const ZERO32 = "0x" + "00".repeat(32);
const ZERO_ADDR = "0x" + "00".repeat(20);
const ERC1271_MAGIC = "0x1626ba7e";

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

/** `{log:<field>, equals:<ref>}` or `{call:{…}, equals:<ref>}`; refs are `subject.address`, `subject.agentId`, `claim.<field>` (with an optional `|0` null-default). */
export interface CvBind {
  log?: string;
  call?: { address: string; fn: string; args: unknown[]; field: string };
  equals: string;
}

export interface CvEvidence {
  trust: CvTrust;
  chainId?: number;
  block?: number;
  blockTime?: string;
  tx?: string;
  /** index into the transaction receipt's own `logs` array — receipt-scoped, always */
  logIndex?: number;
  /** the block-scoped index the RPC returns as `logs[].logIndex`; unambiguous, and preferred when present */
  blockLogIndex?: number | null;
  /** the receipt's own status; 1 or the claim is rejected */
  status?: number;
  address?: string;
  /** full event signature, e.g. "JobCompleted(uint256,uint256,uint256,uint8)" */
  event?: string;
  topic0?: string;
  method?: string;
  bind?: CvBind[];
  // trust: "gateway" — the gateway's signed audit merkle root
  attestedBy?: string;
  source?: string;
  auditMerkleRoot?: string;
  auditLeaf?: string;
  auditSeq?: number;
  auditPath?: string[];
  note?: string;
  [k: string]: unknown;
}

export interface CvClaim {
  id: string;
  type: CvClaimType;
  statedAt?: string;
  evidence: CvEvidence;
  /** further transactions in the same claim's life (requested/delivered); not bound, informational */
  alsoEvidence?: CvEvidence[];
  /** keccak256(utf8(canonicalJson(claim without {leaf, path}))) */
  leaf?: string;
  /** merkle path to claimsRoot, `"L:0x…"` / `"R:0x…"` naming the SIBLING's side; present in a derived presentation */
  path?: string[];
  [k: string]: unknown;
}

export interface CvSummary {
  asOfBlock?: number;
  jobsCompleted?: number;
  jobsFailed?: number;
  ratingCount?: number;
  ratingSum?: number;
  ratingAvg?: number | null;
  bondWei?: string;
  pricePerJobWei?: string;
  escrowEarnedWei?: string;
  x402EarnedWei?: string;
  x402ReceiptCount?: number;
  x402SpentWei?: string;
  x402PaymentCount?: number;
  subscriptionPlans?: number;
  disputesOpened?: number;
  disputesLost?: number;
  slashCount?: number;
  verify?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CvRecordMeta {
  count: number;
  /** false unless the issuer asserts nothing was left out. A dishonest issuer can lie here — see `omitted`. */
  complete: boolean;
  omitted?: Array<{ type: string; count: number; reason: string }>;
  omittedNote?: string;
  full?: string;
  [k: string]: unknown;
}

export interface CvSubject {
  id: string;
  type: "AutonomousAgent";
  name?: string;
  agent: {
    chainId: number;
    caip2: string;
    agentId: number;
    agentRegistry: string;
    identityRegistry?: string;
    /** CAIP-19 machine identifier; `erc721` here is the CAIP token namespace, not branding (prose says FRC-721) */
    caip19?: string;
    controller: string;
    registeredAt?: string;
    endpoint?: string;
    status?: string;
    [k: string]: unknown;
  };
  summary: CvSummary;
  record: CvClaim[];
  recordMeta?: CvRecordMeta;
  [k: string]: unknown;
}

export interface CvEip712Proof {
  type: "DataIntegrityProof";
  cryptosuite: string;
  created: string;
  proofPurpose: string;
  verificationMethod: string;
  eip712: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    primaryType: string;
    types: Record<string, TypedDataField[]>;
    message: AgentCvMessage;
  };
  digest?: string;
  proofValue: string;
  [k: string]: unknown;
}

export interface AgentCvMessage {
  chainId: number;
  registry: string;
  agentId: number;
  subject: string;
  claimsRoot: string;
  documentHash: string;
  issuedAt: number;
  expiresAt: number;
  asOfBlock: number;
  asOfBlockHash: string;
  uri: string;
}

export interface CvDocument {
  "@context": string[];
  type: string[];
  id?: string;
  issuer: string;
  validFrom: string;
  validUntil: string;
  name?: string;
  description?: string;
  credentialSubject: CvSubject;
  evidence?: Array<Record<string, unknown>>;
  credentialStatus?: Record<string, unknown>;
  credentialSchema?: Record<string, unknown>;
  refreshService?: Record<string, unknown>;
  proof?: CvEip712Proof | CvEip712Proof[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Canonicalisation, hashing, merkle — all pure, no network
// ---------------------------------------------------------------------------

/** keccak256(utf8(canonicalJson(claim without {leaf, path}))). */
export function cvLeaf(claim: CvClaim | Record<string, unknown>): string {
  const { leaf: _l, path: _p, ...rest } = claim as Record<string, unknown>;
  return keccak256(toUtf8Bytes(canonicalJson(rest)));
}

/** Pairwise keccak256(concat(l,r)); an odd node pairs with itself. Identical to gateway/src/v3/audit.ts. */
export function cvMerkleRoot(leaves: readonly string[]): string {
  if (!leaves.length) return keccak256("0x");
  let level: string[] = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      next.push(keccak256(concat([a, b])));
    }
    level = next;
  }
  return level[0];
}

/**
 * The merkle path for `index`, as `"L:0x…"` / `"R:0x…"` entries naming which
 * side the SIBLING sits on. A node paired with itself contributes `"R:<self>"`,
 * so a path always folds back to the root without knowing the tree's shape.
 */
export function cvMerklePath(leaves: readonly string[], index: number): string[] {
  if (index < 0 || index >= leaves.length) throw new Error(`Ferminux: leaf index ${index} out of range (${leaves.length} leaves)`);
  const path: string[] = [];
  let level: string[] = [...leaves];
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const siblingIndex = isRight ? i - 1 : i + 1;
    const sibling = level[siblingIndex] ?? level[i];
    path.push(`${isRight ? "L" : "R"}:${sibling}`);
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const a = level[j];
      const b = level[j + 1] ?? a;
      next.push(keccak256(concat([a, b])));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

/** Folds a leaf up a `cvMerklePath` to the root it was built from. */
export function cvFoldPath(leaf: string, path: readonly string[]): string {
  let node = leaf;
  for (const step of path) {
    const side = step.slice(0, 1);
    const hash = step.slice(2);
    if (side === "L") node = keccak256(concat([hash, node]));
    else if (side === "R") node = keccak256(concat([node, hash]));
    else throw new Error(`Ferminux: merkle path step must start with "L:" or "R:" (got ${step.slice(0, 8)}…)`);
  }
  return node;
}

/**
 * keccak256(utf8(canonicalJson(document without `proof` and without
 * `documentHash`))).
 *
 * BOTH keys are stripped. A document that carries its own `documentHash` at the
 * top level — every document this gateway serves does — cannot be covered by a
 * hash of itself, so the hash rule has to exclude it. Stripping only `proof`
 * made this function disagree with the gateway, with the document's own
 * `hashing.documentHash` string and with published verification step 2, and it
 * rejected genuine credentials as tampered.
 */
export function cvDocumentHash(doc: CvDocument | Record<string, unknown>): string {
  const { proof: _p, documentHash: _d, ...rest } = doc as Record<string, unknown>;
  return keccak256(toUtf8Bytes(canonicalJson(rest)));
}

export function cvDomain(chainId: number, identityRegistry: string): TypedDataDomain {
  return { name: CV_DOMAIN_NAME, version: CV_DOMAIN_VERSION, chainId, verifyingContract: getAddress(identityRegistry) };
}

/** The EIP-712 digest a CV signature is made over. */
export function cvDigest(domain: TypedDataDomain, message: AgentCvMessage): string {
  return TypedDataEncoder.hash(domain, AGENT_CV_TYPES, message as unknown as Record<string, unknown>);
}

/** did:pkh resolves with zero network calls — it is a pure function of (namespace, chainId, address). */
export function didPkh(chainId: number, address: string): string {
  return `did:pkh:eip155:${chainId}:${getAddress(address)}`;
}

/** Address out of a `did:pkh:eip155:<chainId>:<address>` (fragment allowed), or null. */
export function didPkhAddress(did: string): { chainId: number; address: string } | null {
  const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})(?:#.*)?$/.exec(did.trim());
  if (!m) return null;
  try {
    return { chainId: Number(m[1]), address: getAddress(m[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The verifier's own ABI catalogue
//
// Step 7 decodes each cited log with the SDK's OWN ABI, keyed by topic0 — never
// with an ABI supplied inside the document. `evidence.event` is only checked to
// hash to the same topic0; it is never used to interpret bytes.
// ---------------------------------------------------------------------------

const CV_ABIS: readonly (readonly string[])[] = [
  REGISTRY_ABI,
  ESCROW_ABI,
  X402_VAULT_ABI,
  STREAM_PAY_ABI,
  ARBITER_POOL_ABI,
  IDENTITY_8004_ABI,
  REPUTATION_8004_ABI,
  VALIDATION_8004_ABI,
  AGENT_TOKEN_FACTORY_ABI,
];

let cachedIface: Interface | null = null;

/** One Interface over every contract a CV claim can cite, with duplicate fragments dropped. */
export function cvInterface(): Interface {
  if (cachedIface) return cachedIface;
  const seen = new Set<string>();
  const frags: string[] = [];
  for (const abi of CV_ABIS) {
    for (const entry of abi) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      frags.push(entry);
    }
  }
  // Fragments that collide on signature (e.g. getVersion()) are dropped one by one
  // rather than failing the whole catalogue.
  let iface: Interface;
  try {
    iface = new Interface(frags);
  } catch {
    iface = new Interface([]);
    const kept: string[] = [];
    for (const f of frags) {
      try {
        new Interface([...kept, f]);
        kept.push(f);
      } catch {
        /* collides with one already kept — the kept one wins */
      }
    }
    iface = new Interface(kept);
  }
  cachedIface = iface;
  return iface;
}

function eventByTopic0(topic0: string): EventFragment | null {
  try {
    return cvInterface().getEvent(topic0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE VERIFIER'S OWN RULES
//
// Everything below is the answer to one attack: a forged CV that cites an
// attacker-deployed contract, emits a log bearing a genuine `JobCompleted`
// topic0, and points its own `bind.call.address` at that contract so the bind
// resolves against the forger's own state. The verifier agreed: 13 claims
// verified, 0 rejected, 58,500 FMX of earnings that never existed.
//
// The root cause was that the DOCUMENT decided what got checked and against
// which contract. It no longer does. Two rules now hold without exception:
//
//   1. ADDRESSES ARE PINNED. Every address a claim cites — the log's emitter
//      and every `bind.call.address` — is resolved against the verifier's own
//      NETWORKS entry for the chain in the signed message. A claim naming any
//      other contract is rejected, whatever it says about itself.
//
//   2. THE VERIFIER OWNS THE BIND SET. `evidence.bind` is a courtesy, not the
//      gate. For each (claim type, event) the table below states which pinned
//      contract must have emitted the log, how the log ties to THIS subject,
//      and which claim fields must equal which decoded log fields. Every one
//      is checked whether or not the document mentions it, which is what stops
//      a `proven: true` claim carrying a 100× payout that no rule touched.
//
// A claim type or event with no entry here is never counted as verified. It is
// reported `unrecognised` and skipped, so an older verifier meeting a newer
// claim type degrades to "I cannot check this" rather than to "fine by me".
// ---------------------------------------------------------------------------

/** The contract roles a CV claim may cite. Each resolves to one pinned address. */
export const CV_CONTRACT_ROLES = [
  "registry",
  "escrow",
  "x402Vault",
  "streamPay",
  "arbiterPool",
  "identity8004",
  "reputation8004",
  "validation8004",
  "tokenFactory",
  "memoryAnchor",
  "endorsements",
] as const;
export type CvContractRole = (typeof CV_CONTRACT_ROLES)[number];

/** Per-verifier overrides for the pinned set (tests, forks, a private deployment). */
export type CvContractOverrides = Partial<Record<CvContractRole, string>>;

/** The pinned address for each role on `chainId`, from the SDK's OWN network table. */
export function cvTrustedContracts(chainId: number, overrides?: CvContractOverrides): Map<CvContractRole, string> {
  const net = NETWORKS[chainId] as unknown as Record<string, string> | undefined;
  const out = new Map<CvContractRole, string>();
  for (const role of CV_CONTRACT_ROLES) {
    const raw = overrides?.[role] ?? net?.[role] ?? "";
    if (!raw || raw === ZERO_ADDR) continue;
    try {
      out.set(role, getAddress(raw));
    } catch {
      /* unusable entry — treated as not deployed */
    }
  }
  return out;
}

/** Reverse map, address → role, for naming what a claim actually cited. */
function roleOfAddress(pinned: Map<CvContractRole, string>, address: string): CvContractRole | null {
  let a: string;
  try {
    a = getAddress(address);
  } catch {
    return null;
  }
  for (const [role, addr] of pinned) if (addr === a) return role;
  return null;
}

/** A tie from the cited log (or an eth_call into a pinned contract) to THIS subject. */
interface SubjectRule {
  log?: string;
  call?: { role: CvContractRole; fn: string; args: unknown[]; field: string };
  equals: "subject.address" | "subject.agentId";
}

interface ClaimRule {
  /** which pinned contract must have emitted the log */
  role: CvContractRole;
  /** every one of these must hold — the claim is tied to the subject by all of them */
  subject: SubjectRule[];
  /** claim field → decoded log field; checked whenever the claim states the field */
  fields?: Record<string, string>;
  /** claim fields whose `null` means "absent" and whose log counterpart must then be 0 */
  nullMeansZero?: string[];
  /**
   * Field names this claim type may NOT carry. Mutable registry state inside a
   * claim proved by a registration log is how a forged endpoint, a Paused→Active
   * flip and a 10x price got through every published step: the log is real, the
   * values are current-state, and nothing compared them to anything. They belong
   * in AgentState, which is re-read live. A claim carrying them is rejected
   * rather than partly checked.
   */
  forbidden?: string[];
}

/** `"<ClaimType>|<event sighash>"` → the rule. Unlisted pairs are never verified. */
const CLAIM_RULES: Record<string, ClaimRule> = {
  "Registration|AgentRegistered(uint256,address,string,string,string,uint256,uint256)": {
    role: "registry",
    subject: [
      { log: "id", equals: "subject.agentId" },
      { log: "owner", equals: "subject.address" },
    ],
    fields: {
      agentId: "id",
      owner: "owner",
      name: "name",
      endpointAtRegistration: "endpoint",
      metadataURIAtRegistration: "metadataURI",
      pricePerJobWeiAtRegistration: "pricePerJob",
      bondWeiAtRegistration: "bond",
    },
    forbidden: ["endpoint", "status", "pricePerJobWei", "bondWei", "metadataURI"],
  },
  "EscrowJob|JobCompleted(uint256,uint256,uint256,uint8)": {
    role: "escrow",
    subject: [{ call: { role: "escrow", fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" }],
    fields: { jobId: "jobId", payoutWei: "agentPayout", feeWei: "fee", rating: "rating" },
    nullMeansZero: ["rating"],
  },
  "EscrowJob|JobResolved(uint256,uint256,uint256,uint256)": {
    role: "escrow",
    subject: [{ call: { role: "escrow", fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" }],
    fields: { jobId: "jobId", payoutWei: "agentPayout", feeWei: "fee" },
  },
  "EscrowJob|JobRefunded(uint256,uint256,bool)": {
    role: "escrow",
    subject: [{ call: { role: "escrow", fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" }],
    fields: { jobId: "jobId" },
  },
  "EscrowJob|JobRequested(uint256,uint256,address,uint256,bytes32,string)": {
    role: "escrow",
    subject: [{ log: "agentId", equals: "subject.agentId" }],
    fields: { jobId: "jobId", client: "client", amountWei: "amount", inputHash: "inputHash" },
  },
  "X402Receipt|Settled(address,address,uint256,uint256,uint256,bytes32)": {
    role: "x402Vault",
    subject: [{ log: "payee", equals: "subject.address" }],
    fields: { payer: "payer", payee: "payee", amountWei: "amount", feeWei: "fee", nonce: "nonce" },
  },
  "X402Payment|Settled(address,address,uint256,uint256,uint256,bytes32)": {
    role: "x402Vault",
    subject: [{ log: "payer", equals: "subject.address" }],
    fields: { payer: "payer", payee: "payee", amountWei: "amount", feeWei: "fee", nonce: "nonce" },
  },
  "Stream|StreamOpened(uint256,address,address,uint256,uint256,uint64,uint64)": {
    role: "streamPay",
    subject: [{ log: "payee", equals: "subject.address" }],
    fields: { streamId: "id", payer: "payer", payee: "payee", ratePerSecWei: "ratePerSec", depositWei: "deposit" },
  },
  "StreamPayment|StreamOpened(uint256,address,address,uint256,uint256,uint64,uint64)": {
    role: "streamPay",
    subject: [{ log: "payer", equals: "subject.address" }],
    fields: { streamId: "id", payer: "payer", payee: "payee", ratePerSecWei: "ratePerSec", depositWei: "deposit" },
  },
  "SubscriptionPlan|PlanCreated(uint256,address,uint256,uint64,string)": {
    role: "streamPay",
    subject: [{ log: "payee", equals: "subject.address" }],
    fields: { planId: "planId", payee: "payee", pricePerPeriodWei: "pricePerPeriod", periodSeconds: "period", metadataURI: "metadataURI" },
  },
  "Feedback|NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)": {
    role: "reputation8004",
    subject: [{ log: "agentId", equals: "subject.agentId" }],
    fields: { client: "clientAddress", value: "value", valueDecimals: "valueDecimals", tag1: "tag1", tag2: "tag2", feedbackURI: "feedbackURI" },
  },
  "Validation|ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)": {
    role: "validation8004",
    subject: [{ log: "agentId", equals: "subject.agentId" }],
    fields: { requestHash: "requestHash", validator: "validatorAddress", response: "response", responseURI: "responseURI", tag: "tag" },
  },
  "Validation|ValidationRequest(address,uint256,string,bytes32)": {
    role: "validation8004",
    subject: [{ log: "agentId", equals: "subject.agentId" }],
    fields: { requestHash: "requestHash", validator: "validatorAddress", requestURI: "requestURI" },
  },
  "Dispute|CaseClosed(uint256,uint256,uint16)": {
    role: "arbiterPool",
    subject: [{ call: { role: "escrow", fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" }],
    fields: { caseId: "caseId", jobId: "jobId", clientBps: "clientBps" },
  },
  "Dispute|CaseOpened(uint256,uint256,address,string)": {
    role: "arbiterPool",
    subject: [{ call: { role: "escrow", fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" }],
    fields: { caseId: "caseId", jobId: "jobId", opener: "opener", evidenceURI: "evidenceURI" },
  },
  "Endorsement|Endorsed(uint256,uint256,uint256,bytes32,string,uint8,uint32,uint64,uint256,string)": {
    role: "endorsements",
    subject: [{ log: "toAgentId", equals: "subject.agentId" }],
    fields: {
      endorsementId: "id",
      fromAgentId: "fromAgentId",
      capability: "capability",
      basis: "basis",
      weight: "weight",
      evidenceJobId: "evidenceJobId",
      evidenceAmountWei: "evidenceAmountWei",
      uri: "uri",
    },
    nullMeansZero: ["evidenceJobId"],
  },
  "MemoryAnchor|MemoryAnchored(uint256,uint64,bytes32,bytes32,uint32,uint64,address,string)": {
    role: "memoryAnchor",
    subject: [{ log: "agentId", equals: "subject.agentId" }],
    fields: { anchorSeq: "seq", root: "root", prevRoot: "prevRoot", count: "count", totalRecords: "totalRecords", uri: "uri" },
  },
  "TokenLaunch|Launched(uint256,address,string)": {
    role: "tokenFactory",
    subject: [{ log: "agentId", equals: "subject.agentId" }],
    fields: { token: "token", symbol: "symbol" },
  },
  "Slash|AgentSlashed(uint256,uint256,address,string)": {
    role: "registry",
    subject: [{ log: "id", equals: "subject.agentId" }],
    fields: { amountWei: "amount", to: "to", reason: "reason" },
  },
};

/**
 * `AgentState` has no transaction: endpoint, status, price and bond are mutable
 * registry state the owner rewrites at will, with no history and no event for
 * the current value. They are therefore read LIVE from the pinned registry at
 * verification time, and a mismatch rejects the claim — a stale document and a
 * forged one are the same answer here, because the endpoint is where a client
 * sends work and money. This is the claim that used to sit inside `Registration`
 * with a bind set covering only `{id, owner}`, which let a forged endpoint,
 * a Paused→Active flip and a 10× price ride through every published step.
 */
const AGENT_STATE_FIELDS: Record<string, string> = {
  endpoint: "endpoint",
  metadataURI: "metadataURI",
  pricePerJobWei: "pricePerJob",
  bondWei: "bond",
  owner: "owner",
};

// ---------------------------------------------------------------------------
// The RPC surface a verifier needs — deliberately tiny, so a test (or another
// library) can satisfy it without ethers and without a network.
// ---------------------------------------------------------------------------

export interface CvLog {
  address: string;
  topics: readonly string[];
  data: string;
  index?: number;
  logIndex?: number;
}

export interface CvReceipt {
  blockNumber: number;
  status?: number;
  logs: readonly CvLog[];
}

export interface CvRpc {
  call(tx: { to: string; data: string }): Promise<string>;
  getTransactionReceipt(hash: string): Promise<CvReceipt | null>;
  getCode?(address: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// verifyCv — the algorithm a stranger runs with one RPC URL and nothing else
// ---------------------------------------------------------------------------

export interface CvVerifyOptions {
  /** any chain-3961 RPC URL; a JsonRpcProvider is built from it */
  rpc?: string;
  /** or bring your own provider-shaped object (ethers' Provider satisfies this) */
  provider?: CvRpc;
  /** drop every claim below this tier; default "chain" — nothing but chain evidence counts */
  trustFloor?: CvTrust;
  /** unix seconds, for the validity window; default now */
  now?: number;
  /** fail verification when the CV is not anchored on chain (default false: unanchored is reported, not fatal) */
  requireAnchor?: boolean;
  /**
   * The AgentRegistry / IdentityRegistry8004 a verifier trusts. Defaults to the
   * SDK's own NETWORKS entry for the document's chainId. A document that names
   * different contracts FAILS step 5 — otherwise an impostor could point
   * `registry` at a contract of its own that names it the owner.
   */
  registry?: string;
  identityRegistry?: string;
  /** skip the registry pinning check (only for a private deployment with its own addresses) */
  allowUnknownRegistry?: boolean;
  /**
   * Override the verifier's pinned contract table for this chain. Used by tests
   * and private deployments; a claim citing any address outside this set is
   * rejected, which is what stops a forged CV supplying the contract that
   * answers for it.
   */
  contracts?: CvContractOverrides;
  /** addresses allowed to index-sign a CV, on top of NETWORKS[chainId].cvIssuers */
  issuers?: string[];
  /** refuse an index-issued CV; only a signature by the agent's own owner key passes */
  requireOwnerSigned?: boolean;
}

export type CvStepStatus = "pass" | "fail" | "skip";

export interface CvVerifyStep {
  step: number;
  name: string;
  status: CvStepStatus;
  detail: string;
}

export interface CvClaimResult {
  id: string;
  type: string;
  trust: CvTrust;
  status: "verified" | "rejected" | "skipped";
  reason?: string;
  tx?: string;
}

export interface CvVerifyResult {
  /** every mandatory step passed and no retained claim failed */
  ok: boolean;
  /**
   * false for an unsigned index — a CV assembled locally from chain logs, which
   * nobody has attested. Its claims still verify one by one against the chain;
   * what is missing is only the issuer's statement that it published this set.
   */
  signed: boolean;
  /** steps 1–4: shape, documentHash, claimsRoot, signature — no RPC needed */
  offlineOk: boolean;
  /** true when an RPC was supplied and the chain steps actually ran */
  chainChecked: boolean;
  signer: string | null;
  owner: string | null;
  agentId: number | null;
  chainId: number | null;
  documentHash: string | null;
  claimsRoot: string | null;
  /** "current" | "superseded" | "unanchored" | "unchecked" */
  anchor: "current" | "superseded" | "unanchored" | "unchecked";
  /**
   * Who signed, and with what standing.
   *   "owner"   — the agent's own key, read from AgentRegistry
   *   "indexer" — a pinned index key; attests authorship, not any claim
   *   "none"    — unsigned index
   */
  issuerRole: "owner" | "indexer" | "none";
  /**
   * Money and breadth RECOMPUTED from the claims that verified, never read from
   * `summary`. This is the figure a hiring agent must use.
   */
  verifiedEarned: {
    escrowEarnedWei: string;
    x402EarnedWei: string;
    x402SpentWei: string;
    payers: number;
    paidJobs: number;
    zeroValueJobs: number;
  } | null;
  steps: CvVerifyStep[];
  claims: CvClaimResult[];
  verified: number;
  rejected: number;
  skipped: number;
  errors: string[];
  warnings: string[];
}

/**
 * Money out of claims that VERIFIED — the only figures a verifier may repeat.
 * `summary` is the issuer's arithmetic; this is the reader's.
 */
export function cvMoneyFromClaims(claims: readonly CvClaim[]): {
  escrowEarnedWei: bigint;
  x402EarnedWei: bigint;
  x402SpentWei: bigint;
  payers: Set<string>;
  paidJobs: number;
  zeroValueJobs: number;
} {
  let escrowEarnedWei = 0n;
  let x402EarnedWei = 0n;
  let x402SpentWei = 0n;
  let paidJobs = 0;
  let zeroValueJobs = 0;
  const payers = new Set<string>();
  const big = (v: unknown): bigint => {
    try {
      return BigInt(String(v ?? "0"));
    } catch {
      return 0n;
    }
  };
  for (const c of claims) {
    const r = c as unknown as Record<string, unknown>;
    if (c.type === "EscrowJob" && (r.outcome === "Completed" || r.outcome === "Resolved")) {
      const payout = big(r.payoutWei);
      escrowEarnedWei += payout;
      // A settled job that moved no FMX still mints a jobsCompleted and a
      // rating on chain. It is counted separately so nobody has to guess.
      if (big(r.amountWei) > 0n) {
        paidJobs += 1;
        if (typeof r.client === "string") payers.add(r.client.toLowerCase());
      } else {
        zeroValueJobs += 1;
      }
    }
    if (c.type === "X402Receipt") {
      // NET of the protocol fee, like escrowEarnedWei. "Earned" means the same
      // thing in both places or the word is useless.
      x402EarnedWei += big(r.amountWei) - big(r.feeWei);
      if (typeof r.payer === "string") payers.add(r.payer.toLowerCase());
    }
    if (c.type === "X402Payment") x402SpentWei += big(r.amountWei);
  }
  return { escrowEarnedWei, x402EarnedWei, x402SpentWei, payers, paidJobs, zeroValueJobs };
}

function step(step: number, name: string, status: CvStepStatus, detail: string): CvVerifyStep {
  return { step, name, status, detail };
}

function tierIndex(t: CvTrust): number {
  const i = CV_TRUST_TIERS.indexOf(t);
  return i < 0 ? CV_TRUST_TIERS.length : i;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function normalizeScalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? v.toString() : String(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return s.toLowerCase();
    if (/^-?\d+$/.test(s)) return BigInt(s).toString();
    return s;
  }
  return null;
}

/** Address-, bigint- and hex-insensitive comparison of two decoded values. */
function sameValue(a: unknown, b: unknown): boolean {
  const na = normalizeScalar(a);
  const nb = normalizeScalar(b);
  if (na === null || nb === null) return na === nb;
  if (na === nb) return true;
  // 0x-hex vs decimal (e.g. a bytes32 nonce quoted as a decimal string)
  try {
    if (/^(0x)?[0-9a-fA-F]+$/.test(na) && /^(0x)?[0-9a-fA-F]+$/.test(nb)) {
      return BigInt(na.startsWith("0x") ? na : `0x${na}`) === BigInt(nb.startsWith("0x") ? nb : `0x${nb}`);
    }
  } catch {
    /* not both numeric */
  }
  return false;
}

interface BindContext {
  subjectAddress: string;
  subjectAgentId: number;
  claim: CvClaim;
  /** the verifier's OWN address table for this chain — never the document's */
  pinned: Map<CvContractRole, string>;
  chainId: number;
}

/** AgentRegistry's status enum, by index. */
export const AGENT_STATUS_NAMES = ["None", "Active", "Paused", "Retired"] as const;

/** Resolves `subject.address` / `subject.agentId` / `claim.<field>` / `claim.<field>|0`. */
function resolveRef(ref: string, ctx: BindContext): unknown {
  const [path, fallback] = ref.split("|", 2);
  const value = (() => {
    if (path === "subject.address") return ctx.subjectAddress;
    if (path === "subject.agentId") return ctx.subjectAgentId;
    if (path.startsWith("claim.")) {
      const key = path.slice("claim.".length);
      return key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), ctx.claim);
    }
    return undefined;
  })();
  if ((value === null || value === undefined) && fallback !== undefined) return fallback;
  return value;
}

function decodedField(args: unknown, field: string): unknown {
  if (args === null || args === undefined) return undefined;
  const direct = (args as Record<string, unknown>)[field];
  if (direct !== undefined) return direct;
  // getJob(uint256) returns a single named tuple — unwrap one level
  const arr = args as unknown as { length?: number; [i: number]: unknown };
  if (typeof arr.length === "number" && arr.length === 1) {
    const inner = arr[0];
    if (inner && typeof inner === "object") {
      const v = (inner as Record<string, unknown>)[field];
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * The full stranger-side verification, client-side, using only the document and
 * an RPC. No Ferminux endpoint is contacted at any point.
 */
export async function verifyCv(doc: CvDocument, opts: CvVerifyOptions = {}): Promise<CvVerifyResult> {
  const steps: CvVerifyStep[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const claimResults: CvClaimResult[] = [];
  const floor = opts.trustFloor ?? "chain";
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const result: CvVerifyResult = {
    ok: false,
    signed: false,
    offlineOk: false,
    chainChecked: false,
    signer: null,
    owner: null,
    agentId: null,
    chainId: null,
    documentHash: null,
    claimsRoot: null,
    anchor: "unchecked",
    issuerRole: "none",
    verifiedEarned: null,
    steps,
    claims: claimResults,
    verified: 0,
    rejected: 0,
    skipped: 0,
    errors,
    warnings,
  };

  const fail = (s: CvVerifyStep, message: string): CvVerifyResult => {
    steps.push(s);
    errors.push(message);
    return result;
  };

  const provider: CvRpc | undefined = opts.provider ?? (opts.rpc ? (new JsonRpcProvider(opts.rpc) as unknown as CvRpc) : undefined);

  // --- Step 1: shape and validity window -----------------------------------
  const ctx = doc?.["@context"];
  if (!Array.isArray(ctx) || ctx[0] !== CV_VC_CONTEXT) {
    return fail(step(1, "shape", "fail", `@context[0] must be ${CV_VC_CONTEXT}`), "bad @context");
  }
  if (!Array.isArray(doc.type) || !doc.type.includes("FerminuxAgentCV")) {
    return fail(step(1, "shape", "fail", 'type must contain "FerminuxAgentCV"'), "bad type");
  }
  const subject = doc.credentialSubject;
  if (!subject || !subject.agent || !Array.isArray(subject.record)) {
    return fail(step(1, "shape", "fail", "credentialSubject.agent and credentialSubject.record are required"), "bad credentialSubject");
  }
  const validFrom = Date.parse(doc.validFrom ?? "");
  const validUntil = Date.parse(doc.validUntil ?? "");
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil)) {
    return fail(step(1, "shape", "fail", "validFrom / validUntil must be RFC 3339 timestamps"), "bad validity window");
  }
  if (now * 1000 < validFrom) {
    return fail(step(1, "shape", "fail", `not yet valid (validFrom ${doc.validFrom})`), "not yet valid");
  }
  if (now * 1000 >= validUntil) {
    return fail(step(1, "shape", "fail", `expired at ${doc.validUntil}`), "expired");
  }
  steps.push(step(1, "shape", "pass", `VC 2.0 FerminuxAgentCV, valid until ${doc.validUntil}`));

  // An UNSIGNED INDEX is a first-class case, not an error. `fmx.cv.build()`
  // assembles a CV from chain logs with nobody's signature on it, and that
  // document is exactly as provable as a signed one — every claim still names
  // the transaction that proves it. What an unsigned index cannot tell you is
  // who chose this particular set of claims, so steps 2 and 4 are skipped and
  // the result says `signed: false`.
  const proof = asArray(doc.proof)[0];
  const signed = Boolean(proof && proof.eip712);
  result.signed = signed;
  const message: AgentCvMessage = signed
    ? proof.eip712.message
    : {
        chainId: Number(subject.agent.chainId),
        registry: String(subject.agent.agentRegistry ?? ""),
        agentId: Number(subject.agent.agentId),
        subject: didPkhAddress(String(subject.agent.controller ?? subject.id ?? ""))?.address ?? ZERO_ADDR,
        claimsRoot: ZERO32,
        documentHash: ZERO32,
        issuedAt: 0,
        expiresAt: 0,
        asOfBlock: Number(subject.summary?.asOfBlock ?? 0),
        asOfBlockHash: ZERO32,
        uri: String(doc.id ?? ""),
      };
  if (!signed && (!Number.isFinite(message.agentId) || !message.registry)) {
    return fail(step(2, "shape", "fail", "an unsigned index still needs credentialSubject.agent.{agentId, agentRegistry}"), "unsigned index is missing its subject");
  }
  result.chainId = Number(message.chainId);
  result.agentId = Number(message.agentId);

  // --- Step 2: documentHash ------------------------------------------------
  //
  // A derived presentation legitimately fails this step: it holds a subset of
  // record[], so it cannot hash to the full CV's documentHash. It declares that
  // in `derivedFrom`, and step 3 then proves each retained claim against the
  // SIGNED claimsRoot instead. What the signature stops covering in that case is
  // the unsigned half — summary and profile fields — so those are cross-checked
  // against the registry in step 8 and flagged here.
  const computedDocHash = cvDocumentHash(doc);
  const record = subject.record;
  result.documentHash = computedDocHash;
  if (!signed) {
    steps.push(step(2, "documentHash", "skip", `unsigned index — nothing was signed, so there is no documentHash to match (this document hashes to ${computedDocHash})`));
    steps.push(step(3, "claimsRoot", "skip", `${record.length} claim(s), root ${cvMerkleRoot(record.map((c) => cvLeaf(c)))} — computed here, committed to by nobody`));
    steps.push(step(4, "signature", "skip", "unsigned index: no author to authenticate. Every claim below is proved directly against the chain instead."));
    warnings.push("unsigned index: nothing in this document is attested by the agent. Claims still verify one by one; the SET of claims is whoever assembled it.");
    result.offlineOk = true;
    return verifyChainHalf();
  }
  const derivedFrom = doc.derivedFrom as { documentHash?: string } | undefined;
  const isDerived = Boolean(derivedFrom?.documentHash) && String(derivedFrom?.documentHash).toLowerCase() === String(message.documentHash).toLowerCase();
  if (computedDocHash.toLowerCase() !== String(message.documentHash).toLowerCase()) {
    if (!isDerived) {
      return fail(
        step(2, "documentHash", "fail", `computed ${computedDocHash}, signed ${message.documentHash}`),
        "documentHash mismatch — the document was altered after signing",
      );
    }
    steps.push(step(2, "documentHash", "skip", `derived presentation of ${message.documentHash}: only record[] is covered by the signature, through claimsRoot`));
    warnings.push("derived presentation: `summary` and the profile fields are not covered by the signature here — step 8 checks them against the registry's own counters");
  } else {
    steps.push(step(2, "documentHash", "pass", computedDocHash));
  }

  // The signed message pins the identity. A document whose body names a
  // different agent, owner or registry than the signature does is rejected
  // outright — this is what stops a derived presentation being re-pointed at
  // another agent.
  const bodyAgentId = Number(subject.agent.agentId);
  if (Number.isFinite(bodyAgentId) && bodyAgentId !== Number(message.agentId)) {
    return fail(step(2, "identity", "fail", `the body names agent #${bodyAgentId}, the signature covers #${message.agentId}`), "agentId mismatch between body and signature");
  }
  const bodySubject = didPkhAddress(String(subject.id ?? ""));
  if (bodySubject && getAddress(bodySubject.address) !== getAddress(String(message.subject))) {
    return fail(step(2, "identity", "fail", `credentialSubject.id is ${bodySubject.address}, the signature covers ${message.subject}`), "subject mismatch between body and signature");
  }
  if (subject.agent.agentRegistry && getAddress(String(subject.agent.agentRegistry)) !== getAddress(String(message.registry))) {
    return fail(step(2, "identity", "fail", `the body names registry ${subject.agent.agentRegistry}, the signature covers ${message.registry}`), "registry mismatch between body and signature");
  }

  // --- Step 3: claimsRoot --------------------------------------------------
  const leaves: string[] = [];
  let leafMismatch: string | null = null;
  for (const claim of record) {
    const computed = cvLeaf(claim);
    if (claim.leaf && claim.leaf.toLowerCase() !== computed.toLowerCase()) {
      leafMismatch = `${claim.id}: stated leaf ${claim.leaf} ≠ computed ${computed}`;
      break;
    }
    leaves.push(computed);
  }
  if (leafMismatch) {
    return fail(step(3, "claimsRoot", "fail", leafMismatch), `claim leaf mismatch (${leafMismatch})`);
  }
  const signedRoot = String(message.claimsRoot).toLowerCase();
  const derived = isDerived || record.some((c) => Array.isArray(c.path));
  let rootOk = false;
  let rootDetail = "";
  const fullRoot = cvMerkleRoot(leaves);
  if (fullRoot.toLowerCase() === signedRoot) {
    rootOk = true;
    rootDetail = `${leaves.length} leaves → ${fullRoot}`;
  } else if (derived) {
    // A derived presentation carries only some claims; each folds its own path
    // to the SAME signed root under the SAME signature.
    rootOk = record.length > 0;
    for (let i = 0; i < record.length; i++) {
      const claim = record[i];
      if (!Array.isArray(claim.path)) {
        rootOk = false;
        rootDetail = `${claim.id}: a partial presentation needs a merkle path on every claim`;
        break;
      }
      const folded = cvFoldPath(leaves[i], claim.path);
      if (folded.toLowerCase() !== signedRoot) {
        rootOk = false;
        rootDetail = `${claim.id}: path folds to ${folded}, signed root is ${message.claimsRoot}`;
        break;
      }
    }
    if (rootOk) rootDetail = `derived presentation: ${record.length} claim(s), every path folds to ${message.claimsRoot}`;
  } else {
    rootDetail = `computed ${fullRoot}, signed ${message.claimsRoot}`;
  }
  result.claimsRoot = signedRoot;
  if (!rootOk) {
    return fail(step(3, "claimsRoot", "fail", rootDetail), `claimsRoot mismatch (${rootDetail})`);
  }
  steps.push(step(3, "claimsRoot", "pass", rootDetail));

  // --- Step 4: signature ---------------------------------------------------
  const domain = proof.eip712.domain;
  const digest = cvDigest(domain as TypedDataDomain, message);
  if (proof.digest && proof.digest.toLowerCase() !== digest.toLowerCase()) {
    return fail(step(4, "signature", "fail", `stated digest ${proof.digest} ≠ computed ${digest}`), "digest mismatch");
  }
  const vm = didPkhAddress(String(proof.verificationMethod ?? ""));
  if (!vm) {
    return fail(step(4, "signature", "fail", `verificationMethod must be a did:pkh:eip155:<chainId>:<address> (got ${proof.verificationMethod})`), "bad verificationMethod");
  }
  if (vm.chainId !== Number(message.chainId)) {
    return fail(step(4, "signature", "fail", `verificationMethod is on chain ${vm.chainId}, message says ${message.chainId}`), "chainId mismatch");
  }
  let recovered: string | null = null;
  try {
    recovered = verifyTypedData(domain as TypedDataDomain, AGENT_CV_TYPES, message as unknown as Record<string, unknown>, proof.proofValue);
  } catch {
    recovered = null;
  }
  let signatureOk = recovered !== null && recovered === vm.address;
  let sigDetail = recovered ? `ecrecover → ${recovered}` : "signature could not be recovered";
  if (!signatureOk && provider) {
    // ERC-1271: an AgentAccount (or any contract wallet) signs through
    // isValidSignature — the same path X402Vault already uses.
    const ok1271 = await erc1271Ok(provider, vm.address, digest, proof.proofValue).catch(() => false);
    if (ok1271) {
      signatureOk = true;
      sigDetail = `ERC-1271 isValidSignature accepted by contract wallet ${vm.address}`;
    }
  }
  if (!signatureOk) {
    return fail(step(4, "signature", "fail", `${sigDetail}; verificationMethod names ${vm.address}`), "signature does not match verificationMethod");
  }
  result.signer = vm.address;
  steps.push(step(4, "signature", "pass", `${sigDetail} (digest ${digest})`));
  result.offlineOk = true;

  /** Steps 5–9: everything that needs a chain. Shared by the signed and unsigned paths. */
  async function verifyChainHalf(): Promise<CvVerifyResult> {
    if (!provider) {
      steps.push(step(5, "authority", "skip", "no RPC given — steps 5–9 need one (pass {rpc} or {provider})"));
      warnings.push("no RPC: the document is internally consistent and correctly signed, but nothing was checked against the chain");
      result.ok = false;
      result.skipped = record.length;
      for (const c of record) claimResults.push({ id: c.id, type: String(c.type), trust: c.evidence?.trust ?? "selfAttested", status: "skipped", reason: "no RPC" });
      return result;
    }
    result.chainChecked = true;

    // --- Step 5: authority (with registry pinning) ---------------------------
    const chainId = Number(message.chainId);
    const net = NETWORKS[chainId];
    // The verifier's OWN address table. Nothing in the document contributes to
    // it, so no claim can name the contract that answers for it.
    const pinned = cvTrustedContracts(chainId, opts.contracts);
    const verifiedClaims: CvClaim[] = [];
    if (!pinned.size) {
      warnings.push(`this verifier has no pinned contract addresses for chain ${chainId}: every chain claim will be reported unverifiable rather than accepted`);
    }
    const expectedRegistry = opts.registry ?? net?.registry;
    const expectedIdentity = opts.identityRegistry ?? net?.identity8004;
    const docRegistry = String(message.registry);
    if (!opts.allowUnknownRegistry && expectedRegistry && expectedRegistry !== ZERO_ADDR) {
      if (getAddress(docRegistry) !== getAddress(expectedRegistry)) {
        return fail(
          step(5, "authority", "fail", `the document names AgentRegistry ${docRegistry}; this verifier trusts ${expectedRegistry}`),
          "registry not pinned to a known AgentRegistry — an impostor can name a contract of its own",
        );
      }
    } else if (!expectedRegistry || expectedRegistry === ZERO_ADDR) {
      warnings.push(`no known AgentRegistry for chain ${chainId}: authority was checked against the address in the document (${docRegistry})`);
    }
    let owner: string | null = null;
    let agentOnChain: Record<string, unknown> | null = null;
    try {
      agentOnChain = await readAgent(provider, docRegistry, Number(message.agentId));
      owner = getAddress(String(agentOnChain.owner));
    } catch (err) {
      return fail(step(5, "authority", "fail", `AgentRegistry.getAgent(${message.agentId}) failed: ${(err as Error).message}`), "could not read the agent");
    }
    result.owner = owner;
    if (signed) {
      // TWO LEGITIMATE ISSUERS, and the difference is stated rather than hidden.
      //
      //   owner   — the agent signed its own CV. The strongest form: the key
      //             that signed is the key AgentRegistry says controls the agent.
      //   indexer — a known index (the Ferminux gateway) assembled and published
      //             it. That signature attests authorship and completeness of
      //             the off-chain half, nothing about any claim.
      //
      // The indexer key is pinned HERE, in the verifier's own network table, and
      // is never learned from the document or from an HTTP endpoint the issuer
      // controls. A document signed by anything else is refused outright.
      if (owner === result.signer) {
        result.issuerRole = "owner";
        steps.push(step(5, "authority", "pass", `getAgent(${message.agentId}).owner == ${owner} — self-issued by the agent`));
      } else {
        const issuers = (opts.issuers ?? net?.cvIssuers ?? []).map((a) => {
          try {
            return getAddress(a);
          } catch {
            return "";
          }
        });
        if (result.signer && issuers.includes(result.signer)) {
          result.issuerRole = "indexer";
          steps.push(
            step(5, "authority", "pass", `signed by the pinned index key ${result.signer}; AgentRegistry.getAgent(${message.agentId}).owner is ${owner}`),
          );
          warnings.push(
            "index-issued: the signature says an index assembled this document, not that the agent stands behind it. Every claim below is still proved against the chain, and nothing in the result depends on that key.",
          );
          if (opts.requireOwnerSigned) {
            return fail(step(5, "authority", "fail", "requireOwnerSigned was set and this CV is index-issued"), "not self-issued by the agent");
          }
        } else {
          return fail(
            step(5, "authority", "fail", `AgentRegistry.getAgent(${message.agentId}).owner is ${owner}, the CV is signed by ${result.signer}, which is not a pinned index key`),
            "the signer neither owns this agent nor is a known index — the claims may be true, but this key speaks for nobody",
          );
        }
      }
    } else {
      // No signature to hold anyone to, so the registry's own answer is taken as
      // authoritative and the document's claim about who owns the agent is
      // checked against it rather than the other way round.
      const declared = didPkhAddress(String(subject.agent.controller ?? subject.id ?? ""))?.address;
      if (declared && getAddress(declared) !== owner) {
        return fail(
          step(5, "authority", "fail", `the document says agent #${message.agentId} is owned by ${declared}; the registry says ${owner}`),
          "the document names the wrong owner for this agent",
        );
      }
      steps.push(step(5, "authority", "pass", `unsigned index: AgentRegistry.getAgent(${message.agentId}).owner == ${owner}, taken as the subject`));
    }

    // --- Step 6: supersession ------------------------------------------------
    const identityAddr = opts.identityRegistry ?? String(subject.agent.identityRegistry ?? domain.verifyingContract ?? "");
    if (!opts.allowUnknownRegistry && expectedIdentity && expectedIdentity !== ZERO_ADDR && identityAddr && getAddress(identityAddr) !== getAddress(expectedIdentity)) {
      warnings.push(`the document names IdentityRegistry8004 ${identityAddr}; this verifier trusts ${expectedIdentity} — supersession was checked against the trusted one`);
    }
    const anchorAddress = expectedIdentity && expectedIdentity !== ZERO_ADDR ? expectedIdentity : identityAddr;
    if (!signed) {
      steps.push(step(6, "supersession", "skip", "unsigned index: there is no signed documentHash for the on-chain pointer to match"));
    } else if (anchorAddress && isAddress(anchorAddress)) {
      try {
        const anchored = await readCvAnchor(provider, anchorAddress, Number(message.agentId));
        if (!anchored) {
          result.anchor = "unanchored";
          steps.push(step(6, "supersession", opts.requireAnchor ? "fail" : "skip", `getMetadata(${message.agentId}, "cv") is empty — never anchored`));
          if (opts.requireAnchor) {
            errors.push("the CV is not anchored on chain and requireAnchor was set");
          } else {
            warnings.push('not anchored on chain: individual claims still verify, but treat `summary` as self-asserted');
          }
        } else if (anchored.documentHash.toLowerCase() === computedDocHash.toLowerCase()) {
          result.anchor = "current";
          steps.push(step(6, "supersession", "pass", `getMetadata(${message.agentId}, "cv") == this documentHash — current`));
        } else {
          result.anchor = "superseded";
          steps.push(step(6, "supersession", "fail", `on chain the current CV is ${anchored.documentHash}; this one is ${computedDocHash}`));
          warnings.push("superseded: this CV was valid when issued, but a newer one is anchored — its numbers are stale");
        }
      } catch (err) {
        steps.push(step(6, "supersession", "skip", `getMetadata failed: ${(err as Error).message}`));
      }
    } else {
      steps.push(step(6, "supersession", "skip", "no IdentityRegistry8004 address to check against"));
    }

    // --- Step 7: per-claim evidence ------------------------------------------
    // The on-chain owner is authoritative for bind rules. In the signed path it
    // equals message.subject (step 5 proved it); in the unsigned path it is the
    // only trustworthy source, so a document cannot bind claims to an address
    // of its own choosing.
    const subjectAddress = owner ? getAddress(owner) : getAddress(String(message.subject));
    let anyClaimFailed = false;
    for (const claim of record) {
      const trust: CvTrust = (claim.evidence?.trust as CvTrust) ?? "selfAttested";
      if (tierIndex(trust) > tierIndex(floor)) {
        claimResults.push({ id: claim.id, type: String(claim.type), trust, status: "skipped", reason: `trust "${trust}" is below the "${floor}" floor` });
        result.skipped++;
        continue;
      }
      if (trust !== "chain") {
        claimResults.push({ id: claim.id, type: String(claim.type), trust, status: "skipped", reason: `trust "${trust}" carries no transaction to check` });
        result.skipped++;
        continue;
      }
      const verdict = await verifyChainClaim(provider, claim, { subjectAddress, subjectAgentId: Number(message.agentId), claim, pinned, chainId });
      if (verdict.ok) {
        claimResults.push({ id: claim.id, type: String(claim.type), trust, status: "verified", tx: claim.evidence.tx });
        result.verified++;
        verifiedClaims.push(claim);
      } else if (verdict.unrecognised) {
        // A claim this verifier has no rule for is NOT a failure and is NOT a
        // pass. It is skipped, loudly, so a newer claim type degrades to "I
        // cannot check this" rather than to "fine by me".
        claimResults.push({ id: claim.id, type: String(claim.type), trust, status: "skipped", reason: verdict.reason, tx: claim.evidence.tx });
        result.skipped++;
        warnings.push(`${claim.id}: ${verdict.reason}`);
      } else {
        claimResults.push({ id: claim.id, type: String(claim.type), trust, status: "rejected", reason: verdict.reason, tx: claim.evidence.tx });
        result.rejected++;
        anyClaimFailed = true;
      }
    }
    steps.push(
      step(
        7,
        "claims",
        anyClaimFailed ? "fail" : "pass",
        `${result.verified} verified, ${result.rejected} rejected, ${result.skipped} below the "${floor}" floor`,
      ),
    );
    if (anyClaimFailed) errors.push(`${result.rejected} claim(s) do not bind to the transactions they cite`);

    // --- Step 8: aggregate cross-check ---------------------------------------
    //
    // Two rules, and the second one is the important one.
    //
    // (a) The registry's counters BOUND the summary in both directions. Good
    //     news may not exceed them (that was always checked) and BAD news may
    //     not fall below them (that was not: a CV stating jobsFailed: 0 while
    //     the chain counted 6 verified clean).
    //
    // (b) Every money figure is RECOMPUTED from the claims that actually
    //     verified in step 7, and the stated figure must equal it. AgentRegistry
    //     keeps no earnings counter, so before this there was nothing at all
    //     bounding `escrowEarnedWei` — which is exactly the number a forgery
    //     inflates, and the number a hiring agent reads.
    if (agentOnChain) {
      const counters = {
        jobsCompleted: Number(agentOnChain.jobsCompleted ?? 0),
        jobsFailed: Number(agentOnChain.jobsFailed ?? 0),
        ratingCount: Number(agentOnChain.ratingCount ?? 0),
        ratingSum: Number(agentOnChain.ratingSum ?? 0),
      };
      const s = subject.summary ?? {};
      const problems: string[] = [];
      for (const key of ["jobsCompleted", "jobsFailed", "ratingCount", "ratingSum"] as const) {
        const stated = s[key];
        if (typeof stated === "number" && stated > counters[key]) problems.push(`${key}: the CV says ${stated}, the registry counts ${counters[key]}`);
      }
      // Understating bad news is a lie in the other direction.
      for (const key of ["jobsFailed"] as const) {
        const stated = s[key];
        if (typeof stated === "number" && stated < counters[key]) {
          problems.push(`${key}: the CV says ${stated}, the registry counts ${counters[key]} — a record may not understate its failures`);
        }
      }
      const completedClaims = record.filter((c) => c.type === "EscrowJob" && (c.outcome === "Completed" || c.outcome === "Resolved")).length;
      if (completedClaims > counters.jobsCompleted) problems.push(`record[] holds ${completedClaims} settled jobs, the registry counts ${counters.jobsCompleted} completed`);

      // (b) money, recomputed from verified claims only.
      const money = cvMoneyFromClaims(verifiedClaims);
      result.verifiedEarned = {
        escrowEarnedWei: money.escrowEarnedWei.toString(),
        x402EarnedWei: money.x402EarnedWei.toString(),
        x402SpentWei: money.x402SpentWei.toString(),
        payers: money.payers.size,
        paidJobs: money.paidJobs,
        zeroValueJobs: money.zeroValueJobs,
      };
      const omittedTypes = new Set((subject.recordMeta?.omitted ?? []).map((o) => String(o.type)));
      const checkMoney = (key: "escrowEarnedWei" | "x402EarnedWei" | "x402SpentWei", computed: bigint, omitType: string) => {
        const raw = s[key];
        if (raw === undefined || raw === null) return;
        let stated: bigint;
        try {
          stated = BigInt(String(raw));
        } catch {
          problems.push(`${key} is not an integer`);
          return;
        }
        if (stated === computed) return;
        if (stated > computed) {
          problems.push(`${key}: the CV states ${stated}, the claims that verified add up to ${computed} — a money figure may not exceed what was proved`);
          return;
        }
        // Stated LESS than proved is selective disclosure, not inflation.
        if (!omittedTypes.has(omitType)) {
          warnings.push(`${key}: the CV states ${stated}, less than the ${computed} its own verified claims add up to`);
        }
      };
      checkMoney("escrowEarnedWei", money.escrowEarnedWei, "EscrowJob");
      checkMoney("x402EarnedWei", money.x402EarnedWei, "X402Receipt");
      checkMoney("x402SpentWei", money.x402SpentWei, "X402Payment");

      if (problems.length) {
        steps.push(step(8, "aggregate", "fail", problems.join("; ")));
        errors.push("the CV's headline numbers do not survive the registry's own counters and its own verified claims");
        anyClaimFailed = true;
      } else {
        steps.push(
          step(
            8,
            "aggregate",
            "pass",
            `registry: jobsCompleted=${counters.jobsCompleted} jobsFailed=${counters.jobsFailed} ratingCount=${counters.ratingCount} ratingSum=${counters.ratingSum}; proved from claims: ${money.escrowEarnedWei} wei escrow + ${money.x402EarnedWei} wei x402 from ${money.payers.size} payer(s), ${money.paidJobs} paid job(s), ${money.zeroValueJobs} zero-value`,
          ),
        );
      }
      if (money.zeroValueJobs > 0) {
        warnings.push(
          `${money.zeroValueJobs} of this agent's settled jobs moved 0 FMX. ServiceEscrow mints a full jobsCompleted and a full rating for a job worth nothing, so weight the counters by the FMX that actually moved.`,
        );
      }
    }

    // --- Step 9: gateway attestation (never trusted, only reported) ----------
    const anchorEvidence = (doc.evidence ?? []).find((e) => Array.isArray(e.type) && (e.type as string[]).includes("FerminuxChainAnchor"));
    const attestation = anchorEvidence?.gatewayAttestation as { signer?: string; auditMerkleRoot?: string } | undefined;
    if (attestation?.signer) {
      steps.push(step(9, "completeness", "skip", `attested by ${attestation.signer}; it covers completeness of the off-chain index only, and every chain claim above verified without it`));
      warnings.push("completeness is attested, not proved: a stranger can prove every claim is true without Ferminux, but proving nothing was omitted means trusting that attestation or re-scanning the chain");
    } else {
      const meta = subject.recordMeta;
      steps.push(step(9, "completeness", "skip", meta?.complete ? "the issuer asserts the record is complete (unattested)" : "completeness is not claimed — assume selective disclosure and read recordMeta.omitted"));
    }

    result.ok = errors.length === 0 && !anyClaimFailed && (!opts.requireAnchor || result.anchor === "current");
    return result;
  }

  return verifyChainHalf();
}

async function erc1271Ok(provider: CvRpc, account: string, digest: string, sig: string): Promise<boolean> {
  if (provider.getCode) {
    const code = await provider.getCode(account).catch(() => "0x");
    if (!code || code === "0x") return false;
  }
  const iface = new Interface(["function isValidSignature(bytes32 hash, bytes sig) view returns (bytes4)"]);
  const data = iface.encodeFunctionData("isValidSignature", [digest, sig]);
  const raw = await provider.call({ to: account, data });
  return typeof raw === "string" && raw.slice(0, 10).toLowerCase() === ERC1271_MAGIC;
}

async function readAgent(provider: CvRpc, registry: string, agentId: number): Promise<Record<string, unknown>> {
  const iface = new Interface(REGISTRY_ABI as unknown as string[]);
  const data = iface.encodeFunctionData("getAgent", [agentId]);
  const raw = await provider.call({ to: getAddress(registry), data });
  const decoded = iface.decodeFunctionResult("getAgent", raw);
  const a = decoded[0] as unknown as Record<string, unknown>;
  if (!a || !a.owner || getAddress(String(a.owner)) === ZERO_ADDR) throw new Error(`agent ${agentId} is not registered`);
  return a;
}

/** `getMetadata(agentId, "cv")` → abi.decode(bytes32 documentHash, string uri); empty = never anchored. */
async function readCvAnchor(provider: CvRpc, identityRegistry: string, agentId: number, key = CV_METADATA_KEY): Promise<{ documentHash: string; uri: string } | null> {
  const iface = new Interface(IDENTITY_8004_ABI as unknown as string[]);
  const data = iface.encodeFunctionData("getMetadata", [agentId, key]);
  const raw = await provider.call({ to: getAddress(identityRegistry), data });
  const [bytes] = iface.decodeFunctionResult("getMetadata", raw);
  const hex = String(bytes);
  if (!hex || hex === "0x") return null;
  try {
    const [documentHash, uri] = AbiCoder.defaultAbiCoder().decode(["bytes32", "string"], hex);
    return { documentHash: String(documentHash), uri: String(uri) };
  } catch {
    // tolerate a bare bytes32 anchor
    if (hex.length === 66) return { documentHash: hex, uri: "" };
    return null;
  }
}

/**
 * One chain claim, checked against the chain and against THIS verifier's rules.
 *
 * Order matters: the address is pinned before anything is decoded, the rule is
 * looked up by (claim type, event) before any bind is read, and the document's
 * own `evidence.bind` is evaluated last, as an extra, never as the gate.
 */
async function verifyChainClaim(provider: CvRpc, claim: CvClaim, bindCtx: BindContext): Promise<{ ok: boolean; reason?: string; unrecognised?: boolean }> {
  const ev = claim.evidence;
  const pinned = bindCtx.pinned;
  const claimType = String(claim.type);

  // --- AgentState: no transaction, live state read from the pinned registry ---
  if (!ev.tx && (ev.method === "eth_call" || claimType === "AgentState")) {
    if (claimType !== "AgentState") return { ok: false, reason: "a chain-trust claim with no transaction must be an AgentState claim" };
    const registry = pinned.get("registry");
    if (!registry) return { ok: false, reason: "this verifier has no pinned AgentRegistry for this chain", unrecognised: true };
    let agent: Record<string, unknown>;
    try {
      agent = await readAgent(provider, registry, bindCtx.subjectAgentId);
    } catch (err) {
      return { ok: false, reason: `AgentRegistry.getAgent(${bindCtx.subjectAgentId}) failed: ${(err as Error).message}` };
    }
    if (getAddress(String(agent.owner)) !== bindCtx.subjectAddress) {
      return { ok: false, reason: `the registry says agent #${bindCtx.subjectAgentId} is owned by ${String(agent.owner)}, not ${bindCtx.subjectAddress}` };
    }
    for (const [claimField, stateField] of Object.entries(AGENT_STATE_FIELDS)) {
      const stated = (claim as Record<string, unknown>)[claimField];
      if (stated === undefined) continue;
      if (!sameValue(agent[stateField], stated)) {
        return {
          ok: false,
          reason: `getAgent(${bindCtx.subjectAgentId}).${stateField} is ${String(agent[stateField])}, the claim states ${String(stated)} — this document is stale or forged; refetch it`,
        };
      }
    }
    const statedStatus = (claim as Record<string, unknown>).status;
    if (statedStatus !== undefined && statedStatus !== null) {
      const onChain = AGENT_STATUS_NAMES[Number(agent.status ?? 0)] ?? "None";
      if (String(statedStatus) !== onChain) {
        return { ok: false, reason: `getAgent(${bindCtx.subjectAgentId}).status is ${onChain}, the claim states ${String(statedStatus)} — stale or forged` };
      }
    }
    return { ok: true };
  }

  if (!ev.tx) return { ok: false, reason: "a chain-trust claim must name a transaction" };

  // --- Rule 1: the emitting contract is pinned by the verifier ---------------
  if (!ev.address) return { ok: false, reason: "a chain-trust claim must name the contract that emitted its log" };
  const emitterRole = roleOfAddress(pinned, String(ev.address));
  if (!emitterRole) {
    return {
      ok: false,
      reason: `${ev.address} is not a contract this verifier knows on chain ${bindCtx.chainId} — a claim may only cite the pinned Ferminux contracts, never one the document supplies`,
    };
  }

  const receipt = await provider.getTransactionReceipt(ev.tx).catch(() => null);
  if (!receipt) return { ok: false, reason: `transaction ${ev.tx} not found on this RPC` };
  if (ev.status !== undefined && Number(ev.status) !== 1) return { ok: false, reason: "the claim states a failed transaction" };
  if (receipt.status !== undefined && Number(receipt.status) !== 1) return { ok: false, reason: `transaction ${ev.tx} reverted` };
  if (ev.block !== undefined && ev.block !== null && Number(receipt.blockNumber) !== Number(ev.block)) {
    return { ok: false, reason: `tx is in block ${receipt.blockNumber}, the claim says ${ev.block}` };
  }

  // Locate the log. `logIndex` is the index into THIS receipt's own `logs`
  // array; `blockLogIndex`, when present, is the block-scoped index the RPC
  // returns. Either may address the log, and whichever is used, the log found
  // must still carry the stated emitter and topic0.
  const addrOk = (l?: CvLog) => !!l && getAddress(l.address) === getAddress(String(ev.address));
  const topicOk = (l?: CvLog) => !!l && (!ev.topic0 || String(l.topics[0]).toLowerCase() === String(ev.topic0).toLowerCase());
  const blockScoped = ev.blockLogIndex;
  let log: CvLog | undefined;
  if (blockScoped !== undefined && blockScoped !== null) {
    log = receipt.logs.find((l) => Number(l.index ?? l.logIndex) === Number(blockScoped));
  }
  if (!log) {
    const wanted = ev.logIndex ?? 0;
    const byPosition = receipt.logs[wanted as number];
    if (addrOk(byPosition) && topicOk(byPosition)) log = byPosition;
    else log = receipt.logs.find((l) => Number(l.index ?? l.logIndex) === Number(wanted) && addrOk(l) && topicOk(l)) ?? byPosition;
  }
  if (!log) return { ok: false, reason: `no log at index ${ev.blockLogIndex ?? ev.logIndex ?? 0} in ${ev.tx}` };
  if (!addrOk(log)) return { ok: false, reason: `that log was emitted by ${log.address}, the claim says ${ev.address}` };

  // --- The event: named, self-checking, and decoded with OUR ABI only --------
  const topic0 = String(log.topics[0] ?? "");
  if (ev.topic0 && topic0.toLowerCase() !== String(ev.topic0).toLowerCase()) {
    return { ok: false, reason: `log topic0 is ${topic0}, the claim says ${ev.topic0}` };
  }
  if (ev.event) {
    const computedTopic0 = keccak256(toUtf8Bytes(String(ev.event)));
    if (computedTopic0.toLowerCase() !== topic0.toLowerCase()) return { ok: false, reason: `the log is not a ${ev.event}` };
  }
  const fragment = eventByTopic0(topic0);
  if (!fragment) return { ok: false, reason: `this verifier has no ABI for topic0 ${topic0}`, unrecognised: true };
  const signature = fragment.format("sighash");
  let args: Record<string, unknown>;
  try {
    args = cvInterface().decodeEventLog(fragment, log.data, log.topics as string[]) as unknown as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `could not decode ${signature}: ${(err as Error).message}` };
  }

  // --- Rule 2: the verifier's own rule for (type, event) ---------------------
  const rule = CLAIM_RULES[`${claimType}|${signature}`];
  if (!rule) {
    return {
      ok: false,
      unrecognised: true,
      reason: `this verifier has no rule for a ${claimType} claim proved by ${signature} — it is reported, never counted as proved`,
    };
  }
  if (rule.role !== emitterRole) {
    return { ok: false, reason: `a ${claimType} claim must cite ${rule.role} (${pinned.get(rule.role) ?? "not deployed"}); this log came from ${emitterRole}` };
  }
  for (const banned of rule.forbidden ?? []) {
    if ((claim as Record<string, unknown>)[banned] !== undefined) {
      return {
        ok: false,
        reason: `a ${claimType} claim may not carry "${banned}": that is mutable registry state with no history and no event, and no transaction proves its current value. It belongs in an AgentState claim, which is read live.`,
      };
    }
  }

  // The tie to THIS subject, from the verifier's table rather than the document.
  for (const s of rule.subject) {
    const expected = s.equals === "subject.agentId" ? bindCtx.subjectAgentId : bindCtx.subjectAddress;
    if (s.log !== undefined) {
      const actual = args[s.log];
      if (actual === undefined) return { ok: false, reason: `${signature} has no field "${s.log}"` };
      if (!sameValue(actual, expected)) return { ok: false, reason: `log.${s.log} is ${String(actual)}, this agent is ${String(expected)} — the transaction is not this agent's` };
      continue;
    }
    if (s.call) {
      const target = pinned.get(s.call.role);
      if (!target) return { ok: false, reason: `this verifier has no pinned ${s.call.role} to resolve the claim against`, unrecognised: true };
      const value = await callPinned(provider, target, s.call.fn, s.call.args, s.call.field, bindCtx);
      if (value.error) return { ok: false, reason: value.error };
      if (!sameValue(value.value, expected)) {
        return { ok: false, reason: `${s.call.role}.${s.call.fn}.${s.call.field} is ${String(value.value)}, this agent is ${String(expected)} — the transaction is not this agent's` };
      }
    }
  }

  // Every field the claim states that the log also carries. This is the check
  // whose absence let a proven:true claim state a 100x payout and a five-star
  // rating on a job the log records as unrated and one-hundredth the size.
  for (const [claimField, logField] of Object.entries(rule.fields ?? {})) {
    const stated = (claim as Record<string, unknown>)[claimField];
    if (stated === undefined) continue;
    const actual = args[logField];
    if (actual === undefined) return { ok: false, reason: `${signature} has no field "${logField}" to check ${claimField} against` };
    if (stated === null) {
      if (rule.nullMeansZero?.includes(claimField)) {
        if (!sameValue(actual, 0)) return { ok: false, reason: `the claim states ${claimField}: null, the log records ${logField} = ${String(actual)}` };
        continue;
      }
      return { ok: false, reason: `the claim states ${claimField}: null, but the log carries ${logField} = ${String(actual)}` };
    }
    if (!sameValue(actual, stated)) {
      return { ok: false, reason: `the claim states ${claimField} = ${String(stated)}, the log records ${logField} = ${String(actual)}` };
    }
  }

  // --- The document's own bind rules, last, as an extra ----------------------
  for (const bind of ev.bind ?? []) {
    const expected = resolveRef(bind.equals, bindCtx);
    if (bind.log !== undefined) {
      const actual = args[bind.log];
      if (actual === undefined) return { ok: false, reason: `the log has no field "${bind.log}"` };
      if (!sameValue(actual, expected)) {
        return { ok: false, reason: `log.${bind.log} is ${String(actual)}, the claim binds it to ${bind.equals} = ${String(expected)}` };
      }
      continue;
    }
    if (bind.call) {
      // A stated bind target is only ever accepted when it is one of the pinned
      // contracts. This is the line the 58,500 FMX forgery walked through.
      const role = roleOfAddress(pinned, String(bind.call.address));
      if (!role) {
        return { ok: false, reason: `the claim binds itself to ${bind.call.address}, which is not a contract this verifier knows — an attacker may not supply the contract that answers for it` };
      }
      const value = await callPinned(provider, pinned.get(role)!, bind.call.fn, bind.call.args, bind.call.field, bindCtx);
      if (value.error) return { ok: false, reason: value.error };
      if (!sameValue(value.value, expected)) {
        return { ok: false, reason: `${bind.call.fn}.${bind.call.field} is ${String(value.value)}, the claim binds it to ${bind.equals} = ${String(expected)}` };
      }
      continue;
    }
    return { ok: false, reason: "a bind rule must carry either `log` or `call`" };
  }
  return { ok: true };
}

/** One `eth_call` into a PINNED contract, decoded with the verifier's own ABI. */
async function callPinned(
  provider: CvRpc,
  target: string,
  fn: string,
  rawArgs: unknown[],
  field: string,
  bindCtx: BindContext,
): Promise<{ value?: unknown; error?: string }> {
  const fnArgs = rawArgs.map((a) => (typeof a === "string" && (a.startsWith("claim.") || a.startsWith("subject.")) ? resolveRef(a, bindCtx) : a));
  try {
    const iface = cvInterface();
    const frag = iface.getFunction(fn);
    if (!frag) return { error: `unknown view function "${fn}"` };
    const data = iface.encodeFunctionData(frag, fnArgs as unknown[]);
    const raw = await provider.call({ to: getAddress(target), data });
    const decoded = iface.decodeFunctionResult(frag, raw);
    const value = decodedField(decoded, field);
    if (value === undefined) return { error: `${fn} returned no field "${field}"` };
    return { value };
  } catch (err) {
    return { error: `${fn} on ${target} failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Selective disclosure — same signature, fewer claims
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Derives a presentation holding only `claimIds`, each carrying the merkle path
 * that folds to the SAME signed `claimsRoot`. The signature is unchanged and
 * still verifies; `documentHash` no longer matches the derived document, so the
 * presentation carries `derivedFrom` and step 2 is reported as derived.
 *
 * `recordMeta.omitted` is rewritten so that what was dropped is declared rather
 * than hidden.
 */
export function presentCv(source: CvDocument, claimIds: readonly string[]): CvDocument {
  // An unsigned index can be narrowed too — there is simply no signature to
  // preserve, so the result is a filtered document whose claims still verify one
  // by one against the chain. It says so rather than pretending otherwise.
  const proof = asArray(source.proof)[0];
  // Deep copy: a presentation must never be able to mutate the CV it came from,
  // or deriving one would quietly rewrite the original's identity fields.
  const doc: CvDocument = deepClone(source);
  const record = doc.credentialSubject.record;
  const leaves = record.map((c) => cvLeaf(c));
  const wanted = new Set(claimIds);
  const kept: CvClaim[] = [];
  const dropped = new Map<string, number>();
  record.forEach((claim, i) => {
    if (wanted.has(claim.id)) {
      kept.push({ ...claim, leaf: leaves[i], path: cvMerklePath(leaves, i) });
    } else {
      dropped.set(String(claim.type), (dropped.get(String(claim.type)) ?? 0) + 1);
    }
  });
  const missing = claimIds.filter((id) => !record.some((c) => c.id === id));
  if (missing.length) throw new Error(`Ferminux: no such claim(s) in this CV: ${missing.join(", ")}`);

  const out: CvDocument = {
    ...doc,
    credentialSubject: {
      ...doc.credentialSubject,
      record: kept,
      recordMeta: {
        ...(doc.credentialSubject.recordMeta ?? { count: 0, complete: false }),
        count: kept.length,
        complete: false,
        derived: true,
        omitted: [...dropped.entries()].map(([type, count]) => ({ type, count, reason: "not disclosed in this presentation" })),
        omittedNote: "A derived presentation MUST declare what it left out, by type and count, so selective disclosure is visible rather than silent.",
      },
    },
    derivedFrom: proof
      ? {
          documentHash: proof.eip712.message.documentHash,
          claimsRoot: proof.eip712.message.claimsRoot,
          note: "Derived presentation: documentHash covers the full CV, not this subset. Every claim below folds its merkle path to the signed claimsRoot under the unchanged signature.",
        }
      : {
          claimsRoot: cvMerkleRoot(leaves),
          note: "Narrowed from an UNSIGNED index — there was no signature to preserve. Each claim below still names the transaction that proves it, so verify them one by one; the choice of which claims to show is whoever handed you this.",
        },
  };
  return out;
}

// ---------------------------------------------------------------------------
// Building, signing and anchoring — the agent's own side
// ---------------------------------------------------------------------------

export interface CvBuildOptions {
  /** ceiling on record[] length; anything beyond is summarised in recordMeta.omitted (default 200) */
  maxClaims?: number;
  /**
   * Publishing a CV publishes the agent's counterparty graph. It is already
   * public on chain, but the CV makes it trivially indexable — so outgoing
   * payments are an explicit choice (default true, matching the reference CV).
   */
  payments?: boolean;
  /** first block to scan (default the network's deploy block) */
  fromBlock?: number;
  /** where the signed copy will live; goes inside the signature */
  uri?: string;
  /** validity window in seconds (default 90 days) */
  ttlSeconds?: number;
  /** enrich the document with the agent card from the gateway (name, capabilities). Never scored. */
  card?: boolean;
}

export interface CvGetOptions extends CvBuildOptions {
  /** "auto" (default): ask the gateway, build locally if it has no CV route. "never": gateway only. "always": build locally. */
  source?: "auto" | "never" | "always";
}

interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  index: number;
  transactionIndex: number;
}

function iso(unixSeconds: number | bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Index of a log inside its own transaction receipt (what `evidence.logIndex` means). */
function receiptLogIndex(logs: readonly LogLike[], target: LogLike): number {
  const sameTx = logs.filter((l) => l.transactionHash === target.transactionHash).sort((a, b) => a.index - b.index);
  const i = sameTx.findIndex((l) => l.index === target.index);
  return i < 0 ? 0 : i;
}

function evidenceOf(chainId: number, log: LogLike, event: string, blockTime: number | undefined, receiptIndex: number, bind?: CvBind[]): CvEvidence {
  const ev: CvEvidence = {
    trust: "chain",
    chainId,
    block: log.blockNumber,
    tx: log.transactionHash,
    logIndex: receiptIndex,
    // The block-scoped index the RPC itself returns. `logIndex` above is the
    // position inside THIS receipt's logs array; on a chain whose blocks hold
    // one transaction the two coincide, and the first block that holds two is
    // the one where a reader guessing between them gets a different answer.
    blockLogIndex: log.index ?? null,
    address: getAddress(log.address),
    event,
    topic0: keccak256(toUtf8Bytes(event)),
    method: "eth_getTransactionReceipt",
  };
  if (blockTime !== undefined) ev.blockTime = iso(blockTime);
  if (bind) ev.bind = bind;
  return ev;
}

export class CvAPI {
  private readonly identity: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.identity = lazyContract("identity8004", () => this.fmx.v3.identity8004, IDENTITY_8004_ABI as unknown as string[], this.fmx.runner);
  }

  /**
   * An agent's CV. Asks the gateway first (one HTTP call, cached, and it carries
   * the gateway's completeness attestation); falls back to building the document
   * locally from chain logs when the gateway has no CV route or is unreachable.
   *
   * Nothing here is trusted: run `fmx.cv.verify(doc)` on whatever comes back.
   */
  async get(agent: number | bigint | string, opts: CvGetOptions = {}): Promise<CvDocument> {
    const source = opts.source ?? "auto";
    if (source !== "always") {
      for (const path of [`/agents/${agent}/cv.json`, `/cv/${agent}.json`, `/cv/${agent}`]) {
        try {
          const doc = await this.fmx.gatewayGet<CvDocument>(path);
          if (doc && typeof doc === "object" && Array.isArray((doc as CvDocument)["@context"])) return doc;
        } catch {
          /* route not there yet — try the next shape, then build locally */
        }
      }
      if (source === "never") throw new Error(`Ferminux: the gateway has no CV for ${agent} (and source: "never" forbids building one locally)`);
    }
    const id = typeof agent === "string" && !/^\d+$/.test(agent) ? await this.resolveSlug(agent) : Number(agent);
    return this.build(id, opts);
  }

  /** The signed, portable credential: `get()` plus a hard requirement that it carries a proof. */
  async credential(agent: number | bigint | string, opts: CvGetOptions = {}): Promise<CvDocument> {
    const doc = await this.get(agent, opts);
    if (!asArray(doc.proof).length) {
      throw new Error(
        `Ferminux: agent ${agent} has no signed CV yet — its owner must run fmx.cv.sign() (the document from fmx.cv.get() is an unsigned index over chain history)`,
      );
    }
    return doc;
  }

  /** The stranger-side verification, client-side. Only an RPC is contacted — never a Ferminux service. */
  async verify(doc: CvDocument, opts: CvVerifyOptions = {}): Promise<CvVerifyResult> {
    return verifyCv(doc, { provider: opts.provider ?? (this.fmx.provider as unknown as CvRpc), ...opts });
  }

  /** Derives a presentation carrying only `claimIds` — unchanged signature, merkle paths to the same root. */
  present(doc: CvDocument, claimIds: readonly string[]): CvDocument {
    return presentCv(doc, claimIds);
  }

  /** keccak256(utf8(canonicalJson(doc without proof))) — the value that gets anchored. */
  documentHash(doc: CvDocument): string {
    return cvDocumentHash(doc);
  }

  /**
   * Builds an agent's CV from chain history: one eth_getLogs sweep per contract,
   * then one receipt per cited transaction. Works with no gateway at all
   * (`card: false`), which is what makes the record portable off this network.
   */
  async build(agentId: number | bigint, opts: CvBuildOptions = {}): Promise<CvDocument> {
    const id = Number(agentId);
    const chainId = this.fmx.chainId;
    const net = NETWORKS[chainId];
    const provider = this.fmx.provider as unknown as {
      getLogs(f: Record<string, unknown>): Promise<LogLike[]>;
      getBlock(tag: number | string): Promise<{ number: number; hash: string | null; timestamp: number } | null>;
    };
    const registryAddr = getAddress(net.registry);
    const escrowAddr = getAddress(net.escrow);
    const fromBlock = opts.fromBlock ?? net.deployBlock ?? 0;
    const maxClaims = opts.maxClaims ?? 200;
    const includePayments = opts.payments ?? true;

    const registry = new Contract(registryAddr, REGISTRY_ABI as unknown as string[], this.fmx.provider);
    const escrow = new Contract(escrowAddr, ESCROW_ABI as unknown as string[], this.fmx.provider);

    const head = await provider.getBlock("latest");
    if (!head) throw new Error("Ferminux: RPC returned no head block");
    const asOfBlock = head.number;
    const asOfBlockHash = head.hash ?? ZERO32;

    const agent = (await registry.getAgent(id)) as unknown as Record<string, unknown>;
    const owner = getAddress(String(agent.owner));
    if (owner === ZERO_ADDR) throw new Error(`Ferminux: agent ${id} is not registered on chain ${chainId}`);

    const blockTimes = new Map<number, number>();
    const timeOf = async (block: number): Promise<number | undefined> => {
      if (blockTimes.has(block)) return blockTimes.get(block);
      const b = await provider.getBlock(block).catch(() => null);
      if (b) blockTimes.set(block, b.timestamp);
      return b?.timestamp;
    };

    const topic = (sig: string) => keccak256(toUtf8Bytes(sig));
    const idTopic = "0x" + BigInt(id).toString(16).padStart(64, "0");
    const addrTopic = "0x" + owner.slice(2).toLowerCase().padStart(64, "0");
    const getLogs = async (address: string, topics: (string | null)[]): Promise<LogLike[]> => {
      try {
        return await provider.getLogs({ address, topics, fromBlock, toBlock: "latest" });
      } catch {
        return [];
      }
    };

    const claims: CvClaim[] = [];
    const omitted: Array<{ type: string; count: number; reason: string }> = [];
    const push = (claim: CvClaim, type: string) => {
      if (claims.length >= maxClaims) {
        const row = omitted.find((o) => o.type === type);
        if (row) row.count++;
        else omitted.push({ type, count: 1, reason: `beyond the ${maxClaims}-claim ceiling of this export` });
        return;
      }
      claims.push(claim);
    };

    // --- Registration ------------------------------------------------------
    const REGISTERED = "AgentRegistered(uint256,address,string,string,string,uint256,uint256)";
    const regLogs = await getLogs(registryAddr, [topic(REGISTERED), idTopic]);
    for (const log of regLogs) {
      const args = registry.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
      const t = await timeOf(log.blockNumber);
      push(
        {
          id: `fmx:${id}:registration`,
          type: "Registration",
          statedAt: t !== undefined ? iso(t) : undefined,
          agentId: id,
          name: String(args?.name ?? agent.name ?? ""),
          // AS REGISTERED, and named so. The live endpoint, price, bond and
          // status are mutable registry state the owner rewrites at will; they
          // are not what this log says and they belong in the AgentState claim,
          // which a verifier re-reads from the registry every time.
          endpointAtRegistration: String(args?.endpoint ?? ""),
          metadataURIAtRegistration: String(args?.metadataURI ?? ""),
          pricePerJobWeiAtRegistration: String(args?.pricePerJob ?? "0"),
          bondWeiAtRegistration: String(args?.bond ?? "0"),
          mutableNote: "endpoint, price, bond and status can be changed by the owner at any time with no history. Read the AgentState claim (or AgentRegistry.getAgent) for what is true now.",
          evidence: evidenceOf(chainId, log, REGISTERED, t, receiptLogIndex(regLogs, log), [
            { log: "id", equals: "subject.agentId" },
            { log: "owner", equals: "subject.address" },
          ]),
        },
        "Registration",
      );
    }

    // --- Live registry state -----------------------------------------------
    //
    // Endpoint, status, price and bond are the mutable half of an agent. There
    // is no event carrying their CURRENT value, so this claim carries no
    // transaction: a verifier re-reads AgentRegistry.getAgent at verification
    // time and rejects the claim if the answer differs. A stale document and a
    // forged one get the same answer on purpose — the endpoint is where a client
    // sends work and money, and "probably still right" is not good enough there.
    push(
      {
        id: `fmx:${id}:state`,
        type: "AgentState",
        statedAt: iso(Math.floor(Date.now() / 1000)),
        agentId: id,
        owner,
        endpoint: String(agent.endpoint ?? ""),
        metadataURI: String(agent.metadataURI ?? ""),
        pricePerJobWei: String(agent.pricePerJob ?? "0"),
        bondWei: String(agent.bond ?? "0"),
        status: AGENT_STATUS_NAMES[Number(agent.status ?? 0)] ?? "None",
        note: "read live from AgentRegistry at this block. The owner can rewrite all of it in one transaction, with no history — verify it again yourself before you send anything anywhere.",
        evidence: {
          trust: "chain",
          chainId,
          address: registryAddr,
          method: "eth_call",
          call: `getAgent(${id})`,
          note: "no transaction proves a mutable field's current value; this is a live read, checked again by the verifier",
        } as CvEvidence,
      },
      "AgentState",
    );

    // --- Escrow jobs -------------------------------------------------------
    const REQUESTED = "JobRequested(uint256,uint256,address,uint256,bytes32,string)";
    const DELIVERED = "JobDelivered(uint256,bytes32,string)";
    const COMPLETED = "JobCompleted(uint256,uint256,uint256,uint8)";
    const REFUNDED = "JobRefunded(uint256,uint256,bool)";
    const RESOLVED = "JobResolved(uint256,uint256,uint256,uint256)";
    const reqLogs = await getLogs(escrowAddr, [topic(REQUESTED), null, idTopic]);
    let escrowEarned = 0n;
    let disputesLost = 0;
    for (const req of reqLogs) {
      const reqArgs = escrow.interface.parseLog({ topics: req.topics as string[], data: req.data })?.args;
      const jobId = Number(reqArgs?.jobId ?? 0);
      if (!jobId) continue;
      const jobTopic = "0x" + BigInt(jobId).toString(16).padStart(64, "0");
      const [doneLogs, delivLogs, refundLogs, resolveLogs] = await Promise.all([
        getLogs(escrowAddr, [topic(COMPLETED), jobTopic]),
        getLogs(escrowAddr, [topic(DELIVERED), jobTopic]),
        getLogs(escrowAddr, [topic(REFUNDED), jobTopic]),
        getLogs(escrowAddr, [topic(RESOLVED), jobTopic]),
      ]);
      const job = (await escrow.getJob(jobId)) as unknown as Record<string, unknown>;
      const settle = doneLogs[0] ?? resolveLogs[0] ?? refundLogs[0];
      if (!settle) continue; // still open — an unsettled job is not a record of work done
      const settleEvent = doneLogs[0] ? COMPLETED : resolveLogs[0] ? RESOLVED : REFUNDED;
      const settleArgs = escrow.interface.parseLog({ topics: settle.topics as string[], data: settle.data })?.args;
      const t = await timeOf(settle.blockNumber);
      const reqTime = await timeOf(req.blockNumber);
      const outcome = doneLogs[0] ? "Completed" : resolveLogs[0] ? "Resolved" : "Refunded";
      const rawRating = doneLogs[0] ? Number(settleArgs?.rating ?? 0) : 0;
      const payout = BigInt(String(settleArgs?.agentPayout ?? 0));
      if (outcome !== "Refunded") escrowEarned += payout;
      if (outcome === "Resolved") disputesLost++;
      const bind: CvBind[] = [
        { log: "jobId", equals: "claim.jobId" },
        { call: { address: escrowAddr, fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" },
        { call: { address: escrowAddr, fn: "getJob(uint256)", args: ["claim.jobId"], field: "outputHash" }, equals: "claim.outputHash" },
      ];
      if (doneLogs[0]) bind.splice(1, 0, { log: "rating", equals: "claim.rating|0" });
      const also: CvEvidence[] = [];
      if (reqArgs) {
        const rt = await timeOf(req.blockNumber);
        also.push(evidenceOf(chainId, req, REQUESTED, rt, receiptLogIndex(reqLogs, req)));
      }
      if (delivLogs[0]) {
        const dt = await timeOf(delivLogs[0].blockNumber);
        also.push(evidenceOf(chainId, delivLogs[0], DELIVERED, dt, receiptLogIndex(delivLogs, delivLogs[0])));
      }
      push(
        {
          id: `fmx:${id}:job:${jobId}`,
          type: "EscrowJob",
          statedAt: t !== undefined ? iso(t) : undefined,
          jobId,
          client: getAddress(String(reqArgs?.client ?? job.client ?? ZERO_ADDR)),
          amountWei: String(reqArgs?.amount ?? job.amount ?? "0"),
          payoutWei: String(settleArgs?.agentPayout ?? "0"),
          feeWei: String(settleArgs?.fee ?? "0"),
          outcome,
          // ServiceEscrow.claim() records rating 0 for a job the client never
          // reviewed, so 0 means UNRATED, not "rated zero". Never coerce null to 0.
          rating: doneLogs[0] && rawRating > 0 ? rawRating : null,
          ratingScale: doneLogs[0] && rawRating > 0 ? "1..5" : undefined,
          ratingNote: doneLogs[0] && rawRating === 0 ? "released without a rating (rating 0 = unrated)" : undefined,
          inputHash: String(job.inputHash ?? ZERO32),
          outputHash: String(job.outputHash ?? ZERO32),
          requestedAt: reqTime !== undefined ? iso(reqTime) : undefined,
          settledAt: t !== undefined ? iso(t) : undefined,
          evidence: evidenceOf(chainId, settle, settleEvent, t, receiptLogIndex(doneLogs.concat(resolveLogs, refundLogs), settle), bind),
          alsoEvidence: also.length ? also : undefined,
        },
        "EscrowJob",
      );
    }

    // --- x402 settlements --------------------------------------------------
    const SETTLED = "Settled(address,address,uint256,uint256,uint256,bytes32)";
    let x402Earned = 0n;
    let x402Spent = 0n;
    let receiptCount = 0;
    let paymentCount = 0;
    if (this.fmx.v3.x402Vault) {
      const vaultAddr = getAddress(this.fmx.v3.x402Vault);
      const vault = new Contract(vaultAddr, X402_VAULT_ABI as unknown as string[], this.fmx.provider);
      const inLogs = await getLogs(vaultAddr, [topic(SETTLED), null, addrTopic]);
      for (const log of inLogs) {
        const args = vault.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
        receiptCount++;
        // The vault credits the payee `amount - fee`, so that is what was earned.
        x402Earned += BigInt(String(args?.amount ?? 0)) - BigInt(String(args?.fee ?? 0));
        const t = await timeOf(log.blockNumber);
        push(
          {
            id: `fmx:${id}:x402:in:${String(args?.nonce ?? log.index)}`,
            type: "X402Receipt",
            statedAt: t !== undefined ? iso(t) : undefined,
            payer: getAddress(String(args?.payer ?? ZERO_ADDR)),
            payee: owner,
            amountWei: String(args?.amount ?? 0),
            feeWei: String(args?.fee ?? 0),
            nonce: String(args?.nonce ?? 0),
            evidence: evidenceOf(chainId, log, SETTLED, t, receiptLogIndex(inLogs, log), [
              { log: "payee", equals: "subject.address" },
              { log: "nonce", equals: "claim.nonce" },
              { log: "amount", equals: "claim.amountWei" },
            ]),
          },
          "X402Receipt",
        );
      }
      const outLogs = await getLogs(vaultAddr, [topic(SETTLED), addrTopic]);
      for (const log of outLogs) {
        const args = vault.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
        paymentCount++;
        x402Spent += BigInt(String(args?.amount ?? 0));
        if (!includePayments) continue;
        const t = await timeOf(log.blockNumber);
        push(
          {
            id: `fmx:${id}:x402:out:${String(args?.nonce ?? log.index)}`,
            type: "X402Payment",
            statedAt: t !== undefined ? iso(t) : undefined,
            payer: owner,
            payee: getAddress(String(args?.payee ?? ZERO_ADDR)),
            amountWei: String(args?.amount ?? 0),
            feeWei: String(args?.fee ?? 0),
            nonce: String(args?.nonce ?? 0),
            note: "this agent hires other agents; counterparty history is part of the record",
            evidence: evidenceOf(chainId, log, SETTLED, t, receiptLogIndex(outLogs, log), [
              { log: "payer", equals: "subject.address" },
              { log: "nonce", equals: "claim.nonce" },
            ]),
          },
          "X402Payment",
        );
      }
      if (!includePayments && paymentCount) {
        omitted.push({ type: "X402Payment", count: paymentCount, reason: "outgoing payments withheld: publishing them publishes the agent's counterparty graph" });
      }
    }

    // --- Subscription plans ------------------------------------------------
    const PLAN_CREATED = "PlanCreated(uint256,address,uint256,uint64,string)";
    let plans = 0;
    if (this.fmx.v3.streamPay) {
      const streamAddr = getAddress(this.fmx.v3.streamPay);
      const stream = new Contract(streamAddr, STREAM_PAY_ABI as unknown as string[], this.fmx.provider);
      const planLogs = await getLogs(streamAddr, [topic(PLAN_CREATED), null, addrTopic]);
      for (const log of planLogs) {
        const args = stream.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
        plans++;
        const t = await timeOf(log.blockNumber);
        push(
          {
            id: `fmx:${id}:plan:${String(args?.planId ?? 0)}`,
            type: "SubscriptionPlan",
            statedAt: t !== undefined ? iso(t) : undefined,
            planId: Number(args?.planId ?? 0),
            payee: owner,
            pricePerPeriodWei: String(args?.pricePerPeriod ?? 0),
            periodSeconds: Number(args?.period ?? 0),
            metadataURI: String(args?.metadataURI ?? ""),
            evidence: evidenceOf(chainId, log, PLAN_CREATED, t, receiptLogIndex(planLogs, log), [
              { log: "planId", equals: "claim.planId" },
              { log: "payee", equals: "subject.address" },
            ]),
          },
          "SubscriptionPlan",
        );
      }
    }

    // --- FRC-8004 feedback and validations ---------------------------------
    const NEW_FEEDBACK = "NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)";
    if (this.fmx.v3.reputation8004) {
      const repAddr = getAddress(this.fmx.v3.reputation8004);
      const rep = new Contract(repAddr, REPUTATION_8004_ABI as unknown as string[], this.fmx.provider);
      const fbLogs = await getLogs(repAddr, [topic(NEW_FEEDBACK), idTopic]);
      for (const log of fbLogs) {
        const args = rep.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
        const t = await timeOf(log.blockNumber);
        push(
          {
            id: `fmx:${id}:feedback:${String(args?.clientAddress ?? "")}:${String(args?.feedbackIndex ?? 0)}`,
            type: "Feedback",
            statedAt: t !== undefined ? iso(t) : undefined,
            client: getAddress(String(args?.clientAddress ?? ZERO_ADDR)),
            value: String(args?.value ?? 0),
            valueDecimals: Number(args?.valueDecimals ?? 0),
            tag1: String(args?.tag1 ?? ""),
            tag2: String(args?.tag2 ?? ""),
            note: "FRC-8004 feedback is permissionless: anyone but the owner may write one. Weigh it by whether the author also paid this agent.",
            evidence: evidenceOf(chainId, log, NEW_FEEDBACK, t, receiptLogIndex(fbLogs, log), [{ log: "agentId", equals: "subject.agentId" }]),
          },
          "Feedback",
        );
      }
    }
    const VALIDATION_RESPONSE = "ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)";
    if (this.fmx.v3.validation8004) {
      const valAddr = getAddress(this.fmx.v3.validation8004);
      const val = new Contract(valAddr, VALIDATION_8004_ABI as unknown as string[], this.fmx.provider);
      const valLogs = await getLogs(valAddr, [topic(VALIDATION_RESPONSE), null, idTopic]);
      for (const log of valLogs) {
        const args = val.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
        const t = await timeOf(log.blockNumber);
        push(
          {
            id: `fmx:${id}:validation:${String(args?.requestHash ?? "")}`,
            type: "Validation",
            statedAt: t !== undefined ? iso(t) : undefined,
            validator: getAddress(String(args?.validatorAddress ?? ZERO_ADDR)),
            response: Number(args?.response ?? 0),
            responseScale: "0..100",
            tag: String(args?.tag ?? ""),
            requestHash: String(args?.requestHash ?? ZERO32),
            note: "a validator named by the agent's own owner is self-attested; check who the validator is before weighing this",
            evidence: evidenceOf(chainId, log, VALIDATION_RESPONSE, t, receiptLogIndex(valLogs, log), [{ log: "agentId", equals: "subject.agentId" }]),
          },
          "Validation",
        );
      }
    }

    // --- Slashes -----------------------------------------------------------
    const SLASHED = "AgentSlashed(uint256,uint256,address,string)";
    const slashLogs = await getLogs(registryAddr, [topic(SLASHED), idTopic]);
    for (const log of slashLogs) {
      const args = registry.interface.parseLog({ topics: log.topics as string[], data: log.data })?.args;
      const t = await timeOf(log.blockNumber);
      push(
        {
          id: `fmx:${id}:slash:${log.transactionHash}`,
          type: "Slash",
          statedAt: t !== undefined ? iso(t) : undefined,
          amountWei: String(args?.amount ?? 0),
          to: getAddress(String(args?.to ?? ZERO_ADDR)),
          reason: String(args?.reason ?? ""),
          evidence: evidenceOf(chainId, log, SLASHED, t, receiptLogIndex(slashLogs, log), [{ log: "id", equals: "subject.agentId" }]),
        },
        "Slash",
      );
    }

    // --- Memory anchor -----------------------------------------------------
    const memAnchor = await this.anchored(id, MEMORY_METADATA_KEY).catch(() => null);
    if (memAnchor) {
      push(
        {
          id: `fmx:${id}:memory`,
          type: "MemoryAnchor",
          root: memAnchor.documentHash,
          uri: memAnchor.uri,
          evidence: {
            trust: "chain",
            chainId,
            address: getAddress(this.fmx.v3.identity8004),
            method: "eth_call",
            note: `IdentityRegistry8004.getMetadata(${id}, "${MEMORY_METADATA_KEY}") → abi.decode(bytes32 root, string uri). The root commits to the agent's memory index; the values stay private.`,
            bind: [],
          },
        },
        "MemoryAnchor",
      );
    }

    // --- Declared capabilities (never proved by chain state) ---------------
    let card: Record<string, unknown> | null = null;
    if (opts.card !== false) {
      card = await this.fmx
        .gatewayGet<{ card?: Record<string, unknown> }>(`/agents/${id}`)
        .then((a) => a.card ?? null)
        .catch(() => null);
    }
    if (card) {
      push(
        {
          id: `fmx:${id}:capabilities`,
          type: "Capability",
          statedAt: iso(head.timestamp),
          capabilities: (card.capabilities as string[]) ?? [],
          model: card.model ?? null,
          version: card.version ?? null,
          card: `${String(agent.endpoint ?? "")}/.well-known/ferminux-agent.json`,
          evidence: {
            trust: "selfAttested",
            note: "declared by the agent in its card; not proved by chain state. A verifier may test it against the live endpoint.",
          },
        },
        "Capability",
      );
    }

    // --- Assemble ----------------------------------------------------------
    const leaves = claims.map((c) => cvLeaf(c));
    for (let i = 0; i < claims.length; i++) claims[i].leaf = leaves[i];
    const claimsRoot = cvMerkleRoot(leaves);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + (opts.ttlSeconds ?? CV_DEFAULT_TTL_S);
    const ratingCount = Number(agent.ratingCount ?? 0);
    const ratingSum = Number(agent.ratingSum ?? 0);
    const uri = opts.uri ?? `${this.fmx.gatewayUrl}/agents/${id}/cv.json`;
    const identityAddr = this.fmx.v3.identity8004 || net.identity8004 || "";
    const name = String(agent.name ?? `Agent #${id}`);

    const doc: CvDocument = {
      "@context": [...CV_CONTEXT],
      type: [...CV_TYPE],
      id: uri,
      issuer: didPkh(chainId, owner),
      validFrom: iso(issuedAt),
      validUntil: iso(expiresAt),
      name: `${name} — Ferminux AI-CV`,
      description:
        `Verifiable working record of Ferminux agent #${id} (${name}) on chain ${chainId}. Every claim in credentialSubject.record ` +
        `carries the transaction that proves it; verify against any public RPC for chain ${chainId} without contacting Ferminux.`,
      credentialSubject: {
        id: didPkh(chainId, owner),
        type: "AutonomousAgent",
        name,
        agent: {
          chainId,
          caip2: `eip155:${chainId}`,
          agentId: id,
          agentRegistry: registryAddr,
          identityRegistry: identityAddr || undefined,
          // CAIP-19 machine identifier. `erc721` is the CAIP token namespace and
          // the deployed contract's interface name, not branding: the token
          // standard is FRC-721 everywhere in prose.
          caip19: identityAddr ? `eip155:${chainId}/erc721:${getAddress(identityAddr)}/${id}` : undefined,
          controller: didPkh(chainId, owner),
          registeredAt: agent.registeredAt ? iso(agent.registeredAt as bigint) : undefined,
          endpoint: String(agent.endpoint ?? ""),
          status: ["None", "Active", "Paused", "Retired"][Number(agent.status ?? 0)] ?? "None",
          // The identity key is agent.agentId — NOT credentialSubject.id, which is
          // the OWNER's did:pkh and is shared by every agent that owner runs.
          identityKey: "agent.agentId",
        },
        summary: {
          asOfBlock,
          jobsCompleted: Number(agent.jobsCompleted ?? 0),
          jobsFailed: Number(agent.jobsFailed ?? 0),
          ratingCount,
          ratingSum,
          ratingAvg: ratingCount > 0 ? ratingSum / ratingCount : null,
          bondWei: String(agent.bond ?? 0),
          pricePerJobWei: String(agent.pricePerJob ?? 0),
          escrowEarnedWei: escrowEarned.toString(),
          /** NET of the protocol fee, like escrowEarnedWei. "Earned" means one thing in this document. */
          x402EarnedWei: x402Earned.toString(),
          x402EarnedNote: "net of the X402Vault fee — the FMX this agent could withdraw, not the FMX the payer sent",
          x402ReceiptCount: receiptCount,
          x402SpentWei: x402Spent.toString(),
          x402PaymentCount: paymentCount,
          subscriptionPlans: plans,
          disputesLost,
          slashCount: slashLogs.length,
          ...(() => {
            const m = cvMoneyFromClaims(claims);
            return {
              paidJobsCompleted: m.paidJobs,
              zeroValueJobs: m.zeroValueJobs,
              distinctPayers: m.payers.size,
              countersNote:
                m.zeroValueJobs > 0
                  ? `${m.zeroValueJobs} settled job(s) moved 0 FMX. ServiceEscrow mints a full jobsCompleted and a full rating for a job worth nothing, so read paidJobsCompleted and distinctPayers, not the raw counters.`
                  : "jobsCompleted, ratingCount and ratingSum are registry counters: proven on chain and cheap to inflate. Read them next to paidJobsCompleted, distinctPayers and the FMX that actually moved.",
            };
          })(),
          verify: {
            method: "eth_call",
            address: registryAddr,
            call: "getAgent(uint256) → (owner,name,endpoint,metadataURI,pricePerJob,bond,registeredAt,retiredAt,status,jobsCompleted,jobsFailed,ratingCount,ratingSum)",
            args: [id],
            note: "jobsCompleted, jobsFailed, ratingCount, ratingSum and bond are counters kept by AgentRegistry itself. One eth_call proves the headline numbers; no claim in record[] may exceed them. They are proven on chain and cheap to inflate — read them next to what the payments were worth.",
          },
        },
        record: claims,
        recordMeta: {
          count: claims.length,
          complete: omitted.length === 0,
          omitted: omitted.length ? omitted : undefined,
          omittedNote: "A CV or a derived presentation MUST declare what it left out, by type and count, so that selective disclosure is visible rather than silent.",
          full: `${this.fmx.gatewayUrl}/agents/${id}/audit.jsonl`,
          builtBy: "@ferminux/agent fmx.cv.build() — assembled client-side from chain logs, not from a Ferminux index",
        },
      },
      evidence: [
        {
          id: `${this.fmx.gatewayUrl}/agents/${id}/audit.jsonl`,
          type: ["FerminuxChainAnchor"],
          chainId,
          asOfBlock,
          asOfBlockHash,
          asOfBlockTime: iso(head.timestamp),
          contracts: {
            agentRegistry: registryAddr,
            serviceEscrow: escrowAddr,
            x402Vault: this.fmx.v3.x402Vault || undefined,
            streamPay: this.fmx.v3.streamPay || undefined,
            identityRegistry: identityAddr || undefined,
            reputationRegistry: this.fmx.v3.reputation8004 || undefined,
            validationRegistry: this.fmx.v3.validation8004 || undefined,
          },
          rpc: [net.rpc],
        },
      ],
      credentialStatus: identityAddr
        ? {
            id: `${uri}#status`,
            type: "FerminuxRegistryPointer2026",
            chainId,
            identityRegistry: getAddress(identityAddr),
            agentId: id,
            metadataKey: CV_METADATA_KEY,
            statusPurpose: "supersession",
            check: `eth_call IdentityRegistry8004.getMetadata(${id}, "${CV_METADATA_KEY}") → abi.decode(bytes32 documentHash, string uri). Current when documentHash equals proof.eip712.message.documentHash; superseded when it differs; unanchored when empty. The id above is a name, not a dependency — the check needs only an RPC.`,
          }
        : undefined,
      credentialSchema: { id: CV_SCHEMA_URL, type: "JsonSchema" },
    };

    // Stash what sign() needs without putting it inside the signed document.
    Object.defineProperty(doc, "__unsigned", {
      value: { claimsRoot, issuedAt, expiresAt, asOfBlock, asOfBlockHash, uri, owner, agentId: id, registry: registryAddr, identityRegistry: identityAddr },
      enumerable: false,
    });
    return doc;
  }

  /**
   * Signs a CV with the agent owner's key (EIP-712 over the fixed 11-field
   * AgentCV struct). The document is returned with its `proof` attached.
   */
  async sign(doc: CvDocument, opts: { uri?: string } = {}): Promise<CvDocument> {
    const signer = this.fmx.requireSigner();
    const unsigned = (doc as unknown as { __unsigned?: Record<string, unknown> }).__unsigned;
    const subject = doc.credentialSubject;
    const chainId = Number(subject.agent.chainId ?? this.fmx.chainId);
    const agentId = Number(subject.agent.agentId);
    const registry = String(unsigned?.registry ?? subject.agent.agentRegistry);
    const identityRegistry = String(unsigned?.identityRegistry ?? subject.agent.identityRegistry ?? this.fmx.v3.identity8004);
    if (!identityRegistry) throw new Error("Ferminux: IdentityRegistry8004 address is required — it is the EIP-712 verifyingContract");
    const owner = didPkhAddress(subject.id)?.address ?? signer.address;
    if (getAddress(owner) !== getAddress(signer.address)) {
      throw new Error(
        `Ferminux: this CV is for ${owner} but the configured key is ${signer.address} — a CV is self-issued, so only the agent's owner key can sign it`,
      );
    }
    const issuedAt = Number(unsigned?.issuedAt ?? Math.floor(Date.parse(doc.validFrom) / 1000));
    const expiresAt = Number(unsigned?.expiresAt ?? Math.floor(Date.parse(doc.validUntil) / 1000));
    const asOfBlock = Number(unsigned?.asOfBlock ?? subject.summary.asOfBlock ?? 0);
    const asOfBlockHash = String(unsigned?.asOfBlockHash ?? (doc.evidence?.[0]?.asOfBlockHash as string) ?? ZERO32);
    const uri = opts.uri ?? String(unsigned?.uri ?? doc.id ?? "");

    // Recompute both hashes over the document as it stands — never trust a cached value.
    const leaves = subject.record.map((c) => cvLeaf(c));
    const claimsRoot = cvMerkleRoot(leaves);
    for (let i = 0; i < subject.record.length; i++) subject.record[i].leaf = leaves[i];
    const { proof: _p, ...withoutProof } = doc as Record<string, unknown>;
    const documentHash = keccak256(toUtf8Bytes(canonicalJson(withoutProof)));

    const message: AgentCvMessage = {
      chainId,
      registry: getAddress(registry),
      agentId,
      subject: getAddress(signer.address),
      claimsRoot,
      documentHash,
      issuedAt,
      expiresAt,
      asOfBlock,
      asOfBlockHash,
      uri,
    };
    const domain = cvDomain(chainId, identityRegistry);
    const digest = cvDigest(domain, message);
    const proofValue = await signer.signTypedData(domain, AGENT_CV_TYPES, message as unknown as Record<string, unknown>);
    const proof: CvEip712Proof = {
      type: "DataIntegrityProof",
      cryptosuite: CV_CRYPTOSUITE,
      created: new Date(issuedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      proofPurpose: "assertionMethod",
      verificationMethod: `${didPkh(chainId, signer.address)}#blockchainAccountId`,
      eip712: {
        domain: { name: CV_DOMAIN_NAME, version: CV_DOMAIN_VERSION, chainId, verifyingContract: getAddress(identityRegistry) },
        primaryType: CV_PRIMARY_TYPE,
        types: AGENT_CV_TYPES,
        message,
      },
      digest,
      proofValue,
    };
    return { ...(withoutProof as CvDocument), proof };
  }

  /**
   * Anchors a signed CV: `IdentityRegistry8004.setMetadata(agentId, "cv",
   * abi.encode(bytes32 documentHash, string uri))`. Owner-only on chain.
   * Optionally publishes the document to the keccak-addressed payload store
   * first, so the anchored `uri` points at an immutable copy.
   */
  async anchor(doc: CvDocument, opts: { publish?: boolean; uri?: string; key?: string } = {}): Promise<{ tx: string; documentHash: string; uri: string }> {
    this.fmx.requireSigner();
    const proof = asArray(doc.proof)[0];
    if (!proof) throw new Error("Ferminux: sign the CV before anchoring it (fmx.cv.sign)");
    const documentHash = proof.eip712.message.documentHash;
    const computed = cvDocumentHash(doc);
    if (computed.toLowerCase() !== documentHash.toLowerCase()) {
      throw new Error(`Ferminux: the document changed after signing (documentHash ${computed} ≠ signed ${documentHash}) — re-sign before anchoring`);
    }
    let uri = opts.uri ?? proof.eip712.message.uri;
    if (opts.publish !== false) {
      const published = await this.publish(doc).catch(() => null);
      if (published) uri = opts.uri ?? published.uri;
    }
    const agentId = Number(doc.credentialSubject.agent.agentId);
    const value = AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [documentHash, uri]);
    const tx = await this.identity().setMetadata(agentId, opts.key ?? CV_METADATA_KEY, value);
    const receipt = await tx.wait();
    return { tx: receipt.hash, documentHash, uri };
  }

  /** What `getMetadata(agentId, key)` currently points at, or null when never anchored. */
  async anchored(agentId: number | bigint, key = CV_METADATA_KEY): Promise<{ documentHash: string; uri: string } | null> {
    const addr = requireAddress("identity8004", this.fmx.v3.identity8004);
    return readCvAnchor(this.fmx.provider as unknown as CvRpc, addr, Number(agentId), key);
  }

  /** Stores the document in the gateway's keccak-addressed payload store (content-addressed: the gateway cannot alter it without breaking the hash). */
  async publish(doc: CvDocument): Promise<{ hash: string; uri: string; size: number }> {
    const body = toUtf8Bytes(JSON.stringify(doc));
    const res = await fetch(`${this.fmx.gatewayUrl}/payloads`, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) throw new Error(`Ferminux: publishing the CV failed (${res.status})`);
    return (await res.json()) as { hash: string; uri: string; size: number };
  }

  /** The `/a/<slug>` name → agent id, via the gateway's A2A resolver. */
  private async resolveSlug(slug: string): Promise<number> {
    const list = await this.fmx.gatewayGet<{ items: Array<{ id: number; name: string }> }>(`/agents${qs({ q: slug, limit: 50 })}`);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const hit = list.items.find((a) => norm(a.name) === norm(slug));
    if (!hit) throw new Error(`Ferminux: no agent resolves to "${slug}"`);
    return hit.id;
  }
}
