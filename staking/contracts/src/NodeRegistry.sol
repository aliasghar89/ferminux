// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FMXStaking} from "./FMXStaking.sol";

/**
 * @title NodeRegistry — stake-gated node registration for Ferminux (chain 3961)
 * @notice Binds, per staking/DESIGN.md section 5, three things on-chain:
 *
 *             staker address -> consensus (block-signing) address -> node
 *             identity (devp2p public key), proven by a signature from the
 *             node key.
 *
 *         Each node is bonded by ONE Validator-track staking position of at
 *         least 25,000 FMX held in FMXStaking. The bond stays in the vault;
 *         this contract only links and gates.
 *
 *         THERE ARE NO PER-NODE REWARDS. Running a node is a multiplier
 *         condition on stake that is already bonded: a >=95% uptime epoch
 *         moves the linked position from 2.0x to 3.0x weight (and back).
 *         Splitting one bond into many nodes earns exactly nothing extra —
 *         that is the Sybil defence (design section 4).
 *
 *         Uptime attestation is a TRUSTED, OPERATOR-SIGNED ORACLE, not a
 *         proof (design section 4, stated plainly). Its power is bounded:
 *           - the watchtower can only post epoch scores (1-day epochs);
 *           - a posted epoch sits in a 7-day dispute window; the multisig can
 *             void it; anyone can finalize it after the window;
 *           - finalization's ONLY effect on funds is the 2.0x <-> 3.0x boost
 *             toggle in FMXStaking. The watchtower can never touch principal,
 *             never slash, never affect the other tiers.
 *
 *         Slashing (double-sign, 5% of bond) is a POST-FORK HOOK: it is inert
 *         until block 4,500,000 by an in-vault guard, requires a separately
 *         timelocked adjudicator address (zero today: no such engine exists),
 *         and — because the adjudicator is itself a trusted key — is bounded
 *         on-chain: MAX 5% per event, a LIFETIME cap of 10% of the original
 *         bond per position, a 7-day per-position cooldown between events
 *         (both vault-enforced, immune to re-registration games), and
 *         evidence deduplication by hash (the same offence can never be
 *         submitted twice). Paid to the future SystemRewards sink.
 *
 * STATUS (2026-09-26): not deployed on chain 3961. Chain 3961 runs Clique
 * proof-of-authority with an authorised signer set, and the stake-based
 * hand-off this surface was written for was dropped: no client reads it.
 *
 * FORMER MIGRATION SURFACE — the ABI the dropped design had a client read at
 * the fork block (static call, state of block 4,499,999) and every epoch after:
 *
 *     function getValidators()
 *         external view
 *         returns (address[] memory consensusAddrs, uint256[] memory bonds);
 *
 *   Returns the top-21 qualifying validator-track positions ranked by bond
 *   (ties broken by lower node id — deterministic on every node). Qualifying:
 *   registered + active node, position Active with bond >= 25,000 FMX, and
 *   >=95% mean attested uptime over the trailing 90 finalized epochs.
 *   Supporting views a client or explorer may also read:
 *     - uptimeOver90Epochs(nodeId), isQualified(nodeId)
 *     - getNode(nodeId), getNodePubkey(nodeId), listActiveNodes()
 *     - staking.getPosition(positionId) in FMXStaking
 *
 * Self-contained: imports only FMXStaking from this repo. solc >=0.8.24,
 * evm_version = paris (zero PUSH0).
 */
