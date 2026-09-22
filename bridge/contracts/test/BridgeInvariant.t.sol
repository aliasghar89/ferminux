// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {MockERC20} from "./utils/Mocks.sol";

/**
 * @dev Stateful handler driving two bridges on two chain ids through random
 *      sequences of sends, relays and time skips. Everything is wrapped in
 *      try/catch so a cap or pause revert just ends that call instead of the run.
 */
contract BridgeHandler is CommonBase, StdUtils {
    uint64 public constant CHAIN_A = 3961;
    uint64 public constant CHAIN_B = 56;

    FerminuxBridge public immutable bridgeA;
    FerminuxBridge public immutable bridgeB;
    MockERC20 public immutable usdxA;
    BridgeToken public immutable wFmxB;
    BridgeToken public immutable wUsdxB;

    uint256 internal immutable k1;
    uint256 internal immutable k2;

    FerminuxBridge.BridgeTransfer[] public toB;
    FerminuxBridge.BridgeTransfer[] public toA;
    uint256 public nextToB;
    uint256 public nextToA;

    uint256 public sends;
    uint256 public relays;

    constructor(
        FerminuxBridge _bridgeA,
        FerminuxBridge _bridgeB,
        MockERC20 _usdxA,
        BridgeToken _wFmxB,
        BridgeToken _wUsdxB,
        uint256 _k1,
        uint256 _k2
    ) {
        bridgeA = _bridgeA;
        bridgeB = _bridgeB;
        usdxA = _usdxA;
        wFmxB = _wFmxB;
        wUsdxB = _wUsdxB;
        k1 = _k1;
        k2 = _k2;
    }

    receive() external payable {}

    function _quorum(FerminuxBridge b, FerminuxBridge.BridgeTransfer memory t)
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

    function _net(FerminuxBridge b, uint256 amount) internal view returns (uint256) {
        return amount - (amount * b.feeBps()) / 10_000;
    }

    // ------------------------------------------------------- A -> B (lock)

    function toBLength() external view returns (uint256) {
        return toB.length;
    }

    function toALength() external view returns (uint256) {
        return toA.length;
    }

    function sendNativeAToB(uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1e12, 10 ether);
        if (address(this).balance < amount) return;
        vm.chainId(CHAIN_A);
        try bridgeA.send{value: amount}(address(0), amount, CHAIN_B, address(this)) returns (bytes32) {
            toB.push(
                FerminuxBridge.BridgeTransfer({
                    srcChainId: CHAIN_A,
                    dstChainId: CHAIN_B,
                    nonce: bridgeA.outboundNonce(),
                    srcToken: address(0),
                    dstToken: address(wFmxB),
                    sender: address(this),
                    recipient: address(this),
                    amount: _net(bridgeA, amount)
                })
            );
            sends++;
        } catch {}
    }

    function sendUsdxAToB(uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1e12, 10 ether);
        if (usdxA.balanceOf(address(this)) < amount) return;
        vm.chainId(CHAIN_A);
        usdxA.approve(address(bridgeA), type(uint256).max);
        try bridgeA.send(address(usdxA), amount, CHAIN_B, address(this)) returns (bytes32) {
            toB.push(
                FerminuxBridge.BridgeTransfer({
                    srcChainId: CHAIN_A,
                    dstChainId: CHAIN_B,
                    nonce: bridgeA.outboundNonce(),
                    srcToken: address(usdxA),
                    dstToken: address(wUsdxB),
                    sender: address(this),
                    recipient: address(this),
                    amount: _net(bridgeA, amount)
                })
            );
            sends++;
        } catch {}
    }

    // ------------------------------------------------------ B -> A (burn)

    function sendWrappedFmxBToA(uint96 rawAmount) external {
        uint256 balance = wFmxB.balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, balance);
        vm.chainId(CHAIN_B);
        try bridgeB.send(address(wFmxB), amount, CHAIN_A, address(this)) returns (bytes32) {
            toA.push(
                FerminuxBridge.BridgeTransfer({
                    srcChainId: CHAIN_B,
                    dstChainId: CHAIN_A,
                    nonce: bridgeB.outboundNonce(),
                    srcToken: address(wFmxB),
                    dstToken: address(0),
                    sender: address(this),
                    recipient: address(this),
                    amount: _net(bridgeB, amount)
                })
            );
            sends++;
        } catch {}
    }

    function sendWrappedUsdxBToA(uint96 rawAmount) external {
        uint256 balance = wUsdxB.balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, balance);
        vm.chainId(CHAIN_B);
        try bridgeB.send(address(wUsdxB), amount, CHAIN_A, address(this)) returns (bytes32) {
            toA.push(
                FerminuxBridge.BridgeTransfer({
                    srcChainId: CHAIN_B,
                    dstChainId: CHAIN_A,
                    nonce: bridgeB.outboundNonce(),
                    srcToken: address(wUsdxB),
                    dstToken: address(usdxA),
                    sender: address(this),
                    recipient: address(this),
                    amount: _net(bridgeB, amount)
                })
            );
            sends++;
        } catch {}
    }

    // ------------------------------------------------------------- relaying

    function executeOnB(uint256 seed) external {
        if (nextToB >= toB.length) return;
        uint256 idx = bound(seed, nextToB, toB.length - 1);
        FerminuxBridge.BridgeTransfer memory t = toB[idx];
        vm.chainId(CHAIN_B);
        try bridgeB.execute(t, _quorum(bridgeB, t)) {
            toB[idx] = toB[nextToB];
            nextToB++;
            relays++;
        } catch {}
    }

    function executeOnA(uint256 seed) external {
        if (nextToA >= toA.length) return;
        uint256 idx = bound(seed, nextToA, toA.length - 1);
        FerminuxBridge.BridgeTransfer memory t = toA[idx];
        vm.chainId(CHAIN_A);
        try bridgeA.execute(t, _quorum(bridgeA, t)) {
            toA[idx] = toA[nextToA];
            nextToA++;
            relays++;
        } catch {}
    }

    function skipTime(uint32 rawSeconds) external {
        vm.warp(block.timestamp + bound(uint256(rawSeconds), 1, 48 hours));
    }
}

