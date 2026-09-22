// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {MockERC20, FeeOnTransferToken, RejectingReceiver} from "./utils/Mocks.sol";
import {
    SilentNoopToken,
    ReflectionToken,
    BurnOnTransferToken,
    SurchargeToken,
    ReentrantWrapper,
    NotABridge,
    WrongIdentityBridge,
    ShortAnswerBridge
} from "./utils/RedTeamMocks.sol";

/**
 * @dev Round-2 regression suite. The independent verifier re-ran all 36 original
 *      proofs against the round-1 remediation, refused to sign off, and wrote up
 *      what was still open. Every test here is one of its items:
 *
 *        A  a reflection/redistributing token could be LOCKED but never RELEASED —
 *           the round-1 settlement check turned a silent-loss bug into a
 *           permanent-lock bug for a whole token class
 *        D  proposeWrapperBridge accepted an EOA, handing the owner a route to
 *           unlimited unbacked wrapped supply
 *        E  adoptWrapper / cancelWrapperBridgeRotation were owner-controlled
 *           arbitrary-address callbacks with no reentrancy guard
 *        F  send()'s self-recipient guard rested on an undocumented assumption
 *           ("deployments are address-identical across chains")
 *
 *      (G was a test-name correction and lives in BridgeRedTeam.t.sol.)
 *
 *      ROUND 3 CHANGED THE ANSWER TO (A). The round-2 remedy was a LOSSY token
 *      class, and the round-3 verifier measured what it cost: the deposit leg
 *      credited whatever the token handed back, so a reflection token settling
 *      its pool during transferFrom credited 1.0 token in as 200.799 out, against
 *      other users' collateral on the counterpart chain. The class is gone. The
 *      A-tests below are rewritten as what they now prove: the same token shapes
 *      are refused on BOTH legs, and the ONE way collateral behind a token that
 *      turned hostile can still come out is the per-transfer, timelocked
 *      short-delivery escape — which is exercised in BridgeShortDelivery.t.sol.
 */
