// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {MockERC20, FeeOnTransferToken} from "./utils/Mocks.sol";
import {SeizableToken, SilentNoopToken, ProxyWrapper, LyingWrapper} from "./utils/RedTeamMocks.sol";

/**
 * @dev Regression suite for the red-team review of 2026-08-20
 *      (audit/RED-TEAM-2026-08-20.md). Every test here replays a proof-of-concept
 *      that PASSED against the pre-remediation contracts and asserts that the
 *      attack is now neutralised. Names carry the finding id:
 *
 *        H1  _safeTransfer had no code-existence check
 *        M1  execute() to the bridge itself turned collateral into surplus
 *        M2  withdrawFees dipped into collateral
 *        M3  immutable BridgeToken.bridge made migration a dead end
 *        M4  transferOwnership bypassed the timelock; pendingOwner never expired
 *        M5  no success check on mint/burn; spoofable registerWrapped guard
 *        L1  registry allowed two local tokens per remote pair
 *        L2  arity guard rejected a valid quorum containing a stale signature
 *        L3  matured action could be held for the whole grace period
 *        I1  feeCollector could be the bridge itself
 */
contract BridgeRedTeamTest is BridgeTestBase {
    address internal constant REMOTE_SILENT = address(0xC0DE);
    address internal constant REMOTE_SEIZ = address(0xF6F6);
    address internal constant REMOTE_FOT = address(0xF00D);
    address internal constant REMOTE_LIAR = address(0xA11);

    /// @dev queue -> warp -> execute against a bridge other than the fixture's.
    function _timelockOn(FerminuxBridge target, bytes memory data) internal returns (uint256 actionId) {
        vm.prank(owner);
        actionId = target.queue(data);
        vm.warp(block.timestamp + target.timelockDelay());
        vm.prank(owner);
        target.executeAction(actionId);
    }

    // =====================================================================
    // H1 — a release against a token that has gone dark must REVERT, so the
    //      transfer stays unprocessed and retryable, instead of consuming the
    //      transferId and writing down the collateral while paying nobody.
    //      PoC: Attack3.t.sol::test_C1, Attack4.t.sol::test_C8
    // =====================================================================

    function test_H1_ReleaseAgainstACodelessTokenRevertsAndStaysRetryable() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(usdx));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        bytes memory realCode = address(usdx).code;

        // SELFDESTRUCT on a pre-Cancun chain — the token keeps its storage and
        // loses its code.
        vm.etch(address(usdx), "");

        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: token has no code"));
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)), "transferId must NOT be consumed");
        assertEq(bridge.lockedBalance(address(usdx)), locked, "collateral must NOT be written down");
        assertEq(bridge.inboundUsage(address(usdx)), 0, "cap must NOT be consumed");

        // The whole point of failing loudly: a temporary token outage is now a
        // delay, not a permanent loss.
        vm.etch(address(usdx), realCode);
        vm.prank(relayer);
        bridge.execute(t, sigs);
        assertEq(usdx.balanceOf(bob), 50 ether, "same transfer settles once the token is healthy");
    }

    function test_H1_ReleaseThatMovesNothingRevertsEvenThoughTheTokenHasCode() public {
        SilentNoopToken slnt = new SilentNoopToken();
        _registerCanonical(address(slnt), REMOTE_CHAIN, REMOTE_SILENT, MAX_PER, DAILY);
        slnt.mint(alice, 100 ether);
        vm.prank(alice);
        slnt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(slnt), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(slnt));

        // transfer() now succeeds, returns no data, and moves nothing — a dead
        // proxy in miniature. A code-existence check alone cannot see this.
        slnt.goSilent();

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(slnt), REMOTE_SILENT, bob, 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: transfer not settled"));
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)));
        assertEq(bridge.lockedBalance(address(slnt)), locked);
        assertEq(slnt.balanceOf(bob), 0);
    }

    function test_H1_ReleaseThroughADeadProxyReverts() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(usdx));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);

        // The Cancun-proof variant: the token keeps its own code but delegatecalls
        // into nothing, which returns success with empty returndata.
        ProxyWrapper dead = new ProxyWrapper(address(0), address(bridge));
        vm.etch(address(usdx), address(dead).code);
        vm.store(address(usdx), bytes32(uint256(0)), bytes32(0)); // impl = address(0)

        vm.prank(relayer);
        vm.expectRevert(); // the settlement read itself cannot be answered
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)));
        assertEq(bridge.lockedBalance(address(usdx)), locked);
    }

    function test_H1_SendAgainstACodelessTokenReverts() public {
        vm.etch(address(usdx), "");
        vm.prank(alice);
        vm.expectRevert(); // balance metering and the explicit code check both refuse
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, bob);
        assertEq(bridge.lockedBalance(address(usdx)), 0);
    }

    /// @dev A token that skims the recipient is REFUSED on release, retryably —
    ///      the bridge never short-pays a signed amount by default. Round 2 made
    ///      this settle by declaring the token LOSSY; round 3 removed that class
    ///      (its deposit half was a fund-theft path) and the only way out for
    ///      collateral behind a token that turned hostile is the per-transfer
    ///      timelocked escape, proved in BridgeShortDelivery.t.sol.
    function test_H1_FeeOnTransferReleaseIsRefusedRetryably() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        _registerCanonical(address(fot), REMOTE_CHAIN, REMOTE_FOT, MAX_PER, DAILY);
        fot.setTax(false); // exact while the collateral goes in
        fot.mint(alice, 100 ether);
        vm.prank(alice);
        fot.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(fot), 50 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(fot));
        fot.setTax(true); // ...and hostile afterwards

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(t, sigs);

        assertEq(fot.balanceOf(bob), 0, "nobody was silently short-paid");
        assertFalse(bridge.processed(bridge.transferIdOf(t)), "and the transfer is still retryable");
        assertEq(bridge.lockedBalance(address(fot)), locked, "collateral untouched");
    }

    // =====================================================================
    // M1 — execute() with recipient == the bridge itself.
    //      PoC: Attack.t.sol::test_A1 / A1b / A1c / A1d
    // =====================================================================

    function test_M1_ExecuteToTheBridgeIsRejected_ERC20() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(usdx));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, address(bridge), 60 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.execute(t, sigs);

        assertEq(bridge.lockedBalance(address(usdx)), locked, "collateral intact");
        assertEq(bridge.surplusOf(address(usdx)), 0, "no collateral reclassified as surplus");
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    function test_M1_ExecuteToTheBridgeIsRejected_Native() public {
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(0));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(0), REMOTE_WFMX, address(bridge), 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.execute(t, sigs);

        assertEq(bridge.lockedBalance(address(0)), locked);
        assertEq(bridge.surplusOf(address(0)), 0);
    }

    function test_M1_ExecuteToTheBridgeIsRejected_Wrapped() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, address(bridge), 40 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.execute(t, sigs);

        assertEq(wrmt.totalSupply(), 0, "no IOU minted to the bridge");
        assertEq(bridge.surplusOf(address(wrmt)), 0);
    }

    /// @dev Caught at ORIGIN too, where the user still has their money. This is
    ///      the LOCAL sanity check; the load-bearing one is the remote-bridge
    ///      guard asserted in BridgeVerifier.t.sol (finding F).
    function test_M1_SendRejectsTheBridgeAsRecipient() public {
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, address(bridge));

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, address(bridge));
    }

    /// @dev The invariant the finding actually violated: no execute(), of any
    ///      kind, may increase surplusOf(). Surplus grows only from genuine
    ///      external inflows, never from an internal state transition.
    function test_M1_SurplusIsUnchangedAcrossEveryExecute() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        vm.prank(alice);
        bridge.send{value: 100 ether}(address(0), 100 ether, REMOTE_CHAIN, bob);

        uint256 sUsdx = bridge.surplusOf(address(usdx));
        uint256 sNative = bridge.surplusOf(address(0));
        uint256 sWrapped = bridge.surplusOf(address(wrmt));

        FerminuxBridge.BridgeTransfer memory a = _inbound(address(usdx), REMOTE_WUSDX, bob, 60 ether, 1);
        bridge.execute(a, _quorum(a));
        FerminuxBridge.BridgeTransfer memory b = _inbound(address(0), REMOTE_WFMX, bob, 50 ether, 2);
        bridge.execute(b, _quorum(b));
        FerminuxBridge.BridgeTransfer memory c = _inbound(address(wrmt), REMOTE_RMT, bob, 40 ether, 3);
        bridge.execute(c, _quorum(c));

        assertEq(bridge.surplusOf(address(usdx)), sUsdx, "canonical ERC20 release created no surplus");
        assertEq(bridge.surplusOf(address(0)), sNative, "native release created no surplus");
        assertEq(bridge.surplusOf(address(wrmt)), sWrapped, "wrapped mint created no surplus");
    }

    // =====================================================================
    // M2 — withdrawFees must fail closed under exactly the conditions rescue()
    //      already fails closed under. PoC: Attack.t.sol::test_A7
    // =====================================================================

    function test_M2_WithdrawFeesRefusesWhenCollateralWouldBeImpaired() public {
        SeizableToken sz = new SeizableToken();
        _registerCanonical(address(sz), REMOTE_CHAIN, REMOTE_SEIZ, MAX_PER, DAILY);
        sz.mint(alice, 100 ether);
        vm.prank(alice);
        sz.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(sz), 100 ether, REMOTE_CHAIN, bob);

        uint256 locked = bridge.lockedBalance(address(sz));
        uint256 fees = bridge.accruedFees(address(sz));
        assertEq(sz.balanceOf(address(bridge)), locked + fees);

        // Issuer clawback / blacklist-with-burn: the bridge is now short.
        sz.seize(address(bridge), 50 ether);
        assertLt(sz.balanceOf(address(bridge)), locked + fees, "insolvent");
        assertEq(bridge.surplusOf(address(sz)), 0, "rescue already refuses here");

        vm.prank(collector);
        vm.expectRevert(bytes("BRIDGE: impairs collateral"));
        bridge.withdrawFees(address(sz));

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: impairs collateral"));
        bridge.withdrawFees(address(sz));

        assertEq(sz.balanceOf(collector), 0, "not one wei of principal left as a fee");
        assertEq(bridge.accruedFees(address(sz)), fees, "the accrual is untouched, not silently zeroed");
    }

    function test_M2_WithdrawFeesStillWorksWhileSolventAndLeavesCollateralWhole() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        uint256 fee = _fee(100 ether);

        vm.prank(collector);
        bridge.withdrawFees(address(usdx));

        assertEq(usdx.balanceOf(collector), fee);
        assertGe(usdx.balanceOf(address(bridge)), bridge.lockedBalance(address(usdx)), "collateral still fully backed");
    }

    // =====================================================================
    // M3 — a migration must be able to carry the wrapped supply with it.
    //      PoC: Attack2.t.sol::test_B1
    // =====================================================================

    function test_M3_RedeployedBridgeAdoptsWrappedSupplyAndHoldersGetAnExit() public {
        // Real wrapped supply, created honestly.
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 100 ether, 1);
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));
        assertEq(wrmt.totalSupply(), 100 ether);

        // Incident response per the docs: pause v1, stand up v2.
        vm.prank(pauser);
        bridge.pause();
        FerminuxBridge v2 = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        // v2 stands its own registry up first: adoptWrapper is gated on the
        // wrapper codehash pin, so the only seat it can take is one holding
        // audited BridgeToken code.
        _pinBridgeToken(v2);
        _setRemoteBridge(v2, REMOTE_CHAIN, REMOTE_BRIDGE);

        // v1 hands the minter seat over. Timelocked here, then a second delay
        // inside the token before v2 may take it up.
        _timelock(abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(v2))));
        assertEq(wrmt.pendingBridge(), address(v2));

        vm.warp(block.timestamp + wrmt.ROTATION_DELAY());
        vm.prank(owner);
        v2.adoptWrapper(address(wrmt));
        assertEq(wrmt.bridge(), address(v2), "v2 is the minter");
        assertEq(wrmt.pendingBridge(), address(0));

        // v2 can now register the existing wrapper — the step that used to revert
        // "BRIDGE: not the minter" forever.
        _timelockOn(
            v2,
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(wrmt), REMOTE_CHAIN, REMOTE_RMT, MAX_PER, DAILY))
        );

        // The rotation moved the minter seat, and nothing else. v2 inherits no
        // claim on bob's balance: allowances are per-spender, and bob never
        // granted one to a contract that did not exist when he was paid. This is
        // the property the burn() allowance check buys — a bridge installed by
        // rotation cannot spend what it was not approved to spend.
        vm.prank(bob);
        vm.expectRevert(bytes("WTOKEN: burn exceeds allowance"));
        v2.send(address(wrmt), 10 ether, REMOTE_CHAIN, bob);
        assertEq(wrmt.balanceOf(bob), 100 ether, "an unapproved v2 moved nothing");

        // bob has an exit that does not run through the contract we migrated away
        // from — he takes it himself, by approving the bridge he chose to use.
        vm.prank(bob);
        wrmt.approve(address(v2), 10 ether);
        vm.prank(bob);
        v2.send(address(wrmt), 10 ether, REMOTE_CHAIN, bob);
        assertEq(wrmt.balanceOf(bob), 90 ether, "wrapped supply is redeemable again");
        assertEq(wrmt.allowance(bob, address(v2)), 0, "the exit consumed exactly the approval");

        // And the abandoned bridge can no longer touch supply, even unpaused.
        vm.prank(owner);
        bridge.unpause();
        vm.prank(bob);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        bridge.send(address(wrmt), 1 ether, REMOTE_CHAIN, bob);
    }

    function test_M3_ProposeWrapperBridgeIsTimelocked() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.proposeWrapperBridge(address(wrmt), address(0xBEEF));

        // It is queueable, which is the whole point: the handover announces itself.
        vm.prank(owner);
        bridge.queue(abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(0xBEEF))));
        assertEq(wrmt.pendingBridge(), address(0), "queueing alone changes nothing");
    }

    function test_M3_RotationCannotBeAcceptedEarlyOrByAnyoneElse() public {
        FerminuxBridge v2 = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        _pinBridgeToken(v2);
        _timelock(abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(v2))));

        vm.prank(owner);
        vm.expectRevert(bytes("WTOKEN: rotation not elapsed"));
        v2.adoptWrapper(address(wrmt));

        vm.warp(block.timestamp + wrmt.ROTATION_DELAY());
        vm.prank(outsider);
        vm.expectRevert(bytes("WTOKEN: not pending bridge"));
        wrmt.acceptBridge();

        assertEq(wrmt.bridge(), address(bridge));
    }

    function test_M3_RotationIsRevocableInstantly() public {
        FerminuxBridge v2 = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        _pinBridgeToken(v2);
        _timelock(abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(v2))));

        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.cancelWrapperBridgeRotation(address(wrmt));

        vm.prank(owner);
        bridge.cancelWrapperBridgeRotation(address(wrmt));
        assertEq(wrmt.pendingBridge(), address(0));

        vm.warp(block.timestamp + wrmt.ROTATION_DELAY());
        vm.prank(owner);
        vm.expectRevert(bytes("WTOKEN: not pending bridge"));
        v2.adoptWrapper(address(wrmt));
        assertEq(wrmt.bridge(), address(bridge));
    }

    function test_M3_MinterSeatCanOnlyBeHandedOverNeverTaken() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        wrmt.proposeBridge(outsider);

        vm.prank(owner);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        wrmt.proposeBridge(owner);

        assertEq(wrmt.bridge(), address(bridge));
    }

    // =====================================================================
    // M4 — ownership is the largest blast radius in the system, so it goes
    //      through the timelock and a stale offer dies.
    //      PoC: Attack.t.sol::test_A5, Attack2.t.sol::test_B2
    // =====================================================================

    function test_M4_OwnershipHandoverGoesThroughTheTimelock() public {
        address attacker = makeAddr("attacker");

        // The one-block takeover is gone: not even the owner may call it directly.
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.transferOwnership(attacker);

        // It must be announced. queue() now accepts the selector.
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.transferOwnership, (attacker)));
        assertEq(bridge.pendingOwner(), address(0), "nothing is pending until the delay has run");

        vm.prank(attacker);
        vm.expectRevert(bytes("BRIDGE: not pending owner"));
        bridge.acceptOwnership();

        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        bridge.executeAction(id);
        assertEq(bridge.pendingOwner(), attacker);
        assertEq(bridge.owner(), owner, "still a two-step handover");
    }

    function test_M4_QueuedHandoverCanBeCanceledBeforeItLands() public {
        address attacker = makeAddr("attacker");
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.transferOwnership, (attacker)));
        vm.prank(owner);
        bridge.cancelAction(id);

        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: action canceled"));
        bridge.executeAction(id);
        assertEq(bridge.pendingOwner(), address(0));
        assertEq(bridge.owner(), owner);
    }

    function test_M4_PendingOwnerCanBeRevoked() public {
        address candidate = makeAddr("newMultisigThatWasNeverUsed");
        _timelock(abi.encodeCall(FerminuxBridge.transferOwnership, (candidate)));
        assertEq(bridge.pendingOwner(), candidate);

        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.cancelOwnershipTransfer();

        vm.prank(owner);
        bridge.cancelOwnershipTransfer();
        assertEq(bridge.pendingOwner(), address(0));
        assertEq(bridge.pendingOwnerExpiry(), 0);

        vm.prank(candidate);
        vm.expectRevert(bytes("BRIDGE: not pending owner"));
        bridge.acceptOwnership();
        assertEq(bridge.owner(), owner);
    }

    function test_M4_CancelOwnershipTransferRejectsWhenNothingIsPending() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: no pending owner"));
        bridge.cancelOwnershipTransfer();
    }

    function test_M4_AbandonedOfferExpiresInsteadOfStandingForever() public {
        address candidate = makeAddr("newMultisigThatWasNeverUsed");
        _timelock(abi.encodeCall(FerminuxBridge.transferOwnership, (candidate)));

        vm.warp(block.timestamp + 730 days);
        vm.prank(candidate);
        vm.expectRevert(bytes("BRIDGE: offer expired"));
        bridge.acceptOwnership();
        assertEq(bridge.owner(), owner, "no silent takeover two years later");
    }

    function test_M4_OfferIsStillGoodOnTheLastSecondOfTheWindow() public {
        address candidate = makeAddr("newMultisig");
        _timelock(abi.encodeCall(FerminuxBridge.transferOwnership, (candidate)));
        uint64 expiry = bridge.pendingOwnerExpiry();

        vm.warp(expiry);
        vm.prank(candidate);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), candidate);
    }

    // =====================================================================
    // M5 — mint/burn are verified by measured effect, and registerWrapped pins
    //      the wrapper bytecode instead of trusting a view function.
    //      PoC: Attack4.t.sol::test_C6 / test_C7
    // =====================================================================

    function test_M5_RegisterWrappedRejectsAProxyWrapper() public {
        ProxyWrapper spoof = new ProxyWrapper(address(0), address(bridge));
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(spoof), REMOTE_CHAIN, REMOTE_LIAR, MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: wrapper not pinned"));
        bridge.executeAction(id);

        assertEq(uint256(bridge.tokenConfig(address(spoof)).kind), uint256(FerminuxBridge.TokenKind.UNREGISTERED));
    }

    function test_M5_RegisterWrappedFailsClosedWhenNoWrapperIsPinned() public {
        FerminuxBridge fresh = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        BridgeToken w = new BridgeToken("Wrapped RMT", "wRMT", 18, address(fresh), REMOTE_CHAIN, REMOTE_RMT);
        assertEq(fresh.bridgeTokenCodehash(), bytes32(0));

        vm.prank(owner);
        uint256 id = fresh.queue(
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(w), REMOTE_CHAIN, REMOTE_RMT, MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: wrapper pin unset"));
        fresh.executeAction(id);
    }

    function test_M5_ChangingTheWrapperPinIsItselfTimelocked() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setBridgeTokenCodehash(keccak256("anything"));

        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (bytes32(0))));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: zero codehash"));
        bridge.executeAction(id);

        assertEq(bridge.bridgeTokenCodehash(), _bridgeTokenCodehash(), "pin unchanged");
    }

    /// @dev Second line of defence: if governance ever pins a wrapper that lies,
    ///      the supply delta still catches it. A burn that does not settle can no
    ///      longer produce a signed Sent against the far chain's collateral.
    function test_M5_WrappedBurnThatDoesNotSettleReverts() public {
        LyingWrapper liar = _registerLyingWrapper();

        FerminuxBridge.BridgeTransfer memory in_ = _inbound(address(liar), REMOTE_LIAR, alice, 100 ether, 1);
        vm.prank(relayer);
        bridge.execute(in_, _quorum(in_));
        assertEq(liar.balanceOf(alice), 100 ether);

        liar.startLying();

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: burn not settled"));
        bridge.send(address(liar), 100 ether, REMOTE_CHAIN, bob);

        assertEq(liar.balanceOf(alice), 100 ether, "nothing burned, so nothing may be claimed abroad");
        assertEq(bridge.accruedFees(address(liar)), 0, "no fee booked on a phantom burn");
        assertEq(bridge.outboundNonce(), 0, "no Sent emitted");
    }

    function test_M5_WrappedMintThatDoesNotSettleReverts() public {
        LyingWrapper liar = _registerLyingWrapper();
        liar.startLying();

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(liar), REMOTE_LIAR, bob, 100 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: mint not settled"));
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)), "transferId not burned on a phantom mint");
        assertEq(liar.balanceOf(bob), 0);
        assertEq(bridge.inboundUsage(address(liar)), 0);
    }

    function _registerLyingWrapper() internal returns (LyingWrapper liar) {
        liar = new LyingWrapper(address(bridge));
        // Governance error, modelled explicitly: the pin is moved to a wrapper
        // that is not the audited BridgeToken. Both steps are timelocked.
        _timelock(abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (address(liar).codehash)));
        _registerWrapped(address(liar), REMOTE_CHAIN, REMOTE_LIAR, MAX_PER, DAILY);
    }

    // =====================================================================
    // L1 — the registry is a bijection. PoC: Attack.t.sol::test_A6
    // =====================================================================

    function test_L1_OneRemoteAssetCannotBeRoutedToTwoLocalTokens() public {
        BridgeToken wdup = new BridgeToken("wDup", "wDUP", 18, address(bridge), REMOTE_CHAIN, REMOTE_WUSDX);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(wdup), REMOTE_CHAIN, REMOTE_WUSDX, MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: remote already routed"));
        bridge.executeAction(id);

        assertEq(uint256(bridge.tokenConfig(address(wdup)).kind), uint256(FerminuxBridge.TokenKind.UNREGISTERED));
        assertEq(bridge.registeredTokenCount(), 3);
    }

    function test_L1_CanonicalCannotShadowAnExistingRouteEither() public {
        MockERC20 dup = new MockERC20("Dup", "DUP", 18);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(dup), REMOTE_CHAIN, REMOTE_RMT, MAX_PER, DAILY))
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: remote already routed"));
        bridge.executeAction(id);
    }

    function test_L1_ReverseIndexResolvesEveryRegisteredRoute() public view {
        assertEq(bridge.localTokenFor(REMOTE_CHAIN, REMOTE_WUSDX), address(usdx));
        assertEq(bridge.localTokenFor(REMOTE_CHAIN, REMOTE_RMT), address(wrmt));

        // The native coin's local address IS address(0), so the boolean is what
        // separates "routed to the native coin" from "not routed at all".
        assertEq(bridge.localTokenFor(REMOTE_CHAIN, REMOTE_WFMX), address(0), "native route");
        assertTrue(bridge.isRemoteRouted(REMOTE_CHAIN, REMOTE_WFMX));
        assertFalse(bridge.isRemoteRouted(OTHER_CHAIN, REMOTE_WUSDX), "unrouted pair");
    }

    /// @dev The sentinel case: without it, the native coin's slot would read as
    ///      empty and a second local token could claim its remote asset.
    function test_L1_NativeRouteCannotBeShadowedByAnotherToken() public {
        MockERC20 impostor = new MockERC20("Impostor", "IMP", 18);
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(
                FerminuxBridge.registerCanonical, (address(impostor), REMOTE_CHAIN, REMOTE_WFMX, MAX_PER, DAILY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: remote already routed"));
        bridge.executeAction(id);
    }

    // =====================================================================
    // L2 — the arity bound is a constant, so a rotation cannot invalidate a
    //      bundle whose content is a valid quorum.
    //      PoC: Attack2.t.sol::test_B6
    // =====================================================================

    /// @dev ROUND 3 CLOSED THE OTHER HALF OF L2. Round 2 made the arity bound a
    ///      constant, so a bundle was no longer rejected on its LENGTH — but it was
    ///      still rejected wholesale for CONTAINING one stale signature, which is
    ///      the same outage with a different revert string. A relayer that collects
    ///      every signature it can get is doing the right thing; the moment
    ///      removeValidator lands, its in-flight bundles carried a signer who is no
    ///      longer in the set, and every one of them died even though two current
    ///      validators had signed. Now the stale signature is ignored and the
    ///      quorum inside the bundle is honoured.
    function test_L2_StaleSignatureIsIgnoredAndTheQuorumInsideStillExecutes() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 10 ether, 1);
        // The relayer collects every signature it can get — normal practice.
        FerminuxBridge.Signature[] memory three = new FerminuxBridge.Signature[](3);
        three[0] = _sign(k1, t);
        three[1] = _sign(k2, t);
        three[2] = _sign(k3, t);

        // v3 is rotated out mid-flight; v1 and v2 are still valid and both signed.
        _timelock(abi.encodeCall(FerminuxBridge.removeValidator, (v3)));
        assertEq(bridge.validatorCount(), 2);

        vm.prank(relayer);
        bridge.execute(t, three);
        assertEq(wrmt.balanceOf(bob), 10 ether, "the in-flight bundle survived the rotation");

        // The stale signer did NOT count toward the quorum. With v3's signature and
        // only ONE current validator, the same bundle shape is refused.
        FerminuxBridge.BridgeTransfer memory t2 = _inbound(address(wrmt), REMOTE_RMT, bob, 10 ether, 2);
        FerminuxBridge.Signature[] memory staleQuorum = _sigs(k1, k3, t2);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t2, staleQuorum);
        assertFalse(bridge.processed(bridge.transferIdOf(t2)));
    }

    function test_L2_ShrinkingTheSetDoesNotInvalidateALongerValidBundle() public {
        // Grow to 4 validators, threshold 2, then collect 3 signatures.
        _timelock(abi.encodeCall(FerminuxBridge.addValidator, (rogue)));
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 10 ether, 1);
        FerminuxBridge.Signature[] memory three = new FerminuxBridge.Signature[](3);
        three[0] = _sign(k1, t);
        three[1] = _sign(k2, t);
        three[2] = _sign(kRogue, t);

        // The set shrinks below the bundle length — but every signer in it is
        // still current, so the transfer must go through.
        _timelock(abi.encodeCall(FerminuxBridge.removeValidator, (v3)));
        assertEq(bridge.validatorCount(), 3);

        vm.prank(relayer);
        bridge.execute(t, three);
        assertEq(wrmt.balanceOf(bob), 10 ether);
    }

    function test_L2_ArityCeilingIsTheConstantNotTheValidatorCount() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 10 ether, 1);
        uint256 tooMany = bridge.MAX_VALIDATORS() + 1;
        FerminuxBridge.Signature[] memory flood = new FerminuxBridge.Signature[](tooMany);
        for (uint256 i = 0; i < tooMany; i++) {
            flood[i] = _sign(k1, t);
        }
        vm.expectRevert(bytes("BRIDGE: too many signatures"));
        bridge.execute(t, flood);
    }

    // =====================================================================
    // L3 — a matured action cannot be held past its own announcement.
    //      PoC: Attack.t.sol::test_A9
    // =====================================================================

    function test_L3_MaturedActionCannotBeHeldUntilTheAlertHasAgedOut() public {
        assertEq(bridge.GRACE_PERIOD(), 72 hours, "grace period is an operational window, not a fortnight");

        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (1)));
        vm.warp(block.timestamp + DELAY); // matures, no event
        vm.warp(block.timestamp + 72 hours + 1); // owner sits on it

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: action stale"));
        bridge.executeAction(id);
        assertEq(bridge.threshold(), 2, "quorum was never halved");

        // A single validator still cannot deliver anything.
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, outsider, 100 ether, 1);
        FerminuxBridge.Signature[] memory one = _one(k1, t);
        vm.expectRevert(bytes("BRIDGE: not enough signatures"));
        bridge.execute(t, one);
    }

    function test_L3_MaturedActionIsStillExecutableInsideTheWindow() public {
        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        vm.warp(block.timestamp + DELAY + 71 hours);
        vm.prank(owner);
        bridge.executeAction(id);
        assertEq(bridge.threshold(), 3);
    }

    // =====================================================================
    // I1 — value must never cross from a reserved bucket into the unreserved
    //      one through an internal state transition.
    //      PoC: Attack3.t.sol::test_C3
    // =====================================================================

    function test_I1_FeeCollectorCannotBeTheBridgeItself() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        uint256 fees = bridge.accruedFees(address(usdx));
        assertGt(fees, 0);

        vm.prank(owner);
        uint256 id = bridge.queue(abi.encodeCall(FerminuxBridge.setFeeCollector, (address(bridge))));
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: collector is bridge"));
        bridge.executeAction(id);

        assertEq(bridge.feeCollector(), collector);
        assertEq(bridge.accruedFees(address(usdx)), fees);
        assertEq(bridge.surplusOf(address(usdx)), 0, "fees never became surplus");
    }

    function test_I1_RescueCannotTargetTheBridge() public {
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(address(bridge), 5 ether);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: to is bridge"));
        bridge.rescue(address(junk), address(bridge), 5 ether);

        assertEq(junk.balanceOf(address(bridge)), 5 ether);
    }
}
