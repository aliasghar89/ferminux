// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../../src/validators/ValidatorHubLens.sol";
import {FMXRewardSink} from "./utils/FMXRewardSink.sol";

/// @notice Randomised driver for the invite-only pilot: the owner invites and un-invites wallets in
///         batches, wallets (invited or not) try to open seats, seats exit and withdraw, the cap is
///         raised by timelock, the owner queues, cancels and applies the one-way switch, and later
///         tries every way it has to turn the allowlist back on. Ghosts record what the hub allowed.
contract PilotHandler is Test {
    ValidatorHub public hub;
    ValidatorHubLens public lens;
    address public msig;

    uint256 internal constant ACTORS = 8;
    uint8 internal constant P_MAX_SEATS = 0;
    uint8 internal constant P_OPEN_TO_ALL = 7;
    uint256 internal nextPk = 0xC0C0;

    uint256[] public seats;
    mapping(uint256 => bool) public exited;
    mapping(uint256 => bool) public withdrawn;

    bool public ghostOpened; // the switch was applied
    uint256 public ghostUninvitedSeats; // seats opened while invite-only by a wallet not on the list
    uint256 public ghostReenabled; // any call after the switch that left allowlistOnly true
    uint256 public ghostOpenedEarly; // the switch applied before its 48 h
    uint256 public ghostOverCap; // a seat accepted beyond maxSeats
    uint256 public ghostLensMismatch; // ValidatorHubLens.seatAccess disagreed with openSeat
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public queuedAt; // 0 = not queued
    // coverage
    uint256 public nInvited;
    uint256 public nOpenedInvited;
    uint256 public nRefusedUninvited;
    uint256 public nRefusedFull;
    uint256 public nOpenedAfterSwitch;
    uint256 public nExited;
    uint256 public nWithdrawn;
    uint256 public nSwitch;

    constructor(ValidatorHub hub_, ValidatorHubLens lens_, address msig_) {
        hub = hub_;
        lens = lens_;
        msig = msig_;
    }

    function actor(uint256 seed) public pure returns (address) {
        return address(uint160(0xD0000 + seed % ACTORS));
    }

    function seatCount() external view returns (uint256) {
        return seats.length;
    }

    function _sign(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ owner

    function setAllowlist(uint256 mask, bool allowed) external {
        mask = bound(mask, 1, (1 << ACTORS) - 1);
        uint256 n;
        for (uint256 i; i < ACTORS; ++i) {
            if ((mask >> i) & 1 == 1) ++n;
        }
        address[] memory l = new address[](n);
        n = 0;
        for (uint256 i; i < ACTORS; ++i) {
            if ((mask >> i) & 1 == 1) l[n++] = actor(i);
        }
        vm.prank(msig);
        try hub.setAllowlist(l, allowed) {
            if (ghostOpened) ++ghostReenabled; // must revert once open
            if (allowed) nInvited += n;
        } catch {}
        if (ghostOpened && hub.allowlistOnly()) ++ghostReenabled;
    }

    /// Queued on one call in six, so most runs spend a good while invite-only before the switch.
    function queueOpen(uint256 seed) external {
        if (seed % 6 != 0) return;
        vm.prank(msig);
        try hub.queueParam(P_OPEN_TO_ALL, 1) {
            queuedAt = block.number;
        } catch {}
        if (ghostOpened && hub.allowlistOnly()) ++ghostReenabled;
    }

    function cancelOpen() external {
        vm.prank(msig);
        try hub.cancelParam(P_OPEN_TO_ALL, 1) {
            queuedAt = 0;
        } catch {}
    }

    function applyOpen() external {
        vm.prank(msig);
        try hub.applyParam(P_OPEN_TO_ALL, 1) {
            if (queuedAt == 0 || block.number < queuedAt + 24_686) ++ghostOpenedEarly;
            if (ghostOpened) ++ghostReenabled; // a second apply must never succeed
            ghostOpened = true;
            queuedAt = 0;
            ++nSwitch;
        } catch {}
    }

    function raiseCap(uint256 value) external {
        value = bound(value, 1, 12);
        vm.startPrank(msig);
        try hub.queueParam(P_MAX_SEATS, value) {} catch {}
        vm.roll(block.number + 24_686);
        try hub.applyParam(P_MAX_SEATS, value) {} catch {}
        vm.stopPrank();
        if (ghostOpened && hub.allowlistOnly()) ++ghostReenabled;
    }

    function pauseSeats(bool paused) external {
        vm.prank(msig);
        hub.setSeatsPaused(paused);
    }

    // ------------------------------------------------------------------ wallets

    /// One to three attempts, from the same wallet, so runs press against the cap.
    function open(uint256 actorSeed, uint256 tries) external {
        tries = bound(tries, 1, 3);
        for (uint256 i; i < tries; ++i) {
            _open(actor(actorSeed));
        }
    }

    function _open(address owner) internal {
        if (seats.length >= 48) return;
        bool inviteOnly = hub.allowlistOnly();
        bool invited = hub.allowlisted(owner);
        bool full = hub.occupiedSeats() >= hub.maxSeats();
        uint8 predicted = lens.seatAccess(owner).reason;
        uint256 a = nextPk++;
        uint256 n = nextPk++;
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(owner, att));
        VmSafe.Wallet memory w = vm.createWallet(n);
        bytes memory pub = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes memory nSig = _sign(n, hub.enodeDigest(owner, att));
        vm.deal(owner, owner.balance + 2_000 ether);
        vm.prank(owner);
        try hub.openSeat{value: 2_000 ether}(att, aSig, pub, nSig) returns (uint256 id) {
            seats.push(id);
            ghostDeposited += 2_000 ether;
            if (inviteOnly && !invited) ++ghostUninvitedSeats;
            if (full) ++ghostOverCap;
            if (predicted != 0) ++ghostLensMismatch; // the lens said no, the hub said yes
            if (inviteOnly) ++nOpenedInvited;
            else ++nOpenedAfterSwitch;
        } catch (bytes memory err) {
            if (predicted == 0) ++ghostLensMismatch; // the lens said yes, the hub said no
            if (bytes4(err) == ValidatorHub.NotAllowlisted.selector) {
                ++nRefusedUninvited;
                if (!inviteOnly || invited) ++ghostUninvitedSeats; // refused for the wrong reason
            }
            if (bytes4(err) == ValidatorHub.SeatsFull.selector) ++nRefusedFull;
        }
    }

    function exit(uint256 seed) external {
        if (seats.length == 0) return;
        uint256 id = seats[seed % seats.length];
        if (exited[id]) return;
        vm.prank(lens.seat(id).owner);
        hub.requestExit(id);
        exited[id] = true;
        ++nExited;
    }

    function withdraw(uint256 seed) external {
        if (seats.length == 0) return;
        uint256 id = seats[seed % seats.length];
        if (!exited[id] || withdrawn[id]) return;
        ValidatorHub.Seat memory s = lens.seat(id);
        if (block.number < s.unbondEndBlock) vm.roll(s.unbondEndBlock);
        vm.prank(s.owner);
        hub.withdraw(id, payable(s.owner));
        withdrawn[id] = true;
        ghostWithdrawn += s.deposit;
        ++nWithdrawn;
    }

    function advance(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 1, 30_000));
    }
}

