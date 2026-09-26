// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";

/// @notice Load test at the hard ceiling of 1,000 seats (PLAN 10.1 item 8). Storage is cooled
///         (vm.cool) before every measured call so the numbers are cold-access, one-transaction
///         costs; the calldata part of the intrinsic cost is added for the batch transactions.
/// forge-config: default.fuzz.runs = 1
contract ValidatorHubGasTest is ValidatorTestBase {
    uint256 internal constant SEATS = 1_000;
    uint256 internal constant BLOCK_GAS_LIMIT = 100_000_000; // the mainnet block gas limit
    uint256 internal constant WINDOW_BLOCKS = 187; // inclusion window [h+64, h+250]

    uint256[] internal ids;

    struct Gas {
        uint256 open;
        uint256 sync;
        uint256 firstAll;
        uint256 execAll;
        uint256 totalAll;
        uint256 totalTen;
        uint256 maxTx;
        uint256 jail;
        uint256 singleFirst;
        uint256 singleNext;
    }

    function setUp() public override {
        super.setUp();
        // reach 1,000 seats the only way the hub allows: after the 30-day launch cap, with the
        // reward lowered first so 1,000 x rate stays within 7.5 FMX per checkpoint
        vm.roll(START + 370_286);
        _setParam(1, 0.0075 ether);
        _setParam(0, SEATS);
        _setParam(2, 50);
        _fund(100_000 ether);
    }

    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _blob(uint256 h, uint256 from, uint256 to) internal view returns (bytes memory blob) {
        blob = new bytes((to - from) * 65);
        bytes32 hash = _hashOf(h);
        bytes32 digest = hub.attestationDigest(uint64(h), hash);
        for (uint256 i = from; i < to; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(attPk[ids[i]], digest);
            uint256 o = (i - from) * 65;
            assembly {
                let p := add(add(blob, 32), o)
                mstore(p, r)
                mstore(add(p, 32), s)
                mstore8(add(p, 64), v)
            }
        }
    }

    function _measure(uint256 h, bytes memory blob) internal returns (uint256 exec, uint256 total) {
        bytes memory call = abi.encodeCall(hub.attestBatch, (uint64(h), _hashOf(h), blob));
        vm.cool(address(hub));
        uint256 g0 = gasleft();
        (bool ok,) = address(hub).call(call);
        exec = g0 - gasleft();
        require(ok, "attestBatch failed");
        total = exec + _intrinsic(call);
    }

    function test_Gas_ThousandSeats() public {
        Gas memory g;
        // ---- open 1,000 seats (all in one block: the churn limit spreads activation over 20 days)
        for (uint256 i; i < SEATS; ++i) {
            address owner = address(uint160(0x50000 + i));
            if (i == SEATS - 1) {
                uint256 a = _freshPk();
                uint256 n = _freshPk();
                address att = vm.addr(a);
                bytes memory aSig = _sign(a, hub.attesterKeyDigest(owner, att));
                bytes memory pub = _pubkey(n);
                bytes memory nSig = _sign(n, hub.enodeDigest(owner, att));
                vm.deal(owner, DEPOSIT);
                vm.cool(address(hub));
                vm.prank(owner);
                uint256 g0 = gasleft();
                uint256 id = hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);
                g.open = g0 - gasleft();
                attPk[id] = a;
                ids.push(id);
            } else {
                ids.push(_open(owner));
            }
        }
        assertEq(hub.occupiedSeats(), SEATS);
        uint256 lastAct = _seat(ids[SEATS - 1]).activationBlock;
        assertEq(lastAct / DAY - _seat(ids[0]).activationBlock / DAY, SEATS / 50 - 1, "50 activations a day");

        // ---- everyone eligible; the cursor catches up in one call
        vm.roll(lastAct + ELIG);
        vm.cool(address(hub));
        uint256 g1 = gasleft();
        hub.sync(SEATS);
        g.sync = g1 - gasleft();
        assertEq(hub.eligibleCount(), SEATS);

        // ---- first checkpoint: every seat's FIRST attestation, all 1,000 in ONE transaction.
        // Each seat's ring word goes from zero to non-zero here (a one-time 20k SSTORE per seat;
        // in practice seats arrive at most 50 a day, so this never happens all at once).
        uint256 h = _nextCheckpoint();
        _enterWindow(h);
        (, g.firstAll) = _measure(h, _blob(h, 0, SEATS));
        ValidatorHub.Checkpoint memory cp = hub.checkpoint(h);
        assertEq(cp.total, SEATS);
        assertTrue(cp.certified);

        // ---- steady state: the next checkpoint, all 1,000 in ONE transaction
        uint256 h2 = h + CP;
        _enterWindow(h2);
        (g.execAll, g.totalAll) = _measure(h2, _blob(h2, 0, SEATS));
        assertTrue(hub.isCertified(h2, _hashOf(h2)));

        // ---- steady state as a relay would send it: 10 transactions of 100
        uint256 h3 = h2 + CP;
        _enterWindow(h3);
        for (uint256 k; k < 10; ++k) {
            (, uint256 t) = _measure(h3, _blob(h3, k * 100, (k + 1) * 100));
            g.totalTen += t;
            if (t > g.maxTx) g.maxTx = t;
        }
        assertEq(hub.checkpoint(h3).total, SEATS);

        // ---- self-submission: one attest() transaction, first and second of a checkpoint
        uint256 h4 = h3 + CP;
        _enterWindow(h4);
        g.singleFirst = _single(h4, 0);
        g.singleNext = _single(h4, 1);

        // ---- the other per-seat entry points stay flat at 1,000 seats
        vm.roll(block.number + 125 * CP); // nobody attests for 125 checkpoints
        vm.cool(address(hub));
        uint256 g2 = gasleft();
        hub.jail(ids[500]);
        g.jail = g2 - gasleft();
        _report(g);
    }

    function _single(uint256 h, uint256 i) internal returns (uint256) {
        bytes memory call = abi.encodeCall(hub.attest, (uint64(h), _hashOf(h), _attSig(attPk[ids[i]], h, _hashOf(h))));
        vm.cool(address(hub));
        uint256 g0 = gasleft();
        (bool ok,) = address(hub).call(call);
        uint256 used = g0 - gasleft();
        require(ok, "attest failed");
        return used + _intrinsic(call);
    }

    function _report(Gas memory g) internal pure {

        console.log("openSeat (1,000th seat)          ", g.open);
        console.log("sync of 1,000 newly eligible     ", g.sync);
        console.log("first-ever attestations, 1,000   ", g.firstAll);
        console.log("attestBatch 1,000 sigs, one tx   ", g.totalAll);
        console.log("  execution only                 ", g.execAll);
        console.log("  per attestation                ", g.totalAll / SEATS);
        console.log("attestBatch 10 x 100, sum        ", g.totalTen);
        console.log("  largest single tx              ", g.maxTx);
        console.log("jail at 1,000 seats              ", g.jail);
        console.log("attest() alone, first of a cp    ", g.singleFirst);
        console.log("attest() alone, later in the cp  ", g.singleNext);
        console.log("avg gas/block over the window    ", g.totalAll / WINDOW_BLOCKS);

        // a steady-state checkpoint for 1,000 seats fits one 30M-gas block; even every seat's
        // first attestation at once fits half of the 100M block; spread over the inclusion window
        // a checkpoint is under 1% of the block gas limit per block
        assertLt(g.firstAll, BLOCK_GAS_LIMIT / 2, "first-ever attestations fit half a block");
        assertLt(g.totalAll, 30_000_000, "1,000 attestations fit one 30M block");
        assertLt(g.totalAll / WINDOW_BLOCKS, BLOCK_GAS_LIMIT / 100, "under 1% of block gas per block");
        assertLt(g.maxTx, 3_500_000);
        assertLt(g.jail, 60_000);
        assertLt(g.singleFirst, 150_000);
        assertLt(g.singleNext, 100_000);
        assertLt(g.open, 350_000);
        assertLt(g.sync, 30_000_000);
    }

    function test_Gas_PreviewAtThousandCandidates() public {
        // fabricate 1,000 qualified keys in slots 0/1 (qualifying 1,000 seats for real would
        // take 30 days of attestations per seat) and preview the election
        vm.store(address(hub), bytes32(uint256(0)), bytes32(SEATS));
        bytes32 base = keccak256(abi.encode(uint256(0)));
        for (uint256 i; i < SEATS; ++i) {
            address key = address(uint160(uint256(keccak256(abi.encode("cand", i)))));
            vm.store(address(hub), bytes32(uint256(base) + i), bytes32(uint256(uint160(key))));
            vm.store(address(hub), keccak256(abi.encode(key, uint256(1))), bytes32(uint256(2_000 ether)));
        }
        _setParam(4, 1);
        uint256 g0 = gasleft();
        address[] memory c = lens.electablePreview(block.number);
        uint256 used = g0 - gasleft();
        console.log("electablePreview, 1,000 candidates", used);
        assertEq(c.length, 64);
        assertLt(used, 50_000_000, "fits the default eth_call gas cap");
    }
}
