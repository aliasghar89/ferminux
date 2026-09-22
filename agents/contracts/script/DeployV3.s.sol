// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {StreamPay} from "../src/StreamPay.sol";
import {ArbiterPool} from "../src/ArbiterPool.sol";
import {IdentityRegistry8004} from "../src/erc8004/IdentityRegistry8004.sol";
import {ReputationRegistry8004} from "../src/erc8004/ReputationRegistry8004.sol";
import {ValidationRegistry8004} from "../src/erc8004/ValidationRegistry8004.sol";
import {AgentTokenFactory} from "../src/AgentTokenFactory.sol";

/// @notice Addendum v3 deploy: X402Vault, AgentAccountFactory (+impl), StreamPay, ArbiterPool,
///         IdentityRegistry8004 / ReputationRegistry8004 / ValidationRegistry8004, AgentTokenFactory.
///         Governance / owner of every governed contract is handed to GOVERNANCE as the LAST step.
/// @dev Env (all optional):
///   REGISTRY       existing AgentRegistry   (default mainnet 0xa94f27F18267d09349809f3e2AeF8e7767033e8F)
///   ESCROW         existing ServiceEscrow   (default mainnet 0x99b331495951dB91857902de91EAe9Ff54d8a719)
///   GOVERNANCE     final governance/owner   (default MinimalMultisig 0x910BD467D8576277f8f96DF47428377FFD94fEfe)
///   FEE_RECIPIENT  treasury                 (default escrow.feeRecipient())
/// Prints a JSON line and writes ../deployments-v3.<chainid>.json.
/// NOTE: escrow governance is NOT touched here — moving it to ArbiterPool is a separate multisig tx
///       (escrow.setGovernance(arbiterPool)); until then ArbiterPool.close reverts.
contract DeployV3 is Script {
    address internal constant MAINNET_REGISTRY = 0xa94f27F18267d09349809f3e2AeF8e7767033e8F;
    address internal constant MAINNET_ESCROW = 0x99b331495951dB91857902de91EAe9Ff54d8a719;
    address internal constant MULTISIG = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;

    struct Out {
        X402Vault vault;
        AgentAccountFactory accountFactory;
        StreamPay streams;
        ArbiterPool arbiters;
        IdentityRegistry8004 identity;
        ReputationRegistry8004 reputation;
        ValidationRegistry8004 validation;
        AgentTokenFactory tokens;
    }

    function run() external {
        AgentRegistry registry = AgentRegistry(vm.envOr("REGISTRY", MAINNET_REGISTRY));
        ServiceEscrow escrow = ServiceEscrow(vm.envOr("ESCROW", MAINNET_ESCROW));
        address governance = vm.envOr("GOVERNANCE", MULTISIG);
        require(address(registry).code.length != 0, "REGISTRY has no code");
        require(address(escrow).code.length != 0, "ESCROW has no code");
        require(address(escrow.registry()) == address(registry), "escrow.registry != REGISTRY");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", escrow.feeRecipient());
        require(governance != address(0) && feeRecipient != address(0), "env");

        vm.startBroadcast();
        address deployer = msg.sender;
        uint256 deployBlock = block.number;

        Out memory o;
        // deployer is the interim governance/owner so post-deploy config could run in-script if ever needed
        o.vault = new X402Vault(deployer, feeRecipient);
        o.accountFactory = new AgentAccountFactory();
        o.streams = new StreamPay(deployer, feeRecipient);
        o.arbiters = new ArbiterPool(escrow, deployer);
        o.identity = new IdentityRegistry8004(registry);
        o.reputation = new ReputationRegistry8004(o.identity, escrow);
        o.validation = new ValidationRegistry8004(o.identity);
        o.tokens = new AgentTokenFactory(registry, deployer, feeRecipient);

        // ── hand-over is the LAST step ──
        o.vault.setGovernance(governance);
        o.streams.setGovernance(governance);
        o.tokens.setGovernance(governance);
        o.arbiters.transferOwnership(governance);
        vm.stopBroadcast();

        require(o.vault.governance() == governance && o.streams.governance() == governance, "gov");
        require(o.tokens.governance() == governance && o.arbiters.owner() == governance, "gov");

        console.log("chainId               ", block.chainid);
        console.log("deployer              ", deployer);
        console.log("registry              ", address(registry));
        console.log("escrow                ", address(escrow));
        console.log("X402Vault             ", address(o.vault));
        console.log("AgentAccountFactory   ", address(o.accountFactory));
        console.log("AgentAccount impl     ", address(o.accountFactory.implementation()));
        console.log("StreamPay             ", address(o.streams));
        console.log("ArbiterPool           ", address(o.arbiters));
        console.log("IdentityRegistry8004  ", address(o.identity));
        console.log("ReputationRegistry8004", address(o.reputation));
        console.log("ValidationRegistry8004", address(o.validation));
        console.log("AgentTokenFactory     ", address(o.tokens));
        console.log("deployBlock           ", deployBlock);
        console.log("governance            ", governance);
        console.log("feeRecipient          ", feeRecipient);

        string memory json = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"registry":"',
            vm.toString(address(registry)),
            '","escrow":"',
            vm.toString(address(escrow)),
            '","x402Vault":"',
            vm.toString(address(o.vault)),
            '","agentAccountFactory":"',
            vm.toString(address(o.accountFactory)),
            '","agentAccountImpl":"',
            vm.toString(address(o.accountFactory.implementation())),
            '","streamPay":"',
            vm.toString(address(o.streams)),
            '"'
        );
        json = string.concat(
            json,
            ',"arbiterPool":"',
            vm.toString(address(o.arbiters)),
            '","identityRegistry8004":"',
            vm.toString(address(o.identity)),
            '","reputationRegistry8004":"',
            vm.toString(address(o.reputation)),
            '","validationRegistry8004":"',
            vm.toString(address(o.validation)),
            '","agentTokenFactory":"',
            vm.toString(address(o.tokens)),
            '","governance":"',
            vm.toString(governance),
            '","feeRecipient":"',
            vm.toString(feeRecipient),
            '","deployBlockV3":',
            vm.toString(deployBlock),
            "}"
        );
        console.log("deployments-v3 json:", json);

        string memory path = string.concat("../deployments-v3.", vm.toString(block.chainid), ".json");
        try vm.writeFile(path, json) {
            console.log("wrote", path);
        } catch {
            console.log("could not write", path, "- copy the JSON line above");
        }
    }
}
