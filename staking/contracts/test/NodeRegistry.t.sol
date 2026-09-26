// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StakingTestBase} from "./StakingTestBase.sol";
import {FMXStaking} from "../src/FMXStaking.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";
import {Vm} from "forge-std/Test.sol";

/// @notice NodeRegistry tests: registration + possession proofs, duplicate
///         identity rejection, bond gating, attestation epochs with dispute
///         window, boost wiring, qualification, getValidators ranking,
///         slashing hooks, and the roster view.
contract NodeRegistryTest is StakingTestBase {
    // ------------------------------------------------------- Registration
    function test_RegisterHappyPath() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 nodeId, Vm.Wallet memory w, address cons) = registerNodeAs(alice, pos, "node-a");
        assertEq(nodeId, 1);
        NodeRegistry.Node memory n = registry.getNode(nodeId);
        assertEq(n.operator, alice);
        assertEq(n.consensusAddr, cons);
        assertEq(n.nodeAddress, w.addr);
        assertEq(n.positionId, pos);
        assertTrue(n.active);
        assertEq(n.lastSeen, 0);
        assertEq(registry.nodeIdByNodeAddress(w.addr), nodeId);
        assertEq(registry.nodeIdByConsensusAddr(cons), nodeId);
        assertEq(registry.nodeIdByPosition(pos), nodeId);
        bytes memory pk = registry.getNodePubkey(nodeId);
        assertEq(pk.length, 64);
        assertEq(address(uint160(uint256(keccak256(pk)))), w.addr);
    }

    function test_RegisterRejectsDuplicateNodeKey() public {
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL);
        (, Vm.Wallet memory w,) = registerNodeAs(alice, p1, "dup-key");
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        address cons2 = makeAddr("cons2");
        bytes32 digest = registry.registrationDigest(bob, cons2, p2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.privateKey, digest);
        vm.prank(bob);
        vm.expectRevert(bytes("NR: node key already registered"));
        registry.registerNode(pubkey, cons2, p2, v, r, s);
    }

    function test_RegisterRejectsDuplicateConsensusAddr() public {
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL);
        (,, address cons) = registerNodeAs(alice, p1, "n1");
        Vm.Wallet memory w2 = vm.createWallet(uint256(keccak256("n2")));
        bytes memory pubkey2 = abi.encodePacked(bytes32(w2.publicKeyX), bytes32(w2.publicKeyY));
        bytes32 digest = registry.registrationDigest(bob, cons, p2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w2.privateKey, digest);
        vm.prank(bob);
        vm.expectRevert(bytes("NR: consensus addr already registered"));
        registry.registerNode(pubkey2, cons, p2, v, r, s);
    }

    function test_RegisterRejectsReusedPosition() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        registerNodeAs(alice, pos, "n1");
        Vm.Wallet memory w2 = vm.createWallet(uint256(keccak256("n2")));
        bytes memory pubkey2 = abi.encodePacked(bytes32(w2.publicKeyX), bytes32(w2.publicKeyY));
        address cons2 = makeAddr("cons2");
        bytes32 digest = registry.registrationDigest(alice, cons2, pos);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w2.privateKey, digest);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: position already bonds a node"));
        registry.registerNode(pubkey2, cons2, pos, v, r, s);
    }

    function test_RegisterRejectsBadPubkeyLength() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: pubkey must be 64 bytes"));
        registry.registerNode(hex"deadbeef", makeAddr("c"), pos, 27, bytes32(0), bytes32(0));
    }

    function test_RegisterRejectsZeroConsensusAddr() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256("n")));
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        vm.prank(alice);
        vm.expectRevert(bytes("NR: zero consensus addr"));
        registry.registerNode(pubkey, address(0), pos, 27, bytes32(0), bytes32(0));
    }

    function test_RegisterRejectsForeignPosition() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256("n")));
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        address cons = makeAddr("c");
        bytes32 digest = registry.registrationDigest(bob, cons, pos);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.privateKey, digest);
        vm.prank(bob);
        vm.expectRevert(bytes("NR: not position owner"));
        registry.registerNode(pubkey, cons, pos, v, r, s);
    }

    function test_RegisterRejectsNonValidatorTier() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Locked180, 30_000 ether);
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256("n")));
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        address cons = makeAddr("c");
        bytes32 digest = registry.registrationDigest(alice, cons, pos);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.privateKey, digest);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: not a validator-track position"));
        registry.registerNode(pubkey, cons, pos, v, r, s);
    }

    function test_RegisterRejectsInactivePosition() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.prank(alice);
        staking.emergencyExit(pos);
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256("n")));
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        address cons = makeAddr("c");
        bytes32 digest = registry.registrationDigest(alice, cons, pos);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.privateKey, digest);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: position not active"));
        registry.registerNode(pubkey, cons, pos, v, r, s);
    }

    function test_RegisterRejectsWrongSigner() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256("real-node")));
        Vm.Wallet memory imposter = vm.createWallet(uint256(keccak256("imposter")));
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        address cons = makeAddr("c");
        bytes32 digest = registry.registrationDigest(alice, cons, pos);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(imposter.privateKey, digest); // not the node key
        vm.prank(alice);
        vm.expectRevert(bytes("NR: invalid possession signature"));
        registry.registerNode(pubkey, cons, pos, v, r, s);
    }

    function test_RegisterRejectsReplayedSignatureForOtherPosition() public {
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256("n")));
        bytes memory pubkey = abi.encodePacked(bytes32(w.publicKeyX), bytes32(w.publicKeyY));
        address cons = makeAddr("c");
        bytes32 digest = registry.registrationDigest(alice, cons, p1); // signed for p1
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.privateKey, digest);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: invalid possession signature"));
        registry.registerNode(pubkey, cons, p2, v, r, s); // replayed against p2
    }

    // ------------------------------------------------------ Deregistration
    function test_DeregisterFreesIdentity() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 nodeId, Vm.Wallet memory w, address cons) = registerNodeAs(alice, pos, "n1");
        vm.prank(alice);
        registry.deregisterNode(nodeId);
        assertFalse(registry.getNode(nodeId).active);
        assertEq(registry.nodeIdByNodeAddress(w.addr), 0);
        assertEq(registry.nodeIdByConsensusAddr(cons), 0);
        assertEq(registry.nodeIdByPosition(pos), 0);
        // same identity can be re-registered
        (uint256 nodeId2,,) = registerNodeAs(alice, pos, "n1");
        assertEq(nodeId2, 2);
    }

    function test_DeregisterOnlyOperator() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 nodeId,,) = registerNodeAs(alice, pos, "n1");
        vm.prank(bob);
        vm.expectRevert(bytes("NR: not node operator"));
        registry.deregisterNode(nodeId);
        vm.prank(alice);
        registry.deregisterNode(nodeId);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: node not active"));
        registry.deregisterNode(nodeId);
    }

    function test_DeregisterClearsBoost() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 nodeId,,) = registerNodeAs(alice, pos, "n1");
        forceBoost(pos, true);
        assertTrue(staking.getPosition(pos).boosted);
        vm.prank(alice);
        registry.deregisterNode(nodeId);
        assertFalse(staking.getPosition(pos).boosted);
        assertEq(staking.totalUnits(), MIN_VAL * 20);
    }

    // -------------------------------------------------------- Attestation
    function _oneNode() internal returns (uint256 nodeId, uint256 pos) {
        pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        (nodeId,,) = registerNodeAs(alice, pos, "node");
    }

    function test_PostEpochOnlyWatchtower() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        uint256[] memory ids = new uint256[](1);
        uint16[] memory scores = new uint16[](1);
        ids[0] = nodeId;
        scores[0] = 10_000;
        vm.prank(alice);
        vm.expectRevert(bytes("NR: not watchtower"));
        registry.postEpoch(epoch, bytes32(0), ids, scores);
    }

    function test_PostEpochRejectsCurrentEpoch() public {
        (uint256 nodeId,) = _oneNode();
        uint256[] memory ids = new uint256[](1);
        uint16[] memory scores = new uint16[](1);
        ids[0] = nodeId;
        scores[0] = 10_000;
        uint256 cur = registry.currentEpoch();
        vm.prank(watchtower);
        vm.expectRevert(bytes("NR: epoch not over"));
        registry.postEpoch(cur, bytes32(0), ids, scores);
    }

    function test_PostEpochValidation() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        uint256[] memory ids = new uint256[](1);
        uint16[] memory scores = new uint16[](2);
        ids[0] = nodeId;
        vm.prank(watchtower);
        vm.expectRevert(bytes("NR: length mismatch"));
        registry.postEpoch(epoch, bytes32(0), ids, scores);

        uint16[] memory scores1 = new uint16[](1);
        scores1[0] = 10_001;
        vm.prank(watchtower);
        vm.expectRevert(bytes("NR: uptime above 100%"));
        registry.postEpoch(epoch, bytes32(0), ids, scores1);

        uint256[] memory badIds = new uint256[](1);
        badIds[0] = 99;
        scores1[0] = 10_000;
        vm.prank(watchtower);
        vm.expectRevert(bytes("NR: unknown node in epoch"));
        registry.postEpoch(epoch, bytes32(0), badIds, scores1);
    }

    function test_PostEpochTwiceReverts() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        uint256[] memory ids = new uint256[](1);
        uint16[] memory scores = new uint16[](1);
        ids[0] = nodeId;
        scores[0] = 9_000;
        vm.prank(watchtower);
        vm.expectRevert(bytes("NR: epoch already posted"));
        registry.postEpoch(epoch, bytes32(0), ids, scores);
    }

    function test_FinalizeRespectsDisputeWindow() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        vm.expectRevert(bytes("NR: dispute window open"));
        registry.finalizeEpoch(epoch);
        skip(DISPUTE - 1);
        vm.expectRevert(bytes("NR: dispute window open"));
        registry.finalizeEpoch(epoch);
        skip(1);
        registry.finalizeEpoch(epoch); // anyone may finalize
        assertEq(registry.latestFinalizedEpoch(), epoch);
        assertTrue(registry.hasFinalizedEpoch());
        assertEq(registry.nodeScore(nodeId, epoch), 10_000);
    }

    function test_FinalizeTwiceReverts() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch);
        vm.expectRevert(bytes("NR: epoch already finalized"));
        registry.finalizeEpoch(epoch);
    }

    function test_FinalizeUnpostedReverts() public {
        vm.expectRevert(bytes("NR: epoch not posted"));
        registry.finalizeEpoch(1);
    }

    function test_VoidEpochAndRepost() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: not owner"));
        registry.voidEpoch(epoch);
        vm.prank(msig);
        registry.voidEpoch(epoch);
        skip(DISPUTE);
        vm.expectRevert(bytes("NR: epoch voided"));
        registry.finalizeEpoch(epoch);
        // watchtower may re-post the corrected epoch
        postEpochFor(epoch, nodeId, 9_600);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch);
        assertEq(registry.nodeScore(nodeId, epoch), 9_600);
    }

    function test_VoidAfterFinalizeReverts() public {
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch);
        vm.prank(msig);
        vm.expectRevert(bytes("NR: epoch already finalized"));
        registry.voidEpoch(epoch);
    }

    function test_FinalizeAppliesBoostAt95pct() public {
        (uint256 nodeId, uint256 pos) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 9_500); // exactly the threshold
        skip(DISPUTE);
        registry.finalizeEpoch(epoch);
        assertTrue(staking.getPosition(pos).boosted);
        assertEq(staking.totalUnits(), MIN_VAL * 30);
        NodeRegistry.Node memory n = registry.getNode(nodeId);
        assertEq(n.lastUptimeBps, 9_500);
        assertEq(n.lastSeen, (epoch + 1) * EPOCH);

        // next epoch below threshold removes the boost
        uint256 epoch2 = registry.currentEpoch() - 1;
        postEpochFor(epoch2, nodeId, 9_499);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch2);
        assertFalse(staking.getPosition(pos).boosted);
        assertEq(staking.totalUnits(), MIN_VAL * 20);
    }

    function test_FinalizeSkipsDeregisteredNode() public {
        (uint256 nodeId, uint256 pos) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        vm.prank(alice);
        registry.deregisterNode(nodeId);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch); // must not revert
        assertEq(registry.nodeScore(nodeId, epoch), 0); // skipped
        assertFalse(staking.getPosition(pos).boosted);
    }

    function test_FinalizeSurvivesExitedPosition() public {
        (uint256 nodeId, uint256 pos) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 10_000);
        vm.prank(alice);
        staking.emergencyExit(pos); // bond exits during the dispute window
        skip(DISPUTE);
        registry.finalizeEpoch(epoch); // setBoost no-ops; no revert
        assertEq(registry.nodeScore(nodeId, epoch), 10_000);
    }

    function test_BoostChangesRewardRate() public {
        fundPool(100_000 ether);
        (uint256 nodeId, uint256 pos) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        postEpochFor(epoch, nodeId, 9_800);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch);
        uint256 pendingAtBoost = staking.pendingRewards(pos);
        skip(YEAR);
        // one boosted year at 30%/yr on the 25k bond
        assertApproxEqAbs(staking.pendingRewards(pos) - pendingAtBoost, (MIN_VAL * 30) / 100, 1e6);
    }

    // ------------------------------------------------------ Qualification
    /// @dev Post + finalize `count` consecutive perfect epochs for `nodeId`.
    function _attestPerfectEpochs(uint256 nodeId, uint256 count) internal {
        uint256 firstEpoch = registry.currentEpoch() - count;
        for (uint256 i = 0; i < count; i++) {
            postEpochFor(firstEpoch + i, nodeId, 10_000);
        }
        skip(DISPUTE);
        for (uint256 i = 0; i < count; i++) {
            registry.finalizeEpoch(firstEpoch + i);
        }
    }

    function test_QualificationNeedsFullWindow() public {
        (uint256 nodeId,) = _oneNode();
        assertEq(registry.uptimeOver90Epochs(nodeId), 0);
        assertFalse(registry.isQualified(nodeId));
        _attestPerfectEpochs(nodeId, 45); // half the window: 45/90 = 50%
        assertEq(registry.uptimeOver90Epochs(nodeId), 5_000);
        assertFalse(registry.isQualified(nodeId));
    }

    function test_QualificationAt95pctMean() public {
        vm.warp(400 days); // room for 90 past epochs
        (uint256 nodeId,) = _oneNode();
        _attestPerfectEpochs(nodeId, 90);
        assertEq(registry.uptimeOver90Epochs(nodeId), 10_000);
        assertTrue(registry.isQualified(nodeId));
    }

    function test_QualificationFailsBelow95pctMean() public {
        vm.warp(400 days);
        (uint256 nodeId,) = _oneNode();
        // 90 epochs at exactly 9,400 mean -> below the 9,500 bar
        uint256 firstEpoch = registry.currentEpoch() - 90;
        for (uint256 i = 0; i < 90; i++) {
            postEpochFor(firstEpoch + i, nodeId, 9_400);
        }
        skip(DISPUTE);
        for (uint256 i = 0; i < 90; i++) {
            registry.finalizeEpoch(firstEpoch + i);
        }
        assertEq(registry.uptimeOver90Epochs(nodeId), 9_400);
        assertFalse(registry.isQualified(nodeId));
    }

    function test_QualificationDropsWhenBondExits() public {
        vm.warp(400 days);
        (uint256 nodeId, uint256 pos) = _oneNode();
        _attestPerfectEpochs(nodeId, 90);
        assertTrue(registry.isQualified(nodeId));
        vm.roll(staking.VALIDATOR_LOCK_BLOCK());
        vm.prank(alice);
        staking.requestUnstake(pos);
        assertFalse(registry.isQualified(nodeId)); // bond in cooldown
    }

    // ------------------------------------------------------ getValidators
    function test_GetValidatorsEmptyByDefault() public view {
        (address[] memory cons, uint256[] memory bonds) = registry.getValidators();
        assertEq(cons.length, 0);
        assertEq(bonds.length, 0);
    }

    function test_GetValidatorsRanksByBondAndCapsAt21() public {
        vm.warp(600 days);
        uint256 n = 25;
        uint256[] memory nodeIds = new uint256[](n);
        address[] memory consAddrs = new address[](n);
        // 25 operators with strictly increasing bonds: 25k, 26k, ..., 49k
        for (uint256 i = 0; i < n; i++) {
            address op = makeAddr(string.concat("op", vm.toString(i)));
            uint256 pos = stakeAs(op, FMXStaking.Tier.Validator, MIN_VAL + i * 1_000 ether);
            (uint256 id,, address cons) = registerNodeAs(op, pos, string.concat("valnode", vm.toString(i)));
            nodeIds[i] = id;
            consAddrs[i] = cons;
        }
        // one perfect 90-epoch window for all of them
        uint256 firstEpoch = registry.currentEpoch() - 90;
        for (uint256 e = 0; e < 90; e++) {
            uint16[] memory scores = new uint16[](n);
            for (uint256 i = 0; i < n; i++) {
                scores[i] = 10_000;
            }
            vm.prank(watchtower);
            registry.postEpoch(firstEpoch + e, keccak256(abi.encode(e)), nodeIds, scores);
        }
        skip(DISPUTE);
        for (uint256 e = 0; e < 90; e++) {
            registry.finalizeEpoch(firstEpoch + e);
        }

        (address[] memory cons, uint256[] memory bonds) = registry.getValidators();
        assertEq(cons.length, 21); // capped at MAX_VALIDATORS
        // ranked by bond descending: 49k first, down to 29k (the 21st)
        assertEq(bonds[0], MIN_VAL + 24_000 ether);
        assertEq(cons[0], consAddrs[24]);
        assertEq(bonds[20], MIN_VAL + 4_000 ether);
        assertEq(cons[20], consAddrs[4]);
        for (uint256 i = 1; i < 21; i++) {
            assertLe(bonds[i], bonds[i - 1]);
        }
    }

    function test_GetValidatorsTieBreaksByLowerNodeId() public {
        vm.warp(600 days);
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL); // equal bonds
        (uint256 n1,, address c1) = registerNodeAs(alice, p1, "tie-a");
        (uint256 n2,,) = registerNodeAs(bob, p2, "tie-b");
        uint256 firstEpoch = registry.currentEpoch() - 90;
        for (uint256 e = 0; e < 90; e++) {
            uint256[] memory ids = new uint256[](2);
            uint16[] memory scores = new uint16[](2);
            ids[0] = n1;
            ids[1] = n2;
            scores[0] = 10_000;
            scores[1] = 10_000;
            vm.prank(watchtower);
            registry.postEpoch(firstEpoch + e, bytes32(0), ids, scores);
        }
        skip(DISPUTE);
        for (uint256 e = 0; e < 90; e++) {
            registry.finalizeEpoch(firstEpoch + e);
        }
        (address[] memory cons,) = registry.getValidators();
        assertEq(cons.length, 2);
        assertEq(cons[0], c1); // node 1 first on the tie
    }

    // ----------------------------------------------------------- Slashing
    function _armSlashing() internal returns (address sink) {
        sink = makeAddr("systemRewards");
        vm.startPrank(msig);
        registry.queueSetSlashingAdjudicator(carol);
        registry.queueSetSlashSink(sink);
        vm.stopPrank();
        skip(TIMELOCK);
        vm.startPrank(msig);
        registry.applySetSlashingAdjudicator(carol);
        registry.applySetSlashSink(sink);
        vm.stopPrank();
    }

    function test_SlashRequiresAdjudicator() public {
        (uint256 nodeId,) = _oneNode();
        vm.prank(msig);
        vm.expectRevert(bytes("NR: not adjudicator"));
        registry.slash(nodeId, hex"");
    }

    function test_SlashInertPreFork() public {
        (uint256 nodeId,) = _oneNode();
        _armSlashing();
        vm.roll(staking.FORK_BLOCK() - 1);
        vm.prank(carol);
        vm.expectRevert(bytes("STK: slashing inert pre-fork"));
        // non-empty evidence: the registry's own evidence gate sits before the
        // vault call, and this test is about the vault's fork guard
        registry.slash(nodeId, hex"aa");
    }

    function test_SlashPostForkTakes5pctToSink() public {
        (uint256 nodeId, uint256 pos) = _oneNode();
        address sink = _armSlashing();
        vm.roll(staking.FORK_BLOCK());
        vm.prank(carol);
        uint256 slashed = registry.slash(nodeId, hex"deadbeef");
        assertEq(slashed, (MIN_VAL * 500) / 10_000);
        assertEq(sink.balance, slashed);
        assertEq(staking.getPosition(pos).amount, MIN_VAL - slashed);
        // bond now below the minimum: node drops out of roster + validator set
        assertFalse(registry.isQualified(nodeId));
        assertEq(registry.listActiveNodes().length, 0);
    }

    function test_AdjudicatorAndSinkAreTimelocked() public {
        vm.prank(msig);
        registry.queueSetSlashingAdjudicator(carol);
        vm.prank(msig);
        vm.expectRevert(bytes("NR: timelock not elapsed"));
        registry.applySetSlashingAdjudicator(carol);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: not owner"));
        registry.queueSetSlashSink(alice);
    }

    // ----------------------------------------------------- Governance/misc
    function test_WatchtowerRotationImmediate() public {
        address newTower = makeAddr("tower2");
        vm.prank(alice);
        vm.expectRevert(bytes("NR: not owner"));
        registry.setWatchtower(newTower);
        vm.prank(msig);
        registry.setWatchtower(newTower);
        assertEq(registry.watchtower(), newTower);
        // old key is dead
        (uint256 nodeId,) = _oneNode();
        uint256 epoch = registry.currentEpoch() - 1;
        uint256[] memory ids = new uint256[](1);
        uint16[] memory scores = new uint16[](1);
        ids[0] = nodeId;
        scores[0] = 10_000;
        vm.prank(watchtower);
        vm.expectRevert(bytes("NR: not watchtower"));
        registry.postEpoch(epoch, bytes32(0), ids, scores);
    }

    function test_OwnerTransferTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(msig);
        registry.transferOwner(newOwner);
        vm.prank(alice);
        vm.expectRevert(bytes("NR: not pending owner"));
        registry.acceptOwner();
        vm.prank(newOwner);
        registry.acceptOwner();
        assertEq(registry.owner(), newOwner);
    }

    function test_ConstructorGuards() public {
        vm.expectRevert(bytes("NR: zero staking"));
        new NodeRegistry(address(0), msig, watchtower);
        vm.expectRevert(bytes("NR: zero owner"));
        new NodeRegistry(address(staking), address(0), watchtower);
        vm.expectRevert(bytes("NR: zero watchtower"));
        new NodeRegistry(address(staking), msig, address(0));
        assertEq(registry.minBond(), staking.MIN_VALIDATOR_STAKE());
    }

    // -------------------------------------------------------------- Roster
    function test_ListActiveNodesRoster() public {
        fundPool(1_000 ether);
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(bob, FMXStaking.Tier.Validator, 2 * MIN_VAL);
        uint256 p3 = stakeAs(carol, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 n1,,) = registerNodeAs(alice, p1, "r1");
        (uint256 n2,,) = registerNodeAs(bob, p2, "r2");
        (uint256 n3,,) = registerNodeAs(carol, p3, "r3");

        // n1 gets attested + boosted; n3 deregisters; a 4th never registers
        uint256 epoch = registry.currentEpoch() - 1;
        uint256[] memory ids = new uint256[](2);
        uint16[] memory scores = new uint16[](2);
        ids[0] = n1;
        ids[1] = n2;
        scores[0] = 9_900;
        scores[1] = 5_000;
        vm.prank(watchtower);
        registry.postEpoch(epoch, bytes32(0), ids, scores);
        skip(DISPUTE);
        registry.finalizeEpoch(epoch);
        vm.prank(carol);
        registry.deregisterNode(n3);

        NodeRegistry.NodeView[] memory roster = registry.listActiveNodes();
        assertEq(roster.length, 2);
        assertEq(roster[0].nodeId, n1);
        assertEq(roster[0].operator, alice);
        assertEq(roster[0].stake, MIN_VAL);
        assertTrue(roster[0].boosted);
        assertEq(roster[0].lastUptimeBps, 9_900);
        assertEq(roster[0].lastSeen, (epoch + 1) * EPOCH);
        assertEq(roster[1].nodeId, n2);
        assertEq(roster[1].stake, 2 * MIN_VAL);
        assertFalse(roster[1].boosted);

        // an exited bond drops off the roster
        vm.prank(bob);
        staking.emergencyExit(p2);
        assertEq(registry.listActiveNodes().length, 1);
    }

    function test_GetNodeGuards() public {
        vm.expectRevert(bytes("NR: no such node"));
        registry.getNode(0);
        vm.expectRevert(bytes("NR: no such node"));
        registry.getNode(1);
    }
}
