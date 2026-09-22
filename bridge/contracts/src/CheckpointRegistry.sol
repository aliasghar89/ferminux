// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CheckpointRegistry
 * @notice Signed weak-subjectivity checkpoints for the Ferminux chain, stored on
 *         a chain with real finality (BSC) and published by that chain's owner
 *         multisig.
 *
 *         Each checkpoint is (ferminuxBlockNumber, blockHash, attestedAt). A
 *         bridge validator refuses to sign a Ferminux->BSC transfer whose source
 *         block is ABOVE the latest checkpoint, refuses if the hash it sees on
 *         Ferminux at that height differs from the attested one (a detected
 *         reorg), and refuses if the checkpoint is older than its configured max
 *         age. All of that policy lives in the relayer; this contract is only
 *         the attested record.
 *
 *         Deliberately minimal: no pause, no timelock, no batch publish. The
 *         only privileged action is appending a strictly-higher checkpoint, and
 *         the only way to "undo" one is to publish a higher one — a checkpoint
 *         can never be moved backwards or overwritten.
 *
 *         Ownership is two-step (propose / accept) like the bridge, so a typo'd
 *         owner cannot brick publishing. There is no timelock on the handover:
 *         the owner is a multisig and the worst a hostile owner can do is stop
 *         publishing, which fails the bridge CLOSED via the max-age rule.
 *
 *         Bytecode targets Paris (no PUSH0) — see foundry.toml.
 */
contract CheckpointRegistry {
    struct Attestation {
        bytes32 blockHash;
        uint64 attestedAt;
    }

    address public owner;
    address public pendingOwner;

    /// @notice Ferminux block number of the most recent checkpoint. 0 means none
    ///         has ever been published (block 0 itself cannot be checkpointed —
    ///         publish() requires a strictly higher number than this).
    uint64 public latestNumber;

    /// @notice Every checkpoint ever published, keyed by Ferminux block number.
    mapping(uint64 => Attestation) private _checkpoints;

    event Checkpoint(uint64 indexed ferminuxBlock, bytes32 blockHash, uint64 attestedAt);
    event OwnershipTransferStarted(address indexed newOwner);
    event OwnershipTransferCanceled(address indexed canceledOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "CKPT: not owner");
        _;
    }

    constructor(address _owner) {
        require(_owner != address(0), "CKPT: zero owner");
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ------------------------------------------------------------ publishing

    /// @notice Attest that Ferminux block `ferminuxBlock` has hash `blockHash`.
    ///         Must be strictly higher than the latest checkpoint; the hash must
    ///         be non-zero (an all-zero hash is what a failed RPC read looks like
    ///         after `cast` output goes through a careless script).
    function publish(uint64 ferminuxBlock, bytes32 blockHash) external onlyOwner {
        require(ferminuxBlock > latestNumber, "CKPT: not increasing");
        require(blockHash != bytes32(0), "CKPT: zero hash");
        uint64 now_ = uint64(block.timestamp);
        _checkpoints[ferminuxBlock] = Attestation({blockHash: blockHash, attestedAt: now_});
        latestNumber = ferminuxBlock;
        emit Checkpoint(ferminuxBlock, blockHash, now_);
    }

    // ----------------------------------------------------------------- views

    /// @notice The most recent checkpoint. Returns (0, 0x0, 0) if none exists —
    ///         callers MUST treat number == 0 as "no checkpoint" and refuse.
    function latest() external view returns (uint64 number, bytes32 blockHash, uint64 attestedAt) {
        number = latestNumber;
        Attestation storage c = _checkpoints[number];
        return (number, c.blockHash, c.attestedAt);
    }

    /// @notice The checkpoint published for exactly `number`, or (0x0, 0) if
    ///         that height was never checkpointed.
    function checkpointAt(uint64 number) external view returns (bytes32 blockHash, uint64 attestedAt) {
        Attestation storage c = _checkpoints[number];
        return (c.blockHash, c.attestedAt);
    }

    // ------------------------------------------------------------- ownership

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "CKPT: zero owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(newOwner);
    }

    function cancelOwnershipTransfer() external onlyOwner {
        address canceled = pendingOwner;
        require(canceled != address(0), "CKPT: no pending owner");
        pendingOwner = address(0);
        emit OwnershipTransferCanceled(canceled);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "CKPT: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
