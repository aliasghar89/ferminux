// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FMXVesting
 * @notice Linear vesting of native FMX for the team allocation.
 *         Deploy, then send the 5,000,000 FMX team allocation to this contract.
 *
 *         Default: 6-month cliff, 36-month total linear vesting.
 *         Irrevocable by design — signals credibility to miners/investors.
 *
 * Native-coin vesting (FMX is the gas coin, not an ERC20), so this contract
 * holds and releases native balance.
 */
contract FMXVesting {
    address public immutable beneficiary;
    uint64 public immutable start;      // vesting start timestamp
    uint64 public immutable cliff;      // seconds after start before anything unlocks
    uint64 public immutable duration;   // total vesting length in seconds

    uint256 public released;

    event Released(uint256 amount);
    event Funded(address indexed from, uint256 amount);

    constructor(address _beneficiary, uint64 _start, uint64 _cliffSeconds, uint64 _durationSeconds) {
        require(_beneficiary != address(0), "Vesting: zero beneficiary");
        require(_durationSeconds > 0 && _cliffSeconds <= _durationSeconds, "Vesting: bad schedule");
        beneficiary = _beneficiary;
        start = _start;
        cliff = _cliffSeconds;
        duration = _durationSeconds;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Total FMX ever held by this contract (released + still locked).
    function totalAllocation() public view returns (uint256) {
        return address(this).balance + released;
    }

    /// @notice Amount vested at a given timestamp.
    function vestedAmount(uint64 timestamp) public view returns (uint256) {
        uint256 total = totalAllocation();
        if (timestamp < start + cliff) return 0;
        if (timestamp >= start + duration) return total;
        return (total * (timestamp - start)) / duration;
    }

    /// @notice Releasable right now.
    function releasable() public view returns (uint256) {
        return vestedAmount(uint64(block.timestamp)) - released;
    }

    /// @notice Anyone can trigger; funds only ever go to the beneficiary.
    function release() external {
        uint256 amount = releasable();
        require(amount > 0, "Vesting: nothing vested");
        released += amount;
        (bool ok, ) = beneficiary.call{value: amount}("");
        require(ok, "Vesting: transfer failed");
        emit Released(amount);
    }
}
