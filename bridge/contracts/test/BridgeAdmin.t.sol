// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// @dev Constructor validation, the timelock queue, the registry, validator
///      management, fee config and ownership.
contract BridgeAdminTest is BridgeTestBase {
    event ActionQueued(uint256 indexed actionId, bytes4 indexed selector, bytes data, uint64 eta);
    event ActionExecuted(uint256 indexed actionId, bytes4 indexed selector);
    event ActionCanceled(uint256 indexed actionId, bytes4 indexed selector);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdChanged(uint256 threshold);
    event TokenLimitsChanged(address indexed localToken, uint256 maxPerTransfer, uint256 dailyCap, bool immediate);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ---------------------------------------------------------- constructor

    function test_Constructor_SetsEverything() public view {
        assertEq(bridge.owner(), owner);
        assertEq(bridge.threshold(), 2);
        assertEq(bridge.validatorCount(), 3);
        assertTrue(bridge.isValidator(v1));
        assertTrue(bridge.isValidator(v2));
        assertTrue(bridge.isValidator(v3));
        assertFalse(bridge.isValidator(rogue));
        assertEq(bridge.feeCollector(), collector);
        assertEq(bridge.feeBps(), FEE_BPS);
        assertEq(bridge.timelockDelay(), DELAY);
        assertTrue(bridge.isPauser(pauser));
        assertFalse(bridge.paused());
        assertEq(bridge.outboundNonce(), 0);
        assertEq(bridge.MAX_FEE_BPS(), 100);
        assertEq(bridge.WINDOW(), 24 hours);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(bytes("BRIDGE: zero owner"));
        new FerminuxBridge(address(0), _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_RevertsOnZeroCollector() public {
        vm.expectRevert(bytes("BRIDGE: zero collector"));
        new FerminuxBridge(owner, _validatorSet(), 2, address(0), FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_RevertsOnFeeAboveCap() public {
        vm.expectRevert(bytes("BRIDGE: fee too high"));
        new FerminuxBridge(owner, _validatorSet(), 2, collector, 101, DELAY, pauser);
    }

    function test_Constructor_AcceptsFeeExactlyAtCap() public {
        FerminuxBridge b = new FerminuxBridge(owner, _validatorSet(), 2, collector, 100, DELAY, pauser);
        assertEq(b.feeBps(), 100);
    }

    function test_Constructor_RevertsOnDelayBelowMinimum() public {
        vm.expectRevert(bytes("BRIDGE: bad delay"));
        new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, 59 minutes, pauser);
    }

    function test_Constructor_RevertsOnDelayAboveMaximum() public {
        vm.expectRevert(bytes("BRIDGE: bad delay"));
        new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, 31 days, pauser);
    }

    function test_Constructor_RevertsOnEmptyValidatorSet() public {
        vm.expectRevert(bytes("BRIDGE: bad validator count"));
        new FerminuxBridge(owner, new address[](0), 1, collector, FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_RevertsOnZeroValidator() public {
        address[] memory set = new address[](2);
        set[0] = v1;
        set[1] = address(0);
        vm.expectRevert(bytes("BRIDGE: zero validator"));
        new FerminuxBridge(owner, set, 1, collector, FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_RevertsOnDuplicateValidator() public {
        address[] memory set = new address[](2);
        set[0] = v1;
        set[1] = v1;
        vm.expectRevert(bytes("BRIDGE: duplicate validator"));
        new FerminuxBridge(owner, set, 1, collector, FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_RevertsOnThresholdAboveValidatorCount() public {
        vm.expectRevert(bytes("BRIDGE: bad threshold"));
        new FerminuxBridge(owner, _validatorSet(), 4, collector, FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_RevertsOnZeroThreshold() public {
        vm.expectRevert(bytes("BRIDGE: bad threshold"));
        new FerminuxBridge(owner, _validatorSet(), 0, collector, FEE_BPS, DELAY, pauser);
    }

    function test_Constructor_ZeroPauserIsAllowed() public {
        FerminuxBridge b = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, address(0));
        assertFalse(b.isPauser(address(0)));
    }

    // ------------------------------------------------------------- timelock

    function test_Queue_OnlyOwner() public {
        bytes memory data = abi.encodeCall(FerminuxBridge.setThreshold, (3));
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.queue(data);
    }

    function test_Queue_EmitsWithEta() public {
        // setUp() already queued+executed three registrations, so ids start at 3.
        uint256 expectedId = bridge.actionCount();
        bytes memory data = abi.encodeCall(FerminuxBridge.setThreshold, (3));
        uint64 expectedEta = uint64(block.timestamp) + DELAY;
        vm.expectEmit(true, true, true, true);
        emit ActionQueued(expectedId, FerminuxBridge.setThreshold.selector, data, expectedEta);
        vm.prank(owner);
        uint256 id = bridge.queue(data);
        assertEq(id, expectedId);
        assertEq(bridge.actionCount(), expectedId + 1);
        (bytes memory storedData, uint64 eta, bool executed, bool canceled) = bridge.getAction(id);
        assertEq(storedData, data);
        assertEq(eta, expectedEta);
        assertFalse(executed);
        assertFalse(canceled);
    }

    function test_Queue_RejectsNonTimelockableSelector() public {
        // withdrawFees() is a fee-authority call and must not be smuggled through
        // the queue. (rescue() IS queueable — that is how a registered token's
        // surplus comes out — see BridgeAccounting.t.sol.)
        bytes memory data = abi.encodeCall(FerminuxBridge.withdrawFees, (address(usdx)));
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not timelockable"));
        bridge.queue(data);
    }

    function test_Queue_RejectsSendSelector() public {
        bytes memory data = abi.encodeCall(FerminuxBridge.send, (address(usdx), 1, REMOTE_CHAIN, outsider));
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not timelockable"));
        bridge.queue(data);
    }

    function test_Queue_RejectsShortData() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: bad action data"));
        bridge.queue(hex"1234");
    }

    function test_ExecuteAction_RevertsBeforeEta() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelock not elapsed"));
        bridge.executeAction(id);
    }

    function test_ExecuteAction_SucceedsExactlyAtEta() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, true, true, true);
        emit ThresholdChanged(3);
        vm.expectEmit(true, true, true, true);
        emit ActionExecuted(id, FerminuxBridge.setThreshold.selector);
        vm.prank(owner);
        bridge.executeAction(id);
        assertEq(bridge.threshold(), 3);
    }

    function test_ExecuteAction_RevertsAfterGracePeriod() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.warp(block.timestamp + DELAY + bridge.GRACE_PERIOD() + 1);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: action stale"));
        bridge.executeAction(id);
    }

    function test_ExecuteAction_RevertsOnDoubleExecute() public {
        uint256 id = _timelock(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: action executed"));
        bridge.executeAction(id);
    }

    function test_ExecuteAction_OnlyOwner() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.executeAction(id);
    }

    function test_ExecuteAction_RevertsOnUnknownAction() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: no such action"));
        bridge.executeAction(42);
    }

    function test_ExecuteAction_BubblesInnerRevert() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setFeeBps, (101)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: fee too high"));
        bridge.executeAction(id);
    }

    function test_CancelAction_BlocksExecution() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.expectEmit(true, true, true, true);
        emit ActionCanceled(id, FerminuxBridge.setThreshold.selector);
        vm.prank(owner);
        bridge.cancelAction(id);

        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: action canceled"));
        bridge.executeAction(id);
        assertEq(bridge.threshold(), 2);
    }

    function test_CancelAction_OnlyOwner() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.cancelAction(id);
    }

    function test_CancelAction_RevertsOnAlreadyExecuted() public {
        uint256 id = _timelock(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: action executed"));
        bridge.cancelAction(id);
    }

    function test_TimelockedSetters_UnreachableDirectly() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setThreshold(3);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.addValidator(rogue);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setTokenLimits(address(usdx), 1 ether, 1 ether);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.registerCanonical(address(0x1234), REMOTE_CHAIN, address(1), 1, 1);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setFeeCollector(outsider);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setTimelockDelay(2 hours);
    }

    function test_SetTimelockDelay_IsItselfTimelocked() public {
        _timelock(abi.encodeCall(FerminuxBridge.setTimelockDelay, (7 days)));
        assertEq(bridge.timelockDelay(), 7 days);

        // the NEW delay applies to the next queue
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        (, uint64 eta,,) = bridge.getAction(id);
        assertEq(eta, uint64(block.timestamp) + 7 days);
    }

    function test_SetTimelockDelay_RejectsOutOfRange() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setTimelockDelay, (uint64(31 days))));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: bad delay"));
        bridge.executeAction(id);
    }

    // ------------------------------------------------------------- registry

    function test_Registry_CanonicalNativeRegistered() public view {
        FerminuxBridge.TokenConfig memory cfg = bridge.tokenConfig(address(0));
        assertEq(uint256(cfg.kind), uint256(FerminuxBridge.TokenKind.CANONICAL));
        assertEq(cfg.remoteChainId, REMOTE_CHAIN);
        assertEq(cfg.remoteToken, REMOTE_WFMX);
        assertEq(cfg.maxPerTransfer, MAX_PER);
        assertEq(cfg.dailyCap, DAILY);
        assertFalse(cfg.paused);
    }

    function test_Registry_WrappedRegistered() public view {
        FerminuxBridge.TokenConfig memory cfg = bridge.tokenConfig(address(wrmt));
        assertEq(uint256(cfg.kind), uint256(FerminuxBridge.TokenKind.WRAPPED));
        assertEq(cfg.remoteToken, REMOTE_RMT);
        assertEq(bridge.registeredTokenCount(), 3);
    }

    function test_Registry_RejectsDoubleRegistration() public {
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(usdx), REMOTE_CHAIN, REMOTE_WUSDX, 1, 1))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: already registered"));
        bridge.executeAction(id);
    }

    function test_Registry_RejectsRemoteChainEqualToLocal() public {
        MockERC20 t = new MockERC20("T", "T", 18);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(t), LOCAL_CHAIN, address(9), MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: remote is local"));
        bridge.executeAction(id);
    }

    function test_Registry_RejectsZeroRemoteChain() public {
        MockERC20 t = new MockERC20("T", "T", 18);
        vm.prank(owner);
        uint256 id =
            bridge.queue(abi.encodeCall(FerminuxBridge.registerCanonical, (address(t), 0, address(9), MAX_PER, DAILY)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero remote chain"));
        bridge.executeAction(id);
    }

    function test_Registry_RejectsZeroCaps() public {
        MockERC20 t = new MockERC20("T", "T", 18);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(t), REMOTE_CHAIN, address(9), 0, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero per-transfer cap"));
        bridge.executeAction(id);

        vm.prank(owner);
        uint256 id2 = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(t), REMOTE_CHAIN, address(9), MAX_PER, 0))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero daily cap"));
        bridge.executeAction(id2);
    }

    function test_Registry_RejectsCapAboveUint128() public {
        MockERC20 t = new MockERC20("T", "T", 18);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(
                FerminuxBridge.registerCanonical,
                (address(t), REMOTE_CHAIN, address(9), MAX_PER, uint256(type(uint128).max) + 1)
            )
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: cap too large"));
        bridge.executeAction(id);
    }

    function test_Registry_CanonicalRejectsNonContract() public {
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(
                FerminuxBridge.registerCanonical, (address(0xdead), REMOTE_CHAIN, address(9), MAX_PER, DAILY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: token not a contract"));
        bridge.executeAction(id);
    }

    function test_Registry_WrappedRejectsNative() public {
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(0), REMOTE_CHAIN, address(9), MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: wrapped is not native"));
        bridge.executeAction(id);
    }

    function test_Registry_WrappedRejectsForeignMinter() public {
        BridgeToken foreign = new BridgeToken("Foreign", "FRN", 18, address(0xBEEF), REMOTE_CHAIN, address(1));
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(foreign), REMOTE_CHAIN, address(1), MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not the minter"));
        bridge.executeAction(id);
    }

    function test_Registry_WrappedRejectsPlainERC20() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(plain), REMOTE_CHAIN, address(1), MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert();
        bridge.executeAction(id);
    }

    function test_Registry_RemoteTokenMayBeNativeOnTheOtherSide() public {
        // wFMX on a remote chain mirrors a NATIVE coin — remoteToken == address(0).
        BridgeToken wnative = new BridgeToken("Wrapped Native", "wNAT", 18, address(bridge), OTHER_CHAIN, address(0));
        _registerWrapped(address(wnative), OTHER_CHAIN, address(0), MAX_PER, DAILY);
        FerminuxBridge.TokenConfig memory cfg = bridge.tokenConfig(address(wnative));
        assertEq(cfg.remoteToken, address(0));
        assertEq(uint256(cfg.kind), uint256(FerminuxBridge.TokenKind.WRAPPED));
    }

    // ------------------------------------------------------------ validators

    function test_AddValidator_Timelocked() public {
        _timelock(abi.encodeCall(FerminuxBridge.addValidator, (rogue)));
        assertTrue(bridge.isValidator(rogue));
        assertEq(bridge.validatorCount(), 4);
    }

    function test_AddValidator_RejectsDuplicate() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.addValidator, (v1)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: already a validator"));
        bridge.executeAction(id);
    }

    function test_AddValidator_RejectsZero() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.addValidator, (address(0))));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero validator"));
        bridge.executeAction(id);
    }

    function test_RemoveValidator_Timelocked() public {
        _timelock(abi.encodeCall(FerminuxBridge.removeValidator, (v3)));
        assertFalse(bridge.isValidator(v3));
        assertEq(bridge.validatorCount(), 2);
        address[] memory set = bridge.getValidators();
        assertEq(set.length, 2);
        assertTrue(set[0] == v1 || set[1] == v1);
        assertTrue(set[0] == v2 || set[1] == v2);
    }

    function test_RemoveValidator_RejectsUnknown() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.removeValidator, (rogue)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not a validator"));
        bridge.executeAction(id);
    }

    function test_RemoveValidator_RejectsWhenThresholdWouldBeUnreachable() public {
        _timelock(abi.encodeCall(FerminuxBridge.removeValidator, (v3)));
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.removeValidator, (v2)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: threshold unreachable"));
        bridge.executeAction(id);
    }

    function test_SetThreshold_RejectsAboveValidatorCount() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (4)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: bad threshold"));
        bridge.executeAction(id);
    }

    function test_SetThreshold_RejectsZero() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (0)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: bad threshold"));
        bridge.executeAction(id);
    }

    // ------------------------------------------------------------ fee config

    function test_SetFeeBps_Timelocked() public {
        _timelock(abi.encodeCall(FerminuxBridge.setFeeBps, (55)));
        assertEq(bridge.feeBps(), 55);
    }

    function test_SetFeeBps_HardCapAt100() public {
        _timelock(abi.encodeCall(FerminuxBridge.setFeeBps, (100)));
        assertEq(bridge.feeBps(), 100);

        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setFeeBps, (101)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: fee too high"));
        bridge.executeAction(id);
        assertEq(bridge.feeBps(), 100);
    }

    function test_SetFeeCollector_Timelocked() public {
        _timelock(abi.encodeCall(FerminuxBridge.setFeeCollector, (outsider)));
        assertEq(bridge.feeCollector(), outsider);
    }

    function test_SetFeeCollector_RejectsZero() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setFeeCollector, (address(0))));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero collector"));
        bridge.executeAction(id);
    }

    // ------------------------------------------------------------- ownership

    /// @dev Ownership is now the TENTH timelocked selector, so the handover is
    ///      proposed through queue()/executeAction() and only then accepted.
    function test_TransferOwnership_TwoStep() public {
        address newOwner = makeAddr("newMultisig");
        _timelock(abi.encodeCall(FerminuxBridge.transferOwnership, (newOwner)));
        assertEq(bridge.pendingOwner(), newOwner);
        assertEq(bridge.owner(), owner);
        assertEq(bridge.pendingOwnerExpiry(), uint64(block.timestamp) + bridge.OWNERSHIP_ACCEPT_WINDOW());

        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), newOwner);
        assertEq(bridge.pendingOwner(), address(0));
        assertEq(bridge.pendingOwnerExpiry(), 0);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
    }

    function test_TransferOwnership_UnreachableWithoutTheTimelock() public {
        // Not even the owner may call it directly any more.
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.transferOwnership(outsider);

        // And only the owner may queue it.
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.queue(abi.encodeCall(FerminuxBridge.transferOwnership, (outsider)));
    }

    function test_TransferOwnership_RejectsZero() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.transferOwnership, (address(0))));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero owner"));
        bridge.executeAction(id);
    }

    function test_AcceptOwnership_OnlyPending() public {
        _timelock(abi.encodeCall(FerminuxBridge.transferOwnership, (makeAddr("newMultisig"))));
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not pending owner"));
        bridge.acceptOwnership();
    }

    // --------------------------------------------------------------- pausers

    function test_SetPauser_OnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.setPauser(outsider, true);
    }

    function test_SetPauser_GrantAndRevoke() public {
        vm.prank(owner);
        bridge.setPauser(bob, true);
        assertTrue(bridge.isPauser(bob));
        vm.prank(owner);
        bridge.setPauser(bob, false);
        assertFalse(bridge.isPauser(bob));
    }

    function test_SetPauser_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero pauser"));
        bridge.setPauser(address(0), true);
    }

    // ------------------------------------------------------------------ misc

    function test_GetAction_RevertsOnUnknown() public {
        vm.expectRevert(bytes("BRIDGE: no such action"));
        bridge.getAction(99);
    }

    function test_DomainSeparator_BindsChainIdAndAddress() public {
        bytes32 here = bridge.DOMAIN_SEPARATOR();

        FerminuxBridge other = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        assertTrue(other.DOMAIN_SEPARATOR() != here, "different address must give a different domain");

        vm.chainId(OTHER_CHAIN);
        assertTrue(bridge.DOMAIN_SEPARATOR() != here, "different chain must give a different domain");
        vm.chainId(LOCAL_CHAIN);
        assertEq(bridge.DOMAIN_SEPARATOR(), here);
    }

    function testFuzz_QueueOnlyOwner(address caller) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
    }

    function testFuzz_TimelockNeverExecutesEarly(uint64 skipSeconds) public {
        skipSeconds = uint64(bound(skipSeconds, 0, DELAY - 1));
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.warp(block.timestamp + skipSeconds);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelock not elapsed"));
        bridge.executeAction(id);
        assertEq(bridge.threshold(), 2);
    }
}
