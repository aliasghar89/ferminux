// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxPair} from "../src/FerminuxPair.sol";
import {FerminuxRouter} from "../src/FerminuxRouter.sol";
import {WFMX} from "../src/WFMX.sol";
import {MockERC20, FeeOnTransferERC20, FMXRejector, LiquidityTheftToken} from "./mocks/Mocks.sol";

contract FerminuxRouterTest is Test {
    FerminuxFactory internal factory;
    FerminuxRouter internal router;
    WFMX internal wfmx;

    MockERC20 internal tka;
    MockERC20 internal tkb;
    MockERC20 internal tkc;
    FeeOnTransferERC20 internal fee;

    address internal setter = makeAddr("feeToSetter");
    address internal user = makeAddr("user");
    address internal other = makeAddr("other");
    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim");

    uint256 internal deadline;

    function setUp() public {
        vm.warp(1_700_000_000);
        deadline = block.timestamp + 1 hours;

        factory = new FerminuxFactory(setter);
        wfmx = new WFMX();
        router = new FerminuxRouter(address(factory), address(wfmx));

        tka = new MockERC20("Token A", "TKA", 18);
        tkb = new MockERC20("Token B", "TKB", 18);
        tkc = new MockERC20("Token C", "TKC", 18);
        fee = new FeeOnTransferERC20(100); // 1% burn on every transfer

        tka.mint(user, 1_000_000e18);
        tkb.mint(user, 1_000_000e18);
        tkc.mint(user, 1_000_000e18);
        fee.mint(user, 1_000_000e18);
        vm.deal(user, 10_000 ether);

        vm.startPrank(user);
        tka.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        tkc.approve(address(router), type(uint256).max);
        fee.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ helpers
    function _addTokenPair(MockERC20 a, MockERC20 b, uint256 amountA, uint256 amountB) internal {
        vm.prank(user);
        router.addLiquidity(address(a), address(b), amountA, amountB, 0, 0, 0, user, deadline);
    }

    function _addFMXPair(MockERC20 token, uint256 amountToken, uint256 amountFMX) internal {
        vm.prank(user);
        router.addLiquidityFMX{value: amountFMX}(address(token), amountToken, 0, 0, 0, user, deadline);
    }

    function _path2(address a, address b) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }

    function _path3(address a, address b, address c) internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = a;
        path[1] = b;
        path[2] = c;
    }

    function _lpOf(address a, address b) internal view returns (FerminuxPair) {
        return FerminuxPair(factory.getPair(a, b));
    }

    // =====================================================================
    //                            Construction
    // =====================================================================

    function test_Constructor() public view {
        assertEq(router.factory(), address(factory));
        assertEq(router.WFMX(), address(wfmx));
    }

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert(bytes("ROUTER: zero address"));
        new FerminuxRouter(address(0), address(wfmx));
        vm.expectRevert(bytes("ROUTER: zero address"));
        new FerminuxRouter(address(factory), address(0));
    }

    function test_Receive_OnlyFromWFMX() public {
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "router must reject stray FMX");
    }

    // =====================================================================
    //                            ADD LIQUIDITY
    // =====================================================================

    function test_AddLiquidity_CreatesPairAndMints() public {
        vm.prank(user);
        (uint256 amountA, uint256 amountB, uint256 liquidity) =
            router.addLiquidity(address(tka), address(tkb), 100e18, 400e18, 0, 0, 0, user, deadline);

        assertEq(amountA, 100e18);
        assertEq(amountB, 400e18);
        address pair = factory.getPair(address(tka), address(tkb));
        assertTrue(pair != address(0), "pair auto-created");
        assertEq(FerminuxPair(pair).balanceOf(user), liquidity);
        assertEq(liquidity, 200e18 - 1000, "sqrt(100*400) - MINIMUM_LIQUIDITY");
    }

    function test_AddLiquidity_SecondDepositFollowsPoolRatio() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);

        // offer too much B: the router pulls only the amount the ratio needs
        vm.prank(user);
        (uint256 amountA, uint256 amountB,) =
            router.addLiquidity(address(tka), address(tkb), 10e18, 100e18, 0, 0, 0, user, deadline);
        assertEq(amountA, 10e18);
        assertEq(amountB, 40e18, "quoted at the pool ratio, not the offer");

        // offer too much A: the router falls back to the B-limited amount
        vm.prank(user);
        (amountA, amountB,) = router.addLiquidity(address(tka), address(tkb), 100e18, 40e18, 0, 0, 0, user, deadline);
        assertEq(amountA, 10e18);
        assertEq(amountB, 40e18);
    }

    function test_AddLiquidity_RevertsOnSlippageB() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: insufficient B amount"));
        router.addLiquidity(address(tka), address(tkb), 10e18, 100e18, 0, 41e18, 0, user, deadline);
    }

    function test_AddLiquidity_RevertsOnSlippageA() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: insufficient A amount"));
        router.addLiquidity(address(tka), address(tkb), 100e18, 40e18, 11e18, 0, 0, user, deadline);
    }

    function test_AddLiquidity_RevertsAfterDeadline() public {
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: expired"));
        router.addLiquidity(address(tka), address(tkb), 1e18, 1e18, 0, 0, 0, user, block.timestamp - 1);
    }

    function test_AddLiquidity_MintsToRecipient() public {
        vm.prank(user);
        (,, uint256 liquidity) =
            router.addLiquidity(address(tka), address(tkb), 100e18, 100e18, 0, 0, 0, other, deadline);
        assertEq(_lpOf(address(tka), address(tkb)).balanceOf(other), liquidity);
        assertEq(_lpOf(address(tka), address(tkb)).balanceOf(user), 0);
    }

    // --------------------------------------------------------- native FMX
    function test_AddLiquidityFMX_WrapsAndMints() public {
        uint256 balanceBefore = user.balance;
        vm.prank(user);
        (uint256 amountToken, uint256 amountFMX, uint256 liquidity) =
            router.addLiquidityFMX{value: 50 ether}(address(tka), 100e18, 0, 0, 0, user, deadline);

        assertEq(amountToken, 100e18);
        assertEq(amountFMX, 50 ether);
        assertGt(liquidity, 0);
        assertEq(user.balance, balanceBefore - 50 ether);
        assertEq(wfmx.balanceOf(factory.getPair(address(tka), address(wfmx))), 50 ether);
    }

    function test_AddLiquidityFMX_RefundsDust() public {
        _addFMXPair(tka, 100e18, 50 ether); // pool ratio 1 TKA : 0.5 FMX
        uint256 balanceBefore = user.balance;

        vm.prank(user);
        (, uint256 amountFMX,) = router.addLiquidityFMX{value: 30 ether}(address(tka), 20e18, 0, 0, 0, user, deadline);

        assertEq(amountFMX, 10 ether, "only the ratio-implied FMX is used");
        assertEq(user.balance, balanceBefore - 10 ether, "the other 20 FMX came straight back");
        assertEq(address(router).balance, 0, "router keeps nothing");
    }

    function test_AddLiquidityFMX_RevertsOnSlippage() public {
        _addFMXPair(tka, 100e18, 50 ether);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: insufficient B amount"));
        router.addLiquidityFMX{value: 30 ether}(address(tka), 20e18, 0, 11 ether, 0, user, deadline);
    }

    // -------------------------------------------------------- minLiquidity
    // The caller's LP floor is enforced against the LP actually delivered, so an
    // honest deposit passes when the floor is met and reverts when it is not.
    function test_AddLiquidity_HonorsMinLiquidityFloor() public {
        _addTokenPair(tka, tkb, 100e18, 100e18);
        // A 10-token deposit into a 100/100 pool of ~100e18 supply mints ~10e18.
        vm.prank(user);
        (,, uint256 lp) = router.addLiquidity(address(tka), address(tkb), 10e18, 10e18, 0, 0, 10e18, user, deadline);
        assertEq(lp, 10e18, "delivered exactly the proportional LP");
    }

    function test_AddLiquidity_RevertsWhenMinLiquidityUnmet() public {
        _addTokenPair(tka, tkb, 100e18, 100e18);
        vm.prank(user);
        // Ask for one wei more LP than the deposit can possibly mint.
        vm.expectRevert(bytes("ROUTER: insufficient liquidity"));
        router.addLiquidity(address(tka), address(tkb), 10e18, 10e18, 0, 0, 10e18 + 1, user, deadline);
    }

    function test_AddLiquidityFMX_HonorsMinLiquidityFloor() public {
        _addFMXPair(tka, 100e18, 100 ether); // 1 TKA : 1 FMX, ~100e18 LP
        uint256 balBefore = _lpOf(address(tka), address(wfmx)).balanceOf(user);
        vm.prank(user);
        (,, uint256 lp) = router.addLiquidityFMX{value: 10 ether}(address(tka), 10e18, 0, 0, 10e18, user, deadline);
        assertEq(lp, 10e18, "delivered exactly the proportional LP");
        assertEq(_lpOf(address(tka), address(wfmx)).balanceOf(user), balBefore + lp);
    }

    // =====================================================================
    //     H_AddLiquidityTheft — a hostile token side skims the counter-asset
    // =====================================================================
    //
    // A token that is one side of a pair credits the pool only 2 wei of itself
    // on the victim's deposit, so `FerminuxPair.mint`'s `require(liquidity > 0)`
    // is satisfied with dust LP while the victim's counter-asset — real native
    // FMX, or an honest ERC-20 — is fully deposited and left for the attacker,
    // who already holds the pool's LP, to withdraw. The router must refuse to
    // hand over dust LP for a full-value deposit.

    /// @dev Seed an honest THEFT/FMX pool as the attacker, then arm the skim.
    function _seedAndArmTheftFMX() internal returns (LiquidityTheftToken theft, address pair) {
        theft = new LiquidityTheftToken();
        theft.mint(attacker, 1_000_000e18);
        vm.deal(attacker, 1_000 ether);

        vm.startPrank(attacker);
        theft.approve(address(router), type(uint256).max);
        router.addLiquidityFMX{value: 100 ether}(address(theft), 100e18, 0, 0, 0, attacker, deadline);
        pair = factory.getPair(address(theft), address(wfmx));
        theft.armTheft(pair); // now honest-looking pool turns hostile on deposits
        vm.stopPrank();
    }

    function test_Attack_AddLiquidityFMX_SkimsFMX_RevertsOnProportionalFloor() public {
        (LiquidityTheftToken theft,) = _seedAndArmTheftFMX();

        theft.mint(victim, 100e18);
        vm.deal(victim, 100 ether);
        uint256 fmxBefore = victim.balance;

        vm.startPrank(victim);
        theft.approve(address(router), type(uint256).max);
        // Even with no LP floor of their own, the proportional floor stops it:
        // a 50 FMX deposit should mint ~50e18 LP, dust is orders of magnitude off.
        vm.expectRevert(bytes("ROUTER: liquidity below pool ratio"));
        router.addLiquidityFMX{value: 50 ether}(address(theft), 50e18, 0, 0, 0, victim, deadline);
        vm.stopPrank();

        assertEq(victim.balance, fmxBefore, "victim keeps every FMX, nothing was skimmed");
    }

    function test_Attack_AddLiquidityFMX_SkimsFMX_RevertsOnMinLiquidity() public {
        (LiquidityTheftToken theft,) = _seedAndArmTheftFMX();

        theft.mint(victim, 100e18);
        vm.deal(victim, 100 ether);
        uint256 fmxBefore = victim.balance;

        vm.startPrank(victim);
        theft.approve(address(router), type(uint256).max);
        // A victim who sets a sane LP floor (≈ expected less slippage) also reverts,
        // and hits the minLiquidity check first.
        vm.expectRevert(bytes("ROUTER: insufficient liquidity"));
        router.addLiquidityFMX{value: 50 ether}(address(theft), 50e18, 0, 0, 49e18, victim, deadline);
        vm.stopPrank();

        assertEq(victim.balance, fmxBefore, "victim keeps every FMX");
    }

    function test_Attack_AddLiquidity_SkimsHonestToken_Reverts() public {
        // THEFT paired against an honest ERC-20 (tkb) instead of native FMX.
        LiquidityTheftToken theft = new LiquidityTheftToken();
        theft.mint(attacker, 1_000_000e18);
        tkb.mint(attacker, 1_000_000e18);

        vm.startPrank(attacker);
        theft.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        router.addLiquidity(address(theft), address(tkb), 100e18, 100e18, 0, 0, 0, attacker, deadline);
        address pair = factory.getPair(address(theft), address(tkb));
        theft.armTheft(pair);
        vm.stopPrank();

        theft.mint(victim, 100e18);
        tkb.mint(victim, 100e18);
        uint256 tkbBefore = tkb.balanceOf(victim);

        vm.startPrank(victim);
        theft.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        vm.expectRevert(bytes("ROUTER: liquidity below pool ratio"));
        router.addLiquidity(address(theft), address(tkb), 50e18, 50e18, 0, 0, 0, victim, deadline);
        vm.stopPrank();

        assertEq(tkb.balanceOf(victim), tkbBefore, "victim keeps every TKB, nothing was skimmed");
    }

    // A fee-on-transfer token legitimately delivers less than the router sends,
    // so it trips the plain path's proportional floor on a second deposit — and
    // the supporting variant, which measures what actually arrived and takes an
    // explicit fee allowance, lets it through.
    function test_FeeToken_PlainAddLiquiditySecondDepositReverts() public {
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: liquidity below pool ratio"));
        router.addLiquidity(address(fee), address(tka), 100e18, 200e18, 0, 0, 0, user, deadline);
    }

    function test_FeeToken_SupportingAddLiquidityWorks() public {
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(fee), address(tka));
        uint256 before = pair.balanceOf(user);
        vm.prank(user);
        uint256 lp = router.addLiquiditySupportingFeeOnTransferTokens(
            address(fee), address(tka), 100e18, 200e18, 0, 0, 100, 90e18, user, deadline
        );
        assertGt(lp, 0, "fee-token deposit settled");
        assertEq(pair.balanceOf(user) - before, lp, "delivered LP matches the return value");
    }

    function test_FeeToken_SupportingAddLiquidityEnforcesMinLiquidity() public {
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: insufficient liquidity"));
        router.addLiquiditySupportingFeeOnTransferTokens(
            address(fee), address(tka), 100e18, 200e18, 0, 0, 100, 200e18, user, deadline
        );
    }

    function test_FeeToken_SupportingAddLiquidityFMXWorks() public {
        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee), 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(fee), address(wfmx));
        uint256 before = pair.balanceOf(user);
        vm.prank(user);
        uint256 lp = router.addLiquidityFMXSupportingFeeOnTransferTokens{value: 50 ether}(
            address(fee), 100e18, 0, 0, 100, 40e18, user, deadline
        );
        assertGt(lp, 0, "fee-token FMX deposit settled");
        assertEq(pair.balanceOf(user) - before, lp, "delivered LP matches the return value");
        assertEq(address(router).balance, 0, "router keeps nothing");
    }

    // =====================================================================
    //   E1 regression — the SupportingFeeOnTransferTokens side door is shut
    // =====================================================================
    //
    // The gate's E1 scenario: the supporting variants used to drop the
    // proportional floor entirely, so at minLiquidity = 0 they fully reinstated
    // the add-liquidity theft — measured: the victim deposited 10,000 of the
    // counter-asset, the hostile token credited the pool 2 wei of itself, and
    // the victim received 2 wei of LP. Now the supporting paths measure what
    // the pair actually received and a token crediting dust can never clear the
    // declared fee allowance (hard-capped at 20%), so the same call reverts and
    // the victim keeps everything — even with every caller-supplied bound at 0.

    /// @dev Seed an honest 10,000/10,000 THEFT pool, then arm the skim —
    ///      exactly the E1 stage: honest-looking pool, hostile on deposits.
    function _seedE1TheftFMX() internal returns (LiquidityTheftToken theft) {
        theft = new LiquidityTheftToken();
        theft.mint(attacker, 1_000_000e18);
        vm.deal(attacker, 100_000 ether);
        vm.startPrank(attacker);
        theft.approve(address(router), type(uint256).max);
        router.addLiquidityFMX{value: 10_000 ether}(address(theft), 10_000e18, 0, 0, 0, attacker, deadline);
        theft.armTheft(factory.getPair(address(theft), address(wfmx)));
        vm.stopPrank();
    }

    function test_Attack_E1_SupportingFMX_MinLiquidityZero_Reverts() public {
        LiquidityTheftToken theft = _seedE1TheftFMX();

        theft.mint(victim, 10_000e18);
        vm.deal(victim, 10_000 ether);
        uint256 fmxBefore = victim.balance;

        vm.startPrank(victim);
        theft.approve(address(router), type(uint256).max);
        // Every caller-supplied bound at its weakest: mins 0, minLiquidity 0,
        // and the fee allowance at the 20% hard cap. The 2-wei credit still
        // cannot clear the measured fee check.
        vm.expectRevert(bytes("ROUTER: token fee above declared max"));
        router.addLiquidityFMXSupportingFeeOnTransferTokens{value: 10_000 ether}(
            address(theft), 10_000e18, 0, 0, 2000, 0, victim, deadline
        );
        vm.stopPrank();

        assertEq(victim.balance, fmxBefore, "victim keeps all 10,000 FMX");
        assertEq(theft.balanceOf(victim), 10_000e18, "victim keeps every token");
    }

    function test_Attack_E1_SupportingTokens_HostileTokenA_Reverts() public {
        // THEFT as tokenA (the measured-first side), honest tkb as counter.
        LiquidityTheftToken theft = new LiquidityTheftToken();
        theft.mint(attacker, 1_000_000e18);
        tkb.mint(attacker, 1_000_000e18);
        vm.startPrank(attacker);
        theft.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        router.addLiquidity(address(theft), address(tkb), 10_000e18, 10_000e18, 0, 0, 0, attacker, deadline);
        theft.armTheft(factory.getPair(address(theft), address(tkb)));
        vm.stopPrank();

        theft.mint(victim, 10_000e18);
        tkb.mint(victim, 10_000e18);
        vm.startPrank(victim);
        theft.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        vm.expectRevert(bytes("ROUTER: token fee above declared max"));
        router.addLiquiditySupportingFeeOnTransferTokens(
            address(theft), address(tkb), 10_000e18, 10_000e18, 0, 0, 2000, 0, victim, deadline
        );
        vm.stopPrank();

        assertEq(tkb.balanceOf(victim), 10_000e18, "victim keeps all 10,000 of the counter-asset");
    }

    function test_Attack_E1_SupportingTokens_HostileTokenB_Reverts() public {
        // Same attack with the hostile token passed as tokenB — the second,
        // sized leg. Its dust credit trips the measured fee check on that leg.
        LiquidityTheftToken theft = new LiquidityTheftToken();
        theft.mint(attacker, 1_000_000e18);
        tkb.mint(attacker, 1_000_000e18);
        vm.startPrank(attacker);
        theft.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        router.addLiquidity(address(tkb), address(theft), 10_000e18, 10_000e18, 0, 0, 0, attacker, deadline);
        theft.armTheft(factory.getPair(address(theft), address(tkb)));
        vm.stopPrank();

        theft.mint(victim, 10_000e18);
        tkb.mint(victim, 10_000e18);
        vm.startPrank(victim);
        theft.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        vm.expectRevert(bytes("ROUTER: token fee above declared max"));
        router.addLiquiditySupportingFeeOnTransferTokens(
            address(tkb), address(theft), 10_000e18, 10_000e18, 0, 0, 2000, 0, victim, deadline
        );
        vm.stopPrank();

        assertEq(tkb.balanceOf(victim), 10_000e18, "victim keeps all 10,000 of the counter-asset");
    }

    function test_Supporting_FeeAllowanceHardCapEnforced() public {
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: fee allowance too high"));
        router.addLiquiditySupportingFeeOnTransferTokens(
            address(fee), address(tka), 100e18, 200e18, 0, 0, 2001, 0, user, deadline
        );

        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee), 1000e18, 0, 0, 0, user, deadline);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: fee allowance too high"));
        router.addLiquidityFMXSupportingFeeOnTransferTokens{value: 50 ether}(
            address(fee), 100e18, 0, 0, 2001, 0, user, deadline
        );
    }

    // ------- an HONEST fee-on-transfer token still deposits successfully -----

    /// @dev A 5% transfer-tax token, funded and approved for `user`.
    function _honest5pctToken() internal returns (FeeOnTransferERC20 fee5) {
        fee5 = new FeeOnTransferERC20(500);
        fee5.mint(user, 1_000_000e18);
        vm.prank(user);
        fee5.approve(address(router), type(uint256).max);
    }

    function test_FeeToken5pct_SupportingAddLiquidity_AsTokenA() public {
        FeeOnTransferERC20 fee5 = _honest5pctToken();
        vm.prank(user);
        router.addLiquidity(address(fee5), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(fee5), address(tka));
        uint256 supply = pair.totalSupply();
        (uint256 reserveFee,) = router.getReserves(address(fee5), address(tka));
        uint256 before = pair.balanceOf(user);

        vm.prank(user);
        uint256 lp = router.addLiquiditySupportingFeeOnTransferTokens(
            address(fee5), address(tka), 100e18, 200e18, 0, 0, 500, 0, user, deadline
        );

        assertGt(lp, 0, "honest 5% fee token deposits through the supporting path");
        assertEq(pair.balanceOf(user) - before, lp, "delivered LP matches the return value");
        // Proportional to what ARRIVED: 95e18 of the fee token against its
        // reserve, with the counter-asset sized to match — nothing donated.
        assertEq(lp, 95e18 * supply / reserveFee, "LP is exactly proportional to the measured arrival");
    }

    function test_FeeToken5pct_SupportingAddLiquidity_AsTokenB() public {
        FeeOnTransferERC20 fee5 = _honest5pctToken();
        vm.prank(user);
        router.addLiquidity(address(tka), address(fee5), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(tka), address(fee5));
        uint256 before = pair.balanceOf(user);
        vm.prank(user);
        uint256 lp = router.addLiquiditySupportingFeeOnTransferTokens(
            address(tka), address(fee5), 100e18, 200e18, 0, 0, 500, 0, user, deadline
        );
        assertGt(lp, 0, "honest 5% fee token also works as the second leg");
        assertEq(pair.balanceOf(user) - before, lp);
    }

    function test_FeeToken5pct_SupportingAddLiquidityFMX_RefundsUnusedFMX() public {
        FeeOnTransferERC20 fee5 = _honest5pctToken();
        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee5), 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(fee5), address(wfmx));
        uint256 lpBefore = pair.balanceOf(user);
        uint256 fmxBefore = user.balance;

        vm.prank(user);
        uint256 lp = router.addLiquidityFMXSupportingFeeOnTransferTokens{value: 50 ether}(
            address(fee5), 100e18, 0, 0, 500, 0, user, deadline
        );

        assertGt(lp, 0, "honest 5% fee token FMX deposit settled");
        assertEq(pair.balanceOf(user) - lpBefore, lp);
        assertEq(address(router).balance, 0, "router keeps nothing");
        // The FMX leg is sized to the token's MEASURED arrival, so ~5% of the
        // offered FMX comes straight back instead of being donated to the pool.
        uint256 spent = fmxBefore - user.balance;
        assertLt(spent, 50 ether, "unused FMX was refunded");
        assertGt(spent, 44 ether, "the measured deposit still went through");
    }

    function test_FeeToken5pct_Supporting_RevertsWhenDeclaredFeeTooLow() public {
        FeeOnTransferERC20 fee5 = _honest5pctToken();
        vm.prank(user);
        router.addLiquidity(address(fee5), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        // The token takes 5% but the caller only declared 1%: the measured
        // arrival lands below the declared floor and the deposit reverts.
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: token fee above declared max"));
        router.addLiquiditySupportingFeeOnTransferTokens(
            address(fee5), address(tka), 100e18, 200e18, 0, 0, 100, 0, user, deadline
        );
    }

    function test_FeeToken_SupportingFirstDeposit_EmptyPool() public {
        // First deposit through the supporting path: no ratio to floor against,
        // the fee allowance still applies per side, and the depositor holds the
        // whole pool.
        FeeOnTransferERC20 fee5 = _honest5pctToken();
        vm.prank(user);
        uint256 lp = router.addLiquiditySupportingFeeOnTransferTokens(
            address(fee5), address(tka), 1000e18, 1000e18, 0, 0, 500, 0, user, deadline
        );
        assertGt(lp, 0, "first deposit settled");
        (uint256 reserveFee, uint256 reserveTka) = router.getReserves(address(fee5), address(tka));
        assertEq(reserveFee, 950e18, "fee side holds what arrived net of the 5% tax");
        assertEq(reserveTka, 1000e18);
    }

    // =====================================================================
    //                          REMOVE LIQUIDITY
    // =====================================================================

    function test_RemoveLiquidity_ReturnsProportionalAmounts() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);
        FerminuxPair pair = _lpOf(address(tka), address(tkb));
        uint256 liquidity = pair.balanceOf(user);

        vm.startPrank(user);
        pair.approve(address(router), liquidity);
        uint256 a0 = tka.balanceOf(user);
        uint256 b0 = tkb.balanceOf(user);
        (uint256 amountA, uint256 amountB) =
            router.removeLiquidity(address(tka), address(tkb), liquidity, 0, 0, user, deadline);
        vm.stopPrank();

        assertApproxEqRel(amountA, 100e18, 1e15); // MINIMUM_LIQUIDITY keeps a sliver
        assertApproxEqRel(amountB, 400e18, 1e15);
        assertEq(tka.balanceOf(user), a0 + amountA);
        assertEq(tkb.balanceOf(user), b0 + amountB);
        assertEq(pair.balanceOf(user), 0);
    }

    function test_RemoveLiquidity_RevertsOnSlippage() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);
        FerminuxPair pair = _lpOf(address(tka), address(tkb));
        uint256 liquidity = pair.balanceOf(user);

        vm.startPrank(user);
        pair.approve(address(router), liquidity);
        vm.expectRevert(bytes("ROUTER: insufficient A amount"));
        router.removeLiquidity(address(tka), address(tkb), liquidity, 100e18, 0, user, deadline);

        vm.expectRevert(bytes("ROUTER: insufficient B amount"));
        router.removeLiquidity(address(tka), address(tkb), liquidity, 0, 400e18, user, deadline);
        vm.stopPrank();
    }

    function test_RemoveLiquidity_RevertsAfterDeadline() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: expired"));
        router.removeLiquidity(address(tka), address(tkb), 1, 0, 0, user, block.timestamp - 1);
    }

    function test_RemoveLiquidityFMX_UnwrapsToNative() public {
        _addFMXPair(tka, 100e18, 50 ether);
        FerminuxPair pair = _lpOf(address(tka), address(wfmx));
        uint256 liquidity = pair.balanceOf(user);
        uint256 balanceBefore = user.balance;

        vm.startPrank(user);
        pair.approve(address(router), liquidity);
        (uint256 amountToken, uint256 amountFMX) =
            router.removeLiquidityFMX(address(tka), liquidity, 0, 0, user, deadline);
        vm.stopPrank();

        assertApproxEqRel(amountToken, 100e18, 1e15);
        assertApproxEqRel(amountFMX, 50 ether, 1e15);
        assertEq(user.balance, balanceBefore + amountFMX, "paid out as native FMX");
        assertEq(address(router).balance, 0);
    }

    function test_RemoveLiquidityFMX_RevertsIfRecipientRejectsFMX() public {
        _addFMXPair(tka, 100e18, 50 ether);
        FerminuxPair pair = _lpOf(address(tka), address(wfmx));
        uint256 liquidity = pair.balanceOf(user);
        FMXRejector rejector = new FMXRejector();

        vm.startPrank(user);
        pair.approve(address(router), liquidity);
        vm.expectRevert(bytes("TH: FMX transfer failed"));
        router.removeLiquidityFMX(address(tka), liquidity, 0, 0, address(rejector), deadline);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ permits
    function _permitLp(FerminuxPair pair, uint256 pk, address owner, uint256 value)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                pair.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(pair.PERMIT_TYPEHASH(), owner, address(router), value, pair.nonces(owner), deadline)
                )
            )
        );
        (v, r, s) = vm.sign(pk, digest);
    }

    function test_RemoveLiquidityWithPermit() public {
        (address owner, uint256 pk) = makeAddrAndKey("lpOwner");
        tka.mint(owner, 1000e18);
        tkb.mint(owner, 1000e18);
        vm.startPrank(owner);
        tka.approve(address(router), type(uint256).max);
        tkb.approve(address(router), type(uint256).max);
        router.addLiquidity(address(tka), address(tkb), 100e18, 100e18, 0, 0, 0, owner, deadline);
        vm.stopPrank();

        FerminuxPair pair = _lpOf(address(tka), address(tkb));
        uint256 liquidity = pair.balanceOf(owner);
        (uint8 v, bytes32 r, bytes32 s) = _permitLp(pair, pk, owner, liquidity);

        vm.prank(owner);
        (uint256 amountA, uint256 amountB) = router.removeLiquidityWithPermit(
            address(tka), address(tkb), liquidity, 0, 0, owner, deadline, false, v, r, s
        );
        assertGt(amountA, 0);
        assertGt(amountB, 0);
        assertEq(pair.balanceOf(owner), 0);
        assertEq(pair.allowance(owner, address(router)), 0, "exact-value permit is fully spent");
    }

    function test_RemoveLiquidityFMXWithPermit_ApproveMax() public {
        (address owner, uint256 pk) = makeAddrAndKey("lpOwner");
        tka.mint(owner, 1000e18);
        vm.deal(owner, 100 ether);
        vm.startPrank(owner);
        tka.approve(address(router), type(uint256).max);
        router.addLiquidityFMX{value: 50 ether}(address(tka), 100e18, 0, 0, 0, owner, deadline);
        vm.stopPrank();

        FerminuxPair pair = _lpOf(address(tka), address(wfmx));
        uint256 liquidity = pair.balanceOf(owner);
        (uint8 v, bytes32 r, bytes32 s) = _permitLp(pair, pk, owner, type(uint256).max);

        uint256 balanceBefore = owner.balance;
        vm.prank(owner);
        (, uint256 amountFMX) =
            router.removeLiquidityFMXWithPermit(address(tka), liquidity, 0, 0, owner, deadline, true, v, r, s);

        assertEq(owner.balance, balanceBefore + amountFMX);
        assertEq(
            pair.allowance(owner, address(router)),
            type(uint256).max,
            "approveMax leaves an infinite, non-decrementing allowance"
        );
    }

    // =====================================================================
    //                                SWAPS
    // =====================================================================

    function test_SwapExactTokensForTokens_SingleHop() public {
        _addTokenPair(tka, tkb, 1000e18, 1000e18);
        uint256[] memory quoted = router.getAmountsOut(10e18, _path2(address(tka), address(tkb)));

        uint256 before = tkb.balanceOf(user);
        vm.prank(user);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(10e18, quoted[1], _path2(address(tka), address(tkb)), user, deadline);

        assertEq(amounts[1], quoted[1]);
        assertEq(tkb.balanceOf(user), before + quoted[1]);
    }

    function test_SwapExactTokensForTokens_MultiHop() public {
        _addTokenPair(tka, tkb, 1000e18, 1000e18);
        _addTokenPair(tkb, tkc, 1000e18, 1000e18);

        address[] memory path = _path3(address(tka), address(tkb), address(tkc));
        uint256[] memory quoted = router.getAmountsOut(10e18, path);

        uint256 before = tkc.balanceOf(user);
        vm.prank(user);
        router.swapExactTokensForTokens(10e18, quoted[2], path, user, deadline);
        assertEq(tkc.balanceOf(user), before + quoted[2]);

        // two hops means the fee is charged twice
        assertLt(quoted[2], quoted[1], "second hop takes another 0.30% plus impact");
    }

    function test_SwapExactTokensForTokens_RevertsOnSlippage() public {
        _addTokenPair(tka, tkb, 1000e18, 1000e18);
        uint256[] memory quoted = router.getAmountsOut(10e18, _path2(address(tka), address(tkb)));

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: insufficient output amount"));
        router.swapExactTokensForTokens(10e18, quoted[1] + 1, _path2(address(tka), address(tkb)), user, deadline);
    }

    function test_SwapExactTokensForTokens_RevertsAfterDeadline() public {
        _addTokenPair(tka, tkb, 1000e18, 1000e18);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: expired"));
        router.swapExactTokensForTokens(1e18, 0, _path2(address(tka), address(tkb)), user, block.timestamp - 1);
    }

    function test_SwapExactTokensForTokens_RevertsOnMissingPair() public {
        vm.prank(user);
        vm.expectRevert(bytes("LIB: pair does not exist"));
        router.swapExactTokensForTokens(1e18, 0, _path2(address(tka), address(tkb)), user, deadline);
    }

    function test_SwapTokensForExactTokens_SpendsAtMostMax() public {
        _addTokenPair(tka, tkb, 1000e18, 1000e18);
        uint256[] memory quoted = router.getAmountsIn(10e18, _path2(address(tka), address(tkb)));

        uint256 beforeA = tka.balanceOf(user);
        uint256 beforeB = tkb.balanceOf(user);
        vm.prank(user);
        router.swapTokensForExactTokens(10e18, quoted[0], _path2(address(tka), address(tkb)), user, deadline);

        assertEq(tkb.balanceOf(user), beforeB + 10e18, "exact output delivered");
        assertEq(tka.balanceOf(user), beforeA - quoted[0]);
    }

    function test_SwapTokensForExactTokens_RevertsOnSlippage() public {
        _addTokenPair(tka, tkb, 1000e18, 1000e18);
        uint256[] memory quoted = router.getAmountsIn(10e18, _path2(address(tka), address(tkb)));

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: excessive input amount"));
        router.swapTokensForExactTokens(10e18, quoted[0] - 1, _path2(address(tka), address(tkb)), user, deadline);
    }

    // --------------------------------------------------------- native FMX
    function test_SwapExactFMXForTokens() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        address[] memory path = _path2(address(wfmx), address(tka));
        uint256[] memory quoted = router.getAmountsOut(1 ether, path);

        uint256 before = tka.balanceOf(user);
        uint256 balanceBefore = user.balance;
        vm.prank(user);
        router.swapExactFMXForTokens{value: 1 ether}(quoted[1], path, user, deadline);

        assertEq(tka.balanceOf(user), before + quoted[1]);
        assertEq(user.balance, balanceBefore - 1 ether);
    }

    function test_SwapExactFMXForTokens_RevertsOnBadPath() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: invalid path"));
        router.swapExactFMXForTokens{value: 1 ether}(0, _path2(address(tka), address(wfmx)), user, deadline);
    }

    function test_SwapFMXForExactTokens_RefundsDust() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        address[] memory path = _path2(address(wfmx), address(tka));
        uint256[] memory quoted = router.getAmountsIn(10e18, path);

        uint256 balanceBefore = user.balance;
        uint256 before = tka.balanceOf(user);
        vm.prank(user);
        router.swapFMXForExactTokens{value: 50 ether}(10e18, path, user, deadline);

        assertEq(tka.balanceOf(user), before + 10e18);
        assertEq(user.balance, balanceBefore - quoted[0], "unused FMX refunded in full");
        assertEq(address(router).balance, 0);
    }

    function test_SwapFMXForExactTokens_RevertsIfValueTooLow() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        address[] memory path = _path2(address(wfmx), address(tka));
        uint256[] memory quoted = router.getAmountsIn(10e18, path);

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: excessive input amount"));
        router.swapFMXForExactTokens{value: quoted[0] - 1}(10e18, path, user, deadline);
    }

    function test_SwapExactTokensForFMX() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        address[] memory path = _path2(address(tka), address(wfmx));
        uint256[] memory quoted = router.getAmountsOut(10e18, path);

        uint256 balanceBefore = user.balance;
        vm.prank(user);
        router.swapExactTokensForFMX(10e18, quoted[1], path, user, deadline);

        assertEq(user.balance, balanceBefore + quoted[1], "delivered as native FMX");
        assertEq(wfmx.balanceOf(address(router)), 0);
    }

    function test_SwapExactTokensForFMX_RevertsOnBadPath() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: invalid path"));
        router.swapExactTokensForFMX(1e18, 0, _path2(address(wfmx), address(tka)), user, deadline);
    }

    function test_SwapTokensForExactFMX() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        address[] memory path = _path2(address(tka), address(wfmx));
        uint256[] memory quoted = router.getAmountsIn(5 ether, path);

        uint256 balanceBefore = user.balance;
        uint256 beforeToken = tka.balanceOf(user);
        vm.prank(user);
        router.swapTokensForExactFMX(5 ether, quoted[0], path, user, deadline);

        assertEq(user.balance, balanceBefore + 5 ether);
        assertEq(tka.balanceOf(user), beforeToken - quoted[0]);
    }

    function test_SwapTokensForExactFMX_RevertsOnSlippage() public {
        _addFMXPair(tka, 1000e18, 1000 ether);
        address[] memory path = _path2(address(tka), address(wfmx));
        uint256[] memory quoted = router.getAmountsIn(5 ether, path);

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: excessive input amount"));
        router.swapTokensForExactFMX(5 ether, quoted[0] - 1, path, user, deadline);
    }

    // =====================================================================
    //                     FEE-ON-TRANSFER TOKEN HANDLING
    // =====================================================================

    function test_FeeToken_PlainSwapPathReverts() public {
        // seed a fee-token pool (the transfer tax means the pool receives less
        // than the router asks for, so the plain path's pre-computed amounts
        // no longer hold and the k check rejects the swap)
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        vm.prank(user);
        vm.expectRevert(bytes("PAIR: K"));
        router.swapExactTokensForTokens(10e18, 0, _path2(address(fee), address(tka)), user, deadline);
    }

    function test_FeeToken_SupportingVariantWorks() public {
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        uint256 before = tka.balanceOf(user);
        vm.prank(user);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            10e18, 1, _path2(address(fee), address(tka)), user, deadline
        );

        uint256 received = tka.balanceOf(user) - before;
        assertGt(received, 0, "swap settled");
        // 1% burned in transit, then the 0.30% pool fee and price impact
        assertLt(received, 10e18 * 99 / 100);
        assertGt(received, 9.5e18);
    }

    function test_FeeToken_SupportingVariantEnforcesSlippage() public {
        vm.prank(user);
        router.addLiquidity(address(fee), address(tka), 1000e18, 1000e18, 0, 0, 0, user, deadline);

        vm.prank(user);
        vm.expectRevert(bytes("ROUTER: insufficient output amount"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            10e18, 10e18, _path2(address(fee), address(tka)), user, deadline
        );
    }

    function test_FeeToken_SupportingFMXIn() public {
        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee), 1000e18, 0, 0, 0, user, deadline);

        uint256 before = fee.balanceOf(user);
        vm.prank(user);
        router.swapExactFMXForTokensSupportingFeeOnTransferTokens{value: 1 ether}(
            1, _path2(address(wfmx), address(fee)), user, deadline
        );
        assertGt(fee.balanceOf(user), before);
    }

    function test_FeeToken_SupportingFMXOut() public {
        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee), 1000e18, 0, 0, 0, user, deadline);

        uint256 balanceBefore = user.balance;
        vm.prank(user);
        router.swapExactTokensForFMXSupportingFeeOnTransferTokens(
            10e18, 1, _path2(address(fee), address(wfmx)), user, deadline
        );
        assertGt(user.balance, balanceBefore, "received native FMX");
        assertEq(address(router).balance, 0);
    }

    function test_FeeToken_RemoveLiquidityFMXSupporting() public {
        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee), 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(fee), address(wfmx));
        uint256 liquidity = pair.balanceOf(user);
        uint256 balanceBefore = user.balance;
        uint256 feeBefore = fee.balanceOf(user);

        vm.startPrank(user);
        pair.approve(address(router), liquidity);
        uint256 amountFMX =
            router.removeLiquidityFMXSupportingFeeOnTransferTokens(address(fee), liquidity, 0, 0, user, deadline);
        vm.stopPrank();

        assertEq(user.balance, balanceBefore + amountFMX);
        assertGt(fee.balanceOf(user), feeBefore, "token side delivered net of its tax");
        assertEq(fee.balanceOf(address(router)), 0, "router keeps nothing");
    }

    function test_FeeToken_PlainRemoveLiquidityFMXReverts() public {
        // The plain path routes the token through the router, so the tax is
        // charged twice and the router is short by 1% when it forwards. It
        // fails loudly instead of paying out a wrong amount — which is exactly
        // why the SupportingFeeOnTransferTokens variant exists.
        vm.prank(user);
        router.addLiquidityFMX{value: 500 ether}(address(fee), 1000e18, 0, 0, 0, user, deadline);

        FerminuxPair pair = _lpOf(address(fee), address(wfmx));
        uint256 liquidity = pair.balanceOf(user);

        vm.startPrank(user);
        pair.approve(address(router), liquidity);
        vm.expectRevert(bytes("TH: transfer failed"));
        router.removeLiquidityFMX(address(fee), liquidity, 0, 0, user, deadline);
        vm.stopPrank();
    }

    // =====================================================================
    //                            PRICING VIEWS
    // =====================================================================

    function test_Quote() public view {
        assertEq(router.quote(1e18, 100e18, 200e18), 2e18);
    }

    function test_GetAmountOut_MatchesFormula() public view {
        uint256 amountIn = 10e18;
        uint256 expected = (amountIn * 997 * 1000e18) / (1000e18 * 1000 + amountIn * 997);
        assertEq(router.getAmountOut(amountIn, 1000e18, 1000e18), expected);
    }

    function test_GetAmountIn_RoundsUp() public view {
        uint256 amountOut = 10e18;
        uint256 expected = (1000e18 * amountOut * 1000) / ((1000e18 - amountOut) * 997) + 1;
        assertEq(router.getAmountIn(amountOut, 1000e18, 1000e18), expected);
    }

    function test_GetAmountOut_ThenGetAmountIn_RoundTrips() public view {
        uint256 out = router.getAmountOut(10e18, 1000e18, 2000e18);
        uint256 backIn = router.getAmountIn(out, 1000e18, 2000e18);
        assertLe(backIn, 10e18 + 1, "rounding always favours the pool, never the trader");
        assertGe(backIn, 10e18 - 1e12);
    }

    function test_PricingViews_Validate() public {
        vm.expectRevert(bytes("LIB: insufficient amount"));
        router.quote(0, 1, 1);
        vm.expectRevert(bytes("LIB: insufficient liquidity"));
        router.quote(1, 0, 1);
        vm.expectRevert(bytes("LIB: insufficient input amount"));
        router.getAmountOut(0, 1, 1);
        vm.expectRevert(bytes("LIB: insufficient liquidity"));
        router.getAmountOut(1, 0, 1);
        vm.expectRevert(bytes("LIB: insufficient output amount"));
        router.getAmountIn(0, 1, 1);
        vm.expectRevert(bytes("LIB: insufficient liquidity"));
        router.getAmountIn(1, 1, 1); // amountOut == reserveOut
    }

    function test_GetAmounts_RejectShortPath() public {
        address[] memory path = new address[](1);
        path[0] = address(tka);
        vm.expectRevert(bytes("LIB: invalid path"));
        router.getAmountsOut(1e18, path);
        vm.expectRevert(bytes("LIB: invalid path"));
        router.getAmountsIn(1e18, path);
    }

    function test_PairForAndReserves() public {
        _addTokenPair(tka, tkb, 100e18, 400e18);
        assertEq(router.pairFor(address(tka), address(tkb)), factory.getPair(address(tka), address(tkb)));

        (uint256 rA, uint256 rB) = router.getReserves(address(tka), address(tkb));
        assertEq(rA, 100e18);
        assertEq(rB, 400e18);

        (rA, rB) = router.getReserves(address(tkb), address(tka));
        assertEq(rA, 400e18, "reserves come back in the caller's order");
        assertEq(rB, 100e18);
    }

    // =====================================================================
    //                                FUZZ
    // =====================================================================

    function testFuzz_SwapExactTokensForTokens_RespectsMinOut(uint96 amountIn) public {
        uint256 input = bound(uint256(amountIn), 1e12, 100_000e18);
        _addTokenPair(tka, tkb, 500_000e18, 500_000e18);

        address[] memory path = _path2(address(tka), address(tkb));
        uint256[] memory quoted = router.getAmountsOut(input, path);

        uint256 before = tkb.balanceOf(user);
        vm.prank(user);
        router.swapExactTokensForTokens(input, quoted[1], path, user, deadline);
        assertGe(tkb.balanceOf(user) - before, quoted[1]);
    }

    function testFuzz_AddThenRemoveLiquidity_ReturnsAlmostEverything(uint96 a, uint96 b) public {
        uint256 amountA = bound(uint256(a), 1e15, 100_000e18);
        uint256 amountB = bound(uint256(b), 1e15, 100_000e18);

        vm.startPrank(user);
        (,, uint256 liquidity) =
            router.addLiquidity(address(tka), address(tkb), amountA, amountB, 0, 0, 0, user, deadline);
        FerminuxPair pair = _lpOf(address(tka), address(tkb));
        pair.approve(address(router), liquidity);
        (uint256 outA, uint256 outB) =
            router.removeLiquidity(address(tka), address(tkb), liquidity, 0, 0, user, deadline);
        vm.stopPrank();

        assertLe(outA, amountA);
        assertLe(outB, amountB);
        // only the MINIMUM_LIQUIDITY share is left behind
        assertGe(outA * 10_000 / amountA, 9_900);
        assertGe(outB * 10_000 / amountB, 9_900);
    }
}
