// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StakingTestBase} from "./StakingTestBase.sol";
import {FMXStaking} from "../src/FMXStaking.sol";

/// @notice Reward-math tests: APY caps per tier, proportionality, order
///         independence, the deposit-sniping attack, the drip cap, pool
///         exhaustion, and the DESIGN.md runway table.
contract FMXStakingRewardsTest is StakingTestBase {
    uint256 internal constant TOL = 1e6; // wei tolerance for segmented accrual

    // ------------------------------------------------ Per-tier APY caps
    function test_Flexible10pctPerYear() public {
        fundPool(1_000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(id), 10 ether, TOL);
    }

    function test_Locked90_15pctPerYear() public {
        fundPool(1_000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked90, 100 ether);
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(id), 15 ether, TOL);
    }

    function test_Locked180_20pctPerYear() public {
        fundPool(1_000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Locked180, 100 ether);
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(id), 20 ether, TOL);
    }

    function test_ValidatorBase20pctPerYear() public {
        fundPool(10_000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(id), (MIN_VAL * 20) / 100, TOL);
    }

    function test_ValidatorBoosted30pctPerYear() public {
        fundPool(10_000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        forceBoost(id, true);
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(id), (MIN_VAL * 30) / 100, TOL);
    }

    function test_BoostToggleMidstream() public {
        fundPool(100_000 ether);
        uint256 id = stakeAs(alice, FMXStaking.Tier.Validator, 100_000 ether);
        skip(YEAR / 2); // 20%/yr for half a year = 10%
        forceBoost(id, true);
        skip(YEAR / 2); // 30%/yr for half a year = 15%
        assertApproxEqAbs(staking.pendingRewards(id), 25_000 ether, TOL);
    }

    // --------------------------------------------------- Proportionality
    function test_TwoStakersProportional() public {
        fundPool(10_000 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        uint256 b = stakeAs(bob, FMXStaking.Tier.Flexible, 300 ether);
        skip(YEAR);
        uint256 ra = staking.pendingRewards(a);
        uint256 rb = staking.pendingRewards(b);
        assertApproxEqAbs(ra, 10 ether, TOL);
        assertApproxEqAbs(rb, 30 ether, TOL);
        assertApproxEqAbs(rb, ra * 3, TOL);
    }

    function test_MixedTiersProportionalToUnits() public {
        fundPool(10_000 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 200 ether); // 2000 units
        uint256 b = stakeAs(bob, FMXStaking.Tier.Locked180, 100 ether); // 2000 units
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(a), staking.pendingRewards(b), TOL);
    }

    // ------------------------------------------------ Order independence
    function test_DepositOrderIrrelevant() public {
        // world 1: alice stakes first, bob second (same second)
        fundPool(10_000 ether);
        uint256 a1 = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        uint256 b1 = stakeAs(bob, FMXStaking.Tier.Flexible, 50 ether);
        skip(123 days);
        uint256 ra1 = staking.pendingRewards(a1);
        uint256 rb1 = staking.pendingRewards(b1);

        // world 2 (fresh stack): bob first, alice second
        setUp();
        fundPool(10_000 ether);
        uint256 b2 = stakeAs(bob, FMXStaking.Tier.Flexible, 50 ether);
        uint256 a2 = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(123 days);
        assertEq(staking.pendingRewards(a2), ra1);
        assertEq(staking.pendingRewards(b2), rb1);
    }

    function test_ClaimTimingIrrelevantToTotal() public {
        // claiming monthly vs once at the end pays the same total
        fundPool(10_000 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        stakeAs(bob, FMXStaking.Tier.Flexible, 100 ether);
        uint256 claimedTotal = 0;
        for (uint256 i = 0; i < 12; i++) {
            skip(30 days);
            vm.prank(alice);
            claimedTotal += staking.claim(a);
        }
        uint256 bobPending = staking.pendingRewards(1);
        assertApproxEqAbs(claimedTotal, bobPending, TOL); // same stake, same time
    }

    function test_InterleavedExitsAndEntries() public {
        // A stakes; later B stakes; A exits; C stakes. Below the drip cap
        // every position earns its own 10%/yr for exactly the seconds it was
        // active — other stakers entering or leaving change nothing.
        fundPool(100_000 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(100 days);
        uint256 b = stakeAs(bob, FMXStaking.Tier.Flexible, 100 ether);
        skip(100 days);
        vm.prank(alice);
        staking.requestUnstake(a); // A active days 0..200
        uint256 c = stakeAs(carol, FMXStaking.Tier.Flexible, 100 ether);
        skip(100 days); // B active days 100..300, C active days 200..300

        uint256 perDay = (10 ether) / uint256(365); // 10%/yr on 100 FMX
        assertApproxEqAbs(staking.pendingRewards(a), perDay * 200, TOL * 400);
        assertApproxEqAbs(staking.pendingRewards(b), perDay * 200, TOL * 400);
        assertApproxEqAbs(staking.pendingRewards(c), perDay * 100, TOL * 400);
    }

    // ------------------------------------------- The deposit-snipe attack
    function test_Attack_DepositJustBeforeFundingEarnsNothing() public {
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(180 days);
        // attacker sees the funding tx coming and front-runs it with a whale stake
        uint256 atk = stakeAs(bob, FMXStaking.Tier.Flexible, 1_000_000 ether);
        fundPool(100_000 ether); // funding is NOT a distribution event
        assertEq(staking.pendingRewards(atk), 0);
        assertEq(staking.pendingRewards(a), 0); // nothing accrued before funding either (pool was empty)
        skip(1);
        // one second later the attacker has earned exactly one second of yield, no more
        uint256 oneSec = (1_000_000 ether * 10) / (100 * YEAR);
        assertApproxEqAbs(staking.pendingRewards(atk), oneSec, 1e12); // ~0.003 FMX/s, share-rounded
    }

    function test_Attack_DepositJustBeforeVictimClaimEarnsNothing() public {
        fundPool(100_000 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(365 days);
        uint256 aliceBefore = staking.pendingRewards(a);
        // attacker stakes huge right before alice claims
        uint256 atk = stakeAs(bob, FMXStaking.Tier.Flexible, 1_000_000 ether);
        vm.prank(alice);
        uint256 got = staking.claim(a);
        assertEq(got, aliceBefore); // alice's year is untouched by the whale
        assertEq(staking.pendingRewards(atk), 0); // whale got nothing for zero seconds
    }

    // ------------------------------------------------------ The drip cap
    function test_DripCapBindsProRata() public {
        // 15M FMX flexible = 15M design-weighted units -> ideal outlay
        // 1.5M/yr, capped at 1.2M/yr -> everyone scaled to 80% of tier cap:
        // "at 15M units: flexible 8%" (DESIGN.md section 7.2).
        fundPool(1_500_000 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 15_000_000 ether);
        assertEq(staking.effectiveRateBps(), 8000);
        assertEq(staking.outlayPerYear(), 1_200_000 ether);
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(a), 1_200_000 ether, TOL); // 8%, not 10%
    }

    function test_UnderDripCapFullTierRate() public {
        fundPool(1_000_000 ether);
        stakeAs(alice, FMXStaking.Tier.Flexible, 1_000_000 ether); // ideal 100k/yr < 1.2M
        assertEq(staking.effectiveRateBps(), 10_000);
        assertEq(staking.outlayPerYear(), 100_000 ether);
    }

    // -------------------------------------------------- Pool exhaustion
    function test_ExhaustionStopsAccrualGracefully() public {
        fundPool(5 ether); // half a year of runway on 100 FMX flexible
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR); // wants 10, pool has 5
        assertApproxEqAbs(staking.pendingRewards(a), 5 ether, TOL);
        skip(YEAR); // accrual stopped — fail-closed, no IOUs
        assertApproxEqAbs(staking.pendingRewards(a), 5 ether, TOL);

        // nothing else is broken: claim pays, unstake + withdraw work
        vm.startPrank(alice);
        uint256 got = staking.claim(a);
        assertApproxEqAbs(got, 5 ether, TOL);
        assertEq(staking.rewardPool(), 0); // settled: fully allocated and paid
        staking.requestUnstake(a);
        skip(COOLDOWN);
        staking.withdraw(a);
        vm.stopPrank();
        assertApproxEqAbs(alice.balance, 105 ether, TOL);
    }

    function test_ExhaustionSplitsProRataAtTheEnd() public {
        fundPool(3 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        uint256 b = stakeAs(bob, FMXStaking.Tier.Flexible, 200 ether);
        skip(YEAR); // ideal 30 FMX, pool only 3 -> A:1, B:2
        assertApproxEqAbs(staking.pendingRewards(a), 1 ether, TOL);
        assertApproxEqAbs(staking.pendingRewards(b), 2 ether, TOL);
    }

    function test_RefundingResumesAccrual() public {
        fundPool(5 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(2 * YEAR); // exhausted at 5
        fundPool(100 ether); // top-up: accrual resumes from here, no back-pay
        skip(YEAR);
        assertApproxEqAbs(staking.pendingRewards(a), 15 ether, TOL); // 5 + 10
    }

    function test_ForfeitsRecycleIntoPool() public {
        fundPool(20 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        uint256 b = stakeAs(bob, FMXStaking.Tier.Flexible, 100 ether);
        skip(YEAR / 2); // each accrued 5 (20%-of-pool outlay: 20/yr combined)
        vm.prank(alice);
        staking.emergencyExit(a); // alice's 5 goes back into the pool
        assertApproxEqAbs(staking.rewardPool(), 15 ether, TOL);
        skip(3 * YEAR); // bob alone: wants 30, pool pays out the remaining 15
        assertApproxEqAbs(staking.pendingRewards(b), 20 ether, TOL); // 5 + 15
    }

    // -------------------------------------- DESIGN.md section 1 runway table
    function test_Runway_TargetMix_825k_218months() public {
        // Target: 2M flex + 1.5M 90d + 0.5M 180d + 1M validator (boosted).
        fundPool(1_500_000 ether);
        stakeAs(alice, FMXStaking.Tier.Flexible, 2_000_000 ether);
        stakeAs(bob, FMXStaking.Tier.Locked90, 1_500_000 ether);
        stakeAs(carol, FMXStaking.Tier.Locked180, 500_000 ether);
        uint256 v = stakeAs(makeAddr("op"), FMXStaking.Tier.Validator, 1_000_000 ether);
        forceBoost(v, true);

        // outlay: 200k + 225k + 100k + 300k = 825k FMX/yr — tier caps bind
        assertEq(staking.outlayPerYear(), 825_000 ether);
        assertEq(staking.effectiveRateBps(), 10_000);

        // runway: 1.5M / 825k = ~1.818 yr = ~21.8 months
        uint256 runway = staking.poolRunwaySeconds();
        assertApproxEqAbs(runway, (uint256(1_500_000) * YEAR) / 825_000, 1);

        // and the pool actually lasts that long: after 1 year, 675k left
        skip(YEAR);
        vm.prank(alice);
        staking.claim(0);
        assertApproxEqAbs(staking.rewardPool(), 675_000 ether, 1e12);
    }

    function test_Runway_HotDripCap_15monthHardFloor() public {
        // >=12M weighted units -> drip cap binds -> 1.2M/yr outlay,
        // 1.5M pool / 1.2M = 1.25 yr = 15.0 months. The design's hard floor.
        fundPool(1_500_000 ether);
        stakeAs(alice, FMXStaking.Tier.Flexible, 14_000_000 ether); // 14M design-units
        assertEq(staking.outlayPerYear(), 1_200_000 ether);
        uint256 runway = staking.poolRunwaySeconds();
        assertEq(runway, (uint256(1_500_000) * YEAR) / 1_200_000); // 1.25 years
        // 15.0 months within a day's tolerance
        assertApproxEqAbs(runway, (15 * YEAR) / 12, 1 days);
    }

    // ------------------------------------------------------------- Views
    function test_PendingRewardsMatchesClaim() public {
        fundPool(100 ether);
        uint256 a = stakeAs(alice, FMXStaking.Tier.Locked90, 123 ether);
        skip(77 days);
        uint256 pending = staking.pendingRewards(a);
        vm.prank(alice);
        uint256 got = staking.claim(a);
        assertEq(got, pending);
    }

    function test_RunwayInfiniteWhenIdle() public {
        fundPool(100 ether);
        assertEq(staking.poolRunwaySeconds(), type(uint256).max); // no stakers
        assertEq(staking.outlayPerYear(), 0);
        assertEq(staking.effectiveRateBps(), 10_000);
    }

    function test_EffectiveRateZeroWhenPoolEmpty() public {
        stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        assertEq(staking.effectiveRateBps(), 0);
        assertEq(staking.outlayPerYear(), 0);
    }

    function test_NoStakersMeansPoolUntouched() public {
        fundPool(100 ether);
        skip(10 * YEAR);
        fundPool(1 ether); // pokes _accrue()
        assertEq(staking.rewardPool(), 101 ether);
    }

    function test_FundingDoesNotBumpAccumulator() public {
        fundPool(100 ether);
        stakeAs(alice, FMXStaking.Tier.Flexible, 100 ether);
        skip(30 days);
        fundPool(1 ether);
        uint256 accAfterSettle = staking.accRewardPerUnit();
        fundPool(1 ether); // same second: funding alone must not move the accumulator
        assertEq(staking.accRewardPerUnit(), accAfterSettle);
    }
}
