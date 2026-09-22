// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";
import {ServiceEscrow} from "./ServiceEscrow.sol";

/// @title ArbiterPool — staked arbitration for ServiceEscrow disputes (Addendum v3, C4)
/// @notice ServiceEscrow governance is handed to this contract (multisig tx). Staked arbiters vote a
///         client share (bps) on disputed jobs; `close` resolves the job through `escrow.resolve` with
///         the median vote and splits the case fee among the voters within 2000 bps of the result.
///         `owner` (multisig) keeps escrow admin reachable through `forward`.
/// @dev Paris EVM. Pull payments: stakes, rewards and the case-fee remainder land in `credits`.
///      Design decisions beyond the spec:
///      - `leavePool` is two-step: first call starts the 7-day cooldown (and blocks new votes), second
///        call after the cooldown — and only with no pending votes — moves the stake to `credits`.
///      - Median of an even vote count = floor(mean of the two middle votes). Zero votes at window end
///        → result 5000 (even split) and the fee goes to `owner` credits; leftover wei of a split too.
///      - An arbiter may not vote on a case where it is the client or the agent owner.
///      - `close` reverts (whole tx) while escrow.governance != this — cases stay open until then.
contract ArbiterPool {
    // ───────────────────────────── types ─────────────────────────────

    struct Case {
        uint256 jobId;
        address opener;
        string evidenceURI;
        uint64 openedAt;
        uint16 result;
        uint8 votes;
        bool closed;
    }

    struct Vote {
        uint16 clientBps;
        bool cast;
    }

    // ───────────────────────────── constants ─────────────────────────────

    uint256 public constant CASE_FEE = 1 ether;
    uint64 public constant LEAVE_COOLDOWN = 7 days;
    uint16 public constant REWARD_BAND_BPS = 2000;
    uint16 public constant BPS = 10000;

    // ───────────────────────────── storage ─────────────────────────────

    ServiceEscrow public immutable escrow;
    AgentRegistry public immutable registry;
    address public owner;

    uint256 public minStake = 500 ether;
    uint64 public votingWindow = 3 days;
    uint8 public quorum = 3;

    mapping(address => uint256) public stake;
    address[] public arbiters;
    mapping(address => uint256) private _arbiterIndex; // 1-based, 0 = not in pool
    mapping(address => uint64) public leaveAt; // 0 = not leaving
    mapping(address => uint256) public pendingVotes; // votes on still-open cases
    mapping(address => uint256) public credits;

    uint256 public nextCaseId; // ids start at 1
    mapping(uint256 => Case) private _cases;
    mapping(uint256 => uint256) public caseOf; // jobId => caseId
    mapping(uint256 => address[]) private _voters;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    mapping(uint256 => string[]) private _evidence;

    uint256 private _lock;

    // ───────────────────────────── events ─────────────────────────────

    event ArbiterJoined(address indexed arbiter, uint256 stake);
    event ArbiterLeaving(address indexed arbiter, uint64 at);
    event ArbiterLeft(address indexed arbiter, uint256 stake);
    event CaseOpened(uint256 indexed caseId, uint256 indexed jobId, address indexed opener, string evidenceURI);
    event EvidenceSubmitted(uint256 indexed caseId, address indexed by, string uri);
    event Voted(uint256 indexed caseId, address indexed arbiter, uint16 clientBps);
    event CaseClosed(uint256 indexed caseId, uint256 indexed jobId, uint16 clientBps);
    event Rewarded(uint256 indexed caseId, address indexed arbiter, uint256 amount);
    event ParamsChanged(uint256 minStake, uint64 votingWindow, uint8 quorum);
    event OwnershipTransferred(address indexed previous, address indexed current);
    event Withdrawn(address indexed to, uint256 amount);

    // ───────────────────────────── errors ─────────────────────────────

    error NotOwner();
    error ZeroAddress();
    error ZeroValue();
    error BelowMinStake(uint256 total, uint256 required);
    error NotArbiter();
    error Leaving();
    error CooldownActive(uint64 availableAt);
    error VotesPending(uint256 count);
    error WrongFee(uint256 provided, uint256 required);
    error JobNotDisputed();
    error NotParty();
    error CaseExists(uint256 caseId);
    error UnknownCase();
    error CaseClosedAlready();
    error AlreadyVoted();
    error ConflictOfInterest();
    error InvalidBps();
    error VotingClosed(uint64 closedAt);
    error NotClosable();
    error InvalidParams();
    error StringTooLong();
    error ForwardFailed();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    // ───────────────────────────── modifiers ─────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    // ───────────────────────────── constructor ─────────────────────────────

    constructor(ServiceEscrow escrow_, address owner_) {
        if (address(escrow_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        registry = escrow_.registry();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ───────────────────────────── pool ─────────────────────────────

    /// @notice Stake FMX; total stake must reach `minStake`. Cancels a pending leave.
    function joinPool() external payable {
        if (msg.value == 0) revert ZeroValue();
        uint256 total = stake[msg.sender] + msg.value;
        if (total < minStake) revert BelowMinStake(total, minStake);
        stake[msg.sender] = total;
        leaveAt[msg.sender] = 0;
        if (_arbiterIndex[msg.sender] == 0) {
            arbiters.push(msg.sender);
            _arbiterIndex[msg.sender] = arbiters.length;
        }
        emit ArbiterJoined(msg.sender, total);
    }

    /// @notice First call: start the 7-day cooldown (no more votes). Second call after the cooldown and
    ///         with no pending votes: stake → credits.
    function leavePool() external {
        if (_arbiterIndex[msg.sender] == 0) revert NotArbiter();
        uint64 at = leaveAt[msg.sender];
        if (at == 0) {
            at = uint64(block.timestamp) + LEAVE_COOLDOWN;
            leaveAt[msg.sender] = at;
            emit ArbiterLeaving(msg.sender, at);
            return;
        }
        if (block.timestamp < at) revert CooldownActive(at);
        if (pendingVotes[msg.sender] != 0) revert VotesPending(pendingVotes[msg.sender]);
        uint256 amount = stake[msg.sender];
        stake[msg.sender] = 0;
        leaveAt[msg.sender] = 0;
        _removeArbiter(msg.sender);
        credits[msg.sender] += amount;
        emit ArbiterLeft(msg.sender, amount);
    }

    function arbiterCount() external view returns (uint256) {
        return arbiters.length;
    }

    function isArbiter(address a) public view returns (bool) {
        return _arbiterIndex[a] != 0 && stake[a] >= minStake && leaveAt[a] == 0;
    }

    // ───────────────────────────── cases ─────────────────────────────

    /// @notice Open a case on a Disputed job. Client or agent owner; fee = 1 FMX (msg.value) → rewards.
    function openCase(uint256 jobId, string calldata evidenceURI) external payable returns (uint256 caseId) {
        if (msg.value != CASE_FEE) revert WrongFee(msg.value, CASE_FEE);
        if (bytes(evidenceURI).length > 256) revert StringTooLong();
        if (caseOf[jobId] != 0) revert CaseExists(caseOf[jobId]);
        ServiceEscrow.Job memory j = escrow.getJob(jobId);
        if (j.status != ServiceEscrow.JobStatus.Disputed) revert JobNotDisputed();
        _requireParty(j, msg.sender);

        caseId = ++nextCaseId;
        Case storage c = _cases[caseId];
        c.jobId = jobId;
        c.opener = msg.sender;
        c.evidenceURI = evidenceURI;
        c.openedAt = uint64(block.timestamp);
        caseOf[jobId] = caseId;
        if (bytes(evidenceURI).length != 0) _evidence[caseId].push(evidenceURI);
        emit CaseOpened(caseId, jobId, msg.sender, evidenceURI);
    }

    function submitEvidence(uint256 caseId, string calldata uri) external {
        Case storage c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase();
        if (c.closed) revert CaseClosedAlready();
        if (bytes(uri).length > 256) revert StringTooLong();
        _requireParty(escrow.getJob(c.jobId), msg.sender);
        _evidence[caseId].push(uri);
        emit EvidenceSubmitted(caseId, msg.sender, uri);
    }

    /// @notice Staked arbiter votes the client's share (bps) once per case.
    function vote(uint256 caseId, uint16 clientBps) external {
        Case storage c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase();
        if (c.closed) revert CaseClosedAlready();
        if (clientBps > BPS) revert InvalidBps();
        uint64 closesAt = c.openedAt + votingWindow;
        if (block.timestamp >= closesAt) revert VotingClosed(closesAt);
        if (_arbiterIndex[msg.sender] == 0 || stake[msg.sender] < minStake) revert NotArbiter();
        if (leaveAt[msg.sender] != 0) revert Leaving();
        if (_votes[caseId][msg.sender].cast) revert AlreadyVoted();
        ServiceEscrow.Job memory j = escrow.getJob(c.jobId);
        if (msg.sender == j.client || msg.sender == registry.getAgent(j.agentId).owner) revert ConflictOfInterest();

        _votes[caseId][msg.sender] = Vote({clientBps: clientBps, cast: true});
        _voters[caseId].push(msg.sender);
        c.votes += 1;
        pendingVotes[msg.sender] += 1;
        emit Voted(caseId, msg.sender, clientBps);
    }

    /// @notice Close once the window elapsed or votes >= quorum + 2. Resolves the escrow job with the
    ///         median vote and splits the case fee among voters within 2000 bps of the result.
    function close(uint256 caseId) external {
        Case storage c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase();
        if (c.closed) revert CaseClosedAlready();
        bool windowOver = block.timestamp >= c.openedAt + votingWindow;
        if (!windowOver && c.votes < uint256(quorum) + 2) revert NotClosable();

        address[] storage voters = _voters[caseId];
        uint256 n = voters.length;
        uint16 result = n == 0 ? 5000 : _median(caseId, voters);
        c.closed = true;
        c.result = result;

        // rewards: equal split among voters within the band
        uint256 eligible;
        for (uint256 i = 0; i < n; i++) {
            pendingVotes[voters[i]] -= 1;
            if (_withinBand(_votes[caseId][voters[i]].clientBps, result)) eligible++;
        }
        uint256 distributed;
        if (eligible != 0) {
            uint256 share = CASE_FEE / eligible;
            for (uint256 i = 0; i < n; i++) {
                if (_withinBand(_votes[caseId][voters[i]].clientBps, result)) {
                    credits[voters[i]] += share;
                    distributed += share;
                    emit Rewarded(caseId, voters[i], share);
                }
            }
        }
        if (CASE_FEE - distributed != 0) credits[owner] += CASE_FEE - distributed;

        emit CaseClosed(caseId, c.jobId, result);
        escrow.resolve(c.jobId, result); // reverts unless escrow.governance == this
    }

    function getCase(uint256 caseId) external view returns (Case memory) {
        return _cases[caseId];
    }

    function getVote(uint256 caseId, address arbiter) external view returns (bool cast, uint16 clientBps) {
        Vote storage v = _votes[caseId][arbiter];
        return (v.cast, v.clientBps);
    }

    function getVoters(uint256 caseId) external view returns (address[] memory) {
        return _voters[caseId];
    }

    function getEvidence(uint256 caseId) external view returns (string[] memory) {
        return _evidence[caseId];
    }

    // ───────────────────────────── withdraw ─────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────────── owner ─────────────────────────────

    /// @notice Relay an admin call (e.g. escrow.setFee / setWindows / setFeeRecipient / setGovernance).
    function forward(address target, bytes calldata data) external onlyOwner returns (bytes memory ret) {
        if (target == address(0)) revert ZeroAddress();
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            if (ret.length == 0) revert ForwardFailed();
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function setParams(uint256 minStake_, uint64 votingWindow_, uint8 quorum_) external onlyOwner {
        if (minStake_ == 0 || votingWindow_ == 0 || quorum_ == 0) revert InvalidParams();
        minStake = minStake_;
        votingWindow = votingWindow_;
        quorum = quorum_;
        emit ParamsChanged(minStake_, votingWindow_, quorum_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _requireParty(ServiceEscrow.Job memory j, address who) internal view {
        if (who != j.client && who != registry.getAgent(j.agentId).owner) revert NotParty();
    }

    function _withinBand(uint16 v, uint16 result) internal pure returns (bool) {
        uint16 diff = v > result ? v - result : result - v;
        return diff <= REWARD_BAND_BPS;
    }

    /// @dev Insertion-sort the (small) vote list; odd n → middle, even n → floor(mean of the two middles).
    function _median(uint256 caseId, address[] storage voters) internal view returns (uint16) {
        uint256 n = voters.length;
        uint16[] memory v = new uint16[](n);
        for (uint256 i = 0; i < n; i++) {
            uint16 x = _votes[caseId][voters[i]].clientBps;
            uint256 j = i;
            while (j > 0 && v[j - 1] > x) {
                v[j] = v[j - 1];
                j--;
            }
            v[j] = x;
        }
        if (n % 2 == 1) return v[n / 2];
        return uint16((uint256(v[n / 2 - 1]) + uint256(v[n / 2])) / 2);
    }

    function _removeArbiter(address a) internal {
        uint256 idx = _arbiterIndex[a];
        uint256 last = arbiters.length;
        if (idx != last) {
            address moved = arbiters[last - 1];
            arbiters[idx - 1] = moved;
            _arbiterIndex[moved] = idx;
        }
        arbiters.pop();
        _arbiterIndex[a] = 0;
    }
}
