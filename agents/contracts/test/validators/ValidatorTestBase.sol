// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../../src/validators/ValidatorHubLens.sol";
import {FMXRewardSink} from "./utils/FMXRewardSink.sol";

/// @notice Shared fixture: the real FMXRewardSink (symlinked from contracts/src), a hub owned by
///         a stand-in multisig, its lens, and helpers that build every signature the hub checks.
abstract contract ValidatorTestBase is Test {
    ValidatorHub internal hub;
    ValidatorHubLens internal lens;
    FMXRewardSink internal sink;

    address internal msig = makeAddr("msig");
    address internal premine = makeAddr("premine");
    address internal relay = makeAddr("relay");

    uint256 internal constant START = 1_000_000;
    uint256 internal constant DAY = 12_343;
    uint256 internal constant CP = 200;
    uint256 internal constant DEPOSIT = 2_000 ether;
    uint256 internal constant RATE = 0.025 ether;
    uint256 internal constant TIMELOCK = 24_686;
    uint256 internal constant ELIG = 86_400;
    uint256 internal constant UNBOND = 172_800;

    // seat id => keys
    mapping(uint256 => uint256) internal attPk;
    mapping(uint256 => uint256) internal nodePk;
    uint256 internal nextPk = 0xA11CE;

    function setUp() public virtual {
        vm.roll(START);
        sink = new FMXRewardSink(msig);
        address[] memory deny = new address[](1);
        deny[0] = premine;
        hub = new ValidatorHub(msig, address(sink), deny);
        lens = new ValidatorHubLens(hub);
    }

    // ------------------------------------------------------------------ signatures

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pubkey(uint256 pk) internal returns (bytes memory) {
        Vm.Wallet memory w = vm.createWallet(pk);
        return abi.encodePacked(w.publicKeyX, w.publicKeyY);
    }

    function _attSig(uint256 pk, uint256 h, bytes32 hash) internal view returns (bytes memory) {
        return _sign(pk, hub.attestationDigest(uint64(h), hash));
    }

    function _freshPk() internal returns (uint256 pk) {
        pk = nextPk++;
    }

    // ------------------------------------------------------------------ seats

    function _open(address owner) internal returns (uint256 id) {
        uint256 a = _freshPk();
        uint256 n = _freshPk();
        id = _openWith(owner, a, n);
    }

    function _openWith(address owner, uint256 a, uint256 n) internal returns (uint256 id) {
        address att = vm.addr(a);
        bytes memory aSig = _sign(a, hub.attesterKeyDigest(owner, att));
        bytes memory pub = _pubkey(n);
        bytes memory nSig = _sign(n, hub.enodeDigest(owner, att));
        vm.deal(owner, owner.balance + DEPOSIT);
        vm.prank(owner);
        id = hub.openSeat{value: DEPOSIT}(att, aSig, pub, nSig);
        attPk[id] = a;
        nodePk[id] = n;
    }

    function _openMany(uint256 count) internal returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _open(address(uint160(0x10000 + i)));
        }
    }

    function _seat(uint256 id) internal view returns (ValidatorHub.Seat memory) {
        return lens.seat(id);
    }

    // ------------------------------------------------------------------ checkpoints

    function _hashOf(uint256 h) internal pure returns (bytes32) {
        return keccak256(abi.encode("ferminux-block", h));
    }

    /// Next checkpoint height whose inclusion window opens at or after the current block.
    function _nextCheckpoint() internal view returns (uint256 h) {
        h = ((block.number - 64) / CP + 1) * CP;
        if (h + 64 < block.number) h += CP;
    }

    /// Roll to the start of checkpoint h's inclusion window and make blockhash(h) known.
    function _enterWindow(uint256 h) internal {
        if (block.number < h + 64) vm.roll(h + 64);
        vm.setBlockhash(h, _hashOf(h));
    }

    function _attestBatch(uint256 h, uint256[] memory ids) internal returns (uint256 accepted) {
        bytes memory blob;
        for (uint256 i; i < ids.length; ++i) {
            blob = bytes.concat(blob, _attSig(attPk[ids[i]], h, _hashOf(h)));
        }
        vm.prank(relay);
        accepted = hub.attestBatch(uint64(h), _hashOf(h), blob);
    }

    /// Attest checkpoint after checkpoint with `ids` for `n` checkpoints, starting at the next one.
    function _attestRun(uint256[] memory ids, uint256 n) internal returns (uint256 lastH) {
        uint256 h = _nextCheckpoint();
        for (uint256 i; i < n; ++i) {
            _enterWindow(h);
            if (ids.length != 0) _attestBatch(h, ids);
            lastH = h;
            h += CP;
        }
    }

    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        hub.fund{value: amount}();
    }

    function _setParam(uint8 p, uint256 v) internal {
        vm.prank(msig);
        hub.queueParam(p, v);
        vm.roll(block.number + TIMELOCK);
        vm.prank(msig);
        hub.applyParam(p, v);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }
}

/// @notice Minimal RLP encoder for building block-header preimages in tests.
library RLPTest {
    function str(bytes memory b) internal pure returns (bytes memory) {
        if (b.length == 1 && uint8(b[0]) < 0x80) return b;
        return bytes.concat(_len(b.length, 0x80), b);
    }

    function uintStr(uint256 v) internal pure returns (bytes memory) {
        if (v == 0) return hex"80";
        bytes memory b;
        while (v != 0) {
            b = bytes.concat(bytes1(uint8(v & 0xff)), b);
            v >>= 8;
        }
        return str(b);
    }

    function list(bytes[] memory items) internal pure returns (bytes memory) {
        bytes memory body;
        for (uint256 i; i < items.length; ++i) {
            body = bytes.concat(body, items[i]);
        }
        return bytes.concat(_len(body.length, 0xc0), body);
    }

    function _len(uint256 n, uint8 base) private pure returns (bytes memory) {
        if (n <= 55) return abi.encodePacked(bytes1(uint8(base + n)));
        bytes memory b;
        uint256 x = n;
        while (x != 0) {
            b = bytes.concat(bytes1(uint8(x & 0xff)), b);
            x >>= 8;
        }
        return bytes.concat(bytes1(uint8(base + 55 + b.length)), b);
    }

    /// A Clique-style header seal preimage (16 fields, London): the header with the 65-byte
    /// signature removed from extraData.
    function header(bytes32 parent, uint256 number, uint256 time, bytes32 txRoot) internal pure returns (bytes memory) {
        bytes[] memory f = new bytes[](16);
        f[0] = str(abi.encodePacked(parent));
        f[1] = str(abi.encodePacked(keccak256("uncles")));
        f[2] = str(abi.encodePacked(address(0)));
        f[3] = str(abi.encodePacked(keccak256(abi.encode("root", number))));
        f[4] = str(abi.encodePacked(txRoot));
        f[5] = str(abi.encodePacked(keccak256("receipts")));
        f[6] = str(new bytes(256));
        f[7] = uintStr(2);
        f[8] = uintStr(number);
        f[9] = uintStr(100_000_000);
        f[10] = uintStr(21_000);
        f[11] = uintStr(time);
        f[12] = str(new bytes(32));
        f[13] = str(abi.encodePacked(bytes32(0)));
        f[14] = str(abi.encodePacked(bytes8(0)));
        f[15] = uintStr(7);
        return list(f);
    }
}