contract NodeRegistry {
    // ---------------------------------------------------------------- Types
    struct Node {
        address operator; // staker who registered the node
        address consensusAddr; // block-signing address in the dropped hand-off design
        address nodeAddress; // address derived from the devp2p pubkey
        uint64 registeredAt;
        uint64 lastSeen; // end of latest finalized epoch with score > 0
        uint16 lastUptimeBps; // score in the latest finalized epoch including it
        bool active; // false after deregistration
        uint256 positionId; // bonding Validator-track position in FMXStaking
    }

    struct Epoch {
        bytes32 root; // published merkle root of the watchtower's challenge log
        uint64 postedAt;
        bool finalized;
        bool voided;
    }

    // ------------------------------------------------------------ Constants
    uint256 public constant EPOCH_LENGTH = 1 days;
    uint256 public constant DISPUTE_WINDOW = 7 days;
    uint256 public constant QUAL_WINDOW = 90; // trailing epochs for qualification
    uint256 public constant QUAL_THRESHOLD_BPS = 9500; // >=95% mean uptime
    uint256 public constant BOOST_THRESHOLD_BPS = 9500; // >=95% in an epoch -> 3.0x
    uint256 public constant MAX_VALIDATORS = 21;
    uint256 public constant SLASH_BPS = 500; // 5% per adjudicated double-sign
    uint256 public constant TIMELOCK = 48 hours;
    uint256 public constant BPS = 10_000;

    // ----------------------------------------------------------- Immutables
    FMXStaking public immutable staking;
    uint256 public immutable minBond; // = staking.MIN_VALIDATOR_STAKE()

    // ------------------------------------------------------------ Ownership
    address public owner;
    address public pendingOwner;

    // ---------------------------------------------------------------- State
    /// @notice Trusted uptime oracle key. Rotatable by the owner immediately —
    ///         compromise response must not wait 48h; its power is bounded to
    ///         the boost toggle regardless.
    address public watchtower;

    /// @notice POST-FORK: address allowed to submit double-sign slashes.
    ///         Zero today (inert). Set via 48h timelock only.
    address public slashingAdjudicator;

    /// @notice POST-FORK: where slashed funds go (future SystemRewards).
    ///         Set via 48h timelock only.
    address public slashSink;

    uint256 public nodeCount; // ids run 1..nodeCount (historical, monotonic)

    /// @notice Compact array of ACTIVE node ids. Registration pushes; deregistration
    ///         swap-and-pops. Every roster/validator-set walk iterates THIS array,
    ///         so read cost is bounded by live nodes, never by registration history —
    ///         churning register/deregister cannot inflate the cost of
    ///         getValidators(), the call the dropped hand-off design made at the fork.
    uint256[] internal _activeNodeIds;
    /// @notice nodeId => index in _activeNodeIds PLUS ONE (0 = not active).
    mapping(uint256 => uint256) internal _activeIndexPlus1;

    /// @notice keccak256 of every slash evidence blob ever accepted. The same
    ///         offence can never be submitted twice.
    mapping(bytes32 => bool) public evidenceUsed;

    mapping(uint256 => Node) internal _nodes;
    mapping(address => uint256) public nodeIdByNodeAddress; // 0 = free
    mapping(address => uint256) public nodeIdByConsensusAddr; // 0 = free
    mapping(uint256 => uint256) public nodeIdByPosition; // 0 = free
    mapping(uint256 => bytes) internal _nodePubkey; // 64-byte devp2p pubkey

    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => uint256[]) internal _epochNodeIds;
    mapping(uint256 => uint16[]) internal _epochScores;
    /// @notice nodeId => epoch => attested uptime (bps), set at finalization.
    mapping(uint256 => mapping(uint256 => uint16)) public nodeScore;

    uint256 public latestFinalizedEpoch;
    bool public hasFinalizedEpoch;

    /// @notice Timelock queue: action key => eta (0 = not queued).
    mapping(bytes32 => uint256) public queuedEta;

    // --------------------------------------------------------------- Events
    event NodeRegistered(
        uint256 indexed nodeId,
        address indexed operator,
        address consensusAddr,
        address nodeAddress,
        uint256 indexed positionId
    );
    event NodeDeregistered(uint256 indexed nodeId, address indexed operator);
    event EpochPosted(uint256 indexed epoch, bytes32 root, uint256 nodeCount, uint256 postedAt);
    event EpochVoided(uint256 indexed epoch);
    event EpochFinalized(uint256 indexed epoch, uint256 nodeCount);
    event NodeAttested(uint256 indexed nodeId, uint256 indexed epoch, uint16 uptimeBps, bool boosted);
    event NodeSlashed(uint256 indexed nodeId, bytes32 evidenceHash, uint256 slashed, address indexed sink);
    event WatchtowerSet(address oldWatchtower, address newWatchtower);
    event SlashingAdjudicatorSet(address oldAdjudicator, address newAdjudicator);
    event SlashSinkSet(address oldSink, address newSink);
    event ParamQueued(bytes32 indexed key, uint256 eta);
    event ParamCancelled(bytes32 indexed key);
    event OwnerTransferStarted(address indexed newOwner);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    // ------------------------------------------------------------ Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "NR: not owner");
        _;
    }

    modifier onlyWatchtower() {
        require(msg.sender == watchtower, "NR: not watchtower");
        _;
    }

    modifier nodeExists(uint256 nodeId) {
        require(nodeId >= 1 && nodeId <= nodeCount, "NR: no such node");
        _;
    }

    // ---------------------------------------------------------- Constructor
    constructor(address _staking, address _owner, address _watchtower) {
        require(_staking != address(0), "NR: zero staking");
        require(_owner != address(0), "NR: zero owner");
        require(_watchtower != address(0), "NR: zero watchtower");
        staking = FMXStaking(_staking);
        minBond = FMXStaking(_staking).MIN_VALIDATOR_STAKE();
        owner = _owner;
        watchtower = _watchtower;
        emit OwnerTransferred(address(0), _owner);
        emit WatchtowerSet(address(0), _watchtower);
    }

    // ---------------------------------------------------------- Registration
    /// @notice Digest the node key must sign to prove possession. Binds chain,
    ///         registry, operator, consensus address and bonding position, so
    ///         a signature can never be replayed for another registration.
    function registrationDigest(address operator, address consensusAddr, uint256 positionId)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("FMX_NODE_REG_V1", block.chainid, address(this), operator, consensusAddr, positionId));
    }

    /**
     * @notice Register a node identity bonded by a Validator-track position.
     * @param pubkey        the node's 64-byte uncompressed devp2p public key
     *                      (without the 0x04 prefix), as in the enode URL
     * @param consensusAddr the block-signing address the dropped hand-off design would have used
     * @param positionId    the caller's Active Validator-track position with
     *                      >= 25,000 FMX — one node per position
     * @param v,r,s         signature over registrationDigest(...) by the node key
     */
    function registerNode(bytes calldata pubkey, address consensusAddr, uint256 positionId, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256 nodeId)
    {
        require(pubkey.length == 64, "NR: pubkey must be 64 bytes");
        require(consensusAddr != address(0), "NR: zero consensus addr");
        address nodeAddress = address(uint160(uint256(keccak256(pubkey))));
        require(nodeIdByNodeAddress[nodeAddress] == 0, "NR: node key already registered");
        require(nodeIdByConsensusAddr[consensusAddr] == 0, "NR: consensus addr already registered");
        require(nodeIdByPosition[positionId] == 0, "NR: position already bonds a node");

        FMXStaking.Position memory p = staking.getPosition(positionId);
        require(p.owner == msg.sender, "NR: not position owner");
        require(p.tier == FMXStaking.Tier.Validator, "NR: not a validator-track position");
        require(p.state == FMXStaking.PositionState.Active, "NR: position not active");
        require(uint256(p.amount) >= minBond, "NR: bond below minimum");

        address recovered = ecrecover(registrationDigest(msg.sender, consensusAddr, positionId), v, r, s);
        require(recovered != address(0) && recovered == nodeAddress, "NR: invalid possession signature");

        nodeId = ++nodeCount;
        _nodes[nodeId] = Node({
            operator: msg.sender,
            consensusAddr: consensusAddr,
            nodeAddress: nodeAddress,
            registeredAt: uint64(block.timestamp),
            lastSeen: 0,
            lastUptimeBps: 0,
            active: true,
            positionId: positionId
        });
        _nodePubkey[nodeId] = pubkey;
        nodeIdByNodeAddress[nodeAddress] = nodeId;
        nodeIdByConsensusAddr[consensusAddr] = nodeId;
        nodeIdByPosition[positionId] = nodeId;
        _activeNodeIds.push(nodeId);
        _activeIndexPlus1[nodeId] = _activeNodeIds.length;
        emit NodeRegistered(nodeId, msg.sender, consensusAddr, nodeAddress, positionId);
    }

    /// @notice Deregister a node. Frees its identity bindings (they may be
    ///         re-registered), removes it from the active-node array
    ///         (swap-and-pop) and drops any active boost on the bond.
    function deregisterNode(uint256 nodeId) external nodeExists(nodeId) {
        Node storage n = _nodes[nodeId];
        require(n.operator == msg.sender, "NR: not node operator");
        require(n.active, "NR: node not active");
        n.active = false;
        delete nodeIdByNodeAddress[n.nodeAddress];
        delete nodeIdByConsensusAddr[n.consensusAddr];
        delete nodeIdByPosition[n.positionId];

        // swap-and-pop from the active array; keep the index map exact
        uint256 idx = _activeIndexPlus1[nodeId] - 1; // n.active guaranteed presence
        uint256 lastIdx = _activeNodeIds.length - 1;
        if (idx != lastIdx) {
            uint256 movedId = _activeNodeIds[lastIdx];
            _activeNodeIds[idx] = movedId;
            _activeIndexPlus1[movedId] = idx + 1;
        }
        _activeNodeIds.pop();
        delete _activeIndexPlus1[nodeId];

        staking.setBoost(n.positionId, false); // no-op if position already exited
        emit NodeDeregistered(nodeId, msg.sender);
    }

    // ----------------------------------------------------------- Attestation
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_LENGTH;
    }

    /**
     * @notice Watchtower posts a completed epoch's uptime scores plus the
     *         merkle root of its published challenge log. The epoch then sits
     *         in the 7-day dispute window; nothing takes effect until
     *         finalizeEpoch().
     */
    function postEpoch(uint256 epoch, bytes32 root, uint256[] calldata nodeIds, uint16[] calldata uptimeBps)
        external
        onlyWatchtower
    {
        require(epoch < currentEpoch(), "NR: epoch not over");
        require(!hasFinalizedEpoch || epoch > latestFinalizedEpoch, "NR: epoch not after latest finalized");
        Epoch storage e = epochs[epoch];
        require(e.postedAt == 0 || e.voided, "NR: epoch already posted");
        require(!e.finalized, "NR: epoch already finalized");
        require(nodeIds.length == uptimeBps.length, "NR: length mismatch");
        for (uint256 i = 0; i < nodeIds.length; i++) {
            require(nodeIds[i] >= 1 && nodeIds[i] <= nodeCount, "NR: unknown node in epoch");
            require(uptimeBps[i] <= BPS, "NR: uptime above 100%");
        }
        e.root = root;
        e.postedAt = uint64(block.timestamp);
        e.voided = false;
        _epochNodeIds[epoch] = nodeIds;
        _epochScores[epoch] = uptimeBps;
        emit EpochPosted(epoch, root, nodeIds.length, block.timestamp);
    }

    /// @notice Void a posted-but-unfinalized epoch during the dispute window.
    ///         The multisig's remedy for a bad or contested attestation.
    function voidEpoch(uint256 epoch) external onlyOwner {
        Epoch storage e = epochs[epoch];
        require(e.postedAt != 0, "NR: epoch not posted");
        require(!e.finalized, "NR: epoch already finalized");
        require(!e.voided, "NR: epoch already voided");
        e.voided = true;
        delete _epochNodeIds[epoch];
        delete _epochScores[epoch];
        emit EpochVoided(epoch);
    }

    /**
     * @notice After the 7-day dispute window anyone may finalize a posted
     *         epoch: scores become part of the qualification record and each
     *         included node's boost is set (>=95% -> 3.0x, else 2.0x).
     *         Nodes deregistered since posting are skipped, and setBoost
     *         no-ops on exited positions — finalization can never be bricked.
     */
    function finalizeEpoch(uint256 epoch) external {
        Epoch storage e = epochs[epoch];
        require(e.postedAt != 0, "NR: epoch not posted");
        require(!e.voided, "NR: epoch voided");
        require(!e.finalized, "NR: epoch already finalized");
        require(block.timestamp >= uint256(e.postedAt) + DISPUTE_WINDOW, "NR: dispute window open");
        e.finalized = true;
        if (epoch > latestFinalizedEpoch || !hasFinalizedEpoch) {
            latestFinalizedEpoch = epoch;
            hasFinalizedEpoch = true;
        }
        uint256[] storage ids = _epochNodeIds[epoch];
        uint16[] storage scores = _epochScores[epoch];
        uint64 epochEnd = uint64((epoch + 1) * EPOCH_LENGTH);
        for (uint256 i = 0; i < ids.length; i++) {
            Node storage n = _nodes[ids[i]];
            if (!n.active) continue; // deregistered since posting
            uint16 score = scores[i];
            nodeScore[ids[i]][epoch] = score;
            n.lastUptimeBps = score;
            if (score > 0 && epochEnd > n.lastSeen) n.lastSeen = epochEnd;
            bool boosted = score >= BOOST_THRESHOLD_BPS;
            staking.setBoost(n.positionId, boosted);
            emit NodeAttested(ids[i], epoch, score, boosted);
        }
        emit EpochFinalized(epoch, ids.length);
    }

    // -------------------------------------------------------------- Slashing
    /**
     * @notice POST-FORK HOOK — inert today. Slash 5% of a node's bond for
     *         adjudicated double-signing. Requires: an adjudicator set via
     *         48h timelock (zero now), a slash sink set via 48h timelock,
     *         and block.number >= 4,500,000 (enforced in FMXStaking).
     *
     *         The adjudicator is a TRUSTED key, not a proof, so its damage is
     *         bounded on-chain (audit finding, red-team 2026-08):
     *           - evidence must be non-empty and NEVER seen before (dedup by
     *             keccak256 — the same offence cannot be submitted twice);
     *           - FMXStaking additionally enforces, per POSITION (survives
     *             deregister/re-register): >= 7-day cooldown between slashes
     *             and a lifetime cap of 10% of the original bond. Total
     *             confiscation by a rogue adjudicator is impossible, and the
     *             cooldown gives the multisig a window to rotate the key
     *             before repeat damage lands.
     *         On-chain header verification belonged to the dropped client work,
     *         not this hooks-only surface.
     */
    function slash(uint256 nodeId, bytes calldata evidence) external nodeExists(nodeId) returns (uint256 slashed) {
        require(msg.sender == slashingAdjudicator && slashingAdjudicator != address(0), "NR: not adjudicator");
        require(slashSink != address(0), "NR: slash sink unset");
        require(evidence.length > 0, "NR: empty evidence");
        bytes32 evidenceHash = keccak256(evidence);
        require(!evidenceUsed[evidenceHash], "NR: duplicate evidence");
        evidenceUsed[evidenceHash] = true; // effects before the external call
        Node storage n = _nodes[nodeId];
        slashed = staking.slashBond(n.positionId, SLASH_BPS, slashSink);
        emit NodeSlashed(nodeId, evidenceHash, slashed, slashSink);
    }

    // ------------------------------------------- Owner actions (immediate)
    /// @notice Rotate the watchtower oracle key. Immediate — this is the
    ///         compromise-recovery path and the oracle's power is bounded to
    ///         the boost toggle in any case.
    function setWatchtower(address newWatchtower) external onlyOwner {
        require(newWatchtower != address(0), "NR: zero watchtower");
        emit WatchtowerSet(watchtower, newWatchtower);
        watchtower = newWatchtower;
    }

    /// @notice Two-step owner transfer (multisig rotation).
    function transferOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "NR: zero new owner");
        pendingOwner = newOwner;
        emit OwnerTransferStarted(newOwner);
    }

    function acceptOwner() external {
        require(msg.sender == pendingOwner, "NR: not pending owner");
        emit OwnerTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // --------------------------------------- Owner actions (48h timelocked)
    function _queue(bytes32 key) internal {
        require(queuedEta[key] == 0, "NR: already queued");
        queuedEta[key] = block.timestamp + TIMELOCK;
        emit ParamQueued(key, queuedEta[key]);
    }

    function _consume(bytes32 key) internal {
        uint256 eta = queuedEta[key];
        require(eta != 0, "NR: not queued");
        require(block.timestamp >= eta, "NR: timelock not elapsed");
        delete queuedEta[key];
    }

    function cancelQueued(bytes32 key) external onlyOwner {
        require(queuedEta[key] != 0, "NR: not queued");
        delete queuedEta[key];
        emit ParamCancelled(key);
    }

    function adjudicatorKey(address adjudicator) public pure returns (bytes32) {
        return keccak256(abi.encode("NR_ADJUDICATOR", adjudicator));
    }

    function queueSetSlashingAdjudicator(address adjudicator) external onlyOwner {
        _queue(adjudicatorKey(adjudicator));
    }

    function applySetSlashingAdjudicator(address adjudicator) external onlyOwner {
        _consume(adjudicatorKey(adjudicator));
        emit SlashingAdjudicatorSet(slashingAdjudicator, adjudicator);
        slashingAdjudicator = adjudicator;
    }

    function slashSinkKey(address sink) public pure returns (bytes32) {
        return keccak256(abi.encode("NR_SLASH_SINK", sink));
    }

    function queueSetSlashSink(address sink) external onlyOwner {
        require(sink != address(0), "NR: zero sink");
        _queue(slashSinkKey(sink));
    }

    function applySetSlashSink(address sink) external onlyOwner {
        _consume(slashSinkKey(sink));
        emit SlashSinkSet(slashSink, sink);
        slashSink = sink;
    }

    // ---------------------------------------------------------------- Views
    struct NodeView {
        uint256 nodeId;
        address operator;
        address consensusAddr;
        address nodeAddress;
        uint256 stake; // live bond from FMXStaking
        bool boosted;
        uint64 lastSeen;
        uint16 lastUptimeBps;
    }

    function getNode(uint256 nodeId) external view nodeExists(nodeId) returns (Node memory) {
        return _nodes[nodeId];
    }

    function getNodePubkey(uint256 nodeId) external view nodeExists(nodeId) returns (bytes memory) {
        return _nodePubkey[nodeId];
    }

    function getEpochNodes(uint256 epoch) external view returns (uint256[] memory, uint16[] memory) {
        return (_epochNodeIds[epoch], _epochScores[epoch]);
    }

    /// @dev A node counts as live when it is registered, its bonding position
    ///      is still Active and its bond still meets the minimum.
    function _isLive(uint256 nodeId) internal view returns (bool live, FMXStaking.Position memory p) {
        Node storage n = _nodes[nodeId];
        if (!n.active) return (false, p);
        p = staking.getPosition(n.positionId);
        live = p.state == FMXStaking.PositionState.Active && uint256(p.amount) >= minBond;
    }

    /// @notice Number of currently registered (active) nodes. Contrast with
    ///         nodeCount, which is the historical total and only ever grows.
    function activeNodeCount() external view returns (uint256) {
        return _activeNodeIds.length;
    }

    /// @notice The compact active-node id array (order is not meaningful:
    ///         registration order perturbed by swap-and-pop removals).
    function getActiveNodeIds() external view returns (uint256[] memory) {
        return _activeNodeIds;
    }

    /// @notice Network roster for the app and site: every live node with its
    ///         stake and last-seen. "Bonded nodes" — NOT a distinct-operator
    ///         count (design section 4, honesty note). O(active nodes): walks
    ///         the compact active array, never historical ids.
    function listActiveNodes() external view returns (NodeView[] memory nodesOut) {
        uint256 total = _activeNodeIds.length;
        uint256 live = 0;
        for (uint256 i = 0; i < total; i++) {
            (bool ok,) = _isLive(_activeNodeIds[i]);
            if (ok) live++;
        }
        nodesOut = new NodeView[](live);
        uint256 j = 0;
        for (uint256 i = 0; i < total; i++) {
            uint256 id = _activeNodeIds[i];
            (bool ok, FMXStaking.Position memory p) = _isLive(id);
            if (!ok) continue;
            Node storage n = _nodes[id];
            nodesOut[j++] = NodeView({
                nodeId: id,
                operator: n.operator,
                consensusAddr: n.consensusAddr,
                nodeAddress: n.nodeAddress,
                stake: uint256(p.amount),
                boosted: p.boosted,
                lastSeen: n.lastSeen,
                lastUptimeBps: n.lastUptimeBps
            });
        }
    }

    /// @notice Mean attested uptime (bps) over the trailing 90 finalized
    ///         epochs. Epochs with no finalized attestation count as zero —
    ///         a node the watchtower never saw is a node that was down.
    function uptimeOver90Epochs(uint256 nodeId) public view returns (uint256 avgBps) {
        if (!hasFinalizedEpoch) return 0;
        uint256 end = latestFinalizedEpoch;
        uint256 start = end >= QUAL_WINDOW - 1 ? end - (QUAL_WINDOW - 1) : 0;
        uint256 sum = 0;
        for (uint256 e = start; e <= end; e++) {
            sum += nodeScore[nodeId][e];
        }
        return sum / QUAL_WINDOW;
    }

    /// @notice Whether a node currently qualifies for the (dropped) stake-based validator list.
    function isQualified(uint256 nodeId) public view returns (bool) {
        (bool live,) = _isLive(nodeId);
        if (!live) return false;
        return uptimeOver90Epochs(nodeId) >= QUAL_THRESHOLD_BPS;
    }

    /**
     * @notice Former migration surface — the fixed ABI the dropped design had a client read
     *         at the fork block and every epoch after (design section 5): the top-21
     *         qualifying validator-track positions, ranked by bond descending,
     *         ties broken by lower node id. Pure function of consensus state:
     *         every node derives the identical set. Cost is O(active nodes) —
     *         it walks the compact active array, so historical register/
     *         deregister churn cannot make this call more expensive, and the
     *         selection itself is order-independent (max bond, then min id),
     *         so swap-and-pop array order never changes the result.
     */
    function getValidators() external view returns (address[] memory consensusAddrs, uint256[] memory bonds) {
        uint256 total = _activeNodeIds.length;
        uint256[] memory candIds = new uint256[](total);
        uint256[] memory candBonds = new uint256[](total);
        uint256 m = 0;
        for (uint256 i = 0; i < total; i++) {
            uint256 id = _activeNodeIds[i];
            if (!isQualified(id)) continue;
            candIds[m] = id;
            candBonds[m] = uint256(staking.getPosition(_nodes[id].positionId).amount);
            m++;
        }
        uint256 k = m < MAX_VALIDATORS ? m : MAX_VALIDATORS;
        consensusAddrs = new address[](k);
        bonds = new uint256[](k);
        for (uint256 i = 0; i < k; i++) {
            // selection: largest bond, ties to the lowest node id
            uint256 best = i;
            for (uint256 j = i + 1; j < m; j++) {
                if (candBonds[j] > candBonds[best] || (candBonds[j] == candBonds[best] && candIds[j] < candIds[best])) {
                    best = j;
                }
            }
            (candIds[i], candIds[best]) = (candIds[best], candIds[i]);
            (candBonds[i], candBonds[best]) = (candBonds[best], candBonds[i]);
            consensusAddrs[i] = _nodes[candIds[i]].consensusAddr;
            bonds[i] = candBonds[i];
        }
    }
}
