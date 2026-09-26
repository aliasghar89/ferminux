// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FMXStaking} from "../src/FMXStaking.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";

/**
 * @title DeployStaking
 * @notice Deploys the Ferminux staking stack in dependency order:
 *           1. FMXStaking   (owner = OWNER, premine wallets deny-listed)
 *           2. NodeRegistry (staking, owner = OWNER, watchtower = WATCHTOWER)
 *           3. staking.initNodeRegistry(registry) — called directly when the
 *              deployer IS the owner (devnet); on mainnet the multisig must
 *              submit the printed calldata instead.
 *
 * Env vars (all optional — defaults target a local anvil devnet):
 *   DEPLOYER_KEY  private key that broadcasts     (default: anvil account #0)
 *   OWNER         contract owner                  (default: deployer address;
 *                 mainnet: the MinimalMultisig 0x910B...fEfe)
 *   WATCHTOWER    uptime oracle signer            (default: anvil account #1)
 *
 * The deny list is the five premine holders from the brief and is baked in —
 * it is the same on every network because the addresses are chain-agnostic.
 *
 * Devnet run (own anvil on the assigned port, NOT the live chain):
 *   anvil --port 8610 --chain-id 3961
 *   forge script script/DeployStaking.s.sol --rpc-url http://127.0.0.1:8610 --broadcast
 */
contract DeployStaking is Script {
    // anvil's deterministic dev accounts — devnet defaults only, NEVER production
    address internal constant DEV_WATCHTOWER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil #1
    uint256 internal constant DEV_DEPLOYER_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0

    // Premine wallets (design section 3: excluded from earning).
    address internal constant TREASURY = 0xc0A5Eb613f859f072554F29f1Ab7400265af15aB;
    address internal constant ECOSYSTEM = 0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787;
    address internal constant AZNT_OPS = 0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE;
    address internal constant COMMUNITY = 0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC;
    address internal constant TEAM_VESTING = 0x6F488FB1f382Bc96Fef8bBfCa28A9647E5Fe430B;

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address deployer = vm.addr(deployerKey);
        address ownerAddr = vm.envOr("OWNER", deployer);
        address watchtower = vm.envOr("WATCHTOWER", DEV_WATCHTOWER);

        address[] memory denyList = new address[](5);
        denyList[0] = TREASURY;
        denyList[1] = ECOSYSTEM;
        denyList[2] = AZNT_OPS;
        denyList[3] = COMMUNITY;
        denyList[4] = TEAM_VESTING;

        vm.startBroadcast(deployerKey);
        FMXStaking staking = new FMXStaking(ownerAddr, denyList);
        NodeRegistry registry = new NodeRegistry(address(staking), ownerAddr, watchtower);
        if (ownerAddr == deployer) {
            staking.initNodeRegistry(address(registry));
        }
        vm.stopBroadcast();

        console2.log("FMXStaking:  ", address(staking));
        console2.log("NodeRegistry:", address(registry));
        console2.log("  owner:     ", ownerAddr);
        console2.log("  watchtower:", watchtower);
        if (ownerAddr == deployer) {
            console2.log("  registry wired via initNodeRegistry");
        } else {
            console2.log("  ACTION REQUIRED: owner multisig must submit to FMXStaking:");
            console2.logBytes(abi.encodeCall(FMXStaking.initNodeRegistry, (address(registry))));
        }
    }
}
