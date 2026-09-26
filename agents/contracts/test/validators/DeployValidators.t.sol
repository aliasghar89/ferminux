// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {SinkRouter} from "../../src/validators/SinkRouter.sol";
import {ValidatorHubLens} from "../../src/validators/ValidatorHubLens.sol";
import {DeployValidatorsTestnet} from "../../script/DeployValidatorsTestnet.s.sol";
import {DeployValidatorsMainnet} from "../../script/DeployValidatorsMainnet.s.sol";

/// @notice Exercises the deploy scripts' functions inside the test EVM only. Nothing here talks to
///         a network or broadcasts; the mainnet script's pinned constants and post-deploy checks
///         run under vm.chainId(3961).
contract DeployValidatorsTest is Test {
    function test_Testnet_DeploysWiredStack() public {
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        address owner = makeAddr("owner");
        address reserve = makeAddr("reserve");
        address[] memory deny = new address[](1);
        deny[0] = makeAddr("premine");
        DeployValidatorsTestnet.Out memory o = s.deployAll(owner, address(0), reserve, deny);
        assertEq(o.hub.owner(), owner);
        assertEq(o.hub.rewardSink(), o.sink);
        assertTrue(o.hub.denied(deny[0]));
        assertEq(address(o.lens.hub()), address(o.hub));
        assertEq(o.router.owner(), owner);
        assertEq(o.router.reserve(), reserve);
        assertEq(address(o.router.sink()), o.sink);
        assertEq(o.router.hub(), address(o.hub));
        assertEq(o.hub.maxSeats(), 100);
    }

    /// The lab shares chain id 3961 with mainnet, so its hub must never share the mainnet hub's
    /// address (and with it the signature domain), even when deployed by the same key at the
    /// same nonce the mainnet script would use.
    function test_Lab_HubAddressNeverEqualsADirectDeploy() public {
        vm.chainId(3961);
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        address owner = makeAddr("lab-owner");
        uint64 nonce = vm.getNonce(address(s));
        address direct = vm.computeCreateAddress(address(s), nonce + 1); // the slot after the sink
        DeployValidatorsTestnet.Out memory o = s.deployAll(owner, address(0), owner, new address[](0));
        address factory = vm.computeCreateAddress(address(s), nonce + 1);
        assertEq(address(o.hub), vm.computeCreateAddress(factory, 1), "hub created by LabHubDeployer");
        assertTrue(address(o.hub) != direct, "not where a direct deploy from the same key and nonce lands");
        assertEq(o.hub.owner(), owner);
        assertEq(o.hub.rewardSink(), o.sink);
        assertEq(address(o.lens.hub()), address(o.hub));
        assertEq(o.router.hub(), address(o.hub));
        // off 3961 (devnet, public testnet) the hub is created directly
        vm.chainId(39_611);
        nonce = vm.getNonce(address(s));
        o = s.deployAll(owner, address(0), owner, new address[](0));
        assertEq(address(o.hub), vm.computeCreateAddress(address(s), nonce + 1));
    }

    function test_Testnet_RefusesChain3961UnlessLab() public {
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        vm.chainId(3961);
        vm.expectRevert(bytes("chain 3961: use DeployValidatorsMainnet (operator only)"));
        s.run();
        vm.setEnv("LAB", "true");
        vm.setEnv("OWNER", "0x910BD467D8576277f8f96DF47428377FFD94fEfe");
        vm.expectRevert(bytes("LAB needs OWNER set to a lab key"));
        s.run();
        vm.setEnv("LAB", "false");
        vm.setEnv("OWNER", "0x0000000000000000000000000000000000000000");
    }

    function test_Mainnet_DeploysPinnedOwnerSinkAndDenyList() public {
        DeployValidatorsMainnet s = new DeployValidatorsMainnet();
        vm.chainId(3961);
        (ValidatorHub hub, ValidatorHubLens lens) = s.deployHub();
        s.checkHub(hub);
        assertEq(address(lens.hub()), address(hub));
        assertTrue(hub.denied(0xc0A5Eb613f859f072554F29f1Ab7400265af15aB), "treasury / first premine");
        assertTrue(hub.denied(0x910BD467D8576277f8f96DF47428377FFD94fEfe), "multisig");
        SinkRouter router = s.deployRouter(hub);
        assertEq(router.shareBps(), 4_000);
        assertEq(router.reserve(), 0x910BD467D8576277f8f96DF47428377FFD94fEfe);
    }

    function test_Mainnet_RunRefusesWithoutChainAndConfirmation() public {
        DeployValidatorsMainnet s = new DeployValidatorsMainnet();
        vm.expectRevert(bytes("chain 3961 only"));
        s.run();
        vm.chainId(3961);
        vm.expectRevert(bytes("set CONFIRM_MAINNET: operator-only mainnet deploy"));
        s.run();
    }
}
