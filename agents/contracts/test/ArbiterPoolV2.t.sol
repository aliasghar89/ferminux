// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, Rejecter} from "./Base.t.sol";
import {ArbiterPool} from "../src/ArbiterPool.sol";
import {ArbiterPoolV2} from "../src/ArbiterPoolV2.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

/// @dev The ArbiterPool suite, run against ArbiterPoolV2 (same behaviour unless a test says otherwise),
///      followed by the V2 fixes, each reproduced against the live ArbiterPool first.
contract ArbiterPoolV2Test is BaseTest {
    ArbiterPoolV2 internal pool;
    address internal multisig = makeAddr("multisig");
    address[5] internal arbs;
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        pool = new ArbiterPoolV2(escrow, multisig);
        // hand escrow governance to the pool (as the multisig tx would)
        vm.prank(gov);
        escrow.setGovernance(address(pool));
        agentId = _registerAlice();
        for (uint256 i = 0; i < 5; i++) {
            arbs[i] = makeAddr(string.concat("arb", vm.toString(i)));
            vm.deal(arbs[i], 2_000 ether);
        }
    }

    function _join(address a) internal {
        vm.prank(a);
        pool.joinPool{value: 500 ether}();
    }

    function _joinAll() internal {
        for (uint256 i = 0; i < 5; i++) {
            _join(arbs[i]);
        }
    }

    /// @dev request → deliver → dispute; returns the job id (Disputed).
    function _disputedJob() internal returns (uint256 jobId) {
        jobId = _request(agentId, bob, 10 ether);
        _deliver(jobId, alice);
        vm.prank(bob);
        escrow.dispute(jobId);
    }

    /// @dev One second later than the joins before it: a bond votes only on cases opened after it.
    function _openCase(uint256 jobId, address by) internal returns (uint256 caseId) {
        vm.warp(block.timestamp + 1);
        vm.prank(by);
        caseId = pool.openCase{value: 1 ether}(jobId, "fmx://payload/0xevidence");
    }

    function _vote(uint256 caseId, uint256 i, uint16 bps) internal {
        vm.prank(arbs[i]);
        pool.vote(caseId, bps);
    }

    // ───────────────────────────── deploy ─────────────────────────────

    function test_deployState() public view {
        assertEq(address(pool.escrow()), address(escrow));
        assertEq(address(pool.registry()), address(registry));
        assertEq(pool.owner(), multisig);
        assertEq(pool.minStake(), 500 ether);
        assertEq(pool.votingWindow(), 3 days);
        assertEq(pool.quorum(), 3);
        assertEq(pool.minVotingPeriod(), 1 days);
        assertEq(pool.CASE_FEE(), 1 ether);
        assertEq(escrow.governance(), address(pool));
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(ArbiterPoolV2.ZeroAddress.selector);
        new ArbiterPoolV2(ServiceEscrow(address(0)), multisig);
        vm.expectRevert(ArbiterPoolV2.ZeroAddress.selector);
        new ArbiterPoolV2(escrow, address(0));
    }

    // ───────────────────────────── pool membership ─────────────────────────────

    function test_joinPool() public {
        vm.prank(arbs[0]);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.ArbiterJoined(arbs[0], 500 ether);
        pool.joinPool{value: 500 ether}();
        assertEq(pool.stake(arbs[0]), 500 ether);
        assertEq(pool.arbiterCount(), 1);
        assertEq(pool.arbiters(0), arbs[0]);
        assertTrue(pool.isArbiter(arbs[0]));
        // top up keeps a single entry
        vm.prank(arbs[0]);
        pool.joinPool{value: 100 ether}();
        assertEq(pool.stake(arbs[0]), 600 ether);
        assertEq(pool.arbiterCount(), 1);
    }

    function test_joinPool_belowMinStake() public {
        vm.prank(arbs[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.BelowMinStake.selector, 499 ether, 500 ether));
        pool.joinPool{value: 499 ether}();
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.ZeroValue.selector);
        pool.joinPool{value: 0}();
    }

    function test_leavePool_twoStep() public {
        _join(arbs[0]);
        _join(arbs[1]);
        vm.prank(arbs[0]);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.ArbiterLeaving(arbs[0], uint64(block.timestamp + 7 days));
        pool.leavePool();
        assertFalse(pool.isArbiter(arbs[0]));
        vm.prank(arbs[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.CooldownActive.selector, uint64(block.timestamp + 7 days)));
        pool.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(arbs[0]);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.ArbiterLeft(arbs[0], 500 ether);
        pool.leavePool();
        assertEq(pool.stake(arbs[0]), 0);
        assertEq(pool.credits(arbs[0]), 500 ether);
        assertEq(pool.arbiterCount(), 1);
        assertEq(pool.arbiters(0), arbs[1]); // swap-pop
        vm.prank(arbs[0]);
        pool.withdraw();
        assertEq(arbs[0].balance, 2_000 ether);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.NotArbiter.selector);
        pool.leavePool();
    }

    function test_leavePool_rejoinCancelsLeave() public {
        _join(arbs[0]);
        vm.prank(arbs[0]);
        pool.leavePool();
        _join(arbs[0]);
        assertEq(pool.leaveAt(arbs[0]), 0);
        assertTrue(pool.isArbiter(arbs[0]));
    }

    function test_leavePool_blockedWhileVotesPending() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 5000);
        vm.prank(arbs[0]);
        pool.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(arbs[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.VotesPending.selector, 1));
        pool.leavePool();
        pool.close(caseId); // window over
        assertEq(pool.pendingVotes(arbs[0]), 0);
        vm.prank(arbs[0]);
        pool.leavePool();
        assertEq(pool.credits(arbs[0]), 500 ether + 1 ether); // bond + sole-voter reward
    }

    function test_leavingArbiterCannotVote() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.prank(arbs[0]);
        pool.leavePool();
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.Leaving.selector);
        pool.vote(caseId, 1);
    }

    // ───────────────────────────── openCase ─────────────────────────────

    function test_openCase_byClient() public {
        uint256 jobId = _disputedJob();
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.CaseOpened(1, jobId, bob, "fmx://payload/0xevidence");
        uint256 caseId = pool.openCase{value: 1 ether}(jobId, "fmx://payload/0xevidence");
        assertEq(caseId, 1);
        ArbiterPoolV2.Case memory c = pool.getCase(caseId);
        assertEq(c.jobId, jobId);
        assertEq(c.opener, bob);
        assertEq(c.evidenceURI, "fmx://payload/0xevidence");
        assertEq(c.openedAt, uint64(block.timestamp));
        assertEq(c.votes, 0);
        assertFalse(c.closed);
        assertEq(pool.caseOf(jobId), caseId);
        assertEq(pool.getEvidence(caseId).length, 1);
        assertEq(address(pool).balance, 1 ether);
    }

    function test_openCase_byAgentOwner() public {
        uint256 jobId = _disputedJob();
        _openCase(jobId, alice);
        assertEq(pool.getCase(1).opener, alice);
    }

    function test_openCase_validation() public {
        uint256 jobId = _disputedJob();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.WrongFee.selector, 0.5 ether, 1 ether));
        pool.openCase{value: 0.5 ether}(jobId, "");
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotParty.selector);
        pool.openCase{value: 1 ether}(jobId, "");
        vm.prank(bob);
        vm.expectRevert(ArbiterPoolV2.StringTooLong.selector);
        pool.openCase{value: 1 ether}(jobId, string(new bytes(257)));
        // not disputed
        uint256 openJob = _request(agentId, bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(ArbiterPoolV2.JobNotDisputed.selector);
        pool.openCase{value: 1 ether}(openJob, "");
        // duplicate
        _openCase(jobId, bob);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.CaseExists.selector, 1));
        pool.openCase{value: 1 ether}(jobId, "");
    }

    // ───────────────────────────── evidence ─────────────────────────────

    function test_submitEvidence() public {
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.EvidenceSubmitted(caseId, alice, "fmx://payload/0xreply");
        pool.submitEvidence(caseId, "fmx://payload/0xreply");
        assertEq(pool.getEvidence(caseId).length, 2);
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotParty.selector);
        pool.submitEvidence(caseId, "x");
        vm.prank(bob);
        vm.expectRevert(ArbiterPoolV2.UnknownCase.selector);
        pool.submitEvidence(9, "x");
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        vm.prank(bob);
        vm.expectRevert(ArbiterPoolV2.CaseClosedAlready.selector);
        pool.submitEvidence(caseId, "late");
    }

    // ───────────────────────────── vote ─────────────────────────────

    function test_vote_happyAndOnce() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.prank(arbs[0]);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.Voted(caseId, arbs[0], 7000);
        pool.vote(caseId, 7000);
        (bool cast, uint16 bps) = pool.getVote(caseId, arbs[0]);
        assertTrue(cast);
        assertEq(bps, 7000);
        assertEq(pool.getCase(caseId).votes, 1);
        assertEq(pool.pendingVotes(arbs[0]), 1);
        assertEq(pool.getVoters(caseId).length, 1);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.AlreadyVoted.selector);
        pool.vote(caseId, 1);
    }

    function test_vote_validation() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotArbiter.selector);
        pool.vote(caseId, 1);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.InvalidBps.selector);
        pool.vote(caseId, 10001);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.UnknownCase.selector);
        pool.vote(7, 1);
        // under-bonded after a param raise
        vm.prank(multisig);
        pool.setParams(600 ether, 3 days, 3);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.NotArbiter.selector);
        pool.vote(caseId, 1);
        vm.prank(multisig);
        pool.setParams(500 ether, 3 days, 3);
        // window closed
        vm.warp(block.timestamp + 3 days);
        vm.prank(arbs[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.VotingClosed.selector, uint64(block.timestamp)));
        pool.vote(caseId, 1);
    }

    function test_vote_conflictOfInterest() public {
        _joinAll();
        vm.deal(bob, 2_000 ether);
        _join(bob); // the client bonds
        vm.deal(alice, 2_000 ether);
        _join(alice); // the agent owner bonds
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.prank(bob);
        vm.expectRevert(ArbiterPoolV2.ConflictOfInterest.selector);
        pool.vote(caseId, 10000);
        vm.prank(alice);
        vm.expectRevert(ArbiterPoolV2.ConflictOfInterest.selector);
        pool.vote(caseId, 0);
    }

    // ───────────────────────────── close ─────────────────────────────

    function test_close_medianOddAndRewardSplit() public {
        _joinAll();
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, bob);
        _vote(caseId, 0, 1000);
        _vote(caseId, 1, 6000);
        _vote(caseId, 2, 7000);
        _vote(caseId, 3, 8000);
        _vote(caseId, 4, 10000); // 5 votes = quorum + 2 → closable early …
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);
        vm.warp(block.timestamp + 1 days); // … but only after minVotingPeriod (V2)
        // median = 7000; within 2000 bps: 6000, 7000, 8000 → 3 winners
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.CaseClosed(caseId, jobId, 7000);
        pool.close(caseId);
        ArbiterPoolV2.Case memory c = pool.getCase(caseId);
        assertTrue(c.closed);
        assertEq(c.result, 7000);
        uint256 share = uint256(1 ether) / 3;
        assertEq(pool.credits(arbs[0]), 0);
        assertEq(pool.credits(arbs[1]), share);
        assertEq(pool.credits(arbs[2]), share);
        assertEq(pool.credits(arbs[3]), share);
        assertEq(pool.credits(arbs[4]), 0);
        assertEq(pool.credits(multisig), 1 ether - 3 * share); // rounding dust
        for (uint256 i = 0; i < 5; i++) {
            assertEq(pool.pendingVotes(arbs[i]), 0);
        }
        // escrow resolved: client 70 %, agent 30 % minus fee
        ServiceEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(uint8(j.status), uint8(ServiceEscrow.JobStatus.Resolved));
        assertEq(escrow.credits(bob), 7 ether);
        uint256 agentGross = 3 ether;
        uint256 fee = (agentGross * escrow.feeBps()) / 10000;
        assertEq(escrow.credits(alice), agentGross - fee);
        assertEq(escrow.credits(treasury), fee);
        assertEq(registry.getAgent(agentId).jobsFailed, 1);
    }

    function test_close_medianEvenIsFloorMean() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 2000);
        _vote(caseId, 1, 2001);
        _vote(caseId, 2, 9000);
        _vote(caseId, 3, 9999);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        assertEq(pool.getCase(caseId).result, 5500); // floor((2001 + 9000) / 2)
        // nobody within 2000 bps of 5500 → whole fee to owner
        assertEq(pool.credits(multisig), 1 ether);
    }

    function test_close_singleVoteAfterWindow() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 2, 4000);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        assertEq(pool.getCase(caseId).result, 4000);
        assertEq(pool.credits(arbs[2]), 1 ether);
        assertEq(registry.getAgent(agentId).jobsCompleted, 1); // clientBps < 5000 → success
    }

    function test_close_noVotesSplitsEvenly() public {
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, alice);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        assertEq(pool.getCase(caseId).result, 5000);
        assertEq(pool.credits(multisig), 1 ether);
        assertEq(escrow.credits(bob), 5 ether);
    }

    function test_close_notClosableEarly() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 1);
        _vote(caseId, 1, 1);
        _vote(caseId, 2, 1);
        _vote(caseId, 3, 1); // quorum + 1 — still not enough
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);
        vm.warp(block.timestamp + 3 days - 1);
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);
        vm.warp(block.timestamp + 1);
        pool.close(caseId);
        vm.expectRevert(ArbiterPoolV2.CaseClosedAlready.selector);
        pool.close(caseId);
        vm.expectRevert(ArbiterPoolV2.UnknownCase.selector);
        pool.close(99);
    }

    function test_close_revertsWhenEscrowGovernanceNotPool() public {
        // hand escrow governance back to gov (via forward) → close must revert atomically
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (gov)));
        assertEq(escrow.governance(), gov);
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        pool.close(caseId);
        assertFalse(pool.getCase(caseId).closed);
    }

    function test_close_anyoneMayCall() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 5000);
        vm.warp(block.timestamp + 3 days);
        vm.prank(carol);
        pool.close(caseId);
        assertTrue(pool.getCase(caseId).closed);
    }

    function test_close_rewardBandBoundaryInclusive() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 3000);
        _vote(caseId, 1, 5000);
        _vote(caseId, 2, 7000); // median 5000; 3000 and 7000 are exactly 2000 away → included
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        uint256 share = uint256(1 ether) / 3;
        assertEq(pool.credits(arbs[0]), share);
        assertEq(pool.credits(arbs[1]), share);
        assertEq(pool.credits(arbs[2]), share);
    }

    function testFuzz_close_feeConserved(uint16 a, uint16 b, uint16 c) public {
        a = uint16(bound(a, 0, 10000));
        b = uint16(bound(b, 0, 10000));
        c = uint16(bound(c, 0, 10000));
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, a);
        _vote(caseId, 1, b);
        _vote(caseId, 2, c);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        uint256 sum = pool.credits(multisig);
        for (uint256 i = 0; i < 3; i++) {
            sum += pool.credits(arbs[i]);
        }
        assertEq(sum, 1 ether);
        uint16 r = pool.getCase(caseId).result;
        assertTrue(r >= _min3(a, b, c) && r <= _max3(a, b, c));
    }

    function _min3(uint16 a, uint16 b, uint16 c) internal pure returns (uint16) {
        uint16 m = a < b ? a : b;
        return m < c ? m : c;
    }

    function _max3(uint16 a, uint16 b, uint16 c) internal pure returns (uint16) {
        uint16 m = a > b ? a : b;
        return m > c ? m : c;
    }

    // ───────────────────────────── withdraw ─────────────────────────────

    function test_withdraw() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 5000);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        vm.prank(arbs[0]);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.Withdrawn(arbs[0], 1 ether);
        pool.withdraw();
        assertEq(arbs[0].balance, 2_000 ether - 500 ether + 1 ether);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPoolV2.NothingToWithdraw.selector);
        pool.withdraw();
    }

    function test_withdraw_rejecterRollsBack() public {
        Rejecter rj = new Rejecter();
        vm.deal(address(rj), 500 ether);
        vm.prank(address(rj));
        pool.joinPool{value: 500 ether}();
        vm.prank(address(rj));
        pool.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(address(rj));
        pool.leavePool();
        vm.prank(address(rj));
        vm.expectRevert(ArbiterPoolV2.TransferFailed.selector);
        pool.withdraw();
        assertEq(pool.credits(address(rj)), 500 ether);
    }

    // ───────────────────────────── owner ─────────────────────────────

    function test_forward_adminReachable() public {
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setFee, (300)));
        assertEq(escrow.feeBps(), 300);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setWindows, (2 days, 2 days)));
        assertEq(escrow.deliveryWindow(), 2 days);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setFeeRecipient, (carol)));
        assertEq(escrow.feeRecipient(), carol);
    }

    function test_forward_onlyOwnerAndBubbles() public {
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotOwner.selector);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setFee, (1)));
        vm.prank(multisig);
        vm.expectRevert(ServiceEscrow.FeeTooHigh.selector);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setFee, (5000)));
        vm.prank(multisig);
        vm.expectRevert(ArbiterPoolV2.ZeroAddress.selector);
        pool.forward(address(0), "");
    }

    function test_setParams() public {
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotOwner.selector);
        pool.setParams(1, 1, 1);
        vm.prank(multisig);
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        pool.setParams(0, 1, 1);
        vm.prank(multisig);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.ParamsChanged(100 ether, 1 days, 2);
        pool.setParams(100 ether, 1 days, 2);
        assertEq(pool.minStake(), 100 ether);
        assertEq(pool.votingWindow(), 1 days);
        assertEq(pool.quorum(), 2);
    }

    function test_transferOwnership() public {
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotOwner.selector);
        pool.transferOwnership(carol);
        vm.prank(multisig);
        vm.expectRevert(ArbiterPoolV2.ZeroAddress.selector);
        pool.transferOwnership(address(0));
        vm.prank(multisig);
        pool.transferOwnership(carol);
        assertEq(pool.owner(), carol);
    }

    // ═════════════════════════════ V2 fix 1: sybil fast-close ═════════════════════════════

    address[5] internal sybils;

    function _sybils() internal {
        for (uint256 i = 0; i < 5; i++) {
            sybils[i] = makeAddr(string.concat("sybil", vm.toString(i)));
            vm.deal(sybils[i], 500 ether);
        }
    }

    /// @dev A delivered job, not yet disputed (the attacker picks the block).
    function _deliveredJob() internal returns (uint256 jobId) {
        jobId = _request(agentId, bob, 10 ether);
        _deliver(jobId, alice);
    }

    /// @notice The live pool: a client with 5 × 500 FMX of fresh bonds disputes, opens, votes itself a
    ///         full refund and closes — all in one block, before any bonded arbiter can vote.
    function test_attack_v1_sybilsVoteAndCloseInOneBlock() public {
        ArbiterPool v1 = new ArbiterPool(escrow, multisig);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(v1))));
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            v1.joinPool{value: 500 ether}(); // honest arbiters, bonded long before
        }
        _sybils();
        uint256 jobId = _deliveredJob();
        vm.warp(block.timestamp + 1 days - 1);

        // ── one block ──
        vm.prank(bob);
        escrow.dispute(jobId);
        vm.prank(bob);
        uint256 caseId = v1.openCase{value: 1 ether}(jobId, "");
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(sybils[i]);
            v1.joinPool{value: 500 ether}();
            vm.prank(sybils[i]);
            v1.vote(caseId, 10000);
        }
        v1.close(caseId);
        // ──────────────

        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Resolved));
        assertEq(escrow.credits(bob), 10 ether); // the whole job amount back to the client
        assertEq(escrow.credits(alice), 0);
        vm.prank(arbs[0]);
        vm.expectRevert(ArbiterPool.CaseClosedAlready.selector);
        v1.vote(caseId, 0); // the honest arbiters never got a say
    }

    /// @notice Same attack on V2: bonds posted in the opening block cannot vote, so nothing closes.
    function test_v2_sybilsJoiningAfterOpenCannotVote() public {
        _joinAll();
        _sybils();
        uint256 jobId = _deliveredJob();
        vm.warp(block.timestamp + 1 days - 1);

        vm.prank(bob);
        escrow.dispute(jobId);
        vm.prank(bob);
        uint256 caseId = pool.openCase{value: 1 ether}(jobId, "");
        uint64 openedAt = uint64(block.timestamp);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(sybils[i]);
            pool.joinPool{value: 500 ether}();
            vm.prank(sybils[i]);
            vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.JoinedAfterCaseOpened.selector, openedAt, openedAt));
            pool.vote(caseId, 10000);
        }
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);
        // a later block does not help them either: their bonds still postdate the case
        vm.warp(block.timestamp + 2 days);
        vm.prank(sybils[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.JoinedAfterCaseOpened.selector, openedAt, openedAt));
        pool.vote(caseId, 10000);
        // the arbiters bonded before the case decide it
        _vote(caseId, 0, 2000);
        _vote(caseId, 1, 3000);
        _vote(caseId, 2, 4000);
        vm.warp(uint256(openedAt) + 3 days);
        pool.close(caseId);
        assertEq(pool.getCase(caseId).result, 3000);
        assertEq(escrow.credits(bob), 3 ether);
    }

    /// @notice Pre-positioned bonds still cannot close in the opening block: the early close waits
    ///         `minVotingPeriod`, and the arbiters who vote in that time move the median.
    function test_v2_preBondedBlocCannotCloseBeforeMinVotingPeriod() public {
        _joinAll();
        _sybils();
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(sybils[i]);
            pool.joinPool{value: 500 ether}();
        }
        address[2] memory more = [makeAddr("arb5"), makeAddr("arb6")];
        for (uint256 i = 0; i < 2; i++) {
            vm.deal(more[i], 500 ether);
            vm.prank(more[i]);
            pool.joinPool{value: 500 ether}();
        }
        uint256 jobId = _deliveredJob();
        vm.warp(block.timestamp + 1 hours);

        vm.prank(bob);
        escrow.dispute(jobId);
        vm.prank(bob);
        uint256 caseId = pool.openCase{value: 1 ether}(jobId, "");
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(sybils[i]);
            pool.vote(caseId, 10000);
        }
        assertFalse(pool.closable(caseId));
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);

        // within the minimum period the other 7 bonded arbiters vote
        for (uint256 i = 0; i < 5; i++) {
            _vote(caseId, i, 0);
        }
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(more[i]);
            pool.vote(caseId, 0);
        }
        vm.warp(block.timestamp + 1);
        assertTrue(pool.closable(caseId));
        pool.close(caseId);
        assertEq(pool.getCase(caseId).result, 0); // 7 × 0 against 5 × 10000
        assertEq(escrow.credits(bob), 0);
        uint256 share = uint256(1 ether) / 7;
        assertEq(pool.credits(arbs[0]), share);
        assertEq(pool.credits(sybils[0]), 0);
    }

    function test_v2_eligibility_topUpKeepsActiveSince() public {
        _join(arbs[0]);
        uint64 since = pool.activeSince(arbs[0]);
        assertEq(since, uint64(block.timestamp));
        vm.warp(block.timestamp + 1 days);
        vm.prank(arbs[0]);
        pool.joinPool{value: 1 ether}(); // already eligible: a top-up only
        assertEq(pool.activeSince(arbs[0]), since);
        uint256 caseId = _openCase(_disputedJob(), bob);
        _vote(caseId, 0, 5000);
    }

    function test_v2_eligibility_rejoinAfterLeaveRestarts() public {
        _join(arbs[0]);
        vm.warp(block.timestamp + 1 days);
        vm.prank(arbs[0]);
        pool.leavePool(); // starts the cooldown
        uint256 jobId = _disputedJob();
        _join(arbs[0]); // cancels the leave: eligible again from this second only
        vm.prank(bob);
        uint256 caseId = pool.openCase{value: 1 ether}(jobId, "");
        vm.prank(arbs[0]);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArbiterPoolV2.JoinedAfterCaseOpened.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        pool.vote(caseId, 5000);
        // a full exit clears the snapshot
        vm.prank(arbs[0]);
        pool.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(arbs[0]);
        pool.leavePool();
        assertEq(pool.activeSince(arbs[0]), 0);
    }

    function test_v2_eligibility_raisedMinStakeTopUpRestarts() public {
        _join(arbs[0]);
        vm.warp(block.timestamp + 1 days);
        vm.prank(multisig);
        pool.setParams(600 ether, 3 days, 3);
        assertFalse(pool.isArbiter(arbs[0]));
        vm.prank(arbs[0]);
        pool.joinPool{value: 100 ether}(); // eligible again only from now
        assertEq(pool.activeSince(arbs[0]), uint64(block.timestamp));
    }

    function test_v2_closable_view() public {
        _joinAll();
        uint256 caseId = _openCase(_disputedJob(), bob);
        assertFalse(pool.closable(caseId));
        assertFalse(pool.closable(99));
        for (uint256 i = 0; i < 5; i++) {
            _vote(caseId, i, 5000);
        }
        assertFalse(pool.closable(caseId));
        vm.warp(block.timestamp + 1 days);
        assertTrue(pool.closable(caseId));
        pool.close(caseId);
        assertFalse(pool.closable(caseId));
    }

    function test_v2_setMinVotingPeriod() public {
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotOwner.selector);
        pool.setMinVotingPeriod(2 days);
        vm.startPrank(multisig);
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        pool.setMinVotingPeriod(0);
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        pool.setMinVotingPeriod(3 days + 1); // longer than the window
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.MinVotingPeriodChanged(2 days);
        pool.setMinVotingPeriod(2 days);
        assertEq(pool.minVotingPeriod(), 2 days);
        // the window may not shrink below it
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        pool.setParams(500 ether, 2 days - 1, 3);
        pool.setParams(500 ether, 2 days, 3);
        vm.stopPrank();
    }

    function testFuzz_v2_noEarlyCloseBeforeMinVotingPeriod(uint8 extra, uint32 dt) public {
        uint256 n = 5 + bound(extra, 0, 5);
        for (uint256 i = 0; i < n; i++) {
            address a = makeAddr(string.concat("fz", vm.toString(i)));
            vm.deal(a, 500 ether);
            vm.prank(a);
            pool.joinPool{value: 500 ether}();
        }
        uint256 caseId = _openCase(_disputedJob(), bob);
        for (uint256 i = 0; i < n; i++) {
            vm.prank(makeAddr(string.concat("fz", vm.toString(i))));
            pool.vote(caseId, 10000);
        }
        uint256 elapsed = bound(dt, 0, 3 days);
        vm.warp(block.timestamp + elapsed);
        if (elapsed < 1 days) {
            vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        }
        pool.close(caseId);
    }
}
