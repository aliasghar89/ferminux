// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {IdentityRegistry8004} from "../src/erc8004/IdentityRegistry8004.sol";
import {ReputationRegistry8004} from "../src/erc8004/ReputationRegistry8004.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

contract ReputationRegistry8004Test is BaseTest {
    IdentityRegistry8004 internal id8004;
    ReputationRegistry8004 internal rep;
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        id8004 = new IdentityRegistry8004(registry);
        rep = new ReputationRegistry8004(id8004, escrow);
        agentId = _registerAlice();
    }

    function _give(address from, int128 value, uint8 dec, string memory t1, string memory t2) internal returns (uint64) {
        vm.prank(from);
        rep.giveFeedback(agentId, value, dec, t1, t2, "https://ep", "fmx://payload/0xfb", keccak256("fb"));
        return rep.getLastIndex(agentId, from);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    // ───────────────────────────── deploy ─────────────────────────────

    function test_deployState() public view {
        assertEq(rep.getIdentityRegistry(), address(id8004));
        assertEq(address(rep.escrow()), address(escrow));
        assertEq(rep.getVersion(), "ferminux-2.0.0");
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(ReputationRegistry8004.ZeroAddress.selector);
        new ReputationRegistry8004(IdentityRegistry8004(address(0)), escrow);
        vm.expectRevert(ReputationRegistry8004.ZeroAddress.selector);
        new ReputationRegistry8004(id8004, ServiceEscrow(address(0)));
    }

    // ───────────────────────────── giveFeedback ─────────────────────────────

    function test_giveFeedback_happyPath() public {
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit ReputationRegistry8004.NewFeedback(
            agentId, bob, 1, 85, 0, "quality", "quality", "fast", "https://ep", "fmx://payload/0xfb", keccak256("fb")
        );
        rep.giveFeedback(agentId, 85, 0, "quality", "fast", "https://ep", "fmx://payload/0xfb", keccak256("fb"));
        assertEq(rep.getLastIndex(agentId, bob), 1);
        (int128 v, uint8 d, string memory t1, string memory t2, bool revoked) = rep.readFeedback(agentId, bob, 1);
        assertEq(v, 85);
        assertEq(d, 0);
        assertEq(t1, "quality");
        assertEq(t2, "fast");
        assertFalse(revoked);
        assertEq(rep.getClients(agentId).length, 1);
        assertEq(rep.getClients(agentId)[0], bob);
        _give(bob, 90, 0, "quality", "");
        assertEq(rep.getLastIndex(agentId, bob), 2);
        assertEq(rep.getClients(agentId).length, 1); // still one unique client
    }

    function test_giveFeedback_selfRejected() public {
        vm.prank(alice);
        vm.expectRevert(ReputationRegistry8004.SelfFeedback.selector);
        rep.giveFeedback(agentId, 100, 0, "", "", "", "", bytes32(0));
        // after ownership transfer the old owner may rate, the new one may not
        vm.prank(alice);
        registry.transferOwnership(agentId, bob);
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry8004.SelfFeedback.selector);
        rep.giveFeedback(agentId, 100, 0, "", "", "", "", bytes32(0));
        _give(alice, 100, 0, "", "");
        assertEq(rep.getLastIndex(agentId, alice), 1);
    }

    function test_giveFeedback_validation() public {
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry8004.TooManyDecimals.selector);
        rep.giveFeedback(agentId, 1, 19, "", "", "", "", bytes32(0));
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry8004.ValueTooLarge.selector);
        rep.giveFeedback(agentId, int128(1e38) + 1, 0, "", "", "", "", bytes32(0));
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry8004.ValueTooLarge.selector);
        rep.giveFeedback(agentId, -int128(1e38) - 1, 0, "", "", "", "", bytes32(0));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 77));
        rep.giveFeedback(77, 1, 0, "", "", "", "", bytes32(0));
    }

    // ───────────────────────────── revoke / respond ─────────────────────────────

    function test_revokeFeedback() public {
        uint64 idx = _give(bob, 50, 0, "", "");
        vm.prank(carol);
        vm.expectRevert(ReputationRegistry8004.IndexOutOfBounds.selector); // carol has no feedback
        rep.revokeFeedback(agentId, idx);
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry8004.IndexOutOfBounds.selector);
        rep.revokeFeedback(agentId, 0);
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit ReputationRegistry8004.FeedbackRevoked(agentId, bob, idx);
        rep.revokeFeedback(agentId, idx);
        (,,,, bool revoked) = rep.readFeedback(agentId, bob, idx);
        assertTrue(revoked);
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry8004.AlreadyRevoked.selector);
        rep.revokeFeedback(agentId, idx);
        (uint64 count,,) = rep.getSummary(agentId, _one(bob), "", "");
        assertEq(count, 0);
    }

    function test_appendResponse() public {
        uint64 idx = _give(bob, 50, 0, "", "");
        vm.prank(alice);
        vm.expectRevert(ReputationRegistry8004.EmptyURI.selector);
        rep.appendResponse(agentId, bob, idx, "", bytes32(0));
        vm.prank(alice);
        vm.expectRevert(ReputationRegistry8004.IndexOutOfBounds.selector);
        rep.appendResponse(agentId, bob, 2, "u", bytes32(0));
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit ReputationRegistry8004.ResponseAppended(agentId, bob, idx, alice, "fmx://payload/0xr", keccak256("r"));
        rep.appendResponse(agentId, bob, idx, "fmx://payload/0xr", keccak256("r"));
        vm.prank(alice);
        rep.appendResponse(agentId, bob, idx, "fmx://payload/0xr2", keccak256("r2"));
        vm.prank(carol);
        rep.appendResponse(agentId, bob, idx, "fmx://payload/0xr3", keccak256("r3"));
        address[] memory none;
        assertEq(rep.getResponseCount(agentId, bob, idx, none), 3);
        assertEq(rep.getResponseCount(agentId, bob, idx, _one(alice)), 2);
        assertEq(rep.getResponseCount(agentId, bob, 0, none), 3);
        assertEq(rep.getResponseCount(agentId, address(0), 0, none), 3);
        assertEq(rep.getResponseCount(agentId, address(0), 0, _one(carol)), 1);
    }

    // ───────────────────────────── reads ─────────────────────────────

    function test_readFeedback_bounds() public {
        vm.expectRevert(ReputationRegistry8004.IndexOutOfBounds.selector);
        rep.readFeedback(agentId, bob, 1);
        _give(bob, 1, 0, "", "");
        vm.expectRevert(ReputationRegistry8004.IndexOutOfBounds.selector);
        rep.readFeedback(agentId, bob, 0);
        vm.expectRevert(ReputationRegistry8004.IndexOutOfBounds.selector);
        rep.readFeedback(agentId, bob, 2);
    }

    function test_getSummary_averageAndTagFilters() public {
        _give(bob, 80, 0, "quality", "a");
        _give(bob, 100, 0, "quality", "b");
        _give(carol, 60, 0, "speed", "a");
        address[] memory both = new address[](2);
        both[0] = bob;
        both[1] = carol;
        (uint64 count, int128 v, uint8 d) = rep.getSummary(agentId, both, "", "");
        assertEq(count, 3);
        assertEq(v, 80);
        assertEq(d, 0);
        (count, v,) = rep.getSummary(agentId, both, "quality", "");
        assertEq(count, 2);
        assertEq(v, 90);
        (count, v,) = rep.getSummary(agentId, both, "", "a");
        assertEq(count, 2);
        assertEq(v, 70);
        (count, v,) = rep.getSummary(agentId, both, "speed", "b");
        assertEq(count, 0);
        assertEq(v, 0);
        address[] memory none;
        vm.expectRevert(ReputationRegistry8004.ClientAddressesRequired.selector);
        rep.getSummary(agentId, none, "", "");
    }

    function test_getSummary_mixedDecimalsUsesMode() public {
        _give(bob, 45, 1, "", ""); // 4.5
        _give(bob, 35, 1, "", ""); // 3.5
        _give(carol, 4, 0, "", ""); // 4
        address[] memory both = new address[](2);
        both[0] = bob;
        both[1] = carol;
        (uint64 count, int128 v, uint8 d) = rep.getSummary(agentId, both, "", "");
        assertEq(count, 3);
        assertEq(d, 1); // mode = 1 decimal
        assertEq(v, 40); // avg 4.0
    }

    function test_getSummary_negativeValues() public {
        _give(bob, -10, 0, "", "");
        _give(carol, 4, 0, "", "");
        address[] memory both = new address[](2);
        both[0] = bob;
        both[1] = carol;
        (, int128 v,) = rep.getSummary(agentId, both, "", "");
        assertEq(v, -3);
    }

    function test_readAllFeedback() public {
        uint64 i1 = _give(bob, 1, 0, "x", "");
        _give(bob, 2, 0, "y", "");
        _give(carol, 3, 0, "x", "z");
        vm.prank(bob);
        rep.revokeFeedback(agentId, i1);
        address[] memory none;
        (address[] memory clients, uint64[] memory idxs, int128[] memory values,,, string[] memory t2s, bool[] memory rv) =
            rep.readAllFeedback(agentId, none, "", "", false);
        assertEq(clients.length, 2);
        assertEq(clients[0], bob);
        assertEq(idxs[0], 2);
        assertEq(values[0], 2);
        assertEq(clients[1], carol);
        assertEq(t2s[1], "z");
        assertFalse(rv[0]);
        (clients,, values,,,, rv) = rep.readAllFeedback(agentId, none, "", "", true);
        assertEq(clients.length, 3);
        assertTrue(rv[0]);
        (clients,,,,,,) = rep.readAllFeedback(agentId, none, "x", "", true);
        assertEq(clients.length, 2);
        (clients,,,,,,) = rep.readAllFeedback(agentId, _one(carol), "x", "z", false);
        assertEq(clients.length, 1);
        (clients,,,,,,) = rep.readAllFeedback(agentId, _one(carol), "x", "nope", false);
        assertEq(clients.length, 0);
    }

    // ───────────────────────────── syncFromEscrow ─────────────────────────────

    function test_syncFromEscrow_completedOncePerJob() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 5);
        vm.prank(carol); // anyone
        vm.expectEmit(true, true, true, true);
        emit ReputationRegistry8004.NewFeedback(
            agentId, bob, 1, 1, 0, "escrow", "escrow", "completed", "", "fmx://payload/0xout", keccak256("out")
        );
        vm.expectEmit(true, true, true, true);
        emit ReputationRegistry8004.EscrowSynced(jobId, agentId, bob, 1, 1);
        uint64 idx = rep.syncFromEscrow(jobId);
        assertEq(idx, 1);
        assertTrue(rep.syncedJob(jobId));
        (int128 v, uint8 d, string memory t1, string memory t2,) = rep.readFeedback(agentId, bob, 1);
        assertEq(v, 1);
        assertEq(d, 0);
        assertEq(t1, "escrow");
        assertEq(t2, "completed");
        assertEq(rep.getClients(agentId)[0], bob);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry8004.AlreadySynced.selector, jobId));
        rep.syncFromEscrow(jobId);
        assertEq(rep.getLastIndex(agentId, bob), 1);
    }

    function test_syncFromEscrow_claimedAndRefunded() public {
        uint256 j1 = _request(agentId, bob, PRICE);
        _deliver(j1, alice);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        escrow.claim(j1);
        uint256 j2 = _request(agentId, bob, PRICE);
        vm.prank(alice);
        escrow.cancel(j2);
        rep.syncFromEscrow(j1);
        rep.syncFromEscrow(j2);
        (int128 v,,, string memory t2,) = rep.readFeedback(agentId, bob, 2);
        assertEq(v, 0);
        assertEq(t2, "refunded");
        (uint64 count, int128 avg, uint8 d) = rep.getSummary(agentId, _one(bob), "escrow", "");
        assertEq(count, 2);
        assertEq(avg, 0); // (1 + 0) / 2 floored at 0 decimals
        assertEq(d, 0);
        (count,,) = rep.getSummary(agentId, _one(bob), "escrow", "completed");
        assertEq(count, 1);
    }

    function test_syncFromEscrow_notSyncableStatuses() public {
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry8004.JobNotSyncable.selector, ServiceEscrow.JobStatus.None));
        rep.syncFromEscrow(99);
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry8004.JobNotSyncable.selector, ServiceEscrow.JobStatus.Open));
        rep.syncFromEscrow(jobId);
        _deliver(jobId, alice);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry8004.JobNotSyncable.selector, ServiceEscrow.JobStatus.Delivered));
        rep.syncFromEscrow(jobId);
        vm.prank(bob);
        escrow.dispute(jobId);
        vm.prank(gov);
        escrow.resolve(jobId, 5000);
        vm.expectRevert(abi.encodeWithSelector(ReputationRegistry8004.JobNotSyncable.selector, ServiceEscrow.JobStatus.Resolved));
        rep.syncFromEscrow(jobId);
    }

    function test_syncFromEscrow_clientMayRevokeImportedEntry() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 4);
        uint64 idx = rep.syncFromEscrow(jobId);
        vm.prank(bob);
        rep.revokeFeedback(agentId, idx);
        (,,,, bool revoked) = rep.readFeedback(agentId, bob, idx);
        assertTrue(revoked);
    }
}
