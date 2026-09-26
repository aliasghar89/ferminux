// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ValidatorHub} from "../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../src/validators/ValidatorHubLens.sol";
import {SinkRouter} from "../src/validators/SinkRouter.sol";
import {FMXRewardSink} from "../test/validators/utils/FMXRewardSink.sol";

/// @notice Validator hub deploy for a devnet, the lab or the public testnet. Mainnet has its own
///         operator-only script (DeployValidatorsMainnet).
///
///         The lab (infra/lab) runs a copy of mainnet: network id 39610 but chain id 3961, the
///         same as mainnet. On chain id 3961 this script therefore refuses to run unless LAB is
///         true and OWNER is set to a lab key that is not the mainnet multisig, and it creates the
///         lab hub from inside LabHubDeployer: with an equal chain id, a hub at the mainnet hub's
///         address would have the mainnet signature domain, and a rehearsal from the mainnet
///         deployer key at the same nonce would otherwise land exactly there.
/// @dev Env (all optional):
///   OWNER             hub and router owner                (default: the broadcaster)
///   SINK              existing FMXRewardSink              (default: deploy a fresh one owned by OWNER)
///   RESERVE           router's non-validator share        (default: OWNER)
///   DENY              comma-separated seat owners refused (default: none)
///   TRANCHE           wei sent to hub.fund() at deploy    (default: 0)
///   WRITE_DEPLOYMENTS true to write ../deployments-validators.<chainid>.json (".lab.json" on the lab)
///   LAB               true only on the lab (chain id 3961, network id 39610)
///
/// Dry run:   forge script script/DeployValidatorsTestnet.s.sol --rpc-url <testnet rpc>
/// Broadcast: add --broadcast --private-key $KEY --priority-gas-price 1gwei
contract DeployValidatorsTestnet is Script {
    struct Out {
        address sink;
        ValidatorHub hub;
        ValidatorHubLens lens;
        SinkRouter router;
    }

    address internal constant MAINNET_MULTISIG = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;

    function run() external {
        address owner = vm.envOr("OWNER", address(0));
        if (block.chainid == 3961) {
            require(vm.envOr("LAB", false), "chain 3961: use DeployValidatorsMainnet (operator only)");
            require(owner != address(0) && owner != MAINNET_MULTISIG, "LAB needs OWNER set to a lab key");
            console.log("LAB deploy on chain id 3961: make sure the RPC is the lab, not mainnet");
        }
        address sinkAddr = vm.envOr("SINK", address(0));
        address reserve = vm.envOr("RESERVE", address(0));
        uint256 tranche = vm.envOr("TRANCHE", uint256(0));
        address[] memory deny = vm.envOr("DENY", ",", new address[](0));

        uint256 deployBlock = block.number;
        vm.startBroadcast();
        address deployer = msg.sender;
        if (owner == address(0)) owner = deployer;
        if (reserve == address(0)) reserve = owner;
        Out memory o = deployAll(owner, sinkAddr, reserve, deny);
        if (tranche != 0) o.hub.fund{value: tranche}();
        vm.stopBroadcast();

        require(o.hub.owner() == owner && o.router.owner() == owner, "owner");
        require(o.hub.rewardSink() == o.sink, "sink");

        console.log("chainId       ", block.chainid);
        console.log("deployer      ", deployer);
        console.log("owner         ", owner);
        console.log("FMXRewardSink ", o.sink);
        console.log("ValidatorHub  ", address(o.hub));
        console.log("SealEvidence  ", address(o.hub.sealEvidence()));
        console.log("Lens          ", address(o.lens));
        console.log("SinkRouter    ", address(o.router));
        console.log("rewardPool    ", o.hub.rewardPool());

        if (vm.envOr("WRITE_DEPLOYMENTS", false)) {
            string memory json = string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"validatorHub":"',
                vm.toString(address(o.hub)),
                '","validatorHubLens":"',
                vm.toString(address(o.lens)),
                '","sinkRouter":"',
                vm.toString(address(o.router)),
                '","rewardSink":"',
                vm.toString(o.sink),
                '","owner":"',
                vm.toString(owner),
                '","deployBlock":',
                vm.toString(deployBlock),
                "}"
            );
            // the lab shares chain id 3961 with mainnet: never write a file that looks like mainnet's
            string memory tag = block.chainid == 3961 ? "lab" : vm.toString(block.chainid);
            string memory path = string.concat("../deployments-validators.", tag, ".json");
            vm.writeFile(path, json);
            console.log("wrote", path);
        }
    }

    /// @notice Everything the broadcast deploys, as one function the tests exercise.
    function deployAll(address owner, address sinkAddr, address reserve, address[] memory deny)
        public
        returns (Out memory o)
    {
        if (sinkAddr == address(0)) sinkAddr = address(new FMXRewardSink(owner));
        o.sink = sinkAddr;
        o.hub = block.chainid == 3961
            ? new LabHubDeployer(owner, sinkAddr, deny).hub()
            : new ValidatorHub(owner, sinkAddr, deny);
        o.lens = new ValidatorHubLens(o.hub);
        o.router = new SinkRouter(owner, sinkAddr, address(o.hub), reserve);
    }
}

/// @notice Creates the lab hub in its constructor, so the hub's address is derived from this
///         contract (nonce 1) and can never equal a hub created directly from an EOA, as the
///         mainnet script does. Holds nothing and has no functions besides the getter.
contract LabHubDeployer {
    ValidatorHub public immutable hub;

    constructor(address owner, address sink, address[] memory deny) {
        hub = new ValidatorHub(owner, sink, deny);
    }
}
