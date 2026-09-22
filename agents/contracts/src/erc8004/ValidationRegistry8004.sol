// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry8004} from "./IdentityRegistry8004.sol";

/// @title ValidationRegistry8004 — ERC-8004 Validation Registry (reference 2.0.0 signatures)
/// @notice The agent owner (or the validator the owner named in identity metadata key "validator")
///         posts a `validationRequest`; only the named validator answers with `validationResponse`
///         (score 0..100). Used for verifiable delivery: the gateway's Oracle scores a delivered job
///         before the client releases.
/// @dev Paris EVM, dependency-free. Addition over the reference: `validationRequest` is also allowed
///      when msg.sender == validatorAddress == abi.encodePacked(identity.getMetadata(agentId, "validator")),
///      so an agent can delegate request-opening to its validator without ERC-721 approvals (which the
///      identity view does not support).
contract ValidationRegistry8004 {
    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response; // 0..100
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    IdentityRegistry8004 public immutable identityRegistry;

    mapping(bytes32 => ValidationStatus) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash);
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    error ZeroAddress();
    error RequestExists(bytes32 requestHash);
    error NotAuthorized();
    error UnknownRequest(bytes32 requestHash);
    error NotValidator();
    error ResponseOutOfRange();

    constructor(IdentityRegistry8004 identityRegistry_) {
        if (address(identityRegistry_) == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external
    {
        if (validatorAddress == address(0)) revert ZeroAddress();
        if (_validations[requestHash].validatorAddress != address(0)) revert RequestExists(requestHash);
        address owner = identityRegistry.ownerOf(agentId); // reverts for unknown agents
        bool authorized = msg.sender == owner;
        if (!authorized && msg.sender == validatorAddress) {
            bytes memory named = identityRegistry.getMetadata(agentId, "validator");
            authorized = named.length == 20 && address(bytes20(named)) == validatorAddress;
        }
        if (!authorized) revert NotAuthorized();

        ValidationStatus storage s = _validations[requestHash];
        s.validatorAddress = validatorAddress;
        s.agentId = agentId;
        s.lastUpdate = block.timestamp;
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest(requestHash);
        if (msg.sender != s.validatorAddress) revert NotValidator();
        if (response > 100) revert ResponseOutOfRange();
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate)
    {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest(requestHash);
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    function hasResponse(bytes32 requestHash) external view returns (bool) {
        return _validations[requestHash].hasResponse;
    }

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32[] storage hashes = _agentValidations[agentId];
        uint256 total;
        bool filterTag = bytes(tag).length != 0;
        bytes32 tagHash = keccak256(bytes(tag));
        for (uint256 i; i < hashes.length; i++) {
            ValidationStatus storage s = _validations[hashes[i]];
            if (!s.hasResponse) continue;
            bool matchValidator = validatorAddresses.length == 0;
            for (uint256 j; !matchValidator && j < validatorAddresses.length; j++) {
                if (s.validatorAddress == validatorAddresses[j]) matchValidator = true;
            }
            if (!matchValidator) continue;
            if (filterTag && keccak256(bytes(s.tag)) != tagHash) continue;
            total += s.response;
            count++;
        }
        avgResponse = count > 0 ? uint8(total / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function getVersion() external pure returns (string memory) {
        return "ferminux-2.0.0";
    }
}
