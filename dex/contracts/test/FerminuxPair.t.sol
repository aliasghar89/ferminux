// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxPair} from "../src/FerminuxPair.sol";
import {FerminuxMath, UQ112x112} from "../src/libraries/FerminuxMath.sol";
import {MockERC20, ReentrantERC20, FlashBorrower, NoReturnERC20, FalseReturnERC20} from "./mocks/Mocks.sol";

contract FerminuxPairTest is Test {
    FerminuxFactory internal factory;
    FerminuxPair internal pair;
    MockERC20 internal token0;
    MockERC20 internal token1;

    address internal setter = makeAddr("feeToSetter");
    address internal treasury = makeAddr("treasury");
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");
    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim");

    uint256 internal constant MINIMUM_LIQUIDITY = 1000;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    function setUp() public {
        factory = new FerminuxFactory(setter);
        MockERC20 a = new MockERC20("Alpha", "ALPHA", 18);
        MockERC20 b = new MockERC20("Beta", "BETA", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        pair = FerminuxPair(factory.createPair(address(token0), address(token1)));
        vm.warp(1_700_000_000); // a sane, non-zero starting timestamp
    }

    // ------------------------------------------------------------ helpers
    function _seed(address to, uint256 amount0, uint256 amount1) internal returns (uint256 liquidity) {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        liquidity = pair.mint(to);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /// @dev Sell `amountIn` of token0 into the pool, sending the output to `to`.
    function _swap0For1(uint256 amountIn, address to) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        out = _amountOut(amountIn, r0, r1);
        token0.mint(address(pair), amountIn);
        pair.swap(0, out, to, new bytes(0));
    }

    function _swap1For0(uint256 amountIn, address to) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        out = _amountOut(amountIn, r1, r0);
        token1.mint(address(pair), amountIn);
        pair.swap(out, 0, to, new bytes(0));
    }

    function _k() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * uint256(r1);
    }

    function _burnFrom(address who, uint256 liquidity, address to) internal returns (uint256 a0, uint256 a1) {
        vm.prank(who);
        pair.transfer(address(pair), liquidity);
        (a0, a1) = pair.burn(to);
    }

    // =====================================================================
    //                            LP token basics
    // =====================================================================

    function test_LP_Metadata() public view {
        assertEq(pair.name(), "Ferminux LP");
        assertEq(pair.symbol(), "FMX-LP");
        assertEq(pair.decimals(), 18);
        assertEq(pair.MINIMUM_LIQUIDITY(), MINIMUM_LIQUIDITY);
    }

    function test_LP_TransferAndAllowance() public {
        _seed(lp, 10e18, 10e18);
        uint256 bal = pair.balanceOf(lp);

        vm.prank(lp);
        pair.transfer(trader, bal / 2);
        assertEq(pair.balanceOf(trader), bal / 2);

        vm.prank(trader);
        pair.approve(address(this), bal / 4);
        pair.transferFrom(trader, lp, bal / 4);
        assertEq(pair.allowance(trader, address(this)), 0);

        vm.expectRevert(bytes("LP: insufficient allowance"));
        pair.transferFrom(trader, lp, 1);
    }

    function test_LP_InfiniteAllowanceNotDecremented() public {
        _seed(lp, 10e18, 10e18);
        vm.prank(lp);
        pair.approve(address(this), type(uint256).max);
        pair.transferFrom(lp, trader, 1e18);
        assertEq(pair.allowance(lp, address(this)), type(uint256).max);
    }

    function test_LP_Permit() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwner");
        _seed(owner, 10e18, 10e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                pair.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(pair.PERMIT_TYPEHASH(), owner, trader, 5e18, pair.nonces(owner), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        pair.permit(owner, trader, 5e18, deadline, v, r, s);
        assertEq(pair.allowance(owner, trader), 5e18);
        assertEq(pair.nonces(owner), 1, "nonce must advance");

        // the same signature cannot be replayed
        vm.expectRevert(bytes("LP: invalid signature"));
        pair.permit(owner, trader, 5e18, deadline, v, r, s);
    }

    function test_LP_PermitExpired() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitOwner");
        uint256 deadline = block.timestamp - 1;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                pair.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(pair.PERMIT_TYPEHASH(), owner, trader, 1e18, uint256(0), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(bytes("LP: permit expired"));
        pair.permit(owner, trader, 1e18, deadline, v, r, s);
    }

    function test_LP_PermitWrongSigner() public {
        (address owner,) = makeAddrAndKey("permitOwner");
        (, uint256 otherPk) = makeAddrAndKey("someoneElse");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                pair.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(pair.PERMIT_TYPEHASH(), owner, trader, 1e18, uint256(0), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherPk, digest);
        vm.expectRevert(bytes("LP: invalid signature"));
        pair.permit(owner, trader, 1e18, deadline, v, r, s);
    }

    function test_LP_DomainSeparatorRebuiltOnChainIdChange() public {
        bytes32 before = pair.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(pair.DOMAIN_SEPARATOR() != before, "domain must be chain-bound");
    }

    // =====================================================================
    //                                 MINT
    // =====================================================================

    function test_Mint_FirstDeposit_BurnsMinimumLiquidity() public {
        uint256 expected = FerminuxMath.sqrt(4e18 * 9e18) - MINIMUM_LIQUIDITY;

        token0.mint(address(pair), 4e18);
        token1.mint(address(pair), 9e18);
        vm.expectEmit(true, false, false, true, address(pair));
        emit Mint(address(this), 4e18, 9e18);
        uint256 liquidity = pair.mint(lp);

        assertEq(liquidity, expected, "sqrt(x*y) - MINIMUM_LIQUIDITY");
        assertEq(pair.balanceOf(lp), expected);
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY, "1000 LP burned forever");
        assertEq(pair.totalSupply(), expected + MINIMUM_LIQUIDITY);

        (uint112 r0, uint112 r1, uint32 ts) = pair.getReserves();
        assertEq(r0, 4e18);
        assertEq(r1, 9e18);
        assertEq(ts, uint32(block.timestamp));
    }

    function test_Mint_FirstDeposit_RevertsBelowMinimumLiquidity() public {
        // sqrt(999 * 999) = 999 < MINIMUM_LIQUIDITY -> the subtraction underflows,
        // which under 0.8 semantics is a panic rather than a silent wrap.
        token0.mint(address(pair), 999);
        token1.mint(address(pair), 999);
        vm.expectRevert(stdError.arithmeticError);
        pair.mint(lp);
    }

    function test_Mint_FirstDeposit_ExactlyMinimumLiquidityRevertsAsZero() public {
        // sqrt(1000 * 1000) = 1000 -> liquidity 0 -> caught by the explicit check
        token0.mint(address(pair), 1000);
        token1.mint(address(pair), 1000);
        vm.expectRevert(bytes("PAIR: insufficient liquidity minted"));
        pair.mint(lp);
    }

    function test_Mint_FirstDeposit_ExactlyMinimumLiquidityMintsZero() public {
        token0.mint(address(pair), 1001);
        token1.mint(address(pair), 1001);
        // sqrt(1001*1001) - 1000 = 1 -> allowed
        assertEq(pair.mint(lp), 1);
    }

    function test_Mint_Subsequent_Proportional() public {
        _seed(lp, 100e18, 400e18);
        uint256 supplyBefore = pair.totalSupply();

        // add 10% more of both
        uint256 liquidity = _seed(trader, 10e18, 40e18);
        assertEq(liquidity, supplyBefore / 10, "10% more reserves -> 10% more supply");
    }

    function test_Mint_Subsequent_UsesWorseRatio_ExcessIsDonated() public {
        _seed(lp, 100e18, 100e18);
        uint256 supplyBefore = pair.totalSupply();

        // 10% of token0 but 20% of token1: only 10% of LP is minted, the extra
        // token1 is donated to every LP.
        uint256 liquidity = _seed(trader, 10e18, 20e18);
        assertEq(liquidity, supplyBefore / 10);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 110e18);
        assertEq(r1, 120e18, "donation still lands in the reserves");
    }

    function test_Mint_RevertsWhenNothingDeposited() public {
        _seed(lp, 100e18, 100e18);
        vm.expectRevert(bytes("PAIR: insufficient liquidity minted"));
        pair.mint(trader);
    }

    function test_Mint_RevertsWhenOnlyOneSideDeposited() public {
        _seed(lp, 100e18, 100e18);
        token0.mint(address(pair), 10e18);
        vm.expectRevert(bytes("PAIR: insufficient liquidity minted"));
        pair.mint(trader);
    }

    // =====================================================================
    //                                 BURN
    // =====================================================================

    function test_Burn_ReturnsProportionalAmounts() public {
        _seed(lp, 100e18, 400e18);
        uint256 liquidity = pair.balanceOf(lp);
        uint256 totalSupply = pair.totalSupply();

        (uint256 a0, uint256 a1) = _burnFrom(lp, liquidity, lp);

        assertEq(a0, 100e18 * liquidity / totalSupply);
        assertEq(a1, 400e18 * liquidity / totalSupply);
        assertEq(token0.balanceOf(lp), a0);
        assertEq(token1.balanceOf(lp), a1);
        assertEq(pair.balanceOf(lp), 0);
        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY, "only the burned minimum remains");
    }

    function test_Burn_HalfPosition() public {
        _seed(lp, 100e18, 100e18);
        uint256 half = pair.balanceOf(lp) / 2;
        (uint256 a0, uint256 a1) = _burnFrom(lp, half, lp);
        // ~50% of the pool, minus the share attributable to MINIMUM_LIQUIDITY
        assertApproxEqRel(a0, 50e18, 1e15); // within 0.1%
        assertApproxEqRel(a1, 50e18, 1e15);
    }

    function test_Burn_EmitsEvent() public {
        _seed(lp, 100e18, 100e18);
        uint256 liquidity = pair.balanceOf(lp);
        vm.prank(lp);
        pair.transfer(address(pair), liquidity);

        uint256 supply = pair.totalSupply();
        uint256 e0 = liquidity * 100e18 / supply;
        uint256 e1 = liquidity * 100e18 / supply;
        vm.expectEmit(true, true, false, true, address(pair));
        emit Burn(address(this), e0, e1, lp);
        pair.burn(lp);
    }

    function test_Burn_RevertsWithNoLiquiditySent() public {
        _seed(lp, 100e18, 100e18);
        vm.expectRevert(bytes("PAIR: insufficient liquidity burned"));
        pair.burn(lp);
    }

    function test_Burn_MinimumLiquidityIsUnredeemable() public {
        _seed(lp, 100e18, 100e18);
        _burnFrom(lp, pair.balanceOf(lp), lp);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertGt(r0, 0, "pool never fully drains");
        assertGt(r1, 0);
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY);
        // address(0) cannot sign a transfer, so those 1000 LP are gone forever
        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY);
    }

    // =====================================================================
    //                                 SWAP
    // =====================================================================

    function test_Swap_MovesPriceAndKeepsK() public {
        _seed(lp, 1000e18, 1000e18);
        uint256 kBefore = _k();

        uint256 out = _swap0For1(10e18, trader);

        assertEq(token1.balanceOf(trader), out);
        assertGt(kBefore, 0);
        assertGe(_k(), kBefore, "k must never decrease on a swap");

        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 1010e18);
        assertEq(r1, 1000e18 - out);
    }

    function test_Swap_RevertsWhenOutputTooLarge() public {
        _seed(lp, 1000e18, 1000e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 fair = _amountOut(10e18, r0, r1);

        token0.mint(address(pair), 10e18);
        vm.expectRevert(bytes("PAIR: K"));
        pair.swap(0, fair + 1, trader, new bytes(0)); // one wei too greedy
    }

    function test_Swap_ExactFeeBoundaryIsAccepted() public {
        _seed(lp, 1000e18, 1000e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 fair = _amountOut(10e18, r0, r1);
        token0.mint(address(pair), 10e18);
        pair.swap(0, fair, trader, new bytes(0)); // exactly the 0.30%-fee price
        assertEq(token1.balanceOf(trader), fair);
    }

    function test_Swap_RevertsOnZeroOutput() public {
        _seed(lp, 1000e18, 1000e18);
        vm.expectRevert(bytes("PAIR: insufficient output amount"));
        pair.swap(0, 0, trader, new bytes(0));
    }

    function test_Swap_RevertsOnInsufficientLiquidity() public {
        _seed(lp, 1000e18, 1000e18);
        vm.expectRevert(bytes("PAIR: insufficient liquidity"));
        pair.swap(0, 1000e18, trader, new bytes(0));
    }

    function test_Swap_RevertsOnInvalidTo() public {
        _seed(lp, 1000e18, 1000e18);
        vm.expectRevert(bytes("PAIR: invalid to"));
        pair.swap(0, 1e18, address(token1), new bytes(0));

        vm.expectRevert(bytes("PAIR: invalid to"));
        pair.swap(1e18, 0, address(token0), new bytes(0));
    }

    function test_Swap_RevertsWithoutInput() public {
        _seed(lp, 1000e18, 1000e18);
        vm.expectRevert(bytes("PAIR: insufficient input amount"));
        pair.swap(0, 1e18, trader, new bytes(0)); // nothing was paid in
    }

    function test_Swap_EmitsEvent() public {
        _seed(lp, 1000e18, 1000e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 out = _amountOut(5e18, r0, r1);
        token0.mint(address(pair), 5e18);

        vm.expectEmit(true, true, false, true, address(pair));
        emit Swap(address(this), 5e18, 0, 0, out, trader);
        pair.swap(0, out, trader, new bytes(0));
    }

    /// @notice The 0.30% is not skimmed anywhere — it stays in the reserves, so
    ///         the LP redeems more than they deposited after trading activity.
    function test_Swap_FeeAccruesToLiquidityProviders() public {
        _seed(lp, 1000e18, 1000e18);
        uint256 liquidity = pair.balanceOf(lp);

        // round trip: sell 100 token0, then sell the proceeds back
        uint256 got1 = _swap0For1(100e18, trader);
        vm.prank(trader);
        token1.transfer(address(pair), got1);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 back0 = _amountOut(got1, r1, r0);
        pair.swap(back0, 0, trader, new bytes(0));

        (uint256 a0, uint256 a1) = _burnFrom(lp, liquidity, lp);

        assertGt(a0 + a1, 2000e18 - 2000, "LP position must have grown");
        assertGt(a0, 1000e18, "the extra token0 left behind is the fee");
        // two hops of 0.30% on 100e18 ~= 0.599e18 of value retained
        // Two 0.30% hops on 100e18 is ~0.6e18 gross; the LP realises slightly
        // less because the round trip ends at a shifted price and the burned
        // MINIMUM_LIQUIDITY keeps a sliver of the pool.
        uint256 gain = a0 + a1 - (2000e18 - 2000);
        assertGt(gain, 0.5e18);
        assertLt(gain, 0.62e18);
    }

    function testFuzz_Swap_KNeverDecreases(uint96 amountIn, bool zeroForOne) public {
        vm.assume(amountIn > 1000);
        _seed(lp, 1_000_000e18, 500_000e18);
        uint256 kBefore = _k();

        if (zeroForOne) _swap0For1(amountIn, trader);
        else _swap1For0(amountIn, trader);

        assertGe(_k(), kBefore, "constant product must be preserved or grow");
    }

    function testFuzz_Swap_SequenceKeepsK(uint96[8] calldata amounts, uint8 directions) public {
        _seed(lp, 1_000_000e18, 1_000_000e18);
        uint256 k = _k();
        for (uint256 i; i < amounts.length; i++) {
            uint256 amountIn = bound(uint256(amounts[i]), 1001, 200_000e18);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            bool zeroForOne = (directions >> i) & 1 == 1;
            uint256 out = zeroForOne ? _amountOut(amountIn, r0, r1) : _amountOut(amountIn, r1, r0);
            if (out == 0) continue; // a hop that prices out at zero is rejected by the pair
            if (zeroForOne) {
                token0.mint(address(pair), amountIn);
                pair.swap(0, out, trader, new bytes(0));
            } else {
                token1.mint(address(pair), amountIn);
                pair.swap(out, 0, trader, new bytes(0));
            }
            uint256 kAfter = _k();
            assertGe(kAfter, k, "k decreased mid-sequence");
            k = kAfter;
        }
    }

    // =====================================================================
    //                       First-depositor / donation attack
    // =====================================================================

    /// @notice The classic inflation attack: seed the pool with dust, donate a
    ///         large amount to inflate the LP share price, then wait for a
    ///         depositor to round down to (almost) nothing. MINIMUM_LIQUIDITY
    ///         makes this a losing trade for the attacker by orders of
    ///         magnitude, and the victim's loss is bounded at a rounding error.
    function test_Attack_FirstDepositorDonation_IsUnprofitable() public {
        uint256 donation = 10_000e18;
        uint256 victimDeposit = 10_000e18;

        // 1. attacker seeds with dust and takes 1 wei of LP
        token0.mint(address(pair), 1001);
        token1.mint(address(pair), 1001);
        uint256 attackerLp = pair.mint(attacker);
        assertEq(attackerLp, 1);

        // 2. attacker donates and syncs, inflating the LP share price
        token0.mint(address(pair), donation);
        token1.mint(address(pair), donation);
        pair.sync();

        // 3. victim deposits at the inflated price
        token0.mint(address(pair), victimDeposit);
        token1.mint(address(pair), victimDeposit);
        uint256 victimLp = pair.mint(victim);
        assertGt(victimLp, 0, "victim must receive non-zero LP");

        // 4. both exit
        (uint256 v0, uint256 v1) = _burnFrom(victim, victimLp, victim);
        (uint256 a0, uint256 a1) = _burnFrom(attacker, attackerLp, attacker);

        uint256 attackerSpent = donation * 2 + 2002;
        uint256 attackerGot = a0 + a1;
        assertLt(attackerGot, attackerSpent, "attack must be strictly loss-making");
        assertLt(attackerGot, attackerSpent / 100, "attacker loses >99% of the donation");

        uint256 victimIn = victimDeposit * 2;
        uint256 victimOut = v0 + v1;
        assertGt(victimOut * 10_000 / victimIn, 9_990, "victim keeps >99.9% of value");
    }

    /// @notice The rounding-to-zero variant fails closed: a deposit too small to
    ///         earn a single LP wei reverts instead of being silently confiscated.
    function test_Attack_TinyDepositAfterDonation_RevertsInsteadOfLosingFunds() public {
        token0.mint(address(pair), 1001);
        token1.mint(address(pair), 1001);
        pair.mint(attacker);

        token0.mint(address(pair), 1e18);
        token1.mint(address(pair), 1e18);
        pair.sync();

        uint256 balanceBefore = token0.balanceOf(victim);
        token0.mint(address(pair), 1e6);
        token1.mint(address(pair), 1e6);
        vm.expectRevert(bytes("PAIR: insufficient liquidity minted"));
        pair.mint(victim);
        assertEq(token0.balanceOf(victim), balanceBefore);
    }

    /// @notice An un-synced donation is credited to the NEXT minter, not stolen
    ///         from them — the other reason this attack shape does not pay.
    function test_Donation_WithoutSyncGoesToNextMinter() public {
        _seed(lp, 100e18, 100e18);
        uint256 supplyBefore = pair.totalSupply();

        token0.mint(address(pair), 10e18); // donation
        token1.mint(address(pair), 10e18);
        token0.mint(address(pair), 10e18); // victim's own deposit
        token1.mint(address(pair), 10e18);
        uint256 minted = pair.mint(victim);

        assertEq(minted, supplyBefore * 20 / 100, "credited with the donation too");
    }

    // =====================================================================
    //                             PROTOCOL FEE
    // =====================================================================

    function test_ProtocolFee_OffByDefault() public {
        _seed(lp, 1000e18, 1000e18);
        assertEq(pair.kLast(), 0, "kLast untracked while the fee is off");

        _swap0For1(100e18, trader);
        _seed(trader, 10e18, 10e18); // triggers _mintFee

        assertEq(pair.balanceOf(treasury), 0, "no protocol fee may be minted");
        assertEq(pair.kLast(), 0);
    }

    function test_ProtocolFee_MintsOneSixthOfGrowth() public {
        vm.prank(setter);
        factory.setFeeTo(treasury);

        _seed(lp, 1000e18, 1000e18);
        assertEq(pair.kLast(), 1000e18 * 1000e18, "kLast tracked once the fee is on");

        _swap0For1(100e18, trader);

        uint256 kLast = pair.kLast();
        uint256 totalSupply = pair.totalSupply();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 rootK = FerminuxMath.sqrt(uint256(r0) * uint256(r1));
        uint256 rootKLast = FerminuxMath.sqrt(kLast);
        uint256 expected = (totalSupply * (rootK - rootKLast)) / (rootK * 5 + rootKLast);
        assertGt(expected, 0);

        _seed(trader, 1e18, 1e18); // any liquidity event settles the fee

        assertEq(pair.balanceOf(treasury), expected, "1/6-of-growth formula");

        // Sanity-check the economics: the treasury's LP is worth ~1/6 of the
        // growth in sqrt(k) that the swap fee produced.
        uint256 growth = rootK - rootKLast;
        assertApproxEqRel(pair.balanceOf(treasury) * rootK / totalSupply, growth / 6, 0.02e18);
    }

    function test_ProtocolFee_NotMintedWithoutGrowth() public {
        vm.prank(setter);
        factory.setFeeTo(treasury);

        _seed(lp, 1000e18, 1000e18);
        _seed(trader, 100e18, 100e18); // no swaps in between -> no k growth
        assertEq(pair.balanceOf(treasury), 0);
    }

    function test_ProtocolFee_KLastClearedWhenTurnedOff() public {
        vm.prank(setter);
        factory.setFeeTo(treasury);
        _seed(lp, 1000e18, 1000e18);
        assertGt(pair.kLast(), 0);

        vm.prank(setter);
        factory.setFeeTo(address(0));
        _swap0For1(100e18, trader);
        _seed(trader, 1e18, 1e18);

        assertEq(pair.kLast(), 0, "kLast is zeroed when the fee is switched off");
        assertEq(pair.balanceOf(treasury), 0);
    }

    function test_ProtocolFee_SettledOnBurnToo() public {
        vm.prank(setter);
        factory.setFeeTo(treasury);
        _seed(lp, 1000e18, 1000e18);
        _swap0For1(100e18, trader);

        _burnFrom(lp, pair.balanceOf(lp) / 2, lp);
        assertGt(pair.balanceOf(treasury), 0, "burn settles the protocol fee");
    }

    // =====================================================================
    //                            SKIM AND SYNC
    // =====================================================================

    function test_Skim_SendsExcessBalance() public {
        _seed(lp, 100e18, 100e18);
        token0.mint(address(pair), 7e18); // stray transfer in

        pair.skim(trader);

        assertEq(token0.balanceOf(trader), 7e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 100e18, "reserves untouched by skim");
        assertEq(r1, 100e18);
        assertEq(token0.balanceOf(address(pair)), 100e18);
    }

    function test_Sync_AdoptsBalancesAsReserves() public {
        _seed(lp, 100e18, 100e18);
        token0.mint(address(pair), 7e18);

        vm.expectEmit(false, false, false, true, address(pair));
        emit Sync(107e18, 100e18);
        pair.sync();

        (uint112 r0,,) = pair.getReserves();
        assertEq(r0, 107e18);
    }

    function test_Sync_RevertsAboveUint112() public {
        _seed(lp, 100e18, 100e18);
        token0.mint(address(pair), uint256(type(uint112).max));
        vm.expectRevert(bytes("PAIR: overflow"));
        pair.sync();
    }

    // =====================================================================
    //                            TWAP ORACLE
    // =====================================================================

    function test_TWAP_StartsAtZeroAndDoesNotMoveInSameBlock() public {
        _seed(lp, 100e18, 200e18);
        assertEq(pair.price0CumulativeLast(), 0);
        assertEq(pair.price1CumulativeLast(), 0);

        pair.sync(); // same timestamp -> no accumulation
        assertEq(pair.price0CumulativeLast(), 0);
    }

    function test_TWAP_AccumulatesWithElapsedTime() public {
        _seed(lp, 100e18, 200e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();

        vm.warp(block.timestamp + 3600);
        pair.sync();

        uint256 expected0 = uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0)) * 3600;
        uint256 expected1 = uint256(UQ112x112.uqdiv(UQ112x112.encode(r0), r1)) * 3600;
        assertEq(pair.price0CumulativeLast(), expected0);
        assertEq(pair.price1CumulativeLast(), expected1);

        // a TWAP taken over the window recovers the price: 200/100 = 2
        uint256 twap0 = expected0 / 3600;
        assertEq(twap0 >> 112, 2, "price0 TWAP = reserve1/reserve0 = 2");
    }

    function test_TWAP_UsesPreSwapReservesForTheElapsedWindow() public {
        _seed(lp, 100e18, 100e18);
        vm.warp(block.timestamp + 100);
        pair.sync();
        uint256 afterFirst = pair.price0CumulativeLast();

        (uint112 r0, uint112 r1,) = pair.getReserves();
        vm.warp(block.timestamp + 100);
        _swap0For1(10e18, trader); // price changes only AFTER this window

        uint256 delta = pair.price0CumulativeLast() - afterFirst;
        assertEq(delta, uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0)) * 100, "window priced at the old reserves");
    }

    function test_TWAP_TimestampWrapsAtUint32() public {
        vm.warp(uint256(type(uint32).max) - 9); // 2**32 - 10
        _seed(lp, 100e18, 200e18);
        (uint112 r0, uint112 r1, uint32 tsBefore) = pair.getReserves();
        assertEq(tsBefore, uint32(type(uint32).max - 9));

        vm.warp(uint256(type(uint32).max) + 6); // wraps to 5
        pair.sync();

        (,, uint32 tsAfter) = pair.getReserves();
        assertEq(tsAfter, 5, "timestamp wrapped as designed");
        // 15 seconds really elapsed across the rollover
        assertEq(pair.price0CumulativeLast(), uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0)) * 15);
    }

    function test_TWAP_AccumulatorWrapsAtUint256() public {
        // An extreme price (1 : 2**112-1) makes the accumulator advance by
        // ~2**224 per second, so it wraps uint256 within a uint32 time window.
        uint256 huge = uint256(type(uint112).max);
        token0.mint(address(pair), 1);
        token1.mint(address(pair), huge);
        pair.mint(lp);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 perSecond = uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0));

        vm.warp(block.timestamp + 2 ** 31);
        pair.sync();
        uint256 first = pair.price0CumulativeLast();
        assertEq(first, perSecond * 2 ** 31);

        vm.warp(block.timestamp + 2 ** 31);
        pair.sync();
        uint256 second = pair.price0CumulativeLast();
        assertGt(second, first, "still below 2**256 after two windows");

        vm.warp(block.timestamp + 2 ** 31);
        pair.sync();
        uint256 third = pair.price0CumulativeLast();

        uint256 expected;
        unchecked {
            expected = second + perSecond * 2 ** 31; // wraps, by design
        }
        assertEq(third, expected);
        assertLt(third, second, "accumulator wrapped past 2**256");
        // and the observed delta is still correct under modular subtraction,
        // which is the only way consumers ever read these values
        unchecked {
            assertEq(third - second, perSecond * 2 ** 31);
        }
    }

    // =====================================================================
    //                            REENTRANCY
    // =====================================================================

    function test_Reentrancy_TokenCallbackDuringBurnIsBlocked() public {
        (FerminuxPair p, ReentrantERC20 rent, MockERC20 other) = _reentrantPair();
        _seedReentrant(p, rent, other, 100e18, 100e18);

        rent.arm(address(p), ReentrantERC20.Mode.Swap, false);
        uint256 liquidity = p.balanceOf(lp);
        vm.prank(lp);
        p.transfer(address(p), liquidity);
        p.burn(lp);

        assertEq(rent.reentryAttempts(), 1, "the token did try to reenter");
        assertEq(rent.lastRevertReason(), "PAIR: locked", "reentrancy guard held");
    }

    function test_Reentrancy_TokenCallbackDuringSwapIsBlocked() public {
        (FerminuxPair p, ReentrantERC20 rent, MockERC20 other) = _reentrantPair();
        _seedReentrant(p, rent, other, 100e18, 100e18);

        rent.arm(address(p), ReentrantERC20.Mode.Sync, false);
        // sell `other` into the pool so the pool pays out the reentrant token
        other.mint(address(p), 1e18);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool rentIsToken0 = p.token0() == address(rent);
        uint256 out = rentIsToken0 ? _amountOut(1e18, r1, r0) : _amountOut(1e18, r0, r1);
        if (rentIsToken0) p.swap(out, 0, trader, new bytes(0));
        else p.swap(0, out, trader, new bytes(0));

        assertEq(rent.reentryAttempts(), 1);
        assertEq(rent.lastRevertReason(), "PAIR: locked");
    }

    function test_Reentrancy_BubblingTokenCallbackRevertsTheWholeCall() public {
        (FerminuxPair p, ReentrantERC20 rent, MockERC20 other) = _reentrantPair();
        _seedReentrant(p, rent, other, 100e18, 100e18);

        rent.arm(address(p), ReentrantERC20.Mode.Burn, true); // re-revert instead of swallowing
        uint256 liquidity = p.balanceOf(lp);
        vm.prank(lp);
        p.transfer(address(p), liquidity);
        // The guard fires inside the token's own transfer, so the pair sees the
        // payout call fail and reverts the whole burn. Nothing settles halfway.
        vm.expectRevert(bytes("PAIR: transfer failed"));
        p.burn(lp);
        // (the inner "PAIR: locked" reason is asserted by the non-bubbling
        // variants above; here the whole call reverts, so no state survives)
    }

    function test_Reentrancy_FlashCallbackCannotMintBurnOrSwap() public {
        _seed(lp, 1000e18, 1000e18);
        FlashBorrower borrower = new FlashBorrower(address(pair));
        token0.mint(address(borrower), 10e18);
        token1.mint(address(borrower), 10e18);

        FlashBorrower.Mode[3] memory modes =
            [FlashBorrower.Mode.ReenterMint, FlashBorrower.Mode.ReenterBurn, FlashBorrower.Mode.ReenterSwap];
        for (uint256 i; i < modes.length; i++) {
            borrower.setMode(modes[i]);
            borrower.flash(0, 1e18);
            assertTrue(borrower.reentryAttempted());
            assertEq(borrower.lastRevertReason(), "PAIR: locked", "flash callee must not reenter");
        }
    }

    // =====================================================================
    //                             FLASH SWAPS
    // =====================================================================

    function test_FlashSwap_SucceedsWhenRepaidWithFee() public {
        _seed(lp, 1000e18, 1000e18);
        FlashBorrower borrower = new FlashBorrower(address(pair));
        token1.mint(address(borrower), 1e18); // enough for the fee
        uint256 kBefore = _k();

        borrower.setMode(FlashBorrower.Mode.Repay);
        borrower.flash(0, 100e18);

        assertGe(_k(), kBefore, "flash loan must leave k at least as high");
    }

    function test_FlashSwap_RevertsWhenNotRepaid() public {
        _seed(lp, 1000e18, 1000e18);
        FlashBorrower borrower = new FlashBorrower(address(pair));
        borrower.setMode(FlashBorrower.Mode.Steal);
        vm.expectRevert(bytes("PAIR: insufficient input amount"));
        borrower.flash(0, 100e18);
    }

    function test_FlashSwap_RevertsWhenFeeUnpaid() public {
        _seed(lp, 1000e18, 1000e18);
        FlashBorrower borrower = new FlashBorrower(address(pair));
        token1.mint(address(borrower), 1e18);
        borrower.setMode(FlashBorrower.Mode.RepayWithoutFee);
        vm.expectRevert(bytes("PAIR: K"));
        borrower.flash(0, 100e18);
    }

    // =====================================================================
    //                        NON-STANDARD ERC-20s
    // =====================================================================

    function test_Pair_WorksWithNoReturnValueToken() public {
        NoReturnERC20 weird = new NoReturnERC20();
        MockERC20 normal = new MockERC20("Normal", "NRM", 18);
        FerminuxPair p = FerminuxPair(factory.createPair(address(weird), address(normal)));

        weird.mint(address(p), 100e18);
        normal.mint(address(p), 100e18);
        uint256 liquidity = p.mint(lp);
        assertGt(liquidity, 0);

        vm.prank(lp);
        p.transfer(address(p), liquidity);
        (uint256 a0, uint256 a1) = p.burn(lp);
        assertGt(a0, 0);
        assertGt(a1, 0);
    }

    function test_Pair_RejectsTokenThatReturnsFalse() public {
        FalseReturnERC20 bad = new FalseReturnERC20();
        MockERC20 normal = new MockERC20("Normal", "NRM", 18);
        FerminuxPair p = FerminuxPair(factory.createPair(address(bad), address(normal)));

        bad.mint(address(p), 100e18);
        normal.mint(address(p), 100e18);
        uint256 liquidity = p.mint(lp);

        vm.prank(lp);
        p.transfer(address(p), liquidity);
        vm.expectRevert(bytes("PAIR: transfer failed"));
        p.burn(lp);
    }

    // ------------------------------------------------------------ helpers
    function _reentrantPair() internal returns (FerminuxPair p, ReentrantERC20 rent, MockERC20 other) {
        rent = new ReentrantERC20();
        other = new MockERC20("Other", "OTH", 18);
        p = FerminuxPair(factory.createPair(address(rent), address(other)));
    }

    function _seedReentrant(FerminuxPair p, ReentrantERC20 rent, MockERC20 other, uint256 a0, uint256 a1) internal {
        rent.mint(address(p), a0);
        other.mint(address(p), a1);
        p.mint(lp);
    }
}
