// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorHub} from "./ValidatorHub.sol";

/// @title ValidatorHubLens: read-only views over ValidatorHub
/// @notice Decodes the hub's storage (read through ValidatorHub.extsload) into seats, slashes,
///         enodes, running totals and the Step 2 slots, and previews the engine's election. It
///         holds nothing, changes nothing and nothing trusts it; it exists so the hub's own
///         runtime stays under the 24 KB code limit. The slot numbers below are the hub's
///         storage layout, which never changes (the hub is not upgradeable); the lens tests
///         check every decoded field against state the hub itself produced.
contract ValidatorHubLens {
    // ValidatorHub storage slots (forge inspect ValidatorHub storageLayout)
    uint256 internal constant SLOT_SIGNING_KEYS = 0;
    uint256 internal constant SLOT_COUNTED_BOND = 1;
    uint256 internal constant SLOT_QUALIFIED_AT = 2;
    uint256 internal constant SLOT_REWARD_TO = 3;
    uint256 internal constant SLOT_JAIL = 4;
    uint256 internal constant SLOT_ACCOUNTING = 22; // 11 consecutive slots
    uint256 internal constant SLOT_SEATS = 33; // Seat: 6 slots
    uint256 internal constant SLOT_ENODE = 35; // bytes32[2]
    uint256 internal constant SLOT_SLASHES = 39; // Slash: 2 slots
    uint256 internal constant SLOT_RETIRED_AT = 46; // mapping(address => uint256)

    uint256 internal constant SEAT_DEPOSIT = 2_000 ether;
    uint256 internal constant MAX_SIGNING_CANDIDATES = 1_000;
    uint256 internal constant MIN_COMMUNITY_SEATS = 4;
    uint256 internal constant MAX_COMMUNITY_SEATS = 64;
    uint256 internal constant ROTATION_INTERVAL = 600;
    uint256 internal constant CHECKPOINT_INTERVAL = 200;
    uint256 internal constant BLOCKS_PER_DAY = 12_343;

    ValidatorHub public immutable hub;

    constructor(ValidatorHub hub_) {
        hub = hub_;
    }

    // ------------------------------------------------------------------ seats and slashes

    function seat(uint256 seatId) external view returns (ValidatorHub.Seat memory s) {
        bytes32[] memory w = _range(_mapSlot(bytes32(seatId), SLOT_SEATS), 6);
        uint256 a = uint256(w[0]);
        s.claimable = uint96(a);
        s.lastAttestedCp = uint32(a >> 96);
        s.dutyStartCp = uint32(a >> 128);
        s.activationBlock = uint40(a >> 160);
        s.countedSince = uint40(a >> 200);
        s.status = uint8(a >> 240);
        s.jailed = uint8(a >> 248) != 0;
        uint256 b = uint256(w[1]);
        s.owner = address(uint160(b));
        s.unjailBlock = uint40(b >> 160);
        s.unbondEndBlock = uint40(b >> 200);
        s.slashState = uint8(b >> 240);
        s.qualified = uint8(b >> 248) != 0;
        uint256 c = uint256(w[2]);
        s.attester = address(uint160(c));
        s.deposit = uint96(c >> 160);
        uint256 d = uint256(w[3]);
        s.pendingAttester = address(uint160(d));
        s.attesterRotateBlock = uint40(d >> 160);
        s.signingKey = address(uint160(uint256(w[4])));
        s.rewardTo = address(uint160(uint256(w[5])));
    }

    function slash(uint256 slashId) external view returns (ValidatorHub.Slash memory sl) {
        bytes32[] memory w = _range(_mapSlot(bytes32(slashId), SLOT_SLASHES), 2);
        uint256 a = uint256(w[0]);
        sl.seatId = uint64(a);
        sl.kind = uint8(a >> 64);
        sl.status = uint8(a >> 72);
        sl.executableBlock = uint40(a >> 80);
        sl.vetoSunsetBlock = uint40(a >> 120);
        sl.amount = uint96(a >> 160);
        uint256 b = uint256(w[1]);
        sl.reporter = address(uint160(b));
        sl.height = uint64(b >> 160);
    }

    /// @notice Block at which a replaced attester or signing key was retired (0 = never replaced).
    ///         Double-sign evidence against it is accepted until 14 days (172,800 blocks) later.
    function keyRetiredAt(address key) external view returns (uint256) {
        return uint256(_one(_mapSlot(bytes32(uint256(uint160(key))), SLOT_RETIRED_AT)));
    }

    function enodeOf(uint256 seatId) external view returns (bytes memory) {
        bytes32[] memory w = _range(_mapSlot(bytes32(seatId), SLOT_ENODE), 2);
        return abi.encodePacked(w[0], w[1]);
    }

    function accounting() external view returns (ValidatorHub.Accounting memory t) {
        bytes32[] memory w = _range(bytes32(SLOT_ACCOUNTING), 11);
        t.totalDeposited = uint256(w[0]);
        t.totalWithdrawn = uint256(w[1]);
        t.totalSlashed = uint256(w[2]);
        t.totalBurned = uint256(w[3]);
        t.pendingBurn = uint256(w[4]);
        t.totalCredits = uint256(w[5]);
        t.totalFunded = uint256(w[6]);
        t.totalAllocated = uint256(w[7]);
        t.totalClaimable = uint256(w[8]);
        t.totalClaimed = uint256(w[9]);
        t.totalReturned = uint256(w[10]);
    }

    /// @notice Days the unallocated pool lasts if every seat attests every checkpoint.
    function runwayDays() external view returns (uint256) {
        uint256 perCp = hub.maxSeats() * hub.currentRewardPerAttest();
        if (perCp == 0) return type(uint256).max;
        return hub.rewardPool() / perCp * CHECKPOINT_INTERVAL / BLOCKS_PER_DAY;
    }

    // ------------------------------------------------------------------ Step 2 slots, decoded

    function signingKeys() public view returns (address[] memory keys) {
        uint256 len = uint256(_one(bytes32(SLOT_SIGNING_KEYS)));
        bytes32[] memory w = _range(keccak256(abi.encode(SLOT_SIGNING_KEYS)), len);
        keys = new address[](len);
        for (uint256 i; i < len; ++i) {
            keys[i] = address(uint160(uint256(w[i])));
        }
    }

    function countedBond(address key) public view returns (uint256) {
        return uint256(_one(_mapSlot(bytes32(uint256(uint160(key))), SLOT_COUNTED_BOND)));
    }

    function qualifiedAt(address key) external view returns (uint256) {
        return uint256(_one(_mapSlot(bytes32(uint256(uint160(key))), SLOT_QUALIFIED_AT)));
    }

    function rewardToOf(address key) external view returns (address) {
        return address(uint160(uint256(_one(_mapSlot(bytes32(uint256(uint160(key))), SLOT_REWARD_TO)))));
    }

    /// @notice Engine-owned jail word of a signing key: jailedUntil (bits 0-63), offences
    ///         (64-95), lastOffence (96-159).
    function jailOf(address key) public view returns (uint64 jailedUntil, uint32 offences, uint64 lastOffence) {
        uint256 w = uint256(_one(_mapSlot(bytes32(uint256(uint160(key))), SLOT_JAIL)));
        return (uint64(w), uint32(w >> 64), uint64(w >> 96));
    }

    /// @notice Mirror of the engine's Elect(state) at rotation block `n` (PLAN 4.4), sorted
    ///         ascending. It cannot apply the "key not in F" rule, which needs the header chain.
    function electablePreview(uint256 n) external view returns (address[] memory c) {
        if (!hub.communitySeatsOpen()) return c;
        address[] memory keys = signingKeys();
        uint256 len = keys.length;
        if (len > MAX_SIGNING_CANDIDATES) len = MAX_SIGNING_CANDIDATES;
        // one extsload for every key's countedBond (slot 1) and jail word (slot 4)
        bytes32[] memory q = new bytes32[](2 * len);
        for (uint256 i; i < len; ++i) {
            bytes32 keyWord = bytes32(uint256(uint160(keys[i])));
            q[2 * i] = _mapSlot(keyWord, SLOT_COUNTED_BOND);
            q[2 * i + 1] = _mapSlot(keyWord, SLOT_JAIL);
        }
        bytes32[] memory w = hub.extsload(q);
        uint256[] memory l = new uint256[](len);
        uint256 m;
        for (uint256 i; i < len; ++i) {
            if (uint256(w[2 * i]) == SEAT_DEPOSIT && uint64(uint256(w[2 * i + 1])) <= n) l[m++] = uint160(keys[i]);
        }
        if (m < MIN_COMMUNITY_SEATS) return c;
        assembly {
            mstore(l, m)
        }
        _sort(l);
        uint256 v = hub.openSeatsBlock();
        uint256 k = (v != 0 && n >= v) ? (n - v) / ROTATION_INTERVAL : 0;
        uint256 size = m < MAX_COMMUNITY_SEATS ? m : MAX_COMMUNITY_SEATS;
        uint256[] memory sel = new uint256[](size);
        for (uint256 i; i < size; ++i) {
            sel[i] = l[(k * MAX_COMMUNITY_SEATS + i) % m];
        }
        _sort(sel);
        c = new address[](size);
        for (uint256 i; i < size; ++i) {
            c[i] = address(uint160(sel[i]));
        }
    }

    // ------------------------------------------------------------------ internals

    function _mapSlot(bytes32 key, uint256 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slot));
    }

    function _one(bytes32 slot) internal view returns (bytes32) {
        bytes32[] memory q = new bytes32[](1);
        q[0] = slot;
        return hub.extsload(q)[0];
    }

    function _range(bytes32 start, uint256 n) internal view returns (bytes32[] memory) {
        bytes32[] memory q = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            q[i] = bytes32(uint256(start) + i);
        }
        return hub.extsload(q);
    }

    /// In-place heapsort, ascending.
    function _sort(uint256[] memory a) internal pure {
        uint256 n = a.length;
        if (n < 2) return;
        for (uint256 i = n / 2; i > 0; --i) {
            _siftDown(a, i - 1, n);
        }
        for (uint256 end = n - 1; end > 0; --end) {
            (a[0], a[end]) = (a[end], a[0]);
            _siftDown(a, 0, end);
        }
    }

    function _siftDown(uint256[] memory a, uint256 root, uint256 n) internal pure {
        while (true) {
            uint256 child = 2 * root + 1;
            if (child >= n) return;
            if (child + 1 < n && a[child + 1] > a[child]) ++child;
            if (a[root] >= a[child]) return;
            (a[root], a[child]) = (a[child], a[root]);
            root = child;
        }
    }
}
