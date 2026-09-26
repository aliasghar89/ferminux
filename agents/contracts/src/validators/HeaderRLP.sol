// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HeaderRLP: the two header fields Step 2 double-sign evidence needs
/// @notice Reads item 0 (parentHash) and item 8 (number) of an RLP-encoded block header (the
///         preimage the signer's header signature covers: the header with the 65-byte signature
///         removed from extraData). Nothing else in the
///         header is interpreted. Strict: the outer list must span the whole input, items 0-8 must
///         be byte strings inside it, parentHash must be exactly 32 bytes and number at most 32.
/// @dev Internal library (inlined, no delegatecall). Paris EVM.
library HeaderRLP {
    error BadHeader();

    function parentAndNumber(bytes calldata rlp) internal pure returns (bytes32 parent, uint256 number) {
        uint256 len = rlp.length;
        if (len == 0) revert BadHeader();
        uint256 b0 = uint8(rlp[0]);
        if (b0 < 0xc0) revert BadHeader();
        uint256 off;
        uint256 payload;
        if (b0 <= 0xf7) {
            payload = b0 - 0xc0;
            off = 1;
        } else {
            uint256 ll = b0 - 0xf7;
            if (1 + ll > len) revert BadHeader();
            payload = _be(rlp, 1, ll);
            off = 1 + ll;
        }
        if (off + payload != len) revert BadHeader();
        for (uint256 i; i <= 8; ++i) {
            (uint256 dataOff, uint256 dataLen, uint256 next) = _item(rlp, off, len);
            if (i == 0) {
                if (dataLen != 32) revert BadHeader();
                parent = bytes32(rlp[dataOff:dataOff + 32]);
            } else if (i == 8) {
                number = _be(rlp, dataOff, dataLen);
            }
            off = next;
        }
    }

    /// One RLP byte string at `off`. Lists are rejected: header items 0-8 are all strings.
    function _item(bytes calldata rlp, uint256 off, uint256 end)
        private
        pure
        returns (uint256 dataOff, uint256 dataLen, uint256 next)
    {
        if (off >= end) revert BadHeader();
        uint256 b = uint8(rlp[off]);
        if (b < 0x80) {
            (dataOff, dataLen) = (off, 1);
        } else if (b <= 0xb7) {
            (dataOff, dataLen) = (off + 1, b - 0x80);
        } else if (b <= 0xbf) {
            uint256 ll = b - 0xb7;
            if (off + 1 + ll > end) revert BadHeader();
            dataLen = _be(rlp, off + 1, ll);
            dataOff = off + 1 + ll;
        } else {
            revert BadHeader();
        }
        next = dataOff + dataLen;
        if (next > end) revert BadHeader();
    }

    /// Big-endian unsigned integer of `n` <= 32 bytes at `off`.
    function _be(bytes calldata b, uint256 off, uint256 n) private pure returns (uint256 v) {
        if (n > 32) revert BadHeader();
        for (uint256 i; i < n; ++i) {
            v = (v << 8) | uint8(b[off + i]);
        }
    }
}

/// @title SealEvidence: stateless check of Step 2 double-sign header evidence
/// @notice Deployed by ValidatorHub in its own constructor (so the hub trusts no outside code) to
///         keep the RLP parser out of the hub's 24 KB runtime. Pure: holds nothing, stores nothing.
contract SealEvidence {
    error NotADoubleSeal();

    /// @return number header number shared by both preimages
    /// @return sealA  keccak256(preimageA), the digest the header signature covers
    /// @return sealB  keccak256(preimageB)
    function check(bytes calldata preimageA, bytes calldata preimageB)
        external
        pure
        returns (uint256 number, bytes32 sealA, bytes32 sealB)
    {
        (bytes32 parentA, uint256 numberA) = HeaderRLP.parentAndNumber(preimageA);
        (bytes32 parentB, uint256 numberB) = HeaderRLP.parentAndNumber(preimageB);
        sealA = keccak256(preimageA);
        sealB = keccak256(preimageB);
        if (numberA != numberB || parentA != parentB || sealA == sealB || numberA > type(uint64).max) {
            revert NotADoubleSeal();
        }
        number = numberA;
    }
}
