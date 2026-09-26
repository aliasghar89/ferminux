// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidatorTestBase} from "./ValidatorTestBase.sol";
import {SinkRouter} from "../../src/validators/SinkRouter.sol";

/// @notice Chain 3961 runs a pre-Shanghai EVM: PUSH0 (0x5f) is an invalid opcode there. Walk
///         the deployed runtime code of every validator contract opcode by opcode (skipping PUSH
///         data and the trailing CBOR metadata) and fail on any PUSH0. Also pin the EIP-170 size.
contract ValidatorBytecodeTest is ValidatorTestBase {
    uint256 internal constant EIP170 = 24_576;

    function _push0At(bytes memory code) internal pure returns (bool found, uint256 at) {
        uint256 n = code.length;
        uint256 meta = (uint256(uint8(code[n - 2])) << 8) | uint8(code[n - 1]);
        uint256 end = n - 2 - meta;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op == 0x5f) return (true, i);
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
    }

    function _check(address a, string memory name) internal view {
        bytes memory code = a.code;
        assertGt(code.length, 0, name);
        assertLe(code.length, EIP170, string.concat(name, " exceeds 24 KB"));
        (bool found, uint256 at) = _push0At(code);
        assertFalse(found, string.concat(name, " contains PUSH0 at byte ", vm.toString(at)));
    }

    function test_NoPush0_AndUnder24KB() public {
        SinkRouter router = new SinkRouter(msig, address(sink), address(hub), msig);
        _check(address(hub), "ValidatorHub");
        _check(address(hub.sealEvidence()), "SealEvidence");
        _check(address(lens), "ValidatorHubLens");
        _check(address(router), "SinkRouter");
    }

    function test_Walker_FindsPush0AndSkipsPushData() public pure {
        // PUSH1 0x5f ; PUSH0 ; metadata length 0
        (bool found, uint256 at) = _push0At(hex"605f5f0000");
        assertTrue(found);
        assertEq(at, 2);
        // PUSH2 0x5f5f ; STOP ; metadata length 0
        (found,) = _push0At(hex"615f5f000000");
        assertFalse(found);
    }
}
