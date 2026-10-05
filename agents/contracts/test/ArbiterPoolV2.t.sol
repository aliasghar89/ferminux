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
        pool = new ArbiterPoolV2(escrow, multisig, ArbiterPoolV2(address(0)));
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
        assertEq(pool.disputeTimeout(), 7 days);
        assertEq(pool.CASE_FEE(), 1 ether);
        assertEq(address(pool.predecessor()), address(0));
        assertEq(escrow.governance(), address(pool));
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(ArbiterPoolV2.ZeroAddress.selector);
        new ArbiterPoolV2(ServiceEscrow(address(0)), multisig, ArbiterPoolV2(address(0)));
        vm.expectRevert(ArbiterPoolV2.ZeroAddress.selector);
        new ArbiterPoolV2(escrow, address(0), ArbiterPoolV2(address(0)));
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

    /// @dev V2: ArbiterPool reverted here (NotGovernance) for as long as governance stayed away; V2
    ///      voids the case at its normal close time instead. See the fix-2 section below.
    function test_close_voidsWhenEscrowGovernanceNotPool() public {
        uint256 caseId = _openCase(_disputedJob(), bob);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (gov)));
        assertEq(escrow.governance(), gov);
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector); // not before the normal close time
        pool.close(caseId);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId);
        assertTrue(pool.getCase(caseId).closed);
        assertTrue(pool.voided(caseId));
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

    // ═════════════════════════════ V2 fix 2: cases the pool can no longer resolve ═════════════════════════════

    /// @dev Live ArbiterPool as escrow governance, with arbs[0..2] bonded and a voted case on a disputed job.
    function _v1CaseWithVotes() internal returns (ArbiterPool v1, uint256 jobId, uint256 caseId) {
        v1 = new ArbiterPool(escrow, multisig);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(v1))));
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            v1.joinPool{value: 500 ether}();
        }
        jobId = _disputedJob();
        vm.prank(bob);
        caseId = v1.openCase{value: 1 ether}(jobId, "");
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            v1.vote(caseId, 5000);
        }
    }

    /// @notice The live pool: once the job is settled through `forward`, close() reverts for ever and the
    ///         voters' bonds can never leave the pool.
    function test_attack_v1_directResolveStrandsVoters() public {
        (ArbiterPool v1, uint256 jobId, uint256 caseId) = _v1CaseWithVotes();
        vm.prank(multisig);
        v1.forward(address(escrow), abi.encodeCall(ServiceEscrow.resolve, (jobId, 10000)));

        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Resolved));
        v1.close(caseId);

        vm.prank(arbs[0]);
        v1.leavePool();
        vm.warp(block.timestamp + 365 days);
        vm.prank(arbs[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPool.VotesPending.selector, 1));
        v1.leavePool();
        assertEq(v1.stake(arbs[0]), 500 ether); // stranded
    }

    /// @notice The live pool: once escrow governance moves on, close() reverts NotGovernance for ever.
    function test_attack_v1_governanceMovedStrandsVoters() public {
        (ArbiterPool v1,, uint256 caseId) = _v1CaseWithVotes();
        vm.prank(multisig);
        v1.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (gov)));
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        v1.close(caseId);
        vm.prank(arbs[1]);
        v1.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(arbs[1]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPool.VotesPending.selector, 1));
        v1.leavePool();
    }

    function _poolSolvent() internal view {
        uint256 owed = pool.credits(multisig) + pool.credits(bob) + pool.credits(alice);
        for (uint256 i = 0; i < 5; i++) {
            owed += pool.stake(arbs[i]) + pool.credits(arbs[i]);
        }
        assertEq(address(pool).balance, owed);
    }

    function test_v2_close_voidsAtOnceWhenJobResolvedElsewhere() public {
        _joinAll();
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, bob);
        for (uint256 i = 0; i < 3; i++) {
            _vote(caseId, i, 5000);
        }
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.resolve, (jobId, 2500)));
        assertEq(escrow.credits(bob), 2.5 ether);

        // nobody can pin a bond on the dead case any more
        vm.prank(arbs[3]);
        vm.expectRevert(ArbiterPoolV2.JobNotDisputed.selector);
        pool.vote(caseId, 0);

        assertTrue(pool.closable(caseId)); // well inside the voting window
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.CaseVoided(caseId, jobId);
        pool.close(caseId);

        ArbiterPoolV2.Case memory c = pool.getCase(caseId);
        assertTrue(c.closed);
        assertTrue(pool.voided(caseId));
        assertEq(c.result, 0);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(pool.pendingVotes(arbs[i]), 0);
            assertEq(pool.credits(arbs[i]), 0); // no decision, no reward
        }
        assertEq(pool.credits(bob), 1 ether); // case fee back to the opener
        assertEq(pool.credits(multisig), 0);
        assertEq(escrow.credits(bob), 2.5 ether); // the escrow outcome is the direct resolve's
        _poolSolvent();

        vm.expectRevert(ArbiterPoolV2.CaseClosedAlready.selector);
        pool.close(caseId);

        // the voters can leave
        vm.prank(arbs[0]);
        pool.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(arbs[0]);
        pool.leavePool();
        assertEq(pool.credits(arbs[0]), 500 ether);
    }

    function test_v2_close_voidsWhenGovernanceMovedAway_thenJobReopens() public {
        _joinAll();
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, alice);
        _vote(caseId, 0, 9000);
        _vote(caseId, 1, 9000);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (gov)));

        assertFalse(pool.closable(caseId)); // still voting: governance may come back in time
        vm.expectRevert(ArbiterPoolV2.NotClosable.selector);
        pool.close(caseId);
        vm.warp(block.timestamp + 3 days);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.CaseVoided(caseId, jobId);
        pool.close(caseId);
        assertEq(pool.pendingVotes(arbs[0]), 0);
        assertEq(pool.pendingVotes(arbs[1]), 0);
        assertEq(pool.credits(alice), 1 ether);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Disputed));
        _poolSolvent();

        // governance returns; the job gets a fresh case and a decision
        vm.prank(gov);
        escrow.setGovernance(address(pool));
        uint256 caseId2 = _openCase(jobId, bob);
        assertEq(caseId2, caseId + 1);
        assertEq(pool.caseOf(jobId), caseId2);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.CaseExists.selector, caseId2));
        pool.openCase{value: 1 ether}(jobId, "");
        _vote(caseId2, 0, 6000);
        _vote(caseId2, 1, 6000);
        _vote(caseId2, 2, 6000);
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId2);
        assertFalse(pool.voided(caseId2));
        assertEq(pool.getCase(caseId2).result, 6000);
        assertEq(escrow.credits(bob), 6 ether);
    }

    /// @notice Hand-over to a successor pool needs no drain: the successor decides the job, the old case voids.
    function test_v2_migrationToSuccessorPool() public {
        _joinAll();
        ArbiterPoolV2 next = new ArbiterPoolV2(escrow, multisig, pool);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            next.joinPool{value: 500 ether}();
        }
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, bob);
        _vote(caseId, 0, 1000);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(next))));

        vm.prank(bob);
        uint256 nextCase = next.openCase{value: 1 ether}(jobId, "");
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            next.vote(nextCase, 7000);
        }
        vm.warp(block.timestamp + 3 days);
        next.close(nextCase);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Resolved));

        pool.close(caseId);
        assertTrue(pool.voided(caseId));
        assertEq(pool.pendingVotes(arbs[0]), 0);
    }

    /// @notice The v1 drain with b sent apart from c and d: a party to a stale disputed job opens a v1 case
    ///         and closes it a second later. No arbiter can vote, so v1's zero-vote rule splits the job
    ///         50/50 — where v2 would have refunded the client in full at the hand-over.
    function test_attack_v1_drainStepsApartSplitUnarbitrated() public {
        ArbiterPool v1 = new ArbiterPool(escrow, multisig);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(v1))));
        uint256 jobId = _disputedJob();
        vm.warp(block.timestamp + 30 days); // a dispute nobody took to v1

        uint8 quorum = v1.quorum();
        vm.prank(multisig);
        v1.setParams(type(uint256).max, 1, quorum); // step b, on its own
        vm.prank(alice);
        uint256 caseId = v1.openCase{value: 1 ether}(jobId, "");
        vm.warp(block.timestamp + 1);
        v1.close(caseId);
        assertEq(v1.getCase(caseId).result, 5000);
        assertEq(escrow.credits(bob), 5 ether);

        vm.prank(multisig);
        v1.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(pool))));
        vm.expectRevert(ArbiterPoolV2.JobNotDisputed.selector);
        pool.resolveUnarbitrated(jobId);
    }

    /// @notice The drain as the MIGRATION note runs it: the vote freeze (a) on its own, then b–d in one
    ///         multisig batch. The in-flight case is decided on its votes, nothing can be opened and closed
    ///         in between, and a v1 case opened afterwards never closes — v2 takes its job.
    function test_v1DrainInOneBatch() public {
        uint256 stale = _disputedJob();
        vm.warp(block.timestamp + 30 days); // a dispute nobody took to v1
        (ArbiterPool v1, uint256 jobId, uint256 caseId) = _v1CaseWithVotes(); // in flight: 3 × 5000
        uint64 window = v1.votingWindow();
        uint8 quorum = v1.quorum();
        vm.prank(multisig);
        v1.setParams(type(uint256).max, window, quorum);
        uint256 n = v1.nextCaseId();
        vm.warp(block.timestamp + 1 hours);

        vm.startPrank(multisig);
        v1.setParams(type(uint256).max, 1, v1.quorum());
        for (uint256 id = 1; id <= n; id++) {
            if (!v1.getCase(id).closed) v1.close(id);
        }
        v1.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(pool))));
        vm.stopPrank();

        assertEq(v1.getCase(caseId).result, 5000);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Resolved));

        vm.prank(alice);
        uint256 late = v1.openCase{value: 1 ether}(stale, "");
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        v1.close(late);
        pool.resolveUnarbitrated(stale);
        assertEq(escrow.credits(bob), 5 ether + 10 ether);

        // v1's voters are free to leave
        vm.prank(arbs[0]);
        v1.leavePool();
        vm.warp(block.timestamp + 7 days);
        vm.prank(arbs[0]);
        v1.leavePool();
        assertEq(v1.stake(arbs[0]), 0);
    }

    /// @notice The drain with the vote freeze inside the batch: a v1 case opened and voted on after the
    ///         batch's list was read outlives the hand-over. v2 does not see it, so anyone refunds its stale
    ///         job through v2 in the next transaction; a governance loan to close the case then comes too
    ///         late — v1.close reverts for good and the voter's bond can never leave v1.
    function test_attack_v1Drain_freezeInBatchStrandsLateVoter() public {
        uint256 missedJob = _disputedJob();
        vm.warp(block.timestamp + 30 days); // a dispute nobody took to v1 so far
        (ArbiterPool v1,,) = _v1CaseWithVotes();
        uint256 listed = v1.nextCaseId(); // the list for the batch is read here …
        vm.prank(alice);
        uint256 missed = v1.openCase{value: 1 ether}(missedJob, ""); // … and this case comes after it
        vm.prank(arbs[0]);
        v1.vote(missed, 0); // votes are still open: the freeze is in the batch
        vm.warp(block.timestamp + 1 hours);

        vm.startPrank(multisig);
        v1.setParams(type(uint256).max, 1, v1.quorum());
        for (uint256 id = 1; id <= listed; id++) {
            if (!v1.getCase(id).closed) v1.close(id);
        }
        v1.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(pool))));
        vm.stopPrank();
        assertFalse(v1.getCase(missed).closed);
        assertEq(v1.pendingVotes(arbs[0]), 1);

        vm.prank(carol);
        pool.resolveUnarbitrated(missedJob);
        assertEq(uint8(escrow.getJob(missedJob).status), uint8(ServiceEscrow.JobStatus.Resolved));

        vm.startPrank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(v1))));
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Resolved));
        v1.close(missed);
        vm.stopPrank();

        vm.prank(arbs[0]);
        v1.leavePool();
        vm.warp(block.timestamp + 365 days);
        vm.prank(arbs[0]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPool.VotesPending.selector, 1));
        v1.leavePool();
        assertEq(v1.stake(arbs[0]), 500 ether); // stranded
    }

    /// @notice The drain as the MIGRATION note runs it, freeze first: a v1 case opened after it — after the
    ///         batch's list was read, too — can get no vote and cannot close early. The batch leaves it
    ///         open, v2 refunds its stale job at once, and every v1 arbiter can still leave.
    function test_v1Drain_caseOpenedAfterFreezePinsNobody() public {
        uint256 missedJob = _disputedJob();
        vm.warp(block.timestamp + 30 days); // a dispute nobody took to v1 so far
        (ArbiterPool v1,, uint256 caseId) = _v1CaseWithVotes(); // in flight: 3 × 5000
        uint64 window = v1.votingWindow();
        uint8 quorum = v1.quorum();
        vm.prank(multisig);
        v1.setParams(type(uint256).max, window, quorum); // a, on its own
        uint256 n = v1.nextCaseId();

        vm.prank(alice);
        uint256 missed = v1.openCase{value: 1 ether}(missedJob, "");
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(arbs[i]);
            vm.expectRevert(ArbiterPool.NotArbiter.selector);
            v1.vote(missed, 0);
        }
        vm.prank(arbs[3]);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPool.BelowMinStake.selector, 500 ether, type(uint256).max));
        v1.joinPool{value: 500 ether}();
        vm.warp(block.timestamp + 1);
        vm.expectRevert(ArbiterPool.NotClosable.selector);
        v1.close(missed);
        vm.warp(block.timestamp + 1 hours);

        vm.startPrank(multisig);
        v1.setParams(type(uint256).max, 1, quorum);
        for (uint256 id = 1; id <= n; id++) {
            if (!v1.getCase(id).closed) v1.close(id);
        }
        v1.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(pool))));
        vm.stopPrank();
        assertEq(v1.getCase(caseId).result, 5000); // decided on the votes cast before the freeze
        assertFalse(v1.getCase(missed).closed);
        assertEq(v1.getCase(missed).votes, 0);

        vm.prank(carol);
        pool.resolveUnarbitrated(missedJob);
        assertEq(uint8(escrow.getJob(missedJob).status), uint8(ServiceEscrow.JobStatus.Resolved));

        for (uint256 i = 0; i < 3; i++) {
            assertEq(v1.pendingVotes(arbs[i]), 0);
            vm.prank(arbs[i]);
            v1.leavePool();
        }
        vm.warp(block.timestamp + 7 days);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            v1.leavePool();
            assertEq(v1.stake(arbs[i]), 0);
        }
    }

    // ═════════════════════════════ V2 fix 3: dispute timeout (ServiceEscrow) ═════════════════════════════

    /// @notice The live escrow + pool: a disputed job nobody takes to a case is locked for good — no
    ///         party and no pool function can ever move its FMX.
    function test_attack_v1_disputedJobLocksForever() public {
        ArbiterPool v1 = new ArbiterPool(escrow, multisig);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(v1))));
        uint256 jobId = _disputedJob();
        uint256 locked = address(escrow).balance;
        vm.warp(block.timestamp + 365 days);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Disputed));
        escrow.refund(jobId);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServiceEscrow.WrongStatus.selector, ServiceEscrow.JobStatus.Disputed));
        escrow.claim(jobId);
        vm.expectRevert(ArbiterPool.UnknownCase.selector);
        v1.close(1);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Disputed));
        assertEq(escrow.credits(bob) + escrow.credits(alice), 0);
        assertEq(address(escrow).balance, locked);
    }

    function test_v2_resolveUnarbitrated_refundsClientAfterTimeout() public {
        uint256 jobId = _disputedJob();
        uint256 deadline = uint256(escrow.getJob(jobId).deliveredAt) + 1 days + 7 days;
        assertEq(pool.disputeDeadline(jobId), deadline);

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.TooEarly.selector, deadline));
        pool.resolveUnarbitrated(jobId);

        vm.warp(deadline);
        vm.prank(carol); // anyone
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.DisputeTimedOut(jobId, carol);
        vm.expectEmit(true, true, true, true);
        emit ServiceEscrow.JobResolved(jobId, 10 ether, 0, 0);
        pool.resolveUnarbitrated(jobId);

        assertEq(uint8(escrow.getJob(jobId).status), uint8(ServiceEscrow.JobStatus.Resolved));
        assertEq(escrow.credits(bob), 10 ether); // full refund, no fee
        assertEq(escrow.credits(alice), 0);
        assertEq(escrow.credits(treasury), 0);
        assertEq(registry.getAgent(agentId).jobsFailed, 1);
        vm.prank(bob);
        escrow.withdraw();

        vm.expectRevert(ArbiterPoolV2.JobNotDisputed.selector);
        pool.resolveUnarbitrated(jobId);
    }

    function test_v2_resolveUnarbitrated_notWhileACaseIsOpen() public {
        _joinAll();
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, alice); // the agent owner defends in time
        _vote(caseId, 0, 1000);
        vm.warp(pool.disputeDeadline(jobId) + 30 days);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.CaseExists.selector, caseId));
        pool.resolveUnarbitrated(jobId);
        pool.close(caseId); // the case decides, not the timeout
        assertEq(escrow.credits(bob), 1 ether);
    }

    function test_v2_resolveUnarbitrated_afterVoidedCase() public {
        uint256 jobId = _disputedJob();
        uint256 caseId = _openCase(jobId, bob);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (gov)));
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId); // voided: governance was elsewhere
        assertEq(pool.lastVoidAt(jobId), block.timestamp);
        assertEq(pool.disputeDeadline(jobId), block.timestamp + 7 days); // the void restarts the clock
        // still not the pool's to resolve
        vm.warp(pool.disputeDeadline(jobId));
        vm.expectRevert(ServiceEscrow.NotGovernance.selector);
        pool.resolveUnarbitrated(jobId);
        // governance back: the voided case does not block the timeout
        vm.prank(gov);
        escrow.setGovernance(address(pool));
        pool.resolveUnarbitrated(jobId);
        assertEq(escrow.credits(bob), 10 ether);
    }

    function test_v2_resolveUnarbitrated_validation() public {
        vm.expectRevert(ArbiterPoolV2.JobNotDisputed.selector);
        pool.resolveUnarbitrated(42); // unknown job
        uint256 jobId = _request(agentId, bob, 1 ether);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(ArbiterPoolV2.JobNotDisputed.selector);
        pool.resolveUnarbitrated(jobId); // Open: the client has refund() for that
    }

    function test_v2_disputeDeadline_followsReviewWindowAndTimeout() public {
        uint256 jobId = _disputedJob();
        uint256 deliveredAt = escrow.getJob(jobId).deliveredAt;
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setWindows, (1 days, 2 days)));
        vm.prank(multisig);
        pool.setDisputeTimeout(14 days);
        assertEq(pool.disputeDeadline(jobId), deliveredAt + 2 days + 14 days);
    }

    function test_v2_setDisputeTimeout() public {
        vm.prank(carol);
        vm.expectRevert(ArbiterPoolV2.NotOwner.selector);
        pool.setDisputeTimeout(10 days);
        vm.startPrank(multisig);
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        pool.setDisputeTimeout(1 days - 1);
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        pool.setDisputeTimeout(90 days + 1);
        vm.expectEmit(true, true, true, true);
        emit ArbiterPoolV2.DisputeTimeoutChanged(1 days);
        pool.setDisputeTimeout(1 days);
        pool.setDisputeTimeout(90 days);
        vm.stopPrank();
        assertEq(pool.disputeTimeout(), 90 days);
    }

    function testFuzz_v2_resolveUnarbitrated_onlyAfterDeadline(uint32 dt) public {
        uint256 jobId = _disputedJob();
        uint256 deadline = pool.disputeDeadline(jobId);
        vm.warp(block.timestamp + bound(dt, 0, 20 days));
        if (block.timestamp < deadline) {
            vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.TooEarly.selector, deadline));
            pool.resolveUnarbitrated(jobId);
        } else {
            pool.resolveUnarbitrated(jobId);
            assertEq(escrow.credits(bob), 10 ether);
        }
    }

    // ═════════════════════════════ V2 fix 3, continued: a timely defence outlives a void or a hand-over ═════════════════════════════

    /// @notice The agent owner defends two hours before the deadline and the arbiters side with it.
    ///         Escrow governance leaves and comes back, so the case voids at its close time. The refund
    ///         still waits `disputeTimeout` after the void, and the owner's new case decides the job.
    function test_v2_resolveUnarbitrated_voidRestartsTheClock() public {
        _joinAll();
        uint256 jobId = _disputedJob();
        vm.warp(pool.disputeDeadline(jobId) - 2 hours);
        uint256 caseId = _openCase(jobId, alice);
        for (uint256 i = 0; i < 3; i++) {
            _vote(caseId, i, 0);
        }
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (gov)));
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId); // voided: governance was elsewhere at its close time
        assertTrue(pool.voided(caseId));
        uint256 again = block.timestamp + 7 days;
        vm.prank(gov);
        escrow.setGovernance(address(pool));

        // the review-window deadline passed days ago, but the void restarted the clock
        assertEq(pool.disputeDeadline(jobId), again);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.TooEarly.selector, again));
        pool.resolveUnarbitrated(jobId);

        // in which the agent owner brings the job back to a case, and the arbiters decide it
        uint256 caseId2 = _openCase(jobId, alice);
        for (uint256 i = 0; i < 3; i++) {
            _vote(caseId2, i, 0);
        }
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId2);
        assertEq(escrow.credits(bob), 0);
        assertEq(registry.getAgent(agentId).jobsCompleted, 1);
        assertEq(registry.getAgent(agentId).jobsFailed, 0);
    }

    /// @notice The agent owner defends two hours before the deadline, three arbiters vote for it, and the
    ///         multisig hands governance to a successor two hours after the deadline. The successor
    ///         honours the open case, then `disputeTimeout` after its void, in which the owner brings the
    ///         job to the new pool.
    function test_v2_successorHonoursPredecessorCase() public {
        _joinAll();
        ArbiterPoolV2 next = new ArbiterPoolV2(escrow, multisig, pool);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            next.joinPool{value: 500 ether}();
        }
        uint256 jobId = _disputedJob();
        uint256 deadline = pool.disputeDeadline(jobId);
        vm.warp(deadline - 2 hours);
        uint256 caseId = _openCase(jobId, alice);
        for (uint256 i = 0; i < 3; i++) {
            _vote(caseId, i, 0);
        }
        vm.warp(deadline + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.CaseExists.selector, caseId));
        pool.resolveUnarbitrated(jobId);

        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(next))));
        // same block: the successor sees the old pool's case
        (bool open,) = next.caseStatus(jobId);
        assertTrue(open);
        vm.prank(bob);
        vm.expectRevert(ArbiterPoolV2.CaseOpenInPredecessor.selector);
        next.resolveUnarbitrated(jobId);

        // the old case voids at its close time, and the clock restarts there
        vm.warp(uint256(pool.getCase(caseId).openedAt) + 3 days);
        pool.close(caseId);
        assertTrue(pool.voided(caseId));
        uint256 again = block.timestamp + 7 days;
        assertEq(next.disputeDeadline(jobId), again);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.TooEarly.selector, again));
        next.resolveUnarbitrated(jobId);

        // the agent owner brings the job to the successor, whose arbiters decide it
        vm.prank(alice);
        uint256 nextCase = next.openCase{value: 1 ether}(jobId, "");
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(arbs[i]);
            next.vote(nextCase, 0);
        }
        vm.warp(block.timestamp + 3 days);
        next.close(nextCase);
        assertEq(escrow.credits(bob), 0);
        assertEq(registry.getAgent(agentId).jobsCompleted, 1);
        assertEq(registry.getAgent(agentId).jobsFailed, 0);
    }

    /// @notice Two hand-overs inside one restarted clock: the third pool still sees the first one's void,
    ///         and refunds the client once nobody brought the job to it in that time.
    function test_v2_successorChainHonoursEveryPredecessor() public {
        ArbiterPoolV2 next = new ArbiterPoolV2(escrow, multisig, pool);
        ArbiterPoolV2 last = new ArbiterPoolV2(escrow, multisig, next);
        uint256 jobId = _disputedJob();
        vm.warp(pool.disputeDeadline(jobId) - 1 hours);
        uint256 caseId = _openCase(jobId, alice);
        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(next))));
        vm.warp(block.timestamp + 3 days);
        pool.close(caseId); // voided in the first pool
        uint256 again = block.timestamp + 7 days;
        vm.prank(multisig);
        next.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(last))));

        assertEq(last.disputeDeadline(jobId), again);
        vm.expectRevert(abi.encodeWithSelector(ArbiterPoolV2.TooEarly.selector, again));
        last.resolveUnarbitrated(jobId);
        vm.warp(again);
        vm.prank(carol);
        last.resolveUnarbitrated(jobId);
        assertEq(escrow.credits(bob), 10 ether);
        assertEq(registry.getAgent(agentId).jobsFailed, 1);
    }

    /// @notice A pool takes cases only while it is escrow governance: a successor not yet handed over
    ///         cannot, and a retired pool cannot either, so nobody can hold a successor's timeout off by
    ///         opening cases that could only ever void.
    function test_v2_openCase_onlyWhileEscrowGovernance() public {
        ArbiterPoolV2 next = new ArbiterPoolV2(escrow, multisig, pool);
        uint256 jobId = _disputedJob();
        vm.prank(alice);
        vm.expectRevert(ArbiterPoolV2.NotEscrowGovernance.selector);
        next.openCase{value: 1 ether}(jobId, "");

        vm.prank(multisig);
        pool.forward(address(escrow), abi.encodeCall(ServiceEscrow.setGovernance, (address(next))));
        vm.prank(alice);
        vm.expectRevert(ArbiterPoolV2.NotEscrowGovernance.selector);
        pool.openCase{value: 1 ether}(jobId, "");
        (bool open,) = next.caseStatus(jobId);
        assertFalse(open);

        vm.prank(alice);
        uint256 caseId = next.openCase{value: 1 ether}(jobId, "");
        assertEq(next.caseOf(jobId), caseId);
    }

    function test_v2_constructor_predecessorChecks() public {
        // a pool on another escrow: the same job id is another job there
        ServiceEscrow other = new ServiceEscrow(registry, gov, treasury);
        ArbiterPoolV2 foreign = new ArbiterPoolV2(other, multisig, ArbiterPoolV2(address(0)));
        vm.expectRevert(ArbiterPoolV2.InvalidParams.selector);
        new ArbiterPoolV2(escrow, multisig, foreign);
        // the live ArbiterPool has no caseStatus to honour
        ArbiterPool v1 = new ArbiterPool(escrow, multisig);
        vm.expectRevert();
        new ArbiterPoolV2(escrow, multisig, ArbiterPoolV2(address(v1)));

        ArbiterPoolV2 next = new ArbiterPoolV2(escrow, multisig, pool);
        assertEq(address(next.predecessor()), address(pool));
    }
}
