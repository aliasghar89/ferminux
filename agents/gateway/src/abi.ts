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
