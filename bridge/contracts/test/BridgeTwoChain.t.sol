// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {MockERC20} from "./utils/Mocks.sol";

/**
 * @dev Full two-chain simulation inside one test process.
 *
 *      CHAIN A = 3961 (Ferminux)            CHAIN B = 56 (a remote EVM)
 *        bridgeA                              bridgeB
 *        FMX      CANONICAL  <------------->  wFMX   WRAPPED
 *        USDX     CANONICAL  <------------->  wUSDX  WRAPPED
 *        wBNB     WRAPPED    <------------->  BNB    CANONICAL (native there)
 *
 *      vm.chainId() switches which chain we are "on"; every signature is a real
 *      secp256k1 signature over the real EIP-712 digest of the bridge that will
 *      consume it. Value moves both ways and is asserted to be conserved.
 */
contract BridgeTwoChainTest is Test {
    uint64 internal constant CHAIN_A = 3961;
    uint64 internal constant CHAIN_B = 56;
    uint256 internal constant FEE_BPS = 10;
    uint64 internal constant DELAY = 48 hours;
    uint256 internal constant MAX_PER = 1_000 ether;
    uint256 internal constant DAILY = 10_000 ether;

    FerminuxBridge internal bridgeA;
    FerminuxBridge internal bridgeB;

    MockERC20 internal usdxA; // canonical on A
    BridgeToken internal wUsdxB; // its wrapper on B
    BridgeToken internal wFmxB; // wrapper for A's native coin, on B
    BridgeToken internal wBnbA; // wrapper for B's native coin, on A

    address internal owner = makeAddr("ownerMultisig");
    address internal collector = makeAddr("feeCollector");
    address internal pauser = makeAddr("pauserKey");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    address internal v1;
    address internal v2;
    address internal v3;
    uint256 internal k1;
    uint256 internal k2;
    uint256 internal k3;

    function setUp() public {
        vm.warp(1_700_000_000);
        (v1, k1) = makeAddrAndKey("validator1");
        (v2, k2) = makeAddrAndKey("validator2");
        (v3, k3) = makeAddrAndKey("validator3");

        address[] memory set = new address[](3);
        set[0] = v1;
        set[1] = v2;
        set[2] = v3;

        // ---- chain A
        vm.chainId(CHAIN_A);
        bridgeA = new FerminuxBridge(owner, set, 2, collector, FEE_BPS, DELAY, pauser);
        usdxA = new MockERC20("USD Example", "USDX", 18);

        // ---- chain B
        vm.chainId(CHAIN_B);
        bridgeB = new FerminuxBridge(owner, set, 2, collector, FEE_BPS, DELAY, pauser);
        wFmxB = new BridgeToken("Wrapped FMX", "wFMX", 18, address(bridgeB), CHAIN_A, address(0));
        wUsdxB = new BridgeToken("Wrapped USDX", "wUSDX", 18, address(bridgeB), CHAIN_A, address(usdxA));

        // ---- B's native coin wrapper lives on A
        vm.chainId(CHAIN_A);
        wBnbA = new BridgeToken("Wrapped BNB", "wBNB", 18, address(bridgeA), CHAIN_B, address(0));

        // ---- pin the wrapper bytecode on both sides: registerWrapped fails
        //      closed until the bridge knows which code a wrapper must have.
        bytes32 wrapperCodehash = keccak256(type(BridgeToken).runtimeCode);
        vm.chainId(CHAIN_A);
        _tl(bridgeA, abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (wrapperCodehash)));
        vm.chainId(CHAIN_B);
        _tl(bridgeB, abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (wrapperCodehash)));

        // ---- each side records the OTHER side's deployment address. Mandatory
        //      before any route may be registered, and the two addresses are
        //      genuinely different here — nothing is assumed to be identical.
        vm.chainId(CHAIN_A);
        _tl(bridgeA, abi.encodeCall(FerminuxBridge.setRemoteBridge, (CHAIN_B, address(bridgeB))));
        vm.chainId(CHAIN_B);
        _tl(bridgeB, abi.encodeCall(FerminuxBridge.setRemoteBridge, (CHAIN_A, address(bridgeA))));

        // ---- registries (each side is the mirror of the other)
        vm.chainId(CHAIN_A);
        _tl(
            bridgeA,
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(0), CHAIN_B, address(wFmxB), MAX_PER, DAILY))
        );
        _tl(
            bridgeA,
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(usdxA), CHAIN_B, address(wUsdxB), MAX_PER, DAILY))
        );
        _tl(
            bridgeA,
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(wBnbA), CHAIN_B, address(0), MAX_PER, DAILY))
        );

        vm.chainId(CHAIN_B);
        _tl(
            bridgeB,
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(wFmxB), CHAIN_A, address(0), MAX_PER, DAILY))
        );
        _tl(
            bridgeB,
            abi.encodeCall(FerminuxBridge.registerWrapped, (address(wUsdxB), CHAIN_A, address(usdxA), MAX_PER, DAILY))
        );
        _tl(
            bridgeB,
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(0), CHAIN_A, address(wBnbA), MAX_PER, DAILY))
        );

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        usdxA.mint(alice, 1_000 ether);

        vm.chainId(CHAIN_A);
        vm.prank(alice);
        usdxA.approve(address(bridgeA), type(uint256).max);
    }

    // ------------------------------------------------------------- plumbing

    function _tl(FerminuxBridge b, bytes memory data) internal {
        vm.prank(owner);
        uint256 id = b.queue(data);
        vm.warp(block.timestamp + b.timelockDelay());
        vm.prank(owner);
        b.executeAction(id);
    }

    function _send(
        FerminuxBridge b,
        uint64 srcChain,
        uint64 dstChain,
        address from,
        address localToken,
        uint256 amount,
        address recipient
    ) internal returns (FerminuxBridge.BridgeTransfer memory t) {
        vm.chainId(srcChain);
        address remoteToken = b.tokenConfig(localToken).remoteToken;
        uint256 net = amount - (amount * b.feeBps()) / 10_000;

        _approveIfWrapped(b, from, localToken, amount);

        vm.prank(from);
        if (localToken == address(0)) {
            b.send{value: amount}(localToken, amount, dstChain, recipient);
        } else {
            b.send(localToken, amount, dstChain, recipient);
        }

        t = FerminuxBridge.BridgeTransfer({
            srcChainId: srcChain,
            dstChainId: dstChain,
            nonce: b.outboundNonce(),
            srcToken: localToken,
            dstToken: remoteToken,
            sender: from,
            recipient: recipient,
            amount: net
        });
    }

    /// @dev Bridging a WRAPPED balance back burns it, and the wrapper's burn()
    ///      consumes the holder's allowance. So the return leg is a two-step —
    ///      approve, then send — the same shape the outbound leg already has for
    ///      a canonical ERC20 (alice's approve in setUp). Only the native coin
    ///      needs no approval, because it arrives as msg.value.
    function _approveIfWrapped(FerminuxBridge b, address from, address localToken, uint256 amount) internal {
        if (b.tokenConfig(localToken).kind != FerminuxBridge.TokenKind.WRAPPED) return;
        vm.prank(from);
        BridgeToken(localToken).approve(address(b), amount);
    }

    function _relay(FerminuxBridge dst, uint64 dstChain, FerminuxBridge.BridgeTransfer memory t) internal {
        vm.chainId(dstChain);
        dst.execute(t, _quorumFor(dst, t));
    }

    function _quorumFor(FerminuxBridge b, FerminuxBridge.BridgeTransfer memory t)
        internal
        view
        returns (FerminuxBridge.Signature[] memory sigs)
    {
        bytes32 digest = b.hashTransfer(t);
        sigs = new FerminuxBridge.Signature[](2);
        (uint8 va, bytes32 ra, bytes32 sa) = vm.sign(k1, digest);
        (uint8 vb, bytes32 rb, bytes32 sb) = vm.sign(k2, digest);
        sigs[0] = FerminuxBridge.Signature({v: va, r: ra, s: sa});
        sigs[1] = FerminuxBridge.Signature({v: vb, r: rb, s: sb});
    }

    function _fee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    // ----------------------------------------------------------- native A->B

    function test_TwoChain_NativeFmxCrossesAndIsBacked() public {
        uint256 gross = 100 ether;
        FerminuxBridge.BridgeTransfer memory t = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), gross, bob);

        assertEq(bridgeA.lockedBalance(address(0)), gross - _fee(gross));
        assertEq(bridgeA.accruedFees(address(0)), _fee(gross));
        assertEq(wFmxB.totalSupply(), 0, "nothing minted until the transfer is executed");

        _relay(bridgeB, CHAIN_B, t);

        assertEq(wFmxB.balanceOf(bob), gross - _fee(gross));
        assertEq(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)), "wrapped supply == locked collateral");
    }

    function test_TwoChain_RoundTripConservesValueExactly() public {
        uint256 gross = 100 ether;
        uint256 aliceStart = alice.balance;

        // A -> B
        FerminuxBridge.BridgeTransfer memory out = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), gross, bob);
        _relay(bridgeB, CHAIN_B, out);
        uint256 onB = wFmxB.balanceOf(bob);
        assertEq(onB, gross - _fee(gross));

        // B -> A, all of it
        FerminuxBridge.BridgeTransfer memory back = _send(bridgeB, CHAIN_B, CHAIN_A, bob, address(wFmxB), onB, alice);
        _relay(bridgeA, CHAIN_A, back);

        uint256 returned = back.amount;
        uint256 feeA = _fee(gross);
        uint256 feeB = _fee(onB);

        // alice got back everything except the two origin fees
        assertEq(alice.balance, aliceStart - gross + returned);
        assertEq(returned, gross - feeA - feeB);

        // every wei is accounted for: user + fee on A + fee on B
        assertEq(returned + feeA + feeB, gross, "conservation: amount in == amount out + fees");

        // the fee taken on B lives as wrapped supply, still fully collateralised on A
        assertEq(wFmxB.totalSupply(), feeB);
        assertEq(bridgeA.lockedBalance(address(0)), feeB);
        assertEq(bridgeA.accruedFees(address(0)), feeA);
        assertEq(address(bridgeA).balance, feeA + feeB);
    }

    function test_TwoChain_ERC20CrossesAndReturns() public {
        uint256 gross = 200 ether;
        FerminuxBridge.BridgeTransfer memory out = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(usdxA), gross, bob);
        _relay(bridgeB, CHAIN_B, out);
        assertEq(wUsdxB.balanceOf(bob), gross - _fee(gross));
        assertEq(wUsdxB.totalSupply(), bridgeA.lockedBalance(address(usdxA)));

        uint256 onB = wUsdxB.balanceOf(bob);
        FerminuxBridge.BridgeTransfer memory back = _send(bridgeB, CHAIN_B, CHAIN_A, bob, address(wUsdxB), onB, carol);
        _relay(bridgeA, CHAIN_A, back);

        assertEq(usdxA.balanceOf(carol), back.amount);
        assertEq(wUsdxB.totalSupply(), bridgeA.lockedBalance(address(usdxA)), "still exactly backed");
        assertEq(
            usdxA.balanceOf(address(bridgeA)),
            bridgeA.lockedBalance(address(usdxA)) + bridgeA.accruedFees(address(usdxA))
        );
    }

    function test_TwoChain_ReverseDirectionNativeOnB() public {
        // B's native coin is canonical on B and wrapped on A — the mirror image.
        uint256 gross = 60 ether;
        FerminuxBridge.BridgeTransfer memory out = _send(bridgeB, CHAIN_B, CHAIN_A, carol, address(0), gross, alice);
        _relay(bridgeA, CHAIN_A, out);

        assertEq(wBnbA.balanceOf(alice), gross - _fee(gross));
        assertEq(wBnbA.totalSupply(), bridgeB.lockedBalance(address(0)));
        assertEq(bridgeA.lockedBalance(address(wBnbA)), 0, "a wrapper is never collateral");

        uint256 onA = wBnbA.balanceOf(alice);
        FerminuxBridge.BridgeTransfer memory back = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(wBnbA), onA, bob);
        uint256 bobBefore = bob.balance;
        _relay(bridgeB, CHAIN_B, back);

        assertEq(bob.balance, bobBefore + back.amount);
        assertEq(wBnbA.totalSupply(), bridgeB.lockedBalance(address(0)));
    }

    function test_TwoChain_BothDirectionsAtOnce() public {
        FerminuxBridge.BridgeTransfer memory aToB = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), 100 ether, bob);
        FerminuxBridge.BridgeTransfer memory bToA = _send(bridgeB, CHAIN_B, CHAIN_A, carol, address(0), 70 ether, alice);

        _relay(bridgeB, CHAIN_B, aToB);
        _relay(bridgeA, CHAIN_A, bToA);

        assertEq(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)));
        assertEq(wBnbA.totalSupply(), bridgeB.lockedBalance(address(0)));
    }

    // ------------------------------------------------- cross-chain isolation

    function test_TwoChain_SignatureForBIsWorthlessOnA() public {
        // A transfer whose destination is A, but signed against B's domain.
        FerminuxBridge.BridgeTransfer memory t = FerminuxBridge.BridgeTransfer({
            srcChainId: CHAIN_B,
            dstChainId: CHAIN_A,
            nonce: 1,
            srcToken: address(0),
            dstToken: address(wBnbA),
            sender: carol,
            recipient: alice,
            amount: 1 ether
        });

        vm.chainId(CHAIN_B);
        FerminuxBridge.Signature[] memory forB = _quorumFor(bridgeB, t);

        vm.chainId(CHAIN_A);
        vm.expectRevert(bytes("BRIDGE: below threshold"));
        bridgeA.execute(t, forB);
    }

    function test_TwoChain_TransferExecutedOnBCannotAlsoRunOnA() public {
        FerminuxBridge.BridgeTransfer memory t = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), 10 ether, bob);
        _relay(bridgeB, CHAIN_B, t);

        vm.chainId(CHAIN_A);
        FerminuxBridge.Signature[] memory sigs = _quorumFor(bridgeA, t);
        vm.expectRevert(bytes("BRIDGE: wrong dst chain"));
        bridgeA.execute(t, sigs);
    }

    function test_TwoChain_ReplayOnTheCorrectChainStillFails() public {
        FerminuxBridge.BridgeTransfer memory t = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), 10 ether, bob);
        _relay(bridgeB, CHAIN_B, t);

        vm.chainId(CHAIN_B);
        FerminuxBridge.Signature[] memory sigs = _quorumFor(bridgeB, t);
        vm.expectRevert(bytes("BRIDGE: already processed"));
        bridgeB.execute(t, sigs);
    }

    function test_TwoChain_NoncesAreIndependentPerBridge() public {
        _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), 1 ether, bob);
        _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), 1 ether, bob);
        _send(bridgeB, CHAIN_B, CHAIN_A, carol, address(0), 1 ether, alice);

        assertEq(bridgeA.outboundNonce(), 2);
        assertEq(bridgeB.outboundNonce(), 1);
    }

    function test_TwoChain_PauseOnOneSideDoesNotPauseTheOther() public {
        vm.chainId(CHAIN_A);
        vm.prank(pauser);
        bridgeA.pause();

        vm.chainId(CHAIN_A);
        vm.prank(alice);
        vm.expectRevert(bytes("BRIDGE: paused"));
        bridgeA.send{value: 1 ether}(address(0), 1 ether, CHAIN_B, bob);

        // B keeps running
        FerminuxBridge.BridgeTransfer memory t = _send(bridgeB, CHAIN_B, CHAIN_A, carol, address(0), 1 ether, alice);
        assertEq(bridgeB.lockedBalance(address(0)), 1 ether - _fee(1 ether));
        assertEq(t.dstChainId, CHAIN_A);
    }

    function test_TwoChain_InFlightTransferSurvivesAPauseAndResumes() public {
        FerminuxBridge.BridgeTransfer memory t = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), 10 ether, bob);

        vm.chainId(CHAIN_B);
        vm.prank(pauser);
        bridgeB.pause();
        FerminuxBridge.Signature[] memory sigs = _quorumFor(bridgeB, t);
        vm.expectRevert(bytes("BRIDGE: paused"));
        bridgeB.execute(t, sigs);

        vm.prank(owner);
        bridgeB.unpause();
        bridgeB.execute(t, sigs);
        assertEq(wFmxB.balanceOf(bob), t.amount);
    }

    // -------------------------------------------------------------- fuzzing

    function testFuzz_TwoChainRoundTripNeverCreatesValue(uint96 rawAmount) public {
        uint256 gross = bound(uint256(rawAmount), 1 ether, MAX_PER);
        vm.deal(alice, gross);

        FerminuxBridge.BridgeTransfer memory out = _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), gross, bob);
        _relay(bridgeB, CHAIN_B, out);
        uint256 onB = wFmxB.balanceOf(bob);

        FerminuxBridge.BridgeTransfer memory back = _send(bridgeB, CHAIN_B, CHAIN_A, bob, address(wFmxB), onB, alice);
        _relay(bridgeA, CHAIN_A, back);

        assertEq(back.amount + _fee(gross) + _fee(onB), gross, "no value created or destroyed");
        assertLe(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)) + 0);
        assertEq(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)));
        assertEq(address(bridgeA).balance, bridgeA.lockedBalance(address(0)) + bridgeA.accruedFees(address(0)));
    }

    function testFuzz_WrappedSupplyNeverExceedsLockedCollateral(uint96 a, uint96 b, uint96 c) public {
        uint256[3] memory amounts = [
            bound(uint256(a), 1 ether, 100 ether),
            bound(uint256(b), 1 ether, 100 ether),
            bound(uint256(c), 1 ether, 100 ether)
        ];
        vm.deal(alice, 1_000 ether);

        for (uint256 i = 0; i < 3; i++) {
            FerminuxBridge.BridgeTransfer memory t =
                _send(bridgeA, CHAIN_A, CHAIN_B, alice, address(0), amounts[i], bob);
            // the invariant must hold BEFORE the mint (in flight) and after it
            assertLe(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)));
            _relay(bridgeB, CHAIN_B, t);
            assertLe(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)));
        }
        assertEq(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)));
    }
}
