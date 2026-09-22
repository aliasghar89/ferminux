// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FMXRewardSink} from "../src/FMXRewardSink.sol";

/// @dev Recipient without a payable fallback: exercises "SINK: transfer failed".
contract Rejecting {}

contract FMXRewardSinkTest is Test {
    FMXRewardSink internal sink;

    address internal multisig = makeAddr("multisig");
    address internal outsider = makeAddr("outsider");
    address internal payee = makeAddr("payee");
    address internal newOwner = makeAddr("newOwner");

    event Received(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        sink = new FMXRewardSink(multisig);
    }

    // ---------------------------------------------------------- constructor

    function test_Constructor_SetsOwner() public view {
        assertEq(sink.owner(), multisig);
        assertEq(sink.pendingOwner(), address(0));
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert("SINK: zero owner");
        new FMXRewardSink(address(0));
    }

    // -------------------------------------------------------------- receive

    function test_Receive_EmitsAndHolds() public {
        vm.deal(outsider, 3 ether);
        vm.prank(outsider);
        vm.expectEmit(true, false, false, true, address(sink));
        emit Received(outsider, 3 ether);
        (bool ok, ) = address(sink).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(address(sink).balance, 3 ether);
    }

    function test_ConsensusCredit_NoCallNeeded() public {
        // The engine credits the balance directly (state.AddBalance). Simulate
        // that and make sure the owner can still withdraw it.
        vm.deal(address(sink), 5 ether);
        vm.prank(multisig);
        sink.withdraw(payable(payee), 5 ether);
        assertEq(payee.balance, 5 ether);
        assertEq(address(sink).balance, 0);
    }

    // ------------------------------------------------------------- withdraw

    function test_Withdraw_OwnerOnly() public {
        vm.deal(address(sink), 1 ether);
        vm.prank(outsider);
        vm.expectRevert("SINK: not owner");
        sink.withdraw(payable(payee), 1 ether);
    }

    function test_Withdraw_Partial_EmitsWithdrawn() public {
        vm.deal(address(sink), 10 ether);
        vm.prank(multisig);
        vm.expectEmit(true, false, false, true, address(sink));
        emit Withdrawn(payee, 4 ether);
        sink.withdraw(payable(payee), 4 ether);
        assertEq(payee.balance, 4 ether);
        assertEq(address(sink).balance, 6 ether);
    }

    function test_Withdraw_RevertsOnZeroRecipient() public {
        vm.deal(address(sink), 1 ether);
        vm.prank(multisig);
        vm.expectRevert("SINK: zero recipient");
        sink.withdraw(payable(address(0)), 1 ether);
    }

    function test_Withdraw_RevertsOnInsufficientBalance() public {
        vm.deal(address(sink), 1 ether);
        vm.prank(multisig);
        vm.expectRevert("SINK: insufficient balance");
        sink.withdraw(payable(payee), 1 ether + 1);
    }

    function test_Withdraw_RevertsWhenRecipientRejects() public {
        Rejecting rejecting = new Rejecting();
        vm.deal(address(sink), 1 ether);
        vm.prank(multisig);
        vm.expectRevert("SINK: transfer failed");
        sink.withdraw(payable(address(rejecting)), 1 ether);
        assertEq(address(sink).balance, 1 ether);
    }

    function testFuzz_Withdraw_NeverExceedsBalance(uint96 funded, uint96 amount) public {
        vm.deal(address(sink), funded);
        vm.prank(multisig);
        if (amount > funded) {
            vm.expectRevert("SINK: insufficient balance");
            sink.withdraw(payable(payee), amount);
        } else {
            sink.withdraw(payable(payee), amount);
            assertEq(payee.balance, amount);
            assertEq(address(sink).balance, uint256(funded) - amount);
        }
    }

    // ------------------------------------------------------ two-step owner

    function test_TransferOwnership_OwnerOnly() public {
        vm.prank(outsider);
        vm.expectRevert("SINK: not owner");
        sink.transferOwnership(newOwner);
    }

    function test_TransferOwnership_RevertsOnZero() public {
        vm.prank(multisig);
        vm.expectRevert("SINK: zero owner");
        sink.transferOwnership(address(0));
    }

    function test_TransferOwnership_IsTwoStep() public {
        vm.prank(multisig);
        vm.expectEmit(true, true, false, false, address(sink));
        emit OwnershipTransferStarted(multisig, newOwner);
        sink.transferOwnership(newOwner);

        // Nothing changes until accepted; the old owner keeps control.
        assertEq(sink.owner(), multisig);
        assertEq(sink.pendingOwner(), newOwner);
        vm.deal(address(sink), 1 ether);
        vm.prank(multisig);
        sink.withdraw(payable(payee), 1 ether);

        vm.prank(outsider);
        vm.expectRevert("SINK: not pending owner");
        sink.acceptOwnership();

        vm.prank(newOwner);
        vm.expectEmit(true, true, false, false, address(sink));
        emit OwnershipTransferred(multisig, newOwner);
        sink.acceptOwnership();

        assertEq(sink.owner(), newOwner);
        assertEq(sink.pendingOwner(), address(0));

        // Old owner is locked out, new owner can withdraw.
        vm.deal(address(sink), 1 ether);
        vm.prank(multisig);
        vm.expectRevert("SINK: not owner");
        sink.withdraw(payable(payee), 1 ether);
        vm.prank(newOwner);
        sink.withdraw(payable(payee), 1 ether);
        assertEq(payee.balance, 2 ether);
    }

    function test_TransferOwnership_CanBeReplacedBeforeAccept() public {
        vm.startPrank(multisig);
        sink.transferOwnership(outsider);
        sink.transferOwnership(newOwner);
        vm.stopPrank();

        vm.prank(outsider);
        vm.expectRevert("SINK: not pending owner");
        sink.acceptOwnership();

        vm.prank(newOwner);
        sink.acceptOwnership();
        assertEq(sink.owner(), newOwner);
    }
}
