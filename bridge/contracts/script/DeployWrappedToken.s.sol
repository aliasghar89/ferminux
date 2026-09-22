// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BridgeToken} from "../src/BridgeToken.sol";

/**
 * @title DeployWrappedToken
 * @notice Deploys the BridgeToken wrapper for an asset that is canonical on
 *         another chain. Run this BEFORE RegisterToken with TOKEN_KIND=wrapped:
 *         registerWrapped() checks that the wrapper names the registering bridge
 *         as its minter, so the wrapper must exist first.
 *
 *         registerWrapped ALSO requires the bridge's wrapper codehash pin to be
 *         set to this bytecode, and fails closed until it is. Every BridgeToken
 *         deployment has identical runtime code (the contract has no immutables),
 *         so one pin covers every wrapper on that chain. Pin it once per bridge
 *         with RegisterToken TOKEN_KIND=pin.
 *
 * Env vars:
 *   DEPLOYER_KEY   private key that broadcasts             (default: anvil #0)
 *   BRIDGE         the bridge on THIS chain                (required)
 *   WRAPPED_NAME   e.g. "Wrapped FMX"                      (default: "Wrapped Token")
 *   WRAPPED_SYMBOL e.g. "wFMX"                             (default: "wTKN")
 *   WRAPPED_DECIMALS  mirror the origin asset, <= 18       (default: 18)
 *   ORIGIN_CHAIN_ID   chain where the asset is canonical   (required)
 *   ORIGIN_TOKEN      its address there; 0x0 = native coin (default: 0x0)
 *
 * Devnet run:
 *   BRIDGE=0x... ORIGIN_CHAIN_ID=3961 WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX \
 *   forge script script/DeployWrappedToken.s.sol --rpc-url http://127.0.0.1:8561 --broadcast
 */
contract DeployWrappedToken is Script {
    uint256 internal constant DEV_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0

    function run() external returns (BridgeToken token) {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address bridge = vm.envAddress("BRIDGE");
        string memory name = vm.envOr("WRAPPED_NAME", string("Wrapped Token"));
        string memory symbol = vm.envOr("WRAPPED_SYMBOL", string("wTKN"));
        uint8 decimals = uint8(vm.envOr("WRAPPED_DECIMALS", uint256(18)));
        uint64 originChainId = uint64(vm.envUint("ORIGIN_CHAIN_ID"));
        address originToken = vm.envOr("ORIGIN_TOKEN", address(0));

        vm.startBroadcast(deployerKey);
        token = new BridgeToken(name, symbol, decimals, bridge, originChainId, originToken);
        vm.stopBroadcast();

        console2.log("chain id:        ", block.chainid);
        console2.log("BridgeToken:     ", address(token));
        console2.log("name / symbol:   ", name, symbol);
        console2.log("decimals:        ", decimals);
        console2.log("minter (bridge): ", bridge);
        console2.log("origin chain id: ", originChainId);
        console2.log("origin token:    ", originToken);
        console2.log("runtime codehash:");
        console2.logBytes32(address(token).codehash);
        console2.log("");
        console2.log("Next, in order:");
        console2.log("  1. RegisterToken TOKEN_KIND=pin       (once per bridge, 48h timelock)");
        console2.log("  2. RegisterToken TOKEN_KIND=wrapped LOCAL_TOKEN=<this address>");
    }
}
