// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";
import {BridgeToken} from "../src/BridgeToken.sol";

/**
 * @title RegisterToken
 * @notice Registering a token is a TIMELOCKED action, so it always takes two
 *         transactions separated by the delay (48h by default):
 *
 *           ACTION=queue    -> bridge.queue(<registerCanonical|registerWrapped>)
 *           ...wait out the timelock...
 *           ACTION=execute  -> bridge.executeAction(ACTION_ID)
 *
 *         Both must come from the owner multisig. If OWNER_KEY is set the script
 *         broadcasts directly (devnet / EOA owner). It ALWAYS prints the raw
 *         calldata as well, so a MinimalMultisig owner can be driven with:
 *
 *           cast send $MSIG "submit(address,uint256,bytes)" $BRIDGE 0 <calldata>
 *
 * Env vars:
 *   BRIDGE           bridge address on THIS chain                (required)
 *   ACTION           queue | execute | cancel                    (default: queue)
 *   TOKEN_KIND       canonical | wrapped | pin | remotebridge | limits |
 *                    shortdelivery | rescue                      (default: canonical)
 *                    `pin` queues setBridgeTokenCodehash, which registerWrapped
 *                    requires. Run it ONCE per bridge, before the first wrapped
 *                    registration — until it lands, registerWrapped fails closed
 *                    with "BRIDGE: wrapper pin unset".
 *                    `remotebridge` queues setRemoteBridge. Run it ONCE per
 *                    REMOTE CHAIN, before that chain's first registration —
 *                    until it lands, every register fails closed with
 *                    "BRIDGE: remote bridge unset". It is the address send()
 *                    refuses to pay, so read it back before registering.
 *                    `shortdelivery` queues allowShortDelivery for ONE stranded
 *                    inbound transfer — the LAST resort for a canonical token
 *                    that started taxing its transfers after its collateral was
 *                    locked. Read contracts/README.md §"When a route strands"
 *                    before using it: it makes one named recipient receive less
 *                    than they were promised.
 *                    `rescue` queues rescue() for a REGISTERED token, which is
 *                    timelocked. For an UNREGISTERED token call rescue()
 *                    directly instead — no timelock applies there.
 *   LOCAL_TOKEN      token address here; 0x0 = native coin       (default: 0x0)
 *   REMOTE_CHAIN_ID  the one chain this token bridges with       (required for queue)
 *   REMOTE_TOKEN     its address there; 0x0 = their native coin  (default: 0x0)
 *   REMOTE_BRIDGE    counterpart bridge, for TOKEN_KIND=remotebridge (required there)
 *   SD_*             the stranded transfer, for TOKEN_KIND=shortdelivery:
 *                    SD_SRC_CHAIN_ID, SD_NONCE, SD_SRC_TOKEN, SD_DST_TOKEN,
 *                    SD_SENDER, SD_RECIPIENT, SD_AMOUNT — copy them field for
 *                    field from the Sent event on the source chain. dstChainId is
 *                    this chain and is filled in for you.
 *   RESCUE_TOKEN / RESCUE_TO / RESCUE_AMOUNT   for TOKEN_KIND=rescue
 *   MAX_PER_TRANSFER per-transfer ceiling, wei                   (default: 1000e18)
 *   DAILY_CAP        rolling-24h ceiling per direction, wei      (default: 10000e18)
 *   ACTION_ID        for ACTION=execute|cancel                   (required there)
 *   WRAPPER_CODEHASH override for TOKEN_KIND=pin                 (default: this
 *                    build's keccak256(BridgeToken.runtimeCode))
 *   OWNER_KEY        owner private key; omit to only print calldata
 *
 * Devnet run:
 *   BRIDGE=0x... REMOTE_CHAIN_ID=56 REMOTE_TOKEN=0x... \
 *   forge script script/RegisterToken.s.sol --rpc-url http://127.0.0.1:8560 --broadcast
 */
