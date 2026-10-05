// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {stdError} from "forge-std/StdError.sol";
import {BaseTest, Rejecter} from "./Base.t.sol";
import {AgentTokenFactoryV2, AgentTokenV2} from "../src/AgentTokenFactoryV2.sol";
import {AgentTokenFactory, AgentToken} from "../src/AgentTokenFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev The AgentTokenFactory suite, run against AgentTokenFactoryV2 (same behaviour), followed by the
///      V2 fix, reproduced against the live AgentTokenFactory first.
contract AgentTokenFactoryV2Test is BaseTest {
    AgentTokenFactoryV2 internal f;
    uint256 internal agentId;
    address internal token;

    uint256 internal constant BASE = 0.01 ether; // 0.01 FMX per token at s = 0
    uint256 internal constant SLOPE = 0.0001 ether; // +0.0001 FMX per whole token minted
    uint256 internal constant WAD = 1e18;

    function setUp() public override {
        super.setUp();
        f = new AgentTokenFactoryV2(registry, gov, treasury);
        agentId = _registerAlice();
        vm.prank(alice);
        token = f.launch(agentId, "SCRB", BASE, SLOPE);
    }

    function _fee(uint256 a) internal view returns (uint256) {
        return (a * f.feeBps()) / 10000;
    }

    function _reserveAt(uint256 s) internal pure returns (uint256) {
        return (BASE * s) / WAD + (SLOPE * s * s) / (2 * WAD * WAD);
    }

    function _buy(address who, uint256 fmx) internal returns (uint256 out) {
        uint256 before = AgentTokenV2(token).balanceOf(who);
        vm.prank(who);
        f.buy{value: fmx}(token, 0);
        out = AgentTokenV2(token).balanceOf(who) - before;
    }

    // ───────────────────────────── deploy / launch ─────────────────────────────

    function test_deployState() public view {
        assertEq(address(f.registry()), address(registry));
        assertEq(f.governance(), gov);
        assertEq(f.feeRecipient(), treasury);
        assertEq(f.feeBps(), 100);
        assertEq(f.tokenCount(), 1);
        assertEq(f.tokens(0), token);
        assertEq(f.tokenOf(agentId), token);
        AgentTokenFactoryV2.Curve memory c = f.getCurve(token);
        assertEq(c.agentId, agentId);
        assertEq(c.base, BASE);
        assertEq(c.slope, SLOPE);
        assertEq(c.reserve, 0);
        assertEq(f.price(token), BASE);
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(AgentTokenFactoryV2.ZeroAddress.selector);
        new AgentTokenFactoryV2(AgentRegistry(address(0)), gov, treasury);
        vm.expectRevert(AgentTokenFactoryV2.ZeroAddress.selector);
        new AgentTokenFactoryV2(registry, address(0), treasury);
        vm.expectRevert(AgentTokenFactoryV2.ZeroAddress.selector);
        new AgentTokenFactoryV2(registry, gov, address(0));
    }

    function test_launch_tokenMetadata() public view {
        AgentTokenV2 t = AgentTokenV2(token);
        assertEq(t.name(), "Scribe"); // agent name
        assertEq(t.symbol(), "SCRB");
        assertEq(t.decimals(), 18);
        assertEq(t.totalSupply(), 0);
        assertEq(t.factory(), address(f));
        assertEq(t.agentId(), agentId);
    }

    function test_launch_emits() public {
        uint256 id2 = _register(bob, MIN_BOND);
        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit AgentTokenFactoryV2.Launched(id2, address(0), "BOB");
        // token address is unknown ahead of time → check topic1 + data only
        f.launch(id2, "BOB", BASE, 0);
        assertEq(f.tokenCount(), 2);
    }

    function test_launch_validation() public {
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.NotAgentOwner.selector);
        f.launch(agentId, "X", BASE, SLOPE);
        vm.prank(alice);
        vm.expectRevert(AgentTokenFactoryV2.UnknownAgent.selector);
        f.launch(99, "X", BASE, SLOPE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactoryV2.AlreadyLaunched.selector, token));
        f.launch(agentId, "X", BASE, SLOPE);
        uint256 id2 = _register(bob, MIN_BOND);
        vm.startPrank(bob);
        vm.expectRevert(AgentTokenFactoryV2.InvalidSymbol.selector);
        f.launch(id2, "", BASE, SLOPE);
        vm.expectRevert(AgentTokenFactoryV2.InvalidSymbol.selector);
        f.launch(id2, "TWELVECHARSX", BASE, SLOPE);
        vm.expectRevert(AgentTokenFactoryV2.InvalidCurve.selector);
        f.launch(id2, "B", 0, 0);
        vm.expectRevert(AgentTokenFactoryV2.InvalidCurve.selector);
        f.launch(id2, "B", 1e30 + 1, 0);
        vm.expectRevert(AgentTokenFactoryV2.InvalidCurve.selector);
        f.launch(id2, "B", 0, 1e30 + 1);
        vm.stopPrank();
    }

    // ───────────────────────────── buy ─────────────────────────────

    function test_buy_happyPath() public {
        uint256 quoted = f.quoteBuy(token, 1 ether);
        assertGt(quoted, 0);
        uint256 fee = _fee(1 ether);
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit AgentTokenFactoryV2.Bought(token, bob, 1 ether, fee, quoted);
        f.buy{value: 1 ether}(token, quoted);
        assertEq(AgentTokenV2(token).balanceOf(bob), quoted);
        assertEq(AgentTokenV2(token).totalSupply(), quoted);
        assertEq(f.getCurve(token).reserve, 1 ether - _fee(1 ether));
        assertEq(f.credits(treasury), _fee(1 ether));
        assertEq(address(f).balance, 1 ether);
        // 0.01*s + 0.00005*s^2 = 0.99  ->  s ~= 72.63 tokens
        assertGt(quoted, 72.6 ether);
        assertLt(quoted, 72.7 ether);
        assertGt(f.price(token), BASE);
    }

    function test_buy_reserveNeverBelowCurve() public {
        _buy(bob, 1 ether);
        _buy(carol, 0.333333333333333333 ether);
        _buy(bob, 7 ether);
        uint256 s = AgentTokenV2(token).totalSupply();
        uint256 r = f.getCurve(token).reserve;
        assertGe(r, _reserveAt(s));
        assertLe(r - _reserveAt(s), 1e12); // dust only
    }

    function test_buy_slippageAndZero() public {
        uint256 quoted = f.quoteBuy(token, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactoryV2.Slippage.selector, quoted, quoted + 1));
        f.buy{value: 1 ether}(token, quoted + 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.ZeroValue.selector);
        f.buy{value: 0}(token, 0);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.UnknownToken.selector);
        f.buy{value: 1 ether}(address(0x1234), 0);
        // 1 wei buys nothing → Slippage(0, 0)
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactoryV2.Slippage.selector, 0, 0));
        f.buy{value: 1}(token, 0);
    }

    function test_buy_priceRisesWithSupply() public {
        uint256 out1 = _buy(bob, 1 ether);
        uint256 out2 = _buy(bob, 1 ether);
        assertLt(out2, out1);
        assertEq(f.price(token), BASE + (SLOPE * AgentTokenV2(token).totalSupply()) / WAD);
    }

    function test_buy_flatCurve() public {
        uint256 id2 = _register(bob, MIN_BOND);
        vm.prank(bob);
        address t2 = f.launch(id2, "FLAT", 0.5 ether, 0);
        assertEq(f.quoteBuy(t2, 1 ether), (0.99 ether * WAD) / 0.5 ether);
        vm.prank(carol);
        f.buy{value: 1 ether}(t2, 0);
        assertEq(AgentTokenV2(t2).balanceOf(carol), 1.98 ether);
        assertEq(f.quoteSell(t2, 1.98 ether), 0.99 ether);
        assertEq(f.price(t2), 0.5 ether);
    }

    // ───────────────────────────── sell ─────────────────────────────

    function test_sell_happyPath() public {
        uint256 out = _buy(bob, 1 ether);
        uint256 quote = f.quoteSell(token, out);
        assertEq(quote, 1 ether - _fee(1 ether) - (f.getCurve(token).reserve - _reserveAt(out)));
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit AgentTokenFactoryV2.Sold(token, bob, out, quote);
        f.sell(token, out, quote);
        assertEq(AgentTokenV2(token).balanceOf(bob), 0);
        assertEq(AgentTokenV2(token).totalSupply(), 0);
        assertEq(f.credits(bob), quote);
        assertLe(f.getCurve(token).reserve, 1e12); // dust
        vm.prank(bob);
        f.withdraw();
        assertEq(bob.balance, 1_000 ether - 1 ether + quote);
    }

    function test_sell_partial() public {
        uint256 out = _buy(bob, 2 ether);
        uint256 half = out / 2;
        uint256 quote = f.quoteSell(token, half);
        uint256 s0 = AgentTokenV2(token).totalSupply();
        assertEq(quote, _reserveAt(s0) - _reserveAt(s0 - half));
        vm.prank(bob);
        f.sell(token, half, 0);
        assertEq(AgentTokenV2(token).totalSupply(), out - half);
        assertEq(f.credits(bob), quote);
    }

    function test_sell_validation() public {
        uint256 out = _buy(bob, 1 ether);
        uint256 quote = f.quoteSell(token, out);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactoryV2.Slippage.selector, quote, quote + 1));
        f.sell(token, out, quote + 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.ZeroValue.selector);
        f.sell(token, 0, 0);
        vm.prank(carol); // holds nothing
        vm.expectRevert(AgentTokenV2.InsufficientBalance.selector);
        f.sell(token, 1, 0);
        vm.prank(bob);
        vm.expectRevert(); // amount > supply → arithmetic underflow in the curve
        f.sell(token, out + 1, 0);
        assertEq(f.quoteSell(token, out + 1), 0);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.UnknownToken.selector);
        f.sell(address(0x1234), 1, 0);
    }

    function test_roundTrip_multipleHoldersFIFO() public {
        uint256 a = _buy(bob, 1 ether);
        uint256 b = _buy(carol, 1 ether);
        // later buyer sells first at the higher end of the curve → gets >= what bob paid net? No:
        // carol's tokens sit above bob's on the curve, so she recovers her net input (minus dust).
        uint256 qc = f.quoteSell(token, b);
        assertLe(qc, 0.99 ether);
        assertGe(qc, 0.99 ether - 1e12);
        vm.prank(carol);
        f.sell(token, b, qc);
        uint256 qb = f.quoteSell(token, a);
        assertLe(qb, 0.99 ether);
        assertGe(qb, 0.99 ether - 1e12);
        vm.prank(bob);
        f.sell(token, a, qb);
        assertEq(AgentTokenV2(token).totalSupply(), 0);
        assertEq(address(f).balance, f.credits(bob) + f.credits(carol) + f.credits(treasury) + f.getCurve(token).reserve);
    }

    function testFuzz_curve_roundTripNeverProfits(uint96 in1, uint96 in2) public {
        in1 = uint96(bound(in1, 1e9, 500 ether));
        in2 = uint96(bound(in2, 1e9, 500 ether));
        uint256 o1 = _buy(bob, in1);
        uint256 o2 = _buy(carol, in2);
        uint256 s = AgentTokenV2(token).totalSupply();
        uint256 r = f.getCurve(token).reserve;
        assertGe(r, _reserveAt(s));
        // selling everything back returns at most the net (post-fee) input
        uint256 q = f.quoteSell(token, o1 + o2);
        assertLe(q, r);
        assertLe(q, uint256(in1) - _fee(in1) + uint256(in2) - _fee(in2));
        vm.prank(carol);
        f.sell(token, o2, 0);
        vm.prank(bob);
        f.sell(token, o1, 0);
        assertEq(AgentTokenV2(token).totalSupply(), 0);
        // every wei is accounted for: reserve dust + credits == contract balance
        assertEq(address(f).balance, f.credits(bob) + f.credits(carol) + f.credits(treasury) + f.getCurve(token).reserve);
    }

    // ───────────────────────────── FRC-20 ─────────────────────────────

    function test_frc20_transferAndAllowance() public {
        uint256 out = _buy(bob, 1 ether);
        AgentTokenV2 t = AgentTokenV2(token);
        vm.prank(bob);
        assertTrue(t.transfer(carol, out / 2));
        assertEq(t.balanceOf(carol), out / 2);
        vm.prank(bob);
        vm.expectRevert(AgentTokenV2.InsufficientBalance.selector);
        t.transfer(carol, out);
        vm.prank(bob);
        vm.expectRevert(AgentTokenV2.ZeroAddress.selector);
        t.transfer(address(0), 1);
        vm.prank(bob);
        t.approve(carol, 10);
        assertEq(t.allowance(bob, carol), 10);
        vm.prank(carol);
        vm.expectRevert(AgentTokenV2.InsufficientAllowance.selector);
        t.transferFrom(bob, carol, 11);
        vm.prank(carol);
        t.transferFrom(bob, carol, 10);
        assertEq(t.allowance(bob, carol), 0);
        vm.prank(bob);
        t.approve(carol, type(uint256).max);
        vm.prank(carol);
        t.transferFrom(bob, carol, 1);
        assertEq(t.allowance(bob, carol), type(uint256).max);
        // only the factory mints/burns
        vm.prank(bob);
        vm.expectRevert(AgentTokenV2.NotFactory.selector);
        t.mint(bob, 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenV2.NotFactory.selector);
        t.burn(bob, 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenV2.NotFactory.selector);
        t.addDistribution(1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenV2.NotFactory.selector);
        t.settleClaimable(bob);
    }

    // ───────────────────────────── distributions ─────────────────────────────

    function test_distribute_proRataAndClaim() public {
        _buy(bob, 1 ether);
        uint256 ob = AgentTokenV2(token).balanceOf(bob);
        // carol buys the same number of tokens by transfer to make the math exact
        vm.prank(bob);
        AgentTokenV2(token).transfer(carol, ob / 2);
        uint256 cb = AgentTokenV2(token).balanceOf(carol);
        uint256 bb = AgentTokenV2(token).balanceOf(bob);
        assertEq(bb, ob - cb);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit AgentTokenFactoryV2.Distributed(token, alice, 3 ether);
        f.distribute{value: 3 ether}(token);
        uint256 expB = (3 ether * bb) / ob;
        uint256 expC = (3 ether * cb) / ob;
        assertApproxEqAbs(f.claimable(token, bob), expB, 1);
        assertApproxEqAbs(f.claimable(token, carol), expC, 1);

        uint256 owedB = f.claimable(token, bob);
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit AgentTokenFactoryV2.Claimed(token, bob, owedB);
        f.claimDistribution(token);
        assertEq(f.claimable(token, bob), 0);
        assertApproxEqAbs(f.credits(bob), expB, 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.NothingToClaim.selector);
        f.claimDistribution(token);
        vm.prank(carol);
        f.claimDistribution(token);
        assertApproxEqAbs(f.credits(carol), expC, 1);
        assertLe(f.credits(bob) + f.credits(carol), 3 ether);
        assertEq(AgentTokenV2(token).totalDistributed(), 3 ether);
    }

    function test_distribute_transferAfterSnapshotDoesNotDoubleClaim() public {
        _buy(bob, 1 ether);
        vm.prank(alice);
        f.distribute{value: 1 ether}(token);
        uint256 owed = f.claimable(token, bob);
        assertApproxEqAbs(owed, 1 ether, 1);
        uint256 bal = AgentTokenV2(token).balanceOf(bob);
        vm.prank(bob);
        AgentTokenV2(token).transfer(carol, bal);
        assertEq(f.claimable(token, carol), 0);
        assertEq(f.claimable(token, bob), owed);
        vm.prank(bob);
        f.claimDistribution(token);
        assertEq(f.credits(bob), owed);
        // second distribution goes to carol only
        vm.prank(alice);
        f.distribute{value: 1 ether}(token);
        assertEq(f.claimable(token, bob), 0);
        assertApproxEqAbs(f.claimable(token, carol), 1 ether, 1);
    }

    function test_distribute_sellAfterSnapshotKeepsClaim() public {
        uint256 out = _buy(bob, 1 ether);
        vm.prank(alice);
        f.distribute{value: 1 ether}(token);
        uint256 owed = f.claimable(token, bob);
        uint256 proceeds = f.quoteSell(token, out);
        vm.prank(bob);
        f.sell(token, out, 0);
        assertEq(f.claimable(token, bob), owed);
        vm.prank(bob);
        f.claimDistribution(token);
        assertEq(f.credits(bob), owed + proceeds);
    }

    function test_distribute_noSupplyReverts() public {
        vm.prank(alice);
        vm.expectRevert(AgentTokenV2.NoSupply.selector);
        f.distribute{value: 1 ether}(token);
        vm.prank(alice);
        vm.expectRevert(AgentTokenFactoryV2.ZeroValue.selector);
        f.distribute{value: 0}(token);
        vm.prank(alice);
        vm.expectRevert(AgentTokenFactoryV2.UnknownToken.selector);
        f.distribute{value: 1}(address(0x99));
    }

    // ───────────────────────────── withdraw / governance ─────────────────────────────

    function test_withdraw_andRejecter() public {
        uint256 out = _buy(bob, 1 ether);
        vm.prank(bob);
        f.sell(token, out, 0);
        vm.prank(treasury);
        f.withdraw();
        assertEq(treasury.balance, _fee(1 ether));
        vm.prank(treasury);
        vm.expectRevert(AgentTokenFactoryV2.NothingToWithdraw.selector);
        f.withdraw();
        Rejecter rj = new Rejecter();
        vm.deal(address(rj), 1 ether);
        vm.prank(address(rj));
        f.buy{value: 1 ether}(token, 0);
        uint256 rjBal = AgentTokenV2(token).balanceOf(address(rj));
        vm.prank(address(rj));
        f.sell(token, rjBal, 0);
        uint256 c = f.credits(address(rj));
        vm.prank(address(rj));
        vm.expectRevert(AgentTokenFactoryV2.TransferFailed.selector);
        f.withdraw();
        assertEq(f.credits(address(rj)), c);
    }

    function test_governance() public {
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactoryV2.NotGovernance.selector);
        f.setFee(1);
        vm.startPrank(gov);
        vm.expectRevert(AgentTokenFactoryV2.FeeTooHigh.selector);
        f.setFee(1001);
        f.setFee(0);
        assertEq(f.feeBps(), 0);
        vm.expectRevert(AgentTokenFactoryV2.ZeroAddress.selector);
        f.setFeeRecipient(address(0));
        f.setFeeRecipient(carol);
        vm.expectRevert(AgentTokenFactoryV2.ZeroAddress.selector);
        f.setGovernance(address(0));
        f.setGovernance(carol);
        vm.stopPrank();
        assertEq(f.governance(), carol);
        // zero fee: net == gross
        _buy(bob, 1 ether);
        assertEq(f.getCurve(token).reserve, 1 ether);
    }

    // ═════════════════════════════ V2 fix 5: distribution over a dust supply ═════════════════════════════

    address internal dave = makeAddr("dave");

    /// @notice The live factory: sell down to 1 wei of supply, distribute 1 FMX and claim it straight
    ///         back. magnifiedPerShare is now ~2^188: a buy of more than ~340 tokens overflows outright,
    ///         and the signed corrections overflow once any holder's running total passes ~170 tokens,
    ///         so its next buy or incoming transfer reverts — for good.
    function test_attack_v1_dustDistributionBricksLargeTrades() public {
        AgentTokenFactory f1 = new AgentTokenFactory(registry, gov, treasury);
        vm.prank(alice);
        address t1 = f1.launch(agentId, "SCRB", BASE, SLOPE);
        vm.prank(bob);
        f1.buy{value: 1 ether}(t1, 0);
        uint256 bal = AgentToken(t1).balanceOf(bob);
        vm.prank(bob);
        f1.sell(t1, bal - 1, 0);
        assertEq(AgentToken(t1).totalSupply(), 1);
        vm.prank(bob);
        f1.distribute{value: 1 ether}(t1);
        vm.prank(bob);
        f1.claimDistribution(t1); // bob is the only holder: his 1 FMX comes straight back
        assertEq(AgentToken(t1).claimable(bob), 0);

        // one buy worth ~400 tokens overflows
        vm.prank(carol);
        vm.expectRevert(stdError.arithmeticError);
        f1.buy{value: 13 ether}(t1, 0);

        // a smaller buy goes through …
        vm.prank(carol);
        f1.buy{value: 2 ether}(t1, 0);
        uint256 cb = AgentToken(t1).balanceOf(carol);
        assertGt(cb, 100 ether);
        // … but the same buy again takes carol past ~170 tokens
        vm.prank(carol);
        vm.expectRevert(stdError.arithmeticError);
        f1.buy{value: 2 ether}(t1, 0);
        // and so does a transfer that would
        vm.deal(dave, 10 ether);
        vm.prank(dave);
        f1.buy{value: 2 ether}(t1, 0);
        vm.prank(carol);
        vm.expectRevert(stdError.arithmeticError);
        AgentToken(t1).transfer(dave, cb);
    }

    /// @notice V2 refuses the distribution that sets the trap.
    function test_v2_distributeOverDustSupplyReverts() public {
        uint256 out = _buy(bob, 1 ether);
        vm.prank(bob);
        f.sell(token, out - 1, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenV2.SupplyTooLow.selector, 1, 1e18));
        f.distribute{value: 1 ether}(token);

        _buy(carol, 1 ether);
        uint256 cb = AgentTokenV2(token).balanceOf(carol);
        vm.prank(carol);
        f.sell(token, cb - (1e18 - 2), 0); // supply = 1e18 - 1: one wei short of a whole token
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenV2.SupplyTooLow.selector, 1e18 - 1, 1e18));
        f.distribute{value: 1 ether}(token);
        assertEq(AgentTokenV2(token).MIN_DISTRIBUTION_SUPPLY(), 1e18);
    }

    /// @notice At the floor, a large distribution leaves every later trade working: tens of thousands of
    ///         tokens are bought, moved and sold, and the next distribution splits pro rata.
    function test_v2_distributionAtFloorKeepsLargeTradesWorking() public {
        uint256 out = _buy(bob, 1 ether);
        vm.prank(bob);
        f.sell(token, out - 1e18, 0);
        assertEq(AgentTokenV2(token).totalSupply(), 1e18);
        vm.deal(alice, 2_000 ether);
        vm.prank(alice);
        f.distribute{value: 1_000 ether}(token);
        assertApproxEqAbs(f.claimable(token, bob), 1_000 ether, 1);
        vm.prank(bob);
        f.claimDistribution(token);

        vm.deal(carol, 100_000 ether);
        vm.prank(carol);
        f.buy{value: 50_000 ether}(token, 0);
        uint256 cb = AgentTokenV2(token).balanceOf(carol);
        assertGt(cb, 30_000 ether);
        assertEq(f.claimable(token, carol), 0);
        vm.prank(carol);
        AgentTokenV2(token).transfer(dave, cb / 2);

        vm.prank(alice);
        f.distribute{value: 1 ether}(token);
        uint256 supply = AgentTokenV2(token).totalSupply();
        assertApproxEqAbs(f.claimable(token, dave), (1 ether * (cb / 2)) / supply, 1);
        assertApproxEqAbs(f.claimable(token, carol), (1 ether * (cb - cb / 2)) / supply, 1);
        assertApproxEqAbs(f.claimable(token, bob), (1 ether * 1e18) / supply, 1);

        vm.prank(dave);
        f.sell(token, cb / 2, 0);
        vm.prank(carol);
        f.sell(token, cb - cb / 2, 0);
        vm.prank(dave);
        f.claimDistribution(token);
        assertGt(f.credits(dave), 0);
    }

    /// @notice The floor alone would not be enough: on a cheap flat curve, a large distribution over a
    ///         small (but legal) supply still overflows the live token's mps × value products. V2's
    ///         per-holder settlement does not, and pays the next distribution pro rata.
    function test_v2_cheapCurveLargeDistributionNoOverflow() public {
        uint256 bobAgent = _register(bob, MIN_BOND);
        AgentTokenFactory f1 = new AgentTokenFactory(registry, gov, treasury);
        vm.prank(bob);
        address t1 = f1.launch(bobAgent, "CHEAP", 1, 0); // 1 wei per whole token
        vm.prank(bob);
        address t2 = f.launch(bobAgent, "CHEAP", 1, 0);
        vm.deal(address(this), 2_000_002 ether);
        vm.deal(carol, 2_000 ether);

        f1.buy{value: 2}(t1, 0); // 2 whole tokens, fee rounds to 0
        f.buy{value: 2}(t2, 0);
        assertEq(AgentTokenV2(t2).totalSupply(), 2e18);
        f1.distribute{value: 1_000_000 ether}(t1);
        f.distribute{value: 1_000_000 ether}(t2);

        vm.prank(carol);
        vm.expectRevert(stdError.arithmeticError);
        f1.buy{value: 1_000 ether}(t1, 0);

        vm.prank(carol);
        f.buy{value: 1_000 ether}(t2, 0);
        uint256 cb = AgentTokenV2(t2).balanceOf(carol);
        assertEq(cb, 990e36);
        assertEq(f.claimable(t2, carol), 0);
        assertApproxEqAbs(f.claimable(t2, address(this)), 1_000_000 ether, 1);

        f.distribute{value: 1 ether}(t2);
        uint256 supply = AgentTokenV2(t2).totalSupply();
        assertApproxEqAbs(f.claimable(t2, carol), (1 ether * cb) / supply, 1);
        vm.prank(carol);
        f.sell(t2, cb, 0);
        vm.prank(carol);
        f.claimDistribution(t2);
    }

    /// @notice Wherever the live token works, V2 pays every holder exactly the same.
    function testFuzz_v2_matchesV1WhereV1Works(uint96 a, uint96 b, uint96 d1, uint96 d2, uint8 pct) public {
        a = uint96(bound(a, 1 ether, 100 ether));
        b = uint96(bound(b, 1 ether, 100 ether));
        d1 = uint96(bound(d1, 1, 50 ether));
        d2 = uint96(bound(d2, 1, 50 ether));
        pct = uint8(bound(pct, 0, 100));
        AgentTokenFactory f1 = new AgentTokenFactory(registry, gov, treasury);
        vm.prank(alice);
        address t1 = f1.launch(agentId, "SCRB", BASE, SLOPE);
        vm.deal(address(this), 200 ether);

        // identical history on both
        vm.prank(bob);
        f1.buy{value: a}(t1, 0);
        _buy(bob, a);
        f1.distribute{value: d1}(t1);
        f.distribute{value: d1}(token);
        vm.prank(carol);
        f1.buy{value: b}(t1, 0);
        _buy(carol, b);
        uint256 moved = (AgentToken(t1).balanceOf(bob) * pct) / 100;
        vm.prank(bob);
        AgentToken(t1).transfer(dave, moved);
        vm.prank(bob);
        AgentTokenV2(token).transfer(dave, moved);
        f1.distribute{value: d2}(t1);
        f.distribute{value: d2}(token);
        uint256 half = AgentToken(t1).balanceOf(carol) / 2;
        vm.prank(carol);
        f1.sell(t1, half, 0);
        vm.prank(carol);
        f.sell(token, half, 0);

        assertEq(AgentTokenV2(token).balanceOf(bob), AgentToken(t1).balanceOf(bob));
        assertEq(f.claimable(token, bob), f1.claimable(t1, bob));
        assertEq(f.claimable(token, carol), f1.claimable(t1, carol));
        assertEq(f.claimable(token, dave), f1.claimable(t1, dave));
    }

    /// @notice Whatever the order of trades and distributions, holders can never claim more than was
    ///         distributed, and the factory always holds what it owes.
    function testFuzz_v2_distributionsConserveValue(uint96 a, uint96 b, uint96 d1, uint96 d2, uint8 pct) public {
        a = uint96(bound(a, 1 ether, 10_000 ether));
        b = uint96(bound(b, 1 ether, 10_000 ether));
        d1 = uint96(bound(d1, 1, 1_000 ether));
        d2 = uint96(bound(d2, 1, 1_000 ether));
        pct = uint8(bound(pct, 0, 100));
        vm.deal(bob, 20_000 ether);
        vm.deal(carol, 20_000 ether);
        vm.deal(address(this), 2_000 ether);
        _buy(bob, a);
        f.distribute{value: d1}(token);
        _buy(carol, b);
        uint256 moved = (AgentTokenV2(token).balanceOf(bob) * pct) / 100;
        vm.prank(bob);
        AgentTokenV2(token).transfer(dave, moved);
        f.distribute{value: d2}(token);
        uint256 cb = AgentTokenV2(token).balanceOf(carol);
        vm.prank(carol);
        f.sell(token, cb, 0);

        address[3] memory holders = [bob, carol, dave];
        uint256 claimed;
        for (uint256 i = 0; i < 3; i++) {
            if (f.claimable(token, holders[i]) != 0) {
                vm.prank(holders[i]);
                f.claimDistribution(token);
            }
            claimed += AgentTokenV2(token).distributionsClaimed(holders[i]);
        }
        assertLe(claimed, uint256(d1) + d2);
        assertGe(claimed + 3, uint256(d1) + d2 - 2); // only rounding dust stays unclaimed
        assertEq(
            address(f).balance,
            f.credits(bob) + f.credits(carol) + f.credits(dave) + f.credits(treasury) + f.getCurve(token).reserve
                + (uint256(d1) + d2 - claimed)
        );
    }
}
