// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FerminuxCitizens} from "../src/FerminuxCitizens.sol";

interface IOwned {
    function owner() external view returns (address);
}

/// @notice Deploys Ferminux Citizens from agents/nft/citizens/tiers.json (the single source of truth: name, symbol,
///         tier prices in whole FMX, royalty, and every token's tier), appends ids 1..N, grants CURATOR to the
///         deployer, and STARTS the ownership hand-over to the FerminuxAgents owner. The new owner must call
///         acceptOwnership() (a multisig transaction) to finish it; until then the deployer stays owner.
/// @dev Env (all optional):
///   OWNER             final owner      (default: owner() of FerminuxAgents at FMXA)
///   FMXA              FerminuxAgents   (default mainnet 0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd)
///   TREASURY          withdraw target  (default: OWNER — FerminuxAgents pays its proceeds to its owner too)
///   ROYALTY_RECEIVER  FRC-2981 payee   (default and only allowed value: tiers.json collection.royaltyReceiver,
///                     the fee_recipient that contract.json publishes)
///   TIERS_JSON        (default ../nft/citizens/tiers.json)
///   CITIZENS_OUT      where to write the result (default ../deployments-citizens.<chainid>.json)
///   APPEND_BATCH      ids per appendTokens call (default 200)
/// Refuses to run while any token still has needsReview: true.
contract DeployCitizens is Script {
    address internal constant MAINNET_FMXA = 0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd;

    function _tierIndex(string memory t) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(t));
        if (h == keccak256("Common")) return 0;
        if (h == keccak256("Rare")) return 1;
        if (h == keccak256("Epic")) return 2;
        if (h == keccak256("Legendary")) return 3;
        revert(string.concat("unknown tier: ", t));
    }

    /// Tier index of ids 1..N from tiers.json, after checking the ids run 1..N and no token still needs review.
    function readTiers(string memory json) public pure returns (uint8[] memory tiers) {
        // a [*] path yields several values: the typed parse functions refuse that, so decode the raw array
        string[] memory names = abi.decode(vm.parseJson(json, ".tokens[*].tier"), (string[]));
        uint256[] memory ids = abi.decode(vm.parseJson(json, ".tokens[*].id"), (uint256[]));
        bool[] memory review = abi.decode(vm.parseJson(json, ".tokens[*].needsReview"), (bool[]));
        require(names.length == ids.length && ids.length == review.length && ids.length > 0, "tiers.json: tokens");
        tiers = new uint8[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            require(ids[i] == i + 1, "tiers.json: ids must run 1..N in order");
            require(!review[i], string.concat("tiers.json: #", vm.toString(ids[i]), " still needs review"));
            tiers[i] = _tierIndex(names[i]);
        }
    }

    struct Cfg {
        string name;
        string symbol;
        string base;
        uint96 royaltyBps;
        uint256[4] prices;
        uint8[] tiers;
        address owner;
        address treasury;
        address royaltyReceiver;
        uint256 batch;
    }

    function config() public view returns (Cfg memory k) {
        string memory json = vm.readFile(vm.envOr("TIERS_JSON", string("../nft/citizens/tiers.json")));
        k.name = vm.parseJsonString(json, ".collection.name");
        k.symbol = vm.parseJsonString(json, ".collection.symbol");
        k.base = vm.parseJsonString(json, ".collection.base");
        k.royaltyBps = uint96(vm.parseJsonUint(json, ".collection.royaltyBps"));
        uint256[] memory whole = abi.decode(vm.parseJson(json, ".collection.tiers[*].price"), (uint256[]));
        require(whole.length == 4, "tiers.json: 4 tier prices");
        for (uint256 i = 0; i < 4; i++) k.prices[i] = whole[i] * 1 ether;
        k.tiers = readTiers(json);
        address fmxa = vm.envOr("FMXA", MAINNET_FMXA);
        k.owner = vm.envOr("OWNER", fmxa.code.length != 0 ? IOwned(fmxa).owner() : address(0));
        require(k.owner != address(0), "OWNER unset and FMXA has no owner()");
        k.treasury = vm.envOr("TREASURY", k.owner);
        // contract.json publishes collection.royaltyReceiver to marketplaces (fee_recipient), so the chain must pay the
        // same address: to change it, edit tiers.json and run build-meta.mjs, not only the env.
        address published = vm.parseJsonAddress(json, ".collection.royaltyReceiver");
        k.royaltyReceiver = vm.envOr("ROYALTY_RECEIVER", published);
        require(
            k.royaltyReceiver == published,
            "ROYALTY_RECEIVER differs from tiers.json collection.royaltyReceiver (contract.json): edit tiers.json and rebuild"
        );
        k.batch = vm.envOr("APPEND_BATCH", uint256(200));
    }

    function run() external returns (FerminuxCitizens c) {
        Cfg memory k = config();
        vm.startBroadcast();
        address deployer = msg.sender;
        uint256 deployBlock = block.number;
        // the deployer is the interim owner so the set-up below runs in this script; hand-over is the LAST step
        c = new FerminuxCitizens(
            k.name,
            k.symbol,
            deployer,
            k.prices,
            string.concat(k.base, "/meta/"),
            string.concat(k.base, "/contract.json"),
            k.treasury,
            k.royaltyReceiver,
            k.royaltyBps
        );
        _append(c, k.tiers, k.batch);
        c.grantCurator(deployer);
        if (k.owner != deployer) c.transferOwnership(k.owner);
        vm.stopBroadcast();

        require(c.totalIds() == k.tiers.length, "totalIds");
        require(c.isCurator(deployer), "curator");
        require(k.owner == deployer || c.pendingOwner() == k.owner, "pending owner");
        _report(c, k, deployer, deployBlock);
    }

    function _append(FerminuxCitizens c, uint8[] memory tiers, uint256 batch) internal {
        for (uint256 from = 0; from < tiers.length; from += batch) {
            uint256 n = tiers.length - from < batch ? tiers.length - from : batch;
            uint8[] memory part = new uint8[](n);
            for (uint256 i = 0; i < n; i++) part[i] = tiers[from + i];
            c.appendTokens(part);
        }
    }

    function _report(FerminuxCitizens c, Cfg memory k, address deployer, uint256 deployBlock) internal {
        console.log("chainId          ", block.chainid);
        console.log("FerminuxCitizens ", address(c));
        console.log("name / symbol    ", k.name, k.symbol);
        console.log("totalIds         ", c.totalIds());
        console.log("deployer/curator ", deployer);
        console.log("pendingOwner     ", c.pendingOwner());
        console.log("treasury         ", k.treasury);
        console.log("royalty          ", k.royaltyReceiver, k.royaltyBps);
        console.log("deployBlock      ", deployBlock);

        string memory out = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"citizens":"',
            vm.toString(address(c)),
            '","citizensDeployBlock":',
            vm.toString(deployBlock),
            ',"citizensCurator":"',
            vm.toString(deployer),
            '","citizensOwner":"',
            vm.toString(k.owner),
            '"}'
        );
        console.log("deployments-citizens json:", out);
        string memory path =
            vm.envOr("CITIZENS_OUT", string.concat("../deployments-citizens.", vm.toString(block.chainid), ".json"));
        try vm.writeFile(path, out) {
            console.log("wrote", path);
        } catch {
            console.log("could not write", path, "- copy the JSON line above");
        }
    }
}

/// @notice Appends the ids in tiers.json that the contract does not have yet (the next folder of artwork).
///         Signed by a curator (the deployer key). Env: CITIZENS (address), TIERS_JSON (optional).
contract AppendCitizens is Script {
    function run() external {
        FerminuxCitizens c = FerminuxCitizens(vm.envAddress("CITIZENS"));
        string memory json = vm.readFile(vm.envOr("TIERS_JSON", string("../nft/citizens/tiers.json")));
        DeployCitizens d = new DeployCitizens();
        uint8[] memory tiers = d.readTiers(json);
        uint256 have = c.totalIds();
        require(tiers.length > have, "tiers.json has no ids beyond totalIds()");
        // tiers already on chain must agree with the file, except ids re-tiered on chain after minting was blocked
        for (uint256 i = 0; i < have; i++) {
            if (c.tierOf(i + 1) != tiers[i]) console.log("note: on-chain tier differs for id", i + 1);
        }
        uint8[] memory part = new uint8[](tiers.length - have);
        for (uint256 i = 0; i < part.length; i++) part[i] = tiers[have + i];
        vm.startBroadcast();
        c.appendTokens(part);
        vm.stopBroadcast();
        console.log("appended ids", have + 1, "to", c.totalIds());
    }
}
