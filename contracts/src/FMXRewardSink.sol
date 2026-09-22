// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FMXRewardSink
 * @notice Receives the sink share (50%) of every Ferminux proof-of-authority
 *         block reward. The consensus engine (consensus/posa) credits this
 *         address directly in state — no call is made — so receive() only
 *         runs for ordinary transfers. Funds leave through the owner only.
 *
 *         Deliberately minimal:
 *           - owner is the Ferminux multisig (0x910BD467D8576277f8f96DF47428377FFD94fEfe),
 *             handed over with a two-step transfer so a typo cannot orphan it
 *           - withdraw(to, amount) is the only way out
 *           - no upgradeability, no delegatecall, no roles, nothing else
 *
 * Self-contained: no external imports, compiles standalone with solc 0.8.24
 * targeting Paris (no PUSH0) for chain 3961.
 */
contract FMXRewardSink {
    // ---------------------------------------------------------------- Events
    event Received(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------- State
    address public owner;
    address public pendingOwner;

    // ------------------------------------------------------------- Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "SINK: not owner");
        _;
    }

    // ----------------------------------------------------------- Constructor
    /// @param initialOwner The Ferminux multisig.
    constructor(address initialOwner) {
        require(initialOwner != address(0), "SINK: zero owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // ---------------------------------------------------------- Receive FMX
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // -------------------------------------------------------------- Withdraw
    /// @notice Send `amount` wei of FMX to `to`. Owner only.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "SINK: zero recipient");
        require(amount <= address(this).balance, "SINK: insufficient balance");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "SINK: transfer failed");
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------ Two-step owner
    /// @notice Nominate a new owner; takes effect when they call acceptOwnership().
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "SINK: zero owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete a pending ownership transfer. Pending owner only.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "SINK: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
