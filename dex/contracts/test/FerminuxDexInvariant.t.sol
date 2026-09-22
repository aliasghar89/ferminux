// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxPair} from "../src/FerminuxPair.sol";
import {FerminuxMath} from "../src/libraries/FerminuxMath.sol";
import {FerminuxLibrary} from "../src/libraries/FerminuxLibrary.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/**
 * @dev Drives a live pool through random sequences of swaps, deposits,
 *      withdrawals, donations, skims and time jumps. Every action re-checks the
 *      local invariants immediately, so a violation points at the action that
 *      caused it rather than at the end of a 64-step run.
 */
contract DexHandler is Test {
    FerminuxPair public immutable pair;
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;

    uint256 public swaps;
    uint256 public mints;
    uint256 public burns;
    uint256 public donations;
    uint256 public skims;
    uint256 public timeJumps;

    /// @dev sqrt(k) per LP token, scaled by 1e18. Must never decrease: it is the
    ///      redeemable value of one LP share and no user action may dilute it.
    uint256 public lastValuePerLp;

    constructor(FerminuxPair _pair, MockERC20 _token0, MockERC20 _token1) {
        pair = _pair;
        token0 = _token0;
        token1 = _token1;
        lastValuePerLp = _valuePerLp();
    }

    function _valuePerLp() internal view returns (uint256) {
        uint256 supply = pair.totalSupply();
        if (supply == 0) return 0;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return FerminuxMath.sqrt(uint256(r0) * uint256(r1)) * 1e18 / supply;
    }

    function _checkValuePerLp(string memory what) internal {
        uint256 current = _valuePerLp();
        assertGe(current, lastValuePerLp, what);
        lastValuePerLp = current;
    }

    function _k() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * uint256(r1);
    }

    // ----------------------------------------------------------- actions
    function swap(uint256 amountIn, bool zeroForOne) public {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        amountIn = bound(amountIn, 1e6, 500_000e18);

        uint256 amountOut = zeroForOne
            ? FerminuxLibrary.getAmountOut(amountIn, r0, r1)
            : FerminuxLibrary.getAmountOut(amountIn, r1, r0);
        if (amountOut == 0) return;

        uint256 kBefore = _k();
        if (zeroForOne) {
            token0.mint(address(pair), amountIn);
            pair.swap(0, amountOut, address(this), new bytes(0));
        } else {
            token1.mint(address(pair), amountIn);
            pair.swap(amountOut, 0, address(this), new bytes(0));
        }

        assertGe(_k(), kBefore, "swap decreased k");
        _checkValuePerLp("swap diluted LP value");
        swaps++;
    }

    function addLiquidity(uint256 amount0) public {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        amount0 = bound(amount0, 1e12, 1_000_000e18);
        uint256 amount1 = amount0 * uint256(r1) / uint256(r0) + 1;
        if (amount1 == 0) return;

        uint256 kBefore = _k();
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        pair.mint(address(this));

        assertGe(_k(), kBefore, "deposit decreased k");
        _checkValuePerLp("deposit diluted LP value");
        mints++;
    }

    function removeLiquidity(uint256 bps) public {
        uint256 balance = pair.balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = balance * bound(bps, 1, 9_000) / 10_000;
        if (amount == 0) return;

        pair.transfer(address(pair), amount);
        try pair.burn(address(this)) {
            burns++;
            // k is EXPECTED to fall here — value per LP share is what must hold
            _checkValuePerLp("withdrawal diluted the remaining LP value");
        } catch {
            // a burn too small to pay out both sides reverts; the LP tokens stay
            // parked in the pair and are picked up by the next burn
        }
    }

    function donate(uint256 amount0, uint256 amount1) public {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        amount0 = bound(amount0, 1, 100_000e18);
        amount1 = bound(amount1, 1, 100_000e18);

        uint256 kBefore = _k();
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        pair.sync(); // reserves must adopt the donated balances

        assertGe(_k(), kBefore, "donation decreased k");
        _checkValuePerLp("donation diluted LP value");
        donations++;
    }

    function skim(uint256 amount0) public {
        amount0 = bound(amount0, 1, 1_000e18);
        token0.mint(address(pair), amount0); // stray transfer in
        uint256 kBefore = _k();
        pair.skim(address(this));
        assertEq(_k(), kBefore, "skim must not move the reserves");
        _checkValuePerLp("skim diluted LP value");
        skims++;
    }

    function advanceTime(uint256 secondsToJump) public {
        secondsToJump = bound(secondsToJump, 1, 30 days);
        vm.warp(block.timestamp + secondsToJump);
        pair.sync();
        _checkValuePerLp("time alone changed LP value");
        timeJumps++;
    }
}

