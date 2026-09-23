// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";
import {ServiceEscrow} from "./ServiceEscrow.sol";
import {Sig} from "./lib/Sig.sol";
import {IAccountFactoryLike, IAccountLike} from "./lib/IAccount.sol";

/// @title Endorsements — agent-to-agent capability endorsements, weighted by the endorser's own paid work
/// @notice Agent A endorses agent B for a named capability. The endorsement's weight is derived from A's
///         OWN verifiable history: a completed ServiceEscrow job, paid by a third party at arm's length
///         from both A and B, that A delivered. No evidence, no weight — and an unweighted endorsement is
///         a separate, counted category rather than a hidden zero, so a reader always sees how many of an
///         agent's endorsements carry economic backing and how many do not.
/// @dev Paris EVM (no PUSH0), solc 0.8.24, dependency-free, custom errors only.
///      This contract never holds, receives or sends FMX: no payable function, no value path, nothing to
///      reenter and no pull-payment ledger to keep.
///
///      Arms-length test (a faithful port of `jobQualifies` in `gateway/src/commons/referrals.ts`):
///      a party is its owner address AND every AgentAccount that owner holds. Two parties are related
///      when they are the same address, when one is an AgentAccount of the other, or when both are
///      AgentAccounts of one owner. A related pair may never endorse, and a job whose client is related
///      to either side is not evidence of anything.
///
///      What this contract deliberately does NOT claim: `weight` is a snapshot of one proven paid job
///      scaled by the registry's rating counters. Those counters are cheap to inflate (see SPEC.md,
///      AI-CV layer), so the authoritative score stays off chain — the contract emits the evidence
///      (job id, amount, client-at-arm's-length flag) so an independent scorer can recompute its own.
contract Endorsements {
    // ───────────────────────────── types ─────────────────────────────

    /// @notice Unbacked = no proven paid work behind it, weight 0. PaidWork = backed by an arm's-length
    ///         completed escrow job the endorser delivered.
    enum Basis {
        Unbacked,
        PaidWork
    }

    struct Endorsement {
        uint64 fromAgentId;
        uint64 toAgentId;
        uint64 evidenceJobId; // 0 when Unbacked
        uint32 weight; // snapshot at endorsement time; 0 when Unbacked or revoked
        address endorser; // fromAgentId's owner at endorsement time
        bool revoked;
        Basis basis;
        uint64 ts;
        uint256 evidenceAmountWei; // the evidence job's amount; 0 when Unbacked
        bytes32 capabilityId; // keccak256(bytes(capability))
        string capability;
        string uri; // optional evidence / statement URI
    }

    /// @notice Live tallies for an agent (or for one of its capabilities). `backed` + `unbacked` == `total`.
    struct Summary {
        uint32 total; // active endorsements received
        uint32 backed; // of which Basis.PaidWork
        uint32 unbacked; // of which Basis.Unbacked (weight 0)
        uint32 revoked; // revoked, no longer counted in `total`
        uint128 weight; // sum of active weights
    }

    // ───────────────────────────── constants ─────────────────────────────

    string public constant NAME = "FerminuxEndorsements";
    string public constant VERSION = "1";
    /// @notice One whole FMX of proven, arm's-length, completed work = one base point of weight.
    uint256 public constant WEIGHT_UNIT_WEI = 1 ether;
    /// @notice Rating assumed for an endorser the registry has never rated (neutral, mid-scale).
    uint256 public constant RATING_PRIOR = 3;

    bytes32 public constant ENDORSE_TYPEHASH = keccak256(
        "Endorse(uint256 fromAgentId,uint256 toAgentId,string capability,string uri,uint256 evidenceJobId,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant REVOKE_TYPEHASH = keccak256("Revoke(uint256 endorsementId,uint256 nonce,uint64 deadline)");

    // ───────────────────────────── storage ─────────────────────────────

    AgentRegistry public immutable registry;
    ServiceEscrow public immutable escrow;
    /// @notice AgentAccountFactory; address(0) disables the AgentAccount half of the arms-length test.
    IAccountFactoryLike public immutable accountFactory;

    address public governance;
    /// @notice An evidence job must have paid at least this much to back an endorsement.
    uint256 public minPaidWei = 1 ether;
    /// @notice Hard ceiling on a single endorsement's weight — breadth must beat depth.
    uint32 public weightCap = 1000;
    uint16 public maxUriBytes = 256;

    uint256 public nextId; // endorsement ids start at 1
    mapping(uint256 => Endorsement) private _endorsements;
    mapping(uint256 => uint256[]) private _received; // toAgentId => endorsement ids
    mapping(uint256 => uint256[]) private _given; // fromAgentId => endorsement ids
    mapping(uint256 => Summary) private _summary; // toAgentId => tallies
    mapping(uint256 => mapping(bytes32 => Summary)) private _capSummary; // toAgentId => capabilityId => tallies
    /// @notice from => to => capabilityId => ACTIVE endorsement id (0 = none)
    mapping(uint256 => mapping(uint256 => mapping(bytes32 => uint256))) public edgeOf;
    mapping(uint256 => uint256) public nonces; // fromAgentId => next signed-write nonce

    // ───────────────────────────── events ─────────────────────────────

    event Endorsed(
        uint256 indexed id,
        uint256 indexed fromAgentId,
        uint256 indexed toAgentId,
        bytes32 capabilityId,
        string capability,
        Basis basis,
        uint32 weight,
        uint64 evidenceJobId,
        uint256 evidenceAmountWei,
        string uri
    );
    event EndorsementRevoked(uint256 indexed id, uint256 indexed fromAgentId, uint256 indexed toAgentId, uint32 weight);
    event MinPaidWeiChanged(uint256 minPaidWei);
    event WeightCapChanged(uint32 weightCap);
    event MaxUriBytesChanged(uint16 maxUriBytes);
    event GovernanceChanged(address indexed previous, address indexed current);

    // ───────────────────────────── errors ─────────────────────────────

    error ZeroAddress();
    error NotGovernance();
    error NotAuthorized();
    error UnknownAgent(uint256 agentId);
    error UnknownEndorsement(uint256 id);
    error SelfEndorsement(); // same agent, same owner, or an account either side controls
    error AlreadyEndorsed(uint256 existingId);
    error AlreadyRevoked(uint256 id);
    error InvalidCapability();
    error StringTooLong();
    error ExpiredSignature(uint64 deadline);
    error BadSignature();
    error EvidenceNotCompleted(ServiceEscrow.JobStatus status);
    error EvidenceNotOwnWork(uint256 jobAgentId);
    error EvidenceTooSmall(uint256 amount, uint256 required);
    error EvidenceNotArmsLength(address client);

    // ───────────────────────────── modifiers ─────────────────────────────

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ───────────────────────────── constructor ─────────────────────────────

    constructor(
        AgentRegistry registry_,
        ServiceEscrow escrow_,
        IAccountFactoryLike accountFactory_,
        address governance_
    ) {
        if (address(registry_) == address(0) || address(escrow_) == address(0) || governance_ == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        escrow = escrow_;
        accountFactory = accountFactory_;
        governance = governance_;
        emit GovernanceChanged(address(0), governance_);
        emit MinPaidWeiChanged(minPaidWei);
        emit WeightCapChanged(weightCap);
        emit MaxUriBytesChanged(maxUriBytes);
    }

    // ───────────────────────────── writes ─────────────────────────────

    /// @notice Endorse `toAgentId` for `capability`. Called by `fromAgentId`'s owner or by an
    ///         AgentAccount that owner holds.
    /// @param evidenceJobId a ServiceEscrow job the endorser completed, paid at arm's length by a third
    ///        party — or 0 for an explicitly unbacked, zero-weight endorsement.
    function endorse(
        uint256 fromAgentId,
        uint256 toAgentId,
        string calldata capability,
        string calldata uri,
        uint256 evidenceJobId
    ) external returns (uint256 id) {
        if (!_authorized(fromAgentId, msg.sender)) revert NotAuthorized();
        return _endorse(fromAgentId, toAgentId, capability, uri, evidenceJobId);
    }

    /// @notice Relayed endorsement: the endorsing agent's owner signs, anyone pays the gas.
    function endorseFor(
        uint256 fromAgentId,
        uint256 toAgentId,
        string calldata capability,
        string calldata uri,
        uint256 evidenceJobId,
        uint64 deadline,
        bytes calldata sig
    ) external returns (uint256 id) {
        if (block.timestamp > deadline) revert ExpiredSignature(deadline);
        uint256 nonce = nonces[fromAgentId];
        bytes32 digest = hashEndorse(fromAgentId, toAgentId, capability, uri, evidenceJobId, nonce, deadline);
        if (!Sig.isValid(_ownerOf(fromAgentId), digest, sig)) revert BadSignature();
        nonces[fromAgentId] = nonce + 1;
        return _endorse(fromAgentId, toAgentId, capability, uri, evidenceJobId);
    }

    /// @notice Withdraw an endorsement. The record survives (revoked = true) but stops counting.
    function revoke(uint256 id) external {
        Endorsement storage e = _endorsements[id];
        if (e.fromAgentId == 0) revert UnknownEndorsement(id);
        if (!_authorized(e.fromAgentId, msg.sender)) revert NotAuthorized();
        _revoke(id, e);
    }

    /// @notice Relayed revocation.
    function revokeFor(uint256 id, uint64 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert ExpiredSignature(deadline);
        Endorsement storage e = _endorsements[id];
        if (e.fromAgentId == 0) revert UnknownEndorsement(id);
        uint256 from = e.fromAgentId;
        uint256 nonce = nonces[from];
        bytes32 digest = hashRevoke(id, nonce, deadline);
        if (!Sig.isValid(_ownerOf(from), digest, sig)) revert BadSignature();
        nonces[from] = nonce + 1;
        _revoke(id, e);
    }

    // ───────────────────────────── governance ─────────────────────────────

    /// @dev Parameter changes are forward-looking only: every endorsement stores the weight it was
    ///      issued with, so history never silently re-prices.
    function setMinPaidWei(uint256 newMin) external onlyGovernance {
        minPaidWei = newMin;
        emit MinPaidWeiChanged(newMin);
    }

    function setWeightCap(uint32 newCap) external onlyGovernance {
        weightCap = newCap;
        emit WeightCapChanged(newCap);
    }

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

    function getEndorsement(uint256 id) external view returns (Endorsement memory) {
        Endorsement memory e = _endorsements[id];
        if (e.fromAgentId == 0) revert UnknownEndorsement(id);
        return e;
    }

    /// @notice Everything a profile needs in one call: how many endorsements an agent holds, how many
    ///         carry proven paid work behind them, how many do not, and the total weight.
    function summary(uint256 toAgentId) external view returns (Summary memory) {
        return _summary[toAgentId];
    }

    function capabilitySummary(uint256 toAgentId, string calldata capability) external view returns (Summary memory) {
        return _capSummary[toAgentId][keccak256(bytes(capability))];
    }

    function capabilitySummaryById(uint256 toAgentId, bytes32 capabilityId) external view returns (Summary memory) {
        return _capSummary[toAgentId][capabilityId];
    }

    function receivedCount(uint256 toAgentId) external view returns (uint256) {
        return _received[toAgentId].length;
    }

    function givenCount(uint256 fromAgentId) external view returns (uint256) {
        return _given[fromAgentId].length;
    }

    /// @notice Page through the ids an agent received (includes revoked ones — the record is permanent).
    function receivedIds(uint256 toAgentId, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_received[toAgentId], offset, limit);
    }

    function givenIds(uint256 fromAgentId, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_given[fromAgentId], offset, limit);
    }

    /// @notice The weight `fromAgentId` would carry endorsing `toAgentId` with `evidenceJobId` right now.
    /// @dev Reverts exactly as the write would, so a caller can preview a failure without sending a tx.
    function quoteWeight(uint256 fromAgentId, uint256 toAgentId, uint256 evidenceJobId)
        public
        view
        returns (uint32 weight, Basis basis, uint256 evidenceAmountWei)
    {
        address fromOwner = _ownerOf(fromAgentId);
        address toOwner = _ownerOf(toAgentId);
        return _weigh(fromAgentId, fromOwner, toOwner, evidenceJobId);
    }

    /// @notice True when `who` may act for `agentId`: its owner, or an AgentAccount that owner holds.
    function canActFor(uint256 agentId, address who) external view returns (bool) {
        return _authorized(agentId, who);
    }

    /// @notice The arms-length test, exposed so the gateway and the CV builder apply exactly this rule.
    function isRelated(address a, address b) external view returns (bool) {
        return _related(a, b);
    }

    function capabilityIdOf(string calldata capability) external pure returns (bytes32) {
        return keccak256(bytes(capability));
    }

    // ───────────────────────────── EIP-712 ─────────────────────────────

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return Sig.domainSeparator(NAME, VERSION, address(this));
    }

    function hashEndorse(
        uint256 fromAgentId,
        uint256 toAgentId,
        string calldata capability,
        string calldata uri,
        uint256 evidenceJobId,
        uint256 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        return Sig.typedDataHash(
            DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    ENDORSE_TYPEHASH,
                    fromAgentId,
                    toAgentId,
                    keccak256(bytes(capability)),
                    keccak256(bytes(uri)),
                    evidenceJobId,
                    nonce,
                    deadline
                )
            )
        );
    }

    function hashRevoke(uint256 endorsementId, uint256 nonce, uint64 deadline) public view returns (bytes32) {
        return
            Sig.typedDataHash(
                DOMAIN_SEPARATOR(), keccak256(abi.encode(REVOKE_TYPEHASH, endorsementId, nonce, deadline))
            );
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Everything `_endorse` resolves before it writes. A memory struct keeps the write path
    ///      inside the legacy-codegen stack limit (this repo targets Paris, no via-ir).
    struct Pending {
        uint64 fromAgentId;
        uint64 toAgentId;
        uint64 evidenceJobId;
        uint32 weight;
        address fromOwner;
        Basis basis;
        uint256 evidenceAmountWei;
        bytes32 capabilityId;
    }

    function _endorse(
        uint256 fromAgentId,
        uint256 toAgentId,
        string calldata capability,
        string calldata uri,
        uint256 evidenceJobId
    ) internal returns (uint256 id) {
        Pending memory p = _prepare(fromAgentId, toAgentId, capability, uri, evidenceJobId);
        return _store(p, capability, uri);
    }

    function _prepare(
        uint256 fromAgentId,
        uint256 toAgentId,
        string calldata capability,
        string calldata uri,
        uint256 evidenceJobId
    ) internal view returns (Pending memory p) {
        if (fromAgentId == toAgentId) revert SelfEndorsement();
        uint256 capLen = bytes(capability).length;
        if (capLen == 0 || capLen > 64) revert InvalidCapability();
        if (bytes(uri).length > maxUriBytes) revert StringTooLong();

        p.fromAgentId = uint64(fromAgentId);
        p.toAgentId = uint64(toAgentId);
        p.evidenceJobId = uint64(evidenceJobId);
        p.fromOwner = _ownerOf(fromAgentId);
        address toOwner = _ownerOf(toAgentId);
        // you cannot endorse yourself, nor an agent whose owner you are, nor one that owns you
        if (_related(p.fromOwner, toOwner)) revert SelfEndorsement();

        p.capabilityId = keccak256(bytes(capability));
        uint256 existing = edgeOf[fromAgentId][toAgentId][p.capabilityId];
        if (existing != 0) revert AlreadyEndorsed(existing);

        (p.weight, p.basis, p.evidenceAmountWei) = _weigh(fromAgentId, p.fromOwner, toOwner, evidenceJobId);
    }

    function _store(Pending memory p, string calldata capability, string calldata uri) internal returns (uint256 id) {
        id = ++nextId;
        Endorsement storage e = _endorsements[id];
        e.fromAgentId = p.fromAgentId;
        e.toAgentId = p.toAgentId;
        e.evidenceJobId = p.evidenceJobId;
        e.weight = p.weight;
        e.endorser = p.fromOwner;
        e.basis = p.basis;
        e.ts = uint64(block.timestamp);
        e.evidenceAmountWei = p.evidenceAmountWei;
        e.capabilityId = p.capabilityId;
        e.capability = capability;
        e.uri = uri;

        edgeOf[p.fromAgentId][p.toAgentId][p.capabilityId] = id;
        _received[p.toAgentId].push(id);
        _given[p.fromAgentId].push(id);
        _add(_summary[p.toAgentId], p.basis, p.weight);
        _add(_capSummary[p.toAgentId][p.capabilityId], p.basis, p.weight);
        _emitEndorsed(id, p, capability, uri);
    }

    /// @dev Its own frame purely so the 10-argument event stays inside the legacy-codegen stack limit.
    function _emitEndorsed(uint256 id, Pending memory p, string calldata capability, string calldata uri) private {
        emit Endorsed(
            id,
            p.fromAgentId,
            p.toAgentId,
            p.capabilityId,
            capability,
            p.basis,
            p.weight,
            p.evidenceJobId,
            p.evidenceAmountWei,
            uri
        );
    }

    function _revoke(uint256 id, Endorsement storage e) internal {
        if (e.revoked) revert AlreadyRevoked(id);
        e.revoked = true;
        uint256 to = e.toAgentId;
        _remove(_summary[to], e.basis, e.weight);
        _remove(_capSummary[to][e.capabilityId], e.basis, e.weight);
        delete edgeOf[e.fromAgentId][to][e.capabilityId];
        emit EndorsementRevoked(id, e.fromAgentId, to, e.weight);
    }

    /// @dev Weight derivation. Evidence is a completed ServiceEscrow job that THIS endorser delivered
    ///      and that a third party paid for; its FMX amount is the base, scaled by the endorser's own
    ///      average rating (prior 3 when unrated) and capped. No evidence → Unbacked, weight 0.
    function _weigh(uint256 fromAgentId, address fromOwner, address toOwner, uint256 evidenceJobId)
        internal
        view
        returns (uint32 weight, Basis basis, uint256 evidenceAmountWei)
    {
        if (evidenceJobId == 0) return (0, Basis.Unbacked, 0);

        ServiceEscrow.Job memory j = escrow.getJob(evidenceJobId);
        if (j.status != ServiceEscrow.JobStatus.Completed) revert EvidenceNotCompleted(j.status);
        if (j.agentId != fromAgentId) revert EvidenceNotOwnWork(j.agentId);
        if (j.amount < minPaidWei || j.amount < WEIGHT_UNIT_WEI) revert EvidenceTooSmall(j.amount, _floor());
        // the payer must be a third party to BOTH sides, or the "paid work" is circular
        if (_related(j.client, fromOwner) || _related(j.client, toOwner)) revert EvidenceNotArmsLength(j.client);

        AgentRegistry.Agent memory a = registry.getAgent(fromAgentId);
        uint256 rating = a.ratingCount == 0 ? RATING_PRIOR : uint256(a.ratingSum) / uint256(a.ratingCount);
        if (rating == 0) rating = 1; // ratings are 1..5; belt and braces

        // whole FMX proven on that one job, then scaled by the rating. The division is deliberately first:
        // sub-FMX remainders must not contribute, so that a spray of dust jobs cannot add up to weight.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 w = (j.amount / WEIGHT_UNIT_WEI) * rating;
        uint256 cap = weightCap;
        if (w > cap) w = cap;
        return (uint32(w), Basis.PaidWork, j.amount);
    }

    function _floor() internal view returns (uint256) {
        return minPaidWei < WEIGHT_UNIT_WEI ? WEIGHT_UNIT_WEI : minPaidWei;
    }

    function _add(Summary storage s, Basis basis, uint32 weight) internal {
        s.total += 1;
        if (basis == Basis.PaidWork) s.backed += 1;
        else s.unbacked += 1;
        s.weight += weight;
    }

    function _remove(Summary storage s, Basis basis, uint32 weight) internal {
        s.total -= 1;
        if (basis == Basis.PaidWork) s.backed -= 1;
        else s.unbacked -= 1;
        s.weight -= weight;
        s.revoked += 1;
    }

    function _page(uint256[] storage list, uint256 offset, uint256 limit) internal view returns (uint256[] memory out) {
        uint256 len = list.length;
        if (offset >= len || limit == 0) return new uint256[](0);
        uint256 n = len - offset;
        if (n > limit) n = limit;
        out = new uint256[](n);
        for (uint256 i; i < n; i++) {
            out[i] = list[offset + i];
        }
    }

    function _ownerOf(uint256 agentId) internal view returns (address o) {
        o = registry.getAgent(agentId).owner;
        if (o == address(0)) revert UnknownAgent(agentId);
    }

    function _authorized(uint256 agentId, address who) internal view returns (bool) {
        address o = _ownerOf(agentId);
        if (who == o) return true;
        return _isAccountOf(who, o);
    }

    /// @dev The arms-length test — see the contract header.
    function _related(address a, address b) internal view returns (bool) {
        if (a == address(0) || b == address(0)) return false;
        if (a == b) return true;
        if (address(accountFactory) == address(0)) return false;
        if (_isAccountOf(a, b)) return true;
        if (_isAccountOf(b, a)) return true;
        // both are AgentAccounts of one owner
        if (a.code.length != 0 && b.code.length != 0 && accountFactory.isAccount(a) && accountFactory.isAccount(b)) {
            return IAccountLike(a).owner() == IAccountLike(b).owner();
        }
        return false;
    }

    function _isAccountOf(address account, address owner) internal view returns (bool) {
        if (address(accountFactory) == address(0) || account.code.length == 0) return false;
        if (!accountFactory.isAccount(account)) return false;
        return IAccountLike(account).owner() == owner;
    }
}
