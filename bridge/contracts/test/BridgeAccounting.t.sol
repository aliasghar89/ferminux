// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {MockERC20, RejectingReceiver} from "./utils/Mocks.sol";

/// @dev lockedBalance / accruedFees bookkeeping, fee withdrawal, and the rescue
///      surplus rule — the guarantee that operator convenience functions can
///      never reach user collateral.
contract BridgeAccountingTest is BridgeTestBase {
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    function _lockNative(uint256 gross) internal {
        vm.prank(alice);
        bridge.send{value: gross}(address(0), gross, REMOTE_CHAIN, bob);
    }

    function _lockUsdx(uint256 gross) internal {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), gross, REMOTE_CHAIN, bob);
    }

    // ------------------------------------------------------- fee withdrawal

    function test_Fees_CollectorWithdrawsNative() public {
        _lockNative(100 ether);
        uint256 fee = _fee(100 ether);

        vm.expectEmit(true, true, true, true);
        emit FeesWithdrawn(address(0), collector, fee);
        vm.prank(collector);
        bridge.withdrawFees(address(0));

        assertEq(collector.balance, fee);
        assertEq(bridge.accruedFees(address(0)), 0);
        assertEq(bridge.lockedBalance(address(0)), 100 ether - fee, "collateral untouched");
        assertEq(address(bridge).balance, bridge.lockedBalance(address(0)));
    }

    function test_Fees_CollectorWithdrawsERC20() public {
        _lockUsdx(100 ether);
        uint256 fee = _fee(100 ether);
        vm.prank(collector);
        bridge.withdrawFees(address(usdx));
        assertEq(usdx.balanceOf(collector), fee);
        assertEq(usdx.balanceOf(address(bridge)), 100 ether - fee);
    }

    function test_Fees_WrappedFeesAreRealWithdrawableBalance() public {
        vm.prank(address(bridge));
        wrmt.mint(alice, 100 ether);
        vm.prank(alice);
        wrmt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(wrmt), 100 ether, REMOTE_CHAIN, bob);
        uint256 fee = _fee(100 ether);

        vm.prank(collector);
        bridge.withdrawFees(address(wrmt));
        assertEq(wrmt.balanceOf(collector), fee);
        assertEq(wrmt.balanceOf(address(bridge)), 0);
        assertEq(wrmt.totalSupply(), fee);
    }

    function test_Fees_OwnerCanTriggerButFundsGoToCollector() public {
        _lockNative(100 ether);
        vm.prank(owner);
        bridge.withdrawFees(address(0));
        assertEq(collector.balance, _fee(100 ether));
        assertEq(owner.balance, 0);
    }

    function test_Fees_RejectsOutsider() public {
        _lockNative(100 ether);
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not fee authority"));
        bridge.withdrawFees(address(0));
    }

    function test_Fees_RejectsWhenNothingAccrued() public {
        vm.prank(collector);
        vm.expectRevert(bytes("BRIDGE: no fees"));
        bridge.withdrawFees(address(0));
    }

    function test_Fees_CannotBeWithdrawnTwice() public {
        _lockNative(100 ether);
        vm.prank(collector);
        bridge.withdrawFees(address(0));
        vm.prank(collector);
        vm.expectRevert(bytes("BRIDGE: no fees"));
        bridge.withdrawFees(address(0));
    }

    function test_Fees_FollowTheCollectorAfterARotation() public {
        _lockNative(100 ether);
        address newCollector = makeAddr("newCollector");
        _timelock(abi.encodeCall(FerminuxBridge.setFeeCollector, (newCollector)));

        vm.prank(collector);
        vm.expectRevert(bytes("BRIDGE: not fee authority"));
        bridge.withdrawFees(address(0));

        vm.prank(newCollector);
        bridge.withdrawFees(address(0));
        assertEq(newCollector.balance, _fee(100 ether));
        assertEq(collector.balance, 0);
    }

    function test_Fees_RevertWhenCollectorRejectsNative() public {
        _lockNative(100 ether);
        RejectingReceiver bad = new RejectingReceiver();
        _timelock(abi.encodeCall(FerminuxBridge.setFeeCollector, (address(bad))));

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: native transfer failed"));
        bridge.withdrawFees(address(0));
        assertEq(bridge.accruedFees(address(0)), _fee(100 ether), "accrual restored by the revert");
    }

    function test_Fees_AccumulateOverManySends() public {
        _lockNative(10 ether);
        _lockNative(20 ether);
        _lockNative(30 ether);
        assertEq(bridge.accruedFees(address(0)), _fee(10 ether) + _fee(20 ether) + _fee(30 ether));
    }

    function test_Fees_BothTravelDirectionsPayAtOrigin() public {
        // Leg 1: canonical leaves this chain -> fee accrues here in the canonical asset.
        _lockNative(100 ether);
        uint256 outboundFee = _fee(100 ether);
        assertEq(bridge.accruedFees(address(0)), outboundFee);

        // Leg 2: a wrapped asset leaves this chain -> fee accrues here in the wrapper.
        vm.prank(address(bridge));
        wrmt.mint(alice, 100 ether);
        vm.prank(alice);
        wrmt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(wrmt), 100 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.accruedFees(address(wrmt)), _fee(100 ether));

        // Arrival never charges: the recipient receives exactly the signed amount.
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(0), REMOTE_WFMX, bob, 5 ether, 1);
        uint256 bobBefore = bob.balance;
        bridge.execute(t, _quorum(t));
        assertEq(bob.balance - bobBefore, 5 ether);
        assertEq(bridge.accruedFees(address(0)), outboundFee, "no extra fee on arrival");
    }

    // -------------------------------------------------------- locked balance

    function test_Locked_TracksLockAndRelease() public {
        _lockUsdx(100 ether);
        uint256 net = _net(100 ether);
        assertEq(bridge.lockedBalance(address(usdx)), net);

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 40 ether, 1);
        bridge.execute(t, _quorum(t));
        assertEq(bridge.lockedBalance(address(usdx)), net - 40 ether);

        _lockUsdx(50 ether);
        assertEq(bridge.lockedBalance(address(usdx)), net - 40 ether + _net(50 ether));
    }

    function test_Locked_WrappedTokensNeverAccrueCollateral() public {
        vm.prank(address(bridge));
        wrmt.mint(alice, 100 ether);
        vm.prank(alice);
        wrmt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(wrmt), 100 ether, REMOTE_CHAIN, bob);

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 10 ether, 1);
        bridge.execute(t, _quorum(t));

        assertEq(bridge.lockedBalance(address(wrmt)), 0);
    }

    // ---------------------------------------------------------------- rescue

    /// @dev usdx is REGISTERED, so its surplus comes out through the timelock —
    ///      the surplus of a routed asset is a DERIVED figure and an instant exit
    ///      is what turns any accounting defect into a withdrawal.
    function test_Rescue_MovesOnlyDonatedSurplus() public {
        _lockUsdx(100 ether);
        uint256 reserved = bridge.lockedBalance(address(usdx)) + bridge.accruedFees(address(usdx));
        assertEq(bridge.surplusOf(address(usdx)), 0);

        usdx.mint(address(bridge), 7 ether); // stray airdrop
        assertEq(bridge.surplusOf(address(usdx)), 7 ether);

        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.rescue, (address(usdx), owner, 7 ether + 1)), bytes("BRIDGE: exceeds surplus")
        );

        uint256 id = _queueMatured(abi.encodeCall(FerminuxBridge.rescue, (address(usdx), owner, 7 ether)));
        vm.expectEmit(true, true, true, true);
        emit Rescued(address(usdx), owner, 7 ether);
        _fireAction(id);

        assertEq(usdx.balanceOf(owner), 7 ether);
        assertEq(usdx.balanceOf(address(bridge)), reserved);
        assertEq(bridge.lockedBalance(address(usdx)), reserved - bridge.accruedFees(address(usdx)));
    }

    /// @dev The instant path survives for exactly the case it was written for: an
    ///      asset this bridge does not route, where "surplus" is the whole balance
    ///      and there is no collateral denominated in it to protect.
    function test_Rescue_UnregisteredTokenStaysInstant() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(bridge), 5 ether);

        vm.prank(owner);
        bridge.rescue(address(junk), alice, 5 ether);
        assertEq(junk.balanceOf(alice), 5 ether);
    }

    /// @dev ...and a REGISTERED token cannot take that path at all, however small
    ///      the amount and however genuine the surplus.
    function test_Rescue_RegisteredTokenCannotBeRescuedInstantly() public {
        usdx.mint(address(bridge), 3 ether);
        assertEq(bridge.surplusOf(address(usdx)), 3 ether);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.rescue(address(usdx), owner, 1);

        // The native coin is registered here too, so it is on the slow path with
        // everything else that has collateral behind it.
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(bridge).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.rescue(address(0), owner, 1);

        assertEq(usdx.balanceOf(address(bridge)), 3 ether, "nothing moved");
    }

    function test_Rescue_CannotTouchLockedCollateral() public {
        _lockUsdx(100 ether);
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.rescue, (address(usdx), owner, 1)), bytes("BRIDGE: exceeds surplus")
        );
        assertEq(usdx.balanceOf(address(bridge)), 100 ether);
    }

    function test_Rescue_CannotTouchAccruedFees() public {
        _lockUsdx(100 ether);
        usdx.mint(address(bridge), 1 ether);
        // surplus is exactly the donation — the fee portion stays reserved
        assertEq(bridge.surplusOf(address(usdx)), 1 ether);
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.rescue, (address(usdx), owner, 1 ether + 1)), bytes("BRIDGE: exceeds surplus")
        );
    }

    function test_Rescue_NativeSurplus() public {
        _lockNative(100 ether);
        assertEq(bridge.surplusOf(address(0)), 0);

        vm.deal(address(this), 3 ether);
        (bool ok,) = address(bridge).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(bridge.surplusOf(address(0)), 3 ether);

        _rescue(address(0), bob, 3 ether);
        assertEq(bridge.surplusOf(address(0)), 0);
        assertEq(address(bridge).balance, bridge.lockedBalance(address(0)) + bridge.accruedFees(address(0)));
    }

    function test_Rescue_UnregisteredTokenIsFullyRecoverable() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(bridge), 12 ether);
        assertEq(bridge.surplusOf(address(junk)), 12 ether);

        vm.prank(owner);
        bridge.rescue(address(junk), alice, 12 ether);
        assertEq(junk.balanceOf(alice), 12 ether);
        assertEq(junk.balanceOf(address(bridge)), 0);
    }

    function test_Rescue_OnlyOwner() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(bridge), 1 ether);
        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.rescue(address(junk), pauser, 1 ether);
    }

    function test_Rescue_RejectsZeroTargetAndAmount() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(bridge), 1 ether);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero to"));
        bridge.rescue(address(junk), address(0), 1);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero amount"));
        bridge.rescue(address(junk), owner, 0);
    }

    function test_Rescue_AfterFeeWithdrawalTheFeeIsNoLongerReserved() public {
        _lockUsdx(100 ether);
        vm.prank(collector);
        bridge.withdrawFees(address(usdx));
        // balance now == locked exactly, nothing to rescue
        assertEq(bridge.surplusOf(address(usdx)), 0);
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.rescue, (address(usdx), owner, 1)), bytes("BRIDGE: exceeds surplus")
        );
    }

    /// @dev The queue is still not an arbitrary-call machine: rescue() is on the
    ///      whitelist BECAUSE registered tokens must go through it, and everything
    ///      that was refused before is still refused.
    function test_Rescue_IsQueueableButTheQueueIsStillAWhitelist() public {
        vm.prank(owner);
        bridge.queue(abi.encodeCall(FerminuxBridge.rescue, (address(usdx), outsider, 1 ether)));

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not timelockable"));
        bridge.queue(abi.encodeCall(FerminuxBridge.send, (address(usdx), 1, REMOTE_CHAIN, outsider)));

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not timelockable"));
        bridge.queue(abi.encodeCall(FerminuxBridge.withdrawFees, (address(usdx))));

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not timelockable"));
        bridge.queue(abi.encodeCall(FerminuxBridge.pause, ()));
    }

    /// @dev A timelocked rescue is still capped at the surplus. The delay is a
    ///      second lock, never a replacement for the first one.
    function test_Rescue_TimelockedStillCannotExceedSurplus() public {
        _lockUsdx(100 ether);
        usdx.mint(address(bridge), 2 ether);
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.rescue, (address(usdx), outsider, 2 ether + 1)),
            bytes("BRIDGE: exceeds surplus")
        );
        _rescue(address(usdx), outsider, 2 ether);
        assertEq(usdx.balanceOf(outsider), 2 ether);
        assertEq(bridge.surplusOf(address(usdx)), 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_RescueNeverEatsIntoLockedOrFees(uint96 rawLock, uint96 rawDonation, uint256 rawRescue) public {
        uint256 lockAmount = bound(uint256(rawLock), 1, MAX_PER);
        uint256 donation = bound(uint256(rawDonation), 0, 1_000 ether);
        usdx.mint(alice, lockAmount);

        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), lockAmount, REMOTE_CHAIN, bob);
        usdx.mint(address(bridge), donation);

        uint256 locked = bridge.lockedBalance(address(usdx));
        uint256 fees = bridge.accruedFees(address(usdx));
        uint256 rescueAmount = bound(rawRescue, 1, type(uint128).max);

        if (rescueAmount > donation) {
            _expectTimelockRevert(
                abi.encodeCall(FerminuxBridge.rescue, (address(usdx), outsider, rescueAmount)),
                bytes("BRIDGE: exceeds surplus")
            );
        } else {
            _rescue(address(usdx), outsider, rescueAmount);
        }

        assertGe(usdx.balanceOf(address(bridge)), locked + fees, "collateral + fees must always remain");
        assertEq(bridge.lockedBalance(address(usdx)), locked);
        assertEq(bridge.accruedFees(address(usdx)), fees);
    }

    function testFuzz_SurplusIsBalanceMinusReserved(uint96 rawLock, uint96 rawDonation) public {
        uint256 lockAmount = bound(uint256(rawLock), 1, MAX_PER);
        uint256 donation = uint256(rawDonation);
        usdx.mint(alice, lockAmount);
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), lockAmount, REMOTE_CHAIN, bob);
        usdx.mint(address(bridge), donation);

        uint256 reserved = bridge.lockedBalance(address(usdx)) + bridge.accruedFees(address(usdx));
        assertEq(bridge.surplusOf(address(usdx)), usdx.balanceOf(address(bridge)) - reserved);
        assertEq(bridge.surplusOf(address(usdx)), donation);
    }

    function testFuzz_FeeWithdrawalNeverTouchesCollateral(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 10_000, MAX_PER);
        usdx.mint(alice, amount);
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), amount, REMOTE_CHAIN, bob);

        uint256 locked = bridge.lockedBalance(address(usdx));
        vm.prank(collector);
        bridge.withdrawFees(address(usdx));

        assertEq(bridge.lockedBalance(address(usdx)), locked);
        assertGe(usdx.balanceOf(address(bridge)), locked);
        assertEq(bridge.accruedFees(address(usdx)), 0);
    }
}
