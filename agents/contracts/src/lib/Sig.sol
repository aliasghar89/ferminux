// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Sig — minimal signature + EIP-712 helpers (dependency-free, Paris EVM)
/// @dev Internal library: every function is inlined, no delegatecall. `isValid` accepts an EOA
///      signature (ecrecover, low-s only) OR an ERC-1271 answer from a contract signer.
library Sig {
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @return signer recovered address, or address(0) when the signature is malformed.
    function recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    /// @notice True when `sig` over `digest` was produced by `signer` (EOA) or `signer` is a contract
    ///         that returns the ERC-1271 magic value for it.
    function isValid(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer == address(0)) return false;
        address rec = recover(digest, sig);
        if (rec != address(0) && rec == signer) return true;
        if (signer.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, sig));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC;
    }

    function domainSeparator(string memory name, string memory version, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, verifyingContract)
        );
    }

    function typedDataHash(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
