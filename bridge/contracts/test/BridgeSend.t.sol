// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {MockERC20, FeeOnTransferToken, NoReturnToken, FalseReturnToken} from "./utils/Mocks.sol";

/// @dev Outbound leg: locking canonical assets, burning wrapped ones, the fee
///      split, and the outbound rails (per-transfer cap + rolling 24h window).
contract BridgeSendTest is BridgeTestBase {
    event Sent(
        bytes32 indexed transferId,
        uint64 indexed dstChainId,
        address indexed localToken,
        uint64 srcChainId,
        uint64 nonce,
        address remoteToken,
        address sender,
        address recipient,
        uint256 amount,
        uint256 fee
    );
    event TokenLimitsChanged(address indexed localToken, uint256 maxPerTransfer, uint256 dailyCap, bool immediate);

    function _mintWrapped(address to, uint256 amount) internal {
        vm.prank(address(bridge));
        wrmt.mint(to, amount);
        // The wrapper's burn() consumes the sender's allowance, so a holder must
        // approve the bridge before bridging back — the same approve-then-act
        // step every DEX requires. Fixtures model a holder who has done so.
        vm.prank(to);
        wrmt.approve(address(bridge), type(uint256).max);
    }

    function _expectedId(
        address localToken,
        address remoteToken,
        address sender,
        address recipient,
        uint256 net,
        uint64 nonce
    ) internal view returns (bytes32) {
        return bridge.transferIdOf(
            FerminuxBridge.BridgeTransfer({
                srcChainId: LOCAL_CHAIN,
                dstChainId: REMOTE_CHAIN,
                nonce: nonce,
                srcToken: localToken,
                dstToken: remoteToken,
                sender: sender,
                recipient: recipient,
                amount: net
            })
        );
    }

    // ------------------------------------------------------- native canonical

    function test_Send_NativeLocksAndEmits() public {
        uint256 gross = 10 ether;
        uint256 fee = _fee(gross);
        uint256 net = gross - fee;
        bytes32 expected = _expectedId(address(0), REMOTE_WFMX, alice, bob, net, 1);

        vm.expectEmit(true, true, true, true);
        emit Sent(expected, REMOTE_CHAIN, address(0), LOCAL_CHAIN, 1, REMOTE_WFMX, alice, bob, net, fee);

        vm.prank(alice);
        bytes32 id = bridge.send{value: gross}(address(0), gross, REMOTE_CHAIN, bob);

        assertEq(id, expected);
        assertEq(address(bridge).balance, gross);
        assertEq(bridge.lockedBalance(address(0)), net);
        assertEq(bridge.accruedFees(address(0)), fee);
        assertEq(bridge.outboundNonce(), 1);
        assertEq(bridge.outboundUsage(address(0)), gross);
        assertEq(bridge.inboundUsage(address(0)), 0);
    }

    function test_Send_NativeRevertsOnValueMismatch() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: bad msg.value"));
        bridge.send{value: 1 ether}(address(0), 2 ether, REMOTE_CHAIN, bob);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: bad msg.value"));
        bridge.send{value: 3 ether}(address(0), 2 ether, REMOTE_CHAIN, bob);
    }

    // -------------------------------------------------------- ERC20 canonical

    function test_Send_ERC20LocksAndEmits() public {
        uint256 gross = 40 ether;
        uint256 fee = _fee(gross);
        uint256 net = gross - fee;

        vm.prank(alice);
        bytes32 id = bridge.send(address(usdx), gross, REMOTE_CHAIN, bob);

        assertEq(id, _expectedId(address(usdx), REMOTE_WUSDX, alice, bob, net, 1));
        assertEq(usdx.balanceOf(address(bridge)), gross);
        assertEq(usdx.balanceOf(alice), 960 ether);
        assertEq(bridge.lockedBalance(address(usdx)), net);
        assertEq(bridge.accruedFees(address(usdx)), fee);
    }

    function test_Send_ERC20RevertsWhenValueAttached() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: unexpected value"));
        bridge.send{value: 1}(address(usdx), 10 ether, REMOTE_CHAIN, bob);
    }

    function test_Send_ERC20RevertsWithoutAllowance() public {
        usdx.mint(bob, 10 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("BRIDGE: transferFrom failed"));
        bridge.send(address(usdx), 10 ether, REMOTE_CHAIN, alice);
    }

    /// @dev A deposit credits what the caller ASKED for or it does not happen at
    ///      all. There is no measured-arrival credit any more: metering the
    ///      arrival and crediting the measurement is precisely how a reflection
    ///      token handed a depositor 200x their deposit in round 2.
    function test_Send_RefusesASkimmingTokenRatherThanCreditingTheArrival() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        _registerCanonical(address(fot), REMOTE_CHAIN, address(0xABCD), MAX_PER, DAILY);
        fot.mint(alice, 100 ether);
        vm.prank(alice);
        fot.approve(address(bridge), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.send(address(fot), 50 ether, REMOTE_CHAIN, bob);

        assertEq(fot.balanceOf(address(bridge)), 0, "the deposit was rolled back whole");
        assertEq(bridge.lockedBalance(address(fot)), 0);
        assertEq(bridge.accruedFees(address(fot)), 0);
        assertEq(bridge.outboundNonce(), 0);
        assertEq(fot.balanceOf(alice), 100 ether, "and the depositor still has their money");

        // The same token, behaving itself, is an ordinary deposit — the refusal is
        // a measurement of THIS transfer, not a permanent verdict on the address.
        fot.setTax(false);
        vm.prank(alice);
        fot.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(fot), 50 ether, REMOTE_CHAIN, bob);
        assertEq(fot.balanceOf(address(bridge)), 50 ether);
        assertEq(bridge.lockedBalance(address(fot)), 50 ether - _fee(50 ether));
    }

    function test_Send_AcceptsNoReturnValueToken() public {
        NoReturnToken nrt = new NoReturnToken();
        _registerCanonical(address(nrt), REMOTE_CHAIN, address(0xABCE), MAX_PER, DAILY);
        nrt.mint(alice, 100 ether);
        vm.prank(alice);
        nrt.approve(address(bridge), type(uint256).max);

        vm.prank(alice);
        nrt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(nrt), 10 ether, REMOTE_CHAIN, bob);
        assertEq(nrt.balanceOf(address(bridge)), 10 ether);
    }

    function test_Send_RejectsFalseReturningToken() public {
        FalseReturnToken frt = new FalseReturnToken();
        _registerCanonical(address(frt), REMOTE_CHAIN, address(0xABCF), MAX_PER, DAILY);
        frt.mint(alice, 100 ether);
        vm.prank(alice);
        frt.approve(address(bridge), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: transferFrom failed"));
        bridge.send(address(frt), 10 ether, REMOTE_CHAIN, bob);
    }

    // --------------------------------------------------------------- wrapped

    function test_Send_WrappedBurnsAndKeepsFeeInSupply() public {
        _mintWrapped(alice, 100 ether);
        uint256 gross = 50 ether;
        uint256 fee = _fee(gross);
        uint256 net = gross - fee;

        vm.prank(alice);
        bytes32 id = bridge.send(address(wrmt), gross, REMOTE_CHAIN, bob);

        assertEq(id, _expectedId(address(wrmt), REMOTE_RMT, alice, bob, net, 1));
        assertEq(wrmt.balanceOf(alice), 50 ether);
        // supply fell by exactly the net that will be released at home
        assertEq(wrmt.totalSupply(), 100 ether - net);
        // the fee is held by the bridge as real wrapped balance
        assertEq(wrmt.balanceOf(address(bridge)), fee);
        assertEq(bridge.accruedFees(address(wrmt)), fee);
        // wrapped assets are never collateral
        assertEq(bridge.lockedBalance(address(wrmt)), 0);
    }

    function test_Send_WrappedRevertsWithoutBalance() public {
        _mintWrapped(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(); // BridgeToken underflow
        bridge.send(address(wrmt), 2 ether, REMOTE_CHAIN, bob);
    }

    // ------------------------------------------------------------ validation

    function test_Send_RevertsOnUnregisteredToken() public {
        MockERC20 stranger = new MockERC20("Stranger", "STR", 18);
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: token not registered"));
        bridge.send(address(stranger), 1 ether, REMOTE_CHAIN, bob);
    }

    function test_Send_RevertsOnZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: zero recipient"));
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, address(0));
    }

    function test_Send_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: zero amount"));
        bridge.send(address(0), 0, REMOTE_CHAIN, bob);
    }

    function test_Send_RevertsOnWrongDestinationChain() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: bad dst chain"));
        bridge.send{value: 1 ether}(address(0), 1 ether, OTHER_CHAIN, bob);
    }

    function test_Send_RevertsWhenSendingToOwnChain() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: bad dst chain"));
        bridge.send{value: 1 ether}(address(0), 1 ether, LOCAL_CHAIN, bob);
    }

    // ------------------------------------------------------ per-transfer cap

    function test_Cap_PerTransferBoundary() public {
        vm.prank(alice);
        bridge.send{value: MAX_PER}(address(0), MAX_PER, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundUsage(address(0)), MAX_PER);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over per-transfer cap"));
        bridge.send{value: MAX_PER + 1}(address(0), MAX_PER + 1, REMOTE_CHAIN, bob);
    }

    // ------------------------------------------------------- rolling 24h cap

    function test_Cap_DailyOutboundWindow() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
            bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        }
        assertEq(bridge.outboundUsage(address(0)), DAILY);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over 24h cap"));
        bridge.send{value: 1}(address(0), 1, REMOTE_CHAIN, bob);
    }

    function test_Cap_WindowDecaysLinearly() public {
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundUsage(address(0)), 100 ether);

        vm.warp(block.timestamp + 12 hours);
        assertEq(bridge.outboundUsage(address(0)), 50 ether, "half the window elapsed => half decayed");

        vm.warp(block.timestamp + 6 hours);
        assertEq(bridge.outboundUsage(address(0)), 25 ether, "another quarter");
    }

    function test_Cap_WindowFullyResetsAfter24h() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
            bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        }
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over 24h cap"));
        bridge.send{value: 1}(address(0), 1, REMOTE_CHAIN, bob);

        vm.warp(block.timestamp + 24 hours);
        assertEq(bridge.outboundUsage(address(0)), 0);

        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundUsage(address(0)), 100 ether);
    }

    function test_Cap_NoDayBoundaryToGame() public {
        // Fill the bucket, then wait for exactly half the window. A calendar-day
        // reset would hand back the WHOLE cap; the draining bucket hands back half.
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
            bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        }
        vm.warp(block.timestamp + 12 hours);
        assertEq(bridge.outboundUsage(address(0)), 250 ether);

        // 250 more fits exactly; one wei beyond does not.
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        vm.prank(alice);
        bridge.send{value: 50 ether}(address(0), 50 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundUsage(address(0)), DAILY);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over 24h cap"));
        bridge.send{value: 1}(address(0), 1, REMOTE_CHAIN, bob);
    }

    function test_Cap_WindowsArePerToken() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
            bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        }
        // native is exhausted; usdx is untouched
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundUsage(address(usdx)), 100 ether);
    }

    // ----------------------------------------------------- decrease vs raise

    function test_Limits_DecreaseIsImmediate() public {
        vm.expectEmit(true, true, true, true);
        emit TokenLimitsChanged(address(0), 1 ether, 2 ether, true);
        vm.prank(owner);
        bridge.decreaseTokenLimits(address(0), 1 ether, 2 ether);

        FerminuxBridge.TokenConfig memory cfg = bridge.tokenConfig(address(0));
        assertEq(cfg.maxPerTransfer, 1 ether);
        assertEq(cfg.dailyCap, 2 ether);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over per-transfer cap"));
        bridge.send{value: 2 ether}(address(0), 2 ether, REMOTE_CHAIN, bob);
    }

    function test_Limits_DecreaseToZeroStopsTheToken() public {
        vm.prank(owner);
        bridge.decreaseTokenLimits(address(0), 0, 0);
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over per-transfer cap"));
        bridge.send{value: 1}(address(0), 1, REMOTE_CHAIN, bob);
    }

    function test_Limits_DecreaseRejectsIncrease() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not a decrease"));
        bridge.decreaseTokenLimits(address(0), MAX_PER + 1, DAILY);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not a decrease"));
        bridge.decreaseTokenLimits(address(0), MAX_PER, DAILY + 1);
    }

    function test_Limits_DecreaseOnlyOwner() public {
        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.decreaseTokenLimits(address(0), 1, 1);
    }

    function test_Limits_DecreaseRejectsUnregisteredToken() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: token not registered"));
        bridge.decreaseTokenLimits(address(0xdead), 1, 1);
    }

    function test_Limits_IncreaseIsTimelocked() public {
        // direct call is impossible
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setTokenLimits(address(0), 1_000 ether, 5_000 ether);

        // queued but not yet mature
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setTokenLimits, (address(0), 1_000 ether, 5_000 ether)));
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelock not elapsed"));
        bridge.executeAction(id);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over per-transfer cap"));
        bridge.send{value: 200 ether}(address(0), 200 ether, REMOTE_CHAIN, bob);

        // mature: now the raise lands
        vm.warp(block.timestamp + 1);
        vm.prank(owner);
        bridge.executeAction(id);
        assertEq(bridge.tokenConfig(address(0)).maxPerTransfer, 1_000 ether);

        vm.prank(alice);
        bridge.send{value: 200 ether}(address(0), 200 ether, REMOTE_CHAIN, bob);
    }

    function test_Limits_SetTokenLimitsRejectsUnregistered() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setTokenLimits, (address(0xdead), 1, 1)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: token not registered"));
        bridge.executeAction(id);
    }

    // -------------------------------------------------------------- fee math

    function test_Fee_DefaultTenBps() public {
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.accruedFees(address(0)), 0.1 ether); // 10 bps of 100
        assertEq(bridge.lockedBalance(address(0)), 99.9 ether);
    }

    function test_Fee_ZeroBpsTakesNothing() public {
        _timelock(abi.encodeCall(FerminuxBridge.setFeeBps, (0)));
        vm.prank(alice);
        bridge.send{value: 10 ether}(address(0), 10 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.accruedFees(address(0)), 0);
        assertEq(bridge.lockedBalance(address(0)), 10 ether);
    }

    function test_Fee_AtMaxBps() public {
        _timelock(abi.encodeCall(FerminuxBridge.setFeeBps, (100)));
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.accruedFees(address(0)), 1 ether); // 1.00 %
        assertEq(bridge.lockedBalance(address(0)), 99 ether);
    }

    function test_Fee_RoundsDownInFavourOfTheUser() public {
        // 1234 wei * 10 / 10000 = 1.234 -> 1 wei fee
        vm.prank(alice);
        bridge.send{value: 1234}(address(0), 1234, REMOTE_CHAIN, bob);
        assertEq(bridge.accruedFees(address(0)), 1);
        assertEq(bridge.lockedBalance(address(0)), 1233);
    }

    function test_Fee_DustPaysNoFee() public {
        vm.prank(alice);
        bridge.send{value: 99}(address(0), 99, REMOTE_CHAIN, bob);
        assertEq(bridge.accruedFees(address(0)), 0);
        assertEq(bridge.lockedBalance(address(0)), 99);
    }

    function test_Fee_LockedPlusFeesEqualsBalance() public {
        vm.prank(alice);
        bridge.send{value: 10 ether}(address(0), 10 ether, REMOTE_CHAIN, bob);
        vm.prank(alice);
        bridge.send{value: 7 ether}(address(0), 7 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.lockedBalance(address(0)) + bridge.accruedFees(address(0)), address(bridge).balance);
    }

    // ------------------------------------------------------------ nonce/ids

    function test_Nonce_IncrementsAcrossTokens() public {
        vm.prank(alice);
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundNonce(), 1);
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundNonce(), 2);
    }

    function test_TransferId_DiffersPerSend() public {
        vm.prank(alice);
        bytes32 a = bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, bob);
        vm.prank(alice);
        bytes32 b = bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, bob);
        assertTrue(a != b, "identical sends must still get unique ids via the nonce");
    }

    // ----------------------------------------------------------------- fuzz

    function testFuzz_NativeSendAccounting(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, MAX_PER);
        vm.deal(alice, amount);
        vm.prank(alice);
        bridge.send{value: amount}(address(0), amount, REMOTE_CHAIN, bob);

        uint256 fee = (amount * FEE_BPS) / 10_000;
        assertEq(bridge.accruedFees(address(0)), fee);
        assertEq(bridge.lockedBalance(address(0)), amount - fee);
        assertEq(bridge.lockedBalance(address(0)) + bridge.accruedFees(address(0)), address(bridge).balance);
        assertLe(fee, amount / 100, "fee can never exceed the 1% hard cap");
    }

    function testFuzz_WrappedSendBurnsExactlyNet(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, MAX_PER);
        _mintWrapped(alice, MAX_PER);
        uint256 supplyBefore = wrmt.totalSupply();

        vm.prank(alice);
        wrmt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(wrmt), amount, REMOTE_CHAIN, bob);

        uint256 fee = (amount * FEE_BPS) / 10_000;
        assertEq(wrmt.totalSupply(), supplyBefore - (amount - fee));
        assertEq(bridge.accruedFees(address(wrmt)), fee);
        assertEq(wrmt.balanceOf(address(bridge)), fee);
        assertEq(bridge.lockedBalance(address(wrmt)), 0);
    }

    function testFuzz_OverCapAlwaysReverts(uint256 rawAmount) public {
        uint256 amount = bound(rawAmount, MAX_PER + 1, type(uint128).max);
        vm.deal(alice, amount);
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: over per-transfer cap"));
        bridge.send{value: amount}(address(0), amount, REMOTE_CHAIN, bob);
    }

    function testFuzz_WindowDecayIsMonotone(uint32 elapsed) public {
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        uint256 before = bridge.outboundUsage(address(0));
        vm.warp(block.timestamp + elapsed);
        uint256 later = bridge.outboundUsage(address(0));
        assertLe(later, before);
        if (elapsed >= 24 hours) assertEq(later, 0);
    }
}
