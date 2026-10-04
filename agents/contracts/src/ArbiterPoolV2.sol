// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";
import {ServiceEscrow} from "./ServiceEscrow.sol";

/// @title ArbiterPoolV2 — bonded arbitration for ServiceEscrow disputes (successor of ArbiterPool)
/// @notice Every function, event and error of ArbiterPool is kept with the same signature, so a client
///         of the live pool only needs the new address. What changes:
///         - Eligibility snapshot: an arbiter votes only on cases opened AFTER its bond became active
///           (`activeSince`). Bonds posted once a case is open cannot vote on it.
///         - Minimum voting period: the early close at `quorum + 2` votes waits `minVotingPeriod` after
///           the case opened. ArbiterPool let five bonds vote and close in the block that opened the
///           case, before any honest arbiter could see it.
///         - Void instead of stranding: when the pool can no longer resolve a case's job — the job left
///           Disputed some other way (e.g. `forward` → escrow.resolve), or escrow governance moved away —
///           `close` voids the case: its voters' `pendingVotes` are released, the opener gets the case fee
///           back and the job may get a new case. ArbiterPool reverted there for ever, so those voters
///           could never leave the pool.
///         - Dispute timeout: ServiceEscrow gives a Disputed job no way out but governance. When nobody
///           brings the job to a case within `disputeTimeout` after its review window ends, anyone may
///           call `resolveUnarbitrated`, which refunds the client in full (escrow.resolve(jobId, 10000)).
///           Refund is the conservative default: the client gets back FMX for a delivery it contested
///           and the agent owner did not defend. The escrow records it as a failed job for the agent
///           (its rule: success = clientBps < 5000); an agent owner who disagrees opens a case in time.
///           Done here rather than in a new escrow: AgentRegistry.setEscrow is one-shot, so a second
///           escrow could never record outcomes in the live registry, and every client, gateway and
///           FRC-8004 adapter reads the live escrow. This pool is escrow governance, so no escrow change
///           is needed.
///
/// MIGRATION — replaces the live `arbiterPool` (agents/deployments-v3.3961.json). Nothing here is deployed:
///   1. Deploy `ArbiterPoolV2(escrow, multisig)` against the live `escrow`.
///   2. If `escrow.governance()` is still the multisig, the multisig calls `escrow.setGovernance(v2)`.
///   3. If `escrow.governance()` is the live pool (v1), drain v1 first: v1.close() reverts for good once
///      governance leaves it, and its voters could then never leave (`pendingVotes` stays > 0).
///      a. multisig: `v1.setParams(type(uint256).max, 1, v1.quorum())` — no joins or votes from now on,
///         and every open case becomes closable (in-flight cases are decided on the votes already cast);
///      b. anyone: `v1.close(id)` for every id in 1..v1.nextCaseId() with `!v1.getCase(id).closed`;
///      c. multisig: `v1.forward(escrow, abi.encodeCall(ServiceEscrow.setGovernance, (v2)))`.
///      v1 arbiters then leave (`leavePool` twice, 7-day cooldown — the raised minStake does not block
///      it) and join v2; v1 credits stay withdrawable. A v1 case opened after step (a) can get no votes:
///      its job stays Disputed and v2 takes it.
///      Never resolve a job through `v1.forward(escrow.resolve)` while a v1 case on it is open — v1 has
///      no way to release that case's voters.
///      From the hand-over on, any Disputed job with no open v2 case and a passed `disputeDeadline` —
///      including jobs stuck since before v2 — can be refunded to its client through `resolveUnarbitrated`.
///   4. Point the gateway / SDK / web `arbiterPool` key at v2 and export its ABI then
///      (`forge inspect ArbiterPoolV2 abi --json > abi/ArbiterPoolV2.json`).
///   v2's own successor needs no drain: once governance has moved, each open v2 case voids at its close
///   time and its job, still Disputed, can be brought to the new pool.
/// @dev Paris EVM. Pull payments: bonds, rewards and the case-fee remainder land in `credits`.
///      Design decisions carried over from ArbiterPool:
///      - `leavePool` is two-step: first call starts the 7-day cooldown (and blocks new votes), second
///        call after the cooldown — and only with no pending votes — moves the bond to `credits`.
///      - Median of an even vote count = floor(mean of the two middle votes). Zero votes at window end
///        → result 5000 (even split) and the fee goes to `owner` credits; leftover wei of a split too.
///      - An arbiter may not vote on a case where it is the client or the agent owner.
///      Voided cases keep `closed = true` and `result = 0`; read `voided(caseId)` to tell them apart.
contract ArbiterPoolV2 {
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
    /// @notice Earliest close after a case opens, even with `quorum + 2` votes in.
    uint64 public minVotingPeriod = 1 days;
    /// @notice How long after a disputed job's review window a case can still be opened before
    ///         `resolveUnarbitrated` refunds the client.
    uint64 public disputeTimeout = 7 days;

    mapping(address => uint256) public stake;
    address[] public arbiters;
    mapping(address => uint256) private _arbiterIndex; // 1-based, 0 = not in pool
    mapping(address => uint64) public leaveAt; // 0 = not leaving
    mapping(address => uint256) public pendingVotes; // votes on still-open cases
    mapping(address => uint256) public credits;
    /// @notice When the arbiter's current bond became eligible; it votes only on cases opened later.
    mapping(address => uint64) public activeSince;

    uint256 public nextCaseId; // ids start at 1
    mapping(uint256 => Case) private _cases;
    mapping(uint256 => uint256) public caseOf; // jobId => latest caseId
    /// @notice Closed without a decision because the pool could no longer resolve the job.
    mapping(uint256 => bool) public voided;
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
    event CaseVoided(uint256 indexed caseId, uint256 indexed jobId);
    event Rewarded(uint256 indexed caseId, address indexed arbiter, uint256 amount);
    event ParamsChanged(uint256 minStake, uint64 votingWindow, uint8 quorum);
    event MinVotingPeriodChanged(uint64 minVotingPeriod);
    event DisputeTimedOut(uint256 indexed jobId, address indexed by);
    event DisputeTimeoutChanged(uint64 disputeTimeout);
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
    error JoinedAfterCaseOpened(uint64 activeSince, uint64 openedAt);
    error TooEarly(uint256 availableAt);

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

    /// @notice Bond FMX; the total must reach `minStake`. Cancels a pending leave. A bond that was not
    ///         eligible before this call (new, leaving, or under a raised `minStake`) restarts
    ///         `activeSince`, so it cannot vote on cases that are already open.
    function joinPool() external payable {
        if (msg.value == 0) revert ZeroValue();
        uint256 total = stake[msg.sender] + msg.value;
        if (total < minStake) revert BelowMinStake(total, minStake);
        bool wasEligible = isArbiter(msg.sender);
        stake[msg.sender] = total;
        leaveAt[msg.sender] = 0;
        if (_arbiterIndex[msg.sender] == 0) {
            arbiters.push(msg.sender);
            _arbiterIndex[msg.sender] = arbiters.length;
        }
        if (!wasEligible) activeSince[msg.sender] = uint64(block.timestamp);
        emit ArbiterJoined(msg.sender, total);
    }

    /// @notice First call: start the 7-day cooldown (no more votes). Second call after the cooldown and
    ///         with no pending votes: bond → credits.
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
        activeSince[msg.sender] = 0;
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
    ///         A job whose previous case was voided may be opened again.
    function openCase(uint256 jobId, string calldata evidenceURI) external payable returns (uint256 caseId) {
        if (msg.value != CASE_FEE) revert WrongFee(msg.value, CASE_FEE);
        if (bytes(evidenceURI).length > 256) revert StringTooLong();
        uint256 prev = caseOf[jobId];
        if (prev != 0 && !voided[prev]) revert CaseExists(prev);
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

    /// @notice A bonded arbiter that was eligible before the case opened votes the client's share
    ///         (bps) once per case.
    function vote(uint256 caseId, uint16 clientBps) external {
        Case storage c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase();
        if (c.closed) revert CaseClosedAlready();
        if (clientBps > BPS) revert InvalidBps();
        uint64 closesAt = c.openedAt + votingWindow;
        if (block.timestamp >= closesAt) revert VotingClosed(closesAt);
        if (_arbiterIndex[msg.sender] == 0 || stake[msg.sender] < minStake) revert NotArbiter();
        if (leaveAt[msg.sender] != 0) revert Leaving();
        // strictly earlier: a bond posted in the block that opened the case is already too late
        uint64 since = activeSince[msg.sender];
        if (since >= c.openedAt) revert JoinedAfterCaseOpened(since, c.openedAt);
        if (_votes[caseId][msg.sender].cast) revert AlreadyVoted();
        ServiceEscrow.Job memory j = escrow.getJob(c.jobId);
        // settled elsewhere: a vote here would only pin the arbiter's bond until someone voids the case
        if (j.status != ServiceEscrow.JobStatus.Disputed) revert JobNotDisputed();
        if (msg.sender == j.client || msg.sender == registry.getAgent(j.agentId).owner) revert ConflictOfInterest();

        _votes[caseId][msg.sender] = Vote({clientBps: clientBps, cast: true});
        _voters[caseId].push(msg.sender);
        c.votes += 1;
        pendingVotes[msg.sender] += 1;
        emit Voted(caseId, msg.sender, clientBps);
    }

    /// @notice True when `close` would succeed now: the job already left Disputed (the case voids), or
    ///         the voting window is over, or `quorum + 2` votes are in AND `minVotingPeriod` has passed
    ///         since the case opened.
    function closable(uint256 caseId) external view returns (bool) {
        Case storage c = _cases[caseId];
        if (c.openedAt == 0 || c.closed) return false;
        if (escrow.getJob(c.jobId).status != ServiceEscrow.JobStatus.Disputed) return true;
        return _decidable(c);
    }

    /// @notice Close the case. Normally: once the window is over (or early, see `closable`), resolve the
    ///         escrow job with the median vote and split the case fee among voters within 2000 bps of
    ///         the result. When the pool can no longer resolve the job, the case is voided instead —
    ///         at once if the job already left Disputed, at the normal close time if escrow governance
    ///         is no longer this pool.
    function close(uint256 caseId) external {
        Case storage c = _cases[caseId];
        if (c.openedAt == 0) revert UnknownCase();
        if (c.closed) revert CaseClosedAlready();
        if (escrow.getJob(c.jobId).status != ServiceEscrow.JobStatus.Disputed) {
            _void(caseId, c);
            return;
        }
        if (!_decidable(c)) revert NotClosable();
        // escrow.resolve would revert for as long as governance stays elsewhere
        if (escrow.governance() != address(this)) {
            _void(caseId, c);
            return;
        }

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
        escrow.resolve(c.jobId, result);
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

    // ───────────────────────────── dispute timeout ─────────────────────────────

    /// @notice When `resolveUnarbitrated` becomes available for `jobId`: its review window's end plus
    ///         `disputeTimeout`. The dispute itself fell inside that review window, so a party always
    ///         has at least `disputeTimeout` after it. Reads escrow.reviewWindow live.
    function disputeDeadline(uint256 jobId) public view returns (uint256) {
        return uint256(escrow.getJob(jobId).deliveredAt) + escrow.reviewWindow() + disputeTimeout;
    }

    /// @notice Settle a Disputed job that nobody brought to arbitration in time: full refund to the
    ///         client. Anyone may call once `disputeDeadline(jobId)` has passed and no case on the job is
    ///         open (a voided case does not count).
    function resolveUnarbitrated(uint256 jobId) external {
        uint256 caseId = caseOf[jobId];
        if (caseId != 0 && !voided[caseId]) revert CaseExists(caseId);
        if (escrow.getJob(jobId).status != ServiceEscrow.JobStatus.Disputed) revert JobNotDisputed();
        uint256 at = disputeDeadline(jobId);
        if (block.timestamp < at) revert TooEarly(at);
        emit DisputeTimedOut(jobId, msg.sender);
        escrow.resolve(jobId, BPS);
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

    /// @dev `votingWindow_` may not drop below `minVotingPeriod` (the early close would outlast the window).
    function setParams(uint256 minStake_, uint64 votingWindow_, uint8 quorum_) external onlyOwner {
        if (minStake_ == 0 || votingWindow_ == 0 || quorum_ == 0) revert InvalidParams();
        if (votingWindow_ < minVotingPeriod) revert InvalidParams();
        minStake = minStake_;
        votingWindow = votingWindow_;
        quorum = quorum_;
        emit ParamsChanged(minStake_, votingWindow_, quorum_);
    }

    /// @dev 0 would bring back the same-block close; above `votingWindow` the early close never applies.
    function setMinVotingPeriod(uint64 minVotingPeriod_) external onlyOwner {
        if (minVotingPeriod_ == 0 || minVotingPeriod_ > votingWindow) revert InvalidParams();
        minVotingPeriod = minVotingPeriod_;
        emit MinVotingPeriodChanged(minVotingPeriod_);
    }

    /// @dev Bounded so the owner can neither make the refund instant nor switch it off in practice.
    function setDisputeTimeout(uint64 disputeTimeout_) external onlyOwner {
        if (disputeTimeout_ < 1 days || disputeTimeout_ > 90 days) revert InvalidParams();
        disputeTimeout = disputeTimeout_;
        emit DisputeTimeoutChanged(disputeTimeout_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _decidable(Case storage c) internal view returns (bool) {
        if (block.timestamp >= uint256(c.openedAt) + votingWindow) return true;
        return c.votes >= uint256(quorum) + 2 && block.timestamp >= uint256(c.openedAt) + minVotingPeriod;
    }

    /// @dev No decision: release every voter, return the fee to the opener, let the job be reopened.
    function _void(uint256 caseId, Case storage c) internal {
        address[] storage voters = _voters[caseId];
        for (uint256 i = 0; i < voters.length; i++) {
            pendingVotes[voters[i]] -= 1;
        }
        c.closed = true;
        voided[caseId] = true;
        credits[c.opener] += CASE_FEE;
        emit CaseVoided(caseId, c.jobId);
    }

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
