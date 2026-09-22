// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeTestBase} from "./utils/BridgeTestBase.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {MockERC20, RejectingReceiver, ReentrantReceiver} from "./utils/Mocks.sol";

/// @dev Inbound leg: EIP-712 M-of-N verification, replay protection, inbound
///      rails, and the release/mint split.
contract BridgeExecuteTest is BridgeTestBase {
    uint256 internal constant CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    event Executed(
        bytes32 indexed transferId,
        uint64 indexed srcChainId,
        address indexed localToken,
        address remoteToken,
        address recipient,
        uint256 amount,
        uint256 signatureCount
    );

    /// @dev Put real collateral behind the native bridge so releases have backing.
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

    // ---------------------------------------------------------- happy paths

    function test_Execute_ReleasesNative() public {
        _lockNative(100 ether);
        uint256 locked = bridge.lockedBalance(address(0));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(0), REMOTE_WFMX, bob, 10 ether, 7);
        bytes32 id = bridge.transferIdOf(t);
        uint256 bobBefore = bob.balance;

        vm.expectEmit(true, true, true, true);
        emit Executed(id, REMOTE_CHAIN, address(0), REMOTE_WFMX, bob, 10 ether, 2);
        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        assertEq(bob.balance, bobBefore + 10 ether);
        assertEq(bridge.lockedBalance(address(0)), locked - 10 ether);
        assertTrue(bridge.processed(id));
        assertEq(bridge.inboundUsage(address(0)), 10 ether);
        // no fee is taken on arrival: the recipient gets exactly the signed amount
        assertEq(bridge.accruedFees(address(0)), _fee(100 ether));
    }

    function test_Execute_ReleasesERC20() public {
        _lockUsdx(100 ether);
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 25 ether, 1);

        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        assertEq(usdx.balanceOf(bob), 25 ether);
        assertEq(bridge.lockedBalance(address(usdx)), _net(100 ether) - 25 ether);
    }

    function test_Execute_MintsWrapped() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 30 ether, 1);

        vm.prank(relayer);
        bridge.execute(t, _quorum(t));

        assertEq(wrmt.balanceOf(bob), 30 ether);
        assertEq(wrmt.totalSupply(), 30 ether);
        assertEq(bridge.lockedBalance(address(wrmt)), 0, "wrapped assets are never collateral");
    }

    function test_Execute_IsPermissionless() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        vm.prank(outsider);
        bridge.execute(t, _quorum(t));
        assertEq(wrmt.balanceOf(bob), 1 ether);
    }

    function test_Execute_AcceptsAnyValidPairOfValidators() public {
        FerminuxBridge.BridgeTransfer memory a = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        bridge.execute(a, _sigs(k1, k2, a));

        FerminuxBridge.BridgeTransfer memory b = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 2);
        bridge.execute(b, _sigs(k1, k3, b));

        FerminuxBridge.BridgeTransfer memory c = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 3);
        bridge.execute(c, _sigs(k2, k3, c));

        assertEq(wrmt.balanceOf(bob), 3 ether);
    }

    // ---------------------------------------------------- signature security

    function test_Sig_RejectsNonValidatorSigner() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _sigs(k1, kRogue, t);
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    function test_Sig_RejectsBelowThreshold() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _one(k1, t);
        vm.expectRevert(bytes("BRIDGE: not enough signatures"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RejectsEmptySignatureArray() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        vm.expectRevert(bytes("BRIDGE: not enough signatures"));
        bridge.execute(t, new FerminuxBridge.Signature[](0));
    }

    /// CRITICAL: one validator repeating themselves must never reach quorum.
    function test_Sig_DuplicateSignerCannotReachThreshold() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _sigs(k1, k1, t);
        vm.expectRevert(bytes("BRIDGE: duplicate signer"));
        bridge.execute(t, sigs);

        assertFalse(bridge.processed(bridge.transferIdOf(t)));
        assertEq(wrmt.totalSupply(), 0, "not a single wei may be minted by a repeated signature");
    }

    function test_Sig_DuplicateSignerAtHigherThresholdAlsoFails() public {
        _timelock(abi.encodeCall(FerminuxBridge.setThreshold, (3)));
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);

        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](3);
        sigs[0] = _sign(k1, t);
        sigs[1] = _sign(k1, t);
        sigs[2] = _sign(k1, t);
        vm.expectRevert(bytes("BRIDGE: duplicate signer"));
        bridge.execute(t, sigs);

        // even 2 genuine + 1 repeat cannot fake a 3rd voice
        FerminuxBridge.Signature[] memory mixed = new FerminuxBridge.Signature[](3);
        mixed[0] = _sign(k1, t);
        mixed[1] = _sign(k2, t);
        mixed[2] = _sign(k2, t);
        vm.expectRevert(bytes("BRIDGE: duplicate signer"));
        bridge.execute(t, mixed);

        assertEq(wrmt.totalSupply(), 0);
    }

    function test_Sig_MalleableTwinOfTheSameSignerIsRejected() public {
        // The classic way to forge a "second" signature from one key is to flip
        // s to N-s. The malleability guard kills that before the dedup even runs.
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature memory good = _sign(k1, t);

        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](2);
        sigs[0] = good;
        sigs[1] =
            FerminuxBridge.Signature({v: good.v == 27 ? 28 : 27, r: good.r, s: bytes32(CURVE_ORDER - uint256(good.s))});

        vm.expectRevert(bytes("BRIDGE: malleable signature"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RejectsSignatureFromAnotherChainId() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        bytes32 foreignDigest = _digestForDomain(OTHER_CHAIN, address(bridge), t);

        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](2);
        sigs[0] = _signDigest(k1, foreignDigest);
        sigs[1] = _signDigest(k2, foreignDigest);

        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RejectsSignatureForAnotherBridgeAddress() public {
        FerminuxBridge other = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        bytes32 otherDigest = _digestForDomain(LOCAL_CHAIN, address(other), t);
        assertTrue(otherDigest != bridge.hashTransfer(t));

        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](2);
        sigs[0] = _signDigest(k1, otherDigest);
        sigs[1] = _signDigest(k2, otherDigest);

        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RejectsZeroSignature() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](2);
        sigs[0] = _sign(k1, t);
        sigs[1] = FerminuxBridge.Signature({v: 27, r: bytes32(0), s: bytes32(0)});
        vm.expectRevert(bytes("BRIDGE: invalid signature"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RejectsBadRecoveryId() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature memory good = _sign(k1, t);

        FerminuxBridge.Signature[] memory zeroV = new FerminuxBridge.Signature[](2);
        zeroV[0] = good;
        zeroV[1] = FerminuxBridge.Signature({v: 0, r: good.r, s: good.s});
        vm.expectRevert(bytes("BRIDGE: bad v"));
        bridge.execute(t, zeroV);

        FerminuxBridge.Signature[] memory bigV = new FerminuxBridge.Signature[](2);
        bigV[0] = good;
        bigV[1] = FerminuxBridge.Signature({v: 29, r: good.r, s: good.s});
        vm.expectRevert(bytes("BRIDGE: bad v"));
        bridge.execute(t, bigV);
    }

    function test_Sig_OrderDoesNotMatter() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory reversed = new FerminuxBridge.Signature[](2);
        reversed[0] = _sign(k2, t);
        reversed[1] = _sign(k1, t);
        bridge.execute(t, reversed);
        assertEq(wrmt.balanceOf(bob), 1 ether);
    }

    function test_Sig_AllPermutationsOfAFullQuorumAreAccepted() public {
        _timelock(abi.encodeCall(FerminuxBridge.setThreshold, (3)));

        uint256[6] memory a = [k1, k1, k2, k2, k3, k3];
        uint256[6] memory b = [k2, k3, k1, k3, k1, k2];
        uint256[6] memory c = [k3, k2, k3, k1, k2, k1];

        for (uint64 i = 0; i < 6; i++) {
            FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, i + 1);
            FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](3);
            sigs[0] = _sign(a[i], t);
            sigs[1] = _sign(b[i], t);
            sigs[2] = _sign(c[i], t);
            bridge.execute(t, sigs);
        }
        assertEq(wrmt.balanceOf(bob), 6 ether);
    }

    /// @dev A bundle is judged on the QUORUM it contains, never on what else is in
    ///      it. Three current validators plus one signature from an address that is
    ///      not in the set: the extra is ignored and the transfer executes, because
    ///      the only question `execute` has ever needed answered is "did at least
    ///      `threshold` distinct current validators sign this digest?".
    function test_Sig_ExtraNonValidatorSignatureIsIgnoredNotFatal() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](4);
        sigs[0] = _sign(k1, t);
        sigs[1] = _sign(k2, t);
        sigs[2] = _sign(k3, t);
        sigs[3] = _sign(kRogue, t);

        bridge.execute(t, sigs);

        assertEq(wrmt.balanceOf(bob), 1 ether, "the valid quorum was honoured");
        assertTrue(bridge.processed(bridge.transferIdOf(t)));
    }

    /// @dev Ignoring extras does NOT weaken the threshold: strip the real signers
    ///      out and the same bundle shape is refused, because the count is what is
    ///      counted.
    function test_Sig_ExtrasCannotSubstituteForAQuorum() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        (, uint256 kOther) = makeAddrAndKey("anotherStranger");
        (, uint256 kThird) = makeAddrAndKey("thirdStranger");
        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](4);
        sigs[0] = _sign(k1, t); // one real validator
        sigs[1] = _sign(kRogue, t);
        sigs[2] = _sign(kOther, t);
        sigs[3] = _sign(kThird, t);

        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    /// @dev And a repeated CURRENT validator is still fatal, not merely ignored: a
    ///      duplicate is an attempt to make one vote look like two, and no honest
    ///      relayer produces one.
    function test_Sig_DuplicateStaysFatalEvenAmongIgnorableExtras() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](3);
        sigs[0] = _sign(k1, t);
        sigs[1] = _sign(kRogue, t);
        sigs[2] = _sign(k1, t);

        vm.expectRevert(bytes("BRIDGE: duplicate signer"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RejectsTamperedAmount() public {
        FerminuxBridge.BridgeTransfer memory signedT = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(signedT);

        FerminuxBridge.BridgeTransfer memory tampered = signedT;
        tampered.amount = 90 ether;
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(tampered, sigs);
    }

    function test_Sig_RejectsTamperedRecipient() public {
        FerminuxBridge.BridgeTransfer memory signedT = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(signedT);

        FerminuxBridge.BridgeTransfer memory tampered = signedT;
        tampered.recipient = outsider;
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(tampered, sigs);
    }

    function test_Sig_RemovedValidatorNoLongerCounts() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _sigs(k1, k3, t);

        _timelock(abi.encodeCall(FerminuxBridge.removeValidator, (v3)));

        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
    }

    function test_Sig_RaisedThresholdInvalidatesOldQuorum() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);

        _timelock(abi.encodeCall(FerminuxBridge.setThreshold, (3)));

        vm.expectRevert(bytes("BRIDGE: not enough signatures"));
        bridge.execute(t, sigs);
    }

    function test_Sig_NewValidatorIsAcceptedAfterTimelock() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _sigs(k1, kRogue, t);

        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);

        _timelock(abi.encodeCall(FerminuxBridge.addValidator, (rogue)));
        bridge.execute(t, sigs);
        assertEq(wrmt.balanceOf(bob), 1 ether);
    }

    // -------------------------------------------------------------- replay

    function test_Replay_SameTransferIdRejected() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        bridge.execute(t, sigs);

        vm.expectRevert(bytes("BRIDGE: already processed"));
        bridge.execute(t, sigs);
        assertEq(wrmt.balanceOf(bob), 1 ether);
    }

    function test_Replay_SameNonceFromADifferentChainIsFine() public {
        BridgeToken wother = new BridgeToken("Wrapped Other", "wOTH", 18, address(bridge), OTHER_CHAIN, address(0xDEAD));
        _registerWrapped(address(wother), OTHER_CHAIN, address(0xDEAD), MAX_PER, DAILY);

        FerminuxBridge.BridgeTransfer memory fromRemote = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 42);
        bridge.execute(fromRemote, _quorum(fromRemote));

        FerminuxBridge.BridgeTransfer memory fromOther = FerminuxBridge.BridgeTransfer({
            srcChainId: OTHER_CHAIN,
            dstChainId: LOCAL_CHAIN,
            nonce: 42, // same nonce, different source chain
            srcToken: address(0xDEAD),
            dstToken: address(wother),
            sender: address(0xBEEF),
            recipient: bob,
            amount: 1 ether
        });
        assertTrue(bridge.transferIdOf(fromRemote) != bridge.transferIdOf(fromOther));
        bridge.execute(fromOther, _quorum(fromOther));

        assertEq(wrmt.balanceOf(bob), 1 ether);
        assertEq(wother.balanceOf(bob), 1 ether);
    }

    function test_Replay_DifferentAmountSameNonceIsADifferentTransfer() public view {
        FerminuxBridge.BridgeTransfer memory a = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 5);
        FerminuxBridge.BridgeTransfer memory b = _inbound(address(wrmt), REMOTE_RMT, bob, 2 ether, 5);
        assertTrue(bridge.transferIdOf(a) != bridge.transferIdOf(b));
    }

    // ---------------------------------------------------------- validation

    function test_Execute_RejectsWrongDestinationChain() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        t.dstChainId = OTHER_CHAIN;
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: wrong dst chain"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsSameChainTransfer() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        t.srcChainId = LOCAL_CHAIN;
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: same chain"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsZeroRecipient() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, address(0), 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: zero recipient"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsZeroAmount() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 0, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: zero amount"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsUnregisteredDestinationToken() public {
        MockERC20 stranger = new MockERC20("Stranger", "STR", 18);
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(stranger), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: token not registered"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsWrongSourceChainForToken() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        t.srcChainId = OTHER_CHAIN;
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: bad src chain"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsWrongSourceToken() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), address(0xBAD), bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: token mismatch"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsOverPerTransferCap() public {
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, MAX_PER + 1, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: over per-transfer cap"));
        bridge.execute(t, sigs);
    }

    function test_Execute_RejectsOverInboundDailyCap() public {
        for (uint64 i = 1; i <= 5; i++) {
            FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 100 ether, i);
            bridge.execute(t, _quorum(t));
        }
        assertEq(bridge.inboundUsage(address(wrmt)), DAILY);

        FerminuxBridge.BridgeTransfer memory over = _inbound(address(wrmt), REMOTE_RMT, bob, 1, 6);
        FerminuxBridge.Signature[] memory overSigs = _quorum(over);
        vm.expectRevert(bytes("BRIDGE: over 24h cap"));
        bridge.execute(over, overSigs);
    }

    function test_Execute_InboundWindowIsIndependentOfOutbound() public {
        // burn the whole outbound window on wrmt
        vm.prank(address(bridge));
        wrmt.mint(alice, 500 ether);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
        wrmt.approve(address(bridge), type(uint256).max);
        vm.prank(alice);
            bridge.send(address(wrmt), 100 ether, REMOTE_CHAIN, bob);
        }
        assertEq(bridge.outboundUsage(address(wrmt)), DAILY);

        // inbound still has its full allowance
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 100 ether, 1);
        bridge.execute(t, _quorum(t));
        assertEq(bridge.inboundUsage(address(wrmt)), 100 ether);
    }

    function test_Execute_InboundWindowDecays() public {
        for (uint64 i = 1; i <= 5; i++) {
            FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 100 ether, i);
            bridge.execute(t, _quorum(t));
        }
        vm.warp(block.timestamp + 24 hours);
        assertEq(bridge.inboundUsage(address(wrmt)), 0);

        FerminuxBridge.BridgeTransfer memory later = _inbound(address(wrmt), REMOTE_RMT, bob, 100 ether, 6);
        bridge.execute(later, _quorum(later));
        assertEq(wrmt.balanceOf(bob), 600 ether);
    }

    // ------------------------------------------------------- collateral wall

    function test_Execute_CannotReleaseMoreThanWasLocked() public {
        // fund the bridge with unbacked native (a donation, not a lock)
        vm.deal(address(this), 50 ether);
        (bool ok,) = address(bridge).call{value: 50 ether}("");
        assertTrue(ok);
        assertEq(bridge.lockedBalance(address(0)), 0);

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(0), REMOTE_WFMX, bob, 10 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(); // lockedBalance underflow
        bridge.execute(t, sigs);
        assertEq(address(bridge).balance, 50 ether);
    }

    function test_Execute_CanReleaseExactlyTheLockedAmountAndNoMore() public {
        _lockNative(100 ether);
        uint256 locked = bridge.lockedBalance(address(0));

        FerminuxBridge.BridgeTransfer memory all = _inbound(address(0), REMOTE_WFMX, bob, locked, 1);
        bridge.execute(all, _quorum(all));
        assertEq(bridge.lockedBalance(address(0)), 0);
        // fees remain, but they are not releasable
        assertEq(address(bridge).balance, _fee(100 ether));

        FerminuxBridge.BridgeTransfer memory more = _inbound(address(0), REMOTE_WFMX, bob, 1, 2);
        FerminuxBridge.Signature[] memory moreSigs = _quorum(more);
        vm.expectRevert();
        bridge.execute(more, moreSigs);
    }

    function test_Execute_CanonicalPathNeverMints() public {
        _lockUsdx(100 ether);
        uint256 supplyBefore = usdx.totalSupply();
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(usdx), REMOTE_WUSDX, bob, 10 ether, 1);
        bridge.execute(t, _quorum(t));
        assertEq(usdx.totalSupply(), supplyBefore, "a canonical release must never create supply");
        assertEq(usdx.balanceOf(address(bridge)), 100 ether - 10 ether);
    }

    function test_Execute_WrappedPathNeverTouchesLockedCollateral() public {
        _lockNative(100 ether);
        uint256 lockedBefore = bridge.lockedBalance(address(0));
        uint256 balBefore = address(bridge).balance;

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 10 ether, 1);
        bridge.execute(t, _quorum(t));

        assertEq(bridge.lockedBalance(address(0)), lockedBefore);
        assertEq(address(bridge).balance, balBefore);
        assertEq(bridge.lockedBalance(address(wrmt)), 0);
        assertEq(wrmt.totalSupply(), 10 ether);
    }

    // ------------------------------------------------------- payout failures

    function test_Execute_RevertsWhenNativeRecipientRejects() public {
        _lockNative(100 ether);
        RejectingReceiver r = new RejectingReceiver();
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(0), REMOTE_WFMX, address(r), 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);
        vm.expectRevert(bytes("BRIDGE: native transfer failed"));
        bridge.execute(t, sigs);
        assertFalse(bridge.processed(bridge.transferIdOf(t)));
    }

    function test_Execute_ReentrancyOnNativeReleaseIsBlocked() public {
        _lockNative(100 ether);
        ReentrantReceiver r = new ReentrantReceiver(bridge);

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(0), REMOTE_WFMX, address(r), 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = _quorum(t);

        FerminuxBridge.BridgeTransfer memory second = _inbound(address(0), REMOTE_WFMX, address(r), 1 ether, 2);
        r.arm(second, _quorum(second));

        vm.expectRevert(bytes("BRIDGE: native transfer failed"));
        bridge.execute(t, sigs);
        assertEq(address(r).balance, 0);
    }

    // ----------------------------------------------------------------- fuzz

    function testFuzz_ExecuteMintsExactlyTheSignedAmount(uint96 rawAmount, uint64 nonce) public {
        uint256 amount = bound(uint256(rawAmount), 1, MAX_PER);
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, amount, nonce);
        bridge.execute(t, _quorum(t));
        assertEq(wrmt.balanceOf(bob), amount);
        assertEq(wrmt.totalSupply(), amount);
    }

    function testFuzz_NonValidatorKeysNeverPass(uint256 rawKey) public {
        uint256 key = bound(rawKey, 1, CURVE_ORDER - 1);
        address signer = vm.addr(key);
        vm.assume(!bridge.isValidator(signer));

        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](2);
        sigs[0] = _sign(k1, t);
        sigs[1] = _sign(key, t);
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
    }

    function testFuzz_AnyForeignDomainIsRejected(uint64 foreignChain, address foreignVerifier) public {
        vm.assume(foreignChain != LOCAL_CHAIN || foreignVerifier != address(bridge));
        FerminuxBridge.BridgeTransfer memory t = _inbound(address(wrmt), REMOTE_RMT, bob, 1 ether, 1);
        bytes32 digest = _digestForDomain(foreignChain, foreignVerifier, t);
        vm.assume(digest != bridge.hashTransfer(t));

        FerminuxBridge.Signature[] memory sigs = new FerminuxBridge.Signature[](2);
        sigs[0] = _signDigest(k1, digest);
        sigs[1] = _signDigest(k2, digest);
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridge.execute(t, sigs);
    }
}