/// @notice The pilot's promises: only invited wallets open seats while invite-only; never more
///         seats than maxSeats; the switch to open-to-all fires only after 48 h and only once, and
///         nothing ever turns the allowlist back on; deposits stay conserved throughout.
contract ValidatorHubPilotInvariantTest is Test {
    ValidatorHub internal hub;
    ValidatorHubLens internal lens;
    PilotHandler internal handler;
    address internal msig = makeAddr("pilot-msig");

    function setUp() public {
        vm.roll(1_000_000);
        FMXRewardSink sink = new FMXRewardSink(msig);
        // 6 seats rather than the pilot's 20, so a run of 120 calls reaches the cap often; the cap
        // logic does not depend on the number (ValidatorHubPilot.t.sol fills all 20).
        hub = new ValidatorHub(msig, address(sink), new address[](0), 6, true);
        lens = new ValidatorHubLens(hub);
        handler = new PilotHandler(hub, lens, msig);
        targetContract(address(handler));
    }

    function afterInvariant() external view {
        console.log("invited", handler.nInvited(), "opened while invite-only", handler.nOpenedInvited());
        console.log("refused uninvited", handler.nRefusedUninvited(), "refused full", handler.nRefusedFull());
        console.log("switch applied", handler.nSwitch(), "opened after switch", handler.nOpenedAfterSwitch());
        console.log("exited", handler.nExited(), "withdrawn", handler.nWithdrawn());
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    function invariant_OnlyInvitedWalletsOpenSeatsWhileInviteOnly() public view {
        assertEq(
            handler.ghostUninvitedSeats(),
            0,
            "an uninvited wallet opened a seat, or an invitee was refused as uninvited"
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    function invariant_NeverAboveTheCap() public view {
        assertLe(hub.occupiedSeats(), hub.maxSeats(), "occupied <= maxSeats");
        assertLe(hub.maxSeats(), 100, "the 30-day launch ceiling");
        assertEq(handler.ghostOverCap(), 0, "a seat accepted past the cap");
        assertEq(handler.ghostLensMismatch(), 0, "ValidatorHubLens.seatAccess disagreed with openSeat");
        uint256 bonded;
        for (uint256 id = 1; id <= hub.seatCount(); ++id) {
            if (lens.seat(id).status == 1) ++bonded;
        }
        assertEq(hub.occupiedSeats(), bonded, "occupied = bonded seats");
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    function invariant_OpenToAllIsOneWayAndTimelocked() public view {
        assertEq(hub.allowlistOnly(), !handler.ghostOpened(), "allowlistOnly changes only through the switch, once");
        assertEq(handler.ghostReenabled(), 0, "the allowlist came back or the switch fired twice");
        assertEq(handler.ghostOpenedEarly(), 0, "the switch fired before 48 h");
        assertLe(handler.nSwitch(), 1);
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    function invariant_DepositsConserved() public view {
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(t.totalDeposited, handler.ghostDeposited(), "deposits in");
        assertEq(t.totalWithdrawn, handler.ghostWithdrawn(), "deposits out");
        assertEq(address(hub).balance, hub.bondedTotal(), "no rewards funded here: balance = bonded deposits");
        assertEq(t.totalDeposited, hub.bondedTotal() + t.totalWithdrawn, "in = bonded + withdrawn");
        assertEq(msig.balance, 0, "the owner is never paid");
    }
}
