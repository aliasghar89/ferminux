// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Sig} from "./lib/Sig.sol";

/// @title AgentAccount — policy wallet for an AI agent (Addendum v3, C2)
/// @notice One implementation, many EIP-1167 clones (see AgentAccountFactory). The owner (human EOA or
///         multisig) adds **session keys** with a daily spend cap and an optional target allowlist; the
///         agent runtime signs with a session key; anyone may relay via `executeWithSig` (gasless).
///         ERC-1271 so X402Vault vouchers and Commons messages can be signed by the account.
/// @dev Paris EVM (no PUSH0). The clone's storage starts at slot 0 here; the implementation itself is
///      bricked in its constructor (owner = address(1)) so it can never be initialised.
///      Policy: the daily cap counts msg value only; `dayStart` rolls forward to "now" when a day has
///      elapsed since the previous roll. Calls that fail revert (bubbling the target's revert data) so
///      the `Executed` event always carries ok = true — an unsuccessful relay consumes no nonce.
///      Signature domain: {name:"FerminuxAgentAccount", version:"1", chainId, verifyingContract:clone}.
contract AgentAccount {
    // ───────────────────────────── types ─────────────────────────────

    struct Session {
        uint256 capPerDay;
        uint256 spentToday;
        uint64 dayStart;
        uint64 expiry; // key valid while block.timestamp < expiry
        bool anyTarget;
    }

    // ───────────────────────────── constants ─────────────────────────────

    string public constant NAME = "FerminuxAgentAccount";
    string public constant VERSION = "1";
    bytes32 public constant EXECUTE_TYPEHASH =
        keccak256("Execute(address to,uint256 value,bytes32 dataHash,uint256 nonce,uint64 deadline)");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    // ───────────────────────────── storage ─────────────────────────────

    address public owner;
    uint256 public nonce;
    mapping(address => Session) public sessions;
    mapping(address => mapping(address => bool)) public allowedTarget; // key => target
    mapping(address => address[]) private _targets; // key => targets (to clear on revoke / re-add)
    uint256 private _lock;

    // ───────────────────────────── events ─────────────────────────────

    event Initialized(address indexed owner);
    event SessionAdded(address indexed key, uint256 capPerDay, uint64 expiry);
    event SessionRevoked(address indexed key);
    event Executed(address indexed by, address indexed to, uint256 value, bool ok);
    event OwnershipTransferred(address indexed previous, address indexed current);
    event Received(address indexed from, uint256 amount);

    // ───────────────────────────── errors ─────────────────────────────

    error AlreadyInitialized();
    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error SessionExpired();
    error TargetNotAllowed(address target);
    error CapExceeded(uint256 requested, uint256 remaining);
    error Expired(uint64 deadline);
    error BadSignature();
    error LengthMismatch();
    error CallFailed();
    error Reentrancy();

    // ───────────────────────────── modifiers ─────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    // ───────────────────────────── constructor / init ─────────────────────────────

    /// @dev Bricks the implementation; clones do not run this.
    constructor() {
        owner = address(1);
    }

    function initialize(address owner_) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit Initialized(owner_);
        emit OwnershipTransferred(address(0), owner_);
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ───────────────────────────── sessions ─────────────────────────────

    /// @notice Add (or replace) a session key. Empty `targets` = any target.
    function addSession(address key, uint256 capPerDay, uint64 expiry, address[] calldata targets)
        external
        onlyOwner
    {
        if (key == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp) revert SessionExpired();
        _clearTargets(key);
        Session storage s = sessions[key];
        s.capPerDay = capPerDay;
        s.spentToday = 0;
        s.dayStart = uint64(block.timestamp);
        s.expiry = expiry;
        s.anyTarget = targets.length == 0;
        for (uint256 i = 0; i < targets.length; i++) {
            allowedTarget[key][targets[i]] = true;
            _targets[key].push(targets[i]);
        }
        emit SessionAdded(key, capPerDay, expiry);
    }

    function revokeSession(address key) external onlyOwner {
        _clearTargets(key);
        delete sessions[key];
        emit SessionRevoked(key);
    }

    function sessionTargets(address key) external view returns (address[] memory) {
        return _targets[key];
    }

    /// @notice True when `key` is the owner or an unexpired session key.
    function isSigner(address key) public view returns (bool) {
        if (key == owner) return true;
        Session storage s = sessions[key];
        return s.expiry != 0 && block.timestamp < s.expiry;
    }

    // ───────────────────────────── execution ─────────────────────────────

    /// @notice Call `to` with `value` and `data`. Owner OR valid session key (allowlist + daily cap on value).
    function execute(address to, uint256 value, bytes calldata data) external nonReentrant returns (bytes memory) {
        _authorize(msg.sender, to, value);
        return _call(msg.sender, to, value, data);
    }

    function executeBatch(address[] calldata to, uint256[] calldata value, bytes[] calldata data)
        external
        nonReentrant
    {
        if (to.length != value.length || to.length != data.length) revert LengthMismatch();
        for (uint256 i = 0; i < to.length; i++) {
            _authorize(msg.sender, to[i], value[i]);
            _call(msg.sender, to[i], value[i], data[i]);
        }
    }

    /// @notice Relayed execution: `sig` is EIP-712 over (to, value, keccak(data), nonce, deadline) by the
    ///         owner (EOA or ERC-1271 contract) or a session key. Same policy checks. Relayer pays gas.
    function executeWithSig(address to, uint256 value, bytes calldata data, uint64 deadline, bytes calldata sig)
        external
        nonReentrant
        returns (bytes memory)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        bytes32 digest = hashExecute(to, value, keccak256(data), nonce, deadline);
        address signer = _signerOf(digest, sig);
        if (signer == address(0)) revert BadSignature();
        nonce += 1;
        _authorize(signer, to, value);
        return _call(signer, to, value, data);
    }

    function hashExecute(address to, uint256 value, bytes32 dataHash, uint256 nonce_, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return Sig.typedDataHash(
            DOMAIN_SEPARATOR(), keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, dataHash, nonce_, deadline))
        );
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return Sig.domainSeparator(NAME, VERSION, address(this));
    }

    // ───────────────────────────── ERC-1271 ─────────────────────────────

    /// @notice Valid when signed by the owner (EOA or ERC-1271 contract) or an unexpired session key.
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return _signerOf(hash, sig) != address(0) ? ERC1271_MAGIC : bytes4(0xffffffff);
    }

    // ───────────────────────────── ownership ─────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Returns the authorised signer of `digest` (owner or session key), or address(0).
    function _signerOf(bytes32 digest, bytes calldata sig) internal view returns (address) {
        address rec = Sig.recover(digest, sig);
        if (rec != address(0) && isSigner(rec)) return rec;
        // owner may be a contract wallet (multisig) — ask it via ERC-1271
        if (owner.code.length != 0 && Sig.isValid(owner, digest, sig)) return owner;
        return address(0);
    }

    function _authorize(address by, address to, uint256 value) internal {
        if (by == owner) return;
        Session storage s = sessions[by];
        if (s.expiry == 0 || block.timestamp >= s.expiry) revert NotAuthorized();
        if (!s.anyTarget && !allowedTarget[by][to]) revert TargetNotAllowed(to);
        if (value != 0) {
            if (block.timestamp >= s.dayStart + 1 days) {
                s.dayStart = uint64(block.timestamp);
                s.spentToday = 0;
            }
            uint256 remaining = s.capPerDay > s.spentToday ? s.capPerDay - s.spentToday : 0;
            if (value > remaining) revert CapExceeded(value, remaining);
            s.spentToday += value;
        }
    }

    function _call(address by, address to, uint256 value, bytes calldata data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) {
            if (ret.length == 0) revert CallFailed();
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit Executed(by, to, value, true);
    }

    function _clearTargets(address key) internal {
        address[] storage ts = _targets[key];
        for (uint256 i = 0; i < ts.length; i++) {
            delete allowedTarget[key][ts[i]];
        }
        delete _targets[key];
    }
}
