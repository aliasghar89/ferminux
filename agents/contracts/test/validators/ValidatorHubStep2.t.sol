// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorTestBase, RLPTest} from "./ValidatorTestBase.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {HeaderRLP, SealEvidence} from "../../src/validators/HeaderRLP.sol";

/// @notice Step 2 surface, live from day one but read by the engine only from block V: the
///         pinned storage slots 0-5, signing keys, qualify/disqualify, the election preview, the
///         community-seat switch and double-sign header evidence.
contract ValidatorHubStep2Test is ValidatorTestBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256[] internal ids;
    mapping(uint256 => uint256) internal signPk;

    function setUp() public override {
        super.setUp();
        ids.push(_open(alice));
        ids.push(_open(bob));
        ids.push(_open(carol));
        for (uint256 i; i < ids.length; ++i) {
            _setSigningKey(ids[i]);
        }
    }

    function _setSigningKey(uint256 seatId) internal returns (address key) {
        uint256 pk = _freshPk();
        key = vm.addr(pk);
        address owner = _seat(seatId).owner;
        bytes memory pop = _sign(pk, hub.signingKeyDigest(seatId, key, owner));
        vm.prank(owner);
        hub.setSigningKey(seatId, key, pop);
        signPk[seatId] = pk;
    }

    /// Run every seat through 30 days active with a full 432-checkpoint record.
    function _qualifyAll() internal {
        uint256 ready = _seat(ids[2]).activationBlock + 370_286;
        vm.roll(ready - 440 * CP);
        uint256 lastH = _attestRun(ids, 440);
        vm.roll(lastH + 251);
        for (uint256 i; i < ids.length; ++i) {
            hub.qualify(ids[i]);
        }
    }

    function _keyWord(address key) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(key)));
    }

    function _mapSlot(address key, uint256 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slot));
    }

    // ================================================================= signing keys

    function _expectPopRejected(uint256 seatId, address key, bytes memory pop) internal {
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadPossession.selector);
        hub.setSigningKey(seatId, key, pop);
    }

    function test_SigningKey_PossessionBoundToSeatOwnerAndNetwork() public {
        uint256 pk = _freshPk();
        address key = vm.addr(pk);
        uint256 seatId = ids[0];
        _expectPopRejected(seatId, key, _sign(pk, hub.signingKeyDigest(seatId + 1, key, alice)));
        _expectPopRejected(seatId, key, _sign(pk, hub.signingKeyDigest(seatId, key, bob)));
        uint256 cid = block.chainid;
        vm.chainId(39610);
        bytes32 otherNet = hub.signingKeyDigest(seatId, key, alice);
        vm.chainId(cid);
        _expectPopRejected(seatId, key, _sign(pk, otherNet));

        bytes memory good = _sign(pk, hub.signingKeyDigest(seatId, key, alice));
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotSeatOwner.selector);
        hub.setSigningKey(seatId, key, good);
    }

    function test_SigningKey_UniqueAndReplaceable() public {
        uint256 seatId = ids[0];
        address att = _seat(seatId).attester;
        address otherSeatKey = _seat(ids[1]).signingKey;
        vm.startPrank(alice);
        vm.expectRevert(ValidatorHub.KeyUsed.selector);
        hub.setSigningKey(seatId, att, ""); // an attester key never doubles as a signing key
        vm.expectRevert(ValidatorHub.KeyUsed.selector);
        hub.setSigningKey(seatId, otherSeatKey, ""); // nor is shared between seats
        vm.expectRevert(ValidatorHub.BadKey.selector);
        hub.setSigningKey(seatId, alice, "");
        vm.stopPrank();

        // replacing an unqualified key is allowed; the old key stays bound to the seat
        address old = _seat(seatId).signingKey;
        address key = _setSigningKey(seatId);
        assertEq(_seat(seatId).signingKey, key);
        assertEq(uint256(hub.keyInfo(old).seatId), seatId);
        assertFalse(hub.keyInfo(old).active);
        assertEq(hub.keyInfo(key).role, 2);
    }

    // ================================================================= qualify and pinned slots

    function test_Qualify_WritesPinnedSlots() public {
        _qualifyAll();
        address k0 = _seat(ids[0]).signingKey;
        address k1 = _seat(ids[1]).signingKey;
        address k2 = _seat(ids[2]).signingKey;

        // slot 0: address[] _signingKeys
        assertEq(uint256(vm.load(address(hub), bytes32(uint256(0)))), 3);
        bytes32 base = keccak256(abi.encode(uint256(0)));
        assertEq(vm.load(address(hub), base), _keyWord(k0));
        assertEq(vm.load(address(hub), bytes32(uint256(base) + 1)), _keyWord(k1));
        assertEq(vm.load(address(hub), bytes32(uint256(base) + 2)), _keyWord(k2));
        // slot 1: _countedBond
        assertEq(uint256(vm.load(address(hub), _mapSlot(k0, 1))), 2_000 ether);
        // slot 2: _qualifiedAt
        assertEq(uint256(vm.load(address(hub), _mapSlot(k0, 2))), block.number);
        // slot 3: _rewardTo (defaults to the owner)
        assertEq(vm.load(address(hub), _mapSlot(k0, 3)), _keyWord(alice));
        vm.prank(alice);
        hub.setRewardTo(ids[0], carol);
        assertEq(vm.load(address(hub), _mapSlot(k0, 3)), _keyWord(carol));
        assertEq(lens.rewardToOf(k0), carol);
        // slot 4: _jail, engine-owned, only decoded
        uint256 word = uint256(1_500_000) | (uint256(2) << 64) | (uint256(1_400_000) << 96);
        vm.store(address(hub), _mapSlot(k0, 4), bytes32(word));
        (uint64 until, uint32 offences, uint64 lastOffence) = lens.jailOf(k0);
        assertEq(uint256(until), 1_500_000);
        assertEq(uint256(offences), 2);
        assertEq(uint256(lastOffence), 1_400_000);
        // slot 5: _flags bit 0
        assertEq(uint256(vm.load(address(hub), bytes32(uint256(5)))), 0);
        _setParam(4, 1);
        assertEq(uint256(vm.load(address(hub), bytes32(uint256(5)))), 1);
        assertTrue(hub.communitySeatsOpen());

        // the lens reads the same values
        address[] memory keys = lens.signingKeys();
        assertEq(keys.length, 3);
        assertEq(keys[1], k1);
        assertEq(lens.countedBond(k2), 2_000 ether);
        assertEq(lens.qualifiedAt(k1), block.number - 24_686);
        assertTrue(_seat(ids[0]).qualified);
    }

    function test_Qualify_NinetyPercentOf432AndAKey() public {
        uint256 keyless = _open(makeAddr("keyless"));
        uint256 ready = _seat(keyless).activationBlock + 370_286;
        vm.roll(ready - 440 * CP);
        uint256[] memory all = new uint256[](4);
        (all[0], all[1], all[2], all[3]) = (ids[0], ids[1], ids[2], keyless);
        uint256[] memory some = new uint256[](2);
        (some[0], some[1]) = (ids[0], keyless);
        // ids[1] attests 389 of the last 432 checkpoints, ids[2] only 388
        uint256 h = _nextCheckpoint();
        for (uint256 i; i < 440; ++i) {
            _enterWindow(h);
            if (i < 440 - 44) _attestBatch(h, all);
            else if (i < 440 - 43) _attestBatch(h, _pair(ids[0], ids[1], keyless));
            else _attestBatch(h, some);
            h += CP;
        }
        vm.roll(h - CP + 251);
        assertGe(block.number, ready);
        assertEq(hub.participation(ids[1], 432), 389);
        assertEq(hub.participation(ids[2], 432), 388);

        hub.qualify(ids[1]);
        vm.expectRevert(ValidatorHub.NotQualifiable.selector);
        hub.qualify(ids[2]); // below 90%
        vm.expectRevert(ValidatorHub.NotQualifiable.selector);
        hub.qualify(keyless); // no signing key
        hub.qualify(ids[0]);
        vm.expectRevert(ValidatorHub.NotQualifiable.selector);
        hub.qualify(ids[0]); // already qualified
        vm.prank(alice);
        vm.expectRevert(ValidatorHub.BadStatus.selector);
        hub.setSigningKey(ids[0], address(1), ""); // key frozen while qualified
    }

    function _pair(uint256 x, uint256 y, uint256 z) internal pure returns (uint256[] memory a) {
        a = new uint256[](3);
        (a[0], a[1], a[2]) = (x, y, z);
    }

    function test_Qualify_NotBefore30Days() public {
        uint256 ready = _seat(ids[2]).activationBlock + 370_286;
        vm.roll(ready - 441 * CP);
        uint256 lastH = _attestRun(ids, 437);
        vm.roll(lastH + 251);
        assertLt(block.number, ready);
        vm.expectRevert(ValidatorHub.NotQualifiable.selector);
        hub.qualify(ids[2]);
    }

    function test_Disqualify_SwapAndPopAndPaths() public {
        _qualifyAll();
        address k0 = _seat(ids[0]).signingKey;
        address k2 = _seat(ids[2]).signingKey;

        // not disqualifiable by others while participation is fine
        vm.prank(carol);
        vm.expectRevert(ValidatorHub.NotDisqualifiable.selector);
        hub.disqualify(ids[0]);

        // the owner can always step out
        vm.prank(alice);
        hub.disqualify(ids[0]);
        address[] memory keys = lens.signingKeys();
        assertEq(keys.length, 2);
        assertEq(keys[0], k2, "last key moved into the gap");
        assertEq(lens.countedBond(k0), 0);
        assertEq(lens.qualifiedAt(k0), 0);
        assertFalse(_seat(ids[0]).qualified);

        // exit disqualifies
        vm.prank(carol);
        hub.requestExit(ids[2]);
        keys = lens.signingKeys();
        assertEq(keys.length, 1);
        assertEq(keys[0], _seat(ids[1]).signingKey);

        // low participation: anyone may disqualify, and jail does it too
        vm.roll(block.number + 125 * CP);
        vm.prank(carol);
        hub.disqualify(ids[1]);
        assertEq(lens.signingKeys().length, 0);
    }

    function test_Disqualify_NotByOthersWhileAttestationsPaused() public {
        _qualifyAll();
        vm.prank(msig);
        hub.setAttestationsPaused(true);
        // a long pause leaves every seat with no recent checkpoints
        vm.roll(block.number + 125 * CP);
        vm.prank(relay);
        vm.expectRevert(ValidatorHub.Paused.selector);
        hub.disqualify(ids[0]);
        // the owner may still step out
        vm.prank(alice);
        hub.disqualify(ids[0]);
        // on resume duty restarts, so the paused stretch never counts against a seat
        vm.prank(msig);
        hub.setAttestationsPaused(false);
        vm.prank(relay);
        vm.expectRevert(ValidatorHub.NotDisqualifiable.selector);
        hub.disqualify(ids[1]);
        assertTrue(_seat(ids[1]).qualified);
        assertEq(lens.signingKeys().length, 2);
    }

    function test_Disqualify_OnJailAndOnSlash() public {
        _qualifyAll();
        // slash: evidence against the attester key of seat 0
        uint256 h = (_seat(ids[0]).lastAttestedCp) * CP;
        bytes memory a = _attSig(attPk[ids[0]], h, _hashOf(h));
        bytes memory b = _attSig(attPk[ids[0]], h, keccak256("fork"));
        hub.proveDoubleAttestation(uint64(h), _hashOf(h), a, keccak256("fork"), b);
        assertFalse(_seat(ids[0]).qualified);
        // jail: seat 1 stops attesting
        vm.roll(block.number + 125 * CP);
        hub.jail(ids[1]);
        assertFalse(_seat(ids[1]).qualified);
        address[] memory keys = lens.signingKeys();
        assertEq(keys.length, 1);
        assertEq(keys[0], _seat(ids[2]).signingKey);
    }

    // ================================================================= community seats switch

    function test_CommunitySeats_OpenByTimelockCloseAtOnce() public {
        assertFalse(hub.communitySeatsOpen());
        vm.prank(bob);
        vm.expectRevert(ValidatorHub.NotOwner.selector);
        hub.closeCommunitySeats();
        vm.prank(msig);
        vm.expectRevert(ValidatorHub.BadParam.selector);
        hub.queueParam(4, 2);
        _setParam(4, 1);
        assertTrue(hub.communitySeatsOpen());
        vm.prank(msig);
        hub.closeCommunitySeats();
        assertFalse(hub.communitySeatsOpen());
    }

    // ================================================================= election preview

    /// Fabricate `n` qualified keys directly in slots 0 and 1 (the lens reads raw storage).
    function _fakeKeys(uint256 n) internal returns (address[] memory keys) {
        keys = new address[](n);
        vm.store(address(hub), bytes32(uint256(0)), bytes32(n));
        bytes32 base = keccak256(abi.encode(uint256(0)));
        for (uint256 i; i < n; ++i) {
            keys[i] = address(uint160(uint256(keccak256(abi.encode("signer", i)))));
            vm.store(address(hub), bytes32(uint256(base) + i), _keyWord(keys[i]));
            vm.store(address(hub), _mapSlot(keys[i], 1), bytes32(uint256(2_000 ether)));
        }
    }

    function _sorted(address[] memory a) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            address x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
        return a;
    }

    function test_Preview_ClosedOrTooFewIsEmpty() public {
        _fakeKeys(10);
        assertEq(lens.electablePreview(block.number).length, 0, "switch closed");
        _setParam(4, 1);
        assertEq(lens.electablePreview(block.number).length, 10);
        _fakeKeys(3);
        assertEq(lens.electablePreview(block.number).length, 0, "fewer than 4 candidates elect nobody");
    }

    function test_Preview_FiltersBondAndJail() public {
        address[] memory keys = _fakeKeys(6);
        _setParam(4, 1);
        uint256 n = 2_000_000;
        vm.store(address(hub), _mapSlot(keys[0], 1), bytes32(uint256(1_800 ether)));
        vm.store(address(hub), _mapSlot(keys[1], 4), bytes32(n + 1)); // jailed past n
        vm.store(address(hub), _mapSlot(keys[2], 4), bytes32(n)); // jailedUntil == n: eligible
        address[] memory c = lens.electablePreview(n);
        assertEq(c.length, 4);
        for (uint256 i; i < c.length; ++i) {
            assertTrue(c[i] != keys[0] && c[i] != keys[1]);
            if (i > 0) assertGt(uint160(c[i]), uint160(c[i - 1]), "sorted ascending");
        }
    }

    function test_Preview_WindowRotation() public {
        address[] memory keys = _fakeKeys(70);
        _setParam(4, 1);
        uint256 v = 1_110_000;
        _setParam(3, v);
        address[] memory l = _sorted(keys);

        // rotation k: sorted { L[(k*64 + i) mod 70] : i < 64 }
        for (uint256 k; k < 3; ++k) {
            address[] memory want = new address[](64);
            for (uint256 i; i < 64; ++i) {
                want[i] = l[(k * 64 + i) % 70];
            }
            want = _sorted(want);
            address[] memory got = lens.electablePreview(v + k * 600);
            assertEq(got.length, 64);
            for (uint256 i; i < 64; ++i) {
                assertEq(got[i], want[i]);
            }
        }
    }

    // ================================================================= double-sign header evidence

    function _headers(uint256 number) internal pure returns (bytes memory a, bytes memory b) {
        bytes32 parent = keccak256(abi.encode("parent", number));
        a = RLPTest.header(parent, number, 1_800_000_000, keccak256("txs A"));
        b = RLPTest.header(parent, number, 1_800_000_000, keccak256("txs B"));
    }

    /// Header signatures as the node produces them: [r || s || v] with v in {0, 1}.
    function _headerSig(uint256 pk, bytes memory preimage) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(preimage));
        return abi.encodePacked(r, s, v - 27);
    }

    function test_DoubleSeal_InertUntilV() public {
        (bytes memory a, bytes memory b) = _headers(2_000_000);
        uint256 pk = signPk[ids[0]];
        bytes memory sa = _headerSig(pk, a);
        bytes memory sb = _headerSig(pk, b);
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleSeal(a, sa, b, sb);
    }

    function test_DoubleSeal_SlashesTheSeat() public {
        uint256 v = 1_110_000;
        _setParam(3, v);
        uint256 seatId = ids[0];
        uint256 pk = signPk[seatId];
        (bytes memory a, bytes memory b) = _headers(v + 5);
        vm.prank(carol);
        uint256 slashId = hub.proveDoubleSeal(a, _headerSig(pk, a), b, _headerSig(pk, b));
        ValidatorHub.Slash memory sl = lens.slash(slashId);
        assertEq(uint256(sl.seatId), seatId);
        assertEq(sl.kind, 2);
        assertEq(uint256(sl.height), v + 5);
        assertEq(uint256(sl.vetoSunsetBlock), v + 2_221_715, "veto sunset counts from V");
        assertEq(uint256(sl.amount), 200 ether);
        assertEq(_seat(seatId).status, 2);
        vm.expectRevert(ValidatorHub.EvidenceUsed.selector);
        hub.proveDoubleSeal(a, _headerSig(pk, a), b, _headerSig(pk, b));
    }

    function test_DoubleSeal_ReplacedSigningKeyIsEvidenceForOneUnbondOnly() public {
        uint256 v = 1_110_000;
        _setParam(3, v);
        uint256 seatId = ids[0];
        uint256 oldPk = signPk[seatId];
        _setSigningKey(seatId);
        uint256 newPk = signPk[seatId];
        uint256 retired = block.number;
        assertEq(lens.keyRetiredAt(vm.addr(oldPk)), retired);
        (bytes memory a, bytes memory b) = _headers(v + 5);

        vm.roll(retired + UNBOND);
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleSeal(a, _headerSig(oldPk, a), b, _headerSig(oldPk, b));
        // the current signing key is still evidence
        uint256 slashId = hub.proveDoubleSeal(a, _headerSig(newPk, a), b, _headerSig(newPk, b));
        assertEq(uint256(lens.slash(slashId).seatId), seatId);
    }

    function test_DoubleSeal_RejectsNonConflicts() public {
        uint256 v = 1_110_000;
        _setParam(3, v);
        uint256 pk = signPk[ids[0]];
        bytes32 parent = keccak256("p");
        bytes memory a = RLPTest.header(parent, v + 5, 1, keccak256("A"));
        bytes memory otherNumber = RLPTest.header(parent, v + 6, 1, keccak256("B"));
        bytes memory otherParent = RLPTest.header(keccak256("q"), v + 5, 1, keccak256("B"));
        bytes memory belowV = RLPTest.header(parent, v - 1, 1, keccak256("A"));
        bytes memory belowV2 = RLPTest.header(parent, v - 1, 1, keccak256("B"));
        bytes memory b = RLPTest.header(parent, v + 5, 1, keccak256("B"));

        vm.expectRevert(SealEvidence.NotADoubleSeal.selector);
        hub.proveDoubleSeal(a, _headerSig(pk, a), otherNumber, _headerSig(pk, otherNumber));
        vm.expectRevert(SealEvidence.NotADoubleSeal.selector);
        hub.proveDoubleSeal(a, _headerSig(pk, a), otherParent, _headerSig(pk, otherParent));
        vm.expectRevert(SealEvidence.NotADoubleSeal.selector);
        hub.proveDoubleSeal(a, _headerSig(pk, a), a, _headerSig(pk, a));
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleSeal(belowV, _headerSig(pk, belowV), belowV2, _headerSig(pk, belowV2));
        // signed by two different keys
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleSeal(a, _headerSig(pk, a), b, _headerSig(signPk[ids[1]], b));
        // an attester key is not a signing key
        vm.expectRevert(ValidatorHub.BadEvidence.selector);
        hub.proveDoubleSeal(a, _headerSig(attPk[ids[0]], a), b, _headerSig(attPk[ids[0]], b));
        // malformed RLP
        bytes memory cut = new bytes(a.length - 1);
        for (uint256 i; i < cut.length; ++i) {
            cut[i] = a[i];
        }
        vm.expectRevert(HeaderRLP.BadHeader.selector);
        hub.proveDoubleSeal(cut, _headerSig(pk, cut), b, _headerSig(pk, b));
    }

    function test_HeaderRLP_ParsesParentAndNumber() public {
        SealEvidence ev = hub.sealEvidence();
        (bytes memory a, bytes memory b) = _headers(123_456_789);
        (uint256 number, bytes32 sa, bytes32 sb) = ev.check(a, b);
        assertEq(number, 123_456_789);
        assertEq(sa, keccak256(a));
        assertEq(sb, keccak256(b));
        // number 0 encodes as the empty string
        (a, b) = _headers(0);
        (number,,) = ev.check(a, b);
        assertEq(number, 0);
        // a list where a string is expected
        bytes[] memory f = new bytes[](9);
        f[0] = RLPTest.str(abi.encodePacked(bytes32(0)));
        for (uint256 i = 1; i < 9; ++i) {
            f[i] = hex"c0";
        }
        bytes memory bad = RLPTest.list(f);
        vm.expectRevert(HeaderRLP.BadHeader.selector);
        ev.check(bad, a);
        // a byte string, not a list
        vm.expectRevert(HeaderRLP.BadHeader.selector);
        ev.check(hex"8412345678", a);
        vm.expectRevert(HeaderRLP.BadHeader.selector);
        ev.check("", a);
    }
}
