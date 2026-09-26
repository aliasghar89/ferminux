// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFMXRewardSink {
    function withdraw(address payable to, uint256 amount) external;
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function owner() external view returns (address);
}

interface IValidatorHubFund {
    function fund() external payable;
}

/// @title SinkRouter: forwards a fixed share of FMXRewardSink inflow to ValidatorHub
/// @notice Becomes FMXRewardSink's owner through the sink's own two-step transfer
///         (the multisig calls sink.transferOwnership(router), then router.acceptSinkOwnership()).
///         pump() is permissionless: it withdraws the whole sink balance and splits it,
///         `shareBps` (40% at launch) to ValidatorHub.fund() and the rest to the multisig reserve.
///
///         The share changes only through a 48 h timelock and can never exceed 50%. The reserve
///         address and handing the sink back also go through the timelock, so the validator
///         share can never be redirected at once.
/// @dev solc 0.8.24, evm paris. No upgradeability, no delegatecall. Holds FMX only inside pump().
contract SinkRouter {
    uint256 public constant MAX_SHARE_BPS = 5_000; // hard cap: 50%
    uint256 public constant INITIAL_SHARE_BPS = 4_000; // 40%
    uint256 public constant BPS = 10_000;
    uint256 public constant TIMELOCK = 24_686; // 48 h at 7 s blocks

    uint8 public constant P_SHARE = 0;
    uint8 public constant P_RESERVE = 1;
    uint8 public constant P_SINK_OWNER = 2;

    IFMXRewardSink public immutable sink;
    address public immutable hub;

    address public owner;
    address public pendingOwner;
    address public reserve;
    uint256 public shareBps;
    mapping(bytes32 => uint256) public timelockEta;

    uint256 public totalPumped;
    uint256 public totalToHub;
    uint256 public totalToReserve;

    uint256 private _lock = 1;

    event Pumped(uint256 fromSink, uint256 toHub, uint256 toReserve);
    event ParamQueued(uint8 indexed param, uint256 value, uint256 eta);
    event ParamCancelled(uint8 indexed param, uint256 value);
    event ParamApplied(uint8 indexed param, uint256 value);
    event SinkOwnershipAccepted(address indexed sink);
    event SinkOwnershipOffered(address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error Reentrancy();
    error BadParam();
    error NotQueued();
    error AlreadyQueued();
    error TooEarly();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param owner_   the foundation multisig
    /// @param sink_    FMXRewardSink
    /// @param hub_     ValidatorHub
    /// @param reserve_ receives the non-validator share (the multisig reserve)
    constructor(address owner_, address sink_, address hub_, address reserve_) {
        if (owner_ == address(0) || sink_ == address(0) || hub_ == address(0) || reserve_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        sink = IFMXRewardSink(sink_);
        hub = hub_;
        reserve = reserve_;
        shareBps = INITIAL_SHARE_BPS;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// Accepts FMX from the sink's withdraw() (and anyone else; pump() forwards it all).
    receive() external payable {}

    /// @notice Withdraw the sink's whole balance and split it: `shareBps` to the hub, the rest to
    ///         the reserve. Anything already held by the router is split the same way.
    function pump() external returns (uint256 toHub, uint256 toReserve) {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        uint256 fromSink = address(sink).balance;
        if (fromSink != 0) sink.withdraw(payable(address(this)), fromSink);
        uint256 total = address(this).balance;
        toHub = total * shareBps / BPS;
        toReserve = total - toHub;
        totalPumped += total;
        totalToHub += toHub;
        totalToReserve += toReserve;
        if (toHub != 0) IValidatorHubFund(hub).fund{value: toHub}();
        if (toReserve != 0) {
            (bool ok,) = payable(reserve).call{value: toReserve}("");
            if (!ok) revert TransferFailed();
        }
        emit Pumped(fromSink, toHub, toReserve);
        _lock = 1;
    }

    /// @notice Second half of the sink's two-step ownership transfer.
    function acceptSinkOwnership() external onlyOwner {
        sink.acceptOwnership();
        emit SinkOwnershipAccepted(address(sink));
    }

    // ------------------------------------------------------------------ timelock

    function queueParam(uint8 param, uint256 value) external onlyOwner {
        _validate(param, value);
        bytes32 key = keccak256(abi.encode(param, value));
        if (timelockEta[key] != 0) revert AlreadyQueued();
        uint256 eta = block.number + TIMELOCK;
        timelockEta[key] = eta;
        emit ParamQueued(param, value, eta);
    }

    function cancelParam(uint8 param, uint256 value) external onlyOwner {
        bytes32 key = keccak256(abi.encode(param, value));
        if (timelockEta[key] == 0) revert NotQueued();
        delete timelockEta[key];
        emit ParamCancelled(param, value);
    }

    function applyParam(uint8 param, uint256 value) external onlyOwner {
        bytes32 key = keccak256(abi.encode(param, value));
        uint256 eta = timelockEta[key];
        if (eta == 0) revert NotQueued();
        if (block.number < eta) revert TooEarly();
        delete timelockEta[key];
        _validate(param, value);
        if (param == P_SHARE) {
            shareBps = value;
        } else if (param == P_RESERVE) {
            reserve = address(uint160(value));
        } else {
            // hand the sink to a new owner (it completes with sink.acceptOwnership())
            address next = address(uint160(value));
            sink.transferOwnership(next);
            emit SinkOwnershipOffered(next);
        }
        emit ParamApplied(param, value);
    }

    function _validate(uint8 param, uint256 value) internal pure {
        if (param == P_SHARE) {
            if (value > MAX_SHARE_BPS) revert BadParam();
        } else if (param == P_RESERVE || param == P_SINK_OWNER) {
            if (value == 0 || value > type(uint160).max) revert BadParam();
        } else {
            revert BadParam();
        }
    }

    // ------------------------------------------------------------------ ownership

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
