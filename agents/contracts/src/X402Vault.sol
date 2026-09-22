// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Sig} from "./lib/Sig.sol";

/// @title X402Vault — pay-per-request vouchers in native FMX (Addendum v3, C1)
/// @notice A payer deposits FMX and signs off-chain EIP-712 vouchers; the payee (or the gateway
///         facilitator) settles them on-chain, batched. Withdrawal of the deposit has a 1 h unlock so
///         outstanding vouchers can be settled first. Payee earnings are PULL payments (`credits`).
/// @dev Paris EVM (no PUSH0). Signature = EOA ecrecover OR ERC-1271 (AgentAccount clones can pay).
///      Domain: {name:"FerminuxX402", version:"1", chainId:block.chainid, verifyingContract:this}.
///      Only `withdraw` and `withdrawCredits` move FMX out; both are nonReentrant and zero-before-call.
contract X402Vault {
    // ───────────────────────────── types ─────────────────────────────

    struct Voucher {
        address payer;
        address payee;
        uint256 amount; // per-voucher (not cumulative)
        uint256 nonce; // unique per payer
        uint64 expiry; // unix seconds, voucher valid while block.timestamp <= expiry
        bytes32 ref; // free-form reference (resource hash, job id, …)
    }

    // ───────────────────────────── constants ─────────────────────────────

    string public constant NAME = "FerminuxX402";
    string public constant VERSION = "1";
    uint64 public constant UNLOCK_DELAY = 1 hours;
    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant BPS = 10000;
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address payer,address payee,uint256 amount,uint256 nonce,uint64 expiry,bytes32 ref)");

    // ───────────────────────────── storage ─────────────────────────────

    mapping(address => uint256) public balance; // deposited FMX
    mapping(address => uint256) public unlockAt; // 0 = locked
    mapping(address => mapping(uint256 => bool)) public used; // payer => nonce
    mapping(address => uint256) public credits; // payee pull balance
    uint16 public feeBps = 100; // 1 %
    address public feeRecipient;
    address public governance;

    uint256 private _lock;

    // ───────────────────────────── events ─────────────────────────────

    event Deposited(address indexed payer, uint256 amount);
    event Settled(
        address indexed payer, address indexed payee, uint256 amount, uint256 fee, uint256 nonce, bytes32 ref
    );
    event Skipped(address indexed payer, uint256 nonce, string reason);
    event UnlockRequested(address indexed payer, uint64 at);
    event Withdrawn(address indexed to, uint256 amount); // deposit withdrawal
    event CreditsWithdrawn(address indexed to, uint256 amount); // payee earnings withdrawal
    event FeeChanged(uint16 feeBps);
    event FeeRecipientChanged(address indexed feeRecipient);
    event GovernanceChanged(address indexed previous, address indexed current);

    // ───────────────────────────── errors ─────────────────────────────

    error NotGovernance();
    error ZeroAddress();
    error ZeroValue();
    error Locked();
    error TooEarly(uint64 availableAt);
    error InsufficientBalance(uint256 requested, uint256 available);
    error VoucherInvalid(string reason);
    error LengthMismatch();
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

    // ───────────────────────────── deposits / withdrawals ─────────────────────────────

    function deposit() external payable {
        _deposit(msg.sender);
    }

    function depositFor(address payer) external payable {
        if (payer == address(0)) revert ZeroAddress();
        _deposit(payer);
    }

    /// @notice Start the 1 h unlock. Vouchers stay settleable during the delay.
    function requestUnlock() external {
        uint64 at = uint64(block.timestamp) + UNLOCK_DELAY;
        unlockAt[msg.sender] = at;
        emit UnlockRequested(msg.sender, at);
    }

    /// @notice Withdraw `amount` of the deposit once unlocked. Re-locks the account (unlockAt = 0).
    function withdraw(uint256 amount) external nonReentrant {
        uint64 at = uint64(unlockAt[msg.sender]);
        if (at == 0) revert Locked();
        if (block.timestamp < at) revert TooEarly(at);
        if (amount == 0) revert ZeroValue();
        uint256 bal = balance[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);
        balance[msg.sender] = bal - amount;
        unlockAt[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Pull accrued payee earnings (and fees for the fee recipient).
    function withdrawCredits() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit CreditsWithdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────────── settlement ─────────────────────────────

    /// @notice Settle one voucher. Anyone may call. Reverts with `VoucherInvalid(reason)` on failure.
    function settle(Voucher calldata v, bytes calldata sig) external {
        (bool ok, string memory reason) = _verify(v, sig);
        if (!ok) revert VoucherInvalid(reason);
        _settle(v);
    }

    /// @notice Settle many vouchers; invalid ones are skipped with `Skipped(payer, nonce, reason)`.
    /// @dev Balance is re-checked per voucher, so a payer running dry mid-batch only skips the rest.
    function settleBatch(Voucher[] calldata vs, bytes[] calldata sigs) external {
        if (vs.length != sigs.length) revert LengthMismatch();
        for (uint256 i = 0; i < vs.length; i++) {
            (bool ok, string memory reason) = _verify(vs[i], sigs[i]);
            if (!ok) {
                emit Skipped(vs[i].payer, vs[i].nonce, reason);
                continue;
            }
            _settle(vs[i]);
        }
    }

    /// @notice Facilitator pre-check: would `settle` succeed right now?
    function verify(Voucher calldata v, bytes calldata sig) external view returns (bool ok, string memory reason) {
        return _verify(v, sig);
    }

    // ───────────────────────────── views ─────────────────────────────

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return Sig.domainSeparator(NAME, VERSION, address(this));
    }

    function hashVoucher(Voucher calldata v) public view returns (bytes32) {
        return Sig.typedDataHash(
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(VOUCHER_TYPEHASH, v.payer, v.payee, v.amount, v.nonce, v.expiry, v.ref))
        );
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

    function _deposit(address payer) internal {
        if (msg.value == 0) revert ZeroValue();
        balance[payer] += msg.value;
        emit Deposited(payer, msg.value);
    }

    function _verify(Voucher calldata v, bytes calldata sig) internal view returns (bool, string memory) {
        if (v.payer == address(0)) return (false, "zero payer");
        if (v.payee == address(0)) return (false, "zero payee");
        if (v.amount == 0) return (false, "zero amount");
        if (block.timestamp > v.expiry) return (false, "expired");
        if (used[v.payer][v.nonce]) return (false, "nonce used");
        if (balance[v.payer] < v.amount) return (false, "insufficient balance");
        if (!Sig.isValid(v.payer, hashVoucher(v), sig)) return (false, "bad signature");
        return (true, "");
    }

    /// @dev Caller has verified. Effects only — no external calls.
    function _settle(Voucher calldata v) internal {
        uint256 fee = (v.amount * feeBps) / BPS;
        used[v.payer][v.nonce] = true;
        balance[v.payer] -= v.amount;
        credits[v.payee] += v.amount - fee;
        if (fee != 0) credits[feeRecipient] += fee;
        emit Settled(v.payer, v.payee, v.amount, fee, v.nonce, v.ref);
    }
}
