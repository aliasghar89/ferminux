// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StakingTestBase} from "./StakingTestBase.sol";
import {FMXStaking} from "../src/FMXStaking.sol";

/// @notice Core unit tests: lifecycle, locks, cooldowns, emergency exit,
///         pause semantics, access control, timelocked parameters, slashing.
contract FMXStakingTest is StakingTestBase {
    // ------------------------------------------------------ Constructor
    function test_ConstructorState() public view {
        assertEq(staking.owner(), msig);
        assertEq(staking.dripPerYear(), staking.MAX_DRIP_PER_YEAR());
        assertTrue(staking.denied(premine));
        assertEq(staking.lastAccrual(), block.timestamp);
        assertEq(staking.nodeRegistry(), address(registry));
    }

    function test_ConstructorRejectsZeroOwner() public {
        address[] memory deny = new address[](0);
        vm.expectRevert(bytes("STK: zero owner"));
        new FMXStaking(address(0), deny);
    }

    function test_ConstructorRejectsZeroDenyEntry() public {
        address[] memory deny = new address[](1);
        deny[0] = address(0);
        vm.expectRevert(bytes("STK: zero deny entry"));
        new FMXStaking(msig, deny);
    }

    // ---------------------------------------------------------- Staking
    function test_StakeFlexible() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        FMXStaking.Position memory p = staking.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(uint8(p.tier), uint8(FMXStaking.Tier.Flexible));
        assertEq(uint8(p.state), uint8(FMXStaking.PositionState.Active));
        assertEq(p.amount, 100 ether);
        assertEq(p.units, 100 ether * 10);
        assertEq(p.lockEnd, 0);
        assertFalse(p.boosted);
        assertEq(staking.totalUnits(), 100 ether * 10);
        assertEq(staking.totalPrincipal(), 100 ether);
        uint256[] memory ids = staking.positionsOf(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
    }

    function test_StakeEmitsEvent() public {
        vm.deal(alice, 1 ether);
        vm.expectEmit(true, true, false, true);
        emit FMXStaking.Staked(0, alice, FMXStaking.Tier.Flexible, 1 ether, 1 ether * 10);
        vm.prank(alice);
        staking.stake{value: 1 ether}(FMXStaking.Tier.Flexible);
    }

    function test_StakeTierWeightsAndLocks() public {
        uint256 f = stakeAs(alice, FMXStaking.Tier.Flexible, 10 ether);
        uint256 l90 = stakeAs(alice, FMXStaking.Tier.Locked90, 10 ether);
        uint256 l180 = stakeAs(alice, FMXStaking.Tier.Locked180, 10 ether);
        uint256 val = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        assertEq(staking.getPosition(f).units, 10 ether * 10);
        assertEq(staking.getPosition(l90).units, 10 ether * 15);
        assertEq(staking.getPosition(l180).units, 10 ether * 20);
        assertEq(staking.getPosition(val).units, MIN_VAL * 20);
        assertEq(staking.getPosition(l90).lockEnd, block.timestamp + 90 days);
        assertEq(staking.getPosition(l180).lockEnd, block.timestamp + 180 days);
        assertEq(staking.getPosition(val).lockEnd, 0); // block-number locked
    }

    function test_StakeZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(bytes("STK: zero amount"));
        staking.stake{value: 0}(FMXStaking.Tier.Flexible);
    }

    function test_StakeDeniedReverts() public {
        vm.deal(premine, 1 ether);
        vm.prank(premine);
        vm.expectRevert(bytes("STK: staker denied"));
        staking.stake{value: 1 ether}(FMXStaking.Tier.Flexible);
    }

    function test_StakeValidatorBelowMinReverts() public {
        vm.deal(alice, MIN_VAL);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: below validator minimum"));
        staking.stake{value: MIN_VAL - 1}(FMXStaking.Tier.Validator);
    }

    // ------------------------------------------------------------ Pause
    function test_PauseOnlyOwner() public {
        vm.expectRevert(bytes("STK: not owner"));
        staking.pauseDeposits();
        vm.prank(msig);
        staking.pauseDeposits();
        assertTrue(staking.paused());
        vm.expectRevert(bytes("STK: not owner"));
        staking.unpauseDeposits();
    }

    function test_PauseBlocksDepositsOnly() public {
        fundPool(1000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(30 days);
        vm.prank(msig);
        staking.pauseDeposits();

        // deposits blocked
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("STK: deposits paused"));
        staking.stake{value: 1 ether}(FMXStaking.Tier.Flexible);

        // claims, unstakes, withdrawals all still work
        vm.prank(alice);
        uint256 claimed = staking.claim(id);
        vm.prank(alice);
        staking.requestUnstake(id);
        skip(COOLDOWN);
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance, 100 ether + claimed);
    }

    function test_PauseStateGuards() public {
        vm.startPrank(msig);
        vm.expectRevert(bytes("STK: not paused"));
        staking.unpauseDeposits();
        staking.pauseDeposits();
        vm.expectRevert(bytes("STK: already paused"));
        staking.pauseDeposits();
        staking.unpauseDeposits();
        vm.stopPrank();
    }

    // ------------------------------------------------- Locks & cooldowns
    function test_UnstakeFlexibleImmediate() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(alice);
        staking.requestUnstake(id);
        FMXStaking.Position memory p = staking.getPosition(id);
        assertEq(uint8(p.state), uint8(FMXStaking.PositionState.Cooldown));
        assertEq(p.cooldownEnd, block.timestamp + COOLDOWN);
        assertEq(p.units, 0);
        assertEq(staking.totalUnits(), 0);
    }

    function test_UnstakeLocked90Enforced() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked90, 5 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: lock not expired"));
        staking.requestUnstake(id);
        skip(90 days - 1);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: lock not expired"));
        staking.requestUnstake(id);
        skip(1);
        vm.prank(alice);
        staking.requestUnstake(id);
    }

    function test_UnstakeLocked180Enforced() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked180, 5 ether);
        skip(179 days);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: lock not expired"));
        staking.requestUnstake(id);
        skip(1 days);
        vm.prank(alice);
        staking.requestUnstake(id);
    }

    function test_UnstakeValidatorLockedUntilBlock() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: lock not expired"));
        staking.requestUnstake(id);
        vm.roll(staking.VALIDATOR_LOCK_BLOCK() - 1);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: lock not expired"));
        staking.requestUnstake(id);
        vm.roll(staking.VALIDATOR_LOCK_BLOCK());
        vm.prank(alice);
        staking.requestUnstake(id);
    }

    function test_UnstakeNotOwnerReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("STK: not position owner"));
        staking.requestUnstake(id);
    }

    function test_UnstakeTwiceReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(alice);
        staking.requestUnstake(id);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: not active"));
        staking.requestUnstake(id);
    }

    function test_WithdrawBeforeCooldownEndsReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(alice);
        staking.requestUnstake(id);
        skip(COOLDOWN - 1);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: cooldown not over"));
        staking.withdraw(id);
    }

    function test_WithdrawWithoutRequestReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: not in cooldown"));
        staking.withdraw(id);
    }

    function test_WithdrawPaysExactPrincipal() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.startPrank(alice);
        staking.requestUnstake(id);
        skip(COOLDOWN);
        uint256 before = alice.balance;
        staking.withdraw(id);
        vm.stopPrank();
        assertEq(alice.balance - before, 5 ether);
        assertEq(staking.totalPrincipal(), 0);
        assertEq(uint8(staking.getPosition(id).state), uint8(FMXStaking.PositionState.Withdrawn));
    }

    function test_WithdrawTwiceReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.startPrank(alice);
        staking.requestUnstake(id);
        skip(COOLDOWN);
        staking.withdraw(id);
        vm.expectRevert(bytes("STK: not in cooldown"));
        staking.withdraw(id);
        vm.stopPrank();
    }

    function test_CooldownAccruesNothing() public {
        fundPool(1000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR);
        vm.prank(alice);
        staking.requestUnstake(id);
        uint256 pendingAtRequest = staking.pendingRewards(id);
        skip(COOLDOWN + 30 days);
        assertEq(staking.pendingRewards(id), pendingAtRequest); // frozen
    }

    // ------------------------------------------------------------ Claims
    function test_ClaimDoesNotUnstake() public {
        fundPool(1000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR);
        vm.prank(alice);
        uint256 got = staking.claim(id);
        assertApproxEqAbs(got, 10 ether, 1e6);
        FMXStaking.Position memory p = staking.getPosition(id);
        assertEq(uint8(p.state), uint8(FMXStaking.PositionState.Active));
        assertEq(p.amount, 100 ether);
    }

    function test_ClaimNothingReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: nothing to claim"));
        staking.claim(id); // empty pool -> zero accrual
    }

    function test_ClaimNotOwnerReverts() public {
        fundPool(10 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(30 days);
        vm.prank(bob);
        vm.expectRevert(bytes("STK: not position owner"));
        staking.claim(id);
    }

    function test_BankedRewardsClaimableAfterWithdraw() public {
        fundPool(1000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR);
        vm.startPrank(alice);
        staking.requestUnstake(id);
        skip(COOLDOWN);
        staking.withdraw(id);
        uint256 before = alice.balance;
        staking.claim(id); // banked rewards survive withdrawal
        vm.stopPrank();
        assertApproxEqAbs(alice.balance - before, 10 ether, 1e6);
    }

    // --------------------------------------------------- Emergency exit
    function test_EmergencyExitFlexibleNoPenalty() public {
        fundPool(1000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR);
        uint256 pending = staking.pendingRewards(id);
        assertApproxEqAbs(pending, 10 ether, 1e6); // a year of accrual...
        vm.prank(alice);
        staking.emergencyExit(id);
        // ...all forfeited straight back into the pool: net pool unchanged
        assertApproxEqAbs(staking.rewardPool(), 1000 ether, 1e6);
        assertEq(staking.pendingRewards(id), 0);
        skip(COOLDOWN);
        uint256 before = alice.balance;
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance - before, 100 ether); // full principal
    }

    function test_EmergencyExitLocked90TakesPenalty() public {
        fundPool(1000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked90, 100 ether);
        skip(30 days); // lock NOT expired
        uint256 pending = staking.pendingRewards(id);
        assertGt(pending, 0);
        vm.prank(alice);
        staking.emergencyExit(id);
        // forfeited rewards recycle (net zero) + 5% of principal added
        assertApproxEqAbs(staking.rewardPool(), 1000 ether + 5 ether, 1e6);
        skip(COOLDOWN);
        uint256 before = alice.balance;
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance - before, 95 ether);
    }

    function test_EmergencyExitLocked90AfterExpiryNoPenalty() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked90, 100 ether);
        skip(91 days);
        vm.prank(alice);
        staking.emergencyExit(id);
        skip(COOLDOWN);
        uint256 before = alice.balance;
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance - before, 100 ether);
    }

    function test_EmergencyExitValidatorPreLockBlockTakesPenalty() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.prank(alice);
        staking.emergencyExit(id); // block.number << 4,680,000
        skip(COOLDOWN);
        uint256 before = alice.balance;
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance - before, MIN_VAL - (MIN_VAL * 500) / 10_000);
        assertEq(staking.rewardPool(), (MIN_VAL * 500) / 10_000);
    }

    function test_EmergencyExitAlwaysAvailable_PausedAndPoolEmpty() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked180, 100 ether);
        vm.prank(msig);
        staking.pauseDeposits();
        assertEq(staking.rewardPool(), 0); // nothing funded at all
        vm.prank(alice);
        staking.emergencyExit(id);
        skip(COOLDOWN);
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance, 95 ether); // principal back, minus lock penalty
    }

    function test_EmergencyExitTwiceReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(alice);
        staking.emergencyExit(id);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: not active"));
        staking.emergencyExit(id);
    }

    function test_EmergencyExitNotOwnerReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 5 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("STK: not position owner"));
        staking.emergencyExit(id);
    }

    // ----------------------------------------------------------- Funding
    function test_FundRewardsAnyone() public {
        vm.deal(bob, 7 ether);
        vm.expectEmit(true, false, false, true);
        emit FMXStaking.RewardsFunded(bob, 7 ether, 7 ether);
        vm.prank(bob);
        staking.fundRewards{value: 7 ether}();
        assertEq(staking.rewardPool(), 7 ether);
    }

    function test_FundZeroReverts() public {
        vm.prank(bob);
        vm.expectRevert(bytes("STK: zero funding"));
        staking.fundRewards{value: 0}();
    }

    function test_BareTransferReverts() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(staking).call{value: 1 ether}("");
        assertFalse(ok); // no receive/fallback: pool accounting cannot drift
    }

    // ------------------------------------------------- Timelocked params
    function test_DripChangeTimelocked() public {
        uint256 newDrip = 500_000 ether;
        vm.prank(msig);
        staking.queueSetDripPerYear(newDrip);
        vm.prank(msig);
        vm.expectRevert(bytes("STK: timelock not elapsed"));
        staking.applySetDripPerYear(newDrip);
        skip(TIMELOCK);
        vm.prank(msig);
        staking.applySetDripPerYear(newDrip);
        assertEq(staking.dripPerYear(), newDrip);
    }

    function test_DripAboveHardCapReverts() public {
        uint256 aboveCap = staking.MAX_DRIP_PER_YEAR() + 1;
        vm.prank(msig);
        vm.expectRevert(bytes("STK: drip above hard cap"));
        staking.queueSetDripPerYear(aboveCap);
    }

    function test_ApplyWithoutQueueReverts() public {
        vm.prank(msig);
        vm.expectRevert(bytes("STK: not queued"));
        staking.applySetDripPerYear(1 ether);
    }

    function test_QueueTwiceReverts() public {
        vm.startPrank(msig);
        staking.queueSetDripPerYear(1 ether);
        vm.expectRevert(bytes("STK: already queued"));
        staking.queueSetDripPerYear(1 ether);
        vm.stopPrank();
    }

    function test_CancelQueued() public {
        vm.startPrank(msig);
        staking.queueSetDripPerYear(1 ether);
        staking.cancelQueued(staking.dripKey(1 ether));
        skip(TIMELOCK);
        vm.expectRevert(bytes("STK: not queued"));
        staking.applySetDripPerYear(1 ether);
        vm.stopPrank();
    }

    function test_TimelockOnlyOwner() public {
        vm.expectRevert(bytes("STK: not owner"));
        staking.queueSetDripPerYear(1 ether);
        vm.expectRevert(bytes("STK: not owner"));
        staking.applySetDripPerYear(1 ether);
        vm.expectRevert(bytes("STK: not owner"));
        staking.cancelQueued(bytes32(0));
        vm.expectRevert(bytes("STK: not owner"));
        staking.queueDefund(alice, 1 ether);
        vm.expectRevert(bytes("STK: not owner"));
        staking.queueSetDenied(alice, true);
        vm.expectRevert(bytes("STK: not owner"));
        staking.queueSetNodeRegistry(alice);
    }

    function test_DenyListTimelocked() public {
        vm.prank(msig);
        staking.queueSetDenied(alice, true);
        skip(TIMELOCK);
        vm.prank(msig);
        staking.applySetDenied(alice, true);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: staker denied"));
        staking.stake{value: 1 ether}(FMXStaking.Tier.Flexible);

        // and back off the list
        vm.prank(msig);
        staking.queueSetDenied(alice, false);
        skip(TIMELOCK);
        vm.prank(msig);
        staking.applySetDenied(alice, false);
        stakeAs(alice, FMXStaking.Tier.Flexible, 1 ether);
    }

    function test_DefundOnlyUnallocatedPool() public {
        fundPool(100 ether);
        stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR); // ~10 FMX accrued to alice, pool ~90
        vm.prank(msig);
        staking.queueDefund(msig, 95 ether); // more than what will be unallocated
        skip(TIMELOCK);
        vm.prank(msig);
        vm.expectRevert(bytes("STK: exceeds unallocated pool"));
        staking.applyDefund(msig, 95 ether);

        // a defund within the unallocated pool succeeds
        vm.prank(msig);
        staking.queueDefund(msig, 80 ether);
        skip(TIMELOCK);
        vm.prank(msig);
        staking.applyDefund(msig, 80 ether);
        assertEq(msig.balance, 80 ether);
        // alice's principal and accrued rewards are untouched
        vm.prank(alice);
        uint256 got = staking.claim(0);
        assertGt(got, 10 ether); // > 1 year of accrual by now
    }

    function test_InitNodeRegistryOnceThenTimelocked() public {
        vm.prank(msig);
        vm.expectRevert(bytes("STK: registry already set"));
        staking.initNodeRegistry(alice);

        address newReg = makeAddr("newRegistry");
        vm.prank(msig);
        staking.queueSetNodeRegistry(newReg);
        skip(TIMELOCK);
        vm.prank(msig);
        staking.applySetNodeRegistry(newReg);
        assertEq(staking.nodeRegistry(), newReg);
    }

    function test_OwnerTransferTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(msig);
        staking.transferOwner(newOwner);
        assertEq(staking.owner(), msig); // unchanged until accepted
        vm.prank(alice);
        vm.expectRevert(bytes("STK: not pending owner"));
        staking.acceptOwner();
        vm.prank(newOwner);
        staking.acceptOwner();
        assertEq(staking.owner(), newOwner);
        assertEq(staking.pendingOwner(), address(0));
    }

    // ------------------------------------------------ Registry-only paths
    function test_SetBoostOnlyRegistry() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.prank(alice);
        vm.expectRevert(bytes("STK: not registry"));
        staking.setBoost(id, true);
        vm.prank(msig);
        vm.expectRevert(bytes("STK: not registry"));
        staking.setBoost(id, true);
    }

    function test_SetBoostNonValidatorTierReverts() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 1 ether);
        vm.prank(address(registry));
        vm.expectRevert(bytes("STK: not validator tier"));
        staking.setBoost(id, true);
    }

    function test_SetBoostInactiveIsNoop() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.prank(alice);
        staking.emergencyExit(id);
        vm.prank(address(registry));
        bool changed = staking.setBoost(id, true);
        assertFalse(changed);
        assertFalse(staking.getPosition(id).boosted);
    }

    function test_SetBoostAdjustsUnits() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        assertEq(staking.totalUnits(), MIN_VAL * 20);
        forceBoost(id, true);
        assertEq(staking.totalUnits(), MIN_VAL * 30);
        assertTrue(staking.getPosition(id).boosted);
        forceBoost(id, false);
        assertEq(staking.totalUnits(), MIN_VAL * 20);
    }

    function test_SlashOnlyRegistry() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.roll(staking.FORK_BLOCK());
        vm.prank(alice);
        vm.expectRevert(bytes("STK: not registry"));
        staking.slashBond(id, 500, bob);
    }

    function test_SlashInertPreFork() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.roll(staking.FORK_BLOCK() - 1);
        vm.prank(address(registry));
        vm.expectRevert(bytes("STK: slashing inert pre-fork"));
        staking.slashBond(id, 500, bob);
    }

    function test_SlashBpsBounds() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.roll(staking.FORK_BLOCK());
        vm.startPrank(address(registry));
        vm.expectRevert(bytes("STK: slash bps out of bounds"));
        staking.slashBond(id, 0, bob);
        vm.expectRevert(bytes("STK: slash bps out of bounds"));
        staking.slashBond(id, 501, bob);
        vm.stopPrank();
    }

    function test_SlashPostForkMovesFivePercent() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.roll(staking.FORK_BLOCK());
        uint256 expected = (MIN_VAL * 500) / 10_000;
        vm.prank(address(registry));
        uint256 slashed = staking.slashBond(id, 500, bob);
        assertEq(slashed, expected);
        assertEq(bob.balance, expected);
        FMXStaking.Position memory p = staking.getPosition(id);
        assertEq(p.amount, MIN_VAL - expected);
        assertEq(p.units, (MIN_VAL - expected) * 20);
        assertEq(staking.totalPrincipal(), MIN_VAL - expected);
        assertEq(staking.totalUnits(), (MIN_VAL - expected) * 20);
    }

    function test_SlashDuringCooldownAlsoWorks() public {
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.roll(staking.VALIDATOR_LOCK_BLOCK());
        vm.prank(alice);
        staking.requestUnstake(id);
        vm.prank(address(registry));
        uint256 slashed = staking.slashBond(id, 500, bob);
        assertEq(slashed, (MIN_VAL * 500) / 10_000);
        skip(COOLDOWN);
        vm.prank(alice);
        staking.withdraw(id);
        assertEq(alice.balance, MIN_VAL - slashed);
    }

    // ------------------------------------------------------------- Views
    function test_GetPositionOutOfRangeReverts() public {
        vm.expectRevert(bytes("STK: no such position"));
        staking.getPosition(0);
    }

    function test_PositionCount() public {
        assertEq(staking.positionCount(), 0);
        stakeAs(alice, FMXStaking.Tier.Flexible, 1 ether);
        stakeAs(bob, FMXStaking.Tier.Flexible, 1 ether);
        assertEq(staking.positionCount(), 2);
    }
}
