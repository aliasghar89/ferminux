// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, Rejecter} from "./Base.t.sol";
import {AgentTokenFactory, AgentToken} from "../src/AgentTokenFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentTokenFactoryTest is BaseTest {
    AgentTokenFactory internal f;
    uint256 internal agentId;
    address internal token;

    uint256 internal constant BASE = 0.01 ether; // 0.01 FMX per token at s = 0
    uint256 internal constant SLOPE = 0.0001 ether; // +0.0001 FMX per whole token minted
    uint256 internal constant WAD = 1e18;

    function setUp() public override {
        super.setUp();
        f = new AgentTokenFactory(registry, gov, treasury);
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
        uint256 before = AgentToken(token).balanceOf(who);
        vm.prank(who);
        f.buy{value: fmx}(token, 0);
        out = AgentToken(token).balanceOf(who) - before;
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
        AgentTokenFactory.Curve memory c = f.getCurve(token);
        assertEq(c.agentId, agentId);
        assertEq(c.base, BASE);
        assertEq(c.slope, SLOPE);
        assertEq(c.reserve, 0);
        assertEq(f.price(token), BASE);
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(AgentTokenFactory.ZeroAddress.selector);
        new AgentTokenFactory(AgentRegistry(address(0)), gov, treasury);
        vm.expectRevert(AgentTokenFactory.ZeroAddress.selector);
        new AgentTokenFactory(registry, address(0), treasury);
        vm.expectRevert(AgentTokenFactory.ZeroAddress.selector);
        new AgentTokenFactory(registry, gov, address(0));
    }

    function test_launch_tokenMetadata() public view {
        AgentToken t = AgentToken(token);
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
        emit AgentTokenFactory.Launched(id2, address(0), "BOB");
        // token address is unknown ahead of time → check topic1 + data only
        f.launch(id2, "BOB", BASE, 0);
        assertEq(f.tokenCount(), 2);
    }

    function test_launch_validation() public {
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.NotAgentOwner.selector);
        f.launch(agentId, "X", BASE, SLOPE);
        vm.prank(alice);
        vm.expectRevert(AgentTokenFactory.UnknownAgent.selector);
        f.launch(99, "X", BASE, SLOPE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactory.AlreadyLaunched.selector, token));
        f.launch(agentId, "X", BASE, SLOPE);
        uint256 id2 = _register(bob, MIN_BOND);
        vm.startPrank(bob);
        vm.expectRevert(AgentTokenFactory.InvalidSymbol.selector);
        f.launch(id2, "", BASE, SLOPE);
        vm.expectRevert(AgentTokenFactory.InvalidSymbol.selector);
        f.launch(id2, "TWELVECHARSX", BASE, SLOPE);
        vm.expectRevert(AgentTokenFactory.InvalidCurve.selector);
        f.launch(id2, "B", 0, 0);
        vm.expectRevert(AgentTokenFactory.InvalidCurve.selector);
        f.launch(id2, "B", 1e30 + 1, 0);
        vm.expectRevert(AgentTokenFactory.InvalidCurve.selector);
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
        emit AgentTokenFactory.Bought(token, bob, 1 ether, fee, quoted);
        f.buy{value: 1 ether}(token, quoted);
        assertEq(AgentToken(token).balanceOf(bob), quoted);
        assertEq(AgentToken(token).totalSupply(), quoted);
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
        uint256 s = AgentToken(token).totalSupply();
        uint256 r = f.getCurve(token).reserve;
        assertGe(r, _reserveAt(s));
        assertLe(r - _reserveAt(s), 1e12); // dust only
    }

    function test_buy_slippageAndZero() public {
        uint256 quoted = f.quoteBuy(token, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactory.Slippage.selector, quoted, quoted + 1));
        f.buy{value: 1 ether}(token, quoted + 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.ZeroValue.selector);
        f.buy{value: 0}(token, 0);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.UnknownToken.selector);
        f.buy{value: 1 ether}(address(0x1234), 0);
        // 1 wei buys nothing → Slippage(0, 0)
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactory.Slippage.selector, 0, 0));
        f.buy{value: 1}(token, 0);
    }

    function test_buy_priceRisesWithSupply() public {
        uint256 out1 = _buy(bob, 1 ether);
        uint256 out2 = _buy(bob, 1 ether);
        assertLt(out2, out1);
        assertEq(f.price(token), BASE + (SLOPE * AgentToken(token).totalSupply()) / WAD);
    }

    function test_buy_flatCurve() public {
        uint256 id2 = _register(bob, MIN_BOND);
        vm.prank(bob);
        address t2 = f.launch(id2, "FLAT", 0.5 ether, 0);
        assertEq(f.quoteBuy(t2, 1 ether), (0.99 ether * WAD) / 0.5 ether);
        vm.prank(carol);
        f.buy{value: 1 ether}(t2, 0);
        assertEq(AgentToken(t2).balanceOf(carol), 1.98 ether);
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
        emit AgentTokenFactory.Sold(token, bob, out, quote);
        f.sell(token, out, quote);
        assertEq(AgentToken(token).balanceOf(bob), 0);
        assertEq(AgentToken(token).totalSupply(), 0);
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
        uint256 s0 = AgentToken(token).totalSupply();
        assertEq(quote, _reserveAt(s0) - _reserveAt(s0 - half));
        vm.prank(bob);
        f.sell(token, half, 0);
        assertEq(AgentToken(token).totalSupply(), out - half);
        assertEq(f.credits(bob), quote);
    }

    function test_sell_validation() public {
        uint256 out = _buy(bob, 1 ether);
        uint256 quote = f.quoteSell(token, out);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentTokenFactory.Slippage.selector, quote, quote + 1));
        f.sell(token, out, quote + 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.ZeroValue.selector);
        f.sell(token, 0, 0);
        vm.prank(carol); // holds nothing
        vm.expectRevert(AgentToken.InsufficientBalance.selector);
        f.sell(token, 1, 0);
        vm.prank(bob);
        vm.expectRevert(); // amount > supply → arithmetic underflow in the curve
        f.sell(token, out + 1, 0);
        assertEq(f.quoteSell(token, out + 1), 0);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.UnknownToken.selector);
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
        assertEq(AgentToken(token).totalSupply(), 0);
        assertEq(address(f).balance, f.credits(bob) + f.credits(carol) + f.credits(treasury) + f.getCurve(token).reserve);
    }

    function testFuzz_curve_roundTripNeverProfits(uint96 in1, uint96 in2) public {
        in1 = uint96(bound(in1, 1e9, 500 ether));
        in2 = uint96(bound(in2, 1e9, 500 ether));
        uint256 o1 = _buy(bob, in1);
        uint256 o2 = _buy(carol, in2);
        uint256 s = AgentToken(token).totalSupply();
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
        assertEq(AgentToken(token).totalSupply(), 0);
        // every wei is accounted for: reserve dust + credits == contract balance
        assertEq(address(f).balance, f.credits(bob) + f.credits(carol) + f.credits(treasury) + f.getCurve(token).reserve);
    }

    // ───────────────────────────── ERC-20 ─────────────────────────────

    function test_erc20_transferAndAllowance() public {
        uint256 out = _buy(bob, 1 ether);
        AgentToken t = AgentToken(token);
        vm.prank(bob);
        assertTrue(t.transfer(carol, out / 2));
        assertEq(t.balanceOf(carol), out / 2);
        vm.prank(bob);
        vm.expectRevert(AgentToken.InsufficientBalance.selector);
        t.transfer(carol, out);
        vm.prank(bob);
        vm.expectRevert(AgentToken.ZeroAddress.selector);
        t.transfer(address(0), 1);
        vm.prank(bob);
        t.approve(carol, 10);
        assertEq(t.allowance(bob, carol), 10);
        vm.prank(carol);
        vm.expectRevert(AgentToken.InsufficientAllowance.selector);
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
        vm.expectRevert(AgentToken.NotFactory.selector);
        t.mint(bob, 1);
        vm.prank(bob);
        vm.expectRevert(AgentToken.NotFactory.selector);
        t.burn(bob, 1);
        vm.prank(bob);
        vm.expectRevert(AgentToken.NotFactory.selector);
        t.addDistribution(1);
        vm.prank(bob);
        vm.expectRevert(AgentToken.NotFactory.selector);
        t.settleClaimable(bob);
    }

    // ───────────────────────────── distributions ─────────────────────────────

    function test_distribute_proRataAndClaim() public {
        _buy(bob, 1 ether);
        uint256 ob = AgentToken(token).balanceOf(bob);
        // carol buys the same number of tokens by transfer to make the math exact
        vm.prank(bob);
        AgentToken(token).transfer(carol, ob / 2);
        uint256 cb = AgentToken(token).balanceOf(carol);
        uint256 bb = AgentToken(token).balanceOf(bob);
        assertEq(bb, ob - cb);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit AgentTokenFactory.Distributed(token, alice, 3 ether);
        f.distribute{value: 3 ether}(token);
        uint256 expB = (3 ether * bb) / ob;
        uint256 expC = (3 ether * cb) / ob;
        assertApproxEqAbs(f.claimable(token, bob), expB, 1);
        assertApproxEqAbs(f.claimable(token, carol), expC, 1);

        uint256 owedB = f.claimable(token, bob);
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit AgentTokenFactory.Claimed(token, bob, owedB);
        f.claimDistribution(token);
        assertEq(f.claimable(token, bob), 0);
        assertApproxEqAbs(f.credits(bob), expB, 1);
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.NothingToClaim.selector);
        f.claimDistribution(token);
        vm.prank(carol);
        f.claimDistribution(token);
        assertApproxEqAbs(f.credits(carol), expC, 1);
        assertLe(f.credits(bob) + f.credits(carol), 3 ether);
        assertEq(AgentToken(token).totalDistributed(), 3 ether);
    }

    function test_distribute_transferAfterSnapshotDoesNotDoubleClaim() public {
        _buy(bob, 1 ether);
        vm.prank(alice);
        f.distribute{value: 1 ether}(token);
        uint256 owed = f.claimable(token, bob);
        assertApproxEqAbs(owed, 1 ether, 1);
        uint256 bal = AgentToken(token).balanceOf(bob);
        vm.prank(bob);
        AgentToken(token).transfer(carol, bal);
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
        vm.expectRevert(AgentToken.NoSupply.selector);
        f.distribute{value: 1 ether}(token);
        vm.prank(alice);
        vm.expectRevert(AgentTokenFactory.ZeroValue.selector);
        f.distribute{value: 0}(token);
        vm.prank(alice);
        vm.expectRevert(AgentTokenFactory.UnknownToken.selector);
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
        vm.expectRevert(AgentTokenFactory.NothingToWithdraw.selector);
        f.withdraw();
        Rejecter rj = new Rejecter();
        vm.deal(address(rj), 1 ether);
        vm.prank(address(rj));
        f.buy{value: 1 ether}(token, 0);
        uint256 rjBal = AgentToken(token).balanceOf(address(rj));
        vm.prank(address(rj));
        f.sell(token, rjBal, 0);
        uint256 c = f.credits(address(rj));
        vm.prank(address(rj));
        vm.expectRevert(AgentTokenFactory.TransferFailed.selector);
        f.withdraw();
        assertEq(f.credits(address(rj)), c);
    }

    function test_governance() public {
        vm.prank(bob);
        vm.expectRevert(AgentTokenFactory.NotGovernance.selector);
        f.setFee(1);
        vm.startPrank(gov);
        vm.expectRevert(AgentTokenFactory.FeeTooHigh.selector);
        f.setFee(1001);
        f.setFee(0);
        assertEq(f.feeBps(), 0);
        vm.expectRevert(AgentTokenFactory.ZeroAddress.selector);
        f.setFeeRecipient(address(0));
        f.setFeeRecipient(carol);
        vm.expectRevert(AgentTokenFactory.ZeroAddress.selector);
        f.setGovernance(address(0));
        f.setGovernance(carol);
        vm.stopPrank();
        assertEq(f.governance(), carol);
        // zero fee: net == gross
        _buy(bob, 1 ether);
        assertEq(f.getCurve(token).reserve, 1 ether);
    }
}
