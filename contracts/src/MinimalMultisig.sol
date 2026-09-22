// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MinimalMultisig
 * @notice Small, auditable M-of-N owner multisig for the Ferminux Network treasury.
 *         Holds privileged positions (AZNT admin, TokenFactory feeCollector) and
 *         native FMX. Owners submit arbitrary calls, confirm them, and execute
 *         once the confirmation threshold is met.
 *
 *         Deliberately boring:
 *           - fixed owner set and threshold (set once in the constructor)
 *           - plain CALL only — no delegatecall, no upgradeability, no modules
 *           - submit() auto-confirms for the proposer
 *           - executed flag is set before the external call (no re-execution,
 *             no reentrancy into execute)
 *           - a failed call reverts, leaving the transaction pending so it can
 *             be retried or simply abandoned
 *
 * Self-contained: no external imports, compiles standalone with solc >=0.8.24.
 */
contract MinimalMultisig {
    // ---------------------------------------------------------------- Events
    event Deposit(address indexed sender, uint256 value);
    event Submitted(uint256 indexed txId, address indexed proposer, address to, uint256 value, bytes data);
    event Confirmed(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId, address indexed executor);

    // ---------------------------------------------------------------- State
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    Transaction[] public transactions;
    /// txId => owner => confirmed?
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    // ------------------------------------------------------------- Modifiers
    modifier onlyOwner() {
        require(isOwner[msg.sender], "MSIG: not owner");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactions.length, "MSIG: no such tx");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "MSIG: already executed");
        _;
    }

    // ----------------------------------------------------------- Constructor
    constructor(address[] memory _owners, uint256 _threshold) {
        require(_owners.length > 0, "MSIG: no owners");
        require(_threshold >= 1 && _threshold <= _owners.length, "MSIG: bad threshold");
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0), "MSIG: zero owner");
            require(!isOwner[o], "MSIG: duplicate owner");
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = _threshold;
    }

    // ---------------------------------------------------------- Receive FMX
    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- Views
    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function transactionCount() external view returns (uint256) {
        return transactions.length;
    }

    function getTransaction(uint256 txId)
        external
        view
        txExists(txId)
        returns (address to, uint256 value, bytes memory data, bool executed, uint256 confirmations)
    {
        Transaction storage txn = transactions[txId];
        return (txn.to, txn.value, txn.data, txn.executed, txn.confirmations);
    }

    // ------------------------------------------------------------- Lifecycle
    /// @notice Propose an arbitrary call. Auto-confirms for the proposer.
    function submit(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        require(to != address(0), "MSIG: zero target");
        txId = transactions.length;
        transactions.push(Transaction({to: to, value: value, data: data, executed: false, confirmations: 0}));
        emit Submitted(txId, msg.sender, to, value, data);
        _confirm(txId, msg.sender);
    }

    /// @notice Add this owner's confirmation to a pending transaction.
    function confirm(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        require(!confirmedBy[txId][msg.sender], "MSIG: already confirmed");
        _confirm(txId, msg.sender);
    }

    /// @notice Withdraw this owner's confirmation from a pending transaction.
    function revoke(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        require(confirmedBy[txId][msg.sender], "MSIG: not confirmed");
        confirmedBy[txId][msg.sender] = false;
        transactions[txId].confirmations -= 1;
        emit Revoked(txId, msg.sender);
    }

    /// @notice Execute a transaction once it has >= threshold confirmations.
    ///         Plain CALL. On failure the whole tx reverts and stays pending.
    function execute(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        Transaction storage txn = transactions[txId];
        require(txn.confirmations >= threshold, "MSIG: below threshold");
        txn.executed = true;
        (bool ok, ) = txn.to.call{value: txn.value}(txn.data);
        require(ok, "MSIG: call failed");
        emit Executed(txId, msg.sender);
    }

    function _confirm(uint256 txId, address owner) internal {
        confirmedBy[txId][owner] = true;
        transactions[txId].confirmations += 1;
        emit Confirmed(txId, owner);
    }
}
