// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";

/// @notice Jail and unjail, exit and unbonding, attester rotation, double-attestation slashing
///         with the veto-only window and its sunset.
contract ValidatorHubLifecycleTest is ValidatorTestBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal id;
    uint256 internal dutyCp;

    function setUp() public override {
        super.setUp();
        id = _open(alice);
        dutyCp = _seat(id).dutyStartCp;
    }

    /// Attest checkpoints dutyCp + i, for every i in [from, to), with `ids`.
    function _attestCps(uint256[] memory ids, uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to; ++i) {
            uint256 h = (dutyCp + i) * CP;
            _enterWindow(h);
            _attestBatch(h, ids);
        }
    }

    /// First block at which checkpoint index `cp` counts as closed.
    function _closedAt(uint256 cp) internal pure returns (uint256) {
        return cp * CP + 251;
    }

    // ================================================================= jail

    function test_Jail_AfterFullWindowBelowHalf() public {
        vm.roll(_closedAt(dutyCp + 122));
        vm.expectRevert(ValidatorHub.NotJailable.selector);
        hub.jail(id); // only 123 checkpoints on duty so far

        vm.roll(_closedAt(dutyCp + 123));
        assertEq(hub.participation(id, 124), 0);
        vm.expectEmit(true, false, false, true, address(hub));
        emit ValidatorHub.Jailed(id, 0, 124, block.number + DAY);
        vm.prank(carol); // permissionless
        hub.jail(id);

        ValidatorHub.Seat memory s = _seat(id);
        assertTrue(s.jailed);
        assertEq(uint256(s.deposit), DEPOSIT, "downtime never costs deposit");
        assertEq(s.status, 1);
        assertEq(hub.bondedTotal(), DEPOSIT);

        vm.expectRevert(ValidatorHub.NotJailable.selector);
        hub.jail(id);
    }

    function test_Jail_BoundaryIsFiftyPercent() public {
        uint256 other = _open(bob);
        assertEq(_seat(other).dutyStartCp, dutyCp);
        uint256[] memory both = new uint256[](2);
        both[0] = id;
        both[1] = other;
        _attestCps(both, 0, 61); // both attest 61 checkpoints ...
        _attestCps(_one(id), 61, 62); // ... and `id` one more: exactly 50% against 61/124
        vm.roll(_closedAt(dutyCp + 123));
        assertEq(hub.participation(id, 124), 62);
        assertEq(hub.participation(other, 124), 61);
        vm.expectRevert(ValidatorHub.NotJailable.selector);
        hub.jail(id);
        hub.jail(other);
    }

    function test_Jail_JailedSeatCannotAttestAndUnjailsAfter24h() public {
        vm.roll(_closedAt(dutyCp + 123));
        hub.jail(id);
        uint256 jailedAt = block.number;

        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes memory sig = _attSig(attPk[id], h, _hashOf(h));
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 3));
        hub.attest(uint64(h), _hashOf(h), sig);

        vm.prank(alice);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.unjail(id);
        vm.roll(jailedAt + DAY);
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotSeatOwner.selector);
        hub.unjail(id);
        vm.prank(alice);
        hub.unjail(id);

        ValidatorHub.Seat memory s = _seat(id);
        assertFalse(s.jailed);
        assertEq(uint256(s.dutyStartCp), block.number / CP + 1, "measured afresh");
        // cannot be jailed again until a new full window has passed
        vm.roll(_closedAt(s.dutyStartCp + 122));
        vm.expectRevert(ValidatorHub.NotJailable.selector);
        hub.jail(id);
        vm.roll(_closedAt(s.dutyStartCp + 123));
        hub.jail(id);
    }

    function test_Jail_LeavesAndRejoinsEligibleCount() public {
        vm.roll(_seat(id).activationBlock + ELIG + 124 * CP);
        hub.sync(10);
        assertEq(hub.eligibleCount(), 1);
        hub.jail(id);
        assertEq(hub.eligibleCount(), 0);
        assertEq(uint256(_seat(id).countedSince), 0);
        vm.roll(block.number + DAY);
        vm.prank(alice);
        hub.unjail(id);
        assertEq(hub.eligibleCount(), 1);
        assertEq(uint256(_seat(id).countedSince), block.number);
    }

    function test_Jail_NotDuringAttestationPauseAndDutyResetsAfter() public {
        vm.roll(_closedAt(dutyCp + 200));
        vm.prank(msig);
        hub.setAttestationsPaused(true);
        vm.expectRevert(ValidatorHub.Paused.selector);
        hub.jail(id);
        vm.roll(block.number + 5 * DAY);
        vm.prank(msig);
        hub.setAttestationsPaused(false);
        uint256 g = hub.globalDutyStartCp();
        assertEq(g, block.number / CP + 1);
        vm.expectRevert(ValidatorHub.NotJailable.selector);
        hub.jail(id); // the paused stretch does not count against anyone
        vm.roll(_closedAt(g + 123));
        hub.jail(id);
    }

    function test_Attest_PausedReverts() public {
        vm.roll(_seat(id).activationBlock);
        vm.prank(msig);
        hub.setAttestationsPaused(true);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes memory sig = _attSig(attPk[id], h, _hashOf(h));
        vm.expectRevert(ValidatorHub.Paused.selector);
        hub.attest(uint64(h), _hashOf(h), sig);
    }

    // ================================================================= exit and unbonding

    function test_Exit_UnbondThenWithdrawOnce() public {
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotSeatOwner.selector);
        hub.requestExit(id);
        vm.prank(alice);
        hub.requestExit(id);
        ValidatorHub.Seat memory s = _seat(id);
        assertEq(s.status, 2);
        assertEq(uint256(s.unbondEndBlock), block.number + UNBOND);
        assertEq(hub.occupiedSeats(), 0);
        assertFalse(hub.keyInfo(s.attester).active, "rewards stop at once");

        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.requestExit(id);

        vm.roll(block.number + UNBOND - 1);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.withdraw(id, payable(alice));
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.ZeroAddress.selector);
        hub.withdraw(id, payable(address(0)));
        uint256 before = alice.balance;
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        assertEq(alice.balance - before, DEPOSIT);
        assertEq(_seat(id).status, 3);
        assertEq(hub.bondedTotal(), 0);
        assertEq(address(hub).balance, 0);

        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.withdraw(id, payable(alice));
    }

    function test_Exit_ExitedSeatCannotAttest() public {
        vm.roll(_seat(id).activationBlock);
        vm.prank(alice);
        hub.requestExit(id);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes memory sig = _attSig(attPk[id], h, _hashOf(h));
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 2));
        hub.attest(uint64(h), _hashOf(h), sig);
    }

    function test_Exit_RewardsStayClaimableAfterWithdraw() public {
        vm.roll(_seat(id).activationBlock);
        _fund(1 ether);
        _attestRun(_one(id), 3);
        vm.prank(alice);
        hub.requestExit(id);
        vm.roll(block.number + UNBOND);
        vm.startPrank(alice);
        hub.withdraw(id, payable(alice));
        uint256 got = hub.claim(id, payable(alice));
        vm.stopPrank();
        assertEq(got, 3 * RATE);
    }

    // ================================================================= attester rotation

    function test_RotateAttester_After24h() public {
        vm.roll(_seat(id).activationBlock);
        uint256 newPk = _freshPk();
        address newKey = vm.addr(newPk);
        bytes memory pop = _sign(newPk, hub.attesterKeyDigest(alice, newKey));

        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotSeatOwner.selector);
        hub.rotateAttester(id, newKey, pop);
        bytes memory badPop = _sign(newPk, hub.attesterKeyDigest(bob, newKey));
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.rotateAttester(id, newKey, badPop);

        vm.prank(alice);
        hub.rotateAttester(id, newKey, pop);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.applyAttesterRotation(id);

        // the current key keeps attesting during the delay
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        _attestBatch(h, _one(id));
        assertTrue(hub.attested(id, h));

        vm.roll(block.number + DAY);
        vm.prank(carol);
        hub.applyAttesterRotation(id); // permissionless
        assertEq(_seat(id).attester, newKey);
        assertFalse(hub.keyInfo(vm.addr(attPk[id])).active);

        uint256 h2 = _nextCheckpoint();
        _enterWindow(h2);
        bytes memory oldSig = _attSig(attPk[id], h2, _hashOf(h2));
        vm.expectRevert(abi.encodeWithSelector(ValidatorHub.AttestationRejected.selector, 2));
        hub.attest(uint64(h2), _hashOf(h2), oldSig);
        hub.attest(uint64(h2), _hashOf(h2), _attSig(newPk, h2, _hashOf(h2)));
    }

    // ================================================================= slashing

    function _doubleSigs(uint256 pk, uint256 h) internal view returns (bytes memory a, bytes memory b) {
        a = _attSig(pk, h, _hashOf(h));
        b = _attSig(pk, h, keccak256(abi.encode("other branch", h)));
    }

    function _prove(uint256 pk, uint256 h) internal returns (uint256 slashId) {
        (bytes memory a, bytes memory b) = _doubleSigs(pk, h);
        vm.prank(carol);
        slashId = hub.proveDoubleAttestation(uint64(h), _hashOf(h), a, keccak256(abi.encode("other branch", h)), b);
    }

    function test_Slash_DoubleAttestationFullFlow() public {
        vm.roll(_seat(id).activationBlock);
        uint256 h = 1_012_400;
        uint256 slashId = _prove(attPk[id], h);
        assertEq(slashId, 1);

        ValidatorHub.Slash memory sl = lens.slash(slashId);
        assertEq(uint256(sl.seatId), id);
        assertEq(sl.kind, 1);
        assertEq(sl.status, 1);
        assertEq(uint256(sl.amount), 200 ether, "10% of the deposit");
        assertEq(sl.reporter, carol);
        assertEq(uint256(sl.height), h);
        assertEq(uint256(sl.executableBlock), block.number + 24_686);
        assertEq(uint256(sl.vetoSunsetBlock), START + 2_221_715);

        ValidatorHub.Seat memory s = _seat(id);
        assertEq(s.status, 2, "ejected into unbonding");
        assertEq(s.slashState, 1);
        assertFalse(hub.keyInfo(s.attester).active, "key banned");
        assertEq(hub.occupiedSeats(), 0);

        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.executeSlash(slashId);
        vm.roll(sl.executableBlock);
        uint256 deadBefore = DEAD.balance;
        vm.prank(bob); // permissionless
        hub.executeSlash(slashId);
        assertEq(uint256(_seat(id).deposit), 1_800 ether);
        assertEq(hub.credits(carol), 20 ether, "10% of the slash to the reporter");
        assertEq(DEAD.balance - deadBefore, 180 ether, "the rest burned");
        assertEq(hub.bondedTotal(), 1_800 ether);
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(t.totalSlashed, 200 ether);
        assertEq(t.totalBurned, 180 ether);
        vm.expectRevert(ValidatorHub.SlashNotPending.selector);
        hub.executeSlash(slashId);

        vm.prank(carol);
        hub.withdrawCredit(payable(carol));
        assertEq(carol.balance, 20 ether);
        vm.prank(carol);
        vm.expectRevert(ValidatorHub.NothingToPay.selector);
        hub.withdrawCredit(payable(carol));

        vm.roll(s.unbondEndBlock);
        uint256 before = alice.balance;
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        assertEq(alice.balance - before, 1_800 ether);
        assertEq(address(hub).balance, 0);
    }

    function _expectBadEvidence(uint256 h, bytes32 hA, bytes memory a, bytes32 hB, bytes memory b) internal {
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleAttestation(uint64(h), hA, a, hB, b);
    }

    function test_Slash_BadEvidenceRejected() public {
        uint256 h = 1_012_400;
        bytes32 hA = _hashOf(h);
        bytes32 hB = keccak256("b");
        uint256 pk = attPk[id];
        bytes memory a = _attSig(pk, h, hA);

        _expectBadEvidence(h, hA, a, hA, a); // same hash
        _expectBadEvidence(h, hA, a, hB, _attSig(_freshPk(), h, hB)); // two keys
        _expectBadEvidence(h + 1, hA, _attSig(pk, h + 1, hA), hB, _attSig(pk, h + 1, hB)); // not a checkpoint
        uint256 otherPk = _freshPk();
        _expectBadEvidence(h, hA, _attSig(otherPk, h, hA), hB, _attSig(otherPk, h, hB)); // unregistered key
        _expectBadEvidence(h, hA, a, hB, a); // signature does not cover hash B

        // a signature made for another network recovers to a different key
        uint256 cid = block.chainid;
        vm.chainId(39610);
        bytes32 dB = hub.attestationDigest(uint64(h), hB);
        vm.chainId(cid);
        _expectBadEvidence(h, hA, a, hB, _sign(pk, dB));

        hub.proveDoubleAttestation(uint64(h), hA, a, hB, _attSig(pk, h, hB));
    }

    function test_Slash_EvidenceUsedOnceAndOneSlashPerSeat() public {
        uint256 h = 1_012_400;
        _prove(attPk[id], h);
        (bytes memory a, bytes memory b) = _doubleSigs(attPk[id], h);
        bytes32 hB = keccak256(abi.encode("other branch", h));
        vm.expectRevert(ValidatorHub.EvidenceUsed.selector);
        hub.proveDoubleAttestation(uint64(h), _hashOf(h), a, hB, b);

        // another offence while one is pending: rejected
        (bytes memory a2, bytes memory b2) = _doubleSigs(attPk[id], h + CP);
        bytes32 hB2 = keccak256(abi.encode("other branch", h + CP));
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.proveDoubleAttestation(uint64(h + CP), _hashOf(h + CP), a2, hB2, b2);

        // and after execution: a seat is slashed at most once
        vm.roll(block.number + 24_686);
        hub.executeSlash(1);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.proveDoubleAttestation(uint64(h + CP), _hashOf(h + CP), a2, hB2, b2);
        assertEq(uint256(_seat(id).deposit), 1_800 ether);
    }

    function test_Veto_OnlyMultisigOnlyInsideWindow() public {
        uint256 slashId = _prove(attPk[id], 1_012_400);
        vm.prank(carol);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.veto(slashId);

        vm.roll(block.number + 24_685);
        vm.prank(msig);
        hub.veto(slashId);
        assertEq(lens.slash(slashId).status, 3);
        ValidatorHub.Seat memory s = _seat(id);
        assertEq(s.slashState, 0);
        assertEq(s.status, 2, "stays ejected");
        assertEq(uint256(s.deposit), DEPOSIT);
        vm.expectRevert(ValidatorHub.SlashNotPending.selector);
        hub.executeSlash(slashId);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.SlashNotPending.selector);
        hub.veto(slashId);

        // full deposit back after the unbond
        vm.roll(s.unbondEndBlock);
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        assertEq(alice.balance, DEPOSIT);
    }

    function test_Veto_ClosedAtExecutableBlock() public {
        uint256 slashId = _prove(attPk[id], 1_012_400);
        vm.roll(block.number + 24_686);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.VetoClosed.selector);
        hub.veto(slashId);
        hub.executeSlash(slashId);
    }

    function test_Veto_SunsetsAfter180Days() public {
        uint256 sunset = START + 2_221_715;
        assertEq(hub.vetoSunsetBlock(), sunset);
        vm.roll(sunset - 100);
        uint256 slashId = _prove(attPk[id], 1_012_400);
        vm.roll(sunset);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.VetoClosed.selector);
        hub.veto(slashId);
    }

    function test_Slash_EvidenceDuringUnbondBlocksWithdrawUntilDecided() public {
        vm.prank(alice);
        hub.requestExit(id);
        uint256 end = _seat(id).unbondEndBlock;
        vm.roll(end - 10);
        uint256 slashId = _prove(attPk[id], 1_012_400);
        assertEq(uint256(_seat(id).unbondEndBlock), end, "unbond clock unchanged");
        vm.roll(end);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.withdraw(id, payable(alice));
        vm.roll(lens.slash(slashId).executableBlock);
        hub.executeSlash(slashId);
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        assertEq(alice.balance, 1_800 ether);
    }

    function test_Slash_NotAfterWithdraw() public {
        vm.prank(alice);
        hub.requestExit(id);
        vm.roll(block.number + UNBOND);
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        (bytes memory a, bytes memory b) = _doubleSigs(attPk[id], 1_012_400);
        bytes32 hB = keccak256(abi.encode("other branch", uint256(1_012_400)));
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.proveDoubleAttestation(1_012_400, _hashOf(1_012_400), a, hB, b);
    }

    function test_Slash_RotatedOutKeyStillBoundToSeat() public {
        uint256 oldPk = attPk[id];
        uint256 newPk = _freshPk();
        bytes memory pop = _sign(newPk, hub.attesterKeyDigest(alice, vm.addr(newPk)));
        vm.prank(alice);
        hub.rotateAttester(id, vm.addr(newPk), pop);
        vm.roll(block.number + DAY);
        hub.applyAttesterRotation(id);
        uint256 slashId = _prove(oldPk, 1_012_400);
        assertEq(uint256(lens.slash(slashId).seatId), id);
    }

    function _expectStaleEvidence(uint256 pk, uint256 h) internal {
        (bytes memory a, bytes memory b) = _doubleSigs(pk, h);
        vm.prank(carol);
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleAttestation(uint64(h), _hashOf(h), a, keccak256(abi.encode("other branch", h)), b);
    }

    function test_Slash_ReplacedKeyIsEvidenceForOneUnbondOnly() public {
        uint256 oldPk = attPk[id];
        uint256 newPk = _freshPk();
        bytes memory pop = _sign(newPk, hub.attesterKeyDigest(alice, vm.addr(newPk)));
        vm.prank(alice);
        hub.rotateAttester(id, vm.addr(newPk), pop);
        assertEq(lens.keyRetiredAt(vm.addr(oldPk)), 0, "still the attester while the rotation waits");
        vm.roll(block.number + DAY);
        hub.applyAttesterRotation(id);
        uint256 retired = block.number;
        assertEq(lens.keyRetiredAt(vm.addr(oldPk)), retired);
        assertEq(lens.keyRetiredAt(vm.addr(newPk)), 0);

        // up to the last block of the window the old key is still evidence against the seat
        uint256 snap = vm.snapshotState();
        vm.roll(retired + UNBOND - 1);
        assertEq(uint256(lens.slash(_prove(oldPk, 1_012_400)).seatId), id);
        vm.revertToState(snap);

        // then a leaked old key (a sold or decommissioned PC) can no longer slash the seat
        vm.roll(retired + UNBOND);
        _expectStaleEvidence(oldPk, 1_012_400);
        _expectStaleEvidence(oldPk, 1_000_000);
        assertEq(hub.slashCount(), 0);
        assertEq(_seat(id).status, 1, "the seat stays bonded");
        // the current key stays evidence for as long as it is the seat's key
        assertEq(uint256(lens.slash(_prove(newPk, 1_012_400)).seatId), id);
    }

    function test_Slash_SupersededPendingKeyRetiresToo() public {
        uint256 k1 = _freshPk();
        uint256 k2 = _freshPk();
        bytes memory pop1 = _sign(k1, hub.attesterKeyDigest(alice, vm.addr(k1)));
        bytes memory pop2 = _sign(k2, hub.attesterKeyDigest(alice, vm.addr(k2)));
        vm.prank(alice);
        hub.rotateAttester(id, vm.addr(k1), pop1);
        vm.roll(block.number + 10);
        vm.prank(alice);
        hub.rotateAttester(id, vm.addr(k2), pop2);
        uint256 retired = block.number;
        assertEq(lens.keyRetiredAt(vm.addr(k1)), retired);
        assertEq(uint256(hub.keyInfo(vm.addr(k1)).seatId), id, "still bound to the seat, never reused");
        vm.roll(retired + UNBOND);
        _expectStaleEvidence(k1, 1_012_400);
        hub.applyAttesterRotation(id);
        assertEq(_seat(id).attester, vm.addr(k2));
    }

    function test_Slash_BurnFailureParksAndFlushes() public {
        vm.etch(DEAD, hex"60006000fd"); // revert(0, 0)
        uint256 slashId = _prove(attPk[id], 1_012_400);
        vm.roll(block.number + 24_686);
        hub.executeSlash(slashId);
        assertEq(lens.accounting().pendingBurn, 180 ether);
        vm.expectRevert(ValidatorHub.TransferFailed.selector);
        hub.flushBurn();
        vm.etch(DEAD, "");
        hub.flushBurn();
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(t.pendingBurn, 0);
        assertEq(t.totalBurned, 180 ether);
        assertEq(DEAD.balance, 180 ether);
        vm.expectRevert(ValidatorHub.NothingToPay.selector);
        hub.flushBurn();
    }

    function test_Slash_OwnerHasNoPathToStartOne() public {
        // the multisig can submit evidence like anyone else, and invalid evidence fails for it too
        bytes memory junk = new bytes(65);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleAttestation(1_012_400, keccak256("a"), junk, keccak256("b"), junk);
        assertEq(hub.slashCount(), 0);
    }
}
