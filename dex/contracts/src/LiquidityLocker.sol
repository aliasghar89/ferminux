// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IFerminuxDex.sol";
import {TransferHelper} from "./libraries/TransferHelper.sol";

/**
 * @title LiquidityLocker
 * @notice Time-locks LP tokens and publishes proof of it.
 *
 *         This is a trust primitive, not a yield product. A project that adds
 *         liquidity can pull it out again a minute later ("rug"); locking the
 *         LP tokens here makes that impossible until the unlock date, and the
 *         `locksForToken` view lets any wallet, explorer or third party verify
 *         the claim without trusting the project's word.
 *
 *         The rules, stated once and enforced everywhere:
 *
 *           - a lock's unlock time can be pushed LATER, never earlier — there
 *             is no admin, no owner, no pause and no escape hatch that can
 *             shorten it
 *           - tokens leave only through `withdraw`, only after `unlockAt`, and
 *             only to (or at the direction of) the lock's current owner
 *           - ownership of a lock is transferable, so a locked position can
 *             still be sold or moved to a multisig
 *           - every lock is listed per token AND per owner, forever, including
 *             withdrawn ones — the history cannot be erased
 *
 *         Works with any ERC-20; it is meant for FerminuxPair LP tokens.
 *
 * Self-contained apart from the shared TransferHelper.
 */
