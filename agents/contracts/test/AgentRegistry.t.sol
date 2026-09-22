// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest, Reenterer, Rejecter} from "./Base.t.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is BaseTest {
    // ───────────────────────────── deployment ─────────────────────────────

    function test_deployState() public view {
        assertEq(registry.minBond(), MIN_BOND);
        assertEq(registry.governance(), gov);
        assertEq(registry.escrow(), address(escrow));
        assertEq(registry.nextId(), 0);
        assertEq(registry.BOND_COOLDOWN(), 7 days);
    }

    function test_constructor_revertsZeroGovernance() public {
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        new AgentRegistry(address(0), 1);
    }

    // ───────────────────────────── register ─────────────────────────────

    function test_register_happyPath() public {
        vm.expectEmit(true, true, false, true);
        emit AgentRegistry.AgentRegistered(
            1, alice, "Scribe", "https://scribe.example", "fmx://payload/0xabc", PRICE, MIN_BOND
        );
        uint256 id = _registerAlice();
        assertEq(id, 1);
        assertEq(registry.nextId(), 1);

        AgentRegistry.Agent memory a = registry.getAgent(id);
        assertEq(a.owner, alice);
        assertEq(a.name, "Scribe");
        assertEq(a.endpoint, "https://scribe.example");
        assertEq(a.metadataURI, "fmx://payload/0xabc");
        assertEq(a.pricePerJob, PRICE);
        assertEq(a.bond, MIN_BOND);
        assertEq(a.registeredAt, uint64(block.timestamp));
        assertEq(a.retiredAt, 0);
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.Active));
        assertEq(a.jobsCompleted, 0);
        assertEq(a.ratingCount, 0);
        assertTrue(registry.isActive(id));
        assertEq(address(registry).balance, MIN_BOND);
    }

    function test_register_idsIncrement() public {
        assertEq(_register(alice, MIN_BOND), 1);
        assertEq(_register(bob, MIN_BOND), 2);
        assertEq(_register(alice, MIN_BOND + 1), 3);
        assertEq(registry.nextId(), 3);
    }

    function test_register_revertsBelowMinBond() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InsufficientBond.selector, MIN_BOND - 1, MIN_BOND));
        registry.register{value: MIN_BOND - 1}("x", "", "", 0);
    }

    function test_register_acceptsBondAboveMin() public {
        uint256 id = _register(alice, 250 ether);
        assertEq(registry.getAgent(id).bond, 250 ether);
    }

    function test_register_revertsEmptyName() public {
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register{value: MIN_BOND}("", "", "", 0);
    }

    function test_register_revertsNameTooLong() public {
        string memory name65 = string(new bytes(65));
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register{value: MIN_BOND}(name65, "", "", 0);
    }

    function test_register_acceptsName64() public {
        string memory name64 = string(new bytes(64));
        vm.prank(alice);
        uint256 id = registry.register{value: MIN_BOND}(name64, "", "", 0);
        assertEq(bytes(registry.getAgent(id).name).length, 64);
    }

    function test_register_revertsEndpointTooLong() public {
        string memory s257 = string(new bytes(257));
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.StringTooLong.selector);
        registry.register{value: MIN_BOND}("x", s257, "", 0);
    }

    function test_register_revertsMetadataTooLong() public {
        string memory s257 = string(new bytes(257));
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.StringTooLong.selector);
        registry.register{value: MIN_BOND}("x", "", s257, 0);
    }

    function test_register_accepts256ByteStrings() public {
        string memory s256 = string(new bytes(256));
        vm.prank(alice);
        uint256 id = registry.register{value: MIN_BOND}("x", s256, s256, 0);
        assertEq(bytes(registry.getAgent(id).endpoint).length, 256);
    }

    // ───────────────────────────── update ─────────────────────────────

    function test_update_ownerOnly() public {
        uint256 id = _registerAlice();
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.update(id, "e", "m", 2 ether);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit AgentRegistry.AgentUpdated(id, "e", "m", 2 ether);
        registry.update(id, "e", "m", 2 ether);
        AgentRegistry.Agent memory a = registry.getAgent(id);
        assertEq(a.endpoint, "e");
        assertEq(a.metadataURI, "m");
        assertEq(a.pricePerJob, 2 ether);
        assertEq(a.name, "Scribe"); // unchanged
    }

    function test_update_revertsUnknownAgent() public {
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.UnknownAgent.selector);
        registry.update(42, "e", "m", 0);
    }

    function test_update_validatesLengths() public {
        uint256 id = _registerAlice();
        string memory s257 = string(new bytes(257));
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.StringTooLong.selector);
        registry.update(id, s257, "", 0);
    }

    // ───────────────────────────── status ─────────────────────────────

    function test_setStatus_activePausedToggle() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit AgentRegistry.AgentStatusChanged(id, AgentRegistry.Status.Paused);
        registry.setStatus(id, AgentRegistry.Status.Paused);
        assertEq(uint8(registry.getAgent(id).status), uint8(AgentRegistry.Status.Paused));
        assertFalse(registry.isActive(id));

        vm.prank(alice);
        registry.setStatus(id, AgentRegistry.Status.Active);
        assertTrue(registry.isActive(id));
    }

    function test_setStatus_rejectsInvalidTransitions() public {
        uint256 id = _registerAlice();
        vm.startPrank(alice);
        vm.expectRevert(AgentRegistry.InvalidStatusTransition.selector);
        registry.setStatus(id, AgentRegistry.Status.Active); // already active
        vm.expectRevert(AgentRegistry.InvalidStatusTransition.selector);
        registry.setStatus(id, AgentRegistry.Status.Retired); // must use retire()
        vm.expectRevert(AgentRegistry.InvalidStatusTransition.selector);
        registry.setStatus(id, AgentRegistry.Status.None);
        registry.retire(id);
        vm.expectRevert(AgentRegistry.InvalidStatusTransition.selector);
        registry.setStatus(id, AgentRegistry.Status.Active); // cannot un-retire
        vm.stopPrank();
    }

    function test_setStatus_ownerOnly() public {
        uint256 id = _registerAlice();
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.setStatus(id, AgentRegistry.Status.Paused);
    }

    function test_retire_fromActiveAndPaused() public {
        uint256 a1 = _register(alice, MIN_BOND);
        uint256 a2 = _register(alice, MIN_BOND);
        vm.startPrank(alice);
        registry.setStatus(a2, AgentRegistry.Status.Paused);
        registry.retire(a1);
        registry.retire(a2);
        vm.stopPrank();
        assertEq(uint8(registry.getAgent(a1).status), uint8(AgentRegistry.Status.Retired));
        assertEq(registry.getAgent(a1).retiredAt, uint64(block.timestamp));
        assertEq(uint8(registry.getAgent(a2).status), uint8(AgentRegistry.Status.Retired));
        assertFalse(registry.isActive(a1));
    }

    function test_retire_twiceReverts() public {
        uint256 id = _registerAlice();
        vm.startPrank(alice);
        registry.retire(id);
        vm.expectRevert(AgentRegistry.InvalidStatusTransition.selector);
        registry.retire(id);
        vm.stopPrank();
    }

    // ───────────────────────────── bond ─────────────────────────────

    function test_withdrawBond_afterCooldown() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.retire(id);
        uint64 retiredAt = registry.getAgent(id).retiredAt;

        vm.warp(retiredAt + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CooldownActive.selector, retiredAt + 7 days));
        registry.withdrawBond(id);

        vm.warp(retiredAt + 7 days);
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit AgentRegistry.BondChanged(id, 0);
        registry.withdrawBond(id);
        assertEq(alice.balance - before, MIN_BOND);
        assertEq(registry.getAgent(id).bond, 0);
        assertEq(address(registry).balance, 0);

        // second withdrawal has nothing left
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NothingToWithdraw.selector);
        registry.withdrawBond(id);
    }

    function test_withdrawBond_revertsIfNotRetired() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotRetired.selector);
        registry.withdrawBond(id);
    }

    function test_withdrawBond_ownerOnly() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.retire(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.withdrawBond(id);
    }

    function test_withdrawBond_reentrancyBlocked() public {
        Reenterer evil = new Reenterer(escrow, registry);
        uint256 id = evil.register{value: MIN_BOND}("evil"); // bond funded by this test contract
        // a second honest agent so the registry holds more than evil's bond
        _register(alice, MIN_BOND);
        evil.retire();
        vm.warp(block.timestamp + 7 days);
        evil.withdrawBond();
        assertFalse(evil.reentered());
        assertEq(address(evil).balance, MIN_BOND);
        assertEq(address(registry).balance, MIN_BOND);
        assertEq(registry.getAgent(id).bond, 0);
    }

    function test_withdrawBond_revertsWhenReceiverRejects() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), MIN_BOND);
        vm.prank(address(r));
        uint256 id = registry.register{value: MIN_BOND}("r", "", "", 0);
        vm.prank(address(r));
        registry.retire(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(address(r));
        vm.expectRevert(AgentRegistry.TransferFailed.selector);
        registry.withdrawBond(id);
        assertEq(registry.getAgent(id).bond, MIN_BOND); // state rolled back
    }

    function test_topUpBond_anyoneCanTopUp() public {
        uint256 id = _registerAlice();
        vm.prank(carol);
        vm.expectEmit(true, false, false, true);
        emit AgentRegistry.BondChanged(id, MIN_BOND + 5 ether);
        registry.topUpBond{value: 5 ether}(id);
        assertEq(registry.getAgent(id).bond, MIN_BOND + 5 ether);
        assertEq(address(registry).balance, MIN_BOND + 5 ether);
    }

    function test_topUpBond_revertsZeroOrUnknown() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.topUpBond{value: 0}(id);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.UnknownAgent.selector);
        registry.topUpBond{value: 1}(99);
    }

    function test_minBond_raiseDeactivatesUntilTopUp() public {
        uint256 id = _registerAlice();
        assertTrue(registry.isActive(id));
        vm.prank(gov);
        registry.setMinBond(150 ether);
        assertFalse(registry.isActive(id));
        assertEq(uint8(registry.getAgent(id).status), uint8(AgentRegistry.Status.Active)); // status untouched
        vm.prank(alice);
        registry.topUpBond{value: 50 ether}(id);
        assertTrue(registry.isActive(id));
    }

    // ───────────────────────────── slash ─────────────────────────────

    function test_slash_governanceOnly() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotGovernance.selector);
        registry.slash(id, 1 ether, treasury, "x");
    }

    function test_slash_reducesBondAndPays() public {
        uint256 id = _registerAlice();
        uint256 before = treasury.balance;
        vm.prank(gov);
        vm.expectEmit(true, false, false, true);
        emit AgentRegistry.AgentSlashed(id, 10 ether, treasury, "bad output");
        registry.slash(id, 10 ether, treasury, "bad output");
        assertEq(treasury.balance - before, 10 ether);
        assertEq(registry.getAgent(id).bond, MIN_BOND - 10 ether);
        assertFalse(registry.isActive(id)); // under-bonded now
    }

    function test_slash_revertsAboveBondOrZeroTo() public {
        uint256 id = _registerAlice();
        vm.startPrank(gov);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SlashExceedsBond.selector, MIN_BOND + 1, MIN_BOND));
        registry.slash(id, MIN_BOND + 1, treasury, "x");
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.slash(id, 1, address(0), "x");
        vm.expectRevert(AgentRegistry.UnknownAgent.selector);
        registry.slash(77, 1, treasury, "x");
        vm.stopPrank();
    }

    function test_slash_fullBondThenWithdrawNothing() public {
        uint256 id = _registerAlice();
        vm.prank(gov);
        registry.slash(id, MIN_BOND, treasury, "rug");
        vm.prank(alice);
        registry.retire(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NothingToWithdraw.selector);
        registry.withdrawBond(id);
    }

    // ───────────────────────────── ownership ─────────────────────────────

    function test_transferOwnership() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit AgentRegistry.OwnershipTransferred(id, alice, carol);
        registry.transferOwnership(id, carol);
        assertEq(registry.getAgent(id).owner, carol);

        // old owner locked out, new owner in control
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.update(id, "e", "m", 0);
        vm.prank(carol);
        registry.update(id, "e", "m", 0);
    }

    function test_transferOwnership_revertsZeroAndNonOwner() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.transferOwnership(id, address(0));
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.transferOwnership(id, bob);
    }

    // ───────────────────────────── recordOutcome ─────────────────────────────

    function test_recordOutcome_escrowOnly() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotEscrow.selector);
        registry.recordOutcome(id, true, 5);
        vm.prank(gov);
        vm.expectRevert(AgentRegistry.NotEscrow.selector);
        registry.recordOutcome(id, true, 5);
    }

    function test_recordOutcome_countsAndRatings() public {
        uint256 id = _registerAlice();
        vm.startPrank(address(escrow));
        registry.recordOutcome(id, true, 5);
        registry.recordOutcome(id, true, 0); // unrated
        registry.recordOutcome(id, false, 0);
        registry.recordOutcome(id, true, 3);
        vm.expectRevert(AgentRegistry.InvalidRating.selector);
        registry.recordOutcome(id, true, 6);
        vm.expectRevert(AgentRegistry.UnknownAgent.selector);
        registry.recordOutcome(55, true, 1);
        vm.stopPrank();
        AgentRegistry.Agent memory a = registry.getAgent(id);
        assertEq(a.jobsCompleted, 3);
        assertEq(a.jobsFailed, 1);
        assertEq(a.ratingCount, 2);
        assertEq(a.ratingSum, 8);
    }

    // ───────────────────────────── governance setters ─────────────────────────────

    function test_setMinBond_governanceOnly() public {
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotGovernance.selector);
        registry.setMinBond(1);
        vm.prank(gov);
        registry.setMinBond(1);
        assertEq(registry.minBond(), 1);
    }

    function test_setEscrow_onceOnly() public {
        vm.prank(gov);
        vm.expectRevert(AgentRegistry.EscrowAlreadySet.selector);
        registry.setEscrow(carol);

        AgentRegistry fresh = new AgentRegistry(gov, 1);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotGovernance.selector);
        fresh.setEscrow(carol);
        vm.prank(gov);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        fresh.setEscrow(address(0));
        vm.prank(gov);
        fresh.setEscrow(carol);
        assertEq(fresh.escrow(), carol);
    }

    function test_recordOutcome_revertsWhenEscrowUnset() public {
        AgentRegistry fresh = new AgentRegistry(gov, 1);
        vm.prank(alice);
        uint256 id = fresh.register{value: 1}("x", "", "", 0);
        vm.prank(address(0));
        vm.expectRevert(AgentRegistry.NotEscrow.selector);
        fresh.recordOutcome(id, true, 0);
    }

    function test_setGovernance() public {
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.NotGovernance.selector);
        registry.setGovernance(alice);
        vm.prank(gov);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setGovernance(address(0));
        vm.prank(gov);
        registry.setGovernance(carol);
        assertEq(registry.governance(), carol);
        vm.prank(gov);
        vm.expectRevert(AgentRegistry.NotGovernance.selector);
        registry.setMinBond(5);
    }

    // ───────────────────────────── fuzz ─────────────────────────────

    function testFuzz_bondAccounting(uint96 extra, uint96 slashAmt) public {
        uint256 id = _register(alice, MIN_BOND);
        vm.deal(carol, uint256(extra));
        if (extra > 0) {
            vm.prank(carol);
            registry.topUpBond{value: extra}(id);
        }
        uint256 bond = MIN_BOND + extra;
        uint256 s = bound(uint256(slashAmt), 0, bond);
        vm.prank(gov);
        registry.slash(id, s, treasury, "fuzz");
        assertEq(registry.getAgent(id).bond, bond - s);
        assertEq(address(registry).balance, bond - s);
        assertEq(registry.isActive(id), bond - s >= MIN_BOND);
    }
}
