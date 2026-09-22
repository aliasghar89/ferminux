// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {IdentityRegistry8004} from "../src/erc8004/IdentityRegistry8004.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract IdentityRegistry8004Test is BaseTest {
    IdentityRegistry8004 internal id8004;
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        id8004 = new IdentityRegistry8004(registry);
        agentId = _registerAlice();
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(IdentityRegistry8004.ZeroAddress.selector);
        new IdentityRegistry8004(AgentRegistry(address(0)));
    }

    function test_metadata() public view {
        assertEq(id8004.name(), "AgentIdentity");
        assertEq(id8004.symbol(), "AGENT");
        assertTrue(id8004.supportsInterface(0x01ffc9a7));
        assertTrue(id8004.supportsInterface(0x80ac58cd));
        assertTrue(id8004.supportsInterface(0x5b5e139f));
        assertFalse(id8004.supportsInterface(0xdeadbeef));
        assertEq(id8004.getVersion(), "ferminux-2.0.0");
    }

    function test_ownerOf_mirrorsRegistry() public {
        assertEq(id8004.ownerOf(agentId), alice);
        assertEq(id8004.getAgentWallet(agentId), alice);
        vm.prank(alice);
        registry.transferOwnership(agentId, bob);
        assertEq(id8004.ownerOf(agentId), bob);
        assertEq(id8004.getAgentWallet(agentId), bob);
    }

    function test_ownerOf_nonexistentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 99));
        id8004.ownerOf(99);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 0));
        id8004.getAgentWallet(0);
    }

    function test_retiredAgentStillExists() public {
        vm.prank(alice);
        registry.retire(agentId);
        assertEq(id8004.ownerOf(agentId), alice);
    }

    function test_balanceOfAndTotalSupply() public {
        assertEq(id8004.balanceOf(alice), 1);
        assertEq(id8004.balanceOf(bob), 0);
        _register(alice, MIN_BOND);
        _register(bob, MIN_BOND);
        assertEq(id8004.balanceOf(alice), 2);
        assertEq(id8004.balanceOf(bob), 1);
        assertEq(id8004.totalSupply(), 3);
        vm.expectRevert(IdentityRegistry8004.ZeroAddress.selector);
        id8004.balanceOf(address(0));
    }

    function test_agentURI_defaultAndCustom() public {
        assertEq(id8004.agentURI(agentId), "https://ferminux.net/api/agents/1/erc8004.json");
        assertEq(id8004.tokenURI(agentId), "https://ferminux.net/api/agents/1/erc8004.json");
        vm.prank(bob);
        vm.expectRevert(IdentityRegistry8004.NotAuthorized.selector);
        id8004.setAgentURI(agentId, "ipfs://x");
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IdentityRegistry8004.URIUpdated(agentId, "ipfs://x", alice);
        id8004.setAgentURI(agentId, "ipfs://x");
        assertEq(id8004.agentURI(agentId), "ipfs://x");
        vm.prank(alice);
        id8004.setAgentURI(agentId, "");
        assertEq(id8004.agentURI(agentId), "https://ferminux.net/api/agents/1/erc8004.json");
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 12));
        id8004.agentURI(12);
    }

    function test_agentURI_multiDigitId() public {
        vm.deal(bob, 5_000 ether);
        for (uint256 i = 0; i < 11; i++) {
            _register(bob, MIN_BOND);
        }
        assertEq(id8004.agentURI(12), "https://ferminux.net/api/agents/12/erc8004.json");
    }

    function test_setMetadata_ownerOnly() public {
        vm.prank(bob);
        vm.expectRevert(IdentityRegistry8004.NotAuthorized.selector);
        id8004.setMetadata(agentId, "validator", abi.encodePacked(carol));
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IdentityRegistry8004.MetadataSet(agentId, "validator", "validator", abi.encodePacked(carol));
        id8004.setMetadata(agentId, "validator", abi.encodePacked(carol));
        assertEq(id8004.getMetadata(agentId, "validator"), abi.encodePacked(carol));
        assertEq(id8004.getMetadata(agentId, "missing").length, 0);
    }

    function test_agentWalletKeyReserved() public {
        vm.prank(alice);
        vm.expectRevert(IdentityRegistry8004.ReservedKey.selector);
        id8004.setMetadata(agentId, "agentWallet", abi.encodePacked(bob));
        assertEq(id8004.getMetadata(agentId, "agentWallet"), abi.encodePacked(alice));
        assertEq(id8004.getMetadata(42, "agentWallet").length, 0);
        vm.prank(alice);
        vm.expectRevert(IdentityRegistry8004.AgentWalletIsRegistryOwner.selector);
        id8004.setAgentWallet(agentId, bob, block.timestamp, "");
        vm.prank(alice);
        vm.expectRevert(IdentityRegistry8004.AgentWalletIsRegistryOwner.selector);
        id8004.unsetAgentWallet(agentId);
    }

    function test_registerOverloadsRevert() public {
        vm.expectRevert(IdentityRegistry8004.RegistrationViaAgentRegistry.selector);
        id8004.register();
        vm.expectRevert(IdentityRegistry8004.RegistrationViaAgentRegistry.selector);
        id8004.register("uri");
        IdentityRegistry8004.MetadataEntry[] memory m;
        vm.expectRevert(IdentityRegistry8004.RegistrationViaAgentRegistry.selector);
        id8004.register("uri", m);
    }

    function test_transfersAndApprovalsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(IdentityRegistry8004.UseAgentRegistryTransferOwnership.selector);
        id8004.transferFrom(alice, bob, agentId);
        vm.expectRevert(IdentityRegistry8004.UseAgentRegistryTransferOwnership.selector);
        id8004.safeTransferFrom(alice, bob, agentId);
        vm.expectRevert(IdentityRegistry8004.UseAgentRegistryTransferOwnership.selector);
        id8004.safeTransferFrom(alice, bob, agentId, "");
        vm.expectRevert(IdentityRegistry8004.UseAgentRegistryTransferOwnership.selector);
        id8004.approve(bob, agentId);
        vm.expectRevert(IdentityRegistry8004.UseAgentRegistryTransferOwnership.selector);
        id8004.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(id8004.getApproved(agentId), address(0));
        assertFalse(id8004.isApprovedForAll(alice, bob));
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 5));
        id8004.getApproved(5);
    }

    function test_isAuthorizedOrOwner() public {
        assertTrue(id8004.isAuthorizedOrOwner(alice, agentId));
        assertFalse(id8004.isAuthorizedOrOwner(bob, agentId));
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 9));
        id8004.isAuthorizedOrOwner(alice, 9);
    }
}
