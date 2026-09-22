// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry8004} from "./IdentityRegistry8004.sol";
import {ServiceEscrow} from "../ServiceEscrow.sol";

/// @title ReputationRegistry8004 — ERC-8004 Reputation Registry (reference 2.0.0 signatures)
/// @notice Any address except the agent owner may `giveFeedback`; `syncFromEscrow(jobId)` (anyone) imports
///         a finished ServiceEscrow job once, as feedback from `job.client` with tag1 = "escrow".
/// @dev Paris EVM, dependency-free. Deviation from the addendum text: the deployed ServiceEscrow does not
///      persist the 1..5 rating in its Job struct (it is only in the JobCompleted event), so the sync
///      imports the OUTCOME instead: Completed → value 1, Refunded → value 0 (decimals 0, tag2 =
///      "completed" | "refunded"). Resolved jobs are not syncable (their split is not stored either).
contract ReputationRegistry8004 {
    int128 private constant MAX_ABS_VALUE = 1e38;

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        string tag1;
        string tag2;
    }

    IdentityRegistry8004 public immutable identityRegistry;
    ServiceEscrow public immutable escrow;

    // agentId => client => index (1-based) => Feedback
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;
    mapping(uint256 => mapping(address => mapping(uint64 => mapping(address => uint64)))) private _responseCount;
    mapping(uint256 => mapping(address => mapping(uint64 => address[]))) private _responders;
    mapping(uint256 => mapping(address => mapping(uint64 => mapping(address => bool)))) private _responderExists;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _clientExists;
    mapping(uint256 => bool) public syncedJob; // jobId => imported

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );
    event EscrowSynced(uint256 indexed jobId, uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value);

    error ZeroAddress();
    error TooManyDecimals();
    error ValueTooLarge();
    error SelfFeedback();
    error IndexOutOfBounds();
    error AlreadyRevoked();
    error EmptyURI();
    error ClientAddressesRequired();
    error AlreadySynced(uint256 jobId);
    error JobNotSyncable(ServiceEscrow.JobStatus status);

    constructor(IdentityRegistry8004 identityRegistry_, ServiceEscrow escrow_) {
        if (address(identityRegistry_) == address(0) || address(escrow_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        escrow = escrow_;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    // ───────────────────────────── writes ─────────────────────────────

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        string memory endpoint,
        string memory feedbackURI,
        bytes32 feedbackHash
    ) external {
        // memory (not calldata) strings keep the 11-arg event under the legacy-codegen stack limit
        if (valueDecimals > 18) revert TooManyDecimals();
        if (value < -MAX_ABS_VALUE || value > MAX_ABS_VALUE) revert ValueTooLarge();
        // reverts NonexistentAgent for unknown ids; owner may not rate itself
        if (identityRegistry.isAuthorizedOrOwner(msg.sender, agentId)) revert SelfFeedback();
        uint64 idx = _store(agentId, msg.sender, value, valueDecimals, tag1, tag2);
        emit NewFeedback(agentId, msg.sender, idx, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    /// @notice Import a finished escrow job as feedback from its client (once per job). Anyone may call.
    function syncFromEscrow(uint256 jobId) external returns (uint64 feedbackIndex) {
        if (syncedJob[jobId]) revert AlreadySynced(jobId);
        ServiceEscrow.Job memory j = escrow.getJob(jobId);
        int128 value;
        string memory tag2;
        if (j.status == ServiceEscrow.JobStatus.Completed) {
            value = 1;
            tag2 = "completed";
        } else if (j.status == ServiceEscrow.JobStatus.Refunded) {
            value = 0;
            tag2 = "refunded";
        } else {
            revert JobNotSyncable(j.status);
        }
        syncedJob[jobId] = true;
        feedbackIndex = _store(j.agentId, j.client, value, 0, "escrow", tag2);
        emit NewFeedback(j.agentId, j.client, feedbackIndex, value, 0, "escrow", "escrow", tag2, "", j.outputURI, j.outputHash);
        emit EscrowSynced(jobId, j.agentId, j.client, feedbackIndex, value);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][msg.sender]) revert IndexOutOfBounds();
        Feedback storage f = _feedback[agentId][msg.sender][feedbackIndex];
        if (f.isRevoked) revert AlreadyRevoked();
        f.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        if (bytes(responseURI).length == 0) revert EmptyURI();
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert IndexOutOfBounds();
        if (!_responderExists[agentId][clientAddress][feedbackIndex][msg.sender]) {
            _responders[agentId][clientAddress][feedbackIndex].push(msg.sender);
            _responderExists[agentId][clientAddress][feedbackIndex][msg.sender] = true;
        }
        _responseCount[agentId][clientAddress][feedbackIndex][msg.sender]++;
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    // ───────────────────────────── reads ─────────────────────────────

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _lastIndex[agentId][clientAddress];
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert IndexOutOfBounds();
        Feedback storage f = _feedback[agentId][clientAddress][feedbackIndex];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    struct Filter {
        bool f1;
        bytes32 t1;
        bool f2;
        bytes32 t2;
    }

    struct Acc {
        int256 sum;
        uint64 count;
        uint64[19] decimalCounts;
    }

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string memory tag1, string memory tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        if (clientAddresses.length == 0) revert ClientAddressesRequired();
        Filter memory f = _filter(tag1, tag2);
        Acc memory acc;
        for (uint256 i; i < clientAddresses.length; i++) {
            _sumClient(agentId, clientAddresses[i], f, acc);
        }
        count = acc.count;
        if (count == 0) return (0, 0, 0);
        uint8 modeDecimals;
        uint64 maxCount;
        for (uint8 d; d <= 18; d++) {
            if (acc.decimalCounts[d] > maxCount) {
                maxCount = acc.decimalCounts[d];
                modeDecimals = d;
            }
        }
        int256 avgWad = acc.sum / int256(uint256(count));
        summaryValue = int128(avgWad / int256(10 ** uint256(18 - modeDecimals)));
        summaryValueDecimals = modeDecimals;
    }

    function _sumClient(uint256 agentId, address client, Filter memory f, Acc memory acc) internal view {
        uint64 last = _lastIndex[agentId][client];
        for (uint64 j = 1; j <= last; j++) {
            Feedback storage fb = _feedback[agentId][client][j];
            if (!_matches(fb, false, f)) continue;
            acc.sum += int256(fb.value) * int256(10 ** uint256(18 - fb.valueDecimals));
            acc.decimalCounts[fb.valueDecimals]++;
            acc.count++;
        }
    }

    function _filter(string memory tag1, string memory tag2) internal pure returns (Filter memory f) {
        f.f1 = bytes(tag1).length != 0;
        f.t1 = keccak256(bytes(tag1));
        f.f2 = bytes(tag2).length != 0;
        f.t2 = keccak256(bytes(tag2));
    }

    struct All {
        address[] clients;
        uint64[] feedbackIndexes;
        int128[] values;
        uint8[] valueDecimals;
        string[] tag1s;
        string[] tag2s;
        bool[] revokedStatuses;
    }

    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string memory tag1,
        string memory tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        )
    {
        All memory r = _collect(agentId, clientAddresses, _filter(tag1, tag2), includeRevoked);
        return (r.clients, r.feedbackIndexes, r.values, r.valueDecimals, r.tag1s, r.tag2s, r.revokedStatuses);
    }

    function _collect(uint256 agentId, address[] calldata clientAddresses, Filter memory f, bool includeRevoked)
        internal
        view
        returns (All memory r)
    {
        address[] memory list;
        if (clientAddresses.length != 0) list = clientAddresses;
        else list = _clients[agentId];
        uint256 total = _countMatching(agentId, list, includeRevoked, f);
        r.clients = new address[](total);
        r.feedbackIndexes = new uint64[](total);
        r.values = new int128[](total);
        r.valueDecimals = new uint8[](total);
        r.tag1s = new string[](total);
        r.tag2s = new string[](total);
        r.revokedStatuses = new bool[](total);
        _fill(agentId, list, includeRevoked, f, r);
    }

    function _fill(uint256 agentId, address[] memory list, bool includeRevoked, Filter memory f, All memory r)
        internal
        view
    {
        uint256 k;
        for (uint256 i; i < list.length; i++) {
            uint64 last = _lastIndex[agentId][list[i]];
            for (uint64 j = 1; j <= last; j++) {
                Feedback storage fb = _feedback[agentId][list[i]][j];
                if (!_matches(fb, includeRevoked, f)) continue;
                r.clients[k] = list[i];
                r.feedbackIndexes[k] = j;
                r.values[k] = fb.value;
                r.valueDecimals[k] = fb.valueDecimals;
                r.tag1s[k] = fb.tag1;
                r.tag2s[k] = fb.tag2;
                r.revokedStatuses[k] = fb.isRevoked;
                k++;
            }
        }
    }

    function _countMatching(uint256 agentId, address[] memory list, bool includeRevoked, Filter memory f)
        internal
        view
        returns (uint256 total)
    {
        for (uint256 i; i < list.length; i++) {
            uint64 last = _lastIndex[agentId][list[i]];
            for (uint64 j = 1; j <= last; j++) {
                if (_matches(_feedback[agentId][list[i]][j], includeRevoked, f)) total++;
            }
        }
    }

    function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] calldata responders)
        external
        view
        returns (uint64 count)
    {
        if (clientAddress == address(0)) {
            address[] memory cs = _clients[agentId];
            for (uint256 i; i < cs.length; i++) {
                uint64 last = _lastIndex[agentId][cs[i]];
                for (uint64 j = 1; j <= last; j++) {
                    count += _countResponses(agentId, cs[i], j, responders);
                }
            }
        } else if (feedbackIndex == 0) {
            uint64 last = _lastIndex[agentId][clientAddress];
            for (uint64 j = 1; j <= last; j++) {
                count += _countResponses(agentId, clientAddress, j, responders);
            }
        } else {
            count = _countResponses(agentId, clientAddress, feedbackIndex, responders);
        }
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getVersion() external pure returns (string memory) {
        return "ferminux-2.0.0";
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _store(uint256 agentId, address client, int128 value, uint8 decimals, string memory tag1, string memory tag2)
        internal
        returns (uint64 idx)
    {
        idx = ++_lastIndex[agentId][client];
        Feedback storage f = _feedback[agentId][client][idx];
        f.value = value;
        f.valueDecimals = decimals;
        f.tag1 = tag1;
        f.tag2 = tag2;
        if (!_clientExists[agentId][client]) {
            _clients[agentId].push(client);
            _clientExists[agentId][client] = true;
        }
    }

    function _matches(Feedback storage fb, bool includeRevoked, Filter memory f) internal view returns (bool) {
        if (!includeRevoked && fb.isRevoked) return false;
        if (f.f1 && f.t1 != keccak256(bytes(fb.tag1))) return false;
        if (f.f2 && f.t2 != keccak256(bytes(fb.tag2))) return false;
        return true;
    }

    function _countResponses(uint256 agentId, address client, uint64 idx, address[] calldata responders)
        internal
        view
        returns (uint64 count)
    {
        if (responders.length == 0) {
            address[] storage all = _responders[agentId][client][idx];
            for (uint256 k; k < all.length; k++) {
                count += _responseCount[agentId][client][idx][all[k]];
            }
        } else {
            for (uint256 k; k < responders.length; k++) {
                count += _responseCount[agentId][client][idx][responders[k]];
            }
        }
    }
}