/**
 * @dev THE bridge invariant: the wrapped supply on the destination chain can
 *      never exceed the collateral locked on the origin chain, no matter what
 *      order random sends and relays happen in.
 */
contract BridgeInvariantTest is Test {
    uint64 internal constant CHAIN_A = 3961;
    uint64 internal constant CHAIN_B = 56;
    uint256 internal constant FEE_BPS = 10;
    uint64 internal constant DELAY = 48 hours;
    uint256 internal constant MAX_PER = 100 ether;
    uint256 internal constant DAILY = 100_000 ether;

    FerminuxBridge internal bridgeA;
    FerminuxBridge internal bridgeB;
    MockERC20 internal usdxA;
    BridgeToken internal wFmxB;
    BridgeToken internal wUsdxB;
    BridgeHandler internal handler;

    address internal owner = makeAddr("ownerMultisig");
    address internal collector = makeAddr("feeCollector");
    address internal pauser = makeAddr("pauserKey");

    uint256 internal usdxInitialSupply;

    function setUp() public {
        vm.warp(1_700_000_000);
        (address v1, uint256 k1) = makeAddrAndKey("validator1");
        (address v2, uint256 k2) = makeAddrAndKey("validator2");
        (address v3,) = makeAddrAndKey("validator3");

        address[] memory set = new address[](3);
        set[0] = v1;
        set[1] = v2;
        set[2] = v3;

        vm.chainId(CHAIN_A);
        bridgeA = new FerminuxBridge(owner, set, 2, collector, FEE_BPS, DELAY, pauser);
        usdxA = new MockERC20("USD Example", "USDX", 18);

        vm.chainId(CHAIN_B);
        bridgeB = new FerminuxBridge(owner, set, 2, collector, FEE_BPS, DELAY, pauser);
        wFmxB = new BridgeToken("Wrapped FMX", "wFMX", 18, address(bridgeB), CHAIN_A, address(0));
        wUsdxB = new BridgeToken("Wrapped USDX", "wUSDX", 18, address(bridgeB), CHAIN_A, address(usdxA));

        // registerWrapped fails closed until the wrapper bytecode is pinned.
        vm.chainId(CHAIN_B);
        _tl(bridgeB, abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (keccak256(type(BridgeToken).runtimeCode))));

        // Each side must know the other's deployment address before any route can
        // be registered against it.
        vm.chainId(CHAIN_A);
        _tl(bridgeA, abi.encodeCall(FerminuxBridge.setRemoteBridge, (CHAIN_B, address(bridgeB))));
        vm.chainId(CHAIN_B);
        _tl(bridgeB, abi.encodeCall(FerminuxBridge.setRemoteBridge, (CHAIN_A, address(bridgeA))));

        vm.chainId(CHAIN_A);
        _tl(
            bridgeA,
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(0), CHAIN_B, address(wFmxB), MAX_PER, DAILY))
        );
        _tl(
            bridgeA,
            abi.encodeCall(FerminuxBridge.registerCanonical, (address(usdxA), CHAIN_B, address(wUsdxB), MAX_PER, DAILY))
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

        handler = new BridgeHandler(bridgeA, bridgeB, usdxA, wFmxB, wUsdxB, k1, k2);
        vm.deal(address(handler), 10_000 ether);
        usdxA.mint(address(handler), 10_000 ether);
        usdxInitialSupply = usdxA.totalSupply();

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = BridgeHandler.sendNativeAToB.selector;
        selectors[1] = BridgeHandler.sendUsdxAToB.selector;
        selectors[2] = BridgeHandler.sendWrappedFmxBToA.selector;
        selectors[3] = BridgeHandler.sendWrappedUsdxBToA.selector;
        selectors[4] = BridgeHandler.executeOnB.selector;
        selectors[5] = BridgeHandler.executeOnA.selector;
        selectors[6] = BridgeHandler.skipTime.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _tl(FerminuxBridge b, bytes memory data) internal {
        vm.prank(owner);
        uint256 id = b.queue(data);
        vm.warp(block.timestamp + b.timelockDelay());
        vm.prank(owner);
        b.executeAction(id);
    }

    // ------------------------------------------------------------ invariants

    /// THE bridge invariant.
    function invariant_WrappedSupplyNeverExceedsLockedCollateral() public view {
        assertLe(wFmxB.totalSupply(), bridgeA.lockedBalance(address(0)), "wFMX minted beyond the FMX locked on chain A");
        assertLe(
            wUsdxB.totalSupply(),
            bridgeA.lockedBalance(address(usdxA)),
            "wUSDX minted beyond the USDX locked on chain A"
        );
    }

    /// The bridge always holds at least what it owes.
    function invariant_BridgeIsSolvent() public view {
        assertGe(address(bridgeA).balance, bridgeA.lockedBalance(address(0)) + bridgeA.accruedFees(address(0)));
        assertGe(
            usdxA.balanceOf(address(bridgeA)),
            bridgeA.lockedBalance(address(usdxA)) + bridgeA.accruedFees(address(usdxA))
        );
    }

    /// Nothing donates to this deployment, so solvency is exact — every wei the
    /// bridge holds is either collateral or an accrued fee.
    function invariant_NoUnexplainedBalance() public view {
        assertEq(address(bridgeA).balance, bridgeA.lockedBalance(address(0)) + bridgeA.accruedFees(address(0)));
        assertEq(
            usdxA.balanceOf(address(bridgeA)),
            bridgeA.lockedBalance(address(usdxA)) + bridgeA.accruedFees(address(usdxA))
        );
    }

    /// A wrapper is never collateral: execute() can only mint it, never release it.
    function invariant_WrappedTokensAreNeverCollateral() public view {
        assertEq(bridgeB.lockedBalance(address(wFmxB)), 0);
        assertEq(bridgeB.lockedBalance(address(wUsdxB)), 0);
        assertEq(bridgeB.accruedFees(address(0)), 0, "chain B never locked native here");
        assertEq(bridgeB.lockedBalance(address(0)), 0);
    }

    /// A canonical asset's supply is never touched by the bridge — it can only
    /// ever be moved into or out of custody.
    function invariant_CanonicalSupplyIsUntouched() public view {
        assertEq(usdxA.totalSupply(), usdxInitialSupply);
    }

    /// Exact conservation: the collateral locked on A backs, at every instant,
    /// (a) the wrapped supply on B, (b) transfers on their way to B that have
    /// not been minted yet, and (c) burned wrappers on their way home that have
    /// not been released yet. Nothing else, ever.
    function invariant_LockedEqualsWrappedPlusInFlight() public view {
        uint256 inFlightToB;
        uint256 lenB = handler.toBLength();
        for (uint256 i = handler.nextToB(); i < lenB; i++) {
            (,,,, address dstToken,,, uint256 amount) = handler.toB(i);
            if (dstToken == address(wFmxB)) inFlightToB += amount;
        }
        uint256 inFlightToA;
        uint256 lenA = handler.toALength();
        for (uint256 i = handler.nextToA(); i < lenA; i++) {
            (,,, address srcToken,,,, uint256 amount) = handler.toA(i);
            if (srcToken == address(wFmxB)) inFlightToA += amount;
        }
        assertEq(bridgeA.lockedBalance(address(0)), wFmxB.totalSupply() + inFlightToB + inFlightToA);
    }

    /// Guards against a vacuous suite: if the handler never actually moved
    /// anything, every invariant above would be trivially true.
    function afterInvariant() public view {
        assertGt(handler.sends(), 0, "handler completed no sends - invariants would be vacuous");
    }
}
