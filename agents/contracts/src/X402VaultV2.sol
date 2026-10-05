// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Sig} from "./lib/Sig.sol";

/// @title X402VaultV2 — pay-per-request vouchers in native FMX (successor of X402Vault)
/// @notice Same interface, EIP-712 domain and voucher type as X402Vault, plus:
///         - Lock semantics. A deposit is locked (unlockAt = 0) until its payer calls `requestUnlock`;
///           `withdraw` works from `unlockAt` on and re-locks. In X402Vault a deposit made after the
///           unlock time stayed withdrawable at once, so a payer could top up, pay with vouchers and
///           pull the deposit out ahead of their settlement. Here the payer's own `deposit` (or
///           `depositFor` itself) re-locks, and `relock()` does so explicitly; either way a later
///           withdrawal needs a fresh `requestUnlock` and its full delay, during which outstanding
///           vouchers can still be settled. A `depositFor` by anyone else leaves the payer's lock state
///           alone, so a third party cannot keep a payer from withdrawing with dust deposits.
///         - A contract payer's ERC-1271 answer can no longer revert a batch. X402Vault decoded it with
///           `abi.decode(ret, (bytes4))`, which reverts on dirty padding, so one such payer made
///           `settleBatch` revert as a whole and no voucher in it settled. Here the answer must be the
///           magic value with clean padding; anything else (dirty, short, reverting) is "bad signature"
///           and that voucher alone is skipped. Only the first 32 bytes of the answer are copied.
///           The answer gets a fixed `ERC1271_GAS`, not all the gas: X402Vault forwarded 63/64 of what the
///           batch had left, so a payer whose answer burns gas starved every voucher after it and the
///           batch failed even at the block gas limit. Here such a voucher costs that allowance, and an
///           answer that runs out of it is "bad signature" too. And since an answer may change between the
///           facilitator's gas estimate and inclusion (state, block.number, tx.gasprice), and so may whether
///           a voucher comes to its call at all (its payer's deposit, its payer's code), `settleBatch`
///           requires, at each voucher that is not its payer's own EOA signature — decided by the calldata
///           alone, ahead of every check on state — the gas for that voucher and for every voucher after it
///           at its worst case (`InsufficientGas` otherwise): the estimate holds that headroom, so the batch
///           still fits it whatever the answers, deposits and code do. A batch then needs a gas limit of
///           about 325k for each voucher from its first contract payer on (16M for 50); the gas it uses is
///           unchanged.
///
/// MIGRATION — replaces the live `x402Vault` (agents/deployments-v3.3961.json). Nothing here is deployed:
///   1. Deploy `X402VaultV2(deployer, feeRecipient)`, then — last — `setGovernance(multisig)`.
///   2. The live vault has no admin path that moves deposits: each payer leaves it with `requestUnlock`
///      and, an hour later, `withdraw`, then deposits into V2. Payee credits stay withdrawable there.
///   3. Point the gateway facilitator and the SDK / web `x402Vault` key at V2, but keep settling live-vault
///      vouchers already issued until they expire. The EIP-712 domain name and version are unchanged
///      (signers need no update); `verifyingContract` keeps vouchers of the two vaults apart. The
///      facilitator's `settleBatch` gas limit must stay an estimate (or above it): a fixed limit below the
///      headroom above reverts `InsufficientGas` for every batch with a contract payer. Ahead of a batch's
///      first contract payer (and in a batch without one) the estimate holds each voucher only at the cost
///      it had then: one skipped while estimated that settles on chain (its deposit refilled in between)
///      takes its settlement beyond it, which the facilitator's margin has to cover: under 75k, the cost
///      of settling into fresh slots (its nonce, its payee's credits, and the fee recipient's once a
///      `withdrawCredits` has emptied them).
///   4. Export the ABI then (`forge inspect X402VaultV2 abi --json > abi/X402VaultV2.json`).
/// @dev Paris EVM (no PUSH0). Signature = EOA ecrecover OR ERC-1271 (AgentAccount clones can pay).
///      Domain: {name:"FerminuxX402", version:"1", chainId:block.chainid, verifyingContract:this}.
///      Only `withdraw` and `withdrawCredits` move FMX out; both are nonReentrant and zero-before-call.
contract X402VaultV2 {
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
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    /// @dev The same value as an ABI-encoded bytes4 answer: left-aligned, zero padding.
    bytes32 private constant ERC1271_MAGIC_WORD = 0x1626ba7e00000000000000000000000000000000000000000000000000000000;
    /// @dev Gas an ERC-1271 answer may use. AgentAccount's check (an ecrecover, or its owner's own ERC-1271
    ///      check when the owner is a multisig) needs a fraction of it, and a batch of 50 answers that each
    ///      burn all of it stays well inside the block gas limit.
    uint256 private constant ERC1271_GAS = 200_000;
    /// @dev The most one voucher costs `settleBatch` besides its signature bytes, should its payer be a
    ///      contract whose answer burns the whole allowance: that allowance, the 1/64 a call keeps back (so
    ///      the answer is given all of it), and 120k for the rest — checks, digest, ecrecover, the payer's
    ///      code size, settling into fresh storage slots and the log come to about 90k on the chain's gas
    ///      schedule.
    uint256 private constant VOUCHER_WORST_GAS = ERC1271_GAS + ERC1271_GAS / 63 + 120_000;
    /// @dev The most one signature byte adds: its copy into the ERC-1271 call and the memory that takes
    ///      (under 1 gas a byte for signatures up to 400 KB).
    uint256 private constant SIG_BYTE_GAS = 2;

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
    event Relocked(address indexed payer);
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
    error InsufficientGas(uint256 required);

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

    /// @notice Deposit for yourself. Re-locks your deposit if an unlock was requested (pending or due).
    function deposit() external payable {
        _deposit(msg.sender);
    }

    /// @notice Deposit for `payer`. Re-locks only when `payer` is the caller.
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

    /// @notice Cancel a requested unlock (pending or due): the deposit is locked again until the next
    ///         `requestUnlock` and its full delay.
    function relock() external {
        _relock(msg.sender);
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
        (bool ok, string memory reason) = _verify(v, sig, 0);
        if (!ok) revert VoucherInvalid(reason);
        _settle(v);
    }

    /// @notice Settle many vouchers; invalid ones are skipped with `Skipped(payer, nonce, reason)`.
    ///         Reverts `InsufficientGas` when, at a voucher that is not its payer's own EOA signature (a
    ///         contract payer's), the batch no longer holds the gas for it and for every voucher after it
    ///         at its worst case, whatever the payer's deposit and code; a gas estimate includes it.
    /// @dev Balance is re-checked per voucher, so a payer running dry mid-batch only skips the rest.
    function settleBatch(Voucher[] calldata vs, bytes[] calldata sigs) external {
        if (vs.length != sigs.length) revert LengthMismatch();
        for (uint256 i = 0; i < vs.length; i++) {
            (bool ok, string memory reason) = _verify(vs[i], sigs[i], vs.length - i);
            if (!ok) {
                emit Skipped(vs[i].payer, vs[i].nonce, reason);
                continue;
            }
            _settle(vs[i]);
        }
    }

    /// @notice Facilitator pre-check: would `settle` succeed right now?
    function verify(Voucher calldata v, bytes calldata sig) external view returns (bool ok, string memory reason) {
        return _verify(v, sig, 0);
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
        // only the payer's own deposit: anyone else could otherwise hold a payer's withdrawal off for ever
        if (msg.sender == payer) _relock(payer);
    }

    function _relock(address payer) internal {
        if (unlockAt[payer] == 0) return;
        unlockAt[payer] = 0;
        emit Relocked(payer);
    }

    /// @param left vouchers of the batch from this one on (see `_requireHeadroom`); 0 outside `settleBatch`
    function _verify(Voucher calldata v, bytes calldata sig, uint256 left) internal view returns (bool, string memory) {
        if (v.payer == address(0)) return (false, "zero payer");
        if (v.payee == address(0)) return (false, "zero payee");
        if (v.amount == 0) return (false, "zero amount");
        bytes32 digest = hashVoucher(v);
        address rec = Sig.recover(digest, sig);
        // recovered ahead of every check on state, so that whether this voucher may come to an ERC-1271
        // call (and needs the headroom) is decided by the calldata alone: the same in an estimate as on chain
        bool eoa = rec != address(0) && rec == v.payer;
        if (!eoa && left != 0) _requireHeadroom(sig, left);
        if (block.timestamp > v.expiry) return (false, "expired");
        if (used[v.payer][v.nonce]) return (false, "nonce used");
        if (balance[v.payer] < v.amount) return (false, "insufficient balance");
        if (!eoa && !_isValid1271(v.payer, digest, sig)) return (false, "bad signature");
        return (true, "");
    }

    /// @dev In a batch, at each voucher that is not its payer's own EOA signature: reverts `InsufficientGas`
    ///      unless the gas for `left` vouchers at their worst case, and for this and every later signature's
    ///      bytes, is left.
    function _requireHeadroom(bytes calldata sig, uint256 left) internal view {
        // The facilitator's gas limit is an estimate, taken while this voucher's answer may have been cheap
        // or invalid — it can turn on state, block.number or tx.gasprice (0 in an estimate without fee
        // fields) — or while the voucher never came to its call: its payer's deposit was short, or the payer
        // had no code (anyone may `depositFor` it, and a CREATE2 account be deployed, in between). On chain
        // it may burn its allowance, or settle where it was skipped, and the vouchers after it would run out
        // of gas, the batch with them. A check reached only past the state checks would leave such a voucher
        // out of the estimate, so this one turns on the calldata alone. A check of this answer's allowance
        // alone never binds while later vouchers still need gas, so it covers every voucher left at its worst
        // case: an estimate that passes here holds whatever the answers, deposits and code do. The later
        // signatures follow this one in the calldata (ABI encoding lays them out in order): what is left from
        // its first byte bounds the bytes still to copy.
        uint256 sigStart;
        assembly ("memory-safe") {
            sigStart := sig.offset
        }
        uint256 needed = left * VOUCHER_WORST_GAS + (msg.data.length - sigStart) * SIG_BYTE_GAS;
        if (gasleft() < needed) revert InsufficientGas(needed);
    }

    /// @dev Sig.isValid's ERC-1271 half without its ways to revert: the magic value — exactly, clean padding
    ///      included — from `signer` as a contract. A reverting, short or dirty answer, or one that runs out
    ///      of `ERC1271_GAS`, is simply not valid; only its first word is copied.
    function _isValid1271(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool valid) {
        if (signer.code.length == 0) return false;
        bytes memory data = abi.encodeWithSelector(ERC1271_MAGIC, digest, sig);
        assembly ("memory-safe") {
            // capped: with gas() a payer's answer could take 63/64 of the batch's gas and starve the rest
            let ok := staticcall(ERC1271_GAS, signer, add(data, 0x20), mload(data), 0, 0x20)
            valid := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0), ERC1271_MAGIC_WORD)))
        }
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
