// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {FeeOnTransferToken} from "./utils/Mocks.sol";
import {ReflectionToken, SurchargeToken, BurnOnTransferToken, SilentNoopToken} from "./utils/RedTeamMocks.sol";

/**
 * @dev THE STRAND ESCAPE — round 3.
 *
 *      Removing the LOSSY class closed a fund-theft path and made settlement
 *      unconditional, which leaves exactly one honest problem behind: a canonical
 *      token that settled exactly while its collateral went in, and starts taxing
 *      its transfers afterwards. Every release then reverts — correctly, because
 *      the alternative is silently short-paying somebody — and the collateral
 *      cannot come out.
 *
 *      allowShortDelivery() is the answer, and this suite is the proof that it is
 *      an escape and not a door:
 *
 *        * it moves nothing itself, and the value only moves through the ordinary
 *          execute(), which still demands a full validator quorum
 *        * it is welded to ONE transferId, which commits to token, recipient,
 *          amount, both chain ids and the nonce
 *        * the bridge still may not part with more than that transfer's amount,
 *          still may not pay a recipient who receives nothing, still may not move
 *          nothing at all
 *        * it is single-use, timelocked, revocable for free, and loud in both
 *          directions — the announcement says what is owed, the settlement says
 *          what was actually delivered
 */
