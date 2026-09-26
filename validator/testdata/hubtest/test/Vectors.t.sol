// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ValidatorHub} from "hub/validators/ValidatorHub.sol";
import {Sig} from "hub/lib/Sig.sol";

/// Sig.recover takes calldata; this puts it behind an external call.
contract Recoverer {
    function recover(bytes32 digest, bytes calldata sig) external pure returns (address) {
        return Sig.recover(digest, sig);
    }
}

/// The contract half of the signing-format cross-test. The Go sidecar writes
/// ../attestation_vectors.json (validator/internal/attest); this test deploys
/// the real ValidatorHub at the vectors' hub address and checks that it derives
/// the same domain separator and digests, that its signature rules accept and
/// refuse the same signatures, and that the sidecar's openSeat possession proofs
/// and attestation signatures are accepted end to end.
contract VectorsTest is Test {
    address internal constant MULTISIG = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;
    address internal constant SINK = 0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6;

    string internal json;
    Recoverer internal rec;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../attestation_vectors.json"));
        rec = new Recoverer();
    }

    function _hub(address at, uint256 chainId) internal returns (ValidatorHub hub) {
        vm.chainId(chainId);
        address[] memory none = new address[](0);
        // chain 3961 only accepts the foundation multisig and the reward sink
        address own = chainId == 3961 ? MULTISIG : address(this);
        address sink = chainId == 3961 ? SINK : address(0xBEEF);
        deployCodeTo("ValidatorHub.sol:ValidatorHub", abi.encode(own, sink, none), at);
        hub = ValidatorHub(payable(at));
    }

    function _len(string memory arr) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(arr, "[", vm.toString(n), "]"))) n++;
        assertGt(n, 0, arr);
    }

    function _s(string memory p, string memory f) internal pure returns (string memory) {
        return string.concat(p, f);
    }

    function test_typeHashes() public view {
        assertEq(keccak256(bytes(vm.parseJsonString(json, ".domainType"))), vm.parseJsonBytes32(json, ".domainTypeHash"));
        assertEq(Sig.DOMAIN_TYPEHASH, vm.parseJsonBytes32(json, ".domainTypeHash"));
        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".attestationType"))), vm.parseJsonBytes32(json, ".attestationTypeHash")
        );
        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".attesterKeyType"))), vm.parseJsonBytes32(json, ".attesterKeyTypeHash")
        );
    }

    function test_attestationDigests() public {
        uint256 n = _len(".valid");
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".valid[", vm.toString(i), "]");
            ValidatorHub hub = _hub(vm.parseJsonAddress(json, _s(p, ".hub")), vm.parseJsonUint(json, _s(p, ".chainId")));
            assertEq(hub.ATTESTATION_TYPEHASH(), vm.parseJsonBytes32(json, ".attestationTypeHash"));
            uint64 height = uint64(vm.parseJsonUint(json, _s(p, ".height")));
            bytes32 blockHash = vm.parseJsonBytes32(json, _s(p, ".blockHash"));
            assertEq(hub.domainSeparator(), vm.parseJsonBytes32(json, _s(p, ".domainSeparator")), p);
            bytes32 digest = hub.attestationDigest(height, blockHash);
            assertEq(digest, vm.parseJsonBytes32(json, _s(p, ".digest")), p);
            address signer = vm.parseJsonAddress(json, _s(p, ".signer"));
            assertEq(rec.recover(digest, vm.parseJsonBytes(json, _s(p, ".signature"))), signer, p);
            assertEq(vm.addr(uint256(vm.parseJsonBytes32(json, _s(p, ".privateKey")))), signer, p);
        }
    }

    function test_invalidAndRawV() public {
        ValidatorHub hub = _hub(vm.parseJsonAddress(json, ".valid[0].hub"), 3961);
        address seat1 = vm.parseJsonAddress(json, ".valid[0].signer");
        uint256 n = _len(".invalid");
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".invalid[", vm.toString(i), "]");
            bytes32 digest = hub.attestationDigest(
                uint64(vm.parseJsonUint(json, _s(p, ".height"))), vm.parseJsonBytes32(json, _s(p, ".blockHash"))
            );
            address got = rec.recover(digest, vm.parseJsonBytes(json, _s(p, ".signature")));
            assertTrue(got != seat1, p);
        }
        bytes32 d0 = hub.attestationDigest(
            uint64(vm.parseJsonUint(json, ".acceptedRawV[0].height")), vm.parseJsonBytes32(json, ".acceptedRawV[0].blockHash")
        );
        assertEq(rec.recover(d0, vm.parseJsonBytes(json, ".acceptedRawV[0].signature")), seat1);
    }

    function test_doubleAttestationPair() public {
        ValidatorHub hub = _hub(vm.parseJsonAddress(json, ".doubleAttestation.hub"), 3961);
        uint64 height = uint64(vm.parseJsonUint(json, ".doubleAttestation.height"));
        address a = rec.recover(
            hub.attestationDigest(height, vm.parseJsonBytes32(json, ".doubleAttestation.blockHashA")),
            vm.parseJsonBytes(json, ".doubleAttestation.signatureA")
        );
        address b = rec.recover(
            hub.attestationDigest(height, vm.parseJsonBytes32(json, ".doubleAttestation.blockHashB")),
            vm.parseJsonBytes(json, ".doubleAttestation.signatureB")
        );
        assertEq(a, vm.parseJsonAddress(json, ".doubleAttestation.signer"));
        assertEq(a, b);
    }

    function test_possessionDigests() public {
        uint256 n = _len(".attesterKey");
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".attesterKey[", vm.toString(i), "]");
            ValidatorHub hub = _hub(vm.parseJsonAddress(json, _s(p, ".hub")), vm.parseJsonUint(json, _s(p, ".chainId")));
            bytes32 d = hub.attesterKeyDigest(vm.parseJsonAddress(json, _s(p, ".owner")), vm.parseJsonAddress(json, _s(p, ".attester")));
            assertEq(d, vm.parseJsonBytes32(json, _s(p, ".digest")), p);
        }
        ValidatorHub h2 = _hub(vm.parseJsonAddress(json, ".enode[0].hub"), 3961);
        assertEq(
            h2.enodeDigest(vm.parseJsonAddress(json, ".enode[0].owner"), vm.parseJsonAddress(json, ".enode[0].attester")),
            vm.parseJsonBytes32(json, ".enode[0].digest")
        );
    }

    /// openSeat with the sidecar's proofs, then attest with the sidecar's signature format.
    function test_openSeatAndAttestEndToEnd() public {
        ValidatorHub hub = _hub(vm.parseJsonAddress(json, ".enode[0].hub"), 3961);
        address owner = vm.parseJsonAddress(json, ".enode[0].owner");
        address attester = vm.parseJsonAddress(json, ".enode[0].attester");
        assertEq(attester, vm.parseJsonAddress(json, ".attesterKey[0].attester"));
        vm.deal(owner, 2_000 ether);
        vm.prank(owner);
        uint256 seatId = hub.openSeat{value: 2_000 ether}(
            attester,
            vm.parseJsonBytes(json, ".attesterKey[0].signature"),
            vm.parseJsonBytes(json, ".enode[0].pubkey"),
            vm.parseJsonBytes(json, ".enode[0].signature")
        );
        assertEq(seatId, 1);

        // after activation (24 h), sign the next checkpoint exactly as the sidecar does
        vm.roll(block.number + 12_343 * 2);
        uint64 h = uint64(block.number - (block.number % 200));
        vm.roll(uint256(h) + 64);
        bytes32 bh = blockhash(h);
        uint256 pk = uint256(vm.parseJsonBytes32(json, ".valid[0].privateKey"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hub.attestationDigest(h, bh));
        assertTrue(v == 27 || v == 28);
        assertEq(hub.attest(h, bh, abi.encodePacked(r, s, v)), seatId);
        assertTrue(hub.attested(seatId, h));
        (,, bool active) = _key(hub, attester);
        assertTrue(active);
    }

    function _key(ValidatorHub hub, address k) internal view returns (uint64, uint8, bool) {
        ValidatorHub.KeyInfo memory ki = hub.keyInfo(k);
        return (ki.seatId, ki.role, ki.active);
    }
}
