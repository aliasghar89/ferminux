// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

/// @notice End-to-end smoke run against an already deployed registry/escrow (anvil or a testnet fork):
///         register agent -> request job -> deliver -> release(5) -> withdraw. Prints balances.
/// @dev Env:
///   REGISTRY   AgentRegistry address — required
///   ESCROW     ServiceEscrow address — required
///   AGENT_PK   agent-owner private key   (default: anvil key #0)
///   CLIENT_PK  client private key        (default: anvil key #1)
///   JOB_AMOUNT wei sent for the job      (default: 1 ether)
contract Smoke is Script {
    uint256 constant ANVIL_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ANVIL_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    function run() external {
        AgentRegistry registry = AgentRegistry(vm.envAddress("REGISTRY"));
        ServiceEscrow escrow = ServiceEscrow(payable(vm.envAddress("ESCROW")));
        uint256 agentPk = vm.envOr("AGENT_PK", ANVIL_0);
        uint256 clientPk = vm.envOr("CLIENT_PK", ANVIL_1);
        uint256 jobAmount = vm.envOr("JOB_AMOUNT", uint256(1 ether));
        address agentOwner = vm.addr(agentPk);
        address client = vm.addr(clientPk);
        address treasury = escrow.feeRecipient();

        console.log("registry   ", address(registry));
        console.log("escrow     ", address(escrow));
        console.log("agentOwner ", agentOwner, agentOwner.balance);
        console.log("client     ", client, client.balance);
        console.log("treasury   ", treasury, treasury.balance);

        uint256 minBond = registry.minBond();

        // 1. register
        vm.startBroadcast(agentPk);
        uint256 agentId =
            registry.register{value: minBond}("Smoke Scribe", "http://127.0.0.1:8801", "fmx://payload/0x00", 0.5 ether);
        vm.stopBroadcast();
        console.log("registered agent", agentId, "bond", minBond);
        require(registry.isActive(agentId), "agent not active");

        // 2. request
        vm.startBroadcast(clientPk);
        uint256 jobId = escrow.requestJob{value: jobAmount}(agentId, keccak256("hello"), "fmx://payload/0xhello");
        vm.stopBroadcast();
        console.log("requested job", jobId, "amount", jobAmount);

        // 3. deliver
        vm.startBroadcast(agentPk);
        escrow.deliver(jobId, keccak256("world"), "fmx://payload/0xworld");
        vm.stopBroadcast();
        console.log("delivered job", jobId);

        // 4. release with rating 5
        vm.startBroadcast(clientPk);
        escrow.release(jobId, 5);
        vm.stopBroadcast();
        ServiceEscrow.Job memory j = escrow.getJob(jobId);
        console.log("released; status", uint8(j.status));
        console.log("credits[agentOwner]", escrow.credits(agentOwner));
        console.log("credits[treasury]  ", escrow.credits(treasury));

        // 5. withdraw agent payout
        vm.startBroadcast(agentPk);
        escrow.withdraw();
        vm.stopBroadcast();

        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        console.log("agent jobsCompleted", a.jobsCompleted, "ratingSum", a.ratingSum);
        console.log("agentOwner balance ", agentOwner.balance);
        console.log("client balance     ", client.balance);
        console.log("escrow balance     ", address(escrow).balance);
        console.log("registry balance   ", address(registry).balance);
        console.log("SMOKE OK");
    }
}
