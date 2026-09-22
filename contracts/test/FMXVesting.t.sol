// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FMXVesting} from "../src/FMXVesting.sol";

/// @dev Beneficiary that refuses native transfers — exercises the failure branch in release().
contract RejectingBeneficiary {
    // no receive / no fallback
}

contract FMXVestingTest is Test {
    FMXVesting internal vesting;

    address internal beneficiary = makeAddr("beneficiary");
    address internal funder = makeAddr("funder");

    uint64 internal constant T0 = 1_700_000_000;
    uint64 internal constant CLIFF = 180 days;
    uint64 internal constant DURATION = 1080 days;
    uint256 internal constant ALLOC = 5_000_000 ether;

    event Released(uint256 amount);
    event Funded(address indexed from, uint256 amount);

    function setUp() public {
        vm.warp(T0);
        vesting = new FMXVesting(beneficiary, T0, CLIFF, DURATION);
        vm.deal(funder, 10_000_000 ether);
    }

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        (bool ok,) = address(vesting).call{value: amount}("");
        assertTrue(ok);
    }

    // ---------------------------------------------------------- constructor

    function test_Constructor_SetsImmutables() public view {
        assertEq(vesting.beneficiary(), beneficiary);
        assertEq(vesting.start(), T0);
        assertEq(vesting.cliff(), CLIFF);
        assertEq(vesting.duration(), DURATION);
        assertEq(vesting.released(), 0);
    }

    function test_Constructor_RevertsOnZeroBeneficiary() public {
        vm.expectRevert(bytes("Vesting: zero beneficiary"));
        new FMXVesting(address(0), T0, CLIFF, DURATION);
    }

    function test_Constructor_RevertsOnZeroDuration() public {
        vm.expectRevert(bytes("Vesting: bad schedule"));
        new FMXVesting(beneficiary, T0, 0, 0);
    }

    function test_Constructor_RevertsWhenCliffExceedsDuration() public {
        vm.expectRevert(bytes("Vesting: bad schedule"));
        new FMXVesting(beneficiary, T0, DURATION + 1, DURATION);
    }

    function test_Constructor_AllowsCliffEqualToDuration() public {
        FMXVesting v = new FMXVesting(beneficiary, T0, DURATION, DURATION);
        assertEq(v.cliff(), v.duration());
    }

    // ------------------------------------------------------------- funding

    function test_Receive_AcceptsFMX_EmitsFunded() public {
        vm.expectEmit(true, false, false, true);
        emit Funded(funder, ALLOC);
        _fund(ALLOC);
        assertEq(address(vesting).balance, ALLOC);
        assertEq(vesting.totalAllocation(), ALLOC);
    }

    function test_TotalAllocation_IncludesReleased() public {
        _fund(ALLOC);
        vm.warp(T0 + DURATION);
        vesting.release();
        assertEq(address(vesting).balance, 0);
        assertEq(vesting.totalAllocation(), ALLOC);
    }

    // -------------------------------------------------------- vestedAmount

    function test_VestedAmount_ZeroBeforeCliff() public {
        _fund(ALLOC);
        assertEq(vesting.vestedAmount(T0), 0);
        assertEq(vesting.vestedAmount(T0 + CLIFF - 1), 0);
    }

    function test_VestedAmount_AtCliff_UnlocksAccruedPortion() public {
        _fund(ALLOC);
        // At the cliff, the whole time-since-start portion unlocks at once.
        uint256 expected = (ALLOC * CLIFF) / DURATION;
        assertEq(vesting.vestedAmount(T0 + CLIFF), expected);
    }

    function test_VestedAmount_LinearMidway() public {
        _fund(ALLOC);
        assertEq(vesting.vestedAmount(T0 + DURATION / 2), ALLOC / 2);
        assertEq(vesting.vestedAmount(T0 + (DURATION * 3) / 4), (ALLOC * 3) / 4);
    }

    function test_VestedAmount_FullAtAndAfterEnd() public {
        _fund(ALLOC);
        assertEq(vesting.vestedAmount(T0 + DURATION), ALLOC);
        assertEq(vesting.vestedAmount(T0 + DURATION + 365 days), ALLOC);
    }

    // -------------------------------------------------------------- release

    function test_Release_RevertsBeforeCliff() public {
        _fund(ALLOC);
        vm.warp(T0 + CLIFF - 1);
        assertEq(vesting.releasable(), 0);
        vm.expectRevert(bytes("Vesting: nothing vested"));
        vesting.release();
    }

    function test_Release_RevertsWhenUnfunded() public {
        vm.warp(T0 + DURATION);
        vm.expectRevert(bytes("Vesting: nothing vested"));
        vesting.release();
    }

    function test_Release_AtCliff_PaysBeneficiary() public {
        _fund(ALLOC);
        vm.warp(T0 + CLIFF);
        uint256 expected = (ALLOC * CLIFF) / DURATION;

        vm.expectEmit(false, false, false, true);
        emit Released(expected);
        vesting.release();

        assertEq(beneficiary.balance, expected);
        assertEq(vesting.released(), expected);
        assertEq(vesting.releasable(), 0);
    }

    function test_Release_AnyoneCanTrigger_FundsGoToBeneficiaryOnly() public {
        _fund(ALLOC);
        vm.warp(T0 + DURATION);
        address rando = makeAddr("rando");
        vm.prank(rando);
        vesting.release();
        assertEq(rando.balance, 0);
        assertEq(beneficiary.balance, ALLOC);
    }

    function test_Release_IncrementalOverTime() public {
        _fund(ALLOC);

        vm.warp(T0 + DURATION / 2);
        vesting.release();
        assertEq(beneficiary.balance, ALLOC / 2);

        // nothing more releasable at the same timestamp
        vm.expectRevert(bytes("Vesting: nothing vested"));
        vesting.release();

        vm.warp(T0 + (DURATION * 3) / 4);
        vesting.release();
        assertEq(beneficiary.balance, (ALLOC * 3) / 4);

        vm.warp(T0 + DURATION);
        vesting.release();
        assertEq(beneficiary.balance, ALLOC);
        assertEq(address(vesting).balance, 0);
        assertEq(vesting.released(), ALLOC);
    }

    function test_Release_AfterTopUpMidStream() public {
        _fund(100 ether);
        vm.warp(T0 + DURATION / 2);
        vesting.release(); // 50 out
        assertEq(beneficiary.balance, 50 ether);

        _fund(100 ether); // totalAllocation now 200
        assertEq(vesting.totalAllocation(), 200 ether);
        // vested at half = 100, minus 50 already released
        assertEq(vesting.releasable(), 50 ether);
        vesting.release();
        assertEq(beneficiary.balance, 100 ether);

        vm.warp(T0 + DURATION);
        vesting.release();
        assertEq(beneficiary.balance, 200 ether);
    }

    function test_Release_RevertsWhenBeneficiaryRejects() public {
        RejectingBeneficiary bad = new RejectingBeneficiary();
        FMXVesting v = new FMXVesting(address(bad), T0, CLIFF, DURATION);
        vm.prank(funder);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);
        vm.warp(T0 + DURATION);
        vm.expectRevert(bytes("Vesting: transfer failed"));
        v.release();
    }

    // ----------------------------------------------------------------- fuzz

    function testFuzz_VestedAmount_MonotonicAndBounded(uint256 amount, uint64 t) public {
        amount = bound(amount, 1, 1e30);
        t = uint64(bound(t, 0, T0 + 2 * uint256(DURATION)));
        vm.deal(funder, amount);
        _fund(amount);

        uint256 vested = vesting.vestedAmount(t);
        assertLe(vested, amount, "vested must never exceed allocation");
        if (t < T0 + CLIFF) assertEq(vested, 0, "nothing before cliff");
        if (t >= T0 + DURATION) assertEq(vested, amount, "everything after end");
    }

    function testFuzz_Release_AccountingHolds(uint256 amount, uint64 warpTo) public {
        amount = bound(amount, 1, 1e30);
        warpTo = uint64(bound(warpTo, T0 + CLIFF, T0 + 2 * uint256(DURATION)));
        vm.deal(funder, amount);
        _fund(amount);
        vm.warp(warpTo);

        uint256 expected = vesting.releasable();
        if (expected == 0) {
            vm.expectRevert(bytes("Vesting: nothing vested"));
            vesting.release();
            return;
        }
        vesting.release();
        assertEq(beneficiary.balance, expected);
        assertEq(vesting.released(), expected);
        assertEq(vesting.totalAllocation(), amount, "allocation invariant");
    }
}
