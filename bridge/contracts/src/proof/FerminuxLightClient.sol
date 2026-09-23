// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RLPReader} from "./vendor/RLPReader.sol";

/**
 * @title  FerminuxLightClient
 * @notice Verifies Ferminux blocks on another chain from their signatures alone.
 *
 *         Ferminux confirms a block every 7 s by one signer of a small authority
 *         set. The set is written in full into every checkpoint header (block
 *         numbers divisible by EPOCH), and a signer may seal at most one block in
 *         any run of floor(N/2)+1. This contract turns that into a proof rule:
 *
 *         FINAL — a header is final when it and the headers built on it carry
 *         seals from a MAJORITY of the distinct signers of its epoch. Forging a
 *         final header therefore takes a majority of the signer keys: the same
 *         assumption the chain itself rests on, and no other.
 *
 *         SIGNER SETS — the contract starts from ONE trusted checkpoint (the
 *         bootstrap, whose hash is published for anyone to compare with the
 *         explorer). Every later set is adopted only from the NEXT checkpoint,
 *         in sequence, when a majority of the CURRENT set has sealed it final.
 *         There is no setter: governance can freeze the client, never tell it
 *         who the signers are.
 *
 *         CONFLICT — two conflicting headers that are BOTH final at the same
 *         height prove a majority of signers broke the chain's safety. Anyone
 *         can submit them; the client then freezes itself. Ordinary short
 *         reorgs never produce two final branches, so they cannot trip it.
 *
 *         Scope: London-format Clique headers (16 fields), which is every block
 *         Ferminux has sealed since PosaBlock 160,000. Blocks before the first
 *         post-fork checkpoint (180,000) cannot be proven and never need to be.
 *
 *         Mid-epoch signer votes are deliberately ignored: a signer voted in
 *         mid-epoch is not counted until the next checkpoint lists it (costs
 *         liveness, never safety), and a signer voted out mid-epoch still counts
 *         until then — but alone it can never reach a majority.
 */
