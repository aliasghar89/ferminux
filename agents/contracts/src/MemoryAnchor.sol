// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";
import {Sig} from "./lib/Sig.sol";
import {IAccountFactoryLike, IAccountLike} from "./lib/IAccount.sol";

/// @title MemoryAnchor — append-only memory commitments for Ferminux agents (AI-CV layer)
/// @notice An agent anchors ONE merkle root per batch of memory records. The batch carries a monotonic
///         sequence number, the record count (which pins the tree shape), a timestamp, an optional URI
///         and a pointer to the previous root — so the chain of roots is itself a hash chain and a
///         dropped batch is a visible break rather than a silent edit. Anyone verifies a single record
///         with `(record, proof, root)` and no trusted party.
/// @dev Paris EVM (no PUSH0), solc 0.8.24, dependency-free, custom errors only.
///      NO plaintext, no ciphertext and no key name ever reaches this contract — only commitments.
///      This contract never holds, receives or sends FMX: there is no payable function and no value
///      path, so there is nothing to reenter and no pull-payment ledger to keep.
///      Memory is keyed by AGENT ID, not by address: `AgentRegistry.transferOwnership` therefore
///      carries the memory chain with the agent, which is the behaviour a portable record needs.
///
///      Merkle rule (binding on every producer — see SPEC.md "AI-CV layer"):
///          leaf(h)     = keccak256(abi.encodePacked(uint8(0), h))   , h = keccak256(record bytes)
///          node(l, r)  = keccak256(abi.encodePacked(uint8(1), l, r))
///          an odd node at a level is paired with ITSELF and consumes no proof element
///          the anchored `count` pins the tree shape, closing the [a,b,c] vs [a,b,c,c] ambiguity
contract MemoryAnchor {
    // ───────────────────────────── types ─────────────────────────────

    struct Anchor {
        bytes32 root; // merkle root over this batch's leaves
        bytes32 prevRoot; // root of seq-1 (bytes32(0) at seq 1)
        uint64 seq; // 1-based, strictly monotone per agent
        uint32 count; // records in this batch — pins the tree shape for `verify`
        uint64 totalRecords; // cumulative records anchored through this batch
        uint64 ts; // block timestamp of the anchoring tx
        string uri; // optional pointer to the batch's headers ("" allowed)
    }

    // ───────────────────────────── constants ─────────────────────────────

    string public constant NAME = "FerminuxMemoryAnchor";
    string public constant VERSION = "1";
    bytes1 internal constant LEAF_TAG = 0x00;
    bytes1 internal constant NODE_TAG = 0x01;
    bytes32 public constant ANCHOR_TYPEHASH = keccak256(
        "Anchor(uint256 agentId,bytes32 root,bytes32 prevRoot,uint32 count,string uri,uint256 nonce,uint64 deadline)"
    );

    // ───────────────────────────── storage ─────────────────────────────

    AgentRegistry public immutable registry;
    /// @notice AgentAccountFactory, so an agent's own policy wallet may anchor without an extra grant.
    ///         address(0) disables the lookup (the explicit `setAnchorer` grant still works).
    IAccountFactoryLike public immutable accountFactory;

    address public governance;
    uint16 public maxUriBytes = 256; // matches AgentRegistry's string limits

    mapping(uint256 => Anchor[]) private _anchors; // agentId => batches, index = seq - 1
    mapping(uint256 => mapping(address => bool)) public isAnchorer; // agentId => delegate => allowed
    mapping(uint256 => uint256) public nonces; // agentId => next signed-anchor nonce

    // ───────────────────────────── events ─────────────────────────────

    event MemoryAnchored(
        uint256 indexed agentId,
        uint64 indexed seq,
        bytes32 indexed root,
        bytes32 prevRoot,
        uint32 count,
        uint64 totalRecords,
        address anchoredBy,
        string uri
    );
    event AnchorerSet(uint256 indexed agentId, address indexed who, bool allowed);
    event MaxUriBytesChanged(uint16 maxUriBytes);
    event GovernanceChanged(address indexed previous, address indexed current);

    // ───────────────────────────── errors ─────────────────────────────

    error ZeroAddress();
    error NotGovernance();
    error NotAuthorized();
    error UnknownAgent(uint256 agentId);
    error ZeroRoot();
    error EmptyBatch();
    error StringTooLong();
    error PrevRootMismatch(bytes32 expected, bytes32 provided);
    error UnknownAnchor(uint256 agentId, uint64 seq);
    error ExpiredSignature(uint64 deadline);
    error BadSignature();
    error CountOverflow();

    // ───────────────────────────── modifiers ─────────────────────────────

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ───────────────────────────── constructor ─────────────────────────────

    /// @param registry_ the AgentRegistry that owns agent identity
    /// @param accountFactory_ AgentAccountFactory, or address(0) to disable the AgentAccount shortcut
    /// @param governance_ interim governance; the deploy script hands this to the multisig LAST
    constructor(AgentRegistry registry_, IAccountFactoryLike accountFactory_, address governance_) {
        if (address(registry_) == address(0) || governance_ == address(0)) revert ZeroAddress();
        registry = registry_;
        accountFactory = accountFactory_;
        governance = governance_;
        emit GovernanceChanged(address(0), governance_);
        emit MaxUriBytesChanged(maxUriBytes);
    }

    // ───────────────────────────── anchoring ─────────────────────────────

    /// @notice Anchor one batch. Cost is flat: a batch of 1 record and a batch of 100,000 records cost
    ///         the same, so per-record gas is zero.
    /// @param prevRoot the root this batch follows (bytes32(0) for the first). Compare-and-swap: a
    ///        stale value reverts, so two concurrent writers can never clobber each other's chain.
    /// @param count number of leaves in the batch — anchored, and required by `verify`.
    function anchor(uint256 agentId, bytes32 root, bytes32 prevRoot, uint32 count, string calldata uri)
        external
        returns (uint64 seq)
    {
        if (!_authorized(agentId, msg.sender)) revert NotAuthorized();
        return _anchor(agentId, root, prevRoot, count, uri);
    }

    /// @notice Relayed anchor: the agent owner signs, anyone pays the gas.
    /// @dev EIP-712 `Anchor(uint256 agentId,bytes32 root,bytes32 prevRoot,uint32 count,string uri,uint256 nonce,uint64 deadline)`.
    ///      `sig` is an EOA signature or anything the owner accepts through ERC-1271 (AgentAccount clones do).
    function anchorFor(
        uint256 agentId,
        bytes32 root,
        bytes32 prevRoot,
        uint32 count,
        string calldata uri,
        uint64 deadline,
        bytes calldata sig
    ) external returns (uint64 seq) {
        if (block.timestamp > deadline) revert ExpiredSignature(deadline);
        address owner = _ownerOf(agentId);
        uint256 nonce = nonces[agentId];
        bytes32 digest = hashAnchor(agentId, root, prevRoot, count, uri, nonce, deadline);
        if (!Sig.isValid(owner, digest, sig)) revert BadSignature();
        nonces[agentId] = nonce + 1;
        return _anchor(agentId, root, prevRoot, count, uri);
    }

    function _anchor(uint256 agentId, bytes32 root, bytes32 prevRoot, uint32 count, string calldata uri)
        internal
        returns (uint64 seq)
    {
        if (root == bytes32(0)) revert ZeroRoot();
        if (count == 0) revert EmptyBatch();
        if (bytes(uri).length > maxUriBytes) revert StringTooLong();

        Anchor[] storage list = _anchors[agentId];
        uint256 len = list.length;
        bytes32 expected = len == 0 ? bytes32(0) : list[len - 1].root;
        if (prevRoot != expected) revert PrevRootMismatch(expected, prevRoot);

        uint64 total = len == 0 ? 0 : list[len - 1].totalRecords;
        uint256 newTotal = uint256(total) + count;
        if (newTotal > type(uint64).max) revert CountOverflow();

        seq = uint64(len + 1);
        list.push(
            Anchor({
                root: root,
                prevRoot: prevRoot,
                seq: seq,
                count: count,
                totalRecords: uint64(newTotal),
                ts: uint64(block.timestamp),
                uri: uri
            })
        );
        emit MemoryAnchored(agentId, seq, root, prevRoot, count, uint64(newTotal), msg.sender, uri);
    }

    // ───────────────────────────── delegation ─────────────────────────────

    /// @notice Let `who` anchor for this agent (a gateway key, a sidecar, a second process). Owner only.
    /// @dev A delegate can only APPEND — it cannot rewrite or remove an anchored batch, and the
    ///      prevRoot compare-and-swap means it cannot fork the chain either.
    function setAnchorer(uint256 agentId, address who, bool allowed) external {
        if (msg.sender != _ownerOf(agentId)) revert NotAuthorized();
        if (who == address(0)) revert ZeroAddress();
        isAnchorer[agentId][who] = allowed;
        emit AnchorerSet(agentId, who, allowed);
    }

    // ───────────────────────────── governance ─────────────────────────────

    function setMaxUriBytes(uint16 newMax) external onlyGovernance {
        maxUriBytes = newMax;
        emit MaxUriBytesChanged(newMax);
    }

    function setGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceChanged(governance, newGovernance);
        governance = newGovernance;
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice The agent's latest root and how much it covers. One call, everything a reader needs.
    /// @return root latest anchored root (bytes32(0) when the agent has never anchored)
    /// @return seq number of batches anchored so far (also the latest sequence number)
    /// @return totalRecords cumulative records covered by every batch
    /// @return anchoredAt timestamp of the latest batch
    function head(uint256 agentId)
        external
        view
        returns (bytes32 root, uint64 seq, uint64 totalRecords, uint64 anchoredAt)
    {
        Anchor[] storage list = _anchors[agentId];
        uint256 len = list.length;
        if (len == 0) return (bytes32(0), 0, 0, 0);
        Anchor storage a = list[len - 1];
        return (a.root, a.seq, a.totalRecords, a.ts);
    }

    /// @notice Number of batches anchored by this agent (== the latest sequence number).
    function anchorCount(uint256 agentId) external view returns (uint64) {
        return uint64(_anchors[agentId].length);
    }

    function getAnchor(uint256 agentId, uint64 seq) public view returns (Anchor memory) {
        Anchor[] storage list = _anchors[agentId];
        if (seq == 0 || seq > list.length) revert UnknownAnchor(agentId, seq);
        return list[seq - 1];
    }

    /// @notice Page through an agent's batches (for indexers and the CV builder).
    function getAnchors(uint256 agentId, uint64 fromSeq, uint64 limit) external view returns (Anchor[] memory out) {
        Anchor[] storage list = _anchors[agentId];
        uint256 len = list.length;
        if (fromSeq == 0) fromSeq = 1;
        if (fromSeq > len || limit == 0) return new Anchor[](0);
        uint256 n = len - (fromSeq - 1);
        if (n > limit) n = limit;
        out = new Anchor[](n);
        for (uint256 i; i < n; i++) {
            out[i] = list[fromSeq - 1 + i];
        }
    }

    function nonceOf(uint256 agentId) external view returns (uint256) {
        return nonces[agentId];
    }

    /// @notice True when `who` may anchor for `agentId`: the owner, an owner-granted delegate, or an
    ///         AgentAccount whose owner is the agent owner.
    function canAnchor(uint256 agentId, address who) external view returns (bool) {
        return _authorized(agentId, who);
    }

    // ───────────────────────────── merkle ─────────────────────────────

    /// @notice The leaf a record contributes: keccak256(0x00 ‖ keccak256(record)).
    function recordLeaf(bytes calldata record) public pure returns (bytes32) {
        return leafOf(keccak256(record));
    }

    /// @notice The leaf for an already-hashed record.
    function leafOf(bytes32 recordHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(LEAF_TAG, recordHash));
    }

    /// @notice Root over `leaves` in order — the reference implementation every producer must match.
    function computeRoot(bytes32[] calldata leaves) external pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) revert EmptyBatch();
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            level[i] = leaves[i];
        }
        while (n > 1) {
            uint256 w;
            for (uint256 i; i < n; i += 2) {
                bytes32 l = level[i];
                bytes32 r = i + 1 < n ? level[i + 1] : l; // odd node pairs with itself
                level[w++] = _node(l, r);
            }
            n = w;
        }
        return level[0];
    }

    /// @notice Verify a memory record against a root, trusting nobody. Pure — usable off-chain-style
    ///         with one `eth_call`, or mirrored in any language from the rule in the contract header.
    /// @param root the anchored root
    /// @param record the record bytes exactly as hashed into the tree
    /// @param proof sibling hashes, leaf level first
    /// @param index the record's position in the batch (0-based)
    /// @param count the batch's record count, as anchored — it pins the tree shape
    function verify(bytes32 root, bytes calldata record, bytes32[] calldata proof, uint256 index, uint256 count)
        external
        pure
        returns (bool)
    {
        return verifyLeaf(root, leafOf(keccak256(record)), proof, index, count);
    }

    /// @notice Same, for a caller that already computed the leaf.
    function verifyLeaf(bytes32 root, bytes32 leaf, bytes32[] calldata proof, uint256 index, uint256 count)
        public
        pure
        returns (bool)
    {
        if (root == bytes32(0) || count == 0 || index >= count) return false;
        bytes32 computed = leaf;
        uint256 idx = index;
        uint256 levelSize = count;
        uint256 p;
        while (levelSize > 1) {
            if (idx == levelSize - 1 && levelSize % 2 == 1) {
                // last node of an odd level: paired with itself, consumes no proof element
                computed = _node(computed, computed);
            } else {
                if (p == proof.length) return false;
                bytes32 sibling = proof[p];
                unchecked {
                    p++;
                }
                computed = idx % 2 == 0 ? _node(computed, sibling) : _node(sibling, computed);
            }
            idx /= 2;
            levelSize = (levelSize + 1) / 2;
        }
        // a proof with leftover elements is a forgery attempt, not a valid proof
        return p == proof.length && computed == root;
    }

    /// @notice Verify a record against an anchored batch — `count` and `root` come from chain state,
    ///         so the caller cannot lie about the tree's shape.
    function verifyRecord(uint256 agentId, uint64 seq, bytes calldata record, bytes32[] calldata proof, uint256 index)
        external
        view
        returns (bool)
    {
        Anchor memory a = getAnchor(agentId, seq);
        return verifyLeaf(a.root, leafOf(keccak256(record)), proof, index, a.count);
    }

    /// @notice Same against the agent's CURRENT head. False when the agent has never anchored.
    function verifyAgainstHead(uint256 agentId, bytes calldata record, bytes32[] calldata proof, uint256 index)
        external
        view
        returns (bool)
    {
        Anchor[] storage list = _anchors[agentId];
        uint256 len = list.length;
        if (len == 0) return false;
        Anchor storage a = list[len - 1];
        return verifyLeaf(a.root, leafOf(keccak256(record)), proof, index, a.count);
    }

    // ───────────────────────────── EIP-712 ─────────────────────────────

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return Sig.domainSeparator(NAME, VERSION, address(this));
    }

    function hashAnchor(
        uint256 agentId,
        bytes32 root,
        bytes32 prevRoot,
        uint32 count,
        string calldata uri,
        uint256 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        return Sig.typedDataHash(
            DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(ANCHOR_TYPEHASH, agentId, root, prevRoot, count, keccak256(bytes(uri)), nonce, deadline)
            )
        );
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _node(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(NODE_TAG, l, r));
    }

    function _ownerOf(uint256 agentId) internal view returns (address o) {
        o = registry.getAgent(agentId).owner;
        if (o == address(0)) revert UnknownAgent(agentId);
    }

    function _authorized(uint256 agentId, address who) internal view returns (bool) {
        address o = registry.getAgent(agentId).owner;
        if (o == address(0)) revert UnknownAgent(agentId);
        if (who == o) return true;
        if (isAnchorer[agentId][who]) return true;
        if (address(accountFactory) != address(0) && who.code.length != 0) {
            if (accountFactory.isAccount(who) && IAccountLike(who).owner() == o) return true;
        }
        return false;
    }
}
