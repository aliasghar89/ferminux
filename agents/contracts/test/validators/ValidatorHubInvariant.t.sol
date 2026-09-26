// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../../src/validators/ValidatorHubLens.sol";
import {FMXRewardSink} from "./utils/FMXRewardSink.sol";

/// @notice Randomised driver: seats open, attest in random subsets, get jailed and unjailed, exit,
///         withdraw, claim, get slashed (executed or vetoed), the pool is funded and trimmed, the
///         owner pauses and queues parameters, and time jumps by up to 16 days. Ghost totals are
///         kept for the conservation checks.
contract HubHandler is Test {
    ValidatorHub public hub;
    ValidatorHubLens public lens;
    address public msig;
    address public sinkAddr;
    address public reporter = makeAddr("inv-reporter");

    uint256 internal constant MAX_SEATS_USED = 14;
    uint256 internal nextPk = 0xB0B0;

    uint256[] public seats;
    mapping(uint256 => uint256) public attPkOf;
    mapping(uint256 => uint256) public withdrawCount;
    mapping(uint256 => uint256) public paidAtHeight;
    mapping(uint256 => uint256) public pendingPkOf; // queued attester rotation
    mapping(uint256 => uint256) public oldPkOf; // attester key replaced by the last rotation

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostFunded;
    uint256 public ghostClaimed;
    uint256 public ghostCreditsPaid;
    uint256 public ghostReturned;
    uint256 public ghostMaxPaidPerCheckpoint;
    uint256 public ghostBudgetBreaches;
    uint256 public ghostDoubleWithdrawSucceeded;
    uint256 public ghostStaleKeySlashes; // slashes from a key replaced more than one unbond ago
    // coverage counters: how often each path actually succeeded
    uint256 public nOpened;
    uint256 public nAttested;
    uint256 public nJailed;
    uint256 public nUnjailed;
    uint256 public nExited;
    uint256 public nWithdrawn;
    uint256 public nSlashed;
    uint256 public nExecuted;
    uint256 public nVetoed;
    uint256 public nClaimed;
    uint256 public nReturned;
    uint256 public nRotated;

    constructor(ValidatorHub hub_, ValidatorHubLens lens_, address msig_, address sink_) {
        hub = hub_;
        lens = lens_;
        msig = msig_;
        sinkAddr = sink_;
    }

    function seatCount() external view returns (uint256) {
        return seats.length;
    }

    function _pick(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (seats.length == 0) return (0, false);
        return (seats[seed % seats.length], true);
    }

    function _sign(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ actions

    function open(uint256 actorSeed) external {
        if (seats.length >= MAX_SEATS_USED || hub.occupiedSeats() >= hub.maxSeats()) return;
        address owner = address(uint160(0xA0000 + actorSeed % 6));
        uint256 a = nextPk++;
        uint256 n = nextPk++;
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(owner, att));
        (bytes memory pub, bytes memory nSig) = _node(n, owner, att);
        vm.deal(owner, owner.balance + 2_000 ether);
        vm.prank(owner);
        try hub.openSeat{value: 2_000 ether}(att, aSig, pub, nSig) returns (uint256 id) {
            seats.push(id);
            attPkOf[id] = a;
            ghostDeposited += 2_000 ether;
            ++nOpened;
        } catch {}
    }

    function _node(uint256 n, address owner, address att) internal returns (bytes memory pub, bytes memory sig) {
        VmSafe.Wallet memory w = vm.createWallet(n);
        pub = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        sig = _sign(n, hub.enodeDigest(owner, att));
    }

    function advance(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 1, 40_000));
    }

    function leap(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 40_000, 200_000));
    }

    function attest(uint256 mask, uint256 offset) external {
        uint256 h = ((block.number - 64) / 200 + 1) * 200;
        vm.roll(h + 64 + bound(offset, 0, 186));
        bytes32 hash = keccak256(abi.encode("inv-block", h));
        vm.setBlockhash(h, hash);
        bytes memory blob;
        for (uint256 i; i < seats.length; ++i) {
            if ((mask >> i) & 1 == 1) {
                blob = bytes.concat(blob, _sign(attPkOf[seats[i]], hub.attestationDigest(uint64(h), hash)));
            }
        }
        if (blob.length == 0) return;
        uint256 allocatedBefore = lens.accounting().totalAllocated;
        uint256 cap = hub.halvingActive() ? 3.75 ether : 7.5 ether;
        try hub.attestBatch(uint64(h), hash, blob) returns (uint256 accepted) {
            nAttested += accepted;
            uint256 paid = lens.accounting().totalAllocated - allocatedBefore;
            paidAtHeight[h] += paid;
            if (paidAtHeight[h] > ghostMaxPaidPerCheckpoint) ghostMaxPaidPerCheckpoint = paidAtHeight[h];
            if (paidAtHeight[h] > cap) ++ghostBudgetBreaches;
        } catch {}
    }

    function jail(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        try hub.jail(id) {
            ++nJailed;
        } catch {}
    }

    function unjail(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(lens.seat(id).owner);
        try hub.unjail(id) {
            ++nUnjailed;
        } catch {}
    }

    function exit(uint256 seed) external {
        if (seed % 3 != 0) return;
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        vm.prank(lens.seat(id).owner);
        try hub.requestExit(id) {
            ++nExited;
        } catch {}
    }

    function withdraw(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        ValidatorHub.Seat memory s = lens.seat(id);
        address payable to = payable(address(uint160(0xC0000 + id)));
        uint256 before = to.balance;
        vm.prank(s.owner);
        try hub.withdraw(id, to) {
            ++withdrawCount[id];
            ++nWithdrawn;
            uint256 got = to.balance - before;
            ghostWithdrawn += got;
            assertEq(got, s.deposit, "withdraw pays exactly the remaining deposit");
            // a second attempt must fail
            vm.prank(s.owner);
            try hub.withdraw(id, to) {
                ++ghostDoubleWithdrawSucceeded;
            } catch {}
        } catch {}
    }

    function claim(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        ValidatorHub.Seat memory s = lens.seat(id);
        if (s.claimable == 0) return;
        address payable to = payable(address(uint160(0xD0000 + id)));
        uint256 before = to.balance;
        vm.prank(s.owner);
        hub.claim(id, to);
        ghostClaimed += to.balance - before;
        ++nClaimed;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0.01 ether, 30_000 ether); // large enough to reach returnExcess
        vm.deal(address(this), amount);
        hub.fund{value: amount}();
        ghostFunded += amount;
    }

    /// Queue an attester rotation (it replaces any rotation already queued).
    function rotate(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        address owner = lens.seat(id).owner;
        uint256 pk = nextPk++;
        address key = vm.addr(pk);
        bytes memory pop = _sign(pk, hub.attesterKeyDigest(owner, key));
        vm.prank(owner);
        try hub.rotateAttester(id, key, pop) {
            pendingPkOf[id] = pk;
        } catch {}
    }

    function applyRotation(uint256 seed) external {
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        try hub.applyAttesterRotation(id) {
            oldPkOf[id] = attPkOf[id];
            attPkOf[id] = pendingPkOf[id];
            pendingPkOf[id] = 0;
            ++nRotated;
        } catch {}
    }

    function proveDouble(uint256 seed, uint256 cpSeed) external {
        if (cpSeed % 4 != 0) return; // rarer than the other paths, so seats live long enough to earn
        (uint256 id, bool ok) = _pick(seed);
        if (!ok) return;
        uint256 h = (bound(cpSeed, 1, 20_000)) * 200;
        bytes32 hA = keccak256(abi.encode("a", h));
        bytes32 hB = keccak256(abi.encode("b", h));
        // sometimes the evidence comes from a key the seat has since replaced
        uint256 pk = (seed >> 128) % 2 == 1 && oldPkOf[id] != 0 ? oldPkOf[id] : attPkOf[id];
        bytes memory sA = _sign(pk, hub.attestationDigest(uint64(h), hA));
        bytes memory sB = _sign(pk, hub.attestationDigest(uint64(h), hB));
        vm.prank(reporter);
        try hub.proveDoubleAttestation(uint64(h), hA, sA, hB, sB) {
            ++nSlashed;
            uint256 retired = lens.keyRetiredAt(vm.addr(pk));
            if (retired != 0 && block.number >= retired + 172_800) ++ghostStaleKeySlashes;
        } catch {}
    }

    function executeSlash(uint256 seed) external {
        uint256 n = hub.slashCount();
        if (n == 0) return;
        try hub.executeSlash(seed % n + 1) {
            ++nExecuted;
        } catch {}
    }

    function veto(uint256 seed) external {
        uint256 n = hub.slashCount();
        if (n == 0) return;
        vm.prank(msig);
        try hub.veto(seed % n + 1) {
            ++nVetoed;
        } catch {}
    }

    function withdrawCredit() external {
        uint256 c = hub.credits(reporter);
        if (c == 0) return;
        address payable to = payable(makeAddr("inv-reporter-wallet"));
        uint256 before = to.balance;
        vm.prank(reporter);
        hub.withdrawCredit(to);
        ghostCreditsPaid += to.balance - before;
    }

    function returnExcess() external {
        uint256 before = sinkAddr.balance;
        try hub.returnExcess() {
            ghostReturned += sinkAddr.balance - before;
            ++nReturned;
        } catch {}
    }

    /// Everything the owner can do. None of it may move a deposit or pay the owner.
    function ownerOps(uint256 op, uint256 value) external {
        vm.startPrank(msig);
        op = op % 7;
        if (op == 0) hub.setSeatsPaused(value % 2 == 0);
        else if (op == 1) hub.setAttestationsPaused(value % 3 == 0);
        else if (op == 2) hub.closeCommunitySeats();
        else if (op == 3) try hub.queueParam(uint8(value % 7), value % 200) {} catch {}
        else if (op == 4) try hub.applyParam(uint8(value % 7), value % 200) {} catch {}
        else if (op == 5) try hub.queueParam(1, bound(value, 0, 0.05 ether)) {} catch {}
        else try hub.applyParam(1, bound(value, 0, 0.05 ether)) {} catch {}
        vm.stopPrank();
    }
}

