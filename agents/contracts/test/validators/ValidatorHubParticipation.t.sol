// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";

/// @notice The 512-checkpoint participation ring against a plain model, the eligibility cursor,
///         and the certification snapshot.
contract ValidatorHubParticipationTest is ValidatorTestBase {
    /// Random attendance over 700 checkpoints (the ring wraps), checked against a plain array:
    /// participation(id, n) for several n, and attested(id, h) for every checkpoint in range.
    /// forge-config: default.fuzz.runs = 12
    function testFuzz_RingMatchesModel(uint256 seed) public {
        uint256 id = _open(makeAddr("ring"));
        uint256 first = _seat(id).dutyStartCp;
        vm.roll(first * CP + 64);
        uint256 total = 700;
        bool[] memory did = new bool[](total);
        // long gaps as well as noise: 1/8 of the time skip a run of up to 300 checkpoints
        for (uint256 i; i < total; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 8 == 0) {
                uint256 gap = (r >> 8) % 300;
                i += gap;
                if (i >= total) break;
                continue;
            }
            if ((r >> 16) % 3 != 0) {
                uint256 h = (first + i) * CP;
                _enterWindow(h);
                _attestBatch(h, _one(id));
                did[i] = true;
            }
        }
        vm.roll((first + total - 1) * CP + 251); // the last one is closed
        uint256 last = hub.lastClosedCheckpoint();
        assertEq(last, first + total - 1);

        uint256[5] memory windows = [uint256(1), 124, 256, 432, 511];
        for (uint256 w; w < windows.length; ++w) {
            uint256 n = windows[w];
            uint256 want;
            for (uint256 i = total - n; i < total; ++i) {
                if (did[i]) ++want;
            }
            assertEq(hub.participation(id, n), want, "participation window");
        }
        for (uint256 i = total - 511; i < total; ++i) {
            assertEq(hub.attested(id, (first + i) * CP), did[i], "attested bit");
        }
    }

    /// A gap of 512 or more checkpoints clears the whole ring before the new bit is set.
    function test_Ring_GapOfAWholeRingClearsIt() public {
        uint256 id = _open(makeAddr("gap"));
        uint256 first = _seat(id).dutyStartCp;
        for (uint256 i; i < 10; ++i) {
            uint256 h = (first + i) * CP;
            _enterWindow(h);
            _attestBatch(h, _one(id));
        }
        uint256 back = (first + 10 + 600) * CP;
        _enterWindow(back);
        _attestBatch(back, _one(id));
        vm.roll(back + 251);
        assertEq(hub.participation(id, 511), 1, "only the new attestation remains");
        assertTrue(hub.attested(id, back));
        assertFalse(hub.attested(id, (first + 5) * CP), "older than the ring");
    }

    function test_Participation_WindowBounds() public {
        uint256 id = _open(makeAddr("w"));
        vm.expectRevert(ValidatorHub.BadWindow.selector);
        hub.participation(id, 0);
        vm.expectRevert(ValidatorHub.BadWindow.selector);
        hub.participation(id, 512);
        assertEq(hub.participation(id, 511), 0);
    }

    function test_Sync_BoundedStepsAndEvents() public {
        uint256[] memory ids = _openMany(5);
        vm.roll(_seat(ids[4]).activationBlock + ELIG);
        hub.sync(2);
        assertEq(hub.eligibleCount(), 2);
        vm.expectEmit(true, false, false, true, address(hub));
        emit ValidatorHub.SeatEligible(ids[2], 3);
        hub.sync(1);
        hub.sync(100);
        assertEq(hub.eligibleCount(), 5);
        hub.sync(100); // idempotent
        assertEq(hub.eligibleCount(), 5);
        // an exited seat is never counted when the cursor reaches it
        uint256 late = _open(makeAddr("late"));
        vm.prank(makeAddr("late"));
        hub.requestExit(late);
        vm.roll(_seat(late).activationBlock + ELIG);
        hub.sync(100);
        assertEq(hub.eligibleCount(), 5);
    }

    /// A seat that becomes eligible after the checkpoint's snapshot attests and earns, but does
    /// not count toward that checkpoint's certification (it was not in the denominator).
    function test_Snapshot_LateEligibleSeatNotCounted() public {
        uint256 y = _open(makeAddr("y"));
        vm.roll(START + 5_000);
        uint256 x = _open(makeAddr("x"));
        uint256 ex = uint256(_seat(x).activationBlock) + ELIG;
        uint256 h = ((ex - 65) / CP) * CP;
        assertLt(h + 64, ex);
        if (h + 250 < ex) h += CP;
        assertLe(ex, h + 250);
        assertGe(h + 64, uint256(_seat(y).activationBlock) + ELIG);

        _enterWindow(h);
        _attestBatch(h, _one(y)); // snapshot: only y is eligible
        vm.roll(ex);
        vm.setBlockhash(h, _hashOf(h));
        _attestBatch(h, _one(x));
        ValidatorHub.Checkpoint memory cp = hub.checkpoint(h);
        assertEq(cp.eligible, 1);
        assertEq(cp.count, 1, "x became eligible after the snapshot");
        assertEq(cp.total, 2);
        assertEq(hub.eligibleCount(), 2);
    }

    function test_Lens_DecodesEveryField() public {
        address o = makeAddr("lens-owner");
        uint256 id = _open(o);
        vm.roll(_seat(id).activationBlock);
        _fund(1 ether);
        uint256 h = _attestRun(_one(id), 2);
        ValidatorHub.Seat memory s = _seat(id);
        assertEq(uint256(s.lastAttestedCp), h / CP);
        assertEq(uint256(s.claimable), 2 * RATE);

        uint256 pk = _freshPk();
        bytes memory pop = _sign(pk, hub.attesterKeyDigest(o, vm.addr(pk)));
        vm.prank(o);
        hub.rotateAttester(id, vm.addr(pk), pop);
        vm.prank(o);
        hub.setRewardTo(id, address(0xBEEF));
        s = _seat(id);
        assertEq(s.pendingAttester, vm.addr(pk));
        assertEq(uint256(s.attesterRotateBlock), block.number + DAY);
        assertEq(s.rewardTo, address(0xBEEF));

        vm.roll(uint256(s.dutyStartCp + 200) * CP + 251);
        hub.jail(id);
        s = _seat(id);
        assertTrue(s.jailed);
        assertEq(uint256(s.unjailBlock), block.number + DAY);
        assertEq(uint256(s.deposit), DEPOSIT);
        assertEq(s.owner, o);
        assertFalse(s.qualified);
        assertEq(s.slashState, 0);
    }
}
