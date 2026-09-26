// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FMXStaking} from "../src/FMXStaking.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";

/// @notice Randomized driver: stakes, unstakes, withdraws, claims, emergency
///         exits, boost toggles, fundings and time warps in arbitrary order,
///         with ghost accounting for conservation checks.
contract StakingHandler is Test {
    FMXStaking public staking;
    address public registryAddr;

    address[] public actors;
    uint256[] public allPositions;
    mapping(uint256 => uint256) public depositedOf; // positionId => principal in
    mapping(uint256 => uint256) public withdrawnOf;

    uint256 public ghostFunded;
    uint256 public ghostDeposited;
    uint256 public ghostClaimed;
    uint256 public ghostWithdrawn;
    uint256 public ghostPenalties; // early-exit principal penalties -> pool

    constructor(FMXStaking _staking, address _registry) {
        staking = _staking;
        registryAddr = _registry;
        actors.push(makeAddr("h-alice"));
        actors.push(makeAddr("h-bob"));
        actors.push(makeAddr("h-carol"));
        actors.push(makeAddr("h-dave"));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _somePosition(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (allPositions.length == 0) return (0, false);
        return (allPositions[seed % allPositions.length], true);
    }

    // ------------------------------------------------------------- Actions
    function stake(uint256 actorSeed, uint8 tierSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        FMXStaking.Tier tier = FMXStaking.Tier(tierSeed % 4);
        if (tier == FMXStaking.Tier.Validator) {
            amount = bound(amount, staking.MIN_VALIDATOR_STAKE(), 1_000_000 ether);
        } else {
            amount = bound(amount, 1, 1_000_000 ether);
        }
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        uint256 id = staking.stake{value: amount}(tier);
        allPositions.push(id);
        depositedOf[id] = amount;
        ghostDeposited += amount;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 200_000 ether);
        vm.deal(address(this), amount);
        staking.fundRewards{value: amount}();
        ghostFunded += amount;
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1, 60 days);
        vm.warp(block.timestamp + dt);
    }

    function requestUnstake(uint256 seed) external {
        (uint256 id, bool ok) = _somePosition(seed);
        if (!ok) return;
        FMXStaking.Position memory p = staking.getPosition(id);
        if (p.state != FMXStaking.PositionState.Active) return;
        // move past any lock so the call can succeed
        if (p.tier == FMXStaking.Tier.Locked90 || p.tier == FMXStaking.Tier.Locked180) {
            if (block.timestamp < p.lockEnd) vm.warp(p.lockEnd);
        }
        if (p.tier == FMXStaking.Tier.Validator && block.number < staking.VALIDATOR_LOCK_BLOCK()) {
            vm.roll(staking.VALIDATOR_LOCK_BLOCK());
        }
        vm.prank(p.owner);
        staking.requestUnstake(id);
    }

    function withdraw(uint256 seed) external {
        (uint256 id, bool ok) = _somePosition(seed);
        if (!ok) return;
        FMXStaking.Position memory p = staking.getPosition(id);
        if (p.state != FMXStaking.PositionState.Cooldown) return;
        if (block.timestamp < p.cooldownEnd) vm.warp(p.cooldownEnd);
        uint256 before = p.owner.balance;
        vm.prank(p.owner);
        staking.withdraw(id);
        uint256 got = p.owner.balance - before;
        withdrawnOf[id] = got;
        ghostWithdrawn += got;
        // principal comes back whole, or 95% after a broken lock — never less
        assertLe(got, depositedOf[id], "withdraw above deposit");
        assertGe(got + 1, (depositedOf[id] * 9_500) / 10_000, "withdraw below 95%");
    }

    function claim(uint256 seed) external {
        (uint256 id, bool ok) = _somePosition(seed);
        if (!ok) return;
        FMXStaking.Position memory p = staking.getPosition(id);
        if (staking.pendingRewards(id) == 0) return;
        uint256 before = p.owner.balance;
        vm.prank(p.owner);
        staking.claim(id);
        ghostClaimed += p.owner.balance - before;
    }

    function emergencyExit(uint256 seed) external {
        (uint256 id, bool ok) = _somePosition(seed);
        if (!ok) return;
        FMXStaking.Position memory p = staking.getPosition(id);
        if (p.state != FMXStaking.PositionState.Active) return;
        vm.prank(p.owner);
        staking.emergencyExit(id);
        ghostPenalties += uint256(p.amount) - staking.getPosition(id).amount;
    }

    function toggleBoost(uint256 seed, bool on) external {
        (uint256 id, bool ok) = _somePosition(seed);
        if (!ok) return;
        FMXStaking.Position memory p = staking.getPosition(id);
        if (p.tier != FMXStaking.Tier.Validator) return;
        vm.prank(registryAddr);
        staking.setBoost(id, on);
    }

    // ------------------------------------------------------------- Helpers
    function positionCount() external view returns (uint256) {
        return allPositions.length;
    }

    function positionAt(uint256 i) external view returns (uint256) {
        return allPositions[i];
    }
}