contract FerminuxDexInvariantTest is Test {
    FerminuxFactory internal factory;
    FerminuxPair internal pair;
    MockERC20 internal token0;
    MockERC20 internal token1;
    DexHandler internal handler;

    uint256 internal initialValuePerLp;

    function setUp() public {
        vm.warp(1_700_000_000);
        factory = new FerminuxFactory(address(this));
        MockERC20 a = new MockERC20("Alpha", "ALPHA", 18);
        MockERC20 b = new MockERC20("Beta", "BETA", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        pair = FerminuxPair(factory.createPair(address(token0), address(token1)));

        // seed a real pool before fuzzing
        token0.mint(address(pair), 1_000_000e18);
        token1.mint(address(pair), 2_000_000e18);
        pair.mint(address(this));

        handler = new DexHandler(pair, token0, token1);
        // hand the seed LP position to the handler so it can withdraw as well
        pair.transfer(address(handler), pair.balanceOf(address(this)) / 2);

        initialValuePerLp = _valuePerLp();

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = DexHandler.swap.selector;
        selectors[1] = DexHandler.addLiquidity.selector;
        selectors[2] = DexHandler.removeLiquidity.selector;
        selectors[3] = DexHandler.donate.selector;
        selectors[4] = DexHandler.skim.selector;
        selectors[5] = DexHandler.advanceTime.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _valuePerLp() internal view returns (uint256) {
        uint256 supply = pair.totalSupply();
        if (supply == 0) return 0;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return FerminuxMath.sqrt(uint256(r0) * uint256(r1)) * 1e18 / supply;
    }

    /// @notice After every settled action the recorded reserves are exactly the
    ///         token balances the pool holds. Anything else means the pool is
    ///         quoting a price it cannot honour.
    function invariant_ReservesEqualBalances() public view {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(uint256(r0), token0.balanceOf(address(pair)), "reserve0 != balance0");
        assertEq(uint256(r1), token1.balanceOf(address(pair)), "reserve1 != balance1");
    }

    /// @notice One LP token is never worth less than it was at genesis. Swaps
    ///         and donations push it up (fees), deposits and withdrawals leave
    ///         it flat; nothing pushes it down.
    function invariant_LpValueNeverFalls() public view {
        assertGe(_valuePerLp(), initialValuePerLp, "LP share value fell below its starting point");
    }

    /// @notice MINIMUM_LIQUIDITY is unredeemable, so the pool can never be
    ///         emptied and the reserves can never hit zero.
    function invariant_PoolNeverFullyDrains() public view {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertGe(pair.totalSupply(), pair.MINIMUM_LIQUIDITY(), "supply below MINIMUM_LIQUIDITY");
        assertGt(uint256(r0), 0, "reserve0 drained");
        assertGt(uint256(r1), 0, "reserve1 drained");
    }

    /// @notice The reserves must always fit the uint112 packing.
    function invariant_ReservesFitUint112() public view {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertLe(uint256(r0), uint256(type(uint112).max));
        assertLe(uint256(r1), uint256(type(uint112).max));
    }

    /// @dev Surfaced with -vv; confirms the run actually exercised every action.
    function afterInvariant() public {
        emit log_named_uint("swaps", handler.swaps());
        emit log_named_uint("deposits", handler.mints());
        emit log_named_uint("withdrawals", handler.burns());
        emit log_named_uint("donations", handler.donations());
        emit log_named_uint("skims", handler.skims());
        emit log_named_uint("time jumps", handler.timeJumps());
    }
}
