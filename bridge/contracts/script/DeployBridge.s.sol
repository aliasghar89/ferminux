// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FerminuxBridge} from "../src/FerminuxBridge.sol";

/**
 * @title DeployBridge
 * @notice Deploys ONE FerminuxBridge. Run it once per chain — Ferminux (3961)
 *         and every remote chain get the same contract, differing only in their
 *         token registry (see script/RegisterToken.s.sol).
 *
 * Env vars (all optional — the defaults are anvil's deterministic dev accounts
 * and are for a LOCAL DEVNET ONLY; never ship a deployment that used them):
 *   DEPLOYER_KEY      private key that broadcasts        (default: anvil #0)
 *   BRIDGE_OWNER      owner multisig                      (default: anvil #0)
 *   BRIDGE_VALIDATOR1 validator 1                         (default: anvil #1)
 *   BRIDGE_VALIDATOR2 validator 2                         (default: anvil #2)
 *   BRIDGE_VALIDATOR3 validator 3                         (default: anvil #3)
 *   BRIDGE_THRESHOLD  signatures required                 (default: 2)
 *   FEE_COLLECTOR     where bridge fees are swept         (default: BRIDGE_OWNER)
 *   FEE_BPS           fee in basis points, max 100        (default: 10 = 0.10 %)
 *   TIMELOCK_DELAY    seconds, 1h..30d                    (default: 172800 = 48h)
 *   BRIDGE_PAUSER     hot key that may pause              (default: anvil #4)
 *
 * Devnet run (your OWN anvil, never the live docker devnet):
 *   anvil --port 8560 --chain-id 3961
 *   forge script script/DeployBridge.s.sol --rpc-url http://127.0.0.1:8560 --broadcast
 */
contract DeployBridge is Script {
    // anvil dev accounts — devnet defaults only, NEVER production
    uint256 internal constant DEV_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0
    address internal constant DEV_OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil #0
    address internal constant DEV_VALIDATOR1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil #1
    address internal constant DEV_VALIDATOR2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // anvil #2
    address internal constant DEV_VALIDATOR3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // anvil #3
    address internal constant DEV_PAUSER = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; // anvil #4

    uint256 internal constant DEFAULT_THRESHOLD = 2;
    uint256 internal constant DEFAULT_FEE_BPS = 10; // 0.10 %
    uint64 internal constant DEFAULT_TIMELOCK_DELAY = 48 hours;

    function run() external returns (FerminuxBridge bridge) {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address owner = vm.envOr("BRIDGE_OWNER", DEV_OWNER);
        address feeCollector = vm.envOr("FEE_COLLECTOR", owner);
        uint256 threshold = vm.envOr("BRIDGE_THRESHOLD", DEFAULT_THRESHOLD);
        uint256 feeBps = vm.envOr("FEE_BPS", DEFAULT_FEE_BPS);
        uint64 timelockDelay = uint64(vm.envOr("TIMELOCK_DELAY", uint256(DEFAULT_TIMELOCK_DELAY)));
        address pauser = vm.envOr("BRIDGE_PAUSER", DEV_PAUSER);

        address[] memory validators = new address[](3);
        validators[0] = vm.envOr("BRIDGE_VALIDATOR1", DEV_VALIDATOR1);
        validators[1] = vm.envOr("BRIDGE_VALIDATOR2", DEV_VALIDATOR2);
        validators[2] = vm.envOr("BRIDGE_VALIDATOR3", DEV_VALIDATOR3);

        // A missing env var must never become a PUBLICLY KNOWN key on a real
        // chain. Every value above falls back to an anvil dev account, which is
        // right for a devnet and catastrophic anywhere else: on 2026-08-23 an
        // Ethereum mainnet deployment ran with BRIDGE_VALIDATOR3 unset and took
        // anvil #3 — whose private key is in every Foundry install — as one of
        // three validators on a 2-of-3 bridge. It only failed because the
        // deployer had no gas. Off a local chain, refuse the defaults instead.
        if (block.chainid != 31337 && block.chainid != 39610) {
            require(deployerKey != DEV_DEPLOYER_KEY, "DEPLOY: DEPLOYER_KEY is the anvil dev key");
            require(owner != DEV_OWNER, "DEPLOY: BRIDGE_OWNER is an anvil dev account");
            require(pauser != DEV_PAUSER, "DEPLOY: BRIDGE_PAUSER is an anvil dev account");
            require(validators[0] != DEV_VALIDATOR1, "DEPLOY: BRIDGE_VALIDATOR1 is an anvil dev account");
            require(validators[1] != DEV_VALIDATOR2, "DEPLOY: BRIDGE_VALIDATOR2 is an anvil dev account");
            require(validators[2] != DEV_VALIDATOR3, "DEPLOY: BRIDGE_VALIDATOR3 is an anvil dev account");
            require(validators[0] != validators[1] && validators[1] != validators[2]
                    && validators[0] != validators[2], "DEPLOY: duplicate validator");
            require(owner != address(0) && pauser != address(0), "DEPLOY: zero owner or pauser");
        }

        vm.startBroadcast(deployerKey);
        bridge = new FerminuxBridge(owner, validators, threshold, feeCollector, feeBps, timelockDelay, pauser);
        vm.stopBroadcast();

        console2.log("chain id:              ", block.chainid);
        console2.log("FerminuxBridge:        ", address(bridge));
        console2.log("owner (multisig):      ", owner);
        console2.log("fee collector:         ", feeCollector);
        console2.log("fee bps:               ", feeBps);
        console2.log("threshold:             ", threshold);
        console2.log("validator 1:           ", validators[0]);
        console2.log("validator 2:           ", validators[1]);
        console2.log("validator 3:           ", validators[2]);
        console2.log("pauser:                ", pauser);
        console2.log("timelock delay (s):    ", timelockDelay);
        console2.log("EIP-712 domain sep:    ");
        console2.logBytes32(bridge.DOMAIN_SEPARATOR());
        console2.log("wrapper codehash pin:  UNSET - registerWrapped fails closed until it is set");
        console2.log("");
        console2.log("Next, with script/RegisterToken.s.sol (48h timelock each):");
        console2.log("  TOKEN_KIND=pin        once per bridge, required before any wrapped token");
        console2.log("  TOKEN_KIND=canonical  per asset that is canonical here");
        console2.log("  TOKEN_KIND=wrapped    per asset that is canonical elsewhere");
    }
}
