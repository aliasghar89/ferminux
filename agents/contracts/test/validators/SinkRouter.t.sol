// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {SinkRouter} from "../../src/validators/SinkRouter.sol";

contract RevertingReserve {
    receive() external payable {
        revert("no");
    }
}

/// @notice SinkRouter against the real FMXRewardSink: the handover, the 40% split, the 50% cap,
///         the timelock on share, reserve and hand-back, and the starting tranche.
contract SinkRouterTest is ValidatorTestBase {
    SinkRouter internal router;
    address internal reserve = makeAddr("reserve");
    address internal anyone = makeAddr("anyone");

    function setUp() public override {
        super.setUp();
        router = new SinkRouter(msig, address(sink), address(hub), reserve);
    }

    function _handover() internal {
        vm.prank(msig);
        sink.transferOwnership(address(router));
        vm.prank(msig);
        router.acceptSinkOwnership();
    }

    function _setRouterParam(uint8 p, uint256 v) internal {
        vm.prank(msig);
        router.queueParam(p, v);
        vm.roll(block.number + router.TIMELOCK());
        vm.prank(msig);
        router.applyParam(p, v);
    }

    function test_Constructor_RejectsZero() public {
        vm.expectRevert(SinkRouter.ZeroAddress.selector);
        new SinkRouter(address(0), address(sink), address(hub), reserve);
        vm.expectRevert(SinkRouter.ZeroAddress.selector);
        new SinkRouter(msig, address(sink), address(hub), address(0));
        assertEq(router.shareBps(), 4_000);
    }

    function test_TrancheThenHandoverThenPump() public {
        // the sink has accumulated its share of block rewards
        vm.deal(address(sink), 26_500 ether);
        // 1) the published 20,000 FMX starting tranche, straight from the sink to the hub
        vm.prank(msig);
        sink.withdraw(payable(address(hub)), 20_000 ether);
        assertEq(hub.rewardPool(), 20_000 ether);

        // 2) the two-step handover: only the router's owner completes it
        vm.prank(msig);
        sink.transferOwnership(address(router));
        vm.prank(anyone);
        vm.expectRevert(SinkRouter.NotOwner.selector);
        router.acceptSinkOwnership();
        vm.prank(msig);
        router.acceptSinkOwnership();
        assertEq(sink.owner(), address(router));

        // 3) pump is permissionless: 40% of the sink balance to the hub, the rest to the reserve
        vm.prank(anyone);
        (uint256 toHub, uint256 toReserve) = router.pump();
        assertEq(toHub, 2_600 ether);
        assertEq(toReserve, 3_900 ether);
        assertEq(hub.rewardPool(), 22_600 ether);
        assertEq(reserve.balance, 3_900 ether);
        assertEq(address(sink).balance, 0);
        assertEq(address(router).balance, 0);

        // new block rewards arrive in the sink (credited in state by the engine)
        vm.deal(address(sink), 1_543 ether);
        router.pump();
        assertEq(hub.rewardPool(), 22_600 ether + 617.2 ether);
        assertEq(router.totalToHub(), 2_600 ether + 617.2 ether);

        // an empty sink is a no-op
        (toHub, toReserve) = router.pump();
        assertEq(toHub + toReserve, 0);
    }

    function test_Pump_RevertsBeforeHandover() public {
        vm.deal(address(sink), 100 ether);
        vm.expectRevert(bytes("SINK: not owner"));
        router.pump();
    }

    function test_Share_TimelockedAndCappedAtHalf() public {
        _handover();
        vm.startPrank(msig);
        vm.expectRevert(SinkRouter.BadParam.selector);
        router.queueParam(0, 5_001);
        router.queueParam(0, 5_000);
        vm.expectRevert(SinkRouter.AlreadyQueued.selector);
        router.queueParam(0, 5_000);
        vm.expectRevert(SinkRouter.TooEarly.selector);
        router.applyParam(0, 5_000);
        vm.stopPrank();
        vm.prank(anyone);
        vm.expectRevert(SinkRouter.NotOwner.selector);
        router.queueParam(0, 1);

        vm.roll(block.number + 24_686);
        vm.prank(msig);
        router.applyParam(0, 5_000);
        assertEq(router.shareBps(), 5_000);
        vm.deal(address(sink), 100 ether);
        router.pump();
        assertEq(hub.rewardPool(), 50 ether);
        assertEq(reserve.balance, 50 ether);

        vm.startPrank(msig);
        router.queueParam(0, 0);
        router.cancelParam(0, 0);
        vm.expectRevert(SinkRouter.NotQueued.selector);
        router.applyParam(0, 0);
        vm.expectRevert(SinkRouter.BadParam.selector);
        router.queueParam(7, 0);
        vm.stopPrank();
    }

    function test_Reserve_TimelockedAndFailureKeepsFundsInSink() public {
        _handover();
        RevertingReserve bad = new RevertingReserve();
        _setRouterParam(1, uint256(uint160(address(bad))));
        assertEq(router.reserve(), address(bad));
        vm.deal(address(sink), 100 ether);
        vm.expectRevert(SinkRouter.TransferFailed.selector);
        router.pump();
        assertEq(address(sink).balance, 100 ether, "nothing moved");
        _setRouterParam(1, uint256(uint160(reserve)));
        router.pump();
        assertEq(reserve.balance, 60 ether);
    }

    function test_HandBack_Timelocked() public {
        _handover();
        address next = makeAddr("new multisig");
        _setRouterParam(2, uint256(uint160(next)));
        assertEq(sink.pendingOwner(), next);
        vm.prank(next);
        sink.acceptOwnership();
        assertEq(sink.owner(), next);
    }

    function testFuzz_Pump_Conserves(uint96 amount, uint16 share) public {
        _handover();
        uint256 bps = bound(share, 0, 5_000);
        if (bps != 4_000) _setRouterParam(0, bps);
        vm.deal(address(sink), amount);
        uint256 poolBefore = hub.rewardPool();
        (uint256 toHub, uint256 toReserve) = router.pump();
        assertEq(toHub + toReserve, amount);
        assertEq(toHub, uint256(amount) * bps / 10_000);
        assertLe(toHub * 2, uint256(amount), "never above 50%");
        assertEq(hub.rewardPool() - poolBefore, toHub);
        assertEq(reserve.balance, toReserve);
    }

    function test_Ownership_TwoStep() public {
        vm.prank(msig);
        router.transferOwnership(anyone);
        vm.prank(anyone);
        router.acceptOwnership();
        assertEq(router.owner(), anyone);
        vm.prank(msig);
        vm.expectRevert(SinkRouter.NotOwner.selector);
        router.transferOwnership(msig);
    }
}
