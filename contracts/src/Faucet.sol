// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Ferminux Faucet
 * @notice Drips small amounts of native FMX so new users can pay gas
 *         before they mine or buy. Fund from the Community allocation.
 *         Rate-limited per address; owner can tune drip and cooldown.
 */
contract Faucet {
    address public owner;
    uint256 public dripAmount = 0.5 ether;   // 0.5 FMX (18 decimals)
    uint256 public cooldown = 24 hours;

    mapping(address => uint256) public lastDrip;

    event Dripped(address indexed to, uint256 amount);
    event Config(uint256 dripAmount, uint256 cooldown);

    modifier onlyOwner() {
        require(msg.sender == owner, "Faucet: not owner");
        _;
    }

    constructor() { owner = msg.sender; }

    receive() external payable {}

    function drip() external {
        require(block.timestamp >= lastDrip[msg.sender] + cooldown, "Faucet: cooldown");
        require(address(this).balance >= dripAmount, "Faucet: empty");
        lastDrip[msg.sender] = block.timestamp;
        (bool ok, ) = msg.sender.call{value: dripAmount}("");
        require(ok, "Faucet: send failed");
        emit Dripped(msg.sender, dripAmount);
    }

    function setConfig(uint256 _dripAmount, uint256 _cooldown) external onlyOwner {
        dripAmount = _dripAmount;
        cooldown = _cooldown;
        emit Config(_dripAmount, _cooldown);
    }

    function withdraw(uint256 amount) external onlyOwner {
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "Faucet: withdraw failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Faucet: zero owner");
        owner = newOwner;
    }
}
