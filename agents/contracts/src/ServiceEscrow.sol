// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";

/// @title ServiceEscrow — pay-per-job escrow between clients and registered agents
/// @notice A client locks FMX for a job on a registered agent; the agent delivers a
///         result hash + URI; the client releases (with an optional rating) or disputes;
///         governance resolves disputes. All payouts are PULL payments via `credits`
///         and `withdraw()` — the escrow never pushes FMX to agents or clients.
/// @dev Bytecode targets Paris (no PUSH0) — chain 3961 runs geth v1.10.26.
///      Design decisions (not fixed by the spec, documented here):
///      - Payouts go to the agent's CURRENT owner (as of release/claim/resolve), not the owner at request time.
///      - Fee on release/claim = amount * feeBps / 10000; agent gets amount - fee.
///      - resolve(clientBps): clientShare = amount * clientBps / 10000 -> credits[client];
///        agentGross = amount - clientShare; fee = agentGross * feeBps / 10000 -> credits[feeRecipient];
///        agent gets agentGross - fee; recordOutcome(success = clientBps < 5000, rating 0).
///      - inputURI / outputURI are limited to 256 bytes (same limit as registry URIs).
///      - deliver() stays possible after the delivery window as long as the job is still Open
///        (i.e. until the client actually calls refund()).
///      - No selfdestruct / delegatecall. Only withdraw() transfers value and it is nonReentrant.
contract ServiceEscrow {
    // ───────────────────────────── types ─────────────────────────────

    enum JobStatus {
        None,
        Open,
        Delivered,
        Completed,
        Refunded,
        Disputed,
        Resolved
    }

    struct Job {
        uint256 agentId;
        address client;
        uint256 amount; // msg.value at request
        bytes32 inputHash;
        bytes32 outputHash;
        string inputURI;
        string outputURI;
        uint64 createdAt;
        uint64 deliveredAt;
        JobStatus status;
    }

    // ───────────────────────────── storage ─────────────────────────────

    AgentRegistry public registry;
    address public governance;
    address public feeRecipient; // treasury
    uint16 public feeBps = 250; // 2.5 %, governance-settable, max 1000
    uint64 public deliveryWindow = 1 days; // agent must deliver within, else client may refund
    uint64 public reviewWindow = 1 days; // client may release/dispute within, else agent may claim
    mapping(address => uint256) public credits; // PULL payments
    uint256 public nextJobId; // ids start at 1

    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant BPS = 10000;

    mapping(uint256 => Job) private _jobs;

    uint256 private _lock;

    // ───────────────────────────── events ─────────────────────────────

    event JobRequested(
        uint256 indexed jobId,
        uint256 indexed agentId,
        address indexed client,
        uint256 amount,
        bytes32 inputHash,
        string inputURI
    );
    event JobDelivered(uint256 indexed jobId, bytes32 outputHash, string outputURI);
    event JobCompleted(uint256 indexed jobId, uint256 agentPayout, uint256 fee, uint8 rating);
    event JobRefunded(uint256 indexed jobId, uint256 amount, bool byAgent);
    event JobDisputed(uint256 indexed jobId);
    event JobResolved(uint256 indexed jobId, uint256 clientAmount, uint256 agentPayout, uint256 fee);
    event Withdrawn(address indexed to, uint256 amount);
    event FeeChanged(uint16 feeBps);
    event WindowsChanged(uint64 deliveryWindow, uint64 reviewWindow);
    event FeeRecipientChanged(address indexed feeRecipient);
    event GovernanceChanged(address indexed previous, address indexed current);

    // ───────────────────────────── errors ─────────────────────────────

    error NotGovernance();
    error NotClient();
    error NotAgentOwner();
    error ZeroAddress();
    error AgentNotActive(uint256 agentId);
    error CannotHireOwnAgent();
    error InsufficientPayment(uint256 provided, uint256 required);
    error StringTooLong();
    error WrongStatus(JobStatus current);
    error InvalidRating();
    error TooEarly(uint64 availableAt);
    error TooLate(uint64 deadline);
    error InvalidBps();
    error FeeTooHigh();
    error InvalidWindow();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    // ───────────────────────────── modifiers ─────────────────────────────

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    // ───────────────────────────── constructor ─────────────────────────────

    constructor(AgentRegistry registry_, address governance_, address feeRecipient_) {
        if (address(registry_) == address(0) || governance_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        governance = governance_;
        feeRecipient = feeRecipient_;
        emit GovernanceChanged(address(0), governance_);
        emit FeeRecipientChanged(feeRecipient_);
    }

    // ───────────────────────────── job lifecycle ─────────────────────────────

    /// @notice Open a job on `agentId`, locking `msg.value` (>= agent.pricePerJob).
    /// @dev Requires registry.isActive(agentId) and msg.sender != agent owner. inputURI <= 256 bytes.
    function requestJob(uint256 agentId, bytes32 inputHash, string calldata inputURI)
        external
        payable
        returns (uint256 jobId)
    {
        if (!registry.isActive(agentId)) revert AgentNotActive(agentId);
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        if (msg.sender == a.owner) revert CannotHireOwnAgent();
        if (msg.value < a.pricePerJob) revert InsufficientPayment(msg.value, a.pricePerJob);
        if (bytes(inputURI).length > 256) revert StringTooLong();

        jobId = ++nextJobId;
        Job storage j = _jobs[jobId];
        j.agentId = agentId;
        j.client = msg.sender;
        j.amount = msg.value;
        j.inputHash = inputHash;
        j.inputURI = inputURI;
        j.createdAt = uint64(block.timestamp);
        j.status = JobStatus.Open;

        emit JobRequested(jobId, agentId, msg.sender, msg.value, inputHash, inputURI);
    }

    /// @notice Deliver the result. Current agent owner only; job must be Open.
    function deliver(uint256 jobId, bytes32 outputHash, string calldata outputURI) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Open) revert WrongStatus(j.status);
        _requireAgentOwner(j.agentId);
        if (bytes(outputURI).length > 256) revert StringTooLong();

        j.outputHash = outputHash;
        j.outputURI = outputURI;
        j.deliveredAt = uint64(block.timestamp);
        j.status = JobStatus.Delivered;

        emit JobDelivered(jobId, outputHash, outputURI);
    }

    /// @notice Client accepts the delivery. rating 1..5 or 0 (unrated). Pays agent (amount - fee), fee to treasury.
    function release(uint256 jobId, uint8 rating) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Delivered) revert WrongStatus(j.status);
        if (msg.sender != j.client) revert NotClient();
        if (rating > 5) revert InvalidRating();
        _complete(jobId, j, rating);
    }

    /// @notice Agent claims payment after the review window elapsed without release/dispute.
    function claim(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Delivered) revert WrongStatus(j.status);
        _requireAgentOwner(j.agentId);
        uint64 availableAt = j.deliveredAt + reviewWindow;
        if (block.timestamp < availableAt) revert TooEarly(availableAt);
        _complete(jobId, j, 0);
    }

    /// @notice Client reclaims funds when the agent failed to deliver within the delivery window.
    function refund(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Open) revert WrongStatus(j.status);
        if (msg.sender != j.client) revert NotClient();
        uint64 availableAt = j.createdAt + deliveryWindow;
        if (block.timestamp < availableAt) revert TooEarly(availableAt);
        _refund(jobId, j, false);
    }

    /// @notice Agent declines an Open job; client is credited the full amount. Counts as a failed outcome.
    function cancel(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Open) revert WrongStatus(j.status);
        _requireAgentOwner(j.agentId);
        _refund(jobId, j, true);
    }

    /// @notice Client disputes a delivery within the review window. Governance must then resolve().
    function dispute(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Delivered) revert WrongStatus(j.status);
        if (msg.sender != j.client) revert NotClient();
        uint64 deadline = j.deliveredAt + reviewWindow;
        if (block.timestamp >= deadline) revert TooLate(deadline);
        j.status = JobStatus.Disputed;
        emit JobDisputed(jobId);
    }

    /// @notice Governance splits a disputed job: client gets clientBps/10000, agent the rest minus fee on its share.
    /// @dev success = clientBps < 5000 (agent "won" the dispute); rating 0.
    function resolve(uint256 jobId, uint16 clientBps) external onlyGovernance {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Disputed) revert WrongStatus(j.status);
        if (clientBps > BPS) revert InvalidBps();

        uint256 amount = j.amount;
        uint256 clientShare = (amount * clientBps) / BPS;
        uint256 agentGross = amount - clientShare;
        uint256 fee = (agentGross * feeBps) / BPS;
        uint256 agentPayout = agentGross - fee;
        address agentOwner = registry.getAgent(j.agentId).owner;

        j.status = JobStatus.Resolved;
        if (clientShare != 0) credits[j.client] += clientShare;
        if (agentPayout != 0) credits[agentOwner] += agentPayout;
        if (fee != 0) credits[feeRecipient] += fee;

        emit JobResolved(jobId, clientShare, agentPayout, fee);
        registry.recordOutcome(j.agentId, clientBps < 5000, 0);
    }

    /// @notice Pull all accrued credits of msg.sender. The only function that moves FMX out of the escrow.
    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────────── governance ─────────────────────────────

    function setFee(uint16 bps) external onlyGovernance {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeChanged(bps);
    }

    /// @dev Both windows must be non-zero (a zero review window would let agents claim instantly).
    function setWindows(uint64 delivery, uint64 review) external onlyGovernance {
        if (delivery == 0 || review == 0) revert InvalidWindow();
        deliveryWindow = delivery;
        reviewWindow = review;
        emit WindowsChanged(delivery, review);
    }

    function setFeeRecipient(address recipient) external onlyGovernance {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientChanged(recipient);
    }

    function setGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceChanged(governance, newGovernance);
        governance = newGovernance;
    }

    // ───────────────────────────── views ─────────────────────────────

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _requireAgentOwner(uint256 agentId) internal view {
        if (registry.getAgent(agentId).owner != msg.sender) revert NotAgentOwner();
    }

    /// @dev Shared by release() and claim(). Effects first, then the trusted registry call.
    function _complete(uint256 jobId, Job storage j, uint8 rating) internal {
        uint256 amount = j.amount;
        uint256 fee = (amount * feeBps) / BPS;
        uint256 agentPayout = amount - fee;
        address agentOwner = registry.getAgent(j.agentId).owner;

        j.status = JobStatus.Completed;
        credits[agentOwner] += agentPayout;
        if (fee != 0) credits[feeRecipient] += fee;

        emit JobCompleted(jobId, agentPayout, fee, rating);
        registry.recordOutcome(j.agentId, true, rating);
    }

    /// @dev Shared by refund() and cancel().
    function _refund(uint256 jobId, Job storage j, bool byAgent) internal {
        uint256 amount = j.amount;
        j.status = JobStatus.Refunded;
        credits[j.client] += amount;
        emit JobRefunded(jobId, amount, byAgent);
        registry.recordOutcome(j.agentId, false, 0);
    }
}
