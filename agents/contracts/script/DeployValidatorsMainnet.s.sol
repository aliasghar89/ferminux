// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ValidatorHub} from "../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../src/validators/ValidatorHubLens.sol";
import {SinkRouter} from "../src/validators/SinkRouter.sol";

/// @notice MAINNET (chain 3961) validator hub deploy. NEVER run by tooling, CI or an agent.
///         The operator runs it by hand, and only when every gate in PLAN section 9 is met:
///           - phase 0 exit criteria (5/5 signers live on at least 3 providers);
///           - the section 10.1 lab checklist all PASS with evidence in infra/lab/evidence/;
///           - the 14-day public testnet run and the external audit of the hub are done;
///           - the 7-day public notice with the section 12.1 wording has gone out.
///
///         Step A (phase 1d): deploy ValidatorHub (maxSeats 100, owner = the multisig, sink =
///         FMXRewardSink, deny list = the genesis premine wallets, the multisig and the sink)
///         and its read-only lens. Then the multisig, not this script, funds the pool:
///             sink.withdraw(<hub>, 20000 ether)          (check sink balance on-chain first)
///         Step B (phase 1e, after 30 clean days): ROUTER=true HUB=<hub> deploys SinkRouter; the
///         multisig then calls sink.transferOwnership(<router>) and router.acceptSinkOwnership().
///
/// @dev Guards: chain id must be 3961 and CONFIRM_MAINNET must equal CONFIRMATION. The hub's
///      constructor pins nothing (the lab shares chain id 3961), so checkHub() re-reads the owner,
///      sink, launch parameters and deny list after the deploy. Never rehearse this script on the
///      lab: with the mainnet deployer key at the same nonce the lab hub would take the mainnet
///      hub's address and so its signature domain (DeployValidatorsTestnet with LAB=true is the
///      lab path).
///
///   CONFIRM_MAINNET=deploy-validator-hub-3961-after-audit \
///   forge script script/DeployValidatorsMainnet.s.sol --rpc-url https://rpc.ferminux.net \
///     --broadcast --private-key $KEY --priority-gas-price 1gwei
contract DeployValidatorsMainnet is Script {
    string public constant CONFIRMATION = "deploy-validator-hub-3961-after-audit";
    address public constant MULTISIG = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;
    address public constant REWARD_SINK = 0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6;

    function run() external {
        require(block.chainid == 3961, "chain 3961 only");
        require(
            keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256(bytes(CONFIRMATION)),
            "set CONFIRM_MAINNET: operator-only mainnet deploy"
        );
        bool routerStep = vm.envOr("ROUTER", false);

        vm.startBroadcast();
        if (!routerStep) {
            (ValidatorHub hub, ValidatorHubLens lens) = deployHub();
            vm.stopBroadcast();
            checkHub(hub);
            console.log("ValidatorHub     ", address(hub));
            console.log("SealEvidence     ", address(hub.sealEvidence()));
            console.log("ValidatorHubLens ", address(lens));
            console.log("deployBlock      ", hub.deployBlock());
            console.log("vetoSunsetBlock  ", hub.vetoSunsetBlock());
            console.log("NEXT (multisig): check sink balance, then sink.withdraw(hub, 20000 ether)");
        } else {
            ValidatorHub hub = ValidatorHub(payable(vm.envAddress("HUB")));
            checkWiring(hub);
            SinkRouter router = deployRouter(hub);
            vm.stopBroadcast();
            require(router.owner() == MULTISIG && router.reserve() == MULTISIG, "router owner/reserve");
            require(address(router.sink()) == REWARD_SINK && router.hub() == address(hub), "router wiring");
            console.log("SinkRouter       ", address(router));
            console.log("NEXT (multisig): sink.transferOwnership(router), then router.acceptSinkOwnership()");
        }
    }

    /// @notice Seat owners refused as policy (PLAN 3.1): the five genesis premine wallets (the
    ///         first is also the treasury), the multisig and the reward sink.
    function denyList() public pure returns (address[] memory d) {
        d = new address[](7);
        d[0] = 0xc0A5Eb613f859f072554F29f1Ab7400265af15aB;
        d[1] = 0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787;
        d[2] = 0x86e286684Ae5899A941142D143949C444F9Fe831;
        d[3] = 0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE;
        d[4] = 0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC;
        d[5] = MULTISIG;
        d[6] = REWARD_SINK;
    }

    function deployHub() public returns (ValidatorHub hub, ValidatorHubLens lens) {
        hub = new ValidatorHub(MULTISIG, REWARD_SINK, denyList());
        lens = new ValidatorHubLens(hub);
    }

    function deployRouter(ValidatorHub hub) public returns (SinkRouter router) {
        router = new SinkRouter(MULTISIG, REWARD_SINK, address(hub), MULTISIG);
    }

    function checkWiring(ValidatorHub hub) public view {
        require(address(hub).code.length != 0, "HUB has no code");
        require(hub.owner() == MULTISIG, "hub owner");
        require(hub.rewardSink() == REWARD_SINK, "hub sink");
    }

    /// Launch state of a freshly deployed hub (PLAN 3.1 and 13.3-13.4).
    function checkHub(ValidatorHub hub) public view {
        checkWiring(hub);
        require(hub.maxSeats() == 100, "maxSeats at launch");
        require(hub.rewardPerAttest() == 0.025 ether, "rewardPerAttest");
        require(hub.activationsPerDay() == 10, "activations per day");
        address[] memory d = denyList();
        for (uint256 i; i < d.length; ++i) {
            require(hub.denied(d[i]), "deny list");
        }
    }
}
