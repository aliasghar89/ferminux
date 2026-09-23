// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal views of AgentAccountFactory / AgentAccount, so the AI-CV contracts can decide
///         whether two addresses are the same party without importing either implementation.
///         This mirrors the off-chain arms-length test in `gateway/src/commons/referrals.ts`
///         (`jobQualifies`): a party is its owner address AND every AgentAccount that owner holds.
interface IAccountFactoryLike {
    function isAccount(address account) external view returns (bool);
}

interface IAccountLike {
    function owner() external view returns (address);
}