/// @notice Invariants: solvency (the vault can always cover principal +
///         unallocated pool + every position's raw claimable), unit/principal
///         bookkeeping, exact FMX conservation, and payouts bounded by
///         funding. Plus targeted fuzz for fair share and rounding drift.
contract FMXStakingInvariantTest is Test {
    FMXStaking internal staking;
    NodeRegistry internal registry;
    StakingHandler internal handler;
    address internal msig = makeAddr("msig");
    address internal watchtower = makeAddr("watchtower");

    uint256 internal constant YEAR = 365 days;

    function setUp() public {
        vm.warp(200 days);
        address[] memory deny = new address[](0);
        staking = new FMXStaking(msig, deny);
        registry = new NodeRegistry(address(staking), msig, watchtower);
        vm.prank(msig);
        staking.initNodeRegistry(address(registry));
        handler = new StakingHandler(staking, address(registry));
        targetContract(address(handler));
    }

    /// @dev Raw claimable against the STORED accumulator (no simulation), so
    ///      it never double-counts value still sitting in rewardPool.
    function _rawPending(uint256 id) internal view returns (uint256) {
        FMXStaking.Position memory p = staking.getPosition(id);
        return p.banked + (uint256(p.units) * staking.accRewardPerUnit()) / staking.PRECISION() - p.rewardDebt;
    }

    function invariant_SolvencyNeverBroken() public view {
        uint256 owedPending = 0;
        uint256 n = staking.positionCount();
        for (uint256 i = 0; i < n; i++) {
            owedPending += _rawPending(i);
        }
        assertGe(
            address(staking).balance,
            staking.totalPrincipal() + staking.rewardPool() + owedPending,
            "vault owes more than it holds"
        );
    }

    function invariant_UnitAndPrincipalBookkeeping() public view {
        uint256 units = 0;
        uint256 principal = 0;
        uint256 n = staking.positionCount();
        for (uint256 i = 0; i < n; i++) {
            FMXStaking.Position memory p = staking.getPosition(i);
            if (p.state == FMXStaking.PositionState.Active) units += p.units;
            if (p.state != FMXStaking.PositionState.Withdrawn) principal += p.amount;
        }
        assertEq(staking.totalUnits(), units, "totalUnits drifted");
        assertEq(staking.totalPrincipal(), principal, "totalPrincipal drifted");
    }

    function invariant_ExactConservation() public view {
        // everything in == everything out + everything still inside
        assertEq(
            handler.ghostFunded() + handler.ghostDeposited(),
            address(staking).balance + handler.ghostClaimed() + handler.ghostWithdrawn(),
            "FMX not conserved"
        );
    }

    function invariant_PayoutsNeverExceedFunding() public view {
        // rewards come only from explicit funding plus recycled early-exit
        // penalties (which the design routes into the pool) — never from thin air
        assertLe(
            handler.ghostClaimed(),
            handler.ghostFunded() + handler.ghostPenalties(),
            "paid out more rewards than ever funded"
        );
        assertLe(
            handler.ghostWithdrawn(), handler.ghostDeposited(), "withdrew more principal than was ever deposited"
        );
    }

    // ---------------------------------------------------------- Fuzz: fair share
    /// @notice No staker can ever claim more than its tier-cap fair share for
    ///         the time staked, and withdraw more than its principal.
    function testFuzz_FairShareBounded(uint96 amtA, uint96 amtB, uint32 dur) public {
        uint256 a = bound(uint256(amtA), 1, 4_000_000 ether);
        uint256 b = bound(uint256(amtB), 1, 4_000_000 ether);
        uint256 t = bound(uint256(dur), 1, 2 * YEAR);
        address alice = makeAddr("f-alice");
        address bob = makeAddr("f-bob");

        vm.deal(address(this), 10_000_000 ether);
        staking.fundRewards{value: 10_000_000 ether}();
        vm.deal(alice, a);
        vm.prank(alice);
        uint256 pa = staking.stake{value: a}(FMXStaking.Tier.Flexible);
        vm.deal(bob, b);
        vm.prank(bob);
        uint256 pb = staking.stake{value: b}(FMXStaking.Tier.Locked180);
        skip(t);

        // fair-share caps: 10%/yr and 20%/yr pro-rata over t, +1 wei rounding
        uint256 capA = (a * 10 * t) / (100 * YEAR) + 1;
        uint256 capB = (b * 20 * t) / (100 * YEAR) + 1;
        assertLe(staking.pendingRewards(pa), capA, "A above fair share");
        assertLe(staking.pendingRewards(pb), capB, "B above fair share");

        // and everyone gets out exactly their principal afterwards
        vm.startPrank(alice);
        staking.requestUnstake(pa);
        skip(7 days);
        staking.withdraw(pa);
        vm.stopPrank();
        assertEq(alice.balance, a, "principal not returned whole");
    }

    /// @notice Accumulator rounding across many odd-length segments never
    ///         creates value and strands at most a few wei of dust.
    function testFuzz_RoundingDriftBounded(uint256 seed) public {
        address alice = makeAddr("d-alice");
        address bob = makeAddr("d-bob");
        uint256 a = (seed % 999_983) + 1; // deliberately odd, tiny amounts (wei)
        uint256 b = (uint256(keccak256(abi.encode(seed))) % 999_979) + 1;

        vm.deal(address(this), 1_000 ether);
        staking.fundRewards{value: 1_000 ether}();
        vm.deal(alice, a);
        vm.prank(alice);
        uint256 pa = staking.stake{value: a}(FMXStaking.Tier.Flexible);
        vm.deal(bob, b);
        vm.prank(bob);
        uint256 pb = staking.stake{value: b}(FMXStaking.Tier.Locked90);

        uint256 ops = 40;
        uint256 claimedTotal = 0;
        for (uint256 i = 0; i < ops; i++) {
            uint256 dt = (uint256(keccak256(abi.encode(seed, i))) % 1 days) + 1;
            skip(dt);
            // poke settlement through a real state change every step
            vm.deal(address(this), 1);
            staking.fundRewards{value: 1}();
            if (i % 5 == 0 && staking.pendingRewards(pa) > 0) {
                uint256 before = alice.balance;
                vm.prank(alice);
                staking.claim(pa);
                claimedTotal += alice.balance - before;
            }
        }
        uint256 stillPending = staking.pendingRewards(pa) + staking.pendingRewards(pb);
        uint256 funded = 1_000 ether + ops;

        // no value creation: what's claimable + claimed + left in pool <= funded
        assertLe(claimedTotal + stillPending + staking.rewardPool(), funded, "accumulator created value");
        // bounded dust: ceil-charging strands at most ~2 wei per segment
        assertGe(
            claimedTotal + stillPending + staking.rewardPool() + 3 * ops + 16,
            funded,
            "accumulator leaks more than dust"
        );
        // and principals always come back whole
        vm.prank(alice);
        staking.requestUnstake(pa);
        skip(7 days);
        vm.prank(alice);
        staking.withdraw(pa);
        assertEq(alice.balance, a + claimedTotal, "principal wrong after drift run");
    }
}
