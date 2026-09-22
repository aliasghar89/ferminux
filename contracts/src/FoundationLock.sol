// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title FoundationLock
 * @notice A public, time-locked vault for native FMX.
 *
 *         Anyone can send FMX here with a plain transfer — receive() accepts it
 *         and logs it. Nothing can leave before `unlockAt`. After `unlockAt`,
 *         only the owner (the foundation multisig) can withdraw.
 *
 *         What this is: a credibility instrument. The foundation holds most of
 *         the supply, and "we are not selling" is worth nothing unless it can
 *         be checked. Coins in here are checkably not for sale until the date.
 *
 *         What this is NOT: staking, consensus participation, or security for
 *         the chain. It votes on nothing and secures nothing. Do not describe
 *         it otherwise.
 *
 *         Deliberately immutable: `unlockAt` is fixed at deployment and there is
 *         no function to shorten it. A lock the owner can shorten is not a
 *         lock. To lock for a different period, deploy another instance.
 *
 * @dev    Paris EVM, no PUSH0 (Ferminux). Two-step ownership so a typo cannot
 *         hand the vault to a dead address.
 */
contract FoundationLock {
    /// @notice Timestamp before which nothing can be withdrawn. Immutable.
    uint64 public immutable unlockAt;

    address public owner;
    address public pendingOwner;

    event Locked(address indexed from, uint256 amount, uint256 totalLocked);
    event Withdrawn(address indexed to, uint256 amount, uint256 remaining);
    event OwnershipTransferStarted(address indexed newOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "LOCK: not owner");
        _;
    }

    constructor(address _owner, uint64 _unlockAt) {
        require(_owner != address(0), "LOCK: zero owner");
        // A lock that is already open at deployment is a mistake, not a lock.
        require(_unlockAt > block.timestamp, "LOCK: unlock must be in the future");
        owner = _owner;
        unlockAt = _unlockAt;
        emit OwnershipTransferred(address(0), _owner);
    }

    /// @notice Accept a plain FMX transfer. This is how coins go in.
    receive() external payable {
        require(msg.value > 0, "LOCK: zero value");
        emit Locked(msg.sender, msg.value, address(this).balance);
    }

    /// @notice Total FMX currently held.
    function locked() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Seconds until withdrawal is possible; 0 once open.
    function remaining() external view returns (uint256) {
        return block.timestamp >= unlockAt ? 0 : unlockAt - block.timestamp;
    }

    /// @notice Withdraw after the unlock date. Owner only.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        require(block.timestamp >= unlockAt, "LOCK: still locked");
        require(to != address(0), "LOCK: zero to");
        require(amount > 0 && amount <= address(this).balance, "LOCK: bad amount");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "LOCK: transfer failed");
        emit Withdrawn(to, amount, address(this).balance);
    }

    // ------------------------------------------------------------ ownership
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "LOCK: zero owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "LOCK: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