contract LiquidityLocker {
    struct Lock {
        uint256 id; // index into the global list, stable forever
        address token; // the LP token (a FerminuxPair) being locked
        address owner; // current owner; may be transferred
        uint256 amount; // units actually received by this contract
        uint64 lockedAt; // block timestamp of creation
        uint64 unlockAt; // withdrawable at or after this timestamp
        bool withdrawn; // one-way flag: a lock pays out exactly once
    }

    Lock[] private _locks;
    mapping(address => uint256[]) private _tokenLocks; // token => lock ids
    mapping(address => uint256[]) private _ownerLocks; // owner => lock ids
    mapping(uint256 => uint256) private _ownerLockIndex; // lock id => index in _ownerLocks[owner]

    uint256 private _unlocked = 1;

    event Locked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockAt);
    event Extended(uint256 indexed id, address indexed token, uint64 oldUnlockAt, uint64 newUnlockAt);
    event Withdrawn(uint256 indexed id, address indexed token, address indexed to, uint256 amount);
    event LockTransferred(uint256 indexed id, address indexed from, address indexed to);

    /// @dev The locker calls out to arbitrary ERC-20s; a malicious token must
    ///      not be able to reenter and touch a half-updated lock.
    modifier nonReentrant() {
        require(_unlocked == 1, "LOCKER: reentrant");
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    modifier onlyLockOwner(uint256 id) {
        require(id < _locks.length, "LOCKER: no such lock");
        require(_locks[id].owner == msg.sender, "LOCKER: not lock owner");
        _;
    }

    // =====================================================================
    //                               WRITE
    // =====================================================================

    /// @notice Lock `amount` of `token` until `unlockAt`.
    /// @dev    The recorded amount is the balance actually received, so a token
    ///         that taxes transfers locks what arrived, never more.
    /// @return id the new lock's permanent id
    function lock(address token, uint256 amount, uint64 unlockAt) external nonReentrant returns (uint256 id) {
        require(token != address(0), "LOCKER: zero token");
        require(amount > 0, "LOCKER: zero amount");
        require(unlockAt > block.timestamp, "LOCKER: unlock in the past");

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        TransferHelper.safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        require(received > 0, "LOCKER: nothing received");

        id = _locks.length;
        _locks.push(
            Lock({
                id: id,
                token: token,
                owner: msg.sender,
                amount: received,
                lockedAt: uint64(block.timestamp),
                unlockAt: unlockAt,
                withdrawn: false
            })
        );
        _tokenLocks[token].push(id);
        _ownerLockIndex[id] = _ownerLocks[msg.sender].length;
        _ownerLocks[msg.sender].push(id);

        emit Locked(id, token, msg.sender, received, unlockAt);
    }

    /// @notice Push a lock's unlock time further out. Strictly one-way.
    function extend(uint256 id, uint64 newUnlockAt) external onlyLockOwner(id) {
        Lock storage l = _locks[id];
        require(!l.withdrawn, "LOCKER: already withdrawn");
        require(newUnlockAt > l.unlockAt, "LOCKER: cannot shorten");

        uint64 oldUnlockAt = l.unlockAt;
        l.unlockAt = newUnlockAt;
        emit Extended(id, l.token, oldUnlockAt, newUnlockAt);
    }

    /// @notice Withdraw a matured lock in full to `to`.
    function withdraw(uint256 id, address to) external nonReentrant onlyLockOwner(id) {
        require(to != address(0), "LOCKER: zero recipient");
        Lock storage l = _locks[id];
        require(!l.withdrawn, "LOCKER: already withdrawn");
        require(block.timestamp >= l.unlockAt, "LOCKER: still locked");

        l.withdrawn = true; // effect before interaction
        uint256 amount = l.amount;
        TransferHelper.safeTransfer(l.token, to, amount);
        emit Withdrawn(id, l.token, to, amount);
    }

    /// @notice Hand a lock (and the right to withdraw it later) to `newOwner`.
    function transferLock(uint256 id, address newOwner) external onlyLockOwner(id) {
        require(newOwner != address(0), "LOCKER: zero owner");
        Lock storage l = _locks[id];
        require(newOwner != l.owner, "LOCKER: same owner");
        require(!l.withdrawn, "LOCKER: already withdrawn");

        address oldOwner = l.owner;

        // Remove `id` from the old owner's list: swap-and-pop, keeping the
        // index map of the moved element in sync.
        uint256[] storage from = _ownerLocks[oldOwner];
        uint256 idx = _ownerLockIndex[id];
        uint256 lastIdx = from.length - 1;
        if (idx != lastIdx) {
            uint256 movedId = from[lastIdx];
            from[idx] = movedId;
            _ownerLockIndex[movedId] = idx;
        }
        from.pop();

        l.owner = newOwner;
        _ownerLockIndex[id] = _ownerLocks[newOwner].length;
        _ownerLocks[newOwner].push(id);

        emit LockTransferred(id, oldOwner, newOwner);
    }

    // =====================================================================
    //                               VIEWS
    // =====================================================================

    function lockCount() external view returns (uint256) {
        return _locks.length;
    }

    function getLock(uint256 id) external view returns (Lock memory) {
        require(id < _locks.length, "LOCKER: no such lock");
        return _locks[id];
    }

    /// @notice True once the lock has matured (and is still unwithdrawn).
    function isWithdrawable(uint256 id) external view returns (bool) {
        require(id < _locks.length, "LOCKER: no such lock");
        Lock storage l = _locks[id];
        return !l.withdrawn && block.timestamp >= l.unlockAt;
    }

    /// @notice EVERY lock ever created for `token`, withdrawn ones included.
    ///         This is the proof-of-lock view a UI or explorer renders.
    function locksForToken(address token) external view returns (Lock[] memory list) {
        uint256[] storage ids = _tokenLocks[token];
        list = new Lock[](ids.length);
        for (uint256 i; i < ids.length; i++) {
            list[i] = _locks[ids[i]];
        }
    }

    function lockCountForToken(address token) external view returns (uint256) {
        return _tokenLocks[token].length;
    }

    /// @notice Paginated version of `locksForToken` for pairs with many locks.
    function locksForTokenPage(address token, uint256 offset, uint256 limit)
        external
        view
        returns (Lock[] memory page)
    {
        uint256[] storage ids = _tokenLocks[token];
        uint256 n = ids.length;
        if (offset >= n) return new Lock[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        page = new Lock[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _locks[ids[i]];
        }
    }

    function locksForOwner(address owner) external view returns (Lock[] memory list) {
        uint256[] storage ids = _ownerLocks[owner];
        list = new Lock[](ids.length);
        for (uint256 i; i < ids.length; i++) {
            list[i] = _locks[ids[i]];
        }
    }

    function lockIdsForToken(address token) external view returns (uint256[] memory) {
        return _tokenLocks[token];
    }

    function lockIdsForOwner(address owner) external view returns (uint256[] memory) {
        return _ownerLocks[owner];
    }

    /// @notice Total units of `token` this contract still holds under lock
    ///         (matured but unwithdrawn included).
    function totalLockedForToken(address token) external view returns (uint256 total) {
        uint256[] storage ids = _tokenLocks[token];
        for (uint256 i; i < ids.length; i++) {
            Lock storage l = _locks[ids[i]];
            if (!l.withdrawn) total += l.amount;
        }
    }

    /// @notice Total units of `token` that are STILL time-locked at
    ///         `timestamp` — the honest "is the liquidity locked right now?"
    ///         number, since it excludes locks that have already matured.
    function totalLockedForTokenAt(address token, uint64 timestamp) external view returns (uint256 total) {
        uint256[] storage ids = _tokenLocks[token];
        for (uint256 i; i < ids.length; i++) {
            Lock storage l = _locks[ids[i]];
            if (!l.withdrawn && l.unlockAt > timestamp) total += l.amount;
        }
    }
}