contract BridgeShortDeliveryTest is BridgeTestBase {
    address internal constant REMOTE_FOT = address(0x5D1);
    address internal constant REMOTE_RFLX = address(0x5D2);
    address internal constant REMOTE_SURC = address(0x5D3);
    address internal constant REMOTE_BURN = address(0x5D4);

    event ShortDeliveryAllowed(
        bytes32 indexed transferId, address indexed localToken, address indexed recipient, uint256 owed
    );
    event ShortDeliveryRevoked(bytes32 indexed transferId);
    event ShortDelivery(bytes32 indexed transferId, uint256 owed, uint256 paid, uint256 delivered);

    /// @dev The incident, set up exactly as it arrives: the token behaves while
    ///      100 tokens of collateral are locked behind it, then turns the tax on.
    function _strandedFot() internal returns (FeeOnTransferToken fot, uint256 locked) {
        fot = new FeeOnTransferToken();
        _registerCanonical(address(fot), REMOTE_CHAIN, REMOTE_FOT, MAX_PER, DAILY);
        fot.setTax(false);
        fot.mint(alice, 100 ether);
        vm.prank(alice);
        fot.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(fot), 100 ether, REMOTE_CHAIN, bob);
        locked = bridge.lockedBalance(address(fot));
        fot.setTax(true);
    }

    function _strandedReflection() internal returns (ReflectionToken rflx, uint256 locked) {
        rflx = new ReflectionToken();
        _registerCanonical(address(rflx), REMOTE_CHAIN, REMOTE_RFLX, MAX_PER, DAILY);
        rflx.setTax(false);
        rflx.mint(alice, 100 ether);
        vm.prank(alice);
        rflx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(rflx), 100 ether, REMOTE_CHAIN, bob);
        locked = bridge.lockedBalance(address(rflx));
        rflx.setTax(true);
    }

    // =====================================================================
    // The problem, stated as a test so the escape has something to escape.
    // =====================================================================

    /// @dev Without the escape this collateral never comes out. The refusal is
    ///      correct and retryable — but retrying forever is still a strand.
    function test_SD_WithoutTheEscapeAStrandedRouteStaysStranded() public {
        (FeeOnTransferToken fot, uint256 locked) = _strandedFot();

        for (uint64 n = 1; n <= 3; n++) {
            FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, n);
            FerminuxBridge.Signature[] memory sigs = _quorum(t);
            vm.prank(relayer);
            vm.expectRevert(bytes("BRIDGE: inexact transfer"));
            bridge.execute(t, sigs);
        }
        assertEq(bridge.lockedBalance(address(fot)), locked, "not one wei came out");
        assertEq(fot.balanceOf(bob), 0);
    }

    // =====================================================================
    // The escape, working.
    // =====================================================================

    function test_SD_ArmedTransferSettlesAndSaysExactlyWhatItShortChanged() public {
        (FeeOnTransferToken fot, uint256 locked) = _strandedFot();

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        bytes32 id = bridge.transferIdOf(t);

        // The announcement: 48h ahead, naming the transfer and what it owes.
        uint256 actionId = _queueMatured(abi.encodeCall(FerminuxBridge.allowShortDelivery, (t)));
        vm.expectEmit(true, true, true, true);
        emit ShortDeliveryAllowed(id, address(fot), bob, 10 ether);
        _fireAction(actionId);
        assertEq(bridge.shortDeliveryArmed(), id);

        uint256 tax = 10 ether / 100;
        uint256 bridgeBefore = fot.balanceOf(address(bridge));

        // The settlement: what was owed, what the bridge parted with, what landed.
        vm.expectEmit(true, true, true, true);
        emit ShortDelivery(id, 10 ether, 10 ether, 10 ether - tax);
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        assertEq(fot.balanceOf(bob), 10 ether - tax, "the recipient got the token's net, and the log says so");
        assertEq(bridgeBefore - fot.balanceOf(address(bridge)), 10 ether, "the bridge parted with the full amount");
        assertEq(bridge.lockedBalance(address(fot)), locked - 10 ether, "written down once, by its own amount");
        assertTrue(bridge.processed(id));
        assertEq(bridge.shortDeliveryArmed(), bytes32(0), "and the authorisation is spent");
    }

    /// @dev The other stranded shape: the token reflects part of the tax back, so
    ///      the bridge parts with LESS than the amount. The write-down is still the
    ///      full amount, so the residue lands in surplus — never in a shortfall.
    function test_SD_ReflectionShapeSettlesAndLeavesTheBridgeOverBackedNotShort() public {
        (ReflectionToken rflx, uint256 locked) = _strandedReflection();

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(rflx), REMOTE_RFLX, bob, 40 ether, 1);
        _allowShortDelivery(t);

        uint256 bridgeBefore = rflx.balanceOf(address(bridge));
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        uint256 paid = bridgeBefore - rflx.balanceOf(address(bridge));
        assertGt(rflx.balanceOf(bob), 0, "the recipient was actually paid");
        assertLt(paid, 40 ether, "and the bridge parted with less, because it is a holder too");
        assertEq(bridge.lockedBalance(address(rflx)), locked - 40 ether);
        assertGe(
            rflx.balanceOf(address(bridge)),
            bridge.lockedBalance(address(rflx)) + bridge.accruedFees(address(rflx)),
            "still fully backed"
        );
        assertGt(bridge.surplusOf(address(rflx)), 0, "the residue is surplus, and surplus is not a shortfall");
    }

    /// @dev The whole stranded position can be walked out, one announced transfer
    ///      at a time. That is the property the strand takes away and this restores.
    function test_SD_TheWholePositionCanBeWalkedOutOneTransferAtATime() public {
        (FeeOnTransferToken fot,) = _strandedFot();

        for (uint64 n = 1; n <= 3; n++) {
            uint256 remaining = bridge.lockedBalance(address(fot));
            uint256 amount = n == 3 ? remaining : 30 ether;
            FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, amount, n);
            _allowShortDelivery(t);
            vm.prank(relayer);
            bridge.execute(t, _quorum(t));
        }
        assertEq(bridge.lockedBalance(address(fot)), 0, "no collateral stranded");
        assertGt(fot.balanceOf(bob), 0);
    }

    // =====================================================================
    // Why it is not a door.
    // =====================================================================

    /// @dev It is timelocked. The owner cannot reach it directly, and an outsider
    ///      cannot even queue it.
    function test_SD_IsTimelockedAndOwnerOnlyToQueue() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 1 ether, 1);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.allowShortDelivery(t);

        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.queue(abi.encodeCall(FerminuxBridge.allowShortDelivery, (t)));

        assertEq(bridge.shortDeliveryArmed(), bytes32(0));
    }

    /// @dev THE property. An armed transfer still needs a validator quorum, so the
    ///      owner cannot direct one wei anywhere: they can only relax the equality
    ///      on a payout somebody else already authorised.
    function test_SD_ArmingAloneMovesNothingWithoutAQuorum() public {
        (FeeOnTransferToken fot, uint256 locked) = _strandedFot();
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, outsider, 50 ether, 1);
        _allowShortDelivery(t);

        // One signature is not a quorum, and neither is a bundle of strangers.
        FerminuxBridge.Signature[] memory one = _one(k1, t);
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not enough signatures"));
        bridge.execute(t, one);

        FerminuxBridge.Signature[] memory strangers = new FerminuxBridge.Signature[](2);
        (, uint256 kA) = makeAddrAndKey("strangerA");
        (, uint256 kB) = makeAddrAndKey("strangerB");
        strangers[0] = _sign(kA, t);
        strangers[1] = _sign(kB, t);
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, strangers);

        assertEq(fot.balanceOf(outsider), 0);
        assertEq(bridge.lockedBalance(address(fot)), locked);
    }

    /// @dev The authorisation is welded to one transferId. Change the amount or
    ///      the recipient and it is a different id that the armed slot does not
    ///      cover — so the ordinary strict rule applies and the release reverts.
    function test_SD_TheAuthorisationDoesNotCoverANeighbouringTransfer() public {
        (FeeOnTransferToken fot,) = _strandedFot();
        FerminuxBridge.BridgeTransfer memory armed = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        _allowShortDelivery(armed);

        FerminuxBridge.BridgeTransfer memory bigger = _inbound(address(fot), REMOTE_FOT, bob, 20 ether, 2);
        FerminuxBridge.Signature[] memory sigsBigger = _quorum(bigger);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(bigger, sigsBigger);

        FerminuxBridge.BridgeTransfer memory elsewhere = _inbound(address(fot), REMOTE_FOT, outsider, 10 ether, 3);
        FerminuxBridge.Signature[] memory sigsElsewhere = _quorum(elsewhere);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(elsewhere, sigsElsewhere);

        assertEq(fot.balanceOf(outsider), 0);
        assertEq(bridge.shortDeliveryArmed(), bridge.transferIdOf(armed), "still armed on the one it names");
    }

    /// @dev Single-use. The bit is cleared before the payout, so a second transfer
    ///      of the same shape gets the strict rule again.
    function test_SD_IsSpentOnFirstUse() public {
        (FeeOnTransferToken fot,) = _strandedFot();
        FerminuxBridge.BridgeTransfer memory first = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        _allowShortDelivery(first);
        vm.prank(relayer);
        bridge.execute(first, _quorum(first));
        assertEq(bridge.shortDeliveryArmed(), bytes32(0));

        FerminuxBridge.BridgeTransfer memory second = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 2);
        FerminuxBridge.Signature[] memory sigs = _quorum(second);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(second, sigs);
    }

    /// @dev The solvency rail survives the escape: a token whose fee lands ON TOP
    ///      of the amount is refused even when armed, because that release would
    ///      eat somebody else's collateral.
    function test_SD_CannotPayOutMoreThanTheTransferItNames() public {
        SurchargeToken surc = new SurchargeToken();
        _registerCanonical(address(surc), REMOTE_CHAIN, REMOTE_SURC, MAX_PER, DAILY);
        surc.mint(alice, 100 ether);
        vm.prank(alice);
        surc.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(surc), 100 ether, REMOTE_CHAIN, bob);
        uint256 held = surc.balanceOf(address(bridge));
        uint256 locked = bridge.lockedBalance(address(surc));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(surc), REMOTE_SURC, bob, 50 ether, 1);
        _allowShortDelivery(t);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(t, sigs);

        assertEq(surc.balanceOf(address(bridge)), held, "not one wei of surcharge came out of the pool");
        assertEq(bridge.lockedBalance(address(surc)), locked);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    /// @dev "Short" never means "nothing". A token that debits the bridge and
    ///      credits nobody is refused with the authorisation in place.
    function test_SD_StillRefusesAReleaseThatDeliversNothing() public {
        BurnOnTransferToken burn = new BurnOnTransferToken();
        _registerCanonical(address(burn), REMOTE_CHAIN, REMOTE_BURN, MAX_PER, DAILY);
        burn.mint(alice, 100 ether);
        vm.prank(alice);
        burn.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(burn), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(burn));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(burn), REMOTE_BURN, bob, 50 ether, 1);
        _allowShortDelivery(t);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: transfer not settled"));
        bridge.execute(t, sigs);

        assertEq(burn.balanceOf(bob), 0);
        assertEq(bridge.lockedBalance(address(burn)), locked);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    /// @dev ...nor "moved nothing". A token that has gone dark cannot consume a
    ///      transferId behind an authorisation either.
    function test_SD_StillRefusesAReleaseThatMovesNothing() public {
        SilentNoopToken slnt = new SilentNoopToken();
        _registerCanonical(address(slnt), REMOTE_CHAIN, address(0x5D5), MAX_PER, DAILY);
        slnt.mint(alice, 100 ether);
        vm.prank(alice);
        slnt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(slnt), 100 ether, REMOTE_CHAIN, bob);
        slnt.goSilent();

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(slnt), address(0x5D5), bob, 50 ether, 1);
        _allowShortDelivery(t);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: transfer not settled"));
        bridge.execute(t, sigs);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    /// @dev The collateral ceiling is untouched: an armed transfer for more than
    ///      the bridge ever locked still underflows lockedBalance and reverts.
    function test_SD_CannotReachPastTheCollateralItIsOwed() public {
        (FeeOnTransferToken fot, uint256 locked) = _strandedFot();
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, locked + 1, 1);
        _allowShortDelivery(t);

        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(); // lockedBalance underflow — the hard ceiling
        bridge.execute(t, sigs);
        assertEq(bridge.lockedBalance(address(fot)), locked);
    }

    /// @dev A wrapped release is a mint, which cannot under-deliver; the native
    ///      coin either transfers msg.value or reverts. Both are refused at the
    ///      announcement, not silently accepted as no-ops.
    function test_SD_RefusesWrappedAndNativeAndUnregisteredTargets() public {
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.allowShortDelivery, (_inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1))),
            bytes("BRIDGE: not canonical")
        );
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.allowShortDelivery, (_inbound(address(0), REMOTE_WFMX, bob, 1 ether, 1))),
            bytes("BRIDGE: not canonical")
        );
        _expectTimelockRevert(
            abi.encodeCall(
                FerminuxBridge.allowShortDelivery, (_inbound(address(0xDEAD), address(0xBEEF), bob, 1 ether, 1))
            ),
            bytes("BRIDGE: not canonical")
        );
        assertEq(bridge.shortDeliveryArmed(), bytes32(0));
    }

    // =====================================================================
    // Revocation, and the one-at-a-time rule.
    // =====================================================================

    /// @dev Revoking is instant and owner-only, like every other revocation here:
    ///      withdrawing a permission is a safety action and never waits.
    function test_SD_CanBeRevokedInstantlyAndTheStrictRuleReturns() public {
        (FeeOnTransferToken fot,) = _strandedFot();
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        _allowShortDelivery(t);
        bytes32 id = bridge.transferIdOf(t);

        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.cancelShortDelivery();

        vm.expectEmit(true, true, true, true);
        emit ShortDeliveryRevoked(id);
        vm.prank(owner);
        bridge.cancelShortDelivery();
        assertEq(bridge.shortDeliveryArmed(), bytes32(0));

        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(t, sigs);
    }

    function test_SD_RevokingNothingReverts() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not allowed"));
        bridge.cancelShortDelivery();
    }

    /// @dev One authorisation exists at a time, so arming a second replaces the
    ///      first rather than accumulating standing permissions.
    function test_SD_OnlyOneTransferIsArmedAtATime() public {
        (FeeOnTransferToken fot,) = _strandedFot();
        FerminuxBridge.BridgeTransfer memory first = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        FerminuxBridge.BridgeTransfer memory second = _inbound(address(fot), REMOTE_FOT, bob, 20 ether, 2);

        _allowShortDelivery(first);
        assertEq(bridge.shortDeliveryArmed(), bridge.transferIdOf(first));
        _allowShortDelivery(second);
        assertEq(bridge.shortDeliveryArmed(), bridge.transferIdOf(second), "the second replaced the first");

        FerminuxBridge.Signature[] memory sigs = _quorum(first);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(first, sigs);
    }

    /// @dev An armed authorisation for one asset does not loosen anything else:
    ///      an ordinary token on an ordinary route still settles exactly.
    function test_SD_ArmingOneTransferDoesNotLoosenAnyOther() public {
        (FeeOnTransferToken fot,) = _strandedFot();
        _allowShortDelivery(_inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1));

        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 60 ether, 7);
        uint256 before = usdx.balanceOf(address(bridge));
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));
        assertEq(before - usdx.balanceOf(address(bridge)), 60 ether);
        assertEq(usdx.balanceOf(bob), 60 ether);
    }

    // =====================================================================
    // The residue, and rescue().
    // =====================================================================

    /// @dev The reflection shape writes the debt down by more than the bridge
    ///      parted with, which manufactures surplus. That was a MEDIUM when
    ///      rescue() was instant; now a registered token's surplus is itself
    ///      timelocked, so the residue costs a second public 48h announcement.
    function test_SD_TheResidueIsOnlyReachableThroughASecondTimelock() public {
        (ReflectionToken rflx,) = _strandedReflection();
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(rflx), REMOTE_RFLX, bob, 40 ether, 1);
        _allowShortDelivery(t);
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        uint256 residue = bridge.surplusOf(address(rflx));
        assertGt(residue, 0, "the escape did manufacture surplus: measured, not denied");

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.rescue(address(rflx), owner, 1);

        // ...and even through the timelock it is capped at the surplus, so the
        // collateral behind the remaining transfers is untouched.
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.rescue, (address(rflx), owner, residue + 1)), bytes("BRIDGE: exceeds surplus")
        );
        assertGe(
            rflx.balanceOf(address(bridge)),
            bridge.lockedBalance(address(rflx)) + bridge.accruedFees(address(rflx)),
            "collateral still fully backed"
        );
    }

    // =====================================================================
    // Fuzz.
    // =====================================================================

    /// @dev Over any armed amount the bridge may deliver less, never more, and may
    ///      never part with more than the transfer it was authorised for.
    function testFuzz_ShortDeliveryNeverPaysMoreThanItIsOwed(uint96 rawAmount) public {
        (FeeOnTransferToken fot, uint256 locked) = _strandedFot();
        uint256 amount = bound(uint256(rawAmount), 1e6, locked);

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, amount, 1);
        _allowShortDelivery(t);

        uint256 bridgeBefore = fot.balanceOf(address(bridge));
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        uint256 paid = bridgeBefore - fot.balanceOf(address(bridge));
        assertLe(paid, amount, "never more than the transfer's own amount");
        assertGt(paid, 0, "and never nothing");
        assertLe(fot.balanceOf(bob), amount, "the recipient is short-paid, never over-paid");
        assertGt(fot.balanceOf(bob), 0);
        assertEq(bridge.lockedBalance(address(fot)), locked - amount);
    }
}
