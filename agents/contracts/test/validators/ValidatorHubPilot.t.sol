// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../../src/validators/ValidatorHubLens.sol";
import {FMXRewardSink} from "./utils/FMXRewardSink.sol";

/// @notice The invite-only pilot: an allowlist of seat owners managed by the owner (the multisig),
///         a cap of 20 seats fixed at deploy, and a one-way switch to open seats to everyone through
///         the 48 h timelock.
contract ValidatorHubPilotTest is ValidatorTestBase {
    uint8 internal constant P_MAX_SEATS = 0;
    uint8 internal constant P_REWARD = 1;
    uint8 internal constant P_ACTIVATIONS = 2;
    uint8 internal constant P_DENY = 5;
    uint8 internal constant P_ALLOW = 6;
    uint8 internal constant P_OPEN_TO_ALL = 7;
    uint256 internal constant PILOT_SEATS = 20;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol"); // never invited

    function setUp() public override {
        vm.roll(START);
        sink = new FMXRewardSink(msig);
        address[] memory deny = new address[](1);
        deny[0] = premine;
        hub = new ValidatorHub(msig, address(sink), deny, PILOT_SEATS, true);
        lens = new ValidatorHubLens(hub);
    }

    // ------------------------------------------------------------------ helpers

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        l[0] = a;
        l[1] = b;
    }

    function _invite(address[] memory l) internal {
        vm.prank(msig);
        hub.setAllowlist(l, true);
    }

    function _uninvite(address[] memory l) internal {
        vm.prank(msig);
        hub.setAllowlist(l, false);
    }

    struct Proofs {
        address att;
        bytes aSig;
        bytes pub;
        bytes nSig;
    }

    /// Everything openSeat needs, built before any expectRevert (the digests are hub calls too).
    function _proofs(address owner) internal returns (Proofs memory p) {
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        p.att = vm.addr(a);
        p.aSig = _sign(a, hub.attesterKeyDigest(owner, p.att));
        p.pub = _pubkey(n);
        p.nSig = _sign(n, hub.enodeDigest(owner, p.att));
        vm.deal(owner, owner.balance + DEPOSIT);
    }

    function _expectOpenRefused(address owner, bytes4 err) internal {
        Proofs memory p = _proofs(owner);
        vm.expectRevert(err);
        vm.prank(owner);
        hub.openSeat{value: DEPOSIT}(p.att, p.aSig, p.pub, p.nSig);
    }

    function _openToAll() internal {
        _setParam(P_OPEN_TO_ALL, 1);
    }

    // ================================================================= deploy state

    function test_Pilot_StartsInviteOnlyWith20Seats() public view {
        assertTrue(hub.allowlistOnly());
        assertEq(hub.maxSeats(), PILOT_SEATS);
        assertFalse(hub.allowlisted(alice));
        assertEq(hub.owner(), msig);
        // everything else is the Step 1 launch shape
        assertEq(hub.rewardPerAttest(), RATE);
        assertEq(hub.activationsPerDay(), 10);
        assertEq(hub.currentRewardPerAttest(), RATE, "7.5 / 20 is far above 0.025: the guard does not bite");
    }

    function test_Constructor_MaxSeatsBounds() public {
        vm.expectRevert(ValidatorHub.BadParam.selector);
        new ValidatorHub(msig, address(sink), new address[](0), 0, true);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        new ValidatorHub(msig, address(sink), new address[](0), 101, false);
        assertEq(new ValidatorHub(msig, address(sink), new address[](0), 1, true).maxSeats(), 1);
        ValidatorHub open = new ValidatorHub(msig, address(sink), new address[](0), 100, false);
        assertEq(open.maxSeats(), 100);
        assertFalse(open.allowlistOnly());
    }

    // ================================================================= allowlist gates openSeat

    function test_Pilot_UninvitedOwnerRefused() public {
        _expectOpenRefused(carol, ValidatorHub.NotAllowlisted.selector);
        assertEq(hub.seatCount(), 0);
        assertEq(address(hub).balance, 0);
    }

    function test_Pilot_InvitedOwnerOpensSeat() public {
        _invite(_list(alice));
        uint256 id = _open(alice);
        assertEq(id, 1);
        assertEq(_seat(id).owner, alice);
        assertEq(hub.occupiedSeats(), 1);
        assertEq(hub.bondedTotal(), DEPOSIT);
        // an invitee may open more than one seat; the cap is maxSeats, not the list
        _open(alice);
        assertEq(hub.occupiedSeats(), 2);
    }

    function test_Pilot_DenyListBeatsAllowlist() public {
        _invite(_list(premine));
        _expectOpenRefused(premine, ValidatorHub.Denied.selector);
    }

    function test_Pilot_PauseStillApplies() public {
        _invite(_list(alice));
        vm.prank(msig);
        hub.setSeatsPaused(true);
        _expectOpenRefused(alice, ValidatorHub.Paused.selector);
    }

    function test_SetAllowlist_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.setAllowlist(_list(alice), true);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.setAllowlist(_list(alice), false);
    }

    function test_SetAllowlist_ZeroAddressRefused() public {
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.ZeroAddress.selector);
        hub.setAllowlist(_list(alice, address(0)), true);
        assertFalse(hub.allowlisted(alice), "the whole batch reverted");
    }

    function test_SetAllowlist_OneEventPerChange() public {
        address[] memory l = new address[](3);
        l[0] = alice;
        l[1] = bob;
        l[2] = alice; // a duplicate in the batch changes nothing the second time
        vm.recordLogs();
        _invite(l);
        _assertAllowlistEvents(_list(alice, bob), true);
        assertTrue(hub.allowlisted(alice) && hub.allowlisted(bob));

        vm.recordLogs();
        _invite(_list(alice)); // already invited: no change, no event
        _assertAllowlistEvents(new address[](0), true);

        vm.recordLogs();
        _uninvite(_list(alice, carol)); // carol was never invited: only alice changes
        _assertAllowlistEvents(_list(alice), false);
        assertFalse(hub.allowlisted(alice));
        assertTrue(hub.allowlisted(bob));
    }

    function _assertAllowlistEvents(address[] memory want, bool allowed) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hub) || logs[i].topics[0] != ValidatorHub.AllowlistSet.selector) continue;
            assertLt(n, want.length, "more AllowlistSet events than changes");
            assertEq(address(uint160(uint256(logs[i].topics[1]))), want[n], "account");
            assertEq(abi.decode(logs[i].data, (bool)), allowed, "allowed");
            ++n;
        }
        assertEq(n, want.length, "one AllowlistSet per change");
    }

    function testFuzz_SetAllowlist_MatchesTheBatch(address[8] memory raw, bool allowed) public {
        address[] memory l = new address[](8);
        for (uint256 i; i < 8; ++i) {
            l[i] = raw[i] == address(0) ? address(1) : raw[i];
        }
        if (!allowed) _invite(l);
        vm.prank(msig);
        hub.setAllowlist(l, allowed);
        for (uint256 i; i < 8; ++i) {
            assertEq(hub.allowlisted(l[i]), allowed);
        }
    }

    function test_Pilot_UninviteBlocksNewSeatsOnly() public {
        _invite(_list(alice));
        uint256 id = _open(alice);
        _fund(10 ether);
        _uninvite(_list(alice));
        _expectOpenRefused(alice, ValidatorHub.NotAllowlisted.selector);

        // the open seat is untouched: it activates, attests, earns, exits and withdraws as usual
        vm.roll(_seat(id).activationBlock);
        uint256 h = _attestRun(_one(id), 1);
        assertTrue(hub.attested(id, h));
        assertEq(uint256(_seat(id).claimable), RATE);
        vm.prank(alice);
        hub.claim(id, payable(alice));
        vm.prank(alice);
        hub.requestExit(id);
        vm.roll(block.number + UNBOND);
        uint256 before = alice.balance;
        vm.prank(alice);
        hub.withdraw(id, payable(alice));
        assertEq(alice.balance - before, DEPOSIT, "full deposit back");
    }

    // ================================================================= the 20-seat cap

    function test_Pilot_Seat21Refused() public {
        _invite(_list(alice, bob));
        uint256[] memory ids = new uint256[](PILOT_SEATS);
        for (uint256 i; i < PILOT_SEATS; ++i) {
            ids[i] = _open(i % 2 == 0 ? alice : bob);
        }
        assertEq(hub.occupiedSeats(), 20);
        assertEq(hub.bondedTotal(), 20 * DEPOSIT);
        _expectOpenRefused(alice, ValidatorHub.SeatsFull.selector);
        // an uninvited wallet is told it is not invited, not that seats are full
        _expectOpenRefused(carol, ValidatorHub.NotAllowlisted.selector);

        // an exit frees a place (the unbond does not hold it)
        vm.prank(bob);
        hub.requestExit(ids[1]);
        assertEq(_open(alice), 21);
        assertEq(hub.occupiedSeats(), 20);
        _expectOpenRefused(bob, ValidatorHub.SeatsFull.selector);
    }

    function test_Pilot_CapRaisedOnlyByTimelock() public {
        vm.prank(msig);
        hub.queueParam(P_MAX_SEATS, 100);
        vm.roll(block.number + TIMELOCK - 1);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.applyParam(P_MAX_SEATS, 100);
        vm.roll(block.number + 1);
        vm.prank(msig);
        hub.applyParam(P_MAX_SEATS, 100);
        assertEq(hub.maxSeats(), 100);
        assertTrue(hub.allowlistOnly(), "raising the cap does not open the pilot");
        // the 30-day launch ceiling still holds
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(P_MAX_SEATS, 101);
    }

    // ================================================================= openToAll: one-way, 48 h

    function test_OpenToAll_ThroughTimelockOnceAndForGood() public {
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.queueParam(P_OPEN_TO_ALL, 1);

        vm.expectEmit(true, false, false, true, address(hub));
        emit ValidatorHub.ParamQueued(P_OPEN_TO_ALL, 1, block.number + TIMELOCK);
        vm.prank(msig);
        hub.queueParam(P_OPEN_TO_ALL, 1);

        vm.prank(msig);
        vm.expectRevert(ValidatorHub.AlreadyQueued.selector);
        hub.queueParam(P_OPEN_TO_ALL, 1);

        vm.roll(block.number + TIMELOCK - 1);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.TooEarly.selector);
        hub.applyParam(P_OPEN_TO_ALL, 1);
        _expectOpenRefused(carol, ValidatorHub.NotAllowlisted.selector);

        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.applyParam(P_OPEN_TO_ALL, 1);
        vm.expectEmit(false, false, false, false, address(hub));
        emit ValidatorHub.OpenedToAll();
        vm.prank(msig);
        hub.applyParam(P_OPEN_TO_ALL, 1);
        assertFalse(hub.allowlistOnly());

        // anyone not denied can open a seat now
        assertEq(_open(carol), 1);
        _expectOpenRefused(premine, ValidatorHub.Denied.selector);

        // and it cannot be undone or repeated
        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.NotQueued.selector);
        hub.applyParam(P_OPEN_TO_ALL, 1);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(P_OPEN_TO_ALL, 1);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.setAllowlist(_list(alice), true);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.setAllowlist(_list(alice), false);
        vm.stopPrank();
        assertFalse(hub.allowlistOnly());
    }

    function test_OpenToAll_OnlyValueOne() public {
        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(P_OPEN_TO_ALL, 0);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(P_OPEN_TO_ALL, 2);
        vm.stopPrank();
    }

    function test_OpenToAll_CancelKeepsThePilot() public {
        vm.prank(msig);
        hub.queueParam(P_OPEN_TO_ALL, 1);
        vm.prank(msig);
        hub.cancelParam(P_OPEN_TO_ALL, 1);
        vm.roll(block.number + TIMELOCK);
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.NotQueued.selector);
        hub.applyParam(P_OPEN_TO_ALL, 1);
        assertTrue(hub.allowlistOnly());
    }

    function test_OpenToAll_RefusedOnAHubDeployedOpen() public {
        ValidatorHub open = new ValidatorHub(msig, address(sink), new address[](0), 100, false);
        vm.startPrank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        open.queueParam(P_OPEN_TO_ALL, 1);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        open.setAllowlist(_list(alice), true);
        vm.stopPrank();
    }

    /// Every other timelocked parameter, applied after the switch, leaves the hub open.
    function test_OpenToAll_NoOtherParameterReEnablesTheAllowlist() public {
        _openToAll();
        _setParam(P_MAX_SEATS, 60);
        _setParam(P_REWARD, 0.02 ether);
        _setParam(P_ACTIVATIONS, 20);
        _setParam(P_DENY, uint256(uint160(carol)));
        _setParam(P_ALLOW, uint256(uint160(carol)));
        vm.startPrank(msig);
        hub.setSeatsPaused(true);
        hub.setSeatsPaused(false);
        hub.setAttestationsPaused(true);
        hub.setAttestationsPaused(false);
        hub.closeCommunitySeats();
        vm.stopPrank();
        assertFalse(hub.allowlistOnly());
        assertEq(_open(bob), 1);
    }

    /// The allowlist belongs to whoever owns the hub (the re-keyed multisig after a handover).
    function test_Allowlist_FollowsOwnership() public {
        address next = makeAddr("next-msig");
        vm.prank(msig);
        hub.transferOwnership(next);
        vm.prank(next);
        hub.acceptOwnership();
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.setAllowlist(_list(alice), true);
        vm.prank(next);
        hub.setAllowlist(_list(alice), true);
        assertTrue(hub.allowlisted(alice));
        assertTrue(hub.allowlistOnly());
    }

    // ================================================================= lens

    function test_Lens_SeatAccess() public {
        _invite(_list(alice, premine));
        ValidatorHubLens.SeatAccess memory a = lens.seatAccess(carol);
        assertEq(a.reason, lens.ACCESS_NOT_INVITED());
        assertTrue(a.allowlistOnly);
        assertFalse(a.allowlisted);
        assertEq(a.maxSeats, 20);
        assertEq(a.occupiedSeats, 0);

        a = lens.seatAccess(alice);
        assertEq(a.reason, lens.ACCESS_OPEN());
        assertTrue(a.allowlisted);

        assertEq(lens.seatAccess(premine).reason, lens.ACCESS_DENIED(), "deny list first");

        vm.prank(msig);
        hub.setSeatsPaused(true);
        assertEq(lens.seatAccess(alice).reason, lens.ACCESS_PAUSED());
        vm.prank(msig);
        hub.setSeatsPaused(false);

        for (uint256 i; i < PILOT_SEATS; ++i) {
            _open(alice);
        }
        a = lens.seatAccess(alice);
        assertEq(a.reason, lens.ACCESS_FULL());
        assertEq(a.occupiedSeats, 20);
        assertEq(lens.seatAccess(carol).reason, lens.ACCESS_NOT_INVITED(), "same order as openSeat");

        _openToAll();
        a = lens.seatAccess(carol);
        assertFalse(a.allowlistOnly);
        assertEq(a.reason, lens.ACCESS_FULL());
    }

    /// The lens mirrors openSeat exactly: whatever it says, openSeat does.
    function testFuzz_Lens_SeatAccessMatchesOpenSeat(uint8 invite, bool paused, bool fill, bool opened) public {
        address who = invite % 3 == 0 ? carol : (invite % 3 == 1 ? alice : premine);
        _invite(_list(alice, premine));
        if (fill) {
            for (uint256 i; i < PILOT_SEATS; ++i) {
                _open(alice);
            }
        }
        if (opened) _openToAll();
        if (paused) {
            vm.prank(msig);
            hub.setSeatsPaused(true);
        }
        uint8 reason = lens.seatAccess(who).reason;
        Proofs memory p = _proofs(who);
        vm.prank(who);
        (bool ok, bytes memory ret) =
            address(hub).call{value: DEPOSIT}(abi.encodeCall(hub.openSeat, (p.att, p.aSig, p.pub, p.nSig)));
        if (reason == lens.ACCESS_OPEN()) {
            assertTrue(ok, "lens said open");
        } else {
            assertFalse(ok, "lens said refused");
            bytes4 want = reason == lens.ACCESS_PAUSED()
                ? ValidatorHub.Paused.selector
                : reason == lens.ACCESS_DENIED()
                    ? ValidatorHub.Denied.selector
                    : reason == lens.ACCESS_NOT_INVITED()
                        ? ValidatorHub.NotAllowlisted.selector
                        : ValidatorHub.SeatsFull.selector;
            assertEq(bytes4(ret), want);
        }
    }

    // ================================================================= storage

    /// allowlistOnly shares slot 12 with the two pause flags and the allowlist sits after every
    /// earlier variable, so no slot the lens, the sidecar or the Step 2 engine reads has moved.
    function test_StorageLayout_PilotFieldsMoveNothing() public {
        uint256 w = uint256(vm.load(address(hub), bytes32(uint256(12))));
        assertEq((w >> 16) & 0xff, 1, "allowlistOnly = slot 12, byte 2");
        assertEq(w & 0xffff, 0, "both pauses off");
        vm.prank(msig);
        hub.setSeatsPaused(true);
        w = uint256(vm.load(address(hub), bytes32(uint256(12))));
        assertEq(w & 0xff, 1, "seatsPaused still slot 12, byte 0");
        assertEq((w >> 16) & 0xff, 1);

        _invite(_list(alice));
        bytes32 slot = keccak256(abi.encode(alice, uint256(47)));
        assertEq(uint256(vm.load(address(hub), slot)), 1, "allowlisted = mapping at slot 47");
        assertEq(uint256(vm.load(address(hub), bytes32(uint256(8)))), 20, "maxSeats still slot 8");
        assertEq(uint256(vm.load(address(hub), bytes32(uint256(6)))), uint256(uint160(msig)), "owner still slot 6");

        _openToAll();
        w = uint256(vm.load(address(hub), bytes32(uint256(12))));
        assertEq((w >> 16) & 0xff, 0, "cleared");
        assertEq(w & 0xff, 1, "the pause flag next to it is untouched");
    }

    /// The four views that moved from the hub to the lens (to keep the hub under 24 KB) read the
    /// same values the hub itself uses.
    function test_Lens_MovedViews() public {
        _invite(_list(alice));
        uint256 id = _open(alice);
        vm.roll(_seat(id).activationBlock);
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        bytes32 other = keccak256(abi.encode("other branch", h));
        bytes memory a = _attSig(attPk[id], h, _hashOf(h));
        bytes memory b = _attSig(attPk[id], h, other);
        bytes32 ev = keccak256(abi.encode(uint8(1), id, h));
        assertFalse(lens.evidenceUsed(ev));
        hub.proveDoubleAttestation(uint64(h), _hashOf(h), a, other, b);
        assertTrue(lens.evidenceUsed(ev));

        assertFalse(lens.communitySeatsOpen());
        assertFalse(lens.halvingActive());
        vm.roll(4_500_000);
        assertTrue(lens.halvingActive());
        assertEq(hub.currentRewardPerAttest(), RATE / 2, "the hub halves at the same block");

        // the Step 2 possession digest binds chain, hub, seat, key and owner
        address key = makeAddr("signing-key");
        assertEq(
            lens.signingKeyDigest(id, key, alice),
            keccak256(abi.encodePacked("FERMINUX-SIGNKEY-V1", block.chainid, address(hub), id, key, alice))
        );
    }
}