/// @notice The money invariants: deposits are conserved and only ever leave to their seat owner
///         (once) or as an executed slash; rewards never exceed what was funded; no checkpoint pays
///         more than the budget guard; the owner is never paid.
contract ValidatorHubInvariantTest is Test {
    ValidatorHub internal hub;
    ValidatorHubLens internal lens;
    HubHandler internal handler;
    FMXRewardSink internal sink;
    address internal msig = makeAddr("inv-msig");

    function setUp() public {
        vm.roll(1_000_000);
        sink = new FMXRewardSink(msig);
        hub = new ValidatorHub(msig, address(sink), new address[](0));
        lens = new ValidatorHubLens(hub);
        handler = new HubHandler(hub, lens, msig, address(sink));
        targetContract(address(handler));
    }

    /// Coverage summary (printed with -vv): the handler must reach every money path.
    function afterInvariant() external view {
        console.log("opened", handler.nOpened(), "attested", handler.nAttested());
        console.log("jailed", handler.nJailed(), "unjailed", handler.nUnjailed());
        console.log("exited", handler.nExited(), "withdrawn", handler.nWithdrawn());
        console.log("slashed", handler.nSlashed(), "executed", handler.nExecuted());
        console.log("vetoed", handler.nVetoed(), "claimed", handler.nClaimed());
        console.log("returned", handler.nReturned(), "rotated", handler.nRotated());
    }

    function _sumDeposits() internal view returns (uint256 sum, uint256 bonded, uint256 counted) {
        uint256 n = hub.seatCount();
        for (uint256 id = 1; id <= n; ++id) {
            ValidatorHub.Seat memory s = lens.seat(id);
            sum += s.deposit;
            if (s.status == 1) ++bonded;
            if (s.countedSince != 0) ++counted;
        }
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_DepositsConserved() public view {
        (uint256 sum,,) = _sumDeposits();
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(t.totalDeposited, handler.ghostDeposited(), "deposits in");
        assertEq(hub.bondedTotal(), sum, "bondedTotal = sum of seat deposits");
        assertEq(t.totalDeposited, sum + t.totalSlashed + t.totalWithdrawn, "deposits = seats + slashed + withdrawn");
        assertEq(t.totalWithdrawn, handler.ghostWithdrawn(), "withdrawn out");
        assertLe(t.totalSlashed * 10, t.totalDeposited, "at most 10% of any deposit is ever slashed");
        assertEq(handler.ghostStaleKeySlashes(), 0, "a key replaced more than one unbond ago slashed its seat");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_BalanceCoversEveryClaim() public view {
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(
            address(hub).balance,
            hub.bondedTotal() + hub.rewardPool() + t.totalClaimable + t.totalCredits + t.pendingBurn,
            "balance = deposits + pool + claimable + credits + pending burn"
        );
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_RewardsNeverExceedFunding() public view {
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(t.totalFunded, handler.ghostFunded(), "funded");
        assertLe(t.totalAllocated, t.totalFunded, "allocated <= funded");
        assertLe(t.totalClaimed, t.totalAllocated, "claimed <= allocated");
        assertEq(t.totalFunded, hub.rewardPool() + t.totalClaimable + t.totalClaimed + t.totalReturned, "reward FMX conserved");
        assertEq(t.totalClaimed, handler.ghostClaimed(), "claimed out");
        assertEq(t.totalReturned, handler.ghostReturned(), "returned to the sink");
        assertEq(handler.ghostBudgetBreaches(), 0, "a checkpoint paid more than the budget guard");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_NoSeatWithdrawsTwice() public view {
        assertEq(handler.ghostDoubleWithdrawSucceeded(), 0, "second withdraw succeeded");
        uint256 n = hub.seatCount();
        for (uint256 id = 1; id <= n; ++id) {
            uint256 c = handler.withdrawCount(id);
            assertLe(c, 1, "withdrew twice");
            assertEq(c == 1, lens.seat(id).status == 3, "withdrawn status matches");
        }
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_SlashesConserved() public view {
        ValidatorHub.Accounting memory t = lens.accounting();
        assertEq(
            t.totalSlashed,
            t.totalCredits + handler.ghostCreditsPaid() + t.totalBurned + t.pendingBurn,
            "slashed = reporter credits + credits paid + burned"
        );
        assertEq(t.totalSlashed, t.totalBurned + t.pendingBurn + t.totalSlashed / 10, "10% reporter, 90% burned");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_SeatBookkeeping() public view {
        (, uint256 bonded, uint256 counted) = _sumDeposits();
        assertEq(hub.occupiedSeats(), bonded, "occupied = bonded seats");
        assertLe(hub.occupiedSeats(), hub.maxSeats(), "never above maxSeats");
        assertEq(hub.eligibleCount(), counted, "eligibleCount = counted seats");
        assertEq(msig.balance, 0, "the owner is never paid");
    }
}
