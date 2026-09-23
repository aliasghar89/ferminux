// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "../AgentRegistry.sol";

/// @title IdentityRegistry8004 — FRC-8004 Identity Registry as an FRC-721 VIEW over AgentRegistry
/// @notice tokenId = agentId; ownerOf(id) = AgentRegistry.getAgent(id).owner. Registration happens in
///         `AgentRegistry.register` (the `register()` overloads here revert) and transfers happen through
///         `AgentRegistry.transferOwnership` (FRC-721 transfers/approvals here revert).
///         Function names/signatures follow erc-8004/erc-8004-contracts (IdentityRegistryUpgradeable 2.0.0).
/// @dev Paris EVM, dependency-free. `agentWallet` = the AgentRegistry owner (not settable — use
///      AgentRegistry.transferOwnership). `balanceOf` iterates the registry (view only, O(nextId)).
contract IdentityRegistry8004 {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    string public constant name = "AgentIdentity";
    string public constant symbol = "AGENT";
    string public constant DEFAULT_URI_PREFIX = "https://ferminux.net/api/agents/";
    string public constant DEFAULT_URI_SUFFIX = "/erc8004.json";
    bytes32 private constant RESERVED_AGENT_WALLET_KEY_HASH = keccak256("agentWallet");

    AgentRegistry public immutable registry;

    mapping(uint256 => string) private _agentURI; // "" = default
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    // FRC-721
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    // FRC-8004
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    error ZeroAddress();
    error NonexistentAgent(uint256 agentId);
    error NotAuthorized();
    error ReservedKey();
    error RegistrationViaAgentRegistry(); // use AgentRegistry.register
    error UseAgentRegistryTransferOwnership(); // use AgentRegistry.transferOwnership
    error AgentWalletIsRegistryOwner(); // agentWallet == AgentRegistry owner, not settable here

    constructor(AgentRegistry registry_) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        registry = registry_;
    }

    // ───────────────────────────── ERC-165 ─────────────────────────────

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; // 165, 721, 721Metadata
    }

    // ───────────────────────────── FRC-721 views ─────────────────────────────

    function ownerOf(uint256 tokenId) public view returns (address) {
        AgentRegistry.Agent memory a = registry.getAgent(tokenId);
        if (a.status == AgentRegistry.Status.None) revert NonexistentAgent(tokenId);
        return a.owner;
    }

    /// @dev O(nextId) scan of the registry — intended for eth_call only.
    function balanceOf(address owner) external view returns (uint256 count) {
        if (owner == address(0)) revert ZeroAddress();
        uint256 n = registry.nextId();
        for (uint256 id = 1; id <= n; id++) {
            AgentRegistry.Agent memory a = registry.getAgent(id);
            if (a.status != AgentRegistry.Status.None && a.owner == owner) count++;
        }
    }

    function totalSupply() external view returns (uint256) {
        return registry.nextId();
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return agentURI(tokenId);
    }

    function agentURI(uint256 agentId) public view returns (string memory) {
        ownerOf(agentId); // existence check
        string memory u = _agentURI[agentId];
        if (bytes(u).length != 0) return u;
        return string.concat(DEFAULT_URI_PREFIX, _toString(agentId), DEFAULT_URI_SUFFIX);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    // ───────────────────────────── FRC-721 writes (disabled) ─────────────────────────────

    function approve(address, uint256) external pure {
        revert UseAgentRegistryTransferOwnership();
    }

    function setApprovalForAll(address, bool) external pure {
        revert UseAgentRegistryTransferOwnership();
    }

    function transferFrom(address, address, uint256) external pure {
        revert UseAgentRegistryTransferOwnership();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert UseAgentRegistryTransferOwnership();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert UseAgentRegistryTransferOwnership();
    }

    // ───────────────────────────── FRC-8004 ─────────────────────────────

    function register() external pure returns (uint256) {
        revert RegistrationViaAgentRegistry();
    }

    function register(string memory) external pure returns (uint256) {
        revert RegistrationViaAgentRegistry();
    }

    function register(string memory, MetadataEntry[] memory) external pure returns (uint256) {
        revert RegistrationViaAgentRegistry();
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        if (msg.sender != ownerOf(agentId)) revert NotAuthorized();
        _agentURI[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        if (keccak256(bytes(metadataKey)) == RESERVED_AGENT_WALLET_KEY_HASH) {
            AgentRegistry.Agent memory a = registry.getAgent(agentId);
            if (a.status == AgentRegistry.Status.None) return "";
            return abi.encodePacked(a.owner);
        }
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        if (msg.sender != ownerOf(agentId)) revert NotAuthorized();
        if (keccak256(bytes(metadataKey)) == RESERVED_AGENT_WALLET_KEY_HASH) revert ReservedKey();
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return ownerOf(agentId);
    }

    function setAgentWallet(uint256, address, uint256, bytes calldata) external pure {
        revert AgentWalletIsRegistryOwner();
    }

    function unsetAgentWallet(uint256) external pure {
        revert AgentWalletIsRegistryOwner();
    }

    /// @notice Reference-compatible: reverts for a nonexistent agent; approvals are unsupported so
    ///         only the owner is authorised.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return spender == ownerOf(agentId);
    }

    function getVersion() external pure returns (string memory) {
        return "ferminux-2.0.0";
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v;
        uint256 d;
        while (t != 0) {
            d++;
            t /= 10;
        }
        bytes memory b = new bytes(d);
        while (v != 0) {
            d--;
            b[d] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(b);
    }
}
