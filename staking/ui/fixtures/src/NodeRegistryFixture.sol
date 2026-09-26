// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultView {
    function positionById(uint256 id) external view returns (address owner, uint256 tier, uint256 amount, uint256 state);
}

/**
 * @title NodeRegistryFixture
 * @notice E2E TEST FIXTURE for the Ferminux staking UI — NOT the production
 *         registry (DESIGN.md calls it ValidatorRegistry). Enough of the real
 *         surface for the UI's roster + register-a-node flow:
 *
 *           - one node per validator-track position, bond read from the vault
 *           - registration binds operator -> consensus signing address ->
 *             node identity (bytes32 enode-pubkey hash)
 *           - a watchtower address posts uptime attestations (lastSeen +
 *             uptime bps) — trusted oracle, exactly as the design admits
 *
 *         Self-contained, Paris EVM, zero PUSH0.
 */
contract NodeRegistryFixture {
    // ---------------------------------------------------------------- Events
    event NodeRegistered(uint256 indexed id, address indexed operator, address consensusAddr, bytes32 enodeId, uint256 positionId);
    event NodeDeregistered(uint256 indexed id, address indexed operator);
    event UptimeAttested(uint256 indexed id, uint256 uptimeBps, uint256 timestamp);

    // ---------------------------------------------------------------- Types
    struct Node {
        uint256 id;
        address operator;
        address consensusAddr;
        bytes32 enodeId;
        uint256 positionId;
        uint256 registeredAt;
        uint256 lastSeen;
        uint256 uptimeBps;
        bool active;
    }

    struct NodeView {
        uint256 id;
        address operator;
        address consensusAddr;
        bytes32 enodeId;
        uint256 positionId;
        uint256 bond;
        uint256 registeredAt;
        uint256 lastSeen;
        uint256 uptimeBps;
        bool active;
    }

    // ---------------------------------------------------------------- State
    IVaultView public immutable vault;
    uint256 public immutable validatorTier;
    uint256 public immutable minBond;
    address public immutable watchtower;

    Node[] private _nodes;
    mapping(uint256 => bool) public positionRegistered;
    mapping(bytes32 => bool) public enodeRegistered;

    // ----------------------------------------------------------- Constructor
    constructor(address _vault, uint256 _validatorTier, uint256 _minBond, address _watchtower) {
        require(_vault != address(0), "NR: zero vault");
        require(_watchtower != address(0), "NR: zero watchtower");
        vault = IVaultView(_vault);
        validatorTier = _validatorTier;
        minBond = _minBond;
        watchtower = _watchtower;
    }

    // ---------------------------------------------------------------- Views
    function nodeCount() external view returns (uint256) {
        return _nodes.length;
    }

    /// Full roster; bond and active-ness re-read from the vault so an
    /// emergency-exited position never shows as a live node.
    function getNodes() external view returns (NodeView[] memory out) {
        out = new NodeView[](_nodes.length);
        for (uint256 i = 0; i < _nodes.length; i++) {
            Node storage n = _nodes[i];
            (, , uint256 amount, uint256 state) = vault.positionById(n.positionId);
            out[i] = NodeView(
                n.id,
                n.operator,
                n.consensusAddr,
                n.enodeId,
                n.positionId,
                amount,
                n.registeredAt,
                n.lastSeen,
                n.uptimeBps,
                n.active && state == 0
            );
        }
    }

    // -------------------------------------------------------------- Actions
    function registerNode(uint256 positionId, address consensusAddr, bytes32 enodeId) external returns (uint256 id) {
        require(consensusAddr != address(0), "NR: zero consensus addr");
        require(enodeId != bytes32(0), "NR: zero enode id");
        require(!positionRegistered[positionId], "NR: position already has a node");
        require(!enodeRegistered[enodeId], "NR: enode already registered");
        (address owner, uint256 tier, uint256 amount, uint256 state) = vault.positionById(positionId);
        require(owner == msg.sender, "NR: not position owner");
        require(tier == validatorTier, "NR: not a validator-track position");
        require(amount >= minBond, "NR: bond below minimum");
        require(state == 0, "NR: position not active");

        id = _nodes.length;
        _nodes.push(Node(id, msg.sender, consensusAddr, enodeId, positionId, block.timestamp, 0, 0, true));
        positionRegistered[positionId] = true;
        enodeRegistered[enodeId] = true;
        emit NodeRegistered(id, msg.sender, consensusAddr, enodeId, positionId);
    }

    function deregister(uint256 nodeId) external {
        require(nodeId < _nodes.length, "NR: no such node");
        Node storage n = _nodes[nodeId];
        require(n.operator == msg.sender, "NR: not node operator");
        require(n.active, "NR: already deregistered");
        n.active = false;
        positionRegistered[n.positionId] = false;
        enodeRegistered[n.enodeId] = false;
        emit NodeDeregistered(nodeId, msg.sender);
    }

    /// Watchtower-signed uptime attestation (trusted oracle by design).
    function attest(uint256[] calldata ids, uint256[] calldata uptimes) external {
        require(msg.sender == watchtower, "NR: not watchtower");
        require(ids.length == uptimes.length, "NR: length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            require(ids[i] < _nodes.length, "NR: no such node");
            require(uptimes[i] <= 10_000, "NR: uptime above 100%");
            Node storage n = _nodes[ids[i]];
            n.uptimeBps = uptimes[i];
            n.lastSeen = block.timestamp;
            emit UptimeAttested(ids[i], uptimes[i], block.timestamp);
        }
    }
}
