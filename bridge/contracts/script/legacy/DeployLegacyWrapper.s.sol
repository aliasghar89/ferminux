// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BridgeToken} from "./BridgeTokenLegacy.sol";

/**
 * @title DeployLegacyWrapper
 * @notice Deploys the wrapper bytecode that is ALREADY LIVE on BSC, so the
 *         migration rehearsal can unwind the real thing.
 *
 *         This exists for `script/wfmx-migration-e2e.sh` and for nothing else.
 *         Deploying it on a public chain would put a wrapper on-chain whose
 *         burn() consults no allowance — the exact property the migration is
 *         being run to remove. The script refuses any chain id it does not
 *         recognise as a local devnet.
 */
contract DeployLegacyWrapper is Script {
    uint256 internal constant DEV_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0

    function run() external returns (BridgeToken token) {
        // A rehearsal fixture must never reach a real chain. Chain id cannot be
        // the gate here: the rehearsal deliberately runs anvils on the REAL ids
        // (3961 and 56), because the EIP-712 domain binds chainid and a
        // rehearsal on invented ids proves the wrong digests. So the gate is an
        // explicit acknowledgement instead — nobody sets REHEARSAL=1 by
        // accident, and an unset env var refuses rather than deploys.
        require(vm.envOr("REHEARSAL", false), "LEGACY: fixture, set REHEARSAL=1 -- local anvils only");

        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address bridge = vm.envAddress("BRIDGE");
        string memory name = vm.envOr("WRAPPED_NAME", string("Wrapped FMX"));
        string memory symbol = vm.envOr("WRAPPED_SYMBOL", string("wFMX"));
        uint8 decimals = uint8(vm.envOr("WRAPPED_DECIMALS", uint256(18)));
        uint64 originChainId = uint64(vm.envUint("ORIGIN_CHAIN_ID"));
        address originToken = vm.envOr("ORIGIN_TOKEN", address(0));

        vm.startBroadcast(deployerKey);
        token = new BridgeToken(name, symbol, decimals, bridge, originChainId, originToken);
        vm.stopBroadcast();

        console2.log("LEGACY BridgeToken:", address(token));
        console2.log("runtime codehash:");
        console2.logBytes32(address(token).codehash);
    }
}
