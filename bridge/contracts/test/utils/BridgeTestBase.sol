// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxBridge} from "../../src/FerminuxBridge.sol";
import {BridgeToken} from "../../src/BridgeToken.sol";
import {MockERC20} from "./Mocks.sol";

/**
 * @dev Shared fixture: one bridge on the "local" chain (3961, mimicking Ferminux)
 *      talking to a single remote chain (1). Three assets are registered:
 *
 *        address(0)  CANONICAL native FMX  <-> remote wFMX  at REMOTE_WFMX
 *        usdx        CANONICAL ERC-20      <-> remote wUSDX at REMOTE_WUSDX
 *        wrmt        WRAPPED   BridgeToken <-> remote RMT   at REMOTE_RMT
 *
 *      Validator set is 2-of-3 with real keys, so every signature in the suite
 *      is a genuine secp256k1 signature over the real EIP-712 digest.
 */
abstract contract BridgeTestBase is Test {
    uint64 internal constant LOCAL_CHAIN = 3961;
    uint64 internal constant REMOTE_CHAIN = 1;
    uint64 internal constant OTHER_CHAIN = 56;

    uint256 internal constant FEE_BPS = 10; // 0.10 %
    uint64 internal constant DELAY = 48 hours;
    uint256 internal constant MAX_PER = 100 ether;
    uint256 internal constant DAILY = 500 ether;

    address internal constant REMOTE_WFMX = address(0xF1F1);
    address internal constant REMOTE_WUSDX = address(0xF2F2);
    address internal constant REMOTE_RMT = address(0xF3F3);

    /// @dev The counterpart bridge deployments, as this chain records them.
    ///      Deliberately NOT this bridge's address: nothing about the two sides is
    ///      address-identical, and send()'s guard must hold anyway.
    address internal constant REMOTE_BRIDGE = address(0xB1D6E);
    address internal constant OTHER_BRIDGE = address(0xB1D65);

    FerminuxBridge internal bridge;
    MockERC20 internal usdx;
    BridgeToken internal wrmt;

    address internal owner = makeAddr("ownerMultisig");
    address internal pauser = makeAddr("pauserKey");
    address internal collector = makeAddr("feeCollector");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");
    address internal outsider = makeAddr("outsider");

    address internal v1;
    address internal v2;
    address internal v3;
    uint256 internal k1;
    uint256 internal k2;
    uint256 internal k3;
    address internal rogue;
    uint256 internal kRogue;

    function setUp() public virtual {
        vm.chainId(LOCAL_CHAIN);
        vm.warp(1_700_000_000); // a realistic epoch so window math is not near zero

        (v1, k1) = makeAddrAndKey("validator1");
        (v2, k2) = makeAddrAndKey("validator2");
        (v3, k3) = makeAddrAndKey("validator3");
        (rogue, kRogue) = makeAddrAndKey("rogueValidator");

        bridge = new FerminuxBridge(owner, _validatorSet(), 2, collector, FEE_BPS, DELAY, pauser);

        usdx = new MockERC20("USD Example", "USDX", 18);
        wrmt = new BridgeToken("Wrapped RMT", "wRMT", 18, address(bridge), REMOTE_CHAIN, REMOTE_RMT);

        _pinBridgeToken(bridge);
        // No route may be registered for a chain whose counterpart bridge address
        // is unknown — send()'s bad-recipient guard depends on it.
        _setRemoteBridge(bridge, REMOTE_CHAIN, REMOTE_BRIDGE);
        _setRemoteBridge(bridge, OTHER_CHAIN, OTHER_BRIDGE);
        _registerCanonical(address(0), REMOTE_CHAIN, REMOTE_WFMX, MAX_PER, DAILY);
        _registerCanonical(address(usdx), REMOTE_CHAIN, REMOTE_WUSDX, MAX_PER, DAILY);
        _registerWrapped(address(wrmt), REMOTE_CHAIN, REMOTE_RMT, MAX_PER, DAILY);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        usdx.mint(alice, 1_000 ether);
        vm.prank(alice);
        usdx.approve(address(bridge), type(uint256).max);
    }

    // ------------------------------------------------------------- fixtures
    function _validatorSet() internal view returns (address[] memory set) {
        set = new address[](3);
        set[0] = v1;
        set[1] = v2;
        set[2] = v3;
    }

    // -------------------------------------------------------- timelock help
    /// @dev Queue -> warp past the eta -> execute, as the owner multisig would.
    function _timelock(bytes memory data) internal returns (uint256 actionId) {
        vm.prank(owner);
        actionId = bridge.queue(data);
        vm.warp(block.timestamp + bridge.timelockDelay());
        vm.prank(owner);
        bridge.executeAction(actionId);
    }

    /// @dev keccak256 of BridgeToken's runtime code. Identical for every
    ///      deployment because BridgeToken deliberately has no immutables, which
    ///      is what makes registerWrapped's codehash pin possible at all.
    function _bridgeTokenCodehash() internal pure returns (bytes32) {
        return keccak256(type(BridgeToken).runtimeCode);
    }

    /// @dev registerWrapped fails closed until the wrapper bytecode is pinned, so
    ///      every fixture that registers a wrapper must do this first.
    function _pinBridgeToken(FerminuxBridge target) internal {
        vm.prank(owner);
        uint256 id = target.queue(abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (_bridgeTokenCodehash())));
        vm.warp(block.timestamp + target.timelockDelay());
        vm.prank(owner);
        target.executeAction(id);
    }

    /// @dev Timelocked on any bridge, so a fixture can stand a second deployment up.
    function _timelockOnTarget(FerminuxBridge target, bytes memory data) internal returns (uint256 actionId) {
        vm.prank(owner);
        actionId = target.queue(data);
        vm.warp(block.timestamp + target.timelockDelay());
        vm.prank(owner);
        target.executeAction(actionId);
    }

    /// @dev Name the counterpart deployment for a remote chain. Mandatory before
    ///      the first registration against that chain.
    function _setRemoteBridge(FerminuxBridge target, uint64 remoteChain, address remote) internal {
        _timelockOnTarget(target, abi.encodeCall(FerminuxBridge.setRemoteBridge, (remoteChain, remote)));
    }

    function _registerCanonical(address token, uint64 remoteChain, address remoteToken, uint256 maxPer, uint256 daily)
        internal
    {
        _timelock(abi.encodeCall(FerminuxBridge.registerCanonical, (token, remoteChain, remoteToken, maxPer, daily)));
    }

    /// @dev Authorise ONE named inbound transfer to settle short — the strand
    ///      escape. Timelocked, like every other enlarging change.
    function _allowShortDelivery(FerminuxBridge.BridgeTransfer memory t) internal {
        _timelock(abi.encodeCall(FerminuxBridge.allowShortDelivery, (t)));
    }

    /// @dev rescue() of a REGISTERED token is timelocked; only an unregistered
    ///      token can still be swept instantly by the owner.
    function _rescue(address token, address to, uint256 amount) internal {
        _timelock(abi.encodeCall(FerminuxBridge.rescue, (token, to, amount)));
    }

    /// @dev Queue and mature an action without firing it, so a test can assert on
    ///      the events (or the revert) of the execution itself.
    function _queueMatured(bytes memory data) internal returns (uint256 actionId) {
        vm.prank(owner);
        actionId = bridge.queue(data);
        vm.warp(block.timestamp + bridge.timelockDelay());
    }

    function _fireAction(uint256 actionId) internal {
        vm.prank(owner);
        bridge.executeAction(actionId);
    }

    /// @dev Queue -> warp -> executeAction, expecting the INNER call to revert.
    function _expectTimelockRevert(bytes memory data, bytes memory reason) internal {
        uint256 id = _queueMatured(data);
        vm.prank(owner);
        vm.expectRevert(reason);
        bridge.executeAction(id);
    }

    function _registerWrapped(address token, uint64 remoteChain, address remoteToken, uint256 maxPer, uint256 daily)
        internal
    {
        _timelock(abi.encodeCall(FerminuxBridge.registerWrapped, (token, remoteChain, remoteToken, maxPer, daily)));
    }

    // -------------------------------------------------------- transfer help
    function _inbound(address dstToken, address srcToken, address recipient, uint256 amount, uint64 nonce)
        internal
        pure
        returns (FerminuxBridge.BridgeTransfer memory)
    {
        return FerminuxBridge.BridgeTransfer({
            srcChainId: REMOTE_CHAIN,
            dstChainId: LOCAL_CHAIN,
            nonce: nonce,
            srcToken: srcToken,
            dstToken: dstToken,
            sender: address(0xBEEF),
            recipient: recipient,
            amount: amount
        });
    }

    function _sign(uint256 key, FerminuxBridge.BridgeTransfer memory t)
        internal
        view
        returns (FerminuxBridge.Signature memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, bridge.hashTransfer(t));
        return FerminuxBridge.Signature({v: v, r: r, s: s});
    }

    function _signWith(FerminuxBridge target, uint256 key, FerminuxBridge.BridgeTransfer memory t)
        internal
        view
        returns (FerminuxBridge.Signature memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.hashTransfer(t));
        return FerminuxBridge.Signature({v: v, r: r, s: s});
    }

    function _sigs(uint256 keyA, uint256 keyB, FerminuxBridge.BridgeTransfer memory t)
        internal
        view
        returns (FerminuxBridge.Signature[] memory out)
    {
        out = new FerminuxBridge.Signature[](2);
        out[0] = _sign(keyA, t);
        out[1] = _sign(keyB, t);
    }

    function _quorum(FerminuxBridge.BridgeTransfer memory t) internal view returns (FerminuxBridge.Signature[] memory) {
        return _sigs(k1, k2, t);
    }

    function _one(uint256 key, FerminuxBridge.BridgeTransfer memory t)
        internal
        view
        returns (FerminuxBridge.Signature[] memory out)
    {
        out = new FerminuxBridge.Signature[](1);
        out[0] = _sign(key, t);
    }

    /// @dev Rebuild the EIP-712 digest with an arbitrary domain, so tests can
    ///      forge signatures that are valid "somewhere else".
    function _digestForDomain(uint256 chainId, address verifying, FerminuxBridge.BridgeTransfer memory t)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("FerminuxBridge")),
                keccak256(bytes("1")),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                bridge.TRANSFER_TYPEHASH(),
                bridge.transferIdOf(t),
                t.srcChainId,
                t.dstChainId,
                t.nonce,
                t.srcToken,
                t.dstToken,
                t.sender,
                t.recipient,
                t.amount
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signDigest(uint256 key, bytes32 digest) internal pure returns (FerminuxBridge.Signature memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return FerminuxBridge.Signature({v: v, r: r, s: s});
    }

    function _fee(uint256 gross) internal view returns (uint256) {
        return (gross * bridge.feeBps()) / bridge.BPS_DENOMINATOR();
    }

    function _net(uint256 gross) internal view returns (uint256) {
        return gross - _fee(gross);
    }
}
