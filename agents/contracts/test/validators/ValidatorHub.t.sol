// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";

/// @notice Seats, activation queue, attestations, certification, rewards and the budget guard.
contract ValidatorHubSeatsTest is ValidatorTestBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // ================================================================= openSeat

    function test_OpenSeat_RecordsSeatKeysAndMoney() public {
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        vm.expectEmit(true, true, true, true, address(hub));
        emit ValidatorHub.SeatOpened(1, alice, vm.addr(a), START + DAY, START + DAY + ELIG);
        uint256 id = _openWith(alice, a, n);
        assertEq(id, 1);

        ValidatorHub.Seat memory s = _seat(id);
        assertEq(s.owner, alice);
        assertEq(s.attester, vm.addr(a));
        assertEq(uint256(s.deposit), DEPOSIT);
        assertEq(s.status, 1, "bonded");
        assertEq(uint256(s.activationBlock), START + DAY);
        assertEq(uint256(s.dutyStartCp), (START + DAY) / CP + 1);
        assertEq(uint256(s.countedSince), 0);
        assertFalse(s.jailed);

        ValidatorHub.KeyInfo memory k = hub.keyInfo(vm.addr(a));
        assertEq(uint256(k.seatId), 1);
        assertEq(k.role, 1);
        assertTrue(k.active);
        assertEq(lens.enodeOf(id), _pubkey(n));

        assertEq(hub.seatCount(), 1);
        assertEq(hub.occupiedSeats(), 1);
        assertEq(hub.bondedTotal(), DEPOSIT);
        assertEq(address(hub).balance, DEPOSIT);
        assertEq(lens.accounting().totalDeposited, DEPOSIT);
    }

    function test_OpenSeat_RequiresExactly2000() public {
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(alice, att));
        bytes memory pub = _pubkey(n);
        bytes memory nSig = _sign(n, hub.enodeDigest(alice, att));
        vm.deal(alice, 10_000 ether);
        vm.startPrank(alice);
        vm.expectRevert(ValidatorHub.WrongDeposit.selector);
        hub.openSeat{value: DEPOSIT - 1}(att, aSig, pub, nSig);
        vm.expectRevert(ValidatorHub.WrongDeposit.selector);
        hub.openSeat{value: DEPOSIT + 1}(att, aSig, pub, nSig);
        vm.expectRevert(ValidatorHub.WrongDeposit.selector);
        hub.openSeat{value: 2 * DEPOSIT}(att, aSig, pub, nSig);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);
        vm.stopPrank();
    }

    function test_OpenSeat_DeniedOwnerRefused() public {
        assertTrue(hub.denied(premine));
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(premine, att));
        bytes memory nSig = _sign(n, hub.enodeDigest(premine, att));
        bytes memory pub = _pubkey(n);
        vm.deal(premine, DEPOSIT);
        vm.prank(premine);
        vm.expectRevert(ValidatorHub.Denied.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);
    }

    function test_OpenSeat_AttesterPossessionChecked() public {
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory pub = _pubkey(n);
        bytes memory nSig = _sign(n, hub.enodeDigest(alice, att));
        vm.deal(alice, 10 * DEPOSIT);

        // signed by another key
        bytes memory wrongKey = _sign(_freshPk(), hub.attesterKeyDigest(alice, att));
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.openSeat{value: DEPOSIT}(att, wrongKey, pub, nSig);

        // signed for another owner: a copied proof cannot be used by someone else
        bytes memory otherOwner = _sign(a, hub.attesterKeyDigest(bob, att));
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.openSeat{value: DEPOSIT}(att, otherOwner, pub, nSig);

        // signed for another network (chain id is in the domain)
        uint256 cid = block.chainid;
        vm.chainId(39610);
        bytes32 otherChain = hub.attesterKeyDigest(alice, att);
        vm.chainId(cid);
        bytes memory otherNet = _sign(a, otherChain);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.openSeat{value: DEPOSIT}(att, otherNet, pub, nSig);

        // attester may not be the owner, nor zero
        uint256 ownerPk = _freshPk();
        address owner = vm.addr(ownerPk);
        vm.deal(owner, DEPOSIT);
        bytes memory selfSig = _sign(ownerPk, hub.attesterKeyDigest(owner, owner));
        bytes memory selfNode = _sign(n, hub.enodeDigest(owner, owner));
        vm.prank(owner);
        vm.expectRevert(ValidatorHub.BadKey.selector);
        hub.openSeat{value: DEPOSIT}(owner, selfSig, pub, selfNode);
    }

    function test_OpenSeat_KeysNeverReused() public {
        uint256 a = _freshPk();
        _openWith(alice, a, _freshPk());
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(bob, att));
        bytes memory pub = _pubkey(n);
        bytes memory nSig = _sign(n, hub.enodeDigest(bob, att));
        vm.deal(bob, DEPOSIT);
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.KeyUsed.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);
    }

    function test_OpenSeat_EnodeChecked() public {
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(alice, att));
        bytes memory pub = _pubkey(n);
        vm.deal(alice, 10 * DEPOSIT);

        bytes memory shortKey = new bytes(63);
        bytes memory nSig = _sign(n, hub.enodeDigest(alice, att));
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadEnode.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, shortKey, nSig);

        // node key did not sign
        bytes memory forged = _sign(_freshPk(), hub.enodeDigest(alice, att));
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, forged);

        // pubkey of another node
        bytes memory otherPub = _pubkey(_freshPk());
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, otherPub, nSig);
    }

    function test_SetEnode_OwnerReplacesNode() public {
        uint256 id = _open(alice);
        uint256 n2 = _freshPk();
        bytes memory pub = _pubkey(n2);
        bytes memory sig = _sign(n2, hub.enodeDigest(alice, _seat(id).attester));
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotSeatOwner.selector);
        hub.setEnode(id, pub, sig);
        vm.prank(alice);
        hub.setEnode(id, pub, sig);
        assertEq(lens.enodeOf(id), pub);
    }

    function test_OpenSeat_LaunchCapOf100() public {
        _openMany(100);
        assertEq(hub.occupiedSeats(), 100);
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(alice, att));
        bytes memory pub = _pubkey(n);
        bytes memory nSig = _sign(n, hub.enodeDigest(alice, att));
        vm.deal(alice, DEPOSIT);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.SeatsFull.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);

        // an exit frees a seat
        vm.prank(address(uint160(0x10000)));
        hub.requestExit(1);
        vm.prank(alice);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);
    }

    function test_OpenSeat_PausedButExitsNotPaused() public {
        uint256 id = _open(alice);
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.setSeatsPaused(true);
        vm.startPrank(msig);
        hub.setSeatsPaused(true);
        hub.setAttestationsPaused(true);
        vm.stopPrank();

        uint256 a = _freshPk();
        uint256 n = _freshPk();
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(bob, att));
        bytes memory pub = _pubkey(n);
        bytes memory nSig = _sign(n, hub.enodeDigest(bob, att));
        vm.deal(bob, DEPOSIT);
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.Paused.selector);
        hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);

        // exit, unbond and withdraw all work while everything else is paused
        vm.prank(alice);
        hub.requestExit(id);
        vm.roll(block.number + UNBOND);
        uint256 before = alice.balance;
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        assertEq(alice.balance - before, DEPOSIT);
    }

    // ================================================================= activation queue

    function test_Activation_24hThenTenPerDay() public {
        uint256[] memory ids = _openMany(25);
        uint256 first = START + DAY;
        uint256 day = first / DAY;
        for (uint256 i; i < 25; ++i) {
            uint256 act = _seat(ids[i]).activationBlock;
            if (i < 10) assertEq(act, first, "first ten: 24 h after deposit");
            else if (i < 20) assertEq(act, (day + 1) * DAY, "next ten: next day");
            else assertEq(act, (day + 2) * DAY, "then the day after");
        }
    }

    /// Activation blocks never decrease (the eligibility cursor relies on it), are always at least
    /// 24 h after deposit, and no day bucket gets more than activationsPerDay.
    function testFuzz_ActivationQueue(uint16[40] memory gaps) public {
        uint256 prev;
        uint256 lastDay = type(uint256).max;
        uint256 inDay;
        for (uint256 i; i < gaps.length; ++i) {
            vm.roll(block.number + uint256(gaps[i]) % (3 * DAY));
            uint256 deposit = block.number;
            uint256 id = _open(address(uint160(0x20000 + i)));
            uint256 act = _seat(id).activationBlock;
            assertGe(act, deposit + DAY, "activates 24 h after deposit at the earliest");
            assertGe(act, prev, "monotonic");
            uint256 d = act / DAY;
            if (d == lastDay) {
                ++inDay;
            } else {
                lastDay = d;
                inDay = 1;
            }
            assertLe(inDay, 10, "churn limit");
            prev = act;
        }
    }

    // ================================================================= attestations

    function _activeSeat(address owner) internal returns (uint256 id) {
        id = _open(owner);
        vm.roll(_seat(id).activationBlock);
    }

    function test_Attest_InclusionWindow() public {
        uint256 id = _activeSeat(alice);
        uint256 id2 = _open(bob);
        vm.roll(_seat(id2).activationBlock);
        uint256 h = _nextCheckpoint();
        bytes memory sig = _attSig(attPk[id], h, _hashOf(h));
        bytes memory sig2 = _attSig(attPk[id2], h, _hashOf(h));

        vm.roll(h + 63);
        vm.setBlockhash(h, _hashOf(h));
        vm.expectRevert(ValidatorHub.OutsideWindow.selector);
        hub.attest(uint64(h), _hashOf(h), sig);

        vm.roll(h + 64);
        vm.setBlockhash(h, _hashOf(h));
        hub.attest(uint64(h), _hashOf(h), sig);

        vm.roll(h + 250);
        vm.setBlockhash(h, _hashOf(h));
        hub.attest(uint64(h), _hashOf(h), sig2);

        uint256 h2 = h + CP;
        bytes memory late = _attSig(attPk[id], h2, _hashOf(h2));
        vm.roll(h2 + 251);
        vm.setBlockhash(h2, _hashOf(h2));
        vm.expectRevert(ValidatorHub.OutsideWindow.selector);
        hub.attest(uint64(h2), _hashOf(h2), late);
    }

    function test_Attest_WrongHashOrHeightReverts() public {
        uint256 id = _activeSeat(alice);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes32 wrong = keccak256("fork");
        bytes memory s1 = _attSig(attPk[id], h, wrong);
        bytes memory s2 = _attSig(attPk[id], h, bytes32(0));
        bytes memory s3 = _attSig(attPk[id], h + 1, _hashOf(h));
        bytes memory s4 = _attSig(attPk[id], 0, _hashOf(0));
        vm.expectRevert(ValidatorHub.WrongBlockHash.selector);
        hub.attest(uint64(h), wrong, s1);
        vm.expectRevert(ValidatorHub.WrongBlockHash.selector);
        hub.attest(uint64(h), bytes32(0), s2);
        vm.expectRevert(ValidatorHub.NotCheckpoint.selector);
        hub.attest(uint64(h + 1), _hashOf(h), s3);
        vm.expectRevert(ValidatorHub.NotCheckpoint.selector);
        hub.attest(0, _hashOf(0), s4);
    }

    function test_Attest_ReplayFromAnotherHubOrNetworkRejected() public {
        uint256 id = _activeSeat(alice);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes32 hash = _hashOf(h);

        ValidatorHub other = new ValidatorHub(msig, address(sink), new address[](0));
        bytes memory otherHub = _sign(attPk[id], other.attestationDigest(uint64(h), hash));
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 2));
        hub.attest(uint64(h), hash, otherHub);

        uint256 cid = block.chainid;
        vm.chainId(39610);
        bytes32 d = hub.attestationDigest(uint64(h), hash);
        vm.chainId(cid);
        bytes memory otherNet = _sign(attPk[id], d);
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 2));
        hub.attest(uint64(h), hash, otherNet);

        hub.attest(uint64(h), hash, _attSig(attPk[id], h, hash));
    }

    function test_Attest_PendingSeatRejected() public {
        uint256 id = _open(alice);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        assertLt(block.number, _seat(id).activationBlock);
        bytes memory sig = _attSig(attPk[id], h, _hashOf(h));
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 3));
        hub.attest(uint64(h), _hashOf(h), sig);
    }

    function test_Attest_DuplicateAndBadSignature() public {
        uint256 id = _activeSeat(alice);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes32 hash = _hashOf(h);
        bytes memory sig = _attSig(attPk[id], h, hash);
        hub.attest(uint64(h), hash, sig);
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 4));
        hub.attest(uint64(h), hash, sig);
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 1));
        hub.attest(uint64(h), hash, new bytes(65));
        bytes memory stranger = _attSig(_freshPk(), h, hash);
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 2));
        hub.attest(uint64(h), hash, stranger);
        assertTrue(hub.attested(id, h));
        assertFalse(hub.attested(id, h - CP));
    }

    function test_AttestBatch_SkipsBadEntries() public {
        uint256 a = _activeSeat(alice);
        uint256 b = _open(bob);
        vm.roll(_seat(b).activationBlock);
        _fund(10 ether);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes32 hash = _hashOf(h);
        bytes memory blob = bytes.concat(
            _attSig(attPk[a], h, hash),
            new bytes(65), // malformed
            _attSig(_freshPk(), h, hash), // unknown key
            _attSig(attPk[a], h, hash), // duplicate
            _attSig(attPk[b], h, hash)
        );
        vm.prank(relay);
        uint256 accepted = hub.attestBatch(uint64(h), hash, blob);
        assertEq(accepted, 2);
        ValidatorHub.Checkpoint memory cp = hub.checkpoint(h);
        assertEq(cp.total, 2);
        assertEq(cp.blockHash, hash);
        assertEq(uint256(_seat(a).claimable), RATE);
        assertEq(uint256(_seat(b).claimable), RATE);

        vm.expectRevert(ValidatorHub.BadSignatureBlob.selector);
        hub.attestBatch(uint64(h), hash, new bytes(64));
        vm.expectRevert(ValidatorHub.BadSignatureBlob.selector);
        hub.attestBatch(uint64(h), hash, "");
    }

    function test_Attest_SelfSubmissionByAttesterWorks() public {
        uint256 id = _activeSeat(alice);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        address att = _seat(id).attester;
        vm.prank(att);
        assertEq(hub.attest(uint64(h), _hashOf(h), _attSig(attPk[id], h, _hashOf(h))), id);
    }

    // ================================================================= rewards

    function test_Rewards_PaidFromPoolAndClaimed() public {
        uint256 id = _activeSeat(alice);
        _fund(1 ether);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        vm.expectEmit(true, true, false, true, address(hub));
        emit ValidatorHub.Attested(id, h, RATE);
        hub.attest(uint64(h), _hashOf(h), _attSig(attPk[id], h, _hashOf(h)));
        assertEq(hub.rewardPool(), 1 ether - RATE);
        assertEq(uint256(_seat(id).claimable), RATE);

        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotSeatOwner.selector);
        hub.claim(id, payable(bob));

        uint256 before = bob.balance;
        vm.prank(alice);
        hub.claim(id, payable(bob));
        assertEq(bob.balance - before, RATE);
        assertEq(uint256(_seat(id).claimable), 0);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NothingToPay.selector);
        hub.claim(id, payable(bob));
        assertEq(lens.accounting().totalClaimed, RATE);
    }

    function test_Rewards_ClaimToAttesterForGas() public {
        uint256 id = _activeSeat(alice);
        _fund(1 ether);
        _attestRun(_one(id), 4);
        address att = _seat(id).attester;
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NothingToPay.selector);
        hub.claimToAttester(id, 4 * RATE + 1);
        vm.prank(alice);
        hub.claimToAttester(id, 3 * RATE);
        assertEq(att.balance, 3 * RATE);
        assertEq(uint256(_seat(id).claimable), RATE);
    }

    function test_Rewards_EmptyPoolPaysZeroButCounts() public {
        uint256 id = _activeSeat(alice);
        assertEq(hub.rewardPool(), 0);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        vm.expectEmit(true, true, false, true, address(hub));
        emit ValidatorHub.Attested(id, h, 0);
        hub.attest(uint64(h), _hashOf(h), _attSig(attPk[id], h, _hashOf(h)));
        assertEq(uint256(_seat(id).claimable), 0);
        assertEq(hub.checkpoint(h).total, 1);
        assertTrue(hub.attested(id, h));
    }

    function test_Rewards_PartialPoolFailsClosed() public {
        uint256 a = _activeSeat(alice);
        uint256 b = _open(bob);
        vm.roll(_seat(b).activationBlock);
        _fund(RATE + RATE / 2);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        _attestBatch(h, ids);
        assertEq(uint256(_seat(a).claimable), RATE);
        assertEq(uint256(_seat(b).claimable), 0, "pool no longer covers a full reward");
        assertEq(hub.rewardPool(), RATE / 2);
        assertEq(hub.checkpoint(h).total, 2);
    }

    function testFuzz_Rewards_NeverExceedFunding(uint256 funded, uint8 seats, uint8 rounds) public {
        funded = bound(funded, 0, 5 ether);
        uint256 n = bound(seats, 1, 12);
        uint256 r = bound(rounds, 1, 6);
        uint256[] memory ids = _openMany(n);
        vm.roll(_seat(ids[n - 1]).activationBlock);
        _fund(funded);
        _attestRun(ids, r);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += _seat(ids[i]).claimable;
        }
        assertLe(sum, funded, "allocated more than funded");
        assertEq(sum + hub.rewardPool(), funded, "pool conserved");
    }

    function test_Funding_ReceiveAndSinkTranche() public {
        vm.deal(address(sink), 26_500 ether);
        vm.prank(msig);
        sink.withdraw(payable(address(hub)), 20_000 ether);
        assertEq(hub.rewardPool(), 20_000 ether);
        (bool ok,) = address(hub).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(hub.rewardPool(), 20_001 ether);
        assertEq(lens.accounting().totalFunded, 20_001 ether);
        // runway at 100 seats x 0.025 FMX: 20,001 / 2.5 = 8,000 checkpoints ~ 129 days
        assertEq(lens.runwayDays(), 129);
    }

    function test_ReturnExcess_KeepsOneEightyDays() public {
        _fund(50_000 ether);
        uint256 reserve = 100 * RATE * 11_109;
        uint256 before = address(sink).balance;
        vm.prank(bob);
        uint256 excess = hub.returnExcess();
        assertEq(excess, 50_000 ether - reserve);
        assertEq(address(sink).balance - before, excess);
        assertEq(hub.rewardPool(), reserve);
        vm.expectRevert(ValidatorHub.NothingToPay.selector);
        hub.returnExcess();
    }

    // ================================================================= budget guard and halving

    function test_BudgetGuard_And_Caps() public {
        // before 30 days: max 100 seats
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(0, 300);
        vm.roll(START + 370_286);
        _setParam(0, 300); // 300 x 0.025 = 7.5 FMX: exactly at the guard
        assertEq(hub.maxSeats(), 300);
        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(0, 301); // 7.525 FMX
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(1, 0.026 ether); // 300 x 0.026 = 7.8
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(0, 1_001); // hard ceiling
        vm.stopPrank();
        _setParam(1, 0.0075 ether);
        _setParam(0, 1_000); // 1,000 x 0.0075 = 7.5
        assertEq(hub.maxSeats(), 1_000);
        assertEq(hub.currentRewardPerAttest(), 0.0075 ether);

        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(1, 0.051 ether); // above the 0.05 ceiling whatever the seat count
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(2, 51);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(2, 0);
        vm.stopPrank();
        _setParam(2, 50);
        assertEq(hub.activationsPerDay(), 50);
    }

    function test_BudgetGuard_MaxSeatsNotBelowOccupied() public {
        _openMany(5);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(0, 4);
        _setParam(0, 5);
    }

    function test_Halving_AtBlock4500000() public {
        assertEq(hub.currentRewardPerAttest(), RATE);
        assertFalse(hub.halvingActive());
        vm.roll(4_500_000);
        assertTrue(hub.halvingActive());
        assertEq(hub.currentRewardPerAttest(), RATE / 2);
    }

    function test_Halving_AtV() public {
        uint256 v = 1_110_000; // a multiple of 30,000 past the timelock
        _setParam(3, v);
        assertEq(hub.openSeatsBlock(), v);
        assertEq(hub.currentRewardPerAttest(), RATE);
        vm.roll(v);
        assertEq(hub.currentRewardPerAttest(), RATE / 2);
        // V is set once
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(3, 1_200_000);
    }

    function test_OpenSeatsBlock_MustBeEpochMultipleInFuture() public {
        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(3, 1_110_001);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(3, 1_020_000); // before the timelock ends
        vm.stopPrank();
    }

    // ================================================================= certification

    function test_Certification_ThresholdAndThirtySeatFloor() public {
        uint256[] memory ids = _openMany(45);
        vm.roll(_seat(ids[44]).activationBlock + ELIG);
        hub.sync(1_000);
        assertEq(hub.eligibleCount(), 45);

        // 45 eligible: need max(20, ceil(30)) = 30
        uint256[] memory some = new uint256[](29);
        for (uint256 i; i < 29; ++i) {
            some[i] = ids[i];
        }
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        _attestBatch(h, some);
        assertFalse(hub.checkpoint(h).certified);
        assertEq(hub.checkpoint(h).eligible, 45);
        vm.expectEmit(true, false, false, true, address(hub));
        emit ValidatorHub.CheckpointCertified(h, _hashOf(h), 30, 45);
        _attestBatch(h, _one(ids[29]));
        assertTrue(hub.isCertified(h, _hashOf(h)));
        assertFalse(hub.isCertified(h, keccak256("other")));
    }

    function test_Certification_NeverBelowThirtyEligible() public {
        uint256[] memory ids = _openMany(29);
        vm.roll(_seat(ids[28]).activationBlock + ELIG);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        _attestBatch(h, ids);
        ValidatorHub.Checkpoint memory cp = hub.checkpoint(h);
        assertEq(cp.eligible, 29);
        assertEq(cp.count, 29, "all attested");
        assertFalse(cp.certified, "no certified claim below 30 eligible seats");
    }

    function test_Certification_OnlyEligibleSeatsCount() public {
        uint256[] memory ids = _openMany(40);
        // the first 30 are eligible, the last 10 are active but inside their first 7 days
        vm.roll(_seat(ids[29]).activationBlock + ELIG);
        assertLt(block.number, _seat(ids[39]).activationBlock + ELIG);
        assertGe(block.number, _seat(ids[39]).activationBlock);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        uint256[] memory late = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            late[i] = ids[30 + i];
        }
        _attestBatch(h, late);
        ValidatorHub.Checkpoint memory cp = hub.checkpoint(h);
        assertEq(cp.total, 10);
        assertEq(cp.count, 0, "not yet eligible: attests and earns, does not count");
        assertEq(cp.eligible, 30);
    }

    function testFuzz_CertificationRule(uint32 count, uint32 eligible) public view {
        uint256 e = eligible;
        uint256 need = e * 2 / 3 + (e * 2 % 3 == 0 ? 0 : 1);
        if (need < 20) need = 20;
        bool expected = eligible >= 30 && count >= need;
        assertEq(hub.certifies(count, eligible), expected);
    }

    // ================================================================= constructor, ownership

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert(ValidatorHub.ZeroAddress.selector);
        new ValidatorHub(address(0), address(sink), new address[](0));
        vm.expectRevert(ValidatorHub.ZeroAddress.selector);
        new ValidatorHub(msig, address(0), new address[](0));
        assertEq(hub.owner(), msig);
        assertEq(hub.rewardSink(), address(sink));
        assertEq(hub.deployBlock(), START);
        assertEq(hub.vetoSunsetBlock(), START + 2_221_715);
    }

    function test_Ownership_TwoStep() public {
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.transferOwnership(bob);
        vm.prank(msig);
        hub.transferOwnership(bob);
        assertEq(hub.owner(), msig);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.acceptOwnership();
        vm.prank(bob);
        hub.acceptOwnership();
        assertEq(hub.owner(), bob);
    }

    function test_Timelock_QueueApplyCancel() public {
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.queueParam(2, 20);
        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.NotQueued.selector);
        hub.applyParam(2, 20);
        hub.queueParam(2, 20);
        vm.expectRevert(ValidatorHub.AlreadyQueued.selector);
        hub.queueParam(2, 20);
        vm.roll(block.number + TIMELOCK - 1);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.applyParam(2, 20);
        hub.cancelParam(2, 20);
        vm.roll(block.number + 1);
        vm.expectRevert(ValidatorHub.NotQueued.selector);
        hub.applyParam(2, 20);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(9, 1);
        vm.stopPrank();
    }

    function test_DenyList_Timelocked() public {
        _setParam(5, uint256(uint160(alice)));
        assertTrue(hub.denied(alice));
        _setParam(6, uint256(uint160(alice)));
        assertFalse(hub.denied(alice));
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(5, 0);
    }
}
