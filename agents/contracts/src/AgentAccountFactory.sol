// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentAccount} from "./AgentAccount.sol";

/// @title AgentAccountFactory — EIP-1167 minimal-proxy factory for AgentAccount (Addendum v3, C2)
/// @notice `create(owner, salt)` deploys a deterministic clone (CREATE2) and initialises it; `predict`
///         returns the address ahead of time so the gateway can pre-fund an agent wallet.
/// @dev Paris EVM. The clone runtime is the canonical 45-byte EIP-1167 code (delegatecall lives ONLY there).
contract AgentAccountFactory {
    AgentAccount public immutable implementation;

    mapping(address => uint256) public accountCount; // owner => accounts created via this factory
    mapping(address => bool) public isAccount; // clone address => true

    event AccountCreated(address indexed owner, address indexed account);

    error ZeroAddress();
    error CreateFailed();

    constructor() {
        implementation = new AgentAccount();
    }

    /// @notice Deploy a clone for `owner`. Salt space is per owner (salt is mixed with `owner`).
    function create(address owner, bytes32 salt) external returns (address account) {
        if (owner == address(0)) revert ZeroAddress();
        bytes32 s = _salt(owner, salt);
        address impl = address(implementation);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            account := create2(0, ptr, 0x37, s)
        }
        if (account == address(0)) revert CreateFailed();
        AgentAccount(payable(account)).initialize(owner);
        accountCount[owner] += 1;
        isAccount[account] = true;
        emit AccountCreated(owner, account);
    }

    function predict(address owner, bytes32 salt) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                address(implementation),
                hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(owner, salt), initCodeHash))))
        );
    }

    function _salt(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, salt));
    }
}
