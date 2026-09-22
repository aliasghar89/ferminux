// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

/// @notice Deploys AgentRegistry + ServiceEscrow and hands governance to GOVERNANCE as the LAST step.
/// @dev Env:
///   GOVERNANCE     final governance (multisig) — required
///   FEE_RECIPIENT  treasury — required
///   MIN_BOND       wei, default 100 ether
/// Writes ../deployments.<chainid>.json = {chainId, registry, escrow, deployBlock}
/// (falls back to a console JSON line if the write fails).
contract Deploy is Script {
    function run() external {
        address governance = vm.envAddress("GOVERNANCE");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 minBond = vm.envOr("MIN_BOND", uint256(100 ether));
        require(governance != address(0) && feeRecipient != address(0), "env");

        vm.startBroadcast();
        address deployer = msg.sender;
        uint256 deployBlock = block.number;

        AgentRegistry registry = new AgentRegistry(deployer, minBond);
        ServiceEscrow escrow = new ServiceEscrow(registry, deployer, feeRecipient);
        registry.setEscrow(address(escrow));
        // governance hand-over is the last thing we do
        registry.setGovernance(governance);
        escrow.setGovernance(governance);
        vm.stopBroadcast();

        console.log("chainId      ", block.chainid);
        console.log("deployer     ", deployer);
        console.log("AgentRegistry", address(registry));
        console.log("ServiceEscrow", address(escrow));
        console.log("deployBlock  ", deployBlock);
        console.log("governance   ", governance);
        console.log("feeRecipient ", feeRecipient);
        console.log("minBond      ", minBond);

        string memory json = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"registry":"',
            vm.toString(address(registry)),
            '","escrow":"',
            vm.toString(address(escrow)),
            '","deployBlock":',
            vm.toString(deployBlock),
            "}"
        );
        console.log("deployments json:", json);

        string memory path = string.concat("../deployments.", vm.toString(block.chainid), ".json");
        try vm.writeFile(path, json) {
            console.log("wrote", path);
        } catch {
            console.log("could not write", path, "- copy the JSON line above");
        }
    }
}