contract FerminuxLightClient {
    using RLPReader for RLPReader.RLPItem;

    /// @notice What a successful proof yields about the target block.
    struct Verified {
        bytes32 hash;
        uint64 number;
        uint64 time;
        bytes32 stateRoot;
        bytes32 receiptsRoot;
    }

    struct Header {
        bytes32 hash;
        bytes32 parentHash;
        bytes32 stateRoot;
        bytes32 receiptsRoot;
        uint64 number;
        uint64 time;
        address signer;
        address[] checkpointSigners; // only populated for checkpoint headers
    }

    uint256 public constant MAX_HEADERS = 64;
    uint256 public constant MAX_SIGNERS = 21;
    uint256 private constant VANITY = 32;
    uint256 private constant SEAL = 65;
    uint256 private constant HEADER_FIELDS = 16; // London: 15 legacy fields + baseFee
    bytes32 private constant EMPTY_UNCLE_HASH = 0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347;
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint64 public immutable EPOCH;
    uint64 public immutable PERIOD;
    uint64 public immutable BOOTSTRAP_NUMBER;
    bytes32 public immutable BOOTSTRAP_HASH;

    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public frozen;

    /// @notice Highest checkpoint whose signer set is known. Checkpoints are
    ///         adopted strictly in order, one EPOCH at a time.
    uint64 public latestCheckpoint;

    mapping(uint64 => address[]) private _signers;
    mapping(uint64 => mapping(address => bool)) private _isSigner;
    mapping(bytes32 => Verified) private _finalized;

    event CheckpointAdopted(uint64 indexed number, bytes32 indexed hash, address[] signers);
    event HeaderFinalized(uint64 indexed number, bytes32 indexed hash);
    event ConflictProven(uint64 indexed number, bytes32 hashA, bytes32 hashB);
    event Frozen(address indexed by);
    event Unfrozen(address indexed by);
    event GuardianChanged(address indexed guardian);
    event OwnershipTransferStarted(address indexed newOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "LC: not owner");
        _;
    }

    modifier live() {
        require(!frozen, "LC: frozen");
        _;
    }

    /// @param bootstrapHeader RLP of a post-fork checkpoint header. Its hash is
    ///        the trust anchor: compare BOOTSTRAP_HASH with the explorer.
    constructor(bytes memory bootstrapHeader, uint64 epoch, uint64 period, address owner_, address guardian_) {
        require(epoch > 0 && period > 0, "LC: bad params");
        require(owner_ != address(0), "LC: zero owner");
        EPOCH = epoch;
        PERIOD = period;
        Header memory h = _parse(bootstrapHeader, epoch);
        require(h.number % epoch == 0 && h.checkpointSigners.length > 0, "LC: bootstrap is not a checkpoint");
        BOOTSTRAP_NUMBER = h.number;
        BOOTSTRAP_HASH = h.hash;
        owner = owner_;
        guardian = guardian_;
        _adopt(h);
    }

    // --------------------------------------------------------------- views

    function signersAt(uint64 checkpoint) external view returns (address[] memory) {
        return _signers[checkpoint];
    }

    function isSigner(uint64 checkpoint, address account) external view returns (bool) {
        return _isSigner[checkpoint][account];
    }

    /// @notice Signers needed for finality in the epoch starting at `checkpoint`.
    function quorum(uint64 checkpoint) public view returns (uint256) {
        uint256 n = _signers[checkpoint].length;
        return n == 0 ? type(uint256).max : n / 2 + 1;
    }

    function finalized(bytes32 blockHash) external view returns (Verified memory) {
        return _finalized[blockHash];
    }

    /**
     * @notice Stateless proof: headers[0] is the target, headers[1..] the blocks
     *         built on it, consecutive. Reverts unless the run is linked, well
     *         formed and sealed by a majority of the target epoch's signers.
     */
    function verifyFinal(bytes[] memory headers) public view live returns (Verified memory v) {
        Header memory target = _verifyRun(headers, _epochOf(headers.length == 0 ? 0 : _peekNumber(headers[0])));
        v = Verified(target.hash, target.number, target.time, target.stateRoot, target.receiptsRoot);
    }

    // ----------------------------------------------------------- mutations

    /// @notice verifyFinal, then remember the result so later proofs about the
    ///         same block can cite it by hash. Permissionless.
    function finalize(bytes[] calldata headers) external live returns (Verified memory v) {
        v = verifyFinal(headers);
        if (_finalized[v.hash].hash == bytes32(0)) {
            _finalized[v.hash] = v;
            emit HeaderFinalized(v.number, v.hash);
        }
    }

    /**
     * @notice Adopt the next checkpoint's signer set. headers[0] must be the
     *         checkpoint exactly one EPOCH after latestCheckpoint; the run must
     *         carry seals from a majority of the CURRENT set. Permissionless:
     *         anyone keeping the client current is doing everyone a favour.
     */
    function advance(bytes[] calldata headers) external live {
        require(headers.length > 0, "LC: no headers");
        uint64 current = latestCheckpoint;
        Header memory cp = _verifyRun(headers, current);
        require(cp.number == current + EPOCH, "LC: checkpoints must be sequential");
        require(cp.checkpointSigners.length > 0, "LC: not a checkpoint");
        _adopt(cp);
    }

    /**
     * @notice Freeze on proof of a safety failure: two different headers at the
     *         same height, each final on its own branch. Permissionless.
     */
    function proveConflict(bytes[] calldata branchA, bytes[] calldata branchB) external live {
        require(branchA.length > 0 && branchB.length > 0, "LC: empty branch");
        uint64 epochA = _epochOf(_peekNumber(branchA[0]));
        Header memory a = _verifyRun(branchA, epochA);
        Header memory b = _verifyRun(branchB, _epochOf(_peekNumber(branchB[0])));
        require(a.number == b.number, "LC: different heights");
        require(a.hash != b.hash, "LC: same block");
        frozen = true;
        emit ConflictProven(a.number, a.hash, b.hash);
        emit Frozen(msg.sender);
    }

    /// @notice Emergency stop by the guardian (or owner). Only the owner unfreezes.
    function freeze() external {
        require(msg.sender == guardian || msg.sender == owner, "LC: not guardian");
        frozen = true;
        emit Frozen(msg.sender);
    }

    function unfreeze() external onlyOwner {
        frozen = false;
        emit Unfrozen(msg.sender);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "LC: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------ internals

    function _epochOf(uint64 number) private view returns (uint64) {
        return number - (number % EPOCH);
    }

    function _adopt(Header memory cp) private {
        address[] memory s = cp.checkpointSigners;
        for (uint256 i = 0; i < s.length; i++) {
            _isSigner[cp.number][s[i]] = true;
        }
        _signers[cp.number] = s;
        latestCheckpoint = cp.number;
        emit CheckpointAdopted(cp.number, cp.hash, s);
    }

    /// @dev Checks a consecutive run and counts distinct seals from the signer
    ///      set of checkpoint `setAt`. headers[0] must itself be sealed by a
    ///      member; later headers sealed by non-members are allowed (a signer
    ///      voted in mid-epoch) but never counted.
    function _verifyRun(bytes[] memory headers, uint64 setAt) private view returns (Header memory target) {
        uint256 n = headers.length;
        require(n > 0 && n <= MAX_HEADERS, "LC: bad header count");
        uint256 size = _signers[setAt].length;
        require(size > 0, "LC: unknown signer set");
        mapping(address => bool) storage member = _isSigner[setAt];

        target = _parse(headers[0], EPOCH);
        require(member[target.signer], "LC: target not sealed by the set");

        address[] memory seen = new address[](size);
        seen[0] = target.signer;
        uint256 distinct = 1;

        Header memory prev = target;
        for (uint256 i = 1; i < n; i++) {
            Header memory h = _parse(headers[i], EPOCH);
            require(h.parentHash == prev.hash, "LC: broken parent link");
            require(h.number == prev.number + 1, "LC: non-consecutive");
            require(h.time >= prev.time + PERIOD, "LC: timestamp too early");
            if (member[h.signer] && !_contains(seen, distinct, h.signer)) {
                seen[distinct] = h.signer;
                distinct++;
            }
            prev = h;
        }
        require(distinct >= size / 2 + 1, "LC: not final");
    }

    function _contains(address[] memory list, uint256 len, address a) private pure returns (bool) {
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == a) return true;
        }
        return false;
    }

    function _peekNumber(bytes memory raw) private pure returns (uint64) {
        RLPReader.RLPItem[] memory f = RLPReader.readList(raw);
        require(f.length == HEADER_FIELDS, "LC: not a London header");
        return _u64(f[8]);
    }

    /// @dev Decodes and checks one header, and recovers its sealer.
    function _parse(bytes memory raw, uint64 epoch) private pure returns (Header memory h) {
        RLPReader.RLPItem[] memory f = RLPReader.readList(raw);
        require(f.length == HEADER_FIELDS, "LC: not a London header");

        h.hash = keccak256(raw);
        h.parentHash = _b32(f[0]);
        require(_b32(f[1]) == EMPTY_UNCLE_HASH, "LC: uncles");
        h.stateRoot = _b32(f[3]);
        h.receiptsRoot = _b32(f[5]);
        uint256 difficulty = _uint(f[7]);
        require(difficulty == 1 || difficulty == 2, "LC: bad difficulty");
        h.number = _u64(f[8]);
        h.time = _u64(f[11]);
        require(_b32(f[13]) == bytes32(0), "LC: bad mix digest");
        bytes memory nonce = f[14].readBytes();
        require(nonce.length == 8, "LC: bad nonce");

        bytes memory extra = f[12].readBytes();
        require(extra.length >= VANITY + SEAL, "LC: extra too short");
        uint256 signersLen = extra.length - VANITY - SEAL;
        if (h.number % epoch == 0) {
            require(signersLen > 0 && signersLen % 20 == 0, "LC: bad checkpoint signer list");
            require(signersLen / 20 <= MAX_SIGNERS, "LC: too many signers");
            bytes memory coinbase = f[2].readBytes();
            require(coinbase.length == 20 && bytes20(_word(coinbase, 0)) == bytes20(0), "LC: checkpoint coinbase");
            h.checkpointSigners = _signerList(extra, signersLen / 20);
        } else {
            require(signersLen == 0, "LC: signers outside checkpoint");
        }

        h.signer = _recoverSealer(f, extra);
    }

    /// @dev Signers are listed in strictly ascending order in the checkpoint
    ///      extra-data; enforcing that also rules out duplicates.
    function _signerList(bytes memory extra, uint256 count) private pure returns (address[] memory s) {
        s = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            s[i] = address(bytes20(_word(extra, VANITY + i * 20)));
            require(s[i] != address(0), "LC: zero signer");
            if (i > 0) require(uint160(s[i]) > uint160(s[i - 1]), "LC: signers not sorted");
        }
    }

    /// @dev Clique seal hash: the RLP of the header with the 65-byte seal cut
    ///      from extra-data, every other field byte-identical.
    function _recoverSealer(RLPReader.RLPItem[] memory f, bytes memory extra) private pure returns (address) {
        bytes memory payload;
        for (uint256 i = 0; i < HEADER_FIELDS; i++) {
            if (i == 12) {
                payload = bytes.concat(payload, _encodeBytes(extra, extra.length - SEAL));
            } else {
                payload = bytes.concat(payload, f[i].readRawBytes());
            }
        }
        bytes32 sealHash = keccak256(bytes.concat(_listPrefix(payload.length), payload));

        uint256 off = extra.length - SEAL;
        bytes32 r = _word(extra, off);
        bytes32 s = _word(extra, off + 32);
        uint8 v = uint8(extra[off + 64]);
        require(v < 2, "LC: bad seal v");
        require(uint256(s) <= HALF_CURVE_ORDER, "LC: malleable seal");
        address signer = ecrecover(sealHash, v + 27, r, s);
        require(signer != address(0), "LC: bad seal");
        return signer;
    }

    function _encodeBytes(bytes memory b, uint256 len) private pure returns (bytes memory out) {
        bytes memory body = new bytes(len);
        for (uint256 i = 0; i < len; i++) body[i] = b[i];
        if (len == 1 && uint8(body[0]) < 0x80) return body;
        return bytes.concat(_lengthPrefix(0x80, len), body);
    }

    function _listPrefix(uint256 len) private pure returns (bytes memory) {
        return _lengthPrefix(0xc0, len);
    }

    function _lengthPrefix(uint8 base, uint256 len) private pure returns (bytes memory) {
        if (len < 56) return abi.encodePacked(uint8(base + len));
        uint256 lenLen;
        for (uint256 x = len; x != 0; x >>= 8) lenLen++;
        bytes memory out = new bytes(1 + lenLen);
        out[0] = bytes1(uint8(base + 55 + lenLen));
        for (uint256 i = 0; i < lenLen; i++) {
            out[1 + i] = bytes1(uint8(len >> (8 * (lenLen - 1 - i))));
        }
        return out;
    }

    function _word(bytes memory b, uint256 off) private pure returns (bytes32 w) {
        require(b.length >= off + 20, "LC: short read");
        // Callers read 20- or 32-byte values; bytes past the end of `b` only ever
        // land in the low bytes a bytes20 read discards.
        assembly {
            w := mload(add(add(b, 32), off))
        }
    }

    function _b32(RLPReader.RLPItem memory item) private pure returns (bytes32) {
        bytes memory b = item.readBytes();
        require(b.length == 32, "LC: bad hash field");
        return _word(b, 0);
    }

    function _uint(RLPReader.RLPItem memory item) private pure returns (uint256 x) {
        bytes memory b = item.readBytes();
        require(b.length <= 32, "LC: int too long");
        require(b.length == 0 || b[0] != 0, "LC: non-canonical int");
        for (uint256 i = 0; i < b.length; i++) x = (x << 8) | uint8(b[i]);
    }

    function _u64(RLPReader.RLPItem memory item) private pure returns (uint64) {
        uint256 x = _uint(item);
        require(x <= type(uint64).max, "LC: int overflow");
        return uint64(x);
    }
}
