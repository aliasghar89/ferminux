// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StreamPay} from "../src/StreamPay.sol";
import {Rejecter} from "./Base.t.sol";

contract StreamPayTest is Test {
    StreamPay internal sp;

    address internal gov = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal other = makeAddr("other");

    uint256 internal constant RATE = 1e15; // 0.001 FMX / s
    uint256 internal constant DEPOSIT = 3600 * RATE; // 1 hour
    uint256 internal constant PRICE = 10 ether;
    uint64 internal constant PERIOD = 30 days;

    function setUp() public {
        sp = new StreamPay(gov, treasury);
        vm.deal(payer, 1_000 ether);
        vm.deal(other, 1_000 ether);
        vm.warp(1_700_000_000);
    }

    function _fee(uint256 a) internal view returns (uint256) {
        return (a * sp.feeBps()) / 10000;
    }

    function _open() internal returns (uint256 id) {
        vm.prank(payer);
        id = sp.openStream{value: DEPOSIT}(payee, RATE);
    }

    function _plan() internal returns (uint256 planId) {
        vm.prank(payee);
        planId = sp.createPlan(PRICE, PERIOD, "fmx://payload/0xplan");
    }

    function _sub(uint256 planId, uint32 periods) internal returns (uint256 subId) {
        vm.prank(payer);
        subId = sp.subscribe{value: periods * PRICE}(planId, periods);
    }

    // ───────────────────────────── deploy ─────────────────────────────

    function test_deployState() public view {
        assertEq(sp.governance(), gov);
        assertEq(sp.feeRecipient(), treasury);
        assertEq(sp.feeBps(), 100);
        assertEq(sp.nextStreamId(), 0);
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(StreamPay.ZeroAddress.selector);
        new StreamPay(address(0), treasury);
        vm.expectRevert(StreamPay.ZeroAddress.selector);
        new StreamPay(gov, address(0));
    }

    // ───────────────────────────── streams ─────────────────────────────

    function test_openStream_happyPath() public {
        uint64 start = uint64(block.timestamp);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.StreamOpened(1, payer, payee, RATE, DEPOSIT, start, start + 3600);
        uint256 id = sp.openStream{value: DEPOSIT}(payee, RATE);
        assertEq(id, 1);
        StreamPay.Stream memory s = sp.getStream(id);
        assertEq(s.payer, payer);
        assertEq(s.payee, payee);
        assertEq(s.ratePerSec, RATE);
        assertEq(s.deposit, DEPOSIT);
        assertEq(s.withdrawn, 0);
        assertEq(s.start, start);
        assertEq(s.stop, start + 3600);
        assertFalse(s.cancelled);
        assertEq(sp.claimable(id), 0);
    }

    function test_openStream_validation() public {
        vm.startPrank(payer);
        vm.expectRevert(StreamPay.ZeroAddress.selector);
        sp.openStream{value: DEPOSIT}(address(0), RATE);
        vm.expectRevert(StreamPay.SelfPayment.selector);
        sp.openStream{value: DEPOSIT}(payer, RATE);
        vm.expectRevert(StreamPay.ZeroRate.selector);
        sp.openStream{value: DEPOSIT}(payee, 0);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.InsufficientDeposit.selector, RATE - 1, RATE));
        sp.openStream{value: RATE - 1}(payee, RATE);
        vm.stopPrank();
    }

    function test_stream_accrualMath() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 1);
        assertEq(sp.claimable(id), RATE);
        vm.warp(block.timestamp + 1799);
        assertEq(sp.claimable(id), 1800 * RATE);
        vm.warp(block.timestamp + 1800); // exactly at stop
        assertEq(sp.claimable(id), DEPOSIT);
        vm.warp(block.timestamp + 100_000); // long after stop — capped
        assertEq(sp.claimable(id), DEPOSIT);
    }

    function test_stream_roundingDustStaysWithPayer() public {
        vm.prank(payer);
        uint256 id = sp.openStream{value: 10 * RATE + 7}(payee, RATE);
        StreamPay.Stream memory s = sp.getStream(id);
        assertEq(s.stop - s.start, 10);
        vm.warp(block.timestamp + 100);
        assertEq(sp.claimable(id), 10 * RATE);
        vm.prank(payer);
        sp.cancelStream(id);
        assertEq(sp.credits(payer), 7);
        assertEq(sp.credits(payee) + sp.credits(treasury), 10 * RATE);
    }

    function test_claimStream_partialThenRest() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 600);
        uint256 a1 = 600 * RATE;
        uint256 f1 = _fee(a1);
        vm.prank(payee);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.StreamClaimed(id, a1 - f1, f1);
        sp.claimStream(id);
        assertEq(sp.credits(payee), a1 - _fee(a1));
        assertEq(sp.credits(treasury), _fee(a1));
        assertEq(sp.getStream(id).withdrawn, a1);
        assertEq(sp.claimable(id), 0);

        vm.warp(block.timestamp + 10_000);
        vm.prank(payee);
        sp.claimStream(id);
        assertEq(sp.getStream(id).withdrawn, DEPOSIT);
        assertEq(sp.credits(payee) + sp.credits(treasury), DEPOSIT);
        vm.prank(payee);
        vm.expectRevert(StreamPay.NothingToClaim.selector);
        sp.claimStream(id);
    }

    function test_claimStream_auth() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 10);
        vm.prank(payer);
        vm.expectRevert(StreamPay.NotPayee.selector);
        sp.claimStream(id);
        vm.prank(payee);
        vm.expectRevert(StreamPay.UnknownStream.selector);
        sp.claimStream(99);
    }

    function test_topUp_extendsStop() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 1800);
        uint64 stop0 = sp.getStream(id).stop;
        vm.prank(other);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.StreamToppedUp(id, DEPOSIT, 2 * DEPOSIT, stop0 + 3600);
        sp.topUp{value: DEPOSIT}(id);
        assertEq(sp.getStream(id).stop, stop0 + 3600);
        vm.warp(block.timestamp + 10_000);
        assertEq(sp.claimable(id), 2 * DEPOSIT);
    }

    function test_topUp_revertsAfterStopOrCancelledOrZero() public {
        uint256 id = _open();
        vm.prank(payer);
        vm.expectRevert(StreamPay.ZeroValue.selector);
        sp.topUp{value: 0}(id);
        vm.warp(block.timestamp + 3600);
        vm.prank(payer);
        vm.expectRevert(StreamPay.StreamEnded.selector);
        sp.topUp{value: 1 ether}(id);
        uint256 id2 = _open();
        vm.prank(payer);
        sp.cancelStream(id2);
        vm.prank(payer);
        vm.expectRevert(StreamPay.StreamAlreadyCancelled.selector);
        sp.topUp{value: 1 ether}(id2);
        vm.prank(payer);
        vm.expectRevert(StreamPay.UnknownStream.selector);
        sp.topUp{value: 1 ether}(42);
    }

    function test_cancelStream_byPayerMidway() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 900);
        uint256 accrued = 900 * RATE;
        uint256 f = _fee(accrued);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.StreamCancelled(id, payer, accrued - f, f, DEPOSIT - accrued);
        sp.cancelStream(id);
        StreamPay.Stream memory s = sp.getStream(id);
        assertTrue(s.cancelled);
        assertEq(s.withdrawn, accrued);
        assertEq(sp.credits(payer), DEPOSIT - accrued);
        assertEq(sp.credits(payee), accrued - _fee(accrued));
        assertEq(sp.claimable(id), 0);
        // no further action
        vm.prank(payee);
        vm.expectRevert(StreamPay.StreamAlreadyCancelled.selector);
        sp.claimStream(id);
        vm.prank(payee);
        vm.expectRevert(StreamPay.StreamAlreadyCancelled.selector);
        sp.cancelStream(id);
    }

    function test_cancelStream_byPayeeAfterPartialClaim() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 600);
        vm.prank(payee);
        sp.claimStream(id);
        vm.warp(block.timestamp + 600);
        vm.prank(payee);
        sp.cancelStream(id);
        uint256 accrued = 1200 * RATE;
        assertEq(sp.credits(payer), DEPOSIT - accrued);
        assertEq(sp.credits(payee) + sp.credits(treasury), accrued);
    }

    function test_cancelStream_atZeroElapsedRefundsAll() public {
        uint256 id = _open();
        vm.prank(payer);
        sp.cancelStream(id);
        assertEq(sp.credits(payer), DEPOSIT);
        assertEq(sp.credits(payee), 0);
        assertEq(sp.credits(treasury), 0);
    }

    function test_cancelStream_auth() public {
        uint256 id = _open();
        vm.prank(other);
        vm.expectRevert(StreamPay.NotParty.selector);
        sp.cancelStream(id);
    }

    function testFuzz_stream_conservesValue(uint96 deposit, uint64 rate, uint32 dt) public {
        rate = uint64(bound(rate, 1, 1e18));
        deposit = uint96(bound(deposit, rate, 100 ether));
        vm.prank(payer);
        uint256 id = sp.openStream{value: deposit}(payee, rate);
        vm.warp(block.timestamp + dt);
        vm.prank(payee);
        sp.cancelStream(id);
        assertEq(sp.credits(payer) + sp.credits(payee) + sp.credits(treasury), deposit);
    }

    // ───────────────────────────── plans ─────────────────────────────

    function test_createPlan() public {
        vm.prank(payee);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.PlanCreated(1, payee, PRICE, PERIOD, "fmx://payload/0xplan");
        uint256 planId = sp.createPlan(PRICE, PERIOD, "fmx://payload/0xplan");
        StreamPay.Plan memory p = sp.getPlan(planId);
        assertEq(p.payee, payee);
        assertEq(p.pricePerPeriod, PRICE);
        assertEq(p.period, PERIOD);
        assertTrue(p.active);
        assertEq(p.metadataURI, "fmx://payload/0xplan");
    }

    function test_createPlan_validation() public {
        vm.startPrank(payee);
        vm.expectRevert(StreamPay.ZeroValue.selector);
        sp.createPlan(0, PERIOD, "");
        vm.expectRevert(StreamPay.ZeroRate.selector);
        sp.createPlan(PRICE, 0, "");
        vm.expectRevert(StreamPay.StringTooLong.selector);
        sp.createPlan(PRICE, PERIOD, string(new bytes(257)));
        vm.stopPrank();
    }

    function test_setPlanActive() public {
        uint256 planId = _plan();
        vm.prank(other);
        vm.expectRevert(StreamPay.NotPayee.selector);
        sp.setPlanActive(planId, false);
        vm.prank(payee);
        vm.expectRevert(StreamPay.UnknownPlan.selector);
        sp.setPlanActive(9, false);
        vm.prank(payee);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.PlanActiveSet(planId, false);
        sp.setPlanActive(planId, false);
        assertFalse(sp.getPlan(planId).active);
        vm.prank(payer);
        vm.expectRevert(StreamPay.PlanInactive.selector);
        sp.subscribe{value: PRICE}(planId, 1);
    }

    // ───────────────────────────── subscriptions ─────────────────────────────

    function test_subscribe_happyPath() public {
        uint256 planId = _plan();
        uint64 through = uint64(block.timestamp + 3 * PERIOD);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.Subscribed(1, planId, payer, 3, through);
        uint256 subId = sp.subscribe{value: 3 * PRICE}(planId, 3);
        StreamPay.Sub memory s = sp.getSub(subId);
        assertEq(s.planId, planId);
        assertEq(s.payer, payer);
        assertEq(s.paidThrough, through);
        assertFalse(s.cancelled);
        assertEq(s.prepaid, 3 * PRICE);
        assertTrue(sp.isSubscribed(planId, payer));
        assertFalse(sp.isSubscribed(planId, other));
        assertEq(sp.subOf(planId, payer), subId);
        // first period is due immediately (billed at period start)
        assertEq(sp.dueSubPeriods(subId), 1);
    }

    function test_subscribe_validation() public {
        uint256 planId = _plan();
        vm.startPrank(payer);
        vm.expectRevert(StreamPay.UnknownPlan.selector);
        sp.subscribe{value: PRICE}(7, 1);
        vm.expectRevert(StreamPay.ZeroPeriods.selector);
        sp.subscribe{value: 0}(planId, 0);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.WrongPayment.selector, PRICE - 1, PRICE));
        sp.subscribe{value: PRICE - 1}(planId, 1);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.WrongPayment.selector, PRICE + 1, PRICE));
        sp.subscribe{value: PRICE + 1}(planId, 1);
        uint256 subId = sp.subscribe{value: PRICE}(planId, 1);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.AlreadySubscribed.selector, subId));
        sp.subscribe{value: PRICE}(planId, 1);
        vm.stopPrank();
        vm.deal(payee, PRICE);
        vm.prank(payee);
        vm.expectRevert(StreamPay.SelfPayment.selector);
        sp.subscribe{value: PRICE}(planId, 1);
    }

    function test_claimSub_accruesPerPeriodStart() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 3);
        // t0: period 1 due
        uint256 f = _fee(PRICE);
        vm.prank(payee);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.SubClaimed(subId, 1, PRICE - f, f);
        sp.claimSub(subId);
        assertEq(sp.getSub(subId).prepaid, 2 * PRICE);
        vm.prank(payee);
        vm.expectRevert(StreamPay.NothingToClaim.selector);
        sp.claimSub(subId);
        // one second before period 2 starts: nothing
        vm.warp(block.timestamp + PERIOD - 1);
        assertEq(sp.dueSubPeriods(subId), 0);
        vm.warp(block.timestamp + 1);
        assertEq(sp.dueSubPeriods(subId), 1);
        // far in the future: remaining 2 periods, never more than prepaid
        vm.warp(block.timestamp + 10 * PERIOD);
        assertEq(sp.dueSubPeriods(subId), 2);
        vm.prank(payee);
        sp.claimSub(subId);
        assertEq(sp.getSub(subId).prepaid, 0);
        assertEq(sp.credits(payee) + sp.credits(treasury), 3 * PRICE);
        assertFalse(sp.isSubscribed(planId, payer)); // lapsed
    }

    function test_claimSub_auth() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 1);
        vm.prank(other);
        vm.expectRevert(StreamPay.NotPayee.selector);
        sp.claimSub(subId);
        vm.prank(payee);
        vm.expectRevert(StreamPay.UnknownSub.selector);
        sp.claimSub(77);
    }

    function test_cancelSub_refundsUnstartedPeriods() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 4);
        vm.warp(block.timestamp + PERIOD + 1); // periods 1 and 2 started
        uint256 f = _fee(2 * PRICE);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.SubClaimed(subId, 2, 2 * PRICE - f, f);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.SubCancelled(subId, 2 * PRICE);
        sp.cancelSub(subId);
        StreamPay.Sub memory s = sp.getSub(subId);
        assertTrue(s.cancelled);
        assertEq(s.prepaid, 0);
        assertEq(s.paidThrough, uint64(block.timestamp));
        assertEq(sp.credits(payer), 2 * PRICE);
        assertEq(sp.credits(payee) + sp.credits(treasury), 2 * PRICE);
        assertFalse(sp.isSubscribed(planId, payer));
        assertEq(sp.dueSubPeriods(subId), 0);
        vm.prank(payer);
        vm.expectRevert(StreamPay.SubAlreadyCancelled.selector);
        sp.cancelSub(subId);
        vm.prank(payee);
        vm.expectRevert(StreamPay.SubAlreadyCancelled.selector);
        sp.claimSub(subId);
        // may subscribe again afterwards
        uint256 subId2 = _sub(planId, 1);
        assertTrue(subId2 != subId);
        assertTrue(sp.isSubscribed(planId, payer));
    }

    function test_cancelSub_auth() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 1);
        vm.prank(other);
        vm.expectRevert(StreamPay.NotPayer.selector);
        sp.cancelSub(subId);
        vm.prank(payer);
        vm.expectRevert(StreamPay.UnknownSub.selector);
        sp.cancelSub(5);
    }

    function test_renew_extendsAndSettles() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 2);
        uint64 through0 = sp.getSub(subId).paidThrough;
        vm.warp(block.timestamp + 10);
        uint256 f = _fee(PRICE);
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.SubClaimed(subId, 1, PRICE - f, f); // period 1 settled on renew
        vm.expectEmit(true, true, true, true);
        emit StreamPay.SubRenewed(subId, 3, through0 + 3 * PERIOD);
        sp.renew{value: 3 * PRICE}(subId, 3);
        StreamPay.Sub memory s = sp.getSub(subId);
        assertEq(s.paidThrough, through0 + 3 * PERIOD);
        assertEq(s.prepaid, 4 * PRICE); // 1 unclaimed + 3 new
        // accrual anchor is unchanged: period 2 starts at t0 + PERIOD
        vm.warp(1_700_000_000 + PERIOD);
        assertEq(sp.dueSubPeriods(subId), 1);
        vm.warp(1_700_000_000 + 5 * PERIOD);
        assertEq(sp.dueSubPeriods(subId), 4);
    }

    function test_renew_lapsedRestartsFromNow() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 1);
        vm.warp(block.timestamp + 3 * PERIOD);
        assertFalse(sp.isSubscribed(planId, payer));
        vm.prank(payer);
        sp.renew{value: 2 * PRICE}(subId, 2);
        StreamPay.Sub memory s = sp.getSub(subId);
        assertEq(s.paidThrough, uint64(block.timestamp + 2 * PERIOD));
        assertEq(s.prepaid, 2 * PRICE);
        assertTrue(sp.isSubscribed(planId, payer));
        assertEq(sp.dueSubPeriods(subId), 1); // new period 1 started now
        assertEq(sp.credits(payee) + sp.credits(treasury), PRICE); // the old period was settled
    }

    function test_renew_validation() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 1);
        vm.prank(other);
        vm.expectRevert(StreamPay.NotPayer.selector);
        sp.renew{value: PRICE}(subId, 1);
        vm.prank(payer);
        vm.expectRevert(StreamPay.ZeroPeriods.selector);
        sp.renew{value: 0}(subId, 0);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(StreamPay.WrongPayment.selector, 1, PRICE));
        sp.renew{value: 1}(subId, 1);
        vm.prank(payee);
        sp.setPlanActive(planId, false);
        vm.prank(payer);
        vm.expectRevert(StreamPay.PlanInactive.selector);
        sp.renew{value: PRICE}(subId, 1);
        vm.prank(payer);
        vm.expectRevert(StreamPay.UnknownSub.selector);
        sp.renew{value: PRICE}(9, 1);
    }

    function test_sub_inactivePlanStillClaimableAndCancellable() public {
        uint256 planId = _plan();
        uint256 subId = _sub(planId, 2);
        vm.prank(payee);
        sp.setPlanActive(planId, false);
        vm.prank(payee);
        sp.claimSub(subId);
        vm.prank(payer);
        sp.cancelSub(subId);
        assertEq(sp.credits(payer), PRICE);
    }

    function testFuzz_sub_conservesValue(uint8 periods, uint32 dt, bool cancel) public {
        periods = uint8(bound(periods, 1, 24));
        uint256 planId = _plan();
        uint256 subId = _sub(planId, periods);
        vm.warp(block.timestamp + dt);
        if (cancel) {
            vm.prank(payer);
            sp.cancelSub(subId);
        } else {
            vm.prank(payee);
            sp.claimSub(subId);
        }
        uint256 total = uint256(periods) * PRICE;
        assertEq(sp.credits(payer) + sp.credits(payee) + sp.credits(treasury) + sp.getSub(subId).prepaid, total);
    }

    // ───────────────────────────── withdraw ─────────────────────────────

    function test_withdraw() public {
        uint256 id = _open();
        vm.warp(block.timestamp + 100);
        vm.prank(payer);
        sp.cancelStream(id);
        uint256 refund = sp.credits(payer);
        uint256 before = payer.balance;
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit StreamPay.Withdrawn(payer, refund);
        sp.withdraw();
        assertEq(payer.balance, before + refund);
        vm.prank(payer);
        vm.expectRevert(StreamPay.NothingToWithdraw.selector);
        sp.withdraw();
        vm.prank(payee);
        sp.withdraw();
        vm.prank(treasury);
        sp.withdraw();
        assertEq(address(sp).balance, 0);
    }

    function test_withdraw_rejecterRollsBack() public {
        Rejecter rj = new Rejecter();
        vm.prank(payer);
        uint256 id = sp.openStream{value: DEPOSIT}(address(rj), RATE);
        vm.warp(block.timestamp + 10);
        vm.prank(address(rj));
        sp.claimStream(id);
        uint256 c = sp.credits(address(rj));
        vm.prank(address(rj));
        vm.expectRevert(StreamPay.TransferFailed.selector);
        sp.withdraw();
        assertEq(sp.credits(address(rj)), c);
    }

    function test_withdraw_reentrancyBlocked() public {
        ReenterStream re = new ReenterStream(sp);
        vm.prank(payer);
        uint256 id = sp.openStream{value: DEPOSIT}(address(re), RATE);
        vm.warp(block.timestamp + 3600);
        re.claim(id);
        re.pull();
        assertFalse(re.reentered());
        assertEq(sp.credits(address(re)), 0);
    }

    // ───────────────────────────── governance ─────────────────────────────

    function test_governance() public {
        vm.prank(other);
        vm.expectRevert(StreamPay.NotGovernance.selector);
        sp.setFee(1);
        vm.startPrank(gov);
        vm.expectRevert(StreamPay.FeeTooHigh.selector);
        sp.setFee(1001);
        sp.setFee(500);
        assertEq(sp.feeBps(), 500);
        vm.expectRevert(StreamPay.ZeroAddress.selector);
        sp.setFeeRecipient(address(0));
        sp.setFeeRecipient(other);
        assertEq(sp.feeRecipient(), other);
        vm.expectRevert(StreamPay.ZeroAddress.selector);
        sp.setGovernance(address(0));
        sp.setGovernance(other);
        vm.stopPrank();
        assertEq(sp.governance(), other);
    }
}

contract ReenterStream {
    StreamPay public sp;
    bool public reentered;
    uint256 internal n;

    constructor(StreamPay s) {
        sp = s;
    }

    function claim(uint256 id) external {
        sp.claimStream(id);
    }

    function pull() external {
        sp.withdraw();
    }

    receive() external payable {
        if (n++ == 0) {
            try sp.withdraw() {
                reentered = true;
            } catch {}
        }
    }
}
