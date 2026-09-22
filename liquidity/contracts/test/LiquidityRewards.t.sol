// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LiquidityRewards} from "../src/LiquidityRewards.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/**
 * @dev An airdrop for liquidity providers is farmed the moment it can be. These
 *      tests are mostly about the ways someone takes the budget WITHOUT leaving
 *      liquidity behind — and about the ways we could take their LP, which
 *      matters more, because they are trusting a contract with real assets.
 */
contract LiquidityRewardsTest is Test {
    LiquidityRewards internal lr;
    MockToken internal lp;
    MockToken internal fmx;

    address internal owner = makeAddr("ownerMultisig");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal farmer = makeAddr("farmer");

    uint256 internal constant BUDGET = 100_000 ether; // the announced 100k FMX
    uint64 internal constant DURATION = 30 days;
    uint64 internal constant VEST = 30 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        lp = new MockToken();
        fmx = new MockToken();
        lr = new LiquidityRewards(address(lp), address(fmx), VEST, owner);

        fmx.mint(owner, BUDGET);
        vm.prank(owner);
        fmx.approve(address(lr), type(uint256).max);

        for (uint256 i = 0; i < 3; i++) {
            address who = [alice, bob, farmer][i];
            lp.mint(who, 1_000 ether);
            vm.prank(who);
            lp.approve(address(lr), type(uint256).max);
        }
    }

    function _fund() internal {
        vm.prank(owner);
        lr.fund(BUDGET, DURATION);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        lr.stake(amount);
    }

    // ==================================================== the anti-farm core

    /// The naive airdrop is farmed in one block: be in the snapshot, leave.
    /// Here there is no snapshot — a stake held for zero time earns zero.
    function test_StakingAndLeavingInTheSameBlockEarnsNothing() public {
        _fund();
        _stake(farmer, 1_000 ether);
        vm.prank(farmer);
        lr.withdraw(1_000 ether);

        assertEq(lr.earned(farmer), 0, "a zero-duration stake must earn nothing");
        vm.prank(farmer);
        vm.expectRevert(bytes("LR: nothing to claim"));
        lr.claim();
    }

    /// Rewards are proportional to time, so a latecomer cannot catch up by
    /// depositing more at the end.
    function test_RewardsAreProportionalToTimeHeld() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + 15 days);

        uint256 half = lr.earned(alice);
        assertApproxEqRel(half, BUDGET / 2, 0.01e18, "sole staker earns about half the budget in half the term");

        vm.warp(block.timestamp + 15 days);
        assertApproxEqRel(lr.earned(alice), BUDGET, 0.01e18, "and about all of it over the full term");
    }

    function test_RewardsSplitByShareOfThePool() public {
        _fund();
        _stake(alice, 300 ether);
        _stake(bob, 100 ether);

        vm.warp(block.timestamp + 30 days);

        uint256 a = lr.earned(alice);
        uint256 b = lr.earned(bob);
        assertApproxEqRel(a, b * 3, 0.01e18, "3x the liquidity earns 3x the reward");
        assertApproxEqRel(a + b, BUDGET, 0.01e18, "and together they earn the budget");
    }

    /// A big deposit right at the end takes only its last-minute share.
    function test_ALateWhaleCannotCaptureTheWholeBudget() public {
        _fund();
        _stake(alice, 1 ether);
        vm.warp(block.timestamp + 29 days);

        _stake(farmer, 1_000 ether); // a thousand times alice's stake
        vm.warp(block.timestamp + 1 days);

        assertGt(lr.earned(alice), lr.earned(farmer), "29 days of 1 beats 1 day of 1000");
    }

    function test_NoRewardsAccrueAfterTheProgramEnds() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + DURATION);
        uint256 atEnd = lr.earned(alice);

        vm.warp(block.timestamp + 365 days);
        assertEq(lr.earned(alice), atEnd, "emission stops at endTime, it does not run forever");
    }

    function test_CannotStakeAfterTheProgramEnds() public {
        _fund();
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("LR: program ended"));
        lr.stake(100 ether);
    }

    // ================================================ the provider's property

    /// A provider's LP is their property held for a purpose, not a deposit at
    /// our discretion. There must be no path from `owner` to it.
    function test_TheOwnerCannotTakeStakedLP() public {
        _fund();
        _stake(alice, 500 ether);

        // There is no function to try — assert the balance is where it belongs
        // and that the owner's only reward-side power cannot reach it.
        assertEq(lp.balanceOf(address(lr)), 500 ether);
        vm.warp(block.timestamp + DURATION + 1);
        // The sweep is the owner's ONLY value-moving power, and it is confined
        // to the reward token. It succeeds here only because floor division
        // leaves a dust remainder of the budget unemitted.
        vm.prank(owner);
        lr.sweepUnallocated(owner);
        assertEq(lp.balanceOf(address(lr)), 500 ether, "staked LP is untouched by the only power we have");

        vm.prank(alice);
        lr.withdraw(500 ether);
        assertEq(lp.balanceOf(alice), 1_000 ether, "alice got all of it back");
    }

    function test_WithdrawalCannotBeStoppedByAnyone() public {
        _fund();
        _stake(alice, 500 ether);
        // Ownership handed to an address nobody controls.
        vm.prank(owner);
        lr.transferOwnership(address(0xdead));

        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        lr.withdraw(500 ether);
        assertEq(lp.balanceOf(alice), 1_000 ether);
    }

    function test_WithdrawingDoesNotForfeitRewardsAlreadyEarned() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + 10 days);

        uint256 before = lr.earned(alice);
        vm.prank(alice);
        lr.withdraw(100 ether);
        assertApproxEqAbs(lr.earned(alice), before, 1e12, "leaving keeps what was earned");
    }

    // ============================================================== vesting

    /// Rewards paid instantly are sold instantly, into the pool they were meant
    /// to deepen.
    function test_ClaimingDoesNotPayOutImmediately() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + DURATION);

        vm.prank(alice);
        lr.claim();
        assertEq(fmx.balanceOf(alice), 0, "nothing is liquid at the moment of claiming");
        assertGt(lr.vestOf(alice).amount, 0);
    }

    function test_VestingReleasesLinearly() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + DURATION);
        vm.prank(alice);
        lr.claim();
        uint256 total = lr.vestOf(alice).amount;

        vm.warp(block.timestamp + VEST / 2);
        vm.prank(alice);
        lr.release();
        assertApproxEqRel(fmx.balanceOf(alice), total / 2, 0.01e18, "about half after half the vest");

        vm.warp(block.timestamp + VEST / 2);
        vm.prank(alice);
        lr.release();
        assertApproxEqAbs(fmx.balanceOf(alice), total, 2, "all of it once vested");
    }

    function test_NothingCanBeReleasedBeforeItVests() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + DURATION);
        vm.prank(alice);
        lr.claim();

        vm.prank(alice);
        vm.expectRevert(bytes("LR: nothing vested"));
        lr.release();
    }

    // ============================================================ the budget

    function test_TheBudgetIsPrefunded() public {
        assertEq(fmx.balanceOf(address(lr)), 0);
        _fund();
        assertEq(fmx.balanceOf(address(lr)), BUDGET, "the contract holds what it promises");
    }

    /// Terms a provider commits capital against must not be changeable — by us,
    /// with good intentions, or otherwise.
    function test_TheProgramCannotBeReFundedOrRetermed() public {
        _fund();
        fmx.mint(owner, BUDGET);
        vm.prank(owner);
        vm.expectRevert(bytes("LR: already funded"));
        lr.fund(BUDGET, DURATION);
    }

    function test_OnlyTheOwnerCanFund() public {
        fmx.mint(farmer, BUDGET);
        vm.prank(farmer);
        fmx.approve(address(lr), type(uint256).max);
        vm.prank(farmer);
        vm.expectRevert(bytes("LR: not owner"));
        lr.fund(BUDGET, DURATION);
    }

    function test_CannotStakeBeforeTheProgramIsFunded() public {
        vm.prank(alice);
        vm.expectRevert(bytes("LR: not funded"));
        lr.stake(100 ether);
    }

    /// Emission during a period with NO stakers is owed to nobody, and is the
    /// only thing the sweep may take — after the program has ended.
    function test_SweepTakesOnlyTheEmissionNobodyEarned() public {
        _fund();
        // Nobody stakes for the first half.
        vm.warp(block.timestamp + 15 days);
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + 15 days + 1);

        vm.prank(owner);
        lr.sweepUnallocated(owner);

        // Alice earned about half; roughly the other half was unallocated.
        assertApproxEqRel(fmx.balanceOf(owner), BUDGET / 2, 0.02e18, "only the unstaked half was swept");
        assertGe(
            fmx.balanceOf(address(lr)), lr.outstandingRewards(), "what alice is owed is still in the contract"
        );
    }

    function test_SweepIsRefusedWhileTheProgramIsRunning() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + 10 days);
        vm.prank(owner);
        vm.expectRevert(bytes("LR: program not ended"));
        lr.sweepUnallocated(owner);
    }

    /// The sweep must never eat rewards somebody has earned but not collected.
    function test_SweepCannotTakeRewardsAlreadyEarned() public {
        _fund();
        _stake(alice, 100 ether);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 owed = lr.earned(alice);

        // Alice was staked for the whole program, so essentially everything is
        // hers. The sweep may take only the floor-division dust — the part of
        // the budget the emission rate could never pay out.
        uint256 dust = BUDGET - (BUDGET / DURATION) * DURATION;
        vm.prank(owner);
        lr.sweepUnallocated(owner);
        assertLe(fmx.balanceOf(owner), dust, "the sweep took nothing beyond unemittable dust");
        assertGe(fmx.balanceOf(address(lr)), owed, "everything alice earned is still here");

        // And alice can still collect the whole thing.
        vm.prank(alice);
        lr.claim();
        vm.warp(block.timestamp + VEST);
        vm.prank(alice);
        lr.release();
        assertApproxEqRel(fmx.balanceOf(alice), owed, 0.01e18);
    }

    function test_StakeAndRewardTokenCannotBeTheSame() public {
        vm.expectRevert(bytes("LR: same token"));
        new LiquidityRewards(address(lp), address(lp), VEST, owner);
    }

    // =========================================================== invariants

    /// The contract must always hold at least the rewards it has promised.
    function testFuzz_NeverOwesMoreRewardsThanItHolds(uint96 a, uint96 b, uint32 t) public {
        uint256 sa = bound(uint256(a), 1 ether, 500 ether);
        uint256 sb = bound(uint256(b), 1 ether, 500 ether);
        uint256 dt = bound(uint256(t), 1, DURATION);

        _fund();
        _stake(alice, sa);
        _stake(bob, sb);
        vm.warp(block.timestamp + dt);

        vm.prank(alice);
        lr.claim();
        assertGe(fmx.balanceOf(address(lr)), lr.outstandingRewards(), "solvent on the reward side");
    }

    function testFuzz_StakedLPIsAlwaysFullyRecoverable(uint96 a, uint32 t) public {
        uint256 sa = bound(uint256(a), 1 ether, 1_000 ether);
        uint256 dt = bound(uint256(t), 0, DURATION * 2);

        _fund();
        _stake(alice, sa);
        vm.warp(block.timestamp + dt);

        vm.prank(alice);
        lr.withdraw(sa);
        assertEq(lp.balanceOf(alice), 1_000 ether, "every wei of LP came back");
    }
}
