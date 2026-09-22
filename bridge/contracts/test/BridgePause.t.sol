// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";

/// @dev The circuit breaker: fast to close (a pauser key), slow to open (the
///      owner multisig), and isolated per token.
contract BridgePauseTest is BridgeTestBase {
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event TokenPaused(address indexed localToken, address indexed account);
    event TokenUnpaused(address indexed localToken, address indexed account);

    function _inboundWrapped(uint64 nonce) internal view returns (FerminuxBridge.BridgeTransfer memory) {
        return _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, nonce);
    }

    // ---------------------------------------------------------- global pause

    function test_Pause_ByPauserKey() public {
        vm.expectEmit(true, true, true, true);
        emit Paused(pauser);
        vm.prank(pauser);
        bridge.pause();
        assertTrue(bridge.paused());
    }

    function test_Pause_ByOwner() public {
        vm.prank(owner);
        bridge.pause();
        assertTrue(bridge.paused());
    }

    function test_Pause_RejectsOutsider() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not pauser"));
        bridge.pause();
    }

    function test_Pause_RejectsDoublePause() public {
        vm.prank(pauser);
        bridge.pause();
        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: already paused"));
        bridge.pause();
    }

    function test_Pause_BlocksSend() public {
        vm.prank(pauser);
        bridge.pause();
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: paused"));
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, bob);
    }

    function test_Pause_BlocksExecute() public {
        FerminuxBridge.BridgeTransfer memory t = _inboundWrapped(1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);

        vm.prank(pauser);
        bridge.pause();

        vm.expectRevert(bytes("BRIDGE: paused"));
        bridge.execute(t, sigs);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    function test_Pause_DoesNotBlockFeeWithdrawalOrRescue() public {
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        vm.prank(pauser);
        bridge.pause();

        // the operator can still sweep fees and rescue stray funds while closed
        vm.prank(collector);
        bridge.withdrawFees(address(0));
        assertEq(collector.balance, _fee(100 ether));
    }

    // -------------------------------------------------------------- unpause

    function test_Unpause_OnlyOwner() public {
        vm.prank(pauser);
        bridge.pause();

        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.unpause();

        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.unpause();

        vm.expectEmit(true, true, true, true);
        emit Unpaused(owner);
        vm.prank(owner);
        bridge.unpause();
        assertFalse(bridge.paused());
    }

    function test_Unpause_RejectsWhenNotPaused() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not paused"));
        bridge.unpause();
    }

    function test_Unpause_RestoresService() public {
        vm.prank(pauser);
        bridge.pause();
        vm.prank(owner);
        bridge.unpause();

        vm.prank(alice);
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.outboundNonce(), 1);
    }

    function test_Unpause_IsImmediateNotTimelocked() public {
        // Unpause is a multisig call, not a queued action: restoring service
        // must not wait 48h once the owners agree.
        vm.prank(pauser);
        bridge.pause();
        uint256 t0 = block.timestamp;
        vm.prank(owner);
        bridge.unpause();
        assertEq(block.timestamp, t0);
        assertFalse(bridge.paused());
    }

    // ------------------------------------------------------- per-token pause

    function test_TokenPause_ByPauser() public {
        vm.expectEmit(true, true, true, true);
        emit TokenPaused(address(usdx), pauser);
        vm.prank(pauser);
        bridge.pauseToken(address(usdx));
        assertTrue(bridge.tokenConfig(address(usdx)).paused);
    }

    function test_TokenPause_IsolatesOtherTokens() public {
        vm.prank(pauser);
        bridge.pauseToken(address(usdx));

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: token paused"));
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, bob);

        // native and wrapped are untouched
        vm.prank(alice);
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, bob);

        FerminuxBridge.BridgeTransfer memory t = _inboundWrapped(1);
        bridge.execute(t, _quorum(t));
        assertEq(wrmt.balanceOf(bob), 1 ether);
    }

    function test_TokenPause_BlocksInboundToo() public {
        vm.prank(pauser);
        bridge.pauseToken(address(wrmt));

        FerminuxBridge.BridgeTransfer memory t = _inboundWrapped(1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: token paused"));
        bridge.execute(t, sigs);
    }

    function test_TokenPause_RejectsUnregisteredToken() public {
        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: token not registered"));
        bridge.pauseToken(address(0xdead));
    }

    function test_TokenPause_RejectsDoublePause() public {
        vm.prank(pauser);
        bridge.pauseToken(address(usdx));
        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: already paused"));
        bridge.pauseToken(address(usdx));
    }

    function test_TokenPause_RejectsOutsider() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not pauser"));
        bridge.pauseToken(address(usdx));
    }

    function test_TokenUnpause_OnlyOwner() public {
        vm.prank(pauser);
        bridge.pauseToken(address(usdx));

        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.unpauseToken(address(usdx));

        vm.expectEmit(true, true, true, true);
        emit TokenUnpaused(address(usdx), owner);
        vm.prank(owner);
        bridge.unpauseToken(address(usdx));
        assertFalse(bridge.tokenConfig(address(usdx)).paused);

        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, bob);
    }

    function test_TokenUnpause_RejectsWhenNotPaused() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not paused"));
        bridge.unpauseToken(address(usdx));
    }

    // ----------------------------------------------------------- pauser role

    function test_Pauser_RevokedKeyCannotPause() public {
        vm.prank(owner);
        bridge.setPauser(pauser, false);
        vm.prank(pauser);
        vm.expectRevert(bytes("BRIDGE: not pauser"));
        bridge.pause();
    }

    function test_Pauser_AdditionalKeyWorks() public {
        vm.prank(owner);
        bridge.setPauser(bob, true);
        vm.prank(bob);
        bridge.pause();
        assertTrue(bridge.paused());
    }

    function test_Pauser_CompromisedValidatorIsContainedByPauseNotRemoval() public {
        // Removing a validator takes 48h. Pausing takes one transaction — that is
        // the intended incident response, and it stops the bleeding instantly.
        FerminuxBridge.BridgeTransfer memory t = _inboundWrapped(1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);

        vm.prank(pauser);
        bridge.pause();
        vm.expectRevert(bytes("BRIDGE: paused"));
        bridge.execute(t, sigs);

        // the removal is queued and still pending
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.removeValidator, (v1)));
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelock not elapsed"));
        bridge.executeAction(id);
        assertTrue(bridge.isValidator(v1));
        assertTrue(bridge.paused());
    }

    function testFuzz_OnlyPauserOrOwnerCanPause(address caller) public {
        vm.assume(caller != pauser && caller != owner);
        vm.prank(caller);
        vm.expectRevert(bytes("BRIDGE: not pauser"));
        bridge.pause();
    }
}
