// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {MemoryAnchor} from "../src/MemoryAnchor.sol";
import {Endorsements} from "../src/Endorsements.sol";
import {DeployCV} from "../script/DeployCV.s.sol";
import {IAccountFactoryLike} from "../src/lib/IAccount.sol";

/// @dev Exercises the deploy script's ordering: both contracts land wired to the live registry /
///      escrow / account factory, and governance of BOTH is the multisig once the script returns.
contract DeployCVTest is Test {
    AgentRegistry internal registry;
    ServiceEscrow internal escrow;
    AgentAccountFactory internal factory;
    DeployCV internal script;

    address internal multisig = makeAddr("multisig");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        registry = new AgentRegistry(address(this), 0);
        escrow = new ServiceEscrow(registry, address(this), treasury);
        registry.setEscrow(address(escrow));
        factory = new AgentAccountFactory();
        script = new DeployCV();
    }

    function test_deployAll_handsGovernanceToTheMultisigLast() public {
        DeployCV.Out memory o =
            script.deployAll(registry, escrow, IAccountFactoryLike(address(factory)), address(script), multisig);

        MemoryAnchor anchors = o.memoryAnchor;
        Endorsements endorsements = o.endorsements;

        assertEq(anchors.governance(), multisig, "MemoryAnchor governance is the multisig");
        assertEq(endorsements.governance(), multisig, "Endorsements governance is the multisig");

        assertEq(address(anchors.registry()), address(registry));
        assertEq(address(anchors.accountFactory()), address(factory));
        assertEq(address(endorsements.registry()), address(registry));
        assertEq(address(endorsements.escrow()), address(escrow));
        assertEq(address(endorsements.accountFactory()), address(factory));

        // the interim governance is powerless the moment the script returns
        vm.prank(address(script));
        vm.expectRevert(MemoryAnchor.NotGovernance.selector);
        anchors.setMaxUriBytes(1);
        vm.prank(address(script));
        vm.expectRevert(Endorsements.NotGovernance.selector);
        endorsements.setWeightCap(1);

        // and the multisig can govern both
        vm.prank(multisig);
        anchors.setMaxUriBytes(128);
        assertEq(anchors.maxUriBytes(), 128);
        vm.prank(multisig);
        endorsements.setWeightCap(500);
        assertEq(endorsements.weightCap(), 500);
    }

    function test_deployAll_worksWithoutAnAccountFactory() public {
        DeployCV.Out memory o =
            script.deployAll(registry, escrow, IAccountFactoryLike(address(0)), address(script), multisig);
        assertEq(address(o.memoryAnchor.accountFactory()), address(0));
        assertEq(o.endorsements.governance(), multisig);
    }
}
