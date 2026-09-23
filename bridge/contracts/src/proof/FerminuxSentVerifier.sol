// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RLPReader} from "./vendor/RLPReader.sol";
import {MerkleTrie} from "./vendor/MerkleTrie.sol";
import {FerminuxBridge} from "../FerminuxBridge.sol";
import {FerminuxLightClient} from "./FerminuxLightClient.sol";

/**
 * @title  FerminuxSentVerifier
 * @notice Proves that the Ferminux bridge really emitted a given `Sent` — in a
 *         block the light client accepts as final, in a transaction that
 *         succeeded — and that every field of the claimed transfer matches it.
 *         This is what replaces validator signatures on the destination chain:
 *         the transfer is taken from Ferminux's own receipts, not from anyone's
 *         say-so.
 *
 *         Proof = abi.encode(bytes[] headers, bytes[] receiptProof, uint256 txIndex, uint256 logIndex)
 *           headers      target block first, then the blocks built on it (see
 *                        FerminuxLightClient.verifyFinal)
 *           receiptProof Merkle-Patricia nodes from receiptsRoot to the receipt
 *                        at key rlp(txIndex)
 *           logIndex     position of the Sent log WITHIN that receipt
 */
contract FerminuxSentVerifier {
    using RLPReader for RLPReader.RLPItem;

    bytes32 public constant SENT_TOPIC =
        keccak256("Sent(bytes32,uint64,address,uint64,uint64,address,address,address,uint256,uint256)");

    FerminuxLightClient public immutable LIGHT_CLIENT;
    /// @notice The FerminuxBridge deployment on Ferminux whose logs count.
    address public immutable SOURCE_BRIDGE;
    uint64 public immutable SOURCE_CHAIN_ID;

    struct Proof {
        bytes[] headers;
        bytes[] receiptProof;
        uint256 txIndex;
        uint256 logIndex;
    }

    constructor(FerminuxLightClient lightClient, address sourceBridge, uint64 sourceChainId) {
        require(address(lightClient).code.length > 0, "SV: light client has no code");
        require(sourceBridge != address(0) && sourceChainId != 0, "SV: bad source");
        LIGHT_CLIENT = lightClient;
        SOURCE_BRIDGE = sourceBridge;
        SOURCE_CHAIN_ID = sourceChainId;
    }

    /// @notice Reverts unless `proof` shows the source bridge emitted exactly
    ///         `t`. Returns its transferId and the proven block.
    function verifySent(FerminuxBridge.BridgeTransfer calldata t, bytes calldata proof)
        external
        view
        returns (bytes32 transferId, bytes32 blockHash, uint64 blockNumber)
    {
        Proof memory p;
        (p.headers, p.receiptProof, p.txIndex, p.logIndex) = abi.decode(proof, (bytes[], bytes[], uint256, uint256));
        FerminuxLightClient.Verified memory v = LIGHT_CLIENT.verifyFinal(p.headers);

        bytes memory receipt = MerkleTrie.get(_rlpIndex(p.txIndex), p.receiptProof, v.receiptsRoot);
        RLPReader.RLPItem[] memory log = _successfulLog(receipt, p.logIndex);

        require(_address(log[0]) == SOURCE_BRIDGE, "SV: not the source bridge");
        RLPReader.RLPItem[] memory topics = log[1].readList();
        require(topics.length == 4, "SV: not a Sent log");
        require(_b32(topics[0]) == SENT_TOPIC, "SV: not a Sent log");
        transferId = _b32(topics[1]);

        // Indexed: transferId, dstChainId, localToken. Data: the rest.
        uint256 dst = uint256(_b32(topics[2]));
        address srcToken = address(uint160(uint256(_b32(topics[3]))));
        (uint64 srcChainId, uint64 nonce, address dstToken, address sender, address recipient, uint256 amount,) =
            abi.decode(log[2].readBytes(), (uint64, uint64, address, address, address, uint256, uint256));

        require(srcChainId == SOURCE_CHAIN_ID && t.srcChainId == srcChainId, "SV: src chain mismatch");
        require(dst <= type(uint64).max && t.dstChainId == uint64(dst), "SV: dst chain mismatch");
        require(t.nonce == nonce, "SV: nonce mismatch");
        require(t.srcToken == srcToken && t.dstToken == dstToken, "SV: token mismatch");
        require(t.sender == sender && t.recipient == recipient, "SV: party mismatch");
        require(t.amount == amount, "SV: amount mismatch");
        require(
            keccak256(
                abi.encode(t.srcChainId, t.dstChainId, t.nonce, t.srcToken, t.dstToken, t.sender, t.recipient, t.amount)
            ) == transferId,
            "SV: transferId mismatch"
        );

        blockHash = v.hash;
        blockNumber = v.number;
    }

    /// @dev Receipt = [status, cumulativeGas, bloom, logs], optionally behind an
    ///      EIP-2718 type byte. A reverted transaction's logs never happened.
    function _successfulLog(bytes memory receipt, uint256 logIndex)
        private
        pure
        returns (RLPReader.RLPItem[] memory log)
    {
        require(receipt.length > 0, "SV: empty receipt");
        uint8 first = uint8(receipt[0]);
        if (first < 0x80) {
            require(first == 1 || first == 2, "SV: unsupported receipt type");
            bytes memory body = new bytes(receipt.length - 1);
            for (uint256 i = 0; i < body.length; i++) body[i] = receipt[i + 1];
            receipt = body;
        }
        RLPReader.RLPItem[] memory r = RLPReader.readList(receipt);
        require(r.length == 4, "SV: bad receipt");
        bytes memory status = r[0].readBytes();
        require(status.length == 1 && status[0] == 0x01, "SV: transaction failed");
        RLPReader.RLPItem[] memory logs = r[3].readList();
        require(logIndex < logs.length, "SV: no such log");
        log = logs[logIndex].readList();
        require(log.length == 3, "SV: bad log");
    }

    /// @dev Receipt-trie key: the RLP encoding of the transaction index.
    function _rlpIndex(uint256 i) private pure returns (bytes memory) {
        if (i == 0) return hex"80";
        if (i < 0x80) return abi.encodePacked(uint8(i));
        uint256 len;
        for (uint256 x = i; x != 0; x >>= 8) len++;
        bytes memory out = new bytes(1 + len);
        out[0] = bytes1(uint8(0x80 + len));
        for (uint256 k = 0; k < len; k++) out[1 + k] = bytes1(uint8(i >> (8 * (len - 1 - k))));
        return out;
    }

    function _address(RLPReader.RLPItem memory item) private pure returns (address a) {
        bytes memory b = item.readBytes();
        require(b.length == 20, "SV: bad address");
        assembly {
            a := shr(96, mload(add(b, 32)))
        }
    }

    function _b32(RLPReader.RLPItem memory item) private pure returns (bytes32 w) {
        bytes memory b = item.readBytes();
        require(b.length == 32, "SV: bad word");
        assembly {
            w := mload(add(b, 32))
        }
    }
}
