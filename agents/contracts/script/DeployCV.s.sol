// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";
import {MemoryAnchor} from "../src/MemoryAnchor.sol";
import {Endorsements} from "../src/Endorsements.sol";
import {IAccountFactoryLike} from "../src/lib/IAccount.sol";

/// @notice AI-CV layer deploy: MemoryAnchor + Endorsements. Governance of BOTH is handed to
///         GOVERNANCE as the LAST step, exactly as DeployV3 does for the v3 contracts.
/// @dev Env (all optional):
///   REGISTRY         existing AgentRegistry       (default mainnet 0xa94f…3e8F)
///   ESCROW           existing ServiceEscrow       (default mainnet 0x99b3…a719)
///   ACCOUNT_FACTORY  existing AgentAccountFactory (default mainnet 0x82e7…2dcb)
///   GOVERNANCE       final governance             (default MinimalMultisig 0x910B…fEfe)
/// Prints a JSON line and writes ../deployments-cv.<chainid>.json.
///
/// Dry run:    forge script script/DeployCV.s.sol --rpc-url https://rpc.ferminux.net
/// Broadcast:  add --broadcast --private-key $KEY --priority-gas-price 1gwei
///             (chain 3961's signers enforce a 1 gwei priority-fee floor)
/// NOTE: this script is NOT to be broadcast to mainnet by tooling — the operator sends it.
contract DeployCV is Script {
    address internal constant MAINNET_REGISTRY = 0xa94f27F18267d09349809f3e2AeF8e7767033e8F;
    address internal constant MAINNET_ESCROW = 0x99b331495951dB91857902de91EAe9Ff54d8a719;
    address internal constant MAINNET_ACCOUNT_FACTORY = 0x82e7C593785f726A0A0BB4D37AbCaF2bA4a72dcb;
    address internal constant MULTISIG = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;

    struct Out {
        MemoryAnchor memoryAnchor;
        Endorsements endorsements;
    }

    function run() external {
        AgentRegistry registry = AgentRegistry(vm.envOr("REGISTRY", MAINNET_REGISTRY));
        ServiceEscrow escrow = ServiceEscrow(vm.envOr("ESCROW", MAINNET_ESCROW));
        address accountFactory = vm.envOr("ACCOUNT_FACTORY", MAINNET_ACCOUNT_FACTORY);
        address governance = vm.envOr("GOVERNANCE", MULTISIG);
        require(address(registry).code.length != 0, "REGISTRY has no code");
        require(address(escrow).code.length != 0, "ESCROW has no code");
        require(address(escrow.registry()) == address(registry), "escrow.registry != REGISTRY");
        require(accountFactory == address(0) || accountFactory.code.length != 0, "ACCOUNT_FACTORY has no code");
        require(governance != address(0), "GOVERNANCE");

        uint256 deployBlock = block.number;
        vm.startBroadcast();
        address deployer = msg.sender;
        Out memory o = deployAll(registry, escrow, IAccountFactoryLike(accountFactory), deployer, governance);
        vm.stopBroadcast();

        require(o.memoryAnchor.governance() == governance, "memoryAnchor governance");
        require(o.endorsements.governance() == governance, "endorsements governance");

        console.log("chainId        ", block.chainid);
        console.log("deployer       ", deployer);
        console.log("registry       ", address(registry));
        console.log("escrow         ", address(escrow));
        console.log("accountFactory ", accountFactory);
        console.log("MemoryAnchor   ", address(o.memoryAnchor));
        console.log("Endorsements   ", address(o.endorsements));
        console.log("deployBlock    ", deployBlock);
        console.log("governance     ", governance);

        string memory json = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"registry":"',
            vm.toString(address(registry)),
            '","escrow":"',
            vm.toString(address(escrow)),
            '","agentAccountFactory":"',
            vm.toString(accountFactory),
            '","memoryAnchor":"',
            vm.toString(address(o.memoryAnchor)),
            '","endorsements":"',
            vm.toString(address(o.endorsements)),
            '","governance":"',
            vm.toString(governance),
            '","deployBlockCV":',
            vm.toString(deployBlock),
            "}"
        );
        console.log("deployments-cv json:", json);

        string memory path = string.concat("../deployments-cv.", vm.toString(block.chainid), ".json");
        try vm.writeFile(path, json) {
            console.log("wrote", path);
        } catch {
            console.log("could not write", path, "- copy the JSON line above");
        }
    }

    /// @notice Deploy both contracts with `interimGovernance`, then hand both to `finalGovernance`.
    /// @dev The hand-over is deliberately the LAST thing that happens, and it is one function so the
    ///      test suite exercises the same ordering the broadcast does.
    function deployAll(
        AgentRegistry registry,
        ServiceEscrow escrow,
        IAccountFactoryLike accountFactory,
        address interimGovernance,
        address finalGovernance
    ) public returns (Out memory o) {
        o.memoryAnchor = new MemoryAnchor(registry, accountFactory, interimGovernance);
        o.endorsements = new Endorsements(registry, escrow, accountFactory, interimGovernance);

        // ── hand-over is the LAST step ──
        o.memoryAnchor.setGovernance(finalGovernance);
        o.endorsements.setGovernance(finalGovernance);
    }
}
