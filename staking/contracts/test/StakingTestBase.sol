// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {FMXStaking} from "../src/FMXStaking.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";

/// @notice Shared fixture: deployed + wired staking stack, funded actors,
///         helpers for staking, pool funding, node registration and epochs.
abstract contract StakingTestBase is Test {
    FMXStaking internal staking;
    NodeRegistry internal registry;

    address internal msig = makeAddr("msig");
    address internal watchtower = makeAddr("watchtower");
    address internal funder = makeAddr("funder");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // deny-listed premine stand-in
    address internal premine = makeAddr("premine");

    uint256 internal constant YEAR = 365 days;
    uint256 internal constant COOLDOWN = 7 days;
    uint256 internal constant MIN_VAL = 25_000 ether;
    uint256 internal constant TIMELOCK = 48 hours;
    uint256 internal constant EPOCH = 1 days;
    uint256 internal constant DISPUTE = 7 days;

    function setUp() public virtual {
        vm.warp(200 days); // non-zero clock; epoch ~200
        address[] memory deny = new address[](1);
        deny[0] = premine;
        staking = new FMXStaking(msig, deny);
        registry = new NodeRegistry(address(staking), msig, watchtower);
        vm.prank(msig);
        staking.initNodeRegistry(address(registry));
    }

    // ------------------------------------------------------------- Helpers
    function fundPool(uint256 amount) internal {
        vm.deal(funder, funder.balance + amount);
        vm.prank(funder);
        staking.fundRewards{value: amount}();
    }

    function stakeAs(address who, FMXStaking.Tier tier, uint256 amount) internal returns (uint256 id) {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        id = staking.stake{value: amount}(tier);
    }

    /// @dev Register a node for `operator` bonded by `positionId`, with a
    ///      fresh devp2p key derived from `label`. Returns (nodeId, wallet).
    function registerNodeAs(address operator, uint256 positionId, string memory label)
        internal
        returns (uint256 nodeId, Vm.Wallet memory nodeWallet, address consensusAddr)
    {
        nodeWallet = vm.createWallet(uint256(keccak256(bytes(label))));
        consensusAddr = makeAddr(string.concat(label, "-consensus"));
        bytes memory pubkey = abi.encodePacked(bytes32(nodeWallet.publicKeyX), bytes32(nodeWallet.publicKeyY));
        bytes32 digest = registry.registrationDigest(operator, consensusAddr, positionId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(nodeWallet.privateKey, digest);
        vm.prank(operator);
        nodeId = registry.registerNode(pubkey, consensusAddr, positionId, v, r, s);
    }

    /// @dev Post a single-node epoch (must be a completed epoch).
    function postEpochFor(uint256 epoch, uint256 nodeId, uint16 scoreBps) internal {
        uint256[] memory ids = new uint256[](1);
        uint16[] memory scores = new uint16[](1);
        ids[0] = nodeId;
        scores[0] = scoreBps;
        vm.prank(watchtower);
        registry.postEpoch(epoch, keccak256(abi.encode(epoch, nodeId, scoreBps)), ids, scores);
    }

    /// @dev Boost helper for pure reward-math tests: act as the registry.
    function forceBoost(uint256 positionId, bool boosted) internal {
        vm.prank(address(registry));
        staking.setBoost(positionId, boosted);
    }
}
