// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CheckpointRegistry} from "../src/CheckpointRegistry.sol";

/// @dev Monotonicity, ownership (two-step), views and event emission for the
///      weak-subjectivity checkpoint registry.
contract CheckpointRegistryTest is Test {
    event Checkpoint(uint64 indexed ferminuxBlock, bytes32 blockHash, uint64 attestedAt);
    event OwnershipTransferStarted(address indexed newOwner);
    event OwnershipTransferCanceled(address indexed canceledOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    CheckpointRegistry reg;
    address owner = makeAddr("msig");
    address other = makeAddr("other");
    address rogue = makeAddr("rogue");

    bytes32 constant H1 = keccak256("block-100");
    bytes32 constant H2 = keccak256("block-200");

    function setUp() public {
        vm.warp(1_700_000_000);
        reg = new CheckpointRegistry(owner);
    }

    // ----------------------------------------------------------- constructor

    function test_Constructor_SetsOwnerAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(address(0), other);
        CheckpointRegistry r = new CheckpointRegistry(other);
        assertEq(r.owner(), other);
        assertEq(r.pendingOwner(), address(0));
        assertEq(r.latestNumber(), 0);
    }

    function test_Constructor_RevertsZeroOwner() public {
        vm.expectRevert("CKPT: zero owner");
        new CheckpointRegistry(address(0));
    }

    function test_Initial_LatestIsEmpty() public view {
        (uint64 n, bytes32 h, uint64 t) = reg.latest();
        assertEq(n, 0);
        assertEq(h, bytes32(0));
        assertEq(t, 0);
    }

    // --------------------------------------------------------------- publish

    function test_Publish_StoresAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Checkpoint(100, H1, uint64(block.timestamp));
        vm.prank(owner);
        reg.publish(100, H1);

        (uint64 n, bytes32 h, uint64 t) = reg.latest();
        assertEq(n, 100);
        assertEq(h, H1);
        assertEq(t, uint64(block.timestamp));
        assertEq(reg.latestNumber(), 100);

        (bytes32 h2, uint64 t2) = reg.checkpointAt(100);
        assertEq(h2, H1);
        assertEq(t2, uint64(block.timestamp));
    }

    function test_Publish_AttestedAtIsBlockTimestamp() public {
        vm.prank(owner);
        reg.publish(100, H1);
        vm.warp(block.timestamp + 3600);
        vm.prank(owner);
        reg.publish(200, H2);
        (, uint64 t1) = reg.checkpointAt(100);
        (, uint64 t2) = reg.checkpointAt(200);
        assertEq(t2 - t1, 3600);
    }

    function test_Publish_HistoryIsPreserved() public {
        vm.prank(owner);
        reg.publish(100, H1);
        vm.prank(owner);
        reg.publish(200, H2);
        (bytes32 h1,) = reg.checkpointAt(100);
        (bytes32 h2,) = reg.checkpointAt(200);
        assertEq(h1, H1);
        assertEq(h2, H2);
        (uint64 n,,) = reg.latest();
        assertEq(n, 200);
    }

    function test_CheckpointAt_UnknownHeightIsEmpty() public {
        vm.prank(owner);
        reg.publish(100, H1);
        (bytes32 h, uint64 t) = reg.checkpointAt(150);
        assertEq(h, bytes32(0));
        assertEq(t, 0);
    }

    function test_Publish_RevertsNotOwner() public {
        vm.prank(rogue);
        vm.expectRevert("CKPT: not owner");
        reg.publish(100, H1);
    }

    function test_Publish_RevertsZeroHash() public {
        vm.prank(owner);
        vm.expectRevert("CKPT: zero hash");
        reg.publish(100, bytes32(0));
    }

    function test_Publish_RevertsBlockZero() public {
        vm.prank(owner);
        vm.expectRevert("CKPT: not increasing");
        reg.publish(0, H1);
    }

    function test_Publish_RevertsEqualHeight() public {
        vm.startPrank(owner);
        reg.publish(100, H1);
        vm.expectRevert("CKPT: not increasing");
        reg.publish(100, H2);
        vm.stopPrank();
        // the original hash was not overwritten
        (bytes32 h,) = reg.checkpointAt(100);
        assertEq(h, H1);
    }

    function test_Publish_RevertsLowerHeight() public {
        vm.startPrank(owner);
        reg.publish(200, H2);
        vm.expectRevert("CKPT: not increasing");
        reg.publish(199, H1);
        vm.stopPrank();
        assertEq(reg.latestNumber(), 200);
    }

    function testFuzz_Publish_Monotonic(uint64 a, uint64 b, bytes32 ha, bytes32 hb) public {
        a = uint64(bound(a, 1, type(uint64).max - 1));
        b = uint64(bound(b, 1, type(uint64).max));
        vm.assume(ha != bytes32(0) && hb != bytes32(0));

        vm.prank(owner);
        reg.publish(a, ha);

        vm.prank(owner);
        if (b > a) {
            reg.publish(b, hb);
            assertEq(reg.latestNumber(), b);
            (bytes32 h,) = reg.checkpointAt(b);
            assertEq(h, hb);
        } else {
            vm.expectRevert("CKPT: not increasing");
            reg.publish(b, hb);
            assertEq(reg.latestNumber(), a);
        }
    }

    // ------------------------------------------------------------- ownership

    function test_TransferOwnership_TwoStep() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit OwnershipTransferStarted(other);
        reg.transferOwnership(other);
        assertEq(reg.owner(), owner, "owner unchanged until accept");
        assertEq(reg.pendingOwner(), other);

        // old owner can still publish before acceptance
        vm.prank(owner);
        reg.publish(1, H1);
        // new owner cannot yet
        vm.prank(other);
        vm.expectRevert("CKPT: not owner");
        reg.publish(2, H2);

        vm.prank(other);
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(owner, other);
        reg.acceptOwnership();
        assertEq(reg.owner(), other);
        assertEq(reg.pendingOwner(), address(0));

        vm.prank(other);
        reg.publish(2, H2);
        vm.prank(owner);
        vm.expectRevert("CKPT: not owner");
        reg.publish(3, H1);
    }

    function test_TransferOwnership_RevertsNotOwner() public {
        vm.prank(rogue);
        vm.expectRevert("CKPT: not owner");
        reg.transferOwnership(rogue);
    }

    function test_TransferOwnership_RevertsZero() public {
        vm.prank(owner);
        vm.expectRevert("CKPT: zero owner");
        reg.transferOwnership(address(0));
    }

    function test_AcceptOwnership_RevertsNotPending() public {
        vm.prank(owner);
        reg.transferOwnership(other);
        vm.prank(rogue);
        vm.expectRevert("CKPT: not pending owner");
        reg.acceptOwnership();
        // and with nothing pending at all
        vm.prank(owner);
        reg.cancelOwnershipTransfer();
        vm.prank(other);
        vm.expectRevert("CKPT: not pending owner");
        reg.acceptOwnership();
    }

    function test_CancelOwnershipTransfer() public {
        vm.prank(owner);
        reg.transferOwnership(other);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit OwnershipTransferCanceled(other);
        reg.cancelOwnershipTransfer();
        assertEq(reg.pendingOwner(), address(0));
        assertEq(reg.owner(), owner);
        vm.prank(other);
        vm.expectRevert("CKPT: not pending owner");
        reg.acceptOwnership();
    }

    function test_CancelOwnershipTransfer_RevertsNothingPending() public {
        vm.prank(owner);
        vm.expectRevert("CKPT: no pending owner");
        reg.cancelOwnershipTransfer();
    }

    function test_CancelOwnershipTransfer_RevertsNotOwner() public {
        vm.prank(owner);
        reg.transferOwnership(other);
        vm.prank(rogue);
        vm.expectRevert("CKPT: not owner");
        reg.cancelOwnershipTransfer();
    }

    function test_TransferOwnership_Overwrite() public {
        vm.startPrank(owner);
        reg.transferOwnership(other);
        reg.transferOwnership(rogue);
        vm.stopPrank();
        assertEq(reg.pendingOwner(), rogue);
        vm.prank(other);
        vm.expectRevert("CKPT: not pending owner");
        reg.acceptOwnership();
    }
}
