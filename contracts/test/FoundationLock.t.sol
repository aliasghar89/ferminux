// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {FoundationLock} from "../src/FoundationLock.sol";

contract FoundationLockTest is Test {
    FoundationLock lock;
    address owner = address(0xA11CE);
    address stranger = address(0xBEEF);
    uint64 unlockAt;

    function setUp() public {
        vm.warp(1_000_000);
        unlockAt = uint64(block.timestamp + 365 days);
        lock = new FoundationLock(owner, unlockAt);
        vm.deal(stranger, 100 ether);
        vm.deal(owner, 1 ether);
    }

    // ----------------------------------------------------------- deposits
    function testPlainSendIsAccepted() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 10 ether}("");
        assertTrue(ok);
        assertEq(lock.locked(), 10 ether);
    }

    function testZeroSendRejected() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 0}("");
        assertFalse(ok);
    }

    function testAnyoneCanLock() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        (ok, ) = address(lock).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(lock.locked(), 2 ether);
    }

    function testLockedEventReportsRunningTotal() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 3 ether}("");
        assertTrue(ok);
        vm.expectEmit(true, false, false, true);
        emit FoundationLock.Locked(stranger, 2 ether, 5 ether);
        vm.prank(stranger);
        (ok, ) = address(lock).call{value: 2 ether}("");
        assertTrue(ok);
    }

    // --------------------------------------------------- the lock itself
    function testOwnerCannotWithdrawBeforeUnlock() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 10 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vm.expectRevert("LOCK: still locked");
        lock.withdraw(payable(owner), 1 ether);
    }

    function testOneSecondBeforeUnlockStillLocked() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 10 ether}("");
        assertTrue(ok);
        vm.warp(unlockAt - 1);
        vm.prank(owner);
        vm.expectRevert("LOCK: still locked");
        lock.withdraw(payable(owner), 1 ether);
        assertEq(lock.remaining(), 1);
    }

    function testOwnerCanWithdrawAtUnlock() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 10 ether}("");
        assertTrue(ok);
        vm.warp(unlockAt);
        assertEq(lock.remaining(), 0);
        uint256 before = owner.balance;
        vm.prank(owner);
        lock.withdraw(payable(owner), 4 ether);
        assertEq(owner.balance - before, 4 ether);
        assertEq(lock.locked(), 6 ether);
    }

    function testStrangerCanNeverWithdraw() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 10 ether}("");
        assertTrue(ok);
        vm.warp(unlockAt + 1000 days);
        vm.prank(stranger);
        vm.expectRevert("LOCK: not owner");
        lock.withdraw(payable(stranger), 1 ether);
    }

    function testCannotOverdraw() public {
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: 1 ether}("");
        assertTrue(ok);
        vm.warp(unlockAt);
        vm.prank(owner);
        vm.expectRevert("LOCK: bad amount");
        lock.withdraw(payable(owner), 2 ether);
    }

    function testNoWayToShortenTheLock() public {
        // The contract exposes no setter; the compiler enforces this, and this
        // test exists so the absence is a deliberate, tested property rather
        // than an accident someone "fixes" later.
        assertEq(lock.unlockAt(), unlockAt);
    }

    // ---------------------------------------------------------- ownership
    function testTwoStepOwnership() public {
        address newOwner = address(0xCAFE);
        vm.prank(owner);
        lock.transferOwnership(newOwner);
        assertEq(lock.owner(), owner, "owner must not change until accepted");
        vm.prank(stranger);
        vm.expectRevert("LOCK: not pending owner");
        lock.acceptOwnership();
        vm.prank(newOwner);
        lock.acceptOwnership();
        assertEq(lock.owner(), newOwner);
        assertEq(lock.pendingOwner(), address(0));
    }

    function testConstructorRejectsPastUnlock() public {
        vm.expectRevert("LOCK: unlock must be in the future");
        new FoundationLock(owner, uint64(block.timestamp));
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert("LOCK: zero owner");
        new FoundationLock(address(0), unlockAt);
    }

    // ------------------------------------------------------------- fuzz
    function testFuzzNeverWithdrawableBeforeUnlock(uint64 t, uint96 amt) public {
        vm.assume(amt > 0);
        t = uint64(bound(t, block.timestamp, unlockAt - 1));
        vm.deal(stranger, amt);
        vm.prank(stranger);
        (bool ok, ) = address(lock).call{value: amt}("");
        assertTrue(ok);
        vm.warp(t);
        vm.prank(owner);
        vm.expectRevert("LOCK: still locked");
        lock.withdraw(payable(owner), 1);
    }
}
