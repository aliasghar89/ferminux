// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StakingTestBase} from "./StakingTestBase.sol";
import {FMXStaking} from "../src/FMXStaking.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";

/// @notice Regression suite for the two red-team MEDIUM findings on the
///         node/validator surface (2026-08):
///
///         FINDING 1 — nodeCount inflation made getValidators()/listActiveNodes()
///         O(historical registrations). Fixed with a compact active-id array
///         (push on register, swap-and-pop on deregister). Tests reproduce the
///         churn attack and prove read cost is now bounded by LIVE nodes, plus
///         deterministic and randomised integrity checks on the swap-and-pop
///         index map.
///
///         FINDING 2 — post-fork slashing had no cumulative cap, no cooldown,
///         no evidence check: a rogue adjudicator key could confiscate an
///         entire bond, 5% at a time. Now bounded: 10%-of-original-bond
///         lifetime cap + 7-day per-position cooldown (vault-enforced, immune
///         to re-registration) + global evidence-hash deduplication. Tests
///         reproduce the confiscation attack and prove it stops at 10%.
contract NodeRegistryHardeningTest is StakingTestBase {
    // ------------------------------------------------------------- Helpers
    function _armSlashing() internal returns (address sink) {
        sink = makeAddr("systemRewards");
        vm.startPrank(msig);
        registry.queueSetSlashingAdjudicator(carol);
        registry.queueSetSlashSink(sink);
        vm.stopPrank();
        skip(TIMELOCK);
        vm.startPrank(msig);
        registry.applySetSlashingAdjudicator(carol);
        registry.applySetSlashSink(sink);
        vm.stopPrank();
    }

    /// @dev Assert the active array and index map exactly match `expected`
    ///      (a set of node ids, order-insensitive), by checking both
    ///      directions plus length equality.
    function _assertActiveSetEquals(uint256[] memory expected, uint256 expectedLen) internal view {
        uint256[] memory actual = registry.getActiveNodeIds();
        assertEq(actual.length, expectedLen, "active array length mismatch");
        assertEq(registry.activeNodeCount(), expectedLen, "activeNodeCount mismatch");
        // forward: every array entry is an expected id and is marked active
        for (uint256 i = 0; i < actual.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < expectedLen; j++) {
                if (expected[j] == actual[i]) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "array holds an id that should not be active");
            assertTrue(registry.getNode(actual[i]).active, "array holds an inactive node");
        }
        // backward: every expected id appears in the array (with equal lengths
        // and distinct expected ids this also rules out duplicates)
        for (uint256 j = 0; j < expectedLen; j++) {
            bool present = false;
            for (uint256 i = 0; i < actual.length; i++) {
                if (actual[i] == expected[j]) {
                    present = true;
                    break;
                }
            }
            assertTrue(present, "live node dropped from active array");
        }
    }

    // ================================================= FINDING 1: inflation
    /// @notice ATTACK REPRODUCTION — register/deregister churn inflates
    ///         nodeCount but must NOT inflate the cost of getValidators()
    ///         (the exact call the PoS client makes at the fork block) or of
    ///         the roster view. Pre-fix, 150 dead ids added ~150 cold walks
    ///         per call; post-fix the cost tracks live nodes only.
    function test_Attack_ChurnCannotInflateGetValidatorsCost() public {
        // three genuine bonded nodes
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p3 = stakeAs(carol, FMXStaking.Tier.Validator, MIN_VAL);
        registerNodeAs(alice, p1, "live-1");
        registerNodeAs(bob, p2, "live-2");
        registerNodeAs(carol, p3, "live-3");

        // warm every slot both calls touch, then take the honest baseline
        registry.getValidators();
        registry.listActiveNodes();
        uint256 g0 = gasleft();
        registry.getValidators();
        uint256 gasBefore = g0 - gasleft();
        g0 = gasleft();
        registry.listActiveNodes();
        uint256 rosterBefore = g0 - gasleft();

        // the attack: cheap churn — one spare bond, 150 register/deregister
        // cycles. nodeCount inflates by 150; live set is unchanged.
        address attacker = makeAddr("churner");
        uint256 spare = stakeAs(attacker, FMXStaking.Tier.Validator, MIN_VAL);
        for (uint256 i = 0; i < 150; i++) {
            (uint256 id,,) = registerNodeAs(attacker, spare, "churn");
            vm.prank(attacker);
            registry.deregisterNode(id);
        }
        assertEq(registry.nodeCount(), 153); // 3 live + 150 of pure history
        assertEq(registry.activeNodeCount(), 3); // the live set did not move

        uint256 g1 = gasleft();
        registry.getValidators();
        uint256 gasAfter = g1 - gasleft();
        g1 = gasleft();
        registry.listActiveNodes();
        uint256 rosterAfter = g1 - gasleft();

        // bounded by live nodes: history must add (essentially) nothing.
        // Pre-fix this delta was ~hundreds of thousands of gas and unbounded.
        assertLt(gasAfter, gasBefore + 2_000, "getValidators cost grew with history");
        assertLt(rosterAfter, rosterBefore + 2_000, "listActiveNodes cost grew with history");
    }

    /// @notice Deterministic swap-and-pop walkthrough covering every removal
    ///         shape: middle, head, tail, and removal after a swap moved an id.
    function test_ActiveArray_SwapAndPopExactSteps() public {
        uint256[] memory pos = new uint256[](4);
        pos[0] = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        pos[1] = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        pos[2] = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL);
        pos[3] = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL);
        registerNodeAs(alice, pos[0], "sp-1"); // id 1
        registerNodeAs(alice, pos[1], "sp-2"); // id 2
        registerNodeAs(bob, pos[2], "sp-3"); // id 3
        registerNodeAs(bob, pos[3], "sp-4"); // id 4

        uint256[] memory exp = new uint256[](4);
        exp[0] = 1;
        exp[1] = 2;
        exp[2] = 3;
        exp[3] = 4;
        _assertActiveSetEquals(exp, 4);

        // remove a middle element (2): tail id 4 must be swapped in, not lost
        vm.prank(alice);
        registry.deregisterNode(2);
        exp[0] = 1;
        exp[1] = 4;
        exp[2] = 3;
        _assertActiveSetEquals(exp, 3);

        // remove the head (1): the previously-swapped id keeps a correct index
        vm.prank(alice);
        registry.deregisterNode(1);
        exp[0] = 3;
        exp[1] = 4;
        _assertActiveSetEquals(exp, 2);

        // remove the tail (no swap branch)
        vm.prank(bob);
        registry.deregisterNode(4);
        exp[0] = 3;
        _assertActiveSetEquals(exp, 1);

        // re-register on a freed position: new id joins cleanly
        (uint256 id5,,) = registerNodeAs(alice, pos[0], "sp-5"); // id 5
        exp[0] = 3;
        exp[1] = id5;
        _assertActiveSetEquals(exp, 2);

        // drain completely, then rebuild — the map must be spotless
        vm.prank(bob);
        registry.deregisterNode(3);
        vm.prank(alice);
        registry.deregisterNode(id5);
        _assertActiveSetEquals(new uint256[](0), 0);
        (uint256 id6,,) = registerNodeAs(bob, pos[2], "sp-6");
        exp[0] = id6;
        _assertActiveSetEquals(exp, 1);
    }

    /// @notice RANDOMISED register/deregister sequences (256 fuzz runs x 48
    ///         ops) against an in-test model. After every op the active array,
    ///         index map and roster must match the model exactly; a corrupted
    ///         index map or dropped live node fails here.
    function testFuzz_ActiveArray_RandomChurnMatchesModel(uint256 seed) public {
        // six bond positions, each holding at most one live node at a time
        uint256 nSlots = 6;
        address[] memory ops = new address[](nSlots);
        uint256[] memory posIds = new uint256[](nSlots);
        uint256[] memory slotNode = new uint256[](nSlots); // 0 = free
        for (uint256 s = 0; s < nSlots; s++) {
            ops[s] = makeAddr(string.concat("fuzz-op", vm.toString(s)));
            posIds[s] = stakeAs(ops[s], FMXStaking.Tier.Validator, MIN_VAL);
        }

        for (uint256 step = 0; step < 48; step++) {
            uint256 slot = uint256(keccak256(abi.encode(seed, step))) % nSlots;
            if (slotNode[slot] == 0) {
                (uint256 id,,) =
                    registerNodeAs(ops[slot], posIds[slot], string.concat("fz", vm.toString(seed), "-", vm.toString(step)));
                slotNode[slot] = id;
            } else {
                vm.prank(ops[slot]);
                registry.deregisterNode(slotNode[slot]);
                slotNode[slot] = 0;
            }

            // model -> expected active set
            uint256 liveCount = 0;
            uint256[] memory expected = new uint256[](nSlots);
            for (uint256 s = 0; s < nSlots; s++) {
                if (slotNode[s] != 0) expected[liveCount++] = slotNode[s];
            }
            _assertActiveSetEquals(expected, liveCount);
            // the views that walk the array agree and never revert
            assertEq(registry.listActiveNodes().length, liveCount);
            (address[] memory cons,) = registry.getValidators();
            assertEq(cons.length, 0); // nobody has 90 attested epochs here
        }
    }

    /// @notice The fork read stays CORRECT (not just cheap) when deregistration
    ///         has reshuffled the active array: ranking, exclusion of
    ///         deregistered nodes, and the historical-id gap are all handled.
    function test_GetValidatorsCorrectAfterDeregistrationReshuffle() public {
        vm.warp(600 days);
        uint256 n = 5;
        uint256[] memory nodeIds = new uint256[](n);
        address[] memory consAddrs = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            address op = makeAddr(string.concat("vop", vm.toString(i)));
            uint256 pos = stakeAs(op, FMXStaking.Tier.Validator, MIN_VAL + i * 1_000 ether);
            (uint256 id,, address cons) = registerNodeAs(op, pos, string.concat("vnode", vm.toString(i)));
            nodeIds[i] = id;
            consAddrs[i] = cons;
        }
        uint256 firstEpoch = registry.currentEpoch() - 90;
        for (uint256 e = 0; e < 90; e++) {
            uint16[] memory scores = new uint16[](n);
            for (uint256 i = 0; i < n; i++) {
                scores[i] = 10_000;
            }
            vm.prank(watchtower);
            registry.postEpoch(firstEpoch + e, keccak256(abi.encode(e)), nodeIds, scores);
        }
        skip(DISPUTE);
        for (uint256 e = 0; e < 90; e++) {
            registry.finalizeEpoch(firstEpoch + e);
        }

        // all five qualify; drop the largest bond (id 5) and a middle one (id 2)
        vm.prank(registry.getNode(nodeIds[4]).operator);
        registry.deregisterNode(nodeIds[4]);
        vm.prank(registry.getNode(nodeIds[1]).operator);
        registry.deregisterNode(nodeIds[1]);
        assertEq(registry.nodeCount(), 5);
        assertEq(registry.activeNodeCount(), 3);

        (address[] memory cons2, uint256[] memory bonds2) = registry.getValidators();
        assertEq(cons2.length, 3);
        // remaining bonds 28k > 27k > 25k, none of the deregistered addrs present
        assertEq(bonds2[0], MIN_VAL + 3_000 ether);
        assertEq(cons2[0], consAddrs[3]);
        assertEq(bonds2[1], MIN_VAL + 2_000 ether);
        assertEq(cons2[1], consAddrs[2]);
        assertEq(bonds2[2], MIN_VAL);
        assertEq(cons2[2], consAddrs[0]);
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(cons2[i] != consAddrs[4] && cons2[i] != consAddrs[1], "deregistered node in validator set");
        }
    }

    // ================================================ FINDING 2: slashing
    /// @notice ATTACK REPRODUCTION — a rogue adjudicator key tries to
    ///         confiscate an operator's whole 25k bond by slashing repeatedly.
    ///         Pre-fix: unlimited 5% events drained the bond to dust.
    ///         Post-fix: immediate repeats hit the 7-day cooldown, and the
    ///         lifetime take is clamped to exactly 10% of the ORIGINAL bond;
    ///         the operator keeps 90% no matter what the key does.
    function test_Attack_RepeatSlashConfiscationNowBounded() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 nodeId,,) = registerNodeAs(alice, pos, "victim");
        address sink = _armSlashing();
        vm.roll(staking.FORK_BLOCK());
        assertEq(staking.originalBond(pos), MIN_VAL);

        // event 1: 5% of 25,000 = 1,250
        vm.prank(carol);
        uint256 s1 = registry.slash(nodeId, hex"01");
        assertEq(s1, 1_250 ether);

        // immediate repeat, fresh evidence — cooldown blocks it
        vm.prank(carol);
        vm.expectRevert(bytes("STK: slash cooldown active"));
        registry.slash(nodeId, hex"02");
        skip(staking.SLASH_COOLDOWN() - 1);
        vm.prank(carol);
        vm.expectRevert(bytes("STK: slash cooldown active"));
        registry.slash(nodeId, hex"02");

        // event 2 after the full cooldown: 5% of 23,750 = 1,187.5
        skip(1);
        vm.prank(carol);
        uint256 s2 = registry.slash(nodeId, hex"02");
        assertEq(s2, 1_187.5 ether);

        // event 3: clamped to the lifetime remainder (2,500 - 2,437.5 = 62.5)
        skip(staking.SLASH_COOLDOWN());
        vm.prank(carol);
        uint256 s3 = registry.slash(nodeId, hex"03");
        assertEq(s3, 62.5 ether);
        assertEq(staking.slashedTotal(pos), (MIN_VAL * staking.MAX_TOTAL_SLASH_BPS()) / 10_000);

        // event 4: lifetime cap reached — forever
        skip(365 days);
        vm.prank(carol);
        vm.expectRevert(bytes("STK: lifetime slash cap reached"));
        registry.slash(nodeId, hex"04");

        // the operator kept exactly 90% of the original bond
        assertEq(staking.getPosition(pos).amount, MIN_VAL - 2_500 ether);
        assertEq(sink.balance, 2_500 ether);
        // and the units accounting followed the clamped amounts
        assertEq(staking.getPosition(pos).units, (MIN_VAL - 2_500 ether) * 20);
    }

    /// @notice Evidence must be non-empty and globally unique: the same
    ///         offence can never be submitted twice — not for the same node,
    ///         not for another node, not after any amount of time.
    function test_SlashEvidenceDeduplicated() public {
        uint256 p1 = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        uint256 p2 = stakeAs(bob, FMXStaking.Tier.Validator, MIN_VAL);
        (uint256 n1,,) = registerNodeAs(alice, p1, "ev-1");
        (uint256 n2,,) = registerNodeAs(bob, p2, "ev-2");
        _armSlashing();
        vm.roll(staking.FORK_BLOCK());

        vm.prank(carol);
        vm.expectRevert(bytes("NR: empty evidence"));
        registry.slash(n1, hex"");

        vm.prank(carol);
        registry.slash(n1, hex"deadbeef");
        assertTrue(registry.evidenceUsed(keccak256(hex"deadbeef")));

        // same evidence against another node: refused
        vm.prank(carol);
        vm.expectRevert(bytes("NR: duplicate evidence"));
        registry.slash(n2, hex"deadbeef");

        // a failed slash must NOT burn its evidence (state rolls back whole):
        // n1 is inside its cooldown, so this fresh evidence bounces off intact
        vm.prank(carol);
        vm.expectRevert(bytes("STK: slash cooldown active"));
        registry.slash(n1, hex"beef01");
        assertFalse(registry.evidenceUsed(keccak256(hex"beef01")));

        // same evidence against the same node after the cooldown: refused
        skip(staking.SLASH_COOLDOWN());
        vm.prank(carol);
        vm.expectRevert(bytes("NR: duplicate evidence"));
        registry.slash(n1, hex"deadbeef");

        // the unburnt evidence is still usable once the cooldown has passed
        vm.prank(carol);
        registry.slash(n1, hex"beef01");
        assertTrue(registry.evidenceUsed(keccak256(hex"beef01")));
        assertEq(staking.getPosition(p2).amount, MIN_VAL); // n2 untouched throughout
    }

    /// @notice Cooldown and lifetime cap are keyed by POSITION in the vault:
    ///         deregistering and re-registering the same bond as a "new" node
    ///         resets nothing.
    function test_SlashBoundsSurviveReRegistration() public {
        // 30k bond: still >= the 25k registration minimum after a 5% slash,
        // so the deregister/re-register cycle is actually available to try
        uint256 bond = 30_000 ether;
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, bond);
        (uint256 nodeId,,) = registerNodeAs(alice, pos, "rr-1");
        _armSlashing();
        vm.roll(staking.FORK_BLOCK());

        vm.prank(carol);
        registry.slash(nodeId, hex"11");
        uint256 taken = staking.slashedTotal(pos);
        assertEq(taken, 1_500 ether); // 5% of 30k

        // operator (or a colluding adjudicator path) cycles the node identity
        vm.prank(alice);
        registry.deregisterNode(nodeId);
        (uint256 nodeId2,,) = registerNodeAs(alice, pos, "rr-2");
        assertTrue(nodeId2 != nodeId);

        // fresh node id, same position: still inside the cooldown
        vm.prank(carol);
        vm.expectRevert(bytes("STK: slash cooldown active"));
        registry.slash(nodeId2, hex"22");

        // and the lifetime tally carried over
        skip(staking.SLASH_COOLDOWN());
        vm.prank(carol);
        uint256 s2 = registry.slash(nodeId2, hex"22");
        assertEq(staking.slashedTotal(pos), taken + s2);
        skip(staking.SLASH_COOLDOWN());
        vm.prank(carol);
        registry.slash(nodeId2, hex"33"); // clamped remainder
        assertEq(staking.slashedTotal(pos), (bond * staking.MAX_TOTAL_SLASH_BPS()) / 10_000);
        skip(staking.SLASH_COOLDOWN());
        vm.prank(carol);
        vm.expectRevert(bytes("STK: lifetime slash cap reached"));
        registry.slash(nodeId2, hex"44");
    }

    /// @notice Direct vault-level check of the same bounds (defence in depth:
    ///         they hold even against the registry itself, so no future
    ///         registry bug can exceed them).
    function test_VaultEnforcesSlashBoundsAgainstRegistryDirectly() public {
        uint256 pos = stakeAs(alice, FMXStaking.Tier.Validator, MIN_VAL);
        vm.roll(staking.FORK_BLOCK());
        vm.startPrank(address(registry));
        staking.slashBond(pos, 500, bob);
        vm.expectRevert(bytes("STK: slash cooldown active"));
        staking.slashBond(pos, 500, bob);
        vm.stopPrank();
        skip(staking.SLASH_COOLDOWN());
        vm.prank(address(registry));
        staking.slashBond(pos, 500, bob);
        skip(staking.SLASH_COOLDOWN());
        vm.prank(address(registry));
        staking.slashBond(pos, 500, bob); // clamped to remainder
        assertEq(staking.slashedTotal(pos), 2_500 ether);
        skip(staking.SLASH_COOLDOWN());
        vm.prank(address(registry));
        vm.expectRevert(bytes("STK: lifetime slash cap reached"));
        staking.slashBond(pos, 500, bob);
        assertEq(staking.getPosition(pos).amount, MIN_VAL - 2_500 ether);
    }
}
