// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, Reenterer, Rejecter} from "./Base.t.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

contract ServiceEscrowTest is BaseTest {
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        agentId = _registerAlice();
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return (amount * escrow.feeBps()) / 10000;
    }

    // ───────────────────────────── deployment ─────────────────────────────

    function test_deployState() public view {
        assertEq(address(escrow.registry()), address(registry));
        assertEq(escrow.governance(), gov);
        assertEq(escrow.feeRecipient(), treasury);
        assertEq(escrow.feeBps(), 250);
        assertEq(escrow.deliveryWindow(), 1 days);
        assertEq(escrow.reviewWindow(), 1 days);
        assertEq(escrow.nextJobId(), 0);
    }

    function test_constructor_revertsZeroArgs() public {
        vm.expectRevert(ServiceEscrow.ZeroAddress.selector);
        new ServiceEscrow(AgentRegistry(address(0)), gov, treasury);
        vm.expectRevert(ServiceEscrow.ZeroAddress.selector);
        new ServiceEscrow(registry, address(0), treasury);
        vm.expectRevert(ServiceEscrow.ZeroAddress.selector);
        new ServiceEscrow(registry, gov, address(0));
    }

    // ───────────────────────────── requestJob ─────────────────────────────

    function test_requestJob_happyPath() public {
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit ServiceEscrow.JobRequested(1, agentId, bob, PRICE, keccak256("in"), "fmx://payload/0xin");
        uint256 jobId = escrow.requestJob{value: PRICE}(agentId, keccak256("in"), "fmx://payload/0xin");
        assertEq(jobId, 1);
        assertEq(escrow.nextJobId(), 1);
        ServiceEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(j.agentId, agentId);
        assertEq(j.client, bob);
        assertEq(j.amount, PRICE);
        assertEq(j.inputHash, keccak256("in"));
        assertEq(j.inputURI, "fmx://payload/0xin");
        assertEq(j.outputHash, bytes32(0));
        assertEq(j.createdAt, uint64(block.timestamp));
        assertEq(j.deliveredAt, 0);
        assertEq(uint8(j.status), uint8(ServiceEscrow.JobStatus.Open));
        assertEq(address(escrow).balance, PRICE);
    }

    function test_requestJob_overpaymentAccepted() public {
        uint256 jobId = _request(agentId, bob, 3 ether);
        assertEq(escrow.getJob(jobId).amount, 3 ether);
    }

    function test_requestJob_revertsUnderpayment() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.InsufficientPayment.selector, PRICE - 1, PRICE));
        escrow.requestJob{value: PRICE - 1}(agentId, keccak256("in"), "");
    }

    function test_requestJob_revertsOwnAgent() public {
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.CannotHireOwnAgent.selector);
        escrow.requestJob{value: PRICE}(agentId, keccak256("in"), "");
    }

    function test_requestJob_revertsInactiveAgent_paused() public {
        vm.prank(alice);
        registry.setStatus(agentId, AgentRegistry.Status.Paused);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.AgentNotActive.selector, agentId));
        escrow.requestJob{value: PRICE}(agentId, keccak256("in"), "");
    }

    function test_requestJob_revertsInactiveAgent_retired() public {
        vm.prank(alice);
        registry.retire(agentId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.AgentNotActive.selector, agentId));
        escrow.requestJob{value: PRICE}(agentId, keccak256("in"), "");
    }

    function test_requestJob_revertsInactiveAgent_underBonded() public {
        vm.prank(gov);
        registry.slash(agentId, 1, treasury, "tiny");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.AgentNotActive.selector, agentId));
        escrow.requestJob{value: PRICE}(agentId, keccak256("in"), "");
    }

    function test_requestJob_revertsUnknownAgent() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.AgentNotActive.selector, 99));
        escrow.requestJob{value: PRICE}(99, keccak256("in"), "");
    }

    function test_requestJob_revertsLongURI() public {
        string memory s257 = string(new bytes(257));
        vm.prank(bob);
        vm.expectRevert(ServiceEscrow.StringTooLong.selector);
        escrow.requestJob{value: PRICE}(agentId, keccak256("in"), s257);
    }

    // ───────────────────────────── deliver ─────────────────────────────

    function test_deliver_happyPath() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.warp(block.timestamp + 100);
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobDelivered(jobId, keccak256("out"), "fmx://payload/0xout");
        escrow.deliver(jobId, keccak256("out"), "fmx://payload/0xout");
        ServiceEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(j.outputHash, keccak256("out"));
        assertEq(j.outputURI, "fmx://payload/0xout");
        assertEq(j.deliveredAt, uint64(block.timestamp));
        assertEq(uint8(j.status), uint8(ServiceEscrow.JobStatus.Delivered));
    }

    function test_deliver_onlyAgentOwner() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(bob);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.deliver(jobId, keccak256("out"), "");
        vm.prank(carol);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.deliver(jobId, keccak256("out"), "");
    }

    function test_deliver_byNewOwnerAfterTransfer() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(alice);
        registry.transferOwnership(agentId, carol);
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.deliver(jobId, keccak256("out"), "");
        _deliver(jobId, carol);
        // payout goes to the current owner
        vm.prank(bob);
        escrow.release(jobId, 5);
        assertEq(escrow.credits(carol), PRICE - _fee(PRICE));
        assertEq(escrow.credits(alice), 0);
    }

    function test_deliver_twiceReverts() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Delivered));
        escrow.deliver(jobId, keccak256("out2"), "");
    }

    function test_deliver_unknownJobReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.None));
        escrow.deliver(42, keccak256("out"), "");
    }

    function test_deliver_stillAllowedAfterWindowIfNotRefunded() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.warp(block.timestamp + 3 days);
        _deliver(jobId, alice);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Delivered));
    }

    // ───────────────────────────── release ─────────────────────────────

    function test_release_withRating_fullLifecycle() public {
        uint256 amount = 2 ether;
        uint256 jobId = _request(agentId, bob, amount);
        _deliver(jobId, alice);
        uint256 fee = _fee(amount);

        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobCompleted(jobId, amount - fee, fee, 5);
        escrow.release(jobId, 5);

        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Completed));
        assertEq(escrow.credits(alice), amount - fee);
        assertEq(escrow.credits(treasury), fee);
        assertEq(escrow.credits(bob), 0);
        assertEq(fee, 0.05 ether); // 2.5 % of 2 FMX

        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        assertEq(a.jobsCompleted, 1);
        assertEq(a.jobsFailed, 0);
        assertEq(a.ratingCount, 1);
        assertEq(a.ratingSum, 5);

        // withdraw both
        uint256 aBefore = alice.balance;
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.Withdrawn(alice, amount - fee);
        escrow.withdraw();
        assertEq(alice.balance - aBefore, amount - fee);
        assertEq(escrow.credits(alice), 0);

        vm.prank(treasury);
        escrow.withdraw();
        assertEq(treasury.balance, fee);
        assertEq(address(escrow).balance, 0);
    }

    function test_release_unrated() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 0);
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        assertEq(a.jobsCompleted, 1);
        assertEq(a.ratingCount, 0);
        assertEq(a.ratingSum, 0);
    }

    function test_release_invalidRating() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(bob);
        vm.expectRevert(ServiceEscrow.InvalidRating.selector);
        escrow.release(jobId, 6);
    }

    function test_release_clientOnly() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotClient.selector);
        escrow.release(jobId, 5);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.NotClient.selector);
        escrow.release(jobId, 5);
    }

    function test_release_requiresDelivered() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Open));
        escrow.release(jobId, 5);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 4);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Completed));
        escrow.release(jobId, 4); // cannot double-pay
    }

    function test_release_allowedAfterReviewWindowIfNotClaimed() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.warp(block.timestamp + 10 days);
        vm.prank(bob);
        escrow.release(jobId, 3);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Completed));
    }

    // ───────────────────────────── claim ─────────────────────────────

    function test_claim_afterReviewWindow() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        uint64 deliveredAt = escrow.getJob(jobId).deliveredAt;

        vm.warp(deliveredAt + 1 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.TooEarly.selector, deliveredAt + 1 days));
        escrow.claim(jobId);

        vm.warp(deliveredAt + 1 days);
        uint256 fee = _fee(PRICE);
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobCompleted(jobId, PRICE - fee, fee, 0);
        escrow.claim(jobId);
        assertEq(escrow.credits(alice), PRICE - _fee(PRICE));
        assertEq(escrow.credits(treasury), _fee(PRICE));
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        assertEq(a.jobsCompleted, 1);
        assertEq(a.ratingCount, 0);
    }

    function test_claim_agentOwnerOnly() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.warp(block.timestamp + 2 days);
        vm.prank(bob);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.claim(jobId);
    }

    function test_claim_requiresDelivered() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Open));
        escrow.claim(jobId);
    }

    // ───────────────────────────── refund ─────────────────────────────

    function test_refund_afterDeliveryWindow() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        uint64 createdAt = escrow.getJob(jobId).createdAt;

        vm.warp(createdAt + 1 days - 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.TooEarly.selector, createdAt + 1 days));
        escrow.refund(jobId);

        vm.warp(createdAt + 1 days);
        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobRefunded(jobId, PRICE, false);
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Refunded));
        assertEq(escrow.credits(bob), PRICE);
        assertEq(escrow.credits(alice), 0);
        assertEq(escrow.credits(treasury), 0); // no fee on refund
        assertEq(registry.getAgent(agentId).jobsFailed, 1);

        // agent can no longer deliver
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Refunded));
        escrow.deliver(jobId, keccak256("late"), "");

        uint256 before = bob.balance;
        vm.prank(bob);
        escrow.withdraw();
        assertEq(bob.balance - before, PRICE);
    }

    function test_refund_clientOnly() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.warp(block.timestamp + 2 days);
        vm.prank(carol);
        vm.expectRevert(ServiceEscrow.NotClient.selector);
        escrow.refund(jobId);
    }

    function test_refund_revertsAfterDelivery() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.warp(block.timestamp + 2 days);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Delivered));
        escrow.refund(jobId);
    }

    // ───────────────────────────── cancel ─────────────────────────────

    function test_cancel_byAgentWhileOpen() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobRefunded(jobId, PRICE, true);
        escrow.cancel(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Refunded));
        assertEq(escrow.credits(bob), PRICE);
        assertEq(registry.getAgent(agentId).jobsFailed, 1);
    }

    function test_cancel_accessAndStatus() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(bob);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.cancel(jobId);
        _deliver(jobId, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Delivered));
        escrow.cancel(jobId);
    }

    // ───────────────────────────── dispute / resolve ─────────────────────────────

    function test_dispute_withinReviewWindow() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        uint64 deliveredAt = escrow.getJob(jobId).deliveredAt;
        vm.warp(deliveredAt + 1 days - 1);
        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobDisputed(jobId);
        escrow.dispute(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Disputed));

        // agent cannot claim a disputed job
        vm.warp(deliveredAt + 2 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Disputed));
        escrow.claim(jobId);
        // client cannot release a disputed job
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Disputed));
        escrow.release(jobId, 1);
    }

    function test_dispute_tooLate() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        uint64 deliveredAt = escrow.getJob(jobId).deliveredAt;
        vm.warp(deliveredAt + 1 days);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.TooLate.selector, deliveredAt + 1 days));
        escrow.dispute(jobId);
    }

    function test_dispute_clientOnlyAndDeliveredOnly() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Open));
        escrow.dispute(jobId);
        _deliver(jobId, alice);
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotClient.selector);
        escrow.dispute(jobId);
    }

    function _disputed(uint256 amount) internal returns (uint256 jobId) {
        jobId = _request(agentId, bob, amount);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.dispute(jobId);
    }

    function test_resolve_governanceOnly() public {
        uint256 jobId = _disputed(PRICE);
        vm.prank(bob);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.resolve(jobId, 5000);
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.resolve(jobId, 5000);
    }

    function test_resolve_0bps_agentWins() public {
        uint256 amount = 4 ether;
        uint256 jobId = _disputed(amount);
        uint256 fee = _fee(amount);
        vm.prank(gov);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobResolved(jobId, 0, amount - fee, fee);
        escrow.resolve(jobId, 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Resolved));
        assertEq(escrow.credits(bob), 0);
        assertEq(escrow.credits(alice), amount - fee);
        assertEq(escrow.credits(treasury), fee);
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        assertEq(a.jobsCompleted, 1);
        assertEq(a.jobsFailed, 0);
        assertEq(a.ratingCount, 0);
    }

    function test_resolve_5000bps_split_countsAsFailure() public {
        uint256 amount = 4 ether;
        uint256 jobId = _disputed(amount);
        uint256 clientShare = amount / 2;
        uint256 agentGross = amount - clientShare;
        uint256 fee = (agentGross * 250) / 10000;
        vm.prank(gov);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobResolved(jobId, clientShare, agentGross - fee, fee);
        escrow.resolve(jobId, 5000);
        assertEq(escrow.credits(bob), clientShare);
        assertEq(escrow.credits(alice), agentGross - fee);
        assertEq(escrow.credits(treasury), fee);
        assertEq(fee, 0.05 ether);
        // clientBps < 5000 is false -> failure
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        assertEq(a.jobsCompleted, 0);
        assertEq(a.jobsFailed, 1);
    }

    function test_resolve_10000bps_clientWins_noFee() public {
        uint256 amount = 4 ether;
        uint256 jobId = _disputed(amount);
        vm.prank(gov);
        vm.expectEmit(true, false, false, true);
        emit ServiceEscrow.JobResolved(jobId, amount, 0, 0);
        escrow.resolve(jobId, 10000);
        assertEq(escrow.credits(bob), amount);
        assertEq(escrow.credits(alice), 0);
        assertEq(escrow.credits(treasury), 0);
        assertEq(registry.getAgent(agentId).jobsFailed, 1);
    }

    function test_resolve_4999bps_isSuccess() public {
        uint256 jobId = _disputed(PRICE);
        vm.prank(gov);
        escrow.resolve(jobId, 4999);
        assertEq(registry.getAgent(agentId).jobsCompleted, 1);
        assertEq(registry.getAgent(agentId).jobsFailed, 0);
    }

    function test_resolve_revertsBadBpsOrStatus() public {
        uint256 jobId = _disputed(PRICE);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.InvalidBps.selector);
        escrow.resolve(jobId, 10001);
        vm.prank(gov);
        escrow.resolve(jobId, 2500);
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Resolved));
        escrow.resolve(jobId, 2500); // no double resolve

        uint256 open = _request(agentId, bob, PRICE);
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Open));
        escrow.resolve(open, 0);
    }

    function testFuzz_resolve_conservesValue(uint96 amountRaw, uint16 clientBps, uint16 feeBpsRaw) public {
        uint256 amount = bound(uint256(amountRaw), PRICE, 500 ether);
        clientBps = uint16(bound(uint256(clientBps), 0, 10000));
        uint16 fee = uint16(bound(uint256(feeBpsRaw), 0, 1000));
        vm.prank(gov);
        escrow.setFee(fee);

        uint256 jobId = _disputed(amount);
        vm.prank(gov);
        escrow.resolve(jobId, clientBps);

        uint256 total = escrow.credits(bob) + escrow.credits(alice) + escrow.credits(treasury);
        assertEq(total, amount, "value conserved");
        assertEq(escrow.credits(bob), (amount * clientBps) / 10000);
        assertLe(escrow.credits(treasury), (amount * fee) / 10000);
        assertEq(address(escrow).balance, amount);
    }

    // ───────────────────────────── fee math ─────────────────────────────

    function test_fee_zeroBps() public {
        vm.prank(gov);
        escrow.setFee(0);
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 5);
        assertEq(escrow.credits(alice), PRICE);
        assertEq(escrow.credits(treasury), 0);
    }

    function test_fee_maxBps() public {
        vm.prank(gov);
        escrow.setFee(1000);
        uint256 jobId = _request(agentId, bob, 10 ether);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 5);
        assertEq(escrow.credits(alice), 9 ether);
        assertEq(escrow.credits(treasury), 1 ether);
    }

    function test_fee_roundsDownInAgentFavour() public {
        uint256 jobId = _request(agentId, bob, PRICE + 39); // 39 wei extra -> fee floor
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 5);
        uint256 fee = ((PRICE + 39) * 250) / 10000;
        assertEq(escrow.credits(treasury), fee);
        assertEq(escrow.credits(alice) + fee, PRICE + 39);
    }

    function test_fee_usesRecipientAtPayoutTime() public {
        uint256 jobId = _request(agentId, bob, PRICE);
        _deliver(jobId, alice);
        vm.prank(gov);
        escrow.setFeeRecipient(carol);
        vm.prank(bob);
        escrow.release(jobId, 5);
        assertEq(escrow.credits(carol), _fee(PRICE));
        assertEq(escrow.credits(treasury), 0);
    }

    function testFuzz_releaseConservesValue(uint96 amountRaw, uint16 feeBpsRaw) public {
        uint256 amount = bound(uint256(amountRaw), PRICE, 500 ether);
        uint16 fee = uint16(bound(uint256(feeBpsRaw), 0, 1000));
        vm.prank(gov);
        escrow.setFee(fee);
        uint256 jobId = _request(agentId, bob, amount);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.release(jobId, 4);
        assertEq(escrow.credits(alice) + escrow.credits(treasury), amount);
        assertEq(escrow.credits(treasury), (amount * fee) / 10000);
    }

    // ───────────────────────────── credits / withdraw ─────────────────────────────

    function test_credits_accumulateAcrossJobs() public {
        uint256 j1 = _request(agentId, bob, PRICE);
        uint256 j2 = _request(agentId, carol, 2 ether);
        _deliver(j1, alice);
        _deliver(j2, alice);
        vm.prank(bob);
        escrow.release(j1, 5);
        vm.prank(carol);
        escrow.release(j2, 4);
        assertEq(escrow.credits(alice), 3 ether - _fee(3 ether));
        assertEq(escrow.credits(treasury), _fee(PRICE) + _fee(2 ether));
        assertEq(registry.getAgent(agentId).ratingSum, 9);
        assertEq(registry.getAgent(agentId).ratingCount, 2);
    }

    function test_withdraw_revertsWhenEmpty() public {
        vm.prank(carol);
        vm.expectRevert(ServiceEscrow.NothingToWithdraw.selector);
        escrow.withdraw();
    }

    function test_withdraw_reentrancyBlocked() public {
        Reenterer evil = new Reenterer(escrow, registry);
        uint256 evilAgent = evil.register{value: MIN_BOND}("evil"); // bond funded by this test contract

        // two jobs so the escrow holds more than evil's credit
        uint256 j1 = _request(evilAgent, bob, PRICE);
        _request(agentId, carol, PRICE);
        evil.deliver(j1);
        vm.prank(bob);
        escrow.release(j1, 5);
        uint256 credit = escrow.credits(address(evil));
        assertEq(credit, PRICE - _fee(PRICE));

        evil.withdraw();
        assertFalse(evil.reentered(), "re-entry must fail");
        assertEq(evil.attempts(), 1);
        assertEq(address(evil).balance, credit);
        assertEq(escrow.credits(address(evil)), 0);
        assertEq(address(escrow).balance, PRICE + _fee(PRICE));
    }

    function test_withdraw_revertsWhenReceiverRejects_stateRolledBack() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 10 ether);
        vm.prank(address(r));
        uint256 jobId = escrow.requestJob{value: PRICE}(agentId, keccak256("in"), "");
        vm.warp(block.timestamp + 2 days);
        vm.prank(address(r));
        escrow.refund(jobId);
        assertEq(escrow.credits(address(r)), PRICE);
        vm.prank(address(r));
        vm.expectRevert(ServiceEscrow.TransferFailed.selector);
        escrow.withdraw();
        assertEq(escrow.credits(address(r)), PRICE);
    }

    function test_escrowNeverPushes_balanceMatchesCredits() public {
        uint256 j1 = _request(agentId, bob, PRICE);
        uint256 j2 = _request(agentId, carol, PRICE);
        _deliver(j1, alice);
        vm.prank(bob);
        escrow.release(j1, 5);
        vm.prank(alice);
        escrow.cancel(j2);
        // nothing left the escrow yet
        assertEq(address(escrow).balance, 2 * PRICE);
        assertEq(escrow.credits(alice) + escrow.credits(treasury) + escrow.credits(carol), 2 * PRICE);
    }

    // ───────────────────────────── governance setters ─────────────────────────────

    function test_setFee_boundsAndAccess() public {
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.setFee(100);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.FeeTooHigh.selector);
        escrow.setFee(1001);
        vm.prank(gov);
        escrow.setFee(1000);
        assertEq(escrow.feeBps(), 1000);
    }

    function test_setWindows() public {
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.setWindows(2 days, 3 days);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.InvalidWindow.selector);
        escrow.setWindows(0, 3 days);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.InvalidWindow.selector);
        escrow.setWindows(2 days, 0);
        vm.prank(gov);
        escrow.setWindows(2 hours, 3 hours);
        assertEq(escrow.deliveryWindow(), 2 hours);
        assertEq(escrow.reviewWindow(), 3 hours);

        // new windows apply
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(bob);
        escrow.refund(jobId);
        assertEq(escrow.credits(bob), PRICE);
    }

    function test_setFeeRecipient_access() public {
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.setFeeRecipient(alice);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.ZeroAddress.selector);
        escrow.setFeeRecipient(address(0));
        vm.prank(gov);
        escrow.setFeeRecipient(carol);
        assertEq(escrow.feeRecipient(), carol);
    }

    function test_setGovernance_access() public {
        vm.prank(alice);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.setGovernance(alice);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.ZeroAddress.selector);
        escrow.setGovernance(address(0));
        vm.prank(gov);
        escrow.setGovernance(carol);
        assertEq(escrow.governance(), carol);
        vm.prank(gov);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        escrow.setFee(1);
    }

    // ───────────────────────────── multi-agent isolation ─────────────────────────────

    function test_otherAgentOwnerCannotDeliverOrCancel() public {
        uint256 otherAgent = _register(carol, MIN_BOND);
        uint256 jobId = _request(agentId, bob, PRICE);
        vm.prank(carol);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.deliver(jobId, keccak256("x"), "");
        vm.prank(carol);
        vm.expectRevert(ServiceEscrow.NotAgentOwner.selector);
        escrow.cancel(jobId);
        assertEq(registry.getAgent(otherAgent).jobsFailed, 0);
    }
}