contract RegisterToken is Script {
    uint256 internal constant DEV_OWNER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0

    function run() external {
        FerminuxBridge bridge = FerminuxBridge(payable(vm.envAddress("BRIDGE")));
        string memory action = vm.envOr("ACTION", string("queue"));

        if (_eq(action, "queue")) {
            _queue(bridge);
        } else if (_eq(action, "execute")) {
            _execute(bridge);
        } else if (_eq(action, "cancel")) {
            _cancel(bridge);
        } else {
            revert("ACTION must be queue | execute | cancel");
        }
    }

    // ------------------------------------------------------------------ queue

    function _queue(FerminuxBridge bridge) internal {
        string memory kind = vm.envOr("TOKEN_KIND", string("canonical"));
        if (_eq(kind, "pin")) {
            _queuePin(bridge);
            return;
        }
        if (_eq(kind, "remotebridge")) {
            _queueSimple(
                bridge,
                abi.encodeCall(
                    FerminuxBridge.setRemoteBridge,
                    (uint64(vm.envUint("REMOTE_CHAIN_ID")), vm.envAddress("REMOTE_BRIDGE"))
                ),
                "setRemoteBridge"
            );
            return;
        }
        if (_eq(kind, "shortdelivery")) {
            FerminuxBridge.BridgeTransfer memory t = FerminuxBridge.BridgeTransfer({
                srcChainId: uint64(vm.envUint("SD_SRC_CHAIN_ID")),
                dstChainId: uint64(block.chainid),
                nonce: uint64(vm.envUint("SD_NONCE")),
                srcToken: vm.envAddress("SD_SRC_TOKEN"),
                dstToken: vm.envAddress("SD_DST_TOKEN"),
                sender: vm.envAddress("SD_SENDER"),
                recipient: vm.envAddress("SD_RECIPIENT"),
                amount: vm.envUint("SD_AMOUNT")
            });
            console2.log("transferId:      ");
            console2.logBytes32(bridge.transferIdOf(t));
            console2.log("recipient is owed:", t.amount);
            console2.log("...and will receive LESS. Publish this before you queue it.");
            _queueSimple(bridge, abi.encodeCall(FerminuxBridge.allowShortDelivery, (t)), "allowShortDelivery");
            return;
        }
        // Raising a cap is the ONE governance action this project needed
        // repeatedly and had no way to queue: the script could register a token
        // at a cap but never change it afterwards, so the 48h clock could not
        // even be started without hand-building calldata. LOWERING needs nothing
        // here — decreaseTokenLimits is instant and owner-only, because
        // tightening is a safety action.
        if (_eq(kind, "limits")) {
            _queueSimple(
                bridge,
                abi.encodeCall(
                    FerminuxBridge.setTokenLimits,
                    (
                        vm.envOr("LOCAL_TOKEN", address(0)),
                        vm.envUint("MAX_PER_TRANSFER"),
                        vm.envUint("DAILY_CAP")
                    )
                ),
                "setTokenLimits"
            );
            return;
        }
        if (_eq(kind, "rescue")) {
            _queueSimple(
                bridge,
                abi.encodeCall(
                    FerminuxBridge.rescue,
                    (vm.envAddress("RESCUE_TOKEN"), vm.envAddress("RESCUE_TO"), vm.envUint("RESCUE_AMOUNT"))
                ),
                "rescue"
            );
            return;
        }

        address localToken = vm.envOr("LOCAL_TOKEN", address(0));
        uint64 remoteChainId = uint64(vm.envUint("REMOTE_CHAIN_ID"));
        address remoteToken = vm.envOr("REMOTE_TOKEN", address(0));
        uint256 maxPerTransfer = vm.envOr("MAX_PER_TRANSFER", uint256(1_000 ether));
        uint256 dailyCap = vm.envOr("DAILY_CAP", uint256(10_000 ether));

        bytes memory inner;
        if (_eq(kind, "canonical")) {
            inner = abi.encodeCall(
                FerminuxBridge.registerCanonical, (localToken, remoteChainId, remoteToken, maxPerTransfer, dailyCap)
            );
        } else if (_eq(kind, "wrapped")) {
            require(localToken != address(0), "wrapped token cannot be the native coin");
            inner = abi.encodeCall(
                FerminuxBridge.registerWrapped, (localToken, remoteChainId, remoteToken, maxPerTransfer, dailyCap)
            );
        } else {
            revert("TOKEN_KIND must be canonical | wrapped | pin | remotebridge | limits | shortdelivery | rescue");
        }

        console2.log("bridge:          ", address(bridge));
        console2.log("kind:            ", kind);
        console2.log("local token:     ", localToken);
        console2.log("remote chain id: ", remoteChainId);
        console2.log("remote token:    ", remoteToken);
        console2.log("maxPerTransfer:  ", maxPerTransfer);
        console2.log("dailyCap:        ", dailyCap);
        console2.log("timelock delay:  ", bridge.timelockDelay());
        console2.log("");
        console2.log("calldata for bridge.queue(bytes) -- submit this through the owner multisig:");
        console2.logBytes(abi.encodeCall(FerminuxBridge.queue, (inner)));

        (bool hasKey, uint256 ownerKey) = _ownerKey();
        if (!hasKey) {
            console2.log("");
            console2.log("OWNER_KEY not set - printed calldata only, nothing broadcast.");
            return;
        }

        vm.broadcast(ownerKey);
        uint256 actionId = bridge.queue(inner);
        console2.log("");
        console2.log("queued action id:", actionId);
        console2.log("execute after:   ", block.timestamp + bridge.timelockDelay());
    }

    // ------------------------------------------------- generic queued action

    /// @dev Print-then-optionally-broadcast for the one-argument timelocked
    ///      setters, so every governance step in this script takes the same shape.
    function _queueSimple(FerminuxBridge bridge, bytes memory inner, string memory label) internal {
        console2.log("bridge:          ", address(bridge));
        console2.log("action:          ", label);
        console2.log("timelock delay:  ", bridge.timelockDelay());
        console2.log("");
        console2.log("inner calldata:");
        console2.logBytes(inner);
        console2.log("calldata for bridge.queue(bytes) -- submit this through the owner multisig:");
        console2.logBytes(abi.encodeCall(FerminuxBridge.queue, (inner)));

        (bool hasKey, uint256 ownerKey) = _ownerKey();
        if (!hasKey) {
            console2.log("");
            console2.log("OWNER_KEY not set - printed calldata only, nothing broadcast.");
            return;
        }

        vm.broadcast(ownerKey);
        uint256 actionId = bridge.queue(inner);
        console2.log("");
        console2.log("queued action id:", actionId);
        console2.log("execute after:   ", block.timestamp + bridge.timelockDelay());
    }

    // --------------------------------------------------------- wrapper pin

    /// @dev Pins the exact wrapper bytecode registerWrapped will accept. Every
    ///      BridgeToken deployment shares this codehash because the contract has
    ///      no immutables, so one pin covers every wrapper on this chain.
    function _queuePin(FerminuxBridge bridge) internal {
        bytes32 codehash = keccak256(type(BridgeToken).runtimeCode);
        uint256 override_ = vm.envOr("WRAPPER_CODEHASH", uint256(0));
        if (override_ != 0) codehash = bytes32(override_);

        bytes memory inner = abi.encodeCall(FerminuxBridge.setBridgeTokenCodehash, (codehash));

        console2.log("bridge:          ", address(bridge));
        console2.log("current pin:     ");
        console2.logBytes32(bridge.bridgeTokenCodehash());
        console2.log("new pin:         ");
        console2.logBytes32(codehash);
        console2.log("timelock delay:  ", bridge.timelockDelay());
        console2.log("");
        console2.log("calldata for bridge.queue(bytes) -- submit this through the owner multisig:");
        console2.logBytes(abi.encodeCall(FerminuxBridge.queue, (inner)));

        (bool hasKey, uint256 ownerKey) = _ownerKey();
        if (!hasKey) {
            console2.log("");
            console2.log("OWNER_KEY not set - printed calldata only, nothing broadcast.");
            return;
        }

        vm.broadcast(ownerKey);
        uint256 actionId = bridge.queue(inner);
        console2.log("");
        console2.log("queued action id:", actionId);
        console2.log("execute after:   ", block.timestamp + bridge.timelockDelay());
    }

    // ---------------------------------------------------------------- execute

    function _execute(FerminuxBridge bridge) internal {
        uint256 actionId = vm.envUint("ACTION_ID");
        (bytes memory data, uint64 eta, bool executed, bool canceled) = bridge.getAction(actionId);
        console2.log("action id:", actionId);
        console2.log("eta:      ", eta);
        console2.log("now:      ", block.timestamp);
        console2.log("executed: ", executed);
        console2.log("canceled: ", canceled);
        console2.logBytes(data);
        console2.log("");
        console2.log("calldata for bridge.executeAction(uint256):");
        console2.logBytes(abi.encodeCall(FerminuxBridge.executeAction, (actionId)));

        (bool hasKey, uint256 ownerKey) = _ownerKey();
        if (!hasKey) {
            console2.log("");
            console2.log("OWNER_KEY not set - printed calldata only, nothing broadcast.");
            return;
        }
        require(block.timestamp >= eta, "timelock has not elapsed yet");

        vm.broadcast(ownerKey);
        bridge.executeAction(actionId);
        console2.log("executed.");
    }

    // ----------------------------------------------------------------- cancel

    function _cancel(FerminuxBridge bridge) internal {
        uint256 actionId = vm.envUint("ACTION_ID");
        console2.log("calldata for bridge.cancelAction(uint256):");
        console2.logBytes(abi.encodeCall(FerminuxBridge.cancelAction, (actionId)));

        (bool hasKey, uint256 ownerKey) = _ownerKey();
        if (!hasKey) return;

        vm.broadcast(ownerKey);
        bridge.cancelAction(actionId);
        console2.log("canceled action:", actionId);
    }

    // ------------------------------------------------------------------ utils

    function _ownerKey() internal view returns (bool hasKey, uint256 key) {
        key = vm.envOr("OWNER_KEY", uint256(0));
        if (key != 0) return (true, key);
        // On a local devnet fall back to anvil #0 so the script is runnable as-is.
        if (block.chainid == 31337 || vm.envOr("DEVNET", false)) return (true, DEV_OWNER_KEY);
        return (false, 0);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
