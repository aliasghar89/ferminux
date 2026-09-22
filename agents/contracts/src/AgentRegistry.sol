// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentRegistry — on-chain directory of AI agents on Ferminux Network
/// @notice Agents register with a bond in FMX, publish a service endpoint and a price
///         per job, and accumulate an outcome/rating history recorded by the escrow.
/// @dev Bytecode targets Paris (no PUSH0) — chain 3961 runs geth v1.10.26.
///      Money safety: bond withdrawal zeroes the bond before pushing value and is
///      nonReentrant; slash pushes to `to` after state update and is nonReentrant.
///      No selfdestruct / delegatecall.
contract AgentRegistry {
    // ───────────────────────────── types ─────────────────────────────

    enum Status {
        None,
        Active,
        Paused,
        Retired
    }

    struct Agent {
        address owner;
        string name;
        string endpoint;
        string metadataURI;
        uint256 pricePerJob; // wei of FMX, minimum payment for one job
        uint256 bond; // FMX held as bond
        uint64 registeredAt;
        uint64 retiredAt;
        Status status;
        uint32 jobsCompleted;
        uint32 jobsFailed;
        uint32 ratingCount;
        uint32 ratingSum; // rating 1..5
    }

    // ───────────────────────────── storage ─────────────────────────────

    uint256 public minBond; // governance-settable
    uint64 public constant BOND_COOLDOWN = 7 days;
    address public governance; // multisig
    address public escrow; // set once by governance
    uint256 public nextId; // ids start at 1

    mapping(uint256 => Agent) private _agents;

    uint256 private _lock; // 0 = unlocked, 1 = locked

    // ───────────────────────────── events ─────────────────────────────

    event AgentRegistered(
        uint256 indexed id,
        address indexed owner,
        string name,
        string endpoint,
        string metadataURI,
        uint256 pricePerJob,
        uint256 bond
    );
    event AgentUpdated(uint256 indexed id, string endpoint, string metadataURI, uint256 pricePerJob);
    event AgentStatusChanged(uint256 indexed id, Status status);
    event BondChanged(uint256 indexed id, uint256 bond);
    event AgentSlashed(uint256 indexed id, uint256 amount, address to, string reason);
    event OutcomeRecorded(uint256 indexed id, bool success, uint8 rating);
    event OwnershipTransferred(uint256 indexed id, address indexed from, address indexed to);
    event GovernanceChanged(address indexed previous, address indexed current);
    event EscrowSet(address indexed escrow);
    event MinBondChanged(uint256 minBond);

    // ───────────────────────────── errors ─────────────────────────────

    error NotGovernance();
    error NotEscrow();
    error NotOwner();
    error ZeroAddress();
    error EscrowAlreadySet();
    error InsufficientBond(uint256 provided, uint256 required);
    error InvalidName();
    error StringTooLong();
    error InvalidStatusTransition();
    error NotRetired();
    error CooldownActive(uint64 availableAt);
    error NothingToWithdraw();
    error ZeroValue();
    error InvalidRating();
    error SlashExceedsBond(uint256 requested, uint256 bond);
    error TransferFailed();
    error Reentrancy();
    error UnknownAgent();

    // ───────────────────────────── modifiers ─────────────────────────────

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow || escrow == address(0)) revert NotEscrow();
        _;
    }

    modifier onlyAgentOwner(uint256 id) {
        Agent storage a = _agents[id];
        if (a.status == Status.None) revert UnknownAgent();
        if (a.owner != msg.sender) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    // ───────────────────────────── constructor ─────────────────────────────

    /// @param governance_ initial governance (deploy script sets the multisig last)
    /// @param minBond_ minimum bond in wei required at registration and for `isActive`
    constructor(address governance_, uint256 minBond_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
        minBond = minBond_;
        emit GovernanceChanged(address(0), governance_);
        emit MinBondChanged(minBond_);
    }

    // ───────────────────────────── agent lifecycle ─────────────────────────────

    /// @notice Register a new agent. `msg.value` becomes the bond and must be >= `minBond`.
    /// @dev name 1..64 bytes, endpoint <= 256 bytes, metadataURI <= 256 bytes.
    function register(string calldata name, string calldata endpoint, string calldata metadataURI, uint256 pricePerJob)
        external
        payable
        returns (uint256 id)
    {
        if (msg.value < minBond) revert InsufficientBond(msg.value, minBond);
        uint256 nameLen = bytes(name).length;
        if (nameLen == 0 || nameLen > 64) revert InvalidName();
        if (bytes(endpoint).length > 256 || bytes(metadataURI).length > 256) revert StringTooLong();

        id = ++nextId;
        Agent storage a = _agents[id];
        a.owner = msg.sender;
        a.name = name;
        a.endpoint = endpoint;
        a.metadataURI = metadataURI;
        a.pricePerJob = pricePerJob;
        a.bond = msg.value;
        a.registeredAt = uint64(block.timestamp);
        a.status = Status.Active;

        emit AgentRegistered(id, msg.sender, name, endpoint, metadataURI, pricePerJob, msg.value);
        emit AgentStatusChanged(id, Status.Active);
        emit BondChanged(id, msg.value);
    }

    /// @notice Update endpoint / metadata / price. Owner only. Allowed in any non-None status.
    function update(uint256 id, string calldata endpoint, string calldata metadataURI, uint256 pricePerJob)
        external
        onlyAgentOwner(id)
    {
        if (bytes(endpoint).length > 256 || bytes(metadataURI).length > 256) revert StringTooLong();
        Agent storage a = _agents[id];
        a.endpoint = endpoint;
        a.metadataURI = metadataURI;
        a.pricePerJob = pricePerJob;
        emit AgentUpdated(id, endpoint, metadataURI, pricePerJob);
    }

    /// @notice Toggle Active <-> Paused. Owner only. Any other target/source status reverts.
    function setStatus(uint256 id, Status s) external onlyAgentOwner(id) {
        Agent storage a = _agents[id];
        bool ok = (a.status == Status.Active && s == Status.Paused) || (a.status == Status.Paused && s == Status.Active);
        if (!ok) revert InvalidStatusTransition();
        a.status = s;
        emit AgentStatusChanged(id, s);
    }

    /// @notice Retire the agent (Active|Paused -> Retired) and start the bond cooldown. Irreversible.
    function retire(uint256 id) external onlyAgentOwner(id) {
        Agent storage a = _agents[id];
        if (a.status != Status.Active && a.status != Status.Paused) revert InvalidStatusTransition();
        a.status = Status.Retired;
        a.retiredAt = uint64(block.timestamp);
        emit AgentStatusChanged(id, Status.Retired);
    }

    /// @notice Withdraw the full bond after the cooldown. Owner only; Retired && now >= retiredAt + BOND_COOLDOWN.
    /// @dev Bond is zeroed BEFORE the value transfer (checks-effects-interactions) and the call is nonReentrant.
    function withdrawBond(uint256 id) external onlyAgentOwner(id) nonReentrant {
        Agent storage a = _agents[id];
        if (a.status != Status.Retired) revert NotRetired();
        uint64 availableAt = a.retiredAt + BOND_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);
        uint256 amount = a.bond;
        if (amount == 0) revert NothingToWithdraw();
        a.bond = 0;
        emit BondChanged(id, 0);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Add FMX to the bond. Anyone may top up any existing agent (e.g. re-activate an under-bonded one).
    function topUpBond(uint256 id) external payable {
        Agent storage a = _agents[id];
        if (a.status == Status.None) revert UnknownAgent();
        if (msg.value == 0) revert ZeroValue();
        a.bond += msg.value;
        emit BondChanged(id, a.bond);
    }

    /// @notice Transfer the agent record (and its bond) to a new owner.
    function transferOwnership(uint256 id, address newOwner) external onlyAgentOwner(id) {
        if (newOwner == address(0)) revert ZeroAddress();
        _agents[id].owner = newOwner;
        emit OwnershipTransferred(id, msg.sender, newOwner);
    }

    // ───────────────────────────── governance ─────────────────────────────

    /// @notice Slash `amount` of the agent's bond to `to`. Governance only.
    /// @dev Bond reduced before the transfer; nonReentrant. Slashing does not change status —
    ///      an under-bonded agent simply stops being `isActive` until it tops up.
    function slash(uint256 id, uint256 amount, address to, string calldata reason)
        external
        onlyGovernance
        nonReentrant
    {
        Agent storage a = _agents[id];
        if (a.status == Status.None) revert UnknownAgent();
        if (to == address(0)) revert ZeroAddress();
        if (amount > a.bond) revert SlashExceedsBond(amount, a.bond);
        a.bond -= amount;
        emit AgentSlashed(id, amount, to, reason);
        emit BondChanged(id, a.bond);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function setMinBond(uint256 newMinBond) external onlyGovernance {
        minBond = newMinBond;
        emit MinBondChanged(newMinBond);
    }

    /// @notice Set the escrow once. Governance only.
    function setEscrow(address escrow_) external onlyGovernance {
        if (escrow_ == address(0)) revert ZeroAddress();
        if (escrow != address(0)) revert EscrowAlreadySet();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    function setGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceChanged(governance, newGovernance);
        governance = newGovernance;
    }

    // ───────────────────────────── escrow hook ─────────────────────────────

    /// @notice Record a job outcome. Escrow only. rating 0 = unrated, 1..5 adds to the rating sum/count.
    function recordOutcome(uint256 id, bool success, uint8 rating) external onlyEscrow {
        Agent storage a = _agents[id];
        if (a.status == Status.None) revert UnknownAgent();
        if (rating > 5) revert InvalidRating();
        if (success) {
            a.jobsCompleted += 1;
        } else {
            a.jobsFailed += 1;
        }
        if (rating != 0) {
            a.ratingCount += 1;
            a.ratingSum += rating;
        }
        emit OutcomeRecorded(id, success, rating);
    }

    // ───────────────────────────── views ─────────────────────────────

    function getAgent(uint256 id) external view returns (Agent memory) {
        return _agents[id];
    }

    /// @notice True when the agent is Active AND its bond is at or above the current `minBond`.
    /// @dev A raise of `minBond` by governance or a slash can make an agent inactive until it tops up.
    function isActive(uint256 id) external view returns (bool) {
        Agent storage a = _agents[id];
        return a.status == Status.Active && a.bond >= minBond;
    }
}
