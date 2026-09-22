// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StreamPay — per-second FMX streams + period subscriptions (Addendum v3, C3)
/// @notice Streams: payer deposits FMX that accrues to the payee at `ratePerSec`; payee claims accrued
///         value into `credits`; either party may cancel (accrued → payee, remainder → payer).
///         Subscriptions: a payee publishes a Plan (price per period); a payer prepays N periods; each
///         period's price becomes claimable by the payee when that period STARTS; the payer may cancel
///         and get every period that has not started refunded. All payouts are PULL (`credits`+`withdraw`).
/// @dev Paris EVM. Fee `feeBps` is charged on every payee credit (stream claim/cancel, sub claim).
///      Design decisions beyond the spec:
///      - `stop = start + deposit / ratePerSec` (floor); the rounding dust stays with the payer on cancel.
///      - `topUp` only while the stream is running (now < stop) — extending a stream that already ran
///        dry would pay the payee for the idle gap.
///      - Sub accounting is derived from the spec struct alone: unclaimed periods = prepaid / price,
///        accrualStart = paidThrough - unclaimed*period; `renew` first settles due periods.
///      - Only `withdraw()` moves FMX out; nonReentrant, zero-before-call.
contract StreamPay {
    // ───────────────────────────── types ─────────────────────────────

    struct Stream {
        address payer;
        address payee;
        uint256 ratePerSec;
        uint256 deposit;
        uint256 withdrawn;
        uint64 start;
        uint64 stop; // start + deposit / ratePerSec
        bool cancelled;
    }

    struct Plan {
        address payee;
        uint256 pricePerPeriod;
        uint64 period;
        bool active;
        string metadataURI;
    }

    struct Sub {
        uint256 planId;
        address payer;
        uint64 paidThrough;
        bool cancelled;
        uint256 prepaid; // FMX not yet claimed by the payee (= unclaimed periods * price)
    }

    // ───────────────────────────── storage ─────────────────────────────

    mapping(address => uint256) public credits;
    uint16 public feeBps = 100;
    address public feeRecipient;
    address public governance;
    uint256 public nextStreamId; // ids start at 1
    uint256 public nextPlanId;
    uint256 public nextSubId;
    mapping(uint256 => mapping(address => uint256)) public subOf; // planId => payer => latest subId

    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant BPS = 10000;

    mapping(uint256 => Stream) private _streams;
    mapping(uint256 => Plan) private _plans;
    mapping(uint256 => Sub) private _subs;
    uint256 private _lock;

    // ───────────────────────────── events ─────────────────────────────

    event StreamOpened(uint256 indexed id, address indexed payer, address indexed payee, uint256 ratePerSec, uint256 deposit, uint64 start, uint64 stop);
    event StreamToppedUp(uint256 indexed id, uint256 amount, uint256 deposit, uint64 stop);
    event StreamClaimed(uint256 indexed id, uint256 payeeAmount, uint256 fee);
    event StreamCancelled(uint256 indexed id, address indexed by, uint256 payeeAmount, uint256 fee, uint256 refund);
    event PlanCreated(uint256 indexed planId, address indexed payee, uint256 pricePerPeriod, uint64 period, string metadataURI);
    event PlanActiveSet(uint256 indexed planId, bool active);
    event Subscribed(uint256 indexed subId, uint256 indexed planId, address indexed payer, uint32 periods, uint64 paidThrough);
    event SubRenewed(uint256 indexed subId, uint32 periods, uint64 paidThrough);
    event SubCancelled(uint256 indexed subId, uint256 refund);
    event SubClaimed(uint256 indexed subId, uint256 periods, uint256 payeeAmount, uint256 fee);
    event Withdrawn(address indexed to, uint256 amount);
    event FeeChanged(uint16 feeBps);
    event FeeRecipientChanged(address indexed feeRecipient);
    event GovernanceChanged(address indexed previous, address indexed current);

    // ───────────────────────────── errors ─────────────────────────────

    error NotGovernance();
    error ZeroAddress();
    error ZeroValue();
    error ZeroRate();
    error InsufficientDeposit(uint256 provided, uint256 required);
    error SelfPayment();
    error UnknownStream();
    error UnknownPlan();
    error UnknownSub();
    error NotPayer();
    error NotPayee();
    error NotParty();
    error StreamEnded();
    error StreamAlreadyCancelled();
    error NothingToClaim();
    error PlanInactive();
    error ZeroPeriods();
    error WrongPayment(uint256 provided, uint256 required);
    error AlreadySubscribed(uint256 subId);
    error SubAlreadyCancelled();
    error StringTooLong();
    error FeeTooHigh();
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

    constructor(address governance_, address feeRecipient_) {
        if (governance_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        governance = governance_;
        feeRecipient = feeRecipient_;
        emit GovernanceChanged(address(0), governance_);
        emit FeeRecipientChanged(feeRecipient_);
    }

    // ───────────────────────────── streams ─────────────────────────────

    /// @notice Open a stream to `payee`; `msg.value` is the deposit, must cover at least one second.
    function openStream(address payee, uint256 ratePerSec) external payable returns (uint256 id) {
        if (payee == address(0)) revert ZeroAddress();
        if (payee == msg.sender) revert SelfPayment();
        if (ratePerSec == 0) revert ZeroRate();
        if (msg.value < ratePerSec) revert InsufficientDeposit(msg.value, ratePerSec);

        id = ++nextStreamId;
        Stream storage s = _streams[id];
        s.payer = msg.sender;
        s.payee = payee;
        s.ratePerSec = ratePerSec;
        s.deposit = msg.value;
        s.start = uint64(block.timestamp);
        s.stop = uint64(block.timestamp + msg.value / ratePerSec);
        emit StreamOpened(id, msg.sender, payee, ratePerSec, msg.value, s.start, s.stop);
    }

    /// @notice Add deposit to a running stream (anyone may top up; remainder always returns to the payer).
    function topUp(uint256 id) external payable {
        Stream storage s = _streams[id];
        if (s.payer == address(0)) revert UnknownStream();
        if (s.cancelled) revert StreamAlreadyCancelled();
        if (block.timestamp >= s.stop) revert StreamEnded();
        if (msg.value == 0) revert ZeroValue();
        s.deposit += msg.value;
        s.stop = uint64(uint256(s.start) + s.deposit / s.ratePerSec);
        emit StreamToppedUp(id, msg.value, s.deposit, s.stop);
    }

    /// @notice Accrued-but-unclaimed value for the payee.
    function claimable(uint256 id) public view returns (uint256) {
        Stream storage s = _streams[id];
        if (s.cancelled) return 0;
        return _accrued(s) - s.withdrawn;
    }

    /// @notice Payee pulls the accrued value into `credits` (minus fee).
    function claimStream(uint256 id) external {
        Stream storage s = _streams[id];
        if (s.payer == address(0)) revert UnknownStream();
        if (msg.sender != s.payee) revert NotPayee();
        if (s.cancelled) revert StreamAlreadyCancelled();
        uint256 amount = _accrued(s) - s.withdrawn;
        if (amount == 0) revert NothingToClaim();
        s.withdrawn += amount;
        (uint256 net, uint256 fee) = _creditPayee(s.payee, amount);
        emit StreamClaimed(id, net, fee);
    }

    /// @notice Payer or payee closes the stream: accrued → payee credits, remainder → payer credits.
    function cancelStream(uint256 id) external {
        Stream storage s = _streams[id];
        if (s.payer == address(0)) revert UnknownStream();
        if (msg.sender != s.payer && msg.sender != s.payee) revert NotParty();
        if (s.cancelled) revert StreamAlreadyCancelled();
        uint256 accrued = _accrued(s);
        uint256 payeeAmount = accrued - s.withdrawn;
        uint256 refund = s.deposit - accrued;
        s.cancelled = true;
        s.withdrawn = accrued;
        (uint256 net, uint256 fee) = _creditPayee(s.payee, payeeAmount);
        if (refund != 0) credits[s.payer] += refund;
        emit StreamCancelled(id, msg.sender, net, fee, refund);
    }

    function getStream(uint256 id) external view returns (Stream memory) {
        return _streams[id];
    }

    // ───────────────────────────── plans ─────────────────────────────

    function createPlan(uint256 pricePerPeriod, uint64 period, string calldata metadataURI)
        external
        returns (uint256 planId)
    {
        if (pricePerPeriod == 0) revert ZeroValue();
        if (period == 0) revert ZeroRate();
        if (bytes(metadataURI).length > 256) revert StringTooLong();
        planId = ++nextPlanId;
        Plan storage p = _plans[planId];
        p.payee = msg.sender;
        p.pricePerPeriod = pricePerPeriod;
        p.period = period;
        p.active = true;
        p.metadataURI = metadataURI;
        emit PlanCreated(planId, msg.sender, pricePerPeriod, period, metadataURI);
    }

    function setPlanActive(uint256 planId, bool active) external {
        Plan storage p = _plans[planId];
        if (p.payee == address(0)) revert UnknownPlan();
        if (msg.sender != p.payee) revert NotPayee();
        p.active = active;
        emit PlanActiveSet(planId, active);
    }

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return _plans[planId];
    }

    // ───────────────────────────── subscriptions ─────────────────────────────

    /// @notice Prepay `periods` periods of `planId`. msg.value must equal periods * pricePerPeriod.
    function subscribe(uint256 planId, uint32 periods) external payable returns (uint256 subId) {
        Plan storage p = _plans[planId];
        if (p.payee == address(0)) revert UnknownPlan();
        if (!p.active) revert PlanInactive();
        if (msg.sender == p.payee) revert SelfPayment();
        if (periods == 0) revert ZeroPeriods();
        uint256 due = uint256(periods) * p.pricePerPeriod;
        if (msg.value != due) revert WrongPayment(msg.value, due);
        uint256 existing = subOf[planId][msg.sender];
        if (existing != 0 && _isLive(_subs[existing])) revert AlreadySubscribed(existing);

        subId = ++nextSubId;
        Sub storage s = _subs[subId];
        s.planId = planId;
        s.payer = msg.sender;
        s.paidThrough = uint64(block.timestamp + uint256(periods) * p.period);
        s.prepaid = msg.value;
        subOf[planId][msg.sender] = subId;
        emit Subscribed(subId, planId, msg.sender, periods, s.paidThrough);
    }

    /// @notice Extend a subscription by `periods`. Settles due periods to the payee first. A lapsed
    ///         subscription restarts from now.
    function renew(uint256 subId, uint32 periods) external payable {
        Sub storage s = _subs[subId];
        if (s.payer == address(0)) revert UnknownSub();
        if (msg.sender != s.payer) revert NotPayer();
        if (s.cancelled) revert SubAlreadyCancelled();
        if (periods == 0) revert ZeroPeriods();
        Plan storage p = _plans[s.planId];
        if (!p.active) revert PlanInactive();
        uint256 due = uint256(periods) * p.pricePerPeriod;
        if (msg.value != due) revert WrongPayment(msg.value, due);

        _settleSub(subId, s, p);
        if (s.paidThrough < block.timestamp) s.paidThrough = uint64(block.timestamp);
        s.paidThrough = uint64(uint256(s.paidThrough) + uint256(periods) * p.period);
        s.prepaid += msg.value;
        emit SubRenewed(subId, periods, s.paidThrough);
    }

    /// @notice Payer cancels: due periods → payee, every period not yet started → payer credits.
    function cancelSub(uint256 subId) external {
        Sub storage s = _subs[subId];
        if (s.payer == address(0)) revert UnknownSub();
        if (msg.sender != s.payer) revert NotPayer();
        if (s.cancelled) revert SubAlreadyCancelled();
        Plan storage p = _plans[s.planId];
        _settleSub(subId, s, p);
        uint256 refund = s.prepaid;
        s.prepaid = 0;
        s.cancelled = true;
        if (s.paidThrough > block.timestamp) s.paidThrough = uint64(block.timestamp);
        if (refund != 0) credits[s.payer] += refund;
        emit SubCancelled(subId, refund);
    }

    /// @notice Payee claims every period that has started since the last claim.
    function claimSub(uint256 subId) external {
        Sub storage s = _subs[subId];
        if (s.payer == address(0)) revert UnknownSub();
        Plan storage p = _plans[s.planId];
        if (msg.sender != p.payee) revert NotPayee();
        if (s.cancelled) revert SubAlreadyCancelled();
        if (_settleSub(subId, s, p) == 0) revert NothingToClaim();
    }

    /// @notice Periods currently claimable by the payee.
    function dueSubPeriods(uint256 subId) external view returns (uint256) {
        Sub storage s = _subs[subId];
        if (s.payer == address(0) || s.cancelled) return 0;
        return _duePeriods(s, _plans[s.planId]);
    }

    function isSubscribed(uint256 planId, address payer) external view returns (bool) {
        uint256 subId = subOf[planId][payer];
        return subId != 0 && _isLive(_subs[subId]);
    }

    function getSub(uint256 subId) external view returns (Sub memory) {
        return _subs[subId];
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

    // ───────────────────────────── governance ─────────────────────────────

    function setFee(uint16 bps) external onlyGovernance {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeChanged(bps);
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

    // ───────────────────────────── internals ─────────────────────────────

    function _accrued(Stream storage s) internal view returns (uint256) {
        uint256 t = block.timestamp < s.stop ? block.timestamp : s.stop;
        if (t <= s.start) return 0;
        uint256 a = (t - s.start) * s.ratePerSec;
        return a > s.deposit ? s.deposit : a;
    }

    function _creditPayee(address payee, uint256 amount) internal returns (uint256 net, uint256 fee) {
        if (amount == 0) return (0, 0);
        fee = (amount * feeBps) / BPS;
        net = amount - fee;
        credits[payee] += net;
        if (fee != 0) credits[feeRecipient] += fee;
    }

    function _isLive(Sub storage s) internal view returns (bool) {
        return !s.cancelled && s.paidThrough > block.timestamp;
    }

    /// @dev Periods that have started (period i starts at accrualStart + i*period) but are unclaimed.
    function _duePeriods(Sub storage s, Plan storage p) internal view returns (uint256) {
        uint256 remaining = s.prepaid / p.pricePerPeriod;
        if (remaining == 0) return 0;
        uint256 accrualStart = uint256(s.paidThrough) - remaining * p.period;
        if (block.timestamp < accrualStart) return 0;
        uint256 started = (block.timestamp - accrualStart) / p.period + 1;
        return started > remaining ? remaining : started;
    }

    function _settleSub(uint256 subId, Sub storage s, Plan storage p) internal returns (uint256 periods) {
        periods = _duePeriods(s, p);
        if (periods == 0) return 0;
        uint256 amount = periods * p.pricePerPeriod;
        s.prepaid -= amount;
        (uint256 net, uint256 fee) = _creditPayee(p.payee, amount);
        emit SubClaimed(subId, periods, net, fee);
    }
}
