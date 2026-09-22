// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxPair} from "../src/FerminuxPair.sol";
import {MockERC20, FeeOnTransferERC20, CallbackERC20} from "./mocks/Mocks.sol";

contract LiquidityLockerTest is Test {
    LiquidityLocker internal locker;
    FerminuxFactory internal factory;
    FerminuxPair internal pair;
    MockERC20 internal tka;
    MockERC20 internal tkb;

    address internal project = makeAddr("project");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    uint64 internal unlockAt;

    event Locked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockAt);
    event Extended(uint256 indexed id, address indexed token, uint64 oldUnlockAt, uint64 newUnlockAt);
    event Withdrawn(uint256 indexed id, address indexed token, address indexed to, uint256 amount);
    event LockTransferred(uint256 indexed id, address indexed from, address indexed to);

    function setUp() public {
        vm.warp(1_700_000_000);
        unlockAt = uint64(block.timestamp + 365 days);

        locker = new LiquidityLocker();
        factory = new FerminuxFactory(address(this));
        tka = new MockERC20("Token A", "TKA", 18);
        tkb = new MockERC20("Token B", "TKB", 18);
        pair = FerminuxPair(factory.createPair(address(tka), address(tkb)));

        // give `project` a real LP position to lock
        tka.mint(address(pair), 1_000e18);
        tkb.mint(address(pair), 1_000e18);
        pair.mint(project);

        vm.prank(project);
        pair.approve(address(locker), type(uint256).max);
    }

    function _lockAll() internal returns (uint256 id, uint256 amount) {
        amount = pair.balanceOf(project);
        vm.prank(project);
        id = locker.lock(address(pair), amount, unlockAt);
    }

    function _lockSome(uint256 amount, uint64 until) internal returns (uint256 id) {
        vm.prank(project);
        id = locker.lock(address(pair), amount, until);
    }

    // =====================================================================
    //                                LOCK
    // =====================================================================

    function test_Lock_TransfersInAndRecords() public {
        uint256 amount = pair.balanceOf(project);

        vm.expectEmit(true, true, true, true, address(locker));
        emit Locked(0, address(pair), project, amount, unlockAt);
        (uint256 id,) = _lockAll();

        assertEq(id, 0);
        assertEq(pair.balanceOf(project), 0);
        assertEq(pair.balanceOf(address(locker)), amount);

        LiquidityLocker.Lock memory l = locker.getLock(id);
        assertEq(l.id, 0);
        assertEq(l.token, address(pair));
        assertEq(l.owner, project);
        assertEq(l.amount, amount);
        assertEq(l.lockedAt, uint64(block.timestamp));
        assertEq(l.unlockAt, unlockAt);
        assertFalse(l.withdrawn);
        assertEq(locker.lockCount(), 1);
    }

    function test_Lock_ValidatesInputs() public {
        vm.startPrank(project);
        vm.expectRevert(bytes("LOCKER: zero token"));
        locker.lock(address(0), 1e18, unlockAt);

        vm.expectRevert(bytes("LOCKER: zero amount"));
        locker.lock(address(pair), 0, unlockAt);

        vm.expectRevert(bytes("LOCKER: unlock in the past"));
        locker.lock(address(pair), 1e18, uint64(block.timestamp));

        vm.expectRevert(bytes("LOCKER: unlock in the past"));
        locker.lock(address(pair), 1e18, uint64(block.timestamp - 1));
        vm.stopPrank();
    }

    function test_Lock_RequiresAllowance() public {
        vm.prank(project);
        pair.approve(address(locker), 0);
        vm.prank(project);
        vm.expectRevert(bytes("TH: transferFrom failed"));
        locker.lock(address(pair), 1e18, unlockAt);
    }

    function test_Lock_MultipleLocksPerOwnerAndToken() public {
        uint256 id0 = _lockSome(10e18, unlockAt);
        uint256 id1 = _lockSome(20e18, unlockAt + 30 days);
        uint256 id2 = _lockSome(30e18, unlockAt + 60 days);

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(locker.lockCountForToken(address(pair)), 3);
        assertEq(locker.totalLockedForToken(address(pair)), 60e18);

        uint256[] memory ids = locker.lockIdsForOwner(project);
        assertEq(ids.length, 3);
        assertEq(ids[0], 0);
        assertEq(ids[2], 2);
    }

    function test_Lock_RecordsAmountActuallyReceived() public {
        FeeOnTransferERC20 taxed = new FeeOnTransferERC20(500); // 5%
        taxed.mint(project, 100e18);
        vm.startPrank(project);
        taxed.approve(address(locker), type(uint256).max);
        uint256 id = locker.lock(address(taxed), 100e18, unlockAt);
        vm.stopPrank();

        LiquidityLocker.Lock memory l = locker.getLock(id);
        assertEq(l.amount, 95e18, "records what arrived, not what was asked for");
        assertEq(taxed.balanceOf(address(locker)), 95e18);
    }

    // =====================================================================
    //                               EXTEND
    // =====================================================================

    function test_Extend_PushesUnlockLater() public {
        (uint256 id,) = _lockAll();
        uint64 later = unlockAt + 90 days;

        vm.prank(project);
        vm.expectEmit(true, true, false, true, address(locker));
        emit Extended(id, address(pair), unlockAt, later);
        locker.extend(id, later);

        assertEq(locker.getLock(id).unlockAt, later);
    }

    function test_Extend_CannotShorten() public {
        (uint256 id,) = _lockAll();

        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: cannot shorten"));
        locker.extend(id, unlockAt - 1);

        // not even by zero seconds — the check is strict
        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: cannot shorten"));
        locker.extend(id, unlockAt);

        // and not to a past timestamp
        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: cannot shorten"));
        locker.extend(id, uint64(block.timestamp));

        assertEq(locker.getLock(id).unlockAt, unlockAt, "unchanged");
    }

    function test_Extend_OnlyOwner() public {
        (uint256 id,) = _lockAll();
        vm.prank(stranger);
        vm.expectRevert(bytes("LOCKER: not lock owner"));
        locker.extend(id, unlockAt + 1);
    }

    function test_Extend_RevertsForUnknownLock() public {
        vm.expectRevert(bytes("LOCKER: no such lock"));
        locker.extend(0, unlockAt + 1);
    }

    function test_Extend_RevertsAfterWithdrawal() public {
        (uint256 id,) = _lockAll();
        vm.warp(unlockAt);
        vm.prank(project);
        locker.withdraw(id, project);

        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: already withdrawn"));
        locker.extend(id, unlockAt + 1000);
    }

    function test_Extend_WorksAfterExpiry() public {
        (uint256 id,) = _lockAll();
        vm.warp(unlockAt + 1);
        uint64 relock = uint64(block.timestamp + 30 days);
        vm.prank(project);
        locker.extend(id, relock);
        assertEq(locker.getLock(id).unlockAt, relock);
        assertFalse(locker.isWithdrawable(id), "re-locked");
    }

    // =====================================================================
    //                              WITHDRAW
    // =====================================================================

    function test_Withdraw_OnlyAfterExpiry() public {
        (uint256 id, uint256 amount) = _lockAll();

        vm.warp(unlockAt - 1);
        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: still locked"));
        locker.withdraw(id, project);
        assertFalse(locker.isWithdrawable(id));

        vm.warp(unlockAt); // exactly at the boundary is allowed
        assertTrue(locker.isWithdrawable(id));
        vm.prank(project);
        vm.expectEmit(true, true, true, true, address(locker));
        emit Withdrawn(id, address(pair), project, amount);
        locker.withdraw(id, project);

        assertEq(pair.balanceOf(project), amount);
        assertEq(pair.balanceOf(address(locker)), 0);
        assertTrue(locker.getLock(id).withdrawn);
        assertFalse(locker.isWithdrawable(id), "already paid out");
    }

    function test_Withdraw_OnlyOwner() public {
        (uint256 id,) = _lockAll();
        vm.warp(unlockAt);
        vm.prank(stranger);
        vm.expectRevert(bytes("LOCKER: not lock owner"));
        locker.withdraw(id, stranger);
    }

    function test_Withdraw_CannotBeRepeated() public {
        (uint256 id,) = _lockAll();
        vm.warp(unlockAt);
        vm.startPrank(project);
        locker.withdraw(id, project);
        vm.expectRevert(bytes("LOCKER: already withdrawn"));
        locker.withdraw(id, project);
        vm.stopPrank();
    }

    function test_Withdraw_RejectsZeroRecipient() public {
        (uint256 id,) = _lockAll();
        vm.warp(unlockAt);
        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: zero recipient"));
        locker.withdraw(id, address(0));
    }

    function test_Withdraw_ToAnotherAddress() public {
        (uint256 id, uint256 amount) = _lockAll();
        vm.warp(unlockAt);
        vm.prank(project);
        locker.withdraw(id, buyer);
        assertEq(pair.balanceOf(buyer), amount);
    }

    function test_Withdraw_OneLockDoesNotTouchAnother() public {
        uint256 id0 = _lockSome(10e18, uint64(block.timestamp + 1 days));
        _lockSome(20e18, unlockAt);

        vm.warp(block.timestamp + 1 days);
        vm.prank(project);
        locker.withdraw(id0, project);

        assertEq(pair.balanceOf(address(locker)), 20e18, "the second lock is untouched");
        assertEq(locker.totalLockedForToken(address(pair)), 20e18);
    }

    // =====================================================================
    //                          OWNERSHIP TRANSFER
    // =====================================================================

    function test_TransferLock_MovesTheRightToWithdraw() public {
        (uint256 id, uint256 amount) = _lockAll();

        vm.prank(project);
        vm.expectEmit(true, true, true, false, address(locker));
        emit LockTransferred(id, project, buyer);
        locker.transferLock(id, buyer);

        assertEq(locker.getLock(id).owner, buyer);
        assertEq(locker.lockIdsForOwner(project).length, 0);
        assertEq(locker.lockIdsForOwner(buyer).length, 1);

        vm.warp(unlockAt);
        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: not lock owner"));
        locker.withdraw(id, project);

        vm.prank(buyer);
        locker.withdraw(id, buyer);
        assertEq(pair.balanceOf(buyer), amount);
    }

    function test_TransferLock_KeepsIndexesConsistent() public {
        uint256 id0 = _lockSome(10e18, unlockAt);
        uint256 id1 = _lockSome(20e18, unlockAt);
        uint256 id2 = _lockSome(30e18, unlockAt);

        // move the middle one: swap-and-pop must not corrupt the others
        vm.prank(project);
        locker.transferLock(id1, buyer);

        uint256[] memory projectIds = locker.lockIdsForOwner(project);
        assertEq(projectIds.length, 2);
        assertEq(projectIds[0], id0);
        assertEq(projectIds[1], id2, "the tail element moved into the hole");

        uint256[] memory buyerIds = locker.lockIdsForOwner(buyer);
        assertEq(buyerIds.length, 1);
        assertEq(buyerIds[0], id1);

        // now move the tail one as well
        vm.prank(project);
        locker.transferLock(id2, buyer);
        projectIds = locker.lockIdsForOwner(project);
        assertEq(projectIds.length, 1);
        assertEq(projectIds[0], id0);
        assertEq(locker.lockIdsForOwner(buyer).length, 2);

        // and the whole per-token listing is still complete
        assertEq(locker.locksForToken(address(pair)).length, 3);
    }

    function test_TransferLock_Validations() public {
        (uint256 id,) = _lockAll();

        vm.prank(stranger);
        vm.expectRevert(bytes("LOCKER: not lock owner"));
        locker.transferLock(id, stranger);

        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: zero owner"));
        locker.transferLock(id, address(0));

        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: same owner"));
        locker.transferLock(id, project);
    }

    function test_TransferLock_RevertsAfterWithdrawal() public {
        (uint256 id,) = _lockAll();
        vm.warp(unlockAt);
        vm.prank(project);
        locker.withdraw(id, project);

        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: already withdrawn"));
        locker.transferLock(id, buyer);
    }

    function test_TransferLock_NewOwnerCanExtendButNotShorten() public {
        (uint256 id,) = _lockAll();
        vm.prank(project);
        locker.transferLock(id, buyer);

        vm.prank(buyer);
        locker.extend(id, unlockAt + 10 days);
        assertEq(locker.getLock(id).unlockAt, unlockAt + 10 days);

        vm.prank(buyer);
        vm.expectRevert(bytes("LOCKER: cannot shorten"));
        locker.extend(id, unlockAt);
    }

    // =====================================================================
    //                                VIEWS
    // =====================================================================

    function test_Views_ProveLockedLiquidity() public {
        uint64 short_ = uint64(block.timestamp + 10 days);
        uint256 id0 = _lockSome(10e18, short_);
        _lockSome(25e18, unlockAt);

        LiquidityLocker.Lock[] memory list = locker.locksForToken(address(pair));
        assertEq(list.length, 2);
        assertEq(list[0].amount, 10e18);
        assertEq(list[1].amount, 25e18);
        assertEq(list[1].unlockAt, unlockAt);

        assertEq(locker.totalLockedForToken(address(pair)), 35e18);
        assertEq(locker.totalLockedForTokenAt(address(pair), uint64(block.timestamp)), 35e18);
        assertEq(
            locker.totalLockedForTokenAt(address(pair), short_),
            25e18,
            "the 10-day lock no longer counts past its expiry"
        );

        // withdrawing removes it from the locked total but not from the history
        vm.warp(short_);
        vm.prank(project);
        locker.withdraw(id0, project);
        assertEq(locker.totalLockedForToken(address(pair)), 25e18);
        assertEq(locker.locksForToken(address(pair)).length, 2, "history is permanent");
        assertTrue(locker.locksForToken(address(pair))[0].withdrawn);
    }

    function test_Views_Pagination() public {
        _lockSome(1e18, unlockAt);
        _lockSome(2e18, unlockAt);
        _lockSome(3e18, unlockAt);

        LiquidityLocker.Lock[] memory page = locker.locksForTokenPage(address(pair), 0, 2);
        assertEq(page.length, 2);
        assertEq(page[0].amount, 1e18);
        assertEq(page[1].amount, 2e18);

        page = locker.locksForTokenPage(address(pair), 2, 50);
        assertEq(page.length, 1);
        assertEq(page[0].amount, 3e18);

        page = locker.locksForTokenPage(address(pair), 3, 50);
        assertEq(page.length, 0);
    }

    function test_Views_LocksForOwner() public {
        _lockSome(1e18, unlockAt);
        _lockSome(2e18, unlockAt);
        LiquidityLocker.Lock[] memory mine = locker.locksForOwner(project);
        assertEq(mine.length, 2);
        assertEq(locker.locksForOwner(stranger).length, 0);
    }

    function test_Views_UnknownLockReverts() public {
        vm.expectRevert(bytes("LOCKER: no such lock"));
        locker.getLock(0);
        vm.expectRevert(bytes("LOCKER: no such lock"));
        locker.isWithdrawable(0);
    }

    function test_Views_UntouchedTokenIsEmpty() public view {
        assertEq(locker.locksForToken(address(tka)).length, 0);
        assertEq(locker.totalLockedForToken(address(tka)), 0);
        assertEq(locker.lockIdsForToken(address(tka)).length, 0);
    }

    // =====================================================================
    //                            REENTRANCY
    // =====================================================================

    function test_Reentrancy_WithdrawIsGuarded() public {
        CallbackERC20 evil = new CallbackERC20();
        evil.mint(project, 100e18);
        vm.startPrank(project);
        evil.approve(address(locker), type(uint256).max);
        uint256 id = locker.lock(address(evil), 100e18, unlockAt);
        vm.stopPrank();

        // during the payout transfer, the token calls withdraw again
        evil.arm(address(locker), abi.encodeCall(LiquidityLocker.withdraw, (id, address(evil))));

        vm.warp(unlockAt);
        vm.prank(project);
        locker.withdraw(id, project);

        assertTrue(evil.called());
        assertFalse(evil.lastSuccess(), "the reentrant call must fail");
        assertEq(evil.lastRevertReason(), "LOCKER: reentrant");
        assertEq(evil.balanceOf(project), 100e18, "paid out exactly once");
        assertEq(evil.balanceOf(address(locker)), 0);
    }

    function test_Reentrancy_LockIsGuarded() public {
        CallbackERC20 evil = new CallbackERC20();
        evil.mint(project, 100e18);
        vm.startPrank(project);
        evil.approve(address(locker), type(uint256).max);
        vm.stopPrank();

        evil.arm(address(locker), abi.encodeCall(LiquidityLocker.lock, (address(evil), 1e18, unlockAt)));

        vm.prank(project);
        locker.lock(address(evil), 50e18, unlockAt);

        assertTrue(evil.called());
        assertFalse(evil.lastSuccess());
        assertEq(evil.lastRevertReason(), "LOCKER: reentrant");
        assertEq(locker.lockCount(), 1, "only the outer lock was created");
    }

    // =====================================================================
    //                                FUZZ
    // =====================================================================

    function testFuzz_Lock_NeverWithdrawableEarly(uint64 duration, uint64 elapsed) public {
        uint64 dur = uint64(bound(uint256(duration), 1, 3650 days));
        uint64 el = uint64(bound(uint256(elapsed), 0, uint256(dur) - 1));
        uint64 until = uint64(block.timestamp) + dur;

        uint256 id = _lockSome(1e18, until);
        vm.warp(block.timestamp + el);

        assertFalse(locker.isWithdrawable(id));
        vm.prank(project);
        vm.expectRevert(bytes("LOCKER: still locked"));
        locker.withdraw(id, project);
    }

    function testFuzz_Extend_MonotoneOnly(uint64 first, uint64 second) public {
        uint64 t1 = uint64(bound(uint256(first), block.timestamp + 1, block.timestamp + 3650 days));
        uint64 t2 = uint64(bound(uint256(second), 0, type(uint64).max));

        uint256 id = _lockSome(1e18, t1);
        vm.prank(project);
        if (t2 > t1) {
            locker.extend(id, t2);
            assertEq(locker.getLock(id).unlockAt, t2);
        } else {
            vm.expectRevert(bytes("LOCKER: cannot shorten"));
            locker.extend(id, t2);
            assertEq(locker.getLock(id).unlockAt, t1);
        }
    }
}