contract BridgeVerifierTest is BridgeTestBase {
    address internal constant REMOTE_RFLX = address(0x4F1);
    address internal constant REMOTE_BURN = address(0x4F2);
    address internal constant REMOTE_SURC = address(0x4F3);
    address internal constant REMOTE_SLNT = address(0x4F4);
    address internal constant REMOTE_FOT = address(0x4F5);
    address internal constant REMOTE_DEAD = address(0x4F6);

    // =====================================================================
    // A — ONE settlement rule, no classes. Exactly the amount leaves the
    //     bridge and exactly the amount lands on the recipient, on every
    //     ordinary payout, with no switch that turns it off. Every shape that
    //     cannot meet it is refused on BOTH legs, loudly and retryably.
    // =====================================================================

    /// @dev The round-3 HIGH, at its root. A reflection token can settle POOLED
    ///      accrual into the bridge during transferFrom, so the measured receipt
    ///      is larger than the deposit. Round 2 credited that measurement, which
    ///      handed the depositor other users' money and made the counterpart chain
    ///      release real collateral against it. There is no measurement to credit
    ///      any more: the deposit is exactly `amount` or it reverts.
    function test_VA_ReflectionDepositCannotCreditMoreThanWasSent() public {
        ReflectionToken rflx = new ReflectionToken();
        _registerCanonical(address(rflx), REMOTE_CHAIN, REMOTE_RFLX, MAX_PER, DAILY);
        // The pool the round-2 deposit leg would have handed over: a fat bridge
        // balance that the token reflects part of back on every transfer.
        rflx.mint(address(bridge), 200 ether);
        rflx.mint(alice, 100 ether);
        vm.prank(alice);
        rflx.approve(address(bridge), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.send(address(rflx), 1 ether, REMOTE_CHAIN, bob);

        assertEq(bridge.lockedBalance(address(rflx)), 0, "not one wei of credit against the pool");
        assertEq(bridge.outboundNonce(), 0, "no Sent for the counterpart chain to fill");
    }

    /// @dev And the release half, for the same token: refused, and refused
    ///      RETRYABLY. The transferId survives, the collateral is not written
    ///      down, the cap is not spent.
    function test_VA_ReflectionReleaseIsRefusedAndNothingIsConsumed() public {
        ReflectionToken rflx = new ReflectionToken();
        _registerCanonical(address(rflx), REMOTE_CHAIN, REMOTE_RFLX, MAX_PER, DAILY);
        rflx.mint(address(bridge), 500 ether);
        // The realistic shape of this incident: the token behaved itself while the
        // collateral went in, and turned the tax on afterwards.
        rflx.setTax(false);
        rflx.mint(alice, 100 ether);
        vm.prank(alice);
        rflx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(rflx), 100 ether, REMOTE_CHAIN, bob);
        rflx.setTax(true);

        uint256 locked = bridge.lockedBalance(address(rflx));
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(rflx), REMOTE_RFLX, bob, 10 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);

        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)), "transferId NOT consumed");
        assertEq(bridge.lockedBalance(address(rflx)), locked, "collateral NOT written down");
        assertEq(bridge.inboundUsage(address(rflx)), 0, "cap NOT consumed");
        assertEq(rflx.balanceOf(bob), 0);
    }

    /// @dev A token that goes dark cannot consume a transferId while paying
    ///      nobody. `paid > 0` is one of the three refusals _settle applies to
    ///      EVERY payout, including the short-delivery escape.
    function test_VA_AReleaseThatMovesNothingIsRefused() public {
        SilentNoopToken slnt = new SilentNoopToken();
        _registerCanonical(address(slnt), REMOTE_CHAIN, REMOTE_SLNT, MAX_PER, DAILY);
        slnt.mint(alice, 100 ether);
        vm.prank(alice);
        slnt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(slnt), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(slnt));

        slnt.goSilent();

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(slnt), REMOTE_SLNT, bob, 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: transfer not settled"));
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)));
        assertEq(bridge.lockedBalance(address(slnt)), locked);
        assertEq(slnt.balanceOf(bob), 0);
    }

    /// @dev The shape the bridge-side read alone is blind to: the bridge IS
    ///      debited, so `paid > 0` passes — and the recipient still gets nothing.
    ///      Only the recipient-side delta catches it.
    function test_VA_ReleaseThatDebitsTheBridgeAndCreditsNobodyIsRefused() public {
        BurnOnTransferToken burn = new BurnOnTransferToken();
        _registerCanonical(address(burn), REMOTE_CHAIN, REMOTE_BURN, MAX_PER, DAILY);
        burn.mint(alice, 100 ether);
        vm.prank(alice);
        burn.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(burn), 100 ether, REMOTE_CHAIN, bob);
        uint256 locked = bridge.lockedBalance(address(burn));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(burn), REMOTE_BURN, bob, 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: transfer not settled"));
        bridge.execute(t, sigs);

        assertEq(burn.balanceOf(bob), 0, "nobody was paid, so nothing may be marked delivered");
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
        assertEq(bridge.lockedBalance(address(burn)), locked);
    }

    /// @dev The solvency rail. A token whose fee lands ON TOP of the amount would
    ///      let each release eat a slice of everybody else's collateral. Refused
    ///      here, and refused again inside the short-delivery escape — see
    ///      BridgeShortDelivery.t.sol.
    function test_VA_ReleaseCannotPayOutMoreThanTheAmountAccountedFor() public {
        SurchargeToken surc = new SurchargeToken();
        _registerCanonical(address(surc), REMOTE_CHAIN, REMOTE_SURC, MAX_PER, DAILY);
        surc.mint(alice, 100 ether);
        vm.prank(alice);
        surc.approve(address(bridge), type(uint256).max);
        // The surcharge lands on the PAYER, so a deposit moves `amount` onto the
        // bridge and takes the extra out of alice — the deposit itself is exact.
        vm.prank(alice);
        surc.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(surc), 100 ether, REMOTE_CHAIN, bob);
        uint256 held = surc.balanceOf(address(bridge));
        uint256 locked = bridge.lockedBalance(address(surc));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(surc), REMOTE_SURC, bob, 50 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.prank(relayer);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.execute(t, sigs);

        assertEq(surc.balanceOf(address(bridge)), held, "not one wei of surcharge came out of the pool");
        assertEq(bridge.lockedBalance(address(surc)), locked);
    }

    /// @dev The rule every well-behaved token meets without noticing it exists.
    function test_VA_APlainTokenSettlesExactlyOnBothLegs() public {
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 100 ether, REMOTE_CHAIN, bob);
        assertEq(usdx.balanceOf(address(bridge)), 100 ether, "exactly the amount was taken");

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 60 ether, 1);
        uint256 before = usdx.balanceOf(address(bridge));
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));
        assertEq(before - usdx.balanceOf(address(bridge)), 60 ether, "exactly the amount left the bridge");
        assertEq(usdx.balanceOf(bob), 60 ether, "exactly the amount reached the recipient");
    }

    /// @dev Both legs fail closed. A token that quietly switches a tax on stops
    ///      taking NEW deposits at the same moment its releases start reverting,
    ///      so no further collateral is trapped behind a broken route. There is no
    ///      declaration that makes the deposit go through any more.
    function test_VA_ATaxingTokenIsRefusedOnDepositForever() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        _registerCanonical(address(fot), REMOTE_CHAIN, REMOTE_FOT, MAX_PER, DAILY);
        fot.mint(alice, 100 ether);
        vm.prank(alice);
        fot.approve(address(bridge), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.send(address(fot), 50 ether, REMOTE_CHAIN, bob);

        assertEq(bridge.lockedBalance(address(fot)), 0, "no collateral trapped behind a broken route");
        assertEq(fot.balanceOf(address(bridge)), 0);
        assertEq(bridge.outboundNonce(), 0, "no Sent emitted for a deposit that did not settle exactly");

        // There is no governance action that changes this answer. The escape
        // hatch is per-INBOUND-TRANSFER and cannot authorise a deposit at all.
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(fot), REMOTE_FOT, bob, 10 ether, 1);
        _allowShortDelivery(t);
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: inexact transfer"));
        bridge.send(address(fot), 50 ether, REMOTE_CHAIN, bob);
        assertEq(fot.balanceOf(address(bridge)), 0);
    }

    /// @dev The LOSSY class is gone from the ABI, not just from the docs: the
    ///      selector no longer exists, so nothing can queue it and no struct field
    ///      records it.
    function test_VA_TheLossyClassIsGoneFromTheAbi() public {
        // setLossyTransfers(address,bool) — the exact selector round 2 shipped.
        bytes4 gone = bytes4(keccak256("setLossyTransfers(address,bool)"));
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: not timelockable"));
        bridge.queue(abi.encodeWithSelector(gone, address(usdx), true));

        // And calling it lands in no function at all: the bridge has no fallback,
        // so the call reverts rather than silently succeeding.
        (bool ok,) = address(bridge).call(abi.encodeWithSelector(gone, address(usdx), true));
        assertFalse(ok, "no such function");
    }

    /// @dev The registry-time half of the answer: the settlement metering is built
    ///      entirely on balanceOf(), so a canonical token that cannot answer it is
    ///      refused at registration instead of at the first release.
    function test_VA_RegisterCanonicalRefusesATokenThatCannotAnswerBalanceOf() public {
        RejectingReceiver notAToken = new RejectingReceiver();
        vm.prank(owner);
        uint256 id = bridge.queue(
            abi.encodeCall(
                FerminuxBridge.registerCanonical, (address(notAToken), REMOTE_CHAIN, REMOTE_DEAD, MAX_PER, DAILY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        vm.expectRevert();
        bridge.executeAction(id);

        assertEq(uint256(bridge.tokenConfig(address(notAToken)).kind), uint256(FerminuxBridge.TokenKind.UNREGISTERED));

        // And an address with no code at all, on the same path.
        _expectTimelockRevert(
            abi.encodeCall(
                FerminuxBridge.registerCanonical, (address(0xC0FFEE), REMOTE_CHAIN, REMOTE_DEAD, MAX_PER, DAILY)
            ),
            bytes("BRIDGE: token not a contract")
        );
    }

    // =====================================================================
    // D — a wrapper's minter seat may only be rotated to a contract that
    //     positively identifies itself as a Ferminux bridge.
    // =====================================================================

    function test_VD_WrapperMinterCannotBeRotatedToAnEOA() public {
        address plainKey = makeAddr("attackerKey");
        assertEq(plainKey.code.length, 0);

        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), plainKey)),
            bytes("BRIDGE: not a bridge")
        );

        assertEq(wrmt.pendingBridge(), address(0), "no offer was ever made");
        assertEq(wrmt.bridge(), address(bridge), "the minter seat did not move");

        // The consequence that is now unreachable: a bare key minting unbacked IOUs.
        vm.prank(plainKey);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        wrmt.mint(plainKey, 1_000_000 ether);
        assertEq(wrmt.totalSupply(), 0);
    }

    function test_VD_WrapperMinterCannotBeRotatedToAContractThatIsNotABridge() public {
        NotABridge stranger = new NotABridge();
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(stranger))),
            bytes("BRIDGE: not a bridge")
        );

        // Having the function is not enough — the answer has to be right.
        WrongIdentityBridge liar = new WrongIdentityBridge();
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(liar))),
            bytes("BRIDGE: not a bridge")
        );

        // Nor is answering with something that is not 32 bytes wide.
        ShortAnswerBridge short_ = new ShortAnswerBridge();
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(short_))),
            bytes("BRIDGE: not a bridge")
        );

        assertEq(wrmt.pendingBridge(), address(0));
    }

    function test_VD_ARealBridgeStillPassesTheIdentityCheck() public {
        FerminuxBridge v2 = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        assertEq(v2.BRIDGE_INTERFACE_ID(), bridge.BRIDGE_INTERFACE_ID());
        assertEq(bridge.BRIDGE_INTERFACE_ID(), keccak256("FerminuxBridge.v1"));

        _timelock(abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(v2))));
        assertEq(wrmt.pendingBridge(), address(v2), "the migration path still works");
    }

    function test_VD_TheBridgeStillRefusesItselfAndTheZeroAddress() public {
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(0))),
            bytes("BRIDGE: zero bridge")
        );
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.proposeWrapperBridge, (address(wrmt), address(bridge))),
            bytes("BRIDGE: same bridge")
        );
    }

    // =====================================================================
    // E — the two owner-controlled rotation callbacks are guarded.
    // =====================================================================

    /// @dev cancelWrapperBridgeRotation calls into an address the owner names and
    ///      is not gated on the codehash pin (a revocation must stay available),
    ///      so the reentrancy guard is the whole defence.
    function test_VE_CancelWrapperBridgeRotationIsNonReentrant() public {
        ReentrantWrapper evil = new ReentrantWrapper(address(bridge));

        // Disarmed: the callback path is genuinely reachable and the call lands.
        vm.prank(owner);
        bridge.cancelWrapperBridgeRotation(address(evil));

        evil.arm(true);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: reentrant"));
        bridge.cancelWrapperBridgeRotation(address(evil));
    }

    /// @dev adoptWrapper gets both guards: the codehash pin makes the callee
    ///      audited BridgeToken code rather than an arbitrary address, and
    ///      nonReentrant holds even if governance has pinned something else.
    function test_VE_AdoptWrapperIsNonReentrant() public {
        ReentrantWrapper evil = new ReentrantWrapper(address(bridge));
        // Governance error, modelled explicitly: the pin is moved off BridgeToken.
        _timelock(abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (address(evil).codehash)));

        vm.prank(owner);
        bridge.adoptWrapper(address(evil)); // disarmed: reaches the callback

        evil.arm(true);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: reentrant"));
        bridge.adoptWrapper(address(evil));
    }

    /// @dev With the pin on the audited wrapper — the normal state of the world —
    ///      adoptWrapper cannot be pointed at an arbitrary address at all.
    function test_VE_AdoptWrapperRefusesAnUnpinnedTarget() public {
        ReentrantWrapper evil = new ReentrantWrapper(address(bridge));
        evil.arm(true);

        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: wrapper not pinned"));
        bridge.adoptWrapper(address(evil));

        // And it fails closed on a bridge that has pinned nothing yet, rather than
        // matching every code-less address (EXTCODEHASH answers 0 for those).
        FerminuxBridge fresh = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: wrapper pin unset"));
        fresh.adoptWrapper(address(0xC0FFEE));
    }

    function test_VE_RotationCallbacksStayOwnerOnly() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.adoptWrapper(address(wrmt));

        vm.prank(outsider);
        vm.expectRevert(bytes("BRIDGE: not owner"));
        bridge.cancelWrapperBridgeRotation(address(wrmt));
    }

    // =====================================================================
    // F — the bad-recipient guard now rests on a recorded fact, not on an
    //     assumption about how the two sides were deployed.
    // =====================================================================

    /// @dev The address that actually destroys the money is the DESTINATION
    ///      bridge. It is recorded per route, and refused at ORIGIN — where the
    ///      user still has their funds.
    function test_VF_SendRefusesTheRemoteBridgeAsRecipient() public {
        assertEq(bridge.remoteBridge(REMOTE_CHAIN), REMOTE_BRIDGE);
        assertTrue(REMOTE_BRIDGE != address(bridge), "the guard does not rely on the two being equal");

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.send{value: 1 ether}(address(0), 1 ether, REMOTE_CHAIN, REMOTE_BRIDGE);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, REMOTE_BRIDGE);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.send(address(wrmt), 1 ether, REMOTE_CHAIN, REMOTE_BRIDGE);

        assertEq(bridge.lockedBalance(address(0)), 0);
        assertEq(bridge.outboundNonce(), 0, "nothing was ever emitted for the far bridge");
    }

    /// @dev Per route, not globally: the guard fires on the bridge for the chain
    ///      being sent to, and a different chain's bridge is an ordinary address.
    function test_VF_TheGuardIsPerRoute() public {
        // OTHER_BRIDGE is the counterpart on chain 56, not on REMOTE_CHAIN, so it
        // is a perfectly ordinary recipient for a REMOTE_CHAIN transfer.
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, OTHER_BRIDGE);
        assertEq(bridge.outboundNonce(), 1);
    }

    /// @dev Fail-closed: a route cannot exist for a chain whose counterpart
    ///      deployment has never been named, so the guard can never be a no-op.
    function test_VF_ARouteCannotBeRegisteredBeforeTheRemoteBridgeIsKnown() public {
        uint64 unknownChain = 137;
        MockERC20 t = new MockERC20("Poly", "POLY", 18);
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(t), unknownChain, address(0xAB), MAX_PER, DAILY)),
            bytes("BRIDGE: remote bridge unset")
        );
        assertEq(bridge.remoteBridge(unknownChain), address(0));

        // Name it, and the same registration goes through.
        _timelock(abi.encodeCall(FerminuxBridge.setRemoteBridge, (unknownChain, address(0xB0B0))));
        _registerCanonical(address(t), unknownChain, address(0xAB), MAX_PER, DAILY);
        assertEq(uint256(bridge.tokenConfig(address(t)).kind), uint256(FerminuxBridge.TokenKind.CANONICAL));
    }

    function test_VF_SetRemoteBridgeIsTimelockedAndValidated() public {
        vm.prank(owner);
        vm.expectRevert(bytes("BRIDGE: timelocked"));
        bridge.setRemoteBridge(REMOTE_CHAIN, address(0xBEEF));

        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.setRemoteBridge, (uint64(0), address(0xBEEF))),
            bytes("BRIDGE: zero remote chain")
        );
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.setRemoteBridge, (LOCAL_CHAIN, address(0xBEEF))),
            bytes("BRIDGE: remote is local")
        );
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.setRemoteBridge, (REMOTE_CHAIN, address(0))), bytes("BRIDGE: zero bridge")
        );
        // Naming OURSELVES would collapse the remote guard into the local one and
        // leave the real counterpart address unrecorded.
        _expectTimelockRevert(
            abi.encodeCall(FerminuxBridge.setRemoteBridge, (REMOTE_CHAIN, address(bridge))),
            bytes("BRIDGE: same bridge")
        );

        assertEq(bridge.remoteBridge(REMOTE_CHAIN), REMOTE_BRIDGE, "unchanged throughout");
    }

    /// @dev A counterpart migration is followable: the guard tracks the new
    ///      address, and the old one becomes an ordinary recipient again.
    function test_VF_RemoteBridgeCanBeRepointedAfterACounterpartMigration() public {
        address remoteV2 = address(0xB2D62);
        _timelock(abi.encodeCall(FerminuxBridge.setRemoteBridge, (REMOTE_CHAIN, remoteV2)));
        assertEq(bridge.remoteBridge(REMOTE_CHAIN), remoteV2);

        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: recipient is bridge"));
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, remoteV2);

        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
        bridge.send(address(usdx), 1 ether, REMOTE_CHAIN, REMOTE_BRIDGE);
        assertEq(bridge.outboundNonce(), 1);
    }
}
